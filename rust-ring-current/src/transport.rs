//! transport.rs — the bounce-averaged ring-current transport core, ported
//! method-for-method from js/ring-current-transport.js (the reference oracle).
//! Same grid, same drift/diffusion/loss/source split, same adaptive substep,
//! same diagnostics — so the WASM runtime reproduces the JS module.

use crate::physics::*;
use std::f64::consts::PI;

pub const NL: usize = 24;
pub const NMLT: usize = 48;
pub const NE: usize = 6;
pub const NS: usize = 3;
pub const LMIN: f64 = 2.0;
pub const LMAX: f64 = 7.0;

const ENERGIES: [f64; NE] = [10.0, 20.5, 42.0, 86.0, 176.0, 300.0];
const DT_SUB_S: f64 = 30.0;
const DLL_PER_DAY0: f64 = 0.4;
const DLL_POW: i32 = 3;
const SOURCE_NORM: f64 = 6.36e25;
const E0_KEV: f64 = 12.0;
const HELIUM_FRACTION: f64 = 0.04;
const PRESS_CAL: f64 = 0.04;

/// Charge-exchange key per species index (H⁺, O⁺, He⁺). He⁺ uses the proton
/// cross-section (approx) and an extra ×0.7 lifetime factor, as in the JS.
const SPECIES_CX: [Cx; NS] = [Cx::Ion, Cx::Oxygen, Cx::Ion];
const HELIUM_IDX: usize = 2;

#[inline]
fn gidx(i: usize, j: usize) -> usize {
    i * NMLT + j
}
#[inline]
fn cbase(s: usize, k: usize) -> usize {
    (s * NE + k) * NL * NMLT
}

/// Guiding-centre drift at (L, az) for a proton of energy `e_kev` — the exact
/// `driftAt` port. Returns (dL/dt [R_E/s], dAz/dt [rad/s]).
fn drift_at(l: f64, az: f64, e_kev: f64, conv_a: f64) -> (f64, f64) {
    let d_phi_dl = COROT_C / (l * l) + 2.0 * conv_a * l * az.sin();
    let d_phi_daz = conv_a * l * l * az.cos();
    let denom = B0_RE2 / (l * l);
    let dldt = -d_phi_daz / denom;
    let exb_az = d_phi_dl / denom;
    let th = drift_period_hours(e_kev, l);
    let gc_az = if th.is_finite() && th != 0.0 {
        -2.0 * PI / (th * 3600.0)
    } else {
        0.0
    };
    (dldt, exb_az + gc_az)
}

pub struct Sim {
    pub content: Vec<f64>, // NS*NE*NL*NMLT
    l: [f64; NL],
    az: [f64; NMLT],
    mlt: [f64; NMLT],
    ekev: [f64; NE],
    spec: [f64; NE],
    dl: f64,
    daz: f64,
    kp: f64,
    vbs: f64,
    pub t_sec: f64,
    dps: f64,
    vlf: Vec<f64>, // NE*(NL+1)*NMLT — radial face velocities
    vaf: Vec<f64>, // NE*NL*NMLT     — azimuthal face velocities
    max_vl: f64,
    max_va: f64,
    pub out_map: Vec<f32>, // NL*NMLT — the C-ABI output buffer
}

impl Default for Sim {
    fn default() -> Self {
        Self::new()
    }
}

impl Sim {
    pub fn new() -> Self {
        let dl = (LMAX - LMIN) / NL as f64;
        let daz = 2.0 * PI / NMLT as f64;
        let mut l = [0.0; NL];
        for (i, li) in l.iter_mut().enumerate() {
            *li = LMIN + (i as f64 + 0.5) * dl;
        }
        let mut az = [0.0; NMLT];
        let mut mlt = [0.0; NMLT];
        for j in 0..NMLT {
            mlt[j] = (j as f64 + 0.5) * 24.0 / NMLT as f64;
            az[j] = 2.0 * PI * mlt[j] / 24.0;
        }
        let ekev = ENERGIES;
        // Normalised injection spectrum (κ-like: E·exp(−E/E0)).
        let mut spec = [0.0; NE];
        let mut ssum = 0.0;
        for k in 0..NE {
            spec[k] = ekev[k] * (-ekev[k] / E0_KEV).exp();
            ssum += spec[k];
        }
        if ssum != 0.0 {
            for s in spec.iter_mut() {
                *s /= ssum;
            }
        }
        Sim {
            content: vec![0.0; NS * NE * NL * NMLT],
            l,
            az,
            mlt,
            ekev,
            spec,
            dl,
            daz,
            kp: 1.0,
            vbs: 0.0,
            t_sec: 0.0,
            dps: dps_j_per_nt(),
            vlf: vec![0.0; NE * (NL + 1) * NMLT],
            vaf: vec![0.0; NE * NL * NMLT],
            max_vl: 0.0,
            max_va: 0.0,
            out_map: vec![0.0; NL * NMLT],
        }
    }

    pub fn reset(&mut self) {
        self.content.iter_mut().for_each(|c| *c = 0.0);
        self.t_sec = 0.0;
    }

    pub fn set_driver(&mut self, kp: f64, vbs: f64) {
        if kp.is_finite() {
            self.kp = kp.clamp(0.0, 9.0);
        }
        if vbs.is_finite() {
            self.vbs = vbs.max(0.0);
        }
    }

    pub fn step(&mut self, dt_seconds: f64) {
        let mut remaining = dt_seconds.max(0.0);
        if remaining <= 0.0 {
            return;
        }
        self.compute_drift();
        // Adaptive substep: advective Courant ≤ 0.8 (upwind is stable to 1).
        let cfl = 0.8
            * f64::min(
                if self.max_vl > 0.0 {
                    self.dl / self.max_vl
                } else {
                    f64::INFINITY
                },
                if self.max_va > 0.0 {
                    self.daz / self.max_va
                } else {
                    f64::INFINITY
                },
            );
        let sub = DT_SUB_S.min(cfl);
        while remaining > 1e-9 {
            let dt = sub.min(remaining);
            self.advect(dt);
            self.diffuse(dt);
            self.loss(dt);
            self.source(dt);
            self.t_sec += dt;
            remaining -= dt;
        }
    }

    fn compute_drift(&mut self) {
        let conv_a = convection_amplitude(self.kp);
        let mut vlf = std::mem::take(&mut self.vlf);
        let mut vaf = std::mem::take(&mut self.vaf);
        let mut max_vl = 0.0f64;
        let mut max_va = 0.0f64;
        for k in 0..NE {
            let e = self.ekev[k];
            let vlbase = k * (NL + 1) * NMLT;
            let vabase = k * NL * NMLT;
            for f in 0..=NL {
                let lf = LMIN + f as f64 * self.dl;
                for j in 0..NMLT {
                    let (dldt, _) = drift_at(lf, self.az[j], e, conv_a);
                    vlf[vlbase + f * NMLT + j] = dldt;
                    if dldt.abs() > max_vl {
                        max_vl = dldt.abs();
                    }
                }
            }
            for i in 0..NL {
                let l = self.l[i];
                for j in 0..NMLT {
                    let (_, dazdt) = drift_at(l, j as f64 * self.daz, e, conv_a);
                    vaf[vabase + i * NMLT + j] = dazdt;
                    if dazdt.abs() > max_va {
                        max_va = dazdt.abs();
                    }
                }
            }
        }
        self.vlf = vlf;
        self.vaf = vaf;
        self.max_vl = max_vl;
        self.max_va = max_va;
    }

    fn advect(&mut self, dt: f64) {
        let vlf = std::mem::take(&mut self.vlf);
        let vaf = std::mem::take(&mut self.vaf);
        let mut out = vec![0.0f64; NL * NMLT];
        for k in 0..NE {
            let vlbase = k * (NL + 1) * NMLT;
            let vabase = k * NL * NMLT;
            for s in 0..NS {
                let base = cbase(s, k);
                let c = &mut self.content[base..base + NL * NMLT];
                out.iter_mut().for_each(|o| *o = 0.0);
                // Radial faces f=0..NL per MLT column.
                for j in 0..NMLT {
                    for f in 0..=NL {
                        let v = vlf[vlbase + f * NMLT + j];
                        if v == 0.0 {
                            continue;
                        }
                        let cf = v * dt / self.dl;
                        let donor = if v > 0.0 { f as isize - 1 } else { f as isize };
                        if donor < 0 || donor >= NL as isize {
                            continue;
                        }
                        let flux = cf * c[gidx(donor as usize, j)];
                        if f >= 1 {
                            out[gidx(f - 1, j)] -= flux;
                        }
                        if f < NL {
                            out[gidx(f, j)] += flux;
                        }
                    }
                }
                // Azimuthal faces j (between cells j−1 and j), periodic.
                for i in 0..NL {
                    for j in 0..NMLT {
                        let v = vaf[vabase + i * NMLT + j];
                        if v == 0.0 {
                            continue;
                        }
                        let ca = v * dt / self.daz;
                        let jm = (j + NMLT - 1) % NMLT;
                        let donor = if v > 0.0 { jm } else { j };
                        let flux = ca * c[gidx(i, donor)];
                        out[gidx(i, jm)] -= flux;
                        out[gidx(i, j)] += flux;
                    }
                }
                for n in 0..NL * NMLT {
                    c[n] += out[n];
                    if c[n] < 0.0 {
                        c[n] = 0.0;
                    }
                }
            }
        }
        self.vlf = vlf;
        self.vaf = vaf;
    }

    fn diffuse(&mut self, dt: f64) {
        let d0 = DLL_PER_DAY0 / 86400.0;
        let mut col = [0.0f64; NL];
        let mut flux = [0.0f64; NL + 1];
        for s in 0..NS {
            for k in 0..NE {
                let base = cbase(s, k);
                let c = &mut self.content[base..base + NL * NMLT];
                for j in 0..NMLT {
                    for i in 0..NL {
                        col[i] = c[gidx(i, j)];
                    }
                    flux[0] = 0.0;
                    flux[NL] = 0.0;
                    for f in 1..NL {
                        let lf = LMIN + f as f64 * self.dl;
                        let d = d0 * (lf / 6.6).powi(DLL_POW);
                        flux[f] = d * (col[f] - col[f - 1]) / self.dl;
                    }
                    for i in 0..NL {
                        let mut v = col[i] + dt * (flux[i + 1] - flux[i]) / self.dl;
                        if v < 0.0 {
                            v = 0.0;
                        }
                        c[gidx(i, j)] = v;
                    }
                }
            }
        }
    }

    fn loss(&mut self, dt: f64) {
        let ppl = plasmapause_l(self.kp);
        for s in 0..NS {
            let cx = SPECIES_CX[s];
            for k in 0..NE {
                let e = self.ekev[k];
                let base = cbase(s, k);
                for i in 0..NL {
                    let l = self.l[i];
                    let mut tau_h = cx_lifetime_hours(e, l, cx);
                    if s == HELIUM_IDX && tau_h.is_finite() {
                        tau_h *= 0.7;
                    }
                    if !tau_h.is_finite() || tau_h <= 0.0 {
                        continue;
                    }
                    let inv_tau =
                        1.0 / (tau_h * 3600.0) + if l < ppl { 1.0 / (72.0 * 3600.0) } else { 0.0 };
                    let decay = (-inv_tau * dt).exp();
                    for j in 0..NMLT {
                        self.content[base + gidx(i, j)] *= decay;
                    }
                }
            }
        }
    }

    fn source(&mut self, dt: f64) {
        let conv_a = convection_amplitude(self.kp);
        let drive = conv_a / convection_amplitude(6.0);
        let vbs_boost = 1.0 + 0.15 * self.vbs;
        let rate = SOURCE_NORM * drive * vbs_boost * dt;
        if rate <= 0.0 {
            return;
        }
        let f_o = oxygen_fraction(self.dst_star());
        let f_he = HELIUM_FRACTION;
        let f_h = (1.0 - f_o - f_he).max(0.0);
        let comp = [f_h, f_o, f_he]; // H, O, He
        let mut w = [0.0f64; NMLT];
        let mut wsum = 0.0;
        for j in 0..NMLT {
            w[j] = self.az[j].cos().max(0.0);
            wsum += w[j];
        }
        let wsum = if wsum != 0.0 { wsum } else { 1.0 };
        let i_out = NL - 1;
        for s in 0..NS {
            let fs = comp[s];
            if fs <= 0.0 {
                continue;
            }
            for k in 0..NE {
                let add = rate * fs * self.spec[k];
                let base = cbase(s, k);
                for j in 0..NMLT {
                    self.content[base + gidx(i_out, j)] += add * (w[j] / wsum);
                }
            }
        }
    }

    // ── Diagnostics ──────────────────────────────────────────────────────────

    pub fn energy_content_j(&self) -> f64 {
        let mut w = 0.0;
        for s in 0..NS {
            for k in 0..NE {
                let ej = self.ekev[k] * KEV_J;
                let base = cbase(s, k);
                let mut sum = 0.0;
                for n in 0..NL * NMLT {
                    sum += self.content[base + n];
                }
                w += sum * ej;
            }
        }
        w
    }

    pub fn dst_star(&self) -> f64 {
        -self.energy_content_j() / self.dps
    }

    pub fn oxygen_fraction_val(&self) -> f64 {
        let mut per = [0.0f64; NS];
        let mut total = 0.0;
        for s in 0..NS {
            let mut ws = 0.0;
            for k in 0..NE {
                let ej = self.ekev[k] * KEV_J;
                let base = cbase(s, k);
                let mut sum = 0.0;
                for n in 0..NL * NMLT {
                    sum += self.content[base + n];
                }
                ws += sum * ej;
            }
            per[s] = ws;
            total += ws;
        }
        if total > 0.0 {
            per[1] / total
        } else {
            0.0
        }
    }

    #[inline]
    fn include(sel: u32, s: usize) -> bool {
        sel == 0 || sel as usize == s + 1
    }

    /// Fill out_map (f32) with Σ_E content (·E if `want_e`) for the selection.
    pub fn fill_equatorial(&mut self, sel: u32, want_e: bool) {
        let mut acc = [0.0f64; NL * NMLT];
        for s in 0..NS {
            if !Self::include(sel, s) {
                continue;
            }
            for k in 0..NE {
                let wk = if want_e { self.ekev[k] } else { 1.0 };
                let base = cbase(s, k);
                for n in 0..NL * NMLT {
                    acc[n] += self.content[base + n] * wk;
                }
            }
        }
        for n in 0..NL * NMLT {
            self.out_map[n] = acc[n] as f32;
        }
    }

    /// Fill out_map (f32) with the perpendicular pressure (nPa) for the selection.
    pub fn fill_pressure(&mut self, sel: u32) {
        let mut edens = [0.0f64; NL * NMLT];
        for s in 0..NS {
            if !Self::include(sel, s) {
                continue;
            }
            for k in 0..NE {
                let wk = self.ekev[k];
                let base = cbase(s, k);
                for n in 0..NL * NMLT {
                    edens[n] += self.content[base + n] * wk;
                }
            }
        }
        for i in 0..NL {
            let v_cell = self.l[i] * self.daz * self.dl * R_E * R_E * R_E;
            let k_npa = KEV_J / v_cell * 1e9 * PRESS_CAL;
            for j in 0..NMLT {
                let n = gidx(i, j);
                self.out_map[n] = (edens[n] * k_npa) as f32;
            }
        }
    }

    /// Fill out_map (f32) with the ENA emissivity source Σ content·σ_cx.
    pub fn fill_ena(&mut self) {
        let mut acc = [0.0f64; NL * NMLT];
        for s in 0..NS {
            let cx = SPECIES_CX[s];
            for k in 0..NE {
                let sig = cx_cross_section(self.ekev[k], cx);
                if !(sig > 0.0) {
                    continue;
                }
                let base = cbase(s, k);
                for n in 0..NL * NMLT {
                    acc[n] += self.content[base + n] * sig;
                }
            }
        }
        for n in 0..NL * NMLT {
            self.out_map[n] = acc[n] as f32;
        }
    }

    /// Partial-ring asymmetry: (peak_L, index, peak_MLT) of the total content.
    pub fn asym(&self) -> (f64, f64, f64) {
        let mut best_i = 0usize;
        let mut best_row = -1.0f64;
        let row_of = |i: usize| -> f64 {
            let mut row = 0.0;
            for s in 0..NS {
                for k in 0..NE {
                    let base = cbase(s, k);
                    for j in 0..NMLT {
                        row += self.content[base + gidx(i, j)];
                    }
                }
            }
            row
        };
        for i in 0..NL {
            let r = row_of(i);
            if r > best_row {
                best_row = r;
                best_i = i;
            }
        }
        let mut mx = f64::NEG_INFINITY;
        let mut mn = f64::INFINITY;
        let mut mx_j = 0usize;
        for j in 0..NMLT {
            let mut v = 0.0;
            for s in 0..NS {
                for k in 0..NE {
                    v += self.content[cbase(s, k) + gidx(best_i, j)];
                }
            }
            if v > mx {
                mx = v;
                mx_j = j;
            }
            if v < mn {
                mn = v;
            }
        }
        let denom = mx + mn;
        let index = if denom > 0.0 { (mx - mn) / denom } else { 0.0 };
        (self.l[best_i], index, self.mlt[mx_j])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drift_signs() {
        // Corotation only (convA=0, negligible-energy grad-curv): +Ω eastward.
        let (dldt, dazdt) = drift_at(4.0, 1.0, 1e-3, 0.0);
        assert!((dazdt - OMEGA_E).abs() < 1e-3 * OMEGA_E);
        assert!(dldt.abs() < 1e-15);
        // Energetic ion drifts net westward.
        assert!(drift_at(4.0, 0.0, 100.0, 0.0).1 < 0.0);
        // Convection is inward on the nightside, outward at noon.
        let a6 = convection_amplitude(6.0);
        assert!(drift_at(4.0, 0.0, 100.0, a6).0 < 0.0);
        assert!(drift_at(4.0, PI, 100.0, a6).0 > 0.0);
    }

    #[test]
    fn diffusion_conserves() {
        let mut s = Sim::new();
        for j in 0..NMLT {
            s.content[cbase(0, 0) + gidx(12, j)] = 1.0;
        }
        let before: f64 = (0..NL * NMLT).map(|n| s.content[cbase(0, 0) + n]).sum();
        for _ in 0..200 {
            s.diffuse(300.0);
        }
        let after: f64 = (0..NL * NMLT).map(|n| s.content[cbase(0, 0) + n]).sum();
        assert!((after - before).abs() / before < 1e-9, "{before} vs {after}");
        assert!(s.content[cbase(0, 0) + gidx(14, 0)] > 0.0, "spread outward");
    }

    #[test]
    fn storm_response() {
        let mut s = Sim::new();
        s.set_driver(7.0, 8.0);
        for _ in 0..12 {
            s.step(3600.0);
        }
        let dst = s.dst_star();
        assert!(dst < -40.0 && dst > -400.0, "main-phase Dst* {dst}");
        assert!(s.oxygen_fraction_val() > 0.06, "O+ enhanced");
        let (peak_l, index, peak_mlt) = s.asym();
        assert!(peak_l > 3.0 && peak_l < 5.5, "peak L {peak_l}");
        assert!(index > 0.3, "partial ring {index}");
        assert!(peak_mlt >= 15.0 || peak_mlt <= 4.0, "dusk-midnight {peak_mlt}");
        s.fill_pressure(0);
        let pk = s.out_map.iter().cloned().fold(0.0f32, f32::max);
        assert!(pk > 1.0 && pk < 80.0, "peak P⊥ {pk} nPa");
        // Recovery.
        s.set_driver(1.0, 0.0);
        for _ in 0..24 {
            s.step(3600.0);
        }
        assert!(s.dst_star() > dst, "recovers");
    }

    #[test]
    fn deterministic() {
        let run = || {
            let mut s = Sim::new();
            s.set_driver(6.0, 5.0);
            for _ in 0..6 {
                s.step(3600.0);
            }
            s.dst_star()
        };
        assert_eq!(run(), run());
    }
}
