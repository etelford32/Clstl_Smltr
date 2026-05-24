#!/usr/bin/env node
/**
 * extend-gannon-window.mjs — extend the Gannon replay bundle backwards
 * ═══════════════════════════════════════════════════════════════════════
 * Takes data/hindcast/gannon_may_2024_replay.json (72 h, May 10 12:00 UT
 * onward) and rewrites it to cover 132 h starting May 8 00:00 UT so the
 * Sun→Earth case-study visualization can show the Gannon CMEs in transit
 * across May 8-10.
 *
 * Design choice — h=0 stays anchored at May 10 12:00 UT
 * ─────────────────────────────────────────────────────
 * Every existing reference (SSC at h=5.08, phase boundaries at 8/30,
 * narration moments, truth-observation `h` values, peak Ap_mhd, the
 * RMSE skill numbers) is keyed to h=0 = window.start of the previous
 * bundle. Re-anchoring h=0 to May 8 would shift all of those by +60
 * and require touching every chart, the narration, the residuals
 * computation, and the test fixtures. Instead, the scrubber's domain
 * becomes [-60, 72] and we prepend 60 *negative-hour* samples; all
 * existing positive-hour data stays bit-identical.
 *
 * Preroll values are quiet-baseline placeholders that ramp into the
 * existing hand-authored h=0 anchor smoothly. They keep `_is_placeholder`
 * true (which is sticky until BATS-R-US output lands real numbers).
 *
 * Adds top-level `cme_events[]` — five canonical Gannon CMEs with
 * launch UT, X-class, v₀, source helio-latitude/-longitude, and
 * arrival UT. These drive the 3D Sun-Earth panel's CME meshes via
 * the existing js/cme-propagation.js drag-based-model trajectory math.
 *
 * Usage:
 *   node scripts/extend-gannon-window.mjs
 *
 * Idempotent — running twice still leaves the bundle at the same 133-sample
 * shape. Output written in-place to the bundle path.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BUNDLE_PATH = resolve("data/hindcast/gannon_may_2024_replay.json");

// ── target window (h=0 stays at May 10 12:00 UT) ───────────────────
const NEW_START_ISO = "2024-05-08T00:00:00Z";
const NEW_END_ISO   = "2024-05-13T12:00:00Z";
const STEP_MIN      = 60;

// Hours-from-old-start (the new h coord) at which the new arrays begin.
// New start is 60 h *before* the old start, so the first new sample is at h=-60.
const PREROLL_HOURS = 60;

// ── canonical Gannon CME catalog ───────────────────────────────────
// Sources: NOAA SWPC event tables + GOES X-ray flux logs.
// v₀ from CACTus/SOHO LASCO C2 inversions where available; the
// May-2024 cluster's v₀ values were unusually high (1500-1900 km/s).
// Helio coords from AR 13664's drift position during the active week.
const CME_EVENTS = [
    {
        id:           "cme1",
        label:        "X1.0 flare · AR 13664",
        flare_class:  "X1.0",
        launch_iso:   "2024-05-08T05:09:00Z",
        v0_kms:       1500,
        src_lat_deg:  14,           // AR 13664 northern hemisphere
        src_lon_deg:  -22,          // east limb on May 8
        notes:        "First X-class flare of the May 2024 cluster.",
    },
    {
        id:           "cme2",
        label:        "X1.0 flare · 21:08 UT",
        flare_class:  "X1.0",
        launch_iso:   "2024-05-08T21:08:00Z",
        v0_kms:       1500,
        src_lat_deg:  14,
        src_lon_deg:  -10,
        notes:        "Second X-class — full halo CME, central trajectory toward Earth.",
    },
    {
        id:           "cme3",
        label:        "X2.2 flare · the SSC progenitor",
        flare_class:  "X2.2",
        launch_iso:   "2024-05-09T17:23:00Z",
        v0_kms:       1900,
        src_lat_deg:  12,
        src_lon_deg:  0,            // straight at Earth
        notes:        "The shock that hit DSCOVR at 17:05 UT May 10 (h=+5.08). Halo + west-limb trajectory geometry.",
    },
    {
        id:           "cme4",
        label:        "X3.9 flare · reinforcement",
        flare_class:  "X3.9",
        launch_iso:   "2024-05-10T06:54:00Z",
        v0_kms:       1820,
        src_lat_deg:  11,
        src_lon_deg:  8,
        notes:        "Compound-CME pile-up reinforcement. Arrived during the storm peak.",
    },
    {
        id:           "cme5",
        label:        "X5.8 flare · recovery-phase",
        flare_class:  "X5.8",
        launch_iso:   "2024-05-11T01:30:00Z",
        v0_kms:       1500,
        src_lat_deg:  10,
        src_lon_deg:  20,
        notes:        "Largest X-class of the cluster but launched mid-storm — extends recovery phase.",
    },
];

// ── preroll-value generators (quiet-baseline placeholders) ─────────
//
// Strategy: each variable's preroll is a smooth curve that meets the
// existing h=0 value continuously (so the chart traces don't show a
// discontinuity at h=0). The shape is "near-quiet" with mild bumps
// near CME launch times — purely cosmetic; real data will replace.

function buildPrerollAp(h_arr, h0_existing_value) {
    // Real Ap stays mostly quiet during May 8-9 (the storm wasn't yet
    // at Earth). Couple of small bumps near the launch times.
    return h_arr.map(h => {
        const dist_to_cme3 = Math.abs(h - (-18.62));   // X2.2 launch
        const dist_to_cme4 = Math.abs(h - (-5.10));    // X3.9 launch
        // Closer to h=0 we ramp gently toward the existing h=0 value.
        const ramp = Math.max(0, 1 - (-h) / PREROLL_HOURS);
        const base = 3 + 2 * ramp;
        // Small bumps from minor flares that preceded the X-class events.
        const bump1 = 1.5 * Math.exp(-dist_to_cme3 / 4);
        const bump2 = 1.0 * Math.exp(-dist_to_cme4 / 3);
        return Math.round(base + bump1 + bump2);
    });
}

function buildPrerollBz(h_arr) {
    return h_arr.map(h => {
        // Quiet IMF, slight southward turn near each X-class launch.
        const distCme3 = Math.abs(h - (-18.62));
        const distCme4 = Math.abs(h - (-5.10));
        const noise = Math.sin(h * 0.3) * 1.5;
        const dip   = -3 * Math.exp(-distCme3 / 3) - 4 * Math.exp(-distCme4 / 2);
        return round1(noise + dip);
    });
}

function buildPrerollVsw(h_arr, h0_existing_value) {
    // Background solar wind 350-450 km/s. Slight enhancement after
    // earlier CMEs cleared the path (forward-shock pre-conditioning).
    return h_arr.map(h => {
        const ramp_to_anchor = Math.max(0, 1 - (-h) / 12);   // last 12 h ramp into h=0
        const post_cme3 = sigmoid((h + 18.62) / 3) * 30;     // small bump after CME-3 launch
        const post_cme4 = sigmoid((h + 5.10)  / 2) * 50;     // bump after CME-4 launch
        const val = 370 + post_cme3 + post_cme4
                  + ramp_to_anchor * (h0_existing_value - 420);
        return Math.round(val);
    });
}

function buildPrerollPhiPc(h_arr, h0_existing_value) {
    return h_arr.map(h => {
        const ramp = Math.max(0, 1 - (-h) / 10);
        const base = 12;
        return round1(base + ramp * (h0_existing_value - base));
    });
}

function buildPrerollHpi(h_arr, h0_existing_value) {
    return h_arr.map(h => {
        const ramp = Math.max(0, 1 - (-h) / 10);
        const base = 8;
        return round1(base + ramp * (h0_existing_value - base));
    });
}

function buildPrerollSme(h_arr, h0_existing_value) {
    // Quiet auroral baseline ~150 nT, mild enhancements near CME launches.
    return h_arr.map(h => {
        const distCme3 = Math.abs(h - (-18.62));
        const distCme4 = Math.abs(h - (-5.10));
        const ramp = Math.max(0, 1 - (-h) / 8);
        const base = 120 + 60 * Math.exp(-distCme3 / 3) + 80 * Math.exp(-distCme4 / 2);
        return Math.round(base + ramp * (h0_existing_value - base));
    });
}

function buildPrerollDensity(h_arr, h0_existing_value) {
    // Quiet thermosphere baseline ~2.7×10⁻¹² kg/m³ for Gannon-era F10.7.
    // Ramp smoothly into the existing h=0 anchor.
    return h_arr.map(h => {
        const ramp = Math.max(0, 1 - (-h) / 10);
        const base = 2.7e-12;
        return base + ramp * (h0_existing_value - base);
    });
}

// ── helpers ────────────────────────────────────────────────────────

function round1(x) { return Math.round(x * 10) / 10; }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// ── main ───────────────────────────────────────────────────────────

function main() {
    const bundle = JSON.parse(readFileSync(BUNDLE_PATH, "utf8"));

    // Idempotency check — if already extended, no-op.
    if (bundle.window?.start === NEW_START_ISO &&
        Array.isArray(bundle.drivers_compact?.ap_real) &&
        bundle.drivers_compact.ap_real.length === 133) {
        console.log("bundle already extended; no changes written.");
        return;
    }

    // Preroll hours grid: h = -60, -59, ..., -1   (60 samples).
    const preroll_hours = [];
    for (let h = -PREROLL_HOURS; h < 0; h++) preroll_hours.push(h);

    const dc = bundle.drivers_compact;
    const dn = bundle.density_400km;

    // Fix one pre-existing data bug while we're here: bz_nt was 74
    // entries while everything else was 73. Trim to 73 before we prepend.
    if (Array.isArray(dc.bz_nt) && dc.bz_nt.length === 74) {
        dc.bz_nt = dc.bz_nt.slice(0, 73);
    }

    // Build preroll arrays — each ends at h=-1 (just before the
    // existing h=0 anchor value). The h=0 anchors stay untouched.
    const preroll_ap_real  = buildPrerollAp(preroll_hours, dc.ap_real[0]);
    const preroll_ap_mhd   = buildPrerollAp(preroll_hours, dc.ap_mhd[0]);
    const preroll_ap_gnd   = buildPrerollAp(preroll_hours, dc.ap_gnd[0]);
    const preroll_phi      = buildPrerollPhiPc(preroll_hours, dc.phi_pc_kv[0]);
    const preroll_hpi      = buildPrerollHpi(preroll_hours, dc.hpi_gw[0]);
    const preroll_sme      = buildPrerollSme(preroll_hours, dc.sme_nt[0]);
    const preroll_bz       = buildPrerollBz(preroll_hours);
    const preroll_vsw      = buildPrerollVsw(preroll_hours, dc.v_kms[0]);
    const preroll_dr_real  = buildPrerollDensity(preroll_hours, dn.msis_apreal[0]);
    const preroll_dr_mhd   = buildPrerollDensity(preroll_hours, dn.msis_apmhd[0]);
    const preroll_dr_gnd   = buildPrerollDensity(preroll_hours, dn.msis_apgnd[0]);

    bundle.window = {
        start:        NEW_START_ISO,
        end:          NEW_END_ISO,
        step_minutes: STEP_MIN,
        // Anchor preserved: existing h-coords still measured from this.
        anchor_iso:   "2024-05-10T12:00:00Z",
        anchor_h:     0,
    };

    bundle.drivers_compact.ap_real    = [...preroll_ap_real,  ...dc.ap_real];
    bundle.drivers_compact.ap_mhd     = [...preroll_ap_mhd,   ...dc.ap_mhd];
    bundle.drivers_compact.ap_gnd     = [...preroll_ap_gnd,   ...dc.ap_gnd];
    bundle.drivers_compact.phi_pc_kv  = [...preroll_phi,      ...dc.phi_pc_kv];
    bundle.drivers_compact.hpi_gw     = [...preroll_hpi,      ...dc.hpi_gw];
    bundle.drivers_compact.sme_nt     = [...preroll_sme,      ...dc.sme_nt];
    bundle.drivers_compact.bz_nt      = [...preroll_bz,       ...dc.bz_nt];
    bundle.drivers_compact.v_kms      = [...preroll_vsw,      ...dc.v_kms];
    bundle.density_400km.msis_apreal  = [...preroll_dr_real,  ...dn.msis_apreal];
    bundle.density_400km.msis_apmhd   = [...preroll_dr_mhd,   ...dn.msis_apmhd];
    bundle.density_400km.msis_apgnd   = [...preroll_dr_gnd,   ...dn.msis_apgnd];

    // The compact-format note now mentions the negative-h range.
    bundle.drivers_compact._format =
        `Each array is sampled at window.start + i * step_minutes, length ${bundle.drivers_compact.ap_real.length} ` +
        `(132 h inclusive). Indices 0..59 are preroll (May 8 00:00 → May 10 11:00 UT, h=-60..-1); ` +
        `indices 60..132 are the original 72-h ground-truth window (h=0..72) anchored at May 10 12:00 UT.`;

    // Catalog the CMEs that drive the 3D Sun-Earth panel.
    bundle.cme_events = CME_EVENTS;

    // _warning stays — bundle is still placeholder until BATS-R-US lands.
    // Add a note about the extension so reviewers don't miss what changed.
    bundle._extension_note =
        "Window extended backwards from 72 h to 132 h to cover the May 8-10 CME launches. " +
        "Preroll arrays (indices 0..59) are quiet-baseline placeholders that ramp into the " +
        "existing h=0 anchor; the original 72 h block (indices 60..132) is bit-identical to " +
        "the pre-extension bundle. cme_events[] catalogs the canonical Gannon CMEs for the " +
        "Sun-Earth visualization layer.";

    writeFileSync(BUNDLE_PATH, JSON.stringify(bundle, null, 0) + "\n");

    console.log(`wrote ${BUNDLE_PATH}`);
    console.log(`  window: ${NEW_START_ISO} → ${NEW_END_ISO}`);
    console.log(`  ap_real length: ${bundle.drivers_compact.ap_real.length}`);
    console.log(`  cme_events: ${bundle.cme_events.length}`);
}

main();
