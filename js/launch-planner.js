/**
 * launch-planner.js — Upcoming orbital launches + weather Go/No-Go analysis.
 *
 * Target users: commercial launch operators (SpaceX, Blue Origin, ULA,
 * Rocket Lab) who want a quick weather read on pad conditions for scheduled
 * missions.
 *
 * Pipeline:
 *   1. GET /api/launches/upcoming  (Launch Library 2, cached 1 hr).
 *   2. Render left-panel filters + center roster of launch cards sorted by T-.
 *   3. On card select, fetchPointForecast(pad.lat, pad.lon) from Open-Meteo.
 *   4. Score weather against public launch commit criteria (wind, precip,
 *      cloud, thunderstorm, temperature). Worst rule wins.
 *   5. Per-second countdown updates T-minus on every visible card.
 *
 * No Supabase writes. No auth required beyond nav tier gating.
 */

import {
    fetchPointForecast,
    weatherCodeLabel,
    compassLabel,
} from './trip-planner.js';

// ── Go/No-Go scoring ────────────────────────────────────────────────────────

const THRESHOLDS = Object.freeze({
    wind:   { green: 20, yellow: 30 },        // mph, sustained
    gust:   { green: 25, yellow: 35 },        // mph, peak
    precip: { green: 25, yellow: 50 },        // %, daily precip probability
    cloud:  { green: 50, yellow: 75 },        // %, total cover
    tempLo: { red: 35, yellow: 40 },          // °F
    tempHi: { yellow: 95, red: 100 },         // °F
});

const THUNDERSTORM_CODES = new Set([95, 96, 99]);

const VERDICT_RANK = { green: 0, yellow: 1, red: 2 };

function worst(a, b) {
    return VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a;
}

function bandSustainedWind(mph) {
    if (mph == null || !Number.isFinite(mph)) return { v: 'yellow', note: 'unknown' };
    if (mph < THRESHOLDS.wind.green)  return { v: 'green',  note: `${mph.toFixed(0)} mph` };
    if (mph < THRESHOLDS.wind.yellow) return { v: 'yellow', note: `${mph.toFixed(0)} mph — marginal` };
    return { v: 'red', note: `${mph.toFixed(0)} mph — over 30 mph ground wind` };
}

function bandGust(mph) {
    if (mph == null || !Number.isFinite(mph)) return { v: 'yellow', note: 'unknown' };
    if (mph < THRESHOLDS.gust.green)  return { v: 'green',  note: `${mph.toFixed(0)} mph` };
    if (mph < THRESHOLDS.gust.yellow) return { v: 'yellow', note: `${mph.toFixed(0)} mph — watch gusts` };
    return { v: 'red', note: `${mph.toFixed(0)} mph — gusts over 35 mph` };
}

function bandPrecip(pct) {
    if (pct == null || !Number.isFinite(pct)) return { v: 'green', note: 'no precip forecast' };
    if (pct < THRESHOLDS.precip.green)  return { v: 'green',  note: `${pct}% chance` };
    if (pct < THRESHOLDS.precip.yellow) return { v: 'yellow', note: `${pct}% — possible scrub` };
    return { v: 'red', note: `${pct}% — wet weather expected` };
}

function bandCloud(pct) {
    if (pct == null || !Number.isFinite(pct)) return { v: 'yellow', note: 'unknown' };
    if (pct < THRESHOLDS.cloud.green)  return { v: 'green',  note: `${pct}% cover` };
    if (pct < THRESHOLDS.cloud.yellow) return { v: 'yellow', note: `${pct}% — watch ceiling` };
    return { v: 'red', note: `${pct}% — overcast` };
}

function bandTemp(f) {
    if (f == null || !Number.isFinite(f)) return { v: 'yellow', note: 'unknown' };
    if (f < THRESHOLDS.tempLo.red)    return { v: 'red',    note: `${f.toFixed(0)}°F — below 35°F cutoff` };
    if (f < THRESHOLDS.tempLo.yellow) return { v: 'yellow', note: `${f.toFixed(0)}°F — cold` };
    if (f > THRESHOLDS.tempHi.red)    return { v: 'red',    note: `${f.toFixed(0)}°F — heat extreme` };
    if (f > THRESHOLDS.tempHi.yellow) return { v: 'yellow', note: `${f.toFixed(0)}°F — hot` };
    return { v: 'green', note: `${f.toFixed(0)}°F` };
}

function bandLightning(code) {
    if (THUNDERSTORM_CODES.has(code)) return { v: 'red', note: weatherCodeLabel(code) };
    return { v: 'green', note: 'no thunderstorms' };
}

/**
 * Score an Open-Meteo forecast against launch commit criteria.
 * Returns { verdict, rules: [{ key, label, v, note }] }.
 * Worst rule wins; UNKNOWN weather yields a yellow overall verdict.
 */
export function scoreWeather(fc) {
    if (!fc) {
        return {
            verdict: 'yellow',
            rules: [{ key: 'data', label: 'Forecast', v: 'yellow', note: 'No forecast available' }],
        };
    }
    const precipPct = Array.isArray(fc.daily?.precip_prob_pct) ? fc.daily.precip_prob_pct[0] : null;
    const rules = [
        { key: 'wind',      label: 'Ground wind',     ...bandSustainedWind(fc.wind_mph) },
        { key: 'gust',      label: 'Wind gusts',      ...bandGust(fc.wind_gust_mph) },
        { key: 'precip',    label: 'Precipitation',   ...bandPrecip(precipPct) },
        { key: 'cloud',     label: 'Cloud cover',     ...bandCloud(fc.cloud_cover) },
        { key: 'lightning', label: 'Thunderstorms',   ...bandLightning(fc.weather_code) },
        { key: 'temp',      label: 'Temperature',     ...bandTemp(fc.temp_f) },
    ];
    const verdict = rules.reduce((acc, r) => worst(acc, r.v), 'green');
    return { verdict, rules };
}

// ── Countdown formatting ────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

export function formatCountdown(targetIso, now = Date.now()) {
    if (!targetIso) return 'TBD';
    const t = Date.parse(targetIso);
    if (!Number.isFinite(t)) return 'TBD';
    const diff = t - now;
    const abs = Math.abs(diff);
    const d = Math.floor(abs / 86400000);
    const h = Math.floor((abs % 86400000) / 3600000);
    const m = Math.floor((abs % 3600000) / 60000);
    const s = Math.floor((abs % 60000) / 1000);
    const sign = diff >= 0 ? 'T-' : 'T+';
    if (d > 0) return `${sign}${d}d ${pad2(h)}:${pad2(m)}:${pad2(s)}`;
    return `${sign}${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

// ── Launch feed fetching ────────────────────────────────────────────────────

async function fetchLaunches(windowDays = 90, limit = 50) {
    const params = new URLSearchParams({ limit: String(limit), window_days: String(windowDays) });
    try {
        const res = await fetch(`/api/launches/upcoming?${params}`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data;
    } catch (e) {
        console.warn('[LaunchPlanner] feed fetch failed:', e.message);
        return { launches: [], error: e.message };
    }
}

// ── Rendering ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function escHtml(s) {
    return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatLocalTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function verdictColor(v) {
    return v === 'red' ? '#ff4444' : v === 'yellow' ? '#ffaa00' : '#44cc88';
}

function verdictLabel(v) {
    return v === 'red' ? 'NO-GO' : v === 'yellow' ? 'HOLD' : 'GO';
}

function renderCard(l) {
    const verdict = l._score?.verdict || 'unknown';
    const color   = verdictColor(verdict);
    const label   = l._score ? verdictLabel(verdict) : '—';
    const net     = formatLocalTime(l.net_iso);
    const flagCls = l.pad?.country_code ? `flag-${l.pad.country_code.toLowerCase()}` : '';
    return `
        <button type="button" class="lp-card${verdict === 'red' ? ' lp-card--red' : verdict === 'yellow' ? ' lp-card--yellow' : verdict === 'green' ? ' lp-card--green' : ''}" data-launch-id="${escHtml(l.id)}">
            <div class="lp-card-hd">
                <span class="lp-card-provider">${escHtml(l.provider)}</span>
                <span class="lp-badge" style="background:${color}22;border-color:${color}55;color:${color}">${label}</span>
            </div>
            <div class="lp-card-name">${escHtml(l.name)}</div>
            <div class="lp-card-meta">
                <span class="lp-card-vehicle">${escHtml(l.vehicle)}</span>
                <span class="lp-card-dot">·</span>
                <span class="lp-card-pad ${flagCls}">${escHtml(l.pad?.location || '—')}</span>
            </div>
            <div class="lp-card-footer">
                <span class="lp-card-net">${escHtml(net)}</span>
                <span class="lp-countdown" data-net="${escHtml(l.net_iso || '')}">${formatCountdown(l.net_iso)}</span>
            </div>
        </button>
    `;
}

function renderRuleRow(r) {
    const color = verdictColor(r.v);
    return `
        <div class="lp-rule">
            <span class="lp-rule-dot" style="background:${color}"></span>
            <span class="lp-rule-k">${escHtml(r.label)}</span>
            <span class="lp-rule-v">${escHtml(r.note)}</span>
        </div>
    `;
}

function renderDetail(l, fc, score) {
    if (!l) {
        return `<div class="lp-empty">Select a launch on the left to see weather Go/No-Go analysis.</div>`;
    }

    const verdict = score?.verdict || 'unknown';
    const color   = verdictColor(verdict);
    const label   = score ? verdictLabel(verdict) : '…analyzing';

    const lat = l.pad?.lat;
    const lon = l.pad?.lon;
    const hasPad = Number.isFinite(lat) && Number.isFinite(lon);

    const weatherBlock = fc ? `
        <div class="lp-wx-grid">
            <div class="lp-wx-cell"><div class="lp-wx-k">Conditions</div><div class="lp-wx-v">${escHtml(weatherCodeLabel(fc.weather_code))}</div></div>
            <div class="lp-wx-cell"><div class="lp-wx-k">Temp</div><div class="lp-wx-v">${fc.temp_f != null ? `${fc.temp_f.toFixed(0)}°F` : '—'}</div></div>
            <div class="lp-wx-cell"><div class="lp-wx-k">Wind</div><div class="lp-wx-v">${fc.wind_mph != null ? `${fc.wind_mph.toFixed(0)} mph ${compassLabel(fc.wind_dir_deg)}` : '—'}</div></div>
            <div class="lp-wx-cell"><div class="lp-wx-k">Gusts</div><div class="lp-wx-v">${fc.wind_gust_mph != null ? `${fc.wind_gust_mph.toFixed(0)} mph` : '—'}</div></div>
            <div class="lp-wx-cell"><div class="lp-wx-k">Cloud</div><div class="lp-wx-v">${fc.cloud_cover != null ? `${fc.cloud_cover}%` : '—'}</div></div>
            <div class="lp-wx-cell"><div class="lp-wx-k">Humidity</div><div class="lp-wx-v">${fc.humidity != null ? `${fc.humidity}%` : '—'}</div></div>
        </div>
    ` : `<div class="lp-wx-loading">Fetching pad weather…</div>`;

    const forecastBlock = fc?.daily?.dates?.length ? `
        <div class="lp-label">3-Day Forecast</div>
        <div class="lp-forecast">
            ${fc.daily.dates.map((d, i) => {
                const dt = new Date(d);
                const name = dt.toLocaleDateString([], { weekday: 'short' });
                const hi = fc.daily.high_f?.[i];
                const lo = fc.daily.low_f?.[i];
                const pp = fc.daily.precip_prob_pct?.[i];
                return `
                    <div class="lp-fc-day">
                        <div class="lp-fc-name">${escHtml(name)}</div>
                        <div class="lp-fc-temp"><span class="lp-fc-hi">${hi != null ? Math.round(hi) : '—'}°</span><span class="lp-fc-lo">${lo != null ? Math.round(lo) : '—'}°</span></div>
                        <div class="lp-fc-precip">${pp != null ? pp : 0}%</div>
                    </div>
                `;
            }).join('')}
        </div>
    ` : '';

    const ruleBlock = score ? `
        <div class="lp-label">Launch Commit Criteria</div>
        <div class="lp-rules">${score.rules.map(renderRuleRow).join('')}</div>
    ` : '';

    return `
        <div class="lp-detail">
            <div class="lp-detail-hd">
                <div>
                    <div class="lp-detail-provider">${escHtml(l.provider)}</div>
                    <h2 class="lp-detail-name">${escHtml(l.name)}</h2>
                    <div class="lp-detail-sub">${escHtml(l.vehicle)} · ${escHtml(l.pad?.name || '')} · ${escHtml(l.pad?.location || '')}</div>
                </div>
                <span class="lp-verdict" style="background:${color}22;border-color:${color};color:${color}">${label}</span>
            </div>

            <div class="lp-detail-row">
                <div class="lp-clock">
                    <div class="lp-label">T-minus</div>
                    <div class="lp-countdown-big" data-net="${escHtml(l.net_iso || '')}">${formatCountdown(l.net_iso)}</div>
                    <div class="lp-net">NET ${formatLocalTime(l.net_iso)} local</div>
                </div>
                <div class="lp-pad">
                    <div class="lp-label">Pad</div>
                    <div class="lp-pad-name">${escHtml(l.pad?.name || '—')}</div>
                    <div class="lp-pad-coords">${hasPad ? `${lat.toFixed(3)}°, ${lon.toFixed(3)}°` : 'Coordinates unavailable'}</div>
                    ${l.pad?.wiki ? `<a href="${escHtml(l.pad.wiki)}" target="_blank" rel="noopener" class="lp-link">Pad info ↗</a>` : ''}
                </div>
            </div>

            ${l.mission ? `<div class="lp-mission"><div class="lp-label">Mission</div><p>${escHtml(l.mission)}</p></div>` : ''}

            <div class="lp-label">Current Weather</div>
            ${weatherBlock}

            ${forecastBlock}

            ${ruleBlock}

            <div class="lp-footnote">
                Weather source: Open-Meteo. Launch data: Launch Library 2 (TheSpaceDevs).
                Go/No-Go uses public launch commit criteria and is advisory only — not an
                official flight-readiness determination.
            </div>
        </div>
    `;
}

// ── App state ───────────────────────────────────────────────────────────────

const state = {
    launches:       [],
    filtered:       [],
    providers:      new Set(),
    activeProviders: new Set(),     // empty = all
    verdictFilter:  'all',          // 'all' | 'green' | 'yellow' | 'red'
    windowDays:     90,
    selectedId:     null,
    weatherCache:   new Map(),      // launchId → forecast
    scoreCache:     new Map(),      // launchId → score
};

function applyFilters() {
    state.filtered = state.launches.filter(l => {
        if (state.activeProviders.size > 0 && !state.activeProviders.has(l.provider)) return false;
        if (state.verdictFilter !== 'all' && l._score?.verdict !== state.verdictFilter) return false;
        return true;
    });
}

function renderRoster() {
    const host = $('lp-roster');
    if (!host) return;
    if (state.filtered.length === 0) {
        host.innerHTML = `<div class="lp-empty">No launches match these filters.</div>`;
        return;
    }
    host.innerHTML = state.filtered.map(renderCard).join('');
    host.querySelectorAll('.lp-card').forEach(btn => {
        btn.addEventListener('click', () => selectLaunch(btn.dataset.launchId));
    });
    if (state.selectedId) {
        host.querySelector(`[data-launch-id="${CSS.escape(state.selectedId)}"]`)?.classList.add('lp-card--active');
    }
}

function renderDetailPane() {
    const host = $('lp-detail');
    if (!host) return;
    const l  = state.launches.find(x => x.id == state.selectedId);
    const fc = l ? state.weatherCache.get(l.id) : null;
    const sc = l ? state.scoreCache.get(l.id)   : null;
    host.innerHTML = renderDetail(l, fc, sc);
}

function renderProviderFilters() {
    const host = $('lp-providers');
    if (!host) return;
    const sorted = [...state.providers].sort();
    host.innerHTML = sorted.map(p => {
        const active = state.activeProviders.has(p);
        return `<button type="button" class="lp-chip${active ? ' lp-chip--on' : ''}" data-provider="${escHtml(p)}">${escHtml(p)}</button>`;
    }).join('');
    host.querySelectorAll('.lp-chip').forEach(ch => {
        ch.addEventListener('click', () => {
            const p = ch.dataset.provider;
            if (state.activeProviders.has(p)) state.activeProviders.delete(p);
            else state.activeProviders.add(p);
            applyFilters();
            renderProviderFilters();
            renderRoster();
        });
    });
}

function renderStatus(text, isError = false) {
    const el = $('lp-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#ff6b6b' : '#8ab';
}

function renderCountdowns() {
    const now = Date.now();
    document.querySelectorAll('[data-net]').forEach(el => {
        const iso = el.getAttribute('data-net');
        if (iso) el.textContent = formatCountdown(iso, now);
    });
}

// ── Selection + weather join ────────────────────────────────────────────────

async function ensureWeather(l) {
    if (state.weatherCache.has(l.id)) return state.weatherCache.get(l.id);
    if (!Number.isFinite(l.pad?.lat) || !Number.isFinite(l.pad?.lon)) {
        state.weatherCache.set(l.id, null);
        return null;
    }
    const fc = await fetchPointForecast(l.pad.lat, l.pad.lon);
    state.weatherCache.set(l.id, fc);
    const score = scoreWeather(fc);
    state.scoreCache.set(l.id, score);
    l._score = score;
    return fc;
}

async function selectLaunch(id) {
    state.selectedId = id;
    renderRoster();
    renderDetailPane();
    const l = state.launches.find(x => x.id == id);
    if (!l) return;
    await ensureWeather(l);
    applyFilters();
    renderRoster();
    renderDetailPane();
    updateUrl();
}

function updateUrl() {
    const url = new URL(window.location.href);
    if (state.selectedId) url.searchParams.set('launch', state.selectedId);
    else                  url.searchParams.delete('launch');
    if (state.verdictFilter !== 'all') url.searchParams.set('verdict', state.verdictFilter);
    else                                url.searchParams.delete('verdict');
    window.history.replaceState(null, '', url.toString());
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function init() {
    renderStatus('Loading upcoming launches…');

    const data = await fetchLaunches(state.windowDays, 50);
    if (data.error) {
        renderStatus(`Upstream error: ${data.error}`, true);
        return;
    }
    state.launches = data.launches || [];
    state.providers = new Set(state.launches.map(l => l.provider).filter(Boolean));

    renderStatus(`${state.launches.length} launches · updated ${new Date(data.fetched_at).toLocaleTimeString()}`);

    // Kick off weather prefetch for the first 8 launches so initial sort reflects verdicts.
    const soon = state.launches.slice(0, 8);
    await Promise.all(soon.map(l => ensureWeather(l).catch(() => null)));

    applyFilters();
    renderProviderFilters();
    renderRoster();

    // Honor ?launch=<id> deep link
    const urlParams = new URLSearchParams(window.location.search);
    const preselect = urlParams.get('launch');
    const verdictParam = urlParams.get('verdict');
    if (verdictParam && ['green', 'yellow', 'red'].includes(verdictParam)) {
        state.verdictFilter = verdictParam;
        const btn = document.querySelector(`[data-verdict-filter="${verdictParam}"]`);
        btn?.classList.add('lp-chip--on');
    }
    if (preselect && state.launches.some(l => String(l.id) === String(preselect))) {
        await selectLaunch(preselect);
    } else if (state.launches[0]) {
        await selectLaunch(state.launches[0].id);
    } else {
        renderDetailPane();
    }

    // Countdown tick
    setInterval(renderCountdowns, 1000);

    // Lazy-load weather for the rest so all cards show verdicts eventually
    const remaining = state.launches.slice(8);
    for (const l of remaining) {
        ensureWeather(l).then(() => {
            applyFilters();
            renderRoster();
        }).catch(() => null);
        await new Promise(r => setTimeout(r, 150));  // throttle Open-Meteo
    }
}

function wireControls() {
    document.querySelectorAll('[data-window-days]').forEach(btn => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('[data-window-days]').forEach(b => b.classList.remove('lp-chip--on'));
            btn.classList.add('lp-chip--on');
            state.windowDays = parseInt(btn.dataset.windowDays, 10) || 90;
            const data = await fetchLaunches(state.windowDays, 50);
            state.launches = data.launches || [];
            state.providers = new Set(state.launches.map(l => l.provider).filter(Boolean));
            state.weatherCache.clear();
            state.scoreCache.clear();
            state.selectedId = null;
            applyFilters();
            renderProviderFilters();
            renderRoster();
            renderDetailPane();
            if (state.launches[0]) selectLaunch(state.launches[0].id);
        });
    });

    document.querySelectorAll('[data-verdict-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-verdict-filter]').forEach(b => b.classList.remove('lp-chip--on'));
            btn.classList.add('lp-chip--on');
            state.verdictFilter = btn.dataset.verdictFilter;
            applyFilters();
            renderRoster();
            updateUrl();
        });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { wireControls(); init(); });
} else {
    wireControls();
    init();
}
