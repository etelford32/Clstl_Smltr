/**
 * cloud-volume.js — volumetric cloud renderer for earth.html
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A single-pass raymarch through the troposphere shell, replacing the three
 * alpha-blended noise DECALS in earth-skin.js's CLOUD_FRAG at the top
 * governor tier. Same data, given real vertical extent.
 *
 * WHAT THIS FIXES
 * ───────────────
 * The decal shader had hit its ceiling. Three shells of FBM alpha stacked
 * over a lit sphere can produce a coverage map, but it cannot produce a
 * cloud: there is no depth to integrate through, so there are no dark bases,
 * no bright tops, no shafts, no limb puff, and every fragment resolves to
 * roughly the same mid-grey. That is the "grey soup" the layered
 * compositing, the mass-clumping S-curve and the relief-bump pass were each
 * trying to fake, and it is why the globe read as smeared rather than
 * cloudy. Integrating along the view ray gets all of it for free, because
 * all of it is the same phenomenon: light attenuating through a medium.
 *
 * WHAT IT DOES NOT CHANGE
 * ───────────────────────
 * The DATA. Coverage still comes from the Open-Meteo low/mid/high channels
 * and the satellite mosaic exactly as CLOUD_FRAG consumed them, including
 * the Phase-2.5 IR deck routing. The march decides where the mass SITS in
 * the column and how light moves through it; it never invents coverage.
 * Research / measured-only mode does NOT use this path at all (see the
 * routing note below) — a volumetric render implies vertical structure the
 * measured fields did not supply.
 *
 * THE IR TOP IS THE VOLUME'S TOP
 * ──────────────────────────────
 * The mosaic's B channel is an IR brightness-temperature proxy; decoded
 * against 2 m temperature and a 6.5 K/km lapse it is an OBSERVED cloud-top
 * height. The decal shader could only use it to pick which of three flat
 * shells to paint. Here it sets the actual top of the marched column, so a
 * measured 13 km overshoot renders as a tower that is 13 km tall. Where no
 * IR disc saw the pixel the column falls back to the model's nominal deck
 * extents — procedural-fill regions grow no fake towers.
 *
 * GEOMETRY / COVERAGE
 * ───────────────────
 * The carrier mesh is a unit sphere scaled just past the volume top, drawn
 * `side: BackSide, depthTest: false`. BackSide is what makes the same
 * material work from OUTSIDE the volume (back faces cover exactly the
 * shell's silhouette) and from INSIDE it (back faces surround you) — which
 * the altitude ramp needs, because the camera is allowed to descend into
 * the stack. depthTest is off because the march establishes its own
 * occlusion: it clips at the planet sphere analytically, so the ground
 * hides cloud correctly without the depth buffer, and a fragment whose ray
 * misses the shell early-outs before any march cost.
 *
 * The march runs in WORLD space (concentric spheres are rotation-invariant,
 * so intersections need no frame change) and only the SAMPLE DIRECTION is
 * rotated into the Earth-fixed frame by `u_earth_rot`. Do not re-add a
 * per-vertex object-space transform for this — `inverse()` is GLSL3-only
 * and the mesh must stay un-rotated for the scale-tracking to be one line.
 *
 * PLANET SHADOW IS REAL HERE
 * ──────────────────────────
 * The light march tests the sun ray against the planet sphere, so the
 * terminator, the long shadow-side falloff and the reddening all fall out
 * of geometry instead of the decal shader's hand-tuned NdotL biases and
 * per-deck `u_shell_lift` constants. That is why those uniforms have no
 * analogue here.
 *
 * COST + ROUTING
 * ──────────────
 * This is fragment-bound and expensive. It is gated exactly like the split
 * shells: top governor tier only, research mode off. Every other state —
 * including the whole software-GL path CI runs on, which is why
 * tests/earth-smoke.spec.js's ≥25 fps gate still holds — falls back to the
 * composite CLOUD_FRAG shell. Both paths stay live and neither is dead
 * code. Step counts come from `marchLadder()` so the ladder is data, not
 * scattered magic numbers.
 *
 * Altitudes, radii and the exaggeration factor all come from
 * js/atmo-scale.js. This module owns no geometry constants of its own.
 */

import * as THREE from 'three';
import { GEO_GLSL } from './geo/coords.glsl.js';
import {
    R_EARTH_KM, DECK_ALTITUDE_KM, VOLUME_TOP_KM, VOLUME_BASE_KM,
    SURFACE_CLEARANCE_R,
} from './atmo-scale.js';

/**
 * Primary / light march step budget per quality tier. Mirrors the tiering of
 * CLOUD_FRAG's `u_quality` so a governor step changes both shaders' cost in
 * the same direction. The volumetric path only ever runs at the top tier, so
 * the lower rungs exist for the URL override (`?cloud_quality=`) and for a
 * future mid-tier volumetric mode — they are not reachable by the governor
 * on its own.
 */
export function marchLadder(quality) {
    if (quality > 0.83) return { primary: 48, light: 6 };
    if (quality > 0.45) return { primary: 28, light: 4 };
    return { primary: 16, light: 3 };
}

/** Hard ceilings the GLSL loops are compiled with (GLSL ES 1.00 needs
 *  constant bounds; the uniforms break out early below these). */
const MAX_PRIMARY_STEPS = 64;
const MAX_LIGHT_STEPS   = 8;

export const VOLUME_VERT = /* glsl */`
varying vec3 vWorldPos;
void main() {
    vWorldPos   = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const VOLUME_FRAG = /* glsl */`
precision highp float;

${GEO_GLSL}

varying vec3 vWorldPos;

uniform sampler2D u_cloud_layers;   // R=low G=mid B=high A=precip  [0-1]
uniform sampler2D u_satellite;      // R=cover  B=IR top proxy  A=confidence
uniform sampler2D u_weather;        // R=temp (t2m, normalised)

uniform vec3  u_sun_dir;            // world space, unit
uniform float u_earth_rot;          // planet spin, radians (world → Earth-fixed)
uniform float u_time;               // animation SECONDS (clock.getElapsedTime)
uniform float u_exag;               // vertical exaggeration (atmo-scale)
uniform float u_r_base;             // volume inner radius, world units
uniform float u_r_top;              // volume outer radius, world units
uniform float u_r_surface;          // planet sphere, for shadow + clipping
uniform float u_satellite_on;
uniform float u_cloud_data_strength;
uniform float u_density;            // global optical-depth scale (tuning knob)
uniform int   u_steps;              // primary march steps
uniform int   u_light_steps;        // light march steps

const float R_EARTH_KM_C   = ${R_EARTH_KM.toFixed(1)};
const float R_CLEAR_C      = ${SURFACE_CLEARANCE_R.toFixed(6)};
const float VOL_TOP_KM     = ${VOLUME_TOP_KM.toFixed(2)};
const float VOL_BASE_KM    = ${VOLUME_BASE_KM.toFixed(3)};
const float LOW_BASE_KM    = ${DECK_ALTITUDE_KM.low.base.toFixed(2)};
const float LOW_TOP_KM     = ${DECK_ALTITUDE_KM.low.top.toFixed(2)};
const float MID_BASE_KM    = ${DECK_ALTITUDE_KM.mid.base.toFixed(2)};
const float MID_TOP_KM     = ${DECK_ALTITUDE_KM.mid.top.toFixed(2)};
const float HIGH_BASE_KM   = ${DECK_ALTITUDE_KM.high.base.toFixed(2)};
const float HIGH_TOP_KM    = ${DECK_ALTITUDE_KM.high.top.toFixed(2)};

// ── Noise ────────────────────────────────────────────────────────────────────
// Same hash/value-noise construction as CLOUD_FRAG so the two paths share a
// visual family — a governor flip between them must not look like a different
// planet's weather.
float hash31(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

float vnoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(i);
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
    float x00 = mix(n000, n100, f.x);
    float x10 = mix(n010, n110, f.x);
    float x01 = mix(n001, n101, f.x);
    float x11 = mix(n011, n111, f.x);
    return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

// NORMALISED to [0,1] — divide by the amplitude actually summed, not by a
// constant. The coverage remap in densityAt() thresholds against (1 - cover),
// so it assumes its input spans the unit interval. An un-normalised 3-octave
// sum tops out at 0.875 and averages ~0.44, which silently made every cell
// with less than ~55% cover render as clear sky: the globe came back almost
// cloudless and it read as "the data isn't arriving" rather than as a
// one-line scaling bug. Keep the division.
float fbm3(vec3 p, int octaves) {
    float v = 0.0, a = 0.5, f = 1.0, norm = 0.0;
    for (int i = 0; i < 5; i++) {
        if (i >= octaves) break;
        v += a * vnoise3(p * f);
        norm += a;
        f *= 2.17;      // non-integer lacunarity: keeps octaves from
        a *= 0.5;       // re-aligning into visible lattice grids
    }
    return v / max(norm, 1e-5);
}

vec3 rotateY(vec3 p, float a) {
    float c = cos(a), s = sin(a);
    return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}

// ── Ray/sphere ───────────────────────────────────────────────────────────────
// Origin-centred sphere of radius R. Returns (tNear, tFar); tFar < 0 or
// tFar < tNear means "no useful hit". Kept branch-free — it is called up to
// four times per fragment before any march decision is made.
vec2 raySphere(vec3 ro, vec3 rd, float R) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - R * R;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
}

// Real altitude (km) at a world radius, undoing the exaggeration. Every
// physical decision below is made in KILOMETRES, never in globe radii, so
// the ramp can move the geometry without changing a single cloud's shape.
float altitudeKm(float r) {
    return (r - R_CLEAR_C) * R_EARTH_KM_C / max(u_exag, 0.0001);
}

// Soft vertical membership of a deck [base, top]: 1 through the middle,
// easing out over the outer 35% so decks blend instead of stacking as slabs.
float deckProfile(float altKm, float base, float top) {
    // NB: 'half' is a GLSL reserved word — do not shorten halfSpan back to it.
    float mid     = 0.5 * (base + top);
    float halfSpan = max(0.5 * (top - base), 0.001);
    float d       = abs(altKm - mid) / halfSpan;
    return 1.0 - smoothstep(0.65, 1.0, d);
}

// ── Column properties ────────────────────────────────────────────────────────
// Everything that depends only on WHERE ON THE GLOBE the sample is (not how
// high). Sampled per march step, but all taps are on smoothly-upsampled
// coarse fields so the cost is texture bandwidth, not detail.
struct Column {
    float covLow;
    float covMid;
    float covHigh;
    float precip;
    float topKm;      // observed cloud-top height, < 0 when no IR estimate
    float conf;       // satellite observation confidence
};

Column columnAt(vec2 uv) {
    Column c;
    vec4 cl   = texture2D(u_cloud_layers, uv);
    float g   = clamp(u_cloud_data_strength * 2.0, 0.0, 1.0);
    // Data-GATED coverage, lockstep with CLOUD_FRAG: a clear grid cell must
    // read as clear. A base floor here is what made the old globe
    // permanently half-overcast.
    c.covLow  = mix(0.55, mix(0.02, 1.00, cl.r), g);
    c.covMid  = mix(0.40, mix(0.02, 0.95, cl.g), g);
    c.covHigh = mix(0.30, mix(0.01, 0.90, cl.b), g);
    c.precip  = cl.a;
    c.topKm   = -1.0;
    c.conf    = 0.0;

    if (u_satellite_on > 0.5) {
        vec4 sat = texture2D(u_satellite, uv);
        c.conf   = sat.a;
        float satShape = smoothstep(0.14, 0.86, sat.r);
        // The mosaic is the dominant coverage signal where it actually saw
        // the pixel; the feathered alpha keeps the handoff a gradient.
        float infl = sat.a * 0.85;
        c.covLow  = mix(c.covLow,  satShape,        infl);
        c.covMid  = mix(c.covMid,  satShape * 0.85, infl * 0.8);
        c.covHigh = mix(c.covHigh, satShape * 0.70, infl * 0.7);

        // IR cloud-top height → the column's real top. Keep the
        // 26.85 − b·105 ramp in lockstep with IR_BT_WARM_K / IR_BT_COLD_K
        // in cloud-mosaic-core.js and with CLOUD_FRAG's copy.
        if (sat.b > 0.02) {
            float t2mC = texture2D(u_weather, uv).r * 110.0 - 60.0;
            float btC  = 26.85 - sat.b * 105.0;
            c.topKm    = clamp((t2mC - btC) / 6.5, 0.0, 17.0);
        }
    }
    return c;
}

// ── Density ──────────────────────────────────────────────────────────────────
// The 'cheap' flag skips the detail octaves — used by the light march and by the
// empty-space skip, where only "is there anything here" matters. This split
// is the difference between ~48 and ~300 noise evaluations per pixel.
float densityAt(vec3 pWorld, Column col, bool cheap) {
    float r     = length(pWorld);
    float altKm = altitudeKm(r);
    if (altKm < VOL_BASE_KM || altKm > VOL_TOP_KM) return 0.0;

    // Vertical coverage: each deck contributes over its own extent.
    float pLow  = deckProfile(altKm, LOW_BASE_KM,  LOW_TOP_KM);
    float pMid  = deckProfile(altKm, MID_BASE_KM,  MID_TOP_KM);
    float pHigh = deckProfile(altKm, HIGH_BASE_KM, HIGH_TOP_KM);
    float cov   = col.covLow * pLow + col.covMid * pMid + col.covHigh * pHigh;

    // Deep convection: where rain is falling, bridge the gap between the low
    // and mid decks so a storm renders as ONE tower rather than two
    // disconnected sheets. This is the volumetric form of CLOUD_FRAG's
    // precip→cloud coupling, and it exists for the same reason: the decks
    // are separate channels but the storm is one object.
    float wet = smoothstep(0.02, 0.30, col.precip);
    if (wet > 0.0) {
        float bridge = deckProfile(altKm, LOW_BASE_KM, MID_TOP_KM);
        cov = max(cov, bridge * wet * 0.95);
    }

    // Observed top: hard-cap the column at the IR cloud-top height, and let
    // it BUILD up to that height. Confidence-weighted, so a feathered disc
    // edge relaxes back to the model's nominal decks instead of snapping.
    if (col.topKm > 0.0) {
        float capped = 1.0 - smoothstep(col.topKm - 0.9, col.topKm + 0.35, altKm);
        float tower  = smoothstep(LOW_BASE_KM, col.topKm, altKm) * 0.0 + 1.0;
        cov = mix(cov, cov * capped * tower, col.conf);
        // Tall observed tops thicken the column they belong to — this is the
        // anvil, and it is measured, not invented.
        float anvil = smoothstep(7.0, 13.0, col.topKm) * col.conf;
        cov += anvil * deckProfile(altKm, col.topKm - 3.0, col.topKm) * 0.35;
    }

    cov = clamp(cov, 0.0, 1.0);
    if (cov <= 0.001) return 0.0;

    // Within-deck vertical density gradient: thin at the base, dense toward
    // the top. This is what gives cumulus a flat dark bottom and a piled
    // bright crown instead of a symmetric blob.
    float hFrac = clamp((altKm - VOL_BASE_KM) / (VOL_TOP_KM - VOL_BASE_KM), 0.0, 1.0);
    float grad  = smoothstep(0.0, 0.09, hFrac) * (1.0 - smoothstep(0.55, 1.0, hFrac));
    // Cirrus is a veil, not a mass — flatten its gradient so it doesn't get a
    // cumulus crown.
    grad = mix(grad, 0.55, clamp(pHigh, 0.0, 1.0));

    // Sampling direction in the Earth-fixed frame. Noise rides the SPHERE,
    // never equirectangular UV — that is what keeps the poles free of the
    // UV-stretch smear the decal shader had to fix the same way.
    vec3 nObj = rotateY(pWorld / r, -u_earth_rot);
    // Slow drift, per altitude band: high cloud runs faster, as it does.
    float drift = u_time * 0.0026 * (1.0 + hFrac * 1.6);
    vec3  q     = nObj * 22.0 + vec3(0.0, 0.0, drift);
    // Vertical detail is sampled in REAL km so the noise cell shape is
    // physical — without this the exaggeration stretches every cloud
    // vertically as the ramp climbs, and the whole stack smears on zoom.
    q.y += altKm * 0.42;

    // DOMAIN WARP — not optional. Value noise on a cubic-interpolated lattice
    // leaves axis-aligned straight edges, and the coverage threshold below
    // turns those into hard rectangular blobs: the globe came back looking
    // tiled rather than cloudy. CLOUD_FRAG hit the same wall and fixed it the
    // same way (see its warpedFbm3 note about "horizontal strips"). One octave
    // per axis is enough to decorrelate the lattice and is a third the cost of
    // warping with full FBM.
    //
    // Applied on BOTH the cheap and detailed paths on purpose: the light march
    // uses the cheap one, and if the two disagree about where a cloud IS, the
    // self-shadowing lands next to the cloud casting it.
    vec3 warp = vec3(
        vnoise3(q * 0.55 + vec3( 17.3, -3.1,  0.0)),
        vnoise3(q * 0.55 + vec3( -9.6, 12.4,  5.2)),
        vnoise3(q * 0.55 + vec3(  4.2,  7.8, -8.1))
    ) - 0.5;
    q += warp * 1.35;

    float shape = fbm3(q, cheap ? 2 : 4);

    // Coverage-thresholded remap: as cov → 1 the threshold → 0 and the
    // column fills. Standard, and the reason clear cells read as truly clear.
    float d = clamp((shape - (1.0 - cov)) / max(cov, 0.001), 0.0, 1.0);
    d *= grad;
    // Hard cut on the bottom of the density range. Densities of a few
    // thousandths contribute nothing individually but accumulate over ~48
    // steps into a uniform grey veil across the whole globe — the same haze
    // the decal shader's base-coverage floor produced, arriving by a
    // different route. Clear air has to integrate to exactly zero.
    d = max(0.0, d - 0.035) * 1.036;

    if (!cheap && d > 0.0) {
        // Edge erosion: high-frequency detail bites into the boundary only,
        // which is where real clouds are wispy. Applying it everywhere just
        // lowers the mean density and brings back the haze.
        float det  = fbm3(q * 4.3 + vec3(11.7, 3.1, 0.0), 2);
        float edge = 1.0 - smoothstep(0.0, 0.30, d);
        d = clamp(d - det * edge * 0.42, 0.0, 1.0);
    }
    return d * u_density;
}

// ── Extinction scale ─────────────────────────────────────────────────────────
// Optical depth must be a property of the CLOUD, not of how far the
// exaggeration ramp has stretched the shell it is drawn in. Scaling by the
// shell thickness keeps a given density at a fixed optical depth as the ramp
// fans the column from 0.022 R out to 0.12 R — without this, zooming in
// silently thickens every cloud into a white wall.
//
// 55 is calibrated so a fully-covered deck reaches optical depth ~18 through
// a vertical column: solidly opaque, which is what overcast is.
float sigmaScale() {
    return u_density * 55.0 / max(u_r_top - u_r_base, 1e-5);
}

// ── Phase function ───────────────────────────────────────────────────────────
// Dual-lobe Henyey-Greenstein: a strong forward lobe (the silver lining when
// you look toward the sun) plus a weak back lobe (the glow when it is behind
// you). Normalised so that ISOTROPIC == 1 (the 4π cancels the 1/4π in hg),
// which is what makes the radiance below land in [0,1] without a fudge
// factor. 'ani' scales both lobes toward isotropic for the multiple-scattering
// orders.
float hg(float cosT, float g) {
    float g2 = g * g;
    float d  = 1.0 + g2 - 2.0 * g * cosT;
    return (1.0 - g2) / (12.566370614 * d * sqrt(max(d, 1e-4)));
}
float phaseTwoLobe(float cosT, float ani) {
    return mix(hg(cosT, 0.80 * ani), hg(cosT, -0.30 * ani), 0.28) * 12.566370614;
}

// Multiple-scattering approximation (the standard Wrenninge octave trick):
// approximate each successive scattering order with less extinction and a
// flatter phase, reusing the ONE light-march result. This is not a
// refinement — it is the difference between a cloud and a smudge. Single
// scattering alone is always far too dark, because almost every photon that
// reaches your eye from a real cloud has bounced many times; without these
// orders you get exactly the flat grey the decal shader was already stuck at.
vec3 msScatter(float lt, float cosT, vec3 sunCol) {
    vec3 sum = vec3(0.0);
    float att = 1.0;   // energy remaining in this order
    float ext = 1.0;   // extinction exponent
    float ani = 1.0;   // phase anisotropy
    for (int k = 0; k < 3; k++) {
        sum += att * sunCol * pow(max(lt, 1e-5), ext) * phaseTwoLobe(cosT, ani);
        att *= 0.52;
        ext *= 0.55;
        ani *= 0.60;
    }
    return sum;
}

// Planet shadow with a penumbra. A hard raySphere test gives a razor-sharp
// terminator, which is wrong twice over: the Sun is a 0.53 deg disc, not a
// point, and the atmosphere refracts and scatters light well past the
// geometric line. Both smear the shadow edge over roughly a hundred km.
//
// Cheaper than the intersection test it replaces: the shadow of an
// origin-centred sphere is a cylinder, so "am I in it" is one dot product
// (are we anti-sunward at all) plus one perpendicular distance.
float planetShadow(vec3 p) {
    float along = dot(p, u_sun_dir);
    if (along > 0.0) return 1.0;                 // sunward hemisphere
    float perp = length(p - u_sun_dir * along);
    return smoothstep(u_r_surface * 0.994, u_r_surface * 1.022, perp);
}

// Transmittance of sunlight arriving at p: planet shadow first (cheap), then
// a short march through the medium.
float lightTransmittance(vec3 p, Column col) {
    float shadow = planetShadow(p);
    if (shadow <= 0.001) return 0.0;

    vec2 hitTop = raySphere(p, u_sun_dir, u_r_top);
    float span  = max(hitTop.y, 0.0);
    if (span <= 0.0) return shadow;

    int   n  = u_light_steps;
    float dt = span / float(n);
    float tau = 0.0;
    float t   = dt * 0.5;
    for (int i = 0; i < ${MAX_LIGHT_STEPS}; i++) {
        if (i >= n) break;
        vec3 sp = p + u_sun_dir * t;
        // Cheap density: the light march only needs bulk opacity, and the
        // detail octaves cost more here than anywhere (n× per primary step).
        tau += densityAt(sp, col, true) * dt;
        // Geometric step growth — the far end of a light ray contributes
        // little and does not deserve uniform sampling.
        t  += dt;
        dt *= 1.35;
    }
    return exp(-tau * sigmaScale()) * shadow;
}

void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorldPos - cameraPosition);

    // ── Establish the march interval ────────────────────────────────────────
    vec2 hTop  = raySphere(ro, rd, u_r_top);
    if (hTop.y <= 0.0) discard;                 // ray never reaches the shell
    vec2 hBase = raySphere(ro, rd, u_r_base);
    vec2 hSurf = raySphere(ro, rd, u_r_surface);

    float tEnter = max(hTop.x, 0.0);            // 0 when the camera is inside
    float tExit  = hTop.y;

    // The planet is opaque: stop at the ground.
    if (hSurf.y > 0.0 && hSurf.x > 0.0) tExit = min(tExit, hSurf.x);
    // Below the volume base there is nothing to integrate; a ray that enters
    // the inner sphere and comes back out (a grazing chord) is handled by the
    // per-sample altitude test rather than by splitting the interval in two,
    // which would double the loop for a case that contributes almost nothing.
    if (hBase.x > 0.0 && hSurf.x <= 0.0) tExit = min(tExit, hBase.x);

    if (tExit <= tEnter) discard;

    int   n      = u_steps;
    float span   = tExit - tEnter;
    float dt     = span / float(n);

    // Blue-noise-ish jitter on the start offset. Without it a 48-step march
    // across a 0.02 R shell bands visibly into concentric rings; with it the
    // banding becomes per-pixel noise the bloom pass swallows.
    float jitter = hash31(vec3(gl_FragCoord.xy, fract(u_time * 137.0)));

    vec3  scattered    = vec3(0.0);
    float transmittance = 1.0;
    float t = tEnter + dt * jitter;

    float cosT  = dot(rd, u_sun_dir);
    float sigK  = sigmaScale();

    for (int i = 0; i < ${MAX_PRIMARY_STEPS}; i++) {
        if (i >= n || transmittance < 0.012) break;

        vec3  p    = ro + rd * t;
        float r    = length(p);
        vec3  nObj = rotateY(p / r, -u_earth_rot);
        Column col = columnAt(normalToUV(nObj));

        float d = densityAt(p, col, false);
        if (d > 0.002) {
            float sigma = d * sigK;
            float lt    = lightTransmittance(p, col);

            // Sun colour reddens through the long slant path near the
            // terminator — the same reason a real sunset is orange. Driven by
            // the local solar elevation, so it tracks the shadow line exactly.
            float sunEl = dot(p / r, u_sun_dir);
            vec3  sunCol = mix(vec3(1.00, 0.52, 0.24), vec3(1.00, 0.97, 0.93),
                               smoothstep(-0.02, 0.28, sunEl));

            // Powder / dark-edge term: an approximation of the multiple
            // scattering that makes cloud EDGES darker than their interiors
            // when lit from behind the viewer. Without it thin edges read as
            // uniformly bright and the whole field flattens.
            float powder = 1.0 - exp(-d * 14.0);
            powder = mix(1.0, powder, clamp(cosT * 0.5 + 0.5, 0.0, 1.0));

            // Sky ambient: bright from above, dim and blue from below, so
            // undersides fill with sky rather than going black.
            float up  = clamp(altitudeKm(r) / VOL_TOP_KM, 0.0, 1.0);
            vec3 ambient = mix(vec3(0.13, 0.17, 0.26), vec3(0.42, 0.50, 0.64), up);
            // Ambient must also die on the night side or the dark hemisphere
            // glows with daylight sky — but NOT to zero. A night cloud is a
            // dim blue silhouette (moonlight, airglow, and city light from
            // underneath), not a hole in the planet: at floor 0 the whole
            // dark hemisphere rendered as a black cut-out wherever it was
            // overcast, which reads as a rendering failure rather than as
            // night. The floor is deliberately low enough that the terminator
            // still reads as a terminator.
            ambient *= clamp(sunEl * 1.6 + 0.36, 0.11, 1.0);

            vec3 S = msScatter(lt, cosT, sunCol) * powder + ambient;

            // Energy-conserving integration of a constant-density step:
            // ∫ S·T dt over the step, in closed form. Summing S·T·dt instead
            // makes the result step-count dependent, so a governor tier flip
            // would visibly change cloud brightness.
            float Tstep = exp(-sigma * dt);
            scattered += transmittance * S * (1.0 - Tstep);
            transmittance *= Tstep;
        }
        t += dt;
    }

    float alpha = clamp(1.0 - transmittance, 0.0, 1.0);
    if (alpha < 0.002) discard;
    // 'scattered' is already transmittance-weighted along the ray, i.e. it is
    // PREMULTIPLIED radiance. The material blends with (ONE,
    // ONE_MINUS_SRC_ALPHA) for exactly this reason — standard
    // (SRC_ALPHA, ONE_MINUS_SRC_ALPHA) would multiply by alpha a second time
    // and halve every cloud's brightness.
    gl_FragColor = vec4(scattered, alpha);
}`;

/**
 * Uniform block. Shares the SAME uniform entry objects as the decal shader
 * for every input both consume (`Object.assign` in earth.html copies the
 * references), so one `cloudU.u_x.value = …` write still reaches both paths
 * and the fallback can never render stale data.
 */
export function createVolumeUniforms(sunDir = new THREE.Vector3(1, 0, 0)) {
    const ladder = marchLadder(1);
    return {
        u_cloud_layers: { value: null },
        u_satellite:    { value: null },
        u_weather:      { value: null },
        u_sun_dir:      { value: sunDir },
        u_earth_rot:    { value: 0 },
        u_time:         { value: 0 },
        u_exag:         { value: 10 },
        u_r_base:       { value: 1.0031 },
        u_r_top:        { value: 1.025 },
        u_r_surface:    { value: 1.0 },
        u_satellite_on: { value: 0 },
        u_cloud_data_strength: { value: 0.5 },
        // Optical-depth scale. Tuned so a fully-covered low deck reads as
        // solid overcast without the limb going to a white wall; exposed as a
        // knob because it is the one number that trades "dramatic" against
        // "washed out" and it will want retuning against real mosaics.
        u_density:      { value: 1.0 },
        u_steps:        { value: ladder.primary },
        u_light_steps:  { value: ladder.light },
    };
}

/**
 * Build the carrier mesh. Radius-1 sphere: the caller scales it to track the
 * volume top as the exaggeration ramp moves (one `setScalar` per frame),
 * which is why nothing here bakes a radius into the geometry.
 */
export function createVolumeMesh(uniforms) {
    const geo = new THREE.IcosahedronGeometry(1, 4);
    const mat = new THREE.ShaderMaterial({
        vertexShader: VOLUME_VERT,
        fragmentShader: VOLUME_FRAG,
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: false,       // the march owns its own occlusion — see header
        side: THREE.BackSide,   // works from outside AND inside the volume
        // PREMULTIPLIED alpha: the march returns radiance already weighted by
        // transmittance. Do not "simplify" this back to NormalBlending — that
        // applies alpha twice and the clouds come out half-lit and grey.
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;   // the camera can sit inside it
    return mesh;
}
