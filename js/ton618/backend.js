// Backend-agnostic renderer interface for the TON 618 observatory.
//
// A backend implements: { init(canvas), setUniforms(uniforms), draw(), resize(w,h), dispose() }.
// The geodesic kernel is a fragment shader in WebGL2 and (future) a compute shader
// in WebGPU. This module picks the best available backend.

import { createWebGL2Backend } from './backend-webgl2.js';
import { createWebGPUBackend } from './backend-webgpu.js';

export async function detectBackend() {
    const webgpuOk = await probeWebGPU();
    if (webgpuOk) {
        return { name: 'webgpu', factory: createWebGPUBackend };
    }
    return { name: 'webgl2', factory: createWebGL2Backend };
}

async function probeWebGPU() {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false;
    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return false;
        // Phase 0: WebGPU path is a stub. Flip to true here once the kernel lands.
        const ENABLE_WEBGPU = false;
        return ENABLE_WEBGPU;
    } catch {
        return false;
    }
}
