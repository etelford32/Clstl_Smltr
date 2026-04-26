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
 * Why we *inline* the handler here instead of `export { default } from
 * './latest.js'`: the re-export pattern bundles fine locally but Vercel
 * Edge has been observed returning HTTP 500 on the alias path while
 * the canonical /latest endpoint serves 200 normally — same source,
 * same env. Inlining sidesteps whatever the Edge bundler is doing.
 *
 * Older clients, bookmarks, and the health-check UI in
 * js/pipeline-analytics.js keep working with identical response shape
 * and query params (?series=1 / ?series=full).
 */

import handler, { config as latestConfig } from './latest.js';

export const config = latestConfig;

export default async function aliasHandler(request) {
    return handler(request);
}
