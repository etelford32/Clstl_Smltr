/**
 * Vercel Edge Function: /api/contact/enterprise
 *
 * Public, unauthenticated lead-capture endpoint for the Enterprise tier.
 * Persists the lead to the enterprise_leads Supabase table (RLS allows
 * anonymous insert with input-validation policy) and sends a notification
 * email to the sales team via Resend.
 *
 * POST /api/contact/enterprise
 *   Body: {
 *     name:         string  (required, 1–120 chars)
 *     email:        string  (required, valid email)
 *     organization: string  (optional, ≤120 chars)
 *     role_title:   string  (optional, ≤120 chars)
 *     use_case:     string[] (optional, subset of allowed values)
 *     message:      string  (optional, ≤4000 chars)
 *     hp_field:     string  (honeypot — must be empty)
 *   }
 *
 * Returns:
 *   200 { ok: true, lead_id }
 *   400 { error: 'invalid_body'|'invalid_email'|'invalid_use_case'|'too_long' }
 *   403 { error: 'origin_blocked' }
 *   429 { error: 'rate_limited' }
 *   500 { error: 'persist_failed', detail }
 *   501 { error: 'not_configured' }
 *
 * ── Env vars ─────────────────────────────────────────────────────────
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY  — service-role; bypasses RLS for the insert + read
 *   RESEND_API_KEY        — for the sales-team notification email (optional)
 *   SALES_EMAIL           — destination address (default: sales@parkerphysics.com)
 *   ALERT_FROM_EMAIL      — From: address (reused from alerts module)
 *   APP_URL               — used for the admin link in the notification email
 *   ALLOWED_ORIGINS       — comma-list; defaults to parkerphysics.com + .app
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const RESEND_API    = 'https://api.resend.com/emails';
const RESEND_KEY    = process.env.RESEND_API_KEY || '';
const SALES_EMAIL   = process.env.SALES_EMAIL || 'sales@parkerphysics.com';
const FROM_EMAIL    = process.env.ALERT_FROM_EMAIL || 'Parker Physics <noreply@parkerphysics.com>';
const APP_URL       = process.env.APP_URL || 'https://parkerphysics.com';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    || 'https://parkerphysics.com,https://www.parkerphysics.com,https://parkerphysics.app,https://www.parkerphysics.app')
    .split(',').map(s => s.trim()).filter(Boolean);

// Allowed use-case tags. The frontend renders these as checkboxes and
// stuffs the selection into a string[] column. Restricting to a known
// vocabulary makes the lead row useful for filtering — and prevents
// arbitrary user-controlled tags from polluting downstream reports.
const VALID_USE_CASES = new Set([
    'satellite_operations',
    'anomaly_correlation',
    'gnss_scintillation',
    'launch_window',
    'financial_services',
    'university_research',
    'public_outreach',
    'k12_district',
    'planetarium',
    'media_broadcast',
    'other',
]);

// Per-IP rate limit (best-effort, in-memory; isolates each Vercel POP).
// A spammer can rotate IPs / POPs around it, but the Supabase RLS check
// + the email validation regex push the per-attempt cost up enough that
// a botnet hitting it would just hit the persist_failed code path.
const RATE_LIMIT = { windowMs: 60_000, max: 6 };
const _hits = new Map();

function _clientIp(req) {
    return req.headers.get('x-forwarded-for')?.split(',')[0].trim()
        || req.headers.get('x-real-ip')
        || 'unknown';
}
function _checkRate(ip) {
    const now = Date.now();
    const list = (_hits.get(ip) || []).filter(t => now - t < RATE_LIMIT.windowMs);
    if (list.length >= RATE_LIMIT.max) return false;
    list.push(now);
    _hits.set(ip, list);
    return true;
}

function json(body, status = 200) {
    return Response.json(body, {
        status,
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Cache-Control':                'no-store',
        },
    });
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _isValidEmail(email) {
    return typeof email === 'string'
        && email.length <= 200
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function _persistLead(lead) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/enterprise_leads`, {
        method: 'POST',
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type':'application/json',
            Prefer:        'return=representation',
        },
        body: JSON.stringify(lead),
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Supabase ${res.status}: ${detail}`);
    }
    const rows = await res.json();
    return rows?.[0]?.id;
}

async function _notifySales(lead) {
    if (!RESEND_KEY) return; // optional — email is nice-to-have, lead row is the source of truth
    const useCases = (lead.use_case || []).map(escHtml).join(', ') || '(none specified)';
    const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0a0a14;color:#e8f4ff;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#12111a;border:1px solid #222;border-radius:12px;padding:24px">
    <h2 style="margin:0 0 12px;color:#ffd700">New Enterprise lead</h2>
    <p style="margin:0 0 14px;font-size:.9rem;color:#aab"><strong style="color:#fff">${escHtml(lead.name)}</strong> &lt;${escHtml(lead.email)}&gt;</p>
    <p style="margin:0 0 6px;font-size:.85rem;color:#aab"><strong>Organization:</strong> ${escHtml(lead.organization || '—')}</p>
    <p style="margin:0 0 6px;font-size:.85rem;color:#aab"><strong>Role:</strong> ${escHtml(lead.role_title || '—')}</p>
    <p style="margin:0 0 14px;font-size:.85rem;color:#aab"><strong>Use cases:</strong> ${useCases}</p>
    <hr style="border:none;border-top:1px solid #333;margin:14px 0">
    <p style="margin:0 0 14px;font-size:.88rem;color:#cdd;white-space:pre-wrap">${escHtml(lead.message || '(no additional message)')}</p>
    <p style="margin:18px 0 0;font-size:.75rem;color:#778"><a href="${APP_URL}/admin.html#leads" style="color:#a080ff">Open admin → leads</a></p>
  </div>
</body></html>`;
    try {
        await fetch(RESEND_API, {
            method:  'POST',
            headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from:    FROM_EMAIL,
                to:      SALES_EMAIL,
                reply_to: lead.email,
                subject: `[Enterprise lead] ${lead.organization || lead.name}`,
                html,
            }),
            signal: AbortSignal.timeout(8000),
        });
    } catch (e) {
        console.warn('[contact/enterprise] sales notification failed:', e.message);
    }
}

export default async function handler(req) {
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin':  '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            },
        });
    }
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!SUPABASE_KEY)         return json({ error: 'not_configured', detail: 'SUPABASE_SERVICE_KEY missing' }, 501);

    // Origin allow-list — defense in depth against CSRF-style abuse from
    // hostile pages submitting on a logged-in user's behalf. The lead form
    // is anonymous so this is mostly a spam filter.
    const origin = req.headers.get('Origin') || '';
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        return json({ error: 'origin_blocked' }, 403);
    }

    const ip = _clientIp(req);
    if (!_checkRate(ip)) return json({ error: 'rate_limited', detail: `Max ${RATE_LIMIT.max} submissions per minute` }, 429);

    let body;
    try { body = await req.json(); }
    catch { return json({ error: 'invalid_body' }, 400); }

    // Honeypot — if a bot fills the hidden field, accept the request silently
    // (200 OK with no DB write) so the bot moves on instead of retrying.
    if (typeof body.hp_field === 'string' && body.hp_field.length > 0) {
        return json({ ok: true });
    }

    const name         = String(body.name ?? '').trim();
    const email        = String(body.email ?? '').trim().toLowerCase();
    const organization = body.organization ? String(body.organization).trim().slice(0, 120) : null;
    const roleTitle    = body.role_title   ? String(body.role_title).trim().slice(0, 120)   : null;
    const message      = body.message      ? String(body.message).slice(0, 4000)            : null;

    if (!name || name.length > 120) return json({ error: 'invalid_body', detail: 'name must be 1–120 characters' }, 400);
    if (!_isValidEmail(email))      return json({ error: 'invalid_email' }, 400);

    let useCase = [];
    if (Array.isArray(body.use_case)) {
        for (const uc of body.use_case) {
            if (typeof uc !== 'string') continue;
            if (!VALID_USE_CASES.has(uc)) {
                return json({ error: 'invalid_use_case', detail: `Unknown use case: ${uc}` }, 400);
            }
            if (useCase.length < 12) useCase.push(uc);
        }
    }

    const userAgent = req.headers.get('User-Agent')?.slice(0, 300) || null;

    let leadId;
    try {
        leadId = await _persistLead({
            name,
            email,
            organization,
            role_title: roleTitle,
            use_case:   useCase,
            message,
            source_ip:  ip.slice(0, 64),
            user_agent: userAgent,
        });
    } catch (e) {
        return json({ error: 'persist_failed', detail: e.message }, 500);
    }

    // Fire-and-forget — failure to email sales does not block the lead
    // from being captured. The admin dashboard reads from the table.
    await _notifySales({ name, email, organization, role_title: roleTitle, use_case: useCase, message });

    return json({ ok: true, lead_id: leadId });
}
