/**
 * api/storms.js — Vercel edge function: active tropical cyclone list (global)
 *
 * Merges two upstream feeds into one normalised worldwide cyclone list:
 *
 *   1. NOAA NHC CurrentStorms.json — authoritative for the Atlantic and
 *      East/Central Pacific. Rich fields (pressure, official movement).
 *   2. NASA EONET v3 severeStorms (JTWC-sourced) — the only keyless public
 *      JSON feed that carries West Pacific typhoons, Indian Ocean and
 *      Southern Hemisphere cyclones. Position/intensity come as a track of
 *      timestamped points; movement is derived from the last two points.
 *
 * NHC wins on overlap (same storm name or position within ~3°).
 *
 * Response shape (extra fields are additive — client contract unchanged):
 *   {
 *     updated: ISO string,
 *     count,
 *     storms: [{
 *       id, name, basin, classification,
 *       lat, lon, intensityKt, pressureHpa,
 *       movementDir, movementKt, hemisphere,
 *       source: 'nhc'|'eonet', lastUpdate
 *     }],
 *     sources: { nhc: {ok, count, error?}, eonet: {ok, count, error?} }
 *   }
 *
 * CDN cache: 30 minutes (NHC advisories every 3–6 h; EONET updates ~2×/day).
 *
 * CRITICAL — NHC field names: CurrentStorms.json provides
 * `latitudeNumeric`/`longitudeNumeric` (numbers), `latitude`/`longitude`
 * (strings like "15.4N"), and camelCase `movementDir`/`movementSpeed`.
 * There are NO `lat`/`lon`/`movement_dir` fields. A previous version of
 * this parser read those non-existent names, so the filter dropped every
 * storm and the watch list was permanently empty. Verified against the
 * live feed 2026-07-15 (TS Elida, EP5).
 */

export const config = { runtime: 'edge' };

// Both feeds are keyless and CORS-open.
const NHC_URL   = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?category=severeStorms&status=open';

const USER_AGENT = 'ParkerPhysics/1.0 (+https://parkersphysics.com)';

// Classification codes used by NHC and JTWC
const CLASSIFICATIONS = new Set(['TD', 'TS', 'HU', 'TY', 'STY', 'TC', 'MH', 'SD', 'SS', 'EX']);

// NHC codes that need remapping into the client vocabulary
const NHC_CLASS_REMAP = { PTC: 'EX', PC: 'TD', STD: 'SD', STS: 'SS' };

// ── Shared helpers ───────────────────────────────────────────────────────────

/** "15.4N" / "113.5W" → signed float, or null. */
function parseCoord(str) {
    if (typeof str !== 'string') return null;
    const m = str.trim().match(/^(-?\d+(?:\.\d+)?)\s*([NSEW])?$/i);
    if (!m) return null;
    let v = parseFloat(m[1]);
    const h = (m[2] || '').toUpperCase();
    if (h === 'S' || h === 'W') v = -Math.abs(v);
    return Number.isFinite(v) ? v : null;
}

/** Great-circle distance in nautical miles. */
function distanceNm(lat1, lon1, lat2, lon2) {
    const R = 3440.065; // Earth radius, nm
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial great-circle bearing, degrees 0–360 (0 = N, 90 = E). */
function bearingDeg(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ── NHC (Atlantic / East+Central Pacific) ────────────────────────────────────

function parseNHCStorms(data) {
    const raw = data?.activeStorms ?? [];
    return raw
        .map(s => {
            const lat = Number.isFinite(s.latitudeNumeric)
                ? s.latitudeNumeric : parseCoord(s.latitude);
            const lon = Number.isFinite(s.longitudeNumeric)
                ? s.longitudeNumeric : parseCoord(s.longitude);
            if (lat == null || lon == null) return null;

            const rawClass = String(s.classification ?? '').toUpperCase();
            const classification = CLASSIFICATIONS.has(rawClass)
                ? rawClass
                : (NHC_CLASS_REMAP[rawClass] ?? 'TS');

            // Basin from the storm id prefix: al012026 / ep052026 / cp022026
            const prefix = String(s.id ?? '').slice(0, 2).toLowerCase();
            const basin = { al: 'ATLANTIC', ep: 'EPAC', cp: 'CPAC' }[prefix] ?? 'UNKNOWN';

            return {
                id:             s.id ?? 'unknown',
                name:           s.name ?? 'Unnamed',
                basin,
                classification,
                lat,
                lon,
                intensityKt:    parseInt(s.intensity, 10) || 35,
                pressureHpa:    s.pressure ? parseInt(s.pressure, 10) : null,
                movementDir:    Number.isFinite(s.movementDir) ? s.movementDir
                                  : parseInt(s.movementDir, 10) || 0,
                movementKt:     Number.isFinite(s.movementSpeed) ? s.movementSpeed
                                  : parseInt(s.movementSpeed, 10) || 0,
                hemisphere:     lat >= 0 ? 'N' : 'S',
                source:         'nhc',
                lastUpdate:     s.lastUpdate ?? null,
            };
        })
        .filter(Boolean);
}

// ── EONET (global, JTWC-sourced) ─────────────────────────────────────────────

// "Super Typhoon Bavi" → { classification: 'STY', name: 'Bavi' }
const EONET_TITLE_CLASSES = [
    [/^super\s+typhoon\s+/i,       'STY'],
    [/^typhoon\s+/i,               'TY'],
    [/^major\s+hurricane\s+/i,     'MH'],
    [/^hurricane\s+/i,             'HU'],
    [/^tropical\s+storm\s+/i,      'TS'],
    [/^tropical\s+depression\s+/i, 'TD'],
    [/^subtropical\s+storm\s+/i,   'SS'],
    [/^tropical\s+cyclone\s+/i,    'TC'],
    [/^cyclone\s+/i,               'TC'],
];

function classifyEONETTitle(title) {
    for (const [re, code] of EONET_TITLE_CLASSES) {
        if (re.test(title)) return { classification: code, name: title.replace(re, '').trim() };
    }
    return { classification: 'TS', name: title.trim() };
}

/** Basin from the JTWC product URL (wp0926.tcw → WPAC), else from position. */
function eonetBasin(sources, lat, lon) {
    for (const src of sources ?? []) {
        const m = String(src.url ?? '').match(/\/(al|ep|cp|wp|io|sh)\d+/i);
        if (m) {
            return { al: 'ATLANTIC', ep: 'EPAC', cp: 'CPAC',
                     wp: 'WPAC', io: 'IO', sh: 'SH' }[m[1].toLowerCase()];
        }
    }
    if (lat < 0) return 'SH';
    const e = ((lon % 360) + 360) % 360;             // 0–360 east
    if (e >= 100 && e < 200) return 'WPAC';
    if (e >= 30  && e < 100) return 'IO';
    if (e >= 200 && e < 240) return 'CPAC';
    if (e >= 240 && e < 290) return 'EPAC';
    return 'ATLANTIC';
}

// Ignore events whose newest track point is older than this — EONET
// occasionally keeps dissipated systems "open" for days.
const EONET_MAX_AGE_MS = 48 * 3600 * 1000;

function parseEONETStorms(data, nowMs) {
    const events = data?.events ?? [];
    const out = [];

    for (const ev of events) {
        const pts = (ev.geometry ?? [])
            .filter(g => g.type === 'Point' && Array.isArray(g.coordinates))
            .map(g => ({
                lon: g.coordinates[0],
                lat: g.coordinates[1],
                t:   Date.parse(g.date),
                kt:  Number.isFinite(g.magnitudeValue) ? g.magnitudeValue : null,
            }))
            .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t))
            .sort((a, b) => a.t - b.t);

        if (!pts.length) continue;
        const last = pts[pts.length - 1];
        if (nowMs - last.t > EONET_MAX_AGE_MS) continue;   // dissipated / stale

        // Movement from the last two distinct points (JTWC points are 6 h apart)
        let movementDir = 0, movementKt = 0;
        for (let i = pts.length - 2; i >= 0; i--) {
            const prev = pts[i];
            const dtH = (last.t - prev.t) / 3600e3;
            if (dtH <= 0) continue;
            const nm = distanceNm(prev.lat, prev.lon, last.lat, last.lon);
            if (nm < 1) continue;                          // stationary fix
            movementDir = Math.round(bearingDeg(prev.lat, prev.lon, last.lat, last.lon));
            movementKt  = Math.round(nm / dtH);
            break;
        }

        // Latest known intensity anywhere on the track (some points omit it)
        let intensityKt = last.kt;
        if (intensityKt == null) {
            for (let i = pts.length - 2; i >= 0 && intensityKt == null; i--) {
                intensityKt = pts[i].kt;
            }
        }

        const { classification, name } = classifyEONETTitle(String(ev.title ?? 'Unnamed'));

        out.push({
            id:             ev.id ?? 'eonet-unknown',
            name,
            basin:          eonetBasin(ev.sources, last.lat, last.lon),
            classification,
            lat:            last.lat,
            lon:            last.lon,
            intensityKt:    intensityKt ?? 35,
            pressureHpa:    null,                          // EONET carries no pressure
            movementDir,
            movementKt,
            hemisphere:     last.lat >= 0 ? 'N' : 'S',
            source:         'eonet',
            lastUpdate:     new Date(last.t).toISOString(),
        });
    }
    return out;
}

// ── Merge ────────────────────────────────────────────────────────────────────

/** NHC wins on overlap: same name (case-insensitive) or within ~3° great circle. */
function mergeStorms(nhc, eonet) {
    const names = new Set(nhc.map(s => s.name.toLowerCase()));
    const merged = [...nhc];
    for (const s of eonet) {
        if (names.has(s.name.toLowerCase())) continue;
        const dup = nhc.some(n =>
            Math.abs(n.lat - s.lat) < 3 &&
            Math.abs(((n.lon - s.lon + 540) % 360) - 180) < 3);
        if (dup) continue;
        merged.push(s);
    }
    return merged.sort((a, b) => b.intensityKt - a.intensityKt);
}

// ── Handler ──────────────────────────────────────────────────────────────────

async function fetchJson(url) {
    const r = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

export default async function handler(req) {
    const headers = {
        'content-type':  'application/json',
        'cache-control': 'public, max-age=1800, s-maxage=1800',   // 30 min
        'access-control-allow-origin': '*',
    };

    const nowMs = Date.now();
    const [nhcRes, eonetRes] = await Promise.allSettled([
        fetchJson(NHC_URL),
        fetchJson(EONET_URL),
    ]);

    const nhcStorms   = nhcRes.status   === 'fulfilled' ? parseNHCStorms(nhcRes.value) : [];
    const eonetStorms = eonetRes.status === 'fulfilled' ? parseEONETStorms(eonetRes.value, nowMs) : [];
    const storms      = mergeStorms(nhcStorms, eonetStorms);

    // Both upstreams down is still a 200 with an empty list — the UI
    // degrades gracefully and the client doesn't retry aggressively.
    return new Response(JSON.stringify({
        updated: new Date().toISOString(),
        count:   storms.length,
        storms,
        sources: {
            nhc: {
                ok:    nhcRes.status === 'fulfilled',
                count: nhcStorms.length,
                ...(nhcRes.status === 'rejected' ? { error: nhcRes.reason?.message } : {}),
            },
            eonet: {
                ok:    eonetRes.status === 'fulfilled',
                count: eonetStorms.length,
                ...(eonetRes.status === 'rejected' ? { error: eonetRes.reason?.message } : {}),
            },
        },
    }), { headers });
}
