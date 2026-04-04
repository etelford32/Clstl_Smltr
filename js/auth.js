/**
 * auth.js — Client-side authentication manager
 *
 * Manages user session state across all pages. Uses localStorage for
 * persistent sessions ("Remember me") and sessionStorage for tab-only sessions.
 *
 * ── Session Storage ──────────────────────────────────────────────────────────
 *   Remember me OFF → sessionStorage (cleared on tab close)
 *   Remember me ON  → localStorage (persists across browser restarts)
 *
 *   Key: 'pp_auth'
 *   Value: { email, name, plan, signedIn, ts, remember }
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { auth } from './js/auth.js';
 *
 *   // Check if signed in
 *   if (auth.isSignedIn()) { ... }
 *
 *   // Get user info
 *   const user = auth.getUser();  // { email, name, plan, ... }
 *
 *   // Sign in (after form validation)
 *   auth.signIn({ email, name, plan, remember });
 *
 *   // Sign out
 *   auth.signOut();  // clears session, redirects to index
 *
 *   // Require auth (redirect to signin if not logged in)
 *   auth.requireAuth();  // call at top of protected pages
 *
 * ── Future Backend Integration ──────────────────────────────────────────────
 *   Replace signIn() internals with POST /api/auth/signin → JWT token.
 *   Replace signUp() with POST /api/auth/signup → create user + JWT.
 *   Store JWT in httpOnly cookie (not localStorage) for production security.
 */

const AUTH_KEY = 'pp_auth';

class AuthManager {
    constructor() {
        this._user = null;
        this._load();
    }

    /** Load session from storage. */
    _load() {
        // Try localStorage first (persistent), then sessionStorage (tab-only)
        let raw = null;
        try { raw = localStorage.getItem(AUTH_KEY); } catch (_) {}
        if (!raw) {
            try { raw = sessionStorage.getItem(AUTH_KEY); } catch (_) {}
        }
        if (raw) {
            try {
                const data = JSON.parse(raw);
                if (data && data.signedIn) {
                    this._user = data;
                }
            } catch (_) {}
        }
    }

    /** Check if user is signed in. */
    isSignedIn() {
        return !!(this._user && this._user.signedIn);
    }

    /** Get current user data (or null). */
    getUser() {
        return this._user ? { ...this._user } : null;
    }

    /** Get user's display name. */
    getDisplayName() {
        if (!this._user) return 'Guest';
        return this._user.name || this._user.email?.split('@')[0] || 'Explorer';
    }

    /** Get user's first name. */
    getFirstName() {
        const name = this.getDisplayName();
        return name.split(' ')[0];
    }

    /** Get user's plan. */
    getPlan() {
        return (this._user?.plan || 'free').toLowerCase();
    }

    /**
     * Sign in — store session data.
     * @param {object} opts
     * @param {string} opts.email
     * @param {string} [opts.name]
     * @param {string} [opts.plan='free']
     * @param {boolean} [opts.remember=false]
     */
    signIn({ email, name, plan = 'free', remember = false }) {
        const data = {
            email,
            name: name || email.split('@')[0],
            plan,
            signedIn: true,
            remember,
            ts: Date.now(),
        };

        this._user = data;
        const json = JSON.stringify(data);

        try {
            if (remember) {
                localStorage.setItem(AUTH_KEY, json);
                sessionStorage.removeItem(AUTH_KEY);
            } else {
                sessionStorage.setItem(AUTH_KEY, json);
                localStorage.removeItem(AUTH_KEY);
            }
        } catch (_) {}

        window.dispatchEvent(new CustomEvent('auth-changed', { detail: data }));
    }

    /**
     * Sign up — same as signIn but for new accounts.
     * In a real system this would POST to /api/auth/signup first.
     */
    signUp({ email, name, plan = 'free', remember = false }) {
        // TODO: POST /api/auth/signup → create account → return JWT
        this.signIn({ email, name, plan, remember });
    }

    /** Sign out — clear all session data and redirect. */
    signOut(redirectUrl = 'index.html') {
        this._user = null;
        try { localStorage.removeItem(AUTH_KEY); } catch (_) {}
        try { sessionStorage.removeItem(AUTH_KEY); } catch (_) {}
        window.dispatchEvent(new CustomEvent('auth-changed', { detail: null }));
        if (redirectUrl) {
            window.location.href = redirectUrl;
        }
    }

    /**
     * Require authentication — redirect to signin if not logged in.
     * Call this at the top of any protected page.
     * @param {string} [redirectUrl='signin.html'] Where to redirect if not authed
     */
    requireAuth(redirectUrl = 'signin.html') {
        if (!this.isSignedIn()) {
            // Store the intended destination so we can redirect back after login
            try {
                sessionStorage.setItem('pp_auth_redirect', window.location.href);
            } catch (_) {}
            window.location.href = redirectUrl;
            return false;
        }
        return true;
    }

    /**
     * Get the redirect URL stored before auth redirect (if any).
     * Called after successful sign-in to redirect back to the original page.
     */
    getPostLoginRedirect() {
        try {
            const url = sessionStorage.getItem('pp_auth_redirect');
            sessionStorage.removeItem('pp_auth_redirect');
            return url;
        } catch (_) {
            return null;
        }
    }

    /**
     * Request password reset (simulated).
     * In a real system this would POST to /api/auth/reset-password.
     * @param {string} email
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async requestPasswordReset(email) {
        // TODO: POST /api/auth/reset-password → send email with reset link
        // For now, simulate the flow
        await new Promise(r => setTimeout(r, 800));

        // Always return success to prevent email enumeration
        return {
            success: true,
            message: `If an account exists for ${email}, we've sent a password reset link. Check your inbox.`,
        };
    }

    /**
     * Update user profile data.
     * @param {object} updates  Fields to update (name, plan, etc.)
     */
    updateProfile(updates) {
        if (!this._user) return;
        Object.assign(this._user, updates, { ts: Date.now() });

        const json = JSON.stringify(this._user);
        try {
            if (this._user.remember) {
                localStorage.setItem(AUTH_KEY, json);
            } else {
                sessionStorage.setItem(AUTH_KEY, json);
            }
        } catch (_) {}

        window.dispatchEvent(new CustomEvent('auth-changed', { detail: this._user }));
    }
}

/** Singleton auth manager instance. */
export const auth = new AuthManager();
