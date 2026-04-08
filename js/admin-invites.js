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
 * @param {string} code - The invite code string
 * @returns {{ ok: boolean, plan?: string, error?: string }}
 */
export async function validateInviteCode(code) {
    if (!isConfigured()) return { ok: false, error: 'Supabase not configured' };
    if (!code || code.length < 4) return { ok: false, error: 'Invalid code' };
    try {
        const sb = await getSupabase();
        const { data, error } = await sb
            .from('invite_codes')
            .select('id, code, plan, max_uses, used_count, expires_at, active')
            .eq('code', code.toUpperCase().trim())
            .eq('active', true)
            .single();
        if (error || !data) return { ok: false, error: 'Invalid or expired invite code' };
        if (data.used_count >= data.max_uses) return { ok: false, error: 'Invite code has been fully used' };
        if (data.expires_at && new Date(data.expires_at) < new Date()) return { ok: false, error: 'Invite code has expired' };
        return { ok: true, plan: data.plan, inviteId: data.id };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Redeem an invite code (increment used_count). Call after successful signup.
 * @param {string} inviteId - UUID of the invite code
 * @returns {{ ok: boolean }}
 */
export async function redeemInviteCode(inviteId) {
    if (!isConfigured() || !inviteId) return { ok: false };
    try {
        const sb = await getSupabase();
        const { error } = await sb.rpc('redeem_invite', { invite_id: inviteId });
        if (error) {
            // Fallback: direct increment
            const { error: err2 } = await sb
                .from('invite_codes')
                .update({ used_count: sb.raw('used_count + 1') })
                .eq('id', inviteId);
            if (err2) return { ok: false };
        }
        return { ok: true };
    } catch (_) {
        return { ok: false };
    }
}
