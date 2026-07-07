# Observatory 3D Upgrade — Progress Log

Assume each session starts cold: read `ARCHITECTURE_BASELINE.md` first,
then this file bottom-up. Branch: `claude/observatory-3d-upgrade-lyx385`.

---

## Session 1 — 2026-07-07 (Phase 0 + Phase 1 camera + Phase 2 HDR)

### Done, with acceptance status

**Phase 0 — complete.**
- `ARCHITECTURE_BASELINE.md` written; star position path WASM→pixel
  documented. Baseline screenshot in `baseline-2026-07-07.png`.
- Headline recon results: the page was **already 3D** (Phase 1 task 2 was
  already satisfied — oriented orbital planes, 3D PN, floating origin), and
  the Kerr geodesic ray tracer for Phase 3 is **in-repo at `js/ton618/`**
  (BL-coordinate RK45 Kerr tracer + disk + bloom/ACES chain).

**Instrumentation — complete.** `?hud=1` frame-time HUD
(`js/abell85/perfhud.js`), `?renderer=3d` flag (`js/abell85/flags.js`).

**Phase 1 (camera) — tasks 1–3 done in adapted form.**
- Task 1: orbit-drag release inertia (opt-in `onDragStart/onDragEnd`
  protocol in `camera.js` — abell85/cinema/twin pages unaffected); per-lane
  **focus** buttons (smooth dolly to binary-separation ×7, or horizon ×30
  post-merger); idle-drift and follow/chase already existed.
- Task 2: nothing to do — physics and render were already 3D.
- Task 3: depth policy documented in baseline §5 (no-depth is correct for
  the all-additive scene; near-field occlusion will live inside the Phase 3
  geodesic march). No log-depth needed yet.
- NOT done from Phase 1: task 4 (depth-separated lane volumes — needs a
  product decision, the stacked-at-origin composite is a deliberate design)
  and task 5 (trail ribbons — trails are still GL line strips).

**Phase 2 (HDR star pipeline) — tasks 1–4 done, behind `?renderer=3d`.**
- RGBA16F scene (EXT_color_buffer_float gate, silent classic fallback),
  per-star blackbody color/luminosity via gl_VertexID hash + 256×1
  Tanner-Helland LUT (fake-IMF: cool dwarfs, ~10% giants, hot tail),
  Karis bright-pass (clamped at 2.5) + 2-octave separable bloom at half
  res, ACES+sRGB folded into the lens composite (bloom sampled through the
  same lens warp). Doppler beaming δ⁴ + color shift from live velocities —
  the worker protocol now ping-pongs `vel` as a third transferable.
- Draw calls: one star draw per lane (3), not one total — the per-lane
  tint/buffer architecture makes a single merged draw a bigger refactor
  than it is worth right now.
- Task 5 (screenshot harness): `scratchpad` Playwright scripts used in-
  session (SwiftShader). Not yet committed as a repo test — candidate for
  next session (`tests/observatory-render-smoke.mjs`).
- Acceptance "fast stars visibly beam/blueshift": the math is in (δ from
  live velocities, LUT re-lookup at shifted T); *visual* confirmation at
  endgame zoom still owed — check when validating on real GPU.

### Verification record
- `tests/abell85-physics.mjs`: **all 22 checks pass** after the protocol
  change (incl. WASM/JS kernel parity).
- Classic path (`no flag`): screenshot-compared against Phase 0 baseline —
  identical apart from the new focus buttons.
- HDR path: booted clean headless (no console errors), verified at cluster
  scale and influence scale. SwiftShader relative cost: classic ~283 ms,
  HDR ~350–400 ms median (software rasterization; meaningless in absolute
  terms, fine as a regression reference).
- Elliot's visual sign-off on the HDR look: **pending** (plan requires it
  before Phase 3 starts).

### Tuning knobs (renderer instance)
`exposureStops` (2.0), `bloomStrength` (0.35), bright-pass threshold 1.0 /
knee 0.6 / clamp 2.5, IMF luminosity scale 0.18 in `VS_POINTS_HDR`.

### Exact resume state for Session 2
1. Get visual sign-off on `?renderer=3d`; tune knobs above if asked.
2. Remaining Phase 1: trail ribbons (task 5); ask Elliot about
   depth-separated lane volumes (task 4) before building.
3. Phase 2 leftover: commit a screenshot-harness smoke test.
4. Then Phase 3 prototype: port `js/ton618/` Schwarzschild tracer to a
   standalone page/harness per plan (do NOT integrate before it validates
   against the Einstein-ring/photon-ring references). Binary case: switch
   to superposed Kerr-Schild (ton618 is single-hole BL — see baseline §2).
