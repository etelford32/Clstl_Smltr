/**
 * Vercel Edge Function: /api/alerts/email
 *
 * Sends alert notification emails to users via Resend (https://resend.com).
 * Called by the client-side AlertEngine when a user has email_alerts enabled.
 *
 * ── Security ─────────────────────────────────────────────────────────────────
 *  - Validates the Supabase JWT from the Authorization header
 *  - Only sends to the authenticated user's own email (no arbitrary recipients)
 *  - Rate-limited: max 10 emails per user per hour, tracked in
 *    public.email_send_log via the try_send_email_quota RPC. The DB-
 *    backed limit is global across Vercel POPs (the previous in-memory
 *    counter could be bypassed by hitting different edge regions).
 *  - Every send attempt — allowed or throttled — gets a row in the
 *    log, which the admin dashboard reads as audit + analytics.
 *  - Requires RESEND_API_KEY env var (set in Vercel Dashboard → Settings → Env)
 *
 * ── Request ──────────────────────────────────────────────────────────────────
 *  POST /api/alerts/email
 *  Headers:  Authorization: Bearer <supabase-jwt>
 *  Body:     { title, body, severity, alert_type, metadata,
 *              location_label?, location_city? }
 *
 *  When location_label is present the email subject includes it and the HTML
 *  shows it as a small chip next to the severity label, so multi-location
 *  subscribers can tell at a glance which spot fired the alert.
 *
 * ── Response ─────────────────────────────────────────────────────────────────
 *  200: { sent: true, id: "<resend-message-id>" }
 *  401: { error: "unauthorized" }
 *  429: { error: "rate_limited" }
 *  500: { error: "send_failed", detail: "..." }
 *  501: { error: "not_configured" }  (RESEND_API_KEY not set)
 *
 * ── Setup ────────────────────────────────────────────────────────────────────
 *  1. Create a Resend account at https://resend.com (free tier: 3,000 emails/month)
 *  2. Add your domain or use the default onboarding@resend.dev sender
 *  3. Copy your API key → Vercel Dashboard → Settings → Environment Variables
 *     Name: RESEND_API_KEY   Value: re_xxxxxxxxx
 *  4. Optionally set ALERT_FROM_EMAIL (default: alerts@parkerphysics.com)
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://aijsboodkivnhzfstvdq.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || '';
const RESEND_API    = 'https://api.resend.com/emails';
const RESEND_KEY    = process.env.RESEND_API_KEY || '';
const FROM_EMAIL    = process.env.ALERT_FROM_EMAIL || 'Parker Physics Alerts <alerts@parkerphysics.com>';
const MAX_PER_HOUR  = 10;

function jsonResp(body, status = 200) {
    return Response.json(body, {
        status,
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
    });
}

/** Verify Supabase JWT and return user info. */
async function verifyJwt(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);

    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: {
                Authorization: `Bearer ${token}`,
                apikey: SUPABASE_KEY || token,  // service key preferred, fall back to user token
            },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const user = await res.json();
        return user?.email ? { id: user.id, email: user.email } : null;
    } catch {
        return null;
    }
}

/**
 * DB-backed rate limit + audit log via try_send_email_quota RPC.
 * Atomically checks whether the user is under their hourly cap and
 * inserts a row in email_send_log (with throttled set accordingly).
 *
 * Returns true if the caller may proceed to send the email.
 *
 * On Supabase / network failure we FAIL OPEN — log a warning and let
 * the send proceed. The alternative (fail closed) would mean a
 * single Supabase blip blocks every user's alerts. The endpoint is
 * still gated by JWT validation and by Resend's own per-key limits.
 */
async function checkRate({ userId, recipient, subject, severity, alertType }) {
    if (!SUPABASE_KEY) return true;     // not configured — skip
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/try_send_email_quota`, {
            method:  'POST',
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type':'application/json',
            },
            body: JSON.stringify({
                p_user_id:        userId,
                p_endpoint:       'alerts',
                p_recipient:      recipient,
                p_subject:        subject,
                p_metadata:       { severity, alert_type: alertType },
                p_limit:          MAX_PER_HOUR,
                p_window_seconds: 3600,
            }),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
            console.warn('[alerts/email] quota RPC HTTP', res.status, '— failing open');
            return true;
        }
        const allowed = await res.json();
        return allowed === true;
    } catch (e) {
        console.warn('[alerts/email] quota RPC error:', e.message, '— failing open');
        return true;
    }
}

/** Build a clean HTML email body. */
function buildEmailHtml(title, body, severity, alertType, locationLabel) {
    const sevColor = severity === 'critical' ? '#ff3344' : severity === 'warning' ? '#ffaa00' : '#44cc88';
    const sevLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
    const locChip  = locationLabel
        ? `<span style="display:inline-block;background:rgba(79,195,247,.14);color:#4fc3f7;font-size:.64rem;padding:2px 8px;border-radius:10px;font-weight:700;letter-spacing:.03em">📍 ${escHtml(locationLabel)}</span>`
        : '';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 20px">
  <div style="text-align:center;margin-bottom:20px">
    <span style="font-size:1.1rem;font-weight:800;background:linear-gradient(45deg,#ffd700,#ff8c00);-webkit-background-clip:text;-webkit-text-fill-color:transparent">Parker Physics</span>
  </div>
  <div style="background:#12111a;border:1px solid #222;border-radius:12px;padding:20px;margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${sevColor}"></span>
      <span style="font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:${sevColor};font-weight:700">${sevLabel} &middot; ${alertType}</span>
      ${locChip}
    </div>
    <h2 style="margin:0 0 8px;font-size:1.15rem;color:#e8f4ff;font-weight:700">${escHtml(title)}</h2>
    <p style="margin:0;font-size:.88rem;color:#99aabb;line-height:1.6">${escHtml(body)}</p>
  </div>
  <div style="text-align:center">
    <a href="https://parkerphysics.com/dashboard.html" style="display:inline-block;padding:10px 24px;background:linear-gradient(45deg,#ff8c00,#ffd700);color:#000;font-weight:700;border-radius:8px;text-decoration:none;font-size:.82rem">View Dashboard</a>
  </div>
  <p style="margin-top:20px;font-size:.65rem;color:#445;text-align:center;line-height:1.5">
    You're receiving this because you enabled email alerts in your Parker Physics dashboard.<br>
    <a href="https://parkerphysics.com/dashboard.html#saved-locations-card" style="color:#667">Manage alert preferences &amp; locations</a>
  </p>
</div>
</body></html>`;
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default async function handler(req) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin':  '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            },
        });
    }

    if (req.method !== 'POST') {
        return jsonResp({ error: 'method_not_allowed' }, 405);
    }

    // Check Resend configuration
    if (!RESEND_KEY) {
        return jsonResp({ error: 'not_configured', detail: 'RESEND_API_KEY env var not set' }, 501);
    }

    // Authenticate user
    const user = await verifyJwt(req.headers.get('Authorization'));
    if (!user) {
        return jsonResp({ error: 'unauthorized' }, 401);
    }

    // Parse body BEFORE rate-check so the log row carries the actual
    // alert metadata (subject, severity) for admin analytics.
    let payload;
    try {
        payload = await req.json();
    } catch {
        return jsonResp({ error: 'invalid_body' }, 400);
    }

    const {
        title, body, severity = 'info', alert_type = 'storm',
        location_label = null,
    } = payload;
    if (!title || !body) {
        return jsonResp({ error: 'missing_fields', detail: 'title and body required' }, 400);
    }

    // Pre-build subject so the rate-limit log row matches what gets sent.
    const locPrefixForLog = location_label ? `[${location_label}] ` : '';
    const logSubject      = `[${severity.toUpperCase()}] ${locPrefixForLog}${title}`;

    // DB-backed rate limit + audit insert (atomic, global across POPs).
    const allowed = await checkRate({
        userId:    user.id,
        recipient: user.email,
        subject:   logSubject,
        severity,
        alertType: alert_type,
    });
    if (!allowed) {
        return jsonResp({ error: 'rate_limited', detail: `Max ${MAX_PER_HOUR} emails per hour` }, 429);
    }

    // Subject already computed above (logSubject) so the audit log
    // and the actual Resend message carry the same string.
    const subject = logSubject;

    // Send via Resend
    try {
        const res = await fetch(RESEND_API, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${RESEND_KEY}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({
                from:    FROM_EMAIL,
                to:      user.email,
                subject,
                html:    buildEmailHtml(title, body, severity, alert_type, location_label),
            }),
            signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
            const err = await res.text();
            return jsonResp({ error: 'send_failed', detail: err }, 500);
        }

        const result = await res.json();
        return jsonResp({ sent: true, id: result.id });
    } catch (e) {
        return jsonResp({ error: 'send_failed', detail: e.message }, 500);
    }
}
