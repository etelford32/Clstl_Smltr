/**
 * Vercel Edge Function: /api/contact/feedback
 *
 * Public, unauthenticated feedback endpoint for feature requests and bug
 * reports submitted from /feedback.html. Persists the submission to the
 * feedback_submissions Supabase table (RLS allows anonymous insert) and
 * fires a notification email to the team via Resend.
 *
 * POST /api/contact/feedback
 *   Body: {
 *     kind:       'feature_request' | 'bug_report' | 'general'
 *     page:       string? (≤80 chars; the page or simulator the feedback is about)
 *     subject:    string  (required, 1–160 chars)
 *     message:    string  (required, 1–4000 chars)
 *     email:      string? (optional reply-to; ≤200 chars; valid email)
 *     user_agent: string? (≤300 chars)
 *     url:        string? (≤500 chars; page the form was submitted from)
 *     hp_field:   string  (honeypot — must be empty)
 *   }
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const RESEND_API    = 'https://api.resend.com/emails';
const RESEND_KEY    = process.env.RESEND_API_KEY || '';
const FEEDBACK_EMAIL = process.env.FEEDBACK_EMAIL || process.env.SALES_EMAIL || 'feedback@parkerphysics.com';
const FROM_EMAIL    = process.env.ALERT_FROM_EMAIL || 'Parkers Physics <noreply@parkerphysics.com>';
const APP_URL       = process.env.APP_URL || 'https://parkerphysics.com';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    || 'https://parkerphysics.com,https://www.parkerphysics.com,https://parkerphysics.app,https://www.parkerphysics.app')
    .split(',').map(s => s.trim()).filter(Boolean);

const VALID_KINDS = new Set(['feature_request', 'bug_report', 'general']);

// Per-IP rate limit (best-effort, in-memory; isolates each Vercel POP).
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

async function _persistFeedback(row) {
    if (!SUPABASE_KEY) return null; // best-effort persistence; email is the source-of-truth fallback
    const res = await fetch(`${SUPABASE_URL}/rest/v1/feedback_submissions`, {
        method: 'POST',
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type':'application/json',
            Prefer:        'return=representation',
        },
        body: JSON.stringify(row),
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Supabase ${res.status}: ${detail}`);
    }
    const rows = await res.json();
    return rows?.[0]?.id ?? null;
}

const KIND_LABEL = {
    feature_request: 'Feature request',
    bug_report:      'Bug report',
    general:         'General feedback',
};

async function _notifyTeam(item) {
    if (!RESEND_KEY) return;
    const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0a0a14;color:#e8f4ff;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#12111a;border:1px solid #222;border-radius:12px;padding:24px">
    <h2 style="margin:0 0 12px;color:#ffd700">${escHtml(KIND_LABEL[item.kind] || 'Feedback')}</h2>
    <p style="margin:0 0 6px;font-size:.85rem;color:#aab"><strong>Subject:</strong> ${escHtml(item.subject)}</p>
    <p style="margin:0 0 6px;font-size:.85rem;color:#aab"><strong>Page:</strong> ${escHtml(item.page || '—')}</p>
    <p style="margin:0 0 6px;font-size:.85rem;color:#aab"><strong>From:</strong> ${escHtml(item.email || '(anonymous)')}</p>
    <p style="margin:0 0 6px;font-size:.78rem;color:#778"><strong>URL:</strong> ${escHtml(item.url || '—')}</p>
    <p style="margin:0 0 14px;font-size:.78rem;color:#778"><strong>UA:</strong> ${escHtml(item.user_agent || '—')}</p>
    <hr style="border:none;border-top:1px solid #333;margin:14px 0">
    <p style="margin:0 0 14px;font-size:.88rem;color:#cdd;white-space:pre-wrap">${escHtml(item.message)}</p>
    <p style="margin:18px 0 0;font-size:.75rem;color:#778"><a href="${APP_URL}/admin.html#feedback" style="color:#a080ff">Open admin → feedback</a></p>
  </div>
</body></html>`;
    try {
        await fetch(RESEND_API, {
            method:  'POST',
            headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from:     FROM_EMAIL,
                to:       FEEDBACK_EMAIL,
                reply_to: item.email || undefined,
                subject:  `[${KIND_LABEL[item.kind] || 'Feedback'}] ${item.subject}`,
                html,
            }),
            signal: AbortSignal.timeout(8000),
        });
    } catch (e) {
        console.warn('[contact/feedback] team notification failed:', e.message);
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

    // We accept submissions when EITHER persistence (Supabase) OR notification
    // (Resend) is configured. If neither is set the form has nowhere to land.
    if (!SUPABASE_KEY && !RESEND_KEY) {
        return json({ error: 'not_configured', detail: 'Feedback sink is not configured' }, 501);
    }

    const origin = req.headers.get('Origin') || '';
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        return json({ error: 'origin_blocked' }, 403);
    }

    const ip = _clientIp(req);
    if (!_checkRate(ip)) return json({ error: 'rate_limited', detail: `Max ${RATE_LIMIT.max} submissions per minute` }, 429);

    let body;
    try { body = await req.json(); }
    catch { return json({ error: 'invalid_body' }, 400); }

    // Honeypot — silently accept so bots don't retry.
    if (typeof body.hp_field === 'string' && body.hp_field.length > 0) {
        return json({ ok: true });
    }

    const kind    = String(body.kind ?? '').trim();
    const subject = String(body.subject ?? '').trim();
    const message = String(body.message ?? '').trim();
    const page    = body.page    ? String(body.page).trim().slice(0, 80)    : null;
    const email   = body.email   ? String(body.email).trim().toLowerCase()  : null;
    const url     = body.url     ? String(body.url).slice(0, 500)           : null;
    const ua      = body.user_agent ? String(body.user_agent).slice(0, 300) : (req.headers.get('User-Agent')?.slice(0, 300) || null);

    if (!VALID_KINDS.has(kind))                         return json({ error: 'invalid_kind' }, 400);
    if (!subject || subject.length > 160)               return json({ error: 'invalid_body', detail: 'subject must be 1–160 characters' }, 400);
    if (!message || message.length > 4000)              return json({ error: 'invalid_body', detail: 'message must be 1–4000 characters' }, 400);
    if (email && !_isValidEmail(email))                 return json({ error: 'invalid_email' }, 400);

    const row = {
        kind,
        page,
        subject,
        message,
        email,
        url,
        source_ip:  ip.slice(0, 64),
        user_agent: ua,
    };

    let feedbackId = null;
    try {
        feedbackId = await _persistFeedback(row);
    } catch (e) {
        // Persistence failure is not fatal — fall through to email so the
        // submission still reaches the team. Surface a warning in logs.
        console.warn('[contact/feedback] persist failed, continuing to email:', e.message);
    }

    await _notifyTeam(row);

    return json({ ok: true, feedback_id: feedbackId });
}
