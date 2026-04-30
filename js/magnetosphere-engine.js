/**
 * MagnetosphereEngine — real-time magnetosphere geometry + ionospheric analysis
 *
 * Scene layout (Earth at origin, R_E = 1 Three.js unit):
 *
 *   _solarGroup  (world-space Group, Y-axis aligned toward sun each frame)
 *     ├─ magnetosheath      compressed solar wind between bow shock and magnetopause
 *     ├─ magnetopauseFill   Shue-1998 parametric surface, translucent fill
 *     ├─ magnetopauseWire   same surface, wireframe overlay
 *     ├─ bowShockWire       Farris-Russell bow shock, wireframe
 *     ├─ reconnXLine        dayside X-line reconnection glow (Bz-southward driven)
 *     ├─ polarCusps         pair of funnel cones at ±magnetic cusp entry regions
 *     └─ tail               flattened cylinder in the anti-solar lobe
 *
 *   _eqGroup  (world-space Group at origin, equatorial-plane objects, no rotation)
 *     ├─ innerBelt    Van Allen inner belt torus  ~1.6 Re additive blue
 *     ├─ outerBelt    Van Allen outer belt torus  ~4–6 Re additive orange
 *     └─ plasmasphere plasmapause torus           ~Lpp Re  additive cyan
 *
 * ── Physics references ─────────────────────────────────────────────────────
 *  Shue et al. (1998) JGR 103(A8): magnetopause standoff model
 *  Farris & Russell (1994) JGR: bow shock model
 *  Carpenter & Anderson (1992): plasmapause empirical formula
 *  O'Brien & McPherron (2002): ring current Dst injection model
 *  IRI-2016 (simplified): ionospheric layer parameters
 *
 * ── Exported API ───────────────────────────────────────────────────────────
 *  MagnetosphereEngine   class  — create once, call .update() + .tick()
 *  computeShue           physics function
 *  computePlasmapause    physics function
 *  computeIonoLayers     physics function
 *  computeRingCurrentDst physics function
 *  computeJouleHeating   physics function
 */

import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
//  Physical constants and helpers
// ─────────────────────────────────────────────────────────────────────────────
const DEG = Math.PI / 180;

/**
 * Shue et al. (1998) magnetopause standoff model.
 *
 * Returns { r0, alpha, pdyn } where:
 *   r0    — subsolar magnetopause distance (Earth radii)
 *   alpha — magnetopause flaring parameter (dimensionless)
 *   pdyn  — solar wind dynamic pressure (nPa)
 *
 * Inputs:
 *   n  — solar wind proton density (n/cm³)
 *   v  — solar wind speed (km/s)
 *   bz — IMF Bz component in GSM (nT, positive = northward)
 *
 * Valid range: n 1–50 n/cm³, v 250–900 km/s, Bz −30 to +15 nT
 */
export function computeShue(n = 5, v = 400, bz = 0) {
    const pdyn = 1.67e-6 * n * v * v;          // nPa (1.67e-6 = m_p in kg × 1e-12 unit conv)
    const pdynSafe = Math.max(0.05, pdyn);

    const r0 = Math.max(3.5,
        (10.22 + 1.29 * Math.tanh(0.184 * (bz + 8.14)))
        * Math.pow(pdynSafe, -1 / 6.6)
    );
    const alpha = Math.max(0.30,
        (0.58 - 0.007 * bz) * (1 + 0.024 * Math.log(pdynSafe))
    );
    return { r0, alpha, pdyn };
}

/**
 * Bow shock standoff — empirical fit to Farris & Russell (1994).
 * r_bs ≈ r_mp + (0.14 × r_mp + 1.6) with a minimum separation of 1.5 Re.
 */
export function computeBowShock(r0, alpha) {
    const rBs = Math.max(r0 + 1.5, r0 * 1.14 + 1.0);
    // Bow shock is more blunt than magnetopause (smaller alpha)
    return { r0: rBs, alpha: Math.max(0.30, alpha - 0.08) };
}

/**
 * Plasmapause L-shell location (Earth radii).
 * Carpenter & Anderson (1992): Lpp ≈ 5.6 − 0.46 × Kp_max
 * We use current Kp as a proxy for 24-h Kp_max.
 */
export function computePlasmapause(kp = 2) {
    return Math.max(1.8, Math.min(6.5, 5.6 - 0.46 * kp));
}

/**
 * Ring current Dst proxy (nT) using simplified O'Brien & McPherron (2002).
 * Negative = ring current injection (storm main phase).
 *   dDst/dt ≈ Q(Bz, v) − Dst/τ   τ ≈ 7 h recovery time constant
 * We return a rough steady-state approximation:
 *   Dst_ss ≈ τ × Q  where Q ≈ -4.4(VBs - 0.49) for VBs > 0.49 mV/m
 *   VBs = v × max(0, -Bz) × 1e-3  (dawn-dusk electric field, mV/m)
 */
export function computeRingCurrentDst(kp = 2, pdyn = 1.3, bz = 0) {
    const v       = 400;   // approx solar wind speed from pdyn
    const VBs     = v * Math.max(0, -bz) * 1e-3;   // mV/m
    const Q       = VBs > 0.49 ? -4.4 * (VBs - 0.49) : 0;  // nT/h
    const tau     = 7;     // hours recovery time constant
    const Dst_inj = Q * tau;
    // Add quiet-time Dst from dynamic pressure term (pressure-related ring current)
    const Dst_pdyn = -7.26 * Math.sqrt(Math.max(0.1, pdyn));
    return Math.max(-600, Math.min(30, Dst_inj + Dst_pdyn));
}

/**
 * Joule heating rate in the auroral ionosphere (GW).
 * Proxy: Q_J ≈ 0.15 × Kp² + 0.4 × Kp  (simplified, valid ≈ 1–100 GW range)
 * Reference: Emery et al. (1999) auroral Joule heating statistics.
 */
export function computeJouleHeating(kp = 2) {
    return Math.max(0.5, 0.15 * kp * kp + 0.4 * kp);  // GW
}

/**
 * Ionospheric layer analysis — simplified IRI-2016 parameterization.
 *
 * Returns an object describing the four main layers:
 *   dLayerAbs   — D-layer HF absorption at 10 MHz (dB) — dayside only
 *   foE         — E-layer critical frequency (MHz)
 *   foF2        — F2-layer critical frequency (MHz)  [highest daytime frequency]
 *   hmF2        — F2-layer peak height (km)
 *   tec         — Total Electron Content (TECU = 10^16 el/m²)
 *   eLayerNorm  — normalised E-layer electron density [0,1]
 *   f2Active    — true if foF2 > 6 MHz (strongly ionized)
 *   blackout    — true if D-layer absorption > 10 dB (HF radio blackout)
 *
 * @param {number} f107    F10.7 solar radio flux (sfu, 65–300 typical)
 * @param {number} kp      Planetary K-index (0–9)
 * @param {number} xray    GOES X-ray flux (W/m², 1e-9 to 1e-2)
 * @param {number} szaDeg  Representative solar zenith angle (degrees, 0=subsolar)
 */
export function computeIonoLayers(f107 = 150, kp = 2, xray = 1e-8, szaDeg = 50) {
    const cosZ    = Math.max(0, Math.cos(szaDeg * DEG));
    const dayFac  = cosZ;            // 0 (night) → 1 (subsolar)
    const f107n   = (f107 - 65) / 235;   // 0 (min) → 1 (max), clamped below

    // D layer (60–90 km) — only exists on dayside, enhanced by solar X-rays
    // Chapman ionisation theory: absorption A ∝ √(X-ray flux) × cos(χ)
    const fluxRef    = 1e-5;   // M1.0 reference level
    const xrayRatio  = Math.sqrt(Math.max(0, xray) / fluxRef);
    const dLayerAbs  = dayFac * xrayRatio * 18.0;  // dB at 10 MHz
    const blackout   = dLayerAbs > 10;

    // E layer (100–150 km, peak ~110 km)
    // foE ≈ 0.9 × f(F10.7) × (cos χ)^0.25
    const foE = dayFac > 0.01
        ? 0.9 * (1 + 0.006 * f107) * Math.pow(cosZ, 0.25)
        : 0.5;   // weak night-time E

    // F2 layer (200–450 km)
    // foF2 depends on F10.7 (photoionisation) and Kp (storm-time depletion)
    // Quiet daytime mid-lat: ~7–12 MHz. Storm-time negative phase: −3 MHz typical.
    const foF2_quiet = 4.0 + 0.035 * f107 * (0.3 + 0.7 * dayFac);
    const stormDelta = kp > 4 ? -(kp - 4) * 0.7 : 0;  // negative storm phase
    const foF2 = Math.max(1.5, foF2_quiet + stormDelta);

    // F2 peak height: rises during storms, lower during solar max
    const hmF2 = 290 - 0.02 * f107 + kp * 8;   // km

    // TEC (total electron content, TECU = 10^16 el/m²)
    // Solar max noon quiet: ~100 TECU; solar min night: ~5 TECU
    const tec = Math.max(2,
        (10 + 0.4 * f107) * Math.pow(Math.max(0.01, cosZ), 0.6) * Math.max(0.1, 1 - 0.08 * kp)
    );

    return {
        dLayerAbs:  Math.max(0, dLayerAbs),
        foE:        Math.max(0, foE),
        foF2:       foF2,
        hmF2:       hmF2,
        tec:        tec,
        eLayerNorm: Math.min(1, dayFac * (1 + f107n * 0.5)),
        f2Active:   foF2 > 6,
        blackout,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Aurora curtain GLSL shaders
//
//  Physical aurora spectral lines (nanometres):
//    O(¹S) 557.7 nm  → green    dominant, 100–200 km altitude
//    O(¹D) 630.0 nm  → red      diffuse, > 200 km
//    N₂⁺   427.8 nm  → blue-violet  lower edge, < 100 km
//
//  The curtain geometry runs from R_BASE (surface) to R_TOP (~1.8 Re) at the
//  magnetic oval colatitude.  vHeight (0=bottom, 1=top) drives the colour
//  gradient and is the proxy for altitude in the fragment shader.
// ─────────────────────────────────────────────────────────────────────────────

const _AURORA_VERT = /* glsl */`
    attribute float a_height;
    attribute float a_phi;
    varying float   vHeight;
    varying float   vPhi;

    void main() {
        vHeight     = a_height;
        vPhi        = a_phi;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const _AURORA_FRAG = /* glsl */`
    precision highp float;

    uniform float u_time;
    uniform float u_kp_norm;
    uniform float u_bz_south;
    uniform float u_substorm_t;

    varying float vHeight;
    varying float vPhi;

    void main() {
        // ── Altitude-dependent spectral colours ──────────────────────────────
        vec3 lowCol  = vec3(0.03, 1.00, 0.28);
        vec3 midCol  = vec3(0.10, 0.82, 0.55);
        vec3 highCol = vec3(0.62, 0.14, 0.88);

        vec3 col;
        if (vHeight < 0.45) {
            col = mix(lowCol, midCol, vHeight / 0.45);
        } else {
            col = mix(midCol, highCol, (vHeight - 0.45) / 0.55);
        }

        // ── Curtain fold structure — azimuthal brightness variation ───────────
        float fold1 = 0.55 + 0.45 * sin(vPhi * 8.0 + u_time * 1.2);
        float fold2 = 0.70 + 0.30 * sin(vPhi * 14.0 - u_time * 2.5 + 1.0);

        // ── Curtain shimmer — rapid vertical streaks ──────────────────────────
        float s1 = 0.60 + 0.40 * sin(u_time * 5.4  + vHeight * 14.0 + vPhi * 3.0);
        float s2 = 0.72 + 0.28 * sin(u_time * 9.1  + vHeight * 23.0 + 1.57);
        float s3 = 0.80 + 0.20 * sin(u_time * 14.0 + vHeight *  8.0 + vPhi * 5.0);

        // ── Vertical intensity profile: bright band in middle, fade at edges ──
        float vFade = sin(vHeight * 3.14159) * (0.55 + 0.45 * pow(1.0 - vHeight, 0.5));

        // ── Kp + storm driving ────────────────────────────────────────────────
        float quiet  = 0.15 + u_kp_norm * 0.65;
        float stormy = u_bz_south * 0.42;
        float base   = clamp(quiet + stormy, 0.0, 1.3);

        // ── Substorm flash: brief surge (ripple up curtain height) ────────────
        float sbRipple = u_substorm_t * (0.5 + 0.5 * sin(u_time * 10.0 + vHeight * 10.0));
        float sbBoost  = sbRipple * 0.70;

        float alpha  = clamp(vFade * base * fold1 * fold2 * s1 * s2 * s3 + sbBoost, 0.0, 0.92);

        gl_FragColor = vec4(col, alpha);
    }
`;

// ─────────────────────────────────────────────────────────────────────────────
//  Geometry builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a Shue-model profile for THREE.LatheGeometry.
 * The profile is in the XY plane (X = transverse radius, Y = along sun-line).
 * LatheGeometry revolves around Y; we orient the group so +Y → sun.
 *
 * θ = 0  →  subsolar nose (X=0,  Y=r0)
 * θ = π/2 → equatorial flank (X=r_flank, Y=0)
 * θ → π  →  magnetotail opening (large X, negative Y)
 */
function shueProfile(r0, alpha, nPts = 64) {
    const theta_max = Math.PI * 0.87;   // stop before tail degenerates
    const pts = [];
    for (let i = 0; i <= nPts; i++) {
        const theta = (i / nPts) * theta_max;
        const r     = r0 * Math.pow(2 / (1 + Math.cos(theta)), alpha);
        pts.push(new THREE.Vector2(
            r * Math.sin(theta),   // radius from Y axis (LatheGeometry X)
            r * Math.cos(theta),   // height along Y axis
        ));
    }
    return pts;
}

// ── Fresnel surface shaders for magnetopause / bow shock ─────────────────────
const _FRESNEL_VERT = /* glsl */`
    varying vec3 vNormal;
    varying vec3 vViewDir;
    void main() {
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vNormal  = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
    }
`;

const _FRESNEL_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  u_color;
    uniform vec3  u_rim_color;
    uniform float u_base_alpha;
    uniform float u_rim_power;
    uniform float u_time;
    uniform float u_pulse;
    varying vec3 vNormal;
    varying vec3 vViewDir;
    void main() {
        float NdV = abs(dot(normalize(vNormal), normalize(vViewDir)));
        float fresnel = pow(1.0 - NdV, u_rim_power);
        vec3 col = mix(u_color, u_rim_color, fresnel);
        float pulse = 1.0 + u_pulse * 0.12 * sin(u_time * 0.8);
        float alpha = (u_base_alpha + fresnel * 0.35) * pulse;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.85));
    }
`;

/**
 * Build a Fresnel-rimmed Shue magnetopause or bow shock surface.
 * Single clean mesh — no wireframe overlay.
 */
function buildFresnelShue(r0, alpha, color, rimColor, baseAlpha, rimPower = 3.0) {
    const profile = shueProfile(r0, alpha, 80);
    const geo     = new THREE.LatheGeometry(profile, 64);
    const mat     = new THREE.ShaderMaterial({
        uniforms: {
            u_color:      { value: new THREE.Color(color) },
            u_rim_color:  { value: new THREE.Color(rimColor) },
            u_base_alpha: { value: baseAlpha },
            u_rim_power:  { value: rimPower },
            u_time:       { value: 0 },
            u_pulse:      { value: 0 },
        },
        vertexShader:   _FRESNEL_VERT,
        fragmentShader: _FRESNEL_FRAG,
        transparent: true,
        depthWrite:  false,
        side:        THREE.DoubleSide,
        blending:    THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 4;
    return mesh;
}

// ── Volumetric Van Allen belt shader ─────────────────────────────────────────
const _BELT_VERT = /* glsl */`
    varying vec3 vLocalPos;
    varying vec2 vUv;
    void main() {
        vLocalPos = position;
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const _BELT_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  u_color;
    uniform float u_opacity;
    uniform float u_time;
    uniform float u_noise_scale;
    varying vec3 vLocalPos;
    varying vec2 vUv;

    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i), b = hash(i + vec2(1,0)),
              c = hash(i + vec2(0,1)), d = hash(i + vec2(1,1));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    void main() {
        // Radial density: bright at tube center, fades at edges
        float tubeR = length(vec2(vUv.x - 0.5, vUv.y - 0.5)) * 2.0;
        float density = exp(-tubeR * tubeR * 2.0);
        // Non-uniform patches via noise
        float n = vnoise(vLocalPos.xz * u_noise_scale + u_time * 0.1);
        float patchiness = 0.6 + 0.4 * n;
        float alpha = u_opacity * density * patchiness;
        // Breathing animation
        alpha *= 0.85 + 0.15 * sin(u_time * 1.5 + vLocalPos.x * 3.0);
        gl_FragColor = vec4(u_color, clamp(alpha, 0.0, 0.75));
    }
`;

function buildVolumetricTorus(radius, tube, color, opacity, noiseScale = 2.0) {
    const geo = new THREE.TorusGeometry(radius, tube, 24, 96);
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            u_color:       { value: new THREE.Color(color) },
            u_opacity:     { value: opacity },
            u_time:        { value: 0 },
            u_noise_scale: { value: noiseScale },
        },
        vertexShader:   _BELT_VERT,
        fragmentShader: _BELT_FRAG,
        transparent: true,
        depthWrite:  false,
        side:        THREE.DoubleSide,
        blending:    THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    return mesh;
}

/**
 * Magnetosheath fill — compressed, heated solar wind plasma occupying the
 * region between the bow shock and magnetopause.
 * Rendered as the bow-shock LatheGeometry with BackSide + additive blending
 * so only the gap outside the opaque magnetopause fill is visible.
 */
function buildMagnetosheath(bs_r0, bs_alpha) {
    const profile = shueProfile(bs_r0, bs_alpha);
    const geo     = new THREE.LatheGeometry(profile, 32);
    const mat     = new THREE.MeshBasicMaterial({
        color:      0xff9944,
        transparent: true,
        opacity:    0.045,
        side:       THREE.BackSide,
        depthWrite: false,
        blending:   THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    return mesh;
}

/**
 * Dayside reconnection X-line glow.
 * A small emissive sphere sitting at the subsolar magnetopause nose (+Y in
 * the solarGroup).  Opacity and radius are driven by southward Bz in tick().
 * Two "jet" line segments extend from the nose along the magnetopause flanks
 * (±X), representing accelerated plasma outflow from the X-line.
 */
function buildReconnXLine(r0) {
    const group = new THREE.Group();
    group.name  = 'reconnXLine';

    // Glowing blob at the X-line
    const sGeo = new THREE.SphereGeometry(0.28, 10, 7);
    const sMat = new THREE.MeshBasicMaterial({
        color:      0xffffff,
        transparent: true,
        opacity:    0.0,
        blending:   THREE.AdditiveBlending,
        depthWrite: false,
    });
    const blob = new THREE.Mesh(sGeo, sMat);
    blob.name = 'blob';
    blob.position.set(0, r0, 0);
    group.add(blob);

    // Reconnection outflow jets (±X flanks, 2 Re long each)
    const jetPts = [
        new THREE.Vector3(-2.2, r0 * 0.97, 0),
        new THREE.Vector3( 0,   r0,        0),
        new THREE.Vector3( 2.2, r0 * 0.97, 0),
    ];
    const jGeo = new THREE.BufferGeometry().setFromPoints(jetPts);
    const jMat = new THREE.LineBasicMaterial({
        color:      0xffffff,
        transparent: true,
        opacity:    0.0,
        blending:   THREE.AdditiveBlending,
        depthWrite: false,
    });
    const jets = new THREE.Line(jGeo, jMat);
    jets.name = 'jets';
    group.add(jets);

    group.renderOrder = 8;
    return group;
}

/**
 * Polar cusp funnels — two open wireframe cones marking the dayside
 * magnetospheric cusps where solar wind particles directly enter along
 * open magnetic field lines.
 *
 * In the _solarGroup's local frame (+Y toward sun), the cusps sit at
 * approximately ±Z (roughly corresponding to geographic north and south),
 * offset sunward by ~0.75 × r0.  The cones open toward Earth (origin).
 */
function buildPolarCusps(r0, alpha) {
    const group = new THREE.Group();
    group.name  = 'polarCusps';

    // Cusp throat latitude ≈ 75–80° → θ ≈ 35° in Shue angle
    const thetaCusp = 36 * (Math.PI / 180);
    const r_c       = r0 * Math.pow(2 / (1 + Math.cos(thetaCusp)), alpha);
    const Y_cusp    = r_c * Math.cos(thetaCusp);   // along-sun offset
    const Z_cusp    = r_c * Math.sin(thetaCusp);   // north/south transverse

    for (const sign of [+1, -1]) {
        // Open wireframe cone, apex toward Earth, base outward
        const cGeo = new THREE.ConeGeometry(1.0, 2.2, 14, 1, true);
        const cMat = new THREE.MeshBasicMaterial({
            color:      0x44ffee,
            transparent: true,
            opacity:    0.12,
            wireframe:  true,
            depthWrite: false,
            blending:   THREE.AdditiveBlending,
        });
        const cone = new THREE.Mesh(cGeo, cMat);

        // Position cone at cusp entry; tilt apex toward Earth-centre
        cone.position.set(0, Y_cusp, sign * Z_cusp);
        // ConeGeometry points along +Y by default; rotate to point at origin
        const dir = new THREE.Vector3(0, -Y_cusp, -sign * Z_cusp).normalize();
        const q   = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 1, 0), dir
        );
        cone.setRotationFromQuaternion(q);
        cone.renderOrder = 7;
        group.add(cone);
    }
    return group;
}

/**
 * Build a 3D auroral curtain mesh for one hemisphere.
 *
 * The curtain is a ring of vertical quads placed at the auroral oval colatitude
 * (from the geographic pole).  Each quad extends radially from R_BASE to R_TOP
 * along the same polar direction vector, creating the characteristic "curtain"
 * morphology.  The GLSL shader maps height (0=base, 1=top) to spectral colour
 * and adds fast shimmer for realism.
 *
 * @param {number}  kp       Planetary K-index (0–9) — sets oval latitude
 * @param {boolean} isNorth  true = northern oval, false = southern oval
 * @returns {THREE.Mesh}
 */
function buildAuroralCurtains(kp, isNorth) {
    const N_SEG  = 180;     // segments around the oval (smoother)
    const R_BASE = 1.02;    // curtain bottom (just above surface, Re)
    const R_TOP  = 2.50;    // curtain top (~9600 km altitude, visually dramatic)
    const N_LAYERS = 3;     // concentric curtain layers for volumetric depth

    // Auroral oval colatitude θ from pole: expands equatorward during storms
    const auroralLat_deg = Math.max(50, 67 - kp * 1.5);
    const colatDeg       = 90 - auroralLat_deg;
    const theta          = colatDeg * DEG;
    const sign           = isNorth ? 1 : -1;
    const sinT           = Math.sin(theta);
    const cosT           = Math.cos(theta);

    // Build multi-layer curtain mesh
    const group = new THREE.Group();
    group.name = isNorth ? 'aurora_N' : 'aurora_S';

    for (let layer = 0; layer < N_LAYERS; layer++) {
        // Each layer at a slightly different radial offset for depth
        const rOffset = layer * 0.015;
        const rBase = R_BASE + rOffset;
        const rTop  = R_TOP  + rOffset;

        const posArr = [];
        const hArr   = [];
        const phiArr = [];
        const idxArr = [];

        for (let k = 0; k <= N_SEG; k++) {
            const phi  = (k / N_SEG) * Math.PI * 2;
            const cosP = Math.cos(phi);
            const sinP = Math.sin(phi);

            // Base vertex
            posArr.push(rBase * sinT * cosP, rBase * cosT * sign, rBase * sinT * sinP);
            hArr.push(0.0);
            phiArr.push(phi);

            // Top vertex
            posArr.push(rTop * sinT * cosP, rTop * cosT * sign, rTop * sinT * sinP);
            hArr.push(1.0);
            phiArr.push(phi);
        }

        for (let k = 0; k < N_SEG; k++) {
            const b0 = k * 2,       t0 = k * 2 + 1;
            const b1 = (k + 1) * 2, t1 = (k + 1) * 2 + 1;
            idxArr.push(b0, t0, t1,  b0, t1, b1);
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
        geo.setAttribute('a_height', new THREE.BufferAttribute(new Float32Array(hArr),   1));
        geo.setAttribute('a_phi',    new THREE.BufferAttribute(new Float32Array(phiArr), 1));
        geo.setIndex(idxArr);

        // Outer layers are slightly fainter for depth illusion
        const layerFade = 1.0 - layer * 0.2;

        const mat = new THREE.ShaderMaterial({
            uniforms: {
                u_time:       { value: 0 },
                u_kp_norm:    { value: Math.min(1, kp / 9) * layerFade },
                u_bz_south:   { value: 0 },
                u_substorm_t: { value: 0 },
            },
            vertexShader:   _AURORA_VERT,
            fragmentShader: _AURORA_FRAG,
            transparent:    true,
            depthWrite:     false,
            side:           THREE.DoubleSide,
            blending:       THREE.AdditiveBlending,
        });

        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 9 + layer;
        group.add(mesh);
    }

    group.renderOrder = 9;
    return group;
}

function buildTorus(radius, tube, color, opacity, segments = 48) {
    const geo  = new THREE.TorusGeometry(radius, tube, 16, segments);
    const mat  = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
        side:        THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    return mesh;
}

/**
 * Build 3D dipole magnetic field lines.
 *
 * A magnetic dipole field line satisfies  r = L sin²(θ)  where L is the
 * equatorial crossing distance in Earth radii and θ is colatitude from
 * the magnetic pole.  Each line is traced from pole to pole at fixed
 * longitude φ, creating the characteristic 3D "onion" shape.
 *
 * Multiple L-shells at multiple longitudes give a volumetric wireframe
 * of the inner magnetosphere — the single biggest visual cue that the
 * field is 3D, not flat.
 *
 * @param {number[]} lShells   L-shell values (e.g. [2, 3, 4.5, 6])
 * @param {number}   nLongs    longitudes per L-shell (e.g. 8)
 * @param {number}   color     base colour
 * @param {number}   opacity   base opacity
 * @returns {THREE.Group}
 */
function buildDipoleFieldLines(lShells, nLongs, color, opacity) {
    const group = new THREE.Group();
    group.name  = 'fieldLines';
    const PTS   = 80;

    for (const L of lShells) {
        const lOp = opacity * (1.0 - (L - lShells[0]) / (lShells[lShells.length - 1] - lShells[0] + 1) * 0.5);

        for (let j = 0; j < nLongs; j++) {
            const phi = (j / nLongs) * Math.PI * 2;
            const rawPts = [];

            for (let i = 0; i <= PTS; i++) {
                const theta = (8 + (i / PTS) * 164) * DEG;
                const sinT  = Math.sin(theta);
                const r     = L * sinT * sinT;
                if (r < 1.02) continue;
                rawPts.push(new THREE.Vector3(
                    r * sinT * Math.cos(phi),
                    r * Math.cos(theta),
                    r * sinT * Math.sin(phi),
                ));
            }

            if (rawPts.length < 4) continue;

            // Smooth with CatmullRom spline for cleaner curves
            const curve = new THREE.CatmullRomCurve3(rawPts, false, 'catmullrom', 0.5);
            const smoothPts = curve.getPoints(120);

            const geo = new THREE.BufferGeometry().setFromPoints(smoothPts);
            const mat = new THREE.LineBasicMaterial({
                color,
                transparent: true,
                opacity:     lOp,
                depthWrite:  false,
                blending:    THREE.AdditiveBlending,
            });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 2;
            group.add(line);
        }
    }
    return group;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MagnetosphereEngine
// ─────────────────────────────────────────────────────────────────────────────
export class MagnetosphereEngine {
    /**
     * @param {THREE.Scene}       scene
     * @param {THREE.Vector3Ref}  sunDirRef  — mutable reference to earthU.u_sun_dir.value
     */
    constructor(scene) {
        this._scene = scene;

        // ── Sun-aligned group (magnetopause, bow shock, tail) ──────────────
        this._solarGroup = new THREE.Group();
        this._solarGroup.name = 'magnetosphere_solar';
        scene.add(this._solarGroup);

        // ── Equatorial-plane group (radiation belts, plasmasphere) ─────────
        // NOT a child of earthMesh — radiation belts are quasi-static in
        // inertial space (aligned with magnetic equator, not rotating with Earth).
        this._eqGroup = new THREE.Group();
        this._eqGroup.name = 'magnetosphere_eq';
        scene.add(this._eqGroup);

        // Initial nominal solar-wind parameters
        this._lastR0    = -1;   // force build on first update()
        this._lastAlpha = -1;
        this._lastKp    = -1;

        this._layers = {
            magnetopause:  true,
            bowShock:      true,
            belts:         true,
            plasmasphere:  true,
            magnetosheath: true,
            cusps:         true,
            reconnection:  true,
            aurora:        true,
        };

        this.analysis = null;

        // Substorm flash state: set via setSubstorm(); decays in tick()
        this._substormT = 0;  // 0–1 flash intensity

        // Build with fallback values
        this._rebuildSolarShells(10.9, 0.58);
        this._rebuildEarthShells(2.0, computePlasmapause(2));
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Update geometry and analysis from a fresh SpaceWeatherFeed state object.
     * Call this inside the 'swpc-update' event handler.
     */
    update(state) {
        const sw  = state.solar_wind ?? {};
        const n   = Math.max(0.5,   sw.density     ?? 5);
        const v   = Math.max(200,   sw.speed       ?? 400);
        const bz  = sw.bz ?? 0;
        const kp  = state.kp       ?? 2;
        const f107= state.f107_flux ?? 150;
        const xr  = state.xray_flux ?? 1e-8;

        const { r0, alpha, pdyn } = computeShue(n, v, bz);
        const bs = computeBowShock(r0, alpha);

        // Rebuild solar shells only on significant change (avoids GC pressure)
        if (Math.abs(r0 - this._lastR0) > 0.25 || Math.abs(alpha - this._lastAlpha) > 0.03) {
            this._rebuildSolarShells(r0, alpha);
            this._lastR0    = r0;
            this._lastAlpha = alpha;
        }

        // Rebuild Earth shells on Kp change
        if (Math.abs(kp - this._lastKp) > 0.4) {
            const lpp = computePlasmapause(kp);
            this._rebuildEarthShells(kp, lpp);
            this._lastKp = kp;
        }

        // Compute analysis metrics
        this.analysis = {
            r0,
            alpha,
            pdyn,
            bowShockR0:  bs.r0,
            plasmapause: computePlasmapause(kp),
            dst:         computeRingCurrentDst(kp, pdyn, bz),
            joule:       computeJouleHeating(kp),
            iono:        computeIonoLayers(f107, kp, xr, state?.szaDeg ?? 50),
            kp,
        };
    }

    /**
     * Per-frame update. Call from animate().
     * @param {number}          t       elapsed seconds
     * @param {THREE.Vector3}   sunDir  world-space unit vector toward sun
     * @param {object}          sw      swpc-feed state (optional; uses last if omitted)
     * @param {number}          dt      frame delta-time (s, default 1/60)
     */
    tick(t, sunDir, sw = {}, dt = 1 / 60) {
        // Orient solar group: +Y → sun direction
        const q = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            sunDir.clone().normalize(),
        );
        this._solarGroup.setRotationFromQuaternion(q);

        // ── Derive live quantities ─────────────────────────────────────────
        const wind    = sw.solar_wind ?? {};
        const bz      = wind.bz      ?? 0;
        const speed   = wind.speed   ?? 400;
        const density = wind.density ?? 5;
        const kp      = sw.kp        ?? (sw.geomagnetic?.kp ?? 2);
        const dst     = sw.dst_index ?? (sw.geomagnetic?.dst_nT ?? -5);
        const sep     = sw.sep_storm_level ?? (sw.particles?.sep_storm_level ?? 0);
        const pdyn    = 1.67e-6 * Math.max(0.5, density) * Math.max(200, speed) ** 2; // nPa

        // ── Magnetopause Fresnel — colour shifts blue→magenta with southward Bz ──
        const bzSouth = Math.max(0, Math.min(1, -bz / 30));  // 0=north, 1=−30 nT
        if (this._mpFresnel) {
            const u = this._mpFresnel.material.uniforms;
            u.u_time.value = t;
            // Shift rim colour from cyan to magenta during reconnection
            u.u_rim_color.value.setRGB(
                0.40 + bzSouth * 0.55,
                0.73 - bzSouth * 0.40,
                1.0  - bzSouth * 0.15,
            );
            u.u_base_alpha.value = 0.04 + bzSouth * 0.08;
            u.u_pulse.value = bzSouth;
        }

        // ── Bow shock Fresnel — intensity pulses with dynamic pressure ──────
        const pdynNorm = Math.min(1, pdyn / 6);
        if (this._bsFresnel) {
            const u = this._bsFresnel.material.uniforms;
            u.u_time.value = t;
            u.u_base_alpha.value = 0.02 + pdynNorm * 0.06;
            u.u_pulse.value = pdynNorm;
            // Hotter colour at high pressure
            u.u_rim_color.value.setRGB(1.0, 0.67 + pdynNorm * 0.25, 0.27 - pdynNorm * 0.1);
        }

        // Hoist kpNorm / sepNorm so all new blocks below can use them
        const kpNorm  = Math.min(1, kp / 9);
        const sepNorm = Math.min(1, sep / 5);

        // ── Magnetosheath — brightens with dynamic pressure ────────────────
        if (this._magnetosheath) {
            const msPulse = 0.5 + 0.5 * Math.sin(t * 0.6 + pdynNorm * 2.5);
            this._magnetosheath.material.opacity = 0.028 + pdynNorm * 0.030 + msPulse * 0.010;
            // Colour: cools from orange toward yellow under high density
            const densNorm = Math.min(1, density / 20);
            this._magnetosheath.material.color.setRGB(
                1.0,
                0.50 + densNorm * 0.30,
                0.10 + densNorm * 0.10,
            );
        }

        // ── Dayside reconnection X-line ────────────────────────────────────
        // Only activated by southward Bz (magnetic reconnection requires Bz < 0)
        if (this._reconnXLine) {
            const blob = this._reconnXLine.getObjectByName('blob');
            const jets = this._reconnXLine.getObjectByName('jets');
            // Reconnection intensity: peaks at Bz ≈ −15 nT, saturates beyond
            const reconn = bzSouth * bzSouth;   // quadratic: more sensitive at onset
            const pulse  = 0.5 + 0.5 * Math.sin(t * 3.5 + reconn * Math.PI);
            if (blob) {
                blob.material.opacity = reconn * (0.55 + pulse * 0.30);
                // Colour: white-hot at peak reconnection, fades to pale blue
                const r = 0.70 + reconn * 0.30;
                const g = 0.55 + reconn * 0.25;
                const b = 1.00;
                blob.material.color.setRGB(r, g, b);
                blob.scale.setScalar(1 + reconn * 0.6 + pulse * 0.2);
            }
            if (jets) {
                jets.material.opacity = reconn * (0.35 + pulse * 0.20);
                jets.material.color.setRGB(0.6 + reconn * 0.4, 0.7, 1.0);
            }
        }

        // ── Polar cusps — widen + brighten during storms ───────────────────
        if (this._polarCusps) {
            this._polarCusps.children.forEach(cone => {
                // Cusps open wider and glow more during active conditions
                const cuspOpen = 0.08 + kpNorm * 0.12 + bzSouth * 0.08;
                cone.material.opacity = cuspOpen;
                // Electric cyan during quiet times, shift toward white-green in storms
                const r = kpNorm * 0.30;
                const g = 0.85 + kpNorm * 0.15;
                const b = 0.85 + (1 - kpNorm) * 0.15;
                cone.material.color.setRGB(r, g, b);
            });
        }

        // ── Radiation belt volumetric shader updates ──────────────────────
        if (this._outerBelt?.material?.uniforms) {
            const u = this._outerBelt.material.uniforms;
            u.u_time.value = t;
            u.u_opacity.value = 0.22 + kpNorm * 0.14 + sepNorm * 0.10;
        }
        if (this._innerBelt?.material?.uniforms) {
            const u = this._innerBelt.material.uniforms;
            u.u_time.value = t;
            u.u_opacity.value = 0.28 + sepNorm * 0.18;
        }
        if (this._plasmasphere?.material?.uniforms) {
            const u = this._plasmasphere.material.uniforms;
            u.u_time.value = t;
            u.u_opacity.value = 0.12 + 0.04 * Math.sin(t * 0.9 + 0.5);
        }

        // ── Dipole field lines — colour shifts quiet blue → storm magenta ──
        if (this._fieldLines) {
            this._fieldLines.children.forEach(line => {
                const m = line.material;
                // Quiet: cool blue (0.28, 0.53, 0.80)
                // Storm: warm magenta-purple (0.75, 0.25, 0.85)
                const r = 0.28 + kpNorm * 0.47;
                const g = 0.53 - kpNorm * 0.28;
                const b = 0.80 + kpNorm * 0.05;
                m.color.setRGB(r, g, b);
                m.opacity = 0.12 + kpNorm * 0.18 + 0.03 * Math.sin(t * 0.5);
            });
        }

        // ── Ring current — scales with |Dst| (storm main phase injection) ──
        if (this._ringCurrent?.material?.uniforms) {
            const dstNorm = Math.min(1, Math.max(0, -dst) / 200);
            const u = this._ringCurrent.material.uniforms;
            u.u_time.value = t;
            u.u_opacity.value = dstNorm * 0.30;
        }

        // ── Aurora curtains — update GLSL uniforms every frame ────────────────
        // Substorm flash decays with τ ≈ 8 s; aurora pulsation driven by Kp + Bz.
        this._substormT = Math.max(0, this._substormT - dt * 0.125);  // 8 s decay

        // Aurora is now a group of multi-layer curtain meshes
        const _updateAuroraGroup = (group) => {
            if (!group) return;
            group.traverse(child => {
                if (child.isMesh && child.material?.uniforms) {
                    const U = child.material.uniforms;
                    U.u_time.value       = t;
                    U.u_kp_norm.value    = kpNorm;
                    U.u_bz_south.value   = bzSouth;
                    U.u_substorm_t.value = this._substormT;
                }
            });
        };
        _updateAuroraGroup(this._auroraN);
        _updateAuroraGroup(this._auroraS);

        // ── Plasma sheet — brightens with dynamic pressure + substorm flash ────
        if (this._plasmaSheet) {
            const psBase  = 0.018 + pdynNorm * 0.025;
            const psStorm = bzSouth * 0.030;
            const psPulse = 0.5 + 0.5 * Math.sin(t * 0.4 + pdynNorm * 2.0);
            const sbGlow  = this._substormT * 0.12;
            this._plasmaSheet.material.opacity =
                psBase + psStorm + psPulse * 0.008 + sbGlow;
            // Colour: quiet blue → hot cyan during substorm
            const sbFrac = Math.min(1, this._substormT * 2);
            this._plasmaSheet.material.color.setRGB(
                0.20 + sbFrac * 0.55,
                0.55 + sbFrac * 0.35,
                1.00,
            );
        }
    }

    setLayerVisible(name, v) {
        this._layers[name] = v;
        switch (name) {
            case 'magnetopause':
                if (this._mpFresnel) this._mpFresnel.visible = v;
                if (this._tail) this._tail.visible = v;
                break;
            case 'bowShock':
                if (this._bsFresnel) this._bsFresnel.visible = v;
                break;
            case 'belts':
                if (this._innerBelt) this._innerBelt.visible = v;
                if (this._outerBelt) this._outerBelt.visible = v;
                if (this._fieldLines) this._fieldLines.visible = v;
                break;
            case 'plasmasphere':
                if (this._plasmasphere) this._plasmasphere.visible = v;
                break;
            case 'magnetosheath':
                if (this._magnetosheath) this._magnetosheath.visible = v;
                break;
            case 'cusps':
                if (this._polarCusps) this._polarCusps.visible = v;
                break;
            case 'reconnection':
                if (this._reconnXLine) this._reconnXLine.visible = v;
                break;
            case 'aurora':
                if (this._auroraN) this._auroraN.visible = v;
                if (this._auroraS) this._auroraS.visible = v;
                break;
        }
    }

    /**
     * Trigger a substorm brightening on the aurora curtains.
     * @param {number} idx  substorm index [0,1]
     */
    setSubstorm(idx) {
        // Latch to a minimum of the current value so surges don't interrupt decay
        this._substormT = Math.max(this._substormT, Math.min(1.0, idx));
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

    _rebuildSolarShells(r0, alpha) {
        // Remove old
        while (this._solarGroup.children.length) {
            const c = this._solarGroup.children[0];
            c.geometry?.dispose();
            c.material?.dispose();
            this._solarGroup.remove(c);
        }

        // Bow shock parameters needed for magnetosheath + wire
        const bs = computeBowShock(r0, alpha);

        // Magnetosheath fill (compressed solar-wind plasma between bow shock and magnetopause)
        this._magnetosheath = buildMagnetosheath(bs.r0, bs.alpha);
        this._solarGroup.add(this._magnetosheath);

        // Magnetopause — clean Fresnel-rimmed surface (no wireframe)
        this._mpFresnel = buildFresnelShue(r0, alpha, 0x334488, 0x66bbff, 0.04, 3.0);
        this._mpFresnel.renderOrder = 4;
        this._solarGroup.add(this._mpFresnel);

        // Bow shock — Fresnel-rimmed, orange-gold palette, higher segments
        this._bsFresnel = buildFresnelShue(bs.r0, bs.alpha, 0x884422, 0xffaa44, 0.02, 2.5);
        this._bsFresnel.renderOrder = 3;
        this._solarGroup.add(this._bsFresnel);

        // Dayside reconnection X-line glow (active only when Bz southward)
        this._reconnXLine = buildReconnXLine(r0);
        this._solarGroup.add(this._reconnXLine);

        // Polar cusp funnels
        this._polarCusps = buildPolarCusps(r0, alpha);
        this._solarGroup.add(this._polarCusps);

        // Magnetotail — extended lobe structure, anti-solar direction (-Y)
        // Real magnetotail extends 200–600 Re downstream; we show to ~80 Re
        // for the dramatic long-tail morphology (previously was 22 Re).
        const tailLen = 80;
        const tailR   = Math.min(20, r0 * 2.2 * Math.pow(2, alpha));
        const tailGeo = new THREE.CylinderGeometry(tailR * 0.55, tailR, tailLen, 32, 1, true);
        const tailMat = new THREE.MeshBasicMaterial({
            color: 0x1a2a44, transparent: true, opacity: 0.065,
            side: THREE.BackSide, depthWrite: false,
        });
        this._tail = new THREE.Mesh(tailGeo, tailMat);
        this._tail.position.set(0, -(tailLen / 2 + r0 * 0.1), 0);  // offset into -Y (anti-sun)
        this._tail.renderOrder = 3;
        this._solarGroup.add(this._tail);

        // Plasma sheet — thin, flat current sheet bisecting the magnetotail lobes.
        // The neutral sheet is the boundary between the two tail lobes: hot dense
        // plasma separates the open field lines of the North and South lobe.
        // Rendered as a glowing blue-white disc in the equatorial XZ plane of the tail.
        const psLen    = tailLen * 0.92;
        const psGeo    = new THREE.CylinderGeometry(tailR * 0.42, tailR * 0.52, 0.6, 48, 1, false);
        const psMat    = new THREE.MeshBasicMaterial({
            color: 0x4488cc, transparent: true, opacity: 0.0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        this._plasmaSheet = new THREE.Mesh(psGeo, psMat);
        // Position flat disc at mid-tail; rotated so it lies in the XZ plane
        this._plasmaSheet.position.set(0, -(psLen / 2 + r0 * 0.15), 0);
        this._plasmaSheet.renderOrder = 4;
        this._solarGroup.add(this._plasmaSheet);

        // Apply layer visibility
        if (!this._layers.magnetopause) {
            this._mpFresnel.visible   = false;
            this._tail.visible        = false;
            this._plasmaSheet.visible = false;
        }
        if (!this._layers.bowShock)      this._bsFresnel.visible    = false;
        if (!this._layers.magnetosheath) this._magnetosheath.visible = false;
        if (!this._layers.cusps)         this._polarCusps.visible    = false;
        if (!this._layers.reconnection)  this._reconnXLine.visible   = false;
    }

    _rebuildEarthShells(kp, lpp) {
        // Remove old
        while (this._eqGroup.children.length) {
            const c = this._eqGroup.children[0];
            c.geometry?.dispose();
            c.material?.dispose();
            this._eqGroup.remove(c);
        }

        // Inner Van Allen belt (proton belt, 1.2–2.2 Re, fairly stable)
        // Volumetric shader with non-uniform density patches
        const innerR    = 1.55 - Math.min(0.1, kp / 90);   // slight compression at high Kp
        const innerTube = 0.28;
        this._innerBelt = buildVolumetricTorus(innerR, innerTube, 0x3366ff, 0.35, 3.0);
        this._eqGroup.add(this._innerBelt);

        // Outer Van Allen belt (electron belt, Kp-dependent boundary)
        const outerR    = Math.max(2.6, (2.5 + lpp) / 2);
        const outerTube = Math.max(0.6, (lpp - 2.5) / 2 * 0.85);
        this._outerBelt = buildVolumetricTorus(outerR, outerTube, 0xff7722, 0.28, 2.0);
        this._eqGroup.add(this._outerBelt);

        // Plasmasphere (cold plasma torus, extends to plasmapause L-shell)
        const psR    = lpp;
        const psTube = Math.max(0.45, lpp * 0.20);    // minimum visual thickness
        this._plasmasphere = buildVolumetricTorus(psR, psTube, 0x44ccee, 0.14, 1.5);
        this._eqGroup.add(this._plasmasphere);

        // Ring current torus (~3–4 Re) — O'Brien & McPherron driven by Dst
        this._ringCurrent = buildVolumetricTorus(3.6, 0.42, 0xff4400, 0.0, 2.5);
        this._eqGroup.add(this._ringCurrent);

        // ── 3D Dipole magnetic field lines ────────────────────────────────────
        // Trace r = L sin²(θ) for multiple L-shells and longitudes.
        // Closed field lines (L < ~8) form the inner magnetosphere cage.
        // Open field lines (L > ~10) would extend into the tail (not shown).
        const closedL = [1.5, 2.0, 3.0, 4.5, Math.min(6.5, lpp + 0.5)];
        this._fieldLines = buildDipoleFieldLines(closedL, 12, 0x4488cc, 0.22);
        this._eqGroup.add(this._fieldLines);

        // ── 3D Auroral curtains (North + South ovals) ─────────────────────────
        // Placed in _eqGroup which is Earth-local space centred at origin.
        // The curtain oval colatitude contracts equatorward with rising Kp.
        this._auroraN = buildAuroralCurtains(kp, true);
        this._eqGroup.add(this._auroraN);
        this._auroraS = buildAuroralCurtains(kp, false);
        this._eqGroup.add(this._auroraS);

        // ── Magnetic dipole tilt ──────────────────────────────────────────────
        // Earth's magnetic dipole axis is tilted ~11.5° from rotation axis.
        // This makes belts/field lines visibly offset, adding realism.
        this._eqGroup.rotation.x = 11.5 * DEG;

        // Apply layer visibility
        if (!this._layers.belts) {
            this._innerBelt.visible = false;
            this._outerBelt.visible = false;
        }
        if (!this._layers.plasmasphere) this._plasmasphere.visible = false;
        if (!this._layers.aurora) {
            this._auroraN.visible = false;
            this._auroraS.visible = false;
        }
        if (!this._layers.belts && this._fieldLines) this._fieldLines.visible = false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Ionospheric layer HTML renderer
//  Call this from earth.html to paint the iono-layers div
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate an HTML string representing the ionospheric layer status bars.
 * @param {ReturnType<computeIonoLayers>} iono
 */
export function renderIonoHTML(iono) {
    const bar = (pct, color) =>
        `<span style="display:inline-block;width:${Math.round(Math.min(100, pct))}%;`
      + `height:5px;background:${color};border-radius:2px;vertical-align:middle;"></span>`;

    const row = (label, value, barPct, color, note = '') =>
        `<div style="display:flex;align-items:center;gap:5px;margin-bottom:3px;">`
      + `<span style="min-width:26px;color:#778">${label}</span>`
      + `<span style="flex:1;background:#111;border-radius:2px;overflow:hidden;">`
      + bar(barPct, color)
      + `</span>`
      + `<span style="min-width:56px;text-align:right;color:#aac;">${value}</span>`
      + (note ? `<span style="color:#556;font-size:8px;">${note}</span>` : '')
      + `</div>`;

    const absNorm = Math.min(100, (iono.dLayerAbs / 30) * 100);
    const foENorm = Math.min(100, (iono.foE / 6) * 100);
    const foF2Norm = Math.min(100, (iono.foF2 / 14) * 100);
    const tecNorm  = Math.min(100, (iono.tec / 120) * 100);

    const dColor  = iono.blackout ? '#ff4422' : iono.dLayerAbs > 3 ? '#ffaa22' : '#44aa66';
    const f2Color = iono.f2Active ? '#44ccff' : '#3366aa';

    return `<div style="font-size:9px;color:#aac;padding:2px 0;">`
         + row('D',  iono.blackout ? 'Blackout!' : `${iono.dLayerAbs.toFixed(1)} dB`, absNorm, dColor,
               iono.blackout ? '⚠' : '')
         + row('E',  `${iono.foE.toFixed(1)} MHz`, foENorm, '#66aaff')
         + row('F2', `${iono.foF2.toFixed(1)} MHz`, foF2Norm, f2Color)
         + row('TEC',`${Math.round(iono.tec)} TECU`, tecNorm, '#88ccaa')
         + `<div style="color:#556;margin-top:3px;">hmF2 ≈ ${Math.round(iono.hmF2)} km</div>`
         + `</div>`;
}
