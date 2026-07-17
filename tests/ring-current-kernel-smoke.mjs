// ring-current-kernel-smoke.mjs — drives the COMMITTED ring-current WASM
// binary and the JS reference module (js/ring-current-transport.js) through an
// IDENTICAL driver history, and asserts they agree. This is the oracle gate:
// the JS module is the reference, the Rust/WASM kernel is the runtime, and this
// test fails if the port drifts, if someone rebuilds the kernel without
// committing the wasm, or if the extern-C surface drifts from the JS wrapper.
//
//   node tests/ring-current-kernel-smoke.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadRingCurrentKernel } from '../js/ring-current-kernel.js';
import { RingCurrentTransport } from '../js/ring-current-transport.js';

const wasmPath = fileURLToPath(new URL('../js/ring-current-wasm/ring_current_kernel.wasm', import.meta.url));

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-30, Math.abs(b));
const peak = (arr) => { let m = 0; for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i]; return m; };
const maxAbsDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

const wasm = await loadRingCurrentKernel(await readFile(wasmPath));
const js = new RingCurrentTransport();

// ── Grid metadata parity ─────────────────────────────────────────────────────
check('grid shape matches JS',
    wasm.nL === js.nL && wasm.nMlt === js.nMlt && wasm.nE === js.nE,
    `${wasm.nL}×${wasm.nMlt}×${wasm.nE}`);
check('L range matches JS',
    rel(wasm.lMin, js.cfg.lMin) < 1e-12 && rel(wasm.lMax, js.cfg.lMax) < 1e-12,
    `${wasm.lMin}..${wasm.lMax}`);

// ── Identical storm history on both ──────────────────────────────────────────
wasm.setDriver({ kp: 7, vbs: 8 });
js.setDriver({ kp: 7, vbs: 8 });
for (let h = 0; h < 6; h++) { wasm.step(3600); js.step(3600); }

const dW = wasm.dstStar(), dJ = js.dstStar();
check('storm Dst* agrees (<1%)', rel(dW, dJ) < 0.01, `wasm ${dW.toFixed(2)} vs js ${dJ.toFixed(2)} nT`);
check('storm Dst* is a real main phase', dW < -20, `${dW.toFixed(1)} nT`);
check('energy content agrees (<1%)', rel(wasm.energyContentJ(), js.energyContentJ()) < 0.01,
    `Δ ${(rel(wasm.energyContentJ(), js.energyContentJ()) * 100).toFixed(3)}%`);
check('O⁺ fraction agrees (<1%)', rel(wasm.oxygenFraction(), js.speciesEnergyJ().oxygenFraction) < 0.01,
    `wasm ${wasm.oxygenFraction().toFixed(3)} vs js ${js.speciesEnergyJ().oxygenFraction.toFixed(3)}`);

// Pressure field parity (peak + full-map max diff, normalised to peak).
const pW = wasm.pressureMap('all'), pJ = js.pressureMap('all');
const pkW = peak(pW), pkJ = peak(pJ);
check('peak P⊥ agrees (<2%)', rel(pkW, pkJ) < 0.02, `wasm ${pkW.toFixed(2)} vs js ${pkJ.toFixed(2)} nPa`);
check('pressure map matches everywhere (<2% of peak)', maxAbsDiff(pW, pJ) < 0.02 * pkJ,
    `max Δ ${(maxAbsDiff(pW, pJ) / pkJ * 100).toFixed(3)}% of peak`);

// O⁺-only pressure parity (exercises the species selector).
const oW = wasm.pressureMap('oxygen'), oJ = js.pressureMap('oxygen');
check('O⁺ pressure map matches (<2% of peak)', maxAbsDiff(oW, oJ) < 0.02 * peak(oJ),
    `max Δ ${(maxAbsDiff(oW, oJ) / peak(oJ) * 100).toFixed(3)}% of peak`);

// ENA emissivity parity.
const eW = wasm.enaEmissivityMap(), eJ = js.enaEmissivityMap();
check('ENA emissivity peak agrees (<2%)', rel(peak(eW), peak(eJ)) < 0.02,
    `Δ ${(rel(peak(eW), peak(eJ)) * 100).toFixed(3)}%`);
check('ENA map matches everywhere (<2% of peak)', maxAbsDiff(eW, eJ) < 0.02 * peak(eJ),
    `max Δ ${(maxAbsDiff(eW, eJ) / peak(eJ) * 100).toFixed(3)}% of peak`);

// EMIC precipitation + anisotropy parity (the pitch-angle-moment surface).
const prW = wasm.emicPrecipitationMap(), prJ = js.emicPrecipitationMap();
check('EMIC precip map is live in the storm', peak(prJ) > 0, `js peak ${peak(prJ).toExponential(2)}`);
check('EMIC precip map matches (<2% of peak)', maxAbsDiff(prW, prJ) < 0.02 * peak(prJ),
    `max Δ ${(maxAbsDiff(prW, prJ) / (peak(prJ) || 1) * 100).toFixed(3)}% of peak`);
const aW = wasm.anisotropyMap(), aJ = js.anisotropyMap();
check('anisotropy map matches (<2% of peak)', maxAbsDiff(aW, aJ) < 0.02 * Math.max(peak(aJ), 0.1),
    `max Δ ${maxAbsDiff(aW, aJ).toExponential(2)} (peak ${peak(aJ).toFixed(3)})`);
const gW = wasm.emicWaveGateMap(), gJ = js.emicWaveGateMap();
check('wave-gate map matches (<2%)', maxAbsDiff(gW, gJ) < 0.02,
    `max Δ ${maxAbsDiff(gW, gJ).toExponential(2)} (peak ${peak(gJ).toFixed(3)})`);

// ── Recovery step still tracks ───────────────────────────────────────────────
wasm.setDriver({ kp: 1, vbs: 0 });
js.setDriver({ kp: 1, vbs: 0 });
for (let h = 0; h < 8; h++) { wasm.step(3600); js.step(3600); }
check('recovery Dst* agrees (<1.5%)', rel(wasm.dstStar(), js.dstStar()) < 0.015,
    `wasm ${wasm.dstStar().toFixed(1)} vs js ${js.dstStar().toFixed(1)} nT`);
check('Dst* recovered toward zero', wasm.dstStar() > dW);

// ── Determinism of the WASM kernel ───────────────────────────────────────────
const k2 = await loadRingCurrentKernel(await readFile(wasmPath));
const k3 = await loadRingCurrentKernel(await readFile(wasmPath));
for (const k of [k2, k3]) { k.setDriver({ kp: 6, vbs: 5 }); for (let h = 0; h < 4; h++) k.step(3600); }
check('deterministic replay', k2.dstStar() === k3.dstStar(),
    `${k2.dstStar().toFixed(6)}`);

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nring-current-kernel smoke: all checks passed (WASM ↔ JS oracle agree)');
