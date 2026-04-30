/**
 * Vercel Cron: /api/cron/prewarm-medium
 *
 * Runs every 30 minutes. Pre-warms ~10 endpoints tagged
 * `prewarm: 'medium'` in js/pipeline-registry.js — DONKI feeds,
 * NOAA aurora/alerts/flares, NWS convective, lightning, launches.
 */

import { prewarmTier } from '../_lib/prewarm.js';

export const config = { runtime: 'edge' };

export default (req) => prewarmTier('medium', req);
