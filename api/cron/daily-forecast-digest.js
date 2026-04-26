/**
 * Vercel Edge Cron: /api/cron/daily-forecast-digest
 *
 * Sends a one-email-per-day "tomorrow's forecast" digest to every saved
 * location flagged for it. Intro-tier (basic plan) only — by design.
 * Pro users get real-time alerts via /api/alerts/email and are not enrolled
 * in this duplicate channel; the cron's primary query filters by plan.
 *
 *   query path:
 *     user_locations  WHERE daily_digest_enabled
 *                       AND notify_enabled
 *                       AND email_alerts_enabled
 *     ⨝ user_profiles WHERE plan = 'basic'
 *     ⨝ auth.users    (for the recipient email)
 *
 * For each match: fetch tomorrow's forecast from Open-Meteo (point-shape:
 * daily high/low, precip%, weather code), build an HTML email, send via
 * Resend, and log the attempt in email_send_log.
 *
 * ── Auth ───────────────────────────────────────────────────────────────
 *   Vercel Cron sends `x-vercel-cron: 1`; when CRON_SECRET is set, it
 *   also sends `Authorization: Bearer <secret>`. We accept either.
 *
 * ── Env ────────────────────────────────────────────────────────────────
 *   SUPABASE_URL          (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY  (or SUPABASE_SECRET_KEY) — service_role
 *   RESEND_API_KEY
 *   ALERT_FROM_EMAIL      (optional)
 *   CRON_SECRET           (optional but recommended)
 *
 * ── Schedule ───────────────────────────────────────────────────────────
 *   Registered in vercel.json at 11:00 UTC daily (~7am Eastern, 6am
 *   Central, 4am Pacific). Aiming at Eastern morning because that's
 *   our largest user cohort; UTC keeps the schedule deterministic
 *   regardless of DST. Per-location timezone-aware delivery is a
 *   future enhancement (would require shard-by-tz cron entries).
 *
 * ── Failure handling ───────────────────────────────────────────────────
 *   Per-location failures are isolated: a forecast or send error on one
 *   location doesn't block the rest. End-of-run summary returned in the
 *   response body for ops debugging.
 */

import { fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const RESEND_API   = 'https://api.resend.com/emails';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const FROM_EMAIL   = process.env.ALERT_FROM_EMAIL || 'Parker Physics Alerts <alerts@parkerphysics.com>';
const CRON_SECRET  = process.env.CRON_SECRET || '';

const OPEN_METEO   = 'https://api.open-meteo.com/v1/forecast';

// Hard caps so a runaway query can't melt our Resend/Supabase budget. The
// Intro tier caps users at 5 saved locations and ~250 paying Intro users
// today → < 1250 sends/day worst-case; we still cap to be safe.
const MAX_LOCATIONS_PER_RUN = 2000;

// Per-location upstream timeout. Forecast calls cache aggressively at
// the Edge layer and Open-Meteo p99 is < 2 s.
const FORECAST_TIMEOUT_MS = 8_000;

// Concurrency for the per-location pipeline (forecast fetch + email send).
// Conservative — Resend allows 10 req/s on the default tier; 6 in flight
// keeps comfortable headroom.
const CONCURRENCY = 6;

function isAuthorized(req) {
    const hdr = req.headers.get('authorization') || '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (req.headers.get('x-vercel-cron')) return true;
    return false;
}

function jsonResp(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

// ── Supabase helpers (service-role) ─────────────────────────────────────

/**
 * Fetch the eligible (location, recipient) pairs for today's run. Joins
 * user_locations → user_profiles → auth.users via two PostgREST calls
 * because PostgREST can't traverse `auth.*` in a single request without
 * a SECURITY DEFINER view. The two-call pattern is fine — the inner set
 * is small (Intro users with digest-enabled rows).
 */
async function fetchEligibleLocations() {
    // 1) Location rows + profile join (PostgREST can do nested-resource
    //    selection via the FK from user_locations.user_id → user_profiles.id).
    //    Filter on the partial-index columns so Postgres uses
    //    idx_user_locations_digest_due (added by the migration).
    const url = `${SUPABASE_URL}/rest/v1/user_locations`
        + `?select=id,user_id,label,lat,lon,city,timezone,user_profiles!inner(id,plan)`
        + `&daily_digest_enabled=eq.true`
        + `&notify_enabled=eq.true`
        + `&email_alerts_enabled=eq.true`
        + `&user_profiles.plan=eq.basic`
        + `&limit=${MAX_LOCATIONS_PER_RUN}`;
    const res = await fetchWithTimeout(url, {
        timeoutMs: 15_000,
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Accept:        'application/json',
        },
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`fetchEligibleLocations HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return [];

    // 2) Look up email addresses in auth.users for the unique user_ids we
    //    just collected. Service role can read auth.admin via the admin API.
    const userIds = [...new Set(rows.map(r => r.user_id))];
    const emails = await fetchEmailsForUsers(userIds);

    return rows.map(r => ({
        id:       r.id,
        userId:   r.user_id,
        email:    emails.get(r.user_id) || null,
        label:    r.label || r.city || 'your location',
        city:     r.city  || null,
        lat:      r.lat,
        lon:      r.lon,
        timezone: r.timezone || null,
    })).filter(r => !!r.email);   // skip any users with no resolvable email
}

/**
 * Resolve auth.users.email for a list of user IDs. Supabase exposes the
 * admin API at /auth/v1/admin/users — we paginate through and filter
 * locally to the IDs we care about. For our tiny Intro cohort this is a
 * single page (~250 users), well under the default 50-per-page limit.
 */
async function fetchEmailsForUsers(userIds) {
    const out = new Map();
    if (!userIds.length) return out;

    // Up to 1000 users — covers headroom for projected growth in the
    // Intro tier without ever paging in practice. Past 1000 we'd switch
    // to fetching individual users by ID.
    const url = `${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`;
    const res = await fetchWithTimeout(url, {
        timeoutMs: 12_000,
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Accept:        'application/json',
        },
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`fetchEmailsForUsers HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const body  = await res.json();
    const users = Array.isArray(body) ? body : (body?.users ?? []);
    const want  = new Set(userIds);
    for (const u of users) {
        if (u?.id && want.has(u.id) && u?.email) out.set(u.id, u.email);
    }
    return out;
}

/**
 * Best-effort log of the send attempt to email_send_log. Failures here are
 * non-fatal — the email already went out and we don't want a Supabase blip
 * to mask successful delivery.
 */
async function logSend({ userId, recipient, subject, throttled }) {
    try {
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/email_send_log`, {
            method:    'POST',
            timeoutMs: 5_000,
            headers: {
                apikey:         SUPABASE_KEY,
                Authorization:  `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                Prefer:         'return=minimal',
            },
            body: JSON.stringify({
                user_id:   userId,
                endpoint:  'daily-digest',
                recipient,
                subject,
                throttled,
                metadata:  { source: 'cron' },
            }),
        });
    } catch {
        /* swallow */
    }
}

// ── Forecast fetch (tomorrow only, point-shape) ────────────────────────

async function fetchTomorrowForecast(lat, lon, timezone) {
    const params = new URLSearchParams({
        latitude:  Number(lat).toFixed(3),
        longitude: Number(lon).toFixed(3),
        daily: [
            'temperature_2m_max', 'temperature_2m_min',
            'precipitation_sum', 'precipitation_probability_max',
            'weather_code', 'wind_speed_10m_max',
            'sunrise', 'sunset', 'uv_index_max',
        ].join(','),
        temperature_unit: 'fahrenheit',
        wind_speed_unit:  'mph',
        // `auto` resolves the timezone from coords; we override only when
        // the saved location carries an explicit zone (rare path).
        timezone:      timezone || 'auto',
        forecast_days: '2',
    });
    const res = await fetchWithTimeout(`${OPEN_METEO}?${params}`, {
        timeoutMs: FORECAST_TIMEOUT_MS,
        headers:   { Accept: 'application/json' },
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`Open-Meteo HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const json  = await res.json();
    const daily = json?.daily;
    // index 1 = tomorrow (index 0 is today, the local day at the requested tz).
    if (!daily?.time || daily.time.length < 2) {
        throw new Error('forecast missing tomorrow row');
    }
    const i = 1;
    return {
        date:     daily.time[i],
        high:     daily.temperature_2m_max?.[i],
        low:      daily.temperature_2m_min?.[i],
        precip:   daily.precipitation_sum?.[i],
        pop:      daily.precipitation_probability_max?.[i],
        code:     daily.weather_code?.[i],
        windMax:  daily.wind_speed_10m_max?.[i],
        sunrise:  daily.sunrise?.[i],
        sunset:   daily.sunset?.[i],
        uv:       daily.uv_index_max?.[i],
        timezone: json?.timezone,
    };
}

// ── Email composition ──────────────────────────────────────────────────

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wxLabel(code) {
    if (code == null) return 'Mixed';
    if (code === 0)   return 'Clear';
    if (code <= 2)    return 'Partly cloudy';
    if (code === 3)   return 'Overcast';
    if (code <= 49)   return 'Foggy';
    if (code <= 59)   return 'Drizzle';
    if (code <= 69)   return 'Rain';
    if (code <= 79)   return 'Snow';
    if (code <= 84)   return 'Showers';
    if (code <= 99)   return 'Thunderstorms';
    return 'Mixed';
}

function fmtTime(iso, tz) {
    if (!iso) return '–';
    try {
        const d = new Date(iso);
        if (!Number.isFinite(d.getTime())) return '–';
        return d.toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit',
            timeZone: tz || 'UTC',
        });
    } catch {
        return '–';
    }
}

function fmtDate(iso, tz) {
    if (!iso) return 'Tomorrow';
    try {
        // Date-only string ('YYYY-MM-DD') — append T12:00 so timezone
        // shifts don't cross the date line in either direction.
        const d = new Date(iso + 'T12:00:00');
        return d.toLocaleDateString('en-US', {
            weekday: 'long', month: 'short', day: 'numeric',
            timeZone: tz || 'UTC',
        });
    } catch {
        return 'Tomorrow';
    }
}

function buildDigestHtml({ label, city, forecast }) {
    const dateLine = fmtDate(forecast.date, forecast.timezone);
    const high     = forecast.high  != null ? `${Math.round(forecast.high)}°F` : '–';
    const low      = forecast.low   != null ? `${Math.round(forecast.low)}°F`  : '–';
    const pop      = forecast.pop   != null ? `${Math.round(forecast.pop)}%`   : '0%';
    const precip   = forecast.precip != null ? `${forecast.precip.toFixed(2)}″` : '0″';
    const wind     = forecast.windMax != null ? `${Math.round(forecast.windMax)} mph` : '–';
    const uv       = forecast.uv     != null ? Math.round(forecast.uv) : '–';
    const sunrise  = fmtTime(forecast.sunrise, forecast.timezone);
    const sunset   = fmtTime(forecast.sunset,  forecast.timezone);
    const condition = wxLabel(forecast.code);

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px 20px">
  <div style="text-align:center;margin-bottom:18px">
    <span style="font-size:1.05rem;font-weight:800;background:linear-gradient(45deg,#ffd700,#ff8c00);-webkit-background-clip:text;-webkit-text-fill-color:transparent">Parker Physics</span>
    <div style="font-size:.66rem;color:#667;text-transform:uppercase;letter-spacing:.1em;margin-top:2px">Daily Forecast Digest</div>
  </div>
  <div style="background:#12111a;border:1px solid #222;border-radius:12px;padding:20px;margin-bottom:14px">
    <div style="font-size:.66rem;text-transform:uppercase;letter-spacing:.08em;color:#4fc3f7;font-weight:700;margin-bottom:4px">📍 ${escHtml(label)}${city && city !== label ? ` &middot; <span style="color:#778">${escHtml(city)}</span>` : ''}</div>
    <h2 style="margin:0 0 14px;font-size:1.05rem;color:#e8f4ff;font-weight:700">${escHtml(dateLine)}</h2>
    <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:14px">
      <div style="font-size:2.1rem;font-weight:800;color:#ffd700;line-height:1">${high}</div>
      <div style="font-size:1rem;color:#889;line-height:1">/ ${low}</div>
      <div style="font-size:.85rem;color:#cdd;margin-left:auto">${escHtml(condition)}</div>
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:.78rem;color:#cdd;border-collapse:collapse">
      <tr>
        <td style="padding:6px 0;color:#889">Precip chance</td>
        <td style="padding:6px 0;text-align:right;font-weight:600">${pop}${forecast.precip != null && forecast.precip > 0 ? ` &middot; <span style="color:#889;font-weight:400">${precip}</span>` : ''}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#889;border-top:1px solid #222">Max wind</td>
        <td style="padding:6px 0;text-align:right;font-weight:600;border-top:1px solid #222">${wind}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#889;border-top:1px solid #222">UV index</td>
        <td style="padding:6px 0;text-align:right;font-weight:600;border-top:1px solid #222">${uv}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;color:#889;border-top:1px solid #222">Sunrise / sunset</td>
        <td style="padding:6px 0;text-align:right;font-weight:600;border-top:1px solid #222">${sunrise} &middot; ${sunset}</td>
      </tr>
    </table>
  </div>
  <div style="text-align:center">
    <a href="https://parkersphysics.com/dashboard.html" style="display:inline-block;padding:10px 24px;background:linear-gradient(45deg,#ff8c00,#ffd700);color:#000;font-weight:700;border-radius:8px;text-decoration:none;font-size:.82rem">Open Dashboard</a>
  </div>
  <p style="margin-top:20px;font-size:.62rem;color:#445;text-align:center;line-height:1.5">
    You're receiving this because you enabled the daily forecast digest for this location on the Intro plan.<br>
    <a href="https://parkersphysics.com/dashboard.html#saved-locations-card" style="color:#667">Manage digest preferences</a>
  </p>
</div>
</body></html>`;
}

// ── Resend send ────────────────────────────────────────────────────────

async function sendDigestEmail({ recipient, label, subject, html }) {
    const res = await fetchWithTimeout(RESEND_API, {
        method:    'POST',
        timeoutMs: 12_000,
        headers: {
            Authorization:  `Bearer ${RESEND_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from:    FROM_EMAIL,
            to:      recipient,
            subject,
            html,
        }),
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`Resend HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const out = await res.json().catch(() => ({}));
    return out?.id || null;
}

// ── Concurrency-bounded worker pool ────────────────────────────────────

async function processWithLimit(items, limit, worker) {
    const results = [];
    let next = 0;
    async function pump() {
        while (true) {
            const idx = next++;
            if (idx >= items.length) return;
            results[idx] = await worker(items[idx], idx);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
    return results;
}

// ── Handler ────────────────────────────────────────────────────────────

export default async function handler(req) {
    if (!isAuthorized(req)) {
        return jsonResp({ error: 'unauthorized' }, 401);
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonResp({ error: 'supabase_not_configured' }, 500);
    }
    if (!RESEND_KEY) {
        return jsonResp({ error: 'resend_not_configured' }, 501);
    }

    let locations;
    try {
        locations = await fetchEligibleLocations();
    } catch (e) {
        return jsonResp({ error: 'fetch_eligible_failed', detail: e.message }, 502);
    }

    if (!locations.length) {
        return jsonResp({ ok: true, sent: 0, failed: 0, scanned: 0, note: 'no eligible locations' });
    }

    let sent = 0, failed = 0;
    const errors = [];

    await processWithLimit(locations, CONCURRENCY, async (loc) => {
        try {
            const forecast = await fetchTomorrowForecast(loc.lat, loc.lon, loc.timezone);
            const subject  = `Tomorrow at ${loc.label}: ${forecast.high != null ? Math.round(forecast.high) + '°' : '—'} ${wxLabel(forecast.code)}`;
            const html     = buildDigestHtml({ label: loc.label, city: loc.city, forecast });
            await sendDigestEmail({ recipient: loc.email, label: loc.label, subject, html });
            await logSend({
                userId:    loc.userId,
                recipient: loc.email,
                subject,
                throttled: false,
            });
            sent++;
        } catch (e) {
            failed++;
            // Keep the error list bounded so a mass upstream failure doesn't
            // generate a multi-MB response body.
            if (errors.length < 25) errors.push({ loc: loc.label, err: e.message });
        }
    });

    return jsonResp({
        ok:      true,
        scanned: locations.length,
        sent,
        failed,
        errors:  errors.length ? errors : undefined,
    });
}
