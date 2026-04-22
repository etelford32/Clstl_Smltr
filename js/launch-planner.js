/**
 * launch-planner.js — Upcoming orbital launches + weather Go/No-Go analysis.
 *
 * Target users: commercial launch operators (SpaceX, Blue Origin, ULA,
 * Rocket Lab) who want a quick weather read on pad conditions for scheduled
 * missions.
 *
 * Pipeline:
 *   1. GET /api/launches/upcoming  (Launch Library 2, cached 1 hr).
 *   2. Render left-panel filters + center roster of launch cards sorted by T-.
 *   3. On card select, fetchLaunchForecast(pad.lat, pad.lon) — pulls current
 *      + 7-day hourly + daily in one Open-Meteo call so we can score weather
 *      at the actual NET, not "right now."
 *   4. Score a time-aligned snapshot against public launch commit criteria
 *      (wind, precip, cloud, thunderstorm, temperature). Worst rule wins.
 *      scoreWeather() takes an optional ruleset so per-vehicle thresholds
 *      (Falcon 9 vs. Electron vs. crewed Dragon) plug in without refactors.
 *   5. Per-second countdown updates T-minus on every visible card.
 *
 * No Supabase writes. No auth required beyond nav tier gating.
 */

import {
    fetchLaunchForecast,
    weatherCodeLabel,
    compassLabel,
} from './trip-planner.js';
import { resolveRuleset } from './launch-rulesets.js';

// ── Rulesets ────────────────────────────────────────────────────────────────
// Default ruleset is a conservative blend of publicly-documented launch
// commit criteria (SpaceX Falcon 9 user's guide + 45 WS Flight Commit
// Criteria for Cape Canaveral / KSC). Vehicle-specific rulesets will override
// any subset of these in v3.

export const DEFAULT_RULESET = Object.freeze({
    id: 'default',
    label: 'Generic orbital launch',
    wind:        { green: 20, yellow: 30 },   // mph, sustained at pad
    gust:        { green: 25, yellow: 35 },   // mph, peak at pad
    // Upper-level winds and vector shear across the max-Q band (≈9–12 km).
    // Conservative generic thresholds; per-vehicle overrides in
    // js/launch-rulesets.js tune these to each rocket's published FCC.
    upper_wind:  { green: 90, yellow: 140 },  // mph at 200 hPa (~12 km)
    upper_shear: { green: 55, yellow: 90 },   // mph vector diff, 300→200 hPa
    precip:      { green: 25, yellow: 50 },   // %, hourly probability at T-0
    cloud:       { green: 50, yellow: 75 },   // %, total cover
    tempLo:      { red: 35, yellow: 40 },     // °F
    tempHi:      { yellow: 95, red: 100 },    // °F
});

const THUNDERSTORM_CODES = new Set([95, 96, 99]);

const VERDICT_RANK = { green: 0, yellow: 1, red: 2 };

function worst(a, b) {
    return VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a;
}

function bandSustainedWind(mph, T) {
    if (mph == null || !Number.isFinite(mph)) return { v: 'yellow', note: 'unknown' };
    if (mph < T.wind.green)  return { v: 'green',  note: `${mph.toFixed(0)} mph` };
    if (mph < T.wind.yellow) return { v: 'yellow', note: `${mph.toFixed(0)} mph — marginal` };
    return { v: 'red', note: `${mph.toFixed(0)} mph — over ${T.wind.yellow} mph ground wind` };
}

function bandGust(mph, T) {
    if (mph == null || !Number.isFinite(mph)) return { v: 'yellow', note: 'unknown' };
    if (mph < T.gust.green)  return { v: 'green',  note: `${mph.toFixed(0)} mph` };
    if (mph < T.gust.yellow) return { v: 'yellow', note: `${mph.toFixed(0)} mph — watch gusts` };
    return { v: 'red', note: `${mph.toFixed(0)} mph — gusts over ${T.gust.yellow} mph` };
}

function bandPrecip(pct, T) {
    if (pct == null || !Number.isFinite(pct)) return { v: 'green', note: 'no precip forecast' };
    if (pct < T.precip.green)  return { v: 'green',  note: `${pct}% chance` };
    if (pct < T.precip.yellow) return { v: 'yellow', note: `${pct}% — possible scrub` };
    return { v: 'red', note: `${pct}% — wet weather expected` };
}

function bandCloud(pct, T) {
    if (pct == null || !Number.isFinite(pct)) return { v: 'yellow', note: 'unknown' };
    if (pct < T.cloud.green)  return { v: 'green',  note: `${pct}% cover` };
    if (pct < T.cloud.yellow) return { v: 'yellow', note: `${pct}% — watch ceiling` };
    return { v: 'red', note: `${pct}% — overcast` };
}

function bandTemp(f, T) {
    if (f == null || !Number.isFinite(f)) return { v: 'yellow', note: 'unknown' };
    if (f < T.tempLo.red)    return { v: 'red',    note: `${f.toFixed(0)}°F — below ${T.tempLo.red}°F cutoff` };
    if (f < T.tempLo.yellow) return { v: 'yellow', note: `${f.toFixed(0)}°F — cold` };
    if (f > T.tempHi.red)    return { v: 'red',    note: `${f.toFixed(0)}°F — heat extreme` };
    if (f > T.tempHi.yellow) return { v: 'yellow', note: `${f.toFixed(0)}°F — hot` };
    return { v: 'green', note: `${f.toFixed(0)}°F` };
}

function bandLightning(code) {
    if (code != null && THUNDERSTORM_CODES.has(code)) return { v: 'red', note: weatherCodeLabel(code) };
    return { v: 'green', note: 'no thunderstorms' };
}

function bandUpperWind(mph, T) {
    // Forecast-based proxy for balloon-release peak wind at max-Q.
    // A day-of launch would refine this with an actual jimsphere/balloon
    // profile; the forecast catches the "clearly over" and "clearly under"
    // cases, which are the majority of scrubs.
    if (mph == null || !Number.isFinite(mph)) return { v: 'yellow', note: 'pressure-level wind unavailable' };
    if (mph < T.upper_wind.green)  return { v: 'green',  note: `${Math.round(mph)} mph at ~12 km` };
    if (mph < T.upper_wind.yellow) return { v: 'yellow', note: `${Math.round(mph)} mph at ~12 km — watch jet stream` };
    return { v: 'red', note: `${Math.round(mph)} mph at ~12 km — jet stream over limit` };
}

function bandUpperShear(mph, T) {
    if (mph == null || !Number.isFinite(mph)) return { v: 'yellow', note: 'shear unavailable' };
    if (mph < T.upper_shear.green)  return { v: 'green',  note: `${Math.round(mph)} mph across max-Q band` };
    if (mph < T.upper_shear.yellow) return { v: 'yellow', note: `${Math.round(mph)} mph — elevated shear` };
    return { v: 'red', note: `${Math.round(mph)} mph — severe wind shear` };
}

// ── Snapshot helpers ────────────────────────────────────────────────────────
// Forecast data is laid out as parallel hourly arrays. A snapshot is the
// projection of those arrays at one hour index — the shape scoreWeather()
// operates on. Lets us score any point in the forecast horizon, not just
// "right now."

/**
 * Build a snapshot (the shape scoreWeather consumes) from an hourly index.
 * Returns null if the forecast doesn't extend to this hour.
 */
export function snapshotAt(fc, targetIso) {
    if (!fc?.hourly?.time?.length || !targetIso) return null;
    const target = Date.parse(targetIso);
    if (!Number.isFinite(target)) return null;

    const times = fc.hourly.time;
    const lastIdx = times.length - 1;
    const lastMs = Date.parse(times[lastIdx]);
    if (Number.isFinite(lastMs) && target > lastMs + 3600_000) {
        // Target is beyond the forecast horizon — let the caller fall back.
        return null;
    }

    // Nearest-hour lookup. Open-Meteo timestamps are on the hour in local
    // tz; binary search would be overkill for 168 slots.
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
        const t = Date.parse(times[i]);
        const diff = Math.abs(t - target);
        if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    const i = best;
    const h = fc.hourly;

    // Upper-level winds and vector shear across the max-Q band. Meteorological
    // wind direction is the direction wind is blowing FROM, in degrees; we
    // convert each pressure level to (u, v) components, take the vector
    // difference 300→200 hPa, and return the magnitude. This is the "shear
    // across max-Q" signal operators care about: a rocket passing through a
    // strongly sheared layer experiences rapid lateral loads the TVC has
    // only milliseconds to null out.
    const w200 = h.wind_200_mph?.[i];
    const d200 = h.wind_200_dir_deg?.[i];
    const w300 = h.wind_300_mph?.[i];
    const d300 = h.wind_300_dir_deg?.[i];
    const shearMag = _vectorShear(w300, d300, w200, d200);

    return {
        time:             times[i],
        target_iso:       targetIso,
        lead_hours:       (target - Date.now()) / 3600_000,
        slot_offset_min:  Math.round((Date.parse(times[i]) - target) / 60_000),
        temp_f:           h.temp_f?.[i]           ?? null,
        wind_mph:         h.wind_mph?.[i]         ?? null,
        wind_gust_mph:    h.wind_gust_mph?.[i]    ?? null,
        wind_dir_deg:     h.wind_dir_deg?.[i]     ?? null,
        precip_prob_pct:  h.precip_prob_pct?.[i]  ?? null,
        precip_in:        h.precip_in?.[i]        ?? null,
        cloud_cover:      h.cloud_cover?.[i]      ?? null,
        weather_code:     h.weather_code?.[i]     ?? null,
        humidity:         h.humidity?.[i]         ?? null,
        visibility_m:     h.visibility_m?.[i]     ?? null,
        cape_j_per_kg:    h.cape_j_per_kg?.[i]    ?? null,
        upper_wind_mph:       Number.isFinite(w200) ? w200 : null,
        upper_wind_dir_deg:   Number.isFinite(d200) ? d200 : null,
        upper_wind_500_mph:   Number.isFinite(h.wind_500_mph?.[i]) ? h.wind_500_mph[i] : null,
        upper_wind_300_mph:   Number.isFinite(w300) ? w300 : null,
        upper_shear_mph:      Number.isFinite(shearMag) ? shearMag : null,
    };
}

/**
 * Magnitude of the vector difference between two winds given as
 * (speed, meteorological-direction). Returns null if either side is missing.
 * Output units match the inputs (mph in this module).
 */
function _vectorShear(speedA, dirDegA, speedB, dirDegB) {
    if (!Number.isFinite(speedA) || !Number.isFinite(speedB) ||
        !Number.isFinite(dirDegA) || !Number.isFinite(dirDegB)) return null;
    // Meteorological dir is "from"; convert to math radians ("to" vector).
    const aRad = ((dirDegA + 180) % 360) * Math.PI / 180;
    const bRad = ((dirDegB + 180) % 360) * Math.PI / 180;
    const uA = speedA * Math.sin(aRad), vA = speedA * Math.cos(aRad);
    const uB = speedB * Math.sin(bRad), vB = speedB * Math.cos(bRad);
    return Math.hypot(uA - uB, vA - vB);
}

/**
 * Project the `current` block into the same snapshot shape as snapshotAt()
 * so the scorer can consume either interchangeably.
 */
function snapshotFromCurrent(fc) {
    const c = fc?.current;
    if (!c) return null;
    return {
        time:             c.time,
        target_iso:       c.time,
        lead_hours:       0,
        slot_offset_min:  0,
        temp_f:           c.temp_f ?? null,
        wind_mph:         c.wind_mph ?? null,
        wind_gust_mph:    c.wind_gust_mph ?? null,
        wind_dir_deg:     c.wind_dir_deg ?? null,
        precip_prob_pct:  null,                 // current block has no prob
        precip_in:        c.precip_in ?? null,
        cloud_cover:      c.cloud_cover ?? null,
        weather_code:     c.weather_code ?? null,
        humidity:         c.humidity ?? null,
        visibility_m:     null,
        cape_j_per_kg:    null,
    };
}

/**
 * Score a snapshot against launch commit criteria.
 * @param {object} snap     — shape returned by snapshotAt() or snapshotFromCurrent()
 * @param {object} [opts]
 * @param {object} [opts.ruleset] — override any subset of DEFAULT_RULESET
 * @returns {{ verdict: 'green'|'yellow'|'red', rules: Array, ruleset_id: string }}
 */
export function scoreWeather(snap, opts = {}) {
    const T = { ...DEFAULT_RULESET, ...(opts.ruleset || {}) };
    if (!snap) {
        return {
            verdict:    'yellow',
            rules:      [{ key: 'data', label: 'Forecast', v: 'yellow', note: 'No forecast available' }],
            ruleset_id: T.id,
        };
    }
    const rules = [
        { key: 'wind',        label: 'Ground wind',      ...bandSustainedWind(snap.wind_mph, T) },
        { key: 'gust',        label: 'Wind gusts',       ...bandGust(snap.wind_gust_mph, T) },
        { key: 'upper_wind',  label: 'Upper winds (max-Q)', ...bandUpperWind(snap.upper_wind_mph, T) },
        { key: 'upper_shear', label: 'Wind shear',       ...bandUpperShear(snap.upper_shear_mph, T) },
        { key: 'precip',      label: 'Precipitation',    ...bandPrecip(snap.precip_prob_pct, T) },
        { key: 'cloud',       label: 'Cloud cover',      ...bandCloud(snap.cloud_cover, T) },
        { key: 'lightning',   label: 'Thunderstorms',    ...bandLightning(snap.weather_code) },
        { key: 'temp',        label: 'Temperature',      ...bandTemp(snap.temp_f, T) },
    ];
    const verdict = rules.reduce((acc, r) => worst(acc, r.v), 'green');
    return { verdict, rules, ruleset_id: T.id, snapshot: snap };
}

/**
 * Compute the full scoring bundle for a launch: primary T-0 score plus a
 * lead-time arc (T-6h, T-1h, T-0, T+1h, T+3h) so the UI can show whether
 * the verdict is improving, holding, or deteriorating across the window.
 */
export function scoreLaunch(fc, netIso, opts = {}) {
    if (!fc) {
        return {
            verdict:   'yellow',
            primary:   scoreWeather(null, opts),
            arc:       [],
            source:    'none',
            target_iso: netIso,
        };
    }
    // If NET is missing or beyond the forecast horizon, fall back to `current`
    // so new launches still show *something* — just flag the source.
    const hasHourly = !!fc.hourly?.time?.length;
    const targetMs  = netIso ? Date.parse(netIso) : NaN;
    const horizonOk = Number.isFinite(targetMs)
        && hasHourly
        && targetMs <= (fc.horizon_end_ms || (Date.parse(fc.hourly.time[fc.hourly.time.length - 1]) + 3600_000));

    if (!horizonOk) {
        const snap = snapshotFromCurrent(fc);
        return {
            verdict:    scoreWeather(snap, opts).verdict,
            primary:    scoreWeather(snap, opts),
            arc:        [],
            source:     hasHourly && Number.isFinite(targetMs) ? 'beyond-horizon' : (netIso ? 'current' : 'no-net'),
            target_iso: netIso,
        };
    }

    const primarySnap = snapshotAt(fc, netIso);
    const primary     = scoreWeather(primarySnap, opts);

    // Arc offsets in hours from NET — picked to bracket the most common
    // scrub windows and recovery ops.
    const ARC_OFFSETS_H = [-6, -1, 0, 1, 3];
    const arc = ARC_OFFSETS_H.map(dh => {
        const iso = new Date(targetMs + dh * 3600_000).toISOString();
        const s   = snapshotAt(fc, iso);
        const sc  = scoreWeather(s, opts);
        return {
            offset_h: dh,
            label:    dh === 0 ? 'T-0' : dh < 0 ? `T${dh}h` : `T+${dh}h`,
            verdict:  sc.verdict,
            snapshot: s,
        };
    });

    return {
        verdict:    primary.verdict,
        primary,
        arc,
        source:     'hourly',
        target_iso: netIso,
    };
}

// ── Countdown formatting ────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

export function formatCountdown(targetIso, now = Date.now()) {
    if (!targetIso) return 'TBD';
    const t = Date.parse(targetIso);
    if (!Number.isFinite(t)) return 'TBD';
    const diff = t - now;
    const abs = Math.abs(diff);
    const d = Math.floor(abs / 86400000);
    const h = Math.floor((abs % 86400000) / 3600000);
    const m = Math.floor((abs % 3600000) / 60000);
    const s = Math.floor((abs % 60000) / 1000);
    const sign = diff >= 0 ? 'T-' : 'T+';
    if (d > 0) return `${sign}${d}d ${pad2(h)}:${pad2(m)}:${pad2(s)}`;
    return `${sign}${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

// ── Launch feed fetching ────────────────────────────────────────────────────

async function fetchLaunches(windowDays = 90, limit = 50) {
    const params = new URLSearchParams({ limit: String(limit), window_days: String(windowDays) });
    try {
        const res = await fetch(`/api/launches/upcoming?${params}`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data;
    } catch (e) {
        console.warn('[LaunchPlanner] feed fetch failed:', e.message);
        return { launches: [], error: e.message };
    }
}

// ── Rendering ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function escHtml(s) {
    return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatLocalTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function verdictColor(v) {
    return v === 'red' ? '#ff4444' : v === 'yellow' ? '#ffaa00' : '#44cc88';
}

function verdictLabel(v) {
    return v === 'red' ? 'NO-GO' : v === 'yellow' ? 'HOLD' : 'GO';
}

function confidenceTooltip(c) {
    if (c === 'high')            return 'Thresholds from the vehicle\'s primary public user\'s guide or 45 WS Flight Commit Criteria.';
    if (c === 'medium')          return 'Thresholds derived from FAA EIS, press statements, or historical scrub behavior.';
    if (c === 'public-estimate') return 'No primary public source; conservative analog from a similar-class vehicle.';
    if (c === 'generic')         return 'Vehicle not in catalog; using generic default thresholds.';
    return '';
}

// Render a two-letter ISO country code to its flag emoji (skipped if not exactly 2 letters).
function countryFlag(cc) {
    if (!cc || typeof cc !== 'string' || cc.length !== 2) return '';
    const base = 0x1F1E6;
    const a = cc.toUpperCase().charCodeAt(0) - 65;
    const b = cc.toUpperCase().charCodeAt(1) - 65;
    if (a < 0 || a > 25 || b < 0 || b > 25) return '';
    return String.fromCodePoint(base + a) + String.fromCodePoint(base + b);
}

function renderCard(l) {
    const verdict = l._score?.verdict || 'unknown';
    const color   = verdictColor(verdict);
    const label   = l._score ? verdictLabel(verdict) : '—';
    const net     = formatLocalTime(l.net_iso);
    const flag    = countryFlag(l.pad?.country_code);
    return `
        <button type="button" class="lp-card${verdict === 'red' ? ' lp-card--red' : verdict === 'yellow' ? ' lp-card--yellow' : verdict === 'green' ? ' lp-card--green' : ''}" data-launch-id="${escHtml(l.id)}">
            <div class="lp-card-hd">
                <span class="lp-card-provider">${escHtml(l.provider)}</span>
                <span class="lp-badge" style="background:${color}22;border-color:${color}55;color:${color}">${label}</span>
            </div>
            <div class="lp-card-name">${escHtml(l.name)}</div>
            <div class="lp-card-meta">
                <span class="lp-card-vehicle">${escHtml(l.vehicle)}</span>
                <span class="lp-card-dot">·</span>
                <span class="lp-card-pad">${flag ? flag + ' ' : ''}${escHtml(l.pad?.location || '—')}</span>
            </div>
            <div class="lp-card-footer">
                <span class="lp-card-net">${escHtml(net)}</span>
                <span class="lp-countdown" data-net="${escHtml(l.net_iso || '')}">${formatCountdown(l.net_iso)}</span>
            </div>
        </button>
    `;
}

function renderRuleRow(r) {
    const color = verdictColor(r.v);
    return `
        <div class="lp-rule">
            <span class="lp-rule-dot" style="background:${color}"></span>
            <span class="lp-rule-k">${escHtml(r.label)}</span>
            <span class="lp-rule-v">${escHtml(r.note)}</span>
        </div>
    `;
}

function renderDetail(l, fc, score) {
    if (!l) {
        return `<div class="lp-empty">Select a launch on the left to see weather Go/No-Go analysis.</div>`;
    }

    const verdict = score?.verdict || 'unknown';
    const color   = verdictColor(verdict);
    const label   = score ? verdictLabel(verdict) : '…analyzing';

    const lat = l.pad?.lat;
    const lon = l.pad?.lon;
    const hasPad = Number.isFinite(lat) && Number.isFinite(lon);

    // The T-0 snapshot is what the verdict is actually computed from. If we
    // fell back to `current` (no NET, or NET beyond forecast horizon) the
    // snapshot still exists — we just label it differently.
    const snap = score?.primary?.snapshot;
    const src  = score?.source || 'none';
    const srcLabel =
        src === 'hourly'         ? `Forecast at T-0 (${formatLocalTime(snap?.target_iso)})` :
        src === 'current'        ? 'Current conditions at pad (no NET set)' :
        src === 'beyond-horizon' ? 'Current conditions (NET beyond 7-day forecast)' :
        'Current conditions';
    const srcNote =
        src === 'beyond-horizon' ? 'Hourly forecast re-evaluates as T-0 moves inside the 7-day window.' :
        src === 'current'        ? 'Set a NET to time-align the forecast.' : '';

    const weatherBlock = !hasPad
        ? `<div class="lp-wx-loading">Pad coordinates are not published yet — weather analysis unavailable.</div>`
        : snap ? `
            <div class="lp-wx-sub">${escHtml(srcLabel)}${srcNote ? ` — <span style="color:#667">${escHtml(srcNote)}</span>` : ''}</div>
            <div class="lp-wx-grid">
                <div class="lp-wx-cell"><div class="lp-wx-k">Conditions</div><div class="lp-wx-v">${escHtml(weatherCodeLabel(snap.weather_code))}</div></div>
                <div class="lp-wx-cell"><div class="lp-wx-k">Temp</div><div class="lp-wx-v">${snap.temp_f != null ? `${snap.temp_f.toFixed(0)}°F` : '—'}</div></div>
                <div class="lp-wx-cell"><div class="lp-wx-k">Wind</div><div class="lp-wx-v">${snap.wind_mph != null ? `${snap.wind_mph.toFixed(0)} mph ${compassLabel(snap.wind_dir_deg)}` : '—'}</div></div>
                <div class="lp-wx-cell"><div class="lp-wx-k">Gusts</div><div class="lp-wx-v">${snap.wind_gust_mph != null ? `${snap.wind_gust_mph.toFixed(0)} mph` : '—'}</div></div>
                <div class="lp-wx-cell"><div class="lp-wx-k">Cloud</div><div class="lp-wx-v">${snap.cloud_cover != null ? `${snap.cloud_cover}%` : '—'}</div></div>
                <div class="lp-wx-cell"><div class="lp-wx-k">Precip prob</div><div class="lp-wx-v">${snap.precip_prob_pct != null ? `${snap.precip_prob_pct}%` : '—'}</div></div>
            </div>
        ` : `<div class="lp-wx-loading">Fetching pad weather…</div>`;

    const arcBlock = (score?.arc?.length) ? `
        <div class="lp-label">Launch-window arc</div>
        <div class="lp-arc">
            ${score.arc.map(stop => {
                const s  = stop.snapshot;
                const c  = verdictColor(stop.verdict);
                const wind = s?.wind_mph != null ? `${Math.round(s.wind_mph)} mph` : '—';
                const prec = s?.precip_prob_pct != null ? `${s.precip_prob_pct}%` : '—';
                return `
                    <div class="lp-arc-stop" title="${escHtml(weatherCodeLabel(s?.weather_code))}">
                        <div class="lp-arc-name">${escHtml(stop.label)}</div>
                        <div class="lp-arc-dot" style="background:${c}"></div>
                        <div class="lp-arc-v">${verdictLabel(stop.verdict)}</div>
                        <div class="lp-arc-metric">${wind}</div>
                        <div class="lp-arc-metric lp-arc-precip">${prec}</div>
                    </div>
                `;
            }).join('')}
        </div>
    ` : '';

    const forecastBlock = fc?.daily?.dates?.length ? `
        <div class="lp-label">7-Day Daily Outlook</div>
        <div class="lp-forecast">
            ${fc.daily.dates.map((d, i) => {
                const dt = new Date(d);
                const name = dt.toLocaleDateString([], { weekday: 'short' });
                const hi = fc.daily.high_f?.[i];
                const lo = fc.daily.low_f?.[i];
                const pp = fc.daily.precip_prob_pct?.[i];
                return `
                    <div class="lp-fc-day">
                        <div class="lp-fc-name">${escHtml(name)}</div>
                        <div class="lp-fc-temp"><span class="lp-fc-hi">${hi != null ? Math.round(hi) : '—'}°</span><span class="lp-fc-lo">${lo != null ? Math.round(lo) : '—'}°</span></div>
                        <div class="lp-fc-precip">${pp != null ? pp : 0}%</div>
                    </div>
                `;
            }).join('')}
        </div>
    ` : '';

    const primaryRules = score?.primary?.rules || score?.rules;
    const veh = l._vehicle;  // resolved vehicle + ruleset + metadata
    const confBadge = veh ? `<span class="lp-conf lp-conf--${escHtml(veh.confidence)}" title="${escHtml(confidenceTooltip(veh.confidence))}">${escHtml(veh.confidence)}</span>` : '';
    const sourceTxt = veh?.sources?.length ? `<div class="lp-rule-sources">Sources: ${veh.sources.map(escHtml).join(' · ')}</div>` : '';
    const notes     = veh?.notes ? `<div class="lp-rule-note">${escHtml(veh.notes)}</div>` : '';
    const ruleBlock = primaryRules ? `
        <div class="lp-label">Launch Commit Criteria${veh ? ` <span class="lp-rule-src">· ${escHtml(veh.label)} ruleset ${confBadge}</span>` : ''}</div>
        <div class="lp-rules">${primaryRules.map(renderRuleRow).join('')}</div>
        ${sourceTxt}${notes}
    ` : '';

    return `
        <div class="lp-detail">
            <div class="lp-detail-hd">
                <div>
                    <div class="lp-detail-provider">${escHtml(l.provider)}</div>
                    <h2 class="lp-detail-name">${escHtml(l.name)}</h2>
                    <div class="lp-detail-sub">${escHtml(l.vehicle)} · ${escHtml(l.pad?.name || '')} · ${escHtml(l.pad?.location || '')}</div>
                </div>
                <span class="lp-verdict" style="background:${color}22;border-color:${color};color:${color}">${label}</span>
            </div>

            <div class="lp-detail-row">
                <div class="lp-clock">
                    <div class="lp-label">T-minus</div>
                    <div class="lp-countdown-big" data-net="${escHtml(l.net_iso || '')}">${formatCountdown(l.net_iso)}</div>
                    <div class="lp-net">NET ${formatLocalTime(l.net_iso)} local</div>
                </div>
                <div class="lp-pad">
                    <div class="lp-label">Pad</div>
                    <div class="lp-pad-name">${escHtml(l.pad?.name || '—')}</div>
                    <div class="lp-pad-coords">${hasPad ? `${lat.toFixed(3)}°, ${lon.toFixed(3)}°` : 'Coordinates unavailable'}</div>
                    ${l.pad?.wiki ? `<a href="${escHtml(l.pad.wiki)}" target="_blank" rel="noopener" class="lp-link">Pad info ↗</a>` : ''}
                </div>
            </div>

            ${l.mission ? `<div class="lp-mission"><div class="lp-label">Mission</div><p>${escHtml(l.mission)}</p></div>` : ''}

            <div class="lp-label">Current Weather</div>
            ${weatherBlock}

            ${forecastBlock}

            ${ruleBlock}

            <div class="lp-footnote">
                Weather source: Open-Meteo (hourly forecast, time-aligned to NET).
                Launch data: Launch Library 2 (TheSpaceDevs).
                Go/No-Go uses a generic orbital-launch ruleset based on publicly-documented
                commit criteria; vehicle-specific rules ship next. Advisory only — not an
                official flight-readiness determination.
            </div>
        </div>
    `;
}

// ── App state ───────────────────────────────────────────────────────────────

const state = {
    launches:       [],
    filtered:       [],
    providers:      new Set(),
    activeProviders: new Set(),     // empty = all
    verdictFilter:  'all',          // 'all' | 'green' | 'yellow' | 'red'
    windowDays:     90,
    selectedId:     null,
    weatherCache:   new Map(),      // launchId → forecast
    scoreCache:     new Map(),      // launchId → score
};

function applyFilters() {
    state.filtered = state.launches.filter(l => {
        if (state.activeProviders.size > 0 && !state.activeProviders.has(l.provider)) return false;
        if (state.verdictFilter !== 'all' && l._score?.verdict !== state.verdictFilter) return false;
        return true;
    });
}

function renderRoster() {
    const host = $('lp-roster');
    if (!host) return;
    if (state.filtered.length === 0) {
        host.innerHTML = `<div class="lp-empty">No launches match these filters.</div>`;
        return;
    }
    host.innerHTML = state.filtered.map(renderCard).join('');
    host.querySelectorAll('.lp-card').forEach(btn => {
        btn.addEventListener('click', () => selectLaunch(btn.dataset.launchId));
    });
    if (state.selectedId) {
        host.querySelector(`[data-launch-id="${CSS.escape(state.selectedId)}"]`)?.classList.add('lp-card--active');
    }
}

function renderDetailPane() {
    const host = $('lp-detail');
    if (!host) return;
    const l  = state.launches.find(x => x.id == state.selectedId);
    const fc = l ? state.weatherCache.get(l.id) : null;
    const sc = l ? state.scoreCache.get(l.id)   : null;
    host.innerHTML = renderDetail(l, fc, sc);
}

function renderProviderFilters() {
    const host = $('lp-providers');
    if (!host) return;
    const sorted = [...state.providers].sort();
    host.innerHTML = sorted.map(p => {
        const active = state.activeProviders.has(p);
        return `<button type="button" class="lp-chip${active ? ' lp-chip--on' : ''}" data-provider="${escHtml(p)}">${escHtml(p)}</button>`;
    }).join('');
    host.querySelectorAll('.lp-chip').forEach(ch => {
        ch.addEventListener('click', () => {
            const p = ch.dataset.provider;
            if (state.activeProviders.has(p)) state.activeProviders.delete(p);
            else state.activeProviders.add(p);
            applyFilters();
            renderProviderFilters();
            renderRoster();
        });
    });
}

function renderStatus(text, isError = false) {
    const el = $('lp-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#ff6b6b' : '#8ab';
}

function renderCountdowns() {
    const now = Date.now();
    document.querySelectorAll('[data-net]').forEach(el => {
        const iso = el.getAttribute('data-net');
        if (iso) el.textContent = formatCountdown(iso, now);
    });
}

// ── Selection + weather join ────────────────────────────────────────────────

async function ensureWeather(l) {
    if (state.weatherCache.has(l.id)) return state.weatherCache.get(l.id);
    if (!Number.isFinite(l.pad?.lat) || !Number.isFinite(l.pad?.lon)) {
        state.weatherCache.set(l.id, null);
        state.scoreCache.set(l.id, scoreLaunch(null, l.net_iso));
        l._score = state.scoreCache.get(l.id);
        return null;
    }
    const fc = await fetchLaunchForecast(l.pad.lat, l.pad.lon);
    state.weatherCache.set(l.id, fc);
    // Vehicle-specific wind ruleset. resolveRuleset() returns both the merged
    // thresholds and UI-facing metadata (confidence, sources); we stash the
    // metadata on the launch so renderDetail can cite it without re-matching.
    const rr = resolveRuleset(l);
    l._vehicle = rr;
    const score = scoreLaunch(fc, l.net_iso, { ruleset: rr.ruleset });
    state.scoreCache.set(l.id, score);
    l._score = score;
    return fc;
}

async function selectLaunch(id) {
    state.selectedId = id;
    renderRoster();
    renderDetailPane();
    const l = state.launches.find(x => x.id == id);
    if (!l) return;
    await ensureWeather(l);
    applyFilters();
    renderRoster();
    renderDetailPane();
    updateUrl();
}

function updateUrl() {
    const url = new URL(window.location.href);
    if (state.selectedId) url.searchParams.set('launch', state.selectedId);
    else                  url.searchParams.delete('launch');
    if (state.verdictFilter !== 'all') url.searchParams.set('verdict', state.verdictFilter);
    else                                url.searchParams.delete('verdict');
    window.history.replaceState(null, '', url.toString());
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function init() {
    renderStatus('Loading upcoming launches…');

    const data = await fetchLaunches(state.windowDays, 50);
    if (data.error) {
        renderStatus(`Upstream error: ${data.error}`, true);
        return;
    }
    state.launches = data.launches || [];
    state.providers = new Set(state.launches.map(l => l.provider).filter(Boolean));

    renderStatus(`${state.launches.length} launches · updated ${new Date(data.fetched_at).toLocaleTimeString()}`);

    // Kick off weather prefetch for the first 8 launches so initial sort reflects verdicts.
    const soon = state.launches.slice(0, 8);
    await Promise.all(soon.map(l => ensureWeather(l).catch(() => null)));

    applyFilters();
    renderProviderFilters();
    renderRoster();

    // Honor ?launch=<id> deep link
    const urlParams = new URLSearchParams(window.location.search);
    const preselect = urlParams.get('launch');
    const verdictParam = urlParams.get('verdict');
    if (verdictParam && ['green', 'yellow', 'red'].includes(verdictParam)) {
        state.verdictFilter = verdictParam;
        document.querySelectorAll('[data-verdict-filter]').forEach(b => b.classList.remove('lp-chip--on'));
        document.querySelector(`[data-verdict-filter="${verdictParam}"]`)?.classList.add('lp-chip--on');
        applyFilters();
    }
    if (preselect && state.launches.some(l => String(l.id) === String(preselect))) {
        await selectLaunch(preselect);
    } else if (state.launches[0]) {
        await selectLaunch(state.launches[0].id);
    } else {
        renderDetailPane();
    }

    // Countdown tick (single interval; pause when tab hidden to save CPU)
    let tick = setInterval(renderCountdowns, 1000);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            clearInterval(tick);
            tick = null;
        } else if (!tick) {
            renderCountdowns();
            tick = setInterval(renderCountdowns, 1000);
        }
    });

    // Lazy-load weather for the rest so all cards show verdicts eventually
    const remaining = state.launches.slice(8);
    for (const l of remaining) {
        ensureWeather(l).then(() => {
            applyFilters();
            renderRoster();
        }).catch(() => null);
        await new Promise(r => setTimeout(r, 150));  // throttle Open-Meteo
    }
}

function wireControls() {
    document.querySelectorAll('[data-window-days]').forEach(btn => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('[data-window-days]').forEach(b => b.classList.remove('lp-chip--on'));
            btn.classList.add('lp-chip--on');
            state.windowDays = parseInt(btn.dataset.windowDays, 10) || 90;
            const data = await fetchLaunches(state.windowDays, 50);
            state.launches = data.launches || [];
            state.providers = new Set(state.launches.map(l => l.provider).filter(Boolean));
            state.weatherCache.clear();
            state.scoreCache.clear();
            state.selectedId = null;
            applyFilters();
            renderProviderFilters();
            renderRoster();
            renderDetailPane();
            if (state.launches[0]) selectLaunch(state.launches[0].id);
        });
    });

    document.querySelectorAll('[data-verdict-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-verdict-filter]').forEach(b => b.classList.remove('lp-chip--on'));
            btn.classList.add('lp-chip--on');
            state.verdictFilter = btn.dataset.verdictFilter;
            applyFilters();
            renderRoster();
            updateUrl();
        });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { wireControls(); init(); });
} else {
    wireControls();
    init();
}
