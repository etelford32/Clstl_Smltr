/**
 * Vercel Edge Function: GET /api/billing/status
 *
 * Returns the authenticated user's current subscription and billing info.
 * Requires Supabase JWT in Authorization header.
 *
 * Response:
 *   { plan, subscriptionStatus, currentPeriodEnd, cancelAtPeriodEnd,
 *     stripeCustomerId, recentInvoices: [...] }
 */
export const config = { runtime: 'edge' };

import { jsonResp, errorResp, ErrorCodes } from '../_lib/middleware.js';
import { authenticateUser, getSupabaseService, PLAN_CONFIG } from '../_lib/stripe.js';

export default async function handler(request) {
    if (request.method !== 'GET') {
        return errorResp(ErrorCodes.INVALID_REQUEST, 'GET required');
    }

    const user = await authenticateUser(request);
    if (!user) {
        return errorResp(ErrorCodes.UNAUTHORIZED, 'Sign in required');
    }

    let sb;
    try {
        sb = await getSupabaseService();
    } catch (_) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Service not configured');
    }

    // Fetch profile + recent invoices in parallel
    try {
        const [profiles, invoices] = await Promise.all([
            sb.query('user_profiles', 'GET', {
                select: 'plan,subscription_status,current_period_end,cancel_at_period_end,stripe_customer_id',
                id: `eq.${user.id}`,
            }),
            sb.query('billing_invoices', 'GET', {
                select: 'stripe_invoice_id,amount_cents,currency,plan_at_invoice,status,paid_at,hosted_invoice_url,pdf_url,period_start,period_end',
                user_id: `eq.${user.id}`,
                order: 'created_at.desc',
                limit: '10',
            }),
        ]);

        const profile = Array.isArray(profiles) ? profiles[0] : null;
        if (!profile) {
            return errorResp(ErrorCodes.NOT_FOUND, 'Profile not found');
        }

        const plan = profile.plan || 'free';
        const planInfo = PLAN_CONFIG[plan] || PLAN_CONFIG.free;

        return jsonResp({
            plan,
            planLabel: planInfo.label,
            pricePerMonth: planInfo.amount / 100,
            subscriptionStatus: profile.subscription_status || 'none',
            currentPeriodEnd: profile.current_period_end || null,
            cancelAtPeriodEnd: profile.cancel_at_period_end || false,
            hasStripeCustomer: !!profile.stripe_customer_id,
            invoices: (invoices || []).map(inv => ({
                id: inv.stripe_invoice_id,
                amount: `$${(inv.amount_cents / 100).toFixed(2)}`,
                currency: inv.currency,
                plan: inv.plan_at_invoice,
                status: inv.status,
                paidAt: inv.paid_at,
                invoiceUrl: inv.hosted_invoice_url,
                pdfUrl: inv.pdf_url,
                periodStart: inv.period_start,
                periodEnd: inv.period_end,
            })),
        }, 200, 0);  // no caching — billing data is private
    } catch (e) {
        return errorResp(ErrorCodes.UPSTREAM_UNAVAILABLE, 'Failed to fetch billing data');
    }
}
