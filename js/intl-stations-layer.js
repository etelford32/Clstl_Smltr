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

const FEED_URL = '/api/air-quality/stations-intl';
const REFRESH_MS = 15 * 60 * 1000;
const HIT_THRESHOLD = 0.014;      // tighter than city dots — monitors cluster

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

    async _refresh() {
        if (this._inflight) return;
        this._onStatus('fetching', {});
        this._inflight = (async () => {
            const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(15_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (body.attribution) this.attribution = body.attribution;
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
                attribution: this.attribution,
            });
        })().catch(err => {
            this._onStatus('error', {
                error: err?.message ?? 'fetch failed',
                configured: err?.configured !== false,
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

        for (let i = 0; i < n; i++) {
            const s = this.stations[i];
            const v = this._geoToXYZ(s.lat, s.lon).multiplyScalar(this._radius);
            pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
            // Modest severity sizing — a thousand markers must read as a
            // network, not a carpet. 0.007 clean → 0.013 at 100+ µg/m³.
            const pm = Number.isFinite(s.pm25) ? s.pm25 : 0;
            size[i] = 0.007 + 0.006 * Math.min(1, pm / 100);
            const [r, g, b] = airQualityMetricColor('pm25', Number.isFinite(s.pm25) ? s.pm25 : NaN);
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
