/**
 * Vercel Cron: /api/cron/prewarm-cold
 *
 * Runs every 6 hours. Pre-warms ~8 endpoints tagged
 * `prewarm: 'cold'` in js/pipeline-registry.js — atmosphere
 * profile/snapshot, polar vortex, AO/NAO teleconnections,
 * surface-outlook combiner, NOAA radio-flux + active regions +
 * 3-day forecast, CelesTrak TLE.
 *
 * These endpoints fan out to expensive upstreams (Open-Meteo GFS
 * pressure-levels, NOAA CPC ASCII files); pre-warming once per 6 h
 * keeps the warm cache fresh well within their natural publish
 * cadences.
 */

import { prewarmTier } from '../_lib/prewarm.js';

export const config = { runtime: 'edge' };

export default (req) => prewarmTier('cold', req);
