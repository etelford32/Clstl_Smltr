/**
 * bootes-web-model.js — the surrounding cosmic web, as a seeded model
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No DOM, no fetch, no ambient time, no three.js. Deterministic: the
 * same seed and options always produce the same web, byte for byte, which is
 * what lets `tests/bootes-web-model.mjs` pin statistical claims about it.
 *
 * THIS FILE IS A MODEL AND NOTHING IN IT IS AN OBSERVATION
 * ───────────────────────────────────────────────────────
 * Say it plainly, because the rendered result looks like a galaxy survey and
 * will be screenshotted by people who did not read this header: the filaments,
 * nodes and tracer galaxies below are SYNTHESISED. They are not a
 * reconstruction of the observed density field around Boötes; this repo has no
 * galaxy catalogue and astronomy archives are egress-blocked at build time.
 * bootes-void.html states this on the page, next to the render, permanently.
 *
 * What IS constrained, and constrained tightly:
 *
 *   1. MASS. The web carries exactly the compensating-wall mass of the void
 *      profile — `wallMassMsun(voidProfile)` — no more and no less. Nobody
 *      typed a mass in.
 *   2. RADIAL DISTRIBUTION. Particle radii are drawn from the profile's own
 *      δ⁺(r) r² measure by inverse-CDF sampling, so the spherically-averaged
 *      wall of the clumped model is the smooth wall, exactly.
 *   3. DIRECTIONS. The angular distribution is biased towards where the real
 *      rich clusters around Boötes actually sit (js/bootes-void-data.js), so
 *      the web is oriented like the real one rather than isotropically.
 *
 * WHY THAT DESIGN, AND NOT "GIVE EACH CLUSTER ITS PUBLISHED MASS"
 * ──────────────────────────────────────────────────────────────
 * Because of what the page is trying to measure. Test 5 asks whether the void
 * or the surrounding filaments dominate the local gravitational force. If the
 * filament masses were invented — and any mass typed in from memory for a
 * supercluster is invented, they are uncertain at the factor-of-two level —
 * then the answer would be a function of what somebody typed, and the whole
 * result would be circular.
 *
 * Constraining the total to the profile's own wall removes that freedom
 * completely. The monopole of the clumped model and the monopole of the smooth
 * model are identical by construction, so the ONLY thing that differs between
 * them is how the mass is arranged. "Void or filament?" then becomes a
 * question about GEOMETRY, which is a question a model can honestly answer.
 *
 * `clumpiness` is the one knob that matters and it is exposed on the page: 0
 * puts the wall mass in a near-uniform shell (the smooth limit, where the web
 * contributes almost no force beyond what the spherical profile already
 * carries), 1 concentrates it hard into nodes and the filaments between them.
 * Sweeping it is the sensitivity analysis, and it is why the page reports
 * R_influence as a curve against clumpiness rather than as one number.
 *
 * THE COUNTERFACTUAL IS EXACT, NOT DIFFERENCED
 * ────────────────────────────────────────────
 * Model A = spherical deficit + discrete wall particles
 * Model B = ................. + discrete wall particles      ("no Boötes")
 * Δg      = spherical deficit                                 ← analytic
 *
 * The particles are IDENTICAL in both models — same seed, same positions, same
 * masses — so they cancel exactly rather than to four digits. See
 * `splitProfile` in js/bootes-void-model.js for the other half of that
 * argument. Differencing two independently-summed particle fields would lose
 * precision in exactly the outskirts where the R_influence answer lives.
 */

import {
    G_SI, MPC_M, MSUN_KG, COSMOLOGY,
    splitProfile, wallMassMsun, meanMatterDensityMsunMpc3,
    pointGravityVector, pointTidalTensor, symmetricEigen,
    voidGravityVector, voidTidalTensor, galaxyContrastFromMatter,
} from './bootes-void-model.js';

// ── Deterministic randomness ────────────────────────────────────────────────

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * SEEDED AND NOT Math.random() FOR A REASON THAT IS NOT REPRODUCIBILITY ALONE.
 * The page lets you re-roll the web to see how much the answer moves. If the
 * web changed on every frame or every reload, the R_influence number would
 * jitter and a reader would have no way to tell model variance from a control
 * they just moved. Seeded means "re-roll" is a deliberate act with a visible
 * seed number next to it.
 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Normalise a 3-vector in place-free fashion. Returns [0,0,1] for a zero. */
function normalise(v) {
    const n = Math.hypot(v[0], v[1], v[2]);
    if (n < 1e-12) return [0, 0, 1];
    return [v[0] / n, v[1] / n, v[2] / n];
}

/** Any unit vector orthogonal to `v`. */
function orthogonal(v) {
    const a = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return normalise([
        a[1] * v[2] - a[2] * v[1],
        a[2] * v[0] - a[0] * v[2],
        a[0] * v[1] - a[1] * v[0],
    ]);
}

/**
 * Draw a unit vector from a von Mises–Fisher distribution about `mu` with
 * concentration κ. κ = 0 is uniform on the sphere; large κ clusters tightly.
 *
 * Used for the angular bias towards the real cluster directions. The
 * closed-form inversion for the polar angle (Wood 1994's w-sampling reduced to
 * the 3-sphere case) rather than rejection sampling, because rejection
 * sampling's variable cost showed up as a stutter when the page re-rolls the
 * web at high clumpiness — exactly when κ is largest and acceptance is worst.
 */
function sampleVMF(mu, kappa, rng) {
    if (kappa < 1e-6) {
        const z = 2 * rng() - 1;
        const phi = 2 * Math.PI * rng();
        const s = Math.sqrt(Math.max(0, 1 - z * z));
        return [s * Math.cos(phi), s * Math.sin(phi), z];
    }
    const u = rng();
    const w = 1 + Math.log(u + (1 - u) * Math.exp(-2 * kappa)) / kappa;
    const phi = 2 * Math.PI * rng();
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    const e1 = orthogonal(mu);
    const e2 = [
        mu[1] * e1[2] - mu[2] * e1[1],
        mu[2] * e1[0] - mu[0] * e1[2],
        mu[0] * e1[1] - mu[1] * e1[0],
    ];
    return normalise([
        w * mu[0] + s * (Math.cos(phi) * e1[0] + Math.sin(phi) * e2[0]),
        w * mu[1] + s * (Math.cos(phi) * e1[1] + Math.sin(phi) * e2[1]),
        w * mu[2] + s * (Math.cos(phi) * e1[2] + Math.sin(phi) * e2[2]),
    ]);
}

/**
 * Inverse-CDF sampler over the wall's own radial mass measure, δ⁺(r) r² dr.
 *
 * THIS IS WHAT KEEPS THE MONOPOLE HONEST. Sampling radii any other way — a
 * Gaussian shell, a uniform band, "somewhere near R_v" — changes the
 * spherically-averaged wall and therefore changes the total enclosed mass as a
 * function of r. The clumped model would then differ from the smooth model in
 * its monopole as well as its clumping, and the counterfactual would no longer
 * be measuring only the thing it claims to measure.
 */
function makeRadialSampler(wallProfile, nBins = 600) {
    const rMax = wallProfile.rMaxMpc;
    const dr = rMax / nBins;
    const cdf = new Float64Array(nBins + 1);
    for (let i = 1; i <= nBins; i++) {
        const r = i * dr;
        cdf[i] = cdf[i - 1] + Math.max(0, wallProfile.deltaAt(r)) * r * r * dr;
    }
    const total = cdf[nBins];
    return (rng) => {
        if (total <= 0) return wallProfile.params.rvMpc;
        const target = rng() * total;
        let lo = 0, hi = nBins;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (cdf[mid] < target) lo = mid; else hi = mid;
        }
        const span = cdf[hi] - cdf[lo];
        const frac = span > 0 ? (target - cdf[lo]) / span : 0;
        return (lo + frac) * dr;
    };
}

// ── The web ─────────────────────────────────────────────────────────────────

/**
 * Build the synthetic cosmic web around a void.
 *
 * Options
 *   voidProfile    the full HSW profile. Its WALL half becomes the web.
 *   anchors        resolved anchors from js/bootes-void-data.js. Their
 *                  directions bias node placement; their `massHintMsun` sets
 *                  only the RELATIVE weight between them.
 *   seed           integer. Same seed ⇒ same web.
 *   nodeCount      number of web nodes (cluster-scale concentrations).
 *   filamentParticles  particles distributed along the filament graph.
 *   clumpiness     0 → near-uniform shell, 1 → hard concentration. The
 *                  sensitivity knob; see the header.
 *   softeningMpc   Plummer softening. Defaults to the mean particle spacing,
 *                  which is the length scale below which a chain of particles
 *                  stops standing in for a continuous filament.
 */
export function createCosmicWeb({
    voidProfile,
    anchors = [],
    seed = 20260907,
    nodeCount = 42,
    filamentParticles = 760,
    clumpiness = 0.65,
    softeningMpc = null,
    z = 0,
    cosmo = COSMOLOGY,
} = {}) {
    const rng = mulberry32(seed);
    const { wall } = splitProfile(voidProfile);
    const totalWallMass = wallMassMsun(voidProfile, cosmo);
    const sampleRadius = makeRadialSampler(wall);

    // Concentration ramps with clumpiness. κ = 0 is isotropic; κ ≈ 22 puts
    // most of a node's probability inside ~25° of its anchor, which is about
    // the angular size of a supercluster seen from the middle of this void.
    const kappa = 0.5 + 34 * clumpiness * clumpiness;

    // Anchors become the directional attractors. Weight is the mass hint,
    // normalised — RELATIVE only, per this file's header and the data file's.
    const attractors = anchors.length
        ? anchors.map(a => ({ dir: normalise(a.directionFromVoid), w: a.massHintMsun, id: a.id }))
        : [];
    const weightTotal = attractors.reduce((s, a) => s + a.w, 0) || 1;

    /** Pick an attractor by weight, or null for the isotropic background. */
    const pickAttractor = () => {
        if (!attractors.length) return null;
        // A fraction of nodes stay unattached to any anchor. The real web is
        // not made only of the structures that have Abell numbers, and a web
        // built purely from the catalogue would concentrate the entire wall
        // into nine directions and overstate the anisotropy badly.
        if (rng() > 0.35 + 0.5 * clumpiness) return null;
        let t = rng() * weightTotal;
        for (const a of attractors) { t -= a.w; if (t <= 0) return a; }
        return attractors[attractors.length - 1];
    };

    // ── Nodes ───────────────────────────────────────────────────────────────
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
        const att = pickAttractor();
        const dir = att ? sampleVMF(att.dir, kappa, rng) : sampleVMF([0, 0, 1], 0, rng);
        const r = sampleRadius(rng);
        nodes.push({
            index: i,
            anchorId: att ? att.id : null,
            direction: dir,
            radiusMpc: r,
            offsetMpc: [dir[0] * r, dir[1] * r, dir[2] * r],
            massMsun: 0,
        });
    }

    // ── Filaments: a mutual-nearest-neighbour graph over the nodes ──────────
    //
    // k = 2 rather than a Delaunay triangulation or a minimum spanning tree.
    // An MST gives a single connected tree with no loops, which does not look
    // or behave like a cosmic web (the real one is multiply connected); a full
    // triangulation on a shell connects almost everything to almost everything
    // and washes the anisotropy out. Two nearest neighbours per node, deduped,
    // gives a network with loops, dead ends and a few long spans — which is
    // what a wall actually is.
    const filaments = [];
    const seen = new Set();
    for (const node of nodes) {
        const others = nodes
            .filter(n => n !== node)
            .map(n => ({
                n,
                d: Math.hypot(
                    n.offsetMpc[0] - node.offsetMpc[0],
                    n.offsetMpc[1] - node.offsetMpc[1],
                    n.offsetMpc[2] - node.offsetMpc[2]),
            }))
            .sort((a, b) => a.d - b.d);
        for (const cand of others.slice(0, 2)) {
            const key = node.index < cand.n.index
                ? `${node.index}-${cand.n.index}` : `${cand.n.index}-${node.index}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const dir = normalise([
                cand.n.offsetMpc[0] - node.offsetMpc[0],
                cand.n.offsetMpc[1] - node.offsetMpc[1],
                cand.n.offsetMpc[2] - node.offsetMpc[2],
            ]);
            filaments.push({
                a: node.index,
                b: cand.n.index,
                lengthMpc: cand.d,
                direction: dir,
                midpointMpc: [
                    0.5 * (node.offsetMpc[0] + cand.n.offsetMpc[0]),
                    0.5 * (node.offsetMpc[1] + cand.n.offsetMpc[1]),
                    0.5 * (node.offsetMpc[2] + cand.n.offsetMpc[2]),
                ],
            });
        }
    }

    // ── Mass budget ─────────────────────────────────────────────────────────
    //
    // Nodes take a share that grows with clumpiness; the filaments take the
    // rest. At clumpiness 0 the nodes are nearly massless and the mass sits in
    // the filament particles, which — because their radii come from the same
    // δ⁺(r) r² measure and their directions are near-isotropic — is very close
    // to a smooth shell. That is the intended smooth limit.
    const nodeShare = 0.15 + 0.45 * clumpiness;
    const nodeMassTotal = totalWallMass * nodeShare;
    const filamentMassTotal = totalWallMass - nodeMassTotal;

    // Node masses follow their attractor's weight so the real rich clusters
    // end up as the heavy nodes, with a floor so unattached nodes are not zero.
    const nodeWeights = nodes.map(n => {
        const att = attractors.find(a => a.id === n.anchorId);
        return att ? att.w : 0.25 * (weightTotal / Math.max(1, attractors.length));
    });
    const nodeWeightSum = nodeWeights.reduce((s, w) => s + w, 0) || 1;
    nodes.forEach((n, i) => { n.massMsun = nodeMassTotal * nodeWeights[i] / nodeWeightSum; });

    // ── Filament particles ──────────────────────────────────────────────────
    //
    // Distributed along the segments proportional to length, then RE-SEATED
    // onto a radius drawn from the wall measure. The re-seating is what keeps
    // the radial monopole exact: a straight chord between two shell nodes cuts
    // INSIDE the shell, and a web built from chords alone quietly moves wall
    // mass inward by several Mpc, which shows up as a spurious extra inward
    // pull right where the void's own outward pull is being measured.
    const particles = [];
    for (const node of nodes) {
        particles.push({ offsetMpc: node.offsetMpc, massMsun: node.massMsun, kind: 'node' });
    }
    const totalLength = filaments.reduce((s, f) => s + f.lengthMpc, 0) || 1;
    for (const fil of filaments) {
        const share = fil.lengthMpc / totalLength;
        const count = Math.max(2, Math.round(filamentParticles * share));
        const massEach = filamentMassTotal * share / count;
        const A = nodes[fil.a].offsetMpc;
        const B = nodes[fil.b].offsetMpc;
        for (let i = 0; i < count; i++) {
            const t = (i + 0.5) / count;
            const raw = [
                A[0] + (B[0] - A[0]) * t,
                A[1] + (B[1] - A[1]) * t,
                A[2] + (B[2] - A[2]) * t,
            ];
            // Small transverse jitter so a filament has thickness, then
            // re-seat onto a wall-measure radius.
            const dir = normalise(raw);
            const perp = orthogonal(dir);
            const jitter = (rng() - 0.5) * 12 * (1 - 0.6 * clumpiness);
            const r = sampleRadius(rng);
            particles.push({
                offsetMpc: [
                    dir[0] * r + perp[0] * jitter,
                    dir[1] * r + perp[1] * jitter,
                    dir[2] * r + perp[2] * jitter,
                ],
                massMsun: massEach,
                kind: 'filament',
                filament: fil,
            });
        }
    }

    // Mean particle spacing sets the softening — below it, a chain of point
    // masses stops standing in for a continuous filament and starts reporting
    // the sampling.
    const meanRadius = particles.reduce((s, p) => s + Math.hypot(...p.offsetMpc), 0)
        / Math.max(1, particles.length);
    const eps = softeningMpc ?? Math.max(4, 2.2 * meanRadius / Math.sqrt(particles.length));

    /**
     * Peculiar gravity from the web alone, m/s². `offset` is measured FROM THE
     * VOID CENTRE, in comoving Mpc.
     *
     * `z` must match whatever the void half of the comparison was evaluated at
     * — see the (1+z)² note on `pointGravityVector`. It is bound at
     * construction rather than passed per call so the two halves of a
     * counterfactual cannot be evaluated at different redshifts, which is
     * exactly how the 10 % bias got in the first time.
     */
    function externalGravityAt(offset) {
        let gx = 0, gy = 0, gz = 0;
        for (const p of particles) {
            const g = pointGravityVector(offset, p.offsetMpc, p.massMsun, eps, z);
            gx += g[0]; gy += g[1]; gz += g[2];
        }
        return [gx, gy, gz];
    }

    /** Tidal tensor from the web alone, in units of 4πGρ̄_m. */
    function externalTidalAt(offset) {
        const acc = new Array(9).fill(0);
        for (const p of particles) {
            const t = pointTidalTensor(offset, p.offsetMpc, p.massMsun, eps, cosmo);
            for (let i = 0; i < 9; i++) acc[i] += t[i];
        }
        return acc;
    }

    return {
        seed, clumpiness, z, softeningMpc: eps,
        nodes, filaments, particles,
        totalMassMsun: particles.reduce((s, p) => s + p.massMsun, 0),
        wallMassMsun: totalWallMass,
        externalGravityAt,
        externalTidalAt,
    };
}

// ── The A/B experiment (Test 4) ─────────────────────────────────────────────

/**
 * Evaluate both universes at one point, and their difference.
 *
 * `offset` is measured FROM THE VOID CENTRE, in comoving Mpc.
 *
 * Returns, for each of A ("real"), B ("no Boötes") and Δ = A − B:
 *   gravity        m/s², peculiar
 *   tidal          3×3, in units of 4πGρ̄_m
 *   eigen          eigenvalues descending, with eigenvectors
 * plus `voidShare`, the fraction of the total peculiar acceleration magnitude
 * that comes from the void — the number Test 5 is really about.
 *
 * The deficit field is computed ANALYTICALLY from the split profile and the
 * web term is bit-identical between A and B, so Δ carries no cancellation
 * error at all. See this file's header.
 */
export function counterfactualAt(offset, { voidProfile, web, z = 0, cosmo = COSMOLOGY }) {
    const { deficit } = splitProfile(voidProfile);
    const gVoid = voidGravityVector(offset, [0, 0, 0], deficit, { z, cosmo });
    const gWeb = web.externalGravityAt(offset);
    const tVoid = voidTidalTensor(offset, [0, 0, 0], deficit);
    const tWeb = web.externalTidalAt(offset);

    const gA = [gVoid[0] + gWeb[0], gVoid[1] + gWeb[1], gVoid[2] + gWeb[2]];
    const tA = tVoid.map((v, i) => v + tWeb[i]);
    const magVoid = Math.hypot(gVoid[0], gVoid[1], gVoid[2]);
    const magWeb = Math.hypot(gWeb[0], gWeb[1], gWeb[2]);

    return {
        A: { gravity: gA, tidal: tA, eigen: symmetricEigen(tA) },
        B: { gravity: gWeb, tidal: tWeb, eigen: symmetricEigen(tWeb) },
        delta: { gravity: gVoid, tidal: tVoid, eigen: symmetricEigen(tVoid) },
        voidShare: (magVoid + magWeb) > 0 ? magVoid / (magVoid + magWeb) : 0,
        magVoid, magWeb,
    };
}

/**
 * Test 5's alignment measurement — with the trap that makes it easy to get
 * wrong spelled out, because it invalidates the obvious version entirely.
 *
 * THE DEGENERACY TRAP. A spherically symmetric void's tidal tensor has TWO
 * equal eigenvalues: λ_radial once, and λ_tangential TWICE (see
 * `tidalEigenvalues`). The two tangential eigenvectors are therefore
 * degenerate, and any orthonormal pair spanning the tangent plane is a valid
 * eigenbasis — which one an eigen-solver returns is an artefact of its
 * arithmetic, not a physical direction. So "are filaments aligned with e₂ or
 * e₃ of the void's tidal field?" is not a question with an answer. Asking it
 * anyway returns a number that looks like a measurement and is noise.
 *
 * The only orientation a spherical void defines is its RADIAL axis, which is
 * e₁ (most compressive) outside r_s. So the physically meaningful prediction
 * is that filaments lie PERPENDICULAR to the radial direction — tangentially,
 * in the wall — and the statistic that tests it is |cos θ| against e₁, which
 * should fall BELOW the isotropic 0.5. That is what `axis: 1` measures and it
 * is the default.
 *
 * `which` selects the field: 'total' (model A), 'web' (model B), or 'void'
 * (the counterfactual difference — the void's own tidal contribution).
 *
 * BE HONEST ABOUT WHAT THIS CAN AND CANNOT SHOW HERE:
 *
 *   'web'   is CIRCULAR and the page labels it so. The filaments were drawn
 *           between the same particles whose tidal field is being measured, so
 *           near a segment's midpoint the tensor is dominated by that
 *           segment's own particles. It returns |cos θ| ≈ 0.95 and that number
 *           measures the construction, not the universe. It is kept only as
 *           the positive control — a statistic that cannot detect a known
 *           alignment is broken, and this is how you check it can.
 *
 *   'void'  is the meaningful one. The void's tidal field was NOT used to
 *           place anything — the filaments were placed from cluster directions
 *           and a nearest-neighbour graph. Any alignment with it is emergent
 *           geometry. This is the row the page reports as a result.
 */
export function filamentAlignment({
    voidProfile, web, which = 'void', axis = 1, z = 0, cosmo = COSMOLOGY,
}) {
    const { deficit } = splitProfile(voidProfile);
    const index = axis === 1 ? 0 : axis === 2 ? 1 : 2;
    let sum = 0;
    const perSegment = [];
    for (const fil of web.filaments) {
        const p = fil.midpointMpc;
        let tensor;
        if (which === 'web') tensor = web.externalTidalAt(p);
        else if (which === 'void') tensor = voidTidalTensor(p, [0, 0, 0], deficit);
        else {
            const tv = voidTidalTensor(p, [0, 0, 0], deficit);
            const tw = web.externalTidalAt(p);
            tensor = tv.map((v, i) => v + tw[i]);
        }
        const { values, vectors } = symmetricEigen(tensor);
        const e = vectors[index];
        const c = Math.abs(fil.direction[0] * e[0] + fil.direction[1] * e[1] + fil.direction[2] * e[2]);
        sum += c;
        // The degeneracy gap travels with the result so a caller can see when
        // the eigenvector it asked for was not uniquely defined.
        const gap = Math.abs(values[0] - values[2]) > 0
            ? Math.abs(values[index] - values[index === 0 ? 1 : index - 1])
                / Math.abs(values[0] - values[2])
            : 0;
        perSegment.push({ filament: fil, absCos: c, eigenGap: gap });
    }
    const n = web.filaments.length;
    if (!n) {
        return { which, axis, meanAbsCos: 0.5, isotropic: 0.5, z: 0, n: 0, perSegment,
            circular: which === 'web', minEigenGap: 0 };
    }
    const mean = sum / n;
    // Var(|cos θ|) = 1/12 for isotropic directions in 3D, exactly. So the
    // isotropic 1σ on the MEAN is √(1/12n) — with 56 segments that is 0.039,
    // which is why a mean of 0.53 is not a result and the page prints the
    // z-score rather than the mean.
    const sigma = Math.sqrt((1 / 12) / n);
    return {
        which, axis,
        meanAbsCos: mean,
        isotropic: 0.5,
        z: (mean - 0.5) / sigma,
        n,
        perSegment,
        circular: which === 'web',
        minEigenGap: Math.min(...perSegment.map(s => s.eigenGap)),
    };
}

// ── Tracer galaxies (visual, and honest about it) ───────────────────────────

/**
 * Sample tracer galaxies from the modelled galaxy field, 1 + δ_g.
 *
 * VISUAL ONLY. These carry no mass and enter no calculation — the gravity
 * comes from the wall particles above, whose mass is pinned to the profile.
 * They exist so the page can show what a survey of this modelled region WOULD
 * look like, including the redshift-space distortion of it, which is a claim
 * about the model and not about the sky.
 *
 * Rejection sampling against 1 + δ_g, with a boost towards filament particles
 * so galaxies trace the web rather than a smooth shell. `bias` converts the
 * matter profile to a galaxy profile — the same one-line linear bias the whole
 * page's error budget hangs on.
 */
export function sampleTracers({
    voidProfile, web, count = 2600, bias = 1.5, seed = 991,
    rMaxMpc = null, cosmo = COSMOLOGY,
} = {}) {
    const rng = mulberry32(seed);
    const rMax = rMaxMpc ?? voidProfile.params.rvMpc * 2.6;
    const out = [];
    // The maximum of 1 + δ_g over the sampled range, for rejection.
    let peak = 1;
    for (let r = 0; r <= rMax; r += 1) {
        peak = Math.max(peak, 1 + galaxyContrastFromMatter(voidProfile.deltaAt(r), bias));
    }
    let guard = 0;
    while (out.length < count && guard < count * 400) {
        guard++;
        // Uniform in the ball: r ∝ u^(1/3).
        const u = rng();
        const r = rMax * Math.cbrt(u);
        const z0 = 2 * rng() - 1;
        const phi = 2 * Math.PI * rng();
        const s = Math.sqrt(Math.max(0, 1 - z0 * z0));
        const dir = [s * Math.cos(phi), s * Math.sin(phi), z0];
        const dg = galaxyContrastFromMatter(voidProfile.deltaAt(r), bias);
        if (rng() * peak > Math.max(0, 1 + dg)) continue;
        const pos = [dir[0] * r, dir[1] * r, dir[2] * r];
        out.push({ offsetMpc: pos, radiusMpc: r, deltaG: dg });
    }
    // Web-following extra: draw a share of the tracers directly onto filament
    // particles, so the render shows structure rather than a fuzzy shell.
    const webShare = Math.round(count * 0.45);
    for (let i = 0; i < webShare && web?.particles?.length; i++) {
        const p = web.particles[Math.floor(rng() * web.particles.length)];
        const spread = p.kind === 'node' ? 7 : 4.5;
        const pos = [
            p.offsetMpc[0] + (rng() - 0.5) * spread * 2,
            p.offsetMpc[1] + (rng() - 0.5) * spread * 2,
            p.offsetMpc[2] + (rng() - 0.5) * spread * 2,
        ];
        out.push({
            offsetMpc: pos,
            radiusMpc: Math.hypot(pos[0], pos[1], pos[2]),
            deltaG: galaxyContrastFromMatter(voidProfile.deltaAt(Math.hypot(...pos)), bias),
            onWeb: true,
        });
    }
    return out;
}

/**
 * The web's own mean density check — the assertion that the redistribution
 * conserved what it was supposed to conserve.
 *
 * Returns the ratio of the discrete wall's spherically-averaged enclosed mass
 * to the smooth wall's, at a set of radii. Every entry should be ≈ 1; the test
 * asserts it to 3 % (the residual is Poisson noise from the finite particle
 * count, and 3 % is what ~800 particles buys).
 */
export function monopoleFidelity(web, voidProfile, radiiMpc = [60, 92, 120, 160, 240], cosmo = COSMOLOGY) {
    const { wall } = splitProfile(voidProfile);
    const rho = meanMatterDensityMsunMpc3(cosmo);
    return radiiMpc.map(r => {
        let discrete = 0;
        for (const p of web.particles) {
            if (Math.hypot(p.offsetMpc[0], p.offsetMpc[1], p.offsetMpc[2]) <= r) discrete += p.massMsun;
        }
        const smooth = (4 / 3) * Math.PI * r * r * r * rho * wall.integratedAt(r);
        return { radiusMpc: r, discreteMsun: discrete, smoothMsun: smooth,
            // null, not 1, where the smooth wall carries no mass yet (inside
            // r_s). A ratio of "1" there would read as a passing check on a
            // quantity that was never tested.
            ratio: Math.abs(smooth) > 1e-6 * Math.abs(web.wallMassMsun) ? discrete / smooth : null };
    });
}
