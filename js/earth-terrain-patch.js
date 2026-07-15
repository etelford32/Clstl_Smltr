/**
 * earth-terrain-patch.js — displaced-geometry terrain window (T1 of the LOD plan)
 * ═══════════════════════════════════════════════════════════════════════════════
 * The globe surface is one icosahedron shell whose fragment shader fakes relief
 * with a normal-perturbation bump pass (js/earth-skin.js). Bump shading can
 * shade a slope but it can NEVER break the silhouette — zoom to the limb over
 * the Himalaya and you still see a perfectly smooth sphere. This module adds a
 * high-subdivision GRID mesh that rides the camera's ground footprint
 * (js/focus-footprint.js — the same primitive the weather patch and imagery
 * inset use) and displaces its vertices RADIALLY by the elevation map, so real
 * ridgelines poke past the horizon.
 *
 * Why this is seam-free by construction
 * ─────────────────────────────────────
 * The patch is a child of earthMesh (earth-local space), shares the globe's
 * exact composed fragment shader (EARTH_FRAG) and its uniform objects BY
 * REFERENCE (the same trick the split cloud shells use — Object.assign copies
 * the {value} refs, so every `earthU.u_x.value = …` update the page already
 * does reaches this material too). The displacement is purely radial, so
 * `normalize(position)` — the direction the fragment shader reconstructs its
 * equirectangular UV from — is UNCHANGED by the lift. The patch therefore
 * samples the same day/night/detail textures and runs the same lighting as the
 * globe directly beneath it: identical colour, no visible patch outline. The
 * only thing that changes is the geometry itself (and vWorldPos), which is
 * exactly the silhouette we want.
 *
 * Elevation source (T1a): the global height texture already loaded into
 * earthU.u_topology (sampled with a vertex texture fetch). Land only — ocean is
 * held flat via the u_specular ocean mask, matching the bump pass. A high-res
 * SRTM/Terrarium DEM inset for extreme zoom is the T1b follow-up; it slots in as
 * a second sampler exactly like topoGradient swaps the global gradient for the
 * inset one, no change to this module's geometry pipeline.
 *
 * Tuning knobs (uniforms, defaults chosen conservatively — a real-GPU pass
 * should dial these against the actual height-map encoding):
 *   u_terrain_exag     radial gain on (height − sea level). Vertical exaggeration.
 *   u_terrain_sealevel height value the map uses for sea level (land = h above it)
 *   u_terrain_skirt    how far the boundary skirt tucks under the globe to hide
 *                      the gap between the lifted patch edge and the smooth sphere
 *
 * The geometry math (grid on the sphere, skirt ring, indices) is a pure
 * function — buildPatchArrays — unit-tested by tests/earth-terrain-patch.mjs.
 * The displacement + depth tuning are GPU-only and documented above.
 *
 * Events consumed: 'focus-footprint-change' (document). Never throws into the
 * page: a rebuild failure just hides the patch and leaves the globe untouched.
 */

import { GEO_GLSL } from './geo/coords.glsl.js';
import { INSET_GLSL_HELPERS } from './geo/inset.glsl.js';

const DEG = Math.PI / 180;

// 1×1 "sea level" placeholder so the u_dem sampler is never null before the DEM
// inset delivers a real tile canvas. Terrarium sea level (0 m) encodes as
// R=128,G=0,B=0 → (128·256)−32768 = 0, so this displaces nothing.
function _placeholderTex(THREE) {
    const t = new THREE.DataTexture(new Uint8Array([128, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true;
    return t;
}

// Geographic → unit position, byte-identical to geo.latLonToNormal
// (js/geo/coords.js): the fragment shader's normalToUV() is the inverse, so a
// vertex placed here samples the texture at exactly its own lat/lon.
export function latLonToLocal(latDeg, lonDeg) {
    const lat = latDeg * DEG, lon = lonDeg * DEG;
    const cl = Math.cos(lat);
    return [cl * Math.cos(lon), Math.sin(lat), -cl * Math.sin(lon)];
}

/**
 * Build a (segs+1)² lat/lon grid over the footprint plus a perimeter skirt.
 * Positions are on the UNIT sphere (radial displacement happens in the vertex
 * shader); normals are radial; `skirt` is 1.0 for skirt-ring vertices so the
 * shader can tuck them under the globe.
 *
 * Longitude is left UNwrapped (lonMinDeg + span may exceed 180) — cos/sin are
 * periodic so a footprint straddling the antimeridian stays one continuous
 * sheet, matching the inset convention in earth-skin.js.
 *
 * @returns {{positions:Float32Array, normals:Float32Array, skirt:Float32Array,
 *            index:Uint32Array, vertexCount:number, triCount:number}}
 */
export function buildPatchArrays({ latMin, latMax, lonMinDeg, lonSpanDeg, segs = 96 }) {
    segs = Math.max(2, segs | 0);
    const nv     = segs + 1;
    const gCount = nv * nv;             // grid vertices
    const skCount = 4 * nv;             // four skirt edges, nv twins each
    const total  = gCount + skCount;

    const positions = new Float32Array(total * 3);
    const normals   = new Float32Array(total * 3);
    const skirt     = new Float32Array(total);
    const index     = [];

    const put = (vi, p, isSkirt) => {
        positions[vi*3] = p[0]; positions[vi*3+1] = p[1]; positions[vi*3+2] = p[2];
        normals[vi*3]   = p[0]; normals[vi*3+1]   = p[1]; normals[vi*3+2]   = p[2];
        skirt[vi] = isSkirt ? 1 : 0;
    };

    // ── Grid vertices ───────────────────────────────────────────────────────
    for (let i = 0; i < nv; i++) {
        const lat = latMin + (latMax - latMin) * (i / segs);
        for (let j = 0; j < nv; j++) {
            const lon = lonMinDeg + lonSpanDeg * (j / segs);
            put(i * nv + j, latLonToLocal(lat, lon), false);
        }
    }
    // Two triangles per quad.
    for (let i = 0; i < segs; i++) {
        for (let j = 0; j < segs; j++) {
            const a = i*nv + j, b = i*nv + j+1, c = (i+1)*nv + j, d = (i+1)*nv + j+1;
            index.push(a, c, b,  b, c, d);
        }
    }

    // ── Perimeter skirt ─────────────────────────────────────────────────────
    // For each edge, duplicate its grid vertices (skirt=1) and stitch a wall of
    // quads between the edge and its twins. The shader pushes skirt verts inward
    // so the wall drops below the globe, hiding the step at the patch boundary.
    let sBase = gCount;
    const addSkirtEdge = (edgeIdx) => {
        const twin = new Array(nv);
        for (let k = 0; k < nv; k++) {
            const gi = edgeIdx(k);
            const vi = sBase + k;
            put(vi, [positions[gi*3], positions[gi*3+1], positions[gi*3+2]], true);
            twin[k] = vi;
        }
        for (let k = 0; k < segs; k++) {
            const g0 = edgeIdx(k), g1 = edgeIdx(k + 1), s0 = twin[k], s1 = twin[k + 1];
            index.push(g0, s0, g1,  g1, s0, s1);
        }
        sBase += nv;
    };
    addSkirtEdge(k => 0 * nv + k);        // north edge  (i = 0)
    addSkirtEdge(k => segs * nv + k);     // south edge  (i = segs)
    addSkirtEdge(k => k * nv + 0);        // west edge   (j = 0)
    addSkirtEdge(k => k * nv + segs);     // east edge   (j = segs)

    return {
        positions, normals, skirt,
        index: new Uint32Array(index),
        vertexCount: total,
        triCount: index.length / 3,
    };
}

// ── Displacement vertex shader ──────────────────────────────────────────────
// Radial displacement only, so the varyings the fragment stage reads
// (vNormalLocal / vWorldNormal) match the undisplaced globe exactly — that is
// what keeps the patch's shading seam-free. GEO_GLSL supplies normalToUV().
export const TERRAIN_VERT = /* glsl */`
${GEO_GLSL}
${INSET_GLSL_HELPERS}
uniform sampler2D u_topology;      // shared with EARTH_FRAG: normalised height (r)
uniform sampler2D u_specular;      // shared: ocean mask (r = ocean)
uniform float u_terrain_exag;      // vertical exaggeration on the normalised global map
uniform float u_terrain_sealevel;  // height value that maps to sea level
uniform float u_terrain_skirt;     // skirt tuck-under depth (globe radii)

// ── High-res DEM inset (T1b, js/earth-dem-inset.js) ─────────────────────────
uniform sampler2D u_dem;           // Terrarium terrain-RGB, resampled to equirect
uniform highp vec4 u_dem_bounds;   // lonMin, latMin, lonSpan, latSpan (degrees)
uniform float u_dem_on;
uniform float u_dem_exag;          // UNITLESS vertical exaggeration on real metres

attribute float aSkirt;

varying vec3 vNormalLocal;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

const float EARTH_RADIUS_M = 6371000.0;

// Terrarium decode: metres = (R·256 + G + B/256) − 32768, RGB in 0..1 → ·255.
// Mirrors decodeTerrarium in js/earth-dem-inset.js — keep them in lockstep.
float demMetres(vec2 uvD) {
    vec3 c = texture2D(u_dem, uvD).rgb * 255.0;
    return (c.r * 256.0 + c.g + c.b / 256.0) - 32768.0;
}

void main() {
    vec3 dir = normalize(position);
    vNormalLocal = dir;
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);

    vec2  uv    = normalToUV(dir);
    float ocean = texture2D(u_specular, uv).r;

    // Base: global normalised height (T1a) — continental swells.
    float h    = texture2D(u_topology, uv).r;
    float disp = u_terrain_exag * max(0.0, h - u_terrain_sealevel) * (1.0 - ocean);

    // Inside the DEM footprint, blend to real-metre elevation (T1b). Physically
    // grounded: metres / Earth radius = elevation in globe radii, so u_dem_exag
    // is a pure vertical-exaggeration factor. Bathymetry (negative) clamps to 0.
    if (u_dem_on > 0.5) {
        vec2  uvD = insetUV(uv, u_dem_bounds);
        float wgt = insetWeight(uvD);
        if (wgt > 0.001) {
            float dispDem = u_dem_exag * max(0.0, demMetres(uvD)) / EARTH_RADIUS_M;
            disp = mix(disp, dispDem, wgt);
        }
    }

    // Skirt-ring vertices ignore the height field and drop straight down under
    // the globe so the patch boundary never shows a floating cliff edge.
    disp = mix(disp, -u_terrain_skirt, aSkirt);

    vec3 dpos = position * (1.0 + disp);
    vWorldPos = (modelMatrix * vec4(dpos, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(dpos, 1.0);
}
`;

/**
 * Runtime driver: subscribes to focus-footprint-change, rebuilds the patch
 * geometry over the current footprint when zoomed in past activateSpanDeg, and
 * keeps a single mesh parented to earthMesh. Disabled by default; the page
 * enables it behind a flag + governor gate.
 */
export class EarthTerrainPatch {
    constructor({
        THREE, earthMesh, earthUniforms, fragmentShader,
        segs = 96, activateSpanDeg = 18,
        exaggeration = 0.035, seaLevel = 0.5, skirtDepth = 0.02,
        demExaggeration = 22,
    }) {
        this._THREE   = THREE;
        this._parent  = earthMesh;
        this._segs    = segs;
        this._activate = activateSpanDeg;
        this._enabled = false;
        this._fp      = null;

        this._uniforms = Object.assign({}, earthUniforms, {
            u_terrain_exag:     { value: exaggeration },
            u_terrain_sealevel: { value: seaLevel },
            u_terrain_skirt:    { value: skirtDepth },
            // DEM inset (T1b) — off until earth-dem-inset feeds a texture.
            u_dem:        { value: _placeholderTex(THREE) },
            u_dem_bounds: { value: new THREE.Vector4(0, 0, 1, 1) },
            u_dem_on:     { value: 0 },
            u_dem_exag:   { value: demExaggeration },
        });

        this._mat = new THREE.ShaderMaterial({
            vertexShader:   TERRAIN_VERT,
            fragmentShader,                     // the composed EARTH_FRAG, verbatim
            uniforms:       this._uniforms,
            side:           THREE.DoubleSide,   // skirt wall + winding-agnostic (blind-safe)
            polygonOffset:  true,               // sit just above the coincident globe
            polygonOffsetFactor: -1,
            polygonOffsetUnits:  -1,
        });

        this._geo  = new THREE.BufferGeometry();
        this._mesh = new THREE.Mesh(this._geo, this._mat);
        this._mesh.renderOrder   = 1;           // draw after the globe (occlude where lifted)
        this._mesh.frustumCulled = false;       // displaced verts exceed the base bounds
        this._mesh.visible = false;
        this._parent.add(this._mesh);

        this._onFootprint = this._onFootprint.bind(this);
        document.addEventListener('focus-footprint-change', this._onFootprint);
    }

    setEnabled(on) {
        this._enabled = !!on;
        if (!this._enabled) { this._mesh.visible = false; return; }
        if (this._fp) this._onFootprint({ detail: this._fp });
    }

    setExaggeration(v) { this._uniforms.u_terrain_exag.value = v; }
    setSeaLevel(v)     { this._uniforms.u_terrain_sealevel.value = v; }
    setDemExaggeration(v) { this._uniforms.u_dem_exag.value = v; }

    /**
     * Feed a resampled DEM tile canvas (from js/earth-dem-inset.js) as the
     * high-res elevation inset. NearestFilter — the packed terrain-RGB encoding
     * must not be linearly interpolated.
     * @param {{canvas:HTMLCanvasElement, bounds:{lonMin,latMin,lonSpan,latSpan}}} d
     */
    setDemInset({ canvas, bounds }) {
        if (!canvas || !bounds) return;
        const THREE = this._THREE;
        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        const old = this._uniforms.u_dem.value;
        this._uniforms.u_dem.value = tex;
        this._uniforms.u_dem_bounds.value.set(bounds.lonMin, bounds.latMin, bounds.lonSpan, bounds.latSpan);
        this._uniforms.u_dem_on.value = 1;
        if (old && old.dispose) old.dispose();
    }

    clearDemInset() { this._uniforms.u_dem_on.value = 0; }

    _onFootprint(ev) {
        const fp = ev.detail;
        this._fp = fp;
        if (!this._enabled || !fp) { this._mesh.visible = false; return; }
        if (fp.spanLatDeg > this._activate) { this._mesh.visible = false; return; }
        try {
            this._rebuild(fp);
            this._mesh.visible = true;
        } catch (e) {
            this._mesh.visible = false;         // never break the globe
        }
    }

    _rebuild(fp) {
        const { positions, normals, skirt, index } = buildPatchArrays({
            latMin: fp.latMin, latMax: fp.latMax,
            lonMinDeg: fp.lonMin, lonSpanDeg: fp.spanLonDeg,
            segs: this._segs,
        });
        const THREE = this._THREE;
        const g = this._geo;
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        g.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));
        g.setAttribute('aSkirt',   new THREE.BufferAttribute(skirt, 1));
        g.setIndex(new THREE.BufferAttribute(index, 1));
        g.attributes.position.needsUpdate = true;
    }

    dispose() {
        document.removeEventListener('focus-footprint-change', this._onFootprint);
        this._parent.remove(this._mesh);
        this._geo.dispose();
        this._mat.dispose();
    }
}
