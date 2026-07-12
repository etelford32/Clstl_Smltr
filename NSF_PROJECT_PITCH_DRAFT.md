# NSF SBIR Project Pitch — draft v1

*Target: NSF 26-510, submitted via seedfund.nsf.gov Project Pitch portal.*
*Word limits per NSF format: sections 1–2 = 500 words each, sections 3–4 = 250 words each.*
*Every `[FILL IN]` must be resolved by Eric before submission. Technical
claims below are drawn from the repo's hindcast/pipeline docs — verify each
against actual harness output before submitting; do not ship an unverified
number to NSF.*

---

## 1. Technology Innovation (≤500 words)

In February 2022, SpaceX lost 38 newly launched Starlink satellites to a
geomagnetic storm that was, by historical standards, minor. The satellites
deorbited because the empirical atmospheric density models used across the
industry — NRLMSIS-class models driven by lagging, low-resolution
geomagnetic indices (Ap, F10.7) — underpredicted the storm-time density
enhancement in the lower thermosphere. In May 2024, the Gannon G5
superstorm — the strongest in two decades — produced the largest mass
migration of satellite maneuvers in history under the same forecasting
blind spot. The low-Earth-orbit economy now exceeds 12,000 active
satellites, and its core safety function — conjunction assessment and
collision avoidance — is only as good as the neutral density forecast
underneath it.

Our innovation is an operational forecasting pipeline that replaces the
empirical index-driven density paradigm with **physics-first,
magnetohydrodynamics-grounded modeling**. We couple a first-principles
global magnetosphere simulation (BATS-R-US within the Space Weather
Modeling Framework, SWMF) driven by real-time upstream solar wind
measurements at the L1 Lagrange point, to thermospheric density prediction.
The MHD solution provides physically meaningful storm-energy inputs —
polar cap potential and hemispheric power (auroral energy deposition) —
hours before ground-based geomagnetic indices register the storm and at
far higher fidelity during the storm main phase, precisely when empirical
models fail worst.

The origin of the innovation is a systematic hindcasting program built by
our team: an end-to-end harness that replays historical storms through the
full pipeline (L1 solar wind → MHD → density → orbit-level drag) and
scores the result against ground truth — accelerometer-derived neutral
densities from the GRACE-FO mission. The February 2022 Starlink event and
the May 2024 Gannon superstorm are our canonical validation cases. This
research-to-operations discipline — every forecast component validated
against measured storm-time density, not against another model — is what
distinguishes the approach from both legacy empirical models and the
recent wave of purely data-driven (ML) surrogates, which train on the same
index-driven inputs and inherit their storm-time blindness.

The unproven, high-risk element — and the focus of Phase I — is the
coupling layer: demonstrating that MHD-derived energy inputs, computed at
operational latency from L1 data, produce thermospheric density forecasts
that are measurably more accurate during storm conditions than the
operational baselines (NRLMSISE-00, JB2008), with quantified uncertainty.
No commercially available product does this today; the state of the art in
research (e.g., coupled whole-atmosphere models at national centers) runs
at costs and latencies incompatible with commercial operations.

The delivery vehicle already exists: a production web platform
(parkersphysics.com) with live NOAA/NASA data ingestion, containerized
SWMF/BATS-R-US, and in-browser physics visualization via
WebAssembly-compiled solvers. Phase I de-risks the physics coupling; the
operational scaffolding around it is built.

## 2. Technical Objectives and Challenges (≤500 words)

The Phase I question: **can MHD-derived storm-energy inputs, computed at
operational latency, beat the operational empirical baselines on
storm-time thermospheric density — with quantified uncertainty?** Four
objectives:

**Objective 1 — Rigorous two-storm skill benchmark.** Complete the
hindcast validation harness on the February 2022 Starlink event and the
May 2024 Gannon superstorm. Drive BATS-R-US with measured L1 interplanetary
magnetic field and plasma data (OMNI high-resolution merged dataset), map
MHD outputs to thermospheric density, and score against GRACE-FO
accelerometer-derived densities (TU Delft v02 product) using orbit-averaged
and along-track metrics. Baselines: NRLMSISE-00 and JB2008 driven by
definitive indices. Success criterion: statistically significant reduction
in storm-phase density error versus both baselines on both storms.
Risk: a two-storm sample is small; we mitigate by evaluating across storm
phases (ramp, main, recovery) and altitudes, and by pre-registering
metrics before running the comparison.

**Objective 2 — Replace the regression bridge with a physical coupling.**
Our current prototype maps MHD outputs (polar cap potential Φ_PC,
hemispheric power index) to an effective geomagnetic driver via a fitted
"pseudo-Ap" — a deliberate Phase-0 scaffold. Phase I replaces it with
direct physical forcing: high-latitude Joule heating and particle
precipitation from the MHD solution driving the thermospheric response.
This is the highest technical risk in the project: the
magnetosphere–ionosphere–thermosphere coupling is where first-principles
models historically diverge. The pseudo-Ap bridge is retained as the
fallback and as the ablation control that isolates the value of physical
coupling.

**Objective 3 — Operational latency and robustness.** Demonstrate
automated end-to-end runs at forecast-relevant cadence: L1 data arrival to
density product in under [FILL IN: target, e.g. 30] minutes, sustained
across a multi-day storm replay including data gaps and instrument
dropouts (both storms contain real gaps). Challenge: BATS-R-US wall-clock
cost at operationally useful grid resolution; we will characterize the
resolution/latency/skill trade-off explicitly.

**Objective 4 — Uncertainty quantification.** Produce calibrated
uncertainty bounds via ensemble perturbation of solar wind drivers and
coupling parameters, scored with standard probabilistic metrics against
GRACE-FO truth. Operators act on confidence intervals, not point
estimates; a forecast without calibrated uncertainty is not decision-grade.

This is R&D, not engineering: each objective tests a scientific hypothesis
about whether and where first-principles coupling adds storm-time skill,
against instrument ground truth, with published-quality methodology.
Phase I success yields a validated, uncertainty-quantified storm-time
density forecast prototype and the evidence base for Phase II: expansion
to a multi-storm validation set, assimilation of additional truth sources
(Swarm, two-line-element-derived densities), and productization of
per-satellite drag and conjunction-screening outputs.

## 3. Market Opportunity (≤250 words)

The customer is anyone who must predict where a LEO satellite will be
during a geomagnetic storm: constellation operators, conjunction-assessment
and space-traffic-management providers, government space-domain-awareness
missions, and insurers.

The pain is measured in dollars and maneuvers. The 2022 Starlink loss
destroyed an estimated $50M+ of hardware in a single week from one
mis-forecast storm. During the 2024 Gannon storm, operators executed
thousands of emergency maneuvers, and orbit-determination errors degraded
conjunction screening industry-wide for days. Every maneuver burns
propellant (satellite lifetime) and operations time; every false alarm
erodes trust in screening.

The LEO population has grown past 12,000 active satellites and is
projected to multiply through the decade, while solar cycle 25's maximum
keeps storm-time drag the dominant orbit-prediction error source.
Regulatory pressure (space-traffic-coordination mandates, TraCSS) is
formalizing demand for auditable, physics-defensible forecasts.

Entry wedge: storm-time density and per-satellite drag forecasts sold to
LEO operators and SSA providers via API, with government adoption (USSF,
NOAA SWPC) pursued in parallel through agency programs — we are concurrently
engaging the Department of the Air Force SBIR cycle. Physics-first
validation against accelerometer ground truth is the differentiator against
both legacy empirical models (free, but storm-blind) and ML entrants
(unauditable during the rare events that matter most).

[FILL IN: any existing customer conversations, LOIs, pilot users, or
revenue — even informal design-partner interest materially strengthens
this section.]

## 4. Company and Team (≤250 words)

[FILL IN — this section must be written from real facts. Skeleton:]

Parker's Physics [FILL IN: legal entity name, state of incorporation,
founding year] is a [FILL IN: LLC/C-corp] building physics-first space
weather forecasting for satellite operators and government at
parkersphysics.com.

What exists today (verifiable): a production web platform with continuous
live ingestion of NOAA SWPC solar wind data (6,700+ archived samples and
growing), NASA DONKI/HEK event feeds, automated forecast pipelines with
heartbeat monitoring, containerized SWMF/BATS-R-US, a DSMC pipeline for
rarefied-gas modeling, WebAssembly in-browser MHD solvers, and an
operational hindcast harness for the February 2022 and May 2024 validation
storms.

Founder / PI: [FILL IN: name, relevant background, role]. NSF requires
the PI to be primarily employed (>50%) by the small business at award
time — [FILL IN: confirm status or plan].

[FILL IN: additional team members, advisors — a space physics PhD advisor
or aerospace industry advisor is worth recruiting before the full
proposal if not already in place.]

[FILL IN: funding history — bootstrapped / prior grants / investment.]

---

## Submission checklist

- [ ] All `[FILL IN]` blocks resolved
- [ ] Every quantitative claim checked against harness output or a citable source
- [ ] Word counts verified per section (500/500/250/250)
- [ ] Company registered: SAM.gov (UEI), SBA Company Registry (SBC ID)
- [ ] Submitted at seedfund.nsf.gov — record date + pitch ID in `SBIR_SOLICITATION_ACTION_PLAN.md`
