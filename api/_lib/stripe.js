/**
 * api/_lib/stripe.js — Shared Stripe + Supabase helpers for billing endpoints
 *
 * Provides:
 *   - Stripe client initialization (server-side only)
 *   - Supabase service-role client (bypasses RLS for webhook writes)
 *   - Plan ↔ Stripe Price ID mapping
 *   - JWT-based user authentication for billing endpoints
 */

// ── Stripe Price IDs ─────────────────────────────────────────────────────────
// Configure these in Stripe Dashboard → Products → each plan's price.
// Then set as Vercel env vars: STRIPE_PRICE_BASIC, STRIPE_PRICE_ADVANCED
export const PLAN_CONFIG = {
    free:     { price_id: null,                                       amount: 0,     label: 'Free Trial' },
    basic:    { price_id: process.env.STRIPE_PRICE_BASIC    || null,  amount: 1000,  label: 'Basic' },
    advanced: { price_id: process.env.STRIPE_PRICE_ADVANCED || null,  amount: 10000, label: 'Advanced' },
};

/** Map a Stripe Price ID back to our plan name. */
export function priceIdToPlan(priceId) {
    for (const [plan, cfg] of Object.entries(PLAN_CONFIG)) {
        if (cfg.price_id && cfg.price_id === priceId) return plan;
    }
    return 'free';
}

// ── Stripe Client ────────────────────────────────────────────────────────────
let _stripe = null;

export function getStripe() {
    if (_stripe) return _stripe;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
    // Dynamic import not needed — Stripe SDK works in Edge Runtime via fetch
    // We use the raw REST API instead of the SDK to avoid Node.js dependencies
    _stripe = {
        _key: key,
        async request(method, path, body = null) {
            const url = `https://api.stripe.com/v1${path}`;
            const opts = {
                method,
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            };
            if (body) opts.body = new URLSearchParams(body).toString();
            const res = await fetch(url, opts);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error?.message || `Stripe HTTP ${res.status}`);
            return data;
        },
    };
    return _stripe;
}

// ── Supabase Service Client (bypasses RLS) ───────────────────────────────────
let _sbService = null;

export async function getSupabaseService() {
    if (_sbService) return _sbService;
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    // Support both new (SUPABASE_SECRET_KEY) and legacy (SUPABASE_SERVICE_KEY) env var names
    const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!url || !serviceKey) throw new Error('Supabase service credentials not configured');
    // Use raw fetch instead of SDK to stay Edge-compatible
    _sbService = {
        _url: url,
        _key: serviceKey,
        async query(table, method, params = {}) {
            let fetchUrl = `${url}/rest/v1/${table}`;
            const headers = {
                'apikey': serviceKey,
                'Authorization': `Bearer ${serviceKey}`,
                'Content-Type': 'application/json',
                'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
            };
            const opts = { headers };

            if (method === 'GET') {
                const qs = new URLSearchParams(params).toString();
                if (qs) fetchUrl += '?' + qs;
                opts.method = 'GET';
            } else if (method === 'POST') {
                opts.method = 'POST';
                opts.body = JSON.stringify(params);
            } else if (method === 'PATCH') {
                if (params._filter) {
                    fetchUrl += '?' + new URLSearchParams(params._filter).toString();
                    delete params._filter;
                }
                opts.method = 'PATCH';
                opts.body = JSON.stringify(params);
            }
            const res = await fetch(fetchUrl, opts);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
            }
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('json')) return res.json();
            return null;
        },
        async rpc(fn, params = {}) {
            const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
                method: 'POST',
                headers: {
                    'apikey': serviceKey,
                    'Authorization': `Bearer ${serviceKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(params),
            });
            if (!res.ok) throw new Error(`Supabase RPC ${res.status}`);
            return null;
        },
    };
    return _sbService;
}

// ── JWT Validation ───────────────────────────────────────────────────────────
// Extract user ID from Supabase JWT (Authorization: Bearer <jwt>).
// In production, this validates via Supabase Auth; here we decode the payload.

export async function authenticateUser(request) {
    const auth = request.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return null;

    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    // Support both new (SUPABASE_PUBLISHABLE_KEY) and legacy (SUPABASE_ANON_KEY) env var names
    const pubKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !pubKey) return null;

    try {
        // Validate JWT via Supabase Auth API (server-side verification)
        const res = await fetch(`${url}/auth/v1/user`, {
            headers: {
                'apikey': pubKey,
                'Authorization': `Bearer ${token}`,
            },
        });
        if (!res.ok) return null;
        const user = await res.json();
        return user?.id ? user : null;
    } catch (_) {
        return null;
    }
}

// ── Webhook Signature Verification ───────────────────────────────────────────
// Stripe signs webhooks with HMAC-SHA256. We verify using Web Crypto API.

export async function verifyStripeSignature(payload, sigHeader, secret) {
    if (!sigHeader || !secret) return false;

    const parts = {};
    for (const item of sigHeader.split(',')) {
        const [key, val] = item.split('=');
        parts[key.trim()] = val?.trim();
    }

    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) return false;

    // Reject if timestamp is too old (5 min tolerance)
    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
    if (age > 300) return false;

    // Compute expected signature: HMAC-SHA256(secret, timestamp + '.' + payload)
    const signedPayload = `${timestamp}.${payload}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
    const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

    // Constant-time comparison
    if (expected.length !== signature.length) return false;
    let result = 0;
    for (let i = 0; i < expected.length; i++) {
        result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return result === 0;
}
