/**
 * toast.js — Lightweight inline notifications for the Operations console.
 *
 * One stack pinned bottom-center. Each toast is a self-dismissing pill
 * that survives a few seconds. Callers don't pass a target element —
 * the module owns its container and lazily mounts on first use, so any
 * place in the codebase can `showToast(msg)` without wiring up a host
 * div.
 *
 * Kinds:
 *   - 'info'  (default) — neutral cyan border;
 *   - 'ok'              — green; success confirmations;
 *   - 'warn'            — amber; user-facing limits hit;
 *   - 'error'           — red; the screen / network failed.
 *
 * Use sparingly. A toast is the right tool for "the thing you just
 * tried didn't work" or "the thing you just did succeeded out of
 * sight." It's the wrong tool for status that belongs in a panel
 * status line — chronic toasts train operators to ignore them.
 */

const DEFAULT_DURATION_MS = 3500;
const STACK_ID            = 'op-toast-stack';

function ensureStack() {
    let host = document.getElementById(STACK_ID);
    if (host) return host;
    host = document.createElement('div');
    host.id = STACK_ID;
    host.className = 'op-toast-stack';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    return host;
}

/**
 * Pop a toast. Returns a thunk that dismisses it early.
 *
 * @param {string} msg                — Plain text. Caller is
 *        responsible for HTML-escaping anything dynamic; the toast
 *        renders as textContent.
 * @param {'info'|'ok'|'warn'|'error'} [kind='info']
 * @param {object} [opts]
 * @param {number} [opts.duration]    — ms before auto-dismiss. Defaults
 *        to ~3.5 s; -1 means sticky (caller must dismiss).
 */
export function showToast(msg, kind = 'info', opts = {}) {
    const host = ensureStack();
    const el = document.createElement('div');
    el.className = `op-toast op-toast--${kind}`;
    el.textContent = String(msg ?? '');
    host.appendChild(el);

    // Force the slide-in by reading layout — without this the browser
    // batches the insert + class change and skips the transition.
    void el.offsetHeight;
    el.classList.add('op-toast--in');

    const duration = Number.isFinite(opts.duration) ? opts.duration : DEFAULT_DURATION_MS;

    let dismissed = false;
    function dismiss() {
        if (dismissed) return;
        dismissed = true;
        el.classList.remove('op-toast--in');
        el.classList.add('op-toast--out');
        setTimeout(() => el.remove(), 220);
    }

    if (duration > 0) {
        setTimeout(dismiss, duration);
    }

    el.addEventListener('click', dismiss);
    return dismiss;
}
