/**
 * sgr-a-star.js — Sagittarius A* Supermassive Black Hole Simulation Engine
 *
 * Physics references:
 *   Gillessen et al. (2009)  — S-star orbital elements
 *   Gravity Collab. (2018)   — Sgr A* mass = 4.154 × 10⁶ M☉
 *   Gravity Collab. (2020)   — Schwarzschild precession of S2
 *   Shakura-Sunyaev (1973)   — α-disk temperature profile
 *   Blandford-Znajek (1977)  — jet launching mechanism
 *   EHT Collaboration (2022) — Sgr A* shadow 51.8 ± 2.3 μas
 */

import * as THREE from 'three';

// ── Physical constants ───────────────────────────────────────────────────────
const SGR_A_MASS_MSUN = 4.154e6;
const GM_SGR_A = 5.318e15;            // m³/s² for 4.154e6 Msun
const SCHWARZSCHILD_R_KM = 1.23e7;    // Rs = 2GM/c² ≈ 12.3 million km
const SCHWARZSCHILD_R_AU = 0.0823;    // Rs in AU
const DISTANCE_LY = 26673;
const DISTANCE_KPC = 8.178;
const C_KMS = 299792.458;
const AU_M = 1.496e11;

// ── BlackHole ────────────────────────────────────────────────────────────────
export class BlackHole {
    constructor(scene, { radius = 0.5, spin = 0.5 } = {}) {
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

        // Ergosphere (Kerr outer boundary)
        const ergoGeo = new THREE.SphereGeometry(this.radius * 1.8, 48, 48);
        {
            const ep = ergoGeo.attributes.position;
            for (let i = 0; i < ep.count; i++) {
                const x = ep.getX(i), y = ep.getY(i), z = ep.getZ(i);
                const r = Math.sqrt(x*x + y*y + z*z);
                const cosT = y / Math.max(r, 1e-4);
                const ergoR = 1 + Math.sqrt(1 - this.spin*this.spin*cosT*cosT);
                const scale = ergoR / 2;
                ep.setXYZ(i, x * scale, y * scale * 0.65, z * scale);
            }
            ep.needsUpdate = true;
            ergoGeo.computeVertexNormals();
        }
        this.ergosphere = new THREE.Mesh(ergoGeo, new THREE.MeshBasicMaterial({
            color: 0x4422aa, transparent: true, opacity: 0.04,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, wireframe: true,
        }));
        this.scene.add(this.ergosphere);

        // ISCO ring (r_ISCO ≈ 2.32M for a=0.9 prograde Kerr)
        const iscoR = this.radius * 2.32;
        this.iscoRing = new THREE.Mesh(
            new THREE.TorusGeometry(iscoR, 0.025, 12, 120),
            new THREE.MeshBasicMaterial({
                color: 0xffdd66, transparent: true, opacity: 0.7,
                blending: THREE.AdditiveBlending, depthWrite: false,
            })
        );
        this.iscoRing.rotation.x = -Math.PI * 0.42 + Math.PI / 2;
        this.scene.add(this.iscoRing);

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

        // Corona glow (hot electron scattering halo)
        this.corona = new THREE.Mesh(
            new THREE.SphereGeometry(this.radius * 5, 32, 32),
            new THREE.MeshBasicMaterial({
                color: 0xff6622, transparent: true, opacity: 0.015,
                blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
            })
        );
        this.scene.add(this.corona);
    }

    update(dt) {
        this.time += dt;
        this.material.uniforms.u_time.value = this.time;
        this.iscoRing.material.opacity = 0.5 + Math.sin(this.time * 5) * 0.2;
        this.rings.forEach((r, i) => { r.rotation.z = this.time * 0.02 + i * 0.5; });
    }

    setSpin(a) {
        this.spin = a;
    }

    dispose() {
        [this.mesh, this.ergosphere, this.iscoRing, this.corona, ...this.rings].forEach(m => {
            m.geometry.dispose(); m.material.dispose(); this.scene.remove(m);
        });
    }
}

// ── AccretionDisk ────────────────────────────────────────────────────────────
// Sgr A*'s accretion flow is a RIAF (Radiatively Inefficient Accretion Flow),
// NOT a luminous Shakura-Sunyaev thin disk. Key differences:
//   - Geometrically thick (H/R ~ 1), optically thin
//   - Electron temperature Te ~ 10⁹⁻¹⁰ K (virial), ion Ti >> Te
//   - Mdot ~ 10⁻⁸ M☉/yr — only ~1% reaches the horizon
//   - Most energy advected into the BH, not radiated
//   - Peak emission at submm (230 GHz) from near ISCO
// The u_eddRatio uniform dims the disk appropriately.
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
            uniform float u_tmax;
            uniform float u_eddRatio; // 0..1 maps log(L/L_Edd) to brightness
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

                // Temperature ramp scaled by u_tmax
                float tempScale = log(u_tmax) / log(1.0e7);  // normalize to default
                float temp = pow(max(r, 0.3), -0.75) * tempScale;

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

                // RIAF dimming: Sgr A* is at ~10⁻⁸ L_Edd
                // u_eddRatio maps 0.0 (dim RIAF) → 1.0 (luminous thin disk)
                float riafDim = 0.08 + 0.92 * u_eddRatio;
                brightness *= riafDim;

                // RIAF color shift: at low accretion rates, emission is
                // more red/infrared (synchrotron-dominated, not blackbody)
                col = mix(col * vec3(1.0, 0.6, 0.3), col, u_eddRatio);

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

        this.uniforms = { u_time: { value: 0 }, u_tmax: { value: 1e7 }, u_eddRatio: { value: 0.0 } };
        // Default: Sgr A* RIAF mode (very dim). Set to 1.0 for luminous AGN disk.

        const mkDisk = (iR, oR, segs, flip) => {
            const geo = new THREE.RingGeometry(this.bhRadius * iR, this.bhRadius * oR, segs, 8);
            const mat = new THREE.ShaderMaterial({
                vertexShader: vertShader, fragmentShader: fragShader,
                uniforms: this.uniforms, transparent: true, depthWrite: false,
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

    setTemperature(tmax) { this.uniforms.u_tmax.value = tmax; }
    setEddingtonRatio(ratio) { this.uniforms.u_eddRatio.value = Math.max(0, Math.min(1, ratio)); }

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
// The S-stars are young, massive B-type stars (B0-B2 V) with strong stellar
// winds (v_w ~ 1000 km/s, Mdot ~ 10⁻⁷ M☉/yr). At pericenter passage, tidal
// forces from Sgr A* strip and stretch the wind material, feeding the RIAF.
// This is one of the main accretion channels for Sgr A* (Cuadra et al. 2006).
export class SStarOrbits {
    constructor(scene, { scale = 1.0, windParticlesPerStar = 30 } = {}) {
        this.scene = scene;
        this.scale = scale;
        this.time = 0;
        this.trailsEnabled = true;
        this.windParticlesPerStar = windParticlesPerStar;

        // Real stellar + orbital properties
        // Spectral types from Gillessen et al. (2009), Habibi et al. (2017)
        this.stars = [
            { name: 'S2',  a_AU: 1031, e: 0.8839, P: 16.05, i: 134.18, Om: 228.07, w: 66.25,
              color: 0x99ccff, spectral: 'B0-2 V', Teff: 27500, mass_Msun: 14, L_Lsun: 16000,
              Mdot: 1e-7, v_wind: 1000 },
            { name: 'S1',  a_AU: 4193, e: 0.358,  P: 94.1,  i: 119.14, Om: 342.04, w: 122.3,
              color: 0xffa877, spectral: 'B0.5 V', Teff: 25000, mass_Msun: 12, L_Lsun: 12000,
              Mdot: 8e-8, v_wind: 900 },
            { name: 'S62', a_AU: 747,  e: 0.976,  P: 9.9,   i: 72.76,  Om: 122.61, w: 42.62,
              color: 0xffdd66, spectral: 'B2 V',   Teff: 22000, mass_Msun: 10, L_Lsun: 6000,
              Mdot: 5e-8, v_wind: 800 },
            { name: 'S38', a_AU: 1169, e: 0.8201, P: 19.2,  i: 170.76, Om: 101.62, w: 17.99,
              color: 0x88ff99, spectral: 'B1 V',   Teff: 24000, mass_Msun: 11, L_Lsun: 9000,
              Mdot: 7e-8, v_wind: 950 },
            { name: 'S55', a_AU: 890,  e: 0.7209, P: 12.8,  i: 150.1,  Om: 325.5,  w: 332.4,
              color: 0xee88ff, spectral: 'B2 V',   Teff: 22000, mass_Msun: 10, L_Lsun: 7000,
              Mdot: 5e-8, v_wind: 850 },
        ];

        for (const s of this.stars) {
            const a_m = s.a_AU * AU_M;
            s.precRate = 6 * Math.PI * GM_SGR_A / (a_m * C_KMS * 1000 * C_KMS * 1000 * (1 - s.e * s.e));
            s.precAccum = 0;
            s.visualScale = this.scale * 2.5 / 1031;
            s.i_rad = s.i * Math.PI / 180;
            s.Om_rad = s.Om * Math.PI / 180;
            s.w_rad = s.w * Math.PI / 180;
        }

        this.orbits = [];
        this.markers = [];
        this.trails = [];
        this.windSystems = [];
        this._starShader = this._createStarShader();
        this._build();
    }

    // Custom star shader: smooth radial glow, no square artifacts
    _createStarShader() {
        return {
            vertexShader: `
                varying vec3 vNormal;
                varying vec3 vViewDir;
                void main() {
                    vNormal = normalize(normalMatrix * normal);
                    vec4 wp = modelMatrix * vec4(position, 1.0);
                    vViewDir = normalize(cameraPosition - wp.xyz);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                uniform vec3 u_color;
                uniform float u_temperature; // Kelvin, affects core color
                uniform float u_time;
                varying vec3 vNormal;
                varying vec3 vViewDir;

                void main() {
                    float NdotV = dot(vNormal, vViewDir);
                    float facing = max(0.0, NdotV);

                    // Hot stellar core: bright white-blue center
                    float core = pow(facing, 1.2);

                    // Limb darkening (realistic for B-type stars)
                    // I(θ) = I₀ (1 - u(1 - cosθ)) where u ≈ 0.3 for hot stars
                    float limbDark = 1.0 - 0.3 * (1.0 - facing);

                    // Chromospheric rim glow
                    float rim = pow(1.0 - facing, 3.0) * 0.4;

                    // Subtle surface convection flicker
                    float flicker = 0.95 + 0.05 * sin(u_time * 8.0 + vNormal.x * 20.0);

                    // Color: hot core is whiter, edge tints toward star color
                    vec3 coreCol = mix(vec3(1.0, 0.98, 0.95), u_color, 0.3);
                    vec3 rimCol = u_color * 1.3;
                    vec3 col = coreCol * core * limbDark * flicker + rimCol * rim;

                    float alpha = smoothstep(0.0, 0.15, facing) * 0.95 + rim;
                    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
                }`,
        };
    }

    _build() {
        for (let si = 0; si < this.stars.length; si++) {
            const star = this.stars[si];
            const c = new THREE.Color(star.color);

            // ── Orbit line ───────────────────────────────────────────────
            const pts = [];
            const N = 256;
            for (let j = 0; j <= N; j++) {
                const M = (j / N) * Math.PI * 2;
                const E = this._solveKepler(M, star.e);
                const nu = 2 * Math.atan2(
                    Math.sqrt(1 + star.e) * Math.sin(E / 2),
                    Math.sqrt(1 - star.e) * Math.cos(E / 2)
                );
                const r = star.a_AU * (1 - star.e * star.e) / (1 + star.e * Math.cos(nu));
                pts.push(this._orbitToXYZ(r, nu, star));
            }
            const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
            const lineMat = new THREE.LineBasicMaterial({
                color: star.color, transparent: true, opacity: 0.3, depthWrite: false,
            });
            const line = new THREE.Line(lineGeo, lineMat);
            this.scene.add(line);
            this.orbits.push(line);

            // ── Star mesh (custom shader — proper stellar appearance) ────
            // Size scaled by luminosity: R ∝ L^0.5 / T^2 (Stefan-Boltzmann)
            const starRadius = 0.04 + 0.03 * Math.sqrt(star.L_Lsun / 16000);
            const starGeo = new THREE.SphereGeometry(starRadius, 32, 32);
            const starMat = new THREE.ShaderMaterial({
                vertexShader: this._starShader.vertexShader,
                fragmentShader: this._starShader.fragmentShader,
                uniforms: {
                    u_color: { value: c },
                    u_temperature: { value: star.Teff },
                    u_time: { value: 0 },
                },
                transparent: true, depthWrite: true,
            });
            const marker = new THREE.Mesh(starGeo, starMat);
            this.scene.add(marker);
            this.markers.push(marker);

            // ── Outer corona/atmosphere glow (additive, larger sphere) ────
            const glowGeo = new THREE.SphereGeometry(starRadius * 3.5, 16, 16);
            const glowMat = new THREE.ShaderMaterial({
                vertexShader: `
                    varying vec3 vNormal, vViewDir;
                    void main() {
                        vNormal = normalize(normalMatrix * normal);
                        vec4 wp = modelMatrix * vec4(position, 1.0);
                        vViewDir = normalize(cameraPosition - wp.xyz);
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }`,
                fragmentShader: `
                    uniform vec3 u_color;
                    varying vec3 vNormal, vViewDir;
                    void main() {
                        float rim = 1.0 - max(0.0, dot(vNormal, vViewDir));
                        float glow = pow(rim, 2.0) * 0.6;
                        gl_FragColor = vec4(u_color * glow, glow * 0.5);
                    }`,
                uniforms: { u_color: { value: c.clone().multiplyScalar(1.2) } },
                transparent: true, depthWrite: false, side: THREE.BackSide,
                blending: THREE.AdditiveBlending,
            });
            const glowMesh = new THREE.Mesh(glowGeo, glowMat);
            marker.add(glowMesh);

            // ── Stellar wind particles → streaming toward Sgr A* ─────────
            const WN = this.windParticlesPerStar;
            const windPos = new Float32Array(WN * 3);
            const windCol = new Float32Array(WN * 4);
            const windGeo = new THREE.BufferGeometry();
            windGeo.setAttribute('position', new THREE.BufferAttribute(windPos, 3));
            windGeo.setAttribute('color', new THREE.BufferAttribute(windCol, 4));

            // Initialize colors (star-tinted, fading with distance)
            for (let w = 0; w < WN; w++) {
                windCol[w * 4]     = c.r * 0.7;
                windCol[w * 4 + 1] = c.g * 0.7;
                windCol[w * 4 + 2] = c.b * 0.7;
                windCol[w * 4 + 3] = 0; // start invisible
            }
            windGeo.attributes.color.needsUpdate = true;

            const windMat = new THREE.PointsMaterial({
                size: 0.025, vertexColors: true, transparent: true,
                blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
            });
            const windPoints = new THREE.Points(windGeo, windMat);
            this.scene.add(windPoints);

            // Wind state per particle
            const windState = [];
            for (let w = 0; w < WN; w++) {
                windState.push({
                    alive: false,
                    age: 0,
                    maxAge: 2 + Math.random() * 4,
                    pos: new THREE.Vector3(),
                    vel: new THREE.Vector3(),
                });
            }

            this.windSystems.push({ points: windPoints, state: windState, starIdx: si });

            // ── Trail ────────────────────────────────────────────────────
            const TRAIL_LEN = 80;
            const trailGeo = new THREE.BufferGeometry();
            const trailPos = new Float32Array(TRAIL_LEN * 3);
            const trailCol = new Float32Array(TRAIL_LEN * 4);
            trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
            trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 4));
            for (let t = 0; t < TRAIL_LEN; t++) {
                const alpha = 1 - t / TRAIL_LEN;
                trailCol[t*4] = c.r; trailCol[t*4+1] = c.g; trailCol[t*4+2] = c.b; trailCol[t*4+3] = alpha * 0.5;
            }
            trailGeo.attributes.color.needsUpdate = true;
            const trailMat = new THREE.LineBasicMaterial({
                vertexColors: true, transparent: true, depthWrite: false,
                blending: THREE.AdditiveBlending,
            });
            const trailLine = new THREE.Line(trailGeo, trailMat);
            this.scene.add(trailLine);
            this.trails.push({ line: trailLine, positions: [], maxLen: TRAIL_LEN });
        }
    }

    _orbitToXYZ(r_AU, nu, star) {
        const w = star.w_rad + star.precAccum;
        const cosNuW = Math.cos(nu + w);
        const sinNuW = Math.sin(nu + w);
        const cosOm = Math.cos(star.Om_rad);
        const sinOm = Math.sin(star.Om_rad);
        const cosI = Math.cos(star.i_rad);
        const sinI = Math.sin(star.i_rad);

        const x = r_AU * (cosOm * cosNuW - sinOm * sinNuW * cosI);
        const y = r_AU * (sinNuW * sinI);
        const z = r_AU * (sinOm * cosNuW + cosOm * sinNuW * cosI);

        const s = star.visualScale;
        return new THREE.Vector3(x * s, y * s, z * s);
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

            // Accumulate GR precession
            star.precAccum += star.precRate * (dt * 0.3 / star.P);

            // Mean anomaly
            const M = ((this.time * 0.3) / star.P) * Math.PI * 2;
            const E = this._solveKepler(M, star.e);
            const nu = 2 * Math.atan2(
                Math.sqrt(1 + star.e) * Math.sin(E / 2),
                Math.sqrt(1 - star.e) * Math.cos(E / 2)
            );
            const r_AU = star.a_AU * (1 - star.e * star.e) / (1 + star.e * Math.cos(nu));
            const pos3d = this._orbitToXYZ(r_AU, nu, star);

            this.markers[i].position.copy(pos3d);

            // Update star shader time uniform
            if (this.markers[i].material.uniforms) {
                this.markers[i].material.uniforms.u_time.value = this.time;
            }

            // ── Stellar wind particle update ─────────────────────────
            const wind = this.windSystems[i];
            const wp = wind.points.geometry.attributes.position.array;
            const wc = wind.points.geometry.attributes.color.array;
            const starPos = pos3d;
            // Tidal enhancement: stronger wind stripping closer to BH
            // Tidal radius r_t ~ (M_BH / M_star)^(1/3) * R_star
            // At pericenter for S2: ~120 AU, tidal forces dominate
            const periDist = star.a_AU * (1 - star.e);
            const tidalFactor = Math.min(3.0, periDist / Math.max(r_AU, periDist * 0.5));
            const dirToBH = starPos.clone().negate().normalize();

            for (let w = 0; w < wind.state.length; w++) {
                const p = wind.state[w];
                if (!p.alive) {
                    // Spawn new wind particle from star surface
                    if (Math.random() < dt * 3.0) {
                        p.alive = true;
                        p.age = 0;
                        p.maxAge = 1.5 + Math.random() * 3.5;
                        // Emit in random direction, biased toward BH (tidal stripping)
                        const randDir = new THREE.Vector3(
                            (Math.random() - 0.5) * 2,
                            (Math.random() - 0.5) * 2,
                            (Math.random() - 0.5) * 2
                        ).normalize();
                        // Blend: isotropic wind + tidal-directed component
                        const tidalBias = Math.min(0.8, tidalFactor * 0.3);
                        p.vel.copy(randDir).lerp(dirToBH, tidalBias).normalize();
                        // Wind speed scaled by star properties (scene units/s)
                        p.vel.multiplyScalar(0.15 + Math.random() * 0.1);
                        p.pos.copy(starPos);
                    }
                } else {
                    p.age += dt;
                    if (p.age > p.maxAge || p.pos.length() < 0.3) {
                        p.alive = false;
                        wc[w * 4 + 3] = 0;
                    } else {
                        // Gravitational acceleration toward BH (origin)
                        const rVec = p.pos.clone().negate();
                        const rLen = Math.max(rVec.length(), 0.3);
                        const grav = rVec.normalize().multiplyScalar(0.03 / (rLen * rLen));
                        p.vel.add(grav.multiplyScalar(dt));
                        // Tidal stretching: near pericenter, radial velocity enhanced
                        if (tidalFactor > 1.2) {
                            const radialBoost = dirToBH.clone().multiplyScalar(dt * 0.05 * tidalFactor);
                            p.vel.add(radialBoost);
                        }
                        p.pos.add(p.vel.clone().multiplyScalar(dt));
                        // Fade with age
                        const fade = 1 - (p.age / p.maxAge);
                        wc[w * 4 + 3] = fade * 0.5 * Math.min(1, tidalFactor * 0.6);
                    }
                }
                wp[w * 3]     = p.alive ? p.pos.x : 0;
                wp[w * 3 + 1] = p.alive ? p.pos.y : 0;
                wp[w * 3 + 2] = p.alive ? p.pos.z : 0;
            }
            wind.points.geometry.attributes.position.needsUpdate = true;
            wind.points.geometry.attributes.color.needsUpdate = true;

            // ── Update orbit line with current precession ────────────
            const pts = [];
            const N = 256;
            for (let j = 0; j <= N; j++) {
                const Mj = (j / N) * Math.PI * 2;
                const Ej = this._solveKepler(Mj, star.e);
                const nuj = 2 * Math.atan2(
                    Math.sqrt(1 + star.e) * Math.sin(Ej / 2),
                    Math.sqrt(1 - star.e) * Math.cos(Ej / 2)
                );
                const rj = star.a_AU * (1 - star.e * star.e) / (1 + star.e * Math.cos(nuj));
                pts.push(this._orbitToXYZ(rj, nuj, star));
            }
            this.orbits[i].geometry.setFromPoints(pts);

            // ── Trail update ─────────────────────────────────────────
            if (this.trailsEnabled) {
                const trail = this.trails[i];
                trail.positions.unshift(pos3d.clone());
                if (trail.positions.length > trail.maxLen) trail.positions.length = trail.maxLen;
                const tp = trail.line.geometry.attributes.position.array;
                for (let t = 0; t < trail.maxLen; t++) {
                    const p = trail.positions[t] || trail.positions[trail.positions.length - 1] || pos3d;
                    tp[t*3] = p.x; tp[t*3+1] = p.y; tp[t*3+2] = p.z;
                }
                trail.line.geometry.attributes.position.needsUpdate = true;
            }

            // Cache current physical values for telemetry
            if (i === 0) {
                star._r_AU = r_AU;
                star._nu = nu;
                star._M = M;
            }
            // Cache r_AU for all stars (used by getStarInfo)
            star._r_AU = r_AU;
        }
    }

    getS2Telemetry() {
        const s2 = this.stars[0];
        const r_AU = s2._r_AU || s2.a_AU;
        const r_m = r_AU * AU_M;

        // Vis-viva: v² = GM(2/r - 1/a)
        const a_m = s2.a_AU * AU_M;
        const v2 = GM_SGR_A * (2 / r_m - 1 / a_m);
        const v_kms = Math.sqrt(Math.max(0, v2)) / 1000;

        // Gravitational redshift: z = 1/sqrt(1 - Rs/r) - 1
        const Rs_m = 2 * GM_SGR_A / (C_KMS * 1000 * C_KMS * 1000);
        const z = 1 / Math.sqrt(Math.max(0.001, 1 - Rs_m / r_m)) - 1;

        // Pericenter distance
        const rp_AU = s2.a_AU * (1 - s2.e);

        // Phase (0-1 through orbit)
        const phase = ((s2._M || 0) % (Math.PI * 2)) / (Math.PI * 2);

        // Precession in arcmin per orbit
        const precArcmin = (s2.precRate * 180 / Math.PI) * 60;

        // Accumulated precession in degrees
        const precDeg = s2.precAccum * 180 / Math.PI;

        // Distance in milliarcsec (at 8.178 kpc)
        const dist_mas = r_AU / (DISTANCE_KPC * 1000) * 206265 * 1000;

        // Time to next pericenter (simplified)
        const phaseToNext = phase < 0.5 ? (1 - phase) : (1 - phase + 1);
        const nextPeri = 2018.38 + Math.ceil((2026.3 - 2018.38) / s2.P) * s2.P;

        return {
            distance_AU: r_AU,
            distance_mas: dist_mas,
            velocity_kms: v_kms,
            redshift_z: z,
            phase: phase,
            precession_arcmin_per_orbit: precArcmin,
            precession_accumulated_deg: precDeg,
            pericenter_AU: rp_AU,
            next_pericenter_yr: nextPeri,
        };
    }

    getStarInfo(idx) {
        const star = this.stars[idx] || this.stars[0];
        const r_AU = star._r_AU || star.a_AU;
        const r_m = r_AU * AU_M;
        const a_m = star.a_AU * AU_M;
        const v2 = GM_SGR_A * (2 / r_m - 1 / a_m);
        const v_kms = Math.sqrt(Math.max(0, v2)) / 1000;
        const periDist = star.a_AU * (1 - star.e);
        const tidalFactor = periDist / Math.max(r_AU, periDist * 0.5);
        return {
            name: star.name,
            spectral: star.spectral,
            Teff: star.Teff,
            mass_Msun: star.mass_Msun,
            L_Lsun: star.L_Lsun,
            Mdot: star.Mdot,
            v_wind: star.v_wind,
            distance_AU: r_AU,
            velocity_kms: v_kms,
            pericenter_AU: periDist,
            tidalFactor: Math.min(3, tidalFactor),
        };
    }

    setTrails(enabled) {
        this.trailsEnabled = enabled;
        this.trails.forEach(t => t.line.visible = enabled);
    }

    setWindVisible(visible) {
        this.windSystems.forEach(ws => ws.points.visible = visible);
    }

    dispose() {
        this.orbits.forEach(o => { o.geometry.dispose(); o.material.dispose(); this.scene.remove(o); });
        this.markers.forEach(m => {
            m.children.forEach(c => { if (c.material) c.material.dispose(); if (c.geometry) c.geometry.dispose(); });
            m.geometry.dispose(); m.material.dispose(); this.scene.remove(m);
        });
        this.trails.forEach(t => { t.line.geometry.dispose(); t.line.material.dispose(); this.scene.remove(t.line); });
        this.windSystems.forEach(ws => { ws.points.geometry.dispose(); ws.points.material.dispose(); this.scene.remove(ws.points); });
    }
}

// ── RadioOutflow ─────────────────────────────────────────────────────────────
// Sgr A* does NOT have powerful AGN-style jets. It has weak, compact radio
// outflows detected at 1.3 cm (Li et al. 2013, Issaoun et al. 2019).
// L_radio ≈ 10³⁵ erg/s — 10⁹× weaker than typical AGN jets.
// The outflow extends only ~0.5" (~4000 AU) from the BH.
export class RadioOutflow {
    constructor(scene, { count = 80, maxHeight = 1.8, bhRadius = 0.5 } = {}) {
        this.scene = scene;
        this.count = count;
        this.maxHeight = maxHeight;
        this.bhRadius = bhRadius;
        this.power = 0.15; // default: weak (Sgr A* realistic)
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
            const h = Math.random() * this.maxHeight + 0.1;
            // Wide opening angle — poorly collimated (not a true jet)
            const opening = 0.12 + 0.2 * (h / this.maxHeight);
            pos[i * 3]     = Math.cos(angle) * opening;
            pos[i * 3 + 1] = up * h;
            pos[i * 3 + 2] = Math.sin(angle) * opening;
            this.vel[i] = 0.003 + Math.random() * 0.008; // slow
            // Radio-red synchrotron colors (1.3 cm emission)
            const hN = h / this.maxHeight;
            col[i * 3]     = 0.6 + hN * 0.3;  // red-dominant
            col[i * 3 + 1] = 0.15 + hN * 0.15;
            col[i * 3 + 2] = 0.08 + hN * 0.08;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        this.points = new THREE.Points(geo, new THREE.PointsMaterial({
            size: 0.06, vertexColors: true, transparent: true, opacity: 0.25,
            blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
        }));
        this.scene.add(this.points);
    }

    setPower(power) {
        this.power = Math.max(0, Math.min(1, power));
        this.points.material.opacity = 0.25 * this.power + 0.03;
    }

    update(dt) {
        const jp = this.points.geometry.attributes.position.array;
        const N = this.count;
        const time = performance.now() * 0.001;
        const pw = Math.max(0.05, this.power);

        for (let i = 0; i < N; i++) {
            const up = jp[i * 3 + 1] > 0 ? 1 : -1;
            jp[i * 3 + 1] += up * this.vel[i] * pw;
            // Gentle wobble — turbulent outflow, not collimated
            const wobble = time * 1.5 + jp[i * 3 + 1] * 3;
            jp[i * 3]     += (Math.cos(wobble) * 0.002 - jp[i * 3] * 0.002);
            jp[i * 3 + 2] += (Math.sin(wobble) * 0.002 - jp[i * 3 + 2] * 0.002);
            if (Math.abs(jp[i * 3 + 1]) > this.maxHeight) {
                const angle = Math.random() * Math.PI * 2;
                jp[i * 3]     = Math.cos(angle) * 0.08;
                jp[i * 3 + 1] = up * Math.random() * 0.15;
                jp[i * 3 + 2] = Math.sin(angle) * 0.08;
            }
        }
        this.points.geometry.attributes.position.needsUpdate = true;
    }

    dispose() {
        this.points.geometry.dispose(); this.points.material.dispose();
        this.scene.remove(this.points);
    }
}

// ── RadiationField ───────────────────────────────────────────────────────────
// Multi-band emission visualization. Sgr A* emits across the spectrum:
//   Radio (1.3 cm): L ~ 10³⁵ erg/s — dominant, extends to ~1000 Rs
//   Submm (230 GHz): L ~ 10³⁵ erg/s — EHT observing band, near ISCO
//   NIR (2.2 μm): L ~ 10³³ erg/s quiescent, flares to 10³⁴·⁵
//   X-ray (2-10 keV): L ~ 2×10³³ erg/s quiescent, flares to 10³⁵
// Total L_bol ≈ 10³⁶ erg/s = 300 L☉ — only 10⁻⁸ L_Eddington!
export class RadiationField {
    constructor(scene, { bhRadius = 0.5 } = {}) {
        this.scene = scene;
        this.bhRadius = bhRadius;
        this.time = 0;
        this.eddingtonRatio = 1e-8; // L/L_Edd
        this._build();
    }

    _build() {
        // Radio emission shell — largest, faintest red glow
        this.radioShell = new THREE.Mesh(
            new THREE.SphereGeometry(this.bhRadius * 8, 32, 32),
            new THREE.ShaderMaterial({
                vertexShader: `
                    varying vec3 vNormal, vViewDir;
                    void main() {
                        vNormal = normalize(normalMatrix * normal);
                        vec4 wp = modelMatrix * vec4(position, 1.0);
                        vViewDir = normalize(cameraPosition - wp.xyz);
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }`,
                fragmentShader: `
                    uniform float u_time;
                    uniform float u_intensity;
                    varying vec3 vNormal, vViewDir;
                    void main() {
                        float rim = 1.0 - abs(dot(vViewDir, vNormal));
                        float glow = pow(rim, 2.5) * u_intensity;
                        // Radio: deep red synchrotron
                        vec3 col = vec3(0.7, 0.12, 0.05) * glow;
                        gl_FragColor = vec4(col, glow * 0.3);
                    }`,
                uniforms: { u_time: { value: 0 }, u_intensity: { value: 0.4 } },
                transparent: true, depthWrite: false, side: THREE.BackSide,
                blending: THREE.AdditiveBlending,
            })
        );
        this.scene.add(this.radioShell);

        // Submm emission shell — EHT band, closer to BH
        this.submmShell = new THREE.Mesh(
            new THREE.SphereGeometry(this.bhRadius * 4, 32, 32),
            new THREE.ShaderMaterial({
                vertexShader: this.radioShell.material.vertexShader,
                fragmentShader: `
                    uniform float u_time;
                    uniform float u_intensity;
                    varying vec3 vNormal, vViewDir;
                    void main() {
                        float rim = 1.0 - abs(dot(vViewDir, vNormal));
                        float glow = pow(rim, 3.0) * u_intensity;
                        // Submm: warm orange (230 GHz thermal)
                        vec3 col = vec3(0.9, 0.45, 0.08) * glow;
                        gl_FragColor = vec4(col, glow * 0.25);
                    }`,
                uniforms: { u_time: { value: 0 }, u_intensity: { value: 0.35 } },
                transparent: true, depthWrite: false, side: THREE.BackSide,
                blending: THREE.AdditiveBlending,
            })
        );
        this.scene.add(this.submmShell);

        // X-ray emission — compact, near ISCO, blue-white
        this.xrayShell = new THREE.Mesh(
            new THREE.SphereGeometry(this.bhRadius * 2.0, 24, 24),
            new THREE.ShaderMaterial({
                vertexShader: this.radioShell.material.vertexShader,
                fragmentShader: `
                    uniform float u_time;
                    uniform float u_intensity;
                    varying vec3 vNormal, vViewDir;
                    void main() {
                        float rim = 1.0 - abs(dot(vViewDir, vNormal));
                        float pulse = 0.8 + 0.2 * sin(u_time * 3.0);
                        float glow = pow(rim, 4.0) * u_intensity * pulse;
                        // X-ray: blue-white bremsstrahlung
                        vec3 col = vec3(0.3, 0.5, 1.0) * glow;
                        gl_FragColor = vec4(col, glow * 0.2);
                    }`,
                uniforms: { u_time: { value: 0 }, u_intensity: { value: 0.15 } },
                transparent: true, depthWrite: false, side: THREE.BackSide,
                blending: THREE.AdditiveBlending,
            })
        );
        this.scene.add(this.xrayShell);
    }

    setEddingtonRatio(ratio) {
        this.eddingtonRatio = ratio;
        // Scale shell intensities with accretion rate
        const logR = Math.log10(Math.max(1e-12, ratio));
        const norm = (logR + 10) / 4; // maps 1e-10..1e-6 → 0..1
        const s = Math.max(0.05, Math.min(1, norm));
        this.radioShell.material.uniforms.u_intensity.value = 0.4 * s;
        this.submmShell.material.uniforms.u_intensity.value = 0.35 * s;
        this.xrayShell.material.uniforms.u_intensity.value = 0.15 * s;
    }

    // Boost X-ray emission during flares
    setFlareBoost(intensity) {
        this.xrayShell.material.uniforms.u_intensity.value = 0.15 + intensity * 0.8;
    }

    update(dt) {
        this.time += dt;
        this.radioShell.material.uniforms.u_time.value = this.time;
        this.submmShell.material.uniforms.u_time.value = this.time;
        this.xrayShell.material.uniforms.u_time.value = this.time;
    }

    getLuminosity() {
        // L_bol ≈ η * Mdot * c² where η ~ 0.1 for thin disk, ~0.001 for RIAF
        // For Sgr A*: L_bol ≈ 10³⁶ erg/s = ~300 L☉
        const L_edd = 5.2e44; // erg/s for 4.154e6 Msun
        const L_bol = this.eddingtonRatio * L_edd;
        return {
            L_bol_erg: L_bol,
            L_bol_Lsun: L_bol / 3.828e33,
            L_Edd_ratio: this.eddingtonRatio,
            L_radio_erg: L_bol * 0.1,  // ~10% in radio
            L_xray_erg: L_bol * 0.02,  // ~2% in X-ray (quiescent)
        };
    }

    dispose() {
        [this.radioShell, this.submmShell, this.xrayShell].forEach(m => {
            m.geometry.dispose(); m.material.dispose(); this.scene.remove(m);
        });
    }
}

// ── Starfield ────────────────────────────────────────────────────────────────
export class Starfield {
    constructor(scene, { count = 2000 } = {}) {
        this.scene = scene;
        this._build(count);
    }

    _build(count) {
        const total = count + 500; // extra for galactic center dust band
        const pos = new Float32Array(total * 3);
        const col = new Float32Array(total * 3);
        const sizes = new Float32Array(total);

        // Background stars
        for (let i = 0; i < count; i++) {
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            const r = 25 + Math.random() * 50;
            pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
            pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
            pos[i * 3 + 2] = r * Math.cos(phi);
            sizes[i] = 0.05 + Math.random() * 0.12;
            col[i * 3] = 0.9 + Math.random() * 0.1;
            col[i * 3 + 1] = 0.85 + Math.random() * 0.15;
            col[i * 3 + 2] = 0.8 + Math.random() * 0.2;
        }

        // Galactic center dust band — reddened stars concentrated near disk plane
        for (let i = count; i < total; i++) {
            const theta = Math.random() * Math.PI * 2;
            const r = 15 + Math.random() * 40;
            const y = (Math.random() - 0.5) * 4; // concentrated near plane
            pos[i * 3]     = r * Math.cos(theta);
            pos[i * 3 + 1] = y;
            pos[i * 3 + 2] = r * Math.sin(theta);
            sizes[i] = 0.03 + Math.random() * 0.08;
            // Extinction-reddened colors
            col[i * 3]     = 0.7 + Math.random() * 0.3;
            col[i * 3 + 1] = 0.3 + Math.random() * 0.3;
            col[i * 3 + 2] = 0.1 + Math.random() * 0.15;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
        this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
            vertexShader: `
                attribute float size;
                attribute vec3 color;
                varying float vBright;
                varying vec3 vColor;
                void main() {
                    vColor = color;
                    vec4 mvp = modelViewMatrix * vec4(position, 1.0);
                    float projDist = length(mvp.xy / -mvp.z);
                    float lensBoost = 1.0 + 2.0 / (projDist * projDist + 0.5);
                    vBright = min(lensBoost, 3.0);
                    gl_PointSize = size * 300.0 / -mvp.z * lensBoost;
                    gl_Position = projectionMatrix * mvp;
                }`,
            fragmentShader: `
                varying float vBright;
                varying vec3 vColor;
                void main() {
                    float d = length(gl_PointCoord - 0.5) * 2.0;
                    float alpha = smoothstep(1.0, 0.0, d);
                    gl_FragColor = vec4(vColor * vBright * 0.5, alpha * 0.8);
                }`,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this.scene.add(this.points);
    }

    dispose() {
        this.points.geometry.dispose(); this.points.material.dispose();
        this.scene.remove(this.points);
    }
}

// ── FlareEngine ──────────────────────────────────────────────────────────────
// Sgr A* has NIR flares ~4×/day, averaging 40-80 min duration
export class FlareEngine {
    constructor(scene, { bhRadius = 0.5 } = {}) {
        this.scene = scene;
        this.bhRadius = bhRadius;
        this.flaring = false;
        this.intensity = 0;
        this.flareDuration = 0;
        this.flareTimer = 0;
        this.cooldown = 0;
        this.time = 0;

        // Average 4 flares per day → mean interval ~6 hours = 360 sim-minutes
        // In sim time at 1x speed, we compress heavily for visibility
        this.meanInterval = 15; // seconds of sim time between flares
        this.nextFlare = this.meanInterval * (0.5 + Math.random());

        this._build();
    }

    _build() {
        // NIR flare glow sphere (2.2 μm K-band — warm gold)
        this.nirGlow = new THREE.Mesh(
            new THREE.SphereGeometry(this.bhRadius * 2.5, 32, 32),
            new THREE.MeshBasicMaterial({
                color: 0xffaa33, transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false,
            })
        );
        this.scene.add(this.nirGlow);

        // X-ray flare glow (2-10 keV — blue-white, more compact)
        // X-ray flares lag NIR by ~10-20 min (Dodds-Eden et al. 2009)
        this.xrayGlow = new THREE.Mesh(
            new THREE.SphereGeometry(this.bhRadius * 1.5, 24, 24),
            new THREE.MeshBasicMaterial({
                color: 0x4488ff, transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false,
            })
        );
        this.scene.add(this.xrayGlow);

        // Bright flash ring (hotspot orbiting at ISCO — GRAVITY 2018)
        this.ring = new THREE.Mesh(
            new THREE.TorusGeometry(this.bhRadius * 1.8, 0.08, 12, 64),
            new THREE.MeshBasicMaterial({
                color: 0xffdd88, transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false,
            })
        );
        this.ring.rotation.x = Math.PI / 2;
        this.scene.add(this.ring);
    }

    update(dt) {
        this.time += dt;

        if (!this.flaring) {
            this.nextFlare -= dt;
            if (this.nextFlare <= 0) {
                this.flaring = true;
                this.flareDuration = 3 + Math.random() * 5; // 3-8 seconds
                this.flareTimer = 0;
                this.intensity = 0.5 + Math.random() * 0.5;
                this.nextFlare = this.meanInterval * (0.3 + Math.random() * 1.4);
            }
        } else {
            this.flareTimer += dt;
            const progress = this.flareTimer / this.flareDuration;

            if (progress >= 1) {
                this.flaring = false;
                this.intensity = 0;
            } else {
                // Fast rise, slow decay envelope
                const envelope = progress < 0.15
                    ? progress / 0.15
                    : Math.exp(-(progress - 0.15) * 2.5);
                this.intensity = envelope * (0.5 + Math.random() * 0.1);
            }
        }

        // Update visuals
        // NIR flare: immediate
        this.nirGlow.material.opacity = this.intensity * 0.2;
        this.nirGlow.scale.setScalar(1 + this.intensity * 0.5);

        // X-ray: delayed ~20% into flare, more compact and intense
        const xrayDelay = Math.max(0, (this.flareTimer - this.flareDuration * 0.15));
        const xrayEnvelope = xrayDelay > 0
            ? Math.exp(-xrayDelay / (this.flareDuration * 0.5)) * this.intensity
            : 0;
        this.xrayGlow.material.opacity = xrayEnvelope * 0.25;
        this.xrayGlow.scale.setScalar(1 + xrayEnvelope * 0.3);

        // Hotspot ring orbiting at ISCO (period ~27 min for Sgr A*)
        this.ring.material.opacity = this.intensity * 0.35;
        this.ring.rotation.z = this.time * 2.0; // fast orbital motion
    }

    isFlaring() { return this.flaring; }
    getFlareIntensity() { return this.intensity; }
    getFlareDuration() { return this.flareDuration; }
    getFlareElapsed() { return this.flareTimer; }

    getXrayIntensity() {
        const xrayDelay = Math.max(0, (this.flareTimer - this.flareDuration * 0.15));
        return xrayDelay > 0 ? Math.exp(-xrayDelay / (this.flareDuration * 0.5)) * this.intensity : 0;
    }

    dispose() {
        [this.nirGlow, this.xrayGlow, this.ring].forEach(m => {
            m.geometry.dispose(); m.material.dispose(); this.scene.remove(m);
        });
    }
}
