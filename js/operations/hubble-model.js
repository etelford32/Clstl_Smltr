/**
 * hubble-model.js — Hubble Space Telescope (NORAD 20580).
 *
 * Hubble's body is a 13-m cylinder with two flat fixed solar arrays
 * extending sideways and a forward aperture door. The high-gain
 * antennas hang off two booms on the sun side; we render them as
 * tiny accent boxes since they'd otherwise be invisible at orbital-
 * overview zoom.
 *
 * Composition (model units, MODEL_SCALE_SCENE = 0.010 → ~ 85 km
 * total visual span):
 *
 *   - Main optical-telescope-assembly cylinder
 *       r = 0.21, length 1.32 along +Y (along-track / boresight)
 *
 *   - Closed aperture door at +Y end
 *       slightly larger disc (r 0.23) for a visible cap edge
 *
 *   - Two solar arrays — fixed, perpendicular to body, extending
 *     in ±X from the mid-body
 *       Each 1.20 × 0.65 × 0.04, root just outside the body radius
 *
 *   - Two high-gain antenna booms (HGA1, HGA2) — thin sticks
 *     dropping in -Z from forward/aft of the body
 *
 * Operationally Hubble points its boresight (+Y in this model) at
 * its observing target — NOT necessarily along the orbital velocity
 * vector. The LVLH-aligned pose we render is the convenient default
 * for the visualization; an accurate body-frame would require
 * pulling pointing schedules from STScI, which is beyond scope.
 */

import { newAccum, pushBox, pushCylinderSide, pushCap, finalizeGeometry }
    from './geometry-helpers.js';
import { HeroMesh, buildHeroMaterial } from './hero-mesh.js';

export const HUBBLE_NORAD_ID = 20580;
const MODEL_SCALE_SCENE      = 0.010;
const CYL_SEGMENTS           = 18;

const COL_OTA          = [0.82, 0.82, 0.85];   // silver MLI body
const COL_OTA_END      = [0.60, 0.60, 0.63];   // forward / aft caps
const COL_APERTURE     = [0.20, 0.22, 0.26];   // closed aperture door — dark
const COL_SAW_FRONT    = [0.55, 0.60, 0.30];   // dark-olive cell side
const COL_SAW_BACK     = [0.34, 0.30, 0.16];
const COL_SAW_EDGE     = [0.30, 0.28, 0.24];
const COL_ANTENNA      = [0.50, 0.50, 0.48];

export function buildHubbleGeometry() {
    const out = newAccum();
    const seg = CYL_SEGMENTS;

    // ── Main OTA cylinder ────────────────────────────────────────
    // Length 1.32 along the local +Y axis; -Y end is the aft
    // bulkhead, +Y end is the aperture.
    pushCylinderSide(out, 0.21, 0.21, 1.32, 0.0, seg, COL_OTA, 'y');
    pushCap(out, 0.21, -0.66, seg, false, COL_OTA_END, 'y');

    // ── Aperture door (closed) ───────────────────────────────────
    // A slightly bigger disc at the +Y end with a darker tint reads
    // as the closed door against the silver MLI. We also push a
    // shallow rim by stacking a thin cylinder side; this gives the
    // forward face a slight bevel.
    pushCylinderSide(out, 0.23, 0.23, 0.04, 0.68, seg, COL_APERTURE, 'y');
    pushCap(out, 0.23, +0.70, seg, true, COL_APERTURE, 'y');

    // ── Solar arrays ─────────────────────────────────────────────
    // Two fixed panels extending in ±X from the body. Each is
    // centred at X ≈ ±0.85 (outside the body radius), thin in Z so
    // they read as flat plates.
    const SAW_SX = 1.20, SAW_SY = 0.65, SAW_SZ = 0.04;
    const SAW_OFFSET = 0.21 + SAW_SX / 2 + 0.02;
    const sawColors = [
        COL_SAW_EDGE,    // +X (tip)
        COL_SAW_EDGE,    // -X (root meeting body)
        COL_SAW_EDGE,    // +Y
        COL_SAW_EDGE,    // -Y
        COL_SAW_FRONT,   // +Z (cell side)
        COL_SAW_BACK,    // -Z (rear)
    ];
    pushBox(out, +SAW_OFFSET, 0, 0, SAW_SX, SAW_SY, SAW_SZ, sawColors);
    pushBox(out, -SAW_OFFSET, 0, 0, SAW_SX, SAW_SY, SAW_SZ, sawColors);

    // ── High-gain antenna booms ──────────────────────────────────
    // Small accent boxes pointing -Z (nadir-side) from forward and
    // aft sections of the body. Not to scale, but they help the
    // body silhouette read as "telescope with extra bits", not
    // "another rocket body".
    const antColors = [
        COL_ANTENNA, COL_ANTENNA, COL_ANTENNA, COL_ANTENNA, COL_ANTENNA, COL_ANTENNA,
    ];
    pushBox(out, 0, +0.45, -0.28, 0.06, 0.06, 0.30, antColors);
    pushBox(out, 0, -0.45, -0.28, 0.06, 0.06, 0.30, antColors);

    return finalizeGeometry(out);
}

export function createHubbleModel(globe, tracker) {
    return new HeroMesh(globe, tracker, {
        norad:      HUBBLE_NORAD_ID,
        geometry:   buildHubbleGeometry(),
        material:   buildHeroMaterial({ roughness: 0.50, metalness: 0.18 }),
        modelScale: MODEL_SCALE_SCENE,
        name:       'hubble',
        // No tumble — Hubble is actively pointing-controlled.
    });
}
