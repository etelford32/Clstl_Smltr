/**
 * iss-model.js — International Space Station (NORAD 25544).
 *
 * The marquee piece of the hero-mesh fleet. ISS's silhouette is
 * unmistakable: long cross-track truss, perpendicular pressurized-
 * module spine, four SAW pairs at the truss tips, white radiator
 * panels stuck to the truss.
 *
 * Real dimensions are roughly 109 × 73 × 30 m. At our hero scale
 * (MODEL_SCALE_SCENE = 0.010) the on-screen body lands at ~680 km
 * across — comfortably the largest object on the globe and easily
 * the most visually busy.
 *
 * Composition (model units, fully deployed):
 *
 *   - Integrated Truss Structure (S-/P-segments combined)
 *       10.0 along +X (cross-track), 0.55 along +Y, 0.32 along +Z
 *
 *   - Pressurized module stack (Zarya → Cupola; rendered as a
 *     single along-track box because individual modules aren't
 *     distinguishable at this scale)
 *       0.85 along +X, 5.0 along +Y (velocity axis), 0.78 along +Z
 *
 *   - 4 SAW pairs at the truss tips. Each pair is rendered as one
 *     panel for readability (real ISS has 8 individual wings; the
 *     pair-per-tip silhouette reads identically at orbital-overview
 *     zoom).
 *       Each panel: 0.7 along +X, 3.4 along +Y, 0.04 along +Z
 *       Positions: (±4.65, ±1.85, 0) — outboard of the truss tips,
 *       extending fore/aft along velocity.
 *
 *   - Heat-rejection radiator pairs (3 sets of white panels on the
 *     nadir side of the truss). Smaller and more subtle than the
 *     SAWs; they read as "the white wings perpendicular to the
 *     gold ones" when zoomed in.
 *       3 panels at X = -1.8, 0, +1.8, each 1.5 × 0.05 × 1.1
 *       Centred on +Z (extending nadir-side from the truss).
 *
 * Model frame matches every other hero mesh:
 *   +X = cross-track (truss long axis)
 *   +Y = along-track / velocity (module stack)
 *   -Z = nadir (Earth-facing)
 */

import { newAccum, pushBox, finalizeGeometry } from './geometry-helpers.js';
import { HeroMesh, buildHeroMaterial }         from './hero-mesh.js';

export const ISS_NORAD_ID = 25544;
const MODEL_SCALE_SCENE   = 0.010;

const COL_TRUSS         = [0.78, 0.78, 0.74];   // weathered MLI / aluminum
const COL_TRUSS_NADIR   = [0.42, 0.42, 0.42];   // shadow / equipment side
const COL_MODULE        = [0.92, 0.92, 0.94];   // bright white MLI
const COL_MODULE_NADIR  = [0.50, 0.50, 0.52];   // service side
const COL_SAW_FRONT     = [0.72, 0.55, 0.20];   // gold cell side
const COL_SAW_BACK      = [0.18, 0.16, 0.20];   // dark back
const COL_SAW_EDGE      = [0.30, 0.28, 0.26];
const COL_RAD_FACE      = [0.96, 0.96, 0.96];   // bright white radiator
const COL_RAD_EDGE      = [0.50, 0.50, 0.52];

export function buildIssGeometry() {
    const out = newAccum();

    // ── Truss (S0 → S6 + P0 → P6) ────────────────────────────────
    // Single box for the whole 109-m structure. The slight
    // darker tint on +Z / -Z faces sketches the equipment racks
    // hanging off the truss without modelling them individually.
    pushBox(
        out,
        0, 0, 0,
        10.0, 0.55, 0.32,
        [
            COL_TRUSS,         // +X (outboard, port side)
            COL_TRUSS,         // -X (outboard, starboard side)
            COL_TRUSS,         // +Y (forward face)
            COL_TRUSS,         // -Y (aft face)
            COL_TRUSS_NADIR,   // +Z (zenith — slightly darker, equipment)
            COL_TRUSS_NADIR,   // -Z (nadir — equipment too)
        ],
    );

    // ── Pressurized module stack ─────────────────────────────────
    // Zarya / Unity / Destiny / Harmony / Columbus / Kibo etc.
    // are tail-to-nose along the velocity axis. We render the
    // whole spine as one bright-white box — multi-segment cylinder
    // sketches at this scale would be lost.
    // The nadir face gets a slightly darker shade as a hint at
    // the docking ports and Cupola hanging off the bottom.
    pushBox(
        out,
        0, 0, 0,
        0.85, 5.0, 0.78,
        [
            COL_MODULE,         // +X (port side wall)
            COL_MODULE,         // -X (starboard side wall)
            COL_MODULE,         // +Y (forward — node 2 / docking)
            COL_MODULE,         // -Y (aft — Zvezda / propulsion)
            COL_MODULE,         // +Z (zenith)
            COL_MODULE_NADIR,   // -Z (nadir — Cupola, docking ports)
        ],
    );

    // ── Solar-array wings — 4 pair-assemblies at the truss tips ─
    // P-side (port = +X end) and S-side (starboard = -X end) each
    // carry two pairs; the inboard pair extends -Y (aft), the
    // outboard pair extends +Y (forward). We collapse each pair to
    // one larger panel because individual wings are sub-pixel at
    // overview zoom.
    //
    // Front face (+Z) reads as gold; back face (-Z) is the dark
    // backing. Edges intentionally darker so the panel silhouette
    // pops against the bright modules.
    const SAW_TIP_X = 4.65;   // outboard of the truss endpoint (X = ±5.0)
    const SAW_Y     = 1.85;   // fore/aft offset from truss centerline
    const SAW_SX    = 0.70;
    const SAW_SY    = 3.40;
    const SAW_SZ    = 0.04;
    const sawColors = [
        COL_SAW_EDGE,   // +X
        COL_SAW_EDGE,   // -X
        COL_SAW_EDGE,   // +Y (tip)
        COL_SAW_EDGE,   // -Y (root)
        COL_SAW_FRONT,  // +Z (gold cells)
        COL_SAW_BACK,   // -Z (dark back)
    ];
    pushBox(out, +SAW_TIP_X, +SAW_Y, 0, SAW_SX, SAW_SY, SAW_SZ, sawColors);   // P-outboard, fore
    pushBox(out, +SAW_TIP_X, -SAW_Y, 0, SAW_SX, SAW_SY, SAW_SZ, sawColors);   // P-outboard, aft
    pushBox(out, -SAW_TIP_X, +SAW_Y, 0, SAW_SX, SAW_SY, SAW_SZ, sawColors);   // S-outboard, fore
    pushBox(out, -SAW_TIP_X, -SAW_Y, 0, SAW_SX, SAW_SY, SAW_SZ, sawColors);   // S-outboard, aft

    // ── Heat-rejection radiators ────────────────────────────────
    // The three HRS pairs are the bright-white perpendicular flaps
    // hanging below (nadir-side of) the truss. We render them as
    // single thicker panels rather than pairs of thin ones for
    // the same readability reason as the SAWs.
    const radColors = [
        COL_RAD_EDGE,   // +X
        COL_RAD_EDGE,   // -X
        COL_RAD_EDGE,   // +Y
        COL_RAD_EDGE,   // -Y
        COL_RAD_FACE,   // +Z (sky-facing — but the panel itself is centred
                        //      below the truss, so visually the +Z face is
                        //      the top edge of a vertical fin)
        COL_RAD_FACE,   // -Z (Earth-facing)
    ];
    pushBox(out, -1.80, 0, +0.65, 1.50, 0.05, 1.10, radColors);
    pushBox(out,  0.00, 0, +0.65, 1.50, 0.05, 1.10, radColors);
    pushBox(out, +1.80, 0, +0.65, 1.50, 0.05, 1.10, radColors);

    return finalizeGeometry(out);
}

/**
 * Build an ISS HeroMesh ready for fleet.js to wire up.
 *
 * ISS is actively attitude-controlled — no tumble. LVLH pose with the
 * pressurized module spine along velocity is the operational reality.
 */
export function createIssModel(globe, tracker) {
    return new HeroMesh(globe, tracker, {
        norad:        ISS_NORAD_ID,
        geometry:     buildIssGeometry(),
        material:     buildHeroMaterial({ roughness: 0.55, metalness: 0.12 }),
        modelScale:   MODEL_SCALE_SCENE,
        name:         'iss',
        // No tumble — ISS holds attitude via CMGs + thrusters.
    });
}
