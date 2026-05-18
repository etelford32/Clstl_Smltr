/**
 * Vercel Edge Function: /api/stripe/admin-metrics
 *
 * Real revenue metrics straight from Stripe, for the admin dashboard's
 * Revenue & Subscriptions row. Replaces the plan-count × hardcoded-price
 * ESTIMATE in admin.html with true MRR / churn / failed-payment numbers.
 *
 * POST /api/stripe/admin-metrics
 *   Headers: Authorization: Bearer <supabase-jwt>   (admin/superadmin only)
 *
 * Returns:
 *   { ok:true, asOf, currency,
 *     mrr, arpu, activeSubs, trialing, pastDue,
 *     canceled30d, churnRate30d, churnLostMrr,
 *     failedPayments30d, failedAmount30d, collected30d,
 *     byPlan: { basic:{subs,mrr}, … }, truncated }
 *
 * Why a server endpoint (not the Stripe MCP / client):
 *   The browser can't hold the Stripe secret key and MCP is an
 *   agent-only tool. This mirrors api/stripe/portal.js: edge runtime,
 *   Supabase-JWT verify, Basic-auth REST calls to Stripe. The only
 *   addition is an admin-role gate (portal.js is per-user; this exposes
 *   account-wide totals so it must be admin-locked).
 *
 * ── Env vars ─────────────────────────────────────────────────────────
 *   STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

export const config = { runtime: 'edge' };

const STRIPE_KEY   = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_API   = 'https://api.stripe.com/v1';
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

// Bound edge execution + Stripe load: at 100/page this caps the scan at
// 1000 subscriptions / 1000 invoices. A SaaS past that size wants the
// webhook-fed-table approach instead; `truncated` flags when we hit it.
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body, status = 200) {
    return Response.json(body, { status, headers: CORS });
}

async function stripeGet(path) {
    const res = await fetch(`${STRIPE_API}${path}`, {
        headers: { Authorization: `Basic ${btoa(STRIPE_KEY + ':')}` },
    });
    const body = await res.json();
    if (!res.ok || body?.error) {
        throw new Error(body?.error?.message || `Stripe ${res.status}`);
    }
    return body;
}

// Verify the bearer is a Supabase user AND an admin/superadmin. Returns
// the user id on success, null otherwise.
async function verifyAdmin(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    try {
        const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY || token },
        });
        if (!u.ok) return null;
        const user = await u.json();
        if (!user?.id) return null;

        const p = await fetch(
            `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${user.id}&select=role`,
            { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        const rows = await p.json();
        const role = rows?.[0]?.role;
        return (role === 'admin' || role === 'superadmin') ? user.id : null;
    } catch {
        return null;
    }
}

// Normalize a recurring price + quantity to monthly cents so yearly /
// weekly plans don't distort MRR.
function monthlyCents(price, qty) {
    const amt = (price?.unit_amount || 0) * (qty || 1);
    const r = price?.recurring;
    if (!r) return 0;
    const n = r.interval_count || 1;
    switch (r.interval) {
        case 'month': return amt / n;
        case 'year':  return amt / (12 * n);
        case 'week':  return (amt * 52) / 12 / n;
        case 'day':   return (amt * 365) / 12 / n;
        default:      return amt / n;
    }
}

function planOf(sub) {
    const m = sub.metadata?.plan;
    if (m) return String(m);
    const pr = sub.items?.data?.[0]?.price;
    return (pr?.nickname || pr?.id || 'unknown').toString();
}

async function paginate(basePath) {
    const out = [];
    let after = null;
    let pages = 0;
    let truncated = false;
    while (pages < MAX_PAGES) {
        const sep = basePath.includes('?') ? '&' : '?';
        const path = `${basePath}${sep}limit=${PAGE_SIZE}${after ? `&starting_after=${after}` : ''}`;
        const body = await stripeGet(path);
        const data = body.data || [];
        out.push(...data);
        pages++;
        if (!body.has_more || data.length === 0) { after = null; break; }
        after = data[data.length - 1].id;
    }
    if (after) truncated = true;
    return { data: out, truncated };
}

export default async function handler(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
    if (!STRIPE_KEY) return json({ ok: false, error: 'not_configured', detail: 'STRIPE_SECRET_KEY not set' }, 501);

    const adminId = await verifyAdmin(req.headers.get('Authorization'));
    if (!adminId) return json({ ok: false, error: 'unauthorized', detail: 'Admin access required' }, 401);

    const now      = Math.floor(Date.now() / 1000);
    const since30d = now - 30 * 86400;

    try {
        const subsRes = await paginate('/subscriptions?status=all');
        const invRes  = await paginate(`/invoices?created[gte]=${since30d}`);

        let mrrCents = 0, activeSubs = 0, trialing = 0, pastDue = 0;
        let canceled30d = 0, churnLostCents = 0;
        let currency = 'usd';
        const byPlan = {};

        for (const s of subsRes.data) {
            const status = s.status;
            const plan   = planOf(s);
            let subMonthly = 0;
            for (const it of (s.items?.data || [])) {
                subMonthly += monthlyCents(it.price, it.quantity);
                if (it.price?.currency) currency = it.price.currency;
            }

            if (status === 'active' || status === 'trialing') {
                if (status === 'trialing') trialing++;
                if (status === 'active') {
                    activeSubs++;
                    mrrCents += subMonthly;
                    const b = (byPlan[plan] ||= { subs: 0, mrrCents: 0 });
                    b.subs++;
                    b.mrrCents += subMonthly;
                }
            } else if (status === 'past_due' || status === 'unpaid') {
                pastDue++;
            }

            // Churn: anything Stripe stamped canceled_at within the window,
            // regardless of current status (cancel-at-period-end subs read
            // 'active' until the period rolls over).
            if (s.canceled_at && s.canceled_at >= since30d) {
                canceled30d++;
                churnLostCents += subMonthly;
            }
        }

        let collectedCents = 0, failedAmountCents = 0, failedPayments = 0;
        for (const inv of invRes.data) {
            if (inv.currency) currency = inv.currency;
            if (inv.paid === true || inv.status === 'paid') {
                collectedCents += inv.amount_paid || 0;
            } else if (inv.status === 'uncollectible'
                    || (inv.status === 'open' && (inv.attempt_count || 0) > 0)) {
                failedPayments++;
                failedAmountCents += inv.amount_due || 0;
            }
        }

        // Churn rate ≈ canceled in window / (active now + canceled in
        // window) — a simple, defensible denominator without snapshotting
        // historical sub counts.
        const churnDenom   = activeSubs + canceled30d;
        const churnRate30d = churnDenom > 0 ? +(canceled30d / churnDenom).toFixed(4) : 0;
        const mrr  = Math.round(mrrCents) / 100;
        const arpu = activeSubs > 0 ? +(mrr / activeSubs).toFixed(2) : 0;

        const byPlanOut = {};
        for (const [k, v] of Object.entries(byPlan)) {
            byPlanOut[k] = { subs: v.subs, mrr: Math.round(v.mrrCents) / 100 };
        }

        return json({
            ok: true,
            asOf: new Date().toISOString(),
            currency: currency.toUpperCase(),
            mrr,
            arpu,
            activeSubs,
            trialing,
            pastDue,
            canceled30d,
            churnRate30d,
            churnLostMrr: Math.round(churnLostCents) / 100,
            failedPayments30d: failedPayments,
            failedAmount30d: Math.round(failedAmountCents) / 100,
            collected30d: Math.round(collectedCents) / 100,
            byPlan: byPlanOut,
            truncated: subsRes.truncated || invRes.truncated,
        });
    } catch (e) {
        return json({ ok: false, error: 'stripe_error', detail: e.message }, 502);
    }
}
