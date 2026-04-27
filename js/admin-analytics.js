/**
 * admin-analytics.js — Supabase queries for the admin dashboard
 *
 * All metric fetching lives here so admin.html stays clean.
 * Every function returns { ok, data, error? } for consistent handling.
 */

import { getSupabase, isConfigured } from './supabase-config.js';

let _sb = null;
let _adminVerified = false;

async function sb() {
    if (!_sb && isConfigured()) _sb = await getSupabase();
    return _sb;
}

/**
 * Verify the current user is an authenticated admin before allowing queries.
 * This prevents non-admin users from calling admin analytics functions
 * even if they bypass the client-side admin gate.
 * RLS enforces this at the DB level too, but this is defense-in-depth.
 */
async function requireAdmin() {
    if (_adminVerified) return true;
    const client = await sb();
    if (!client) return false;
    try {
        // Validate JWT server-side (not from localStorage)
        const { data: { user }, error } = await client.auth.getUser();
        if (error || !user) return false;
        // Check admin role in user_profiles (RLS allows self-read)
        const { data: profile } = await client
            .from('user_profiles')
            .select('role')
            .eq('id', user.id)
            .single();
        const isAdmin = profile?.role === 'admin' || profile?.role === 'superadmin';
        if (isAdmin) _adminVerified = true;
        return isAdmin;
    } catch (_) { return false; }
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
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

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
        let educatorSubs = 0, institutionSubs = 0, enterpriseSubs = 0;
        if (plansRes.status === 'fulfilled' && !plansRes.value.error) {
            for (const u of plansRes.value.data || []) {
                if (u.plan === 'basic')       introSubs++;
                if (u.plan === 'educator')    educatorSubs++;
                if (u.plan === 'advanced')    proSubs++;
                if (u.plan === 'institution') institutionSubs++;
                if (u.plan === 'enterprise')  enterpriseSubs++;
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
                educatorSubs,
                proSubs,
                institutionSubs,
                enterpriseSubs,
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
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

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
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

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
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

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
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

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
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

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
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

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
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

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
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    // Input validation
    if (!code || typeof code !== 'string' || code.length < 2 || code.length > 50)
        return { ok: false, error: 'Code must be 2-50 characters' };
    if (label && (typeof label !== 'string' || label.length > 200))
        return { ok: false, error: 'Label must be under 200 characters' };
    if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 1000)
        return { ok: false, error: 'maxUses must be 1-1000' };
    if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays < 1 || expiresInDays > 365))
        return { ok: false, error: 'expiresInDays must be 1-365' };

    try {
        const row = {
            code: code.toUpperCase().replace(/[^A-Z0-9\-]/g, '').slice(0, 50),
            label: (label || '').slice(0, 200),
            max_uses: Math.min(1000, Math.max(1, Math.round(maxUses))),
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
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

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

const VALID_SEVERITY = new Set(['info', 'success', 'warning', 'critical']);
const VALID_TARGET_PLAN = new Set([
    'all', 'free', 'basic', 'educator', 'advanced', 'institution', 'enterprise',
]);

export async function createAnnouncement({ title, body, severity = 'info', targetPlan = 'all', published = false }) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    // Input validation
    if (!title || typeof title !== 'string' || title.length > 200)
        return { ok: false, error: 'Title required, max 200 characters' };
    if (body && (typeof body !== 'string' || body.length > 5000))
        return { ok: false, error: 'Body must be under 5000 characters' };
    if (!VALID_SEVERITY.has(severity))
        return { ok: false, error: 'Invalid severity. Must be: info, success, warning, critical' };
    if (!VALID_TARGET_PLAN.has(targetPlan))
        return { ok: false, error: `Invalid target plan. Must be one of: ${[...VALID_TARGET_PLAN].join(', ')}` };

    try {
        const { data, error } = await client
            .from('announcements')
            .insert({
                title: title.slice(0, 200),
                body: (body || '').slice(0, 5000),
                severity,
                target_plan: targetPlan,
                published: !!published,
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

// ── Email send activity ──────────────────────────────────────────────────────
// Reads public.email_send_log (admin-only via RLS). Returns aggregate
// counters AND a recent-activity list, in one round trip per query.

/**
 * Aggregate email send stats over a window (default last 24h).
 *
 * @param {number} windowHours - Hours to look back (24 or 168 typical)
 * @returns {{ ok: boolean, data?: {
 *     total: number, sent: number, throttled: number,
 *     byEndpoint: Record<string, { sent: number, throttled: number }>,
 *     window_hours: number,
 *   }, error?: string }}
 */
export async function fetchEmailStats(windowHours = 24) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    try {
        const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
        const { data, error } = await client
            .from('email_send_log')
            .select('endpoint, throttled')
            .gte('sent_at', since);
        if (error) throw error;

        const stats = { total: 0, sent: 0, throttled: 0, byEndpoint: {}, window_hours: windowHours };
        for (const row of data || []) {
            stats.total++;
            const ep = row.endpoint || 'unknown';
            stats.byEndpoint[ep] = stats.byEndpoint[ep] || { sent: 0, throttled: 0 };
            if (row.throttled) {
                stats.throttled++;
                stats.byEndpoint[ep].throttled++;
            } else {
                stats.sent++;
                stats.byEndpoint[ep].sent++;
            }
        }
        return { ok: true, data: stats };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Recent send activity (most recent first). Used for the admin
 * dashboard's audit table.
 */
export async function fetchEmailActivity(limit = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    try {
        const { data, error } = await client
            .from('email_send_log')
            .select('id, sent_at, endpoint, recipient_email, subject, throttled, metadata')
            .order('sent_at', { ascending: false })
            .limit(Math.min(Math.max(limit, 1), 200));
        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── Scheduled job (pg_cron) status ───────────────────────────────────────────
// Reads the admin_get_cron_status SECURITY DEFINER RPC. Surfaces every
// pg_cron job's last-run status + 24h failure count so silent cron failures
// (which currently only land in cron.job_run_details) are visible on the
// admin dashboard.

/**
 * Returns one entry per scheduled job. See the migration file for full
 * column docs. Empty result if pg_cron isn't installed or the caller
 * isn't admin (RPC degrades gracefully rather than erroring).
 */
export async function fetchCronStatus() {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    try {
        const { data, error } = await client.rpc('admin_get_cron_status');
        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── Pipeline heartbeat (per-pipeline health summary) ────────────────────────
// Reads the pipeline_heartbeat table populated by record_pipeline_success /
// record_pipeline_failure inside each pg_cron refresh function. This is the
// higher-level "is the feed alive?" view — complements the raw cron job
// table, which only reports whether the job ran, not whether the upstream
// fetch actually produced usable data. RLS on the table already allows
// anon/authenticated reads (see supabase-pipeline-heartbeat-migration.sql);
// we keep the admin gate here for consistency with the rest of this module.

/**
 * Returns one row per pipeline with freshness + failure streak info.
 * Empty result if the migration hasn't been applied or no cron job has
 * written yet. Rows sorted by pipeline_name for stable UI ordering.
 */
export async function fetchPipelineHeartbeat() {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    try {
        const { data, error } = await client
            .from('pipeline_heartbeat')
            .select('pipeline_name, last_success_at, last_failure_at, last_failure_reason, last_source, consecutive_fail, updated_at')
            .order('pipeline_name', { ascending: true });
        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}
