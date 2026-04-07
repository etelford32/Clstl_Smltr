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
import { userState } from './user-state.js';

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
                    this._persist();
                    userState.identify(this._user);
                    console.info('[Auth] Supabase session restored:', this._user.email);
                } else {
                    // No Supabase session — check for provisional local session
                    // (created during signup when email confirmation is pending)
                    this._loadMock();
                    if (this._user?.provider === 'supabase-provisional') {
                        console.info('[Auth] Provisional session found:', this._user.email, '(email confirmation pending)');
                    } else if (this._user?.provider === 'mock') {
                        console.info('[Auth] Mock session found:', this._user.email);
                    }
                }

                // Listen for auth state changes (login, logout, token refresh)
                this._supabase.auth.onAuthStateChange((event, session) => {
                    if (session?.user) {
                        this._user = this._mapSupabaseUser(session.user);
                    } else {
                        this._user = null;
                    }
                    this._persist();
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

    /** Persist user to localStorage so nav.js can read it synchronously on any page. */
    _persist() {
        try {
            if (this._user) {
                localStorage.setItem(AUTH_KEY, JSON.stringify(this._user));
            } else {
                localStorage.removeItem(AUTH_KEY);
            }
        } catch (_) {}
    }

    /** Check if current user has admin role. */
    isAdmin() {
        return this._user?.role === 'admin' || this._user?.role === 'superadmin';
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
                .select('role, plan, display_name, location_lat, location_lon, location_city')
                .eq('id', this._user.id)
                .single();
            if (error) { console.warn('[Auth] Profile fetch failed:', error.message); return null; }
            if (data) {
                // Merge server-side role/plan into local state
                this._user.role = data.role || 'user';
                this._user.plan = data.plan || this._user.plan;
                if (data.display_name) this._user.name = data.display_name;
                this._user.location = data.location_lat ? {
                    lat: data.location_lat, lon: data.location_lon, city: data.location_city
                } : null;
                this._persist();
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

    getPlan() {
        return (this._user?.plan || 'free').toLowerCase();
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
                // Fetch server-side profile (role, plan — not just user_metadata)
                await this.fetchProfile();
                this._persist();
                userState.identify(this._user);
                userState.trackEvent('sign_in', { method: 'password' });
                return { success: true };
            } catch (err) {
                return { success: false, error: err.message };
            }
        }

        // Mock mode: ONLY available in development (localhost/127.0.0.1)
        // In production, Supabase must be configured — refuse auth without it.
        const isDev = ['localhost', '127.0.0.1'].includes(window.location.hostname);
        if (!isDev) {
            console.error('[auth] Supabase not configured — cannot authenticate in production');
            return { success: false, error: 'Authentication service unavailable. Please try again later.' };
        }
        console.warn('[auth] Using mock auth — development mode only');
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
                const { data, error } = await this._supabase.auth.signUp({
                    email,
                    password,
                    options: {
                        data: { name, plan },  // stored in user_metadata
                    },
                });
                if (error) return { success: false, error: error.message };

                // Supabase may require email confirmation (data.user exists but no session).
                // Auto-sign-in: try password auth immediately so user isn't blocked.
                if (data.user && !data.session) {
                    const signInResult = await this.signIn({ email, password, remember: true });
                    if (signInResult.success) {
                        return { success: true };
                    }
                    // If auto-sign-in fails (e.g., email confirmation enforced at DB level),
                    // create a provisional local session so the user can explore the app.
                    // They'll need to confirm email for full Supabase features (API, profile sync).
                    this._user = {
                        id: data.user.id,
                        email,
                        name: name || email.split('@')[0],
                        plan,
                        role: 'user',
                        signedIn: true,
                        provider: 'supabase-provisional',
                        needsEmailConfirmation: true,
                        ts: Date.now(),
                    };
                    const json = JSON.stringify(this._user);
                    try { localStorage.setItem(AUTH_KEY, json); } catch (_) {}
                    return {
                        success: true,
                        needsConfirmation: true,
                        message: 'Account created! Please check your email to confirm, but you can start exploring now.',
                    };
                }

                if (data.user) {
                    this._user = this._mapSupabaseUser(data.user);
                    userState.identify(this._user);
                    userState.trackEvent('sign_up', { plan });
                }
                return { success: true };
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
        userState.trackEvent('sign_out');
        userState.clearIdentity();
        try { localStorage.removeItem(AUTH_KEY); } catch (_) {}
        try { sessionStorage.removeItem(AUTH_KEY); } catch (_) {}

        window.dispatchEvent(new CustomEvent('auth-changed', { detail: { event: 'SIGNED_OUT', user: null } }));

        if (redirectUrl) window.location.href = redirectUrl;
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

    /** Get stored post-login redirect URL (validated same-origin to prevent open redirect). */
    getPostLoginRedirect() {
        try {
            const url = sessionStorage.getItem('pp_auth_redirect');
            sessionStorage.removeItem('pp_auth_redirect');
            if (!url) return null;
            // Validate same-origin to prevent open redirect attacks
            try {
                const parsed = new URL(url, window.location.origin);
                if (parsed.origin !== window.location.origin) return null;
            } catch (_) { return null; }
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
                // Update user_profiles table (location, prefs)
                await this._supabase.from('user_profiles').upsert({
                    id: this._user.id,
                    display_name: this._user.name,
                    plan: this._user.plan,
                    location_lat: updates.location_lat,
                    location_lon: updates.location_lon,
                    location_city: updates.location_city,
                    notify_aurora: updates.notify_aurora,
                    notify_conjunction: updates.notify_conjunction,
                    aurora_kp_threshold: updates.aurora_kp_threshold,
                    conjunction_threshold_km: updates.conjunction_threshold_km,
                    updated_at: new Date().toISOString(),
                });
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
