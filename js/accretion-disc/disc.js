/**
 * disc.js — Accretion-disc simulator orchestrator.
 *
 *   - Builds a Three.js scene with a top-down disc view.
 *   - Steps the 1D viscous-disc physics (LBP) + dust drift each frame.
 *   - Runs a leapfrog 2D N-body for embryos in heliocentric coords.
 *   - Applies pebble accretion and Type I/II migration prescriptions.
 *   - Detects collisions; triggers giant-impact module (Theia -> Moon).
 *   - Updates a Kopparapu HZ overlay as the star evolves.
 *   - Reports state to UI elements supplied by the host page.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
    G, M_SUN, M_EARTH, AU, YEAR, L_SUN, R_SUN, R_EARTH,
    makeDiscGrid, stepDisc, discDt,
    dustDriftStep, sampleProfile,
    pebbleAccretionRate, pebbleIsolationMass,
    typeIMigrationRate, typeIIMigrationRate, opensGap, applyMigration,
    leapfrog2D, semiMajorAxis, setCircular,
    snowLineAU, hayashiTemp, toomreQ,
    rocheLimitFluid,
    soundSpeed, omegaK,
} from './physics.js';

import { hzBoundaries, stellarTrack, xuvFlux1AU, planetHabitability } from './habitable.js';
import { SCENARIOS, buildInitialBodies, updateRadius } from './scenarios.js';

// Visual scale: 1 AU -> 5 scene units.
const SCENE_PER_AU = 5;
const TWO_PI = Math.PI * 2;
// Vertical exaggeration applied to the physical z-axis when rendering. Real
// disc H/r flares from ~0.02 (inner) to ~0.1 (outer); 2.5× keeps the visible
// flaring obvious without making the disc look like a vertical wall.
const Z_EXAG = 2.5;

// ─────────────────────────────────────────────────────────────────────────────
// Module-scope state (single sim per page).
// ─────────────────────────────────────────────────────────────────────────────
//
// `cfg` holds the live, user-tunable configuration. It seeds from the chosen
// scenario but every value can be overridden at runtime via applyConfig().
// Slider UIs should always treat `sim.cfg` as the single source of truth.
const sim = {
    scenario: null,
    cfg: null,                // live overrides — see defaultCfg()
    disc:     null,
    bodies:   [],
    moonletDisc: null,        // post-Theia circumterrestrial debris disc
    ageYr:    0,
    timeWarpYrPerS: 2.5e3,
    paused: false,
    impactDone: false,
    moonSpawned: false,
    // Three.js
    scene: null, camera: null, renderer: null, controls: null,
    discMesh: null,
    snowRing: null,
    bodyMeshes: [],
    bodyTrails: [],
    bodyOrbits: [],          // live osculating-ellipse line per body
    bodyLabels: [],          // text-sprite name tag per body
    sunGlow: null,
    dust: null,              // volumetric dust-particle cloud
    flash: null,             // active giant-impact flash sprite, if any
    hzRing: { inner: null, outer: null, optimistic: null },
    star: null,
    starLight: null,
    canvas: null,
    ui: null,
    raf: 0,
    lastTickMs: performance.now(),
    // Diagnostics (mass-flow rate onto the star, low-pass filtered).
    lastMdotacc: 0,
    lastMdotAgeYr: 0,
    mdotEMA: NaN,
    // Throttle expensive HUD redraws to ~6 Hz; the 60 Hz tick still runs.
    lastHudMs: 0,
};

// Live-tunable configuration — sliders write to this object via applyConfig().
function defaultCfg(scenario) {
    return {
        star: {
            Mstar_solar: scenario.star.Mstar_solar,
            ageStartYr:  scenario.star.ageStartYr,
        },
        disc: {
            Mdisc_Msun: scenario.disc.Mdisc_Msun,
            alpha:      scenario.disc.alpha,
            rInAU:      scenario.disc.rInAU,
            rOutAU:     scenario.disc.rOutAU,
            n:          scenario.disc.n,
            dustGasRatio: 0.01,    // global multiplier on dust:gas (Hayashi baseline = 0.01)
        },
        embryos: {
            includeTheia: true,
            seedMultiplier: 1.0,   // scales all embryo seed masses
            jitterAU:       0.0,   // randomize initial a by ±jitter
        },
        physics: {
            pebbleAccretion: true,
            typeI:           true,
            typeII:          true,
            photoEvap:       true,
            collisions:      true,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
export function boot({ canvas, ui, scenarioId = 'solar-system' }) {
    sim.canvas = canvas;
    sim.ui = ui;
    initScenario(scenarioId);
    initThree();
    bindUI();
    loop();
    return {
        sim,
        applyConfig,
        getConfig: () => sim.cfg,
        getDefaults: () => defaultCfg(sim.scenario),
    };
}

// Called from the slider panel. Accepts a partial (deep) override.
// Triggers a live rebuild of the disc + embryos so the scene reflects the
// new initial conditions without dropping the Three.js renderer.
export function applyConfig(partial) {
    if (!sim.scenario) return;
    deepMerge(sim.cfg, partial || {});
    rebuildWorld();
}

function deepMerge(target, source) {
    for (const k of Object.keys(source)) {
        if (source[k] !== null && typeof source[k] === 'object' && !Array.isArray(source[k])) {
            if (!target[k]) target[k] = {};
            deepMerge(target[k], source[k]);
        } else {
            target[k] = source[k];
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario initialisation
// ─────────────────────────────────────────────────────────────────────────────
function initScenario(id) {
    const sc = SCENARIOS[id];
    if (!sc) throw new Error('unknown scenario ' + id);

    sim.scenario = sc;
    sim.cfg = defaultCfg(sc);
    sim.ageYr = sim.cfg.star.ageStartYr;
    sim.impactDone = false;
    sim.moonSpawned = false;

    rebuildDiscAndBodies();
}

// Rebuild the LBP disc grid + embryo list using sim.cfg as truth.
// Does NOT touch the Three.js scene.
function rebuildDiscAndBodies() {
    const cfg = sim.cfg;
    const Mstar = cfg.star.Mstar_solar * M_SUN;
    const trk = stellarTrack(cfg.star.Mstar_solar, sim.ageYr);
    sim.disc = makeDiscGrid({
        Mstar,
        Mdisc: cfg.disc.Mdisc_Msun * M_SUN,
        rInAU: cfg.disc.rInAU,
        rOutAU: cfg.disc.rOutAU,
        n: cfg.disc.n,
        alpha: cfg.disc.alpha,
        Lstar: trk.L_W,
    });
    // Apply the dust:gas ratio override (Hayashi makeDiscGrid uses fixed 0.01 / 0.0033).
    const ratio = cfg.disc.dustGasRatio;
    for (let i = 0; i < sim.disc.n; i++) {
        const inside = sim.disc.T[i] > 170;
        sim.disc.sigmaDust[i] = sim.disc.sigma[i] * ratio * (inside ? 0.33 : 1.4);
    }

    // Build embryos honoring cfg overrides.
    sim.bodies = buildInitialBodies(sim.scenario);
    const out = [];
    for (const b of sim.bodies) {
        if (b.flagTheia && !cfg.embryos.includeTheia) continue;
        b.m *= cfg.embryos.seedMultiplier;
        const jitter = cfg.embryos.jitterAU * (Math.random() * 2 - 1) * AU;
        if (jitter !== 0) {
            const z0 = b.z || 0;
            const a = Math.sqrt(b.x*b.x + b.y*b.y + z0*z0);
            const aNew = Math.max(0.05 * AU, a + jitter);
            const scale = aNew / a;
            b.x *= scale; b.y *= scale; b.z = z0 * scale;
            // Rescale velocity to circular at the new a, preserving direction
            // so the inclined orbital plane is kept.
            const vCirc = Math.sqrt(G * Mstar / aNew);
            const vz0 = b.vz || 0;
            const vmag = Math.sqrt(b.vx*b.vx + b.vy*b.vy + vz0*vz0);
            if (vmag > 0) {
                const s = vCirc / vmag;
                b.vx *= s; b.vy *= s; b.vz = vz0 * s;
            }
        }
        out.push(b);
    }
    sim.bodies = out;
}

// Full live reset: rebuild physics + swap out the visual meshes.
function rebuildWorld() {
    // Tear down old visual companions.
    for (const m of sim.bodyMeshes) sim.scene.remove(m);
    for (const t of sim.bodyTrails) sim.scene.remove(t.line);
    for (const o of sim.bodyOrbits) sim.scene.remove(o.line);
    for (const l of sim.bodyLabels) sim.scene.remove(l);
    sim.bodyMeshes.length = 0;
    sim.bodyTrails.length = 0;
    sim.bodyOrbits.length = 0;
    sim.bodyLabels.length = 0;
    if (sim.flash) { sim.scene.remove(sim.flash.mesh); sim.flash = null; }
    removeDustCloud();
    sim.ageYr = sim.cfg.star.ageStartYr;
    sim.impactDone = false;
    sim.moonSpawned = false;
    sim.lastMdotacc = 0;
    sim.lastMdotAgeYr = sim.ageYr;
    sim.mdotEMA = NaN;
    rebuildDiscAndBodies();

    // Disc mesh geometry depends on n — regenerate if the cell count changed.
    if (sim.discMesh) {
        const segCount = sim.discMesh.userData.segments;
        const expectedVerts = sim.disc.n * (segCount + 1);
        if (sim.discMesh.geometry.attributes.position.count !== expectedVerts) {
            sim.scene.remove(sim.discMesh);
            sim.discMesh.geometry.dispose();
            sim.discMesh.material.dispose();
            sim.discMesh = makeDiscMesh();
            sim.scene.add(sim.discMesh);
        }
    }
    for (const b of sim.bodies) {
        const m = makeBodyMesh(b); sim.bodyMeshes.push(m); sim.scene.add(m);
        const t = makeTrail(b.color); sim.bodyTrails.push(t); sim.scene.add(t.line);
        const o = makeOrbit(b.color); sim.bodyOrbits.push(o); sim.scene.add(o.line);
        const l = makeLabelSprite(b.name); sim.bodyLabels.push(l); sim.scene.add(l);
    }
    sim.dust = makeDustCloud();
    sim.scene.add(sim.dust.points);
}

// ─────────────────────────────────────────────────────────────────────────────
// Three.js scene
// ─────────────────────────────────────────────────────────────────────────────
function initThree() {
    const canvas = sim.canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    sizeRenderer();
    sim.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x03020a);
    sim.scene = scene;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    camera.position.set(0, 60, 110);
    camera.lookAt(0, 0, 0);
    sim.camera = camera;

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    sim.controls = controls;

    // Starfield backdrop
    scene.add(makeStarfield());

    // Star + additive corona halo
    const starGeo = new THREE.SphereGeometry(1.5, 32, 32);
    const starMat = new THREE.MeshBasicMaterial({ color: 0xffe080 });
    const star = new THREE.Mesh(starGeo, starMat);
    scene.add(star);
    sim.star = star;

    sim.sunGlow = makeSunGlow();
    scene.add(sim.sunGlow);

    const sunLight = new THREE.PointLight(0xfff0c0, 4, 0, 1.5);
    scene.add(sunLight);
    sim.starLight = sunLight;
    scene.add(new THREE.AmbientLight(0x303040, 0.6));

    // Disc mesh (texture-driven heatmap)
    sim.discMesh = makeDiscMesh();
    scene.add(sim.discMesh);

    // Snow line ring
    sim.snowRing = makeRing(snowLineAU(sim.disc.Lstar) * SCENE_PER_AU, 0x70c0ff, 0.4);
    scene.add(sim.snowRing);

    // Habitable-zone rings
    refreshHzRings();

    // Per-body visuals: mesh + trail + osculating orbit + label.
    for (const b of sim.bodies) {
        const m = makeBodyMesh(b);  sim.bodyMeshes.push(m); scene.add(m);
        const t = makeTrail(b.color);  sim.bodyTrails.push(t); scene.add(t.line);
        const o = makeOrbit(b.color);  sim.bodyOrbits.push(o); scene.add(o.line);
        const l = makeLabelSprite(b.name); sim.bodyLabels.push(l); scene.add(l);
    }

    // Volumetric dust-particle cloud (3D Σ_dust · Gaussian-in-z).
    sim.dust = makeDustCloud();
    scene.add(sim.dust.points);

    window.addEventListener('resize', sizeRenderer);
}

function sizeRenderer() {
    const canvas = sim.canvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!sim.renderer) return;
    sim.renderer.setSize(w, h, false);
    if (sim.camera) {
        sim.camera.aspect = w / Math.max(1, h);
        sim.camera.updateProjectionMatrix();
    }
}

function makeStarfield() {
    const geom = new THREE.BufferGeometry();
    const N = 800;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        const r = 800 + Math.random() * 600;
        const th = Math.acos(2 * Math.random() - 1);
        const ph = Math.random() * TWO_PI;
        pos[3*i]   = r * Math.sin(th) * Math.cos(ph);
        pos[3*i+1] = r * Math.sin(th) * Math.sin(ph);
        pos[3*i+2] = r * Math.cos(th);
    }
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.7, sizeAttenuation: false });
    return new THREE.Points(geom, mat);
}

function makeDiscMesh() {
    const { n } = sim.disc;
    // Build a ring-like disc as a triangle strip. We use a high-segment ring per radial bin.
    const segments = 64;
    const verts = [];
    const colors = [];
    const indices = [];
    for (let i = 0; i < n; i++) {
        const rScene = sim.disc.r[i] / AU * SCENE_PER_AU;
        for (let s = 0; s <= segments; s++) {
            const t = s / segments * TWO_PI;
            verts.push(rScene * Math.cos(t), 0, rScene * Math.sin(t));
            colors.push(0, 0, 0);
        }
    }
    for (let i = 0; i < n - 1; i++) {
        for (let s = 0; s < segments; s++) {
            const a = i * (segments + 1) + s;
            const b = a + 1;
            const c = a + (segments + 1);
            const d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geom.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
    geom.setIndex(indices);
    const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        transparent: true,
        // Lower opacity so the volumetric dust cloud reads clearly above it.
        opacity: 0.6,
        depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.segments = segments;
    return mesh;
}

function updateDiscColors() {
    const { n, sigma, sigmaDust, T } = sim.disc;
    const segments = sim.discMesh.userData.segments;
    const colorAttr = sim.discMesh.geometry.attributes.color;

    // Normalise Sigma to [0,1] using max value.
    let maxS = 1;
    for (let i = 0; i < n; i++) if (sigma[i] > maxS) maxS = sigma[i];
    for (let i = 0; i < n; i++) {
        const sigN = Math.min(1, Math.sqrt(sigma[i] / maxS));
        const dustN = sigmaDust[i] / Math.max(1e-3, sigma[i] + 1e-9);
        // Temperature lerp: 1500K -> hot (orange) to 30K -> cold (purple-blue)
        const Tn = Math.min(1, Math.max(0, (T[i] - 30) / 470));
        const r = Tn * 0.95 + 0.05;
        const g = 0.3 * Tn + 0.5 * sigN * 0.6;
        const b = 0.6 - 0.4 * Tn + 0.4 * dustN;
        for (let s = 0; s <= segments; s++) {
            const idx = (i * (segments + 1) + s) * 3;
            colorAttr.array[idx]   = r * sigN;
            colorAttr.array[idx+1] = g * sigN;
            colorAttr.array[idx+2] = Math.max(0.04, b * sigN);
        }
    }
    colorAttr.needsUpdate = true;
}

function makeRing(rScene, color, opacity = 0.5) {
    const segs = 192;
    const pts = new Float32Array((segs + 1) * 3);
    for (let i = 0; i <= segs; i++) {
        const t = i / segs * TWO_PI;
        pts[3*i]   = rScene * Math.cos(t);
        pts[3*i+1] = 0;
        pts[3*i+2] = rScene * Math.sin(t);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    const line = new THREE.LineLoop(geom, mat);
    line.userData.rScene = rScene;
    return line;
}

function updateRing(ring, rScene) {
    const segs = ring.geometry.attributes.position.count - 1;
    const arr = ring.geometry.attributes.position.array;
    for (let i = 0; i <= segs; i++) {
        const t = i / segs * TWO_PI;
        arr[3*i]   = rScene * Math.cos(t);
        arr[3*i+1] = 0;
        arr[3*i+2] = rScene * Math.sin(t);
    }
    ring.geometry.attributes.position.needsUpdate = true;
    ring.userData.rScene = rScene;
}

function refreshHzRings() {
    const trk = stellarTrack(sim.cfg.star.Mstar_solar, sim.ageYr);
    const hz  = hzBoundaries(trk.L_W, trk.Teff);
    const inner = hz.runawayGreen * SCENE_PER_AU;
    const outer = hz.maxGreen     * SCENE_PER_AU;
    const opto  = hz.earlyMars    * SCENE_PER_AU;
    if (!sim.hzRing.inner) {
        sim.hzRing.inner = makeRing(inner, 0x6fe48b, 0.55);
        sim.hzRing.outer = makeRing(outer, 0x6fe48b, 0.55);
        sim.hzRing.optimistic = makeRing(opto, 0x6fe48b, 0.25);
        sim.scene.add(sim.hzRing.inner);
        sim.scene.add(sim.hzRing.outer);
        sim.scene.add(sim.hzRing.optimistic);
    } else {
        updateRing(sim.hzRing.inner, inner);
        updateRing(sim.hzRing.outer, outer);
        updateRing(sim.hzRing.optimistic, opto);
    }
}

function makeBodyMesh(b) {
    // Body radius (scene units): exaggerate so embryos are visible.
    const radius = Math.max(0.18, 0.35 * Math.cbrt(b.m / M_EARTH));
    const geom = new THREE.SphereGeometry(radius, 24, 24);
    const mat = new THREE.MeshStandardMaterial({
        color: b.color,
        emissive: new THREE.Color(b.color).multiplyScalar(0.25),
        roughness: 0.65,
        metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData = { body: b, baseRadius: radius };

    // Iconic Saturn rings — flat annulus tilted to Saturn's real axial obliquity.
    if (b.name === 'proto-Saturn') {
        const ringGeom = new THREE.RingGeometry(radius * 1.45, radius * 2.35, 80, 1);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0xead8a0,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.65,
            depthWrite: false,
        });
        const ring = new THREE.Mesh(ringGeom, ringMat);
        ring.rotation.x = -Math.PI / 2 + 0.47;   // ~27° real obliquity
        ring.rotation.z = 0.12;
        mesh.add(ring);
    }
    return mesh;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sun corona halo (additive sprite stack behind the photosphere).
// ─────────────────────────────────────────────────────────────────────────────
function makeSunGlow() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0.00, 'rgba(255,250,210,0.95)');
    g.addColorStop(0.18, 'rgba(255,210,130,0.55)');
    g.addColorStop(0.45, 'rgba(255,140,60,0.20)');
    g.addColorStop(0.85, 'rgba(255,90,30,0.04)');
    g.addColorStop(1.00, 'rgba(255,60,20,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace || tex.colorSpace;
    const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(14, 14, 1);
    return sprite;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live osculating orbit. Recovers (a, e, ω) from the heliocentric state vector
// each frame and renders the resulting Kepler ellipse as a LineLoop. Hides on
// non-bound (e ≥ 1) or invalid solutions.
// ─────────────────────────────────────────────────────────────────────────────
const ORBIT_SEGMENTS = 128;
function makeOrbit(color) {
    const N = ORBIT_SEGMENTS;
    const pos = new Float32Array((N + 1) * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0.35, depthWrite: false,
    });
    const line = new THREE.LineLoop(geom, mat);
    line.visible = false;
    return { line, geom, pos, N };
}

function updateOrbit(orb, body, Mstar) {
    const mu = G * Mstar;
    const x  = body.x,  y  = body.y,  z  = body.z  || 0;
    const vx = body.vx, vy = body.vy, vz = body.vz || 0;
    const r  = Math.sqrt(x*x + y*y + z*z);
    if (!isFinite(r) || r <= 0) { orb.line.visible = false; return; }
    const v2 = vx*vx + vy*vy + vz*vz;
    const energy = 0.5 * v2 - mu / r;
    const a = -mu / (2 * energy);
    if (!isFinite(a) || a <= 0) { orb.line.visible = false; return; }

    // Specific angular momentum vector h = r × v.
    const hx = y * vz - z * vy;
    const hy = z * vx - x * vz;
    const hz = x * vy - y * vx;
    const hmag = Math.sqrt(hx*hx + hy*hy + hz*hz);
    if (!isFinite(hmag) || hmag === 0) { orb.line.visible = false; return; }

    // Eccentricity vector e_vec = (v × h)/μ − r̂.
    const ex_v = (vy * hz - vz * hy) / mu - x / r;
    const ey_v = (vz * hx - vx * hz) / mu - y / r;
    const ez_v = (vx * hy - vy * hx) / mu - z / r;
    const e = Math.sqrt(ex_v*ex_v + ey_v*ey_v + ez_v*ez_v);
    if (!isFinite(e) || e >= 0.95) { orb.line.visible = false; return; }

    // Orthonormal basis in the orbital plane: p̂ along periapsis,
    // q̂ = ĥ × p̂ in the direction of motion at periapsis.
    let px, py, pz;
    if (e > 1e-6) {
        px = ex_v / e; py = ey_v / e; pz = ez_v / e;
    } else {
        // Circular orbit: e_vec is degenerate, take current position as ref.
        px = x / r; py = y / r; pz = z / r;
    }
    const qx = (hy * pz - hz * py) / hmag;
    const qy = (hz * px - hx * pz) / hmag;
    const qz = (hx * py - hy * px) / hmag;

    const p_param = a * (1 - e * e);
    const N = orb.N;
    const s = SCENE_PER_AU / AU;
    for (let i = 0; i <= N; i++) {
        const nu  = (i / N) * TWO_PI;
        const cn  = Math.cos(nu), sn = Math.sin(nu);
        const rNu = p_param / (1 + e * cn);
        const xx = rNu * (cn * px + sn * qx);
        const yy = rNu * (cn * py + sn * qy);
        const zz = rNu * (cn * pz + sn * qz);
        orb.pos[3*i]   = xx * s;
        orb.pos[3*i+1] = zz * s * Z_EXAG;
        orb.pos[3*i+2] = yy * s;
    }
    orb.geom.attributes.position.needsUpdate = true;
    orb.line.visible = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-scene body labels. Each label is a CanvasTexture sprite pinned above the
// body, scaled so it stays legible across zoom levels.
// ─────────────────────────────────────────────────────────────────────────────
function makeLabelSprite(text) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = '700 22px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Soft outline for legibility against the bright disc.
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, 128, 34);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(6, 1.5, 1);
    sprite.renderOrder = 10;
    return sprite;
}

// ─────────────────────────────────────────────────────────────────────────────
// Giant-impact flash: brief additive burst at the merger site, drives itself
// from real time (animated in the render loop, not the physics tick).
// ─────────────────────────────────────────────────────────────────────────────
function triggerImpactFlash(x_m, y_m, z_m = 0) {
    if (sim.flash) { sim.scene.remove(sim.flash.mesh); sim.flash = null; }
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0.00, 'rgba(255,255,255,1)');
    g.addColorStop(0.22, 'rgba(255,220,160,0.85)');
    g.addColorStop(0.55, 'rgba(255,120,60,0.25)');
    g.addColorStop(1.00, 'rgba(255,80,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(
        x_m / AU * SCENE_PER_AU,
        z_m / AU * SCENE_PER_AU * Z_EXAG + 0.4,
        y_m / AU * SCENE_PER_AU,
    );
    sprite.scale.set(2, 2, 1);
    sim.scene.add(sprite);
    sim.flash = { mesh: sprite, t0: performance.now(), durMs: 2200 };
}

function tickFlash() {
    if (!sim.flash) return;
    const u = (performance.now() - sim.flash.t0) / sim.flash.durMs;
    if (u >= 1) {
        sim.scene.remove(sim.flash.mesh);
        sim.flash.mesh.material.map?.dispose();
        sim.flash.mesh.material.dispose();
        sim.flash = null;
        return;
    }
    const s = 2 + 24 * u;
    sim.flash.mesh.scale.set(s, s, 1);
    sim.flash.mesh.material.opacity = Math.max(0, 1 - u);
}

// ─────────────────────────────────────────────────────────────────────────────
// Volumetric dust-particle cloud. Samples N particles from the disc dust
// surface-density profile, distributes them vertically as a Gaussian about
// the midplane with σ = local scale height H(r), and orbits them at the
// Keplerian rate. Gives the disc real 3D thickness — flared as H/r grows
// with r — without changing the underlying thin-disc physics.
// ─────────────────────────────────────────────────────────────────────────────
const DUST_PARTICLE_COUNT = 2500;

function buildDustCdf(disc) {
    const cdf = new Float64Array(disc.n);
    let tot = 0;
    for (let i = 0; i < disc.n; i++) {
        const dr = (i < disc.n - 1) ? disc.r[i+1] - disc.r[i] : disc.r[i] - disc.r[i-1];
        // Weight by mass-per-radial-bin so denser bins draw more particles.
        tot += Math.max(0, disc.sigmaDust[i]) * 2 * Math.PI * disc.r[i] * dr;
        cdf[i] = tot;
    }
    return { cdf, tot };
}

function cdfBisect(cdf, u) {
    let lo = 0, hi = cdf.length - 1;
    if (u <= cdf[0]) return 0;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < u) lo = mid; else hi = mid;
    }
    return hi;
}

function makeDustCloud() {
    const N = DUST_PARTICLE_COUNT;
    const disc = sim.disc;
    const { cdf, tot } = buildDustCdf(disc);

    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const data = new Array(N);

    if (tot === 0) {
        // Degenerate disc — return an empty Points so callers don't crash.
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const m = new THREE.PointsMaterial({ vertexColors: true, size: 0.18, transparent: true, opacity: 0 });
        return { points: new THREE.Points(g, m), data, pos };
    }

    const T_SNOW_K = 170;
    for (let p = 0; p < N; p++) {
        const u = Math.random() * tot;
        const i = cdfBisect(cdf, u);
        const r = disc.r[i];
        const phi0 = Math.random() * TWO_PI;
        const H = soundSpeed(disc.T[i]) / omegaK(r, disc.Mstar);
        // Box-Muller for vertical Gaussian about the midplane.
        const u1 = Math.max(1e-6, Math.random());
        const u2 = Math.random();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(TWO_PI * u2) * H;
        data[p] = { r, phi0, z };
        const x_m = r * Math.cos(phi0);
        const y_m = r * Math.sin(phi0);
        pos[3*p]   = x_m / AU * SCENE_PER_AU;
        pos[3*p+1] = z  / AU * SCENE_PER_AU * Z_EXAG;
        pos[3*p+2] = y_m / AU * SCENE_PER_AU;
        // Inside the snow line → warm/orange (rocky dust); outside → cool/blue
        // (icy grains). Slight randomisation so the cloud doesn't band sharply.
        const warm = disc.T[i] > T_SNOW_K;
        const j = 0.85 + Math.random() * 0.25;
        if (warm) { col[3*p] = 1.0 * j; col[3*p+1] = 0.65 * j; col[3*p+2] = 0.30 * j; }
        else      { col[3*p] = 0.55 * j; col[3*p+1] = 0.78 * j; col[3*p+2] = 1.0  * j; }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('color',    new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
        vertexColors: true,
        size: 0.18,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
    });
    return { points: new THREE.Points(geom, mat), data, pos };
}

// Advance the dust cloud by `dtSimSec` of simulated time. Each particle
// orbits at its own Keplerian rate; z is fixed (vertically static).
function updateDustCloud(dtSimSec) {
    const dust = sim.dust;
    if (!dust || !dust.data || dust.data.length === 0) return;
    const Mstar = sim.cfg.star.Mstar_solar * M_SUN;
    const s = SCENE_PER_AU / AU;
    const sz = s * Z_EXAG;
    const data = dust.data;
    const pos = dust.pos;
    for (let p = 0; p < data.length; p++) {
        const d = data[p];
        const om = Math.sqrt(G * Mstar / (d.r * d.r * d.r));
        d.phi0 += om * dtSimSec;
        const c = Math.cos(d.phi0), si = Math.sin(d.phi0);
        pos[3*p]   = d.r * c * s;
        pos[3*p+1] = d.z * sz;
        pos[3*p+2] = d.r * si * s;
    }
    dust.points.geometry.attributes.position.needsUpdate = true;
}

function removeDustCloud() {
    if (!sim.dust) return;
    sim.scene.remove(sim.dust.points);
    sim.dust.points.geometry.dispose();
    sim.dust.points.material.dispose();
    sim.dust = null;
}

function makeTrail(color) {
    const N = 120;
    const pos = new Float32Array(N * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 });
    const line = new THREE.Line(geom, mat);
    return { line, geom, pos, head: 0, count: 0, N };
}

function pushTrail(t, x, y, z) {
    t.pos[3*t.head]   = x;
    t.pos[3*t.head+1] = y;
    t.pos[3*t.head+2] = z;
    t.head = (t.head + 1) % t.N;
    t.count = Math.min(t.N, t.count + 1);
    // Reorder so the draw range starts at the oldest point.
    if (t.count < t.N) {
        t.geom.setDrawRange(0, t.count);
    } else {
        // Roll the array so head is at end.
        const rolled = new Float32Array(t.N * 3);
        for (let i = 0; i < t.N; i++) {
            const src = ((t.head + i) % t.N) * 3;
            rolled[3*i]   = t.pos[src];
            rolled[3*i+1] = t.pos[src+1];
            rolled[3*i+2] = t.pos[src+2];
        }
        t.geom.attributes.position.array.set(rolled);
        t.geom.setDrawRange(0, t.N);
    }
    t.geom.attributes.position.needsUpdate = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation tick
// ─────────────────────────────────────────────────────────────────────────────
// Hard cap on substeps per frame. Prevents the page from locking up when the
// user dials the time-warp slider to large values — instead of running 80k
// subcycles, we advance as far as we can within the budget and let real time
// move on. The sim quietly slows when warp is too high for the host.
const MAX_SUBSTEPS_PER_FRAME = 120;

function tick(dtRealS) {
    if (sim.paused) return;

    const Mstar = sim.cfg.star.Mstar_solar * M_SUN;
    const sec = sim.timeWarpYrPerS * dtRealS * YEAR;   // simulated seconds advanced this frame
    let remaining = sec;
    // Subcycle: bounded by disc CFL plus an integrator safety on orbits (~ 0.1 of inner orbital period).
    const Pinner = TWO_PI * Math.sqrt(Math.pow(0.3 * AU, 3) / (G * Mstar));
    const phys = sim.cfg.physics;
    let steps = 0;
    while (remaining > 0 && steps < MAX_SUBSTEPS_PER_FRAME) {
        steps++;
        const dtDisc = discDt(sim.disc);
        const dtOrb  = 0.05 * Pinner;
        const dt     = Math.min(remaining, dtDisc, dtOrb, 1e5 * YEAR);

        stepDisc(sim.disc, dt, { photoEvap: phys.photoEvap });
        dustDriftStep(sim.disc, dt);

        // Pebble accretion onto each embryo
        if (phys.pebbleAccretion) {
            for (const b of sim.bodies) {
                if (!b.alive) continue;
                const a = semiMajorAxis(b, Mstar);
                if (!isFinite(a) || a < 0.05 * AU) continue;
                b.a = a;
                const Miso = pebbleIsolationMass(a, sim.disc);
                if (b.m < Miso) {
                    const dm = pebbleAccretionRate(b, sim.disc) * dt;
                    b.m += dm;
                    const iIdx = nearestIndex(sim.disc.r, a);
                    const drCell = (iIdx > 0)
                        ? sim.disc.r[iIdx] - sim.disc.r[iIdx-1]
                        : sim.disc.r[1] - sim.disc.r[0];
                    const annulusA = 2 * Math.PI * sim.disc.r[iIdx] * drCell;
                    sim.disc.sigmaDust[iIdx] = Math.max(0,
                        sim.disc.sigmaDust[iIdx] - dm / annulusA);
                    updateRadius(b);
                }
            }
        }

        // N-body step (with gas-disc still present)
        leapfrog2D(sim.bodies.filter(b => b.alive), Mstar, dt);

        // Migration: Type I or Type II — each gated independently.
        const discAlive = sim.disc.sigma.some(s => s > 1);
        if (discAlive) {
            for (const b of sim.bodies) {
                if (!b.alive) continue;
                const inGap = opensGap(b, sim.disc);
                let daDt = 0;
                if (inGap && phys.typeII) daDt = typeIIMigrationRate(b, sim.disc);
                else if (!inGap && phys.typeI) daDt = typeIMigrationRate(b, sim.disc);
                if (daDt !== 0) applyMigration(b, Mstar, daDt, dt);
            }
        }

        // Collision detection.
        if (phys.collisions) handleCollisions();

        // Theia giant impact - check whether to spawn the Moon.
        if (!sim.impactDone) checkTheiaImpact();
        if (sim.impactDone && !sim.moonSpawned && sim.ageYr > 100e6) spawnMoon();

        sim.ageYr += dt / YEAR;
        remaining -= dt;
    }

    // Refresh stellar luminosity + T_eff -> disc T -> HZ rings.
    const trk = stellarTrack(sim.cfg.star.Mstar_solar, sim.ageYr);
    sim.disc.Lstar = trk.L_W;
    refreshHzRings();

    // Push trails + body positions + osculating orbit + label tag.
    // Mapping: physics-x → scene-x, physics-y → scene-z, physics-z → scene-y.
    for (let i = 0; i < sim.bodies.length; i++) {
        const b = sim.bodies[i];
        const mesh  = sim.bodyMeshes[i];
        const orbit = sim.bodyOrbits[i];
        const label = sim.bodyLabels[i];
        if (!b.alive) {
            mesh.visible = false;
            if (orbit) orbit.line.visible = false;
            if (label) label.visible = false;
            continue;
        }
        const xs = b.x / AU * SCENE_PER_AU;
        const zs = b.y / AU * SCENE_PER_AU;
        const ys = (b.z || 0) / AU * SCENE_PER_AU * Z_EXAG;
        mesh.position.set(xs, ys, zs);
        const baseR = mesh.userData.baseRadius || 0.35;
        const radius = Math.max(0.18, 0.35 * Math.cbrt(b.m / M_EARTH));
        mesh.scale.setScalar(radius / baseR);
        // Slow visual self-rotation so the planets feel alive (purely cosmetic).
        mesh.rotation.y += 0.01;
        pushTrail(sim.bodyTrails[i], xs, ys, zs);
        if (orbit) updateOrbit(orbit, b, Mstar);
        if (label) {
            label.visible = true;
            // Pin label above the body; lift scales with body radius.
            label.position.set(xs, ys + 0.8 + radius * 0.8, zs);
        }
    }

    // Snow line update.
    updateRing(sim.snowRing, snowLineAU(sim.disc.Lstar) * SCENE_PER_AU);

    // Disc colour map.
    updateDiscColors();

    // Volumetric dust particles ride along at the Keplerian rate.
    updateDustCloud(sec);

    updateHud(trk);
}

function nearestIndex(arr, v) {
    let lo = 0, hi = arr.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] < v) lo = mid; else hi = mid;
    }
    return (v - arr[lo] < arr[hi] - v) ? lo : hi;
}

function handleCollisions() {
    const alive = sim.bodies.filter(b => b.alive);
    for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
            const A = alive[i], B = alive[j];
            const dx = A.x - B.x, dy = A.y - B.y;
            const dist = Math.hypot(dx, dy);
            // Combined Hill / proximity radius: use ~ 2 * (R_A + R_B) for inelastic merging.
            const merge = 3 * (A.R_m + B.R_m);
            if (dist < merge) {
                mergeBodies(A, B);
            }
        }
    }
}

function mergeBodies(A, B) {
    // Inelastic merger: conserve momentum (3D), sum masses; remember Theia event.
    const big = (A.m >= B.m) ? A : B;
    const small = (A.m >= B.m) ? B : A;
    const m1 = big.m, m2 = small.m;
    const bvz = big.vz || 0, svz = small.vz || 0;
    big.vx = (m1 * big.vx + m2 * small.vx) / (m1 + m2);
    big.vy = (m1 * big.vy + m2 * small.vy) / (m1 + m2);
    big.vz = (m1 * bvz    + m2 * svz)       / (m1 + m2);
    big.m += m2;
    updateRadius(big);
    small.alive = false;
    small.absorbed_by = big.name;
    // Theia hitting Earth -> trigger giant impact path.
    if ((big.flagEarth && small.flagTheia) || (big.flagTheia && small.flagEarth)) {
        big.flagEarth = true;
        sim.impactDone = true;
        sim.impactBody = big;
        // Boost angular momentum a bit (simulates fast-spin synestia outcome of Cuk & Stewart 2012).
        big.spin_h = 5;  // h/h_rot_break unit, fast spin
        triggerImpactFlash(big.x, big.y, big.z || 0);
    }
}

function checkTheiaImpact() {
    // Force trigger after 60 Myr if Theia is still alive (rare but possible if migration kept them apart).
    if (sim.ageYr > 60e6) {
        const earth = sim.bodies.find(b => b.alive && b.flagEarth);
        const theia = sim.bodies.find(b => b.alive && b.flagTheia);
        if (earth && theia) mergeBodies(earth, theia);
    }
}

function spawnMoon() {
    const earth = sim.bodies.find(b => b.alive && b.flagEarth);
    if (!earth) return;
    // Canup (2012) circumterrestrial debris disc -> Moon at ~3-6 R_earth, then tidal evolution outward.
    const a_moon = 6 * R_EARTH + 0;     // initial post-disc location ≈ Roche-edge x ~2
    // Place the Moon at a heliocentric position relative to Earth.
    const phase = Math.random() * TWO_PI;
    const moon = {
        name: 'Moon',
        m: 7.342e22,
        density: 3344,
        x: earth.x + a_moon * Math.cos(phase) * 50,   // visualization offset
        y: earth.y + a_moon * Math.sin(phase) * 50,
        z: earth.z || 0,
        vx: earth.vx,
        vy: earth.vy,
        vz: earth.vz || 0,
        a_init: a_moon,
        color: 0xc8c8c8,
        role: 'moon',
        flagEarth: false, flagTheia: false,
        final_Mearth: 0.0123,
        R_m: 1737e3,
        alive: true,
        absorbed_by: null,
        atmosphere: null,
        isMoon: true,
        parent: earth,
    };
    sim.bodies.push(moon);
    const moonMesh = makeBodyMesh(moon);
    sim.bodyMeshes.push(moonMesh); sim.scene.add(moonMesh);
    const moonTrail = makeTrail(moon.color);
    sim.bodyTrails.push(moonTrail); sim.scene.add(moonTrail.line);
    const moonOrbit = makeOrbit(moon.color);
    sim.bodyOrbits.push(moonOrbit); sim.scene.add(moonOrbit.line);
    const moonLabel = makeLabelSprite(moon.name);
    sim.bodyLabels.push(moonLabel); sim.scene.add(moonLabel);
    sim.moonSpawned = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD update
// ─────────────────────────────────────────────────────────────────────────────
function updateHud(trk) {
    const ui = sim.ui;
    if (!ui) return;

    ui.age && (ui.age.textContent = formatAge(sim.ageYr));

    // Throttle the heavier per-frame UI work (profile plots, body table,
    // resonance scan) to ~6 Hz so the canvas keeps drawing at full rate.
    const now = performance.now();
    const hudHot = (now - sim.lastHudMs) > 160;
    if (!hudHot) return;
    sim.lastHudMs = now;

    ui.lum && (ui.lum.textContent = trk.L_Lsun.toFixed(3) + ' L☉');
    ui.teff && (ui.teff.textContent = Math.round(trk.Teff) + ' K');
    if (ui.snowLine) ui.snowLine.textContent = snowLineAU(sim.disc.Lstar).toFixed(2) + ' AU';

    const hz = hzBoundaries(trk.L_W, trk.Teff);
    ui.hzInner && (ui.hzInner.textContent = hz.runawayGreen.toFixed(3) + ' AU');
    ui.hzOuter && (ui.hzOuter.textContent = hz.maxGreen.toFixed(3) + ' AU');
    ui.hzOpt   && (ui.hzOpt.textContent   = hz.recentVenus.toFixed(3) + ' – ' + hz.earlyMars.toFixed(3) + ' AU');

    // Mass budget — integrate gas + dust over the grid, sum live planet masses.
    let Mgas = 0, Mdust = 0;
    for (let i = 0; i < sim.disc.n; i++) {
        const dr = (i < sim.disc.n - 1)
            ? sim.disc.r[i+1] - sim.disc.r[i]
            : sim.disc.r[i] - sim.disc.r[i-1];
        const annA = 2 * Math.PI * sim.disc.r[i] * dr;
        Mgas  += annA * sim.disc.sigma[i];
        Mdust += annA * sim.disc.sigmaDust[i];
    }
    let Mplanets = 0;
    for (const b of sim.bodies) if (b.alive) Mplanets += b.m;
    const Macc = sim.disc.Mdotacc;

    ui.discMass   && (ui.discMass.textContent   = (Mgas    / M_SUN * 1000).toFixed(2) + ' × 10⁻³ M☉');
    ui.dustMass   && (ui.dustMass.textContent   = (Mdust   / M_EARTH).toFixed(2) + ' M⊕');
    ui.planetMass && (ui.planetMass.textContent = (Mplanets / M_EARTH).toFixed(2) + ' M⊕');
    ui.accMass    && (ui.accMass.textContent    = (Macc    / M_SUN * 1000).toFixed(3) + ' × 10⁻³ M☉');

    // Ṁ★ (mass-flow rate onto the star) from running total + EMA smoothing.
    if (sim.ageYr > sim.lastMdotAgeYr) {
        const dM_kg  = Macc - sim.lastMdotacc;
        const dt_yr  = sim.ageYr - sim.lastMdotAgeYr;
        const rate   = (dM_kg / M_SUN) / dt_yr;     // M☉ / yr
        sim.mdotEMA  = isFinite(sim.mdotEMA) ? (0.85 * sim.mdotEMA + 0.15 * rate) : rate;
        sim.lastMdotacc   = Macc;
        sim.lastMdotAgeYr = sim.ageYr;
    }
    if (ui.mdot) {
        if (isFinite(sim.mdotEMA) && sim.mdotEMA > 0) {
            ui.mdot.textContent = sim.mdotEMA.toExponential(2) + ' M☉/yr';
        } else {
            ui.mdot.textContent = '—';
        }
    }

    // Disc profile sparklines (log-r horizontal axis).
    drawProfile(ui.profSigma,  sim.disc.sigma,     { log: true,  color: '#ffd700' });
    drawProfile(ui.profDust,   sim.disc.sigmaDust, { log: true,  color: '#ffb84a' });
    drawProfile(ui.profTemp,   sim.disc.T,         { log: false, color: '#70c0ff',
                                                    refValues: [170, 1400], refLabels: ['snow', 'silicate'] });
    const Q = new Float64Array(sim.disc.n);
    for (let i = 0; i < sim.disc.n; i++) {
        const q = toomreQ(sim.disc, i);
        Q[i] = isFinite(q) ? Math.min(q, 50) : 50;     // clamp Σ→0 spike
    }
    drawProfile(ui.profToomre, Q, { log: true, color: '#6fe48b',
                                    refValues: [1], refLabels: ['unstable'] });

    // Resonance scanner.
    if (ui.resList) renderResonances(ui.resList);

    // Body table.
    if (ui.bodyTable) {
        const rows = ['<tr><th>Body</th><th>a</th><th>M</th><th>state</th></tr>'];
        for (const b of sim.bodies) {
            if (!b.alive && !b.absorbed_by) continue;
            const a = b.alive ? semiMajorAxis(b, (sim.cfg.star.Mstar_solar * M_SUN)) / AU : '—';
            const aStr = (typeof a === 'number' && isFinite(a)) ? a.toFixed(2) + ' AU' : '—';
            const mStr = (b.m / M_EARTH).toFixed(3) + ' M⊕';
            let state;
            if (!b.alive) state = '<span style="color:#998">→ ' + (b.absorbed_by || 'lost') + '</span>';
            else if (b.role === 'moon') state = '<span style="color:#cba9ff">spawned</span>';
            else {
                const hab = planetHabitability({ a: b.alive ? semiMajorAxis(b, (sim.cfg.star.Mstar_solar * M_SUN)) : b.a_init, m: b.m, R_m: b.R_m, albedo: 0.3, p_surf_bar: 1, mix: { N2: 0.78, CO2: 0.0004, H2O: 0.01 } },
                    sim.scenario.star, sim.ageYr);
                state = hab.classification;
            }
            rows.push(`<tr><td>${b.name}</td><td>${aStr}</td><td>${mStr}</td><td>${state}</td></tr>`);
        }
        ui.bodyTable.innerHTML = rows.join('');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic profile plots: tiny canvas-2D line charts for Σ, T, Q, dust.
// Horizontal axis is log r over the grid range; reference lines (snow line,
// Q=1, etc.) are passed in via opts.refValues with matching opts.refLabels.
// ─────────────────────────────────────────────────────────────────────────────
function drawProfile(canvas, values, opts) {
    if (!canvas || !values || !values.length) return;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, devicePixelRatio || 1);
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width  = cssW * dpr;
        canvas.height = cssH * dpr;
    }
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Range over finite values.
    let vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!isFinite(v)) continue;
        if (opts.log && v <= 0) continue;
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
    }
    if (!isFinite(vMin) || vMax === vMin) { vMin = 0; vMax = 1; }

    let vLo = vMin, vHi = vMax;
    if (opts.log) { vLo = Math.log10(vMin); vHi = Math.log10(vMax); }
    const padY = 0.05 * (vHi - vLo);
    vLo -= padY; vHi += padY;

    const xOf = (i) => (i / (values.length - 1)) * (W - 4) + 2;
    const yOf = (v) => {
        const u = opts.log ? Math.log10(Math.max(v, 1e-300)) : v;
        return H - ((u - vLo) / (vHi - vLo)) * (H - 4) - 2;
    };

    // Reference lines (snow, silicate, Q=1).
    if (opts.refValues) {
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.lineWidth = 1 * dpr;
        for (const rv of opts.refValues) {
            if (opts.log && rv <= 0) continue;
            const y = yOf(rv);
            if (y < 0 || y > H) continue;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    // Main curve.
    ctx.strokeStyle = opts.color || '#ffd700';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!isFinite(v) || (opts.log && v <= 0)) { started = false; continue; }
        const x = xOf(i);
        const y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Range labels (top-right and bottom-right).
    ctx.fillStyle = '#998';
    ctx.font = (9 * dpr) + 'px monospace';
    ctx.textAlign = 'right';
    const fmt = (v) => {
        if (!isFinite(v)) return '—';
        if (opts.log) return '10^' + v.toFixed(1);
        if (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0)) return v.toExponential(1);
        return v.toFixed(v >= 10 ? 0 : 1);
    };
    ctx.fillText(fmt(vHi), W - 3, 10 * dpr);
    ctx.fillText(fmt(vLo), W - 3, H - 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mean-motion resonance scanner: walk adjacent embryo pairs sorted by a, find
// the nearest p:q commensurability up to p,q ≤ 6, and tag pairs within 1% of
// exact (locked) or within 3% (near).
// ─────────────────────────────────────────────────────────────────────────────
function scanResonances() {
    const Mstar = sim.cfg.star.Mstar_solar * M_SUN;
    const arr = [];
    for (const b of sim.bodies) {
        if (!b.alive || b.isMoon) continue;
        const a = semiMajorAxis(b, Mstar);
        if (!isFinite(a) || a <= 0) continue;
        arr.push({ b, a });
    }
    arr.sort((x, y) => x.a - y.a);
    const out = [];
    for (let i = 0; i < arr.length - 1; i++) {
        const inner = arr[i], outer = arr[i + 1];
        const Pratio = Math.pow(outer.a / inner.a, 1.5);    // P_out / P_in > 1
        if (!isFinite(Pratio) || Pratio < 1.001) continue;
        let best = null;
        for (let q = 1; q <= 5; q++) {
            for (let p = q + 1; p <= q + 6; p++) {
                if (gcdInt(p, q) !== 1) continue;            // reduced form only
                const r = p / q;
                const err = Math.abs(Pratio - r) / r;
                if (!best || err < best.err) best = { p, q, r, err };
            }
        }
        if (!best) continue;
        out.push({
            inner: inner.b.name, outer: outer.b.name,
            Pratio, p: best.p, q: best.q, err: best.err,
        });
    }
    return out;
}

function gcdInt(a, b) { return b ? gcdInt(b, a % b) : a; }

function renderResonances(listEl) {
    const res = scanResonances();
    if (!res.length) {
        listEl.innerHTML = '<li class="ad-res-hint">No alive pairs.</li>';
        return;
    }
    const items = res.map(r => {
        const tag = (r.err < 0.01) ? 'locked' : (r.err < 0.03) ? 'near' : '';
        return `<li class="ad-res-item ${tag}">
            <span class="ad-res-pair">${esc(r.inner)} : ${esc(r.outer)}</span>
            <span><span class="ad-res-ratio">${r.p}:${r.q}</span><span class="ad-res-err">Δ ${(r.err*100).toFixed(1)}%</span></span>
        </li>`;
    });
    listEl.innerHTML = items.join('');
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ─────────────────────────────────────────────────────────────────────────────
// CSV export of current body state for offline analysis.
// ─────────────────────────────────────────────────────────────────────────────
function exportBodiesCsv() {
    const Mstar = sim.cfg.star.Mstar_solar * M_SUN;
    const header = ['name','role','alive','a_AU','a_init_AU','mass_Mearth','R_km','absorbed_by'];
    const rows = [header];
    for (const b of sim.bodies) {
        const a = b.alive ? (semiMajorAxis(b, Mstar) / AU) : '';
        rows.push([
            b.name,
            b.role || '',
            b.alive,
            (typeof a === 'number' && isFinite(a)) ? a.toFixed(4) : '',
            ((b.a_init || 0) / AU).toFixed(4),
            (b.m / M_EARTH).toFixed(5),
            ((b.R_m || 0) / 1000).toFixed(2),
            b.absorbed_by || '',
        ]);
    }
    const csv = rows.map(r => r.map(cell => {
        const s = String(cell);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `accretion-disc_${Math.round(sim.ageYr).toString()}yr.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatAge(yr) {
    if (yr < 1e6) return (yr / 1e3).toFixed(1) + ' kyr';
    if (yr < 1e9) return (yr / 1e6).toFixed(2) + ' Myr';
    return (yr / 1e9).toFixed(2) + ' Gyr';
}

// ─────────────────────────────────────────────────────────────────────────────
// UI bindings
// ─────────────────────────────────────────────────────────────────────────────
function bindUI() {
    const ui = sim.ui;
    if (!ui) return;
    ui.playBtn?.addEventListener('click', () => {
        sim.paused = !sim.paused;
        ui.playBtn.textContent = sim.paused ? '▶ Resume' : '❚❚ Pause';
    });
    ui.resetBtn?.addEventListener('click', () => {
        for (const m of sim.bodyMeshes) sim.scene.remove(m);
        for (const t of sim.bodyTrails) sim.scene.remove(t.line);
        for (const o of sim.bodyOrbits) sim.scene.remove(o.line);
        for (const l of sim.bodyLabels) sim.scene.remove(l);
        sim.bodyMeshes.length = 0;
        sim.bodyTrails.length = 0;
        sim.bodyOrbits.length = 0;
        sim.bodyLabels.length = 0;
        if (sim.flash) { sim.scene.remove(sim.flash.mesh); sim.flash = null; }
        removeDustCloud();
        initScenario(sim.scenario.id);
        sim.lastMdotacc = 0;
        sim.lastMdotAgeYr = sim.ageYr;
        sim.mdotEMA = NaN;
        for (const b of sim.bodies) {
            const m = makeBodyMesh(b); sim.bodyMeshes.push(m); sim.scene.add(m);
            const t = makeTrail(b.color); sim.bodyTrails.push(t); sim.scene.add(t.line);
            const o = makeOrbit(b.color); sim.bodyOrbits.push(o); sim.scene.add(o.line);
            const l = makeLabelSprite(b.name); sim.bodyLabels.push(l); sim.scene.add(l);
        }
        sim.dust = makeDustCloud();
        sim.scene.add(sim.dust.points);
    });
    ui.warpSlider?.addEventListener('input', () => {
        const v = +ui.warpSlider.value / 1000;        // 0..1
        // Log scale 1e2 .. 1e6 yr/sec.
        const yrPerS = Math.pow(10, 2 + 4 * v);
        sim.timeWarpYrPerS = yrPerS;
        ui.warpVal && (ui.warpVal.textContent = yrPerS.toExponential(2) + ' yr/s');
    });
    ui.warpSlider && ui.warpSlider.dispatchEvent(new Event('input'));
    ui.exportCsvBtn?.addEventListener('click', exportBodiesCsv);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────
function loop() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - sim.lastTickMs) / 1000);
    sim.lastTickMs = now;
    sim.controls?.update();
    tick(dt);
    tickFlash();
    sim.renderer.render(sim.scene, sim.camera);
    sim.raf = requestAnimationFrame(loop);
}
