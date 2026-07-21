/**
 * flux-rope-dashboard.js — the Flux Rope Simulator's dashboard insertion
 * (Phase 3/4 bridge, FLUX_ROPE_SIMULATOR_PLAN.md §4: "the live ticker shows
 * NOW; the rope engine adds NEXT").
 *
 * A compact, self-mounting panel for space-weather.html: takes the latest
 * Earth-directed DONKI CME analysis, runs the SAME flux-rope-core WASM
 * ensemble the simulator page uses (500 members, seeded priors from the
 * cone fit), conditions it on live DSCOVR/ACE Bz where coverage overlaps
 * (particle filter, spec §11), and renders the probabilistic Bz fan +
 * arrival window + storm probabilities — the forecast complement to the
 * page's existing arrival-only DBM section directly above it.
 *
 * Fail-quiet contract: this panel must NEVER break the dashboard. Any
 * error (no WASM, DONKI proxy down, no CMEs) collapses it to either a
 * one-line quiet state or display:none. All styles are frd- namespaced and
 * injected here — zero footprint on the page's own CSS.
 */

import { loadFluxRopeKernel } from './flux-rope-kernel.js';
import { fetchDonkiCmes, donkiToPreset, fetchRtswDriver } from './flux-rope-live.js';
import { drawBzChart } from './flux-rope/charts.js';

const CSS = `
.frd-panel {
    background: rgba(13,16,38,.72); border: 1px solid rgba(90,110,160,.25);
    border-radius: 12px; padding: 14px 16px; margin-top: 14px;
    font-family: inherit; color: #cdd5e4;
}
.frd-title { display:flex; align-items:center; gap:8px; font-size:.78rem;
    letter-spacing:.08em; text-transform:uppercase; color:#8b94ad; margin-bottom:8px; }
.frd-title .frd-pip { width:8px; height:8px; border-radius:50%;
    background:#c792ea; box-shadow:0 0 8px #c792ea; }
.frd-event { font-size:.8rem; color:#e4e9f5; margin-bottom:10px; }
.frd-event small { color:#68718a; }
.frd-grid { display:grid; grid-template-columns:minmax(0,1.7fr) minmax(180px,1fr); gap:14px; align-items:start; }
.frd-chart { width:100%; height:170px; display:block; }
.frd-stats { display:grid; gap:8px; }
.frd-stat { background:rgba(5,8,26,.6); border:1px solid rgba(90,110,160,.25);
    border-radius:10px; padding:7px 10px; }
.frd-stat .v { font-size:1rem; font-weight:700; color:#4fc3f7; }
.frd-stat .v.warn { color:#ffb454; }
.frd-stat .k { font-size:.62rem; color:#8b94ad; letter-spacing:.05em; text-transform:uppercase; margin-top:1px; }
.frd-foot { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;
    margin-top:9px; font-size:.68rem; color:#68718a; }
.frd-foot a { color:#4fc3f7; text-decoration:none; }
.frd-foot a:hover { text-decoration:underline; }
.frd-quiet { font-size:.78rem; color:#8b94ad; padding:4px 0 2px; }
@media (max-width:760px) { .frd-grid { grid-template-columns:1fr; } }
`;

const GRID_DT_S = 900;          // 15-min forecast grid
const GRID_HOURS = 120;
const MEMBERS = 500;
const SEED = 6180;              // fixed → the panel is deterministic per event

export async function mountFluxRopeDashboard(containerId) {
    const host = document.getElementById(containerId);
    if (!host) return;
    try {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
        host.innerHTML = `
            <div class="frd-panel" id="${containerId}-panel">
                <div class="frd-title"><span class="frd-pip"></span>
                    Flux-Rope Bz Forecast · ensemble engine (beta)</div>
                <div class="frd-quiet">Checking the DONKI catalog…</div>
            </div>`;
        const panel = host.firstElementChild;

        const cmes = await fetchDonkiCmes({ days: 7 });
        const target = cmes.find((c) => c.earthDirected) ?? null;
        if (!target) {
            panel.querySelector('.frd-quiet').innerHTML =
                '☀ No Earth-directed CME analyses in the DONKI catalog (last 7 days). ' +
                'The ensemble engine is idle — explore hindcasts in the ' +
                '<a href="flux-rope.html" style="color:#4fc3f7">Flux Rope Simulator</a>.';
            return;
        }

        // Live L1 for ambient wind + assimilation (best-effort).
        let rtsw = null;
        try { rtsw = await fetchRtswDriver(); } catch { /* offline is fine */ }
        let wSum = 0, wN = 0;
        for (const s of rtsw?.samples ?? []) if (Number.isFinite(s.v)) { wSum += s.v; wN++; }
        const preset = donkiToPreset(target, { ambientWKms: wN ? Math.round(wSum / wN) : 400 });

        const kernel = await loadFluxRopeKernel('./js/flux-rope-wasm/flux_rope_core.wasm');
        kernel.setRope(preset.rope);
        kernel.setSpreads(preset.spreads);
        const n = Math.round(GRID_HOURS * 3600 / GRID_DT_S);
        const launchMs = Date.parse(preset.launchIso);
        const ens = kernel.ensembleRun(SEED, MEMBERS, 0, GRID_DT_S, n);

        // Condition on live observed Bz where coverage overlaps the grid.
        let fan = ens, assimNote = 'prior (no L1 overlap yet)';
        if (rtsw?.length) {
            const obs = new Float32Array(n).fill(NaN);
            let nObs = 0;
            const nowIdx = Math.min(n, Math.max(0, Math.floor((Date.now() - launchMs) / 1000 / GRID_DT_S)));
            for (let i = 0; i < nowIdx; i++) {
                const t = launchMs + i * GRID_DT_S * 1000;
                if (t < rtsw.tStart || t > rtsw.tEnd) continue;
                const s = rtsw.at(t);
                if (s && Number.isFinite(s.bz)) { obs[i] = s.bz; nObs++; }
            }
            if (nObs >= 4) {
                const a = kernel.assimilate({ obsBz: obs, i0: 0, i1: nowIdx, sigmaNt: 4 });
                fan = a;
                assimNote = `particle filter · ${nObs} obs · ESS ${a.ess.toFixed(0)}/${MEMBERS}`
                    + (a.temperature < 1 ? ` · λ ${a.temperature.toFixed(2)}` : '');
            }
        }

        // Arrival window from the (prior) member arrival distribution.
        const arr = Array.from(ens.arrivalH).filter(Number.isFinite).sort((a, b) => a - b);
        const fmtUtc = (h) => new Date(launchMs + h * 3600_000).toISOString().slice(5, 16).replace('T', ' ');
        const arrTxt = arr.length
            ? `${fmtUtc(arr[Math.floor(arr.length * 0.1)])} – ${fmtUtc(arr[Math.floor(arr.length * 0.9)])}`
            : 'likely miss';
        const pct = (v) => `${Math.round(v * 100)}%`;
        const p10 = fan.pMinBzBelow(-10), p20 = fan.pMinBzBelow(-20);

        panel.innerHTML = `
            <div class="frd-title"><span class="frd-pip"></span>
                Flux-Rope Bz Forecast · ensemble engine (beta)</div>
            <div class="frd-event">
                CME ${target.timeIso.replace('T', ' ').replace(/Z?$/, 'Z')} ·
                ${Math.round(target.speedKms)} km/s · Earth-directed
                <small>· ${MEMBERS}-member ensemble · ${assimNote}</small>
            </div>
            <div class="frd-grid">
                <canvas class="frd-chart" id="${containerId}-chart"></canvas>
                <div class="frd-stats">
                    <div class="frd-stat"><div class="v">${pct(fan.pHit)}</div><div class="k">P(Earth hit)</div></div>
                    <div class="frd-stat"><div class="v${p10 > 0.3 ? ' warn' : ''}">${pct(p10)}</div><div class="k">P(min Bz &lt; −10 nT)</div></div>
                    <div class="frd-stat"><div class="v${p20 > 0.3 ? ' warn' : ''}">${pct(p20)}</div><div class="k">P(min Bz &lt; −20 nT)</div></div>
                    <div class="frd-stat"><div class="v">${arrTxt}</div><div class="k">arrival window (P10–P90, UTC)</div></div>
                </div>
            </div>
            <div class="frd-foot">
                <span>Fan: ensemble 5–95% / 25–75% Bz at L1 · amber = observed DSCOVR/ACE · magnetic config is a wide prior (cone fits don't constrain it)</span>
                <a href="flux-rope.html">Open in the Flux Rope Simulator →</a>
            </div>`;

        const tH = Array.from({ length: n }, (_, i) => i * GRID_DT_S / 3600);
        const obsPlot = rtsw?.length
            ? { tH: rtsw.samples.map((s) => (s.t - launchMs) / 3600_000), bz: rtsw.samples.map((s) => s.bz) }
            : null;
        const draw = () => drawBzChart(document.getElementById(`${containerId}-chart`), {
            tH,
            det: null,
            fan: { ...fan.bzPct, hitFrac: fan.hitFrac },
            obs: obsPlot,
            launchMs,
            cursorH: (Date.now() - launchMs) / 3600_000,
        });
        draw();
        window.addEventListener('resize', draw);
    } catch (e) {
        console.info('flux-rope dashboard panel unavailable:', e?.message ?? e);
        host.style.display = 'none';
    }
}
