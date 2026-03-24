/**
 * heliosphere3d.js — 3D inner solar system for the Space Weather page
 *
 * Three.js scene (ecliptic plane = XZ, +Y ecliptic north):
 *   • Sun at origin with corona glow + PointLight
 *   • Mercury, Venus, Earth+Moon, Mars at real ephemeris positions
 *   • Earth's full magnetosphere via MagnetosphereEngine, parented to Earth's
 *     orbital group — works because Group.add() mirrors Scene.add()
 *   • 3D Parker spiral solar wind particles (3 000 CPU-advected Points)
 *   • CME expanding shell (triggered by earth_directed_cme in swpc-update)
 *   • Solar flare burst ring on sun surface (triggered by M/X class events)
 *   • Starfield backdrop
 *   • OrbitControls — zoom from full system view (all 4 planets) down to the
 *     Earth–L1 gap, exposing the magnetopause and bow shock detail
 *
 * Scale: AU = 100 Three.js units  (1 unit ≈ 1.496 × 10⁶ km ≈ 234 R⊕)
 *   Body radii are visually exaggerated for system-level readability:
 *     Sun 4.5 u · Mercury 0.32 u · Venus 0.58 u · Earth 0.78 u · Mars 0.48 u
 *   MagnetosphereEngine runs at Earth-local R⊕ = 1 u, so its geometry
 *   (magnetopause ~10 u, bow shock ~12 u) is naturally visible at system scale.
 *
 * Events consumed (window):
 *   'swpc-update'     — { solar_wind, kp, xray_class, earth_directed_cme, … }
 *   'ephemeris-ready' — { mercury, venus, earth, moon, mars }
 *                       each body has { lon_rad, lat_rad, dist_AU }
 *
 * Usage:
 *   import { Heliosphere3D } from './js/heliosphere3d.js';
 *   new Heliosphere3D(canvas).start();
 */

import * as THREE from 'three';
import { OrbitControls }       from 'three/addons/controls/OrbitControls.js';
import { MagnetosphereEngine } from './magnetosphere-engine.js';
import {
    buildParkerLUT,
    parkerSpeedRatio,
    alfvenSpeed,
    plasmaTemp,
    tempToRGB,
    petschekRate,
    plasmaBeta,
    cglAnisotropy,
} from './helio-physics.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Three.js units per AU */
const AU = 100;

/** Visual body radii (Three.js units, exaggerated for readability) */
const R = {
    sun:     4.5,
    mercury: 0.32,
    venus:   0.58,
    earth:   0.78,
    mars:    0.48,
    moon:    0.22,
};

/** Orbital semi-major axes (AU) — mean values for orbit ring geometry */
const ORBIT_AU = { mercury: 0.387, venus: 0.723, earth: 1.000, mars: 1.524 };

/** Planet colours */
const COL = {
    mercury: 0x9a8875,
    venus:   0xe8c97a,
    earth:   0x1a6ad8,
    mars:    0xcc4422,
    moon:    0x888888,
};

const N_WIND    = 3000;   // solar wind particles
const MAX_R_AU  = 1.65;   // kill particles beyond this
const N_LINE    = 90;     // points per spiral field-line sample
const N_SPIRAL  = 8;      // field lines sampled (uniformly around the solar disk)
const HCS_NR    = 48;     // HCS mesh — radial segments
const HCS_NPHI  = 80;     // HCS mesh — azimuthal segments

// ── Heliosphere3D ─────────────────────────────────────────────────────────────

export class Heliosphere3D {

    constructor(canvas, opts = {}) {
        this._canvas = canvas;
        this._opts   = {
            showMagnetosphere: true,
            showWind:          true,
            showCME:           true,
            ...opts,
        };

        // ── Space-weather state (seeded with sane defaults) ───────────────────
        this._sw = {
            speed:     450,
            density:   5,
            bz:        -2,
            bt:        5,
            kp:        2,
            xrayClass: 'C1.0',
            xrayFlux:  1e-8,
            cmeActive: false,
            cmeSpeed:  800,
            regions:   [],
        };

        // ── Ephemeris state ───────────────────────────────────────────────────
        this._eph = { mercury: null, venus: null, earth: null, moon: null, mars: null };

        // ── Internal bookkeeping ──────────────────────────────────────────────
        this._t        = 0;       // elapsed seconds
        this._rot      = 0;       // Parker spiral slow rotation (rad)
        this._rafId    = null;
        this._prevNow  = null;

        // CME animation
        this._cme      = null;    // null | { mesh, r_AU, auPerFrame }

        // Flare animation
        this._flare    = null;    // null | { mesh, life, maxLife }
        this._lastXray = '';

        // Three.js objects (set by _build*)
        this._renderer    = null;
        this._scene       = null;
        this._camera      = null;
        this._controls    = null;
        this._earthGroup  = null;
        this._moonMesh    = null;
        this._moonOrbit   = 0;    // current moon angle (rad), animated
        this._magnetosphere = null;
        this._windPoints   = null;
        this._windPos      = null;
        this._windCol      = null;
        this._windAge      = null;
        this._windMaxAge   = null;
        this._windArm      = null;
        this._windR        = null;  // r_AU for each particle
        this._windVY       = null;  // (unused — kept for shape compat)
        this._windPY       = null;  // sin(latitude) for constant-lat trajectory
        this._windJitter   = null;  // per-particle angular offset from field line (rad)
        // Parker spiral field-line samples (backbone)
        this._spiralLines    = null;
        this._spiralLinePts  = null;
        this._spiralLineCols = null;
        // Heliospheric current sheet (HCS / "ballerina skirt")
        this._hcsMesh    = null;
        this._hcsPosArr  = null;
        this._hcsTilt    = 0;      // current warp amplitude (rad)
        // Parker transonic speed profile (precomputed LUT)
        this._parkerLUT  = null;
        // Sweet-Parker / Petschek reconnection events at HCS
        this._reconnEvents = [];
        this._planetMeshes = {};

        // Bound handlers
        this._onSwpc = this._onSwpc.bind(this);
        this._onEph  = this._onEph.bind(this);
        this._loop   = this._loop.bind(this);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    start() {
        this._build();
        window.addEventListener('swpc-update',     this._onSwpc);
        window.addEventListener('ephemeris-ready', this._onEph);
        this._loop();
        return this;
    }

    stop() {
        window.removeEventListener('swpc-update',     this._onSwpc);
        window.removeEventListener('ephemeris-ready', this._onEph);
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        if (this._spiralLines) {
            for (const line of this._spiralLines) {
                line.geometry.dispose();
                line.material.dispose();
            }
        }
        if (this._hcsMesh) {
            this._hcsMesh.geometry.dispose();
            this._hcsMesh.material.dispose();
        }
        for (const ev of this._reconnEvents) {
            this._scene?.remove(ev.mesh);
            ev.mesh.geometry.dispose();
            ev.mesh.material.dispose();
        }
        this._reconnEvents = [];
        this._renderer?.dispose();
    }

    // ── Event handlers ────────────────────────────────────────────────────────

    _onSwpc(ev) {
        const d   = ev.detail ?? {};
        const sw  = d.solar_wind ?? {};
        if (sw.speed   > 0)     this._sw.speed    = sw.speed;
        if (sw.density != null) this._sw.density  = sw.density;
        if (sw.bz      != null) this._sw.bz       = sw.bz;
        if (sw.bt      != null) this._sw.bt       = sw.bt;
        if (d.kp       != null) this._sw.kp       = d.kp;
        if (d.xray_class)       this._sw.xrayClass = d.xray_class;
        if (d.xray_flux)        this._sw.xrayFlux  = d.xray_flux;
        if (d.active_regions)   this._sw.regions   = d.active_regions;

        const prevCme = this._sw.cmeActive;
        this._sw.cmeActive = !!(d.earth_directed_cme || d.cme_active);
        this._sw.cmeSpeed  = d.earth_directed_cme?.speed ?? this._sw.cmeSpeed;
        if (!prevCme && this._sw.cmeActive) this._triggerCME();

        // Update magnetosphere
        if (this._magnetosphere) this._magnetosphere.update(d);

        // Trigger flare on fresh M/X class event
        const cls = this._sw.xrayClass?.[0]?.toUpperCase() ?? '';
        if ((cls === 'M' || cls === 'X') && this._sw.xrayClass !== this._lastXray) {
            this._triggerFlare(cls === 'X');
        }
        this._lastXray = this._sw.xrayClass;
    }

    _onEph(ev) {
        const d = ev.detail ?? {};
        this._eph.mercury = d.mercury ?? null;
        this._eph.venus   = d.venus   ?? null;
        this._eph.earth   = d.earth   ?? null;
        this._eph.moon    = d.moon    ?? null;
        this._eph.mars    = d.mars    ?? null;
        this._updateEphemerisPositions();
    }

    // ── Build ─────────────────────────────────────────────────────────────────

    _build() {
        this._buildRenderer();
        this._buildScene();
        this._buildStarfield();
        this._buildSun();
        this._buildOrbitRings();
        this._buildPlanets();
        this._buildHCS();          // heliospheric current sheet — below field lines
        this._buildSolarWind();    // field lines + particles on top
    }

    _buildRenderer() {
        this._renderer = new THREE.WebGLRenderer({
            canvas:    this._canvas,
            antialias: true,
            alpha:     false,
        });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this._renderer.outputColorSpace = THREE.SRGBColorSpace;
        this._renderer.setClearColor(0x02010a);

        const rect = this._canvas.getBoundingClientRect();
        this._renderer.setSize(rect.width, rect.height, false);

        this._camera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.05, 1200);
        // Start slightly above the ecliptic plane looking toward the inner system
        this._camera.position.set(0, 80, 250);
        this._camera.lookAt(0, 0, 0);

        this._controls = new OrbitControls(this._camera, this._canvas);
        this._controls.enableDamping  = true;
        this._controls.dampingFactor  = 0.07;
        this._controls.minDistance    = 2;
        this._controls.maxDistance    = 700;
        this._controls.autoRotate     = false;
        this._controls.zoomSpeed      = 1.2;
    }

    _buildScene() {
        this._scene = new THREE.Scene();
        // Sun light — illuminates planets
        const sun = new THREE.PointLight(0xfff5e0, 2.5, 0, 1.4);
        this._scene.add(sun);
        // Ambient fill so night sides aren't pure black
        this._scene.add(new THREE.AmbientLight(0x101828, 1.0));
    }

    _buildStarfield() {
        const N   = 4000;
        const pos = new Float32Array(N * 3);
        const col = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            // Fibonacci sphere distribution for uniform coverage
            const theta = Math.acos(1 - 2 * (i + 0.5) / N);
            const phi   = Math.PI * (1 + Math.sqrt(5)) * i;
            const r     = 900 + Math.random() * 100;
            pos[i*3]   = r * Math.sin(theta) * Math.cos(phi);
            pos[i*3+1] = r * Math.sin(theta) * Math.sin(phi);
            pos[i*3+2] = r * Math.cos(theta);
            const br   = 0.5 + Math.random() * 0.5;
            const tint = Math.random();
            col[i*3]   = br * (tint > 0.7 ? 1.0 : tint > 0.4 ? 0.85 : 0.8);
            col[i*3+1] = br * (tint > 0.7 ? 0.9 : tint > 0.4 ? 0.9  : 0.8);
            col[i*3+2] = br * (tint > 0.7 ? 0.8 : tint > 0.4 ? 1.0  : 1.0);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
        const mat = new THREE.PointsMaterial({
            size:         0.8,
            vertexColors: true,
            sizeAttenuation: false,
            depthWrite:   false,
        });
        this._scene.add(new THREE.Points(geo, mat));
    }

    _buildSun() {
        // Core photosphere
        const core = new THREE.Mesh(
            new THREE.SphereGeometry(R.sun, 32, 32),
            new THREE.MeshStandardMaterial({
                color:     0xffcc44,
                emissive:  0xff8800,
                emissiveIntensity: 1.8,
                roughness: 1,
                metalness: 0,
            })
        );
        core.name = 'sun_core';
        this._scene.add(core);
        this._sunCore = core;

        // Outer corona glow — two nested additive spheres
        for (const [scale, opacity] of [[1.35, 0.18], [1.8, 0.07], [2.6, 0.03]]) {
            const glow = new THREE.Mesh(
                new THREE.SphereGeometry(R.sun * scale, 24, 24),
                new THREE.MeshBasicMaterial({
                    color:       0xff6600,
                    transparent: true,
                    opacity,
                    blending:    THREE.AdditiveBlending,
                    depthWrite:  false,
                    side:        THREE.BackSide,
                })
            );
            glow.renderOrder = 2;
            this._scene.add(glow);
        }
    }

    _buildOrbitRings() {
        for (const [name, dist] of Object.entries(ORBIT_AU)) {
            const col = { mercury: 0x4a3a2a, venus: 0x5a4a20, earth: 0x1a3a6a, mars: 0x4a1a0a }[name];
            const mat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.28, depthWrite: false });
            const pts = [];
            for (let i = 0; i <= 128; i++) {
                const a = (i / 128) * Math.PI * 2;
                pts.push(new THREE.Vector3(dist * AU * Math.cos(a), 0, dist * AU * Math.sin(a)));
            }
            this._scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
        }
    }

    _buildPlanets() {
        // Simple helper for non-Earth planets
        const mkPlanet = (name, radius, color) => {
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(radius, 20, 20),
                new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 })
            );
            mesh.name = name;
            this._scene.add(mesh);
            return mesh;
        };

        this._planetMeshes.mercury = mkPlanet('mercury', R.mercury, COL.mercury);
        this._planetMeshes.venus   = mkPlanet('venus',   R.venus,   COL.venus);
        this._planetMeshes.mars    = mkPlanet('mars',    R.mars,    COL.mars);

        // Place at default positions (overwritten by ephemeris)
        this._setDefaultPlanetPositions();

        // ── Earth ─────────────────────────────────────────────────────────────
        this._earthGroup = new THREE.Group();
        this._earthGroup.name = 'earth_group';
        this._scene.add(this._earthGroup);

        // Earth sphere
        const earthMesh = new THREE.Mesh(
            new THREE.SphereGeometry(R.earth, 28, 28),
            new THREE.MeshStandardMaterial({ color: COL.earth, roughness: 0.8, metalness: 0 })
        );
        earthMesh.name = 'earth';
        this._earthGroup.add(earthMesh);

        // Thin atmosphere rim (additive glow)
        const atmo = new THREE.Mesh(
            new THREE.SphereGeometry(R.earth * 1.12, 24, 24),
            new THREE.MeshBasicMaterial({
                color:       0x4488ff,
                transparent: true,
                opacity:     0.14,
                blending:    THREE.AdditiveBlending,
                depthWrite:  false,
                side:        THREE.BackSide,
            })
        );
        atmo.renderOrder = 2;
        this._earthGroup.add(atmo);

        // Moon
        this._moonMesh = new THREE.Mesh(
            new THREE.SphereGeometry(R.moon, 12, 12),
            new THREE.MeshStandardMaterial({ color: COL.moon, roughness: 0.9 })
        );
        this._moonMesh.name = 'moon';
        this._earthGroup.add(this._moonMesh);

        // ── Magnetosphere — parented to earthGroup ───────────────────────────
        // MagnetosphereEngine calls parent.add() so passing earthGroup works:
        // all magnetosphere geometry lives in Earth-local space.
        if (this._opts.showMagnetosphere) {
            this._magnetosphere = new MagnetosphereEngine(this._earthGroup);
        }

        // Default earth position (overwritten by ephemeris)
        this._earthGroup.position.set(AU, 0, 0);
    }

    _setDefaultPlanetPositions() {
        for (const [name, dist] of Object.entries(ORBIT_AU)) {
            if (name === 'earth') continue;
            const mesh = this._planetMeshes[name];
            if (mesh) mesh.position.set(dist * AU, 0, 0);
        }
    }

    // ── Heliospheric Current Sheet ("ballerina skirt") ────────────────────────
    //
    // The HCS is the 3D surface separating IMF "away" (By>0) and "toward" (By<0)
    // polarity sectors.  It lies roughly in the solar equatorial plane but warps
    // sinusoidally above/below by an amplitude (tilt) that grows with solar
    // activity (Kp proxy).  The surface co-rotates with the Sun.
    //
    // Geometry: a disc from r≈0 to MAX_R_AU, with Y displacement
    //   Y(r, φ) = r_px × tilt × r_AU^0.4 × sin(φ)
    // The mesh is rotated each frame by this._rot so it co-rotates with the field
    // lines without needing per-frame vertex updates.

    _buildHCS() {
        const N_R   = HCS_NR;
        const N_PHI = HCS_NPHI;
        const positions = new Float32Array(N_R * N_PHI * 3);

        // Build index buffer (quad triangles — topology is fixed forever)
        const indices = [];
        for (let ir = 0; ir < N_R - 1; ir++) {
            for (let ip = 0; ip < N_PHI; ip++) {
                const a = ir * N_PHI + ip;
                const b = ir * N_PHI + (ip + 1) % N_PHI;
                const c = (ir + 1) * N_PHI + ip;
                const d = (ir + 1) * N_PHI + (ip + 1) % N_PHI;
                indices.push(a, b, d,  a, d, c);
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setIndex(indices);

        const mat = new THREE.MeshBasicMaterial({
            color:       0x1e3a5f,   // dark blue — shows magnetic neutral layer
            transparent: true,
            opacity:     0.13,
            side:        THREE.DoubleSide,
            depthWrite:  false,
            blending:    THREE.NormalBlending,
        });

        this._hcsMesh   = new THREE.Mesh(geo, mat);
        this._hcsMesh.renderOrder = 1;
        this._scene.add(this._hcsMesh);
        this._hcsPosArr = positions;

        // Compute initial warp from current Kp
        const kp        = this._sw.kp || 2;
        this._hcsTilt   = 0.07 + 0.25 * Math.min(1, kp / 9);
        this._updateHCSPositions();
    }

    // Recompute all vertex Y positions from the current tilt amplitude.
    // Called at build time and whenever Kp changes enough to update tilt.
    _updateHCSPositions() {
        const N_R   = HCS_NR;
        const N_PHI = HCS_NPHI;
        const pos   = this._hcsPosArr;
        const tilt  = this._hcsTilt;

        for (let ir = 0; ir < N_R; ir++) {
            const r_AU = 0.04 + (MAX_R_AU - 0.04) * ir / (N_R - 1);
            const r_px = r_AU * AU;
            // Amplitude grows slowly with r (power 0.4) matching observational HCS models
            const amp  = tilt * Math.pow(r_AU, 0.4);
            for (let ip = 0; ip < N_PHI; ip++) {
                const phi  = ip / N_PHI * Math.PI * 2;
                const idx  = (ir * N_PHI + ip) * 3;
                pos[idx]     = r_px * Math.cos(phi);
                pos[idx + 1] = r_px * amp * Math.sin(phi);   // latitude warp
                pos[idx + 2] = r_px * Math.sin(phi);
            }
        }
        this._hcsMesh.geometry.attributes.position.needsUpdate = true;
    }

    // Tick: just co-rotate the HCS with the solar rotation, and lazily update
    // tilt when Kp has shifted enough.
    _tickHCS() {
        if (!this._hcsMesh) return;
        // Co-rotate with the same slow solar rotation driving the field lines
        this._hcsMesh.rotation.y = this._rot;

        const kp      = this._sw.kp || 2;
        const newTilt = 0.07 + 0.25 * Math.min(1, kp / 9);
        if (Math.abs(newTilt - this._hcsTilt) > 0.008) {
            this._hcsTilt = newTilt;
            this._updateHCSPositions();
        }
    }

    // ── Solar wind particles ──────────────────────────────────────────────────

    _buildSolarWind() {
        if (!this._opts.showWind) return;

        // Precompute Parker speed-ratio LUT (200 pts, 0.002–2.1 AU, T_corona = 1.5 MK)
        // The LUT encodes V(r)/V(1 AU) from the Parker (1958) transcendental equation.
        // Particles closer to the sun advect much more slowly (factor ~15–20 near corona),
        // creating a physically-correct dense coronal glow that thins into the outer wind.
        this._parkerLUT = buildParkerLUT(200, 0.002, 2.1, 1.5e6);

        const N = N_WIND;
        this._windPos    = new Float32Array(N * 3);
        this._windCol    = new Float32Array(N * 3);
        this._windR      = new Float32Array(N);   // r_AU along spiral
        this._windPY     = new Float32Array(N);   // sin(latitude) — constant per particle
        this._windVY     = new Float32Array(N);   // unused; retained for shape compat
        this._windArm    = new Float32Array(N);     // source longitude (rad, 0–2π) — continuous per-particle
        this._windJitter = new Float32Array(N);   // fixed angular jitter from arm centre
        this._windAge    = new Float32Array(N);   // age (s) — used for fade-in only
        this._windMaxAge = new Float32Array(N);   // max age (s)

        for (let i = 0; i < N; i++) this._spawnWind(i, true);

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this._windPos, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(this._windCol, 3));

        const mat = new THREE.PointsMaterial({
            size:            2.2,
            vertexColors:    true,
            blending:        THREE.AdditiveBlending,
            depthWrite:      false,
            sizeAttenuation: true,
            transparent:     true,
            opacity:         0.9,
        });

        this._windPoints = new THREE.Points(geo, mat);
        this._windPoints.renderOrder = 3;
        this._scene.add(this._windPoints);

        // Build the 4 Parker spiral arm backbone lines
        this._buildSpiralLines();
    }

    _buildSpiralLines() {
        // Sample N_SPIRAL field lines evenly around the full solar disk.
        // This is the standard way textbook "Parker spiral" images are drawn:
        // they show a handful of representative field lines, not discrete "arms".
        // The first N_SPIRAL/2 lines form the "away" sector (By>0 = field pointing
        // away from Sun), the second half form the "toward" sector.  Colors and
        // tint are updated live in _tickWind() from the measured By component.
        this._spiralLines    = [];
        this._spiralLinePts  = [];
        this._spiralLineCols = [];

        for (let arm = 0; arm < N_SPIRAL; arm++) {
            const pts  = new Float32Array(N_LINE * 3);
            const cols = new Float32Array(N_LINE * 3);
            const geo  = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pts,  3));
            geo.setAttribute('color',    new THREE.BufferAttribute(cols, 3));
            const mat  = new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent:  true,
                opacity:      0.9,
                blending:     THREE.AdditiveBlending,
                depthWrite:   false,
            });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 2;
            this._scene.add(line);
            this._spiralLines.push(line);
            this._spiralLinePts.push(pts);
            this._spiralLineCols.push(cols);
        }
    }

    _spawnWind(i, scatter = false) {
        // Every particle originates from a unique, randomly-chosen heliographic
        // longitude on the solar surface.  There are no discrete "arms" for
        // emission — the Parker spiral equation applies equally to every longitude.
        // The N_SPIRAL backbone lines are purely a visual guide overlay.
        this._windArm[i]    = Math.random() * Math.PI * 2;   // source longitude (rad)
        // Start at the coronal base (~0.008–0.02 AU ≈ 1.7–4 R☉).
        // Scatter=true seeds the initial cloud spread across the full disc.
        this._windR[i]      = scatter
            ? 0.008 + Math.random() * (MAX_R_AU - 0.008)
            : 0.008 + Math.random() * 0.015;
        // Narrow stream jitter (±4°) — models the finite angular width of a
        // coronal hole / streamer stream without creating visible discrete blobs.
        this._windJitter[i] = (Math.random() - 0.5) * 0.14;
        // Heliographic latitude: sin(lat) stored; Y = sinLat × r_px each frame.
        // Distribution mimics real solar wind: most particles near equatorial
        // (|lat|<15°, slow wind) with a minority at higher latitudes (fast polar wind).
        const u = Math.random();
        if (u < 0.72) {
            // Slow equatorial wind belt (±15°) — streamer belt / HCS region
            this._windPY[i] = (Math.random() - 0.5) * 0.52;   // sin(±15°) ≈ ±0.26
        } else {
            // Fast polar wind (15–45°) — coronal hole streams
            const sign = Math.random() < 0.5 ? 1 : -1;
            this._windPY[i] = sign * (0.26 + Math.random() * 0.45);  // sin(15–45°)
        }
        this._windVY[i]     = 0;
        this._windAge[i]    = scatter ? 2.0 : 0;
        this._windMaxAge[i] = 9999;  // position-based kill only
    }

    _tickWind(dt) {
        if (!this._windPoints) return;

        const speed   = this._sw.speed   || 450;
        const bz      = this._sw.bz      ?? 0;
        const by      = this._sw.by      ?? 5;
        const density = this._sw.density || 5;
        const bt      = Math.max(1, this._sw.bt || 5);

        // Base advection step at measured DSCOVR equatorial speed
        const dr_base  = (speed / 450) * 0.0028 * dt * 60;

        // Derived scalars
        const bzSouth  = Math.max(0, Math.min(1, -bz / 30));  // 0=quiet, 1=southward storm
        const btNorm   = Math.min(1, bt / 20);                 // |B| ∕ 20 nT
        const dFactor  = Math.max(0.4, Math.min(2.5, density / 5));

        // ── IMF sector polarity colours for field-line backbone (By-based) ──────
        // Field lines show MAGNETIC structure. Particles show THERMAL structure (below).
        const awayR  = (0.95 + bzSouth * 0.05) * btNorm;
        const awayG  = (0.68 - bzSouth * 0.55) * btNorm;
        const awayB  = (0.08 - bzSouth * 0.06) * btNorm;
        const towdR  = (0.10 + bzSouth * 0.55) * btNorm;
        const towdG  = (0.50 - bzSouth * 0.35) * btNorm;
        const towdB  = (0.95 - bzSouth * 0.60) * btNorm;
        const awayFirst = by >= 0;

        // ── N_SPIRAL field-line backbone lines (magnetic structure) ──────────────
        if (this._spiralLines) {
            for (let arm = 0; arm < N_SPIRAL; arm++) {
                const pts  = this._spiralLinePts[arm];
                const cols = this._spiralLineCols[arm];
                const inAwayHalf = (arm < N_SPIRAL / 2) === awayFirst;
                const sR = inAwayHalf ? awayR : towdR;
                const sG = inAwayHalf ? awayG : towdG;
                const sB = inAwayHalf ? awayB : towdB;
                const srcLon = arm * (Math.PI * 2 / N_SPIRAL);

                for (let j = 0; j < N_LINE; j++) {
                    const r_AU = (j / (N_LINE - 1)) * MAX_R_AU;
                    const ang  = srcLon + this._rot - (428.6 / speed) * r_AU;
                    const rp   = r_AU * AU;
                    pts[j * 3]     = rp * Math.cos(ang);
                    pts[j * 3 + 1] = 0;
                    pts[j * 3 + 2] = rp * Math.sin(ang);

                    const tIn  = Math.min(j / 10, 1.0);
                    const tOut = 1.0 - Math.pow(j / N_LINE, 1.6);
                    const brt  = tIn * tOut * 0.78;
                    cols[j * 3]     = Math.max(0, sR * brt);
                    cols[j * 3 + 1] = Math.max(0, sG * brt);
                    cols[j * 3 + 2] = Math.max(0, sB * brt);
                }
                this._spiralLines[arm].geometry.attributes.position.needsUpdate = true;
                this._spiralLines[arm].geometry.attributes.color.needsUpdate    = true;
            }
        }

        // ── Solar wind particles (Parker-CGL Thermal Differentiation model) ──────
        //
        // Position:  uses Parker transonic speed profile to modulate dr per particle.
        //   Near sun (r ≈ 0.01 AU): Parker ratio ≈ 0.06 → very slow (subsonic corona)
        //   At critical point (r_c ≈ 0.018 AU at 1.5 MK): ratio ≈ 0.35
        //   At 1 AU: ratio = 1.0 (normalised to DSCOVR measurement)
        //   Visual: dense glowing corona that thins into the outer wind — physically correct
        //
        // Colour: derived from first-principles temperature via the Parker-CGL model:
        //   T(r) = T_corona × (r₀/r)^0.74 + Alfvénic wave heating  (Helios/PSP fit)
        //   Temperature → thermal spectral colour via tempToRGB()
        //   Sector polarity tint (±12% brightness shift) on top of thermal base
        //   Southward Bz brightens and reddens (reconnection heating)
        //
        // CGL anisotropy tint: T_⊥/T_∥ profile mapped to a slight blue↔red shift
        //   Near sun: T_⊥ ≫ T_∥ (oblate) → slight blue-green tint
        //   At 1 AU : T_⊥/T_∥ ≈ 0.4 (prolate) → slight warm shift

        const TWO_PI = Math.PI * 2;
        for (let i = 0; i < N_WIND; i++) {
            this._windAge[i] += dt;

            const r = this._windR[i];

            // Parker transonic advection: scale radial step by V(r)/V(1 AU)
            // Particles automatically pile up near the corona (subsonic crowding)
            const parker = this._parkerLUT
                ? parkerSpeedRatio(r, this._parkerLUT)
                : 1.0;
            const latFrac = Math.min(1, Math.abs(this._windPY[i]) / 0.5);
            // Polar wind travels faster (up to 1.65× equatorial)
            const V_local_frac = 1 + latFrac * 0.65;
            this._windR[i] += dr_base * parker * V_local_frac;

            if (this._windR[i] > MAX_R_AU) {
                this._spawnWind(i, false);
            }

            const r_new  = this._windR[i];
            const srcLon = this._windArm[i];
            const sinLat = this._windPY[i];
            const cosLat = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));

            // Parker spiral angle
            const V_lat   = speed * V_local_frac;
            const ang     = srcLon + this._rot - (428.6 / V_lat) * r_new + this._windJitter[i];
            const rPx     = r_new * AU;

            this._windPos[i * 3]     = rPx * cosLat * Math.cos(ang);
            this._windPos[i * 3 + 1] = rPx * sinLat;
            this._windPos[i * 3 + 2] = rPx * cosLat * Math.sin(ang);

            // ── Parker-CGL thermal colour ──────────────────────────────────────
            // Base colour from first-principles temperature model
            const T_K          = plasmaTemp(r_new, 1.5e6);
            const [tR, tG, tB] = tempToRGB(T_K);

            // Sector polarity tint: Away = marginally warmer (+12%), Toward = cooler
            const heliogLon = ((srcLon - this._rot) % TWO_PI + TWO_PI) % TWO_PI;
            const inAway    = (heliogLon < Math.PI) === awayFirst;
            const polShift  = inAway ? 0.12 : -0.12;  // ±12% warmth shift
            const pR = Math.min(1, tR + polShift * (1 - tR));
            const pG = tG;
            const pB = Math.max(0, tB - polShift * 0.4);

            // CGL anisotropy tint: near-sun oblate (T_⊥>T_∥) → slight blue-green
            // distant prolate (T_∥>T_⊥) → slight warm shift
            const aniso     = cglAnisotropy(r_new);
            const anisoTint = Math.max(-0.08, Math.min(0.08, (aniso - 1) * 0.015));
            const aR = Math.max(0, pR - anisoTint * 0.5);
            const aG = Math.max(0, pG + anisoTint * 0.3);
            const aB = Math.max(0, pB + anisoTint);

            // Storm modifier: Bz southward → reconnection heating → brighter, redder
            const stR = Math.min(1, aR + bzSouth * 0.22);
            const stG = Math.max(0, aG - bzSouth * 0.18);
            const stB = Math.max(0, aB - bzSouth * 0.25);

            // Fade-in from birth; position-based fade at domain edge
            const fadeIn  = Math.min(1.0, this._windAge[i] / 1.5);
            const rNorm   = r_new / MAX_R_AU;
            const fadeOut = Math.pow(Math.max(0, 1.0 - rNorm), 0.5);
            const fade    = fadeIn * fadeOut * dFactor;

            this._windCol[i * 3]     = Math.min(1, stR * fade);
            this._windCol[i * 3 + 1] = Math.min(1, stG * fade);
            this._windCol[i * 3 + 2] = Math.min(1, stB * fade);
        }

        const geo = this._windPoints.geometry;
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate    = true;
    }

    // ── CME ───────────────────────────────────────────────────────────────────

    _triggerCME() {
        // Remove previous CME if still present
        if (this._cme) {
            this._scene.remove(this._cme.mesh);
            this._cme.mesh.geometry.dispose();
            this._cme.mesh.material.dispose();
        }
        const geo  = new THREE.SphereGeometry(0.3, 32, 20);
        const mat  = new THREE.MeshBasicMaterial({
            color:       0xff5500,
            transparent: true,
            opacity:     0.38,
            blending:    THREE.AdditiveBlending,
            depthWrite:  false,
            wireframe:   true,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 4;
        this._scene.add(mesh);
        this._cme = {
            mesh,
            r_AU:      0.003,
            auPerFrame: (this._sw.cmeSpeed / 450) * 0.004,
        };
    }

    // ── Sweet-Parker / Petschek reconnection events at the HCS ───────────────
    //
    // The HCS is a current sheet separating antiparallel IMF sectors.
    // When southward Bz tilts the IMF antiparallel to Earth's magnetopause field,
    // Petschek fast reconnection is triggered.  At the HCS itself, ongoing
    // Sweet–Parker reconnection creates "plasmoids" — magnetic islands ejected
    // along the current sheet at ~V_A.
    //
    // Spawn probability per frame:  petschekRate() × |Bz_south| × V_A
    // Visual: an expanding ring in the HCS plane, colour-transitioning from
    // hot white (10 MK reconnection exhaust) to blue-teal (cooling exhaust).
    //
    // Maximum concurrent events: 6 (prevents GPU overload on fast machines)

    _tickReconnection(dt) {
        const bz      = this._sw.bz      ?? 0;
        const bt      = Math.max(1, this._sw.bt      || 5);
        const density = this._sw.density || 5;

        // Only fire when Bz is clearly southward
        const bzSouth = Math.max(0, -bz / 15);
        if (bzSouth < 0.05) {
            // Quiet — age out existing events but don't spawn new ones
        } else {
            // Alfvén speed and Petschek rate from measured quantities
            const V_A    = alfvenSpeed(bt, density);   // km/s
            // Anomalous (turbulent) magnetic diffusivity η_anomalous ≈ 10⁶ m²/s
            // (much larger than classical ~10 m²/s → enables fast Petschek reconnection)
            const rate   = petschekRate(0.08, V_A, 1e6);

            // Spawn probability — scales with both Bz southward and reconnection rate
            const prob = rate * bzSouth * dt * 1.8;
            if (Math.random() < prob && this._reconnEvents.length < 6) {
                // Random position along the HCS surface
                const r_AU   = 0.15 + Math.random() * 0.90;   // 0.15–1.05 AU
                const phi_w  = Math.random() * Math.PI * 2;    // world longitude
                const r_px   = r_AU * AU;

                // Y follows HCS warp: y = r_px × tilt × sin(phi_world − rot)
                const amp    = (this._hcsTilt || 0.12) * Math.pow(r_AU, 0.4);
                const y_hcs  = r_px * amp * Math.sin(phi_w - this._rot);

                const ring = new THREE.Mesh(
                    new THREE.RingGeometry(0.4, 1.0, 32),
                    new THREE.MeshBasicMaterial({
                        color:       0xbbddff,
                        transparent: true,
                        opacity:     0.85,
                        blending:    THREE.AdditiveBlending,
                        depthWrite:  false,
                        side:        THREE.DoubleSide,
                    })
                );
                ring.position.set(r_px * Math.cos(phi_w), y_hcs, r_px * Math.sin(phi_w));
                // Orient ring parallel to the HCS (face approximately radially outward)
                ring.lookAt(0, 0, 0);
                ring.renderOrder = 8;
                this._scene.add(ring);

                this._reconnEvents.push({
                    mesh:   ring,
                    age:    0,
                    maxAge: 2.0 + Math.random() * 1.5,
                    V_A,
                });
            }
        }

        // Age and update all active events
        for (let i = this._reconnEvents.length - 1; i >= 0; i--) {
            const ev = this._reconnEvents[i];
            ev.age  += dt;

            if (ev.age >= ev.maxAge) {
                this._scene.remove(ev.mesh);
                ev.mesh.geometry.dispose();
                ev.mesh.material.dispose();
                this._reconnEvents.splice(i, 1);
                continue;
            }

            const t = ev.age / ev.maxAge;   // 0 → 1 over event lifetime

            // Expand ring outward (moves at ~V_A exhaust speed from reconnection site)
            ev.mesh.scale.setScalar(1.0 + t * 5.0);

            // Colour transition: hot white (T ~ 10 MK) → blue-teal (cooling exhaust)
            // t=0: bright white/cyan  t=1: dim blue
            const hue = 0.58 - t * 0.12;   // blue-teal range
            const sat = 0.3  + t * 0.6;
            const lit = 0.9  - t * 0.55;
            ev.mesh.material.color.setHSL(hue, sat, lit);

            // Fast flash-in, slow fade-out (like real reconnection exhaust)
            const fadeIn  = Math.min(1, t / 0.12);
            const fadeOut = 1 - Math.pow(t, 1.8);
            ev.mesh.material.opacity = Math.max(0, fadeIn * fadeOut * 0.85);
        }
    }

    _tickCME(dt) {
        if (!this._cme) return;
        const c = this._cme;
        c.r_AU += c.auPerFrame * dt * 60;
        const r = c.r_AU * AU;
        c.mesh.scale.setScalar(r / 0.3);
        // Fade as it moves past Earth
        c.mesh.material.opacity = Math.max(0, 0.38 * (1 - c.r_AU / MAX_R_AU));
        if (c.r_AU > MAX_R_AU) {
            this._scene.remove(c.mesh);
            c.mesh.geometry.dispose();
            c.mesh.material.dispose();
            this._cme = null;
        }
    }

    // ── Flare ─────────────────────────────────────────────────────────────────

    _triggerFlare(extreme = false) {
        if (this._flare) {
            this._scene.remove(this._flare.ring);
            this._scene.remove(this._flare.flash);
            this._flare.ring.geometry.dispose();
            this._flare.ring.material.dispose();
            this._flare.flash.geometry.dispose();
            this._flare.flash.material.dispose();
        }
        const col = extreme ? 0xffffff : 0xffdd44;

        // Expanding ring on sun surface
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.01, 0.12, 32),
            new THREE.MeshBasicMaterial({
                color: col, transparent: true, opacity: 0.9,
                blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
            })
        );
        ring.position.set(R.sun * 0.78, R.sun * 0.55, 0);   // AR-like placement
        ring.lookAt(new THREE.Vector3(0, 0, 30));
        ring.renderOrder = 5;
        this._scene.add(ring);

        // Bright flash sphere
        const flash = new THREE.Mesh(
            new THREE.SphereGeometry(R.sun * 0.18, 12, 12),
            new THREE.MeshBasicMaterial({
                color: col, transparent: true, opacity: 0.7,
                blending: THREE.AdditiveBlending, depthWrite: false,
            })
        );
        flash.position.copy(ring.position);
        flash.renderOrder = 5;
        this._scene.add(flash);

        const maxLife = extreme ? 6.0 : 4.0;
        this._flare = { ring, flash, life: 0, maxLife };
    }

    _tickFlare(dt) {
        if (!this._flare) return;
        const f = this._flare;
        f.life += dt;
        const p = f.life / f.maxLife;    // 0 → 1
        if (p >= 1) {
            this._scene.remove(f.ring);
            this._scene.remove(f.flash);
            f.ring.geometry.dispose();
            f.ring.material.dispose();
            f.flash.geometry.dispose();
            f.flash.material.dispose();
            this._flare = null;
            return;
        }
        // Ring expands and fades
        const ringScale = 1 + p * 8;
        f.ring.scale.setScalar(ringScale);
        f.ring.material.opacity = (1 - p) * 0.9;
        // Flash: bright then fade quickly
        f.flash.material.opacity = p < 0.25 ? 0.7 : 0.7 * (1 - (p - 0.25) / 0.75);
        f.flash.scale.setScalar(1 + p * 1.5);
    }

    // ── Ephemeris positions ───────────────────────────────────────────────────

    /** Convert { lon_rad, lat_rad, dist_AU } → Three.js position in ecliptic XZ */
    _ephToPos(body) {
        if (!body) return null;
        const { lon_rad, lat_rad = 0, dist_AU } = body;
        const d = dist_AU * AU;
        return new THREE.Vector3(
            d * Math.cos(lat_rad) * Math.cos(lon_rad),
            d * Math.sin(lat_rad),
            d * Math.cos(lat_rad) * Math.sin(lon_rad),   // note: ecliptic lon → XZ
        );
    }

    _updateEphemerisPositions() {
        const eph = this._eph;

        // Simple planets
        for (const name of ['mercury', 'venus', 'mars']) {
            const pos = this._ephToPos(eph[name]);
            if (pos && this._planetMeshes[name]) {
                this._planetMeshes[name].position.copy(pos);
            }
        }

        // Earth group
        const earthPos = this._ephToPos(eph.earth);
        if (earthPos) this._earthGroup.position.copy(earthPos);

        // Moon — geocentric lon/lat, dist in AU (already converted by horizons.js)
        if (eph.moon) {
            const moonPos = this._ephToPos(eph.moon);
            if (moonPos && this._moonMesh) {
                this._moonMesh.position.copy(moonPos);
                this._moonOrbit = eph.moon.lon_rad;
            }
        }
    }

    // ── Moon animation (when no live ephemeris) ───────────────────────────────

    _tickMoon(dt) {
        if (this._eph.moon) return;   // live ephemeris drives position; skip animation
        // 27.3 day orbit, sped up by 2000× for visual interest
        const MOON_ORBIT_AU = 0.00257;
        this._moonOrbit = (this._moonOrbit + dt * (2 * Math.PI / (27.3 * 86400)) * 2000) % (2 * Math.PI);
        const r = MOON_ORBIT_AU * AU;
        if (this._moonMesh) {
            this._moonMesh.position.set(
                r * Math.cos(this._moonOrbit),
                0,
                r * Math.sin(this._moonOrbit),
            );
        }
    }

    // ── Sun pulse animation ───────────────────────────────────────────────────

    _tickSun() {
        if (!this._sunCore) return;
        const fluxN = Math.min(1, Math.log10(Math.max(1e-9, this._sw.xrayFlux) / 1e-9) / 4);
        const pulse = 1 + 0.04 * Math.sin(this._t * 1.2);
        const boost = 1 + fluxN * 0.35;
        this._sunCore.material.emissiveIntensity = 1.8 * pulse * boost;
    }

    // ── Magnetosphere ─────────────────────────────────────────────────────────

    _tickMagnetosphere(dt) {
        if (!this._magnetosphere) return;
        const earthPos = this._earthGroup.position;
        // Sun direction from Earth (world space): toward the origin
        const sunDir = earthPos.clone().negate().normalize();
        this._magnetosphere.tick(this._t, sunDir, {
            solar_wind: { bz: this._sw.bz, speed: this._sw.speed, density: this._sw.density },
            kp:         this._sw.kp,
        });
    }

    // ── Resize ────────────────────────────────────────────────────────────────

    _resize() {
        const c    = this._canvas;
        const rect = c.getBoundingClientRect();
        const W    = Math.max(1, Math.round(rect.width));
        const H    = Math.max(1, Math.round(rect.height));
        if (this._renderer.domElement.width  === Math.round(W * this._renderer.getPixelRatio()) &&
            this._renderer.domElement.height === Math.round(H * this._renderer.getPixelRatio())) return;
        this._renderer.setSize(W, H, false);
        this._camera.aspect = W / H;
        this._camera.updateProjectionMatrix();
    }

    // ── Main loop ─────────────────────────────────────────────────────────────

    _loop(now) {
        this._rafId = requestAnimationFrame(this._loop);
        // now is undefined on the first manual call; guard so _prevNow stays null
        // until RAF starts supplying timestamps, avoiding NaN dt on frame 2.
        const dt = Math.min(0.1, (this._prevNow == null || now == null)
            ? 0.016
            : (now - this._prevNow) / 1000);
        if (now != null) this._prevNow = now;

        this._resize();
        this._t    += dt;
        this._rot  += 0.0003 * dt * 60;   // Parker spiral rotation

        this._tickSun();
        this._tickMoon(dt);
        this._tickHCS();
        this._tickWind(dt);
        this._tickReconnection(dt);
        this._tickCME(dt);
        this._tickFlare(dt);
        this._tickMagnetosphere(dt);

        this._controls.update();
        this._renderer.render(this._scene, this._camera);
    }
}
