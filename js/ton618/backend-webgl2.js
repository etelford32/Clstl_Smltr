import { FULLSCREEN_VERT } from './shaders/fullscreen.vert.js';
import { SCHWARZSCHILD_FRAG } from './shaders/schwarzschild.frag.js';

export function createWebGL2Backend(canvas) {
    const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 not available in this browser.');

    const program = buildProgram(gl, FULLSCREEN_VERT, SCHWARZSCHILD_FRAG);
    const vao = gl.createVertexArray();

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
        showWind:         gl.getUniformLocation(program, 'u_show_wind'),
        windIntensity:    gl.getUniformLocation(program, 'u_wind_intensity'),
        showFeLine:       gl.getUniformLocation(program, 'u_show_fe_line'),
        feIntensity:      gl.getUniformLocation(program, 'u_fe_intensity'),
        farShortcutR:     gl.getUniformLocation(program, 'u_far_shortcut_r'),
    };

    function resize(w, h) {
        canvas.width  = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
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
        gl.uniform1i(uLoc.showWind,         u.showWind ? 1 : 0);
        gl.uniform1f(uLoc.windIntensity,    u.windIntensity    ?? 0.04);
        gl.uniform1i(uLoc.showFeLine,       u.showFeLine ? 1 : 0);
        gl.uniform1f(uLoc.feIntensity,      u.feIntensity      ?? 0.6);
        gl.uniform1f(uLoc.farShortcutR,     u.farShortcutR     ?? 120.0);
    }

    function draw() {
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    async function readPixelColumn(x, y, w, h) {
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return buf;
    }

    function dispose() {
        gl.deleteProgram(program);
        gl.deleteVertexArray(vao);
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
