/**
 * spaceship-designer-store.js — Persistence for the Space Ship Designer.
 *
 * Two tiers, mirroring the satellite-designer "Hangar":
 *   • Anonymous  → a single in-browser draft in localStorage (no account).
 *   • Signed in  → a roster of named designs in Supabase (table
 *                  public.spaceship_designs), one JSONB blob per ship, with
 *                  RLS scoping every row to its owner. See
 *                  supabase-spaceship-designs-migration.sql.
 *
 * All Supabase writes go straight from the browser via the anon key — RLS does
 * the access control, so there is no serverless wrapper. Per-plan save caps are
 * enforced by a BEFORE INSERT trigger in the migration.
 */

import { auth } from './auth.js';
import { getSupabase, isConfigured } from './supabase-config.js';

const DRAFT_KEY = 'pp_ssd_draft_v1';
const TABLE = 'spaceship_designs';

// ── Local draft (works signed-out) ───────────────────────────────────────────
export function saveDraft(design) {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(design)); return true; }
    catch { return false; }
}

export function loadDraft() {
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

export function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

// ── Cloud hangar (signed in) ─────────────────────────────────────────────────
function userId() {
    return auth.getUser?.()?.id || null;
}

export function canCloudSave() {
    return !!(isConfigured() && userId());
}

/** List the signed-in pilot's saved ships, most-recent first. */
export async function listDesigns() {
    const uid = userId();
    if (!uid || !isConfigured()) return [];
    try {
        const sb = await getSupabase();
        const { data, error } = await sb
            .from(TABLE)
            .select('id, name, description, design_data, best_score, updated_at')
            .eq('user_id', uid)
            .order('updated_at', { ascending: false });
        if (error) { console.warn('[SSD store] list failed:', error.message); return []; }
        return data || [];
    } catch (e) {
        console.warn('[SSD store] list error:', e.message);
        return [];
    }
}

/**
 * Upsert a design into the signed-in pilot's hangar (keyed on user_id + name).
 * Returns { ok, error?, limitReached? }.
 */
export async function saveDesign(design, { bestScore = 0, description = '' } = {}) {
    const uid = userId();
    if (!uid) return { ok: false, error: 'not_signed_in' };
    if (!isConfigured()) return { ok: false, error: 'supabase_unconfigured' };
    const name = String(design.name || 'Untitled').slice(0, 60);
    try {
        const sb = await getSupabase();
        const { error } = await sb.from(TABLE).upsert({
            user_id: uid,
            name,
            description: String(description || '').slice(0, 280),
            design_data: design,
            best_score: Math.max(0, Math.round(bestScore)),
            updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,name' });
        if (error) {
            const limitReached = /limit reached/i.test(error.message) || error.code === '23514';
            return { ok: false, error: error.message, limitReached };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export async function deleteDesign(id) {
    const uid = userId();
    if (!uid) return { ok: false, error: 'not_signed_in' };
    try {
        const sb = await getSupabase();
        const { error } = await sb.from(TABLE).delete().eq('id', id).eq('user_id', uid);
        if (error) return { ok: false, error: error.message };
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}
