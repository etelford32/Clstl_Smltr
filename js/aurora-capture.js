/**
 * aurora-capture.js — anonymous aurora-alert email capture widget.
 *
 * Reusable across the high-traffic burst pages (index / earth / gannon).
 * Wires a [data-aurora-capture] form to /api/subscribe/aurora and emits the
 * aurora_capture_* stages through the existing auth-funnel singleton, so the
 * admin Auth-flow card measures the capture funnel for free.
 *
 * Privacy: no PII leaves the page beyond the email the user typed and UTM
 * tags already in the URL. See AURORA_ALERT_CAPTURE_SPEC.md.
 */

import { funnel } from './auth-funnel.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const STYLE_ID = 'aurora-capture-styles';

// Inject the band stylesheet once. Token fallbacks are baked in because the
// burst pages don't all load js/design-tokens.css (index.html and
// gannon-superstorm.html don't); earth.html does, and on it the var() wins.
// Uses the amber --c-storm* track per DESIGN_TOKENS.md. Mirrors the
// self-injecting stylesheet approach in js/storm-watch-panel.js.
function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
.aurora-capture-band{display:flex;gap:24px;flex-wrap:wrap;align-items:center;
  justify-content:space-between;padding:28px 32px;border-radius:14px;margin:32px auto;max-width:1100px;
  background:radial-gradient(120% 140% at 0% 0%, rgba(var(--c-storm-rgb,255,160,80),.10), transparent 60%);
  border:1px solid rgba(var(--c-storm-rgb,255,160,80),.22)}
.aurora-kicker{color:var(--c-storm,#ffb066);font-size:12px;letter-spacing:.08em;text-transform:uppercase}
.aurora-capture-band h2{color:var(--c-text-primary,#d6dee6);margin:6px 0 4px;font-size:1.4rem}
.aurora-capture-band p{color:var(--c-text-secondary,#b0c8d8);max-width:46ch;margin:0}
.aurora-capture-band form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.aurora-capture-band input[type=email]{background:rgba(0,0,0,.35);
  border:1px solid rgba(var(--c-storm-rgb,255,160,80),.30);color:var(--c-text-primary,#d6dee6);
  padding:11px 14px;border-radius:8px;min-width:220px;font-size:.95rem}
.aurora-capture-band input[type=email]:focus{outline:none;
  border-color:var(--c-storm,#ffb066);box-shadow:0 0 0 3px rgba(var(--c-storm-rgb,255,160,80),.20)}
.aurora-capture-band button{background:var(--c-storm,#ffb066);color:#03010e;font-weight:600;
  border:0;padding:11px 18px;border-radius:8px;cursor:pointer;font-size:.95rem}
.aurora-capture-band button:hover{filter:brightness(1.08)}
.aurora-status{color:var(--c-text-muted,#7a98a8);font-size:13px;flex-basis:100%}`;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
}

function readUtm() {
    const p = new URLSearchParams(location.search), u = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) {
        const v = p.get(k);
        if (v) u[k.replace('utm_', '')] = v.slice(0, 80);
    }
    return Object.keys(u).length ? u : null;
}

export function initAuroraCapture(root = document) {
    const form = root.querySelector('[data-aurora-capture]');
    if (!form) return;

    ensureStyles();
    const source = form.getAttribute('data-source') || 'unknown';
    const input  = form.querySelector('input[type="email"]');
    const status = form.querySelector('[data-aurora-status]');
    if (!input || !status) return;

    // Fire the view stage once the band scrolls into view.
    try {
        new IntersectionObserver((es, obs) => {
            if (es.some(e => e.isIntersecting)) {
                funnel.step('aurora_capture_view', { source });
                obs.disconnect();
            }
        }, { threshold: 0.4 }).observe(form);
    } catch {
        // No IntersectionObserver (very old browser) — count it as viewed now.
        funnel.step('aurora_capture_view', { source });
    }

    input.addEventListener('focus', () => funnel.step('aurora_capture_focus', { source }), { once: true });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = (input.value || '').trim();
        if (!EMAIL_RE.test(email)) { status.textContent = 'Enter a valid email.'; return; }

        funnel.step('aurora_capture_submit', { source });
        status.textContent = 'Sending…';

        try {
            const res = await fetch('/api/subscribe/aurora', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email,
                    source,
                    utm: readUtm(),
                    company: form.querySelector('[name="company"]')?.value || '', // honeypot
                }),
            });
            if (res.status === 202) {
                funnel.step('aurora_capture_succeeded', { source });
                form.innerHTML = `<p data-aurora-status class="aurora-status" style="color:var(--c-storm,#ffb066)">Check your inbox to confirm — then you're set for the next storm. 🌌</p>`;
            } else {
                funnel.step('aurora_capture_failed', { source, code: res.status });
                status.textContent = 'Something went wrong. Try again in a moment.';
            }
        } catch {
            funnel.step('aurora_capture_failed', { source, code: 'network' });
            status.textContent = 'Network error. Try again.';
        }
    });
}
