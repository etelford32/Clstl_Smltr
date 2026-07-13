/**
 * kernel.js — loader/wrapper for gravity_kernel.wasm (P3.1).
 *
 * The kernel is a dependency-free `extern "C"` module (rust-gravity/):
 * static f64 buffers for bodies [m,x,y,z,vx,vy,vz]×64 and massless
 * particles [x,y,z,vx,vy,vz]×65536, plus Yoshida-4 / leapfrog stepping
 * and diagnostics that MIRROR js/gravity-lab/physics.js. The harness
 * parity-gates the two implementations at 1e-12 after 1e4 steps.
 *
 * Loads from a URL (worker/browser; instantiateStreaming with an
 * ArrayBuffer fallback for hosts that mislabel the MIME type) or from
 * bytes (the Node test harness). Memory never grows — the static layout
 * means cached TypedArray views stay valid for the module's lifetime.
 */

export async function loadKernel(source) {
    let instance;
    if (typeof source === 'string' || source instanceof URL) {
        const resp = await fetch(source);
        if (!resp.ok) throw new Error(`gravity kernel fetch: HTTP ${resp.status}`);
        try {
            instance = (await WebAssembly.instantiateStreaming(resp.clone(), {})).instance;
        } catch {
            instance = (await WebAssembly.instantiate(await resp.arrayBuffer(), {})).instance;
        }
    } else {
        instance = (await WebAssembly.instantiate(source, {})).instance;
    }
    const x = instance.exports;
    const maxBodies = x.max_bodies();
    const maxParticles = x.max_particles();
    return {
        maxBodies,
        maxParticles,
        // Stable views — the kernel's memory is statically sized.
        bodiesView:    new Float64Array(x.memory.buffer, x.bodies_ptr(),    maxBodies * 7),
        particlesView: new Float64Array(x.memory.buffer, x.particles_ptr(), maxParticles * 6),
        orbitsView:    new Float64Array(x.memory.buffer, x.orbits_ptr(),    maxParticles * 2),
        stepSystem(nBodies, nParticles, steps, dt, soft2, j2) {
            x.step_system(nBodies, nParticles, steps, dt, soft2 || 0,
                j2 ? j2.centerIdx : -1, j2?.J2 ?? 0, j2?.R_eq ?? 0, j2?.mu ?? 0);
        },
        savePositions(nBodies) { x.save_positions(nBodies); },
        stepParticles(nBodies, nParticles, dt, soft2) {
            x.step_particles(nBodies, nParticles, dt, soft2 || 0);
        },
        computeOrbits(nParticles, centerIdx) { x.compute_orbits(nParticles, centerIdx); },
        totalEnergy(nBodies, soft2) { return x.total_energy(nBodies, soft2 || 0); },
        angularMomentumMag(nBodies) { return x.angular_momentum_mag(nBodies); },
    };
}

/** Copy a JS body array ({m, r, v}) into the kernel buffer. */
export function writeBodies(kernel, bodies) {
    const bv = kernel.bodiesView;
    for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i], o = i * 7;
        bv[o]     = b.m;
        bv[o + 1] = b.r[0]; bv[o + 2] = b.r[1]; bv[o + 3] = b.r[2];
        bv[o + 4] = b.v[0]; bv[o + 5] = b.v[1]; bv[o + 6] = b.v[2];
    }
}

/** Copy kernel body state back into the JS body array (r/v only). */
export function readBodies(kernel, bodies) {
    const bv = kernel.bodiesView;
    for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i], o = i * 7;
        b.r[0] = bv[o + 1]; b.r[1] = bv[o + 2]; b.r[2] = bv[o + 3];
        b.v[0] = bv[o + 4]; b.v[1] = bv[o + 5]; b.v[2] = bv[o + 6];
    }
}
