# Storm Observatory — Design & Build Plan

**Page:** `storm-observatory.html` (new, flat at root) · **Modules:** `js/storm/` (new family) + `rust-storm/` (new WASM kernel)
**Status:** PLAN — drafted 2026-07-06. Nothing built yet; open decisions in §8.
**Goal:** a superposed-epoch comparison instrument for thermospheric storms — multiple storm
epochs τ-aligned on one canvas, the LEO catalog flown through each storm's density history
as test particles, every driver dial carrying its observational provenance. The satellite-drag
counterpart of `blackhole-observatory.html`, aimed at the B2G / satellite-operator wedge
(CLAUDE.md §7: physics-first ground truth, Starlink Feb-2022 as the canonical proof point,
Gannon May-2024 as the hindcast validation).

---

## 0. What this is — and what it is not

- **NOT** a rebuild of `operations.html`. The Operations console answers *"what is my fleet
  doing now and over the next 72 h"* — live SGP4 (SAB + Atomics worker), decay watch,
  conjunction screening. Different question, keep both.
- **NOT** a second Gannon page. `gannon-superstorm.html` is single-event replay with the
  MHD-vs-ground driver skill story.
- **IS** the missing comparison instrument: N storms stacked on the shared axis
  τ = t − t_peak, the *same* satellite population responding to each storm's density history,
  divergence made visible and quantified. Superposed-epoch analysis — a standard technique in
  the storm literature — productized as an interactive instrument. Nobody ships this.

The pitch line writes itself: *"The Feb 2022 storm that killed 38 Starlink satellites was a
G1–G2 — minor. Scrub the same constellation through May 2024's G5 and the quiet counterfactual,
and see what your density model must get right."*

---

## 1. Reuse map — what "built on the existing chassis" means concretely

### From the black-hole observatory (just shipped)

| Piece | Source | Change needed |
|---|---|---|
| ECS world/systems | `js/abell85/ecs.js` | none — generic |
| God camera | `js/abell85/camera.js` | none — generic |
| Worker protocol (lane engines, transferable ping-pong, **copy-on-receive** guard) | `js/abell85/simworker.js` / `laneengine.js` / `observatory.js` PhysicsSystem | port with storm content |
| τ-sync axis | `js/abell85/twinsync.js` | generalize: τ = t − t_peak(ap) instead of t − t_merger |
| Multi-lane tinted composite, markers, trails, shells | `js/abell85/render.js` | add ONE shared Earth (all lanes fly the same planet); satellites drawn per-lane-tinted |
| Rail + provenance tags + presets + inspector + mobile drawer | `blackhole-observatory.html` CSS + `observatory.js` UISystem/InspectSystem | port with new content |
| WASM discipline: bit-exact JS↔Rust parity, committed artifact, `build-wasm.sh` section, test contract | `rust-abell85/`, test 22 pattern | new kernel, same rules |
| Per-particle adaptive substeps (~9× win) | `nbody.js` / `lib.rs` tier rule | tier keyed on **perigee altitude** instead of BH distance — only h ≲ 300 km objects need fine steps |

### From the atmosphere/satellite stack (already in the repo — this is why the plan is cheap)

| Piece | Where | Role here |
|---|---|---|
| Replay bundle schema v1 + `loadReplay({url})` (explicitly designed for more events) | `js/gannon-superstorm-engine.js`, `data/hindcast/gannon_may_2024_replay.json` | **lanes ARE bundles** |
| Bundle pipeline | `scripts/build-replay-bundle.mjs`, `fetch-omni.mjs`, `fetch-grace.mjs`, `bake-real-gannon-*.mjs` | compose the two new bundles |
| NRLMSISE-00 in Rust→WASM + bridge | `rust-sgp4/src/nrlmsise00.rs`, `js/nrlmsise00-bridge.js` | offline density-grid generation (gold standard) |
| Jacchia-style JS surrogate | `js/upper-atmosphere-engine.js` | fallback density model + composition |
| Catalog + B* | `api/celestrak/tle.js` / `satcat.js`, `js/satcat-catalog.js`, `js/debris-catalog.js` | particle population |
| Provenance record conventions | `js/operations/provenance.js` (source / model / sigma / cacheState) | inspector + dial source strings |
| Honesty conventions | Gannon bundle `_is_placeholder` watermark, `provenance` block, `truth_400km` (GRACE-FO, TU Delft v02c), `skill` block | adopted wholesale |

**Genuinely new:** two bundles (Starlink Feb-2022, quiet counterfactual), an additive
density-grid extension to the bundle schema, the drag-decay kernel (JS reference + Rust port),
the Earth scene, and the page wiring.

---

## 2. Lanes

1. **starlink2022** (violet `#a99bff`) — *the storm that killed 38 satellites*. Feb 1–8 2022:
   two **moderate** (G1–G2) storms, ~50 % density enhancement at ~210 km, 38 of 49 Starlink
   Group 4-7 satellites lost from their 210 km injection orbit. The proof that models
   underpredicting *minor* storms is an operational, revenue-destroying problem.
2. **gannon2024** (gold `#f0bd55`) — *the extreme*. May 10–13 2024 G5. Reuses the existing
   bundle including the `ap_real / ap_mhd / ap_gnd` driver-source dial — the MHD
   differentiator on stage — and GRACE-FO truth density for the skill readout.
3. **quiet** (teal `#4fd1b8`) — *the counterfactual*. Same windows with ap pinned to quiet
   climatology (the `driveCounterfactual` hook is already named in the Gannon engine). Every
   Δ against this lane is "what the storm cost you." Its flatness on the τ axis plays the
   same narrative role as B2 0402's stall.

τ-sync on t − t(ap peak) (single documented choice; Dst-min is the alternative). Same lane
colors as the black-hole observatory — the palette is already CVD-validated.

---

## 3. Phase S0 — data spine

- **Extend bundle schema additively** (stays v1; the engine tolerates extra keys):
  - `density_grid`: `{ alt_km: [150…1000 step 25], rho: [t][alt] }` in kg/m³, computed
    **offline** by NRLMSISE-00 (`rust-sgp4`) driven by the lane's ap/F10.7 series. The hot
    loop never calls MSIS — it does table lookups, exactly like the Dehnen closed forms.
  - `f107`, `dst` arrays alongside `drivers_compact`.
  - `cohort` (starlink2022 only): the 49 Group 4-7 injection states (~210 × 340 km, i = 53.2°,
    launch epoch, mass/area → B*-equivalent) so the loss event replays with real elements.
- **New script** `scripts/build-storm-bundle.mjs` following `build-replay-bundle.mjs`
  conventions; ap/F10.7 for Feb 2022 baked from GFZ/NOAA archives via the `fetch-omni.mjs`
  pattern. Anything not yet real ships watermarked `_is_placeholder`, per the Gannon rule.
- **Catalog snapshot**: one committed preprocessed asset (Float32 elements
  `a,e,i,Ω,ω,M,B*` per object + side JSON of names/NORAD ids) built from `api/celestrak`
  GP data, filtered to perigee ≤ 1000 km. Historical per-epoch TLEs are Space-Track-auth
  territory — v1 seeds **today's catalog** into every lane and says so on the methods panel
  ("today's population, yesterday's storm"); the Starlink cohort uses true injection elements.

## 4. Phase S1 — physics core (JS reference first, tests before WASM)

Per-particle state: mean elements + B* + flag. Per step:
ρ = `densityGrid.sample(h_eff, τ)` → near-circular King-Hele decay
`ȧ = −√(μa) · ρ · (B*-derived ballistic coefficient)`, J2 secular Ω̇/ω̇, mean anomaly advanced
by n(a); render positions via Kepler solve. Flags mirror the black-hole observatory:
0 nominal · 3 **high-drag** (dynamic pressure over threshold — the cyan population) ·
1 decaying (h < 180 km) · 2 reentered (removed after a burst shell).

Validation contract (`tests/storm-physics.mjs`, same style as the abell85 suite):
1. J2 nodal regression for an ISS-like orbit matches the textbook rate to < 0.5 %.
2. Quiet-lane decay rate at ISS altitude inside the published solar-moderate band.
3. **Starlink check**: ≥ ~30 of 49 passive cohort satellites decay within the event window
   under the Feb-2022 grid; **0** decay in the quiet counterfactual. (Observed: 38 lost;
   passive-vs-edge-on-flying caveat documented — we model no thrust, no attitude changes.)
4. **Gannon check**: ρ(400 km) track matches the bundle's GRACE-FO `truth_400km` within the
   bundle's own `skill`/`fit` tolerances; catalog-median decay multiple vs quiet inside the
   published ×2–3 enhancement band.
5. Determinism: same bundle + seed → bit-identical output.

## 5. Phase S2 — WASM kernel

`rust-storm/` in the `rust-abell85` mold: separate crate, workspace-excluded, raw
`extern "C"` (no bindgen), committed artifact `js/storm-wasm/storm_drag.wasm`,
`build-wasm.sh` section with committed-binary fallback. Same parity discipline: mirror the
JS f32 store/reload sequence → bit-exact test; density grid uploaded once into WASM linear
memory; per-particle adaptive substeps keyed on perigee altitude. Budget target:
3 lanes × 20 k objects ≤ 15 ms/physics-frame (cheaper per particle than the N-body — no force
loop, mostly table lookups + Kepler iteration; abell85 measured basis supports this).

## 6. Phase S3 — the page

- **ECS systems** (port of `observatory.js`): Timeline(τ) · Physics(worker) · StormChoreo
  (storm-peak caption flash; reentry burst shells) · Trails (selected object) · Camera ·
  Render · HUD · Analytics · UI.
- **Render**: one shared Earth (graticule sphere + terminator; lanes differ by population
  tint, not by planet). Each catalog object drawn once per visible lane; initially the three
  copies coincide, and storm-driven decay separates them. Real Δa is meters-to-km against a
  6371 km globe, so the rail gets an **altitude-loss exaggeration dial (×1 / ×50 / ×500,
  display-only, loudly labeled)** — the honest default view is ×1 plus the charts.
- **Charts dock**: ρ(400 km) vs τ, all lanes + GRACE-FO truth dots; cumulative
  decayed/reentered count vs τ; comparison grid (ρ×quiet, median ȧ, decayed count, cohort
  survivors, median dynamic pressure, model-vs-truth skill where truth exists).
- **Rail dials with provenance** (abell85 tag CSS, operations provenance source strings):
  ap series [measured — GFZ definitive] · F10.7 [measured — NOAA] · Gannon driver source
  [measured ap_real / modeled ap_mhd / modeled ap_gnd — the MHD A/B as a dial] · density
  model [NRLMSISE-00 / Jacchia surrogate] · storm intensity multiplier [free — crank Gannon
  toward Carrington-class] · B* uncertainty [assumed] · exaggeration [display-only].
- **Inspector** (tap an object): name/NORAD id, perigee × apogee, B*, dynamic pressure
  q = ½ρv², ȧ now, **Δa vs quiet lane**, estimated lifetime.
- **Presets** ("experiments"): *replay Feb 2022 as-flown* · *Starlink batch into Gannon* ·
  *Carrington-class multiplier* · *MHD vs ground drivers*.
- Mobile drawer rail, engine chip, stars→objects count dial: straight ports.

## 7. Phase S4 — honesty & B2G hooks

- `_is_placeholder` watermark until every input is real; `provenance` + `skill` blocks
  rendered on the methods panel; every approximation named there (near-circular decay,
  passive-satellite caveat, catalog-seeding caveat, exaggeration dial).
- Export: per-object Δa / decay-ETA CSV per lane; shareable state permalink.
- Cross-link `for-operators.html` and the Gannon page; this page is demo-day material for
  SBIR/operator briefings.

---

## 8. Open decisions (ask before building)

1. **Nav home**: Space Weather dropdown (next to Gannon Superstorm) or Satellites dropdown
   (next to Operations)? Plan assumes Space Weather.
2. **Tier**: public (like Gannon) or PRO-preview badge (like Operations)? Plan assumes public
   — it's a story/credibility page, not a fleet tool.
3. **Catalog scope v1**: LEO subset ~15–20 k objects as a committed ~1–2 MB asset, or curated
   ~5 k (Starlink shells + stations + major debris bands)? Plan assumes the LEO subset.
4. **Third lane**: quiet counterfactual (recommended, zero new data) vs a third real storm
   (Halloween 2003 — thinner data, no GRACE-FO-class truth).
5. **Audio**: sonify ρ(400 km) through the shared `gwaudio.js` oscillator? Cheap, possibly
   gimmicky — default off in plan.

## 9. Effort estimate

S0 bundles + catalog ≈ 1 session · S1 JS core + tests ≈ 1 · S2 WASM + parity ≈ 0.5 ·
S3 page ≈ 1–1.5 · S4 polish ≈ 0.5. The chassis + existing data spine are what keep this at
~4 sessions instead of ~10.
