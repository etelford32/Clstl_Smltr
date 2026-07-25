/**
 * hero-live-hud.js — live space-weather readout chips inside the landing hero.
 *
 * The hero canvas is the spectacle; this strip is the PROOF — the actual
 * numbers driving the scene, updating on every 'swpc-update'. Chips: Kp,
 * solar-wind speed, IMF Bz, density, Shue magnetopause standoff, X-ray class,
 * a storm-status chip, and a CME-arrival chip that appears only when NASA
 * DONKI carries an Earth-directed CME with an ETA.
 *
 * Contract (same as js/home-ticker.js): this module does NOT own a data feed.
 * It only listens to the window 'swpc-update' event; the host page must start
 * exactly ONE SpaceWeatherFeed AFTER calling initHeroLiveHud so the listener
 * is attached before the first dispatch.
 *
 * buildHudModel() is pure (no DOM, no fetch, no ambient time) and unit-tested
 * by tests/hero-live-hud.mjs — keep it that way.
 *
 * The Shue standoff here MIRRORS computeShue() in js/magnetosphere-engine.js.
 * It is inlined (6 lines of math) so this module stays dependency-free and
 * node-testable without a three.js resolver — change the two together.
 */

const STYLE_ID = 'hero-live-hud-styles';

// Same 10-step Kp ramp as the dashboard's Kp gauge and js/home-ticker.js so
// "how bad is it" reads identically across surfaces.
const KP_COLORS = [
    '#00e676', '#69f0ae', '#b2ff59', '#fff176',
    '#ffa726', '#ff7043', '#ef5350', '#e040fb', '#aa00ff', '#7c00ff',
];

const STORM_LABELS = ['', 'G1 · Minor storm', 'G2 · Moderate storm',
    'G3 · Strong storm', 'G4 · Severe storm', 'G5 · Extreme storm'];

/**
 * Subsolar magnetopause standoff (Earth radii) — Shue et al. (1998).
 * MIRRORS computeShue() in js/magnetosphere-engine.js; change together.
 */
export function shueStandoffRe(n = 5, v = 400, bz = 0) {
    const pdyn = Math.max(0.05, 1.67e-6 * n * v * v);
    return Math.max(3.5,
        (10.22 + 1.29 * Math.tanh(0.184 * (bz + 8.14))) * Math.pow(pdyn, -1 / 6.6));
}

const _num = (v) => (Number.isFinite(v) ? v : null);

/**
 * Pure view-model builder: swpc-update detail → chip contents.
 * Every field degrades to '—' so a partial feed never crashes the strip.
 */
export function buildHudModel(state = {}) {
    const sw      = state.solar_wind ?? {};
    const kp      = _num(state.kp);
    const speed   = _num(sw.speed);
    const density = _num(sw.density);
    const bz      = _num(sw.bz);
    const level   = state.derived?.storm_level ??
        (kp == null ? 0 : kp >= 9 ? 5 : kp >= 8 ? 4 : kp >= 7 ? 3 : kp >= 6 ? 2 : kp >= 5 ? 1 : 0);

    // Storm status: NOAA G-scale when storming, Kp language below it.
    let status;
    if (level >= 1) {
        status = { label: STORM_LABELS[Math.min(5, level)], tone: level >= 3 ? 'severe' : 'storm' };
    } else if (kp != null && kp >= 4) {
        status = { label: 'Active', tone: 'active' };
    } else if (kp != null && kp >= 3) {
        status = { label: 'Unsettled', tone: 'active' };
    } else {
        status = { label: 'Quiet', tone: 'quiet' };
    }

    const standoff = (speed != null && density != null)
        ? shueStandoffRe(density, speed, bz ?? 0) : null;

    const xrayCls = state.flare_class || state.xray_class || null;

    const eta = _num(state.cme_eta_hours);
    const cme = (state.earth_directed_cme && eta != null && eta > 0)
        ? { text: `~${Math.round(eta)} h`, urgent: eta < 36 }
        : null;

    return {
        kp: {
            text:  kp == null ? '—' : kp.toFixed(1),
            color: kp == null ? null : KP_COLORS[Math.max(0, Math.min(9, Math.floor(kp)))],
        },
        wind:    { text: speed   == null ? '—' : String(Math.round(speed)) },
        bz: {
            text:  bz == null ? '—' : (bz > 0 ? '+' : '') + bz.toFixed(1),
            color: bz == null ? null : (bz < -5 ? '#ff3050' : bz < 0 ? '#ff8fb8' : '#8ff0ff'),
        },
        density: { text: density == null ? '—' : density.toFixed(1) },
        standoff:{ text: standoff == null ? '—' : standoff.toFixed(1) },
        xray: {
            text: xrayCls ?? '—',
            hot:  !!xrayCls && /^[MX]/.test(xrayCls),
        },
        status,
        cme,
    };
}

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
[data-hero-hud]{display:flex;flex-direction:column;gap:10px;align-items:center}
[data-hero-hud] .hlh-caption{font-family:var(--font-display,'Orbitron',sans-serif);
  font-size:.62rem;letter-spacing:.22em;text-transform:uppercase;color:var(--fg-4,#6f6695)}
[data-hero-hud] .hlh-caption b{color:var(--uv-300,#d29aff);font-weight:700}
[data-hero-hud] .hlh-row{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
[data-hero-hud] .hlh-chip[hidden]{display:none}
[data-hero-hud] .hlh-chip{display:inline-flex;align-items:baseline;gap:7px;
  padding:8px 14px;border-radius:10px;background:rgba(7,2,26,.55);
  border:1px solid rgba(154,133,255,.20);backdrop-filter:blur(8px);
  font-family:var(--font-mono,'JetBrains Mono',ui-monospace,monospace);
  transition:border-color .4s ease,box-shadow .4s ease}
[data-hero-hud] .hlh-chip .hlh-l{font-size:.58rem;letter-spacing:.14em;
  text-transform:uppercase;color:var(--fg-4,#6f6695)}
[data-hero-hud] .hlh-chip .hlh-v{font-size:.95rem;font-weight:600;
  color:var(--fg-1,#f5f0ff);font-variant-numeric:tabular-nums}
[data-hero-hud] .hlh-chip .hlh-u{font-size:.6rem;color:var(--fg-5,#48426e)}
[data-hero-hud] .hlh-chip.hlh-flash .hlh-v{animation:hlh-flash .7s ease}
@keyframes hlh-flash{0%{text-shadow:0 0 14px currentColor}100%{text-shadow:none}}
[data-hero-hud] .hlh-status{border-color:rgba(46,255,158,.35)}
[data-hero-hud] .hlh-status .hlh-v{font-family:var(--font-display,'Orbitron',sans-serif);
  font-size:.72rem;letter-spacing:.1em;text-transform:uppercase}
[data-hero-hud] .hlh-status::before{content:'';width:7px;height:7px;border-radius:50%;
  align-self:center;background:var(--status-ok,#2eff9e);
  box-shadow:0 0 8px var(--status-ok,#2eff9e);animation:hlh-pulse 1.8s ease-in-out infinite}
[data-hero-hud] .hlh-status[data-tone="active"]{border-color:rgba(255,210,63,.4)}
[data-hero-hud] .hlh-status[data-tone="active"]::before{background:var(--status-warn,#ffd23f);
  box-shadow:0 0 8px var(--status-warn,#ffd23f)}
[data-hero-hud] .hlh-status[data-tone="storm"],
[data-hero-hud] .hlh-status[data-tone="severe"]{border-color:rgba(255,48,80,.5)}
[data-hero-hud] .hlh-status[data-tone="storm"]::before,
[data-hero-hud] .hlh-status[data-tone="severe"]::before{background:var(--status-danger,#ff3050);
  box-shadow:0 0 8px var(--status-danger,#ff3050);animation-duration:.9s}
[data-hero-hud] .hlh-status[data-tone="storm"] .hlh-v,
[data-hero-hud] .hlh-status[data-tone="severe"] .hlh-v{color:var(--status-danger,#ff3050)}
[data-hero-hud] .hlh-cme{border-color:rgba(255,140,0,.5)}
[data-hero-hud] .hlh-cme .hlh-l,[data-hero-hud] .hlh-cme .hlh-v{color:#ffb347}
[data-hero-hud] .hlh-cme[data-urgent="1"]{animation:hlh-urgent 1.4s ease-in-out infinite}
@keyframes hlh-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes hlh-urgent{0%,100%{box-shadow:0 0 0 rgba(255,140,0,0)}50%{box-shadow:0 0 18px rgba(255,140,0,.45)}}
@media(max-width:640px){
  [data-hero-hud] .hlh-row{gap:6px}
  [data-hero-hud] .hlh-chip{padding:6px 10px}
  [data-hero-hud] .hlh-chip .hlh-v{font-size:.85rem}
  [data-hero-hud] .hlh-hide-sm{display:none}
}`;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
}

export function initHeroLiveHud(el) {
    if (!el) return;
    ensureStyles();

    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Live space weather readout');
    el.innerHTML = `
      <div class="hlh-caption">Live readout — <b>this is the data driving the scene</b></div>
      <div class="hlh-row">
        <span class="hlh-chip hlh-status" data-hlh-chip="status"><span class="hlh-v" data-hlh="status">connecting…</span></span>
        <span class="hlh-chip" data-hlh-chip="kp"><span class="hlh-l">Kp</span><span class="hlh-v" data-hlh="kp">—</span></span>
        <span class="hlh-chip" data-hlh-chip="wind"><span class="hlh-l">Wind</span><span class="hlh-v" data-hlh="wind">—</span><span class="hlh-u">km/s</span></span>
        <span class="hlh-chip" data-hlh-chip="bz"><span class="hlh-l">IMF Bz</span><span class="hlh-v" data-hlh="bz">—</span><span class="hlh-u">nT</span></span>
        <span class="hlh-chip hlh-hide-sm" data-hlh-chip="density"><span class="hlh-l">Density</span><span class="hlh-v" data-hlh="density">—</span><span class="hlh-u">p/cm³</span></span>
        <span class="hlh-chip" data-hlh-chip="standoff" title="Subsolar magnetopause standoff — Shue et al. (1998), computed from the live wind"><span class="hlh-l">Shield edge</span><span class="hlh-v" data-hlh="standoff">—</span><span class="hlh-u">R⊕</span></span>
        <span class="hlh-chip hlh-hide-sm" data-hlh-chip="xray"><span class="hlh-l">X-ray</span><span class="hlh-v" data-hlh="xray">—</span></span>
        <span class="hlh-chip hlh-cme" data-hlh-chip="cme" hidden><span class="hlh-l">CME arrival</span><span class="hlh-v" data-hlh="cme">—</span></span>
      </div>`;

    const chip = (k) => el.querySelector(`[data-hlh-chip="${k}"]`);
    const val  = (k) => el.querySelector(`[data-hlh="${k}"]`);

    const setChip = (key, text, color) => {
        const v = val(key);
        if (!v || text == null) return;
        if (v.textContent !== text) {
            v.textContent = text;
            const c = chip(key);
            c.classList.remove('hlh-flash');
            void c.offsetWidth;   // restart the flash animation
            c.classList.add('hlh-flash');
        }
        if (color !== undefined) v.style.color = color ?? '';
    };

    window.addEventListener('swpc-update', (e) => {
        const m = buildHudModel(e.detail || {});
        setChip('status',  m.status.label);
        chip('status').dataset.tone = m.status.tone;
        setChip('kp',      m.kp.text,   m.kp.color);
        setChip('wind',    m.wind.text);
        setChip('bz',      m.bz.text,   m.bz.color);
        setChip('density', m.density.text);
        setChip('standoff',m.standoff.text);
        setChip('xray',    m.xray.text, m.xray.hot ? 'var(--status-warn,#ffd23f)' : null);
        const cmeChip = chip('cme');
        cmeChip.hidden = !m.cme;
        if (m.cme) {
            setChip('cme', m.cme.text);
            cmeChip.dataset.urgent = m.cme.urgent ? '1' : '0';
        }
    }, { passive: true });
}
