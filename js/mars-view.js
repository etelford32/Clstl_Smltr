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
} from './mars-mission-state.js?v=20260806-camera2';
import { MarsLandmarks } from './mars-landmarks.js?v=20260806-camera2';
import { MARS_LANDMARK_CATEGORIES } from './mars-landmarks-data.js';
import { fetchMarsSkyEphemeris } from './horizons.js';
import { MarsSky } from './mars-sky.js';

const SURFACE_RADIUS = 1;
const RELIEF_EXAGGERATION = 5;
const MOLA_MIN_M = -8068;
const MOLA_MAX_M = 21134;
const MARS_RADIUS_KM = MARS_RADIUS_M / 1000;
const REGIONAL_TERRAIN_EXTENT_KM = 520;
const REGIONAL_TERRAIN_SEGMENTS = 256;
const SURFACE_STEP_KM = 4;
const SURFACE_CLEARANCE_KM = 0.25;
const SURFACE_PATCH_OFFSET = 0.00012;
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.matchMedia('(max-width: 560px)').matches ? 1.5 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    window.__marsReady = false;
    window.__marsRevealFallback?.('The browser lost the WebGL context. Mission and provenance panels remain usable.');
}, { once: true });

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 1.22;
controls.maxDistance = 7;
controls.enablePan = false;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.75;
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
controls.autoRotate = !reducedMotion.matches;
controls.autoRotateSpeed = 0.34;
let cameraMode = 'global';
let cameraModeLabel = 'Mission orbit';
let cameraTween = null;
let cardFocusAction = null;
let surfaceModeActive = false;
let surfaceLocation = null;
let regionalTerrainCenter = null;
let lastSurfaceFocus = null;

scene.add(new THREE.HemisphereLight(0xffd1b1, 0x080304, 0.58));
const sun = new THREE.DirectionalLight(0xffead5, 3.2);
scene.add(sun);
const rim = new THREE.DirectionalLight(0xff6837, 0.38);
rim.position.set(4, -1.5, -3);
scene.add(rim);

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

function buildStars() {
    const count = 1700;
    const positions = new Float32Array(count * 3);
    const random = mulberry32(20260805);
    for (let i = 0; i < count; i += 1) {
        const z = random() * 2 - 1;
        const theta = random() * Math.PI * 2;
        const r = 15 + random() * 25;
        const xy = Math.sqrt(1 - z * z);
        positions[i * 3] = Math.cos(theta) * xy * r;
        positions[i * 3 + 1] = z * r;
        positions[i * 3 + 2] = Math.sin(theta) * xy * r;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(geometry, new THREE.PointsMaterial({
        color: 0xffe5d6,
        size: 0.025,
        transparent: true,
        opacity: 0.65,
        sizeAttenuation: true,
        depthWrite: false,
    }));
}

function mulberry32(seed) {
    return () => {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

scene.add(buildStars());

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

function reliefRadiusAtLatLon(latDeg, lonDeg, offset = 0) {
    const reliefEnabled = typeof hasRelief === 'boolean'
        && hasRelief
        && document.querySelector('#relief-toggle')?.checked;
    const exaggeration = reliefEnabled ? RELIEF_EXAGGERATION : 0;
    return SURFACE_RADIUS + elevationAtLatLon(latDeg, lonDeg) / MARS_RADIUS_M * exaggeration + offset;
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

const regionalTerrainMaterial = new THREE.MeshStandardMaterial({
    color: surfaceTexture ? 0xffffff : 0x9d3d22,
    map: surfaceTexture,
    bumpMap: molaTexture,
    bumpScale: molaTexture ? 0.00032 : 0,
    emissive: 0x6a2e1a,
    emissiveMap: surfaceTexture,
    emissiveIntensity: 1.25,
    roughness: 0.98,
    metalness: 0,
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
});
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

function visualRegionalRoughnessKm(eastKm, northKm) {
    const edge = Math.max(Math.abs(eastKm), Math.abs(northKm)) / (REGIONAL_TERRAIN_EXTENT_KM * 0.5);
    const fade = 1 - THREE.MathUtils.smoothstep(edge, 0.72, 1);
    const broad = Math.sin(eastKm * 0.038 + 1.7) * Math.cos(northKm * 0.031 - 0.8) * 0.11;
    const medium = Math.sin(eastKm * 0.105 - northKm * 0.062) * 0.045;
    const fine = Math.sin(eastKm * 0.24 + northKm * 0.19 + 2.1) * 0.018;
    return (broad + medium + fine) * fade;
}

function rebuildRegionalTerrain(latDeg, lonDeg) {
    const segments = REGIONAL_TERRAIN_SEGMENTS;
    const rowLength = segments + 1;
    const positions = new Float32Array(rowLength * rowLength * 3);
    const uvs = new Float32Array(rowLength * rowLength * 2);
    const colors = new Float32Array(rowLength * rowLength * 3);
    const indices = new Uint32Array(segments * segments * 6);
    let vertexOffset = 0;
    for (let northIndex = 0; northIndex <= segments; northIndex += 1) {
        const northKm = (northIndex / segments - 0.5) * REGIONAL_TERRAIN_EXTENT_KM;
        for (let eastIndex = 0; eastIndex <= segments; eastIndex += 1) {
            const eastKm = (eastIndex / segments - 0.5) * REGIONAL_TERRAIN_EXTENT_KM;
            const location = destinationLatLon(latDeg, lonDeg, eastKm, northKm);
            const visualRoughnessKm = visualRegionalRoughnessKm(eastKm, northKm);
            const visualRoughness = visualRoughnessKm / MARS_RADIUS_KM;
            const radius = reliefRadiusAtLatLon(
                location.latDeg,
                location.lonDeg,
                SURFACE_PATCH_OFFSET + visualRoughness,
            );
            const position = latLonVector(location.latDeg, location.lonDeg, radius);
            const uv = latLonUv(location.latDeg, location.lonDeg);
            positions[vertexOffset * 3] = position.x;
            positions[vertexOffset * 3 + 1] = position.y;
            positions[vertexOffset * 3 + 2] = position.z;
            uvs[vertexOffset * 2] = uv.u;
            uvs[vertexOffset * 2 + 1] = uv.v;
            const shade = THREE.MathUtils.clamp(0.88 + visualRoughnessKm * 0.9, 0.72, 1.08);
            colors[vertexOffset * 3] = shade;
            colors[vertexOffset * 3 + 1] = shade * 0.94;
            colors[vertexOffset * 3 + 2] = shade * 0.9;
            vertexOffset += 1;
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
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    regionalTerrain.geometry.dispose();
    regionalTerrain.geometry = geometry;
    const gridPositions = [];
    const gridStep = 4;
    const pushSegment = (fromIndex, toIndex) => {
        for (const index of [fromIndex, toIndex]) {
            const vector = new THREE.Vector3(
                positions[index * 3],
                positions[index * 3 + 1],
                positions[index * 3 + 2],
            ).multiplyScalar(1.000018);
            gridPositions.push(vector.x, vector.y, vector.z);
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
    gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(gridPositions, 3));
    regionalTerrainGrid.geometry.dispose();
    regionalTerrainGrid.geometry = gridGeometry;
    regionalTerrainCenter = { latDeg, lonDeg };
}

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

function buildCoordinateGrid(radius = 1.038) {
    const group = new THREE.Group();
    const material = new THREE.LineBasicMaterial({ color: 0xffc2a0, transparent: true, opacity: 0.16, depthWrite: false });
    for (let lon = -180; lon < 180; lon += 30) {
        const points = [];
        for (let lat = -90; lat <= 90; lat += 2) points.push(latLonVector(lat, lon, radius));
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
    }
    for (let lat = -60; lat <= 60; lat += 30) {
        const points = [];
        for (let lon = -180; lon <= 180; lon += 2) points.push(latLonVector(lat, lon, radius));
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
    }
    return group;
}

const gridLayer = buildCoordinateGrid();
marsGroup.add(gridLayer);

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

let horizonsSunDirection = null;
function updateIllumination(date = new Date()) {
    const subsolar = marsSubsolarPoint(date);
    const fallbackDirection = latLonVector(subsolar.lat_deg, subsolar.lon_deg).normalize();
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

const landmarks = new MarsLandmarks(marsGroup, latLonVector);
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

function placeSurfaceMarker(group, lat, lon) {
    const position = latLonVector(lat, lon, 1.046);
    const normal = position.clone().normalize();
    group.position.copy(position);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
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

async function loadTraverseHistory() {
    const range = document.querySelector('#route-sol');
    try {
        const response = await fetch('/data/mars/perseverance-route.json', { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const snapshot = await response.json();
        if (!Array.isArray(snapshot.points) || snapshot.points.length < 2) throw new Error('route snapshot has no points');
        routeSnapshot = snapshot;
        const vectors = snapshot.points.map(point => latLonVector(point.lat_deg, point.lon_deg, 1.044));
        routeLine.geometry.dispose();
        routeLine.geometry = new THREE.BufferGeometry().setFromPoints(vectors);
        waypointsLayer.geometry.dispose();
        waypointsLayer.geometry = new THREE.BufferGeometry().setFromPoints(vectors);
        range.min = String(snapshot.points[0].sol);
        range.max = String(snapshot.through_sol);
        range.value = String(snapshot.through_sol);
        range.disabled = false;
        range.addEventListener('input', () => selectRouteSol(Number(range.value)));
        document.querySelector('#route-history-source').textContent = `${snapshot.point_count} NASA stops · ${snapshot.snapshot_checked_at}`;
        document.querySelector('#route-source').textContent = `${snapshot.point_count} bundled NASA stops · through sol ${snapshot.through_sol}`;
        selectRouteSol(snapshot.through_sol);
    } catch (error) {
        console.warn('[Mars] Bundled NASA traverse unavailable', error);
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
    const orbitalSeason = marsSubsolarPoint(new Date()).ls_deg;
    const payloadSeason = numberOrNull(payload?.ls_deg) ?? orbitalSeason;
    const weatherSeason = numberOrNull(record?.ls_deg) ?? payloadSeason;
    document.querySelector('#header-season').textContent = `LS ${Math.round(payloadSeason)}°`;
    document.querySelector('#weather-season').textContent = `Ls ${Math.round(weatherSeason)}°`;
    document.querySelector('#weather-season-detail').textContent = record?.season || payload?.message || 'orbital season fallback';
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
        applyMissionUi(payload?.mission?.perseverance || mission);
        if (payload?.rovers?.perseverance?.active) applyWeatherUi(payload);
        else applyBundledWeather(payload, 'NASA daily-summary upstream returned no usable observation');
    } catch (error) {
        console.warn('[Mars] Shared weather adapter unavailable', error);
        applyMissionUi(mission);
        applyBundledWeather({}, 'Shared adapter unavailable');
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
        reliefMars.visible = enabled && hasRelief;
        smoothMars.visible = !reliefMars.visible;
        if (surfaceModeActive && regionalTerrainCenter) {
            rebuildRegionalTerrain(regionalTerrainCenter.latDeg, regionalTerrainCenter.lonDeg);
        }
    } else if (name === 'grid') gridLayer.visible = enabled;
    else if (name === 'atmosphere') atmosphereLayer.visible = enabled;
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
    if (name === 'relief') return reliefMars.visible;
    if (name === 'regional-terrain') return regionalTerrain.visible;
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

document.querySelectorAll('[data-layer]').forEach(input => {
    input.addEventListener('change', () => setLayer(input.dataset.layer, input.checked));
});

function setCollapsed(container, button, collapsed, label) {
    container.classList.toggle('collapsed', collapsed);
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Minimize'} ${label}`);
    button.title = `${collapsed ? 'Expand' : 'Minimize'} ${label}`;
    button.textContent = collapsed ? '+' : '−';
}

document.querySelectorAll('.panel .panel-toggle').forEach(button => {
    button.addEventListener('click', () => {
        const panel = button.closest('.panel');
        setCollapsed(panel, button, !panel.classList.contains('collapsed'), panel.querySelector('h2').textContent);
    });
});

const weatherDock = document.querySelector('.data-dock');
document.querySelector('#weather-collapse').addEventListener('click', event => {
    setCollapsed(
        weatherDock,
        event.currentTarget,
        !weatherDock.classList.contains('collapsed'),
        'MEDA surface observations',
    );
});

const cameraModeElement = document.querySelector('#camera-mode');
const cameraRangeElement = document.querySelector('#camera-range');
const cameraSpinButton = document.querySelector('#camera-spin');
const rotateToggle = document.querySelector('[data-layer="rotate"]');
const cameraHelpElement = document.querySelector('#camera-help');
const surfaceExplorer = document.querySelector('#surface-explorer');
const surfaceLocationElement = document.querySelector('#surface-location');
const surfaceAltitudeElement = document.querySelector('#surface-altitude');
const surfaceDetailElement = document.querySelector('#surface-detail');
const meshStatusElement = document.querySelector('#mars-mesh-status');
const globalMeshStatus = meshStatusElement.textContent;
const surfaceLightButton = document.querySelector('#surface-light');
const surfaceGridButton = document.querySelector('#surface-grid');
const surfaceCollapseButton = document.querySelector('#surface-collapse');
const interfaceToggleButton = document.querySelector('#ui-panels-toggle');
const interfaceToggleIcon = document.querySelector('#ui-panels-icon');

function setInterfaceClean(enabled) {
    const clean = Boolean(enabled);
    app.classList.toggle('interface-clean', clean);
    interfaceToggleButton.setAttribute('aria-pressed', String(clean));
    interfaceToggleButton.setAttribute('aria-label', clean ? 'Show all interface panels' : 'Hide all interface panels');
    interfaceToggleButton.title = `${clean ? 'Show' : 'Hide'} all interface panels (P)`;
    interfaceToggleIcon.textContent = clean ? 'SHOW' : 'HIDE';
}

interfaceToggleButton.addEventListener('click', () => setInterfaceClean(!app.classList.contains('interface-clean')));
surfaceCollapseButton.addEventListener('click', () => setCollapsed(
    surfaceExplorer,
    surfaceCollapseButton,
    !surfaceExplorer.classList.contains('collapsed'),
    'surface controls',
));

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

const surfaceOccludedObjects = [gridLayer, atmosphereLayer, terminatorLayer, sky.group, routeLayer, waypointsLayer, roverLayer, landingLayer];
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
    return latLonVector(latDeg, lonDeg, reliefRadiusAtLatLon(latDeg, lonDeg, offset))
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

function updateSurfaceTrail(location, { reset = false } = {}) {
    if (reset) surfaceTrailLocations = [];
    surfaceTrailLocations.push({ latDeg: location.latDeg, lonDeg: location.lonDeg });
    if (surfaceTrailLocations.length > 180) surfaceTrailLocations.shift();
    const points = surfaceTrailLocations.map(point => latLonVector(
        point.latDeg,
        point.lonDeg,
        reliefRadiusAtLatLon(point.latDeg, point.lonDeg, SURFACE_PATCH_OFFSET + 0.00007),
    ));
    surfaceTrail.geometry.dispose();
    surfaceTrail.geometry = new THREE.BufferGeometry().setFromPoints(points);
}

function formatCoordinate(value, positive, negative) {
    return `${Math.abs(value).toFixed(3)}°${value < 0 ? negative : positive}`;
}

function updateSurfaceReadout() {
    if (!surfaceModeActive || !surfaceLocation) return;
    const target = worldVectorLatLon(controls.target);
    surfaceLocation = target;
    const cameraLocation = worldVectorLatLon(camera.position);
    const surfaceRadius = reliefRadiusAtLatLon(cameraLocation.latDeg, cameraLocation.lonDeg);
    const altitudeKm = Math.max(0, (camera.position.length() - surfaceRadius) * MARS_RADIUS_KM);
    const elevationKm = elevationAtLatLon(target.latDeg, target.lonDeg) / 1000;
    surfaceLocationElement.textContent = `${formatCoordinate(target.latDeg, 'N', 'S')} · ${formatCoordinate(target.lonDeg, 'E', 'W')}`;
    surfaceAltitudeElement.textContent = `Eye ${altitudeKm.toFixed(1)} km · MOLA ${elevationKm >= 0 ? '+' : '−'}${Math.abs(elevationKm).toFixed(1)} km`;
    surfaceExplorer.dataset.lat = target.latDeg.toFixed(6);
    surfaceExplorer.dataset.lon = target.lonDeg.toFixed(6);
    surfaceExplorer.dataset.altitudeKm = altitudeKm.toFixed(3);
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
    surfaceGridButton.title = `${active ? 'Hide' : 'Show'} 8 km terrain analysis grid`;
}

function deactivateSurfaceExplorer() {
    if (!surfaceModeActive) return;
    surfaceModeActive = false;
    app.classList.remove('is-surface-mode');
    surfaceExplorer.hidden = true;
    regionalTerrain.visible = false;
    setSurfaceGrid(false);
    surfaceTrail.visible = false;
    setSurfaceLight(false);
    setSurfacePresentation(false);
    scene.fog.color.setHex(0x080302);
    scene.fog.density = 0.025;
    camera.near = 0.01;
    camera.up.set(0, 1, 0);
    camera.updateProjectionMatrix();
    meshStatusElement.textContent = globalMeshStatus;
    cameraHelpElement.textContent = 'Drag to orbit · pinch or scroll to zoom';
}

function enterSurfaceExplorer(latDeg, lonDeg, { label = 'Surface traverse', duration = 1050 } = {}) {
    setAutoRotate(false);
    if (surfaceModeActive) setSurfacePresentation(false);
    surfaceModeActive = true;
    surfaceLocation = { latDeg, lonDeg };
    app.classList.add('is-surface-mode');
    surfaceExplorer.hidden = false;
    rebuildRegionalTerrain(latDeg, lonDeg);
    regionalTerrain.visible = true;
    setSurfaceGrid(true);
    surfaceTrail.visible = true;
    setSurfaceLight(true);
    updateSurfaceTrail(surfaceLocation, { reset: true });
    setSurfacePresentation(true);
    scene.fog.color.setHex(0x4d1e12);
    scene.fog.density = 3.2;
    camera.near = 0.00002;
    camera.updateProjectionMatrix();
    controls.minDistance = 0.00025;
    controls.maxDistance = 0.18;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
    const target = worldSurfacePoint(latDeg, lonDeg);
    const radial = target.clone().normalize();
    const { north, east } = tangentFrame(radial);
    const position = target.clone()
        .addScaledVector(radial, 0.0006)
        .addScaledVector(north, -0.0018)
        .addScaledVector(east, 0.0003);
    camera.up.copy(radial);
    setCameraMode('surface', label);
    cameraTween = {
        started: performance.now(), duration,
        fromPosition: camera.position.clone(), toPosition: position,
        fromTarget: controls.target.clone(), toTarget: target,
    };
    surfaceDetailElement.textContent = hasRelief
        ? '520 km MOLA macro-relief · 8 km analysis grid · visual roughness is illustrative'
        : 'MOLA unavailable · smooth regional geometry · Viking/material fallback';
    meshStatusElement.textContent = hasRelief
        ? 'regional MOLA · 66k vertices · 5× macro relief'
        : 'regional smooth-terrain fallback';
    cameraHelpElement.textContent = 'Drag to look · scroll altitude · WASD / arrows move · Esc orbit';
    updateSurfaceReadout();
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

function nudgeSurface(forwardAmount, rightAmount) {
    if (!surfaceModeActive) return;
    cameraTween = null;
    const oldTarget = controls.target.clone();
    const radial = oldTarget.clone().normalize();
    let forward = controls.target.clone().sub(camera.position);
    forward.addScaledVector(radial, -forward.dot(radial));
    if (forward.lengthSq() < 1e-8) forward.copy(tangentFrame(radial).north);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, radial).normalize();
    const movement = forward.multiplyScalar(forwardAmount).addScaledVector(right, rightAmount);
    if (movement.lengthSq() < 1e-8) return;
    movement.normalize();
    const angle = SURFACE_STEP_KM / MARS_RADIUS_KM;
    const newRadial = radial.clone().multiplyScalar(Math.cos(angle))
        .addScaledVector(movement, Math.sin(angle)).normalize();
    const location = worldVectorLatLon(newRadial);
    const newTarget = worldSurfacePoint(location.latDeg, location.lonDeg);
    const transport = new THREE.Quaternion().setFromUnitVectors(radial, newTarget.clone().normalize());
    const offset = camera.position.clone().sub(oldTarget).applyQuaternion(transport);
    controls.target.copy(newTarget);
    camera.position.copy(newTarget).add(offset);
    camera.up.copy(newTarget).normalize();
    surfaceLocation = location;
    if (!regionalTerrainCenter
        || greatCircleDistanceKm(regionalTerrainCenter, location) > REGIONAL_TERRAIN_EXTENT_KM * 0.22) {
        rebuildRegionalTerrain(location.latDeg, location.lonDeg);
    }
    updateSurfaceTrail(location);
    updateSurfaceReadout();
}

function enforceSurfaceClearance() {
    if (!surfaceModeActive) return;
    const location = worldVectorLatLon(camera.position);
    const minimumRadius = reliefRadiusAtLatLon(location.latDeg, location.lonDeg)
        + SURFACE_CLEARANCE_KM / MARS_RADIUS_KM;
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

document.querySelector('#focus-rover').addEventListener('click', () => focusSelectedRover());
document.querySelector('#reset-view').addEventListener('click', () => showGlobalView());
document.querySelector('#camera-global').addEventListener('click', () => showGlobalView());
document.querySelector('#camera-rover').addEventListener('click', () => focusSelectedRover());
document.querySelector('#camera-landing').addEventListener('click', () => focusLandingSite());
document.querySelector('#camera-surface').addEventListener('click', () => enterSurfaceAtCurrentFocus());
document.querySelector('#camera-zoom-out').addEventListener('click', () => zoomCamera(1.3));
document.querySelector('#camera-zoom-in').addEventListener('click', () => zoomCamera(0.76));
cameraSpinButton.addEventListener('click', () => setAutoRotate(!controls.autoRotate));
document.querySelectorAll('[data-surface-move]').forEach(button => {
    button.addEventListener('click', () => nudgeSurface(
        Number(button.dataset.forward || 0),
        Number(button.dataset.right || 0),
    ));
});
surfaceLightButton.addEventListener('click', () => setSurfaceLight(!surfaceHeadlamp.visible));
surfaceGridButton.addEventListener('click', () => setSurfaceGrid(!regionalTerrainGrid.visible));

document.querySelectorAll('[data-sky-focus]').forEach(button => {
    button.addEventListener('click', () => focusSkyBody(button.dataset.skyFocus));
});

controls.addEventListener('start', () => {
    cameraTween = null;
    setAutoRotate(false);
    setCameraMode(surfaceModeActive ? 'surface' : 'custom', surfaceModeActive ? 'Surface traverse' : 'Free orbit');
    canvas.classList.add('is-interacting');
});
controls.addEventListener('end', () => canvas.classList.remove('is-interacting'));

reducedMotion.addEventListener?.('change', event => {
    if (event.matches) setAutoRotate(false);
});

canvas.addEventListener('keydown', event => {
    if (surfaceModeActive && (event.key.toLowerCase() === 'w' || event.key === 'ArrowUp')) nudgeSurface(1, 0);
    else if (surfaceModeActive && (event.key.toLowerCase() === 's' || event.key === 'ArrowDown')) nudgeSurface(-1, 0);
    else if (surfaceModeActive && (event.key.toLowerCase() === 'a' || event.key === 'ArrowLeft')) nudgeSurface(0, -1);
    else if (surfaceModeActive && (event.key.toLowerCase() === 'd' || event.key === 'ArrowRight')) nudgeSurface(0, 1);
    else if (surfaceModeActive && event.key === 'Escape') showGlobalView();
    else if (event.key.toLowerCase() === 'h') showGlobalView();
    else if (event.key.toLowerCase() === 'r') focusSelectedRover();
    else if (event.key.toLowerCase() === 'l') focusLandingSite();
    else if (event.key === '+' || event.key === '=') zoomCamera(0.76);
    else if (event.key === '-' || event.key === '_') zoomCamera(1.3);
    else if (event.key === ' ') setAutoRotate(!controls.autoRotate);
    else if (event.key.toLowerCase() === 'p') setInterfaceClean(!app.classList.contains('interface-clean'));
    else return;
    event.preventDefault();
});

const landmarkCard = document.querySelector('#landmark-card');
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDown = null;

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

canvas.addEventListener('pointerdown', event => { pointerDown = { x: event.clientX, y: event.clientY }; });
canvas.addEventListener('pointerup', event => {
    const start = pointerDown;
    pointerDown = null;
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1;
    pointer.y = -(event.clientY - rect.top) / rect.height * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const skyHit = raycaster.intersectObjects(sky.hitTargets, false)
        .find(intersection => sky.isBodyVisible(intersection.object.userData.skyBodyKey));
    if (skyHit) {
        showSkyBody(sky.getBodyRecord(skyHit.object.userData.skyBodyKey), skyHit.object.userData.skyBodyKey);
        return;
    }
    const hit = raycaster.intersectObjects(landmarks.hitTargets, false)
        .find(intersection => landmarks.isLandmarkVisible(intersection.object.userData.landmark));
    if (hit) showLandmark(hit.object.userData.landmark);
});
canvas.addEventListener('dblclick', event => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1;
    pointer.y = -(event.clientY - rect.top) / rect.height * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const globeHit = raycaster.intersectObjects([regionalTerrain, reliefMars, smoothMars], false)[0];
    if (!globeHit) return;
    const location = worldVectorLatLon(globeHit.point);
    lastSurfaceFocus = { ...location, label: 'Selected terrain' };
    enterSurfaceExplorer(location.latDeg, location.lonDeg, { label: 'Surface · selected terrain' });
});
document.querySelector('#landmark-card-close').addEventListener('click', () => { landmarkCard.hidden = true; });
document.querySelector('#landmark-card-focus').addEventListener('click', () => cardFocusAction?.());

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
setCameraMode('global', 'Mission orbit');
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
loadMarsSky();
scheduleMarsSkyRefresh();

loaderStatus.textContent = hasRelief ? 'MOLA relief ready · locating Perseverance…' : 'Smooth globe ready · MOLA relief unavailable';
window.__marsReady = true;
window.__marsLab = Object.freeze({
    camera,
    controls,
    layerIsVisible,
    enterSurfaceExplorer,
    nudgeSurface,
    cameraState: () => ({
        mode: cameraMode,
        label: cameraModeLabel,
        rangeKm: camera.position.distanceTo(controls.target) * MARS_RADIUS_M / 1000,
    }),
    surfaceState: () => ({
        active: surfaceModeActive,
        location: surfaceLocation ? { ...surfaceLocation } : null,
        terrainVertices: regionalTerrain.geometry.attributes.position?.count || 0,
        trailPoints: surfaceTrailLocations.length,
        gridVisible: regionalTerrainGrid.visible,
        analysisLightVisible: surfaceHeadlamp.visible,
        hasRelief,
    }),
});
window.clearTimeout(window.__marsBootTimer);
document.querySelector('#mars-render-fallback').hidden = true;
app.classList.remove('mars-render-degraded');
window.setTimeout(() => loadingScreen.classList.add('done'), 250);

const clock = new THREE.Clock();
function animate(now) {
    requestAnimationFrame(animate);
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
    if (!cameraTween) controls.update();
    enforceSurfaceClearance();
    if (surfaceModeActive) {
        const radial = camera.position.clone().normalize();
        surfaceHeadlamp.position.copy(camera.position);
        surfaceHeadlamp.target.position.copy(controls.target);
        surfaceHeadlamp.target.updateMatrixWorld();
        surfaceFillLight.position.copy(camera.position).addScaledVector(radial, -0.0001);
        updateSurfaceReadout();
    }
    updateCameraReadout();
    renderer.render(scene, camera);
}
requestAnimationFrame(animate);
