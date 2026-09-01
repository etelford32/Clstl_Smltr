/**
 * Vercel Node Cron: /api/cron/validation-rerun
 *
 * DAILY re-run of both Sun→Earth validation studies over the rolling
 * solar_wind_samples window, appending one row per study to
 * public.validation_runs (service-role-only table — see
 * supabase-validation-runs-migration.sql):
 *
 *   backmap     — attribution scoring: how often fast-wind arrivals
 *                 back-map to a catalogued coronal hole vs chance
 *                 (RING_CURRENT_BACKMAP_VALIDATION.md)
 *   recurrence  — out-of-sample hindcast: predicted vs actual stream
 *                 arrival day/speed per hole
 *                 (RING_CURRENT_RECURRENCE_VALIDATION.md)
 *
 * Plus the CME VALIDATION PROGRAM live loop (Phases 2–3 of
 * CME_FORECAST_VALIDATION_PLAN.md, added 2026-07-23): every Earth-relevant
 * DONKI CME gets a durable cme_events row and issue-time-LOCKED forecast
 * rows per model (enlil / ballistic-v1 / dbm-v1 — INSERT-only, re-issued
 * on kinematic revision); after passage the run resolves L1 truth
 * (Pdyn-step shock or honest false-alarm — a data gap stays 'pending')
 * into cme_l1_observations. The cme_model_skill view over these tables
 * is served by /api/cme/skill and rendered on the space-weather CME
 * calendar scorecard. Decision logic is pure and node-tested
 * (validation-scoring.js: rtEventId, needsNewIssue, resolveEventTruth).
 *
 * The scoring engine is js/validation-scoring.js — the same code the CLI
 * scripts run, so a cron row and a hand run are always comparable. As the
 * archive grows past one Carrington rotation the daily rows become a
 * genuine skill time-series (the quotable numbers).
 *
 * Wind: validation_wind_buckets RPC (6-h medians, service-role).
 * Holes: HEK her API, SPoCA only, chunked 3-day windows over the last
 * 21 days, deduped per day on a 5° Carrington grid (same rules as
 * api/hek/coronal-holes.js). Individual chunk failures are tolerated —
 * a partial catalog is reported, never silently treated as complete.
 *
 * Auth: x-vercel-cron header, or Authorization: Bearer ${CRON_SECRET}.
 * Schedule: vercel.json → 06:30 UT daily (after HEK's overnight backlog).
 *
 * Response: 200 { ok, window, buckets, holes, hekChunksFailed,
 *                 backmap: {...}, recurrence: {...}, cmeProgram, fluxRope,
 *                 dur_ms }
 *
 * OPS POSTMORTEM (2026-07-29, from Vercel runtime logs): this function ran
 * ONCE (07-12) and then silently produced nothing for 17 days. Three
 * compounding causes, all fixed here — do not reintroduce them:
 *   1. `runtime: 'nodejs'` IGNORES a Web-style `return Response`
 *      (the (req, res) signature is the contract) — every response,
 *      including the watchdog's, was dropped and the platform killed the
 *      invocation at 60 s. Handler now writes through `res`.
 *   2. The HEK chunk fetches ran SERIALLY (7 × ≤12 s = 84 s worst case),
 *      blowing the 60 s budget before the first insert on slow days.
 *      Chunks now fetch in parallel with a 6 s per-chunk timeout.
 *   3. The CME program ran AFTER the HEK-dependent studies, so HEK
 *      trouble starved the record-before-predict ledger. The program +
 *      flux-rope block now run FIRST (DONKI + Supabase only) and the
 *      study early-outs carry their partial results instead of aborting.
 */

import { readFile } from 'node:fs/promises';
import { fetchWithTimeout } from '../_lib/responses.js';
import {
    backmapRows, backmapScore, runHindcast, BACKMAP,
    detectShockArrivals, scoreCmeArrivals,
    rtEventId, needsNewIssue, resolveEventTruth, uniformBatch,
} from '../../js/validation-scoring.js';
import { cmeTransit } from '../../js/ring-current-model.js';
import { CmeEvent } from '../../js/cme-propagation.js';
import {
    parseDonkiFlares, fluxRopeForecastRows, arrivalQuantilesH,
    resolveBzTruth, scoreFluxRopeEvent, aggregateFluxRopeScores,
    FLUX_ROPE_MODEL_ID, ARRIVAL_Q_LEVELS,
} from '../../js/flux-rope-validation.js';
import { retrievedPopulation } from '../../js/flux-rope-inversion.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const WATCHDOG_MS = 50_000;   // real margin under the 60 s platform kill
const HEK_BASE = 'https://www.lmsal.com/hek/her';
const HEK_DAYS = 21;
const HEK_CHUNK_DAYS = 3;
const DAY = 86.4e6;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';

// Node-runtime request: headers are a plain object, NOT a Headers map.
function isAuthorized(req) {
    const hdr = req.headers?.authorization ?? '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (req.headers?.['x-vercel-cron']) return true;
    return false;
}

const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
};

async function fetchBuckets() {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/validation_wind_buckets`, {
        method: 'POST', timeoutMs: 10_000, headers: sbHeaders,
        body: JSON.stringify({ p_days: 16 }),
    });
    if (!res.ok) throw new Error(`wind_buckets ${res.status}`);
    const rows = await res.json();
    return rows
        .map(r => ({ t: Date.parse(r.bucket), v: r.v_med, vMed: r.v_med }))
        .filter(r => Number.isFinite(r.t) && Number.isFinite(r.v))
        .sort((a, b) => a.t - b.t);
}

/** HEK SPoCA detections, chunked + deduped per day on a 5° grid.
 *  Chunks fetch IN PARALLEL with a tight per-chunk timeout — the serial
 *  ≤12 s × 7 version could exceed the 60 s platform budget on slow HEK
 *  days and killed the whole cron (see the header postmortem). */
async function fetchHoles(endMs) {
    const nChunks = Math.ceil(HEK_DAYS / HEK_CHUNK_DAYS);
    const chunkRows = await Promise.all(Array.from({ length: nChunks }, (_, k) => (async () => {
        const c1 = new Date(endMs - (k + 1) * HEK_CHUNK_DAYS * DAY).toISOString().replace(/\.\d{3}Z$/, '');
        const c2 = new Date(endMs - k * HEK_CHUNK_DAYS * DAY).toISOString().replace(/\.\d{3}Z$/, '');
        const params = new URLSearchParams({
            cmd: 'search', type: 'column', event_type: 'ch',
            event_coordsys: 'helioprojective', x1: '-3000', x2: '3000', y1: '-3000', y2: '3000',
            event_starttime: c1, event_endtime: c2,
            result_limit: '200', cosec: '2',
            return: 'frm_name,hgs_y,hgc_x,event_starttime',
        });
        try {
            const res = await fetchWithTimeout(`${HEK_BASE}?${params}`, {
                timeoutMs: 6_000, headers: { Accept: 'application/json' },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const raw = await res.json();
            return raw?.result ?? [];
        } catch {
            return null;   // counted as a failed chunk; partial catalogs are reported
        }
    })()));
    const holes = [];
    let failed = 0;
    const seen = new Map();   // day_lat5_lon5 → true (chunk order preserved)
    for (const rows of chunkRows) {
        if (rows === null) { failed++; continue; }
        for (const r of rows) {
            if (!/spoca/i.test(r.frm_name ?? '')) continue;
            const lat = parseFloat(r.hgs_y);
            const lonCar = ((parseFloat(r.hgc_x) % 360) + 360) % 360;
            const day = String(r.event_starttime ?? '').slice(0, 10);
            if (!isFinite(lat) || !isFinite(lonCar) || day.length !== 10) continue;
            const key = `${day}_${Math.round(lat / 5) * 5}_${Math.round(lonCar / 5) * 5}`;
            if (seen.has(key)) continue;
            seen.set(key, true);
            holes.push({ day, lat, lonCar });
        }
    }
    return { holes, failed };
}

/** 15-min Pdyn medians (validation_pdyn_series RPC) for shock detection. */
async function fetchPdynSeries() {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/validation_pdyn_series`, {
        method: 'POST', timeoutMs: 10_000, headers: sbHeaders,
        body: JSON.stringify({ p_days: 16 }),
    });
    if (!res.ok) throw new Error(`pdyn_series ${res.status}`);
    const rows = await res.json();
    return rows
        .map(r => ({ t: Date.parse(r.bucket), pdyn: r.pdyn_med }))
        .filter(r => Number.isFinite(r.t) && Number.isFinite(r.pdyn))
        .sort((a, b) => a.t - b.t);
}

/**
 * DONKI catalog for the window: CMEAnalysis rows deduped per physical CME
 * (isMostAccurate preferred) + the newest WSA-ENLIL Earth-arrival sim per
 * cme id, reduced to the kinematics both the verifier (study 3) and the
 * forecast-locking loop consume. Direct NASA calls — the key lives in
 * this runtime's env, same as the /api/donki/cme proxy.
 */
async function fetchDonkiCatalog(windowStart, windowEnd) {
    const NASA_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';
    const fmt = ms => new Date(ms).toISOString().slice(0, 10);
    const start = fmt(windowStart - 5 * DAY), end = fmt(windowEnd + DAY);
    const get = async (path) => {
        const res = await fetchWithTimeout(
            `https://api.nasa.gov/DONKI/${path}?startDate=${start}&endDate=${end}&api_key=${NASA_KEY}`,
            { headers: { Accept: 'application/json' }, timeoutMs: 12_000 });
        if (!res.ok) throw new Error(`DONKI ${path} ${res.status}`);
        return res.json();
    };
    // FLR rides along for the per-flare ledger ("for each flare"); its
    // failure never blocks the CME program — flare tags are enrichment.
    const [analyses, sims, flrRaw] = await Promise.all([
        get('CMEAnalysis'), get('WSAEnlilSimulations'), get('FLR').catch(() => []),
    ]);
    // Newest Earth-arrival simulation per cme id.
    const enlilByCme = new Map();
    for (const s of Array.isArray(sims) ? sims : []) {
        if (!s?.estimatedShockArrivalTime) continue;
        for (const inp of s.cmeInputs ?? []) {
            if (!inp?.cmeid) continue;
            const prev = enlilByCme.get(inp.cmeid);
            if (!prev || String(s.modelCompletionTime ?? '') > String(prev.modelCompletionTime ?? '')) {
                enlilByCme.set(inp.cmeid, s);
            }
        }
    }
    // Dedupe analyses per physical CME, most-accurate preferred.
    const byId = new Map();
    for (const c of Array.isArray(analyses) ? analyses : []) {
        if (!c?.time21_5 || !c?.associatedCMEID) continue;
        const prev = byId.get(c.associatedCMEID);
        if (!prev || (c.isMostAccurate === true && prev.isMostAccurate !== true)) {
            byId.set(c.associatedCMEID, c);
        }
    }
    const rows = [];
    for (const [id, c] of byId) {
        const launchMs = Date.parse(c.time21_5);
        const speed = parseFloat(c.speed);
        if (!Number.isFinite(launchMs) || !Number.isFinite(speed)) continue;
        const lat = parseFloat(c.latitude) || 0;
        const lon = parseFloat(c.longitude) || 0;
        const half = parseFloat(c.halfAngle);
        const sim = enlilByCme.get(id);
        const enlilMs = sim ? Date.parse(sim.estimatedShockArrivalTime) : NaN;
        const enlilKp = sim ? Math.max(sim.kp_90 ?? -1, sim.kp_135 ?? -1, sim.kp_180 ?? -1) : -1;
        const miss = Math.hypot(lat, lon);
        rows.push({
            id, launchMs, speed, lat, lon,
            half: Number.isFinite(half) ? half : null,
            type: c.type ?? null,
            enlilMs: Number.isFinite(enlilMs) ? enlilMs : null,
            enlilKp: enlilKp >= 0 ? enlilKp : null,
            earthRelevant: (Number.isFinite(half) && miss <= half + 20) || sim?.isEarthGB === true,
        });
    }
    return { rows, flares: parseDonkiFlares(flrRaw) };
}

/** Study-3 verifiable predictions from the catalog (ETA inside window). */
function cmePredictionsFrom(catalog, windowStart, windowEnd) {
    const preds = [];
    for (const c of catalog) {
        if (!c.earthRelevant) continue;
        const tr = cmeTransit(c.launchMs, c.speed, windowEnd);
        if (!tr) continue;
        const etaMs = c.enlilMs ?? tr.etaMs;
        if (etaMs < windowStart || etaMs > windowEnd) continue;   // unverifiable here
        preds.push({
            id: c.id, etaMs,
            basis: c.enlilMs != null ? 'enlil' : 'ballistic',
            enlilEtaMs: c.enlilMs,
            ballisticEtaMs: tr.etaMs,
        });
    }
    return preds;
}

/* ── CME forecast LOCKING + truth RESOLUTION (validation program §2–3) ──
   The record-before-predict loop: every Earth-relevant DONKI CME gets a
   cme_events row at first sight plus ONE issue-time-locked forecast row
   per model (enlil when modeled / ballistic-v1 / dbm-v1) — re-issued as
   a NEW row when DONKI revises kinematics, never updated. After passage
   the same run resolves L1 truth from the detected shocks (arrived /
   false-alarm, with the data-coverage guard in resolveEventTruth) so the
   cme_model_skill view — served by /api/cme/skill and rendered on the
   space-weather calendar scorecard — accretes real per-model skill. */

async function sbGet(path) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
        timeoutMs: 10_000, headers: sbHeaders,
    });
    if (!res.ok) throw new Error(`GET ${path.split('?')[0]} ${res.status}`);
    return res.json();
}

async function sbInsert(table, rows, prefer = 'return=minimal') {
    if (!rows.length) return;
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST', timeoutMs: 10_000,
        headers: { ...sbHeaders, Prefer: prefer },
        body: JSON.stringify(rows),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`insert ${table} ${res.status}: ${text.slice(0, 160)}`);
    }
}

async function lockAndResolveCme(catalog, pdynSeries, nowMs) {
    const summary = { events: 0, locked: 0, resolved: 0, falseAlarms: 0, pending: 0 };
    const relevant = catalog.filter(c => c.earthRelevant);
    const iso = ms => new Date(ms).toISOString();

    // 1 ── Events at first sight (INSERT, never overwrite — the frozen
    //      per-forecast `inputs` carry any later kinematic revisions).
    if (relevant.length) {
        await sbInsert('cme_events?on_conflict=event_id', relevant.map(c => ({
            event_id: rtEventId(c.id), donki_id: c.id,
            launch_time_utc: iso(c.launchMs), cme_type: c.type,
            speed_kms_3d: c.speed, half_width_deg: c.half,
            direction_lat_deg: c.lat, direction_lon_deg: c.lon,
            is_earth_directed: true, is_hindcast: false,
        })), 'return=minimal,resolution=ignore-duplicates');
        summary.events = relevant.length;
    }

    // 2 ── Issue-time-locked forecasts (one row per model, re-issue on
    //      revision > CME_LOCK.REVISION_MIN_H — needsNewIssue decides).
    const ids = relevant.map(c => rtEventId(c.id));
    const inList = `in.(${ids.map(encodeURIComponent).join(',')})`;
    const existing = ids.length ? await sbGet(
        `cme_arrival_forecasts?event_id=${inList}` +
        '&select=event_id,model_id,predicted_arrival_utc&order=issued_at.desc') : [];
    const latest = new Map();   // event|model → latest predicted ms
    for (const r of existing) {
        const k = `${r.event_id}|${r.model_id}`;
        if (!latest.has(k)) latest.set(k, Date.parse(r.predicted_arrival_utc));
    }
    const toInsert = [];
    for (const c of relevant) {
        const eid = rtEventId(c.id);
        const frozen = { donki_id: c.id, launch: iso(c.launchMs), speed_kms: c.speed,
                         half_deg: c.half, lat_deg: c.lat, lon_deg: c.lon };
        // dbm-v1: the SAME CmeEvent model the dashboard/globe display —
        // adaptiveGamma drag + sheath compression + O'Brien/Newell impact.
        const dbm = new CmeEvent({ time: iso(c.launchMs), speed: c.speed,
            halfAngle: c.half ?? 30, earthDirected: true,
            latitude: c.lat, longitude: c.lon }, 400);
        const models = [
            c.enlilMs != null && { model_id: 'enlil',
                predicted_arrival_utc: iso(c.enlilMs),
                predicted_kp_max: c.enlilKp,
                inputs: { ...frozen, source: 'DONKI WSAEnlilSimulations' } },
            (() => {
                const tr = cmeTransit(c.launchMs, c.speed, nowMs);
                return tr && { model_id: 'ballistic-v1',
                    predicted_arrival_utc: iso(tr.etaMs),
                    arrival_window_early: iso(tr.etaEarlyMs),
                    arrival_window_late: iso(tr.etaLateMs),
                    inputs: { ...frozen, method: 'constant-speed 21.5Rs→1AU ±15%' } };
            })(),
            { model_id: 'dbm-v1',
                predicted_arrival_utc: iso(dbm.arrival_ms),
                predicted_speed_at_l1: Math.round(dbm.v_arrival),
                predicted_kp_max: dbm.impact?.kp_max ?? null,
                predicted_dst_min_nt: dbm.impact?.dst_min ?? null,
                inputs: { ...frozen, v_sw: 400, gamma_per_km: dbm.gamma,
                          method: 'DBM Vrsnak-2013 adaptiveGamma' } },
        ].filter(Boolean);
        for (const m of models) {
            const predMs = Date.parse(m.predicted_arrival_utc);
            // Issue-BEFORE-arrival honesty: a row whose predicted arrival
            // is already past is a postdiction, not a forecast — /api/cme/
            // skill promises "locked BEFORE arrival". This matters on a
            // recovery day (a broken run backfilled later would otherwise
            // issue rows for CMEs that already hit) and on late DONKI
            // revisions after passage.
            if (!(predMs > nowMs)) continue;
            if (needsNewIssue(latest.get(`${eid}|${m.model_id}`) ?? null, predMs)) {
                toInsert.push({ event_id: eid, ...m });
            }
        }
    }
    // uniformBatch is LOAD-BEARING: the three models emit different key
    // sets (enlil has no window, only dbm has speed/dst) and PostgREST
    // rejects a mixed-key bulk insert wholesale (PGRST102) — that
    // rejection silently zeroed this ledger for four weeks.
    await sbInsert('cme_arrival_forecasts', uniformBatch(toInsert));
    summary.locked = toInsert.length;

    // 3 ── Truth resolution after passage (arrived / false-alarm /
    //      still-pending — a Pdyn data gap can never become a false alarm).
    const sinceIso = iso(nowMs - 20 * DAY);
    const recent = await sbGet('cme_events?is_hindcast=eq.false' +
        `&launch_time_utc=gte.${encodeURIComponent(sinceIso)}&select=event_id`);
    const openIds = recent.map(r => r.event_id);
    if (openIds.length) {
        const openIn = `in.(${openIds.map(encodeURIComponent).join(',')})`;
        const [obs, fcs] = await Promise.all([
            sbGet(`cme_l1_observations?event_id=${openIn}&select=event_id`),
            sbGet(`cme_arrival_forecasts?event_id=${openIn}` +
                  '&select=event_id,predicted_arrival_utc'),
        ]);
        const resolved = new Set(obs.map(r => r.event_id));
        const predsByEvent = new Map();
        for (const f of fcs) {
            if (!predsByEvent.has(f.event_id)) predsByEvent.set(f.event_id, []);
            predsByEvent.get(f.event_id).push(Date.parse(f.predicted_arrival_utc));
        }
        const shocks = detectShockArrivals(pdynSeries);
        const seriesStartMs = pdynSeries[0]?.t, seriesEndMs = pdynSeries.at(-1)?.t;
        const truthRows = [];
        for (const [eid, preds] of predsByEvent) {
            if (resolved.has(eid)) continue;
            const r = resolveEventTruth({ predictedMsList: preds, shocks, nowMs,
                                          seriesStartMs, seriesEndMs });
            if (r.status === 'pending') { summary.pending++; continue; }
            truthRows.push({
                event_id: eid,
                arrived: r.status === 'arrived',
                shock_arrival_utc: r.status === 'arrived' ? iso(r.shockMs) : null,
                source: 'RTSW',
                notes: r.status === 'arrived'
                    ? 'Pdyn-step shock (detectShockArrivals) matched to locked forecast'
                    : 'no shock in alarm window; Pdyn series covered it',
            });
            if (r.status === 'arrived') summary.resolved++;
            else summary.falseAlarms++;
        }
        await sbInsert('cme_l1_observations?on_conflict=event_id', truthRows,
            'return=minimal,resolution=ignore-duplicates');
    }
    return summary;
}

async function sbPatch(path, body) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
        method: 'PATCH', timeoutMs: 10_000,
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`patch ${path.split('?')[0]} ${res.status}`);
}

/* ── flux-rope-v1: per-flare compounding-train lock + Bz truth + scoring ──
   The flux-rope engine joins the SAME issue-time-locked ledger as enlil /
   ballistic-v1 / dbm-v1 — but as a compounding-TRAIN model with
   probabilistic content (FLUX_ROPE_SIMULATOR_PLAN.md "daily validation"):
     · lock: the shared provider (committed WASM, spec §12.1 train
       selection, §16 interaction, measured-noise σ/δ) runs server-side;
       ONE row per flare-associated CME of the modeled train, with frozen
       replayable inputs (train ids ⇒ deterministic seed), a parametric
       ±σ_v0 arrival window from the EFFECTIVE wake kinematics, and the
       train-onset arrival quantiles on the first-arriving row.
     · truth: the existing shock resolver rows are ENRICHED with
       Bz-structure truth (min Bz + first-hour arrival speed) from
       sw_geomag_dataset — coverage-guarded, a gap stays pending.
     · score: arrival error + CRPS + Brier trio + min-Bz error + the §5
       DBM inversion (retrieved Γ/w → population priors) →
       validation_runs kind='flux-rope' (episodic — only when something
       scored). Pure logic in js/flux-rope-validation.js, node-gated. */

async function lockAndScoreFluxRope(catalog, flares, nowMs) {
    const summary = { locked: 0, scored: 0, bzResolved: 0, idle: null };
    const iso = ms => new Date(ms).toISOString();

    // 1 ── The shared provider on the committed WASM (aurora-cron precedent).
    const [{ computeFluxRopeForecast, trainSeed }, { rtswDriver }, { measureCompounding }]
        = await Promise.all([
            import('../../js/flux-rope-forecast.js'),
            import('../../js/flux-rope-live.js'),
            import('../../js/flux-rope-compounding.js'),
        ]);
    const wasm = await readFile(new URL('../../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url));
    const cmes = catalog.map(c => ({
        id: c.id,
        timeIso: iso(c.launchMs),
        speedKms: c.speed,
        latDeg: c.lat,
        lonDeg: c.lon,
        halfAngleDeg: Number.isFinite(c.half) ? c.half : 30,
        earthDirected: Number.isFinite(c.half) && Math.hypot(c.lat, c.lon) <= c.half,
    }));
    let rtsw = null;
    try {
        const get = async (url) => {
            const r = await fetchWithTimeout(url, { timeoutMs: 12_000 });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        };
        const [mag, wind] = await Promise.all([
            get('https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json'),
            get('https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json'),
        ]);
        rtsw = rtswDriver(mag, wind);
    } catch { /* prior-only lock is honest */ }
    const fc = await computeFluxRopeForecast({ sources: { cmes, rtsw, wasm }, nowMs });

    // 2 ── Lock the per-flare rows (INSERT-only, needsNewIssue gating).
    if (fc.idle) {
        summary.idle = fc.reason;
    } else {
        const eff = fc.preset.ropes.map((_, i) => ({
            wEffKms: fc.kernel.ropeWEffKms(i),
            gammaEffPerKm: fc.kernel.ropeGammaEff(i),
        }));
        // §16 counterfactual for multi-rope trains — the SAME measurement
        // sun.html renders, locked here so it gets SCORED after passage.
        // Its failure degrades to "no compounding block", never a failed
        // lock (the plain forecast rows still land).
        let compounding = null;
        if (fc.preset.ropes.length >= 2) {
            try {
                compounding = await measureCompounding(fc,
                    { wasm, quantileLevels: ARRIVAL_Q_LEVELS });
            } catch { compounding = null; }
        }
        summary.compounding = compounding != null;
        const rows = fluxRopeForecastRows({
            eventIdFor: (id) => rtEventId(id),
            cmes: fc.cmes,
            ropes: fc.preset.ropes,
            eff,
            sigV0Kms: fc.preset.spreads?.sigV0Kms ?? 100,
            launchMs: fc.launchMs,
            seed: trainSeed(fc.cmes),
            summary: fc.summary,
            arrivalQH: arrivalQuantilesH(fc.prior.arrivalH),
            sigmaNt: fc.sigmaNt,
            sheathDeltaNt: fc.sheathDeltaNt,
            noiseSigmaNt: fc.noise?.ok ? fc.noise.sigmaNt : null,
            flares,
            compounding,
        });
        if (rows.length) {
            const ids = rows.map(r => r.event_id);
            const inList = `in.(${ids.map(encodeURIComponent).join(',')})`;
            const existing = await sbGet(
                `cme_arrival_forecasts?event_id=${inList}&model_id=eq.${FLUX_ROPE_MODEL_ID}` +
                '&select=event_id,predicted_arrival_utc&order=issued_at.desc');
            const latest = new Map();
            for (const r of existing) {
                if (!latest.has(r.event_id)) latest.set(r.event_id, Date.parse(r.predicted_arrival_utc));
            }
            const toInsert = rows.filter(r =>
                needsNewIssue(latest.get(r.event_id) ?? null, Date.parse(r.predicted_arrival_utc)));
            await sbInsert('cme_arrival_forecasts', toInsert);
            summary.locked = toInsert.length;
        }
    }

    // 3 ── Bz-structure truth enrichment + per-flare probabilistic scoring
    //      over the trailing 20 days of locked flux-rope rows.
    const since = iso(nowMs - 20 * DAY);
    const frRows = await sbGet(
        `cme_arrival_forecasts?model_id=eq.${FLUX_ROPE_MODEL_ID}` +
        `&issued_at=gte.${encodeURIComponent(since)}` +
        '&select=event_id,predicted_arrival_utc,predicted_hit,inputs,issued_at&order=issued_at.desc');
    if (!frRows.length) return summary;
    const latestByEvent = new Map();
    for (const r of frRows) {
        if (!latestByEvent.has(r.event_id)) latestByEvent.set(r.event_id, r);
    }
    const evIn = `in.(${[...latestByEvent.keys()].map(encodeURIComponent).join(',')})`;
    const [obs, events] = await Promise.all([
        sbGet(`cme_l1_observations?event_id=${evIn}` +
              '&select=event_id,arrived,shock_arrival_utc,observed_bz_min_nt,observed_speed_kms'),
        sbGet(`cme_events?event_id=${evIn}&select=event_id,launch_time_utc`),
    ]);
    const launchByEvent = new Map(events.map(e => [e.event_id, e.launch_time_utc]));
    const scores = [];
    for (const o of obs) {
        const locked = latestByEvent.get(o.event_id);
        if (!locked) continue;
        const truth = {
            arrived: o.arrived === true,
            shockMs: o.shock_arrival_utc ? Date.parse(o.shock_arrival_utc) : NaN,
            minBzNt: Number.isFinite(o.observed_bz_min_nt) ? o.observed_bz_min_nt : NaN,
            vAtShockKms: Number.isFinite(o.observed_speed_kms) ? o.observed_speed_kms : NaN,
        };
        if (truth.arrived && Number.isFinite(truth.shockMs) && !Number.isFinite(truth.minBzNt)) {
            // One-time enrichment from the minute dataset; a coverage gap
            // stays pending and the next run retries.
            try {
                const t0 = iso(truth.shockMs - 60e3);
                const t1 = iso(truth.shockMs + 48 * 3.6e6);
                const ds = await sbGet(
                    `sw_geomag_dataset?t=gte.${encodeURIComponent(t0)}&t=lte.${encodeURIComponent(t1)}` +
                    '&select=t,sw_bz_nt,sw_v_km_s,sw_flag&order=t.asc&limit=3000');
                const bt = resolveBzTruth({
                    rows: ds.map(r => ({
                        tMs: Date.parse(r.t),
                        bz: r.sw_flag === 'gap' ? NaN : r.sw_bz_nt,
                        v: r.sw_flag === 'ok' ? r.sw_v_km_s : NaN,
                    })),
                    shockMs: truth.shockMs,
                });
                if (bt.status === 'resolved') {
                    truth.minBzNt = bt.minBzNt;
                    truth.vAtShockKms = bt.vAtShockKms;
                    await sbPatch(`cme_l1_observations?event_id=eq.${encodeURIComponent(o.event_id)}`, {
                        observed_bz_min_nt: bt.minBzNt,
                        observed_speed_kms: Number.isFinite(bt.vAtShockKms)
                            ? Math.round(bt.vAtShockKms) : null,
                    });
                    summary.bzResolved++;
                }
            } catch { /* retried next run */ }
        }
        if ((truth.arrived && Number.isFinite(truth.shockMs)) || o.arrived === false) {
            scores.push(scoreFluxRopeEvent({
                forecast: locked, truth, launchIso: launchByEvent.get(o.event_id),
            }));
        }
    }
    if (scores.length) {
        const agg = aggregateFluxRopeScores(scores);
        await insertRun({
            kind: 'flux-rope',
            window_start: since,
            window_end: iso(nowMs),
            n_forecasts: agg.n_forecasts,
            hits: agg.hits,
            hit_rate: agg.n_forecasts ? agg.hits / agg.n_forecasts : null,
            mae_days: agg.maeHours != null ? agg.maeHours / 24 : null,
            skill: agg.n_forecasts ? agg.hits / agg.n_forecasts : null,
            metrics: {
                maeHours: agg.maeHours,
                biasHours: agg.biasHours,
                crpsArrivalH: agg.crpsArrivalH,
                brierHit: agg.brierHit,
                brier10: agg.brier10,
                brier20: agg.brier20,
                minBzMaeNt: agg.minBzMaeNt,
                inversionN: agg.inversions.length,
                // Retrieved-drag population — the priors the ledger says
                // the ensemble SHOULD be using (spec §19 feedback loop).
                population: retrievedPopulation(agg.inversions),
                // §16 counterfactual scored vs outcomes (trains only) —
                // followerBiasOnH/ampObs-vs-ampPred are the §19–§21
                // knob-fitting evidence (flux-rope-validation.js header).
                compounding: agg.compounding,
            },
            detail: { events: scores },
        });
        summary.scored = scores.length;
    }
    return summary;
}

async function insertRun(row) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/validation_runs`, {
        method: 'POST', timeoutMs: 8_000,
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(row),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`insert_run ${res.status}: ${text.slice(0, 200)}`);
    }
}

async function runValidation(req) {
    const started = Date.now();
    if (!isAuthorized(req)) {
        return { status: 401, body: { error: 'unauthorized' } };
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return { status: 503, body: { ok: false, reason: 'supabase_not_configured' } };
    }

    // ── CME program + flux-rope per-flare ledger FIRST (DONKI + Supabase
    //    only — see the header postmortem: HEK trouble or a late-run budget
    //    kill must never starve the record-before-predict ledger).
    const nowMs = Date.now();
    let catalog = [], flares = [], pdynSeries = [];
    let cmeProgram = { reason: 'not_run' };
    try {
        const [donki, pdyn] = await Promise.all([
            fetchDonkiCatalog(nowMs - 16 * DAY, nowMs),
            fetchPdynSeries(),
        ]);
        catalog = donki.rows;
        flares = donki.flares;
        pdynSeries = pdyn;
        cmeProgram = await lockAndResolveCme(catalog, pdynSeries, nowMs);
    } catch (e) {
        cmeProgram = { reason: `lock_resolve_failed: ${String(e?.message || e)}` };
        // The response body goes to a cron nobody reads — without this
        // line a daily ledger failure is invisible in Vercel logs (it
        // was, for four weeks).
        console.error('validation-rerun:', cmeProgram.reason);
    }
    let fluxRope = { reason: 'not_run' };
    try {
        if (catalog.length) fluxRope = await lockAndScoreFluxRope(catalog, flares, Date.now());
        else fluxRope = { reason: 'no_catalog' };
    } catch (e) {
        fluxRope = { reason: `flux_rope_failed: ${String(e?.message || e)}` };
        console.error('validation-rerun:', fluxRope.reason);
    }
    const ledger = { cmeProgram, fluxRope };

    // ── Studies 1–3 (wind-bucket + HEK dependent). Early-outs carry the
    //    ledger results — partial success is success.
    const buckets = await fetchBuckets().catch(() => []);
    if (buckets.length < 8) {
        return { status: 200, body: {   // 200: a thin archive, not an infra failure
            ok: false, reason: 'insufficient_wind_data', buckets: buckets.length,
            ...ledger, dur_ms: Date.now() - started,
        } };
    }
    const windowStart = buckets[0].t, windowEnd = buckets[buckets.length - 1].t;
    const { holes, failed: hekChunksFailed } = await fetchHoles(windowEnd);
    if (!holes.length) {
        return { status: 502, body: {
            ok: false, reason: 'hek_unavailable', hekChunksFailed,
            ...ledger, dur_ms: Date.now() - started,
        } };
    }

    // ── Study 1: back-mapping attribution ────────────────────────────
    const bmScore = backmapScore(backmapRows(buckets, holes));
    const bm20 = bmScore.fast?.tol?.[20] ?? {};
    await insertRun({
        kind: 'backmap',
        window_start: new Date(windowStart).toISOString(),
        window_end: new Date(windowEnd).toISOString(),
        n_forecasts: bmScore.fast?.n ?? 0,
        hits: bm20.hits ?? null,
        hit_rate: bm20.hitRate ?? null,
        mae_days: null,
        skill: bm20.skill ?? null,
        metrics: { tols: BACKMAP.TOLS, score: bmScore, holes: holes.length },
    });

    // ── Study 2: recurrence hindcast ─────────────────────────────────
    const rc = runHindcast(buckets, holes);
    await insertRun({
        kind: 'recurrence',
        window_start: new Date(windowStart).toISOString(),
        window_end: new Date(windowEnd).toISOString(),
        n_forecasts: rc.n,
        hits: rc.hits,
        hit_rate: rc.hitRate,
        mae_days: rc.maeDays,
        skill: rc.timingSkill,
        metrics: {
            matched: rc.matched, maeSpeed: rc.maeSpeed,
            independentEvents: rc.independentEvents, missedOnsets: rc.missedOnsets,
            onsets: rc.onsets,
        },
        detail: {
            forecasts: rc.forecasts.map(f => ({
                issue: f.issue, lat: f.lat, lonCar: Math.round(f.lonCar),
                basis: f.basis, vPred: Math.round(f.vPred),
                arriveMs: f.arriveMs, dtDays: f.dtDays, vObs: f.vObs, hit: f.hit,
            })),
        },
    });

    // ── Study 3: CME arrival verification (predicted vs actual shock) ──
    //    (catalog + pdynSeries were fetched by the ledger block above.)
    // Only inserts when there was something to verify — CMEs are episodic
    // and an empty run would poison the sparkline with zeros.
    let cmeSummary = { n: 0, reason: 'no verifiable predictions in window' };
    try {
        const preds = cmePredictionsFrom(catalog, windowStart, windowEnd);
        if (preds.length) {
            const shocks = detectShockArrivals(pdynSeries);
            const sc = scoreCmeArrivals(preds, shocks);
            await insertRun({
                kind: 'cme',
                window_start: new Date(windowStart).toISOString(),
                window_end: new Date(windowEnd).toISOString(),
                n_forecasts: sc.n,
                hits: sc.hits,
                hit_rate: sc.n ? sc.hits / sc.n : null,
                mae_days: sc.maeHours != null ? sc.maeHours / 24 : null,
                skill: sc.n ? sc.hits / sc.n : null,   // sparkline: hit fraction
                metrics: {
                    maeHours: sc.maeHours, matched: sc.matched,
                    byBasis: sc.byBasis, crossCheck: sc.crossCheck,
                    shocks: shocks.length,
                },
                detail: { forecasts: sc.details },
            });
            cmeSummary = {
                n: sc.n, hits: sc.hits, maeHours: sc.maeHours,
                crossCheck: sc.crossCheck, shocksDetected: shocks.length,
            };
        }
    } catch (e) {
        cmeSummary = { n: 0, reason: `cme_verification_failed: ${String(e?.message || e)}` };
    }

    return { status: 200, body: {
        ok: true,
        window: { start: new Date(windowStart).toISOString(), end: new Date(windowEnd).toISOString() },
        buckets: buckets.length,
        holes: holes.length,
        hekChunksFailed,
        backmap: { nFast: bmScore.fast?.n, hitRate20: bm20.hitRate, chance20: bm20.chance, skill20: bm20.skill },
        recurrence: {
            n: rc.n, hits: rc.hits, hitRate: rc.hitRate, maeDays: rc.maeDays,
            timingSkill: rc.timingSkill, independentEvents: rc.independentEvents,
        },
        cme: cmeSummary,
        ...ledger,
        dur_ms: Date.now() - started,
    } };
}

// NODE-runtime signature (req, res): a returned Response is IGNORED here —
// that exact mistake is how this cron 504'd silently for 17 days (header
// postmortem). Every path writes through `res`.
export default async function handler(req, res) {
    let timer;
    const watchdog = new Promise((resolve) => {
        timer = setTimeout(() => resolve({
            status: 504,
            body: { ok: false, reason: 'worker_timeout', budget_ms: WATCHDOG_MS },
        }), WATCHDOG_MS);
    });
    try {
        const out = await Promise.race([runValidation(req), watchdog]);
        res.status(out.status ?? 200).json(out.body ?? {});
    } catch (e) {
        res.status(502).json({ ok: false, reason: String(e?.message || e) });
    } finally {
        clearTimeout(timer);
    }
}
