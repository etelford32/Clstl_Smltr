/**
 * Vercel Edge Function: /api/subscribe/confirm
 *
 * Double opt-in landing for anonymous aurora-alert capture. The link in the
 * confirmation email (sent by /api/subscribe/aurora) points here.
 *
 *   GET /api/subscribe/confirm?token=<uuid>
 *     → confirm_aurora() RPC flips the row to 'confirmed'
 *     → on success, add the contact to the Resend Audience (clean audience:
 *       a contact is added only AFTER confirmation)
 *     → 302 redirect to /welcome.html?aurora=confirmed | invalid | error
 *
 * See AURORA_ALERT_CAPTURE_SPEC.md.
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL
    || process.env.NEXT_PUBLIC_SUPABASE_URL
    || 'https://aijsboodkivnhzfstvdq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const SITE_URL     = process.env.SITE_URL || 'https://parkersphysics.com';

const RESEND_AUDIENCES = 'https://api.resend.com/audiences';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const AUDIENCE_ID  = process.env.AURORA_AUDIENCE_ID || '';

const redirect = (path) => new Response(null, {
    status: 302,
    headers: { Location: `${SITE_URL}${path}`, 'Cache-Control': 'no-store' },
});

export default async function handler(req) {
    const token = new URL(req.url).searchParams.get('token');
    if (!token) return redirect('/welcome.html?aurora=invalid');

    let row;
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/confirm_aurora`, {
            method: 'POST',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_token: token }),
            signal: AbortSignal.timeout(5000),
        });
        row = (await r.json())?.[0];
    } catch {
        return redirect('/welcome.html?aurora=error');
    }

    if (!row || row.out_status !== 'confirmed') return redirect('/welcome.html?aurora=invalid');

    // Add to Resend Audience (idempotent on Resend's side by email).
    if (RESEND_KEY && AUDIENCE_ID) {
        try {
            await fetch(`${RESEND_AUDIENCES}/${AUDIENCE_ID}/contacts`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: row.out_email, unsubscribed: false }),
                signal: AbortSignal.timeout(8000),
            });
        } catch { /* non-fatal: confirmed row is source of truth, cron can reconcile */ }
    }

    return redirect('/welcome.html?aurora=confirmed');
}
