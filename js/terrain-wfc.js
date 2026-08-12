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
 * CLASSES vs TILES — the two-level vocabulary:
 *   A *class* is what the viewer sees: one legend row, one color, one prior
 *   (maria, rille, channel, ice…). A *tile* is what the solver places. Blob
 *   classes have exactly one tile; LINEAR classes (lunar rilles and wrinkle
 *   ridges, martian outflow channels) expand into a 10-tile family of
 *   port-carrying variants — two straight segments (NS, EW), four bends, four
 *   end-caps — with DIRECTIONAL adjacency:
 *     • an OPEN port may sit only against a matching open port of the same
 *       family (bend-to-bend excluded, which is what forbids tight 2×2
 *       loops while still letting lines meander),
 *     • a CLOSED side may touch only the family's background classes.
 *   Propagation therefore FORCES a placed segment to continue until an
 *   end-cap terminates it: lines are emergent from constraints, not painted
 *   by priors. Minimum chain is 2 cells (cap+cap), so single-cell speckle of
 *   a linear class is structurally impossible. Priors apply per CLASS and
 *   scale every variant of it equally (expandClassPriors).
 *
 * Solver: classic min-entropy WFC over a rectangular grid.
 *   - domains are bitmasks (≤ 31 tiles per tileset),
 *   - collapse picks by weight × prior through the seeded PRNG,
 *   - AC-3-style propagation over the 4-neighborhood with PER-DIRECTION
 *     compatibility masks (N/E/S/W — this is what carries the port rules),
 *   - contradiction ⇒ deterministic restart with a derived seed (bounded).
 *   Grids here are small (≤ ~64² cells) and entropies are cached per cell,
 *   refreshed only when a domain shrinks — do not "simplify" the cache away;
 *   the naive rescan cost ~500 ms per 48² solve, a visible stall on a Mars
 *   patch rebuild.
 *
 * Coordinate contract: planetocentric latitude, east-positive longitude,
 * normalized to −180..180 — the SAME convention as moon-landmarks-data.js and
 * mars-landmarks-data.js (IAU Gazetteer). regionGrid() lays cell centers out
 * along great circles from the site center, so a cell's (lat, lon) is where
 * the caller should sample its raster — that is the "accurate mapping" half
 * of the contract. Grid row 0 is the NORTH edge; direction indices below
 * follow that (N = row above).
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

// ── Directions and ports ─────────────────────────────────────────────────────
// Direction indices: 0 = N (row above), 1 = E, 2 = S, 3 = W. Port bits match.

export const DIR_N = 0;
export const DIR_E = 1;
export const DIR_S = 2;
export const DIR_W = 3;
const OPP = [2, 3, 0, 1];
const PORT_BIT = [1, 2, 4, 8];

// The 10 variants of a linear family: ports = bitmask of OPEN sides.
// kind: 0 = segment, 1 = bend, 2 = end-cap (bend↔bend connections are barred).
const FAMILY_VARIANTS = [
    { suffix: 'ns', ports: PORT_BIT[DIR_N] | PORT_BIT[DIR_S], kind: 0 },
    { suffix: 'ew', ports: PORT_BIT[DIR_E] | PORT_BIT[DIR_W], kind: 0 },
    { suffix: 'ne', ports: PORT_BIT[DIR_N] | PORT_BIT[DIR_E], kind: 1 },
    { suffix: 'es', ports: PORT_BIT[DIR_E] | PORT_BIT[DIR_S], kind: 1 },
    { suffix: 'sw', ports: PORT_BIT[DIR_S] | PORT_BIT[DIR_W], kind: 1 },
    { suffix: 'wn', ports: PORT_BIT[DIR_W] | PORT_BIT[DIR_N], kind: 1 },
    { suffix: 'n', ports: PORT_BIT[DIR_N], kind: 2 },
    { suffix: 'e', ports: PORT_BIT[DIR_E], kind: 2 },
    { suffix: 's', ports: PORT_BIT[DIR_S], kind: 2 },
    { suffix: 'w', ports: PORT_BIT[DIR_W], kind: 2 },
];

// ── Tileset builder ──────────────────────────────────────────────────────────

const F = Object.freeze;

/**
 * Build a tileset from declarative geology:
 * @param {object} spec
 *   body        — 'moon' | 'mars' | …
 *   classes     — ordered [{ id, label, color:[r,g,b], reliefAmpM, grain }]:
 *                 THE order class-prior vectors use (marsClassPriors etc.)
 *   base        — { classId: { weight, adj: [classIds] } } blob classes;
 *                 adj lists must be symmetric and self-inclusive
 *   families    — { classId: { background: [baseClassIds],
 *                              segWeight, bendWeight, endWeight } }
 * Every class must appear in exactly one of base/families.
 */
export function buildTileset(spec) {
    const classes = spec.classes.map(c => F({ ...c, color: F([...c.color]) }));
    const classIds = classes.map(c => c.id);
    const classIndex = new Map(classIds.map((id, i) => [id, i]));
    if (classIndex.size !== classIds.length) {
        throw new Error(`tileset ${spec.body}: duplicate class ids`);
    }
    for (const id of classIds) {
        const inBase = Object.hasOwn(spec.base, id);
        const inFamily = Object.hasOwn(spec.families ?? {}, id);
        if (inBase === inFamily) {
            throw new Error(`tileset ${spec.body}: class ${id} must be in exactly one of base/families`);
        }
    }
    // Base adjacency: symmetric + self-compatible, over base classes only.
    for (const [id, def] of Object.entries(spec.base)) {
        if (!def.adj.includes(id)) throw new Error(`tileset ${spec.body}: ${id} must be self-compatible`);
        for (const other of def.adj) {
            if (!Object.hasOwn(spec.base, other)) {
                throw new Error(`tileset ${spec.body}: ${id} → ${other} is not a base class (families connect via ports + background, not adj lists)`);
            }
            if (!spec.base[other].adj.includes(id)) {
                throw new Error(`tileset ${spec.body}: adjacency not symmetric (${id} → ${other})`);
            }
        }
        if (!(def.weight > 0)) throw new Error(`tileset ${spec.body}: ${id} needs weight > 0`);
    }
    const tiles = [];
    for (const cls of classes) {
        if (Object.hasOwn(spec.base, cls.id)) {
            tiles.push({
                id: cls.id, classId: cls.id, weight: spec.base[cls.id].weight,
                ports: 0, kind: -1,
                color: cls.color, reliefAmpM: cls.reliefAmpM, grain: cls.grain,
            });
        } else {
            const fam = spec.families[cls.id];
            for (const bg of fam.background) {
                if (!Object.hasOwn(spec.base, bg)) {
                    throw new Error(`tileset ${spec.body}: family ${cls.id} background ${bg} is not a base class`);
                }
            }
            const weightOf = [fam.segWeight, fam.bendWeight, fam.endWeight];
            for (const v of FAMILY_VARIANTS) {
                if (!(weightOf[v.kind] > 0)) {
                    throw new Error(`tileset ${spec.body}: family ${cls.id} needs positive seg/bend/end weights`);
                }
                tiles.push({
                    id: `${cls.id}:${v.suffix}`, classId: cls.id, weight: weightOf[v.kind],
                    ports: v.ports, kind: v.kind,
                    color: cls.color, reliefAmpM: cls.reliefAmpM, grain: cls.grain,
                });
            }
        }
    }
    if (tiles.length < 2 || tiles.length > 31) {
        throw new Error(`tileset ${spec.body}: need 2..31 tiles, got ${tiles.length}`);
    }
    const classOfTile = new Uint8Array(tiles.length);
    tiles.forEach((t, i) => { classOfTile[i] = classIndex.get(t.classId); });
    const tileset = {
        body: spec.body,
        classes: F(classes),
        tiles: F(tiles.map(t => F(t))),
        baseAdjacency: F(Object.fromEntries(
            Object.entries(spec.base).map(([id, def]) => [id, F([...def.adj])]),
        )),
        families: F(Object.fromEntries(
            Object.entries(spec.families ?? {}).map(([id, fam]) => [id, F({ ...fam, background: F([...fam.background]) })]),
        )),
        classOfTile,
    };
    tileset.masks = compileAdjacency(tileset);
    return F(tileset);
}

/**
 * May tile `a` sit with tile `b` on its `dir` side? The declarative rules,
 * evaluated in one place (the test re-implements these independently as an
 * oracle — keep both in sync):
 *   base|base     — the symmetric class adjacency lists
 *   base|family   — family side CLOSED toward the base tile, and the base
 *                   class is in the family's background list
 *   family|family — same family, facing ports both OPEN, not bend↔bend;
 *                   different families (or open|closed, closed|closed) never
 *                   touch — that is what keeps lines one cell wide
 */
export function tilesCompatible(tileset, a, dir, b) {
    const ta = tileset.tiles[a];
    const tb = tileset.tiles[b];
    const aFam = ta.ports !== 0 || ta.kind >= 0;
    const bFam = tb.ports !== 0 || tb.kind >= 0;
    if (!aFam && !bFam) {
        return tileset.baseAdjacency[ta.classId].includes(tb.classId);
    }
    const aOpen = aFam ? (ta.ports & PORT_BIT[dir]) !== 0 : false;
    const bOpen = bFam ? (tb.ports & PORT_BIT[OPP[dir]]) !== 0 : false;
    if (aFam && bFam) {
        if (ta.classId !== tb.classId) return false;
        if (aOpen && bOpen) return !(ta.kind === 1 && tb.kind === 1);
        return false;
    }
    if (aFam) {
        return !aOpen && tileset.families[ta.classId].background.includes(tb.classId);
    }
    return !bOpen && tileset.families[tb.classId].background.includes(ta.classId);
}

/** Per-tile per-direction compatibility bitmasks: masks[t*4 + dir]. */
function compileAdjacency(tileset) {
    const T = tileset.tiles.length;
    const masks = new Uint32Array(T * 4);
    for (let a = 0; a < T; a += 1) {
        for (let dir = 0; dir < 4; dir += 1) {
            let mask = 0;
            for (let b = 0; b < T; b += 1) {
                if (tilesCompatible(tileset, a, dir, b)) mask |= 1 << b;
            }
            masks[a * 4 + dir] = mask;
        }
    }
    return masks;
}

/** Throws if a tileset breaks the solver's assumptions. */
export function validateTileset(ts) {
    const T = ts.tiles.length;
    if (T < 2 || T > 31) throw new Error(`tileset ${ts.body}: need 2..31 tiles, got ${T}`);
    const ids = new Set(ts.tiles.map(t => t.id));
    if (ids.size !== T) throw new Error(`tileset ${ts.body}: duplicate tile ids`);
    for (const t of ts.tiles) {
        if (!(t.weight > 0)) throw new Error(`tileset ${ts.body}: ${t.id} needs weight > 0`);
        if (!Array.isArray(t.color) || t.color.length !== 3) {
            throw new Error(`tileset ${ts.body}: ${t.id} needs [r,g,b] color`);
        }
    }
    // The compiled masks must be symmetric: b on a's dir side ⟺ a on b's
    // opposite side. Guards tilesCompatible against a one-sided rule edit.
    for (let a = 0; a < T; a += 1) {
        for (let dir = 0; dir < 4; dir += 1) {
            for (let b = 0; b < T; b += 1) {
                const ab = (ts.masks[a * 4 + dir] >>> b) & 1;
                const ba = (ts.masks[b * 4 + OPP[dir]] >>> a) & 1;
                if (ab !== ba) {
                    throw new Error(`tileset ${ts.body}: masks not symmetric (${ts.tiles[a].id} dir ${dir} ${ts.tiles[b].id})`);
                }
            }
        }
    }
    // Every tile must be able to stand in SOME 4-neighborhood.
    for (let a = 0; a < T; a += 1) {
        for (let dir = 0; dir < 4; dir += 1) {
            if (ts.masks[a * 4 + dir] === 0) {
                throw new Error(`tileset ${ts.body}: ${ts.tiles[a].id} has no legal neighbor toward dir ${dir}`);
            }
        }
    }
    return true;
}

// ── The tilesets ─────────────────────────────────────────────────────────────

export const MARS_TILESET = buildTileset({
    body: 'mars',
    classes: [
        { id: 'plains',   label: 'Smooth plains',      color: [0.78, 0.45, 0.30], reliefAmpM: 40,  grain: 0.6 },
        { id: 'cratered', label: 'Cratered highlands', color: [0.62, 0.34, 0.22], reliefAmpM: 220, grain: 1.4 },
        { id: 'dunes',    label: 'Dune field',         color: [0.45, 0.26, 0.20], reliefAmpM: 60,  grain: 2.2 },
        { id: 'channel',  label: 'Outflow channel',    color: [0.82, 0.55, 0.38], reliefAmpM: 120, grain: 1.0 },
        { id: 'chaos',    label: 'Chaos terrain',      color: [0.50, 0.28, 0.19], reliefAmpM: 300, grain: 1.8 },
        { id: 'lava',     label: 'Volcanic flank',     color: [0.58, 0.30, 0.20], reliefAmpM: 90,  grain: 0.8 },
        { id: 'ice',      label: 'Polar layered ice',  color: [0.93, 0.88, 0.86], reliefAmpM: 80,  grain: 0.7 },
    ],
    // Real relationships: dunes pool in plains and ring the polar cap
    // (Olympia Undae) but do not abut raw chaos; ice touches only plains and
    // its erg. Channels are a LINEAR family now — they thread through plains,
    // cratered ground, dunes, and the chaos they historically emerge from,
    // but as one-cell-wide chains with forced continuation, not blobs.
    base: {
        plains:   { weight: 1.00, adj: ['plains', 'cratered', 'dunes', 'lava', 'ice'] },
        cratered: { weight: 0.95, adj: ['cratered', 'plains', 'chaos', 'lava'] },
        dunes:    { weight: 0.55, adj: ['dunes', 'plains', 'ice'] },
        chaos:    { weight: 0.40, adj: ['chaos', 'cratered'] },
        lava:     { weight: 0.45, adj: ['lava', 'plains', 'cratered'] },
        ice:      { weight: 0.30, adj: ['ice', 'plains', 'dunes'] },
    },
    // Family weights are TUNED, not guessed: at a forced line tip the domain
    // is family-only, so the class prior cancels and the seg:bend:end ratio
    // alone sets chain length (0.22:0.045:0.012 ⇒ mean ~12 cells). Priors
    // control only how often lines SEED — lower the prior coefficient, not
    // these ratios, to make a family rarer.
    families: {
        channel: { background: ['plains', 'cratered', 'chaos', 'dunes'], segWeight: 0.22, bendWeight: 0.045, endWeight: 0.012 },
    },
});

export const MOON_TILESET = buildTileset({
    body: 'moon',
    classes: [
        { id: 'maria',     label: 'Mare basalt',           color: [0.30, 0.31, 0.35], reliefAmpM: 40,  grain: 0.6 },
        { id: 'highlands', label: 'Feldspathic highlands', color: [0.72, 0.70, 0.66], reliefAmpM: 240, grain: 1.5 },
        { id: 'rim',       label: 'Crater rim',            color: [0.60, 0.58, 0.55], reliefAmpM: 320, grain: 2.0 },
        { id: 'ejecta',    label: 'Ejecta / rays',         color: [0.86, 0.84, 0.80], reliefAmpM: 90,  grain: 1.2 },
        { id: 'rille',     label: 'Sinuous rille',         color: [0.22, 0.23, 0.27], reliefAmpM: 110, grain: 0.9 },
        { id: 'wrinkle',   label: 'Wrinkle ridge',         color: [0.38, 0.38, 0.41], reliefAmpM: 130, grain: 0.8 },
        { id: 'swirl',     label: 'Bright swirl',          color: [0.92, 0.90, 0.84], reliefAmpM: 0,   grain: 0.5 },
    ],
    // Rilles and wrinkle ridges are LINEAR mare-interior structures — port
    // families over a maria background, so they grow as one-cell-wide chains
    // (a collapsed lava channel, a compression ridge), never speckle. Swirls
    // are albedo PATCHES on maria (Reiner Gamma) — a blob class on purpose,
    // zero relief on purpose. Ejecta and rims bridge maria ↔ highlands.
    base: {
        maria:     { weight: 1.00, adj: ['maria', 'swirl', 'rim', 'ejecta', 'highlands'] },
        highlands: { weight: 1.00, adj: ['highlands', 'rim', 'ejecta', 'maria'] },
        rim:       { weight: 0.35, adj: ['rim', 'ejecta', 'maria', 'highlands'] },
        ejecta:    { weight: 0.40, adj: ['ejecta', 'rim', 'maria', 'highlands'] },
        swirl:     { weight: 0.10, adj: ['swirl', 'maria'] },
    },
    // Same tuned tip ratios as the Mars channels (see that note): chain
    // length lives here, seeding rate lives in moonClassPriors.
    families: {
        rille:   { background: ['maria'], segWeight: 0.22, bendWeight: 0.045, endWeight: 0.012 },
        wrinkle: { background: ['maria'], segWeight: 0.26, bendWeight: 0.050, endWeight: 0.016 },
    },
});

// ── The solver ───────────────────────────────────────────────────────────────

/**
 * Collapse a width×height grid over the tileset.
 *
 * @param {object}   opts
 * @param {object}   opts.tileset   MARS_TILESET | MOON_TILESET | buildTileset(...)
 * @param {number}   opts.width     cells across (east)
 * @param {number}   opts.height    cells down (row 0 = NORTH edge)
 * @param {number}   opts.seed      uint32 — see regionSeed()
 * @param {Float32Array|number[]|null} [opts.priors]
 *        length width*height*tiles.length, row-major, tile-fastest: the weight
 *        MULTIPLIER for tile t at cell (x,y) is priors[(y*width+x)*T + t].
 *        0 excludes a tile from that cell outright. null ⇒ uniform. Build
 *        per-class priors with expandClassPriors().
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
    const baseWeights = tileset.tiles.map(t => t.weight);

    // Per-family tile masks: a cell whose whole domain sits inside one of
    // these is an OBLIGATED line cell (a tip that must continue or cap).
    const familyMasks = [];
    for (const famId of Object.keys(tileset.families)) {
        let mask = 0;
        tileset.tiles.forEach((t, i) => { if (t.classId === famId) mask |= 1 << i; });
        familyMasks.push(mask);
    }

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
        const result = attemptCollapse({
            domain, width, height, masks: tileset.masks, familyMasks, effW, rand, seed, attempt,
        });
        if (result) {
            return { grid: result, width, height, tileset, restarts: attempt, seed };
        }
    }
    throw new Error(`WFC failed after ${maxRestarts} restarts — tileset over-constrained for these priors`);
}

function attemptCollapse({ domain, width, height, masks, familyMasks, effW, rand, seed, attempt }) {
    const cellCount = width * height;
    const collapsed = new Uint8Array(cellCount);      // 1 = done
    const grid = new Uint8Array(cellCount);
    // Cached per-cell entropy. Recomputed ONLY when a cell's domain shrinks —
    // domains shrink at most (tiles−1) times per cell over the whole solve, so
    // the log-weight work is bounded, and the min-scan below is a plain float
    // sweep. This is what keeps a 48² solve fast; the naive rescan recomputed
    // entropy (with a PRNG call per cell!) every step and cost ~500 ms.
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
        let h = Math.log(sumW) - sumWLog / sumW + jitter(c);
        // OBLIGATED line cells collapse first. Shannon entropy is
        // scale-invariant in the weights, so a frontier cell dominated by the
        // background class scores LOWER than a forced family tip (which still
        // has 3–4 live variants) — left alone, the background frontier races
        // around the tip and boxes the line in after 2–3 cells. Measured:
        // mean chains of ~2.5 without this bias, ~12 with it. Depth-first
        // line growth is the whole point of the port families.
        for (const famMask of familyMasks) {
            if ((domain[c] & ~famMask) === 0) { h -= 8; break; }
        }
        entropy[c] = h;
    };

    // Propagate a domain change at `cell` to its 4-neighborhood until stable.
    // The union masks are PER DIRECTION — that is what carries the port rules
    // that make linear classes grow as lines.
    const propagateFrom = (cell) => {
        queue.length = 0;
        queue.push(cell);
        while (queue.length) {
            const c = queue.pop();
            const x = c % width;
            const y = (c - x) / width;
            for (let dir = 0; dir < 4; dir += 1) {
                let nb = -1;
                if (dir === 0 && y > 0) nb = c - width;             // N
                else if (dir === 1 && x < width - 1) nb = c + 1;    // E
                else if (dir === 2 && y < height - 1) nb = c + width; // S
                else if (dir === 3 && x > 0) nb = c - 1;            // W
                if (nb < 0) continue;
                let allowMask = 0;
                let m = domain[c];
                while (m) {
                    const t = 31 - Math.clz32(m);
                    allowMask |= masks[t * 4 + dir];
                    m &= ~(1 << t);
                }
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
    // priors already narrowed. This is also what structurally prevents a
    // line segment from ever pointing an open port at a cell whose priors
    // exclude the family — the segment is pruned from the boundary cell's
    // domain before the first collapse.
    for (let c = 0; c < cellCount; c += 1) {
        if (bitCount(domain[c]) === 1) {
            if (!collapsed[c]) settle(c);
        } else {
            refreshEntropy(c);
        }
    }
    for (let c = 0; c < cellCount; c += 1) {
        if (!propagateFrom(c)) return null;
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
// Both functions return a Float32Array in CLASS ORDER (tileset.classes),
// non-negative, with at least one strictly positive entry. They are pure
// functions of physical numbers so the node gate can pin the geology without
// a browser. Expand to per-tile priors with expandClassPriors().

const clamp01 = v => Math.min(1, Math.max(0, v));
const smooth = (a, b, v) => {
    const t = clamp01((v - a) / (b - a));
    return t * t * (3 - 2 * t);
};

/**
 * Mars: priors from REAL MOLA elevation, local slope, and latitude — plus an
 * optional DRAINAGE term (0..1) from flowAccumulation: where upstream area
 * has genuinely converged, channels seed hard regardless of how gentle the
 * local floor is. Callers normalize accumulation themselves (convergence
 * thresholds ≥ grid size — a plane's parallel drainage must score 0).
 * @param {object} m  { elevationM, slopeDeg, latDeg, drainage? }
 */
export function marsClassPriors({ elevationM, slopeDeg, latDeg, drainage = 0 }) {
    const absLat = Math.abs(latDeg);
    const p = new Float32Array(MARS_TILESET.classes.length);
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
    // Channel is a LINEAR family: these coefficients set how often chains
    // SEED (their length is fixed by the family's tip ratios). The slope
    // term finds hillside tributaries; the drainage term is what puts a
    // TRUNK down a flat valley floor — local slope cannot see that.
    p[3] = 0.30 * steep * lowland * (1 - polar) + 0.015
        + 1.2 * clamp01(drainage) * (1 - polar);                     // channel
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
    const p = new Float32Array(MOON_TILESET.classes.length);
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
    // Rille/wrinkle are LINEAR families: these coefficients set seeding rate
    // only — chain length is fixed by the family tip ratios in the tileset.
    p[4] = 0.12 * dark;                                           // rille — mare interiors only
    p[5] = 0.15 * dark;                                           // wrinkle ridge
    p[6] = dark * (0.02 + 1.6 * clamp01(swirlBoost));             // swirl
    return p;
}

/**
 * The Mars channel ROUTING recipe — one copy, used verbatim by the Mars page
 * and pinned by the kernel test so the two cannot drift:
 *   axis     — the D8 ROUTED direction where one exists (on a flat filled
 *              valley floor that is the spill path, exactly where the raw
 *              gradient fails); gradient axis as the border fallback.
 *   strength — slope ramp (0.06–0.6°, gentle floors still steer) OR the
 *              accumulation ramp, whichever is stronger: a trunk keeps its
 *              heading even where the floor is nearly flat.
 *   drainageNorm — convergence-thresholded accumulation for the PRIOR.
 *              Thresholds scale with the grid edge (≥ cells) because D8 on a
 *              plane degenerates to parallel columns with accumulation up to
 *              ≈ cells without any real channeling — convergence, not path
 *              length, is what makes a channel.
 */
export function marsChannelRouting(field, drain, i, cells) {
    const acc = drain.accumulation[i];
    const routed = drain.dirEast[i] !== 0 || drain.dirNorth[i] !== 0;
    return {
        axisEast: routed ? drain.dirEast[i] : field.axisEast[i],
        axisNorth: routed ? drain.dirNorth[i] : field.axisNorth[i],
        strength: Math.max(
            0.85 * smooth(0.06, 0.6, field.slopeDeg[i]),
            0.85 * smooth(cells * 0.8, cells * 2.5, acc),
        ),
        drainageNorm: smooth(cells * 1.0, cells * 4.0, acc),
    };
}

/**
 * Write a CLASS-ordered prior vector into a per-TILE priors array at
 * cellIndex. Every variant of a linear family gets its class's prior — the
 * seg/bend/end mix is carried by tile weights, not priors.
 */
export function expandClassPriors(tileset, classVector, priors, cellIndex) {
    const T = tileset.tiles.length;
    const base = cellIndex * T;
    for (let t = 0; t < T; t += 1) {
        priors[base + t] = classVector[tileset.classOfTile[t]];
    }
}

/**
 * Alignment of one family variant with a feature AXIS whose east/north
 * components are (ae, an), both already |absolute| and normalized. Segments
 * and end-caps score by the axis component along their own axis. Bends score
 * (ae+an)/√2: on a CARDINAL axis that is 0.71 — they lose to the aligned
 * segment (1.0) and straight runs stay straight — but on a DIAGONAL axis it
 * reaches 1.0 while both segments tie at 0.71, so bends WIN and the chain
 * zigzags along the diagonal. Without this, a diagonal fall line (or the
 * diagonal sectors of a basin-tangent arc) gave the solver no directional
 * signal at all and chains drifted straight across as chords — measured
 * mean tangential alignment stuck at ~0.69 vs 0.64 unbiased.
 */
function variantAxisScore(tile, ae, an) {
    if (tile.kind === 1) return (ae + an) / Math.SQRT2;              // bend
    const northish = (tile.ports & (PORT_BIT[DIR_N] | PORT_BIT[DIR_S])) !== 0;
    return northish ? an : ae;                                       // seg / end
}

/**
 * FLOW-AWARE variant expansion: like expandClassPriors, but linear-family
 * variants are additionally weighted by how well they align with a caller-
 * supplied feature axis — this is what makes martian channels run down the
 * measured MOLA fall line and lunar wrinkle ridges arc around their mare's
 * center. The kernel stays geology-agnostic: callers decide what the axis
 * MEANS (downhill gradient, basin tangent, …).
 *
 * @param {object} flows  { [familyClassId]: { axisEast, axisNorth, strength } }
 *        axisEast/axisNorth — the feature's long-axis direction in local
 *        east/north components; SIGN IS IGNORED (a channel is the same line
 *        read uphill or down) and the vector need not be normalized.
 *        strength — 0..1 how hard to steer; internally capped at 0.85 and
 *        the per-variant multiplier is floored at 0.1, so flow can never
 *        exclude a variant outright — that stays the priors' job. At a
 *        forced line tip the class prior cancels but THESE multipliers do
 *        not, which is exactly how a chain tracks a curving axis: the
 *        cross-axis segment loses to a bend where the axis turns.
 */
export function expandClassPriorsFlow(tileset, classVector, priors, cellIndex, flows = null) {
    const T = tileset.tiles.length;
    const base = cellIndex * T;
    for (let t = 0; t < T; t += 1) {
        const tile = tileset.tiles[t];
        let p = classVector[tileset.classOfTile[t]];
        const flow = flows && tile.kind >= 0 ? flows[tile.classId] : null;
        if (flow && p > 0) {
            const mag = Math.hypot(flow.axisEast, flow.axisNorth);
            const s = Math.min(0.85, Math.max(0, flow.strength ?? 0));
            if (mag > 1e-12 && s > 0) {
                const score = variantAxisScore(tile, Math.abs(flow.axisEast) / mag, Math.abs(flow.axisNorth) / mag);
                p *= Math.max(0.1, (1 - s) + s * 2 * score);
            }
        }
        priors[base + t] = p;
    }
}

/**
 * Per-cell slope/flow field from a cells×cells elevation grid (row 0 north,
 * same layout as regionGrid). Two DIFFERENT derivatives on purpose:
 *
 *   axisEast/axisNorth — CENTRAL differences. At a resolved valley floor the
 *   two walls cancel and the tiny along-valley signal survives, which is the
 *   direction a channel actually runs. Forward differences there see only
 *   the nearest wall and point the axis CROSS-valley — the bug this helper
 *   exists to avoid. (Sign of the axis is irrelevant downstream.)
 *
 *   wallSlopeDeg — max one-sided difference per axis. A valley floor flanked
 *   by steep walls KEEPS a high value, so channel priors still seed there
 *   even though the floor itself is nearly flat. slopeDeg (central) is the
 *   honest local gradient magnitude for everything else.
 *
 * @param {Float32Array|number[]} elevations  length cells², metres
 * @param {number} cells
 * @param {number} spacingM  cell spacing in METRES
 */
export function slopeField(elevations, cells, spacingM) {
    const n = cells * cells;
    const axisEast = new Float32Array(n);
    const axisNorth = new Float32Array(n);
    const slopeDeg = new Float32Array(n);
    const wallSlopeDeg = new Float32Array(n);
    const RAD2DEG = 180 / Math.PI;
    for (let row = 0; row < cells; row += 1) {
        for (let col = 0; col < cells; col += 1) {
            const i = row * cells + col;
            const e = elevations[i];
            const eE = col + 1 < cells ? elevations[i + 1] : e;
            const eW = col > 0 ? elevations[i - 1] : e;
            const eN = row > 0 ? elevations[i - cells] : e;      // row 0 = north
            const eS = row + 1 < cells ? elevations[i + cells] : e;
            const spanE = (col + 1 < cells ? 1 : 0) + (col > 0 ? 1 : 0);
            const spanN = (row > 0 ? 1 : 0) + (row + 1 < cells ? 1 : 0);
            const gradE = spanE ? (eE - eW) / (spanE * spacingM) : 0;
            const gradN = spanN ? (eN - eS) / (spanN * spacingM) : 0;
            axisEast[i] = gradE;
            axisNorth[i] = gradN;
            slopeDeg[i] = Math.atan(Math.hypot(gradE, gradN)) * RAD2DEG;
            const wallE = Math.max(Math.abs(eE - e), Math.abs(e - eW)) / spacingM;
            const wallN = Math.max(Math.abs(eN - e), Math.abs(e - eS)) / spacingM;
            wallSlopeDeg[i] = Math.atan(Math.hypot(wallE, wallN)) * RAD2DEG;
        }
    }
    return { axisEast, axisNorth, slopeDeg, wallSlopeDeg };
}

/**
 * Drainage accumulation over a cells×cells elevation grid (row 0 north, same
 * layout as regionGrid) — the piece local slope cannot provide: WHERE water
 * actually collects. Three classic stages, all deterministic:
 *
 *   1. Priority-flood depression filling (Barnes 2014) with an epsilon step,
 *      so closed pits fill to their spill level and filled flats drain
 *      toward the spill instead of stalling. Filled elevations are Float64 —
 *      float32 cannot resolve the epsilon against multi-km elevations.
 *   2. D8 steepest descent on the FILLED surface (drop over distance,
 *      diagonals ÷√2). The flood guarantees every interior cell a strictly
 *      lower neighbor; border cells without one drain off-map.
 *   3. Upstream-area accumulation in decreasing filled-elevation order
 *      (a valid topological order, since downstream is strictly lower).
 *
 * Invariant (pinned by the test): every unit of area exits the map exactly
 * once — the accumulation of off-map-draining cells sums to cells².
 *
 * Consumers should threshold accumulation against CONVERGENCE, not path
 * length: on a perfect tilted plane D8 degenerates to parallel columns whose
 * accumulation grows linearly (max ≈ cells) without any real channeling, so
 * "trunk" thresholds belong at ≥ cells — see the Mars page's recipe.
 *
 * @returns {{ accumulation: Float32Array, dirEast: Float32Array,
 *             dirNorth: Float32Array, downstream: Int32Array, filled: Float64Array }}
 *          accumulation in CELLS (own cell included); dirEast/dirNorth is the
 *          unit routed-flow direction, (0,0) where flow exits the map.
 */
export function flowAccumulation(elevations, cells, spacingM) {
    const n = cells * cells;
    const filled = new Float64Array(n);
    const visited = new Uint8Array(n);
    const EPS = 1e-3;                                 // metres per flood step

    // Binary min-heap over (filled elevation, index) — index tie-break keeps
    // the flood order fully deterministic even on exactly-equal elevations.
    const heap = [];
    const less = (a, b) => filled[a] < filled[b] || (filled[a] === filled[b] && a < b);
    const heapPush = (c) => {
        heap.push(c);
        let i = heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (!less(heap[i], heap[p])) break;
            [heap[i], heap[p]] = [heap[p], heap[i]];
            i = p;
        }
    };
    const heapPop = () => {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
            heap[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let m = i;
                if (l < heap.length && less(heap[l], heap[m])) m = l;
                if (r < heap.length && less(heap[r], heap[m])) m = r;
                if (m === i) break;
                [heap[i], heap[m]] = [heap[m], heap[i]];
                i = m;
            }
        }
        return top;
    };

    for (let c = 0; c < n; c += 1) {
        const x = c % cells;
        const y = (c - x) / cells;
        if (x === 0 || y === 0 || x === cells - 1 || y === cells - 1) {
            filled[c] = elevations[c];
            visited[c] = 1;
            heapPush(c);
        }
    }
    const NB8 = [-1, 1, -cells, cells, -cells - 1, -cells + 1, cells - 1, cells + 1];
    const inBounds = (c, k) => {
        const x = c % cells;
        if ((k === 0 || k === 4 || k === 6) && x === 0) return false;         // west-ish
        if ((k === 1 || k === 5 || k === 7) && x === cells - 1) return false; // east-ish
        const nb = c + NB8[k];
        return nb >= 0 && nb < n;
    };
    while (heap.length) {
        const c = heapPop();
        for (let k = 0; k < 8; k += 1) {
            if (!inBounds(c, k)) continue;
            const nb = c + NB8[k];
            if (visited[nb]) continue;
            visited[nb] = 1;
            filled[nb] = Math.max(elevations[nb], filled[c] + EPS);
            heapPush(nb);
        }
    }

    // D8 on the filled surface.
    const downstream = new Int32Array(n).fill(-1);
    const dirEast = new Float32Array(n);
    const dirNorth = new Float32Array(n);
    const DIAG = Math.SQRT1_2;
    // dx (east+), dy (south+ = row+), inverse distance weight per NB8 slot.
    const DX8 = [-1, 1, 0, 0, -1, 1, -1, 1];
    const DY8 = [0, 0, -1, 1, -1, -1, 1, 1];
    const W8 = [1, 1, 1, 1, DIAG, DIAG, DIAG, DIAG];
    for (let c = 0; c < n; c += 1) {
        let bestK = -1;
        let bestDrop = 0;
        for (let k = 0; k < 8; k += 1) {
            if (!inBounds(c, k)) continue;
            const drop = (filled[c] - filled[c + NB8[k]]) * W8[k];
            if (drop > bestDrop) { bestDrop = drop; bestK = k; }
        }
        if (bestK >= 0) {
            downstream[c] = c + NB8[bestK];
            const len = Math.hypot(DX8[bestK], DY8[bestK]);
            dirEast[c] = DX8[bestK] / len;
            dirNorth[c] = -DY8[bestK] / len;          // row+ is SOUTH
        }
    }

    // Accumulate high → low (strictly valid order on the filled surface).
    const order = Array.from({ length: n }, (_, i) => i)
        .sort((a, b) => (filled[b] - filled[a]) || (a - b));
    const accumulation = new Float32Array(n).fill(1);
    for (const c of order) {
        if (downstream[c] >= 0) accumulation[downstream[c]] += accumulation[c];
    }
    return { accumulation, dirEast, dirNorth, downstream, filled };
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

/**
 * Fraction of cells carrying each CLASS id (family variants aggregate into
 * their class) — legends + tests read this.
 */
export function classShares(result) {
    const { tileset } = result;
    const counts = new Array(tileset.classes.length).fill(0);
    for (const t of result.grid) counts[tileset.classOfTile[t]] += 1;
    const shares = {};
    tileset.classes.forEach((cls, i) => {
        shares[cls.id] = counts[i] / result.grid.length;
    });
    return shares;
}
