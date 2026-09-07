/**
 * bootes-void-data.js — the measured inputs, and only the measured inputs
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE data + coordinate conversion. No DOM, no fetch, no three.js.
 *
 * THIS FILE IS THE PROVENANCE BOUNDARY. Everything in here is either a
 * published measurement with a citation, or a conversion of one. Everything
 * downstream — the continuous density field, the filament network, the tracer
 * galaxies — is MODEL, and js/bootes-web-model.js says so in its own header.
 * If a number on bootes-void.html is presented as observed, it has to come
 * from this file or from a route; there is no third source.
 *
 * WHY THE COORDINATES ARE TYPED IN AND NOT FETCHED
 * ────────────────────────────────────────────────
 * Astronomy archives (VizieR, SDSS SkyServer, NED) are egress-blocked in this
 * repo's build environment, exactly as NASA is for sun.html's SDO fixtures.
 * So the anchors below are transcribed from the literature at the precision
 * the literature quotes, each carrying its own `source` string, and
 * `scripts/fetch-bootes-anchors.mjs` refreshes them from VizieR on a machine
 * that has the network — the same pattern as scripts/fetch-sdo-fixtures.mjs.
 *
 * Transcribed coordinates are good to about ±0.2° and ±0.002 in redshift.
 * That is FINE for what they are used for (seeding where the biggest nodes of
 * the surrounding web sit, tens of Mpc apart) and NOT fine for anything that
 * needs an identification — do not use these to cross-match a catalogue.
 * `ANCHOR_ACCURACY` carries that statement in machine-readable form so the
 * page can print it rather than the reader having to trust a comment.
 *
 * THE h⁻¹ TRAP — the reason there is a conversion function and not a constant
 * ──────────────────────────────────────────────────────────────────────────
 * The void literature quotes sizes in h⁻¹ Mpc; the popular literature quotes
 * the same numbers in Mpc and light-years having quietly set h = 1. Those
 * differ by a factor of 1/0.677 = 1.48, which is the difference between a
 * 62 Mpc void and a 92 Mpc one. The discovery paper's own headline — "a
 * million cubic megaparsec void" — is a VOLUME in h⁻³ Mpc³, and taking its
 * cube root without the h is exactly how the 1.48 gets lost. So the radius is
 * stored ONCE, in h⁻¹ Mpc, and `effectiveRadiusMpc()` is the only place it
 * becomes a physical length.
 */

import { COSMOLOGY, comovingDistanceMpc, C_KMS } from './bootes-void-model.js';

// ── The void ────────────────────────────────────────────────────────────────

/**
 * Boötes Void (the Great Void, the Supervoid), as published.
 *
 * The radius comes from the discovery paper's stated volume: a sphere of
 * 10⁶ h⁻³ Mpc³ has radius (3·10⁶/4π)^(1/3) = 62.0 h⁻¹ Mpc. Kirshner et al.
 * (1987) refined the survey and quote ≈62.5 h⁻¹ Mpc; the two agree, which is
 * why the derived value is kept rather than a rounded quote — it is
 * reproducible from a number in an abstract.
 */
export const BOOTES_VOID = Object.freeze({
    name: 'Boötes Void',
    aka: ['the Great Void', 'the Supervoid'],

    /** J2000 centre. RA 14h 50m, Dec +46°. */
    raDeg: 222.5,
    decDeg: 46.0,
    /** Heliocentric recession velocity of the void centre, km/s. */
    czKms: 15500,

    /** Effective radius, in the h⁻¹ Mpc the literature quotes. */
    effectiveRadiusHinvMpc: 62.0,
    /** The volume the radius is derived from, h⁻³ Mpc³. */
    volumeHinv3Mpc3: 1.0e6,

    /**
     * Central GALAXY density contrast. Note the tracer: this is what a
     * redshift survey measures, and it is one linear-bias step away from the
     * matter contrast the dynamics respond to.
     */
    centralGalaxyContrast: -0.87,

    /**
     * The famous count. ≈60 galaxies catalogued across the void volume where a
     * mean-density region of the same size would hold roughly 2000.
     *
     * READ THIS BEFORE COMPARING IT TO THE MODEL. Naively that ratio is
     * Δ_g(<R_eff) = −0.97, and the fitted profile gives about −0.28. They are
     * not the same measurement and the page prints both side by side rather
     * than reconciling them:
     *
     *   • The count comes from sparse pencil-beam surveys over a region whose
     *     boundary was DEFINED by emptiness. Defining a volume by its own
     *     under-density and then measuring that under-density is a selection,
     *     not an independent number.
     *   • The count is of galaxies above a survey limit, so it is a count of
     *     BRIGHT galaxies, which are the most strongly biased tracers there
     *     are, and void interiors are precisely where that bias is largest.
     *   • The profile's Δ(<R_eff) is a volume average over a fitted smooth
     *     field, which by construction includes the void's inner wall.
     *
     * The honest statement is that the void is nearly empty of BRIGHT GALAXIES
     * over its core and is about 20 % underdense in MATTER averaged inside
     * R_eff. Both are true. Only the second one drives gravity.
     */
    galaxiesObserved: 60,
    galaxiesExpectedAtMeanDensity: 2000,

    sources: [
        'Kirshner, Oemler, Schechter & Shectman 1981, ApJ 248, L57 — discovery',
        'Kirshner, Oemler, Schechter & Shectman 1987, ApJ 314, 493 — deeper survey',
        'Weistrop et al. 1992, ApJ 396, 471 — interior galaxies',
        'Szomoru et al. 1996, AJ 111, 2150 — HI survey of the void interior',
        'Cruzen et al. 2002, AJ 123, 142 — galaxy population inside the void',
    ],
});

/** Redshift of the void centre, from cz. */
export function voidRedshift(voidData = BOOTES_VOID) {
    return voidData.czKms / C_KMS;
}

/** Comoving distance to the void centre, Mpc. */
export function voidDistanceMpc(voidData = BOOTES_VOID, cosmo = COSMOLOGY) {
    return comovingDistanceMpc(voidRedshift(voidData), cosmo);
}

/**
 * Effective radius in physical (comoving) Mpc.
 *
 * THE ONE PLACE h⁻¹ BECOMES Mpc. Everything else reads this. See the header.
 */
export function effectiveRadiusMpc(voidData = BOOTES_VOID, cosmo = COSMOLOGY) {
    return voidData.effectiveRadiusHinvMpc / cosmo.h;
}

/**
 * How the count-based deficit compares with a profile's volume average — the
 * comparison the `galaxiesObserved` comment explains. Returned as a pair so
 * the page can show the disagreement instead of picking a winner.
 */
export function countBasedDeficit(voidData = BOOTES_VOID) {
    return voidData.galaxiesObserved / voidData.galaxiesExpectedAtMeanDensity - 1;
}

/** What transcribed anchor coordinates are and are not good for. */
export const ANCHOR_ACCURACY = Object.freeze({
    positionDeg: 0.2,
    redshift: 0.002,
    transcribed: true,
    note: 'Transcribed from the literature, not fetched from a catalogue. '
        + 'Adequate for placing structures tens of Mpc apart; not adequate for '
        + 'cross-matching or identification.',
    refresher: 'scripts/fetch-bootes-anchors.mjs',
});

// ── Coordinate conversion ───────────────────────────────────────────────────

const DEG = Math.PI / 180;

/**
 * Equatorial (RA, Dec, comoving distance) → comoving Cartesian Mpc, in a
 * right-handed frame centred on the observer:
 *
 *   +x towards RA 0h,  +y towards RA 6h,  +z towards the north celestial pole
 *
 * Right-handed and equatorial rather than supergalactic because every
 * coordinate in this file is published in equatorial, and one conversion that
 * everything shares beats two conventions that can disagree.
 */
export function equatorialToCartesianMpc(raDeg, decDeg, distanceMpc) {
    const ra = raDeg * DEG;
    const dec = decDeg * DEG;
    const cd = Math.cos(dec);
    return [
        distanceMpc * cd * Math.cos(ra),
        distanceMpc * cd * Math.sin(ra),
        distanceMpc * Math.sin(dec),
    ];
}

/** Inverse of the above. Returns { raDeg, decDeg, distanceMpc }. */
export function cartesianToEquatorial(vec) {
    const [x, y, z] = vec;
    const d = Math.hypot(x, y, z);
    if (d === 0) return { raDeg: 0, decDeg: 0, distanceMpc: 0 };
    let ra = Math.atan2(y, x) / DEG;
    if (ra < 0) ra += 360;
    return { raDeg: ra, decDeg: Math.asin(z / d) / DEG, distanceMpc: d };
}

/** The void centre in the observer-centred comoving frame, Mpc. */
export function voidCenterCartesian(voidData = BOOTES_VOID, cosmo = COSMOLOGY) {
    return equatorialToCartesianMpc(
        voidData.raDeg, voidData.decDeg, voidDistanceMpc(voidData, cosmo));
}

/**
 * Unit vector from the void centre towards the observer — the line of sight
 * the redshift-space mapping needs.
 *
 * This is NOT [0,0,1] or any fixed axis, and a great deal of the RSD section
 * depends on that: the void's own outflow is spherical, so every anisotropy
 * the page draws in redshift space is anisotropy about THIS direction. Wiring
 * a fixed axis in instead makes the RSD figure look right and point the wrong
 * way, which is worse than not drawing it.
 */
export function losUnitFromVoid(voidData = BOOTES_VOID, cosmo = COSMOLOGY) {
    const c = voidCenterCartesian(voidData, cosmo);
    const d = Math.hypot(c[0], c[1], c[2]);
    return [-c[0] / d, -c[1] / d, -c[2] / d];
}

// ── The named structures around the void ────────────────────────────────────

/**
 * Rich clusters and supercluster cores in the sky region around Boötes.
 *
 * WHAT THESE ARE FOR — and it is not what you would guess. They do NOT supply
 * masses to the gravity calculation. The surrounding web's mass budget is the
 * void profile's OWN compensating wall (see `wallMassMsun` in the model), so
 * that the clumped model and the smooth model agree at large radius and the
 * only thing being tested is CLUMPING. These anchors set WHERE that mass
 * concentrates: the web model biases its node placement towards the directions
 * these structures actually occupy, so the filament network around the void is
 * oriented like the real one instead of being isotropic noise.
 *
 * That distinction matters for Test 5. If the masses were invented, "does the
 * filament or the void dominate the local force?" would be a question about
 * the numbers somebody typed here. As built, it is a question about geometry.
 *
 * `massHintMsun` is an order-of-magnitude M₂₀₀ used only for RELATIVE
 * weighting between anchors. It is explicitly not a measurement and the page
 * never prints it as one.
 */
export const NEIGHBOUR_ANCHORS = Object.freeze([
    {
        id: 'a1656', name: 'Coma Cluster (Abell 1656)', kind: 'cluster',
        raDeg: 194.95, decDeg: 27.98, z: 0.0231, massHintMsun: 1.2e15,
        note: 'The dominant node of the Coma supercluster, on the near wall.',
        source: 'Abell catalogue / NED',
    },
    {
        id: 'a1367', name: 'Leo Cluster (Abell 1367)', kind: 'cluster',
        raDeg: 176.12, decDeg: 19.83, z: 0.0216, massHintMsun: 3.0e14,
        note: 'The other end of the Coma–A1367 filament of the CfA2 Great Wall.',
        source: 'Abell catalogue / NED',
    },
    {
        id: 'a2199', name: 'Abell 2199', kind: 'cluster',
        raDeg: 247.15, decDeg: 39.55, z: 0.0302, massHintMsun: 4.0e14,
        note: 'Hercules supercluster core, on the far-eastern side.',
        source: 'Abell catalogue / NED',
    },
    {
        id: 'a2151', name: 'Hercules Cluster (Abell 2151)', kind: 'cluster',
        raDeg: 241.30, decDeg: 17.75, z: 0.0367, massHintMsun: 2.0e14,
        note: 'Hercules supercluster, south-east of the void.',
        source: 'Abell catalogue / NED',
    },
    {
        id: 'a1795', name: 'Abell 1795', kind: 'cluster',
        raDeg: 207.25, decDeg: 26.58, z: 0.0625, massHintMsun: 6.0e14,
        note: 'At the void redshift, south-west on the sky — a wall node.',
        source: 'Abell catalogue / NED',
    },
    {
        id: 'a2065', name: 'Abell 2065', kind: 'cluster',
        raDeg: 230.62, decDeg: 27.71, z: 0.0726, massHintMsun: 6.0e14,
        note: 'Corona Borealis supercluster — the nearest massive structure '
            + 'behind and south of the void, and the one that dominates the '
            + 'local force field along that direction.',
        source: 'Abell catalogue / NED',
    },
    {
        id: 'a2061', name: 'Abell 2061', kind: 'cluster',
        raDeg: 230.34, decDeg: 30.65, z: 0.0784, massHintMsun: 5.0e14,
        note: 'Corona Borealis supercluster member.',
        source: 'Abell catalogue / NED',
    },
    {
        id: 'a2142', name: 'Abell 2142', kind: 'cluster',
        raDeg: 239.58, decDeg: 27.23, z: 0.0904, massHintMsun: 1.3e15,
        note: 'Massive merging cluster beyond the void’s far wall.',
        source: 'Abell catalogue / NED',
    },
    {
        id: 'a2255', name: 'Abell 2255', kind: 'cluster',
        raDeg: 258.19, decDeg: 64.06, z: 0.0806, massHintMsun: 5.0e14,
        note: 'High-declination node north-east of the void.',
        source: 'Abell catalogue / NED',
    },
]);

/**
 * Anchors resolved into the comoving Cartesian frame, with their offset from
 * the void centre — the form the web model and the page both want.
 *
 * `radiusMpc` is the 3D separation from the void centre, and it is the number
 * that decides whether an anchor is a WALL node (comparable to R_eff) or just
 * a foreground/background structure that happens to lie in the same patch of
 * sky. Coma looks close on the sky and is 130 Mpc nearer in depth; the page
 * has to be able to say that rather than drawing it on the wall.
 */
export function resolvedAnchors(voidData = BOOTES_VOID, cosmo = COSMOLOGY) {
    const center = voidCenterCartesian(voidData, cosmo);
    return NEIGHBOUR_ANCHORS.map(a => {
        const pos = equatorialToCartesianMpc(
            a.raDeg, a.decDeg, comovingDistanceMpc(a.z, cosmo));
        const off = [pos[0] - center[0], pos[1] - center[1], pos[2] - center[2]];
        const radiusMpc = Math.hypot(off[0], off[1], off[2]);
        return {
            ...a,
            positionMpc: pos,
            offsetMpc: off,
            radiusMpc,
            directionFromVoid: radiusMpc > 0
                ? [off[0] / radiusMpc, off[1] / radiusMpc, off[2] / radiusMpc]
                : [0, 0, 1],
        };
    });
}

// ── Profile presets ─────────────────────────────────────────────────────────

/**
 * Two anchorings of the same HSW form, and the page lets you switch because
 * the disagreement between them IS the measurement uncertainty.
 *
 * `hsw-supervoid` (default) takes the universal-profile shape parameters
 *   Hamaus et al. (2014) fit to the LARGEST voids — α ≈ 2, β ≈ 9, r_s ≈ 0.95
 *   R_v — and sets the depth from the central galaxy contrast through linear
 *   bias. It lands under-compensated, as large voids do.
 *
 * `deep-core` pushes the central contrast towards what the raw galaxy counts
 *   imply. It is the pessimistic-for-the-model, optimistic-for-the-signal
 *   end: every downstream amplitude grows by roughly the depth ratio.
 *
 * Neither is "the" Boötes profile. Nobody has published a matter-density
 * profile for this void — that would need a peculiar-velocity reconstruction
 * over the whole region, which is the observation this whole exercise is
 * pointing at.
 */
export const PROFILE_PRESETS = Object.freeze({
    'hsw-supervoid': Object.freeze({
        label: 'HSW supervoid',
        alpha: 2.0, beta: 9.0, rsFraction: 0.95,
        centralGalaxyContrast: -0.87,
        note: 'Hamaus+2014 universal-profile shape for the largest voids.',
    }),
    'deep-core': Object.freeze({
        label: 'Deep core',
        alpha: 2.6, beta: 9.0, rsFraction: 0.95,
        centralGalaxyContrast: -0.95,
        note: 'Depth pushed towards the raw galaxy-count deficit. '
            + 'Every downstream amplitude scales with it.',
    }),
});

/** Default tracer bias for the galaxies these voids are traced by. */
export const DEFAULT_BIAS = 1.5;

/**
 * The bias, with the honest range. Void-galaxy bias is measured between about
 * 1.2 and 2.0 depending on the tracer sample, and the whole downstream chain
 * scales as 1/b — so this range, not the numerical precision of anything else,
 * is the page's dominant error bar.
 */
export const BIAS_RANGE = Object.freeze({ min: 1.1, max: 2.2, default: DEFAULT_BIAS });
