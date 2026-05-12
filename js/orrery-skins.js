/**
 * orrery-skins.js — Shader-based procedural skins for the eight planets
 * at solar-system scale.
 *
 * Returns a `THREE.Group` per planet containing:
 *   - the surface mesh (procedural shader keyed by body)
 *   - a Fresnel-edge atmosphere shell (BackSide, additive)
 *   - rings for Saturn (banded with Cassini division) and Uranus (thin,
 *     near-vertical)
 *   - a Neptune Great Dark Spot signature in the surface shader
 *
 * The Group is the "planet handle" — its position is set each frame by
 * the orrery (heliocentric → scene), and each frame `updateOrreryPlanet`
 * is called with the current sim JD to advance axial rotation and tilt.
 *
 * Frame conventions
 *   The orrery scene is Y-up, with the ecliptic in the XZ plane. The
 *   planet group's local Y axis lines up with ecliptic-north; we then
 *   rotate around the local X axis by the obliquity to tilt the spin
 *   axis. Per-frame rotation accumulates into rotation.y.
 *
 * Quality + performance
 *   Sphere segments scale with body size so big planets get more
 *   vertices for smooth limbs. All shaders are pure-procedural — no
 *   textures fetched, no uv lookups, no extra materials beyond what
 *   ships in the page bundle.
 */

import * as THREE from 'three';

const D2R = Math.PI / 180;
const J2000_JD = 2451545.0;

// Sidereal rotation period (days) and obliquity (deg) per planet.
// Source: NASA planetary fact sheets. Negative period == retrograde
// (Venus and Uranus). Mean longitude of the prime-meridian line at
// J2000 set so the planet starts in a recognisable orientation.
const SPIN = {
    mercury: { period_d:  58.6462,  oblq:  0.034, w0_deg:  329.5469 },
    venus:   { period_d:-243.0185,  oblq:177.36,  w0_deg:  160.20   },
    earth:   { period_d:   0.99726, oblq: 23.44,  w0_deg:  280.147  },
    mars:    { period_d:   1.02596, oblq: 25.19,  w0_deg:  176.630  },
    jupiter: { period_d:   0.41354, oblq:  3.13,  w0_deg:   43.30   },
    saturn:  { period_d:   0.44401, oblq: 26.73,  w0_deg:   38.90   },
    uranus:  { period_d:  -0.71833, oblq: 97.77,  w0_deg:  203.81   },
    neptune: { period_d:   0.67125, oblq: 28.32,  w0_deg:  253.18   },
};

// Vertex shader common to every procedural planet — passes the local
// position (so noise stays attached to the surface as the planet spins)
// and the world-space normal for sun lighting.
const SHARED_VERT = /* glsl */`
    varying vec3 vLocalPos;
    varying vec3 vWorldNormal;
    void main() {
        vLocalPos     = position;
        vWorldNormal  = normalize(mat3(modelMatrix) * normal);
        gl_Position   = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

// Shared GLSL helpers (hash + value-noise + 3-octave fbm).
const NOISE_HEAD = /* glsl */`
    float hash3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
    float vnoise3(vec3 p){
        vec3 i = floor(p), f = fract(p);
        f = f*f*(3.0-2.0*f);
        return mix(
            mix(mix(hash3(i),                hash3(i+vec3(1,0,0)), f.x),
                mix(hash3(i+vec3(0,1,0)),    hash3(i+vec3(1,1,0)), f.x), f.y),
            mix(mix(hash3(i+vec3(0,0,1)),    hash3(i+vec3(1,0,1)), f.x),
                mix(hash3(i+vec3(0,1,1)),    hash3(i+vec3(1,1,1)), f.x), f.y),
            f.z);
    }
    float fbm3(vec3 p){
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { v += a*vnoise3(p); p *= 2.0; a *= 0.5; }
        return v;
    }
`;

// ── Per-planet fragment shaders ──────────────────────────────────────

const FRAG = {

    mercury: /* glsl */`
        precision highp float;
        varying vec3 vLocalPos;
        varying vec3 vWorldNormal;
        uniform vec3 uSunDir;
        ${NOISE_HEAD}
        void main() {
            vec3 p = normalize(vLocalPos);
            // Cratered grey-tan procedural surface
            float n = fbm3(p * 9.0);
            float c = fbm3(p * 26.0) * 0.4 + n * 0.6;
            vec3 base = mix(vec3(0.45,0.40,0.35), vec3(0.78,0.72,0.62), c);
            // Bright ray-crater hint
            float ray = smoothstep(0.78, 0.96, fbm3(p * 4.5 + vec3(7.1)));
            base = mix(base, vec3(0.95,0.92,0.85), ray * 0.35);
            float NdotL = max(dot(normalize(vWorldNormal), normalize(uSunDir)), 0.0);
            float lit   = 0.10 + 0.95 * NdotL;
            gl_FragColor = vec4(base * lit, 1.0);
        }
    `,

    venus: /* glsl */`
        precision highp float;
        varying vec3 vLocalPos;
        varying vec3 vWorldNormal;
        uniform vec3 uSunDir;
        uniform float uTime;
        ${NOISE_HEAD}
        void main() {
            vec3 p = normalize(vLocalPos);
            float lat = p.y;
            // Smooth cloud bands with horizontal shear (Y-jet / trade winds).
            float bands = sin(lat * 7.0) * 0.5 + 0.5;
            float t = fbm3(vec3(p.xz * 6.0, uTime * 0.06) + p);
            bands = clamp(bands * 0.8 + t * 0.4, 0.0, 1.0);
            vec3 cream = vec3(0.98, 0.92, 0.74);
            vec3 ochre = vec3(0.86, 0.70, 0.36);
            vec3 col = mix(ochre, cream, bands);
            // Polar caps slightly cooler
            col = mix(col, vec3(0.96, 0.86, 0.66), smoothstep(0.7, 1.0, abs(lat)) * 0.4);
            float NdotL = max(dot(normalize(vWorldNormal), normalize(uSunDir)), 0.0);
            float lit   = 0.18 + 0.85 * NdotL;
            gl_FragColor = vec4(col * lit, 1.0);
        }
    `,

    earth: /* glsl */`
        precision highp float;
        varying vec3 vLocalPos;
        varying vec3 vWorldNormal;
        uniform vec3 uSunDir;
        ${NOISE_HEAD}
        void main() {
            vec3 p = normalize(vLocalPos);
            // Continents via fbm threshold; oceans below.
            float c = fbm3(p * 2.4 + vec3(11.2)) - 0.5 * abs(p.y);
            float landMask = smoothstep(0.06, 0.16, c);
            // Vegetation vs desert by latitude
            float lat = abs(p.y);
            vec3 ocean = mix(vec3(0.04,0.16,0.40), vec3(0.05,0.30,0.55), smoothstep(0.0,0.6,fbm3(p*8.0)));
            vec3 forest = vec3(0.15,0.40,0.16);
            vec3 desert = vec3(0.78,0.66,0.42);
            vec3 ice    = vec3(0.92,0.96,0.99);
            vec3 land   = mix(forest, desert, smoothstep(0.0,0.55,lat));
            land = mix(land, ice, smoothstep(0.78, 0.95, lat));
            vec3 col = mix(ocean, land, landMask);
            // Cloud deck — additive whisps
            float clouds = smoothstep(0.55, 0.82, fbm3(p * 3.8 + vec3(53.7)));
            col = mix(col, vec3(0.96,0.96,1.0), clouds * 0.55);
            float NdotL = max(dot(normalize(vWorldNormal), normalize(uSunDir)), 0.0);
            float lit   = 0.10 + 0.95 * NdotL;
            // Subtle blue scatter on the day-side limb.
            gl_FragColor = vec4(col * lit, 1.0);
        }
    `,

    mars: /* glsl */`
        precision highp float;
        varying vec3 vLocalPos;
        varying vec3 vWorldNormal;
        uniform vec3 uSunDir;
        ${NOISE_HEAD}
        void main() {
            vec3 p = normalize(vLocalPos);
            float n = fbm3(p * 4.5);
            float h = fbm3(p * 12.0) * 0.4 + n * 0.6;
            vec3 rust  = vec3(0.78, 0.36, 0.22);
            vec3 sand  = vec3(0.86, 0.62, 0.40);
            vec3 dark  = vec3(0.42, 0.20, 0.14);
            vec3 col = mix(dark, rust, smoothstep(0.25, 0.6, h));
            col = mix(col, sand, smoothstep(0.55, 0.85, h));
            // Polar ice caps
            float pole = smoothstep(0.78, 0.93, abs(p.y));
            col = mix(col, vec3(0.95, 0.94, 0.92), pole);
            float NdotL = max(dot(normalize(vWorldNormal), normalize(uSunDir)), 0.0);
            float lit   = 0.12 + 0.95 * NdotL;
            gl_FragColor = vec4(col * lit, 1.0);
        }
    `,

    jupiter: /* glsl */`
        precision highp float;
        varying vec3 vLocalPos;
        varying vec3 vWorldNormal;
        uniform vec3 uSunDir;
        uniform float uTime;
        ${NOISE_HEAD}
        void main() {
            vec3 p = normalize(vLocalPos);
            float lat = p.y;
            float lon = atan(p.x, p.z);
            // Strong zonal bands with turbulent edges.
            float band = sin(lat * 18.0);
            float turb = fbm3(vec3(lat * 22.0, lon * 6.0, uTime * 0.08));
            float v = clamp(band * 0.45 + turb * 0.55 + 0.5, 0.0, 1.0);
            vec3 belt = vec3(0.66, 0.42, 0.22);
            vec3 zone = vec3(0.96, 0.86, 0.66);
            vec3 col  = mix(belt, zone, v);
            // Great Red Spot — elliptical patch in the SEB at lat ≈ -0.32.
            vec2 grsCenter = vec2(2.4, -0.32);
            vec2 d = vec2(lon - grsCenter.x, (lat - grsCenter.y) * 2.4);
            d.x = mod(d.x + 3.14159, 6.28318) - 3.14159;
            float grs = exp(-dot(d, d) * 4.0);
            col = mix(col, vec3(0.84, 0.34, 0.18), grs * 0.85);
            // Polar haze
            col = mix(col, vec3(0.55, 0.50, 0.42), smoothstep(0.8, 1.0, abs(lat)) * 0.55);
            float NdotL = max(dot(normalize(vWorldNormal), normalize(uSunDir)), 0.0);
            float lit   = 0.20 + 0.85 * NdotL;
            gl_FragColor = vec4(col * lit, 1.0);
        }
    `,

    saturn: /* glsl */`
        precision highp float;
        varying vec3 vLocalPos;
        varying vec3 vWorldNormal;
        uniform vec3 uSunDir;
        ${NOISE_HEAD}
        void main() {
            vec3 p = normalize(vLocalPos);
            float lat = p.y;
            float lon = atan(p.x, p.z);
            // Soft pastel bands.
            float band = sin(lat * 14.0) * 0.5 + 0.5;
            float turb = fbm3(vec3(lat * 16.0, lon * 4.0, 0.0));
            float v = clamp(band + turb * 0.20 - 0.10, 0.0, 1.0);
            vec3 cream  = vec3(0.96, 0.90, 0.74);
            vec3 butter = vec3(0.86, 0.74, 0.50);
            vec3 col    = mix(butter, cream, v);
            // Hexagonal polar vortex hint at the north pole.
            if (lat > 0.85) {
                float hex = sin(atan(p.x, p.z) * 3.0 + 1.0) * 0.5 + 0.5;
                col = mix(col, vec3(0.42, 0.52, 0.66), hex * 0.35);
            }
            col = mix(col, vec3(0.66, 0.58, 0.42), smoothstep(0.75, 1.0, abs(lat)) * 0.45);
            float NdotL = max(dot(normalize(vWorldNormal), normalize(uSunDir)), 0.0);
            float lit   = 0.22 + 0.82 * NdotL;
            gl_FragColor = vec4(col * lit, 1.0);
        }
    `,

    uranus: /* glsl */`
        precision highp float;
        varying vec3 vLocalPos;
        varying vec3 vWorldNormal;
        uniform vec3 uSunDir;
        ${NOISE_HEAD}
        void main() {
            vec3 p = normalize(vLocalPos);
            float lat = p.y;
            // Ultra-faint banding — Uranus is famously featureless.
            float band = sin(lat * 9.0) * 0.5 + 0.5;
            float turb = fbm3(vec3(p.x * 4.0, lat * 7.0, p.z * 4.0));
            float v = clamp(band * 0.5 + turb * 0.5, 0.0, 1.0);
            vec3 teal  = vec3(0.62, 0.88, 0.92);
            vec3 mint  = vec3(0.82, 0.96, 0.98);
            vec3 col   = mix(teal, mint, v * 0.6);
            // Slight pole highlight (sub-solar pole during seasons).
            col = mix(col, mint, smoothstep(0.6, 1.0, p.y) * 0.25);
            float NdotL = max(dot(normalize(vWorldNormal), normalize(uSunDir)), 0.0);
            float lit   = 0.30 + 0.78 * NdotL;
            gl_FragColor = vec4(col * lit, 1.0);
        }
    `,

    neptune: /* glsl */`
        precision highp float;
        varying vec3 vLocalPos;
        varying vec3 vWorldNormal;
        uniform vec3 uSunDir;
        uniform float uTime;
        ${NOISE_HEAD}
        void main() {
            vec3 p = normalize(vLocalPos);
            float lat = p.y;
            float lon = atan(p.x, p.z);
            float band = sin(lat * 10.0) * 0.5 + 0.5;
            float turb = fbm3(vec3(p.x * 3.0, lat * 6.0, p.z * 3.0 + uTime * 0.04));
            float v = clamp(band * 0.55 + turb * 0.55, 0.0, 1.0);
            vec3 cobalt = vec3(0.18, 0.30, 0.74);
            vec3 azure  = vec3(0.40, 0.62, 0.92);
            vec3 col    = mix(cobalt, azure, v);
            // Great Dark Spot (Voyager 2 1989) at southern mid-latitudes.
            vec2 gdsCenter = vec2(-1.0, -0.40);
            vec2 d = vec2(lon - gdsCenter.x, (lat - gdsCenter.y) * 2.4);
            d.x = mod(d.x + 3.14159, 6.28318) - 3.14159;
            float gds = exp(-dot(d, d) * 6.0);
            col = mix(col, vec3(0.06, 0.10, 0.22), gds * 0.85);
            // Bright "scooter" companion clouds — small white wisps
            float wisp = smoothstep(0.6, 0.9, fbm3(p * 5.5 + vec3(uTime*0.08, 0.0, 0.0)));
            col = mix(col, vec3(0.98, 0.99, 1.00), wisp * 0.18);
            float NdotL = max(dot(normalize(vWorldNormal), normalize(uSunDir)), 0.0);
            float lit   = 0.22 + 0.85 * NdotL;
            gl_FragColor = vec4(col * lit, 1.0);
        }
    `,
};

const SHARED_UNIFORMS_FOR = key => ({
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uTime:   { value: 0 },
});

// ── Atmosphere shell (Fresnel BackSide, sun-aware) ──────────────────
// The shell is added at planet-group level so it picks up heliocentric
// translation but is not subject to the tiltGroup's obliquity rotation
// (a tilted Fresnel ring would distort with the spin).  uSunDir is in
// world space — same convention as the shared planet vertex shader.
//
// Rim brightness combines two factors:
//   r = pow(1 - |vN.z|, 2)   ← view-dependent fresnel (camera-space)
//   l = max(N·L, 0)          ← lambertian on the world-space normal
// so the lit limb glows at full intensity, the unlit limb stays dark
// (with a small ambient floor so the rim doesn't disappear entirely
// when the planet is back-lit and the user is dialing the camera).
function makeAtmosphere(color, scale, intensity, sunDirUniform = null) {
    const uniforms = {
        uColor:  { value: new THREE.Color(color) },
        uK:      { value: intensity },
        // Either share a parent's uSunDir uniform (so updateOrreryPlanet
        // drives both the surface and the atmosphere with one write) or
        // own one and leave it pointing along +X.  Sharing is cheaper
        // and keeps day/night perfectly aligned.
        uSunDir: sunDirUniform || { value: new THREE.Vector3(1, 0, 0) },
    };
    return new THREE.Mesh(
        new THREE.SphereGeometry(scale, 32, 32),
        new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, side: THREE.BackSide,
            blending: THREE.AdditiveBlending,
            uniforms,
            vertexShader: `
                varying vec3 vN;          // camera-space normal (fresnel)
                varying vec3 vWorldN;     // world-space normal  (sun direction)
                void main() {
                    vN      = normalize(normalMatrix * normal);
                    vWorldN = normalize(mat3(modelMatrix) * normal);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                uniform vec3  uColor;
                uniform float uK;
                uniform vec3  uSunDir;
                varying vec3  vN;
                varying vec3  vWorldN;
                void main() {
                    float fres = pow(1.0 - abs(vN.z), 2.0);            // limb fresnel
                    float lit  = max(dot(vWorldN, normalize(uSunDir)), 0.0);
                    // 0.18 ambient keeps the night limb visible enough
                    // to read the body's outline; the day limb takes
                    // the full fresnel × lambertian product.
                    float intensity = (0.18 + 0.82 * lit);
                    gl_FragColor = vec4(uColor, fres * 0.55 * uK * intensity);
                }`,
        }),
    );
}

// ── Ring builders ────────────────────────────────────────────────────
function makeSaturnRings(planetRadius) {
    const rIn  = planetRadius * 1.42;
    const rOut = planetRadius * 2.50;
    const geom = new THREE.RingGeometry(rIn, rOut, 128, 1);
    // Rewrite UVs so x = radial fraction (0 inner, 1 outer).
    const pos = geom.attributes.position.array;
    const uv  = geom.attributes.uv.array;
    for (let i = 0; i < pos.length; i += 3) {
        const r = Math.hypot(pos[i], pos[i+1]);
        uv[(i/3)*2]     = (r - rIn) / (rOut - rIn);
        uv[(i/3)*2 + 1] = 0.5;
    }
    geom.attributes.uv.needsUpdate = true;
    const mat = new THREE.ShaderMaterial({
        transparent:true, depthWrite:false, side:THREE.DoubleSide,
        uniforms:{
            uColor:    { value:new THREE.Color(0xead9a8) },
            uShadowDir:{ value:new THREE.Vector3(1,0,0) },
        },
        vertexShader:`varying vec2 vUv; varying vec3 vWorld;
            void main(){
                vUv = uv;
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vWorld = wp.xyz;
                gl_Position = projectionMatrix * viewMatrix * wp;
            }`,
        fragmentShader:`
            uniform vec3 uColor;
            varying vec2 vUv;
            varying vec3 vWorld;

            // Approximate ring optical depth as a function of radial position.
            // Real rings: D ring (1.10–1.24 R), C ring (1.24–1.53), B ring
            // (1.53–1.95 — densest), Cassini Division (1.95–2.03 — gap),
            // A ring (2.03–2.27), Encke gap, F ring fragments.
            // We compress that into our [0,1] radial range.
            float ringDensity(float r) {
                if (r < 0.04)                       return 0.10;       // inner fade-in (D ring)
                if (r < 0.20)                       return 0.45;       // C ring
                if (r < 0.55)                       return 0.95;       // B ring (dense)
                if (r < 0.62)                       return 0.04;       // Cassini Division
                if (r < 0.92)                       return 0.78;       // A ring
                                                    return 0.18;       // F-ring fade-out
            }

            void main(){
                float r = vUv.x;
                if (r < 0.0 || r > 1.0) discard;
                float d = ringDensity(r);
                // Add fine-scale banding within each major section
                float fine = 0.5 + 0.5 * sin(r * 220.0);
                float micro= 0.5 + 0.5 * sin(r * 980.0 + 1.7);
                float bright = d * (0.55 + 0.45 * fine) * (0.85 + 0.15 * micro);
                // Encke gap inside the A ring (~0.85)
                bright *= 1.0 - 0.55 * smoothstep(0.844, 0.852, r) * (1.0 - smoothstep(0.852, 0.860, r));
                // Outer fall-off for soft edge
                bright *= 1.0 - smoothstep(0.95, 1.0, r);
                bright *= smoothstep(0.0, 0.05, r);
                // Color: outer (A) cooler, inner (B) warmer
                vec3 c = mix(uColor * 1.05, uColor * 0.85, smoothstep(0.0, 1.0, r));
                gl_FragColor = vec4(c * (0.7 + 0.5 * bright), bright);
            }`,
    });
    const ring = new THREE.Mesh(geom, mat);
    ring.rotation.x = Math.PI / 2;     // lie in equatorial plane (with planet's tilt applied at group level)
    ring.renderOrder = 5;
    return ring;
}

// Uranus's narrow ε-ring system, viewed nearly edge-on most of the
// time because Uranus's spin axis lies in its orbital plane.
function makeUranusRings(planetRadius) {
    const group = new THREE.Group();
    const ringDefs = [
        // [innerScale, outerScale, opacity]
        [1.62, 1.65, 0.35],   // ε ring
        [1.78, 1.82, 0.20],   // ν / μ approx
        [1.95, 1.97, 0.12],
    ];
    for (const [iS, oS, op] of ringDefs) {
        const geom = new THREE.RingGeometry(planetRadius * iS, planetRadius * oS, 96);
        const mat  = new THREE.MeshBasicMaterial({
            color:0x99aabb, transparent:true, opacity:op,
            depthWrite:false, side:THREE.DoubleSide,
            blending:THREE.AdditiveBlending,
        });
        const r = new THREE.Mesh(geom, mat);
        r.rotation.x = Math.PI / 2;     // equatorial plane; tilt comes from planet group
        group.add(r);
    }
    return group;
}

// Neptune has very faint, dusty rings (Galle, Le Verrier, Adams + arcs).
function makeNeptuneRings(planetRadius) {
    const group = new THREE.Group();
    const ringDefs = [
        [1.72, 1.73, 0.10],
        [1.95, 1.97, 0.08],
    ];
    for (const [iS, oS, op] of ringDefs) {
        const geom = new THREE.RingGeometry(planetRadius * iS, planetRadius * oS, 96);
        const mat  = new THREE.MeshBasicMaterial({
            color:0x4060c0, transparent:true, opacity:op,
            depthWrite:false, side:THREE.DoubleSide,
            blending:THREE.AdditiveBlending,
        });
        const r = new THREE.Mesh(geom, mat);
        r.rotation.x = Math.PI / 2;
        group.add(r);
    }
    return group;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Build a procedural planet group for a given key.
 *
 * @param {string} key        one of mercury / venus / earth / mars /
 *                            jupiter / saturn / uranus / neptune
 * @param {number} size       sphere radius in scene units
 * @param {number} colorHex   fallback tint for the atmosphere shell
 * @returns {{
 *   group: THREE.Group,         // attach to scene; handle for position
 *   surface: THREE.Mesh,        // the spinning surface mesh
 *   uniforms: object,           // shader uniforms (uTime, uSunDir, ...)
 *   spin: object,               // SPIN entry (period, oblq, w0_deg)
 * }}
 */
export function makeOrreryPlanet(key, size, colorHex) {
    const group = new THREE.Group();

    // Surface mesh
    const seg = key === 'jupiter' || key === 'saturn' ? 64
              : key === 'earth'   || key === 'mars'   ? 48
              :                                          36;
    const uniforms = SHARED_UNIFORMS_FOR(key);
    const mat = new THREE.ShaderMaterial({
        vertexShader:   SHARED_VERT,
        fragmentShader: FRAG[key] || FRAG.mars,
        uniforms,
    });
    const surface = new THREE.Mesh(
        new THREE.SphereGeometry(size, seg, Math.round(seg * 0.7)),
        mat,
    );
    // Apply axial tilt to the spinning surface (and to its rings, since
    // they're added to the same group below the obliquity rotator).
    const tiltGroup = new THREE.Group();
    const sp = SPIN[key] || { period_d: 1, oblq: 0, w0_deg: 0 };
    tiltGroup.rotation.x = sp.oblq * D2R;
    tiltGroup.add(surface);

    // Rings live in the tilted equatorial plane.
    if (key === 'saturn')   tiltGroup.add(makeSaturnRings(size));
    if (key === 'uranus')   tiltGroup.add(makeUranusRings(size));
    if (key === 'neptune')  tiltGroup.add(makeNeptuneRings(size));

    group.add(tiltGroup);

    // Atmosphere — added at group level so it isn't tilted (it'd
    // distort the Fresnel ring).  Sharing the surface's uSunDir
    // uniform ties day/night brightness on the limb to the same
    // sun direction that lights the surface, so updateOrreryPlanet
    // drives both with a single write per frame.
    const atmK = (key === 'earth' || key === 'venus' || key === 'neptune' || key === 'uranus') ? 1.4
               : (key === 'jupiter' || key === 'saturn') ? 1.0
               : 0.5;
    group.add(makeAtmosphere(colorHex, size * 1.36, atmK, uniforms.uSunDir));

    return { group, surface, uniforms, spin: sp, _tiltGroup: tiltGroup };
}

/**
 * Update axial rotation each frame.
 *
 *   theta(jd) = w0 + (jd - J2000) / period_d  · 360°
 *
 * Negative period == retrograde (Venus, Uranus).
 *
 * The orrery places the planet group at its heliocentric scene
 * position; `updateOrreryPlanet` then sets the *internal* rotation so
 * the spin axis (already tilted in the tiltGroup) advances correctly.
 */
export function updateOrreryPlanet(planet, jd, sunPosScene = null) {
    const { surface, spin, uniforms } = planet;
    const dt_d = jd - J2000_JD;
    const rev  = dt_d / spin.period_d;
    const theta = (spin.w0_deg + rev * 360) * D2R;
    surface.rotation.y = theta;
    // Drive shader sun direction so the lit hemisphere always faces the
    // Sun. The shared vertex shader already exposes vWorldNormal in
    // world space, so uSunDir is world-space too — no inverse-matrix
    // dance required.
    if (uniforms.uSunDir) {
        if (sunPosScene && planet.group) {
            const dir = sunPosScene.clone()
                .sub(planet.group.position)
                .normalize();
            uniforms.uSunDir.value.copy(dir);
        } else {
            uniforms.uSunDir.value.set(1, 0, 0);
        }
    }
    if (uniforms.uTime) uniforms.uTime.value = (jd - J2000_JD) / 365.25;
}
