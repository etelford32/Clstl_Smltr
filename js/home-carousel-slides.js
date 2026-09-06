/**
 * home-carousel-slides.js — the ONE list of simulations the homepage
 * background carousel cycles through, plus the recipe that captures each.
 * ═══════════════════════════════════════════════════════════════════════════
 * Consumed by:
 *   - js/home-carousel.js                   the runtime (title / caption / href)
 *   - scripts/capture-home-carousel.mjs     the Playwright capture (url / crop /
 *                                           ready / hide) that writes the
 *                                           poster + clip + manifest under
 *                                           assets/home/carousel/
 *   - tests/home-carousel.mjs               drift gate — every href and capture
 *                                           url must exist on disk, every
 *                                           manifest entry must point at a
 *                                           real file
 *
 * WHY CAPTURES, NOT LIVE EMBEDS
 * ─────────────────────────────
 * Every sim here is a full three.js app. The 2026-09 funnel work measured
 * that the two live iframes below the hero were the reason only ~7% of
 * visitors reached the capture band. A carousel of seven live WebGL
 * contexts behind the buttons would repeat that mistake at 3× the cost.
 * So the background is a poster (JPEG) that swaps to a short muted loop
 * (WebM) — one decoding at a time — and the ONLY live slide is the
 * magnetosphere canvas the hero already pays for.
 *
 * HONESTY
 * ───────
 * A capture is an archive, not an observation. The manifest carries a
 * `capturedAt` per slide and the caption chip prints it — the same
 * archival-vs-live split the Mars tile layer discloses. Do not drop the
 * date to tidy the chip.
 *
 * Fields
 *   id          stable kebab-case key; also the media basename
 *   title       what the visitor is looking at (chip headline)
 *   caption     one line, what the sim actually computes — physics-first
 *   href        where the chip links (must exist on disk)
 *   accent      chip / dot colour
 *   capture     { url, crop, ready, hide, settleMs, clipMs }
 *                url      page to capture (root-relative, query allowed)
 *                crop     selector of the element to crop to (falls back to
 *                         the viewport when it has no box)
 *                ready    JS expression evaluated in the page until truthy
 *                hide     selectors to display:none before capture (page
 *                         chrome that would otherwise sit in the shot)
 *                prep     optional JS run once ready (toggle an in-scene
 *                         layer, pick a camera) before the settle wait
 *                stripOverlays  default true: the capture also hides every
 *                         fixed/absolute element that is not (and does not
 *                         contain) a canvas — panels, tickers, tips — so a
 *                         page can add chrome without breaking its shot
 *                settleMs how long to let the scene run before the poster
 *                clipMs   loop length recorded after the poster
 */

export const MEDIA_DIR = 'assets/home/carousel/';
export const MANIFEST_URL = MEDIA_DIR + 'manifest.json';

/** Slide 0 — the hero's own live WebGL magnetosphere. Never captured. */
export const LIVE_SLIDE = Object.freeze({
    id: 'live-magnetosphere',
    live: true,
    title: 'Your magnetosphere, live',
    caption: 'Shue magnetopause and bow shock driven by NOAA SWPC solar wind, refreshed every 60 s.',
    href: 'space-weather.html',
    accent: '#8ff0ff',
});

export const CAPTURED_SLIDES = Object.freeze([
    {
        id: 'flux-rope',
        title: 'Flux-rope CME corridor',
        caption: 'Magnetic flux ropes launched from real DONKI events, CME-on-CME interaction in transit, arrival drawn as geometry.',
        href: 'flux-rope-live.html',
        accent: '#ff5cb8',
        capture: {
            url: '/space-weather.html?preview=1',
            crop: '#sw-stage-host',
            ready: 'window.__swStage && window.__swStage.attract',
            hide: ['nav', '#sw-status-band', '#alerts-bar', '#data-status-banner'],
            settleMs: 9000,
            clipMs: 7000,
        },
    },
    {
        id: 'ring-current',
        title: 'Ring current & the inner magnetosphere',
        caption: 'Bounce-averaged ion transport, charge-exchange loss and the Dst it builds — the storm’s main phase, particle by particle.',
        href: 'ring-current.html',
        accent: '#ffb830',
        capture: {
            url: '/ring-current.html',
            crop: '#rc-stage',
            ready: '!!window.rcGlobe',
            hide: ['nav', '#rc-dock', '#rc-legend', '.rc-simtime', '.rc-views', '.rc-insp', '.rc-perf',
                   '.rc-gosee', '.rc-stage-hint', '.rc-descent', '.rc-heat-panel', '.rc-ena-cap'],
            // The ENA imager panel is an in-scene mesh, not DOM — switch the
            // layer off so the ring itself is the picture.
            prep: 'document.querySelector(".rc-ena-toggle.rc-on")?.click()',
            settleMs: 9000,
            clipMs: 7000,
        },
    },
    {
        id: 'mars',
        title: 'Mars, in real time',
        caption: 'JPL ephemeris rotation, MOLA relief, a modelled climate field and NASA Trek imagery streamed on approach.',
        href: 'mars.html',
        accent: '#ff8c5a',
        capture: {
            url: '/mars.html',
            crop: '#mars-canvas',
            ready: '!!window.__marsLab',
            hide: ['nav', '#landmark-card', '.loader-status', '#climate-controls', '.mars-header', '.mission-strip',
                   '.camera-dock', '.mission-panel', '.layers-panel', '.data-dock', '.feature-index', '#climate-legend',
                   '#climate-readout'],
            settleMs: 10000,
            clipMs: 7000,
        },
    },
    {
        id: 'moon',
        title: 'The Moon with real relief',
        caption: 'LRO-derived terrain displaced on the sphere, a collisionless exosphere, and a descent mode down to the regolith.',
        href: 'moon.html',
        accent: '#d9d4c7',
        capture: {
            url: '/moon.html',
            crop: '#c',
            ready: '!!window.__moonLab',
            hide: ['nav', '#hud', '#info-panel', '#descent-hud', '#view-toggle', '.view-toggle', '#synth-legend'],
            // Default framing looks at the terminator; swing the camera to
            // the sunlit hemisphere so the relief and maria read.
            prep: 'const L=window.__moonLab; if(L){const d=L.camera.position.length(); L.camera.position.set(1,0.15,0.3).normalize().multiplyScalar(d); L.controls?.update?.();}',
            settleMs: 9000,
            clipMs: 7000,
        },
    },
    {
        id: 'earth',
        title: 'EarthView',
        caption: 'Live radar, hurricane tracks, NWS alerts and tonight’s aurora oval on one globe, with the troposphere drawn to scale.',
        href: 'earth.html',
        accent: '#2eff9e',
        capture: {
            url: '/earth.html?verdict=0',
            crop: '#c',
            ready: 'typeof window.__evCloudMode === "function"',
            hide: ['nav', '#hud', '#loc-panel', '#layer-panel', '#info-panel', '#sat-status', '#verdict-host',
                   '#models-panel-host', '#probability-picker-host', '#renewables-panel-host', '#ct-readouts'],
            settleMs: 10000,
            clipMs: 7000,
        },
    },
    {
        id: 'tiga',
        title: 'The geodynamo’s fingerprint',
        caption: 'IGRF core field continued down to the core-mantle boundary, and the Bayesian estimator that tracks the ring current from it.',
        href: 'tiga.html',
        accent: '#b765ff',
        capture: {
            url: '/tiga.html',
            crop: '#tg-stage',
            ready: '!!document.querySelector("#tg-stage canvas")',
            hide: ['nav'],
            settleMs: 9000,
            clipMs: 7000,
        },
    },
    {
        id: 'pollution',
        title: 'Pollution Lab',
        caption: 'PM2.5 interpolated across ~105 cities, hotspots clustered, plumes advected by the wind field — a week back and a week ahead.',
        href: 'pollution.html',
        accent: '#ffd23f',
        capture: {
            url: '/pollution.html',
            crop: '#pl-map',
            ready: '!!document.querySelector("#pl-map")',
            hide: ['nav'],
            settleMs: 9000,
            clipMs: 7000,
        },
    },
]);

/** Every slide in display order: the live one first, then the captures. */
export const SLIDES = Object.freeze([LIVE_SLIDE, ...CAPTURED_SLIDES]);
