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
import {
    auroralOvalProfile, cuspLatitude, lShellRegime,
    magnetosphericState, magLatMLTToUnit,
} from './upper-atmosphere-aurora-physics.js';

const R_EARTH_KM = 6371;
const DEG = Math.PI / 180;

// SWPC canonical Kp ↔ Ap conversion table — used to invert Ap back to
// Kp for the oval/cusp scaling laws.
const _KP_TO_AP = [0, 3, 7, 15, 27, 48, 80, 140, 240, 400];
function _apToKp(ap) {
    if (!Number.isFinite(ap) || ap <= 0) return 0;
    for (let i = 0; i < _KP_TO_AP.length - 1; i++) {
        const a = _KP_TO_AP[i], b = _KP_TO_AP[i + 1];
        if (ap < b) return i + (ap - a) / (b - a);
    }
    return 9;
}

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
    { L: 2.0,  count: 10, kind: 'plasmasphere' },   // inner plasmasphere
    { L: 4.0,  count: 14, kind: 'inner-belt'   },   // inner Van Allen + ring current
    { L: 6.0,  count: 18, kind: 'outer-belt'   },   // outer Van Allen / killer e⁻
    { L: 8.0,  count: 22, kind: 'oval'         },   // auroral acceleration zone
    { L: 12.0, count: 14, kind: 'cusp'         },   // open cusp field lines
    { L: 20.0, count: 10, kind: 'lobe'         },   // magnetotail lobe (stretched)
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

        // Last-applied state — used for in-place rebuild of geometry
        // when Pdyn shifts the dayside compression / nightside stretch.
        this._lastKp     = 2;
        this._lastPdyn   = 2.0;          // nPa, climatological mean
        this._lastBz     = 0;
        this._daySign    = +1;           // sign of (sun · X) — set by setSunDir

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

        // Sub-groups for each visualisation layer so they can be
        // toggled / disposed independently.
        this._fieldLinesGroup = new THREE.Group();
        this._fieldLinesGroup.name = 'mag-field-lines';
        this._magGroup.add(this._fieldLinesGroup);

        this._ovalGroup = new THREE.Group();
        this._ovalGroup.name = 'auroral-oval';
        this._magGroup.add(this._ovalGroup);

        this._cuspGroup = new THREE.Group();
        this._cuspGroup.name = 'polar-cusps';
        this._magGroup.add(this._cuspGroup);

        this._mltGroup = new THREE.Group();
        this._mltGroup.name = 'mlt-markers';
        this._magGroup.add(this._mltGroup);

        this._facGroup = new THREE.Group();
        this._facGroup.name = 'birkeland-currents';
        this._magGroup.add(this._facGroup);

        this._buildFieldLines();
        this._buildAuroralOval();
        this._buildPolarCusps();
        this._buildMLTMarkers();
        this._buildFACRings();

        parent.add(this.group);
    }

    // ── Construction ───────────────────────────────────────────────────────
    _buildFieldLines() {
        let lineCounter = 0;
        for (const shell of L_SHELLS) {
            // L-shell physical population (plasmasphere / inner-belt /
            // outer-belt / ring-current / auroral / polar-cap). Used in
            // the per-line tooltip — researchers ask "what's at L=4.5?"
            // and want "outer Van Allen relativistic e⁻", not "L=4.5".
            const regime = lShellRegime(shell.L);

            for (let k = 0; k < shell.count; k++) {
                const phi = (k / shell.count) * Math.PI * 2;
                const arc = _buildFieldLineArc({
                    L: shell.L, phi, nSeg: SEGMENTS_PER_LINE,
                    kind: shell.kind,
                    pdynNPa: this._lastPdyn,
                    daySign: this._daySign,
                });
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
                    kind:       'magnetic-cascade-line',
                    L:          shell.L,
                    family:     shell.kind,
                    regime:     regime.regime,
                    label:      regime.label,
                    population: regime.population,
                    color:      regime.color,
                    // Cached arc parameters — the geometry rebuild on
                    // Pdyn change re-emits new positions onto the same
                    // BufferAttribute via .needsUpdate.
                    _phi:       phi,
                    tooltip:    `L = ${shell.L.toFixed(1)} · ${regime.label}\n${regime.population}`,
                };
                this._fieldLinesGroup.add(line);
            }
        }
    }

    /**
     * Rebuild every field-line arc against the current Pdyn / daySign
     * state. Called from setSolarWindState() — cheap (~6 shells × 14
     * lines × 32 segments = ~2700 vertex writes), one allocation-free
     * pass over the existing BufferAttributes.
     */
    _refreshFieldLineGeometry() {
        for (const line of this._fieldLinesGroup.children) {
            const ud = line.userData;
            if (ud?.kind !== 'magnetic-cascade-line') continue;
            const arc = _buildFieldLineArc({
                L: ud.L, phi: ud._phi, nSeg: SEGMENTS_PER_LINE,
                kind: ud.family,
                pdynNPa: this._lastPdyn,
                daySign: this._daySign,
            });
            if (!arc) continue;
            const posAttr = line.geometry.attributes.position;
            posAttr.array.set(arc.pos);
            posAttr.needsUpdate = true;
        }
    }

    // ── Auroral-oval ribbon (Feldstein-Starkov, Kp-driven) ────────────────────
    //
    // Two closed lat-bands (north + south hemisphere) drawn as ring
    // strips at the ionospheric altitude, MLT-eccentric so the
    // equatorward edge sits ~4° closer to the pole on the dayside than
    // at midnight. Geometry rebuilt in setState() whenever Kp changes;
    // the shader paints with a steady warm-pink colour modulated by
    // the cascade's overall intensity.

    _buildAuroralOval() {
        const altKm = 110;                              // E-region peak
        const r = 1 + altKm / R_EARTH_KM;

        this._ovalMat = new THREE.ShaderMaterial({
            uniforms: {
                uTime:      { value: 0 },
                uIntensity: { value: 0.4 },
            },
            vertexShader: /* glsl */`
                attribute float aMlt;       // 0..24
                attribute float aBand;       // 0=eq, 1=pw
                varying float vMlt;
                varying float vBand;
                void main() {
                    vMlt  = aMlt;
                    vBand = aBand;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: /* glsl */`
                precision highp float;
                uniform float uTime;
                uniform float uIntensity;
                varying float vMlt;
                varying float vBand;
                void main() {
                    // Discrete-aurora curtain texture: high-frequency
                    // azimuthal stripes drifting westward (negative MLT
                    // direction in the auroral electrojet).
                    float curtain = 0.5 + 0.5 * sin(vMlt * 18.0 - uTime * 1.3);
                    curtain = pow(curtain, 4.0);
                    // Diffuse-aurora background — broad envelope across
                    // the band, brighter on the nightside (auroral
                    // electrojet midnight enhancement).
                    float mltRad = (vMlt - 12.0) * 0.2618;   // π/12
                    float midnightBoost = 0.7 - 0.35 * cos(mltRad);
                    // Edge palette: equatorward edge red (low-energy
                    // sub-auroral red arcs), poleward edge green
                    // (high-energy 557.7 nm OI emission).
                    vec3 cEq = vec3(1.0, 0.32, 0.55);
                    vec3 cPw = vec3(0.45, 1.0, 0.65);
                    vec3 col = mix(cEq, cPw, vBand);
                    float a = uIntensity * (0.18 + 0.55 * curtain) * midnightBoost;
                    gl_FragColor = vec4(col, clamp(a, 0.0, 0.85));
                }
            `,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
            side:           THREE.DoubleSide,
        });

        // Two hemispheres × two band edges (eq/pw) × N_MLT samples → 4
        // closed line-loops. Built once with placeholder positions;
        // _refreshAuroralOval() rewrites them on Kp updates.
        this._ovalLoops = [];
        const N_MLT = 64;
        for (const hemi of [+1, -1]) {
            for (const band of [0, 1]) {
                const positions = new Float32Array(N_MLT * 3);
                const mlts      = new Float32Array(N_MLT);
                const bands     = new Float32Array(N_MLT).fill(band);
                for (let i = 0; i < N_MLT; i++) {
                    mlts[i] = (i / N_MLT) * 24;
                }
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                geom.setAttribute('aMlt',      new THREE.BufferAttribute(mlts, 1));
                geom.setAttribute('aBand',     new THREE.BufferAttribute(bands, 1));
                const loop = new THREE.LineLoop(geom, this._ovalMat);
                loop.frustumCulled = false;
                loop.userData = {
                    kind:    'auroral-oval',
                    band:    band === 0 ? 'equatorward' : 'poleward',
                    hemisphere: hemi > 0 ? 'north' : 'south',
                    altKm,
                    tooltip: `Auroral oval ${band === 0 ? 'equatorward' : 'poleward'} edge — `
                           + `(${hemi > 0 ? 'N' : 'S'} hemisphere). Feldstein-Starkov 2001.`,
                };
                this._ovalGroup.add(loop);
                this._ovalLoops.push({ loop, hemi, band, mlts, positions, r });
            }
        }
    }

    /**
     * Rewrite the auroral-oval band positions for the new Kp. Cheap;
     * 4 loops × 64 vertices.
     */
    _refreshAuroralOval(kp) {
        const profile = auroralOvalProfile(kp, 64);
        for (const entry of this._ovalLoops) {
            const arr = entry.positions;
            for (let i = 0; i < entry.mlts.length; i++) {
                const lat = entry.band === 0 ? profile.eqLat[i] : profile.pwLat[i];
                const u = magLatMLTToUnit(entry.hemi * lat, profile.mltHours[i]);
                arr[i * 3 + 0] = u.x * entry.r;
                arr[i * 3 + 1] = u.y * entry.r;
                arr[i * 3 + 2] = u.z * entry.r;
            }
            entry.loop.geometry.attributes.position.needsUpdate = true;
        }
    }

    // ── Polar cusps ─────────────────────────────────────────────────────────────
    //
    // Two glowing dots at MLT 12, λ = ±cuspLatitude(Kp). Marks the
    // throat of the open-field-line tube where solar wind precipitates
    // directly into the ionosphere — high-priority spacecraft surface
    // charging zone, hot O⁺ outflow source.

    _buildPolarCusps() {
        const altKm = 250;     // cusp deposition peaks in E/F region
        const r = 1 + altKm / R_EARTH_KM;
        const cuspGeom = new THREE.SphereGeometry(0.025, 16, 12);
        const cuspMat = new THREE.MeshBasicMaterial({
            color:       0xffe066,
            transparent: true,
            opacity:     0.9,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });

        this._cuspMeshes = [];
        for (const hemi of [+1, -1]) {
            const m = new THREE.Mesh(cuspGeom, cuspMat.clone());
            m.userData = {
                kind:       'polar-cusp',
                hemisphere: hemi > 0 ? 'north' : 'south',
                altKm,
                tooltip:    `Polar cusp (${hemi > 0 ? 'N' : 'S'}) — `
                          + `open-field-line throat at MLT 12. Solar-wind direct entry; `
                          + `hot O⁺ outflow source; spacecraft charging risk.`,
            };
            this._cuspGroup.add(m);
            this._cuspMeshes.push({ mesh: m, hemi, r });
        }
        // Soft-glow halo around each cusp dot — additive sphere ~3× the
        // marker size, so the cusp reads as a bright spot at any zoom.
        const haloMat = new THREE.MeshBasicMaterial({
            color:       0xffe066,
            transparent: true,
            opacity:     0.22,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        for (const entry of this._cuspMeshes) {
            const halo = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), haloMat);
            halo.userData = { kind: 'polar-cusp-halo' };
            entry.mesh.add(halo);
        }
    }

    _refreshPolarCusps(kp) {
        const lat = cuspLatitude(kp);
        for (const entry of this._cuspMeshes) {
            const u = magLatMLTToUnit(entry.hemi * lat, 12);   // MLT 12 = noon
            entry.mesh.position.set(u.x * entry.r, u.y * entry.r, u.z * entry.r);
        }
    }

    // ── MLT (magnetic local time) markers ─────────────────────────────────────
    //
    // Four small lat-line ticks at MLT 00 (midnight, blue), 06 (dawn,
    // green), 12 (noon, gold), 18 (dusk, magenta). Drawn as short
    // meridional arcs from the magnetic equator up to ~80° magnetic
    // latitude in both hemispheres so the user has an "MLT compass"
    // around the magnetic pole.

    _buildMLTMarkers() {
        const altKm = 80;
        const r = 1 + altKm / R_EARTH_KM;
        const ticks = [
            { mlt:  0, color: 0x60a0ff, label: 'midnight' },
            { mlt:  6, color: 0x80e0a0, label: 'dawn'     },
            { mlt: 12, color: 0xffd060, label: 'noon'     },
            { mlt: 18, color: 0xff60c0, label: 'dusk'     },
        ];
        const N_LAT = 24;
        for (const t of ticks) {
            const positions = new Float32Array(N_LAT * 3);
            for (let i = 0; i < N_LAT; i++) {
                const lat = -82 + (164 * i / (N_LAT - 1));   // -82..+82
                const u = magLatMLTToUnit(lat, t.mlt);
                positions[i * 3 + 0] = u.x * r;
                positions[i * 3 + 1] = u.y * r;
                positions[i * 3 + 2] = u.z * r;
            }
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const mat = new THREE.LineBasicMaterial({
                color:       t.color,
                transparent: true,
                opacity:     0.35,
                depthWrite:  false,
            });
            const line = new THREE.Line(geom, mat);
            line.userData = {
                kind:    'mlt-marker',
                mlt:     t.mlt,
                label:   t.label,
                color:   `#${t.color.toString(16).padStart(6, '0')}`,
                tooltip: `MLT ${t.mlt.toString().padStart(2, '0')} — ${t.label}. `
                       + `Sun-aligned magnetic local-time meridian (always at ${t.label === 'noon' ? 'sub-solar' : t.label}).`,
            };
            this._mltGroup.add(line);
        }
    }

    // ── Region 1 / Region 2 Birkeland (field-aligned) currents ────────────────
    //
    // Two concentric oval rings in each hemisphere:
    //   • R1 (poleward): downward current dawn (06), upward dusk (18)
    //   • R2 (equatorward): opposite polarity
    // Drawn as line loops with a colour-by-direction swatch — the
    // azimuthal phase of the current direction is encoded in vertex
    // colour via `vDir` so dawn/dusk halves look distinct without
    // needing per-segment arrows.

    _buildFACRings() {
        const altKm = 110;
        const r = 1 + altKm / R_EARTH_KM;
        const N = 80;

        // Two regions, two hemispheres → 4 rings.
        this._facRings = [];
        for (const hemi of [+1, -1]) {
            for (const region of [1, 2]) {
                const positions = new Float32Array(N * 3);
                const colors    = new Float32Array(N * 3);
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
                const mat = new THREE.LineBasicMaterial({
                    transparent:  true,
                    opacity:      0.6,
                    vertexColors: true,
                    depthWrite:   false,
                });
                const loop = new THREE.LineLoop(geom, mat);
                loop.frustumCulled = false;
                loop.userData = {
                    kind:       region === 1 ? 'fac-region-1' : 'fac-region-2',
                    region,
                    hemisphere: hemi > 0 ? 'north' : 'south',
                    altKm,
                    tooltip:    `Region ${region} Birkeland current — ${hemi > 0 ? 'N' : 'S'} hemi. `
                              + `Iijima-Potemra; ${region === 1 ? 'poleward' : 'equatorward'} of auroral oval. `
                              + `Dawn = downward, dusk = upward (R${region === 1 ? '1' : '2'} reverses for R2).`,
                };
                this._facGroup.add(loop);
                this._facRings.push({ loop, hemi, region, positions, colors, r, N });
            }
        }
    }

    /**
     * Position + colour each FAC ring against the current Kp + FAC
     * magnitude. Rings sit slightly poleward (R1) and equatorward (R2)
     * of the auroral-oval band centre. Vertex colour encodes current
     * direction (downward = blue, upward = red) so the user can see
     * the dawn/dusk asymmetry at a glance.
     */
    _refreshFACRings(kp, facMA) {
        const profile = auroralOvalProfile(kp, this._facRings[0].N);
        for (const entry of this._facRings) {
            for (let i = 0; i < entry.N; i++) {
                const mlt = profile.mltHours[i];
                // Lat: R1 = poleward edge + 1°, R2 = equatorward edge − 1°
                const lat = entry.region === 1
                    ? profile.pwLat[i] + 1
                    : profile.eqLat[i] - 1;
                const u = magLatMLTToUnit(entry.hemi * lat, mlt);
                entry.positions[i * 3 + 0] = u.x * entry.r;
                entry.positions[i * 3 + 1] = u.y * entry.r;
                entry.positions[i * 3 + 2] = u.z * entry.r;

                // Direction encoding: R1 dawn (06) = downward (blue),
                // dusk (18) = upward (red); R2 reverses. Smooth via
                // sin(MLT - 06) so transitions are continuous.
                const dirPhase = Math.sin(((mlt - 6) / 24) * 2 * Math.PI);
                const sign = entry.region === 1 ? dirPhase : -dirPhase;
                // sign ∈ [-1, 1]: -1 → blue (down), +1 → red (up)
                const t = (sign + 1) * 0.5;
                // Mix blue → red, brighten with FAC magnitude.
                const intensity = Math.min(1, 0.35 + facMA * 0.25);
                entry.colors[i * 3 + 0] = (0.30 + 0.65 * t) * intensity;        // R
                entry.colors[i * 3 + 1] = 0.20 * intensity;                      // G
                entry.colors[i * 3 + 2] = (0.95 - 0.65 * t) * intensity;        // B
            }
            entry.loop.geometry.attributes.position.needsUpdate = true;
            entry.loop.geometry.attributes.color.needsUpdate    = true;
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
    setState({ f107 = 150, ap = 15, bz = null,
                speed = null, density = null, by = null } = {}) {
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

        // Drive the auroral oval, cusp, and FAC ring geometry from the
        // canonical Kp ↔ Ap inversion (rather than the storm-norm
        // proxy) so all of the research-grade quantities stay tied to
        // the same scaling laws.
        const kp = _apToKp(ap);
        this._lastKp = kp;
        this._lastBz = Number.isFinite(bz) ? bz : null;

        // Optional solar-wind state — drives Pdyn-based geometry
        // refresh + Birkeland current magnitude. Only refresh when the
        // caller actually passed values, otherwise leave the cached
        // climatology in place.
        if (Number.isFinite(speed) && Number.isFinite(density)) {
            const pdyn = 1.67e-6 * density * speed * speed;       // nPa
            this.setSolarWindState({ speed, density, bz, by, pdynNPa: pdyn });
        }

        // Refresh research-grade objects.
        this._ovalMat && (this._ovalMat.uniforms.uIntensity.value = Math.min(1.0, 0.30 + stormNorm * 0.85 + 0.20 * reconnect));
        this._refreshAuroralOval(kp);
        this._refreshPolarCusps(kp);

        // FAC magnitude — use solar-wind state when available, else
        // derive a proxy from Ap so storm presets still light up the
        // current rings.
        const facMA = (Number.isFinite(speed) && Number.isFinite(density))
            ? _facFromSW(speed, bz ?? 0, density)
            : (0.10 + 1.0 * stormNorm);
        this._refreshFACRings(kp, facMA);

        // Headline operator state — broadcast for the UI panel.
        const swForState = {
            speed:   Number.isFinite(speed)   ? speed   : null,
            density: Number.isFinite(density) ? density : null,
            bz:      Number.isFinite(bz)      ? bz      : null,
            by:      Number.isFinite(by)      ? by      : null,
        };
        this._dispatchState(swForState, kp);
    }

    /**
     * Update the cached solar-wind state — Pdyn drives dayside
     * compression of the field lines (and nightside stretch). Cheap;
     * one geometry rebuild over the in-place BufferAttributes.
     */
    setSolarWindState({ speed, density, pdynNPa, bz, by } = {}) {
        if (Number.isFinite(pdynNPa)) {
            this._lastPdyn = Math.max(0.5, Math.min(50, pdynNPa));
        } else if (Number.isFinite(speed) && Number.isFinite(density)) {
            this._lastPdyn = Math.max(0.5, Math.min(50,
                1.67e-6 * density * speed * speed));
        }
        if (Number.isFinite(bz)) this._lastBz = bz;
        // Rebuild field-line arcs in place against the new Pdyn — the
        // dayside lines compress under high pressure, nightside lines
        // stretch into a more pronounced tail.
        this._refreshFieldLineGeometry();
    }

    /**
     * Headline operator-grade quantities — also dispatched as a
     * 'ua-magnetic-state' window event so the UI panel can render a
     * researcher-friendly readout (HPI, Φ_PC, Lpp, FAC, oval, cusp,
     * implications) without having to re-derive anything.
     */
    _dispatchState(sw, kp) {
        const payload = magnetosphericState(sw, kp);
        this._lastPayload = payload;
        try {
            window.dispatchEvent(new CustomEvent('ua-magnetic-state', { detail: payload }));
        } catch (_) { /* SSR / no-window — ignore */ }
    }

    /** Last computed state payload — useful for unit tests / UI seeding. */
    getState() { return this._lastPayload || null; }

    /** Per-frame: advance the dash phase. Cheap (one uniform write). */
    update(elapsedSec) {
        this._mat.uniforms.uTime.value = elapsedSec;
    }

    setVisible(v) { this.group.visible = !!v; }

    setSunDir(sunDir) {
        if (!sunDir) return;
        this._sunDir.set(sunDir.x, sunDir.y, sunDir.z).normalize();
        // Determine which side of the magnetic axis carries the
        // sub-solar point. The compressed/stretched arc generator
        // squashes lines on the dayside (positive azimuthal half)
        // and stretches them on the nightside.
        //
        // The cascade lives in a magGroup that's rotated by
        // DIPOLE_TILT around X — which means its local XZ plane is
        // close to the geographic XZ plane, so we can just project
        // the world-frame sun direction onto X to get a "dayside is
        // +X" indicator. Sign tracks across day/night transitions.
        const xLocal = this._sunDir.x;
        this._daySign = xLocal >= 0 ? +1 : -1;
        // Rebuild geometry so the dayside compression follows the sun.
        this._refreshFieldLineGeometry();
    }

    dispose() {
        this._mat.dispose();
        this._ovalMat?.dispose();
        // Walk every sub-group and dispose every child geometry.
        const stack = [this._magGroup];
        while (stack.length) {
            const g = stack.pop();
            for (const c of g.children) {
                c.geometry?.dispose?.();
                if (c.children?.length) stack.push(c);
            }
        }
        this._parent?.remove(this.group);
    }
}

/**
 * FAC magnitude (MA) from solar-wind state — same Iijima-Potemra fit
 * as in solar-wind-magnetosphere.js, kept local so the cascade has no
 * cross-dependency on that module.
 */
function _facFromSW(v_sw, bz, n) {
    const vNorm = Math.pow(Math.max(200, v_sw) / 400, 0.72);
    const nNorm = Math.pow(Math.max(0.5, n), 0.23);
    if (bz >= 0) return 0.10 * vNorm * nNorm;
    return 0.046 * vNorm * Math.pow(Math.abs(bz), 0.95) * nNorm;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build one field-line arc with optional dayside compression and
 * nightside stretching. Pure dipole r=L·sin²θ is the inner-shell
 * baseline; the dayside half is squashed by a Pdyn-driven factor
 * (mimicking the magnetopause boundary pushing field lines toward
 * Earth), and the nightside half is stretched into a magnetotail by
 * an inverse factor for L≥10 (the lobe family).
 *
 * Geometry frame: the magnetic group's local +X is the noon meridian
 * (sub-solar side), so points with `cos(phi) · daySign > 0` are on
 * the day half. `daySign` is +1 when the geographic-frame sun-direction
 * has +X component, −1 otherwise — that way the sub-solar point of
 * the cascade tracks the actual sub-solar geographic point as Earth
 * rotates beneath the scene.
 *
 *   compressionDay   = (Pdyn / 2)^(1/6)   →  ~1.0 quiet, ~1.4 storm
 *   stretchNight     = 1 + 0.6·(L − 8)·max(0, (Pdyn/2 − 1))
 *
 * Tail family (L ≥ 18) uses a parametric tail extension instead of a
 * pure spherical-dipole arc since the dipole formula is wrong out
 * there. That arc runs from the cusp ionosphere footpoint outward
 * along ±X (anti-sunward) to ~30 R⊕ in the tail.
 *
 * Returns null when the field line never reaches above the footpoint
 * altitude (degenerate L < 1.05).
 */
function _buildFieldLineArc({ L, phi, nSeg, kind, pdynNPa = 2.0, daySign = +1 }) {
    if (L < 1.02) return null;

    // Tail-lobe family: parametric stretched line, not a dipole arc.
    if (kind === 'lobe' && L >= 18) {
        return _buildTailLobeArc({ L, phi, nSeg, pdynNPa, daySign });
    }

    const r_foot_R = 1 + FOOTPOINT_ALT_KM / R_EARTH_KM;
    const sinThetaMin = Math.sqrt(Math.min(1, r_foot_R / L));
    const thetaMin = Math.asin(sinThetaMin);
    const thetaMax = Math.PI - thetaMin;

    // Cap apex so we don't draw out to infinity for L≥10. Magnetopause
    // climatology is ~10 R⊕ subsolar; we cap a hair beyond.
    const apexClampR = 14.0;

    // Compression / stretching factors.
    //   pdynRel: how much above climatology Pdyn is (>1 = stronger SW)
    const pdynRel = Math.max(0.3, pdynNPa / 2.0);
    const compressDay = Math.pow(pdynRel, 1 / 6);          // dayside squash
    const stretchNight = 1 + 0.5 * Math.max(0, L - 6) * Math.max(0, pdynRel - 1);

    const pos  = new Float32Array(nSeg * 3);
    const prog = new Float32Array(nSeg);
    const lid  = new Float32Array(nSeg);

    const cphi = Math.cos(phi);
    const sphi = Math.sin(phi);
    // Sun-aligned X projection. cphi×daySign > 0 → dayside half.
    const dayDot = cphi * daySign;

    for (let i = 0; i < nSeg; i++) {
        const t = i / (nSeg - 1);
        const theta = thetaMin + t * (thetaMax - thetaMin);

        // Pure dipole radius.
        let r = L * Math.sin(theta) * Math.sin(theta);

        // Day/night asymmetric scaling. dayDot ∈ [-1, +1]:
        //   +1 = noon meridian → divide r by compressDay (squash toward Earth)
        //   -1 = midnight       → multiply by stretchNight (push outward)
        // Smooth interpolation by sigmoid of dayDot keeps the
        // transition gradual so adjacent field lines don't pop.
        const dayWeight = 0.5 * (dayDot + 1);                 // 0..1, 1 at noon
        const radialScale = (1 / compressDay) * dayWeight
                          + stretchNight * (1 - dayWeight);
        r *= radialScale;

        if (r > apexClampR) r = apexClampR;

        const sT = Math.sin(theta);
        let x = r * sT * cphi;
        const y = r * Math.cos(theta);
        let z  = r * sT * sphi;

        // Tail asymmetry: shift the high-L nightside lines back along
        // the antisunward axis so they trail Earth instead of forming
        // closed loops behind. Strength scales with L and stretch.
        if (L >= 8 && dayWeight < 0.4) {
            const tailShift = (L - 8) * (0.4 - dayWeight) * 0.6 * pdynRel;
            x += tailShift * (-daySign);
        }

        pos[i * 3 + 0] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;

        // Progress: 0 at apex (mid-arc) → 1 at either footpoint.
        prog[i] = Math.abs(t - 0.5) / 0.5;
        lid[i]  = 0;
    }

    return { pos, prog, lid };
}

/**
 * Magnetotail-lobe field line: footpoint at the polar-cap, then
 * stretched anti-sunward along the local X axis out to ~28 R⊕. This
 * is the geometry the closed-dipole formula gets wrong by orders of
 * magnitude past L ~ 12. Two halves: ionosphere-footpoint anchor at
 * (±X, ~80° magnetic colat) ↔ tail end far in the antisunward
 * direction. We render only one half per line (single ribbon trail).
 */
function _buildTailLobeArc({ L, phi, nSeg, pdynNPa, daySign }) {
    // Footpoint near the polar cap (mag lat ~80°), MLT 23 (slightly
    // duskward of midnight to spread the lobe lines out azimuthally).
    const lat = 80 - (phi % (Math.PI / 4)) * (180 / Math.PI) * 0.2;
    const u = magLatMLTToUnit(lat, 23 + (phi / (2 * Math.PI)) * 2);
    const r_foot = 1.02;

    // Tail-end position: antisunward × scale_with_pdyn, slightly
    // downward in magnetic Y to populate both lobes (north and south).
    const pdynRel = Math.max(0.3, pdynNPa / 2.0);
    const tailLength = Math.min(28, 12 + 4 * pdynRel + L * 0.4);
    const tailEnd = {
        x: -daySign * tailLength,
        y: u.y > 0 ? +1.5 : -1.5,        // segregate north vs south lobe
        z: u.z * 0.6,
    };

    const pos  = new Float32Array(nSeg * 3);
    const prog = new Float32Array(nSeg);
    const lid  = new Float32Array(nSeg);

    for (let i = 0; i < nSeg; i++) {
        const t = i / (nSeg - 1);
        // Smooth Bezier-like sweep: anchor at footpoint, lift through a
        // mid-control point above the polar cap, then sweep into the tail.
        const ctrlX = u.x * r_foot * 0.4 - daySign * tailLength * 0.15;
        const ctrlY = u.y * r_foot + (u.y > 0 ? +1 : -1) * 0.8;
        const ctrlZ = u.z * r_foot * 0.6;
        const x0 = u.x * r_foot, y0 = u.y * r_foot, z0 = u.z * r_foot;
        const omt = 1 - t;
        const x = omt * omt * x0 + 2 * omt * t * ctrlX + t * t * tailEnd.x;
        const y = omt * omt * y0 + 2 * omt * t * ctrlY + t * t * tailEnd.y;
        const z = omt * omt * z0 + 2 * omt * t * ctrlZ + t * t * tailEnd.z;
        pos[i * 3 + 0] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;
        // Tail lobe: progress 1 at footpoint (energy deposition end)
        // → 0 at tail-end (where reconnection sources packets in the
        // first place). Reverse so packets flow Earth-ward.
        prog[i] = 1 - t;
        lid[i]  = 0;
    }

    return { pos, prog, lid };
}
