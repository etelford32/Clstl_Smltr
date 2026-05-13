/**
 * js/anonymous-session-timer.js
 *
 * Generic per-feature "free trial" countdown for anonymous users.
 * Persists elapsed time to localStorage so refreshing the page doesn't
 * reset the clock — that's the explicit anti-pattern this guards against.
 *
 * Semantics: SOFT EXPIRE. When the timer hits maxSeconds we fire
 * `onSoftExpire`; we don't tear anything down. It's the caller's job to
 * gate new actions while leaving the last result on screen — that's
 * the conversion-optimised UX the product brief asked for ("results
 * still visible, but new queries blocked").
 *
 * Signed-in users bypass entirely. Pass `isSignedIn: () => bool` and
 * the timer self-disables when the user authenticates mid-session.
 *
 * Usage
 * ─────
 *   import { AnonymousSessionTimer } from './js/anonymous-session-timer.js';
 *
 *   const timer = new AnonymousSessionTimer({
 *       feature:       'probability-picker',
 *       maxSeconds:    300,
 *       isSignedIn:    () => !!window.auth?.isSignedIn(),
 *       onTick:        (state) => updateCountdownChip(state),
 *       onSoftExpire:  () => freezeNewQueries(),
 *   });
 *   timer.start();
 *   // ... when the user signs in, just call timer.refresh()
 *   timer.stop();   // on page unload (optional — leak is bounded)
 *
 * State shape
 * ───────────
 *   { elapsedSec, remainingSec, percent, expired, bypassed }
 *
 * Persistence
 * ───────────
 *   localStorage key: `pp_anon_timer__${feature}`
 *   payload:          { startedAt, accumulatedSec, expired }
 *
 * Why `startedAt + accumulatedSec` instead of one number:
 *   The user might leave the page open in a background tab. We DON'T
 *   want stale time to keep ticking when the document is hidden — only
 *   active-tab seconds count. So `accumulatedSec` is the locked-in
 *   total at the last tick; the live `now − startedAt` only contributes
 *   when the document is visible.
 */

const TICK_MS         = 1000;
const STORAGE_PREFIX  = 'pp_anon_timer__';
const VISIBILITY_API  = typeof document !== 'undefined' && 'hidden' in document;

function _read(feature) {
    try {
        const raw = localStorage.getItem(STORAGE_PREFIX + feature);
        if (!raw) return null;
        const j = JSON.parse(raw);
        if (typeof j !== 'object' || j == null) return null;
        return {
            startedAt:      Number(j.startedAt)      || 0,
            accumulatedSec: Number(j.accumulatedSec) || 0,
            expired:        !!j.expired,
        };
    } catch { return null; }
}

function _write(feature, state) {
    try {
        localStorage.setItem(STORAGE_PREFIX + feature, JSON.stringify({
            startedAt:      state.startedAt,
            accumulatedSec: state.accumulatedSec,
            expired:        state.expired,
        }));
    } catch { /* private mode / quota — silently ignore */ }
}

function _clear(feature) {
    try { localStorage.removeItem(STORAGE_PREFIX + feature); } catch {}
}

export class AnonymousSessionTimer {
    constructor(opts) {
        const {
            feature,
            maxSeconds   = 300,
            isSignedIn   = () => false,
            onTick       = () => {},
            onSoftExpire = () => {},
            tickIntervalMs = TICK_MS,
        } = opts || {};
        if (!feature) throw new Error('AnonymousSessionTimer: feature is required');

        this.feature      = feature;
        this.maxSeconds   = maxSeconds;
        this.isSignedIn   = isSignedIn;
        this.onTick       = onTick;
        this.onSoftExpire = onSoftExpire;
        this.tickIntervalMs = tickIntervalMs;

        this._timerId   = null;
        this._lastVisibilityTs = null;
        this._stopped   = true;

        // Hydrate prior state (or initialise fresh).
        const prior = _read(feature);
        this._accumulatedSec = prior?.accumulatedSec ?? 0;
        this._expired        = !!prior?.expired
                               || this._accumulatedSec >= maxSeconds;

        this._onVisibilityChange = this._onVisibilityChange.bind(this);
    }

    /** Read-only snapshot of current state for renderers. */
    snapshot() {
        if (this._signedInBypass()) {
            return {
                elapsedSec:   0,
                remainingSec: this.maxSeconds,
                percent:      0,
                expired:      false,
                bypassed:     true,
            };
        }
        const elapsed = Math.min(this.maxSeconds, this._accumulatedSec);
        return {
            elapsedSec:   elapsed,
            remainingSec: Math.max(0, this.maxSeconds - elapsed),
            percent:      this.maxSeconds > 0
                          ? Math.min(1, elapsed / this.maxSeconds)
                          : 1,
            expired:      this._expired,
            bypassed:     false,
        };
    }

    /** Kick off ticking. Idempotent — repeated calls are no-ops. */
    start() {
        if (!this._stopped) return;
        this._stopped = false;

        if (this._signedInBypass()) {
            this.onTick(this.snapshot());
            return;
        }

        // Fire any "already expired" callback synchronously so the UI
        // boots into the frozen state without flashing the live one.
        if (this._expired) {
            this.onTick(this.snapshot());
            this.onSoftExpire(this.snapshot());
            return;
        }

        this._lastVisibilityTs = Date.now();
        if (VISIBILITY_API) {
            document.addEventListener('visibilitychange', this._onVisibilityChange);
        }

        this._tick();    // emit immediately so the UI hydrates
        this._timerId = setInterval(() => this._tick(), this.tickIntervalMs);
    }

    /** Cancel the interval; preserve state in localStorage. */
    stop() {
        if (this._stopped) return;
        this._stopped = true;
        if (this._timerId) {
            clearInterval(this._timerId);
            this._timerId = null;
        }
        if (VISIBILITY_API) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
        }
    }

    /**
     * Re-check sign-in status. Call after a sign-in event fires so the
     * timer can self-disable mid-session. If the user is now signed in
     * we also CLEAR the localStorage slot so a future logout starts
     * from zero rather than wherever the trial got to.
     */
    refresh() {
        if (this._signedInBypass()) {
            _clear(this.feature);
            this.stop();
            this.onTick(this.snapshot());
        }
    }

    /** Manually reset — testing + admin override. */
    reset() {
        _clear(this.feature);
        this._accumulatedSec = 0;
        this._expired = false;
        this._lastVisibilityTs = Date.now();
        this.onTick(this.snapshot());
    }

    // ── Internals ──────────────────────────────────────────────────

    _signedInBypass() {
        try { return !!this.isSignedIn(); } catch { return false; }
    }

    _onVisibilityChange() {
        if (document.hidden) {
            // Lock in whatever active-tab time we accrued before going
            // background, then stop counting until visible again.
            this._commitElapsed();
        } else {
            this._lastVisibilityTs = Date.now();
        }
    }

    _commitElapsed() {
        if (this._lastVisibilityTs == null) return;
        const deltaSec = (Date.now() - this._lastVisibilityTs) / 1000;
        if (deltaSec > 0) {
            this._accumulatedSec += deltaSec;
        }
        this._lastVisibilityTs = null;
        _write(this.feature, {
            startedAt:      Date.now(),
            accumulatedSec: this._accumulatedSec,
            expired:        this._expired,
        });
    }

    _tick() {
        // Mid-session sign-in: take effect on the next tick.
        if (this._signedInBypass()) {
            _clear(this.feature);
            this.stop();
            this.onTick(this.snapshot());
            return;
        }

        if (VISIBILITY_API && document.hidden) return;

        const now = Date.now();
        if (this._lastVisibilityTs == null) this._lastVisibilityTs = now;
        const deltaSec = (now - this._lastVisibilityTs) / 1000;
        this._lastVisibilityTs = now;
        this._accumulatedSec  += deltaSec;

        const snap = this.snapshot();
        this.onTick(snap);

        if (snap.expired) return;  // already fired earlier this session

        if (this._accumulatedSec >= this.maxSeconds && !this._expired) {
            this._expired = true;
            _write(this.feature, {
                startedAt:      now,
                accumulatedSec: this._accumulatedSec,
                expired:        true,
            });
            this.onTick(this.snapshot());
            this.onSoftExpire(this.snapshot());
            // Keep the interval running so onTick continues to deliver
            // the frozen state — it costs nothing and avoids races with
            // the UI's "is the timer alive?" checks.
            return;
        }

        // Persist progress so a refresh mid-session doesn't reset.
        _write(this.feature, {
            startedAt:      now,
            accumulatedSec: this._accumulatedSec,
            expired:        false,
        });
    }
}

/** Convenience: format a seconds count as "M:SS". */
export function formatTimerMMSS(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
}
