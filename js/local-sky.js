/**
 * local-sky.js — "Today & Sun" personal panel for the dashboard.
 * ═══════════════════════════════════════════════════════════════════════════
 * A location-keyed daily snapshot that goes one step past the stock phone
 * weather app: it draws the actual solar day-arc (sunrise → solar noon →
 * sunset, with the live sun position) and surfaces the physics-derived
 * "critical value" advisories — heat index, wind chill, frost, fire weather —
 * computed from first principles rather than a single canned "feels like".
 *
 * Design constraints (see CLAUDE.md §8 "add a new data feed"):
 *   • No new database state. Solar geometry is computed client-side; weather
 *     comes from the existing edge proxy /api/weather/forecast?type=point,
 *     which already edge-caches on rounded (lat,lon) so two callers for the
 *     same place collapse to ONE upstream hit. We deliberately request the
 *     same days=7 the dashboard's temp forecast does, so we share its cache
 *     key for free instead of fragmenting it.
 *   • No framework. Renders an HTML string into a host element, matching the
 *     dashboard's inline-style + CSS-var conventions (--surface, --border,
 *     --muted). One module per feature.
 *   • Never throws out to the caller. A bad fetch or missing element degrades
 *     to a quiet empty state so it can be mounted via runSafe().
 *
 * Usage:
 *   import { mountLocalSky } from './js/local-sky.js';
 *   const sky = mountLocalSky({ host: document.getElementById('local-sky') });
 *   // sky.refresh();  sky.destroy();
 *
 * Solar math lives in sun-altitude.js (NOAA/Meeus, ~1' accuracy). Composite
 * indices live in composite-indices.js (NWS Rothfusz / 2001 wind chill /
 * Fosberg / Magnus-Tetens). This module is glue + presentation only.
 */

import { loadUserLocation }                 from './user-location.js';
import { sunTimes, solarPosition, compass16 } from './sun-altitude.js';
import { computeAdvisories, fToC, mphToMs }   from './composite-indices.js';

const WEATHER_API   = '/api/weather/forecast';
const SUN_TICK_MS   = 60_000;        // re-place the sun every minute
const DATA_TTL_MS   = 10 * 60_000;   // re-pull point weather at most every 10 min

// Compact WMO weather-code labels (Open-Meteo's code set). Kept local rather
// than importing trip-planner.js's weatherCodeLabel — that module pulls three
// transitive deps and has historically been a single point of failure for the
// dashboard (see the resilient-import block in dashboard.html).
const WMO = {
    0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle',
    55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Rain showers', 81: 'Showers', 82: 'Violent showers',
    85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'T-storm + hail', 99: 'Severe T-storm',
};

// Severity → colour, matching the dashboard's alert palette.
const SEV_COLOR = Object.freeze({
    danger:  '#ff3344',
    warning: '#ffaa00',
    caution: '#ffcc00',
    info:    '#44cc88',
});

const SEV_ICON = Object.freeze({
    'heat-index':   '🌡️',
    'wind-chill':   '❄️',
    'fire-weather': '🔥',
    'hot-dry-windy':'🌪️',
    'frost':        '🧊',
});

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const round = (v, d = 0) => {
    const f = 10 ** d;
    return Number.isFinite(v) ? Math.round(v * f) / f : null;
};

// ── Public mount ────────────────────────────────────────────────────────────

/**
 * @param {{ host: HTMLElement }} opts
 * @returns {{ refresh: () => void, destroy: () => void }}
 */
export function mountLocalSky({ host } = {}) {
    if (!host) return { refresh() {}, destroy() {} };

    let pointData   = null;   // last good /api/weather point payload
    let offsetSec   = null;   // location UTC offset (sec) once weather lands
    let fetchKey    = null;   // `${lat},${lon}` of the in-flight/last fetch
    let fetchedAt   = 0;
    let tickTimer   = null;
    let destroyed   = false;

    // Format a Date instant in the *location's* local clock once we know its
    // UTC offset; before the weather lands, fall back to the browser's locale
    // (correct for the common "my own location" case, self-corrects on fetch).
    function fmtClock(date) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
        if (offsetSec == null) {
            return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        }
        const shifted = new Date(date.getTime() + offsetSec * 1000);
        let h = shifted.getUTCHours();
        const m = shifted.getUTCMinutes();
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
    }

    function renderEmpty() {
        host.innerHTML =
            `<div style="font-size:.72rem;color:var(--muted);padding:10px 0;border-top:1px solid var(--border)">
                ☀ Set your location above to see your solar day-arc, “feels like”, and daily safety advisories.
            </div>`;
    }

    function render(loc) {
        const lat = loc.lat, lon = loc.lon;
        const now = new Date();
        const pos   = solarPosition(now, lat, lon);
        const times = sunTimes(now, lat, lon);

        host.innerHTML =
            `<div style="border-top:1px solid var(--border);margin-top:4px;padding-top:14px">
                <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:8px">
                    Today &amp; Sun · ${esc(loc.city || 'Your location')}
                </div>
                ${solarArcHtml(times, pos, now)}
                ${nowHtml(pointData)}
                ${advisoriesHtml(pointData)}
            </div>`;
    }

    // Solar arc: an elliptical day-path with sunrise/solar-noon/sunset pinned
    // and the live sun glyph placed by the fraction of daylight elapsed.
    function solarArcHtml(times, pos, now) {
        const { sunrise, solarNoon, sunset, dayLengthH, polar } = times;
        const altTxt = `${round(pos.altitudeDeg)}° ${pos.altitudeDeg >= 0 ? '↑' : '↓'} ${compass16(pos.azimuthDeg)}`;

        // Arc geometry (viewBox 0..300 × 0..104).
        const cx = 150, rx = 128, ry = 60, horizon = 92, xL = cx - rx, xR = cx + rx;
        // Daylight fraction; clamps below horizon outside [sunrise, sunset].
        let f = 0.5, daytime = true;
        if (sunrise && sunset && sunset > sunrise) {
            f = (now - sunrise) / (sunset - sunrise);
            daytime = f >= 0 && f <= 1;
            f = Math.max(0, Math.min(1, f));
        } else if (polar === 'day') {
            daytime = true;
        } else if (polar === 'night') {
            daytime = false;
        }
        const sunX = cx - rx * Math.cos(Math.PI * f);
        const sunY = daytime ? horizon - ry * Math.sin(Math.PI * f) : horizon;

        const dayLenTxt = polar === 'day'  ? '24h daylight'
                        : polar === 'night' ? 'polar night'
                        : `${Math.floor(dayLengthH)}h ${Math.round((dayLengthH % 1) * 60)}m of daylight`;

        return `
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin-bottom:4px">
            <div style="flex:1 1 240px;min-width:220px">
                <svg viewBox="0 0 300 104" width="100%" height="92" style="display:block" aria-label="Solar day arc">
                    <defs>
                        <linearGradient id="ls-arc" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0" stop-color="#ffb30033"/>
                            <stop offset="0.5" stop-color="#ffd70088"/>
                            <stop offset="1" stop-color="#ffb30033"/>
                        </linearGradient>
                    </defs>
                    <line x1="${xL}" y1="${horizon}" x2="${xR}" y2="${horizon}"
                          stroke="var(--border)" stroke-width="1"/>
                    <path d="M ${xL} ${horizon} A ${rx} ${ry} 0 0 1 ${xR} ${horizon}"
                          fill="none" stroke="url(#ls-arc)" stroke-width="2" stroke-dasharray="3 3"/>
                    <line x1="${cx}" y1="${horizon - ry}" x2="${cx}" y2="${horizon}"
                          stroke="#ffd70033" stroke-width="1"/>
                    ${daytime ? `
                    <circle cx="${round(sunX, 1)}" cy="${round(sunY, 1)}" r="7" fill="#ffd700"/>
                    <circle cx="${round(sunX, 1)}" cy="${round(sunY, 1)}" r="11" fill="none" stroke="#ffd70055" stroke-width="2"/>
                    ` : `
                    <circle cx="${round(sunX, 1)}" cy="${horizon}" r="6" fill="none" stroke="#667" stroke-width="2"/>
                    `}
                    <circle cx="${xL}" cy="${horizon}" r="2.5" fill="#8899aa"/>
                    <circle cx="${xR}" cy="${horizon}" r="2.5" fill="#8899aa"/>
                </svg>
                <div style="display:flex;justify-content:space-between;font-size:.6rem;color:#8899aa;margin-top:-4px">
                    <span>↑ ${fmtClock(sunrise)}</span>
                    <span style="color:#ffd700">☀ noon ${fmtClock(solarNoon)}</span>
                    <span>↓ ${fmtClock(sunset)}</span>
                </div>
            </div>
            <div style="flex:0 0 auto;font-size:.7rem;color:#889;line-height:1.6">
                <div>Sun now: <strong style="color:#e8f4ff">${altTxt}</strong></div>
                <div>${dayLenTxt}</div>
            </div>
        </div>`;
    }

    // Current conditions + the official apparent temperature + today's range.
    function nowHtml(data) {
        const cur = data?.current;
        const daily = data?.daily;
        if (!cur) {
            return `<div style="font-size:.7rem;color:var(--muted);margin:8px 0">Loading current conditions…</div>`;
        }
        const t      = round(cur.temperature_2m);
        const feels  = round(cur.apparent_temperature);
        const code   = WMO[cur.weather_code] ?? '';
        const rh     = round(cur.relative_humidity_2m);
        const wind   = round(cur.wind_speed_10m);
        const feelsTxt = (feels != null && Math.abs((feels ?? t) - t) >= 1)
            ? ` · feels <strong style="color:#ffd27a">${feels}°</strong>` : '';

        // Today's high/low range bar with a marker at the current temperature.
        let rangeHtml = '';
        const hi = round(daily?.temperature_2m_max?.[0]);
        const lo = round(daily?.temperature_2m_min?.[0]);
        if (hi != null && lo != null && hi > lo) {
            const pct = Math.max(0, Math.min(100, ((t - lo) / (hi - lo)) * 100));
            rangeHtml = `
            <div style="margin-top:8px">
                <div style="display:flex;justify-content:space-between;font-size:.6rem;color:#8899aa;margin-bottom:3px">
                    <span>Low ${lo}°</span><span>Today's range</span><span>High ${hi}°</span>
                </div>
                <div style="position:relative;height:6px;border-radius:3px;background:linear-gradient(to right,#3a6ea5,#ffd27a,#ff6b4a)">
                    <div style="position:absolute;top:-3px;left:${round(pct, 1)}%;width:3px;height:12px;border-radius:2px;background:#e8f4ff;box-shadow:0 0 4px rgba(0,0,0,.5);transform:translateX(-50%)"></div>
                </div>
            </div>`;
        }

        return `
        <div style="margin:8px 0 2px">
            <div style="font-size:.95rem;color:#e8f4ff">
                <strong style="font-size:1.15rem">${t != null ? t + '°' : '—'}</strong>
                ${code ? `<span style="color:#aab">${esc(code)}</span>` : ''}${feelsTxt}
            </div>
            <div style="font-size:.65rem;color:#778;margin-top:2px">
                ${rh != null ? `Humidity ${rh}%` : ''}${rh != null && wind != null ? ' · ' : ''}${wind != null ? `Wind ${wind} mph` : ''}
            </div>
            ${rangeHtml}
        </div>`;
    }

    // Physics-derived "critical value" chips. computeAdvisories only returns
    // entries that clear their info threshold, so we render whatever it gives
    // and append a few daily-aggregate flags (UV, overnight freeze, rain).
    function advisoriesHtml(data) {
        const cur = data?.current;
        const daily = data?.daily;
        const chips = [];

        if (cur) {
            const adv = computeAdvisories({
                tempC:  fToC(cur.temperature_2m),
                rhPct:  cur.relative_humidity_2m,
                windMs: mphToMs(cur.wind_speed_10m),
            });
            for (const a of adv) {
                chips.push(chip(SEV_ICON[a.id] || '⚠', `${a.label} ${a.value}${a.units}`, a.severity, a.blurb));
            }
        }

        // Overnight freeze — the most actionable daily flag the current-only
        // advisory pass can't see (it's warm now, cold by dawn).
        const lo = round(daily?.temperature_2m_min?.[0]);
        if (lo != null && lo <= 32 && !chips.some(c => c.includes('Frost'))) {
            chips.push(chip('🧊', `Freeze tonight ${lo}°`, lo <= 28 ? 'danger' : 'warning',
                'Forecast low at or below freezing.'));
        }

        // UV — phone apps show it; we colour it by the EPA scale.
        const uv = round(daily?.uv_index_max?.[0]);
        if (uv != null && uv >= 3) {
            const sev = uv >= 11 ? 'danger' : uv >= 8 ? 'warning' : uv >= 6 ? 'caution' : 'info';
            chips.push(chip('😎', `UV ${uv}`, sev, 'Peak UV index today (EPA scale).'));
        }

        // Rain likelihood.
        const pop = round(daily?.precipitation_probability_max?.[0]);
        if (pop != null && pop >= 40) {
            chips.push(chip('🌧️', `Rain ${pop}%`, pop >= 70 ? 'warning' : 'caution',
                'Peak precipitation probability today.'));
        }

        if (chips.length === 0) {
            return cur
                ? `<div style="font-size:.62rem;color:#5a6;margin-top:6px">✓ No weather advisories for your location.</div>`
                : '';
        }
        return `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">${chips.join('')}</div>`;
    }

    function chip(icon, text, severity, title) {
        const col = SEV_COLOR[severity] || SEV_COLOR.info;
        return `<span title="${esc(title)}" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:12px;font-size:.62rem;font-weight:700;background:${col}1a;color:${col};border:1px solid ${col}40">${icon} ${esc(text)}</span>`;
    }

    // ── Data + lifecycle ──────────────────────────────────────────────────

    async function fetchPoint(loc) {
        // Quantize to 3 dp exactly as temp-forecast.js does, so this request
        // hits the same edge-cache key the dashboard's temp card already
        // primed — one shared upstream hit, not two.
        const qLat = Number(loc.lat.toFixed(3));
        const qLon = Number(loc.lon.toFixed(3));
        const key = `${qLat},${qLon}`;
        if (key === fetchKey && Date.now() - fetchedAt < DATA_TTL_MS && pointData) return;
        fetchKey = key;
        const params = new URLSearchParams({
            type: 'point',
            lat:  String(qLat),
            lon:  String(qLon),
            days: '7',   // share the temp-forecast card's edge-cache key
        });
        try {
            const res = await fetch(`${WEATHER_API}?${params}`, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) return;
            const data = await res.json();
            if (data?.error || destroyed) return;
            pointData = data;
            offsetSec = Number.isFinite(data.utc_offset_seconds) ? data.utc_offset_seconds : null;
            fetchedAt = Date.now();
            const loc2 = loadUserLocation();
            if (loc2?.lat != null) render(loc2);
        } catch (e) {
            console.warn('[local-sky] point fetch failed:', e.message);
        }
    }

    function refresh() {
        if (destroyed) return;
        const loc = loadUserLocation();
        if (!loc || loc.lat == null || loc.lon == null) {
            pointData = null; offsetSec = null; fetchKey = null;
            renderEmpty();
            return;
        }
        render(loc);          // instant solar arc (zero-network)
        fetchPoint(loc);      // enrich with weather + location-tz clock
    }

    function onLocationChanged() { refresh(); }

    // Live sun tick: only re-render when we have a location, and re-read it
    // each tick so a location change between refreshes is reflected.
    tickTimer = setInterval(() => {
        if (destroyed) return;
        const loc = loadUserLocation();
        if (loc?.lat != null && loc?.lon != null) render(loc);
    }, SUN_TICK_MS);

    window.addEventListener('user-location-changed', onLocationChanged);

    function destroy() {
        destroyed = true;
        clearInterval(tickTimer);
        window.removeEventListener('user-location-changed', onLocationChanged);
    }

    refresh();
    return { refresh, destroy };
}
