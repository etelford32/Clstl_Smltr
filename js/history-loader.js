/**
 * history-loader.js
 *
 * Replaces seedSyntheticHistory() when the heliochronicles snapshot
 * pipeline has produced real artifacts at /data/history/.  Live data
 * continues to flow through swpc-update → _wxHistory.ingest() unchanged.
 *
 * Pipeline contract (produced by scripts/heliochronicles/build-snapshots.mjs):
 *   /data/history/index.json
 *     {
 *       populated: "full" | "catalog_only",
 *       artifacts: {
 *         tier1_recent: { path, count, latest_ms, ... },
 *         tier2_4yr:    { path, count, ... },
 *         catalog: [ { id, path, count, ... }, ... ]
 *       }
 *     }
 *   /data/history/tier1-recent.json   array of SolarWeatherHistory records
 *   /data/history/tier2-4yr.json      array of SolarWeatherHistory records
 *
 * Every record already has the 10-field packed shape:
 *   { t, v, bz, by, n, pdyn, kp, dst, epsilon, substorm }
 *
 * Staleness: if a user visits after the snapshot is a week old, tier1's
 * "latest" is a week behind real-time. We anchor tier0 interpolation to
 * tier1's actual latest timestamp — never to Date.now() — so the HUD
 * doesn't lie about when the data was measured. The live swpc feed
 * fills the gap within seconds of arrival.
 */

const DEFAULT_INDEX_URL = '/data/history/index.json';
const TIER0_SLOT_MS = 60_000;   // 1-min cadence
const TIER0_CAPACITY = 1440;    // = SolarWeatherHistory tier0 ring size

/**
 * Load heliochronicles snapshots into a SolarWeatherHistory instance.
 *
 * @param {object} history  SolarWeatherHistory instance (already opened)
 * @param {object} [opts]
 * @param {string} [opts.indexUrl]  Override the default /data/history/index.json
 * @returns {Promise<{
 *     ok: boolean,
 *     source: 'heliochronicles' | 'catalog_only' | 'unavailable',
 *     reason?: string,
 *     tier0?: number, tier1?: number, tier2?: number,
 *     latest_ms?: number,
 *     generated_at?: string,
 * }>}
 */
export async function loadRealHistory(history, opts = {}) {
    const indexUrl = opts.indexUrl ?? DEFAULT_INDEX_URL;

    let index;
    try {
        const res = await fetch(indexUrl, { cache: 'no-cache' });
        if (!res.ok) return { ok: false, source: 'unavailable', reason: `index HTTP ${res.status}` };
        index = await res.json();
    } catch (err) {
        return { ok: false, source: 'unavailable', reason: err.message };
    }

    if (index.populated !== 'full') {
        return { ok: false, source: 'catalog_only', reason: `populated=${index.populated}` };
    }

    const t1Meta = index.artifacts?.tier1_recent;
    const t2Meta = index.artifacts?.tier2_4yr;
    if (!t1Meta || !t2Meta) {
        return { ok: false, source: 'unavailable', reason: 'missing tier artifact metadata' };
    }

    const indexBase = new URL(indexUrl, window.location.href);
    const t1Url = new URL(t1Meta.path, indexBase).href;
    const t2Url = new URL(t2Meta.path, indexBase).href;

    let tier1Rows, tier2Rows;
    try {
        [tier1Rows, tier2Rows] = await Promise.all([
            fetch(t1Url, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(`tier1 HTTP ${r.status}`); return r.json(); }),
            fetch(t2Url, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(`tier2 HTTP ${r.status}`); return r.json(); }),
        ]);
    } catch (err) {
        return { ok: false, source: 'unavailable', reason: err.message };
    }

    if (!Array.isArray(tier1Rows) || !Array.isArray(tier2Rows)) {
        return { ok: false, source: 'unavailable', reason: 'tier payload not an array' };
    }

    // Push in chronological order so ring buffers end with latest-first-out
    tier1Rows.sort((a, b) => a.t - b.t);
    tier2Rows.sort((a, b) => a.t - b.t);

    for (const rec of tier1Rows) history._rings[1].push(rec);
    for (const rec of tier2Rows) history._rings[2].push(rec);

    // Derive tier0 (1-min ring, 24 h window) from the tail of tier1.
    // Anchor to tier1's actual latest timestamp — never Date.now() — so the
    // HUD doesn't falsely claim live measurements when the snapshot is stale.
    const tier0Count = seedTier0FromTier1(history, tier1Rows);

    // Mark flush timestamps so ingest() doesn't double-write the same hour.
    const latestT1 = tier1Rows.length > 0 ? tier1Rows[tier1Rows.length - 1].t : 0;
    const latestT2 = tier2Rows.length > 0 ? tier2Rows[tier2Rows.length - 1].t : 0;
    history._lastFlush[0] = latestT1;           // tier0 aligned to tier1's latest
    history._lastFlush[1] = latestT1;
    history._lastFlush[2] = latestT2;

    return {
        ok: true,
        source: 'heliochronicles',
        tier0: tier0Count,
        tier1: tier1Rows.length,
        tier2: tier2Rows.length,
        latest_ms: latestT1 || null,
        generated_at: index.generated_at ?? null,
    };
}

/**
 * Paint tier0 (1-min × 24 h = 1440 slots) by linearly interpolating between
 * the last up-to-24 hourly records in tier1. Timestamps are anchored to the
 * tier1 latest — so if the snapshot was built yesterday, the tier0 trace ends
 * yesterday, not today. The live feed backfills the gap.
 */
function seedTier0FromTier1(history, tier1Rows) {
    if (tier1Rows.length < 2) return 0;
    const tail = tier1Rows.slice(-25);          // need 25 points to cover 24 intervals
    if (tail.length < 2) return 0;

    const endMs   = tail[tail.length - 1].t;
    const startMs = endMs - TIER0_CAPACITY * TIER0_SLOT_MS;
    const seedable = tail.filter(r => r.t >= startMs - 3_600_000);   // include one lead-in
    if (seedable.length < 2) return 0;

    let painted = 0;
    let j = 0;   // index of the seedable segment currently containing t
    for (let t = startMs; t < endMs; t += TIER0_SLOT_MS) {
        while (j + 1 < seedable.length && seedable[j + 1].t <= t) j++;
        if (j + 1 >= seedable.length) break;
        const a = seedable[j], b = seedable[j + 1];
        if (t < a.t) continue;                   // before our data starts
        const span = b.t - a.t;
        const alpha = span > 0 ? (t - a.t) / span : 0;
        const rec = {
            t,
            v:        interp(a.v,        b.v,        alpha),
            bz:       interp(a.bz,       b.bz,       alpha),
            by:       interp(a.by,       b.by,       alpha),
            n:        interp(a.n,        b.n,        alpha),
            pdyn:     interp(a.pdyn,     b.pdyn,     alpha),
            kp:       interp(a.kp,       b.kp,       alpha),
            dst:      interp(a.dst,      b.dst,      alpha),
            epsilon:  interp(a.epsilon,  b.epsilon,  alpha),
            substorm: interp(a.substorm, b.substorm, alpha),
        };
        history._rings[0].push(rec);
        painted++;
    }
    return painted;
}

function interp(a, b, alpha) {
    if (a == null && b == null) return null;
    if (a == null) return b;
    if (b == null) return a;
    return a + (b - a) * alpha;
}

/**
 * Load the heliochronicles catalog JSON (cycles, storms, aurora, regions).
 * Used by future retrodiction + timeline UI (Phase 1 steps 4–5). Returns
 * an object keyed by catalog id, or null for any entry that failed to fetch.
 *
 * @param {object} [opts]
 * @param {string} [opts.indexUrl]
 * @returns {Promise<Record<string, object|null>>}
 */
export async function loadCatalog(opts = {}) {
    const indexUrl = opts.indexUrl ?? DEFAULT_INDEX_URL;
    const indexBase = new URL(indexUrl, window.location.href);

    const index = await fetch(indexUrl, { cache: 'no-cache' }).then(r => r.json());
    const entries = index.artifacts?.catalog ?? [];

    const out = {};
    await Promise.all(entries.map(async (e) => {
        try {
            const url = new URL(e.path, indexBase).href;
            const res = await fetch(url, { cache: 'no-cache' });
            out[e.id] = res.ok ? await res.json() : null;
        } catch {
            out[e.id] = null;
        }
    }));
    return out;
}
