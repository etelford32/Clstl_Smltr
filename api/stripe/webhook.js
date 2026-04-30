/**
 * Vercel Edge Function: /api/stripe/webhook
 *
 * Handles Stripe webhook events to sync subscription state with Supabase.
 * This is the single source of truth for plan enforcement — the webhook
 * updates user_profiles.plan and subscription_status based on Stripe events.
 *
 * ── Events handled ───────────────────────────────────────────────────────────
 *   checkout.session.completed    — first subscription created
 *   customer.subscription.updated — plan change, trial end, renewal
 *   customer.subscription.deleted — cancellation
 *   invoice.payment_failed        — mark past_due
 *   invoice.paid                  — confirm active after retry
 *
 * ── Env vars required ────────────────────────────────────────────────────────
 *   STRIPE_SECRET_KEY      — for API calls
 *   STRIPE_WEBHOOK_SECRET  — whsec_... for signature verification
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   — service_role key (bypasses RLS)
 */

export const config = { runtime: 'edge' };

const STRIPE_KEY        = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_API        = 'https://api.stripe.com/v1';
const WEBHOOK_SECRET    = process.env.STRIPE_WEBHOOK_SECRET || '';
// Dual-name env vars — see api/weather/grid.js for rationale.
const SUPABASE_URL      = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

// Subscription notifications. The owner wants a heads-up whenever someone
// subscribes (or cancels). Falls back to a hard-coded address so a fresh
// deployment without env vars still notifies the owner.
const RESEND_API        = 'https://api.resend.com/emails';
const RESEND_KEY        = process.env.RESEND_API_KEY || '';
const FROM_EMAIL        = process.env.ALERT_FROM_EMAIL || 'Parker Physics <noreply@parkerphysics.com>';
const SUB_NOTIFY_EMAIL  = process.env.SUBSCRIPTION_NOTIFY_EMAIL || 'etelford32@gmail.com';
const APP_URL           = process.env.APP_URL || 'https://parkerphysics.com';

// Map Stripe price IDs to plan names. Accept both the original naming
// (STRIPE_{TIER}_PRICE_ID) and the Vercel-dashboard convention
// (STRIPE_PRICE_{TIER}) so the webhook upgrades work regardless of how
// the env vars were originally created.
//
// Enterprise has no price ID — it's a manually-assigned plan set by an
// admin once a custom contract is signed. The webhook never touches it.
const PRICE_TO_PLAN = {};
const _basicPrice       = process.env.STRIPE_BASIC_PRICE_ID       || process.env.STRIPE_PRICE_BASIC;
const _educatorPrice    = process.env.STRIPE_EDUCATOR_PRICE_ID    || process.env.STRIPE_PRICE_EDUCATOR;
const _advancedPrice    = process.env.STRIPE_ADVANCED_PRICE_ID    || process.env.STRIPE_PRICE_ADVANCED;
const _institutionPrice = process.env.STRIPE_INSTITUTION_PRICE_ID || process.env.STRIPE_PRICE_INSTITUTION;
if (_basicPrice)       PRICE_TO_PLAN[_basicPrice]       = 'basic';
if (_educatorPrice)    PRICE_TO_PLAN[_educatorPrice]    = 'educator';
if (_advancedPrice)    PRICE_TO_PLAN[_advancedPrice]    = 'advanced';
if (_institutionPrice) PRICE_TO_PLAN[_institutionPrice] = 'institution';

/** Constant-time string compare — same length required, returns false on mismatch. */
function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/** Verify Stripe webhook signature (HMAC-SHA256). */
async function verifySignature(rawBody, sigHeader) {
    if (!WEBHOOK_SECRET || !sigHeader) return false;
    const parts = Object.fromEntries(
        sigHeader.split(',').map(p => { const [k, v] = p.split('='); return [k, v]; })
    );
    const timestamp = parts.t;
    const sig       = parts.v1;
    if (!timestamp || !sig) return false;

    // Check timestamp freshness (5 min tolerance)
    if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;

    const payload = `${timestamp}.${rawBody}`;
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(WEBHOOK_SECRET),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const expectedHex = [...new Uint8Array(expected)].map(b => b.toString(16).padStart(2, '0')).join('');

    // Constant-time compare — `===` leaks length-prefix matches via timing.
    return constantTimeEqual(expectedHex, sig);
}

/** Update user_profiles via Supabase REST API (service key, bypasses RLS). */
async function updateProfile(userId, updates) {
    await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`, {
        method: 'PATCH',
        headers: {
            apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify({ ...updates, updated_at: new Date().toISOString() }),
    });
}

/**
 * Insert a row into activation_events directly. The log_activation_event
 * RPC keys off auth.uid(), which is null in a webhook context — so we
 * write to the table with the service key (RLS bypassed) and rely on the
 * unique partial index for idempotency on first_* events. subscription_*
 * events aren't in that index by design, so we de-dupe in-query.
 */
async function logActivationServerSide(userId, event, plan, metadata = {}) {
    if (!userId || !event) return;
    try {
        // Skip if a row for the same (user, event) was inserted in the last
        // 60 seconds — Stripe occasionally retries webhook deliveries, and
        // we don't want a duplicate `subscription_started` row showing up
        // in the funnel from a redelivered event.
        const sinceIso = new Date(Date.now() - 60_000).toISOString();
        const dupeRes = await fetch(
            `${SUPABASE_URL}/rest/v1/activation_events`
            + `?user_id=eq.${userId}&event=eq.${encodeURIComponent(event)}`
            + `&created_at=gte.${encodeURIComponent(sinceIso)}&select=id&limit=1`,
            { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        if (dupeRes.ok) {
            const rows = await dupeRes.json();
            if (Array.isArray(rows) && rows.length) return;
        }

        await fetch(`${SUPABASE_URL}/rest/v1/activation_events`, {
            method: 'POST',
            headers: {
                apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json', Prefer: 'return=minimal',
            },
            body: JSON.stringify({
                user_id:  userId,
                event,
                plan:     plan ?? null,
                metadata: metadata || {},
            }),
        });
    } catch (e) {
        console.warn(`[StripeWebhook] activation log (${event}) failed:`, e.message);
    }
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Look up the user's email + display name for the notification body. */
async function fetchUserSummary(userId) {
    if (!userId) return null;
    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=email,display_name,plan&limit=1`,
            { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        const rows = await res.json();
        return rows?.[0] || null;
    } catch { return null; }
}

/** Notify the owner that someone subscribed / canceled. Best-effort. */
async function notifyOwner({ kind, plan, userId, amountCents, currency, periodEndIso }) {
    if (!RESEND_KEY)        return;
    if (!SUB_NOTIFY_EMAIL)  return;
    const summary = await fetchUserSummary(userId);
    const who = summary
        ? `${summary.display_name || '(no name)'} <${summary.email || 'unknown'}>`
        : `user ${userId || '(unknown)'}`;
    const isCancel = kind === 'subscription_canceled';
    const subject  = isCancel
        ? `[Parker Physics] Subscription canceled — ${plan || '?'}`
        : `[Parker Physics] New subscriber — ${plan || '?'}`;
    const amount = (typeof amountCents === 'number' && currency)
        ? `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`
        : '—';
    const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0a0a14;color:#e8f4ff;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#12111a;border:1px solid #222;border-radius:12px;padding:24px">
    <h2 style="margin:0 0 12px;color:${isCancel ? '#ff8c00' : '#4eff91'}">
      ${isCancel ? 'Subscription canceled' : 'New subscriber'}
    </h2>
    <p style="margin:0 0 14px;font-size:.9rem;color:#aab"><strong style="color:#fff">${escHtml(who)}</strong></p>
    <p style="margin:0 0 6px;font-size:.85rem;color:#aab"><strong>Plan:</strong> ${escHtml(plan || '—')}</p>
    <p style="margin:0 0 6px;font-size:.85rem;color:#aab"><strong>Amount:</strong> ${escHtml(amount)}</p>
    ${periodEndIso
        ? `<p style="margin:0 0 6px;font-size:.85rem;color:#aab"><strong>${isCancel ? 'Access until' : 'Renews'}:</strong> ${escHtml(new Date(periodEndIso).toUTCString())}</p>`
        : ''}
    <hr style="border:none;border-top:1px solid #333;margin:14px 0">
    <p style="margin:18px 0 0;font-size:.75rem;color:#778"><a href="${APP_URL}/admin.html#activation" style="color:#a080ff">Open admin → activation</a></p>
  </div>
</body></html>`;
    try {
        await fetch(RESEND_API, {
            method:  'POST',
            headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from:    FROM_EMAIL,
                to:      SUB_NOTIFY_EMAIL,
                subject,
                html,
            }),
            signal: AbortSignal.timeout(8000),
        });
    } catch (e) {
        console.warn('[StripeWebhook] subscriber notification failed:', e.message);
    }
}

/** Find the Supabase user ID from a Stripe subscription's metadata or customer. */
async function resolveUserId(subscription) {
    // Try metadata first (set at checkout)
    const uid = subscription.metadata?.supabase_uid;
    if (uid) return uid;

    // Fallback: look up by stripe_customer_id
    const customerId = subscription.customer;
    if (!customerId) return null;
    const res = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?stripe_customer_id=eq.${customerId}&select=id&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const profiles = await res.json();
    return profiles?.[0]?.id ?? null;
}

/** Fetch full subscription object from Stripe. */
async function fetchSubscription(subscriptionId) {
    const res = await fetch(`${STRIPE_API}/subscriptions/${subscriptionId}`, {
        headers: { Authorization: `Basic ${btoa(STRIPE_KEY + ':')}` },
    });
    return res.json();
}

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!STRIPE_KEY) return new Response('Webhook not configured: STRIPE_SECRET_KEY missing', { status: 501 });

    // Fail CLOSED on missing webhook secret. Previously, an unset
    // STRIPE_WEBHOOK_SECRET caused every unsigned POST to be processed
    // (the bad-signature branch was guarded by `&& WEBHOOK_SECRET`).
    // That meant an env-var rotation in progress, a fresh deployment, or
    // a misconfigured preview URL became a "any anonymous request can
    // grant any plan" endpoint. Refuse the request instead.
    if (!WEBHOOK_SECRET) {
        console.error('[StripeWebhook] STRIPE_WEBHOOK_SECRET not set — refusing all events');
        return new Response('Webhook not configured: STRIPE_WEBHOOK_SECRET missing', { status: 503 });
    }

    const rawBody  = await req.text();
    const sigValid = await verifySignature(rawBody, req.headers.get('stripe-signature'));
    if (!sigValid) {
        console.warn('[StripeWebhook] Invalid signature');
        return new Response('Invalid signature', { status: 400 });
    }

    let event;
    try { event = JSON.parse(rawBody); } catch { return new Response('Invalid JSON', { status: 400 }); }

    const type = event.type;
    console.info(`[StripeWebhook] ${type} — ${event.id}`);

    try {
        switch (type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                if (session.mode !== 'subscription') break;
                const subId = session.subscription;
                const sub   = await fetchSubscription(subId);
                const uid   = session.metadata?.supabase_uid ?? await resolveUserId(sub);
                if (!uid) { console.warn('[StripeWebhook] No user ID for session'); break; }
                const priceId   = sub.items?.data?.[0]?.price?.id;
                const plan      = PRICE_TO_PLAN[priceId] ?? sub.metadata?.plan ?? 'basic';
                const periodEnd = new Date(sub.current_period_end * 1000).toISOString();
                await updateProfile(uid, {
                    plan,
                    stripe_subscription_id: subId,
                    stripe_price_id:        priceId,
                    subscription_status:    sub.status,
                    subscription_period_end: periodEnd,
                });
                // Populate the activation funnel so the admin dashboard can
                // see paying conversions, and ping the owner.
                await logActivationServerSide(uid, 'subscription_started', plan, {
                    stripe_subscription_id: subId,
                    stripe_price_id:        priceId,
                });
                await notifyOwner({
                    kind:        'subscription_started',
                    plan,
                    userId:      uid,
                    amountCents: session.amount_total,
                    currency:    session.currency,
                    periodEndIso: periodEnd,
                });
                break;
            }

            case 'customer.subscription.updated': {
                const sub = event.data.object;
                const uid = await resolveUserId(sub);
                if (!uid) break;
                const priceId = sub.items?.data?.[0]?.price?.id;
                const plan    = PRICE_TO_PLAN[priceId] ?? sub.metadata?.plan ?? 'basic';
                // Surface "scheduled to cancel" state immediately rather than
                // waiting for subscription.deleted at period end. Stripe fires
                // this event the moment the user clicks Cancel in the billing
                // portal (cancel_at_period_end=true, status still 'active'),
                // and the dashboard renders 'canceled' as "access until period
                // end" — so flipping subscription_status here lets the user
                // see the wind-down date right away.
                const status = sub.cancel_at_period_end ? 'canceled' : sub.status;
                const updates = {
                    stripe_subscription_id: sub.id,
                    stripe_price_id:        priceId,
                    subscription_status:    status,
                    subscription_period_end: new Date(sub.current_period_end * 1000).toISOString(),
                };
                // Only update plan if subscription is active/trialing (not on cancel)
                if (sub.status === 'active' || sub.status === 'trialing') {
                    updates.plan = plan;
                }
                await updateProfile(uid, updates);
                break;
            }

            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                const uid = await resolveUserId(sub);
                if (!uid) break;
                // Two cases for this event:
                //   1. cancel_at_period_end → fires AT period end, subscription
                //      is fully wound down. Downgrade to free.
                //   2. immediate cancel via Stripe API or admin portal "Cancel
                //      immediately". Fires now, but the user paid for a period
                //      that hasn't elapsed. Honor the paid period: keep their
                //      plan + record the cutoff. The expire-canceled-subscriptions
                //      cron (or auth.js client-side guard) downgrades after.
                const periodEndMs = (sub.current_period_end ?? 0) * 1000;
                const stillPaid   = periodEndMs > Date.now() + 60_000;  // 60s skew tolerance
                const priceId    = sub.items?.data?.[0]?.price?.id;
                const cancelPlan = PRICE_TO_PLAN[priceId] ?? sub.metadata?.plan ?? null;
                if (stillPaid) {
                    console.warn(
                        `[StripeWebhook] subscription.deleted with future period_end ` +
                        `(${new Date(periodEndMs).toISOString()}) for user ${uid} — ` +
                        `preserving plan until expiry`
                    );
                    await updateProfile(uid, {
                        subscription_status:     'canceled',
                        subscription_period_end: new Date(periodEndMs).toISOString(),
                        stripe_subscription_id:  null,
                        stripe_price_id:         null,
                    });
                } else {
                    await updateProfile(uid, {
                        plan: 'free',
                        subscription_status: 'canceled',
                        stripe_subscription_id: null,
                        stripe_price_id: null,
                    });
                }
                await logActivationServerSide(uid, 'subscription_canceled', cancelPlan, {
                    stripe_subscription_id: sub.id,
                    still_paid:             stillPaid,
                });
                await notifyOwner({
                    kind:         'subscription_canceled',
                    plan:         cancelPlan,
                    userId:       uid,
                    periodEndIso: stillPaid ? new Date(periodEndMs).toISOString() : null,
                });
                break;
            }

            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                const subId = invoice.subscription;
                if (!subId) break;
                const sub = await fetchSubscription(subId);
                const uid = await resolveUserId(sub);
                if (!uid) break;
                await updateProfile(uid, { subscription_status: 'past_due' });
                break;
            }

            case 'invoice.paid': {
                const invoice = event.data.object;
                const subId = invoice.subscription;
                if (!subId) break;
                const sub = await fetchSubscription(subId);
                const uid = await resolveUserId(sub);
                if (!uid) break;
                const priceId = sub.items?.data?.[0]?.price?.id;
                const plan    = PRICE_TO_PLAN[priceId] ?? 'basic';
                await updateProfile(uid, {
                    plan,
                    subscription_status: 'active',
                    subscription_period_end: new Date(sub.current_period_end * 1000).toISOString(),
                });
                break;
            }
        }
    } catch (e) {
        console.error(`[StripeWebhook] Error handling ${type}:`, e.message);
        return new Response('Webhook handler error', { status: 500 });
    }

    return new Response('OK', { status: 200 });
}
