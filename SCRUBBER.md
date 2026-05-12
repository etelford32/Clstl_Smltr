# Time Scrubber & Replay Infrastructure

Reference doc for the upper-atmosphere scrubber/replay subsystem
(Phases A–F). Written while the work was fresh so a future maintainer
(or a future me) can re-load context fast.

---

## Why this exists

Before Phase A the page had **two parallel sim-clocks** that nobody
owned:

1. The realtime driver (`upper-atmosphere-realtime-driver.js`) kept its
   own `simTimeMs` for the density model + HUD readouts.
2. The globe (`upper-atmosphere-globe.js`) propagated each satellite
   off `THREE.Clock.getElapsedTime() × rate + _phase0`.

These drifted apart silently under any rate ≠ 1, and there was no
single source of truth to scrub against. Operators asked for two
things:

- **Drag-to-set a specific UTC time** (vs. the existing rate presets).
- **Negative rates / replay** for post-conjunction forensics ("where
  was Starlink-1832 30 minutes ago?").

Both required a shared clock. That's what the TimeBus is.

---

## Architecture at a glance

```
                        ┌────────────────────────────┐
                        │   TimeBus  (singleton)     │
                        │   simTimeMs, rate, mode    │◀── pull-based step()
                        │   bounds: -30d .. +1h      │
                        └──┬─────────────────────┬───┘
                onTick/onJump│                  │ setSimTime/setRate/pause
                            ▼                  │
              ┌─────────────────────┐          │
              │ Globe sat propag.   │          │
              │ M = M_epoch +       │          │
              │   n×(t − epochMs)   │          │
              └─────────────────────┘          │
              ┌─────────────────────┐          │
              │ Realtime driver     │          │
              │ (drains bus →       │          │
              │  density + readouts)│          │
              └─────────────────────┘          │
              ┌─────────────────────┐          │
              │ Analyzer family     │          │
              │ (forecast / MC /    │          │
              │  conjunction / etc) │          │
              └─────────────────────┘          │
                                               │
              ┌────────────────────────────────┴───┐
              │  Operator UI surfaces              │
              │  • Warp HUD (rate chips ±)         │ ← Phase 26 + Phase F
              │  • Time scrubber widget            │ ← Phase E
              └────────────────────────────────────┘
```

The bus is the only shared mutable. Everything else either *advances*
it (the driver, in live mode) or *reads* it (every consumer).

---

## Phase-by-phase

| Phase | Commit  | What it did                                                     |
|-------|---------|-----------------------------------------------------------------|
| A     | 8ba57f5 | `TimeBus` singleton — signed rate, bounds, onTick/onJump        |
| B     | 198e181 | Globe sat propagation switched to absolute `M = M_epoch + n·Δt` |
| C     | 60bb73a | Realtime driver drains its sim-clock into the bus               |
| D     | adb59d3 | Analyzer family cascade — forecast/MC read bus simTime          |
| E     | 8ea7891 | Operator-facing scrubber widget                                 |
| F     | this    | Negative-rate (replay) chips in the warp HUD                    |

Phases B/C/D were "drain the parallel clock" — the bus existed but
nothing consumed it until they did. Phases E/F are the operator UI on
top of that foundation.

---

## TimeBus contract

Module: `js/upper-atmosphere-time-bus.js`.

```js
const bus = getTimeBus();

// State
bus.getSimTime()   // ms since epoch
bus.getRate()      // signed; 0 = paused, 1 = live, -10 = replay
bus.getMode()      // 'live' | 'paused' | 'warp' | 'replay'
bus.getBounds()    // { pastMs, nowMs, futureMs }

// Mutation
bus.setSimTime(ms)   // jump → emits onJump
bus.setRate(r)       // signed; sets mode automatically
bus.pause()          // rate=0, mode='paused', remembers prior rate
bus.resume()         // restore prior rate
bus.snapToNow()      // simTime=wall-now, rate=1

// Per-frame
bus.step()           // host calls this in RAF; advances simTime by
                     // dt × rate and emits onTick

// Subscriptions
const off = bus.onTick(t => {…});  // 60+ Hz, dedupe'd by clock skew
const off = bus.onJump(t => {…});  // explicit set / snap
```

### Key invariants

1. **Pull-based advance.** Nothing advances simTime except `step()`. So
   a hidden tab doesn't accumulate drift, and a host can deliberately
   pause the world by not calling step.
2. **Edge clamp.** `simTime` is clamped to `[pastMs, futureMs]`. When
   it hits an edge with non-zero rate, the bus auto-zeros the rate to
   prevent wedging the consumer in an "outside-of-range" state.
3. **Signed rate.** Forward (>0) advances live time; reverse (<0)
   advances replay. Mode is **`'replay'`** for rate<0, but the bus
   projects it to `'warp'` on the legacy event channel so old
   consumers (pre-Phase-D) don't see an unfamiliar mode string.
4. **Bounds are live.** `pastMs`/`futureMs` are computed against
   wall-clock now on each `getBounds()` call, so they slide forward
   naturally. Ticks can drift in/out of range as a result.

---

## Globe propagation (Phase B)

`upper-atmosphere-globe.js` per-satellite hot path:

```js
const tBus  = this._timeBus.getSimTime();
const dtSec = (tBus - sat.epochMs) / 1000;
const M     = sat.M_epoch + sat.meanMotion * dtSec;
…
```

The old `_phase0 + clock.getElapsedTime() × rate` is gone. The bus
*is* the rate now — the globe just reads the absolute simTime and
recomputes mean anomaly per frame. This is what makes scrubbing work:
set bus.simTime = T, every sat snaps to its position at T.

---

## Realtime driver drain (Phase C)

`upper-atmosphere-realtime-driver.js` used to own `_simTimeMs` and
emit a "sim-tick" DOM event at 10 Hz. After Phase C:

- The driver subscribes to `bus.onJump` for immediate scrub feedback.
- The driver still RAFs but its per-frame work is delegated to
  `bus.step()` → the driver reads back `bus.getSimTime()` instead of
  computing its own.
- The 10 Hz DOM-event emit timer is preserved for legacy consumers
  (density readouts, status pills).

There's a subtle ordering bug worth remembering: in `driver.stop()`
the bus unsubscribe must happen **before** the `if (!_running) return`
guard, because stop()-without-start() still needs to drop the sub.
Don't move that line.

---

## Scrubber widget (Phase E)

Module: `js/upper-atmosphere-time-scrubber.js` (~250 lines).

### Mounting

```js
import { TimeScrubber } from './upper-atmosphere-time-scrubber.js';
const scrubber = new TimeScrubber(hostEl, /* opts */);
// later
scrubber.destroy();
```

The widget is purely a controller. It owns no sim state — everything
flows through the bus. Multiple instances can coexist (each
subscribes, each reflects the same value).

### Drag semantics

- **Pointer-down** on the handle: `bus.pause()` (remembers prior rate
  internally on the bus).
- **Pointer-move**: pixel→ms mapping via `bus.getBounds()`, then
  `bus.setSimTime(ms)`. The widget *skips* re-rendering during drag
  (sets a `_dragging` flag so onTick/onJump callbacks no-op the DOM
  update — the handle is already where the pointer is).
- **Pointer-up**:
  - if `|simTime − bounds.nowMs| < 30_000` → `bus.resume()` and snap
    to live (operator intends "back to live").
  - else → stay paused (operator is examining a moment).

### Pixel → time mapping

The widget calls `bus.getBounds()` *every frame*, not once at mount.
Bounds slide as wall-clock advances, so a "tick at -30d" represents
a different absolute timestamp every second. The track is laid out
on `[pastMs, futureMs]` with a linear scale.

### Why bus.getBounds().nowMs instead of Date.now()

The widget uses `bus.getBounds().nowMs` everywhere it would otherwise
call `Date.now()`. This is so tests (and future replay modes that
inject a different "now") get a consistent answer.

### Tick marks

`TICKS` constant in the module: `-30d, -7d, -24h, -1h, now, +1h`.
Labels are static; positions are recomputed against current bounds.
Each tick is just a CSS-positioned `<span>` — no canvas, no SVG.

### Mode pill (visual)

The "LIVE / PAUSED / WARP / REPLAY" chip reads `bus.getMode()` and
maps to design-token colours:

| Mode    | Token                                |
|---------|--------------------------------------|
| live    | `--ua-cyan` / `--ua-cyan-mid`        |
| paused  | `--ua-amber` / `--ua-amber-low`      |
| warp    | `--ua-amber` / `--ua-amber-low`      |
| replay  | `--ua-red` / `--ua-red-low`          |

Replay is the only mode that uses red, deliberately — operators
should *know* they're looking at history, not live.

---

## Warp HUD rate chips (Phase 26 + F)

Lives inline in `upper-atmosphere.html` under
`.ua-cam-controls--warp`. Pure HTML buttons with `data-rate="<n>"`;
event delegation in `upper-atmosphere-ui.js` line ~187 calls
`globe.setSatTimeScale(rate)` → which forwards to `bus.setRate(rate)`.

### Row layout

```
◂600× ◂60× ◂10×  ×  ½ 1× 10× 60× 600× 3600×  ⏯  ⟳ Now
└─── replay ──┘     └──── forward ─────┘   pause snap
```

Negative rates read leftward (replay), forward rates read rightward,
with the `×` label as the origin. Reverse chips use red tokens to
match the scrubber's REPLAY pill — visual symmetry across surfaces.

### Adding more rates

Two steps and nothing else:
1. Add a `<button class="ua-cam-warp-rate [--rev]" data-rate="…">`
   in the panel.
2. Done. The event-delegation handler does `parseFloat(dataset.rate)`
   and forwards to the bus; the `setActiveRate(rate)` highlighter
   already matches by numeric equality.

---

## Extending the subsystem

Some natural follow-ups (not in scope for Phases A–F):

- **History ring buffer.** Right now replay re-computes positions
  from TLE epoch backward, which is fine for sat propagation but
  doesn't capture *observed* state (density model outputs, anomaly
  flags). A ring buffer keyed on simTimeMs could let the scrubber
  replay what the operator *saw*, not what the model recomputes.
- **Per-asset trail rendering at replay time.** When `rate<0`, draw
  a translucent trail of where each sat was, fading toward the
  current handle position. Useful for conjunction forensics.
- **Bookmarks.** Operator clicks "save this moment" → scrubber gets
  a tick mark at that simTime. Mostly UI work; the bus already
  supports arbitrary jumps.
- **Time-of-interest broadcasts.** When the anomaly detector fires,
  push a tick mark at the trigger time so the operator can scrub
  to it with one click.

---

## Tests

`test/upper-atmosphere-time-bus.test.js` (~19 cases) covers the bus
contract including edge-clamp behaviour and the stop-without-start
unsub bug. Scrubber widget tests run against a JSDOM mount and stub
`bus.getBounds()` to inject a fake wall-clock.

When adding a new consumer to the bus, the bar is:
- Subscribe in init, unsubscribe in destroy.
- Read `bus.getSimTime()` per frame (or per recompute), don't cache.
- If you also want jump-driven recompute, subscribe to `onJump` too.
