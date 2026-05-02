/**
 * space-weather-hud.js — Glass-pane diagnostic overlay for the 3D globe
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Subscribes to the SpaceWeatherGlobe and surfaces its internal physics state
 * — twist accumulators, internal kink eruptions, μ-conserving Van Allen
 * tracer counts, storm index, transit time — at a throttled 4 Hz so the
 * heavy 60 fps render loop is unaffected.
 *
 * The HUD reads-only.  All physics still drives off the live `swpc-update`
 * event bus → SpaceWeatherGlobe.update(); this class is a presentation layer.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { SpaceWeatherHud } from './space-weather-hud.js';
 *   const hud = new SpaceWeatherHud(document.getElementById('sw-hud'), globe);
 *   hud.start();   // begins the 4 Hz refresh; safe to call after globe.start()
 *   hud.stop();    // tear down (e.g. on SPA navigation)
 *
 * ── Data sources (read each tick) ────────────────────────────────────────────
 *   globe.timeCompression          — viewing-time compression factor
 *   globe.currentWindSpeedKms      — last v_sw from swpc-update
 *   globe.transitTimeReal()        — Sun→Earth transit at current v_sw (s)
 *   globe.arTwistState             — [{ arId, phi, phiPi, kinkRatio, cls, areaNorm }]
 *   globe.internalEruptions        — ring buffer of recent internal kink events
 *   globe.beltStormIndex           — 0..1 storm-driven diffusion drive
 *   globe.beltTrappedCount         — currently-visible Van Allen tracers
 *   globe.beltTotalCount           — total population (denominator)
 *   globe.beltLossEvents           — cumulative precipitations
 *   globe.beltRespawnEvents        — cumulative injections
 */

const REFRESH_HZ        = 4;
const REFRESH_INTERVAL  = 1000 / REFRESH_HZ;

// 5-second rolling rate window for loss / respawn counters
const RATE_WINDOW_S     = 5;

export class SpaceWeatherHud {
    /**
     * @param {HTMLElement} rootEl  pre-existing container element to populate
     * @param {object}      globe   SpaceWeatherGlobe instance
     */
    constructor(rootEl, globe) {
        this._root  = rootEl;
        this._globe = globe;
        this._timer = null;

        // Rolling-rate bookkeeping
        this._lastLoss    = 0;
        this._lastRespawn = 0;
        this._lossWindow  = [];   // [{t, count}] within last RATE_WINDOW_S
        this._respawnWindow = [];

        // Last seen eruption count (so we only animate "new" entries)
        this._lastEruptionId = null;

        this._render();          // initial scaffold
    }

    start() {
        if (this._timer) return this;
        this._tick = this._tick.bind(this);
        this._timer = setInterval(this._tick, REFRESH_INTERVAL);
        // Drive an immediate first tick so the HUD doesn't show "—" for 250 ms
        try { this._tick(); } catch (e) { /* ignore — will retry on next interval */ }
        return this;
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    // ── Initial DOM scaffold ─────────────────────────────────────────────────

    _render() {
        this._root.innerHTML = `
            <div class="hud-block hud-system">
                <div class="hud-section-title">System</div>
                <div class="hud-row"><span class="hud-k">time × </span><span id="hud-tc" class="hud-v">—</span></div>
                <div class="hud-row"><span class="hud-k">v<sub>sw</sub></span><span id="hud-vsw" class="hud-v">—</span></div>
                <div class="hud-row"><span class="hud-k">transit</span><span id="hud-transit" class="hud-v">—</span></div>
                <div class="hud-row hud-storm">
                    <span class="hud-k">storm idx</span>
                    <div class="hud-bar"><div class="hud-bar-fill" id="hud-storm-bar"></div></div>
                    <span id="hud-storm-val" class="hud-v">—</span>
                </div>
            </div>

            <div class="hud-block hud-belts">
                <div class="hud-section-title">μ-conserving tracers</div>
                <div class="hud-row"><span class="hud-k">trapped</span><span id="hud-trapped" class="hud-v">—</span></div>
                <div class="hud-row hud-trapped-bar-row">
                    <div class="hud-bar"><div class="hud-bar-fill" id="hud-trapped-bar"></div></div>
                </div>
                <div class="hud-row"><span class="hud-k">loss / s</span><span id="hud-loss-rate" class="hud-v">0.0</span></div>
                <div class="hud-row"><span class="hud-k">refill / s</span><span id="hud-respawn-rate" class="hud-v">0.0</span></div>
                <div class="hud-row hud-cumulative">
                    <span id="hud-loss-total" class="hud-v hud-tiny">0</span>
                    <span class="hud-tiny" style="color:#445">precip · refill</span>
                    <span id="hud-respawn-total" class="hud-v hud-tiny">0</span>
                </div>
            </div>

            <div class="hud-block hud-twist">
                <div class="hud-section-title">AR flux-rope twist (Φ / Φ<sub>kink</sub>)</div>
                <div id="hud-twist-list" class="hud-twist-list"></div>
            </div>

            <div class="hud-block hud-eruptions">
                <div class="hud-section-title">Internal kink eruptions</div>
                <div id="hud-eruption-list" class="hud-eruption-list">
                    <div class="hud-empty">— none yet —</div>
                </div>
            </div>
        `;

        // Cache element references for the tick path (avoid repeated lookups)
        this._el = {
            tc:           this._root.querySelector('#hud-tc'),
            vsw:          this._root.querySelector('#hud-vsw'),
            transit:      this._root.querySelector('#hud-transit'),
            stormBar:     this._root.querySelector('#hud-storm-bar'),
            stormVal:     this._root.querySelector('#hud-storm-val'),
            trapped:      this._root.querySelector('#hud-trapped'),
            trappedBar:   this._root.querySelector('#hud-trapped-bar'),
            lossRate:     this._root.querySelector('#hud-loss-rate'),
            respawnRate:  this._root.querySelector('#hud-respawn-rate'),
            lossTotal:    this._root.querySelector('#hud-loss-total'),
            respawnTotal: this._root.querySelector('#hud-respawn-total'),
            twistList:    this._root.querySelector('#hud-twist-list'),
            eruptList:    this._root.querySelector('#hud-eruption-list'),
        };
    }

    // ── Per-tick refresh (4 Hz) ──────────────────────────────────────────────

    _tick() {
        const g  = this._globe;
        const e  = this._el;
        const t  = performance.now() / 1000;

        // ── System block ────────────────────────────────────────────────────
        const tc = g.timeCompression ?? 0;
        e.tc.textContent = tc >= 1000 ? `${(tc/1000).toFixed(1)}k` : tc.toFixed(0);

        const vsw = g.currentWindSpeedKms ?? 400;
        e.vsw.textContent = `${Math.round(vsw)} km/s`;

        const transitS = g.transitTimeReal ? g.transitTimeReal() : null;
        e.transit.textContent = transitS != null
            ? `${(transitS / 86400).toFixed(2)} d`
            : '—';

        const storm = g.beltStormIndex ?? 0;
        const stormPct = Math.min(100, storm * 100);
        e.stormBar.style.width = `${stormPct.toFixed(1)}%`;
        e.stormVal.textContent = storm.toFixed(2);
        // Hue shift: green (calm) → orange (moderate) → red (extreme)
        e.stormBar.style.background = `hsl(${(120 - storm * 120).toFixed(0)}, 90%, 55%)`;

        // ── Van Allen tracer block ──────────────────────────────────────────
        const trapped = g.beltTrappedCount ?? 0;
        const total   = g.beltTotalCount ?? 0;
        e.trapped.textContent = `${trapped} / ${total}`;
        const trappedPct = total > 0 ? (trapped / total) * 100 : 0;
        e.trappedBar.style.width = `${trappedPct.toFixed(1)}%`;
        // Belt fill drops during storms — colour the bar by trapped fraction
        e.trappedBar.style.background = `hsl(${(trappedPct * 1.4).toFixed(0)}, 70%, 55%)`;

        // Loss / respawn rolling rates
        const lossN    = g.beltLossEvents ?? 0;
        const respawnN = g.beltRespawnEvents ?? 0;
        const lossDelta    = Math.max(0, lossN    - this._lastLoss);
        const respawnDelta = Math.max(0, respawnN - this._lastRespawn);
        this._lastLoss    = lossN;
        this._lastRespawn = respawnN;
        this._lossWindow.push({ t, n: lossDelta });
        this._respawnWindow.push({ t, n: respawnDelta });
        // Drop entries older than RATE_WINDOW_S
        const cutoff = t - RATE_WINDOW_S;
        while (this._lossWindow.length    && this._lossWindow[0].t    < cutoff) this._lossWindow.shift();
        while (this._respawnWindow.length && this._respawnWindow[0].t < cutoff) this._respawnWindow.shift();
        const lossSum    = this._lossWindow   .reduce((s, x) => s + x.n, 0);
        const respawnSum = this._respawnWindow.reduce((s, x) => s + x.n, 0);
        e.lossRate   .textContent = (lossSum    / RATE_WINDOW_S).toFixed(1);
        e.respawnRate.textContent = (respawnSum / RATE_WINDOW_S).toFixed(1);
        e.lossTotal   .textContent = lossN.toLocaleString();
        e.respawnTotal.textContent = respawnN.toLocaleString();

        // ── AR flux-rope twist list ─────────────────────────────────────────
        const arState = g.arTwistState ?? [];
        this._renderTwistList(arState);

        // ── Internal eruption ticker ────────────────────────────────────────
        const eruptions = g.internalEruptions ?? [];
        this._renderEruptionList(eruptions);
    }

    /**
     * Render or update one row per AR — bar fills proportionally to Φ/Φ_crit,
     * colour-coded golden at low twist and red as it approaches the kink
     * threshold (matching the on-globe flux-rope strand colour).
     */
    _renderTwistList(arState) {
        const list = this._el.twistList;
        if (arState.length === 0) {
            list.innerHTML = '<div class="hud-empty">— no active regions tracked —</div>';
            return;
        }

        // Sort by kinkRatio descending (closest-to-eruption first)
        const sorted = arState.slice().sort((a, b) => b.kinkRatio - a.kinkRatio);

        // Reuse / create rows in-place to avoid full innerHTML thrash
        const existing = new Map();
        for (const child of list.children) {
            if (child.dataset?.arid) existing.set(child.dataset.arid, child);
        }

        const seen = new Set();
        for (const ar of sorted) {
            const key = String(ar.arId);
            seen.add(key);
            let row = existing.get(key);
            if (!row) {
                row = document.createElement('div');
                row.className = 'hud-twist-row';
                row.dataset.arid = key;
                row.innerHTML = `
                    <span class="hud-twist-id">AR${key}</span>
                    <span class="hud-twist-cls"></span>
                    <div class="hud-bar hud-twist-bar"><div class="hud-bar-fill"></div></div>
                    <span class="hud-twist-phi"></span>
                `;
                list.appendChild(row);
            }
            const k = Math.min(1.05, ar.kinkRatio);
            const fill = row.querySelector('.hud-bar-fill');
            fill.style.width = `${Math.min(100, k * 100).toFixed(0)}%`;
            // Golden → red as twist climbs (matches flux-rope strand colour)
            const r = 255;
            const g = Math.round(192 * (1 - k) + 72 * k);
            const b = Math.round(96 * (1 - k) + 48 * k);
            fill.style.background = `rgb(${r},${g},${b})`;
            row.querySelector('.hud-twist-cls').textContent = (ar.cls || '').replace('beta', 'β').replace('gamma', 'γ').replace('delta', 'δ');
            row.querySelector('.hud-twist-phi').textContent = `${ar.phiPi.toFixed(2)}π`;
            row.classList.toggle('hud-twist-erupting', ar.kinkRatio >= 1);
        }

        // Drop rows for ARs no longer tracked (rotated off disk / fresh data)
        for (const [key, row] of existing) {
            if (!seen.has(key)) row.remove();
        }
    }

    /**
     * Render the rolling list of recent internal kink eruptions.  Each entry
     * shows AR id, class letter+number, initial speed, Earth-directed flag,
     * and a "X seconds ago" relative timestamp.  The first row is the most
     * recent; we cap at 6 visible rows for screen real-estate.
     */
    _renderEruptionList(eruptions) {
        const list = this._el.eruptList;
        if (!eruptions || eruptions.length === 0) {
            if (!list.querySelector('.hud-empty')) {
                list.innerHTML = '<div class="hud-empty">— none yet —</div>';
            }
            return;
        }

        const now = performance.now() / 1000;

        // Take latest 6 events; remember whether the top item is new so we
        // can flash it briefly via a CSS class.
        const top = eruptions.slice(0, 6);
        const topId = `${top[0].arId}-${top[0].t.toFixed(2)}`;
        const isNew = topId !== this._lastEruptionId;
        this._lastEruptionId = topId;

        list.innerHTML = top.map((ev, i) => {
            const ageS  = Math.max(0, now - ev.t);
            const ageStr = ageS < 60 ? `${ageS.toFixed(0)}s ago`
                         : ageS < 3600 ? `${(ageS/60).toFixed(0)}m ago`
                         : `${(ageS/3600).toFixed(1)}h ago`;
            const dirSym = ev.earthFacing ? '⇒ Earth' : 'limb';
            const dirCls = ev.earthFacing ? 'hud-erupt-earth' : 'hud-erupt-limb';
            const newCls = (i === 0 && isNew) ? ' hud-erupt-new' : '';
            return `
                <div class="hud-erupt-row${newCls}">
                    <span class="hud-erupt-cls cls-${ev.flareLetter}">${ev.flareLetter}${ev.flareNum}</span>
                    <span class="hud-erupt-ar">AR${ev.arId}</span>
                    <span class="hud-erupt-spd">${Math.round(ev.v0)} km/s</span>
                    <span class="${dirCls}">${dirSym}</span>
                    <span class="hud-erupt-age">${ageStr}</span>
                </div>
            `;
        }).join('');
    }
}
