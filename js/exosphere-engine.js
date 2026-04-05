/**
 * ExosphereEngine — solar-wind-driven geocorona / exosphere visualization
 *
 * Scene layout (Earth at origin, R_E = 1 Three.js unit):
 *
 *   _solarGroup  (world-space Group, Y-axis aligned toward sun each frame)
 *     ├─ exoFill      geocorona exopause shell — translucent ShaderMaterial (Fresnel glow + animated waves)
 *     ├─ exoWire      same LatheGeometry surface — wireframe overlay
 *     ├─ chExHalo     charge-exchange standoff annulus — wider wireframe at ~1.1× exopause
 *     └─ tailStream   neutral-H escape plume — open cylinder in anti-solar direction
 *
 *   _eqGroup  (world-space Group at origin, equatorial-plane objects)
 *     └─ geocoronaTorus  equatorial geocorona H density enhancement torus
 *
 * ── Physics references ──────────────────────────────────────────────────────
 *  Hodges (1994) JGR 99(A12): exosphere H density model, charge exchange cross-sections
 *  Baliukin et al. (2019) JGR: SOHO/SWAN geocorona observations (nose ~8–9 Re quiet,
 *    compressed to ~5 Re during high-pressure solar wind)
 *  Hedelt et al. (2011): exopause pressure-balance analytic model
 *  Shue et al. (1998): profile functional form reused for exopause geometry
 *
 * ── Solar wind boundary condition ───────────────────────────────────────────
 *  The exopause standoff distance is computed from pressure balance:
 *    P_sw(ram) = P_exo(thermal)  →  r_nose ∝ P_sw^{-0.15}
 *  Higher solar wind dynamic pressure → exopause compressed sunward.
 *  Southward IMF (negative Bz) opens magnetosphere cusps, enhancing neutral
 *  atmospheric escape and charge-exchange production at the exopause.
 *
 * ── Exported API ───────────────────────────────────────────────────────────
 *  ExosphereEngine         class  — create once, call .update() + .tick()
 *  computeExopause         physics function — exopause standoff + escape rates
 */

import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
//  GLSL: Exosphere shell — Fresnel glow + solar-wind-driven surface waves
// ─────────────────────────────────────────────────────────────────────────────

const EXO_VERT = /* glsl */`
    uniform float u_time;
    uniform float u_escape_norm;    // 0–1  wave amplitude driver (solar wind escape rate)
    uniform float u_pdyn_norm;      // 0–1  normalised solar wind dynamic pressure
    uniform vec3  u_sun_dir;        // world-space unit vector toward sun

    varying vec3  vNormal;
    varying vec3  vWorldPos;
    varying float vSunDot;          // +1 = subsolar, -1 = anti-solar

    void main() {
        vec3 pos = position;

        // Solar-wind-driven Alfvénic surface waves:
        // Amplitude scales with pressure + escape rate; two orthogonal modes.
        float amp  = 0.013 * (0.4 + u_escape_norm * 0.5 + u_pdyn_norm * 0.4);
        float wave = sin(pos.y * 3.4 + u_time * 0.71)
                   * cos(pos.x * 2.7 + u_time * 0.48 + pos.z * 1.9) * amp;
        pos += normal * wave;

        vec4 worldPos4 = modelMatrix * vec4(pos, 1.0);
        vWorldPos = worldPos4.xyz;
        vNormal   = normalize(normalMatrix * normal);
        vSunDot   = dot(normalize(vWorldPos), u_sun_dir);

        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
`;

const EXO_FRAG = /* glsl */`
    uniform float u_time;
    uniform float u_escape_norm;
    uniform float u_pdyn_norm;
    uniform float u_bz_south;       // 0–1  southward Bz fraction (drives reconnection glow)

    varying vec3  vNormal;
    varying vec3  vWorldPos;
    varying float vSunDot;

    void main() {
        // Fresnel factor: brightest at grazing angles (limb of exosphere)
        vec3  viewDir = normalize(cameraPosition - vWorldPos);
        float cosI    = abs(dot(vNormal, viewDir));
        float fresnel = pow(1.0 - cosI, 2.0);

        // Day/night fraction: 0 = anti-solar, 1 = sub-solar
        float dayFrac = clamp(vSunDot * 0.5 + 0.5, 0.0, 1.0);

        // Geocoronal hydrogen Lyman-alpha scattering palette
        //   Dayside  — pale cyan-white  (scattered solar UV 121.6 nm)
        //   Nightside — deep indigo-blue (faint airglow + recombination)
        vec3 colDay   = vec3(0.60, 0.88, 1.00);
        vec3 colNight = vec3(0.12, 0.24, 0.72);
        vec3 color    = mix(colNight, colDay, dayFrac);

        // Southward Bz reconnection glow: enhanced blue emission at dayside exopause
        color += vec3(0.00, 0.08, 0.40) * u_bz_south * dayFrac * fresnel;

        // Solar wind compression brightening at exopause boundary
        color += vec3(0.08, 0.18, 0.35) * u_pdyn_norm * fresnel;

        // Subtle time-varying shimmer — Alfvén waves propagating through exosphere
        float shimmer = 0.5 + 0.5 * sin(
            u_time * 1.35
            + vWorldPos.x * 5.2
            + vWorldPos.y * 4.1
            + vWorldPos.z * 3.6
        );

        // Opacity: dominated by Fresnel edge glow; faint translucent fill on dayside
        float opacity = fresnel * (0.22 + u_pdyn_norm * 0.14)
                      + dayFrac  * 0.025
                      + shimmer  * 0.014 * u_escape_norm;

        gl_FragColor = vec4(color, clamp(opacity, 0.0, 0.55));
    }
`;

// ─────────────────────────────────────────────────────────────────────────────
//  Physics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute exopause standoff and solar-wind interaction parameters.
 *
 * The exopause is where solar wind charge exchange with geocoronal neutral
 * hydrogen (H_exo + p_sw → H⁺_fast + H_ENA) becomes the dominant loss process.
 * Standoff computed from pressure balance:
 *   P_ram(r_nose) = n_sw × m_p × v_sw²  =  P_geocorona_thermal(r_nose)
 * Calibrated to SOHO/SWAN observations: ~8 Re quiet, ~4–5 Re during major storms.
 *
 * @param {number} n    solar wind proton density (n/cm³)
 * @param {number} v    solar wind speed (km/s)
 * @param {number} bz   IMF Bz in GSM coordinates (nT, positive = northward)
 * @param {number} kp   Kp planetary index (0–9)
 * @returns {{ r_nose, alpha, pdyn, escape_norm, cx_norm }}
 *   r_nose      — subsolar exopause standoff (Re)
 *   alpha       — tail-flaring exponent (dimensionless; same profile as Shue model)
 *   pdyn        — solar wind dynamic pressure (nPa)
 *   escape_norm — normalised neutral escape rate [0,1]
 *   cx_norm     — normalised charge-exchange production rate [0,1]
 */
export function computeExopause(n = 5, v = 400, bz = 0, kp = 2) {
    const pdyn     = 1.67e-6 * Math.max(0.5, n) * Math.max(200, v) ** 2;   // nPa
    const pdynSafe = Math.max(0.1, pdyn);

    // Exopause nose: soft pressure-balance — less steep than magnetopause
    // (geocorona density gradient is shallower than magnetic pressure gradient)
    // ~7.5 Re at 1.5 nPa; compressed to ~3.5 Re at 8 nPa
    const r_nose = Math.max(2.5, Math.min(9.5,
        7.5 * Math.pow(pdynSafe / 1.5, -0.15)
    ));

    // Flaring exponent: storms open magnetosphere cusps → exosphere eroded faster
    // Higher Kp → more open, stretched shape
    const alpha = Math.max(0.68, Math.min(1.25,
        0.85 + 0.05 * (kp / 9) - 0.01 * Math.max(0, -bz / 4)
    ));

    // Neutral escape rate: driven by southward Bz (reconnection), speed, and Kp
    const escape_norm = Math.min(1,
          Math.max(0, -bz) / 20 * 0.45
        + Math.max(0, v - 300) / 600 * 0.30
        + kp / 9 * 0.25
    );

    // Charge-exchange (ENA) production rate: ∝ n_sw × v_sw (ram flux)
    const cx_norm = Math.min(1, (pdynSafe / 5) * 0.65 + (Math.min(1, v / 700)) * 0.35);

    return { r_nose, alpha, pdyn, escape_norm, cx_norm };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Geometry builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the exopause profile for THREE.LatheGeometry.
 * Uses the same Shue-model functional form as the magnetopause profile:
 *   r(θ) = r_nose × (2 / (1 + cos θ))^alpha
 * Profile in XY plane; LatheGeometry revolves around Y (+Y → sun).
 */
function exoProfile(r_nose, alpha, nPts = 64) {
    const theta_max = Math.PI * 0.83;   // stop before tail fully opens
    const pts = [];
    for (let i = 0; i <= nPts; i++) {
        const theta = (i / nPts) * theta_max;
        const r     = r_nose * Math.pow(2 / (1 + Math.cos(theta)), alpha);
        pts.push(new THREE.Vector2(
            r * Math.sin(theta),    // transverse radius (LatheGeometry X)
            r * Math.cos(theta),    // along sun-line (LatheGeometry Y)
        ));
    }
    return pts;
}

function buildExoShaderMesh(r_nose, alpha, uniforms) {
    const profile = exoProfile(r_nose, alpha);
    const geo     = new THREE.LatheGeometry(profile, 48);
    geo.computeVertexNormals();
    const mat = new THREE.ShaderMaterial({
        vertexShader:   EXO_VERT,
        fragmentShader: EXO_FRAG,
        uniforms,
        transparent: true,
        depthWrite:  false,
        side:        THREE.DoubleSide,
        blending:    THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 6;
    return mesh;
}

function buildExoWire(r_nose, alpha) {
    const profile = exoProfile(r_nose, alpha);
    const geo     = new THREE.LatheGeometry(profile, 36);
    const mat     = new THREE.MeshBasicMaterial({
        color:       0x44bbff,
        transparent: true,
        opacity:     0.28,
        wireframe:   true,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 6;
    return mesh;
}

/**
 * Charge-exchange standoff annulus — a slightly wider wireframe shell marking
 * where solar wind protons pick up geocoronal electrons (ENA production zone).
 * Sits at r_nose × 1.10, slightly more blunt (smaller alpha).
 */
function buildChExHalo(r_nose, alpha) {
    const profile = exoProfile(r_nose * 1.10, Math.max(0.62, alpha - 0.14), 48);
    const geo     = new THREE.LatheGeometry(profile, 24);
    const mat     = new THREE.MeshBasicMaterial({
        color:       0xfff0aa,
        transparent: true,
        opacity:     0.10,
        wireframe:   true,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 6;
    return mesh;
}

/**
 * Anti-solar neutral-H escape plume — open truncated cone extending in -Y
 * (anti-sun direction), representing the comet-like H tail driven by solar
 * radiation pressure and solar wind pick-up.
 */
function buildTailStream(r_nose) {
    const len = r_nose * 2.2;
    const r1  = r_nose * 0.58;    // anti-solar end (wider)
    const r2  = r_nose * 0.18;    // Earth-side end (narrower)
    const geo = new THREE.CylinderGeometry(r2, r1, len, 24, 1, true);
    const mat = new THREE.MeshBasicMaterial({
        color:      0x1a4488,
        transparent: true,
        opacity:    0.04,
        side:       THREE.BackSide,
        depthWrite: false,
        blending:   THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // Position: anti-solar (-Y from sun-aligned group), offset so base meets exopause tail
    mesh.position.set(0, -(len / 2 + r_nose * 0.07), 0);
    mesh.renderOrder = 5;
    return mesh;
}

/**
 * Equatorial geocorona torus — enhanced neutral H density in the equatorial
 * plane (gravitational focusing + magnetic equatorial trapping).
 * Radius ≈ 55% of exopause nose, capped at 4.5 Re.
 */
function buildGeocoronaTorus(r_nose) {
    const radius = Math.min(r_nose * 0.55, 4.5);
    const tube   = radius * 0.20;
    const geo    = new THREE.TorusGeometry(radius, tube, 16, 64);
    const mat    = new THREE.MeshBasicMaterial({
        color:      0x33aaff,
        transparent: true,
        opacity:    0.065,
        blending:   THREE.AdditiveBlending,
        depthWrite: false,
        side:       THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 5;
    return mesh;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ExosphereEngine
// ─────────────────────────────────────────────────────────────────────────────

export class ExosphereEngine {
    /**
     * @param {THREE.Scene} scene
     */
    constructor(scene) {
        this._scene = scene;

        // Sun-aligned group: exopause shell, charge-exchange halo, escape tail
        this._solarGroup = new THREE.Group();
        this._solarGroup.name = 'exosphere_solar';
        scene.add(this._solarGroup);

        // Equatorial group: geocorona torus (not solar-wind-aligned)
        this._eqGroup = new THREE.Group();
        this._eqGroup.name = 'exosphere_eq';
        scene.add(this._eqGroup);

        // ShaderMaterial uniforms shared across rebuild cycles
        this._uniforms = {
            u_time:        { value: 0 },
            u_escape_norm: { value: 0 },
            u_pdyn_norm:   { value: 0 },
            u_bz_south:    { value: 0 },
            u_sun_dir:     { value: new THREE.Vector3(1, 0, 0) },
        };

        this._lastRNose   = -1;
        this._lastAlpha   = -1;
        this._targetRNose = null;
        this._targetAlpha = null;

        this._layers = {
            exosphere: true,
            geocorona: true,
            chex:      true,
        };

        this.analysis = null;

        // Build with nominal solar wind values
        this._rebuild(7.5, 0.85);
        this._rebuildEq(7.5);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Update exosphere geometry from SWPC feed state.
     * Call inside the 'swpc-update' event handler.
     */
    update(state) {
        const sw  = state.solar_wind ?? {};
        const n   = Math.max(0.5,  sw.density ?? 5);
        const v   = Math.max(200,  sw.speed   ?? 400);
        const bz  = sw.bz  ?? 0;
        const kp  = state.kp ?? 2;

        const { r_nose, alpha, pdyn, escape_norm, cx_norm } = computeExopause(n, v, bz, kp);

        // Store target for smooth per-frame interpolation ("breathing")
        this._targetRNose = r_nose;
        this._targetAlpha = alpha;

        // Rebuild geometry only on large shape changes (avoids GC churn)
        if (Math.abs(r_nose - this._lastRNose) > 0.28 || Math.abs(alpha - this._lastAlpha) > 0.04) {
            this._rebuild(r_nose, alpha);
            this._rebuildEq(r_nose);
            this._lastRNose = r_nose;
            this._lastAlpha = alpha;
        }

        this.analysis = { r_nose, alpha, pdyn, escape_norm, cx_norm };
    }

    /**
     * Per-frame update — orient to sun and animate shader uniforms.
     * Call from animate() every frame.
     *
     * @param {number}        t       elapsed seconds
     * @param {THREE.Vector3} sunDir  world-space unit vector toward sun
     * @param {object}        sw      SWPC feed state (last known)
     */
    tick(t, sunDir, sw = {}) {
        // Orient solar group: +Y → sun (same convention as MagnetosphereEngine)
        const q = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            sunDir.clone().normalize(),
        );
        this._solarGroup.setRotationFromQuaternion(q);

        // ── Smooth breathing: interpolate scale toward target r_nose ──────
        // This makes the exosphere visibly compress/expand each frame
        // as solar wind pressure changes, instead of jumping on thresholds.
        if (this._targetRNose != null && this._lastRNose > 0) {
            const targetScale = this._targetRNose / this._lastRNose;
            const currentScale = this._solarGroup.scale.x;
            // Smooth exponential ease toward target (τ ≈ 0.5 second)
            const lerp = 1.0 - Math.exp(-3.0 * 0.016);  // ~60 fps
            const s = currentScale + (targetScale - currentScale) * lerp;
            this._solarGroup.scale.setScalar(s);
            // Also breathe the equatorial group
            if (this._eqGroup) this._eqGroup.scale.setScalar(s);
        }

        // Derive live scalar quantities
        const wind     = sw.solar_wind ?? {};
        const bz       = wind.bz      ?? 0;
        const speed    = wind.speed   ?? 400;
        const density  = wind.density ?? 5;
        const kp       = sw.kp        ?? 2;
        const pdyn     = 1.67e-6 * Math.max(0.5, density) * Math.max(200, speed) ** 2;
        const pdynNorm = Math.min(1, pdyn / 5);
        const bzSouth  = Math.max(0, Math.min(1, -bz / 25));
        const escNorm  = Math.min(1,
              Math.max(0, -bz) / 20 * 0.45
            + Math.max(0, speed - 300) / 600 * 0.30
            + kp / 9 * 0.25
        );

        // ── Shader uniforms ────────────────────────────────────────────────
        this._uniforms.u_time.value        = t;
        this._uniforms.u_escape_norm.value = escNorm;
        this._uniforms.u_pdyn_norm.value   = pdynNorm;
        this._uniforms.u_bz_south.value    = bzSouth;
        this._uniforms.u_sun_dir.value.copy(sunDir).normalize();

        // ── Exopause wireframe ─────────────────────────────────────────────
        // Teal → electric blue as solar wind compresses the exopause
        // Pulses more intensely with southward Bz (reconnection-driven erosion)
        if (this._exoWire) {
            const r = Math.round(20  + pdynNorm * 55  + bzSouth * 20);
            const g = Math.round(145 + pdynNorm * 35  - bzSouth * 55);
            const b = Math.round(210 + pdynNorm * 45);
            this._exoWire.material.color.setRGB(r / 255, g / 255, Math.min(1, b / 255));
            this._exoWire.material.opacity = 0.20 + pdynNorm * 0.22 + bzSouth * 0.14;
        }

        // ── Charge-exchange halo ───────────────────────────────────────────
        // Pulses with solar wind proton flux (n × v); warm gold-white
        if (this._chExHalo) {
            const cxNorm = Math.min(1, pdynNorm * 0.65 + Math.min(1, speed / 700) * 0.35);
            const pulse  = 0.5 + 0.5 * Math.sin(t * 1.05 + cxNorm * Math.PI);
            this._chExHalo.material.opacity = 0.05 + cxNorm * 0.15 + pulse * 0.04;
            this._chExHalo.material.color.setRGB(
                0.80 + cxNorm * 0.20,
                0.86 + cxNorm * 0.08,
                0.60 + cxNorm * 0.20,
            );
        }

        // ── Neutral-H escape tail ──────────────────────────────────────────
        // Brightens as escape rate rises (southward Bz + storm)
        if (this._tailStream) {
            this._tailStream.material.opacity = 0.03 + escNorm * 0.08 + bzSouth * 0.03;
        }

        // ── Geocorona equatorial torus ─────────────────────────────────────
        // Gentle slow pulse; dims slightly during storms (exosphere eroded)
        if (this._geocoronaTorus) {
            this._geocoronaTorus.material.opacity =
                0.055 - escNorm * 0.02 + 0.018 * Math.sin(t * 0.55 + 0.4);
        }
    }

    /** Toggle a named layer on/off. */
    setLayerVisible(name, v) {
        this._layers[name] = v;
        switch (name) {
            case 'exosphere':
                if (this._exoFill)    this._exoFill.visible    = v;
                if (this._exoWire)    this._exoWire.visible    = v;
                if (this._tailStream) this._tailStream.visible = v;
                break;
            case 'geocorona':
                if (this._geocoronaTorus) this._geocoronaTorus.visible = v;
                break;
            case 'chex':
                if (this._chExHalo) this._chExHalo.visible = v;
                break;
        }
    }

    dispose() {
        [this._solarGroup, this._eqGroup].forEach(g => {
            g.traverse(o => {
                o.geometry?.dispose();
                o.material?.dispose();
            });
            this._scene.remove(g);
        });
    }

    // ── Internal geometry builders ────────────────────────────────────────────

    _rebuild(r_nose, alpha) {
        // Dispose old meshes
        while (this._solarGroup.children.length) {
            const c = this._solarGroup.children[0];
            c.geometry?.dispose();
            c.material?.dispose();
            this._solarGroup.remove(c);
        }

        // 1. Exosphere fill: ShaderMaterial (Fresnel glow + wave animation)
        this._exoFill = buildExoShaderMesh(r_nose, alpha, this._uniforms);
        this._solarGroup.add(this._exoFill);

        // 2. Exopause wireframe overlay
        this._exoWire = buildExoWire(r_nose, alpha);
        this._solarGroup.add(this._exoWire);

        // 3. Charge-exchange standoff halo (slightly outside exopause)
        this._chExHalo = buildChExHalo(r_nose, alpha);
        this._solarGroup.add(this._chExHalo);

        // 4. Anti-solar neutral-H escape plume
        this._tailStream = buildTailStream(r_nose);
        this._solarGroup.add(this._tailStream);

        // Apply current visibility state
        if (!this._layers.exosphere) {
            if (this._exoFill)    this._exoFill.visible    = false;
            if (this._exoWire)    this._exoWire.visible    = false;
            if (this._tailStream) this._tailStream.visible = false;
        }
        if (!this._layers.chex) this._chExHalo.visible = false;
    }

    _rebuildEq(r_nose) {
        while (this._eqGroup.children.length) {
            const c = this._eqGroup.children[0];
            c.geometry?.dispose();
            c.material?.dispose();
            this._eqGroup.remove(c);
        }

        this._geocoronaTorus = buildGeocoronaTorus(r_nose);
        this._eqGroup.add(this._geocoronaTorus);

        if (!this._layers.geocorona) this._geocoronaTorus.visible = false;
    }
}
