//! Finite-volume discretization of ∇⊥·(Σ·∇⊥Φ) and the linear solver.
//!
//! Row equation (per cell, everything in amps):
//!
//! ```text
//! Σ_faces  flux_out(Φ)  =  J∥ · sin(I) · Area
//! ```
//!
//! with the horizontal current J⊥ = Σ·E = −Σ·∇Φ and the height-integrated
//! tensor (northern hemisphere, B pointing down):
//!
//! ```text
//! J_θ = Σtt·E_θ + Σtp·E_φ        Σtt = ΣP/sin²I    Σtp = +ΣH/sinI
//! J_φ = Σpt·E_θ + Σpp·E_φ        Σpp = ΣP          Σpt = −ΣH/sinI
//! ```
//!
//! (θ = colatitude, φ eastward.) The Hall part is antisymmetric — the
//! matrix is NON-symmetric, hence BiCGSTAB, not CG (plan §2.2).
//!
//! Discrete geometry notes:
//!  * θθ face conductances use the HARMONIC mean (correct flux across the
//!    trough's conductance cliffs); Hall face values use the arithmetic mean.
//!  * The Hall term uses the STREAM-FUNCTION form: the Hall current flux
//!    through a face equals Σtp·(Φ_cornerA − Φ_cornerB) exactly (the 1/sinθ
//!    metric cancels the face length). Corner potentials are single-valued
//!    interpolants (4-cell average in the interior, boundary values on the
//!    Dirichlet line, 2-cell average on the pole side — the plan's
//!    "average-over-neighbors" pole closure). Single-valued corners make
//!    the Hall part EXACTLY conservative and exactly divergence-free for
//!    uniform ΣH (it telescopes around each cell) — the
//!    `uniform_hall_is_divergence_free` test pins this to rounding.
//!  * Pedersen pole closure is automatic: the poleward face of the top row
//!    has sin(colat)=0, so its normal-gradient flux vanishes identically.
//!  * Equatorward boundary is Dirichlet (Φ_b per column, zeros in
//!    production); its flux terms move to the RHS via `bc_rhs`.

use crate::grid::{idx, Grid, N, NLAT, NMLT};

// Stencil slots.
pub const C: usize = 0;
const NB: usize = 1; // i+1 (poleward)
const SB: usize = 2; // i−1 (equatorward)
const EB: usize = 3; // j+1
const WB: usize = 4; // j−1
const NE: usize = 5;
const NW: usize = 6;
const SE: usize = 7;
const SW: usize = 8;

pub struct Operator {
    /// 9-point stencil per cell: [C, N, S, E, W, NE, NW, SE, SW].
    pub stencil: Vec<[f64; 9]>,
    /// Dirichlet-boundary contribution to the RHS: b = source + bc_rhs.
    pub bc_rhs: Vec<f64>,
}

#[inline]
fn harm(a: f64, b: f64) -> f64 {
    2.0 * a * b / (a + b)
}

/// Assemble the operator from cell conductances. `sin_dip` is per latitude
/// row (the analytic test passes all-ones; production passes grid.sin_dip).
/// `phi_b` is the Dirichlet boundary potential per column (volts).
pub fn assemble(
    grid: &Grid,
    sigma_p: &[f64],
    sigma_h: &[f64],
    sin_dip: &[f64; NLAT],
    phi_b: &[f64; NMLT],
) -> Operator {
    let dt = grid.dt;
    let dphi = grid.dphi;
    // Cell tensor components.
    let mut s_tt = vec![0.0f64; N];
    let mut s_tp = vec![0.0f64; N];
    // Σpp is just ΣP — use sigma_p directly.
    for i in 0..NLAT {
        let si = sin_dip[i].max(1e-3);
        for j in 0..NMLT {
            let k = idx(i, j);
            s_tt[k] = sigma_p[k] / (si * si);
            s_tp[k] = sigma_h[k] / si;
        }
    }

    let mut st = vec![[0.0f64; 9]; N];
    let mut bc = vec![0.0f64; N];

    for i in 0..NLAT {
        let sc = grid.sin_colat[i];
        for j in 0..NMLT {
            let k = idx(i, j);
            let je = (j + 1) % NMLT;
            let jw = (j + NMLT - 1) % NMLT;

            // ── Pedersen (normal-gradient) parts ────────────────────────

            // Poleward θ-face (between i and i+1):
            // flux_out = cP·(Φ_C − Φ_N). At i = NLAT−1 the face is the
            // pole itself, sin = 0 → zero flux (automatic closure).
            if i + 1 < NLAT {
                let kn = idx(i + 1, j);
                let sf = grid.sin_face_pole[i];
                let cp = harm(s_tt[k], s_tt[kn]) * sf * dphi / dt;
                st[k][C] += cp;
                st[k][NB] -= cp;
            }

            // Equatorward θ-face: flux_out = cP·(Φ_C − Φ_S); Dirichlet
            // half-cell gradient at i = 0.
            if i > 0 {
                let ks = idx(i - 1, j);
                let sf = grid.sin_face_eq[i];
                let cp = harm(s_tt[k], s_tt[ks]) * sf * dphi / dt;
                st[k][C] += cp;
                st[k][SB] -= cp;
            } else {
                let sf = grid.sin_face_eq[0];
                let cp = s_tt[k] * sf * dphi / (0.5 * dt);
                st[k][C] += cp;
                bc[k] += cp * phi_b[j];
            }

            // East φ-face: flux_out = cE·(Φ_C − Φ_E).
            {
                let ke = idx(i, je);
                let ce = harm(sigma_p[k], sigma_p[ke]) * dt / (sc * dphi);
                st[k][C] += ce;
                st[k][EB] -= ce;
            }
            // West φ-face: flux_out = cW·(Φ_C − Φ_W).
            {
                let kw = idx(i, jw);
                let cw = harm(sigma_p[k], sigma_p[kw]) * dt / (sc * dphi);
                st[k][C] += cw;
                st[k][WB] -= cw;
            }

            // ── Hall part — stream-function form over cell corners ──────
            //
            // flux_out^Hall = Σtp_pf·(ne − nw) − Σtp_ef·(se − sw)
            //               + Σtp_e ·(se − ne) + Σtp_w ·(nw − sw)
            //
            // where ne/nw/se/sw are single-valued corner potentials.
            // Grouped per corner:
            //   ne: (Σtp_pf − Σtp_e), nw: (Σtp_w − Σtp_pf),
            //   se: (Σtp_e − Σtp_ef), sw: (Σtp_ef − Σtp_w).
            {
                let tp_pf = if i + 1 < NLAT {
                    0.5 * (s_tp[k] + s_tp[idx(i + 1, j)])
                } else {
                    s_tp[k]
                };
                let tp_ef = if i > 0 {
                    0.5 * (s_tp[k] + s_tp[idx(i - 1, j)])
                } else {
                    s_tp[k]
                };
                let tp_e = 0.5 * (s_tp[k] + s_tp[idx(i, je)]);
                let tp_w = 0.5 * (s_tp[k] + s_tp[idx(i, jw)]);

                let c_ne = tp_pf - tp_e;
                let c_nw = tp_w - tp_pf;
                let c_se = tp_e - tp_ef;
                let c_sw = tp_ef - tp_w;

                // Poleward corners: 4-cell average, or 2-cell average on
                // the pole side (the average-over-neighbors closure).
                if i + 1 < NLAT {
                    let q = 0.25;
                    // ne = ¼(C + E + N + NE)
                    st[k][C] += q * c_ne;
                    st[k][EB] += q * c_ne;
                    st[k][NB] += q * c_ne;
                    st[k][NE] += q * c_ne;
                    // nw = ¼(C + W + N + NW)
                    st[k][C] += q * c_nw;
                    st[k][WB] += q * c_nw;
                    st[k][NB] += q * c_nw;
                    st[k][NW] += q * c_nw;
                } else {
                    let q = 0.5;
                    st[k][C] += q * c_ne;
                    st[k][EB] += q * c_ne;
                    st[k][C] += q * c_nw;
                    st[k][WB] += q * c_nw;
                }

                // Equatorward corners: 4-cell average, or the Dirichlet
                // line value ½(Φb_j + Φb_j±1) at i = 0 (constant → RHS).
                if i > 0 {
                    let q = 0.25;
                    st[k][C] += q * c_se;
                    st[k][EB] += q * c_se;
                    st[k][SB] += q * c_se;
                    st[k][SE] += q * c_se;
                    st[k][C] += q * c_sw;
                    st[k][WB] += q * c_sw;
                    st[k][SB] += q * c_sw;
                    st[k][SW] += q * c_sw;
                } else {
                    let se_b = 0.5 * (phi_b[j] + phi_b[je]);
                    let sw_b = 0.5 * (phi_b[j] + phi_b[jw]);
                    bc[k] -= c_se * se_b + c_sw * sw_b;
                }
            }
        }
    }

    Operator { stencil: st, bc_rhs: bc }
}

/// out = A·x (matrix-free stencil application).
pub fn apply(op: &Operator, x: &[f64], out: &mut [f64]) {
    for i in 0..NLAT {
        for j in 0..NMLT {
            let k = idx(i, j);
            let s = &op.stencil[k];
            let je = (j + 1) % NMLT;
            let jw = (j + NMLT - 1) % NMLT;
            let mut acc = s[C] * x[k] + s[EB] * x[idx(i, je)] + s[WB] * x[idx(i, jw)];
            if i + 1 < NLAT {
                acc += s[NB] * x[idx(i + 1, j)]
                    + s[NE] * x[idx(i + 1, je)]
                    + s[NW] * x[idx(i + 1, jw)];
            }
            if i > 0 {
                acc += s[SB] * x[idx(i - 1, j)]
                    + s[SE] * x[idx(i - 1, je)]
                    + s[SW] * x[idx(i - 1, jw)];
            }
            out[k] = acc;
        }
    }
}

/// Reusable BiCGSTAB workspaces (allocated once — the WASM module must not
/// grow memory after init, so JS TypedArray views stay valid).
pub struct Workspace {
    r: Vec<f64>,
    r0: Vec<f64>,
    p: Vec<f64>,
    v: Vec<f64>,
    s: Vec<f64>,
    t: Vec<f64>,
    binv: Vec<f64>,
}

impl Workspace {
    pub fn new() -> Self {
        Workspace {
            r: vec![0.0; N],
            r0: vec![0.0; N],
            p: vec![0.0; N],
            v: vec![0.0; N],
            s: vec![0.0; N],
            t: vec![0.0; N],
            binv: vec![0.0; N],
        }
    }
}

impl Default for Workspace {
    fn default() -> Self {
        Self::new()
    }
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn norm(a: &[f64]) -> f64 {
    dot(a, a).sqrt()
}

/// Jacobi-preconditioned BiCGSTAB, warm-started from the incoming `x`.
/// Returns (iterations, relative residual). Restarts once on breakdown.
pub fn bicgstab(
    op: &Operator,
    b: &[f64],
    x: &mut [f64],
    tol: f64,
    max_iter: usize,
    ws: &mut Workspace,
) -> (usize, f64) {
    // Jacobi scaling: solve (D⁻¹A)x = D⁻¹b.
    for k in 0..N {
        let d = op.stencil[k][C];
        ws.binv[k] = if d.abs() > 1e-30 { 1.0 / d } else { 1.0 };
    }
    let apply_scaled = |x: &[f64], out: &mut [f64], binv: &[f64]| {
        apply(op, x, out);
        for k in 0..N {
            out[k] *= binv[k];
        }
    };

    let mut bs = vec![0.0; N];
    for k in 0..N {
        bs[k] = b[k] * ws.binv[k];
    }
    let bnorm = norm(&bs);
    if bnorm < 1e-300 {
        x.fill(0.0);
        return (0, 0.0);
    }

    let mut total_it = 0usize;
    for _restart in 0..2 {
        // r = b − A x
        apply_scaled(x, &mut ws.t, &ws.binv);
        for k in 0..N {
            ws.r[k] = bs[k] - ws.t[k];
        }
        let mut res = norm(&ws.r) / bnorm;
        if res < tol {
            return (total_it, res);
        }
        ws.r0.copy_from_slice(&ws.r);
        ws.p.copy_from_slice(&ws.r);
        let mut rho = dot(&ws.r0, &ws.r);
        let mut broke = false;

        while total_it < max_iter {
            total_it += 1;
            apply_scaled(&ws.p, &mut ws.v, &ws.binv);
            let r0v = dot(&ws.r0, &ws.v);
            if r0v.abs() < 1e-300 {
                broke = true;
                break;
            }
            let alpha = rho / r0v;
            for k in 0..N {
                ws.s[k] = ws.r[k] - alpha * ws.v[k];
            }
            if norm(&ws.s) / bnorm < tol {
                for k in 0..N {
                    x[k] += alpha * ws.p[k];
                }
                return (total_it, norm(&ws.s) / bnorm);
            }
            apply_scaled(&ws.s, &mut ws.t, &ws.binv);
            let tt = dot(&ws.t, &ws.t);
            if tt.abs() < 1e-300 {
                broke = true;
                break;
            }
            let omega = dot(&ws.t, &ws.s) / tt;
            for k in 0..N {
                x[k] += alpha * ws.p[k] + omega * ws.s[k];
                ws.r[k] = ws.s[k] - omega * ws.t[k];
            }
            res = norm(&ws.r) / bnorm;
            if res < tol {
                return (total_it, res);
            }
            let rho_new = dot(&ws.r0, &ws.r);
            if rho_new.abs() < 1e-300 || omega.abs() < 1e-300 {
                broke = true;
                break;
            }
            let beta = (rho_new / rho) * (alpha / omega);
            rho = rho_new;
            for k in 0..N {
                ws.p[k] = ws.r[k] + beta * (ws.p[k] - omega * ws.v[k]);
            }
        }
        if !broke {
            break; // hit max_iter
        }
        // Breakdown → restart from current x with a fresh shadow residual.
    }
    apply_scaled(x, &mut ws.t, &ws.binv);
    for k in 0..N {
        ws.r[k] = bs[k] - ws.t[k];
    }
    (total_it, norm(&ws.r) / bnorm)
}
