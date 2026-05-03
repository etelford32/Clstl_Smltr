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

        // ── 60-minute timeline buffers (1 Hz sampling) ───────────────────────
        // Circular buffers of 3600 entries — at 1 Hz that's exactly 60 minutes
        // of viewing-time history.  We sample once per viewing-second (driven
        // off performance.now), independent of the 4 Hz HUD tick rate, so the
        // timeline looks smooth regardless of how the user interacts.
        const TL_N = 3600;
        this._tl = {
            N:           TL_N,
            // count: number of valid samples written so far (capped at N)
            count:       0,
            // head: index where the *next* sample will land (oldest→newest order
            // when (head − count + N) % N → … → (head − 1 + N) % N)
            head:        0,
            t:           new Float32Array(TL_N),
            storm:       new Float32Array(TL_N),
            trapped:     new Float32Array(TL_N),
            bz:          new Float32Array(TL_N),
            kp:          new Float32Array(TL_N),
        };
        this._lastSampleT = 0;
        this._tlDirty     = true;

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
                <div class="hud-row" title="Sub-Earth Carrington longitude L₀ (decreases ≈13.2°/day) and current Carrington Rotation Number">
                    <span class="hud-k">L<sub>0</sub> · CR</span>
                    <span id="hud-l0" class="hud-v">—</span>
                </div>
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
                <div class="hud-row hud-emic" id="hud-emic-row">
                    <span class="hud-k">EMIC</span>
                    <span id="hud-emic-status" class="hud-v hud-emic-status">— quiet —</span>
                </div>
                <div class="hud-row hud-emic-counts hud-cumulative" id="hud-emic-counts-row">
                    <span class="hud-tiny" style="color:#445">H⁺</span>
                    <span id="hud-emic-ions"      class="hud-v hud-tiny">0</span>
                    <span class="hud-tiny" style="color:#445">·</span>
                    <span class="hud-tiny" style="color:#445">e⁻ ≥ 2 MeV</span>
                    <span id="hud-emic-electrons" class="hud-v hud-tiny">0</span>
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

            <div class="hud-block hud-noaa-flares">
                <div class="hud-section-title" title="NOAA-reported flares — drives EUV emission boost on the matching AR (decay τ = 1.5 h)">NOAA flares · last 6 h</div>
                <div id="hud-flare-list" class="hud-eruption-list">
                    <div class="hud-empty">— quiet —</div>
                </div>
            </div>

            <div class="hud-block hud-perf" id="hud-perf">
                <div class="hud-section-title" title="Per-section frame-time profiler — informs optimisation priorities">Performance</div>
                <div class="hud-row"><span class="hud-k">fps</span><span id="hud-fps" class="hud-v">—</span></div>
                <div class="hud-row"><span class="hud-k">frame</span><span id="hud-frame-ms" class="hud-v">—</span></div>
                <div class="hud-row"><span class="hud-k">draws · tris</span><span id="hud-draws" class="hud-v">—</span></div>
                <div id="hud-perf-sections" class="hud-perf-sections"></div>
            </div>

            <div class="hud-block hud-timeline">
                <div class="hud-section-title">Last 60 min</div>
                <canvas id="hud-tl-canvas" class="hud-tl-canvas"
                    width="512" height="140"
                    aria-label="Timeline of storm index, trapped fraction, Kp, and Bz over the last 60 minutes"></canvas>
                <div class="hud-tl-legend">
                    <span class="hud-tl-chip" style="--hud-tl-c:#ff4830">storm</span>
                    <span class="hud-tl-chip" style="--hud-tl-c:#5fd0ff">trapped</span>
                    <span class="hud-tl-chip" style="--hud-tl-c:#ffc060">Kp</span>
                    <span class="hud-tl-chip" style="--hud-tl-c:#fff">Bz</span>
                </div>
                <div class="hud-tl-axis">
                    <span>−60 m</span><span>−45</span><span>−30</span><span>−15</span><span>now</span>
                </div>
            </div>
        `;

        // Cache element references for the tick path (avoid repeated lookups)
        this._el = {
            tc:           this._root.querySelector('#hud-tc'),
            vsw:          this._root.querySelector('#hud-vsw'),
            transit:      this._root.querySelector('#hud-transit'),
            l0:           this._root.querySelector('#hud-l0'),
            flareList:    this._root.querySelector('#hud-flare-list'),
            fps:          this._root.querySelector('#hud-fps'),
            frameMs:      this._root.querySelector('#hud-frame-ms'),
            draws:        this._root.querySelector('#hud-draws'),
            perfSections: this._root.querySelector('#hud-perf-sections'),
            stormBar:     this._root.querySelector('#hud-storm-bar'),
            stormVal:     this._root.querySelector('#hud-storm-val'),
            trapped:      this._root.querySelector('#hud-trapped'),
            trappedBar:   this._root.querySelector('#hud-trapped-bar'),
            lossRate:     this._root.querySelector('#hud-loss-rate'),
            respawnRate:  this._root.querySelector('#hud-respawn-rate'),
            lossTotal:    this._root.querySelector('#hud-loss-total'),
            respawnTotal: this._root.querySelector('#hud-respawn-total'),
            emicRow:      this._root.querySelector('#hud-emic-row'),
            emicStatus:   this._root.querySelector('#hud-emic-status'),
            emicIons:     this._root.querySelector('#hud-emic-ions'),
            emicElectrons: this._root.querySelector('#hud-emic-electrons'),
            twistList:    this._root.querySelector('#hud-twist-list'),
            eruptList:    this._root.querySelector('#hud-eruption-list'),
            tlCanvas:     this._root.querySelector('#hud-tl-canvas'),
        };

        // Resize the timeline canvas backing buffer for crisp lines on HiDPI
        // displays.  CSS sets the displayed size; we set the pixel buffer to
        // dpr × CSS size and store the dpr scale so the draw routine can
        // compensate.
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const c   = this._el.tlCanvas;
        if (c) {
            const cssW = c.clientWidth  || 256;
            const cssH = c.clientHeight || 70;
            c.width  = Math.round(cssW * dpr);
            c.height = Math.round(cssH * dpr);
            this._tlDpr  = dpr;
            this._tlCssW = cssW;
            this._tlCssH = cssH;
        }
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

        // Carrington bookkeeping: L₀ ticks down ~13.2°/day, CR# climbs by 1
        // every 27.27 d.  Useful as a sanity check when comparing the
        // synthetic disk against the SDO 193 Å reference panel — features
        // at the same Carrington longitude should appear at the same
        // apparent disk position whether you're looking at our render or
        // SDO's image at any given instant.
        const L0 = g.subEarthCarrington ?? 0;
        const CR = g.carringtonRotation ?? 0;
        if (e.l0) e.l0.textContent = `${L0.toFixed(1)}° · CR ${CR.toFixed(0)}`;

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

        // EMIC channel indicator: shows quiet, then "active" once storm
        // index passes the activation threshold.  Pops to "+ O⁺" during
        // exceptional storms (stormIdx > 0.85) when ionospheric oxygen
        // outflow boosts the resonant rate.  Two counts are surfaced:
        //   • H⁺  — ions scattered out via standard ion-cyclotron resonance
        //   • e⁻ ≥ 2 MeV — relativistic electrons via *anomalous* resonance
        //     (the canonical "EMIC dropout" of Van Allen Probes data — the
        //     bright high-energy outer-belt electrons selectively vanish).
        const emicActive = !!g.beltEmicActive;
        const emicOplus  = !!g.beltEmicOplusBoost;
        const emicIons   = g.beltEmicIonLossEvents      ?? 0;
        const emicEl     = g.beltEmicElectronLossEvents ?? 0;
        if (emicActive) {
            e.emicStatus.textContent = emicOplus ? 'active + O⁺' : 'active';
            e.emicRow.classList.add('hud-emic-on');
            e.emicRow.classList.toggle('hud-emic-oplus', emicOplus);
        } else {
            e.emicStatus.textContent = '— quiet —';
            e.emicRow.classList.remove('hud-emic-on', 'hud-emic-oplus');
        }
        e.emicIons     .textContent = emicIons.toLocaleString();
        e.emicElectrons.textContent = emicEl  .toLocaleString();

        // ── AR flux-rope twist list ─────────────────────────────────────────
        const arState = g.arTwistState ?? [];
        this._renderTwistList(arState);

        // ── Internal eruption ticker ────────────────────────────────────────
        const eruptions = g.internalEruptions ?? [];
        this._renderEruptionList(eruptions);

        // ── NOAA flare ticker (drives EUV emission boost on matching AR) ──
        const flares = g.recentFlares ?? [];
        this._renderNoaaFlareList(flares);

        // ── Performance snapshot (top-N hot sections, fps, draws/tris) ─────
        if (g.profiler && e.fps) {
            const snap = g.profiler.snapshot();
            const fps = snap.fps || 0;
            e.fps.textContent = fps > 0 ? fps.toFixed(0) : '—';
            // Hue-shift fps so dropouts are obvious at a glance
            //   60 fps → green (120°), 30 fps → yellow (60°), 15 fps → red (0°)
            const hue = Math.max(0, Math.min(120, fps * 2));
            e.fps.style.color = `hsl(${hue}, 80%, 60%)`;
            const frame = snap.sections.find(s => s.name === 'frame');
            e.frameMs.textContent = frame ? `${frame.ema.toFixed(1)} ms` : '—';
            if (snap.renderer) {
                const r = snap.renderer;
                e.draws.textContent = `${r.calls ?? 0} · ${(r.triangles ?? 0).toLocaleString()}`;
            }
            // Render top hot sections (excluding 'frame' which is the total)
            const top = snap.sections
                .filter(s => s.name !== 'frame')
                .slice(0, 6);
            if (e.perfSections) {
                e.perfSections.innerHTML = top.map(s => {
                    const pct = frame && frame.ema > 0
                        ? ((s.ema / frame.ema) * 100).toFixed(0)
                        : '–';
                    const pctW = Math.max(2, Math.min(100, pct === '–' ? 0 : Number(pct)));
                    return `
                        <div class="hud-perf-row">
                            <span class="hud-perf-name">${s.name}</span>
                            <div class="hud-bar hud-perf-bar">
                                <div class="hud-bar-fill" style="width:${pctW}%; background:hsl(${30 + (100 - pctW) * 0.8}, 70%, 55%)"></div>
                            </div>
                            <span class="hud-perf-ms">${s.ema.toFixed(2)} ms</span>
                        </div>
                    `;
                }).join('');
            }
        }

        // ── 60-minute timeline ──────────────────────────────────────────────
        // Sample at 1 Hz regardless of HUD tick rate so the trace doesn't
        // alias with the 4 Hz update; redraw the canvas every time we add a
        // sample (fresh pixels at 1 Hz is enough for human perception).
        if (t - this._lastSampleT >= 1.0) {
            this._sampleTimeline(t, storm, trapped, total, g.lastBz ?? 0, g.lastKp ?? 2);
            this._renderTimeline();
            this._lastSampleT = t;
        }
    }

    /**
     * Push one row of telemetry into the circular timeline buffer.
     */
    _sampleTimeline(t, stormIdx, trapped, total, bz, kp) {
        const tl = this._tl;
        const i  = tl.head;
        tl.t      [i] = t;
        tl.storm  [i] = stormIdx;
        tl.trapped[i] = total > 0 ? trapped / total : 0;
        tl.bz     [i] = bz;
        tl.kp     [i] = kp;
        tl.head  = (i + 1) % tl.N;
        tl.count = Math.min(tl.N, tl.count + 1);
    }

    /**
     * Redraw the timeline strip.  Iterates the buffer in chronological order
     * (oldest → newest), maps each sample's age in seconds onto an x-pixel
     * (60 min wide), and stitches a polyline per trace.
     *
     * Coordinate system: 0 px = "−60 min ago", w = "now".  Each trace has its
     * own y-mapping (storm 0–1 across full height, Kp 0–9, Bz centred at the
     * mid-line with ±30 nT range, trapped 0–1 across full height).
     */
    _renderTimeline() {
        const c = this._el.tlCanvas;
        if (!c) return;
        const ctx = c.getContext('2d');
        const dpr = this._tlDpr || 1;
        const w   = (this._tlCssW || c.width  / dpr);
        const h   = (this._tlCssH || c.height / dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Background + grid
        ctx.fillStyle = 'rgba(0, 4, 12, 0.92)';
        ctx.fillRect(0, 0, w, h);

        ctx.strokeStyle = 'rgba(255, 192, 96, 0.10)';
        ctx.lineWidth = 1;
        // 4 vertical 15-min ticks
        for (let k = 1; k < 4; k++) {
            const x = (k / 4) * w + 0.5;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
        // Bz mid-line (Bz = 0)
        const bzMid = h * 0.5;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.beginPath(); ctx.moveTo(0, bzMid); ctx.lineTo(w, bzMid); ctx.stroke();

        const tl  = this._tl;
        if (tl.count < 2) {
            ctx.fillStyle = 'rgba(120, 132, 142, .55)';
            ctx.font = '10px ui-sans-serif, system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('— accumulating samples —', w/2, h/2 + 4);
            return;
        }

        const tNow      = tl.t[(tl.head - 1 + tl.N) % tl.N];
        const oldestIdx = (tl.head - tl.count + tl.N) % tl.N;
        const WINDOW_S  = 3600;

        // Helper: draw one trace as a polyline through all samples currently
        // within the 60-minute window.
        const drawTrace = (yMap, color, lineWidth = 1.5) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.beginPath();
            let first = true;
            for (let k = 0; k < tl.count; k++) {
                const i  = (oldestIdx + k) % tl.N;
                const ageS = tNow - tl.t[i];
                if (ageS > WINDOW_S || ageS < 0) continue;
                const x  = w * (1 - ageS / WINDOW_S);
                const y  = yMap(i);
                if (first) { ctx.moveTo(x, y); first = false; }
                else       { ctx.lineTo(x, y); }
            }
            ctx.stroke();
        };

        // Trapped fraction (cyan) — under everything else for layering
        drawTrace(i => h - 4 - tl.trapped[i] * (h - 8),
                  'rgba(95, 208, 255, 0.85)');

        // Kp (gold) — 0..9 mapped across full height
        drawTrace(i => h - 4 - (Math.max(0, Math.min(9, tl.kp[i])) / 9) * (h - 8),
                  'rgba(255, 200, 96, 0.85)');

        // Bz (white) — centred at mid-line, ±30 nT range
        const bzScale = (h * 0.45);
        drawTrace(i => bzMid - Math.max(-30, Math.min(30, tl.bz[i])) / 30 * bzScale,
                  'rgba(255, 255, 255, 0.80)');

        // Storm index (red) — drawn last so the storm signal is on top
        drawTrace(i => h - 4 - tl.storm[i] * (h - 8),
                  'rgba(255, 72, 48, 0.95)', 1.8);

        // Right-edge "now" highlighting tick
        ctx.strokeStyle = 'rgba(255, 192, 96, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(w - 0.5, 0); ctx.lineTo(w - 0.5, h); ctx.stroke();
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

    /**
     * NOAA-flare ticker — parallel to internal eruptions but for *real*
     * GOES-reported flares from the swpc-feed.  Each row shows the class,
     * affected AR, time-since-peak, and a small bar reflecting the live
     * EUV-boost amplitude that the flare is contributing to the synthetic
     * corona emission.  This makes the synth-vs-SDO link obvious — when
     * NOAA reports an X-class flare on AR 13800, the same AR brightens in
     * the rendered corona at the same moment.
     */
    _renderNoaaFlareList(flares) {
        const list = this._el.flareList;
        if (!list) return;
        if (!flares || flares.length === 0) {
            if (!list.querySelector('.hud-empty')) {
                list.innerHTML = '<div class="hud-empty">— quiet —</div>';
            }
            return;
        }
        const top = flares.slice(0, 6);
        list.innerHTML = top.map(f => {
            const cls    = String(f.cls ?? '?');
            const letter = cls.charAt(0).toUpperCase();
            const dt_hr  = f.dt_hr ?? 0;
            const ageStr = dt_hr < 1
                ? `${(dt_hr * 60).toFixed(0)}m ago`
                : `${dt_hr.toFixed(1)}h ago`;
            const boostPct = Math.round((f.boost ?? 0) * 100);
            return `
                <div class="hud-erupt-row hud-noaa-flare-row">
                    <span class="hud-erupt-cls cls-${letter}">${cls}</span>
                    <span class="hud-erupt-ar">AR${f.region}</span>
                    <span class="hud-erupt-spd">+${boostPct}%</span>
                    <span class="hud-erupt-age">${ageStr}</span>
                </div>
            `;
        }).join('');
    }
}
