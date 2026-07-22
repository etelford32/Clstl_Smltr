/**
 * ring-current-outlook.js — the Ring Current page's flux-rope FORECAST mode
 * (Phase 4 consumer #1 of js/flux-rope-forecast.js).
 *
 * The page's live pipeline is observed-L1 → Dst with ~30–60 min of physical
 * lead time. This panel adds DAYS: the shared flux-rope provider's forecast
 * driver (SolarWindDriver, source 'forecast') feeds the SAME
 * `integrateDst` the live model uses — the Phase 0 driver-contract bet
 * paying out literally: `driver.samples` IS the integrator's input shape.
 *
 * Honesty in the copy: the rope engine forecasts the FIELD; V is
 * rope-kinematic, N climatological (see flux-rope-forecast.js), and the
 * Dst track inherits the ensemble's uncertainty only through the median —
 * the P() chips carry the spread. Fail-quiet contract: this panel must
 * NEVER break the Ring Current page; any error collapses it to
 * display:none. All styles rco- namespaced.
 */

import { computeFluxRopeForecast } from './flux-rope-forecast.js';
import { integrateDst, stormClass } from './ring-current-model.js';

const CSS = `
.rco-panel { background: rgba(13,16,38,.72); border: 1px solid rgba(90,110,160,.25);
    border-radius: 12px; padding: 13px 15px; margin-top: 12px; color: #cdd5e4; }
.rco-title { display:flex; align-items:center; gap:8px; font-size:.76rem; letter-spacing:.08em;
    text-transform:uppercase; color:#8b94ad; margin-bottom:8px; }
.rco-title .rco-pip { width:8px; height:8px; border-radius:50%; background:#c792ea; box-shadow:0 0 8px #c792ea; }
.rco-grid { display:flex; gap:10px; flex-wrap:wrap; }
.rco-stat { background:rgba(5,8,26,.6); border:1px solid rgba(90,110,160,.25);
    border-radius:10px; padding:7px 12px; min-width:118px; }
.rco-stat .v { font-size:1rem; font-weight:700; color:#4fc3f7; }
.rco-stat .v.warn { color:#ffb454; }
.rco-stat .v.bad { color:#ff6e6e; }
.rco-stat .k { font-size:.6rem; color:#8b94ad; letter-spacing:.05em; text-transform:uppercase; margin-top:1px; }
.rco-foot { margin-top:8px; font-size:.66rem; color:#68718a; }
.rco-foot a { color:#4fc3f7; text-decoration:none; }
`;

/** Latest observed Dst for the integration start (best-effort chain). */
async function latestDst() {
    try {
        const r = await fetch('/api/noaa/dst');
        const j = await r.json();
        const rec = j?.data?.recent;
        if (Array.isArray(rec) && rec.length) {
            const last = rec[rec.length - 1];
            if (Number.isFinite(last.dst_nT)) return { dst: last.dst_nT, assumed: false };
        }
    } catch { /* fall through */ }
    return { dst: 0, assumed: true };
}

export async function mountRingCurrentOutlook(hostId) {
    const host = document.getElementById(hostId);
    if (!host) return;
    try {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        const fc = await computeFluxRopeForecast({});
        if (fc.idle) { host.style.display = 'none'; return; }

        const { summary, driver, launchMs } = fc;
        const nowMs = Date.now();
        // Integrate Dst over the FORECAST portion only, from the latest
        // observed Dst — the past belongs to the live pipeline above.
        const future = driver.samples.filter((s) => s.t >= nowMs);
        if (future.length < 8) { host.style.display = 'none'; return; }
        const { dst: dst0, assumed } = await latestDst();
        const track = integrateDst(future, dst0);
        let minDst = Infinity, minT = null;
        for (const p of track) if (p.dst < minDst) { minDst = p.dst; minT = p.t; }
        const cls = stormClass(minDst).label.replace(/ \(.*\)/, '');

        const fmtUtc = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');
        const pct = (v) => `${Math.round(v * 100)}%`;
        const dstCls = minDst < -100 ? 'bad' : minDst < -50 ? 'warn' : '';
        const arrTxt = summary.arrivalP10Ms != null
            ? `${fmtUtc(summary.arrivalP10Ms)} – ${fmtUtc(summary.arrivalP90Ms)}`
            : 'likely miss';

        host.innerHTML = `
            <div class="rco-panel">
                <div class="rco-title"><span class="rco-pip"></span>
                    Forecast mode · flux-rope ensemble → Dst outlook</div>
                <div class="rco-grid">
                    <div class="rco-stat"><div class="v ${dstCls}">${Math.round(minDst)} nT</div>
                        <div class="k">forecast min Dst${cls && cls !== 'Quiet' ? ` · ${cls}` : ''}</div></div>
                    <div class="rco-stat"><div class="v">${minT ? fmtUtc(minT) : '—'}</div>
                        <div class="k">deepest around (UTC)</div></div>
                    <div class="rco-stat"><div class="v">${arrTxt}</div>
                        <div class="k">CME arrival window</div></div>
                    <div class="rco-stat"><div class="v">${pct(summary.pHit)}</div>
                        <div class="k">P(Earth hit)</div></div>
                    <div class="rco-stat"><div class="v${summary.p20 > 0.3 ? ' warn' : ''}">${pct(summary.p10)} / ${pct(summary.p20)}</div>
                        <div class="k">P(Bz &lt; −10 / −20 nT)</div></div>
                </div>
                <div class="rco-foot">
                    Median flux-rope forecast Bz driven through the SAME Dst integrator as the live
                    pipeline (${fc.assimNote}); V rope-kinematic, N climatological${assumed ? '; start Dst assumed 0 (Kyoto feed unavailable)' : ''}.
                    CME ${new Date(launchMs).toISOString().slice(0, 16).replace('T', ' ')}Z ·
                    <a href="flux-rope.html">open in the Flux Rope Simulator →</a>
                </div>
            </div>`;
    } catch (e) {
        console.info('ring-current flux-rope outlook unavailable:', e?.message ?? e);
        host.style.display = 'none';
    }
}
