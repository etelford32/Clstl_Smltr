/**
 * Vercel Edge Function: /api/solar-wind/wind-speed   (alias)
 *
 * Backward-compatible alias for /api/solar-wind/latest. The original
 * handler fetched NOAA SWPC directly from Vercel edge, which NOAA's
 * WAF permanently blocks with 403 host_not_allowed. The canonical
 * reader now lives at /api/solar-wind/latest and reads from the
 * Supabase ring buffer populated by pg_cron (see
 * supabase-solar-wind-migration.sql).
 *
 * This file re-exports that handler so older clients, bookmarks, and
 * the health-check UI in js/pipeline-analytics.js keep working with
 * identical response shape and query params (?series=1 / ?series=full).
 *
 * CRITICAL: `config` must be declared as a literal IN THIS FILE.
 * Vercel's build-time static analysis does not resolve re-exported
 * config (`export { config } from './latest.js'`), so the route was
 * silently deployed as a Node serverless function. The Node runtime
 * invokes handlers as (req, res) — `new URL(request.url)` then throws
 * on the path-only Node req.url and every request 500s, while
 * /api/solar-wind/latest (same code, literal config) works.
 */

import handler from './latest.js';

export const config = { runtime: 'edge' };

export default handler;
