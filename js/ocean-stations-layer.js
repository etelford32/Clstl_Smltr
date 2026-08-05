/** NOAA tide-gauge, marine buoy, and DART marker layers for EarthView. */

const TIDES_URL = '/api/ocean/tides?mode=stations';
const BUOYS_URL = '/api/ocean/buoys?mode=stations';
const DART_URL  = '/api/ocean/dart?mode=stations';
const KINDS = ['tides', 'buoys', 'dart'];

// Honest, geometry-only defaults used when NOAA cannot be reached. These are
// reference locations—not observations—and every item is flagged so the
// detail card can say that plainly. A failed feed should still prove that the
// toggle and map layer work instead of leaving the user staring at no change.
const FALLBACK_STATIONS = {
    tides: [
        ['Puget Sound', 47.60, -122.34],
        ['San Francisco Bay', 37.81, -122.47],
        ['Southern California', 33.72, -118.27],
        ['Honolulu', 21.31, -157.87],
        ['Southcentral Alaska', 61.13, -149.90],
        ['Gulf Coast', 29.31, -94.79],
        ['Key West', 24.56, -81.81],
        ['South Florida', 25.77, -80.13],
        ['Charleston', 32.78, -79.93],
        ['Chesapeake Bay', 36.97, -76.33],
        ['New York Harbor', 40.70, -74.01],
        ['Boston Harbor', 42.36, -71.05],
        ['San Juan', 18.46, -66.12],
        ['Guam', 13.44, 144.65],
    ].map(([name, lat, lon], index) => ({
        id: `REF-TIDE-${index + 1}`,
        name: `${name} reference`,
        lat, lon, fallback: true,
    })),
    buoys: [
        ['Northeast Pacific', 45, -130],
        ['California offshore', 35, -123],
        ['Gulf of Alaska', 56, -148],
        ['North Pacific', 30, -155],
        ['Hawaiian waters', 20, -158],
        ['Western tropical Pacific', 12, 150],
        ['Eastern tropical Pacific', 5, -110],
        ['Gulf of Mexico', 26, -90],
        ['Florida Atlantic', 28, -78],
        ['Caribbean Sea', 17, -67],
        ['Western North Atlantic', 34, -72],
        ['New England offshore', 41, -68],
        ['Central North Atlantic', 40, -45],
        ['South Atlantic', -20, -25],
        ['North Sea', 56, 3],
        ['Mediterranean', 36, 18],
        ['Arabian Sea', 15, 65],
        ['Bay of Bengal', 15, 88],
        ['Coral Sea', -20, 155],
        ['Southern Ocean', -50, 90],
    ].map(([name, lat, lon], index) => ({
        id: `REF-BUOY-${index + 1}`,
        name: `${name} reference`,
        lat, lon, fallback: true,
    })),
    dart: [
        ['Alaska/Aleutians', 52.6, -156.4],
        ['Northeast Pacific', 46.9, -155.1],
        ['Pacific Northwest', 44.6, -125.8],
        ['California offshore', 34.8, -120.8],
        ['Hawaii north', 23.4, -162.3],
        ['Hawaii south', 17.1, -156.5],
        ['Caribbean', 19.3, -66.6],
        ['Western Atlantic', 31.8, -74.8],
    ].map(([name, lat, lon], index) => ({
        id: `REF-DART-${index + 1}`,
        name: `${name} DART reference`,
        lat, lon, fallback: true,
    })),
};

async function fetchStations(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.detail ?? body.error);
    return body.stations ?? [];
}

export class OceanStationsLayer {
    constructor(THREE, parent, { geoToXYZ, onStatus, forceFallback = false } = {}) {
        this.THREE = THREE;
        this.parent = parent;
        this.geoToXYZ = geoToXYZ;
        this.onStatus = onStatus ?? (() => {});
        this.forceFallback = Boolean(forceFallback);
        this._items = { tides: [], buoys: [], dart: [] };
        this._meshes = { tides: null, buoys: null, dart: null };
        this._wanted = { tides: false, buoys: false, dart: false };
        this._loading = { tides: null, buoys: null, dart: null };
        this._dummy = new THREE.Object3D();
    }

    setTidesVisible(visible) { return this._setVisible('tides', visible); }
    setBuoysVisible(visible) { return this._setVisible('buoys', visible); }
    setDartVisible(visible) { return this._setVisible('dart', visible); }
    isTidesVisible() { return this._meshes.tides?.visible ?? this._wanted.tides; }
    isBuoysVisible() { return this._meshes.buoys?.visible ?? this._wanted.buoys; }
    isDartVisible() { return this._meshes.dart?.visible ?? this._wanted.dart; }

    async _setVisible(kind, visible) {
        this._wanted[kind] = Boolean(visible);
        if (this._meshes[kind]) this._meshes[kind].visible = this._wanted[kind];
        if (!visible || this._meshes[kind]) return;
        if (!this._loading[kind]) this._loading[kind] = this._load(kind);
        return this._loading[kind];
    }

    async _load(kind) {
        this.onStatus(kind, 'fetching');
        try {
            if (this.forceFallback) throw new Error('locally forced fallback verification');
            const endpoint = kind === 'tides' ? TIDES_URL : kind === 'buoys' ? BUOYS_URL : DART_URL;
            const items = await fetchStations(endpoint);
            if (!items.length) throw new Error('upstream returned no station locations');
            this._items[kind] = items;
            this._meshes[kind] = this._buildMesh(kind, items);
            this._meshes[kind].visible = this._wanted[kind];
            this.onStatus(kind, 'loaded', { count: items.length });
        } catch (error) {
            const items = FALLBACK_STATIONS[kind];
            this._items[kind] = items;
            this._meshes[kind] = this._buildMesh(kind, items);
            this._meshes[kind].visible = this._wanted[kind];
            this.onStatus(kind, 'fallback', { count: items.length, error: error.message });
        }
    }

    _buildMesh(kind, items) {
        const geometry = kind === 'tides'
            ? new this.THREE.SphereGeometry(1, 7, 6)
            : kind === 'buoys'
                ? new this.THREE.OctahedronGeometry(1, 0)
                : new this.THREE.TetrahedronGeometry(1, 0);
        const material = new this.THREE.MeshBasicMaterial({
            color: kind === 'tides' ? 0x00d4ff : kind === 'buoys' ? 0xffcc44 : 0xff4d9d,
            transparent: true,
            opacity: 1,
            blending: this.THREE.AdditiveBlending,
            depthWrite: false,
            toneMapped: false,
        });
        const mesh = new this.THREE.InstancedMesh(geometry, material, items.length);
        // EarthView's cloud/aurora/atmosphere stack reaches radius 1.026.
        // Stations must sit above it or a successful feed load is visually
        // buried beneath the weather shells. At these sizes a marker reads as
        // roughly 5–7 CSS px on the default desktop globe: conspicuous when
        // requested, but not a blanket over the coastline.
        const scale = kind === 'tides' ? 0.010 : kind === 'buoys' ? 0.012 : 0.014;
        for (let i = 0; i < items.length; i++) {
            this._dummy.position.copy(this.geoToXYZ(items[i].lat, items[i].lon)).multiplyScalar(1.032);
            this._dummy.scale.setScalar(scale);
            this._dummy.updateMatrix();
            mesh.setMatrixAt(i, this._dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.name = kind === 'tides' ? 'ocean-tide-gauges'
            : kind === 'buoys' ? 'ocean-buoys' : 'ocean-dart-tsunameters';
        mesh.userData.oceanStationLayer = kind;
        mesh.renderOrder = 25;
        this.parent.add(mesh);
        return mesh;
    }

    getHovered(raycaster) {
        const hits = [];
        for (const kind of KINDS) {
            const mesh = this._meshes[kind];
            if (!mesh?.visible) continue;
            const hit = raycaster.intersectObject(mesh)[0];
            if (hit?.instanceId == null) continue;
            const data = this._items[kind][hit.instanceId];
            if (data) hits.push({
                distance: hit.distance,
                kind: kind === 'tides' ? 'tide' : kind === 'buoys' ? 'buoy' : 'dart',
                data,
            });
        }
        hits.sort((a, b) => a.distance - b.distance);
        return hits[0] ?? null;
    }
}
