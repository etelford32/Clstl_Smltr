/**
 * gannon-dst-compare.js — the Gannon THREE-WAY Dst validation
 * (flux-rope Phase 4 close-out: "observed vs rope ensemble vs BATS-R-US
 * through the same Dst pipeline").
 *
 * ONE pipeline — `integrateDst` from js/ring-current-model.js, the same
 * integrator the live Ring Current page and the Phase 4 forecast panel
 * use — fed by three driver sources over the identical May 2024 window:
 *
 *   TRUTH     observed SYM-H (≈ Dst) from OMNI — what Earth actually did.
 *   CEILING   observed L1 drivers (the baked replay bundle) → integrateDst
 *             — the best this empirical pipeline can do given PERFECT
 *             knowledge of the solar wind. Its miss vs SYM-H is pipeline
 *             error, not driver error.
 *   ROPE      the validated v1.4 flux-rope train (standoffRopes +
 *             CME–CME interaction) → the SAME integrateDst — what the
 *             engine produces from LAUNCH-TIME knowledge. Its additional
 *             miss vs the ceiling is driver error. HONESTY: the Gannon
 *             fit was tuned against this event's L1 Bz (spec §8 framing) —
 *             this is REPRODUCTION skill; blind-forecast skill is the
 *             live DONKI pipeline's job.
 *   BATS-R-US the GM/IE Dst diagnostic slot. The Gannon MHD run in this
 *             repo produced pseudo-Ap (the density story above on the
 *             page); its Dst output is PENDING the workstation GM/IE
 *             re-run (swmf/fixtures README pattern). The chart wires the
 *             standard bundle path and lights the trace up the moment
 *             `data/hindcast/gannon_may_2024_hindcast.gm_ie.json` carries
 *             a `dst_nt` per-sample field — no code change needed then.
 *
 * Ensemble honesty: the violet band integrates the ensemble's p5/p95 Bz
 * TRACKS through the pipeline (labeled as such) — percentile-of-Bz driven,
 * not percentile-of-member-Dst.
 *
 * Pure compute (`computeGannonDstComparison`, node-tested by
 * tests/gannon-dst-compare.mjs against the committed WASM) is separated
 * from the fail-quiet page mount (`mountGannonDstCompare`) — the page
 * must never break if any leg is unavailable.
 */

import { integrateDst, skill } from './ring-current-model.js';
import { loadFluxRopeKernel, L1_OBSERVER } from './flux-rope-kernel.js';
import { GANNON_FIT } from './flux-rope-presets.js';

const AU_KM = 1.495978707e8;
const AMBIENT_V = 450;   // the fit's ambient wind [km/s]
const AMBIENT_N = 5;     // climatological density fill [cm⁻³]

/** Min + its time from a Dst track [{t, dst}]. */
export function trackMin(track) {
    let min = Infinity, tMin = null;
    for (const p of track) if (p.dst < min) { min = p.dst; tMin = p.t; }
    return Number.isFinite(min) ? { min, tMin } : { min: null, tMin: null };
}

/**
 * Rope-kinematic V attribution: the speed of the rope whose apex is
 * nearest 1 AU (launch-time knowledge only — never the observed V).
 */
function ropeVAt(kernel, nRopes, tS) {
    let best = AMBIENT_V, bestD = Infinity;
    for (let r = 0; r < nRopes; r++) {
        const d = Math.abs(kernel.apexKmAt(r, tS) - AU_KM);
        if (d < bestD) { bestD = d; best = Math.max(AMBIENT_V, kernel.apexVKmsAt(r, tS)); }
    }
    return best;
}

/**
 * The pure three-way compute. `bundle` is the baked L1 replay
 * (pp.hindcast.replay.v1, 5-min bins); `symH` optional [{t, dst}] truth;
 * `dst0` the integration start level (default 0 — the window opens in
 * quiet conditions; a ±15 nT start error is ~3% of this storm's depth).
 */
export function computeGannonDstComparison({ kernel, bundle, symH = null, dst0 = 0, members = 500, seed = 2024 }) {
    const stepS = bundle.window.step_minutes * 60;
    const startMs = Date.parse(bundle.window.start);
    const launchMs = Date.parse(GANNON_FIT.launchIso);
    const n = bundle.series.bz_nt.length;
    const t0S = (startMs - launchMs) / 1000;
    const tAt = (i) => startMs + i * stepS * 1000;

    // ── CEILING: observed L1 drivers through the pipeline ────────────────
    const obsSamples = [];
    for (let i = 0; i < n; i++) {
        obsSamples.push({
            t: tAt(i),
            bz: bundle.series.bz_nt[i] ?? NaN,
            v: bundle.series.v_kms[i] ?? NaN,
            n: bundle.series.n_cc[i] ?? NaN,
        });
    }
    const ceiling = integrateDst(obsSamples, dst0);

    // ── ROPE: the v1.4 interacting train through the SAME pipeline ──────
    kernel.setRopes(GANNON_FIT.standoffRopes);
    kernel.setInteraction({ enabled: true, ...GANNON_FIT.interaction });
    const det = kernel.series(t0S, stepS, n, L1_OBSERVER);
    kernel.setSpreads({});
    const ens = kernel.ensembleRun(seed, members, t0S, stepS, n, L1_OBSERVER);
    const nRopes = kernel.ropeCount();
    const ropeSamples = (bzArr) => {
        const out = [];
        for (let i = 0; i < n; i++) {
            const tS = t0S + i * stepS;
            out.push({
                t: tAt(i),
                bz: bzArr[i],
                v: det.inside[i] > 0 ? ropeVAt(kernel, nRopes, tS) : AMBIENT_V,
                n: AMBIENT_N,
            });
        }
        return out;
    };
    const rope = integrateDst(ropeSamples(det.bz), dst0);
    const ropeP50 = integrateDst(ropeSamples(ens.bzPct.p50), dst0);
    const ropeP5 = integrateDst(ropeSamples(ens.bzPct.p5), dst0);
    const ropeP95 = integrateDst(ropeSamples(ens.bzPct.p95), dst0);

    // ── Skill vs truth (when SYM-H is available) ─────────────────────────
    const skillOf = (track) => {
        const base = symH?.length ? skill(track, symH) : { rmse: null, bias: null, n: 0 };
        const m = trackMin(track);
        const tm = symH?.length ? trackMin(symH.map((p) => ({ t: p.t, dst: p.dst }))) : { min: null, tMin: null };
        return {
            ...base,
            minDst: m.min,
            minTimeMs: m.tMin,
            dtMinH: m.tMin != null && tm.tMin != null ? (m.tMin - tm.tMin) / 3.6e6 : null,
        };
    };

    return {
        startMs, stepS, n, launchMs,
        tracks: {
            ceiling, rope, ropeP50, ropeP5, ropeP95,
            symH: symH ?? null,
        },
        skill: {
            ceiling: skillOf(ceiling),
            rope: skillOf(rope),
            ropeP50: skillOf(ropeP50),
        },
        truthMin: symH?.length ? trackMin(symH) : { min: null, tMin: null },
    };
}

// ── Page mount (fail-quiet) ──────────────────────────────────────────────────

const CSS = `
.gdc-chart { width:100%; height:260px; display:block; background:rgba(3,2,16,.5);
    border:1px solid rgba(120,110,200,.18); border-radius:8px; }
.gdc-table { width:100%; border-collapse:collapse; font-size:.72rem; margin-top:8px; }
.gdc-table th, .gdc-table td { text-align:right; padding:3px 8px; color:#c6c0e6;
    border-bottom:1px solid rgba(120,110,200,.14); }
.gdc-table th { color:#8a84ad; font-weight:600; text-transform:uppercase; font-size:.62rem; letter-spacing:.05em; }
.gdc-table td:first-child, .gdc-table th:first-child { text-align:left; }
.gdc-note { font-size:.7rem; color:#8ab; margin-top:7px; line-height:1.5; }
.gdc-legend { display:flex; gap:14px; flex-wrap:wrap; font-size:.68rem; color:#a9a3c8; margin-top:7px; }
.gdc-swatch { display:inline-block; width:14px; height:3px; border-radius:2px; vertical-align:middle; margin-right:5px; }
`;

const COL = {
    truth: '#ffc861',
    ceiling: '#e8ecf8',
    rope: '#c792ea',
    band: 'rgba(199,146,234,.18)',
    mhd: '#7fe6c3',
};

function drawChart(canvas, cmp, mhdTrack) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const padL = 44, padR = 8, padT = 8, padB = 20;
    const t0 = cmp.startMs, t1 = cmp.startMs + cmp.n * cmp.stepS * 1000;
    let lo = 40, hi = -520;   // sane bounds for a G5; expanded by data below
    const all = [cmp.tracks.ceiling, cmp.tracks.rope, cmp.tracks.ropeP5, cmp.tracks.ropeP95,
        cmp.tracks.symH ?? [], mhdTrack ?? []];
    for (const tr of all) for (const p of tr) {
        if (Number.isFinite(p.dst)) { if (p.dst < hi) hi = p.dst; if (p.dst > lo) lo = p.dst; }
    }
    hi -= 20;
    const x = (t) => padL + (t - t0) / (t1 - t0) * (W - padL - padR);
    const y = (v) => padT + (lo - v) / (lo - hi) * (H - padT - padB);

    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#6a6490'; ctx.strokeStyle = 'rgba(120,110,200,.15)';
    for (const g of [0, -100, -200, -300, -400, -500]) {
        if (g > lo || g < hi) continue;
        ctx.beginPath(); ctx.moveTo(padL, y(g)); ctx.lineTo(W - padR, y(g)); ctx.stroke();
        ctx.fillText(String(g), 4, y(g) + 3);
    }
    for (let d = 0; ; d++) {
        const t = Date.UTC(2024, 4, 11 + d);
        if (t > t1) break;
        if (t < t0) continue;
        ctx.beginPath(); ctx.moveTo(x(t), padT); ctx.lineTo(x(t), H - padB); ctx.stroke();
        ctx.fillText(`May ${11 + d}`, x(t) + 3, H - 7);
    }

    const line = (track, color, width = 1.6, dash = null) => {
        if (!track?.length) return;
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = width;
        if (dash) ctx.setLineDash(dash);
        ctx.beginPath();
        let pen = false;
        for (const p of track) {
            if (!Number.isFinite(p.dst)) { pen = false; continue; }
            const px = x(p.t), py = y(p.dst);
            if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
    };

    // Ensemble band (p5–p95 Bz tracks through the pipeline).
    const p5 = cmp.tracks.ropeP5, p95 = cmp.tracks.ropeP95;
    if (p5?.length && p95?.length) {
        ctx.save();
        ctx.fillStyle = COL.band;
        ctx.beginPath();
        for (let i = 0; i < p5.length; i++) ctx.lineTo(x(p5[i].t), y(p5[i].dst));
        for (let i = p95.length - 1; i >= 0; i--) ctx.lineTo(x(p95[i].t), y(p95[i].dst));
        ctx.closePath(); ctx.fill();
        ctx.restore();
    }
    line(cmp.tracks.ceiling, COL.ceiling, 1.4, [5, 4]);
    line(cmp.tracks.rope, COL.rope, 1.8);
    line(mhdTrack, COL.mhd, 1.6, [2, 3]);
    line(cmp.tracks.symH, COL.truth, 2.0);
}

/**
 * The BATS-R-US Dst slot: lights up when the GM/IE bundle gains a per-
 * sample `dst_nt` (or `sym_h_nt`) field. Returns [{t, dst}] or null.
 */
export function mhdDstFromBundle(gmIe) {
    const rows = gmIe?.samples;
    if (!Array.isArray(rows)) return null;
    const out = [];
    for (const r of rows) {
        const v = r.dst_nt ?? r.sym_h_nt;
        const t = Date.parse(r.t);
        if (Number.isFinite(v) && Number.isFinite(t)) out.push({ t, dst: v });
    }
    return out.length ? out : null;
}

export async function mountGannonDstCompare(hostId) {
    const host = document.getElementById(hostId);
    if (!host) return;
    try {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        const bundle = await (await fetch('data/hindcast/gannon_may_2024_l1_replay.json')).json();
        const kernel = await loadFluxRopeKernel('./js/flux-rope-wasm/flux_rope_core.wasm');

        // Truth: OMNI SYM-H via the page's own edge proxy (best-effort).
        let symH = null, dst0 = 0;
        try {
            const j = await (await fetch(
                '/api/omni/imf?start=2024-05-10&end=2024-05-13&step_min=30&fields=t,sym_h',
            )).json();
            const t = j?.data?.t, s = j?.data?.sym_h;
            if (Array.isArray(t) && Array.isArray(s)) {
                symH = t.map((ti, i) => ({ t: Date.parse(ti), dst: s[i] }))
                    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.dst));
                const startMs = Date.parse(bundle.window.start);
                const first = symH.find((p) => p.t >= startMs);
                if (first) dst0 = first.dst;
                if (!symH.length) symH = null;
            }
        } catch { /* truth trace hides; the pipeline legs still render */ }

        const cmp = computeGannonDstComparison({ kernel, bundle, symH, dst0 });

        // The BATS-R-US slot (pending bundle — see module header).
        let mhdTrack = null;
        try {
            const gmIe = await (await fetch('data/hindcast/gannon_may_2024_hindcast.gm_ie.json')).json();
            mhdTrack = mhdDstFromBundle(gmIe);
        } catch { /* pending — the note below says so */ }

        const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
        const row = (label, s) => `<tr><td>${label}</td>
            <td>${fmt(s.minDst)} nT</td>
            <td>${s.dtMinH != null ? (s.dtMinH >= 0 ? '+' : '') + s.dtMinH.toFixed(1) + ' h' : '—'}</td>
            <td>${fmt(s.rmse, 1)}</td><td>${fmt(s.bias, 1)}</td></tr>`;

        host.innerHTML = `
            <canvas class="gdc-chart" id="${hostId}-canvas"></canvas>
            <div class="gdc-legend">
                <span><span class="gdc-swatch" style="background:${COL.truth}"></span>observed SYM-H (truth)</span>
                <span><span class="gdc-swatch" style="background:${COL.ceiling}"></span>Dst | observed L1 drivers (pipeline ceiling)</span>
                <span><span class="gdc-swatch" style="background:${COL.rope}"></span>Dst | flux-rope train (launch-time knowledge)</span>
                <span><span class="gdc-swatch" style="background:${COL.band};height:8px"></span>ensemble p5–p95 Bz through the pipeline</span>
                <span><span class="gdc-swatch" style="background:${COL.mhd}"></span>Dst | BATS-R-US GM/IE ${mhdTrack ? '' : '(pending workstation run)'}</span>
            </div>
            <table class="gdc-table">
                <tr><th>driver source</th><th>min Dst</th><th>Δt(min) vs truth</th><th>RMSE</th><th>bias</th></tr>
                ${row('observed L1 drivers', cmp.skill.ceiling)}
                ${row('flux-rope train (det)', cmp.skill.rope)}
                ${row('flux-rope ensemble p50', cmp.skill.ropeP50)}
                ${mhdTrack ? row('BATS-R-US GM/IE', (() => {
                    const base = symH?.length ? skill(mhdTrack, symH) : { rmse: null, bias: null, n: 0 };
                    const m = trackMin(mhdTrack);
                    const tm = cmp.truthMin;
                    return { ...base, minDst: m.min, dtMinH: m.tMin != null && tm.tMin != null ? (m.tMin - tm.tMin) / 3.6e6 : null };
                })()) : ''}
            </table>
            <p class="gdc-note">
                One pipeline (<b>integrateDst</b> — the same O'Brien–McPherron integrator behind the live
                Ring Current page), three driver sources. The gap between <b>truth</b> and the
                <b>observed-driver</b> track is pipeline error; the gap between observed-driver and the
                <b>flux-rope</b> track is driver error. Honesty: the rope train is the validated hindcast
                FIT (tuned against this event's L1 Bz) — reproduction skill, not a blind forecast; V is
                rope-kinematic and N climatological in the rope legs; the ensemble band integrates the
                p5/p95 Bz <i>tracks</i>, not per-member Dst. The BATS-R-US trace joins automatically when
                the Gannon GM/IE re-run lands a <code>dst_nt</code> field in its bundle.
                ${symH ? '' : ' <b>SYM-H truth unavailable right now</b> — showing the two pipeline legs only.'}
            </p>`;

        const canvas = document.getElementById(`${hostId}-canvas`);
        const draw = () => drawChart(canvas, cmp, mhdTrack);
        draw();
        window.addEventListener('resize', draw);
    } catch (e) {
        console.info('gannon dst-compare unavailable:', e?.message ?? e);
        host.style.display = 'none';
    }
}
