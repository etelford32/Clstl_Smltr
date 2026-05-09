import { FULLSCREEN_VERT } from './shaders/fullscreen.vert.js';
import { SCHWARZSCHILD_FRAG } from './shaders/schwarzschild.frag.js';
import { BLOOM_EXTRACT_FRAG, BLOOM_BLUR_FRAG } from './shaders/bloom.frag.js';
import { COMPOSITE_FRAG } from './shaders/composite.frag.js';

export function createWebGL2Backend(canvas) {
    const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 not available in this browser.');

    // EXT_color_buffer_float lets us render into RGBA16F textures, which
    // is what makes the HDR pipeline work — the disk's hot inner edge can
    // hit luminance values of ~50 and bloom pulls them back into sRGB.
    // Without the extension we fall back to LDR (RGBA8) — bloom still
    // runs but the brightest pixels are pre-clipped.
    const hdrExt = gl.getExtension('EXT_color_buffer_float') ||
                   gl.getExtension('EXT_color_buffer_half_float');
    const HDR_INTERNAL = hdrExt ? gl.RGBA16F : gl.RGBA8;
    const HDR_TYPE     = hdrExt ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    const program          = buildProgram(gl, FULLSCREEN_VERT, SCHWARZSCHILD_FRAG);
    const programExtract   = buildProgram(gl, FULLSCREEN_VERT, BLOOM_EXTRACT_FRAG);
    const programBlur      = buildProgram(gl, FULLSCREEN_VERT, BLOOM_BLUR_FRAG);
    const programComposite = buildProgram(gl, FULLSCREEN_VERT, COMPOSITE_FRAG);
    const vao = gl.createVertexArray();

    const uExtract = {
        scene:     gl.getUniformLocation(programExtract, 'u_scene'),
        texel:     gl.getUniformLocation(programExtract, 'u_texel'),
        threshold: gl.getUniformLocation(programExtract, 'u_threshold'),
        knee:      gl.getUniformLocation(programExtract, 'u_knee'),
    };
    const uBlur = {
        input:  gl.getUniformLocation(programBlur, 'u_input'),
        texel:  gl.getUniformLocation(programBlur, 'u_texel'),
        axis:   gl.getUniformLocation(programBlur, 'u_axis'),
    };
    const uComposite = {
        scene:          gl.getUniformLocation(programComposite, 'u_scene'),
        bloom:          gl.getUniformLocation(programComposite, 'u_bloom'),
        bloomStrength:  gl.getUniformLocation(programComposite, 'u_bloom_strength'),
        exposureStops:  gl.getUniformLocation(programComposite, 'u_exposure_stops'),
    };

    // ── HDR + bloom framebuffer set ─────────────────────────────────
    // sceneFBO   — RGBA16F at full resolution; the GR ray-trace renders here.
    // bloomA/B   — RGBA16F at half resolution; bright-pass into A, blur
    //              horizontally into B, blur vertically back into A.
    function makeHdrFBO(w, h) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, HDR_INTERNAL, w, h, 0, gl.RGBA, HDR_TYPE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        return { fbo, tex, w, h };
    }
    let sceneFBO = null;
    let bloomA   = null;
    let bloomB   = null;

    function disposeFBO(f) {
        if (!f) return;
        gl.deleteFramebuffer(f.fbo);
        gl.deleteTexture(f.tex);
    }

    const uLoc = {
        resolution:       gl.getUniformLocation(program, 'u_resolution'),
        fovY:             gl.getUniformLocation(program, 'u_fov_y'),
        camPos:           gl.getUniformLocation(program, 'u_cam_pos'),
        camBasis:         gl.getUniformLocation(program, 'u_cam_basis'),
        rFar:             gl.getUniformLocation(program, 'u_r_far'),
        maxSteps:         gl.getUniformLocation(program, 'u_max_steps'),
        tol:              gl.getUniformLocation(program, 'u_tol'),
        showRing:         gl.getUniformLocation(program, 'u_show_ring'),
        time:             gl.getUniformLocation(program, 'u_time'),
        observerType:     gl.getUniformLocation(program, 'u_observer_type'),
        showDisk:         gl.getUniformLocation(program, 'u_show_disk'),
        diskInner:        gl.getUniformLocation(program, 'u_disk_inner'),
        diskOuter:        gl.getUniformLocation(program, 'u_disk_outer'),
        diskThickness:    gl.getUniformLocation(program, 'u_disk_thickness'),
        diskBrightness:   gl.getUniformLocation(program, 'u_disk_brightness'),
        diskTInner:       gl.getUniformLocation(program, 'u_disk_T_inner'),
        diskShearSpeed:   gl.getUniformLocation(program, 'u_disk_shear_speed'),
        diskMode:         gl.getUniformLocation(program, 'u_disk_mode'),
        showHotspot:      gl.getUniformLocation(program, 'u_show_hotspot'),
        hotspotRadius:    gl.getUniformLocation(program, 'u_hotspot_radius'),
        hotspotPhi0:      gl.getUniformLocation(program, 'u_hotspot_phi0'),
        hotspotStrength:  gl.getUniformLocation(program, 'u_hotspot_strength'),
        showGrid:         gl.getUniformLocation(program, 'u_show_grid'),
        showPhotonSphere: gl.getUniformLocation(program, 'u_show_photon_sphere'),
        // Multi-component radiation
        showJets:         gl.getUniformLocation(program, 'u_show_jets'),
        jetVelocity:      gl.getUniformLocation(program, 'u_jet_velocity'),
        jetAlpha:         gl.getUniformLocation(program, 'u_jet_alpha'),
        jetOpen:          gl.getUniformLocation(program, 'u_jet_open'),
        jetRMax:          gl.getUniformLocation(program, 'u_jet_r_max'),
        jetIntensity:     gl.getUniformLocation(program, 'u_jet_intensity'),
        showCorona:       gl.getUniformLocation(program, 'u_show_corona'),
        coronaRadius:     gl.getUniformLocation(program, 'u_corona_radius'),
        coronaWidth:      gl.getUniformLocation(program, 'u_corona_width'),
        coronaIntensity:  gl.getUniformLocation(program, 'u_corona_intensity'),
        coronaY:          gl.getUniformLocation(program, 'u_corona_y'),
        showWind:         gl.getUniformLocation(program, 'u_show_wind'),
        windIntensity:    gl.getUniformLocation(program, 'u_wind_intensity'),
        showFeLine:       gl.getUniformLocation(program, 'u_show_fe_line'),
        feIntensity:      gl.getUniformLocation(program, 'u_fe_intensity'),
        farShortcutR:     gl.getUniformLocation(program, 'u_far_shortcut_r'),
        // B1 / B2 / B3 / B4 / B5 / B7
        diskHOverR:       gl.getUniformLocation(program, 'u_disk_h_over_r'),
        mriStrength:      gl.getUniformLocation(program, 'u_mri_strength'),
        nHotspots:        gl.getUniformLocation(program, 'u_n_hotspots'),
        qpoFlare:         gl.getUniformLocation(program, 'u_qpo_flare'),
        showLindblad:     gl.getUniformLocation(program, 'u_show_lindblad'),
        lindbladRp:       gl.getUniformLocation(program, 'u_lindblad_rp'),
        diskWarpOn:       gl.getUniformLocation(program, 'u_disk_warp_on'),
        diskWarpAngle:    gl.getUniformLocation(program, 'u_disk_warp_angle'),
        diskWarpPsi:      gl.getUniformLocation(program, 'u_disk_warp_psi'),
        spin:             gl.getUniformLocation(program, 'u_spin'),
        // Phase 2.1 — Lyman-α blob
        showLab:          gl.getUniformLocation(program, 'u_show_lab'),
        labIntensity:     gl.getUniformLocation(program, 'u_lab_intensity'),
        labRadiusKpc:     gl.getUniformLocation(program, 'u_lab_radius_kpc'),
        labInnerKpc:      gl.getUniformLocation(program, 'u_lab_inner_kpc'),
        labAlpha:         gl.getUniformLocation(program, 'u_lab_alpha'),
        labClump:         gl.getUniformLocation(program, 'u_lab_clump'),
        labFilament:      gl.getUniformLocation(program, 'u_lab_filament'),
        labFilamentAxis:  gl.getUniformLocation(program, 'u_lab_filament_axis'),
        mInKpc:           gl.getUniformLocation(program, 'u_M_in_kpc'),
        labMechanism:     gl.getUniformLocation(program, 'u_lab_mechanism'),
        labZ:             gl.getUniformLocation(program, 'u_lab_z'),
        labOutflowKms:    gl.getUniformLocation(program, 'u_lab_outflow_kms'),
        labOutflowBeta:   gl.getUniformLocation(program, 'u_lab_outflow_beta'),
        labLogNHI:        gl.getUniformLocation(program, 'u_lab_log_NHI'),
        labTempK:         gl.getUniformLocation(program, 'u_lab_temp_K'),
        labNeufeld:       gl.getUniformLocation(program, 'u_lab_neufeld'),
        // Phase 2.2 — anisotropic scattering / polarization / double-peak
        showPolVectors:   gl.getUniformLocation(program, 'u_show_pol_vectors'),
        labPolMax:        gl.getUniformLocation(program, 'u_lab_pol_max'),
        labDoublePeak:    gl.getUniformLocation(program, 'u_lab_double_peak'),
        camRightCart:     gl.getUniformLocation(program, 'u_cam_right_cart'),
        camUpCart:        gl.getUniformLocation(program, 'u_cam_up_cart'),
        camForwardCart:   gl.getUniformLocation(program, 'u_cam_forward_cart'),
        // Tier 1B — photon sub-rings + sky strength
        showSubrings:     gl.getUniformLocation(program, 'u_show_subrings'),
        subringStrength:  gl.getUniformLocation(program, 'u_subring_strength'),
        skyStrength:      gl.getUniformLocation(program, 'u_sky_strength'),
        // Tier 2A — disk regime (RIAF / thin / slim) driven by ṁ
        diskRegimeIdx:        gl.getUniformLocation(program, 'u_disk_regime'),
        diskTFactor:          gl.getUniformLocation(program, 'u_disk_T_factor'),
        diskRegimeBrightness: gl.getUniformLocation(program, 'u_disk_regime_brightness'),
        // Tier 2B — Blandford-Znajek MAD-state disk dimming
        diskMadDim:           gl.getUniformLocation(program, 'u_disk_mad_dim'),
    };

    // Tier 1A — render-time post-process knobs (state lives in main.js).
    let bloomThreshold  = 1.0;
    let bloomKnee       = 0.5;
    let bloomStrength   = 1.0;
    let exposureStops   = 0.0;
    let bloomEnabled    = true;

    function resize(w, h) {
        canvas.width  = w;
        canvas.height = h;
        // Reallocate the HDR scene FBO and the half-res bloom ping-pong pair.
        // Half-res is fine for bloom — it's a low-frequency glow.
        const hw = Math.max(1, w >> 1);
        const hh = Math.max(1, h >> 1);
        disposeFBO(sceneFBO); sceneFBO = makeHdrFBO(w, h);
        disposeFBO(bloomA);   bloomA   = makeHdrFBO(hw, hh);
        disposeFBO(bloomB);   bloomB   = makeHdrFBO(hw, hh);
    }

    function setUniforms(u) {
        gl.useProgram(program);
        gl.uniform2f(uLoc.resolution, u.width, u.height);
        gl.uniform1f(uLoc.fovY, u.fovY);
        gl.uniform4f(uLoc.camPos, u.camPos[0], u.camPos[1], u.camPos[2], u.camPos[3]);
        gl.uniformMatrix3fv(uLoc.camBasis, false, new Float32Array(u.camBasis));
        gl.uniform1f(uLoc.rFar, u.rFar);
        gl.uniform1i(uLoc.maxSteps, u.maxSteps);
        gl.uniform1f(uLoc.tol, u.tol);
        gl.uniform1i(uLoc.showRing, u.showRing ? 1 : 0);
        gl.uniform1f(uLoc.time, u.time);
        gl.uniform1i(uLoc.observerType, u.observerType | 0);
        gl.uniform1i(uLoc.showDisk,         u.showDisk ? 1 : 0);
        gl.uniform1f(uLoc.diskInner,        u.diskInner ?? 6.0);
        gl.uniform1f(uLoc.diskOuter,        u.diskOuter ?? 24.0);
        gl.uniform1f(uLoc.diskThickness,    u.diskThickness ?? 0.0);
        gl.uniform1f(uLoc.diskBrightness,   u.diskBrightness ?? 1.0);
        gl.uniform1f(uLoc.diskTInner,       u.diskTInner ?? 12000.0);
        gl.uniform1f(uLoc.diskShearSpeed,   u.diskShearSpeed ?? 18.0);
        gl.uniform1i(uLoc.diskMode,         u.diskMode | 0);
        gl.uniform1i(uLoc.showHotspot,      u.showHotspot ? 1 : 0);
        gl.uniform1f(uLoc.hotspotRadius,    u.hotspotRadius ?? 6.5);
        gl.uniform1f(uLoc.hotspotPhi0,      u.hotspotPhi0 ?? 0.0);
        gl.uniform1f(uLoc.hotspotStrength,  u.hotspotStrength ?? 1.5);
        gl.uniform1i(uLoc.showGrid,         u.showGrid ? 1 : 0);
        gl.uniform1i(uLoc.showPhotonSphere, u.showPhotonSphere ? 1 : 0);
        // Multi-component radiation uniforms
        gl.uniform1i(uLoc.showJets,         u.showJets ? 1 : 0);
        gl.uniform1f(uLoc.jetVelocity,      u.jetVelocity      ?? 0.95);
        gl.uniform1f(uLoc.jetAlpha,         u.jetAlpha         ?? 0.7);
        gl.uniform1f(uLoc.jetOpen,          u.jetOpen          ?? 0.18);
        gl.uniform1f(uLoc.jetRMax,          u.jetRMax          ?? 200.0);
        gl.uniform1f(uLoc.jetIntensity,     u.jetIntensity     ?? 0.06);
        gl.uniform1i(uLoc.showCorona,       u.showCorona ? 1 : 0);
        gl.uniform1f(uLoc.coronaRadius,     u.coronaRadius     ?? 10.0);
        gl.uniform1f(uLoc.coronaWidth,      u.coronaWidth      ?? 4.0);
        gl.uniform1f(uLoc.coronaIntensity,  u.coronaIntensity  ?? 0.04);
        gl.uniform1f(uLoc.coronaY,          u.coronaY          ?? 0.7);
        gl.uniform1i(uLoc.showWind,         u.showWind ? 1 : 0);
        gl.uniform1f(uLoc.windIntensity,    u.windIntensity    ?? 0.04);
        gl.uniform1i(uLoc.showFeLine,       u.showFeLine ? 1 : 0);
        gl.uniform1f(uLoc.feIntensity,      u.feIntensity      ?? 0.6);
        gl.uniform1f(uLoc.farShortcutR,     u.farShortcutR     ?? 120.0);
        // B1 / B2 / B3 / B4 / B5 / B7
        gl.uniform1f(uLoc.diskHOverR,       u.diskHOverR       ?? 0.0);
        gl.uniform1f(uLoc.mriStrength,      u.mriStrength      ?? 0.6);
        gl.uniform1i(uLoc.nHotspots,        u.nHotspots        ?? 1);
        gl.uniform1f(uLoc.qpoFlare,         u.qpoFlare         ?? 0.0);
        gl.uniform1i(uLoc.showLindblad,     u.showLindblad ? 1 : 0);
        gl.uniform1f(uLoc.lindbladRp,       u.lindbladRp       ?? 12.0);
        gl.uniform1i(uLoc.diskWarpOn,       u.diskWarpOn ? 1 : 0);
        gl.uniform1f(uLoc.diskWarpAngle,    u.diskWarpAngle    ?? 0.0);
        gl.uniform1f(uLoc.diskWarpPsi,      u.diskWarpPsi      ?? 0.0);
        gl.uniform1f(uLoc.spin,             u.spin             ?? 0.0);
        // Phase 2.1 — Lyman-α blob
        gl.uniform1i(uLoc.showLab,          u.showLab ? 1 : 0);
        gl.uniform1f(uLoc.labIntensity,     u.labIntensity     ?? 0.0);
        gl.uniform1f(uLoc.labRadiusKpc,     u.labRadiusKpc     ?? 460.0);
        gl.uniform1f(uLoc.labInnerKpc,      u.labInnerKpc      ?? 8.0);
        gl.uniform1f(uLoc.labAlpha,         u.labAlpha         ?? 1.8);
        gl.uniform1f(uLoc.labClump,         u.labClump         ?? 0.5);
        gl.uniform1f(uLoc.labFilament,      u.labFilament      ?? 0.4);
        const fa = u.labFilamentAxis ?? [0.6, 0.0, 0.8];
        gl.uniform3f(uLoc.labFilamentAxis,  fa[0], fa[1], fa[2]);
        gl.uniform1f(uLoc.mInKpc,           u.mInKpc           ?? 3.155e-6);
        gl.uniform1i(uLoc.labMechanism,     (u.labMechanism | 0));
        gl.uniform1f(uLoc.labZ,             u.labZ             ?? 2.219);
        gl.uniform1f(uLoc.labOutflowKms,    u.labOutflowKms    ?? 600.0);
        gl.uniform1f(uLoc.labOutflowBeta,   u.labOutflowBeta   ?? 0.5);
        gl.uniform1f(uLoc.labLogNHI,        u.labLogNHI        ?? 20.5);
        gl.uniform1f(uLoc.labTempK,         u.labTempK         ?? 1.0e4);
        gl.uniform1f(uLoc.labNeufeld,       u.labNeufeld       ?? 0.7);
        gl.uniform1i(uLoc.showPolVectors,   u.showPolVectors ? 1 : 0);
        gl.uniform1f(uLoc.labPolMax,        u.labPolMax        ?? 0.12);
        gl.uniform1i(uLoc.labDoublePeak,    u.labDoublePeak ? 1 : 0);
        const cr = u.camRightCart   ?? [1, 0, 0];
        const cu = u.camUpCart      ?? [0, 1, 0];
        const cf = u.camForwardCart ?? [0, 0, 1];
        gl.uniform3f(uLoc.camRightCart,   cr[0], cr[1], cr[2]);
        gl.uniform3f(uLoc.camUpCart,      cu[0], cu[1], cu[2]);
        gl.uniform3f(uLoc.camForwardCart, cf[0], cf[1], cf[2]);
        gl.uniform1i(uLoc.showSubrings,    u.showSubrings ? 1 : 0);
        gl.uniform1f(uLoc.subringStrength, u.subringStrength ?? 1.0);
        gl.uniform1f(uLoc.skyStrength,     u.skyStrength     ?? 1.0);
        gl.uniform1i(uLoc.diskRegimeIdx,        (u.diskRegimeIdx ?? 1) | 0);
        gl.uniform1f(uLoc.diskTFactor,          u.diskTFactor          ?? 1.0);
        gl.uniform1f(uLoc.diskRegimeBrightness, u.diskRegimeBrightness ?? 1.0);
        gl.uniform1f(uLoc.diskMadDim,           u.diskMadDim           ?? 1.0);
        // Tier 1A — post-process state mirrored locally so draw() can use
        // it without re-marshalling the uniforms object.
        bloomThreshold = u.bloomThreshold ?? 1.0;
        bloomKnee      = u.bloomKnee      ?? 0.5;
        bloomStrength  = u.bloomStrength  ?? 1.0;
        exposureStops  = u.exposureStops  ?? 0.0;
        bloomEnabled   = u.bloomEnabled   ?? true;
    }

    function draw() {
        gl.bindVertexArray(vao);
        const w = canvas.width, h = canvas.height;
        const hw = bloomA.w,    hh = bloomA.h;

        // ── Pass 1: scene → HDR float framebuffer ────────────────────
        gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO.fbo);
        gl.viewport(0, 0, w, h);
        gl.useProgram(program);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        if (bloomEnabled && bloomStrength > 0.001) {
            // ── Pass 2: bright extract (full-res scene → half-res A) ─
            gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
            gl.viewport(0, 0, hw, hh);
            gl.useProgram(programExtract);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, sceneFBO.tex);
            gl.uniform1i(uExtract.scene, 0);
            gl.uniform2f(uExtract.texel, 1.0 / w, 1.0 / h);
            gl.uniform1f(uExtract.threshold, bloomThreshold);
            gl.uniform1f(uExtract.knee, bloomKnee);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            // ── Pass 3: horizontal blur (A → B) ─────────────────────
            gl.bindFramebuffer(gl.FRAMEBUFFER, bloomB.fbo);
            gl.useProgram(programBlur);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
            gl.uniform1i(uBlur.input, 0);
            gl.uniform2f(uBlur.texel, 1.0 / hw, 1.0 / hh);
            gl.uniform2f(uBlur.axis, 1.0, 0.0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            // ── Pass 4: vertical blur (B → A) ───────────────────────
            gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
            gl.bindTexture(gl.TEXTURE_2D, bloomB.tex);
            gl.uniform1i(uBlur.input, 0);
            gl.uniform2f(uBlur.axis, 0.0, 1.0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        } else {
            // Bloom off: clear the bloom buffer so the composite pass
            // adds zero glow. Cheap because half-resolution.
            gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
            gl.viewport(0, 0, hw, hh);
            gl.clearColor(0.0, 0.0, 0.0, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }

        // ── Pass 5: composite (scene + bloom → tonemap → canvas) ─────
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        gl.useProgram(programComposite);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sceneFBO.tex);
        gl.uniform1i(uComposite.scene, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
        gl.uniform1i(uComposite.bloom, 1);
        gl.uniform1f(uComposite.bloomStrength, bloomEnabled ? bloomStrength : 0.0);
        gl.uniform1f(uComposite.exposureStops, exposureStops);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        // Restore TEXTURE0 binding so nobody accidentally samples bloom.
        gl.activeTexture(gl.TEXTURE0);
    }

    async function readPixelColumn(x, y, w, h) {
        // Validation harness reads from the *final* canvas, which is the
        // composited tonemapped output. That's correct: the photon-ring
        // measurement looks for actual rendered shadow pixels.
        const buf = new Uint8Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return buf;
    }

    function dispose() {
        gl.deleteProgram(program);
        gl.deleteProgram(programExtract);
        gl.deleteProgram(programBlur);
        gl.deleteProgram(programComposite);
        gl.deleteVertexArray(vao);
        disposeFBO(sceneFBO);
        disposeFBO(bloomA);
        disposeFBO(bloomB);
    }

    return { name: 'webgl2', gl, canvas, resize, setUniforms, draw, readPixelColumn, dispose };
}

function buildProgram(gl, vertSrc, fragSrc) {
    const vs = compile(gl, gl.VERTEX_SHADER,   vertSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    const p  = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error('Program link failed: ' + log);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return p;
}

function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
        gl.deleteShader(sh);
        throw new Error(`Compile failed (${kind}): ${log}`);
    }
    return sh;
}
