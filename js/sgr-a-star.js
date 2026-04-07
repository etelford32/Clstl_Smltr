/**
 * sgr-a-star.js — Sagittarius A* Supermassive Black Hole Simulation Engine
 *
 * Reusable, object-oriented module for rendering a physically-grounded
 * Sgr A* visualization with Three.js. Designed for composability:
 * each component (BlackHole, AccretionDisk, SStarOrbits, Jets) is a
 * standalone class that can be instantiated independently.
 *
 * Physics references:
 *   Gillessen et al. (2009)  — S-star orbital elements
 *   Gravity Collab. (2018)   — Sgr A* mass = 4.15 × 10⁶ M☉
 *   Shakura-Sunyaev (1973)   — α-disk temperature profile
 *   Blandford-Znajek (1977)  — jet launching mechanism
 */

import * as THREE from 'three';

// ── Physical constants (scaled for visualization) ────────────────────────────
const SGR_A_MASS_MSUN = 4.154e6;       // Gravity Collab. 2018
const SCHWARZSCHILD_R_KM = 1.23e7;     // Rs = 2GM/c² ≈ 12.3 million km
const SPIN_PARAMETER = 0.5;            // moderate Kerr spin estimate

// ── BlackHole ────────────────────────────────────────────────────────────────
export class BlackHole {
    constructor(scene, { radius = 0.5, spin = SPIN_PARAMETER } = {}) {
        this.scene = scene;
        this.radius = radius;
        this.spin = spin;
        this.time = 0;
        this._build();
    }

    _build() {
        // Event horizon — oblate Kerr geometry
        const geo = new THREE.SphereGeometry(this.radius, 64, 64);
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            const r = Math.sqrt(x * x + y * y + z * z);
            const cosT = y / Math.max(r, 1e-4);
            const sinT = Math.sqrt(1 - cosT * cosT);
            const oblate = 1 + this.spin * this.spin * sinT * sinT * 0.15;
            pos.setXYZ(i, x * oblate, y * 0.92, z * oblate);
        }
        pos.needsUpdate = true;
        geo.computeVertexNormals();

        this.material = new THREE.ShaderMaterial({
            vertexShader: `
                varying vec3 vNormal, vViewDir, vLocalPos;
                void main() {
                    vLocalPos = position;
                    vNormal = normalize(normalMatrix * normal);
                    vec4 wp = modelMatrix * vec4(position, 1.0);
                    vViewDir = normalize(cameraPosition - wp.xyz);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                uniform float u_time;
                varying vec3 vNormal, vViewDir, vLocalPos;
                void main() {
                    float rim = 1.0 - abs(dot(vViewDir, vNormal));
                    float hawking = pow(rim, 8.0) * 0.3;
                    float sinT = length(vLocalPos.xz) / max(length(vLocalPos), 0.001);
                    float ergo = pow(rim, 3.5) * 0.1 * sinT *
                        (0.7 + 0.3 * sin(u_time * 5.0 + vLocalPos.y * 12.0 + atan(vLocalPos.z, vLocalPos.x) * 3.0));
                    float shadow = smoothstep(0.25, 0.0, rim);
                    vec3 col = vec3(0.1, 0.15, 0.5) * hawking + vec3(0.5, 0.25, 0.06) * ergo;
                    col *= (1.0 - shadow * 0.95);
                    gl_FragColor = vec4(col, 1.0);
                }`,
            uniforms: { u_time: { value: 0 } },
        });

        this.mesh = new THREE.Mesh(geo, this.material);
        this.scene.add(this.mesh);

        // Photon sphere rings
        this.rings = [];
        for (let i = 0; i < 3; i++) {
            const pr = this.radius * (1.5 + i * 0.08);
            const rGeo = new THREE.TorusGeometry(pr, 0.012 + i * 0.005, 12, 120);
            const rMat = new THREE.MeshBasicMaterial({
                color: new THREE.Color().setHSL(0.12 - i * 0.03, 0.9, 0.7),
                transparent: true, opacity: 0.45 - i * 0.1,
                blending: THREE.AdditiveBlending, depthWrite: false,
            });
            const ring = new THREE.Mesh(rGeo, rMat);
            ring.rotation.x = Math.PI / 2 + i * 0.04;
            this.scene.add(ring);
            this.rings.push(ring);
        }
    }

    update(dt) {
        this.time += dt;
        this.material.uniforms.u_time.value = this.time;
        this.rings.forEach((r, i) => {
            r.rotation.z = this.time * 0.02 + i * 0.5;
        });
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.scene.remove(this.mesh);
        this.rings.forEach(r => { r.geometry.dispose(); r.material.dispose(); this.scene.remove(r); });
    }
}

// ── AccretionDisk ────────────────────────────────────────────────────────────
export class AccretionDisk {
    constructor(scene, { bhRadius = 0.5, innerR = 2.5, outerR = 9.0, tilt = -0.42 } = {}) {
        this.scene = scene;
        this.bhRadius = bhRadius;
        this.tilt = tilt;
        this.time = 0;
        this._build(innerR, outerR);
    }

    _build(innerR, outerR) {
        const fragShader = `
            uniform float u_time;
            varying vec2 vUv;
            varying vec3 vWorldPos;

            float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float noise(vec2 p) {
                vec2 i = floor(p), f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                           mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
            }
            float fbm(vec2 p) {
                float v = 0.0, a = 0.5;
                for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.1; a *= 0.45; }
                return v;
            }

            void main() {
                float r = length(vWorldPos.xz);
                float angle = atan(vWorldPos.z, vWorldPos.x);
                float omega = pow(r + 0.5, -1.5);
                float phase = angle + u_time * omega * 1.5;

                float turb = fbm(vec2(phase * 4.0 + r * 2.0, r * 6.0 + u_time * 0.15)) * 0.65
                           + fbm(vec2(phase * 12.0 - r * 3.0, r * 18.0 + u_time * 0.08)) * 0.35;

                float spiral = 0.5 + 0.5 * sin(phase * 2.0 + log(r + 0.3) * 4.0);
                turb = mix(turb, turb * spiral, 0.4);

                float temp = pow(max(r, 0.3), -0.75);
                vec3 hottest = vec3(0.85, 0.92, 1.0);
                vec3 hot     = vec3(1.0, 0.92, 0.7);
                vec3 warm    = vec3(1.0, 0.55, 0.12);
                vec3 cool    = vec3(0.7, 0.15, 0.03);
                float t = clamp(temp, 0.0, 3.0) / 3.0;
                vec3 col;
                if (t > 0.66) col = mix(hot, hottest, (t - 0.66) / 0.34);
                else if (t > 0.33) col = mix(warm, hot, (t - 0.33) / 0.33);
                else col = mix(cool, warm, t / 0.33);

                float brightness = (0.3 + turb * 0.7) * temp * 0.22;
                brightness *= smoothstep(4.5, 3.0, r);
                brightness *= smoothstep(0.9, 1.4, r);

                float v_orb = omega * r * 0.8;
                float doppler4 = pow(1.0 / (1.0 - v_orb * sin(phase) * 0.3), 4.0);
                doppler4 = clamp(doppler4, 0.3, 3.0);
                brightness *= doppler4;

                gl_FragColor = vec4(col * brightness, brightness * 0.9);
            }`;

        const vertShader = `
            varying vec2 vUv;
            varying vec3 vWorldPos;
            void main() {
                vUv = uv;
                vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`;

        const uniforms = { u_time: { value: 0 } };
        this.uniforms = uniforms;

        const mkDisk = (iR, oR, segs, flip) => {
            const geo = new THREE.RingGeometry(this.bhRadius * iR, this.bhRadius * oR, segs, 8);
            const mat = new THREE.ShaderMaterial({
                vertexShader: vertShader, fragmentShader: fragShader,
                uniforms, transparent: true, depthWrite: false,
                side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.rotation.x = this.tilt + (flip ? Math.PI : 0);
            if (flip) mesh.scale.set(0.9, 0.9, 0.9);
            this.scene.add(mesh);
            return mesh;
        };

        this.frontDisk = mkDisk(innerR, outerR, 256, false);
        this.backDisk  = mkDisk(innerR + 0.3, outerR - 1, 200, true);
    }

    update(dt) {
        this.time += dt;
        this.uniforms.u_time.value = this.time * 1.5;
    }

    dispose() {
        [this.frontDisk, this.backDisk].forEach(m => {
            m.geometry.dispose(); m.material.dispose(); this.scene.remove(m);
        });
    }
}

// ── SStarOrbits ──────────────────────────────────────────────────────────────
// Real orbital elements from Gillessen et al. (2009) / Gravity Collab. (2020)
export class SStarOrbits {
    constructor(scene, { scale = 1.0 } = {}) {
        this.scene = scene;
        this.scale = scale;
        this.time = 0;
        this.labels = [];

        // Orbital elements: { name, a (arcsec), e, period (yr), color }
        this.stars = [
            { name: 'S2',  a: 0.1251, e: 0.8839, P: 16.05,  color: 0x66bbff, phase: 0 },
            { name: 'S1',  a: 0.508,  e: 0.358,  P: 94.1,   color: 0xff8866, phase: 1.2 },
            { name: 'S62', a: 0.0905, e: 0.976,  P: 9.9,    color: 0xffdd44, phase: 2.5 },
            { name: 'S38', a: 0.1416, e: 0.8201, P: 19.2,   color: 0x88ff88, phase: 3.8 },
            { name: 'S55', a: 0.1078, e: 0.7209, P: 12.8,   color: 0xff66ff, phase: 5.0 },
        ];

        this.orbits = [];
        this.markers = [];
        this._build();
    }

    _build() {
        for (const star of this.stars) {
            // Generate elliptical orbit path
            const pts = [];
            const N = 256;
            for (let j = 0; j <= N; j++) {
                const M = (j / N) * Math.PI * 2;
                const E = this._solveKepler(M, star.e);
                const trueAnom = 2 * Math.atan2(
                    Math.sqrt(1 + star.e) * Math.sin(E / 2),
                    Math.sqrt(1 - star.e) * Math.cos(E / 2)
                );
                const r = star.a * (1 - star.e * star.e) / (1 + star.e * Math.cos(trueAnom));
                const s = r * this.scale * 18;
                pts.push(new THREE.Vector3(
                    s * Math.cos(trueAnom + star.phase),
                    (Math.random() - 0.5) * 0.05,
                    s * Math.sin(trueAnom + star.phase)
                ));
            }

            // Orbit line
            const geo = new THREE.BufferGeometry().setFromPoints(pts);
            const mat = new THREE.LineBasicMaterial({
                color: star.color, transparent: true, opacity: 0.35,
                depthWrite: false,
            });
            const line = new THREE.Line(geo, mat);
            this.scene.add(line);
            this.orbits.push(line);

            // Star marker (sphere)
            const mGeo = new THREE.SphereGeometry(0.06, 16, 16);
            const mMat = new THREE.MeshBasicMaterial({
                color: star.color, transparent: true, opacity: 0.95,
            });
            const marker = new THREE.Mesh(mGeo, mMat);
            this.scene.add(marker);
            this.markers.push(marker);

            // Glow sprite
            const spriteMat = new THREE.SpriteMaterial({
                color: star.color, transparent: true, opacity: 0.5,
                blending: THREE.AdditiveBlending,
            });
            const sprite = new THREE.Sprite(spriteMat);
            sprite.scale.set(0.4, 0.4, 1);
            marker.add(sprite);
        }
    }

    _solveKepler(M, e, tol = 1e-8) {
        let E = M;
        for (let i = 0; i < 30; i++) {
            const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
            E -= dE;
            if (Math.abs(dE) < tol) break;
        }
        return E;
    }

    update(dt) {
        this.time += dt;
        for (let i = 0; i < this.stars.length; i++) {
            const star = this.stars[i];
            // Mean anomaly evolves with time; scale so orbits are visible
            const M = ((this.time * 0.3) / star.P) * Math.PI * 2;
            const E = this._solveKepler(M, star.e);
            const trueAnom = 2 * Math.atan2(
                Math.sqrt(1 + star.e) * Math.sin(E / 2),
                Math.sqrt(1 - star.e) * Math.cos(E / 2)
            );
            const r = star.a * (1 - star.e * star.e) / (1 + star.e * Math.cos(trueAnom));
            const s = r * this.scale * 18;
            this.markers[i].position.set(
                s * Math.cos(trueAnom + star.phase),
                0,
                s * Math.sin(trueAnom + star.phase)
            );
        }
    }

    getStarPositions() {
        return this.stars.map((star, i) => ({
            name: star.name,
            position: this.markers[i].position.clone(),
            period: star.P,
            eccentricity: star.e,
        }));
    }

    dispose() {
        this.orbits.forEach(o => { o.geometry.dispose(); o.material.dispose(); this.scene.remove(o); });
        this.markers.forEach(m => {
            m.children.forEach(c => { if (c.material) c.material.dispose(); });
            m.geometry.dispose(); m.material.dispose(); this.scene.remove(m);
        });
    }
}

// ── RelativisticJets ─────────────────────────────────────────────────────────
export class RelativisticJets {
    constructor(scene, { count = 400, maxHeight = 6, bhRadius = 0.5 } = {}) {
        this.scene = scene;
        this.count = count;
        this.maxHeight = maxHeight;
        this.bhRadius = bhRadius;
        this._build();
    }

    _build() {
        const N = this.count;
        const pos = new Float32Array(N * 3);
        const col = new Float32Array(N * 3);
        this.vel = new Float32Array(N);

        for (let i = 0; i < N; i++) {
            const up = i < N / 2 ? 1 : -1;
            const angle = Math.random() * Math.PI * 2;
            const h = Math.random() * this.maxHeight + 0.15;
            const collimation = 0.04 + 0.06 * Math.sqrt(h / this.maxHeight);
            pos[i * 3]     = Math.cos(angle) * collimation;
            pos[i * 3 + 1] = up * h;
            pos[i * 3 + 2] = Math.sin(angle) * collimation;
            this.vel[i] = 0.012 + Math.random() * 0.035;
            const hNorm = h / this.maxHeight;
            const core = collimation < 0.06 ? 1.0 : 0.6;
            col[i * 3]     = (0.15 + hNorm * 0.55) * core;
            col[i * 3 + 1] = (0.3 + hNorm * 0.5) * core;
            col[i * 3 + 2] = (0.85 + hNorm * 0.15) * core;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        this.points = new THREE.Points(geo, new THREE.PointsMaterial({
            size: 0.035, vertexColors: true, transparent: true, opacity: 0.7,
            blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
        }));
        this.scene.add(this.points);
    }

    update(dt) {
        const jp = this.points.geometry.attributes.position.array;
        const jc = this.points.geometry.attributes.color.array;
        const N = this.count;
        const time = performance.now() * 0.001;

        for (let i = 0; i < N; i++) {
            const up = jp[i * 3 + 1] > 0 ? 1 : -1;
            jp[i * 3 + 1] += up * this.vel[i];
            const angle = time * 3 + jp[i * 3 + 1] * 2;
            const spiralR = 0.05 * Math.abs(jp[i * 3 + 1]);
            jp[i * 3]     += (Math.cos(angle) * spiralR - jp[i * 3]) * 0.03;
            jp[i * 3 + 2] += (Math.sin(angle) * spiralR - jp[i * 3 + 2]) * 0.03;
            const h = Math.min(1, Math.abs(jp[i * 3 + 1]) / (this.maxHeight - 0.5));
            jc[i * 3]     = 0.15 + h * 0.65;
            jc[i * 3 + 1] = 0.3 + h * 0.6;
            jc[i * 3 + 2] = 0.9 + h * 0.1;
            if (Math.abs(jp[i * 3 + 1]) > this.maxHeight) {
                jp[i * 3]     = (Math.random() - 0.5) * 0.08;
                jp[i * 3 + 1] = up * Math.random() * 0.2;
                jp[i * 3 + 2] = (Math.random() - 0.5) * 0.08;
            }
        }
        this.points.geometry.attributes.position.needsUpdate = true;
        this.points.geometry.attributes.color.needsUpdate = true;
    }

    dispose() {
        this.points.geometry.dispose();
        this.points.material.dispose();
        this.scene.remove(this.points);
    }
}

// ── Starfield ────────────────────────────────────────────────────────────────
export class Starfield {
    constructor(scene, { count = 2000 } = {}) {
        this.scene = scene;
        this._build(count);
    }

    _build(count) {
        const pos = new Float32Array(count * 3);
        const sizes = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            const r = 25 + Math.random() * 50;
            pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
            pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
            pos[i * 3 + 2] = r * Math.cos(phi);
            sizes[i] = 0.05 + Math.random() * 0.12;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
        this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
            vertexShader: `
                attribute float size;
                varying float vBright;
                void main() {
                    vec4 mvp = modelViewMatrix * vec4(position, 1.0);
                    float projDist = length(mvp.xy / -mvp.z);
                    float lensBoost = 1.0 + 2.0 / (projDist * projDist + 0.5);
                    vBright = min(lensBoost, 3.0);
                    gl_PointSize = size * 300.0 / -mvp.z * lensBoost;
                    gl_Position = projectionMatrix * mvp;
                }`,
            fragmentShader: `
                varying float vBright;
                void main() {
                    float d = length(gl_PointCoord - 0.5) * 2.0;
                    float alpha = smoothstep(1.0, 0.0, d);
                    vec3 col = mix(vec3(1.0), vec3(1.0, 0.9, 0.7), clamp(vBright - 1.0, 0.0, 1.0));
                    gl_FragColor = vec4(col * vBright * 0.5, alpha * 0.8);
                }`,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this.scene.add(this.points);
    }

    dispose() {
        this.points.geometry.dispose();
        this.points.material.dispose();
        this.scene.remove(this.points);
    }
}

// ── SgrAStarSimulation (facade) ──────────────────────────────────────────────
export class SgrAStarSimulation {
    constructor(canvas, { autoStart = true } = {}) {
        this.canvas = canvas;
        this.clock = new THREE.Clock();
        this._setupRenderer();
        this._setupScene();
        this._buildComponents();
        if (autoStart) this.start();
    }

    _setupRenderer() {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;
    }

    _setupScene() {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(50, this.canvas.clientWidth / this.canvas.clientHeight, 0.1, 200);
        this.camera.position.set(0, 4, 10);
        this.camera.lookAt(0, 0, 0);

        // Post-processing (bloom)
        const { EffectComposer } = THREE;
        // We'll set up bloom in the page since addons need import maps
        this.composer = null;
    }

    async setupBloom(EffectComposer, RenderPass, UnrealBloomPass) {
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloom = new UnrealBloomPass(
            new THREE.Vector2(this.canvas.clientWidth, this.canvas.clientHeight),
            0.8, 0.4, 0.85
        );
        this.composer.addPass(this.bloom);
    }

    _buildComponents() {
        this.blackHole = new BlackHole(this.scene);
        this.disk = new AccretionDisk(this.scene);
        this.sStars = new SStarOrbits(this.scene);
        this.jets = new RelativisticJets(this.scene);
        this.starfield = new Starfield(this.scene);
    }

    resize() {
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        if (this.composer) this.composer.setSize(w, h);
    }

    start() {
        this._resizeObs = new ResizeObserver(() => this.resize());
        this._resizeObs.observe(this.canvas.parentElement);
        this.resize();
        this._animate();
    }

    _animate() {
        this._raf = requestAnimationFrame(() => this._animate());
        const dt = this.clock.getDelta();

        this.blackHole.update(dt);
        this.disk.update(dt);
        this.sStars.update(dt);
        this.jets.update(dt);

        if (this.composer) {
            this.composer.render();
        } else {
            this.renderer.render(this.scene, this.camera);
        }
    }

    stop() {
        cancelAnimationFrame(this._raf);
        this._resizeObs?.disconnect();
    }

    dispose() {
        this.stop();
        this.blackHole.dispose();
        this.disk.dispose();
        this.sStars.dispose();
        this.jets.dispose();
        this.starfield.dispose();
        this.renderer.dispose();
    }
}
