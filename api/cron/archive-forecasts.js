/**
 * Vercel Node Cron: /api/cron/archive-forecasts
 *
 * Drains rows from forecast_log that are older than 7 days into daily
 * gzipped JSONL files in R2, writes a pointer row per day, flips
 * archived=TRUE on the source rows, and trims them.
 *
 * This is the cold side of the Phase 0 accumulator. Combined with the
 * hot table (7 days, hourly cadence, Supabase) and the upcoming warm
 * tier (PR #9, 30 days, 6-hourly), we have a complete deterministic
 * replay surface — analog forecasting and the NN residual-correction
 * track read from here.
 *
 * Behaviour:
 *   - Pulls unarchived rows older than 7 d in keyset-paged batches of
 *     1000, capped at MAX_ARCHIVE_ROWS / run.
 *   - Groups rows by (made_at::date, UTC).
 *   - For each day:
 *       - If a forecast_archive_pointer already exists for that day
 *         (idempotent retry path), skip the R2 upload and just flip
 *         archived=TRUE on the rows.
 *       - Otherwise: serialise to JSONL, gzip, sha256 the compressed
 *         bytes, PUT to R2 at forecasts/{yyyy}/{mm}/{dd}.jsonl.gz,
 *         INSERT the pointer row, UPDATE rows.archived = TRUE.
 *   - Calls trim_forecast_log() at the end to delete now-archived
 *     rows older than 7 d. (Brand-new archives stay in the hot table
 *     for a few hours so the validator's observation backfill can
 *     still UPDATE them in place.)
 *
 * ── Auth ────────────────────────────────────────────────────────────
 * Vercel cron header `x-vercel-cron: 1`, or `Authorization: Bearer
 * ${CRON_SECRET}` when CRON_SECRET is set.
 *
 * ── Env vars ────────────────────────────────────────────────────────
 *   SUPABASE_URL              (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY      (or SUPABASE_SECRET_KEY)
 *   CRON_SECRET               (optional but recommended)
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *                             (see api/_lib/r2-client.js)
 *
 * ── Response ────────────────────────────────────────────────────────
 *   200 { ok, days_archived, rows_archived, rows_skipped_existing,
 *         trimmed, dur_ms, files: [{day, key, bytes, row_count}] }
 *   502 { ok: false, reason }  — on R2 / Supabase failure
 *   401 { error: 'unauthorized' }
 *   503 { ok: false, reason: 'r2_not_configured' | 'supabase_not_configured' }
 */

import { createHash } from 'node:crypto';
import { gzipSync }   from 'node:zlib';
import { fetchWithTimeout } from '../_lib/responses.js';
import { putObject, R2_CONFIGURED } from '../_lib/r2-client.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const WATCHDOG_MS = 57_000;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';

// Hard caps. The hot table at expected steady-state is a few thousand
// rows/day; if MAX_ARCHIVE_ROWS is ever hit, the next tick picks up
// where we left off (keyset paging by id).
const PAGE_SIZE         = 1000;
const MAX_ARCHIVE_ROWS  = 50_000;

function isAuthorized(request) {
    const hdr = request.headers.get('authorization') ?? '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (request.headers.get('x-vercel-cron')) return true;
    return false;
}

// ── Supabase REST helpers ─────────────────────────────────────────

async function fetchUnarchivedPage(afterId) {
    // Rows older than 7 d that haven't been archived yet, ordered by id
    // so keyset paging is stable across calls.
    //
    // We pull "made_at + 7 days < now" — equivalent to "older than 7 d"
    // — using PostgREST's lt operator on an ISO-formatted cutoff.
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const url = new URL(`${SUPABASE_URL}/rest/v1/forecast_log`);
    url.searchParams.set('select', '*');
    url.searchParams.set('archived', 'eq.false');
    url.searchParams.set('made_at', `lt.${cutoff}`);
    url.searchParams.set('id', `gt.${afterId}`);
    url.searchParams.set('order', 'id.asc');
    url.searchParams.set('limit', String(PAGE_SIZE));

    const res = await fetchWithTimeout(url, {
        timeoutMs: 10_000,
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Accept:        'application/json',
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`supabase_fetch ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
}

async function fetchExistingPointer(day) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/forecast_archive_pointer`);
    url.searchParams.set('select', 'id,r2_key,row_count,bytes,sha256');
    url.searchParams.set('day', `eq.${day}`);
    url.searchParams.set('limit', '1');
    const res = await fetchWithTimeout(url, {
        timeoutMs: 5_000,
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Accept:        'application/json',
        },
    });
    if (!res.ok) throw new Error(`pointer_lookup ${res.status}`);
    const rows = await res.json();
    return rows[0] || null;
}

async function insertPointer({ day, r2_key, row_count, bytes, sha256 }) {
    const res = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/forecast_archive_pointer`,
        {
            method:    'POST',
            timeoutMs: 8_000,
            headers: {
                apikey:         SUPABASE_KEY,
                Authorization:  `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                // Idempotent against a racing run on the same day — the
                // (r2_key) UNIQUE constraint catches duplicates.
                Prefer:         'resolution=ignore-duplicates,return=representation',
            },
            body: JSON.stringify({ day, r2_key, row_count, bytes, sha256 }),
        },
    );
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`pointer_insert ${res.status}: ${text.slice(0, 300)}`);
    }
}

async function markArchived(ids) {
    if (ids.length === 0) return 0;
    // PostgREST `in.(...)` filter. Cap of 1000 ids per request to keep the
    // URL under typical CDN/origin URL-length limits (~16 KB); chunk if more.
    let marked = 0;
    for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        const url = new URL(`${SUPABASE_URL}/rest/v1/forecast_log`);
        url.searchParams.set('id', `in.(${slice.join(',')})`);
        const res = await fetchWithTimeout(url, {
            method:    'PATCH',
            timeoutMs: 10_000,
            headers: {
                apikey:         SUPABASE_KEY,
                Authorization:  `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                Prefer:         'return=minimal',
            },
            body: JSON.stringify({ archived: true }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`mark_archived ${res.status}: ${text.slice(0, 300)}`);
        }
        marked += slice.length;
    }
    return marked;
}

async function callTrim() {
    try {
        const res = await fetchWithTimeout(
            `${SUPABASE_URL}/rest/v1/rpc/trim_forecast_log`,
            {
                method:    'POST',
                timeoutMs: 8_000,
                headers: {
                    apikey:         SUPABASE_KEY,
                    Authorization:  `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: '{}',
            },
        );
        if (!res.ok) return 0;
        const n = await res.json().catch(() => 0);
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

async function recordPipelineFailure(reason) {
    try {
        await fetchWithTimeout(
            `${SUPABASE_URL}/rest/v1/rpc/record_pipeline_failure`,
            {
                method:    'POST',
                timeoutMs: 5_000,
                headers: {
                    apikey:         SUPABASE_KEY,
                    Authorization:  `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ p_name: 'forecast_archive', p_reason: reason }),
            },
        );
    } catch { /* heartbeat failures are non-fatal */ }
}

async function recordPipelineSuccess(detail) {
    try {
        await fetchWithTimeout(
            `${SUPABASE_URL}/rest/v1/rpc/record_pipeline_success`,
            {
                method:    'POST',
                timeoutMs: 5_000,
                headers: {
                    apikey:         SUPABASE_KEY,
                    Authorization:  `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ p_name: 'forecast_archive', p_source: detail }),
            },
        );
    } catch { /* non-fatal */ }
}

// ── Day-grouping + R2 upload ──────────────────────────────────────

function dayKeyOf(isoMadeAt) {
    // UTC date stamp. forecast_log.made_at is a TIMESTAMPTZ; PostgREST
    // returns it as ISO-8601 with offset. new Date() handles both Z and
    // offset forms.
    const d = new Date(isoMadeAt);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return { day: `${yyyy}-${mm}-${dd}`, yyyy, mm, dd };
}

function rowsToJsonl(rows) {
    // One JSON object per line, NDJSON-style. Keep the full row shape
    // (no projection) so cold replays mirror the hot table exactly.
    return rows.map(r => JSON.stringify(r)).join('\n') + '\n';
}

async function archiveOneDay(day, rows, yyyy, mm, dd) {
    const key   = `forecasts/${yyyy}/${mm}/${dd}.jsonl.gz`;

    // Idempotency check: if the pointer already exists for this day, the
    // R2 object is presumed valid (we wrote them in the same call). Skip
    // re-upload and just flip the source rows. This covers the case
    // where a previous run uploaded + wrote pointer but crashed before
    // markArchived completed.
    const existing = await fetchExistingPointer(day);
    if (existing) {
        await markArchived(rows.map(r => r.id));
        return {
            day,
            key:           existing.r2_key,
            bytes:         existing.bytes,
            row_count:     rows.length,
            uploaded:      false,
            skipped_existing: true,
        };
    }

    const jsonl    = rowsToJsonl(rows);
    const gzipped  = gzipSync(Buffer.from(jsonl, 'utf8'));
    const sha256   = createHash('sha256').update(gzipped).digest('hex');

    await putObject(key, gzipped, {
        contentType:     'application/x-ndjson',
        contentEncoding: 'gzip',
        cacheControl:    'public, max-age=31536000, immutable',
        metadata: {
            day,
            rows: String(rows.length),
            sha256,
        },
    });

    await insertPointer({
        day,
        r2_key:    key,
        row_count: rows.length,
        bytes:     gzipped.byteLength,
        sha256,
    });

    await markArchived(rows.map(r => r.id));

    return {
        day,
        key,
        bytes:            gzipped.byteLength,
        row_count:        rows.length,
        uploaded:         true,
        skipped_existing: false,
    };
}

// ── Handler ───────────────────────────────────────────────────────

async function runArchive(request) {
    const started = Date.now();

    if (!isAuthorized(request)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return new Response(JSON.stringify({
            ok:     false,
            reason: 'supabase_not_configured',
        }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    if (!R2_CONFIGURED) {
        return new Response(JSON.stringify({
            ok:     false,
            reason: 'r2_not_configured',
        }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    // ── Drain unarchived rows older than 7 d ─────────────────────
    const allRows = [];
    let cursor = 0;
    while (allRows.length < MAX_ARCHIVE_ROWS) {
        let page;
        try {
            page = await fetchUnarchivedPage(cursor);
        } catch (e) {
            await recordPipelineFailure(`fetch_page: ${e.message}`);
            return new Response(JSON.stringify({ ok: false, reason: e.message }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (page.length === 0) break;
        allRows.push(...page);
        cursor = page[page.length - 1].id;
        if (page.length < PAGE_SIZE) break;
    }

    if (allRows.length === 0) {
        // Nothing to do — still bump the heartbeat so a long quiet
        // stretch doesn't look like a stalled pipeline.
        await recordPipelineSuccess('idle');
        return new Response(JSON.stringify({
            ok:                     true,
            days_archived:          0,
            rows_archived:          0,
            rows_skipped_existing:  0,
            trimmed:                0,
            dur_ms:                 Date.now() - started,
            files:                  [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // ── Group by UTC date ────────────────────────────────────────
    /** @type {Map<string, { yyyy, mm, dd, rows: any[] }>} */
    const byDay = new Map();
    for (const row of allRows) {
        const { day, yyyy, mm, dd } = dayKeyOf(row.made_at);
        let bucket = byDay.get(day);
        if (!bucket) {
            bucket = { yyyy, mm, dd, rows: [] };
            byDay.set(day, bucket);
        }
        bucket.rows.push(row);
    }

    // ── Archive each day ──────────────────────────────────────────
    const files = [];
    let rowsArchived   = 0;
    let rowsSkipped    = 0;
    for (const [day, { yyyy, mm, dd, rows }] of byDay) {
        try {
            const result = await archiveOneDay(day, rows, yyyy, mm, dd);
            files.push(result);
            if (result.skipped_existing) rowsSkipped   += result.row_count;
            else                          rowsArchived += result.row_count;
        } catch (e) {
            await recordPipelineFailure(`archive_${day}: ${e.message}`);
            return new Response(JSON.stringify({
                ok:              false,
                reason:          `archive_${day}: ${e.message}`,
                partial_files:   files,
                dur_ms:          Date.now() - started,
            }), { status: 502, headers: { 'Content-Type': 'application/json' } });
        }
    }

    const trimmed = await callTrim();

    await recordPipelineSuccess(
        `days=${files.length} rows=${rowsArchived} skipped=${rowsSkipped}`,
    );

    return new Response(JSON.stringify({
        ok:                     true,
        days_archived:          files.length,
        rows_archived:          rowsArchived,
        rows_skipped_existing:  rowsSkipped,
        trimmed,
        dur_ms:                 Date.now() - started,
        files,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export default async function handler(request) {
    let timer;
    const watchdog = new Promise((resolve) => {
        timer = setTimeout(async () => {
            await recordPipelineFailure(
                `worker_timeout: exceeded ${WATCHDOG_MS} ms`,
            );
            resolve(new Response(JSON.stringify({
                ok:        false,
                reason:    'worker_timeout',
                budget_ms: WATCHDOG_MS,
            }), { status: 504, headers: { 'Content-Type': 'application/json' } }));
        }, WATCHDOG_MS);
    });
    try {
        return await Promise.race([runArchive(request), watchdog]);
    } finally {
        clearTimeout(timer);
    }
}
