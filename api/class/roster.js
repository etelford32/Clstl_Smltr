/**
 * Vercel Edge Function: /api/class/roster
 *
 * Class-roster management for the Educator/Institution dashboard.
 *
 * GET  /api/class/roster
 *   Returns the calling user's roster:
 *     { ok, parent_plan, classroom_seats, seats_used, students: [...] }
 *
 * DELETE /api/class/roster?student_id=<uuid>
 *   Detaches a student from the calling user's roster (decrements
 *   seats_used). Authorization is enforced inside release_class_seat()
 *   in the database — non-parents and non-admins are silently rejected.
 *
 * POST /api/class/roster/cancel
 *   Cancels a pending invite (deactivates the row) so a typo'd email
 *   doesn't burn a seat. Body: { invite_id }.
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://aijsboodkivnhzfstvdq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    || 'https://parkerphysics.com,https://parkersphysics.com,https://parkerphysics.app')
    .split(',').map(s => s.trim()).filter(Boolean);

function corsHeaders(origin) {
    const ok = origin && ALLOWED_ORIGINS.includes(origin);
    return {
        'Access-Control-Allow-Origin':  ok ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Cache-Control':                'no-store',
    };
}

function jsonResp(body, status = 200, origin = '') {
    return Response.json(body, { status, headers: corsHeaders(origin) });
}

async function verifyUser(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY || token },
        signal: AbortSignal.timeout(8000),
    });
    if (!userRes.ok) return null;
    const user = await userRes.json();
    if (!user?.id) return null;
    return { id: user.id, email: user.email, jwt: token };
}

async function fetchProfile(userId) {
    const res = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=plan,classroom_seats,seats_used,role`,
        {
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
            signal: AbortSignal.timeout(8000),
        }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : null;
}

/**
 * Call class_roster() RPC with the user's own JWT so SECURITY DEFINER
 * uses auth.uid() = caller. Service-role calls would lose the auth.uid().
 */
async function callRosterRpc(userJwt) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/class_roster`, {
        method: 'POST',
        headers: {
            apikey:        SUPABASE_KEY,    // anon-equivalent header still required
            Authorization: `Bearer ${userJwt}`,
            'Content-Type':'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`class_roster ${res.status}: ${detail}`);
    }
    return res.json();
}

/** Pending invites the calling user has issued but haven't been redeemed. */
async function fetchPendingInvites(userId) {
    const res = await fetch(
        `${SUPABASE_URL}/rest/v1/invite_codes`
        + `?created_by=eq.${userId}`
        + `&is_class_seat=eq.true`
        + `&active=eq.true`
        + `&used_count=eq.0`
        + `&select=id,code,invited_email,sent_at,expires_at`
        + `&order=sent_at.desc.nullslast`
        + `&limit=200`,
        {
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
            signal: AbortSignal.timeout(8000),
        }
    );
    if (!res.ok) return [];
    const rows = await res.json();
    // Filter out expired ones at the application layer (saves a CASE in SQL).
    const now = Date.now();
    return (rows || []).filter(r => !r.expires_at || new Date(r.expires_at).getTime() > now);
}

async function releaseSeat(userJwt, studentId) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/release_class_seat`, {
        method: 'POST',
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${userJwt}`,
            'Content-Type':'application/json',
        },
        body: JSON.stringify({ p_student_id: studentId }),
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const out = await res.json();
    return out === true;
}

async function cancelInvite(userId, inviteId) {
    // Service-role PATCH gated by created_by match; cheaper than another RPC.
    const res = await fetch(
        `${SUPABASE_URL}/rest/v1/invite_codes`
        + `?id=eq.${inviteId}`
        + `&created_by=eq.${userId}`
        + `&used_count=eq.0`,
        {
            method: 'PATCH',
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type':'application/json',
                Prefer:        'return=representation',
            },
            body: JSON.stringify({ active: false }),
            signal: AbortSignal.timeout(8000),
        }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
}

export default async function handler(req) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (!SUPABASE_KEY) return jsonResp({ error: 'not_configured' }, 501, origin);

    const auth = await verifyUser(req.headers.get('Authorization'));
    if (!auth) return jsonResp({ error: 'unauthorized' }, 401, origin);

    const profile = await fetchProfile(auth.id);
    if (!profile) return jsonResp({ error: 'profile_not_found' }, 404, origin);

    // ── GET → roster + pending invites ────────────────────────────
    if (req.method === 'GET') {
        try {
            const [students, pending] = await Promise.all([
                callRosterRpc(auth.jwt),
                fetchPendingInvites(auth.id),
            ]);
            return jsonResp({
                ok:              true,
                parent_plan:     profile.plan,
                classroom_seats: profile.classroom_seats,
                seats_used:      profile.seats_used ?? 0,
                students,
                pending,
            }, 200, origin);
        } catch (e) {
            return jsonResp({ error: 'roster_failed', detail: e.message }, 500, origin);
        }
    }

    // ── DELETE → release a seat ───────────────────────────────────
    if (req.method === 'DELETE') {
        const url = new URL(req.url);
        const studentId = url.searchParams.get('student_id');
        if (!studentId) return jsonResp({ error: 'missing_student_id' }, 400, origin);
        const ok = await releaseSeat(auth.jwt, studentId);
        return jsonResp({ ok }, ok ? 200 : 403, origin);
    }

    // ── POST → cancel a pending invite ────────────────────────────
    if (req.method === 'POST') {
        let body;
        try { body = await req.json(); } catch { return jsonResp({ error: 'invalid_body' }, 400, origin); }
        const inviteId = String(body.invite_id || '').trim();
        if (!inviteId) return jsonResp({ error: 'missing_invite_id' }, 400, origin);
        const ok = await cancelInvite(auth.id, inviteId);
        return jsonResp({ ok }, ok ? 200 : 404, origin);
    }

    return jsonResp({ error: 'method_not_allowed' }, 405, origin);
}
