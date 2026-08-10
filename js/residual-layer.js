/**
 * residual-layer.js — model-vs-observation PM2.5 residual markers on the
 * EarthView globe (/api/air-quality/residuals: CAMS sampled at OpenAQ
 * monitors).
 *
 * THE POINT: this layer shows where the model is WRONG. Diamond markers at
 * monitor locations, colored by the diverging residual = obs − model:
 * red-warm where CAMS underestimates the real reading (missed pollution),
 * blue-cool where it overestimates, near-transparent gray where the two
 * agree — agreement is deliberately quiet so disagreement is the picture.
 * Marker size grows with |residual|.
 *
 * Both values ride every row (obs, model, residual) and the hover tooltip
 * shows all three; nothing here blends the sources. Diverging ramp is
 * exported pure (residualColor) and node-gated in tests/intl-stations.mjs.
 *
 * States: the feed's configured:false (missing OPENAQ_API_KEY) renders as
 * setup, not failure — same contract as the stations layer it derives from.
 *
 * Interaction contract (mirrors js/city-markers.js):
 *   getHovered(raycaster) → { row, index } | null       (near-side only)
 *   setHighlight(index | -1)
 */

const FEED_URL = '/api/air-quality/residuals';
const REFRESH_MS = 15 * 60 * 1000;
const HIT_THRESHOLD = 0.014;
const RESIDUAL_SATURATION = 20;   // µg/m³ at which the ramp saturates

/**
 * Diverging residual ramp: −sat → strong blue, 0 → dim neutral gray,
 * +sat → strong red. Symmetric, clamped, NaN-safe.
 */
export function residualColor(residual, saturation = RESIDUAL_SATURATION) {
    if (!Number.isFinite(residual)) return [0.34, 0.39, 0.46];
    const t = Math.max(-1, Math.min(1, residual / saturation));
    const a = Math.abs(t);
    const neutral = [0.42, 0.46, 0.52];
    const warm = [1.00, 0.25, 0.15];    // model underestimates — missed pollution
    const cool = [0.20, 0.55, 1.00];    // model overestimates
    const target = t >= 0 ? warm : cool;
    return [
        neutral[0] + (target[0] - neutral[0]) * a,
        neutral[1] + (target[1] - neutral[1]) * a,
        neutral[2] + (target[2] - neutral[2]) * a,
    ];
}

/** Marker prominence from |residual| — agreement stays small and faint. */
export function residualStrength(residual, saturation = RESIDUAL_SATURATION) {
    if (!Number.isFinite(residual)) return 0;
    return Math.min(1, Math.abs(residual) / saturation);
}

export class ResidualLayer {
    /**
     * @param {object} THREE     three.js namespace (page-supplied)
     * @param {object} opts
     * @param {Function} opts.geoToXYZ  (lat, lon) → THREE.Vector3 unit sphere
     * @param {number}  [opts.radius]   marker shell radius (globe radii)
     * @param {Function}[opts.onStatus] (state, detail) → void
     */
    constructor(THREE, { geoToXYZ, radius = 1.0052, onStatus } = {}) {
        this._T = THREE;
        this._geoToXYZ = geoToXYZ;
        this._radius = radius;
        this._onStatus = onStatus ?? (() => {});
        this.rows = [];
        this.stats = null;
        this.updated = null;
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
                attribute float aStrength;
                attribute float aHi;
                uniform float uScale;
                varying vec3 vColor;
                varying float vStrength;
                varying float vHi;
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    vColor = aColor; vStrength = aStrength; vHi = aHi;
                    float sizePx = aSize * (1.0 + aHi * 0.9) * uScale / max(0.0001, -mv.z);
                    gl_PointSize = clamp(sizePx, 2.0, 30.0);
                    gl_Position = projectionMatrix * mv;
                }`,
            fragmentShader: `
                varying vec3 vColor;
                varying float vStrength;
                varying float vHi;
                void main() {
                    // Diamond (L1 metric) — "comparison", distinct from the
                    // observation squares and every round model marker.
                    vec2 d = abs(gl_PointCoord - 0.5) * 2.0;
                    float m = d.x + d.y;
                    if (m > 1.0) discard;
                    float rim = smoothstep(1.0, 0.78, m);
                    // Agreement stays deliberately faint (0.25 floor) so the
                    // globe reads as "where is the model wrong", not a carpet.
                    float a = rim * (0.25 + 0.75 * vStrength);
                    a = min(1.0, a + vHi * 0.35);
                    gl_FragColor = vec4(mix(vColor, vec3(1.0), vHi * 0.25), a);
                }`,
        });

        this._geo = new THREE.BufferGeometry();
        this._points = new THREE.Points(this._geo, this._mat);
        this._points.renderOrder = 11;
        this._points.visible = false;
        this.group = new THREE.Group();
        this.group.name = 'aq-residuals';
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
            const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(20_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (body.freshness !== 'live' || !body.residuals?.length) {
                const err = new Error(body.reason ?? 'feed is stale');
                err.configured = body.configured !== false;
                throw err;
            }
            this.rows = body.residuals;
            this.stats = body.stats;
            this.updated = body.updated;
            this._rebuild();
            this._onStatus('loaded', {
                count: this.rows.length,
                stats: this.stats,
                updated: body.updated,
                attribution: body.attribution,
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
        const n = this.rows.length;
        const pos = new Float32Array(n * 3);
        const size = new Float32Array(n);
        const color = new Float32Array(n * 3);
        const strength = new Float32Array(n);
        const hi = new Float32Array(n);

        for (let i = 0; i < n; i++) {
            const row = this.rows[i];
            const v = this._geoToXYZ(row.lat, row.lon).multiplyScalar(this._radius);
            pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
            const s = residualStrength(row.residual);
            strength[i] = s;
            size[i] = 0.008 + 0.009 * s;
            const [r, g, b] = residualColor(row.residual);
            color[i * 3] = r; color[i * 3 + 1] = g; color[i * 3 + 2] = b;
        }

        this._geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        this._geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
        this._geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
        this._geo.setAttribute('aStrength', new THREE.BufferAttribute(strength, 1));
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
        if (!this.group.visible || !this.rows.length || !this._points.visible) return null;
        const prev = raycaster.params.Points;
        raycaster.params.Points = { threshold: HIT_THRESHOLD };
        const hits = raycaster.intersectObject(this._points, false);
        raycaster.params.Points = prev;
        if (!hits.length) return null;
        this._points.updateWorldMatrix(true, false);
        const posAttr = this._geo.getAttribute('position');
        for (const hit of hits) {
            const i = hit.index;
            if (i == null || !this.rows[i]) continue;
            this._vWorld.fromBufferAttribute(posAttr, i)
                .applyMatrix4(this._points.matrixWorld);
            this._vCam.copy(raycaster.ray.origin).sub(this._vWorld);
            if (this._vWorld.dot(this._vCam) <= 0) continue;   // far side
            return { row: this.rows[i], index: i };
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

export default ResidualLayer;
