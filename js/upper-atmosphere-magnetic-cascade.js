/**
 * upper-atmosphere-magnetic-cascade.js — animate solar EUV + energetic
 * particle precipitation cascading along Earth's dipole field lines
 * into the upper thermosphere
 * ═══════════════════════════════════════════════════════════════════════════
 * Renders a set of dipole magnetic-field-line streamers that carry an
 * animated "packet" texture inward — visualising the sequence
 *
 *     Sun  →  magnetopause  →  cusp / auroral oval  →  thermosphere
 *
 * which is what drives auroral emission, Joule heating, and the
 * thermospheric density bulge during a geomagnetic storm. The
 * geometry is the standard dipole field-line equation
 *
 *     r(θ)  =  L · R⊕ · sin²(θ)
 *
 * where L is the dimensionless McIlwain L-shell parameter (1 ≤ L ≤ ∞)
 * and θ is the colatitude from the magnetic pole. Each line is sampled
 * along its arc and passed to a shader that paints a travelling-dash
 * pattern ("packets") drifting from the equatorial apex toward both
 * footpoints. Brightness of the dash modulates with:
 *
 *     • F10.7 → EUV photon flux baseline (continuous, dayside-weighted)
 *     • Ap   → energetic-particle precipitation kicker (storm-driven,
 *               polar-cusp-weighted)
 *     • IMF Bz southward → reconnection-on cue (Bz < 0 brightens the
 *               whole cascade, Bz > 0 dims it; quiet-time fallback when
 *               IMF data unavailable)
 *
 * The magnetic-pole axis is offset ~11° from the geographic +Y axis to
 * match Earth's actual dipole tilt — gives the auroral oval its
 * characteristic eccentric ring around the magnetic pole rather than
 * the geographic one.
 *
 * Mounted as one Group on the globe scene; doesn't allocate per-frame.
 * Per-frame cost is updating uTime on a single ShaderMaterial, which
 * advances every line's dash pattern simultaneously.
 *
 * @example
 *     const cascade = new MagneticCascade({ parent: scene, intensity: 0.8 });
 *     cascade.setState({ f107: 200, ap: 150, bz: -12 });
 *     // per frame:
 *     cascade.update(elapsedSec);
 */

import * as THREE from 'three';

const R_EARTH_KM = 6371;
const DEG = Math.PI / 180;

// Geographic-frame magnetic-pole tilt. Real value ~ 9.4° in 2025; we
// use 11° because that's what the existing aurora shader assumes and
// keeps the cascade consistent with the oval geometry.
const DIPOLE_TILT_RAD = 11 * DEG;

// L-shell sample set. L=1 is the equator at one R⊕; L=4–8 covers the
// inner magnetosphere where most precipitation along field lines
// terminates at the auroral oval (~65°–72° magnetic colat). L=10+
// reaches into the outer magnetosphere where reconnection happens.
//
// Each L value spawns a ring of N field lines around the magnetic
// axis at the corresponding magnetic longitude; the auroral oval
// emerges naturally from the L-distribution where the lines
// intersect the upper atmosphere.
const L_SHELLS = [
    { L: 4.0,  count: 14, kind: 'oval'  },   // ~ 60° mag colat at footpoint
    { L: 6.0,  count: 18, kind: 'oval'  },   // ~ 65° — auroral peak
    { L: 8.0,  count: 22, kind: 'oval'  },   // ~ 69° — diffuse aurora outer edge
    { L: 12.0, count: 14, kind: 'cusp'  },   // ~ 73° — open cusp field lines
    { L: 20.0, count: 10, kind: 'lobe'  },   // tail-lobe geometry, far reach
];

// Number of points per field-line arc. 32 is enough for smooth dipole
// arcs (the field bends gradually), and the shader carries the dash
// pattern without aliasing at typical zoom levels.
const SEGMENTS_PER_LINE = 32;

// Inner footpoint altitude (km). Field lines effectively terminate
// here for visualisation purposes — below this, the line is clamped
// to the layer system rather than continuing to ground.
const FOOTPOINT_ALT_KM = 110;

// ── GLSL shaders ─────────────────────────────────────────────────────
// Vertex: pass per-vertex arc position (0=equator apex, 1=footpoint)
// + per-vertex line ID so the fragment shader can de-correlate dash
// phase between adjacent strands.
const CASCADE_VERT = /* glsl */`
    attribute float aProgress;     // 0 = equatorial apex, 1 = footpoint
    attribute float aLineId;       // unique per field line
    varying float vProgress;
    varying float vLineId;
    void main() {
        vProgress = aProgress;
        vLineId   = aLineId;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

// Fragment: builds a dash pattern that flows from apex (0) to footpoint
// (1), modulated by a packet-train pulse so the cascade reads as
// discrete energy packets rather than a continuous bar. Brightness:
//
//   base    : uIntensity (overall scale; 0 quiet → 1 storm)
//   packet  : sharp travelling dash (sin^N to make it punchy)
//   apexFade: fade in near apex so packets "appear" rather than spawn at apex
//   footFlare: brighten near the footpoint to suggest the energy
//              depositing into the upper thermosphere
const CASCADE_FRAG = /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform float uIntensity;     // 0..1 cascade strength
    uniform float uCuspBoost;     // 0..1 polar cusp brightness add
    uniform float uReconnect;     // 0..1 southward Bz reconnection
    uniform vec3  uColor;         // base packet colour
    uniform vec3  uColorHot;      // hot packet colour (storm)
    varying float vProgress;
    varying float vLineId;

    void main() {
        // Travelling-packet dash. Phase per line is randomised by
        // vLineId so packets aren't synchronised across all strands.
        float phase = vProgress - uTime * 0.35 + vLineId * 13.371;
        float packet = pow(0.5 + 0.5 * sin(phase * 14.0), 8.0);

        // Apex fade-in: the first 8% of the line near the equatorial
        // apex ramps from 0 → 1 so packets appear to "spawn" out of
        // the magnetopause/cusp interface.
        float apexFade = smoothstep(0.0, 0.08, vProgress);

        // Footpoint flare: brighten the last 25% as packets dump energy
        // into the upper atmosphere. Squared to make it punch.
        float footFlare = pow(smoothstep(0.75, 1.0, vProgress), 2.0);

        // Reconnection-on cue: southward Bz makes packets brighter +
        // hotter throughout the line.
        float reconBoost = 1.0 + uReconnect * 1.4;

        // Colour ramp: cool → hot toward footpoint (energy deposition).
        vec3 col = mix(uColor, uColorHot, footFlare + uReconnect * 0.5);

        float alpha = uIntensity * apexFade * (packet + 0.10) * reconBoost
                    + footFlare * uIntensity * 0.55
                    + uCuspBoost * apexFade * 0.20;
        alpha = clamp(alpha, 0.0, 0.95);
        gl_FragColor = vec4(col, alpha);
    }
`;

/**
 * One MagneticCascade owns a single Group containing every field line +
 * its shared ShaderMaterial. setState() updates intensity uniforms;
 * update(t) advances the dash phase.
 */
export class MagneticCascade {
    /**
     * @param {object} opts
     * @param {THREE.Object3D} opts.parent     scene / group to mount under
     * @param {number}         [opts.intensity=0.5]  initial cascade strength
     * @param {THREE.Vector3}  [opts.sunDir]   used to weight dayside vs. nightside
     */
    constructor({ parent, intensity = 0.5, sunDir } = {}) {
        this._parent = parent;
        this._sunDir = (sunDir && typeof sunDir.x === 'number')
            ? new THREE.Vector3(sunDir.x, sunDir.y, sunDir.z).normalize()
            : new THREE.Vector3(1, 0, 0);

        this.group = new THREE.Group();
        this.group.name = 'magnetic-cascade';

        // One ShaderMaterial, shared across every line — single uniform
        // tick per frame in update().
        this._mat = new THREE.ShaderMaterial({
            uniforms: {
                uTime:       { value: 0 },
                uIntensity:  { value: intensity },
                uCuspBoost:  { value: 0 },
                uReconnect:  { value: 0 },
                uColor:      { value: new THREE.Color(0x70a8ff) },
                uColorHot:   { value: new THREE.Color(0xff7080) },
            },
            vertexShader:   CASCADE_VERT,
            fragmentShader: CASCADE_FRAG,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });

        // Tilt the entire cascade so its +Y axis matches Earth's
        // magnetic pole rather than the geographic pole. The dipole
        // tilt is around the geographic +X axis (sub-solar meridian
        // for a nominal IGRF — close enough for this view).
        this._magGroup = new THREE.Group();
        this._magGroup.rotation.x = DIPOLE_TILT_RAD;
        this.group.add(this._magGroup);

        this._buildFieldLines();
        parent.add(this.group);
    }

    // ── Construction ───────────────────────────────────────────────────────
    _buildFieldLines() {
        let lineCounter = 0;
        for (const shell of L_SHELLS) {
            for (let k = 0; k < shell.count; k++) {
                const phi = (k / shell.count) * Math.PI * 2;
                const arc = _buildDipoleArc(shell.L, phi, SEGMENTS_PER_LINE, shell.kind);
                if (!arc) continue;

                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position',  new THREE.BufferAttribute(arc.pos,  3));
                geom.setAttribute('aProgress', new THREE.BufferAttribute(arc.prog, 1));
                geom.setAttribute('aLineId',   new THREE.BufferAttribute(arc.lid,  1));
                arc.lid.fill(lineCounter % 997 / 997);   // de-correlate dash phase
                lineCounter++;

                const line = new THREE.Line(geom, this._mat);
                line.frustumCulled = false;
                line.userData = {
                    kind:    'magnetic-cascade-line',
                    L:       shell.L,
                    family:  shell.kind,
                    tooltip: `Dipole field line, L = ${shell.L.toFixed(1)} (${shell.kind})`,
                };
                this._magGroup.add(line);
            }
        }
    }

    // ── Public API ─────────────────────────────────────────────────────────

    /**
     * Push current space-weather state. Quiet-time → faint baseline
     * cascade; storm → bright packets, hot colour, reconnection cue.
     *
     * @param {object} state
     * @param {number} state.f107   solar radio flux (SFU)
     * @param {number} state.ap     geomagnetic Ap
     * @param {number} [state.bz]   IMF Bz (nT, +north).  Optional —
     *                              when missing we synthesise a proxy
     *                              from Ap so storm presets still
     *                              warm up the reconnection cue.
     */
    setState({ f107 = 150, ap = 15, bz = null } = {}) {
        // EUV continuum baseline. Quiet sun ≈ F10.7=70 → low cascade;
        // solar max ≈ F10.7=250 → bright dayside packets.
        const euvNorm = Math.max(0, Math.min(1, (f107 - 65) / (300 - 65)));

        // Storm precipitation kicker. Ap=15 (quiet) ≈ 0; Ap=80 (G3) ≈ 0.7;
        // Ap=200 (G4-G5) saturates.
        const stormNorm = Math.max(0, Math.min(1, (ap - 12) / 200));

        // Cusp + lobe families brighten more under storm forcing because
        // those are the open field lines that funnel solar wind in.
        const cuspBoost = stormNorm;

        // Reconnection cue from Bz. southward Bz brightens; northward
        // dims toward viscous baseline. Fallback proxy: storm-norm.
        let reconnect;
        if (Number.isFinite(bz)) {
            reconnect = Math.max(0, Math.min(1, -bz / 15));
        } else {
            reconnect = stormNorm * 0.65;
        }

        // Combined intensity envelope. EUV always contributes (quiet-time
        // floor); storm forcing dominates above Ap ≈ 30.
        const I = Math.min(1.2,
            0.18 + 0.55 * euvNorm + 0.85 * stormNorm + 0.25 * reconnect);

        const u = this._mat.uniforms;
        u.uIntensity.value = I;
        u.uCuspBoost.value = cuspBoost;
        u.uReconnect.value = reconnect;
    }

    /** Per-frame: advance the dash phase. Cheap (one uniform write). */
    update(elapsedSec) {
        this._mat.uniforms.uTime.value = elapsedSec;
    }

    setVisible(v) { this.group.visible = !!v; }

    setSunDir(sunDir) {
        if (!sunDir) return;
        this._sunDir.set(sunDir.x, sunDir.y, sunDir.z).normalize();
    }

    dispose() {
        this._mat.dispose();
        this._magGroup.children.forEach(c => c.geometry?.dispose());
        this._parent?.remove(this.group);
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build one dipole-field-line arc as a 3-typed-array tuple
 * (position xyz, progress, lineId) ready to feed BufferGeometry.
 *
 * Geometry: r(θ) = L · sin²(θ). Sweeps θ ∈ [θ_min, π−θ_min] where θ_min
 * is the colatitude at which r drops to (R⊕ + footpoint_alt). Below
 * that we'd be inside the planet so we trim the arc at the
 * footpoint.
 *
 * Returns null when the field line never reaches above the footpoint
 * altitude (degenerate L < 1.05).
 */
function _buildDipoleArc(L, phi, nSeg, kind) {
    if (L < 1.02) return null;
    const r_foot_R = 1 + FOOTPOINT_ALT_KM / R_EARTH_KM;
    // sin² θ_min = r_foot / L  →  θ_min = asin(√(r_foot/L))
    const sinThetaMin = Math.sqrt(Math.min(1, r_foot_R / L));
    const thetaMin = Math.asin(sinThetaMin);
    const thetaMax = Math.PI - thetaMin;

    // Cap r_apex (at θ=π/2, r = L). Skip lines whose apex is so far
    // out it dwarfs the visualisation — clamp to 18 R⊕ which is just
    // beyond the climatological magnetopause.
    const apexClampR = 18.0;
    const apexR      = Math.min(L, apexClampR);

    const pos  = new Float32Array(nSeg * 3);
    const prog = new Float32Array(nSeg);
    const lid  = new Float32Array(nSeg);

    const cphi = Math.cos(phi);
    const sphi = Math.sin(phi);

    for (let i = 0; i < nSeg; i++) {
        const t = i / (nSeg - 1);
        const theta = thetaMin + t * (thetaMax - thetaMin);
        // Dipole formula in R⊕, capped at apexR.
        let r = L * Math.sin(theta) * Math.sin(theta);
        if (r > apexClampR) r = apexClampR + (r - apexClampR) * 0.0;

        // Convert spherical (r, θ, φ) → Cartesian. Magnetic +Y is the
        // axis (the parent group rotates the whole thing back into
        // Earth-geographic frame).
        const sT = Math.sin(theta);
        const x = r * sT * cphi;
        const y = r * Math.cos(theta);
        const z = r * sT * sphi;
        pos[i * 3 + 0] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;

        // Progress: 0 at apex (θ = π/2) → 1 at either footpoint.
        // We remap so the equatorial apex sits at progress=0 and
        // both footpoints at progress=1. That way packets flow
        // outward from the apex on both halves of the line.
        const apexT = 0.5;
        prog[i] = Math.abs(t - apexT) / 0.5;

        lid[i] = 0;   // filled by caller
    }

    // Suppress lid use in tail-lobe family — those are nearly-straight
    // field lines stretched into the magnetotail; the spherical-dipole
    // form is wrong there but keeps the visual coherent.
    void kind;

    return { pos, prog, lid };
}
