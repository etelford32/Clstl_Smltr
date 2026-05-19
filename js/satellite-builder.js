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
export const BODIES = {
    cubesat_3u:  { label: '3U CubeSat',        dims: [0.10, 0.10, 0.34], mass: 4,   cd: 2.2, shape: 'box' },
    cubesat_12u: { label: '12U CubeSat',       dims: [0.20, 0.20, 0.34], mass: 14,  cd: 2.2, shape: 'box' },
    smallsat:    { label: 'SmallSat bus',      dims: [0.60, 0.60, 0.80], mass: 90,  cd: 2.2, shape: 'box' },
    bus_med:     { label: 'Medium bus',        dims: [1.20, 1.20, 1.50], mass: 320, cd: 2.2, shape: 'box' },
    tank_cyl:    { label: 'Cylindrical bus',   dims: [1.00, 1.00, 2.00], mass: 240, cd: 2.0, shape: 'cyl' },
};

// ── Thruster units ──────────────────────────────────────────────────────────
// Keys MUST match satellite-designer-engine.js ENGINE_PRESETS so the flight
// model's thrust/Isp stay the single source of truth. Here we only add the
// per-unit dry mass + the nozzle size used for the 3-D model.
export const THRUSTER_UNITS = {
    cold_gas:    { label: 'Cold-gas (N₂)',          unitMass: 0.6,  nozzle: 0.04 },
    monoprop:    { label: 'Monoprop hydrazine',     unitMass: 4.0,  nozzle: 0.07 },
    biprop:      { label: 'Bipropellant (MMH/NTO)', unitMass: 12.0, nozzle: 0.11 },
    hall_ion:    { label: 'Hall-effect ion',        unitMass: 8.0,  nozzle: 0.09 },
    gridded_ion: { label: 'Gridded ion (Xe)',       unitMass: 10.0, nozzle: 0.10 },
};

// ── Solar arrays ────────────────────────────────────────────────────────────
// wings = number of deployable panels, areaKgM2 = panel areal density,
// ramFactor = fraction of full panel area that actually faces the ram (sun-
// tracking arrays spend a lot of the orbit broadside to the flow), cd = flat-
// plate free-molecular drag coefficient.
export const PANELS = {
    none:  { label: 'Body-mounted only', wings: 0, areaKgM2: 0,   ramFactor: 0,    cd: 0   },
    dual:  { label: 'Dual deployable',   wings: 2, areaKgM2: 2.3, ramFactor: 0.55, cd: 2.5 },
    quad:  { label: 'Quad deployable',   wings: 4, areaKgM2: 2.3, ramFactor: 0.55, cd: 2.5 },
    large: { label: 'Large array',       wings: 2, areaKgM2: 1.8, ramFactor: 0.6,  cd: 2.6 },
};

const AVIONICS_MASS = 6;     // kg — flight computer, comms, harness, reaction wheels

export function defaultBuild() {
    return { body: 'smallsat', thruster: 'monoprop', thrusterCount: 2,
             panel: 'dual', panelSpan: 2.2 };
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
 *            bodyArea,panelArea,panelMass}}
 */
export function deriveDesign(build, presets = null) {
    const b = BODIES[build.body] || BODIES.smallsat;
    const tu = THRUSTER_UNITS[build.thruster] || THRUSTER_UNITS.monoprop;
    const p = PANELS[build.panel] || PANELS.none;
    const count = Math.max(1, Math.round(build.thrusterCount || 1));

    // Bus broadside ram area (largest face for box, side rectangle for cyl).
    const [dx, dy, dz] = b.dims;
    const bodyArea = b.shape === 'cyl'
        ? dx * dz                                   // diameter × length
        : Math.max(dx * dy, dx * dz, dy * dz);      // biggest box face

    const perWing = wingArea(build.panelSpan);
    const totalPanelArea = perWing * p.wings;
    const panelRamArea = totalPanelArea * p.ramFactor;
    const panelMass = totalPanelArea * p.areaKgM2;

    const area = bodyArea + panelRamArea;
    // Area-weighted blend of body vs. flat-plate panel drag coefficients.
    const cd = panelRamArea > 0
        ? (b.cd * bodyArea + p.cd * panelRamArea) / area
        : b.cd;

    const dryMass = b.mass + tu.unitMass * count + panelMass + AVIONICS_MASS;

    const out = {
        dryMass:      round(dryMass, 1),
        area:         round(area, 3),
        cd:           round(cd, 3),
        engine:       build.thruster,
        thrusterCount: count,
        bodyArea:     round(bodyArea, 3),
        panelArea:    round(totalPanelArea, 3),
        panelMass:    round(panelMass, 2),
    };
    if (presets && presets[build.thruster]) {
        out.thrust = round(presets[build.thruster].thrust * count, 3);
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
    const b = BODIES[build.body] || BODIES.smallsat;
    const tu = THRUSTER_UNITS[build.thruster] || THRUSTER_UNITS.monoprop;
    const p = PANELS[build.panel] || PANELS.none;
    const count = Math.max(1, Math.round(build.thrusterCount || 1));
    const [dx, dy, dz] = b.dims;

    // ── Bus ──
    const busMat = new THREE.MeshStandardMaterial({
        color: 0xb9a05a, metalness: 0.65, roughness: 0.42,
        emissive: 0x141005, emissiveIntensity: 0.4,
    });
    let bus;
    if (b.shape === 'cyl') {
        bus = new THREE.Mesh(new THREE.CylinderGeometry(dx / 2, dx / 2, dz, 28), busMat);
        bus.rotation.x = Math.PI / 2;                // align cylinder to +z
    } else {
        bus = new THREE.Mesh(new THREE.BoxGeometry(dx, dy, dz), busMat);
    }
    g.add(bus);

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

    // Antenna whip for a little silhouette character.
    const antMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.6, roughness: 0.4 });
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, dz * 0.5, 8), antMat);
    ant.position.set(0, dy / 2 + dz * 0.25, dz * 0.3);
    g.add(ant);

    return g;
}

/** Largest bounding dimension (m) — handy for fitting the camera. */
export function buildExtent(build) {
    const b = BODIES[build.body] || BODIES.smallsat;
    const p = PANELS[build.panel] || PANELS.none;
    const [dx, dy, dz] = b.dims;
    const span = p.wings > 0 ? clampNum(build.panelSpan, 0.3, 8, 2) : 0;
    return Math.max(dz, dy, dx + 2 * (span + 0.2));
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
    const presets = { monoprop: { thrust: 22, isp: 225 }, hall_ion: { thrust: 0.25, isp: 1800 } };

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

    // No panels ⇒ Cd collapses to the bare bus value.
    const np = deriveDesign({ ...defaultBuild(), panel: 'none' }, presets);
    T(Math.abs(np.cd - BODIES[defaultBuild().body].cd) < 1e-6,
        `no panels ⇒ Cd = bus Cd (${np.cd})`);

    // A big bus is heavier and draggier than a CubeSat.
    const cube = deriveDesign({ ...defaultBuild(), body: 'cubesat_3u', panel: 'none' }, presets);
    const big = deriveDesign({ ...defaultBuild(), body: 'bus_med', panel: 'none' }, presets);
    T(big.dryMass > cube.dryMass && big.area > cube.area,
        `bus_med ≫ 3U (m ${cube.dryMass}→${big.dryMass}, A ${cube.area}→${big.area})`);

    return out;
}
