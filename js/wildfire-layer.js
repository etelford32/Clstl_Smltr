/**
 * wildfire-layer.js — named active-wildfire event markers on the EarthView
 * globe.
 *
 * Renders /api/wildfires/events (NASA EONET v3 open wildfire events) as ONE
 * THREE.Points draw call of flickering ember markers:
 *   - size grows with log(acreage) where EONET reports it,
 *   - brightness fades with days since the event's last update, so a fire
 *     EONET hasn't touched in weeks reads as an ember, not a fresh ignition,
 *   - a fast per-marker flicker keeps them visually distinct from every
 *     other point layer on the globe.
 *
 * This layer is the DISCRETE, clickable event list. The "Active Fires" row
 * in the Observations section is NASA GIBS thermal-anomaly IMAGERY — the
 * two are complements, not duplicates; do not merge them.
 *
 * Interaction contract (mirrors js/city-markers.js):
 *   getHovered(raycaster) → { fire, index } | null       (near-side only)
 *   setHighlight(index | -1)
 * Hover/tap wiring lives with the shared raycast handlers in earth.html.
 *
 * Lifecycle: setVisible(true) triggers the first fetch and a 30-min refresh
 * timer (EONET curates ~2×/day, 30 min keeps the CDN warm without hammering
 * it); setVisible(false) stops the timer. Status via onStatus(state, detail)
 * — a 200 + freshness:'stale' reports 'error' with the upstream's reason so
 * a dead feed never renders as a quiet, empty, healthy-looking layer.
 */

const FEED_URL = '/api/wildfires/events';
const REFRESH_MS = 30 * 60 * 1000;
const HIT_THRESHOLD = 0.022;      // world units (globe R = 1); ~140 km grab

export class WildfireLayer {
    /**
     * @param {object} THREE     three.js namespace (page-supplied)
     * @param {object} opts
     * @param {Function} opts.geoToXYZ  (lat, lon) → THREE.Vector3 unit sphere
     * @param {number}  [opts.radius]   marker shell radius (globe radii)
     * @param {Function}[opts.onStatus] (state, detail) → void
     */
    constructor(THREE, { geoToXYZ, radius = 1.005, onStatus } = {}) {
        this._T = THREE;
        this._geoToXYZ = geoToXYZ;
        this._radius = radius;
        this._onStatus = onStatus ?? (() => {});
        this.fires = [];
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
                attribute float aFade;
                attribute float aPhase;
                attribute float aHi;
                uniform float uTime;
                uniform float uScale;
                varying float vFade;
                varying float vHi;
                varying float vFlick;
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    // Two incommensurate sines ≈ campfire flicker, phase
                    // offset per fire so the field doesn't strobe in sync.
                    float p = aPhase * 6.2831;
                    float flick = 0.72
                        + 0.18 * sin(uTime * 9.3 + p)
                        + 0.10 * sin(uTime * 23.7 + p * 1.7);
                    vFade = aFade; vHi = aHi; vFlick = flick;
                    float sizePx = aSize * (1.0 + aHi * 0.8) * uScale / max(0.0001, -mv.z);
                    gl_PointSize = clamp(sizePx, 2.5, 40.0);
                    gl_Position = projectionMatrix * mv;
                }`,
            fragmentShader: `
                varying float vFade;
                varying float vHi;
                varying float vFlick;
                void main() {
                    vec2 d = gl_PointCoord - 0.5;
                    float r = length(d) * 2.0;
                    if (r > 1.0) discard;
                    float core = smoothstep(0.40, 0.0, r);
                    float glow = pow(max(0.0, 1.0 - r), 1.9);
                    // White-hot core → amber body → deep-red skirt.
                    vec3 col = mix(vec3(1.00, 0.35, 0.05), vec3(1.00, 0.85, 0.45), core);
                    col = mix(vec3(0.75, 0.12, 0.02), col, 0.35 + 0.65 * vFade);
                    float a = (core * 1.0 + glow * 0.55) * vFlick * (0.35 + 0.65 * vFade);
                    a = min(1.0, a + vHi * 0.35);
                    gl_FragColor = vec4(col, a);
                }`,
        });

        this._geo = new THREE.BufferGeometry();
        this._points = new THREE.Points(this._geo, this._mat);
        this._points.renderOrder = 11;
        this._points.visible = false;
        this.group = new THREE.Group();
        this.group.name = 'wildfire-events';
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
            if (body.freshness !== 'live') {
                throw new Error(body.sources?.eonet?.error ?? 'feed is stale');
            }
            this.fires = body.fires ?? [];
            this.updated = body.updated;
            this._rebuild();
            const biggest = this.fires.find(f => f.areaAcres != null);
            this._onStatus('loaded', {
                count: this.fires.length,
                updated: body.updated,
                biggest: biggest
                    ? `${biggest.name.replace(/\s*(wildfire|fire)s?\s*$/i, '')} ${Math.round(biggest.areaAcres).toLocaleString()} ac`
                    : null,
            });
        })().catch(err => {
            this._onStatus('error', { error: err?.message ?? 'fetch failed' });
        }).finally(() => { this._inflight = null; });
        await this._inflight;
    }

    _rebuild() {
        const THREE = this._T;
        const n = this.fires.length;
        const pos = new Float32Array(n * 3);
        const size = new Float32Array(n);
        const fade = new Float32Array(n);
        const phase = new Float32Array(n);
        const hi = new Float32Array(n);

        for (let i = 0; i < n; i++) {
            const f = this.fires[i];
            const v = this._geoToXYZ(f.lat, f.lon).multiplyScalar(this._radius);
            pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
            // log-acreage size ramp: 100 ac ≈ 0.012, 100 k ac ≈ 0.026.
            // Unreported acreage renders at the small end, not invisibly.
            const acres = Number.isFinite(f.areaAcres) ? Math.max(1, f.areaAcres) : 50;
            size[i] = 0.009 + 0.0035 * Math.log10(acres);
            // Recency fade: fresh (≤2 d) = 1 → 30 d+ = 0.15.
            const age = Number.isFinite(f.ageDays) ? f.ageDays : 30;
            fade[i] = Math.max(0.15, 1 - Math.max(0, age - 2) / 28);
            // Deterministic flicker phase (reloads render identically).
            phase[i] = (Math.abs(Math.sin(f.lat * 12.9898 + f.lon * 78.233)) * 43758.5453) % 1;
        }

        this._geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        this._geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
        this._geo.setAttribute('aFade', new THREE.BufferAttribute(fade, 1));
        this._geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
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
        if (!this.group.visible || !this.fires.length || !this._points.visible) return null;
        const prev = raycaster.params.Points;
        raycaster.params.Points = { threshold: HIT_THRESHOLD };
        const hits = raycaster.intersectObject(this._points, false);
        raycaster.params.Points = prev;
        if (!hits.length) return null;
        this._points.updateWorldMatrix(true, false);
        const posAttr = this._geo.getAttribute('position');
        for (const hit of hits) {
            const i = hit.index;
            if (i == null || !this.fires[i]) continue;
            this._vWorld.fromBufferAttribute(posAttr, i)
                .applyMatrix4(this._points.matrixWorld);
            this._vCam.copy(raycaster.ray.origin).sub(this._vWorld);
            if (this._vWorld.dot(this._vCam) <= 0) continue;   // far side
            return { fire: this.fires[i], index: i };
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

export default WildfireLayer;
