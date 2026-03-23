/**
 * MagnetosphereEngine — real-time magnetosphere geometry + ionospheric analysis
 *
 * Scene layout (Earth at origin, R_E = 1 Three.js unit):
 *
 *   _solarGroup  (world-space Group, Y-axis aligned toward sun each frame)
 *     ├─ magnetopauseFill   Shue-1998 parametric surface, translucent fill
 *     ├─ magnetopauseWire   same surface, wireframe overlay
 *     ├─ bowShockWire       Farris-Russell bow shock, wireframe
 *     └─ tail               flattened cylinder in the anti-solar lobe
 *
 *   _eqGroup  (world-space Group at origin, equatorial-plane objects, no rotation)
 *     ├─ innerBelt    Van Allen inner belt torus  ~1.6 Re additive blue
 *     ├─ outerBelt    Van Allen outer belt torus  ~4–6 Re additive orange
 *     └─ plasmasphere plasmapause torus           ~Lpp Re  additive cyan
 *
 * ── Physics references ─────────────────────────────────────────────────────
 *  Shue et al. (1998) JGR 103(A8): magnetopause standoff model
 *  Farris & Russell (1994) JGR: bow shock model
 *  Carpenter & Anderson (1992): plasmapause empirical formula
 *  O'Brien & McPherron (2002): ring current Dst injection model
 *  IRI-2016 (simplified): ionospheric layer parameters
 *
 * ── Exported API ───────────────────────────────────────────────────────────
 *  MagnetosphereEngine   class  — create once, call .update() + .tick()
 *  computeShue           physics function
 *  computePlasmapause    physics function
 *  computeIonoLayers     physics function
 *  computeRingCurrentDst physics function
 *  computeJouleHeating   physics function
 */

import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
//  Physical constants and helpers
// ─────────────────────────────────────────────────────────────────────────────
const DEG = Math.PI / 180;

/**
 * Shue et al. (1998) magnetopause standoff model.
 *
 * Returns { r0, alpha, pdyn } where:
 *   r0    — subsolar magnetopause distance (Earth radii)
 *   alpha — magnetopause flaring parameter (dimensionless)
 *   pdyn  — solar wind dynamic pressure (nPa)
 *
 * Inputs:
 *   n  — solar wind proton density (n/cm³)
 *   v  — solar wind speed (km/s)
 *   bz — IMF Bz component in GSM (nT, positive = northward)
 *
 * Valid range: n 1–50 n/cm³, v 250–900 km/s, Bz −30 to +15 nT
 */
export function computeShue(n = 5, v = 400, bz = 0) {
    const pdyn = 1.67e-6 * n * v * v;          // nPa (1.67e-6 = m_p in kg × 1e-12 unit conv)
    const pdynSafe = Math.max(0.05, pdyn);

    const r0 = Math.max(3.5,
        (10.22 + 1.29 * Math.tanh(0.184 * (bz + 8.14)))
        * Math.pow(pdynSafe, -1 / 6.6)
    );
    const alpha = Math.max(0.30,
        (0.58 - 0.007 * bz) * (1 + 0.024 * Math.log(pdynSafe))
    );
    return { r0, alpha, pdyn };
}

/**
 * Bow shock standoff — empirical fit to Farris & Russell (1994).
 * r_bs ≈ r_mp + (0.14 × r_mp + 1.6) with a minimum separation of 1.5 Re.
 */
export function computeBowShock(r0, alpha) {
    const rBs = Math.max(r0 + 1.5, r0 * 1.14 + 1.0);
    // Bow shock is more blunt than magnetopause (smaller alpha)
    return { r0: rBs, alpha: Math.max(0.30, alpha - 0.08) };
}

/**
 * Plasmapause L-shell location (Earth radii).
 * Carpenter & Anderson (1992): Lpp ≈ 5.6 − 0.46 × Kp_max
 * We use current Kp as a proxy for 24-h Kp_max.
 */
export function computePlasmapause(kp = 2) {
    return Math.max(1.8, Math.min(6.5, 5.6 - 0.46 * kp));
}

/**
 * Ring current Dst proxy (nT) using simplified O'Brien & McPherron (2002).
 * Negative = ring current injection (storm main phase).
 *   dDst/dt ≈ Q(Bz, v) − Dst/τ   τ ≈ 7 h recovery time constant
 * We return a rough steady-state approximation:
 *   Dst_ss ≈ τ × Q  where Q ≈ -4.4(VBs - 0.49) for VBs > 0.49 mV/m
 *   VBs = v × max(0, -Bz) × 1e-3  (dawn-dusk electric field, mV/m)
 */
export function computeRingCurrentDst(kp = 2, pdyn = 1.3, bz = 0) {
    const v       = 400;   // approx solar wind speed from pdyn
    const VBs     = v * Math.max(0, -bz) * 1e-3;   // mV/m
    const Q       = VBs > 0.49 ? -4.4 * (VBs - 0.49) : 0;  // nT/h
    const tau     = 7;     // hours recovery time constant
    const Dst_inj = Q * tau;
    // Add quiet-time Dst from dynamic pressure term (pressure-related ring current)
    const Dst_pdyn = -7.26 * Math.sqrt(Math.max(0.1, pdyn));
    return Math.max(-600, Math.min(30, Dst_inj + Dst_pdyn));
}

/**
 * Joule heating rate in the auroral ionosphere (GW).
 * Proxy: Q_J ≈ 0.15 × Kp² + 0.4 × Kp  (simplified, valid ≈ 1–100 GW range)
 * Reference: Emery et al. (1999) auroral Joule heating statistics.
 */
export function computeJouleHeating(kp = 2) {
    return Math.max(0.5, 0.15 * kp * kp + 0.4 * kp);  // GW
}

/**
 * Ionospheric layer analysis — simplified IRI-2016 parameterization.
 *
 * Returns an object describing the four main layers:
 *   dLayerAbs   — D-layer HF absorption at 10 MHz (dB) — dayside only
 *   foE         — E-layer critical frequency (MHz)
 *   foF2        — F2-layer critical frequency (MHz)  [highest daytime frequency]
 *   hmF2        — F2-layer peak height (km)
 *   tec         — Total Electron Content (TECU = 10^16 el/m²)
 *   eLayerNorm  — normalised E-layer electron density [0,1]
 *   f2Active    — true if foF2 > 6 MHz (strongly ionized)
 *   blackout    — true if D-layer absorption > 10 dB (HF radio blackout)
 *
 * @param {number} f107    F10.7 solar radio flux (sfu, 65–300 typical)
 * @param {number} kp      Planetary K-index (0–9)
 * @param {number} xray    GOES X-ray flux (W/m², 1e-9 to 1e-2)
 * @param {number} szaDeg  Representative solar zenith angle (degrees, 0=subsolar)
 */
export function computeIonoLayers(f107 = 150, kp = 2, xray = 1e-8, szaDeg = 50) {
    const cosZ    = Math.max(0, Math.cos(szaDeg * DEG));
    const dayFac  = cosZ;            // 0 (night) → 1 (subsolar)
    const f107n   = (f107 - 65) / 235;   // 0 (min) → 1 (max), clamped below

    // D layer (60–90 km) — only exists on dayside, enhanced by solar X-rays
    // Chapman ionisation theory: absorption A ∝ √(X-ray flux) × cos(χ)
    const fluxRef    = 1e-5;   // M1.0 reference level
    const xrayRatio  = Math.sqrt(Math.max(0, xray) / fluxRef);
    const dLayerAbs  = dayFac * xrayRatio * 18.0;  // dB at 10 MHz
    const blackout   = dLayerAbs > 10;

    // E layer (100–150 km, peak ~110 km)
    // foE ≈ 0.9 × f(F10.7) × (cos χ)^0.25
    const foE = dayFac > 0.01
        ? 0.9 * (1 + 0.006 * f107) * Math.pow(cosZ, 0.25)
        : 0.5;   // weak night-time E

    // F2 layer (200–450 km)
    // foF2 depends on F10.7 (photoionisation) and Kp (storm-time depletion)
    // Quiet daytime mid-lat: ~7–12 MHz. Storm-time negative phase: −3 MHz typical.
    const foF2_quiet = 4.0 + 0.035 * f107 * (0.3 + 0.7 * dayFac);
    const stormDelta = kp > 4 ? -(kp - 4) * 0.7 : 0;  // negative storm phase
    const foF2 = Math.max(1.5, foF2_quiet + stormDelta);

    // F2 peak height: rises during storms, lower during solar max
    const hmF2 = 290 - 0.02 * f107 + kp * 8;   // km

    // TEC (total electron content, TECU = 10^16 el/m²)
    // Solar max noon quiet: ~100 TECU; solar min night: ~5 TECU
    const tec = Math.max(2,
        (10 + 0.4 * f107) * Math.pow(Math.max(0.01, cosZ), 0.6) * Math.max(0.1, 1 - 0.08 * kp)
    );

    return {
        dLayerAbs:  Math.max(0, dLayerAbs),
        foE:        Math.max(0, foE),
        foF2:       foF2,
        hmF2:       hmF2,
        tec:        tec,
        eLayerNorm: Math.min(1, dayFac * (1 + f107n * 0.5)),
        f2Active:   foF2 > 6,
        blackout,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Geometry builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a Shue-model profile for THREE.LatheGeometry.
 * The profile is in the XY plane (X = transverse radius, Y = along sun-line).
 * LatheGeometry revolves around Y; we orient the group so +Y → sun.
 *
 * θ = 0  →  subsolar nose (X=0,  Y=r0)
 * θ = π/2 → equatorial flank (X=r_flank, Y=0)
 * θ → π  →  magnetotail opening (large X, negative Y)
 */
function shueProfile(r0, alpha, nPts = 64) {
    const theta_max = Math.PI * 0.87;   // stop before tail degenerates
    const pts = [];
    for (let i = 0; i <= nPts; i++) {
        const theta = (i / nPts) * theta_max;
        const r     = r0 * Math.pow(2 / (1 + Math.cos(theta)), alpha);
        pts.push(new THREE.Vector2(
            r * Math.sin(theta),   // radius from Y axis (LatheGeometry X)
            r * Math.cos(theta),   // height along Y axis
        ));
    }
    return pts;
}

function buildShueMesh(r0, alpha, color, opacity, wireframe = false) {
    const profile = shueProfile(r0, alpha);
    const geo     = new THREE.LatheGeometry(profile, wireframe ? 36 : 48);
    const mat     = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side:        THREE.DoubleSide,
        depthWrite:  false,
        wireframe,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = wireframe ? 5 : 4;
    return mesh;
}

function buildTorus(radius, tube, color, opacity, segments = 48) {
    const geo  = new THREE.TorusGeometry(radius, tube, 16, segments);
    const mat  = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
        side:        THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    return mesh;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MagnetosphereEngine
// ─────────────────────────────────────────────────────────────────────────────
export class MagnetosphereEngine {
    /**
     * @param {THREE.Scene}       scene
     * @param {THREE.Vector3Ref}  sunDirRef  — mutable reference to earthU.u_sun_dir.value
     */
    constructor(scene) {
        this._scene = scene;

        // ── Sun-aligned group (magnetopause, bow shock, tail) ──────────────
        this._solarGroup = new THREE.Group();
        this._solarGroup.name = 'magnetosphere_solar';
        scene.add(this._solarGroup);

        // ── Equatorial-plane group (radiation belts, plasmasphere) ─────────
        // NOT a child of earthMesh — radiation belts are quasi-static in
        // inertial space (aligned with magnetic equator, not rotating with Earth).
        this._eqGroup = new THREE.Group();
        this._eqGroup.name = 'magnetosphere_eq';
        scene.add(this._eqGroup);

        // Initial nominal solar-wind parameters
        this._lastR0    = -1;   // force build on first update()
        this._lastAlpha = -1;
        this._lastKp    = -1;

        this._layers = {
            magnetopause: true,
            bowShock:     true,
            belts:        true,
            plasmasphere: true,
        };

        this.analysis = null;

        // Build with fallback values
        this._rebuildSolarShells(10.9, 0.58);
        this._rebuildEarthShells(2.0, computePlasmapause(2));
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Update geometry and analysis from a fresh SpaceWeatherFeed state object.
     * Call this inside the 'swpc-update' event handler.
     */
    update(state) {
        const sw  = state.solar_wind ?? {};
        const n   = Math.max(0.5,   sw.density     ?? 5);
        const v   = Math.max(200,   sw.speed       ?? 400);
        const bz  = sw.bz ?? 0;
        const kp  = state.kp       ?? 2;
        const f107= state.f107_flux ?? 150;
        const xr  = state.xray_flux ?? 1e-8;

        const { r0, alpha, pdyn } = computeShue(n, v, bz);
        const bs = computeBowShock(r0, alpha);

        // Rebuild solar shells only on significant change (avoids GC pressure)
        if (Math.abs(r0 - this._lastR0) > 0.25 || Math.abs(alpha - this._lastAlpha) > 0.03) {
            this._rebuildSolarShells(r0, alpha);
            this._lastR0    = r0;
            this._lastAlpha = alpha;
        }

        // Rebuild Earth shells on Kp change
        if (Math.abs(kp - this._lastKp) > 0.4) {
            const lpp = computePlasmapause(kp);
            this._rebuildEarthShells(kp, lpp);
            this._lastKp = kp;
        }

        // Compute analysis metrics
        this.analysis = {
            r0,
            alpha,
            pdyn,
            bowShockR0:  bs.r0,
            plasmapause: computePlasmapause(kp),
            dst:         computeRingCurrentDst(kp, pdyn, bz),
            joule:       computeJouleHeating(kp),
            iono:        computeIonoLayers(f107, kp, xr, 50),
            kp,
        };
    }

    /**
     * Per-frame update. Call from animate().
     * @param {number}          t       elapsed seconds
     * @param {THREE.Vector3}   sunDir  world-space unit vector toward sun
     * @param {object}          sw      swpc-feed state (optional; uses last if omitted)
     */
    tick(t, sunDir, sw = {}) {
        // Orient solar group: +Y → sun direction
        const q = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            sunDir.clone().normalize(),
        );
        this._solarGroup.setRotationFromQuaternion(q);

        // ── Derive live quantities ─────────────────────────────────────────
        const wind    = sw.solar_wind ?? {};
        const bz      = wind.bz      ?? 0;
        const speed   = wind.speed   ?? 400;
        const density = wind.density ?? 5;
        const kp      = sw.kp        ?? (sw.geomagnetic?.kp ?? 2);
        const dst     = sw.dst_index ?? (sw.geomagnetic?.dst_nT ?? -5);
        const sep     = sw.sep_storm_level ?? (sw.particles?.sep_storm_level ?? 0);
        const pdyn    = 1.67e-6 * Math.max(0.5, density) * Math.max(200, speed) ** 2; // nPa

        // ── Magnetopause wire — blue (north Bz) ↔ red-violet (south Bz) ───
        if (this._mpWire) {
            const bzSouth = Math.max(0, Math.min(1, -bz / 30));  // 0=north, 1=−30 nT
            // Blue → violet → magenta as southward Bz increases
            const r = Math.round(100 + bzSouth * 155);
            const g = Math.round(120 - bzSouth * 70);
            const b = Math.round(255 - bzSouth * 55);
            this._mpWire.material.color.setRGB(r / 255, g / 255, b / 255);
            // Opacity also scales with Bz southward (more pronounced reconnection visual)
            this._mpWire.material.opacity = 0.30 + bzSouth * 0.35;
        }
        if (this._mpFill) {
            const bzSouth = Math.max(0, Math.min(1, -bz / 30));
            this._mpFill.material.opacity = 0.06 + bzSouth * 0.08;
        }

        // ── Bow shock wire — intensity pulses with dynamic pressure ────────
        if (this._bsWire) {
            const pdynNorm = Math.min(1, pdyn / 6);  // 6 nPa = strong compression
            const pulse    = 0.5 + 0.5 * Math.sin(t * 0.8 + pdynNorm * 3);
            this._bsWire.material.opacity = 0.12 + pdynNorm * 0.22 + pulse * 0.08;
            // Hotter orange → yellow at high pressure
            const g = Math.round(136 + pdynNorm * 80);
            this._bsWire.material.color.setRGB(1.0, g / 255, 0.2 - pdynNorm * 0.1);
        }

        // ── Radiation belt glow pulses + storm enhancement ─────────────────
        const kpNorm  = Math.min(1, kp / 9);
        const sepNorm = Math.min(1, sep / 5);

        if (this._outerBelt) {
            this._outerBelt.material.opacity =
                0.16 + 0.07 * Math.sin(t * 1.7) + kpNorm * 0.12 + sepNorm * 0.08;
        }
        if (this._innerBelt) {
            this._innerBelt.material.opacity =
                0.22 + 0.06 * Math.sin(t * 2.3 + 1.1) + sepNorm * 0.16;
        }
        if (this._plasmasphere) {
            this._plasmasphere.material.opacity = 0.08 + 0.03 * Math.sin(t * 0.9 + 0.5);
        }

        // ── Ring current — scales with |Dst| (storm main phase injection) ──
        if (this._ringCurrent) {
            const dstNorm = Math.min(1, Math.max(0, -dst) / 200);
            this._ringCurrent.material.opacity =
                dstNorm * 0.28 + 0.03 * Math.sin(t * 1.1) * dstNorm;
        }
    }

    setLayerVisible(name, v) {
        this._layers[name] = v;
        switch (name) {
            case 'magnetopause':
                this._mpFill?.traverse(o => { if (o.isMesh || o.isLine) o.visible = v; });
                this._mpWire?.traverse(o => { if (o.isMesh || o.isLine) o.visible = v; });
                if (this._tail) this._tail.visible = v;
                break;
            case 'bowShock':
                if (this._bsWire) this._bsWire.visible = v;
                break;
            case 'belts':
                if (this._innerBelt) this._innerBelt.visible = v;
                if (this._outerBelt) this._outerBelt.visible = v;
                break;
            case 'plasmasphere':
                if (this._plasmasphere) this._plasmasphere.visible = v;
                break;
        }
    }

    dispose() {
        [this._solarGroup, this._eqGroup].forEach(g => {
            g.traverse(o => {
                o.geometry?.dispose();
                o.material?.dispose();
            });
            this._scene.remove(g);
        });
    }

    // ── Internal geometry builders ────────────────────────────────────────────

    _rebuildSolarShells(r0, alpha) {
        // Remove old
        while (this._solarGroup.children.length) {
            const c = this._solarGroup.children[0];
            c.geometry?.dispose();
            c.material?.dispose();
            this._solarGroup.remove(c);
        }

        // Magnetopause fill (semi-transparent blue-purple)
        this._mpFill = buildShueMesh(r0, alpha, 0x334477, 0.09, false);
        this._solarGroup.add(this._mpFill);

        // Magnetopause wireframe overlay
        this._mpWire = buildShueMesh(r0, alpha, 0x5577bb, 0.45, true);
        this._solarGroup.add(this._mpWire);

        // Bow shock wireframe (orange, wider and more blunt)
        const bs = computeBowShock(r0, alpha);
        this._bsWire = buildShueMesh(bs.r0, bs.alpha, 0xee8833, 0.22, true);
        this._solarGroup.add(this._bsWire);

        // Magnetotail — two elliptical lobes in the anti-solar direction (-Y)
        // Modelled as a flattened cylinder extending -Y from just behind Earth
        const tailLen = 22;
        const tailR   = Math.min(15, r0 * 2.0 * Math.pow(2, alpha));
        const tailGeo = new THREE.CylinderGeometry(tailR * 0.85, tailR, tailLen, 32, 1, true);
        const tailMat = new THREE.MeshBasicMaterial({
            color: 0x223355, transparent: true, opacity: 0.07,
            side: THREE.BackSide, depthWrite: false,
        });
        this._tail = new THREE.Mesh(tailGeo, tailMat);
        this._tail.position.set(0, -(tailLen / 2 + r0 * 0.1), 0);  // offset into -Y (anti-sun)
        this._tail.renderOrder = 3;
        this._solarGroup.add(this._tail);

        // Apply layer visibility
        if (!this._layers.magnetopause) {
            this._mpFill.visible = false;
            this._mpWire.visible = false;
            this._tail.visible   = false;
        }
        if (!this._layers.bowShock) this._bsWire.visible = false;
    }

    _rebuildEarthShells(kp, lpp) {
        // Remove old
        while (this._eqGroup.children.length) {
            const c = this._eqGroup.children[0];
            c.geometry?.dispose();
            c.material?.dispose();
            this._eqGroup.remove(c);
        }

        // Inner Van Allen belt (proton belt, 1.2–2.2 Re, fairly stable)
        // Slightly compressed during major storms (Kp > 7)
        const innerR    = 1.55;
        const innerTube = 0.22;
        this._innerBelt = buildTorus(innerR, innerTube, 0x3366ff, 0.28);
        this._eqGroup.add(this._innerBelt);

        // Outer Van Allen belt (electron belt, Kp-dependent boundary)
        // Outer edge ≈ plasmapause; inner edge ≈ 2.5 Re
        const outerR    = Math.max(2.6, (2.5 + lpp) / 2);
        const outerTube = Math.max(0.5, (lpp - 2.5) / 2 * 0.8);
        this._outerBelt = buildTorus(outerR, outerTube, 0xff7722, 0.20);
        this._eqGroup.add(this._outerBelt);

        // Plasmasphere (cold plasma torus, extends to plasmapause L-shell)
        const psR    = lpp;
        const psTube = lpp * 0.18;
        this._plasmasphere = buildTorus(psR, psTube, 0x44ccee, 0.10, 64);
        this._eqGroup.add(this._plasmasphere);

        // Ring current torus (~3–4 Re) — O'Brien & McPherron driven by Dst
        // Opacity starts near 0; driven up by |Dst| in tick()
        this._ringCurrent = buildTorus(3.6, 0.38, 0xff4400, 0.0, 48);
        this._eqGroup.add(this._ringCurrent);

        // Apply layer visibility
        if (!this._layers.belts) {
            this._innerBelt.visible = false;
            this._outerBelt.visible = false;
        }
        if (!this._layers.plasmasphere) this._plasmasphere.visible = false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Ionospheric layer HTML renderer
//  Call this from earth.html to paint the iono-layers div
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate an HTML string representing the ionospheric layer status bars.
 * @param {ReturnType<computeIonoLayers>} iono
 */
export function renderIonoHTML(iono) {
    const bar = (pct, color) =>
        `<span style="display:inline-block;width:${Math.round(Math.min(100, pct))}%;`
      + `height:5px;background:${color};border-radius:2px;vertical-align:middle;"></span>`;

    const row = (label, value, barPct, color, note = '') =>
        `<div style="display:flex;align-items:center;gap:5px;margin-bottom:3px;">`
      + `<span style="min-width:26px;color:#778">${label}</span>`
      + `<span style="flex:1;background:#111;border-radius:2px;overflow:hidden;">`
      + bar(barPct, color)
      + `</span>`
      + `<span style="min-width:56px;text-align:right;color:#aac;">${value}</span>`
      + (note ? `<span style="color:#556;font-size:8px;">${note}</span>` : '')
      + `</div>`;

    const absNorm = Math.min(100, (iono.dLayerAbs / 30) * 100);
    const foENorm = Math.min(100, (iono.foE / 6) * 100);
    const foF2Norm = Math.min(100, (iono.foF2 / 14) * 100);
    const tecNorm  = Math.min(100, (iono.tec / 120) * 100);

    const dColor  = iono.blackout ? '#ff4422' : iono.dLayerAbs > 3 ? '#ffaa22' : '#44aa66';
    const f2Color = iono.f2Active ? '#44ccff' : '#3366aa';

    return `<div style="font-size:9px;color:#aac;padding:2px 0;">`
         + row('D',  iono.blackout ? 'Blackout!' : `${iono.dLayerAbs.toFixed(1)} dB`, absNorm, dColor,
               iono.blackout ? '⚠' : '')
         + row('E',  `${iono.foE.toFixed(1)} MHz`, foENorm, '#66aaff')
         + row('F2', `${iono.foF2.toFixed(1)} MHz`, foF2Norm, f2Color)
         + row('TEC',`${Math.round(iono.tec)} TECU`, tecNorm, '#88ccaa')
         + `<div style="color:#556;margin-top:3px;">hmF2 ≈ ${Math.round(iono.hmF2)} km</div>`
         + `</div>`;
}
