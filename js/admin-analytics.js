/**
 * admin-analytics.js — Supabase queries for the admin dashboard
 *
 * All metric fetching lives here so admin.html stays clean.
 * Every function returns { ok, data, error? } for consistent handling.
 */

import { getSupabase, isConfigured } from './supabase-config.js';

let _sb = null;

async function sb() {
    if (!_sb && isConfigured()) _sb = await getSupabase();
    return _sb;
}

// ── Helper: date boundaries ──────────────────────────────────────────────────

function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
}

// ── 1. KPI Metrics (the top stat cards) ──────────────────────────────────────

/**
 * Fetch all key metrics in parallel.
 * Returns: { dailyUnique, weeklyUnique, monthlyUnique, signIns, minutesUsed,
 *            signUps, introSubs, proSubs, adminUsers, onlineNow }
 */
export async function fetchKPIs() {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };

    try {
        const [
            dailyRes,
            weeklyRes,
            monthlyRes,
            signInsRes,
            sessionsRes,
            signUpsRes,
            plansRes,
            onlineRes,
        ] = await Promise.allSettled([
            // Daily unique users (distinct user_id in analytics_events today)
            client.from('analytics_events')
                .select('user_id')
                .gte('created_at', daysAgo(1))
                .not('user_id', 'is', null),

            // Weekly unique users
            client.from('analytics_events')
                .select('user_id')
                .gte('created_at', daysAgo(7))
                .not('user_id', 'is', null),

            // Monthly unique users
            client.from('analytics_events')
                .select('user_id')
                .gte('created_at', daysAgo(30))
                .not('user_id', 'is', null),

            // Sign-ins (last 30 days)
            client.from('analytics_events')
                .select('id', { count: 'exact', head: true })
                .eq('event_name', 'sign_in')
                .gte('created_at', daysAgo(30)),

            // Total minutes used (sum of session durations)
            client.from('user_sessions')
                .select('duration_s')
                .gte('started_at', daysAgo(30)),

            // Sign-ups (all time from user_profiles)
            client.from('user_profiles')
                .select('id', { count: 'exact', head: true }),

            // Plan breakdown (all users)
            client.from('user_profiles')
                .select('plan, role'),

            // Currently online (last_seen within 2 minutes, not ended)
            client.from('user_sessions')
                .select('session_id, user_id')
                .gte('last_seen', new Date(Date.now() - 2 * 60 * 1000).toISOString())
                .eq('ended', false),
        ]);

        // Extract unique user_ids
        const uniqueUserIds = (res) => {
            if (res.status !== 'fulfilled' || res.value.error) return 0;
            const ids = new Set(res.value.data?.map(r => r.user_id).filter(Boolean));
            return ids.size;
        };

        // Sum session durations
        let minutesUsed = 0;
        if (sessionsRes.status === 'fulfilled' && !sessionsRes.value.error) {
            const totalSecs = sessionsRes.value.data?.reduce((sum, r) => sum + (r.duration_s || 0), 0) || 0;
            minutesUsed = Math.round(totalSecs / 60);
        }

        // Plan/role breakdown
        let introSubs = 0, proSubs = 0, adminUsers = 0;
        if (plansRes.status === 'fulfilled' && !plansRes.value.error) {
            for (const u of plansRes.value.data || []) {
                if (u.plan === 'basic') introSubs++;
                if (u.plan === 'advanced') proSubs++;
                if (u.role === 'admin' || u.role === 'superadmin') adminUsers++;
            }
        }

        // Online now (unique sessions)
        let onlineNow = 0;
        if (onlineRes.status === 'fulfilled' && !onlineRes.value.error) {
            onlineNow = onlineRes.value.data?.length || 0;
        }

        return {
            ok: true,
            data: {
                dailyUnique: uniqueUserIds(dailyRes),
                weeklyUnique: uniqueUserIds(weeklyRes),
                monthlyUnique: uniqueUserIds(monthlyRes),
                signIns: signInsRes.status === 'fulfilled' ? (signInsRes.value.count || 0) : 0,
                minutesUsed,
                signUps: signUpsRes.status === 'fulfilled' ? (signUpsRes.value.count || 0) : 0,
                introSubs,
                proSubs,
                adminUsers,
                onlineNow,
            },
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── 2. Users list ────────────────────────────────────────────────────────────

export async function fetchUsers(limit = 100) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };

    try {
        const { data, error } = await client
            .from('user_profiles')
            .select('id, email, display_name, role, plan, created_at, last_api_call')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── 3. Top pages (last 7 days) ──────────────────────────────────────────────

export async function fetchTopPages() {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };

    try {
        const { data, error } = await client
            .from('analytics_events')
            .select('event_name, session_id')
            .eq('event_type', 'page_view')
            .gte('created_at', daysAgo(7));

        if (error) throw error;

        // Aggregate in JS (Supabase views require admin setup, this always works)
        const pages = {};
        for (const row of data || []) {
            const name = row.event_name;
            if (!pages[name]) pages[name] = { views: 0, sessions: new Set() };
            pages[name].views++;
            if (row.session_id) pages[name].sessions.add(row.session_id);
        }

        const sorted = Object.entries(pages)
            .map(([name, d]) => ({ name, views: d.views, unique: d.sessions.size }))
            .sort((a, b) => b.views - a.views)
            .slice(0, 15);

        return { ok: true, data: sorted };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── 4. Recent events (live feed) ─────────────────────────────────────────────

export async function fetchRecentEvents(limit = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };

    try {
        const { data, error } = await client
            .from('analytics_events')
            .select('event_type, event_name, page_path, session_id, user_id, created_at, properties')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── 5. Active sessions (who's online right now) ─────────────────────────────

export async function fetchActiveSessions() {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };

    try {
        const { data, error } = await client
            .from('user_sessions')
            .select('session_id, user_id, page_path, user_agent, started_at, last_seen, duration_s')
            .gte('last_seen', new Date(Date.now() - 5 * 60 * 1000).toISOString())
            .eq('ended', false)
            .order('last_seen', { ascending: false })
            .limit(50);

        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── 6. Daily trend (for sparkline chart) ─────────────────────────────────────

export async function fetchDailyTrend(days = 14) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };

    try {
        const { data, error } = await client
            .from('analytics_events')
            .select('created_at, session_id, user_id')
            .eq('event_type', 'page_view')
            .gte('created_at', daysAgo(days));

        if (error) throw error;

        // Bucket by day
        const buckets = {};
        for (let i = 0; i < days; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            buckets[d.toISOString().slice(0, 10)] = { views: 0, users: new Set() };
        }

        for (const row of data || []) {
            const day = row.created_at?.slice(0, 10);
            if (buckets[day]) {
                buckets[day].views++;
                if (row.user_id) buckets[day].users.add(row.user_id);
            }
        }

        const trend = Object.entries(buckets)
            .map(([day, d]) => ({ day, views: d.views, users: d.users.size }))
            .sort((a, b) => a.day.localeCompare(b.day));

        return { ok: true, data: trend };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── 7. Feedback list ─────────────────────────────────────────────────────────

export async function fetchFeedback(limit = 50) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };

    try {
        const { data, error } = await client
            .from('feedback')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── 8. Beta invites ──────────────────────────────────────────────────────────

export async function fetchInvites() {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };

    try {
        const { data, error } = await client
            .from('beta_invites')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

export async function createInvite({ code, label, maxUses = 10, expiresInDays = null }) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };

    try {
        const row = {
            code: code.toUpperCase().replace(/\s/g, '-'),
            label,
            max_uses: maxUses,
            active: true,
        };
        if (expiresInDays) {
            const d = new Date();
            d.setDate(d.getDate() + expiresInDays);
            row.expires_at = d.toISOString();
        }

        const { data, error } = await client
            .from('beta_invites')
            .insert(row)
            .select()
            .single();

        if (error) throw error;
        return { ok: true, data };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── 9. Announcements ─────────────────────────────────────────────────────────

export async function fetchAnnouncements() {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };

    try {
        const { data, error } = await client
            .from('announcements')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

export async function createAnnouncement({ title, body, severity = 'info', targetPlan = 'all', published = false }) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };

    try {
        const { data, error } = await client
            .from('announcements')
            .insert({
                title,
                body,
                severity,
                target_plan: targetPlan,
                published,
                published_at: published ? new Date().toISOString() : null,
            })
            .select()
            .single();

        if (error) throw error;
        return { ok: true, data };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}
