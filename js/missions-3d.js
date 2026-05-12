/**
 * missions-3d.js — Real-time 3D solar-system visualization of NASA + partner
 * missions. Each spacecraft is placed at its current location relative to its
 * host body (Sun/Earth L1, planet orbit, surface, heliocentric cruise, etc.)
 * using live planetary ephemerides.
 *
 * Coordinate system (Three.js scene units):
 *   1 unit = 1 AU. Heliocentric ecliptic frame, +Y = ecliptic normal.
 *   We map (x_AU, y_AU, z_AU) → (x_AU, z_AU, -y_AU) so the ecliptic lies
 *   in the XZ plane and the camera "top-down" looks down +Y.
 *
 * Position categories (per mission, see MISSION_LOCS below):
 *   l1                Sun-Earth L1 (~0.01 AU sunward of Earth)
 *   earth_orbit       Small ring around Earth (LEO/GEO, jittered phase)
 *   planet_orbit      Small ring around target planet
 *   planet_surface    Pinned point on the surface of the target planet
 *   helio_kepler      Independent heliocentric orbit (PSP, Solar Orbiter, …)
 *   cruise            Linear interp between two bodies, parametrized by date
 *   completed_at      Marker pinned at host body (mission ended there)
 *   lost              Hidden (deep-space relics, no useful position)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    jdNow, jdFromDate,
    mercuryHeliocentric, venusHeliocentric, earthHeliocentric,
    marsHeliocentric, jupiterHeliocentric, saturnHeliocentric,
    uranusHeliocentric, neptuneHeliocentric,
    moonGeocentric,
} from './horizons.js';

// ── Constants ────────────────────────────────────────────────────────────────
const KM_PER_AU = 149597870.7;
const L1_AU     = 1.5e6 / KM_PER_AU;     // Sun–Earth L1 displacement (~0.01 AU)

const PLANET_VIS = {
    sun:     { color: 0xffaa33, radius: 0.045, emissive: true  },
    mercury: { color: 0xaa9988, radius: 0.012 },
    venus:   { color: 0xe7c987, radius: 0.018 },
    earth:   { color: 0x4f8fe0, radius: 0.018 },
    mars:    { color: 0xc0552d, radius: 0.014 },
    jupiter: { color: 0xc6a382, radius: 0.034 },
    saturn:  { color: 0xdcc89a, radius: 0.030 },
    uranus:  { color: 0x9bdcdc, radius: 0.024 },
    neptune: { color: 0x4566c4, radius: 0.024 },
};

const STATUS_COLOR = {
    operational: 0x4fc97f,
    extended:    0x4fc3f7,
    cruising:    0xffb830,
    completed:   0xaaaaaa,
    retired:     0x666666,
    planned:     0xcc7799,
};

// ── Per-mission location config ──────────────────────────────────────────────
// Approximate Kepler elements for heliocentric spacecraft come from published
// mission profiles (mean a, e; perihelion epoch chosen near a recent close
// approach). Sub-degree precision is not the goal — the visual just needs to
// place each mission near its real region of the solar system.

function jdFromISO(s) { return jdFromDate(new Date(s + 'T00:00:00Z')); }

const MISSION_LOCS = {
    // ── Heliophysics — Sun-Earth L1 sentinels ───────────────────────────────
    'soho':    { type: 'l1' },
    'ace':     { type: 'l1' },
    'wind':    { type: 'l1' },
    'dscovr':  { type: 'l1' },
    'imap':    { type: 'l1' },

    // ── Earth-orbit observatories ───────────────────────────────────────────
    'sdo':     { type: 'earth_orbit', radius_au: 0.00024, period_d: 1.0,  inc_deg: 28 },
    'punch':   { type: 'earth_orbit', radius_au: 0.00006, period_d: 0.07, inc_deg: 97 },
    'hinode':  { type: 'earth_orbit', radius_au: 0.000048, period_d: 0.07, inc_deg: 97 },
    'iris':    { type: 'earth_orbit', radius_au: 0.000048, period_d: 0.07, inc_deg: 97 },

    // ── Independent heliocentric orbiters ───────────────────────────────────
    // Parker Solar Probe — final orbit (a≈0.388 AU, e≈0.853, P≈88 d).
    // Perihelion #22 occurred 2024-12-24; subsequent perihelia repeat every 88 d.
    'parker-solar-probe': {
        type:'helio_kepler', a:0.388, e:0.853, period_d:88,
        peri_jd: jdFromISO('2024-12-24'), lon_peri_deg: 80, inc_deg: 3.4,
    },
    // Solar Orbiter — a≈0.605 AU, e≈0.45, P≈168 d, perihelion ~0.29 AU.
    'solar-orbiter': {
        type:'helio_kepler', a:0.605, e:0.45, period_d:168,
        peri_jd: jdFromISO('2025-03-30'), lon_peri_deg: 175, inc_deg: 8.0,
    },
    // STEREO-A — a≈0.957 AU, e≈0.0066, ahead of Earth by ~52° in 2025.
    'stereo-a': {
        type:'helio_kepler', a:0.957, e:0.0066, period_d:346,
        peri_jd: jdFromISO('2025-01-01'), lon_peri_deg: 0, inc_deg: 0.13,
        lead_earth_deg: 52,
    },
    // OSIRIS-APEX — heliocentric en route to Apophis (April 2029).
    'osiris-apex': {
        type:'helio_kepler', a:1.04, e:0.20, period_d:388,
        peri_jd: jdFromISO('2024-09-01'), lon_peri_deg: 200, inc_deg: 3.0,
    },
    // Hayabusa2 extended — heliocentric to 1998 KY26 (~2031).
    'hayabusa2-extended': {
        type:'helio_kepler', a:1.05, e:0.20, period_d:393,
        peri_jd: jdFromISO('2024-04-01'), lon_peri_deg: 300, inc_deg: 5.0,
    },

    // ── Inner-planet missions ───────────────────────────────────────────────
    'bepicolombo': {
        type:'cruise', from:'earth', to:'mercury',
        launch_jd: jdFromISO('2018-10-20'), arrive_jd: jdFromISO('2026-11-01'),
    },
    'messenger': { type:'completed_at', host:'mercury' },
    'akatsuki':  { type:'planet_orbit', host:'venus', radius_mult: 2.2, period_d: 0.45 },

    // ── Asteroid missions ───────────────────────────────────────────────────
    'dart':   { type:'lost' },
    'hera':   {
        type:'cruise', from:'earth', to:'mars',
        launch_jd: jdFromISO('2024-10-07'), arrive_jd: jdFromISO('2026-12-01'),
    },
    'psyche': {
        type:'cruise', from:'earth', to:'mars',
        launch_jd: jdFromISO('2023-10-13'), arrive_jd: jdFromISO('2029-08-01'),
    },

    // ── Mars fleet ──────────────────────────────────────────────────────────
    'mars-reconnaissance-orbiter': { type:'planet_orbit', host:'mars', radius_mult: 1.8, period_d: 0.08 },
    'maven':                       { type:'planet_orbit', host:'mars', radius_mult: 2.4, period_d: 0.18 },
    'mars-express':                { type:'planet_orbit', host:'mars', radius_mult: 2.0, period_d: 0.30 },
    'tianwen-1':                   { type:'planet_orbit', host:'mars', radius_mult: 2.2, period_d: 0.20 },
    'hope-emm':                    { type:'planet_orbit', host:'mars', radius_mult: 3.6, period_d: 1.6  },
    'curiosity':                   { type:'planet_surface', host:'mars', lon_deg:  137, lat_deg: -5  },
    'perseverance':                { type:'planet_surface', host:'mars', lon_deg:   78, lat_deg: 18  },

    // ── Legacy / retired ────────────────────────────────────────────────────
    'helios-a':   { type:'lost' },
    'ulysses':    { type:'lost' },
    'mariner-10': { type:'lost' },
    'ibex':       { type:'earth_orbit', radius_au: 0.0009, period_d: 9.1, inc_deg: 33 },
};

// ── Position computation ─────────────────────────────────────────────────────

/** Stable [0,1) hash for a string id — used to phase-jitter co-located markers. */
function hashId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return ((h % 1000) + 1000) % 1000 / 1000;
}

/** Solve Kepler's equation E − e·sin(E) = M (Newton, ~6 iters is plenty). */
function solveKepler(M, e) {
    let E = M + e * Math.sin(M);
    for (let i = 0; i < 8; i++) {
        const f  = E - e * Math.sin(E) - M;
        const fp = 1 - e * Math.cos(E);
        E -= f / fp;
    }
    return E;
}

/** Compute heliocentric XYZ (AU) for a Kepler orbit definition. */
function keplerPos(loc, jd) {
    const M = ((jd - loc.peri_jd) / loc.period_d) * 2 * Math.PI;
    const E = solveKepler(M, loc.e);
    const cosE = Math.cos(E), sinE = Math.sin(E);
    const xPF = loc.a * (cosE - loc.e);
    const yPF = loc.a * Math.sqrt(1 - loc.e * loc.e) * sinE;

    const peri = (loc.lon_peri_deg || 0) * Math.PI / 180;
    const inc  = (loc.inc_deg     || 0) * Math.PI / 180;
    const cosO = Math.cos(peri), sinO = Math.sin(peri);
    const cosI = Math.cos(inc),  sinI = Math.sin(inc);

    const xR = xPF * cosO - yPF * sinO;
    const yR = xPF * sinO + yPF * cosO;
    return { x_AU: xR, y_AU: yR * cosI, z_AU: yR * sinI };
}

/** STEREO-A: locked at a fixed angular lead ahead of Earth's heliocentric lon. */
function leadEarthPos(loc, earthVec) {
    const earthLon = Math.atan2(earthVec.y_AU, earthVec.x_AU);
    const r        = loc.a;
    const lon      = earthLon + (loc.lead_earth_deg || 0) * Math.PI / 180;
    return { x_AU: r * Math.cos(lon), y_AU: r * Math.sin(lon), z_AU: 0 };
}

/** Sun–Earth L1: Earth's position scaled toward the Sun by L1 displacement. */
function l1Pos(earthVec) {
    const r = Math.hypot(earthVec.x_AU, earthVec.y_AU, earthVec.z_AU);
    const k = (r - L1_AU) / r;
    return { x_AU: earthVec.x_AU * k, y_AU: earthVec.y_AU * k, z_AU: earthVec.z_AU * k };
}

/** Phased small ring around a body. */
function ringPos(centerVec, loc, jd, missionId, baseRadiusAU) {
    const r0 = loc.radius_au ?? (baseRadiusAU * (loc.radius_mult || 2.0));
    const P  = loc.period_d  || 1.0;
    const inc = (loc.inc_deg || 0) * Math.PI / 180;
    const phi = ((jd / P) + hashId(missionId)) * 2 * Math.PI;
    const x   = r0 * Math.cos(phi);
    const y   = r0 * Math.sin(phi) * Math.cos(inc);
    const z   = r0 * Math.sin(phi) * Math.sin(inc);
    return {
        x_AU: centerVec.x_AU + x,
        y_AU: centerVec.y_AU + y,
        z_AU: centerVec.z_AU + z,
    };
}

/** Pinned surface point — uses simplified longitude/latitude on the body. */
function surfacePos(centerVec, loc, baseRadiusAU) {
    const r   = baseRadiusAU * 1.02;
    const lon = (loc.lon_deg || 0) * Math.PI / 180;
    const lat = (loc.lat_deg || 0) * Math.PI / 180;
    return {
        x_AU: centerVec.x_AU + r * Math.cos(lat) * Math.cos(lon),
        y_AU: centerVec.y_AU + r * Math.cos(lat) * Math.sin(lon),
        z_AU: centerVec.z_AU + r * Math.sin(lat),
    };
}

function lerpPos(a, b, f) {
    return {
        x_AU: a.x_AU * (1 - f) + b.x_AU * f,
        y_AU: a.y_AU * (1 - f) + b.y_AU * f,
        z_AU: a.z_AU * (1 - f) + b.z_AU * f,
    };
}

function cruisePos(loc, jd, planets) {
    const f = Math.max(0, Math.min(1, (jd - loc.launch_jd) / (loc.arrive_jd - loc.launch_jd)));
    const lin = lerpPos(planets[loc.from], planets[loc.to], f);
    // Add a gentle arc — pull the interp slightly outward from the Sun.
    const r = Math.hypot(lin.x_AU, lin.y_AU, lin.z_AU);
    const bow = 0.06 * Math.sin(f * Math.PI);
    const k   = r > 0 ? (r + bow) / r : 1;
    return { x_AU: lin.x_AU * k, y_AU: lin.y_AU * k, z_AU: lin.z_AU * k };
}

function computeMissionPos(mission, loc, jd, planets) {
    switch (loc.type) {
        case 'l1':            return l1Pos(planets.earth);
        case 'earth_orbit':   return ringPos(planets.earth, loc, jd, mission.id, PLANET_VIS.earth.radius);
        case 'planet_orbit':  return ringPos(planets[loc.host], loc, jd, mission.id, PLANET_VIS[loc.host].radius);
        case 'planet_surface':return surfacePos(planets[loc.host], loc, PLANET_VIS[loc.host].radius);
        case 'helio_kepler':  return loc.lead_earth_deg != null
                                ? leadEarthPos(loc, planets.earth)
                                : keplerPos(loc, jd);
        case 'cruise':        return cruisePos(loc, jd, planets);
        case 'completed_at':  return ringPos(planets[loc.host], { radius_mult: 1.6, period_d: 9999 },
                                             0, mission.id, PLANET_VIS[loc.host].radius);
        default:              return null;
    }
}

// ── Planet ephemeris snapshot at a given JD ──────────────────────────────────
function snapshotPlanets(jd) {
    return {
        mercury: mercuryHeliocentric(jd),
        venus:   venusHeliocentric(jd),
        earth:   earthHeliocentric(jd),
        mars:    marsHeliocentric(jd),
        jupiter: jupiterHeliocentric(jd),
        saturn:  saturnHeliocentric(jd),
        uranus:  uranusHeliocentric(jd),
        neptune: neptuneHeliocentric(jd),
    };
}

// ── Three.js scene helpers ───────────────────────────────────────────────────

function makeMarkerSprite(colorHex, size = 0.05) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const cx = 32, cy = 32;
    const r  = parseInt(colorHex.toString(16).padStart(6, '0').slice(0, 2), 16);
    const g  = parseInt(colorHex.toString(16).padStart(6, '0').slice(2, 4), 16);
    const b  = parseInt(colorHex.toString(16).padStart(6, '0').slice(4, 6), 16);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 32);
    grad.addColorStop(0,    `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.25, `rgba(${r},${g},${b},0.9)`);
    grad.addColorStop(0.55, `rgba(${r},${g},${b},0.35)`);
    grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sp  = new THREE.Sprite(mat);
    sp.scale.set(size, size, size);
    return sp;
}

function makeStarfield(count = 3500, rMin = 80, rMax = 200) {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const r  = rMin + Math.random() * (rMax - rMin);
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        pos[i*3]   = r * Math.sin(ph) * Math.cos(th);
        pos[i*3+1] = r * Math.sin(ph) * Math.sin(th);
        pos[i*3+2] = r * Math.cos(ph);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({
        color: 0xffffff, size: 0.45, sizeAttenuation: false,
    }));
}

function makeOrbitRing(radiusAU, color = 0x445566, segments = 256) {
    const pts = [];
    for (let i = 0; i <= segments; i++) {
        const t = (i / segments) * Math.PI * 2;
        pts.push(new THREE.Vector3(radiusAU * Math.cos(t), 0, radiusAU * Math.sin(t)));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0.35,
    }));
}

// Convert heliocentric ecliptic (x,y,z AU; z = ecliptic normal) to Three.js
// world coordinates with Y up.
function helioToScene(p) { return new THREE.Vector3(p.x_AU, p.z_AU, -p.y_AU); }

// ── Public API ───────────────────────────────────────────────────────────────

export function initMissionsViewer({ container, missions, onSelect }) {
    if (!container) throw new Error('initMissionsViewer: container required');

    // ── Renderer ────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x040210, 1);
    container.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, {
        display: 'block', width: '100%', height: '100%',
    });

    // ── Scene + camera ──────────────────────────────────────────────────────
    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.001, 4000);
    camera.position.set(0, 3.0, 3.5);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping  = true;
    controls.dampingFactor  = 0.08;
    controls.minDistance    = 0.05;
    controls.maxDistance    = 60;
    controls.target.set(0, 0, 0);
    controls.zoomSpeed      = 1.2;
    controls.panSpeed       = 0.8;
    controls.rotateSpeed    = 0.7;
    controls.screenSpacePanning = true;

    // ── Lighting ────────────────────────────────────────────────────────────
    const sunLight = new THREE.PointLight(0xffeecc, 3.5, 0, 1.5);
    sunLight.position.set(0, 0, 0);
    scene.add(sunLight);
    scene.add(new THREE.AmbientLight(0x404060, 0.55));

    // ── Background stars ────────────────────────────────────────────────────
    scene.add(makeStarfield());

    // ── Sun ─────────────────────────────────────────────────────────────────
    const sun = new THREE.Mesh(
        new THREE.SphereGeometry(PLANET_VIS.sun.radius, 48, 32),
        new THREE.MeshBasicMaterial({ color: PLANET_VIS.sun.color }),
    );
    scene.add(sun);
    const sunGlow = new THREE.Mesh(
        new THREE.SphereGeometry(PLANET_VIS.sun.radius * 2.6, 32, 24),
        new THREE.MeshBasicMaterial({
            color: 0xffaa44, transparent: true, opacity: 0.18,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }),
    );
    scene.add(sunGlow);

    // ── Planets + orbit rings ───────────────────────────────────────────────
    const planetMeshes = {};
    const planetLabels = {};
    const planetOrbitRings = {};
    const ringTargets = {
        mercury: 0.387, venus: 0.723, earth: 1.000, mars: 1.524,
        jupiter: 5.20,  saturn: 9.55, uranus: 19.22, neptune: 30.11,
    };
    for (const [name, vis] of Object.entries(PLANET_VIS)) {
        if (name === 'sun') continue;
        const mesh = new THREE.Mesh(
            new THREE.SphereGeometry(vis.radius, 32, 24),
            new THREE.MeshStandardMaterial({
                color: vis.color, roughness: 0.85, metalness: 0.05,
                emissive: 0x000000,
            }),
        );
        mesh.userData = { kind: 'planet', name };
        scene.add(mesh);
        planetMeshes[name] = mesh;

        const ring = makeOrbitRing(ringTargets[name], 0x335577);
        scene.add(ring);
        planetOrbitRings[name] = ring;

        const label = makePlanetLabel(name);
        scene.add(label);
        planetLabels[name] = label;
    }

    // ── Mission markers ─────────────────────────────────────────────────────
    const missionGroup = new THREE.Group();
    scene.add(missionGroup);

    const missionItems = [];           // { mission, loc, sprite, halo }
    const missionById  = new Map();
    for (const mission of missions) {
        const loc = MISSION_LOCS[mission.id];
        if (!loc || loc.type === 'lost') continue;
        const color  = STATUS_COLOR[mission.status] || 0x888888;
        const sprite = makeMarkerSprite(color, 0.045);
        sprite.userData = { kind: 'mission', missionId: mission.id };
        missionGroup.add(sprite);

        const halo = makeMarkerSprite(color, 0.10);
        halo.material.opacity = 0.0;     // shown only on hover/select
        halo.userData = { kind: 'mission-halo', missionId: mission.id };
        missionGroup.add(halo);

        const item = { mission, loc, sprite, halo };
        missionItems.push(item);
        missionById.set(mission.id, item);
    }

    // ── HUD overlay (selected mission + camera buttons) ─────────────────────
    const hud = buildHUD(container);
    hud.btnTop.onclick    = () => flyTo(new THREE.Vector3(0, 6, 0.001), new THREE.Vector3(0, 0, 0));
    hud.btnEdge.onclick   = () => flyTo(new THREE.Vector3(6, 0.4, 0),   new THREE.Vector3(0, 0, 0));
    hud.btnReset.onclick  = () => { selected = null; flyTo(new THREE.Vector3(0, 3.0, 3.5), new THREE.Vector3(0, 0, 0)); updateHUD(); };
    hud.btnFollow.onclick = () => { followSelected = !followSelected; hud.btnFollow.classList.toggle('mn3-on', followSelected); };

    // ── Raycaster (mission picking) ─────────────────────────────────────────
    const raycaster = new THREE.Raycaster();
    raycaster.params.Sprite = { threshold: 0.005 };
    const pointer = new THREE.Vector2();

    let hovered  = null;
    let selected = null;
    let followSelected = false;

    function pickAt(clientX, clientY) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((clientX - rect.left) / rect.width)  *  2 - 1;
        pointer.y = ((clientY - rect.top)  / rect.height) * -2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(missionGroup.children, false);
        for (const h of hits) {
            const id = h.object.userData?.missionId;
            if (id && missionById.has(id) && h.object.userData.kind === 'mission') {
                return missionById.get(id);
            }
        }
        return null;
    }

    renderer.domElement.addEventListener('pointermove', ev => {
        const item = pickAt(ev.clientX, ev.clientY);
        if (item !== hovered) {
            if (hovered && hovered !== selected) hovered.halo.material.opacity = 0;
            hovered = item;
            if (hovered) hovered.halo.material.opacity = 0.35;
            renderer.domElement.style.cursor = hovered ? 'pointer' : 'grab';
        }
    });

    renderer.domElement.addEventListener('pointerdown', ev => {
        if (ev.button !== 0) return;
        const item = pickAt(ev.clientX, ev.clientY);
        if (item) {
            selected = item;
            updateHUD();
            const worldPos = item.sprite.position.clone();
            // Position camera close enough to read context but not on top of marker.
            const offset = camera.position.clone().sub(controls.target).normalize().multiplyScalar(0.6);
            flyTo(worldPos.clone().add(offset), worldPos);
            if (typeof onSelect === 'function') onSelect(item.mission.id);
        }
    });

    // ── Camera fly-to ───────────────────────────────────────────────────────
    let flyState = null;
    function flyTo(camTo, targetTo, duration = 700) {
        flyState = {
            camFrom:    camera.position.clone(),
            camTo:      camTo.clone(),
            tgtFrom:    controls.target.clone(),
            tgtTo:      targetTo.clone(),
            t0:         performance.now(),
            duration,
        };
    }

    // ── Resize ──────────────────────────────────────────────────────────────
    function resize() {
        const w = container.clientWidth || 800;
        const h = container.clientHeight || 520;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // ── Tick ────────────────────────────────────────────────────────────────
    let frameNo  = 0;
    let lastJD   = jdNow();
    function tick() {
        requestAnimationFrame(tick);
        frameNo++;

        const jd = jdNow();
        lastJD   = jd;
        const planets = snapshotPlanets(jd);

        // Position planets
        for (const [name, mesh] of Object.entries(planetMeshes)) {
            mesh.position.copy(helioToScene(planets[name]));
            const lbl = planetLabels[name];
            if (lbl) lbl.position.copy(mesh.position).add(new THREE.Vector3(0, PLANET_VIS[name].radius * 1.6, 0));
        }

        // Position missions
        for (const item of missionItems) {
            const p = computeMissionPos(item.mission, item.loc, jd, planets);
            if (!p) continue;
            const v = helioToScene(p);
            item.sprite.position.copy(v);
            item.halo.position.copy(v);
        }

        // Camera fly-to interpolation
        if (flyState) {
            const t = Math.min(1, (performance.now() - flyState.t0) / flyState.duration);
            const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;     // ease-in-out
            camera.position.lerpVectors(flyState.camFrom, flyState.camTo, e);
            controls.target.lerpVectors(flyState.tgtFrom, flyState.tgtTo, e);
            if (t >= 1) flyState = null;
        }

        // Follow selected mission (recenters camera target on it).
        if (followSelected && selected) {
            controls.target.lerp(selected.sprite.position, 0.15);
        }

        // Pulse selected halo
        if (selected) {
            const pulse = 0.55 + 0.25 * Math.sin(performance.now() / 300);
            selected.halo.material.opacity = pulse;
        }

        // Slow sun rotation (visual only)
        sun.rotation.y += 0.0015;

        controls.update();
        renderer.render(scene, camera);

        if (frameNo % 120 === 0) updateClock(jd);
    }
    tick();

    // ── HUD updates ─────────────────────────────────────────────────────────
    function updateClock(jd) {
        const d = new Date((jd - 2440587.5) * 86400000);
        hud.clock.textContent = `${d.toUTCString().slice(5, 22)} UTC`;
    }
    updateClock(lastJD);

    function updateHUD() {
        if (!selected) {
            hud.detail.classList.remove('mn3-detail--shown');
            hud.detailName.textContent    = '';
            hud.detailMeta.textContent    = '';
            hud.detailSummary.textContent = '';
            for (const item of missionItems) {
                if (item !== hovered) item.halo.material.opacity = item === selected ? 0.7 : 0;
            }
            return;
        }
        const m = selected.mission;
        hud.detail.classList.add('mn3-detail--shown');
        hud.detailName.textContent = m.name;
        const where = locationLabel(selected.loc);
        const meta  = [m.agency, m.status?.toUpperCase(), where].filter(Boolean).join(' · ');
        hud.detailMeta.textContent    = meta;
        hud.detailSummary.textContent = m.summary || m.note || '';
    }

    function locationLabel(loc) {
        switch (loc.type) {
            case 'l1':             return 'Sun–Earth L1';
            case 'earth_orbit':    return 'Earth orbit';
            case 'planet_orbit':   return `${cap(loc.host)} orbit`;
            case 'planet_surface': return `${cap(loc.host)} surface`;
            case 'helio_kepler':   return 'Heliocentric orbit';
            case 'cruise':         return `Cruise: ${cap(loc.from)} → ${cap(loc.to)}`;
            case 'completed_at':   return `${cap(loc.host)} (mission ended)`;
            default:               return '';
        }
    }

    // ── External API ────────────────────────────────────────────────────────
    return {
        focusMission(id) {
            const item = missionById.get(id);
            if (!item) return;
            selected = item;
            updateHUD();
            const worldPos = item.sprite.position.clone();
            const offset = camera.position.clone().sub(controls.target).normalize().multiplyScalar(0.5);
            flyTo(worldPos.clone().add(offset), worldPos);
        },
        clearSelection() { selected = null; updateHUD(); },
        dispose() {
            ro.disconnect();
            renderer.dispose();
            container.innerHTML = '';
        },
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function makePlanetLabel(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 28px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(220,220,255,0.85)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cap(name), 128, 32);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
    const sp  = new THREE.Sprite(mat);
    sp.scale.set(0.18, 0.045, 1);
    return sp;
}

function buildHUD(container) {
    // Inject CSS once
    if (!document.getElementById('mn3-css')) {
        const css = document.createElement('style');
        css.id = 'mn3-css';
        css.textContent = `
        .mn3-host { position:relative; }
        .mn3-controls {
            position:absolute; top:10px; right:10px;
            display:flex; gap:6px; z-index:5;
            flex-wrap:wrap; justify-content:flex-end;
        }
        .mn3-btn {
            font: 600 .68rem 'Segoe UI', system-ui, sans-serif;
            padding:5px 10px; cursor:pointer;
            background:rgba(10,6,28,.78); color:#bcd;
            border:1px solid rgba(255,255,255,.15); border-radius:999px;
            backdrop-filter:blur(8px);
            letter-spacing:.04em; text-transform:uppercase;
            transition:all .15s;
        }
        .mn3-btn:hover { color:#fff; border-color:rgba(255,184,48,.4); }
        .mn3-btn.mn3-on { background:rgba(255,184,48,.18); border-color:#fb0; color:#fc7; }
        .mn3-clock {
            position:absolute; top:10px; left:10px; z-index:5;
            font: 600 .7rem monospace;
            padding:5px 10px; color:#9ab;
            background:rgba(10,6,28,.78);
            border:1px solid rgba(0,200,200,.18); border-radius:6px;
            backdrop-filter:blur(8px);
        }
        .mn3-clock::before { content:'● LIVE  '; color:#4fc97f; }
        .mn3-legend {
            position:absolute; bottom:10px; left:10px; z-index:5;
            display:flex; gap:10px; flex-wrap:wrap;
            font: 600 .62rem 'Segoe UI', system-ui, sans-serif;
            background:rgba(10,6,28,.78); padding:6px 10px;
            border:1px solid rgba(255,255,255,.08); border-radius:6px;
            backdrop-filter:blur(8px);
            color:#bcd;
        }
        .mn3-legend-item { display:flex; align-items:center; gap:4px; text-transform:uppercase; letter-spacing:.05em; }
        .mn3-legend-dot { width:8px; height:8px; border-radius:50%; box-shadow:0 0 6px currentColor; }
        .mn3-detail {
            position:absolute; bottom:10px; right:10px; z-index:5;
            max-width:340px; padding:10px 12px;
            background:rgba(10,6,28,.85);
            border:1px solid rgba(255,184,48,.35);
            border-left:3px solid #fb0;
            border-radius:8px;
            backdrop-filter:blur(10px);
            color:#ccd;
            opacity:0; transform:translateY(8px); pointer-events:none;
            transition:opacity .2s, transform .2s;
        }
        .mn3-detail--shown { opacity:1; transform:translateY(0); pointer-events:auto; }
        .mn3-detail-name { font-size:.95rem; font-weight:800; color:#eef; margin-bottom:3px; }
        .mn3-detail-meta { font-size:.66rem; color:#998; font-family:monospace; margin-bottom:6px; letter-spacing:.04em; }
        .mn3-detail-summary { font-size:.78rem; line-height:1.5; color:#ccd; }
        @media (max-width:720px) {
            .mn3-detail { max-width:none; left:10px; }
            .mn3-legend { display:none; }
        }
        `;
        document.head.appendChild(css);
    }

    container.classList.add('mn3-host');

    const clock = document.createElement('div');
    clock.className = 'mn3-clock';
    clock.textContent = '— UTC';
    container.appendChild(clock);

    const controls = document.createElement('div');
    controls.className = 'mn3-controls';
    const mkBtn = (label) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'mn3-btn'; b.textContent = label;
        controls.appendChild(b); return b;
    };
    const btnTop    = mkBtn('Top-down');
    const btnEdge   = mkBtn('Edge view');
    const btnFollow = mkBtn('Follow');
    const btnReset  = mkBtn('Reset');
    container.appendChild(controls);

    const legend = document.createElement('div');
    legend.className = 'mn3-legend';
    legend.innerHTML = Object.entries({
        Operational: '#4fc97f', Extended: '#4fc3f7', Cruising: '#ffb830',
        Completed:   '#aaaaaa', Retired:  '#666666',
    }).map(([k, c]) =>
        `<span class="mn3-legend-item"><span class="mn3-legend-dot" style="background:${c};color:${c}"></span>${k}</span>`
    ).join('');
    container.appendChild(legend);

    const detail = document.createElement('div');
    detail.className = 'mn3-detail';
    const detailName    = document.createElement('div'); detailName.className    = 'mn3-detail-name';
    const detailMeta    = document.createElement('div'); detailMeta.className    = 'mn3-detail-meta';
    const detailSummary = document.createElement('div'); detailSummary.className = 'mn3-detail-summary';
    detail.appendChild(detailName); detail.appendChild(detailMeta); detail.appendChild(detailSummary);
    container.appendChild(detail);

    return {
        clock, btnTop, btnEdge, btnFollow, btnReset,
        detail, detailName, detailMeta, detailSummary,
    };
}

export default initMissionsViewer;
