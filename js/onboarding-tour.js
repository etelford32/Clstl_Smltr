/**
 * onboarding-tour.js — Lightweight modal tour for new users
 *
 * Shows a step-by-step guided tour on the dashboard highlighting key features
 * and showing value. Runs once per user (completion tracked in localStorage).
 * Can be re-triggered from a "Take the tour" link.
 *
 * ── Design philosophy ────────────────────────────────────────────────────────
 *  SHOW value first, then ask for action. Each step highlights a real feature
 *  the user can see on the page, with a spotlight effect that dims everything
 *  else. Steps are skippable. The tour ends with a CTA to explore or upgrade.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *  import { OnboardingTour } from './js/onboarding-tour.js';
 *  const tour = new OnboardingTour();
 *  tour.start();        // show if not completed
 *  tour.forceStart();   // show even if previously completed
 */

const LS_KEY = 'ppx_tour_completed';

// ── Tour step definitions ────────────────────────────────────────────────────
const STEPS = [
    {
        title: 'Welcome to Parker Physics',
        body: 'Your personal astrophysics command center — powered by live NASA and NOAA satellite data, updated every 60 seconds.',
        icon: '&#128640;',
        target: null,  // no spotlight — full-screen welcome
        cta: 'Show me around',
    },
    {
        title: 'Set Your Location',
        body: 'We use your location to personalize aurora forecasts, satellite pass predictions, and weather alerts. You can change it anytime.',
        icon: '&#128205;',
        target: '#location-card',
        cta: 'Next',
    },
    {
        title: 'Live Space Weather',
        body: 'Real-time Kp index, solar wind speed, IMF Bz, and storm conditions — all from NOAA SWPC and NASA DONKI. Updates automatically.',
        icon: '&#127758;',
        target: '#sw-card',
        cta: 'Next',
    },
    {
        title: 'Your Impact Score',
        body: 'A personalized 0-100 score combining geomagnetic activity, solar radiation, CME threats, and your location risk — with 24h, 3-day, and 7-day forecasts.',
        icon: '&#127919;',
        target: '#impact-card',
        cta: 'Next',
    },
    {
        title: 'Custom Alerts',
        body: 'Set alerts for aurora visibility, solar flares, geomagnetic storms, temperature extremes, and more. Subscribers get email delivery and advanced alerts like satellite collision detection.',
        icon: '&#128276;',
        target: '#alert-prefs-card',
        cta: 'Next',
    },
    {
        title: 'Interactive Simulations',
        body: '17+ WebGL simulations — from the Sun\'s photosphere to Earth\'s magnetosphere, black hole accretion disks, and the Milky Way. All driven by real physics.',
        icon: '&#9788;',
        target: '.sim-grid',
        cta: 'Next',
    },
    {
        title: 'You\'re All Set!',
        body: 'Start by setting your location, then explore a simulation. Solar Maximum is happening now — the best aurora season in a decade. Don\'t miss it.',
        icon: '&#127775;',
        target: null,
        cta: 'Start exploring',
        final: true,
    },
];

// ── Styles (injected once) ───────────────────────────────────────────────────
const TOUR_CSS = `
.tour-overlay {
    position: fixed; inset: 0; z-index: 9998;
    background: rgba(0,0,0,.7); backdrop-filter: blur(3px);
    opacity: 0; transition: opacity .3s;
}
.tour-overlay.visible { opacity: 1; }
.tour-spotlight {
    position: fixed; z-index: 9999;
    box-shadow: 0 0 0 9999px rgba(0,0,0,.7);
    border-radius: 12px;
    transition: all .4s ease;
    pointer-events: none;
}
.tour-modal {
    position: fixed; z-index: 10000;
    background: rgba(12,10,28,.96); backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,.10); border-radius: 16px;
    padding: 28px 26px 22px; max-width: 400px; width: 90%;
    box-shadow: 0 20px 60px rgba(0,0,0,.6);
    transform: translateY(10px); opacity: 0;
    transition: transform .35s ease, opacity .3s;
}
.tour-modal.visible { transform: translateY(0); opacity: 1; }
.tour-icon { font-size: 2rem; margin-bottom: 10px; }
.tour-title { font-size: 1.1rem; font-weight: 700; color: #e8f4ff; margin-bottom: 8px; }
.tour-body { font-size: .82rem; color: #99aabb; line-height: 1.6; margin-bottom: 18px; }
.tour-footer { display: flex; justify-content: space-between; align-items: center; }
.tour-dots { display: flex; gap: 5px; }
.tour-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: rgba(255,255,255,.15); transition: background .3s;
}
.tour-dot.active { background: #ffd700; }
.tour-btn {
    padding: 8px 20px; border: none; border-radius: 8px;
    font-size: .82rem; font-weight: 700; cursor: pointer; font-family: inherit;
    background: linear-gradient(45deg, #ff8c00, #ffd700); color: #000;
    transition: filter .2s;
}
.tour-btn:hover { filter: brightness(1.12); }
.tour-skip {
    background: none; border: none; color: #667; font-size: .72rem;
    cursor: pointer; font-family: inherit; padding: 4px 8px;
}
.tour-skip:hover { color: #aab; }
.tour-progress {
    margin-top: 14px; height: 3px; border-radius: 2px;
    background: rgba(255,255,255,.06); overflow: hidden;
}
.tour-progress-bar {
    height: 100%; border-radius: 2px;
    background: linear-gradient(90deg, #ff8c00, #ffd700);
    transition: width .4s;
}
`;

// ─────────────────────────────────────────────────────────────────────────────

export class OnboardingTour {
    constructor() {
        this._step = 0;
        this._overlay = null;
        this._spotlight = null;
        this._modal = null;
        this._active = false;
    }

    /** Start the tour if not previously completed. */
    start() {
        try {
            if (localStorage.getItem(LS_KEY) === '1') return;
        } catch {}
        this.forceStart();
    }

    /** Start the tour regardless of completion state. */
    forceStart() {
        if (this._active) return;
        this._active = true;
        this._step = 0;
        this._injectCSS();
        this._createElements();
        this._show();
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _injectCSS() {
        if (document.getElementById('tour-styles')) return;
        const style = document.createElement('style');
        style.id = 'tour-styles';
        style.textContent = TOUR_CSS;
        document.head.appendChild(style);
    }

    _createElements() {
        // Overlay
        this._overlay = document.createElement('div');
        this._overlay.className = 'tour-overlay';
        document.body.appendChild(this._overlay);

        // Spotlight
        this._spotlight = document.createElement('div');
        this._spotlight.className = 'tour-spotlight';
        this._spotlight.style.display = 'none';
        document.body.appendChild(this._spotlight);

        // Modal
        this._modal = document.createElement('div');
        this._modal.className = 'tour-modal';
        document.body.appendChild(this._modal);

        // Click handlers
        this._overlay.addEventListener('click', () => this._close());

        requestAnimationFrame(() => {
            this._overlay.classList.add('visible');
        });
    }

    _show() {
        const step = STEPS[this._step];
        if (!step) { this._close(); return; }

        const progress = ((this._step + 1) / STEPS.length * 100).toFixed(0);

        // Build modal content
        this._modal.innerHTML = `
            <div class="tour-icon">${step.icon}</div>
            <div class="tour-title">${step.title}</div>
            <div class="tour-body">${step.body}</div>
            <div class="tour-footer">
                <div>
                    <div class="tour-dots">
                        ${STEPS.map((_, i) => `<span class="tour-dot${i === this._step ? ' active' : ''}"></span>`).join('')}
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                    ${!step.final ? '<button class="tour-skip" id="tour-skip">Skip tour</button>' : ''}
                    <button class="tour-btn" id="tour-next">${step.cta}</button>
                </div>
            </div>
            <div class="tour-progress"><div class="tour-progress-bar" style="width:${progress}%"></div></div>
        `;

        // Wire buttons
        this._modal.querySelector('#tour-next')?.addEventListener('click', () => {
            if (step.final) { this._close(); return; }
            this._step++;
            this._show();
        });
        this._modal.querySelector('#tour-skip')?.addEventListener('click', () => this._close());

        // Spotlight target
        if (step.target) {
            const el = document.querySelector(step.target);
            if (el) {
                const rect = el.getBoundingClientRect();
                const pad = 8;
                this._spotlight.style.display = '';
                this._spotlight.style.top    = (rect.top - pad)  + 'px';
                this._spotlight.style.left   = (rect.left - pad) + 'px';
                this._spotlight.style.width  = (rect.width + pad * 2)  + 'px';
                this._spotlight.style.height = (rect.height + pad * 2) + 'px';

                // Scroll target into view
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // Position modal below/above the target
                const modalH = 300;
                const spaceBelow = window.innerHeight - rect.bottom;
                if (spaceBelow > modalH + 20) {
                    this._modal.style.top  = (rect.bottom + 16) + 'px';
                    this._modal.style.bottom = '';
                } else {
                    this._modal.style.top    = '';
                    this._modal.style.bottom = (window.innerHeight - rect.top + 16) + 'px';
                }
                this._modal.style.left = Math.max(16, Math.min(
                    window.innerWidth - 420,
                    rect.left + rect.width / 2 - 200
                )) + 'px';
            } else {
                this._spotlight.style.display = 'none';
                this._centerModal();
            }
        } else {
            this._spotlight.style.display = 'none';
            this._centerModal();
        }

        // Animate in
        this._modal.classList.remove('visible');
        requestAnimationFrame(() => {
            requestAnimationFrame(() => this._modal.classList.add('visible'));
        });
    }

    _centerModal() {
        this._modal.style.top = '50%';
        this._modal.style.left = '50%';
        this._modal.style.bottom = '';
        this._modal.style.transform = 'translate(-50%, -50%)';
        // Re-add visible after a frame so the transition works
        requestAnimationFrame(() => {
            this._modal.style.transform = 'translate(-50%, -50%)';
        });
    }

    _close() {
        this._active = false;
        try { localStorage.setItem(LS_KEY, '1'); } catch {}

        // Fade out
        this._overlay?.classList.remove('visible');
        this._modal?.classList.remove('visible');

        setTimeout(() => {
            this._overlay?.remove();
            this._spotlight?.remove();
            this._modal?.remove();
            this._overlay = null;
            this._spotlight = null;
            this._modal = null;
        }, 350);
    }
}
