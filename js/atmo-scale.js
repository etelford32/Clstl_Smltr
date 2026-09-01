/**
 * atmo-scale.js — the ONE owner of troposphere vertical exaggeration
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURE + THREE-free on purpose, so `node tests/atmo-scale.mjs` can pin the
 * geometry without a GL context. Nothing in here fetches, renders, or reads
 * ambient time.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Earth's whole weather column is 14 km tall on a 6371 km ball — 0.0022 of a
 * globe radius. Drawn true to scale it is a coat of paint: you cannot see
 * that cirrus is above cumulus, and a "3-D wind stack" is four coincident
 * spheres. So the stack is exaggerated. That is a deliberate lie, and this
 * module is where the lie is told — once, from real altitudes, with a factor
 * the UI is required to disclose (see `disclosureText`).
 *
 * Before this module the exaggeration was spelled as four hand-tuned radius
 * constants in earth.html (surface 1.003, 850 → 1.008, 500 → 1.013,
 * 250 → 1.018, decks 1.006/1.011/1.016). Those are NOT proportional to real
 * altitude — the low deck sat at ~32× while cirrus sat at ~11× — so the
 * rendered stack silently misreported which layers are close together. Every
 * radius now derives from ONE factor applied to ONE altitude table, so the
 * spacing you see is the spacing that exists, times a number on screen.
 *
 * THE RAMP (what the user asked for)
 * ──────────────────────────────────
 * The factor is not constant: it rides camera range. From orbit the stack
 * collapses to roughly the historical globe-view radii, so the planet still
 * reads as a planet. As the camera dollies in, the factor climbs and the
 * layers fan apart into a legible vertical stack you can fly into.
 *
 * The ramp is driven by CAMERA DISTANCE, never by altitude-above-the-stack.
 * This is the Mars `regionalReliefScale` lesson (see CLAUDE.md, Mars row)
 * inverted into a case where it is safe: there, the scale moved the drawn
 * GROUND, so an AGL-driven controller fed back through the surface it
 * displaced. Here the exaggeration moves shells the camera does not stand
 * on, and the camera's distance-to-centre is user input, so E = f(distance)
 * is a pure function with no loop. Do NOT "improve" this by driving the ramp
 * from the camera's height above the nearest shell — that reintroduces the
 * feedback the Mars page had to unwind.
 *
 * CALIBRATION
 * ───────────
 * E_FAR is chosen so the globe view lands within ~0.003 R of the historical
 * constants above (see tests/atmo-scale.mjs, which pins that). The point of
 * the ramp is depth on approach, not a different-looking planet from orbit.
 *
 * THE CLEARANCE FLOOR
 * ───────────────────
 * 10 m surface wind is 1.6e-6 R. At any honest exaggeration it z-fights the
 * ground. `SURFACE_CLEARANCE_R` pins the near-ground layers to a fixed shell
 * above the surface overlays, and altitude is measured UP FROM THERE:
 *
 *     r(alt) = SURFACE_CLEARANCE_R + (alt_km / R_EARTH_KM) * E
 *
 * so the surface layer stays welded to the deck while everything above it
 * fans upward — which is both the legible read and the physically right one.
 * Same shape as the Moon's `DESCENT_MIN_AGL_KM` clearance: an offset above
 * ground, not a scaled altitude, so the no-exaggeration path reproduces the
 * historical fixed radius exactly.
 */

// ── Physical constants ───────────────────────────────────────────────────────
export const R_EARTH_KM = 6371.0;

/**
 * Standard-atmosphere geopotential altitude of each pressure level we render,
 * in km. These are the levels the multi-level advection forecaster already
 * steers with (weather-flow.js / temp-volume-feed.js levelWindSnapshot), so
 * the drawn altitude and the modelled altitude cannot disagree.
 */
export const LEVEL_ALTITUDE_KM = {
    sfc: 0.01,    // 10 m AGL — the anemometer level
    850: 1.50,    // boundary-layer steering flow
    500: 5.60,    // mid-troposphere steering flow
    250: 10.40,   // jet core
};

/**
 * Cloud deck vertical extent in km, from the WMO étage definitions at
 * mid-latitudes. `mid` is the centroid the flat-shell fallback renders at;
 * base/top are what the volumetric march integrates between.
 */
export const DECK_ALTITUDE_KM = {
    low:  { base: 0.40, top:  2.00, mid: 1.20 },
    mid:  { base: 2.20, top:  6.50, mid: 4.50 },
    high: { base: 7.00, top: 12.00, mid: 9.50 },
};

/** Top of the marched volume, km. Above the 12 km cirrus top with headroom
 *  for the deep-convection anvils the IR channel routes into the high deck
 *  (tropical overshoots reach ~16 km; the density there is ~0 either way). */
export const VOLUME_TOP_KM = 14.0;

/** Bottom of the marched volume, km. Fog/stratus can sit on the deck. */
export const VOLUME_BASE_KM = 0.05;

/**
 * Radius the near-ground layers are pinned to. Sits above the surface
 * overlay band (lat/lon grid 1.0015, SST 1.002, ocean currents 1.0024) and
 * reproduces the historical surface-wind-trail radius exactly, so the
 * un-exaggerated ground layers render byte-identically to before.
 */
export const SURFACE_CLEARANCE_R = 1.0030;

// ── The ramp ─────────────────────────────────────────────────────────────────
// Anchors match WIND_LOD_FAR / WIND_LOD_NEAR in earth.html on purpose: the
// particle-density LOD and the altitude fan-out are one gesture to the user,
// so they must ease over the same dolly interval. If you retune one, retune
// both — tests/atmo-scale.mjs pins the values, earth.html imports them.
export const RAMP_FAR_DIST  = 2.50;   // globe in view → historical stack
export const RAMP_NEAR_DIST = 1.06;   // inside the stack → full fan-out

export const E_FAR  = 10;   // calibrated against the historical constants
export const E_NEAR = 55;   // full cross-section; see the geometry note below

/**
 * Vertical exaggeration for a camera at `dist` globe radii from Earth's
 * centre. Smoothstep-eased so the fan-out has no visible step, clamped at
 * both ends so a runaway camera can't invert the stack.
 *
 * @param {number} dist  camera distance from globe centre, in Earth radii
 * @param {{far?:number, near?:number, eFar?:number, eNear?:number}} [opts]
 * @returns {number} exaggeration factor (dimensionless, ≥ 1)
 */
export function exaggerationAt(dist, opts = {}) {
    const far   = opts.far   ?? RAMP_FAR_DIST;
    const near  = opts.near  ?? RAMP_NEAR_DIST;
    const eFar  = opts.eFar  ?? E_FAR;
    const eNear = opts.eNear ?? E_NEAR;
    if (!Number.isFinite(dist)) return eFar;
    const t  = (far - dist) / (far - near);
    const tc = Math.max(0, Math.min(1, t));
    const s  = tc * tc * (3 - 2 * tc);          // smoothstep
    return eFar + (eNear - eFar) * s;
}

/**
 * Shell radius (in globe radii) for a layer at `altKm` real altitude under
 * exaggeration `exag`. This is THE conversion — every shell radius on
 * earth.html's troposphere stack must come from here.
 */
export function radiusForAltitude(altKm, exag) {
    return SURFACE_CLEARANCE_R + (altKm / R_EARTH_KM) * exag;
}

/** Inverse of `radiusForAltitude` — real altitude (km) at a shell radius. */
export function altitudeForRadius(r, exag) {
    if (!(exag > 0)) return 0;
    return (r - SURFACE_CLEARANCE_R) * R_EARTH_KM / exag;
}

/**
 * Every troposphere radius for one exaggeration, in one object. Consumers
 * take what they need; nobody re-derives a radius from a constant.
 */
export function shellRadii(exag) {
    const r = (km) => radiusForAltitude(km, exag);
    return {
        exag,
        volumeBase: r(VOLUME_BASE_KM),
        volumeTop:  r(VOLUME_TOP_KM),
        deckLow:    r(DECK_ALTITUDE_KM.low.mid),
        deckMid:    r(DECK_ALTITUDE_KM.mid.mid),
        deckHigh:   r(DECK_ALTITUDE_KM.high.mid),
        windSfc:    r(LEVEL_ALTITUDE_KM.sfc),
        wind850:    r(LEVEL_ALTITUDE_KM[850]),
        wind500:    r(LEVEL_ALTITUDE_KM[500]),
        wind250:    r(LEVEL_ALTITUDE_KM[250]),
    };
}

/**
 * The outer context shells (aurora oval, stratosphere haze, atmosphere rim)
 * belong to a vertical regime two orders of magnitude above the weather
 * column, and they are NOT on the troposphere ramp — at E_NEAR the auroral
 * oval's real 100 km would put it past the camera's own orbit.
 *
 * They do still have to stay ABOVE the marched cloud volume, or the limb
 * glow paints under the cirrus and the stack inverts. So each one is lifted
 * only as far as it must be: its historical radius, or the volume top plus
 * its own margin, whichever is greater.
 *
 * NOTE — this lifts the aurora oval slightly even at globe view (1.019 →
 * ~1.026), and that is correct, not drift. The historical constants were
 * tuned against cloud DECALS with no vertical extent; a marched volume that
 * honestly occupies 0–14 km reaches higher than the old high-deck shell did,
 * so the shells that are meant to sit above the weather have to actually sit
 * above it. tests/atmo-scale.mjs bounds how far this may move so a future
 * retune can't quietly balloon the outer shells.
 *
 * @param {number} volumeTopR  outer radius of the marched cloud volume
 * @param {{aurora:number, strat:number, atm:number}} base  historical radii
 */
export const OUTER_SHELL_MARGIN = { aurora: 0.0015, strat: 0.0030, atm: 0.0045 };

export function outerShellRadii(volumeTopR, base) {
    return {
        aurora: Math.max(base.aurora, volumeTopR + OUTER_SHELL_MARGIN.aurora),
        strat:  Math.max(base.strat,  volumeTopR + OUTER_SHELL_MARGIN.strat),
        atm:    Math.max(base.atm,    volumeTopR + OUTER_SHELL_MARGIN.atm),
    };
}

/**
 * Dolly floor for a given exaggeration. The camera is allowed INSIDE the
 * stack (that is the point of the fan-out), so this is a ground-clearance
 * floor, not a stack-clearance one: stay above the surface layer shell with
 * enough margin that the dynamic near-plane has something to work with.
 *
 * Independent of `exag` today — kept as a function because the floor is a
 * property of the scale contract, and a future true-scale mode will want to
 * raise it back above the (then paper-thin) stack.
 */
export function cameraFloor(_exag) {
    return SURFACE_CLEARANCE_R + 0.0010;   // 1.0040
}

/**
 * One-line disclosure for the HUD. The exaggeration is never allowed to be
 * silent — a viewer reading altitude off this globe must be told the column
 * is stretched, and by how much.
 */
export function disclosureText(exag) {
    return `Vertical exaggeration ×${Math.round(exag)} — altitudes are real, spacing is stretched`;
}

/**
 * Which named layer a radius is closest to, for the "you are here" readout
 * while flying through the stack. Returns null above the volume top.
 */
export function layerAtRadius(r, exag) {
    const altKm = altitudeForRadius(r, exag);
    if (altKm > VOLUME_TOP_KM) return null;
    const bands = [
        { key: 'sfc',  label: 'surface layer',    altKm: LEVEL_ALTITUDE_KM.sfc },
        { key: '850',  label: '850 hPa',          altKm: LEVEL_ALTITUDE_KM[850] },
        { key: '500',  label: '500 hPa',          altKm: LEVEL_ALTITUDE_KM[500] },
        { key: '250',  label: '250 hPa (jet)',    altKm: LEVEL_ALTITUDE_KM[250] },
    ];
    let best = bands[0];
    let bestD = Infinity;
    for (const b of bands) {
        const d = Math.abs(b.altKm - altKm);
        if (d < bestD) { bestD = d; best = b; }
    }
    return { ...best, cameraAltKm: altKm };
}
