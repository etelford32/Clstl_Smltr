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
 */

export { config, default } from './latest.js';
