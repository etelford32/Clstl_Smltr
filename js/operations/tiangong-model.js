/**
 * tiangong-model.js — China Manned Space Agency's Tiangong station
 * (NORAD 48274 — Tianhe core module, registered as the whole station).
 *
 * T-shaped three-module configuration since November 2022:
 *
 *           +Y  (along-track / velocity)
 *            │
 *      ┌─────┴─────┐
 *      │  Wentian  │   (one of the lab modules — +X side)
 *      └─────┬─────┘
 *            │
 *      ┌─────┼─────┐   Tianhe = core habitat module, runs along
 *      │  Tianhe   │   the cross-track axis (+X). Crew lives here.
 *      └─────┬─────┘
 *            │
 *      ┌─────┴─────┐
 *      │ Mengtian  │   (other lab module — -X side)
 *      └───────────┘
 *
 * Cylinders shown above are sketches — the real layout is:
 *   - Tianhe runs along velocity (+Y in this model)
 *   - Wentian + Mengtian dock at one node and extend perpendicular
 *     (±X), giving the T silhouette when viewed from zenith.
 *
 * In this rendering we adopt the "T pointing forward" reading:
 *   - Tianhe along +Y (along-track)
 *   - Wentian extends in +X
 *   - Mengtian extends in -X (opposite Wentian)
 *
 * Real dimensions ~ 55 × 39 × 17 m. At MODEL_SCALE_SCENE = 0.012
 * the on-screen body is ~ 290 km wide — smaller than ISS (~680 km),
 * matching the real-world ratio.
 *
 * Each module carries a pair of solar arrays at its far end; we
 * render them as two flat panels per module.
 */

import { newAccum, pushCylinderSide, pushCap, pushBox, finalizeGeometry }
    from './geometry-helpers.js';
import { HeroMesh, buildHeroMaterial } from './hero-mesh.js';

export const TIANGONG_NORAD_ID = 48274;
const MODEL_SCALE_SCENE        = 0.012;
const CYL_SEGMENTS             = 18;

// Pearl-white MLI throughout — Tiangong's modules read as bright
// white in photographs, with darker docking-node accents.
const COL_BODY      = [0.90, 0.90, 0.92];
const COL_END_CAP   = [0.58, 0.58, 0.62];
const COL_NODE      = [0.55, 0.55, 0.58];   // node / docking-port section
const COL_SAW_FRONT = [0.30, 0.42, 0.65];   // blueish — CMSA arrays
const COL_SAW_BACK  = [0.20, 0.18, 0.22];
const COL_SAW_EDGE  = [0.28, 0.28, 0.32];

const TIANHE_R   = 0.22;
const TIANHE_LEN = 1.40;
const LAB_R      = 0.22;
const LAB_LEN    = 1.50;

export function buildTiangongGeometry() {
    const out = newAccum();
    const seg = CYL_SEGMENTS;

    // ── Tianhe core module ──────────────────────────────────────
    // Cylinder along +Y. Caps at both ends; the +Y end is the
    // forward docking hub where Shenzhou + Tianzhou attach. We
    // also drop a small darker collar at the centre to suggest
    // the node where Wentian / Mengtian dock.
    pushCylinderSide(out, TIANHE_R, TIANHE_R, TIANHE_LEN, 0.0, seg, COL_BODY, 'y');
    pushCap(out, TIANHE_R, +TIANHE_LEN / 2, seg, true,  COL_END_CAP, 'y');
    pushCap(out, TIANHE_R, -TIANHE_LEN / 2, seg, false, COL_END_CAP, 'y');

    // Docking node ring at the +Y end (forward), where crew vehicles
    // attach. Slightly larger radius makes a visible collar.
    pushCylinderSide(out, TIANHE_R + 0.02, TIANHE_R + 0.02, 0.08,
                    +TIANHE_LEN / 2 - 0.06, seg, COL_NODE, 'y');

    // Central node collar where the lab modules join. Sits at the
    // Tianhe centre (Y = 0) with slight radius bump.
    pushCylinderSide(out, TIANHE_R + 0.03, TIANHE_R + 0.03, 0.10,
                    0, seg, COL_NODE, 'y');

    // ── Wentian (+X lab) ────────────────────────────────────────
    // Same diameter as Tianhe, extends in +X from the central node.
    // The cylinder is oriented along the X axis using the helper's
    // `axis='x'` mode.
    const wentianCenterX = +TIANHE_R + LAB_LEN / 2 + 0.05;
    pushCylinderSide(out, LAB_R, LAB_R, LAB_LEN, wentianCenterX, seg, COL_BODY, 'x');
    pushCap(out, LAB_R, wentianCenterX + LAB_LEN / 2, seg, true,  COL_END_CAP, 'x');
    pushCap(out, LAB_R, wentianCenterX - LAB_LEN / 2, seg, false, COL_END_CAP, 'x');

    // ── Mengtian (-X lab) ───────────────────────────────────────
    const mengtianCenterX = -(TIANHE_R + LAB_LEN / 2 + 0.05);
    pushCylinderSide(out, LAB_R, LAB_R, LAB_LEN, mengtianCenterX, seg, COL_BODY, 'x');
    pushCap(out, LAB_R, mengtianCenterX + LAB_LEN / 2, seg, true,  COL_END_CAP, 'x');
    pushCap(out, LAB_R, mengtianCenterX - LAB_LEN / 2, seg, false, COL_END_CAP, 'x');

    // ── Solar arrays — three pairs ──────────────────────────────
    // Each module carries two arrays at its far end, oriented in
    // the orbit plane (Y-X plane) extending perpendicular to the
    // module's long axis. Six flat panels total.
    //
    // Real Tiangong arrays are ~12 m long; in model units that's
    // ~0.8 — sized so they read as wings rather than tabs.
    const SAW_LEN = 0.85;
    const SAW_WID = 0.55;
    const SAW_THK = 0.04;
    const sawColors = [
        COL_SAW_EDGE,    // +X
        COL_SAW_EDGE,    // -X
        COL_SAW_EDGE,    // +Y
        COL_SAW_EDGE,    // -Y
        COL_SAW_FRONT,   // +Z
        COL_SAW_BACK,    // -Z
    ];

    // Tianhe (along-track): arrays at the aft end, extending ±X.
    pushBox(out, -(TIANHE_R + 0.02 + SAW_LEN / 2), -TIANHE_LEN / 2 + 0.10, 0,
            SAW_LEN, SAW_WID, SAW_THK, sawColors);
    pushBox(out,  (TIANHE_R + 0.02 + SAW_LEN / 2), -TIANHE_LEN / 2 + 0.10, 0,
            SAW_LEN, SAW_WID, SAW_THK, sawColors);

    // Wentian: arrays at the +X tip, extending ±Y.
    const wTipX = wentianCenterX + LAB_LEN / 2 + 0.05;
    pushBox(out, wTipX + SAW_WID / 2, +(LAB_R + 0.02 + SAW_LEN / 2), 0,
            SAW_WID, SAW_LEN, SAW_THK, sawColors);
    pushBox(out, wTipX + SAW_WID / 2, -(LAB_R + 0.02 + SAW_LEN / 2), 0,
            SAW_WID, SAW_LEN, SAW_THK, sawColors);

    // Mengtian: arrays at the -X tip, extending ±Y.
    const mTipX = mengtianCenterX - LAB_LEN / 2 - 0.05;
    pushBox(out, mTipX - SAW_WID / 2, +(LAB_R + 0.02 + SAW_LEN / 2), 0,
            SAW_WID, SAW_LEN, SAW_THK, sawColors);
    pushBox(out, mTipX - SAW_WID / 2, -(LAB_R + 0.02 + SAW_LEN / 2), 0,
            SAW_WID, SAW_LEN, SAW_THK, sawColors);

    return finalizeGeometry(out);
}

export function createTiangongModel(globe, tracker) {
    return new HeroMesh(globe, tracker, {
        norad:      TIANGONG_NORAD_ID,
        geometry:   buildTiangongGeometry(),
        material:   buildHeroMaterial({ roughness: 0.55, metalness: 0.12 }),
        modelScale: MODEL_SCALE_SCENE,
        name:       'tiangong',
        // No tumble — Tiangong is actively attitude-controlled.
    });
}
