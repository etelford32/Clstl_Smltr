/**
 * Vercel Edge Function: /api/stripe/checkout
 *
 * Creates a Stripe Checkout Session for plan subscription.
 *
 * POST /api/stripe/checkout
 *   Headers: Authorization: Bearer <supabase-jwt>
 *   Body:    { plan: 'basic' | 'advanced' }
 *
 * Returns: { url: 'https://checkout.stripe.com/...' }
 *
 * ── Env vars required ────────────────────────────────────────────────────────
 *   STRIPE_SECRET_KEY        — sk_live_... or sk_test_...
 *   STRIPE_BASIC_PRICE_ID    — price_... for Basic $10/mo
 *   STRIPE_ADVANCED_PRICE_ID — price_... for Advanced $100/mo
 *   SUPABASE_URL             — https://xxx.supabase.co
 *   SUPABASE_SERVICE_KEY     — service_role key (server-side only)
 *   APP_URL                  — https://parkerphysics.com (for redirect URLs)
 */

export const config = { runtime: 'edge' };

const STRIPE_KEY     = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_API     = 'https://api.stripe.com/v1';
const SUPABASE_URL   = process.env.SUPABASE_URL || '';
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY || '';
const APP_URL        = process.env.APP_URL || 'https://parkerphysics.com';

const PRICE_MAP = {
    basic:    process.env.STRIPE_BASIC_PRICE_ID    || '',
    advanced: process.env.STRIPE_ADVANCED_PRICE_ID || '',
};

function json(body, status = 200) {
    return Response.json(body, {
        status,
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
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
        const user = await res.json();
        return user?.email ? { id: user.id, email: user.email } : null;
    } catch { return null; }
}

/** Get or create Stripe customer for this user. */
async function getOrCreateCustomer(userId, email) {
    // Check if user already has a Stripe customer ID in Supabase
    const profileRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=stripe_customer_id`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const profiles = await profileRes.json();
    const existing = profiles?.[0]?.stripe_customer_id;
    if (existing) return existing;

    // Create new Stripe customer
    const params = new URLSearchParams({ email, 'metadata[supabase_uid]': userId });
    const res = await fetch(`${STRIPE_API}/customers`, {
        method: 'POST',
        headers: { Authorization: `Basic ${btoa(STRIPE_KEY + ':')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
    });
    const customer = await res.json();
    if (customer.error) throw new Error(customer.error.message);

    // Save customer ID to Supabase
    await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`, {
        method: 'PATCH',
        headers: {
            apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify({ stripe_customer_id: customer.id }),
    });

    return customer.id;
}

export default async function handler(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!STRIPE_KEY) return json({ error: 'not_configured', detail: 'STRIPE_SECRET_KEY not set' }, 501);

    const user = await verifyUser(req.headers.get('Authorization'));
    if (!user) return json({ error: 'unauthorized' }, 401);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid_body' }, 400); }

    const plan = body.plan;
    const priceId = PRICE_MAP[plan];
    if (!priceId) return json({ error: 'invalid_plan', detail: `Plan must be 'basic' or 'advanced'` }, 400);

    try {
        const customerId = await getOrCreateCustomer(user.id, user.email);

        // Create Checkout Session
        const params = new URLSearchParams({
            'customer':                     customerId,
            'mode':                         'subscription',
            'line_items[0][price]':         priceId,
            'line_items[0][quantity]':       '1',
            'success_url':                  `${APP_URL}/dashboard.html?checkout=success&plan=${plan}`,
            'cancel_url':                   `${APP_URL}/pricing.html?checkout=canceled`,
            'subscription_data[metadata][supabase_uid]': user.id,
            'subscription_data[metadata][plan]':         plan,
            'allow_promotion_codes':        'true',
        });

        const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
            method: 'POST',
            headers: { Authorization: `Basic ${btoa(STRIPE_KEY + ':')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params,
        });
        const session = await res.json();
        if (session.error) return json({ error: 'stripe_error', detail: session.error.message }, 500);

        return json({ url: session.url });
    } catch (e) {
        return json({ error: 'checkout_failed', detail: e.message }, 500);
    }
}
