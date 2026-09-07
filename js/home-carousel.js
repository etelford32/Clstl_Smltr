/**
 * home-carousel.js — the homepage background carousel (index.html hero)
 * ═══════════════════════════════════════════════════════════════════════════
 * Cycles captured simulations behind the hero copy and buttons. It is a
 * BACKGROUND: it never takes pointer focus from the CTAs, it never plays
 * sound, and it cannot make the hero slower than the live magnetosphere
 * already is — one poster + at most one decoding <video> at a time.
 *
 * Contract
 *   mountHomeCarousel(hero, { hero3d, intervalMs, manifestUrl }) → controller
 *     hero        the #hero section (canvas + .hero-inner already inside)
 *     hero3d      the HeroSpaceWeather instance (or a promise of one) — the
 *                 live slide shows it through; on every captured slide it is
 *                 told setCovered(true) so its RAF parks while it can't be seen
 *     controller  { next(), prev(), goTo(i), index, slides, destroy() }
 *
 * Load order (each a measured/deliberate choice)
 *   • Slide 0 is the live magnetosphere: the layer is transparent so the
 *     WebGL canvas underneath IS the slide. When the page has no canvas
 *     (WebGL failed, reduced motion) the live slide is dropped and the
 *     first capture shows statically — awe without motion.
 *   • Captured slides are a JPEG poster with a muted WebM loop on top. The
 *     clip's src is assigned only as the slide becomes current and cleared
 *     when it leaves, so the browser never holds seven decoders.
 *   • Stills only under 768px, under prefers-reduced-motion, and when the
 *     visitor asked for save-data. Reduced motion also disables the
 *     auto-advance; the dots still work by hand.
 *   • A poster that fails to load drops its slide instead of showing a
 *     black frame. A missing manifest means no carousel at all — the live
 *     hero is the fallback, never an empty layer.
 *   • The timer and the video pause when the hero is off-screen or the tab
 *     is hidden (same IntersectionObserver pattern as hero-space-weather).
 *   • The caption chip is an <a data-funnel-cta="hero_carousel_<id>"> so
 *     index.html's delegated listener counts it as a landing CTA — the
 *     background is a door, that is the whole conversion mechanism.
 *   • The chip prints the capture date. Captures are archives; the site
 *     discloses archival vs live everywhere else and so does this.
 *
 * Debug: `?debug=1` exposes the controller as window.__ppCarousel (the
 * browser gate tests/home-carousel.spec.js drives it through that).
 */
import { SLIDES, MANIFEST_URL } from './home-carousel-slides.js';

const FADE_MS = 1400;

const CSS = `
.hc-layer{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none;
  opacity:0;transition:opacity ${FADE_MS}ms ease}
.hc-layer.hc-covering{opacity:1}
.hc-slide{position:absolute;inset:0;margin:0;opacity:0;transition:opacity ${FADE_MS}ms ease;will-change:opacity}
.hc-slide.hc-current{opacity:1}
.hc-slide img,.hc-slide video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;
  transform:scale(1.04);transition:transform 9s linear}
.hc-slide.hc-current img,.hc-slide.hc-current video{transform:scale(1.0)}
.hc-slide video{opacity:0;transition:opacity .6s ease}
.hc-slide video.hc-playing{opacity:1}
.hc-vignette{position:absolute;inset:0;background:
  radial-gradient(ellipse 90% 80% at 50% 45%,transparent 40%,rgba(2,0,10,.55) 100%),
  linear-gradient(180deg,rgba(2,0,10,.55) 0%,rgba(2,0,10,.05) 30%,rgba(2,0,10,.05) 70%,rgba(2,0,10,.7) 100%)}
.hc-ui{position:absolute;left:16px;right:16px;bottom:12px;z-index:2;display:flex;align-items:flex-end;
  justify-content:space-between;gap:12px;pointer-events:none}
.hc-caption{pointer-events:auto;display:inline-flex;flex-direction:column;gap:2px;max-width:min(420px,60vw);
  padding:8px 12px 8px 14px;border-radius:10px;background:rgba(4,1,16,.66);border:1px solid rgba(154,133,255,.28);
  border-left:3px solid var(--hc-accent,#9d3aff);backdrop-filter:blur(8px);text-decoration:none;color:var(--fg-2,#cdd8f0);
  transition:background .2s,border-color .2s,transform .15s,opacity .5s}
.hc-caption:hover{background:rgba(4,1,16,.9);border-color:rgba(154,133,255,.55);transform:translateY(-2px)}
.hc-caption .hc-kicker{font-family:var(--font-mono,monospace);font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;
  color:var(--hc-accent,#9d3aff)}
.hc-caption .hc-title{font-family:var(--font-display,inherit);font-weight:700;font-size:.82rem;color:#fff;letter-spacing:.02em}
.hc-caption .hc-desc{font-size:.72rem;line-height:1.35;color:var(--fg-3,#8b94ad)}
.hc-caption .hc-meta{font-size:.62rem;color:var(--fg-4,#6b7390);margin-top:2px}
.hc-caption .hc-meta b{color:var(--fg-3,#8b94ad);font-weight:600}
.hc-dots{pointer-events:auto;display:flex;gap:6px;align-items:center;padding:6px 8px;border-radius:999px;
  background:rgba(4,1,16,.5);border:1px solid rgba(154,133,255,.2);backdrop-filter:blur(6px)}
.hc-dot{width:8px;height:8px;border-radius:50%;border:0;padding:0;cursor:pointer;background:rgba(255,255,255,.28);
  transition:background .2s,transform .2s,box-shadow .2s}
.hc-dot:hover{background:rgba(255,255,255,.6)}
.hc-dot[aria-selected="true"]{background:var(--hc-accent,#9d3aff);transform:scale(1.3);box-shadow:0 0 8px var(--hc-accent,#9d3aff)}
.hc-dot:focus-visible{outline:2px solid #8ff0ff;outline-offset:2px}
/* Room for the chip + dots under the CTA row: without it the chip sits on
   the "Free forever" note at 1366/1440 widths (hero-inner is 1000px wide). */
#hero.hc-mounted{padding-bottom:128px}
@media (max-width:900px){.hc-caption{display:none}.hc-ui{justify-content:center}#hero.hc-mounted{padding-bottom:78px}}
@media (prefers-reduced-motion:reduce){.hc-layer,.hc-slide,.hc-slide img,.hc-slide video{transition:none}}
`;

function injectStyles() {
    if (document.getElementById('hc-styles')) return;
    const s = document.createElement('style');
    s.id = 'hc-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
}

function fmtDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function loadManifest(url) {
    try {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) return null;
        const json = await res.json();
        return json && Array.isArray(json.slides) ? json : null;
    } catch {
        return null;
    }
}

/**
 * @param {HTMLElement} hero
 * @param {{ hero3d?: any, intervalMs?: number, manifestUrl?: string, slides?: any[], stillsOnly?: boolean }} opts
 */
export async function mountHomeCarousel(hero, opts = {}) {
    if (!hero) return null;
    const manifestUrl = opts.manifestUrl || MANIFEST_URL;
    const manifest = await loadManifest(manifestUrl);
    if (!manifest) return null;   // no captures → the live hero is the page

    const byId = new Map(manifest.slides.map(s => [s.id, s]));
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stillsOnly = opts.stillsOnly ?? (
        reduced || matchMedia('(max-width: 768px)').matches || !!navigator.connection?.saveData
    );
    const canvas = hero.querySelector('canvas');
    const liveAvailable = !!canvas && canvas.style.display !== 'none' && !reduced;

    // Join the registry to the manifest — a slide with no media is skipped.
    const slides = [];
    for (const s of (opts.slides || SLIDES)) {
        if (s.live) { if (liveAvailable) slides.push({ ...s }); continue; }
        const m = byId.get(s.id);
        if (!m || !m.poster) continue;
        slides.push({ ...s, poster: m.poster, clip: stillsOnly ? null : (m.clip || null), capturedAt: m.capturedAt || null });
    }
    if (slides.filter(s => !s.live).length === 0) return null;

    injectStyles();

    // ── DOM ────────────────────────────────────────────────────────────
    const layer = document.createElement('div');
    layer.className = 'hc-layer';
    layer.setAttribute('aria-hidden', 'true');
    const figs = slides.map((s) => {
        const fig = document.createElement('figure');
        fig.className = 'hc-slide';
        fig.dataset.id = s.id;
        if (!s.live) {
            const img = document.createElement('img');
            img.alt = '';
            img.decoding = 'async';
            img.draggable = false;
            fig.appendChild(img);
            if (s.clip) {
                const v = document.createElement('video');
                v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = false;
                v.preload = 'none';
                v.setAttribute('muted', '');
                v.setAttribute('playsinline', '');
                v.addEventListener('playing', () => v.classList.add('hc-playing'));
                fig.appendChild(v);
            }
        }
        layer.appendChild(fig);
        return fig;
    });
    const vignette = document.createElement('div');
    vignette.className = 'hc-vignette';
    layer.appendChild(vignette);

    const ui = document.createElement('div');
    ui.className = 'hc-ui';
    const caption = document.createElement('a');
    caption.className = 'hc-caption';
    const dots = document.createElement('div');
    dots.className = 'hc-dots';
    dots.setAttribute('role', 'tablist');
    dots.setAttribute('aria-label', 'Background simulation');
    const dotEls = slides.map((s, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hc-dot';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-label', s.title);
        b.style.setProperty('--hc-accent', s.accent);
        b.addEventListener('click', () => { goTo(i, { user: true }); });
        dots.appendChild(b);
        return b;
    });
    ui.append(caption, dots);

    // Layer goes right after the canvas (or first) so #hero::after — the
    // legibility scrim — still paints above it; the UI goes last so it sits
    // above .hero-inner in DOM order.
    if (canvas && canvas.parentNode === hero) canvas.after(layer); else hero.prepend(layer);
    hero.appendChild(ui);
    hero.classList.add('hc-mounted');

    // ── State ───────────────────────────────────────────────────────────
    const intervalMs = Math.max(4000, opts.intervalMs ?? 7000);
    let index = -1;
    let timer = null;
    let visible = true;
    let pageVisible = !document.hidden;
    let destroyed = false;
    let hero3d = null;
    Promise.resolve(opts.hero3d).then(h => { hero3d = h || null; }).catch(() => {});

    const setCovered = (v) => { try { hero3d?.setCovered?.(v); } catch {} };

    function ensurePoster(i) {
        const s = slides[i]; const fig = figs[i];
        if (!s || s.live) return;
        const img = fig.querySelector('img');
        if (img && !img.src) {
            img.addEventListener('error', () => dropSlide(s.id), { once: true });
            img.src = s.poster;
        }
    }

    function dropSlide(id) {
        const i = slides.findIndex(s => s.id === id);
        if (i < 0) return;
        const wasCurrent = i === index;
        figs[i].remove(); dotEls[i].remove();
        slides.splice(i, 1); figs.splice(i, 1); dotEls.splice(i, 1);
        if (index > i) index--;
        if (slides.filter(s => !s.live).length === 0) { destroy(); return; }
        if (wasCurrent) { index = -1; goTo(Math.min(i, slides.length - 1)); }
    }

    function stopVideo(fig) {
        const v = fig?.querySelector('video');
        if (!v) return;
        try { v.pause(); } catch {}
        v.classList.remove('hc-playing');
        v.removeAttribute('src');
        try { v.load(); } catch {}
    }

    function startVideo(i) {
        const s = slides[i]; const v = figs[i]?.querySelector('video');
        if (!s?.clip || !v || !visible || !pageVisible) return;
        if (v.getAttribute('src') !== s.clip) v.src = s.clip;
        v.play().catch(() => { /* autoplay refused → poster stays, no harm */ });
    }

    function renderCaption(s) {
        caption.style.setProperty('--hc-accent', s.accent);
        caption.href = s.href;
        caption.setAttribute('data-funnel-cta', 'hero_carousel_' + s.id);
        caption.setAttribute('aria-label', `${s.title} — open the simulation`);
        const when = s.live ? null : fmtDate(s.capturedAt);
        caption.innerHTML =
            `<span class="hc-kicker">${s.live ? 'Live now' : 'From the lab'}</span>` +
            `<span class="hc-title">${s.title} <span aria-hidden="true">→</span></span>` +
            `<span class="hc-desc">${s.caption}</span>` +
            `<span class="hc-meta">${s.live
                ? '<b>Live</b> · NOAA SWPC · rendering on this page'
                : `<b>Captured</b>${when ? ' ' + when : ''} · the real page runs live`}</span>`;
    }

    function goTo(i, { user = false } = {}) {
        if (destroyed || !slides.length) return;
        i = ((i % slides.length) + slides.length) % slides.length;
        if (i === index) { if (user) armTimer(); return; }
        const prev = index;
        index = i;
        const s = slides[i];
        figs.forEach((f, k) => f.classList.toggle('hc-current', k === i));
        dotEls.forEach((d, k) => d.setAttribute('aria-selected', k === i ? 'true' : 'false'));
        renderCaption(s);
        if (s.live) {
            layer.classList.remove('hc-covering');
            setCovered(false);                      // wake the canvas BEFORE the fade
        } else {
            ensurePoster(i);
            layer.classList.add('hc-covering');
            startVideo(i);
            // Park the WebGL loop once the fade has fully hidden it.
            setTimeout(() => { if (index === i && !destroyed) setCovered(true); }, FADE_MS + 50);
        }
        if (prev >= 0 && prev !== i) setTimeout(() => stopVideo(figs[prev]), FADE_MS);
        ensurePoster((i + 1) % slides.length);      // warm the next poster only
        armTimer();
    }

    function armTimer() {
        clearTimeout(timer); timer = null;
        if (reduced || !visible || !pageVisible || slides.length < 2) return;
        timer = setTimeout(() => goTo(index + 1), intervalMs);
    }

    function onVisibility() {
        const now = visible && pageVisible;
        if (now) { startVideo(index); armTimer(); }
        else { clearTimeout(timer); timer = null; const v = figs[index]?.querySelector('video'); try { v?.pause(); } catch {} }
    }
    const onDocVis = () => { pageVisible = !document.hidden; onVisibility(); };
    document.addEventListener('visibilitychange', onDocVis);
    let io = null;
    if ('IntersectionObserver' in window) {
        io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; onVisibility(); }, { threshold: 0.02 });
        io.observe(hero);
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onDocVis);
        io?.disconnect();
        figs.forEach(stopVideo);
        layer.remove(); ui.remove();
        hero.classList.remove('hc-mounted');
        setCovered(false);
    }

    // Boot: the live slide first when we have it (the canvas is already
    // painting), else the first capture. Under reduced motion there is no
    // canvas and no timer, so the first capture simply stands still.
    goTo(0);

    const ctl = {
        next: () => goTo(index + 1, { user: true }),
        prev: () => goTo(index - 1, { user: true }),
        goTo: (i) => goTo(i, { user: true }),
        get index() { return index; },
        get slides() { return slides.map(s => s.id); },
        get stillsOnly() { return stillsOnly; },
        destroy,
    };
    if (/[?&]debug=1(?:&|$)/.test(location.search)) window.__ppCarousel = ctl;
    return ctl;
}
