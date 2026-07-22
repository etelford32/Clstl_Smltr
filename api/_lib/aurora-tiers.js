/**
 * api/_lib/aurora-tiers.js — PURE tier logic for the per-subscriber aurora
 * alert sender (api/cron/aurora-alerts.js). No I/O, no env — node-testable
 * via tests/aurora-tiers.mjs.
 *
 * This implements — and extends — the documented "Sender v1 trigger
 * contract: forecast Kp >= kp_threshold → email"
 * (supabase-aurora-alert-prefs-migration.sql) that was never built: the
 * columns subscribers write (kp_threshold, lat, lon, city) finally get a
 * reader. Three tiers, highest urgency wins:
 *
 *   NOWCAST — observed Kp is at/above the subscriber's threshold NOW.
 *   WARNING — threshold-level activity expected within 24 h: the SWPC
 *             3-day Kp forecast, or an inbound flux-rope CME whose
 *             ensemble arrival window opens within 24 h and whose
 *             forecast min-Bz maps to a threshold-level Kp.
 *   WATCH   — same signals on the 24–96 h horizon (SWPC out to 72 h; the
 *             flux-rope ensemble carries the longer lead).
 *
 * Re-notify policy (`shouldSend`): send on tier ESCALATION immediately;
 * re-send the same tier only after a cooldown (default 24 h) so one storm
 * is one email per tier, not five.
 */

export const TIER_RANK = { watch: 1, warning: 2, nowcast: 3 };

/**
 * Coarse min-Bz → peak-Kp anchors for TIER MAPPING ONLY (not a model):
 * sustained −5 nT ≈ Kp 4, −10 ≈ Kp 6, −15 ≈ Kp 7, −20 ≈ Kp 8, −25 ≈ Kp 9.
 * Linear between anchors, clamped to [0, 9].
 */
export function kpFromMinBz(minBzNt) {
    if (!Number.isFinite(minBzNt)) return null;
    const a = [[-25, 9], [-20, 8], [-15, 7], [-10, 6], [-5, 4], [0, 2]];
    if (minBzNt <= a[0][0]) return 9;
    if (minBzNt >= a[a.length - 1][0]) return Math.max(0, a[a.length - 1][1]);
    for (let i = 1; i < a.length; i++) {
        const [x1, y1] = a[i - 1], [x2, y2] = a[i];
        if (minBzNt <= x2) return y1 + (y2 - y1) * (minBzNt - x1) / (x2 - x1);
    }
    return 0;
}

const HOUR_MS = 3_600_000;

/** Max forecast Kp inside (fromMs, toMs] from [{tMs, kp}] rows. */
function maxKpIn(kpForecast, fromMs, toMs) {
    let m = null;
    for (const r of kpForecast || []) {
        if (!Number.isFinite(r?.tMs) || !Number.isFinite(r?.kp)) continue;
        if (r.tMs > fromMs && r.tMs <= toMs && (m == null || r.kp > m)) m = r.kp;
    }
    return m;
}

/** Does the rope arrival window [P10, P90] intersect (fromMs, toMs]? */
function windowIntersects(f, fromMs, toMs) {
    const a = Number.isFinite(f.arrivalP10Ms) ? f.arrivalP10Ms : f.arrivalP50Ms;
    const b = Number.isFinite(f.arrivalP90Ms) ? f.arrivalP90Ms : f.arrivalP50Ms;
    return Number.isFinite(a) && Number.isFinite(b) && b > fromMs && a <= toMs;
}

/**
 * Evaluate the highest tier that fires for one subscriber threshold.
 * Inputs: observedKp (number|null), kpForecast [{tMs, kp}] (SWPC 3-day),
 * fluxRope (js/flux-rope-forecast.js `summary` | null), kpThreshold.
 * → { tier: 'nowcast'|'warning'|'watch'|null, via, kp, detail }
 */
export function evaluateTier({ nowMs, observedKp, kpForecast, fluxRope, kpThreshold }) {
    const thr = Number.isFinite(kpThreshold) ? kpThreshold : 5;
    const fmt = (v) => new Date(v).toISOString().slice(5, 16).replace('T', ' ') + 'Z';

    if (Number.isFinite(observedKp) && observedKp >= thr) {
        return {
            tier: 'nowcast', via: 'observed', kp: observedKp,
            detail: `Kp ${observedKp.toFixed(1)} observed now (your threshold: ${thr})`,
        };
    }

    const ropeKp = fluxRope ? kpFromMinBz(fluxRope.minBzP50) : null;
    const ropeCredible = fluxRope && Number.isFinite(ropeKp)
        && Number.isFinite(fluxRope.pHit);

    const kp24 = maxKpIn(kpForecast, nowMs, nowMs + 24 * HOUR_MS);
    if (kp24 != null && kp24 >= thr) {
        return {
            tier: 'warning', via: 'swpc-3day', kp: kp24,
            detail: `NOAA forecasts Kp ${kp24.toFixed(1)} within 24 h (your threshold: ${thr})`,
        };
    }
    if (ropeCredible && fluxRope.pHit >= 0.5 && ropeKp >= thr
        && windowIntersects(fluxRope, nowMs, nowMs + 24 * HOUR_MS)) {
        return {
            tier: 'warning', via: 'flux-rope', kp: ropeKp,
            detail: `CME inbound — flux-rope ensemble: est. Kp ${ropeKp.toFixed(1)}, `
                + `P(hit) ${Math.round(fluxRope.pHit * 100)}%, arrival ${fmt(fluxRope.arrivalP10Ms)}–${fmt(fluxRope.arrivalP90Ms)}`,
        };
    }

    const kp96 = maxKpIn(kpForecast, nowMs + 24 * HOUR_MS, nowMs + 96 * HOUR_MS);
    if (kp96 != null && kp96 >= thr) {
        return {
            tier: 'watch', via: 'swpc-3day', kp: kp96,
            detail: `NOAA forecasts Kp ${kp96.toFixed(1)} in the next 1–3 days (your threshold: ${thr})`,
        };
    }
    if (ropeCredible && fluxRope.pHit >= 0.35 && ropeKp >= thr
        && windowIntersects(fluxRope, nowMs + 24 * HOUR_MS, nowMs + 96 * HOUR_MS)) {
        return {
            tier: 'watch', via: 'flux-rope', kp: ropeKp,
            detail: `CME watch — flux-rope ensemble: est. Kp ${ropeKp.toFixed(1)}, `
                + `P(hit) ${Math.round(fluxRope.pHit * 100)}%, arrival ${fmt(fluxRope.arrivalP10Ms)}–${fmt(fluxRope.arrivalP90Ms)}`,
        };
    }

    return { tier: null };
}

/**
 * Debounce/escalation policy: fire on escalation immediately; re-fire the
 * SAME tier only after cooldownH; never fire on de-escalation.
 */
export function shouldSend({ tier, lastTier, lastAtMs, nowMs, cooldownH = 24 }) {
    if (!tier) return false;
    const rank = TIER_RANK[tier] ?? 0;
    const lastRank = TIER_RANK[lastTier] ?? 0;
    if (rank > lastRank) return true;
    if (!Number.isFinite(lastAtMs)) return true;
    return nowMs - lastAtMs >= cooldownH * HOUR_MS;
}

const TIER_COPY = {
    nowcast: { word: 'NOW', color: '#7CFC9B', lead: 'The sky is lighting up' },
    warning: { word: 'WARNING', color: '#ffb454', lead: 'Threshold-level activity expected within 24 hours' },
    watch: { word: 'WATCH', color: '#4fc3f7', lead: 'Storm potential in the next 1–3 days' },
};

/** Per-subscriber email content (pure). */
export function tierEmail({ tier, detail, city, siteUrl, unsubUrl }) {
    const c = TIER_COPY[tier];
    const where = city ? ` over ${city}` : '';
    const subject = tier === 'nowcast'
        ? `Aurora alert: activity crossing your threshold now${where}`
        : tier === 'warning'
            ? 'Aurora warning: storm conditions expected within 24 h'
            : 'Aurora watch: storm potential in the next few days';
    const html = `
      <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#03010e;color:#d6dee6;padding:32px;border-radius:12px;max-width:520px;margin:auto">
        <div style="font-size:11px;letter-spacing:.14em;color:${c.color};font-weight:700;margin-bottom:6px">AURORA ${c.word}</div>
        <h1 style="color:#ffb066;font-size:20px;margin:0 0 12px">${c.lead}.</h1>
        <p style="color:#b0c8d8;line-height:1.6">${detail}.</p>
        <p style="margin:24px 0">
          <a href="${siteUrl}/earth.html" style="background:#ffb066;color:#03010e;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block">Watch it live →</a>
        </p>
        <p style="color:#7a98a8;font-size:12px">Forecast tiers are driven by NOAA data and Parkers Physics' flux-rope ensemble engine.
          <a href="${unsubUrl}" style="color:#7a98a8">Unsubscribe</a>.</p>
      </div>`;
    return { subject, html };
}
