# The 3D Sun→Earth corridor — architecture

> One scene for three programmes. Far-Side Watch says where a source region
> is and when rotation will bring it into view; the flux-rope simulator says
> where the compounding train is; the CME forecast says when something is due
> at L1. They were three pages telling one story. The corridor is where the
> story is drawn.

Lives on `cme-forecast.html` behind the left panel's **Calendar / 3D corridor**
tab. The calendar stays the default and pays nothing for the 3D: three.js, the
corridor modules and the WASM ensemble are all dynamically imported on first
open, and `tests/cme-corridor.spec.js` fails if any of them loads eagerly.

## Where it lives

| Layer | File |
|-------|------|
| Pure scene model | `js/corridor/corridor-model.js` (node: `tests/corridor-model.mjs`) |
| Renderer | `js/corridor/corridor-view.js` (browser-only) |
| Mount + data + clock | `js/corridor/corridor-panel.js` |
| Flare base rate | `js/farside/flare-climatology.js` (node: `tests/flare-climatology.mjs`) |
| Browser gate | `tests/cme-corridor.spec.js` |
| Host | `cme-forecast.html` → `#cmef-corridor-host`, tabs `[data-cmef-view]` |

## Nothing here computes physics

Every number is somebody else's, on purpose:

- **Rope geometry** — the live kernel's per-rope probes `apexKmAt(i, tS)` /
  `sigmaApexKmAt(i, tS)`, on the SAME kernel instance the shared provider
  (`js/flux-rope-forecast.js`) ran. Oracle-direct, so the train's wake and
  §16 interaction are the kernel's answer. Without a kernel it falls back to
  `stage/model.js` `ropeSpecAt`, itself a pinned mirror of the Rust; the
  fallback is flagged `oracle:'mirror'` on the result.
- **Rope surfaces** — `stage/model.js` `ropeSurfaceGrid`, the SDF zero level.
- **Scale** — `stage/scale.js` `stagePoint` / `BODY` / `rulerTicks`. The
  corridor adds no dishonesty of its own; the repo keeps them all in one file
  with their factors, and the compression is removable (`True scale`).
- **Region positions** — `farside-track.js` `projectTracks`, the same call the
  Far-Side Watch list uses.
- **The clock** — `farside/farside-clock.js`, the same module Far-Side Watch
  drives its rotation simulation with.

## The identity that makes the join free

`ropeFrame(lonDeg, …)` in `js/flux-rope/view.js` takes **Stonyhurst**
heliographic longitude — degrees from the Sun-Earth line. Far-Side Watch
reports a region's **central-meridian distance**, `wrap180(lonCarr − L0)`.

Those are the same quantity. CMD *is* Stonyhurst longitude. So a source
region's direction in the flux-rope frame is just `ropeFrame(cmd, lat, 0)`,
and a marker on the Sun sits in exactly the frame a rope launched from it
would use — no conversion, no third convention, and no way for a region and
its own CME to end up on opposite limbs. `tests/corridor-model.mjs` pins it.

## Regions co-rotate; ropes do not

A surface region is carried by rotation, so its CMD is a function of the
clock. A launched rope is ballistic — its heading was fixed at launch. Moving
the clock therefore sweeps the Sun's surface under a train that holds its
course. That is the actual physics and the one thing a static picture cannot
show; the browser gate asserts both halves (`ropeHeadings` unchanged while
`firstSourceCmd` moves and `leadApexAu` grows). Do not "fix" the ropes to
rotate with the Sun.

## The Sun is never rotated as an object

Its photosphere shader derives Carrington longitude per fragment from the
world direction plus the uniform `uL0`. Advancing the clock sweeps the field
while the mesh stands still. That matters because the region markers are
placed in the world frame from a CMD that already contains L0 — rotating a
textured mesh under fixed markers is precisely how a field and its own
detections drift apart. `uL0` is the only place the clock touches the Sun.

## Three feeds, three failure modes

`corridor-panel.js` awaits each separately and lets each be missing:

| Feed | Down means |
|------|-----------|
| far side (`js/farside/*`) | labelled synthetic field — chip says `demo` |
| CME train (`flux-rope-forecast.js`) | **no rope is drawn**, chip says `down` |
| regions (`/api/noaa/regions`) | no flare caption prints, chip says `down` |

A scene that renders beautifully with two dead feeds is the failure mode that
matters, so the chips are load-bearing and the gate asserts them. The provider
runs ONCE per load — the ensemble is expensive and its answer does not depend
on where the scrubber is; only geometry is re-evaluated as τ moves.

The arrival window is drawn from the issue-locked ledger as a **time
interval** at Earth (a wireframe region, not a solid body), never as
fabricated rope geometry: the ledger carries times and probabilities, not a
flux-rope fit.

## The flare base rate

`js/farside/flare-climatology.js`. It is **not** a forecast that a region will
erupt — far-side holography cannot see magnetic complexity, which is what
actually predicts flares. It is a base rate: "regions of about this apparent
size currently carry an N% daily chance of an M-class flare".

- **Rank transform, not unit conversion.** Converting a seismic footprint in
  deg² to sunspot area in μhem needs a calibration constant nobody has — the
  phase-shift footprint is much larger than the spots, by a region-dependent
  factor. So the detection's area is converted to its percentile within the
  far-side population and read off the NOAA-numbered regions' area
  distribution. The only assumption is that size ORDERING survives the two
  observing methods. It is scale-free in far-side units, which the node gate
  asserts.
- **The probabilities are SWPC's own**, per-region, as published — this
  module is not re-deriving flare physics.
- **Quote `pDaily`.** `pTransitUpperBound` compounds that rate over a whole
  disc passage and saturates: 35 %/day reaches 99.7 % over 13.6 days, which is
  arithmetically correct and would read on a page as a certainty nobody is
  entitled to. It is named to make misuse awkward, and the markers quote the
  daily figure.
- **It refuses to answer** on thin input — fewer than 4 usable NOAA regions,
  fewer than 2 far-side detections, or rows carrying no probabilities all
  return `null`, which renders as "unavailable" and never as 0 %.
- **Scale detection is per FEED, not per row.** SWPC publishes whole percents,
  so `1` means 1 % — but read in isolation it is also a legal fraction meaning
  certainty. Judging rows independently turned the quietest region on the disc
  into the most flare-prone one and inverted the entire size ordering.
- It never touches any number in the CME arrival forecast.

### The relay

`api/noaa/regions.js` relays SWPC's per-region C/M/X (and proton)
probabilities; field resolution lives in the pure `api/_lib/noaa-regions.js`
(node: `tests/noaa-regions.mjs`). Values are relayed **as published** — whole
percents — because the percent-vs-fraction call has to be made once over the
whole feed, and that decision already lives in `detectProbabilityScale`.

**The upstream key spellings could not be verified from the build
environment** (`services.swpc.noaa.gov` is blocked by the network egress
proxy). Rather than guess one name and fail silently, each field resolves from
a candidate list and the route reports what it matched:

```
curl -s https://parkersphysics.com/api/noaa/regions | jq '.data.field_map, .data.unmapped_keys, .data.probability_coverage'
```

- `field_map` — which upstream key fed each output field, or `null`.
- `unmapped_keys` — upstream keys nothing claimed. If a probability entry is
  `null` while the real name shows up here, add it to the head of
  `FIELD_CANDIDATES` and drop the candidates that never hit.
- `probability_coverage` — fraction of regions carrying both an area and an
  M-class probability. This is the number to watch; it reads 0 both when SWPC
  stops publishing and when our candidate list is wrong, and `field_map`
  separates the two.

When no probability field matches at all the route emits top-level
`freshness: 'stale'` plus a `note`, so `status.html` flags it rather than
scoring a content-free 200 as healthy — and the corridor logs the note to the
console. Until it matches, the chip reads `flare base rate · down` and no
caption prints: honest, but the feature is off.

## Tests

```
node tests/corridor-model.mjs        # frame identity, train assembly, windows
node tests/flare-climatology.mjs     # rank transform, Poisson, and the refusals
node tests/noaa-regions.mjs          # the relay, its diagnostics, and the handoff
npx playwright test tests/cme-corridor.spec.js
```

The browser gate mocks `/api/cme/skill`, `/api/donki/cme`, `/api/noaa/regions`
and `/api/solar/farside`, so it needs no live upstream. Mock DONKI in the
shape **the edge route serves** (`data.cmes`, snake_case, `earth_directed`) —
the raw NASA payload parses to zero CMEs and an idle provider, which renders
as an honest empty corridor and would make the test assert nothing.
