/**
 * pollution-model.js — PURE pollution-analysis kernel for the Pollution Lab
 * (pollution.html) and the EarthView pollution layers.
 *
 * No DOM, no fetch, no ambient time — every function is deterministic on its
 * inputs so tests/pollution-model.mjs can gate the math. The page owns feeds
 * and rendering; this module owns four things:
 *
 *   1. Field building  — inverse-distance interpolation of scattered CAMS /
 *      city PM2.5 samples onto an equirectangular lat/lon grid.
 *   2. Hotspot ML      — deterministic weighted k-means (farthest-point
 *      seeding, spherical centroids) that identifies pollution centers from
 *      live samples. This is honest, inspectable unsupervised learning —
 *      NOT a black box, in keeping with the site's physics-first framing.
 *   3. Transport       — semi-Lagrangian advection of the PM2.5 field by a
 *      real wind grid, plus explicit diffusion, first-order deposition
 *      (lifetime τ), and steady sources inferred from the observed field.
 *   4. Climate impact  — aerosol direct radiative-forcing estimate from the
 *      field via a PM2.5→AOD conversion, area-weighted global mean, and an
 *      equilibrium temperature response. These are DISCLOSED order-of-
 *      magnitude teaching estimates (constants below), not an ESM run —
 *      the page must keep saying so.
 *
 * Grid convention (shared by every function here):
 *   { w, h, data: Float32Array(w*h) }, cell centers at
 *   lat = 90 − (y+0.5)·180/h   (row 0 = north),
 *   lon = −180 + (x+0.5)·360/w (col 0 = west),
 *   periodic in longitude, clamped in latitude.
 */

// ── Physical constants & disclosed approximations ───────────────────────────

export const EARTH_RADIUS_KM = 6371;
const KM_PER_DEG = Math.PI * EARTH_RADIUS_KM / 180;   // ≈ 111.19 km / °

/**
 * Surface PM2.5 (µg/m³) per unit 550 nm AOD. Column studies used for
 * satellite PM2.5 retrieval (van Donkelaar et al. style η) place the global
 * ratio broadly in the 60–120 µg/m³ range depending on boundary-layer depth
 * and humidity; 85 is a mid-range single number. Used ONLY where the CAMS
 * feed did not already supply a measured AOD.
 */
export const PM25_PER_AOD = 85;

/**
 * Aerosol direct radiative efficiency at top-of-atmosphere, W/m² per unit
 * AOD, sign negative (scattering aerosol reflects sunlight). Literature
 * global means for the direct effect cluster around −20…−30 W/m² per AOD
 * over dark surfaces; absorbing aerosol (black carbon) can flip the sign
 * locally — this kernel does not resolve composition and says so.
 */
export const FORCING_PER_AOD_WM2 = -25;

/**
 * Equilibrium climate sensitivity parameter λ, K per (W/m²). 0.8 sits in
 * the canonical range implied by ECS ≈ 3 K per 3.7 W/m² of CO₂ doubling.
 */
export const CLIMATE_SENSITIVITY_K_PER_WM2 = 0.8;

/** Typical PM2.5 atmospheric residence time (deposition e-folding), days. */
export const DEFAULT_LIFETIME_DAYS = 5;

// ── Grid helpers ────────────────────────────────────────────────────────────

export function makeGrid(w, h, fill = 0) {
    const data = new Float32Array(w * h);
    if (fill) data.fill(fill);
    return { w, h, data };
}

export function cellLat(y, h) { return 90 - (y + 0.5) * 180 / h; }
export function cellLon(x, w) { return -180 + (x + 0.5) * 360 / w; }

/** Great-circle distance in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Bilinear sample of a grid at fractional (lat, lon), periodic in lon,
 * clamped in lat. Used by the semi-Lagrangian step and by page probes.
 */
export function sampleGrid(grid, lat, lon) {
    const { w, h, data } = grid;
    // Fractional cell coords of the sample point (cell centers at +0.5).
    let fy = (90 - lat) * h / 180 - 0.5;
    let fx = ((lon + 180) / 360) * w - 0.5;
    fy = Math.max(0, Math.min(h - 1, fy));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    const x0 = Math.floor(fx), tx = fx - x0;
    const xa = ((x0 % w) + w) % w, xb = (xa + 1) % w;
    const v00 = data[y0 * w + xa], v01 = data[y0 * w + xb];
    const v10 = data[y1 * w + xa], v11 = data[y1 * w + xb];
    return (v00 * (1 - tx) + v01 * tx) * (1 - ty) + (v10 * (1 - tx) + v11 * tx) * ty;
}

/** Area weight of a grid row (∝ cos lat); used by global means. */
export function rowAreaWeight(y, h) {
    return Math.cos(cellLat(y, h) * Math.PI / 180);
}

/** Area-weighted global mean of a grid. */
export function globalMean(grid) {
    const { w, h, data } = grid;
    let sum = 0, wsum = 0;
    for (let y = 0; y < h; y++) {
        const aw = rowAreaWeight(y, h);
        for (let x = 0; x < w; x++) {
            sum += data[y * w + x] * aw;
            wsum += aw;
        }
    }
    return wsum > 0 ? sum / wsum : 0;
}

// ── 1. Field building — inverse-distance interpolation ─────────────────────

/**
 * Interpolate scattered samples [{lat, lon, value}] onto a w×h grid.
 * Shepard IDW with a hard influence radius: cells with no sample within
 * `maxDistKm` fall back to `background` instead of borrowing a value from
 * another continent. Exact at (within a cell of) each sample location.
 *
 * SUPPORT — read this before rendering the result as if it were data.
 *
 * The returned grid carries `nearestKm`, a Float32Array of the great-circle
 * distance from each cell to the nearest CONTRIBUTING sample, and `sampleCount`.
 * This exists because the field is drawn continuously over the whole planet
 * from roughly 145 scattered points: a cell 900 km from the nearest sample
 * and a cell sitting on top of one look identical once painted, and cells
 * beyond `maxDistKm` are pure `background` — a constant, not a measurement.
 *
 * Consumers MUST NOT present a value without consulting its support. Use
 * `supportAt(grid, lat, lon)` for a point probe. Cells with no sample in
 * range report `Infinity`, which is the honest answer, not a large number.
 */
export function idwGrid(samples, w, h, opts = {}) {
    const pts = (samples ?? []).filter(s =>
        Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number.isFinite(s.value));
    const op = buildIdwOperator(pts, w, h, opts);
    return op.apply(pts.map(p => p.value), opts);
}

/**
 * Precompute the IDW weights for a FIXED set of sample POSITIONS, so a series
 * of fields measured at the same places can be built without re-deriving the
 * geometry each time.
 *
 * WHY THIS EXISTS. The Pollution Lab scrubs ~145 hourly frames of CAMS
 * history, all sampled at the same ~105 sites. Calling `idwGrid` per frame
 * recomputes 2,592 cells × 145 haversines = 376k trig-heavy distances per
 * frame — ~45 M for the window, seconds of blocked main thread. But every one
 * of those distances is a function of POSITION ONLY: the weights, the
 * denominator, and the edge fade are identical for every hour. Factor them
 * out once and each frame becomes a sparse matrix–vector product (~26k
 * multiply-adds), which is roughly two orders of magnitude cheaper.
 *
 * `idwGrid` is a one-shot call through this operator, so there is exactly ONE
 * interpolation implementation on the page and the scrubbed frames cannot
 * drift from the live one. The arithmetic is kept in the ORIGINAL order —
 * accumulate `num`, divide by `den`, then fade — so a frame built through the
 * operator is bit-identical to the same frame built by `idwGrid`, which
 * tests/pollution-model.mjs asserts exactly rather than approximately.
 *
 * Sample values are ignored here; pass them to `apply`.
 *
 * @param {{lat:number, lon:number}[]} sites
 * @returns {{ w, h, sampleCount, maxDistKm, nearestKm: Float32Array,
 *             apply(values: ArrayLike<number>, opts?: {background?: number}): object }}
 */
export function buildIdwOperator(sites, w, h, {
    power = 2,
    maxDistKm = 2500,
} = {}) {
    const n = w * h;
    const pts = (sites ?? []).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon));
    const nearestKm = new Float32Array(n).fill(Infinity);
    // CSR sparse rows: cell i draws on sites index[start[i] … start[i+1]).
    const start = new Int32Array(n + 1);
    // `bgFrac` is t² — the share of the cell that comes from `background`
    // rather than from the samples. Stored as t² (not as 1−t²) so `apply`
    // can evaluate the ORIGINAL expression `(num/den)·(1−t²) + bg·t²`
    // literally: reconstructing t² from a stored 1−t² loses the low bits for
    // tiny t, and bit-identity with idwGrid is the property under test.
    const bgFrac = new Float64Array(n);
    const denom = new Float64Array(n);

    const idx = [];
    const wgts = [];
    if (pts.length) {
        for (let y = 0; y < h; y++) {
            const lat = cellLat(y, h);
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                start[i] = idx.length;
                const lon = cellLon(x, w);
                let den = 0, nearest = Infinity;
                for (let p = 0; p < pts.length; p++) {
                    const d = haversineKm(lat, lon, pts[p].lat, pts[p].lon);
                    if (d < nearest) nearest = d;
                    if (d > maxDistKm) continue;
                    // +1 km softening keeps the weight finite on top of a sample.
                    const wgt = 1 / Math.pow(d + 1, power);
                    idx.push(p);
                    wgts.push(wgt);
                    den += wgt;
                }
                if (den > 0) {
                    // Fade toward background near the influence edge so the
                    // field doesn't step discontinuously at maxDistKm.
                    const t = Math.min(1, nearest / maxDistKm);
                    bgFrac[i] = t * t;
                    denom[i] = den;
                    nearestKm[i] = nearest;
                } else {
                    // No contributors: rewind the row so the cell is empty and
                    // `apply` short-circuits it to pure background.
                    idx.length = start[i];
                    wgts.length = start[i];
                }
            }
        }
    }
    start[n] = idx.length;

    const index = Int32Array.from(idx);
    const weight = Float64Array.from(wgts);

    return {
        w, h,
        sampleCount: pts.length,
        maxDistKm,
        nearestKm,
        /** Non-zero weight entries — the operator's real cost, worth logging. */
        nnz: index.length,
        /**
         * Build one field from one value vector, aligned index-for-index with
         * the `sites` this operator was built from. A non-finite value is
         * treated as absent for that cell (its weight is dropped and the
         * denominator shrinks) rather than poisoning the whole cell with NaN —
         * a history frame with a gap at one city must still render.
         */
        apply(values, { background = 0 } = {}) {
            const grid = makeGrid(w, h, background);
            // Support is position-only, so every frame from one operator SHARES
            // this array instead of copying 10 kB per hour. Read-only by
            // contract — supportAt() only ever reads it.
            grid.nearestKm = nearestKm;
            grid.sampleCount = pts.length;
            grid.maxDistKm = maxDistKm;
            const { data } = grid;
            for (let i = 0; i < n; i++) {
                const s = start[i], e = start[i + 1];
                if (e === s) continue;                    // background only
                let num = 0, den = denom[i];
                let dropped = 0;
                for (let k = s; k < e; k++) {
                    const v = values[index[k]];
                    if (!Number.isFinite(v)) { dropped += weight[k]; continue; }
                    num += weight[k] * v;
                }
                if (dropped) den -= dropped;
                if (!(den > 0)) continue;                 // every contributor absent
                const t2 = bgFrac[i];
                data[i] = (num / den) * (1 - t2) + background * t2;
            }
            return grid;
        },
    };
}

/**
 * Distance in km from (lat, lon) to the nearest sample that supports the
 * interpolated value there, or Infinity where the field is background only.
 *
 * Deliberately NEAREST-NEIGHBOUR, not bilinear: interpolating a support
 * distance would smooth the very gap it exists to expose, and would report
 * finite support for a cell that has none.
 */
export function supportAt(grid, lat, lon) {
    if (!grid?.nearestKm) return null;
    const { w, h, nearestKm } = grid;
    const y = Math.max(0, Math.min(h - 1, Math.round((90 - lat) * h / 180 - 0.5)));
    const xRaw = Math.round(((lon + 180) / 360) * w - 0.5);
    const x = ((xRaw % w) + w) % w;
    return nearestKm[y * w + x];
}

// ── 2. Hotspot identification — deterministic weighted k-means ─────────────

function toUnitVec(lat, lon) {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

function fromUnitVec(v) {
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    return {
        lat: Math.asin(Math.max(-1, Math.min(1, v[2] / n))) * 180 / Math.PI,
        lon: Math.atan2(v[1], v[0]) * 180 / Math.PI,
    };
}

/**
 * Weighted k-means over geographic points. Deterministic:
 *   - seeding is farthest-point (first center = highest-weight point, each
 *     next = the point farthest from its nearest chosen center),
 *   - centroids are weighted means of unit vectors (no lon-wrap artifacts),
 *   - iteration order is input order.
 *
 * points: [{lat, lon, weight, value?, ...passthrough}] — weight must be
 * positive (callers pass PM2.5 or AQI); zero/negative rows are dropped.
 *
 * Returns clusters sorted by total weight desc:
 *   [{ lat, lon, count, totalWeight, meanValue, radiusKm, members: [idx…] }]
 */
export function kmeansHotspots(points, { k = 5, maxIter = 32 } = {}) {
    const pts = points
        .map((p, i) => ({ ...p, _i: i }))
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon)
            && Number.isFinite(p.weight) && p.weight > 0);
    if (!pts.length) return [];
    const kk = Math.max(1, Math.min(k, pts.length));

    // Farthest-point seeding.
    let seed = pts[0];
    for (const p of pts) if (p.weight > seed.weight) seed = p;
    const centers = [{ lat: seed.lat, lon: seed.lon }];
    while (centers.length < kk) {
        let far = null, farD = -1;
        for (const p of pts) {
            let dMin = Infinity;
            for (const c of centers) {
                const d = haversineKm(p.lat, p.lon, c.lat, c.lon);
                if (d < dMin) dMin = d;
            }
            if (dMin > farD) { farD = dMin; far = p; }
        }
        centers.push({ lat: far.lat, lon: far.lon });
    }

    let assign = new Array(pts.length).fill(0);
    for (let iter = 0; iter < maxIter; iter++) {
        let moved = false;
        for (let i = 0; i < pts.length; i++) {
            let best = 0, bestD = Infinity;
            for (let c = 0; c < centers.length; c++) {
                const d = haversineKm(pts[i].lat, pts[i].lon, centers[c].lat, centers[c].lon);
                if (d < bestD) { bestD = d; best = c; }
            }
            if (assign[i] !== best) { assign[i] = best; moved = true; }
        }
        // Recompute weighted spherical centroids.
        for (let c = 0; c < centers.length; c++) {
            const acc = [0, 0, 0];
            let wsum = 0;
            for (let i = 0; i < pts.length; i++) {
                if (assign[i] !== c) continue;
                const v = toUnitVec(pts[i].lat, pts[i].lon);
                acc[0] += v[0] * pts[i].weight;
                acc[1] += v[1] * pts[i].weight;
                acc[2] += v[2] * pts[i].weight;
                wsum += pts[i].weight;
            }
            if (wsum > 0) centers[c] = fromUnitVec(acc);
        }
        if (!moved) break;
    }

    const clusters = centers.map((c, ci) => {
        const members = [];
        let totalWeight = 0, valueSum = 0, valueN = 0;
        for (let i = 0; i < pts.length; i++) {
            if (assign[i] !== ci) continue;
            members.push(pts[i]._i);
            totalWeight += pts[i].weight;
            if (Number.isFinite(pts[i].value)) { valueSum += pts[i].value; valueN++; }
        }
        let radiusKm = 0;
        if (totalWeight > 0) {
            let acc = 0;
            for (let i = 0; i < pts.length; i++) {
                if (assign[i] !== ci) continue;
                acc += pts[i].weight * haversineKm(pts[i].lat, pts[i].lon, c.lat, c.lon) ** 2;
            }
            radiusKm = Math.sqrt(acc / totalWeight);
        }
        return {
            lat: c.lat, lon: c.lon,
            count: members.length,
            totalWeight,
            meanValue: valueN ? valueSum / valueN : null,
            radiusKm,
            members,
        };
    }).filter(c => c.count > 0);

    return clusters.sort((a, b) => b.totalWeight - a.totalWeight);
}

/**
 * Pick a cluster count via the elbow of weighted within-cluster variance:
 * the smallest k (≥2) whose marginal variance reduction over k−1 drops
 * below `marginal` of the k=1 total. Deterministic; bounded by kMax.
 */
export function chooseHotspotCount(points, { kMax = 8, marginal = 0.06 } = {}) {
    const wcss = k => kmeansHotspots(points, { k })
        .reduce((s, c) => s + c.totalWeight * c.radiusKm ** 2, 0);
    const base = wcss(1);
    if (!(base > 0)) return 1;
    let prev = base;
    for (let k = 2; k <= kMax; k++) {
        const cur = wcss(k);
        if ((prev - cur) / base < marginal) return k - 1;
        prev = cur;
    }
    return kMax;
}

// ── 3. Transport — semi-Lagrangian advection + diffusion + sources ─────────

/**
 * Convert meteorological wind (speed, direction the wind blows FROM, ° cw
 * from north) to zonal/meridional components: u eastward, v northward, m/s.
 */
export function windToUV(speedMs, dirFromDeg) {
    const r = dirFromDeg * Math.PI / 180;
    return { u: -speedMs * Math.sin(r), v: -speedMs * Math.cos(r) };
}

/**
 * One transport step. Pure: returns a NEW field, inputs untouched.
 *
 * field  — {w, h, data} concentration (µg/m³)
 * wind   — {u, v} Float32Arrays on the same grid (m/s)
 * opts.dtS         — timestep, seconds
 * opts.lifetimeS   — deposition e-folding time; Infinity disables
 * opts.kappaM2S    — horizontal eddy diffusivity (m²/s); 0 disables
 * opts.sources     — Float32Array (µg/m³ per s) added after transport, or null
 *
 * Numerics: semi-Lagrangian back-trajectory with bilinear sampling —
 * unconditionally stable and monotone (no new extrema), at the cost of a
 * few % mass drift on strongly deformed flows; the node test bounds it.
 * Near-pole rows clamp the metric term (cos lat ≥ 0.05) instead of letting
 * departure longitudes blow up.
 */
export function stepTransport(field, wind, {
    dtS = 3600,
    lifetimeS = DEFAULT_LIFETIME_DAYS * 86400,
    kappaM2S = 0,
    sources = null,
} = {}) {
    const { w, h } = field;
    const out = makeGrid(w, h);
    const mPerDegLat = KM_PER_DEG * 1000;

    // Advection (semi-Lagrangian departure points).
    for (let y = 0; y < h; y++) {
        const lat = cellLat(y, h);
        const cosLat = Math.max(0.05, Math.cos(lat * Math.PI / 180));
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const u = wind.u[i] || 0, v = wind.v[i] || 0;
            const depLat = lat - (v * dtS) / mPerDegLat;
            const depLon = cellLon(x, w) - (u * dtS) / (mPerDegLat * cosLat);
            out.data[i] = sampleGrid(field, depLat, depLon);
        }
    }

    // Explicit diffusion (5-point Laplacian). Metric-aware in x.
    if (kappaM2S > 0) {
        const src = out.data.slice();
        for (let y = 0; y < h; y++) {
            const lat = cellLat(y, h);
            const cosLat = Math.max(0.05, Math.cos(lat * Math.PI / 180));
            const dyM = (180 / h) * mPerDegLat;
            const dxM = (360 / w) * mPerDegLat * cosLat;
            // Stability guard: clamp each axis's coefficient to the explicit
            // scheme's 0.25 limit so a large dt degrades smoothly (extra
            // smoothing saturates) instead of exploding.
            const cx = Math.min(0.25, kappaM2S * dtS / (dxM * dxM));
            const cy = Math.min(0.25, kappaM2S * dtS / (dyM * dyM));
            const yN = Math.max(0, y - 1), yS = Math.min(h - 1, y + 1);
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                const xW = y * w + (x + w - 1) % w;
                const xE = y * w + (x + 1) % w;
                out.data[i] = src[i]
                    + cx * (src[xW] + src[xE] - 2 * src[i])
                    + cy * (src[yN * w + x] + src[yS * w + x] - 2 * src[i]);
            }
        }
    }

    // Deposition + sources.
    const decay = Number.isFinite(lifetimeS) && lifetimeS > 0
        ? Math.exp(-dtS / lifetimeS) : 1;
    for (let i = 0; i < out.data.length; i++) {
        let c = out.data[i] * decay;
        if (sources) c += sources[i] * dtS;
        out.data[i] = Math.max(0, c);
    }
    return out;
}

/**
 * Steady-state emission inversion: if the observed field C is in balance
 * with deposition (lifetime τ), the implied source is S = C/τ. This is the
 * DISCLOSED closure that makes "emissions on" reproduce today's field at
 * steady state, and makes "emissions off" a clean what-if decay experiment.
 */
export function inferSteadySources(field, lifetimeS) {
    const s = new Float32Array(field.data.length);
    if (Number.isFinite(lifetimeS) && lifetimeS > 0) {
        for (let i = 0; i < s.length; i++) s[i] = field.data[i] / lifetimeS;
    }
    return s;
}

// ── 4. Climate impact — disclosed teaching estimates ───────────────────────

/** PM2.5 (µg/m³) → estimated 550 nm AOD via the disclosed column ratio. */
export function aodFromPm25(pm25) {
    return Number.isFinite(pm25) && pm25 > 0 ? pm25 / PM25_PER_AOD : 0;
}

/** AOD → aerosol direct radiative forcing, W/m² (negative = cooling). */
export function directForcingWm2(aod) {
    return Number.isFinite(aod) && aod > 0 ? FORCING_PER_AOD_WM2 * aod : 0;
}

/** Per-cell forcing grid from a PM2.5 grid. */
export function forcingGridFromPm25(field) {
    const out = makeGrid(field.w, field.h);
    for (let i = 0; i < field.data.length; i++) {
        out.data[i] = directForcingWm2(aodFromPm25(field.data[i]));
    }
    return out;
}

/** Equilibrium temperature response ΔT = λ·F (K). */
export function equilibriumDeltaT(forcingWm2, lambda = CLIMATE_SENSITIVITY_K_PER_WM2) {
    return Number.isFinite(forcingWm2) ? lambda * forcingWm2 : 0;
}

export default {
    makeGrid, cellLat, cellLon, haversineKm, sampleGrid, rowAreaWeight,
    globalMean, idwGrid, supportAt, kmeansHotspots, chooseHotspotCount, windToUV,
    stepTransport, inferSteadySources, aodFromPm25, directForcingWm2,
    forcingGridFromPm25, equilibriumDeltaT,
    PM25_PER_AOD, FORCING_PER_AOD_WM2, CLIMATE_SENSITIVITY_K_PER_WM2,
    DEFAULT_LIFETIME_DAYS,
};
