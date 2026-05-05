/**
 * scale-nav.js — Cross-scale zoom navigation for Parkers Physics App
 *
 * Provides an animated zoom hierarchy breadcrumb that appears in every
 * simulation page's nav bar and enables seamless transitions between
 * cosmic scale levels.
 *
 * Scale hierarchy (zoom in → zoom out):
 *
 *   🌍 Earth  ←→  ☀️ Solar System  ←→  🌀 Galaxy  ←→  🌌 Universe
 *   earth.html    threejs.html         galactic-map.html  galactic-map.html
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   // In any page's <script type="module">:
 *   import { initScaleNav, navigateTo } from './js/scale-nav.js';
 *   initScaleNav('earth');   // 'earth' | 'solar' | 'galaxy' | 'universe'
 *
 *   // Programmatic navigation with fade transition:
 *   navigateTo('earth.html');
 *
 * ── What initScaleNav does ────────────────────────────────────────────────
 *   1. Immediately sets body opacity → 0 (captures initial paint)
 *   2. Fades the page in over 380 ms (completes any inbound zoom transition)
 *   3. Injects a compact breadcrumb before .nav-menu in the page's <nav>
 *   4. Intercepts clicks on breadcrumb links and nav links pointing to
 *      scale-level pages → replaces hard navigation with animated fade
 *   5. Marks the active level with full label; others show emoji only
 */

// ── Scale hierarchy definition ─────────────────────────────────────────────────
export const SCALE_LEVELS = [
    { id: 'universe', emoji: '🌌', label: 'Universe',     url: 'galactic-map.html' },
    { id: 'galaxy',   emoji: '🌀', label: 'Galaxy Map',   url: 'galactic-map.html' },
    { id: 'solar',    emoji: '☀️',  label: 'Solar System', url: 'threejs.html'      },
    { id: 'earth',    emoji: '🌍', label: 'Earth',         url: 'earth.html'        },
];

// ── Animated fade transition ────────────────────────────────────────────────────
/**
 * Fade the viewport to black and navigate to `url`.
 * Duration ≈ 380 ms fade + negligible load latency.
 */
export function navigateTo(url) {
    // Prevent re-entrant calls
    if (navigateTo._busy) return;
    navigateTo._busy = true;

    const ov = document.createElement('div');
    ov.style.cssText =
        'position:fixed;inset:0;z-index:99999;background:#000;' +
        'opacity:0;transition:opacity .38s ease;pointer-events:all;';
    document.body.appendChild(ov);

    // Double rAF ensures the element is painted before we trigger the transition
    requestAnimationFrame(() => requestAnimationFrame(() => {
        ov.style.opacity = '1';
        setTimeout(() => { window.location.href = url; }, 400);
    }));
}
navigateTo._busy = false;

// ── CSS injected once per page ──────────────────────────────────────────────────
const _CSS = `
/* ── Scale breadcrumb (injected by scale-nav.js) ── */
.scale-bc {
    display: flex;
    align-items: center;
    gap: 1px;
    margin: 0 8px;
    padding: 2px 8px;
    border-radius: 12px;
    background: rgba(255,255,255,.04);
    border: 1px solid rgba(255,255,255,.08);
    font-size: 9px;
    letter-spacing: .02em;
    font-family: 'Segoe UI', system-ui, sans-serif;
    flex-shrink: 0;
}
.scale-bc .sbc-lv {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 5px;
    border-radius: 8px;
    color: #445;
    text-decoration: none;
    white-space: nowrap;
    transition: color .15s, background .15s;
    cursor: pointer;
    line-height: 1;
}
.scale-bc .sbc-lv:hover { color: #99b; background: rgba(255,255,255,.07); }
.scale-bc .sbc-lv.sbc-active { color: #88aadd; font-weight: 600; }
/* Show full label only for active level */
.scale-bc .sbc-lv .sbc-label { display: none; font-size: 9px; }
.scale-bc .sbc-lv.sbc-active .sbc-label { display: inline; }
.scale-bc .sbc-sep {
    color: #2a3040;
    padding: 0 1px;
    user-select: none;
    font-size: 8px;
}
/* Zoom-to-Earth call-to-action button in solar system panel */
#btn-goto-earth {
    width: 100%;
    padding: 8px 10px;
    margin-top: 10px;
    background: linear-gradient(135deg, rgba(0,50,110,.8), rgba(0,110,170,.6));
    border: 1px solid rgba(0,170,255,.35);
    border-radius: 6px;
    color: #80d8ff;
    font-size: 10px;
    cursor: pointer;
    font-family: inherit;
    letter-spacing: .04em;
    transition: background .2s, border-color .2s, color .2s;
}
#btn-goto-earth:hover {
    background: linear-gradient(135deg, rgba(0,80,160,.9), rgba(0,150,220,.7));
    border-color: rgba(0,200,255,.6);
    color: #b0eeff;
}
`;

// ── DOM injection ────────────────────────────────────────────────────────────────
export function initScaleNav(activeId) {

    // ── 1. Page fade-in (complete the inbound transition) ─────────────────────
    // Set opacity:0 before first paint, then fade to 1
    document.body.style.opacity = '0';
    document.body.style.transition = 'none';
    requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.style.transition = 'opacity .38s ease';
        document.body.style.opacity    = '1';
    }));

    // ── 2. Build and inject nav breadcrumb ────────────────────────────────────
    const inject = () => {
        if (document.getElementById('scale-bc')) return;   // idempotent

        // Inject CSS once
        if (!document.getElementById('scale-nav-css')) {
            const st = document.createElement('style');
            st.id = 'scale-nav-css';
            st.textContent = _CSS;
            document.head.appendChild(st);
        }

        // Build breadcrumb element
        const bc = document.createElement('div');
        bc.id        = 'scale-bc';
        bc.className = 'scale-bc';
        bc.setAttribute('role', 'navigation');
        bc.setAttribute('aria-label', 'Cosmic scale navigation');

        SCALE_LEVELS.forEach((lvl, i) => {
            if (i > 0) {
                const sep = document.createElement('span');
                sep.className    = 'sbc-sep';
                sep.textContent  = '›';
                sep.setAttribute('aria-hidden', 'true');
                bc.appendChild(sep);
            }

            const a = document.createElement('a');
            a.className = 'sbc-lv' + (lvl.id === activeId ? ' sbc-active' : '');
            a.href  = lvl.url;
            a.title = lvl.label;
            if (lvl.id === activeId) a.setAttribute('aria-current', 'page');

            const em = document.createElement('span');
            em.textContent = lvl.emoji;
            em.setAttribute('aria-hidden', 'true');

            const lb = document.createElement('span');
            lb.className   = 'sbc-label';
            lb.textContent = '\u00a0' + lvl.label;  // non-breaking space before label

            a.appendChild(em);
            a.appendChild(lb);
            bc.appendChild(a);

            // Intercept click — active level does nothing; others fade-navigate
            a.addEventListener('click', e => {
                e.preventDefault();
                if (lvl.id !== activeId) navigateTo(lvl.url);
            });
        });

        // Insert before .nav-menu so it sits between brand and nav links
        const nav  = document.querySelector('nav');
        const menu = nav?.querySelector('.nav-menu');
        if (menu)     menu.insertAdjacentElement('beforebegin', bc);
        else if (nav) nav.appendChild(bc);

        // ── 3. Also animate existing nav links that point to scale pages ──────
        // This means clicking "Solar System" or "Galactic Map" in any page's
        // top nav also gets the smooth fade transition.
        const scaleUrls = new Set(SCALE_LEVELS.map(l => l.url));
        document.querySelectorAll('nav a[href]').forEach(a => {
            const href = a.getAttribute('href');
            if (scaleUrls.has(href) && href !== SCALE_LEVELS.find(l => l.id === activeId)?.url) {
                a.addEventListener('click', e => {
                    e.preventDefault();
                    navigateTo(href);
                });
            }
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else {
        inject();
    }
}
