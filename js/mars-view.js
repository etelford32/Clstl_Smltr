import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    MARS_RADIUS_M,
    PERSEVERANCE_MEDA_SNAPSHOT,
    PERSEVERANCE_MISSION,
    estimatedMissionSol,
    formatMarsClock,
    localMeanSolarTimeHours,
    marsSubsolarPoint,
    observationFreshness,
} from './mars-mission-state.js?v=20260809-live';
import { MarsLandmarks } from './mars-landmarks.js?v=20260809-live';
import { MARS_LANDMARK_CATEGORIES } from './mars-landmarks-data.js';
import { fetchMarsSkyEphemeris } from './horizons.js';
import { MarsSky } from './mars-sky.js';
import {
    MARS_TILESET, collapse as collapseWfc, marsClassPriors, expandClassPriorsFlow,
    slopeField, flowAccumulation, marsChannelRouting,
    regionSeed, regionGrid as wfcRegionGrid, sampleClassInto, classShares,
} from './terrain-wfc.js';

const SURFACE_RADIUS = 1;
const RELIEF_EXAGGERATION = 5;
const MOLA_MIN_M = -8068;
const MOLA_MAX_M = 21134;
const MARS_RADIUS_KM = MARS_RADIUS_M / 1000;
const REGIONAL_TERRAIN_EXTENT_KM = 520;
// Target ground spacing for the analysis graticule. The actual step is derived
// per rebuild from the current quality level's segment count so the spacing
// stays put when the render budget changes.
const REGIONAL_GRID_TARGET_KM = 16;
const SURFACE_STEP_KM = 12;
const SURFACE_PATCH_OFFSET = 0.00012;

// The regional patch carries its own vertical exaggeration. 5× reads well on a
// whole globe but is invisible across a 520 km patch: Jezero's regional relief
// spans ~2 km over 520 km, so at 5× the terrain rises 0.003 of its own width —
// a flat wash, which is exactly what the surface explorer used to render.
// 18× makes the same MOLA data legible. The MOLA readout in the surface HUD
// still reports TRUE elevation, and the exaggeration is printed on-screen.
const REGIONAL_RELIEF_EXAGGERATION = 18;

// Geology synth (WFC) grid over the regional patch. 48 cells across 520 km is
// ~10.8 km per cell — deliberately AT the bundled MOLA raster's real sample
// spacing (4 px/°, ~15 km at Jezero), so the synthesized class map never
// pretends to more resolution than the data that seeds it. The synth layer is
// decoration in the same sense as the decorative roughness it modulates: it is
// labelled "synthesized" in the surface HUD, and the MOLA readouts stay true.
// Cell count does NOT ride the quality ladder — the ladder trades fidelity,
// and a 48² collapse costs ~15 ms, which is noise inside a 66k-vertex rebuild.
const REGIONAL_SYNTH_CELLS = 48;
// How far the class tint pulls the vertex color away from the neutral
// hypsometric ramp. 1 would replace the Viking albedo outright; 0.55 keeps the
// photometric base readable underneath the geology.
const SYNTH_TINT_STRENGTH = 0.55;

/**
 * ═══ TRUE-SCALE-ON-FINAL ══════════════════════════════════════════════════
 * 18× exaggeration is right for a 55 km survey and WRONG for judging a
 * landing: a pilot reads SHAPE, and every slope on final looked 18× steeper
 * than reality. Below ~50 km of orbit range the patch's vertical scale ramps
 * down, reaching TRUE 1× by 14 km — sightseeing keeps its drama, short final
 * gets honest slopes, and the pilot cluster + HUD disclose the live
 * multiplier the whole way down.
 *
 * The ramp is driven by ORBIT RANGE (camera→target), NOT by altitude above
 * terrain: changing the scale moves the drawn ground, so an AGL-driven
 * controller would feed back through the very surface it displaces and
 * oscillate. Range is exaggeration-independent. The scale is quantized to
 * steps and the patch rebuilds only on a step change (a rebuild costs
 * ~40 ms — continuous rescale would jank the whole zoom).
 *
 * Decorative roughness compresses with the ramp (see rebuildRegionalTerrain):
 * at true scale the patch shows MOLA and nothing else.
 */
const RELIEF_RAMP_TRUE_RANGE_KM = 14;
const RELIEF_RAMP_FULL_RANGE_KM = 50;
const RELIEF_SCALE_STEPS = Object.freeze([1, 2, 3, 5, 8, 12, REGIONAL_RELIEF_EXAGGERATION]);
let regionalReliefScale = REGIONAL_RELIEF_EXAGGERATION;

function reliefScaleForRange(rangeKm) {
    const blend = THREE.MathUtils.smoothstep(rangeKm, RELIEF_RAMP_TRUE_RANGE_KM, RELIEF_RAMP_FULL_RANGE_KM);
    const target = 1 + (REGIONAL_RELIEF_EXAGGERATION - 1) * blend;
    let best = RELIEF_SCALE_STEPS[0];
    for (const step of RELIEF_SCALE_STEPS) {
        if (Math.abs(step - target) < Math.abs(best - target)) best = step;
    }
    return best;
}

// Surface-explorer camera framing. Eye altitude and look-ahead are chosen so the
// horizon lands in the upper third of a 36° frame: at 9 km the horizon is 247 km
// out and 4.2° below local horizontal, while the camera is pitched 9.3° down.
const SURFACE_EYE_ALTITUDE_KM = 9;
const SURFACE_LOOK_AHEAD_KM = 55;
const SURFACE_MIN_EYE_KM = 2.4;
const SURFACE_MAX_EYE_KM = 260;
// Closest the eye may orbit its ground target. This has to sit comfortably
// ABOVE SURFACE_MIN_EYE_KM: the polar limit below is derived from the ratio of
// the two, and at parity it collapses to "you may only look straight down".
const SURFACE_MIN_ORBIT_KM = 4.5;

// Depth range per mode. The old code paired near = 0.00002 with far = 100 —
// a 5,000,000:1 ratio that leaves a 24-bit depth buffer with almost no usable
// precision, which is why coincident surface layers flickered. Keeping the
// star field camera-locked (below) lets `far` stay small in both modes.
const GLOBAL_NEAR = 0.02;
const GLOBAL_FAR = 12;
const SURFACE_NEAR = 0.0002;   // ≈ 0.7 km, below the enforced eye floor
const SURFACE_FAR = 0.9;

// Fog in surface mode is real atmospheric depth, not decoration: Mars' dusty
// CO₂ column visibly softens terrain past ~150 km. FogExp2 density is in scene
// units where 1 unit = 3396 km, so this resolves to ~10% haze at 100 km and
// ~55% at 250 km. The page shipped with 3.2, which over these distances
// resolved to no visible fog at all — the horizon had nothing to fade into.
// Pushing it much higher washes the near field out to a flat sky-coloured
// sheet, which is the opposite failure.
const SURFACE_FOG_DENSITY = 11;
const TEXTURE_URL = '/assets/mars/mars-viking-jpl.jpg';
const MOLA_URL = '/assets/mars/mola-topography.png';
const mission = PERSEVERANCE_MISSION;

const canvas = document.querySelector('#mars-canvas');
const app = document.querySelector('.mars-app');
const viewport = document.querySelector('#mars-viewport');
const loadingScreen = document.querySelector('#loading-screen');
const loaderStatus = document.querySelector('#loader-status');

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x080302, 0.025);

const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
const globalCameraPosition = new THREE.Vector3(0.15, 0.42, 3.65);
camera.position.copy(globalCameraPosition);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
// Quality ladder. The page renders a PBR globe, an additive limb shell, and a
// 66k-vertex regional patch — on a software rasteriser or an integrated GPU at
// 4K that lands well under 10 fps, and an unusable framerate reads as a broken
// canvas. `applyQuality` walks this ladder from measured frame times instead of
// guessing from device class, so a fast machine keeps full resolution and a
// slow one stays interactive.
// `terrainSegments` matters as much as `pixelRatio` here: the regional patch is
// a 256×256 grid, i.e. 131k triangles submitted every frame, which dominates on
// a software rasteriser long before fill rate does. Halving it to 128 is a 4×
// cut in geometry for a patch whose underlying MOLA raster only carries ~37
// real samples per side — the visible relief is unchanged.
// The ladder trades FIDELITY, never instruments. Resolution, star count, the
// decorative limb glow, and the globe's bump term all scale; the analysis
// graticule, the terrain itself, and every readout stay at all four levels. A
// visitor on a slow machine should get a coarser Mars, not a smaller feature set.
// `surfaceDetail` scales the close-range regolith shader on the regional
// patch (0 skips the noise entirely) — it is fidelity, not an instrument,
// so the ladder may trade it away on a software rasteriser.
const QUALITY_LEVELS = Object.freeze([
    Object.freeze({ name: 'high',    pixelRatio: 1,    atmosphere: true,  starCount: 1700, terrainSegments: 256, globeBump: true,  surfaceDetail: 1 }),
    Object.freeze({ name: 'medium',  pixelRatio: 0.8,  atmosphere: true,  starCount: 1700, terrainSegments: 192, globeBump: true,  surfaceDetail: 1 }),
    Object.freeze({ name: 'low',     pixelRatio: 0.62, atmosphere: false, starCount: 900,  terrainSegments: 128, globeBump: false, surfaceDetail: 0.6 }),
    Object.freeze({ name: 'minimal', pixelRatio: 0.5,  atmosphere: false, starCount: 500,  terrainSegments: 96,  globeBump: false, surfaceDetail: 0 }),
]);
const maxPixelRatio = Math.min(window.devicePixelRatio || 1, window.matchMedia('(max-width: 560px)').matches ? 1.5 : 2);
let qualityIndex = 0;
renderer.setPixelRatio(maxPixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    window.__marsReady = false;
    window.__marsRevealFallback?.('The browser lost the WebGL context. Mission and provenance panels remain usable.');
}, { once: true });

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Camera state. Declared BEFORE the controls are built because
// applyControlMode() reads surfaceModeActive during construction.
let cameraMode = 'global';
let cameraModeLabel = 'Mission orbit';
let cameraTween = null;
let cardFocusAction = null;
let surfaceModeActive = false;
let surfaceLocation = null;
let regionalTerrainCenter = null;
let lastSurfaceFocus = null;
// Local vertical the controls' orbit axis was last built for. Travelling far
// enough across the terrain rotates the true local vertical away from it, at
// which point the frame has to be rebuilt (see refreshControlFrame).
let controlFrameUp = new THREE.Vector3(0, 1, 0);
const CONTROL_FRAME_DRIFT_DEG = 1.5;

/**
 * ═══ WHY `controls` IS A `let` AND GETS REBUILT ═══════════════════════════
 *
 * OrbitControls captures its orbit axis ONCE, at construction:
 *
 *     js/vendor/three-0.160.0/jsm/controls/OrbitControls.js:176
 *     const quat = new Quaternion().setFromUnitVectors(object.up, ...)
 *
 * That line sits in the closure around `this.update`, so it runs when the
 * instance is built and never again. **Assigning `camera.up` afterwards does
 * nothing to how the camera orbits.**
 *
 * The surface explorer sets `camera.up` to the local radial and then reasons
 * entirely in a local-horizon frame — polar limits, ground clearance, "don't
 * look below the horizon". None of that was reaching OrbitControls, which kept
 * orbiting about world +Y (Mars' spin axis). At Jezero, 18.4°N, the two frames
 * are ~72° apart, so every polar limit was applied to the wrong axis: dragging
 * "up" hit an invisible wall, dragging down swung the camera under the terrain,
 * and the placement code and the controls disagreed about where the camera even
 * was. It looked like several unrelated bugs; it is this one.
 *
 * The library exposes no way to re-seat that quaternion, so the frame is
 * refreshed by rebuilding the instance — cheap, and only when the local
 * vertical has actually moved (mode change, or enough travel across the
 * terrain to matter). Everything reads `controls` through this binding, and
 * `__marsLab` exposes it via a getter so external references never go stale.
 */
let controls = createControls();

function configureControls(next) {
    next.enableDamping = true;
    next.dampingFactor = 0.06;
    next.enablePan = false;
    next.rotateSpeed = 0.55;
    next.zoomSpeed = 0.75;
    next.autoRotateSpeed = 0.34;
    next.touches.ONE = THREE.TOUCH.ROTATE;
    next.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
    next.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    next.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
    applyControlMode(next);
    return next;
}

/** Mode-specific limits, re-applied after every rebuild. */
function applyControlMode(next = controls) {
    if (surfaceModeActive) {
        next.minDistance = SURFACE_MIN_ORBIT_KM / MARS_RADIUS_KM;
        next.maxDistance = SURFACE_MAX_EYE_KM / MARS_RADIUS_KM;
        next.zoomToCursor = false;
        // Right-drag becomes ground translation (panSurfaceByPixels), so
        // OrbitControls must stop claiming it as a duplicate rotate.
        next.mouseButtons.RIGHT = null;
    } else {
        next.minDistance = 1.22;
        next.maxDistance = 7;
        next.zoomToCursor = true;
        next.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
        next.maxPolarAngle = Math.PI;
    }
    next.minPolarAngle = 0;
}

function createControls() {
    const next = new OrbitControls(camera, canvas);
    configureControls(next);
    next.addEventListener('start', onControlsStart);
    next.addEventListener('end', onControlsEnd);
    return next;
}

/**
 * Rebuild the controls so their orbit axis picks up the current `camera.up`.
 * Preserves the target, the orbit geometry, and auto-rotate state.
 */
function refreshControlFrame() {
    const target = controls.target.clone();
    const autoRotating = controls.autoRotate;
    controls.dispose();
    controls = createControls();
    controls.target.copy(target);
    controls.autoRotate = autoRotating;
    controlFrameUp.copy(camera.up).normalize();
    if (surfaceModeActive) updateSurfacePolarLimit();
    controls.update();
}

/**
 * Rebuild the frame only once the local vertical has drifted enough to matter.
 * 1.5° is ~89 km of travel on Mars — far enough that the horizon would visibly
 * tilt, close enough that the rebuild is imperceptible.
 */
function refreshControlFrameIfDrifted() {
    if (camera.up.angleTo(controlFrameUp) < THREE.MathUtils.degToRad(CONTROL_FRAME_DRIFT_DEG)) return;
    refreshControlFrame();
}

scene.add(new THREE.HemisphereLight(0xffd1b1, 0x080304, 0.58));
const sun = new THREE.DirectionalLight(0xffead5, 3.2);
scene.add(sun);
const rim = new THREE.DirectionalLight(0xff6837, 0.38);
rim.position.set(4, -1.5, -3);
scene.add(rim);
// Night-side floor. Focusing a target that happens to be past the terminator
// used to fill the canvas with pure black and look like a rendering failure.
// This keeps the unlit hemisphere dim but legible without washing out the
// terminator, which is still the layer that says where day actually ends.
const nightFloor = new THREE.AmbientLight(0x40211a, 0.5);
scene.add(nightFloor);

const marsGroup = new THREE.Group();
marsGroup.rotation.y = THREE.MathUtils.degToRad(-77.25);
scene.add(marsGroup);

function latLonVector(latDeg, lonDeg, radius = SURFACE_RADIUS) {
    const lat = THREE.MathUtils.degToRad(latDeg);
    const lon = THREE.MathUtils.degToRad(lonDeg);
    const cosLat = Math.cos(lat);
    return new THREE.Vector3(
        cosLat * Math.cos(lon),
        Math.sin(lat),
        -cosLat * Math.sin(lon),
    ).multiplyScalar(radius);
}

function tangentFrame(radial) {
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(radial, -radial.y);
    if (north.lengthSq() < 1e-6) north.set(1, 0, 0);
    north.normalize();
    const east = new THREE.Vector3().crossVectors(north, radial).normalize();
    return { north, east };
}

const missionFacingRadial = latLonVector(
    mission.latest_drive.position.lat_deg,
    mission.latest_drive.position.lon_deg,
).applyQuaternion(marsGroup.quaternion).normalize();
const missionFacingFrame = tangentFrame(missionFacingRadial);
globalCameraPosition.copy(missionFacingRadial.clone().multiplyScalar(3.55)
    .addScaledVector(missionFacingFrame.north, 0.34)
    .addScaledVector(missionFacingFrame.east, 0.16));
camera.position.copy(globalCameraPosition);

/**
 * Star field, built on a UNIT sphere and scaled per mode.
 *
 * Stars used to sit 15–40 scene units from the origin, which forced `far` to
 * 100 in every mode; paired with a surface-mode `near` of 0.00002 that gave a
 * depth ratio no 24-bit buffer can resolve. They are at infinity physically, so
 * riding with the camera is the correct model AND is what lets both modes keep
 * a tight depth range.
 *
 * Depth testing stays ON. It is tempting to disable it so nothing can clip the
 * sky — but three.js draws transparent objects after opaque ones, so a
 * depth-test-free star field paints straight through the planet and the terrain
 * you are standing on. The radius is scaled per mode instead, so the stars are
 * always behind the scene without ever leaving the frustum:
 *   global   9 units — beyond the globe from any allowed camera distance (≤7),
 *                      inside GLOBAL_FAR (12)
 *   surface  0.5     — beyond the 520 km patch (≤0.25 away), inside SURFACE_FAR
 */
const GLOBAL_STAR_SCALE = 9;
const SURFACE_STAR_SCALE = 0.5;

function buildStars(count = 1700) {
    const positions = new Float32Array(count * 3);
    const random = mulberry32(20260805);
    for (let i = 0; i < count; i += 1) {
        const z = random() * 2 - 1;
        const theta = random() * Math.PI * 2;
        const r = 0.86 + random() * 0.14;
        const xy = Math.sqrt(1 - z * z);
        positions[i * 3] = Math.cos(theta) * xy * r;
        positions[i * 3 + 1] = z * r;
        positions[i * 3 + 2] = Math.sin(theta) * xy * r;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({
        color: 0xffe5d6,
        size: 1.6,
        transparent: true,
        opacity: 0.7,
        // Constant pixel size: with the sphere rescaled per mode, size
        // attenuation would make the same star a speck in one view and a blob
        // in the other.
        sizeAttenuation: false,
        depthWrite: false,
    }));
    points.name = 'mars-star-field';
    points.renderOrder = -2;
    points.frustumCulled = false;
    points.scale.setScalar(surfaceModeActive ? SURFACE_STAR_SCALE : GLOBAL_STAR_SCALE);
    return points;
}

function mulberry32(seed) {
    return () => {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

let starField = buildStars();
scene.add(starField);

const textureLoader = new THREE.TextureLoader();
const loadTexture = async (url, { color = false } = {}) => {
    try {
        const texture = await textureLoader.loadAsync(url);
        if (color) texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        return texture;
    } catch (error) {
        console.warn(`[Mars] Could not load ${url}`, error);
        return null;
    }
};

const [surfaceTexture, molaTexture] = await Promise.all([
    loadTexture(TEXTURE_URL, { color: true }),
    loadTexture(MOLA_URL),
]);

for (const texture of [surfaceTexture, molaTexture]) {
    if (!texture) continue;
    texture.wrapS = THREE.RepeatWrapping;
    texture.needsUpdate = true;
}

function createRasterSampler(texture) {
    const image = texture?.image;
    if (!image?.width || !image?.height) return null;
    const sampler = document.createElement('canvas');
    sampler.width = image.width;
    sampler.height = image.height;
    const context = sampler.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, sampler.width, sampler.height).data;
    return {
        width: sampler.width,
        height: sampler.height,
        sample(u, v) {
            const wrappedU = ((u % 1) + 1) % 1;
            const clampedV = THREE.MathUtils.clamp(v, 0, 1);
            const x = wrappedU * (sampler.width - 1);
            const y = (1 - clampedV) * (sampler.height - 1);
            const x0 = Math.floor(x);
            const y0 = Math.floor(y);
            const x1 = (x0 + 1) % sampler.width;
            const y1 = Math.min(y0 + 1, sampler.height - 1);
            const tx = x - x0;
            const ty = y - y0;
            const channel = (px, py) => pixels[(py * sampler.width + px) * 4];
            const top = THREE.MathUtils.lerp(channel(x0, y0), channel(x1, y0), tx);
            const bottom = THREE.MathUtils.lerp(channel(x0, y1), channel(x1, y1), tx);
            return THREE.MathUtils.lerp(top, bottom, ty);
        },
    };
}

let molaSampler = null;
try {
    molaSampler = createRasterSampler(molaTexture);
} catch (error) {
    console.warn('[Mars] MOLA pixels could not be sampled; regional terrain will use smooth geometry', error);
}

function latLonUv(latDeg, lonDeg) {
    return {
        u: THREE.MathUtils.euclideanModulo(lonDeg + 180, 360) / 360,
        v: THREE.MathUtils.clamp((latDeg + 90) / 180, 0, 1),
    };
}

function elevationAtLatLon(latDeg, lonDeg) {
    if (!molaSampler) return 0;
    const { u, v } = latLonUv(latDeg, lonDeg);
    const gray = molaSampler.sample(u, v);
    return MOLA_MIN_M + gray / 255 * (MOLA_MAX_M - MOLA_MIN_M);
}

// HOT PATH. This is called once per regional-terrain vertex (66,049 of them per
// rebuild) plus once per route point, marker, and grid node. It used to run
// `document.querySelector('#relief-toggle')` on every one of those calls. The
// enabled flag is now cached and refreshed by setLayer('relief', …) — if you
// add another way to toggle relief, update `reliefEnabled` there too.
let reliefEnabled = true;

function reliefRadiusAtLatLon(latDeg, lonDeg, offset = 0, exaggeration = RELIEF_EXAGGERATION) {
    const scale = hasRelief && reliefEnabled ? exaggeration : 0;
    return SURFACE_RADIUS + elevationAtLatLon(latDeg, lonDeg) / MARS_RADIUS_M * scale + offset;
}

/** Radius of the regional patch, which carries its own vertical exaggeration —
 *  the LIVE ramped value, not the constant (see TRUE-SCALE-ON-FINAL above). */
function regionalRadiusAtLatLon(latDeg, lonDeg, offset = 0) {
    return reliefRadiusAtLatLon(latDeg, lonDeg, offset, regionalReliefScale);
}

/**
 * Surface radius for anything anchored to the ground — markers, the traverse,
 * the graticule, the exploration trail. In surface mode that means the regional
 * patch (the globe meshes are hidden there); on the globe it means the 5× relief
 * sphere. Getting this wrong is what left the rover marker and the NASA route
 * floating ~150 km above the terrain they describe.
 */
function anchorRadiusAtLatLon(latDeg, lonDeg, offset = 0) {
    return surfaceModeActive
        ? regionalRadiusAtLatLon(latDeg, lonDeg, offset)
        : reliefRadiusAtLatLon(latDeg, lonDeg, offset);
}

loaderStatus.textContent = 'Displacing 32,768 surface vertices with MOLA elevation…';
await new Promise(resolve => requestAnimationFrame(resolve));

const smoothGeometry = new THREE.SphereGeometry(SURFACE_RADIUS, 256, 128);
const reliefGeometry = smoothGeometry.clone();

function displaceWithMola(geometry, texture) {
    if (!texture || !molaSampler) return false;
    const positions = geometry.attributes.position;
    const uvs = geometry.attributes.uv;
    const direction = new THREE.Vector3();
    for (let index = 0; index < positions.count; index += 1) {
        const u = THREE.MathUtils.clamp(uvs.getX(index), 0, 0.999999);
        const v = THREE.MathUtils.clamp(uvs.getY(index), 0, 0.999999);
        const gray = molaSampler.sample(u, v);
        const elevationM = MOLA_MIN_M + gray / 255 * (MOLA_MAX_M - MOLA_MIN_M);
        const radius = SURFACE_RADIUS + elevationM / MARS_RADIUS_M * RELIEF_EXAGGERATION;
        direction.fromBufferAttribute(positions, index).normalize().multiplyScalar(radius);
        positions.setXYZ(index, direction.x, direction.y, direction.z);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return true;
}

let hasRelief = false;
try {
    hasRelief = displaceWithMola(reliefGeometry, molaTexture);
} catch (error) {
    console.warn('[Mars] MOLA texture could not be sampled; using the smooth sphere', error);
}
const surfaceMaterial = new THREE.MeshStandardMaterial({
    color: surfaceTexture ? 0xffffff : 0xa83f20,
    map: surfaceTexture,
    bumpMap: molaTexture,
    bumpScale: molaTexture ? 0.0024 : 0,
    roughness: 0.92,
    metalness: 0,
});
const smoothMars = new THREE.Mesh(smoothGeometry, surfaceMaterial);
const reliefMars = new THREE.Mesh(reliefGeometry, surfaceMaterial);
smoothMars.visible = !hasRelief;
reliefMars.visible = hasRelief;
marsGroup.add(smoothMars, reliefMars);

// NO emissive/emissiveMap here, deliberately. The patch used to be lit at
// emissiveIntensity 1.25 from the Viking colour map, which meant every vertex
// glowed at its own albedo regardless of sun angle — so slopes, ridges, and
// crater walls all shaded identically and 66k vertices of MOLA relief rendered
// as one flat orange field. Sunlit shading is the whole point of the layer.
// No bumpMap either. The patch spans ~37 MOLA texels, so a derivative-based
// bump term had nothing to perturb — it was contributing an expensive
// dFdx/dFdy pair per fragment for a detail smaller than one texel. The relief
// this layer shows comes from displaced geometry, which is real.
const regionalTerrainMaterial = new THREE.MeshStandardMaterial({
    color: surfaceTexture ? 0xffffff : 0x9d3d22,
    map: surfaceTexture,
    roughness: 0.96,
    metalness: 0,
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
});
/**
 * ═══ CLOSE-RANGE DETAIL CASCADE ════════════════════════════════════════════
 * Below ~10 km the patch used to be a featureless wash: the Viking map is
 * ~15 km/px, the synth classes 11 km/cell, the decorative roughness 10–100 km
 * wavelengths — every visual channel a pilot uses on short final (ground
 * rush, texture-gradient height cues) was empty. This injects a procedural
 * regolith cascade into the patch material: three noise bands (~2.4 km,
 * ~450 m, ~90 m) that each FADE IN as the view distance drops, so survey
 * height keeps the photometric look and detail materializes on descent.
 *
 * The honesty rules:
 *   - albedo/shading ONLY — no geometry, so it cannot lie about shape at
 *     true scale, and the MOLA readouts never see it;
 *   - pattern frequency/amplitude ride the per-vertex synth class grain
 *     (dunes ripple, plains stay calm) — labelled synthesized in the HUD
 *     alongside the classes that drive it;
 *   - noise coordinates are the REFERENCE-SPHERE direction × radius —
 *     radius-independent, so the pattern is pixel-stable across relief-ramp
 *     steps, patch rebuilds, and recenters (world-position input would
 *     reseed the texture on every ramp step — the surface moves radially).
 * The mid band adds a sun-relative two-tap "lit relief" term (bright on the
 * sun side of each bump, dark on the lee) — cheap depth without touching
 * the normal pipeline. uDetailStrength comes from the quality ladder; 0
 * branches the whole cascade out for software rasterisers.
 */
const detailUniforms = {
    uDetailStrength: { value: QUALITY_LEVELS[0].surfaceDetail },
    uSunDirWorld: { value: new THREE.Vector3(1, 0, 0) },
    // World-space anchor (km) near the patch center. Noise coordinates are
    // ANCHOR-RELATIVE: raw sphere coordinates reach ±3400 km, and dividing by
    // a 90 m band wavelength pushes lattice values past fp precision — the
    // noise decorrelated into white speckle (measured with the raw-noise
    // debug view). Quantized to the same quarter-degree grid as the synth
    // cache, so ramp steps and quality rebuilds keep the anchor and only a
    // genuine recenter (which rebuilds all scenery anyway) moves it.
    uDetailAnchor: { value: new THREE.Vector3(0, 0, 0) },
    // Tangent frame at the anchor: the crater field scatters circles on a 2D
    // chart q = (sph·east, sph·north). Same quantization/stability story as
    // the anchor itself.
    uDetailEast: { value: new THREE.Vector3(1, 0, 0) },
    uDetailNorth: { value: new THREE.Vector3(0, 1, 0) },
};
regionalTerrainMaterial.customProgramCacheKey = () => 'mars-regolith-detail';
regionalTerrainMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, detailUniforms);
    shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `
            attribute float aDetailGrain;
            attribute float aDetailCrater;
            varying vec3 vDetailWorld;
            varying float vDetailGrain;
            varying float vDetailCrater;
            #include <common>`)
        .replace('#include <begin_vertex>', `
            #include <begin_vertex>
            vDetailWorld = (modelMatrix * vec4(position, 1.0)).xyz;
            vDetailGrain = aDetailGrain;
            vDetailCrater = aDetailCrater;`);
    shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `
            uniform float uDetailStrength;
            uniform vec3 uSunDirWorld;
            uniform vec3 uDetailAnchor;
            uniform vec3 uDetailEast;
            uniform vec3 uDetailNorth;
            varying vec3 vDetailWorld;
            varying float vDetailGrain;
            varying float vDetailCrater;
            float ppHash(vec3 p) {
                // Wrap the lattice into a 289-cell tile BEFORE hashing: the
                // raw coordinates reach tens of thousands of cells (sphere
                // radius x band frequency) and fract() of such magnitudes
                // sheds most of the fp32 mantissa — the hash degenerates
                // into screen-scale streaks. 289 cells repeats the pattern
                // every ~26 km at the finest band: invisible.
                p = mod(p, 289.0);
                p = fract(p * 0.1031);
                p += dot(p, p.zyx + 31.32);
                return fract((p.x + p.y) * p.z);
            }
            float ppNoise(vec3 p) {
                vec3 i = floor(p);
                vec3 f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                float n000 = ppHash(i);
                float n100 = ppHash(i + vec3(1.0, 0.0, 0.0));
                float n010 = ppHash(i + vec3(0.0, 1.0, 0.0));
                float n110 = ppHash(i + vec3(1.0, 1.0, 0.0));
                float n001 = ppHash(i + vec3(0.0, 0.0, 1.0));
                float n101 = ppHash(i + vec3(1.0, 0.0, 1.0));
                float n011 = ppHash(i + vec3(0.0, 1.0, 1.0));
                float n111 = ppHash(i + vec3(1.0, 1.0, 1.0));
                return mix(
                    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
                    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
                    f.z);
            }
            // Scattered impact craters on the 2D surface chart q (km): one
            // candidate per jittered grid cell of spacing L, existence gated
            // by the per-vertex class density. Analytic bowl + raised-rim
            // profile; shading is the SIGNED radial slope lit against the
            // sun's tangent direction (near inner wall dark, far wall lit,
            // outer flank reversed) plus a bright ejecta collar and a dark
            // floor — the standard lunar/martian look, driven by the actual
            // sun vector.
            float craterField(vec2 q, float L, float seedZ, float density, vec2 sunT2) {
                vec2 base = floor(q / L);
                float shade = 0.0;
                for (int dx = -1; dx <= 1; dx += 1) {
                    for (int dy = -1; dy <= 1; dy += 1) {
                        vec2 cell = base + vec2(float(dx), float(dy));
                        float h = ppHash(vec3(cell * 0.7311, seedZ));
                        if (h > density) continue;
                        vec2 center = (cell + 0.5 + 0.8 * (vec2(fract(h * 127.1), fract(h * 311.7)) - 0.5)) * L;
                        float r = L * mix(0.14, 0.34, fract(h * 43.7));
                        vec2 offset = q - center;
                        float d = length(offset);
                        if (d > r * 1.6) continue;
                        float x = d / r;
                        float slope;
                        float alb;
                        if (x < 0.85) {
                            slope = 1.9 * x;                                  // bowl wall rises outward
                            alb = -0.09 * (1.0 - x);                          // dark floor
                        } else if (x < 1.05) {
                            slope = mix(1.6, -1.6, (x - 0.85) / 0.2);         // over the rim crest
                            alb = 0.10;                                       // bright rim
                        } else {
                            slope = -1.5 * (1.6 - x) / 0.55;                  // outer flank decays
                            alb = 0.05 * (1.6 - x) / 0.55;                    // ejecta collar
                        }
                        vec2 rd = offset / max(d, 1e-5);
                        shade += -slope * dot(rd, sunT2) * 0.6 + alb;
                    }
                }
                return shade;
            }
            #include <common>`)
        .replace('#include <color_fragment>', `
            #include <color_fragment>
            if (uDetailStrength > 0.001) {
                vec3 radialDir = normalize(vDetailWorld);
                // km on the reference sphere, ANCHOR-RELATIVE (see uniform
                // note): small magnitudes keep the hash lattice coherent.
                vec3 sph = radialDir * 3396.19 - uDetailAnchor;
                float viewKm = length(vViewPosition) * 3396.19;
                float freq = mix(1.0, vDetailGrain, 0.7);
                float amp = (0.7 + 0.3 * vDetailGrain) * uDetailStrength;
                vec3 sunTangent = uSunDirWorld - radialDir * dot(uSunDirWorld, radialDir);
                sunTangent = normalize(sunTangent + vec3(1e-5));
                float shade = 0.0;
                float fade0 = 1.0 - smoothstep(60.0, 130.0, viewKm);
                if (fade0 > 0.0) {
                    shade += (ppNoise(sph * (freq / 2.4)) - 0.5) * 0.12 * fade0;
                }
                float fade1 = 1.0 - smoothstep(14.0, 32.0, viewKm);
                if (fade1 > 0.0) {
                    float bump = ppNoise(sph * (freq / 0.45)) * 0.67
                        + ppNoise(sph * (freq / 0.19)) * 0.33;
                    float bumpSunward = ppNoise((sph + sunTangent * 0.09) * (freq / 0.45)) * 0.67
                        + ppNoise((sph + sunTangent * 0.05) * (freq / 0.19)) * 0.33;
                    shade += (bump - 0.5) * 0.09 * fade1;
                    // Lit relief: a DIRECTIONAL derivative along the sun
                    // tangent. Kept subordinate to the isotropic terms — at
                    // 0.5 its anisotropy dominated the whole field and the
                    // regolith rendered as sun-axis streaks (measured).
                    shade += (bump - bumpSunward) * 0.2 * fade1;
                }
                float fade2 = 1.0 - smoothstep(2.5, 7.5, viewKm);
                if (fade2 > 0.0) {
                    shade += (ppNoise(sph * (freq / 0.09)) - 0.5) * 0.18 * fade2;
                }
                // Crater field on the tangent chart, three size decades. The
                // largest (rims 0.5–1.2 km) reads from survey height; the
                // smallest (~50–110 m) only on short final, and only above
                // the ladder's low rung.
                vec2 q = vec2(dot(sph, uDetailEast), dot(sph, uDetailNorth));
                vec2 sunT2 = vec2(dot(sunTangent, uDetailEast), dot(sunTangent, uDetailNorth));
                sunT2 = normalize(sunT2 + vec2(1e-5));
                float craterDensity = vDetailCrater * 0.75;
                float cfade0 = 1.0 - smoothstep(70.0, 150.0, viewKm);
                if (cfade0 > 0.0) {
                    shade += craterField(q, 3.4, 17.0, craterDensity, sunT2) * cfade0;
                }
                float cfade1 = 1.0 - smoothstep(18.0, 42.0, viewKm);
                if (cfade1 > 0.0) {
                    shade += craterField(q, 1.1, 29.0, craterDensity, sunT2) * cfade1;
                }
                float cfade2 = 1.0 - smoothstep(3.0, 10.0, viewKm);
                if (cfade2 > 0.0 && uDetailStrength > 0.8) {
                    shade += craterField(q, 0.32, 47.0, craterDensity * 0.9, sunT2) * cfade2;
                }
                diffuseColor.rgb *= clamp(1.0 + shade * amp, 0.45, 1.55);
            }`);
};

const regionalTerrain = new THREE.Mesh(new THREE.BufferGeometry(), regionalTerrainMaterial);
regionalTerrain.name = 'mola-regional-terrain';
regionalTerrain.visible = false;
regionalTerrain.renderOrder = 2;
marsGroup.add(regionalTerrain);

const regionalTerrainGrid = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xffbd8c, transparent: true, opacity: 0.16, depthWrite: false }),
);
regionalTerrainGrid.name = 'regional-terrain-analysis-grid';
regionalTerrainGrid.visible = false;
regionalTerrainGrid.renderOrder = 4;
marsGroup.add(regionalTerrainGrid);

const surfaceTrail = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x69e4ff, transparent: true, opacity: 0.9, depthWrite: false }),
);
surfaceTrail.name = 'surface-exploration-trail';
surfaceTrail.visible = false;
marsGroup.add(surfaceTrail);
let surfaceTrailLocations = [];

// ═══ LANDING RETICLE ════════════════════════════════════════════════════════
// The orbit target is the single most important point in surface mode — it is
// where every camera gesture pivots and where a landing would happen — and it
// used to be invisible. The reticle drapes a fixed 2 km ring over the terrain
// at the target (a SCALE ANCHOR: the ring is always 2 km, so terrain reads in
// physical units), plus a north tick and a center cross. Anchored through
// anchorRadiusAtLatLon like every other ground layer, re-seated by
// refreshSurfaceAnchors, and offset above the patch + trail so it never
// z-fights either.
const RETICLE_RADIUS_KM = 2;
const RETICLE_OFFSET = SURFACE_PATCH_OFFSET + 0.0003;
const RETICLE_SEGMENTS = 64;
const landingReticle = new THREE.Group();
landingReticle.name = 'landing-reticle';
const reticleMaterial = new THREE.LineBasicMaterial({
    color: 0x7dffb0, transparent: true, opacity: 0.8, depthWrite: false,
});
const reticleRing = new THREE.Line(new THREE.BufferGeometry(), reticleMaterial);
// North tick + center cross share one LineSegments (3 disjoint strokes).
const reticleMarks = new THREE.LineSegments(new THREE.BufferGeometry(), reticleMaterial);
landingReticle.add(reticleRing, reticleMarks);
landingReticle.renderOrder = 5;
reticleRing.renderOrder = 5;
reticleMarks.renderOrder = 5;
landingReticle.visible = false;
marsGroup.add(landingReticle);
let reticleAt = null;

function updateLandingReticle(force = false) {
    if (!surfaceModeActive || !surfaceLocation) {
        landingReticle.visible = false;
        reticleAt = null;
        return;
    }
    if (!force && reticleAt && greatCircleDistanceKm(reticleAt, surfaceLocation) < 0.15) return;
    reticleAt = { latDeg: surfaceLocation.latDeg, lonDeg: surfaceLocation.lonDeg };
    const groundPoint = (eastKm, northKm) => {
        const p = destinationLatLon(reticleAt.latDeg, reticleAt.lonDeg, eastKm, northKm);
        return latLonVector(p.latDeg, p.lonDeg, anchorRadiusAtLatLon(p.latDeg, p.lonDeg, RETICLE_OFFSET));
    };
    const ringPoints = [];
    for (let i = 0; i <= RETICLE_SEGMENTS; i += 1) {
        const bearing = (i / RETICLE_SEGMENTS) * Math.PI * 2;
        ringPoints.push(groundPoint(Math.sin(bearing) * RETICLE_RADIUS_KM, Math.cos(bearing) * RETICLE_RADIUS_KM));
    }
    reticleRing.geometry.dispose();
    reticleRing.geometry = new THREE.BufferGeometry().setFromPoints(ringPoints);
    reticleMarks.geometry.dispose();
    reticleMarks.geometry = new THREE.BufferGeometry().setFromPoints([
        groundPoint(0, RETICLE_RADIUS_KM), groundPoint(0, RETICLE_RADIUS_KM + 0.9),   // north tick
        groundPoint(-0.3, 0), groundPoint(0.3, 0),                                    // center cross
        groundPoint(0, -0.3), groundPoint(0, 0.3),
    ]);
    landingReticle.visible = true;
}

function destinationLatLon(latDeg, lonDeg, eastKm, northKm) {
    const distanceKm = Math.hypot(eastKm, northKm);
    if (distanceKm < 1e-9) return { latDeg, lonDeg };
    const angularDistance = distanceKm / MARS_RADIUS_KM;
    const bearing = Math.atan2(eastKm, northKm);
    const lat = THREE.MathUtils.degToRad(latDeg);
    const lon = THREE.MathUtils.degToRad(lonDeg);
    const destinationLat = Math.asin(
        Math.sin(lat) * Math.cos(angularDistance)
        + Math.cos(lat) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const destinationLon = lon + Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat),
        Math.cos(angularDistance) - Math.sin(lat) * Math.sin(destinationLat),
    );
    return {
        latDeg: THREE.MathUtils.radToDeg(destinationLat),
        lonDeg: THREE.MathUtils.radToDeg(destinationLon),
    };
}

/**
 * Illustrative micro-relief. MOLA's global grid is ~4 px/degree — about 15 km
 * per sample at Jezero — so a 520 km patch resolves roughly 35 real samples per
 * side. This adds sub-sample texture so the interpolated surface does not read
 * as bilinear mush. It is DECORATION, labelled as such in the surface HUD, and
 * its amplitude (≤ ~0.35 km) stays well under the real relief it sits on.
 */
function visualRegionalRoughnessKm(eastKm, northKm) {
    const edge = Math.max(Math.abs(eastKm), Math.abs(northKm)) / (REGIONAL_TERRAIN_EXTENT_KM * 0.5);
    const fade = 1 - THREE.MathUtils.smoothstep(edge, 0.72, 1);
    const broad = Math.sin(eastKm * 0.038 + 1.7) * Math.cos(northKm * 0.031 - 0.8) * 0.14;
    const medium = Math.sin(eastKm * 0.105 - northKm * 0.062) * 0.072;
    const fine = Math.sin(eastKm * 0.24 + northKm * 0.19 + 2.1) * 0.036;
    const grain = Math.sin(eastKm * 0.63 - northKm * 0.51 + 0.6) * 0.014;
    return (broad + medium + fine + grain) * fade;
}

/**
 * Wave-function-collapse geology synth for the regional patch.
 *
 * The kernel lives in js/terrain-wfc.js (node-gated by tests/terrain-wfc.mjs);
 * this function only feeds it MEASURED priors: real MOLA elevation and local
 * slope sampled at each synth cell's accurate great-circle coordinates. The
 * collapsed class map then (a) tints the patch's vertex colors so dune fields,
 * channel floors, and polar ice read as different ground, and (b) shapes the
 * decorative roughness amplitude so smooth plains actually render smooth while
 * chaos terrain keeps its full grain. Deterministic per site: the seed is
 * quantized from the patch center, so revisiting Jezero always grows the same
 * geology. No MOLA sampler ⇒ no synth — the layer refuses to invent classes
 * with nothing real to seed them.
 */
let synthEnabled = true;
let synthResult = null;
let synthShares = null;
let synthKey = '';
// Scratch for the per-vertex hot path — sampleClassInto allocates nothing.
const synthScratch = { color: [0, 0, 0], reliefAmpM: 0, grain: 0, tileIndex: 0 };
// The class tint is normalized so 'plains' ≈ no change: the Viking base map
// already looks like plains nearly everywhere, and an un-normalized tint would
// re-color the whole patch instead of marking the exceptions.
const SYNTH_NEUTRAL = MARS_TILESET.classes.find(cls => cls.id === 'plains').color;

// Crater areal saturation per geology class, indexed by TILE for the per-
// vertex attribute fill (family variants inherit their class's value).
const CRATER_DENSITY_BY_CLASS = {
    cratered: 1.0, lava: 0.6, plains: 0.5, ice: 0.35, chaos: 0.4, channel: 0.25, dunes: 0.12,
};
const CRATER_DENSITY_BY_TILE = MARS_TILESET.tiles.map(
    tile => CRATER_DENSITY_BY_CLASS[tile.classId] ?? 0.5,
);

function computeRegionalSynth(latDeg, lonDeg) {
    if (!molaSampler) return null;
    // Same quarter-degree quantization as regionSeed: rebuilds triggered by the
    // quality ladder (same center) hit the cache; a real traverse (patch
    // recenters after ~114 km) re-collapses.
    const key = `${Math.round(latDeg * 4)}:${Math.round(lonDeg * 4)}`;
    if (synthResult && synthKey === key) return synthResult;
    const cells = REGIONAL_SYNTH_CELLS;
    const region = wfcRegionGrid({
        centerLatDeg: latDeg, centerLonDeg: lonDeg,
        extentKm: REGIONAL_TERRAIN_EXTENT_KM, cells, radiusKm: MARS_RADIUS_KM,
    });
    const cellCount = cells * cells;
    const elevations = new Float32Array(cellCount);
    for (let i = 0; i < cellCount; i += 1) {
        elevations[i] = elevationAtLatLon(region.latDeg[i], region.lonDeg[i]);
    }
    const tileCount = MARS_TILESET.tiles.length;
    const priors = new Float32Array(cellCount * tileCount);
    const stepM = region.spacingKm * 1000;
    // FLOW-ROUTED priors: channels follow the measured MOLA water routing.
    // slopeField gives the gradient two ways on purpose (central-difference
    // AXIS so valley floors read along-valley, one-sided WALL slope so
    // channels still seed in floors), and flowAccumulation adds the piece
    // local slope cannot see — priority-flood pit filling, D8 routing, and
    // upstream-area accumulation, so tributaries converge into trunks that
    // run down real valleys. The recipe combining them is the kernel's
    // marsChannelRouting (ONE copy, pinned by tests/terrain-wfc.mjs — do not
    // re-derive it here).
    const flow = slopeField(elevations, cells, stepM);
    const drain = flowAccumulation(elevations, cells, stepM);
    const flowSpec = { channel: { axisEast: 0, axisNorth: 0, strength: 0 } };
    for (let i = 0; i < cellCount; i += 1) {
        const routing = marsChannelRouting(flow, drain, i, cells);
        flowSpec.channel.axisEast = routing.axisEast;
        flowSpec.channel.axisNorth = routing.axisNorth;
        flowSpec.channel.strength = routing.strength;
        expandClassPriorsFlow(
            MARS_TILESET,
            marsClassPriors({
                elevationM: elevations[i],
                slopeDeg: flow.wallSlopeDeg[i],
                latDeg: region.latDeg[i],
                drainage: routing.drainageNorm,
            }),
            priors,
            i,
            flowSpec,
        );
    }
    try {
        synthResult = collapseWfc({
            tileset: MARS_TILESET, width: cells, height: cells,
            seed: regionSeed('mars', latDeg, lonDeg), priors,
        });
        synthShares = classShares(synthResult);
        synthKey = key;
    } catch (error) {
        // Over-constrained priors are a kernel bug, not a page failure — the
        // patch simply renders without the synth layer.
        console.warn('[Mars] geology synth failed; rendering without it', error);
        synthResult = null;
        synthShares = null;
        synthKey = '';
    }
    return synthResult;
}

/**
 * Hypsometric tint from the REAL MOLA elevation.
 *
 * This replaces a tint driven by the decorative roughness above, which meant
 * the only colour variation on the patch encoded invented data. Now the shading
 * a viewer reads as "that ridge is higher" actually is higher.
 *
 * The ramp normalizes to the PATCH's own relief span rather than a fixed
 * altitude band. Mars ranges from Hellas at −8 km to Olympus at +21 km, so any
 * global constant is wrong nearly everywhere: it flattens Jezero's ~1 km of
 * local structure to nothing while clipping the Tharsis flanks to solid white.
 * Per-patch normalization means every region reads at the same contrast — and
 * matters more here than it would elsewhere, because the bundled MOLA raster is
 * 4 px/°, so a 520 km patch has only ~37 real samples per side to work with.
 *
 * `spanM` is floored so a genuinely flat patch (northern plains) does not have
 * its noise amplified into fake topography.
 */
function hypsometricShade(elevationM, midpointM, spanM) {
    const relative = THREE.MathUtils.clamp((elevationM - midpointM) / spanM, -1, 1);
    return 0.98 + relative * 0.30;
}

function rebuildRegionalTerrain(latDeg, lonDeg) {
    const segments = QUALITY_LEVELS[qualityIndex].terrainSegments;
    const rowLength = segments + 1;
    const vertexCount = rowLength * rowLength;
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const colors = new Float32Array(vertexCount * 3);
    const elevations = new Float32Array(vertexCount);
    const indices = new Uint32Array(segments * segments * 6);
    const synth = synthEnabled ? computeRegionalSynth(latDeg, lonDeg) : null;
    // Detail-cascade anchor: quarter-degree-quantized patch center, in the
    // same WORLD frame as vDetailWorld (marsGroup rotation applied). The
    // tangent frame rides along for the crater chart.
    const anchorLat = Math.round(latDeg * 4) / 4;
    const anchorLon = Math.round(lonDeg * 4) / 4;
    const anchorDir = latLonVector(anchorLat, anchorLon, 1);
    const anchorFrame = tangentFrame(anchorDir);
    detailUniforms.uDetailAnchor.value
        .copy(anchorDir).applyQuaternion(marsGroup.quaternion).multiplyScalar(3396.19);
    detailUniforms.uDetailEast.value
        .copy(anchorFrame.east).applyQuaternion(marsGroup.quaternion);
    detailUniforms.uDetailNorth.value
        .copy(anchorFrame.north).applyQuaternion(marsGroup.quaternion);
    // Class tints stashed in pass 1 (where the synth is sampled for roughness
    // anyway) and applied in pass 2 on top of the hypsometric shade.
    const synthTint = synth ? new Float32Array(vertexCount * 3) : null;
    // Per-vertex grain for the close-range detail cascade: the synth class's
    // noise-frequency knob (dunes 2.2, plains 0.6). 1 = neutral regolith when
    // the synth layer is off or has no data.
    const grains = new Float32Array(vertexCount).fill(1);
    // Per-vertex crater saturation for the cascade's crater field: ancient
    // cratered highlands keep ~4 Gyr of impacts, dune fields bury almost all
    // of theirs, channel floors were resurfaced. 0.5 = neutral.
    const craterDensities = new Float32Array(vertexCount).fill(0.5);

    // Pass 1: geometry + real elevation. No per-vertex object allocation — this
    // loop runs 66,049 times on every rebuild, and rebuilds happen while the
    // user is driving the camera.
    let vertexOffset = 0;
    let elevationSum = 0;
    let minElevationM = Infinity;
    let maxElevationM = -Infinity;
    for (let northIndex = 0; northIndex <= segments; northIndex += 1) {
        const northKm = (northIndex / segments - 0.5) * REGIONAL_TERRAIN_EXTENT_KM;
        for (let eastIndex = 0; eastIndex <= segments; eastIndex += 1) {
            const eastKm = (eastIndex / segments - 0.5) * REGIONAL_TERRAIN_EXTENT_KM;
            const location = destinationLatLon(latDeg, lonDeg, eastKm, northKm);
            const elevationM = elevationAtLatLon(location.latDeg, location.lonDeg);
            elevations[vertexOffset] = elevationM;
            elevationSum += elevationM;
            if (elevationM < minElevationM) minElevationM = elevationM;
            if (elevationM > maxElevationM) maxElevationM = elevationM;
            // Decoration compresses with the true-scale ramp: at 1× the patch
            // shows MOLA and nothing else — invented texture has no business
            // on a surface being read for landing slopes.
            let roughnessKm = visualRegionalRoughnessKm(eastKm, northKm)
                * (regionalReliefScale / REGIONAL_RELIEF_EXAGGERATION);
            if (synth) {
                // Synth grid row 0 is the NORTH edge; this loop's northIndex 0
                // is the SOUTH edge, hence the v flip.
                sampleClassInto(synth, eastIndex / segments, 1 - northIndex / segments, synthScratch);
                // Class-shaped micro-relief, still inside the existing ≤0.35 km
                // decoration budget: plains flatten it, chaos keeps full grain.
                roughnessKm *= Math.min(1, Math.max(0.15, synthScratch.reliefAmpM / 300));
                grains[vertexOffset] = synthScratch.grain;
                craterDensities[vertexOffset] = CRATER_DENSITY_BY_TILE[synthScratch.tileIndex];
                for (let channel = 0; channel < 3; channel += 1) {
                    const ratio = synthScratch.color[channel] / SYNTH_NEUTRAL[channel];
                    synthTint[vertexOffset * 3 + channel] = THREE.MathUtils.clamp(
                        1 + SYNTH_TINT_STRENGTH * (ratio - 1), 0.35, 1.9,
                    );
                }
            }
            const visualRoughness = roughnessKm / MARS_RADIUS_KM;
            const radius = regionalRadiusAtLatLon(
                location.latDeg,
                location.lonDeg,
                SURFACE_PATCH_OFFSET + visualRoughness,
            );
            const lat = THREE.MathUtils.degToRad(location.latDeg);
            const lon = THREE.MathUtils.degToRad(location.lonDeg);
            const cosLat = Math.cos(lat);
            positions[vertexOffset * 3] = cosLat * Math.cos(lon) * radius;
            positions[vertexOffset * 3 + 1] = Math.sin(lat) * radius;
            positions[vertexOffset * 3 + 2] = -cosLat * Math.sin(lon) * radius;
            const uv = latLonUv(location.latDeg, location.lonDeg);
            uvs[vertexOffset * 2] = uv.u;
            uvs[vertexOffset * 2 + 1] = uv.v;
            vertexOffset += 1;
        }
    }

    // Pass 2: hypsometric tint, which needs the patch's own span from pass 1.
    const meanElevationM = elevationSum / vertexCount;
    const midpointM = (minElevationM + maxElevationM) / 2;
    const spanM = Math.max(220, (maxElevationM - minElevationM) / 2);
    for (let index = 0; index < vertexCount; index += 1) {
        const shade = hypsometricShade(elevations[index], midpointM, spanM);
        if (synthTint) {
            colors[index * 3] = shade * synthTint[index * 3];
            colors[index * 3 + 1] = shade * 0.945 * synthTint[index * 3 + 1];
            colors[index * 3 + 2] = shade * 0.9 * synthTint[index * 3 + 2];
        } else {
            colors[index * 3] = shade;
            colors[index * 3 + 1] = shade * 0.945;
            colors[index * 3 + 2] = shade * 0.9;
        }
    }

    let indexOffset = 0;
    for (let row = 0; row < segments; row += 1) {
        for (let column = 0; column < segments; column += 1) {
            const a = row * rowLength + column;
            const b = a + 1;
            const c = a + rowLength;
            const d = c + 1;
            indices.set([a, b, c, b, d, c], indexOffset);
            indexOffset += 6;
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aDetailGrain', new THREE.BufferAttribute(grains, 1));
    geometry.setAttribute('aDetailCrater', new THREE.BufferAttribute(craterDensities, 1));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    regionalTerrain.geometry.dispose();
    regionalTerrain.geometry = geometry;

    // Analysis graticule, drawn straight from the terrain vertices so it drapes
    // over the relief instead of hovering above it. Written into a sized typed
    // array — the previous push-based build allocated ~66k Vector3 objects per
    // rebuild, which is most of a GC pause every time the camera moved.
    //
    // The step is derived from the segment count so the grid keeps the SAME
    // ground spacing across quality levels. A fixed step would silently change
    // what the scale bar means whenever the render budget changed.
    const gridStep = Math.max(1, Math.round(
        REGIONAL_GRID_TARGET_KM * segments / REGIONAL_TERRAIN_EXTENT_KM,
    ));
    regionalGridSpacingKm = Math.round(REGIONAL_TERRAIN_EXTENT_KM / segments * gridStep);
    const rowLines = Math.floor(segments / gridStep) + 1;
    const gridVertexCount = rowLines * segments * 2 * 2;
    const gridPositions = new Float32Array(gridVertexCount * 3);
    let gridOffset = 0;
    const pushSegment = (fromIndex, toIndex) => {
        for (const index of [fromIndex, toIndex]) {
            gridPositions[gridOffset * 3] = positions[index * 3] * 1.000018;
            gridPositions[gridOffset * 3 + 1] = positions[index * 3 + 1] * 1.000018;
            gridPositions[gridOffset * 3 + 2] = positions[index * 3 + 2] * 1.000018;
            gridOffset += 1;
        }
    };
    for (let row = 0; row <= segments; row += gridStep) {
        for (let column = 0; column < segments; column += 1) {
            pushSegment(row * rowLength + column, row * rowLength + column + 1);
        }
    }
    for (let column = 0; column <= segments; column += gridStep) {
        for (let row = 0; row < segments; row += 1) {
            pushSegment(row * rowLength + column, (row + 1) * rowLength + column);
        }
    }
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute('position', new THREE.BufferAttribute(gridPositions.subarray(0, gridOffset * 3), 3));
    regionalTerrainGrid.geometry.dispose();
    regionalTerrainGrid.geometry = gridGeometry;
    regionalTerrainCenter = { latDeg, lonDeg };
    regionalTerrainRelief = {
        meanElevationM,
        minElevationM,
        maxElevationM,
        spanM: maxElevationM - minElevationM,
    };
}

let regionalTerrainRelief = { meanElevationM: 0, minElevationM: 0, maxElevationM: 0, spanM: 0 };
// Actual spacing of the last graticule built, so the HUD cannot claim a number
// the geometry no longer has. 0 means the grid was dropped for render budget.
let regionalGridSpacingKm = 0;

const surfaceHeadlamp = new THREE.DirectionalLight(0xffb08a, 1.15);
surfaceHeadlamp.name = 'surface-explorer-light';
surfaceHeadlamp.visible = false;
surfaceHeadlamp.target.name = 'surface-explorer-light-target';
scene.add(surfaceHeadlamp, surfaceHeadlamp.target);
const surfaceFillLight = new THREE.PointLight(0xff7946, 0.00002, 0.06, 1.5);
surfaceFillLight.visible = false;
scene.add(surfaceFillLight);

const surfaceToggle = document.querySelector('#surface-toggle');
const reliefToggle = document.querySelector('#relief-toggle');
if (!surfaceTexture) {
    surfaceToggle.checked = false;
    surfaceToggle.disabled = true;
    document.querySelector('#surface-source').textContent = 'asset unavailable · material-color fallback';
}
if (!hasRelief) {
    reliefToggle.checked = false;
    reliefToggle.disabled = true;
    document.querySelector('#relief-source').textContent = 'asset unavailable · smooth-sphere fallback';
}
document.querySelector('#mars-mesh-status').textContent = hasRelief
    ? `MOLA 4 px/° · 5× relief${surfaceTexture ? '' : ' · color fallback'}`
    : `smooth sphere${surfaceTexture ? ' · Viking color' : ' · material-color fallback'}`;

// Graticule drawn ON the relief rather than on a floating shell. At the old
// fixed 1.038 radius it stood ~130 km off the ground, so at any close range the
// meridians swept across the frame as unexplained diagonal streaks well clear
// of the surface they were supposed to label.
const GRID_OFFSET = 0.0006;
const gridMaterial = new THREE.LineBasicMaterial({
    color: 0xffc2a0, transparent: true, opacity: 0.16, depthWrite: false,
});

// The layer node itself is stable so visibility bookkeeping (setLayer, the
// surface-mode occlusion map) can hold a permanent reference; only its line
// children are rebuilt when the relief toggle changes the surface radius.
const gridLayer = new THREE.Group();
gridLayer.name = 'mars-coordinate-grid';
marsGroup.add(gridLayer);

function rebuildCoordinateGrid() {
    for (const child of gridLayer.children) child.geometry.dispose();
    gridLayer.clear();
    for (let lon = -180; lon < 180; lon += 30) {
        const points = [];
        for (let lat = -90; lat <= 90; lat += 2) {
            points.push(latLonVector(lat, lon, reliefRadiusAtLatLon(lat, lon, GRID_OFFSET)));
        }
        gridLayer.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), gridMaterial));
    }
    for (let lat = -60; lat <= 60; lat += 30) {
        const points = [];
        for (let lon = -180; lon <= 180; lon += 2) {
            points.push(latLonVector(lat, lon, reliefRadiusAtLatLon(lat, lon, GRID_OFFSET)));
        }
        gridLayer.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), gridMaterial));
    }
}
rebuildCoordinateGrid();

function terminatorPoints(sunDirection, radius = 1.043) {
    sunDirection = sunDirection.clone().normalize();
    const reference = Math.abs(sunDirection.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const axisA = new THREE.Vector3().crossVectors(reference, sunDirection).normalize();
    const axisB = new THREE.Vector3().crossVectors(sunDirection, axisA).normalize();
    const points = [];
    for (let index = 0; index < 256; index += 1) {
        const angle = index / 256 * Math.PI * 2;
        points.push(axisA.clone().multiplyScalar(Math.cos(angle))
            .addScaledVector(axisB, Math.sin(angle))
            .multiplyScalar(radius));
    }
    return { points, sunDirection };
}

const terminatorMaterial = new THREE.LineBasicMaterial({
    color: 0xffd166, transparent: true, opacity: 0.88, depthWrite: false,
});
const terminatorLine = new THREE.LineLoop(new THREE.BufferGeometry(), terminatorMaterial);
const terminatorLayer = new THREE.Group();
terminatorLayer.name = 'current-mars-terminator';
terminatorLayer.add(terminatorLine);
marsGroup.add(terminatorLayer);

/**
 * Feed provenance, surfaced through __marsLab.feedState() and the UI.
 *
 * Every value on this page now comes from one of several sources of very
 * different quality, and the difference is the whole point of the provenance
 * panel: a live MMGIS position is not a baked snapshot, and a JPL sub-solar
 * point is not a linear mean-motion approximation. Track which one won.
 */
const marsFeedState = {
    route: 'pending',
    routeReason: null,
    routeThroughSol: null,
    ephemeris: 'pending',
    ephemerisReason: null,
    illumination: 'analytic',
    weather: 'pending',
};

let horizonsSunDirection = null;
// Sub-solar point from /api/mars/ephemeris (JPL Horizons). Ranks between the
// topocentric Horizons sun direction and the analytic model — see
// updateIllumination for the ladder.
let ephemerisSunDirection = null;

function updateIllumination(date = new Date()) {
    const subsolar = marsSubsolarPoint(date);
    const analyticDirection = latLonVector(subsolar.lat_deg, subsolar.lon_deg).normalize();
    // Illumination ladder, best first:
    //   1. Horizons topocentric Sun az/el at the rover site (the sky layer)
    //   2. Horizons sub-solar point from /api/mars/ephemeris
    //   3. the linear mean-motion model, which can be ~11° of Ls off
    const fallbackDirection = ephemerisSunDirection || analyticDirection;
    marsFeedState.illumination = horizonsSunDirection ? 'horizons-topocentric'
        : ephemerisSunDirection ? 'horizons-subsolar'
        : 'analytic';
    const { points, sunDirection } = terminatorPoints(horizonsSunDirection || fallbackDirection);
    terminatorLine.geometry.dispose();
    terminatorLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
    const worldSunDirection = sunDirection.clone().applyQuaternion(marsGroup.quaternion);
    sun.position.copy(worldSunDirection.multiplyScalar(5));
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld();
    return subsolar;
}

const atmosphereMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { glowColor: { value: new THREE.Color(0xff6b3c) } },
    vertexShader: `varying vec3 vNormal; varying vec3 vWorldPosition;
        void main(){vNormal=normalize(mat3(modelMatrix)*normal);vec4 world=modelMatrix*vec4(position,1.0);vWorldPosition=world.xyz;gl_Position=projectionMatrix*viewMatrix*world;}`,
    fragmentShader: `uniform vec3 glowColor; varying vec3 vNormal; varying vec3 vWorldPosition;
        void main(){vec3 viewDir=normalize(cameraPosition-vWorldPosition);float rim=pow(1.0-abs(dot(vNormal,viewDir)),4.5);gl_FragColor=vec4(glowColor,rim*.48);}`,
});
const atmosphereLayer = new THREE.Mesh(new THREE.SphereGeometry(1.075, 128, 64), atmosphereMaterial);
marsGroup.add(atmosphereLayer);

/**
 * Martian sky dome for the surface explorer.
 *
 * Surface mode used to hide every celestial layer and render nothing above the
 * terrain, so the "regional surface explorer" was a flat orange field with no
 * horizon, no sky, and no way to tell up from down. This is the missing half of
 * the frame: a camera-locked gradient that carries the sun's own light.
 *
 * The palettes below are the real thing, not stylisation. Mars' daytime sky is
 * butterscotch because suspended dust absorbs blue; at low sun the SAME dust
 * forward-scatters, which is why Mars has warm days and famously BLUE sunsets —
 * the inverse of Earth. `uSunTint` carries that swing, so the glow around the
 * Sun goes cool as it sets. Do not "correct" it to an orange sunset.
 *
 * Draw order: star field (renderOrder −2) then the dome (−1), both after the
 * opaque terrain. The dome depth-tests against the terrain so the ground is
 * never painted over, and being drawn after the stars it hides them by day and
 * — at its low night alpha — lets them through after dark. Its radius sits
 * BEYOND the stars (0.6 > 0.5) so nothing about that ordering depends on luck.
 */
const skyDomeMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    uniforms: {
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uHorizon: { value: new THREE.Color(0xd8a273) },
        uZenith: { value: new THREE.Color(0x9c6446) },
        uSunTint: { value: new THREE.Color(0xfff0dc) },
        uOpacity: { value: 0 },
        uGlow: { value: 0.5 },
    },
    vertexShader: `varying vec3 vDirection;
        void main(){vDirection=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `uniform vec3 uUp; uniform vec3 uSunDirection; uniform vec3 uHorizon; uniform vec3 uZenith;
        uniform vec3 uSunTint; uniform float uOpacity; uniform float uGlow;
        varying vec3 vDirection;
        void main(){
            vec3 dir=normalize(vDirection);
            float altitude=dot(dir,uUp);
            // Compress the gradient toward the horizon, where a real dusty
            // atmosphere has by far the longest optical path.
            float band=pow(1.0-clamp(altitude,0.0,1.0),2.6);
            vec3 sky=mix(uZenith,uHorizon,band);
            float sunAngle=max(dot(dir,uSunDirection),0.0);
            sky+=uSunTint*(pow(sunAngle,42.0)*1.15+pow(sunAngle,7.0)*0.30)*uGlow;
            // Below the local horizontal there is ground, not sky. Fade out so
            // the dome never paints over the terrain silhouette.
            float belowHorizon=smoothstep(-0.06,0.0,altitude);
            gl_FragColor=vec4(sky,uOpacity*belowHorizon);
        }`,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyDomeMaterial);
skyDome.name = 'mars-surface-sky';
skyDome.scale.setScalar(0.6);
skyDome.renderOrder = -1;
skyDome.frustumCulled = false;
skyDome.visible = false;
scene.add(skyDome);

const SKY_PALETTES = Object.freeze([
    // sunElevationDeg floor, horizon, zenith, sun tint, opacity, glow
    Object.freeze({ above: 18,  horizon: 0xdCA877, zenith: 0x9a6244, tint: 0xfff2de, opacity: 1,    glow: 0.55 }),
    Object.freeze({ above: 6,   horizon: 0xe0a06a, zenith: 0x8a5540, tint: 0xffe6c8, opacity: 1,    glow: 0.8 }),
    Object.freeze({ above: 0,   horizon: 0xc98a63, zenith: 0x5c3f4c, tint: 0xbcd4ff, opacity: 0.96, glow: 1.15 }),
    Object.freeze({ above: -6,  horizon: 0x8f5f5c, zenith: 0x33253c, tint: 0x9fc2ff, opacity: 0.82, glow: 1.0 }),
    Object.freeze({ above: -12, horizon: 0x4a3038, zenith: 0x150f1e, tint: 0x6f92cc, opacity: 0.5,  glow: 0.5 }),
    Object.freeze({ above: -90, horizon: 0x160e10, zenith: 0x05040a, tint: 0x24304a, opacity: 0.16, glow: 0.15 }),
]);

const skyHorizonColor = new THREE.Color();
const skyZenithColor = new THREE.Color();
const skySunTint = new THREE.Color();
const skyPaletteLow = new THREE.Color();

/**
 * Blend the palette table at the current solar elevation and push it into the
 * dome and the fog. Returns the sun elevation in degrees so callers can report
 * whether the explored point is in daylight.
 */
function updateSurfaceSky(radialWorld) {
    const sunDirection = sun.position.clone().normalize();
    const sunElevationDeg = THREE.MathUtils.radToDeg(
        Math.asin(THREE.MathUtils.clamp(sunDirection.dot(radialWorld), -1, 1)),
    );
    // SKY_PALETTES is sorted descending by `above`. Find the first stop the sun
    // is at or above; that stop is the lower bound and its predecessor the upper.
    let stop = SKY_PALETTES.findIndex(entry => sunElevationDeg >= entry.above);
    if (stop < 0) stop = SKY_PALETTES.length - 1;
    const lower = SKY_PALETTES[stop];
    const upper = SKY_PALETTES[Math.max(0, stop - 1)];
    const span = Math.max(1e-6, upper.above - lower.above);
    const amount = stop === 0
        ? 1
        : THREE.MathUtils.clamp((sunElevationDeg - lower.above) / span, 0, 1);
    const blend = (target, low, high) => {
        target.setHex(low);
        skyPaletteLow.setHex(high);
        target.lerp(skyPaletteLow, amount);
    };
    blend(skyHorizonColor, lower.horizon, upper.horizon);
    blend(skyZenithColor, lower.zenith, upper.zenith);
    blend(skySunTint, lower.tint, upper.tint);

    skyDomeMaterial.uniforms.uUp.value.copy(radialWorld);
    skyDomeMaterial.uniforms.uSunDirection.value.copy(sunDirection);
    skyDomeMaterial.uniforms.uHorizon.value.copy(skyHorizonColor);
    skyDomeMaterial.uniforms.uZenith.value.copy(skyZenithColor);
    skyDomeMaterial.uniforms.uSunTint.value.copy(skySunTint);
    skyDomeMaterial.uniforms.uOpacity.value = THREE.MathUtils.lerp(lower.opacity, upper.opacity, amount);
    skyDomeMaterial.uniforms.uGlow.value = THREE.MathUtils.lerp(lower.glow, upper.glow, amount);

    // Distant terrain has to fade into the sky it meets, or the horizon reads
    // as a hard cut-out. Fog colour tracks the horizon band for exactly that.
    scene.fog.color.copy(skyHorizonColor);
    return sunElevationDeg;
}

const landmarks = new MarsLandmarks(marsGroup, latLonVector, {
    radiusAt: (latDeg, lonDeg) => reliefRadiusAtLatLon(latDeg, lonDeg),
});
const sky = new MarsSky(marsGroup, { onUpdate: applyMarsSkyUi });

function makeLabel(text, color = '#ffd9c4') {
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 512;
    labelCanvas.height = 112;
    const context = labelCanvas.getContext('2d');
    context.fillStyle = 'rgba(9,4,3,.82)';
    context.strokeStyle = 'rgba(255,163,110,.52)';
    context.lineWidth = 3;
    context.beginPath();
    context.roundRect(3, 3, 506, 106, 18);
    context.fill();
    context.stroke();
    context.fillStyle = color;
    context.font = '600 35px "Space Grotesk", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 256, 57);
    const texture = new THREE.CanvasTexture(labelCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false }));
    sprite.scale.set(0.31, 0.068, 1);
    sprite.renderOrder = 10;
    return sprite;
}

// Markers sit ON the relief. The old fixed 1.046 radius put every beacon
// ~156 km above the ground, so at rover-focus range the rover marker, the
// landing site, and the terrain they name were visibly three different places.
const MARKER_OFFSET = 0.0009;

function placeSurfaceMarker(group, lat, lon) {
    const position = latLonVector(lat, lon, anchorRadiusAtLatLon(lat, lon, MARKER_OFFSET));
    const normal = position.clone().normalize();
    group.position.copy(position);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    group.userData.latDeg = lat;
    group.userData.lonDeg = lon;
    return normal;
}

function makeSurfaceMarker({ lat, lon, color, size, label }) {
    const group = new THREE.Group();
    const normal = placeSurfaceMarker(group, lat, lon);
    const beacon = new THREE.Mesh(
        new THREE.ConeGeometry(size * 0.48, size * 1.6, 16),
        new THREE.MeshBasicMaterial({ color, depthTest: true }),
    );
    beacon.position.y = size * 0.8;
    group.add(beacon);
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(size * 0.62, size * 0.82, 32),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthTest: true, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    group.add(ring);
    if (label) {
        const sprite = makeLabel(label);
        sprite.position.copy(normal.clone().multiplyScalar(0.105));
        group.add(sprite);
    }
    group.userData.ring = ring;
    marsGroup.add(group);
    return group;
}

const roverLayer = makeSurfaceMarker({
    lat: mission.position.lat_deg,
    lon: mission.position.lon_deg,
    color: 0x69e4ff,
    size: 0.025,
    label: null,
});
const landingLayer = makeSurfaceMarker({
    lat: mission.landing_site.lat_deg,
    lon: mission.landing_site.lon_deg,
    color: 0xffd166,
    size: 0.016,
    label: null,
});

const routeLayer = new THREE.Group();
routeLayer.name = 'nasa-perseverance-traverse';
const routeLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xffe7c7, transparent: true, opacity: 0.94, depthWrite: false }),
);
routeLayer.add(routeLine);
marsGroup.add(routeLayer);

const waypointsLayer = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color: 0x69e4ff, size: 0.007, transparent: true, opacity: 0.82, depthWrite: false, sizeAttenuation: true }),
);
marsGroup.add(waypointsLayer);

const routeCursor = makeSurfaceMarker({
    lat: mission.latest_drive.position.lat_deg,
    lon: mission.latest_drive.position.lon_deg,
    color: 0xffd166,
    size: 0.022,
    label: null,
});
routeLayer.add(routeCursor);

let routeSnapshot = null;
let selectedRoutePoint = {
    sol: mission.latest_drive.sol,
    lat_deg: mission.latest_drive.position.lat_deg,
    lon_deg: mission.latest_drive.position.lon_deg,
    elevation_m: mission.latest_drive.position.elevation_m,
    distance_km: mission.latest_drive.distance_km,
};

function routeIndexAtSol(points, sol) {
    let low = 0;
    let high = points.length - 1;
    let result = 0;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (points[middle].sol <= sol) {
            result = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return result;
}

function reportedDistanceAt(points, index) {
    for (let cursor = index; cursor >= 0; cursor -= 1) {
        if (points[cursor].distance_km != null) return points[cursor].distance_km;
    }
    return null;
}

// The traverse is 690 NASA localizations draped on the relief. It used to be
// drawn on a fixed 1.044 shell — ~150 km above the ground it describes.
const ROUTE_OFFSET = 0.00055;

function rebuildRouteGeometry() {
    if (!routeSnapshot?.points?.length) return;
    const vectors = routeSnapshot.points.map(point => latLonVector(
        point.lat_deg,
        point.lon_deg,
        anchorRadiusAtLatLon(point.lat_deg, point.lon_deg, ROUTE_OFFSET),
    ));
    const previousDrawRange = routeLine.geometry.drawRange.count;
    routeLine.geometry.dispose();
    routeLine.geometry = new THREE.BufferGeometry().setFromPoints(vectors);
    waypointsLayer.geometry.dispose();
    waypointsLayer.geometry = new THREE.BufferGeometry().setFromPoints(vectors);
    // setFromPoints resets drawRange to Infinity, which would flash the full
    // traverse back in when the relief toggle rebuilds geometry mid-scrub.
    if (Number.isFinite(previousDrawRange)) {
        routeLine.geometry.setDrawRange(0, previousDrawRange);
        waypointsLayer.geometry.setDrawRange(0, previousDrawRange);
    }
}

/**
 * Re-seat everything anchored to the ground after the surface radius changes —
 * relief toggled, or surface mode entered/left (which swaps the 5× globe
 * exaggeration for the patch's 18×). Every caller that changes the radius
 * function MUST call this, or markers detach from the terrain again.
 */
function refreshSurfaceAnchors() {
    rebuildCoordinateGrid();
    rebuildRouteGeometry();
    placeSurfaceMarker(roverLayer, mission.position.lat_deg, mission.position.lon_deg);
    placeSurfaceMarker(landingLayer, mission.landing_site.lat_deg, mission.landing_site.lon_deg);
    placeSurfaceMarker(routeCursor, selectedRoutePoint.lat_deg, selectedRoutePoint.lon_deg);
    updateLandingReticle(true);
}

function selectRouteSol(requestedSol) {
    if (!routeSnapshot?.points?.length) return;
    const index = routeIndexAtSol(routeSnapshot.points, requestedSol);
    selectedRoutePoint = routeSnapshot.points[index];
    routeLine.geometry.setDrawRange(0, index + 1);
    waypointsLayer.geometry.setDrawRange(0, index + 1);
    placeSurfaceMarker(routeCursor, selectedRoutePoint.lat_deg, selectedRoutePoint.lon_deg);
    const distance = reportedDistanceAt(routeSnapshot.points, index);
    document.querySelector('#route-sol-output').textContent = `Sol ${selectedRoutePoint.sol}${distance == null ? '' : ` · ${distance.toFixed(2)} km`}`;
}

/**
 * Live NASA/JPL MMGIS traverse, bundled snapshot as the fallback.
 *
 * /api/mars/route answers 200 either way and says `live: true|false`, so a NASA
 * outage is an ordinary branch rather than an exception. The bundled file is
 * still the offline path and is still labelled as a snapshot when it is used —
 * the provenance line names which one is on screen, always.
 */
let routeScrubBound = false;

async function fetchTraverseSnapshot() {
    try {
        const response = await fetch('/api/mars/route', { headers: { Accept: 'application/json' } });
        if (response.ok) {
            const payload = await response.json();
            if (payload?.live && Array.isArray(payload.points) && payload.points.length >= 2) {
                // Clear any reason left by an earlier hourly attempt, or the UI
                // keeps explaining a fallback that is no longer in effect.
                marsFeedState.routeReason = null;
                return { snapshot: payload, live: true };
            }
            marsFeedState.routeReason = payload?.reason || 'MMGIS returned no usable route';
        } else {
            marsFeedState.routeReason = `route adapter HTTP ${response.status}`;
        }
    } catch (error) {
        marsFeedState.routeReason = error.message || 'route adapter unreachable';
    }
    const response = await fetch('/data/mars/perseverance-route.json', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    if (!Array.isArray(snapshot.points) || snapshot.points.length < 2) throw new Error('route snapshot has no points');
    return { snapshot, live: false };
}

async function loadTraverseHistory() {
    const range = document.querySelector('#route-sol');
    try {
        const { snapshot, live } = await fetchTraverseSnapshot();
        routeSnapshot = snapshot;
        marsFeedState.route = live ? 'live' : 'bundled';
        marsFeedState.routeThroughSol = snapshot.through_sol;
        rebuildRouteGeometry();
        // Hourly refresh: keep the visitor's scrub position unless they were
        // parked at the end of the traverse, in which case follow the rover.
        const wasAtLatest = !routeScrubBound || Number(range.value) >= Number(range.max);
        range.min = String(snapshot.points[0].sol);
        range.max = String(snapshot.through_sol);
        if (wasAtLatest) range.value = String(snapshot.through_sol);
        range.disabled = false;
        if (!routeScrubBound) {
            range.addEventListener('input', () => selectRouteSol(Number(range.value)));
            routeScrubBound = true;
        }
        document.querySelector('#route-history-source').textContent = live
            ? `${snapshot.point_count} NASA stops · live MMGIS`
            : `${snapshot.point_count} NASA stops · ${snapshot.snapshot_checked_at}`;
        document.querySelector('#route-source').textContent = live
            ? `${snapshot.point_count} live NASA MMGIS stops · through sol ${snapshot.through_sol}`
            : `${snapshot.point_count} bundled NASA stops · through sol ${snapshot.through_sol}`;
        // The live traverse supersedes the compiled-in mission constant, so the
        // panel's drive sol and odometer follow MMGIS rather than the build date.
        if (live) {
            const latest = snapshot.points.at(-1);
            applyMissionUi({
                latest_drive: {
                    sol: latest.sol,
                    distance_km: snapshot.distance_km,
                    checked_at: snapshot.snapshot_checked_at,
                    position: {
                        lat_deg: latest.lat_deg,
                        lon_deg: latest.lon_deg,
                        elevation_m: latest.elevation_m ?? mission.latest_drive.position.elevation_m,
                    },
                },
            });
        }
        selectRouteSol(Number(range.value));
    } catch (error) {
        marsFeedState.route = 'unavailable';
        console.warn('[Mars] NASA traverse unavailable (live adapter and bundled snapshot)', error);
        range.disabled = true;
        document.querySelector('#route-sol-output').textContent = 'Route unavailable';
        document.querySelector('#route-history-source').textContent = 'Bundled endpoint markers remain';
        document.querySelector('#route-source').textContent = 'snapshot unavailable · landing + latest-drive markers remain';
        const routeToggle = document.querySelector('#route-toggle');
        routeToggle.checked = false;
        routeToggle.disabled = true;
        const waypointsToggle = document.querySelector('#waypoints-toggle');
        waypointsToggle.checked = false;
        waypointsToggle.disabled = true;
        routeLayer.visible = false;
        waypointsLayer.visible = false;
    }
}

function missionWithFallback(state = {}) {
    const latestDrive = {
        ...mission.latest_drive,
        ...(state.latest_drive || {}),
        position: {
            ...mission.latest_drive.position,
            ...(state.latest_drive?.position || {}),
        },
    };
    return {
        ...mission,
        ...state,
        latest_drive: latestDrive,
        position: { ...mission.position, ...(state.position || {}) },
        meda_archive: { ...mission.meda_archive, ...(state.meda_archive || {}) },
    };
}

function applyMissionUi(state) {
    const resolved = missionWithFallback(state);
    const latestDrive = resolved.latest_drive;
    const position = resolved.position;
    const routePosition = latestDrive.position || position;
    document.querySelector('#mission-status').textContent = resolved.status === 'operational' ? 'Operating on Mars' : (resolved.status || 'Bundled mission snapshot');
    document.querySelector('#mission-pill').textContent = resolved.status === 'operational' ? 'Active' : 'Snapshot';
    document.querySelector('#drive-sol').textContent = `Sol ${latestDrive.sol}`;
    document.querySelector('#drive-date').textContent = `NASA map · checked ${latestDrive.checked_at}`;
    document.querySelector('#drive-distance').textContent = `${latestDrive.distance_km.toFixed(2)} km`;
    document.querySelector('#fix-sol').textContent = `Sol ${latestDrive.sol}`;
    document.querySelector('#fix-coordinates').textContent = `${routePosition.lat_deg.toFixed(3)}°N, ${routePosition.lon_deg.toFixed(3)}°E`;
    document.querySelector('#pds-sol').textContent = `Sol ${resolved.meda_archive.latest_verified_sol}`;
    document.querySelector('#position-note').innerHTML = `<strong>Position integrity:</strong> gold cursor and white history use NASA's MMGIS route snapshot through sol ${latestDrive.sol}. The cyan marker is an independent MEDA/PDS science fix from sol ${position.sol}. Neither is live GPS.`;
}

function numberOrNull(value) {
    if (value == null || value === '') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

function formatTemperature(record) {
    const min = numberOrNull(record?.min_temp_C);
    const max = numberOrNull(record?.max_temp_C);
    if (min == null && max == null) return '—';
    if (min != null && max != null) return `${min.toFixed(1)} → ${max.toFixed(1)} °C`;
    return `${(min ?? max).toFixed(1)} °C`;
}

function applyWeatherUi(payload) {
    const record = payload?.rovers?.perseverance;
    const feedState = document.querySelector('#feed-state');
    const warning = document.querySelector('#weather-warning');
    // Season belongs to /api/mars/ephemeris once JPL has answered — the Ls in
    // the weather payload is the linear mean-motion model, and letting a later
    // weather refresh overwrite the JPL value would quietly re-introduce up to
    // ~11° of error that applyEphemerisUi had just removed.
    if (marsFeedState.ephemeris !== 'jpl-horizons') {
        const orbitalSeason = marsSubsolarPoint(new Date()).ls_deg;
        const payloadSeason = numberOrNull(payload?.ls_deg) ?? orbitalSeason;
        const weatherSeason = numberOrNull(record?.ls_deg) ?? payloadSeason;
        document.querySelector('#header-season').textContent = `LS ${Math.round(payloadSeason)}°`;
        document.querySelector('#weather-season').textContent = `Ls ${Math.round(weatherSeason)}°`;
        document.querySelector('#weather-season-detail').textContent = record?.season || payload?.message || 'orbital season fallback';
    }
    if (!record?.active) {
        feedState.dataset.state = 'offline';
        feedState.textContent = 'Observation feed unavailable · offline-capable view';
        warning.textContent = '3D globe, mission snapshot, route, and orbital season remain available; no weather value is inferred.';
        markMissingWeather();
        return;
    }
    const freshness = record.observation_status
        ? { status: record.observation_status, age_days: record.observation_age_days }
        : observationFreshness(record);
    feedState.dataset.state = freshness.status;
    feedState.textContent = freshness.status === 'recent'
        ? `Recent MEDA summary · sol ${record.sol}`
        : `Historical MEDA summary · sol ${record.sol}`;
    warning.textContent = freshness.age_days == null
        ? 'NASA observation date retained; this is not live surface telemetry.'
        : `Observed ${record.terrestrial_date} · ${freshness.age_days.toLocaleString()} Earth days old · not live telemetry`;
    document.querySelector('#weather-temp').textContent = formatTemperature(record);
    document.querySelector('#weather-temp-detail').textContent = record.terrestrial_date ? `daily minimum → maximum · ${record.terrestrial_date}` : 'daily minimum → maximum';
    const pressure = numberOrNull(record.pressure_pa);
    document.querySelector('#weather-pressure').textContent = pressure == null ? '—' : `${pressure.toFixed(1)} Pa`;
    const wind = numberOrNull(record.wind_speed_mps);
    document.querySelector('#weather-wind').textContent = wind == null ? '—' : `${wind.toFixed(1)} m/s`;
    document.querySelector('#weather-wind-detail').textContent = wind == null ? 'not published in daily summary' : 'daily summary';
    document.querySelector('#weather-sol').textContent = record.sol == null ? '—' : `Sol ${record.sol}`;
    document.querySelector('#weather-date').textContent = record.terrestrial_date || 'NASA date unavailable';
    document.querySelector('#cell-temp').dataset.quality = formatTemperature(record) === '—' ? 'missing' : 'available';
    document.querySelector('#cell-pressure').dataset.quality = pressure == null ? 'missing' : 'available';
    document.querySelector('#cell-wind').dataset.quality = wind == null ? 'missing' : 'available';
    document.querySelector('#feed-provenance').textContent = `${record.source || 'NASA Mars 2020 MEDA'} · normalized by /api/mars/weather`;
}

function markMissingWeather() {
    for (const id of ['weather-temp', 'weather-pressure', 'weather-wind', 'weather-sol']) document.querySelector(`#${id}`).textContent = '—';
    for (const id of ['cell-temp', 'cell-pressure', 'cell-wind']) document.querySelector(`#${id}`).dataset.quality = 'missing';
    document.querySelector('#weather-temp-detail').textContent = 'no observation returned';
    document.querySelector('#weather-wind-detail').textContent = 'no observation returned';
    document.querySelector('#weather-date').textContent = 'NASA date unavailable';
}

function applyBundledWeather(payload = {}, reason = 'Shared adapter is still loading') {
    applyWeatherUi({
        ...payload,
        rovers: {
            ...(payload.rovers || {}),
            perseverance: PERSEVERANCE_MEDA_SNAPSHOT,
        },
    });
    const freshness = observationFreshness(PERSEVERANCE_MEDA_SNAPSHOT);
    const age = freshness.age_days == null ? 'historical' : `${freshness.age_days.toLocaleString()} Earth days old`;
    const feedState = document.querySelector('#feed-state');
    feedState.dataset.state = 'historical';
    feedState.textContent = `Bundled MEDA snapshot · sol ${PERSEVERANCE_MEDA_SNAPSHOT.sol}`;
    document.querySelector('#weather-warning').textContent = `${reason} · observed ${PERSEVERANCE_MEDA_SNAPSHOT.terrestrial_date} · ${age} · not live telemetry`;
    document.querySelector('#feed-provenance').textContent = `${PERSEVERANCE_MEDA_SNAPSHOT.source} · retained for offline first paint`;
}

async function loadMarsFeed() {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch('/api/mars/weather', { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        // The live MMGIS traverse, if it landed, is newer than the mission
        // constant this payload echoes — don't roll the panel back to it.
        if (marsFeedState.route !== 'live') applyMissionUi(payload?.mission?.perseverance || mission);
        if (payload?.rovers?.perseverance?.active) {
            marsFeedState.weather = payload.rovers.perseverance.observation_status || 'active';
            applyWeatherUi(payload);
        } else {
            // Name the upstream that failed instead of shrugging. The adapter's
            // `sources` roll-up exists precisely so this line can be specific.
            const failed = Array.isArray(payload?.sources)
                ? payload.sources.find(source => source.key === 'perseverance')
                : null;
            marsFeedState.weather = 'offline';
            applyBundledWeather(payload, failed?.reason
                ? `NASA MEDA daily summary unavailable (${failed.reason})`
                : 'NASA daily-summary upstream returned no usable observation');
        }
    } catch (error) {
        console.warn('[Mars] Shared weather adapter unavailable', error);
        marsFeedState.weather = 'unavailable';
        applyMissionUi(mission);
        applyBundledWeather({}, 'Shared adapter unavailable');
    } finally {
        window.clearTimeout(timer);
    }
}

// ── Live Mars geometry (JPL Horizons via /api/mars/ephemeris) ───────────────

function formatRange(km) {
    if (!Number.isFinite(km)) return '—';
    return `${(km / 1e6).toFixed(1)} M km`;
}

function applyEphemerisUi(payload) {
    const live = payload?.source === 'jpl-horizons';
    marsFeedState.ephemeris = live ? 'jpl-horizons' : 'analytic';
    marsFeedState.ephemerisReason = payload?.degraded_reason || null;

    const lsDeg = Number.isFinite(payload?.ls_deg) ? payload.ls_deg : null;
    if (lsDeg != null) {
        document.querySelector('#header-season').textContent = `LS ${Math.round(lsDeg)}°`;
        document.querySelector('#weather-season').textContent = `Ls ${Math.round(lsDeg)}°`;
        document.querySelector('#weather-season-detail').textContent = payload.season
            ? `${payload.season}${live ? ' · JPL' : ' · analytic model'}`
            : (live ? 'JPL Horizons L_s' : 'analytic model');
    }

    const setGeometry = (id, value, detail) => {
        const cell = document.querySelector(id);
        if (!cell) return;
        cell.querySelector('strong').textContent = value;
        const small = cell.querySelector('small');
        if (small && detail != null) small.textContent = detail;
        cell.dataset.quality = value === '—' ? 'missing' : 'available';
    };
    setGeometry('#geo-range', formatRange(payload?.earth_range_km),
        Number.isFinite(payload?.earth_range_au) ? `${payload.earth_range_au.toFixed(3)} AU` : 'Earth–Mars distance');
    setGeometry('#geo-light-time', payload?.light_time_text || '—', 'one-way, at light speed');
    setGeometry('#geo-elongation',
        Number.isFinite(payload?.solar_elongation_deg) ? `${payload.solar_elongation_deg.toFixed(1)}°` : '—',
        payload?.solar_conjunction?.note || 'Sun–Earth–Mars angle');
    setGeometry('#geo-subsolar',
        Number.isFinite(payload?.sub_solar?.lat_deg) && Number.isFinite(payload?.sub_solar?.lon_deg)
            ? `${payload.sub_solar.lat_deg.toFixed(1)}°, ${payload.sub_solar.lon_deg.toFixed(1)}°`
            : '—',
        'sub-solar lat, lon');

    const note = document.querySelector('#geometry-note');
    if (note) {
        if (live) {
            const delta = Number.isFinite(payload.ls_model_delta_deg)
                ? ` The bundled analytic season model differs by ${Math.abs(payload.ls_model_delta_deg).toFixed(1)}° of Ls.`
                : '';
            note.innerHTML = `<strong>Geometry:</strong> live JPL Horizons, refreshed every 15 minutes.${delta}`;
        } else {
            note.innerHTML = `<strong>Geometry:</strong> JPL Horizons unavailable (${payload?.degraded_reason || 'no response'}); showing the bundled analytic season model, which can run ~11° of Ls off near the solstices.`;
        }
    }

    // Feed the sub-solar point into the terminator. This is strictly better than
    // the analytic model and independent of the five-body topocentric sky query,
    // so illumination survives a partial Horizons outage.
    if (live && Number.isFinite(payload.sub_solar?.lat_deg) && Number.isFinite(payload.sub_solar?.lon_deg)) {
        ephemerisSunDirection = latLonVector(payload.sub_solar.lat_deg, payload.sub_solar.lon_deg).normalize();
    }
    updateIllumination();
}

async function loadMarsEphemeris() {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 25_000);
    try {
        const response = await fetch('/api/mars/ephemeris', { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        applyEphemerisUi(await response.json());
    } catch (error) {
        console.warn('[Mars] Live geometry adapter unavailable', error);
        marsFeedState.ephemeris = 'unavailable';
        marsFeedState.ephemerisReason = error.message || 'adapter unreachable';
        const note = document.querySelector('#geometry-note');
        if (note) note.innerHTML = '<strong>Geometry:</strong> live adapter unreachable; the season shown is the bundled analytic model.';
    } finally {
        window.clearTimeout(timer);
    }
}

const SKY_BODY_KEYS = ['sun', 'earth', 'moon', 'ceres', 'vesta'];

function signedDegrees(value) {
    if (!Number.isFinite(value)) return '—';
    return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}°`;
}

function applyMarsSkyUi(values, ephemeris) {
    const available = Object.keys(values).length;
    const title = document.querySelector('#sky-feed-title');
    title.textContent = ephemeris.status === 'live'
        ? 'Mars sky · JPL Horizons · live 5/5'
        : `Mars sky · JPL Horizons · ${ephemeris.status} ${available}/5`;
    for (const key of SKY_BODY_KEYS) {
        const status = document.querySelector(`#sky-${key}-status`);
        const value = values[key];
        status.textContent = value
            ? `Az ${value.azimuth_deg.toFixed(1)}° · El ${signedDegrees(value.elevation_deg)} · ${value.above_horizon ? 'above' : 'below'} horizon`
            : (ephemeris.errors?.[key] ? 'JPL unavailable · no synthetic position' : 'waiting for JPL Horizons');
    }
    horizonsSunDirection = sky.getDirection('sun');
    document.querySelector('#terminator-source').textContent = horizonsSunDirection
        ? 'JPL Sun direction · IAU_MARS observer frame'
        : 'season + MTC fallback · JPL Sun unavailable';
    updateIllumination();
}

async function loadMarsSky() {
    try {
        const position = mission.latest_drive.position;
        const ephemeris = await fetchMarsSkyEphemeris({
            date: new Date(),
            latDeg: position.lat_deg,
            lonDeg: position.lon_deg,
            elevationM: position.elevation_m,
            siteName: `Perseverance route snapshot · sol ${mission.latest_drive.sol}`,
        });
        sky.updateEphemeris(ephemeris);
        if (ephemeris.status === 'offline') throw new Error('all five Horizons observer queries failed');
    } catch (error) {
        console.warn('[Mars] JPL Horizons sky unavailable', error);
        horizonsSunDirection = null;
        document.querySelector('#sky-feed-title').textContent = 'Mars sky · JPL Horizons unavailable';
        document.querySelector('#terminator-source').textContent = 'season + MTC fallback · JPL unavailable';
        for (const key of SKY_BODY_KEYS) {
            document.querySelector(`#sky-${key}-status`).textContent = 'JPL unavailable · no synthetic position';
        }
        updateIllumination();
    }
}

function scheduleMarsSkyRefresh() {
    const now = Date.now();
    const nextHour = Math.ceil(now / 3_600_000) * 3_600_000;
    const delay = Math.max(5_000, nextHour + 10_000 - now);
    window.setTimeout(async () => {
        await loadMarsSky();
        scheduleMarsSkyRefresh();
    }, delay);
}

function updateMarsClock() {
    const now = new Date();
    const subsolar = marsSubsolarPoint(now);
    document.querySelector('#header-sol').textContent = `SOL ${estimatedMissionSol(now)}`;
    document.querySelector('#header-lmst').textContent = formatMarsClock(localMeanSolarTimeHours(mission.latest_drive.position.lon_deg, now));
    if (document.querySelector('#header-season').textContent === 'LS —°') {
        document.querySelector('#header-season').textContent = `LS ${Math.round(subsolar.ls_deg)}°`;
    }
}

function setLayer(name, enabled) {
    if (name === 'imagery') {
        surfaceMaterial.map = enabled ? surfaceTexture : null;
        surfaceMaterial.color.set(enabled && surfaceTexture ? 0xffffff : 0xa83f20);
        surfaceMaterial.needsUpdate = true;
        regionalTerrainMaterial.map = enabled ? surfaceTexture : null;
        regionalTerrainMaterial.emissiveMap = enabled ? surfaceTexture : null;
        regionalTerrainMaterial.color.set(enabled && surfaceTexture ? 0xffffff : 0x9d3d22);
        regionalTerrainMaterial.needsUpdate = true;
    } else if (name === 'relief') {
        // Order matters: reliefEnabled feeds reliefRadiusAtLatLon, which every
        // ground-anchored rebuild below reads.
        reliefEnabled = Boolean(enabled);
        setGlobeVisibility(reliefEnabled && hasRelief);
        refreshSurfaceAnchors();
        if (surfaceModeActive && regionalTerrainCenter) {
            rebuildRegionalTerrain(regionalTerrainCenter.latDeg, regionalTerrainCenter.lonDeg);
            updateSurfaceTrail(surfaceLocation || regionalTerrainCenter, { reset: true });
        }
    } else if (name === 'synth') {
        // Deliberately does NOT touch reliefEnabled — the synth layer modulates
        // decoration and tint only; the anchor stack must not move with it.
        synthEnabled = Boolean(enabled);
        if (surfaceModeActive && regionalTerrainCenter) {
            rebuildRegionalTerrain(regionalTerrainCenter.latDeg, regionalTerrainCenter.lonDeg);
            updateSurfaceDetail();
        }
    } else if (name === 'grid') gridLayer.visible = enabled;
    // The quality ladder can drop the limb shell entirely; the layer switch must
    // not turn it back on underneath that decision.
    else if (name === 'atmosphere') atmosphereLayer.visible = enabled && QUALITY_LEVELS[qualityIndex].atmosphere;
    else if (name === 'terminator') terminatorLayer.visible = enabled;
    else if (name === 'rover') roverLayer.visible = enabled;
    else if (name === 'landing') landingLayer.visible = enabled;
    else if (name === 'route') routeLayer.visible = enabled;
    else if (name === 'waypoints') waypointsLayer.visible = enabled;
    else if (name.startsWith('sky-')) sky.setBodyVisible(name.slice(4), enabled);
    else if (name === 'landmark-volcano') landmarks.setCategoryVisible('volcano', enabled);
    else if (name === 'landmark-fracture') landmarks.setCategoryVisible('fracture', enabled);
    else if (name === 'landmark-basins') {
        landmarks.setCategoryVisible('basin', enabled);
        landmarks.setCategoryVisible('crater', enabled);
    } else if (name === 'landmark-polar') landmarks.setCategoryVisible('polar', enabled);
    else if (name === 'rotate') setAutoRotate(enabled);
}

function layerIsVisible(name) {
    if (name === 'imagery') return Boolean(surfaceMaterial.map);
    // While the explorer is up the globe meshes are force-hidden, so the honest
    // answer for "is relief on" is the pending value in the restore map.
    if (name === 'relief') {
        return surfaceModeActive
            ? Boolean(surfaceVisibilityRestore.get(reliefMars))
            : reliefMars.visible;
    }
    if (name === 'regional-terrain') return regionalTerrain.visible;
    if (name === 'synth') return synthEnabled;
    if (name === 'grid') return gridLayer.visible;
    if (name === 'atmosphere') return atmosphereLayer.visible;
    if (name === 'terminator') return terminatorLayer.visible;
    if (name === 'rover') return roverLayer.visible;
    if (name === 'landing') return landingLayer.visible;
    if (name === 'route') return routeLayer.visible;
    if (name === 'waypoints') return waypointsLayer.visible;
    if (name.startsWith('sky-')) return Boolean(sky.entries[name.slice(4)]?.enabled);
    if (name === 'landmark-volcano') return landmarks.categoryGroups.volcano.visible;
    if (name === 'landmark-fracture') return landmarks.categoryGroups.fracture.visible;
    if (name === 'landmark-basins') return landmarks.categoryGroups.basin.visible && landmarks.categoryGroups.crater.visible;
    if (name === 'landmark-polar') return landmarks.categoryGroups.polar.visible;
    if (name === 'rotate') return controls.autoRotate;
    return null;
}

const cameraModeElement = document.querySelector('#camera-mode');
const cameraRangeElement = document.querySelector('#camera-range');
const cameraSpinButton = document.querySelector('#camera-spin');
const rotateToggle = document.querySelector('[data-layer="rotate"]');
const cameraHelpElement = document.querySelector('#camera-help');
const surfaceExplorer = document.querySelector('#surface-explorer');
const surfaceLocationElement = document.querySelector('#surface-location');
const surfaceAltitudeElement = document.querySelector('#surface-altitude');
const surfaceDetailElement = document.querySelector('#surface-detail');
const pilotElements = {
    hdg: document.querySelector('#pilot-hdg'),
    agl: document.querySelector('#pilot-agl'),
    vs: document.querySelector('#pilot-vs'),
    gs: document.querySelector('#pilot-gs'),
    slope: document.querySelector('#pilot-slope'),
    sun: document.querySelector('#pilot-sun'),
    relief: document.querySelector('#pilot-relief'),
};
const meshStatusElement = document.querySelector('#mars-mesh-status');
const globalMeshStatus = meshStatusElement.textContent;
const surfaceLightButton = document.querySelector('#surface-light');
const surfaceGridButton = document.querySelector('#surface-grid');

function setCameraMode(mode, label) {
    cameraMode = mode;
    cameraModeLabel = label;
    cameraModeElement.textContent = label;
    document.querySelectorAll('[data-camera-preset]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.cameraPreset === mode));
    });
}

function setAutoRotate(enabled) {
    const rotating = Boolean(enabled) && !reducedMotion.matches;
    controls.autoRotate = rotating;
    rotateToggle.checked = rotating;
    cameraSpinButton.setAttribute('aria-pressed', String(rotating));
    cameraSpinButton.setAttribute('aria-label', `${rotating ? 'Pause' : 'Resume'} automatic rotation`);
    cameraSpinButton.title = `${rotating ? 'Pause' : 'Resume'} automatic rotation (Space)`;
    cameraSpinButton.querySelector('.camera-icon').textContent = rotating ? 'Ⅱ' : '↻';
    cameraSpinButton.querySelector('.camera-btn-label').textContent = rotating ? 'Pause' : 'Spin';
}

function setCameraConstraints(surfaceFocus) {
    controls.minDistance = surfaceFocus ? 0.18 : 1.22;
    controls.maxDistance = surfaceFocus ? 3.2 : 7;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
}

/**
 * Depth range per mode.
 *
 * Surface mode gets a small `far` because the globe meshes are hidden there and
 * the 520 km patch plus the camera-locked sky dome are all that remain — which
 * is what lets `near` stay tight enough to keep the coincident terrain, grid,
 * trail, and marker layers from z-fighting.
 */
function applyCameraRange() {
    camera.near = surfaceModeActive ? SURFACE_NEAR : GLOBAL_NEAR;
    camera.far = surfaceModeActive ? SURFACE_FAR : GLOBAL_FAR;
    camera.updateProjectionMatrix();
    // The star sphere has to move with `far`, or it lands outside the frustum
    // in one of the two modes and the sky goes empty.
    starField.scale.setScalar(surfaceModeActive ? SURFACE_STAR_SCALE : GLOBAL_STAR_SCALE);
}

// Hidden while the surface explorer is up. The globe meshes are in here because
// the regional patch replaces them and their limb would otherwise cut across the
// horizon; keeping them out is also what allows the tight surface depth range.
//
// sky.group stays hidden ON PURPOSE. Its body markers are placed for the
// ephemeris observer site (the rover's route position); the explorer lets you
// walk 260 km away, where the local vertical has rotated ~4°, so those markers
// would be quietly wrong. The Sun still reaches this view honestly — the sky
// dome's glow is aimed by `sun.position`, which is the JPL Horizons direction.
const surfaceOccludedObjects = [
    gridLayer, atmosphereLayer, terminatorLayer, sky.group,
    routeLayer, waypointsLayer, roverLayer, landingLayer,
    reliefMars, smoothMars,
];
for (const group of Object.values(landmarks.categoryGroups)) surfaceOccludedObjects.push(group);
const surfaceVisibilityRestore = new Map();

function setSurfacePresentation(enabled) {
    if (enabled) {
        surfaceVisibilityRestore.clear();
        for (const object of surfaceOccludedObjects) {
            surfaceVisibilityRestore.set(object, object.visible);
            object.visible = false;
        }
    } else {
        for (const [object, visible] of surfaceVisibilityRestore) object.visible = visible;
        surfaceVisibilityRestore.clear();
    }
}

/**
 * Set a globe-mesh visibility that survives surface mode. While the explorer is
 * up the globe is force-hidden, so writing `.visible` directly would make it
 * reappear mid-scene and then get clobbered on exit — the pending value belongs
 * in the restore map instead.
 */
function setGlobeVisibility(wantRelief) {
    if (surfaceModeActive) {
        surfaceVisibilityRestore.set(reliefMars, wantRelief);
        surfaceVisibilityRestore.set(smoothMars, !wantRelief);
        return;
    }
    reliefMars.visible = wantRelief;
    smoothMars.visible = !wantRelief;
}

function localVectorLatLon(localVector) {
    const radial = localVector.clone().normalize();
    return {
        latDeg: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(radial.y, -1, 1))),
        lonDeg: THREE.MathUtils.radToDeg(Math.atan2(-radial.z, radial.x)),
    };
}

function worldVectorLatLon(worldVector) {
    const inverseRotation = marsGroup.quaternion.clone().invert();
    return localVectorLatLon(worldVector.clone().applyQuaternion(inverseRotation));
}

function worldSurfacePoint(latDeg, lonDeg, offset = SURFACE_PATCH_OFFSET) {
    return latLonVector(latDeg, lonDeg, anchorRadiusAtLatLon(latDeg, lonDeg, offset))
        .applyQuaternion(marsGroup.quaternion);
}

function greatCircleDistanceKm(a, b) {
    const latA = THREE.MathUtils.degToRad(a.latDeg);
    const latB = THREE.MathUtils.degToRad(b.latDeg);
    const deltaLat = latB - latA;
    const deltaLon = THREE.MathUtils.degToRad(b.lonDeg - a.lonDeg);
    const haversine = Math.sin(deltaLat / 2) ** 2
        + Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLon / 2) ** 2;
    return 2 * MARS_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function updateSurfaceTrail(location, { reset = false, reanchor = false } = {}) {
    if (reset) surfaceTrailLocations = [];
    // A re-anchor (relief scale changed under the trail) re-maps the stored
    // traverse onto the new radii WITHOUT recording a point — the true-scale
    // ramp is not a traverse event, and appending here put 12 phantom points
    // on the trail per zoom sweep.
    if (!reanchor) {
        surfaceTrailLocations.push({ latDeg: location.latDeg, lonDeg: location.lonDeg });
        if (surfaceTrailLocations.length > 180) surfaceTrailLocations.shift();
    }
    const points = surfaceTrailLocations.map(point => latLonVector(
        point.latDeg,
        point.lonDeg,
        anchorRadiusAtLatLon(point.latDeg, point.lonDeg, SURFACE_PATCH_OFFSET + 0.00012),
    ));
    surfaceTrail.geometry.dispose();
    surfaceTrail.geometry = new THREE.BufferGeometry().setFromPoints(points);
}

function formatCoordinate(value, positive, negative) {
    return `${Math.abs(value).toFixed(3)}°${value < 0 ? negative : positive}`;
}

// The readout writes four DOM properties and samples the MOLA raster twice.
// Doing that on every frame forces a style recalc per frame for a number that
// changes by metres — 8 Hz is past the point anyone can read it change.
const SURFACE_READOUT_INTERVAL_MS = 125;
let lastSurfaceReadoutAt = 0;

/**
 * ═══ PILOT CLUSTER ══════════════════════════════════════════════════════════
 * The instruments a landing needs that the science readouts don't carry:
 * heading, AGL, vertical speed, ground speed, TRUE slope under the target,
 * sun elevation, and the live relief multiplier. Updated on the same 8 Hz
 * cadence as the surface readout. Two honesty rules:
 *   - SLOPE is computed from the raw MOLA field at 1× — never from the drawn
 *     (exaggerated) geometry — because it exists to answer "could I land on
 *     that", colored by landability (<5° ok, <15° caution, else alert).
 *   - AGL is the distance to the DRAWN ground (what you'd hit); with the
 *     true-scale ramp the two meanings converge exactly where precision
 *     starts to matter.
 */
const pilot = {
    hdgDeg: null, aglKm: null, vsMs: 0, gsKms: 0,
    slopeDeg: null, slopeDownBearingDeg: null, sunElevDeg: null,
    samples: [],            // { t, latDeg, lonDeg, aglKm } sliding ~1.2 s window
    slopeAt: null,          // cache key for the 4-tap MOLA slope sample
};
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const cardinalFor = (deg) => CARDINALS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
const formatRate = (ms) => (Math.abs(ms) >= 1000
    ? `${(ms / 1000).toFixed(1)} km/s`
    : `${ms.toFixed(0)} m/s`);

/** TRUE ground slope from the MOLA field: 4 taps 1 km out, central diffs. */
function trueSlopeAt(latDeg, lonDeg) {
    const east = destinationLatLon(latDeg, lonDeg, 1, 0);
    const west = destinationLatLon(latDeg, lonDeg, -1, 0);
    const north = destinationLatLon(latDeg, lonDeg, 0, 1);
    const south = destinationLatLon(latDeg, lonDeg, 0, -1);
    const dEast = (elevationAtLatLon(east.latDeg, east.lonDeg) - elevationAtLatLon(west.latDeg, west.lonDeg)) / 2000;
    const dNorth = (elevationAtLatLon(north.latDeg, north.lonDeg) - elevationAtLatLon(south.latDeg, south.lonDeg)) / 2000;
    return {
        slopeDeg: Math.atan(Math.hypot(dEast, dNorth)) * 180 / Math.PI,
        // downhill bearing: opposite the gradient
        downBearingDeg: (Math.atan2(-dEast, -dNorth) * 180 / Math.PI + 360) % 360,
    };
}

function updatePilotCluster(target, altitudeKm, nowMs) {
    // Heading: camera forward projected on the target's tangent plane.
    const radial = controls.target.clone().normalize();
    const frame = tangentFrame(radial);
    const forward = controls.target.clone().sub(camera.position);
    forward.addScaledVector(radial, -forward.dot(radial));
    if (forward.lengthSq() > 1e-10) {
        forward.normalize();
        pilot.hdgDeg = (Math.atan2(forward.dot(frame.east), forward.dot(frame.north)) * 180 / Math.PI + 360) % 360;
    }
    pilot.aglKm = altitudeKm;

    // Ground speed + vertical speed over a ~1.2 s sliding window.
    pilot.samples.push({ t: nowMs, latDeg: target.latDeg, lonDeg: target.lonDeg, aglKm: altitudeKm });
    while (pilot.samples.length > 2 && nowMs - pilot.samples[0].t > 1200) pilot.samples.shift();
    const oldest = pilot.samples[0];
    const dt = (nowMs - oldest.t) / 1000;
    if (dt > 0.2) {
        pilot.gsKms = greatCircleDistanceKm(oldest, target) / dt;
        pilot.vsMs = (altitudeKm - oldest.aglKm) * 1000 / dt;
    }

    // True slope under the target, re-sampled when it moves > ~200 m.
    if (!pilot.slopeAt || greatCircleDistanceKm(pilot.slopeAt, target) > 0.2) {
        pilot.slopeAt = { latDeg: target.latDeg, lonDeg: target.lonDeg };
        const slope = hasRelief ? trueSlopeAt(target.latDeg, target.lonDeg) : { slopeDeg: 0, downBearingDeg: null };
        pilot.slopeDeg = slope.slopeDeg;
        pilot.slopeDownBearingDeg = slope.downBearingDeg;
    }

    pilot.sunElevDeg = Math.asin(THREE.MathUtils.clamp(
        sun.position.clone().normalize().dot(radial), -1, 1,
    )) * 180 / Math.PI;

    if (!pilotElements.hdg) return;
    pilotElements.hdg.textContent = pilot.hdgDeg == null
        ? '—'
        : `${String(Math.round(pilot.hdgDeg) % 360).padStart(3, '0')}° ${cardinalFor(pilot.hdgDeg)}`;
    pilotElements.agl.textContent = `${altitudeKm < 10 ? altitudeKm.toFixed(2) : altitudeKm.toFixed(1)} km`;
    pilotElements.agl.className = `pi-v${altitudeKm < 3 ? ' warn' : ''}`;
    pilotElements.vs.textContent = Math.abs(pilot.vsMs) < 1
        ? '0 m/s'
        : `${pilot.vsMs > 0 ? '↑' : '↓'} ${formatRate(Math.abs(pilot.vsMs))}`;
    pilotElements.gs.textContent = pilot.gsKms < 0.005 ? '—' : `${formatRate(pilot.gsKms * 1000)}`;
    if (pilot.slopeDeg == null || !hasRelief) {
        pilotElements.slope.textContent = '—';
        pilotElements.slope.className = 'pi-v';
    } else {
        const down = pilot.slopeDeg >= 0.3 && pilot.slopeDownBearingDeg != null
            ? ` ↓${cardinalFor(pilot.slopeDownBearingDeg)}`
            : '';
        pilotElements.slope.textContent = `${pilot.slopeDeg.toFixed(1)}°${down}`;
        pilotElements.slope.className = `pi-v ${pilot.slopeDeg < 5 ? 'ok' : pilot.slopeDeg < 15 ? 'warn' : 'alert'}`;
    }
    pilotElements.sun.textContent = `${pilot.sunElevDeg >= 0 ? '+' : '−'}${Math.abs(pilot.sunElevDeg).toFixed(0)}°`;
    pilotElements.sun.className = `pi-v${pilot.sunElevDeg < 5 ? ' warn' : ''}`;
    pilotElements.relief.textContent = regionalReliefScale === 1 ? '×1 TRUE' : `×${regionalReliefScale}`;
    pilotElements.relief.className = `pi-v${regionalReliefScale === 1 ? ' ok' : ''}`;
}

function updateSurfaceReadout({ force = false } = {}) {
    if (!surfaceModeActive || !surfaceLocation) return;
    const now = performance.now();
    if (!force && now - lastSurfaceReadoutAt < SURFACE_READOUT_INTERVAL_MS) return;
    lastSurfaceReadoutAt = now;
    const target = worldVectorLatLon(controls.target);
    surfaceLocation = target;
    const cameraLocation = worldVectorLatLon(camera.position);
    const surfaceRadius = anchorRadiusAtLatLon(cameraLocation.latDeg, cameraLocation.lonDeg);
    const altitudeKm = Math.max(0, (camera.position.length() - surfaceRadius) * MARS_RADIUS_KM);
    // MOLA elevation stays TRUE here. The patch is drawn exaggerated, but the
    // number a viewer reads off the HUD is the real areoid height — never
    // scale this to match what the geometry looks like.
    const elevationKm = elevationAtLatLon(target.latDeg, target.lonDeg) / 1000;
    surfaceLocationElement.textContent = `${formatCoordinate(target.latDeg, 'N', 'S')} · ${formatCoordinate(target.lonDeg, 'E', 'W')}`;
    surfaceAltitudeElement.textContent = `Eye ${altitudeKm.toFixed(1)} km · MOLA ${elevationKm >= 0 ? '+' : '−'}${Math.abs(elevationKm).toFixed(1)} km`;
    surfaceExplorer.dataset.lat = target.latDeg.toFixed(6);
    surfaceExplorer.dataset.lon = target.lonDeg.toFixed(6);
    surfaceExplorer.dataset.altitudeKm = altitudeKm.toFixed(3);
    updatePilotCluster(target, altitudeKm, now);
    updateLandingReticle();
}

function setSurfaceLight(enabled) {
    const active = Boolean(enabled) && surfaceModeActive;
    surfaceHeadlamp.visible = active;
    surfaceFillLight.visible = active;
    surfaceLightButton.setAttribute('aria-pressed', String(active));
    surfaceLightButton.title = `${active ? 'Disable' : 'Enable'} terrain analysis light`;
}

function setSurfaceGrid(enabled) {
    const active = Boolean(enabled) && surfaceModeActive;
    regionalTerrainGrid.visible = active;
    surfaceGridButton.setAttribute('aria-pressed', String(active));
    // Title tracks the spacing the geometry actually has — it was hard-coded to
    // "8 km" while the grid had been 16 km since the segment count last moved.
    const label = regionalGridSpacingKm > 0 ? `${regionalGridSpacingKm} km` : 'terrain';
    surfaceGridButton.title = `${active ? 'Hide' : 'Show'} ${label} analysis grid`;
}

function deactivateSurfaceExplorer() {
    if (!surfaceModeActive) return;
    surfaceModeActive = false;
    // Back to survey scale so the next entry starts at the documented 18×.
    regionalReliefScale = REGIONAL_RELIEF_EXAGGERATION;
    updateLandingReticle();
    app.classList.remove('is-surface-mode');
    surfaceExplorer.hidden = true;
    regionalTerrain.visible = false;
    skyDome.visible = false;
    setSurfaceGrid(false);
    surfaceTrail.visible = false;
    setSurfaceLight(false);
    setSurfacePresentation(false);
    scene.fog.color.setHex(0x080302);
    scene.fog.density = 0.025;
    camera.up.set(0, 1, 0);
    applyControlMode();
    // camera.up just went back to world +Y, which OrbitControls cannot pick up
    // without a rebuild — see the note on `let controls`.
    refreshControlFrame();
    applyCameraRange();
    // Surface mode swapped the globe's 5× relief for the patch's 18×; the
    // ground-anchored layers have to come back to the globe radius with it.
    refreshSurfaceAnchors();
    meshStatusElement.textContent = globalMeshStatus;
    cameraHelpElement.textContent = defaultInputHint();
}

/**
 * Surface HUD provenance line. Reports the patch's ACTUAL relief span, the
 * exaggeration applied to it, and the graticule spacing the geometry really
 * has — all three move with the quality ladder, so this is rebuilt rather than
 * written once at entry.
 */
function updateSurfaceDetail() {
    // The close-range regolith cascade is invented texture and says so —
    // appended to whichever provenance line is active.
    const regolithNote = QUALITY_LEVELS[qualityIndex].surfaceDetail > 0
        ? ' · close-range regolith + craters synthesized'
        : '';
    if (!hasRelief) {
        surfaceDetailElement.textContent = `MOLA unavailable · smooth regional geometry · Viking/material fallback${regolithNote}`;
        return;
    }
    // Both provenance tails are honest about the same thing: everything below
    // the MOLA sample spacing is synthesized. With the WFC layer on, the HUD
    // names the leading class so the viewer knows what the tint is claiming.
    let detailNote = 'sub-sample roughness is illustrative';
    if (synthEnabled && synthResult && synthShares) {
        const [topId, topShare] = Object.entries(synthShares).sort((a, b) => b[1] - a[1])[0];
        // shares are keyed by CLASS id — linear families have no tile named
        // after the class, so this lookup must go through classes.
        const topLabel = MARS_TILESET.classes.find(cls => cls.id === topId).label.toLowerCase();
        detailNote = `WFC geology synth ${Math.round(topShare * 100)}% ${topLabel} · synthesized below ${Math.round(REGIONAL_TERRAIN_EXTENT_KM / REGIONAL_SYNTH_CELLS)} km`;
    }
    // The multiplier is LIVE (true-scale-on-final ramp); at 1× say so loudly.
    const scaleNote = regionalReliefScale === 1 ? '1× TRUE SCALE' : `${regionalReliefScale}×`;
    surfaceDetailElement.textContent = `${REGIONAL_TERRAIN_EXTENT_KM} km MOLA patch · relief ${(regionalTerrainRelief.minElevationM / 1000).toFixed(1)} → ${(regionalTerrainRelief.maxElevationM / 1000).toFixed(1)} km at ${scaleNote} · ${regionalGridSpacingKm} km grid · ${detailNote}${regolithNote}`;
}

/**
 * Frame the surface explorer so the horizon is actually in the picture.
 *
 * The original framing put the camera 2 km up and 6 km back, pitched below the
 * horizon line with a 36° field of view — the horizon sat above the top of the
 * frame, so the canvas filled edge to edge with unbroken ground. Standing
 * higher and looking further ahead puts the horizon in the upper third and
 * gives the sky dome somewhere to be.
 */
/**
 * True-scale-on-final controller — called every frame in surface mode. Reads
 * the orbit range, quantizes it to a scale step, and rebuilds the patch ONLY
 * when the step changes. Skipped mid-tween: entry flights sweep the range
 * through the ramp bands and would fire rebuild hitches inside the animation.
 */
function updateReliefRamp() {
    if (!surfaceModeActive || !regionalTerrainCenter || cameraTween) return;
    const rangeKm = camera.position.distanceTo(controls.target) * MARS_RADIUS_KM;
    const next = reliefScaleForRange(rangeKm);
    if (next === regionalReliefScale) return;
    regionalReliefScale = next;
    const previousTarget = controls.target.clone();
    rebuildRegionalTerrain(regionalTerrainCenter.latDeg, regionalTerrainCenter.lonDeg);
    // Re-seat the orbit pivot onto the RE-SCALED ground and carry the camera
    // by the same shift, so range and clearance survive the step. Without
    // this, a scale-down at a below-datum site (Jezero draws at −2.6 km × 18)
    // RAISES the drawn ground tens of km toward the camera, the clearance
    // guard eats the margin, and the zoom stalls mid-ramp (measured: stuck
    // at ×8, never reaching true scale).
    const location = surfaceLocation || regionalTerrainCenter;
    const newTarget = worldSurfacePoint(location.latDeg, location.lonDeg);
    camera.position.add(newTarget.clone().sub(previousTarget));
    controls.target.copy(newTarget);
    // Every ground-anchored layer re-seats onto the new vertical scale; the
    // trail re-anchors WITHOUT reset (updateSurfaceTrail re-maps its stored
    // locations — wiping the traverse on every zoom step would be hostile).
    refreshSurfaceAnchors();
    if (surfaceLocation) updateSurfaceTrail(surfaceLocation, { reanchor: true });
    updateSurfaceDetail();
    meshStatusElement.textContent = hasRelief
        ? `regional MOLA · 66k vertices · ${regionalReliefScale}× relief${regionalReliefScale === 1 ? ' (true scale)' : ''}`
        : 'regional smooth-terrain fallback';
    updateSurfaceReadout({ force: true });
}

function surfaceCameraPlacement(latDeg, lonDeg, headingRad = 0) {
    const target = worldSurfacePoint(latDeg, lonDeg);
    const radial = target.clone().normalize();

    // CRITICAL: the eye is placed above the ground BENEATH THE EYE, not above
    // the target's ground. Offsetting from the target assumed a flat plane —
    // but the eye stands 55 km away, and at the patch's vertical exaggeration
    // a 2 km real elevation change between there and the target becomes tens of
    // km of drawn relief. The camera was landing inside the terrain, and
    // enforceSurfaceClearance() then shoved it radially to ~53 km altitude and
    // fought every subsequent drag for control.
    const eyeGround = destinationLatLon(
        latDeg, lonDeg,
        -Math.sin(headingRad) * SURFACE_LOOK_AHEAD_KM,
        -Math.cos(headingRad) * SURFACE_LOOK_AHEAD_KM,
    );
    const eyeRadius = regionalRadiusAtLatLon(eyeGround.latDeg, eyeGround.lonDeg)
        + SURFACE_EYE_ALTITUDE_KM / MARS_RADIUS_KM;
    const position = latLonVector(eyeGround.latDeg, eyeGround.lonDeg, eyeRadius)
        .applyQuaternion(marsGroup.quaternion);
    return { target, radial, position };
}

function enterSurfaceExplorer(latDeg, lonDeg, { label = 'Surface traverse', duration = 1050 } = {}) {
    setAutoRotate(false);
    if (surfaceModeActive) setSurfacePresentation(false);
    surfaceModeActive = true;
    surfaceLocation = { latDeg, lonDeg };
    // Fresh motion window: V/S and ground speed must not read the flight-in
    // tween (or a previous visit) as pilot motion.
    pilot.samples.length = 0;
    pilot.slopeAt = null;
    app.classList.add('is-surface-mode');
    surfaceExplorer.hidden = false;
    rebuildRegionalTerrain(latDeg, lonDeg);
    regionalTerrain.visible = true;
    skyDome.visible = true;
    setSurfaceGrid(true);
    surfaceTrail.visible = true;
    setSurfacePresentation(true);
    // Anchors re-seat onto the patch's exaggeration before the trail is laid.
    refreshSurfaceAnchors();
    updateSurfaceTrail(surfaceLocation, { reset: true });
    scene.fog.density = SURFACE_FOG_DENSITY;
    applyCameraRange();
    // Orbit limits for the ground camera: zoomToCursor off (on the ground it
    // drags the target off the terrain and into the sky), right-drag freed for
    // ground translation, and minPolarAngle 0 kept because straight overhead is
    // a useful map view — it is the OTHER end that had to be constrained.
    applyControlMode();
    const { target, radial, position } = surfaceCameraPlacement(latDeg, lonDeg);
    camera.up.copy(radial);
    // The local vertical is now the orbit axis, and OrbitControls only reads
    // camera.up at construction — without this rebuild every polar limit below
    // would be measured against the planet's spin axis instead.
    controls.target.copy(target);
    refreshControlFrame();
    setCameraMode('surface', label);
    cameraTween = {
        started: performance.now(), duration,
        fromPosition: camera.position.clone(), toPosition: position,
        fromTarget: controls.target.clone(), toTarget: target,
    };
    // The analysis lamp now defaults to whatever the terrain actually needs.
    // With emissive shading gone the sun does the lighting, so leaving the lamp
    // on in daylight just flattens the relief it exists to reveal — but past the
    // terminator it is the only thing that makes the ground readable at all.
    const sunElevationDeg = updateSurfaceSky(radial);
    setSurfaceLight(sunElevationDeg < 3);
    // Report the patch's ACTUAL relief span. It is the number that tells a
    // viewer whether the shape in front of them is a 3 km scarp or 200 m of
    // noise stretched by the exaggeration, and it costs nothing to be specific.
    updateSurfaceDetail();
    meshStatusElement.textContent = hasRelief
        ? `regional MOLA · 66k vertices · ${REGIONAL_RELIEF_EXAGGERATION}× relief`
        : 'regional smooth-terrain fallback';
    cameraHelpElement.textContent = defaultInputHint();
    updateSurfaceReadout({ force: true });
    canvas.focus({ preventScroll: true });
}

function enterSurfaceAtCurrentFocus() {
    const focus = lastSurfaceFocus || {
        latDeg: selectedRoutePoint.lat_deg,
        lonDeg: selectedRoutePoint.lon_deg,
        label: `Jezero · sol ${selectedRoutePoint.sol}`,
    };
    enterSurfaceExplorer(focus.latDeg, focus.lonDeg, { label: `Surface · ${focus.label}` });
}

/**
 * Walk the ground target across the terrain by a distance in KILOMETRES,
 * carrying the camera with it.
 *
 * The camera offset is parallel-transported by the same rotation that moves the
 * target, so heading and eye altitude survive the step — without that, walking
 * north slowly tips the horizon over as the local vertical rotates underneath.
 *
 * @param {number} forwardKm  along the current view heading
 * @param {number} rightKm    perpendicular, positive = right of the heading
 * @param {boolean} [trail]   append to the exploration trail (false while
 *                            right-dragging, which would otherwise scribble a
 *                            trail point per mouse-move event)
 */
function moveSurfaceBy(forwardKm, rightKm, { trail = true } = {}) {
    if (!surfaceModeActive) return;
    const distanceKm = Math.hypot(forwardKm, rightKm);
    if (distanceKm < 1e-6) return;
    cameraTween = null;
    const oldTarget = controls.target.clone();
    const radial = oldTarget.clone().normalize();
    let forward = controls.target.clone().sub(camera.position);
    forward.addScaledVector(radial, -forward.dot(radial));
    if (forward.lengthSq() < 1e-8) forward.copy(tangentFrame(radial).north);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, radial).normalize();
    const movement = forward.multiplyScalar(forwardKm).addScaledVector(right, rightKm);
    if (movement.lengthSq() < 1e-12) return;
    movement.normalize();
    const angle = distanceKm / MARS_RADIUS_KM;
    const newRadial = radial.clone().multiplyScalar(Math.cos(angle))
        .addScaledVector(movement, Math.sin(angle)).normalize();
    const location = worldVectorLatLon(newRadial);
    const newTarget = worldSurfacePoint(location.latDeg, location.lonDeg);
    const transport = new THREE.Quaternion().setFromUnitVectors(radial, newTarget.clone().normalize());
    const offset = camera.position.clone().sub(oldTarget).applyQuaternion(transport);
    controls.target.copy(newTarget);
    camera.position.copy(newTarget).add(offset);
    camera.up.copy(newTarget).normalize();
    // Walking across the terrain rotates the local vertical; once it has moved
    // far enough the orbit axis has to follow, or dragging starts working in a
    // frame the visitor left behind.
    refreshControlFrameIfDrifted();
    surfaceLocation = location;
    if (!regionalTerrainCenter
        || greatCircleDistanceKm(regionalTerrainCenter, location) > REGIONAL_TERRAIN_EXTENT_KM * 0.22) {
        rebuildRegionalTerrain(location.latDeg, location.lonDeg);
        updateSurfaceDetail();
    }
    if (trail) updateSurfaceTrail(location);
    updateSurfaceReadout({ force: true });
}

/** One discrete step, for the arrow buttons and WASD. */
function nudgeSurface(forwardAmount, rightAmount) {
    moveSurfaceBy(forwardAmount * SURFACE_STEP_KM, rightAmount * SURFACE_STEP_KM);
}

/**
 * Stop the surface camera from orbiting below its own horizon.
 *
 * THE BUG THIS FIXES: surface mode inherited maxPolarAngle = π, so one firm
 * upward drag swung the eye past the target's tangent plane and underground.
 * enforceSurfaceClearance() then caught it and snapped it back with
 * `setLength()` — but OrbitControls recomputes its orbit radius from the
 * camera position it did not author, so every frame of that fight shortened
 * the orbit (measured: 55.7 → 49.1 → 46.8 km) while the eye stayed pinned at
 * the 2.4 km floor. The view was stuck at ground level and could not recover.
 *
 * Constraining the polar angle means the clamp below almost never has to fire.
 * cos(maxPolar) = minEye / orbitRadius is exactly "the eye stays at least
 * SURFACE_MIN_EYE_KM above the target's tangent plane", so the limit opens up
 * as you pull back and tightens as you close in — which is also how it should
 * feel: hovering 4 km over a point, you cannot also be looking at it edge-on.
 */
function updateSurfacePolarLimit() {
    if (!surfaceModeActive) return;
    const orbitRadius = camera.position.distanceTo(controls.target);
    if (!(orbitRadius > 0)) return;
    const ratio = THREE.MathUtils.clamp(
        (SURFACE_MIN_EYE_KM / MARS_RADIUS_KM) / orbitRadius, 0, 1,
    );
    controls.maxPolarAngle = Math.acos(ratio);
}

/**
 * Backstop for terrain the tangent-plane limit above cannot know about: a ridge
 * between the eye and its target. Rare now, but a hill in the way is still a
 * hill in the way. SURFACE_NEAR is 0.0002 (≈ 0.7 km), so the floor also keeps
 * the near plane from clipping the ground away and showing the inside of the
 * patch.
 */
function enforceSurfaceClearance() {
    if (!surfaceModeActive) return;
    const location = worldVectorLatLon(camera.position);
    const minimumRadius = anchorRadiusAtLatLon(location.latDeg, location.lonDeg)
        + SURFACE_MIN_EYE_KM / MARS_RADIUS_KM;
    if (camera.position.length() < minimumRadius) camera.position.setLength(minimumRadius);
}

function flyCamera(position, target, { duration = 850, mode = 'custom', label = 'Free orbit', surfaceFocus = false } = {}) {
    if (mode !== 'surface') deactivateSurfaceExplorer();
    setAutoRotate(false);
    if (!(mode === 'surface' && surfaceModeActive)) setCameraConstraints(surfaceFocus);
    setCameraMode(mode, label);
    cameraTween = {
        started: performance.now(), duration,
        fromPosition: camera.position.clone(), toPosition: position.clone(),
        fromTarget: controls.target.clone(), toTarget: target.clone(),
    };
}

function focusSurfacePoint(latDeg, lonDeg, { mode = 'landmark', label = 'Surface focus', duration = 850 } = {}) {
    lastSurfaceFocus = { latDeg, lonDeg, label };
    const radial = latLonVector(latDeg, lonDeg).applyQuaternion(marsGroup.quaternion).normalize();
    const { north, east } = tangentFrame(radial);
    const position = radial.clone().multiplyScalar(1.22)
        .addScaledVector(north, 0.09)
        .addScaledVector(east, 0.1);
    flyCamera(position, radial.clone().multiplyScalar(0.995), { duration, mode, label, surfaceFocus: true });
}

function focusSelectedRover(duration = 850) {
    focusSurfacePoint(selectedRoutePoint.lat_deg, selectedRoutePoint.lon_deg, {
        mode: 'rover', label: `Rover · sol ${selectedRoutePoint.sol}`, duration,
    });
}

function focusLandingSite(duration = 850) {
    focusSurfacePoint(mission.landing_site.lat_deg, mission.landing_site.lon_deg, {
        mode: 'landing', label: 'Landing site', duration,
    });
}

function showGlobalView(duration = 850) {
    flyCamera(globalCameraPosition, new THREE.Vector3(), {
        duration, mode: 'global', label: 'Mission orbit', surfaceFocus: false,
    });
}

function focusSkyBody(key, { showDetails = true } = {}) {
    const direction = sky.getDirection(key);
    if (!direction) return;
    const input = document.querySelector(`[data-layer="sky-${key}"]`);
    if (input && !input.checked) {
        input.checked = true;
        sky.setBodyVisible(key, true);
    }
    const worldDirection = direction.applyQuaternion(marsGroup.quaternion).normalize();
    const record = sky.getBodyRecord(key);
    flyCamera(worldDirection.multiplyScalar(3.3), new THREE.Vector3(), {
        mode: 'sky', label: `${record?.name || key} sky`, surfaceFocus: false,
    });
    if (showDetails && record) showSkyBody(record, key);
}

function zoomCamera(factor) {
    cameraTween = null;
    setAutoRotate(false);
    const offset = camera.position.clone().sub(controls.target);
    const nextDistance = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
    const nextPosition = controls.target.clone().add(offset.normalize().multiplyScalar(nextDistance));
    flyCamera(nextPosition, controls.target.clone(), {
        duration: 280,
        mode: cameraMode,
        label: cameraModeLabel,
        surfaceFocus: controls.target.length() > 0.5,
    });
}

window.__marsUi?.registerLayerHandler(setLayer);
window.__marsUi?.registerCommands({
    'focus-rover': () => focusSelectedRover(),
    'global-view': () => showGlobalView(),
    'focus-landing': () => focusLandingSite(),
    'enter-surface': () => enterSurfaceAtCurrentFocus(),
    'zoom-out': () => zoomCamera(1.3),
    'zoom-in': () => zoomCamera(0.76),
    'toggle-spin': () => setAutoRotate(!controls.autoRotate),
    'surface-move': ({ dataset }) => nudgeSurface(
        Number(dataset.forward || 0),
        Number(dataset.right || 0),
    ),
    'toggle-surface-light': () => setSurfaceLight(!surfaceHeadlamp.visible),
    'toggle-surface-grid': () => setSurfaceGrid(!regionalTerrainGrid.visible),
    'sky-focus': ({ dataset }) => focusSkyBody(dataset.skyFocus),
});

/**
 * Hand the camera to the visitor.
 *
 * Called when an interaction is confirmed — a drag past the movement threshold,
 * or a wheel/zoom — NOT on bare pointerdown. OrbitControls' 'start' event fires
 * the instant a button goes down, so wiring this to it meant a single click to
 * inspect a landmark silently relabelled the camera "Free orbit" and stopped
 * the globe rotating. Selecting something is not taking the wheel.
 */
function beginManualCamera() {
    cameraTween = null;
    setAutoRotate(false);
    setCameraMode(
        surfaceModeActive ? 'surface' : 'custom',
        surfaceModeActive ? 'Surface traverse' : 'Free orbit',
    );
}

// Bound in createControls() so they survive a frame rebuild. Declarations, not
// consts: createControls() runs during module init, above this point.
function onControlsStart() {
    canvas.classList.add('is-interacting');
}
function onControlsEnd() {
    canvas.classList.remove('is-interacting');
    if (pointerStarts.size === 0 && canvas.dataset.inputState !== 'double-tap') setInputHint(defaultInputHint());
}

reducedMotion.addEventListener?.('change', event => {
    if (event.matches) setAutoRotate(false);
});

/**
 * Camera shortcuts, bound at DOCUMENT level.
 *
 * These used to be bound to the canvas, which meant they only fired while the
 * canvas itself held focus — so clicking any camera-dock button (which takes
 * focus, as buttons do) silently killed every shortcut the button's own tooltip
 * advertises. Pressing H after clicking "Rover" did nothing. Same for W/A/S/D
 * after using the on-screen surface arrows.
 *
 * Two guards keep a global binding from stealing legitimate input:
 *   - typing targets (the traverse-sol slider, any future input) are skipped
 *     entirely, so arrow keys still scrub the slider;
 *   - Space and Enter on a focused button/link belong to that control, not to
 *     the camera — otherwise Space would both press the button and toggle spin.
 */
function shortcutTargetIsBusy(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
    if ((event.key === ' ' || event.key === 'Enter') && target.closest('button, a, [role="button"]')) return true;
    return false;
}

document.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (shortcutTargetIsBusy(event)) return;
    const key = event.key.toLowerCase();
    if (surfaceModeActive && (key === 'w' || event.key === 'ArrowUp')) nudgeSurface(1, 0);
    else if (surfaceModeActive && (key === 's' || event.key === 'ArrowDown')) nudgeSurface(-1, 0);
    else if (surfaceModeActive && (key === 'a' || event.key === 'ArrowLeft')) nudgeSurface(0, -1);
    else if (surfaceModeActive && (key === 'd' || event.key === 'ArrowRight')) nudgeSurface(0, 1);
    else if (surfaceModeActive && event.key === 'Escape') showGlobalView();
    else if (key === 'h') showGlobalView();
    else if (key === 'r') focusSelectedRover();
    else if (key === 'l') focusLandingSite();
    else if (event.key === '+' || event.key === '=') zoomCamera(0.76);
    else if (event.key === '-' || event.key === '_') zoomCamera(1.3);
    else if (event.key === ' ') setAutoRotate(!controls.autoRotate);
    else return;
    event.preventDefault();
});

const landmarkCard = document.querySelector('#landmark-card');
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const pointerStarts = new Map();
// Movement past which a pointer gesture counts as a drag rather than a click.
const DRAG_THRESHOLD_PX = 7;

/**
 * Right-drag translation across the terrain, in surface mode only.
 *
 * RIGHT was mapped to ROTATE, i.e. an exact duplicate of LEFT, so the button
 * did nothing a user could notice while the context menu was suppressed anyway.
 * On the ground the missing verb is "move", and the on-screen arrows plus WASD
 * were the only way to do it.
 *
 * The pixel→kilometre scale is the true one for a perspective camera: the world
 * height spanned at the target distance is 2·d·tan(fov/2), so dragging a
 * feature keeps it roughly under the cursor rather than sliding at some
 * invented rate. Screen Y is inverted (down is +y in client coords, and
 * dragging down should pull the terrain toward you).
 */
function panSurfaceByPixels(deltaX, deltaY) {
    if (!surfaceModeActive || (deltaX === 0 && deltaY === 0)) return;
    const distance = camera.position.distanceTo(controls.target);
    const worldPerPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
        / Math.max(1, renderer.domElement.clientHeight);
    const scaleKm = worldPerPixel * MARS_RADIUS_KM;
    moveSurfaceBy(deltaY * scaleKm, -deltaX * scaleKm, { trail: false });
}
let lastTouchTap = null;
let inputHintTimer = null;

function defaultInputHint() {
    return surfaceModeActive
        ? 'Drag look · right-drag move · wheel altitude · WASD · Esc to orbit'
        : 'Drag orbit · wheel zoom · click a landmark · double-click to land';
}

function setInputHint(message, state = 'idle', resetDelay = 1400) {
    window.clearTimeout(inputHintTimer);
    cameraHelpElement.textContent = message;
    cameraHelpElement.dataset.active = String(state !== 'idle');
    canvas.dataset.inputState = state;
    if (resetDelay > 0) {
        inputHintTimer = window.setTimeout(() => {
            cameraHelpElement.textContent = defaultInputHint();
            cameraHelpElement.dataset.active = 'false';
            canvas.dataset.inputState = 'idle';
        }, resetDelay);
    }
}

function updatePointerDataset(pointerType = canvas.dataset.pointerType || 'none') {
    canvas.dataset.pointerType = pointerType;
    canvas.dataset.pointerCount = String(pointerStarts.size);
}

function setRaycastPointer(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = (clientX - rect.left) / rect.width * 2 - 1;
    pointer.y = -(clientY - rect.top) / rect.height * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
}

function showLandmark(landmark) {
    const category = MARS_LANDMARK_CATEGORIES[landmark.category];
    document.querySelector('#landmark-card-category').textContent = category.label;
    document.querySelector('#landmark-card-name').textContent = landmark.name;
    document.querySelector('#landmark-card-note').textContent = landmark.note;
    document.querySelector('#landmark-card-stats').textContent = `${landmark.diameterKm.toLocaleString(undefined, { maximumFractionDigits: 1 })} km · ${Math.abs(landmark.latDeg).toFixed(2)}°${landmark.latDeg < 0 ? 'S' : 'N'}, ${Math.abs(landmark.lonDeg).toFixed(2)}°${landmark.lonDeg < 0 ? 'W' : 'E'}`;
    document.querySelector('#landmark-card-source').href = landmark.source;
    document.querySelector('#landmark-card-source').textContent = 'USGS/IAU record ↗';
    const focusButton = document.querySelector('#landmark-card-focus');
    focusButton.textContent = 'Fly here';
    cardFocusAction = () => focusSurfacePoint(landmark.latDeg, landmark.lonDeg, { label: landmark.name });
    landmarkCard.hidden = false;
}

function showSkyBody(record, key) {
    document.querySelector('#landmark-card-category').textContent = 'JPL Horizons · Mars topocentric sky';
    document.querySelector('#landmark-card-name').textContent = record.name;
    document.querySelector('#landmark-card-note').textContent = `${record.above_horizon ? 'Above' : 'Below'} the airless local horizon at Perseverance's latest public route position. Apparent direction includes light-time and aberration corrections.`;
    document.querySelector('#landmark-card-stats').textContent = `Az ${record.azimuth_deg.toFixed(3)}° · El ${signedDegrees(record.elevation_deg)} · ${record.range_au.toFixed(6)} AU`;
    document.querySelector('#landmark-card-source').href = 'https://ssd-api.jpl.nasa.gov/doc/horizons.html';
    document.querySelector('#landmark-card-source').textContent = 'JPL Horizons method ↗';
    const focusButton = document.querySelector('#landmark-card-focus');
    focusButton.textContent = 'Center sky';
    cardFocusAction = () => focusSkyBody(key, { showDetails: false });
    landmarkCard.hidden = false;
}

function pickPointOfInterest(clientX, clientY) {
    setRaycastPointer(clientX, clientY);
    const skyHit = raycaster.intersectObjects(sky.hitTargets, false)
        .find(intersection => sky.isBodyVisible(intersection.object.userData.skyBodyKey));
    if (skyHit) {
        showSkyBody(sky.getBodyRecord(skyHit.object.userData.skyBodyKey), skyHit.object.userData.skyBodyKey);
        return true;
    }
    const hit = raycaster.intersectObjects(landmarks.hitTargets, false)
        .find(intersection => landmarks.isLandmarkVisible(intersection.object.userData.landmark));
    if (!hit) return false;
    showLandmark(hit.object.userData.landmark);
    return true;
}

function enterSurfaceAtClientPoint(clientX, clientY) {
    setRaycastPointer(clientX, clientY);
    const targets = surfaceModeActive ? [regionalTerrain, reliefMars, smoothMars] : [reliefMars, smoothMars];
    const globeHit = raycaster.intersectObjects(targets, false)[0];
    if (!globeHit) return false;
    const location = worldVectorLatLon(globeHit.point);
    lastSurfaceFocus = { ...location, label: 'Selected terrain' };
    enterSurfaceExplorer(location.latDeg, location.lonDeg, { label: 'Surface · selected terrain' });
    return true;
}

canvas.dataset.inputState = 'idle';
canvas.dataset.pointerType = 'none';
canvas.dataset.pointerCount = '0';
cameraHelpElement.dataset.active = 'false';

canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('wheel', () => {
    // Wheel IS taking the wheel — unlike a bare click, it always means the
    // visitor wants the camera.
    beginManualCamera();
    setInputHint(
        surfaceModeActive ? 'Wheel adjusts eye altitude' : 'Wheel zooms toward the cursor',
        'wheel',
    );
}, { passive: true });

// ── Hover ───────────────────────────────────────────────────────────────────
// Every landmark, sky body, and marker on this page is clickable, and none of
// them looked it: the cursor stayed `grab` everywhere and nothing highlighted,
// so the atlas read as decoration. Raycasting on move fixes the affordance.
// Throttled and skipped entirely while dragging — 23 hit targets is cheap, but
// not at 60 Hz on a software rasteriser that is already the bottleneck.
const HOVER_INTERVAL_MS = 70;
let lastHoverAt = 0;
let hoveredLabel = null;

function clearHover() {
    const changed = landmarks.setHighlight(null) || sky.setHighlight(null);
    if (hoveredLabel !== null) {
        hoveredLabel = null;
        canvas.dataset.hover = 'none';
        setInputHint(defaultInputHint());
    }
    return changed;
}

function updateHover(clientX, clientY) {
    const now = performance.now();
    if (now - lastHoverAt < HOVER_INTERVAL_MS) return;
    lastHoverAt = now;
    setRaycastPointer(clientX, clientY);

    const skyHit = raycaster.intersectObjects(sky.hitTargets, false)
        .find(intersection => sky.isBodyVisible(intersection.object.userData.skyBodyKey));
    if (skyHit) {
        const key = skyHit.object.userData.skyBodyKey;
        landmarks.setHighlight(null);
        sky.setHighlight(key);
        const name = sky.getBodyRecord(key)?.name || key;
        if (hoveredLabel !== name) {
            hoveredLabel = name;
            canvas.dataset.hover = 'pick';
            setInputHint(`${name} · click for its Mars-sky position`, 'hover', 0);
        }
        return;
    }

    const hit = raycaster.intersectObjects(landmarks.hitTargets, false)
        .find(intersection => landmarks.isLandmarkVisible(intersection.object.userData.landmark));
    if (hit) {
        const landmark = hit.object.userData.landmark;
        sky.setHighlight(null);
        landmarks.setHighlight(landmark);
        if (hoveredLabel !== landmark.name) {
            hoveredLabel = landmark.name;
            canvas.dataset.hover = 'pick';
            setInputHint(`${landmark.name} · click for details`, 'hover', 0);
        }
        return;
    }
    clearHover();
}

canvas.addEventListener('pointerdown', event => {
    const record = {
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        pointerType: event.pointerType || 'mouse',
        button: event.button,
        moved: false,
        multiTouch: false,
        // Right-drag on the ground translates the view instead of duplicating
        // left-drag's rotation (see surfacePanEnabled below).
        panning: event.button === 2 && surfaceModeActive && event.pointerType !== 'touch',
    };
    pointerStarts.set(event.pointerId, record);
    if (record.panning) canvas.setPointerCapture?.(event.pointerId);
    if (record.pointerType === 'touch') {
        const touchRecords = [...pointerStarts.values()].filter(item => item.pointerType === 'touch');
        if (touchRecords.length > 1) touchRecords.forEach(item => { item.multiTouch = true; });
        setInputHint(
            touchRecords.length > 1 ? 'Pinch zoom · twist orbit' : (surfaceModeActive ? 'One-finger surface look' : 'One-finger orbit'),
            touchRecords.length > 1 ? 'pinch' : 'touch-drag',
            0,
        );
    } else if (record.panning) {
        setInputHint('Right-drag moves across the terrain', 'mouse-pan', 0);
    } else {
        setInputHint(event.button === 1 ? 'Middle-drag zoom' : (surfaceModeActive ? 'Drag to look around' : 'Drag to orbit'), 'mouse-drag', 0);
    }
    updatePointerDataset(record.pointerType);
});

canvas.addEventListener('pointermove', event => {
    const record = pointerStarts.get(event.pointerId);
    if (!record) {
        // No button down: this is a hover, not a drag.
        if (pointerStarts.size === 0 && event.pointerType !== 'touch') updateHover(event.clientX, event.clientY);
        return;
    }
    const travelled = Math.hypot(event.clientX - record.x, event.clientY - record.y);
    if (!record.moved && travelled > DRAG_THRESHOLD_PX) {
        record.moved = true;
        // Only NOW is this a camera interaction. A click that never moves stays
        // a selection and leaves the camera mode and auto-rotate alone.
        if (!record.panning) beginManualCamera();
        clearHover();
    }
    if (record.panning && record.moved) {
        panSurfaceByPixels(event.clientX - record.lastX, event.clientY - record.lastY);
    }
    record.lastX = event.clientX;
    record.lastY = event.clientY;
});

canvas.addEventListener('pointerleave', () => { if (pointerStarts.size === 0) clearHover(); });
canvas.addEventListener('pointercancel', event => {
    pointerStarts.delete(event.pointerId);
    updatePointerDataset(event.pointerType || 'touch');
    if (pointerStarts.size === 0) setInputHint(defaultInputHint());
});
canvas.addEventListener('pointerup', event => {
    const start = pointerStarts.get(event.pointerId);
    pointerStarts.delete(event.pointerId);
    if (start?.panning) canvas.releasePointerCapture?.(event.pointerId);
    updatePointerDataset(event.pointerType || start?.pointerType || 'mouse');
    if (!start || start.moved || start.multiTouch
        || Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_THRESHOLD_PX) {
        if (pointerStarts.size === 0) setInputHint(defaultInputHint());
        return;
    }

    if (start.pointerType === 'touch') {
        const now = performance.now();
        const isDoubleTap = lastTouchTap
            && now - lastTouchTap.time < 360
            && Math.hypot(event.clientX - lastTouchTap.x, event.clientY - lastTouchTap.y) < 28;
        if (isDoubleTap) {
            lastTouchTap = null;
            if (enterSurfaceAtClientPoint(event.clientX, event.clientY)) {
                event.preventDefault();
                setInputHint('Surface target acquired', 'double-tap');
                return;
            }
        } else {
            lastTouchTap = { time: now, x: event.clientX, y: event.clientY };
        }
    }

    if (start.pointerType === 'touch' || start.button === 0) {
        // A click that hits nothing dismisses the detail card. Previously the
        // only way to close it was the × — clicking away, which every card-like
        // UI treats as dismissal, did nothing.
        if (!pickPointOfInterest(event.clientX, event.clientY)) landmarkCard.hidden = true;
    }
    setInputHint(defaultInputHint());
});
canvas.addEventListener('dblclick', event => {
    event.preventDefault();
    if (enterSurfaceAtClientPoint(event.clientX, event.clientY)) setInputHint('Surface target acquired', 'double-click');
});
window.__marsUi?.registerCommands({
    'close-landmark-card': () => { landmarkCard.hidden = true; },
    'focus-landmark-card': () => cardFocusAction?.(),
});

function updateCameraTween(now) {
    if (!cameraTween) return;
    const raw = Math.min(1, (now - cameraTween.started) / cameraTween.duration);
    const eased = raw < 0.5 ? 4 * raw ** 3 : 1 - Math.pow(-2 * raw + 2, 3) / 2;
    camera.position.lerpVectors(cameraTween.fromPosition, cameraTween.toPosition, eased);
    controls.target.lerpVectors(cameraTween.fromTarget, cameraTween.toTarget, eased);
    if (raw >= 1) {
        camera.position.copy(cameraTween.toPosition);
        controls.target.copy(cameraTween.toTarget);
        cameraTween = null;
    }
}

let displayedCameraRange = '';
function updateCameraReadout() {
    const rangeKm = camera.position.distanceTo(controls.target) * MARS_RADIUS_M / 1000;
    const formatted = `${Math.round(rangeKm).toLocaleString()} km`;
    if (formatted === displayedCameraRange) return;
    displayedCameraRange = formatted;
    cameraRangeElement.value = `Range ${formatted}`;
    cameraRangeElement.textContent = `Range ${formatted}`;
    cameraRangeElement.dataset.rangeKm = String(Math.round(rangeKm));
}

const markerWorldPosition = new THREE.Vector3();
function updateSurfaceMarkerScale(marker) {
    marker.getWorldPosition(markerWorldPosition);
    const distance = camera.position.distanceTo(markerWorldPosition);
    marker.scale.setScalar(THREE.MathUtils.clamp(distance / 2.25, 0.18, 1));
}

function resize() {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(viewport);
window.addEventListener('resize', resize, { passive: true });
resize();

// ── Adaptive quality ────────────────────────────────────────────────────────
// An unusable framerate reads to a visitor as a broken canvas, not a slow one,
// so the render budget is measured rather than assumed. Steps are hysteretic:
// downgrade needs a sustained bad median, upgrade needs a sustained good one,
// and the ladder never climbs above the device's own pixel-ratio cap.
const frameSamples = [];
let qualityCooldownUntil = 0;

function applyQuality(index) {
    const next = THREE.MathUtils.clamp(index, 0, QUALITY_LEVELS.length - 1);
    if (next === qualityIndex) return;
    const previousSegments = QUALITY_LEVELS[qualityIndex].terrainSegments;
    qualityIndex = next;
    const level = QUALITY_LEVELS[qualityIndex];
    renderer.setPixelRatio(Math.min(maxPixelRatio, level.pixelRatio * maxPixelRatio));
    resize();
    // The regional patch is built at the quality level's segment count, so a
    // step up or down has to rebuild it — otherwise the ladder's biggest lever
    // (4× fewer triangles) does nothing until the visitor happens to move.
    if (surfaceModeActive && regionalTerrainCenter && level.terrainSegments !== previousSegments) {
        rebuildRegionalTerrain(regionalTerrainCenter.latDeg, regionalTerrainCenter.lonDeg);
        updateSurfaceDetail();
    }
    // The additive limb shell is a full-screen overdraw pass for a decorative
    // glow — the first thing worth losing, and the last thing worth keeping.
    atmosphereLayer.visible = level.atmosphere
        && Boolean(document.querySelector('[data-layer="atmosphere"]')?.checked);
    // Close-range regolith cascade rides the ladder too: it costs noise
    // evaluations per fragment, which is exactly what a software rasteriser
    // cannot afford. 0 branches the whole cascade out of the shader path.
    detailUniforms.uDetailStrength.value = level.surfaceDetail;
    // The globe's bump term costs a dFdx/dFdy pair per fragment across the whole
    // disc. Unlike the regional patch's (which was perturbing detail finer than
    // one texel and is gone for good), this one earns its keep at full quality —
    // the 1440×720 MOLA raster genuinely textures a whole-planet view.
    const wantBump = level.globeBump && Boolean(molaTexture);
    if (Boolean(surfaceMaterial.bumpMap) !== wantBump) {
        surfaceMaterial.bumpMap = wantBump ? molaTexture : null;
        surfaceMaterial.bumpScale = wantBump ? 0.0024 : 0;
        surfaceMaterial.needsUpdate = true;
    }
    if (starField.geometry.attributes.position.count !== level.starCount) {
        scene.remove(starField);
        starField.geometry.dispose();
        starField.material.dispose();
        starField = buildStars(level.starCount);
        scene.add(starField);
    }
    app.dataset.renderQuality = level.name;
}

let qualityWindowStart = 0;

// Test/QA affordance: __marsLab.setQuality(i, { lock: true }) pins a rung so
// visual verification of quality-gated features (the regolith cascade) is
// possible on machines the ladder would immediately downgrade.
let qualityLocked = false;

function sampleFrame(frameMs) {
    if (qualityLocked) return;
    // Ignore any single stall (a terrain rebuild, a tab regaining focus) —
    // those are not the steady state the ladder is trying to measure.
    if (frameMs > 500) return;
    const now = performance.now();
    if (!qualityWindowStart) qualityWindowStart = now;
    frameSamples.push(frameMs);
    // CRITICAL: close the window on ELAPSED TIME, not sample count. A pure
    // count of 45 frames is ~0.75 s on a healthy machine but 30 s at 1.5 fps —
    // so the slower the canvas, the longer the visitor waits for the fix. Time
    // bounds it: the worse it renders, the fewer samples the decision needs.
    const elapsed = now - qualityWindowStart;
    if (frameSamples.length < 8 || (elapsed < 900 && frameSamples.length < 45)) return;
    const median = frameSamples.slice().sort((a, b) => a - b)[Math.floor(frameSamples.length / 2)];
    frameSamples.length = 0;
    qualityWindowStart = 0;
    if (now < qualityCooldownUntil) return;
    if (median > 42 && qualityIndex < QUALITY_LEVELS.length - 1) {
        // A catastrophic frame time skips a rung. Walking down one step at a
        // time from 600 ms/frame would take longer than anyone will wait.
        const steps = median > 160 ? 2 : 1;
        applyQuality(qualityIndex + steps);
        qualityCooldownUntil = now + 2500;
    } else if (median < 19 && qualityIndex > 0) {
        applyQuality(qualityIndex - 1);
        qualityCooldownUntil = now + 8000;
    }
}

setCameraMode('global', 'Mission orbit');
applyCameraRange();
// Level 0 is what the renderer, materials, and star field were constructed
// with; publish it so the attribute is never absent before the first step.
app.dataset.renderQuality = QUALITY_LEVELS[qualityIndex].name;
setAutoRotate(!reducedMotion.matches);
updateCameraReadout();

applyMissionUi(mission);
applyBundledWeather({}, 'Checking the shared adapter');
updateMarsClock();
updateIllumination();
window.setInterval(updateMarsClock, 1000);
window.setInterval(() => {
    sky.updateTime();
    updateIllumination();
}, 15_000);
loadMarsFeed();
loadTraverseHistory();
loadMarsEphemeris();
loadMarsSky();
scheduleMarsSkyRefresh();
// The sub-solar longitude moves ~15°/hr with Mars' rotation; the edge cache is
// 15 minutes, so refreshing on that period keeps the terminator within a few
// degrees without ever reaching past the cache to JPL.
window.setInterval(loadMarsEphemeris, 15 * 60_000);
// MMGIS publishes at most one localization per sol. Hourly is generous and
// still catches a new drive the same afternoon it lands.
window.setInterval(loadTraverseHistory, 60 * 60_000);

loaderStatus.textContent = hasRelief ? 'MOLA relief ready · locating Perseverance…' : 'Smooth globe ready · MOLA relief unavailable';
window.__marsReady = true;
window.__marsLab = Object.freeze({
    camera,
    // Getter, not a value: refreshControlFrame() replaces the instance whenever
    // the local vertical changes, and a captured reference would go stale.
    get controls() { return controls; },
    layerIsVisible,
    enterSurfaceExplorer,
    nudgeSurface,
    cameraState: () => ({
        mode: cameraMode,
        label: cameraModeLabel,
        rangeKm: camera.position.distanceTo(controls.target) * MARS_RADIUS_M / 1000,
    }),
    inputState: () => ({
        zoomToCursor: controls.zoomToCursor,
        mouse: {
            primary: 'rotate',
            middle: 'dolly',
            // Right-drag translates the ground in surface mode; on the globe
            // there is nothing to translate, so it stays a second rotate.
            secondary: surfaceModeActive ? 'pan-surface' : 'rotate',
        },
        touch: { oneFinger: 'rotate', twoFinger: 'dolly-rotate', doubleTap: 'surface-target' },
        activePointers: pointerStarts.size,
        pointerType: canvas.dataset.pointerType,
        state: canvas.dataset.inputState,
        dragThresholdPx: DRAG_THRESHOLD_PX,
    }),
    /** What the pointer is currently over, and how the canvas advertises it. */
    hoverState: () => ({
        label: hoveredLabel,
        cursor: canvas.dataset.hover || 'none',
        landmark: landmarks.highlighted?.name || null,
        skyBody: sky.highlighted || null,
    }),
    /** Surface camera limits — the constraint that stops it burrowing. */
    surfaceLimits: () => ({
        minDistanceKm: controls.minDistance * MARS_RADIUS_KM,
        maxDistanceKm: controls.maxDistance * MARS_RADIUS_KM,
        maxPolarDeg: THREE.MathUtils.radToDeg(controls.maxPolarAngle),
        orbitRadiusKm: camera.position.distanceTo(controls.target) * MARS_RADIUS_KM,
    }),
    surfaceState: () => ({
        active: surfaceModeActive,
        location: surfaceLocation ? { ...surfaceLocation } : null,
        terrainVertices: regionalTerrain.geometry.attributes.position?.count || 0,
        terrainSegments: QUALITY_LEVELS[qualityIndex].terrainSegments,
        gridSpacingKm: regionalGridSpacingKm,
        trailPoints: surfaceTrailLocations.length,
        gridVisible: regionalTerrainGrid.visible,
        analysisLightVisible: surfaceHeadlamp.visible,
        skyVisible: skyDome.visible,
        skyOpacity: skyDomeMaterial.uniforms.uOpacity.value,
        reliefExaggeration: REGIONAL_RELIEF_EXAGGERATION,
        reliefScaleNow: regionalReliefScale,
        patchRelief: { ...regionalTerrainRelief },
        hasRelief,
        synth: {
            enabled: synthEnabled,
            active: Boolean(synthEnabled && synthResult),
            cells: REGIONAL_SYNTH_CELLS,
            restarts: synthResult?.restarts ?? null,
            shares: synthShares ? { ...synthShares } : null,
        },
    }),
    /** Pin a quality rung (lock stops the ladder re-adjusting). QA/tests only. */
    setQuality: (index, { lock = false } = {}) => {
        qualityLocked = Boolean(lock);
        applyQuality(index);
    },
    /** Landing instruments + reticle — see the PILOT CLUSTER block. */
    pilotState: () => ({
        hdgDeg: pilot.hdgDeg,
        aglKm: pilot.aglKm,
        vsMs: pilot.vsMs,
        gsKms: pilot.gsKms,
        slopeDeg: pilot.slopeDeg,
        slopeDownBearingDeg: pilot.slopeDownBearingDeg,
        sunElevDeg: pilot.sunElevDeg,
        reliefScaleNow: regionalReliefScale,
        reticle: reticleAt ? { ...reticleAt, radiusKm: RETICLE_RADIUS_KM, visible: landingReticle.visible } : null,
    }),
    /** Solar geometry, so a test can ask whether the focused point is in daylight. */
    sunState: () => {
        const sunDirection = sun.position.clone().normalize();
        const targetRadial = controls.target.clone().normalize();
        return {
            source: marsFeedState.illumination,
            elevationAtTargetDeg: THREE.MathUtils.radToDeg(
                Math.asin(THREE.MathUtils.clamp(sunDirection.dot(targetRadial), -1, 1)),
            ),
            subSolar: worldVectorLatLon(sunDirection),
        };
    },
    renderState: () => ({
        quality: QUALITY_LEVELS[qualityIndex].name,
        pixelRatio: renderer.getPixelRatio(),
        near: camera.near,
        far: camera.far,
        // Depth ratio is the number that used to be 5,000,000:1 and made every
        // coincident surface layer flicker. If a change pushes it back past
        // ~1e5, the surface layers will z-fight again.
        depthRatio: camera.far / camera.near,
        starsFollowCamera: starField.position.distanceTo(camera.position) < 1e-6,
        atmosphere: atmosphereLayer.visible,
        surfaceDetail: detailUniforms.uDetailStrength.value,
    }),
    /** Ground-anchor audit: how far each surface layer floats above the terrain. */
    anchorState: () => {
        const groundRadius = anchorRadiusAtLatLon(selectedRoutePoint.lat_deg, selectedRoutePoint.lon_deg);
        const routePositions = routeLine.geometry.attributes.position;
        return {
            groundRadius,
            markerAltitudeKm: (routeCursor.position.length() - groundRadius) * MARS_RADIUS_KM,
            routeAltitudeKm: routePositions
                ? (new THREE.Vector3().fromBufferAttribute(routePositions, routePositions.count - 1).length()
                    - anchorRadiusAtLatLon(
                        routeSnapshot?.points?.at(-1)?.lat_deg ?? selectedRoutePoint.lat_deg,
                        routeSnapshot?.points?.at(-1)?.lon_deg ?? selectedRoutePoint.lon_deg,
                    )) * MARS_RADIUS_KM
                : null,
        };
    },
    feedState: () => ({ ...marsFeedState }),
});
window.__marsUi?.setEngineState('ready');
window.clearTimeout(window.__marsBootTimer);
document.querySelector('#mars-render-fallback').hidden = true;
app.classList.remove('mars-render-degraded');
window.setTimeout(() => loadingScreen.classList.add('done'), 250);

const clock = new THREE.Clock();
const cameraRadial = new THREE.Vector3();
let lastFrameAt = 0;

/**
 * The graticule is a global reference frame, and at close range it stops being
 * one: 30° meridians resolve into a couple of unexplained lines sweeping the
 * frame. Fade it out as the camera closes so it reads at the scale where it
 * means something and gets out of the way at the scale where it does not.
 */
function updateGridFade(cameraDistance) {
    const target = THREE.MathUtils.smoothstep(cameraDistance, 1.24, 1.95) * 0.16;
    if (Math.abs(gridMaterial.opacity - target) > 0.002) gridMaterial.opacity = target;
}

function animate(now) {
    requestAnimationFrame(animate);
    if (lastFrameAt) sampleFrame(now - lastFrameAt);
    lastFrameAt = now;
    const elapsed = clock.getElapsedTime();
    updateCameraTween(now);
    roverLayer.userData.ring.scale.setScalar(1 + Math.sin(elapsed * 2.7) * 0.14);
    roverLayer.userData.ring.material.opacity = 0.56 + Math.sin(elapsed * 2.7) * 0.16;
    routeCursor.userData.ring.scale.setScalar(1 + Math.sin(elapsed * 3.1) * 0.18);
    routeCursor.userData.ring.material.opacity = 0.58 + Math.sin(elapsed * 3.1) * 0.16;
    updateSurfaceMarkerScale(roverLayer);
    updateSurfaceMarkerScale(landingLayer);
    updateSurfaceMarkerScale(routeCursor);
    landmarks.update(camera);
    sky.updateCamera(camera);
    if (!cameraTween) {
        // Must run BEFORE update() — OrbitControls applies the polar limits
        // inside update(), so setting them afterwards is a frame too late.
        updateSurfacePolarLimit();
        controls.update();
    }
    enforceSurfaceClearance();
    // Stars are at infinity, so the field rides with the camera. This is also
    // what keeps `far` small enough for a usable depth buffer in both modes.
    starField.position.copy(camera.position);
    if (surfaceModeActive) {
        cameraRadial.copy(camera.position).normalize();
        surfaceHeadlamp.position.copy(camera.position);
        surfaceHeadlamp.target.position.copy(controls.target);
        surfaceHeadlamp.target.updateMatrixWorld();
        surfaceFillLight.position.copy(camera.position).addScaledVector(cameraRadial, -0.0001);
        skyDome.position.copy(camera.position);
        updateSurfaceSky(cameraRadial);
        // The detail cascade's lit-relief term shades against the live sun.
        detailUniforms.uSunDirWorld.value.copy(sun.position).normalize();
        updateReliefRamp();
        updateSurfaceReadout();
    } else {
        updateGridFade(camera.position.length());
    }
    updateCameraReadout();
    renderer.render(scene, camera);
}
requestAnimationFrame(animate);
