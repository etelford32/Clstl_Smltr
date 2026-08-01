/**
 * home-sky-console.js — the landing page's personal space-weather console.
 *
 * The home page's centerpiece: a compact, tabbed "what does the sky mean for
 * ME, right now" window in the spirit of a consumer weather app, but for
 * space weather. Five surfaces:
 *
 *   MY SKY      — live Kp orb + the forces stacked on the user's sky
 *   AURORA      — personal go/maybe/no verdict + the Kp *you* need tonight
 *   RISK BOARD  — the NOAA R / S / G scales as readable risk rows, plus
 *                 satellite-drag and GNSS rows derived from them
 *   SUN NOW     — X-ray flux, latest flares, Earth-directed CME ETA
 *   SATELLITES  — magnetopause standoff, drag heating, surface charging
 *
 * CONTRACT (same as js/home-ticker.js / js/hero-live-hud.js): this module
 * does NOT own a data feed. It only listens to the window 'swpc-update'
 * event; the host page must start exactly ONE SpaceWeatherFeed AFTER calling
 * initSkyConsole() so the listener is attached before the first dispatch.
 *
 * ORACLES — nothing here re-derives physics that already has a home:
 *   - aurora visibility: magneticLatitude / boundaryForKp / auroraVerdict /
 *     sunAltitudeDeg from js/verdict-engine.js (the earth.html oracle).
 *   - magnetopause standoff: shueStandoffRe from js/hero-live-hud.js
 *     (which itself mirrors js/magnetosphere-engine.js computeShue).
 *   - location: js/user-location.js (shared with earth.html / AurOracle, so
 *     a place set here follows the user into the simulators).
 * The ONLY new mappings in this file are the NOAA scale tables (R from X-ray
 * flux, S from ≥10 MeV proton flux, G from Kp) — official SWPC thresholds,
 * encoded once here and unit-tested.
 *
 * buildSkyModel() and every scale mapper are PURE (no DOM, no fetch, no
 * ambient time — `now` is a parameter) and unit-tested by
 * tests/home-sky-console.mjs. Keep them that way.
 *
 * ASYNC SIGN-IN: the console renders instantly from the pp_auth localStorage
 * mirror (same read as js/nav.js), then lazily imports js/auth.js on idle so
 * the real Supabase session resolves in the background and 'auth-changed'
 * re-personalizes the chip without ever blocking first paint.
 *
 * KP_COLORS mirrors the 10-step ramp in js/home-ticker.js /
 * js/hero-live-hud.js / dashboard.html so "how bad is it" reads identically
 * across surfaces.
 */

import {
    magneticLatitude, boundaryForKp, auroraVerdict, sunAltitudeDeg,
} from './verdict-engine.js';
import { shueStandoffRe } from './hero-live-hud.js';

// ─────────────────────────────────────────────────────────────────────────────
// PURE MODEL — node-testable, no DOM below this line until the renderer
// ─────────────────────────────────────────────────────────────────────────────

const isNum = (v) => Number.isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = (v) => clamp(v, 0, 1);

/** Shared severity vocabulary for all five scales (index 0–5). */
export const SCALE_NAMES = ['none', 'Minor', 'Moderate', 'Strong', 'Severe', 'Extreme'];

/** NOAA G scale from Kp (G1 at Kp5 … G5 at Kp9). */
export function gFromKp(kp) {
    if (!isNum(kp)) return 0;
    return kp >= 9 ? 5 : kp >= 8 ? 4 : kp >= 7 ? 3 : kp >= 6 ? 2 : kp >= 5 ? 1 : 0;
}

/**
 * NOAA R scale from GOES 0.1–0.8 nm X-ray flux in W/m².
 * R1 = M1 (1e-5), R2 = M5 (5e-5), R3 = X1 (1e-4), R4 = X10 (1e-3), R5 = X20 (2e-3).
 */
export function rFromFlux(wm2) {
    if (!isNum(wm2)) return 0;
    return wm2 >= 2e-3 ? 5 : wm2 >= 1e-3 ? 4 : wm2 >= 1e-4 ? 3 : wm2 >= 5e-5 ? 2 : wm2 >= 1e-5 ? 1 : 0;
}

/**
 * NOAA S scale from the ≥10 MeV integral proton flux in pfu.
 * S1 = 10, S2 = 100, S3 = 1e3, S4 = 1e4, S5 = 1e5 — mirrors the
 * sep_storm_level thresholds inside js/swpc-feed.js.
 */
export function sFromProtonPfu(pfu) {
    if (!isNum(pfu)) return 0;
    return pfu >= 1e5 ? 5 : pfu >= 1e4 ? 4 : pfu >= 1e3 ? 3 : pfu >= 100 ? 2 : pfu >= 10 ? 1 : 0;
}

/**
 * The Kp at which the aurora comes "within reach" of an observer — the
 * smallest Kp whose visibility boundary (see boundaryForKp) comes within
 * `marginDeg` of the observer's |magnetic latitude|. marginDeg defaults to
 * the same 5° GO threshold the EarthView verdict card uses (CLAUDE.md §4.4 —
 * Gannon-calibrated; do not tighten independently).
 *
 * @returns {number|null} Kp in [0,9] (0 = already in reach at quiet field),
 *                        or null when even Kp 9 leaves the oval out of reach.
 */
export function kpNeededForVisibility(mlat, marginDeg = 5) {
    if (!isNum(mlat)) return null;
    // GO when margin = boundary − |mlat| ≤ marginDeg, i.e. the boundary has
    // descended to |mlat| + marginDeg or below.
    const target = Math.abs(mlat) + marginDeg;
    if (boundaryForKp(0) <= target) return 0;
    if (boundaryForKp(9) > target) return null;
    // boundaryForKp is piecewise-linear and strictly decreasing: bisect.
    let lo = 0, hi = 9;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (boundaryForKp(mid) > target) lo = mid; else hi = mid;
    }
    return Math.round(hi * 10) / 10;
}

/**
 * Max forecast Kp over the next `hours`, from the feed's kp_forecast array
 * ({time, kp, kind: 'observed'|'estimated'|'predicted'}). Only forward-looking
 * kinds count — 'observed' entries are the past.
 */
export function maxForecastKp(kpForecast, hours, now = Date.now()) {
    if (!Array.isArray(kpForecast) || !kpForecast.length) return null;
    const horizon = now + hours * 3600e3;
    let max = null;
    for (const e of kpForecast) {
        if (!e || e.kind === 'observed' || !isNum(e.kp)) continue;
        const t = e.time instanceof Date ? e.time.getTime() : Date.parse(e.time);
        if (!isNum(t) || t < now - 3 * 3600e3 || t > horizon) continue;
        if (max == null || e.kp > max) max = e.kp;
    }
    return max;
}

/** Deepest sun altitude over the next 24 h — dark-window detector for aurora. */
export function deepestSunAltitude(lat, lon, now = Date.now()) {
    let min = Infinity;
    for (let m = 0; m <= 24 * 60; m += 30) {
        const alt = sunAltitudeDeg(lat, lon, now + m * 60e3);
        if (alt < min) min = alt;
    }
    return min;
}

/**
 * Prototype 0–100 "sky pressure" index — a weighted blend of geomagnetic,
 * solar-wind and radiation forcing, in the spirit of a consumer heat index.
 * Disclosed as a prototype on-page; it ranks, it does not measure.
 */
export function compoundIndex({ kp, bz, speed, rLevel, sLevel } = {}) {
    const kpN = isNum(kp) ? clamp01(kp / 9) : 0;
    const bzN = isNum(bz) ? clamp01(-bz / 20) : 0;             // southward only
    const spN = isNum(speed) ? clamp01((speed - 300) / 500) : 0;
    const rN = clamp01((rLevel ?? 0) / 5);
    const sN = clamp01((sLevel ?? 0) / 5);
    const num = Math.round(100 * (kpN * 0.34 + bzN * 0.20 + spN * 0.14 + rN * 0.16 + sN * 0.16));
    const word = num < 15 ? 'Quiet sky' : num < 35 ? 'Gently stirring'
        : num < 55 ? 'Forces building' : num < 75 ? 'Storm in progress' : 'Fully loaded';
    return { num, word };
}

const fmt1 = (v) => (isNum(v) ? (Math.round(v * 10) / 10).toLocaleString('en-US') : '—');
const fmt0 = (v) => (isNum(v) ? Math.round(v).toLocaleString('en-US') : '—');

/** chip level 0–3 (Quiet / Watch / Elevated / High) from a 0–5 scale level. */
const chipFromScale = (level) => clamp(level, 0, 3);

/**
 * The master view-model: one 'swpc-update' state (+ optional location and
 * cloud cover) → everything the console renders. Every field degrades to
 * null/'—' so a partial feed never crashes a view.
 *
 * @param {object} state  swpc-update detail (see swpc-feed.js _buildState)
 * @param {object} opts   { loc: {lat,lon,city}|null, cloudPct: number|null,
 *                          now: ms epoch }
 */
export function buildSkyModel(state = {}, opts = {}) {
    const now = isNum(opts.now) ? opts.now : Date.now();
    const loc = opts.loc && isNum(opts.loc.lat) && isNum(opts.loc.lon) ? opts.loc : null;

    const sw = state.solar_wind ?? {};
    const kp = isNum(state.kp) ? state.kp : null;
    const kp1m = isNum(state.kp_1min) ? state.kp_1min : kp;
    const speed = isNum(sw.speed) ? sw.speed : null;
    const density = isNum(sw.density) ? sw.density : null;
    const bz = isNum(sw.bz) ? sw.bz : null;
    const xrayFlux = isNum(state.xray_flux) ? state.xray_flux : null;
    const xrayClass = state.xray_class ?? null;
    const p10 = isNum(state.proton_flux_10mev) ? state.proton_flux_10mev : null;
    const e2 = isNum(state.electron_flux_2mev) ? state.electron_flux_2mev : null;
    const f107 = isNum(state.f107_flux) ? state.f107_flux : null;
    const dst = isNum(state.dst_index) ? state.dst_index : null;

    // ── The three NOAA scales, now + 24 h outlook where a forecast exists ──
    const gNow = gFromKp(kp);
    const kpMax24 = maxForecastKp(state.kp_forecast, 24, now);
    const gNext = gFromKp(kpMax24);
    const rNow = rFromFlux(xrayFlux);
    const sNow = isNum(state.sep_storm_level) ? clamp(state.sep_storm_level, 0, 5)
        : sFromProtonPfu(p10);

    const g = {
        level: gNow, name: SCALE_NAMES[gNow], label: `G${gNow}`,
        next24: kpMax24 != null ? { level: gNext, label: `G${gNext}`, kp: kpMax24 } : null,
        note: kp == null ? 'Waiting for the Kp feed.'
            : gNow === 0
                ? `Kp ${fmt1(kp)} — Earth's field is ${kp < 3 ? 'quiet' : 'unsettled'}.`
                    + (gNext > 0 ? ` NOAA's outlook peaks near Kp ${fmt1(kpMax24)} (${`G${gNext}`}) in the next 24 h.` : '')
                : `Kp ${fmt1(kp)} — ${SCALE_NAMES[gNow].toLowerCase()} geomagnetic storm in progress. `
                    + 'Aurora pushes equatorward; grid and spacecraft operators are on notice.',
    };
    const r = {
        level: rNow, name: SCALE_NAMES[rNow], label: `R${rNow}`,
        note: xrayFlux == null ? 'Waiting for the GOES X-ray feed.'
            : rNow === 0
                ? `X-ray background ${xrayClass ?? '—'} — HF radio is unaffected.`
                : `${xrayClass ?? 'Flare'} flare in progress — ${rNow >= 3 ? 'wide-area blackout of' : 'degraded'} dayside HF radio.`,
    };
    const s = {
        level: sNow, name: SCALE_NAMES[sNow], label: `S${sNow}`,
        note: p10 == null ? 'Waiting for the proton feed.'
            : sNow === 0
                ? `≥10 MeV protons at ${fmt1(p10)} pfu — no radiation storm.`
                : `Radiation storm: ${fmt0(p10)} pfu — polar flights, EVA and satellite electronics are exposed.`,
    };

    // ── Derived operational rows ───────────────────────────────────────────
    const f107Elevated = isNum(f107) && f107 >= 150;
    const dragLevel = clamp((gNow >= 3 ? 3 : gNow >= 1 ? 2 : 0) + (f107Elevated ? 1 : 0), 0, 3)
        || (f107Elevated ? 1 : 0);
    const drag = {
        level: dragLevel,
        note: f107 == null && kp == null ? 'Waiting for solar-activity feeds.'
            : dragLevel === 0
                ? `F10.7 ${fmt0(f107)} sfu, Kp ${fmt1(kp)} — thermosphere near baseline; LEO drag nominal.`
                : dragLevel === 1
                    ? `F10.7 ${fmt0(f107)} sfu — a warm thermosphere is thickening LEO drag above baseline.`
                    : 'Storm heating is puffing the thermosphere — LEO drag climbs within hours '
                        + '(this is what dropped 38 Starlinks in Feb 2022).',
    };
    const gnssLevel = clamp(Math.max(gNow >= 2 ? gNow - 1 : 0, rNow >= 1 ? rNow - 0 : 0, sNow >= 2 ? 2 : 0), 0, 3);
    const gnss = {
        level: gnssLevel,
        note: gnssLevel === 0
            ? 'Ionosphere is settled — single-frequency GPS error stays nominal.'
            : gnssLevel === 1
                ? 'Ionospheric disturbance — expect meters of extra single-frequency GPS error.'
                : 'Storm-time ionosphere — GPS accuracy degraded, HF and L-band links noisy.',
    };

    const CHIP_WORDS = ['Quiet', 'Watch', 'Elevated', 'High'];
    const mkRow = (id, name, level, max, note, extra = {}) => ({
        id, name, level, max, note,
        chip: CHIP_WORDS[chipFromScale(extra.chipLevel ?? level)],
        chipLevel: chipFromScale(extra.chipLevel ?? level),
        ...extra,
    });
    const rows = [
        mkRow('g', 'Geomagnetic storm', gNow, 5, g.note,
            { label: g.label, outlook: g.next24, chipLevel: Math.max(gNow, g.next24 ? Math.min(g.next24.level, 2) : 0) }),
        mkRow('r', 'Radio blackout', rNow, 5, r.note, { label: r.label }),
        mkRow('s', 'Radiation storm', sNow, 5, s.note, { label: s.label }),
        mkRow('drag', 'Satellite drag', drag.level, 3, drag.note),
        mkRow('gnss', 'GPS & navigation', gnss.level, 3, gnss.note),
    ];

    // ── Aurora — personal, needs a location ────────────────────────────────
    let aurora = { available: false, kpEff: kpMax24 != null ? Math.max(kp ?? 0, kpMax24) : kp };
    if (loc) {
        const mlat = magneticLatitude(loc.lat, loc.lon);
        const kpEff = kpMax24 != null ? Math.max(kp ?? 0, kpMax24) : (kp ?? 0);
        const deepAlt = deepestSunAltitude(loc.lat, loc.lon, now);
        const verdict = auroraVerdict(kpEff, mlat, opts.cloudPct ?? null, deepAlt);
        aurora = {
            available: true, mlat, kpEff, deepAlt, verdict,
            cloudPct: isNum(opts.cloudPct) ? opts.cloudPct : null,
            kpNeeded: kpNeededForVisibility(mlat),
            boundaryNow: boundaryForKp(kp ?? 0),
            boundaryEff: boundaryForKp(kpEff),
        };
    }

    // ── Sun + satellites panels ────────────────────────────────────────────
    const cme = state.earth_directed_cme
        ? { eta_hours: isNum(state.cme_eta_hours) ? state.cme_eta_hours : null, raw: state.earth_directed_cme }
        : null;
    const sun = {
        xrayClass, xrayFlux, f107,
        series: Array.isArray(state.xray_series) ? state.xray_series : [],
        flares: (Array.isArray(state.flares) ? state.flares : []).slice(0, 3),
        regionCount: Array.isArray(state.active_regions) ? state.active_regions.length : null,
        cme,
    };
    const standoffRe = (density != null && speed != null)
        ? shueStandoffRe(density, speed, bz ?? 0) : null;
    const sat = {
        standoffRe,
        geoExposed: standoffRe != null && standoffRe < 6.6,
        electronFlux: e2,
        electronElevated: e2 != null && e2 >= 1e3,
        drag,
    };

    const compound = compoundIndex({ kp, bz, speed, rLevel: rNow, sLevel: sNow });

    // ── One readable sentence for the sky panel ────────────────────────────
    const worst = rows.reduce((a, x) => (x.chipLevel > a.chipLevel ? x : a), rows[0]);
    let headline;
    if (kp == null) headline = 'Connecting to the live NOAA feeds…';
    else if (cme && cme.eta_hours != null && cme.eta_hours > 0) {
        headline = `An Earth-directed CME arrives in ~${fmt0(cme.eta_hours)} h — conditions can jump when it hits.`;
    } else if (worst.chipLevel >= 2) headline = `${worst.name} is the risk to watch right now. ${worst.note}`;
    else if (aurora.available && aurora.verdict?.state === 'go') {
        headline = 'Aurora is within reach of your sky tonight — see the Aurora tab.';
    } else if (worst.chipLevel === 1) headline = `Mostly quiet — ${worst.name.toLowerCase()} is the only row worth watching.`;
    else headline = 'All five risk rows are quiet. The Sun is behaving — for now.';

    return {
        status: state.status ?? 'connecting',
        lastUpdated: state.lastUpdated ?? null,
        stormMode: !!state.storm_mode,
        kp, kp1m, kpMax24, speed, density, bz, bt: isNum(sw.bt) ? sw.bt : null,
        xrayClass, f107, dst,
        g, r, s, drag, gnss, rows, aurora, sun, sat, cme, compound, headline,
        alert: worst.chipLevel >= 2 || (cme?.eta_hours != null) || gNow >= 1 ? { row: worst, cme } : null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDERER — DOM from here down
// ─────────────────────────────────────────────────────────────────────────────

// Same 10-step Kp ramp as dashboard.html / home-ticker.js / hero-live-hud.js.
const KP_COLORS = [
    '#00e676', '#69f0ae', '#b2ff59', '#fff176',
    '#ffa726', '#ff7043', '#ef5350', '#e040fb', '#aa00ff', '#7c00ff',
];
const CHIP_COLORS = ['#2eff9e', '#ffd23f', '#ff8c5a', '#ff3050'];

const STYLE_ID = 'sky-console-styles';
const CSS = `
.sky-console{--sc-s1:#0c0722;--sc-s2:#150c33;--sc-ink:#f5f0ff;--sc-ink2:#cdc4f0;--sc-ink3:#9d92c8;
  --sc-ink4:#6f6695;--sc-grid:#221743;--sc-border:rgba(154,133,255,.16);--sc-accent:#8ff0ff;
  --sc-good:#2eff9e;--sc-warn:#ffd23f;--sc-serious:#ff8c5a;--sc-crit:#ff3050;
  max-width:1000px;margin:0 auto;font-family:var(--font-sans,'Space Grotesk',system-ui,sans-serif);
  color:var(--sc-ink2);text-align:left}
.sky-console *{box-sizing:border-box}
.sc-tabs{display:grid;grid-template-columns:104px repeat(4,1fr);gap:10px;margin:0 0 12px;align-items:center}
@media(max-width:880px){.sc-tabs{grid-template-columns:repeat(2,1fr)}.sc-orb{grid-column:span 2;justify-self:center}}
.sc-tab{--tc:var(--sc-accent);display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:13px;
  background:var(--sc-s1);border:1px solid var(--sc-border);cursor:pointer;text-align:left;color:var(--sc-ink3);
  font-family:inherit;transition:transform .15s,border-color .2s,box-shadow .2s;min-width:0}
.sc-tab:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.25);color:var(--sc-ink)}
.sc-tab.active{border-color:var(--tc);box-shadow:0 0 0 1px var(--tc),0 10px 30px color-mix(in srgb,var(--tc) 25%,transparent);
  background:linear-gradient(180deg,color-mix(in srgb,var(--tc) 12%,var(--sc-s1)),var(--sc-s1))}
.sc-tab b{display:block;font-size:.8rem;color:var(--sc-ink);white-space:nowrap;font-weight:650;letter-spacing:.01em}
.sc-tab small{display:block;font-size:.68rem;color:var(--sc-ink4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.sc-tab.active small{color:var(--sc-ink2)}
.sc-tab .ti{width:34px;height:34px;border-radius:50%;flex:none;display:grid;place-items:center;color:var(--tc);
  background:radial-gradient(circle at 32% 28%,color-mix(in srgb,var(--tc) 25%,transparent),color-mix(in srgb,var(--tc) 7%,transparent) 70%);
  border:1px solid color-mix(in srgb,var(--tc) 40%,transparent)}
.sc-tab .ti svg{width:18px;height:18px;display:block}
.sc-orb{width:104px;height:104px;border-radius:50%;padding:0;flex:none;display:grid;place-items:center;background:transparent;
  border:none;cursor:pointer;filter:drop-shadow(0 8px 22px rgba(143,240,255,.25));transition:transform .15s}
.sc-orb:hover{transform:translateY(-2px) scale(1.03)}
.sc-orb.active{filter:drop-shadow(0 0 20px rgba(143,240,255,.5))}
.sc-orb svg{width:104px;height:104px;display:block}
.sc-orbit1{transform-origin:55px 55px;animation:sc-spin 11s linear infinite}
.sc-orbit2{transform-origin:55px 55px;animation:sc-spin 6.5s linear infinite reverse}
@keyframes sc-spin{to{transform:rotate(360deg)}}
#sc-orb-aurora{filter:blur(2px);transition:opacity .8s}
#sc-orb-arc{transition:stroke-dasharray 1.2s ease}
@media(prefers-reduced-motion:reduce){.sc-orbit1,.sc-orbit2{animation:none}}
.sc-view{display:none}.sc-view.active{display:block}
.sc-galert{display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:10px 16px;border-radius:12px;font-size:.82rem;
  color:var(--sc-ink);cursor:pointer;border:1px solid color-mix(in srgb,var(--ac,var(--sc-warn)) 55%,transparent);
  background:linear-gradient(90deg,color-mix(in srgb,var(--ac,var(--sc-warn)) 16%,var(--sc-s1)),var(--sc-s1));
  box-shadow:0 0 18px color-mix(in srgb,var(--ac,var(--sc-warn)) 20%,transparent)}
.sc-galert .go{margin-left:auto;color:var(--sc-ink3);font-size:.74rem;white-space:nowrap}
.sc-window{border:1px solid var(--sc-border);border-radius:18px;overflow:hidden;background:var(--sc-s1);
  box-shadow:0 30px 80px rgba(0,0,0,.55)}
.sc-winbar{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--sc-border);
  background:rgba(255,255,255,.02);flex-wrap:wrap}
.sc-wintitle{display:flex;align-items:center;gap:9px;font-size:.72rem;font-weight:650;letter-spacing:.14em;
  text-transform:uppercase;color:var(--sc-ink3);font-family:var(--font-display,inherit)}
.sc-dot{width:8px;height:8px;border-radius:50%;background:var(--sc-good);animation:sc-pulse 2.4s infinite}
.sc-dot[data-st="stale"],.sc-dot[data-st="connecting"]{background:var(--sc-warn);animation:none}
.sc-dot[data-st="offline"]{background:var(--sc-crit);animation:none}
@keyframes sc-pulse{0%{box-shadow:0 0 0 0 rgba(46,255,158,.45)}70%{box-shadow:0 0 0 9px rgba(46,255,158,0)}100%{box-shadow:0 0 0 0 rgba(46,255,158,0)}}
.sc-loc{display:flex;align-items:center;gap:8px;margin-left:auto;position:relative;flex-wrap:wrap}
.sc-loc input{background:var(--sc-s2);border:1px solid var(--sc-border);border-radius:999px;color:var(--sc-ink);
  font-size:.8rem;padding:6px 13px;width:190px;outline:none;font-family:inherit}
.sc-loc input:focus{border-color:var(--sc-accent)}
.sc-loc button{background:transparent;border:1px solid var(--sc-border);color:var(--sc-ink3);border-radius:999px;
  padding:6px 11px;font-size:.78rem;cursor:pointer;font-family:inherit;white-space:nowrap}
.sc-loc button:hover{color:var(--sc-ink)}
.sc-loc-msg{font-size:.7rem;color:var(--sc-warn);flex-basis:100%;text-align:right;min-height:0}
.sc-auth{display:inline-flex;align-items:center;gap:7px;font-size:.78rem;padding:6px 13px;border-radius:999px;
  border:1px solid var(--sc-border);color:var(--sc-ink2);white-space:nowrap;text-decoration:none;transition:border-color .2s,color .2s}
.sc-auth:hover{border-color:var(--sc-accent);color:var(--sc-ink)}
.sc-auth.in{border-color:rgba(46,255,158,.35);color:var(--sc-good)}
.sc-wingrid{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr)}
@media(max-width:880px){.sc-wingrid{grid-template-columns:1fr}}
.sc-sky{position:relative;padding:16px 20px 14px;background:linear-gradient(160deg,#0e1a3a 0%,#05060f 90%);overflow:hidden}
.sc-sky .place{font-size:.8rem;color:var(--sc-ink2)}
.sc-sky .bigkp{font-size:2.9rem;font-weight:650;letter-spacing:-.03em;line-height:1.05;color:var(--sc-ink)}
.sc-sky .bigkp small{font-size:.95rem;font-weight:500;color:var(--sc-ink3);letter-spacing:0}
.sc-sky .cond{font-size:.85rem;color:var(--sc-ink2)}
.sc-sky .minor{display:flex;gap:13px;margin-top:9px;font-size:.72rem;color:var(--sc-ink4);flex-wrap:wrap}
.sc-sky .minor b{color:var(--sc-ink2);font-weight:600}
.sc-sky .headline{margin-top:12px;padding:9px 12px;border-radius:10px;background:rgba(255,255,255,.05);
  font-size:.8rem;line-height:1.55;color:var(--sc-ink2);border-left:3px solid var(--sc-accent)}
.sc-spark{width:100%;height:auto;margin-top:12px;display:block}
.sc-stack{padding:12px 18px 14px;border-left:1px solid var(--sc-border)}
@media(max-width:880px){.sc-stack{border-left:none;border-top:1px solid var(--sc-border)}}
.sc-stack h3{font-size:.66rem;letter-spacing:.2em;text-transform:uppercase;color:var(--sc-ink4);margin:0 0 2px;font-weight:650}
.sc-layer{display:grid;grid-template-columns:112px minmax(0,1fr) 88px;gap:12px;align-items:center;padding:7px 0;border-bottom:1px solid var(--sc-grid)}
.sc-layer:last-of-type{border-bottom:none}
.sc-layer .name{font-size:.8rem;font-weight:600;color:var(--sc-ink);display:flex;align-items:center;gap:8px}
.sc-layer .name i{width:9px;height:9px;border-radius:3px;flex:none}
.sc-layer .read{font-size:.75rem;color:var(--sc-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-meterrow{display:flex;align-items:center;gap:8px;justify-self:end}
.sc-meter{height:6px;border-radius:999px;background:var(--sc-s2);overflow:hidden;position:relative;width:54px;flex:none}
.sc-meter b{position:absolute;inset:0;width:0%;border-radius:999px;transition:width 1s ease}
.sc-meterrow em{font-style:normal;font-size:.72rem;color:var(--sc-ink4);width:22px;text-align:right;font-variant-numeric:tabular-nums}
.sc-compound{margin-top:10px;padding:10px 14px;border-radius:12px;background:var(--sc-s2);display:flex;align-items:center;
  justify-content:space-between;gap:16px;border:1px solid var(--sc-border)}
.sc-compound .label{font-size:.62rem;letter-spacing:.16em;text-transform:uppercase;color:var(--sc-ink4)}
.sc-compound .word{font-size:.95rem;font-weight:650;margin-top:1px;color:var(--sc-ink)}
.sc-compound .num{font-size:1.9rem;font-weight:650;letter-spacing:-.02em;line-height:1;color:var(--sc-accent)}
.sc-compound .num small{font-size:.72rem;color:var(--sc-ink4);font-weight:500}
.sc-proto{font-size:.62rem;color:var(--sc-ink4);margin-top:6px}
.sc-card{background:var(--sc-s1);border:1px solid var(--sc-border);border-radius:16px;padding:16px 18px 14px;min-width:0}
.sc-card .formula{font-size:.66rem;letter-spacing:.14em;text-transform:uppercase;color:var(--sc-ink4)}
.sc-card .formula b{color:var(--sc-ink2)}
.sc-card h3{font-size:1.1rem;font-weight:650;margin:6px 0 2px;color:var(--sc-ink);letter-spacing:-.01em}
.sc-card .desc{font-size:.8rem;color:var(--sc-ink3);margin-bottom:12px;line-height:1.55}
.sc-verdict{margin-top:12px;padding:10px 14px;border-radius:10px;background:var(--sc-s2);font-size:.8rem;line-height:1.6;
  color:var(--sc-ink2);border-left:3px solid var(--sc-accent)}
.sc-verdict b{color:var(--sc-ink)}
.sc-chip{display:inline-flex;align-items:center;gap:6px;font-size:.72rem;font-weight:600;padding:4px 10px;border-radius:999px;
  background:var(--sc-s2);border:1px solid var(--sc-border);color:var(--sc-ink);white-space:nowrap}
.sc-chip i{width:8px;height:8px;border-radius:50%;flex:none}
.sc-chip.pulse{animation:sc-chippulse 1.8s infinite}
@keyframes sc-chippulse{0%{box-shadow:0 0 0 0 var(--cc)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
.sc-risk{display:grid;grid-template-columns:128px minmax(0,1fr) 96px;gap:12px;align-items:center;padding:11px 0;border-bottom:1px solid var(--sc-grid)}
.sc-risk:last-child{border-bottom:none}
.sc-risk .rname{font-size:.8rem;font-weight:600;color:var(--sc-ink)}
.sc-risk .rlabel{font-size:.68rem;color:var(--sc-ink4);font-variant-numeric:tabular-nums}
.sc-risk .chip-cell{justify-self:end}
.sc-band{position:relative;height:20px;border-radius:6px;background:var(--sc-s2);overflow:hidden}
.sc-band .fill{position:absolute;top:0;bottom:0;left:0;border-radius:6px;transition:width .9s ease}
.sc-band .tick{position:absolute;top:0;bottom:0;width:1px;background:rgba(255,255,255,.12)}
.sc-band .mark{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--sc-ink);border-radius:2px;box-shadow:0 0 7px rgba(255,255,255,.9)}
.sc-band .mark.outlook{background:var(--sc-ink3);box-shadow:none;opacity:.8}
.sc-risknote{font-size:.72rem;color:var(--sc-ink3);margin-top:3px;line-height:1.45}
.sc-hero-verdict{display:flex;align-items:baseline;gap:14px;margin:4px 0 8px;flex-wrap:wrap}
.sc-hero-verdict .n{font-size:2.4rem;font-weight:700;letter-spacing:-.02em;line-height:1}
.sc-hero-verdict .cat{font-size:.85rem;color:var(--sc-ink2);max-width:420px;line-height:1.5}
.sc-kv{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0 10px;font-size:.76rem;color:var(--sc-ink3)}
.sc-kv b{color:var(--sc-ink);font-weight:650;font-variant-numeric:tabular-nums}
.sc-svg{width:100%;height:auto;display:block}
.sc-flare-list{list-style:none;margin:8px 0 0;padding:0;font-size:.76rem}
.sc-flare-list li{display:flex;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--sc-grid);color:var(--sc-ink3)}
.sc-flare-list li:last-child{border-bottom:none}
.sc-flare-list b{color:var(--sc-ink);font-variant-numeric:tabular-nums}
.sc-links{display:flex;gap:14px;flex-wrap:wrap;margin-top:12px;font-size:.76rem}
.sc-links a{color:var(--sc-accent);text-decoration:none;font-weight:600}
.sc-links a:hover{text-decoration:underline}
details.sc-tbl{margin-top:10px}
details.sc-tbl summary{font-size:.72rem;color:var(--sc-ink4);cursor:pointer}
details.sc-tbl table{width:100%;border-collapse:collapse;margin-top:8px;font-size:.72rem;color:var(--sc-ink3)}
details.sc-tbl th,details.sc-tbl td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--sc-grid)}
details.sc-tbl th{color:var(--sc-ink4);font-weight:600}
`;

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
}

const IC = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
    aurora: IC('<path d="M3 16c2-5 4-7 5-7s2 3 4 3 3-5 4-5 3 2 5 6"/><path d="M3 20h18" opacity=".4"/>'),
    alert: IC('<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".4" fill="currentColor"/>'),
    sun: IC('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    sat: IC('<rect x="9" y="9" width="6" height="6" rx="1"/><path d="M4 5l4 4M16 15l4 4M2.5 8.5 8.5 2.5M15.5 21.5l6-6" opacity=".7"/>'),
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function kpColor(kp) {
    return KP_COLORS[clamp(Math.floor(kp ?? 0), 0, 9)];
}

/** 24 h Kp forecast sparkline (bars), with the user's visibility threshold. */
function kpSparkSvg(kpForecast, kpNeeded, now) {
    const entries = (kpForecast ?? [])
        .map((e) => ({ ...e, t: e.time instanceof Date ? e.time.getTime() : Date.parse(e.time) }))
        .filter((e) => isNum(e.t) && isNum(e.kp) && e.t >= now - 3 * 3600e3 && e.t <= now + 27 * 3600e3)
        .sort((a, b) => a.t - b.t)
        .slice(0, 12);
    if (entries.length < 2) return '';
    const W = 360, H = 78, L = 8, R = 8, top = 16, base = 58;
    const slot = (W - L - R) / entries.length;
    let g = `<text x="${L}" y="10" font-size="8" fill="rgba(255,255,255,.5)" letter-spacing="1.6" font-weight="700">NOAA Kp OUTLOOK · NEXT 24 H</text>`;
    entries.forEach((e, i) => {
        const bh = Math.max(2, (clamp(e.kp, 0, 9) / 9) * (base - top));
        const bw = Math.min(20, slot - 5);
        const bx = L + slot * i + (slot - bw) / 2;
        const solid = e.kind === 'observed' ? 1 : 0.75;
        g += `<rect x="${bx.toFixed(1)}" y="${(base - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2.5" fill="${kpColor(e.kp)}" fill-opacity="${solid}"/>`;
        g += `<text x="${(bx + bw / 2).toFixed(1)}" y="${(base - bh - 4).toFixed(1)}" text-anchor="middle" font-size="8.4" fill="rgba(255,255,255,.75)" font-variant-numeric="tabular-nums">${fmt1(e.kp)}</text>`;
        const d = new Date(e.t);
        if (i % 2 === 0) g += `<text x="${(bx + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="7.6" fill="rgba(255,255,255,.4)">${d.toLocaleTimeString(undefined, { hour: 'numeric' })}</text>`;
    });
    if (isNum(kpNeeded) && kpNeeded > 0) {
        const y = base - (clamp(kpNeeded, 0, 9) / 9) * (base - top);
        g += `<line x1="${L}" x2="${W - R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#2eff9e" stroke-width="1" stroke-dasharray="3 3" opacity=".8"/>`;
        g += `<text x="${W - R}" y="${(y - 3).toFixed(1)}" text-anchor="end" font-size="7.8" fill="#2eff9e">Kp ${fmt1(kpNeeded)} = aurora in reach</text>`;
    }
    return `<svg class="sc-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="NOAA Kp forecast, next 24 hours">${g}</svg>`;
}

/** Latitude ladder: where the oval reaches now / tonight vs the observer. */
function latLadderSvg(aurora) {
    if (!aurora?.available) return '';
    const W = 620, H = 120, L = 46, R = 16, mid = 62;
    const latMin = 35, latMax = 75;
    const x = (lat) => L + (W - L - R) * (1 - (clamp(Math.abs(lat), latMin, latMax) - latMin) / (latMax - latMin));
    let g = `<line x1="${L}" x2="${W - R}" y1="${mid}" y2="${mid}" stroke="#221743" stroke-width="2"/>`;
    for (let lat = latMin; lat <= latMax; lat += 10) {
        g += `<line x1="${x(lat)}" x2="${x(lat)}" y1="${mid - 5}" y2="${mid + 5}" stroke="#38335a"/>`
            + `<text x="${x(lat)}" y="${mid + 22}" text-anchor="middle" font-size="9.5" fill="#6f6695">${lat}°</text>`;
    }
    // oval reach: from pole (right edge conceptually poleward=left here? use poleward = high lat) —
    // draw the band from the boundary poleward (higher latitudes).
    const bNow = clamp(Math.abs(aurora.boundaryNow), latMin, latMax);
    const bEff = clamp(Math.abs(aurora.boundaryEff), latMin, latMax);
    g += `<rect x="${L}" y="${mid - 13}" width="${Math.max(0, x(bEff) - L)}" height="10" rx="5" fill="#2eff9e" fill-opacity=".18"/>`;
    g += `<rect x="${L}" y="${mid - 13}" width="${Math.max(0, x(bNow) - L)}" height="10" rx="5" fill="#2eff9e" fill-opacity=".38"/>`;
    g += `<text x="${L}" y="${mid - 20}" font-size="9.5" fill="#2eff9e">aurora reach — bright: now · faint: tonight's max (Kp ${fmt1(aurora.kpEff)})</text>`;
    const you = x(aurora.mlat);
    g += `<line x1="${you}" x2="${you}" y1="${mid - 26}" y2="${mid + 8}" stroke="#f5f0ff" stroke-width="2"/>`
        + `<text x="${you}" y="${mid - 32}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#f5f0ff">you · ${fmt1(Math.abs(aurora.mlat))}° mag</text>`;
    return `<svg class="sc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Aurora reach versus your magnetic latitude">${g}</svg>`;
}

/** Six-hour GOES X-ray sparkline on a log scale with flare-class gridlines. */
function xraySparkSvg(series) {
    const pts = (series ?? [])
        .map((p) => ({ t: p.t instanceof Date ? p.t.getTime() : Date.parse(p.t), f: p.flux }))
        .filter((p) => isNum(p.t) && isNum(p.f) && p.f > 0)
        .sort((a, b) => a.t - b.t)
        .slice(-96);
    if (pts.length < 8) return '';
    const W = 620, H = 150, L = 34, R = 10, T = 12, B = 20;
    const lo = -8, hi = -3; // log10 flux: A(1e-8) … X10(1e-3)
    const x = (i) => L + (W - L - R) * (i / (pts.length - 1));
    const y = (f) => T + (H - T - B) * (1 - (clamp(Math.log10(f), lo, hi) - lo) / (hi - lo));
    const CLASSES = [['B', 1e-7], ['C', 1e-6], ['M', 1e-5], ['X', 1e-4]];
    let g = '';
    for (const [name, f] of CLASSES) {
        g += `<line x1="${L}" x2="${W - R}" y1="${y(f)}" y2="${y(f)}" stroke="#221743" stroke-width="1"/>`
            + `<text x="${L - 6}" y="${y(f) + 3}" text-anchor="end" font-size="9" fill="#6f6695">${name}</text>`;
    }
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.f).toFixed(1)}`).join(' ');
    g += `<path d="${path} L${x(pts.length - 1).toFixed(1)},${H - B} L${L},${H - B} Z" fill="#ffb830" fill-opacity=".08"/>`;
    g += `<path d="${path}" fill="none" stroke="#ffb830" stroke-width="1.8" stroke-linejoin="round"/>`;
    const t0 = new Date(pts[0].t), t1 = new Date(pts[pts.length - 1].t);
    g += `<text x="${L}" y="${H - 6}" font-size="8.5" fill="#48426e">${t0.toLocaleTimeString(undefined, { hour: 'numeric' })}</text>`;
    g += `<text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="8.5" fill="#48426e">${t1.toLocaleTimeString(undefined, { hour: 'numeric' })}</text>`;
    return `<svg class="sc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="GOES X-ray flux, recent hours">${g}</svg>`;
}

function chipHtml(row) {
    const col = CHIP_COLORS[row.chipLevel];
    const pulse = row.chipLevel >= 2
        ? ` pulse" style="--cc:color-mix(in srgb,${col} 55%,transparent);border-color:color-mix(in srgb,${col} 55%,transparent);background:color-mix(in srgb,${col} 18%,var(--sc-s2))"`
        : '"';
    return `<span class="sc-chip${pulse}><i style="background:${col}"></i>${row.chip}</span>`;
}

function riskRowHtml(row) {
    const col = CHIP_COLORS[row.chipLevel];
    const pct = (row.level / row.max) * 100;
    let ticks = '';
    for (let i = 1; i < row.max; i++) ticks += `<span class="tick" style="left:${(i / row.max) * 100}%"></span>`;
    const outlook = row.outlook
        ? `<span class="mark outlook" style="left:${(row.outlook.level / row.max) * 100}%" title="24 h outlook ${row.outlook.label}"></span>` : '';
    const label = row.label ? `<div class="rlabel">${esc(row.label)}${row.outlook ? ` → ${esc(row.outlook.label)} next 24 h` : ''}</div>`
        : `<div class="rlabel">level ${row.level}/${row.max}</div>`;
    return `<div class="sc-risk">
      <div><div class="rname">${esc(row.name)}</div>${label}</div>
      <div><div class="sc-band"><span class="fill" style="width:${pct}%;background:linear-gradient(90deg,${col}44,${col})"></span>${ticks}
        <span class="mark" style="left:${pct}%"></span>${outlook}</div>
        <div class="sc-risknote">${esc(row.note)}</div></div>
      <div class="chip-cell">${chipHtml(row)}</div>
    </div>`;
}

function fmtTime(t) {
    const d = t instanceof Date ? t : new Date(t);
    return Number.isNaN(d.getTime()) ? '—'
        : d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// ── Auth chip (async sign-in) ────────────────────────────────────────────────

function readStoredAuth() {
    try {
        const raw = localStorage.getItem('pp_auth') || sessionStorage.getItem('pp_auth');
        const a = raw ? JSON.parse(raw) : null;
        return a?.signedIn ? a : null;
    } catch { return null; }
}

function authChipHtml() {
    const a = readStoredAuth();
    if (a) {
        const name = esc((a.name || a.email || 'You').split(/[\s@]/)[0]);
        const plan = a.plan && a.plan !== 'free' ? ` · ${esc(a.plan)}` : '';
        return `<a class="sc-auth in" href="/dashboard.html" data-funnel-cta="console_dashboard">◈ ${name}${plan}</a>`;
    }
    return `<a class="sc-auth" href="/signin.html" data-funnel-cta="console_signin">Sign in — save your sky</a>`;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mount the console. Renders the full structure immediately (placeholders),
 * then re-renders the data regions on every 'swpc-update' /
 * 'user-location-changed' / 'auth-changed'. Location input + auth chip are
 * STABLE elements (verdict-card lesson: re-rendering an input mid-keystroke
 * blows away the user's typing) — only data containers get innerHTML swaps.
 */
export async function initSkyConsole(host) {
    if (!host) return;
    ensureStyles();

    // user-location.js is shared with earth.html / AurOracle — a place set
    // here follows the user across the site. Import is static-shaped but the
    // module is tiny and dependency-free.
    const locMod = await import('./user-location.js');
    const { geocodeQuery, saveUserLocation, loadUserLocation } = locMod;

    let loc = loadUserLocation();
    let cloudPct = null;
    let lastState = {};
    let model = buildSkyModel({}, { loc });

    host.classList.add('sky-console');
    host.innerHTML = `
      <div class="sc-tabs" role="tablist" aria-label="Sky console views">
        <button class="sc-tab sc-orb active" data-view="sky-my" role="tab" aria-selected="true" title="My Sky" aria-label="My Sky">
          <svg viewBox="0 0 110 110">
            <defs>
              <radialGradient id="sc-orb-sky" cx="35%" cy="28%" r="90%">
                <stop offset="0" stop-color="#0e1a3a"/><stop offset="1" stop-color="#04050e"/>
              </radialGradient>
              <linearGradient id="sc-orb-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#8ff0ff"/><stop offset="1" stop-color="#9d3aff"/>
              </linearGradient>
              <linearGradient id="sc-aur-grad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stop-color="#2ee6a8" stop-opacity=".1"/><stop offset=".4" stop-color="#2ee6a8" stop-opacity=".8"/>
                <stop offset=".7" stop-color="#7fb2ff" stop-opacity=".7"/><stop offset="1" stop-color="#b48cff" stop-opacity=".15"/>
              </linearGradient>
              <clipPath id="sc-orb-clip"><circle cx="55" cy="55" r="50"/></clipPath>
            </defs>
            <circle cx="55" cy="55" r="50" fill="url(#sc-orb-sky)"/>
            <g clip-path="url(#sc-orb-clip)">
              <circle cx="30" cy="26" r="1" fill="#cdd8f0" opacity=".7"/><circle cx="72" cy="20" r=".8" fill="#cdd8f0" opacity=".5"/>
              <circle cx="86" cy="44" r="1.1" fill="#cdd8f0" opacity=".6"/><circle cx="20" cy="56" r=".7" fill="#cdd8f0" opacity=".45"/>
              <circle cx="66" cy="84" r=".9" fill="#cdd8f0" opacity=".5"/><circle cx="42" cy="72" r=".7" fill="#cdd8f0" opacity=".4"/>
              <path id="sc-orb-aurora" d="M12 30 Q34 12 55 20 Q80 28 100 14" fill="none" stroke="url(#sc-aur-grad)" stroke-width="7" stroke-linecap="round" opacity="0"/>
              <path d="M5 84 Q55 64 105 84 L105 110 L5 110 Z" fill="rgba(143,240,255,.14)"/>
              <path d="M5 84 Q55 64 105 84" fill="none" stroke="rgba(143,240,255,.4)" stroke-width="1"/>
            </g>
            <circle cx="55" cy="55" r="50" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="2.5"/>
            <circle id="sc-orb-arc" cx="55" cy="55" r="50" fill="none" stroke="url(#sc-orb-grad)" stroke-width="2.5"
                stroke-linecap="round" stroke-dasharray="0 315" transform="rotate(-90 55 55)"/>
            <g class="sc-orbit1"><circle cx="55" cy="5" r="2.6" fill="#8ff0ff"/></g>
            <g class="sc-orbit2"><circle cx="55" cy="17" r="1.7" fill="#ffd23f"/></g>
            <text id="sc-orb-kp" x="55" y="60" text-anchor="middle" font-size="22" font-weight="700" fill="#f5f0ff" letter-spacing="-.5">—</text>
            <text x="55" y="76" text-anchor="middle" font-size="6.4" font-weight="700" fill="#cdc4f0" letter-spacing="1.8">MY SKY · Kp</text>
          </svg>
        </button>
        <button class="sc-tab" data-view="sky-aurora" role="tab" aria-selected="false" style="--tc:#2eff9e">
          <span class="ti">${ICONS.aurora}</span><span><b>Aurora tonight</b><small data-sub="aurora">set a location</small></span>
        </button>
        <button class="sc-tab" data-view="sky-risks" role="tab" aria-selected="false" style="--tc:#ffd23f">
          <span class="ti">${ICONS.alert}</span><span><b>Risk board</b><small data-sub="risks">connecting…</small></span>
        </button>
        <button class="sc-tab" data-view="sky-sun" role="tab" aria-selected="false" style="--tc:#ffb830">
          <span class="ti">${ICONS.sun}</span><span><b>Sun now</b><small data-sub="sun">connecting…</small></span>
        </button>
        <button class="sc-tab" data-view="sky-sat" role="tab" aria-selected="false" style="--tc:#8ff0ff">
          <span class="ti">${ICONS.sat}</span><span><b>Satellites &amp; GPS</b><small data-sub="sat">connecting…</small></span>
        </button>
      </div>

      <div class="sc-galert" data-galert style="display:none" role="button" tabindex="0"></div>

      <div class="sc-view active" id="sky-my" role="tabpanel">
        <div class="sc-window">
          <div class="sc-winbar">
            <span class="sc-wintitle"><span class="sc-dot" data-dot data-st="connecting"></span><span data-live>connecting…</span></span>
            <div class="sc-loc">
              <input data-loc-input type="text" placeholder="City or zip…" autocomplete="off" aria-label="Set your location">
              <button data-loc-geo title="Use my location">◎ Locate</button>
              <span data-auth-slot></span>
              <span class="sc-loc-msg" data-loc-msg></span>
            </div>
          </div>
          <div class="sc-wingrid">
            <div class="sc-sky" data-skypanel></div>
            <div class="sc-stack" data-stackpanel></div>
          </div>
        </div>
      </div>
      <div class="sc-view" id="sky-aurora" role="tabpanel"><div class="sc-card" data-aurora-card></div></div>
      <div class="sc-view" id="sky-risks" role="tabpanel"><div class="sc-card" data-risks-card></div></div>
      <div class="sc-view" id="sky-sun" role="tabpanel"><div class="sc-card" data-sun-card></div></div>
      <div class="sc-view" id="sky-sat" role="tabpanel"><div class="sc-card" data-sat-card></div></div>
    `;

    const $ = (sel) => host.querySelector(sel);

    // ── Tabs ──────────────────────────────────────────────────────────────
    host.querySelectorAll('.sc-tab').forEach((b) => b.addEventListener('click', () => {
        host.querySelectorAll('.sc-tab').forEach((x) => {
            x.classList.toggle('active', x === b);
            x.setAttribute('aria-selected', x === b ? 'true' : 'false');
        });
        host.querySelectorAll('.sc-view').forEach((v) => v.classList.toggle('active', v.id === b.dataset.view));
    }));
    const initHash = location.hash.replace('#', '');
    if (/^sky-/.test(initHash)) host.querySelector(`.sc-tab[data-view="${initHash}"]`)?.click();

    // ── Async auth chip ───────────────────────────────────────────────────
    const authSlot = $('[data-auth-slot]');
    const renderAuth = () => { authSlot.innerHTML = authChipHtml(); };
    renderAuth();
    window.addEventListener('auth-changed', renderAuth);
    // Resolve the real Supabase session in the background — never blocks
    // paint; 'auth-changed' re-personalizes the chip (and the nav) when done.
    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 2500));
    idle(() => { import('./auth.js').catch(() => {}); });

    // ── Location plumbing ─────────────────────────────────────────────────
    const locMsg = $('[data-loc-msg]');
    const setLocMsg = (t) => { locMsg.textContent = t || ''; };
    async function fetchClouds() {
        cloudPct = null;
        if (!loc) return;
        try {
            const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=cloud_cover&timezone=auto`);
            if (r.ok) cloudPct = (await r.json())?.current?.cloud_cover ?? null;
        } catch { /* clouds stay unknown — verdict copes */ }
        rebuild();
    }
    $('[data-loc-input]').addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const q = e.target.value.trim();
        if (!q) return;
        setLocMsg('Searching…');
        try {
            const found = await geocodeQuery(q);
            saveUserLocation(found);   // fires user-location-changed → rebuild
            e.target.value = '';
            setLocMsg('');
        } catch (err) { setLocMsg(err.message || 'Not found'); }
    });
    $('[data-loc-geo]').addEventListener('click', () => {
        if (!navigator.geolocation) { setLocMsg('Geolocation unavailable'); return; }
        setLocMsg('Locating…');
        navigator.geolocation.getCurrentPosition(async (pos) => {
            const { latitude: lat, longitude: lon } = pos.coords;
            let city = 'Your location';
            try {
                const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10`,
                    { headers: { 'Accept-Language': 'en' } });
                if (r.ok) {
                    const j = await r.json();
                    city = j.address?.city || j.address?.town || j.address?.county || j.address?.state || city;
                }
            } catch { /* name stays generic */ }
            saveUserLocation({ lat, lon, city, displayName: city });
            setLocMsg('');
        }, () => setLocMsg('Location denied'), { timeout: 8000 });
    });
    window.addEventListener('user-location-changed', (e) => {
        loc = e.detail;
        rebuild();
        fetchClouds();
    });

    // ── Render functions (data regions only) ──────────────────────────────
    function renderChrome() {
        const dot = $('[data-dot]');
        dot.dataset.st = model.status;
        const t = model.lastUpdated ? new Date(model.lastUpdated) : null;
        $('[data-live]').textContent =
            model.status === 'live' ? `live · ${t ? t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''}${model.stormMode ? ' · storm mode' : ''}`
                : model.status === 'connecting' ? 'connecting…'
                    : model.status === 'stale' ? 'stale feed — showing last data'
                        : 'offline — quiet-Sun fallback';

        // orb
        const kpTxt = $('#sc-orb-kp');
        if (kpTxt) {
            kpTxt.textContent = model.kp != null ? fmt1(model.kp) : '—';
            kpTxt.setAttribute('fill', model.kp != null ? kpColor(model.kp) : '#f5f0ff');
        }
        $('#sc-orb-arc')?.setAttribute('stroke-dasharray', `${((model.compound.num / 100) * 313.2).toFixed(1)} 315`);
        const aur = $('#sc-orb-aurora');
        if (aur) aur.setAttribute('opacity', model.aurora.available && model.aurora.verdict?.state !== 'no' ? '.8'
            : (model.kp ?? 0) >= 5 ? '.8' : '0');

        // tab sub-lines
        const subs = {
            aurora: !model.aurora.available ? 'set a location'
                : model.aurora.verdict.state === 'go' ? 'GO — in reach tonight'
                    : model.aurora.verdict.state === 'maybe' ? 'maybe — low on horizon'
                        : model.aurora.deepAlt > -12 ? 'no darkness tonight'
                            : `needs Kp ${model.aurora.kpNeeded != null ? fmt1(model.aurora.kpNeeded) : '9+'}`,
            risks: (() => {
                const hot = model.rows.filter((x) => x.chipLevel >= 1);
                return hot.length ? `${hot.length} of 5 active` : 'all quiet';
            })(),
            sun: model.xrayClass ? `${model.xrayClass}${model.sun.cme ? ' · CME inbound' : ''}` : 'connecting…',
            sat: model.sat.standoffRe != null ? `standoff ${fmt1(model.sat.standoffRe)} R⊕` : 'connecting…',
        };
        for (const [k, v] of Object.entries(subs)) {
            const el = host.querySelector(`[data-sub="${k}"]`);
            if (el) el.textContent = v;
        }

        // global alert band
        const ga = $('[data-galert]');
        if (model.alert) {
            const worst = model.alert.row;
            const cmeTxt = model.alert.cme?.eta_hours != null ? `CME arrives in ~${fmt0(model.alert.cme.eta_hours)} h · ` : '';
            ga.style.display = 'flex';
            ga.style.setProperty('--ac', CHIP_COLORS[Math.max(worst.chipLevel, 1)]);
            ga.innerHTML = `${ICONS.alert}<span><b>${cmeTxt}${esc(worst.name)}:</b> ${esc(worst.note)}</span><span class="go">View risk board →</span>`;
            ga.onclick = () => host.querySelector('.sc-tab[data-view="sky-risks"]')?.click();
        } else ga.style.display = 'none';
    }

    function renderMySky() {
        const place = loc ? esc(loc.city || 'Your location') : 'Anywhere on Earth — set a location for aurora';
        const gWord = model.g.level > 0 ? `${model.g.label} ${model.g.name.toLowerCase()} storm`
            : model.kp == null ? '—' : model.kp < 3 ? 'Quiet geomagnetic field' : 'Unsettled field';
        $('[data-skypanel]').innerHTML = `
          <div style="position:relative">
            <div class="place">${place}</div>
            <div class="bigkp">Kp ${model.kp != null ? fmt1(model.kp) : '—'}<small> / 9</small></div>
            <div class="cond" style="color:${model.g.level > 0 ? CHIP_COLORS[Math.min(model.g.level, 3)] : 'var(--sc-ink2)'}">${gWord}</div>
            <div class="minor">
              <span>Wind <b>${fmt0(model.speed)} km/s</b></span>
              <span>Bz <b>${model.bz != null ? (model.bz > 0 ? '+' : '') + fmt1(model.bz) + ' nT' : '—'}</b></span>
              <span>Density <b>${fmt1(model.density)} p/cm³</b></span>
              <span>X-ray <b>${esc(model.xrayClass ?? '—')}</b></span>
            </div>
            <div class="headline">${esc(model.headline)}</div>
            ${kpSparkSvg(lastState.kp_forecast, model.aurora.available ? model.aurora.kpNeeded : null, Date.now())}
          </div>`;

        const layers = [
            ['Solar X-ray', '#ffb830', `${esc(model.xrayClass ?? '—')} · ${model.sun.regionCount != null ? model.sun.regionCount + ' active regions' : 'regions —'}`, clamp01(model.r.level / 5 + (model.xrayClass?.[0] === 'C' ? 0.12 : 0))],
            ['Solar wind', '#8ff0ff', `${fmt0(model.speed)} km/s · ${fmt1(model.density)} p/cm³`, model.speed != null ? clamp01((model.speed - 300) / 500) : 0],
            ['IMF Bz', '#c080ff', model.bz != null ? `${(model.bz > 0 ? '+' : '') + fmt1(model.bz)} nT ${model.bz <= -5 ? '· south — coupling' : model.bz < 0 ? '· weakly south' : '· north — shielded'}` : '—', model.bz != null ? clamp01(-model.bz / 20) : 0],
            ['Geomagnetic', '#ff5cb8', `Kp ${fmt1(model.kp)} · Dst ${fmt0(model.dst)} nT`, model.kp != null ? clamp01(model.kp / 9) : 0],
            ['Radiation', '#ff8c5a', model.s.level > 0 ? `${model.s.label} storm in progress` : 'no proton storm', clamp01(model.s.level / 5)],
        ];
        $('[data-stackpanel]').innerHTML = `
          <h3>The forces on your sky</h3>
          ${layers.map(([n, col, read, f]) => `
            <div class="sc-layer">
              <div class="name"><i style="background:${col}"></i>${n}</div>
              <div class="read">${read}</div>
              <div class="sc-meterrow"><span class="sc-meter"><b style="background:${col};width:${Math.round(f * 100)}%"></b></span><em>${Math.round(f * 100)}</em></div>
            </div>`).join('')}
          <div class="sc-compound">
            <div><div class="label">Sky pressure index</div><div class="word">${esc(model.compound.word)}</div></div>
            <div class="num">${model.compound.num}<small> /100</small></div>
          </div>
          <div class="sc-proto">Prototype index — a weighted blend of live geomagnetic, solar-wind and radiation forcing. The tabs above hold the real scales.</div>`;
    }

    function renderAurora() {
        const card = $('[data-aurora-card]');
        if (!model.aurora.available) {
            card.innerHTML = `
              <div class="formula"><b>Kp</b> × <b>your latitude</b> × <b>darkness</b> × <b>cloud</b></div>
              <h3>Will you see the aurora tonight?</h3>
              <div class="desc">Set a location in the bar above (city, zip, or ◎ Locate) and this tab turns into a
                personal go / no-go verdict: how far the auroral oval sits from your sky, and exactly what Kp would put it overhead.</div>
              <div class="sc-verdict"><b>No location set.</b> The oval is currently reaching ${fmt1(model.aurora.kpEff != null ? boundaryForKp(model.aurora.kpEff) : boundaryForKp(0))}° magnetic latitude.</div>`;
            return;
        }
        const a = model.aurora;
        const v = a.verdict;
        const stateCol = v.state === 'go' ? '#2eff9e' : v.state === 'maybe' ? '#ffd23f' : '#9d92c8';
        const needTxt = a.kpNeeded == null ? 'even Kp 9 leaves the oval out of visual range — travel poleward for a show'
            : a.kpNeeded <= (model.kp ?? 0) ? 'that bar is met right now'
                : `tonight's max forecast is Kp ${fmt1(a.kpEff)}`;
        card.innerHTML = `
          <div class="formula"><b>Kp</b> × <b>your latitude</b> × <b>darkness</b> × <b>cloud</b></div>
          <h3>Aurora at ${esc(loc.city || 'your location')}</h3>
          <div class="sc-hero-verdict"><div class="n" style="color:${stateCol}">${esc(v.title.replace('Aurora: ', ''))}</div>
            <div class="cat">${esc(v.desc)}</div></div>
          <div class="sc-kv">
            <span>Your magnetic latitude <b>${fmt1(Math.abs(a.mlat))}°</b></span>
            <span>Kp you need <b>${a.kpNeeded != null ? fmt1(a.kpNeeded) : '> 9'}</b> <span style="color:var(--sc-ink4)">(${needTxt})</span></span>
            <span>Cloud <b>${a.cloudPct != null ? fmt0(a.cloudPct) + '%' : 'unknown'}</b></span>
            <span>Dark window ${a.deepAlt > -12 ? '<b>none tonight</b>' : '<b>yes</b>'}</span>
          </div>
          ${latLadderSvg(a)}
          ${kpSparkSvg(lastState.kp_forecast, a.kpNeeded, Date.now())}
          <div class="sc-verdict">${v.state === 'go'
                ? `<b>Get somewhere dark.</b> At Kp ${fmt1(a.kpEff)} the oval's edge reaches ${fmt1(a.boundaryEff)}° magnetic — ${a.verdict.margin <= 0 ? 'overhead at your latitude' : 'close enough to fill your poleward sky'}.`
                : v.state === 'maybe'
                    ? '<b>Camera odds beat eyeball odds.</b> Point a long exposure at the poleward horizon after dark.'
                    : `<b>Not tonight.</b> ${esc(v.desc)}`}</div>
          <div class="sc-links">
            <a href="auroracle.html" data-funnel-cta="console_auroracle">Get AurOracle alerts for this spot →</a>
            <a href="earth.html">Open the EarthView globe →</a>
          </div>`;
    }

    function renderRisks() {
        const worst = model.rows.reduce((x, y) => (y.chipLevel > x.chipLevel ? y : x), model.rows[0]);
        $('[data-risks-card]').innerHTML = `
          <div class="formula"><b>NOAA scales</b> × <b>live feeds</b> — what could bite, right now</div>
          <h3>Your space-weather risk board</h3>
          <div class="desc">The three official NOAA scales plus the two operational risks derived from them.
            White marker = now; grey marker = next-24-h outlook where a forecast exists.</div>
          ${model.rows.map(riskRowHtml).join('')}
          <div class="sc-verdict">${worst.chipLevel >= 2
                ? `<b>${esc(worst.name)} is the stack to watch.</b> ${esc(worst.note)}`
                : worst.chipLevel === 1
                    ? `<b>Watch level only.</b> ${esc(worst.name)} is active but minor — everything else is quiet.`
                    : '<b>All quiet.</b> Five rows, zero active risks. The board lights up the moment the Sun changes its mind.'}</div>
          <details class="sc-tbl"><summary>What the scales mean</summary>
            <table><tr><th>Scale</th><th>Measures</th><th>Trips at</th></tr>
              <tr><td>G1–G5</td><td>Geomagnetic storms (Kp)</td><td>Kp 5 → G1 … Kp 9 → G5</td></tr>
              <tr><td>R1–R5</td><td>Radio blackouts (X-ray flares)</td><td>M1 → R1 · X1 → R3 · X20 → R5</td></tr>
              <tr><td>S1–S5</td><td>Radiation storms (≥10 MeV protons)</td><td>10 pfu → S1 · 10⁴ pfu → S4</td></tr></table></details>
          <div class="sc-links">
            <a href="space-weather.html" data-funnel-cta="console_dashboard_risks">Open the full dashboard →</a>
            <a href="account.html">Set alert thresholds →</a>
          </div>`;
    }

    function renderSun() {
        const flares = model.sun.flares.length
            ? `<ul class="sc-flare-list">${model.sun.flares.map((f) => `<li><b>${esc(f.cls ?? '—')}</b><span>${fmtTime(f.time)}</span>${f.location ? `<span style="color:var(--sc-ink4)">${esc(f.location)}</span>` : ''}</li>`).join('')}</ul>`
            : '<div class="sc-risknote">No M/X flares in the recent record.</div>';
        const cme = model.sun.cme
            ? `<div class="sc-verdict" style="border-left-color:#ff5cb8"><b>Earth-directed CME in transit${model.sun.cme.eta_hours != null ? ` — arrives in ~${fmt0(model.sun.cme.eta_hours)} h` : ''}.</b>
                Watch the <a href="flux-rope-live.html" style="color:var(--sc-accent)">Compounding Watch</a> for the Bz forecast that decides how hard it hits.</div>`
            : '';
        $('[data-sun-card]').innerHTML = `
          <div class="formula"><b>GOES X-ray</b> × <b>flares</b> × <b>CMEs</b></div>
          <h3>The Sun, right now</h3>
          <div class="sc-kv">
            <span>X-ray <b>${esc(model.xrayClass ?? '—')}</b></span>
            <span>F10.7 <b>${fmt0(model.f107)} sfu</b></span>
            <span>Active regions <b>${model.sun.regionCount ?? '—'}</b></span>
          </div>
          ${xraySparkSvg(model.sun.series)}
          <div style="margin-top:10px"><span class="formula">Latest flares</span>${flares}</div>
          ${cme}
          <div class="sc-links">
            <a href="sun.html" data-funnel-cta="console_sun">Open the solar engine →</a>
            <a href="flux-rope-live.html">CME Compounding Watch →</a>
          </div>`;
    }

    function renderSat() {
        const so = model.sat.standoffRe;
        const soTxt = so == null ? '—' : `${fmt1(so)} R⊕`;
        const geo = model.sat.geoExposed
            ? '<b style="color:#ff8c5a">GEO satellites are outside the magnetopause on the dayside</b> — direct solar-wind exposure.'
            : so != null ? `Magnetopause holds ${fmt1(so - 6.6)} R⊕ sunward of GEO — spacecraft stay inside the shield.` : '';
        const eTxt = model.sat.electronFlux != null
            ? `${model.sat.electronFlux >= 1000 ? '<b style="color:#ffd23f">Elevated</b>' : 'Nominal'} · ${fmt0(model.sat.electronFlux)} pfu`
            : '—';
        $('[data-sat-card]').innerHTML = `
          <div class="formula"><b>Drag</b> × <b>charging</b> × <b>shield geometry</b></div>
          <h3>Satellites &amp; GPS</h3>
          ${model.rows.filter((x) => x.id === 'drag' || x.id === 'gnss').map(riskRowHtml).join('')}
          <div class="sc-kv" style="margin-top:12px">
            <span>Magnetopause standoff <b>${soTxt}</b> <span style="color:var(--sc-ink4)">(GEO = 6.6 R⊕)</span></span>
            <span>2 MeV electrons <b>${eTxt}</b></span>
          </div>
          <div class="sc-verdict">${geo || 'Waiting for solar-wind data to place the magnetopause.'}</div>
          <div class="sc-links">
            <a href="operations.html" data-funnel-cta="console_operations">Operations console →</a>
            <a href="upper-atmosphere.html">Drag simulator →</a>
            <a href="satellites.html">Track 4,500+ satellites →</a>
          </div>`;
    }

    function rebuild() {
        model = buildSkyModel(lastState, { loc, cloudPct });
        renderChrome();
        renderMySky();
        renderAurora();
        renderRisks();
        renderSun();
        renderSat();
    }

    window.addEventListener('swpc-update', (e) => {
        lastState = e.detail ?? {};
        rebuild();
    });

    rebuild();       // placeholder paint before the first feed dispatch
    fetchClouds();   // no-op without a location
}
