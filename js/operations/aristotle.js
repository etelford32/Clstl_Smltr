/**
 * aristotle.js — Daily-conjunction feed panel for the Operations console.
 *
 * Pulls the rebranded SOCRATES report from /api/celestrak/aristotle and
 * renders the top conjunctions sorted by minimum range. Each row is
 * clickable: clicking the primary or secondary NORAD jumps the visuals
 * module to that asset (when it exists in the loaded catalog) so the
 * operator can correlate the table entry with what's drawn on the globe.
 *
 * Data source: CelesTrak SOCRATES, refreshed every ~12 h upstream. We
 * poll once an hour client-side; the edge cache absorbs anything more
 * frequent than that.
 *
 * Naming note: the upstream feed is "SOCRATES" but that name has been
 * adopted by an unrelated LLM product. We call it "Aristotle" in the
 * UI to keep the operator nomenclature unambiguous; provenance still
 * attributes to CelesTrak SOCRATES.
 */

import { provStore } from './provenance.js';

const REFRESH_MS = 60 * 60 * 1000;   // 1 hour
const ENDPOINT   = '/api/celestrak/aristotle?sort=range&limit=25';

let _root        = null;
let _timer       = null;
let _onSelect    = null;       // (noradId) => void — wired by operations.html
let _lastFetched = null;

/**
 * Mount the Aristotle panel. Pass a click handler so a row click can
 * select the asset in the globe / decision deck. Returns a stop()
 * function that cancels the refresh timer (handy for tests / unmount).
 */
export function mountAristotle(rootEl, opts = {}) {
    _root = rootEl;
    _onSelect = opts.onSelect ?? null;
    if (!_root) return () => {};

    _root.innerHTML = `<div class="op-deck-empty">Loading conjunction feed…</div>`;
    refresh();
    _timer = setInterval(refresh, REFRESH_MS);

    return () => {
        if (_timer) clearInterval(_timer);
        _timer = null;
    };
}

/** Force a re-fetch (e.g. from a refresh button). */
export async function refresh() {
    if (!_root) return;
    try {
        const res = await fetch(ENDPOINT);
        const data = await res.json();
        if (!res.ok || data.error) {
            renderError(data.error || `HTTP ${res.status}`, data.detail);
            return;
        }
        _lastFetched = data.fetched;
        renderRows(data);
        // Provenance: bind the conjunction count so the data dictionary
        // export captures Aristotle's contribution. Source attribution
        // stays on CelesTrak SOCRATES — Aristotle is the consumer, not
        // a different upstream.
        provStore.set('aristotle.conjunctions.count', {
            value: data.conjunctions.length,
            unit:  'conjunctions',
            source: 'CelesTrak SOCRATES via /api/celestrak/aristotle',
            model:  'SOCRATES pairwise SGP4 (~12 h cadence)',
            validAt: data.fetched,
            cacheState: 'live',
            description: 'Daily worst-case conjunctions from CelesTrak SOCRATES, '
                       + 'sorted by minimum range. Refreshed hourly client-side; '
                       + '12 h refresh upstream.',
        });
    } catch (err) {
        renderError(err.message);
    }
}

/* ─── Rendering ─────────────────────────────────────────────────────── */

function renderError(msg, detail) {
    if (!_root) return;
    const detailHtml = detail
        ? Array.isArray(detail)
            ? `<ul style="margin:6px 0 0 14px;font-size:.7rem;color:#aab">
                 ${detail.map(d => `<li>${esc(d.group ?? d.name ?? d)}: ${esc(d.error ?? d.status ?? '')}</li>`).join('')}
               </ul>`
            : `<div style="color:#aab;font-size:.7rem;margin-top:4px">${esc(String(detail))}</div>`
        : '';
    _root.innerHTML = `
        <div class="op-deck-empty" style="color:#f88">
            <b>Aristotle feed unavailable.</b>
            <div style="font-family:monospace;font-size:.7rem;margin-top:4px">${esc(msg)}</div>
            ${detailHtml}
            <button class="op-deck-btn" style="margin-top:8px" data-aristotle-retry>Retry</button>
        </div>`;
    _root.querySelector('[data-aristotle-retry]')
        ?.addEventListener('click', () => refresh());
}

function renderRows(data) {
    if (!_root) return;
    const rows = data.conjunctions ?? [];

    if (rows.length === 0) {
        const warn = data.warning === 'parser-no-rows'
            ? `<div style="color:#fc6;font-size:.7rem;margin-top:6px">
                 SOCRATES returned ${data.rawHtmlBytes ?? '?'} bytes but the parser found no rows —
                 the upstream HTML format may have changed. The endpoint still works;
                 update <code>api/celestrak/aristotle.js parseSocratesHtml()</code>.
               </div>`
            : '';
        _root.innerHTML = `<div class="op-deck-empty">No conjunctions in current report.${warn}</div>`;
        return;
    }

    const ageMin = _lastFetched
        ? Math.max(0, Math.round((Date.now() - new Date(_lastFetched).getTime()) / 60000))
        : null;
    const ageStr = ageMin == null
        ? '—'
        : ageMin < 1 ? 'just now'
        : ageMin < 60 ? `${ageMin} min ago`
        : `${Math.round(ageMin / 60)} h ago`;

    let html = `
        <div style="display:flex;justify-content:space-between;align-items:baseline;
                    font-size:.66rem;color:#778;margin-bottom:6px;font-family:monospace">
            <span>top ${rows.length} by min range</span>
            <span title="Last fetched ${esc(_lastFetched ?? '')}">fetched ${ageStr}</span>
        </div>
        <table class="op-aristotle-tbl">
            <thead>
                <tr>
                    <th>Primary</th><th>Secondary</th>
                    <th title="Time of closest approach (UTC)">TCA</th>
                    <th title="Minimum range at TCA">Range</th>
                    <th title="Relative velocity at TCA">v_rel</th>
                </tr>
            </thead>
            <tbody>`;

    for (const c of rows) {
        const tcaShort = formatTcaShort(c.tca);
        const rangeColor = c.minRangeKm < 1 ? '#f55'
                         : c.minRangeKm < 5 ? '#fa6' : '#ddd';
        html += `
            <tr data-aristotle-row>
                <td>
                    <span class="op-aristotle-link" data-norad="${c.primary.norad}"
                          title="NORAD ${c.primary.norad}">${esc(c.primary.name)}</span>
                </td>
                <td>
                    <span class="op-aristotle-link" data-norad="${c.secondary.norad}"
                          title="NORAD ${c.secondary.norad}">${esc(c.secondary.name)}</span>
                </td>
                <td style="font-family:monospace;font-size:.66rem;color:#9ab">${tcaShort}</td>
                <td style="font-family:monospace;color:${rangeColor};text-align:right">
                    ${c.minRangeKm.toFixed(3)} km
                </td>
                <td style="font-family:monospace;text-align:right;color:#aab">
                    ${c.relVelKmS.toFixed(2)} km/s
                </td>
            </tr>`;
    }
    html += `</tbody></table>`;

    _root.innerHTML = html;
    _root.querySelectorAll('.op-aristotle-link').forEach(el => {
        el.addEventListener('click', (ev) => {
            ev.preventDefault();
            const id = +el.dataset.norad;
            if (_onSelect && Number.isFinite(id)) _onSelect(id);
        });
    });
}

function formatTcaShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // "Apr 30 12:34Z" — compact for the narrow column.
    const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const pad = (n) => String(n).padStart(2, '0');
    return `${mons[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    }[c]));
}
