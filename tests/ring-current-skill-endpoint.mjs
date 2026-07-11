#!/usr/bin/env node
/**
 * ring-current-skill-endpoint.mjs — pure-Node tests for the aggregation core
 * of api/ring-current/skill.js (ledgerSkillSummary — the published
 * ring_current_log ⨝ geomag_indices join):
 *
 *   1. Known constant offset: model −20 vs observed −25 hourly ⇒ RMSE 5,
 *      bias +5 in both windows; pair counts match the observed cadence.
 *   2. Window separation: an error burst older than 24 h moves h24 ≠ d7.
 *   3. Daily buckets: 7 stable UTC days, ascending, empty days carry nulls.
 *   4. Ledger metadata: row counts + latest timestamps.
 *   5. Degenerate inputs (empty tables, unparsable rows) → nulls, no throw.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import { ledgerSkillSummary } from '../api/ring-current/skill.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

const NOW = Date.parse('2026-07-11T12:00:00Z');
const iso = ms => new Date(ms).toISOString();

/** Model rows every 15 min and observed rows hourly, covering `hours` back. */
function fixture(hours, modelDst = -20, obsDst = -25) {
    const modelRows = [], dstRows = [];
    for (let m = hours * 60; m >= 0; m -= 15) {
        modelRows.push({ t: iso(NOW - m * 60_000), dst_model: modelDst });
    }
    for (let h = hours; h >= 0; h--) {
        dstRows.push({ t: iso(NOW - h * 3.6e6), value: obsDst });
    }
    return { modelRows, dstRows };
}

// ── 1. constant offset recovered ─────────────────────────────────────────────
{
    const { modelRows, dstRows } = fixture(48);
    const s = ledgerSkillSummary(modelRows, dstRows, NOW);
    assert.equal(s.windows.h24.rmse, 5);
    assert.equal(s.windows.h24.bias, 5);
    assert.equal(s.windows.h24.n, 25);          // hourly obs, inclusive window
    assert.equal(s.windows.d7.rmse, 5);
    assert.equal(s.windows.d7.n, 49);           // all 48 h of obs pair up
    ok('constant +5 offset ⇒ RMSE 5 / bias +5, hourly pair counts');
}

// ── 2. window separation ─────────────────────────────────────────────────────
{
    // Perfect last 24 h; a −30 nT model error during the day before.
    const { modelRows, dstRows } = fixture(48, -25, -25);
    for (const r of modelRows) {
        const age = NOW - Date.parse(r.t);
        if (age > 24 * 3.6e6 && age <= 48 * 3.6e6) r.dst_model = -55;
    }
    const s = ledgerSkillSummary(modelRows, dstRows, NOW);
    assert.equal(s.windows.h24.rmse, 0);
    assert.ok(s.windows.d7.rmse > 15 && s.windows.d7.rmse < 30,
        `stale error only in d7: ${s.windows.d7.rmse}`);
    assert.ok(s.windows.d7.bias < -10, 'burst was too-deep ⇒ negative bias');
    ok('24 h window clean while 7 d carries the older error burst');
}

// ── 3. daily buckets ─────────────────────────────────────────────────────────
{
    const { modelRows, dstRows } = fixture(36);   // covers today + yesterday only
    const s = ledgerSkillSummary(modelRows, dstRows, NOW);
    assert.equal(s.daily.length, 7);
    // Ascending stable axis ending today (UTC).
    assert.equal(s.daily[6].day, '2026-07-11');
    assert.equal(s.daily[5].day, '2026-07-10');
    assert.ok(s.daily.every((d, i) => i === 0 || d.day > s.daily[i - 1].day));
    // Uncovered days present with null skill; covered days scored.
    assert.equal(s.daily[0].rmse, null);
    assert.equal(s.daily[0].n, 0);
    assert.equal(s.daily[6].rmse, 5);
    assert.ok(s.daily[6].n >= 12);
    ok('daily: 7 stable UTC buckets, nulls for uncovered days');
}

// ── 4. ledger metadata ───────────────────────────────────────────────────────
{
    const { modelRows, dstRows } = fixture(24);
    const s = ledgerSkillSummary(modelRows, dstRows, NOW);
    assert.equal(s.ledger.model_rows, modelRows.length);
    assert.equal(s.ledger.dst_rows, dstRows.length);
    assert.equal(s.ledger.latest_model, iso(NOW));
    assert.equal(s.ledger.latest_dst, iso(NOW));
    assert.equal(s.ledger.cadence_min, 15);
    ok('ledger metadata: counts, latest timestamps, cadence');
}

// ── 5. degenerate inputs ─────────────────────────────────────────────────────
{
    const empty = ledgerSkillSummary([], [], NOW);
    assert.equal(empty.windows.h24.rmse, null);
    assert.equal(empty.windows.h24.n, 0);
    assert.equal(empty.ledger.model_rows, 0);
    assert.equal(empty.ledger.latest_model, null);
    assert.equal(empty.daily.length, 7);

    const junk = ledgerSkillSummary(
        [{ t: 'garbage', dst_model: -20 }, { t: iso(NOW), dst_model: null }],
        [{ t: iso(NOW), value: NaN }],
        NOW,
    );
    assert.equal(junk.ledger.model_rows, 0);
    assert.equal(junk.ledger.dst_rows, 0);
    assert.equal(junk.windows.d7.rmse, null);
    ok('degenerate: empty tables and unparsable rows → nulls, no throw');
}

console.log(`\nring-current-skill-endpoint: all ${n} test groups passed`);
