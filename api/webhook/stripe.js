/**
 * Vercel Edge Function: POST /api/webhook/stripe
 *
 * Handles Stripe webhook events to sync subscription state with Supabase.
 * Auth: Stripe signature verification (NOT JWT — Stripe sends these directly).
 *
 * Handled events:
 *   - customer.subscription.created   → set plan + status
 *   - customer.subscription.updated   → update plan, status, period_end
 *   - customer.subscription.deleted   → downgrade to free
 *   - invoice.payment_succeeded       → record invoice, mark active
 *   - invoice.payment_failed          → mark past_due
 *
 * All events are logged to payment_events table for audit + idempotency.
 */
export const config = { runtime: 'edge' };

import { errorResp, ErrorCodes } from '../_lib/middleware.js';
import { verifyStripeSignature, getSupabaseService, priceIdToPlan } from '../_lib/stripe.js';

export default async function handler(request) {
    if (request.method !== 'POST') {
        return errorResp(ErrorCodes.INVALID_REQUEST, 'POST required');
    }

    // ── 1. Verify webhook signature ──────────────────────────────────────
    const sig = request.headers.get('stripe-signature');
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
        return new Response('Webhook secret not configured', { status: 500 });
    }

    const rawBody = await request.text();
    const valid = await verifyStripeSignature(rawBody, sig, secret);
    if (!valid) {
        return new Response('Invalid signature', { status: 401 });
    }

    let event;
    try {
        event = JSON.parse(rawBody);
    } catch (_) {
        return new Response('Invalid JSON', { status: 400 });
    }

    // ── 2. Idempotency check ─────────────────────────────────────────────
    let sb;
    try {
        sb = await getSupabaseService();
    } catch (_) {
        return new Response('Service unavailable', { status: 503 });
    }

    // Check if we already processed this event
    try {
        const existing = await sb.query('payment_events', 'GET', {
            select: 'id',
            stripe_event_id: `eq.${event.id}`,
        });
        if (Array.isArray(existing) && existing.length > 0) {
            // Already processed — return 200 (Stripe expects success)
            return new Response(JSON.stringify({ received: true, duplicate: true }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }
    } catch (_) { /* continue — idempotency check is best-effort */ }

    // ── 3. Extract subscription data ─────────────────────────────────────
    const obj = event.data?.object;
    if (!obj) {
        return new Response('Missing event data', { status: 400 });
    }

    // Get the Supabase user ID from metadata
    const userId = obj.metadata?.supabase_uid
        || obj.subscription_details?.metadata?.supabase_uid
        || null;

    // ── 4. Handle event types ────────────────────────────────────────────
    try {
        switch (event.type) {
            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                const priceId = obj.items?.data?.[0]?.price?.id;
                const plan = priceId ? priceIdToPlan(priceId) : (obj.metadata?.plan || 'free');
                const status = obj.status;  // active, past_due, canceled, etc.
                const periodEnd = obj.current_period_end
                    ? new Date(obj.current_period_end * 1000).toISOString()
                    : null;
                const cancelAtEnd = obj.cancel_at_period_end || false;

                if (userId) {
                    await sb.rpc('sync_stripe_subscription', {
                        p_user_id: userId,
                        p_stripe_customer_id: obj.customer,
                        p_stripe_subscription_id: obj.id,
                        p_subscription_status: status,
                        p_plan: status === 'active' || status === 'trialing' ? plan : 'free',
                        p_current_period_end: periodEnd,
                        p_cancel_at_period_end: cancelAtEnd,
                    });
                }
                break;
            }

            case 'customer.subscription.deleted': {
                // Subscription canceled — downgrade to free
                if (userId) {
                    await sb.rpc('sync_stripe_subscription', {
                        p_user_id: userId,
                        p_stripe_customer_id: obj.customer,
                        p_stripe_subscription_id: obj.id,
                        p_subscription_status: 'canceled',
                        p_plan: 'free',
                        p_current_period_end: null,
                        p_cancel_at_period_end: false,
                    });
                }
                break;
            }

            case 'invoice.payment_succeeded': {
                const invoiceUserId = userId
                    || obj.subscription_details?.metadata?.supabase_uid
                    || null;

                if (invoiceUserId && obj.id) {
                    // Record the invoice
                    await sb.query('billing_invoices', 'POST', {
                        user_id: invoiceUserId,
                        stripe_invoice_id: obj.id,
                        stripe_subscription_id: obj.subscription || null,
                        amount_cents: obj.amount_paid || 0,
                        currency: obj.currency || 'usd',
                        plan_at_invoice: obj.lines?.data?.[0]?.metadata?.plan || null,
                        status: 'paid',
                        hosted_invoice_url: obj.hosted_invoice_url || null,
                        pdf_url: obj.invoice_pdf || null,
                        paid_at: new Date().toISOString(),
                        period_start: obj.period_start ? new Date(obj.period_start * 1000).toISOString() : null,
                        period_end: obj.period_end ? new Date(obj.period_end * 1000).toISOString() : null,
                    });
                }
                break;
            }

            case 'invoice.payment_failed': {
                // Mark subscription as past_due
                if (userId) {
                    await sb.query('user_profiles', 'PATCH', {
                        subscription_status: 'past_due',
                        _filter: { id: `eq.${userId}` },
                    });
                }
                break;
            }

            default:
                // Unhandled event type — log but don't error
                break;
        }

        // ── 5. Log the event for audit ───────────────────────────────────
        await sb.query('payment_events', 'POST', {
            stripe_event_id: event.id,
            event_type: event.type,
            user_id: userId || null,
            data: { type: event.type, object_id: obj.id, status: obj.status },
            processed: true,
        });

    } catch (e) {
        // Log processing failure but still return 200 to Stripe
        // (prevents Stripe from retrying endlessly for non-transient errors)
        try {
            await sb.query('payment_events', 'POST', {
                stripe_event_id: event.id,
                event_type: event.type,
                user_id: userId || null,
                data: { error: String(e.message).slice(0, 500) },
                processed: false,
            });
        } catch (_) { /* best effort */ }
    }

    return new Response(JSON.stringify({ received: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
    });
}
