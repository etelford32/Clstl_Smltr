/**
 * Gate for js/pollution-sources.js — the schema-defensive Climate TRACE
 * normalizer.
 *
 * The upstream shape is UNVERIFIED (beta API, egress-blocked build box), so
 * the thing under test is not "does it parse the real response" — nobody
 * here knows the real response. It is: **does it fail loudly and usefully
 * when its guess is wrong?** A normalizer that quietly produces plausible
 * rows from a shape it did not understand is the failure mode this whole
 * module exists to prevent.
 *
 * So most of this file feeds it shapes it was NOT written for and asserts
 * the error message names the keys actually received.
 *
 * Run: node tests/pollution-sources.mjs
 */
import assert from 'node:assert/strict';
import {
    CANDIDATES,
    CLIMATE_TRACE_ATTRIBUTION,
    INVENTORY_PROVENANCE,
    extractGases,
    normalizeSources,
    pickArray,
    resolveFieldMap,
    summarizeSectors,
} from '../js/pollution-sources.js';

// ── Envelope discovery ─────────────────────────────────────────────────────
{
    const row = { asset_id: 1, asset_name: 'A', lat: 10, lon: 20 };
    assert.equal(pickArray([row]).path, '(root array)');
    assert.equal(pickArray({ assets: [row] }).path, 'assets');
    assert.equal(pickArray({ data: [row] }).path, 'data');
    assert.equal(pickArray({ results: [row] }).path, 'results');
    // One level down, e.g. {data: {assets: [...]}}
    assert.equal(pickArray({ data: { assets: [row] } }).path, 'data.assets');
    // Nothing array-shaped anywhere.
    assert.equal(pickArray({ meta: { count: 0 } }).rows, null);
    assert.equal(pickArray(null).rows, null);
    assert.equal(pickArray('nope').rows, null);
}

// ── Field resolution binds to whatever spelling is present ────────────────
{
    const snake = resolveFieldMap({ asset_id: 1, asset_name: 'A', lat: 1, lon: 2, sector: 'power' });
    assert.equal(snake.map.id, 'asset_id');
    assert.equal(snake.map.lon, 'lon');
    assert.equal(snake.missing.length, 0);

    // A different but equally plausible spelling must resolve too — this is
    // the whole point of the candidate table.
    const camel = resolveFieldMap({ assetId: 7, assetName: 'B', latitude: 1, longitude: 2 });
    assert.equal(camel.map.id, 'assetId');
    assert.equal(camel.map.lat, 'latitude');
    assert.equal(camel.map.lon, 'longitude');
    assert.equal(camel.missing.length, 0);

    // Optional fields simply do not bind; that is not an error.
    assert.equal(camel.map.sector, undefined);
    assert.ok(!camel.missing.includes('sector'));

    // Required fields missing are reported by NAME.
    const bad = resolveFieldMap({ foo: 1, bar: 2 });
    assert.deepEqual(bad.missing.sort(), ['id', 'lat', 'lon', 'name']);
    assert.deepEqual(bad.observedKeys, ['foo', 'bar']);

    // Every required candidate list must be non-empty, or the resolver can
    // never succeed — a typo in CANDIDATES would otherwise be invisible.
    for (const [logical, spec] of Object.entries(CANDIDATES)) {
        assert.ok(spec.keys.length > 0, `${logical} has candidate keys`);
    }
}

// ── Gas extraction survives several plausible encodings ───────────────────
{
    // Flat columns.
    const flat = extractGases({ co2e_100yr: 1200, ch4: 5, unit: 'tonnes' });
    assert.equal(flat.find(g => g.gas === 'co2e_100yr').value, 1200);
    assert.equal(flat.find(g => g.gas === 'ch4').unit, 'tonnes');

    // Nested list of {gas, quantity, unit}.
    const list = extractGases({ emissions: [
        { gas: 'co2', quantity: 900, unit: 't' },
        { gas: 'CH4', quantity: '12', unit: 't' },
    ] });
    assert.equal(list.find(g => g.gas === 'co2').value, 900);
    assert.equal(list.find(g => g.gas === 'ch4').value, 12, 'string quantities coerce');
    assert.equal(list.find(g => g.gas === 'ch4').gas, 'ch4', 'gas names normalise to lower case');

    // Nested object keyed by gas.
    const obj = extractGases({ emissions: { co2e_100yr: 500, n2o: 2, unit: 'tonnes' } });
    assert.equal(obj.find(g => g.gas === 'co2e_100yr').value, 500);

    // Single {gas, quantity} object.
    assert.equal(extractGases({ emissions: { gas: 'so2', quantity: 42 } })[0].gas, 'so2');

    // Scalar emissions with no gas named — assumed co2e and labelled as such,
    // never silently attributed to a specific species.
    assert.equal(extractGases({ emissions: 77 })[0].gas, 'co2e');

    // Unrecognisable → empty, not a fabricated zero. A zero would render as
    // "this facility emits nothing", which is a very different claim.
    assert.deepEqual(extractGases({ nothing: 'here' }), []);
    assert.deepEqual(extractGases(null), []);
    assert.deepEqual(extractGases({ emissions: [{ quantity: 5 }] }), [],
        'a quantity with no gas name is not attributed');

    // Non-numeric junk is dropped rather than becoming NaN.
    assert.deepEqual(extractGases({ co2: 'not-a-number' }), []);

    // De-duplication keeps one entry per gas.
    const dupe = extractGases({ co2: 1, emissions: [{ gas: 'co2', quantity: 999 }] });
    assert.equal(dupe.filter(g => g.gas === 'co2').length, 1, 'one entry per gas');
    assert.equal(dupe[0].value, 1, 'the flat column wins');
}

// ── Happy path ─────────────────────────────────────────────────────────────
{
    const payload = { assets: [
        { asset_id: 'a1', asset_name: 'Plant A', lat: 39.7, lon: -104.9,
          sector: 'power', iso3_country: 'USA', co2e_100yr: 5_000_000 },
        { asset_id: 'a2', asset_name: 'Mill B', lat: 28.6, lon: 77.2,
          sector: 'steel', iso3_country: 'IND', co2e_100yr: 2_000_000 },
    ] };
    const out = normalizeSources(payload);
    assert.equal(out.sources.length, 2);
    assert.equal(out.arrayPath, 'assets');
    assert.equal(out.fieldMap.country, 'iso3_country', 'the bound key is reported');
    assert.equal(out.sources[0].sector, 'power');
    assert.equal(out.sources[0].gases[0].value, 5_000_000);
    assert.equal(out.stats.received, 2);
    assert.equal(out.stats.kept, 2);
    assert.equal(out.stats.withoutGases, 0);
    assert.equal(out.stats.gasesUnresolved, false);

    const sectors = summarizeSectors(out.sources);
    assert.equal(sectors[0].sector, 'power', 'sectors rank by total');
    assert.equal(sectors[0].total, 5_000_000);
    assert.equal(sectors.length, 2);
}

// ── Failure modes name what was actually received ─────────────────────────
{
    // Wrong envelope.
    assert.throws(() => normalizeSources({ payload: { thing: 1 } }), (e) => {
        assert.match(e.message, /no record array found/);
        assert.match(e.message, /payload keys were \[payload\]/, 'names the keys it saw');
        assert.match(e.message, /ARRAY_KEYS/, 'names the constant to edit');
        return true;
    });

    // Right envelope, unrecognised record shape.
    assert.throws(() => normalizeSources({ assets: [{ foo: 1, bar: 2 }] }), (e) => {
        assert.match(e.message, /could not resolve required field\(s\)/);
        assert.match(e.message, /record keys were \[foo, bar\]/, 'names the keys it saw');
        assert.match(e.message, /CANDIDATES/, 'names the constant to edit');
        return true;
    });

    // Coordinates present by name but unusable.
    assert.throws(() => normalizeSources({ assets: [
        { asset_id: 1, asset_name: 'X', lat: 999, lon: 999 },
    ] }), /none had usable coordinates/);

    assert.throws(() => normalizeSources({ assets: [] }), /empty record array/);

    // Rows with bad coordinates are dropped, not clamped onto the map.
    const mixed = normalizeSources({ assets: [
        { asset_id: 1, asset_name: 'good', lat: 10, lon: 20, co2e_100yr: 1 },
        { asset_id: 2, asset_name: 'bad', lat: 'nonsense', lon: 20, co2e_100yr: 1 },
        { asset_id: 3, asset_name: 'null island risk', lat: null, lon: null, co2e_100yr: 1 },
    ] });
    assert.equal(mixed.stats.kept, 1, 'unplaceable rows are dropped, never parked at 0,0');
    assert.equal(mixed.stats.received, 3, 'but the drop is visible in the stats');
}

// ── Placeable rows with no magnitude are flagged, not hidden ──────────────
{
    const noGas = normalizeSources({ assets: [
        { asset_id: 1, asset_name: 'A', lat: 10, lon: 20 },
        { asset_id: 2, asset_name: 'B', lat: 11, lon: 21 },
    ] });
    assert.equal(noGas.stats.kept, 2, 'rows are still placeable');
    assert.equal(noGas.stats.withoutGases, 2);
    assert.equal(noGas.stats.gasesUnresolved, true,
        'total gas-extraction failure raises a distinct flag for the status page');
    assert.deepEqual(noGas.sources[0].gases, [], 'and no magnitude is invented');
}

// ── Provenance and licence ────────────────────────────────────────────────
{
    assert.equal(INVENTORY_PROVENANCE.kind, 'inventory',
        'a third kind, distinct from model and observation');
    assert.equal(INVENTORY_PROVENANCE.isGroundObservation, false);
    assert.equal(INVENTORY_PROVENANCE.isStackMeasured, false);
    assert.equal(INVENTORY_PROVENANCE.attribution, CLIMATE_TRACE_ATTRIBUTION);
    assert.match(CLIMATE_TRACE_ATTRIBUTION, /CC BY 4\.0/, 'the licence is carried verbatim');
}

console.log('pollution-sources: all assertions passed');
