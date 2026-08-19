// cme-forecast-page.js — operational forecast ledger for cme-forecast.html.
//
// This page is intentionally a CONSUMER of /api/cme/skill. It never reruns
// the forecast physics in the browser and never substitutes a demo prediction:
// every plotted window is the issue-locked record that can later be scored
// against L1 truth.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const REFRESH_MS = 5 * 60 * 1000;

const RANGE_CONFIG = Object.freeze({
    '48h': { pastMs: 12 * HOUR_MS, futureMs: 48 * HOUR_MS },
    '7d': { pastMs: 24 * HOUR_MS, futureMs: 6 * DAY_MS },
    '30d': { pastMs: 23 * DAY_MS, futureMs: 7 * DAY_MS },
});

const state = {
    events: [],
    models: [],
    range: '7d',
    selectedId: null,
    calendarStartMs: null,
    selectedDayMs: null,
    updatedAt: null,
    hitAreas: [],
    refreshTimer: null,
    clockTimer: null,
    resizeObserver: null,
};

const $ = (id) => document.getElementById(id);

function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function time(value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

function esc(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function pickForecast(forecasts = {}) {
    if (forecasts['flux-rope-v1']) return ['flux-rope-v1', forecasts['flux-rope-v1']];
    // This is Parker's public output, not a generic model browser. Baselines
    // belong in the skill comparison below and must never be plotted as if
    // Parker issued them.
    return [null, null];
}

/** Convert the public skill payload into one stable chart shape. */
export function normalizeCmePayload(payload) {
    const root = payload?.data ?? payload ?? {};
    const events = (Array.isArray(root.events) ? root.events : []).flatMap((event) => {
        const [modelId, forecast] = pickForecast(event?.forecasts);
        if (!forecast || !modelId) return [];

        const predictedMs = time(forecast.predicted);
        if (predictedMs === null) return [];
        const earlyMs = time(forecast.early) ?? predictedMs - 6 * HOUR_MS;
        const lateMs = time(forecast.late) ?? predictedMs + 6 * HOUR_MS;
        const truthShockMs = time(event?.truth?.shock);

        return [{
            id: String(event.event_id ?? event.donki_id ?? `cme-${predictedMs}`),
            donkiId: event.donki_id ? String(event.donki_id) : null,
            launchMs: time(event.launch),
            modelId,
            issuedMs: time(forecast.issued_at),
            predictedMs,
            earlyMs: Math.min(earlyMs, lateMs),
            lateMs: Math.max(earlyMs, lateMs),
            pHit: finite(forecast.p_hit),
            p10: finite(forecast.p10),
            p20: finite(forecast.p20),
            minBzP50: finite(forecast.min_bz_p50),
            minBzP5: finite(forecast.min_bz_p5),
            kpMax: finite(forecast.kp_max),
            speedKms: finite(event.speed_kms ?? forecast.v_l1),
            nTrain: finite(forecast.n_train),
            flare: forecast.flare ?? null,
            truth: event.truth ?? null,
            truthShockMs,
        }];
    }).sort((a, b) => a.predictedMs - b.predictedMs);

    return {
        events,
        models: Array.isArray(root.models) ? root.models : [],
        updatedAt: time(root.updated),
    };
}

function shortId(event) {
    if (event.flare?.class) return `${event.flare.class}${event.flare.region ? ` · AR${event.flare.region}` : ''}`;
    const raw = event.donkiId ?? event.id;
    return raw.length > 18 ? `${raw.slice(0, 15)}…` : raw;
}

function formatUtc(ms, options = {}) {
    if (!Number.isFinite(ms)) return 'Not available';
    const date = new Date(ms);
    const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const day = date.getUTCDate();
    const hour = String(date.getUTCHours()).padStart(2, '0');
    const minute = String(date.getUTCMinutes()).padStart(2, '0');
    if (options.dateOnly) return `${month} ${day}`;
    return `${month} ${day} · ${hour}:${minute} UTC`;
}

function formatCompactUtc(ms) {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    return `${month} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}Z`;
}

function utcDayStart(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function dayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

function formatDayHeading(ms) {
    return new Date(ms).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
}

function formatTimeOnlyUtc(ms) {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function formatCalendarRange(startMs) {
    const endMs = startMs + 6 * DAY_MS;
    const start = new Date(startMs);
    const end = new Date(endMs);
    const startMonth = start.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const endMonth = end.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    if (start.getUTCFullYear() !== end.getUTCFullYear()) {
        return `${startMonth} ${start.getUTCDate()}, ${start.getUTCFullYear()} – ${endMonth} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
    }
    if (start.getUTCMonth() !== end.getUTCMonth()) {
        return `${startMonth} ${start.getUTCDate()} – ${endMonth} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
    }
    return `${startMonth} ${start.getUTCDate()}–${end.getUTCDate()}, ${end.getUTCFullYear()}`;
}

/** Forecast windows that touch one UTC calendar day. */
export function cmeEventsForUtcDay(events, dayStartMs) {
    const dayEndMs = dayStartMs + DAY_MS;
    return events.filter((event) => event.earlyMs < dayEndMs && event.lateMs >= dayStartMs);
}

function relativeClock(targetMs, nowMs = Date.now()) {
    if (!Number.isFinite(targetMs)) return 'No active arrival';
    const delta = targetMs - nowMs;
    const abs = Math.abs(delta);
    const days = Math.floor(abs / DAY_MS);
    const hours = Math.floor((abs % DAY_MS) / HOUR_MS);
    const minutes = Math.floor((abs % HOUR_MS) / 60000);
    const parts = [];
    if (days) parts.push(`${days}d`);
    parts.push(`${String(hours).padStart(days ? 2 : 1, '0')}h`);
    parts.push(`${String(minutes).padStart(2, '0')}m`);
    return `${delta >= 0 ? 'T−' : 'T+'}${parts.join(' ')}`;
}

function eventStatus(event, nowMs = Date.now()) {
    if (event.truth) return event.truth.arrived === false ? 'No arrival' : 'Verified at L1';
    if (event.lateMs < nowMs) return 'Awaiting L1 resolution';
    if (event.earlyMs <= nowMs) return 'Arrival window open';
    return 'In flight';
}

function statusClass(event, nowMs = Date.now()) {
    if (event.truth) return event.truth.arrived === false ? 'miss' : 'verified';
    if (event.earlyMs <= nowMs && event.lateMs >= nowMs) return 'window';
    return 'pending';
}

function activeEvents(nowMs = Date.now()) {
    return state.events.filter((event) => !event.truth && event.lateMs >= nowMs - 3 * HOUR_MS);
}

function nextEvent(nowMs = Date.now()) {
    return activeEvents(nowMs)
        .filter((event) => event.predictedMs >= nowMs - 6 * HOUR_MS)
        .sort((a, b) => a.predictedMs - b.predictedMs)[0] ?? null;
}

function eventWindow() {
    const config = RANGE_CONFIG[state.range] ?? RANGE_CONFIG['7d'];
    const now = Date.now();
    return { start: now - config.pastMs, end: now + config.futureMs };
}

function visibleEvents() {
    const { start, end } = eventWindow();
    return state.events
        .filter((event) => event.lateMs >= start && event.earlyMs <= end)
        .sort((a, b) => a.predictedMs - b.predictedMs)
        .slice(0, 10);
}

function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

function drawDiamond(ctx, x, y, radius, fill) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = fill;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    ctx.restore();
}

function drawEmptyChart(ctx, width, height, message) {
    ctx.clearRect(0, 0, width, height);
    const glow = ctx.createRadialGradient(width * .52, height * .45, 0, width * .52, height * .45, width * .45);
    glow.addColorStop(0, 'rgba(66, 214, 255, .10)');
    glow.addColorStop(1, 'rgba(66, 214, 255, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(153, 173, 204, .12)';
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.moveTo(48, height / 2);
    ctx.lineTo(width - 48, height / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#aebbd1';
    ctx.textAlign = 'center';
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.fillText(message, width / 2, height / 2 - 8);
    ctx.fillStyle = '#66758d';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText('No synthetic forecast is substituted.', width / 2, height / 2 + 18);
}

function chartColors(event) {
    const kind = statusClass(event);
    if (kind === 'verified') return { strong: '#72f5bd', soft: 'rgba(114,245,189,.18)' };
    if (kind === 'miss') return { strong: '#ff7694', soft: 'rgba(255,118,148,.16)' };
    if (kind === 'window') return { strong: '#ffc96c', soft: 'rgba(255,201,108,.20)' };
    return { strong: '#57d9ff', soft: 'rgba(87,217,255,.18)' };
}

function drawChart() {
    const canvas = $('cmef-timeline');
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(320, bounds.width);
    const height = Math.max(320, bounds.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const events = visibleEvents();
    if (!state.events.length) {
        drawEmptyChart(ctx, width, height, 'Forecast ledger unavailable');
        canvas.dataset.ready = 'true';
        return;
    }
    if (!events.length) {
        drawEmptyChart(ctx, width, height, 'Quiet corridor in this view');
        canvas.dataset.ready = 'true';
        return;
    }

    const { start, end } = eventWindow();
    const narrow = width < 620;
    const margin = { left: narrow ? 24 : 124, right: narrow ? 28 : 66, top: 48, bottom: 48 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const x = (ms) => margin.left + ((ms - start) / (end - start)) * plotWidth;
    const rowHeight = plotHeight / events.length;

    // Vertical time grid.
    const ticks = narrow ? 4 : 7;
    ctx.lineWidth = 1;
    for (let i = 0; i <= ticks; i++) {
        const tickMs = start + (i / ticks) * (end - start);
        const tx = margin.left + (i / ticks) * plotWidth;
        ctx.strokeStyle = i === 0 || i === ticks ? 'rgba(151,177,211,.14)' : 'rgba(151,177,211,.09)';
        ctx.beginPath();
        ctx.moveTo(tx, margin.top - 8);
        ctx.lineTo(tx, height - margin.bottom + 6);
        ctx.stroke();
        ctx.fillStyle = '#71819a';
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
        ctx.fillText(formatCompactUtc(tickMs), tx, height - 17);
    }

    state.hitAreas = [];
    const nowMs = Date.now();
    events.forEach((event, index) => {
        const cy = margin.top + rowHeight * (index + .5);
        const colors = chartColors(event);
        const startX = clamp(x(event.earlyMs), margin.left, margin.left + plotWidth);
        const endX = clamp(x(event.lateMs), margin.left, margin.left + plotWidth);
        const medianX = clamp(x(event.predictedMs), margin.left, margin.left + plotWidth);
        const bandHeight = clamp(rowHeight * .24, 8, 14);

        ctx.strokeStyle = 'rgba(151,177,211,.08)';
        ctx.beginPath();
        ctx.moveTo(margin.left, cy);
        ctx.lineTo(margin.left + plotWidth, cy);
        ctx.stroke();

        if (!narrow) {
            ctx.fillStyle = event.id === state.selectedId ? '#f4f8ff' : '#aebbd1';
            ctx.font = `${event.id === state.selectedId ? 700 : 600} 11px system-ui, sans-serif`;
            ctx.textAlign = 'right';
            ctx.fillText(shortId(event), margin.left - 14, cy + 4);
        }

        const gradient = ctx.createLinearGradient(startX, 0, endX, 0);
        gradient.addColorStop(0, 'rgba(87,217,255,.05)');
        gradient.addColorStop(.5, colors.soft);
        gradient.addColorStop(1, 'rgba(178,119,255,.07)');
        roundedRect(ctx, startX, cy - bandHeight / 2, Math.max(3, endX - startX), bandHeight, bandHeight / 2);
        ctx.fillStyle = gradient;
        ctx.fill();
        ctx.strokeStyle = colors.strong;
        ctx.globalAlpha = .7;
        ctx.stroke();
        ctx.globalAlpha = 1;

        if (event.id === state.selectedId) {
            ctx.beginPath();
            ctx.arc(medianX, cy, 10, 0, Math.PI * 2);
            ctx.fillStyle = colors.soft;
            ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(medianX, cy, event.earlyMs <= nowMs && event.lateMs >= nowMs ? 5.5 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = colors.strong;
        ctx.fill();
        ctx.strokeStyle = '#06101c';
        ctx.lineWidth = 2;
        ctx.stroke();

        if (event.truthShockMs !== null && event.truthShockMs >= start && event.truthShockMs <= end) {
            const truthX = x(event.truthShockMs);
            ctx.strokeStyle = 'rgba(255,255,255,.34)';
            ctx.setLineDash([2, 4]);
            ctx.beginPath();
            ctx.moveTo(medianX, cy);
            ctx.lineTo(truthX, cy);
            ctx.stroke();
            ctx.setLineDash([]);
            drawDiamond(ctx, truthX, cy, 4, '#f7fbff');
        }

        const probability = Number.isFinite(event.pHit) ? `${Math.round(event.pHit * 100)}%` : '—';
        ctx.fillStyle = colors.strong;
        ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(probability, margin.left + plotWidth + 12, cy + 4);

        state.hitAreas.push({
            id: event.id,
            left: narrow ? margin.left : 0,
            right: width,
            top: cy - rowHeight / 2,
            bottom: cy + rowHeight / 2,
            anchorX: medianX,
            anchorY: cy,
        });
    });

    // Wall-clock now line is always drawn last so uncertainty bands cannot
    // obscure where the forecast stands at this instant.
    if (nowMs >= start && nowMs <= end) {
        const nowX = x(nowMs);
        ctx.strokeStyle = '#ffc96c';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(nowX, margin.top - 14);
        ctx.lineTo(nowX, height - margin.bottom + 6);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffc96c';
        ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('NOW', nowX, margin.top - 23);
    }
    canvas.dataset.ready = 'true';
}

function renderHeroStats() {
    const now = Date.now();
    const active = activeEvents(now);
    const next = nextEvent(now);
    const strongest = active
        .filter((event) => Number.isFinite(event.minBzP50))
        .sort((a, b) => a.minBzP50 - b.minBzP50)[0];
    $('cmef-active-count').textContent = String(active.length);
    $('cmef-next-countdown').textContent = next ? relativeClock(next.predictedMs, now) : 'Quiet';
    $('cmef-next-window').textContent = next
        ? `${formatCompactUtc(next.earlyMs)}–${formatCompactUtc(next.lateMs)}`
        : 'No open prospective window';
    $('cmef-next-phit').textContent = next && Number.isFinite(next.pHit)
        ? `${Math.round(next.pHit * 100)}%`
        : '—';
    $('cmef-bz').textContent = strongest ? `${strongest.minBzP50.toFixed(0)} nT` : '—';
}

function renderChartSummary() {
    const events = visibleEvents();
    const summary = $('cmef-chart-summary');
    if (!events.length) {
        summary.textContent = state.events.length
            ? 'There are no CME arrival windows in the selected time range.'
            : 'The forecast ledger is unavailable. No forecast values are being shown.';
        return;
    }
    summary.textContent = events.map((event) =>
        `${shortId(event)}: forecast ${formatUtc(event.predictedMs)}, window ${formatUtc(event.earlyMs)} to ${formatUtc(event.lateMs)}, ${eventStatus(event)}.`
    ).join(' ');
}

function renderEvents() {
    const list = $('cmef-event-list');
    const ordered = [...state.events].sort((a, b) => {
        const aResolved = a.truth ? 1 : 0;
        const bResolved = b.truth ? 1 : 0;
        return aResolved - bResolved || a.predictedMs - b.predictedMs;
    }).slice(0, 12);
    if (!ordered.length) {
        list.innerHTML = `<div class="cmef-empty">
            <strong>No forecast records available.</strong>
            <span>This surface does not manufacture demo arrivals when the issue-time ledger is unavailable.</span>
        </div>`;
        return;
    }

    list.innerHTML = ordered.map((event) => {
        const status = eventStatus(event);
        const kind = statusClass(event);
        const selected = event.id === state.selectedId;
        const widthHours = (event.lateMs - event.earlyMs) / HOUR_MS;
        const errorHours = event.truthShockMs === null ? null : (event.predictedMs - event.truthShockMs) / HOUR_MS;
        const pHit = Number.isFinite(event.pHit) ? `${Math.round(event.pHit * 100)}%` : 'Not issued';
        const bz = Number.isFinite(event.minBzP50) ? `${event.minBzP50.toFixed(0)} nT` : 'Not issued';
        const truth = event.truth
            ? event.truth.arrived === false
                ? 'L1 truth: no arrival observed'
                : `L1 shock ${formatUtc(event.truthShockMs)}${Number.isFinite(errorHours) ? ` · error ${errorHours >= 0 ? '+' : ''}${errorHours.toFixed(1)} h` : ''}`
            : 'Outcome pending · forecast remains locked';
        const severity = [
            Number.isFinite(event.p10) ? `P(Bz ≤ −10 nT) ${Math.round(event.p10 * 100)}%` : null,
            Number.isFinite(event.p20) ? `P(Bz ≤ −20 nT) ${Math.round(event.p20 * 100)}%` : null,
            Number.isFinite(event.minBzP5) ? `Bz p05 ${event.minBzP5.toFixed(0)} nT` : null,
        ].filter(Boolean).join(' · ');
        return `<article class="cmef-event-card ${selected ? 'is-selected' : ''}" data-event-id="${esc(event.id)}">
            <button class="cmef-event-select" type="button" data-select-event="${esc(event.id)}" aria-pressed="${selected}">
                <span class="cmef-event-heading">
                    <span><span class="cmef-event-sun">☉</span> ${esc(shortId(event))}</span>
                    <span class="cmef-state ${kind}">${esc(status)}</span>
                </span>
                <span class="cmef-arrival-time">${esc(formatUtc(event.predictedMs))}</span>
                <span class="cmef-arrival-window">${esc(formatUtc(event.earlyMs))} → ${esc(formatUtc(event.lateMs))} · ${widthHours.toFixed(0)} h band</span>
                <span class="cmef-event-metrics">
                    <span><b>${esc(pHit)}</b>P(Earth hit)</span>
                    <span><b>${esc(bz)}</b>min Bz p50</span>
                    <span><b>${Number.isFinite(event.speedKms) ? `${event.speedKms.toFixed(0)} km/s` : '—'}</b>speed</span>
                </span>
                ${severity ? `<span class="cmef-severity-line">${esc(severity)}</span>` : ''}
                <span class="cmef-truth-line">${esc(truth)}</span>
                <span class="cmef-issued">Locked ${esc(formatUtc(event.issuedMs))} · ${esc(event.modelId)}</span>
            </button>
        </article>`;
    }).join('');

    list.querySelectorAll('[data-select-event]').forEach((button) => {
        button.addEventListener('click', () => {
            selectForecastEvent(button.dataset.selectEvent, { scrollToCard: false });
        });
    });
}

function ensureCalendarDayVisible(dayStartMs) {
    const calendarEnd = state.calendarStartMs + 7 * DAY_MS;
    if (dayStartMs < state.calendarStartMs || dayStartMs >= calendarEnd) {
        state.calendarStartMs = dayStartMs;
    }
}

function selectForecastEvent(eventId, { scrollToCard = false, scrollToChart = false } = {}) {
    const event = state.events.find((candidate) => candidate.id === eventId);
    if (!event) return;
    state.selectedId = event.id;
    state.selectedDayMs = utcDayStart(event.predictedMs);
    delete $('cmef-calendar-detail').dataset.userCollapsed;
    ensureCalendarDayVisible(state.selectedDayMs);
    renderEvents();
    renderCalendar();
    drawChart();
    if (scrollToCard) {
        document.querySelector(`[data-event-id="${CSS.escape(event.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (scrollToChart) {
        $('cmef-chart-shell')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function renderCalendarDetail(dayStartMs, events) {
    const detail = $('cmef-calendar-detail');
    if (dayStartMs === null) {
        detail.hidden = true;
        detail.innerHTML = '';
        return;
    }
    detail.hidden = false;
    const heading = formatDayHeading(dayStartMs);
    if (!events.length) {
        detail.innerHTML = `<div class="cmef-day-detail-head">
                <div><span class="cmef-day-detail-label">Daily outlook · UTC</span><h3>${esc(heading)}</h3></div>
                <span class="cmef-day-detail-count quiet">Quiet corridor</span>
            </div>
            <div class="cmef-day-quiet">
                <span class="cmef-day-quiet-mark" aria-hidden="true">○</span>
                <div><strong>No issue-locked CME arrival window intersects this day.</strong>
                <p>That is a quiet Parker forecast, not a guarantee of quiet space weather. Solar eruptions and upstream conditions can still change after this ledger update.</p></div>
            </div>`;
        return;
    }

    const items = events.map((event) => {
        const medianHere = utcDayStart(event.predictedMs) === dayStartMs;
        const truthText = event.truth
            ? event.truth.arrived === false
                ? 'Resolved · no L1 arrival'
                : `L1 truth ${formatTimeOnlyUtc(event.truthShockMs)}`
            : 'Outcome pending';
        return `<article class="cmef-day-event ${event.id === state.selectedId ? 'is-selected' : ''}">
            <div class="cmef-day-event-main">
                <span class="cmef-day-event-title"><span aria-hidden="true">☉</span> ${esc(shortId(event))}</span>
                <strong>${medianHere ? `Median ${esc(formatTimeOnlyUtc(event.predictedMs))}` : `Window overlap · median ${esc(formatUtc(event.predictedMs))}`}</strong>
                <span>${esc(formatCompactUtc(event.earlyMs))}–${esc(formatCompactUtc(event.lateMs))} window · ${esc(truthText)}</span>
            </div>
            <div class="cmef-day-event-metrics">
                <span><b>${Number.isFinite(event.pHit) ? `${Math.round(event.pHit * 100)}%` : '—'}</b>P(hit)</span>
                <span><b>${Number.isFinite(event.minBzP50) ? `${event.minBzP50.toFixed(0)} nT` : '—'}</b>Bz p50</span>
                <span><b>${Number.isFinite(event.p10) ? `${Math.round(event.p10 * 100)}%` : '—'}</b>P(Bz ≤ −10)</span>
                <span><b>${Number.isFinite(event.p20) ? `${Math.round(event.p20 * 100)}%` : '—'}</b>P(Bz ≤ −20)</span>
                <span><b>${Number.isFinite(event.minBzP5) ? `${event.minBzP5.toFixed(0)} nT` : '—'}</b>Bz p05</span>
                <span><b>${Number.isFinite(event.speedKms) ? `${event.speedKms.toFixed(0)} km/s` : '—'}</b>speed</span>
            </div>
            <div class="cmef-day-event-lock">
                <span>Issued ${esc(formatUtc(event.issuedMs))} · ${esc(event.modelId)}</span>
                <button type="button" data-calendar-event="${esc(event.id)}">Locate in chart</button>
            </div>
        </article>`;
    }).join('');

    detail.innerHTML = `<div class="cmef-day-detail-head">
            <div><span class="cmef-day-detail-label">Daily outlook · UTC</span><h3>${esc(heading)}</h3></div>
            <span class="cmef-day-detail-count">${events.length} ${events.length === 1 ? 'window' : 'windows'}</span>
        </div>
        <div class="cmef-day-events">${items}</div>`;
    detail.querySelectorAll('[data-calendar-event]').forEach((button) => {
        button.addEventListener('click', () => selectForecastEvent(button.dataset.calendarEvent, { scrollToChart: true }));
    });
}

function renderCalendar() {
    const grid = $('cmef-calendar-grid');
    if (!grid) return;
    const today = utcDayStart(Date.now());
    if (state.calendarStartMs === null) state.calendarStartMs = today;
    const days = Array.from({ length: 7 }, (_, index) => state.calendarStartMs + index * DAY_MS);
    $('cmef-calendar-range').textContent = formatCalendarRange(state.calendarStartMs);
    grid.innerHTML = days.map((dayStartMs) => {
        const events = cmeEventsForUtcDay(state.events, dayStartMs);
        const medianCount = events.filter((event) => utcDayStart(event.predictedMs) === dayStartMs).length;
        const maxHit = events.reduce((best, event) => Number.isFinite(event.pHit) ? Math.max(best, event.pHit) : best, -1);
        const selected = state.selectedDayMs === dayStartMs;
        const date = new Date(dayStartMs);
        const weekday = date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
        const month = date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
        const signal = medianCount
            ? `${medianCount} ${medianCount === 1 ? 'arrival' : 'arrivals'}`
            : events.length
                ? `${events.length} window ${events.length === 1 ? 'edge' : 'edges'}`
                : 'Quiet';
        const dots = events.slice(0, 3).map((event) => `<i style="--cmef-dot:${esc(chartColors(event).strong)}"></i>`).join('');
        return `<button class="cmef-day ${events.length ? 'has-window' : ''} ${dayStartMs === today ? 'is-today' : ''} ${selected ? 'is-selected' : ''}"
                type="button" data-calendar-day="${dayStartMs}" aria-expanded="${selected}" aria-controls="cmef-calendar-detail">
            <span class="cmef-day-top"><span>${esc(weekday)}</span><small>${esc(month)}</small></span>
            <strong>${date.getUTCDate()}</strong>
            <span class="cmef-day-signal">${esc(signal)}</span>
            <span class="cmef-day-foot"><span class="cmef-day-dots">${dots}</span><b>${maxHit >= 0 ? `${Math.round(maxHit * 100)}%` : ''}</b></span>
        </button>`;
    }).join('');

    grid.querySelectorAll('[data-calendar-day]').forEach((button) => {
        button.addEventListener('click', () => {
            const dayStartMs = Number(button.dataset.calendarDay);
            const collapsing = state.selectedDayMs === dayStartMs;
            state.selectedDayMs = collapsing ? null : dayStartMs;
            if (collapsing) $('cmef-calendar-detail').dataset.userCollapsed = 'true';
            else delete $('cmef-calendar-detail').dataset.userCollapsed;
            renderCalendar();
        });
    });

    const detailEvents = state.selectedDayMs === null
        ? []
        : cmeEventsForUtcDay(state.events, state.selectedDayMs);
    renderCalendarDetail(state.selectedDayMs, detailEvents);
}

function modelMetric(row, names) {
    for (const name of names) {
        const value = finite(row?.[name]);
        if (value !== null) return value;
    }
    return null;
}

function renderSkill() {
    const panel = $('cmef-skill-grid');
    const realtime = state.models.filter((row) => row?.is_hindcast !== true);
    const maturing = `<div class="cmef-skill-empty">
            <span class="cmef-skill-orbit" aria-hidden="true"></span>
            <div><strong>Prospective skill is maturing.</strong>
            <p>The table will populate only as issue-locked forecasts resolve against L1—not from backfilled outcomes.</p></div>
        </div>`;
    if (!realtime.length) {
        panel.innerHTML = maturing;
        return;
    }
    const hasParkerScore = realtime.some((row) => row?.model_id === 'flux-rope-v1');
    panel.innerHTML = `${hasParkerScore ? '' : maturing}${realtime.map((row) => {
        const model = row.model_id ?? row.model ?? 'forecast model';
        const n = modelMetric(row, ['n_scored', 'n', 'sample_size']);
        const mae = modelMetric(row, ['mae_hours', 'mae_h']);
        const bias = modelMetric(row, ['bias_hours', 'bias_h']);
        const directHitRate = modelMetric(row, ['hit_rate', 'hits_12h_rate']);
        const hits12h = modelMetric(row, ['hits_12h']);
        const hitRate = directHitRate ?? (n > 0 && hits12h !== null ? hits12h / n : null);
        return `<article class="cmef-skill-card ${model === 'flux-rope-v1' ? 'primary' : ''}">
            <div class="cmef-skill-head"><strong>${esc(model)}</strong><span>${model === 'flux-rope-v1' ? 'PARKER' : 'BASELINE'}</span></div>
            <div class="cmef-skill-values">
                <span><b>${mae === null ? '—' : `${mae.toFixed(1)} h`}</b>arrival MAE</span>
                <span><b>${bias === null ? '—' : `${bias >= 0 ? '+' : ''}${bias.toFixed(1)} h`}</b>timing bias</span>
                <span><b>${hitRate === null ? '—' : `${Math.round(hitRate <= 1 ? hitRate * 100 : hitRate)}%`}</b>within 12 h</span>
                <span><b>${n === null ? '—' : n.toFixed(0)}</b>scored</span>
            </div>
        </article>`;
    }).join('')}`;
}

function renderFreshness(mode = 'live') {
    const dot = $('cmef-feed-dot');
    const label = $('cmef-feed-label');
    const updated = state.updatedAt ?? Date.now();
    dot.dataset.mode = mode;
    if (mode === 'loading') {
        label.textContent = 'Connecting to issue-time ledger…';
        return;
    }
    if (mode === 'error') {
        label.textContent = 'Forecast ledger unavailable';
        return;
    }
    label.textContent = `Issue-time ledger · updated ${formatUtc(updated)}`;
}

function renderAll() {
    if (!state.selectedId || !state.events.some((event) => event.id === state.selectedId)) {
        state.selectedId = nextEvent()?.id ?? state.events[0]?.id ?? null;
    }
    if (state.calendarStartMs === null) state.calendarStartMs = utcDayStart(Date.now());
    if (state.selectedDayMs === null && !$('cmef-calendar-detail')?.dataset.userCollapsed) {
        const forecastDay = nextEvent() ? utcDayStart(nextEvent().predictedMs) : state.calendarStartMs;
        state.selectedDayMs = forecastDay;
        ensureCalendarDayVisible(forecastDay);
    }
    renderHeroStats();
    renderEvents();
    renderSkill();
    renderCalendar();
    renderChartSummary();
    drawChart();
}

async function loadForecasts({ manual = false } = {}) {
    const refresh = $('cmef-refresh');
    if (manual) {
        refresh.disabled = true;
        refresh.textContent = 'Refreshing…';
    }
    renderFreshness('loading');
    try {
        const response = await fetch('/api/cme/skill?events=60', {
            headers: { accept: 'application/json' },
            cache: 'no-store',
        });
        if (!response.ok) throw new Error(`Forecast endpoint returned ${response.status}`);
        const normalized = normalizeCmePayload(await response.json());
        state.events = normalized.events;
        state.models = normalized.models;
        state.updatedAt = normalized.updatedAt;
        renderFreshness('live');
        renderAll();
    } catch (error) {
        console.info('cme-forecast: issue-time ledger unavailable', error?.message ?? error);
        if (!state.events.length) {
            state.events = [];
            state.models = [];
            renderAll();
        }
        renderFreshness('error');
    } finally {
        if (manual) {
            refresh.disabled = false;
            refresh.textContent = 'Refresh data';
        }
    }
}

function bindRangeControls() {
    document.querySelectorAll('[data-cmef-range]').forEach((button) => {
        button.addEventListener('click', () => {
            state.range = button.dataset.cmefRange;
            document.querySelectorAll('[data-cmef-range]').forEach((candidate) => {
                const active = candidate === button;
                candidate.classList.toggle('active', active);
                candidate.setAttribute('aria-pressed', String(active));
            });
            renderChartSummary();
            drawChart();
        });
    });
}

function bindCalendarControls() {
    $('cmef-calendar-prev').addEventListener('click', () => {
        state.calendarStartMs -= 7 * DAY_MS;
        state.selectedDayMs = null;
        $('cmef-calendar-detail').dataset.userCollapsed = 'true';
        renderCalendar();
    });
    $('cmef-calendar-next').addEventListener('click', () => {
        state.calendarStartMs += 7 * DAY_MS;
        state.selectedDayMs = null;
        $('cmef-calendar-detail').dataset.userCollapsed = 'true';
        renderCalendar();
    });
    $('cmef-calendar-today').addEventListener('click', () => {
        state.calendarStartMs = utcDayStart(Date.now());
        state.selectedDayMs = state.calendarStartMs;
        delete $('cmef-calendar-detail').dataset.userCollapsed;
        renderCalendar();
    });
}

function bindChartPointer() {
    const canvas = $('cmef-timeline');
    const tooltip = $('cmef-tooltip');
    const hide = () => { tooltip.hidden = true; };
    canvas.addEventListener('pointerleave', hide);
    canvas.addEventListener('pointermove', (event) => {
        const bounds = canvas.getBoundingClientRect();
        const px = event.clientX - bounds.left;
        const py = event.clientY - bounds.top;
        const hit = state.hitAreas.find((area) => px >= area.left && px <= area.right && py >= area.top && py <= area.bottom);
        if (!hit) return hide();
        const item = state.events.find((candidate) => candidate.id === hit.id);
        if (!item) return hide();
        tooltip.innerHTML = `<strong>${esc(shortId(item))}</strong><span>${esc(formatUtc(item.earlyMs))} → ${esc(formatUtc(item.lateMs))}</span><span>${esc(eventStatus(item))}</span>`;
        tooltip.hidden = false;
        const left = clamp(hit.anchorX, 118, bounds.width - 118);
        const top = clamp(hit.anchorY - 74, 8, bounds.height - 78);
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    });
    canvas.addEventListener('click', (event) => {
        const bounds = canvas.getBoundingClientRect();
        const py = event.clientY - bounds.top;
        const hit = state.hitAreas.find((area) => py >= area.top && py <= area.bottom);
        if (!hit) return;
        selectForecastEvent(hit.id, { scrollToCard: true });
    });
}

export async function initCmeForecastPage() {
    state.calendarStartMs = utcDayStart(Date.now());
    renderCalendar();
    bindRangeControls();
    bindCalendarControls();
    bindChartPointer();
    $('cmef-refresh').addEventListener('click', () => loadForecasts({ manual: true }));
    state.resizeObserver = new ResizeObserver(drawChart);
    state.resizeObserver.observe($('cmef-chart-shell'));
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            renderHeroStats();
            drawChart();
        }
    });
    state.clockTimer = window.setInterval(() => {
        renderHeroStats();
        drawChart();
    }, 60_000);
    state.refreshTimer = window.setInterval(loadForecasts, REFRESH_MS);
    await loadForecasts();
}

if (typeof document !== 'undefined') {
    initCmeForecastPage();
}
