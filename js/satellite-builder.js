/**
 * satellite-builder.js — parametric spacecraft assembly for the Design Bay
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Turns a small "build" config — { body, thruster, thrusterCount, panel,
 * panelSpan } — into:
 *
 *   1. derived *physics* the flight model consumes (dry mass, projected
 *      drag area, blended drag coefficient, total thrust, Isp), and
 *   2. a THREE.Group the Design Bay renders.
 *
 * The whole point is the engineering trade-off: bigger solar wings collect
 * more power but add frontal area → more drag → faster orbital decay; more
 * thrusters out-push drag but cost dry mass and (for chemical engines) burn
 * propellant fast. The numbers below are order-of-magnitude representative
 * of real LEO hardware classes.
 *
 * buildGroup() takes THREE as a parameter rather than importing it, so the
 * data + deriveDesign() + selfTest() stay dependency-free and unit-testable
 * in plain Node (mirroring satellite-designer-engine.js).
 */

// ── Body / bus chassis ──────────────────────────────────────────────────────
// dims [x,y,z] metres (z = thrust axis), mass kg, cd ≈ free-molecular drag
// coefficient for that shape, broad = broadside projected area (m²) used as
// the default ram area when the bus flies belly-to-the-wind.
//
// momentArmMul = how off-axis the *centre of pressure* sits relative to the
// centre of mass, normalised to (max-side / 2). It feeds the engine's drag-
// torque term: tall buses (telescopes, tugs) want active attitude control
// or they tumble; symmetric cubes resist disturbance naturally.
export const BODIES = {
    cubesat_3u:   { label: '3U CubeSat',        dims: [0.10, 0.10, 0.34], mass: 4,    cd: 2.2, shape: 'box',  momentArmMul: 0.15 },
    cubesat_12u:  { label: '12U CubeSat',       dims: [0.20, 0.20, 0.34], mass: 14,   cd: 2.2, shape: 'box',  momentArmMul: 0.18 },
    cubesat_grid: { label: '6U Grid (3×2)',     dims: [0.30, 0.20, 0.34], mass: 22,   cd: 2.3, shape: 'grid', momentArmMul: 0.22, gridCells: [3, 2, 1] },
    smallsat:     { label: 'SmallSat bus',      dims: [0.60, 0.60, 0.80], mass: 90,   cd: 2.2, shape: 'box',  momentArmMul: 0.18 },
    bus_med:      { label: 'Medium bus',        dims: [1.20, 1.20, 1.50], mass: 320,  cd: 2.2, shape: 'box',  momentArmMul: 0.20 },
    tank_cyl:     { label: 'Cylindrical bus',   dims: [1.00, 1.00, 2.00], mass: 240,  cd: 2.0, shape: 'cyl',  momentArmMul: 0.30 },
    tug:          { label: 'Orbital tug',       dims: [1.60, 1.60, 1.10], mass: 480,  cd: 2.1, shape: 'cyl',  momentArmMul: 0.22, tug: true },
    telescope:    { label: 'Optical telescope', dims: [1.10, 1.10, 3.20], mass: 540,  cd: 2.4, shape: 'tube', momentArmMul: 0.55 },
};

// ── Thruster units ──────────────────────────────────────────────────────────
// Keys MUST match satellite-designer-engine.js ENGINE_PRESETS so the flight
// model's thrust/Isp stay the single source of truth. Here we add the
// per-unit dry mass, the nozzle size used for the 3-D model, and the
// per-unit electrical power draw at rated thrust.
//
//   power = 0   → chemical: stored-energy propellant, thrust is power-
//                 independent (cold-gas, mono-/bi-propellant).
//   power > 0   → electric: needs that many watts (≈ ½·T·Isp·g₀ / η) to
//                 make rated thrust. Starve it of array power and thrust
//                 throttles down linearly (deriveDesign, below).
//
//   gimbalDeg   → maximum gimbal half-angle the nozzle can vector through
//                 (the engine reads control.gimbal in rad, clamped here).
//                 Chemicals gimbal a few degrees mechanically; electrics
//                 vector electrostatically and have wider authority.
//   throatLifeS → how many *full-throttle seconds* the throat lasts before
//                 erosion costs you Isp and thrust (capped at 25 % loss).
//                 Ion engines have huge life; bipropellants are aggressive.
export const THRUSTER_UNITS = {
    cold_gas:      { label: 'Cold-gas (N₂)',          unitMass: 0.6,  nozzle: 0.04, power: 0,    gimbalDeg: 0,   throatLifeS:  8_000 },
    monoprop:      { label: 'Monoprop hydrazine',     unitMass: 4.0,  nozzle: 0.07, power: 0,    gimbalDeg: 4,   throatLifeS:  4_500 },
    biprop:        { label: 'Bipropellant (MMH/NTO)', unitMass: 12.0, nozzle: 0.11, power: 0,    gimbalDeg: 8,   throatLifeS:  2_400 },
    hall_ion:      { label: 'Hall-effect ion',        unitMass: 8.0,  nozzle: 0.09, power: 1100, gimbalDeg: 15,  throatLifeS: 60_000 },
    gridded_ion:   { label: 'Gridded ion (Xe)',       unitMass: 10.0, nozzle: 0.10, power: 650,  gimbalDeg: 18,  throatLifeS: 90_000 },
    hall_shielded: { label: 'Mag-shielded Hall',      unitMass: 11.0, nozzle: 0.09, power: 1500, gimbalDeg: 12,  throatLifeS:120_000 },
    iodine_ion:    { label: 'Iodine gridded ion',     unitMass: 2.2,  nozzle: 0.06, power: 220,  gimbalDeg: 18,  throatLifeS: 30_000 },
    electrospray:  { label: 'Electrospray / FEEP',    unitMass: 0.5,  nozzle: 0.035, power: 35,  gimbalDeg: 22,  throatLifeS: 40_000 },
    water_resisto: { label: 'Water electrothermal',   unitMass: 1.6,  nozzle: 0.05, power: 90,   gimbalDeg: 6,   throatLifeS:  6_000 },
};

// ── Payloads ────────────────────────────────────────────────────────────────
// A fourth assembly slot — the *reason* the bird is up there. Payloads add
// dry mass, drag-area, and a fixed electrical load, and they introduce new
// failure / opportunity modes:
//
//   optical_cam  — narrow-FOV imager; very mass-efficient, modest power.
//   wide_imager  — staring multi-band camera; bigger aperture, more area.
//   commsat_dish — high-gain X-band reflector; large frontal area when
//                  pointed cross-track, big housekeeping power.
//   sar_radar    — phased-array side-looker; heavy, power-hungry, mostly
//                  flat-plate drag.
//   mass_driver  — experimental electromagnetic launcher (gameplay flavour
//                  payload); very heavy, exotic power draw, lots of area.
//
// All payloads have a centreOffset (m, along +z) describing how far above
// the bus deck they sit, used both for the 3-D model and (eventually) for
// CG-offset moments in the flight model.
export const PAYLOADS = {
    none:         { label: 'None',                mass:   0, area:  0,  cd: 0,   powerW:   0, centreOffset: 0,    shape: null     },
    optical_cam:  { label: 'Optical camera',      mass:  18, area: 0.25, cd: 2.3, powerW:  40, centreOffset: 0.45, shape: 'scope'  },
    wide_imager:  { label: 'Wide-field imager',   mass:  46, area: 0.70, cd: 2.3, powerW:  85, centreOffset: 0.55, shape: 'imager' },
    commsat_dish: { label: 'Comms HG dish',       mass:  32, area: 1.10, cd: 2.6, powerW: 110, centreOffset: 0.60, shape: 'dish'   },
    sar_radar:    { label: 'SAR phased array',    mass: 120, area: 2.40, cd: 2.6, powerW: 320, centreOffset: 0.30, shape: 'plate'  },
    mass_driver:  { label: 'Mass driver (exp.)',  mass: 240, area: 1.60, cd: 2.4, powerW: 480, centreOffset: 0.95, shape: 'driver' },
};

// ── Solar arrays ────────────────────────────────────────────────────────────
// wings = number of deployable panels, areaKgM2 = panel areal density,
// ramFactor = fraction of full panel area that actually faces the ram (sun-
// tracking arrays spend a lot of the orbit broadside to the flow), cd = flat-
// plate free-molecular drag coefficient, wPerM2 = electrical power generated
// per m² of panel (BOL, 1 AU, after packing/efficiency).
//
// "Body-mounted only" makes no deployable power, so an electric thruster on
// it is starved → no thrust. Roll-out (ROSA) and thin-film are the cutting-
// edge picks: far lighter per watt, so you can carry the kilowatts an ion
// engine needs without the mass — at the cost of more drag area.
export const PANELS = {
    none:     { label: 'Body-mounted only', wings: 0, areaKgM2: 0,    ramFactor: 0,    cd: 0,   wPerM2: 0   },
    dual:     { label: 'Dual deployable',   wings: 2, areaKgM2: 2.3,  ramFactor: 0.55, cd: 2.5, wPerM2: 180 },
    quad:     { label: 'Quad deployable',   wings: 4, areaKgM2: 2.3,  ramFactor: 0.55, cd: 2.5, wPerM2: 180 },
    large:    { label: 'Large array',       wings: 2, areaKgM2: 1.8,  ramFactor: 0.6,  cd: 2.6, wPerM2: 170 },
    rosa:     { label: 'Roll-out (ROSA)',   wings: 2, areaKgM2: 1.0,  ramFactor: 0.55, cd: 2.5, wPerM2: 200 },
    thinfilm: { label: 'Thin-film flex',    wings: 2, areaKgM2: 0.55, ramFactor: 0.6,  cd: 2.6, wPerM2: 140 },
};

const AVIONICS_MASS  = 6;    // kg — flight computer, comms, harness, reaction wheels
const HOUSEKEEPING_W = 20;   // W  — baseline bus load drawn before any propulsion

export function defaultBuild() {
    return { body: 'smallsat', thruster: 'monoprop', thrusterCount: 2,
             panel: 'dual', panelSpan: 2.2,
             payload: 'optical_cam' };
}

/** Per-wing panel area (m²): span (root→tip) × a fixed 0.45 m chord. */
function wingArea(span) { return clampNum(span, 0.3, 8, 2) * 0.45; }

/**
 * Derive flight-model parameters from a build.
 *
 * @param {object} build
 * @param {object} [presets] ENGINE_PRESETS from the flight engine. When
 *        supplied, thrust/isp are filled in (single source of truth).
 * @returns {{dryMass,area,cd,engine,thrusterCount,thrust,isp,
 *            bodyArea,panelArea,panelMass,
 *            power,powerReq,powerMargin,powerFrac,electric}}
 */
export function deriveDesign(build, presets = null) {
    const b  = BODIES[build.body] || BODIES.smallsat;
    const tu = THRUSTER_UNITS[build.thruster] || THRUSTER_UNITS.monoprop;
    const p  = PANELS[build.panel] || PANELS.none;
    const pl = PAYLOADS[build.payload] || PAYLOADS.none;
    const count = Math.max(1, Math.round(build.thrusterCount || 1));

    // Bus broadside ram area (largest face for box, side rectangle for cyl,
    // length × diameter for the long telescope tube).
    const [dx, dy, dz] = b.dims;
    const bodyArea = b.shape === 'cyl' || b.shape === 'tube'
        ? dx * dz                                   // diameter × length
        : Math.max(dx * dy, dx * dz, dy * dz);      // biggest box face

    const perWing = wingArea(build.panelSpan);
    const totalPanelArea = perWing * p.wings;
    const panelRamArea = totalPanelArea * p.ramFactor;
    const panelMass = totalPanelArea * p.areaKgM2;

    const area = bodyArea + panelRamArea + pl.area;
    // Area-weighted blend of body vs. flat-plate panel vs. payload drag coefficients.
    const cd = area > 0
        ? (b.cd * bodyArea + p.cd * panelRamArea + pl.cd * pl.area) / area
        : b.cd;

    const dryMass = b.mass + tu.unitMass * count + panelMass + pl.mass + AVIONICS_MASS;

    // ── Power budget ──────────────────────────────────────────────────────
    // Sun-tracking arrays generate from their *full* area (orientation only
    // affects drag, not illumination). Housekeeping + the payload's fixed
    // electrical load come off the top before anything reaches propulsion.
    const powerGen   = totalPanelArea * p.wPerM2;             // W generated
    const electric   = tu.power > 0;
    const thrPwrFull = tu.power * count;                      // W at rated thrust
    const fixedLoad  = HOUSEKEEPING_W + pl.powerW;
    const powerReq   = fixedLoad + (electric ? thrPwrFull : 0);
    const powerAvail = Math.max(0, powerGen - fixedLoad);
    // Electric thrust scales linearly with the power it actually gets; a
    // chemical thruster ignores the array entirely.
    const powerFrac  = electric
        ? (thrPwrFull > 0 ? Math.min(1, powerAvail / thrPwrFull) : 1)
        : 1;

    // Centre-of-pressure offset (m): the lever arm between the geometric
    // centre of drag and the centre of mass, used by the engine to compute
    // disturbance torques. Telescopes / tugs with off-axis payloads are
    // more prone to tumble under high-q.
    const maxSide = Math.max(dx, dy, dz);
    const baseArm = maxSide * (b.momentArmMul ?? 0.18);
    const payloadArm = pl.centreOffset * (pl.mass / Math.max(1, dryMass));
    const copOffset = baseArm + payloadArm * 0.5;

    const out = {
        dryMass:      round(dryMass, 1),
        area:         round(area, 3),
        cd:           round(cd, 3),
        engine:       build.thruster,
        thrusterCount: count,
        bodyArea:     round(bodyArea, 3),
        panelArea:    round(totalPanelArea, 3),
        panelMass:    round(panelMass, 2),
        payload:      build.payload || 'none',
        payloadMass:  round(pl.mass, 1),
        payloadArea:  round(pl.area, 3),
        payloadPower: pl.powerW,
        power:        round(powerGen, 0),
        powerReq:     round(powerReq, 0),
        powerMargin:  round(powerGen - powerReq, 0),
        powerFrac:    round(powerFrac, 3),
        electric,
        // Per-thruster *modifier* hand-offs the flight model consumes:
        gimbalDeg:    tu.gimbalDeg,
        gimbalRad:    tu.gimbalDeg * Math.PI / 180,
        throatLifeS:  tu.throatLifeS,
        // Geometric properties the engine uses for torque / tumble math.
        copOffset:    round(copOffset, 3),
        maxSide:      round(maxSide, 3),
    };
    if (presets && presets[build.thruster]) {
        out.thrust = round(presets[build.thruster].thrust * count * powerFrac, 4);
        out.isp = presets[build.thruster].isp;
    }
    return out;
}

/**
 * Assemble a THREE.Group for the build. THREE is injected so this module
 * carries no hard dependency on the 3-D library.
 */
export function buildGroup(THREE, build) {
    const g = new THREE.Group();
    const b  = BODIES[build.body] || BODIES.smallsat;
    const tu = THRUSTER_UNITS[build.thruster] || THRUSTER_UNITS.monoprop;
    const p  = PANELS[build.panel] || PANELS.none;
    const pl = PAYLOADS[build.payload] || PAYLOADS.none;
    const count = Math.max(1, Math.round(build.thrusterCount || 1));
    const [dx, dy, dz] = b.dims;

    // ── Bus ──
    const busMat = new THREE.MeshStandardMaterial({
        color: 0xb9a05a, metalness: 0.65, roughness: 0.42,
        emissive: 0x141005, emissiveIntensity: 0.4,
    });
    const goldMat = new THREE.MeshStandardMaterial({
        color: 0xddc77b, metalness: 0.78, roughness: 0.32,
        emissive: 0x1a1408, emissiveIntensity: 0.55,
    });
    let bus;
    if (b.shape === 'cyl') {
        bus = new THREE.Mesh(new THREE.CylinderGeometry(dx / 2, dx / 2, dz, 28), busMat);
        bus.rotation.x = Math.PI / 2;                // align cylinder to +z
        g.add(bus);
    } else if (b.shape === 'tube') {
        // Telescope: hollow tube + sun-shade baffle on the +z end.
        bus = new THREE.Mesh(new THREE.CylinderGeometry(dx / 2, dx / 2, dz, 36), busMat);
        bus.rotation.x = Math.PI / 2;
        g.add(bus);
        const baffleMat = new THREE.MeshStandardMaterial({
            color: 0x222831, metalness: 0.6, roughness: 0.65,
            emissive: 0x05070a, emissiveIntensity: 0.4,
        });
        const baffle = new THREE.Mesh(
            new THREE.CylinderGeometry(dx / 2 * 1.18, dx / 2, dz * 0.18, 36, 1, true),
            baffleMat);
        baffle.rotation.x = Math.PI / 2;
        baffle.position.z = dz / 2 + dz * 0.09;
        g.add(baffle);
    } else if (b.shape === 'grid') {
        // Bolted multi-cube grid (e.g. 3×2 array of 1-U cubes). Each cell
        // gets its own box so seams are visible; gives the silhouette real
        // multi-cube character instead of one fat box.
        const [gx, gy, gz] = b.gridCells || [Math.round(dx/0.1), Math.round(dy/0.1), 1];
        const cx = dx / gx, cy = dy / gy, cz = dz / gz;
        const inset = 0.0035;            // visible gap between cubes
        for (let i = 0; i < gx; i++) for (let j = 0; j < gy; j++) for (let k = 0; k < gz; k++) {
            const cell = new THREE.Mesh(
                new THREE.BoxGeometry(cx - inset, cy - inset, cz - inset), busMat);
            cell.position.set((i - (gx - 1) / 2) * cx,
                              (j - (gy - 1) / 2) * cy,
                              (k - (gz - 1) / 2) * cz);
            g.add(cell);
        }
    } else {
        bus = new THREE.Mesh(new THREE.BoxGeometry(dx, dy, dz), busMat);
        g.add(bus);
    }
    // Tugs get a docking ring on the +z face — useful narrative cue.
    if (b.tug) {
        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(dx * 0.42, dx * 0.04, 12, 36), goldMat);
        ring.position.z = dz / 2 + 0.02;
        g.add(ring);
    }

    // ── Thrusters: nozzle cones on the −z face, packed in a tidy grid ──
    const nozMat = new THREE.MeshStandardMaterial({
        color: 0x2a2a30, metalness: 0.8, roughness: 0.3,
    });
    const cols = Math.ceil(Math.sqrt(count));
    const pitch = Math.min(dx, dy) * 0.7 / cols;
    for (let i = 0; i < count; i++) {
        const noz = new THREE.Mesh(
            new THREE.ConeGeometry(tu.nozzle, tu.nozzle * 1.8, 18), nozMat);
        const cx = (i % cols) - (cols - 1) / 2;
        const cy = Math.floor(i / cols) - (Math.ceil(count / cols) - 1) / 2;
        noz.position.set(cx * pitch, cy * pitch, -dz / 2 - tu.nozzle * 0.9);
        noz.rotation.x = -Math.PI / 2;               // bell points −z (aft)
        g.add(noz);
    }

    // ── Solar wings along ±x, with a short yoke ──
    if (p.wings > 0) {
        const span = clampNum(build.panelSpan, 0.3, 8, 2);
        const chord = 0.45;
        const panelMat = new THREE.MeshStandardMaterial({
            color: 0x1b2f6b, metalness: 0.35, roughness: 0.5,
            emissive: 0x0a1430, emissiveIntensity: 0.55,
        });
        const yokeMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.7, roughness: 0.4 });
        // dual = one wing each side; quad = two stacked each side
        const perSide = p.wings / 2;
        for (const sgn of [-1, 1]) {
            for (let k = 0; k < perSide; k++) {
                const yoke = new THREE.Mesh(
                    new THREE.BoxGeometry(0.12, 0.03, 0.03), yokeMat);
                yoke.position.set(sgn * (dx / 2 + 0.06), 0, 0);
                g.add(yoke);
                const wing = new THREE.Mesh(
                    new THREE.BoxGeometry(span, 0.02, chord), panelMat);
                const zoff = perSide > 1 ? (k - (perSide - 1) / 2) * (chord + 0.06) : 0;
                wing.position.set(sgn * (dx / 2 + 0.12 + span / 2), 0, zoff);
                g.add(wing);
            }
        }
    }

    // ── Payload (mounted on the +z deck) ─────────────────────────────────
    if (pl.shape) {
        const payMat = new THREE.MeshStandardMaterial({
            color: 0xc6cfd6, metalness: 0.55, roughness: 0.45,
            emissive: 0x0a0e14, emissiveIntensity: 0.45,
        });
        const lensMat = new THREE.MeshStandardMaterial({
            color: 0x6fdcff, metalness: 0.8, roughness: 0.15,
            emissive: 0x062537, emissiveIntensity: 0.85,
        });
        const dishMat = new THREE.MeshStandardMaterial({
            color: 0xe2eef7, metalness: 0.5, roughness: 0.35,
            emissive: 0x10202c, emissiveIntensity: 0.5, side: THREE.DoubleSide,
        });
        const zBase = dz / 2;
        if (pl.shape === 'scope') {
            // Cylinder + glass eye on the bus's +z face.
            const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.45, 24), payMat);
            tube.rotation.x = Math.PI / 2;
            tube.position.z = zBase + 0.22;
            g.add(tube);
            const lens = new THREE.Mesh(new THREE.CircleGeometry(0.12, 24), lensMat);
            lens.position.z = zBase + 0.45;
            g.add(lens);
        } else if (pl.shape === 'imager') {
            // Wider, shorter — multi-aperture imager block.
            const box = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.4, 0.3), payMat);
            box.position.z = zBase + 0.16;
            g.add(box);
            // Three lens dots in a triangle.
            for (const [px, py] of [[-0.16, 0.07], [0.16, 0.07], [0, -0.12]]) {
                const lens = new THREE.Mesh(new THREE.CircleGeometry(0.07, 18), lensMat);
                lens.position.set(px, py, zBase + 0.31);
                g.add(lens);
            }
        } else if (pl.shape === 'dish') {
            // Parabolic-ish dish on a short pedestal, slightly canted.
            const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 12), payMat);
            ped.rotation.x = Math.PI / 2;
            ped.position.z = zBase + 0.09;
            g.add(ped);
            const dish = new THREE.Mesh(
                new THREE.SphereGeometry(0.42, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.32),
                dishMat);
            dish.rotation.x = -Math.PI * 0.45;
            dish.position.z = zBase + 0.32;
            g.add(dish);
            const feed = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), lensMat);
            feed.position.set(0, 0.25, zBase + 0.35);
            g.add(feed);
        } else if (pl.shape === 'plate') {
            // Flat phased-array panel.
            const plate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.7), payMat);
            plate.position.z = zBase + 0.18;
            g.add(plate);
            // Element grid pattern as a wireframe overlay.
            const grid = new THREE.LineSegments(
                new THREE.WireframeGeometry(new THREE.PlaneGeometry(1.2, 0.7, 6, 4)),
                new THREE.LineBasicMaterial({ color: 0x55aaff, transparent: true, opacity: 0.55 }));
            grid.rotation.x = -Math.PI / 2;
            grid.position.z = zBase + 0.20;
            g.add(grid);
        } else if (pl.shape === 'driver') {
            // Mass driver — a long open rail-launch tube with coil rings.
            const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.4, 18, 1, true), payMat);
            rail.rotation.x = Math.PI / 2;
            rail.position.z = zBase + 0.75;
            g.add(rail);
            for (let i = 0; i < 5; i++) {
                const coil = new THREE.Mesh(
                    new THREE.TorusGeometry(0.16, 0.025, 8, 18), goldMat);
                coil.position.z = zBase + 0.18 + i * 0.28;
                coil.rotation.x = Math.PI / 2;
                g.add(coil);
            }
        }
    }

    // Antenna whip for a little silhouette character (skip if a dish or
    // mass-driver dominates the top — they're the comms / payload feature).
    if (pl.shape !== 'dish' && pl.shape !== 'driver') {
        const antMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.6, roughness: 0.4 });
        const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, dz * 0.5, 8), antMat);
        ant.position.set(0, dy / 2 + dz * 0.25, dz * 0.3);
        g.add(ant);
    }

    return g;
}

/** Largest bounding dimension (m) — handy for fitting the camera. */
export function buildExtent(build) {
    const b  = BODIES[build.body] || BODIES.smallsat;
    const p  = PANELS[build.panel] || PANELS.none;
    const pl = PAYLOADS[build.payload] || PAYLOADS.none;
    const [dx, dy, dz] = b.dims;
    const span = p.wings > 0 ? clampNum(build.panelSpan, 0.3, 8, 2) : 0;
    // Long payloads (mass driver, telescope baffle) extend the +z silhouette;
    // account for them so the camera frames the whole stack.
    const payloadStackZ = pl.shape === 'driver' ? 1.6
                       : pl.shape === 'dish'   ? 0.7
                       : pl.shape === 'scope'  ? 0.55
                       : pl.shape === 'imager' ? 0.35
                       : pl.shape === 'plate'  ? 0.25
                       : 0;
    return Math.max(dz + payloadStackZ, dy, dx + 2 * (span + 0.2));
}

// ── helpers ─────────────────────────────────────────────────────────────────
function clampNum(v, lo, hi, dflt) {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
}
function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

// ── self-test ───────────────────────────────────────────────────────────────
export function selfTest() {
    const out = [];
    const T = (c, m) => out.push({ pass: !!c, msg: m });
    const presets = {
        monoprop:      { thrust: 22,   isp: 225  },
        hall_ion:      { thrust: 0.25, isp: 1800 },
        hall_shielded: { thrust: 0.30, isp: 2000 },
    };

    const d = deriveDesign(defaultBuild(), presets);
    T(d.dryMass > 0 && d.area > 0 && d.cd >= 2 && d.cd <= 2.7,
        `default build sane (m=${d.dryMass}kg A=${d.area}m² Cd=${d.cd})`);
    T(d.thrust === 44 && d.isp === 225, `2× monoprop → 44 N / 225 s (got ${d.thrust}/${d.isp})`);

    // More thrusters → more dry mass.
    const t1 = deriveDesign({ ...defaultBuild(), thrusterCount: 1 }, presets);
    const t4 = deriveDesign({ ...defaultBuild(), thrusterCount: 4 }, presets);
    T(t4.dryMass > t1.dryMass, `+thrusters ⇒ +dry mass (${t1.dryMass} → ${t4.dryMass})`);

    // Bigger wings → more drag area AND more mass (the core trade-off).
    const s1 = deriveDesign({ ...defaultBuild(), panelSpan: 1 }, presets);
    const s5 = deriveDesign({ ...defaultBuild(), panelSpan: 5 }, presets);
    T(s5.area > s1.area && s5.dryMass > s1.dryMass,
        `+wing span ⇒ +area & +mass (A ${s1.area}→${s5.area})`);

    // No panels AND no payload ⇒ Cd collapses to the bare bus value.
    const np = deriveDesign({ ...defaultBuild(), panel: 'none', payload: 'none' }, presets);
    T(Math.abs(np.cd - BODIES[defaultBuild().body].cd) < 1e-6,
        `no panels & no payload ⇒ Cd = bus Cd (${np.cd})`);

    // A big bus is heavier and draggier than a CubeSat.
    const cube = deriveDesign({ ...defaultBuild(), body: 'cubesat_3u', panel: 'none', payload: 'none' }, presets);
    const big = deriveDesign({ ...defaultBuild(), body: 'bus_med', panel: 'none', payload: 'none' }, presets);
    T(big.dryMass > cube.dryMass && big.area > cube.area,
        `bus_med ≫ 3U (m ${cube.dryMass}→${big.dryMass}, A ${cube.area}→${big.area})`);

    // ── Power budget ──────────────────────────────────────────────────────
    // Arrays generate power; power scales with span.
    const pw1 = deriveDesign({ ...defaultBuild(), panelSpan: 1 }, presets);
    const pw5 = deriveDesign({ ...defaultBuild(), panelSpan: 5 }, presets);
    T(pw5.power > pw1.power && pw1.power > 0,
        `array power grows with span (${pw1.power} → ${pw5.power} W)`);

    // An electric thruster on a body-only build is starved → ~no thrust.
    const epStarved = deriveDesign(
        { body: 'smallsat', thruster: 'hall_shielded', thrusterCount: 1,
          panel: 'none', panelSpan: 2 }, presets);
    T(epStarved.electric && epStarved.powerFrac === 0 && epStarved.thrust === 0,
        `electric + no panels ⇒ 0 thrust (frac ${epStarved.powerFrac})`);
    T(epStarved.powerMargin < 0, `starved EP shows negative power margin`);

    // Give it a big quad array → full rated thrust, positive margin.
    const epFed = deriveDesign(
        { body: 'smallsat', thruster: 'hall_shielded', thrusterCount: 1,
          panel: 'quad', panelSpan: 6 }, presets);
    T(epFed.powerFrac === 1 && Math.abs(epFed.thrust - 0.30) < 1e-6,
        `electric + ample power ⇒ rated thrust (${epFed.thrust} N)`);
    T(epFed.powerMargin > 0, `well-fed EP shows positive power margin`);

    // Chemical thrust is power-independent: same with or without panels.
    const chemNo = deriveDesign({ ...defaultBuild(), panel: 'none' }, presets);
    const chemBig = deriveDesign({ ...defaultBuild(), panel: 'large', panelSpan: 5 }, presets);
    T(chemNo.thrust === chemBig.thrust && chemNo.electric === false,
        `chemical thrust ignores power (${chemNo.thrust} N both)`);

    // ROSA beats rigid on specific power (W per kg of array).
    const span = 5;
    const rosa = deriveDesign({ ...defaultBuild(), panel: 'rosa',  panelSpan: span }, presets);
    const rigid = deriveDesign({ ...defaultBuild(), panel: 'large', panelSpan: span }, presets);
    T(rosa.power / rosa.panelMass > rigid.power / rigid.panelMass,
        `ROSA > rigid on W/kg (${(rosa.power/rosa.panelMass).toFixed(0)} vs ${(rigid.power/rigid.panelMass).toFixed(0)})`);

    return out;
}
