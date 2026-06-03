# Accretion-Disc → Planetary / Stellar Disc Workshop — Plan

> **Status:** planning only. No code in this document is implemented yet.
> **Branch:** `claude/confident-gauss-ZEFR9`
> **Scope decision (2026-06-03):** prioritize **scientific validity first**, then
> **user exploration / parameter-nudging**. The data-collection *backend*
> (storing run outcomes in Supabase) is **deferred** — everything here is
> client-side. See §6 for what "data validity" means without a backend.

---

## 0. Why this doc exists

`accretion-disc.html` + `js/accretion-disc/` is already a real 1D viscous-disc +
N-body planet-formation engine, not a toy (see §1). The goal is to grow it into a
reproducible **laboratory**: an instrument a user can trust, perturb, and learn
from. This plan deliberately front-loads the unglamorous foundations
(determinism, conservation, validation) because **none of the exploration
features are worth anything if the underlying run isn't reproducible and
physically self-consistent.**

Read this before touching `js/accretion-disc/*`. The physics modules carry
load-bearing comments; respect `CLAUDE.md` §4 (load-bearing invariants), §5
(reversion pattern), and §9 (ask-first list).

---

## 1. Baseline — what exists today

**Files**
- `accretion-disc.html` (807 lines) — single page, flat at repo root, CDN
  Three.js via import map, `<script type=module>` wires a `ui` object to
  `boot()`. Not in `scripts/nav-lint-baseline.json` (passes lint clean).
- `js/accretion-disc/physics.js` (440) — disc + N-body physics core.
- `js/accretion-disc/habitable.js` (180) — HZ, T_eq, atmospheric escape, stellar tracks.
- `js/accretion-disc/scenarios.js` (149) — the single Solar-System scenario + body builder.
- `js/accretion-disc/disc.js` (1511) — Three.js orchestrator, sim loop, HUD, CSV export, UI bindings.

**No** WASM, **no** `api/` endpoint, **no** telemetry. Pure ES modules; one sim per page.

**Physics already implemented** (with literature citations in-code):
- Hayashi (1981) MMSN initial Σ(r)/T(r); water snow line at 170 K.
- Shakura & Sunyaev (1973) α-viscosity; Lynden-Bell & Pringle (1974) 1D viscous
  spreading on a log-r grid (explicit FTCS, CFL-limited `discDt`).
- Owen+ (2012) photoevaporation sink.
- Weidenschilling (1977) / Birnstiel+ (2012) dust radial drift; Lambrechts &
  Johansen (2012) pebble accretion; Lambrechts+ (2014)/Bitsch+ (2018) pebble-isolation mass.
- Paardekooper+ (2010/11) Type I migration torque; Crida+ (2006) gap criterion → Type II.
- 3D heliocentric leapfrog (kick-drift-kick) N-body with softened gravity;
  inelastic Hill-radius mergers.
- Giant-impact module (Theia → Moon, Canup 2012 / Ćuk & Stewart 2012); Martian-moon
  inspiral; fluid Roche limit.
- Kopparapu+ (2013/14) HZ boundaries; grey-atmosphere greenhouse; energy-limited
  XUV escape (Watson+ 1981, Erkaev+ 2007); FGK stellar L(t)/T_eff(t)/F_XUV(t) tracks; Toomre Q.

**UI today:** one scenario (Solar System). Live sliders — `star.Mstar_solar`,
`star.ageStartYr`, `disc.Mdisc_Msun`, `disc.alpha`, `disc.rOutAU`,
`disc.dustGasRatio`, `disc.n`, `embryos.seedMultiplier`, `embryos.jitterAU` —
plus physics toggles (pebble, Type I, Type II, photoEvap, collisions), a
time-warp slider, HUD readouts (L★, T_eff, snow line, HZ, mass budget, Ṁ★), four
profile sparklines (Σ, dust, T, Q), a resonance scanner, a body table, and a
single end-state CSV export.

**Gaps this plan addresses first:**
1. `Math.random()` is called in `scenarios.js` (`buildInitialBodies`,
   `INCL_MAX_RAD` spread) and `disc.js` (jitter) → **runs are not reproducible.**
2. Every slider calls `applyConfig → rebuildWorld`, destroying the run — even for
   parameters that could update in place. Jarring, and makes "nudging" impossible.
3. **No conservation diagnostics** — angular momentum / energy / mass drift are
   invisible, so numerical health is unknowable.
4. **No validation against reality** — nothing tells the user (or us) whether an
   outcome resembles the real Solar System or the observed exoplanet population.

---

## 2. Priorities (locked)

| Rank | Dimension | Why first |
|------|-----------|-----------|
| 1 | **Scientific validity** | A laboratory the user can't trust is a screensaver. Determinism + conservation + validation overlays are the credibility floor. |
| 2 | **Exploration / nudging** | Once a run is reproducible and self-consistent, make it pleasant to perturb and compare. |
| — | Data backend (Supabase run storage) | **Deferred.** Revisit after Phases 0–1 prove value. |

This ordering drives the sequencing below: **Phase 0 (foundations) and the
client-side half of data-validity (§6) come before any new scenarios, deeper
physics, or UX polish.**

---

## 3. Phase 0 — Foundations & determinism (do first)

Small, self-contained, all client-side. Each item is independently shippable.

### 3.1 Seeded RNG (reproducibility prerequisite) — ✅ IMPLEMENTED
*Status (2026-06-03):* shipped. `js/accretion-disc/rng.js` (mulberry32 +
`normalizeSeed`/`randomSeed`) is threaded through `buildInitialBodies(scenario, rng)`
and the jitter path; the RNG is re-seeded from `sim.seed` at the top of every
`rebuildDiscAndBodies()`, so `(scenario, seed, cfg)` reproduces an identical
world. A "world seed" control (numeric or memorable-name input + 🎲 reroll) is in
the left sidebar; `?seed=` in the URL restores a specific world (a down payment
on §3.2). Covered by `tests/accretion-disc-seed-smoke.mjs` (determinism +
divergence + the Theia coupling invariant). The original spec follows:

- Add a tiny PRNG (e.g. `mulberry32` / `splitmix32`, ~10 lines, no deps) in a new
  `js/accretion-disc/rng.js`. Pure function factory: `makeRng(seed) → () => float`.
- Thread an injectable `rng` through `buildInitialBodies(scenario, rng)` and the
  jitter path in `disc.js` `rebuildDiscAndBodies()`. **Replace every
  `Math.random()` in the accretion-disc modules** with `rng()`.
- Store the active `seed` on `sim` and surface it in the HUD; add a "🎲 new seed"
  button and a numeric seed input. Same seed + same config ⇒ bit-identical run.
- **Invariant to preserve:** the Theia/proto-Earth co-planar coupling in
  `scenarios.js` (Theia inherits Earth's inclination + node so the giant impact
  actually happens). Seeding must not break that — keep the `flagEarth`/`flagTheia`
  ordering logic; only the random *source* changes.

### 3.2 Config ⇄ URL permalink
- Serialize `{ scenarioId, seed, cfg }` to a compact query string (and/or hash);
  parse on boot to restore exact state. Keep it versioned (`v=` key) so old links
  degrade gracefully when the schema changes.
- "Copy link" button. Every experiment becomes a shareable, reproducible URL —
  this is the backbone of "data validity without a backend": a permalink *is* a
  reproducibility bundle.
- Encoding must round-trip through `defaultCfg()` so missing keys fall back to
  scenario defaults (forward/backward compatible).

### 3.3 Decouple "rebuild" from "live nudge"
- Classify each config key as **structural** (requires `rebuildWorld`: `disc.n`,
  `disc.rInAU`/`rOutAU`, scenario, seed, embryo seed/jitter) vs **live** (mutate
  in place without dropping the run: `disc.alpha`, `disc.dustGasRatio`,
  `star.*` luminosity inputs, physics toggles, time-warp).
- `applyConfig(partial)` inspects which keys changed and only calls
  `rebuildWorld()` when a structural key moved; otherwise patches `sim.cfg` and
  lets the next `tick()` pick it up. α and dust:gas already feed the per-step
  physics directly, so live update is mostly a matter of *not* rebuilding.
- Net effect: the user can drag α mid-run and watch the disc respond, instead of
  resetting to t=0 on every twitch.

### 3.4 Conservation diagnostics (the correctness guardrail)
- Each step, accumulate and expose:
  - **Total angular momentum** `L = Σ_planets m (r × v)_z + disc L` — track % drift
    from the initial value.
  - **Total energy** (kinetic + stellar potential + mutual PE) for the N-body
    subsystem — track drift; leapfrog should bound it, so growth flags a bug or a
    too-large `dt`.
  - **Mass budget closure**: `M_gas + M_dust + Σ M_planets + M_accreted` constant
    (HUD already computes the pieces in `updateHud`; add the closure check).
- HUD shows drift as a small green/amber/red indicator. Thresholds become CI
  assertions in §6.3. This doubles as marketing: "physics-first, conserved to <X%"
  aligns with `CLAUDE.md` §7 (physics-first, not ML black boxes).
- **Watch the existing inner-boundary drain and photoevap sink** in `stepDisc` —
  they legitimately remove mass/AM (onto the star / in a wind). The closure check
  must credit `disc.Mdotacc` and a new photoevap accumulator, not flag them as
  violations.

### 3.4b Setup lobby ("start a game" framing) — ✅ IMPLEMENTED
*Added 2026-06-03 per user direction* — make configuring a run feel like setting
up an Age-of-Empires / RPG match. The lab now opens in a **setup lobby**: the
world is built and shown as a static, camera-orbitable preview, but physics does
not advance until the user clicks **Begin Formation**. A launch overlay on the
stage summarizes the chosen world (star mass, disc mass, α, dust:gas, seed count,
world seed) and updates live as sliders move. `sim.started` gates the tick;
`sim.paused` remains the post-launch play/pause. Reset = "replay this exact
world" (rebuild from current cfg + seed, back to the lobby), which also fixes the
prior slider-desync where reset silently reverted cfg to defaults. This is a UX
layer over §3.1's determinism — the seed is the "world seed" the lobby exposes.

### 3.5 Phase 0 acceptance
- Two runs with identical `{scenario, seed, cfg}` produce identical body tables
  and CSV (byte-for-byte) — verified by a golden test (§6.3).
- A permalink restores an in-progress configuration exactly.
- Dragging a "live" slider does not reset `sim.ageYr`.
- Conservation drift over a reference 100-Myr run stays within documented bounds.

---

## 4. Phase 1 — Scientific-validity deepening (after Phase 0)

Still validity-first; these raise the *physical* fidelity before we broaden UX.
Ordered by value-per-risk:

1. **Eccentricity & inclination damping** (Cresswell & Nelson 2008). Today embryos
   migrate only in `a`; real disc–planet interaction damps e/i on short timescales
   and is what makes resonance capture and post-disc instability realistic. Add
   e/i to body readouts. *Biggest realism gain.*
2. **Collision-outcome model** (Leinhardt & Stewart 2012): replace
   always-merge (`handleCollisions`/`mergeBodies`) with merge / hit-and-run /
   erosion / fragmentation keyed on impact velocity vs mutual escape velocity.
   Strengthens the giant-impact narrative and Solar-System validation.
3. **Gas accretion onto cores** past pebble-isolation (runaway, Ikoma/Pollack-style)
   so giants grow to Jupiter mass *within* the disc lifetime instead of being
   seeded near-final in `scenarios.js`.
4. **Viscous + irradiated disc temperature** (not just passive Hayashi) so inner-T
   responds to Ṁ and α — currently `T(r)` is refreshed purely from stellar L.
5. **Multiple ice lines** (H₂O, CO₂, CO) + per-body composition (rock/ice/gas
   fraction) → a "what is this planet made of" readout, and a stronger validation
   target.

Deeper/optional (deferred within Phase 1): dead zones / MRI layering,
streaming-instability planetesimal threshold, gravitational-instability
fragmentation channel, binary/circumbinary scenarios.

> **Performance note:** the N-body + LBP loop is the hot path; items 1–3 increase
> per-step cost. If frame budget becomes the limiter, move the sim into a **Web
> Worker** (render thread reads a transferable state buffer) before considering a
> Rust→WASM port of the integrator. A WASM port fits the repo's existing
> `build-wasm.sh` pattern but is the **largest lift and is gated behind explicit
> approval** (`CLAUDE.md` §9 — it would shadow a load-bearing, readable JS reference).

---

## 5. Phase 2 — Exploration / nudging UX (priority 2)

Only after Phases 0–1. Sketch (expanded in a follow-up revision):
- Scenario **registry** (generalize `scenarios.js` from one hard-coded object):
  M-dwarf compact system, hot-Jupiter migration, super-Earth factory, sandbox.
- **Comparison overlays**: ghost a second config / the same seed with one param
  changed, A/B in the same scene.
- **Parameter-sweep runner** (client-side, in the Worker): 1–2 axes × N seeds,
  render an outcome heatmap (planets-in-HZ, final giant mass, system survived?).
- **Guided experiments**: scripted labs ("reproduce the Grand Tack", "make a hot
  Jupiter") = preset config + narrative + success check.
- **Measurement tools**: click-a-body info card, resonance-strength meter, ruler.

---

## 6. Data validity — what "continuously improve" means **without** a backend

The repo ethos (`CLAUDE.md` §7) is **physics-first ground truth, not ML black
boxes**. With run-storage deferred, "improving the simulation" reduces to three
client-side / offline loops. All are about **validation and calibration**, never
replacing the physics.

### 6.1 Validation against observational ground truth (ship as static data)
Bundle curated, **versioned** reference datasets (small JSON shipped with the
page — no backend) and let the sim score itself against them:
- **Solar System architecture** (masses, a, e, i, composition) — the canonical target.
- **NASA Exoplanet Archive / exoplanet.eu** snapshot — period–mass–radius scatter,
  multiplicity, resonant-chain fraction — to place a run inside/outside the
  observed population.
- **ALMA disc surveys** (DSHARP Σ(r) profiles; Andrews 2020 disc-mass/size
  relations) — validates the *disc* phase, not just the planets.
- **Meteoritic / CAI chronology** — anchors the formation timeline.

Deliverable: a **validation overlay** — plot the live system against the chosen
reference (Solar-System architecture first, since it's the existing scenario) and
a single "realism score." This is the highest-leverage validity feature because
the ground truth is public, requires zero user data, and makes physics changes
*visibly* better or worse.

### 6.2 Benchmark calibration against reference codes (offline, for trust)
Not user-facing; the scientifically important loop. Validate our prescriptions
against established codes/runs and **calibrate the free coefficients we currently
hard-code**:
- `C_iso ≈ −3.2` Type-I prefactor (`typeIMigrationRate`) vs FARGO3D torque benchmarks.
- Pebble-accretion transition factor (`pebbleAccretionRate`) vs published
  Lambrechts & Johansen results / DustPy.
- Photoevap normalization (`stepDisc`) vs Owen+ models.
- N-body integrator vs **REBOUND** on a known resonant/instability test.
- Stellar tracks (`habitable.js`) vs **MESA/MIST** grids.

Each comparison becomes a committed regression artifact (§6.3) so future edits
can't silently drift the physics.

### 6.3 Golden runs & conservation as CI (the regression net)
- Fixed-seed **golden runs** under `tests/` (repo expects smoke tests,
  `CLAUDE.md` §10.6): assert (a) byte-identical reproduction for a given
  `{scenario, seed, cfg}`, (b) conservation drift < documented threshold, (c) key
  outcome metrics (final planet count, giant mass, # in HZ) within tolerance.
- These are enabled by Phase 0 (§3.1, §3.4). Without seeded RNG + conservation
  tracking, none of this is testable — which is exactly why foundations come first.

### 6.4 Run-outcome storage (Supabase) — **PARKED**
Documented for completeness; **not** in current scope. When revisited it would be
a `sim_runs` table + a `SECURITY DEFINER log_sim_run(...)` RPC
(`SET search_path = public, pg_temp`, permissive INSERT, service-role read —
the anonymous-instrumentation pattern of `CLAUDE.md` §4.2), opt-in,
rate-limited, **no PII**. A run permalink (§3.2) already serves as a manual,
zero-backend "reproducibility bundle" in the meantime. Decision to build this is
explicitly deferred pending Phase 0–1 results.

---

## 7. Guardrails & repo invariants (must hold)
- **No framework / no bundler / flat `*.html` at root / CDN Three.js** preserved
  (`CLAUDE.md` §1, §9). All new code is plain ES modules under `js/accretion-disc/`.
- Don't reorder or "simplify" the load-bearing logic in `scenarios.js` (Theia
  coupling) or `physics.js` (boundary drain, photoevap sink, softening).
- If any new top-level page is added, copy the canonical `<nav>` and run
  `node scripts/lint-nav.mjs`; register in `scripts/nav-lint-baseline.json` only if
  unavoidable (`CLAUDE.md` §4.4, §8).
- Before opening a PR, re-read `CLAUDE.md` §5 (reversion pattern) and diff against
  `origin/main`.

---

## 8. Suggested first slice (concrete)

Ship Phase 0 in this order, each as a small reviewable change:

1. `rng.js` + thread seeded RNG through `scenarios.js` / `disc.js`; seed in HUD +
   "new seed" control. (§3.1)
2. Conservation diagnostics in `tick()` + HUD indicator. (§3.4)
3. Config ⇄ URL permalink. (§3.2)
4. Live-vs-structural config split so α / dust:gas nudge in place. (§3.3)
5. Solar-System **validation overlay** + realism score (first slice of §6.1).
6. First golden test under `tests/` (reproducibility + conservation). (§6.3)

That sequence delivers a reproducible, self-consistent, self-validating run —
the scientific-validity floor — entirely client-side, before any new scenarios or
UX work begins.

---

## 9. Open questions to resolve before building

1. **Permalink transport:** query string vs URL hash? (Hash avoids server log
   noise and needs no routing; query string is more conventional. Leaning hash.)
2. **Conservation thresholds:** what drift % over a 100-Myr reference run counts as
   "pass" for CI? Needs one calibration run to set honestly.
3. **Validation reference snapshot cadence:** pin a dated NASA Exoplanet Archive
   export (reproducible) vs periodic manual refresh? Leaning pinned + dated.
4. **Realism score definition:** single scalar vs per-axis (mass spectrum, spacing,
   HZ occupancy)? Affects how §6.1 is presented.

---

*Plan authored 2026-06-03. Scope: validity-first, exploration-second, run-storage
backend deferred. Update this doc as phases land rather than letting it drift.*
