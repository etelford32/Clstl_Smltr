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
                this._supabase.auth.onAuthStateChange((event, session) => {
                    if (session?.user) {
                        this._user = this._mapSupabaseUser(session.user);
                    } else {
                        this._user = null;
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

    /** Check if current user is a tester (full feature access for testing). */
    isTester() {
        return this._user?.role === 'tester';
    }

    // ── Tier-tier feature gates ──────────────────────────────────────────
    // Plans, lowest → highest:
    //   free → basic → educator → advanced → institution → enterprise
    //
    // Educator is positioned BETWEEN basic and advanced because it gates
    // on use case (classroom + embed) rather than data depth — Educator
    // gets all Basic data feeds but adds embed permission and the
    // Powered-by attribution flag. Institution and Enterprise are
    // Advanced-equivalent for data access.

    /** Tiers that get any kind of alert (everything except free). */
    canUseAlerts() {
        const PAID = new Set(['basic', 'educator', 'advanced', 'institution', 'enterprise']);
        return PAID.has(this.getPlan()) || this.isAdmin() || this.isTester();
    }

    /** Tiers that get the full advanced alert set (advanced data feeds). */
    canUseAdvancedAlerts() {
        const plan = this.getPlan();
        return plan === 'advanced'
            || plan === 'institution'
            || plan === 'enterprise'
            || this.isAdmin()
            || this.isTester();
    }

    /** Tiers that may embed the simulator in third-party pages. */
    canUseEmbed() {
        const plan = this.getPlan();
        return plan === 'educator'
            || plan === 'institution'
            || plan === 'enterprise'
            || this.isAdmin()
            || this.isTester();
    }

    /** Tiers that may replace the Parker Physics branding with their own. */
    hasCustomBranding() {
        const plan = this.getPlan();
        return plan === 'institution' || plan === 'enterprise';
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
                .select('role, plan, display_name, subscription_status, subscription_period_end, classroom_seats, seats_used, attribution_required, branding, location_lat, location_lon, location_city, notify_aurora, notify_storm, notify_flare, notify_cme, notify_temperature, notify_sat_pass, notify_conjunction, notify_radio_blackout, notify_gps, notify_power_grid, notify_collision, notify_recurrence, notify_iono_disturbance, aurora_kp_threshold, storm_g_threshold, flare_class_threshold, conjunction_threshold_km, temp_high_f, temp_low_f, radio_r_threshold, gnss_risk_threshold, power_grid_g_threshold, email_alerts, email_min_severity, alert_cooldown_min')
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
        const stored = (this._user?.plan || 'free').toLowerCase();
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
            // No Supabase — fall back to local check
            return { verified: this.isAdmin(), role: this.getRole(), error: 'Supabase not configured' };
        }
        try {
            const { data: { user }, error: authErr } = await this._supabase.auth.getUser();
            if (authErr || !user) return { verified: false, error: authErr?.message || 'No session' };

            const { data, error: dbErr } = await this._supabase
                .from('user_profiles')
                .select('role')
                .eq('id', user.id)
                .single();
            if (dbErr) {
                // If role column doesn't exist, the error will mention "role".
                // Provide a helpful message so the admin knows to run the migration.
                const msg = dbErr.message || '';
                const hint = msg.includes('role') || msg.includes('column')
                    ? 'Role column missing — run supabase-admin.sql in Supabase SQL Editor'
                    : msg;
                return { verified: false, error: hint };
            }

            const role = data?.role || 'user';
            // Update local state to match server
            if (this._user) this._user.role = role;
            this._persistToStorage();

            const isAdmin = role === 'admin' || role === 'superadmin';
            return { verified: isAdmin, role };
        } catch (err) {
            return { verified: false, error: err.message };
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
