/**
 * ssw-verification.js — SSW forecast track-record card
 * ═══════════════════════════════════════════════════════════════════════════
 * Loads data/ssw-events.json (historical SSW log + the regime our
 * combiner *would have* classified each one as), then for every
 * event calls /api/weather/ssw-verify to score it against ERA5
 * surface temperatures. Renders a compact track record:
 *
 *   • per-event row — date, predicted regime, verdict (verified /
 *     partial / falsified / ambiguous), regional anomalies on hover
 *   • rollup at the top — "X of Y events verified, hit rate Z%"
 *
 * The card is the operational answer to "do our forecasts work?" —
 * every verified entry is one more brick in the dashboard's
 * credibility, and every falsified entry forces the combiner thresholds
 * to be revisited rather than rationalised away.
 */

const VERDICT_COLORS = {
    verified:      '#88e08c',
    partial:       '#ffcc66',
    ambiguous:     '#778',
    falsified:     '#ff5577',
    no_prediction: '#556',
    no_data:       '#445',
    pending:       '#445',
};

const VERDICT_BADGE = {
    verified:      'badge-minor',
    partial:       'badge-moderate',
    ambiguous:     'badge-minor',
    falsified:     'badge-severe',
    no_prediction: 'badge-minor',
    no_data:       'badge-minor',
    pending:       'badge-minor',
};

const REFRESH_MS = 24 * 60 * 60 * 1000;   // 24 h — events rarely change

export class SSWVerificationCard {
    constructor(opts = {}) {
        this.eventsPath  = opts.eventsPath  ?? '/data/ssw-events.json';
        this.verifyPath  = opts.verifyPath  ?? '/v1/weather/ssw-verify';
        this.maxRender   = opts.maxRender   ?? 6;
        this._timer = null;
        this._abort = null;
    }

    start() {
        this.refresh();
        this._timer = setInterval(() => this.refresh(), REFRESH_MS);
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
        this._abort?.abort();
    }

    async refresh() {
        this._abort?.abort();
        const ctl = new AbortController();
        this._abort = ctl;

        const list = document.getElementById('ssw-event-list');
        if (!list) return;

        try {
            const log = await this._loadLog(ctl.signal);
            if (this._abort !== ctl) return;
            const events = (log.events || []).slice().reverse().slice(0, this.maxRender);
            this._renderSkeleton(events);
            // Verify each event in parallel — they're cheap and edge-cached.
            const verdicts = await Promise.all(
                events.map(e => this._verifyOne(e.id, ctl.signal)));
            if (this._abort !== ctl) return;
            this._render(events, verdicts);
        } catch (err) {
            if (err.name === 'AbortError') return;
            this._renderError(err);
        }
    }

    async _loadLog(signal) {
        const res = await fetch(this.eventsPath, {
            signal,
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`event log HTTP ${res.status}`);
        return res.json();
    }

    async _verifyOne(id, signal) {
        try {
            const res = await fetch(`${this.verifyPath}?id=${encodeURIComponent(id)}`, {
                signal,
                headers: { Accept: 'application/json' },
            });
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            return null;
        }
    }

    _renderSkeleton(events) {
        const list = document.getElementById('ssw-event-list');
        list.innerHTML = events.map(e => `
            <div class="ssw-row" data-id="${esc(e.id)}">
                <span class="ssw-date">${esc(e.date)}</span>
                <span class="ssw-regime" style="color:#aac">${esc(e.predicted_regime || '—')}</span>
                <span class="ssw-outcome">${esc(e.outcome_label || '—')}</span>
                <span class="cme-card-badge badge-minor ssw-verdict">…</span>
            </div>
        `).join('');
    }

    _render(events, verdicts) {
        const list = document.getElementById('ssw-event-list');
        let verified = 0, scored = 0, anomalySum = 0, anomalyCount = 0;

        list.innerHTML = events.map((e, i) => {
            const v = verdicts[i];
            const status = v?.verdict ?? 'pending';
            const colour = VERDICT_COLORS[status] || VERDICT_COLORS.pending;
            const badge  = VERDICT_BADGE[status] || 'badge-minor';
            const label  = v?.verdict_label || _statusLabel(status);
            const score  = Number.isFinite(v?.score_pct) ? `${v.score_pct}%` : '';

            if (v && status !== 'no_prediction' && status !== 'no_data') {
                scored++;
                if (status === 'verified' || status === 'partial') verified++;
                for (const r of v.regions || []) {
                    if (Number.isFinite(r.anomaly_C)) {
                        anomalySum += r.anomaly_C;
                        anomalyCount++;
                    }
                }
            }

            const anomBits = (v?.regions || [])
                .filter(r => Number.isFinite(r.anomaly_C))
                .map(r => `${r.region}: ${r.anomaly_C > 0 ? '+' : ''}${r.anomaly_C} °C`)
                .join('\n');
            const tooltip = [
                e.outcome_label || '',
                e.notes || '',
                anomBits ? `\nAnomalies vs −14d baseline:\n${anomBits}` : '',
                v?.verdict_note ? `\n${v.verdict_note}` : '',
            ].filter(Boolean).join('\n');

            return `
                <div class="ssw-row" title="${esc(tooltip)}" data-id="${esc(e.id)}">
                    <span class="ssw-date">${esc(e.date)}</span>
                    <span class="ssw-regime" style="color:${colour}">
                        ${esc(e.predicted_regime || '—')}
                    </span>
                    <span class="ssw-outcome">${esc(e.outcome_label || '')}</span>
                    <span class="cme-card-badge ${badge} ssw-verdict"
                          style="color:${colour}">${esc(label)}${score ? ' · ' + score : ''}</span>
                </div>
            `;
        }).join('');

        // Rollup line.
        const hitRate = scored > 0 ? Math.round((verified / scored) * 100) : null;
        const meanAnom = anomalyCount > 0 ? (anomalySum / anomalyCount) : null;
        const setText = (id, txt, c) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = txt;
            if (c) el.style.color = c;
        };
        setText('ssw-hit-rate',
            scored > 0 ? `${verified}/${scored}` : '—',
            scored > 0 && hitRate >= 50 ? VERDICT_COLORS.verified : null);
        setText('ssw-pct',
            hitRate != null ? `${hitRate}%` : '—');
        setText('ssw-mean-anom',
            Number.isFinite(meanAnom)
                ? `${meanAnom > 0 ? '+' : ''}${meanAnom.toFixed(1)} °C`
                : '—');
    }

    _renderError(err) {
        const list = document.getElementById('ssw-event-list');
        if (list) list.innerHTML = `<div style="color:#778;font-size:.75rem;padding:8px">
            Verification feed unavailable (${esc(err.message)}). Retrying in 24 h.
        </div>`;
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _statusLabel(status) {
    if (status === 'no_prediction') return 'no fc';
    if (status === 'no_data')       return 'no data';
    if (status === 'pending')       return 'verifying…';
    return status;
}

function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[c]);
}
