/**
 * pollution-centers-layer.js — real-time city pollution markers on the
 * EarthView globe.
 *
 * Renders the /api/air-quality/centers feed (one batched CAMS sample of the
 * top ~100 major-cities.js metros) as ONE THREE.Points draw call: a ring
 * marker per city, colored by the EPA AQI scale via the shared
 * airQualityMetricColor stops (so this layer, the numeric AQI grid, and the
 * verdict card can never disagree on what "unhealthy" looks like), sized by
 * AQI severity, with a slow alert pulse on cities at AQI ≥ 150.
 *
 * This is MODELED CAMS data — the feed's provenance rides along and the
 * hover card must keep saying "CAMS modeled", never "measured".
 *
 * Interaction contract (mirrors js/city-markers.js):
 *   getHovered(raycaster) → { center, index } | null      (near-side only)
 *   setHighlight(index | -1)
 * Hover/tap wiring lives with the shared raycast handlers in earth.html.
 *
 * Lifecycle: setVisible(true) triggers the first fetch and a 15-min refresh
 * timer; setVisible(false) stops the timer (data is kept for re-enable).
 * Status flows through onStatus(state, detail) — 'idle' | 'fetching' |
 * 'loaded' | 'error'; a feed answering 200 + freshness:'stale' reports
 * 'error' with its reason, because a silently empty layer is the failure
 * mode this repo keeps re-learning to avoid.
 */

import { airQualityMetricColor } from './air-quality-frame.js';

const FEED_URL = '/api/air-quality/centers';
const REFRESH_MS = 15 * 60 * 1000;
const HIT_THRESHOLD = 0.024;      // world units (globe R = 1); ~150 km grab
const ALERT_AQI = 150;            // pulse threshold — EPA "unhealthy"

export class PollutionCentersLayer {
    /**
     * @param {object} THREE     three.js namespace (page-supplied)
     * @param {object} opts
     * @param {Function} opts.geoToXYZ  (lat, lon) → THREE.Vector3 unit sphere
     * @param {number}  [opts.radius]   marker shell radius (globe radii)
     * @param {Function}[opts.onStatus] (state, detail) → void
     */
    constructor(THREE, { geoToXYZ, radius = 1.006, onStatus } = {}) {
        this._T = THREE;
        this._geoToXYZ = geoToXYZ;
        this._radius = radius;
        this._onStatus = onStatus ?? (() => {});
        this.centers = [];
        this.updated = null;
        this._hiIndex = -1;
        this._timer = null;
        this._inflight = null;
        this._vWorld = new THREE.Vector3();
        this._vCam = new THREE.Vector3();

        this._mat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uTime:  { value: 0 },
                uScale: { value: 600 },
            },
            vertexShader: `
                attribute float aSize;
                attribute vec3 aColor;
                attribute float aPulse;
                attribute float aHi;
                uniform float uTime;
                uniform float uScale;
                varying vec3 vColor;
                varying float vHi;
                varying float vPulse;
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    // Slow 1.6 s alert pulse on unhealthy cities only.
                    float pulse = aPulse * (0.5 + 0.5 * sin(uTime * 3.9));
                    vColor = aColor; vHi = aHi; vPulse = pulse;
                    float sizePx = aSize * (1.0 + aHi * 0.7 + pulse * 0.35)
                        * uScale / max(0.0001, -mv.z);
                    gl_PointSize = clamp(sizePx, 3.0, 46.0);
                    gl_Position = projectionMatrix * mv;
                }`,
            fragmentShader: `
                varying vec3 vColor;
                varying float vHi;
                varying float vPulse;
                void main() {
                    vec2 d = gl_PointCoord - 0.5;
                    float r = length(d) * 2.0;
                    if (r > 1.0) discard;
                    // Ring marker: hollow center distinguishes these from the
                    // solid city dots and the square AQ grid sprites.
                    float ring = smoothstep(0.30, 0.42, r) * smoothstep(0.95, 0.72, r);
                    float core = smoothstep(0.22, 0.0, r) * 0.55;
                    float halo = pow(max(0.0, 1.0 - r), 2.4) * (0.30 + vPulse * 0.55);
                    float a = ring * 0.95 + core + halo;
                    a = min(1.0, a + vHi * 0.35);
                    vec3 col = mix(vColor, vec3(1.0), core * 0.6 + vHi * 0.25);
                    gl_FragColor = vec4(col, a);
                }`,
        });

        this._geo = new THREE.BufferGeometry();
        this._points = new THREE.Points(this._geo, this._mat);
        this._points.renderOrder = 11;
        this._points.visible = false;
        this.group = new THREE.Group();
        this.group.name = 'pollution-centers';
        this.group.visible = false;
        this.group.add(this._points);
    }

    get visible() { return this.group.visible; }

    setVisible(v) {
        this.group.visible = !!v;
        if (v) {
            this._refresh();
            if (!this._timer) this._timer = setInterval(() => this._refresh(), REFRESH_MS);
        } else {
            clearInterval(this._timer);
            this._timer = null;
            this._onStatus('idle', { label: 'off' });
        }
    }

    async _refresh() {
        if (this._inflight) return;
        this._onStatus('fetching', {});
        this._inflight = (async () => {
            const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(15_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (body.freshness !== 'live' || !body.cities?.length) {
                throw new Error(body.error ?? 'feed is stale');
            }
            this.centers = body.cities;
            this.updated = body.updated;
            this._rebuild();
            const worst = [...body.cities].filter(c => c.aqi != null)
                .sort((a, b) => b.aqi - a.aqi)[0];
            this._onStatus('loaded', {
                count: body.cities.length,
                updated: body.updated,
                worst: worst ? `${worst.name} ${Math.round(worst.aqi)}` : null,
                provenance: body.provenance,
            });
        })().catch(err => {
            this._onStatus('error', { error: err?.message ?? 'fetch failed' });
        }).finally(() => { this._inflight = null; });
        await this._inflight;
    }

    _rebuild() {
        const THREE = this._T;
        const n = this.centers.length;
        const pos = new Float32Array(n * 3);
        const size = new Float32Array(n);
        const color = new Float32Array(n * 3);
        const pulse = new Float32Array(n);
        const hi = new Float32Array(n);

        for (let i = 0; i < n; i++) {
            const c = this.centers[i];
            const v = this._geoToXYZ(c.lat, c.lon).multiplyScalar(this._radius);
            pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
            const aqi = Number.isFinite(c.aqi) ? c.aqi : 0;
            // Severity-first sizing: a clean megacity stays small, a smoggy
            // one grows. 0.010 at AQI 0 → 0.030 at AQI 300+.
            size[i] = 0.010 + 0.020 * Math.min(1, aqi / 300);
            const [r, g, b] = airQualityMetricColor('aqi', Number.isFinite(c.aqi) ? c.aqi : NaN);
            color[i * 3] = r; color[i * 3 + 1] = g; color[i * 3 + 2] = b;
            pulse[i] = aqi >= ALERT_AQI ? 1 : 0;
        }

        this._geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        this._geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
        this._geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
        this._geo.setAttribute('aPulse', new THREE.BufferAttribute(pulse, 1));
        this._geo.setAttribute('aHi', new THREE.BufferAttribute(hi, 1));
        this._hiAttr = this._geo.getAttribute('aHi');
        this._hiIndex = -1;
        this._points.visible = n > 0;
    }

    tick(t, pixelScale) {
        this._mat.uniforms.uTime.value = t;
        if (Number.isFinite(pixelScale)) this._mat.uniforms.uScale.value = pixelScale;
    }

    /** Near-side hit test against the shared hover raycaster. */
    getHovered(raycaster) {
        if (!this.group.visible || !this.centers.length || !this._points.visible) return null;
        const prev = raycaster.params.Points;
        raycaster.params.Points = { threshold: HIT_THRESHOLD };
        const hits = raycaster.intersectObject(this._points, false);
        raycaster.params.Points = prev;
        if (!hits.length) return null;
        this._points.updateWorldMatrix(true, false);
        const posAttr = this._geo.getAttribute('position');
        for (const hit of hits) {
            const i = hit.index;
            if (i == null || !this.centers[i]) continue;
            this._vWorld.fromBufferAttribute(posAttr, i)
                .applyMatrix4(this._points.matrixWorld);
            this._vCam.copy(raycaster.ray.origin).sub(this._vWorld);
            if (this._vWorld.dot(this._vCam) <= 0) continue;   // far side
            return { center: this.centers[i], index: i };
        }
        return null;
    }

    setHighlight(index) {
        if (!this._hiAttr || index === this._hiIndex) return;
        if (this._hiIndex >= 0) this._hiAttr.setX(this._hiIndex, 0);
        if (index >= 0) this._hiAttr.setX(index, 1);
        this._hiIndex = index;
        this._hiAttr.needsUpdate = true;
    }

    dispose() {
        clearInterval(this._timer);
        this._geo.dispose();
        this._mat.dispose();
        this.group.parent?.remove(this.group);
    }
}

export default PollutionCentersLayer;
