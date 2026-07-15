/**
 * topo-bump-clamp.mjs — regression guard for the terrain "goes black on zoom" bug
 * ═══════════════════════════════════════════════════════════════════════════════
 * The Earth surface shader (js/earth-skin.js EARTH_FRAG) perturbs the surface
 * normal by the height-map gradient with a fixed 85× gain that is tuned for the
 * GLOBAL height map's tiny per-texel deltas. When the camera zooms past 25° the
 * high-res GIBS shaded-relief inset switches on and topoGradient() feeds much
 * larger deltas. Before the fix those deltas (clamped only to ±0.25) times the
 * 85× gain pushed the tangential displacement to ~18× the unit normal, so
 * normalize() rotated the normal clear into the tangent plane — flipping it away
 * from the sun. NdotL went negative, dayMix and `lit` collapsed to their dark
 * floor, and the terrain blacked out exactly when the user zoomed in.
 *
 * The fix bounds the tangential displacement length to SLOPE_MAX before
 * normalize(), guaranteeing the normal stays on the sunlit side (crisp hillshade
 * instead of a black-out), while leaving the global-magnitude path untouched.
 *
 * This test replicates the shader's normal math in JS (the render output is a
 * deterministic function of it) and asserts:
 *   1. a detail-magnitude gradient blacks out WITHOUT the cap, stays lit WITH it
 *   2. a global-magnitude gradient is byte-for-byte unchanged by the cap
 *   3. relief is preserved: a sun-facing slope stays brighter than an away slope
 *
 * Run: node tests/topo-bump-clamp.mjs
 */

// ── Shader constants (must mirror js/earth-skin.js EARTH_FRAG) ──────────────
const GAIN      = 85.0;   // normal-perturbation gain
const BUMP      = 0.85;   // u_bump_strength default
const SLOPE_MAX = 1.5;    // the cap added by the fix
const OLD_CLAMP = 0.25;   // pre-fix detail-gradient clamp (the bug)
const NEW_CLAMP = 0.06;   // post-fix detail-gradient clamp

// ── GLSL-equivalent helpers ────────────────────────────────────────────────
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const scale = (a, s) => [a[0]*s, a[1]*s, a[2]*s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
const cross = (a, b) => [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
];
function smoothstep(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
}

// Reproduce main()'s normal perturbation + the lighting terms that drive
// brightness. `cap` toggles the fix.
function shade({ nBase, sunDir, hDx, hDy, cap }) {
    const up = [0, 1, 0];
    const tEast  = norm(cross(up, nBase));
    const tNorth = norm(cross(nBase, tEast));
    const landMsk = 1.0 * BUMP;                     // land pixel: (1 - ocean) * bump
    let slope = scale(
        [tEast[0]*hDx + tNorth[0]*hDy,
         tEast[1]*hDx + tNorth[1]*hDy,
         tEast[2]*hDx + tNorth[2]*hDy],
        GAIN * landMsk,
    );
    if (cap) {
        const sl = len(slope);
        if (sl > SLOPE_MAX) slope = scale(slope, SLOPE_MAX / sl);
    }
    const N = norm(sub(nBase, slope));
    const NdotL  = dot(N, sunDir);
    const dayMix = smoothstep(-0.10, 0.20, NdotL);
    const lit    = 0.35 * (1 - dayMix) + clamp(NdotL * 0.5 + 0.5, 0, 1) * dayMix;
    return { N, NdotL, dayMix, lit };
}

let checks = 0;
function assert(cond, msg) {
    checks++;
    if (!cond) { console.error(`  ✗ ${msg}`); process.exitCode = 1; return false; }
    console.log(`  ✓ ${msg}`);
    return true;
}

// Geometry: a well-lit day pixel (normal nearly at the sub-solar point), with a
// detail-inset slope that pushes the normal AWAY from the sun — the worst case.
const nBase  = [0, 0, 1];
const sunDir = norm([0.2, 0, 1]);   // high sun, NdotL_base ≈ 0.98 (bright daylight)

// ── 1. The bug + the fix ────────────────────────────────────────────────────
// Historical clamp (±0.25): without the cap the terrain blacks out.
const bugOld = shade({ nBase, sunDir, hDx: OLD_CLAMP, hDy: 0, cap: false });
const bugNew = shade({ nBase, sunDir, hDx: OLD_CLAMP, hDy: 0, cap: true });
assert(bugOld.dayMix < 0.01 && bugOld.lit <= 0.36,
    `uncapped detail slope blacks out (dayMix=${bugOld.dayMix.toFixed(3)}, lit=${bugOld.lit.toFixed(3)})`);
assert(bugNew.dayMix > 0.9 && bugNew.lit > 0.6,
    `capped detail slope stays lit (dayMix=${bugNew.dayMix.toFixed(3)}, lit=${bugNew.lit.toFixed(3)})`);

// Even at the new, tighter clamp (±0.06) the uncapped push still collapses —
// proving the CAP, not just the clamp, is what fixes it.
const tightOld = shade({ nBase, sunDir, hDx: NEW_CLAMP, hDy: 0, cap: false });
const tightNew = shade({ nBase, sunDir, hDx: NEW_CLAMP, hDy: 0, cap: true });
assert(tightOld.dayMix < tightNew.dayMix - 0.3,
    `cap is load-bearing even at the tight clamp (uncapped dayMix=${tightOld.dayMix.toFixed(3)} < capped ${tightNew.dayMix.toFixed(3)})`);

// ── 2. Global-magnitude gradient is untouched by the cap ────────────────────
// Global per-texel deltas are ~0.008; slope ≈ 0.008·85·0.85 ≈ 0.58 < SLOPE_MAX,
// so the cap must not engage and the perturbed normal must be identical.
const gGrad = 0.008;
const gOld = shade({ nBase, sunDir, hDx: gGrad, hDy: -gGrad, cap: false });
const gNew = shade({ nBase, sunDir, hDx: gGrad, hDy: -gGrad, cap: true });
const dN = len(sub(gOld.N, gNew.N));
assert(dN < 1e-9, `global-magnitude relief unchanged by cap (|ΔN|=${dN.toExponential(1)})`);

// ── 3. Relief is preserved, not flattened ───────────────────────────────────
// With the cap on, a slope tilting toward the sun must read brighter than one
// tilting away — the whole point of hillshade. (Sun is on the +x side, so a
// -hDx slope tilts the normal toward +x / sunward.)
const facing = shade({ nBase, sunDir, hDx: -NEW_CLAMP, hDy: 0, cap: true });
const away   = shade({ nBase, sunDir, hDx:  NEW_CLAMP, hDy: 0, cap: true });
assert(facing.lit > away.lit + 0.05,
    `hillshade preserved: sun-facing slope brighter than away slope (${facing.lit.toFixed(3)} > ${away.lit.toFixed(3)})`);

if (process.exitCode) {
    console.error('\ntopo-bump-clamp: FAILED');
} else {
    console.log(`\ntopo-bump-clamp: ${checks} checks passed`);
}
