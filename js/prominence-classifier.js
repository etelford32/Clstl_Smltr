// js/prominence-classifier.js
//
// Phase 2.2 prominence classifier.
//
// Walks the field-line atlas + live AR & flare feeds and assigns one of
// seven classes (QP, IP, ARP, HEDGEROW, TORNADO, EP, RAIN) to every
// PIL-anchored closed loop. Returns a list of bundle descriptors that the
// bundle renderer (prominence-bundle.js) consumes to populate instance
// attributes.
//
// Decision tree (first match wins):
//   1. EP        — AR is currently flaring (or in an active EP state machine)
//   2. TORNADO   — |twist| > critical (≥ ~0.8 turn) — clamped per WASM measure
//   3. HEDGEROW  — apex / length ratio > vertical threshold
//   4. ARP       — strong AR (β-γ or higher complexity)
//   5. IP        — weak AR (α/β) at any latitude OR mid-lat with no AR
//   6. QP        — no AR, |lat| ≥ 35° (the polar/high-lat filament belt)
//
// State-machine continuity for EP:
//   idle → destabilizing (4 s) → erupting (8 s, bundle radius grows) → fade (4 s)
//
// State is cached per bundle (keyed by AR num + line index) so transitions
// persist across atlas updates as long as the underlying line is stable.

import { CLASS } from './prominence-bundle.js';

// ─── tunables ──────────────────────────────────────────────────────
const META_STRIDE = 8;

const TORNADO_TWIST_RAD       = 5.5;   // ~0.88 turn — refined as field model gains helicity
const HEDGEROW_APEX_LEN_RATIO = 0.45;  // tall-narrow loops register as wall-class
const QP_LATITUDE_DEG         = 35.0;  // the filament belt boundary

const EP_DESTAB_DURATION = 4.0;        // sec, sim-time
const EP_ERUPT_DURATION  = 8.0;
const EP_FADE_DURATION   = 4.0;
const EP_TOTAL           = EP_DESTAB_DURATION + EP_ERUPT_DURATION + EP_FADE_DURATION;

const EP_FLARE_INTENSITY_GATE = 0.25;  // u_flare_intensity above this = flare in progress
const EP_FLARE_RADIUS_RAD     = 25 * Math.PI / 180; // AR within ~25° of flare = EP candidate

// Per-class weight multipliers (scale base apex×length weight before allocating threads)
const CLASS_WEIGHT = Object.freeze({
    [CLASS.QP]:       1.00,
    [CLASS.IP]:       0.95,
    [CLASS.ARP]:      0.85,  // smaller bundle, more visual impact per thread
    [CLASS.HEDGEROW]: 1.30,  // many threads needed for the curtain look
    [CLASS.TORNADO]:  1.15,
    [CLASS.EP]:       1.50,  // dramatic — give it threads
    [CLASS.RAIN]:     1.20,
});

// ─── state cache ───────────────────────────────────────────────────
const _state = new Map();    // key → { classId, stateEnter, lastSeen }

function _bundleKey(arNum, lineIdx) { return arNum + ':' + lineIdx; }

/**
 * Classify all PIL-anchored bundles in the atlas.
 *
 * @param {object} input
 * @param {object} input.atlas         — { lineCount, samplesPerLine, meta, ... }
 * @param {Array}  input.liveRegions   — sun.html liveRegions array
 * @param {number} input.time          — sim-time clock (seconds, monotonic-ish)
 * @param {number} [input.flareIntensity=0]   — current u_flare_intensity uniform
 * @param {number} [input.flareLatRad=NaN]    — flare site latitude (radians)
 * @param {number} [input.flareLonRad=NaN]    — flare site longitude (radians)
 *
 * @returns {Array<{
 *   lineIdx: number,
 *   classId: number,
 *   weight:  number,        // budget allocation weight (already class-scaled)
 *   params:  Float32Array,  // length 4 — vec4 instance attribute
 *   stateAge: number        // sec since this bundle entered its current class
 * }>}
 *
 * params semantics by class:
 *   QP          → [0, 0, 0, 0]
 *   IP          → [0, 0, 0, 0]
 *   ARP         → [twistRad, 0, 0, 0]    moderate helical winding
 *   HEDGEROW    → [verticality 0..1, 0, 0, 0]   blends bundle frame toward radial
 *   TORNADO     → [turns, 0, 0, 0]              full helical revolutions over the line
 *   EP          → [age, stage, radiusScale, fadeAlpha]   stage: 0 destab, 1 erupt, 2 fade
 *   RAIN        → [coolingT 0..1, flowSpeed, 0, 0]       Phase 3
 */
export function classifyBundles({
    atlas, liveRegions, time,
    flareIntensity = 0, flareLatRad = NaN, flareLonRad = NaN,
}) {
    const bundles = [];
    if (!atlas || atlas.lineCount === 0) return bundles;

    const meta = atlas.meta;
    const arsByIndex = liveRegions || [];

    // Which AR (if any) is currently the flare host?
    const flareArIndex = _findFlareAr(arsByIndex, flareIntensity, flareLatRad, flareLonRad);

    for (let i = 0; i < atlas.lineCount; i++) {
        const m0 = i * META_STRIDE;
        const topology = meta[m0];
        const seedKind = meta[m0 + 1];
        if (topology !== 0 || seedKind !== 2) continue;  // PIL-closed only

        const arIndex   = meta[m0 + 2] | 0;
        const apex      = meta[m0 + 3];
        const length    = meta[m0 + 4];
        const footALat  = meta[m0 + 5];
        const twist     = meta[m0 + 7];

        const arNum   = (arIndex >= 0 && arsByIndex[arIndex]) ? String(arsByIndex[arIndex].num || arIndex) : '-';
        const key     = _bundleKey(arNum, i);
        let s = _state.get(key);
        if (!s) {
            s = { classId: -1, stateEnter: time, lastSeen: time };
            _state.set(key, s);
        }
        s.lastSeen = time;

        const arData = arIndex >= 0 ? arsByIndex[arIndex] : null;
        const complexity = arData ? _complexityFromMag(arData.mag) : 0;

        // ── Class decision ────────────────────────────────────────────
        let classId;
        const params = [0, 0, 0, 0];

        // 1. EP: trigger or already mid-eruption
        const isFlareHost = (arIndex >= 0 && arIndex === flareArIndex);
        const wasErupting = (s.classId === CLASS.EP && (time - s.stateEnter) < EP_TOTAL);
        if (isFlareHost || wasErupting) {
            classId = CLASS.EP;
            if (s.classId !== CLASS.EP) {
                // freshly entering EP
                s.stateEnter = time;
                s.classId = CLASS.EP;
            }
            const a = time - s.stateEnter;
            let stage, scale, fade;
            if (a < EP_DESTAB_DURATION) {
                stage = 0; scale = 1.0;            fade = 1.0;
            } else if (a < EP_DESTAB_DURATION + EP_ERUPT_DURATION) {
                const e = (a - EP_DESTAB_DURATION) / EP_ERUPT_DURATION;
                stage = 1; scale = 1.0 + 3.0 * e;  fade = 1.0 - 0.35 * e;
            } else {
                const f = Math.min(1.0, (a - EP_DESTAB_DURATION - EP_ERUPT_DURATION) / EP_FADE_DURATION);
                stage = 2; scale = 4.0 + 4.0 * f;  fade = (1.0 - f) * 0.65;
            }
            params[0] = a; params[1] = stage; params[2] = scale; params[3] = fade;
        }
        // 2. TORNADO
        else if (Math.abs(twist) > TORNADO_TWIST_RAD) {
            classId = CLASS.TORNADO;
            params[0] = twist / (2 * Math.PI);   // turns (signed)
        }
        // 3. HEDGEROW
        else if (length > 1e-4 && (apex / length) > HEDGEROW_APEX_LEN_RATIO) {
            classId = CLASS.HEDGEROW;
            const verticality = _clamp((apex / length - HEDGEROW_APEX_LEN_RATIO) /
                                       (1.0 - HEDGEROW_APEX_LEN_RATIO), 0, 1);
            params[0] = verticality;
        }
        // 4. ARP — strong AR
        else if (arData && complexity >= 2) {
            classId = CLASS.ARP;
            params[0] = Math.PI / 5;   // ~36° per arclength of mild twist
        }
        // 5. IP — weak/intermediate AR or mid-lat
        else if (arData) {
            classId = CLASS.IP;
        }
        // 6. QP — high-lat background
        else {
            const latAbsDeg = Math.abs(footALat || 0) * 180 / Math.PI;
            classId = (latAbsDeg >= QP_LATITUDE_DEG) ? CLASS.QP : CLASS.IP;
        }

        // Track class transitions → reset state timer
        if (s.classId !== classId) {
            s.stateEnter = time;
            s.classId = classId;
        }

        // ── Weight ────────────────────────────────────────────────────
        const baseWeight = _clamp(apex / 0.05, 0, 1) * _clamp(length / 0.30, 0, 1);
        const classMul   = CLASS_WEIGHT[classId] ?? 1.0;
        // Tiny floor so even trivial PILs get represented (per the
        // "normalize and clamp, don't cull" design).
        const weight = Math.max(0.04, baseWeight) * classMul;

        bundles.push({
            lineIdx: i,
            classId,
            weight,
            params: Float32Array.from(params),
            stateAge: time - s.stateEnter,
            arIndex,
        });
    }

    // ── GC stale state entries (line dropped from atlas) ──────────────
    if (_state.size > 256) {
        for (const [k, v] of _state.entries()) {
            if (time - v.lastSeen > 30) _state.delete(k);
        }
    }

    return bundles;
}

/** Reset all classifier state. Call when the AR list is wholesale-replaced. */
export function resetClassifierState() { _state.clear(); }

// ─── helpers ────────────────────────────────────────────────────────

function _complexityFromMag(mag) {
    const m = String(mag || '').toLowerCase();
    if (m.includes('delta') || m.includes('β-γ-δ') || m.includes('beta-gamma-delta') || m.includes('bgd')) return 3;
    if (m.includes('gamma') || m.includes('β-γ')   || m.includes('beta-gamma')      || m.includes('bg'))  return 2;
    if (m === 'a' || m.includes('alpha') || m.includes('α')) return 0;
    return 1;
}

/** Find the AR closest to the flare site (if a flare is currently in progress). */
function _findFlareAr(liveRegions, flareIntensity, flareLatRad, flareLonRad) {
    if (flareIntensity < EP_FLARE_INTENSITY_GATE) return -1;
    if (!Number.isFinite(flareLatRad) || !Number.isFinite(flareLonRad)) return -1;
    if (!liveRegions || !liveRegions.length) return -1;

    let best = -1;
    let bestDist = EP_FLARE_RADIUS_RAD;
    for (let i = 0; i < liveRegions.length; i++) {
        const r = liveRegions[i];
        const ll = _parseLocSafe(r.loc);
        if (!ll) continue;
        const lat = ll.lat * Math.PI / 180;
        const lon = ll.lon * Math.PI / 180;
        const d = _angSep(flareLatRad, flareLonRad, lat, lon);
        if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
}

function _parseLocSafe(s) {
    const m = (s || '').trim().match(/^([NS])(\d+)([EW])(\d+)$/i);
    if (!m) return null;
    return {
        lat: (m[1].toUpperCase() === 'N' ?  1 : -1) * +m[2],
        lon: (m[3].toUpperCase() === 'W' ?  1 : -1) * +m[4],
    };
}

function _angSep(lat1, lon1, lat2, lon2) {
    const c = Math.sin(lat1) * Math.sin(lat2) +
              Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon1 - lon2);
    return Math.acos(_clamp(c, -1, 1));
}

function _clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
