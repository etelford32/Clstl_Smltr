/**
 * Vercel Edge Function: POST /api/checkout/create-session
 *
 * Creates a Stripe Checkout Session for plan upgrades.
 * Requires authenticated user (Supabase JWT in Authorization header).
 *
 * Input:  { plan: 'basic'|'advanced', successUrl?, cancelUrl? }
 * Output: { sessionId, checkoutUrl }
 *
 * Flow:
 *   1. Authenticate user via Supabase JWT
 *   2. Look up or create Stripe customer
 *   3. Create Stripe Checkout Session with the selected plan's price
 *   4. Return the session URL for redirect
 */
export const config = { runtime: 'edge' };

import { errorResp, ErrorCodes, jsonResp } from '../_lib/middleware.js';
import { getStripe, getSupabaseService, authenticateUser, PLAN_CONFIG } from '../_lib/stripe.js';

export default async function handler(request) {
    if (request.method !== 'POST') {
        return errorResp(ErrorCodes.INVALID_REQUEST, 'POST required');
    }

    // ── 1. Authenticate ──────────────────────────────────────────────────
    const user = await authenticateUser(request);
    if (!user) {
        return errorResp(ErrorCodes.UNAUTHORIZED, 'Sign in required');
    }

    // ── 2. Parse + validate input ────────────────────────────────────────
    let body;
    try {
        body = await request.json();
    } catch (_) {
        return errorResp(ErrorCodes.INVALID_REQUEST, 'Invalid JSON body');
    }

    const plan = body.plan;
    if (!plan || !PLAN_CONFIG[plan] || !PLAN_CONFIG[plan].price_id) {
        return errorResp(ErrorCodes.INVALID_REQUEST, 'Invalid plan. Must be "basic" or "advanced".');
    }

    const origin = new URL(request.url).origin;
    const successUrl = body.successUrl || `${origin}/dashboard.html?checkout=success&plan=${plan}`;
    const cancelUrl  = body.cancelUrl  || `${origin}/pricing.html?checkout=canceled`;

    // ── 3. Get or create Stripe customer ─────────────────────────────────
    let stripe, sb;
    try {
        stripe = getStripe();
        sb = await getSupabaseService();
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Payment service not configured');
    }

    // Check if user already has a Stripe customer ID
    let customerId;
    try {
        const profiles = await sb.query('user_profiles', 'GET', {
            select: 'stripe_customer_id,email',
            id: `eq.${user.id}`,
        });
        const profile = Array.isArray(profiles) ? profiles[0] : null;
        customerId = profile?.stripe_customer_id;

        if (!customerId) {
            // Create Stripe customer
            const customer = await stripe.request('POST', '/customers', {
                email: user.email || profile?.email,
                name: user.user_metadata?.name || '',
                'metadata[supabase_uid]': user.id,
            });
            customerId = customer.id;

            // Store customer ID in Supabase
            await sb.query('user_profiles', 'PATCH', {
                stripe_customer_id: customerId,
                _filter: { id: `eq.${user.id}` },
            });
        }
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Failed to set up billing account');
    }

    // ── 4. Create Checkout Session ───────────────────────────────────────
    try {
        const session = await stripe.request('POST', '/checkout/sessions', {
            customer: customerId,
            mode: 'subscription',
            'line_items[0][price]': PLAN_CONFIG[plan].price_id,
            'line_items[0][quantity]': '1',
            success_url: successUrl,
            cancel_url: cancelUrl,
            'subscription_data[metadata][supabase_uid]': user.id,
            'subscription_data[metadata][plan]': plan,
            allow_promotion_codes: 'true',
        });

        return jsonResp({
            sessionId: session.id,
            checkoutUrl: session.url,
        }, 200, 0);  // no caching for checkout sessions
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Failed to create checkout session');
    }
}
