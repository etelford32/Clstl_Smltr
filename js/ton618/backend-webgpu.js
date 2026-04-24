// WebGPU backend stub. Phase 1+: reimplement the Schwarzschild/Kerr kernel as a
// compute shader (WGSL) and present via a render pass. For Phase 0 we only
// provide the interface so `detectBackend()` compiles cleanly.

export function createWebGPUBackend(/* canvas */) {
    throw new Error('WebGPU backend not yet implemented. Falling back to WebGL2.');
}
