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

/* ── Prediction scorecard (validation program §2–3 consumers) ─────────
   Pure models over /api/cme/skill responses: the per-model skill strip
   and the per-event predicted-vs-actual index the arrival chips render.
   Sign convention everywhere: predicted − actual, + = predicted LATE
   (matches cme_model_skill.bias_hours). Node-tested. */

/** Skill-view rows → display rows, best MAE first. Realtime rows are the
 *  product; hindcast-only is labeled as such, never passed off as live. */
export function scorecardModel(models) {
    const scored = (models || []).filter((m) => (m.n_scored | 0) > 0);
    const rt = scored.filter((m) => m.is_hindcast !== true);
    const use = rt.length ? rt : scored;
    const label = (id) => id === 'dbm-v1' ? 'DBM'
        : id === 'ballistic-v1' ? 'Ballistic' : String(id).toUpperCase();
    const rows = use.map((m) => ({
        modelId: m.model_id, label: label(m.model_id),
        n: m.n_scored | 0,
        maeH: Number.isFinite(+m.mae_hours) ? +m.mae_hours : null,
        biasH: Number.isFinite(+m.bias_hours) ? +m.bias_hours : null,
        hitRate: (m.n_scored | 0) ? (m.hits_12h | 0) / (m.n_scored | 0) : null,
        falseAlarms: m.false_alarms | 0,
        misses: m.misses | 0,
    })).sort((a, b) => (a.maeH ?? 1e9) - (b.maeH ?? 1e9));
    return { rows, hindcastOnly: !rt.length && scored.length > 0, empty: !use.length };
}

/** /api/cme/skill events → Map(donki_id → {resolved, arrived, actualMs,
 *  models:{model_id → predictedMs}}) for chip annotation. */
export function validationIndex(valEvents) {
    const map = new Map();
    for (const ev of valEvents || []) {
        if (!ev?.donki_id) continue;
        const models = {};
        for (const [m, f] of Object.entries(ev.forecasts || {})) {
            const p = Date.parse(f?.predicted);
            if (Number.isFinite(p)) models[m] = p;
        }
        map.set(ev.donki_id, {
            resolved: !!ev.truth,
            arrived: ev.truth?.arrived === true,
            actualMs: ev.truth?.shock ? Date.parse(ev.truth.shock) : NaN,
            models,
        });
    }
    return map;
}

/** Signed timing error, predicted − actual: '+2.9 h' = predicted late. */
export function fmtErrH(predMs, actualMs) {
    const d = (predMs - actualMs) / 3.6e6;
    return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} h`;
}

/** Countdown text for the next-arrival chip. */
export function fmtCountdown(dtMs) {
    if (!(dtMs > 0)) return 'now';
    const h = dtMs / 3.6e6;
    return h < 48 ? `in ${Math.round(h)} h` : `in ${(h / 24).toFixed(1)} d`;
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
/* minmax(0,1fr): chip content must never widen a column — on mobile the
   unequal columns squeezed empty days to slivers (2026-07-23 review). */
.cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.cal-dow { font-size: .58rem; text-transform: uppercase; letter-spacing: .08em;
    color: #667; text-align: center; padding-bottom: 2px; }
.cal-day { position: relative; min-height: 52px; min-width: 0; border-radius: 6px;
    padding: 3px 4px; text-align: left; cursor: pointer;
    background: rgba(255,255,255,.025); border: 1px solid rgba(255,255,255,.06);
    transition: border-color .15s ease; font: inherit; color: inherit; }
.cal-day:hover { border-color: rgba(120,180,240,.45); }
.cal-day.blank { visibility: hidden; pointer-events: none; }
.cal-day.past { background: rgba(255,215,94,.09);
    border-color: rgba(255,215,94,.24); }
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
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: rgba(0,200,100,.12); color: #00e874; border-color: rgba(0,200,100,.3); }
.cal-ev.g1 { background: rgba(255,200,0,.13); color: #ffcc00; border-color: rgba(255,200,0,.35); }
.cal-ev.g2 { background: rgba(255,140,0,.15); color: #ff9900; border-color: rgba(255,140,0,.4); }
.cal-ev.g3 { background: rgba(255,60,40,.16); color: #ff5544; border-color: rgba(255,60,40,.45); }
.cal-ev.g4, .cal-ev.g5 { background: rgba(255,40,80,.18); color: #ff2266;
    border-color: rgba(255,40,80,.5); }
.cal-ev.pastev { opacity: .65; }
.cal-ev.scored s { opacity: .6; font-weight: 500; }
.cal-ev.scored .cal-act { font-weight: 800; }
.cal-ev.scored .cal-err { margin-left: 3px; font-size: .56rem; opacity: .9; }
.cal-ev.hit { border-style: solid; }
.cal-ev.falarm { background: rgba(140,140,160,.12); color: #99a;
    border-color: rgba(140,140,160,.35); text-decoration: none; }
.cal-count { display: inline-block; margin-left: 4px; padding: 0 4px;
    border-radius: 3px; background: rgba(79,195,247,.18); color: #7fd4ff;
    font-size: .56rem; font-weight: 700; }
.cal-p50 { display: block; margin-top: 2px; font-size: .56rem; color: #4fc3f7; }
.cal-quiet { grid-column: 1 / -1; text-align: center; padding: 10px 0 2px;
    font-size: .74rem; color: #667; }
/* ── Skill strip (the live forward ledger — hindcast receipts live in
      the separate D3 scorecard panel) ─────────────────────────────── */
.cal-skill { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    margin: 10px 0 2px; }
.cal-skill-title { font-size: .62rem; text-transform: uppercase;
    letter-spacing: .08em; color: #889; }
.cal-skill-chip { display: inline-flex; gap: 5px; align-items: baseline;
    padding: 3px 8px; border-radius: 6px; font-size: .68rem;
    font-variant-numeric: tabular-nums;
    background: rgba(84,224,138,.07); border: 1px solid rgba(84,224,138,.22);
    color: #9be9b4; }
.cal-skill-chip b { color: #d6ffe2; }
.cal-skill-chip .k { color: #6a8; font-size: .6rem; }
.cal-skill-arming { font-size: .7rem; color: #778; }
.cal-skill-note { flex-basis: 100%; font-size: .6rem; color: #556; }
@media (max-width: 768px) {
    .cal-day { min-height: 42px; }
    .cal-legend { margin-left: 0; }
}
/* ── Motion (entrance stagger, today pulse, next-arrival glow) — all
      behind prefers-reduced-motion; re-renders don't replay the
      entrance (the .cal-animate class is first-paint only) ────────── */
@media (prefers-reduced-motion: no-preference) {
    .cal-animate .cal-day { opacity: 0;
        animation: calIn .38s ease forwards;
        animation-delay: calc(var(--i, 0) * 14ms); }
    @keyframes calIn { from { opacity: 0; transform: translateY(6px); }
                       to { opacity: 1; transform: none; } }
    .cal-day { transition: transform .15s ease, border-color .15s ease; }
    .cal-day:hover { transform: translateY(-1px); }
    .cal-day.today { animation: calToday 2.6s ease-in-out infinite; }
    @keyframes calToday {
        0%, 100% { box-shadow: 0 0 8px rgba(79,201,127,.18); }
        50%      { box-shadow: 0 0 14px rgba(79,201,127,.38); } }
    .cal-ev.next { animation: calNext 2s ease-in-out infinite; }
    @keyframes calNext {
        0%, 100% { box-shadow: 0 0 0 rgba(255,140,0,0); }
        50%      { box-shadow: 0 0 9px rgba(255,140,0,.5); } }
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
        let firstPaint = true;
        let nextArrivalMs = NaN;
        // The prediction-correctness ledger (/api/cme/skill): per-model
        // skill strip + per-event predicted-vs-actual chip annotations.
        let validation = { models: [], byId: new Map() };
        async function fetchSkill() {
            try {
                const res = await fetch('/api/cme/skill');
                if (!res.ok) return;
                const j = await res.json();
                validation = {
                    models: j?.data?.models || [],
                    byId: validationIndex(j?.data?.events || []),
                };
                render();
            } catch {}
        }

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

            // The NEXT upcoming Earth arrival gets the countdown chip.
            nextArrivalMs = events
                .filter((e) => e.earthDirected && e.arrivalMs > nowMs)
                .reduce((m, e) => (e.arrivalMs < m ? e.arrivalMs : m), Infinity);
            if (!Number.isFinite(nextArrivalMs)) nextArrivalMs = NaN;

            const cells = [];
            cells.push(...DOW.map((d) => `<div class="cal-dow">${d}</div>`));
            for (let i = 0; i < model.lead; i++) {
                cells.push('<button class="cal-day blank" tabindex="-1"></button>');
            }
            let ci = 0;
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
                    const v = validation.byId.get(a.id);
                    // Locked issue-time forecasts (the predictor's receipt,
                    // visible BEFORE truth resolves): per-model ETAs.
                    const locked = v && Object.keys(v.models).length
                        ? ' · locked: ' + Object.entries(v.models).map(([m, ms]) =>
                            `${m} ${new Date(ms).toISOString().slice(5, 16).replace('T', ' ')}Z`).join(' · ')
                        : '';
                    const replayNote = ' · click: scrub + REPLAY this event in the corridor';
                    // Resolved truth rewrites the chip: predicted struck
                    // through, actual bold, signed error (+ = we were late).
                    if (v?.resolved && v.arrived && Number.isFinite(v.actualMs)) {
                        const err = fmtErrH(a.arrivalMs, v.actualMs);
                        const hit = Math.abs(a.arrivalMs - v.actualMs) <= 12 * 3.6e6;
                        const actual = new Date(v.actualMs).toISOString().slice(11, 16);
                        return `<span class="cal-ev scored g${a.gScale}${hit ? ' hit' : ''}"
                            data-tau="${v.actualMs}" data-cme-id="${a.id}"
                            title="Predicted ${new Date(a.arrivalMs).toISOString().slice(0, 16).replace('T', ' ')}Z (${eta}) · observed shock ${new Date(v.actualMs).toISOString().slice(0, 16).replace('T', ' ')}Z · error ${err} (+ = forecast late) · ${hit ? 'HIT ≤12 h' : 'outside the 12 h hit window'}${locked}${replayNote}"><s>${a.hhmm}</s> <span class="cal-act">${actual}</span><span class="cal-err">${err}</span></span>`;
                    }
                    if (v?.resolved && !v.arrived) {
                        return `<span class="cal-ev falarm" data-tau="${a.arrivalMs}" data-cme-id="${a.id}"
                            title="Predicted ${new Date(a.arrivalMs).toISOString().slice(0, 16).replace('T', ' ')}Z (${eta}) — NO shock arrived (L1 data covered the window). Logged as a false alarm against the model.${locked}${replayNote}">✗ ${a.hhmm} no arrival</span>`;
                    }
                    const isNext = a.arrivalMs === nextArrivalMs;
                    return `<span class="cal-ev g${a.gScale}${a.arrivalMs < nowMs ? ' pastev' : ''}${isNext ? ' next' : ''}"
                        data-tau="${a.arrivalMs}" data-cme-id="${a.id}"
                        title="⊕ Earth arrival ${new Date(a.arrivalMs).toISOString().slice(0, 16).replace('T', ' ')}Z · ${eta} · ${a.speedKms} km/s${kp}${locked}${replayNote}">${
                        v && Object.keys(v.models).length ? '🔒' : '⊕'} ${a.hhmm}${a.gScale ? ` G${a.gScale}` : ''}${
                        isNext ? `<span class="cal-count">${fmtCountdown(a.arrivalMs - nowMs)}</span>` : ''}</span>`;
                }).join('');
                const p50 = day.isP50 ? '<span class="cal-p50">◈ ensemble P50</span>' : '';
                cells.push(`<button type="button" class="${cls}" style="--i:${ci++}" data-day="${day.dayMs}"
                    aria-label="${day.iso}${day.arrivals.length ? `, ${day.arrivals.length} CME arrival(s)` : ''}">
                    <span class="cal-dom">${day.dom}</span>${
                        day.monthLabel ? `<span class="cal-mon">${day.monthLabel}</span>` : ''
                    }${dots}${chips}${p50}</button>`);
            }
            // Quiet-corridor honesty: an empty grid must read as QUIET,
            // not broken (author feedback 2026-07-22: "it looks empty").
            const anyEvents = events.length > 0;
            const quiet = anyEvents ? '' : `<div class="cal-quiet">☀ No CMEs in the
                DONKI catalog this week — the corridor is quiet. Launches and
                arrivals appear here the moment NASA logs an analysis; every
                Earth-directed forecast below is scored after passage.</div>`;

            // Skill strip: the LIVE forward ledger (per-model MAE/bias from
            // issue-time-locked forecasts). Hindcast receipts stay on the
            // separate D3 validation card.
            const sc = scorecardModel(validation.models);
            const fmtBias = (b) => b == null ? '' :
                ` <span class="k">bias</span> <b>${b >= 0 ? '+' : '−'}${Math.abs(b).toFixed(1)} h</b>`;
            // Even with zero SCORED events, locked forecasts are evidence
            // the predictor is running — count them (author feedback
            // 2026-07-23: "the predictor isn't working" when it was arming).
            let lockedEvents = 0;
            for (const v of validation.byId.values()) {
                if (Object.keys(v.models).length) lockedEvents++;
            }
            const skillChips = sc.empty
                ? `<span class="cal-skill-arming">${lockedEvents
                    ? `${lockedEvents} event forecast${lockedEvents > 1 ? 's' : ''} locked
                       (🔒 on the chips) — scored against the observed shock after passage`
                    : `ledger arming — every forecast is locked at issue time;
                       per-model skill appears as events resolve`}</span>`
                : sc.rows.map((r) => `<span class="cal-skill-chip"
                    title="${r.label}: mean |arrival error| over ${r.n} scored event(s)${
                        r.biasH != null ? ` · mean signed error ${r.biasH >= 0 ? '+' : ''}${r.biasH.toFixed(1)} h (+ = late)` : ''}${
                        r.hitRate != null ? ` · ${Math.round(r.hitRate * 100)}% within ±12 h` : ''}${
                        r.falseAlarms ? ` · ${r.falseAlarms} false alarm(s)` : ''}">
                    <b>${r.label}</b>${r.maeH != null
                        ? ` <span class="k">MAE</span> <b>${r.maeH.toFixed(1)} h</b>` : ''}${
                    fmtBias(r.biasH)} <span class="k">·</span> ${r.n} ev</span>`).join('');
            const strip = `<div class="cal-skill">
                <span class="cal-skill-title">Prediction scorecard${sc.hindcastOnly ? ' · hindcast' : ''}</span>
                ${skillChips}
                <span class="cal-skill-note">skill shown, not claimed — forecasts are
                    locked before arrival and scored against the observed L1 shock;
                    struck-through times were our call, bold is what happened</span>
            </div>`;

            host.innerHTML = `
                <div class="cal-head">
                    <span><span class="cal-swatch past"></span> last 7 days · observed</span>
                    <span><span class="cal-swatch span"></span> ensemble P10–P90 arrival</span>
                    <span class="cal-hint">click a day or an ⊕ arrival to scrub the Stage timeline</span>
                </div>
                <div class="cal-grid">${cells.join('')}${quiet}</div>
                ${strip}`;
            // Entrance stagger runs on the FIRST paint only — re-renders
            // (feed refreshes) must not replay it.
            if (firstPaint) {
                firstPaint = false;
                host.classList.add('cal-animate');
                setTimeout(() => host.classList.remove('cal-animate'), 1500);
            }
        }

        // Clicks → the Stage's τ scrubber; an ⊕ ARRIVAL chip additionally
        // LOADS that event into the canvas ('sw-replay-cme' → the page's
        // ONE flux-rope provider re-runs seeded with it and republishes,
        // so the Stage rope + particle cloud + band + this calendar's
        // cursor all time-travel together). The Stage clamps + dispatches
        // 'sw-tau' itself, keeping the dock contract one-way.
        host.addEventListener('click', (e) => {
            const chip = e.target.closest('.cal-ev');
            const day = e.target.closest('.cal-day:not(.blank)');
            const tau = chip ? +chip.dataset.tau
                : day ? +day.dataset.day + DAY / 2 : NaN;
            if (!Number.isFinite(tau)) return;
            if (chip) e.stopPropagation();
            window.__swStage?.setTau?.(tau);
            const row = chip?.dataset.cmeId ? ledger.get(chip.dataset.cmeId) : null;
            if (row?.earthDirected) {
                window.dispatchEvent(new CustomEvent('sw-replay-cme',
                    { detail: { cme: row } }));
            }
            track('cme_calendar_scrub',
                { via: chip ? 'arrival' : 'day', replay: !!row });
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
        fetchSkill();
        // Midnight rollover, past-arrival restyling, fresh skill rows.
        setInterval(() => { render(); fetchSkill(); }, 10 * 60e3);
        // Countdown ticks WITHOUT rebuilding the grid; crossing zero
        // triggers a real re-render (the chip becomes a past arrival).
        setInterval(() => {
            if (!Number.isFinite(nextArrivalMs)) return;
            const dt = nextArrivalMs - Date.now();
            if (dt <= 0) { render(); return; }
            host.querySelectorAll('.cal-count').forEach((el) => {
                el.textContent = fmtCountdown(dt);
            });
        }, 30e3);
    } catch (e) {
        console.warn('[cme-calendar] mount failed (non-fatal):', e);
    }
}
