/**
 * sun-watch-model.js — PURE analysis kernel for the Sun Watch dock (sun.html)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No DOM, no fetch, no three.js, no ambient time — every function takes its
 * inputs (including `nowMs`) explicitly so `tests/sun-watch-model.mjs` can
 * pin behaviour in node. The DOM/feed layer is js/sun-watch.js.
 *
 * WHAT LIVES HERE
 *   · buildTimeline()  — merge DONKI flares/CMEs/SEP/GST/notifications and
 *     the page's SWPC 48-h flare list into ONE chronological event ledger.
 *     Flares arriving from both DONKI and SWPC are deduped by class + hour.
 *   · enrichRegions()  — normalize /api/noaa/regions rows into fractions
 *     using the far-side package's detectProbabilityScale/readProbability
 *     (the ONE probability-scale implementation — do not re-derive; a
 *     per-row guess inverted the region ordering once already, see the
 *     header in js/farside/flare-climatology.js).
 *   · cmeSummary()     — count / Earth-directed split + fastest + next
 *     modeled arrival off the DONKI CME rows (Enlil fields when present).
 *   · cycleSummary()   — F10.7 state (current, 27-d & 81-d means, trend,
 *     qualitative cycle label) from the f107-history singleton's rows.
 *   · holeMarkers()    — HEK coronal-hole rows → plottable Stonyhurst
 *     markers (uses lon_helio_deg; Carrington lon is NOT plottable in the
 *     page's AR marker frame, which is Stonyhurst like parseLoc()).
 *
 * All list inputs tolerate null/undefined and malformed rows — a dead feed
 * must degrade to an empty section, never to a throw that kills the dock.
 */

import { detectProbabilityScale, readProbability } from './farside/flare-climatology.js';

// ── Shared class/severity helpers ───────────────────────────────────────────

/** GOES class letter → severity rank 0..4 (A..X). Unknown → 0. */
export function classSeverity(cls) {
    const letter = String(cls ?? '').trim().charAt(0).toUpperCase();
    return { A: 0, B: 1, C: 2, M: 3, X: 4 }[letter] ?? 0;
}

/** Event accent colors, keyed by timeline `kind` (flare uses class letter). */
export const EVENT_COLORS = {
    X: '#ff5544', M: '#ff9944', C: '#ffd864', B: '#9aa8bb', A: '#8a97a8',
    cme: '#c084fc', sep: '#ff66aa', gst: '#66dd99', note: '#8899aa',
};

/**
 * Parse a Stonyhurst location string like "N18W22" → { lat, lon } in deg
 * (lon: W positive, matching sun.html's parseLoc / marker frame). Null on
 * anything unparseable.
 */
export function parseStonyhurst(loc) {
    const m = /^([NS])(\d{1,2})([EW])(\d{1,3})$/.exec(String(loc ?? '').trim().toUpperCase());
    if (!m) return null;
    const lat = (m[1] === 'N' ? 1 : -1) * parseInt(m[2], 10);
    const lon = (m[3] === 'W' ? 1 : -1) * parseInt(m[4], 10);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
}

/** Human age string ("3m", "2h", "4d") relative to nowMs. Null-safe. */
export function fmtAge(tMs, nowMs) {
    if (!Number.isFinite(tMs) || !Number.isFinite(nowMs)) return '—';
    const s = Math.max(0, (nowMs - tMs) / 1000);
    if (s < 90) return Math.round(s) + 's';
    if (s < 5400) return Math.round(s / 60) + 'm';
    if (s < 129600) return (s / 3600).toFixed(s < 36000 ? 1 : 0) + 'h';
    return (s / 86400).toFixed(1) + 'd';
}

function _ms(t) {
    if (t == null) return NaN;
    const str = String(t).replace(' ', 'T');
    const v = Date.parse(str.endsWith('Z') || str.includes('+') ? str : str + 'Z');
    return Number.isFinite(v) ? v : NaN;
}

// ── Timeline ────────────────────────────────────────────────────────────────

/**
 * Merge every event source into one ledger, newest first.
 *
 * @param {object} src
 *   donkiFlares  /api/donki/flares  → data.flares[]
 *   swpcFlares   sun.html liveFlares [{time, cls, loc, reg}] (SWPC 48 h)
 *   cmes         /api/donki/cme     → data.cmes[]
 *   seps         /api/donki/sep     → data.events[]
 *   gsts         /api/donki/gst     → data.events[]
 *   notes        /api/donki/notifications → data.notifications[]
 *   nowMs        epoch ms "now"
 *   windowMs     cutoff (default 7 d)
 * @returns {Array} [{ t, kind, cls?, badge, color, title, detail, loc, lat,
 *                     lon, earth, id }]
 */
export function buildTimeline(src = {}) {
    const nowMs = Number(src.nowMs) || 0;
    const windowMs = Number(src.windowMs) || 7 * 86400e3;
    const cutoff = nowMs - windowMs;
    const events = [];

    // DONKI flares — richest flare records (begin/peak/end, linked CME).
    const seenFlares = new Set();  // dedupe key: CLASS@floor(hour)
    for (const f of (Array.isArray(src.donkiFlares) ? src.donkiFlares : [])) {
        const t = _ms(f?.peak_time ?? f?.begin_time);
        const cls = String(f?.flare_class ?? '').toUpperCase();
        if (!Number.isFinite(t) || t < cutoff || !cls) continue;
        seenFlares.add(cls + '@' + Math.floor(t / 3600e3));
        const c = parseStonyhurst(f?.location);
        events.push({
            t, kind: 'flare', cls,
            badge: cls,
            color: EVENT_COLORS[cls.charAt(0)] ?? EVENT_COLORS.C,
            title: cls + ' flare' + (f?.active_region ? ' · AR ' + f.active_region : ''),
            detail: (f?.location || '') + (f?.linked_cme ? ' · CME associated' : ''),
            loc: f?.location ?? null, lat: c?.lat ?? null, lon: c?.lon ?? null,
            earth: !!f?.linked_cme,
            id: f?.id ?? null,
        });
    }

    // SWPC edited-events flares (the page's 48-h list) — fill anything DONKI
    // hasn't published yet, dedup by class + hour bucket.
    for (const f of (Array.isArray(src.swpcFlares) ? src.swpcFlares : [])) {
        const t = _ms(f?.time);
        const cls = String(f?.cls ?? '').toUpperCase();
        if (!Number.isFinite(t) || t < cutoff || !/^[ABCMX]/.test(cls)) continue;
        const key = cls + '@' + Math.floor(t / 3600e3);
        if (seenFlares.has(key)) continue;
        seenFlares.add(key);
        const c = parseStonyhurst(f?.loc);
        events.push({
            t, kind: 'flare', cls,
            badge: cls,
            color: EVENT_COLORS[cls.charAt(0)] ?? EVENT_COLORS.C,
            title: cls + ' flare' + (f?.reg && f.reg !== '—' ? ' · AR ' + f.reg : ''),
            detail: (f?.loc && f.loc !== '—' ? f.loc : '') + ' · GOES event list',
            loc: f?.loc ?? null, lat: c?.lat ?? null, lon: c?.lon ?? null,
            earth: false,
            id: null,
        });
    }

    for (const c of (Array.isArray(src.cmes) ? src.cmes : [])) {
        const t = _ms(c?.time);
        if (!Number.isFinite(t) || t < cutoff) continue;
        const spd = Number(c?.speed_km_s);
        const arrive = _ms(c?.enlil?.shock_arrival);
        events.push({
            t, kind: 'cme',
            badge: 'CME',
            color: EVENT_COLORS.cme,
            title: (c?.earth_directed ? 'Earth-directed CME' : 'CME')
                + (Number.isFinite(spd) ? ' · ' + Math.round(spd) + ' km/s' : ''),
            detail: [
                Number.isFinite(Number(c?.half_angle_deg)) ? 'half-angle ' + Math.round(c.half_angle_deg) + '°' : '',
                Number.isFinite(arrive) ? 'modeled arrival ' + new Date(arrive).toISOString().slice(5, 16).replace('T', ' ') + 'Z' : '',
            ].filter(Boolean).join(' · '),
            loc: null, lat: Number(c?.latitude_deg) || null, lon: Number(c?.longitude_deg) || null,
            earth: !!c?.earth_directed,
            id: c?.cme_id ?? null,
        });
    }

    for (const s of (Array.isArray(src.seps) ? src.seps : [])) {
        const t = _ms(s?.event_time);
        if (!Number.isFinite(t) || t < cutoff) continue;
        events.push({
            t, kind: 'sep',
            badge: 'SEP',
            color: EVENT_COLORS.sep,
            title: 'Solar energetic particle event',
            detail: (Array.isArray(s?.instruments) ? s.instruments.slice(0, 2).join(', ') : '')
                + (s?.linked_flare ? ' · flare-linked' : ''),
            loc: null, lat: null, lon: null,
            earth: true,
            id: s?.id ?? null,
        });
    }

    for (const g of (Array.isArray(src.gsts) ? src.gsts : [])) {
        const t = _ms(g?.start_time);
        if (!Number.isFinite(t) || t < cutoff) continue;
        const kp = Number(g?.max_kp);
        events.push({
            t, kind: 'gst',
            badge: g?.g_scale ? 'G' + g.g_scale : 'GST',
            color: EVENT_COLORS.gst,
            title: 'Geomagnetic storm' + (Number.isFinite(kp) ? ' · Kp ' + kp : ''),
            detail: g?.linked_cme ? 'CME-driven' : '',
            loc: null, lat: null, lon: null,
            earth: true,
            id: g?.id ?? null,
        });
    }

    for (const n of (Array.isArray(src.notes) ? src.notes : [])) {
        const t = _ms(n?.issue_time);
        // Notifications duplicate the typed events above — keep only Report
        // types that add narrative value, capped so they can't flood the ledger.
        const type = String(n?.type ?? '').toUpperCase();
        if (!Number.isFinite(t) || t < cutoff || !type.includes('REPORT')) continue;
        events.push({
            t, kind: 'note',
            badge: 'RPT',
            color: EVENT_COLORS.note,
            title: 'DONKI space-weather report',
            detail: String(n?.body ?? '').slice(0, 120),
            loc: null, lat: null, lon: null,
            earth: false,
            id: n?.id ?? null,
        });
    }

    events.sort((a, b) => b.t - a.t);
    // Cap report-notes to the 3 newest AFTER the sort so they never crowd
    // out typed events.
    let notes = 0;
    return events.filter(e => e.kind !== 'note' || ++notes <= 3);
}

// ── Regions ─────────────────────────────────────────────────────────────────

/**
 * Normalize /api/noaa/regions rows → display rows with probabilities as
 * fractions. Scale is detected ONCE over the whole feed (see module header).
 *
 * @param {Array} apiRegions payload.data.regions
 * @returns {{ rows: Array, scale: string }}
 */
export function enrichRegions(apiRegions) {
    const list = Array.isArray(apiRegions) ? apiRegions : [];
    const scale = detectProbabilityScale(list, 'm');
    const rows = [];
    for (const r of list) {
        const num = String(r?.region ?? '').trim();
        if (!num) continue;
        const lat = Number(r?.latitude_deg);
        const lon = Number(r?.stonyhurst_lon_deg);
        rows.push({
            region: num,
            location: r?.location ?? null,
            lat: Number.isFinite(lat) ? lat : null,
            lon: Number.isFinite(lon) ? lon : null,
            mag_class: r?.mag_class ?? null,
            spot_class: r?.spot_class ?? null,
            area: Number(r?.area) || 0,
            num_spots: Number(r?.num_spots) || 0,
            pC: readProbability(r, 'c', scale),
            pM: readProbability(r, 'm', scale),
            pX: readProbability(r, 'x', scale),
        });
    }
    // Most flare-capable first: X prob, then M, then area.
    rows.sort((a, b) => (b.pX ?? 0) - (a.pX ?? 0) || (b.pM ?? 0) - (a.pM ?? 0) || b.area - a.area);
    return { rows, scale };
}

/** Map region number → enriched row, for popup lookups. */
export function regionProbIndex(rows) {
    const idx = new Map();
    for (const r of (rows || [])) idx.set(String(r.region), r);
    return idx;
}

// ── CMEs ────────────────────────────────────────────────────────────────────

/**
 * Summarize DONKI CME rows.
 * @returns {{ count, earthCount, fastest, nextArrival }} nextArrival = the
 * soonest modeled Enlil shock arrival still in the future (ms) or null.
 */
export function cmeSummary(cmes, nowMs = 0) {
    const list = Array.isArray(cmes) ? cmes : [];
    let earthCount = 0, fastest = null, nextArrival = null;
    for (const c of list) {
        if (c?.earth_directed) earthCount++;
        const spd = Number(c?.speed_km_s);
        if (Number.isFinite(spd) && (fastest === null || spd > fastest)) fastest = spd;
        const arr = _ms(c?.enlil?.shock_arrival);
        if (Number.isFinite(arr) && arr > nowMs && (nextArrival === null || arr < nextArrival)) {
            nextArrival = arr;
        }
    }
    return { count: list.length, earthCount, fastest, nextArrival };
}

// ── Solar cycle (F10.7) ─────────────────────────────────────────────────────

/**
 * F10.7 state from the f107-history rows [{date:'YYYY-MM-DD', flux_sfu,
 * kind:'observed'|'predicted'}].
 *
 * The qualitative label is an ACTIVITY-LEVEL band, not a dynamo-phase
 * claim — a single F10.7 snapshot cannot place you on the cycle; the trend
 * plus level is the honest read.
 */
export function cycleSummary(rows, nowMs) {
    const list = (Array.isArray(rows) ? rows : [])
        .map(r => ({ t: _ms(r?.date), v: Number(r?.flux_sfu), kind: r?.kind === 'predicted' ? 'predicted' : 'observed' }))
        .filter(r => Number.isFinite(r.t) && Number.isFinite(r.v))
        .sort((a, b) => a.t - b.t);
    if (!list.length) return null;

    const observed = list.filter(r => r.kind === 'observed' && r.t <= nowMs);
    const current = observed.length ? observed[observed.length - 1].v : list[list.length - 1].v;
    const mean = (days) => {
        const from = nowMs - days * 86400e3;
        const w = observed.filter(r => r.t >= from);
        return w.length ? w.reduce((s, r) => s + r.v, 0) / w.length : null;
    };
    const mean27 = mean(27);
    const mean81 = mean(81);

    // Trend: last-13d mean vs prior-13d mean, ±2 sfu deadband.
    const half = 13 * 86400e3;
    const recent = observed.filter(r => r.t >= nowMs - half);
    const prior = observed.filter(r => r.t >= nowMs - 2 * half && r.t < nowMs - half);
    const avg = (a) => a.length ? a.reduce((s, r) => s + r.v, 0) / a.length : null;
    const rA = avg(recent), pA = avg(prior);
    const trend = (rA == null || pA == null) ? 'flat'
        : rA - pA > 2 ? 'rising' : pA - rA > 2 ? 'falling' : 'flat';

    const level = mean81 ?? current;
    const label = level < 90 ? 'Low activity (near minimum)'
        : level < 120 ? 'Moderate activity'
        : level < 160 ? 'Elevated activity'
        : 'High activity (near maximum)';

    return { current, mean27, mean81, trend, label, series: list };
}

// ── Coronal holes ───────────────────────────────────────────────────────────

/**
 * HEK hole rows → Stonyhurst markers for the 3D sun. Uses lon_helio_deg
 * (Stonyhurst, the AR-marker frame) — NOT lon_carrington_deg. Rows without
 * a finite Stonyhurst longitude are dropped (they are far-side or the
 * upstream omitted it), never guessed.
 */
export function holeMarkers(holes) {
    const out = [];
    for (const h of (Array.isArray(holes) ? holes : [])) {
        const lat = Number(h?.lat_deg);
        const lon = Number(h?.lon_helio_deg);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 90) continue;   // visible disc only
        out.push({
            lat, lon,
            source: h?.frm_name ?? h?.obs ?? 'HEK',
            time: h?.time ?? null,
        });
        if (out.length >= 12) break;
    }
    return out;
}

/** Coarse feed-age classification for the dock's footer chips. */
export function freshnessLabel(ageMs) {
    if (!Number.isFinite(ageMs)) return 'down';
    if (ageMs < 20 * 60e3) return 'live';
    if (ageMs < 2 * 3600e3) return 'recent';
    return 'stale';
}
