/**
 * conj-timeline.js — Horizontal severity-coloured tick strip showing
 * every fleet conjunction across the time-bus window.
 *
 * Sits just above the time scrub track and shares its X axis: ticks
 * are positioned by `tca_ms` against `timeBus.getState().rangeMs`.
 * Each tick is a `<button>` so it's keyboard-focusable; clicking it
 * scrubs sim time to TCA, selects the fleet primary, and fires the
 * b-plane / encounter visualization.
 *
 * Severity colour matches the conjunctions panel:
 *   < 5 km   high   pink     #f57
 *   < 15 km  med    amber    #fc8
 *   < 50 km  low    cyan     #0cc
 *
 * Hovering a tick pops a tooltip with primary, secondary, miss, lead
 * time, and Δv. The tooltip is shared across the whole strip — one
 * DOM node, repositioned per hover.
 *
 * Renders on three signals:
 *   - subscribeRows from mountConjunctions (new screen → new ticks)
 *   - timeBus.subscribe (the rangeMs window slides every second; we
 *     reposition existing ticks without rebuilding)
 *   - selection change isn't wired here — operators select via tick
 *     click or the panel rows.
 */

import { timeBus } from './time-bus.js';

const SEVERITY_HIGH_KM = 5;
const SEVERITY_MED_KM  = 15;

function severityFor(distKm) {
    if (distKm < SEVERITY_HIGH_KM) return 'high';
    if (distKm < SEVERITY_MED_KM)  return 'med';
    return 'low';
}

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtUtc(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
           `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}Z`;
}
function fmtAhead(simMs, tcaMs) {
    const diff = tcaMs - simMs;
    const sign = diff < 0 ? '−' : '+';
    const abs  = Math.abs(diff);
    if (abs < 3_600_000)         return `${sign}${Math.round(abs / 60_000)} min`;
    if (abs < 24 * 3_600_000)    return `${sign}${(abs / 3_600_000).toFixed(1)} h`;
    return `${sign}${(abs / (24 * 3_600_000)).toFixed(1)} d`;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

export function mountConjTimeline(opts = {}) {
    const {
        host,                             // container DOM element (full-width strip)
        deck,                             // mountConjunctions return value
        onSelect      = () => {},         // primary noradId
        onConjunction = () => {},         // rich conj shape (b-plane / visuals)
        tracker       = null,             // for getSatellite to fetch secondary TLE
    } = opts;

    if (!host || !deck?.subscribeRows) {
        console.warn('[conjTimeline] missing host / deck.subscribeRows; aborting mount');
        return { dispose() {} };
    }

    host.classList.add('op-conj-timeline');
    host.setAttribute('role', 'list');
    host.setAttribute('aria-label', 'Fleet conjunctions in the current horizon');

    const tooltip = document.createElement('div');
    tooltip.className = 'op-conj-timeline-tip';
    tooltip.style.display = 'none';
    host.appendChild(tooltip);

    // Flat list of all conjunctions across the fleet, augmented with
    // primary metadata so a tick click can fire the encounter
    // visualization without a second lookup.
    let flat = [];

    function rebuildFlat(snap) {
        flat = [];
        if (!snap?.rows) return;
        for (const { asset, conjs } of snap.rows) {
            for (const c of (conjs ?? [])) {
                if (!Number.isFinite(c.tca_ms)) continue;
                flat.push({
                    primaryName:  asset.name,
                    primaryId:    asset.noradId,
                    primaryTle:   asset.tle,
                    secondary:    c,
                });
            }
        }
        // Sort by closest TCA so DOM order matches the scan an operator
        // would do reading left-to-right.
        flat.sort((a, b) => a.secondary.tca_ms - b.secondary.tca_ms);
    }

    function renderTicks() {
        // Drop existing ticks but keep the shared tooltip node.
        host.querySelectorAll('.op-conj-tick').forEach(el => el.remove());
        if (flat.length === 0) {
            host.classList.add('op-conj-timeline--empty');
            return;
        }
        host.classList.remove('op-conj-timeline--empty');

        const { rangeMs } = timeBus.getState();
        const span = rangeMs.end - rangeMs.start;

        // Bucket ticks within ~0.5 % of each other into a single
        // glyph so a busy debris field doesn't paint a continuous
        // bar. The brightest (lowest miss) wins the colour.
        const buckets = new Map();
        const bucketWidthPct = 0.5;
        for (const it of flat) {
            const t = (it.secondary.tca_ms - rangeMs.start) / span;
            if (!Number.isFinite(t) || t < 0 || t > 1) continue;
            const key = Math.round((t * 100) / bucketWidthPct);
            const cur = buckets.get(key);
            if (!cur || it.secondary.dist_km < cur.secondary.dist_km) {
                buckets.set(key, it);
            }
        }

        for (const [key, it] of buckets) {
            const left = (key * bucketWidthPct).toFixed(2);
            const sev  = severityFor(it.secondary.dist_km);
            const btn  = document.createElement('button');
            btn.type = 'button';
            btn.className = `op-conj-tick op-conj-tick-${sev}`;
            btn.style.left = `${left}%`;
            btn.dataset.idx = String(key);
            btn.dataset.tcaMs = String(it.secondary.tca_ms);
            btn.setAttribute('role', 'listitem');
            btn.setAttribute('aria-label',
                `${it.primaryName} ↔ ${it.secondary.name || `#${it.secondary.norad_id}`}, ` +
                `${it.secondary.dist_km.toFixed(2)} km at ${fmtUtc(it.secondary.tca_ms)}`,
            );

            btn.addEventListener('mouseenter', () => showTip(it, btn));
            btn.addEventListener('mouseleave', hideTip);
            btn.addEventListener('focus',      () => showTip(it, btn));
            btn.addEventListener('blur',       hideTip);
            btn.addEventListener('click',      () => fire(it));

            host.appendChild(btn);
        }
    }

    function showTip(it, anchor) {
        const { simTimeMs } = timeBus.getState();
        const dv = it.secondary.dv_kms != null
            ? `<span class="op-conj-timeline-tip-dv">${it.secondary.dv_kms.toFixed(2)} km/s</span>`
            : '';
        tooltip.innerHTML = `
            <div class="op-conj-timeline-tip-row1">
                <span class="op-conj-timeline-tip-prim">${escapeHtml(it.primaryName)}</span>
                <span class="op-conj-timeline-tip-arrow">↔</span>
                <span class="op-conj-timeline-tip-sec">${escapeHtml(it.secondary.name || `#${it.secondary.norad_id}`)}</span>
            </div>
            <div class="op-conj-timeline-tip-row2">
                <span class="op-conj-timeline-tip-miss op-conj-timeline-tip-miss-${severityFor(it.secondary.dist_km)}">${it.secondary.dist_km.toFixed(2)} km</span>
                <span>${fmtUtc(it.secondary.tca_ms)} (${fmtAhead(simTimeMs, it.secondary.tca_ms)})</span>
                ${dv}
            </div>
        `;
        tooltip.style.display = 'block';

        // Position the tooltip above the tick; clamp to host bounds
        // so an edge tick doesn't push it offscreen.
        const hostRect = host.getBoundingClientRect();
        const aRect    = anchor.getBoundingClientRect();
        const left     = aRect.left - hostRect.left + (aRect.width / 2);
        const w        = tooltip.offsetWidth || 220;
        const clampedL = Math.max(8, Math.min(hostRect.width - w - 8, left - w / 2));
        tooltip.style.left = `${clampedL}px`;
        // Tooltip sits above the host strip; transform-origin handled in CSS.
        tooltip.style.bottom = `${hostRect.height + 6}px`;
    }

    function hideTip() {
        tooltip.style.display = 'none';
    }

    function fire(it) {
        timeBus.setSimTime(it.secondary.tca_ms, { mode: 'scrub' });
        onSelect(it.primaryId);
        const secondary = tracker?.getSatellite?.(it.secondary.norad_id);
        onConjunction({
            assetName:     it.primaryName,
            assetTle:      it.primaryTle,
            secondaryName: it.secondary.name || `#${it.secondary.norad_id}`,
            secondaryTle:  secondary?.tle ?? null,
            tcaMs:         it.secondary.tca_ms,
            missKm:        it.secondary.dist_km,
            dvKms:         it.secondary.dv_kms,
            missUnit:      it.secondary.miss_unit,
            missVec:       it.secondary.miss_vec,
            vRel:          it.secondary.v_rel,
        });
    }

    // Subscribe to deck row updates and time-bus tick. The bus tick
    // re-runs renderTicks because the moving rangeMs window means
    // tick positions slide leftward (~1 px/sec at default zoom).
    const offRows = deck.subscribeRows((snap) => {
        rebuildFlat(snap);
        renderTicks();
    });

    let busTickFrame = 0;
    const offBus = timeBus.subscribe(() => {
        // Throttle to ~5 Hz; ticks crawl slowly enough that ten
        // frames per second of realignment is a waste.
        busTickFrame++;
        if (busTickFrame % 2 !== 0) return;
        if (flat.length === 0) return;
        repositionTicks();
    });

    function repositionTicks() {
        const { rangeMs } = timeBus.getState();
        const span = rangeMs.end - rangeMs.start;
        host.querySelectorAll('.op-conj-tick[data-tca-ms]').forEach(btn => {
            const tca = Number(btn.dataset.tcaMs);
            const t   = (tca - rangeMs.start) / span;
            if (!Number.isFinite(t) || t < 0 || t > 1) {
                btn.style.display = 'none';
                return;
            }
            btn.style.display = '';
            btn.style.left = `${(t * 100).toFixed(2)}%`;
        });
    }

    return {
        dispose() {
            offRows();
            offBus();
            host.querySelectorAll('.op-conj-tick').forEach(el => el.remove());
            tooltip.remove();
        },
    };
}
