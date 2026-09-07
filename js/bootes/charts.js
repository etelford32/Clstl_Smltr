/**
 * bootes/charts.js — the 2D figures on bootes-void.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Canvas 2D only. No three.js, no fetch. Every chart takes already-computed
 * arrays — this module does no physics, so a wrong curve is a wrong CALL and
 * never a second implementation of the kernel quietly disagreeing with the
 * first.
 *
 * WHY CANVAS AND NOT A CHART LIBRARY. Same reason as everywhere else in this
 * repo: there is no bundler, and a charting library pulled from a CDN would be
 * a third-party render path for numbers whose whole selling point is that you
 * can trace them back to a kernel. Seven small charts is less code than the
 * adapter would be.
 *
 * TWO CONVENTIONS THAT EVERY CHART HERE OBEYS
 * ───────────────────────────────────────────
 *  1. ZERO IS ALWAYS DRAWN when the data crosses it. Half of these figures are
 *     about a SIGN — the outflow is positive, ΔΣ is negative, ΔT is negative —
 *     and a chart that crops the zero line lets a reader lose the one thing
 *     the figure exists to show.
 *  2. R_eff IS ALWAYS MARKED on any chart with a radial axis. Every radius on
 *     this page means something only relative to the void's own size, and
 *     "92 Mpc" is not a number most readers carry.
 *
 * Charts are drawn at devicePixelRatio and re-drawn on resize by the caller;
 * they hold no state of their own beyond the palette.
 */

export const PALETTE = Object.freeze({
    ink: '#cdd5e4',
    dim: '#7d879e',
    faint: 'rgba(125,135,158,.22)',
    grid: 'rgba(125,135,158,.14)',
    void: '#4fc3f7',        // the void / deficit
    wall: '#ff9a56',        // the compensating wall / the web
    total: '#c792ea',       // model A
    counter: '#7ee787',     // the counterfactual difference
    warn: '#ffb84d',
    bg: 'rgba(6,9,28,.0)',
});

/**
 * Prepare a canvas for crisp drawing and return its 2D context plus the CSS
 * pixel dimensions.
 *
 * The devicePixelRatio dance is load-bearing on this page specifically: these
 * charts carry hairline zero-axes and 1px curves, and on a 2× display an
 * unscaled canvas renders them as a 2px blur in which a curve sitting ON the
 * zero line is indistinguishable from one sitting just above it. That is the
 * exact distinction several of these figures exist to make.
 */
export function prepare(canvas) {
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
}

/** Nice round tick step for a span. */
function tickStep(span, target = 5) {
    const raw = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
    const norm = raw / mag;
    const step = norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1;
    return step * mag;
}

const fmt = (v) => {
    const a = Math.abs(v);
    // Snap float noise to zero. Ticks are generated as k·step from a ceil(),
    // which for a range straddling zero lands on values like −5.6e-17 — and
    // the exponential branch below then prints that as an axis label, which
    // reads as a real number and is the first thing a reader's eye lands on.
    if (a < 1e-12) return '0';
    if (a === 0) return '0';
    if (a >= 1000 || a < 0.01) return v.toExponential(1).replace('e+', 'e');
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
};

/**
 * The shared frame: axes, grid, zero line, R_eff marker, labels.
 * Returns projection functions so a caller can plot into it.
 */
function frame(ctx, w, h, { xMin, xMax, yMin, yMax, xLabel, yLabel, markX = [] }) {
    const padL = 46;
    const padR = 10;
    const padT = 12;
    const padB = 26;
    const px = (x) => padL + (x - xMin) / (xMax - xMin) * (w - padL - padR);
    const py = (y) => h - padB - (y - yMin) / (yMax - yMin) * (h - padT - padB);

    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;

    // Grid + tick labels.
    ctx.strokeStyle = PALETTE.grid;
    ctx.fillStyle = PALETTE.dim;
    // Ticks are indexed by an INTEGER multiple of the step rather than
    // accumulated by repeated addition — accumulation is what produced the
    // −5.6e-17 label the fmt() guard above also defends against, and fixing it
    // in one place only would leave the other free to reappear.
    const xs = tickStep(xMax - xMin);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let k = Math.ceil(xMin / xs); k * xs <= xMax + 1e-9; k++) {
        const x = k * xs;
        ctx.beginPath(); ctx.moveTo(px(x), padT); ctx.lineTo(px(x), h - padB); ctx.stroke();
        ctx.fillText(fmt(x), px(x), h - padB + 4);
    }
    const ys = tickStep(yMax - yMin);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let k = Math.ceil(yMin / ys); k * ys <= yMax + 1e-9; k++) {
        const y = k * ys;
        ctx.beginPath(); ctx.moveTo(padL, py(y)); ctx.lineTo(w - padR, py(y)); ctx.stroke();
        ctx.fillText(fmt(y), padL - 5, py(y));
    }

    // CONVENTION 1 — the zero line, drawn brighter than the grid whenever the
    // data straddles it. Several of these figures are entirely about a sign.
    if (yMin < 0 && yMax > 0) {
        ctx.strokeStyle = PALETTE.faint;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(padL, py(0)); ctx.lineTo(w - padR, py(0)); ctx.stroke();
        ctx.lineWidth = 1;
    }

    // CONVENTION 2 — R_eff and any other named radius, dashed and labelled.
    //
    // Labels are STAGGERED in y. R_eff and r_s sit within a few Mpc of each
    // other on every chart here, so drawing both at the same height overlaps
    // them into an unreadable smear — which is what shipped first and made two
    // deliberately-marked radii read as one mislabelled line.
    let markRow = 0;
    for (const mark of markX) {
        if (mark.x < xMin || mark.x > xMax) continue;
        ctx.save();
        ctx.strokeStyle = mark.color || PALETTE.faint;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(px(mark.x), padT); ctx.lineTo(px(mark.x), h - padB); ctx.stroke();
        ctx.restore();
        if (mark.label) {
            ctx.fillStyle = mark.color || PALETTE.dim;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(mark.label, px(mark.x) + 3, padT + 1 + markRow * 12);
            markRow++;
        }
    }

    // Axis labels.
    ctx.fillStyle = PALETTE.dim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    if (xLabel) ctx.fillText(xLabel, w - padR, h - 2);
    if (yLabel) {
        ctx.save();
        ctx.translate(10, padT);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(yLabel, 0, 0);
        ctx.restore();
    }
    return { px, py, padL, padR, padT, padB };
}

/** Plot one series as a polyline. */
function series(ctx, proj, points, color, { width = 1.8, dash = null } = {}) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    points.forEach(([x, y], i) => {
        const X = proj.px(x);
        const Y = proj.py(y);
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    });
    ctx.stroke();
    ctx.restore();
}

/** Shade a band between two y-series sharing an x-axis. */
function band(ctx, proj, points, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    points.forEach(([x, lo], i) => {
        const X = proj.px(x);
        const Y = proj.py(lo);
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    });
    for (let i = points.length - 1; i >= 0; i--) {
        ctx.lineTo(proj.px(points[i][0]), proj.py(points[i][2]));
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

/** Auto-range with padding, always including zero if the data crosses it. */
function rangeOf(values, { includeZero = false, pad = 0.08 } = {}) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
        if (!Number.isFinite(v)) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const span = (hi - lo) || Math.abs(hi) || 1;
    return [lo - span * pad, hi + span * pad];
}

/**
 * A small key drawn inside the plot. Kept here rather than in HTML so a chart
 * and its key cannot drift apart when a series is added or renamed.
 */
function legend(ctx, w, entries, { x = null, y = 16 } = {}) {
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    let ox = x ?? (w - 14);
    for (let i = entries.length - 1; i >= 0; i--) {
        const [label, color, dash] = entries[i];
        ctx.textAlign = 'right';
        ctx.fillStyle = PALETTE.dim;
        ctx.fillText(label, ox, y);
        const tw = ctx.measureText(label).width;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.save();
        if (dash) ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(ox - tw - 18, y);
        ctx.lineTo(ox - tw - 4, y);
        ctx.stroke();
        ctx.restore();
        ox -= tw + 28;
    }
    ctx.restore();
}

// ── The seven figures ───────────────────────────────────────────────────────

/**
 * Density: δ(r) and Δ(<r) on one axis.
 *
 * The two curves together are the whole argument for why the outflow keeps
 * growing outward through a wall where δ has already turned positive: gravity
 * responds to Δ, and Δ is still deeply negative there. Drawing them apart
 * loses that; drawing them together makes it obvious.
 */
export function drawDensity(canvas, { radii, delta, integrated, rEff, rs }) {
    const { ctx, w, h } = prepare(canvas);
    const [yMin, yMax] = rangeOf([...delta, ...integrated], { includeZero: true });
    const proj = frame(ctx, w, h, {
        xMin: 0, xMax: radii[radii.length - 1], yMin, yMax,
        xLabel: 'r  (comoving Mpc)', yLabel: 'contrast',
        markX: [
            { x: rEff, label: 'R_eff', color: PALETTE.faint },
            { x: rs, label: 'r_s', color: 'rgba(255,154,86,.35)' },
        ],
    });
    series(ctx, proj, radii.map((r, i) => [r, delta[i]]), PALETTE.wall);
    series(ctx, proj, radii.map((r, i) => [r, integrated[i]]), PALETTE.void);
    legend(ctx, w, [['δ(r)', PALETTE.wall], ['Δ(<r)', PALETTE.void]]);
}

/**
 * Test 1 — the outflow profile, linear and quasi-linear.
 *
 * Both curves are drawn because their DIFFERENCE is the point: the
 * quasi-linear correction is 5–25 %, which is the same size as the systematic
 * a peculiar-velocity survey would be fighting, so quoting only the linear
 * curve would make the model look more precise than it is.
 */
export function drawVelocity(canvas, { radii, linear, quasi, rEff, threshold }) {
    const { ctx, w, h } = prepare(canvas);
    const [yMin, yMax] = rangeOf([...linear, ...quasi], { includeZero: true });
    const proj = frame(ctx, w, h, {
        xMin: 0, xMax: radii[radii.length - 1], yMin, yMax,
        xLabel: 'r  (comoving Mpc)', yLabel: 'v_r  (km/s, outward)',
        markX: [{ x: rEff, label: 'R_eff', color: PALETTE.faint }],
    });
    if (threshold) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,184,77,.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(proj.px(0), proj.py(threshold));
        ctx.lineTo(proj.px(radii[radii.length - 1]), proj.py(threshold));
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = PALETTE.warn;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(`${threshold} km/s`, proj.px(0) + 4, proj.py(threshold) - 2);
    }
    series(ctx, proj, radii.map((r, i) => [r, linear[i]]), PALETTE.dim, { dash: [4, 3] });
    series(ctx, proj, radii.map((r, i) => [r, quasi[i]]), PALETTE.void);
    legend(ctx, w, [['linear', PALETTE.dim, [4, 3]], ['quasi-linear', PALETTE.void]]);
}

/**
 * Test 2 — density against the divergence of the velocity field, on twin
 * scales so the shapes can be compared.
 *
 * They are the SAME CURVE up to a constant, which is the entire content of
 * ∇·v = −aHf δ. Plotting them normalised makes an agreement visible that a
 * pair of raw axes would hide behind a factor of 40.
 */
export function drawContinuity(canvas, { radii, delta, divergence, rEff }) {
    const { ctx, w, h } = prepare(canvas);
    const dScale = Math.max(...delta.map(Math.abs)) || 1;
    const vScale = Math.max(...divergence.map(Math.abs)) || 1;
    const dn = delta.map(v => v / dScale);
    const vn = divergence.map(v => -v / vScale);
    const proj = frame(ctx, w, h, {
        xMin: 0, xMax: radii[radii.length - 1], yMin: -1.15, yMax: 1.15,
        xLabel: 'r  (comoving Mpc)', yLabel: 'normalised',
        markX: [{ x: rEff, label: 'R_eff', color: PALETTE.faint }],
    });
    series(ctx, proj, radii.map((r, i) => [r, dn[i]]), PALETTE.wall, { width: 3.4 });
    series(ctx, proj, radii.map((r, i) => [r, vn[i]]), PALETTE.void, { width: 1.4, dash: [5, 4] });
    legend(ctx, w, [['δ(r)', PALETTE.wall], ['−∇·v / aHf', PALETTE.void, [5, 4]]]);
}

/**
 * Test 4 — the void's share of the local peculiar acceleration, with the
 * 16–84 band across directions.
 *
 * THE BAND IS THE RESULT. A median alone would say "the void owns 80 % of the
 * force at R_eff" and hide that the figure is 88 % in one direction and 67 %
 * in another. That anisotropy is the answer to "does the void or the filament
 * dominate", and it only exists as a spread.
 */
export function drawInfluence(canvas, { shareProfile, rEff, horizonMpc }) {
    const { ctx, w, h } = prepare(canvas);
    const xs = shareProfile.map(s => s.radiusMpc);
    const proj = frame(ctx, w, h, {
        xMin: xs[0], xMax: xs[xs.length - 1], yMin: 0, yMax: 1.02,
        xLabel: 'r  (comoving Mpc)', yLabel: 'void share of |g|',
        markX: [
            { x: rEff, label: 'R_eff', color: PALETTE.faint },
            horizonMpc ? { x: horizonMpc, label: 'v-horizon', color: 'rgba(255,184,77,.45)' } : null,
        ].filter(Boolean),
    });
    band(ctx, proj, shareProfile.map(s => [s.radiusMpc, s.p16, s.p84]), 'rgba(79,195,247,.16)');
    series(ctx, proj, shareProfile.map(s => [s.radiusMpc, s.median]), PALETTE.void);
    // The 50 % line is where the surrounding web overtakes the void.
    ctx.save();
    ctx.strokeStyle = 'rgba(255,154,86,.45)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(proj.px(xs[0]), proj.py(0.5));
    ctx.lineTo(proj.px(xs[xs.length - 1]), proj.py(0.5));
    ctx.stroke();
    ctx.restore();
    legend(ctx, w, [['median', PALETTE.void], ['web takes over', PALETTE.wall, [4, 4]]]);
}

/**
 * Test 6 — apparent line-of-sight elongation in redshift space.
 *
 * Drawn against ε = 1 (no distortion) rather than against zero, because the
 * quantity is a RATIO and a reader looking for "is it above or below one" gets
 * no help from a zero axis a long way off the bottom of the figure.
 */
export function drawRsd(canvas, { radii, epsilon, quadrupole, rEff }) {
    const { ctx, w, h } = prepare(canvas);
    const [lo, hi] = rangeOf([...epsilon, 1]);
    const proj = frame(ctx, w, h, {
        xMin: radii[0], xMax: radii[radii.length - 1], yMin: Math.min(lo, 0.98), yMax: hi,
        xLabel: 'r  (comoving Mpc)', yLabel: 'ε = s∥ / s⊥',
        markX: [{ x: rEff, label: 'R_eff', color: PALETTE.faint }],
    });
    ctx.save();
    ctx.strokeStyle = PALETTE.faint;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(proj.px(radii[0]), proj.py(1));
    ctx.lineTo(proj.px(radii[radii.length - 1]), proj.py(1));
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = PALETTE.dim;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('ε = 1  (no distortion)', proj.px(radii[0]) + 4, proj.py(1) - 2);
    series(ctx, proj, radii.map((r, i) => [r, epsilon[i]]), PALETTE.total);
    if (quadrupole) {
        const qScale = Math.max(...quadrupole.map(Math.abs)) || 1;
        const mid = (proj.py(1) === undefined) ? 1 : 1;
        series(ctx, proj,
            radii.map((r, i) => [r, mid + (quadrupole[i] / qScale) * (hi - 1) * 0.7]),
            PALETTE.counter, { width: 1.3, dash: [4, 3] });
        legend(ctx, w, [['ε(r)', PALETTE.total], ['ξ₂/ξ₀ (scaled)', PALETTE.counter, [4, 3]]]);
    }
}

/**
 * Test 7 — the lensing observable ΔΣ(R).
 *
 * ENTIRELY BELOW ZERO, and that is the figure's message: a void is a diverging
 * lens and its tangential shear has the opposite sign to a cluster's. The zero
 * line is drawn even though no data touches it, because a reader who cannot
 * see zero cannot see the sign.
 */
export function drawLensing(canvas, { radii, deltaSigma, snr, rEff }) {
    const { ctx, w, h } = prepare(canvas);
    const [lo, hi] = rangeOf(deltaSigma, { includeZero: true });
    const proj = frame(ctx, w, h, {
        xMin: radii[0], xMax: radii[radii.length - 1], yMin: lo, yMax: hi,
        xLabel: 'R  (projected, Mpc)', yLabel: 'ΔΣ  (M☉/pc²)',
        markX: [{ x: rEff, label: 'R_eff', color: PALETTE.faint }],
    });
    series(ctx, proj, radii.map((r, i) => [r, deltaSigma[i]]), PALETTE.void);
    if (snr) {
        const sScale = Math.max(...snr) || 1;
        series(ctx, proj,
            radii.map((r, i) => [r, lo * (snr[i] / sScale) * 0.9]),
            PALETTE.warn, { width: 1.3, dash: [4, 3] });
        legend(ctx, w, [['ΔΣ', PALETTE.void], ['SNR (scaled)', PALETTE.warn, [4, 3]]]);
    }
}

/**
 * Test 8 — the ISW temperature profile against angular radius.
 *
 * The x axis is DEGREES, not Mpc, because this is the one observable on the
 * page that lives on the sky rather than in the box, and because 25° is the
 * number that makes a reader realise how large this void is: it is a quarter
 * of the way from the horizon to the zenith.
 */
export function drawIsw(canvas, { degrees, microK, thetaEff }) {
    const { ctx, w, h } = prepare(canvas);
    const [lo, hi] = rangeOf(microK, { includeZero: true });
    const proj = frame(ctx, w, h, {
        xMin: 0, xMax: degrees[degrees.length - 1], yMin: lo, yMax: hi,
        xLabel: 'angular radius  (degrees)', yLabel: 'ΔT  (µK)',
        markX: [{ x: thetaEff, label: 'R_eff', color: PALETTE.faint }],
    });
    series(ctx, proj, degrees.map((d, i) => [d, microK[i]]), PALETTE.void);
}

/**
 * The compensation figure: cumulative mass excess M(<r), showing the interior
 * deficit being repaid by the wall — and NOT quite repaid, which is what
 * under-compensation means and why the void's reach does not stop at its wall.
 */
export function drawCompensation(canvas, { radii, cumulativeMass, rEff, rs }) {
    const { ctx, w, h } = prepare(canvas);
    const [lo, hi] = rangeOf(cumulativeMass, { includeZero: true });
    const proj = frame(ctx, w, h, {
        xMin: 0, xMax: radii[radii.length - 1], yMin: lo, yMax: hi,
        xLabel: 'r  (comoving Mpc)', yLabel: 'δM(<r)  (10¹⁵ M☉)',
        markX: [
            { x: rEff, label: 'R_eff', color: PALETTE.faint },
            { x: rs, label: 'r_s', color: 'rgba(255,154,86,.35)' },
        ],
    });
    series(ctx, proj, radii.map((r, i) => [r, cumulativeMass[i]]), PALETTE.counter);
    // The asymptote — the residual the wall never repays.
    const residual = cumulativeMass[cumulativeMass.length - 1];
    ctx.save();
    ctx.strokeStyle = 'rgba(126,231,135,.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(proj.px(0), proj.py(residual));
    ctx.lineTo(proj.px(radii[radii.length - 1]), proj.py(residual));
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = PALETTE.counter;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`residual ${residual.toFixed(1)}`, proj.px(radii[radii.length - 1]) - 4,
        proj.py(residual) - 3);
}
