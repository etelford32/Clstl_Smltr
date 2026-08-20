/**
 * js/farside/farside-feed.js — far-side map ingestion (browser side).
 *
 * Produces normalized Carrington-longitude phase-shift maps for the detector.
 * The pipeline is honest about provenance:
 *
 *   1. Try the in-app edge proxy for a NUMERIC grid (`format=json`). When the
 *      server-side FITS→grid step is wired (Phase 1), this is real GONG data.
 *   2. Otherwise synthesize a deterministic map so the detection / tracking /
 *      ETA pipeline is fully exercisable and demoable today. Synthetic maps
 *      carry `synthetic:true` so the UI can label them plainly — we never pass
 *      a modelled map off as observed data.
 *
 * In both cases `imageUrl` points at the proxy's image endpoint so the page
 * can show the upstream picture (GONG/SolO/STEREO) as a backdrop when it
 * resolves, independent of whether numeric data was available.
 *
 * A real far-side magnetic region appears as a NEGATIVE phase-shift signature
 * and keeps a roughly FIXED Carrington longitude across successive maps — only
 * the sub-Earth point (L0) sweeps past it. The synthetic generator respects
 * that: planted regions are pinned in Carrington longitude, so their emergence
 * ETA genuinely shrinks as real time advances.
 *
 * TWO INSTANTS, NOT ONE. Every generator here takes both:
 *
 *   · `anchorMs` — the session's reference "now". It fixes WHERE the planted
 *     regions sit in Carrington longitude, and must stay constant for the
 *     life of a session.
 *   · `whenMs`   — the instant being observed. It fixes L0 (and the noise
 *     seed), i.e. WHERE THE OBSERVER IS.
 *
 * The split is what makes the page's time scrubber physical. Re-deriving the
 * region anchor from `whenMs` would drag the regions along with the observer:
 * their central-meridian distance would never change, their ETAs would never
 * count down, and nothing would ever cross the limb — a rotation simulation
 * in which nothing rotates. tests/farside-sim.mjs pins this.
 */

import { GRID, SOURCES, SERIES_LEN, VALIDATION_CASES } from './farside-config.js';
import { carringtonL0, wrap360 } from './carrington.js';

const TWELVE_H = 12 * 3600 * 1000;

/** Deterministic PRNG (mulberry32) so a 12 h slot always renders identically. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Standard-normal sample from a uniform PRNG (Box–Muller). */
function gauss(rng) {
    const u = Math.max(rng(), 1e-9), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** The 12 h slot index for a timestamp — the synthetic random seed. */
function slotOf(ms) { return Math.floor(ms / TWELVE_H); }

/**
 * Planted far-side regions, pinned in Carrington longitude. Two are seeded
 * from the validation cases (so the demo shows named targets); a third is a
 * generic strong region positioned on the far side relative to "now" so there
 * is always something mid-emergence to forecast.
 */
function plantedRegions(anchorMs) {
    // The live region is PINNED in Carrington longitude (real regions don't
    // move in the co-rotating frame). Anchor it to the SESSION anchor's 12 h
    // slot — never to the observed frame's time — so it stays put across the
    // series and across the whole scrub range, and only its emergence ETA
    // moves. See the "TWO INSTANTS" note in the module header.
    const anchorSlotMs = slotOf(anchorMs) * TWELVE_H;
    const { L0 } = carringtonL0(new Date(anchorSlotMs));
    const regions = VALIDATION_CASES.map((c, i) => ({
        lon: c.carringtonLon,
        lat: c.carringtonLat,
        amp: c.flareProductive ? 4.2 : 3.0,   // peak |z|
        radiusDeg: c.flareProductive ? 11 : 8,
        label: c.label,
        caseId: c.id,
    }));
    // A guaranteed mid-far-side region ~135° from the current sub-Earth point,
    // i.e. roughly 3 days out — keeps the ETA panel populated regardless of
    // where the validation cases currently sit.
    regions.push({
        lon: wrap360(L0 - 135),
        lat: -9,
        amp: 3.6,
        radiusDeg: 9,
        label: 'Far-side signature (live)',
        caseId: null,
    });
    return regions;
}

/**
 * Build one normalized map (z-score field, negative = signature) for `whenMs`.
 * Background ~ N(0,1); planted regions subtract a Gaussian well; a few random
 * transient specks model detector false-alarm fodder.
 */
function synthesizeMap(source, whenMs, anchorMs = whenMs) {
    const { nLon, nLat, latMin } = GRID;
    const data = new Float32Array(nLon * nLat);
    const seed = slotOf(whenMs) * 2654435761 + (source.charCodeAt(0) || 7);
    const rng = mulberry32(seed);

    // Background noise.
    for (let i = 0; i < data.length; i++) data[i] = gauss(rng) * 0.65;

    const eph = carringtonL0(new Date(whenMs));
    const regions = plantedRegions(anchorMs);

    // Slow growth: regions strengthen over their lifetime (deterministic per slot).
    const growth = 0.85 + 0.3 * rng();

    const addWell = (cx, cy, amp, rad) => {
        const r2 = rad * rad;
        for (let dy = -rad * 2; dy <= rad * 2; dy++) {
            const lat = cy + dy;
            if (lat < latMin || lat >= latMin + nLat) continue;
            const row = (lat - latMin) * nLon;
            for (let dx = -rad * 2; dx <= rad * 2; dx++) {
                const lon = ((Math.round(cx) + dx) % nLon + nLon) % nLon;
                const d2 = dx * dx + dy * dy;
                data[row + lon] -= amp * Math.exp(-d2 / (2 * r2));
            }
        }
    };

    for (const reg of regions) addWell(reg.lon, reg.lat, reg.amp * growth, reg.radiusDeg);

    // 0–3 transient specks (false-alarm fodder for an honest FAR).
    const nSpeck = Math.floor(rng() * 4);
    for (let k = 0; k < nSpeck; k++) {
        addWell(rng() * 360, (rng() * 100 - 50), 2.4 + rng(), 3 + rng() * 2);
    }

    return {
        source,
        synthetic: true,
        imageUrl: SOURCES[source]?.endpoint ?? null,
        timestamp: new Date(whenMs).toISOString(),
        jd: eph.jd,
        L0: eph.L0,
        B0: eph.B0,
        grid: { ...GRID },
        data,
        regions, // planted truth — handy for the demo/validation overlay
    };
}

/** Decode a base64 Float32 (LE) payload from the proxy into a Float32Array. */
function b64ToFloat32(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
}

/**
 * Attempt to pull a NUMERIC far-side grid from the edge proxy (which serves the
 * latest map the ingestion cron stored). Returns a FarSideMap on success, or
 * null if nothing is stored yet (501) — the caller then uses the synthetic
 * field. Never throws.
 */
async function tryFetchNumeric(source) {
    try {
        const res = await fetch(`${SOURCES[source].endpoint}&format=json`, {
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) return null;
        const j = await res.json();
        let data = null;
        if (typeof j?.grid_b64 === 'string') data = b64ToFloat32(j.grid_b64);
        else if (Array.isArray(j?.data)) data = Float32Array.from(j.data);
        if (!data) return null;
        const eph = carringtonL0(new Date(j.timestamp ?? Date.now()));
        return {
            source,
            synthetic: false,
            imageUrl: SOURCES[source].endpoint,
            timestamp: j.timestamp ?? new Date().toISOString(),
            jd: eph.jd,
            L0: j.L0 ?? eph.L0,
            B0: j.B0 ?? eph.B0,
            grid: j.grid ?? { ...GRID },
            data,
            regions: [],
        };
    } catch (_) {
        return null;
    }
}

/**
 * Stored detection history for tracking, oldest → newest. Returns the cron's
 * real per-map detections from /api/solar/farside?format=series, or null when
 * nothing is stored yet (the caller falls back to detecting synthetic maps).
 */
export async function getStoredFrames(source = 'gong', n = SERIES_LEN) {
    try {
        const res = await fetch(`${SOURCES[source].endpoint}&format=series&limit=${n}`, {
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) return null;
        const j = await res.json();
        if (!Array.isArray(j?.frames) || !j.frames.length) return null;
        return j.frames;
    } catch (_) {
        return null;
    }
}

/**
 * Latest far-side map for a source (default GONG). Prefers real numeric data,
 * falls back to a synthetic map for the observed 12 h slot.
 *
 * @param {string} source
 * @param {object} [opts]
 * @param {number} [opts.atMs]      instant to observe (default: now)
 * @param {number} [opts.anchorMs]  session anchor pinning planted regions
 * @param {boolean} [opts.allowRemote=true]  set false while scrubbing — the
 *   stored grid is a snapshot of real "now" and cannot answer for another
 *   instant, so a simulated epoch must be served synthetically or not at all.
 */
export async function getLatestMap(source = 'gong', opts = {}) {
    const { atMs = Date.now(), anchorMs = atMs, allowRemote = true } = opts;
    if (allowRemote) {
        const real = await tryFetchNumeric(source);
        if (real) return real;
    }
    return synthesizeMap(source, atMs, anchorMs);
}

/**
 * A synthetic map for one simulated instant, with no network round-trip.
 *
 * The scrubber calls this per 12 h slot as it sweeps, so it must stay
 * synchronous and side-effect free. It is always `synthetic:true` — the page
 * labels a scrubbed frame as modelled even when the live view above it is
 * showing a real stored grid, because a stored grid says nothing about a
 * time that has not happened yet.
 */
export function simulateMap(source = 'gong', atMs = Date.now(), anchorMs = atMs) {
    return synthesizeMap(source, atMs, anchorMs);
}

/**
 * A time-ordered series (oldest → newest) of `n` maps spaced one cadence apart,
 * ending at the latest. Drives tracking + strength-trend. Synthetic for now;
 * a real implementation would page the Supabase archive (Phase 1).
 */
export async function getMapSeries(source = 'gong', n = SERIES_LEN, opts = {}) {
    const { atMs = Date.now(), anchorMs = atMs } = opts;
    const latest = await getLatestMap(source, opts);
    if (!latest.synthetic) {
        // Real series paging is a Phase-1 follow-up; return the single live map.
        return [latest];
    }
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(synthesizeMap(source, atMs - i * TWELVE_H, anchorMs));
    return out;
}
