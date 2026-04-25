/**
 * Vercel Cron: /api/cron/prewarm-hot
 *
 * Runs every 5 minutes. Pre-warms ~10 endpoints tagged
 * `prewarm: 'hot'` in js/pipeline-registry.js — solar wind,
 * Kp 1-min, GOES X-ray, proton/electron flux, Dst.
 *
 * Each tick costs ~1 Edge invocation per endpoint × 12/h × ~10
 * endpoints = ~120 Edge invocations/hr, well within PRO's 1M/mo
 * envelope (cap is 1.4 K/hr if we used the entire month evenly).
 */

import { prewarmTier } from '../_lib/prewarm.js';

export const config = { runtime: 'edge' };

export default (req) => prewarmTier('hot', req);
