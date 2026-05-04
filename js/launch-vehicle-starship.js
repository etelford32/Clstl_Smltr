/**
 * launch-vehicle-starship.js — Parametric Starship-class super-heavy.
 *
 * SpaceX's Starship is still evolving. Block 1 (IFT-1..6) was 121 m at 9 m
 * diameter with 33 Raptor 2 engines on Super Heavy and 6 on Ship; Block 2 is
 * slightly taller; Block 3 / V3 is publicly slated for ~150 m with 35+
 * Raptor 3s on the booster and 9 on the ship; longer-term concepts go to
 * 12 m diameter and beyond. Rather than baking in one snapshot, this module
 * exposes a parametric builder so we can render any of those variants by
 * dialing dimensions, engine counts, and flap geometry.
 *
 * Public API:
 *   buildStarship({ variant, params? }) →
 *     { root, plumes, height, info }
 *
 *   variants: 'v1' | 'v2' | 'v3' | 'future'
 *   params:   optional override merged onto the variant defaults
 *
 *   root    THREE.Group containing the full stack, base at y=0.
 *   plumes  Array of plume Groups (booster ring + ship cluster) — the
 *           framework's tick loop animates these the same way it does the
 *           shuttle's. Hidden by default; toggle via .visible.
 *   height  Stack height in metres. Used by the framework to scale camera
 *           presets so the vehicle frames properly.
 *   info    Display metadata (name, year, engine counts, etc.) for the
 *           side-panel stats card.
 */

import * as THREE from 'three';
import { ENGINES } from './launch-engines.js';

// ── Colors ───────────────────────────────────────────────────────────────────
// Stainless steel is the whole point — high metalness, slight blue tint, and
// a clearcoat for the hot-rolled sheen. The aft skirt and engine plate read
// darker because of soot. Heat-shield tiles are the ship's belly tiles.

const COLORS = {
    steel:        0xc9ced6,
    steelDark:    0x9aa0aa,
    steelHot:     0x5a3a2a,    // soot-streaked aft section
    tile:         0x14141a,
    tileEdge:     0x2a2a32,
    raptorBell:   0x342f2a,
    raptorHot:    0x6a3a18,
    fin:          0x88898d,    // grid-fin frame
    plumeCore:    0xd0e8ff,    // Raptor methalox flame is famously blue/teal
    plumeMid:     0x7fb8ff,
    plumeOuter:   0x223a66,
};

// ── Variants ─────────────────────────────────────────────────────────────────
// All numbers in metres / counts. These are best-effort public approximations:
// V1 from press kits + flight broadcasts (IFT-1..4), V2 from SpaceX IAC slides
// + Block 2 photos at Starbase, V3 from Musk public statements (NASA HLS,
// 2024 Cyberhotel update). 'future' is a deliberate extrapolation for what a
// post-V3 Mars-cargo configuration might look like — speculative on purpose.

const STARSHIP_VARIANTS = {
    v1: {
        label:           'Starship V1 (Block 1)',
        years:           '2023 — 2024',
        diameter:        9.0,
        boosterLen:      71.0,
        shipLen:         50.3,
        ringLen:          1.8,    // hot-stage ring height
        boosterEngines:  33,      // 3 inner / 10 mid / 20 outer
        boosterRings:    [3, 10, 20],
        shipEngines:     6,       // 3 sea-level / 3 vacuum
        shipRings:       [3, 3],
        gridFinChord:    3.0,
        forwardFlapLen:  9.5,
        aftFlapLen:     12.0,
        notes:           'IFT-1 through IFT-6. Achieved hot-staging, ship reentry, tower catch.',
    },
    v2: {
        label:           'Starship V2 (Block 2)',
        years:           '2025 — 2026',
        diameter:        9.0,
        boosterLen:      72.3,
        shipLen:         52.1,
        ringLen:          1.8,
        boosterEngines:  33,
        boosterRings:    [3, 10, 20],
        shipEngines:     6,
        shipRings:       [3, 3],
        gridFinChord:    3.0,
        forwardFlapLen:  8.0,    // smaller, repositioned more leeward
        aftFlapLen:     11.0,
        notes:           'Longer ship + booster, leeward-shifted forward flaps, redesigned avionics.',
    },
    v3: {
        label:           'Starship V3',
        years:           '2026 — 2028',
        diameter:        9.0,
        boosterLen:      80.5,
        shipLen:         69.5,
        ringLen:          2.2,
        boosterEngines:  35,
        boosterRings:    [3, 12, 20],
        shipEngines:     9,      // 6 sea-level + 3 vacuum on V3
        shipRings:       [6, 3],
        gridFinChord:    3.4,
        forwardFlapLen:  8.5,
        aftFlapLen:     11.5,
        notes:           '~150 m stack, Raptor 3 throughout, ~200 t to LEO reusable (target).',
    },
    future: {
        label:           'Starship "Mars-cargo" (concept)',
        years:           '202X+',
        diameter:       12.0,
        boosterLen:     95.0,
        shipLen:        85.0,
        ringLen:         3.0,
        boosterEngines: 42,
        boosterRings:   [6, 14, 22],
        shipEngines:    12,
        shipRings:      [6, 6],
        gridFinChord:    4.5,
        forwardFlapLen: 10.0,
        aftFlapLen:    13.5,
        notes:           'Speculative 12 m wide variant — extrapolated, not announced hardware.',
    },
};

// ── Material helpers ─────────────────────────────────────────────────────────

function steelMat({ tint = COLORS.steel, roughness = 0.32, metalness = 0.92 } = {}) {
    return new THREE.MeshPhysicalMaterial({
        color: tint,
        roughness,
        metalness,
        clearcoat: 0.35,
        clearcoatRoughness: 0.4,
    });
}

function flatMat(color, roughness = 0.6, metalness = 0.05) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

// ── Sub-builders ─────────────────────────────────────────────────────────────

// Raptor engine bell. Raptor's full-flow staged-combustion bell is shorter
// and stockier than an SSME — and we have a LOT of them (33+) so we keep
// geometry cheap (12 segments). One shared bell geometry per call site.
function makeRaptorBellGeo(throatR, exitR, length, segs = 14) {
    const pts = [];
    const N = 10;
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const r = throatR + (exitR - throatR) * Math.pow(t, 0.6);
        pts.push(new THREE.Vector2(r, -t * length));
    }
    return new THREE.LatheGeometry(pts, segs);
}

// Raptor cluster — concentric rings of engines around the base of a booster
// or ship. counts is e.g. [3, 10, 20] = 3 inner + 10 middle + 20 outer.
// Returns a Group containing all bells.
function buildRaptorCluster({ counts, plateRadius, bellRadius, bellLength, vacuumRing = false }) {
    const g = new THREE.Group();
    g.name = 'RaptorCluster';

    const bellGeo = makeRaptorBellGeo(bellRadius * 0.4, bellRadius, bellLength, 14);
    const vacGeo  = makeRaptorBellGeo(bellRadius * 0.4, bellRadius * 1.55, bellLength * 1.45, 14);
    const bellMat = new THREE.MeshPhysicalMaterial({
        color: COLORS.raptorBell,
        roughness: 0.35,
        metalness: 0.6,
        clearcoat: 0.5,
    });
    const hotMat = new THREE.MeshBasicMaterial({ color: COLORS.raptorHot, side: THREE.BackSide });

    // Engine plate — dark disc the bells hang off of.
    const plate = new THREE.Mesh(
        new THREE.CylinderGeometry(plateRadius, plateRadius * 0.95, 0.6, 64),
        flatMat(0x2a2a30, 0.85, 0.2)
    );
    plate.position.y = -0.3;
    plate.castShadow = true;
    plate.receiveShadow = true;
    g.add(plate);

    let ringIdx = 0;
    for (const n of counts) {
        // Inner ring sits at small radius; subsequent rings spaced across the
        // engine plate. Outermost ring is parked just inside plateRadius.
        const isOuterMost = ringIdx === counts.length - 1;
        const innerEdge   = bellRadius * 1.2;
        const ringR = ringIdx === 0
            ? bellRadius * 1.3
            : innerEdge + (plateRadius - innerEdge - bellRadius) *
              (ringIdx / Math.max(1, counts.length - 1));

        // Vacuum-optimized engines (larger bells) are typically the inner
        // ring of the Ship cluster only. Toggle via vacuumRing flag and
        // only apply on innermost ring of a 2-ring ship cluster.
        const useVac = vacuumRing && ringIdx === 0 && counts.length === 2;
        const useGeo = useVac ? vacGeo : bellGeo;
        const useLen = useVac ? bellLength * 1.45 : bellLength;

        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + (ringIdx % 2 ? Math.PI / n : 0);
            const bell = new THREE.Mesh(useGeo, bellMat);
            bell.position.set(Math.cos(a) * ringR, -0.6, Math.sin(a) * ringR);
            bell.castShadow = true;
            g.add(bell);

            // Hot interior glow — back-side cone slightly inside the bell.
            const glow = new THREE.Mesh(useGeo, hotMat);
            glow.scale.set(0.85, 0.95, 0.85);
            glow.position.copy(bell.position);
            g.add(glow);
        }
        ringIdx++;
    }

    return g;
}

// Hot-stage ring — vented cylindrical interstage. Multiple thin pillars give
// the open-vent look that distinguishes the Block 2 design.
function buildHotStageRing(R, ringLen) {
    const g = new THREE.Group();
    g.name = 'HotStageRing';

    // Top + bottom flanges
    const flangeMat = steelMat({ roughness: 0.4 });
    const top = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 1.005, R * 1.005, 0.35, 48),
        flangeMat
    );
    top.position.y = ringLen - 0.18;
    top.castShadow = true;
    top.receiveShadow = true;
    g.add(top);

    const bot = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 1.005, R * 1.005, 0.35, 48),
        flangeMat
    );
    bot.position.y = 0.18;
    bot.castShadow = true;
    bot.receiveShadow = true;
    g.add(bot);

    // Vertical pillars — 24 thin posts around the ring.
    const pillarN = 24;
    const pillarGeo = new THREE.BoxGeometry(0.35, ringLen - 0.4, 0.35);
    for (let i = 0; i < pillarN; i++) {
        const a = (i / pillarN) * Math.PI * 2;
        const post = new THREE.Mesh(pillarGeo, flangeMat);
        post.position.set(Math.cos(a) * R * 1.005, ringLen / 2, Math.sin(a) * R * 1.005);
        post.castShadow = true;
        g.add(post);
    }
    return g;
}

// Grid fin — square frame with a crosshatch interior. Sticks out radially.
function buildGridFin(chord, mat) {
    const g = new THREE.Group();
    const T = 0.35;            // fin thickness
    const W = chord;
    const H = chord * 0.85;

    // Outer frame
    const frameGeo = new THREE.BoxGeometry(W, H, T);
    const frame = new THREE.Mesh(frameGeo, mat);
    g.add(frame);

    // Hatch — visualize as small box inserts forming a grid.
    const cells = 5;
    const cellW = W / cells;
    const cellH = H / cells;
    for (let i = 1; i < cells; i++) {
        // vertical bars
        const v = new THREE.Mesh(new THREE.BoxGeometry(0.08, H * 0.95, T * 0.95), mat);
        v.position.x = -W / 2 + i * cellW;
        g.add(v);
        // horizontal bars
        const h = new THREE.Mesh(new THREE.BoxGeometry(W * 0.95, 0.08, T * 0.95), mat);
        h.position.y = -H / 2 + i * cellH;
        g.add(h);
    }

    // Hinge stub — small cylinder behind the fin, attaches to the body.
    const hinge = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.35, W * 0.4, 12),
        mat
    );
    hinge.rotation.z = Math.PI / 2;
    hinge.position.x = -W / 2 - 0.2;
    g.add(hinge);

    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
}

// Ship flap — leaf-shaped paddle hinged to the ship body.
function buildFlap(length, rootChord, tipChord, mat) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(length * 0.75, rootChord * 0.4);
    shape.lineTo(length, rootChord * 0.5 - tipChord * 0.5);
    shape.lineTo(length, rootChord * 0.5 + tipChord * 0.5);
    shape.lineTo(length * 0.75, rootChord * 0.6 + rootChord * 0.4);
    shape.lineTo(0, rootChord);
    shape.lineTo(0, 0);
    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: 0.4,
        bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.18, bevelSegments: 1,
    });
    const flap = new THREE.Mesh(geo, mat);
    flap.castShadow = true;
    flap.receiveShadow = true;
    return flap;
}

// Tile-belly half-shell on the ship — same idea as the orbiter, but covering
// a larger arc (~165°) since the ship reenters belly-first.
function buildShipTiles(R, length, mat) {
    const arc = 1.83 * Math.PI / 2;         // ~165°
    const g = new THREE.Group();
    const segCount = 6;
    for (let i = 0; i < segCount; i++) {
        const segLen = length * 0.78 / segCount;
        const seg = new THREE.Mesh(
            new THREE.CylinderGeometry(R * 1.012, R * 1.012, segLen, 64, 1, true,
                                       3 * Math.PI / 2 - arc / 2, arc),
            mat
        );
        seg.position.y = length * 0.05 + segLen * (i + 0.5);
        seg.castShadow = true;
        g.add(seg);
    }
    return g;
}

// ── Super Heavy ──────────────────────────────────────────────────────────────

function buildSuperHeavy(P) {
    const g = new THREE.Group();
    g.name = 'SuperHeavy';

    const R = P.diameter / 2;
    const L = P.boosterLen;

    // Body — single lathe so the diameter taper at the aft skirt + nose
    // transition cap is one continuous surface. Most of the booster is just
    // a constant-diameter cylinder.
    const pts = [
        new THREE.Vector2(0,           0),
        new THREE.Vector2(R * 1.05,    0),
        new THREE.Vector2(R * 1.08,    1.2),     // aft skirt flare
        new THREE.Vector2(R,           2.5),
        new THREE.Vector2(R,           L * 0.96),
        new THREE.Vector2(R * 0.97,    L * 0.99),
        new THREE.Vector2(R * 0.94,    L),
    ];
    const body = new THREE.Mesh(
        new THREE.LatheGeometry(pts, 64),
        steelMat({ roughness: 0.34 })
    );
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // Sooted aft skirt — darker overlay sleeve covering the bottom 4 m (real
    // boosters arrive at the pad clean, but post-flight + plume soot they
    // get streaky. We keep it for visual interest even on the static stack).
    const aft = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 1.082, R * 1.082, 4.0, 64, 1, true),
        flatMat(COLORS.steelHot, 0.7, 0.3)
    );
    aft.position.y = 2.0;
    aft.castShadow = true;
    g.add(aft);

    // Chines — two raised stiffener strakes running most of the booster
    // length. Visible Block 2 detail.
    const chineGeo = new THREE.BoxGeometry(0.4, L * 0.85, 0.4);
    const chineMat = steelMat({ roughness: 0.5 });
    for (const ang of [Math.PI * 0.25, Math.PI * 0.75]) {
        const chine = new THREE.Mesh(chineGeo, chineMat);
        chine.position.set(Math.cos(ang) * R * 1.005, L * 0.5, Math.sin(ang) * R * 1.005);
        chine.castShadow = true;
        g.add(chine);
    }

    // Grid fins — 4 around the top, equispaced.
    const finMat = steelMat({ tint: COLORS.fin, roughness: 0.45 });
    for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const fin = buildGridFin(P.gridFinChord, finMat);
        fin.position.set(
            Math.cos(a) * (R + P.gridFinChord * 0.5 + 0.2),
            L - 5.5,
            Math.sin(a) * (R + P.gridFinChord * 0.5 + 0.2),
        );
        fin.rotation.y = -a + Math.PI / 2;
        g.add(fin);
    }

    // Catch points (chopstick pins) — small horizontal pegs near the top
    // that the Mechazilla arms grip. Two of them, 180° apart.
    const pinMat = flatMat(COLORS.steelDark, 0.4, 0.7);
    for (const ang of [0, Math.PI]) {
        const pin = new THREE.Mesh(
            new THREE.CylinderGeometry(0.45, 0.45, 1.4, 16),
            pinMat
        );
        pin.rotation.z = Math.PI / 2;
        pin.position.set(Math.cos(ang) * (R + 0.6), L - 1.5, Math.sin(ang) * (R + 0.6));
        pin.castShadow = true;
        g.add(pin);
    }

    // Engines — concentric ring cluster at the base.
    const cluster = buildRaptorCluster({
        counts:      P.boosterRings,
        plateRadius: R * 0.95,
        bellRadius:  Math.max(0.55, R * 0.16),
        bellLength:  Math.max(1.4, R * 0.4),
    });
    cluster.position.y = 0.2;
    g.add(cluster);

    return g;
}

// ── Ship ─────────────────────────────────────────────────────────────────────

function buildShip(P) {
    const g = new THREE.Group();
    g.name = 'Ship';

    const R = P.diameter / 2;
    const L = P.shipLen;
    const noseFrac = 0.20;
    const bodyLen  = L * (1 - noseFrac);

    // Body + nose — single lathe profile from base, up the cylindrical tank
    // section, then curving into the ogive nose.
    const noseStart = bodyLen;
    const pts = [
        new THREE.Vector2(0,            0),
        new THREE.Vector2(R * 1.02,     0),
        new THREE.Vector2(R,            1.2),
        new THREE.Vector2(R,            noseStart),
    ];
    // Ogive nose — sample the curve so it looks smooth.
    const Nnose = 14;
    const noseLen = L - noseStart;
    for (let i = 1; i <= Nnose; i++) {
        const t = i / Nnose;
        // Ogive: r = R * sqrt(1 - t^2 * 0.6) tapering to a soft point.
        const r = R * Math.cos(t * Math.PI * 0.46);
        pts.push(new THREE.Vector2(Math.max(0, r), noseStart + t * noseLen));
    }

    const body = new THREE.Mesh(
        new THREE.LatheGeometry(pts, 64),
        steelMat({ roughness: 0.32 })
    );
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // Heat-shield tiles on the leeward side (-Z by convention, so the tiles
    // face the camera when the booster catch tower is on +Z behind).
    const tiles = buildShipTiles(R, L, flatMat(COLORS.tile, 0.95));
    g.add(tiles);

    // Tile band stripe at the very base — visual detail, dark ring.
    const band = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 1.008, R * 1.008, 0.6, 64, 1, true),
        flatMat(COLORS.tileEdge, 0.85)
    );
    band.position.y = 1.5;
    g.add(band);

    // Forward flaps — high on the ship, small, leaning leeward.
    const flapMat = steelMat({ tint: COLORS.fin, roughness: 0.45 });
    const fwdRoot = bodyLen - P.forwardFlapLen * 0.9;
    for (const angle of [Math.PI * 0.22, -Math.PI * 0.22]) {
        const flap = buildFlap(P.forwardFlapLen, 2.6, 1.6, flapMat);
        // Hinge oriented so the flap hangs below the hinge axis when stowed.
        flap.position.set(
            Math.cos(angle + Math.PI / 2) * R * 1.02,
            fwdRoot,
            Math.sin(angle + Math.PI / 2) * R * 1.02,
        );
        flap.rotation.set(0, -angle - Math.PI / 2, -Math.PI * 0.08);
        g.add(flap);
    }

    // Aft flaps — low on the ship, larger, splayed outward.
    const aftRoot = 4.5;
    for (const angle of [Math.PI * 0.22, -Math.PI * 0.22]) {
        const flap = buildFlap(P.aftFlapLen, 3.2, 2.0, flapMat);
        flap.position.set(
            Math.cos(angle + Math.PI / 2) * R * 1.02,
            aftRoot,
            Math.sin(angle + Math.PI / 2) * R * 1.02,
        );
        flap.rotation.set(0, -angle - Math.PI / 2, Math.PI * 0.18);
        g.add(flap);
    }

    // Catch pins — same as booster, two horizontal pegs near the top.
    const pinMat = flatMat(COLORS.steelDark, 0.4, 0.7);
    for (const ang of [0, Math.PI]) {
        const pin = new THREE.Mesh(
            new THREE.CylinderGeometry(0.4, 0.4, 1.2, 16),
            pinMat
        );
        pin.rotation.z = Math.PI / 2;
        pin.position.set(Math.cos(ang) * (R + 0.55), bodyLen - 2.0, Math.sin(ang) * (R + 0.55));
        pin.castShadow = true;
        g.add(pin);
    }

    // Raptors — sea-level ring + (optional) vacuum ring.
    const cluster = buildRaptorCluster({
        counts:       P.shipRings,
        plateRadius:  R * 0.85,
        bellRadius:   Math.max(0.55, R * 0.18),
        bellLength:   Math.max(1.4, R * 0.42),
        vacuumRing:   true,
    });
    cluster.position.y = 0.2;
    g.add(cluster);

    return g;
}

// ── Plume (Raptor methalox — blue/teal flame) ────────────────────────────────
// One-time builder shared between booster + ship clusters. The framework's
// tickPlume() animates these at the same cadence as the shuttle's plumes.

function buildRaptorPlume(radius, length) {
    const g = new THREE.Group();
    g.name = 'StarshipPlume';
    g.visible = false;

    const layers = [
        { color: COLORS.plumeCore,  r: radius * 0.55, len: length * 0.55, opacity: 0.95 },
        { color: COLORS.plumeMid,   r: radius * 1.0,  len: length * 0.85, opacity: 0.6  },
        { color: COLORS.plumeOuter, r: radius * 1.6,  len: length,        opacity: 0.3  },
    ];
    for (const L of layers) {
        const cone = new THREE.Mesh(
            new THREE.ConeGeometry(L.r, L.len, 32, 1, true),
            new THREE.MeshBasicMaterial({
                color: L.color, transparent: true, opacity: L.opacity,
                blending: THREE.AdditiveBlending, depthWrite: false,
                side: THREE.DoubleSide,
            })
        );
        cone.rotation.x = Math.PI;
        cone.position.y = -L.len / 2;
        cone.userData.baseOpacity = L.opacity;
        cone.userData.baseLen     = L.len;
        g.add(cone);
    }
    return g;
}

// ── Public builder ───────────────────────────────────────────────────────────

export function buildStarship({ variant = 'v2', params: override = {} } = {}) {
    const base = STARSHIP_VARIANTS[variant];
    if (!base) throw new Error(`Unknown Starship variant: ${variant}`);
    const P = { ...base, ...override };

    const root = new THREE.Group();
    root.name = 'StarshipStack';

    // Booster at base
    const booster = buildSuperHeavy(P);
    root.add(booster);

    // Hot-stage ring on top of the booster
    const ring = buildHotStageRing(P.diameter / 2, P.ringLen);
    ring.position.y = P.boosterLen;
    root.add(ring);

    // Ship on top of the ring
    const ship = buildShip(P);
    ship.position.y = P.boosterLen + P.ringLen;
    root.add(ship);

    const totalH = P.boosterLen + P.ringLen + P.shipLen;

    // Plumes — a single big plume at the booster cluster, plus one at the
    // ship cluster (off-screen during ascent normally, but we expose it for
    // the static visualization).
    const plumes = [];

    const boosterPlume = buildRaptorPlume(P.diameter * 0.55, P.diameter * 4.5);
    boosterPlume.position.y = -1.2;
    root.add(boosterPlume);
    plumes.push(boosterPlume);

    const shipPlume = buildRaptorPlume(P.diameter * 0.45, P.diameter * 3.0);
    shipPlume.position.y = P.boosterLen + P.ringLen - 1.0;
    root.add(shipPlume);
    plumes.push(shipPlume);

    // Thrust — V1 + V2 use Raptor 2; V3 + future use Raptor 3. Numbers
    // come from public IAC slides + Musk public statements (Raptor 3 SL
    // thrust is a stated target rather than confirmed test-stand).
    const useR3 = (variant === 'v3' || variant === 'future');
    const eng   = useR3 ? ENGINES.raptor_3 : ENGINES.raptor_2;
    const liftoffKn = P.boosterEngines * eng.sl_kn;
    const massT = variant === 'v1'  ? 5000
                : variant === 'v2'  ? 5200
                : variant === 'v3'  ? 6500
                :                     10000;

    // Stack info for the side panel.
    const info = {
        name:           P.label,
        years:          P.years,
        height_m:       totalH.toFixed(1),
        diameter_m:     P.diameter.toFixed(1),
        booster_engines: `${P.boosterEngines} × ${eng.name}`,
        ship_engines:    `${P.shipEngines} × ${eng.name}`,
        // Public approximations — let's not pretend these are spec.
        liftoff_mass_t: variant === 'v1'    ? '5,000'
                      : variant === 'v2'    ? '5,200'
                      : variant === 'v3'    ? '6,500'
                      :                       '~10,000',
        leo_payload_t:  variant === 'v1'    ? '~50'
                      : variant === 'v2'    ? '~100'
                      : variant === 'v3'    ? '~200'
                      :                       '~400',
        notes:          P.notes,
        thrust: {
            liftoff_kn:    liftoffKn,
            liftoff_mn:    liftoffKn / 1000,
            per_engine_kn: eng.sl_kn,
            engine_count:  P.boosterEngines,
            booster_engine: eng.name,
            upper_engine:   eng.name,
            propellant:    eng.propellant,
            twr_initial:   liftoffKn / (massT * 9.80665),
            mass_t:        massT,
            ref_id:        variant === 'v1'     ? 'starship_v1'
                         : variant === 'v2'     ? 'starship_v2'
                         : variant === 'v3'     ? 'starship_v3'
                         :                        'starship_future',
        },
    };

    // Engine layout — concentric rings on the booster + cluster on the
    // ship, mirroring buildRaptorCluster's geometry. Used by the thrust-
    // vector overlay. Inner rings gimbal; outer ring is fixed.
    const SR = P.diameter / 2;
    const bellR = Math.max(0.55, SR * 0.16);
    function ringLayout(counts, plateRadius, baseY, gimbalRings) {
        const out = [];
        const innerEdge = bellR * 1.2;
        for (let ringIdx = 0; ringIdx < counts.length; ringIdx++) {
            const n = counts[ringIdx];
            const ringR = ringIdx === 0
                ? bellR * 1.3
                : innerEdge + (plateRadius - innerEdge - bellR) *
                  (ringIdx / Math.max(1, counts.length - 1));
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2 + (ringIdx % 2 ? Math.PI / n : 0);
                out.push({
                    x: Math.cos(a) * ringR,
                    y: baseY,
                    z: Math.sin(a) * ringR,
                    thrust_kn: eng.sl_kn,
                    gimbal:    ringIdx < gimbalRings,
                    ring: ringIdx === 0 ? 'inner'
                        : ringIdx === counts.length - 1 ? 'outer' : 'mid',
                });
            }
        }
        return out;
    }

    const boosterEngines = ringLayout(P.boosterRings, SR * 0.95, -1.4, P.boosterRings.length - 1);
    const shipEngines    = ringLayout(P.shipRings,    SR * 0.85, P.boosterLen + P.ringLen - 0.8, 1);
    const engineLayout = { boosterEngines, upperEngines: shipEngines };

    return { root, plumes, height: totalH, info, engineLayout };
}

export const STARSHIP_VARIANT_IDS = Object.keys(STARSHIP_VARIANTS);
export function starshipVariantLabel(id) {
    return STARSHIP_VARIANTS[id]?.label || id;
}
