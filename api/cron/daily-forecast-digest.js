/**
 * Vercel Edge Cron: /api/cron/daily-forecast-digest
 *
 * Sends a once-daily "your locations" forecast email to every saved
 * location flagged for it. Two tiers:
 *
 *   Intro (basic plan)   → up to 5 digest-enabled locations per user,
 *                          tomorrow's forecast (1-day card)
 *   Pro   (advanced plan) → up to 10 digest-enabled locations per user,
 *                          next-7-days forecast (week strip)
 *
 *   query path:
 *     user_locations  WHERE daily_digest_enabled
 *                       AND notify_enabled
 *                       AND email_alerts_enabled
 *     ⨝ user_profiles WHERE plan IN ('basic','educator','advanced','institution','enterprise')
 *     ⨝ auth.users    (for the recipient email)
 *
 * Per-user digest caps are enforced AFTER the join (group by user_id,
 * order by created_at, take first N). Caps are also enforced client-side
 * in the dashboard so the user sees the cap before they hit it.
 *
 * ── Auth ───────────────────────────────────────────────────────────────
 *   Vercel Cron sends `x-vercel-cron: 1`; when CRON_SECRET is set, it
 *   also sends `Authorization: Bearer <secret>`. We accept either.
 *
 * ── Env ────────────────────────────────────────────────────────────────
 *   SUPABASE_URL          (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY  (or SUPABASE_SECRET_KEY) — service_role
 *   RESEND_API_KEY
 *   ALERT_FROM_EMAIL      (optional, default 'alerts@parkerphysics.com')
 *   CRON_SECRET           (optional but recommended)
 *
 * ── Schedule ───────────────────────────────────────────────────────────
 *   Registered in vercel.json at 11:00 UTC daily (~7am Eastern, 6am
 *   Central, 4am Pacific). UTC keeps the schedule deterministic
 *   regardless of DST. Per-location timezone-aware delivery is a
 *   future enhancement (would require shard-by-tz cron entries).
 *
 * ── Manual / dry-run ───────────────────────────────────────────────────
 *   GET /api/cron/daily-forecast-digest?dry=1
 *     With CRON_SECRET in the Bearer token, returns the planned send
 *     list (no Resend calls, no email_send_log writes). Useful for
 *     verifying eligibility queries + Resend env vars without burning
 *     quota.
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

// Hard global cap so a runaway query can't melt our Resend/Supabase budget.
// At today's user counts (~250 Intro × 5 + ~50 Pro × 10) the worst-case is
// well under 2000; the cap is paranoia headroom.
const MAX_LOCATIONS_PER_RUN = 2000;

// Per-user, per-plan caps on the number of digest-enabled locations we'll
// actually deliver in one run. Locations beyond the cap (ordered by
// created_at ASC) are silently skipped server-side; the dashboard prevents
// users from enabling more than the cap in the first place.
//
// Tier mapping mirrors dashboard.html "_digestPaidLow / High":
//   basic + educator   → 5 locations · 1-day forecast
//   advanced + institution + enterprise → 10 locations · 7-day forecast
const PLAN_DIGEST_CAP = Object.freeze({
    basic:       5,
    educator:    5,
    advanced:    10,
    institution: 10,
    enterprise:  10,
});

// Per-plan forecast horizon in days. Lower tiers get tomorrow only; higher
// tiers get the full week. We always request 8 from Open-Meteo (today + 7)
// and slice from index 1 so "today" never appears in the digest.
const PLAN_FORECAST_DAYS = Object.freeze({
    basic:       1,
    educator:    1,
    advanced:    7,
    institution: 7,
    enterprise:  7,
});

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
    //    `order=created_at.asc` is what makes the per-user cap below
    //    deterministic — first N enabled (oldest first) win.
    const url = `${SUPABASE_URL}/rest/v1/user_locations`
        + `?select=id,user_id,label,lat,lon,city,timezone,created_at,user_profiles!inner(id,plan)`
        + `&daily_digest_enabled=eq.true`
        + `&notify_enabled=eq.true`
        + `&email_alerts_enabled=eq.true`
        + `&user_profiles.plan=in.(basic,educator,advanced,institution,enterprise)`
        + `&order=created_at.asc`
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
    const rawRows = await res.json();
    if (!Array.isArray(rawRows) || rawRows.length === 0) return [];

    // 2) Apply the per-user digest cap (basic: 5, advanced: 10). Inputs are
    //    already sorted by created_at ASC, so a single pass with a per-user
    //    counter gives us the deterministic first-N-per-user slice. The
    //    dashboard prevents over-cap in the first place; this is defense in
    //    depth so a row inserted via the SQL editor still respects the cap.
    const perUser = new Map();   // userId → count kept so far
    const rows = [];
    let droppedOverCap = 0;
    for (const r of rawRows) {
        const plan = r.user_profiles?.plan ?? 'basic';
        const cap  = PLAN_DIGEST_CAP[plan] ?? 0;
        const seen = perUser.get(r.user_id) ?? 0;
        if (seen >= cap) {
            droppedOverCap++;
            continue;
        }
        perUser.set(r.user_id, seen + 1);
        rows.push(r);
    }

    // 3) Look up email addresses for the (now de-duped) set of users.
    const userIds = [...perUser.keys()];
    const emails  = await fetchEmailsForUsers(userIds);

    const out = rows.map(r => ({
        id:       r.id,
        userId:   r.user_id,
        email:    emails.get(r.user_id) || null,
        plan:     r.user_profiles?.plan ?? 'basic',
        label:    r.label || r.city || 'your location',
        city:     r.city  || null,
        lat:      r.lat,
        lon:      r.lon,
        timezone: r.timezone || null,
    })).filter(r => !!r.email);   // skip any users with no resolvable email

    out.__droppedOverCap = droppedOverCap;
    return out;
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
            // Column names match supabase-email-rate-limit-migration.sql:
            // recipient_email (not `recipient`), endpoint, throttled, metadata.
            body: JSON.stringify({
                user_id:         userId,
                endpoint:        'daily-digest',
                recipient_email: recipient,
                subject,
                throttled,
                metadata:        { source: 'cron' },
            }),
        });
    } catch {
        /* swallow */
    }
}

// ── Forecast fetch (1-day or 7-day, point-shape) ───────────────────────

/**
 * Fetch an N-day forecast (N = 1 for Intro, 7 for Pro). Always asks
 * Open-Meteo for `forecastDays + 1` days so we can drop today (index 0)
 * and slice forward — the digest is always about future days.
 *
 * Returns an array of N day objects + the resolved timezone.
 */
async function fetchForecastDays(lat, lon, timezone, forecastDays) {
    const requested = Math.max(1, Math.min(7, forecastDays | 0));
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
        // +1 because index 0 is today and we want `requested` future days.
        forecast_days: String(requested + 1),
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
    if (!daily?.time || daily.time.length < 2) {
        throw new Error('forecast missing future rows');
    }

    const days = [];
    // Slice from index 1 (tomorrow) through requested days. If Open-Meteo
    // returned fewer than asked (rare — high-lat regions in winter), we
    // honor what we got.
    const last = Math.min(daily.time.length, requested + 1);
    for (let i = 1; i < last; i++) {
        days.push({
            date:    daily.time[i],
            high:    daily.temperature_2m_max?.[i],
            low:     daily.temperature_2m_min?.[i],
            precip:  daily.precipitation_sum?.[i],
            pop:     daily.precipitation_probability_max?.[i],
            code:    daily.weather_code?.[i],
            windMax: daily.wind_speed_10m_max?.[i],
            sunrise: daily.sunrise?.[i],
            sunset:  daily.sunset?.[i],
            uv:      daily.uv_index_max?.[i],
        });
    }
    if (!days.length) throw new Error('forecast returned no future days');
    return { days, timezone: json?.timezone };
}

// ── Email composition ──────────────────────────────────────────────────

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Reduce an email to a low-PII identifier for log / dry-run output.
 *   alice.smith@gmail.com → ali***@gmail.com
 * Distinct enough for ops to differentiate users when debugging without
 * round-tripping a full address through HTTP responses.
 */
function maskEmail(email) {
    if (!email || typeof email !== 'string' || !email.includes('@')) return '***';
    const [local, domain] = email.split('@');
    const head = local.slice(0, Math.min(3, local.length));
    return `${head}***@${domain}`;
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

/**
 * Single-day "tomorrow" card body, used for Intro tier and as the lead
 * card for Pro tier (followed by the 7-day strip).
 */
function renderDayCard(day, tz) {
    const dateLine = fmtDate(day.date, tz);
    const high     = day.high  != null ? `${Math.round(day.high)}°F` : '–';
    const low      = day.low   != null ? `${Math.round(day.low)}°F`  : '–';
    const pop      = day.pop   != null ? `${Math.round(day.pop)}%`   : '0%';
    const precip   = day.precip != null ? `${day.precip.toFixed(2)}″` : '0″';
    const wind     = day.windMax != null ? `${Math.round(day.windMax)} mph` : '–';
    const uv       = day.uv     != null ? Math.round(day.uv) : '–';
    const sunrise  = fmtTime(day.sunrise, tz);
    const sunset   = fmtTime(day.sunset,  tz);
    const condition = wxLabel(day.code);
    return `
    <h2 style="margin:0 0 14px;font-size:1.05rem;color:#e8f4ff;font-weight:700">${escHtml(dateLine)}</h2>
    <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:14px">
      <div style="font-size:2.1rem;font-weight:800;color:#ffd700;line-height:1">${high}</div>
      <div style="font-size:1rem;color:#889;line-height:1">/ ${low}</div>
      <div style="font-size:.85rem;color:#cdd;margin-left:auto">${escHtml(condition)}</div>
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:.78rem;color:#cdd;border-collapse:collapse">
      <tr>
        <td style="padding:6px 0;color:#889">Precip chance</td>
        <td style="padding:6px 0;text-align:right;font-weight:600">${pop}${day.precip != null && day.precip > 0 ? ` &middot; <span style="color:#889;font-weight:400">${precip}</span>` : ''}</td>
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
    </table>`;
}

/**
 * Multi-day strip (table-based for Outlook compatibility — flexbox is
 * unreliable in many email clients). Used for Pro tier days 2..7
 * (the lead day is rendered separately via renderDayCard).
 */
function renderWeekTable(days, tz) {
    const cells = days.map(d => {
        const dt = d.date ? new Date(d.date + 'T12:00:00') : null;
        const dayName = dt
            ? dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: tz || 'UTC' })
            : '–';
        const md = dt
            ? dt.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: tz || 'UTC' })
            : '';
        const hi = d.high != null ? `${Math.round(d.high)}°` : '–';
        const lo = d.low  != null ? `${Math.round(d.low)}°`  : '–';
        const pop = d.pop != null && d.pop >= 10 ? `${Math.round(d.pop)}%` : '';
        return `
      <td style="padding:8px 4px;text-align:center;vertical-align:top;width:14%">
        <div style="font-size:.62rem;color:#889;text-transform:uppercase;letter-spacing:.06em;font-weight:700">${escHtml(dayName)}</div>
        <div style="font-size:.55rem;color:#667;margin-bottom:6px">${escHtml(md)}</div>
        <div style="font-size:.7rem;color:#cdd">${escHtml(wxLabel(d.code))}</div>
        <div style="font-size:.95rem;font-weight:700;color:#e8f4ff;margin-top:4px">${hi}</div>
        <div style="font-size:.7rem;color:#778">${lo}</div>
        <div style="font-size:.6rem;color:#4fc3f7;margin-top:3px;min-height:.6rem">${pop}</div>
      </td>`;
    }).join('');
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:4px 0;margin-top:14px">
      <tr>${cells}</tr>
    </table>`;
}

/**
 * Build the email body. Intro: a single-day card. Pro: lead card + the
 * remaining days as a 7-cell horizontal strip.
 */
function buildDigestHtml({ label, city, forecast, plan }) {
    const tz   = forecast.timezone;
    const days = forecast.days;
    const lead = days[0];
    const rest = days.slice(1);
    // High tiers (advanced/institution/enterprise) get the 7-day strip; the
    // rest get tomorrow only. Mirrors PLAN_FORECAST_DAYS above.
    const _highTier = plan === 'advanced' || plan === 'institution' || plan === 'enterprise';
    const planLabel = _highTier ? '7-Day Forecast' : "Tomorrow's Forecast";

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 20px">
  <div style="text-align:center;margin-bottom:18px">
    <span style="font-size:1.05rem;font-weight:800;background:linear-gradient(45deg,#ffd700,#ff8c00);-webkit-background-clip:text;-webkit-text-fill-color:transparent">Parker Physics</span>
    <div style="font-size:.66rem;color:#667;text-transform:uppercase;letter-spacing:.1em;margin-top:2px">${escHtml(planLabel)}</div>
  </div>
  <div style="background:#12111a;border:1px solid #222;border-radius:12px;padding:20px;margin-bottom:14px">
    <div style="font-size:.66rem;text-transform:uppercase;letter-spacing:.08em;color:#4fc3f7;font-weight:700;margin-bottom:4px">📍 ${escHtml(label)}${city && city !== label ? ` &middot; <span style="color:#778">${escHtml(city)}</span>` : ''}</div>
    ${renderDayCard(lead, tz)}
    ${rest.length ? renderWeekTable(rest, tz) : ''}
  </div>
  <div style="text-align:center">
    <a href="https://parkersphysics.com/dashboard.html" style="display:inline-block;padding:10px 24px;background:linear-gradient(45deg,#ff8c00,#ffd700);color:#000;font-weight:700;border-radius:8px;text-decoration:none;font-size:.82rem">Open Dashboard</a>
  </div>
  <p style="margin-top:20px;font-size:.62rem;color:#445;text-align:center;line-height:1.5">
    You're receiving this because you enabled the daily forecast digest for this location.<br>
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

    // Dry-run skips Resend send + email_send_log writes. Useful for ops
    // verification (eligibility query, env vars, plan filter) without
    // actually mailing anyone or burning Resend quota.
    const url    = new URL(req.url);
    const dryRun = url.searchParams.get('dry') === '1';

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
    const errors  = [];
    const dryList = [];

    await processWithLimit(locations, CONCURRENCY, async (loc) => {
        try {
            const days = PLAN_FORECAST_DAYS[loc.plan] ?? 1;
            const fc   = await fetchForecastDays(loc.lat, loc.lon, loc.timezone, days);
            const forecast = { days: fc.days, timezone: fc.timezone };
            const lead     = fc.days[0];
            const subjectPrefix = days === 7 ? 'Week ahead' : 'Tomorrow';
            const subject  = `${subjectPrefix} at ${loc.label}: ${lead.high != null ? Math.round(lead.high) + '°' : '—'} ${wxLabel(lead.code)}`;
            if (dryRun) {
                // Never echo recipient emails back in HTTP responses, even
                // behind CRON_SECRET. Mask to local-part-prefix + domain so
                // ops can still spot bad addresses without a PII trail in
                // Vercel function logs / curl history.
                if (dryList.length < 50) dryList.push({
                    plan:           loc.plan,
                    label:          loc.label,
                    city:           loc.city,
                    days,
                    leadHigh:       lead.high,
                    leadCode:       lead.code,
                    subject,
                    recipientMasked: maskEmail(loc.email),
                });
            } else {
                const html = buildDigestHtml({
                    label:    loc.label,
                    city:     loc.city,
                    forecast,
                    plan:     loc.plan,
                });
                await sendDigestEmail({ recipient: loc.email, label: loc.label, subject, html });
                await logSend({
                    userId:    loc.userId,
                    recipient: loc.email,
                    subject,
                    throttled: false,
                });
            }
            sent++;
        } catch (e) {
            failed++;
            // Keep the error list bounded so a mass upstream failure doesn't
            // generate a multi-MB response body.
            if (errors.length < 25) errors.push({ loc: loc.label, err: e.message });
        }
    });

    return jsonResp({
        ok:              true,
        dryRun,
        scanned:         locations.length,
        droppedOverCap:  locations.__droppedOverCap || 0,
        sent,
        failed,
        errors:          errors.length ? errors : undefined,
        previewSample:   dryRun ? dryList : undefined,
    });
}
