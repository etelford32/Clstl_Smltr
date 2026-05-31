/**
 * Vercel Edge Function: /api/subscribe/resend-webhook
 *
 * Reconciles Resend's NATIVE broadcast unsubscribes back into our DB so
 * aurora_subscribers stays authoritative. When a recipient clicks the
 * one-click unsubscribe in a storm broadcast, Resend marks the Audience
 * contact unsubscribed and fires a webhook here; we flip the matching
 * aurora_subscribers row via unsubscribe_aurora_by_email().
 *
 * Security: Resend signs webhooks with Svix. We verify the signature against
 * RESEND_WEBHOOK_SECRET before acting — the endpoint is otherwise public, and
 * it mutates subscription state, so an unverified request must do nothing.
 *
 * See AURORA_ALERT_CAPTURE_SPEC.md §8/§11.
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://aijsboodkivnhzfstvdq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';

const json = (b, s = 200) => new Response(JSON.stringify(b), {
    status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
function bytesToB64(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

/**
 * Verify a Svix-signed payload (the scheme Resend uses). Returns true iff one
 * of the provided v1 signatures matches our HMAC over `id.timestamp.body`.
 */
async function verifySvix(secret, svixId, svixTs, body, sigHeader) {
    if (!secret || !svixId || !svixTs || !sigHeader) return false;
    const secretB64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    let keyBytes;
    try { keyBytes = b64ToBytes(secretB64); } catch { return false; }

    const key = await crypto.subtle.importKey(
        'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const signed = `${svixId}.${svixTs}.${body}`;
    const macBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
    const expected = bytesToB64(new Uint8Array(macBuf));

    // Header format: space-separated "v1,<sig>" entries.
    for (const part of sigHeader.split(' ')) {
        const sig = part.includes(',') ? part.split(',')[1] : part;
        if (sig && sig.length === expected.length) {
            // length-guarded compare (timing-safe enough for this surface).
            let diff = 0;
            for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
            if (diff === 0) return true;
        }
    }
    return false;
}

export default async function handler(req) {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!WEBHOOK_SECRET) return json({ error: 'not_configured' }, 501);

    const body = await req.text();
    const ok = await verifySvix(
        WEBHOOK_SECRET,
        req.headers.get('svix-id'),
        req.headers.get('svix-timestamp'),
        body,
        req.headers.get('svix-signature'),
    );
    if (!ok) return json({ error: 'bad_signature' }, 401);

    let evt;
    try { evt = JSON.parse(body); } catch { return json({ error: 'invalid_body' }, 400); }

    // Resend contact events carry the email + unsubscribed flag in data.
    const data  = evt?.data || {};
    const email = data.email;
    const type  = String(evt?.type || '');
    const isUnsub = data.unsubscribed === true || /unsubscrib/i.test(type);

    // Only act on unsubscribes we can resolve to an email. Everything else is
    // acknowledged so Resend doesn't retry.
    if (email && isUnsub) {
        try {
            await fetch(`${SUPABASE_URL}/rest/v1/rpc/unsubscribe_aurora_by_email`, {
                method: 'POST',
                headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ p_email: email }),
                signal: AbortSignal.timeout(5000),
            });
        } catch { /* ack anyway; reconcile is best-effort */ }
    }

    return json({ ok: true });
}
