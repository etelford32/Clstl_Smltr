/**
 * Structural gate for js/pipeline-registry.js — the single source of truth for
 * "the list of pipelines we serve".
 *
 * The registry is consumed by four surfaces that never see each other at
 * runtime (status.html, admin.html, the three prewarm crons, and dev-server's
 * route table), so a malformed or unregistered entry fails SILENTLY: a pipeline
 * with no registry row simply never appears on the status board and never gets
 * pre-warmed. Nothing errors. That is exactly how /api/mars/weather shipped and
 * then sat unmonitored.
 *
 * This gate makes those omissions loud.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    CATEGORIES,
    COLD_PIPELINES,
    HEARTBEAT_PIPELINES,
    HOT_PIPELINES,
    MEDIUM_PIPELINES,
    PIPELINES,
    pipelinesByCategory,
} from '../js/pipeline-registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VALID_PREWARM = new Set(['hot', 'medium', 'cold', null, undefined]);
const categoryIds = new Set(CATEGORIES.map(category => category.id));

// ── Every entry is well-formed ──────────────────────────────────────────────
const seenIds = new Set();
const seenEndpoints = new Set();
for (const pipeline of PIPELINES) {
    const where = pipeline.id || JSON.stringify(pipeline).slice(0, 60);
    assert.match(pipeline.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${where}: id is kebab-case`);
    assert.ok(!seenIds.has(pipeline.id), `${where}: duplicate id`);
    seenIds.add(pipeline.id);

    assert.ok(pipeline.label?.length > 2, `${where}: has a human label`);
    assert.ok(pipeline.upstream?.length > 2, `${where}: names its upstream`);
    assert.match(pipeline.endpoint, /^\/api\//, `${where}: endpoint is a same-origin /api/ path`);
    assert.ok(!seenEndpoints.has(pipeline.endpoint), `${where}: duplicate endpoint ${pipeline.endpoint}`);
    seenEndpoints.add(pipeline.endpoint);

    // A category missing from CATEGORIES renders NO table on the status page —
    // the entry is probed and then silently dropped from the output.
    assert.ok(categoryIds.has(pipeline.category), `${where}: category "${pipeline.category}" is declared in CATEGORIES`);
    assert.ok(VALID_PREWARM.has(pipeline.prewarm), `${where}: prewarm tier "${pipeline.prewarm}" is hot|medium|cold|null`);

    assert.ok(Number.isFinite(pipeline.cadence_s) && pipeline.cadence_s > 0, `${where}: positive cadence_s`);
    assert.ok(Number.isFinite(pipeline.warnAgeS) && pipeline.warnAgeS > 0, `${where}: positive warnAgeS`);
    assert.ok(Number.isFinite(pipeline.critAgeS), `${where}: numeric critAgeS`);
    assert.ok(pipeline.critAgeS > pipeline.warnAgeS, `${where}: critAgeS must exceed warnAgeS`);
    // Warn below the upstream's own publish cadence flags every healthy probe.
    assert.ok(pipeline.warnAgeS >= pipeline.cadence_s,
        `${where}: warnAgeS (${pipeline.warnAgeS}s) must not fire before one upstream cadence (${pipeline.cadence_s}s)`);

    if (pipeline.probePath != null) {
        assert.match(pipeline.probePath, /^\/api\//, `${where}: probePath is a same-origin /api/ path`);
    }
    if (pipeline.probeTimeoutMs != null) {
        assert.ok(pipeline.probeTimeoutMs >= 1000 && pipeline.probeTimeoutMs <= 30_000,
            `${where}: probeTimeoutMs within 1–30 s`);
    }
}

// ── Every endpoint has a handler on disk ────────────────────────────────────
// Catches the reverse omission: a registry row whose route was renamed or never
// created. The prewarm cron would fan out to a 404 forever without complaining.
for (const pipeline of PIPELINES) {
    const path = new URL(`http://x${pipeline.endpoint}`).pathname;
    const file = join(ROOT, `${path.replace(/^\//, '')}.js`);
    assert.ok(existsSync(file), `${pipeline.id}: expected a handler at ${path}.js`);
}

// ── Tier filters partition the registry ─────────────────────────────────────
const tiered = HOT_PIPELINES.length + MEDIUM_PIPELINES.length + COLD_PIPELINES.length;
const unprewarmed = PIPELINES.filter(p => !p.prewarm).length;
assert.equal(tiered + unprewarmed, PIPELINES.length, 'every pipeline lands in exactly one prewarm tier or none');
for (const [tier, list] of [['hot', HOT_PIPELINES], ['medium', MEDIUM_PIPELINES], ['cold', COLD_PIPELINES]]) {
    for (const pipeline of list) assert.equal(pipeline.prewarm, tier, `${pipeline.id}: in the ${tier} filter`);
}

// ── Every category is populated ─────────────────────────────────────────────
for (const category of CATEGORIES) {
    assert.ok(pipelinesByCategory(category.id).length > 0, `${category.id}: category has at least one pipeline`);
}

// ── Heartbeat specs ─────────────────────────────────────────────────────────
const heartbeatKeys = new Set();
for (const spec of HEARTBEAT_PIPELINES) {
    assert.match(spec.key, /^[a-z0-9_]+$/, `${spec.key}: snake_case heartbeat key`);
    assert.ok(!heartbeatKeys.has(spec.key), `${spec.key}: duplicate heartbeat key`);
    heartbeatKeys.add(spec.key);
    assert.ok(spec.label?.length > 2, `${spec.key}: has a label`);
    assert.ok(spec.critMin > spec.warnMin, `${spec.key}: critMin must exceed warnMin`);
}

// ── The Mars pipelines specifically ─────────────────────────────────────────
// mars.html degrades rather than failing, so all three of its routes answer 200
// with a fallback. `freshness: 'stale'` is the ONLY signal that tells the status
// board the difference between "live" and "serving the bundled snapshot" — if
// these rows lose it, a dead NASA feed renders green.
const marsIds = ['mars-ephemeris', 'mars-route', 'mars-weather'];
for (const id of marsIds) {
    const pipeline = PIPELINES.find(entry => entry.id === id);
    assert.ok(pipeline, `${id}: registered`);
    assert.equal(pipeline.category, 'planetary', `${id}: filed under planetary`);
    assert.ok(pipeline.notes?.length > 20, `${id}: carries an operator note about its degraded state`);
}
for (const route of ['api/mars/ephemeris.js', 'api/mars/route.js', 'api/mars/weather.js']) {
    const source = readFileSync(join(ROOT, route), 'utf8');
    assert.match(source, /freshness: 'stale'/,
        `${route}: must emit freshness:'stale' when degraded, or the status page scores a fallback as healthy`);
}
// Local routing is covered by the handler-on-disk check above: dev-server.mjs
// falls back to Vercel's file-based convention (/api/foo/bar → api/foo/bar.js)
// for anything not in its explicit alias table, so a handler that exists is a
// handler that resolves both locally and in production.

console.log(`pipeline-registry: ${PIPELINES.length} pipelines across ${CATEGORIES.length} categories, ${HEARTBEAT_PIPELINES.length} heartbeats — structure, handlers, tiers, and Mars degradation signals passed`);
