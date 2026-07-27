/**
 * location-beacon.js — the EarthView "you are here" marker.
 *
 * Replaces the old inline pin (core dot + halo + 3 radar rings + beam)
 * in earth.html with a richer, self-contained beacon:
 *
 *   1. core       — hard warm-white dot on the surface (silhouette anchor)
 *   2. glow       — camera-facing sprite (radial-gradient canvas texture,
 *                   additive) that pulses gently; reads as bloom without a
 *                   post-processing pass
 *   3. gem        — floating octahedron "map pin" hovering above the
 *                   surface, slowly spinning about the surface normal and
 *                   bobbing; wireframe shell for a holographic edge
 *   4. rings      — 3 expanding radar rings on staggered phases (kept from
 *                   the old marker — it read beautifully), now colour-lerped
 *                   along their life from cyan to the brand green
 *   5. beam       — light pillar: shader-gradient cylinder that fades with
 *                   altitude and carries slow-scrolling energy bands
 *   6. orbiters   — 3 tiny sparks circling the beacon in the tangent plane
 *                   on staggered phases ("electrons")
 *
 * Everything lives in a THREE.Group parented to earthMesh, so geographic
 * position automatically tracks globe rotation. The group's ORIGIN is the
 * surface point with local +Y aligned to the surface normal — children are
 * positioned in that local frame. That structure is load-bearing: it lets
 * tick() apply ONE uniform group scale about the beacon's base for the
 * zoom-adaptive size (below). Absolute-positioned children would slide off
 * the globe under scaling — don't restructure back.
 *
 * Zoom-adaptive scale: tick(t, camera) scales the whole beacon by
 * camera-to-beacon distance (clamped), approximating constant SCREEN size.
 * Without it the fixed world-size beacon (~0.26 R footprint) dwarfs the
 * view after the "Fly here" landing (camera ~0.12 R off the surface).
 * tick(t) without a camera keeps the last scale, so cold callers degrade
 * gracefully. tick(t) is allocation-free (scratch vectors are reused) —
 * this runs every frame.
 *
 * Palette: EarthView brand (verdict-card tokens) — cyan #4ddbff → blue
 * #1f8fff → green #2eff9e, warm-white core #fff7d0 so the marker survives
 * both the day-side blue and the night side.
 *
 * Usage (earth.html):
 *   const beacon = new LocationBeacon(THREE, earthMesh);
 *   beacon.show(geoToXYZ(lat, lon).multiplyScalar(1.003));  // surface point
 *   beacon.tick(t, camera);                                  // per frame
 *   beacon.clear();                                          // location cleared
 */

const COLOR_CORE   = 0xfff7d0;   // warm-white core
const COLOR_GLOW_A = '#ffffff';  // glow sprite centre
const COLOR_GLOW_B = '#4ddbff';  // glow sprite falloff
const COLOR_GEM    = 0x4ddbff;   // floating octahedron
const COLOR_GEM_W  = 0xbfe3ff;   // gem wireframe shell
const COLOR_RING_A = 0x8ff0ff;   // ring birth (bright cyan)
const COLOR_RING_B = 0x2eff9e;   // ring death (brand green)
const COLOR_BEAM_A = 0xffd766;   // beam base (sun-warm — ties to old marker)
const COLOR_BEAM_B = 0x4ddbff;   // beam tip
const SPARK_COLORS = [0x2eff9e, 0x4ddbff, 0x8ff0ff];

const RING_COUNT   = 3;
const RING_PERIOD  = 2.4;        // s per ring cycle (matches old marker)
const SPARK_COUNT  = 3;
const SPARK_RADIUS = 0.052;
const GEM_ALT      = 0.085;      // gem hover height above surface (globe radii)
const GEM_BOB      = 0.012;
const BEAM_LEN     = 0.26;

// Zoom-adaptive scale (see header). REF is the camera→beacon distance at
// the page's default view (camera 3 R from centre, beacon on the near
// surface → ~2 R) where scale = 1 preserves the approved look. The floor
// keeps a graze-the-surface zoom (CAM_FLOOR ≈ 1.025 R) from collapsing the
// beacon to nothing; the cap keeps a full zoom-out (10 R) from ballooning.
const SCALE_REF_DIST = 2.0;
const SCALE_MIN      = 0.05;
const SCALE_MAX      = 1.5;

export class LocationBeacon {
    /**
     * @param {object} THREE   the three.js namespace (page supplies it so
     *                         this module never double-imports a second copy)
     * @param {object} parent  Object3D to mount into (earthMesh — geographic
     *                         space, so the beacon tracks globe rotation)
     */
    constructor(THREE, parent) {
        this._T = THREE;
        this._parent = parent;
        this._group = null;
        this._cam = null;        // last camera seen by tick (used by show)

        // Scratch state (allocation-free tick)
        this._vTmp = new THREE.Vector3();
        this._cRing = new THREE.Color();
        this._cA = new THREE.Color(COLOR_RING_A);
        this._cB = new THREE.Color(COLOR_RING_B);
    }

    get active() { return !!this._group; }

    /**
     * Build (or rebuild) the beacon at a surface point. `surface` is the
     * position in the parent's local space, already lifted slightly off
     * the sphere (earth.html passes geoToXYZ(lat,lon) × 1.003).
     */
    show(surface) {
        const THREE = this._T;
        this.clear();

        const normal = surface.clone().normalize();

        // Group origin = the surface point, local +Y = the surface normal.
        // Children below are positioned in THIS frame (see module header —
        // required by the zoom scale).
        const g = new THREE.Group();
        this._group = g;
        g.position.copy(surface);
        g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);

        // 1. Core dot — hard centre so the marker survives bright daylight.
        const core = new THREE.Mesh(
            new THREE.SphereGeometry(0.012, 16, 16),
            new THREE.MeshBasicMaterial({ color: COLOR_CORE }));
        g.add(core);

        // 2. Glow sprite — always faces the camera; cheap "bloom".
        this._glowTex = makeGlowTexture(THREE);
        this._glow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: this._glowTex, transparent: true, opacity: 0.9,
            depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this._glow.scale.set(0.15, 0.15, 1);
        g.add(this._glow);

        // 3. Floating gem + wireframe shell — the "map pin", hovering.
        //    Local +Y is already the surface normal, so rotation.y in tick
        //    spins it like a top and the bob rides straight up.
        const gemGeo = new THREE.OctahedronGeometry(0.024);
        this._gem = new THREE.Mesh(gemGeo, new THREE.MeshBasicMaterial({
            color: COLOR_GEM, transparent: true, opacity: 0.85,
            depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        g.add(this._gem);
        this._gemWire = new THREE.Mesh(gemGeo, new THREE.MeshBasicMaterial({
            color: COLOR_GEM_W, wireframe: true, transparent: true, opacity: 0.5,
            depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this._gemWire.scale.setScalar(1.45);
        g.add(this._gemWire);

        // 4. Radar rings — flat in the local tangent (XZ) plane, staggered.
        this._rings = [];
        const ringGeo = new THREE.RingGeometry(0.022, 0.030, 48);
        for (let i = 0; i < RING_COUNT; i++) {
            const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
                color: COLOR_RING_A, transparent: true, opacity: 0.7,
                side: THREE.DoubleSide, depthWrite: false,
                blending: THREE.AdditiveBlending,
            }));
            ring.rotation.x = -Math.PI / 2;  // XY-plane geometry → tangent
            g.add(ring);
            this._rings.push(ring);
        }

        // 5. Light pillar — gradient + scrolling bands in a tiny shader.
        //    Geometry translated so its base sits AT the origin and the
        //    body extends along local +Y (the surface normal).
        const beamGeo = new THREE.CylinderGeometry(0.005, 0.013, BEAM_LEN, 20, 1, true);
        beamGeo.translate(0, BEAM_LEN / 2, 0);
        this._beamMat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uTime:   { value: 0 },
                uColorA: { value: new THREE.Color(COLOR_BEAM_A) },
                uColorB: { value: new THREE.Color(COLOR_BEAM_B) },
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                uniform float uTime;
                uniform vec3 uColorA;
                uniform vec3 uColorB;
                varying vec2 vUv;
                void main() {
                    float fade  = pow(1.0 - vUv.y, 1.7);              // die out with altitude
                    float bands = 0.72 + 0.28 * sin(vUv.y * 26.0 - uTime * 3.2);
                    float breath = 0.75 + 0.25 * sin(uTime * 1.8);
                    vec3 col = mix(uColorA, uColorB, vUv.y);
                    gl_FragColor = vec4(col, fade * bands * breath * 0.65);
                }`,
        });
        const beam = new THREE.Mesh(beamGeo, this._beamMat);
        g.add(beam);

        // 6. Orbiting sparks.
        this._sparks = [];
        for (let i = 0; i < SPARK_COUNT; i++) {
            const spark = new THREE.Mesh(
                new THREE.SphereGeometry(0.005, 8, 8),
                new THREE.MeshBasicMaterial({
                    color: SPARK_COLORS[i % SPARK_COLORS.length],
                    transparent: true, opacity: 0.9,
                    depthWrite: false, blending: THREE.AdditiveBlending,
                }));
            g.add(spark);
            this._sparks.push(spark);
        }

        g.renderOrder = 12;
        this._parent.add(g);
        this.tick(0, this._cam);   // place animated parts + zoom scale
    }

    /**
     * Per-frame animation. `t` = seconds (the page's animate clock);
     * `camera` drives the zoom-adaptive scale (optional — omitting it
     * keeps the last applied scale).
     */
    tick(t, camera = null) {
        if (!this._group) return;
        if (camera) this._cam = camera;
        const v = this._vTmp;

        // Zoom-adaptive scale: ~constant screen size (see header).
        if (this._cam) {
            const d = this._group.getWorldPosition(v).distanceTo(this._cam.position);
            const s = Math.min(SCALE_MAX, Math.max(SCALE_MIN, d / SCALE_REF_DIST));
            this._group.scale.setScalar(s);
        }

        // Rings: quadratic ease-out expansion, colour cyan→green over life,
        // leading ring brightest (same phase math as the old marker).
        const phase = (t % RING_PERIOD) / RING_PERIOD;
        for (let i = 0; i < this._rings.length; i++) {
            const ring = this._rings[i];
            const local = (phase + i / this._rings.length) % 1;
            const sc = 1 + local * local * 3.4;
            ring.scale.set(sc, sc, 1);
            ring.material.opacity = 0.8 * (1 - local) * (1 - local);
            this._cRing.lerpColors(this._cA, this._cB, local);
            ring.material.color.copy(this._cRing);
        }

        // Gem: spin about the normal (local +Y) + bob.
        const bob = GEM_ALT + Math.sin(t * 2.1) * GEM_BOB;
        this._gem.position.set(0, bob, 0);
        this._gemWire.position.set(0, bob, 0);
        this._gem.rotation.y = t * 1.4;
        this._gemWire.rotation.y = -t * 0.9;     // counter-rotating shell

        // Glow sprite breath.
        const breathe = Math.sin(t * 2.2) * 0.5 + 0.5;
        const gs = 0.13 + breathe * 0.05;
        this._glow.scale.set(gs, gs, 1);
        this._glow.material.opacity = 0.65 + breathe * 0.3;

        // Beam bands.
        this._beamMat.uniforms.uTime.value = t;

        // Sparks: tangent-plane (local XZ) orbit with a slight vertical wave.
        for (let i = 0; i < this._sparks.length; i++) {
            const a = t * (0.9 + i * 0.35) + i * (Math.PI * 2 / SPARK_COUNT);
            const alt = 0.035 + Math.sin(a * 2 + i) * 0.010;
            this._sparks[i].position.set(
                Math.cos(a) * SPARK_RADIUS, alt, Math.sin(a) * SPARK_RADIUS);
            this._sparks[i].material.opacity = 0.55 + 0.45 * (Math.sin(a * 3) * 0.5 + 0.5);
        }
    }

    /** Remove + dispose everything (safe to call when already cleared). */
    clear() {
        if (!this._group) return;
        this._parent.remove(this._group);
        this._group.traverse(c => {
            c.geometry?.dispose();
            if (c.material) {
                c.material.map?.dispose?.();
                c.material.dispose();
            }
        });
        this._glowTex?.dispose?.();
        this._group = null;
        this._rings = [];
        this._sparks = [];
        this._gem = this._gemWire = this._glow = this._beamMat = null;
    }

    dispose() { this.clear(); }
}

/** Radial-gradient glow texture (canvas → THREE.CanvasTexture). */
function makeGlowTexture(THREE) {
    const size = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0.0, COLOR_GLOW_A);
    grad.addColorStop(0.25, COLOR_GLOW_B + 'cc');
    grad.addColorStop(0.6, COLOR_GLOW_B + '44');
    grad.addColorStop(1.0, COLOR_GLOW_B + '00');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

export default LocationBeacon;
