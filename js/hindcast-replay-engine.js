/**
 * hindcast-replay-engine.js — generic hindcast replay player
 * ═══════════════════════════════════════════════════════════════════════
 * Event-agnostic successor to gannon-superstorm-engine.js. Loads a
 * `pp.hindcast.replay.v1` bundle (baked by scripts/build-*-replay.mjs)
 * and exposes a player over its aligned series arrays:
 *
 *   const replay = await loadReplay({ url: '/data/hindcast/<event>_replay.json' });
 *   const player = createPlayer(replay);
 *   player.seekHours(25.5);
 *   const s = player.sample();
 *   //   { t, hours, idx, phase, series: { phi_pc_kv: 148.3, sym_h_nt: -180, ... } }
 *
 * Differences from the Gannon engine (deliberate):
 *   - No event constants in the module. Phases, moments, labels, and
 *     series keys all come from the bundle, so Feb 2022 / Sep 2017 pages
 *     reuse this file untouched.
 *   - Series values may be null (source gaps); consumers render gaps,
 *     they don't interpolate — the bundle is the honesty boundary.
 *   - No density/NRLMSIS coupling here. Density-track events keep using
 *     the Gannon engine; magnetospheric events don't pay for the import.
 *
 * Schema versioning matches the Gannon convention: v1 only, and any v2
 * must be additive (extra keys, never reshapes).
 */

const SUPPORTED_SCHEMA = 1;

/** Fetch a replay bundle. Throws on schema mismatch — fail loud. */
export async function loadReplay({ url } = {}) {
    if (!url) throw new Error('hindcast-replay: url is required');
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`hindcast-replay: fetch failed (${res.status})`);
    const bundle = await res.json();
    if (bundle.schema_version !== SUPPORTED_SCHEMA) {
        throw new Error(`hindcast-replay: schema_version=${bundle.schema_version}, expected ${SUPPORTED_SCHEMA}`);
    }
    return bundle;
}

/**
 * Player over a loaded bundle. Holds cursor state (hours from window
 * start) and samples every series at the cursor. Cheap to construct.
 */
export function createPlayer(replay) {
    const w = replay.window;
    const t0Ms = Date.parse(w.start);
    const stepMs = (w.step_minutes || 5) * 60_000;
    const keys = Object.keys(replay.series || {});
    const nSamples = keys.length ? replay.series[keys[0]].length : 0;
    const hoursMax = ((nSamples - 1) * stepMs) / 3600_000;

    let cursorH = 0;

    const clampH = (h) => Math.max(0, Math.min(hoursMax, h));
    const indexAt = (h) => Math.max(0, Math.min(nSamples - 1, Math.round((h * 3600_000) / stepMs)));

    function phaseAt(h) {
        for (const p of replay.phases || []) {
            if (h < p.until_h) return p;
        }
        const ps = replay.phases || [];
        return ps.length ? ps[ps.length - 1] : { id: 'storm', label: 'storm' };
    }

    function sample() {
        const idx = indexAt(cursorH);
        const series = {};
        for (const k of keys) series[k] = replay.series[k][idx];
        return {
            t: new Date(t0Ms + idx * stepMs).toISOString(),
            hours: cursorH,
            idx,
            phase: phaseAt(cursorH),
            series,
        };
    }

    return {
        get replay() { return replay; },
        get nSamples() { return nSamples; },
        get cursorHours() { return cursorH; },
        get hoursMax() { return hoursMax; },
        seekHours(h)    { cursorH = clampH(h); return sample(); },
        seekFraction(f) { cursorH = clampH(f * hoursMax); return sample(); },
        seekISO(iso)    { cursorH = clampH((Date.parse(iso) - t0Ms) / 3600_000); return sample(); },
        hoursOfISO(iso) { return (Date.parse(iso) - t0Ms) / 3600_000; },
        timestampAt(h)  { return new Date(t0Ms + clampH(h) * 3600_000).toISOString(); },
        sample,
        phaseAt,
    };
}

/** Min/max over a series ignoring nulls — for chart scaling + KPIs. */
export function seriesExtent(arr) {
    let min = Infinity, max = -Infinity;
    for (const v of arr) {
        if (v == null) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return (min === Infinity) ? { min: null, max: null } : { min, max };
}
