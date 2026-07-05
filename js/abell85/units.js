// units.js — unit system + formatting for the Abell 85 / Holm 15A binary lab.
//
// Working unit system (chosen so numbers stay near unity at galactic scale):
//   length  : parsec (pc)
//   velocity: km/s
//   mass    : solar mass (Msun)
//   time    : megayear (Myr)
// In these units G = 4.30091e-3 pc (km/s)^2 / Msun, and a velocity of
// 1 km/s sustained for 1 Myr covers KMS_MYR = 1.02271 pc.

export const G = 4.30091e-3;          // pc (km/s)^2 / Msun
export const C_KMS = 299792.458;      // km/s
export const KMS_MYR = 1.022712e0;    // pc per (km/s · Myr)
export const PC_M = 3.0857e16;        // metres per parsec
export const MSUN_KG = 1.98892e30;    // kg
export const G_SI = 6.6743e-11;       // m^3 kg^-1 s^-2
export const C_SI = 2.99792458e8;     // m/s
export const YR_S = 3.15576e7;        // seconds per Julian year
export const MYR_S = YR_S * 1e6;
export const AU_PC = 4.84814e-6;      // pc per AU
export const MPC_PC = 1e6;

/** Gravitational radius GM/c^2 in pc for mass in Msun. */
export function rGrav(mMsun) {
    return (G * mMsun) / (C_KMS * C_KMS);
}

/** Schwarzschild radius 2GM/c^2 in pc. */
export function rSchw(mMsun) { return 2 * rGrav(mMsun); }

/** Keplerian orbital period in Myr for semimajor axis a [pc] around total mass M [Msun]. */
export function keplerPeriodMyr(aPc, mMsun) {
    // P = 2π sqrt(a^3 / GM); sqrt(pc^2/(km/s)^2) = pc/(km/s) = 0.97779 Myr
    const pcPerKms = Math.sqrt((aPc * aPc * aPc) / (G * mMsun));
    return 2 * Math.PI * pcPerKms / KMS_MYR;
}

/** Relative circular orbital speed [km/s] at separation a [pc], total mass M [Msun]. */
export function vCircKms(aPc, mMsun) {
    return Math.sqrt((G * mMsun) / aPc);
}

/** Observed GW frequency (quadrupole, circular: 2× orbital) in Hz. */
export function fGwHz(aPc, mMsun) {
    const pMyr = keplerPeriodMyr(aPc, mMsun);
    return 2 / (pMyr * MYR_S);
}

/**
 * Characteristic strain of a circular binary at luminosity distance dMpc.
 * h = 4 (G Mc)^{5/3} (π f_gw)^{2/3} / (c^4 D)   [sky/polarization-averaged scale]
 */
export function strainCircular(m1, m2, aPc, dMpc) {
    const mTot = m1 + m2;
    const eta = (m1 * m2) / (mTot * mTot);
    const mc = Math.pow(eta, 3 / 5) * mTot;                  // chirp mass, Msun
    const gmc = G_SI * mc * MSUN_KG;                          // m^3/s^2
    const f = fGwHz(aPc, mTot);                               // Hz
    const dM = dMpc * MPC_PC * PC_M;                          // metres
    return 4 * Math.pow(gmc, 5 / 3) * Math.pow(Math.PI * f, 2 / 3)
        / (Math.pow(C_SI, 4) * dM);
}

// ── Formatting helpers ───────────────────────────────────────────────────────

export function fmtLen(pc) {
    const abs = Math.abs(pc);
    if (abs >= 1e3) return (pc / 1e3).toPrecision(3) + ' kpc';
    if (abs >= 0.1) return pc.toPrecision(3) + ' pc';
    const au = pc / AU_PC;
    if (au >= 1) return au.toPrecision(3) + ' AU';
    return (pc * PC_M / 1e3).toExponential(2) + ' km';
}

export function fmtTime(myr) {
    const abs = Math.abs(myr);
    if (abs >= 1e3) return (myr / 1e3).toPrecision(3) + ' Gyr';
    if (abs >= 1) return myr.toPrecision(3) + ' Myr';
    if (abs >= 1e-3) return (myr * 1e3).toPrecision(3) + ' kyr';
    return (myr * 1e6).toPrecision(3) + ' yr';
}

export function fmtMass(msun) {
    if (msun >= 1e9) return (msun / 1e9).toPrecision(3) + '×10⁹ M☉';
    if (msun >= 1e6) return (msun / 1e6).toPrecision(3) + '×10⁶ M☉';
    return msun.toExponential(2) + ' M☉';
}

export function fmtFreq(hz) {
    if (hz >= 1e-6) return (hz * 1e6).toPrecision(3) + ' µHz';
    if (hz >= 1e-9) return (hz * 1e9).toPrecision(3) + ' nHz';
    return hz.toExponential(2) + ' Hz';
}
