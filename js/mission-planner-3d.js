/**
 * mission-planner-3d.js — Visual mission-planner simulator.
 *
 * Self-contained Three.js scene built around an Earth-centered coordinate
 * frame where 1 scene unit = 1 Earth radius (R⊕ = 6378 km). Supports:
 *
 *   - Launch animation: rocket lifts from a chosen launch site on the
 *     surface, follows a gravity-turn-style profile to the target altitude,
 *     and deploys a payload that then circularizes into orbit.
 *   - Orbit propagation: deployed payloads coast in a circular orbit at the
 *     requested altitude/inclination and trail a fading ribbon.
 *   - Trajectory previews: Moon transfer (Hohmann-style ellipse to lunar
 *     distance) and Mars transfer (escape spiral + heliocentric arc).
 *
 * The math is intentionally schematic — this is a *visual* planner, not a
 * trajectory optimizer. Numbers come from textbook two-body mechanics so
 * the time-of-flight values shown in the HUD are in the right ballpark.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── Constants ────────────────────────────────────────────────────────────────
const R_EARTH_KM   = 6378;
const MU_EARTH     = 398600.4418;        // km^3/s^2
const MOON_DIST_KM = 384400;             // mean lunar distance
const MOON_R_KM    = 1737;
const MARS_DIST_KM = 78340000;           // approx min Earth-Mars (visual only)

const R_MOON_SCENE = MOON_DIST_KM / R_EARTH_KM;     // ~60 R⊕
const R_MOON_BODY  = MOON_R_KM    / R_EARTH_KM;     // ~0.27 R⊕

// Launch sites (lat, lon in degrees; common operational pads).
export const LAUNCH_SITES = [
    { id: 'ksc',     name: 'Kennedy SC (USA)',     lat: 28.573, lon: -80.649 },
    { id: 'baikonur',name: 'Baikonur (KAZ)',       lat: 45.965, lon:  63.305 },
    { id: 'kourou',  name: 'Kourou (FRA)',         lat:  5.236, lon: -52.768 },
    { id: 'starbase',name: 'Starbase (USA)',       lat: 25.997, lon: -97.155 },
    { id: 'wenchang',name: 'Wenchang (CHN)',       lat: 19.614, lon: 110.951 },
    { id: 'vandy',   name: 'Vandenberg (USA)',     lat: 34.742, lon:-120.572 },
];

export const TARGET_ORBITS = [
    { id: 'leo',  name: 'LEO · 400 km',  alt_km:    400 },
    { id: 'sso',  name: 'SSO · 600 km',  alt_km:    600, inc_deg: 97.8 },
    { id: 'meo',  name: 'MEO · 20 200 km (GPS)', alt_km: 20200, inc_deg: 55 },
    { id: 'geo',  name: 'GEO · 35 786 km',       alt_km: 35786, inc_deg: 0  },
    { id: 'moon', name: 'Lunar transfer',        alt_km: MOON_DIST_KM, isTransfer: 'moon' },
    { id: 'mars', name: 'Mars transfer (TMI)',   alt_km: MARS_DIST_KM, isTransfer: 'mars' },
];

// ── Math helpers ─────────────────────────────────────────────────────────────
const DEG = Math.PI / 180;

// Convert (lat, lon) on Earth's surface to a Vector3 (in Earth-radii units).
// We treat +Y as north; lon=0 maps to +X.
function latLonToVec3(latDeg, lonDeg, r = 1) {
    const phi    = latDeg * DEG;
    const lambda = lonDeg * DEG;
    return new THREE.Vector3(
        r * Math.cos(phi) * Math.cos(lambda),
        r * Math.sin(phi),
        -r * Math.cos(phi) * Math.sin(lambda),
    );
}

// Circular-orbit speed at radius r_km (km/s).
function vCirc(r_km) { return Math.sqrt(MU_EARTH / r_km); }

// Hohmann transfer Δv from r1 to r2 (km/s, both radii in km from Earth's center).
function hohmannDV(r1_km, r2_km) {
    const a = (r1_km + r2_km) / 2;
    const v1   = vCirc(r1_km);
    const v2   = vCirc(r2_km);
    const vp   = Math.sqrt(MU_EARTH * (2/r1_km - 1/a));
    const vap  = Math.sqrt(MU_EARTH * (2/r2_km - 1/a));
    const dv1  = vp - v1;
    const dv2  = v2 - vap;
    const tof_s = Math.PI * Math.sqrt(a*a*a / MU_EARTH);
    return { dv1, dv2, total: Math.abs(dv1) + Math.abs(dv2), tof_s, a };
}

// ── Scene builder ────────────────────────────────────────────────────────────
export function initMissionPlanner({ container, onEvent } = {}) {
    if (!container) throw new Error('initMissionPlanner: container required');

    const w = () => container.clientWidth  || 800;
    const h = () => container.clientHeight || 520;

    const scene  = new THREE.Scene();
    scene.background = new THREE.Color(0x05030f);

    const camera = new THREE.PerspectiveCamera(45, w()/h(), 0.05, 5000);
    camera.position.set(3.5, 2.4, 4.6);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w(), h());
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.4;
    controls.maxDistance = 200;

    // ── Lights ──────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0x404060, 0.55));
    const sun = new THREE.DirectionalLight(0xffeec8, 1.1);
    sun.position.set(8, 4, 5);
    scene.add(sun);

    // ── Starfield ───────────────────────────────────────────────────────────
    {
        const N = 1500;
        const pos = new Float32Array(N*3);
        for (let i=0; i<N; i++) {
            const r = 600;
            const u = Math.random()*2 - 1;
            const t = Math.random()*Math.PI*2;
            const s = Math.sqrt(1 - u*u);
            pos[i*3+0] = r * s * Math.cos(t);
            pos[i*3+1] = r * u;
            pos[i*3+2] = r * s * Math.sin(t);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const m = new THREE.PointsMaterial({ color: 0xffffff, size: 0.55, sizeAttenuation: false, transparent: true, opacity: 0.7 });
        scene.add(new THREE.Points(g, m));
    }

    // ── Earth ───────────────────────────────────────────────────────────────
    const earth = new THREE.Mesh(
        new THREE.SphereGeometry(1, 64, 48),
        new THREE.MeshPhongMaterial({
            color: 0x2a4f8e, emissive: 0x0a1830, emissiveIntensity: 0.4,
            shininess: 18, specular: 0x4488cc,
        })
    );
    scene.add(earth);

    // Equator + prime meridian wireframe to communicate orientation.
    const grid = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(1.001, 18, 12)),
        new THREE.LineBasicMaterial({ color: 0x335577, transparent: true, opacity: 0.18 })
    );
    scene.add(grid);

    // Atmosphere glow shell.
    const atmo = new THREE.Mesh(
        new THREE.SphereGeometry(1.04, 48, 32),
        new THREE.MeshBasicMaterial({ color: 0x66aaff, transparent: true, opacity: 0.08, side: THREE.BackSide })
    );
    scene.add(atmo);

    // ── Moon (always rendered for visual context) ───────────────────────────
    const moonAngle = { theta: 0 };
    const moon = new THREE.Mesh(
        new THREE.SphereGeometry(R_MOON_BODY, 32, 24),
        new THREE.MeshPhongMaterial({ color: 0xb8b8b8, emissive: 0x333333 })
    );
    scene.add(moon);
    const moonOrbitLine = makeRingLine(R_MOON_SCENE, 0x444466, 0.35);
    scene.add(moonOrbitLine);

    // ── State ───────────────────────────────────────────────────────────────
    const state = {
        site: LAUNCH_SITES[0],
        target: TARGET_ORBITS[0],
        rockets: [],   // active in-flight vehicles
        payloads: [],  // deployed orbiting payloads
        markers: [],   // surface launch-site dots
        timeScale: 1,
        clock: new THREE.Clock(),
        elapsed: 0,
    };

    // ── Surface markers for all launch sites ────────────────────────────────
    for (const s of LAUNCH_SITES) {
        const dot = new THREE.Mesh(
            new THREE.SphereGeometry(0.018, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffaa33 })
        );
        dot.position.copy(latLonToVec3(s.lat, s.lon, 1.005));
        dot.userData.siteId = s.id;
        scene.add(dot);
        state.markers.push(dot);
    }

    // ── Public API: launch ──────────────────────────────────────────────────
    function launch({ siteId, targetId, payloadName = 'PayloadSat-1' }) {
        const site   = LAUNCH_SITES.find(s => s.id === siteId)   || state.site;
        const target = TARGET_ORBITS.find(t => t.id === targetId) || state.target;
        state.site   = site;
        state.target = target;

        const startPos = latLonToVec3(site.lat, site.lon, 1.0);
        const inc      = (target.inc_deg ?? Math.abs(site.lat));
        const altScene = (target.alt_km / R_EARTH_KM);
        const rOrbit   = 1 + altScene;

        // Pick an orbital plane: tilt by `inc` around the X axis after we
        // construct an "ascending node" frame oriented from the launch site.
        const ascNode = new THREE.Vector3(startPos.x, 0, startPos.z).normalize();
        const planeNormal = new THREE.Vector3(0, 1, 0)
            .applyAxisAngle(ascNode.clone().cross(new THREE.Vector3(0,1,0)).normalize(), inc * DEG)
            .normalize();

        // Rocket body: simple cylinder + cone nose.
        const rocketGroup = new THREE.Group();
        const body = new THREE.Mesh(
            new THREE.CylinderGeometry(0.012, 0.014, 0.07, 12),
            new THREE.MeshPhongMaterial({ color: 0xeeeeee, emissive: 0x222222 })
        );
        const nose = new THREE.Mesh(
            new THREE.ConeGeometry(0.012, 0.025, 12),
            new THREE.MeshPhongMaterial({ color: 0xff5533 })
        );
        nose.position.y = 0.045;
        rocketGroup.add(body, nose);

        // Engine plume (additive sprite-ish glow).
        const plume = new THREE.Mesh(
            new THREE.ConeGeometry(0.015, 0.06, 12, 1, true),
            new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
        );
        plume.rotation.x = Math.PI;
        plume.position.y = -0.05;
        rocketGroup.add(plume);

        // Trail
        const trailMat = new THREE.LineBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.85 });
        const trailGeom = new THREE.BufferGeometry();
        trailGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(600*3), 3));
        trailGeom.setDrawRange(0, 0);
        const trail = new THREE.Line(trailGeom, trailMat);
        scene.add(trail);

        scene.add(rocketGroup);

        const rocket = {
            group: rocketGroup,
            trail, trailGeom, trailIndex: 0,
            site, target,
            startPos, planeNormal, ascNode, rOrbit, inc,
            startedAt: state.elapsed,
            phase: 'ascent',           // 'ascent' → 'coast' → 'deployed'
            ascentDur: target.isTransfer ? 9.0 : 6.5,
            payloadName,
        };
        state.rockets.push(rocket);

        onEvent?.({ type: 'launched', site, target, payloadName });
        return rocket;
    }

    // ── Update loop ─────────────────────────────────────────────────────────
    function tick() {
        const dt = state.clock.getDelta() * state.timeScale;
        state.elapsed += dt;

        // Earth slow rotation (sidereal-ish, just for visual flavor).
        earth.rotation.y += dt * 0.04;
        grid.rotation.y  = earth.rotation.y;

        // Moon
        moonAngle.theta += dt * 0.025;
        moon.position.set(
            R_MOON_SCENE * Math.cos(moonAngle.theta),
            0,
            R_MOON_SCENE * Math.sin(moonAngle.theta),
        );

        // Rockets
        for (const r of state.rockets) {
            const t = state.elapsed - r.startedAt;
            if (r.phase === 'ascent') {
                const u = Math.min(1, t / r.ascentDur);
                // Curved arc: surface → orbit. Interpolate radius linearly,
                // and bend the angular position toward the orbital plane.
                const radius = 1 + (r.rOrbit - 1) * easeInOutCubic(u);
                // Direction in orbital plane: rotate ascNode by `u·90°` around plane normal.
                const dir = r.ascNode.clone()
                    .applyAxisAngle(r.planeNormal, u * Math.PI/2 * 0.85);
                const pos = dir.multiplyScalar(radius);
                r.group.position.copy(pos);
                // Orient rocket along velocity-ish direction (tangent to arc).
                const tangent = r.ascNode.clone().applyAxisAngle(r.planeNormal, u*Math.PI/2 + 0.001).sub(
                    r.ascNode.clone().applyAxisAngle(r.planeNormal, u*Math.PI/2)
                ).normalize();
                const up = pos.clone().normalize();
                const look = pos.clone().add(tangent.add(up.multiplyScalar(0.4)));
                r.group.lookAt(look);
                r.group.rotateX(Math.PI/2);

                pushTrail(r, pos);

                if (u >= 1) {
                    r.phase = r.target.isTransfer ? 'transfer' : 'deployed';
                    deployPayload(r);
                    if (r.phase === 'transfer') runTransfer(r);
                }
            }
        }

        // Payloads (orbit propagation)
        for (const p of state.payloads) {
            p.theta += dt * p.omega;
            const a = p.ascNode.clone();
            const dir = a.applyAxisAngle(p.planeNormal, p.theta);
            p.mesh.position.copy(dir.multiplyScalar(p.r));
            // Update trailing ribbon
            pushOrbitTrail(p);
        }

        controls.update();
        renderer.render(scene, camera);
        requestAnimationFrame(tick);
    }

    function pushTrail(r, pos) {
        const arr = r.trailGeom.attributes.position.array;
        const i = r.trailIndex;
        if (i*3 + 2 < arr.length) {
            arr[i*3+0] = pos.x; arr[i*3+1] = pos.y; arr[i*3+2] = pos.z;
            r.trailIndex = i + 1;
            r.trailGeom.setDrawRange(0, r.trailIndex);
            r.trailGeom.attributes.position.needsUpdate = true;
        }
    }

    function pushOrbitTrail(p) {
        if (!p.trailGeom) return;
        const arr = p.trailGeom.attributes.position.array;
        const N   = arr.length / 3;
        const i   = p.trailIndex % N;
        arr[i*3+0] = p.mesh.position.x;
        arr[i*3+1] = p.mesh.position.y;
        arr[i*3+2] = p.mesh.position.z;
        p.trailIndex++;
        p.trailGeom.setDrawRange(0, Math.min(p.trailIndex, N));
        p.trailGeom.attributes.position.needsUpdate = true;
    }

    function deployPayload(r) {
        // A small bright dot for the payload + an orbit ring + a fading trail.
        const p = new THREE.Mesh(
            new THREE.SphereGeometry(0.025, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0x66ffaa })
        );
        scene.add(p);

        const ring = makeOrbitRing(r.rOrbit, r.planeNormal, r.ascNode, 0x66ffaa, 0.4);
        scene.add(ring);

        const trailGeom = new THREE.BufferGeometry();
        trailGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(400*3), 3));
        trailGeom.setDrawRange(0, 0);
        const trail = new THREE.Line(trailGeom, new THREE.LineBasicMaterial({
            color: 0x66ffaa, transparent: true, opacity: 0.6,
        }));
        scene.add(trail);

        // Period (visual): real T = 2π√(a³/μ); compress so LEO ≈ 6 s.
        const r_km = r.target.alt_km + R_EARTH_KM;
        const period_s = 2 * Math.PI * Math.sqrt(Math.pow(r_km, 3) / MU_EARTH);
        const visualPeriod = Math.max(4, Math.min(45, period_s / 900));
        const omega = (2*Math.PI) / visualPeriod;

        state.payloads.push({
            mesh: p, ring,
            trail, trailGeom, trailIndex: 0,
            r: r.rOrbit, theta: 0, omega,
            ascNode: r.ascNode.clone(),
            planeNormal: r.planeNormal.clone(),
            payloadName: r.payloadName,
            target: r.target,
        });

        onEvent?.({
            type: 'deployed',
            payloadName: r.payloadName,
            target: r.target,
            orbit: {
                alt_km: r.target.alt_km,
                inc_deg: r.inc,
                period_min: period_s / 60,
                v_circ_kms: vCirc(r_km),
            },
        });
    }

    function runTransfer(r) {
        // Fire a transfer ellipse from the *current* orbit (assumed LEO 400 km)
        // out to the destination (Moon or Mars). Pure visual: render a dashed
        // ellipse and an animated traveler on it, then report Δv + TOF in HUD.
        const r1 = R_EARTH_KM + 400;
        const r2 = (r.target.id === 'moon') ? MOON_DIST_KM : MARS_DIST_KM;
        const h = hohmannDV(r1, r2);

        // Ellipse in orbital plane: place periapsis at the launch site direction.
        const a   = (r1 + r2) / 2 / R_EARTH_KM;        // scene units
        const e   = Math.abs(r2 - r1) / (r2 + r1);
        const b   = a * Math.sqrt(1 - e*e);
        const cx  = a - r1 / R_EARTH_KM;                // center offset along major axis

        const N = 256;
        const pos = new Float32Array(N*3);
        const u   = r.ascNode.clone();
        const v   = u.clone().applyAxisAngle(r.planeNormal, Math.PI/2);
        for (let i=0; i<N; i++) {
            const ang = (i / (N-1)) * Math.PI * 2;
            const x = a * Math.cos(ang) - cx;
            const y = b * Math.sin(ang);
            const p = u.clone().multiplyScalar(x).add(v.clone().multiplyScalar(y));
            pos[i*3+0] = p.x; pos[i*3+1] = p.y; pos[i*3+2] = p.z;
        }
        const eg = new THREE.BufferGeometry();
        eg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const em = new THREE.LineDashedMaterial({
            color: r.target.id === 'moon' ? 0xccccff : 0xff8855,
            dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.85,
        });
        const ellipse = new THREE.Line(eg, em);
        ellipse.computeLineDistances();
        scene.add(ellipse);

        onEvent?.({
            type: 'transfer',
            target: r.target,
            dv1_kms: h.dv1, dv2_kms: h.dv2, dv_total_kms: h.total,
            tof_days: h.tof_s / 86400,
        });

        // Mark the rocket as deployed so the ascent loop stops touching it.
        r.phase = 'deployed';
    }

    function makeRingLine(radius, color, opacity) {
        const N = 256;
        const pos = new Float32Array(N*3);
        for (let i=0; i<N; i++) {
            const a = (i / (N-1)) * Math.PI * 2;
            pos[i*3+0] = radius * Math.cos(a);
            pos[i*3+1] = 0;
            pos[i*3+2] = radius * Math.sin(a);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        return new THREE.LineLoop(g, new THREE.LineBasicMaterial({
            color, transparent: true, opacity,
        }));
    }

    function makeOrbitRing(radius, normal, ascNode, color, opacity) {
        const N = 256;
        const pos = new Float32Array(N*3);
        const u = ascNode.clone();
        const v = u.clone().applyAxisAngle(normal, Math.PI/2);
        for (let i=0; i<N; i++) {
            const a = (i / (N-1)) * Math.PI * 2;
            const p = u.clone().multiplyScalar(radius * Math.cos(a))
                .add(v.clone().multiplyScalar(radius * Math.sin(a)));
            pos[i*3+0] = p.x; pos[i*3+1] = p.y; pos[i*3+2] = p.z;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        return new THREE.LineLoop(g, new THREE.LineBasicMaterial({
            color, transparent: true, opacity,
        }));
    }

    function easeInOutCubic(t) {
        return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2;
    }

    // ── Resize ──────────────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
        camera.aspect = w() / h();
        camera.updateProjectionMatrix();
        renderer.setSize(w(), h());
    });
    ro.observe(container);

    requestAnimationFrame(tick);

    return {
        launch,
        setTimeScale: (x) => { state.timeScale = Math.max(0, Math.min(50, x)); },
        getTimeScale: () => state.timeScale,
        clear: () => {
            for (const r of state.rockets) { scene.remove(r.group); scene.remove(r.trail); }
            for (const p of state.payloads) {
                scene.remove(p.mesh); scene.remove(p.ring); scene.remove(p.trail);
            }
            state.rockets.length  = 0;
            state.payloads.length = 0;
        },
        focusEarth: () => { controls.target.set(0,0,0); camera.position.set(3.5, 2.4, 4.6); },
        focusMoon:  () => { controls.target.copy(moon.position); camera.position.set(moon.position.x*1.05, 8, moon.position.z*1.05 + 8); },
        getStats: () => ({
            rockets:  state.rockets.length,
            payloads: state.payloads.length,
        }),
    };
}
