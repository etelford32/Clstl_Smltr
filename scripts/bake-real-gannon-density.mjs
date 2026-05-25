#!/usr/bin/env node
/**
 * bake-real-gannon-density.mjs — recompute msis_apreal from real Ap + F10.7
 * ═══════════════════════════════════════════════════════════════════════════
 * Replaces `drivers_compact.density_400km.msis_apreal` in
 * data/hindcast/gannon_may_2024_replay.json with values computed by
 * the page's canonical client-side density surrogate
 * (js/upper-atmosphere-engine.js → density()), driven sample-by-sample
 * by the REAL GFZ Ap and REAL GFZ F10.7 already baked into the bundle.
 *
 * The other two density tracks — msis_apmhd and msis_apgnd — stay as
 * hand-authored placeholders. They depend on BATS-R-US derived
 * Φ_PC + HPI surrogate Ap streams, which we don't have yet. Letting
 * msis_apreal land on empirical-driver values while the surrogates
 * stay hand-authored preserves the page's saturation/recovery story
 * (the "MHD surrogate sees more drag than capped Ap") AND removes the
 * placeholder mark from the baseline track.
 *
 * Idempotent — running twice produces the same numerical result.
 *
 * Prereqs:
 *   - drivers_compact.ap_real      already REAL GFZ (run bake-real-gannon-ap.mjs first)
 *   - drivers_compact.f107_daily   already REAL GFZ F10.7 (same)
 *
 * Usage: node scripts/bake-real-gannon-density.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { density } from "../js/upper-atmosphere-engine.js";

const BUNDLE_PATH = resolve("data/hindcast/gannon_may_2024_replay.json");
const TARGET_ALT_KM = 400;        // matches density_400km.* contract

function main() {
    const bundle = JSON.parse(readFileSync(BUNDLE_PATH, "utf8"));
    const dc = bundle.drivers_compact;
    const d400 = bundle.density_400km;
    const n = dc.ap_real.length;

    if (!Array.isArray(dc.ap_real) || !Array.isArray(dc.f107_daily)) {
        throw new Error("bundle missing real ap_real or f107_daily — run bake-real-gannon-ap.mjs first");
    }
    if (dc.f107_daily.length !== n) {
        throw new Error(`f107_daily length ${dc.f107_daily.length} != ap_real length ${n}`);
    }
    if (d400.msis_apreal.length !== n) {
        throw new Error(`msis_apreal length ${d400.msis_apreal.length} != ap_real length ${n}`);
    }

    const oldArr = d400.msis_apreal.slice();
    const newArr = new Array(n);
    for (let i = 0; i < n; i++) {
        const { rho } = density({
            altitudeKm: TARGET_ALT_KM,
            f107Sfu:    dc.f107_daily[i],
            ap:         dc.ap_real[i],
        });
        // Round to 4 sig figs to keep JSON tidy without losing fidelity.
        newArr[i] = Number(rho.toPrecision(4));
    }

    d400.msis_apreal = newArr;

    bundle.provenance = bundle.provenance || {};
    bundle.provenance.msis_apreal =
        `REAL — density(altitudeKm=${TARGET_ALT_KM}, f107=f107_daily, ap=ap_real) ` +
        `via js/upper-atmosphere-engine.js Jacchia-style surrogate`;

    // Sanity log.
    const oldPeak = Math.max(...oldArr);
    const newPeak = Math.max(...newArr);
    const oldBase = oldArr[0];
    const newBase = newArr[0];
    const oldStorm = oldArr[Math.round((12 - (-60)) * 1)];  // bundle is hourly; h=12 is index 72
    const newStorm = newArr[Math.round((12 - (-60)) * 1)];

    writeFileSync(BUNDLE_PATH, JSON.stringify(bundle, null, 0) + "\n");

    console.log(`wrote ${BUNDLE_PATH}`);
    console.log(`  msis_apreal (×10⁻¹² kg/m³):`);
    console.log(`    quiet baseline  (h=-60):  ${(oldBase*1e12).toFixed(2)} (placeholder) → ${(newBase*1e12).toFixed(2)} (real-driver)`);
    console.log(`    storm peak 1    (h=12):   ${(oldStorm*1e12).toFixed(2)} (placeholder) → ${(newStorm*1e12).toFixed(2)} (real-driver)`);
    console.log(`    max over window:           ${(oldPeak*1e12).toFixed(2)} (placeholder) → ${(newPeak*1e12).toFixed(2)} (real-driver)`);
    console.log(`  provenance.msis_apreal = ${bundle.provenance.msis_apreal}`);
}

main();
