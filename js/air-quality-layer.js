/**
 * EarthView numeric air-quality LOD layer.
 *
 * Far view       — sparse global CAMS model samples
 * Regional zoom  — 5° CAMS sample grid around the camera focus
 * Close zoom     — 2.5° CAMS grid plus preliminary AirNow monitors
 *
 * All requests follow the shared time bus. Observation frames are staged in
 * IndexedDB; model frames are memory-only so a stale forecast never survives
 * a reload. NASA GIBS imagery remains a separate visual backdrop.
 */

import {
    AIR_QUALITY_METRICS,
    CAMS_PROVENANCE,
    AIRNOW_PROVENANCE,
    airQualityMetricColor,
    buildCamsGrid,
    frameRequestKey,
    resolveAirQualityTime,
} from './air-quality-frame.js';
import { AirQualityFrameStore } from './air-quality-frame-store.js';

const GRID_URL = '/api/air-quality/grid';
const STATIONS_URL = '/api/air-quality/stations';
const SETTLE_MS = 550;
const LOD_SETTLE_MS = 350;
const REFRESH_MS = 15 * 60_000;

export function airQualityLod(cameraDistance) {
    const distance = Number(cameraDistance);
    return {
        detail: distance <= 1.22 ? 'local' : distance <= 1.65 ? 'regional' : 'global',
        showStations: distance <= 1.45,
    };
}

function metricValue(point, metric) {
    return Number.isFinite(point?.[metric]) ? point[metric] : null;
}

function fallbackFrame(grid, requestedMs) {
    const retrievedAt = new Date().toISOString();
    return {
        schema: 'pp.air-quality.frame.v1',
        id: `reference:${grid.scope.key}`,
        requestKey: `reference:${grid.scope.key}`,
        requestedAt: new Date(requestedMs).toISOString(),
        validAt: new Date(requestedMs).toISOString(),
        retrievedAt,
        temporalMode: 'unavailable',
        provenance: {
            id: 'air-quality-reference-grid', provider: 'EarthView',
            dataset: 'No-data reference geometry', kind: 'reference',
            label: 'No numeric data available', isGroundObservation: false,
        },
        scope: grid.scope,
        units: {},
        fallback: true,
        points: grid.coordinates.map((point, index) => ({
            id: `reference-${index}`, ...point, aqi: null, pm25: null, pm10: null, aod: null,
        })),
    };
}

export class AirQualityLayer {
    constructor(THREE, parent, { geoToXYZ, onStatus, forceFallback = false } = {}) {
        this.THREE = THREE;
        this.parent = parent;
        this.geoToXYZ = geoToXYZ;
        this.onStatus = onStatus ?? (() => {});
        this.forceFallback = Boolean(forceFallback);
        this.store = new AirQualityFrameStore();
        this.group = new THREE.Group();
        this.group.name = 'air-quality-numeric-lod';
        this.group.visible = false;
        parent.add(this.group);

        this.enabled = false;
        this.metric = 'aqi';
        this.simTimeMs = Date.now();
        this.focusLat = 0;
        this.focusLon = 0;
        this.cameraDistance = 3;
        this.detail = 'global';
        this.showStations = false;
        this._modelFrame = null;
        this._stationFrame = null;
        this._modelMesh = null;
        this._stationMesh = null;
        this._modelItems = [];
        this._stationItems = [];
        this._timer = null;
        this._refreshTimer = null;
        this._pendingSignature = null;
        this._activeSignature = null;
        this._requestSeq = 0;
        this._forceRefresh = false;
        this._inflight = new Map();
        this._dummy = new THREE.Object3D();
        this._color = new THREE.Color();
        this.ready = this.store.open();
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
        this.group.visible = this.enabled;
        if (!this.enabled) {
            clearTimeout(this._timer);
            clearInterval(this._refreshTimer);
            this._timer = null;
            this._refreshTimer = null;
            this._pendingSignature = null;
            this.onStatus('idle', { label: 'off' });
            return;
        }
        if (!this._refreshTimer) {
            this._refreshTimer = setInterval(() => {
                this._forceRefresh = true;
                this._activeSignature = null;
                this._schedule(true);
            }, REFRESH_MS);
        }
        this._schedule(true);
    }

    setMetric(metric) {
        if (!AIR_QUALITY_METRICS[metric] || metric === this.metric) return;
        this.metric = metric;
        if (this._modelFrame) this._paint(this._modelFrame, this._stationFrame);
        this._emitLoadedStatus();
    }

    setTime(simTimeMs) {
        if (!Number.isFinite(simTimeMs)) return;
        this.simTimeMs = simTimeMs;
        if (this.enabled) this._schedule(false);
    }

    /** Called from EarthView's existing animation LOD path. */
    updateLOD(cameraDistance, focusLat, focusLon) {
        if (Number.isFinite(cameraDistance)) this.cameraDistance = cameraDistance;
        if (Number.isFinite(focusLat)) this.focusLat = focusLat;
        if (Number.isFinite(focusLon)) this.focusLon = focusLon;
        const lod = airQualityLod(this.cameraDistance);
        const grid = buildCamsGrid(lod.detail, this.focusLat, this.focusLon);
        const changed = lod.detail !== this.detail || lod.showStations !== this.showStations
            || grid.scope.key !== this._grid()?.scope.key;
        this.detail = lod.detail;
        this.showStations = lod.showStations;
        if (changed && this.enabled) this._schedule(false, LOD_SETTLE_MS);
    }

    _grid() {
        return buildCamsGrid(this.detail, this.focusLat, this.focusLon);
    }

    _signature() {
        const timing = resolveAirQualityTime({ simTimeMs: this.simTimeMs });
        return `${timing.key}|${this._grid().scope.key}|${this.showStations ? 'stations' : 'grid'}`;
    }

    _schedule(immediate = false, delay = SETTLE_MS) {
        const signature = this._signature();
        if (!immediate && signature === this._pendingSignature && this._timer) return;
        if (!immediate && signature === this._activeSignature) return;
        clearTimeout(this._timer);
        this._pendingSignature = signature;
        this._timer = setTimeout(() => {
            this._timer = null;
            this._pendingSignature = null;
            this._sync(signature);
        }, immediate ? 0 : delay);
    }

    async _sync(signature) {
        if (!this.enabled || signature !== this._signature()) return;
        const seq = ++this._requestSeq;
        await this.ready;
        const timing = resolveAirQualityTime({ simTimeMs: this.simTimeMs });
        const grid = this._grid();
        const forceRefresh = this._forceRefresh;
        this._forceRefresh = false;
        this.onStatus('fetching', {
            detail: this.detail,
            mode: timing.mode,
            metric: this.metric,
            requestedAt: new Date(timing.targetMs).toISOString(),
        });

        const modelRequestKey = frameRequestKey(CAMS_PROVENANCE.id, grid.scope.key, timing.targetMs);
        const modelParams = new URLSearchParams({
            at: new Date(timing.targetMs).toISOString(),
            detail: this.detail,
            lat: this.focusLat.toFixed(3),
            lon: this.focusLon.toFixed(3),
        });
        const modelTask = timing.modelAvailable
            ? this._loadFrame(modelRequestKey, `${GRID_URL}?${modelParams}`, { bypassCache: forceRefresh })
            : Promise.resolve({ frame: null, cacheHit: false, unavailable: true });

        let stationTask = Promise.resolve({ frame: null, cacheHit: false, unavailable: true });
        if (this.showStations && timing.observationsAvailable) {
            const stationScope = this._stationScope();
            const stationRequestKey = frameRequestKey(
                AIRNOW_PROVENANCE.id, stationScope.key, timing.targetMs);
            const stationParams = new URLSearchParams({
                at: new Date(timing.targetMs).toISOString(),
                lat: this.focusLat.toFixed(3),
                lon: this.focusLon.toFixed(3),
                span: String(stationScope.spanDeg),
            });
            stationTask = this._loadFrame(stationRequestKey, `${STATIONS_URL}?${stationParams}`, {
                bypassCache: forceRefresh,
                minValidMs: timing.mode === 'live' ? timing.targetMs : null,
            });
        }

        const [modelResult, stationResult] = await Promise.all([modelTask, stationTask]);
        if (!this.enabled || seq !== this._requestSeq || signature !== this._signature()) return;
        const modelFrame = modelResult.frame ?? fallbackFrame(grid, timing.targetMs);
        this._modelFrame = modelFrame;
        this._stationFrame = stationResult.frame;
        this._activeSignature = signature;
        this._paint(modelFrame, stationResult.frame);

        if (!modelResult.frame) {
            this.onStatus('fallback', {
                detail: this.detail,
                mode: timing.mode,
                metric: this.metric,
                requestedAt: new Date(timing.targetMs).toISOString(),
                modelCount: 0,
                stationCount: stationResult.frame?.points?.length ?? 0,
                error: modelResult.error || (timing.modelAvailable
                    ? 'CAMS grid unavailable' : 'No CAMS frame at this timeline time'),
            });
        } else {
            this._emitLoadedStatus({
                timing,
                modelCacheHit: modelResult.cacheHit,
                stationCacheHit: stationResult.cacheHit,
                stationError: stationResult.error,
            });
        }
    }

    _stationScope() {
        const centerLat = Math.round(this.focusLat / 5) * 5;
        const centerLon = ((Math.round(this.focusLon / 5) * 5 + 540) % 360) - 180;
        const spanDeg = this.detail === 'local' ? 10 : 20;
        return {
            key: `stations-${centerLat.toFixed(0)}-${centerLon.toFixed(0)}-${spanDeg}`,
            kind: 'stations', centerLat, centerLon, spanDeg,
        };
    }

    async _loadFrame(requestKey, url, { bypassCache = false, minValidMs = null } = {}) {
        if (this.forceFallback) {
            return { frame: null, cacheHit: false, error: 'locally forced no-data verification' };
        }
        const cached = bypassCache ? null : await this.store.get(requestKey);
        const cachedValidMs = cached ? Date.parse(cached.validAt) : NaN;
        if (cached && (!Number.isFinite(minValidMs) || cachedValidMs >= minValidMs)) {
            return { frame: cached, cacheHit: true };
        }
        if (this._inflight.has(requestKey)) return this._inflight.get(requestKey);
        const task = fetch(url, { signal: AbortSignal.timeout(18000) })
            .then(async response => {
                const body = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
                if (!body.available || !body.frame) return {
                    frame: null, cacheHit: false, unavailable: true,
                    error: body.reason || 'No frame available',
                };
                await this.store.put(body.frame);
                return { frame: body.frame, cacheHit: false };
            })
            .catch(error => ({ frame: null, cacheHit: false, error: error.message }))
            .finally(() => this._inflight.delete(requestKey));
        this._inflight.set(requestKey, task);
        return task;
    }

    _paint(modelFrame, stationFrame) {
        this._replaceMesh('model', this._buildMesh(modelFrame, 'model'));
        this._replaceMesh('station', this.showStations && stationFrame
            ? this._buildMesh(stationFrame, 'station') : null);
        this.group.visible = this.enabled;
    }

    _replaceMesh(kind, mesh) {
        const field = kind === 'model' ? '_modelMesh' : '_stationMesh';
        const old = this[field];
        if (old) {
            this.group.remove(old);
            old.geometry?.dispose();
            old.material?.dispose();
        }
        this[field] = mesh;
        if (mesh) this.group.add(mesh);
    }

    _buildMesh(frame, kind) {
        const fallback = Boolean(frame?.fallback);
        const points = (frame?.points ?? []).filter(point =>
            fallback || metricValue(point, this.metric) != null);
        const itemField = kind === 'model' ? '_modelItems' : '_stationItems';
        this[itemField] = points.map(point => ({ point, frame, kind }));
        if (!points.length) return null;

        const geometry = kind === 'station'
            ? new this.THREE.OctahedronGeometry(1, 0)
            : new this.THREE.SphereGeometry(1, 8, 6);
        const material = new this.THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: kind === 'station' ? 0.96 : fallback ? 0.34 : 0.72,
            blending: this.THREE.AdditiveBlending,
            depthWrite: false,
            toneMapped: false,
        });
        const mesh = new this.THREE.InstancedMesh(geometry, material, points.length);
        const baseScale = kind === 'station' ? 0.010
            : this.detail === 'global' ? 0.017 : this.detail === 'regional' ? 0.011 : 0.008;
        for (let index = 0; index < points.length; index++) {
            const point = points[index];
            const value = metricValue(point, this.metric);
            this._dummy.position.copy(this.geoToXYZ(point.lat, point.lon)).multiplyScalar(1.038);
            const severityBoost = value == null ? 1 : 1 + Math.min(0.55,
                this.metric === 'aod' ? value * 0.45 : value / 600);
            this._dummy.scale.setScalar(baseScale * severityBoost);
            this._dummy.updateMatrix();
            mesh.setMatrixAt(index, this._dummy.matrix);
            const [r, g, b] = airQualityMetricColor(this.metric, value, fallback);
            this._color.setRGB(r, g, b);
            mesh.setColorAt(index, this._color);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.name = kind === 'station' ? 'airnow-monitor-observations' : 'cams-air-quality-grid';
        mesh.userData.airQualityKind = kind;
        mesh.renderOrder = kind === 'station' ? 28 : 27;
        return mesh;
    }

    _emitLoadedStatus(extra = {}) {
        if (!this.enabled || !this._modelFrame || this._modelFrame.fallback) return;
        const timing = extra.timing ?? resolveAirQualityTime({ simTimeMs: this.simTimeMs });
        this.onStatus('loaded', {
            detail: this.detail,
            mode: timing.mode,
            metric: this.metric,
            requestedAt: new Date(timing.targetMs).toISOString(),
            validAt: this._modelFrame.validAt,
            modelCount: this._modelItems.length,
            stationCount: this._stationItems.length,
            modelCacheHit: extra.modelCacheHit,
            stationCacheHit: extra.stationCacheHit,
            stationError: extra.stationError,
            showStations: this.showStations,
        });
    }

    getHovered(raycaster) {
        if (!this.enabled || !this.group.visible) return null;
        const candidates = [];
        for (const [mesh, items] of [[this._stationMesh, this._stationItems], [this._modelMesh, this._modelItems]]) {
            if (!mesh?.visible) continue;
            const hit = raycaster.intersectObject(mesh)[0];
            if (hit?.instanceId == null) continue;
            const item = items[hit.instanceId];
            if (item) candidates.push({ ...item, distance: hit.distance, metric: this.metric });
        }
        candidates.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'station' ? -1 : 1;
            return a.distance - b.distance;
        });
        return candidates[0] ?? null;
    }

    getSnapshot() {
        return {
            enabled: this.enabled,
            metric: this.metric,
            detail: this.detail,
            showStations: this.showStations,
            modelFrame: this._modelFrame,
            stationFrame: this._stationFrame,
        };
    }
}

export default AirQualityLayer;
