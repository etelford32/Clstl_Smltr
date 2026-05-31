# Gannon Sun→Earth scene — cinematic upgrade (design note)

**Status:** IMPLEMENTED (2026-05-31). All features below shipped at "subtle" intensity,
plus the detailed magnetosphere boundaries and atmospheric differentiation the user
requested. The pre-existing bow shock was also re-oriented: its dayside nose now faces
the Sun (−x) instead of anti-sunward — the CME front from the left strikes the nose, which
is physically correct. Verified headless: 529 `setCursor` steps across the full scrub
range with no exceptions and no non-finite attributes; driver-bound visuals confirmed to
track `bz_nt`/`v_kms`/`hpi_gw`/`density_400km` (browser screenshot blocked by the network
policy, so frames were serialized to standalone SVG instead).
**Scope:** enhance the *existing* `js/gannon-superstorm-sun-earth.js` panel in place. No new panels, no new page sections, no framework, no new runtime dependency. SVG only, same primitives already in the file.

---

## 1. What exists today (baseline)

`createSunEarthScene(container, replay, player, opts)` renders an inline-SVG side view (viewBox 800×280):

- Sun (glow + disk + AR 13664 pip) at left, Earth (disk + atmosphere + bowshock) at right, L1 dashed reference, a 0→1 AU distance axis.
- 14 faint static Parker-spiral streaks.
- 5 Gannon CMEs as glyphs (glow + body + short trail), positioned every `setCursor(h)` from real drag-based-model transit (`dbmAnalytical`). Queued CMEs park at the sun limb; in-transit traverse the gap; arrived/past fade.
- Bowshock compresses (`computeCompression`) when a CME is near Earth.
- Top-right clock + CME status ("2 queued · 1 in transit"), top-left title, PLACEHOLDER watermark when synthetic.
- Driven by the shared scrubber (`onScrub` → `sunEarth.setCursor(h)`) and the 60× play loop.

**Already-available per-sample channels** (from `player.sample().drivers`, real once OMNI/DONKI lift): `bz_nt`, `v_kms`, `phi_pc_kv` (polar-cap potential), `hpi_gw` (hemispheric power), `sme_nt`, plus the three Ap tracks. **The scene currently ignores all of these** — it only uses CME geometry. That's the opportunity: the storm's *intensity* is in the bundle but not yet visualized.

---

## 2. Goal

Make the panel read cinematically as a storm — the IMF turning south, the solar wind accelerating, the field slamming and compressing the magnetosphere, the aurora lighting up — **without inventing any data**. Every visual amplitude maps to a real (or real-once-lifted) channel already in the replay bundle. Keep it legible at a glance for an operator, and keep it honest (placeholder watermark stays).

---

## 3. Proposed enhancements (all scrubber-synced, all data-bound)

The scene factory will read the current sample inside `setCursor(h)` via `player.seekHours(h)` (cheap; pure array index) so each visual tracks the live driver values. Six additions, in rough priority order:

### 3.1 IMF Bz "river" between Sun and L1 — *the southward turn*
Replace the 14 static Parker streaks with a flowing band of short dashes along the track whose **color encodes Bz polarity** and **flow speed encodes `v_kms`**.
- Bz ≥ 0 → cool blue-grey (quiet, northward IMF, weak coupling).
- Bz < 0 → warm orange→red ramping with |Bz| (southward = geoeffective; this is *the* coupling switch).
- Dash phase advances each animation frame proportional to `v_kms` (350 km/s ambient → ~800+ km/s storm), so the wind visibly speeds up at shock arrival.
- This is the single biggest cinematic win: the operator *sees* the field turn south right as the CMEs hit and the storm fires.

### 3.2 Shock-front arc on CME impact
When a CME crosses `state: "arrived"`, draw a brief expanding arc (a compression front) sweeping from the impact point into the magnetosphere, fading over ~1–2 storm-hours of cursor travel. Purely geometric, triggered off the existing `cmeStateAt` state transition. Sells the "slam."

### 3.3 Magnetosphere — keep compression, add a Bz-driven term
Today compression is CME-proximity only. Add a contribution from **dynamic pressure proxy** (`v_kms` ↑) and **southward Bz** so the bowshock stays compressed through the main phase, not just at the instant of impact. Clamp to the existing [0.5, 1.0] range so the path math is unchanged.

### 3.4 Auroral glow on Earth — *Joule heating made visible*
Add an auroral oval arc on Earth's poleward limb whose **brightness and equatorward extent scale with `hpi_gw`** (hemispheric power) and `phi_pc_kv`. This is the physical bridge to the operator story: aurora brightness ∝ Joule heating ∝ thermospheric expansion ∝ drag. Subtle green→magenta gradient, capped so it never overwhelms the schematic.

### 3.5 Active-region flare flash at CME launch
When the cursor crosses a CME's `launch_h`, briefly flash the AR 13664 pip (bright X-class-colored pulse) so launches read as discrete events, not glyphs quietly appearing. Color/size from the existing `flareIntensity` / `cmeColor` helpers.

### 3.6 A compact driver strip inside the scene (optional, low risk)
Two tiny live readouts under the existing clock: `Bz −XX nT` (red when southward) and `V XXX km/s`. The KPI rail already shows these, so this is optional polish — it keeps eyes on the scene during playback. Will gate behind a single boolean so it's trivial to drop.

---

## 4. Data contract / honesty

- **No fabricated numbers.** Every amplitude is a function of `bz_nt`, `v_kms`, `phi_pc_kv`, or `hpi_gw` already in the bundle, or of CME geometry already computed. While the bundle is placeholder, these are synthetic-but-plausible and the PLACEHOLDER watermark stays; once the OMNI/DONKI/runbook lifts land, the same visuals are driven by real data with zero code change.
- **Provenance unaffected.** No change to the pill logic or `_is_placeholder` handling.
- Color semantics reuse the page palette (`#f96` storm orange, `#6cf` cool, `#fc6` warn) — consistent with `DESIGN_TOKENS.md` and the existing `COLORS` map.

---

## 5. Implementation shape

- **One file touched for logic:** `js/gannon-superstorm-sun-earth.js`. Bump the import query (`?v=2` → `?v=3`) in `gannon-superstorm.html` (one line) so the new module busts cache. *(Cache-bump is the only HTML change.)*
- `setCursor(h)` gains: read sample → recolor/advance the Bz river, update aurora arc, fold Bz/V into compression, handle shock-front + flare-flash transitions. All additive; existing CME loop untouched.
- New pure helpers (top of file, next to `flareIntensity`): `bzColor(bz)`, `windDashGap(v)`, `auroraIntensity(hpi, phi)`, `shockArcPath(...)`. Each ≤ ~10 lines.
- Animation: the river dash-phase and any fades advance off the existing 60× `tick` loop (no new RAF; `setCursor` is already called every frame during play). For static scrubbing they settle to the value at `h`.
- **Reduced-motion:** respect `prefers-reduced-motion` — if set, freeze dash animation and shock arcs to their static per-`h` state (the data mapping still shows, just no motion).

## 6. Risk / reversion guardrails (per CLAUDE.md §4–5)

- No framework, no bundler, flat file — compliant.
- Pure addition to one ES module + a 1-char cache bump; `git diff origin/main` will be a single module's growth, easy to review.
- No nav change → `lint-nav.mjs` gate untouched.
- No data/schema change → engine `SUPPORTED_SCHEMA` and bundle untouched.
- Verification: load `node dev-server.mjs`, scrub h=−60→+72, confirm (a) Bz river reddens at the southward turn, (b) shock arc fires on each arrival, (c) aurora brightens at HPI peak (~h=14), (d) placeholder watermark still shows, (e) no console errors. Screenshot before/after.

## 7. Out of scope (explicitly not doing this pass)

- Thermosphere puff-up panel, density heatmap, real telescope imagery (these were the other options; deferred).
- Any new page section or KPI.
- Touching the charts, narration, engine, or API modules.
