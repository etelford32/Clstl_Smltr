/**
 * Vercel Edge Function: /api/subscribe/unsubscribe
 *
 * Token-based, DB-authoritative unsubscribe for aurora alerts.
 *
 *   GET /api/subscribe/unsubscribe?token=<confirm_token>
 *     → unsubscribe_aurora() flips the row to 'unsubscribed' and returns the
 *       email → we also flip the matching Resend Audience contact so the two
 *       stores agree → 302 to /welcome.html?aurora=unsubscribed.
 *
 * Note: storm broadcasts use Resend's NATIVE one-click unsubscribe (handled by
 * api/subscribe/resend-webhook.js on the way back). This endpoint is the
 * token path used by per-recipient / transactional aurora mail and anywhere
 * we want the DB to be the source of truth.
 *
 * See AURORA_ALERT_CAPTURE_SPEC.md §11.
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://aijsboodkivnhzfstvdq.supabase.co';
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

    let email;
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/unsubscribe_aurora`, {
            method: 'POST',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_token: token }),
            signal: AbortSignal.timeout(5000),
        });
        // RPC returns the email (text) or null when no row matched.
        email = await r.json().catch(() => null);
    } catch {
        return redirect('/welcome.html?aurora=error');
    }

    // Flip the Resend Audience contact too (idempotent; addressed by email).
    if (email && RESEND_KEY && AUDIENCE_ID) {
        try {
            await fetch(`${RESEND_AUDIENCES}/${AUDIENCE_ID}/contacts/${encodeURIComponent(email)}`, {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ unsubscribed: true }),
                signal: AbortSignal.timeout(8000),
            });
        } catch { /* non-fatal: DB row is already unsubscribed */ }
    }

    // Always land on the friendly state — even a stale/invalid token shouldn't
    // leak whether it matched. (No row → email is null → we still say "done".)
    return redirect('/welcome.html?aurora=unsubscribed');
}
