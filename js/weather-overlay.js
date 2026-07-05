/**
 * weather-overlay.js — derived-channel overlays on the weather DataTextures
 *
 * Three new visualization layers that read directly from the existing
 * `u_weather` and `u_cloud_layers` DataTextures already populated by
 * weather-feed.js — no new fetches, no new uniforms downstream:
 *
 *   humidity   : RH% as a translucent moisture sheet (dry tan → blue)
 *   precip-rate: mm/hr as a NEXRAD-style radar palette (green → red → magenta)
 *   mist       : derived from RH × low-cloud — the "fog/haze" pocket of the
 *                atmosphere. Soft white-grey, only paints where RH ≥ 85%
 *                AND low-cloud fraction ≥ 0.3.
 *
 * Why a single shader with a mode selector
 *   Each overlay is a thin spherical shell parented to the Earth mesh
 *   exactly like _createObsOverlay does. Fragment cost is identical
 *   between modes (one texture lookup + a colour-ramp branch), and
 *   sharing one shader keeps GLSL drift between modes impossible —
 *   any future fix to the equirect UV math affects all three at once.
 *
 * Channel encoding (lockstep with weather-feed.js):
 *   u_weather.B       = humidity normalised [0, 1] = [0%, 100%]
 *   u_cloud_layers.R  = low-cloud fraction [0, 1]
 *   u_cloud_layers.A  = precipitation rate / 10 mm/hr   (cap 10)
 *
 * Usage:
 *   const overlay = createWeatherOverlay({ THREE, mode: 'humidity', ... });
 *   earthMesh.add(overlay.mesh);
 *   overlay.mesh.visible = userToggle;
 *   overlay.setOpacity(0.55);     // optional runtime tweak
 */

import { GEO_GLSL } from './geo/coords.glsl.js';

// Mode → integer the shader compares against. Order is locked because
// the shader's `if/else if` ladder uses these exact codes.
const MODE_CODE = Object.freeze({
    'humidity':    0,
    'precip-rate': 1,
    'mist':        2,
    'convergence': 3,
    'cape':        4,
});

// Per-mode default opacity. Picked so the overlay reads as a hint about
// the underlying field rather than burying continents — same calibration
// pass as the NASA GIBS overlay opacities.
const DEFAULT_OPACITY = Object.freeze({
    'humidity':    0.45,
    'precip-rate': 0.70,
    'mist':        0.55,
    'convergence': 0.60,
    'cape':        0.62,
});

const VERT = /* glsl */`
varying vec3 vNormalLocal;
void main() {
    vNormalLocal = normalize(position);
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// HSV→RGB and a couple of small ramp helpers. Inline here so the
// overlay shader has no external dependency beyond GEO_GLSL.
const FRAG = /* glsl */`
precision highp float;
${GEO_GLSL}

uniform sampler2D u_weather;        // R=T G=P B=RH A=wind
uniform sampler2D u_cloud_layers;   // R=low G=mid B=high A=precip
uniform sampler2D u_uplift;         // R=signed convergence [-1,1] A=|magnitude|
uniform sampler2D u_aux;            // R=CAPE/4000 J/kg  G=freezing level/10 km
uniform int       u_mode;           // 0=humidity 1=precip 2=mist 3=convergence 4=cape
uniform float     u_opacity;
uniform float     u_has_data;       // 0 until first weather frame ingested

varying vec3 vNormalLocal;

vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// Smoothstep-anchored colour ramp shared by humidity:
//   0.0 → warm sandy tan (parched ground / desert air)
//   0.5 → pale cyan (comfort zone)
//   1.0 → deep blue-cyan (saturated)
vec4 humidityColor(float rh) {
    // Below 30% draw nothing — desert relative humidity isn't a useful
    // overlay signal, the user's eye should see the surface there.
    if (rh < 0.30) return vec4(0.0);
    float t = smoothstep(0.30, 1.00, rh);
    vec3 dry  = vec3(0.78, 0.66, 0.46);
    vec3 mid  = vec3(0.60, 0.84, 0.86);
    vec3 wet  = vec3(0.22, 0.50, 0.85);
    vec3 col  = mix(dry, mid, smoothstep(0.0, 0.55, t));
    col       = mix(col, wet, smoothstep(0.55, 1.0, t));
    // Alpha eases in so 30% RH is barely a tint and 100% reads strong.
    float a   = smoothstep(0.30, 0.70, rh) * 0.85 + 0.15;
    return vec4(col, a);
}

// NEXRAD-style precipitation palette. Input is mm/hr.
//   < 0.10 → no paint
//   0.1 .. 1   → pale green
//   1   .. 5   → green → yellow
//   5   .. 20  → yellow → orange → red
//   > 20       → magenta tail (extreme rain)
vec4 precipColor(float mmhr) {
    if (mmhr < 0.10) return vec4(0.0);
    vec3 col;
    if      (mmhr < 1.0)  col = mix(vec3(0.55, 0.85, 0.55), vec3(0.20, 0.75, 0.20), smoothstep(0.10, 1.0, mmhr));
    else if (mmhr < 5.0)  col = mix(vec3(0.20, 0.75, 0.20), vec3(0.95, 0.90, 0.20), smoothstep(1.0,  5.0, mmhr));
    else if (mmhr < 20.0) col = mix(vec3(0.95, 0.90, 0.20), vec3(0.95, 0.25, 0.15), smoothstep(5.0, 20.0, mmhr));
    else                  col = mix(vec3(0.95, 0.25, 0.15), vec3(0.85, 0.10, 0.65), smoothstep(20., 50., mmhr));
    // Alpha climbs slowly so light drizzle is whisper-thin and storm
    // cells are unmistakable.
    float a = smoothstep(0.10, 8.0, mmhr) * 0.75 + 0.25;
    return vec4(col, a);
}

// Mist gate: only paints where the *near-surface* atmosphere is both
// saturated and clouded. Approximating "near-surface" as "low-cloud
// fraction" because that's what we have on the existing texture; a
// future revision could blend in topography so coastal valleys show
// fog stronger than mountain peaks.
// Convergence / uplift diagnostic. Input is the signed normalised field
// the model grows precip from: +1 = strong convergence (rising air, storm
// genesis), −1 = strong divergence (subsidence, clearing). Diverging cool
// amber, converging a rising indigo→cyan that brightens with strength so
// the eye is drawn to where new weather is forming. The magnitude (abs of
// the signed value) gates alpha so calm regions stay transparent.
vec4 convergenceColor(float signed, float mag) {
    if (mag < 0.06) return vec4(0.0);
    vec3 col;
    if (signed >= 0.0) {
        // Uplift: deep indigo → vivid cyan as convergence strengthens.
        col = mix(vec3(0.28, 0.20, 0.62), vec3(0.30, 0.85, 0.95), smoothstep(0.0, 1.0, signed));
    } else {
        // Subsidence: muted slate → warm amber as divergence strengthens.
        col = mix(vec3(0.42, 0.40, 0.34), vec3(0.92, 0.62, 0.22), smoothstep(0.0, 1.0, -signed));
    }
    float a = smoothstep(0.06, 0.55, mag) * 0.85 + 0.15;
    return vec4(col, a);
}

// CAPE — convective available potential energy (J/kg), the thunderstorm
// fuel gauge. Banded at the thresholds operational forecasters actually
// use: < 100 negligible (no paint); 100–1000 marginal instability (sage →
// yellow); 1000–2500 moderate, organised storms possible (yellow → hot
// orange); 2500+ strong-to-extreme, severe potential (orange → magenta).
// Input arrives normalised against 4000 J/kg (temp-volume-feed sampleAux).
// Alpha stays whisper-thin through the marginal band so fair-weather
// cumulus regions don't shout, then climbs hard where a forecaster's eye
// should land.
vec4 capeColor(float norm) {
    float j = norm * 4000.0;
    if (j < 100.0) return vec4(0.0);
    vec3 col;
    if      (j < 1000.0) col = mix(vec3(0.45, 0.72, 0.52), vec3(0.93, 0.88, 0.30), smoothstep( 100.0, 1000.0, j));
    else if (j < 2500.0) col = mix(vec3(0.93, 0.88, 0.30), vec3(0.95, 0.45, 0.15), smoothstep(1000.0, 2500.0, j));
    else                 col = mix(vec3(0.95, 0.45, 0.15), vec3(0.82, 0.10, 0.48), smoothstep(2500.0, 4000.0, j));
    float a = smoothstep(150.0, 1500.0, j) * 0.80 + 0.20;
    return vec4(col, a);
}

vec4 mistColor(float rh, float cloudLow) {
    float gate = smoothstep(0.85, 1.0, rh) * smoothstep(0.30, 0.90, cloudLow);
    if (gate < 0.05) return vec4(0.0);
    // Cool, slightly blue-tinted off-white. Saturating to pure white at
    // the highest gate so the densest mist patches read instantly.
    vec3 col = mix(vec3(0.78, 0.83, 0.88), vec3(0.96, 0.97, 0.99), gate);
    return vec4(col, gate * 0.85);
}

void main() {
    if (u_has_data < 0.5) discard;

    vec3  n  = normalize(vNormalLocal);
    vec2  uv = normalToUV(n);
    vec4  w  = texture2D(u_weather,      uv);
    vec4  c  = texture2D(u_cloud_layers, uv);

    vec4 col;
    if (u_mode == 0) {
        col = humidityColor(w.b);
    } else if (u_mode == 1) {
        col = precipColor(c.a * 10.0);    // un-normalise from /10 mm/hr
        // Couple the radar sheet to the cloud deck above it so the two
        // layers reinforce instead of floating apart: an echo sitting under
        // a thick low/mid deck reads at full strength (rain confirmed by its
        // parent cloud), while an echo with no overhead cloud fades back —
        // it's the bilinear/blur mismatch between the precip and cloud
        // channels, not a real storm, and shouldn't paint a hard blob in a
        // clear sky. deck = densest of the low/mid decks (the precipitating
        // layers; cirrus doesn't rain).
        float deck = clamp(max(c.r, c.g), 0.0, 1.0);
        col.a *= mix(0.40, 1.0, smoothstep(0.05, 0.45, deck));
    } else if (u_mode == 2) {
        col = mistColor(w.b, c.r);
    } else if (u_mode == 3) {
        vec4 up = texture2D(u_uplift, uv);
        col = convergenceColor(up.r, up.a);
    } else if (u_mode == 4) {
        col = capeColor(texture2D(u_aux, uv).r);
    } else {
        col = vec4(0.0);
    }

    if (col.a < 0.05) discard;
    gl_FragColor = vec4(col.rgb, col.a * u_opacity);
}`;

/**
 * Build a weather-derived overlay shell.
 *
 * @param {object} opts
 * @param {object} opts.THREE              Three.js namespace (avoids re-import fork).
 * @param {number} opts.radius             Shell radius in scene units.
 * @param {number} opts.icoLevel           Subdivision level (match earth's for vertex alignment).
 * @param {string} opts.mode               'humidity' | 'precip-rate' | 'mist'.
 * @param {object} opts.weatherTexture     The shared THREE.DataTexture (RGBA = T,P,RH,wind).
 * @param {object} opts.cloudTexture       The shared THREE.DataTexture (RGBA = low,mid,high,precip).
 * @param {object} [opts.upliftTexture]    The shared THREE.DataTexture (RGBA = signed-convergence,_,_,|mag|).
 *                                         Only the 'convergence' mode samples it; passing it to every
 *                                         overlay keeps a valid sampler bound so three.js doesn't warn.
 * @param {number} [opts.opacity]          Override default per-mode opacity.
 * @returns {{ mesh, mat, setOpacity, setHasData, mode }}
 */
export function createWeatherOverlay({
    THREE,
    radius,
    icoLevel,
    mode,
    weatherTexture,
    cloudTexture,
    upliftTexture = null,
    auxTexture = null,     // R=CAPE/4000, G=freezing level/10 km — 'cape' mode
    opacity,
}) {
    if (!(mode in MODE_CODE)) {
        throw new Error(`createWeatherOverlay: unknown mode '${mode}'`);
    }
    const op = Number.isFinite(opacity) ? opacity : DEFAULT_OPACITY[mode];

    const geom = new THREE.IcosahedronGeometry(radius, icoLevel);
    const mat = new THREE.ShaderMaterial({
        vertexShader:   VERT,
        fragmentShader: FRAG,
        uniforms: {
            u_weather:      { value: weatherTexture },
            u_cloud_layers: { value: cloudTexture },
            u_uplift:       { value: upliftTexture },
            u_aux:          { value: auxTexture ?? upliftTexture ?? weatherTexture },
            u_mode:         { value: MODE_CODE[mode] },
            u_opacity:      { value: op },
            // 0 until the weather feed has produced its first frame —
            // skips the discard-then-write that would otherwise paint
            // garbage from the zero-initialised DataTexture before any
            // observation lands.
            u_has_data:     { value: 0 },
        },
        transparent: true,
        depthWrite:  false,
        side:        THREE.FrontSide,
        blending:    THREE.NormalBlending,
    });

    const mesh = new THREE.Mesh(geom, mat);
    // Render order matches the NASA observation overlays: above the
    // surface (0), below the cloud shell (3) and aurora (4) so cloud
    // tops still occlude the moisture/precip sheet at high altitudes.
    mesh.renderOrder = 2;
    mesh.visible     = false;   // caller sets via toggle

    return {
        mesh,
        mat,
        mode,
        setOpacity(v) { mat.uniforms.u_opacity.value = Math.max(0, Math.min(1, v)); },
        setHasData(on) { mat.uniforms.u_has_data.value = on ? 1 : 0; },
    };
}

export { MODE_CODE, DEFAULT_OPACITY };
export default createWeatherOverlay;
