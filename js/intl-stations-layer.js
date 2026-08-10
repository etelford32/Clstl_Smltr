/**
 * intl-stations-layer.js — international ground-monitor observations on the
 * EarthView globe (OpenAQ v3 via /api/air-quality/stations-intl).
 *
 * These are OBSERVATIONS — real reference monitors reporting PM2.5 — and
 * the marker style says so: small squares (instruments), visually distinct
 * from the CAMS model surfaces (heatmap gradient, pollution rings, numeric
 * grid sprites). Colored on the SHARED EPA PM2.5 stops so a monitor and the
 * model field around it are directly comparable at a glance; where they
 * disagree, that disagreement is the interesting part and must stay visible
 * — never blend or reconcile the two.
 *
 * License: OpenAQ data is CC BY 4.0 — the attribution string rides the feed
 * response and this layer keeps it in the hover hint and the pill title.
 * Keep the attribution when touching either.
 *
 * States (onStatus): the feed distinguishes `configured:false` (the
 * OPENAQ_API_KEY env var isn't set — an actionable setup state, shown as
 * such) from a configured-but-failing upstream (a real error). Neither may
 * render as a quiet empty layer.
 *
 * Interaction contract (mirrors js/city-markers.js):
 *   getHovered(raycaster) → { station, index } | null    (near-side only)
 *   setHighlight(index | -1)
 * Hover/tap wiring lives with the shared raycast handlers in earth.html.
 */

import { airQualityMetricColor } from './air-quality-frame.js';
import { heatColor } from './aqi-heatmap-layer.js';

const FEED_URL = '/api/air-quality/stations-intl';
const REFRESH_MS = 15 * 60 * 1000;
const HIT_THRESHOLD = 0.014;      // tighter than city dots — monitors cluster

// Black carbon is the one station species with no CAMS twin (that absence
// is exactly why it's valuable here). WHO names no guideline; the ramp is
// shaped to urban reality — ~1 µg/m³ clean, 2–4 traffic, 8+ severe.
const BC_STOPS = [
    [0.5, 0.10, 0.88, 0.48], [2, 1.00, 0.86, 0.18],
    [4, 1.00, 0.49, 0.05], [8, 1.00, 0.15, 0.18], [15, 0.62, 0.25, 0.78],
];
function bcRamp(v) {
    if (!Number.isFinite(v)) return [0.34, 0.39, 0.46];
    if (v <= BC_STOPS[0][0]) return BC_STOPS[0].slice(1);
    for (let i = 1; i < BC_STOPS.length; i++) {
        if (v <= BC_STOPS[i][0]) {
            const [v0, r0, g0, b0] = BC_STOPS[i - 1];
            const [v1, r1, g1, b1] = BC_STOPS[i];
            const t = (v - v0) / (v1 - v0);
            return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t];
        }
    }
    return BC_STOPS[BC_STOPS.length - 1].slice(1);
}

// Per-species severity ceiling for marker sizing (native µg/m³).
const SIZE_CEIL = Object.freeze({
    pm25: 100, pm10: 200, o3: 200, no2: 120, so2: 150, co: 3000, bc: 10,
});

/**
 * Station species → [r, g, b]. Particulates reuse the SHARED EPA stops and
 * the gases reuse the heatmap's WHO-shaped ramps — a monitor and the model
 * field behind it are colored on the same scale by construction, so where
 * their colors differ, the SOURCES differ. Only BC has its own ramp.
 */
export function stationColor(species, value) {
    if (species === 'pm10') return airQualityMetricColor('pm10', value);
    if (species === 'o3' || species === 'no2' || species === 'so2' || species === 'co') {
        return heatColor(species, value);
    }
    if (species === 'bc') return bcRamp(value);
    return airQualityMetricColor('pm25', value);
}

export class IntlStationsLayer {
    /**
     * @param {object} THREE     three.js namespace (page-supplied)
     * @param {object} opts
     * @param {Function} opts.geoToXYZ  (lat, lon) → THREE.Vector3 unit sphere
     * @param {number}  [opts.radius]   marker shell radius (globe radii)
     * @param {Function}[opts.onStatus] (state, detail) → void
     */
    constructor(THREE, { geoToXYZ, radius = 1.0045, onStatus } = {}) {
        this._T = THREE;
        this._geoToXYZ = geoToXYZ;
        this._radius = radius;
        this._onStatus = onStatus ?? (() => {});
        this.stations = [];
        this.updated = null;
        this.species = 'pm25';
        this.speciesLabel = 'PM2.5';
        this.speciesUnit = 'µg/m³';
        this.attribution = 'OpenAQ · CC BY 4.0';
        this._hiIndex = -1;
        this._timer = null;
        this._inflight = null;
        this._vWorld = new THREE.Vector3();
        this._vCam = new THREE.Vector3();

        this._mat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false,
            uniforms: {
                uScale: { value: 600 },
            },
            vertexShader: `
                attribute float aSize;
                attribute vec3 aColor;
                attribute float aHi;
                uniform float uScale;
                varying vec3 vColor;
                varying float vHi;
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    vColor = aColor; vHi = aHi;
                    float sizePx = aSize * (1.0 + aHi * 0.9) * uScale / max(0.0001, -mv.z);
                    gl_PointSize = clamp(sizePx, 2.0, 26.0);
                    gl_Position = projectionMatrix * mv;
                }`,
            fragmentShader: `
                varying vec3 vColor;
                varying float vHi;
                void main() {
                    // Square marker with a thin dark rim — "instrument", not
                    // the round glow language of the model layers.
                    vec2 d = abs(gl_PointCoord - 0.5) * 2.0;
                    float m = max(d.x, d.y);
                    if (m > 0.9) discard;
                    float rim = smoothstep(0.9, 0.72, m);
                    vec3 col = mix(vec3(0.02, 0.05, 0.08), vColor, rim);
                    float a = 0.92 * rim + 0.35 * (1.0 - rim);
                    a = min(1.0, a + vHi * 0.3);
                    gl_FragColor = vec4(mix(col, vec3(1.0), vHi * 0.25), a);
                }`,
        });

        this._geo = new THREE.BufferGeometry();
        this._points = new THREE.Points(this._geo, this._mat);
        this._points.renderOrder = 11;
        this._points.visible = false;
        this.group = new THREE.Group();
        this.group.name = 'intl-stations';
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

    /** Switch the observed species; refetches (each species is its own
     *  OpenAQ parameter feed, CDN-cached per query string). */
    setSpecies(species) {
        if (species === this.species) return;
        this.species = species;
        this.stations = [];
        this._points.visible = false;
        if (this.group.visible) this._refresh();
    }

    async _refresh() {
        if (this._inflight) return;
        this._onStatus('fetching', {});
        const requested = this.species;
        this._inflight = (async () => {
            const res = await fetch(`${FEED_URL}?species=${encodeURIComponent(requested)}`,
                { signal: AbortSignal.timeout(15_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (requested !== this.species) return;   // stale response — user re-switched
            if (body.attribution) this.attribution = body.attribution;
            this.speciesLabel = body.label ?? requested;
            this.speciesUnit = body.unit ?? 'µg/m³';
            if (body.freshness !== 'live' || !body.stations?.length) {
                // Setup state vs failure state — the page shows them
                // differently, so keep the distinction on the error object.
                const err = new Error(body.reason ?? 'feed is stale');
                err.configured = body.configured !== false;
                throw err;
            }
            this.stations = body.stations;
            this.updated = body.updated;
            this._rebuild();
            this._onStatus('loaded', {
                count: this.stations.length,
                updated: body.updated,
                species: requested,
                label: this.speciesLabel,
                unit: this.speciesUnit,
                attribution: this.attribution,
            });
        })().catch(err => {
            this._onStatus('error', {
                error: err?.message ?? 'fetch failed',
                configured: err?.configured !== false,
                species: requested,
                label: this.speciesLabel,
            });
        }).finally(() => { this._inflight = null; });
        await this._inflight;
    }

    _rebuild() {
        const THREE = this._T;
        const n = this.stations.length;
        const pos = new Float32Array(n * 3);
        const size = new Float32Array(n);
        const color = new Float32Array(n * 3);
        const hi = new Float32Array(n);

        const ceil = SIZE_CEIL[this.species] ?? 100;
        for (let i = 0; i < n; i++) {
            const s = this.stations[i];
            const v = this._geoToXYZ(s.lat, s.lon).multiplyScalar(this._radius);
            pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
            // Modest severity sizing — a thousand markers must read as a
            // network, not a carpet. 0.007 clean → 0.013 at the ceiling.
            const val = Number.isFinite(s.value) ? s.value : 0;
            size[i] = 0.007 + 0.006 * Math.min(1, val / ceil);
            const [r, g, b] = stationColor(this.species, Number.isFinite(s.value) ? s.value : NaN);
            color[i * 3] = r; color[i * 3 + 1] = g; color[i * 3 + 2] = b;
        }

        this._geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        this._geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
        this._geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
        this._geo.setAttribute('aHi', new THREE.BufferAttribute(hi, 1));
        this._hiAttr = this._geo.getAttribute('aHi');
        this._hiIndex = -1;
        this._points.visible = n > 0;
    }

    tick(_t, pixelScale) {
        if (Number.isFinite(pixelScale)) this._mat.uniforms.uScale.value = pixelScale;
    }

    /** Near-side hit test against the shared hover raycaster. */
    getHovered(raycaster) {
        if (!this.group.visible || !this.stations.length || !this._points.visible) return null;
        const prev = raycaster.params.Points;
        raycaster.params.Points = { threshold: HIT_THRESHOLD };
        const hits = raycaster.intersectObject(this._points, false);
        raycaster.params.Points = prev;
        if (!hits.length) return null;
        this._points.updateWorldMatrix(true, false);
        const posAttr = this._geo.getAttribute('position');
        for (const hit of hits) {
            const i = hit.index;
            if (i == null || !this.stations[i]) continue;
            this._vWorld.fromBufferAttribute(posAttr, i)
                .applyMatrix4(this._points.matrixWorld);
            this._vCam.copy(raycaster.ray.origin).sub(this._vWorld);
            if (this._vWorld.dot(this._vCam) <= 0) continue;   // far side
            return { station: this.stations[i], index: i };
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

export default IntlStationsLayer;
