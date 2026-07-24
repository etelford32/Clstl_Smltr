// shielding-kernel-smoke.mjs — loads the COMMITTED WASM binary through the
// same kernel.js the page uses and drives a southward-turning scenario.
// This is the gate that the shipped artifact (not just the Rust source)
// behaves: if someone rebuilds the kernel and forgets to commit the wasm,
// or the extern-C surface drifts from kernel.js, this fails.
//
//   node tests/shielding-kernel-smoke.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadKernel } from '../js/shielding-lab/kernel.js';

const wasmPath = fileURLToPath(new URL('../js/shielding-lab/wasm/shielding_kernel.wasm', import.meta.url));

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) {
        console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    } else {
        failures++;
        console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

const kernel = await loadKernel(await readFile(wasmPath));

check('grid shape', kernel.nlat === 100 && kernel.nmlt === 96,
    `${kernel.nlat}×${kernel.nmlt}`);

// Quiet steady state (kernel initializes near equilibrium).
kernel.setControls({ bz: -2, by: 0, vsw: 400, n: 5, f107: 120, tauMin: 20, sapsOn: true });
kernel.step(10, 6 * 30); // 30 min
const quietCpcp = kernel.cpcpKv();
check('quiet CPCP in 20–65 kV', quietCpcp > 20 && quietCpcp < 65, `${quietCpcp.toFixed(1)} kV`);

const phi = kernel.phiKv();
check('phi frame finite', Number.isFinite(phi[0]) && Number.isFinite(phi[phi.length - 1]));
check('phi has both cells', Math.max(...phi) > 5 && Math.min(...phi) < -5,
    `${Math.min(...phi).toFixed(1)}…${Math.max(...phi).toFixed(1)} kV`);

// Southward turning → penetration spike, then R2 catches up.
kernel.setControls({ bz: -15, by: 0, vsw: 700, n: 5, f107: 120, tauMin: 20, sapsOn: true });
kernel.step(10, 6 * 2); // 2 min in
const spike = kernel.penEMvpm();
check('undershielding penetration E is eastward (+)', spike > 0, `${spike.toFixed(4)} mV/m`);

kernel.step(10, 6 * 88); // 90 min in
const settled = kernel.penEMvpm();
check('penetration E decays as R2 shields', Math.abs(settled) < 0.55 * Math.abs(spike),
    `${spike.toFixed(4)} → ${settled.toFixed(4)} mV/m`);
check('storm CPCP in 80–260 kV', kernel.cpcpKv() > 80 && kernel.cpcpKv() < 260,
    `${kernel.cpcpKv().toFixed(1)} kV`);
check('shielding efficiency > 0.5', kernel.shieldingEfficiency() > 0.5,
    kernel.shieldingEfficiency().toFixed(3));

const sapsPeak = kernel.sapsPeakMs();
check('SAPS jet > 400 m/s', sapsPeak > 400, `${sapsPeak.toFixed(0)} m/s`);
check('SAPS in subauroral band', kernel.sapsPeakLatDeg() > 52 && kernel.sapsPeakLatDeg() < 68,
    `${kernel.sapsPeakLatDeg().toFixed(1)}°`);
check('SAPS width 1–5°', kernel.sapsWidthDeg() >= 1 && kernel.sapsWidthDeg() <= 5,
    `${kernel.sapsWidthDeg().toFixed(1)}°`);

// Northward turning → overshielding reversal.
kernel.setControls({ bz: 5, by: 0, vsw: 700, n: 5, f107: 120, tauMin: 20, sapsOn: true });
kernel.step(10, 6 * 3);
check('overshielding reverses penetration E', kernel.penEMvpm() < 0,
    `${kernel.penEMvpm().toFixed(4)} mV/m`);

check('R1/R2 sane', kernel.r1Ma() > 0.2 && kernel.r2Ma() > 0.2,
    `R1 ${kernel.r1Ma().toFixed(2)} MA, R2 ${kernel.r2Ma().toFixed(2)} MA`);
check('R2 alpha exported for the verdict classifier',
    kernel.r2Alpha() > 0.5 && kernel.r2Alpha() < 1.0, `α=${kernel.r2Alpha()}`);
check('solver converged', kernel.solverResidual() < 1e-5,
    `res ${kernel.solverResidual().toExponential(1)}, ${kernel.solverIters()} iters`);

// Drift-physics R2 (Phase 6): switch modes, spin up, and confirm the
// emergent ring current produces a real R2 and a nonzero pressure field.
const kd = await loadKernel(await readFile(wasmPath));
kd.setR2Mode('drift');
kd.setControls({ bz: -12, by: 0, vsw: 650, n: 8, f107: 150, tauMin: 25, sapsOn: true });
kd.step(10, 6 * 75); // 75 min spin-up under storm driving
check('drift-mode R2 emerges (0.3–6 MA)', kd.r2Ma() > 0.3 && kd.r2Ma() < 6,
    `${kd.r2Ma().toFixed(2)} MA`);
const press = kd.pressure();
const pMax = Math.max(...press);
check('ring-current pressure field nonzero', pMax > 1 && Number.isFinite(pMax),
    `peak ${pMax.toFixed(1)} nPa`);
check('drift-mode CPCP sane', kd.cpcpKv() > 40 && kd.cpcpKv() < 300,
    `${kd.cpcpKv().toFixed(1)} kV`);
kd.setR2Mode('relaxation');
kd.step(10, 6);
check('mode switch back is safe', Number.isFinite(kd.cpcpKv()));

// Determinism: same history → same frame (seedless kernel).
const k2 = await loadKernel(await readFile(wasmPath));
k2.setControls({ bz: -2, by: 0, vsw: 400, n: 5, f107: 120, tauMin: 20, sapsOn: true });
k2.step(10, 6 * 30);
const k3 = await loadKernel(await readFile(wasmPath));
k3.setControls({ bz: -2, by: 0, vsw: 400, n: 5, f107: 120, tauMin: 20, sapsOn: true });
k3.step(10, 6 * 30);
const a = k2.phiKv(), b = k3.phiKv();
let same = true;
for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
check('deterministic replay', same);

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nshielding-kernel smoke: all checks passed');
