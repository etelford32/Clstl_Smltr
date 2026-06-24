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
            uniqCountsRes,
        ] = await Promise.allSettled([
            // Daily traffic. We pull both session_id and user_id so the
            // dashboard can show "unique visitors" (distinct session_id —
            // includes logged-out + pre-identify traffic) as the headline
            // and "signed-in users" (distinct non-null user_id) as the
            // sub-metric. The old query filtered user_id IS NOT NULL, which
            // discarded every anonymous row and (before the identify fix)
            // every row period. session_id is set on every event from the
            // first page_view, so it survives the consent gate the same way.
            client.from('analytics_events')
                .select('session_id, user_id')
                .gte('created_at', daysAgo(1)),

            // Weekly traffic
            client.from('analytics_events')
                .select('session_id, user_id')
                .gte('created_at', daysAgo(7)),

            // Monthly traffic
            client.from('analytics_events')
                .select('session_id, user_id')
                .gte('created_at', daysAgo(30)),

            // Sign-ins (last 30 days). Counts every successful sign-in,
            // not distinct users — signin_succeeded is intentionally NOT a
            // single-fire activation event (see js/activation.js SINGLE_FIRE),
            // so each sign-in writes its own row. The old query targeted
            // analytics_events.event_name='sign_in', an event no code ever
            // emits, so this KPI was structurally pinned at 0. activation_events
            // is the canonical signin pipeline (same source as the auth-flow
            // card via auth_flow_metrics) and is admin-readable under RLS.
            client.from('activation_events')
                .select('id', { count: 'exact', head: true })
                .eq('event', 'signin_succeeded')
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

            // Accurate distinct visitor/user counts, computed server-side
            // (supabase-analytics-unique-counts-migration.sql). Preferred
            // over the row-scan above: COUNT(DISTINCT …) on the server
            // can't be truncated by PostgREST's max-rows cap the way a
            // 30-day analytics_events SELECT can. If the migration hasn't
            // been applied yet this rejects (PGRST202 / 404) and we fall
            // back to the in-JS de-dupe of the scans above.
            client.rpc('analytics_unique_counts'),
        ]);

        // Distinct non-null user_id → signed-in users.
        const uniqueUserIds = (res) => {
            if (res.status !== 'fulfilled' || res.value.error) return 0;
            const ids = new Set(res.value.data?.map(r => r.user_id).filter(Boolean));
            return ids.size;
        };
        // Distinct session_id → unique visitors (anonymous-inclusive). A
        // null/blank session_id is dropped rather than collapsed into one
        // bogus "visitor" bucket.
        const uniqueSessionIds = (res) => {
            if (res.status !== 'fulfilled' || res.value.error) return 0;
            const ids = new Set(res.value.data?.map(r => r.session_id).filter(Boolean));
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

        // Prefer the server-side distinct counts; fall back to de-duping
        // the row scans in JS if the RPC isn't deployed. The fallback is
        // still subject to PostgREST's row cap on a busy 30-day window —
        // it's a transitional path until the migration is applied.
        let visitors = { day: 0, week: 0, month: 0 };
        let users    = { day: 0, week: 0, month: 0 };
        const rpcRows = (uniqCountsRes.status === 'fulfilled'
            && !uniqCountsRes.value.error
            && Array.isArray(uniqCountsRes.value.data))
            ? uniqCountsRes.value.data : null;
        if (rpcRows) {
            for (const row of rpcRows) {
                const k = row.window_label;
                if (k === 'day' || k === 'week' || k === 'month') {
                    visitors[k] = Number(row.unique_visitors) || 0;
                    users[k]    = Number(row.signed_in_users) || 0;
                }
            }
        } else {
            visitors = {
                day:   uniqueSessionIds(dailyRes),
                week:  uniqueSessionIds(weeklyRes),
                month: uniqueSessionIds(monthlyRes),
            };
            users = {
                day:   uniqueUserIds(dailyRes),
                week:  uniqueUserIds(weeklyRes),
                month: uniqueUserIds(monthlyRes),
            };
        }

        return {
            ok: true,
            data: {
                // Headline = unique visitors (distinct session_id).
                dailyVisitors: visitors.day,
                weeklyVisitors: visitors.week,
                monthlyVisitors: visitors.month,
                // Sub-metric = signed-in users (distinct user_id). Kept under
                // the original *Unique keys so existing consumers don't break.
                dailyUnique: users.day,
                weeklyUnique: users.week,
                monthlyUnique: users.month,
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

// ── Forecast accumulator stats ──────────────────────────────────────────────
// Aggregates over forecast_log + forecast_archive_pointer for the admin
// "Forecast Accumulator" tile. The underlying RPC (get_accumulator_stats)
// is SECURITY DEFINER and rejects non-admins itself; this wrapper still
// gates on requireAdmin() for consistency + early-out.

/**
 * Returns { authorized, hot_total, hot_today, hot_24h, hot_oldest,
 *           archived_total, archived_days, archived_last_day,
 *           archived_last_bytes, archived_total_bytes, as_of }.
 * `authorized: false` is normal in the pre-migration state — the
 * dashboard tile renders an empty-state in that case.
 */
export async function fetchAccumulatorStats() {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    try {
        const { data, error } = await client.rpc('get_accumulator_stats');
        if (error) throw error;
        return { ok: true, data: data || {} };
    } catch (err) {
        // RPC missing (migration not applied yet) → return a not-installed
        // marker so the tile shows a one-line install hint instead of
        // a generic error.
        const msg = err?.message || String(err);
        const missing = /function .* does not exist/i.test(msg)
            || /not found/i.test(msg);
        return { ok: false, error: msg, missing };
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
 * A/B results for one experiment over the last N days. One row per
 * variant: exposures, CTA-click conversions, conversion_rate (%).
 * Backed by telemetry_experiment_ab_summary (admin-only RPC).
 */
export async function fetchExperimentAB(experiment, days = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('telemetry_experiment_ab_summary', {
            p_experiment: experiment,
            p_days: days,
        });
        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        const hint = /function .* does not exist/i.test(err.message || '')
            ? 'telemetry_experiment_ab_summary RPC missing — run supabase-experiment-ab-migration.sql'
            : err.message;
        return { ok: false, error: hint };
    }
}

// ── Stats helpers (Wilson CI + two-proportion z-test) ───────────────────────
// Kept client-side so we can iterate without re-deploying SQL. Wilson is the
// standard recommended interval for binomial proportions — handles n=0 and
// extreme rates (p near 0 or 1) gracefully where the normal approximation
// falls apart. Exported so the dashboard JS can render bounds directly.

/**
 * Wilson score 95% confidence interval for a binomial proportion.
 * Returns { lo, hi, point } as fractions in [0, 1]. n=0 returns nulls.
 */
export function wilsonCI95(conversions, exposures) {
    const n = Number(exposures) || 0;
    const c = Number(conversions) || 0;
    if (n <= 0) return { lo: null, hi: null, point: null };
    const p = c / n;
    const z = 1.96;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
    return {
        point: p,
        lo:    Math.max(0, center - margin),
        hi:    Math.min(1, center + margin),
    };
}

/**
 * Two-proportion z-test (pooled). Returns { z, pTwoSided, significant }.
 * Significance threshold is the operator-friendly p<0.05 (|z|>1.96).
 */
export function twoProportionZ(c1, n1, c2, n2) {
    n1 = Number(n1) || 0; n2 = Number(n2) || 0;
    c1 = Number(c1) || 0; c2 = Number(c2) || 0;
    if (n1 === 0 || n2 === 0) return { z: null, pTwoSided: null, significant: false };
    const p1 = c1 / n1, p2 = c2 / n2;
    const pp = (c1 + c2) / (n1 + n2);
    const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
    if (!(se > 0)) return { z: 0, pTwoSided: 1, significant: false };
    const z = (p2 - p1) / se;
    // Two-sided p-value via the standard-normal survival approximation.
    // Abramowitz & Stegun 26.2.17 — accurate to ~7.5e-8 for any |z|.
    const az = Math.abs(z);
    const t = 1 / (1 + 0.2316419 * az);
    const d = 0.3989422804014327 * Math.exp(-az * az / 2);
    const tail = d * (((((1.330274429 * t - 1.821255978) * t) + 1.781477937) * t - 0.356563782) * t + 0.319381530) * t;
    const pTwoSided = 2 * tail;
    return { z, pTwoSided, significant: az > 1.96 };
}

/**
 * Per-variant × per-goal exposures and conversions for an experiment.
 * Reads analytics_events via telemetry_experiment_goals_summary RPC.
 *
 * Returns:
 *   {
 *     ok, data: {
 *       experiment, days, goals, variants,
 *       rows: [{ variant, goal, exposures, conversions }, ...],
 *     }
 *   }
 *
 * The client (or dashboard) renders Wilson CIs from the raw counts using
 * wilsonCI95() and lift / significance using twoProportionZ() above.
 */
export async function fetchExperimentGoals(experiment, goals, days = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    if (!experiment || !Array.isArray(goals) || goals.length === 0) {
        return { ok: false, error: 'experiment + goals[] required' };
    }
    try {
        const { data, error } = await client.rpc('telemetry_experiment_goals_summary', {
            p_experiment: experiment,
            p_goals:      goals,
            p_days:       days,
        });
        if (error) throw error;
        const rows = data || [];
        const variants = Array.from(new Set(rows.map(r => r.variant))).sort();
        return {
            ok: true,
            data: { experiment, days, goals, variants, rows },
        };
    } catch (err) {
        const hint = /function .* does not exist|PGRST202/i.test(err.message || '')
            ? 'telemetry_experiment_goals_summary RPC missing — run supabase-experiment-ab-v2-migration.sql'
            : err.message;
        return { ok: false, error: hint };
    }
}

/**
 * Per-variant Day-N retention curve. Day buckets are fixed server-side at
 * {1, 3, 7, 14, 28}; only visitors with sufficient follow-up time are
 * scored for a given bucket so retention isn't artificially low on the
 * trailing edge of the window.
 *
 * Returns: { ok, data: { experiment, days, variants, rows: [{ variant, day_n, exposed, returned }] } }
 */
export async function fetchExperimentRetention(experiment, days = 60) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    if (!experiment) return { ok: false, error: 'experiment required' };
    try {
        const { data, error } = await client.rpc('telemetry_experiment_retention', {
            p_experiment: experiment,
            p_days:       days,
        });
        if (error) throw error;
        const rows = data || [];
        const variants = Array.from(new Set(rows.map(r => r.variant))).sort();
        return {
            ok: true,
            data: { experiment, days, variants, rows },
        };
    } catch (err) {
        const hint = /function .* does not exist|PGRST202/i.test(err.message || '')
            ? 'telemetry_experiment_retention RPC missing — run supabase-experiment-ab-v2-migration.sql'
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
// ── Retention depth: daily curve, stickiness, feature return rates ──────────
// Backed by supabase-retention-depth-migration.sql. All three RPCs are
// is_admin()-gated and read existing tables (no schema change).

/**
 * Day-N retention curve from the signup cohort. Day buckets fixed server-
 * side at {1, 2, 3, 7, 14, 28}; only signups with enough follow-up time
 * elapsed are scored for a given bucket. Cohort source is
 * activation_events.event='signup'; return signal is any analytics_events
 * row with the user's user_id in the day-N follow-up window.
 *
 * Returns: { ok, data: { cohortDays, rows: [{ day_n, exposed, returned }] } }
 */
export async function fetchDailyRetentionCurve(cohortDays = 60) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('retention_daily_curve', {
            p_cohort_days: cohortDays,
        });
        if (error) throw error;
        return { ok: true, data: { cohortDays, rows: data || [] } };
    } catch (err) {
        const hint = /function .* does not exist|PGRST202/i.test(err.message || '')
            ? 'retention_daily_curve RPC missing — run supabase-retention-depth-migration.sql'
            : err.message;
        return { ok: false, error: hint };
    }
}

/**
 * DAU / WAU / MAU stickiness for both signed-in users and anonymous
 * visitors. Stickiness is DAU/MAU as a percentage — the standard SaaS
 * read is <10% low, 10-20% healthy, >20% strong daily habit.
 *
 * Returns: { ok, data: { dau, wau, mau, anonDau, anonWau, anonMau, stickiness, anonStickiness } }
 */
export async function fetchStickiness() {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('retention_stickiness');
        if (error) throw error;
        const r = (data && data[0]) || {};
        return {
            ok: true,
            data: {
                dau:            Number(r.dau) || 0,
                wau:            Number(r.wau) || 0,
                mau:            Number(r.mau) || 0,
                anonDau:        Number(r.anon_dau) || 0,
                anonWau:        Number(r.anon_wau) || 0,
                anonMau:        Number(r.anon_mau) || 0,
                stickiness:     r.stickiness != null     ? Number(r.stickiness)     : null,
                anonStickiness: r.anon_stickiness != null ? Number(r.anon_stickiness) : null,
            },
        };
    } catch (err) {
        const hint = /function .* does not exist|PGRST202/i.test(err.message || '')
            ? 'retention_stickiness RPC missing — run supabase-retention-depth-migration.sql'
            : err.message;
        return { ok: false, error: hint };
    }
}

/**
 * Per-feature (page_path) return-within-N-days rate. Top-K features by
 * use volume; for each, the % of distinct visitors whose first use was
 * followed by another use within p_window_days.
 *
 * Returns: { ok, data: { days, windowDays, rows: [{ feature, first_users, returners, total_uses }] } }
 */
export async function fetchFeatureReturnRates(days = 30, limit = 20, windowDays = 7) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('feature_return_rates', {
            p_days:        days,
            p_limit:       limit,
            p_window_days: windowDays,
        });
        if (error) throw error;
        return { ok: true, data: { days, windowDays, rows: data || [] } };
    } catch (err) {
        const hint = /function .* does not exist|PGRST202/i.test(err.message || '')
            ? 'feature_return_rates RPC missing — run supabase-retention-depth-migration.sql'
            : err.message;
        return { ok: false, error: hint };
    }
}

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
// Visitor flow — derived from analytics_events page_view rows. One round trip
// per call; everything (entry/exit pages, transitions, bounce rate, anon vs
// signed split, referrers) is computed client-side from the same dataset to
// keep this cheap on Supabase. No schema change required.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Headline visitor-flow stats for the window. Returns:
 *   {
 *     sessions, anonSessions, signedSessions,
 *     pageviews, avgPagesPerSession, bounceRate,
 *     avgSessionDurationSec,
 *     entryPages:   [{ name, count, share }],
 *     exitPages:    [{ name, count, share }],
 *     transitions:  [{ from, to, count }],
 *     referrers:    [{ origin, count, share }],
 *     anonConverted: # of sessions that started anonymous and ended signed-in
 *   }
 *
 * Capped at 30k events to keep payload sane on long windows. Beyond that
 * the dashboard hint suggests narrowing the window.
 */
export async function fetchVisitorFlow(days = 7) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    const HARD_CAP = 30000;
    try {
        const { data, error } = await client
            .from('analytics_events')
            .select('event_name, page_path, session_id, user_id, referrer, created_at')
            .eq('event_type', 'page_view')
            .gte('created_at', daysAgo(days))
            .order('created_at', { ascending: true })
            .limit(HARD_CAP);
        if (error) throw error;

        const rows = data || [];
        const truncated = rows.length >= HARD_CAP;

        // Group by session — each session becomes a chronological page
        // sequence. We collapse adjacent duplicates (A → A) because those
        // are reloads / SPA-route-noise, not navigation.
        const sessions = new Map();   // sid -> { pages:[name], firstTs, lastTs, hadUser }
        for (const r of rows) {
            const sid = r.session_id;
            if (!sid) continue;
            const name = r.event_name || _pageNameFromPath(r.page_path);
            const ts = Date.parse(r.created_at);
            let s = sessions.get(sid);
            if (!s) {
                s = {
                    pages: [], firstTs: ts, lastTs: ts,
                    hadUser: !!r.user_id,
                    firstHadNoUser: !r.user_id,
                    firstReferrer: r.referrer || null,
                };
                sessions.set(sid, s);
            }
            // Drop consecutive duplicates.
            if (s.pages[s.pages.length - 1] !== name) s.pages.push(name);
            if (ts > s.lastTs) s.lastTs = ts;
            if (r.user_id) s.hadUser = true;
        }

        // ── Aggregate ─────────────────────────────────────────────────
        const entryCount = new Map();
        const exitCount  = new Map();
        const transition = new Map();   // 'from→to' -> count
        const refCount   = new Map();
        let totalPages = 0;
        let bounces    = 0;
        let totalDurationMs = 0;
        let withDuration    = 0;
        let anonSessions    = 0;
        let signedSessions  = 0;
        let anonConverted   = 0;

        for (const [sid, s] of sessions) {
            const pages = s.pages;
            if (!pages.length) continue;
            entryCount.set(pages[0], (entryCount.get(pages[0]) || 0) + 1);
            exitCount.set(pages[pages.length - 1], (exitCount.get(pages[pages.length - 1]) || 0) + 1);
            totalPages += pages.length;
            if (pages.length === 1) bounces++;
            for (let i = 0; i < pages.length - 1; i++) {
                const key = pages[i] + '→' + pages[i + 1];
                transition.set(key, (transition.get(key) || 0) + 1);
            }
            // Duration = last_seen - first_seen for this session. Sessions
            // with only one page_view have duration 0 by definition; skip
            // them so the average isn't dragged toward zero by bounces.
            if (s.lastTs > s.firstTs) {
                totalDurationMs += (s.lastTs - s.firstTs);
                withDuration++;
            }
            if (s.hadUser) signedSessions++;
            else           anonSessions++;
            // "Converted" = session has signed-in events but landing was anon.
            // Heuristic: hadUser is true but the FIRST event had no user_id.
            // We can't perfectly tell from the cap-limited dataset, but the
            // session row was inserted in chronological order — if hadUser
            // is true and the first row's user_id was null, we treat that
            // as a conversion within the visit.
            if (s.hadUser && s.firstHadNoUser) anonConverted++;
            // Referrers — only the first referrer per session matters.
            if (s.firstReferrer) {
                refCount.set(s.firstReferrer, (refCount.get(s.firstReferrer) || 0) + 1);
            }
        }

        const sessionCount = sessions.size;
        const sortTop = (m, n = 10) => Array.from(m, ([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count).slice(0, n)
            .map(x => ({ ...x, share: sessionCount ? +(x.count / sessionCount).toFixed(3) : 0 }));

        const topTransitions = Array.from(transition, ([k, count]) => {
            const [from, to] = k.split('→');
            return { from, to, count };
        }).sort((a, b) => b.count - a.count).slice(0, 15);

        const topReferrers = Array.from(refCount, ([origin, count]) => ({ origin, count }))
            .sort((a, b) => b.count - a.count).slice(0, 10)
            .map(r => ({ ...r, share: sessionCount ? +(r.count / sessionCount).toFixed(3) : 0 }));

        return {
            ok: true,
            data: {
                windowDays:            days,
                sessions:              sessionCount,
                anonSessions,
                signedSessions,
                anonConverted,
                pageviews:             totalPages,
                avgPagesPerSession:    sessionCount ? +(totalPages / sessionCount).toFixed(2) : 0,
                bounceRate:            sessionCount ? +(bounces / sessionCount).toFixed(3) : 0,
                avgSessionDurationSec: withDuration ? Math.round(totalDurationMs / withDuration / 1000) : 0,
                entryPages:            sortTop(entryCount, 10),
                exitPages:             sortTop(exitCount, 10),
                transitions:           topTransitions,
                referrers:             topReferrers,
                truncated,
            },
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * First-touch acquisition breakdown — slices new sessions by the attribution
 * snapshot emitted by analytics.js (`session_start` event) on the page where
 * each session was minted. One round trip, capped at 30k rows; aggregation
 * runs client-side so we can pivot on any dimension without an RPC per slice.
 *
 * Returns:
 *   {
 *     totalSessions,
 *     identifiedSessions,                 // sessions that ever had a user_id
 *     identifiedShare,
 *     byChannel:    [{ key, sessions, identified, identifiedRate, share }],
 *     bySource:     [{ key, ... }],       // utm_source (or '(none)')
 *     byMedium:     [{ key, ... }],       // utm_medium
 *     byCampaign:   [{ key, ... }],
 *     byLanding:    [{ key, ... }],       // landing_page
 *     byReferrer:   [{ key, ... }],       // referrer_host (non-paid only)
 *     byDevice:     [{ key, ... }],       // mobile | tablet | desktop
 *     byCountry:    [{ key, ... }],       // tz_offset_min bucketed (rough)
 *     truncated,
 *   }
 *
 * "Identified" = downstream proxy for conversion: did this session ever
 * carry a user_id on any later analytics_events row? Cheap signal, joins
 * across event types without needing a new RPC.
 */
export async function fetchAcquisition(days = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };

    const HARD_CAP = 30000;
    try {
        // session_start rows carry the first-touch payload; pull the window.
        const startsP = client
            .from('analytics_events')
            .select('session_id, user_id, properties, created_at')
            .eq('event_type', 'event')
            .eq('event_name', 'session_start')
            .gte('created_at', daysAgo(days))
            .order('created_at', { ascending: false })
            .limit(HARD_CAP);

        // All sessions with a user_id in the same window — used to mark which
        // session_start sessions converted to identified at any point.
        const idsP = client
            .from('analytics_events')
            .select('session_id')
            .not('user_id', 'is', null)
            .gte('created_at', daysAgo(days))
            .limit(HARD_CAP);

        const [{ data: starts, error: e1 }, { data: ids, error: e2 }] = await Promise.all([startsP, idsP]);
        if (e1) throw e1;
        if (e2) throw e2;

        const rows = starts || [];
        const truncated = rows.length >= HARD_CAP;
        const identifiedSet = new Set((ids || []).map(r => r.session_id).filter(Boolean));

        // Bucket builders keyed by dimension. Each cell tracks both totals
        // and identified-counts so the ratio survives aggregation.
        const cells = {
            channel: new Map(), source: new Map(), medium: new Map(),
            campaign: new Map(), landing: new Map(), referrer: new Map(),
            device: new Map(), country: new Map(),
        };
        const bump = (m, key, identified) => {
            const k = key == null || key === '' ? '(none)' : String(key).slice(0, 120);
            const cur = m.get(k) || { sessions: 0, identified: 0 };
            cur.sessions++;
            if (identified) cur.identified++;
            m.set(k, cur);
        };

        // tz_offset_min → rough country/region bucket. Not authoritative — a
        // proper geo lookup needs server-side IP resolution — but it's a
        // useful coarse cut today without any new dependency.
        const tzBucket = (off) => {
            if (off == null || !Number.isFinite(off)) return null;
            // JS getTimezoneOffset returns minutes WEST of UTC, sign flipped
            // from the usual UTC±N convention. Convert: +480 → UTC-8.
            const utc = -Math.round(off / 60);
            if (utc >= -10 && utc <= -4) return 'Americas';
            if (utc >= -3 && utc <= 3)   return 'Europe/Africa';
            if (utc >= 4  && utc <= 11)  return 'Asia/Oceania';
            return `UTC${utc >= 0 ? '+' : ''}${utc}`;
        };

        let totalSessions = 0;
        let identifiedSessions = 0;
        const seenSessions = new Set();   // dedupe in case the same session got two session_start rows

        for (const r of rows) {
            const sid = r.session_id;
            if (!sid || seenSessions.has(sid)) continue;
            seenSessions.add(sid);
            const p = r.properties || {};
            const wasIdentified = identifiedSet.has(sid) || !!r.user_id;
            totalSessions++;
            if (wasIdentified) identifiedSessions++;

            bump(cells.channel,  p.channel || 'direct', wasIdentified);
            bump(cells.source,   p.utm_source,          wasIdentified);
            bump(cells.medium,   p.utm_medium,          wasIdentified);
            bump(cells.campaign, p.utm_campaign,        wasIdentified);
            bump(cells.landing,  p.landing_page,        wasIdentified);
            // Don't count paid traffic in the organic referrer breakdown —
            // it conflates ad networks with editorial links.
            if (p.channel !== 'paid') bump(cells.referrer, p.referrer_host, wasIdentified);
            bump(cells.device,   p.device,              wasIdentified);
            bump(cells.country,  tzBucket(p.tz_offset_min), wasIdentified);
        }

        const top = (m, n = 10) => {
            const arr = Array.from(m, ([key, v]) => ({
                key,
                sessions:       v.sessions,
                identified:     v.identified,
                identifiedRate: v.sessions ? +(v.identified / v.sessions).toFixed(3) : 0,
                share:          totalSessions ? +(v.sessions / totalSessions).toFixed(3) : 0,
            }));
            return arr.sort((a, b) => b.sessions - a.sessions).slice(0, n);
        };

        return {
            ok: true,
            data: {
                windowDays:         days,
                totalSessions,
                identifiedSessions,
                identifiedShare:    totalSessions ? +(identifiedSessions / totalSessions).toFixed(3) : 0,
                byChannel:          top(cells.channel,  8),
                bySource:           top(cells.source,   12),
                byMedium:           top(cells.medium,   12),
                byCampaign:         top(cells.campaign, 12),
                byLanding:          top(cells.landing,  15),
                byReferrer:         top(cells.referrer, 15),
                byDevice:           top(cells.device,   4),
                byCountry:          top(cells.country,  10),
                truncated,
            },
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Last-page-of-session distribution, but bucketed by whether the visitor
 * ever signed in. Lets the dashboard show "of anonymous visitors who
 * landed on /pricing, X% bounced and Y% navigated to /signup".
 *
 * Returns: { ok, data: [{ entry, anonNext: [{ to, count }], signedNext: [...] }] }
 */
export async function fetchEntryDestinations(days = 7, topN = 6) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client
            .from('analytics_events')
            .select('event_name, session_id, user_id, created_at')
            .eq('event_type', 'page_view')
            .gte('created_at', daysAgo(days))
            .order('created_at', { ascending: true })
            .limit(30000);
        if (error) throw error;

        const sessions = new Map();
        for (const r of data || []) {
            const sid = r.session_id;
            if (!sid) continue;
            let s = sessions.get(sid);
            if (!s) { s = { pages: [], hadUser: !!r.user_id }; sessions.set(sid, s); }
            const name = r.event_name;
            if (s.pages[s.pages.length - 1] !== name) s.pages.push(name);
            if (r.user_id) s.hadUser = true;
        }

        // entry -> { anonNext: Map(to,count), signedNext: Map(to,count), bouncesAnon, bouncesSigned }
        const buckets = new Map();
        for (const s of sessions.values()) {
            if (!s.pages.length) continue;
            const entry = s.pages[0];
            if (!buckets.has(entry)) buckets.set(entry, {
                anonNext: new Map(), signedNext: new Map(),
                bouncesAnon: 0, bouncesSigned: 0,
                totalAnon: 0, totalSigned: 0,
            });
            const b = buckets.get(entry);
            if (s.hadUser) b.totalSigned++; else b.totalAnon++;
            if (s.pages.length === 1) {
                if (s.hadUser) b.bouncesSigned++; else b.bouncesAnon++;
            } else {
                const next = s.pages[1];
                const m = s.hadUser ? b.signedNext : b.anonNext;
                m.set(next, (m.get(next) || 0) + 1);
            }
        }

        const out = Array.from(buckets, ([entry, b]) => {
            const total = b.totalAnon + b.totalSigned;
            const top = (m, n = 5) => Array.from(m, ([to, count]) => ({ to, count }))
                .sort((a, b) => b.count - a.count).slice(0, n);
            return {
                entry,
                total,
                totalAnon:    b.totalAnon,
                totalSigned:  b.totalSigned,
                bouncesAnon:  b.bouncesAnon,
                bouncesSigned:b.bouncesSigned,
                anonNext:     top(b.anonNext),
                signedNext:   top(b.signedNext),
            };
        }).sort((a, b) => b.total - a.total).slice(0, topN);

        return { ok: true, data: out };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

function _pageNameFromPath(p) {
    if (!p) return '(none)';
    return String(p).split('?')[0].split('#')[0]
        .replace(/^\/+/, '').replace(/\.html?$/i, '') || 'index';
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
// features?". We piggyback on analytics_events + user_profiles via a join.
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchTopSimsByPlan(days = 7) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        // analytics_events lacks plan; we map user_id -> plan in two queries
        // and join client-side. Cheaper than a SQL view, simple to reason
        // about. (Filter by event_type — analytics_events.event_name carries
        // the page slug, not the event kind.)
        const { data: analytics, error: aErr } = await client
            .from('analytics_events')
            .select('user_id, page_path, event_type, created_at')
            .gte('created_at', daysAgo(days))
            .eq('event_type', 'page_view')
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
// Plus one analytics_events query for anonymous demo telemetry
// (demo_entered and demo_signup_clicked land in analytics_events via
// analytics.event() because the visitor isn't signed in and RLS on
// activation_events forbids unauth writes).
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
 * Demo-mode metrics. Anonymous events live in analytics_events (written
 * by analytics.event()) because the visitor isn't signed in, so this
 * fetcher hits that table directly instead of the activation RPCs.
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
            .from('analytics_events')
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
        const confirmed = byEvent.signup_confirmed?.users || 0;
        const welcomes  = byEvent.welcome_email_sent?.users || 0;
        const nudges    = byEvent.nudge_sent?.users || 0;
        const magicReqs = byEvent.signin_magic_link_requested?.users || 0;
        const magicEvts = byEvent.signin_magic_link_requested?.events || 0;
        const failUsers   = byEvent.signin_failed?.users  || 0;
        const failEvents  = byEvent.signin_failed?.events || 0;
        return {
            ok: true,
            data: {
                signups,
                signupsConfirmed:  confirmed,
                // Confirmation rate = confirmed / total signups in the
                // window. Lower than 1.0 means email-gated users dropped
                // off before clicking the confirmation link OR the
                // trigger isn't applied (apply
                // supabase-signup-confirmed-migration.sql). Higher than
                // 1.0 means the window saw confirmations for accounts
                // that signed up earlier — catch-up is normal in the
                // first weeks after the trigger ships.
                confirmationRate:  signups ? +(confirmed / signups).toFixed(3) : 0,
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
                // Magic-link funnel: how many distinct users requested
                // a sign-in link, how many total requests fired (some
                // users hit "Resend"), and what fraction of all sign-in
                // successes appear to come from the magic-link flow.
                // The denominator is signins-in-window, not magic-link
                // requests, because some links are clicked outside the
                // window. Sanity-cap at 100% in case of clock skew.
                magicLinkRequests:     magicReqs,
                magicLinkRequestEvents: magicEvts,
                magicLinkShare:        succUsers ? Math.min(1,
                    +(magicReqs / succUsers).toFixed(3)) : 0,
            },
        };
    } catch (err) {
        const hint = /function .* does not exist/i.test(err.message || '')
            ? 'auth_flow_metrics RPC missing — apply supabase-onboarding-events-migration.sql'
            : err.message;
        return { ok: false, error: hint };
    }
}

/**
 * Daily sign-in health check — the verdict from api/cron/auth-healthcheck.js,
 * read via the auth_healthcheck_summary() SECURITY DEFINER RPC. Surfaces the
 * latest per-method pass/fail, end-to-end latency, and the recent pass-rate so
 * "is sign-in broken?" has a one-glance answer instead of a manual test.
 *
 * Returns { ok, data: { last_ran_at, last_ok, last_password_ok, last_profile_ok,
 *   last_google_ok, last_magiclink_ok, last_latency_ms, last_detail, runs,
 *   passes, pass_rate } } or { ok:true, data:null } when no run has landed yet.
 */
export async function fetchAuthHealthcheck(limit = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('auth_healthcheck_summary', { p_limit: limit });
        if (error) throw error;
        return { ok: true, data: (Array.isArray(data) ? data[0] : data) || null };
    } catch (err) {
        const hint = /function .* does not exist/i.test(err.message || '')
            ? 'auth_healthcheck_summary RPC missing — apply supabase-auth-healthcheck-migration.sql'
            : err.message;
        return { ok: false, error: hint };
    }
}

/**
 * Recent auth-funnel drop-offs — sessions whose last funnel stage in the
 * window is NOT a success terminal. Returns up to `limit` rows ordered
 * newest-first, each carrying the funnel_id (copyable into the replay RPC),
 * the last stage seen, the recorded reason / code / provider / method, and
 * the route the session was on when it stalled.
 *
 * Powers the admin "Last 50 auth funnel drop-offs" card — the
 * one-screen diagnosis surface for "the sign-in is broken" tickets.
 */
export async function fetchAuthFunnelDropoffs(days = 7, limit = 50) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('telemetry_auth_funnel_dropoffs', {
            p_days:  days,
            p_limit: limit,
        });
        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        const msg = err.message || '';
        const hint = /function .* does not exist/i.test(msg)
            ? 'telemetry_auth_funnel_dropoffs RPC missing — apply supabase-auth-funnel-dropoffs-migration.sql'
            : /forbidden|permission|42501/i.test(msg)
            ? 'Superadmin only — sign in as a superadmin to view drop-offs'
            : msg;
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

// ── Client telemetry: perf / errors / 404s / auth failures ──────────────────
// All four RPCs live in supabase-client-telemetry-migration.sql and are
// superadmin-gated server-side (is_superadmin()), so a plain admin gets a
// 42501 and the shared hint below. Data is written by js/telemetry.js
// (web_vital / error / not_found / auth_failure kinds in client_telemetry).

function _telemetryHint(err, rpc, migration) {
    const msg = err?.message || '';
    if (/function .* does not exist|PGRST202/i.test(msg)) {
        return `${rpc} RPC missing — apply ${migration}`;
    }
    if (/forbidden|permission|42501|superadmin/i.test(msg)) {
        return 'Superadmin only — sign in as a superadmin to view this';
    }
    return msg || 'Unknown error';
}

/** Web Vitals + app-perf p50/p95 per (metric, route). */
export async function fetchPerfSummary(days = 7, limit = 50) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('telemetry_perf_summary', { p_days: days, p_limit: limit });
        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: _telemetryHint(err, 'telemetry_perf_summary', 'supabase-client-telemetry-migration.sql') };
    }
}

/** Top JS error fingerprints in the window. */
export async function fetchTopErrors(days = 30, limit = 25) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('telemetry_top_errors', { p_days: days, p_limit: limit });
        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: _telemetryHint(err, 'telemetry_top_errors', 'supabase-client-telemetry-migration.sql') };
    }
}

/** Top 404 routes in the window. */
export async function fetchTop404s(days = 30, limit = 25) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('telemetry_top_404s', { p_days: days, p_limit: limit });
        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: _telemetryHint(err, 'telemetry_top_404s', 'supabase-client-telemetry-migration.sql') };
    }
}

/**
 * Analytics consent opt-in rate — the correction factor for every
 * consent-gated KPI. Returns prompts / decisions / analytics_opt_in /
 * functional_opt_in / optin_rate / engagement_rate (rates 0..1 or null
 * before any traffic). Admin-gated server-side.
 */
export async function fetchConsentOptinRate(days = 30) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('consent_optin_rate', { p_days: days });
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        return {
            ok: true,
            data: {
                prompts:          Number(row?.prompts) || 0,
                decisions:        Number(row?.decisions) || 0,
                analyticsOptIn:   Number(row?.analytics_opt_in) || 0,
                functionalOptIn:  Number(row?.functional_opt_in) || 0,
                // null (not 0) when undefined so the UI shows "—" rather
                // than a misleading 0% before any decisions are recorded.
                optinRate:        row?.optin_rate == null ? null : Number(row.optin_rate),
                engagementRate:   row?.engagement_rate == null ? null : Number(row.engagement_rate),
            },
        };
    } catch (err) {
        return { ok: false, error: _telemetryHint(err, 'consent_optin_rate', 'supabase-consent-telemetry-migration.sql') };
    }
}

/** Top auth-failure reasons (client_telemetry ∪ auth_failures). */
export async function fetchTopAuthFailures(days = 30, limit = 15) {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data, error } = await client.rpc('telemetry_top_auth_failures', { p_days: days, p_limit: limit });
        if (error) throw error;
        return { ok: true, data: data || [] };
    } catch (err) {
        return { ok: false, error: _telemetryHint(err, 'telemetry_top_auth_failures', 'supabase-client-telemetry-migration.sql') };
    }
}

/**
 * Live revenue metrics from Stripe via /api/stripe/admin-metrics
 * (server-side; the browser can't hold the Stripe key). Replaces the
 * plan-count × hardcoded-price estimate on the Revenue row. Returns
 * { ok:true, data:{ mrr, arpu, activeSubs, trialing, pastDue,
 * canceled30d, churnRate30d, churnLostMrr, failedPayments30d,
 * failedAmount30d, collected30d, currency, asOf, truncated, byPlan } }.
 */
export async function fetchStripeMetrics() {
    const client = await sb();
    if (!client) return { ok: false, error: 'Supabase not configured' };
    if (!await requireAdmin()) return { ok: false, error: 'Admin verification failed' };
    try {
        const { data: { session } } = await client.auth.getSession();
        const token = session?.access_token;
        if (!token) return { ok: false, error: 'No active session' };

        const res = await fetch('/api/stripe/admin-metrics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body?.ok === false) {
            const code = body?.error || `http_${res.status}`;
            const hint = code === 'not_configured'
                ? 'Stripe not configured — set STRIPE_SECRET_KEY in the deploy env for live revenue'
                : code === 'unauthorized'
                ? 'Admin access required for Stripe metrics'
                : (body?.detail || code);
            return { ok: false, error: hint };
        }
        return { ok: true, data: body };
    } catch (err) {
        return { ok: false, error: err.message || 'Stripe metrics request failed' };
    }
}
