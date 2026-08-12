# Pollution Sources — inventory, satellite observation, and reconciliation

**Status:** planning. No source code yet beyond the AQI accuracy work that
precedes it (PR #984). Decisions below are the author's, taken 2026-08-12.

**Scope decision:** tracks 1 and 2 (Climate TRACE inventory + Sentinel-5P
TROPOMI observation), free APIs, built so the two can be composed visually.
EPA CEMS is deferred — see §5. Wind/cloud/prediction work follows the two
data layers, not before them.

---

## 1. Why this exists

The site can already say *what the air is like*. It cannot say *who is
producing it*. Every existing air-quality surface — CAMS model, AirNow
monitors, OpenAQ monitors — measures or models **concentration**. None of
them attributes it to a source.

The reconciliation layer in §4 is the differentiator, and it is the same
thesis `api/air-quality/residuals.js` already states for concentration
fields, applied to sources instead: *show where the reported number and the
observed sky disagree.*

## 2. Coverage — the question that drove the scope decision

**Does this cover Asia and Africa?** Yes, and that is most of the point.

Today's ground truth is geographically lopsided:

| source | coverage | in this repo |
|---|---|---|
| EPA AirNow | US only | `/api/air-quality/stations` |
| OpenAQ | global in principle, heavily Europe/North America in practice; thin across Africa | `/api/air-quality/stations-intl` |
| CAMS | global model, ~45 km, not an observation | `/api/air-quality/grid`, `/centers` |

So for most of Africa and much of Asia the site currently has **no ground
truth at all** — only model output. Satellite observation and a global
inventory are the only way to change that.

Both new sources are genuinely global:

- **Sentinel-5P TROPOMI** — sun-synchronous polar orbit, daily global
  coverage, ~5.5 × 3.5 km. Covers everywhere.
- **Climate TRACE** — 352 M assets worldwide, explicitly built to cover
  countries whose national inventories are absent or stale.

### 2.1 Two caveats that must ride every claim

Neither of these is a reason not to build. Both are reasons the UI must
disclose, and the second one bears directly on accuracy claims.

**(a) "Daily global coverage" is optical, so clouds break it.** NO₂ and SO₂
retrievals are UV-visible and are filtered on `qa_value` (the common
threshold is > 0.75, which discards cloud radiance fraction > 0.5). In
persistently cloudy regions — the Congo basin, equatorial West Africa, the
South and Southeast Asian monsoon — effective revisit is far worse than
daily, seasonally so. Any "daily satellite coverage" copy would be false
there.

*Mitigation:* the support machinery built for the AQI review (#5,
`idwGrid().nearestKm` + `supportFade`) is exactly the right instrument.
Composite over N days with a per-cell **observation age**, and fade on it.
Where the sky has not been seen, draw nothing.

**(b) TROPOMI tropospheric NO₂ reads LOW over heavily polluted areas — by
up to 50%.** Attributed to cloud-pressure bias, surface albedo climatology,
and coarse a-priori profiles. The regions where this bites hardest are
exactly the ones with the fewest monitors, i.e. industrial Asia. A raw
column presented as truth would understate the worst air on Earth.

*Mitigation:* never present the column as a concentration. Present it as a
column with its own units, disclose the known bias direction, and use the
reconciliation layer (§4) rather than the raw value for any claim about
magnitude.

## 3. Data sources

### 3.1 Climate TRACE — the inventory ("who emits, where")

- Global, facility level, 352 M assets; power, steel, refineries, shipping.
- Monthly cadence.
- **CC BY 4.0** — attribution is mandatory. Same discipline the repo already
  applies to OpenAQ's `attribution` field; keep it intact everywhere.
- Free API, currently **beta**. Climate TRACE explicitly asks users to keep
  volume low and to be cautious using it in production.

**Design constraint from that beta warning:** this must NOT be a
per-visitor fetch. One cron pulls a bounded slice, caches it, and the
browser only ever reads our own cached route. Same shape as
`/api/air-quality/centers`.

**Provenance:** Climate TRACE is *modeled and satellite-derived*, not
stack-measured. It is a third `kind` alongside the frame contract's `model`
and `observation` — call it `inventory` and never relabel it.

### 3.2 Sentinel-5P TROPOMI — the observation ("what the sky shows")

- NO₂, SO₂, CO, CH₄, aerosol index. Daily, ~5.5 × 3.5 km, free and open
  under the Copernicus licence.
- ESA's own applications page names the use case: local sources such as
  power plants, industry, cities, traffic and ships.
- Access: Copernicus Data Space Ecosystem, OAuth client credentials (free
  registration). Credentials go in Vercel env vars; never client-side.

**Species priority for this site:**
1. **NO₂** — the workhorse. Power plants, cities, shipping lanes.
2. **SO₂** — smelters, coal, volcanoes. Sparser signal, dramatic when present.
3. **CH₄** — oil & gas super-emitters. High public interest, hardest retrieval.
4. **Aerosol index** — pairs with the existing wildfire/EONET layer.

## 4. The reconciliation layer — the actual differentiator

For a facility with reported emissions and a satellite overpass:

```
reported emissions (Climate TRACE)
        │
        ├─► advect with real winds  ──►  predicted downwind column
        │   (js/pollution-model.js stepTransport, already built and tested)
        │
observed column (TROPOMI)  ──────────►  residual = observed − predicted
```

This reuses machinery that already exists and is node-tested. The output is
a statement nobody's consumer air-quality product makes: *"this facility
reports N; the sky downwind says M."*

Guardrails:
- The residual is **not** an accusation. Retrieval bias (§2.1b), wind error,
  plume lofting, and inventory vintage all live in it. The UI must frame it
  as a discrepancy to investigate, not an emissions estimate.
- Never blend inventory and observation into one number.

## 5. EPA CEMS — deferred, and why it is still wanted

EPA's Clean Air Markets hourly CEMS data is **stack-measured ground truth**:
hourly SO₂/NOx/CO₂ per unit for every US power plant with continuous
monitoring, back to 1995.

**It is released quarterly, 2–3 months in arrears.** That rules it out as a
live layer — there is no real-time facility emissions feed from anyone.

It remains the right **calibration anchor**: the only way to prove the §4
method works before trusting it over regions with no monitors. That is a
hindcast, and this repo already has a hindcast discipline
(`HINDCAST_DATABASE_STANDARD.md`) to slot it into. Revisit after §4 exists.

## 6. Phasing

| phase | deliverable | needs |
|---|---|---|
| S1 | ✅ **built, upstream unverified** — `/api/pollution/sources` + `js/pollution-sources.js` + `tests/pollution-sources.mjs`, registered cold-tier | nothing |
| S2 | Globe + Pollution Lab source markers, sector-colored, CC BY attribution visible | S1 |
| S3 | `/api/pollution/tropomi` — NO₂ column tiles/statistics for a bounded scope | Copernicus OAuth creds |
| S4 | Observation drape with per-cell **age**, faded by `supportFade` (§2.1a) | S3 |
| S5 | Reconciliation: advect S1 through real winds, diff against S4 | S1–S4 |
| S6 | CEMS hindcast calibration of S5 | api.data.gov key |

Wind/cloud/prediction work sits after S4 — it needs the observation layer to
verify against, or it is unfalsifiable.

## 7. Guardrails carried from the AQI review

These were bought with real bugs; do not relearn them.

- **One conversion, one home.** `js/aqi-scale.js` is the single source of
  truth for EPA AQI. Anything new that needs an index calls it.
- **Provenance is never implicit.** `model` / `observation` / `inventory`
  are distinct kinds and are displayed together, never substituted.
- **Consistency tests do not prove correctness.** The breakpoint bug survived
  because three gates only checked that surfaces agreed with each other. New
  numeric work is gated against a published external reference or it is not
  gated.
- **Disclose support, not just value.** A number drawn where nothing was
  observed must say so.
- **Degrade to `freshness: 'stale'`, never 5xx.** A route that errors is
  scored the same as one that is merely late; a 200 with stale data is
  scored honestly (CLAUDE.md §8).

## 8. Open questions

- **S1's first deployed run is the discovery step.** The endpoint path,
  envelope shape and field spellings are all guesses resolved at runtime.
  `/api/pollution/sources` reports `pathTried`, `arrayPath`, `fieldMap` and
  `stats` on success, and on failure returns `freshness:'stale'` with a
  `reason` naming the keys it actually received and the constant to edit
  (`ARRAY_KEYS` / `CANDIDATES` / `GAS_KEYS` in `js/pollution-sources.js`).
  Read that response, then delete the losing rungs of `PATH_LADDER` and
  trim `CANDIDATES` to what is real. Keep the resolver — it is what turns
  the next upstream rename into an amber row instead of silent corruption.

- **Climate TRACE is a GREENHOUSE-GAS inventory, not an air-quality one.**
  It reports CO2/CH4/N2O/CO2e; the site's AQ surfaces are PM2.5/NO2/SO2/O3.
  A coal plant emits both, so the inventory is excellent for WHERE the large
  emitters are and HOW BIG they are — but a CO2e tonnage must never be
  colored on the EPA AQI scale, and the §4 reconciliation against TROPOMI
  NO2 is a CO-LOCATION argument, not a mass balance. `gases` is carried
  generically so whatever species the upstream reports survives unconverted.
- Sector taxonomy: Climate TRACE has many sectors. Which appear on the globe
  by default is a product call, not a technical one.
- Whether the reconciliation residual is a public surface or an internal
  validation number first.

---

*Created 2026-08-12 alongside the AQI accuracy review (PR #984).*
