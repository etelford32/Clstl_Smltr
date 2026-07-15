/**
 * city-markers.js — clickable major-city dots on the EarthView globe.
 *
 * Renders the whole js/data/major-cities.js dataset (~270 cities) as ONE
 * THREE.Points draw call with a small custom shader:
 *   - per-city size from metro population (√ scale, clamped)
 *   - per-city colour tier: mega ≥ 10 M = warm gold, ≥ 4 M = cyan,
 *     smaller = soft blue (brand palette)
 *   - soft round dot with a glow skirt + gentle per-city twinkle
 *   - hovered city brightens/enlarges via a per-vertex highlight attribute
 *
 * Interaction contract (mirrors eqMarkers/alertMarkers on earth.html):
 *   getHovered(raycaster) → { city, index } | null
 * The caller feeds the same raycaster it uses for quake/alert hovers; we
 * set the Points threshold locally and reject far-hemisphere hits (a ray
 * "cylinder" would otherwise grab dots on the back of the planet whose
 * pixels are depth-occluded).
 *
 * The group is parented to earthMesh, so dots track globe rotation and the
 * globe itself depth-occludes the far side (depthTest on, depthWrite off).
 *
 * Selection behaviour (click → saveUserLocation → verdict card/beacon)
 * lives in earth.html — this module is rendering + hit-testing only.
 */

const TIER_MEGA  = 10;   // ≥ 10 M — gold
const TIER_LARGE = 4;    // ≥ 4 M  — cyan
const HIT_THRESHOLD = 0.022;   // world units (globe R = 1); ~140 km grab radius

export class CityMarkers {
    /**
     * @param {object} THREE      three.js namespace (supplied by the page)
     * @param {object} opts
     * @param {Array}  opts.cities    [{ n, c, lat, lon, p }]
     * @param {Function} opts.geoToXYZ (lat, lon) → THREE.Vector3 on the unit sphere
     * @param {number} [opts.radius]  marker shell radius (globe radii)
     */
    constructor(THREE, { cities, geoToXYZ, radius = 1.0035 } = {}) {
        this._T = THREE;
        this.cities = cities || [];
        this._hiIndex = -1;
        this._vWorld = new THREE.Vector3();
        this._vCam = new THREE.Vector3();

        const n = this.cities.length;
        const pos = new Float32Array(n * 3);
        const size = new Float32Array(n);
        const tier = new Float32Array(n);
        const phase = new Float32Array(n);
        const hi = new Float32Array(n);

        for (let i = 0; i < n; i++) {
            const c = this.cities[i];
            const v = geoToXYZ(c.lat, c.lon).multiplyScalar(radius);
            pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
            // √population size ramp: Tokyo (37 M) ≈ 2.4× a 1 M city. World
            // units; the vertex shader divides by view depth (attenuation).
            // Sized to stay legible above the wind-current streamlines at
            // full-globe zoom without carpeting Europe at close zoom.
            size[i] = 0.011 + 0.016 * Math.sqrt(Math.min(c.p, 34) / 34);
            tier[i] = c.p >= TIER_MEGA ? 2 : c.p >= TIER_LARGE ? 1 : 0;
            // Deterministic per-city twinkle phase — no Math.random so a
            // reload twinkles identically (nice for visual regression shots).
            phase[i] = (Math.abs(Math.sin(c.lat * 12.9898 + c.lon * 78.233)) * 43758.5453) % 1;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
        geo.setAttribute('aTier', new THREE.BufferAttribute(tier, 1));
        geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
        geo.setAttribute('aHi', new THREE.BufferAttribute(hi, 1));
        this._hiAttr = geo.getAttribute('aHi');

        this._mat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uTime:  { value: 0 },
                uScale: { value: 600 },   // px factor; updated in tick()
            },
            vertexShader: `
                attribute float aSize;
                attribute float aTier;
                attribute float aPhase;
                attribute float aHi;
                uniform float uTime;
                uniform float uScale;
                varying float vTier;
                varying float vHi;
                varying float vTw;
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    float tw = 0.80 + 0.20 * sin(uTime * 1.7 + aPhase * 6.2831);
                    vTw = tw; vTier = aTier; vHi = aHi;
                    float sizePx = aSize * (1.0 + aHi * 0.9) * uScale / max(0.0001, -mv.z);
                    gl_PointSize = clamp(sizePx, 2.25, 38.0);
                    gl_Position = projectionMatrix * mv;
                }`,
            fragmentShader: `
                varying float vTier;
                varying float vHi;
                varying float vTw;
                vec3 tierColor(float t) {
                    if (t > 1.5) return vec3(1.00, 0.84, 0.40);   // mega — warm gold
                    if (t > 0.5) return vec3(0.30, 0.86, 1.00);   // large — cyan
                    return vec3(0.34, 0.62, 1.00);                // rest — soft blue
                }
                void main() {
                    vec2 d = gl_PointCoord - 0.5;
                    float r = length(d) * 2.0;
                    if (r > 1.0) discard;
                    float core = smoothstep(0.55, 0.0, r);        // hot centre
                    float glow = pow(max(0.0, 1.0 - r), 2.2);     // soft skirt
                    vec3 col = mix(tierColor(vTier), vec3(1.0), core * 0.85);
                    float a = (core * 1.0 + glow * 0.65) * vTw;
                    a = min(1.0, a + vHi * 0.35);
                    gl_FragColor = vec4(col, a);
                }`,
        });

        this._points = new THREE.Points(geo, this._mat);
        this._points.renderOrder = 11;   // under the location beacon (12)

        this.group = new THREE.Group();
        this.group.add(this._points);
    }

    get visible() { return this.group.visible; }
    setVisible(v) { this.group.visible = !!v; }

    /** Per-frame: twinkle clock + point-size attenuation factor.
     *  `pixelScale` = drawingBufferHeight / (2·tan(fov/2)). */
    tick(t, pixelScale) {
        this._mat.uniforms.uTime.value = t;
        if (Number.isFinite(pixelScale)) this._mat.uniforms.uScale.value = pixelScale;
    }

    /**
     * Hit-test against the shared hover/tap raycaster. Returns the
     * nearest NEAR-SIDE city within the grab threshold, or null.
     * (three.js happily reports Points on the far side of the globe —
     * they're inside the ray's threshold cylinder even though the planet
     * hides their pixels — so each candidate is checked against the
     * surface normal before it can win.)
     */
    getHovered(raycaster) {
        if (!this.group.visible) return null;
        const prev = raycaster.params.Points;
        raycaster.params.Points = { threshold: HIT_THRESHOLD };
        const hits = raycaster.intersectObject(this._points, false);
        raycaster.params.Points = prev;
        if (!hits.length) return null;

        this._points.updateWorldMatrix(true, false);
        const posAttr = this._points.geometry.getAttribute('position');
        for (const hit of hits) {            // sorted near → far along the ray
            const i = hit.index;
            if (i == null) continue;
            this._vWorld.fromBufferAttribute(posAttr, i)
                .applyMatrix4(this._points.matrixWorld);
            // Near-side test: the outward normal at the dot (globe centred
            // on the origin) must face the ray origin (the camera).
            this._vCam.copy(raycaster.ray.origin).sub(this._vWorld);
            if (this._vWorld.dot(this._vCam) <= 0) continue;
            return { city: this.cities[i], index: i };
        }
        return null;
    }

    /** Brighten/enlarge one dot (hover feedback); pass -1 to clear. */
    setHighlight(index) {
        if (index === this._hiIndex) return;
        if (this._hiIndex >= 0) this._hiAttr.setX(this._hiIndex, 0);
        if (index >= 0) this._hiAttr.setX(index, 1);
        this._hiIndex = index;
        this._hiAttr.needsUpdate = true;
    }

    dispose() {
        this._points.geometry.dispose();
        this._mat.dispose();
        this.group.parent?.remove(this.group);
    }
}

export default CityMarkers;
