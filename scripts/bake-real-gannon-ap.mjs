#!/usr/bin/env node
/**
 * bake-real-gannon-ap.mjs — fold real GFZ Ap + F10.7 into the bundle
 * ═══════════════════════════════════════════════════════════════════════
 * Replaces the hand-authored `drivers_compact.ap_real` in
 * data/hindcast/gannon_may_2024_replay.json with the actual GFZ
 * definitive Ap series for May 8-14 2024, sampled at the bundle's
 * hourly grid via step-after resampling (Ap is 3-hourly).
 *
 * Source CSV: dsmc/fixtures/hindcast/gannon_may_2024/historical_ap.csv
 *   columns: t (UTC ISO), ap (3-hour index), f107_sfu (daily 10.7 cm flux)
 *
 * Also records the per-day F10.7 (`drivers_compact.f107_daily`) so the
 * Sun-Earth panel's "solar context" annotation and any future MSIS
 * recompute have the real values.
 *
 * Other arrays (ap_mhd, ap_gnd, phi_pc_kv, hpi_gw, sme_nt, bz_nt,
 * v_kms, density_400km.*) remain hand-authored placeholder until
 * BATS-R-US output + OMNI 1-min IMF land. _is_placeholder stays true.
 *
 * Idempotent — running twice produces the same numerical result.
 *
 * Usage: node scripts/bake-real-gannon-ap.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BUNDLE_PATH = resolve("data/hindcast/gannon_may_2024_replay.json");
const AP_CSV_PATH = resolve("dsmc/fixtures/hindcast/gannon_may_2024/historical_ap.csv");

function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(L => L.trim() && !L.startsWith("#"));
    const headers = lines[0].split(",").map(s => s.trim());
    return lines.slice(1).map(L => {
        const fields = L.split(",").map(s => s.trim());
        return Object.fromEntries(headers.map((h, i) => [h, fields[i]]));
    });
}

function main() {
    const bundle = JSON.parse(readFileSync(BUNDLE_PATH, "utf8"));
    const win = bundle.window;
    const t0Ms     = Date.parse(win.start);
    const anchorMs = Date.parse(win.anchor_iso || win.start);
    const stepMs   = (win.step_minutes || 60) * 60_000;
    const hoursMin = (t0Ms - anchorMs) / 3600_000;
    const nSamples = bundle.drivers_compact.ap_real.length;

    // Load + parse the GFZ CSV.
    const rows = parseCsv(readFileSync(AP_CSV_PATH, "utf8"))
        .map(r => ({
            tMs: Date.parse(r.t),
            ap:  Number(r.ap),
            f107: Number(r.f107_sfu),
        }))
        .filter(r => Number.isFinite(r.ap))
        .sort((a, b) => a.tMs - b.tMs);

    if (rows.length === 0) throw new Error("no ap rows parsed");

    // Step-after resample onto the bundle's grid. For each bundle sample
    // at h ∈ [hoursMin, hoursMin + (n-1)*stepH], find the latest GFZ row
    // with t <= sample_t and use its ap.
    function lookup(tMs) {
        let lastAp = rows[0].ap;
        for (const r of rows) {
            if (r.tMs > tMs) break;
            lastAp = r.ap;
        }
        return lastAp;
    }
    function lookupF107(tMs) {
        let lastF = rows[0].f107;
        for (const r of rows) {
            if (r.tMs > tMs) break;
            if (Number.isFinite(r.f107)) lastF = r.f107;
        }
        return lastF;
    }

    const ap_real_new = [];
    const f107_daily  = [];
    for (let i = 0; i < nSamples; i++) {
        const tMs = t0Ms + i * stepMs;
        ap_real_new.push(lookup(tMs));
        f107_daily.push(lookupF107(tMs));
    }

    // Sanity log
    const oldPeak = Math.max(...bundle.drivers_compact.ap_real);
    const newPeak = Math.max(...ap_real_new);
    const newSatCount = ap_real_new.filter(v => v >= 400).length;

    bundle.drivers_compact.ap_real = ap_real_new;
    bundle.drivers_compact.f107_daily = f107_daily;
    // Light annotation so reviewers can see what's now real.
    bundle.drivers_compact._format = (bundle.drivers_compact._format || "") +
        " · ap_real reflects real GFZ Kp_ap_Ap_SN_F107 (3-hour cadence, step-after-resampled).";

    bundle.provenance = bundle.provenance || {};
    bundle.provenance.ap = `REAL — GFZ Kp_ap_Ap_SN_F107 via ${AP_CSV_PATH.replace(/^.*\/dsmc/, 'dsmc')}`;
    bundle.provenance.f107 = `REAL — GFZ Kp_ap_Ap_SN_F107 (F10.7_obs column)`;

    writeFileSync(BUNDLE_PATH, JSON.stringify(bundle, null, 0) + "\n");

    console.log(`wrote ${BUNDLE_PATH}`);
    console.log(`  ap_real peak: ${oldPeak} (hand-authored) → ${newPeak} (real GFZ)`);
    console.log(`  Ap=400 saturation bins: ${newSatCount} (hours)`);
    console.log(`  F10.7 range (real, daily): ${Math.min(...f107_daily.filter(Number.isFinite))} – ${Math.max(...f107_daily.filter(Number.isFinite))} sfu`);
    console.log(`  provenance.ap = ${bundle.provenance.ap}`);
}

main();
