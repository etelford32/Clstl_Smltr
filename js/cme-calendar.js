/**
 * cme-calendar.js — the CME arrival calendar on space-weather.html
 * (fix round 2026-07-22, at the author's direction: "turn the CME
 * propagation chart into a calendar with the arrival times of the
 * events mapped out to the day and time of their occurrence, 30 days
 * rolling into the future, and also include the latest week of
 * activity … linked to the time scrubber above").
 *
 * One month-style grid over a rolling UTC window: the LAST 7 DAYS of
 * activity (visually distinct — the observed band) plus TODAY and the
 * NEXT 30 DAYS of forecast. Each DONKI CME shows twice, honestly
 * labeled: a dim ● on its LAUNCH day (activity record, every CME) and
 * a prominent ⊕ HH:MM chip on its Earth-ARRIVAL day (Earth-directed
 * only). Arrival times prefer the WSA-ENLIL modeled shock arrival the
 * DONKI edge route attaches (`enlil.shock_arrival`); otherwise the
 * SAME drag-based CmeEvent model (Vršnak 2013) the 3D globe propagates
 * with — imported from js/cme-propagation.js, never re-derived. The
 * ensemble P10–P90 arrival span from the ONE shared flux-rope provider
 * run (window.__fluxRopeForecast.summary) shades its days, with the
 * P50 day flagged — again consumed, not recomputed.
 *
 * τ-scrubber contract (two-way, and the only calendar↔Stage coupling):
 *   · click a day or an arrival chip → window.__swStage.setTau(ms) —
 *     the Stage then dispatches 'sw-tau' itself, so dock instruments
 *     stay one-way Stage→dock as documented in js/stage/stage.js;
 *   · 'sw-tau' events move the .cal-cursor day highlight here.
 * The Stage's τ window is [now−7 d … now+30 d] to match this grid.
 *
 * calendarModel() and calendarEvents() are PURE (no DOM, no fetch,
 * explicit nowMs) — node-tested by tests/cme-calendar.mjs. The mount
 * is fail-quiet and feeds ONLY from the page's existing 'swpc-update'
 * bus (recent_cmes rows from js/swpc-feed.js) — no second DONKI fetch.
 * The module keeps its own ledger of rows it has seen so past-week
 * arrivals survive longer than CmePropagator's −48 h retirement.
 */

import { CmeEvent } from './cme-propagation.js';

const DAY = 86_400e3;

function track(action, meta) {
    import('./telemetry.js')
        .then((m) => m.telemetry.recordFeature('sw_dashboard', action, meta))
        .catch(() => {});
}

/** UTC midnight of the day containing ms. */
export function utcMidnight(ms) {
    return Math.floor(ms / DAY) * DAY;
}

const kpToG = (kp) => kp >= 9 ? 5 : kp >= 8 ? 4 : kp >= 7 ? 3
    : kp >= 6 ? 2 : kp >= 5 ? 1 : 0;

/**
 * Map swpc-feed `recent_cmes` rows to calendar events.
 * @param {Array} cmes  rows from js/swpc-feed.js fetchDONKICME:
 *        { time, cme_id?, speed, latitude, longitude, halfAngle,
 *          earthDirected, note, enlil? }
 * @param {object} [opts]
 * @param {number} [opts.vSw]  ambient solar wind speed (km/s) for the DBM
 * @returns {Array<{id, launchMs, arrivalMs, earthDirected, speedKms,
 *                  kpMax, gScale, severity, source, note}>}
 */
export function calendarEvents(cmes, { vSw = 400 } = {}) {
    const out = [];
    for (const c of Array.isArray(cmes) ? cmes : []) {
        const launchMs = c?.time ? Date.parse(c.time) : NaN;
        if (!Number.isFinite(launchMs)) continue;
        const ev = new CmeEvent({
            time: c.time, speed: c.speed, halfAngle: c.halfAngle,
            earthDirected: c.earthDirected, latitude: c.latitude,
            longitude: c.longitude, note: c.note,
        }, vSw);
        const enlilMs = c.enlil?.shock_arrival ? Date.parse(c.enlil.shock_arrival) : NaN;
        const useEnlil = Number.isFinite(enlilMs);
        const enlilKp = Math.max(c.enlil?.kp_90 ?? -1, c.enlil?.kp_135 ?? -1,
            c.enlil?.kp_180 ?? -1);
        const kpMax = enlilKp >= 0 ? enlilKp : ev.impact?.kp_max ?? null;
        const gScale = enlilKp >= 0 ? kpToG(enlilKp) : ev.impact?.g_scale ?? 0;
        out.push({
            id: c.cme_id || c.time,
            launchMs,
            arrivalMs: useEnlil ? enlilMs : ev.arrival_ms,
            earthDirected: !!c.earthDirected,
            speedKms: Math.round(ev.v0),
            kpMax, gScale,
            severity: ev.impact?.severity ?? 'MINOR',
            source: useEnlil ? 'enlil' : 'dbm',
            note: c.note || '',
        });
    }
    return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Build the rolling calendar grid.
 * @param {object} opts
 * @param {Array}  opts.events   calendarEvents() output
 * @param {number} opts.nowMs    explicit clock (UTC ms)
 * @param {object} [opts.span]   ensemble arrival span from the ONE
 *        provider summary: { p10Ms, p50Ms, p90Ms } (any may be absent)
 * @param {number} [opts.pastDays=7]
 * @param {number} [opts.futureDays=30]
 * @returns {{lead:number, days:Array, startMs:number, endMs:number}}
 *   lead    = weekday (0=Sun) of the first cell, for grid alignment
 *   days[i] = { dayMs, iso, dom, monthLabel|null, past, today,
 *               launches: [...], arrivals: [...(+hhmm)],
 *               inSpan, isP50 }
 */
export function calendarModel({ events = [], nowMs, span = null,
                                pastDays = 7, futureDays = 30 }) {
    const todayMs = utcMidnight(nowMs);
    const startMs = todayMs - pastDays * DAY;
    const n = pastDays + futureDays + 1;
    const p10d = Number.isFinite(span?.p10Ms) ? utcMidnight(span.p10Ms) : NaN;
    const p90d = Number.isFinite(span?.p90Ms) ? utcMidnight(span.p90Ms) : NaN;
    const p50d = Number.isFinite(span?.p50Ms) ? utcMidnight(span.p50Ms) : NaN;
    const days = [];
    for (let i = 0; i < n; i++) {
        const dayMs = startMs + i * DAY;
        const d = new Date(dayMs);
        const within = (ms) => Number.isFinite(ms) && ms >= dayMs && ms < dayMs + DAY;
        const arrivals = events
            .filter((e) => e.earthDirected && within(e.arrivalMs))
            .sort((a, b) => a.arrivalMs - b.arrivalMs)
            .map((e) => ({ ...e,
                hhmm: new Date(e.arrivalMs).toISOString().slice(11, 16) }));
        const launches = events
            .filter((e) => within(e.launchMs))
            .sort((a, b) => a.launchMs - b.launchMs);
        days.push({
            dayMs,
            iso: d.toISOString().slice(0, 10),
            dom: d.getUTCDate(),
            monthLabel: (i === 0 || d.getUTCDate() === 1)
                ? MONTHS[d.getUTCMonth()] : null,
            past: dayMs < todayMs,
            today: dayMs === todayMs,
            launches, arrivals,
            inSpan: Number.isFinite(p10d) && Number.isFinite(p90d)
                && dayMs >= p10d && dayMs <= p90d,
            isP50: dayMs === p50d,
        });
    }
    return { lead: new Date(startMs).getUTCDay(), days,
             startMs, endMs: startMs + n * DAY };
}

/* ── Mount (fail-quiet, DOM only below this line) ─────────────────────── */

const CSS = `
#cme-calendar-host { margin-top: 8px; }
.cal-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    margin-bottom: 8px; font-size: .68rem; color: #889; }
.cal-head .cal-hint { color: #667; }
.cal-legend { display: flex; gap: 14px; flex-wrap: wrap; margin-left: auto; }
.cal-legend span { display: inline-flex; align-items: center; gap: 5px; }
.cal-swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.cal-swatch.past { background: rgba(255,215,94,.16); border: 1px solid rgba(255,215,94,.35); }
.cal-swatch.span { background: rgba(79,195,247,.18); border: 1px solid rgba(79,195,247,.4); }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.cal-dow { font-size: .58rem; text-transform: uppercase; letter-spacing: .08em;
    color: #667; text-align: center; padding-bottom: 2px; }
.cal-day { position: relative; min-height: 52px; border-radius: 6px;
    padding: 3px 4px; text-align: left; cursor: pointer;
    background: rgba(255,255,255,.025); border: 1px solid rgba(255,255,255,.06);
    transition: border-color .15s ease; font: inherit; color: inherit; }
.cal-day:hover { border-color: rgba(120,180,240,.45); }
.cal-day.blank { visibility: hidden; pointer-events: none; }
.cal-day.past { background: rgba(255,215,94,.055);
    border-color: rgba(255,215,94,.16); }
.cal-day.today { border-color: rgba(79,201,127,.65);
    box-shadow: 0 0 8px rgba(79,201,127,.18); }
.cal-day.inspan { background: rgba(79,195,247,.08);
    border-color: rgba(79,195,247,.28); }
.cal-day.cursor { outline: 2px solid var(--sw-accent, #4fc3f7); outline-offset: -2px; }
.cal-dom { font-size: .62rem; color: #8a93a4; font-variant-numeric: tabular-nums; }
.cal-day.today .cal-dom { color: #4fc97f; font-weight: 700; }
.cal-mon { font-size: .58rem; color: #667; margin-left: 3px; text-transform: uppercase; }
.cal-dots { position: absolute; top: 4px; right: 5px; display: flex; gap: 2px; }
.cal-dot { width: 5px; height: 5px; border-radius: 50%; background: #776a55; }
.cal-dot.ed { background: #ff8c00; box-shadow: 0 0 4px rgba(255,140,0,.6); }
.cal-ev { display: block; width: 100%; margin-top: 2px; padding: 1px 4px;
    border-radius: 4px; font-size: .6rem; font-weight: 700; text-align: left;
    font-variant-numeric: tabular-nums; cursor: pointer; border: 1px solid;
    background: rgba(0,200,100,.12); color: #00e874; border-color: rgba(0,200,100,.3); }
.cal-ev.g1 { background: rgba(255,200,0,.13); color: #ffcc00; border-color: rgba(255,200,0,.35); }
.cal-ev.g2 { background: rgba(255,140,0,.15); color: #ff9900; border-color: rgba(255,140,0,.4); }
.cal-ev.g3 { background: rgba(255,60,40,.16); color: #ff5544; border-color: rgba(255,60,40,.45); }
.cal-ev.g4, .cal-ev.g5 { background: rgba(255,40,80,.18); color: #ff2266;
    border-color: rgba(255,40,80,.5); }
.cal-ev.pastev { opacity: .65; }
.cal-p50 { display: block; margin-top: 2px; font-size: .56rem; color: #4fc3f7; }
@media (max-width: 768px) {
    .cal-day { min-height: 42px; }
    .cal-legend { margin-left: 0; }
}
`;

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function mountCmeCalendar(hostId = 'cme-calendar-host') {
    if (typeof document === 'undefined') return;
    try {
        const host = document.getElementById(hostId);
        if (!host) return;
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        // Ledger: every feed row seen this visit, keyed by id — DONKI's
        // 7-day lookback plus this retention covers the observed band.
        const ledger = new Map();
        let vSw = 400;
        let span = null;
        let cursorMs = NaN;

        const takeForecast = (fc) => {
            const s = fc?.summary;
            span = (s && !fc.idle) ? { p10Ms: s.arrivalP10Ms, p50Ms: s.arrivalP50Ms,
                                       p90Ms: s.arrivalP90Ms } : null;
        };

        function render() {
            const nowMs = Date.now();
            const events = calendarEvents([...ledger.values()], { vSw });
            const model = calendarModel({ events, nowMs, span });

            // Status pip in the section title: red while an Earth arrival
            // is still ahead, amber when the corridor is clear.
            const pip = document.getElementById('cme-pip');
            if (pip) {
                const hot = events.some((e) => e.earthDirected && e.arrivalMs > nowMs);
                pip.style.background = hot ? '#ff3322' : '#ff6622';
                pip.style.boxShadow = `0 0 ${hot ? 8 : 6}px ${hot ? '#ff3322' : '#ff6622'}`;
            }

            const cells = [];
            cells.push(...DOW.map((d) => `<div class="cal-dow">${d}</div>`));
            for (let i = 0; i < model.lead; i++) {
                cells.push('<button class="cal-day blank" tabindex="-1"></button>');
            }
            for (const day of model.days) {
                const cls = ['cal-day', day.past && 'past', day.today && 'today',
                    day.inSpan && 'inspan',
                    Number.isFinite(cursorMs) && utcMidnight(cursorMs) === day.dayMs && 'cursor',
                ].filter(Boolean).join(' ');
                const dots = day.launches.length ? `<span class="cal-dots">${
                    day.launches.slice(0, 4).map((l) =>
                        `<span class="cal-dot${l.earthDirected ? ' ed' : ''}"
                             title="CME launch ${new Date(l.launchMs).toISOString().slice(0, 16).replace('T', ' ')}Z · ${l.speedKms} km/s${l.earthDirected ? ' · Earth-directed' : ''}"></span>`)
                        .join('')}</span>` : '';
                const chips = day.arrivals.map((a) => {
                    const eta = a.source === 'enlil' ? 'WSA-ENLIL shock arrival'
                        : 'drag-based (DBM) arrival';
                    const kp = Number.isFinite(a.kpMax) ? ` · Kp≈${(+a.kpMax).toFixed(1)}` : '';
                    return `<span class="cal-ev g${a.gScale}${a.arrivalMs < nowMs ? ' pastev' : ''}"
                        data-tau="${a.arrivalMs}"
                        title="⊕ Earth arrival ${new Date(a.arrivalMs).toISOString().slice(0, 16).replace('T', ' ')}Z · ${eta} · ${a.speedKms} km/s${kp} · click to scrub the Stage">⊕ ${a.hhmm}${a.gScale ? ` G${a.gScale}` : ''}</span>`;
                }).join('');
                const p50 = day.isP50 ? '<span class="cal-p50">◈ ensemble P50</span>' : '';
                cells.push(`<button type="button" class="${cls}" data-day="${day.dayMs}"
                    aria-label="${day.iso}${day.arrivals.length ? `, ${day.arrivals.length} CME arrival(s)` : ''}">
                    <span class="cal-dom">${day.dom}</span>${
                        day.monthLabel ? `<span class="cal-mon">${day.monthLabel}</span>` : ''
                    }${dots}${chips}${p50}</button>`);
            }
            host.innerHTML = `
                <div class="cal-head">
                    <span><span class="cal-swatch past"></span> last 7 days · observed</span>
                    <span><span class="cal-swatch span"></span> ensemble P10–P90 arrival</span>
                    <span class="cal-hint">click a day or an ⊕ arrival to scrub the Stage timeline</span>
                </div>
                <div class="cal-grid">${cells.join('')}</div>`;
        }

        // Clicks → the Stage's τ scrubber. The Stage clamps + dispatches
        // 'sw-tau' itself, keeping the dock contract one-way.
        host.addEventListener('click', (e) => {
            const chip = e.target.closest('.cal-ev');
            const day = e.target.closest('.cal-day:not(.blank)');
            const tau = chip ? +chip.dataset.tau
                : day ? +day.dataset.day + DAY / 2 : NaN;
            if (!Number.isFinite(tau)) return;
            if (chip) e.stopPropagation();
            window.__swStage?.setTau?.(tau);
            track('cme_calendar_scrub', { via: chip ? 'arrival' : 'day' });
        });

        // Stage → calendar: follow the scrubber with a day cursor. Cheap
        // class swap, no rebuild.
        window.addEventListener('sw-tau', (e) => {
            const tauMs = e.detail?.tauMs;
            if (!Number.isFinite(tauMs)) return;
            cursorMs = tauMs;
            const want = String(utcMidnight(tauMs));
            host.querySelectorAll('.cal-day').forEach((el) => {
                el.classList.toggle('cursor', el.dataset.day === want);
            });
        });

        window.addEventListener('swpc-update', (e) => {
            const d = e.detail || {};
            if (Number.isFinite(d.solar_wind?.speed)) vSw = d.solar_wind.speed;
            let changed = false;
            for (const c of d.recent_cmes || []) {
                const key = c?.cme_id || c?.time;
                if (!key || ledger.has(key)) continue;
                ledger.set(key, c);
                changed = true;
            }
            // Prune far outside the window so the ledger stays bounded.
            const floor = Date.now() - 40 * DAY;
            for (const [k, c] of ledger) {
                if (Date.parse(c.time) < floor) { ledger.delete(k); changed = true; }
            }
            if (changed) render();
        });
        window.addEventListener('flux-rope-forecast', (ev) => {
            takeForecast(ev.detail);
            render();
        });
        if (window.__fluxRopeForecast) takeForecast(window.__fluxRopeForecast);

        render();
        // Midnight rollover + past-arrival restyling.
        setInterval(render, 10 * 60e3);
    } catch (e) {
        console.warn('[cme-calendar] mount failed (non-fatal):', e);
    }
}
