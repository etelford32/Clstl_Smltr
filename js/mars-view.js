import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    MARS_RADIUS_M,
    PERSEVERANCE_MISSION,
    estimatedMissionSol,
    formatMarsClock,
    localMeanSolarTimeHours,
    marsSubsolarPoint,
    observationFreshness,
} from './mars-mission-state.js';
import { MarsLandmarks } from './mars-landmarks.js';
import { MARS_LANDMARK_CATEGORIES } from './mars-landmarks-data.js';
import { fetchMarsSkyEphemeris } from './horizons.js';
import { MarsSky } from './mars-sky.js';

const SURFACE_RADIUS = 1;
const RELIEF_EXAGGERATION = 5;
const MOLA_MIN_M = -8068;
const MOLA_MAX_M = 21134;
const TEXTURE_URL = '/assets/mars/mars-viking-jpl.jpg';
const MOLA_URL = '/assets/mars/mola-topography.png';
const mission = PERSEVERANCE_MISSION;

const canvas = document.querySelector('#mars-canvas');
const app = document.querySelector('.mars-app');
const loadingScreen = document.querySelector('#loading-screen');
const loaderStatus = document.querySelector('#loader-status');

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x080302, 0.025);

const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
camera.position.set(0.15, 0.42, 3.15);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 1.22;
controls.maxDistance = 7;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.75;
controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
controls.autoRotateSpeed = 0.34;

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

loaderStatus.textContent = 'Displacing 32,768 surface vertices with MOLA elevation…';
await new Promise(resolve => requestAnimationFrame(resolve));

const smoothGeometry = new THREE.SphereGeometry(SURFACE_RADIUS, 256, 128);
const reliefGeometry = smoothGeometry.clone();

function displaceWithMola(geometry, texture) {
    const image = texture?.image;
    if (!image?.width || !image?.height) return false;
    const sampler = document.createElement('canvas');
    sampler.width = image.width;
    sampler.height = image.height;
    const context = sampler.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, sampler.width, sampler.height).data;
    const positions = geometry.attributes.position;
    const uvs = geometry.attributes.uv;
    const direction = new THREE.Vector3();
    for (let index = 0; index < positions.count; index += 1) {
        const u = THREE.MathUtils.clamp(uvs.getX(index), 0, 0.999999);
        const v = THREE.MathUtils.clamp(uvs.getY(index), 0, 0.999999);
        const x = Math.floor(u * sampler.width);
        const y = Math.min(sampler.height - 1, Math.floor((1 - v) * sampler.height));
        const gray = pixels[(y * sampler.width + x) * 4];
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

const hasRelief = displaceWithMola(reliefGeometry, molaTexture);
const surfaceMaterial = new THREE.MeshStandardMaterial({
    color: surfaceTexture ? 0xffffff : 0xa83f20,
    map: surfaceTexture,
    roughness: 0.92,
    metalness: 0,
});
const smoothMars = new THREE.Mesh(smoothGeometry, surfaceMaterial);
const reliefMars = new THREE.Mesh(reliefGeometry, surfaceMaterial);
smoothMars.visible = !hasRelief;
reliefMars.visible = hasRelief;
marsGroup.add(smoothMars, reliefMars);

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
        selectRouteSol(snapshot.through_sol);
    } catch (error) {
        console.warn('[Mars] Bundled NASA traverse unavailable', error);
        range.disabled = true;
        document.querySelector('#route-sol-output').textContent = 'Route unavailable';
        document.querySelector('#route-history-source').textContent = 'PDS science fix still available';
        routeLayer.visible = false;
        waypointsLayer.visible = false;
    }
}

function applyMissionUi(state) {
    const latestDrive = state.latest_drive;
    const position = state.position;
    const routePosition = latestDrive.position || position;
    document.querySelector('#mission-status').textContent = state.status === 'operational' ? 'Operating on Mars' : state.status;
    document.querySelector('#mission-pill').textContent = state.status === 'operational' ? 'Active' : 'Check status';
    document.querySelector('#drive-sol').textContent = `Sol ${latestDrive.sol}`;
    document.querySelector('#drive-date').textContent = `NASA map · checked ${latestDrive.checked_at}`;
    document.querySelector('#drive-distance').textContent = `${latestDrive.distance_km.toFixed(2)} km`;
    document.querySelector('#fix-sol').textContent = `Sol ${latestDrive.sol}`;
    document.querySelector('#fix-coordinates').textContent = `${routePosition.lat_deg.toFixed(3)}°N, ${routePosition.lon_deg.toFixed(3)}°E`;
    document.querySelector('#pds-sol').textContent = `Sol ${state.meda_archive.latest_verified_sol}`;
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
    document.querySelector('#header-season').textContent = Number.isFinite(payload?.ls_deg) ? `LS ${Math.round(payload.ls_deg)}°` : 'LS —°';
    document.querySelector('#weather-season').textContent = Number.isFinite(record?.ls_deg) ? `Ls ${Math.round(record.ls_deg)}°` : (Number.isFinite(payload?.ls_deg) ? `Ls ${Math.round(payload.ls_deg)}°` : '—');
    document.querySelector('#weather-season-detail').textContent = record?.season || payload?.message || 'season model';
    if (!record?.active) {
        feedState.dataset.state = 'offline';
        feedState.textContent = 'Mars adapter online · MEDA summary unavailable';
        warning.textContent = 'Globe and PDS marker remain available; no environmental value is being inferred.';
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

async function loadMarsFeed() {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch('/api/mars/weather', { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        applyMissionUi(payload?.mission?.perseverance || mission);
        applyWeatherUi(payload);
    } catch (error) {
        console.warn('[Mars] Shared weather adapter unavailable', error);
        applyMissionUi(mission);
        applyWeatherUi({ ls_deg: null, rovers: { perseverance: { active: false } } });
        document.querySelector('#feed-state').textContent = 'Adapter unavailable · bundled PDS snapshot';
        document.querySelector('#feed-provenance').textContent = '/api/mars/weather unavailable · no direct upstream requests were made';
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
    } else if (name === 'relief') {
        reliefMars.visible = enabled && hasRelief;
        smoothMars.visible = !reliefMars.visible;
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
    else if (name === 'rotate') controls.autoRotate = enabled && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

document.querySelectorAll('[data-layer]').forEach(input => {
    input.addEventListener('change', () => setLayer(input.dataset.layer, input.checked));
});

document.querySelectorAll('.panel-toggle').forEach(button => {
    button.addEventListener('click', () => {
        const panel = button.closest('.panel');
        const collapsed = panel.classList.toggle('collapsed');
        button.setAttribute('aria-expanded', String(!collapsed));
        button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${panel.querySelector('h2').textContent}`);
    });
});

let cameraTween = null;
function flyCamera(position, target, duration = 850) {
    cameraTween = {
        started: performance.now(), duration,
        fromPosition: camera.position.clone(), toPosition: position.clone(),
        fromTarget: controls.target.clone(), toTarget: target.clone(),
    };
}

document.querySelector('#focus-rover').addEventListener('click', () => {
    const radial = latLonVector(selectedRoutePoint.lat_deg, selectedRoutePoint.lon_deg).applyEuler(marsGroup.rotation).normalize();
    const tangent = new THREE.Vector3(0, 1, 0).cross(radial).normalize();
    flyCamera(radial.clone().multiplyScalar(1.72).add(tangent.multiplyScalar(0.36)), radial.clone().multiplyScalar(0.98));
});
document.querySelector('#reset-view').addEventListener('click', () => flyCamera(new THREE.Vector3(0.15, 0.42, 3.15), new THREE.Vector3()));
document.querySelectorAll('[data-sky-focus]').forEach(button => {
    button.addEventListener('click', () => {
        const key = button.dataset.skyFocus;
        const direction = sky.getDirection(key);
        if (!direction) return;
        const input = document.querySelector(`[data-layer="sky-${key}"]`);
        if (input && !input.checked) {
            input.checked = true;
            sky.setBodyVisible(key, true);
        }
        const worldDirection = direction.applyQuaternion(marsGroup.quaternion).normalize();
        flyCamera(worldDirection.multiplyScalar(3.15), new THREE.Vector3());
        showSkyBody(sky.getBodyRecord(key));
    });
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
    landmarkCard.hidden = false;
}

function showSkyBody(record) {
    document.querySelector('#landmark-card-category').textContent = 'JPL Horizons · Mars topocentric sky';
    document.querySelector('#landmark-card-name').textContent = record.name;
    document.querySelector('#landmark-card-note').textContent = `${record.above_horizon ? 'Above' : 'Below'} the airless local horizon at Perseverance's latest public route position. Apparent direction includes light-time and aberration corrections.`;
    document.querySelector('#landmark-card-stats').textContent = `Az ${record.azimuth_deg.toFixed(3)}° · El ${signedDegrees(record.elevation_deg)} · ${record.range_au.toFixed(6)} AU`;
    document.querySelector('#landmark-card-source').href = 'https://ssd-api.jpl.nasa.gov/doc/horizons.html';
    document.querySelector('#landmark-card-source').textContent = 'JPL Horizons method ↗';
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
        showSkyBody(sky.getBodyRecord(skyHit.object.userData.skyBodyKey));
        return;
    }
    const hit = raycaster.intersectObjects(landmarks.hitTargets, false)
        .find(intersection => landmarks.isLandmarkVisible(intersection.object.userData.landmark));
    if (hit) showLandmark(hit.object.userData.landmark);
});
document.querySelector('#landmark-card-close').addEventListener('click', () => { landmarkCard.hidden = true; });

function updateCameraTween(now) {
    if (!cameraTween) return;
    const raw = Math.min(1, (now - cameraTween.started) / cameraTween.duration);
    const eased = raw < 0.5 ? 4 * raw ** 3 : 1 - Math.pow(-2 * raw + 2, 3) / 2;
    camera.position.lerpVectors(cameraTween.fromPosition, cameraTween.toPosition, eased);
    controls.target.lerpVectors(cameraTween.fromTarget, cameraTween.toTarget, eased);
    if (raw >= 1) cameraTween = null;
}

function resize() {
    const width = Math.max(1, app.clientWidth);
    const height = Math.max(1, app.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(app);
resize();

applyMissionUi(mission);
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

loaderStatus.textContent = hasRelief ? 'MOLA relief ready · locating Perseverance…' : 'Color globe ready · MOLA relief unavailable';
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
    landmarks.update(camera);
    sky.updateCamera(camera);
    controls.update();
    renderer.render(scene, camera);
}
requestAnimationFrame(animate);
