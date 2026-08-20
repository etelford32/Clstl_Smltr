// noaa-regions.mjs — contract tests for the NOAA solar_regions normalizer.
//
// This relay exists so js/farside/flare-climatology.js can rank-match a
// far-side detection against SWPC's own per-region flare probabilities. The
// exact upstream key spellings could not be confirmed from the build
// environment (services.swpc.noaa.gov is egress-blocked), so the design
// resolves each field from a CANDIDATE LIST and reports what it matched.
//
// What these tests protect is mostly the diagnostics: a relay that silently
// returns null probabilities is indistinguishable from an upstream outage,
// and the whole point of field_map / unmapped_keys is to tell those apart
// from one production request.

import assert from 'node:assert/strict';
import {
    normalizeSolarRegions, FIELD_CANDIDATES, PROBABILITY_FIELDS,
} from '../api/_lib/noaa-regions.js';
import {
    flareClimatology, readArea, readProbability, detectProbabilityScale,
} from '../js/farside/flare-climatology.js';

// The shape SWPC is expected to publish.
const UPSTREAM = [
    {
        observed_date: '2026-08-19T00:00:00', region: 14101, location: 'S12W30',
        latitude: -12, longitude: 30, carrington_longitude: 142, area: 240,
        spot_class: 'DAI', mag_class: 'BETA-GAMMA', number_spots: 14, extent: 9,
        c_flare_probability: 45, m_flare_probability: 15, x_flare_probability: 1,
        proton_probability: 1,
    },
    {
        observed_date: '2026-08-19T00:00:00', region: 14102, location: 'N05E10',
        latitude: 5, longitude: -10, carrington_longitude: 182, area: 60,
        spot_class: 'CAO', mag_class: 'BETA', number_spots: 4, extent: 5,
        c_flare_probability: 20, m_flare_probability: 5, x_flare_probability: 1,
        proton_probability: 1,
    },
];

// ── The happy path ───────────────────────────────────────────────────────
{
    const out = normalizeSolarRegions(UPSTREAM);
    assert.equal(out.region_count, 2);
    assert.equal(out.regions.length, 2);

    const [a] = out.regions;
    assert.equal(a.region, 14101);
    assert.equal(a.area, 240);
    assert.equal(a.spot_class, 'DAI');
    assert.equal(a.mag_class, 'BETA-GAMMA');
    assert.equal(a.num_spots, 14);
    assert.equal(a.latitude_deg, -12);
    assert.equal(a.stonyhurst_lon_deg, 30);
    assert.equal(a.carrington_lon_deg, 142);

    // THE POINT OF THE CHANGE: probabilities reach the client.
    assert.equal(a.c_flare_probability, 45);
    assert.equal(a.m_flare_probability, 15);
    assert.equal(a.x_flare_probability, 1);
    assert.equal(a.proton_probability, 1);

    // Relayed AS PUBLISHED — whole percents, not fractions. The
    // percent-vs-fraction call belongs to the client, over the whole feed.
    assert.ok(a.m_flare_probability > 1, 'not pre-divided into a fraction');

    // Back-compat: rust/www/index.html still reads z_class.
    assert.equal(a.z_class, 'DAI');

    // Diagnostics name the key that actually fed each field.
    assert.equal(out.field_map.m_flare_probability, 'm_flare_probability');
    assert.equal(out.field_map.spot_class, 'spot_class');
    assert.equal(out.field_map.num_spots, 'number_spots');
    assert.deepEqual(out.unmapped_keys, [], 'a fully-understood row leaves nothing over');
    assert.equal(out.probability_coverage, 1);
}

// ── Alternate spellings ──────────────────────────────────────────────────
{
    // The same feed under the other names the candidate lists allow. Every
    // output field must land, and field_map must name what it used — that is
    // how a schema change gets diagnosed instead of silently zeroing the
    // downstream base rate.
    const alt = [{
        Region: 14200, Area: '310', Z: 'EKC', Mag: 'BETA-GAMMA-DELTA',
        Spots: '22', Latitude: '-8', Longitude: '12',
        cFlareProbability: 70, mFlareProbability: 35, xFlareProbability: 10,
    }];
    const out = normalizeSolarRegions(alt);
    const [r] = out.regions;
    assert.equal(r.region, 14200);
    assert.equal(r.area, 310, 'numeric strings are coerced');
    assert.equal(r.spot_class, 'EKC');
    assert.equal(r.num_spots, 22);
    assert.equal(r.m_flare_probability, 35);
    assert.equal(out.field_map.m_flare_probability, 'mFlareProbability');
    assert.equal(out.field_map.spot_class, 'Z');
    assert.equal(out.probability_coverage, 1);
}

// ── The failure this design exists to make visible ───────────────────────
{
    // Upstream renames the probability fields to something not in the list.
    // The regions still relay; the probabilities go null; and — crucially —
    // field_map says null while unmapped_keys shows the real names, so one
    // production request tells you it is our candidate list at fault and not
    // an SWPC outage.
    const renamed = UPSTREAM.map(({
        c_flare_probability, m_flare_probability, x_flare_probability, ...rest
    }) => ({
        ...rest,
        flare_prob_c: c_flare_probability,
        flare_prob_m: m_flare_probability,
        flare_prob_x: x_flare_probability,
    }));
    const out = normalizeSolarRegions(renamed);

    assert.equal(out.region_count, 2, 'the region list still relays');
    assert.equal(out.regions[0].area, 240, 'and the fields we do understand survive');
    for (const f of PROBABILITY_FIELDS) {
        assert.equal(out.field_map[f], null, `${f} reports unmatched`);
        assert.equal(out.regions[0][f], null, 'and is null, never 0');
    }
    assert.ok(out.unmapped_keys.includes('flare_prob_m'),
        'the real upstream name is surfaced for a human to read');
    assert.equal(out.probability_coverage, 0);
}

// ── Partial and ragged feeds ─────────────────────────────────────────────
{
    // Only some regions carry probabilities — coverage reports the fraction so
    // a half-populated feed is distinguishable from a working one.
    const partial = [
        { region: 1, area: 100, m_flare_probability: 10 },
        { region: 2, area: 200 },
        { region: 3, area: 300, m_flare_probability: 40 },
        { region: 4 },
    ];
    const out = normalizeSolarRegions(partial);
    assert.equal(out.region_count, 4);
    assert.equal(out.probability_coverage, 0.5, 'two of four are usable');
    assert.equal(out.regions[1].m_flare_probability, null);
    assert.equal(out.regions[3].area, null);

    // The schema is resolved over the WHOLE list, not the first row: region 1
    // has no spot_class but region 3 does, and the mapping must still find it.
    const ragged = normalizeSolarRegions([
        { region: 9 },
        { region: 10, spot_class: 'AXX', m_flare_probability: 1 },
    ]);
    assert.equal(ragged.field_map.spot_class, 'spot_class');
    assert.equal(ragged.regions[1].spot_class, 'AXX');
    assert.equal(ragged.regions[0].spot_class, null);
}

// ── Zero is a probability; empty string and null are not ─────────────────
{
    const out = normalizeSolarRegions([
        { region: 1, area: 50, m_flare_probability: 0 },
        { region: 2, area: 50, m_flare_probability: '' },
        { region: 3, area: 50, m_flare_probability: null },
    ]);
    assert.equal(out.regions[0].m_flare_probability, 0, 'a real 0 % survives');
    assert.equal(out.regions[1].m_flare_probability, null, 'empty string is absence');
    assert.equal(out.regions[2].m_flare_probability, null, 'null is absence');
    // Coverage counts the honest zero.
    assert.ok(Math.abs(out.probability_coverage - 1 / 3) < 1e-12);
}

// ── Junk input ───────────────────────────────────────────────────────────
{
    // Not an array → throw, so the route answers parse_error rather than
    // serving an empty list that reads as "the Sun is blank today".
    assert.throws(() => normalizeSolarRegions(null), TypeError);
    assert.throws(() => normalizeSolarRegions({ regions: [] }), TypeError);
    assert.throws(() => normalizeSolarRegions('nope'), TypeError);

    // An empty array is a legitimate (if unusual) answer.
    const empty = normalizeSolarRegions([]);
    assert.equal(empty.region_count, 0);
    assert.equal(empty.probability_coverage, 0);
    assert.deepEqual(empty.regions, []);

    // Rows without a region number are dropped, and null rows do not throw.
    const dirty = normalizeSolarRegions([null, { area: 10 }, { region: 7, area: 10 }]);
    assert.equal(dirty.region_count, 1);
    assert.equal(dirty.regions[0].region, 7);

    // The diagnostic is capped — it is a hint for a human, not a data channel.
    const wide = normalizeSolarRegions([Object.fromEntries(
        [['region', 1], ...Array.from({ length: 100 }, (_, i) => [`junk_${i}`, i])])]);
    assert.ok(wide.unmapped_keys.length <= 40, 'unmapped_keys is bounded');
}

// ── The candidate lists themselves ───────────────────────────────────────
{
    // Every output field offers at least one candidate, and no upstream key is
    // claimed by two fields (which would make field_map ambiguous).
    const seen = new Map();
    for (const [out, candidates] of Object.entries(FIELD_CANDIDATES)) {
        assert.ok(candidates.length >= 1, `${out} has candidates`);
        for (const key of candidates) {
            assert.ok(!seen.has(key) || seen.get(key) === out,
                `upstream key "${key}" is claimed by both ${seen.get(key)} and ${out}`);
            seen.set(key, out);
        }
    }
    for (const f of PROBABILITY_FIELDS) {
        assert.ok(FIELD_CANDIDATES[f], `${f} is a resolvable field`);
    }
}

// ── The relay actually feeds its consumer ────────────────────────────────
// The two sides were written apart: this route names the output fields and
// js/farside/flare-climatology.js reads them. A rename on either side would
// leave both files internally consistent and the feature silently dead, so
// the handoff gets its own assertion rather than being assumed.
{
    const disc = [
        { region: 1, area: 20, spot_class: 'AXX', m_flare_probability: 1 },
        { region: 2, area: 80, spot_class: 'BXO', m_flare_probability: 5 },
        { region: 3, area: 240, spot_class: 'CAO', m_flare_probability: 15 },
        { region: 4, area: 600, spot_class: 'DAI', m_flare_probability: 35 },
        { region: 5, area: 1400, spot_class: 'EKC', m_flare_probability: 60 },
    ];
    const { regions } = normalizeSolarRegions(disc);

    // The consumer's readers find what the relay emitted.
    assert.equal(readArea(regions[3]), 600, 'flare-climatology reads the relayed area');
    assert.equal(readProbability(regions[3], 'm', 'percent'), 0.35, '...and the probability');
    assert.equal(detectProbabilityScale(regions), 'percent',
        'whole percents survive the relay and are recognised as such');

    // End to end: a big far-side detection ranks above a small one, off the
    // relay's own output.
    const farSide = [50, 120, 300, 700];
    const small = flareClimatology({ areaDeg2: 50, farSideAreas: farSide, noaaRegions: regions });
    const big = flareClimatology({ areaDeg2: 700, farSideAreas: farSide, noaaRegions: regions });
    assert.ok(small && big, 'the relayed disc supports a base rate');
    assert.ok(big.pDaily > small.pDaily, 'and preserves the size ordering');
    assert.equal(big.nRegions, 5, 'every relayed region is usable');

    // And the failure mode stays a refusal: strip the probabilities upstream
    // and the consumer declines rather than reporting 0 %.
    const stripped = normalizeSolarRegions(
        disc.map(({ m_flare_probability, ...r }) => r)).regions;
    assert.equal(
        flareClimatology({ areaDeg2: 700, farSideAreas: farSide, noaaRegions: stripped }),
        null, 'no probabilities relayed means no claim, not a zero');
}

console.log('✓ NOAA solar_regions relay (flare probabilities + schema diagnostics)');
