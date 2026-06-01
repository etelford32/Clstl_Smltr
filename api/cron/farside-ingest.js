/**
 * Vercel Node Cron: /api/cron/farside-ingest
 *
 * Phase 1 of Far-Side Watch (see FAR_SIDE_WATCH.md). Pulls each new far-side
 * map, parses it, runs the classical detector, and upserts one row per
 * (source, observed_at) into public.farside_maps. The slowest feed in the
 * architecture — no real-time pressure — so it runs on a 12 h cadence.
 *
 * Per source:
 *   - GONG is REQUIRED (the backbone); its failure fails the heartbeat.
 *   - SolO / STEREO / HMI are opportunistic (geometry-gated) — attempted
 *     best-effort, and a failure there is logged but never fails the run.
 *
 * Pipeline:
 *   fetch upstream → (FITS? readFITS → resample to 360×180 → z-normalize →
 *   detectSignatures : image-only) → archive raw bytes to R2 (provenance,
 *   optional) → upsert row (grid inline as base64 Float32 + detections jsonb).
 *
 * Reuses the DOM-free far-side modules (js/farside/{carrington,farside-detect}.js)
 * so the detector here is byte-for-byte the one the browser runs.
 *
 * ── Auth ── Vercel cron header `x-vercel-cron: 1`, or `Bearer ${CRON_SECRET}`.
 * ── Env  ── SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_KEY
 *            (or SUPABASE_SECRET_KEY), CRON_SECRET (optional),
 *            FARSIDE_*_URL upstream overrides, R2_* (optional, see r2-client.js).
 * ── Response ── 200 { ok, results:[…], trimmed, dur_ms } | 401 | 503 | 502
 */

import { createHash } from 'node:crypto';
import { fetchWithTimeout } from '../_lib/responses.js';
import { putObject, R2_CONFIGURED } from '../_lib/r2-client.js';
import { resolveUpstream, SOURCES } from '../_lib/farside-sources.js';
import { readFITS, resample, zNormalize } from '../_lib/fits.js';
import { GRID } from '../../js/farside/farside-config.js';
import { detectSignatures, isStrong } from '../../js/farside/farside-detect.js';
import { carringtonL0 } from '../../js/farside/carrington.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const WATCHDOG_MS  = 56_000;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';

const TWELVE_H = 12 * 3600 * 1000;

function isAuthorized(req) {
    const hdr = req.headers.get('authorization') ?? '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (req.headers.get('x-vercel-cron')) return true;
    return false;
}

const sbHeaders = (extra = {}) => ({
    apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...extra,
});

// ── heartbeat (shared SECURITY DEFINER helpers) ───────────────────
async function recordSuccess(source) {
    try {
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/record_pipeline_success`, {
            method: 'POST', timeoutMs: 5000,
            headers: sbHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ p_name: 'farside_ingest', p_source: source }),
        });
    } catch { /* non-fatal */ }
}
async function recordFailure(reason) {
    try {
        await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/record_pipeline_failure`, {
            method: 'POST', timeoutMs: 5000,
            headers: sbHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ p_name: 'farside_ingest', p_reason: String(reason).slice(0, 300) }),
        });
    } catch { /* non-fatal */ }
}
async function callTrim() {
    try {
        const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/trim_farside_maps`, {
            method: 'POST', timeoutMs: 8000,
            headers: sbHeaders({ 'Content-Type': 'application/json' }),
            body: '{}',
        });
        if (!res.ok) return 0;
        const n = await res.json().catch(() => 0);
        return Number.isFinite(n) ? n : 0;
    } catch { return 0; }
}

// ── helpers ───────────────────────────────────────────────────────
function slotStartISO(ms = Date.now()) {
    return new Date(Math.floor(ms / TWELVE_H) * TWELVE_H).toISOString();
}

function looksLikeFITS(buf, url) {
    if (/\.fits?($|\?)/i.test(url)) return true;
    const head = new Uint8Array(buf.slice(0, 6));
    return String.fromCharCode(...head) === 'SIMPLE';
}

function parseDateObs(header) {
    const d = header['DATE-OBS'] || header['DATE_OBS'] || header.DATEOBS;
    if (!d) return null;
    const t = Date.parse(d.endsWith('Z') || /[+\-]\d\d:?\d\d$/.test(d) ? d : d + 'Z');
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function f32ToBase64(f32) {
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

async function upsertRow(row) {
    const res = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/farside_maps?on_conflict=source,observed_at`,
        {
            method: 'POST', timeoutMs: 12_000,
            headers: sbHeaders({
                'Content-Type': 'application/json',
                Prefer: 'resolution=merge-duplicates,return=minimal',
            }),
            body: JSON.stringify(row),
        },
    );
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`upsert ${res.status}: ${t.slice(0, 300)}`);
    }
}

/** Ingest one source. Returns a summary; throws on hard failure. */
async function ingestSource(source) {
    const upstream = resolveUpstream(source);
    if (!upstream) throw new Error(`unknown_source_${source}`);

    const up = await fetchWithTimeout(upstream, {
        timeoutMs: 12_000,
        headers: { Accept: 'application/fits,image/png,image/jpeg,*/*' },
    });
    if (!up.ok) throw new Error(`upstream_${up.status}`);
    const buf = await up.arrayBuffer();

    const row = {
        source,
        image_url: upstream,
        synthetic: false,
        grid_nlon: GRID.nLon, grid_nlat: GRID.nLat, lat_min: GRID.latMin,
        detections: [], n_detections: 0, n_strong: 0,
        meta: { bytes: buf.byteLength, content_type: up.headers.get('content-type') || null },
    };

    if (looksLikeFITS(buf, upstream)) {
        const { header, nx, ny, data } = readFITS(buf);
        const grid = resample(data, nx, ny, GRID.nLon, GRID.nLat);
        const { data: z, mean, std } = zNormalize(grid);

        const observedISO = parseDateObs(header) || slotStartISO();
        // Prefer header Carrington coords; else compute from the observation time.
        const eph = carringtonL0(new Date(observedISO));
        const L0 = Number.isFinite(header.CRLN_OBS) ? header.CRLN_OBS : eph.L0;
        const B0 = Number.isFinite(header.CRLT_OBS) ? header.CRLT_OBS : eph.B0;

        const mapObj = { source, grid: { ...GRID }, data: z, L0, B0, timestamp: observedISO };
        const dets = detectSignatures(mapObj);

        row.observed_at = observedISO;
        row.carrington_l0 = L0;
        row.carrington_b0 = B0;
        row.detections = dets;
        row.n_detections = dets.length;
        row.n_strong = dets.filter(isStrong).length;
        row.grid_b64 = f32ToBase64(z);
        row.grid_sha256 = createHash('sha256').update(Buffer.from(z.buffer)).digest('hex');
        row.meta = { ...row.meta, src_nx: nx, src_ny: ny, bg_mean: mean, bg_std: std,
                     date_obs: header['DATE-OBS'] || null };
    } else {
        // Image-only upstream (no numeric grid yet). Record metadata + provenance.
        row.observed_at = slotStartISO();
        const eph = carringtonL0(new Date(row.observed_at));
        row.carrington_l0 = eph.L0;
        row.carrington_b0 = eph.B0;
        row.meta = { ...row.meta, image_only: true };
    }

    // Archive the original bytes for provenance (optional — needs R2 configured).
    if (R2_CONFIGURED) {
        try {
            const d = new Date(row.observed_at);
            const ext = looksLikeFITS(buf, upstream) ? 'fits'
                      : (up.headers.get('content-type') || '').includes('jpeg') ? 'jpg' : 'png';
            const key = `farside/${source}/${d.getUTCFullYear()}/`
                      + `${String(d.getUTCMonth() + 1).padStart(2, '0')}/`
                      + `${String(d.getUTCDate()).padStart(2, '0')}T`
                      + `${String(d.getUTCHours()).padStart(2, '0')}.${ext}`;
            await putObject(key, Buffer.from(buf), { contentType: up.headers.get('content-type') || undefined });
            row.raw_r2_key = key;
        } catch (e) {
            row.meta = { ...row.meta, r2_error: String(e?.message ?? e).slice(0, 120) };
        }
    }

    await upsertRow(row);
    return { source, observed_at: row.observed_at, n_detections: row.n_detections,
             n_strong: row.n_strong, has_grid: !!row.grid_b64, raw_r2_key: row.raw_r2_key ?? null };
}

export default async function handler(req) {
    if (!isAuthorized(req)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401, headers: { 'Content-Type': 'application/json' },
        });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return new Response(JSON.stringify({ ok: false, reason: 'supabase_not_configured' }), {
            status: 503, headers: { 'Content-Type': 'application/json' },
        });
    }

    const t0 = Date.now();
    // Guard: if the run wedges, record a failure heartbeat before Vercel kills us.
    let done = false;
    const guard = setTimeout(() => { if (!done) recordFailure('watchdog_timeout'); }, WATCHDOG_MS);

    const results = [];
    let gongOk = false;

    // GONG first (required); imagers + HMI best-effort.
    for (const source of ['gong', ...SOURCES.filter((s) => s !== 'gong')]) {
        try {
            const r = await ingestSource(source);
            results.push({ ok: true, ...r });
            if (source === 'gong') gongOk = true;
        } catch (e) {
            results.push({ ok: false, source, error: String(e?.message ?? e).slice(0, 200) });
        }
    }

    let trimmed = 0;
    if (gongOk) {
        await recordSuccess('gong');
        trimmed = await callTrim();
    } else {
        await recordFailure(results.find((r) => r.source === 'gong')?.error || 'gong_failed');
    }

    done = true;
    clearTimeout(guard);

    return new Response(JSON.stringify({ ok: gongOk, results, trimmed, dur_ms: Date.now() - t0 }), {
        status: gongOk ? 200 : 502,
        headers: { 'Content-Type': 'application/json' },
    });
}
