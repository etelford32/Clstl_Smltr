/**
 * solar-disk.js — shared live SDO/AIA solar-disk layer.
 *
 * The Sprint-1.2 implementation billboarded the SDO JPEG with a plain
 * SpriteMaterial, so the image's BLACK SQUARE BACKGROUND rendered as an
 * opaque box clipped over the photosphere (the "dark square" artifact).
 *
 * This replaces it with a camera-facing plane carrying a custom shader:
 *   • circular mask to the true solar disk (the square frame is discarded)
 *   • soft limb feather so the disk dissolves into the corona, no hard edge
 *   • luminance-keyed alpha — the black frame/space becomes transparent so
 *     the procedural photosphere + corona show through; only the luminous
 *     solar surface paints the real imagery
 *   • mild tone-map + warm grade so the live disk integrates with the
 *     synthetic corona instead of fighting it
 *
 * One implementation, used by BOTH Sun scenes (heliosphere hero +
 * Sun·Earth globe) so they are two windows onto the same real-time Sun.
 */

const DISK_VERT = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DISK_FRAG = /* glsl */`
precision highp float;
uniform sampler2D u_tex;
uniform float u_opacity;     // global fade [0..1]
uniform float u_diskR;       // solar-disk radius in uv (0.5 = half-frame)
uniform float u_feather;     // limb feather width (uv)
uniform vec3  u_tint;        // warm grade multiplier
varying vec2 vUv;

void main() {
    // Radial distance from frame centre (0 at centre).
    vec2  c = vUv - 0.5;
    float r = length(c);

    // Hard discard well outside the disk keeps the square frame out of
    // the depth/alpha entirely.
    if (r > u_diskR + u_feather) discard;

    vec3 col = texture2D(u_tex, vUv).rgb;

    // Perceived luminance — the SDO frame's black background / off-disk
    // space is ~0, so this keys it out automatically.
    float luma = dot(col, vec3(0.299, 0.587, 0.114));

    // Circular mask with a soft limb that fades into the corona.
    float disk = 1.0 - smoothstep(u_diskR - u_feather, u_diskR + u_feather, r);
    // Gentle inner vignette so the very limb of the imagery blends rather
    // than ending on a ring.
    float limbBlend = smoothstep(u_diskR, u_diskR * 0.80, r);

    // Tone-map a touch (the JPEGs clip highlights) and warm-grade.
    col = pow(col, vec3(0.90)) * u_tint;
    col = col / (col + vec3(0.55)) * 1.55;          // soft Reinhard

    float a = disk * u_opacity * (0.18 + 0.82 * pow(luma, 0.80));
    a *= mix(0.65, 1.0, limbBlend);

    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
}
`;

/**
 * @param {object} THREE   the three module (passed so this stays renderer-agnostic)
 * @param {object} opts
 * @param {number} [opts.size=18]   plane size in scene units (≈ 2.2 × photosphere radius)
 * @param {number} [opts.diskR=0.455]  solar-disk radius in uv (SDO ≈ 0.46)
 * @returns {{ mesh, setTexture(tex), setOpacity(a), face(camera) }}
 */
export function createSolarDisk(THREE, { size = 18, diskR = 0.455 } = {}) {
    const uniforms = {
        u_tex:     { value: null },
        u_opacity: { value: 0.0 },
        u_diskR:   { value: diskR },
        u_feather: { value: 0.035 },
        u_tint:    { value: new THREE.Color(1.06, 1.0, 0.94) },
    };
    const mat = new THREE.ShaderMaterial({
        vertexShader:   DISK_VERT,
        fragmentShader: DISK_FRAG,
        uniforms,
        transparent: true,
        depthWrite:  false,
        depthTest:   true,
        blending:    THREE.NormalBlending,   // alpha keys out the black frame
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    mesh.renderOrder = 6;
    mesh.visible = false;
    let _hasTex = false;

    return {
        mesh,
        get hasTexture() { return _hasTex; },
        setTexture(tex) {
            tex.colorSpace = THREE.SRGBColorSpace ?? tex.colorSpace;
            const old = uniforms.u_tex.value;
            uniforms.u_tex.value = tex;
            _hasTex = true;
            mesh.visible = true;
            if (old && old.dispose) old.dispose();
        },
        setOpacity(a) { uniforms.u_opacity.value = Math.max(0, Math.min(1, a)); },
        get opacity() { return uniforms.u_opacity.value; },
        /** Billboard: keep the plane facing the camera (call each frame). */
        face(camera) { if (camera) mesh.quaternion.copy(camera.quaternion); },
    };
}
