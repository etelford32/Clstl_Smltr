/**
 * physics.js — Accretion-disc & planet-formation physics core.
 *
 * Implements (all in SI; r in metres, Sigma in kg/m^2, t in seconds):
 *
 *  - Hayashi (1981) MMSN initial Sigma(r), T(r), snow line at 170 K
 *  - Shakura & Sunyaev (1973) alpha-viscosity:  nu = alpha * c_s * H
 *  - Lynden-Bell & Pringle (1974) 1D viscous spreading on a log grid
 *  - Weidenschilling (1977) / Birnstiel et al. (2012) dust radial drift
 *  - Lambrechts & Johansen (2012) pebble accretion onto embryos
 *  - Paardekooper, Baruteau & Kley (2010, 2011) Type I migration torque
 *  - Crida, Morbidelli & Masset (2006) gap-opening criterion -> Type II
 *  - WHFast-style democratic-heliocentric kick-drift-kick step
 *
 * No external dependencies. All functions are pure where possible.
 */

// ─── Physical constants (SI) ─────────────────────────────────────────────────
export const G        = 6.67430e-11;       // m^3 kg^-1 s^-2
export const M_SUN    = 1.98892e30;        // kg
export const R_SUN    = 6.9634e8;          // m
export const L_SUN    = 3.828e26;          // W
export const AU       = 1.495978707e11;    // m
export const YEAR     = 3.15576e7;         // s
export const M_EARTH  = 5.9722e24;         // kg
export const R_EARTH  = 6.371e6;           // m
export const SIGMA_SB = 5.670374419e-8;    // W m^-2 K^-4
export const K_B      = 1.380649e-23;      // J/K
export const M_H      = 1.6735575e-27;     // kg (hydrogen atom)
export const MU_GAS   = 2.34;              // mean molecular weight, H2+He
export const KM       = 1000;

// ─── Hayashi MMSN profile (Hayashi 1981, PTPS 70, 35) ───────────────────────
// Sigma_gas = 1700 (r/AU)^(-3/2) g/cm^2; Sigma_dust x 4.2 inside snow line.
// T_eq(r)  = 280 (r/AU)^(-1/2) K  for L = L_sun (passive disc).
export function hayashiSigmaGas(rAU) {
    return 1700 * Math.pow(rAU, -1.5) * 10; // 1 g/cm^2 = 10 kg/m^2
}
export function hayashiTemp(rAU, Lstar = L_SUN) {
    return 280 * Math.pow(rAU, -0.5) * Math.pow(Lstar / L_SUN, 0.25);
}
export const T_SNOW = 170; // K — water-ice condensation threshold
export function snowLineAU(Lstar = L_SUN) {
    // T(r) = 280 (r/AU)^(-1/2) (L/Lsun)^(1/4) = 170  =>  r = (280/170)^2 sqrt(L/Lsun)
    return Math.pow(280 / T_SNOW, 2) * Math.sqrt(Lstar / L_SUN);
}

// Sound speed from local T (isothermal in the vertical direction).
export function soundSpeed(T) {
    return Math.sqrt(K_B * T / (MU_GAS * M_H));
}
// Keplerian angular frequency at radius r around mass M.
export function omegaK(r, Mstar) {
    return Math.sqrt(G * Mstar / (r * r * r));
}
// Pressure scale height H = c_s / Omega_K.
export function scaleHeight(T, r, Mstar) {
    return soundSpeed(T) / omegaK(r, Mstar);
}
// Shakura-Sunyaev kinematic viscosity nu = alpha c_s H.
export function alphaViscosity(alpha, T, r, Mstar) {
    const cs = soundSpeed(T);
    const H  = cs / omegaK(r, Mstar);
    return alpha * cs * H;
}

// ─── 1D viscous-disc grid (LBP 1974) ─────────────────────────────────────────
// Log-spaced grid in r; Sigma is updated by an explicit FTCS step on the
// Lynden-Bell & Pringle equation
//   dSigma/dt = (3/r) d/dr [ r^(1/2) d/dr ( nu Sigma r^(1/2) ) ]
// with zero Sigma at the inner edge (accreted) and Sigma -> 0 outer.
export function makeDiscGrid({ Mstar, Mdisc, rInAU = 0.1, rOutAU = 60, n = 90, alpha = 1e-3, Lstar = L_SUN }) {
    const rIn  = rInAU  * AU;
    const rOut = rOutAU * AU;
    const r = new Float64Array(n);
    const logIn  = Math.log(rIn);
    const logOut = Math.log(rOut);
    for (let i = 0; i < n; i++) {
        r[i] = Math.exp(logIn + (logOut - logIn) * i / (n - 1));
    }
    const sigma = new Float64Array(n);
    const sigmaDust = new Float64Array(n);
    const T = new Float64Array(n);

    // Initial Hayashi profile scaled so the integrated disc mass = Mdisc.
    let mIntegral = 0;
    for (let i = 0; i < n; i++) {
        const rAU = r[i] / AU;
        sigma[i] = hayashiSigmaGas(rAU);
        T[i] = hayashiTemp(rAU, Lstar);
        const dr = (i < n - 1) ? (r[i+1] - r[i]) : (r[i] - r[i-1]);
        mIntegral += 2 * Math.PI * r[i] * sigma[i] * dr;
    }
    const scale = Mdisc / mIntegral;
    for (let i = 0; i < n; i++) {
        sigma[i] *= scale;
        // Dust:gas ratio 1:100 outside snow line, 1/4.2 of that inside (ices condense)
        const inside = T[i] > T_SNOW;
        sigmaDust[i] = sigma[i] * (inside ? 0.0033 : 0.014);
    }

    return {
        r, sigma, sigmaDust, T,
        Mstar, Lstar, alpha,
        n,
        Mdotacc: 0,   // running mass accreted onto star (kg)
    };
}

// One explicit LBP step. dt should satisfy CFL: dt < 0.4 * min(dr^2 / nu).
// Optional second arg `{ photoEvap: bool }` toggles the Owen+ (2012) sink.
export function stepDisc(disc, dt, opts = {}) {
    const usePhotoEvap = opts.photoEvap !== false;
    const { r, sigma, T, n, Mstar, alpha, Lstar } = disc;
    const newSigma = new Float64Array(n);

    // Pre-compute nu and X = r^(1/2) at each cell.
    const nu    = new Float64Array(n);
    const sqrtr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        nu[i]    = alphaViscosity(alpha, T[i], r[i], Mstar);
        sqrtr[i] = Math.sqrt(r[i]);
    }

    // Build q = nu * Sigma * sqrt(r) at cell centres, then a face-centred dq/dr.
    const q = new Float64Array(n);
    for (let i = 0; i < n; i++) q[i] = nu[i] * sigma[i] * sqrtr[i];

    // Face-centred quantity F_{i+1/2} = sqrt(r_{i+1/2}) * (q_{i+1} - q_i)/(r_{i+1} - r_i)
    const F = new Float64Array(n + 1); // F[0]..F[n]; F[0] and F[n] are boundary fluxes
    for (let i = 0; i < n - 1; i++) {
        const rFace = 0.5 * (r[i] + r[i+1]);
        F[i+1] = Math.sqrt(rFace) * (q[i+1] - q[i]) / (r[i+1] - r[i]);
    }
    // Inner boundary: zero-torque (Sigma=0 at r_in, gas drains onto the star).
    F[0] = F[1];
    // Outer boundary: no mass flux beyond rOut.
    F[n] = 0;

    // Update Sigma: dSigma/dt = (3/r) * (1/dr) * d/dr [ sqrt(r) d q / d r ]
    let accreted = 0;
    for (let i = 0; i < n; i++) {
        const rLeft  = (i > 0)     ? 0.5 * (r[i-1] + r[i]) : r[i] - 0.5 * (r[i+1] - r[i]);
        const rRight = (i < n - 1) ? 0.5 * (r[i] + r[i+1]) : r[i] + 0.5 * (r[i] - r[i-1]);
        const dr     = rRight - rLeft;
        const dSigma = (3 / r[i]) * (F[i+1] - F[i]) / dr;
        newSigma[i] = sigma[i] + dSigma * dt;
        if (newSigma[i] < 0) {
            accreted += -newSigma[i] * 2 * Math.PI * r[i] * dr;
            newSigma[i] = 0;
        }
    }
    // Inner cell drains onto the star (zero-torque accretion).
    {
        const dr = (r[1] - r[0]);
        const drained = newSigma[0] * 0.5; // fraction per step crossing the inner boundary
        accreted += drained * 2 * Math.PI * r[0] * dr;
        newSigma[0] -= drained;
    }

    // Apply photo-evaporation: Owen et al. (2012) -- simple wind sink at r > 1 AU.
    // F_w(r) ~ 1e-9 Msun/yr * (r/AU)^(-2) once disc age > 1 Myr; we fold it
    // into the explicit Sigma update each step proportional to local Sigma.
    if (usePhotoEvap) {
        const photoRate = 1e-9 * M_SUN / YEAR; // kg/s
        for (let i = 0; i < n; i++) {
            const rAU = r[i] / AU;
            if (rAU < 1) continue;
            const local = photoRate / (2 * Math.PI * r[i] * (r[i] - (i > 0 ? r[i-1] : r[0]))) * Math.pow(rAU, -2);
            const dSig  = Math.min(newSigma[i], local * dt);
            newSigma[i] -= dSig;
        }
    }

    for (let i = 0; i < n; i++) sigma[i] = newSigma[i];
    disc.Mdotacc += accreted;

    // Refresh T(r) using time-evolved luminosity (passive disc).
    for (let i = 0; i < n; i++) T[i] = hayashiTemp(r[i] / AU, Lstar);
}

// CFL-stable timestep for the disc explicit step.
export function discDt(disc, safety = 0.25) {
    const { r, T, Mstar, alpha, n } = disc;
    let minDt = Infinity;
    for (let i = 1; i < n; i++) {
        const dr = r[i] - r[i-1];
        const nu = alphaViscosity(alpha, T[i], r[i], Mstar);
        const dt = dr * dr / nu;
        if (dt < minDt) minDt = dt;
    }
    return safety * minDt;
}

// ─── Dust drift (Weidenschilling 1977) ───────────────────────────────────────
// v_drift = -2 eta v_K St / (1 + St^2) with eta = -(1/2)(H/r)^2 d ln P / d ln r.
// We use a power-law P ∝ r^(-11/4) (Hayashi) so d ln P / d ln r ≈ -2.75 -> eta ≈ 1.375 (H/r)^2.
export function dustDriftStep(disc, dt, St = 0.05) {
    const { r, sigmaDust, T, n, Mstar } = disc;
    const newD = new Float64Array(n);

    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const cs = soundSpeed(T[i]);
        const om = omegaK(r[i], Mstar);
        const H  = cs / om;
        const vK = om * r[i];
        const eta = 1.375 * (H / r[i]) * (H / r[i]);
        v[i] = -2 * eta * vK * St / (1 + St * St);
    }

    // Upwind advection in r for inwardly-drifting dust.
    for (let i = 0; i < n; i++) {
        const drIn  = (i > 0)     ? r[i] - r[i-1] : r[1] - r[0];
        const drOut = (i < n - 1) ? r[i+1] - r[i] : r[i] - r[i-1];

        // Flux at the outer face (i+1/2): use cell i+1 since v < 0 (inward).
        const Fout = (i < n - 1) ? sigmaDust[i+1] * v[i+1] * r[i+1] : 0;
        // Flux at the inner face (i-1/2): use cell i.
        const Fin  = sigmaDust[i] * v[i] * r[i];

        const dr = 0.5 * (drIn + drOut);
        newD[i] = sigmaDust[i] - dt * (Fout - Fin) / (r[i] * dr);
        if (newD[i] < 0) newD[i] = 0;
    }
    for (let i = 0; i < n; i++) sigmaDust[i] = newD[i];
}

// Sample Sigma_dust at a planet's location (linear interp in log r).
export function sampleProfile(disc, prop, rPlanet) {
    const arr = disc[prop];
    const r = disc.r;
    if (rPlanet <= r[0]) return arr[0];
    if (rPlanet >= r[r.length - 1]) return arr[r.length - 1];
    let lo = 0, hi = r.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (r[mid] < rPlanet) lo = mid; else hi = mid;
    }
    const f = (Math.log(rPlanet) - Math.log(r[lo])) / (Math.log(r[hi]) - Math.log(r[lo]));
    return arr[lo] * (1 - f) + arr[hi] * f;
}

// ─── Pebble accretion (Lambrechts & Johansen 2012) ───────────────────────────
//   M_dot_p = 2 R_H v_Hill Sigma_peb     (3D Bondi regime ignored for brevity)
// where R_H is the Hill radius and v_Hill = R_H * Omega_K. We multiply by a
// transition factor to avoid runaway when Sigma_dust is small.
export function pebbleAccretionRate(planet, disc) {
    const r = planet.a;
    const om = omegaK(r, disc.Mstar);
    const rH = r * Math.pow(planet.m / (3 * disc.Mstar), 1/3);
    const Sigma_peb = sampleProfile(disc, 'sigmaDust', r);
    const v = rH * om;
    // Hill regime cross section ~ 2 r_H * H_peb but for thin layer H_peb ~ 0.1 H_gas
    return 2 * rH * v * Sigma_peb;
}

// Pebble-isolation mass (Lambrechts+ 2014; Bitsch+ 2018): M_iso ≈ 25 (H/r)^3 M_earth.
export function pebbleIsolationMass(r, disc) {
    const T = hayashiTemp(r / AU, disc.Lstar);
    const H = scaleHeight(T, r, disc.Mstar);
    const hOverR = H / r;
    return 25 * Math.pow(hOverR / 0.05, 3) * M_EARTH;
}

// ─── Type I migration torque (Paardekooper, Baruteau & Kley 2010, 2011) ─────
// Simplified isothermal:
//   Gamma_iso = -(2.5 - 0.1 * alpha_Sigma + 1.7 * beta_T) * Gamma_0
// with Gamma_0 = (q/h)^2 Sigma r^4 Omega^2, q = M_p/M_*, h = H/r.
// alpha_Sigma = -d ln Sigma / d ln r, beta_T = -d ln T / d ln r.
//
// dr/dt = 2 a Gamma / L  with L = M_p * sqrt(G M_*  a)  (angular momentum).
export function typeIMigrationRate(planet, disc) {
    const M_p = planet.m;
    const M_s = disc.Mstar;
    const a   = planet.a;
    const T   = hayashiTemp(a / AU, disc.Lstar);
    const H   = scaleHeight(T, a, M_s);
    const Om  = omegaK(a, M_s);
    const Sigma = sampleProfile(disc, 'sigma', a);
    if (Sigma <= 0) return 0;
    const q = M_p / M_s;
    const h = H / a;
    const Gamma0 = (q / h) * (q / h) * Sigma * a * a * a * a * Om * Om;

    // For Hayashi profile: Sigma ∝ r^-1.5, T ∝ r^-0.5  ->  alpha_S = 1.5, beta_T = 0.5
    const alpha_S = 1.5;
    const beta_T  = 0.5;
    const C_iso   = -(2.5 - 0.1 * alpha_S + 1.7 * beta_T);  // ≈ -3.2 (inward)
    const Gamma   = C_iso * Gamma0;

    const L = M_p * Math.sqrt(G * M_s * a);
    return 2 * a * Gamma / L;   // da/dt in m/s, signed (negative = inward)
}

// Crida+ 2006 gap criterion: planet opens a gap when
//   (3/4)(H/r_H) + 50 alpha (h/q)^2 < 1
// Once true we treat it as Type II (locked to viscous flow).
export function opensGap(planet, disc) {
    const a  = planet.a;
    const T  = hayashiTemp(a / AU, disc.Lstar);
    const H  = scaleHeight(T, a, disc.Mstar);
    const rH = a * Math.pow(planet.m / (3 * disc.Mstar), 1/3);
    const h  = H / a;
    const q  = planet.m / disc.Mstar;
    const lhs = 0.75 * (H / rH) + 50 * disc.alpha * (h / q) * (h / q);
    return lhs < 1;
}

// Type II rate: planet drifts on viscous timescale t_nu = a^2 / nu.
export function typeIIMigrationRate(planet, disc) {
    const a = planet.a;
    const T = hayashiTemp(a / AU, disc.Lstar);
    const nu = alphaViscosity(disc.alpha, T, a, disc.Mstar);
    return -1.5 * nu / a;   // inward at viscous rate
}

// ─── Mini N-body for embryos ────────────────────────────────────────────────
// We track 2D positions, velocities of N embryos around the star. For the
// formation phase we use a simple leapfrog in heliocentric coordinates and
// add gas-driven migration as a forced eccentricity-damped a-update.
export function leapfrog2D(bodies, Mstar, dt) {
    const N = bodies.length;
    // Half-kick
    for (let i = 0; i < N; i++) {
        const ax = gravX(bodies, i, Mstar);
        const ay = gravY(bodies, i, Mstar);
        bodies[i].vx += 0.5 * ax * dt;
        bodies[i].vy += 0.5 * ay * dt;
    }
    // Drift
    for (let i = 0; i < N; i++) {
        bodies[i].x += bodies[i].vx * dt;
        bodies[i].y += bodies[i].vy * dt;
    }
    // Half-kick
    for (let i = 0; i < N; i++) {
        const ax = gravX(bodies, i, Mstar);
        const ay = gravY(bodies, i, Mstar);
        bodies[i].vx += 0.5 * ax * dt;
        bodies[i].vy += 0.5 * ay * dt;
    }
}

function gravX(bodies, i, Mstar) {
    const xi = bodies[i].x, yi = bodies[i].y;
    const ri = Math.hypot(xi, yi);
    let ax = -G * Mstar * xi / (ri * ri * ri);
    for (let j = 0; j < bodies.length; j++) {
        if (j === i) continue;
        const dx = bodies[j].x - xi, dy = bodies[j].y - yi;
        const r2 = dx*dx + dy*dy + 1e6;       // softening (1 km)
        const r3 = r2 * Math.sqrt(r2);
        ax += G * bodies[j].m * dx / r3;
    }
    return ax;
}
function gravY(bodies, i, Mstar) {
    const xi = bodies[i].x, yi = bodies[i].y;
    const ri = Math.hypot(xi, yi);
    let ay = -G * Mstar * yi / (ri * ri * ri);
    for (let j = 0; j < bodies.length; j++) {
        if (j === i) continue;
        const dx = bodies[j].x - xi, dy = bodies[j].y - yi;
        const r2 = dx*dx + dy*dy + 1e6;
        const r3 = r2 * Math.sqrt(r2);
        ay += G * bodies[j].m * dy / r3;
    }
    return ay;
}

// Convert a body's state to orbital semi-major axis.
export function semiMajorAxis(b, Mstar) {
    const r = Math.hypot(b.x, b.y);
    const v2 = b.vx*b.vx + b.vy*b.vy;
    const eps = v2 / 2 - G * Mstar / r;     // specific energy
    return -G * Mstar / (2 * eps);
}

// Reset a body onto a circular Keplerian orbit at radius a.
export function setCircular(b, Mstar, a, phase = 0) {
    const v = Math.sqrt(G * Mstar / a);
    b.x = a * Math.cos(phase); b.y = a * Math.sin(phase);
    b.vx = -v * Math.sin(phase); b.vy = v * Math.cos(phase);
}

// Apply migration to a body (smoothly shrink a while keeping e ~ 0).
export function applyMigration(b, Mstar, daDt, dt) {
    const a = semiMajorAxis(b, Mstar);
    if (!isFinite(a) || a <= 0) return;
    const aNew = Math.max(0.01 * AU, a + daDt * dt);
    const ratio = aNew / a;
    // Scale radius and rescale velocity to remain on a circular orbit at the new a.
    b.x *= ratio; b.y *= ratio;
    const vCirc = Math.sqrt(G * Mstar / aNew);
    const vmag  = Math.hypot(b.vx, b.vy);
    if (vmag > 0) { b.vx *= vCirc / vmag; b.vy *= vCirc / vmag; }
}

// Roche limit (fluid satellite) for inspiral checks (Phobos).
export function rocheLimitFluid(R_primary, rho_primary, rho_sat) {
    return 2.44 * R_primary * Math.pow(rho_primary / rho_sat, 1/3);
}

// Toomre Q for gravitational stability of the gas disc.
export function toomreQ(disc, i) {
    const cs = soundSpeed(disc.T[i]);
    const kappa = omegaK(disc.r[i], disc.Mstar);     // Keplerian: kappa = Omega
    if (disc.sigma[i] <= 0) return Infinity;
    return cs * kappa / (Math.PI * G * disc.sigma[i]);
}
