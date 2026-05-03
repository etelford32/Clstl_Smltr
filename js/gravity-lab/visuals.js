/**
 * visuals.js — Visual stack for the Gravity Lab.
 *
 * Reuses the solar system simulation's planet skins (Earth, Moon, Jupiter)
 * for the parent bodies, and adds bespoke procedural surfaces for Mars and
 * Saturn plus Saturn-style rings, distance-fading orbit guides, label
 * sprites, and an upgraded starfield with a Milky Way band.
 *
 * The integrator and HUD never see any of this — lab.js calls into this
 * module to build a Group per body, then just translates the group every
 * frame from the body's position vector.
 */

import * as THREE from 'three';

import { JupiterSkin } from '../jupiter-skin.js';
import { EarthSkin }   from '../earth-skin.js';
import { MoonSkin }    from '../moon-skin.js';

const D2R = Math.PI / 180;

// ─────────────────────────────────────────────────────────────────────────────
// Body visuals — returns { group, surfaceMesh, skin?, dispose() }
//
//   group:        THREE.Group containing all body geometry (positioned per
//                 frame by lab.js)
//   surfaceMesh:  the central sphere — used as the raycast hit target
//   skin:         optional skin instance with update(t) / setSunDir(v)
// ─────────────────────────────────────────────────────────────────────────────

export function createBodyVisual(body, parent, opts) {
    const {
        radiusUnits,
        sunDir       = new THREE.Vector3(1, 0, 0),
        renderer     = null,
        segmentsHigh = 64,
        segmentsLow  = 24,
    } = opts;

    const group = new THREE.Group();
    group.name = `body_${body.name}`;
    parent.add(group);

    let surfaceMesh, skin = null;

    switch (body.skin) {
        case 'jupiter': {
            const j = new JupiterSkin(group, {
                radius:     radiusUnits,
                quality:    'high',
                rings:      false,         // Jupiter rings are very faint here
                atmosphere: true,
                segments:   segmentsHigh,
            });
            // Jupiter shader bakes its own day-side appearance; drop a faint
            // ambient halo at the equator for sex appeal at far zoom.
            _addRimGlow(group, radiusUnits * 1.18, 0xffd089, 0.06);
            surfaceMesh = j.mesh;
            skin = j;
            break;
        }
        case 'earth': {
            const e = new EarthSkin(group, sunDir, {
                radius:     radiusUnits,
                segments:   segmentsHigh,
                clouds:     true,
                atmosphere: true,
            });
            e.loadTextures();
            surfaceMesh = e.earthMesh;
            skin = e;
            break;
        }
        case 'moon': {
            const m = new MoonSkin(group, sunDir, {
                radius:    radiusUnits,
                segments:  segmentsHigh,
                radiation: false,
            });
            m.loadTextures(renderer);
            surfaceMesh = m.moonMesh;
            skin = m;
            break;
        }
        case 'mars': {
            surfaceMesh = _makeMars(radiusUnits, segmentsHigh);
            group.add(surfaceMesh);
            _addRimGlow(group, radiusUnits * 1.04, 0xff8c5a, 0.07);
            break;
        }
        case 'saturn': {
            surfaceMesh = _makeSaturn(radiusUnits, segmentsHigh);
            group.add(surfaceMesh);
            _addRimGlow(group, radiusUnits * 1.04, 0xffe6a8, 0.07);
            break;
        }
        default: {
            // Unskinned body — pick a procedural surface based on `surface` hint.
            surfaceMesh = _makeProcedural(body, radiusUnits, segmentsLow);
            group.add(surfaceMesh);
            // Faint glow for parents.
            if (body.is_parent && body.glow !== undefined) {
                _addRimGlow(group, radiusUnits * 1.15, body.glow, 0.10);
            }
        }
    }

    surfaceMesh.userData.bodyName = body.name;
    surfaceMesh.userData.bodyIdx  = -1;          // backfilled by lab.js

    return { group, surfaceMesh, skin, dispose: () => _dispose(group) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Saturn-style rings — ring system data lives on the system descriptor.
// Returns the group of ring meshes (caller adds it to the parent bodyGroup).
// ─────────────────────────────────────────────────────────────────────────────

export function createRingSystem(rings, planetRadiusUnits) {
    const group = new THREE.Group();
    group.name = 'rings';

    const inner = planetRadiusUnits * rings.inner_R;
    const outer = planetRadiusUnits * rings.outer_R;
    const tilt  = (rings.tilt_deg ?? 0) * D2R;
    const color = rings.color   ?? 0xd4c88a;
    const op    = rings.opacity ?? 0.6;

    // Three concentric ring annuli of slightly different tints to suggest the
    // C/B/A ring transition.
    const slices = [
        { in: inner,                  out: inner + (outer - inner) * 0.30, color: 0xb09a72, opacity: op * 0.55 },
        { in: inner + (outer - inner) * 0.30, out: inner + (outer - inner) * 0.72, color,                  opacity: op       },
        { in: inner + (outer - inner) * 0.72, out: outer,                  color: 0xc9b988, opacity: op * 0.85 },
    ];
    for (const s of slices) {
        const ring = _makeRingMesh(s.in, s.out, s.color, s.opacity, 128);
        group.add(ring);
    }

    // Cassini-style gaps: punch a thin darker annulus through the stack.
    if (rings.gaps?.length) {
        for (const g of rings.gaps) {
            const r0 = planetRadiusUnits * (g.r - g.half_w);
            const r1 = planetRadiusUnits * (g.r + g.half_w);
            const gap = _makeRingMesh(r0, r1, 0x000000, 1 - g.opacity, 96, true);
            // Slight lift above the rings so it draws on top.
            gap.position.y = 0.0003 * planetRadiusUnits;
            group.add(gap);
        }
    }

    // Tilt the whole disk so it sits in the parent's equatorial plane.
    group.rotation.x = Math.PI / 2 - tilt;
    return group;
}

function _makeRingMesh(inner, outer, color, opacity, seg = 96, isGap = false) {
    const geo = new THREE.RingGeometry(inner, outer, seg, 1);
    const mat = new THREE.MeshBasicMaterial({
        color,
        side:        THREE.DoubleSide,
        transparent: true,
        opacity,
        depthWrite:  false,
    });
    if (isGap) {
        mat.blending = THREE.NormalBlending;
        mat.color = new THREE.Color(0x05030f);
    }
    return new THREE.Mesh(geo, mat);
}

// ─────────────────────────────────────────────────────────────────────────────
// Orbit guide ring — draws a faint Keplerian outline so users can see how
// far the trail has deviated from the unperturbed orbit (very satisfying
// for the J2 Mars demo and the Janus/Epimetheus swap).
// ─────────────────────────────────────────────────────────────────────────────

export function createOrbitGuide(elements, scaleKmPerUnit, color, opacity = 0.20) {
    const KM_PER_M = 1e-3;
    const a = elements.a * KM_PER_M / scaleKmPerUnit;
    const e = elements.e ?? 0;
    const i = (elements.i_deg    ?? 0) * D2R;
    const O = (elements.raan_deg ?? 0) * D2R;
    const w = (elements.argp_deg ?? 0) * D2R;

    // Match the rotation used by physics.elementsToState exactly so this
    // guide overlays the integrated trail at t=0 (no axis swaps — lab.js
    // already maps body r[0..2] straight to scene x/y/z).
    const cR = Math.cos(O), sR = Math.sin(O);
    const ci = Math.cos(i), si = Math.sin(i);
    const cw = Math.cos(w), sw = Math.sin(w);
    const R11 =  cR * cw - sR * sw * ci;
    const R12 = -cR * sw - sR * cw * ci;
    const R21 =  sR * cw + cR * sw * ci;
    const R22 = -sR * sw + cR * cw * ci;
    const R31 =  sw * si;
    const R32 =  cw * si;

    const N = 256;
    const pts = new Float32Array(N * 3);
    for (let k = 0; k < N; k++) {
        const nu = (k / (N - 1)) * 2 * Math.PI;
        const r  = a * (1 - e * e) / (1 + e * Math.cos(nu));
        const xp = r * Math.cos(nu);
        const yp = r * Math.sin(nu);
        pts[k * 3]     = R11 * xp + R12 * yp;
        pts[k * 3 + 1] = R21 * xp + R22 * yp;
        pts[k * 3 + 2] = R31 * xp + R32 * yp;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({
        color, transparent: true, opacity, depthWrite: false,
    });
    const line = new THREE.LineLoop(geom, mat);
    line.userData.kind = 'orbit-guide';
    return line;
}

// ─────────────────────────────────────────────────────────────────────────────
// Label sprite — small text tag that rides above each body in screen space.
// ─────────────────────────────────────────────────────────────────────────────

export function createLabelSprite(text, color = '#ffffff', accent = '#cba9ff') {
    const cv = document.createElement('canvas');
    const W = 256, H = 64;
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.font         = '600 28px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'left';
    // Soft halo behind glyphs for legibility against bright planets.
    ctx.shadowColor   = '#000000';
    ctx.shadowBlur    = 6;
    ctx.fillStyle     = color;
    ctx.fillText(text, 18, H / 2 + 1);
    ctx.shadowBlur    = 0;
    // Accent dot.
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(8, H / 2, 4, 0, Math.PI * 2);
    ctx.fill();

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter  = THREE.LinearFilter;
    tex.magFilter  = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: false,
    });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(2.4, 0.6, 1);     // world-units; lab.js can rescale per-system
    spr.renderOrder = 999;
    return spr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Starfield — replaces the basic dot cloud with size/color variation and a
// faint Milky Way band.
// ─────────────────────────────────────────────────────────────────────────────

export function createStarfield() {
    const group = new THREE.Group();
    group.name = 'starfield';

    // Scattered point stars
    const N   = 2200;
    const R   = 1500;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const siz = new Float32Array(N);

    const tints = [
        [0.85, 0.92, 1.00],   // blue-white (hot)
        [0.95, 0.97, 1.00],   // white
        [1.00, 0.96, 0.84],   // sun-like
        [1.00, 0.84, 0.65],   // K-class
        [1.00, 0.72, 0.55],   // M dwarf
    ];

    for (let i = 0; i < N; i++) {
        const u = Math.random() * 2 - 1;
        const t = Math.random() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        // Concentrate ~30% of stars in a narrow band (Milky Way-like)
        const inBand = Math.random() < 0.32;
        const lat = inBand
            ? (Math.random() - 0.5) * 0.18           // ±10° band
            : Math.asin(u);
        const z   = Math.sin(lat);
        const ct  = Math.cos(lat);
        pos[i * 3]     = R * ct * Math.cos(t);
        pos[i * 3 + 1] = R * z;
        pos[i * 3 + 2] = R * ct * Math.sin(t);
        const tint = tints[Math.floor(Math.random() * tints.length)];
        // Random brightness — most stars dim, a few bright.
        const m = Math.pow(Math.random(), 3.0) * 0.6 + 0.4;
        col[i * 3]     = tint[0] * m;
        col[i * 3 + 1] = tint[1] * m;
        col[i * 3 + 2] = tint[2] * m;
        siz[i] = inBand ? 0.4 + Math.random() * 0.4 : 0.5 + Math.random() * 1.4;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('color',    new THREE.BufferAttribute(col, 3));
    geom.setAttribute('size',     new THREE.BufferAttribute(siz, 1));

    const mat = new THREE.PointsMaterial({
        size:            1.2,
        sizeAttenuation: false,
        vertexColors:    true,
        transparent:     true,
        opacity:         0.9,
        depthWrite:      false,
    });
    const pts = new THREE.Points(geom, mat);
    group.add(pts);

    // Diffuse Milky Way band — a low-opacity ring/cylinder of additive light.
    const bandTex = _makeBandTexture();
    const bandGeo = new THREE.CylinderGeometry(R * 0.92, R * 0.92, R * 0.55, 64, 1, true);
    const bandMat = new THREE.MeshBasicMaterial({
        map:         bandTex,
        side:        THREE.BackSide,
        transparent: true,
        opacity:     0.35,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
    });
    const band = new THREE.Mesh(bandGeo, bandMat);
    band.rotation.z = 0.32;
    band.rotation.x = 0.10;
    group.add(band);

    return group;
}

function _makeBandTexture() {
    const W = 1024, H = 256;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    // Vertical gradient: bright in middle, fades to nothing at top/bottom.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0.0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(180,170,210,0.55)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // Sprinkle warm dust mottling.
    for (let i = 0; i < 360; i++) {
        const x = Math.random() * W;
        const y = (Math.random() * 0.6 + 0.2) * H;
        const r = Math.random() * 22 + 6;
        const alpha = Math.random() * 0.18 + 0.04;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, `rgba(255,210,150,${alpha})`);
        grad.addColorStop(1, 'rgba(255,210,150,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal — procedural surfaces / helpers
// ─────────────────────────────────────────────────────────────────────────────

function _addRimGlow(parent, radius, color, opacity) {
    const halo = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 36, 24),
        new THREE.MeshBasicMaterial({
            color, transparent: true, opacity,
            side: THREE.BackSide, depthWrite: false,
            blending: THREE.AdditiveBlending,
        }),
    );
    parent.add(halo);
    return halo;
}

const _MARS_VERT = /* glsl */`
    varying vec3 vPos;
    varying vec3 vWorldNormal;
    void main() {
        vPos         = normalize(position);
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
const _MARS_FRAG = /* glsl */`
    precision highp float;
    varying vec3 vPos;
    varying vec3 vWorldNormal;
    uniform vec3 u_sun_dir;

    float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453); }
    float vnoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f*f*(3.0-2.0*f);
        float n = mix(
            mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x),
                mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
            mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x),
                mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y),
            f.z);
        return n;
    }
    float fbm(vec3 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += a*vnoise(p); p *= 2.05; a *= 0.5; }
        return v;
    }

    void main() {
        // Latitude — drives polar caps.
        float lat = vPos.y;
        float polar = smoothstep(0.78, 0.95, abs(lat));
        // Continent vs maria mottling.
        float n = fbm(vPos * 4.0);
        float n2 = fbm(vPos * 12.0 + 3.7) * 0.5;
        float h = clamp(n * 0.7 + n2, 0.0, 1.2);
        // Color ramp: deep rust → ochre → tan highlands.
        vec3 rust  = vec3(0.55, 0.18, 0.10);
        vec3 ochre = vec3(0.78, 0.36, 0.18);
        vec3 tan   = vec3(0.86, 0.62, 0.40);
        vec3 col   = mix(rust, ochre, smoothstep(0.20, 0.55, h));
        col        = mix(col,  tan,   smoothstep(0.55, 0.95, h));
        // CO2 polar caps.
        col = mix(col, vec3(0.93, 0.94, 0.97), polar);
        // Vallis/dust streaks: thin lat-stripes for terminator drama.
        float stripe = sin(lat * 38.0 + n * 6.0) * 0.5 + 0.5;
        col *= 0.92 + stripe * 0.10;

        // Diffuse lighting against the world-space normal.
        float NdotL = max(dot(normalize(vWorldNormal), normalize(u_sun_dir)), 0.0);
        float lit = 0.18 + 0.82 * NdotL;
        gl_FragColor = vec4(col * lit, 1.0);
    }
`;

function _makeMars(radiusUnits, segments) {
    const mat = new THREE.ShaderMaterial({
        vertexShader:   _MARS_VERT,
        fragmentShader: _MARS_FRAG,
        uniforms: {
            u_sun_dir: { value: new THREE.Vector3(1, 0, 0) },
        },
    });
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radiusUnits, segments, Math.round(segments * 0.7)),
        mat,
    );
    mesh.userData.surfaceUniforms = mat.uniforms;
    return mesh;
}

const _SAT_VERT = _MARS_VERT;
const _SAT_FRAG = /* glsl */`
    precision highp float;
    varying vec3 vPos;
    varying vec3 vWorldNormal;
    uniform vec3 u_sun_dir;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float vnoise2(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                   mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
    }
    float fbm2(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { v += a*vnoise2(p); p *= 2.0; a *= 0.5; }
        return v;
    }

    void main() {
        float lat = vPos.y;
        // Wide pale bands — Saturn is much less dramatic than Jupiter.
        float bands = sin(lat * 14.0) * 0.5 + 0.5;
        // Soften with horizontal turbulence for the "watercolor" look.
        float turb = fbm2(vec2(lat * 18.0, atan(vPos.x, vPos.z) * 4.0));
        bands = clamp(bands + turb * 0.18 - 0.09, 0.0, 1.0);
        // Cream ↔ butter palette.
        vec3 cream  = vec3(0.96, 0.90, 0.74);
        vec3 butter = vec3(0.86, 0.74, 0.50);
        vec3 col    = mix(butter, cream, bands);
        // Pole shading.
        float pole = smoothstep(0.7, 1.0, abs(lat));
        col = mix(col, vec3(0.66, 0.58, 0.42), pole * 0.55);
        // Hex-ish polar vortex hint at the north pole.
        if (lat > 0.85) {
            float hex = sin(atan(vPos.x, vPos.z) * 3.0) * 0.5 + 0.5;
            col = mix(col, vec3(0.45, 0.55, 0.70), hex * 0.18);
        }
        // Lighting + limb darkening.
        float NdotL = max(dot(normalize(vWorldNormal), normalize(u_sun_dir)), 0.0);
        float limb  = 0.55 + 0.45 * NdotL;
        gl_FragColor = vec4(col * limb, 1.0);
    }
`;

function _makeSaturn(radiusUnits, segments) {
    const mat = new THREE.ShaderMaterial({
        vertexShader:   _SAT_VERT,
        fragmentShader: _SAT_FRAG,
        uniforms: {
            u_sun_dir: { value: new THREE.Vector3(1, 0, 0) },
        },
    });
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radiusUnits, segments, Math.round(segments * 0.7)),
        mat,
    );
    mesh.userData.surfaceUniforms = mat.uniforms;
    return mesh;
}

function _makeProcedural(body, radiusUnits, segments) {
    // Pick a base palette for icy / volcanic / cratered moons so the simple
    // MeshStandardMaterial reads like more than a flat-shaded ball.
    const surface = body.surface || (body.is_parent ? 'gas-giant' : 'rocky-cool');
    const base    = body.color ?? 0xaaaaaa;
    const params = {
        'icy':         { roughness: 0.55, metalness: 0.04, emissive: 0x223344, emissiveIntensity: 0.05 },
        'volcanic':    { roughness: 0.78, metalness: 0.02, emissive: 0x331100, emissiveIntensity: 0.20 },
        'cratered':    { roughness: 0.95, metalness: 0.0,  emissive: 0x000000, emissiveIntensity: 0.0  },
        'rocky-cool':  { roughness: 0.88, metalness: 0.0,  emissive: 0x000000, emissiveIntensity: 0.0  },
        'rocky-warm':  { roughness: 0.80, metalness: 0.0,  emissive: 0x110000, emissiveIntensity: 0.05 },
        'asteroid':    { roughness: 1.00, metalness: 0.05, emissive: 0x000000, emissiveIntensity: 0.0  },
        'gas-giant':   { roughness: 0.55, metalness: 0.0,  emissive: base,    emissiveIntensity: 0.18 },
    }[surface] ?? { roughness: 0.85, metalness: 0.0, emissive: 0x000000, emissiveIntensity: 0.0 };

    const mat = new THREE.MeshStandardMaterial({ color: base, ...params });
    return new THREE.Mesh(
        new THREE.SphereGeometry(radiusUnits, segments, Math.round(segments * 0.7)),
        mat,
    );
}

function _dispose(group) {
    while (group.children.length) {
        const c = group.children.pop();
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
            if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
            else c.material.dispose();
        }
        if (c.children?.length) _dispose(c);
    }
}
