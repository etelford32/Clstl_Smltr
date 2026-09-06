/**
 * sun-post.js — HDR post chain for sun.html (SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 2)
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE EffectComposer pass that replaces the two `UnrealBloomPass`es (whose
 * thresholded, ring-prone kernel produced the "glow circles" the owner
 * complained about in 2026-06) with:
 *
 *   1. MIP-CHAIN BLOOM (Jimenez, "Next Generation Post Processing in Call of
 *      Duty: Advanced Warfare", SIGGRAPH 2014): a 13-tap downsample with the
 *      Karis average on the first mip (kills fireflies), N half-resolution
 *      mips, then a 9-tap tent upsample accumulated back up the chain. No
 *      threshold — physically it is a wide, smooth PSF, so it cannot ring.
 *      Strength is an additive FRACTION of the blurred image (≈0.06); the
 *      observed disk is already correctly exposed and must not "glow".
 *   2. EXPOSURE ADAPTATION: the smallest mip is reduced to a 1×1 mean
 *      log-luminance, read back every few frames, and fed to the PURE
 *      `ExposureController` (node-tested): EV = log2(L_calib / L_scene),
 *      clamped, with asymmetric time constants (brighten slowly, darken
 *      fast — the eye). L_calib is LOCKED from the first frames of the
 *      default view, so the default look is unchanged and adaptation only
 *      responds to what the camera does afterwards (fly into the corona →
 *      the disk leaves the frame → scene darkens → exposure comes up;
 *      flare → scene brightens → exposure drops and the flash reads as
 *      bloom + a soft roll-off instead of a uniform white-out).
 *   3. COMPOSITE: exposure × (scene + bloom·strength), a soft shoulder above
 *      1.0 (continuous in value AND slope at 1.0), optional LENS effects
 *      (4 mirrored ghosts of the bloom, ≤1.5 px chromatic aberration at the
 *      frame edge, 0.015 film grain — OFF by default in Observed mode, ON
 *      only in the Phase 5 cinematic paths or via `?lens=1`), and blue-ish
 *      noise dither before the 8-bit output.
 *
 * Colour pipeline honesty: the page's shaders emit DISPLAY-REFERRED values
 * (sunFS applies its own acesFilm; the corona shells are additive), and the
 * composer has no OutputPass, so the exposure multiply here is a practical
 * adaptation on tonemapped input rather than a scene-referred exposure.
 * Moving tone mapping to the END of the chain is Phase 6 (TSL, both
 * back-ends); do not fake it here by adding a second ACES.
 *
 * Flare bloom: the old pipeline had a second, tight, high-threshold pass
 * gated by `u_flare_intensity`. Bloom is linear in intensity here, so flash
 * pixels above 1.0 already bloom more than the disk; `flareIntensity` adds a
 * strength boost on top so the punch is preserved. `bloomEnabled` /
 * `flareEnabled` keep the two rendering-panel checkboxes meaningful.
 *
 * Usage (sun.html):
 *   const sunPost = new SunPostPass(THREE, { width, height });
 *   composer.addPass(sunPost);         // before the spaceOcclusion pass
 *   sunPost.bloomStrength = 0.06;      // per-frame target (lerped inside)
 *   sunPost.flareIntensity = u_flare_intensity.value;
 *   sunPost.setSize(w, h)              // on resize
 *   sunPost.exposure.ev                // current EV for the HUD / tests
 */
// No static three import: the pure half (ExposureController, bloomMipSizes,
// flareBloomBoost) must load under node for tests/sun-post.mjs. The pass
// duck-types three's `Pass` interface (enabled / needsSwap / clear /
// renderToScreen / setSize / render) — that is all EffectComposer reads —
// and builds its own full-screen quad from the injected THREE.

// ── Pure: exposure controller (tests/sun-post.mjs) ──────────────────────────

export const EXPOSURE_DEFAULTS = Object.freeze({
    evMin: -2.0,        // never darker than 1/4 of the calibrated view
    evMax: 4.0,         // never brighter than 16× (deep-corona flights)
    tauBrighten: 1.2,   // s — dark adaptation is slow
    tauDarken: 0.5,     // s — a flare snaps the iris shut
    calibFrames: 20,    // frames of the default view averaged into L_calib
    minLum: 1e-5,
});

/**
 * EV controller. Feed it the scene's mean log-luminance each measurement;
 * it locks a calibration luminance from the first `calibFrames` samples
 * (EV = 0 there), then tracks log2(L_calib / L) with asymmetric first-order
 * time constants. No ambient time — `step` takes dt.
 */
export class ExposureController {
    constructor(opts = {}) {
        this.p = { ...EXPOSURE_DEFAULTS, ...opts };
        this.ev = 0;
        this.evTarget = 0;
        this.calibLum = opts.calibLum ?? null;
        this._calibSum = 0;
        this._calibN = 0;
        this.samples = 0;
        this.lastLum = null;
    }

    /** Re-lock L_calib from the next `calibFrames` samples (e.g. after a scene change). */
    recalibrate() { this.calibLum = null; this._calibSum = 0; this._calibN = 0; this.ev = 0; this.evTarget = 0; }

    /**
     * @param {number} avgLogLum  mean of ln(luminance) over the frame
     * @param {number} dt         seconds since the previous step
     * @returns {number} exposure multiplier (2^EV)
     */
    step(avgLogLum, dt) {
        if (!Number.isFinite(avgLogLum) || !Number.isFinite(dt)) return this.exposure;
        const L = Math.max(Math.exp(avgLogLum), this.p.minLum);
        this.lastLum = L;
        this.samples++;
        if (this.calibLum == null) {
            this._calibSum += Math.log(L);
            this._calibN++;
            if (this._calibN >= this.p.calibFrames) this.calibLum = Math.exp(this._calibSum / this._calibN);
            return this.exposure;                       // EV stays 0 while calibrating
        }
        const target = clamp(Math.log2(this.calibLum / L), this.p.evMin, this.p.evMax);
        this.evTarget = target;
        const tau = target > this.ev ? this.p.tauBrighten : this.p.tauDarken;
        const a = 1 - Math.exp(-Math.max(dt, 0) / tau);
        this.ev += (target - this.ev) * a;
        return this.exposure;
    }

    get exposure() { return Math.pow(2, this.ev); }
    get calibrated() { return this.calibLum != null; }
}

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

/** Mip sizes for a bloom chain: half-res down to ≥ minSize on the short side. */
export function bloomMipSizes(width, height, { maxMips = 6, minSize = 8 } = {}) {
    const out = [];
    let w = Math.max(1, Math.floor(width / 2)), h = Math.max(1, Math.floor(height / 2));
    while (out.length < maxMips && Math.min(w, h) >= minSize) {
        out.push([w, h]);
        w = Math.max(1, Math.floor(w / 2)); h = Math.max(1, Math.floor(h / 2));
    }
    if (!out.length) out.push([Math.max(1, Math.floor(width / 2)), Math.max(1, Math.floor(height / 2))]);
    return out;
}

/** Flare-driven bloom boost (mirrors the old tight pass's gate: nothing below 0.15). */
export function flareBloomBoost(flareIntensity, { knee = 0.15, gain = 1.2 } = {}) {
    const f = Number.isFinite(flareIntensity) ? flareIntensity : 0;
    return f < knee ? 0 : (f - knee) * gain;
}

// ── GLSL ────────────────────────────────────────────────────────────────────

const VS = /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// 13-tap downsample (Jimenez 2014). uKaris = 1 on the first mip: weight each
// of the five 4-tap boxes by 1/(1+luma) so a single hot pixel cannot become
// a firefly that survives every mip.
const DOWN_FS = /* glsl */`
    precision highp float;
    uniform sampler2D tSrc;
    uniform vec2  uTexel;     // 1/src size
    uniform float uKaris;
    varying vec2 vUv;
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    vec3 box4(vec3 a, vec3 b, vec3 c, vec3 d) {
        vec3 s = (a + b + c + d) * 0.25;
        if (uKaris > 0.5) {
            float w = 1.0 / (1.0 + luma(s));
            return s * w * 4.0 / (1.0 / (1.0 + luma(a)) + 1.0 / (1.0 + luma(b)) + 1.0 / (1.0 + luma(c)) + 1.0 / (1.0 + luma(d)));
        }
        return s;
    }
    void main() {
        vec2 t = uTexel;
        vec3 a = texture2D(tSrc, vUv + vec2(-2.0,  2.0) * t).rgb;
        vec3 b = texture2D(tSrc, vUv + vec2( 0.0,  2.0) * t).rgb;
        vec3 c = texture2D(tSrc, vUv + vec2( 2.0,  2.0) * t).rgb;
        vec3 d = texture2D(tSrc, vUv + vec2(-2.0,  0.0) * t).rgb;
        vec3 e = texture2D(tSrc, vUv                     ).rgb;
        vec3 f = texture2D(tSrc, vUv + vec2( 2.0,  0.0) * t).rgb;
        vec3 g = texture2D(tSrc, vUv + vec2(-2.0, -2.0) * t).rgb;
        vec3 h = texture2D(tSrc, vUv + vec2( 0.0, -2.0) * t).rgb;
        vec3 i = texture2D(tSrc, vUv + vec2( 2.0, -2.0) * t).rgb;
        vec3 j = texture2D(tSrc, vUv + vec2(-1.0,  1.0) * t).rgb;
        vec3 k = texture2D(tSrc, vUv + vec2( 1.0,  1.0) * t).rgb;
        vec3 l = texture2D(tSrc, vUv + vec2(-1.0, -1.0) * t).rgb;
        vec3 m = texture2D(tSrc, vUv + vec2( 1.0, -1.0) * t).rgb;
        vec3 col = box4(j, k, l, m) * 0.5
                 + box4(a, b, d, e) * 0.125
                 + box4(b, c, e, f) * 0.125
                 + box4(d, e, g, h) * 0.125
                 + box4(e, f, h, i) * 0.125;
        gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
`;

// 9-tap tent upsample of the coarser accumulation, added to this mip.
const UP_FS = /* glsl */`
    precision highp float;
    uniform sampler2D tCoarse;   // accumulated bloom, one mip coarser
    uniform sampler2D tMip;      // this mip's downsampled scene
    uniform vec2  uTexel;        // 1/coarse size
    uniform float uRadius;
    varying vec2 vUv;
    void main() {
        vec2 t = uTexel * uRadius;
        vec3 s = texture2D(tCoarse, vUv).rgb * 4.0
               + (texture2D(tCoarse, vUv + vec2( 0.0,  1.0) * t).rgb + texture2D(tCoarse, vUv + vec2(-1.0, 0.0) * t).rgb
                + texture2D(tCoarse, vUv + vec2( 1.0,  0.0) * t).rgb + texture2D(tCoarse, vUv + vec2( 0.0, -1.0) * t).rgb) * 2.0
               +  texture2D(tCoarse, vUv + vec2(-1.0,  1.0) * t).rgb + texture2D(tCoarse, vUv + vec2( 1.0,  1.0) * t).rgb
               +  texture2D(tCoarse, vUv + vec2(-1.0, -1.0) * t).rgb + texture2D(tCoarse, vUv + vec2( 1.0, -1.0) * t).rgb;
        gl_FragColor = vec4(texture2D(tMip, vUv).rgb + s / 16.0, 1.0);
    }
`;

// 8×8 grid of the smallest mip → mean log-luminance in .r (1×1 target).
const LUM_FS = /* glsl */`
    precision highp float;
    uniform sampler2D tSrc;
    void main() {
        float acc = 0.0;
        for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
            vec2 uv = (vec2(float(x), float(y)) + 0.5) / 8.0;
            vec3 c = texture2D(tSrc, uv).rgb;
            acc += log(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-5));
        }
        gl_FragColor = vec4(acc / 64.0, 0.0, 0.0, 1.0);
    }
`;

const COMPOSITE_FS = /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform float uExposure;
    uniform float uBloom;      // additive fraction of the blurred image (already ÷ mip count)
    uniform float uBloomNorm;  // 1/(mips+1): tBloom is a SUM of the chain, normalise every read
    uniform float uFlare;      // flare boost — applied to the BRIGHT PASS of the bloom only
    uniform float uLens;       // 0/1 — ghosts + CA + grain
    uniform float uGhost;
    uniform float uCA;         // px at the frame edge
    uniform float uGrain;
    uniform float uTime;
    uniform vec2  uRes;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
        vec3 col;
        if (uLens > 0.5 && uCA > 0.0) {
            // Lateral chromatic aberration: radial shift growing to uCA px at the edge.
            vec2 d = (vUv - 0.5) * 2.0;
            vec2 off = d * (uCA / uRes) * dot(d, d);
            col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
        } else {
            col = texture2D(tDiffuse, vUv).rgb;
        }
        vec3 bloom = texture2D(tBloom, vUv).rgb * uBloomNorm;
        // Ambient: a fraction of the whole blurred image. Flare: only what is
        // already bright in the blur (> 0.65) — a global boost of an
        // un-thresholded bloom lit the entire disk white (measured).
        col = (col + bloom * uBloom + max(bloom - 0.65, 0.0) * uFlare) * uExposure;
        if (uLens > 0.5 && uGhost > 0.0) {
            // Four ghosts of the BRIGHT part of the bloom (threshold 0.55 so the
            // disk's own glow does not re-light the disk), mirrored through the
            // frame centre and vignetted toward the edge.
            vec2 c = 0.5 - vUv;
            vec3 gh = vec3(0.0);
            gh += max(texture2D(tBloom, 0.5 + c * 0.55).rgb * uBloomNorm - 0.55, 0.0) * 0.30;
            gh += max(texture2D(tBloom, 0.5 + c * 1.35).rgb * uBloomNorm - 0.55, 0.0) * 0.22;
            gh += max(texture2D(tBloom, 0.5 - c * 0.70).rgb * uBloomNorm - 0.55, 0.0) * 0.18;
            gh += max(texture2D(tBloom, 0.5 - c * 1.80).rgb * uBloomNorm - 0.55, 0.0) * 0.12;
            float vig = 1.0 - smoothstep(0.35, 0.95, length(c) * 2.0);
            col += gh * uGhost * uExposure * (0.35 + 0.65 * vig);
        }
        // Soft shoulder above 1.0: y = 1 + x/(1+x) for the overshoot x — value
        // and slope both continuous at 1.0, so nothing steps at the clip.
        vec3 over = max(col - 1.0, 0.0);
        col = min(col, 1.0) + over / (1.0 + over);
        if (uLens > 0.5 && uGrain > 0.0) {
            col += (hash(vUv * uRes + fract(uTime) * 61.7) - 0.5) * uGrain;
        }
        // Dither before quantisation (kills 8-bit banding in the dark corona).
        col += (hash(vUv * uRes + 3.1) - 0.5) / 255.0;
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
`;

// ── The pass ────────────────────────────────────────────────────────────────

class FullScreenQuad {
    constructor(THREE, material) {
        this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    }
    get material() { return this._mesh.material; }
    set material(m) { this._mesh.material = m; }
    render(renderer) { renderer.render(this._mesh, this._camera); }
    dispose() { this._mesh.geometry.dispose(); }
}

export class SunPostPass {
    /**
     * @param {object} THREE
     * @param {object} opts
     * @param {number} opts.width  @param {number} opts.height
     * @param {number} [opts.maxMips=6]
     * @param {number} [opts.bloomStrength=0.06]
     * @param {boolean} [opts.lens=false]
     * @param {number} [opts.readbackEvery=4]   frames between luminance readbacks
     * @param {object} [opts.exposure]          ExposureController options
     */
    constructor(THREE, opts = {}) {
        this.THREE = THREE;
        // three `Pass` contract
        this.isPass = true;
        this.enabled = true;
        this.needsSwap = true;
        this.clear = false;
        this.renderToScreen = false;
        this.maxMips = opts.maxMips ?? 6;
        this.bloomStrength = opts.bloomStrength ?? 0.06;   // target; lerped per frame
        this.bloomRadius = opts.bloomRadius ?? 1.0;
        this.bloomEnabled = true;
        this.flareEnabled = true;
        this.flareIntensity = 0;
        this.lens = !!opts.lens;
        this.ghost = opts.ghost ?? 0.18;
        this.chromaticAberrationPx = opts.chromaticAberrationPx ?? 1.5;
        this.grain = opts.grain ?? 0.015;
        this.adaptEnabled = opts.adapt !== false;
        this.readbackEvery = opts.readbackEvery ?? 4;
        this.exposure = new ExposureController(opts.exposure);
        this._frame = 0;
        this._lastT = null;
        this._strengthNow = this.bloomStrength;
        this._lumPixel = new Float32Array(4);
        this.lastAvgLogLum = null;

        const rtOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false };
        this._rtOpts = rtOpts;
        this.lumTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false });

        this.downMat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: DOWN_FS, depthTest: false, depthWrite: false,
            uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uKaris: { value: 0 } } });
        this.upMat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: UP_FS, depthTest: false, depthWrite: false,
            uniforms: { tCoarse: { value: null }, tMip: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 } } });
        this.lumMat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: LUM_FS, depthTest: false, depthWrite: false,
            uniforms: { tSrc: { value: null } } });
        this.compMat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: COMPOSITE_FS, depthTest: false, depthWrite: false,
            uniforms: {
                tDiffuse: { value: null }, tBloom: { value: null },
                uExposure: { value: 1 }, uBloom: { value: 0 }, uBloomNorm: { value: 1 }, uFlare: { value: 0 }, uLens: { value: 0 }, uGhost: { value: this.ghost },
                uCA: { value: this.chromaticAberrationPx }, uGrain: { value: this.grain }, uTime: { value: 0 },
                uRes: { value: new THREE.Vector2(1, 1) },
            } });
        this.quad = new FullScreenQuad(THREE, this.downMat);
        this.mips = []; this.ups = []; this.sizes = [];
        this.setSize(opts.width || 1280, opts.height || 720);
    }

    setSize(width, height) {
        const THREE = this.THREE;
        for (const rt of [...this.mips, ...this.ups]) rt.dispose();
        this.sizes = bloomMipSizes(width, height, { maxMips: this.maxMips });
        this.mips = this.sizes.map(([w, h]) => new THREE.WebGLRenderTarget(w, h, this._rtOpts));
        this.ups  = this.sizes.map(([w, h]) => new THREE.WebGLRenderTarget(w, h, this._rtOpts));
        this.compMat.uniforms.uRes.value.set(width, height);
        this.width = width; this.height = height;
    }

    /** Per-frame time source (ms); override in tests. */
    now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

    render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
        const THREE = this.THREE;
        const prevRT = renderer.getRenderTarget();
        const prevAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        const n = this.mips.length;

        // 1. Downsample chain.
        let src = readBuffer.texture, sw = readBuffer.width, sh = readBuffer.height;
        for (let i = 0; i < n; i++) {
            this.downMat.uniforms.tSrc.value = src;
            this.downMat.uniforms.uTexel.value.set(1 / sw, 1 / sh);
            this.downMat.uniforms.uKaris.value = i === 0 ? 1 : 0;
            this.quad.material = this.downMat;
            renderer.setRenderTarget(this.mips[i]);
            renderer.clear();
            this.quad.render(renderer);
            src = this.mips[i].texture; sw = this.sizes[i][0]; sh = this.sizes[i][1];
        }

        // 2. Luminance reduction from the smallest mip (+ occasional readback).
        if (this.adaptEnabled) {
            this.lumMat.uniforms.tSrc.value = this.mips[n - 1].texture;
            this.quad.material = this.lumMat;
            renderer.setRenderTarget(this.lumTarget);
            renderer.clear();
            this.quad.render(renderer);
            if (this._frame % this.readbackEvery === 0) {
                try {
                    renderer.readRenderTargetPixels(this.lumTarget, 0, 0, 1, 1, this._lumPixel);
                    const t = this.now();
                    const dt = this._lastT == null ? 1 / 60 : Math.min(0.5, (t - this._lastT) / 1000);
                    this._lastT = t;
                    this.lastAvgLogLum = this._lumPixel[0];
                    this.exposure.step(this.lastAvgLogLum, dt);
                } catch (_) { /* readback unsupported: exposure stays at its last value */ }
            }
        }

        // 3. Upsample chain: ups[n-1] = mips[n-1]; ups[i] = mips[i] + tent(ups[i+1]).
        for (let i = n - 1; i >= 0; i--) {
            renderer.setRenderTarget(this.ups[i]);
            renderer.clear();
            if (i === n - 1) {
                this.upMat.uniforms.tCoarse.value = this.mips[i].texture;   // tent(self) ≈ self at the coarsest level
                this.upMat.uniforms.tMip.value = this.mips[i].texture;
                this.upMat.uniforms.uTexel.value.set(0, 0);
            } else {
                this.upMat.uniforms.tCoarse.value = this.ups[i + 1].texture;
                this.upMat.uniforms.tMip.value = this.mips[i].texture;
                this.upMat.uniforms.uTexel.value.set(1 / this.sizes[i + 1][0], 1 / this.sizes[i + 1][1]);
            }
            this.upMat.uniforms.uRadius.value = this.bloomRadius;
            this.quad.material = this.upMat;
            this.quad.render(renderer);
        }
        // The coarsest level was counted twice (mip + "tent of itself"); the
        // chain normalises by 1/(n) below so the sum stays an average-ish PSF.

        // 4. Composite.
        const flareBoost = this.flareEnabled ? flareBloomBoost(this.flareIntensity) : 0;
        const target = this.bloomEnabled ? this.bloomStrength : 0;
        this._strengthNow += (target - this._strengthNow) * 0.06;
        this._flareNow = (this._flareNow ?? 0) + (flareBoost - (this._flareNow ?? 0)) * 0.25;
        const u = this.compMat.uniforms;
        u.tDiffuse.value = readBuffer.texture;
        u.tBloom.value = this.ups[0].texture;
        u.uBloomNorm.value = 1 / (n + 1);                // ups[0] sums n+1 mip contributions
        u.uBloom.value = this._strengthNow;
        u.uFlare.value = this._flareNow;
        u.uExposure.value = this.adaptEnabled ? this.exposure.exposure : 1.0;
        u.uLens.value = this.lens ? 1 : 0;
        u.uGhost.value = this.ghost; u.uCA.value = this.chromaticAberrationPx; u.uGrain.value = this.grain;
        u.uTime.value = (this._frame % 600) / 600;
        this.quad.material = this.compMat;
        if (this.renderToScreen) {
            renderer.setRenderTarget(null);
        } else {
            renderer.setRenderTarget(writeBuffer);
            if (this.clear) renderer.clear();
        }
        this.quad.render(renderer);

        renderer.setRenderTarget(prevRT);
        renderer.autoClear = prevAutoClear;
        this._frame++;
    }

    /** Snapshot for the HUD / tests. */
    get state() {
        return {
            ev: this.exposure.ev, evTarget: this.exposure.evTarget, exposure: this.exposure.exposure,
            calibrated: this.exposure.calibrated, avgLogLum: this.lastAvgLogLum,
            bloomStrength: this._strengthNow, flareBoost: this._flareNow ?? 0, mips: this.mips.length, lens: this.lens,
            bloomEnabled: this.bloomEnabled, flareEnabled: this.flareEnabled,
        };
    }

    dispose() {
        for (const rt of [...this.mips, ...this.ups, this.lumTarget]) rt.dispose();
        for (const m of [this.downMat, this.upMat, this.lumMat, this.compMat]) m.dispose();
        this.quad.dispose();
    }
}
