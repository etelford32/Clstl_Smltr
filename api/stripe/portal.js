/**
 * Vercel Edge Function: /api/stripe/portal
 *
 * Creates a Stripe Billing Portal session so users can manage their
 * subscription: update payment method, change plan, cancel, view invoices.
 *
 * POST /api/stripe/portal
 *   Headers: Authorization: Bearer <supabase-jwt>
 *
 * Returns: { url: 'https://billing.stripe.com/...' }
 *
 * ── Env vars ─────────────────────────────────────────────────────────────────
 *   STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, APP_URL
 */

export const config = { runtime: 'edge' };

const STRIPE_KEY   = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_API   = 'https://api.stripe.com/v1';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const APP_URL      = process.env.APP_URL || 'https://parkerphysics.com';
const PORTAL_CONFIG = process.env.STRIPE_PORTAL_CONFIG_ID || 'bpc_1TKem2CFCdsF8GYJNqf8hKGN';

function json(body, status = 200) {
    return Response.json(body, {
        status,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' },
    });
}

async function verifyUser(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY || token },
        });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

export default async function handler(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!STRIPE_KEY) return json({ error: 'not_configured', detail: 'STRIPE_SECRET_KEY not set' }, 501);

    const user = await verifyUser(req.headers.get('Authorization'));
    if (!user?.id) return json({ error: 'unauthorized' }, 401);

    // Get Stripe customer ID from Supabase
    let customerId;
    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${user.id}&select=stripe_customer_id`,
            { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        const profiles = await res.json();
        customerId = profiles?.[0]?.stripe_customer_id;
    } catch { /* fall through */ }

    if (!customerId) return json({ error: 'no_subscription', detail: 'No active subscription found. Subscribe first.' }, 404);

    try {
        const params = new URLSearchParams({
            customer:       customerId,
            return_url:     `${APP_URL}/dashboard.html`,
            configuration:  PORTAL_CONFIG,
        });
        const res = await fetch(`${STRIPE_API}/billing_portal/sessions`, {
            method: 'POST',
            headers: { Authorization: `Basic ${btoa(STRIPE_KEY + ':')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params,
        });
        const session = await res.json();
        if (session.error) return json({ error: 'stripe_error', detail: session.error.message }, 500);

        return json({ url: session.url });
    } catch (e) {
        return json({ error: 'portal_failed', detail: e.message }, 500);
    }
}
