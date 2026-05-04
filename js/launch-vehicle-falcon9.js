/**
 * launch-vehicle-falcon9.js — Parametric Falcon 9 / Falcon Heavy.
 *
 * SpaceX's workhorse — by far the most common upcoming-launch vehicle in the
 * planner's roster. Same parametric pattern as the Starship module so we can
 * render Block 5 (current expendable + reusable booster), Block 5 + Crew
 * Dragon, and Falcon Heavy (3-core triple-booster) from one builder.
 *
 * Public API:
 *   buildFalcon9({ variant, params? }) →
 *     { root, plumes, height, info, padId }
 *
 *   variants: 'block5' | 'block5-crew' | 'heavy'
 *
 *   root    THREE.Group containing the full stack, base at y=0.
 *   plumes  Array of plume Groups (one per booster + one for upper stage).
 *   height  Stack height in metres (for camera framing).
 *   info    Display metadata (name, year, engine counts, etc.).
 *   padId   Preferred pad id ('lc39a' for KSC / SLC-40 stand-in).
 */

import * as THREE from 'three';
import { ENGINES } from './launch-engines.js';

// ── Colors ───────────────────────────────────────────────────────────────────

const COLORS = {
    boosterWhite:  0xf6f3ec,    // slightly off-white (block-5 cream tint)
    boosterSoot:   0x18181c,    // sooted aft ring on reused boosters
    boosterTrim:   0xc8c4b6,    // dirty-white near soot edge
    interstage:    0xeeeae0,
    stage2:        0xf6f3ec,
    fairing:       0xfaf8f0,
    fairingSeam:   0x6a6a70,
    merlinBell:    0x1c1c20,
    merlinHot:     0x6a3a18,
    gridFin:       0xe6dcc8,    // titanium "TUFROC" surface, lightly tinted
    leg:           0x2a2a32,
    plumeCore:     0xfff2c0,    // RP-1/LOX kerolox plume — bright yellow-orange
    plumeMid:      0xff9a40,
    plumeOuter:    0x4a2410,
    nose:          0xe8e3d6,
    dragonWhite:   0xfafaf6,
    dragonGray:    0x6e6f78,
    dragonGold:    0xb89060,
    solarPanel:    0x1a2440,
};

// ── Variants ─────────────────────────────────────────────────────────────────
// Block 5 dimensions per SpaceX Falcon Payload User's Guide rev. 3 (2021):
//   First stage              41.2 m × 3.66 m  (9 Merlin 1D)
//   Interstage                6.7 m × 3.66 m
//   Second stage             12.6 m × 3.66 m  (1 Merlin Vacuum)
//   Standard payload fairing 13.1 m × 5.2 m

const FALCON_VARIANTS = {
    'block5': {
        label:           'Falcon 9 Block 5',
        years:           '2018 — present',
        cores:           1,
        diameter:        3.66,
        boosterLen:      41.2,
        interstageLen:   6.7,
        upperStageLen:   12.6,
        fairingLen:      13.1,
        fairingDia:      5.2,
        sideNoseLen:     0,        // unused (side cores only)
        payload:         'fairing',
        landingLegs:     true,
        gridFins:        4,
        boosterEngines:  9,         // 1 + 8 octaweb
        upperEngines:    1,
        notes:           'First-stage reuse + booster recovery; 200+ landings.',
    },
    'block5-crew': {
        label:           'Falcon 9 + Crew Dragon',
        years:           '2020 — present',
        cores:           1,
        diameter:        3.66,
        boosterLen:      41.2,
        interstageLen:   6.7,
        upperStageLen:   12.6,
        fairingLen:      0,         // payload is the capsule, no fairing
        fairingDia:      0,
        sideNoseLen:     0,
        payload:         'crew_dragon',
        landingLegs:     true,
        gridFins:        4,
        boosterEngines:  9,
        upperEngines:    1,
        notes:           'Crew Dragon — Demo-2, Crew-1..N, Inspiration4, Polaris Dawn.',
    },
    'heavy': {
        label:           'Falcon Heavy',
        years:           '2018 — present',
        cores:           3,         // 1 center + 2 side
        diameter:        3.66,
        boosterLen:      41.2,
        interstageLen:   6.7,
        upperStageLen:   12.6,
        fairingLen:      13.1,
        fairingDia:      5.2,
        sideNoseLen:     5.0,       // ogive nose cone capping each side core
        payload:         'fairing',
        landingLegs:     true,
        gridFins:        4,
        boosterEngines:  27,        // 9 × 3 cores
        upperEngines:    1,
        notes:           'Triple-core; FH Demo "Starman", Arabsat-6A, USSF-44, Psyche.',
    },
};

// ── Material helpers ─────────────────────────────────────────────────────────

function flatMat(color, roughness = 0.55, metalness = 0.05) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function physMat(color, opts = {}) {
    return new THREE.MeshPhysicalMaterial({
        color,
        roughness:   opts.roughness   ?? 0.4,
        metalness:   opts.metalness   ?? 0.05,
        clearcoat:   opts.clearcoat   ?? 0.25,
        clearcoatRoughness: opts.clearcoatRoughness ?? 0.4,
    });
}

// ── Octaweb (9-Merlin engine plate) ──────────────────────────────────────────
// Real Falcon 9 octaweb: 1 center engine + 8 in a ring at ~0.7·radius.
// Merlin 1D bell: throat ~0.32 m, exit ~0.92 m, length ~2.0 m.

function makeMerlinBellGeo(throatR, exitR, length) {
    const pts = [];
    const N = 12;
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const r = throatR + (exitR - throatR) * Math.pow(t, 0.55);
        pts.push(new THREE.Vector2(r, -t * length));
    }
    return new THREE.LatheGeometry(pts, 20);
}

function buildOctaweb(boosterR) {
    const g = new THREE.Group();
    g.name = 'Octaweb';

    // Engine plate — flat dark disc the bells hang off of.
    const plate = new THREE.Mesh(
        new THREE.CylinderGeometry(boosterR * 0.96, boosterR * 0.92, 0.5, 36),
        flatMat(0x1a1a1f, 0.85, 0.2)
    );
    plate.position.y = -0.25;
    plate.castShadow = true;
    plate.receiveShadow = true;
    g.add(plate);

    // 9 Merlin bells — 1 center + 8 ring
    const bellGeo = makeMerlinBellGeo(0.18, 0.46, 1.95);
    const bellMat = physMat(COLORS.merlinBell, {
        roughness: 0.32, metalness: 0.55, clearcoat: 0.5,
    });
    const hotMat = new THREE.MeshBasicMaterial({ color: COLORS.merlinHot, side: THREE.BackSide });

    function placeBell(x, z) {
        const bell = new THREE.Mesh(bellGeo, bellMat);
        bell.position.set(x, -0.55, z);
        bell.castShadow = true;
        g.add(bell);
        const glow = new THREE.Mesh(bellGeo, hotMat);
        glow.scale.set(0.85, 0.95, 0.85);
        glow.position.copy(bell.position);
        g.add(glow);
    }
    placeBell(0, 0);
    const ringR = boosterR * 0.62;
    for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        placeBell(Math.cos(a) * ringR, Math.sin(a) * ringR);
    }
    return g;
}

// ── Grid fin ─────────────────────────────────────────────────────────────────
// Titanium grid fin — square frame with a tighter crosshatch than a
// Super Heavy fin (Falcon 9 is ~1.8 m on a side).

function buildGridFin(size = 1.8) {
    const g = new THREE.Group();
    const T = 0.22;
    const mat = flatMat(COLORS.gridFin, 0.45, 0.4);

    const frame = new THREE.Mesh(new THREE.BoxGeometry(size, size, T), mat);
    g.add(frame);
    const cells = 5;
    const step = size / cells;
    for (let i = 1; i < cells; i++) {
        const v = new THREE.Mesh(new THREE.BoxGeometry(0.05, size * 0.95, T * 0.95), mat);
        v.position.x = -size / 2 + i * step;
        g.add(v);
        const h = new THREE.Mesh(new THREE.BoxGeometry(size * 0.95, 0.05, T * 0.95), mat);
        h.position.y = -size / 2 + i * step;
        g.add(h);
    }
    // Pivot stub
    const pivot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.18, size * 0.4, 12),
        mat
    );
    pivot.rotation.z = Math.PI / 2;
    pivot.position.x = -size / 2 - 0.15;
    g.add(pivot);

    g.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
    return g;
}

// ── Landing leg (stowed) ─────────────────────────────────────────────────────
// Carbon-fibre A-frame leg in the stowed-against-body position.

function buildLandingLegStowed(boosterLen, boosterR) {
    const g = new THREE.Group();
    const mat = flatMat(COLORS.leg, 0.5, 0.3);

    // Main strut, flush with the booster aft for ~10 m.
    const strut = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 9.5, 0.35),
        mat
    );
    strut.position.set(boosterR * 1.04, 5.2, 0);
    strut.castShadow = true;
    g.add(strut);

    // Foot pad triangle at the bottom.
    const foot = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 0.6, 0.7),
        mat
    );
    foot.position.set(boosterR * 1.04, 0.4, 0);
    foot.castShadow = true;
    g.add(foot);

    return g;
}

// ── Booster (single Falcon 9 first stage) ────────────────────────────────────

function buildBoosterCore(P, { isSideCore = false } = {}) {
    const g = new THREE.Group();
    g.name = isSideCore ? 'Falcon9-SideCore' : 'Falcon9-Core';
    const R = P.diameter / 2;
    const L = P.boosterLen;

    // Body — straight cylinder with slight aft skirt flare.
    const pts = [
        new THREE.Vector2(0,        0),
        new THREE.Vector2(R * 1.04, 0),
        new THREE.Vector2(R * 1.06, 0.6),
        new THREE.Vector2(R,        2.0),
        new THREE.Vector2(R,        L * 0.96),
        new THREE.Vector2(R * 0.99, L),
    ];
    const body = new THREE.Mesh(
        new THREE.LatheGeometry(pts, 36),
        physMat(COLORS.boosterWhite, { roughness: 0.42, clearcoat: 0.3 })
    );
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // Soot ring — darker overlay sleeve covering the bottom 4 m. Reused
    // boosters arrive at the pad with a clear post-flight soot ring.
    const sootSleeve = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 1.052, R * 1.052, 4, 36, 1, true),
        flatMat(COLORS.boosterSoot, 0.85)
    );
    sootSleeve.position.y = 2.0;
    sootSleeve.castShadow = true;
    g.add(sootSleeve);

    // Soot transition band (gradient between black and white)
    const sootBand = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 1.054, R * 1.054, 1.5, 36, 1, true),
        flatMat(COLORS.boosterTrim, 0.8)
    );
    sootBand.position.y = 4.7;
    g.add(sootBand);

    // Octaweb at the base
    const ow = buildOctaweb(R);
    ow.position.y = 0;
    g.add(ow);

    // Landing legs (4)
    if (P.landingLegs) {
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
            const leg = buildLandingLegStowed(L, R);
            leg.rotation.y = -a;
            leg.position.set(0, 0, 0);
            // Move legs to rotate around body center
            leg.children.forEach(child => {
                const x = child.position.x;
                child.position.x = Math.cos(a) * x;
                child.position.z = Math.sin(a) * x;
                child.rotation.y = -a;
            });
            g.add(leg);
        }
    }

    // Grid fins (4) at top of booster
    if (P.gridFins && !isSideCore) {
        const finMat = flatMat(COLORS.gridFin, 0.45, 0.4);
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
            const fin = buildGridFin(1.8);
            fin.position.set(
                Math.cos(a) * (R + 0.95),
                L - 1.5,
                Math.sin(a) * (R + 0.95),
            );
            fin.rotation.y = -a + Math.PI / 2;
            g.add(fin);
        }
    }

    // Side cores: ogive nose cone replacing interstage+upper+fairing.
    if (isSideCore) {
        const noseLen = P.sideNoseLen;
        const nosePts = [];
        const N = 12;
        for (let i = 0; i <= N; i++) {
            const t = i / N;
            const r = R * Math.cos(t * Math.PI * 0.45);
            nosePts.push(new THREE.Vector2(Math.max(0, r), L + t * noseLen));
        }
        const nose = new THREE.Mesh(
            new THREE.LatheGeometry(nosePts, 36),
            physMat(COLORS.nose, { roughness: 0.4, clearcoat: 0.25 })
        );
        nose.castShadow = true;
        g.add(nose);

        // Side-core nose ALSO has 4 grid fins (real FH side cores do).
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
            const fin = buildGridFin(1.5);
            fin.position.set(
                Math.cos(a) * (R + 0.85),
                L - 1.5,
                Math.sin(a) * (R + 0.85),
            );
            fin.rotation.y = -a + Math.PI / 2;
            g.add(fin);
        }
    }

    return g;
}

// ── Interstage ───────────────────────────────────────────────────────────────

function buildInterstage(P) {
    const g = new THREE.Group();
    const R = P.diameter / 2;
    const L = P.interstageLen;

    const body = new THREE.Mesh(
        new THREE.CylinderGeometry(R, R, L, 36),
        physMat(COLORS.interstage, { roughness: 0.45, clearcoat: 0.2 })
    );
    body.position.y = L / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // Subtle horizontal panel seam at the top
    const seam = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 1.005, R * 1.005, 0.15, 36, 1, true),
        flatMat(0xb8b4a8, 0.6)
    );
    seam.position.y = L - 0.15;
    g.add(seam);

    return g;
}

// ── Second stage + Merlin Vacuum ─────────────────────────────────────────────

function buildSecondStage(P) {
    const g = new THREE.Group();
    const R = P.diameter / 2;
    const L = P.upperStageLen;

    const body = new THREE.Mesh(
        new THREE.CylinderGeometry(R, R, L, 36),
        physMat(COLORS.stage2, { roughness: 0.42, clearcoat: 0.3 })
    );
    body.position.y = L / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // MVac engine — a single, much larger bell than a sea-level Merlin
    // (vacuum-optimized, ~1.8 m exit diameter on Falcon 9).
    const mvacGeo = makeMerlinBellGeo(0.22, 0.92, 3.0);
    const mvac = new THREE.Mesh(
        mvacGeo,
        physMat(COLORS.merlinBell, { roughness: 0.3, metalness: 0.55, clearcoat: 0.5 })
    );
    mvac.position.y = -0.1;
    mvac.castShadow = true;
    g.add(mvac);

    return g;
}

// ── Payload fairing (clamshell with seam) ────────────────────────────────────

function buildFairing(P) {
    const g = new THREE.Group();
    const R = P.fairingDia / 2;
    const L = P.fairingLen;
    const stageR = P.diameter / 2;

    // Lathe profile — base diameter matches the upper stage, expands to
    // the fairing's larger diameter, then ogives to a point.
    const pts = [
        new THREE.Vector2(stageR, 0),
        new THREE.Vector2(stageR + 0.05, 0.4),
        new THREE.Vector2(R, 1.6),                  // expansion section
        new THREE.Vector2(R, L * 0.62),             // cylindrical section
    ];
    const N = 12;
    for (let i = 1; i <= N; i++) {
        const t = i / N;
        const r = R * Math.cos(t * Math.PI * 0.46);
        pts.push(new THREE.Vector2(Math.max(0, r), L * 0.62 + t * (L - L * 0.62)));
    }
    const body = new THREE.Mesh(
        new THREE.LatheGeometry(pts, 48),
        physMat(COLORS.fairing, { roughness: 0.35, clearcoat: 0.4 })
    );
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // Vertical seam — two clamshell halves split front-to-back.
    const seamMat = flatMat(COLORS.fairingSeam, 0.6);
    for (const xSign of [-1, 1]) {
        const seam = new THREE.Mesh(
            new THREE.BoxGeometry(0.05, L * 0.95, 0.18),
            seamMat
        );
        seam.position.set(xSign * R * 1.005, L * 0.5, 0);
        g.add(seam);
    }

    return g;
}

// ── Crew Dragon (capsule + trunk + nose cone) ────────────────────────────────

function buildCrewDragon(P) {
    const g = new THREE.Group();
    const stageR = P.diameter / 2;

    // Trunk — cylindrical extension below the capsule, with two
    // rectangular solar arrays on opposite sides.
    const trunkH = 3.7;
    const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(stageR, stageR, trunkH, 36),
        physMat(COLORS.dragonWhite, { roughness: 0.4, clearcoat: 0.3 })
    );
    trunk.position.y = trunkH / 2;
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    g.add(trunk);

    // Solar panels — flat panels integrated to the trunk (Dragon 2 has
    // body-mounted arrays, not deployable wings like Dragon 1).
    const solarMat = flatMat(COLORS.solarPanel, 0.3, 0.2);
    for (const xSign of [-1, 1]) {
        const panel = new THREE.Mesh(
            new THREE.BoxGeometry(0.05, trunkH * 0.85, stageR * 1.4),
            solarMat
        );
        panel.position.set(xSign * stageR * 1.005, trunkH / 2, 0);
        g.add(panel);
    }

    // Trunk fins — 4 small radiator fins between the solar arrays.
    const finMat = flatMat(COLORS.dragonGray, 0.6);
    for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const fin = new THREE.Mesh(
            new THREE.BoxGeometry(0.08, trunkH * 0.6, 0.7),
            finMat
        );
        fin.position.set(Math.cos(a) * stageR * 1.02, trunkH / 2, Math.sin(a) * stageR * 1.02);
        fin.rotation.y = -a;
        g.add(fin);
    }

    // Capsule — frustum (gum-drop shape). Dragon 2 base ~3.7 m, top ~2.2 m,
    // height ~4 m. Use a short Lathe.
    const capH = 4.0;
    const capPts = [
        new THREE.Vector2(stageR, trunkH),
        new THREE.Vector2(stageR, trunkH + 0.2),
        new THREE.Vector2(stageR * 0.9, trunkH + capH * 0.6),
        new THREE.Vector2(stageR * 0.55, trunkH + capH * 0.95),
        new THREE.Vector2(stageR * 0.4, trunkH + capH),
    ];
    const capsule = new THREE.Mesh(
        new THREE.LatheGeometry(capPts, 36),
        physMat(COLORS.dragonWhite, { roughness: 0.4, clearcoat: 0.45 })
    );
    capsule.castShadow = true;
    capsule.receiveShadow = true;
    g.add(capsule);

    // PICA-X heat shield — gold/ablative bottom of capsule (just visible
    // as a darker ring at the trunk-capsule join).
    const shield = new THREE.Mesh(
        new THREE.CylinderGeometry(stageR * 1.005, stageR * 1.005, 0.4, 36, 1, true),
        flatMat(COLORS.dragonGold, 0.7)
    );
    shield.position.y = trunkH;
    g.add(shield);

    // Nose cone (closed) — protects the docking adapter on ascent. Hinged
    // open in real flight at T+~6 min. We render closed for static stack.
    const noseLen = 1.5;
    const nose = new THREE.Mesh(
        new THREE.ConeGeometry(stageR * 0.4, noseLen, 24),
        physMat(COLORS.dragonWhite, { roughness: 0.4, clearcoat: 0.4 })
    );
    nose.position.y = trunkH + capH + noseLen / 2 - 0.05;
    nose.castShadow = true;
    g.add(nose);

    return g;
}

// ── Plume (Merlin kerolox — bright orange-yellow) ────────────────────────────

function buildKeroloxPlume(radius, length) {
    const g = new THREE.Group();
    g.name = 'Falcon9Plume';
    g.visible = false;

    const layers = [
        { color: COLORS.plumeCore,  r: radius * 0.55, len: length * 0.55, opacity: 0.95 },
        { color: COLORS.plumeMid,   r: radius * 1.0,  len: length * 0.85, opacity: 0.65 },
        { color: COLORS.plumeOuter, r: radius * 1.55, len: length,        opacity: 0.30 },
    ];
    for (const L of layers) {
        const cone = new THREE.Mesh(
            new THREE.ConeGeometry(L.r, L.len, 28, 1, true),
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

export function buildFalcon9({ variant = 'block5', params: override = {} } = {}) {
    const base = FALCON_VARIANTS[variant];
    if (!base) throw new Error(`Unknown Falcon 9 variant: ${variant}`);
    const P = { ...base, ...override };

    const root = new THREE.Group();
    root.name = 'Falcon9Stack';
    const plumes = [];

    // Center core (always present)
    const center = buildBoosterCore(P, { isSideCore: false });
    root.add(center);

    // Center-core plume
    const cR = P.diameter / 2;
    const centerPlume = buildKeroloxPlume(cR * 0.95, cR * 6);
    centerPlume.position.y = -1.6;
    plumes.push(centerPlume);
    root.add(centerPlume);

    // Falcon Heavy: 2 side cores
    if (P.cores === 3) {
        const offset = P.diameter * 1.02;     // edge-to-edge contact
        for (const xSign of [-1, 1]) {
            const side = buildBoosterCore(P, { isSideCore: true });
            side.position.x = xSign * offset;
            root.add(side);

            // Each side core gets its own plume
            const sp = buildKeroloxPlume(cR * 0.95, cR * 6);
            sp.position.set(xSign * offset, -1.6, 0);
            plumes.push(sp);
            root.add(sp);
        }
    }

    // Center core continues upward: interstage → S2 → fairing/dragon
    let yCursor = P.boosterLen;

    const interstage = buildInterstage(P);
    interstage.position.y = yCursor;
    root.add(interstage);
    yCursor += P.interstageLen;

    const s2 = buildSecondStage(P);
    s2.position.y = yCursor;
    root.add(s2);

    // Upper-stage plume (off by default, drives nicely from same throttle)
    const s2Plume = buildKeroloxPlume(cR * 0.7, cR * 4);
    s2Plume.position.y = yCursor - 0.4;
    plumes.push(s2Plume);
    root.add(s2Plume);

    yCursor += P.upperStageLen;

    if (P.payload === 'fairing') {
        const fairing = buildFairing(P);
        fairing.position.y = yCursor;
        root.add(fairing);
        yCursor += P.fairingLen;
    } else if (P.payload === 'crew_dragon') {
        const dragon = buildCrewDragon(P);
        dragon.position.y = yCursor;
        root.add(dragon);
        yCursor += 8.0;     // trunk + capsule + nose cone
    }

    const totalH = yCursor;

    // Side-core nose adds to envelope only when it's taller than the
    // center-stack height — typically not the case on Falcon Heavy.
    const sideTop = P.cores === 3 ? P.boosterLen + P.sideNoseLen : 0;
    const visualH = Math.max(totalH, sideTop);

    // Thrust spec — all 9 Merlins per booster fire at liftoff. Falcon
    // Heavy adds 2× side cores, so total = 27 Merlins. Block 5 Merlin 1D
    // SL thrust = 854 kN.
    const merlinSl  = ENGINES.merlin_1d.sl_kn;
    const totalEnginesSl = P.boosterEngines;        // already accounts for side cores
    const liftoffKn  = totalEnginesSl * merlinSl;
    const massT      = P.cores === 3 ? 1420 : 549;
    const twrInitial = liftoffKn / (massT * 9.80665);

    const info = {
        name:           P.label,
        years:          P.years,
        height_m:       visualH.toFixed(1),
        diameter_m:     P.cores === 3
            ? `${(P.diameter * 3).toFixed(1)} (3 cores)`
            : P.diameter.toFixed(2),
        booster_engines:`${P.boosterEngines} ${ENGINES.merlin_1d.name}`,
        ship_engines:   `${P.upperEngines} ${ENGINES.merlin_vac.name}`,
        liftoff_mass_t: P.cores === 3 ? '1,420' : '549',
        leo_payload_t:  P.cores === 3 ? '63.8' : (P.payload === 'crew_dragon' ? '~12 (crew)' : '22.8'),
        notes:          P.notes,
        thrust: {
            liftoff_kn:    liftoffKn,
            liftoff_mn:    liftoffKn / 1000,
            per_engine_kn: merlinSl,
            engine_count:  totalEnginesSl,
            booster_engine: ENGINES.merlin_1d.name,
            upper_engine:   ENGINES.merlin_vac.name,
            propellant:     ENGINES.merlin_1d.propellant,
            twr_initial:   twrInitial,
            mass_t:        massT,
            // Comparison-bar id — keeps the highlight in lockstep
            // with the REFERENCE_THRUSTS table.
            ref_id:        P.cores === 3 ? 'falcon9_heavy' : 'falcon9_b5',
        },
    };

    // Engine layout — one entry per visible engine, used by the thrust-
    // vector overlay. y is the engine bell exit (where the plume + arrow
    // attach); coordinates are in vehicle-root local space.
    const ER = P.diameter / 2;
    function octaweb(xOffset = 0) {
        const arr = [
            { x: xOffset, y: -1.6, z: 0,
              thrust_kn: ENGINES.merlin_1d.sl_kn, gimbal: true, ring: 'inner' },
        ];
        for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
            arr.push({
                x: xOffset + Math.cos(a) * ER * 0.62,
                y: -1.6,
                z: Math.sin(a) * ER * 0.62,
                thrust_kn: ENGINES.merlin_1d.sl_kn,
                gimbal: true,
                ring: 'outer',
            });
        }
        return arr;
    }

    let boosterEngines = octaweb(0);
    if (P.cores === 3) {
        const off = P.diameter * 1.02;
        boosterEngines = boosterEngines
            .concat(octaweb(-off))
            .concat(octaweb( off));
    }
    const upperEngines = [{
        x: 0,
        y: P.boosterLen + P.interstageLen - 0.4,
        z: 0,
        thrust_kn: ENGINES.merlin_vac.vac_kn,
        gimbal: true,
        ring: 'vac',
    }];

    const engineLayout = { boosterEngines, upperEngines };

    return {
        root, plumes, height: visualH, info,
        padId: 'lc39a', engineLayout,
    };
}

export const FALCON9_VARIANT_IDS = Object.keys(FALCON_VARIANTS);
export function falcon9VariantLabel(id) {
    return FALCON_VARIANTS[id]?.label || id;
}
