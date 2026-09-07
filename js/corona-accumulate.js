/**
 * corona-accumulate.js — temporal integration of the jittered corona raymarch
 * ═══════════════════════════════════════════════════════════════════════════
 * SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 3. The volumetric corona
 * (js/corona-volumetric.js) marches 12 jittered steps per pixel; this composer
 * pass renders it ALONE (the mesh lives on camera layer 1, which the main
 * RenderPass does not draw), blends the result into a history buffer while
 * the camera is still, and adds the history onto the scene. With a static
 * camera the history converges in ~16 frames to the equivalent of ~200
 * samples per pixel at 1× cost; any camera motion, channel switch or
 * explicit `reset()` restarts from the current frame (no ghosting — the
 * corona is additive and camera-locked, so reprojection is not needed: a
 * moved camera simply resets).
 *
 * Duck-types three's Pass (like js/sun-post.js) so the module needs no
 * static three import. Insert it right after the RenderPass and before the
 * post chain so the corona receives bloom + exposure like everything else.
 *
 *   const acc = new CoronaAccumPass(THREE, { scene, camera, corona: volumetricCorona, width, height });
 *   composer.insertPass(acc, 1);
 *   acc.state → { frames, resets, weight, active }
 */
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

const VS = /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const ACCUM_FS = /* glsl */`
    precision highp float;
    uniform sampler2D tHistory; uniform sampler2D tCurrent; uniform float uWeight;
    varying vec2 vUv;
    void main() { gl_FragColor = mix(texture2D(tHistory, vUv), texture2D(tCurrent, vUv), uWeight); }
`;
const ADD_FS = /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse; uniform sampler2D tCorona;
    varying vec2 vUv;
    void main() {
        vec4 s = texture2D(tDiffuse, vUv);
        gl_FragColor = vec4(s.rgb + texture2D(tCorona, vUv).rgb, s.a);
    }
`;

export const GOLDEN = 0.6180339887498949;
export const MAX_HISTORY = 32;   // frames — weight floor 1/32

/** Blend weight for the n-th accumulated frame (1 on reset, 1/(n+1) down to the floor). */
export function accumWeight(n, maxHistory = MAX_HISTORY) {
    return Math.max(1 / (Math.min(n, maxHistory) + 1), 1 / (maxHistory + 1));
}

export class CoronaAccumPass {
    constructor(THREE, opts) {
        this.THREE = THREE;
        this.isPass = true; this.enabled = true; this.needsSwap = true; this.clear = false; this.renderToScreen = false;
        this.scene = opts.scene; this.camera = opts.camera; this.corona = opts.corona;
        this.layer = opts.layer ?? 1;
        this.maxHistory = opts.maxHistory ?? MAX_HISTORY;
        this._n = 0; this._resets = 0; this._frame = 0; this._needsReset = true;
        this._camSnapshot = new Float32Array(32);
        const rtOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false };
        this._rtOpts = rtOpts;
        this.rtCurrent = new THREE.WebGLRenderTarget(1, 1, rtOpts);
        this.rtHistA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
        this.rtHistB = new THREE.WebGLRenderTarget(1, 1, rtOpts);
        this.accumMat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: ACCUM_FS, depthTest: false, depthWrite: false,
            uniforms: { tHistory: { value: null }, tCurrent: { value: null }, uWeight: { value: 1 } } });
        this.addMat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: ADD_FS, depthTest: false, depthWrite: false,
            uniforms: { tDiffuse: { value: null }, tCorona: { value: null } } });
        this.quad = new FullScreenQuad(THREE, this.accumMat);
        this._clearColor = new THREE.Color(0, 0, 0);
        this.setSize(opts.width || 1280, opts.height || 720);
        if (this.corona && this.corona.onChannelChange) this.corona.onChannelChange(() => this.reset());
    }

    setSize(w, h) {
        for (const rt of [this.rtCurrent, this.rtHistA, this.rtHistB]) rt.setSize(w, h);
        this._needsReset = true;
    }

    /** Restart accumulation from the next frame (channel switch, AR update, camera jump). */
    reset() { this._needsReset = true; }

    _cameraMoved() {
        const m = this.camera.matrixWorld.elements, p = this.camera.projectionMatrix.elements;
        let moved = false;
        for (let i = 0; i < 16; i++) {
            if (Math.abs(this._camSnapshot[i] - m[i]) > 1e-6 || Math.abs(this._camSnapshot[16 + i] - p[i]) > 1e-6) moved = true;
            this._camSnapshot[i] = m[i]; this._camSnapshot[16 + i] = p[i];
        }
        return moved;
    }

    render(renderer, writeBuffer, readBuffer) {
        const mesh = this.corona && this.corona.mesh;
        if (!mesh || !mesh.visible) { this.needsSwap = false; this._needsReset = true; return; }
        this.needsSwap = true;
        const prevRT = renderer.getRenderTarget();
        const prevAutoClear = renderer.autoClear;
        const prevClear = renderer.getClearColor(this._clearColor).clone();
        const prevAlpha = renderer.getClearAlpha();
        const prevMask = this.camera.layers.mask;

        // 1. Corona only, jittered.
        this._frame++;
        if (this.corona.setJitter) this.corona.setJitter((this._frame * GOLDEN) % 1);
        this.camera.layers.set(this.layer);
        renderer.setRenderTarget(this.rtCurrent);
        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = true;
        renderer.clear();
        renderer.render(this.scene, this.camera);
        this.camera.layers.mask = prevMask;

        // 2. Accumulate (reset on camera motion / request).
        const moved = this._cameraMoved();
        if (moved || this._needsReset) { this._n = 0; this._resets++; this._needsReset = false; }
        const weight = this._n === 0 ? 1 : accumWeight(this._n, this.maxHistory);
        this.accumMat.uniforms.tHistory.value = this.rtHistA.texture;
        this.accumMat.uniforms.tCurrent.value = this.rtCurrent.texture;
        this.accumMat.uniforms.uWeight.value = weight;
        this.quad.material = this.accumMat;
        renderer.autoClear = false;
        renderer.setRenderTarget(this.rtHistB);
        this.quad.render(renderer);
        [this.rtHistA, this.rtHistB] = [this.rtHistB, this.rtHistA];
        this._n++;
        this._lastWeight = weight;

        // 3. Add onto the scene.
        this.addMat.uniforms.tDiffuse.value = readBuffer.texture;
        this.addMat.uniforms.tCorona.value = this.rtHistA.texture;
        this.quad.material = this.addMat;
        if (this.renderToScreen) renderer.setRenderTarget(null);
        else { renderer.setRenderTarget(writeBuffer); if (this.clear) renderer.clear(); }
        this.quad.render(renderer);

        renderer.setClearColor(prevClear, prevAlpha);
        renderer.autoClear = prevAutoClear;
        renderer.setRenderTarget(prevRT);
    }

    get state() {
        return { active: !!(this.corona && this.corona.mesh && this.corona.mesh.visible), frames: this._n, resets: this._resets, weight: this._lastWeight ?? null, renders: this._frame };
    }

    dispose() {
        for (const rt of [this.rtCurrent, this.rtHistA, this.rtHistB]) rt.dispose();
        this.accumMat.dispose(); this.addMat.dispose(); this.quad.dispose();
    }
}
