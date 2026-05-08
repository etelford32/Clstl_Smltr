/**
 * Vercel Edge Function: /api/class/invite
 *
 * Class-seat invite. Educator / Institution / Enterprise users (and
 * admins) issue an invite for a student/staff seat under their
 * subscription. The invite is a normal invite_codes row with
 * is_class_seat=TRUE; the recipient redeems it via apply_class_invite()
 * which sets parent_account_id on their profile and bumps the
 * inviter's seats_used.
 *
 * This is the missing piece for Educator's $25/30-seat sale to mean
 * anything to a real teacher.
 *
 * ── Request ─────────────────────────────────────────────────────
 *  POST /api/class/invite
 *  Headers: Authorization: Bearer <user-jwt>
 *  Body:    { email, name?, expiry_days? }
 *
 * ── Response ────────────────────────────────────────────────────
 *  200: { ok: true, code, invite_id, link, sent_to, seats_remaining }
 *  400: { error: 'missing_email' | 'invalid_email' }
 *  401: { error: 'unauthorized' }
 *  402: { error: 'no_seats', detail: 'Class is full…' }
 *  403: { error: 'forbidden', detail: 'Plan does not include classroom seats' }
 *  429: { error: 'rate_limited' }
 *  500/501: error envelopes
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://aijsboodkivnhzfstvdq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const RESEND_API   = 'https://api.resend.com/emails';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const FROM_EMAIL   = process.env.INVITE_FROM_EMAIL
                  || process.env.ALERT_FROM_EMAIL
                  || 'Parkers Physics <invites@parkerphysics.com>';
const APP_URL      = process.env.APP_URL || 'https://parkerphysics.com';

// Plans that include seat capacity. Admins bypass via role check.
const SEATED_PLANS = new Set(['educator', 'institution', 'enterprise']);

// 60 invites/hour/user. Higher than personal-alerts (10/hr) because
// a teacher legitimately bulk-imports a class roster, but tight enough
// that a compromised account can't spam thousands of unique addresses.
const MAX_PER_HOUR = 60;
const CODE_ALPHA   = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN     = 8;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    || 'https://parkerphysics.com,https://parkersphysics.com,https://parkerphysics.app')
    .split(',').map(s => s.trim()).filter(Boolean);

function corsHeaders(origin) {
    const ok = origin && ALLOWED_ORIGINS.includes(origin);
    return {
        'Access-Control-Allow-Origin':  ok ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Cache-Control':                'no-store',
    };
}

function jsonResp(body, status = 200, origin = '') {
    return Response.json(body, { status, headers: corsHeaders(origin) });
}

function generateCode() {
    const arr = new Uint8Array(CODE_LEN);
    crypto.getRandomValues(arr);
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHA[arr[i] % CODE_ALPHA.length];
    return code;
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Verify Supabase JWT and read the caller's profile (plan, role,
 * classroom_seats, seats_used, display_name). Returns null on auth
 * failure.
 */
async function verifyUser(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);

    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY || token },
        signal: AbortSignal.timeout(8000),
    });
    if (!userRes.ok) return null;
    const user = await userRes.json();
    if (!user?.id) return null;

    const profileRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${user.id}&select=role,plan,classroom_seats,seats_used,display_name`,
        {
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
            signal: AbortSignal.timeout(8000),
        }
    );
    if (!profileRes.ok) return null;
    const rows = await profileRes.json();
    const profile = Array.isArray(rows) ? rows[0] : null;
    if (!profile) return null;

    return {
        user_id:         user.id,
        email:           user.email,
        role:            profile.role,
        plan:            profile.plan,
        classroom_seats: profile.classroom_seats,
        seats_used:      profile.seats_used ?? 0,
        display_name:    profile.display_name,
    };
}

async function checkRate({ userId, recipient, subject }) {
    if (!SUPABASE_KEY) return true;
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
                p_endpoint:       'class_invite',
                p_recipient:      recipient,
                p_subject:        subject,
                p_metadata:       { kind: 'class_seat' },
                p_limit:          MAX_PER_HOUR,
                p_window_seconds: 3600,
            }),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return true;   // fail open on infra hiccup
        return (await res.json()) === true;
    } catch { return true; }
}

async function insertClassInvite({ code, invitedEmail, expiryDays, createdBy }) {
    const expiresAt = expiryDays > 0
        ? new Date(Date.now() + expiryDays * 86400_000).toISOString()
        : null;

    const res = await fetch(`${SUPABASE_URL}/rest/v1/invite_codes`, {
        method:  'POST',
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type':'application/json',
            Prefer:        'return=representation',
        },
        body: JSON.stringify({
            code,
            // Class seats don't carry a plan tier — the student's
            // effective plan is resolved at runtime via parent_account_id.
            // Stamp 'free' so the CHECK constraint passes.
            plan:          'free',
            is_class_seat: true,
            max_uses:      1,
            used_count:    0,
            invited_email: invitedEmail,
            sent_at:       new Date().toISOString(),
            expires_at:    expiresAt,
            created_by:    createdBy,
            active:        true,
        }),
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Supabase insert ${res.status}: ${txt}`);
    }
    const rows = await res.json();
    return rows?.[0]?.id;
}

function buildInviteHtml({ recipientEmail, link, code, inviterName, planLabel }) {
    const inviter = inviterName ? `<strong style="color:#fff">${escHtml(inviterName)}</strong>` : `your instructor`;
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 20px">
  <div style="text-align:center;margin-bottom:20px">
    <span style="font-size:1.1rem;font-weight:800;background:linear-gradient(45deg,#ffd700,#ff8c00);-webkit-background-clip:text;-webkit-text-fill-color:transparent">Parkers Physics</span>
  </div>
  <div style="background:#12111a;border:1px solid #222;border-radius:12px;padding:24px;margin-bottom:16px">
    <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:#80d4ff;font-weight:700;margin-bottom:14px">Class invite — ${escHtml(planLabel)}</div>
    <h2 style="margin:0 0 12px;font-size:1.25rem;color:#e8f4ff;font-weight:700">You're in.</h2>
    <p style="margin:0 0 18px;font-size:.92rem;color:#aab;line-height:1.6">
      ${inviter} added you to their Parkers Physics class. Real-time space-weather data, satellite tracking, and 17+ interactive astrophysics simulations — at no cost to you while you're enrolled.
    </p>
    <div style="text-align:center;margin:24px 0">
      <a href="${escHtml(link)}" style="display:inline-block;padding:12px 28px;background:linear-gradient(45deg,#ff8c00,#ffd700);color:#000;font-weight:700;border-radius:8px;text-decoration:none;font-size:.9rem">Accept &amp; create your account →</a>
    </div>
    <p style="margin:0;font-size:.78rem;color:#778;line-height:1.6">
      Or copy this link:<br>
      <code style="word-break:break-all;color:#9ad;font-size:.74rem">${escHtml(link)}</code>
    </p>
    <p style="margin:18px 0 0;font-size:.78rem;color:#778;line-height:1.6">
      Invite code: <code style="color:#fff;letter-spacing:.1em;background:#0a0a14;padding:3px 8px;border-radius:4px">${escHtml(code)}</code>
    </p>
  </div>
  <p style="margin-top:18px;font-size:.65rem;color:#445;text-align:center;line-height:1.5">
    Sent to <strong>${escHtml(recipientEmail)}</strong>. If you weren't expecting this, you can ignore the message.
  </p>
</div>
</body></html>`;
}

export default async function handler(req) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (req.method !== 'POST')   return jsonResp({ error: 'method_not_allowed' }, 405, origin);
    if (!SUPABASE_KEY)           return jsonResp({ error: 'not_configured', detail: 'SUPABASE_SERVICE_KEY missing' }, 501, origin);
    if (!RESEND_KEY)             return jsonResp({ error: 'not_configured', detail: 'RESEND_API_KEY missing' }, 501, origin);

    // Origin allow-list (defense-in-depth; JWT is the primary gate)
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        return jsonResp({ error: 'forbidden_origin' }, 403, origin);
    }

    const auth = await verifyUser(req.headers.get('Authorization'));
    if (!auth) return jsonResp({ error: 'unauthorized' }, 401, origin);

    // Tier gate: must hold a seated plan (or be admin/superadmin).
    const isAdmin = auth.role === 'admin' || auth.role === 'superadmin';
    if (!isAdmin && !SEATED_PLANS.has(auth.plan)) {
        return jsonResp({
            error: 'forbidden',
            detail: 'Class invites require an Educator, Institution, or Enterprise plan.',
        }, 403, origin);
    }

    let payload;
    try { payload = await req.json(); }
    catch { return jsonResp({ error: 'invalid_body' }, 400, origin); }

    const recipientEmail = String(payload.email ?? '').trim().toLowerCase();
    const expiryDays     = Number.isFinite(+payload.expiry_days) ? +payload.expiry_days : 30;

    if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
        return jsonResp({ error: 'invalid_email' }, 400, origin);
    }

    // Seat-cap check (admins bypass).
    if (!isAdmin) {
        const seats = auth.classroom_seats ?? 0;
        const used  = auth.seats_used     ?? 0;
        if (seats <= 0 || used >= seats) {
            return jsonResp({
                error:  'no_seats',
                detail: `Class is full (${used}/${seats} seats used). Remove a student or upgrade your plan.`,
                seats_remaining: Math.max(0, seats - used),
            }, 402, origin);
        }
    }

    const subject = `You've been added to a Parkers Physics class`;
    const allowed = await checkRate({
        userId:    auth.user_id,
        recipient: recipientEmail,
        subject,
    });
    if (!allowed) {
        return jsonResp({ error: 'rate_limited', detail: `Max ${MAX_PER_HOUR} class invites per hour.` }, 429, origin);
    }

    // Generate + persist the invite row.
    const code = generateCode();
    let inviteId;
    try {
        inviteId = await insertClassInvite({
            code,
            invitedEmail: recipientEmail,
            expiryDays,
            createdBy:    auth.user_id,
        });
    } catch (e) {
        return jsonResp({ error: 'persist_failed', detail: e.message }, 500, origin);
    }

    const link = `${APP_URL}/signup?code=${encodeURIComponent(code)}`
              +  `&email=${encodeURIComponent(recipientEmail)}`;

    const planLabel = auth.plan === 'institution' ? 'Institution'
                    : auth.plan === 'enterprise'  ? 'Enterprise'
                    : 'Educator';

    const html = buildInviteHtml({
        recipientEmail,
        link,
        code,
        inviterName: auth.display_name,
        planLabel,
    });

    try {
        const sendRes = await fetch(RESEND_API, {
            method:  'POST',
            headers: {
                Authorization:  `Bearer ${RESEND_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from:    FROM_EMAIL,
                to:      recipientEmail,
                subject,
                html,
            }),
            signal: AbortSignal.timeout(10000),
        });
        if (!sendRes.ok) {
            const detail = await sendRes.text().catch(() => '');
            return jsonResp({ error: 'send_failed', detail, code, invite_id: inviteId, link }, 500, origin);
        }
    } catch (e) {
        return jsonResp({ error: 'send_failed', detail: e.message, code, invite_id: inviteId, link }, 500, origin);
    }

    // Activation event ('invite_sent') is logged client-side by class-roster.js
    // after this call returns ok. Doing it here would lose auth.uid() (SECURITY
    // DEFINER + service-role key = no caller identity).

    const seatsRemaining = isAdmin ? null
        : Math.max(0, (auth.classroom_seats ?? 0) - (auth.seats_used ?? 0) - 1);

    return jsonResp({
        ok:               true,
        code,
        invite_id:        inviteId,
        link,
        sent_to:          recipientEmail,
        seats_remaining:  seatsRemaining,
    }, 200, origin);
}
