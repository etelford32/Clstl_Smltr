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

        // Plan/role breakdown.
        //
        // basicSubs counts plan='basic' — the tier formerly labelled "Intro"
        // in early KPI dashboards. The two names are synonymous in this
        // app: 'intro' is a legacy alias for 'basic' (no plan='intro' rows
        // ever land in the DB; the CHECK constraint forbids it). The
        // `introSubs` field on the returned payload is preserved as an
        // alias for one release window so existing admin templates keep
        // working — prefer `basicSubs` going forward.
        let basicSubs = 0, proSubs = 0, adminUsers = 0;
        let educatorSubs = 0, institutionSubs = 0, enterpriseSubs = 0;
        if (plansRes.status === 'fulfilled' && !plansRes.value.error) {
            for (const u of plansRes.value.data || []) {
                if (u.plan === 'basic')       basicSubs++;
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
                basicSubs,
                introSubs: basicSubs, // legacy alias — same number as basicSubs
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

// ── 3. Top pages (last N days) ──────────────────────────────────────────────

export async function fetchTopPages(days = 7) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    try {
        const { data, error } = await client
            .from('analytics_events')
            .select('event_name, session_id')
            .eq('event_type', 'page_view')
            .gte('created_at', daysAgo(days));

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

export async function fetchRecentEvents(limit = 30, opts = {}) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    try {
        let q = client
            .from('analytics_events')
            .select('event_type, event_name, page_path, session_id, user_id, created_at, properties')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (opts.eventType) q = q.eq('event_type', opts.eventType);

        const { data, error } = await q;
        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── 4b. Average time-on-page (from page_close events) ───────────────────────

export async function fetchAvgTimeOnPage(days = 14) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    try {
        const { data, error } = await client
            .from('analytics_events')
            .select('properties')
            .eq('event_name', 'page_close')
            .gte('created_at', daysAgo(days))
            .limit(5000);

        if (error) throw error;

        let total = 0, n = 0;
        for (const row of data || []) {
            const t = row.properties?.time_on_page_s;
            // Cap a single value at 1 hour to keep one stuck tab from dominating.
            if (typeof t === 'number' && t > 0 && t < 3600) { total += t; n++; }
        }
        return { ok: true, data: { avg_s: n > 0 ? Math.round(total / n) : null, sample: n } };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ── 4c. Click heatmap (raw click events for one page) ───────────────────────

export async function fetchClickHeatmap(pageName, days = 7) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    try {
        const { data, error } = await client
            .from('analytics_events')
            .select('event_name, page_path, session_id, properties, created_at')
            .eq('event_type', 'click')
            .eq('event_name', pageName)
            .gte('created_at', daysAgo(days))
            .order('created_at', { ascending: false })
            .limit(5000);

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

// ─────────────────────────────────────────────────────────────────────────────
// Activation analytics — backed by activation_events + supabase-class-seats
// migration. All queries gated on requireAdmin(); RLS on activation_events
// enforces the same bound at the DB layer (admins-only SELECT).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Activation funnel summary by plan + event for the last N days.
 * Calls activation_funnel(p_days) which returns rows shaped:
 *   { plan, event, user_count, median_hours }
 *
 * Useful for the headline "of N signups in the last 30 days, how many
 * configured an alert / opened a sim / sent an invite, and how long
 * did it take them?"
 */
export async function fetchActivationFunnel(days = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('activation_funnel', { p_days: days });
        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        // Migration not applied yet — surface a recoverable hint.
        const hint = /function .* does not exist/i.test(err.message || '')
            ? 'activation_funnel RPC missing — run supabase-class-seats-migration.sql'
            : err.message;
        return { ok: false, error: hint };
    }
}

/**
 * Activation overview KPIs for the last N days. Single round trip to
 * activation_events; aggregated client-side. Returns:
 *   {
 *     signups,                  // # users who signed up in the window
 *     activated,                // # of those signups with ANY post-signup event
 *     activationRate,           // activated / signups (0..1)
 *     medianTimeToSimHours,     // median signup → first_sim_opened (or null)
 *     newSubscriptions,         // # subscription_started in window
 *     canceledSubscriptions,    // # subscription_canceled in window
 *     totalEvents,              // raw event count in window
 *   }
 *
 * Designed so a fresh table (no rows) returns all-zeros rather than
 * erroring — the dashboard renders it as a quiet "—".
 */
export async function fetchActivationOverview(days = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client
            .from('activation_events')
            .select('user_id, event, created_at')
            .gte('created_at', daysAgo(days))
            .order('created_at', { ascending: true });
        if (error) throw error;

        // Bucket events per user. Per-event sets allow us to derive
        // activation rate + time-to-first-sim without a second query.
        const POST_SIGNUP_EVENTS = new Set([
            'profile_completed', 'location_saved', 'first_sim_opened',
            'first_alert_configured', 'first_email_alert_sent',
            'invite_sent', 'student_joined', 'subscription_started',
        ]);
        const signupAt = new Map();      // user_id → first signup ts
        const firstSimAt = new Map();    // user_id → first first_sim_opened ts
        const activated = new Set();     // user_id with any post-signup event
        let newSubscriptions = 0;
        let canceledSubscriptions = 0;
        let totalEvents = 0;

        for (const row of (data || [])) {
            totalEvents++;
            const uid = row.user_id;
            const ev  = row.event;
            const ts  = Date.parse(row.created_at);
            if (ev === 'signup') {
                if (!signupAt.has(uid)) signupAt.set(uid, ts);
            } else if (POST_SIGNUP_EVENTS.has(ev)) {
                activated.add(uid);
                if (ev === 'first_sim_opened' && !firstSimAt.has(uid)) {
                    firstSimAt.set(uid, ts);
                }
            }
            if (ev === 'subscription_started')  newSubscriptions++;
            if (ev === 'subscription_canceled') canceledSubscriptions++;
        }

        const signups = signupAt.size;
        // Only count "activated" within the cohort that actually signed up
        // in this window — a user who signed up months ago and just opened
        // a sim shouldn't inflate the rate.
        let activatedInCohort = 0;
        const deltas = [];
        for (const [uid, suTs] of signupAt.entries()) {
            if (activated.has(uid)) activatedInCohort++;
            const simTs = firstSimAt.get(uid);
            if (simTs && simTs >= suTs) deltas.push((simTs - suTs) / 3_600_000);
        }
        deltas.sort((a, b) => a - b);
        const medianTimeToSimHours = deltas.length
            ? Math.round(deltas[Math.floor(deltas.length / 2)] * 10) / 10
            : null;

        return {
            ok: true,
            data: {
                signups,
                activated:             activatedInCohort,
                activationRate:        signups > 0 ? activatedInCohort / signups : 0,
                medianTimeToSimHours,
                newSubscriptions,
                canceledSubscriptions,
                totalEvents,
                windowDays:            days,
            },
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Daily activation rollup for the last N days. Returns one row per
 * (day, event) bucket — used by the activation chart in the admin
 * dashboard.
 */
export async function fetchActivationDaily(days = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client
            .from('activation_events')
            .select('event, plan, created_at')
            .gte('created_at', daysAgo(days))
            .order('created_at', { ascending: true });
        if (error) throw error;
        // Bucket client-side — there are at most a few thousand rows in a
        // 30-day window for a small product, and a SQL view would lock us
        // into the bucket size. Do it once here.
        const buckets = new Map();   // 'YYYY-MM-DD::event' -> count
        for (const row of (data || [])) {
            const day = (row.created_at || '').slice(0, 10);
            const key = `${day}::${row.event}`;
            buckets.set(key, (buckets.get(key) || 0) + 1);
        }
        return { ok: true, data: Array.from(buckets, ([k, v]) => {
            const [day, event] = k.split('::');
            return { day, event, count: v };
        }) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cohort retention — by signup-week, week-N return-visit rate.
// "Did the user have ANY activation event in week N after signup?"
// Approximation of true retention; cheaper than maintaining a session table.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns N weeks of cohorts × N weekly retention buckets.
 * Result shape: [{ cohort: 'YYYY-MM-DD', size, weeks: [pct,pct,…] }]
 */
export async function fetchCohortRetention(weeks = 6) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        // Pull every signup + activation event in the last N+1 weeks.
        const since = daysAgo(weeks * 7 + 7);
        const { data, error } = await client
            .from('activation_events')
            .select('user_id, event, created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: true });
        if (error) throw error;

        const signups = new Map();   // user_id -> Date(signup)
        const visits  = new Map();   // user_id -> Set(week_index)
        for (const r of (data || [])) {
            if (r.event === 'signup' && !signups.has(r.user_id)) {
                signups.set(r.user_id, new Date(r.created_at));
            }
        }
        for (const r of (data || [])) {
            const su = signups.get(r.user_id);
            if (!su) continue;
            const wkIdx = Math.floor((new Date(r.created_at) - su) / (7 * 86400_000));
            if (wkIdx < 0 || wkIdx >= weeks) continue;
            if (!visits.has(r.user_id)) visits.set(r.user_id, new Set());
            visits.get(r.user_id).add(wkIdx);
        }

        // Group signups by cohort (week of signup).
        const cohorts = new Map();   // 'YYYY-MM-DD' (Mon) -> { size, weeks:[count,…] }
        for (const [uid, suDate] of signups.entries()) {
            const monday = new Date(suDate);
            monday.setUTCHours(0, 0, 0, 0);
            monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
            const key = monday.toISOString().slice(0, 10);
            if (!cohorts.has(key)) cohorts.set(key, { size: 0, weeks: Array(weeks).fill(0) });
            const c = cohorts.get(key);
            c.size++;
            const v = visits.get(uid);
            if (v) for (const wk of v) c.weeks[wk]++;
        }

        const out = Array.from(cohorts, ([cohort, c]) => ({
            cohort,
            size: c.size,
            weeks: c.weeks.map(n => c.size > 0 ? Math.round((n / c.size) * 100) : 0),
        })).sort((a, b) => a.cohort < b.cohort ? -1 : 1);

        return { ok: true, data: out };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion: free → paid funnel rate, by week.
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchConversionRate(weeks = 8) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const since = daysAgo(weeks * 7);
        const { data, error } = await client
            .from('activation_events')
            .select('user_id, event, plan, created_at')
            .gte('created_at', since)
            .in('event', ['signup', 'subscription_started']);
        if (error) throw error;

        const buckets = new Map();   // 'YYYY-Wnn' -> { signups, conversions }
        const isoWeek = (d) => {
            // ISO week (Mon-anchored) format YYYY-Www
            const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
            date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
            const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
            const wk = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
            return `${date.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
        };

        for (const r of (data || [])) {
            const wk = isoWeek(new Date(r.created_at));
            if (!buckets.has(wk)) buckets.set(wk, { signups: 0, conversions: 0 });
            const b = buckets.get(wk);
            if (r.event === 'signup') b.signups++;
            if (r.event === 'subscription_started') b.conversions++;
        }

        const out = Array.from(buckets, ([week, b]) => ({
            week,
            signups: b.signups,
            conversions: b.conversions,
            rate: b.signups > 0 ? Math.round((b.conversions / b.signups) * 1000) / 10 : 0,
        })).sort((a, b) => a.week < b.week ? -1 : 1);

        return { ok: true, data: out };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top sims / pages — already exists as fetchTopPages, but admin/analytics
// surface wants a per-plan breakdown for "do paid users actually use Advanced
// features?". We piggyback on user_analytics + user_profiles via a join.
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchTopSimsByPlan(days = 7) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        // user_analytics lacks plan; we map user_id -> plan in two queries
        // and join client-side. Cheaper than a SQL view, simple to reason
        // about.
        const { data: analytics, error: aErr } = await client
            .from('user_analytics')
            .select('user_id, page_path, event_name, created_at')
            .gte('created_at', daysAgo(days))
            .eq('event_name', 'page_view')
            .limit(20000);
        if (aErr) throw aErr;

        const userIds = Array.from(new Set((analytics || []).map(r => r.user_id).filter(Boolean)));
        let planMap = new Map();
        if (userIds.length) {
            const { data: profiles } = await client
                .from('user_profiles')
                .select('id, plan')
                .in('id', userIds);
            for (const p of (profiles || [])) planMap.set(p.id, p.plan || 'free');
        }

        const PAGE_TO_SIM = (path) => {
            // Strip query/hash, normalize to filename, map a few aliases.
            const clean = String(path || '').split('?')[0].split('#')[0]
                .replace(/^\/+/, '').replace(/\.html$/, '');
            if (!clean || clean === 'index') return null;
            // Only count actual sim pages, not auth/admin/legal.
            const SKIP = new Set(['signin', 'signup', 'admin', 'pricing', 'eula',
                                  'privacy', 'reset-password', 'api-policy',
                                  'contact-enterprise', 'for-educators',
                                  'dashboard', 'status']);
            if (SKIP.has(clean)) return null;
            return clean;
        };

        // sim -> { plan -> count }
        const matrix = new Map();
        for (const row of (analytics || [])) {
            const sim = PAGE_TO_SIM(row.page_path);
            if (!sim) continue;
            const plan = row.user_id ? (planMap.get(row.user_id) || 'free') : 'anon';
            if (!matrix.has(sim)) matrix.set(sim, new Map());
            const inner = matrix.get(sim);
            inner.set(plan, (inner.get(plan) || 0) + 1);
        }

        const out = Array.from(matrix, ([sim, planCounts]) => ({
            sim,
            total:       Array.from(planCounts.values()).reduce((a, b) => a + b, 0),
            byPlan:      Object.fromEntries(planCounts),
        })).sort((a, b) => b.total - a.total).slice(0, 12);

        return { ok: true, data: out };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Class-roster aggregate — # of educators with N students. Helps the team see
// whether educators are actually onboarding their classes.
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchClassRosterStats() {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client
            .from('user_profiles')
            .select('id, plan, classroom_seats, seats_used, display_name')
            .in('plan', ['educator', 'institution', 'enterprise']);
        if (error) throw error;
        const educators = (data || []).map(r => ({
            id:        r.id,
            name:      r.display_name || '(no name)',
            plan:      r.plan,
            seats:     r.classroom_seats || 0,
            used:      r.seats_used || 0,
            fillRate:  r.classroom_seats > 0
                ? Math.round((r.seats_used / r.classroom_seats) * 100)
                : 0,
        }));

        const totals = educators.reduce((a, e) => {
            a.educators++;
            a.totalSeats += e.seats;
            a.usedSeats  += e.used;
            if (e.used === 0) a.dormant++;
            else if (e.fillRate >= 80) a.healthy++;
            return a;
        }, { educators: 0, totalSeats: 0, usedSeats: 0, dormant: 0, healthy: 0 });

        return { ok: true, data: { educators, totals } };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Churn / past-due / at-risk — surface subscriptions in the danger zones so
// the team can act.
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAtRiskSubscriptions() {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client
            .from('user_profiles')
            .select('id, display_name, plan, subscription_status, subscription_period_end, updated_at')
            .in('subscription_status', ['past_due', 'canceled', 'trialing'])
            .order('subscription_period_end', { ascending: true, nullsFirst: false });
        if (error) throw error;
        const now = Date.now();
        const enriched = (data || []).map(r => {
            const ts = r.subscription_period_end ? Date.parse(r.subscription_period_end) : null;
            const daysLeft = ts ? Math.round((ts - now) / 86400_000) : null;
            return { ...r, daysLeft };
        });
        return { ok: true, data: enriched };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── ONBOARDING ANALYTICS ────────────────────────────────────────────────────
//
// New surface added in the Phase-3 onboarding work. Fetches lean wrappers
// around four RPCs created in supabase-onboarding-events-migration.sql:
//
//   onboarding_funnel(p_days)   → wizard step funnel + drop-off
//   tour_metrics(p_days)        → guided-tour start/complete/skip
//   auth_flow_metrics(p_days)   → signup / signin success counts
//   new_vs_returning(p_days)    → bucketed user counts
//
// Plus one event_log query for anonymous demo telemetry (demo_entered
// and demo_signup_clicked land in event_log because the visitor isn't
// signed in and RLS on activation_events forbids unauth writes).
//
// All fetchers degrade gracefully if the migration hasn't been applied —
// the admin UI surfaces the migration filename in the empty state so an
// operator knows what to do.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wizard funnel: shown → step1 done → step2 done → step3 done → completed.
 * Returns a flat object keyed by event name with user-counts as values
 * plus three derived ratios (step-1, step-2, step-3 completion).
 */
export async function fetchWizardFunnel(days = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('onboarding_funnel', { p_days: days });
        if (error) throw error;
        const counts = Object.fromEntries((data || []).map(r => [r.event, Number(r.user_count) || 0]));
        // Note: step_completed is fired multiple times per user (one per
        // advance), but the RPC counts DISTINCT users — so the value is
        // "users who completed at least one step", not total step events.
        // For per-step drop-off we'd need a separate query that filters
        // metadata->>'step'. Keeping this lean for now; the four-bucket
        // funnel below is good enough for headline conversion.
        const shown   = counts.wizard_shown || 0;
        const stepped = counts.wizard_step_completed || 0;
        const done    = counts.wizard_completed || 0;
        const skipped = counts.wizard_skipped || 0;
        return {
            ok: true,
            data: {
                shown, stepped, completed: done, skipped,
                completionRate: shown ? +(done / shown).toFixed(3) : 0,
                skipRate:       shown ? +(skipped / shown).toFixed(3) : 0,
                anyProgress:    shown ? +(stepped / shown).toFixed(3) : 0,
            },
        };
    } catch (err) {
        const hint = /function .* does not exist/i.test(err.message || '')
            ? 'onboarding_funnel RPC missing — apply supabase-onboarding-events-migration.sql'
            : err.message;
        return { ok: false, error: hint };
    }
}

/** Tour metrics: started/completed/skipped + completion ratio. */
export async function fetchTourMetrics(days = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('tour_metrics', { p_days: days });
        if (error) throw error;
        const counts = Object.fromEntries((data || []).map(r => [r.event, Number(r.user_count) || 0]));
        const started   = counts.tour_started || 0;
        const completed = counts.tour_completed || 0;
        const skipped   = counts.tour_skipped || 0;
        return {
            ok: true,
            data: {
                started, completed, skipped,
                completionRate: started ? +(completed / started).toFixed(3) : 0,
            },
        };
    } catch (err) {
        const hint = /function .* does not exist/i.test(err.message || '')
            ? 'tour_metrics RPC missing — apply supabase-onboarding-events-migration.sql'
            : err.message;
        return { ok: false, error: hint };
    }
}

/**
 * Demo-mode metrics. Anonymous events live in event_log (analytics.event)
 * because the visitor isn't signed in, so this fetcher hits that table
 * directly instead of the activation RPCs.
 *
 * Conversion = demo_signup_clicked / demo_entered. Not perfect (a click
 * doesn't guarantee signup completion) but close enough to spot a
 * step-funnel regression.
 */
export async function fetchDemoMetrics(days = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        const { data, error } = await client
            .from('event_log')
            .select('event_name')
            .in('event_name', ['demo_entered', 'demo_signup_clicked'])
            .gte('created_at', since);
        if (error) throw error;
        let entered = 0, clicked = 0;
        for (const r of data || []) {
            if (r.event_name === 'demo_entered')        entered++;
            else if (r.event_name === 'demo_signup_clicked') clicked++;
        }
        return {
            ok: true,
            data: {
                entered, clicked,
                clickRate: entered ? +(clicked / entered).toFixed(3) : 0,
            },
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Auth flow metrics: signups / signin success / signin retries.
 *
 * Failed signins can't be logged client-side (RLS forbids unauth writes
 * to activation_events), so we surface "retries to first success" via
 * the metadata.retry_count attached to signin_succeeded rows. A high
 * average retry count is the same actionable signal as a high failure
 * rate.
 */
export async function fetchAuthFlowMetrics(days = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('auth_flow_metrics', { p_days: days });
        if (error) throw error;
        const byEvent = Object.fromEntries(
            (data || []).map(r => [r.event, { users: Number(r.user_count) || 0, events: Number(r.event_count) || 0 }])
        );
        // Retry-count average: pull metadata for signin_succeeded events
        // separately (the RPC aggregates by event only). Cheap query;
        // bounded to the same window.
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        const { data: succRows } = await client
            .from('activation_events')
            .select('metadata')
            .eq('event', 'signin_succeeded')
            .gte('created_at', since)
            .limit(5000);
        let totalRetries = 0, withRetry = 0;
        for (const r of succRows || []) {
            const n = +((r.metadata || {}).retry_count || 0);
            totalRetries += n;
            if (n > 0) withRetry++;
        }
        const succUsers = byEvent.signin_succeeded?.users || 0;
        const signups   = byEvent.signup?.users || 0;
        const welcomes  = byEvent.welcome_email_sent?.users || 0;
        const nudges    = byEvent.nudge_sent?.users || 0;
        const failUsers   = byEvent.signin_failed?.users  || 0;
        const failEvents  = byEvent.signin_failed?.events || 0;
        return {
            ok: true,
            data: {
                signups,
                signinSuccesses:   succUsers,
                signinFailures:    failUsers,
                signinFailEvents:  failEvents,
                // Distinct emails that failed ÷ (failed + succeeded).
                // Approximation: an attacker hammering one email skews
                // failEvents but not failUsers, so this is the user-
                // impact rate, not the raw error rate.
                signinFailureRate: (failUsers + succUsers) ? +(failUsers / (failUsers + succUsers)).toFixed(3) : 0,
                returningSessions: byEvent.returning_user_session?.users || 0,
                welcomeEmails:     welcomes,
                // Send rate = welcome emails / signups in the same window.
                // > 1.0 means we welcomed users who signed up before the
                // window opened (catch-up automation, future cron); < 1.0
                // means the edge endpoint is dropping sends — investigate.
                welcomeSendRate:   signups ? +(welcomes / signups).toFixed(3) : 0,
                nudgesSent:        nudges,
                // Nudge rate is the share of signups in the window that
                // got nudged (i.e. didn't finish the wizard within 24h).
                // High nudge-rate = wizard friction; investigate the
                // funnel card. Low nudge-rate AND low completion-rate
                // means the cron isn't firing (env var, RPC missing).
                nudgeRate:         signups ? +(nudges / signups).toFixed(3) : 0,
                avgRetries:        succUsers ? +(totalRetries / succUsers).toFixed(2) : 0,
                pctNeedingRetry:   succUsers ? +(withRetry / succUsers).toFixed(3) : 0,
            },
        };
    } catch (err) {
        const hint = /function .* does not exist/i.test(err.message || '')
            ? 'auth_flow_metrics RPC missing — apply supabase-onboarding-events-migration.sql'
            : err.message;
        return { ok: false, error: hint };
    }
}

/** New vs returning users in the window. */
export async function fetchNewVsReturning(days = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('new_vs_returning', { p_days: days });
        if (error) throw error;
        const counts = Object.fromEntries((data || []).map(r => [r.bucket, Number(r.user_count) || 0]));
        const newU = counts.new || 0;
        const ret  = counts.returning || 0;
        const total = newU + ret;
        return {
            ok: true,
            data: {
                new: newU, returning: ret, total,
                returningShare: total ? +(ret / total).toFixed(3) : 0,
            },
        };
    } catch (err) {
        const hint = /function .* does not exist/i.test(err.message || '')
            ? 'new_vs_returning RPC missing — apply supabase-onboarding-events-migration.sql'
            : err.message;
        return { ok: false, error: hint };
    }
}
