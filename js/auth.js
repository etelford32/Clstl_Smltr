/**
 * auth.js — Client-side authentication manager (Supabase-integrated)
 *
 * Uses Supabase Auth when configured (real email/password auth with JWT),
 * falls back to localStorage mock when Supabase isn't set up.
 *
 * ── How It Works ─────────────────────────────────────────────────────────────
 *   Supabase mode (production):
 *     signIn  → supabase.auth.signInWithPassword() → JWT stored by Supabase client
 *     signUp  → supabase.auth.signUp() → user created in auth.users + user_profiles
 *     signOut → supabase.auth.signOut() → JWT cleared
 *     reset   → supabase.auth.resetPasswordForEmail() → real email sent
 *     session → supabase.auth.getSession() → auto-refreshing JWT
 *
 *   Mock mode (development / no Supabase):
 *     Same interface, data stored in localStorage/sessionStorage.
 *     No real auth — any email/password combination "works".
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { auth } from './js/auth.js';
 *
 *   if (auth.isSignedIn()) { ... }
 *   await auth.signIn({ email, password, remember });
 *   await auth.signUp({ email, password, name, plan });
 *   auth.signOut();
 *   auth.requireAuth();
 */

import { getSupabase, isConfigured } from './supabase-config.js';
import {
    canUseAlerts as _cfgCanUseAlerts,
    canUseAdvancedAlerts as _cfgCanUseAdvancedAlerts,
    canUseEmbed as _cfgCanUseEmbed,
    hasCustomBranding as _cfgHasCustomBranding,
    isPro as _cfgIsPro,
} from './tier-config.js';

const AUTH_KEY = 'pp_auth';

class AuthManager {
    constructor() {
        this._user = null;
        this._supabase = null;
        this._initialized = false;
        this._initPromise = this._init();
    }

    async _init() {
        if (isConfigured()) {
            try {
                this._supabase = await getSupabase();
                const { data: { session } } = await this._supabase.auth.getSession();
                if (session?.user) {
                    this._user = this._mapSupabaseUser(session.user);
                    // Fetch server-side profile (role, plan) on session restore
                    // so admin status is available immediately, not just from stale user_metadata
                    await this.fetchProfile();
                    console.info('[Auth] Supabase session restored:', this._user.email, 'role:', this._user.role);
                }

                // Listen for auth state changes (login, logout, token refresh)
                // CRITICAL: _mapSupabaseUser builds the user from user_metadata,
                // which doesn't carry role/plan/seat info — that lives in
                // user_profiles and is set by fetchProfile(). Wiping the
                // existing user object on every auth event silently demotes
                // admins on token refresh, breaking the admin gate. So:
                //   - On SIGNED_OUT we clear _user.
                //   - On any other event with a session, we MERGE the new
                //     auth payload onto the existing _user (preserving role/
                //     plan/etc.) and refresh from user_profiles after a
                //     token refresh / sign-in so the server stays the source
                //     of truth.
                this._supabase.auth.onAuthStateChange(async (event, session) => {
                    if (event === 'SIGNED_OUT' || !session?.user) {
                        this._user = null;
                    } else {
                        const supaUser = session.user;
                        const mapped = this._mapSupabaseUser(supaUser);
                        // Preserve fields that come from user_profiles (role,
                        // server-side plan, seat info) across token refreshes.
                        const preserved = this._user ? {
                            role:                       this._user.role,
                            plan:                       this._user.plan,
                            display_name:               this._user.display_name,
                            subscription_status:        this._user.subscription_status,
                            subscription_period_end:    this._user.subscription_period_end,
                            classroom_seats:            this._user.classroom_seats,
                            seats_used:                 this._user.seats_used,
                            attribution_required:       this._user.attribution_required,
                            branding:                   this._user.branding,
                            parent_account_id:          this._user.parent_account_id,
                            effective_plan:             this._user.effective_plan,
                            alerts:                     this._user.alerts,
                        } : {};
                        this._user = { ...mapped, ...preserved };
                        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
                            // Re-pull server state so role/plan are current.
                            // Fire-and-forget — don't block the auth event.
                            this.fetchProfile().catch(() => {});
                        }
                    }
                    window.dispatchEvent(new CustomEvent('auth-changed', {
                        detail: { event, user: this._user }
                    }));
                });

                this._initialized = true;
                console.info('[Auth] Supabase auth active');
            } catch (err) {
                console.warn('[Auth] Supabase init failed, using mock auth:', err.message);
                this._loadMock();
                this._initialized = true;
            }
        } else {
            console.info('[Auth] Supabase not configured — using mock auth');
            this._loadMock();
            this._initialized = true;
        }
    }

    /** Wait for initialization to complete. */
    async ready() {
        await this._initPromise;
    }

    /** Map Supabase user object to our app's user shape. */
    _mapSupabaseUser(supaUser) {
        return {
            id: supaUser.id,
            email: supaUser.email,
            name: supaUser.user_metadata?.name || supaUser.email?.split('@')[0],
            plan: supaUser.user_metadata?.plan || 'free',
            role: supaUser.user_metadata?.role || 'user',
            signedIn: true,
            provider: 'supabase',
            ts: Date.now(),
        };
    }

    /** Check if current user has admin role. */
    isAdmin() {
        return this._user?.role === 'admin' || this._user?.role === 'superadmin';
    }

    /**
     * Check if current user is a tester (full feature access for testing).
     * Accepts EITHER role='tester' (legacy QA accounts) OR plan='tester'
     * (the new comp tier issued via admin invite). Both grant the same
     * access — every paid-tier gate that delegates to isTester() lights up.
     */
    isTester() {
        return this._user?.role === 'tester' || this._user?.plan === 'tester';
    }

    // ── Tier feature gates ───────────────────────────────────────────────
    // Plans, lowest → highest:
    //   free → basic → educator → advanced → institution → enterprise
    //
    // PRO ≡ Advanced. The "PRO" badge in the UI and the TIER.PRO feed
    // bucket both mean exactly: Advanced or above (Institution and
    // Enterprise are Advanced-equivalent on data access; they layer on
    // seats, branding, and support). Use isPro() below as the canonical
    // gate.
    //
    // Educator is positioned BETWEEN basic and advanced because it gates
    // on use case (classroom + embed) rather than data depth — Educator
    // gets all Basic data feeds but adds embed permission and the
    // Powered-by attribution flag.

    /** Tiers that get any kind of alert (everything except free). */
    canUseAlerts() {
        return _cfgCanUseAlerts(this.getPlan(), this.getRole());
    }

    /** Tiers that get the full advanced alert set (advanced data feeds). */
    canUseAdvancedAlerts() {
        return _cfgCanUseAdvancedAlerts(this.getPlan(), this.getRole());
    }

    /** Tiers that may embed the simulator in third-party pages. */
    canUseEmbed() {
        return _cfgCanUseEmbed(this.getPlan(), this.getRole());
    }

    /** Tiers that may replace the Parker Physics branding with their own. */
    hasCustomBranding() {
        return _cfgHasCustomBranding(this.getPlan());
    }

    /**
     * Canonical PRO gate. PRO ≡ Advanced.
     *
     * Advanced, Institution, and Enterprise plans share the same data
     * depth, the same advanced alerts, and the same simulators — they
     * differ only on seat count, branding, and support. Admins and
     * testers also pass.
     *
     * Use this for any feature gate that asks "does this user get the
     * full advanced product?". This is the canonical equivalent of the
     * `tier: 'advanced'` nav label and the `TIER.PRO` feed bucket from
     * config.js (planToTier()).
     */
    isPro() {
        return _cfgIsPro(this.getPlan(), this.getRole());
    }

    /**
     * True when the user's tier requires the "Powered by Parker Physics"
     * attribution badge to render. Reads the server-side flag if available
     * (set by the sync_tier_derived_columns trigger), else falls back to
     * the plan name. Educator is the only paid tier where attribution is
     * a licensing condition — Basic doesn't embed at all, and
     * Institution+ get to white-label.
     */
    requiresAttribution() {
        if (this._user?.attribution_required != null) return !!this._user.attribution_required;
        return this.getPlan() === 'educator';
    }

    /** Get alert preferences (or defaults if not loaded). */
    getAlertPrefs() {
        return this._user?.alerts ?? {};
    }

    /** Check if current user has superadmin role. */
    isSuperAdmin() {
        return this._user?.role === 'superadmin';
    }

    /**
     * Lowercase-canonical alias matching the DB role literal `superadmin`.
     * Prefer this in new code; isSuperAdmin() kept for back-compat.
     */
    isSuperadmin() {
        return this._user?.role === 'superadmin';
    }

    /** Get user's role. */
    getRole() {
        return this._user?.role || 'user';
    }

    /**
     * Fetch the user's profile from the user_profiles table (includes role).
     * Call after sign-in to get the server-side role (not just user_metadata).
     */
    async fetchProfile() {
        if (!this._supabase || !this._user?.id) return null;
        try {
            const { data, error } = await this._supabase
                .from('user_profiles')
                .select('role, plan, display_name, subscription_status, subscription_period_end, classroom_seats, seats_used, attribution_required, branding, parent_account_id, location_lat, location_lon, location_city, notify_aurora, notify_storm, notify_flare, notify_cme, notify_temperature, notify_sat_pass, notify_conjunction, notify_radio_blackout, notify_gps, notify_power_grid, notify_collision, notify_recurrence, notify_iono_disturbance, aurora_kp_threshold, storm_g_threshold, flare_class_threshold, conjunction_threshold_km, temp_high_f, temp_low_f, radio_r_threshold, gnss_risk_threshold, power_grid_g_threshold, email_alerts, email_min_severity, alert_cooldown_min')
                .eq('id', this._user.id)
                .single();
            if (error) {
                // If error mentions missing column, try without 'role' as fallback
                if (error.message?.includes('role') || error.message?.includes('column')) {
                    console.warn('[Auth] Role column missing — run supabase-admin.sql. Retrying without role...');
                    const { data: d2, error: e2 } = await this._supabase
                        .from('user_profiles')
                        .select('plan, display_name, location_lat, location_lon, location_city')
                        .eq('id', this._user.id)
                        .single();
                    if (!e2 && d2) {
                        this._user.plan = d2.plan || this._user.plan;
                        if (d2.display_name) this._user.name = d2.display_name;
                        this._persistToStorage();
                        return d2;
                    }
                }
                console.warn('[Auth] Profile fetch failed:', error.message);
                return null;
            }
            if (data) {
                // Merge server-side role/plan into local state
                if (data.role) this._user.role = data.role;
                this._user.plan = data.plan || this._user.plan;
                if (data.display_name) this._user.name = data.display_name;
                // Tier metadata used by dashboard subscription card + attribution badge
                this._user.subscription_status     = data.subscription_status     ?? null;
                this._user.subscription_period_end = data.subscription_period_end ?? null;
                this._user.classroom_seats         = data.classroom_seats         ?? null;
                this._user.seats_used              = data.seats_used              ?? 0;
                this._user.attribution_required    = data.attribution_required    ?? false;
                this._user.branding                = data.branding                ?? {};
                this._user.parent_account_id       = data.parent_account_id       ?? null;
                // Resolve effective plan through parent_account_id for class
                // students. effective_plan_for() is a SECURITY DEFINER RPC
                // that returns the parent's plan (or the user's own when
                // there's no parent). Failure here is non-fatal — getPlan()
                // falls back to the stored value.
                this._user.effective_plan = data.plan || 'free';
                if (data.parent_account_id) {
                    try {
                        const { data: ep } = await this._supabase.rpc('effective_plan_for', { p_user_id: this._user.id });
                        if (ep && typeof ep === 'string') this._user.effective_plan = ep;
                    } catch (_) { /* keep fallback */ }
                }
                this._user.location = data.location_lat ? {
                    lat: data.location_lat, lon: data.location_lon, city: data.location_city
                } : null;
                // Merge alert preferences into local state
                this._user.alerts = {
                    notify_aurora:         data.notify_aurora         ?? false,
                    notify_storm:          data.notify_storm          ?? false,
                    notify_flare:          data.notify_flare          ?? false,
                    notify_cme:            data.notify_cme            ?? false,
                    notify_temperature:    data.notify_temperature    ?? false,
                    notify_sat_pass:       data.notify_sat_pass       ?? false,
                    notify_conjunction:    data.notify_conjunction    ?? false,
                    notify_radio_blackout: data.notify_radio_blackout ?? false,
                    notify_gps:            data.notify_gps            ?? false,
                    notify_power_grid:     data.notify_power_grid     ?? false,
                    notify_collision:      data.notify_collision      ?? false,
                    notify_recurrence:     data.notify_recurrence     ?? false,
                    notify_iono_disturbance: data.notify_iono_disturbance ?? false,
                    aurora_kp_threshold:   data.aurora_kp_threshold   ?? 5,
                    storm_g_threshold:     data.storm_g_threshold     ?? 1,
                    flare_class_threshold: data.flare_class_threshold ?? 'M',
                    conjunction_threshold_km: data.conjunction_threshold_km ?? 25,
                    temp_high_f:           data.temp_high_f,
                    temp_low_f:            data.temp_low_f,
                    radio_r_threshold:     data.radio_r_threshold     ?? 2,
                    gnss_risk_threshold:   data.gnss_risk_threshold   ?? 2,
                    power_grid_g_threshold: data.power_grid_g_threshold ?? 4,
                    email_alerts:          data.email_alerts          ?? false,
                    email_min_severity:    data.email_min_severity    ?? 'warning',
                    alert_cooldown_min:    data.alert_cooldown_min    ?? 60,
                };
                this._persistToStorage();
                // Notify listeners (nav, dashboard) that role/plan may have changed
                window.dispatchEvent(new CustomEvent('auth-changed', {
                    detail: { event: 'PROFILE_FETCHED', user: this._user }
                }));
            }
            return data;
        } catch (err) {
            console.warn('[Auth] Profile fetch error:', err.message);
            return null;
        }
    }

    /** Load session from localStorage/sessionStorage (mock mode). */
    _loadMock() {
        let raw = null;
        try { raw = localStorage.getItem(AUTH_KEY); } catch (_) {}
        if (!raw) {
            try { raw = sessionStorage.getItem(AUTH_KEY); } catch (_) {}
        }
        if (raw) {
            try {
                const data = JSON.parse(raw);
                if (data?.signedIn) this._user = data;
            } catch (_) {}
        }
    }

    /** Check if user is signed in. */
    isSignedIn() {
        return !!(this._user?.signedIn);
    }

    /** Get current user data (or null). */
    getUser() {
        return this._user ? { ...this._user } : null;
    }

    getDisplayName() {
        if (!this._user) return 'Guest';
        return this._user.name || this._user.email?.split('@')[0] || 'Explorer';
    }

    getFirstName() {
        return this.getDisplayName().split(' ')[0];
    }

    /**
     * Effective plan after applying client-side guards. Reads `plan` straight
     * from the user_profiles row, then downgrades to 'free' if the
     * subscription is in the 'canceled' state AND the period_end has already
     * elapsed.
     *
     * Why: when Stripe receives an immediate-cancel-via-API request the
     * webhook keeps the paid plan until period_end so the user gets the
     * value they paid for. We don't have a cron that flips them back to
     * 'free' once that boundary passes — this guard makes the UI honest
     * even if the row hasn't been touched in a while.
     *
     * Admins/testers ALWAYS see their stored plan (an expired admin row
     * is still an admin row).
     */
    getPlan() {
        // Class students inherit their parent's plan via effective_plan
        // (cached during fetchProfile). When set, it short-circuits the
        // canceled-subscription guard below — a student's "subscription"
        // is the parent's, which is whatever Stripe says it is.
        const effective = (this._user?.effective_plan || '').toLowerCase();
        const stored    = (this._user?.plan || 'free').toLowerCase();
        if (effective && effective !== stored && this._user?.parent_account_id) {
            return effective;
        }
        if (this.isAdmin?.() || this.isTester?.()) return stored;
        if ((this._user?.subscription_status || '').toLowerCase() !== 'canceled') return stored;
        const endIso = this._user?.subscription_period_end;
        if (!endIso) return stored;
        const ts = Date.parse(endIso);
        if (!Number.isFinite(ts)) return stored;
        // Subscription is canceled AND we're past the paid window — treat as free.
        return ts < Date.now() ? 'free' : stored;
    }

    /**
     * Sign in with email and password.
     * @returns {{ success: boolean, error?: string }}
     */
    async signIn({ email, password, remember = false }) {
        if (this._supabase) {
            try {
                const { data, error } = await this._supabase.auth.signInWithPassword({
                    email,
                    password,
                });
                if (error) return { success: false, error: error.message };
                this._user = this._mapSupabaseUser(data.user);
                this._user.remember = remember;
                // Fetch server-side profile (role, plan — not just user_metadata)
                await this.fetchProfile();
                // Always persist after sign-in so dashboard can read it
                this._persistToStorage();
                return { success: true };
            } catch (err) {
                return { success: false, error: err.message };
            }
        }

        // Mock mode: accept any credentials
        const userData = {
            email,
            name: email.split('@')[0],
            plan: 'free',
            signedIn: true,
            remember,
            provider: 'mock',
            ts: Date.now(),
        };
        this._user = userData;
        const json = JSON.stringify(userData);
        try {
            if (remember) {
                localStorage.setItem(AUTH_KEY, json);
                sessionStorage.removeItem(AUTH_KEY);
            } else {
                sessionStorage.setItem(AUTH_KEY, json);
                localStorage.removeItem(AUTH_KEY);
            }
        } catch (_) {}

        window.dispatchEvent(new CustomEvent('auth-changed', { detail: { event: 'SIGNED_IN', user: userData } }));
        return { success: true };
    }

    /**
     * Sign up with email, password, and profile data.
     * @returns {{ success: boolean, error?: string, needsConfirmation?: boolean }}
     */
    async signUp({ email, password, name, plan = 'free' }) {
        if (this._supabase) {
            try {
                // Plan is decided server-side. The signup trigger
                // (supabase-plan-lockdown-migration.sql) HARD-CODES plan='free'
                // and IGNORES any client-supplied plan/role metadata — passing
                // them here would be a silent no-op. We omit them entirely so
                // the contract is obvious to readers and we don't tempt anyone
                // into thinking client-side state controls billing tier.
                const { data, error } = await this._supabase.auth.signUp({
                    email,
                    password,
                    options: {
                        data: { name },
                    },
                });
                if (error) return { success: false, error: error.message };

                // Check if email confirmation is required
                if (data.user && !data.session) {
                    return {
                        success: true,
                        needsConfirmation: true,
                        intendedPlan: plan,
                        message: 'Check your email for a confirmation link.',
                    };
                }

                if (data.user) {
                    this._user = this._mapSupabaseUser(data.user);
                    this._user.plan = 'free';  // enforce free until payment
                    this._persistToStorage();
                }
                return { success: true, intendedPlan: plan };
            } catch (err) {
                return { success: false, error: err.message };
            }
        }

        // Mock mode
        return this.signIn({ email, password: '', remember: true });
    }

    /** Sign out — clear session and redirect. */
    async signOut(redirectUrl = 'index.html') {
        if (this._supabase) {
            await this._supabase.auth.signOut();
        }

        this._user = null;
        try { localStorage.removeItem(AUTH_KEY); } catch (_) {}
        try { sessionStorage.removeItem(AUTH_KEY); } catch (_) {}

        window.dispatchEvent(new CustomEvent('auth-changed', { detail: { event: 'SIGNED_OUT', user: null } }));

        if (redirectUrl) window.location.href = redirectUrl;
    }

    /**
     * Server-side admin verification via Supabase.
     * Validates the JWT with Supabase Auth server, then queries user_profiles
     * for role. Cannot be bypassed via localStorage manipulation.
     * @returns {{ verified: boolean, role?: string, error?: string }}
     */
    async verifyAdminServerSide() {
        if (!this._supabase) {
            return { verified: this.isAdmin(), role: this.getRole(), error: 'Supabase not configured' };
        }
        try {
            // Try getUser() first — it cross-checks the JWT against the
            // Supabase Auth server (so a tampered local token gets rejected).
            // If that fails (auth-session-missing on cold load, network hiccup,
            // refresh window) fall back to getSession().user since the JWT
            // has already been validated once during _init/onAuthStateChange.
            let userId = null;
            let authErrMsg = null;
            try {
                const { data: { user }, error: authErr } = await this._supabase.auth.getUser();
                if (authErr) authErrMsg = authErr.message;
                userId = user?.id || null;
            } catch (e) { authErrMsg = e.message; }

            if (!userId) {
                const { data: { session } } = await this._supabase.auth.getSession();
                userId = session?.user?.id || null;
                if (!userId) {
                    return { verified: false, error: authErrMsg || 'No session' };
                }
            }

            const { data, error: dbErr } = await this._supabase
                .from('user_profiles')
                .select('role')
                .eq('id', userId)
                .single();
            if (dbErr) {
                const msg = dbErr.message || '';
                // Most common failure modes — surface the recovery action,
                // not just the raw error.
                let hint;
                if (msg.includes('role') || msg.toLowerCase().includes('column')) {
                    hint = 'Role column missing — run supabase-admin.sql in Supabase SQL Editor';
                } else if (msg.toLowerCase().includes('no rows')
                        || msg.toLowerCase().includes('multiple') ) {
                    hint = 'No user_profiles row — sign out, sign back in, then run the supabase-make-owner-superadmin.sql migration';
                } else if (dbErr.code === '42501' || msg.toLowerCase().includes('permission')) {
                    hint = `RLS denied SELECT on user_profiles — verify the "Users see own profile" policy is in place`;
                } else {
                    hint = msg;
                }
                return { verified: false, error: hint, dbCode: dbErr.code };
            }

            const role = data?.role || 'user';
            if (this._user) this._user.role = role;
            this._persistToStorage();

            const isAdmin = role === 'admin' || role === 'superadmin';
            return { verified: isAdmin, role };
        } catch (err) {
            return { verified: false, error: err.message };
        }
    }

    /**
     * Server-side superadmin verification. Same shape as
     * verifyAdminServerSide() but only passes for role === 'superadmin'.
     * Used by /superadmin.html to gate role-management + audit log.
     * @returns {{ verified: boolean, role?: string, error?: string }}
     */
    async verifySuperadminServerSide() {
        const res = await this.verifyAdminServerSide();
        if (!res || res.error || !res.role) {
            return { verified: false, role: res?.role, error: res?.error || 'No role' };
        }
        return { verified: res.role === 'superadmin', role: res.role };
    }

    /**
     * Promote a user to a new role via the audited promote_user RPC.
     * Caller permissions are enforced server-side:
     *   - admin     → may set role IN ('user', 'tester'); cannot touch admins
     *   - superadmin → may set role IN ('user', 'tester', 'admin')
     * Superadmin minting is SQL-Editor-only (no UI path).
     *
     * @param {string} userId
     * @param {'user'|'tester'|'admin'} newRole
     * @param {string} [reason]  Free-form note attached to the audit row.
     * @returns {{ success: boolean, role?: string, error?: string }}
     */
    async promoteUser(userId, newRole, reason = null) {
        if (!this._supabase) return { success: false, error: 'Supabase not configured' };
        try {
            const { data, error } = await this._supabase.rpc('promote_user', {
                p_user_id:  userId,
                p_new_role: newRole,
                p_reason:   reason,
            });
            if (error) return { success: false, error: error.message, code: error.code };
            const row = Array.isArray(data) ? data[0] : data;
            return { success: true, role: row?.role || newRole };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Superadmin-only: manually override a user's plan, bypassing Stripe.
     * Used for comp accounts that didn't go through the invite flow.
     * Reason required (10–500 characters); recorded to user_profiles_audit.
     *
     * @param {string} userId
     * @param {'free'|'basic'|'educator'|'advanced'|'institution'|'enterprise'} newPlan
     * @param {string} reason
     */
    async setUserPlanOverride(userId, newPlan, reason) {
        if (!this._supabase) return { success: false, error: 'Supabase not configured' };
        try {
            const { data, error } = await this._supabase.rpc('set_user_plan_override', {
                p_user_id:  userId,
                p_new_plan: newPlan,
                p_reason:   reason,
            });
            if (error) return { success: false, error: error.message, code: error.code };
            const row = Array.isArray(data) ? data[0] : data;
            return { success: true, plan: row?.plan || newPlan };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Superadmin-only: fetch recent role/plan/Stripe-link audit rows.
     * @param {number} [limit=100]  Server clamps to 1–1000.
     */
    async getRecentRoleAudit(limit = 100) {
        if (!this._supabase) return { success: false, error: 'Supabase not configured', rows: [] };
        try {
            const { data, error } = await this._supabase.rpc('recent_role_audit', { p_limit: limit });
            if (error) return { success: false, error: error.message, rows: [] };
            return { success: true, rows: data || [] };
        } catch (err) {
            return { success: false, error: err.message, rows: [] };
        }
    }

    /**
     * Admin/superadmin: list users for the management table.
     * @param {{ limit?: number, offset?: number, search?: string }} [opts]
     */
    async listUsersForAdmin(opts = {}) {
        if (!this._supabase) return { success: false, error: 'Supabase not configured', rows: [] };
        try {
            const { data, error } = await this._supabase.rpc('list_users_for_admin', {
                p_limit:  opts.limit  ?? 200,
                p_offset: opts.offset ?? 0,
                p_search: opts.search ?? null,
            });
            if (error) return { success: false, error: error.message, rows: [] };
            return { success: true, rows: data || [] };
        } catch (err) {
            return { success: false, error: err.message, rows: [] };
        }
    }

    /** Persist current user state to localStorage for nav.js to read. */
    _persistToStorage() {
        if (!this._user) return;
        const json = JSON.stringify(this._user);
        try { localStorage.setItem(AUTH_KEY, json); } catch (_) {}
    }

    /** Redirect to signin if not logged in. */
    requireAuth(redirectUrl = 'signin.html') {
        if (!this.isSignedIn()) {
            try { sessionStorage.setItem('pp_auth_redirect', window.location.href); } catch (_) {}
            window.location.href = redirectUrl;
            return false;
        }
        return true;
    }

    /** Get stored post-login redirect URL. */
    getPostLoginRedirect() {
        try {
            const url = sessionStorage.getItem('pp_auth_redirect');
            sessionStorage.removeItem('pp_auth_redirect');
            return url;
        } catch (_) { return null; }
    }

    /**
     * Start an OAuth sign-in flow. Provider-agnostic — the only
     * provider-specific work happens in the Supabase dashboard
     * (see OAUTH_SETUP.md). Supabase performs the redirect itself
     * via signInWithOAuth(); this method returns either an immediate
     * `{ success:true }` (browser is leaving the page) or a
     * `{ success:false, error }` if the call couldn't even start.
     *
     * The `redirectTo` URL must be on the Supabase project's allowed
     * redirect list (Authentication → URL Configuration). We default
     * to `<origin>/auth-callback.html`, which is where the provider-
     * agnostic landing page lives; opting into a different
     * redirectTo is allowed but generally only useful for tests.
     *
     * @param {'google'|'apple'|string} provider
     * @param {{ redirectTo?: string, scopes?: string }} [options]
     * @returns {Promise<{ success: boolean, error?: string }>}
     */
    async signInWithProvider(provider, options = {}) {
        if (!this._supabase) {
            return { success: false, error: 'Supabase client not configured' };
        }
        try {
            const redirectTo = options.redirectTo
                || `${window.location.origin}/auth-callback.html`;
            const { error } = await this._supabase.auth.signInWithOAuth({
                provider,
                options: {
                    redirectTo,
                    scopes: options.scopes,   // undefined → provider defaults
                    // queryParams default is fine; PKCE is auto for browsers.
                },
            });
            if (error) return { success: false, error: error.message };
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Request password reset email.
     * @returns {{ success: boolean, message: string }}
     */
    async requestPasswordReset(email) {
        if (this._supabase) {
            try {
                const { error } = await this._supabase.auth.resetPasswordForEmail(email, {
                    redirectTo: `${window.location.origin}/reset-password.html`,
                });
                if (error) return { success: false, message: error.message };
                return {
                    success: true,
                    message: `Password reset link sent to ${email}. Check your inbox.`,
                };
            } catch (err) {
                return { success: false, message: err.message };
            }
        }

        // Mock mode
        await new Promise(r => setTimeout(r, 600));
        return {
            success: true,
            message: `If an account exists for ${email}, we've sent a reset link.`,
        };
    }

    /**
     * Update user profile (name, plan, location, preferences).
     * Writes to both Supabase user_profiles table and local state.
     */
    async updateProfile(updates) {
        if (!this._user) return;
        Object.assign(this._user, updates, { ts: Date.now() });

        if (this._supabase) {
            try {
                // Update user_metadata (name, plan)
                if (updates.name || updates.plan) {
                    await this._supabase.auth.updateUser({
                        data: { name: updates.name, plan: updates.plan },
                    });
                }
                // Update user_profiles table (location, prefs, alerts)
                const row = {
                    id: this._user.id,
                    display_name: this._user.name,
                    plan: this._user.plan,
                    updated_at: new Date().toISOString(),
                };
                // Only include fields that were actually passed in updates
                const profileFields = [
                    'location_lat', 'location_lon', 'location_city',
                    'notify_aurora', 'notify_storm', 'notify_flare', 'notify_cme',
                    'notify_temperature', 'notify_sat_pass', 'notify_conjunction',
                    'notify_radio_blackout', 'notify_gps', 'notify_power_grid',
                    'notify_collision', 'notify_recurrence', 'notify_iono_disturbance',
                    'aurora_kp_threshold', 'storm_g_threshold', 'flare_class_threshold',
                    'conjunction_threshold_km', 'temp_high_f', 'temp_low_f',
                    'radio_r_threshold', 'gnss_risk_threshold', 'power_grid_g_threshold',
                    'email_alerts', 'email_min_severity', 'alert_cooldown_min',
                ];
                for (const k of profileFields) {
                    if (updates[k] !== undefined) row[k] = updates[k];
                }
                await this._supabase.from('user_profiles').upsert(row);
            } catch (err) {
                console.warn('[Auth] Profile update failed:', err.message);
            }
        } else {
            // Mock: store in localStorage
            const json = JSON.stringify(this._user);
            try {
                if (this._user.remember) localStorage.setItem(AUTH_KEY, json);
                else sessionStorage.setItem(AUTH_KEY, json);
            } catch (_) {}
        }

        window.dispatchEvent(new CustomEvent('auth-changed', { detail: { event: 'PROFILE_UPDATED', user: this._user } }));
    }
}

/** Singleton auth manager instance. */
export const auth = new AuthManager();
