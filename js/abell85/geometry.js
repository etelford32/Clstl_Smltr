// geometry.js — full 3D orbital orientation and merger kinematics, shared by
// the lab (main.js), the cinematic (cinema.js), and the twins (twin.js).
//
// Before this module the binary lived in a single plane tilted about the
// x-axis and the recoil kick fired along world x̂ — the merger read as 2D.
// Now each system carries a complete orientation (inclination i + line of
// nodes Ω), and the kick direction is *physical*:
//
//   · non-spinning (mass-asymmetry) recoils lie IN the orbital plane
//     (González et al. 2007),
//   · superkicks are directed along ±L̂ — the orbital angular momentum axis
//     (Campanelli et al. 2007; Lousto & Zlochower 2011) — so a spun-up
//     remnant punches OUT of its orbital plane through the star cluster.
//
// DOM-free; unit-tested in tests/abell85-physics.mjs.

/**
 * Orthonormal basis of an orbital plane with inclination `incl` (tilt about
 * the world x-axis) and ascending-node rotation `node` (about world y).
 * Returns { e1, e2, n }: in-plane axes and the plane normal (∥ L̂).
 */
export function orbitalBasis(incl = 0, node = 0) {
    const si = Math.sin(incl), ci = Math.cos(incl);
    const sn = Math.sin(node), cn = Math.cos(node);
    // plane spanned by world X,Z (normal Y), oriented by v' = Ry(node)·Rx(incl)·v
    const rx = (v) => [v[0], ci * v[1] - si * v[2], si * v[1] + ci * v[2]];
    const ry = (v) => [cn * v[0] + sn * v[2], v[1], -sn * v[0] + cn * v[2]];
    const T = (v) => ry(rx(v));
    return { e1: T([1, 0, 0]), e2: T([0, 0, 1]), n: T([0, 1, 0]) };
}

/** Map in-plane coordinates (u along e1, w along e2) to world xyz. */
export function toWorld(basis, u, w) {
    return [
        basis.e1[0] * u + basis.e2[0] * w,
        basis.e1[1] * u + basis.e2[1] * w,
        basis.e1[2] * u + basis.e2[2] * w,
    ];
}

function keplerSolve(M, e) {
    let E = M;
    for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    return E;
}

/**
 * World positions of the two holes for a Kepler state (a, e, mean phase,
 * periapsis angle) in the oriented plane. Center of mass at the origin.
 */
export function binaryWorldPositions(sc, now, phase, basis) {
    const E = keplerSolve(phase, now.e);
    const r = now.a * (1 - now.e * Math.cos(E));
    const nu = 2 * Math.atan2(Math.sqrt(1 + now.e) * Math.sin(E / 2),
        Math.sqrt(1 - now.e) * Math.cos(E / 2));
    const ang = nu + now.peri;
    const u = r * Math.cos(ang), w = r * Math.sin(ang);
    const f1 = sc.m2 / sc.mTot, f2 = sc.m1 / sc.mTot;
    const p1 = toWorld(basis, u * f1, w * f1);
    const p2 = toWorld(basis, -u * f2, -w * f2);
    return [{ p: p1, m: sc.m1 }, { p: p2, m: sc.m2 }];
}

/**
 * Physical recoil-kick direction (world unit vector).
 *   'nonspinning' → in the orbital plane, at a deterministic azimuth
 *                   (the true azimuth depends on the merger phase — random
 *                   in nature, fixed here for reproducibility);
 *   'superkick'   → along ±n̂ = ±L̂, out of the plane.
 */
export function kickDirection(mode, basis, azimuth = 0.9) {
    if (mode === 'superkick') return [...basis.n];
    const c = Math.cos(azimuth), s = Math.sin(azimuth);
    return toWorld(basis, c, s);
}

/**
 * World position of the merged remnant on its damped oscillation along the
 * 3D kick axis (Gualandris & Merritt 2008 phases, as in physics.buildHistory).
 */
export function remnantWorldPosition(sc, history, now, basis) {
    const rem = history.events.remnant;
    const dir = kickDirection(sc.kick === 'superkick' ? 'superkick' : 'nonspinning', basis);
    const dtM = now.t - history.events.merger;
    const osc = history.events.recoil
        ? Math.sin(Math.min(dtM * history.events.recoil.omega, 1e6)) : 0;
    const off = (now.remnantOffset ?? 0) * osc;
    return [{
        p: [dir[0] * off, dir[1] * off, dir[2] * off],
        m: rem ? rem.mass : sc.mTot,
    }];
}

/**
 * One call for every surface: binary positions before coalescence, the
 * kicked remnant after.
 */
export function bodiesAt(sc, history, now, phase, basis) {
    if (now.a <= 0) return remnantWorldPosition(sc, history, now, basis);
    return binaryWorldPositions(sc, now, phase, basis);
}
