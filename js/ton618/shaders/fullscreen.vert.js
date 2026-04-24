export const FULLSCREEN_VERT = /* glsl */ `#version 300 es
precision highp float;

// Fullscreen triangle pass-through. No vertex buffer needed; draw 3 verts.
out vec2 v_ndc;

void main() {
    vec2 pos = vec2(
        (gl_VertexID == 1) ? 3.0 : -1.0,
        (gl_VertexID == 2) ? 3.0 : -1.0
    );
    v_ndc = pos;
    gl_Position = vec4(pos, 0.0, 1.0);
}
`;
