/**
 * solar-dynamo.js — Parker αΩ mean-field tachocline dynamo
 *
 * Coupled poloidal/toroidal field evolution at the tachocline (r ≈ 0.713
 * R_sun) where the Sun's differential rotation transitions to rigid-body
 * rotation in the radiative zone. This shear layer is the canonical
 * solar dynamo source — it shears the poloidal seed field into toroidal
 * flux ropes that rise via magnetic buoyancy to become sunspots.
 *
 * Mean-field equations (axisymmetric, latitude-only reduction):
 *
 *   ∂A/∂t       =  α(λ)·B_φ  +  η ∇²A  −  v_θ·∂A/∂θ        (poloidal stream func)
 *   ∂B_φ/∂t     =  G(λ)·∂A   +  η ∇²B_φ −  v_θ·∂B_φ/∂θ     (toroidal field)
 *
 *   α(λ)        = α_0 · sin(2λ)              Babcock-Leighton α-effect,
 *                                            antisymmetric across equator,
 *                                            peaks at ±45° (BL flux source).
 *   G(λ)        = Ω_shear · cos(λ)           Ω-effect proxy: latitudinal
 *                                            differential rotation gradient
 *                                            shears Bp into Bφ at the
 *                                            tachocline.
 *   v_θ         = v_0 · sin(2λ)              Meridional circulation
 *                                            equator-ward at depth (matches
 *                                            observed butterfly migration).
 *
 *  Time scaling: 1 sim-second ≈ 1 solar year, so a 22-year (Hale) cycle
 *  reads visually over ~22 sim-seconds. This gives the user time to watch
 *  polarity reversal + equator-ward drift unfold without running for hours.
 *
 *  History buffer: the toroidal field strength at every latitude is
 *  recorded once per sim-second, building the classical Maunder butterfly
 *  diagram naturally as the wave solution propagates equator-ward.
 *
 *  References:
 *    Parker (1955) ApJ 122, 293       — dynamo wave dispersion relation
 *    Babcock (1961)  ApJ 133, 572     — surface α from BMR decay
 *    Charbonneau (2010) Living Rev    — modern flux-transport reviews
 */

const NLAT = 32;

export class SolarDynamo {
    constructor() {
        this.NLAT = NLAT;
        this.lat       = new Float32Array(NLAT);
        this.cosLat    = new Float32Array(NLAT);
        this.sin2Lat   = new Float32Array(NLAT);
        this.A         = new Float32Array(NLAT);   // poloidal stream function ≈ Bp
        this.Bphi      = new Float32Array(NLAT);   // toroidal field
        this.dOmegaDr  = new Float32Array(NLAT);   // ∂Ω/∂r at tachocline (Snodgrass)

        // Latitude grid (centred bins, [-π/2, π/2])
        for (let i = 0; i < NLAT; i++) {
            const lat = ((i + 0.5) / NLAT) * Math.PI - Math.PI / 2;
            this.lat[i]     = lat;
            this.cosLat[i]  = Math.cos(lat);
            this.sin2Lat[i] = Math.sin(2 * lat);
            // Snodgrass surface Ω(λ) − rigid radiative Ω → tachocline shear sign:
            // positive at low |λ| (equator faster than core), negative at high |λ|.
            const sl = Math.sin(lat);
            const Omega_surf = 1.000 - 0.190 * sl * sl - 0.090 * sl * sl * sl * sl;
            const Omega_rad  = 0.930;
            this.dOmegaDr[i] = (Omega_surf - Omega_rad) / 0.04;   // Δr ≈ 0.04 R_sun
        }

        // Seed: weak dipolar Bp (sin λ profile) + zero toroidal
        for (let i = 0; i < NLAT; i++) {
            this.A[i]    = 0.4 * Math.sin(this.lat[i]);
            this.Bphi[i] = 0.0;
        }

        this.simTime    = 0;
        this.cycleStart = 0;

        // Butterfly history: ring buffer of (t, Bphi[NLAT]) snapshots.
        this.HISTORY_LEN = 320;
        this.history     = [];
        this._lastHistAt = -1;

        // Scratch arrays
        this._newA    = new Float32Array(NLAT);
        this._newBphi = new Float32Array(NLAT);
    }

    /**
     * One Euler step. dt is in sim-seconds (≈ years of solar time).
     * Tuned coefficients give a ~22-year period oscillation with
     * equator-ward butterfly migration.
     */
    step(dt) {
        // Cap dt so a frame stall doesn't blow up the integration.
        const dyr = Math.max(0, Math.min(0.20, dt));

        // ── Coupling constants (tuned for 22-year period) ──────────────
        const C_OMEGA  = 0.42;     // Ω-effect strength
        const C_ALPHA  = 0.0185;   // BL α coefficient
        const ETA      = 0.0040;   // turbulent diffusivity (rad²/yr)
        const V_MERID  = 0.082;    // meridional drift amplitude (rad/yr)
        const TAU_DISS = 14.0;     // ohmic dissipation time (yr)

        const A = this.A, Bp = this.Bphi;
        const newA = this._newA, newBp = this._newBphi;
        const dlat = Math.PI / NLAT;
        const inv_dlat2 = 1 / (dlat * dlat);
        const inv_2dlat = 1 / (2 * dlat);

        for (let i = 0; i < NLAT; i++) {
            // ── Source terms ─────────────────────────────────────────
            // α-effect (Babcock-Leighton): poloidal regeneration from
            // toroidal field. Antisymmetric across equator → opposite
            // hemispheres regenerate Bp with opposite sign.
            const dA_alpha = C_ALPHA * this.sin2Lat[i] * Bp[i];
            // Ω-effect: shear on Bp generates Bphi.
            const dBp_omega = C_OMEGA * this.dOmegaDr[i] * this.cosLat[i] * A[i];

            // ── Diffusion (laplacian in latitude) ────────────────────
            const Aip  = A[Math.min(NLAT - 1, i + 1)];
            const Aim  = A[Math.max(0, i - 1)];
            const Bip  = Bp[Math.min(NLAT - 1, i + 1)];
            const Bim  = Bp[Math.max(0, i - 1)];
            const lapA = (Aip - 2 * A[i]  + Aim)  * inv_dlat2;
            const lapB = (Bip - 2 * Bp[i] + Bim)  * inv_dlat2;

            // ── Meridional advection — equator-ward drift at tachocline ─
            // v_θ(λ) = -V·sin(2λ) (negative latitude direction = toward equator)
            const vmer = -V_MERID * this.sin2Lat[i];
            const gradA = (Aip - Aim) * inv_2dlat;
            const gradB = (Bip - Bim) * inv_2dlat;

            // ── Dissipation ─────────────────────────────────────────
            const dissA = -A[i]  / (TAU_DISS * 2);
            const dissB = -Bp[i] / TAU_DISS;

            newA[i]  = A[i]  + dyr * (dA_alpha     + ETA * lapA - vmer * gradA + dissA);
            newBp[i] = Bp[i] + dyr * (dBp_omega    + ETA * lapB - vmer * gradB + dissB);
        }

        // Pole boundaries: zero Bphi (axial regularity), reflective Bp
        newBp[0]        = 0;
        newBp[NLAT - 1] = 0;

        // Swap buffers
        for (let i = 0; i < NLAT; i++) {
            A[i]  = newA[i];
            Bp[i] = newBp[i];
        }

        this.simTime += dt;

        // Snapshot once per ~0.25 sim-sec (≈ 0.25 yr) for butterfly diagram
        if (this.simTime - this._lastHistAt >= 0.20) {
            const snap = new Float32Array(NLAT);
            for (let i = 0; i < NLAT; i++) snap[i] = Bp[i];
            this.history.push({ t: this.simTime, Bphi: snap });
            if (this.history.length > this.HISTORY_LEN) this.history.shift();
            this._lastHistAt = this.simTime;
        }
    }

    /**
     * Linearly sample Bphi at an arbitrary latitude (radians).
     */
    BphiAt(latRad) {
        const f = ((latRad + Math.PI / 2) / Math.PI) * NLAT - 0.5;
        const i0 = Math.max(0, Math.min(NLAT - 2, Math.floor(f)));
        const t  = Math.max(0, Math.min(1, f - i0));
        return this.Bphi[i0] * (1 - t) + this.Bphi[i0 + 1] * t;
    }

    /**
     * Cycle-tracking diagnostics.
     */
    diagnostics() {
        let maxAbsBphi = 0;
        let signedBphi = 0;     // sign of the dominant hemisphere
        let peakLat    = 0;
        let polarBp    = 0;
        let activeBeltMin = Infinity, activeBeltMax = -Infinity;
        for (let i = 0; i < NLAT; i++) {
            const ab = Math.abs(this.Bphi[i]);
            if (ab > maxAbsBphi) {
                maxAbsBphi = ab;
                signedBphi = Math.sign(this.Bphi[i]) || 1;
                peakLat    = this.lat[i];
            }
            if (Math.abs(this.lat[i]) > 1.05) polarBp = Math.max(polarBp, Math.abs(this.A[i]));
            if (ab > 0.15) {
                activeBeltMin = Math.min(activeBeltMin, this.lat[i]);
                activeBeltMax = Math.max(activeBeltMax, this.lat[i]);
            }
        }
        const beltDeg = activeBeltMin === Infinity
            ? null
            : { min: activeBeltMin * 180 / Math.PI, max: activeBeltMax * 180 / Math.PI };
        return {
            simTime:     this.simTime,
            maxBphi:     maxAbsBphi,
            polarity:    signedBphi,
            peakLatDeg:  peakLat * 180 / Math.PI,
            polarBp:     polarBp,
            activeBelt:  beltDeg,
            cyclePhase:  ((this.simTime % 22.0) / 22.0),   // [0, 1) within 22-yr cycle
        };
    }

    /**
     * Pack Bphi into a 32-element Float32Array suitable for shader uniform.
     */
    packBphiArray() {
        return this.Bphi;   // already exactly NLAT entries
    }
}
