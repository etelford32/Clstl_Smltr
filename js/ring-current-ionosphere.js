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
import { BAKE_W, BAKE_H } from './ionosphere-cells.js';
import { GEOMAG_NORTH_LAT_2025, GEOMAG_NORTH_LON_2025 } from './geo/coords.js';

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
        side: THREE.FrontSide,
        uniforms: {
            uCells:   { value: cellTex },
            uMagPole: { value: latLonToVec(GEOMAG_NORTH_LAT_2025, GEOMAG_NORTH_LON_2025, new THREE.Vector3()) },
            uSunDir:  { value: new THREE.Vector3(1, 0, 0) },   // Earth-local, set per frame
            uTime:    { value: 0 },
            uGain:    { value: 1 },
            uBub:     { value: Array.from({ length: MAX_BUBBLES }, () => new THREE.Vector4()) },
        },
        vertexShader: `
            varying vec3 vN;
            void main() {
                vN = normalize(position);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
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
        },
        vertexShader: `
            attribute float aT;
            varying float vT;
            void main() {
                vT = aT;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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

// Page palette for the WFC map bake: crest + bubble muted (see header).
const MAP_PALETTE = Uint8Array.from([
    10, 12, 24, 16,       // quiet: whisper of deep blue
    0, 0, 0, 0,           // crest: analytic airglow owns it
    0, 0, 0, 0,           // bubble: analytic airglow owns it
    64, 255, 128, 105,    // arc: discrete auroral cells (EarthSkin glows above)
    40, 160, 90, 95,      // diffuse: equatorward flank
    60, 120, 255, 110,    // trough: subauroral depletion band
]);

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
    }

    /** The Track B regional-state map shell (see header). */
    _buildStateMap() {
        this._mapData = new Uint8Array(BAKE_W * BAKE_H * 4);
        this._mapTex = new THREE.DataTexture(this._mapData, BAKE_W, BAKE_H, THREE.RGBAFormat);
        this._mapTex.wrapS = THREE.RepeatWrapping;
        this._mapTex.magFilter = THREE.LinearFilter;
        this._mapTex.minFilter = THREE.LinearFilter;
        this._mapDirty = true;
        this._mapUtH = -1;
        this._mapMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            uniforms: { uMap: { value: this._mapTex } },
            vertexShader: `
                varying vec3 vN;
                void main() {
                    vN = normalize(position);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                uniform sampler2D uMap;
                varying vec3 vN;
                const float PI = 3.14159265358979;
                void main() {
                    vec3 n = normalize(vN);
                    // Same frame as the airglow shader: lon 0 → +X, east → −Z.
                    // Bake rows run north → south, DataTexture v=0 = row 0.
                    float lon = atan(-n.z, n.x);
                    float v = (PI * 0.5 - asin(clamp(n.y, -1.0, 1.0))) / PI;
                    vec4 c = texture2D(uMap, vec2(lon / (2.0 * PI) + 0.5, v));
                    if (c.a < 0.01) discard;
                    gl_FragColor = c;
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
    update(dtWall, dSimSec, tView, subsolar, utH = 0) {
        if (!this.group.visible) return;
        const cells = this._fountain.cells;
        this._shellMat.uniforms.uTime.value = tView;
        if (subsolar) {
            latLonToVec(subsolar.latDeg * Math.PI / 180, subsolar.lonDeg * Math.PI / 180,
                this._shellMat.uniforms.uSunDir.value);
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

    dispose() {
        this._cellTex.dispose();
        this._mapTex?.dispose();
        // Geometries/materials are disposed by the globe's scene traversal.
    }
}
