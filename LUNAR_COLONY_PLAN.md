# LUNAR_COLONY_PLAN.md — a lunar colony sim (and yes, a game) on moon.html

> Status: **PLANNED — Phase 0 not started.** This document is the design
> record; read it before building any phase. Companion surfaces already
> shipped: the moon.html Surface/Interior views, `js/moon-interior-model.js`
> (the interior kernel this game will reuse for quake + shielding physics),
> and the live SEP/GCR radiation model on the same page.

---

## 1. The pitch

Run a small lunar base at the south pole. Power it, water it, shield it,
grow it — while the **real Sun** decides when you have a bad day.

The differentiator (nobody else's colony game has this): the hazard events
are **live space weather**. When NOAA SWPC reports an actual S2 proton
event, *your* crew has to shelter, *your* EVAs get scrubbed, *your* dose
ledger takes the hit — with the same feeds and the same physics the rest of
parkersphysics.com already runs. The February 2022 Starlink loss is the
company's proof point that space weather kills hardware; this is the
playable version of that argument.

It is also, deliberately, an educational Trojan horse: every game mechanic
is a real engineering constraint with a citation, and the "why" panel for
each mechanic links back to the site's physics pages (radiation → this
page's dose model, quakes → the Interior view, aurora/SEP → space-weather
dashboard).

## 2. What the site already gives us (build on, don't refork)

| Asset | Where | Colony use |
|---|---|---|
| Live GCR/SEP/Kp/X-ray state | `js/swpc-feed.js` (`swpc-update` event), moon.html radiation model | Storm events, EVA gating, dose accrual |
| Dose numbers w/ refs | moon.html panel (LND/Chang'E-4, CRaTER, Schwadron) | Crew dose ledger; regolith shielding curve |
| Interior physics kernel | `js/moon-interior-model.js` + node gate | Shallow-moonquake hazard, tidal clock, regolith/crust facts |
| Landing-site data | `js/artemis-data.js` (Artemis III candidate regions, south pole) | Site-selection phase; real candidate sites are the map |
| Lunar day/night clock | moon.html `lunarPhase()` | The 29.53-day sol cycle that drives solar power + thermal |
| Solar-wind driver contract | `js/solar-wind-driver.js` | Hindcast mode: replay Gannon 2024 against your base |
| Auth + profiles + Supabase | `js/auth.js`, `user_profiles` | Saved colonies (later phase, migration-guarded) |
| Telemetry | `telemetry.recordFeature` | Funnel: which mechanics people actually play |

**Rule: the colony sim consumes existing oracles; it does not re-implement
them.** Same discipline as the flux-rope provider — one compute, many
consumers.

## 3. Design decisions (made now so sessions don't relitigate)

1. **Where it lives:** a new top-level `colony.html` (flat `*.html` at root
   per repo convention), nav'd under the Earth/Moon cluster. Phase 0 ships
   as a layer on moon.html first to validate appetite; the page comes when
   the tick engine exists.
2. **Sim architecture:** pure tick engine `js/colony-engine.js` — no DOM,
   no fetch, no ambient time; inputs are `(state, dtHours, env)` where
   `env` carries space-weather + sun-elevation numbers the PAGE gathers.
   Node-gated by `tests/colony-engine.mjs` from day one. Rendering and
   feeds stay in page-side modules.
3. **Tick cadence:** 1 real second = 1 lunar hour by default (a full lunar
   day-night ≈ 12 minutes of play), pausable, with a "live mode" toggle
   that pins sim time to wall time for the space-weather-driven events.
   Live mode is the honest mode: storms arrive when the Sun sends them.
4. **It's a game, not a spreadsheet:** failure is survivable and legible —
   you lose power before you lose crew; every death has a one-line cause
   ("EVA during S3 event: +180 mGy") so losing teaches the physics.
5. **Determinism:** the engine takes an explicit RNG seed (same pattern as
   the flux-rope ensemble). Replays and tests stay reproducible; the only
   nondeterminism in live mode is the actual Sun.
6. **No pay-gating in v1.** It's the educational/attract surface (CLAUDE.md
   §7 pivot note: consumer vs B2G surfaces — ask the author before gating
   anything). A shareable "my base survived the storm" card is the growth
   hook, not a paywall.

## 4. Core mechanics — each one is a real constraint

Every mechanic below carries its citation into the UI (the "why?" chip).

- **Power.** Solar arrays + batteries. Sun elevation from the real lunar
  clock; south-pole sites trade near-continuous illumination
  (Shackleton-rim "peaks of eternal light", ~80–90% uptime) against
  distance to ice. Earth-eclipse transits and the ~14-day night elsewhere
  are the antagonists. Later: fission surface power (NASA FSP program) as
  a tech unlock.
- **Water & oxygen (ISRU).** Ice harvesting in permanently shadowed
  regions (LCROSS ~5.6 wt% water in Cabeus); molten-regolith electrolysis
  for O₂ as an alternate chain. Closed-loop recycling with ISS-like
  efficiency (~90%+ water reclamation) — the gap is what mining must fill.
- **Radiation.** The dose ledger is the heart. Baseline GCR from the
  page's solar-cycle model (13–38 cGy/yr surface); SEP events spike dose
  for unsheltered crew/EVAs; regolith burial buys attenuation (the page's
  existing ~50 cm ≈ 50% GCR figure, with a proper attenuation curve in the
  engine). Career limits per NASA STD-3001 (600 mSv effective) end a
  crewmember's surface eligibility — a roster-management mechanic, not a
  death screen.
- **Storm shelter.** A buried module with capacity N. SEP onset → shelter
  decision → productivity stops while sheltered. The tension between
  "wait it out" and "the ice harvester is offline" is the game.
- **Moonquakes.** Shallow quakes (kernel: 28 recorded 1969–77, up to
  m~5.5, minutes-long shaking) as rare structural-damage events; deep
  quakes tick harmlessly on the kernel's tidal clock as ambience/foreshock
  flavor. Structures have a quake rating; rigid pressurized modules care,
  regolith berms don't.
- **Thermal.** Day/night swing (~+120 °C to −170 °C; ~40 K in PSRs)
  as a power draw (heaters/radiators) that scales with habitat exposure —
  burial helps radiation AND thermal, teaching why real designs bury.
- **Micrometeorites + dust.** Slow abrasion tax on exposed equipment;
  dust mitigation as a maintenance loop (Apollo's #1 surprise complaint).
- **Crew.** Small roster (4–12), each with dose history, morale, and a
  specialty. EVAs are the universal verb: build, repair, mine — all EVAs,
  all dose- and storm-gated. The GO/NO-GO framing mirrors the EarthView
  verdict card on purpose.

## 5. The live-weather event pipeline

```
swpc-feed (existing) ──swpc-update──▶ page adapter ──env──▶ colony-engine tick
                                          │
        flux-rope-forecast (existing) ────┘   (arrival windows → "storm inbound"
                                               warnings hours ahead — the same
                                               provider the dashboard uses)
```

- S-scale proton events → shelter events (severity = S level).
- X-class flares → radio blackout: comms/nav side effects (mild).
- CME arrival forecasts → advance warning UI ("estimated arrival 18:00 UTC
  ±7 h") — playing the uncertainty window IS the lesson.
- Quiet Sun → the game is a logistics puzzle; storms are punctuation.
  Hindcast mode replays Gannon May-2024 or the St. Patrick's storm through
  the same `SolarWindDriver` contract for guaranteed drama (and testing).

## 6. Phases

**Phase 0 — Site Survey (moon.html layer, small).**
South-pole site picker on the existing globe: for each Artemis III
candidate region show illumination %, ice proximity class, quake exposure,
comms line-of-sight to Earth. Pick a site → stored in localStorage → seeds
Phase 1. Ships with `tests/colony-sites.mjs` for the site-scoring table.

**Phase 1 — The tick engine + one screen (the real MVP).**
`js/colony-engine.js` (state, resources, crew, dose ledger, build queue,
seeded RNG) + `colony.html` with a 2-D schematic base view (SVG/canvas,
no three.js needed yet), resource bars, event log. Live SEP gating wired.
Win condition: survive 3 lunar days; score = crew-sols × dose margin.
Gates: `tests/colony-engine.mjs` (conservation laws: mass/power/water
balance closed each tick; dose monotone; determinism under fixed seed) +
a Playwright smoke.

**Phase 2 — Depth.** Tech tree (FSP reactor, mass driver, greenhouse),
crew specialties/morale, moonquake damage model from the kernel, thermal
sim, hindcast storm scenarios, shareable outcome card.

**Phase 3 — Persistence + presence.** Supabase saves (own migration,
guarded like `supabase-dashboards-migration.sql`), leaderboard on storm
scenarios (same seed + same storm = comparable scores), maybe async
"visit a friend's base."

**Phase 4 — The 3-D dream (only if the game earns it).** First-person or
orbital 3-D base view reusing the moon.html renderer stack. Explicitly
deferred: pretty comes after playable.

## 7. Guardrails

- Engine purity is non-negotiable: if a number appears in the UI and is
  not traceable to `colony-engine.js` or an existing site oracle, it's a
  bug (same rule as the Interior view).
- Real physics, disclosed simplifications: every rate constant in the
  engine gets a source comment (LCROSS, NASA STD-3001, Apollo ALSEP …) or
  an explicit `// GAMEPLAY:` tag when a value is tuned for fun. Never
  blur which is which.
- Live feeds must look live and down must look down (the flux-rope DEMO
  badge rule) — if swpc-feed is stale, the game says "feed stale, storm
  events paused", it does not quietly go quiet-Sun.
- Don't touch the radiation lab's science panels in service of the game;
  colony UI is additive, moon.html keeps its instrument character.
- New SECURITY DEFINER functions (Phase 3) follow CLAUDE.md §8's
  migration pattern; nothing anonymous-writable beyond the telemetry
  surface that already exists.

## 8. Open questions for the author

1. Tone: hard-hat NASA realism, or a little warmth/whimsy in crew events?
   (Design assumes "realism with heart" — Oregon Trail, not dwarf
   fortress.)
2. Should Phase 0 ship inside moon.html's Interior/Surface toggle as a
   third "Colony" mode, or as its own panel section? (Assumed: third
   toggle state, it's cheap and discoverable.)
3. Is a public leaderboard worth the moderation surface, or do we keep
   scores share-card-only until there's demand?

---

*Created 2026-07-30. Update this file as phases land — status line at top,
decisions in §3, so the next session doesn't re-decide.*
