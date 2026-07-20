/**
 * ring-current-ionosphere.js — THREE render layer for the equatorial fountain
 * (Track A of IONOSPHERE_EXPLORATION_PLAN.md; the pure physics lives in
 * js/ionosphere-fountain.js — this file only draws its state)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two visuals, both children of the EARTH SPIN group (the ionosphere is
 * Earth-fixed; its magnetic organization comes from the same IGRF-2025
 * tilted-dipole pole the EarthSkin aurora oval uses, so the airglow bands
 * and the oval share one magnetic frame):
 *
 *   AIRGLOW SHELL   630 nm layer at its TRUE altitude (250 km, r ≈ 1.039 —
 *                   no vertical exaggeration at this framing; Track C will
 *                   add the disclosed descent remap). Fragment shader:
 *                   · two Appleton crest bands at ± the per-cell crest
 *                     latitude in MAGNETIC latitude — they snake along the
 *                     dip equator's actual curve, dark fountain trough
 *                     between them (that gap IS the fountain signature)
 *                   · plasma bubbles as dark field-aligned BITE-OUTS with a
 *                     shimmering edge (the scintillation cue) — exactly what
 *                     all-sky imagers photograph, dark wedges eating east
 *                   · night-gated (630 nm airglow is a nightside visual;
 *                     limb brightening comes free from the additive shell)
 *                   Per-cell state rides in a 72×1 RGBA DataTexture
 *                   (R = crest, G = crest lat, B = vertical drift) — texel
 *                   centers align exactly with the kernel's 5° cells and
 *                   RepeatWrapping + linear filtering smooth the seam.
 *
 *   FOUNTAIN LINES  12 up-and-over dipole arcs (equator → ±16° maglat at
 *                   F-region height) with a moving pulse-train. The pulse
 *                   RATE is proportional to the cell's true vertical drift
 *                   and advances on SIM seconds (pause holds it, τ scales
 *                   it, a westward drift REVERSES it — honest direction and
 *                   ratios). The absolute rate is a disclosed CUE: at true
 *                   scale 30 m/s is invisible at every τ preset, so the
 *                   legend labels it "pulse rate ∝ drift (cue, not to
 *                   scale)" — the same disclosed-exception pattern as the
 *                   ×1 bounce.
 *
 *   WFC STATE MAP   the Track B cell engine's 288×192 equirect bake
 *                   (ionosphere-cells.js) on its own translucent shell —
 *                   the "what regime is this region in" overlay: trough
 *                   band, diffuse-aurora flank, discrete arc cells. Muted
 *                   palette on THIS page: crest/bubble texels bake to
 *                   alpha 0 because the analytic airglow above already
 *                   draws those two states continuously — the map never
 *                   double-paints them. Rebaked when the globe signals an
 *                   epoch (markMapDirty) or when Earth has rotated ~0.1 h
 *                   under the sun-fixed MLT pattern; NormalBlending (it is
 *                   an overlay legend, not a light source). Hover the map
 *                   on the page for the per-cell `why` inspector.
 *
 * Perf: shell = 1 draw call + one 72-texel texture upload at 4 Hz; lines =
 * 12 draw calls with 2 scalar uniforms each per frame. Bubble uniforms cap
 * at 16 strongest (the kernel may carry more; selection at the 4 Hz sync —
 * no per-frame allocation).
 */

import * as THREE from 'three';
import { AIRGLOW_ALT_KM, N_CELLS, CELL_DEG, dipEquatorLat } from './ionosphere-fountain.js';
import { BAKE_W, BAKE_H, S as CELL_S, N_LAT, N_MLT, latCenter, mltCenter, magLatDeg } from './ionosphere-cells.js';
import {
    engagement, remapRadius, remapFieldLineRadius,
} from './ionosphere-descent.js';
import { GEOMAG_NORTH_LAT_2025, GEOMAG_NORTH_LON_2025 } from './geo/coords.js';

// Shared vertex shader for every atmosphere-anchored shell/line: the Track C
// DISCLOSED vertical exaggeration (js/ionosphere-descent.js) applied on the
// GPU — geometry is built at TRUE radii and inflated per frame by uExag, so
// physics/state never sees the transform (the §C.2 contract).
const EXAG_VERTEX = `
    uniform float uExag;
    varying vec3 vN;
    void main() {
        float r0 = length(position);
        vN = position / r0;
        float r = 1.0 + (r0 - 1.0) * uExag;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(vN * r, 1.0);
    }`;

const R_E_KM = 6371;
const MAX_BUBBLES = 24;   // GW-seeded evenings pack up to 3 crests per cell
const STREAM_COUNT = 12;
const STREAM_MAX_MAGLAT = 16 * Math.PI / 180;
const STREAM_APEX_L = 1.115;               // arc apex ≈ 730 km — "up and over"
/** Pulse-train cycles per (m/s · sim-s) — the disclosed cue rate: 30 m/s at
 *  τ=300 ≈ 0.8 cycles/s on screen, at τ=1 a pulse every ~6 min (near-still,
 *  as a real fountain would look). */
const PULSE_K = 8.9e-5;

// Earth-local frame (js/geo/coords.js canonical): lon 0 → +X, east → −Z.
function latLonToVec(latRad, lonRad, out) {
    const cl = Math.cos(latRad);
    out.set(cl * Math.cos(lonRad), Math.sin(latRad), -cl * Math.sin(lonRad));
    return out;
}

function airglowMaterial(cellTex) {
    return new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        // DoubleSide: at full descent the camera flies INSIDE this shell —
        // back faces are the view (FrontSide would cull the sky away).
        side: THREE.DoubleSide,
        uniforms: {
            uCells:   { value: cellTex },
            uMagPole: { value: latLonToVec(GEOMAG_NORTH_LAT_2025, GEOMAG_NORTH_LON_2025, new THREE.Vector3()) },
            uSunDir:  { value: new THREE.Vector3(1, 0, 0) },   // Earth-local, set per frame
            uTime:    { value: 0 },
            uGain:    { value: 1 },
            uExag:    { value: 1 },
            uBub:     { value: Array.from({ length: MAX_BUBBLES }, () => new THREE.Vector4()) },
        },
        vertexShader: EXAG_VERTEX,
        fragmentShader: `
            uniform sampler2D uCells;
            uniform vec3 uMagPole, uSunDir;
            uniform float uTime, uGain;
            uniform vec4 uBub[${MAX_BUBBLES}];
            varying vec3 vN;
            const float PI = 3.14159265358979;
            void main() {
                vec3 n = normalize(vN);
                float lon = atan(-n.z, n.x);                  // geo lon (coords.js frame)
                float magLat = asin(clamp(dot(n, uMagPole), -1.0, 1.0));
                // Per-cell state — texel centers sit at the kernel's 5° cells.
                vec4 cell = texture2D(uCells, vec2(lon / (2.0 * PI) + 0.5, 0.5));
                float crest = cell.r;
                float crestLat = radians(10.0 + 8.0 * cell.g);
                // Two Appleton bands (σ ≈ 3.2°) with the dark fountain
                // trough between them — brightness from the cell's crest.
                float sig = radians(3.2);
                float dN = (magLat - crestLat) / sig, dS = (magLat + crestLat) / sig;
                float band = exp(-dN * dN) + exp(-dS * dS);
                float b = crest * band;
                // Bubbles: dark field-aligned wedges biting the bands, with
                // a shimmering edge — the scintillation cue.
                for (int i = 0; i < ${MAX_BUBBLES}; i++) {
                    vec4 bub = uBub[i];
                    if (bub.z <= 0.001) continue;
                    float dLon = abs(mod(lon - bub.x + PI, 2.0 * PI) - PI);
                    float wLon = 1.0 - smoothstep(bub.w * 0.45, bub.w, dLon);
                    float wLat = 1.0 - smoothstep(bub.y * 0.62, bub.y, abs(magLat));
                    float edge = 0.86 + 0.14 * sin(uTime * 6.3 + lon * 57.0 + magLat * 43.0);
                    b *= 1.0 - bub.z * wLon * wLat * edge;
                }
                // Nightside gate: 630 nm is a night visual (terminator soft).
                float night = smoothstep(0.05, 0.28, -dot(n, uSunDir));
                float glow = max(0.0, b) * night * uGain;
                gl_FragColor = vec4(vec3(1.0, 0.36, 0.22) * glow, 0.55);
            }`,
    });
}

function streamlineMaterial() {
    return new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uPhase: { value: 0 },
            uAmp:   { value: 0 },
            uExag:  { value: 1 },
        },
        vertexShader: `
            attribute float aT;
            varying float vT;
            uniform float uExag;
            void main() {
                vT = aT;
                float r0 = length(position);
                float r = 1.0 + (r0 - 1.0) * uExag;
                gl_Position = projectionMatrix * modelViewMatrix
                    * vec4(position * (r / r0), 1.0);
            }`,
        fragmentShader: `
            uniform float uPhase, uAmp;
            varying float vT;
            void main() {
                // Pulses travel equator → crest as uPhase grows (drift up),
                // reversing with it (nighttime descent runs back down).
                float f = fract(abs(vT) * 3.0 - uPhase);
                float pulse = smoothstep(0.0, 0.16, f) * (1.0 - smoothstep(0.30, 0.62, f));
                float a = uAmp * pulse * (1.0 - 0.30 * abs(vT));
                gl_FragColor = vec4(vec3(0.50, 0.91, 1.00) * a, a);
            }`,
    });
}

// Page palette for the WFC map bake — a STATE-ID encoding (M4, plan §B.5):
// R = state id × 20 (decoded in the fragment shader, which dispatches a
// per-state program: color ramp + spectral flow noise), A = 0 mutes a state
// off the map entirely (crest/bubble — the analytic airglow owns them).
// The map texture is NEAREST-filtered: ids must never interpolate.
const ID_STEP = 20;
const MAP_PALETTE = Uint8Array.from((() => {
    const MUTED = new Set([1, 2]);              // crest, bubble
    const out = [];
    for (let id = 0; id < 11; id++) {
        out.push(id * ID_STEP, 255, 0, MUTED.has(id) ? 0 : 255);
    }
    return out;
})());

export class IonosphereLayer {
    /**
     * @param {import('./ionosphere-fountain.js').IonosphereFountain} fountain
     * @param {import('./ionosphere-cells.js').IonosphereCells} [cells]
     */
    constructor(fountain, cells = null) {
        this._fountain = fountain;
        this._cells = cells;
        this.group = new THREE.Group();
        this._syncT = 0;

        // Per-cell state texture (72×1 RGBA — see header).
        this._cellData = new Uint8Array(N_CELLS * 4);
        this._cellTex = new THREE.DataTexture(this._cellData, N_CELLS, 1, THREE.RGBAFormat);
        this._cellTex.wrapS = THREE.RepeatWrapping;
        this._cellTex.magFilter = THREE.LinearFilter;
        this._cellTex.minFilter = THREE.LinearFilter;

        this._shellMat = airglowMaterial(this._cellTex);
        const rShell = 1 + AIRGLOW_ALT_KM / R_E_KM;
        this._shell = new THREE.Mesh(new THREE.SphereGeometry(rShell, 96, 48), this._shellMat);
        this._shell.renderOrder = 3;   // over the EarthSkin atmosphere rim
        this.group.add(this._shell);

        this._buildStreamlines();
        if (this._cells) this._buildStateMap();
        this._buildLayerShells();
        this._buildDetailPool();
        this._exag = 1;
        this._engage = 0;
        this._detailExagAt = 1;
        this._camLocal = new THREE.Vector3();
        this.detailActive = 0;   // perf-HUD `cells` counter (plan §C.4)
    }

    /** Track C descent: the D/E/F stack as nested translucent surfaces that
     *  fade in with engagement and separate under the vertical exaggeration
     *  — "the layer diagram you fly between". Day/night behavior is real:
     *  D exists in daylight only, E keeps a weak night residual, F2
     *  persists (uNightFloor 0 / 0.25 / 1). A faint 15° graticule makes
     *  each surface legible as a surface from inside. */
    _buildLayerShells() {
        const defs = [
            { alt: 75,  color: [0.75, 0.55, 0.35], floor: 0.0,  label: 'D' },
            { alt: 108, color: [0.35, 0.80, 0.75], floor: 0.25, label: 'E' },
            { alt: 300, color: [0.55, 0.55, 1.00], floor: 1.0,  label: 'F' },
        ];
        this._layerShells = [];
        for (const d of defs) {
            const mat = new THREE.ShaderMaterial({
                transparent: true, depthWrite: false, side: THREE.DoubleSide,
                uniforms: {
                    uExag: { value: 1 }, uEngage: { value: 0 },
                    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
                    uColor: { value: new THREE.Vector3(...d.color) },
                    uNightFloor: { value: d.floor },
                },
                vertexShader: EXAG_VERTEX,
                fragmentShader: `
                    uniform float uEngage, uNightFloor;
                    uniform vec3 uSunDir, uColor;
                    varying vec3 vN;
                    const float PI = 3.14159265358979;
                    void main() {
                        vec3 n = normalize(vN);
                        float dayF = smoothstep(0.0, 0.25, dot(n, uSunDir));
                        float presence = mix(uNightFloor, 1.0, dayF);
                        float latDeg = degrees(asin(clamp(n.y, -1.0, 1.0)));
                        float lonDeg = degrees(atan(-n.z, n.x));
                        float gLat = smoothstep(0.44, 0.5, abs(fract(latDeg / 15.0) - 0.5));
                        float gLon = smoothstep(0.44, 0.5, abs(fract(lonDeg / 15.0) - 0.5));
                        float grid = max(gLat, gLon);
                        float a = uEngage * presence * (0.05 + 0.11 * grid);
                        gl_FragColor = vec4(uColor, a);
                    }`,
            });
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(1 + d.alt / R_E_KM, 72, 36), mat);
            mesh.renderOrder = 2;
            mesh.visible = false;
            this.group.add(mesh);
            this._layerShells.push({ mesh, mat });
        }
    }

    /** LOD detail pool (plan §C.4: pooled geometry, ~a dozen active cells,
     *  noise in-shader, no per-frame allocation): 6 aurora-curtain ribbons
     *  + 6 bubble wedges, assigned at sync time to the cells/bubbles
     *  nearest the camera's ground point. Curtain radii use the FIELD-LINE
     *  remap so curtains meet their (remapped) arcs exactly. */
    _buildDetailPool() {
        this._curtains = [];
        this._wedges = [];
        this._scratch = {
            e: new THREE.Vector3(), u: new THREE.Vector3(), n: new THREE.Vector3(),
            p: new THREE.Vector3(), s: new THREE.Vector3(), m: new THREE.Matrix4(),
        };
        for (let k = 0; k < 6; k++) {
            const mat = new THREE.ShaderMaterial({
                transparent: true, depthWrite: false, side: THREE.DoubleSide,
                blending: THREE.AdditiveBlending,
                uniforms: { uTime: { value: 0 }, uAmp: { value: 0 } },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }`,
                fragmentShader: `
                    uniform float uTime, uAmp;
                    varying vec2 vUv;
                    void main() {
                        // Vertical ray striations, drifting slowly — the
                        // all-sky-camera curtain look, noise in-shader.
                        float x = vUv.x * 7.0;
                        float rays = 0.42
                            + 0.34 * sin(x * 9.0 + sin(x * 3.7 + uTime * 0.9) * 2.2)
                            + 0.24 * sin(x * 23.0 - uTime * 1.7);
                        rays = clamp(rays, 0.0, 1.0);
                        // 557.7 nm green low, 630 nm red topside.
                        vec3 col = mix(vec3(0.25, 1.0, 0.5), vec3(1.0, 0.32, 0.36),
                                       smoothstep(0.55, 1.0, vUv.y));
                        float vert = smoothstep(0.0, 0.08, vUv.y) * (1.0 - 0.6 * vUv.y);
                        float a = uAmp * rays * vert;
                        gl_FragColor = vec4(col * a, a);
                    }`,
            });
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), mat);
            mesh.matrixAutoUpdate = false;
            mesh.renderOrder = 4;
            mesh.visible = false;
            this.group.add(mesh);
            this._curtains.push({ mesh, mat });
        }
        for (let k = 0; k < 6; k++) {
            const mat = new THREE.MeshBasicMaterial({
                color: 0x160309, transparent: true, opacity: 0,
                depthWrite: false,
            });
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), mat);
            mesh.matrixAutoUpdate = false;
            mesh.renderOrder = 4;
            mesh.visible = false;
            this.group.add(mesh);
            this._wedges.push({ mesh, mat });
        }
    }

    /** Per-frame from the globe: the disclosed vertical exaggeration. */
    setExaggeration(E) {
        if (Math.abs(E - this._exag) < 1e-4) return;
        this._exag = E;
        this._engage = engagement(E);
        this._shellMat.uniforms.uExag.value = E;
        if (this._mapMat) this._mapMat.uniforms.uExag.value = E;
        for (const st of this._streams) st.mat.uniforms.uExag.value = E;
        for (const L of this._layerShells) {
            L.mat.uniforms.uExag.value = E;
            L.mat.uniforms.uEngage.value = this._engage;
            L.mesh.visible = this._engage > 0.02 && this.group.visible;
        }
    }

    /** The Track B regional-state map shell (see header). */
    _buildStateMap() {
        this._mapData = new Uint8Array(BAKE_W * BAKE_H * 4);
        this._mapTex = new THREE.DataTexture(this._mapData, BAKE_W, BAKE_H, THREE.RGBAFormat);
        this._mapTex.wrapS = THREE.RepeatWrapping;
        // NEAREST, not linear: the texels carry STATE IDS for the shader
        // dispatch — interpolated ids decode to garbage states at borders.
        // The per-state noise programs supply all the visual softening.
        this._mapTex.magFilter = THREE.NearestFilter;
        this._mapTex.minFilter = THREE.NearestFilter;
        this._mapDirty = true;
        this._mapUtH = -1;
        this._simH = 0;
        // The M4 per-state shader dispatch (plan §B.5 realized): the texture
        // carries STATE IDS; this fragment shader is the "program registry" —
        // each state gets a color ramp + power-law (fbm) spectral noise
        // ADVECTED by the convection physics. Advection runs on SIM time
        // (uSimH accumulates dSim: pause freezes every texture's motion) and
        // its speed scales with the LIVE shielded amplitude uAsh — patches
        // and the tongue stream antisunward faster as convection strengthens,
        // and the SAPS channel streaks westward at its honest jet rate
        // (~0.5 MLT-h per hour at 1 km/s — the one motion drawn 1:1).
        this._mapMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,   // visible from inside at full descent
            uniforms: {
                uMap: { value: this._mapTex },
                uExag: { value: 1 },
                uMagPole: { value: latLonToVec(GEOMAG_NORTH_LAT_2025, GEOMAG_NORTH_LON_2025, new THREE.Vector3()) },
                uUtH: { value: 0 },
                uSimH: { value: 0 },
                uAsh: { value: 0.1 },
            },
            vertexShader: EXAG_VERTEX,
            fragmentShader: `
                uniform sampler2D uMap;
                uniform vec3 uMagPole;
                uniform float uUtH, uSimH, uAsh;
                varying vec3 vN;
                const float PI = 3.14159265358979;
                // Hash → value noise → 3-octave fbm (power-law amplitudes) —
                // the plan's spectral noise, cheap enough for software GL.
                float h21(vec2 p) {
                    p = fract(p * vec2(123.34, 456.21));
                    p += dot(p, p + 45.32);
                    return fract(p.x * p.y);
                }
                float vnoise(vec2 p) {
                    vec2 i = floor(p), f = fract(p);
                    f = f * f * (3.0 - 2.0 * f);
                    return mix(
                        mix(h21(i), h21(i + vec2(1, 0)), f.x),
                        mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
                }
                float fbm(vec2 p) {
                    float s = 0.55 * vnoise(p);
                    p *= 2.13; s += 0.28 * vnoise(p);
                    p *= 2.11; s += 0.17 * vnoise(p);
                    return s;
                }
                void main() {
                    vec3 n = normalize(vN);
                    float lon = atan(-n.z, n.x);                  // coords.js frame
                    float v = (PI * 0.5 - asin(clamp(n.y, -1.0, 1.0))) / PI;
                    vec4 tex = texture2D(uMap, vec2(lon / (2.0 * PI) + 0.5, v));
                    if (tex.a < 0.5) discard;
                    float id = floor(tex.r * 255.0 / ${ID_STEP}.0 + 0.5);
                    float magLat = degrees(asin(clamp(dot(n, uMagPole), -1.0, 1.0)));
                    float mlt = mod(uUtH + degrees(lon) / 15.0, 24.0);
                    float ashN = clamp(uAsh / 1.2, 0.0, 1.0);     // storm-normalized
                    // Noise domain: MLT-hours × maglat-degrees (sun-fixed, so
                    // advection velocities are physical directions).
                    vec2 q = vec2(mlt * 2.2, magLat * 0.45);
                    float antisun = (mlt < 12.0 ? -1.0 : 1.0);    // away from noon
                    vec3 col; float a;
                    if (id < 0.5) {                               // quiet
                        col = vec3(0.04, 0.05, 0.10); a = 0.05;
                    } else if (id < 3.5) {                        // arc
                        float s = fbm(vec2(q.x * 6.0 - uSimH * (0.6 + 1.4 * ashN), q.y * 1.3));
                        col = mix(vec3(0.10, 0.75, 0.30), vec3(0.45, 1.0, 0.55), s);
                        a = 0.22 + 0.42 * s;
                    } else if (id < 4.5) {                        // diffuse
                        float s = fbm(q * 0.9 - vec2(uSimH * 0.25, 0.0));
                        col = vec3(0.14, 0.55, 0.32); a = 0.24 + 0.22 * s;
                    } else if (id < 5.5) {                        // trough — a dark HOLE
                        float s = fbm(q * 0.6);
                        col = vec3(0.06, 0.10, 0.30); a = 0.42 + 0.10 * s;
                    } else if (id < 6.5) {                        // SAPS — westward jet
                        // Elongated streaks racing WESTWARD (−MLT); the drawn
                        // rate ≈ the real 1 km/s jet (≈0.5 MLT-h per hour).
                        vec2 qs = vec2(q.x * 0.55 + uSimH * (0.25 + 0.45 * ashN), q.y * 3.2);
                        float s = fbm(qs);
                        col = mix(vec3(0.75, 0.22, 0.06), vec3(1.0, 0.62, 0.20), s);
                        a = 0.34 + 0.42 * s;
                    } else if (id < 7.5) {                        // patches — blobs antisunward
                        vec2 qp = q * 1.25 - vec2(antisun * uSimH * (0.3 + 1.2 * ashN), 0.0);
                        float b = smoothstep(0.52, 0.72, fbm(qp));
                        col = vec3(0.70, 0.88, 1.0); a = 0.10 + 0.55 * b;
                    } else if (id < 8.5) {                        // TOI — the streaming tongue
                        vec2 qt = vec2(q.x * 1.6, q.y * 0.5)
                            - vec2(antisun * uSimH * (0.4 + 1.3 * ashN), 0.0);
                        float s = fbm(qt);
                        col = vec3(0.82, 0.92, 1.0); a = 0.20 + 0.34 * s;
                    } else if (id < 9.5) {                        // SED plume — toward the cusp
                        vec2 qd = q - vec2(uSimH * 0.2, -uSimH * (0.15 + 0.35 * ashN));
                        float s = fbm(qd * 1.1);
                        col = mix(vec3(0.85, 0.60, 0.20), vec3(1.0, 0.85, 0.45), s);
                        a = 0.22 + 0.32 * s;
                    } else {                                      // storm O/N₂ depletion
                        float s = fbm(q * 0.45 - vec2(uSimH * 0.08, 0.0));
                        col = vec3(0.35, 0.16, 0.10); a = 0.28 + 0.26 * s;
                    }
                    gl_FragColor = vec4(col, a);
                }`,
        });
        // Just under the airglow shell (renderOrder 2 < 3) so bite-outs and
        // crest bands draw over the regime map, never the reverse.
        this._mapShell = new THREE.Mesh(
            new THREE.SphereGeometry(1 + (AIRGLOW_ALT_KM - 60) / R_E_KM, 96, 48), this._mapMat);
        this._mapShell.renderOrder = 2;
        this.group.add(this._mapShell);
    }

    /** The globe signals a fresh WFC epoch — rebake on the next sync. */
    markMapDirty() { this._mapDirty = true; }

    /** Live shielded amplitude (+ ΔA, reserved) → the map shader's flow
     *  speeds: patches/TOI stream antisunward faster as convection
     *  strengthens; the SAPS streak rate rides the same drive. */
    setDrivers(ash) {
        if (this._mapMat && Number.isFinite(ash)) {
            this._mapMat.uniforms.uAsh.value = ash;
        }
    }

    /** The map shell mesh — the globe raycasts it for the cell inspector. */
    get mapShell() { return this._mapShell ?? null; }

    setMapVisible(on) {
        if (this._mapShell) this._mapShell.visible = !!on;
    }

    /** 12 up-and-over dipole arcs anchored to the SNAKING dip equator —
     *  each is a polyline in magnetic coordinates around its own magnetic
     *  meridian, so the arc tops sit over the real (offset) dip equator. */
    _buildStreamlines() {
        // Magnetic basis (mirrors js/geo/coords.js geoToMagnetic).
        const pole = latLonToVec(GEOMAG_NORTH_LAT_2025, GEOMAG_NORTH_LON_2025, new THREE.Vector3());
        const xMag = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), pole).normalize();
        const yMag = new THREE.Vector3().crossVectors(pole, xMag).normalize();

        this._streams = [];
        const SEGS = 64;
        const tmp = new THREE.Vector3();
        for (let k = 0; k < STREAM_COUNT; k++) {
            const lonDeg = -165 + k * (360 / STREAM_COUNT);
            const lonRad = lonDeg * Math.PI / 180;
            const eqLat = dipEquatorLat(lonRad);
            latLonToVec(eqLat, lonRad, tmp);
            const mlon = Math.atan2(-tmp.dot(yMag), tmp.dot(xMag));
            const cm = Math.cos(mlon), sm = Math.sin(mlon);

            const pos = new Float32Array((SEGS + 1) * 3);
            const aT = new Float32Array(SEGS + 1);
            for (let s = 0; s <= SEGS; s++) {
                const t = -1 + (2 * s) / SEGS;
                const m = t * STREAM_MAX_MAGLAT;
                const cosM = Math.cos(m), sinM = Math.sin(m);
                const r = Math.max(1.02, STREAM_APEX_L * cosM * cosM);
                const j = s * 3;
                pos[j]     = r * (cosM * (cm * xMag.x - sm * yMag.x) + sinM * pole.x);
                pos[j + 1] = r * (cosM * (cm * xMag.y - sm * yMag.y) + sinM * pole.y);
                pos[j + 2] = r * (cosM * (cm * xMag.z - sm * yMag.z) + sinM * pole.z);
                aT[s] = t;
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
            const mat = streamlineMaterial();
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 3;
            this.group.add(line);
            this._streams.push({
                mat,
                phase: (k * 0.618034) % 1,   // golden-ratio de-phasing, deterministic
                cell: Math.max(0, Math.min(N_CELLS - 1, Math.floor((lonDeg + 180) / CELL_DEG))),
            });
        }
    }

    setVisible(on) {
        this.group.visible = !!on;
    }

    /**
     * Per-frame update. dSimSec is the SimClock delta (0 while paused);
     * subsolar {latDeg, lonDeg} comes from the globe's existing
     * subsolarPoint call — the shell's night gate uses the same sun the
     * terminator does. utH (sim UT hours) places the sun-fixed WFC map
     * under the Earth-fixed texels.
     */
    update(dtWall, dSimSec, tView, subsolar, utH = 0, camWorld = null) {
        if (!this.group.visible) return;
        const cells = this._fountain.cells;
        this._shellMat.uniforms.uTime.value = tView;
        if (subsolar) {
            const sun = latLonToVec(subsolar.latDeg * Math.PI / 180,
                subsolar.lonDeg * Math.PI / 180, this._shellMat.uniforms.uSunDir.value);
            for (const L of this._layerShells) L.mat.uniforms.uSunDir.value.copy(sun);
        }
        // Curtain shimmer clock + an out-of-band detail refresh when the
        // exaggeration moved a lot between 4 Hz syncs (fast zoom).
        for (const c of this._curtains) {
            if (c.mesh.visible) c.mat.uniforms.uTime.value = tView;
        }
        if (Math.abs(this._exag - this._detailExagAt) > 0.2) this._syncT = 0;
        // Map-shader advection clock: SIM hours (pause freezes every state's
        // texture motion with the rest of the scene — one clock, always).
        this._simH += dSimSec / 3600;
        if (this._mapMat) {
            this._mapMat.uniforms.uSimH.value = this._simH % 4096;
            this._mapMat.uniforms.uUtH.value = utH;
        }
        // Streamline pulse-trains: rate ∝ the cell's true drift, advancing
        // on SIM time (τ-honest, pause-frozen, direction-honest).
        for (const st of this._streams) {
            const v = cells[st.cell].v;
            st.phase += v * dSimSec * PULSE_K;
            st.mat.uniforms.uPhase.value = st.phase;
            st.mat.uniforms.uAmp.value = Math.min(1, Math.abs(v) / 28) * 0.85;
        }
        // Throttled (4 Hz) per-cell texture + bubble uniform sync.
        this._syncT -= dtWall;
        if (this._syncT > 0) return;
        this._syncT = 0.25;
        // WFC map rebake: on a fresh epoch, or once Earth has rotated far
        // enough (~0.1 h ≈ 1.5° lon ≈ one texel) that the sun-fixed MLT
        // pattern has visibly slid under the geographic texels. Steady bake
        // ≈ 0.3 ms (perf-probed) — cheap at this cadence.
        if (this._mapShell && this._mapShell.visible &&
            (this._mapDirty || Math.abs(utH - this._mapUtH) > 0.1)) {
            this._mapDirty = false;
            this._mapUtH = utH;
            this._cells.bake(utH, this._mapData, MAP_PALETTE);
            this._mapTex.needsUpdate = true;
        }
        // LOD detail pool: camera ground point in the Earth-local frame
        // (matrixWorld is last frame's — one frame stale, invisible at 4 Hz).
        if (camWorld) {
            this._camLocal.copy(camWorld);
            this.group.worldToLocal(this._camLocal).normalize();
            this._detailExagAt = this._exag;
            this._updateDetail(utH);
        }
        for (let i = 0; i < N_CELLS; i++) {
            const c = cells[i];
            const j = i * 4;
            this._cellData[j]     = Math.max(0, Math.min(255, c.crest * 255)) | 0;
            this._cellData[j + 1] = Math.max(0, Math.min(255, (this._fountain.crestLatDeg(c) - 10) / 8 * 255)) | 0;
            this._cellData[j + 2] = Math.max(0, Math.min(255, (c.v + 80) / 160 * 255)) | 0;
            this._cellData[j + 3] = 255;
        }
        this._cellTex.needsUpdate = true;

        const bubs = this._fountain.allBubbles()
            .sort((a, b) => b.strength * b.fade - a.strength * a.fade);
        const uBub = this._shellMat.uniforms.uBub.value;
        for (let i = 0; i < MAX_BUBBLES; i++) {
            const u = uBub[i];
            const b = bubs[i];
            if (!b) { u.set(0, 0, 0, 0); continue; }
            u.set(
                b.lonDeg * Math.PI / 180,
                b.latExtentDeg * Math.PI / 180,
                Math.min(1, b.strength * b.fade),
                // Wedge widens as it rises — 0.6° → 1.5° (≈ 65–165 km), the
                // observed depletion width; keeping it narrow is what lets
                // the GW-seeded ~100–400 km spacing read as separate bites.
                (0.6 + 0.9 * b.rise01) * Math.PI / 180,
            );
        }
    }

    /** Geographic latitude whose centered-dipole maglat equals the target
     *  at this longitude — bisection on the monotone branch (|lat| kept
     *  below 80° where ∂maglat/∂lat stays positive). null if out of range. */
    _geoLatForMagLat(magTarget, lonDeg) {
        let lo = Math.max(-80, magTarget - 15), hi = Math.min(80, magTarget + 15);
        if (magLatDeg(lo, lonDeg) > magTarget || magLatDeg(hi, lonDeg) < magTarget) return null;
        for (let it = 0; it < 22; it++) {
            const mid = 0.5 * (lo + hi);
            if (magLatDeg(mid, lonDeg) < magTarget) lo = mid; else hi = mid;
        }
        return 0.5 * (lo + hi);
    }

    /** Assign the pooled curtains/wedges to the arc-diffuse cells and live
     *  bubbles nearest the camera ground point (4 Hz; modest short-lived
     *  arrays here are the same budget the bubble sync already spends). */
    _updateDetail(utH) {
        const { e, u, n, m } = this._scratch;
        this.detailActive = 0;
        const engaged = this._cells && this._engage > 0.3 && this.group.visible;
        const cam = this._camLocal;
        const DEG = Math.PI / 180;

        // ── Aurora curtains over arc/diffuse cells ──
        const cand = [];
        if (engaged) {
            for (let i = 0; i < N_LAT; i++) {
                const mlat = latCenter(i);
                if (Math.abs(mlat) < 45 || Math.abs(mlat) > 78) continue;
                for (let j = 0; j < N_MLT; j++) {
                    const s = this._cells.state[i * N_MLT + j];
                    if (s !== CELL_S.ARC && s !== CELL_S.DIFFUSE) continue;
                    const lonDeg = (((mltCenter(j) - utH) * 15) % 360 + 540) % 360 - 180;
                    const latDeg = this._geoLatForMagLat(mlat, lonDeg);
                    if (latDeg === null) continue;
                    const d = latLonToVec(latDeg * DEG, lonDeg * DEG, u).dot(cam);
                    if (d < 0.55) continue;   // beyond ~57° of ground distance
                    cand.push({ d, latDeg, lonDeg, arc: s === CELL_S.ARC });
                }
            }
            cand.sort((a, b) => b.d - a.d);
        }
        const rBase = remapFieldLineRadius(1 + 100 / R_E_KM, this._exag);
        const rTop = remapFieldLineRadius(1 + 280 / R_E_KM, this._exag);
        for (let k = 0; k < this._curtains.length; k++) {
            const slot = this._curtains[k], c = cand[k];
            if (!c) { slot.mesh.visible = false; slot.mat.uniforms.uAmp.value = 0; continue; }
            const latR = c.latDeg * DEG, lonR = c.lonDeg * DEG;
            latLonToVec(latR, lonR, u);
            e.set(-Math.sin(lonR), 0, -Math.cos(lonR));   // local east (coords frame)
            n.crossVectors(u, e).normalize();
            const h = rTop - rBase, w = c.arc ? 0.085 : 0.13;
            m.makeBasis(e, u, n);
            const el = m.elements;                        // column-scale (w, h, 1)
            el[0] *= w; el[1] *= w; el[2] *= w;
            el[4] *= h; el[5] *= h; el[6] *= h;
            const rc = rBase + h / 2;
            m.setPosition(u.x * rc, u.y * rc, u.z * rc);
            slot.mesh.matrix.copy(m);
            slot.mesh.visible = true;
            slot.mat.uniforms.uAmp.value = this._engage * (c.arc ? 0.85 : 0.4);
            this.detailActive++;
        }

        // ── Bubble wedges (shell remap — they live among the layers) ──
        const bubs = engaged
            ? this._fountain.allBubbles()
                .map(b => {
                    const lonR = b.lonDeg * DEG;
                    const latR = dipEquatorLat(lonR);
                    return { b, latR, lonR, d: latLonToVec(latR, lonR, u).dot(cam) };
                })
                .filter(x => x.d > 0.55)
                .sort((a, b) => b.d - a.d)
            : [];
        for (let k = 0; k < this._wedges.length; k++) {
            const slot = this._wedges[k], x = bubs[k];
            if (!x) { slot.mesh.visible = false; slot.mat.opacity = 0; continue; }
            latLonToVec(x.latR, x.lonR, u);
            e.set(-Math.sin(x.lonR), 0, -Math.cos(x.lonR));
            n.crossVectors(u, e).normalize();
            const rB = remapRadius(1 + 250 / R_E_KM, this._exag);
            const rT = remapRadius(1 + x.b.apexKm / R_E_KM, this._exag);
            const radial = Math.max(0.012, (rT - rB) / 2);
            const wLon = Math.max(0.008, (0.6 + 0.9 * x.b.rise01) * DEG * 0.9);
            const wLat = Math.max(0.012, x.b.latExtentDeg * DEG);
            m.makeBasis(e, u, n);
            const el = m.elements;
            el[0] *= wLon; el[1] *= wLon; el[2] *= wLon;
            el[4] *= radial; el[5] *= radial; el[6] *= radial;
            el[8] *= wLat; el[9] *= wLat; el[10] *= wLat;
            const rc = (rB + rT) / 2;
            m.setPosition(u.x * rc, u.y * rc, u.z * rc);
            slot.mesh.matrix.copy(m);
            slot.mesh.visible = true;
            slot.mat.opacity = 0.5 * this._engage * x.b.strength * x.b.fade;
            this.detailActive++;
        }
    }

    dispose() {
        this._cellTex.dispose();
        this._mapTex?.dispose();
        // Geometries/materials are disposed by the globe's scene traversal.
    }
}
