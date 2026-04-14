/**
 * user-state.js — Lightweight local-first user tracking & state management
 *
 * Works entirely from localStorage. No Supabase dependency.
 * Tracks: visits, session count, time on site, last active, preferences,
 * feature usage, and builds a user profile over time.
 *
 * Usage:
 *   import { userState } from './js/user-state.js';
 *
 *   userState.trackPage('earth');
 *   userState.getStats();          // { totalVisits, uniquePages, sessions, ... }
 *   userState.isReturning();       // true if they've been here before
 *   userState.getLastPages(5);     // last 5 pages visited
 */

const STORAGE_KEY = 'pp_user_state';
const SESSION_KEY = 'pp_session';
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 min inactivity = new session

class UserState {
    constructor() {
        this._state = this._load();
        this._session = this._loadSession();
        this._startHeartbeat();
    }

    // ── Persistence ─────────────────────────────────────────────────────────

    _load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) return JSON.parse(raw);
        } catch (_) {}
        return this._defaults();
    }

    _defaults() {
        return {
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            totalPageViews: 0,
            totalSessions: 0,
            totalTimeMs: 0,
            pages: {},           // { pageName: { views: N, lastVisit: ts, totalTimeMs: N } }
            events: [],          // last 50 events: [{ type, name, ts }]
            preferences: {},     // user-set preferences
            userId: null,
            displayName: null,
            // NOTE: email, role, plan are intentionally NOT stored in localStorage.
            // They are fetched from the server (auth.fetchProfile) on each session.
        };
    }

    _save() {
        try {
            this._state.lastSeen = Date.now();
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this._state));
        } catch (_) {}
    }

    _loadSession() {
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            if (raw) {
                const s = JSON.parse(raw);
                // If session is still fresh, resume it
                if (Date.now() - s.lastActivity < SESSION_TIMEOUT) {
                    return s;
                }
            }
        } catch (_) {}
        return this._newSession();
    }

    _newSession() {
        this._state.totalSessions++;
        const s = {
            id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            startedAt: Date.now(),
            lastActivity: Date.now(),
            pageViews: 0,
            pages: [],
            events: [],
        };
        this._saveSession(s);
        this._save();
        return s;
    }

    _saveSession(s) {
        try {
            if (s) s.lastActivity = Date.now();
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(s || this._session));
        } catch (_) {}
    }

    // ── Heartbeat (tracks time on site) ────────────────────────────────────

    _startHeartbeat() {
        this._heartbeatInterval = setInterval(() => {
            this._state.totalTimeMs += 10_000;
            const currentPage = this._session?.pages?.at(-1);
            if (currentPage && this._state.pages[currentPage]) {
                this._state.pages[currentPage].totalTimeMs = (this._state.pages[currentPage].totalTimeMs || 0) + 10_000;
            }
            this._save();
            this._saveSession();
        }, 10_000);

        // Save on page hide
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    this._save();
                    this._saveSession();
                }
            });
        }
    }

    // ── Page Tracking ──────────────────────────────────────────────────────

    trackPage(pageName) {
        if (!pageName) return;

        // Update page stats
        if (!this._state.pages[pageName]) {
            this._state.pages[pageName] = { views: 0, firstVisit: Date.now(), lastVisit: Date.now(), totalTimeMs: 0 };
        }
        this._state.pages[pageName].views++;
        this._state.pages[pageName].lastVisit = Date.now();
        this._state.totalPageViews++;

        // Session tracking
        this._session.pageViews++;
        this._session.pages.push(pageName);

        // Event log (keep last 100)
        this._addEvent('page_view', pageName);

        this._save();
        this._saveSession();
    }

    // ── Event Tracking ─────────────────────────────────────────────────────

    trackEvent(name, data = {}) {
        this._addEvent('event', name, data);
        this._save();
    }

    _addEvent(type, name, data = {}) {
        const entry = { type, name, ts: Date.now() };
        if (Object.keys(data).length) entry.data = data;

        this._state.events.push(entry);
        if (this._state.events.length > 100) {
            this._state.events = this._state.events.slice(-100);
        }

        this._session.events.push(entry);
    }

    // ── User Identity ──────────────────────────────────────────────────────

    /**
     * Identify user — stores ONLY non-sensitive display data in localStorage.
     * Email, role, and plan are NOT persisted to localStorage (PII/privilege data).
     * Those are fetched fresh from the server via auth.fetchProfile() on each session.
     */
    identify(user) {
        if (!user) return;
        this._state.userId = user.id || this._state.userId;
        this._state.displayName = user.name || user.displayName || this._state.displayName;
        // Do NOT store email, role, or plan in localStorage — these are sensitive.
        // They should be read from the Supabase session (auth.js) on each page load.
        this._addEvent('identify', user.id || 'anon');
        this._save();
    }

    clearIdentity() {
        this._state.userId = null;
        this._state.displayName = null;
        // Also clear any legacy fields that may have been stored previously
        delete this._state.email;
        delete this._state.role;
        delete this._state.plan;
        this._save();
    }

    // ── Preferences ────────────────────────────────────────────────────────

    setPref(key, value) {
        this._state.preferences[key] = value;
        this._save();
    }

    getPref(key, fallback = null) {
        return this._state.preferences[key] ?? fallback;
    }

    // ── Queries ────────────────────────────────────────────────────────────

    /** Is this a returning visitor (more than 1 session)? */
    isReturning() {
        return this._state.totalSessions > 1;
    }

    /** Is this their first visit ever? */
    isFirstVisit() {
        return this._state.totalPageViews <= 1 && this._state.totalSessions <= 1;
    }

    /** How many days since first visit? */
    daysSinceFirstVisit() {
        return Math.floor((Date.now() - this._state.firstSeen) / 86_400_000);
    }

    /** How many days since last visit? */
    daysSinceLastVisit() {
        return Math.floor((Date.now() - this._state.lastSeen) / 86_400_000);
    }

    /** Total time on site in minutes. */
    totalMinutes() {
        return Math.round(this._state.totalTimeMs / 60_000);
    }

    /** Has the user visited a specific page? */
    hasVisited(pageName) {
        return !!this._state.pages[pageName];
    }

    /** Get pages the user has never visited (from a list). */
    unvisitedPages(pageList) {
        return pageList.filter(p => !this._state.pages[p]);
    }

    /** Get the N most recently visited pages. */
    getLastPages(n = 5) {
        return Object.entries(this._state.pages)
            .sort((a, b) => b[1].lastVisit - a[1].lastVisit)
            .slice(0, n)
            .map(([name, data]) => ({ name, ...data }));
    }

    /** Get the N most visited pages. */
    getTopPages(n = 5) {
        return Object.entries(this._state.pages)
            .sort((a, b) => b[1].views - a[1].views)
            .slice(0, n)
            .map(([name, data]) => ({ name, ...data }));
    }

    /** Full stats summary. */
    getStats() {
        return {
            firstSeen: this._state.firstSeen,
            lastSeen: this._state.lastSeen,
            totalPageViews: this._state.totalPageViews,
            totalSessions: this._state.totalSessions,
            totalMinutes: this.totalMinutes(),
            uniquePages: Object.keys(this._state.pages).length,
            isReturning: this.isReturning(),
            daysSinceFirst: this.daysSinceFirstVisit(),
            currentSession: {
                id: this._session.id,
                pageViews: this._session.pageViews,
                pages: this._session.pages,
                durationMs: Date.now() - this._session.startedAt,
            },
            user: {
                id: this._state.userId,
                email: this._state.email,
                name: this._state.displayName,
                plan: this._state.plan,
                role: this._state.role,
            },
        };
    }

    /** Get raw state (for admin/debug). */
    getRaw() {
        return { ...this._state };
    }

    /** Get current session info. */
    getSession() {
        return { ...this._session };
    }

    /** Reset all tracking data. */
    reset() {
        this._state = this._defaults();
        this._session = this._newSession();
        this._save();
    }
}

export const userState = new UserState();
