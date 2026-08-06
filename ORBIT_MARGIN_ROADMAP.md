# Orbit Margin — operator product roadmap

Status: working roadmap
Owner: Parkers Physics
Product surface: `for-operators.html` → `operations.html`

## Product promise

Orbit Margin turns space-weather conditions into a fleet decision:

> Load the fleet, stress it against a live or historical storm, compare the
> operational choices, and leave with an auditable briefing.

The product is not another neutral-density viewer. Public agencies already
publish density and index products. Parkers Physics earns its place by joining
those drivers to each operator's assets, drag exposure, conjunction workload,
and maneuver trade space—with uncertainty and provenance attached.

## Initial buyer and paid offer

### Beachhead buyer

- LEO operators with roughly 5–100 spacecraft.
- University and research missions with small flight-dynamics teams.
- Earth-observation, GNSS-RO, AIS, and VLEO programs whose scheduling or
  station-keeping changes materially during storms.
- Conjunction-assessment providers that need an independent storm-atmosphere
  sensitivity layer.

Do not start with mega-constellations. They have the largest theoretical ACV
but the longest validation, security, integration, and procurement path.

### Founding offer

**Fleet Storm-Readiness Assessment**

The customer supplies NORAD IDs plus the best available mass, area, attitude,
and propulsion assumptions. Parkers Physics runs quiet, Feb-2022, Gannon G5,
and one customer-selected scenario, then delivers:

- per-asset decay and perigee sensitivity;
- along-track and conjunction-workload changes;
- maneuver and delay/no-delay tradeoffs;
- uncertainty, assumptions, and model provenance;
- a written briefing plus a 60-minute review.

Pricing hypothesis: **$3,500 fixed-scope founding assessment**. Test the offer
with at least ten qualified conversations. Require three paid assessments
before building customer-specific integrations.

## Product principles

1. **Decisions before dashboards.** Every view must answer an operational
   question: wait, change attitude, raise, delay, or investigate.
2. **Bands before false precision.** TLE age, ballistic coefficient, density,
   and forecast-driver uncertainty remain visible.
3. **Provenance is part of the result.** Model version, input age, forecast
   regime, and caveats travel with every export.
4. **Public TLE mode is triage-grade.** Never label a public-TLE screen as a
   maneuver command or operator-grade probability of collision.
5. **Earn the MHD claim.** Do not sell superior predictive accuracy until the
   hindcast validation gate in `MHD_DENSITY_PRODUCT_PLAN.md` clears.

## Roadmap

### Phase 0 — Fleet-ready public preview

Target: now–2 weeks

Goal: let an operator reach the first useful fleet stress test without a sales
call or manual setup.

Deliverables:

- bulk NORAD/CSV/TLE fleet intake with a one-click representative demo fleet;
- a visible four-step workflow: load → stress → screen → compare;
- live, Gannon G5, Feb-2022, and AR3842 scenario entry points;
- per-asset decay bands, drag-vs-quiet, conjunction screen, and maneuver
  what-if in one flow;
- a fleet risk outlook that projects perigee at 6/24/72 hours, ranks screened
  encounters by synthetic uncertainty-envelope overlap, and attributes debris
  family, size class, closing speed, and estimated impact energy;
- fleet JSON and CSV briefing exports;
- explicit public-TLE and synthetic-covariance caveats;
- ~~OMM-first public GP ingestion with one- through nine-digit catalogue IDs,
  full SGP4 propagation, and selected-layer Catalogue Coverage Health;~~
  **SHIPPED 2026-08**;
- operator landing page that sells the assessment, not a generic simulator.

Release gate:

- A first-time evaluator can load five assets, select Gannon, run a screen,
  inspect one maneuver, and download a result in under two minutes.
- Mobile users can complete fleet intake and read the result panels.
- Existing Operations decay, debris, and navigation gates remain green.

### Phase 1 — Paid-assessment workbench

Target: 2–5 weeks

Goal: deliver the first three paid readiness assessments efficiently.

Deliverables:

- ~~editable spacecraft assumptions: mass, effective area, drag coefficient,
  nominal attitude, thrust, specific impulse, and propellant reserve;~~ **SHIPPED
  2026-08** with six representative, explicitly illustrative vehicle templates;
- side-by-side quiet/current/storm scenario comparison;
- ~~policy branches: do nothing, low-drag attitude, raise orbit, delay
  deployment, and operator-entered RTN burn;~~ **SHIPPED 2026-08** as a
  72-hour comparison using local-rate drag scaling, Hohmann raise, rocket
  equation, and a first-order tangential-burn energy change;
- ~~selected-vehicle visualization for design and attitude changes, including
  active chemical/electric thruster plumes;~~ **SHIPPED 2026-08**;
- actual re-screen after a maneuver, including updated TCA;
- customer-branded PDF briefing with assumptions and limitations;
- named scenarios and secure share links;
- structured interview notes tied to requested decisions and exported fields.

Commercial gate:

- Three paid assessments.
- At least two customers ask to rerun or monitor the analysis.
- One customer provides a sanitized example of its real operational inputs or
  desired downstream schema.

### Phase 2 — Team beta

Target: 1–3 months, after the commercial gate

Goal: turn repeated assessment work into a recurring team product.

Deliverables:

- organization fleets and role-based access;
- CSV, OMM, OEM, and CDM ingestion with customer-provided covariance;
- multi-fleet and saved vehicle configurations;
- scheduled re-screening, per-asset alerts, and shift handoff notes;
- API/webhook delivery for changed risk and drag states;
- immutable scenario/run IDs and downloadable audit bundles;
- usage, activation, and time-to-first-result telemetry.

Target packaging hypothesis:

- Team: $1,500–$4,000 per month, sized by assets and cadence.
- Annual operator contract: from $25,000 with onboarding and support.
- Enterprise integrations: from $50,000 per year, quoted against data volume,
  response expectations, and custom model work.

Release gate:

- One team uses the product during an actual elevated-space-weather interval.
- Exported results reconcile with the customer's internal tool within agreed
  triage tolerances.
- Alert precision and acknowledgement workflow are measured, not assumed.

### Phase 3 — Validated forecast product

Target: after Phase-0 density validation clears

Goal: replace scenario-only value with continuously verified predictive value.

Deliverables:

- MHD-conditioned density nowcast and 6/24/72-hour forecast;
- calibrated per-altitude and per-horizon uncertainty;
- published hindcast cards for Feb-2022, Gannon, AR3842, a quiet control, and
  at least two additional storms;
- continuously updated skill ledger against available accelerometer-derived
  density truth;
- along-track timing-error and perigee-altitude distributions along registered
  orbits;
- fallback ladder and visible degraded-state behavior when upstream data or
  compute is unavailable.

Science gate:

- The agreed validation metric beats the declared empirical/persistence
  baseline on held-out storm cases.
- Coverage of the displayed uncertainty band is measured and published.
- Marketing claims match the exact altitude range, horizon, and regimes that
  passed validation.

### Phase 4 — Enterprise data and ecosystem

Target: 3–9 months, conditional on Team beta retention

Goal: become the independent storm-atmosphere decision layer inside existing
flight-dynamics and space-traffic workflows.

Deliverables:

- per-orbit API plus gridded netCDF/CBOR density product;
- customer propagator adapters and configurable webhook schemas;
- service health, latency, freshness, and model-version SLAs;
- historical reprocessing and contractual audit retention;
- TraCSS-compatible and customer-CDM workflows where policy and access allow;
- insurer/portfolio stress-testing mode as an adjacent enterprise package.

## Funnel and success metrics

### Acquisition

- Qualified operator conversations per month.
- Landing page → demo-fleet launch rate.
- Landing page → assessment request rate.

### Activation

- Time to first ready fleet asset.
- Percentage importing 3+ assets.
- Percentage selecting a storm scenario.
- Percentage completing a conjunction screen.
- Percentage downloading an export.

### Commercial proof

- Paid assessments / qualified conversations.
- Assessment → recurring subscription conversion.
- Median asset count and rerun frequency.
- Number of downstream integrations requested before they are built.

### Trust

- Forecast/data freshness at decision time.
- Exported runs with complete provenance.
- Uncertainty coverage by horizon and regime.
- Customer-reported discrepancies and their resolution time.

## Immediate backlog

1. Put the fleet-ready public preview in front of ten operator-design partners.
2. Measure whether altitude-loss and uncertainty-overlap rows shorten the path
   from “storm selected” to “asset worth investigating.”
3. Recruit ten design-partner conversations using the fixed-scope assessment.
4. Finish real re-screen-after-maneuver before presenting a maneuver as a
   compared operational branch.
5. Extend the shipped vehicle/action workbench from one space-weather state to
   a quiet/current/storm comparison matrix.
6. Add secure saved fleets only after the first paid customers confirm the
   fields and collaboration model they actually need.
7. Continue the density validation program in parallel; keep it independent
   of whether the assessment workflow can sell today.

## Explicit non-goals for the first paid release

- Autonomous maneuver commands.
- A claimed operational probability of collision from public TLEs.
- A generic replacement for an operator's high-fidelity propagator.
- Unlimited fleet scale in the anonymous browser preview.
- Building a new framework, 3D engine, or atmospheric model before validating
  the decision workflow.
