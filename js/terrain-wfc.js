/**
 * terrain-wfc.js — wave-function-collapse terrain synthesis kernel (Moon + Mars).
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURE kernel: no DOM, no three.js, no fetch, no ambient time or Math.random —
 * every stochastic choice comes from a caller-supplied seed, so the same
 * (body, site, seed) always synthesizes the same terrain. Node-gated by
 * tests/terrain-wfc.mjs (run it after ANY edit here).
 *
 * What this is (and is honestly NOT):
 *   The globes' elevation and color come from real rasters (MOLA for Mars,
 *   LRO/LOLA for the Moon), but those rasters bottom out around 10–15 km per
 *   sample. Below that scale the pages used to show bilinear mush or sine-wave
 *   "roughness". This kernel synthesizes a *geologic class map* at the data's
 *   own resolution using wave function collapse: each cell collapses to one of
 *   a small set of terrain classes (dunes, outflow channel, maria, ejecta, …)
 *   under (a) adjacency rules encoding real geologic relationships — outflow
 *   channels emerge from chaos terrain, lunar swirls live on maria basalt,
 *   circumpolar ergs ring the martian ice caps — and (b) per-cell priors
 *   MEASURED from the real rasters (elevation / slope / albedo at accurate
 *   IAU coordinates). The output is decoration and must be labelled as
 *   synthesized wherever it renders; the elevation readouts, landmark
 *   positions, and photometric base maps stay untouched and true.
 *
 * Solver: classic min-entropy WFC over a rectangular grid.
 *   - domains are bitmasks (≤ 31 tiles per tileset),
 *   - collapse picks by weight × prior through the seeded PRNG,
 *   - AC-3-style propagation over the 4-neighborhood,
 *   - contradiction ⇒ deterministic restart with a derived seed (bounded).
 *   Grids here are small (≤ ~64² cells), so the O(n) min-entropy scan per
 *   step is comfortably fast (<10 ms) — do not "optimize" it into a heap
 *   without keeping determinism byte-identical.
 *
 * Coordinate contract: planetocentric latitude, east-positive longitude,
 * normalized to −180..180 — the SAME convention as moon-landmarks-data.js and
 * mars-landmarks-data.js (IAU Gazetteer). regionGrid() lays cell centers out
 * along great circles from the site center, so a cell's (lat, lon) is where
 * the caller should sample its raster — that is the "accurate mapping" half
 * of the contract.
 */

// ── Seeded PRNG ──────────────────────────────────────────────────────────────

/** FNV-1a over the stringified parts → uint32. Stable across sessions. */
export function hashSeed(...parts) {
    let h = 0x811c9dc5;
    const s = parts.map(p => (typeof p === 'number' ? p.toFixed(6) : String(p))).join('|');
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** mulberry32 — small, fast, good-enough PRNG. Returns () => [0,1). */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Stable per-site seed: same body + coordinates ⇒ same synthesized terrain. */
export function regionSeed(body, latDeg, lonDeg, salt = 0) {
    // Quarter-degree quantization: a site nudged by float noise still maps to
    // the same terrain, while genuinely different sites get different seeds.
    return hashSeed(body, Math.round(latDeg * 4), Math.round(lonDeg * 4), salt);
}

// ── Tilesets ─────────────────────────────────────────────────────────────────
// Each tile: id, label (for legends/HUD), color (linear-ish RGB 0..1 — a TINT
// the renderer blends over the real base map, not a replacement albedo),
// reliefAmpM (micro-relief amplitude budget the renderer MAY spend — the Mars
// patch's decorative roughness cap is 350 m, so all values sit well under it),
// grain (relative noise frequency), weight (global base rate).
// adjacency lists are SYMMETRIC and every tile is self-compatible — terrain
// classes are regions, not Wang borders. validateTileset() enforces both.

const F = Object.freeze;

export const MARS_TILESET = F({
    body: 'mars',
    tiles: F([
        F({ id: 'plains',   label: 'Smooth plains',        color: F([0.78, 0.45, 0.30]), reliefAmpM: 40,  grain: 0.6, weight: 1.00 }),
        F({ id: 'cratered', label: 'Cratered highlands',   color: F([0.62, 0.34, 0.22]), reliefAmpM: 220, grain: 1.4, weight: 0.95 }),
        F({ id: 'dunes',    label: 'Dune field',           color: F([0.45, 0.26, 0.20]), reliefAmpM: 60,  grain: 2.2, weight: 0.55 }),
        F({ id: 'channel',  label: 'Outflow channel',      color: F([0.82, 0.55, 0.38]), reliefAmpM: 120, grain: 1.0, weight: 0.50 }),
        F({ id: 'chaos',    label: 'Chaos terrain',        color: F([0.50, 0.28, 0.19]), reliefAmpM: 300, grain: 1.8, weight: 0.40 }),
        F({ id: 'lava',     label: 'Volcanic flank',       color: F([0.58, 0.30, 0.20]), reliefAmpM: 90,  grain: 0.8, weight: 0.45 }),
        F({ id: 'ice',      label: 'Polar layered ice',    color: F([0.93, 0.88, 0.86]), reliefAmpM: 80,  grain: 0.7, weight: 0.30 }),
    ]),
    // Real relationships: channels emerge from chaos (Ares Vallis ← Iani Chaos);
    // dunes pool in plains, channel floors, and ring the polar cap (Olympia
    // Undae) but do not abut raw chaos; ice touches only plains and its erg.
    adjacency: F({
        plains:   F(['plains', 'cratered', 'dunes', 'channel', 'lava', 'ice']),
        cratered: F(['cratered', 'plains', 'channel', 'chaos', 'lava']),
        dunes:    F(['dunes', 'plains', 'channel', 'ice']),
        channel:  F(['channel', 'plains', 'cratered', 'chaos', 'dunes']),
        chaos:    F(['chaos', 'cratered', 'channel']),
        lava:     F(['lava', 'plains', 'cratered']),
        ice:      F(['ice', 'plains', 'dunes']),
    }),
});

export const MOON_TILESET = F({
    body: 'moon',
    tiles: F([
        F({ id: 'maria',     label: 'Mare basalt',         color: F([0.30, 0.31, 0.35]), reliefAmpM: 40,  grain: 0.6, weight: 1.00 }),
        F({ id: 'highlands', label: 'Feldspathic highlands', color: F([0.72, 0.70, 0.66]), reliefAmpM: 240, grain: 1.5, weight: 1.00 }),
        F({ id: 'rim',       label: 'Crater rim',          color: F([0.60, 0.58, 0.55]), reliefAmpM: 320, grain: 2.0, weight: 0.35 }),
        F({ id: 'ejecta',    label: 'Ejecta / rays',       color: F([0.86, 0.84, 0.80]), reliefAmpM: 90,  grain: 1.2, weight: 0.40 }),
        F({ id: 'rille',     label: 'Sinuous rille',       color: F([0.22, 0.23, 0.27]), reliefAmpM: 110, grain: 0.9, weight: 0.18 }),
        F({ id: 'wrinkle',   label: 'Wrinkle ridge',       color: F([0.38, 0.38, 0.41]), reliefAmpM: 130, grain: 0.8, weight: 0.22 }),
        F({ id: 'swirl',     label: 'Bright swirl',        color: F([0.92, 0.90, 0.84]), reliefAmpM: 0,   grain: 0.5, weight: 0.10 }),
    ]),
    // Rilles and wrinkle ridges are mare-interior structures; swirls are
    // albedo features ON maria (Reiner Gamma) — zero relief on purpose.
    // Ejecta and rims bridge maria ↔ highlands (every contact does, via impact).
    adjacency: F({
        maria:     F(['maria', 'rille', 'wrinkle', 'swirl', 'rim', 'ejecta', 'highlands']),
        highlands: F(['highlands', 'rim', 'ejecta', 'maria']),
        rim:       F(['rim', 'ejecta', 'maria', 'highlands']),
        ejecta:    F(['ejecta', 'rim', 'maria', 'highlands']),
        rille:     F(['rille', 'maria']),
        wrinkle:   F(['wrinkle', 'maria']),
        swirl:     F(['swirl', 'maria']),
    }),
});

/** Throws if a tileset breaks the solver's assumptions. */
export function validateTileset(ts) {
    const n = ts.tiles.length;
    if (n < 2 || n > 31) throw new Error(`tileset ${ts.body}: need 2..31 tiles, got ${n}`);
    const ids = ts.tiles.map(t => t.id);
    const index = new Map(ids.map((id, i) => [id, i]));
    if (index.size !== n) throw new Error(`tileset ${ts.body}: duplicate tile ids`);
    for (const id of ids) {
        const adj = ts.adjacency[id];
        if (!adj) throw new Error(`tileset ${ts.body}: ${id} has no adjacency list`);
        if (!adj.includes(id)) throw new Error(`tileset ${ts.body}: ${id} must be self-compatible`);
        for (const other of adj) {
            if (!index.has(other)) throw new Error(`tileset ${ts.body}: ${id} → unknown tile ${other}`);
            if (!ts.adjacency[other].includes(id)) {
                throw new Error(`tileset ${ts.body}: adjacency not symmetric (${id} → ${other})`);
            }
        }
        const tile = ts.tiles[index.get(id)];
        if (!(tile.weight > 0)) throw new Error(`tileset ${ts.body}: ${id} needs weight > 0`);
        if (!Array.isArray(tile.color) || tile.color.length !== 3) {
            throw new Error(`tileset ${ts.body}: ${id} needs [r,g,b] color`);
        }
    }
    return true;
}

/** Precompute adjacency bitmasks: allowed[i] = bitmask of tiles that may sit next to i. */
function adjacencyMasks(ts) {
    const index = new Map(ts.tiles.map((t, i) => [t.id, i]));
    return ts.tiles.map(t => {
        let mask = 0;
        for (const other of ts.adjacency[t.id]) mask |= 1 << index.get(other);
        return mask;
    });
}

// ── The solver ───────────────────────────────────────────────────────────────

/**
 * Collapse a width×height grid over the tileset.
 *
 * @param {object}   opts
 * @param {object}   opts.tileset   MARS_TILESET | MOON_TILESET | custom (validated)
 * @param {number}   opts.width     cells across (east)
 * @param {number}   opts.height    cells down (north→south row order)
 * @param {number}   opts.seed      uint32 — see regionSeed()
 * @param {Float32Array|number[]|null} [opts.priors]
 *        length width*height*tiles.length, row-major, tile-fastest: the weight
 *        MULTIPLIER for tile t at cell (x,y) is priors[(y*width+x)*T + t].
 *        0 excludes a tile from that cell outright. null ⇒ uniform.
 * @param {number}   [opts.maxRestarts=10]
 * @returns {{ grid: Uint8Array, width, height, tileset, restarts, seed }}
 *          grid[y*width+x] = tile index into tileset.tiles.
 */
export function collapse({ tileset, width, height, seed, priors = null, maxRestarts = 10 }) {
    validateTileset(tileset);
    const T = tileset.tiles.length;
    const cellCount = width * height;
    if (priors && priors.length !== cellCount * T) {
        throw new Error(`priors length ${priors.length} ≠ cells×tiles ${cellCount * T}`);
    }
    const allowed = adjacencyMasks(tileset);
    const baseWeights = tileset.tiles.map(t => t.weight);
    const fullMask = (1 << T) - 1;

    // Per-cell starting domain: tiles whose effective weight is > 0.
    const startDomain = new Uint32Array(cellCount);
    for (let c = 0; c < cellCount; c += 1) {
        let mask = 0;
        for (let t = 0; t < T; t += 1) {
            const w = baseWeights[t] * (priors ? priors[c * T + t] : 1);
            if (w > 0) mask |= 1 << t;
        }
        if (mask === 0) {
            throw new Error(`cell ${c}: priors exclude every tile — at least one must stay > 0`);
        }
        startDomain[c] = mask;
    }

    const effW = (c, t) => baseWeights[t] * (priors ? priors[c * T + t] : 1);

    for (let attempt = 0; attempt <= maxRestarts; attempt += 1) {
        const rand = mulberry32(attempt === 0 ? seed : hashSeed(seed, 'restart', attempt));
        const domain = startDomain.slice();
        const result = attemptCollapse({ domain, width, height, allowed, effW, rand, seed, attempt });
        if (result) {
            return { grid: result, width, height, tileset, restarts: attempt, seed };
        }
    }
    throw new Error(`WFC failed after ${maxRestarts} restarts — tileset over-constrained for these priors`);
}

function attemptCollapse({ domain, width, height, allowed, effW, rand, seed, attempt }) {
    const cellCount = width * height;
    const collapsed = new Uint8Array(cellCount);      // 1 = done
    const grid = new Uint8Array(cellCount);
    // Cached per-cell entropy. Recomputed ONLY when a cell's domain shrinks —
    // domains shrink at most (tiles−1) times per cell over the whole solve, so
    // the log-weight work is bounded, and the min-scan below is a plain float
    // sweep. This is what keeps a 48² solve in the tens of milliseconds; the
    // naive rescan recomputed entropy (with a PRNG call per cell!) every step
    // and cost ~500 ms, which is a visible stall on a patch rebuild.
    const entropy = new Float64Array(cellCount);
    const queue = [];
    let remaining = cellCount;

    // Deterministic per-cell tiebreak that consumes NO PRNG draws — the rand()
    // stream stays reserved for collapse choices so the pick sequence is
    // independent of scan order.
    const jitter = (c) =>
        ((Math.imul((c + 1) ^ seed ^ Math.imul(attempt + 1, 0x85ebca6b), 0x9e3779b1) >>> 0) / 4294967296) * 1e-6;

    const bitCount = (m) => {
        let c = 0;
        while (m) { m &= m - 1; c += 1; }
        return c;
    };

    /** domain[c] is a singleton: record the decision. */
    const settle = (c) => {
        collapsed[c] = 1;
        grid[c] = 31 - Math.clz32(domain[c]);
        entropy[c] = Infinity;
        remaining -= 1;
    };

    const refreshEntropy = (c) => {
        let sumW = 0;
        let sumWLog = 0;
        let m = domain[c];
        while (m) {
            const t = 31 - Math.clz32(m);
            const w = effW(c, t);
            if (w > 0) { sumW += w; sumWLog += w * Math.log(w); }
            m &= ~(1 << t);
        }
        entropy[c] = Math.log(sumW) - sumWLog / sumW + jitter(c);
    };

    // Propagate a domain change at `cell` to its 4-neighborhood until stable.
    const propagateFrom = (cell) => {
        queue.length = 0;
        queue.push(cell);
        while (queue.length) {
            const c = queue.pop();
            // Union of what c's remaining tiles allow beside them.
            let allowMask = 0;
            let m = domain[c];
            while (m) {
                const t = 31 - Math.clz32(m);
                allowMask |= allowed[t];
                m &= ~(1 << t);
            }
            const x = c % width;
            const y = (c - x) / width;
            const neighbors = [];
            if (x > 0) neighbors.push(c - 1);
            if (x < width - 1) neighbors.push(c + 1);
            if (y > 0) neighbors.push(c - width);
            if (y < height - 1) neighbors.push(c + width);
            for (const nb of neighbors) {
                const next = domain[nb] & allowMask;
                if (next === domain[nb]) continue;
                if (next === 0) return false;         // contradiction
                domain[nb] = next;
                if (!collapsed[nb]) {
                    if (bitCount(next) === 1) settle(nb);
                    else refreshEntropy(nb);
                }
                queue.push(nb);
            }
        }
        return true;
    };

    // Seed pass: prime the entropy cache; settle + propagate anything the
    // priors already narrowed.
    for (let c = 0; c < cellCount; c += 1) {
        if (bitCount(domain[c]) === 1) {
            if (!collapsed[c]) settle(c);
        } else {
            refreshEntropy(c);
        }
    }
    for (let c = 0; c < cellCount; c += 1) {
        if (collapsed[c] && !propagateFrom(c)) return null;
    }

    while (remaining > 0) {
        // Min-entropy cell — plain sweep over the cache (collapsed = Infinity).
        let best = -1;
        let bestEntropy = Infinity;
        for (let c = 0; c < cellCount; c += 1) {
            if (entropy[c] < bestEntropy) { bestEntropy = entropy[c]; best = c; }
        }
        if (best < 0) return null;

        // Collapse: weighted choice among the remaining domain.
        let total = 0;
        let m = domain[best];
        while (m) {
            const t = 31 - Math.clz32(m);
            total += effW(best, t);
            m &= ~(1 << t);
        }
        let pick = rand() * total;
        let chosen = -1;
        m = domain[best];
        while (m) {
            const t = 31 - Math.clz32(m);
            pick -= effW(best, t);
            if (pick <= 0) { chosen = t; break; }
            m &= ~(1 << t);
        }
        if (chosen < 0) chosen = 31 - Math.clz32(domain[best]); // float residue
        domain[best] = 1 << chosen;
        settle(best);
        if (!propagateFrom(best)) return null;
    }
    return grid;
}

// ── Priors from real measurements ────────────────────────────────────────────
// Both functions return a Float32Array in TILESET ORDER, non-negative, with at
// least one strictly positive entry. They are pure functions of physical
// numbers so the node gate can pin the geology without a browser.

const clamp01 = v => Math.min(1, Math.max(0, v));
const smooth = (a, b, v) => {
    const t = clamp01((v - a) / (b - a));
    return t * t * (3 - 2 * t);
};

/**
 * Mars: priors from REAL MOLA elevation, local slope, and latitude.
 * @param {object} m  { elevationM, slopeDeg, latDeg }
 */
export function marsClassPriors({ elevationM, slopeDeg, latDeg }) {
    const absLat = Math.abs(latDeg);
    const p = new Float32Array(MARS_TILESET.tiles.length);
    const polar = smooth(70, 80, absLat);
    const lowland = smooth(1000, -2500, elevationM);     // deepens toward northern plains / Hellas
    const highland = smooth(-500, 2000, elevationM);
    const flat = smooth(2.5, 0.8, slopeDeg);
    const steep = smooth(1.2, 3.5, slopeDeg);
    const summit = smooth(4000, 9000, elevationM);       // Tharsis / Elysium flanks
    // The polar layered deposits stand ABOVE their surroundings — the northern
    // cap tops out near −1800 m over −4500 m plains, the southern cap is high
    // ground outright — so "cap" needs latitude AND standing height. The ergs
    // (Olympia Undae) ring the cap on the LOW ground; (1 − capIce) keeps the
    // dunes off the dome itself while adjacency still lets them touch it.
    const capIce = polar * smooth(-3600, -2800, elevationM);

    p[0] = 0.55 * flat * (0.4 + 0.6 * lowland) + 0.10;               // plains
    p[1] = 0.75 * highland * (0.3 + 0.7 * steep) * (1 - polar) + 0.06; // cratered
    p[2] = 0.70 * flat * lowland * (1 - summit) * (1 - capIce);      // dunes
    p[3] = 0.60 * steep * lowland * (1 - polar) + 0.03;              // channel
    p[4] = 0.55 * steep * (1 - polar) * (1 - summit) * smooth(-4500, -500, elevationM); // chaos
    p[5] = 0.85 * summit + 0.02;                                     // lava
    p[6] = 2.20 * capIce;                                            // ice
    return p;
}

/**
 * Moon: priors from MEASURED albedo (0..1, normalized base-map gray at the
 * cell's IAU coordinates) plus optional crater-proximity and swirl context.
 * @param {object} m  { albedo, latDeg, craterDistNorm?, swirlBoost? }
 *        craterDistNorm — distance from nearest major crater CENTER in units
 *        of that crater's radius (1 = on the rim). Infinity when unknown.
 *        swirlBoost — 0..1, set near known swirls (Reiner Gamma) only.
 */
export function moonClassPriors({ albedo, latDeg, craterDistNorm = Infinity, swirlBoost = 0 }) {
    const p = new Float32Array(MOON_TILESET.tiles.length);
    const dark = smooth(0.52, 0.30, albedo);         // maria basalt is dark
    const bright = smooth(0.38, 0.60, albedo);
    const rimBand = Number.isFinite(craterDistNorm)
        ? Math.exp(-((craterDistNorm - 1) ** 2) / (2 * 0.18 ** 2))
        : 0;
    const ejectaBand = Number.isFinite(craterDistNorm)
        ? smooth(0.9, 1.15, craterDistNorm) * smooth(2.6, 1.4, craterDistNorm)
        : 0;

    p[0] = 1.10 * dark + 0.02;                                    // maria
    p[1] = 1.10 * bright + 0.02;                                  // highlands
    p[2] = 0.90 * rimBand + 0.05 * bright;                        // rim
    p[3] = 0.85 * ejectaBand + 0.10 * bright;                     // ejecta / rays
    p[4] = 0.30 * dark;                                           // rille — mare interiors only
    p[5] = 0.35 * dark;                                           // wrinkle ridge
    p[6] = dark * (0.02 + 1.6 * clamp01(swirlBoost));             // swirl
    return p;
}

// ── Geo-referenced cell layout ───────────────────────────────────────────────

/**
 * Great-circle destination — planetocentric lat, east-positive lon (degrees).
 * Same math as the Mars page's destinationLatLon; kept here so the kernel and
 * its tests need no three.js.
 */
export function destinationLatLon(latDeg, lonDeg, eastKm, northKm, radiusKm) {
    const d = Math.hypot(eastKm, northKm);
    if (d < 1e-9) return { latDeg, lonDeg };
    const delta = d / radiusKm;
    const bearing = Math.atan2(eastKm, northKm);
    const lat = latDeg * Math.PI / 180;
    const lon = lonDeg * Math.PI / 180;
    const sinLat2 = Math.sin(lat) * Math.cos(delta)
        + Math.cos(lat) * Math.sin(delta) * Math.cos(bearing);
    const lat2 = Math.asin(Math.min(1, Math.max(-1, sinLat2)));
    const lon2 = lon + Math.atan2(
        Math.sin(bearing) * Math.sin(delta) * Math.cos(lat),
        Math.cos(delta) - Math.sin(lat) * sinLat2,
    );
    let lonOut = lon2 * 180 / Math.PI;
    lonOut = ((lonOut + 540) % 360) - 180;          // normalize to −180..180
    return { latDeg: lat2 * 180 / Math.PI, lonDeg: lonOut };
}

/**
 * Inverse of destinationLatLon: local (east, north) km offset of a point as
 * seen from the site center — great-circle distance + initial bearing, which
 * is EXACTLY how regionGrid laid its cells out, so graticule lines drawn with
 * this land on the same map the cells define. Round-trip pinned by the test.
 */
export function localOffsetKm(centerLatDeg, centerLonDeg, latDeg, lonDeg, radiusKm) {
    const lat1 = centerLatDeg * Math.PI / 180;
    const lat2 = latDeg * Math.PI / 180;
    let dLon = (lonDeg - centerLonDeg) * Math.PI / 180;
    if (dLon > Math.PI) dLon -= 2 * Math.PI;
    if (dLon < -Math.PI) dLon += 2 * Math.PI;
    const cosDelta = Math.sin(lat1) * Math.sin(lat2)
        + Math.cos(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const delta = Math.acos(Math.min(1, Math.max(-1, cosDelta)));
    if (delta < 1e-12) return { eastKm: 0, northKm: 0 };
    const bearing = Math.atan2(
        Math.sin(dLon) * Math.cos(lat2),
        Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon),
    );
    const d = delta * radiusKm;
    return { eastKm: d * Math.sin(bearing), northKm: d * Math.cos(bearing) };
}

/**
 * Lay out a cells×cells grid of cell CENTERS covering extentKm×extentKm around
 * the site, row 0 at the NORTH edge (matches the collapse grid's row order and
 * canvas y-down drawing). Returns accurate per-cell IAU coordinates to sample
 * rasters at.
 */
export function regionGrid({ centerLatDeg, centerLonDeg, extentKm, cells, radiusKm }) {
    const latDeg = new Float64Array(cells * cells);
    const lonDeg = new Float64Array(cells * cells);
    const spacingKm = extentKm / cells;
    for (let row = 0; row < cells; row += 1) {
        const northKm = (0.5 - (row + 0.5) / cells) * extentKm;
        for (let col = 0; col < cells; col += 1) {
            const eastKm = ((col + 0.5) / cells - 0.5) * extentKm;
            const p = destinationLatLon(centerLatDeg, centerLonDeg, eastKm, northKm, radiusKm);
            latDeg[row * cells + col] = p.latDeg;
            lonDeg[row * cells + col] = p.lonDeg;
        }
    }
    return { cells, latDeg, lonDeg, spacingKm, extentKm };
}

// ── Render-side sampling helpers ─────────────────────────────────────────────

const _w4 = new Float32Array(4);
const _c4 = new Int32Array(4);

/**
 * Allocation-free bilinear class sample at (u, v) ∈ [0,1]² over the collapsed
 * grid (u east, v north→south like the grid rows). Blends tile COLORS and
 * reliefAmpM across cell centers so the rendered map has soft geologic
 * contacts instead of pixel stairs; also reports the dominant tile. Writes
 * into `out` and returns it — the Mars patch calls this once per vertex
 * (66k per rebuild), so no per-call objects. `out` shape:
 * { color: [r,g,b], reliefAmpM, grain, tileIndex }.
 */
export function sampleClassInto(result, u, v, out) {
    const { grid, width, height, tileset } = result;
    const x = clamp01(u) * width - 0.5;
    const y = clamp01(v) * height - 0.5;
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = clamp01(x - x0);
    const ty = clamp01(y - y0);
    _w4[0] = (1 - tx) * (1 - ty); _w4[1] = tx * (1 - ty);
    _w4[2] = (1 - tx) * ty;       _w4[3] = tx * ty;
    _c4[0] = grid[y0 * width + x0]; _c4[1] = grid[y0 * width + x1];
    _c4[2] = grid[y1 * width + x0]; _c4[3] = grid[y1 * width + x1];
    out.color[0] = 0; out.color[1] = 0; out.color[2] = 0;
    out.reliefAmpM = 0;
    out.grain = 0;
    let domW = -1;
    let dominant = _c4[0];
    for (let i = 0; i < 4; i += 1) {
        const tile = tileset.tiles[_c4[i]];
        const w = _w4[i];
        out.color[0] += tile.color[0] * w;
        out.color[1] += tile.color[1] * w;
        out.color[2] += tile.color[2] * w;
        out.reliefAmpM += tile.reliefAmpM * w;
        out.grain += tile.grain * w;
        if (w > domW) { domW = w; dominant = _c4[i]; }
    }
    out.tileIndex = dominant;
    return out;
}

/** Convenience wrapper over sampleClassInto for callers off the hot path. */
export function sampleClass(result, u, v) {
    const out = sampleClassInto(result, u, v, {
        color: [0, 0, 0], reliefAmpM: 0, grain: 0, tileIndex: 0,
    });
    return { ...out, color: out.color.slice(), tile: result.tileset.tiles[out.tileIndex] };
}

/** Fraction of cells carrying each tile id — legends + tests read this. */
export function classShares(result) {
    const counts = new Array(result.tileset.tiles.length).fill(0);
    for (const t of result.grid) counts[t] += 1;
    const shares = {};
    result.tileset.tiles.forEach((tile, i) => {
        shares[tile.id] = counts[i] / result.grid.length;
    });
    return shares;
}
