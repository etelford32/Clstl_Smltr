/**
 * js/auroracle-globe.js — real-time 3D aurora analyzer for auroracle.html.
 *
 * A small (≈300×400) Three.js globe that plots the live OVATION Prime
 * auroral footprint on Earth: every bright grid cell becomes an additive
 * glow point coloured by probability, so you literally see the oval and
 * where it's strongest right now. Saved/selected locations drop as pins so
 * a user can tell at a glance whether their sky is under the oval.
 *
 * Design notes
 * ────────────
 *  • Self-contained: no external textures, no 178 KB shared globe. Earth is
 *    a procedural "analyzer" sphere (graticule + day/night terminator) so
 *    the widget has zero network deps beyond the aurora data itself.
 *  • Everything lives in `earthGroup`, the GEOGRAPHIC frame — it is never
 *    rotated. The Sun direction is the real sub-solar point (also geographic),
 *    so the terminator sits where night actually is. The "live" spin is just
 *    OrbitControls.autoRotate orbiting the camera, which keeps aurora points,
 *    pins, graticule and terminator all mutually consistent.
 *  • Bare `three` specifier is resolved by the page importmap (same vendored
 *    build as far-side-watch). The controller loads this with dynamic import()
 *    and degrades gracefully if WebGL / the vendor file is unavailable.
 *
 * Usage (mirrors farside-globe.js):
 *   import { AuroraGlobe } from './auroracle-globe.js';
 *   const g = new AuroraGlobe(canvas);
 *   g.setAurora({ cells, north_gw, south_gw, updated });   // from /api/noaa/aurora-grid
 *   g.setLocations(list, currentId);                       // pins
 *   g.start();
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DEG = Math.PI / 180;
const R = 1;                       // Earth radius in scene units

/** Geographic (lat°, lonEast°) → scene vector. The single source of truth:
 *  the Earth shader inverts this exact mapping for its graticule/terminator. */
function latLonToVec3(latDeg, lonDeg, r = R) {
    const phi = latDeg * DEG, theta = lonDeg * DEG;
    const cl = Math.cos(phi);
    return new THREE.Vector3(r * cl * Math.cos(theta), r * Math.sin(phi), -r * cl * Math.sin(theta));
}

/** Sub-solar geographic point right now (declination + noon meridian). */
function subsolarDir(date = new Date()) {
    // Day-of-year solar declination (Cooper 1969), good to ~0.5°.
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    const doy = Math.floor((date.getTime() - start) / 86400000);
    const decl = -23.44 * Math.cos((360 / 365) * (doy + 10) * DEG);
    // Sub-solar longitude (East): 0° at 12:00 UTC, −15°/h after.
    const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    let lonE = (12 - utcH) * 15;
    lonE = ((lonE + 180) % 360 + 360) % 360 - 180;
    return latLonToVec3(decl, lonE).normalize();
}

/* ── Earth: procedural "analyzer" sphere ─────────────────────────────────── */
function earthMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) } },
        vertexShader: /* glsl */`
            varying vec3 vPos;
            void main() {
                vPos = position;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: /* glsl */`
            precision highp float;
            uniform vec3 uSun;
            varying vec3 vPos;
            const float PI = 3.14159265359;
            // intensity of the nearest graticule line, spaced step degrees apart
            float grat(float deg, float step, float halfW) {
                float d = abs(mod(deg + step * 0.5, step) - step * 0.5);
                return 1.0 - smoothstep(0.0, halfW, d);
            }
            void main() {
                vec3 n = normalize(vPos);
                float lat = asin(clamp(n.y, -1.0, 1.0)) * 180.0 / PI;
                float lon = atan(-n.z, n.x) * 180.0 / PI;

                float day = dot(n, normalize(uSun));        // -1 night .. +1 noon
                float dayl = smoothstep(-0.18, 0.30, day);

                vec3 night = vec3(0.012, 0.026, 0.060);
                vec3 dayc  = vec3(0.040, 0.105, 0.190);
                vec3 col = mix(night, dayc, dayl);

                // polar caps read a touch brighter/cooler
                float ice = smoothstep(0.86, 1.0, abs(n.y));
                col = mix(col, vec3(0.10, 0.16, 0.27), ice * 0.45);

                // graticule — 30° grid, brighter equator + prime meridian
                float g = max(grat(lat, 30.0, 0.8), grat(lon, 30.0, 0.8));
                float gEq = grat(lat, 180.0, 1.0);          // equator
                float gPm = grat(lon, 360.0, 1.0);          // prime meridian
                vec3 gridCol = vec3(0.30, 0.80, 0.92);
                col += gridCol * (g * 0.10 + max(gEq, gPm) * 0.10);

                // soft day-terminator warm edge
                float term = 1.0 - smoothstep(0.0, 0.10, abs(day));
                col += vec3(0.18, 0.10, 0.04) * term * 0.5;

                gl_FragColor = vec4(col, 1.0);
            }`,
    });
}

/** Faint additive atmosphere rim (Fresnel), cyan to match the page. */
function atmosphereMesh() {
    const mat = new THREE.ShaderMaterial({
        transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
        vertexShader: /* glsl */`
            varying float vR;
            void main() {
                vec3 nn = normalize(normalMatrix * normal);
                vec3 vv = normalize((modelViewMatrix * vec4(position, 1.0)).xyz);
                vR = pow(1.0 - abs(dot(nn, vv)), 3.0);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: /* glsl */`
            precision highp float;
            varying float vR;
            void main() { gl_FragColor = vec4(vec3(0.20, 0.62, 0.78) * vR, vR * 0.9); }`,
    });
    return new THREE.Mesh(new THREE.SphereGeometry(R * 1.16, 48, 32), mat);
}

/** Aurora point cloud material — per-point size + green→amber→red by prob. */
function auroraPointsMaterial(pixelRatio) {
    return new THREE.ShaderMaterial({
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        uniforms: { uPixelRatio: { value: pixelRatio }, uSize: { value: 7.0 } },
        vertexShader: /* glsl */`
            attribute float aProb;          // 0..1
            varying float vProb;
            uniform float uPixelRatio;
            uniform float uSize;
            void main() {
                vProb = aProb;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = uSize * uPixelRatio * (0.55 + aProb) * (300.0 / max(-mv.z, 0.1));
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */`
            precision highp float;
            varying float vProb;
            void main() {
                vec2 uv = gl_PointCoord - 0.5;
                float d = length(uv);
                if (d > 0.5) discard;
                float a = smoothstep(0.5, 0.0, d);
                vec3 lo  = vec3(0.20, 1.00, 0.55);
                vec3 mid = vec3(1.00, 0.85, 0.25);
                vec3 hi  = vec3(1.00, 0.28, 0.36);
                vec3 c = vProb < 0.5 ? mix(lo, mid, vProb * 2.0) : mix(mid, hi, (vProb - 0.5) * 2.0);
                gl_FragColor = vec4(c, a * (0.30 + 0.70 * vProb));
            }`,
    });
}

/** Camera-facing text label sprite (same recipe as farside-globe.makeLabel).
 *  depthTest=false keeps a label always on top (the "you" pin); true lets the
 *  globe occlude it, which is what we want for the many reference-city labels
 *  so only the near-side ones show. */
function makeLabel(text, color = '#cdeefe', scale = 0.26, depthTest = false) {
    const pad = 8, font = 44;
    const cvs = document.createElement('canvas');
    let ctx = cvs.getContext('2d');
    ctx.font = `700 ${font}px ui-monospace, Menlo, monospace`;
    cvs.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
    cvs.height = font + pad * 2;
    ctx = cvs.getContext('2d');
    ctx.font = `700 ${font}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(4,8,18,0.66)';
    ctx.fillRect(0, 0, cvs.width, cvs.height);
    ctx.fillStyle = color;
    ctx.fillText(text, pad, cvs.height / 2);
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest }));
    spr.scale.set(scale * (cvs.width / cvs.height), scale, 1);
    return spr;
}

/* ── coarse region naming for "where it's brightest" (self-contained) ─────── */
function regionName(lat, lonEast) {
    const lon = ((lonEast + 180) % 360 + 360) % 360 - 180;   // -180..180
    if (lat >= 0) {
        if (lon >= -170 && lon < -100) return 'Alaska & NW Canada';
        if (lon >= -100 && lon < -55)  return 'Hudson Bay & N. Canada';
        if (lon >= -55  && lon < -18)  return 'Greenland & N. Atlantic';
        if (lon >= -18  && lon < 42)   return 'Scandinavia & N. Europe';
        if (lon >= 42   && lon < 100)  return 'N. Russia';
        if (lon >= 100  && lon < 170)  return 'Siberia & Far East';
        return 'Bering Sea';
    }
    if (lon >= -110 && lon < 20)  return 'S. Atlantic & Antarctica';
    if (lon >= 20   && lon < 140) return 'S. Indian Ocean';
    return 'Ross Sea & S. Pacific';
}

/** Angular gap² (deg², in lat/lon space) between a [lonEast,lat] point and a
 *  city {lat,lon(−180..180)}, wrapping longitude. Cheap planar proxy — fine at
 *  the small radii we test (used only to pick the nearest landmark). */
function cityGap2(lat, lonEast, city) {
    const L = ((lonEast % 360) + 360) % 360, cl = ((city.lon % 360) + 360) % 360;
    const dlat = city.lat - lat;
    let dlon = cl - L; if (dlon > 180) dlon -= 360; else if (dlon < -180) dlon += 360;
    return dlat * dlat + dlon * dlon;
}

/** Nearest hotspot city to a cell, within maxDeg — else null. */
function nearestCity(lat, lonEast, cities, maxDeg) {
    if (!Array.isArray(cities) || !cities.length) return null;
    let best = null, bd = maxDeg * maxDeg;
    for (const c of cities) {
        if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
        const d2 = cityGap2(lat, lonEast, c);
        if (d2 < bd) { bd = d2; best = c; }
    }
    return best;
}

/** Live OVATION probability over a city (nearest bright cell within maxDeg). */
export function probOverCity(city, cells, maxDeg = 4) {
    if (!Array.isArray(cells) || !cells.length || !city) return null;
    let best = null, bd = maxDeg * maxDeg;
    for (const c of cells) {
        const d2 = cityGap2(c[1], c[0], city);
        if (d2 < bd) { bd = d2; best = c[2]; }
    }
    return best;
}

/**
 * Top-N brightest named regions from a cell list, one entry per name (so the
 * caption isn't three rows of "N. Canada"). When `cities` is supplied, a bright
 * cell near a hotspot is labelled with that city ("Fairbanks") instead of the
 * coarse continental band — more concrete and useful. Cells are [lon,lat,prob].
 */
export function brightestRegions(cells, n = 3, cities = null) {
    if (!Array.isArray(cells)) return [];
    const best = new Map();
    for (const c of cells) {
        const lon = c[0], lat = c[1], prob = c[2];
        const city = nearestCity(lat, lon, cities, 7);
        const name = city ? city.name.split(',')[0] : regionName(lat, lon);
        const cur = best.get(name);
        if (!cur || prob > cur.prob) best.set(name, { name, lat, lon, prob });
    }
    return [...best.values()].sort((a, b) => b.prob - a.prob).slice(0, n);
}

export class AuroraGlobe {
    constructor(canvas) {
        this.canvas = canvas;
        this._raf = 0;
        this._t = 0;
        this._cells = [];
        this._pointsMesh = null;
        this._markerGroup = null;
        this._pinGroup = null;
        this._refGroup = null;     // hotspot-city reference landmarks
        this._refDots = [];        // [{ city, dot }] — recoloured as the oval moves

        const pr = Math.min(window.devicePixelRatio || 1, 2);
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        this.renderer.setPixelRatio(pr);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(38, 0.75, 0.1, 100);
        this.camera.position.set(1.6, 1.7, 2.7);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.enablePan = false;
        this.controls.enableZoom = true;
        this.controls.minDistance = 2.0;
        this.controls.maxDistance = 6.0;
        this._reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        this.controls.autoRotate = !this._reduced;
        this.controls.autoRotateSpeed = 0.55;     // gentle "live" orbit
        this.controls.target.set(0, 0, 0);

        // Geographic frame — never rotated; the camera orbits instead.
        this.earthGroup = new THREE.Group();
        this.scene.add(this.earthGroup);

        this.earthMat = earthMaterial();
        this.earthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(R, 72, 48), this.earthMat));
        this.earthGroup.add(atmosphereMesh());

        this._pointsMat = auroraPointsMaterial(pr);
        this.setSubsolar(new Date());

        this._resize();
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(canvas);
        this._renderOnce();
    }

    /** Update the day/night terminator to the current sub-solar point. */
    setSubsolar(date = new Date()) {
        this.earthMat.uniforms.uSun.value.copy(subsolarDir(date));
        if (!this._raf) this._renderOnce();
    }

    /**
     * Plot the live aurora footprint.
     * @param {{cells:Array<[number,number,number]>, north_gw?:number, south_gw?:number}} data
     */
    setAurora(data = {}) {
        const cells = Array.isArray(data.cells) ? data.cells : [];
        this._cells = cells;

        if (this._pointsMesh) { this.earthGroup.remove(this._pointsMesh); this._pointsMesh.geometry.dispose(); this._pointsMesh = null; }
        if (this._markerGroup) { this.earthGroup.remove(this._markerGroup); this._disposeGroup(this._markerGroup); this._markerGroup = null; }

        if (cells.length) {
            const pos = new Float32Array(cells.length * 3);
            const prob = new Float32Array(cells.length);
            for (let i = 0; i < cells.length; i++) {
                const [lon, lat, p] = cells[i];
                const v = latLonToVec3(lat, lon, R * 1.012);
                pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
                prob[i] = Math.max(0, Math.min(1, p / 100));
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            geo.setAttribute('aProb', new THREE.BufferAttribute(prob, 1));
            this._pointsMesh = new THREE.Points(geo, this._pointsMat);
            this._pointsMesh.frustumCulled = false;
            this.earthGroup.add(this._pointsMesh);

            // Pulsing ring on the single brightest cell per hemisphere.
            this._markerGroup = new THREE.Group();
            for (const hemi of [1, -1]) {
                const top = cells.filter(c => Math.sign(c[1]) === hemi).sort((a, b) => b[2] - a[2])[0];
                if (top) this._markerGroup.add(this._makeHotspot(top[1], top[0]));
            }
            this.earthGroup.add(this._markerGroup);
        }
        this._recolorReferenceCities();      // light up hotspot cities under the live oval
        if (!this._raf) this._renderOnce();
    }

    /**
     * Drop the aurora hotspot cities as map landmarks: dim dots that brighten
     * to green when the live oval is over them, so the textureless globe gains
     * geographic anchors AND answers "which famous aurora cities are lit now."
     * @param {Array<{name:string,lat:number,lon:number,marquee?:boolean}>} cities
     */
    setReferenceCities(cities = []) {
        this._refCities = (cities || []).filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon));
        if (this._refGroup) { this.earthGroup.remove(this._refGroup); this._disposeGroup(this._refGroup); }
        this._refGroup = new THREE.Group();
        this._refDots = [];
        for (const city of this._refCities) {
            const surf = latLonToVec3(city.lat, city.lon, R * 1.008);
            const dot = new THREE.Mesh(
                new THREE.SphereGeometry(0.014, 12, 8),
                new THREE.MeshBasicMaterial({ color: 0x7193ad, transparent: true, opacity: 0.75, depthWrite: false }),
            );
            dot.position.copy(surf);
            this._refGroup.add(dot);
            this._refDots.push({ city, dot });
            if (city.marquee) {
                // Depth-tested so only near-side labels show (no back-side clutter).
                const lbl = makeLabel(' ' + city.name.split(',')[0] + ' ', '#a8cfe4', 0.165, true);
                lbl.position.copy(latLonToVec3(city.lat, city.lon, R * 1.075));
                this._refGroup.add(lbl);
            }
        }
        this.earthGroup.add(this._refGroup);
        this._recolorReferenceCities();
        if (!this._raf) this._renderOnce();
    }

    /** Recolour hotspot dots from the current footprint: lit cities glow green
     *  and grow; dark ones stay a dim slate. Cheap (cities × cells). */
    _recolorReferenceCities() {
        if (!this._refDots || !this._refDots.length) return;
        for (const ref of this._refDots) {
            const p = probOverCity(ref.city, this._cells, 4);
            const lit = p != null && p >= 8;
            ref.lit = lit;
            const m = ref.dot.material;
            if (lit) {
                const t = Math.min(1, p / 55);
                m.color.setHex(0x5fffd0);
                m.opacity = 0.85;
                ref.dot.scale.setScalar(1 + 1.7 * t);
            } else {
                m.color.setHex(0x7193ad);
                m.opacity = 0.7;
                ref.dot.scale.setScalar(1);
            }
        }
    }

    _makeHotspot(lat, lonEast) {
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(R * 0.045, R * 0.075, 28),
            new THREE.MeshBasicMaterial({ color: 0xfff0c0, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }),
        );
        const p = latLonToVec3(lat, lonEast, R * 1.02);
        ring.position.copy(p);
        ring.lookAt(p.clone().multiplyScalar(2));
        ring.userData.pulse = true;
        return ring;
    }

    /**
     * Drop pins for saved/selected locations.
     * @param {Array<{id?:string,name?:string,lat:number,lon:number}>} list
     * @param {string|null} currentId   highlighted + labelled entry
     */
    setLocations(list = [], currentId = null) {
        if (this._pinGroup) { this.earthGroup.remove(this._pinGroup); this._disposeGroup(this._pinGroup); }
        this._pinGroup = new THREE.Group();
        for (const loc of (list || [])) {
            if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) continue;
            const isCur = currentId != null && (loc.id === currentId);
            const col = isCur ? 0x5fffd0 : 0x8fd6ff;
            const surf = latLonToVec3(loc.lat, loc.lon, R * 1.01);

            const dot = new THREE.Mesh(
                new THREE.SphereGeometry(isCur ? 0.032 : 0.024, 14, 10),
                new THREE.MeshBasicMaterial({ color: col }),
            );
            dot.position.copy(surf);
            this._pinGroup.add(dot);

            // stalk so the pin reads above the surface
            const tip = latLonToVec3(loc.lat, loc.lon, R * (isCur ? 1.16 : 1.10));
            const stalk = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([surf, tip]),
                new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.8 }),
            );
            this._pinGroup.add(stalk);

            if (isCur) {
                const ring = new THREE.Mesh(
                    new THREE.RingGeometry(0.05, 0.07, 24),
                    new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
                );
                ring.position.copy(surf);
                ring.lookAt(surf.clone().multiplyScalar(2));
                this._pinGroup.add(ring);
                const lbl = makeLabel(' ' + (loc.name || 'You').split(',')[0] + ' ', '#bafff0', 0.24);
                lbl.position.copy(tip.clone().multiplyScalar(1.04));
                this._pinGroup.add(lbl);
            }
        }
        this.earthGroup.add(this._pinGroup);
        if (!this._raf) this._renderOnce();
    }

    _resize() {
        const w = this.canvas.clientWidth || 300;
        const h = this.canvas.clientHeight || 400;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / Math.max(h, 1);
        this.camera.updateProjectionMatrix();
        if (!this._raf) this._renderOnce();
    }

    _renderOnce() { this.controls.update(); this.renderer.render(this.scene, this.camera); }

    start() {
        if (this._raf) return this;
        const loop = () => {
            this._raf = requestAnimationFrame(loop);
            this._t += 0.016;
            if (this._markerGroup && !this._reduced) {
                const s = 1 + 0.22 * Math.sin(this._t * 3.2);
                this._markerGroup.children.forEach(m => { if (m.userData.pulse) { m.scale.setScalar(s); m.material.opacity = 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(this._t * 3.2)); } });
            }
            if (this._refDots && !this._reduced) {
                const o = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(this._t * 2.4));   // breathe the lit cities
                for (const ref of this._refDots) if (ref.lit) ref.dot.material.opacity = o;
            }
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        this._raf = requestAnimationFrame(loop);
        return this;
    }

    stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; return this; }

    _disposeGroup(g) {
        g.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
        });
    }

    dispose() {
        this.stop();
        try { this._ro.disconnect(); } catch (_) {}
        this.controls.dispose();
        this._disposeGroup(this.scene);
        this._pointsMat.dispose();
        this.renderer.dispose();
    }
}
