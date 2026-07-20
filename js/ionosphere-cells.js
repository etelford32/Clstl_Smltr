/**
 * ionosphere-cells.js — WFC regional cell engine (Track B of
 * IONOSPHERE_EXPLORATION_PLAN.md, M2 STARTER PROTOTYPE)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure functions + one class: no DOM, no THREE, no fetch.
 * tests/ionosphere-cells.mjs runs this exact module under node — including
 * the PERF PROBE that answers the plan's open question 1 (is an 864-cell
 * collapse + 288×192 bake cheap enough per epoch for phones?). This is the
 * "experiment first" build (2026-07-20 decision): 6 starter states, the
 * priors/adjacency/collapse machinery, and the bake — render integration
 * comes after the numbers hold up.
 *
 * ── The idea ────────────────────────────────────────────────────────────────
 * A 36 × 24 grid in quasi-dipole coordinates (5° maglat × 1 h MLT — sun-
 * fixed, Earth rotates under it) where each cell holds ONE discrete regional
 * state. Physics fields act as PRIOR WEIGHTS (what wants to happen here);
 * adjacency rules act as CONSTRAINTS (what can coexist next to what); a
 * min-entropy wave-function-collapse pass turns the two into a coherent,
 * inspectable map. Every cell keeps its `why` — the top priors that argued
 * for its state — because pedagogy is a first-class output.
 *
 * Starter state vocabulary (M2): quiet · crest · bubble · arc · diffuse ·
 * trough. SAPS / patches / TOI / SED land in M4 — and SAPS the *simulation*
 * stays in the Shielding Lab (2026-07-20 decision).
 *
 * ── Priors (weights, all VIZ-grade parameterizations) ───────────────────────
 *   oval center   Feldstein-flavored: 70° − 1.8·Kp − 3·cos(MLT·π/12) |maglat|
 *                 (midnight-equatorward, storm-expanding; Kp 5 midnight ≈ 58°)
 *   arc           Gaussian on the oval center (σ 2°), night-weighted, ∝ Kp
 *   diffuse       Gaussian 4° equatorward of center (σ 2.5°), night, ∝ Kp
 *   trough        subauroral plateau 5–12° equatorward of center, 18–06 MLT
 *   crest         Appleton band |maglat| ≈ 14° ± 4°, from the FOUNTAIN
 *                 kernel's per-longitude crest intensity (MLT → geographic
 *                 lon via lon = (MLT − UT)·15 — mean-sun approximation,
 *                 same one the fountain's LT uses)
 *   bubble        |maglat| within the live bubble's field-aligned extent at
 *                 that longitude, 19–02 MLT window (the R-T window)
 *   quiet         baseline everywhere; polar cap and quiet dayside
 *
 * ── Constraints (the physics of coherence, starter set) ─────────────────────
 *   arc      poleward ∈ {arc, quiet}; equatorward ∈ {diffuse, arc, quiet};
 *            NEVER directly above trough (diffuse must intervene)
 *   diffuse  poleward ∈ {arc, diffuse, quiet}; equatorward ∈ {trough,
 *            diffuse, quiet}
 *   trough   poleward ∈ {diffuse, trough, quiet} — equatorward of the oval
 *   bubble   lat/MLT neighbors ∈ {bubble, crest, quiet} (field-aligned
 *            column; wave-train neighbors east/west)
 *   crest    neighbors ∈ {crest, bubble, quiet}
 *   quiet    universal — ALSO the contradiction escape: quiet is in every
 *            cell's possible set by construction, so a true empty-set
 *            contradiction is structurally impossible; what we count
 *            instead is `forcedQuiet` (a cell whose best prior got
 *            constraint-eliminated) — a rising rate is a rules bug, the
 *            same canary the plan's contradiction counter wanted.
 *
 * ── Collapse & time ─────────────────────────────────────────────────────────
 * Min-entropy WFC with arc-consistency propagation, INCREMENTAL: an epoch
 * re-opens only cells whose prior vector moved beyond a hysteresis band
 * (plus re-propagation into their neighborhood); everything else keeps its
 * state. Deterministic RNG per (cell, epoch) — hash1, the house pattern.
 * The 288×192 equirect bake maps texels through a PRECOMPUTED static
 * maglat/lon table (Earth-fixed), so per-epoch bake cost is table lookups.
 */

import { hash1, N_CELLS as N_LON_CELLS } from './ionosphere-fountain.js';

// ── Grid ─────────────────────────────────────────────────────────────────────
export const N_LAT = 36;                 // 5° maglat bins, centers −87.5…+87.5
export const N_MLT = 24;                 // 1 h MLT bins, centers 0.5…23.5
export const N_GRID = N_LAT * N_MLT;     // 864
export const STATES = Object.freeze(['quiet', 'crest', 'bubble', 'arc', 'diffuse', 'trough']);
export const S = Object.freeze({ QUIET: 0, CREST: 1, BUBBLE: 2, ARC: 3, DIFFUSE: 4, TROUGH: 5 });
const N_S = STATES.length;
const ALL_MASK = (1 << N_S) - 1;

export const latCenter = (i) => -90 + 2.5 + i * 5;      // signed maglat (deg)
export const mltCenter = (j) => j + 0.5;                // MLT hours

// Bake target — plan C.4's global shell texture.
export const BAKE_W = 288, BAKE_H = 192;

// IGRF-13 dipole pole (epoch 2025.0) — same constants as coords.js / the
// fountain kernel (literal: this module stays THREE-free).
const POLE_LAT = 80.65 * Math.PI / 180;
const POLE_LON = -72.68 * Math.PI / 180;

/** Centered-tilted-dipole magnetic latitude (deg) of a geographic point —
 *  the SAME mapping the bake's static texel table uses; exported so the
 *  page-side cell inspector converts identically. */
export function magLatDeg(latDeg, lonDeg) {
    const lat = latDeg * Math.PI / 180, lon = lonDeg * Math.PI / 180;
    const sinMag = Math.sin(lat) * Math.sin(POLE_LAT)
        + Math.cos(lat) * Math.cos(POLE_LAT) * Math.cos(lon - POLE_LON);
    return Math.asin(Math.max(-1, Math.min(1, sinMag))) * 180 / Math.PI;
}

/** Default bake palette (RGBA per state, prototype legibility). Callers may
 *  pass their own — ring-current.html mutes crest/bubble to alpha 0 because
 *  the analytic airglow shell already owns those two states on the globe. */
export const BAKE_PALETTE = Uint8Array.from([
    10, 12, 24, 30,       // quiet: near-transparent deep blue
    255, 92, 56, 200,     // crest: 630 nm red-orange
    40, 8, 16, 235,       // bubble: dark bite
    64, 255, 128, 220,    // arc: auroral green
    40, 160, 90, 150,     // diffuse: dim green
    60, 120, 255, 130,    // trough: dim blue
]);

// ── Priors ───────────────────────────────────────────────────────────────────

/** Feldstein-flavored auroral oval center |maglat| (deg). Kp 1 midnight
 *  ≈ 65°, Kp 5 ≈ 58°, Kp 8 ≈ 53° — storm ovals push into the low 50s. */
export function ovalCenterMaglat(mlt, kp) {
    const k = Number.isFinite(kp) ? Math.max(0, Math.min(9, kp)) : 1;
    return 70 - 1.8 * k - 3 * Math.cos(mlt * Math.PI / 12);
}

const gauss = (x, sigma) => Math.exp(-(x * x) / (2 * sigma * sigma));
/** Smooth night weighting: 1 at 00 MLT, ~0 at noon. */
const nightness = (mlt) => 0.5 + 0.5 * Math.cos(mlt * Math.PI / 12);
/** Smooth membership of mlt in the wrapped window [a, b] (hours). */
function mltWindow(mlt, a, b, soft = 0.75) {
    const span = (b - a + 24) % 24;
    const x = (mlt - a + 24) % 24;
    if (x < -soft || x > span + soft) return 0;
    const inA = Math.min(1, Math.max(0, (x + soft) / (2 * soft)));
    const inB = Math.min(1, Math.max(0, (span + soft - x) / (2 * soft)));
    return Math.min(inA, inB);
}

/**
 * Prior weight vector for one cell. `fields`:
 *   kp, utH               — live driver + UT hours (for MLT → lon)
 *   crest[72]             — fountain per-lon crest intensity (0..~1)
 *   bubbleExtent[72]      — live max |maglat| extent of bubbles per lon (deg,
 *                           0 = none), from the fountain's allBubbles()
 * Writes into `out` (Float32Array length 6) and returns it.
 */
export function priorWeights(latIdx, mltIdx, fields, out = new Float32Array(N_S)) {
    const lat = latCenter(latIdx);
    const alat = Math.abs(lat);
    const mlt = mltCenter(mltIdx);
    const kp = Number.isFinite(fields.kp) ? fields.kp : 1;
    const night = nightness(mlt);
    const center = ovalCenterMaglat(mlt, kp);
    const kpN = Math.max(0, Math.min(1, kp / 9));

    // Geographic longitude under this MLT column right now (mean sun).
    const lonDeg = (((mlt - (fields.utH ?? 0)) * 15) % 360 + 540) % 360 - 180;
    const lonIdx = Math.max(0, Math.min(N_LON_CELLS - 1, Math.floor((lonDeg + 180) / (360 / N_LON_CELLS))));
    const crestIn = fields.crest ? fields.crest[lonIdx] : 0;
    const bubExt = fields.bubbleExtent ? fields.bubbleExtent[lonIdx] : 0;

    out[S.QUIET] = 0.25
        + 0.55 * Math.max(0, 1 - night) * gauss(alat - 35, 12)      // calm dayside MID-lat
        + 0.8 * Math.min(1, Math.max(0, (alat - center - 5) / 8));  // polar cap
    out[S.CREST] = 1.5 * crestIn * gauss(alat - 14, 4);
    out[S.BUBBLE] = (alat <= bubExt + 1 ? 1.8 : 0)
        * mltWindow(mlt, 19, 2) * Math.min(1, bubExt / 5);
    // Day floors keep the oval CONTINUOUS through noon (the cusp-side oval
    // is real; a ring that opens on the dayside is a rules bug, test-pinned).
    out[S.ARC] = (0.25 + 1.35 * kpN) * (0.42 + 0.58 * night) * gauss(alat - center, 2);
    out[S.DIFFUSE] = (0.2 + 1.2 * kpN) * (0.35 + 0.65 * night) * gauss(alat - (center - 4), 2.5);
    out[S.TROUGH] = 0.9 * Math.min(1, kp / 6) * mltWindow(mlt, 18, 6)
        * (alat > center - 12 && alat < center - 5 ? 1 : 0);
    return out;
}

// ── Adjacency (compatibility bitmasks) ───────────────────────────────────────
// Directions: 0 = poleward, 1 = equatorward, 2 = east (+MLT), 3 = west.
// Built from pair rules with automatic reciprocity; QUIET is universal.
const COMPAT = (() => {
    const m = Array.from({ length: N_S }, () => new Uint8Array(4));
    const allowAll = (s) => { for (let d = 0; d < 4; d++) m[s][d] = ALL_MASK; };
    // Start from nothing-allowed except self+quiet, then open pairs.
    for (let s = 0; s < N_S; s++) {
        for (let d = 0; d < 4; d++) m[s][d] = (1 << S.QUIET) | (1 << s);
    }
    allowAll(S.QUIET);
    // latPair(equatorwardState, polewardState): x may sit equatorward of y.
    const latPair = (x, y) => { m[x][0] |= 1 << y; m[y][1] |= 1 << x; };
    // mltPair: x and y may sit side by side in MLT.
    const mltPair = (x, y) => { m[x][2] |= 1 << y; m[x][3] |= 1 << y; m[y][2] |= 1 << x; m[y][3] |= 1 << x; };
    latPair(S.DIFFUSE, S.ARC);       // diffuse under arc (the canonical stack)
    latPair(S.TROUGH, S.DIFFUSE);    // trough under diffuse
    latPair(S.CREST, S.BUBBLE);      // bubble column tops a crest band
    latPair(S.BUBBLE, S.CREST);      // …and crests flank bubble columns
    mltPair(S.ARC, S.DIFFUSE);       // oval chains along MLT
    mltPair(S.DIFFUSE, S.TROUGH);
    mltPair(S.BUBBLE, S.CREST);      // wave-train neighbors
    // NOT opened, deliberately: (TROUGH poleward→ARC) — diffuse must
    // intervene between trough and arc; that gap is test-pinned.
    return m;
})();

/** Test/inspection handle: may state `a` sit in direction `dir` of `b`? */
export function compatible(b, dir, a) {
    return (COMPAT[b][dir] & (1 << a)) !== 0;
}

// ── The engine ───────────────────────────────────────────────────────────────

export class IonosphereCells {
    constructor() {
        this.state = new Uint8Array(N_GRID).fill(S.QUIET);
        this.why = Array.from({ length: N_GRID }, () => []);
        this._priors = new Float32Array(N_GRID * N_S);
        this._lastPriors = new Float32Array(N_GRID * N_S).fill(-1); // force first collapse
        this._possible = new Uint16Array(N_GRID);
        this._entropy = new Float32Array(N_GRID);
        this._open = new Uint8Array(N_GRID);
        this.stats = { epochs: 0, contradictions: 0, forcedQuiet: 0, collapsed: 0 };
        this.hysteresis = 0.18;

        // Neighbor tables. Poleward = away from the equator (sign-aware);
        // −1 = no neighbor (pole rows point off-grid, equator rows' equator-
        // ward neighbor is the OTHER hemisphere's mirror cell — physical:
        // a field-aligned column crosses the equator).
        this._nbr = new Int32Array(N_GRID * 4).fill(-1);
        for (let i = 0; i < N_LAT; i++) {
            const north = latCenter(i) > 0;
            for (let j = 0; j < N_MLT; j++) {
                const c = i * N_MLT + j, b = c * 4;
                const pole = north ? i + 1 : i - 1;
                const eq = north ? i - 1 : i + 1;
                if (pole >= 0 && pole < N_LAT) this._nbr[b] = pole * N_MLT + j;
                if (eq >= 0 && eq < N_LAT) this._nbr[b + 1] = eq * N_MLT + j;
                this._nbr[b + 2] = i * N_MLT + ((j + 1) % N_MLT);
                this._nbr[b + 3] = i * N_MLT + ((j + N_MLT - 1) % N_MLT);
            }
        }
        // The direction slot of each neighbor that points BACK at us. Not a
        // fixed 0↔1/2↔3 swap: at the equator seam the two straddling cells
        // are each the other's EQUATORWARD neighbor (poleward is sign-aware,
        // away from the equator), which is exactly right for field-aligned
        // columns crossing the equator — so we look it up, not assume it.
        this._oppDir = new Uint8Array(N_GRID * 4);
        for (let c = 0; c < N_GRID; c++) {
            for (let d = 0; d < 4; d++) {
                const n = this._nbr[c * 4 + d];
                if (n < 0) continue;
                for (let d2 = 0; d2 < 4; d2++) {
                    if (this._nbr[n * 4 + d2] === c) { this._oppDir[c * 4 + d] = d2; break; }
                }
            }
        }
    }

    /**
     * Run one epoch against the live fields (see priorWeights). Incremental:
     * only cells whose priors moved past the hysteresis band re-collapse.
     * `epochN` seeds the deterministic RNG — same fields + same epochN ⇒
     * identical map, bit for bit.
     */
    epoch(fields, epochN) {
        const st = this.stats;
        st.epochs++;
        let opened = 0;
        for (let c = 0; c < N_GRID; c++) {
            const w = priorWeights(Math.floor(c / N_MLT), c % N_MLT, fields,
                this._priors.subarray(c * N_S, c * N_S + N_S));
            let moved = 0;
            for (let s = 0; s < N_S; s++) {
                moved += Math.abs(w[s] - this._lastPriors[c * N_S + s]);
            }
            if (moved > this.hysteresis) {
                this._open[c] = 1;
                opened++;
                // Possible = states with support, plus the quiet escape.
                let mask = 1 << S.QUIET;
                for (let s = 0; s < N_S; s++) if (w[s] > 0.02) mask |= 1 << s;
                this._possible[c] = mask;
            } else {
                this._open[c] = 0;
                this._possible[c] = 1 << this.state[c];
            }
        }
        if (opened === 0) return 0;

        // Arc-consistency to a fixpoint over the open region.
        this._propagateAll();

        // Min-entropy collapse loop (ties by cell index — determinism).
        for (;;) {
            let best = -1, bestH = Infinity;
            for (let c = 0; c < N_GRID; c++) {
                if (!this._open[c]) continue;
                const h = this._cellEntropy(c);
                if (h < bestH - 1e-9) { bestH = h; best = c; }
            }
            if (best < 0) break;
            this._collapse(best, epochN);
            this._propagateFrom(best);
        }
        return opened;
    }

    _cellEntropy(c) {
        const mask = this._possible[c];
        let sum = 0, H = 0;
        for (let s = 0; s < N_S; s++) {
            if (mask & (1 << s)) sum += this._priors[c * N_S + s] + 1e-4;
        }
        for (let s = 0; s < N_S; s++) {
            if (mask & (1 << s)) {
                const p = (this._priors[c * N_S + s] + 1e-4) / sum;
                H -= p * Math.log(p);
            }
        }
        return H;
    }

    _collapse(c, epochN) {
        const mask = this._possible[c];
        const w = this._priors.subarray(c * N_S, c * N_S + N_S);
        // Jittered ARGMAX, not proportional sampling: this map is a physics
        // REGULARIZER, so a clearly-dominant prior must always win (the
        // Kp 5 oval closes structurally, not with dice); the ±15% per-state
        // hash jitter only breaks near-ties (state boundaries, mixed
        // regions), deterministically per (cell, state, epoch).
        let pick = S.QUIET, best = -Infinity;
        for (let s = 0; s < N_S; s++) {
            if (!(mask & (1 << s))) continue;
            const jit = 0.85 + 0.3 * hash1(c * 13.37 + epochN * 61.7 + s * 7.91);
            const v = (w[s] + 1e-4) * jit;
            if (v > best) { best = v; pick = s; }
        }
        // Bookkeeping: did constraints eliminate the priors' favorite?
        let fav = 0, favW = -1;
        for (let s = 0; s < N_S; s++) if (w[s] > favW) { favW = w[s]; fav = s; }
        if (!(mask & (1 << fav)) && fav !== pick) this.stats.forcedQuiet++;
        if (mask === 0) this.stats.contradictions++;   // structurally impossible; canary

        this.state[c] = pick;
        this._possible[c] = 1 << pick;
        this._open[c] = 0;
        this.stats.collapsed++;
        // The pedagogical `why`: top-3 priors by weight.
        const order = [];
        for (let s = 0; s < N_S; s++) order.push(s);
        order.sort((a, b) => w[b] - w[a]);
        this.why[c] = order.slice(0, 3).map(s => ({ state: STATES[s], w: +w[s].toFixed(3) }));
        for (let s = 0; s < N_S; s++) this._lastPriors[c * N_S + s] = w[s];
    }

    /** One arc-consistency sweep to fixpoint over open cells. */
    _propagateAll() {
        const queue = [];
        for (let c = 0; c < N_GRID; c++) if (this._open[c]) queue.push(c);
        this._runQueue(queue);
    }

    _propagateFrom(c) {
        const queue = [];
        for (let d = 0; d < 4; d++) {
            const n = this._nbr[c * 4 + d];
            if (n >= 0 && this._open[n]) queue.push(n);
        }
        this._runQueue(queue);
    }

    _runQueue(queue) {
        while (queue.length) {
            const c = queue.pop();
            const before = this._possible[c];
            let mask = before;
            for (let d = 0; d < 4; d++) {
                const n = this._nbr[c * 4 + d];
                if (n < 0) continue;
                // A state survives if SOME possible neighbor state allows it
                // in this direction (checked from the neighbor's frame, via
                // the precomputed back-pointing slot — see _oppDir).
                const od = this._oppDir[c * 4 + d];
                let allowed = 0;
                const nMask = this._possible[n];
                for (let s = 0; s < N_S; s++) {
                    if (nMask & (1 << s)) allowed |= COMPAT[s][od];
                }
                mask &= allowed;
            }
            mask |= (before & (1 << S.QUIET));      // the escape survives all
            if (mask !== before) {
                this._possible[c] = mask;
                for (let d = 0; d < 4; d++) {
                    const n = this._nbr[c * 4 + d];
                    if (n >= 0 && this._open[n]) queue.push(n);
                }
            }
        }
    }

    /** State at (signed maglat deg, MLT h) — render/inspector sampling. */
    sampleState(maglatDeg, mltH) {
        const i = Math.max(0, Math.min(N_LAT - 1, Math.floor((maglatDeg + 90) / 5)));
        const j = Math.max(0, Math.min(N_MLT - 1, Math.floor(((mltH % 24) + 24) % 24)));
        return this.state[i * N_MLT + j];
    }

    /**
     * Bake the global equirect shell texture (BAKE_W × BAKE_H RGBA). The
     * geographic→magnetic mapping per texel is STATIC (Earth-fixed dipole
     * pole) and precomputed on first use; per-epoch cost is pure lookups.
     * `utH` places the sun-fixed MLT grid under the geographic texels.
     */
    bake(utH, out = new Uint8Array(BAKE_W * BAKE_H * 4), PAL = BAKE_PALETTE) {
        if (!this._texLatIdx) {
            this._texLatIdx = new Uint8Array(BAKE_W * BAKE_H);
            this._texLon = new Float32Array(BAKE_W);
            for (let x = 0; x < BAKE_W; x++) {
                this._texLon[x] = -180 + (x + 0.5) * (360 / BAKE_W);
            }
            for (let y = 0; y < BAKE_H; y++) {
                const lat = 90 - (y + 0.5) * (180 / BAKE_H);
                for (let x = 0; x < BAKE_W; x++) {
                    const maglat = magLatDeg(lat, this._texLon[x]);
                    this._texLatIdx[y * BAKE_W + x] =
                        Math.max(0, Math.min(N_LAT - 1, Math.floor((maglat + 90) / 5)));
                }
            }
        }
        for (let x = 0; x < BAKE_W; x++) {
            const mltIdx = Math.floor((((utH + this._texLon[x] / 15) % 24) + 24) % 24);
            for (let y = 0; y < BAKE_H; y++) {
                const t = y * BAKE_W + x;
                const s = this.state[this._texLatIdx[t] * N_MLT + mltIdx];
                const o = t * 4, p = s * 4;
                out[o] = PAL[p]; out[o + 1] = PAL[p + 1];
                out[o + 2] = PAL[p + 2]; out[o + 3] = PAL[p + 3];
            }
        }
        return out;
    }
}
