/**
 * spaceship-designer-3d.js — Parametric rocket builder + launch animation for
 * the Space Ship Designer page.
 *
 * Builds a fully customizable launch vehicle out of THREE primitives driven by
 * a design blob (see spaceship-designer-engine.js): stack of stages, engine
 * clusters, nosecone / fairing / capsule, fins, livery. Then flies it on a
 * physics-derived ascent trajectory with a live HUD callback.
 *
 * Reuses the launch planner's detailed sub-builders so the engines and exhaust
 * look the same as the rest of the site:
 *   launch-engine-bell.js → buildEngineBell  (de Laval / Rao / vacuum nozzles)
 *   launch-plume.js        → buildPlume / tickPlume (shader exhaust)
 *   launch-pad-3d.js       → buildPad / tickBeacons (launch mount + beacons)
 *
 * Public:
 *   createRocketScene(canvas, opts) → {
 *     build(design),          // (re)assemble the rocket from a design blob
 *     launch(ascentResult),   // play a flight; resolves a Promise on MECO
 *     abort(), reset(),
 *     setView(name), setAutoRotate(bool),
 *     dispose(),
 *   }
 *   opts.onTick(state)  — per-frame flight telemetry for the HUD
 *   opts.onPhase(name)  — phase transitions ('idle'|'ignition'|'liftoff'|'ascent'|'meco')
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildEngineBell } from './launch-engine-bell.js';
import { buildPlume, tickPlume } from './launch-plume.js';
import { buildPad, tickBeacons } from './launch-pad-3d.js';
import { PROPELLANTS, ENGINE_CATALOG, LIVERIES } from './spaceship-designer-engine.js';

const DAY_SKY = new THREE.Color(0x9ec7e8);
const SPACE_SKY = new THREE.Color(0x02040a);

export function createRocketScene(canvas, opts = {}) {
    const onTick = opts.onTick || (() => {});
    const onPhase = opts.onPhase || (() => {});

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = DAY_SKY.clone();
    scene.fog = new THREE.Fog(DAY_SKY.clone(), 120, 520);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    camera.position.set(60, 45, 90);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 12;
    controls.maxDistance = 600;
    controls.target.set(0, 30, 0);

    // ── Lighting ──
    scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x202830, 0.85));
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
    sun.position.set(80, 120, 60);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.4);
    fill.position.set(-60, 40, -40);
    scene.add(fill);

    // ── Ground + pad ──
    const world = new THREE.Group();          // everything that "drops away" on ascent
    scene.add(world);
    const ground = new THREE.Mesh(
        new THREE.CircleGeometry(400, 64),
        new THREE.MeshStandardMaterial({ color: 0x39414a, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    world.add(ground);
    let pad = null, padBeacons = [];
    try {
        const p = buildPad('generic', {});
        pad = p.root; padBeacons = p.beacons || [];
        world.add(pad);
    } catch { /* pad optional */ }

    // ── Starfield (fades in with altitude) ──
    const stars = makeStars();
    stars.material.opacity = 0;
    scene.add(stars);

    // ── Rocket ──
    const rocketRoot = new THREE.Group();      // climbs in +Y during flight
    scene.add(rocketRoot);
    let plumes = [];                            // active first-stage plumes
    let engineMounts = [];                      // gimbal pivots { pivot, isFirstStage }
    let currentDesign = null;
    let stage0ThrustFull_kN = 0;               // first-stage thrust at 100% throttle
    let disposables = [];

    // ── Ground exhaust bloom (stays on the pad; fades with altitude) ──
    const groundFX = makeGroundFX();
    groundFX.group.position.y = 0.12;
    groundFX.group.visible = false;
    world.add(groundFX.group);

    function disposeRocket() {
        for (const d of disposables) {
            d.geometry?.dispose?.();
            if (Array.isArray(d.material)) d.material.forEach((m) => m.dispose());
            else d.material?.dispose?.();
        }
        disposables = [];
        rocketRoot.clear();
        plumes = [];
        engineMounts = [];
    }

    function track(obj) {
        obj.traverse?.((c) => { if (c.isMesh) disposables.push(c); });
        if (obj.isMesh) disposables.push(obj);
        return obj;
    }

    // ── Build the rocket from a design ──────────────────────────────────────
    function build(design) {
        currentDesign = design;
        disposeRocket();

        const liv = LIVERIES[design.livery?.id] || LIVERIES.classic;
        const matBody = new THREE.MeshStandardMaterial({ color: liv.primary, roughness: 0.5, metalness: 0.12 });
        const matDark = new THREE.MeshStandardMaterial({ color: liv.secondary, roughness: 0.55, metalness: 0.2 });
        const matAccent = new THREE.MeshStandardMaterial({ color: liv.accent, roughness: 0.4, metalness: 0.3 });

        let y = 0;
        const stageTops = [];

        design.stages.forEach((s, i) => {
            const rTop = s.diameter_m / 2;
            const rBot = (design.stages[i - 1]?.diameter_m / 2) || rTop;
            // Interstage taper if this stage is narrower/wider than the one below.
            if (i > 0 && Math.abs(rTop - rBot) > 0.05) {
                const taperH = Math.max(1.5, Math.abs(rTop - rBot) * 2.2);
                const taper = track(new THREE.Mesh(
                    new THREE.CylinderGeometry(rTop, rBot, taperH, 40, 1, true),
                    matDark
                ));
                taper.position.y = y + taperH / 2;
                rocketRoot.add(taper);
                y += taperH;
            }

            // Stage body.
            const body = track(new THREE.Mesh(
                new THREE.CylinderGeometry(rTop, rTop, s.length_m, 48, 1, true),
                matBody
            ));
            body.position.y = y + s.length_m / 2;
            rocketRoot.add(body);

            // Livery pattern → accent rings.
            addPattern(rocketRoot, design.livery?.pattern || 'solid', rTop, y, s.length_m, matAccent, track);

            // Engine section ring (darker collar at the base of the stage).
            const collarH = Math.min(2.2, s.length_m * 0.08);
            const collar = track(new THREE.Mesh(
                new THREE.CylinderGeometry(rTop * 1.005, rTop * 1.02, collarH, 48, 1, true),
                matDark
            ));
            collar.position.y = y + collarH / 2;
            rocketRoot.add(collar);

            // Engine cluster at the base of this stage (points down).
            addEngines(rocketRoot, s, rTop, y, i === 0);

            stageTops.push(y + s.length_m);
            y += s.length_m;
        });

        const topR = design.stages[design.stages.length - 1]?.diameter_m / 2 || 1.8;

        // ── Nosecone / payload / cockpit ──
        addNosecone(rocketRoot, design, topR, y, { matBody, matDark, matAccent }, track);

        // ── Fins on the first stage ──
        addFins(rocketRoot, design.fins, design.stages[0]?.diameter_m / 2 || 1.8, track, matDark);

        // First-stage thrust (full throttle) — drives the live thrust HUD and the
        // ground-bloom intensity during a static fire.
        const s0 = design.stages[0];
        if (s0) {
            const e0 = ENGINE_CATALOG[s0.engineId] || ENGINE_CATALOG.merlin_1d;
            stage0ThrustFull_kN = (e0.sl_kn || e0.vac_kn || 0) * Math.max(1, s0.engineCount | 0);
            // Size the ground bloom to the booster footprint and tint it to the fuel.
            const prop0 = PROPELLANTS[s0.propellantId] || PROPELLANTS.kerolox;
            groundFX.configure((s0.diameter_m / 2) * 2.6, prop0.flame);
        }

        // A rebuild blows away the old plumes/pivots; if we're mid static-fire
        // (e.g. the user nudged the throttle slider), re-light the new engines so
        // the test keeps running and updates live.
        if (staticFire) {
            plumes.forEach((p) => { p.visible = true; });
            groundFX.group.visible = true;
        }

        frameCamera();
        return { height: y + (design.payload?.fairingLen_m || 8) };
    }

    function addPattern(parent, pattern, r, y0, len, matAccent, track) {
        const ring = (yy, h) => {
            const m = track(new THREE.Mesh(
                new THREE.CylinderGeometry(r * 1.012, r * 1.012, h, 48, 1, true),
                matAccent
            ));
            m.position.y = yy;
            parent.add(m);
        };
        if (pattern === 'stripe') ring(y0 + len * 0.82, Math.min(2, len * 0.06));
        else if (pattern === 'bands') {
            for (let f = 0.2; f < 0.95; f += 0.25) ring(y0 + len * f, Math.min(1.2, len * 0.04));
        } else if (pattern === 'checker') {
            for (let f = 0.15; f < 0.95; f += 0.18) ring(y0 + len * f, Math.min(0.8, len * 0.03));
        }
    }

    function addEngines(parent, stageDef, stageR, baseY, isFirstStage) {
        const eng = ENGINE_CATALOG[stageDef.engineId] || ENGINE_CATALOG.merlin_1d;
        const prop = PROPELLANTS[stageDef.propellantId] || PROPELLANTS.kerolox;
        const count = Math.max(1, Math.min(45, stageDef.engineCount | 0));
        const positions = clusterPositions(count, stageR * 0.82);

        // Build one bell to measure its natural exit radius, then scale all
        // copies so the cluster fits inside the stage diameter.
        const proto = buildEngineBell({ type: eng.bell, detail: count > 12 ? 'low' : count > 4 ? 'medium' : 'high' });
        const box = new THREE.Box3().setFromObject(proto);
        const natR = Math.max(0.2, (box.max.x - box.min.x) / 2);
        const spacing = nearestSpacing(positions);
        const targetR = Math.min(spacing * 0.46, stageR * 0.9 / Math.max(1, Math.cbrt(count)));
        const scale = Math.max(0.12, targetR / natR);
        proto.scale.setScalar(scale);

        positions.forEach(([px, pz], idx) => {
            // Each engine hangs off a gimbal pivot at its mount point so the bell
            // and its plume can thrust-vector together (rotate about the mount,
            // not about the rocket centreline).
            const pivot = new THREE.Group();
            pivot.position.set(px, baseY, pz);
            parent.add(pivot);
            engineMounts.push({ pivot, isFirstStage });

            const bell = idx === 0 ? proto : proto.clone();
            if (idx !== 0) bell.scale.setScalar(scale);
            bell.position.set(0, -0.2, 0);
            bell.traverse((c) => { if (c.isMesh) disposables.push(c); });
            pivot.add(bell);

            // Plumes only on the first stage (the one that fires at liftoff).
            if (isFirstStage) {
                const plume = buildPlume({
                    coreRadius: natR * scale * 0.7,
                    outerLen: natR * scale * 26,
                    coreColor: 0xfff5d8,
                    midColor: prop.flame,
                    outerColor: 0x40210e,
                    name: `plume-${idx}`,
                });
                plume.position.set(0, -natR * scale * 2.0, 0);
                plume.traverse((c) => { if (c.isMesh) disposables.push(c); });
                pivot.add(plume);
                plumes.push(plume);
            }
        });
    }

    function addNosecone(parent, design, r, y0, mats, track) {
        const type = design.payload?.nosecone || 'ogive';
        const len = Math.max(3, design.payload?.fairingLen_m || 8);

        if (type === 'capsule') {
            // Gumdrop crew capsule + window band.
            const cap = track(new THREE.Mesh(
                new THREE.CylinderGeometry(r * 0.55, r, len * 0.7, 40, 1, true),
                mats.matBody
            ));
            cap.position.y = y0 + len * 0.35;
            parent.add(cap);
            const dome = track(new THREE.Mesh(
                new THREE.SphereGeometry(r * 0.55, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
                mats.matBody
            ));
            dome.position.y = y0 + len * 0.7;
            parent.add(dome);
            addWindows(parent, design, r * 0.8, y0 + len * 0.42, track);
        } else if (type === 'spaceplane') {
            const fuse = track(new THREE.Mesh(
                new THREE.CylinderGeometry(r * 0.7, r, len, 40, 1, true),
                mats.matBody
            ));
            fuse.position.y = y0 + len / 2;
            parent.add(fuse);
            const wing = track(new THREE.Mesh(new THREE.BoxGeometry(r * 5, 0.4, r * 1.6), mats.matDark));
            wing.position.set(0, y0 + len * 0.25, 0);
            parent.add(wing);
            addWindows(parent, design, r * 0.9, y0 + len * 0.75, track);
        } else {
            // Cone / ogive / blunt fairing.
            const topR = type === 'cone' ? 0.01 : type === 'blunt' ? r * 0.4 : 0.05;
            const segs = type === 'ogive' ? 40 : 32;
            const nose = track(new THREE.Mesh(
                new THREE.CylinderGeometry(topR, r, len, segs, 1, true),
                mats.matBody
            ));
            nose.position.y = y0 + len / 2;
            parent.add(nose);
            if (design.cockpit?.layout && design.cockpit.layout !== 'none') {
                addWindows(parent, design, r * 0.95, y0 + len * 0.55, track);
            }
        }
    }

    function addWindows(parent, design, r, yy, track) {
        const n = Math.max(0, Math.min(8, design.cockpit?.windows ?? 2));
        const glass = new THREE.MeshStandardMaterial({
            color: design.cockpit?.layout === 'glass' ? 0x0a1a2a : 0x121821,
            emissive: 0x123a55, emissiveIntensity: 0.6, roughness: 0.15, metalness: 0.6,
        });
        for (let i = 0; i < n; i++) {
            const a = (i / Math.max(1, n)) * Math.PI * 2;
            const w = track(new THREE.Mesh(new THREE.CircleGeometry(r * 0.16, 16), glass));
            w.position.set(Math.cos(a) * r, yy, Math.sin(a) * r);
            w.lookAt(Math.cos(a) * r * 2, yy, Math.sin(a) * r * 2);
            parent.add(w);
        }
    }

    function addFins(parent, fins, r, track, matDark) {
        if (!fins || fins.type === 'none') return;
        const count = Math.max(2, Math.min(8, fins.count || 4));
        for (let i = 0; i < count; i++) {
            const a = (i / count) * Math.PI * 2;
            let mesh;
            if (fins.type === 'grid') {
                mesh = track(new THREE.Mesh(new THREE.BoxGeometry(r * 1.1, r * 1.1, 0.18), matDark));
                mesh.position.set(Math.cos(a) * r * 1.05, r * 6, Math.sin(a) * r * 1.05);
                mesh.rotation.y = -a;
            } else {
                const shape = new THREE.Shape();
                const sweep = fins.type === 'swept' ? 1.6 : 0.6;
                shape.moveTo(0, 0); shape.lineTo(r * 1.4, 0);
                shape.lineTo(r * (0.3 + sweep * 0.2), r * 2.2); shape.lineTo(0, r * 2.2);
                shape.closePath();
                const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.18, bevelEnabled: false });
                mesh = track(new THREE.Mesh(geo, matDark));
                mesh.position.set(Math.cos(a) * r, 0.2, Math.sin(a) * r);
                mesh.rotation.y = -a + Math.PI / 2;
            }
            parent.add(mesh);
        }
    }

    // ── Camera framing ──────────────────────────────────────────────────────
    function frameCamera() {
        const box = new THREE.Box3().setFromObject(rocketRoot);
        if (box.isEmpty()) return;
        const size = new THREE.Vector3(); box.getSize(size);
        const center = new THREE.Vector3(); box.getCenter(center);
        const h = Math.max(size.y, size.x, 10);
        const dist = h * 1.5;
        camera.position.set(dist * 0.7, center.y + h * 0.15, dist);
        controls.target.set(0, center.y, 0);
        controls.update();
    }

    function setView(name) {
        const box = new THREE.Box3().setFromObject(rocketRoot);
        const size = new THREE.Vector3(); box.getSize(size);
        const center = new THREE.Vector3(); box.getCenter(center);
        const h = Math.max(size.y, 10), d = h * 1.4;
        const cy = center.y;
        if (name === 'front') camera.position.set(0, cy, d);
        else if (name === 'side') camera.position.set(d, cy, 0);
        else if (name === 'top') camera.position.set(0.01, cy + d, 0.01);
        else camera.position.set(d * 0.7, cy + h * 0.15, d);
        controls.target.set(0, cy, 0);
        controls.update();
    }

    // ── Thrust vectoring (gimbal) ────────────────────────────────────────────
    // Tilt every first-stage engine pivot (bell + plume) by the same small angle
    // so the cluster visibly vectors. Angles are in radians; ~0.1 rad ≈ 5.7°.
    function applyGimbal(angX, angZ) {
        for (const m of engineMounts) {
            if (!m.isFirstStage) continue;
            m.pivot.rotation.x = angX;
            m.pivot.rotation.z = angZ;
        }
    }
    function clearGimbal() { applyGimbal(0, 0); }

    // ── Static fire (hold-down engine test on the pad) ───────────────────────
    let staticFire = false;
    function setStaticFire(on) {
        if (flight) return;                 // can't static-fire mid-flight
        staticFire = !!on;
        plumes.forEach((p) => { p.visible = staticFire; });
        groundFX.group.visible = staticFire;
        if (!staticFire) { clearGimbal(); onPhase('idle'); }
        else onPhase('static-fire');
    }

    // ── Flight animation ────────────────────────────────────────────────────
    let flight = null;     // { traj, dur, t0, resolve, result }
    let autoRotate = false;
    const clock = new THREE.Clock();

    function launch(ascentResult) {
        staticFire = false;                       // a real launch supersedes a static fire
        if (!ascentResult || !ascentResult.trajectory?.length) {
            // No usable trajectory — still show ignition then "fail".
            return Promise.resolve(ascentResult);
        }
        rocketRoot.position.y = 0;
        plumes.forEach((p) => { p.visible = false; });
        clearGimbal();
        onPhase('ignition');
        return new Promise((resolve) => {
            flight = {
                traj: ascentResult.trajectory,
                burn: ascentResult.trajectory[ascentResult.trajectory.length - 1].t || 1,
                t0: clock.getElapsedTime() + 2.2,    // 2.2 s ignition hold
                ignited: false,
                resolve,
                result: ascentResult,
            };
        });
    }

    function abort() { if (flight) { endFlight(flight.result); } }

    function reset() {
        flight = null;
        staticFire = false;
        rocketRoot.position.y = 0;
        plumes.forEach((p) => { p.visible = false; });
        clearGimbal();
        groundFX.group.visible = false;
        scene.background = DAY_SKY.clone();
        scene.fog.color = DAY_SKY.clone();
        stars.material.opacity = 0;
        world.position.y = 0;
        onPhase('idle');
    }

    function endFlight(result) {
        const f = flight; flight = null;
        plumes.forEach((p) => { p.visible = false; });
        clearGimbal();
        groundFX.group.visible = false;
        onPhase('meco');
        f?.resolve?.(result);
    }

    // sample trajectory (alt_km, v_kms, + aero telemetry) at flight-time t
    function sampleTraj(traj, t) {
        if (t <= traj[0].t) return traj[0];
        const last = traj[traj.length - 1];
        if (t >= last.t) return last;
        for (let i = 1; i < traj.length; i++) {
            if (traj[i].t >= t) {
                const a = traj[i - 1], b = traj[i];
                const f = (t - a.t) / Math.max(1e-3, b.t - a.t);
                const lerp = (k, d = 0) => (a[k] ?? d) + ((b[k] ?? d) - (a[k] ?? d)) * f;
                return {
                    t, alt_km: lerp('alt_km'),
                    v_kms: lerp('v_kms'),
                    mass_frac: lerp('mass_frac', 1),
                    // Aerodynamic telemetry (enriched by runAscent) for the live panel.
                    mach: lerp('mach'), q_kPa: lerp('q_kPa'), reynolds: lerp('reynolds'),
                    drag_kN: lerp('drag_kN'),
                    dragFriction_kN: lerp('dragFriction_kN'),
                    dragPressure_kN: lerp('dragPressure_kN'),
                    dragWave_kN: lerp('dragWave_kN'),
                    boundaryLayer: (f < 0.5 ? a : b).boundaryLayer,
                    regime: (f < 0.5 ? a : b).regime,
                    // Propulsion telemetry.
                    thrust_kN: lerp('thrust_kN'), isp_s: lerp('isp_s'),
                    twr: lerp('twr'), accel_g: lerp('accel_g'),
                    dv_used_kms: lerp('dv_used_kms'),
                    stage: (f < 0.5 ? a : b).stage,
                    coasting: (f < 0.5 ? a : b).coasting,
                };
            }
        }
        return last;
    }

    // Compress real altitude (0..hundreds of km) into a small scene rise so the
    // rocket visibly climbs while staying framed. Pad/ground drop with it.
    const altToScene = (altKm) => Math.log10(1 + altKm) * 26;

    function tickFlight(now) {
        const f = flight;
        const tcd = now - f.t0;       // negative during ignition hold

        if (tcd < 0) {
            // Ignition hold: spin up plume, hold on pad, build the exhaust bloom.
            if (!f.ignited && tcd > -1.4) {
                plumes.forEach((p) => { p.visible = true; });
                groundFX.group.visible = true;
                f.ignited = true;
            }
            const spool = Math.max(0, 1 + tcd / 1.4);
            plumes.forEach((p) => tickPlume(p, now, spool * 0.6, 0));
            groundFX.tick(now, spool * 0.6, 1);     // full ground-effect on the pad
            // Engines settle from a small ignition twitch to centred as they light.
            applyGimbal(Math.sin(now * 9) * 0.05 * (1 - spool), Math.cos(now * 7) * 0.05 * (1 - spool));
            onTick({ phase: 'ignition', t: tcd, altKm: 0, vKms: 0, throttle: spool * 0.6,
                     thrustMN: stage0ThrustFull_kN * spool * 0.6 / 1000 });
            return;
        }

        // Playback speed: compress the multi-minute ascent into ~14 s.
        const PLAY = Math.max(6, f.burn / 14);
        const flightT = tcd * PLAY;
        const s = sampleTraj(f.traj, flightT);
        // Plume follows the real engine: lit whenever there is thrust, dark during
        // the inter-stage coast. Intensity scales with thrust vs the sea-level
        // liftoff thrust (so the vacuum thrust rise reads as a fuller plume).
        const burning = (s.thrust_kN ?? 0) > 1 && !s.coasting;
        const throttle = burning
            ? Math.max(0.55, Math.min(1.2, (s.thrust_kN || 0) / Math.max(1, stage0ThrustFull_kN)))
            : 0;

        const rise = altToScene(s.alt_km);
        rocketRoot.position.y = rise;              // rocket climbs; the ground stays put
        // Camera eases upward to follow.
        const targetY = rocketRoot.position.y + 25;
        controls.target.y += (targetY - controls.target.y) * 0.05;

        // Sky darkens with altitude.
        const mix = Math.min(1, s.alt_km / 90);
        scene.background.copy(DAY_SKY).lerp(SPACE_SKY, mix);
        scene.fog.color.copy(scene.background);
        stars.material.opacity = mix;

        plumes.forEach((p) => { p.visible = throttle > 0; tickPlume(p, now, throttle, s.alt_km); });

        // Thrust vectoring: a slow guidance weave plus a downrange lean that grows
        // with altitude — the visible signature of the gravity-turn steering.
        const lean = Math.min(0.16, s.alt_km / 90 * 0.16) * throttle;
        applyGimbal(
            (lean + Math.sin(flightT * 0.6) * 0.03) * throttle,
            Math.sin(flightT * 0.45 + 1.3) * 0.03 * throttle,
        );

        // Ground bloom only reads near the pad; fade it out over the first ~1.5 km.
        const groundMix = Math.max(0, 1 - s.alt_km / 1.5);
        groundFX.group.visible = groundMix > 0.02 && throttle > 0;
        if (groundFX.group.visible) groundFX.tick(now, throttle, groundMix);

        if (s.coasting) onPhase('staging');
        else if (tcd < 0.2) onPhase('liftoff');
        else onPhase((s.stage || 1) > 1 ? 'stage ' + s.stage : 'ascent');
        onTick({ phase: 'ascent', t: flightT, altKm: s.alt_km, vKms: s.v_kms,
                 throttle: burning ? 1 : 0,
                 thrustMN: (s.thrust_kN ?? 0) / 1000,
                 massFrac: s.mass_frac,
                 mach: s.mach, qkPa: s.q_kPa, reynolds: s.reynolds,
                 dragkN: s.drag_kN, dragFrictionkN: s.dragFriction_kN,
                 dragPressurekN: s.dragPressure_kN, dragWavekN: s.dragWave_kN,
                 boundaryLayer: s.boundaryLayer, regime: s.regime,
                 // Propulsion telemetry for the live engine panel.
                 isp: s.isp_s, twr: s.twr, accelG: s.accel_g,
                 stage: s.stage, coasting: s.coasting, dvUsed: s.dv_used_kms });

        if (flightT >= f.burn - 1e-3) endFlight(f.result);
    }

    // Static-fire test: hold on the pad and fire stage 1 at the design throttle,
    // with the engines weaving on their gimbals so the thrust vector is visible.
    function tickStaticFire(now) {
        const thr = clamp01(currentDesign?.stages?.[0]?.throttle ?? 1);
        plumes.forEach((p) => { p.visible = thr > 0; tickPlume(p, now, thr, 0); });
        groundFX.group.visible = thr > 0;
        if (groundFX.group.visible) groundFX.tick(now, thr, 1);
        // Exaggerated gimbal sweep (a Lissajous figure) so the vectoring is obvious.
        applyGimbal(
            Math.sin(now * 1.3) * 0.09 * thr,
            Math.sin(now * 0.9 + 1.0) * 0.09 * thr,
        );
        onTick({ phase: 'static-fire', t: now, altKm: 0, vKms: 0, throttle: thr,
                 thrustMN: stage0ThrustFull_kN * thr / 1000 });
    }

    // ── Render loop ─────────────────────────────────────────────────────────
    let raf = 0, running = true;
    function render() {
        if (!running) return;
        raf = requestAnimationFrame(render);
        const now = clock.getElapsedTime();
        if (autoRotate && !flight && !staticFire) rocketRoot.rotation.y += 0.0035;
        tickBeacons(padBeacons, now);
        if (flight) tickFlight(now);
        else if (staticFire) tickStaticFire(now);
        controls.update();
        renderer.render(scene, camera);
    }

    function resize() {
        const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 640;
        const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 480;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement || canvas);
    resize();
    render();

    function dispose() {
        running = false;
        cancelAnimationFrame(raf);
        ro.disconnect();
        controls.dispose();
        disposeRocket();
        groundFX.dispose();
        stars.geometry.dispose(); stars.material.dispose();
        renderer.dispose();
    }

    return {
        build,
        launch,
        abort,
        reset,
        setStaticFire,
        get isStaticFiring() { return staticFire; },
        setView,
        setAutoRotate: (v) => { autoRotate = !!v; },
        dispose,
        get design() { return currentDesign; },
    };
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * Ground exhaust bloom — a flat additive disc + an expanding shock ring that
 * pulse at the base of the booster while it fires. Purely cosmetic; intensity
 * is driven by throttle and a 0..1 `mix` so it can fade out with altitude.
 */
function makeGroundFX() {
    const group = new THREE.Group();
    group.rotation.x = -Math.PI / 2;           // lie flat on the ground

    const discMat = new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 48), discMat);
    group.add(disc);

    const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffe6c2, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 48), ringMat);
    group.add(ring);

    let baseR = 8;
    return {
        group, disc, ring,
        configure(radius, color) {
            baseR = Math.max(2, radius);
            disc.material.color.set(color);
            ring.material.color.set(color).lerp(new THREE.Color(0xffffff), 0.4);
        },
        tick(t, throttle, mix) {
            const k = clamp01(throttle) * clamp01(mix);
            // Billowing disc — breathes with a fast flicker so it doesn't look static.
            const flick = 0.85 + Math.sin(t * 22) * 0.15;
            const dR = baseR * (0.9 + 0.25 * Math.sin(t * 6)) * (0.6 + 0.6 * k);
            disc.scale.setScalar(dR);
            disc.material.opacity = 0.5 * k * flick;
            // Shock ring expands outward then resets — reads as rolling exhaust.
            const phase = (t * 0.8) % 1;
            ring.scale.setScalar(baseR * (1 + phase * 1.8));
            ring.material.opacity = 0.45 * k * (1 - phase);
        },
        dispose() {
            disc.geometry.dispose(); disc.material.dispose();
            ring.geometry.dispose(); ring.material.dispose();
        },
    };
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** Concentric-ring engine cluster positions inside `rMax`. */
function clusterPositions(count, rMax) {
    if (count <= 1) return [[0, 0]];
    const pos = [[0, 0]];                       // center engine
    let remaining = count - 1;
    let ring = 1;
    const ringGap = rMax / (Math.ceil(Math.sqrt(count) / 1.6) + 0.5);
    while (remaining > 0) {
        const r = Math.min(rMax, ring * ringGap);
        const cap = Math.max(6, Math.floor((2 * Math.PI * r) / (ringGap * 0.9)));
        const n = Math.min(remaining, cap);
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + (ring % 2 ? 0 : Math.PI / n);
            pos.push([Math.cos(a) * r, Math.sin(a) * r]);
        }
        remaining -= n;
        ring++;
        if (ring > 6) break;
    }
    return pos.slice(0, count);
}

/** Nearest-neighbour spacing among cluster positions (for bell sizing). */
function nearestSpacing(positions) {
    if (positions.length < 2) return 2;
    let min = Infinity;
    for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
            const dx = positions[i][0] - positions[j][0];
            const dz = positions[i][1] - positions[j][1];
            min = Math.min(min, Math.hypot(dx, dz));
        }
    }
    return isFinite(min) ? min : 2;
}

function makeStars() {
    const N = 1400;
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        const r = 800 + Math.random() * 1500;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        arr[i * 3] = r * Math.sin(ph) * Math.cos(th);
        arr[i * 3 + 1] = Math.abs(r * Math.cos(ph)) + 50;
        arr[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.4, sizeAttenuation: false, transparent: true, opacity: 0, fog: false });
    return new THREE.Points(geo, mat);
}
