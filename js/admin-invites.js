/**
 * admin-invites.js — Invite code management for the admin dashboard
 *
 * Invite codes are stored in the `invite_codes` Supabase table.
 * Admins can generate codes with a plan tier, max uses, and expiry.
 * Users redeem codes on the signup page to get a specific plan tier.
 *
 * Table schema (add to supabase-schema.sql):
 *   CREATE TABLE public.invite_codes (
 *       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *       code TEXT UNIQUE NOT NULL,
 *       plan TEXT DEFAULT 'free' CHECK (plan IN ('free','basic','advanced')),
 *       max_uses INTEGER DEFAULT 1,
 *       used_count INTEGER DEFAULT 0,
 *       expires_at TIMESTAMPTZ,
 *       created_by UUID REFERENCES auth.users(id),
 *       created_at TIMESTAMPTZ DEFAULT now(),
 *       active BOOLEAN DEFAULT true
 *   );
 *   ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "Admins can manage invites" ON public.invite_codes
 *       FOR ALL USING (public.is_admin());
 *   CREATE POLICY "Anyone can read active invites by code" ON public.invite_codes
 *       FOR SELECT USING (active = true AND code = current_setting('request.headers')::json->>'x-invite-code');
 */

import { getSupabase, isConfigured } from './supabase-config.js';

/** Generate a random invite code (8 chars, alphanumeric uppercase). */
function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
    let code = '';
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    for (let i = 0; i < 8; i++) code += chars[arr[i] % chars.length];
    return code;
}

/**
 * Create a new invite code.
 * @param {{ plan: string, maxUses: number, expiryDays: number }} opts
 * @returns {{ ok: boolean, code?: string, error?: string }}
 */
export async function createInviteCode({ plan = 'free', maxUses = 1, expiryDays = 30 } = {}) {
    if (!isConfigured()) return { ok: false, error: 'Supabase not configured' };
    try {
        const sb = await getSupabase();
        const { data: { user } } = await sb.auth.getUser();
        if (!user) return { ok: false, error: 'Not authenticated' };

        const code = generateCode();
        const expiresAt = expiryDays > 0
            ? new Date(Date.now() + expiryDays * 86400000).toISOString()
            : null;

        const { error } = await sb.from('invite_codes').insert({
            code,
            plan,
            max_uses: maxUses,
            used_count: 0,
            expires_at: expiresAt,
            created_by: user.id,
            active: true,
        });

        if (error) return { ok: false, error: error.message };
        return { ok: true, code };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Fetch all invite codes (admin only).
 * @returns {{ ok: boolean, data?: Array, error?: string }}
 */
export async function fetchInviteCodes() {
    if (!isConfigured()) return { ok: false, error: 'Supabase not configured', data: [] };
    try {
        const sb = await getSupabase();
        const { data, error } = await sb
            .from('invite_codes')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);
        if (error) return { ok: false, error: error.message, data: [] };
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: err.message, data: [] };
    }
}

/**
 * Deactivate an invite code.
 * @param {string} codeId - UUID of the invite code
 * @returns {{ ok: boolean, error?: string }}
 */
export async function deactivateInvite(codeId) {
    if (!isConfigured()) return { ok: false, error: 'Supabase not configured' };
    try {
        const sb = await getSupabase();
        const { error } = await sb
            .from('invite_codes')
            .update({ active: false })
            .eq('id', codeId);
        if (error) return { ok: false, error: error.message };
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Validate an invite code (used during signup).
 *
 * Calls the SECURITY DEFINER RPC `validate_invite(p_code, p_email)`
 * defined in supabase-invites-email-migration.sql instead of doing a
 * direct SELECT — the table's public SELECT policy was dropped so
 * anonymous signup can't enumerate codes any more.
 *
 * For email-targeted invites (admin sent via /api/invites/send), the
 * email argument MUST match the invited_email or the function returns
 * no rows. For bulk codes (no invited_email set), the email argument
 * is ignored.
 *
 * @param {string} code  - The invite code string
 * @param {string} [email] - Email the user is signing up with
 * @returns {{ ok: boolean, plan?: string, inviteId?: string, isTargeted?: boolean, error?: string }}
 */
export async function validateInviteCode(code, email = null) {
    if (!isConfigured()) return { ok: false, error: 'Supabase not configured' };
    if (!code || code.length < 4) return { ok: false, error: 'Invalid code' };
    try {
        const sb = await getSupabase();
        const { data, error } = await sb.rpc('validate_invite', {
            p_code:  code.toUpperCase().trim(),
            p_email: email,
        });
        if (error) return { ok: false, error: 'Invalid or expired invite code' };
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) return { ok: false, error: 'Invalid or expired invite code' };
        return {
            ok:         true,
            plan:       row.plan,
            inviteId:   row.invite_id,
            isTargeted: row.is_targeted,
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Redeem an invite code (increment used_count + set accepted_at).
 * Call after successful signup. The RPC enforces that email-targeted
 * invites only redeem when the email matches.
 *
 * @param {string} inviteId  - UUID of the invite code
 * @param {string} [email]   - Email the user signed up with (for targeted invites)
 * @returns {{ ok: boolean }}
 */
export async function redeemInviteCode(inviteId, email = null) {
    if (!isConfigured() || !inviteId) return { ok: false };
    try {
        const sb = await getSupabase();
        const { data, error } = await sb.rpc('redeem_invite', {
            invite_id: inviteId,
            p_email:   email,
        });
        if (error) return { ok: false };
        // RPC now returns BOOLEAN — true on successful redeem, false if
        // already-used / expired / email mismatch.
        return { ok: data === true || data === null };
    } catch (_) {
        return { ok: false };
    }
}

/**
 * Send an email invite to a specific address. Generates a fresh
 * single-use code targeted at that email, persists it with
 * invited_email/sent_at populated, and dispatches via Resend.
 *
 * Server endpoint enforces admin role on the JWT — this client-side
 * function only succeeds when called from an admin session.
 *
 * @param {{ email: string, plan?: string, expiryDays?: number, name?: string }} opts
 * @returns {Promise<{ ok: boolean, code?: string, link?: string, inviteId?: string, error?: string }>}
 */
export async function sendInviteEmail({ email, plan = 'free', expiryDays = 30, name } = {}) {
    if (!isConfigured()) return { ok: false, error: 'Supabase not configured' };
    if (!email)          return { ok: false, error: 'Email required' };
    try {
        const sb = await getSupabase();
        const { data: { session } } = await sb.auth.getSession();
        if (!session?.access_token) return { ok: false, error: 'Not signed in' };

        const res = await fetch('/api/invites/send', {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization:  `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ email, plan, expiry_days: expiryDays, name }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
            return { ok: false, error: body.error || `HTTP ${res.status}`, detail: body.detail };
        }
        return {
            ok:       true,
            code:     body.code,
            link:     body.link,
            inviteId: body.invite_id,
            sentTo:   body.sent_to,
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}
