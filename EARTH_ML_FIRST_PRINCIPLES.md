# Earth Simulation — First-Principles ML & Historical Accumulation

Branch: `claude/fix-earth-ui-padding-cXUyH`

Companion to `WEATHER_FORECAST_PLAN.md`. That document spells out a
conventional persistence → AR → optical-flow → NN ladder. This one
sketches the parallel "Claude/ET integration" track: **we measure
what we already see, write it down forever, score every guess we
make, and let unusual methodologies compete on a level playing
field.**

The conventional ladder gives us a floor. The unusual track is how
we find a ceiling no one else is looking at.

---

## 1. North-star principles

1. **Record before predict.** No model is allowed to ship until the
   accumulator is producing reproducible append-only artifacts. If we
   can't replay the past byte-for-byte, we can't audit any forecast.
2. **One time variable.** Everything is keyed off `simTimeMs`. The
   slider, the resolver, the forecaster, and the validator share it.
   No model gets its own clock.
3. **Forecast = first-class data.** A prediction is an event with the
   same schema as an observation: `(t_target, channel, value,
   uncertainty, model_id, issued_at)`. Predictions get archived next
   to observations so future-us can re-score them with hindsight.
4. **Skill, not loss.** Every model is reported in **skill vs
   persistence** (Murphy score on MAE), not in raw MSE. A model with
   a fancy name that loses to "tomorrow looks like today" is a bug,
   not an achievement.
5. **First-principles inductive bias.** Where we know the physics
   (advection, geostrophic balance, diurnal cycle, GMST sun
   position), bake it into the model as a structural prior — don't
   hope the network rediscovers it from 24 noisy samples.
6. **Claude in the loop is allowed, but logged.** Anything an LLM
   contributes is recorded as a model with a model_id (e.g.
   `claude-pattern-v1`) and scored alongside everything else. No
   special status.
7. **ET test.** For every method, ask: "Could a being with no Earth
   priors discover this from the raw stream?" If yes, the method
   generalises. If no (e.g. it's hard-coding NWS station IDs), park
   it behind a `regional/` namespace.

---

## 2. The accumulator (Phase 0 — must land first)

Goal: a never-deleted, append-only log of everything the page
already touches. No new sensors required — we're already pulling the
data; we're just throwing it away after one paint.

### 2.1 What to capture

For each tick of every existing feed (`weather-feed`,
`earth-feeds`, `swpc-feed`, `solar-weather-history`, `wind-pipeline-feed`,
`storm-feed`, `earth-obs-feed`, `satellite-feed`, …), serialise:

| Field          | Type         | Notes                                          |
|----------------|--------------|------------------------------------------------|
| `feed_id`      | string       | e.g. `weather-grid`, `swpc-kp`, `donki-cme`    |
| `t_observed`   | int (ms UTC) | sensor / model timestamp                       |
| `t_received`   | int (ms UTC) | wall-clock when client got it                  |
| `payload_sha`  | hex          | content hash — dedupe across reloads           |
| `payload`      | bytes        | original encoding (JSON or binary CHW Float32) |
| `provenance`   | string       | upstream URL or supabase view                  |
| `client_id`    | UUID v7      | so we can attribute / aggregate                |

### 2.2 Where it lives

Two-tier storage, mirroring `weather-history.js`:

* **Hot ring (IDB, client):** last 14 days, all feeds, sharded per
  feed. Survives reloads. Sized for ~100 MB worst case.
* **Cold archive (Supabase + R2/Backblaze):** append-only object
  store keyed by `(feed_id, YYYY/MM/DD/HH, payload_sha).bin.zst`.
  Server cron pulls from existing endpoints once per natural cadence
  and writes the cold archive directly — clients are not on the
  write path. Retention: forever.

### 2.3 What this enables

* Replay any window without re-hitting upstreams.
* A/B re-score old forecasts against ground truth that arrived later.
* Train models offline, deterministically, on the same bytes the UI
  saw at the time.
* Spot upstream regressions (payload schema drifts, missing frames).

### 2.4 Files to create

* `js/accumulator.js` — generic append-only ring writer; subscribes
  to every feed's `*-update` event.
* `api/archive/ingest.js` — server endpoint that pulls each upstream
  on its cadence and writes cold-tier objects.
* `scripts/replay/from-archive.mjs` — CLI to materialise a past
  window into the same shape `weather-feed` emits at runtime.

---

## 3. Forecasting registry

Every forecaster — from "tomorrow looks like today" to a trained
NN — implements:

```js
class Forecaster {
    static id = 'persistence-v1';
    forecast({ history, simTimeMs, horizons }) → { mean, sigma, model_id, issued_at };
}
```

Each call is logged as a `(model_id, issued_at, target_ms, horizon,
mean, sigma)` row. The validator pairs it with the ground-truth
observation that lands in the accumulator at `target_ms` and
computes per-channel MAE + skill.

The leaderboard (a small SW-panel widget) lists every registered
model, ranked by 1 h / 6 h / 24 h skill. Anything below persistence
gets a red dot; we ship the top model as the default.

---

## 4. Unusual methodologies (in priority order)

Each is independently shippable. Each gets its own `model_id` and
competes in the registry above.

### 4.1 Reservoir computing on the global field (high-leverage)

Echo-state networks fit chaotic dynamics from tiny datasets — they
were practically built for this regime. ~1 K-neuron reservoir,
random sparse weights, only the readout is trained (linear regression).

* Input: flattened coarse grid at t, t-1, t-2.
* Output: grid at t+1.
* Training: `(W_out)^T = Y X^T (X X^T + λI)^{-1}` — closed form,
  ~10 ms in JS, no autograd.
* Why first-principles: the reservoir's job is to project state into
  a high-dim space where dynamics are locally linear; the linear
  readout then *finds* that linear projection. We are not assuming
  any earth-specific physics — we're assuming the system has a
  manifold (it does, it's classical mechanics).

### 4.2 Symbolic regression on derived scalars (Claude/ET flavour)

Take a small dictionary of physically meaningful scalars per cell —
divergence, vorticity, lapse rate, pressure tendency, wind shear —
and let symbolic regression (SR) search expression trees that
predict the next-step value from current values + a few neighbours.

* Library: a tiny in-house SR (genetic-programming) loop, or
  `pysr` server-side and ship the resulting expression as a JSON AST.
* The output is a **human-readable equation** ("future T ≈ T - α·∇·v
  - β·dT/dz") that we can verify against textbook geostrophic /
  thermodynamic equations.
* Win condition: rediscover at least the advection term (`∂T/∂t = -v·∇T`)
  from data alone. If we can, we know the pipeline works and we can
  start hunting for terms textbooks *don't* have.

### 4.3 LLM-as-feature-namer (Claude in the loop)

Send Claude a compact JSON snapshot of the current global field
(a few hundred floats) every 6 h with a fixed prompt:

> "Below is a coarse global state. List up to five named patterns
> you recognise (e.g. 'equatorial Kelvin wave', 'blocking high
> over Greenland'). Reply only as JSON: `[{name, lat, lon,
> radius_km, confidence}]`."

* Each named pattern becomes a `claude-pattern-v1` event in the
  accumulator.
* Validator question: do cells inside Claude's flagged regions
  produce statistically different forecast errors than cells outside?
* This is *meta-prediction*. Claude isn't predicting numbers; she's
  predicting where our other models will be wrong. Use her flags
  as a **gating function** — when she names a region, switch to a
  more conservative model (longer-horizon AR + wider error bars)
  inside the radius. Score the gated and ungated versions against
  each other.
* Cost cap: ≤ 10 K input tokens / day with prompt caching. If the
  gated model wins, the bill is justified and the experiment scales.
  If not, we kill it transparently.

### 4.4 Topological signal — persistent homology of the field

Treat each frame's pressure / vorticity field as a function on the
sphere. Compute its persistence diagram (a list of `(birth, death)`
pairs of topological features). Track those features through time.

* A storm is a topological feature with long persistence. Watching
  features merge / split is a robust early-warning signal that no
  AR model captures.
* Library: `js-persistent-homology` (small, can ship), or compute
  server-side and stream features.
* This is the "ET" methodology — it makes no use of the fact that
  the data is weather. Any field on any manifold gets the same
  treatment. If it works here, it'll work for the Sun's photosphere
  too (and we have that page already).

### 4.5 Information-bottleneck encoder

Train a tiny autoencoder (8-D bottleneck) on the coarse field.
Forecast in the latent space (linear dynamics work surprisingly well
on IB-compressed states), then decode.

* The bottleneck *forces* the model to discover the field's intrinsic
  degrees of freedom. The latent dim where forecasts go from "random"
  to "good" is the field's effective complexity. We learn something
  about Earth's atmosphere just by training the autoencoder.
* Side benefit: the 8-D latent is small enough to log every frame in
  the accumulator at trivial cost — a cheap perceptual-hash for the
  whole planet's weather state.

### 4.6 Self-distillation against Claude

Once we have ≥ 30 days of accumulator data:

1. Sample 100 random past windows.
2. For each, compose a prompt: "Here is what we knew at `t`. Here is
   what actually happened at `t + 6h`. What rule, in one sentence,
   would have predicted this?"
3. Collect the 100 rules. Use Claude to cluster them, write
   pseudo-code for the top 10, and ship them as scoreable models.

The interesting case is when one of those rules **beats AR + flow**.
That rule is a paper.

---

## 5. Phasing

| Phase | Scope | Ship gate |
|---|---|---|
| 0 | Accumulator hot ring (`accumulator.js`) | All existing feeds writing into IDB; replay round-trips byte-equal. |
| 0a | Cold archive cron + ingest endpoint | 24 h of cold data verified replayable. |
| 1 | Forecaster registry + persistence baseline + validator (per `WEATHER_FORECAST_PLAN.md`) | Skill table populated against persistence with hand-checked numbers. |
| 2 | Reservoir-computing forecaster (4.1) | Beats persistence at 1 h on T and U/V. |
| 3 | Symbolic regression on derived scalars (4.2) | Recovers advection term from 30 d of data. |
| 4 | LLM-feature-namer gating (4.3) | Gated forecast strictly dominates ungated on storm-region cells. |
| 5 | Topological / IB / self-distill (4.4-4.6) | Any one of these earns the top spot on the registry leaderboard. |

Phases 0 and 0a are blocking; 1 unlocks everything else; 2-5 are
independent and parallelisable.

---

## 6. Slider integration

The current slider (this branch) covers `-7d .. +3d`. The
accumulator (§2) is what makes the past side meaningful past the
24-hour ring; the forecaster registry (§3) is what makes the future
side meaningful past "persistence". Until those land, scrubbing
beyond `-24h` clamps to the oldest frame, and scrubbing beyond `0`
freezes weather while sun and satellites continue (acceptable
stand-in; the slider track paints the future side amber so the user
knows the layers aren't real predictions yet).

Once Phase 1 ships, the future side switches from "frozen
persistence" to "registered forecast". Once Phase 0 ships, the past
side stretches honestly to a full week.

---

## 7. Open questions

* **Storage budget.** Is 100 MB IDB acceptable on mobile? Audit
  Safari's quotas — we may need a 7-day client cap with the cold
  archive doing the long memory.
* **Claude rate-limit / cost ceiling.** Need a kill-switch and a
  weekly spend report before turning §4.3 on for all sessions.
* **Reproducibility on forecasts.** The reservoir's random init
  must be seeded and logged. Same for any GP run. No "I lost the
  seed, the result doesn't repro" allowed in the registry.
* **Coordinate with `WEATHER_FORECAST_PLAN.md` Phase 4.** That doc
  proposes a server-trained NN. If Phase 5 here reaches the same
  conclusion, we converge — otherwise the registry surfaces which
  was the better bet without us having to argue about it.
