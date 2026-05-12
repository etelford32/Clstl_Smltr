/**
 * upper-atmosphere-asset-storycard.js — single-asset focused view
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 21: an enlarged, draggable, minimizable window that consolidates
 * everything the operator has accumulated about a single asset:
 *
 *   1. Header     — name, NORAD ID, status pill, live drag-band readout
 *   2. Live       — current alt / speed / q / period / sub-satellite point
 *   3. Forecast   — large altitude + p5/p95 envelope chart (re-rendered
 *                   from the per-asset analyzer result; nothing recomputed)
 *   4. Skill      — enlarged residual sparkline + backtest summary +
 *                   tally of past anomalies (with descriptor)
 *   5. Conjunctions — this asset's archive entries (live + historical),
 *                     sorted by tcaAbsMs DESC
 *   6. Anomalies  — chronological list of anomaly-fired moments with
 *                   their best-guess causes from Phase 18/19
 *
 * Lives inside a FloatingWindow. Multiple cards can be open at once;
 * each operator click is dedup'd by asset id (re-click brings the
 * existing card to front rather than spawning a duplicate). The panel
 * holds an instance map and pushes update() on every analyzer recompute
 * so the open card stays live without operator action.
 *
 * Every section here re-renders from existing data (asset, analyzer
 * result, fleet archive). No new compute, no new fetches, no new
 * storage — same dataflow contract as Phases 16–20.
 */

import { FloatingWindow } from './upper-atmosphere-floating-window.js';
import {
    detectAnomaly, walkResidualAnomalies,
    correlateAnomalyWithConjunctions,
} from './upper-atmosphere-backtest.js';
import {
    REENTRY_KM, DECAY_SPIKE_KM_DAY,
} from './upper-atmosphere-fleet-analyzer.js';

const WINDOW_WIDTH  = 500;
const WINDOW_HEIGHT = 640;

// Per-section chart geometry (larger than the per-card sparkline).
const FORECAST_W = 460, FORECAST_H = 130;
const SPARK_W    = 460, SPARK_H    = 56;

export class AssetStoryCard {
    /** Open (or focus, if already open) the story card for one asset. */
    static open({ asset, result, fleet, analyzer }) {
        const id = `story:${asset.id}`;
        const win = new FloatingWindow({
            id,
            title: asset.name || (asset.noradId ? `#${asset.noradId}` : asset.id),
            width: WINDOW_WIDTH,
            height: WINDOW_HEIGHT,
        });
        const sc = new AssetStoryCard({ asset, result, fleet, analyzer, win });
        sc.render();
        return sc;
    }

    constructor({ asset, result, fleet, analyzer, win }) {
        this.asset    = asset;
        this.result   = result;
        this.fleet    = fleet;
        this.analyzer = analyzer;
        this.win      = win;
    }

    /** Push fresh data into the card — called by the panel after each tick. */
    update({ asset, result }) {
        if (asset)  this.asset  = asset;
        if (result) this.result = result;
        this.win.setTitle(this.asset.name || `#${this.asset.noradId}`);
        this.render();
    }

    isOpen() { return !!this.win?.el?.isConnected; }
    close()  { this.win?.close(); }

    // ── Render ────────────────────────────────────────────────────────────

    render() {
        const a = this.asset;
        const r = this.result;

        const header   = this._renderHeader(a, r);
        const live     = this._renderLive(a, r);
        const forecast = this._renderForecastChart(r);
        const skill    = this._renderSkillSection(a, r);
        const conj     = this._renderConjunctionsSection(a);
        const anomLog  = this._renderAnomaliesSection(a);

        this.win.setBody(`
            <div class="ua-storycard">
                ${header}
                <div class="ua-storycard-grid">
                    ${live}
                    ${forecast}
                    ${skill}
                    ${conj}
                    ${anomLog}
                </div>
            </div>
        `);
    }

    // ── 1. Header ─────────────────────────────────────────────────────────
    _renderHeader(a, r) {
        const noradTag = a.noradId
            ? `<span class="ua-storycard-norad">#${a.noradId}</span>` : '';
        const statusCls = r?.status === 'ready'   ? 'ua-fleet-pill--ok'
                        : r?.status === 'pending' ? 'ua-fleet-pill--pending'
                        : 'ua-fleet-pill--err';
        const statusTxt = r?.status === 'ready' ? 'LIVE'
                        : r?.status === 'pending' ? 'LOADING' : 'ERROR';
        // Inline confidence + drag-band as the operator-grade one-liner.
        const conf = r?.forecast ? this._renderConfidenceChip(r.forecast) : '';
        return `
            <div class="ua-storycard-head">
                <span class="ua-storycard-name">${_esc(a.name || 'unknown')}</span>
                ${noradTag}
                <span class="ua-fleet-pill ${statusCls}">${statusTxt}</span>
                ${conf}
            </div>`;
    }

    _renderConfidenceChip(fc) {
        const skill = Math.round((fc.skill ?? 0) * 100);
        const cls = skill >= 75 ? 'ua-fleet-skill--high'
                  : skill >= 50 ? 'ua-fleet-skill--med'
                                : 'ua-fleet-skill--low';
        const jointPct = Number.isFinite(fc.jointSigmaRel)
            ? `${(fc.jointSigmaRel * 100).toFixed(0)}%` : '—';
        return `<span class="ua-fleet-skill ${cls}"
                    title="AR(1) forecast confidence at +${fc.horizonHr}h. Drag-rate σ (joint forcing + BC) = ${jointPct}.">
            ${skill}% · drag ±${jointPct}</span>`;
    }

    // ── 2. Live state ─────────────────────────────────────────────────────
    _renderLive(a, r) {
        if (!r?.live) {
            return `<section class="ua-storycard-sec ua-storycard-empty">
                Live state unavailable (asset status: ${_esc(r?.status || 'unknown')}).</section>`;
        }
        const live = r.live;
        const q = live.q_pa ? ` · q ${(live.q_pa * 1e6).toFixed(2)} µPa` : '';
        const altStr = `${live.altKm.toFixed(1)} km`;
        const ssp = `lat ${live.latDeg.toFixed(1)}° / lon ${live.lonDeg.toFixed(1)}°`;
        const orbit = (live.period_min != null ? `T ${live.period_min.toFixed(1)} min` : '')
            + (live.inclinationDeg != null ? ` · i ${live.inclinationDeg.toFixed(1)}°` : '')
            + (Number.isFinite(live.eccentricity) ? ` · e ${live.eccentricity.toFixed(4)}` : '');
        return `<section class="ua-storycard-sec">
            <h4>Live state</h4>
            <div class="ua-storycard-livegrid">
                <div><span>alt</span><b>${altStr}</b></div>
                <div><span>speed</span><b>${live.speedKms.toFixed(2)} km/s</b></div>
                <div><span>BC</span><b>${a.bcM2PerKg.toFixed(4)} m²/kg</b></div>
                <div><span>σ_BC</span><b>${((a.bcSigmaRel ?? 0.15) * 100).toFixed(0)}%</b></div>
            </div>
            <div class="ua-storycard-livefoot">${ssp} · ${orbit}${q}</div>
        </section>`;
    }

    // ── 3. Forecast chart ─────────────────────────────────────────────────
    _renderForecastChart(r) {
        const decay = r?.decay;
        if (!decay?.nowcast?.length || !decay.forecast?.length) {
            return '';
        }
        const W = FORECAST_W, H = FORECAST_H, PAD = 6;
        const useMc = decay.mc?.pLow?.length && decay.mc?.pHigh?.length;
        const a = decay.nowcast;
        const b = (useMc && decay.mc.pMed?.length) ? decay.mc.pMed : decay.forecast;
        const lo = useMc ? decay.mc.pHigh : (decay.envelopeBenign  || decay.forecast);
        const hi = useMc ? decay.mc.pLow  : (decay.envelopeAdverse || decay.forecast);

        let xMin = a[0].t_min, xMax = a[a.length - 1].t_min;
        let yMin = Infinity, yMax = -Infinity;
        const span = arr => { for (const p of arr) {
            if (p.alt_km < yMin) yMin = p.alt_km;
            if (p.alt_km > yMax) yMax = p.alt_km;
        }};
        span(a); span(b); span(lo); span(hi);
        if (yMax - yMin < 0.5) yMax = yMin + 0.5;

        const sx = t => PAD + ((t - xMin) / (xMax - xMin)) * (W - 2 * PAD);
        const sy = y => H - PAD - ((y - yMin) / (yMax - yMin)) * (H - 2 * PAD);
        const linePath = arr => arr.map((p, i) =>
            `${i === 0 ? 'M' : 'L'}${sx(p.t_min).toFixed(1)},${sy(p.alt_km).toFixed(1)}`).join(' ');

        let bandPath = null;
        if (lo.length === hi.length && lo.length >= 2) {
            const fwd = lo.map(p => `${sx(p.t_min).toFixed(1)},${sy(p.alt_km).toFixed(1)}`);
            const bak = hi.slice().reverse().map(p =>
                `${sx(p.t_min).toFixed(1)},${sy(p.alt_km).toFixed(1)}`);
            bandPath = `M${fwd.join(' L')} L${bak.join(' L')} Z`;
        }

        const reentryLine = (REENTRY_KM > yMin && REENTRY_KM < yMax)
            ? `<line x1="${PAD}" x2="${W - PAD}"
                     y1="${sy(REENTRY_KM).toFixed(1)}" y2="${sy(REENTRY_KM).toFixed(1)}"
                     stroke="rgba(255,80,96,.45)" stroke-dasharray="3 3" stroke-width="1"/>`
            : '';

        // Y-axis ticks: just min and max labels so the operator can read
        // magnitudes off the chart without consulting a separate ruler.
        const yLabels = `
            <text x="${PAD + 2}" y="${PAD + 9}" class="ua-storycard-axislabel">${yMax.toFixed(0)} km</text>
            <text x="${PAD + 2}" y="${H - PAD - 2}" class="ua-storycard-axislabel">${yMin.toFixed(0)} km</text>`;
        const horizonHrs = (xMax - xMin) / 60;
        const horizonLabel = `<text x="${W - PAD - 4}" y="${H - PAD - 2}"
                                    class="ua-storycard-axislabel"
                                    text-anchor="end">+${horizonHrs.toFixed(0)}h</text>`;

        const risk = r.risk;
        const pReentryPct = Number.isFinite(risk?.pReentry) && risk.pReentry > 0.005
            ? `P(reentry) ${(risk.pReentry * 100).toFixed(0)}%` : '';
        const horizonLine = `${decay.horizonHr ?? horizonHrs.toFixed(0)} h forecast`;
        const subtitle = pReentryPct
            ? `${horizonLine} · ${pReentryPct}`
            : horizonLine;

        return `<section class="ua-storycard-sec">
            <h4>Decay forecast</h4>
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
                 class="ua-storycard-svg"
                 aria-label="Altitude decay forecast with uncertainty envelope">
                ${bandPath ? `<path d="${bandPath}" fill="rgba(255,170,32,.16)" stroke="none"/>` : ''}
                ${reentryLine}
                <path d="${linePath(a)}" stroke="#0ff"    stroke-width="1.5" fill="none"/>
                <path d="${linePath(b)}" stroke="#ffaa20" stroke-width="1.5" fill="none"
                      stroke-dasharray="4 3"/>
                ${yLabels}
                ${horizonLabel}
            </svg>
            <div class="ua-storycard-key">
                <span style="color:#0ff">— nowcast</span>
                <span style="color:#ffaa20">— ${useMc ? `MC p50 (n=${decay.mc.n_used})` : 'forecast'}</span>
                <span style="color:rgba(255,170,32,.65)">▬ ${useMc ? 'p5–p95 band' : '±σ envelope'}</span>
                <span class="ua-storycard-key-sub">${subtitle}</span>
            </div>
        </section>`;
    }

    // ── 4. Skill section ──────────────────────────────────────────────────
    _renderSkillSection(a, r) {
        const det  = detectAnomaly(a);
        const walk = walkResidualAnomalies(a);
        const sorted = walk.entries;
        if (sorted.length === 0) {
            return `<section class="ua-storycard-sec">
                <h4>Skill</h4>
                <p class="ua-storycard-empty">No residual history yet. Refresh
                this asset's TLE over a few days to build skill data.</p>
            </section>`;
        }
        const values = sorted.map(e => e.residual_km);

        // Reuse the median/σ from the live detector when we have them; fall
        // back to raw median when the detector hasn't enough samples.
        const median = Number.isFinite(det?.median) ? det.median
            : _sampleMedian(values);
        const sigma  = Number.isFinite(det?.sigma) ? det.sigma : 0;

        const W = SPARK_W, H = SPARK_H, PAD_X = 4, PAD_Y = 6;
        let yLo = Math.min(...values, median - 3 * sigma);
        let yHi = Math.max(...values, median + 3 * sigma);
        const yRange = Math.max(yHi - yLo, 0.01);
        yLo -= yRange * 0.05; yHi += yRange * 0.05;
        const sx = i => PAD_X + (W - 2 * PAD_X) * (i / Math.max(1, sorted.length - 1));
        const sy = v => H - PAD_Y - (H - 2 * PAD_Y) * ((v - yLo) / (yHi - yLo));

        const band = sigma > 0 ? (() => {
            const y1 = sy(median + 3 * sigma), y2 = sy(median - 3 * sigma);
            return `<rect x="${PAD_X}" y="${y1.toFixed(1)}"
                          width="${(W - 2 * PAD_X).toFixed(1)}"
                          height="${(y2 - y1).toFixed(1)}"
                          fill="rgba(255,170,32,.12)"/>`;
        })() : '';
        const medY = sy(median);
        const medLine = `<line x1="${PAD_X}" x2="${W - PAD_X}"
                                y1="${medY.toFixed(1)}" y2="${medY.toFixed(1)}"
                                stroke="rgba(0,200,200,.45)"
                                stroke-dasharray="3 3" stroke-width="1"/>`;
        const path = sorted.map((p, i) =>
            `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(p.residual_km).toFixed(1)}`
        ).join(' ');
        const dots = sorted.map((p, i) => {
            const isLast = i === sorted.length - 1;
            const wasAnom = walk.flags[i] === true;
            const z = sigma > 0 ? Math.abs(p.residual_km - median) / sigma : 0;
            const colour = isLast && det?.isAnomaly ? '#ff5060'
                        : isLast                   ? '#40e090'
                        : wasAnom                  ? '#ff5060'
                        : z >= 3                   ? '#ffaa20'
                                                   : '#9ab';
            const r = isLast ? 3.0 : (wasAnom ? 2.4 : 2.0);
            return `<circle cx="${sx(i).toFixed(1)}" cy="${sy(p.residual_km).toFixed(1)}"
                            r="${r}" fill="${colour}"/>`;
        }).join('');
        const ticks = sorted.map((p, i) => {
            if (!walk.flags[i] || i === sorted.length - 1) return '';
            return `<line x1="${sx(i).toFixed(1)}" x2="${sx(i).toFixed(1)}"
                          y1="${(H - 2).toFixed(1)}" y2="${(H - PAD_Y).toFixed(1)}"
                          stroke="#ff5060" stroke-width="1.4" opacity="0.8"/>`;
        }).join('');

        const totalAnoms = walk.flags.filter(Boolean).length;
        const descriptor = totalAnoms >= 3 ? ' (chronic)'
                         : totalAnoms === 2 ? ' (recurring)'
                         : totalAnoms === 1 ? ' (single event)' : '';

        const latest = sorted[sorted.length - 1];
        const sign = latest.residual_km >= 0 ? '+' : '−';

        return `<section class="ua-storycard-sec">
            <h4>Skill — ${sorted.length} sample${sorted.length === 1 ? '' : 's'}${descriptor}</h4>
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
                 class="ua-storycard-svg ua-storycard-svg--spark">
                ${band}${medLine}
                <path d="${path}" stroke="rgba(150,170,200,.7)" stroke-width="1" fill="none"/>
                ${dots}
                ${ticks}
            </svg>
            <div class="ua-storycard-skillfoot">
                latest ${sign}${Math.abs(latest.residual_km).toFixed(2)} km
                · median ${median.toFixed(2)} km
                · σ ${sigma > 0 ? sigma.toFixed(2) + ' km' : '—'}
                ${Number.isFinite(det?.z) ? `· z ${det.z.toFixed(1)}` : ''}
                ${totalAnoms ? `· ⚠×${totalAnoms}` : ''}
            </div>
        </section>`;
    }

    // ── 5. Conjunction history ────────────────────────────────────────────
    _renderConjunctionsSection(a) {
        const stats = this.fleet.getConjunctionStats?.(a.id, 30);
        const archive = this.fleet.getConjunctionArchive?.() || [];
        const mine = archive
            .filter(e => e.idA === a.id || e.idB === a.id)
            .sort((x, y) => (y.tcaAbsMs ?? 0) - (x.tcaAbsMs ?? 0));
        if (mine.length === 0) {
            return `<section class="ua-storycard-sec">
                <h4>Conjunctions</h4>
                <p class="ua-storycard-empty">No conjunction events archived
                for this asset. (Encounters with other tracked fleet members
                will accumulate here over time.)</p>
            </section>`;
        }
        const now = Date.now();
        const rows = mine.slice(0, 12).map(e => {
            const partner = e.idA === a.id ? e.nameB : e.nameA;
            const isPast = e.tcaAbsMs < now;
            const delta = (e.tcaAbsMs - now) / 86400000;
            const when = isPast
                ? `${(-delta).toFixed(1)} d ago`
                : `+${delta.toFixed(1)} d`;
            const pct = Number.isFinite(e.pConj) ? `${(e.pConj * 100).toFixed(0)}%` : '—';
            const pCls = e.pConj >= 0.5 ? 'is-high' : e.pConj >= 0.1 ? 'is-med' : 'is-low';
            const dMin = Number.isFinite(e.dMinKm) ? `${e.dMinKm.toFixed(1)} km` : '—';
            const sightTxt = (e.sightings ?? 1) > 1 ? ` · ${e.sightings}×seen` : '';
            const cls = isPast ? 'is-past' : 'is-pending';
            return `<div class="ua-storycard-conj-row ${cls}">
                <span class="ua-storycard-conj-prob ${pCls}">${pct}</span>
                <span class="ua-storycard-conj-partner">${_esc(partner)}</span>
                <span class="ua-storycard-conj-meta">${when} · ${dMin}${sightTxt}</span>
            </div>`;
        }).join('');
        const summary = stats
            ? `${stats.encounters} encounter${stats.encounters === 1 ? '' : 's'}`
              + ` across ${stats.uniquePartners} partner${stats.uniquePartners === 1 ? '' : 's'}`
              + (Number.isFinite(stats.worstDMinKm) ? ` · worst ${stats.worstDMinKm.toFixed(1)} km` : '')
              + ` · last ${stats.windowDays} d`
            : '';
        return `<section class="ua-storycard-sec">
            <h4>Conjunctions</h4>
            ${summary ? `<div class="ua-storycard-conj-summary">${summary}</div>` : ''}
            <div class="ua-storycard-conj-rows">${rows}</div>
        </section>`;
    }

    // ── 6. Anomaly timeline ───────────────────────────────────────────────
    _renderAnomaliesSection(a) {
        const walk = walkResidualAnomalies(a);
        const flaggedIdxs = [];
        for (let i = 0; i < walk.flags.length; i++) if (walk.flags[i]) flaggedIdxs.push(i);
        if (flaggedIdxs.length === 0) {
            return `<section class="ua-storycard-sec">
                <h4>Anomaly timeline</h4>
                <p class="ua-storycard-empty">No anomalies fired on this
                asset's history. Quiet residuals — model is honest.</p>
            </section>`;
        }
        const archive = this.fleet.getConjunctionArchive?.() || [];
        const rows = flaggedIdxs.slice().reverse().slice(0, 8).map(i => {
            const e = walk.entries[i];
            // Reconstruct a minimal detector output so the correlator
            // works on past entries too — we already have everything it
            // needs from the walker.
            const priorVals = walk.entries.slice(0, i).map(x => x.residual_km).sort((a, b) => a - b);
            const med = _sampleMedian(priorVals);
            const devs = priorVals.map(v => Math.abs(v - med)).sort((a, b) => a - b);
            const sig = Math.max(_sampleMedian(devs) * 1.4826, 1e-6);
            const delta = e.residual_km - med;
            const direction = delta > 0 ? 'high' : delta < 0 ? 'low' : null;
            const det = {
                isAnomaly: true, latestRanAt: e.ranAt,
                direction, z: Math.abs(delta) / sig,
                latestResidual: e.residual_km, median: med, sigma: sig,
            };
            const conj = correlateAnomalyWithConjunctions(a, det, archive);
            const ageDays = (Date.now() - e.ranAt) / 86400000;
            const ageTxt = ageDays < 1 ? `${(ageDays * 24).toFixed(0)} h ago`
                          : `${ageDays.toFixed(1)} d ago`;
            const sign = delta >= 0 ? '+' : '−';
            const causeWord = conj?.maneuverHint === 'boost' ? 'likely boost'
                            : conj?.maneuverHint === 'brake' ? 'likely brake'
                            : conj ? 'likely conj' : 'unexplained';
            const causeDetail = conj
                ? ` (after ${_esc(conj.partnerName)}, P(conj) ${(conj.pConj * 100).toFixed(0)}%)`
                : '';
            return `<div class="ua-storycard-anom-row">
                <span class="ua-storycard-anom-when">${ageTxt}</span>
                <span class="ua-storycard-anom-delta">${sign}${Math.abs(delta).toFixed(2)} km</span>
                <span class="ua-storycard-anom-z">z ${det.z.toFixed(1)}</span>
                <span class="ua-storycard-anom-cause">${causeWord}${causeDetail}</span>
            </div>`;
        }).join('');
        const total = flaggedIdxs.length;
        return `<section class="ua-storycard-sec">
            <h4>Anomaly timeline — ${total} event${total === 1 ? '' : 's'}</h4>
            <div class="ua-storycard-anom-rows">${rows}</div>
        </section>`;
    }
}

// ── Private helpers ──────────────────────────────────────────────────────

function _sampleMedian(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
