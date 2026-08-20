// cme-forecast-page.js — operational forecast ledger for cme-forecast.html.
//
// This page is intentionally a CONSUMER of /api/cme/skill. It never reruns
// the forecast physics in the browser and never substitutes a demo prediction:
// every plotted window is the issue-locked record that can later be scored
// against L1 truth.
//
// The surface is a real MONTH CALENDAR (Sunday-first, always 42 cells) plus
// a rail of derived views. Two things about that are load-bearing:
//
//   · The grid is ALWAYS six weeks. A month-length grid would change height
//     between February and August, and the page holds a single-screen
//     layout (see the LAYOUT CONTRACT comment in cme-forecast.html) — a
//     variable row count is what would make a scrollbar appear some months
//     and not others. monthGridDays() therefore pads to 42 unconditionally.
//   · A day cell shows a CHIP only for a median arrival that lands on that
//     day. Days a window merely passes through get the dimmer "window edge"
//     row instead, because painting them identically would read as many
//     more forecast arrivals than were ever issued.

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
    calendarMonthMs: null,
    selectedDayMs: null,
    corridor: null,        // lazily mounted 3D panel (see bindViewTabs)
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
    // This is the Parkers Physics public output, not a generic model
    // browser. Baselines belong in the skill comparison below and must never
    // be plotted as if Parkers Physics issued them. (Spell the brand out:
    // bare "Parker" reads as Eugene Parker everywhere else in this repo —
    // Parker spiral, Parker 1958 — which is exactly the wrong association
    // on a page about forecast provenance.)
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

/** UTC month start (day 1, 00:00Z) of the month containing ms. */
export function utcMonthStart(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Shift a UTC month start by whole months (Date.UTC normalizes overflow). */
export function addUtcMonths(monthStartMs, count) {
    const d = new Date(monthStartMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + count, 1);
}

/**
 * The 42 UTC day-starts of a Sunday-first month grid.
 *
 * Always six weeks — see the module header. Plain DAY_MS arithmetic is exact
 * here because every UTC midnight is a whole multiple of 86 400 000 ms from
 * the epoch; there is no DST in UTC to skew a day step.
 */
export function monthGridDays(monthStartMs) {
    const gridStart = monthStartMs - new Date(monthStartMs).getUTCDay() * DAY_MS;
    return Array.from({ length: 42 }, (_, index) => gridStart + index * DAY_MS);
}

function formatDayHeading(ms) {
    return new Date(ms).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
}

/** Compact day label for the rail head, e.g. "Thu, Aug 20". */
function formatDayShort(ms) {
    return new Date(ms).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
}

/** Bare 24 h clock, no suffix — calendar chips have no room for one. */
function formatClockUtc(ms) {
    if (!Number.isFinite(ms)) return '--:--';
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function formatTimeOnlyUtc(ms) {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function formatMonthLabel(monthStartMs) {
    return new Date(monthStartMs).toLocaleDateString('en-US', {
        month: 'long', year: 'numeric', timeZone: 'UTC',
    });
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
        .slice(0, 8);
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
    glow.addColorStop(0, 'rgba(79, 195, 247, .10)');
    glow.addColorStop(1, 'rgba(79, 195, 247, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(144, 164, 200, .12)';
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.moveTo(24, height / 2);
    ctx.lineTo(width - 24, height / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#cdd5e4';
    ctx.textAlign = 'center';
    ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(message, width / 2, height / 2 - 6);
    ctx.fillStyle = '#69718c';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('No synthetic forecast is substituted.', width / 2, height / 2 + 11);
}

// House accent set (flux-rope-live.html / operations.html / status.html).
// Canvas cannot read CSS custom properties, so these mirror the --cmef-*
// tokens in cme-forecast.html by hand — change both together.
function chartColors(event) {
    const kind = statusClass(event);
    if (kind === 'verified') return { strong: '#7fe6c3', soft: 'rgba(127,230,195,.20)' };
    if (kind === 'miss') return { strong: '#ff6b8a', soft: 'rgba(255,107,138,.18)' };
    if (kind === 'window') return { strong: '#ffb454', soft: 'rgba(255,180,84,.22)' };
    return { strong: '#4fc3f7', soft: 'rgba(79,195,247,.20)' };
}

function drawChart() {
    const canvas = $('cmef-timeline');
    if (!canvas) return;
    // Size the shell to the row count FIRST — the canvas is measured from
    // its laid-out box, so reading bounds before this would draw at the
    // previous height and leave the last row outside the visible area.
    const shell = $('cmef-chart-shell');
    const rows = String(Math.max(1, visibleEvents().length));
    // Write only on change: the ResizeObserver watches this element, and an
    // unconditional write would re-enter drawChart on every frame it fires.
    if (shell && shell.style.getPropertyValue('--cmef-rows') !== rows) {
        shell.style.setProperty('--cmef-rows', rows);
    }
    const bounds = canvas.getBoundingClientRect();
    // Floors, not defaults: the corridor is a RAIL panel now (~152 px tall,
    // ~330 px wide). The old 320 px height floor over-drew a canvas the CSS
    // had already sized down, so every row landed outside the visible box.
    const width = Math.max(260, bounds.width);
    const height = Math.max(96, bounds.height);
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
    // "narrow" is the rail case: no room for a left label gutter, so the
    // event id moves into the row itself and only the P(hit) column stays.
    const narrow = width < 560;
    const margin = { left: narrow ? 8 : 116, right: narrow ? 38 : 58, top: 18, bottom: 20 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const x = (ms) => margin.left + ((ms - start) / (end - start)) * plotWidth;
    const rowHeight = plotHeight / events.length;

    // Vertical time grid.
    const ticks = narrow ? 3 : 6;
    ctx.lineWidth = 1;
    for (let i = 0; i <= ticks; i++) {
        const tickMs = start + (i / ticks) * (end - start);
        const tx = margin.left + (i / ticks) * plotWidth;
        ctx.strokeStyle = i === 0 || i === ticks ? 'rgba(151,177,211,.14)' : 'rgba(151,177,211,.09)';
        ctx.beginPath();
        ctx.moveTo(tx, margin.top - 6);
        ctx.lineTo(tx, height - margin.bottom + 4);
        ctx.stroke();
        ctx.fillStyle = '#69718c';
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
        ctx.fillText(formatCompactUtc(tickMs), tx, height - 6);
    }

    state.hitAreas = [];
    const nowMs = Date.now();
    events.forEach((event, index) => {
        const cy = margin.top + rowHeight * (index + .5);
        const colors = chartColors(event);
        const startX = clamp(x(event.earlyMs), margin.left, margin.left + plotWidth);
        const endX = clamp(x(event.lateMs), margin.left, margin.left + plotWidth);
        const medianX = clamp(x(event.predictedMs), margin.left, margin.left + plotWidth);
        const bandHeight = clamp(rowHeight * .3, 5, 11);

        ctx.strokeStyle = 'rgba(151,177,211,.08)';
        ctx.beginPath();
        ctx.moveTo(margin.left, cy);
        ctx.lineTo(margin.left + plotWidth, cy);
        ctx.stroke();

        if (!narrow) {
            ctx.fillStyle = event.id === state.selectedId ? '#eef3fb' : '#8b94ad';
            ctx.font = `${event.id === state.selectedId ? 700 : 600} 10px "Segoe UI", system-ui, sans-serif`;
            ctx.textAlign = 'right';
            ctx.fillText(shortId(event), margin.left - 10, cy + 3.5);
        } else if (rowHeight >= 22) {
            // Rail case: the id rides just above its own band.
            ctx.fillStyle = event.id === state.selectedId ? '#eef3fb' : '#8b94ad';
            ctx.font = `${event.id === state.selectedId ? 700 : 600} 9px "Segoe UI", system-ui, sans-serif`;
            ctx.textAlign = 'left';
            ctx.fillText(shortId(event), margin.left + 1, cy - bandHeight / 2 - 3);
        }

        const gradient = ctx.createLinearGradient(startX, 0, endX, 0);
        gradient.addColorStop(0, 'rgba(79,195,247,.05)');
        gradient.addColorStop(.5, colors.soft);
        gradient.addColorStop(1, 'rgba(199,146,234,.07)');
        roundedRect(ctx, startX, cy - bandHeight / 2, Math.max(3, endX - startX), bandHeight, bandHeight / 2);
        ctx.fillStyle = gradient;
        ctx.fill();
        ctx.strokeStyle = colors.strong;
        ctx.globalAlpha = .7;
        ctx.stroke();
        ctx.globalAlpha = 1;

        if (event.id === state.selectedId) {
            ctx.beginPath();
            ctx.arc(medianX, cy, 8, 0, Math.PI * 2);
            ctx.fillStyle = colors.soft;
            ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(medianX, cy, event.earlyMs <= nowMs && event.lateMs >= nowMs ? 4.5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = colors.strong;
        ctx.fill();
        ctx.strokeStyle = '#080a1c';
        ctx.lineWidth = 1.5;
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
            drawDiamond(ctx, truthX, cy, 3.2, '#f2f6ff');
        }

        const probability = Number.isFinite(event.pHit) ? `${Math.round(event.pHit * 100)}%` : '—';
        ctx.fillStyle = colors.strong;
        ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(probability, margin.left + plotWidth + 8, cy + 3.5);

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
        ctx.strokeStyle = '#ffb454';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(nowX, margin.top - 4);
        ctx.lineTo(nowX, height - margin.bottom + 4);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffb454';
        ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
        // Clamped so the label cannot be clipped by either edge of a rail
        // canvas that is only ~330 px wide.
        ctx.textAlign = 'center';
        ctx.fillText('NOW', clamp(nowX, 14, width - 14), margin.top - 8);
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

/**
 * The ledger tape: one compact card per committed forecast.
 *
 * This used to be twelve 260 px-tall cards in a two-column grid a full
 * screen below the calendar. The content is unchanged — median arrival,
 * P(hit), Bz p50, and the resolved L1 outcome — but a horizontal tape puts
 * every event in view at once, which is what a ledger is for.
 */
function renderEvents() {
    const list = $('cmef-event-list');
    const ordered = [...state.events].sort((a, b) => {
        const aResolved = a.truth ? 1 : 0;
        const bResolved = b.truth ? 1 : 0;
        return aResolved - bResolved || a.predictedMs - b.predictedMs;
    }).slice(0, 14);
    if (!ordered.length) {
        list.innerHTML = `<div class="cmef-tape-empty">
            <span><strong>No forecast records available.</strong> This surface does not manufacture demo arrivals when the issue-time ledger is unavailable.</span>
        </div>`;
        return;
    }

    list.innerHTML = ordered.map((event) => {
        const status = eventStatus(event);
        const kind = statusClass(event);
        const selected = event.id === state.selectedId;
        const errorHours = event.truthShockMs === null ? null : (event.predictedMs - event.truthShockMs) / HOUR_MS;
        const pHit = Number.isFinite(event.pHit) ? `${Math.round(event.pHit * 100)}% hit` : 'P(hit) not issued';
        const bz = Number.isFinite(event.minBzP50) ? `${event.minBzP50.toFixed(0)} nT` : 'Bz not issued';
        const outcome = event.truth
            ? event.truth.arrived === false
                ? 'no L1 arrival'
                : Number.isFinite(errorHours)
                    ? `L1 error ${errorHours >= 0 ? '+' : ''}${errorHours.toFixed(1)} h`
                    : 'resolved at L1'
            : 'Outcome pending';
        return `<button class="cmef-ledger-card ${selected ? 'is-selected' : ''}" type="button"
                data-event-id="${esc(event.id)}" data-select-event="${esc(event.id)}"
                style="--cmef-card:${esc(chartColors(event).strong)}" aria-pressed="${selected}">
            <span class="cmef-ledger-top"><span aria-hidden="true">\u2609</span> ${esc(shortId(event))}<em>${esc(status)}</em></span>
            <span class="cmef-ledger-time">${esc(formatUtc(event.predictedMs))}</span>
            <span class="cmef-ledger-sub">${esc(pHit)} \u00b7 ${esc(bz)} \u00b7 ${esc(outcome)}</span>
        </button>`;
    }).join('');

    list.querySelectorAll('[data-select-event]').forEach((button) => {
        button.addEventListener('click', () => {
            selectForecastEvent(button.dataset.selectEvent, { scrollToCard: false });
        });
    });
}

/** Pull the calendar to the month that actually shows this day. */
function ensureCalendarDayVisible(dayStartMs) {
    const grid = monthGridDays(state.calendarMonthMs ?? utcMonthStart(dayStartMs));
    if (dayStartMs < grid[0] || dayStartMs > grid[grid.length - 1]) {
        state.calendarMonthMs = utcMonthStart(dayStartMs);
    }
}

function selectForecastEvent(eventId, { scrollToCard = false, scrollToChart = false } = {}) {
    const event = state.events.find((candidate) => candidate.id === eventId);
    if (!event) return;
    state.selectedId = event.id;
    state.selectedDayMs = utcDayStart(event.predictedMs);
    delete $('cmef-calendar-detail').dataset.userCollapsed;
    ensureCalendarDayVisible(state.selectedDayMs);
    // The corridor draws the SELECTED event's arrival window, so its scrubber
    // ticks move with the selection.
    state.corridor?.refreshTicks?.();
    renderEvents();
    renderCalendar();
    drawChart();
    if (scrollToCard) {
        document.querySelector(`[data-event-id="${CSS.escape(event.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
    if (scrollToChart) {
        $('cmef-chart-shell')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

/**
 * The rail's selected-day panel. The day heading and the window count live
 * in the panel HEAD (outside the re-rendered body) so the panel keeps its
 * shape while the body swaps.
 */
function renderCalendarDetail(dayStartMs, events) {
    const detail = $('cmef-calendar-detail');
    const dayLabel = $('cmef-detail-day');
    const count = $('cmef-detail-count');

    if (dayStartMs === null) {
        dayLabel.textContent = '\u2014';
        count.textContent = 'None';
        count.className = 'cmef-detail-count quiet';
        detail.innerHTML = `<div class="cmef-day-quiet">
            <strong>No day selected.</strong>
            <p>Pick a day in the calendar to see the issue-locked arrival windows that intersect it.</p>
        </div>`;
        return;
    }

    dayLabel.textContent = formatDayShort(dayStartMs);
    if (!events.length) {
        count.textContent = 'Quiet';
        count.className = 'cmef-detail-count quiet';
        detail.innerHTML = `<div class="cmef-day-quiet">
            <strong>No issue-locked CME arrival window intersects ${esc(formatDayHeading(dayStartMs))}.</strong>
            <p>That is a quiet Parkers Physics forecast, not a guarantee of quiet space weather. Solar eruptions and upstream conditions can still change after this ledger update.</p>
        </div>`;
        return;
    }

    count.textContent = `${events.length} ${events.length === 1 ? 'window' : 'windows'}`;
    count.className = 'cmef-detail-count';
    detail.innerHTML = events.map((event) => {
        const medianHere = utcDayStart(event.predictedMs) === dayStartMs;
        const errorHours = event.truthShockMs === null ? null : (event.predictedMs - event.truthShockMs) / HOUR_MS;
        const truthText = event.truth
            ? event.truth.arrived === false
                ? 'Resolved \u00b7 no L1 arrival'
                : `L1 truth ${formatTimeOnlyUtc(event.truthShockMs)}${Number.isFinite(errorHours) ? ` \u00b7 error ${errorHours >= 0 ? '+' : ''}${errorHours.toFixed(1)} h` : ''}`
            : 'Outcome pending \u00b7 forecast remains locked';
        return `<article class="cmef-day-event ${event.id === state.selectedId ? 'is-selected' : ''}">
            <div class="cmef-day-event-top">
                <strong><span aria-hidden="true">\u2609</span> ${esc(shortId(event))}</strong>
                <span class="cmef-state ${statusClass(event)}">${esc(eventStatus(event))}</span>
            </div>
            <span class="cmef-day-event-time">${medianHere
                ? `Median ${esc(formatTimeOnlyUtc(event.predictedMs))}`
                : `Median ${esc(formatUtc(event.predictedMs))}`}</span>
            <span class="cmef-day-event-band">${esc(formatCompactUtc(event.earlyMs))}\u2013${esc(formatCompactUtc(event.lateMs))} window${medianHere ? '' : ' \u00b7 overlaps this day'}</span>
            <div class="cmef-metrics">
                <span><b>${Number.isFinite(event.pHit) ? `${Math.round(event.pHit * 100)}%` : '\u2014'}</b>P(hit)</span>
                <span><b>${Number.isFinite(event.minBzP50) ? `${event.minBzP50.toFixed(0)} nT` : '\u2014'}</b>Bz p50</span>
                <span><b>${Number.isFinite(event.minBzP5) ? `${event.minBzP5.toFixed(0)} nT` : '\u2014'}</b>Bz p05</span>
                <span><b>${Number.isFinite(event.p10) ? `${Math.round(event.p10 * 100)}%` : '\u2014'}</b>P(Bz \u2264 \u221210)</span>
                <span><b>${Number.isFinite(event.p20) ? `${Math.round(event.p20 * 100)}%` : '\u2014'}</b>P(Bz \u2264 \u221220)</span>
                <span><b>${Number.isFinite(event.speedKms) ? `${event.speedKms.toFixed(0)}` : '\u2014'}</b>km/s</span>
            </div>
            <div class="cmef-day-event-foot">
                <span class="cmef-truth">${esc(truthText)}</span>
                <span>Issued ${esc(formatUtc(event.issuedMs))} \u00b7 ${esc(event.modelId)}</span>
                <button type="button" data-calendar-event="${esc(event.id)}">Locate in chart</button>
            </div>
        </article>`;
    }).join('');

    detail.querySelectorAll('[data-calendar-event]').forEach((button) => {
        button.addEventListener('click', () => selectForecastEvent(button.dataset.calendarEvent, { scrollToChart: true }));
    });
}

/**
 * The month grid itself.
 *
 * A cell carries a CHIP per median arrival landing on that day (time +
 * P(hit), tinted by forecast state), and a single dim "window edge" row
 * when the day is only crossed by somebody else's uncertainty band. The
 * two are deliberately not drawn alike — see the module header.
 */
function renderCalendar() {
    const grid = $('cmef-calendar-grid');
    if (!grid) return;
    const today = utcDayStart(Date.now());
    if (state.calendarMonthMs === null) state.calendarMonthMs = utcMonthStart(today);
    const monthStart = state.calendarMonthMs;
    const shownMonth = new Date(monthStart).getUTCMonth();
    $('cmef-calendar-range').textContent = formatMonthLabel(monthStart);

    grid.innerHTML = monthGridDays(monthStart).map((dayStartMs) => {
        const events = cmeEventsForUtcDay(state.events, dayStartMs);
        const medians = events.filter((event) => utcDayStart(event.predictedMs) === dayStartMs);
        const edges = events.length - medians.length;
        const outside = new Date(dayStartMs).getUTCMonth() !== shownMonth;
        const selected = state.selectedDayMs === dayStartMs;
        const date = new Date(dayStartMs);

        const chips = medians.slice(0, 2).map((event) => {
            const probability = Number.isFinite(event.pHit) ? `${Math.round(event.pHit * 100)}%` : '';
            return `<span class="cmef-chip" style="--cmef-chip:${esc(chartColors(event).strong)}"><i></i><span class="cmef-chip-time">${esc(formatClockUtc(event.predictedMs))}</span><b>${probability}</b></span>`;
        });
        if (medians.length > 2) {
            chips.push(`<span class="cmef-chip-more">+${medians.length - 2} more</span>`);
        } else if (edges > 0) {
            // "edge", not "window edge": a phone day cell is ~52 px wide and
            // the longer wording was being clipped mid-word. The calendar
            // legend is what carries the full term.
            chips.push(`<span class="cmef-chip is-edge"><i></i><span class="cmef-chip-time">${edges}<em> ${edges === 1 ? 'edge' : 'edges'}</em></span></span>`);
        }

        const summary = medians.length
            ? `${medians.length} arrival${medians.length === 1 ? '' : 's'}`
            : edges > 0 ? `${edges} window edge${edges === 1 ? '' : 's'}` : 'quiet';
        return `<button class="cmef-day ${events.length ? 'has-window' : ''} ${outside ? 'is-outside' : ''} ${dayStartMs === today ? 'is-today' : ''} ${selected ? 'is-selected' : ''}"
                type="button" data-calendar-day="${dayStartMs}" aria-expanded="${selected}" aria-controls="cmef-calendar-detail"
                aria-label="${esc(formatDayHeading(dayStartMs))} \u00b7 ${esc(summary)}">
            <span class="cmef-day-num">${date.getUTCDate()}${dayStartMs === today ? '<small>NOW</small>' : ''}</span>
            <span class="cmef-chips">${chips.join('')}</span>
        </button>`;
    }).join('');

    grid.querySelectorAll('[data-calendar-day]').forEach((button) => {
        button.addEventListener('click', () => {
            const dayStartMs = Number(button.dataset.calendarDay);
            const collapsing = state.selectedDayMs === dayStartMs;
            state.selectedDayMs = collapsing ? null : dayStartMs;
            if (collapsing) $('cmef-calendar-detail').dataset.userCollapsed = 'true';
            else delete $('cmef-calendar-detail').dataset.userCollapsed;
            // Picking a day sets the corridor's clock to that day's midpoint,
            // so the calendar doubles as the 3D view's time index. Noon, not
            // midnight: a day's arrivals cluster nowhere in particular and the
            // midpoint is the least misleading single instant to stand at.
            if (!collapsing) state.corridor?.setEpoch?.(dayStartMs + 12 * HOUR_MS);
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
    const maturing = `<div class="cmef-empty">
            <strong>Prospective skill is maturing.</strong>
            <p>These rows populate only as issue-locked forecasts resolve against L1 \u2014 never from backfilled outcomes.</p>
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
        return `<article class="cmef-skill-row ${model === 'flux-rope-v1' ? 'primary' : ''}">
            <div class="cmef-skill-name"><strong>${esc(model)}</strong><span>${model === 'flux-rope-v1' ? 'PARKERS PHYSICS' : 'BASELINE'}</span></div>
            <div class="cmef-skill-vals">
                <span><b>${mae === null ? '\u2014' : `${mae.toFixed(1)} h`}</b>MAE</span>
                <span><b>${bias === null ? '\u2014' : `${bias >= 0 ? '+' : ''}${bias.toFixed(1)} h`}</b>bias</span>
                <span><b>${hitRate === null ? '\u2014' : `${Math.round(hitRate <= 1 ? hitRate * 100 : hitRate)}%`}</b>\u226412 h</span>
                <span><b>${n === null ? '\u2014' : n.toFixed(0)}</b>scored</span>
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
    if (state.calendarMonthMs === null) state.calendarMonthMs = utcMonthStart(Date.now());
    if (state.selectedDayMs === null && !$('cmef-calendar-detail')?.dataset.userCollapsed) {
        const upcoming = nextEvent();
        const forecastDay = upcoming ? utcDayStart(upcoming.predictedMs) : utcDayStart(Date.now());
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

/**
 * Left-panel view switch: the month calendar, or the 3D Sun→Earth corridor.
 *
 * The corridor module is imported on FIRST OPEN, never at load. It pulls in
 * three.js, the far-side package and the flux-rope provider (which runs a
 * WASM ensemble), and a visitor who only wants the calendar should not pay
 * for any of that. The mount is fail-quiet: if it cannot start, the tab says
 * so and the calendar is untouched.
 *
 * The corridor is told which ledger event to draw an arrival window for by
 * reading state.selectedId on every frame rather than being pushed a value —
 * one source of truth, so the scene and the ledger cannot disagree about
 * what is selected.
 */
function bindViewTabs() {
    const tabs = [...document.querySelectorAll('[data-cmef-view]')];
    if (!tabs.length) return;
    const panes = {
        calendar: $('cmef-view-calendar'),
        corridor: $('cmef-view-corridor'),
    };
    const calNav = $('cmef-cal-nav');

    const show = async (name) => {
        for (const tab of tabs) {
            tab.setAttribute('aria-selected', String(tab.dataset.cmefView === name));
        }
        for (const [key, pane] of Object.entries(panes)) {
            if (pane) pane.hidden = key !== name;
        }
        // Month paging belongs to the calendar only.
        if (calNav) calNav.style.visibility = name === 'calendar' ? '' : 'hidden';
        $('cmef-calendar-title').textContent =
            name === 'corridor' ? 'Sun → Earth corridor' : 'Arrival calendar';
        if (name !== 'corridor' || state.corridor) return;

        state.corridor = 'loading';
        try {
            const { mountCorridor } = await import('./corridor/corridor-panel.js');
            state.corridor = mountCorridor('cmef-corridor-host', {
                getEvent: () => state.events.find((e) => e.id === state.selectedId) ?? null,
            }) || 'failed';
        } catch (error) {
            state.corridor = 'failed';
            console.info('cme-forecast: 3D corridor unavailable', error?.message ?? error);
        }
        if (state.corridor === 'failed') {
            $('cmef-corridor-host').innerHTML =
                '<p class="cmef-empty" style="margin:10px"><strong>3D corridor unavailable.</strong>'
                + '<span>The calendar and the issue-locked ledger are unaffected.</span></p>';
        }
    };

    for (const tab of tabs) {
        tab.addEventListener('click', () => show(tab.dataset.cmefView));
    }
}

function bindCalendarControls() {
    // Month paging deliberately PRESERVES the selected day: a calendar that
    // wiped your selection every time you looked at next month would blank
    // the rail, and the rail head still names the date it is showing.
    $('cmef-calendar-prev').addEventListener('click', () => {
        state.calendarMonthMs = addUtcMonths(state.calendarMonthMs, -1);
        renderCalendar();
    });
    $('cmef-calendar-next').addEventListener('click', () => {
        state.calendarMonthMs = addUtcMonths(state.calendarMonthMs, 1);
        renderCalendar();
    });
    $('cmef-calendar-today').addEventListener('click', () => {
        const today = utcDayStart(Date.now());
        state.calendarMonthMs = utcMonthStart(today);
        state.selectedDayMs = today;
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
    state.calendarMonthMs = utcMonthStart(Date.now());
    renderCalendar();
    bindRangeControls();
    bindCalendarControls();
    bindViewTabs();
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
