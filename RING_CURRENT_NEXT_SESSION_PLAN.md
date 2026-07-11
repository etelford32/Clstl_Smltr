# Ring Current — next session plan (2026-07-11)

## Live bug (P0): particles invisible after PR #916
Buffers animate (verified via position-delta probe) but nothing renders.
Prime suspect: the custom glow ShaderMaterial in js/ring-current-globe.js
(`glowPointsMaterial`) — a GLSL compile failure draws nothing while CPU
motion continues. All four point systems use it (ions, electrons, transit,
envelope), which matches "no particles anywhere". User may have rolled
production back to the pre-#916 deployment (visible but frozen).

## Fix sequence
1. **Pixel probe first**: extend scratchpad storm-probe to screenshot the
   corridor + ring regions and COUNT LIT PIXELS; hook
   `renderer.debug.onShaderError` and dump the GLSL log. "Renders" must be
   measured, never assumed.
2. **Isolate**: A/B glowPointsMaterial vs stock PointsMaterial in the probe.
   Suspect: `vertexColors`/USE_COLOR define interplay in three r160 —
   the shader reads `color` attribute declared only under defines.
3. **Fix low-risk**: replace hand-written GLSL with PointsMaterial + a
   procedural radial-gradient CanvasTexture sprite (`map` + alphaTest 0 +
   additive) — identical glow look, zero compile risk. Keep the fresnel
   atmosphere only if its compile log is clean (built-in attributes only).
4. **Permanent gate**: add tests/ring-current-render-smoke.spec.js
   (Playwright): boots page with mocked feeds, asserts (a) lit pixels in
   corridor+ring regions, (b) buffer positions change over 2 s, (c) zero
   pageerrors. This becomes the CI check that prevents blank/frozen scenes.
5. **Ship + verify on the artifact**: PR, then verify on the Vercel preview
   URL itself (get_access_to_vercel_url share link) BEFORE telling the user
   to promote. Never verify only against local mocks again.

## Context you'll need
- Branch: claude/ring-current-simulation-earth-12ry38 (restart from
  origin/main; PRs #909–#916 all merged — see git log).
- Deploys: git pushes build PREVIEWS only; production moves ONLY via manual
  "Promote to Production" (Vercel project clstl-smltr, team
  elliot-telfords-projects). Preview URLs are immutable snapshots.
- Sandbox blocks NOAA + vercel.app; use Playwright with mocked routes
  (scratchpad/storm-probe.mjs pattern) and Supabase MCP http_get for live
  NOAA checks.
- Full stack docs: RING_CURRENT_SIMULATION_PLAN.md,
  RING_CURRENT_USER_RESEARCH.md. Tests: tests/ring-current-*.mjs (28 groups)
  + tests/refresh-solar-wind-helpers.mjs.

## Backlog after P0 (user-approved directions)
- Verify production pipeline post-promote: solar_wind_samples bz_nt fresh,
  geomag_indices + ring_current_log filling (Supabase aijsboodkivnhzfstvdq).
- Skill page from ring_current_log ⊗ geomag_indices ledger.
- TraCSS white paper angle (see research doc §2 leads).
