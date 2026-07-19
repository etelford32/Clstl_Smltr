/**
 * Vercel Edge Function: /api/subscribe/confirm
 *
 * Double opt-in landing for anonymous aurora-alert capture. The link in the
 * confirmation email (sent by /api/subscribe/aurora) points here.
 *
 *   GET /api/subscribe/confirm?token=<uuid>
 *     → confirm_aurora() RPC flips the row to 'confirmed'
 *     → on success, create the global Resend contact and add it to the
 *       aurora Segment (clean list: only AFTER confirmation). Resend's
 *       2026 model: contacts are account-global, segments are static
 *       containers joined via POST /contacts/{id}/segments — audiences
 *       are deprecated.
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

const RESEND_CONTACTS = 'https://api.resend.com/contacts';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
// Segment ID (Resend renamed audiences → segments, 2026). The old env var
// name is honored as a fallback so a half-migrated Vercel config still works.
const SEGMENT_ID   = process.env.AURORA_SEGMENT_ID || process.env.AURORA_AUDIENCE_ID || '';

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

    // Create the global contact, then add it to the aurora Segment. Both
    // steps are best-effort and non-fatal: the confirmed DB row is the
    // source of truth, and a re-confirm retries the whole sequence.
    if (RESEND_KEY && SEGMENT_ID) {
        try {
            const hdrs = { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' };
            // 1) Create (or find) the contact. Contacts are unique by email;
            //    on a duplicate the create fails, so fall back to a lookup —
            //    the docs address contacts by id or email interchangeably.
            let contactId = null;
            const createRes = await fetch(RESEND_CONTACTS, {
                method: 'POST', headers: hdrs,
                body: JSON.stringify({ email: row.out_email, unsubscribed: false }),
                signal: AbortSignal.timeout(8000),
            });
            if (createRes.ok) {
                contactId = (await createRes.json().catch(() => null))?.id || null;
            } else {
                const getRes = await fetch(`${RESEND_CONTACTS}/${encodeURIComponent(row.out_email)}`, {
                    headers: hdrs, signal: AbortSignal.timeout(8000),
                });
                if (getRes.ok) contactId = (await getRes.json().catch(() => null))?.id || null;
            }
            // 2) Segment membership (idempotent add).
            if (contactId) {
                await fetch(`${RESEND_CONTACTS}/${contactId}/segments`, {
                    method: 'POST', headers: hdrs,
                    body: JSON.stringify({ segment_id: SEGMENT_ID }),
                    signal: AbortSignal.timeout(8000),
                });
            }
        } catch { /* non-fatal: confirmed row is source of truth, cron can reconcile */ }
    }

    return redirect('/welcome.html?aurora=confirmed');
}
