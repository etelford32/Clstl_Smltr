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
} from './physics.js';

import { hzBoundaries, stellarTrack, xuvFlux1AU, planetHabitability } from './habitable.js';
import { SCENARIOS, buildInitialBodies, updateRadius } from './scenarios.js';

// Visual scale: 1 AU -> 5 scene units.
const SCENE_PER_AU = 5;
const TWO_PI = Math.PI * 2;

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
    hzRing: { inner: null, outer: null, optimistic: null },
    star: null,
    starLight: null,
    canvas: null,
    ui: null,
    raf: 0,
    lastTickMs: performance.now(),
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
            const a = Math.hypot(b.x, b.y);
            const aNew = Math.max(0.05 * AU, a + jitter);
            const scale = aNew / a;
            b.x *= scale; b.y *= scale;
            // Re-circularise at the new a (cfg.star.Mstar_solar).
            const v = Math.sqrt(G * Mstar / aNew);
            const ang = Math.atan2(b.y, b.x);
            b.vx = -v * Math.sin(ang); b.vy = v * Math.cos(ang);
        }
        out.push(b);
    }
    sim.bodies = out;
}

// Full live reset: rebuild physics + swap out the visual meshes.
function rebuildWorld() {
    // Tear down old meshes/trails.
    for (const m of sim.bodyMeshes) sim.scene.remove(m);
    for (const t of sim.bodyTrails) sim.scene.remove(t.line);
    sim.bodyMeshes.length = 0;
    sim.bodyTrails.length = 0;
    sim.ageYr = sim.cfg.star.ageStartYr;
    sim.impactDone = false;
    sim.moonSpawned = false;
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
    }
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

    // Star
    const starGeo = new THREE.SphereGeometry(1.5, 32, 32);
    const starMat = new THREE.MeshBasicMaterial({ color: 0xffe080 });
    const star = new THREE.Mesh(starGeo, starMat);
    scene.add(star);
    sim.star = star;

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

    // Embryo meshes
    for (const b of sim.bodies) sim.bodyMeshes.push(makeBodyMesh(b));
    for (const m of sim.bodyMeshes) scene.add(m);

    // Trails
    for (const b of sim.bodies) sim.bodyTrails.push(makeTrail(b.color));
    for (const t of sim.bodyTrails) scene.add(t.line);

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
        opacity: 0.85,
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
    const geom = new THREE.SphereGeometry(radius, 18, 18);
    const mat = new THREE.MeshStandardMaterial({
        color: b.color,
        emissive: new THREE.Color(b.color).multiplyScalar(0.25),
        roughness: 0.65,
        metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData = { body: b };
    return mesh;
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

function pushTrail(t, x, z) {
    t.pos[3*t.head]   = x;
    t.pos[3*t.head+1] = 0.02;
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

    // Push trails + body positions.
    for (let i = 0; i < sim.bodies.length; i++) {
        const b = sim.bodies[i];
        if (!b.alive) { sim.bodyMeshes[i].visible = false; continue; }
        sim.bodyMeshes[i].position.set(b.x / AU * SCENE_PER_AU, 0, b.y / AU * SCENE_PER_AU);
        const radius = Math.max(0.18, 0.35 * Math.cbrt(b.m / M_EARTH));
        sim.bodyMeshes[i].scale.setScalar(radius / 0.35);
        pushTrail(sim.bodyTrails[i], b.x / AU * SCENE_PER_AU, b.y / AU * SCENE_PER_AU);
    }

    // Snow line update.
    updateRing(sim.snowRing, snowLineAU(sim.disc.Lstar) * SCENE_PER_AU);

    // Disc colour map.
    updateDiscColors();

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
    // Inelastic merger: conserve momentum, sum masses; remember Theia event.
    const big = (A.m >= B.m) ? A : B;
    const small = (A.m >= B.m) ? B : A;
    const m1 = big.m, m2 = small.m;
    big.vx = (m1 * big.vx + m2 * small.vx) / (m1 + m2);
    big.vy = (m1 * big.vy + m2 * small.vy) / (m1 + m2);
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
        vx: earth.vx,
        vy: earth.vy,
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
    sim.bodyMeshes.push(makeBodyMesh(moon));
    sim.scene.add(sim.bodyMeshes[sim.bodyMeshes.length - 1]);
    sim.bodyTrails.push(makeTrail(moon.color));
    sim.scene.add(sim.bodyTrails[sim.bodyTrails.length - 1].line);
    sim.moonSpawned = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD update
// ─────────────────────────────────────────────────────────────────────────────
function updateHud(trk) {
    const ui = sim.ui;
    if (!ui) return;

    ui.age && (ui.age.textContent = formatAge(sim.ageYr));
    ui.lum && (ui.lum.textContent = trk.L_Lsun.toFixed(3) + ' L☉');
    ui.teff && (ui.teff.textContent = Math.round(trk.Teff) + ' K');
    if (ui.snowLine) ui.snowLine.textContent = snowLineAU(sim.disc.Lstar).toFixed(2) + ' AU';

    const hz = hzBoundaries(trk.L_W, trk.Teff);
    ui.hzInner && (ui.hzInner.textContent = hz.runawayGreen.toFixed(3) + ' AU');
    ui.hzOuter && (ui.hzOuter.textContent = hz.maxGreen.toFixed(3) + ' AU');
    ui.hzOpt   && (ui.hzOpt.textContent   = hz.recentVenus.toFixed(3) + ' – ' + hz.earlyMars.toFixed(3) + ' AU');

    // Total disc mass.
    let Mdisc = 0;
    for (let i = 0; i < sim.disc.n; i++) {
        const dr = (i < sim.disc.n - 1)
            ? sim.disc.r[i+1] - sim.disc.r[i]
            : sim.disc.r[i] - sim.disc.r[i-1];
        Mdisc += 2 * Math.PI * sim.disc.r[i] * sim.disc.sigma[i] * dr;
    }
    ui.discMass && (ui.discMass.textContent = (Mdisc / M_SUN * 1000).toFixed(2) + ' × 10⁻³ M☉');

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
        sim.bodyMeshes.length = 0;
        sim.bodyTrails.length = 0;
        initScenario(sim.scenario.id);
        for (const b of sim.bodies) {
            const m = makeBodyMesh(b);
            sim.bodyMeshes.push(m);
            sim.scene.add(m);
            const t = makeTrail(b.color);
            sim.bodyTrails.push(t);
            sim.scene.add(t.line);
        }
    });
    ui.warpSlider?.addEventListener('input', () => {
        const v = +ui.warpSlider.value / 1000;        // 0..1
        // Log scale 1e2 .. 1e6 yr/sec.
        const yrPerS = Math.pow(10, 2 + 4 * v);
        sim.timeWarpYrPerS = yrPerS;
        ui.warpVal && (ui.warpVal.textContent = yrPerS.toExponential(2) + ' yr/s');
    });
    ui.warpSlider && ui.warpSlider.dispatchEvent(new Event('input'));
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
    sim.renderer.render(sim.scene, sim.camera);
    sim.raf = requestAnimationFrame(loop);
}
