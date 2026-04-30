/**
 * Vercel Edge Function: /api/stripe/checkout
 *
 * Creates a Stripe Checkout Session for plan subscription.
 *
 * POST /api/stripe/checkout
 *   Headers: Authorization: Bearer <supabase-jwt>
 *   Body:    { plan: 'basic' | 'educator' | 'advanced' | 'institution',
 *              trial?: 'tour-30day' | 'edu-14day' }   // optional promo
 *
 * Returns: { url: 'https://checkout.stripe.com/...' }
 *
 * Note: 'enterprise' is rejected with 400 — Enterprise pricing is custom
 * and routed through /contact-enterprise.html → /api/contact/enterprise.
 *
 * ── Trial codes (server-enforced) ─────────────────────────────────────────
 * The trial code → trial-day mapping lives ONLY on the server. The client
 * sends the opaque code (e.g. 'tour-30day') and the server looks up the
 * day count + plan eligibility. This way a curious user can't extend their
 * own trial by changing the URL — the only thing they can do is request a
 * promo we've already approved for that plan.
 *
 * Each trial entry can also gate which plans it applies to. Today the
 * 30-day post-tour offer covers Basic and Educator (Advanced/Institution
 * trials happen via sales). Add more entries as marketing campaigns ship.
 *
 * ── Env vars required ────────────────────────────────────────────────────────
 *   STRIPE_SECRET_KEY            — sk_live_... or sk_test_...
 *   STRIPE_BASIC_PRICE_ID        — price_... for Basic $10/mo
 *   STRIPE_EDUCATOR_PRICE_ID     — price_... for Educator $25/mo
 *   STRIPE_ADVANCED_PRICE_ID     — price_... for Advanced $100/mo
 *   STRIPE_INSTITUTION_PRICE_ID  — price_... for Institution $500/mo
 *   SUPABASE_URL                 — https://xxx.supabase.co
 *   SUPABASE_SERVICE_KEY         — service_role key (server-side only)
 *   APP_URL                      — https://parkerphysics.com (for redirect URLs)
 */

export const config = { runtime: 'edge' };

const STRIPE_KEY     = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_API     = 'https://api.stripe.com/v1';
// Dual-name env vars — see api/weather/grid.js for rationale.
const SUPABASE_URL   = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const APP_URL        = process.env.APP_URL || 'https://parkerphysics.com';

// Stripe price IDs: original naming was STRIPE_{TIER}_PRICE_ID; Vercel
// dashboards often prefix with STRIPE_PRICE_{TIER}. Accept either.
//
// Yearly variants are optional — set STRIPE_<TIER>_YEARLY_PRICE_ID to
// enable a "billed annually" toggle on the matching pricing card. Plans
// without a yearly price simply don't show the toggle.
const PRICE_MAP = {
    basic:              process.env.STRIPE_BASIC_PRICE_ID              || process.env.STRIPE_PRICE_BASIC              || '',
    'basic-yearly':     process.env.STRIPE_BASIC_YEARLY_PRICE_ID       || process.env.STRIPE_PRICE_BASIC_YEARLY       || '',
    educator:           process.env.STRIPE_EDUCATOR_PRICE_ID           || process.env.STRIPE_PRICE_EDUCATOR           || '',
    'educator-yearly':  process.env.STRIPE_EDUCATOR_YEARLY_PRICE_ID    || process.env.STRIPE_PRICE_EDUCATOR_YEARLY    || '',
    advanced:           process.env.STRIPE_ADVANCED_PRICE_ID           || process.env.STRIPE_PRICE_ADVANCED           || '',
    'advanced-yearly':  process.env.STRIPE_ADVANCED_YEARLY_PRICE_ID    || process.env.STRIPE_PRICE_ADVANCED_YEARLY    || '',
    institution:        process.env.STRIPE_INSTITUTION_PRICE_ID        || process.env.STRIPE_PRICE_INSTITUTION        || '',
    'institution-yearly': process.env.STRIPE_INSTITUTION_YEARLY_PRICE_ID || process.env.STRIPE_PRICE_INSTITUTION_YEARLY || '',
};

// Map a yearly variant back to the base plan name for downstream consumers
// (webhook plan-flag, success URL, dashboard tier resolution). The user is
// still on "educator" — the yearly slug is just a billing cadence.
function basePlan(plan) {
    if (typeof plan !== 'string') return plan;
    return plan.replace(/-yearly$/, '');
}

// Tiers that are NEVER self-serve. enterprise = custom contract; free = no
// Stripe interaction at all. Returning 400 with a hint keeps the client
// from getting a confusing "invalid_plan" when they hit the wrong button.
const NON_SELFSERVE_TIERS = new Set(['enterprise']);

// ── Trial promotions ────────────────────────────────────────────────────────
// Server-side allow-list. Client posts `trial: '<code>'`; we look up the
// day count and the plans it's valid for. Anything not in this map is
// silently dropped (the checkout still succeeds — just without a trial).
//
// 'tour-30day': granted at the end of the home-page Explore tour. Card on
//               file required (Stripe collects it during Checkout); we
//               email the user a heads-up the day before the trial ends
//               via the Stripe customer.subscription.trial_will_end webhook.
//
// 'edu-14day':  generic 14-day trial slot for Educator outreach. Disabled
//               by default (set TRIAL_EDU_14DAY_ENABLED=1 in env to turn
//               on) so a stale marketing link can't grant a trial after
//               the campaign window closes.
const TRIAL_PROMOS = {
    'tour-30day': {
        days:  30,
        plans: new Set(['basic', 'educator']),
    },
    'edu-14day': {
        days:  14,
        plans: new Set(['educator']),
        enabled: process.env.TRIAL_EDU_14DAY_ENABLED === '1',
    },
};

// Resolve a (trial code, plan) pair into a trial-day count, or null if
// the combination isn't in the allow-list. The plan check is performed
// against the BASE plan ('educator-yearly' → 'educator') so a yearly
// upgrade still gets the same promo as the monthly variant.
function resolveTrial(code, plan) {
    if (!code || typeof code !== 'string') return null;
    const promo = TRIAL_PROMOS[code];
    if (!promo) return null;
    if (promo.enabled === false) return null;
    if (!promo.plans.has(basePlan(plan))) return null;
    return promo.days;
}

// Origin allow-list — defense in depth on top of the JWT check. The
// endpoint isn't directly CSRF-able (browsers don't auto-attach our
// Supabase Bearer token cross-origin), but a compromised third-party
// script on a parkerphysics.com sub-resource could still post here, so
// reject any non-allowed Origin outright. APP_URL is always allowed.
const ALLOWED_ORIGINS = new Set(
    (process.env.ALLOWED_ORIGINS
        || `${APP_URL},https://parkerphysics.com,https://www.parkerphysics.com,https://parkerphysics.app,https://www.parkerphysics.app`
    ).split(',').map(s => s.trim()).filter(Boolean)
);

function _corsHeaders(origin) {
    // Echo back only allow-listed origins. Same-origin requests omit the
    // header entirely (browsers behaviour) — those skip the check too.
    const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : '';
    const headers = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Vary':                         'Origin',
    };
    if (allow) headers['Access-Control-Allow-Origin'] = allow;
    return headers;
}

function json(body, status = 200, origin = '') {
    return Response.json(body, { status, headers: _corsHeaders(origin) });
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

/**
 * Get or create the Stripe customer for this Supabase user.
 *
 * Concurrent-safe: if two checkout calls race (user double-clicks the
 * "Subscribe" button) both will pass an identical
 * `Idempotency-Key: pp-cust-<uid>` header to Stripe, so Stripe returns
 * the same customer record for both — no duplicate Stripe customers,
 * regardless of how the Supabase PATCH races.
 *
 * Stripe stores idempotency results for 24h, which is long enough for
 * any realistic race window (the customer ID lands in user_profiles on
 * the first call; subsequent calls hit the early-return path).
 */
async function getOrCreateCustomer(userId, email) {
    // Fast path: customer already in Supabase.
    const profileRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=stripe_customer_id`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const profiles = await profileRes.json();
    const existing = profiles?.[0]?.stripe_customer_id;
    if (existing) return existing;

    // Create — or retrieve, if a concurrent request already created one
    // under the same key — via Stripe's Idempotency-Key. Stripe matches
    // requests by (key, body); using user_id as the key means the second
    // double-click returns the SAME customer object as the first, so we
    // can't end up with two Stripe customers for one Supabase user.
    const params = new URLSearchParams({ email, 'metadata[supabase_uid]': userId });
    const res = await fetch(`${STRIPE_API}/customers`, {
        method: 'POST',
        headers: {
            Authorization:    `Basic ${btoa(STRIPE_KEY + ':')}`,
            'Content-Type':   'application/x-www-form-urlencoded',
            'Idempotency-Key': `pp-cust-${userId}`,
        },
        body: params,
    });
    const customer = await res.json();
    if (customer.error) throw new Error(customer.error.message);

    // Persist back to Supabase. The PATCH is naturally idempotent — if a
    // concurrent caller has already written the same customer.id, the
    // second write is a no-op.
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
    const origin = req.headers.get('Origin') || '';

    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: _corsHeaders(origin) });
    }
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
    if (!STRIPE_KEY) return json({ error: 'not_configured', detail: 'STRIPE_SECRET_KEY not set' }, 501, origin);

    // Origin gate — defense in depth on top of the JWT check below. Browsers
    // attach Origin on every cross-origin POST; same-origin requests omit it
    // (no header → no check). A non-allow-listed origin is silently rejected.
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return json({ error: 'origin_blocked' }, 403, origin);
    }

    const user = await verifyUser(req.headers.get('Authorization'));
    if (!user) return json({ error: 'unauthorized' }, 401, origin);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid_body' }, 400, origin); }

    const plan = body.plan;
    if (NON_SELFSERVE_TIERS.has(plan)) {
        return json({
            error: 'contact_required',
            detail: `${plan} pricing is custom — please use the contact form at /contact-enterprise.html`,
            redirect: `${APP_URL}/contact-enterprise.html`,
        }, 400, origin);
    }
    const priceId = PRICE_MAP[plan];
    if (!priceId) {
        return json({
            error:  'invalid_plan',
            detail: `Plan must be one of: ${Object.keys(PRICE_MAP).join(', ')}`,
        }, 400, origin);
    }

    try {
        const customerId = await getOrCreateCustomer(user.id, user.email);

        // Resolve any promo trial code. Server-validated — see TRIAL_PROMOS.
        // We trim the input to a sensible length so a malicious client can't
        // POST a multi-megabyte string and slow us down.
        const trialCode = typeof body.trial === 'string'
            ? body.trial.slice(0, 64).trim().toLowerCase()
            : '';
        const trialDays = resolveTrial(trialCode, plan);

        // Create Checkout Session.
        // Idempotency key is per (user, plan, trialCode) — a double-click
        // within Stripe's 24h dedupe window returns the same Checkout Session
        // URL instead of creating two open subscription invoices. Distinct
        // (user, plan, trial) combos still get fresh sessions because the
        // key changes — so a user who first started checkout without a trial
        // and then revisits with the tour offer doesn't get a stale URL.
        // Normalize plan + cadence — downstream consumers (webhook,
        // dashboard, success URL) think in base plan names; the cadence
        // is metadata.
        const _basePlan = basePlan(plan);
        const _cadence  = plan.endsWith('-yearly') ? 'yearly' : 'monthly';

        const params = new URLSearchParams({
            'customer':                     customerId,
            'mode':                         'subscription',
            'line_items[0][price]':         priceId,
            'line_items[0][quantity]':       '1',
            'success_url':                  `${APP_URL}/dashboard.html?checkout=success&plan=${_basePlan}`,
            'cancel_url':                   `${APP_URL}/pricing.html?checkout=canceled`,
            'subscription_data[metadata][supabase_uid]': user.id,
            'subscription_data[metadata][plan]':         _basePlan,
            'subscription_data[metadata][cadence]':      _cadence,
            'allow_promotion_codes':        'true',
        });

        if (trialDays) {
            params.set('subscription_data[trial_period_days]', String(trialDays));
            params.set('subscription_data[metadata][trial_code]', trialCode);
            // Card-on-file required — that's the whole point of a "drop a
            // card and your first month is free" hook. Stripe collects the
            // payment method during Checkout and charges automatically when
            // the trial ends unless the user cancels in the billing portal.
            params.set('payment_method_collection', 'always');
            // If the trial expires without a card (shouldn't happen with
            // 'always' above, but be explicit) — cancel the sub rather than
            // leaving an inactive paid plan dangling.
            params.set('subscription_data[trial_settings][end_behavior][missing_payment_method]', 'cancel');
        }

        // Daily-rotating salt so the idempotency window doesn't trap a user
        // who tries the same plan again after a real failure (e.g. card
        // declined). Stripe's window is 24h; salting per UTC day matches.
        const _day = new Date().toISOString().slice(0, 10);
        const trialSlug = trialDays ? `-trial-${trialCode}` : '';
        const idempKey = `pp-checkout-${user.id}-${plan}${trialSlug}-${_day}`;

        const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
            method: 'POST',
            headers: {
                Authorization:    `Basic ${btoa(STRIPE_KEY + ':')}`,
                'Content-Type':   'application/x-www-form-urlencoded',
                'Idempotency-Key': idempKey,
            },
            body: params,
        });
        const session = await res.json();
        if (session.error) return json({ error: 'stripe_error', detail: session.error.message }, 500, origin);

        return json({ url: session.url }, 200, origin);
    } catch (e) {
        return json({ error: 'checkout_failed', detail: e.message }, 500, origin);
    }
}
