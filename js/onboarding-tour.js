/**
 * onboarding-tour.js — Guided modal tour for new users
 *
 * A polished step-by-step tour that spotlights dashboard sections with a
 * translucent cutout overlay, a cleanly-anchored tooltip card, and smooth
 * scroll/transitions between steps.
 *
 * ── Key design decisions ─────────────────────────────────────────────────────
 *  - Overlay is a translucent scrim (not opaque) so the page is always visible
 *  - Spotlight is a real CSS clip-path cutout, not a massive box-shadow
 *  - The tooltip card is always anchored to a consistent position (bottom-right
 *    of the spotlight, or centered for full-screen steps)
 *  - Arrow/connector points from card to target
 *  - Back button available from step 2 onward
 *  - Keyboard: Escape to skip, Enter/Right to advance, Left to go back
 */

const LS_KEY = 'ppx_tour_completed';

// Steps shared across personas. Each entry has a `personas` array — the
// step is shown only when the user's resolved persona is in the list, OR
// when `personas` is omitted (meaning: show for everyone).
//
// Personas:
//   'educator'   — user is on educator/institution/enterprise (parent of class)
//   'student'    — user has a parent_account_id (joined a class)
//   'advanced'   — advanced/institution/enterprise paid tier
//   'basic'      — basic plan
//   'free'       — no subscription
//
// The first step (welcome) is rewritten per persona. The class-roster step
// only fires for educators. Everyone gets the location + alerts steps.
const STEPS_BY_PERSONA = {
    educator: [
        {
            title: 'Welcome, instructor',
            body: 'Your Parker Physics class is live. The first thing to do is invite your students — they\'ll get a magic link, sign up free, and inherit your plan automatically.',
            icon: '&#127979;',
            target: null,
            cta: 'Show me how',
        },
        {
            title: 'Invite your class',
            body: 'Drop your students\' emails into this roster panel. Each invite uses one of your seats; remove a student to free a seat back up.',
            icon: '&#128231;',
            target: '#class-roster-card',
            cta: 'Next',
        },
        {
            title: 'Set a teaching location',
            body: 'Pin your school\'s coordinates so the live aurora, satellite-pass, and weather forecasts in every simulation are personalized to your students\' sky.',
            icon: '&#128205;',
            target: '#location-card',
            cta: 'Next',
        },
        {
            title: 'Pick a simulation to demo',
            body: '17+ WebGL labs driven by real NASA/NOAA data — the Sun\'s magnetic field, Earth\'s magnetosphere, accretion disks around supermassive black holes. Every sim is classroom-shareable.',
            icon: '&#9788;',
            target: '.sim-grid',
            cta: 'Next',
        },
        {
            title: 'You\'re ready to teach',
            body: 'Tip: every page carries a "Powered by Parker Physics" badge for your students — that\'s the educator-tier licensing terms in action. Solar Maximum is now; the data is rich.',
            icon: '&#127775;',
            target: null,
            cta: 'Start teaching',
            final: true,
        },
    ],

    student: [
        {
            title: 'Welcome to your class',
            body: 'You\'ve joined a Parker Physics class — your instructor\'s plan covers full access. No card on file, no upgrade pitch.',
            icon: '&#127891;',
            target: null,
            cta: 'Show me around',
        },
        {
            title: 'Set your location',
            body: 'Drop a pin where you are so the aurora, sky charts, and satellite passes match your view.',
            icon: '&#128205;',
            target: '#location-card',
            cta: 'Next',
        },
        {
            title: 'Pick a simulation',
            body: 'Black holes, the Sun\'s atmosphere, the magnetosphere, the inner Milky Way — all interactive, all driven by live data. Start anywhere.',
            icon: '&#9788;',
            target: '.sim-grid',
            cta: 'Next',
        },
        {
            title: 'You\'re all set',
            body: 'Ask your instructor which sim ties to the lesson — or just explore. Solar Maximum is happening right now; the activity is unusually high.',
            icon: '&#127775;',
            target: null,
            cta: 'Explore',
            final: true,
        },
    ],

    advanced: [
        {
            title: 'Welcome, professional',
            body: 'Advanced tier unlocks the full pipeline: collision screens, GNSS scintillation forecasts, satellite alerts, the API. Let\'s tour the operator surface.',
            icon: '&#128752;',
            target: null,
            cta: 'Show me',
        },
        {
            title: 'Pin your operating area',
            body: 'Saved locations drive forecast pre-warming and per-site alerts. You can save up to 25 locations on the Advanced tier.',
            icon: '&#128205;',
            target: '#location-card',
            cta: 'Next',
        },
        {
            title: 'Configure your alerts',
            body: 'Solar flare class, Kp threshold, conjunction radius, GNSS risk, power-grid storm severity — all configurable, all delivered by email when triggered.',
            icon: '&#128276;',
            target: '#alert-prefs-card',
            cta: 'Next',
        },
        {
            title: 'Open the operator console',
            body: 'The simulations double as analysis tools: TLE conjunction watch on Upper Atmosphere, real GFS+ECMWF ensemble on Earth, full TON 618 GR observatory.',
            icon: '&#9788;',
            target: '.sim-grid',
            cta: 'Next',
        },
        {
            title: 'You\'re live',
            body: 'API keys + rate-limit policy live in /api-policy. Reach out for custom integrations or a higher cap.',
            icon: '&#127775;',
            target: null,
            cta: 'Get to work',
            final: true,
        },
    ],

    // Default flow for free / basic — same five-step tour as before but
    // re-targeted to be more concrete about the "what would I get if I
    // upgraded" pitch on the alerts step.
    default: [
        {
            title: 'Welcome to Parker Physics',
            body: 'Your personal astrophysics command center — powered by live NASA and NOAA satellite data, updated every 60 seconds.',
            icon: '&#128640;',
            target: null,
            cta: 'Show me around',
        },
        {
            title: 'Set your location',
            body: 'Enter your city or use GPS to unlock personalized aurora forecasts, satellite pass predictions, and local weather alerts.',
            icon: '&#128205;',
            target: '#location-card',
            cta: 'Next',
        },
        {
            title: 'Live space weather',
            body: 'Real-time Kp index, solar wind speed, IMF Bz, and storm conditions from NOAA SWPC. Updates every 60 seconds automatically.',
            icon: '&#127758;',
            target: '#sw-card',
            cta: 'Next',
        },
        {
            title: 'Your impact score',
            body: 'A personalized 0–100 score combining geomagnetic activity, solar radiation, CME threats, and your location — with 24h, 3-day, and 7-day storm probability forecasts.',
            icon: '&#127919;',
            target: '#impact-card',
            cta: 'Next',
        },
        {
            title: 'Custom alerts',
            body: 'Set alerts for aurora visibility, solar flares, geomagnetic storms, temperature extremes, and more. Subscribers get email delivery and advanced alerts like satellite collision detection.',
            icon: '&#128276;',
            target: '#alert-prefs-card',
            cta: 'Next',
        },
        {
            title: 'Interactive simulations',
            body: '17+ WebGL simulations — from the Sun\'s photosphere to Earth\'s magnetosphere, black hole accretion disks, and the Milky Way. All driven by real physics engines.',
            icon: '&#9788;',
            target: '.sim-grid',
            cta: 'Next',
        },
        {
            title: 'You\'re all set!',
            body: 'Start by setting your location, then explore a simulation. Solar Maximum is happening right now — the best aurora season in over a decade.',
            icon: '&#127775;',
            target: null,
            cta: 'Start exploring',
            final: true,
        },
    ],
};

/**
 * Resolve which persona's tour to play. Reads from window._ppAuth.auth or
 * the global auth singleton. Falls back to 'default' if it can't tell.
 */
function resolvePersona() {
    try {
        const a = window._ppAuth?.auth || window.auth;
        if (!a) return 'default';
        const plan = (a.getPlan?.() || 'free').toLowerCase();
        const user = a.getUser?.() || {};
        if (user.parent_account_id) return 'student';
        if (['educator', 'institution', 'enterprise'].includes(plan)) return 'educator';
        if (['advanced'].includes(plan)) return 'advanced';
        return 'default';
    } catch {
        return 'default';
    }
}


// ── Styles ───────────────────────────────────────────────────────────────────

const TOUR_CSS = `
/* ── Scrim: translucent so the page is always visible ─────────────────────── */
.tour-scrim {
    position: fixed; inset: 0; z-index: 9990;
    background: rgba(3,1,14,.55);
    opacity: 0; transition: opacity .35s;
    pointer-events: auto;
}
.tour-scrim.visible { opacity: 1; }

/* ── Spotlight cutout: highlights the target element ──────────────────────── */
.tour-spotlight {
    position: fixed; z-index: 9991;
    border: 2px solid rgba(255,200,0,.35);
    border-radius: 12px;
    box-shadow: 0 0 0 4px rgba(255,200,0,.08), 0 0 30px rgba(255,180,0,.12);
    transition: top .4s ease, left .4s ease, width .4s ease, height .4s ease, opacity .3s;
    pointer-events: none;
    opacity: 0;
}
.tour-spotlight.visible { opacity: 1; }

/* ── Tooltip card ─────────────────────────────────────────────────────────── */
.tour-card {
    position: fixed; z-index: 9992;
    background: rgba(14,12,30,.94);
    backdrop-filter: blur(24px) saturate(1.2);
    border: 1px solid rgba(255,200,0,.18);
    border-radius: 14px;
    padding: 24px 22px 18px;
    width: 380px; max-width: calc(100vw - 32px);
    box-shadow: 0 16px 48px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.04) inset;
    opacity: 0; transform: translateY(12px);
    transition: opacity .3s, transform .35s ease;
}
.tour-card.visible { opacity: 1; transform: translateY(0); }
.tour-card.center {
    top: 50% !important; left: 50% !important;
    transform: translate(-50%, -50%) !important;
}
.tour-card.center.visible { transform: translate(-50%, -50%) !important; }

/* ── Arrow connector (CSS triangle) ───────────────────────────────────────── */
.tour-arrow {
    position: absolute; width: 12px; height: 12px;
    background: rgba(14,12,30,.94);
    border: 1px solid rgba(255,200,0,.18);
    transform: rotate(45deg);
}
.tour-arrow.arrow-up    { top: -7px; border-bottom: none; border-right: none; }
.tour-arrow.arrow-down  { bottom: -7px; border-top: none; border-left: none; }

/* ── Card content ─────────────────────────────────────────────────────────── */
.tour-step-badge {
    display: inline-block; font-size: .6rem; font-weight: 700;
    color: rgba(255,200,0,.7); letter-spacing: .08em; text-transform: uppercase;
    margin-bottom: 8px;
}
.tour-icon { font-size: 1.8rem; margin-bottom: 8px; line-height: 1; }
.tour-title { font-size: 1.05rem; font-weight: 700; color: #e8f4ff; margin-bottom: 6px; line-height: 1.3; }
.tour-body { font-size: .8rem; color: #8899aa; line-height: 1.65; margin-bottom: 16px; }
.tour-footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.tour-dots { display: flex; gap: 4px; }
.tour-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: rgba(255,255,255,.12); transition: background .3s, transform .3s;
}
.tour-dot.active { background: #ffd700; transform: scale(1.3); }
.tour-dot.done   { background: rgba(255,200,0,.35); }
.tour-btns { display: flex; gap: 6px; align-items: center; }
.tour-btn {
    padding: 7px 18px; border: none; border-radius: 7px;
    font-size: .8rem; font-weight: 700; cursor: pointer; font-family: inherit;
    background: linear-gradient(135deg, #ff8c00, #ffd700); color: #000;
    transition: filter .15s, transform .15s;
}
.tour-btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
.tour-btn-back {
    padding: 7px 12px; border: 1px solid rgba(255,255,255,.1); border-radius: 7px;
    background: rgba(255,255,255,.04); color: #889; cursor: pointer;
    font-family: inherit; font-size: .78rem; transition: border-color .15s;
}
.tour-btn-back:hover { border-color: rgba(255,255,255,.25); color: #bbc; }
.tour-skip {
    background: none; border: none; color: #556; font-size: .68rem;
    cursor: pointer; font-family: inherit; padding: 2px 6px;
}
.tour-skip:hover { color: #99a; }
.tour-progress {
    margin-top: 12px; height: 2px; border-radius: 1px;
    background: rgba(255,255,255,.05); overflow: hidden;
}
.tour-progress-bar {
    height: 100%; border-radius: 1px;
    background: linear-gradient(90deg, #ff8c00, #ffd700);
    transition: width .4s ease;
}
@media (max-width: 500px) {
    .tour-card { width: calc(100vw - 24px); padding: 20px 16px 14px; }
}
`;

// ─────────────────────────────────────────────────────────────────────────────

export class OnboardingTour {
    constructor() {
        this._step = 0;
        this._scrim = null;
        this._spotlight = null;
        this._card = null;
        this._active = false;
        this._onKey = this._onKey.bind(this);
        this._steps = STEPS_BY_PERSONA.default;
        this._persona = 'default';
    }

    start() {
        try { if (localStorage.getItem(LS_KEY) === '1') return; } catch {}
        this.forceStart();
    }

    forceStart() {
        if (this._active) return;
        // Persona is resolved fresh each time forceStart is called so the
        // "Retake tour" button picks up plan changes (e.g. user just
        // upgraded to Educator).
        this._persona = resolvePersona();
        this._steps = STEPS_BY_PERSONA[this._persona] || STEPS_BY_PERSONA.default;
        this._active = true;
        this._step = 0;
        this._inject();
        this._create();
        this._render();
        document.addEventListener('keydown', this._onKey);
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _inject() {
        if (document.getElementById('tour-css')) return;
        const s = document.createElement('style');
        s.id = 'tour-css';
        s.textContent = TOUR_CSS;
        document.head.appendChild(s);
    }

    _create() {
        this._scrim = document.createElement('div');
        this._scrim.className = 'tour-scrim';
        this._scrim.addEventListener('click', () => this._close());
        document.body.appendChild(this._scrim);

        this._spotlight = document.createElement('div');
        this._spotlight.className = 'tour-spotlight';
        document.body.appendChild(this._spotlight);

        this._card = document.createElement('div');
        this._card.className = 'tour-card';
        document.body.appendChild(this._card);

        requestAnimationFrame(() => this._scrim.classList.add('visible'));
    }

    _render() {
        const steps = this._steps;
        const step = steps[this._step];
        if (!step) { this._close(); return; }

        const pct = (((this._step + 1) / steps.length) * 100).toFixed(0);

        // Build card HTML
        this._card.innerHTML = `
            <div class="tour-step-badge">Step ${this._step + 1} of ${steps.length}</div>
            <div class="tour-icon">${step.icon}</div>
            <div class="tour-title">${step.title}</div>
            <div class="tour-body">${step.body}</div>
            <div class="tour-footer">
                <div class="tour-dots">
                    ${steps.map((_, i) =>
                        `<span class="tour-dot${i === this._step ? ' active' : i < this._step ? ' done' : ''}"></span>`
                    ).join('')}
                </div>
                <div class="tour-btns">
                    ${!step.final ? '<button class="tour-skip" id="tour-skip">Skip</button>' : ''}
                    ${this._step > 0 ? '<button class="tour-btn-back" id="tour-back">&larr;</button>' : ''}
                    <button class="tour-btn" id="tour-next">${step.cta}</button>
                </div>
            </div>
            <div class="tour-progress"><div class="tour-progress-bar" style="width:${pct}%"></div></div>
        `;

        // Wire buttons
        this._card.querySelector('#tour-next')?.addEventListener('click', () => {
            if (step.final) { this._close(); return; }
            this._step++;
            this._render();
        });
        this._card.querySelector('#tour-back')?.addEventListener('click', () => {
            if (this._step > 0) { this._step--; this._render(); }
        });
        this._card.querySelector('#tour-skip')?.addEventListener('click', () => this._close());

        // Position spotlight + card
        this._position(step);
    }

    _position(step) {
        // Remove old arrow
        this._card.querySelector('.tour-arrow')?.remove();

        // Reset card classes
        this._card.classList.remove('center', 'visible');
        this._card.style.top = '';
        this._card.style.left = '';
        this._card.style.bottom = '';
        this._card.style.right = '';

        if (!step.target) {
            // Full-screen centered card (welcome/finale)
            this._spotlight.classList.remove('visible');
            this._card.classList.add('center');
            requestAnimationFrame(() => {
                requestAnimationFrame(() => this._card.classList.add('visible'));
            });
            return;
        }

        const el = document.querySelector(step.target);
        if (!el) {
            // Target not found — center the card
            this._spotlight.classList.remove('visible');
            this._card.classList.add('center');
            requestAnimationFrame(() => {
                requestAnimationFrame(() => this._card.classList.add('visible'));
            });
            return;
        }

        // Scroll target into view first, then position after scroll settles
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });

        setTimeout(() => {
            const rect = el.getBoundingClientRect();
            const pad = 10;

            // Position spotlight over the target
            this._spotlight.style.top    = (rect.top - pad) + 'px';
            this._spotlight.style.left   = (rect.left - pad) + 'px';
            this._spotlight.style.width  = (rect.width + pad * 2) + 'px';
            this._spotlight.style.height = (rect.height + pad * 2) + 'px';
            this._spotlight.classList.add('visible');

            // Decide card placement: prefer below, fallback above
            const cardH = 280;
            const gap = 14;
            const spaceBelow = window.innerHeight - rect.bottom;
            const spaceAbove = rect.top;

            let cardTop, arrowClass, arrowLeft;

            if (spaceBelow >= cardH + gap) {
                // Place below target
                cardTop = rect.bottom + gap;
                arrowClass = 'arrow-up';
            } else if (spaceAbove >= cardH + gap) {
                // Place above target
                cardTop = rect.top - cardH - gap;
                arrowClass = 'arrow-down';
            } else {
                // Not enough space — place at bottom of viewport
                cardTop = window.innerHeight - cardH - 20;
                arrowClass = '';
            }

            // Horizontal: center on target, clamped to viewport
            const cardW = Math.min(380, window.innerWidth - 32);
            let cardLeft = rect.left + rect.width / 2 - cardW / 2;
            cardLeft = Math.max(16, Math.min(window.innerWidth - cardW - 16, cardLeft));

            this._card.style.top  = cardTop + 'px';
            this._card.style.left = cardLeft + 'px';

            // Arrow connector
            if (arrowClass) {
                const arrow = document.createElement('div');
                arrow.className = 'tour-arrow ' + arrowClass;
                // Position arrow horizontally to point at target center
                arrowLeft = rect.left + rect.width / 2 - cardLeft - 6;
                arrowLeft = Math.max(20, Math.min(cardW - 32, arrowLeft));
                arrow.style.left = arrowLeft + 'px';
                this._card.appendChild(arrow);
            }

            requestAnimationFrame(() => {
                requestAnimationFrame(() => this._card.classList.add('visible'));
            });
        }, 350);  // wait for scroll to settle
    }

    _onKey(e) {
        if (!this._active) return;
        if (e.key === 'Escape') { this._close(); return; }
        if (e.key === 'ArrowRight' || e.key === 'Enter') {
            if (this._steps[this._step]?.final) { this._close(); return; }
            this._step++;
            this._render();
            return;
        }
        if (e.key === 'ArrowLeft' && this._step > 0) {
            this._step--;
            this._render();
        }
    }

    _close() {
        this._active = false;
        document.removeEventListener('keydown', this._onKey);
        try { localStorage.setItem(LS_KEY, '1'); } catch {}

        this._scrim?.classList.remove('visible');
        this._spotlight?.classList.remove('visible');
        this._card?.classList.remove('visible');

        setTimeout(() => {
            this._scrim?.remove();
            this._spotlight?.remove();
            this._card?.remove();
            this._scrim = this._spotlight = this._card = null;
        }, 400);
    }
}
