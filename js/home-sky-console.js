/**
 * home-sky-console.js — the landing page's personal conditions console.
 *
 * The home page's centerpiece: a compact, tabbed "what does the sky mean for
 * ME, right now" window. Priority order (2026-08 direction: everyday-first —
 * air quality and temperature lead, aurora is deliberately secondary):
 *
 *   MY AIR      — DEFAULT. US AQI + pollutants + the forces loading/cleaning
 *                 the air + week-ahead forecast (the orb button shows AQI)
 *   EVENTS      — major-event predictions, next 7 days: thunderstorms, heavy
 *                 rain, wind, heat/freeze (Open-Meteo) merged with inbound
 *                 space weather (CME arrival, forecast G-storms, radiation)
 *   TEMPERATURE — temperature dynamics: now / 24 h / 7-day band, plus the
 *                 solar-input-vs-temperature year arc with the thermal-lag
 *                 annotation (the planet's thermal memory)
 *   SPACE       — the NOAA R/S/G risk board, Kp outlook, flares, CME, drag
 *   AURORA      — personal go/maybe/no verdict + the Kp *you* need tonight
 *
 * CONTRACT (same as js/home-ticker.js / js/hero-live-hud.js): this module
 * does NOT own the space-weather feed. It only listens to the window
 * 'swpc-update' event; the host page must start exactly ONE SpaceWeatherFeed
 * AFTER calling initSkyConsole() so the listener is attached before the
 * first dispatch. Per-location Earth data (weather / air / climate archive)
 * comes from js/home-conditions.js — fetched here, per location, nowhere
 * else on this page.
 *
 * ORACLES — nothing here re-derives physics that already has a home:
 *   - aurora visibility: magneticLatitude / boundaryForKp / auroraVerdict /
 *     sunAltitudeDeg from js/verdict-engine.js (the earth.html oracle).
 *   - magnetopause standoff: shueStandoffRe from js/hero-live-hud.js.
 *   - location storage: js/user-location.js (shared with earth.html /
 *     AurOracle). A timezone-guessed default (js/home-conditions.js
 *     tzGuessLocation) is used before the visitor sets a real place — it is
 *     kept IN MEMORY ONLY, never written to the shared store.
 * The only new mappings in this file are the NOAA scale tables (R from
 * X-ray flux, S from ≥10 MeV proton flux, G from Kp) — official SWPC
 * thresholds, encoded once here and unit-tested. js/home-conditions.js
 * imports gFromKp back from this file (a deliberate, benign module cycle:
 * hoisted function declaration, exercised by both node gates).
 *
 * buildSkyModel() and every scale mapper are PURE (no DOM, no fetch, no
 * ambient time — `now` is a parameter) and unit-tested by
 * tests/home-sky-console.mjs; the air/events/temperature models live in
 * js/home-conditions.js under tests/home-conditions.mjs. Keep them that way.
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
 * The master space-weather view-model: one 'swpc-update' state (+ optional
 * location and cloud cover) → everything the space/aurora views render.
 * Every field degrades to null/'—' so a partial feed never crashes a view.
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

    // ── One readable sentence for the space panel ──────────────────────────
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
#sc-orb-arc{transition:stroke-dasharray 1.2s ease,stroke .8s ease}
@media(prefers-reduced-motion:reduce){.sc-orbit1,.sc-orbit2{animation:none}}
.sc-view{display:none}.sc-view.active{display:block}
.sc-topbar{display:flex;align-items:center;gap:10px;padding:9px 14px;border:1px solid var(--sc-border);border-radius:13px;
  background:var(--sc-s1);margin-bottom:12px;flex-wrap:wrap}
.sc-wintitle{display:flex;align-items:center;gap:9px;font-size:.72rem;font-weight:650;letter-spacing:.14em;
  text-transform:uppercase;color:var(--sc-ink3);font-family:var(--font-display,inherit)}
.sc-dot{width:8px;height:8px;border-radius:50%;background:var(--sc-good);animation:sc-pulse 2.4s infinite}
.sc-dot[data-st="stale"],.sc-dot[data-st="connecting"]{background:var(--sc-warn);animation:none}
.sc-dot[data-st="offline"]{background:var(--sc-crit);animation:none}
@keyframes sc-pulse{0%{box-shadow:0 0 0 0 rgba(46,255,158,.45)}70%{box-shadow:0 0 0 9px rgba(46,255,158,0)}100%{box-shadow:0 0 0 0 rgba(46,255,158,0)}}
.sc-loc{display:flex;align-items:center;gap:8px;margin-left:auto;position:relative;flex-wrap:wrap}
.sc-loc input{background:var(--sc-s2);border:1px solid var(--sc-border);border-radius:999px;color:var(--sc-ink);
  font-size:.8rem;padding:6px 13px;width:180px;outline:none;font-family:inherit}
.sc-loc input:focus{border-color:var(--sc-accent)}
.sc-loc button{background:transparent;border:1px solid var(--sc-border);color:var(--sc-ink3);border-radius:999px;
  padding:6px 11px;font-size:.78rem;cursor:pointer;font-family:inherit;white-space:nowrap}
.sc-loc button:hover{color:var(--sc-ink)}
.sc-loc-msg{font-size:.7rem;color:var(--sc-warn);flex-basis:100%;text-align:right;min-height:0}
.sc-auth{display:inline-flex;align-items:center;gap:7px;font-size:.78rem;padding:6px 13px;border-radius:999px;
  border:1px solid var(--sc-border);color:var(--sc-ink2);white-space:nowrap;text-decoration:none;transition:border-color .2s,color .2s}
.sc-auth:hover{border-color:var(--sc-accent);color:var(--sc-ink)}
.sc-auth.in{border-color:rgba(46,255,158,.35);color:var(--sc-good)}
.sc-galert{display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:10px 16px;border-radius:12px;font-size:.82rem;
  color:var(--sc-ink);cursor:pointer;border:1px solid color-mix(in srgb,var(--ac,var(--sc-warn)) 55%,transparent);
  background:linear-gradient(90deg,color-mix(in srgb,var(--ac,var(--sc-warn)) 16%,var(--sc-s1)),var(--sc-s1));
  box-shadow:0 0 18px color-mix(in srgb,var(--ac,var(--sc-warn)) 20%,transparent)}
.sc-galert .go{margin-left:auto;color:var(--sc-ink3);font-size:.74rem;white-space:nowrap}
.sc-galert svg{width:17px;height:17px;flex:none;color:var(--ac,var(--sc-warn))}
.sc-card{background:var(--sc-s1);border:1px solid var(--sc-border);border-radius:16px;padding:16px 18px 14px;min-width:0;
  box-shadow:0 30px 80px rgba(0,0,0,.45)}
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
.sc-spark{width:100%;height:auto;display:block;margin-top:6px}
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
/* air view */
.sc-aqi-track{height:10px;border-radius:999px;position:relative;margin:10px 0 4px;
  background:linear-gradient(90deg,#2eff9e,#ffd23f 30%,#ff8c5a 50%,#ff3050 72%,#b48cff)}
.sc-aqi-track i{position:absolute;top:50%;transform:translate(-50%,-50%);width:16px;height:16px;border-radius:50%;
  background:var(--sc-ink);border:3px solid var(--sc-s1)}
.sc-aqi-scale{display:flex;justify-content:space-between;font-size:.64rem;color:var(--sc-ink4);margin-bottom:10px}
.sc-meterrow{display:grid;grid-template-columns:150px minmax(0,1fr) 84px;gap:10px;align-items:center;padding:6px 0;
  border-bottom:1px solid var(--sc-grid);font-size:.76rem}
.sc-meterrow:last-child{border-bottom:none}
.sc-meterrow .mname{color:var(--sc-ink2)}
.sc-meterrow .mval{text-align:right;color:var(--sc-ink4);font-variant-numeric:tabular-nums;font-size:.72rem}
.sc-meter{height:6px;border-radius:999px;background:var(--sc-s2);overflow:hidden;position:relative}
.sc-meter b{position:absolute;inset:0;width:0%;border-radius:999px;transition:width 1s ease}
.sc-fbar{position:relative;height:8px}
.sc-fbar .mid{position:absolute;left:50%;top:-3px;bottom:-3px;width:1px;background:#2a3450}
.sc-fbar b{position:absolute;top:0;bottom:0;border-radius:4px}
/* events view */
.sc-event{display:grid;grid-template-columns:96px minmax(0,1fr) auto;gap:12px;align-items:start;padding:11px 0;border-bottom:1px solid var(--sc-grid)}
.sc-event:last-child{border-bottom:none}
.sc-event .when{font-size:.74rem;color:var(--sc-ink2);font-weight:650;line-height:1.4}
.sc-event .when small{display:block;font-size:.64rem;color:var(--sc-ink4);font-weight:500}
.sc-event .ename{font-size:.82rem;font-weight:650;color:var(--sc-ink)}
.sc-event .ename .tag{font-size:.6rem;font-weight:650;letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;
  border-radius:999px;margin-left:8px;vertical-align:1px;border:1px solid var(--sc-border);color:var(--sc-ink4)}
.sc-event .enote{font-size:.74rem;color:var(--sc-ink3);margin-top:2px;line-height:1.5}
.sc-watchlist{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.sc-watchlist span{font-size:.68rem;color:var(--sc-ink4);border:1px solid var(--sc-border);border-radius:999px;padding:3px 10px}
/* temp view */
.sc-temp-hero{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin:4px 0 6px}
.sc-temp-hero .n{font-size:2.6rem;font-weight:700;letter-spacing:-.02em;line-height:1;color:var(--sc-ink)}
.sc-temp-hero .n small{font-size:1rem;color:var(--sc-ink3);font-weight:500}
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
    bolt: IC('<path d="M13 2 5 13.5h5L9.5 22 18 10h-5.5z"/>'),
    thermo: IC('<path d="M10 4a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 9v6" opacity=".6"/>'),
    planet: IC('<circle cx="12" cy="12" r="5.5"/><path d="M3.5 14.5c3-1 6.5-2.4 9.8-4.2 3.2-1.7 6-3.6 7.2-5" opacity=".7"/>'),
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function kpColor(kp) {
    return KP_COLORS[clamp(Math.floor(kp ?? 0), 0, 9)];
}

// ── SVG builders (string SVG, prototype style) ───────────────────────────────

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
    return `<svg class="sc-spark" style="max-width:480px" viewBox="0 0 ${W} ${H}" role="img" aria-label="NOAA Kp forecast, next 24 hours">${g}</svg>`;
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
    const lo = -8, hi = -3;
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

/** Week-ahead AQI daily-peak bars, colored by EPA category. */
function aqiWeekSvg(week, catFn) {
    if (!week?.length) return '';
    const W = 360, H = 96, top = 16, base = 72, labY = 88;
    const slot = (W - 16) / week.length;
    const scale = Math.max(120, ...week.map((p) => p.v));
    let g = `<line x1="8" x2="${W - 8}" y1="${base}" y2="${base}" stroke="#2a3450" stroke-width="1"/>`;
    week.forEach((p, i) => {
        const bw = Math.min(24, slot - 6), bx = 8 + slot * i + (slot - bw) / 2;
        const bh = Math.max(3, (p.v / scale) * (base - top));
        g += `<rect x="${bx.toFixed(1)}" y="${(base - bh).toFixed(1)}" width="${bw}" height="${bh.toFixed(1)}" rx="3" fill="${catFn(p.v).color}" fill-opacity=".85"/>`;
        g += `<text x="${(bx + bw / 2).toFixed(1)}" y="${(base - bh - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,.75)" font-variant-numeric="tabular-nums">${p.v}</text>`;
        g += `<text x="${(bx + bw / 2).toFixed(1)}" y="${labY}" text-anchor="middle" font-size="8.4" fill="#6f6695">${i === 0 ? 'Today' : new Date(p.t).toLocaleDateString(undefined, { weekday: 'short' })}</text>`;
    });
    return `<svg class="sc-spark" style="max-width:440px" viewBox="0 0 ${W} ${H}" role="img" aria-label="7-day air quality forecast">${g}</svg>`;
}

/** Next-24-h temperature line + precip-probability bars. */
function tempSparkSvg(spark) {
    if (!spark || spark.length < 6) return '';
    const W = 360, H = 84, L = 8, R = 8, top = 20, base = 56;
    const n = spark.length;
    const x = (i) => L + (W - L - R) * (i / (n - 1));
    const tMin = Math.min(...spark.map((p) => p.tempF)), tMax = Math.max(...spark.map((p) => p.tempF));
    const y = (v) => base - (base - top) * ((v - tMin) / ((tMax - tMin) || 1));
    let g = `<text x="${L}" y="10" font-size="8" fill="rgba(255,255,255,.5)" letter-spacing="1.6" font-weight="700">NEXT 24 H</text>`;
    spark.forEach((p, i) => {
        if (p.pp > 4) {
            const bh = Math.max(2, (p.pp / 100) * 14);
            g += `<rect x="${(x(i) - 2).toFixed(1)}" y="${(base + 18 - bh).toFixed(1)}" width="4" height="${bh.toFixed(1)}" rx="1.5" fill="rgba(110,193,255,.55)"/>`;
        }
    });
    const path = spark.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.tempF).toFixed(1)}`).join(' ');
    g += `<path d="${path} L${x(n - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z" fill="rgba(255,255,255,.07)"/>`;
    g += `<path d="${path}" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`;
    g += `<circle cx="${x(0).toFixed(1)}" cy="${y(spark[0].tempF).toFixed(1)}" r="3" fill="#fff"/>`;
    let pk = 0; spark.forEach((p, i) => { if (p.tempF > spark[pk].tempF) pk = i; });
    if (pk >= 2) {
        const px = clamp(x(pk), L + 60, W - R - 40);
        g += `<circle cx="${x(pk).toFixed(1)}" cy="${y(spark[pk].tempF).toFixed(1)}" r="2.6" fill="#fff"/>`;
        g += `<text x="${px.toFixed(1)}" y="${Math.max(y(spark[pk].tempF) - 6, 16).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="600" fill="rgba(255,255,255,.9)">${Math.round(spark[pk].tempF)}° · ${new Date(spark[pk].t).toLocaleTimeString(undefined, { hour: 'numeric' })}</text>`;
    }
    [0, 6, 12, 18, 24].forEach((i) => {
        if (i < n) g += `<text x="${x(i).toFixed(1)}" y="${H - 2}" font-size="8" fill="rgba(255,255,255,.4)" text-anchor="${i === 0 ? 'start' : i === 24 ? 'end' : 'middle'}">${i === 0 ? 'now' : new Date(spark[i].t).toLocaleTimeString(undefined, { hour: 'numeric' })}</text>`;
    });
    return `<svg class="sc-spark" style="max-width:480px" viewBox="0 0 ${W} ${H}" role="img" aria-label="Next 24 hours temperature and rain chance">${g}</svg>`;
}

/** 7-day hi/lo range bars. */
function weekBandSvg(week) {
    if (!week?.length) return '';
    const W = 360, H = 92, top = 26, base = 66, labY = 86;
    const slot = (W - 16) / week.length;
    const hi = Math.max(...week.map((d) => d.hiF)), lo = Math.min(...week.map((d) => d.loF ?? d.hiF));
    const y = (v) => base - (base - top) * ((v - lo) / ((hi - lo) || 1));
    let g = `<text x="8" y="9" font-size="8" fill="rgba(255,255,255,.5)" letter-spacing="1.6" font-weight="700">7-DAY RANGE</text>`;
    week.forEach((d, i) => {
        const cx = 8 + slot * i + slot / 2;
        const yh = y(d.hiF), yl = y(d.loF ?? d.hiF);
        g += `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${yh.toFixed(1)}" y2="${yl.toFixed(1)}" stroke="#ff8c5a" stroke-width="5" stroke-linecap="round" opacity=".8"/>`;
        g += `<text x="${cx.toFixed(1)}" y="${(yh - 5).toFixed(1)}" text-anchor="middle" font-size="8.6" fill="rgba(255,255,255,.8)" font-variant-numeric="tabular-nums">${Math.round(d.hiF)}°</text>`;
        g += `<text x="${cx.toFixed(1)}" y="${(yl + 11).toFixed(1)}" text-anchor="middle" font-size="8" fill="#6f6695" font-variant-numeric="tabular-nums">${Math.round(d.loF ?? d.hiF)}°</text>`;
        g += `<text x="${cx.toFixed(1)}" y="${labY}" text-anchor="middle" font-size="8.4" fill="#6f6695">${i === 0 ? 'Today' : new Date(d.t).toLocaleDateString(undefined, { weekday: 'short' })}</text>`;
    });
    return `<svg class="sc-spark" style="max-width:480px" viewBox="0 0 ${W} ${H}" role="img" aria-label="7-day temperature range">${g}</svg>`;
}

/** The year arc: multi-year mean solar input vs temperature, with lag. */
function yearArcSvg(arc, now) {
    if (!arc?.mean?.length) return '';
    const W = 620, H = 240, L = 40, R = 14, T = 18, B = 30;
    const iw = W - L - R, ih = H - T - B;
    const x = (doy) => L + iw * (doy / 365);
    const y = (v) => T + ih * (1 - v);
    const doyNow = Math.floor((now - new Date(new Date(now).getFullYear(), 0, 0).getTime()) / 86400e3);
    let g = '';
    for (const v of [0, 0.5, 1]) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#221743" stroke-width="1"/>`;
    const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    MO.forEach((m, i) => { g += `<text x="${x(cum[i] + 15).toFixed(1)}" y="${H - 10}" font-size="9.5" fill="#6f6695" text-anchor="middle">${m}</text>`; });
    g += `<text x="${L - 8}" y="${y(1) + 4}" font-size="9.5" fill="#6f6695" text-anchor="end">100%</text>`;
    g += `<text x="${L - 8}" y="${y(0) + 4}" font-size="9.5" fill="#6f6695" text-anchor="end">0%</text>`;
    const line = (key, color) => {
        const path = arc.mean.map((p, i) => `${i ? 'L' : 'M'}${x(p.doy).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
        return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    };
    g += line('solar', '#4ddbff') + line('temp', '#ff8c5a');
    if (arc.lagDays != null) {
        const yA = T + 12;
        g += `<line x1="${x(arc.sPeakDoy).toFixed(1)}" x2="${x(arc.tPeakDoy).toFixed(1)}" y1="${yA}" y2="${yA}" stroke="#2a3450" stroke-width="1"/>`
            + `<line x1="${x(arc.sPeakDoy).toFixed(1)}" x2="${x(arc.sPeakDoy).toFixed(1)}" y1="${yA - 3}" y2="${yA + 3}" stroke="#2a3450"/>`
            + `<line x1="${x(arc.tPeakDoy).toFixed(1)}" x2="${x(arc.tPeakDoy).toFixed(1)}" y1="${yA - 3}" y2="${yA + 3}" stroke="#2a3450"/>`
            + `<text x="${((x(arc.sPeakDoy) + x(arc.tPeakDoy)) / 2).toFixed(1)}" y="${yA - 5}" font-size="10" fill="#cdc4f0" text-anchor="middle">${arc.lagDays}-day lag</text>`;
    }
    g += `<line x1="${x(doyNow).toFixed(1)}" x2="${x(doyNow).toFixed(1)}" y1="${T}" y2="${T + ih}" stroke="#cdc4f0" stroke-width="1" stroke-opacity=".55"/>`
        + `<text x="${x(doyNow).toFixed(1)}" y="${T + ih + 10}" font-size="8.6" fill="#cdc4f0" text-anchor="middle">today</text>`;
    return `<svg class="sc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Solar input versus air temperature through the year">${g}</svg>`;
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
    // Anonymous visitors get the FREE-ACCOUNT door, not the sign-in door:
    // signin.html is a dead end for someone with no account (2026-09 funnel
    // read: the landing → signup handoff was 2 of 18 CTA clicks). Returning
    // users still have Sign In in the nav and the link on signup.html.
    return `<a class="sc-auth" href="/signup.html?plan=free" data-funnel-cta="console_signup">Save your sky — free account</a>`;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mount the console. Renders the full structure immediately (placeholders),
 * then re-renders the data regions on every 'swpc-update' /
 * 'user-location-changed' / 'auth-changed' / conditions refresh. Location
 * input + auth chip are STABLE elements (verdict-card lesson: re-rendering
 * an input mid-keystroke blows away the user's typing) — only data
 * containers get innerHTML swaps.
 */
export async function initSkyConsole(host) {
    if (!host) return;
    ensureStyles();

    const [locMod, condMod] = await Promise.all([
        import('./user-location.js'),
        import('./home-conditions.js'),
    ]);
    const { geocodeQuery, saveUserLocation, loadUserLocation } = locMod;
    const {
        tzGuessLocation, fetchConditions, fetchClimate,
        buildAirModel, buildEventsModel, buildTempModel, aqiCat,
    } = condMod;

    // Location: a saved real place wins; otherwise a timezone-guessed default
    // (approximate, in-memory only — never written to the shared store).
    let loc = loadUserLocation();
    if (!loc) {
        try { loc = tzGuessLocation(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch { /* stays null */ }
    }
    let wx = null, aqData = null, climate = null;
    let condStatus = 'idle';            // idle | loading | live | error
    let climateKey = null;
    let lastState = {};
    let sky, air, events, temp;         // models

    host.classList.add('sky-console');
    host.innerHTML = `
      <div class="sc-tabs" role="tablist" aria-label="Conditions console views">
        <button class="sc-tab sc-orb active" data-view="sky-air" role="tab" aria-selected="true" title="My Air" aria-label="My Air — air quality">
          <svg viewBox="0 0 110 110">
            <defs>
              <radialGradient id="sc-orb-sky" cx="35%" cy="28%" r="90%">
                <stop offset="0" stop-color="#0e1a3a"/><stop offset="1" stop-color="#04050e"/>
              </radialGradient>
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
            <circle id="sc-orb-arc" cx="55" cy="55" r="50" fill="none" stroke="#2eff9e" stroke-width="2.5"
                stroke-linecap="round" stroke-dasharray="0 315" transform="rotate(-90 55 55)"/>
            <g class="sc-orbit1"><circle cx="55" cy="5" r="2.6" fill="#8ff0ff"/></g>
            <g class="sc-orbit2"><circle cx="55" cy="17" r="1.7" fill="#ffd23f"/></g>
            <text id="sc-orb-aqi" x="55" y="60" text-anchor="middle" font-size="22" font-weight="700" fill="#f5f0ff" letter-spacing="-.5">—</text>
            <text x="55" y="76" text-anchor="middle" font-size="6.4" font-weight="700" fill="#cdc4f0" letter-spacing="1.8">MY AIR · AQI</text>
          </svg>
        </button>
        <button class="sc-tab" data-view="sky-events" role="tab" aria-selected="false" style="--tc:#ff5cb8">
          <span class="ti">${ICONS.bolt}</span><span><b>Major events</b><small data-sub="events">reading the board…</small></span>
        </button>
        <button class="sc-tab" data-view="sky-temp" role="tab" aria-selected="false" style="--tc:#ff8c5a">
          <span class="ti">${ICONS.thermo}</span><span><b>Temperature</b><small data-sub="temp">connecting…</small></span>
        </button>
        <button class="sc-tab" data-view="sky-space" role="tab" aria-selected="false" style="--tc:#c080ff">
          <span class="ti">${ICONS.planet}</span><span><b>Space weather</b><small data-sub="space">connecting…</small></span>
        </button>
        <button class="sc-tab" data-view="sky-aurora" role="tab" aria-selected="false" style="--tc:#2eff9e">
          <span class="ti">${ICONS.aurora}</span><span><b>Aurora</b><small data-sub="aurora">secondary check</small></span>
        </button>
      </div>

      <div class="sc-topbar">
        <span class="sc-wintitle"><span class="sc-dot" data-dot data-st="connecting"></span><span data-live>connecting…</span></span>
        <div class="sc-loc">
          <input data-loc-input type="text" placeholder="City or zip…" autocomplete="off" aria-label="Set your location">
          <button data-loc-geo title="Use my location">◎ Locate</button>
          <span data-auth-slot></span>
          <span class="sc-loc-msg" data-loc-msg></span>
        </div>
      </div>

      <div class="sc-galert" data-galert style="display:none" role="button" tabindex="0"></div>

      <div class="sc-view active" id="sky-air" role="tabpanel"><div class="sc-card" data-air-card></div></div>
      <div class="sc-view" id="sky-events" role="tabpanel"><div class="sc-card" data-events-card></div></div>
      <div class="sc-view" id="sky-temp" role="tabpanel"><div class="sc-card" data-temp-card></div></div>
      <div class="sc-view" id="sky-space" role="tabpanel"><div class="sc-card" data-space-card></div></div>
      <div class="sc-view" id="sky-aurora" role="tabpanel"><div class="sc-card" data-aurora-card></div></div>
    `;

    const $ = (sel) => host.querySelector(sel);
    const placeName = () => (loc ? `${loc.approx ? '≈ ' : ''}${loc.city || 'your location'}` : 'your location');
    const placeSuffix = () => (loc?.approx ? ' <span style="font-size:.7em;color:var(--sc-ink4)">(guessed from your clock — set your exact spot above)</span>' : '');

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
    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 2500));
    idle(() => { import('./auth.js').catch(() => {}); });

    // ── Location plumbing ─────────────────────────────────────────────────
    const locMsg = $('[data-loc-msg]');
    const setLocMsg = (t) => { locMsg.textContent = t || ''; };
    $('[data-loc-input]').addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const q = e.target.value.trim();
        if (!q) return;
        setLocMsg('Searching…');
        try {
            const found = await geocodeQuery(q);
            saveUserLocation(found);   // fires user-location-changed → reload
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
        if (!loc) {
            try { loc = tzGuessLocation(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch { /* null */ }
        }
        wx = null; aqData = null; climate = null;
        rebuild();
        loadConditions();
    });

    // ── Per-location Earth conditions ─────────────────────────────────────
    async function loadConditions() {
        if (!loc) { condStatus = 'idle'; rebuild(); return; }
        condStatus = 'loading';
        const forLoc = loc;
        try {
            const { wx: w, aq: a } = await fetchConditions(forLoc);
            if (forLoc !== loc) return;              // location changed mid-flight
            wx = w; aqData = a;
            condStatus = (w || a) ? 'live' : 'error';
        } catch { condStatus = 'error'; }
        rebuild();
        // Year-arc archive: lazy, once per location, after the fast data lands.
        const key = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
        if (climateKey !== key) {
            climateKey = key;
            fetchClimate(loc).then((c) => {
                if (`${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}` !== key) return;
                climate = c;
                rebuild();
            }).catch(() => {});
        }
    }
    setInterval(() => {
        if (document.visibilityState === 'visible' && loc) loadConditions();
    }, 10 * 60e3);

    // ── Render ────────────────────────────────────────────────────────────
    function renderChrome() {
        const dot = $('[data-dot]');
        // The dot reports the WORSE of the two pipelines (space feed + conditions).
        const swSt = sky.status;
        const st = swSt === 'offline' || condStatus === 'error' ? (swSt === 'offline' ? 'offline' : 'stale')
            : swSt === 'connecting' || condStatus === 'loading' ? 'connecting'
                : swSt === 'stale' ? 'stale' : 'live';
        dot.dataset.st = st;
        const t = sky.lastUpdated ? new Date(sky.lastUpdated) : new Date();
        $('[data-live]').textContent =
            st === 'live' ? `live · ${t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${sky.stormMode ? ' · storm mode' : ''}`
                : st === 'connecting' ? 'connecting…'
                    : st === 'stale' ? 'partial feeds — showing what’s live'
                        : 'offline — showing fallback data';

        // Orb = AQI
        const aqiTxt = $('#sc-orb-aqi');
        if (aqiTxt) {
            aqiTxt.textContent = air.aqi != null ? String(air.aqi) : '—';
            aqiTxt.setAttribute('fill', air.aqi != null ? air.cat.color : '#f5f0ff');
        }
        const arcEl = $('#sc-orb-arc');
        if (arcEl) {
            arcEl.setAttribute('stroke', air.aqi != null ? air.cat.color : '#2eff9e');
            arcEl.setAttribute('stroke-dasharray', `${(clamp01((air.aqi ?? 0) / 300) * 313.2).toFixed(1)} 315`);
        }
        const aur = $('#sc-orb-aurora');
        if (aur) aur.setAttribute('opacity', sky.aurora.available && sky.aurora.verdict?.state !== 'no' ? '.8'
            : (sky.kp ?? 0) >= 5 ? '.8' : '0');

        // Tab sub-lines
        const shortCat = air.cat.level === 2 ? 'Sensitive' : air.cat.label;
        const subs = {
            // Without weather data a quiet board only covers the space side —
            // never claim the week is quiet on a dead Earth feed.
            events: !events.quiet ? `${events.events.length} on the board`
                : wx ? 'quiet week ahead'
                    : condStatus === 'error' ? 'space side only' : 'reading the board…',
            temp: temp.available ? `${Math.round(temp.tempF)}° now · ${temp.hiF != null ? Math.round(temp.hiF) + '° high' : ''}` : 'connecting…',
            space: sky.kp == null ? 'connecting…'
                : sky.g.level > 0 ? `${sky.g.label} storm in progress` : `Kp ${fmt1(sky.kp)} · quiet`,
            aurora: !sky.aurora.available ? 'set a location'
                : sky.aurora.verdict.state === 'go' ? 'GO — in reach tonight'
                    : sky.aurora.verdict.state === 'maybe' ? 'maybe — low on horizon'
                        : sky.aurora.deepAlt > -12 ? 'no darkness tonight'
                            : `needs Kp ${sky.aurora.kpNeeded != null ? fmt1(sky.aurora.kpNeeded) : '9+'}`,
        };
        for (const [k, v] of Object.entries(subs)) {
            const el = host.querySelector(`[data-sub="${k}"]`);
            if (el) el.textContent = v;
        }

        // Alert band: worst of (major events ≥ Elevated) and (space alert).
        const ga = $('[data-galert]');
        const topEvent = events.events.find((e) => e.level >= 2) ?? null;
        const spaceAlert = sky.alert;
        if (topEvent && (!spaceAlert || topEvent.level >= spaceAlert.row.chipLevel)) {
            ga.style.display = 'flex';
            ga.style.setProperty('--ac', CHIP_COLORS[clamp(topEvent.level, 1, 3)]);
            ga.innerHTML = `${ICONS.bolt}<span><b>${esc(topEvent.name)}${topEvent.when ? ` — ${esc(new Date(topEvent.when).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' }))}` : ' — in progress'}:</b> ${esc(topEvent.magnitude)}</span><span class="go">View events →</span>`;
            ga.onclick = () => host.querySelector('.sc-tab[data-view="sky-events"]')?.click();
        } else if (spaceAlert) {
            const worst = spaceAlert.row;
            const cmeTxt = spaceAlert.cme?.eta_hours != null ? `CME arrives in ~${fmt0(spaceAlert.cme.eta_hours)} h · ` : '';
            ga.style.display = 'flex';
            ga.style.setProperty('--ac', CHIP_COLORS[Math.max(worst.chipLevel, 1)]);
            ga.innerHTML = `${ICONS.alert}<span><b>${cmeTxt}${esc(worst.name)}:</b> ${esc(worst.note)}</span><span class="go">View space weather →</span>`;
            ga.onclick = () => host.querySelector('.sc-tab[data-view="sky-space"]')?.click();
        } else ga.style.display = 'none';
    }

    function renderAir() {
        const card = $('[data-air-card]');
        if (air.aqi == null) {
            card.innerHTML = `
              <div class="formula"><b>Everything</b> → <b>breathability</b></div>
              <h3>Air quality at ${esc(placeName())}${placeSuffix()}</h3>
              <div class="desc">${condStatus === 'loading' || condStatus === 'idle'
                    ? 'Sampling the air at your location…'
                    : 'The air-quality feed is unreachable right now — the rest of the console runs on independent pipelines.'}</div>`;
            return;
        }
        const pollutants = air.pollutants.map((p) => `
          <div class="sc-meterrow"><div class="mname">${esc(p.name)}</div>
            <span class="sc-meter"><b style="background:${air.cat.color};width:${Math.round(p.norm * 100)}%"></b></span>
            <div class="mval">${fmt1(p.value)} ${p.unit}</div></div>`).join('');
        const factors = air.factors.map((f) => {
            const w = Math.abs(f.v) * 50;
            const bar = f.v >= 0 ? `left:50%;width:${w}%;background:#ff8c5a` : `right:50%;width:${w}%;background:#4ddbff`;
            return `<div class="sc-meterrow"><div class="mname">${esc(f.name)}</div>
              <div class="sc-fbar"><span class="mid"></span><b style="${bar}"></b></div>
              <div class="mval">${esc(f.label)}</div></div>`;
        }).join('');
        card.innerHTML = `
          <div class="formula"><b>Everything</b> → <b>breathability</b> — sun makes ozone, wind clears particles, heat feeds smoke</div>
          <h3>Air quality at ${esc(placeName())}${placeSuffix()}</h3>
          <div class="sc-hero-verdict"><div class="n" style="color:${air.cat.color}">${air.aqi}</div>
            <div class="cat"><b style="color:${air.cat.color}">${esc(air.cat.label)}</b> · US AQI${air.uvNow != null ? ` · UV ${fmt1(air.uvNow)}` : ''}</div></div>
          <div class="sc-aqi-track"><i style="left:${clamp((air.aqi / 300) * 100, 1, 99)}%"></i></div>
          <div class="sc-aqi-scale"><span>0</span><span>50</span><span>100</span><span>150</span><span>200</span><span>300+</span></div>
          ${pollutants}
          <div style="margin-top:10px" class="formula">What's loading / cleaning the air</div>
          ${factors}
          ${air.week.length ? `<div style="margin-top:10px" class="formula">Week ahead · forecast daily peak</div>${aqiWeekSvg(air.week, aqiCat)}` : ''}
          <div class="sc-verdict" style="border-left-color:${air.cat.color}"><b>${esc(air.verdict.text)}</b>${air.weekText ? ` ${esc(air.weekText)}` : ''}</div>
          <div class="sc-links">
            <a href="earth.html" data-funnel-cta="console_earth_air">Open the EarthView globe →</a>
            <a href="account.html">Alert me when air turns →</a>
          </div>`;
    }

    function renderEvents() {
        const card = $('[data-events-card]');
        const KIND = { space: 'Space', weather: 'Earth' };
        const rows = events.events.map((e) => {
            const when = e.when == null
                ? '<span style="color:#ff8c5a">Now</span><small>in progress</small>'
                : `${esc(new Date(e.when).toLocaleDateString(undefined, { weekday: 'short' }))}<small>${esc(new Date(e.when).toLocaleTimeString(undefined, { hour: 'numeric' }))}</small>`;
            return `<div class="sc-event">
              <div class="when">${when}</div>
              <div><div class="ename">${esc(e.name)} <span class="tag">${KIND[e.kind] ?? ''}</span></div>
                <div class="enote">${esc(e.note)}</div></div>
              ${chipHtml({ chip: ['', 'Watch', 'Elevated', 'High'][e.level] || 'Watch', chipLevel: e.level })}
            </div>`;
        }).join('');
        card.innerHTML = `
          <div class="formula"><b>Forecast</b> × <b>physics</b> — the next 7 days, Earth and Sun on one board</div>
          <h3>Major events for ${esc(placeName())}${placeSuffix()}</h3>
          <div class="desc">Thunderstorm fuel, flood rain, damaging wind, heat and freeze from the hourly forecast —
            merged with inbound space weather: CME arrivals, forecast geomagnetic storms, radiation events.</div>
          ${events.quiet
                ? (wx
                    ? `<div class="sc-verdict"><b>No major events on the board.</b> The next 7 days look quiet at ${esc(placeName())} — and the Sun is quiet too. This board lights up the moment either changes.</div>`
                    : `<div class="sc-verdict"><b>Space side is quiet; the local weather feed is unreachable right now,</b> so Earth-side events can't be scored. The board completes itself when the feed returns.</div>`)
                : rows + `<div class="sc-verdict"><b>${esc(events.topLine)}</b></div>`}
          <div class="sc-watchlist" aria-label="What this board watches">
            <span>⛈ thunderstorm fuel (CAPE)</span><span>🌧 flood rain</span><span>💨 damaging wind</span>
            <span>🌡 heat / freeze</span><span>☀️ CME arrivals</span><span>🧲 G-storm outlook</span><span>☢ radiation storms</span>
          </div>
          <div class="sc-links">
            <a href="space-weather.html" data-funnel-cta="console_dashboard_events">Open the full dashboard →</a>
            <a href="flux-rope-live.html">CME Compounding Watch →</a>
            <a href="account.html">Set alert thresholds →</a>
          </div>`;
    }

    function renderTemp() {
        const card = $('[data-temp-card]');
        if (!temp.available) {
            card.innerHTML = `
              <div class="formula"><b>Solar input</b> × <b>thermal memory</b></div>
              <h3>Temperature at ${esc(placeName())}${placeSuffix()}</h3>
              <div class="desc">${condStatus === 'loading' || condStatus === 'idle'
                    ? 'Reading the thermometer at your location…'
                    : 'The weather feed is unreachable right now.'}</div>`;
            return;
        }
        const arcBlock = temp.arc
            ? `<div style="margin-top:12px" class="formula">The year arc · ${temp.arc.years[0]}–${temp.arc.years[1]} · <span style="color:#4ddbff">■ solar input</span> vs <span style="color:#ff8c5a">■ air temperature</span> (% of annual range)</div>
               ${yearArcSvg(temp.arc, Date.now())}
               <div class="sc-verdict"><b>${temp.arc.lagDays != null ? `Your air runs ~${temp.arc.lagDays} days behind the Sun.` : 'Solar input and temperature, one year on top of the other.'}</b>
                 Solar input peaks at the solstice — the air answers weeks later, year after year. That repeatable gap is stored heat:
                 the planet's thermal memory, and the reason seasons spike after the solstices.</div>`
            : `<div class="sc-risknote" style="margin-top:10px">Loading the multi-year archive for the solar-vs-temperature year arc…</div>`;
        card.innerHTML = `
          <div class="formula"><b>Solar input</b> × <b>thermal memory</b> — today's number, and the physics behind its season</div>
          <h3>Temperature at ${esc(placeName())}${placeSuffix()}</h3>
          <div class="sc-temp-hero">
            <div class="n">${Math.round(temp.tempF)}°<small>F</small></div>
            <div class="sc-kv" style="margin:0">
              <span>Feels <b>${fmt0(temp.feelsF)}°</b></span>
              <span>Today <b>${fmt0(temp.hiF)}° / ${fmt0(temp.loF)}°</b></span>
              <span>Humidity <b>${fmt0(temp.rh)}%</b></span>
              <span>Wind <b>${fmt0(temp.windMph)} mph</b></span>
            </div>
          </div>
          <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end">
            <div style="flex:1 1 300px;min-width:0">${tempSparkSvg(temp.spark)}</div>
            <div style="flex:1 1 300px;min-width:0">${weekBandSvg(temp.week)}</div>
          </div>
          ${arcBlock}
          <div class="sc-links">
            <a href="earth.html" data-funnel-cta="console_earth_temp">Open the EarthView globe →</a>
            <a href="upper-atmosphere.html">Where the heat goes: the upper atmosphere →</a>
          </div>`;
    }

    function renderSpace() {
        const card = $('[data-space-card]');
        const gWord = sky.g.level > 0 ? `${sky.g.label} ${sky.g.name.toLowerCase()} storm`
            : sky.kp == null ? '—' : sky.kp < 3 ? 'quiet field' : 'unsettled field';
        const flares = sky.sun.flares.length
            ? `<ul class="sc-flare-list">${sky.sun.flares.map((f) => `<li><b>${esc(f.cls ?? '—')}</b><span>${fmtTime(f.time)}</span>${f.location ? `<span style="color:var(--sc-ink4)">${esc(f.location)}</span>` : ''}</li>`).join('')}</ul>`
            : '<div class="sc-risknote">No M/X flares in the recent record.</div>';
        const cme = sky.sun.cme
            ? `<div class="sc-verdict" style="border-left-color:#ff5cb8"><b>Earth-directed CME in transit${sky.sun.cme.eta_hours != null ? ` — arrives in ~${fmt0(sky.sun.cme.eta_hours)} h` : ''}.</b>
                The <a href="flux-rope-live.html" style="color:var(--sc-accent)">Compounding Watch</a> tracks the Bz forecast that decides how hard it hits.</div>`
            : '';
        const standoff = sky.sat.standoffRe != null
            ? `<span>Magnetopause <b>${fmt1(sky.sat.standoffRe)} R⊕</b>${sky.sat.geoExposed ? ' <b style="color:#ff8c5a">— GEO exposed</b>' : ''}</span>` : '';
        card.innerHTML = `
          <div class="formula"><b>NOAA scales</b> × <b>live feeds</b> — the Sun's side of your sky</div>
          <h3>Space weather right now</h3>
          <div class="sc-hero-verdict"><div class="n" style="color:${kpColor(sky.kp)}">Kp ${sky.kp != null ? fmt1(sky.kp) : '—'}</div>
            <div class="cat"><b>${esc(gWord)}</b> · ${esc(sky.headline)}</div></div>
          <div class="sc-kv">
            <span>Wind <b>${fmt0(sky.speed)} km/s</b></span>
            <span>Bz <b>${sky.bz != null ? (sky.bz > 0 ? '+' : '') + fmt1(sky.bz) + ' nT' : '—'}</b></span>
            <span>Density <b>${fmt1(sky.density)} p/cm³</b></span>
            <span>X-ray <b>${esc(sky.xrayClass ?? '—')}</b></span>
            <span>F10.7 <b>${fmt0(sky.f107)} sfu</b></span>
            ${standoff}
          </div>
          ${kpSparkSvg(lastState.kp_forecast, sky.aurora.available ? sky.aurora.kpNeeded : null, Date.now())}
          ${sky.rows.map(riskRowHtml).join('')}
          ${xraySparkSvg(sky.sun.series)}
          <div style="margin-top:8px" class="formula">Latest flares</div>
          ${flares}
          ${cme}
          <details class="sc-tbl"><summary>What the scales mean</summary>
            <table><tr><th>Scale</th><th>Measures</th><th>Trips at</th></tr>
              <tr><td>G1–G5</td><td>Geomagnetic storms (Kp)</td><td>Kp 5 → G1 … Kp 9 → G5</td></tr>
              <tr><td>R1–R5</td><td>Radio blackouts (X-ray flares)</td><td>M1 → R1 · X1 → R3 · X20 → R5</td></tr>
              <tr><td>S1–S5</td><td>Radiation storms (≥10 MeV protons)</td><td>10 pfu → S1 · 10⁴ pfu → S4</td></tr></table></details>
          <div class="sc-links">
            <a href="space-weather.html" data-funnel-cta="console_dashboard_space">Open the full dashboard →</a>
            <a href="sun.html">Solar engine →</a>
            <a href="operations.html">Operations console →</a>
          </div>`;
    }

    function renderAurora() {
        const card = $('[data-aurora-card]');
        if (!sky.aurora.available) {
            card.innerHTML = `
              <div class="formula"><b>Kp</b> × <b>your latitude</b> × <b>darkness</b> × <b>cloud</b></div>
              <h3>Will you see the aurora tonight?</h3>
              <div class="desc">Set a location in the bar above (city, zip, or ◎ Locate) and this tab turns into a
                personal go / no-go verdict: how far the auroral oval sits from your sky, and exactly what Kp would put it overhead.</div>
              <div class="sc-verdict"><b>No location set.</b> The oval is currently reaching ${fmt1(boundaryForKp(sky.aurora.kpEff ?? 0))}° magnetic latitude.</div>`;
            return;
        }
        const a = sky.aurora;
        const v = a.verdict;
        const stateCol = v.state === 'go' ? '#2eff9e' : v.state === 'maybe' ? '#ffd23f' : '#9d92c8';
        const needTxt = a.kpNeeded == null ? 'even Kp 9 leaves the oval out of visual range — travel poleward for a show'
            : a.kpNeeded <= (sky.kp ?? 0) ? 'that bar is met right now'
                : `tonight's max forecast is Kp ${fmt1(a.kpEff)}`;
        card.innerHTML = `
          <div class="formula"><b>Kp</b> × <b>your latitude</b> × <b>darkness</b> × <b>cloud</b></div>
          <h3>Aurora at ${esc(placeName())}${placeSuffix()}</h3>
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
                ? `<b>Get somewhere dark.</b> At Kp ${fmt1(a.kpEff)} the oval's edge reaches ${fmt1(a.boundaryEff)}° magnetic — ${v.margin <= 0 ? 'overhead at your latitude' : 'close enough to fill your poleward sky'}.`
                : v.state === 'maybe'
                    ? '<b>Camera odds beat eyeball odds.</b> Point a long exposure at the poleward horizon after dark.'
                    : `<b>Not tonight.</b> ${esc(v.desc)}`}</div>
          <div class="sc-links">
            <a href="auroracle.html" data-funnel-cta="console_auroracle">Get AurOracle alerts for this spot →</a>
            <a href="earth.html">Open the EarthView globe →</a>
          </div>`;
    }

    function rebuild() {
        sky = buildSkyModel(lastState, { loc, cloudPct: wx?.current?.cloud ?? null });
        air = buildAirModel(aqData, wx);
        events = buildEventsModel(lastState, wx);
        temp = buildTempModel(wx, climate);
        renderChrome();
        renderAir();
        renderEvents();
        renderTemp();
        renderSpace();
        renderAurora();
    }

    window.addEventListener('swpc-update', (e) => {
        lastState = e.detail ?? {};
        rebuild();
    });

    rebuild();          // placeholder paint before any feed dispatch
    loadConditions();   // per-location Earth data (no-op without a location)
}
