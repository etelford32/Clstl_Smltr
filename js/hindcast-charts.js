/**
 * hindcast-charts.js — generic canvas charts + narration band for
 * hindcast replay pages (pp.hindcast.replay.v1 bundles).
 * ═══════════════════════════════════════════════════════════════════════
 * Event-agnostic peer of js/hindcast-replay-engine.js. The page supplies
 * series keys + colors; everything else (scales, gaps, phases, cursor,
 * click-to-seek, DPR, resize) is handled here.
 *
 *   const chart = createSeriesChart(el, replay, player, {
 *       series: [
 *           { key: 'sym_h_nt', color: '#fc6', width: 2 },
 *           { key: 'ap_real',  color: '#888', staircase: true, axis: 'right' },
 *       ],
 *       yLabel: 'nT', yLabelRight: 'ap',
 *       zeroLine: true,
 *       phaseBands: true,                       // tint bundle phases
 *       markers: [{ h: 34.78, label: '−234 nT' }],
 *       onSeekHours(h) { ... },                 // click/drag on plot
 *   });
 *   chart.setCursor(h);
 *
 * Null series values are rendered as gaps (line breaks) — the bundle is
 * the honesty boundary, charts never interpolate across missing data.
 */

const PHASE_TINTS = {
    quiet:    'rgba(160,160,200,.045)',
    sheath:   'rgba(255,200,80,.055)',
    main:     'rgba(255,90,90,.065)',
    recovery: 'rgba(120,200,255,.05)',
};

const FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

function niceTicks(min, max, n = 5) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    let step = mag;
    for (const m of [1, 2, 2.5, 5, 10]) {
        if (step0 <= m * mag) { step = m * mag; break; }
    }
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v);
    return ticks;
}

export function createSeriesChart(el, replay, player, opts) {
    const {
        series = [], yLabel = '', yLabelRight = '',
        zeroLine = false, phaseBands = false,
        markers = [], onSeekHours = null,
        padTopFrac = 0.06, padBotFrac = 0.06,
    } = opts;

    el.classList.remove('gn-pulse');
    el.innerHTML = '';
    const canvas = document.createElement('canvas');
    el.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const w = replay.window;
    const stepMs = (w.step_minutes || 5) * 60_000;
    const t0Ms = Date.parse(w.start);
    const n = replay.series[series[0].key].length;
    const hoursMax = ((n - 1) * stepMs) / 3600_000;

    // Split series by axis, compute extents.
    function extent(keys) {
        let min = Infinity, max = -Infinity;
        for (const s of keys) {
            for (const v of replay.series[s.key]) {
                if (v == null) continue;
                if (v < min) min = v;
                if (v > max) max = v;
            }
        }
        if (min === Infinity) { min = 0; max = 1; }
        const span = (max - min) || 1;
        return { min: min - span * padBotFrac, max: max + span * padTopFrac };
    }
    const left = series.filter(s => s.axis !== 'right');
    const right = series.filter(s => s.axis === 'right');
    const extL = extent(left);
    const extR = right.length ? extent(right) : null;

    let cursorH = 0;
    let cssW = 0, cssH = 0;
    const M = { l: 46, r: right.length ? 46 : 12, t: 8, b: 22 };

    const xOf = (h) => M.l + (h / hoursMax) * (cssW - M.l - M.r);
    const hOf = (x) => Math.max(0, Math.min(hoursMax, ((x - M.l) / (cssW - M.l - M.r)) * hoursMax));
    const yOf  = (v) => M.t + (1 - (v - extL.min) / (extL.max - extL.min)) * (cssH - M.t - M.b);
    const yOfR = (v) => M.t + (1 - (v - extR.min) / (extR.max - extR.min)) * (cssH - M.t - M.b);

    function draw() {
        const dpr = window.devicePixelRatio || 1;
        cssW = el.clientWidth; cssH = el.clientHeight;
        if (!cssW || !cssH) return;
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.font = FONT;

        // Phase tint bands.
        if (phaseBands && Array.isArray(replay.phases)) {
            let from = 0;
            for (const p of replay.phases) {
                const to = Math.min(hoursMax, p.until_h);
                ctx.fillStyle = PHASE_TINTS[p.id] || 'rgba(255,255,255,.03)';
                ctx.fillRect(xOf(from), M.t, xOf(to) - xOf(from), cssH - M.t - M.b);
                if (to >= hoursMax) break;
                from = to;
            }
        }

        // X grid: one tick every 12 h, label as "Mar 17 12:00".
        ctx.strokeStyle = 'rgba(255,255,255,.07)';
        ctx.fillStyle = '#8a86aa';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (let hh = 0; hh <= hoursMax + 0.001; hh += 12) {
            const x = xOf(hh);
            ctx.beginPath(); ctx.moveTo(x, M.t); ctx.lineTo(x, cssH - M.b); ctx.stroke();
            const d = new Date(t0Ms + hh * 3600_000);
            const lbl = `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
            ctx.fillText(lbl, x, cssH - M.b + 6);
        }

        // Y grid + labels (left).
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        for (const v of niceTicks(extL.min, extL.max)) {
            const y = yOf(v);
            if (y < M.t || y > cssH - M.b) continue;
            ctx.strokeStyle = 'rgba(255,255,255,.06)';
            ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(cssW - M.r, y); ctx.stroke();
            ctx.fillStyle = '#8a86aa';
            ctx.fillText(String(Math.round(v * 100) / 100), M.l - 6, y);
        }
        if (yLabel) {
            ctx.save();
            ctx.translate(11, M.t + 2); ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            ctx.fillStyle = '#9a94c0'; ctx.fillText(yLabel, 0, 0);
            ctx.restore();
        }
        // Right axis labels.
        if (extR) {
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            for (const v of niceTicks(extR.min, extR.max)) {
                const y = yOfR(v);
                if (y < M.t || y > cssH - M.b) continue;
                ctx.fillStyle = '#8a86aa';
                ctx.fillText(String(Math.round(v * 100) / 100), cssW - M.r + 6, y);
            }
            if (yLabelRight) {
                ctx.save();
                ctx.translate(cssW - 8, M.t + 2); ctx.rotate(-Math.PI / 2);
                ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
                ctx.fillStyle = '#9a94c0'; ctx.fillText(yLabelRight, 0, 0);
                ctx.restore();
            }
        }

        // Zero line (left axis) — emphasized when in range.
        if (zeroLine && extL.min < 0 && extL.max > 0) {
            ctx.strokeStyle = 'rgba(255,255,255,.28)';
            ctx.beginPath(); ctx.moveTo(M.l, yOf(0)); ctx.lineTo(cssW - M.r, yOf(0)); ctx.stroke();
        }

        // Series lines. Null values break the path (gap honesty).
        for (const s of series) {
            const arr = replay.series[s.key];
            const y = s.axis === 'right' ? yOfR : yOf;
            ctx.strokeStyle = s.color;
            ctx.lineWidth = s.width || 1.5;
            ctx.setLineDash(s.dash || []);
            ctx.beginPath();
            let pen = false, prevY = null;
            for (let i = 0; i < n; i++) {
                const v = arr[i];
                if (v == null) { pen = false; continue; }
                const px = xOf((i * stepMs) / 3600_000);
                const py = y(v);
                if (!pen) { ctx.moveTo(px, py); pen = true; }
                else if (s.staircase && prevY != null) { ctx.lineTo(px, prevY); ctx.lineTo(px, py); }
                else ctx.lineTo(px, py);
                prevY = py;
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Markers (annotated verticals).
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        for (const m of markers) {
            const x = xOf(m.h);
            ctx.strokeStyle = m.color || 'rgba(255,255,255,.3)';
            ctx.setLineDash([3, 4]);
            ctx.beginPath(); ctx.moveTo(x, M.t); ctx.lineTo(x, cssH - M.b); ctx.stroke();
            ctx.setLineDash([]);
            if (m.label) {
                ctx.fillStyle = m.color || '#aaa6cc';
                ctx.fillText(m.label, x + 4, M.t + 2 + (m.labelDy || 0));
            }
        }

        // Cursor.
        const cx = xOf(cursorH);
        ctx.strokeStyle = 'rgba(255,255,255,.75)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, M.t); ctx.lineTo(cx, cssH - M.b); ctx.stroke();
    }

    // Seek interactions (click + drag).
    if (onSeekHours) {
        let dragging = false;
        const seek = (ev) => {
            const rect = canvas.getBoundingClientRect();
            onSeekHours(hOf(ev.clientX - rect.left));
        };
        canvas.style.cursor = 'crosshair';
        canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); seek(e); });
        canvas.addEventListener('pointermove', (e) => { if (dragging) seek(e); });
        canvas.addEventListener('pointerup',   (e) => { dragging = false; canvas.releasePointerCapture(e.pointerId); });
    }

    const ro = new ResizeObserver(draw);
    ro.observe(el);
    draw();

    return {
        setCursor(h) { cursorH = h; draw(); },
        redraw: draw,
        destroy() { ro.disconnect(); el.innerHTML = ''; },
    };
}

/**
 * Narration band — a horizontal storm timeline built from bundle.moments,
 * with a caption for the moment nearest the cursor. Same interaction
 * pattern as the Gannon narration band, but generic over the bundle.
 * Expects the host page to style .hc-narration-* (see st-patrick-storm.html).
 */
export function createNarrationBand(el, replay, player, { onSeekHours } = {}) {
    const moments = (replay.moments || []).slice().sort((a, b) => a.h - b.h);
    const hoursMax = player.hoursMax;

    el.classList.remove('gn-pulse');
    el.innerHTML = `
        <div class="hc-narration-track"></div>
        <div class="hc-narration-caption">
            <div class="hc-narration-clock"></div>
            <div class="hc-narration-title"></div>
            <div class="hc-narration-body"></div>
        </div>`;
    const track = el.querySelector('.hc-narration-track');
    const clock = el.querySelector('.hc-narration-clock');
    const title = el.querySelector('.hc-narration-title');
    const body  = el.querySelector('.hc-narration-body');

    const btns = moments.map((m, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `hc-narration-moment hc-narration-moment--${m.phase || 'storm'}`;
        b.style.left = `${(m.h / hoursMax) * 100}%`;
        b.innerHTML = `<span class="hc-narration-label">${m.title}</span><span class="hc-narration-tick"></span><span class="hc-narration-dot"></span>`;
        b.addEventListener('click', () => onSeekHours && onSeekHours(m.h));
        b.setAttribute('aria-label', `${m.title} — jump to this moment`);
        track.appendChild(b);
        return { m, b, i };
    });

    // Declutter: alternate label rows so adjacent labels don't collide.
    btns.forEach(({ b }, i) => { if (i % 2 === 1) b.classList.add('hc-narration-moment--low'); });

    function setCursor(h) {
        let active = 0;
        for (let i = 0; i < moments.length; i++) {
            if (h >= moments[i].h - 0.01) active = i;
        }
        btns.forEach(({ b }, i) => b.classList.toggle('is-active', i === active));
        const m = moments[active];
        clock.textContent = player.timestampAt(m.h).slice(0, 16).replace('T', ' · ') + ' UT';
        title.textContent = m.title;
        body.textContent = m.body;
    }
    setCursor(0);

    return { setCursor };
}
