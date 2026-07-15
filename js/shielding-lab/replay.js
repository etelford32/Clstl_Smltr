/**
 * replay.js — hindcast replay sources for the Shielding Lab (plan Phase 5).
 *
 * Consumes `pp.hindcast.replay.v1` bundles through the house replay engine
 * (js/hindcast-replay-engine.js — event-agnostic, per CLAUDE.md the Gannon
 * modules are never forked). A replay drives the solver's controls with
 * REAL storm data and exposes the observed/reference series for the
 * validation panel:
 *
 *   St. Patrick's 2015 — committed bundle. 5-min OMNI HRO drivers
 *   (Bz, v, n) + observed SYM-H/AE + the BATS-R-US + Ridley (SWMF IE)
 *   Φ_PC hindcast — the head-to-head reference for OUR solver's CPCP,
 *   since both solve the same ionospheric equation.
 *
 *   Gannon 2024 — appears automatically once someone runs
 *   scripts/build-shielding-gannon-replay.mjs on a networked machine
 *   and commits the bundle (SPDF is not reachable from every sandbox).
 *
 * Gap policy: the bundle is the honesty boundary — series may be null.
 * The VALIDATION series render gaps. The DRIVER series hold the last
 * valid sample (the solver cannot ingest null); holds are counted and
 * surfaced so the honesty is visible, not silent.
 */

import { loadReplay } from '../hindcast-replay-engine.js';

export const REPLAY_SOURCES = [
    {
        id: 'stpatrick2015',
        label: "St. Patrick's 2015",
        sub: 'G4 · OMNI drivers · vs SWMF-IE',
        url: '/data/hindcast/st_patrick_mar_2015_replay.json',
        f107: 113, // GFZ definitive, 2015-03-17
    },
    {
        id: 'gannon2024',
        label: 'Gannon 2024',
        sub: 'G5 · OMNI drivers',
        url: '/data/hindcast/gannon_shielding_replay.json',
        f107: 230, // ~GFZ definitive, 2024-05-10/11
    },
];

/** Load one source; throws if the bundle is missing or malformed. */
export async function loadReplaySource(src) {
    const bundle = await loadReplay({ url: src.url });
    const w = bundle.window;
    const stepMin = w.step_minutes || 5;
    const stepS = stepMin * 60;
    const s = bundle.series || {};
    const n = (s.bz_nt || []).length;
    if (!n || !s.v_kms) {
        throw new Error(`replay ${src.id}: bundle lacks driver series (bz_nt, v_kms)`);
    }

    const t0Ms = Date.parse(w.start);
    const durationS = (n - 1) * stepS;

    // Driver hold state (per-series last valid + hold counter).
    const holds = { bz: 0, v: 0, n: 0, by: 0 };
    const mkDriver = (arr, key, fallback) => {
        let last = fallback;
        // Pre-scan so random access (seek) still holds sensibly: build a
        // fully-held copy once. Bundles are ≤ ~1000 samples — cheap.
        const held = new Array(n);
        for (let i = 0; i < n; i++) {
            const v = arr ? arr[i] : null;
            if (v == null || !Number.isFinite(v)) {
                holds[key]++;
            } else {
                last = v;
            }
            held[i] = last;
        }
        return held;
    };

    const bz = mkDriver(s.bz_nt, 'bz', 0);
    const v = mkDriver(s.v_kms, 'v', 400);
    const dens = mkDriver(s.n_cc, 'n', 5);
    const by = s.by_nt ? mkDriver(s.by_nt, 'by', 0) : null;

    const idxAt = (tS) => Math.max(0, Math.min(n - 1, Math.round(tS / stepS)));

    return {
        id: src.id,
        label: src.label,
        f107: src.f107,
        stepMin,
        durationS,
        window: w,
        headline: bundle.headline || null,
        phases: bundle.phases || [],
        provenance: bundle.provenance || {},
        driverHolds: holds,

        /** Solver controls at an offset (s) from window start. */
        controlsAt(tS) {
            const i = idxAt(tS);
            return {
                bz: bz[i],
                by: by ? by[i] : 0,
                vsw: v[i],
                n: dens[i],
                f107: src.f107,
            };
        },

        /** Observed / reference values (nullable — render gaps). */
        truthAt(tS) {
            const i = idxAt(tS);
            const pick = (arr) => {
                const val = arr ? arr[i] : null;
                return val == null || !Number.isFinite(val) ? null : val;
            };
            return {
                symH: pick(s.sym_h_nt),
                ae: pick(s.ae_nt),
                phiPcRidley: pick(s.phi_pc_kv),
            };
        },

        /** UTC ISO string at an offset from window start. */
        utcAt(tS) {
            return new Date(t0Ms + tS * 1000).toISOString().slice(0, 16) + 'Z';
        },

        /** Storm phase label at an offset. */
        phaseAt(tS) {
            const h = tS / 3600;
            for (const p of bundle.phases || []) {
                if (p.until_h == null || h < p.until_h) return p.label || p.id;
            }
            return '';
        },
    };
}

/** Pearson correlation of paired samples (nulls skipped). */
export function pearson(xs, ys) {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, m = 0;
    for (let i = 0; i < xs.length; i++) {
        const x = xs[i], y = ys[i];
        if (x == null || y == null) continue;
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; m++;
    }
    if (m < 8) return null;
    const cov = sxy - (sx * sy) / m;
    const vx = sxx - (sx * sx) / m;
    const vy = syy - (sy * sy) / m;
    if (vx <= 0 || vy <= 0) return null;
    return cov / Math.sqrt(vx * vy);
}
