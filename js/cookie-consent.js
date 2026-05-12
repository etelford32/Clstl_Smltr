/**
 * cookie-consent.js — opt-in consent banner for Parkers Physics App
 *
 * Default posture (GDPR/UK GDPR safe): non-essential categories OFF until the
 * user accepts. Honors Global Privacy Control (GPC) as a refusal signal for
 * functional + analytics. Banner is self-mounting on DOMContentLoaded.
 *
 * Public API on window:
 *   window.ppConsent.get()      → { strict, functional, analytics, ts, version }
 *   window.ppConsent.has(cat)   → boolean
 *   window.ppConsent.open()     → opens the settings modal
 *   window.ppConsent.set(part)  → merge-update consent state
 *   window.ppConsent.clear()    → forget consent (re-shows banner)
 *
 * Custom events dispatched on window:
 *   'pp-consent-changed' { detail: <state> } — fired whenever consent updates
 *
 * Custom events listened for on window:
 *   'open-cookie-settings' — opens the modal (used by footer link)
 */

const STORAGE_KEY = 'pp_consent_v1';
const BANNER_VERSION = 1;

const DEFAULT_STATE = Object.freeze({
    strict: true,        // always on, immutable
    functional: false,
    analytics: false,
    ts: null,
    version: BANNER_VERSION,
});

// ── Storage ──────────────────────────────────────────────────────────────────

function _read() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== BANNER_VERSION) return null;
        return parsed;
    } catch (e) {
        return null;
    }
}

function _write(state) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
        // Storage may be disabled (private mode, quota, etc.); fail silently.
    }
}

function _gpcRefuses() {
    // navigator.globalPrivacyControl === true means the user signals refusal
    // of selling/sharing and tracking. We honor it for functional+analytics.
    return navigator.globalPrivacyControl === true;
}

// ── State management ─────────────────────────────────────────────────────────

function getState() {
    const stored = _read();
    if (stored) return { ...DEFAULT_STATE, ...stored, strict: true };
    // No stored consent — return defaults but reflect GPC as a refusal so
    // calling code does not opportunistically enable analytics before banner
    // interaction.
    return { ...DEFAULT_STATE };
}

function setState(partial) {
    const next = {
        ...getState(),
        ...partial,
        strict: true,                      // never overridable
        ts: new Date().toISOString(),
        version: BANNER_VERSION,
    };
    _write(next);
    window.dispatchEvent(new CustomEvent('pp-consent-changed', { detail: next }));
    return next;
}

function clearState() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    window.dispatchEvent(new CustomEvent('pp-consent-changed', { detail: { ...DEFAULT_STATE } }));
}

function hasConsent(category) {
    const s = getState();
    if (category === 'strict') return true;
    return !!s[category];
}

function hasDecided() {
    return _read() !== null;
}

// ── DOM ──────────────────────────────────────────────────────────────────────

let bannerEl = null;
let modalEl = null;

function _injectStyles() {
    if (document.getElementById('pp-consent-styles')) return;
    const style = document.createElement('style');
    style.id = 'pp-consent-styles';
    style.textContent = `
        .pp-consent-banner {
            position: fixed; left: 0; right: 0; bottom: 0;
            z-index: 9000;
            background: rgba(8, 4, 22, .96);
            backdrop-filter: blur(14px);
            border-top: 1px solid rgba(255, 200, 0, .25);
            color: #d8d8e8;
            padding: 1rem 1.25rem;
            box-shadow: 0 -8px 32px rgba(0, 0, 0, .55);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            font-size: .88rem; line-height: 1.55;
            display: flex; flex-direction: row; align-items: center;
            gap: 1rem; flex-wrap: wrap;
        }
        .pp-consent-banner .pp-consent-text { flex: 1 1 320px; min-width: 280px; }
        .pp-consent-banner .pp-consent-text strong {
            color: #ffd700;
            display: block; font-size: .95rem; margin-bottom: .25rem;
        }
        .pp-consent-banner .pp-consent-text a { color: #a080ff; text-decoration: underline; }
        .pp-consent-banner .pp-consent-actions {
            display: flex; gap: .5rem; flex-wrap: wrap; align-items: center;
        }
        /* Reject and Accept share the same visual weight per CNIL/ICO guidance:
           the data-minimizing choice must be at least as prominent as the
           data-maximizing choice. */
        .pp-consent-btn {
            font: inherit; cursor: pointer; padding: .55rem 1rem;
            border-radius: 6px; border: 1px solid rgba(255,200,0,.35);
            background: rgba(255,200,0,.06); color: #e8e8f4;
            font-weight: 600;
            transition: background .15s, border-color .15s;
            min-width: 150px; text-align: center;
        }
        .pp-consent-btn:hover {
            background: rgba(255,200,0,.14);
            border-color: rgba(255,200,0,.55);
        }
        .pp-consent-btn:focus-visible {
            outline: 2px solid #ffd700; outline-offset: 2px;
        }
        .pp-consent-btn.pp-consent-ghost {
            background: transparent; color: #c0c0d0; font-weight: 400;
            border-color: rgba(255,255,255,.18);
            min-width: 0;
        }
        .pp-consent-btn.pp-consent-ghost:hover {
            color: #fff; border-color: rgba(255,200,0,.4);
            background: rgba(255,255,255,.06);
        }
        @media (max-width: 640px) {
            .pp-consent-banner { flex-direction: column; align-items: stretch; }
            .pp-consent-banner .pp-consent-actions { justify-content: stretch; }
            .pp-consent-btn { flex: 1 1 auto; text-align: center; }
        }

        .pp-consent-modal-backdrop {
            position: fixed; inset: 0; z-index: 9100;
            background: rgba(2, 1, 8, .72);
            display: flex; align-items: center; justify-content: center;
            padding: 1rem;
        }
        .pp-consent-modal {
            background: linear-gradient(135deg, #14102a 0%, #1f1638 100%);
            border: 1px solid rgba(255,200,0,.22);
            border-radius: 10px;
            box-shadow: 0 20px 60px rgba(0,0,0,.7);
            color: #d8d8e8;
            width: 100%; max-width: 540px;
            max-height: 90vh; overflow-y: auto;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            font-size: .9rem; line-height: 1.55;
        }
        .pp-consent-modal h2 {
            margin: 0; padding: 1.1rem 1.4rem;
            font-size: 1.1rem;
            background: linear-gradient(45deg, #ffd700, #ff8c00);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
            border-bottom: 1px solid rgba(255,200,0,.18);
        }
        .pp-consent-modal-body { padding: 1rem 1.4rem; }
        .pp-consent-modal-body p { margin-bottom: .75rem; color: #b0b0c8; }
        .pp-consent-modal-body a { color: #a080ff; }
        .pp-consent-cat {
            border: 1px solid rgba(255,255,255,.1);
            border-radius: 8px;
            padding: .85rem 1rem;
            margin: .65rem 0;
            background: rgba(255,255,255,.03);
        }
        .pp-consent-cat-head {
            display: flex; align-items: center; justify-content: space-between;
            gap: .75rem; margin-bottom: .35rem;
        }
        .pp-consent-cat-name { font-weight: 600; color: #e8e0c0; font-size: .95rem; }
        .pp-consent-cat-desc { color: #99a; font-size: .82rem; line-height: 1.5; }
        .pp-consent-switch {
            position: relative; width: 38px; height: 22px;
            background: rgba(255,255,255,.12);
            border-radius: 999px; cursor: pointer;
            transition: background .15s;
            flex-shrink: 0;
        }
        .pp-consent-switch::after {
            content: ''; position: absolute; top: 2px; left: 2px;
            width: 18px; height: 18px;
            background: #ddd; border-radius: 50%;
            transition: left .15s, background .15s;
        }
        .pp-consent-switch.on { background: linear-gradient(45deg, #ffd700, #ff8c00); }
        .pp-consent-switch.on::after { left: 18px; background: #fff; }
        .pp-consent-switch.disabled { opacity: .55; cursor: not-allowed; }
        .pp-consent-modal-foot {
            padding: 1rem 1.4rem;
            display: flex; gap: .55rem; justify-content: flex-end; flex-wrap: wrap;
            border-top: 1px solid rgba(255,255,255,.08);
            background: rgba(0,0,0,.25);
        }
        @media (max-width: 480px) {
            .pp-consent-modal-foot { flex-direction: column-reverse; }
            .pp-consent-modal-foot .pp-consent-btn { width: 100%; text-align: center; }
        }
    `;
    document.head.appendChild(style);
}

function _renderBanner() {
    if (bannerEl) return;
    bannerEl = document.createElement('div');
    bannerEl.className = 'pp-consent-banner';
    bannerEl.setAttribute('role', 'dialog');
    bannerEl.setAttribute('aria-live', 'polite');
    bannerEl.setAttribute('aria-label', 'Cookie consent');
    bannerEl.innerHTML = `
        <div class="pp-consent-text">
            <strong>Your privacy choices</strong>
            We use strictly necessary cookies to run Parkers Physics App. With your consent, we also use
            functional storage for your preferences and privacy-respecting analytics to improve the service.
            We never use advertising or cross-site tracking. See our
            <a href="/privacy.html">Privacy Policy</a> &middot;
            <a href="/eula.html">EULA</a> &middot;
            <a href="/dpa.html">DPA</a>.
        </div>
        <div class="pp-consent-actions">
            <button type="button" class="pp-consent-btn pp-consent-ghost" data-action="customize">Customize</button>
            <button type="button" class="pp-consent-btn" data-action="reject">Reject non-essential</button>
            <button type="button" class="pp-consent-btn" data-action="accept">Accept all</button>
        </div>
    `;
    bannerEl.addEventListener('click', e => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'accept')      _accept(true);
        else if (action === 'reject') _accept(false);
        else if (action === 'customize') _openModal();
    });
    document.body.appendChild(bannerEl);
}

function _hideBanner() {
    if (!bannerEl) return;
    bannerEl.remove();
    bannerEl = null;
}

function _accept(allCategories) {
    setState({
        functional: !!allCategories,
        analytics:  !!allCategories,
    });
    _hideBanner();
    _closeModal();
}

function _openModal() {
    if (modalEl) return;
    const state = getState();
    const gpc = _gpcRefuses();

    modalEl = document.createElement('div');
    modalEl.className = 'pp-consent-modal-backdrop';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-label', 'Cookie settings');
    modalEl.innerHTML = `
        <div class="pp-consent-modal" role="document">
            <h2>Cookie &amp; Storage Settings</h2>
            <div class="pp-consent-modal-body">
                <p>
                    Choose which non-essential categories you allow. Strictly necessary cookies and
                    storage are required to operate the service and cannot be disabled.
                </p>
                ${gpc ? `<p style="color:#a080ff">
                    Your browser sends a Global Privacy Control (GPC) signal. We honor it as a refusal
                    of functional and analytics storage by default. You can override it here.
                </p>` : ''}
                <div class="pp-consent-cat">
                    <div class="pp-consent-cat-head">
                        <span class="pp-consent-cat-name">Strictly necessary</span>
                        <span class="pp-consent-switch on disabled" aria-disabled="true" title="Required"></span>
                    </div>
                    <div class="pp-consent-cat-desc">
                        Authentication, session, CSRF, load-balancing, and the cookie that remembers
                        your consent choice. Always on.
                    </div>
                </div>
                <div class="pp-consent-cat" data-cat="functional">
                    <div class="pp-consent-cat-head">
                        <span class="pp-consent-cat-name">Functional</span>
                        <span class="pp-consent-switch ${state.functional ? 'on' : ''}" data-toggle="functional"
                              role="switch" aria-checked="${state.functional ? 'true' : 'false'}"
                              tabindex="0"></span>
                    </div>
                    <div class="pp-consent-cat-desc">
                        Saved UI preferences, simulation parameters, named locations, dashboard layout.
                        Stored in your browser; no remote profile is built.
                    </div>
                </div>
                <div class="pp-consent-cat" data-cat="analytics">
                    <div class="pp-consent-cat-head">
                        <span class="pp-consent-cat-name">Analytics</span>
                        <span class="pp-consent-switch ${state.analytics ? 'on' : ''}" data-toggle="analytics"
                              role="switch" aria-checked="${state.analytics ? 'true' : 'false'}"
                              tabindex="0"></span>
                    </div>
                    <div class="pp-consent-cat-desc">
                        Privacy-respecting, first-party usage statistics (page views, feature usage)
                        used only to improve the service. No cross-site tracking, no ad-tech.
                    </div>
                </div>
            </div>
            <div class="pp-consent-modal-foot">
                <button type="button" class="pp-consent-btn pp-consent-ghost" data-action="reject">Reject non-essential</button>
                <button type="button" class="pp-consent-btn pp-consent-ghost" data-action="save">Save choices</button>
                <button type="button" class="pp-consent-btn" data-action="accept">Accept all</button>
            </div>
        </div>
    `;

    modalEl.addEventListener('click', e => {
        if (e.target === modalEl) { _closeModal(); return; }
        const sw = e.target.closest('[data-toggle]');
        if (sw && !sw.classList.contains('disabled')) {
            sw.classList.toggle('on');
            sw.setAttribute('aria-checked', sw.classList.contains('on') ? 'true' : 'false');
            return;
        }
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'accept') _accept(true);
        else if (action === 'reject') _accept(false);
        else if (action === 'save') {
            const fn = modalEl.querySelector('[data-toggle="functional"]')?.classList.contains('on');
            const an = modalEl.querySelector('[data-toggle="analytics"]')?.classList.contains('on');
            setState({ functional: !!fn, analytics: !!an });
            _hideBanner();
            _closeModal();
        }
    });

    modalEl.addEventListener('keydown', e => {
        if (e.key === 'Escape') _closeModal();
        if (e.key === 'Enter' || e.key === ' ') {
            const sw = e.target.closest('[data-toggle]');
            if (sw && !sw.classList.contains('disabled')) {
                e.preventDefault();
                sw.classList.toggle('on');
                sw.setAttribute('aria-checked', sw.classList.contains('on') ? 'true' : 'false');
            }
        }
    });

    document.body.appendChild(modalEl);
    modalEl.querySelector('[data-action="accept"]')?.focus();
}

function _closeModal() {
    if (!modalEl) return;
    modalEl.remove();
    modalEl = null;
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

function _init() {
    _injectStyles();
    if (!hasDecided()) _renderBanner();

    window.addEventListener('open-cookie-settings', _openModal);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
} else {
    _init();
}

// ── Public API ───────────────────────────────────────────────────────────────

window.ppConsent = Object.freeze({
    get:   getState,
    has:   hasConsent,
    set:   setState,
    open:  _openModal,
    clear: clearState,
});
