# parkersphysics.com

> **This repo is parkersphysics.com** — a physics-first space weather forecasting platform for satellite operators, government, and research users. The project began life as a celestial simulator (the repo was previously named `Clstl_Smltr`) and outgrew those origins. **Do not assume this is a small pygame demo — it is a ~100k-line production web application.**

Live site: [parkersphysics.com](https://parkersphysics.com)

---

## What this actually is

A static-HTML + Vercel-serverless web app that delivers MHD-grounded space weather forecasts. The wedge is physics-first modeling (SWMF / BATS-R-US lineage) vs. the ML-black-box approach common in the category, with LEO drag forecasting as the lead use case.

**Stack:**
- **Frontend:** Vanilla HTML / JS / CSS. ~55 top-level HTML pages, no framework. JS modules under `js/`.
- **Backend:** Vercel serverless functions under `api/` (Node). Cron jobs in `vercel.json`.
- **Database / Auth:** Supabase (Postgres 17, email+password + Google OAuth, JWT in localStorage with a `pp_auth` legacy mirror). See `AUTH_FLOW_REVIEW.md`.
- **Heavy compute:** Rust + WebAssembly. Crates under `crates/`, `rust-*/`, built via `build-wasm.sh`. SGP4 propagation, stellar MHD, sunfield, sirius solver.
- **Data sources:** NOAA SWPC, NASA DONKI/HEK, CelesTrak, NWS, plus the Gannon May-2024 G5 hindcast and INTERMAGNET (Step-1 GSA pipeline, validation-only).
- **Payments:** Stripe (under `api/stripe/`).

**Deployed via:** Vercel. Cron schedules and build command live in `vercel.json`. The `build-wasm.sh` script compiles the Rust crates to wasm at deploy time.

---

## Read these before editing anything

Heavy `.md` documentation lives at the repo root — these are load-bearing context, not boilerplate.

| File | What it covers |
|------|----------------|
| `AUTH_FLOW_REVIEW.md` | **Read first if touching auth.** Full inventory of signin/signup/OAuth/callback, what's shipped vs. gaps, the `auth_failures` telemetry surface. |
| `OAUTH_SETUP.md` | Google OAuth operator runbook (Apple is staged behind a flag). |
| `MAGIC_LINK_SETUP.md` | Passwordless flow. |
| `OPERATIONS_STATUS.md` | What pipelines are live, what's degraded. |
| `DEPLOYMENT.md`, `WEB_DEPLOYMENT.md`, `VERCEL_SETUP.md` | Deploy procedure. |
| `MHD_DENSITY_PRODUCT_PLAN.md`, `MHD_DENSITY_PHASE0_RUNBOOK.md`, `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md` | LEO drag / MHD density product spec and runbooks. |
| `GANNON_SIMULATION_DESIGN.md` | Gannon May-2024 G5 hindcast page + pipeline. |
| `WEATHER_FORECAST_PLAN.md`, `WEATHER_PREDICTIVE_ANALYTICS_PLAN.md` | Forecast surface roadmap. |
| `EARTH_LOD_NASA_PRECIP_PLAN.md`, `EARTH_ML_FIRST_PRINCIPLES.md` | Earth viz LOD + ML approach. |
| `ANALYTICS.md`, `TIER_EXPANSION_SPRINT.md`, `SCRUBBER.md` | Analytics, plan tiers, scrub-bar component. |
| `DESIGN_TOKENS.md` | Design system. |
| `SECURITY.md` | Disclosure policy. |
| `SMOKE_TEST_EDUCATOR.md` | Manual smoke test for educator-tier flows. |

---

## Notes for AI coding agents

If you are an AI agent (Claude Code, Copilot, Cursor, etc.) starting work in this repo, **read these first** to avoid the documented reversion pattern in this repo's history:

1. **This is not a celestial simulator.** Ignore any pygame/OpenGL references in legacy files (`star_simulation.py`, `celestial_studio.py`, `main.py`, `simple_star_test.py`, `test_display.py`, the `rust/` toy crate). They are origin artifacts and not deployed. The deployed product is the HTML + `api/` + `js/` + WASM-emitting Rust crates surface.
2. **Inline comments in `js/auth.js` are load-bearing.** They document past bugs (admin demotion on token refresh, dashboard auth gate stuck on RLS errors, signin_failed event drops). Do not "clean up" or remove them.
3. **Some things that look like bugs are intentional:**
    - `SECURITY DEFINER` functions exposed to the `anon` Postgres role — needed for telemetry RPCs called before sign-in.
    - Permissive RLS (`WITH CHECK (true)`) on `analytics_events`, `user_sessions`, `feedback`, `beta_invite_uses` — required for anonymous instrumentation.
    - `_persistToStorage()` called *before* `fetchProfile()` in auth init — prevents the dashboard auth gate from dead-ending on transient RLS errors.
4. **Before opening a PR, search recent commits for the same title.** This repo has empty/duplicate PRs in its history (e.g. PRs #762, #763, #765, #766 all titled "3d satellite orbit" — only one had code). If you intended to ship a change and `git diff` shows nothing, your change was already merged. Do not re-open the PR.
5. **The Supabase project is `aijsboodkivnhzfstvdq` (Parkers Physics, us-east-1).** RLS is enabled on every public table but three (`forecast_log`, `solar_wind_samples`, `weather_grid_cache`) have RLS enabled without policies — these are service-role-only by design.
6. **Do not introduce a framework.** No Next.js, no React, no build step beyond `build-wasm.sh`. The whole point of the static-HTML architecture is fast cold starts and Vercel-edge cacheability.

---

## Repo layout

```
api/                Vercel serverless functions (Node). One subdir per data source / capability.
  auth/             Auth-failure logging, magic-link helpers.
  cron/             Scheduled refresh / digest / prewarm jobs (see vercel.json `crons`).
  stripe/           Webhooks + checkout sessions.
  noaa/  donki/  hek/  celestrak/  nws/  ...   External data integrations.
js/                 Client modules (~100 files). Loaded directly by HTML pages, no bundler.
  auth.js           Supabase auth wrapper. Single source of truth for session + plan + role.
  config.js         SOCIAL_PROVIDERS flag and runtime config.
  telemetry.js      Fire-and-forget error/web-vitals/auth-funnel capture.
crates/             Rust libraries compiled to WASM (stellar-mhd-2d, disc-hydro).
rust-sgp4/  rust-sirius/  rust-sstar/  rust-sunfield/  rust-forecast/   Per-page WASM modules.
swmf/  dsmc/        Physics pipelines (Python). swmf/ wraps SWMF; dsmc/ wraps SPARTA.
satellite-operator/ Operator-facing dashboard surface (early).
pi/                 Edge / Pi deployment config.
data/               Hindcast + heliochronicles data.
scripts/            Training, heliochronicles generators.
tests/              Smoke tests (Playwright-style and Node).
*.html              Page surface. dashboard.html, signin.html, signup.html, admin.html, sun.html,
                    earth.html, satellite-designer.html, account.html, etc.
```

---

## Local development

```bash
# Install Node deps (for api/ functions and tests)
npm install

# Run locally with Vercel
vercel dev

# Build WASM (required before deploy; usually run by Vercel)
bash build-wasm.sh

# Run smoke tests
node tests/weather-forecast-smoke.mjs
```

You'll need Supabase env vars in `.env.local` — see `VERCEL_SETUP.md`.

---

## Historical origin

This repo started as a pygame/OpenGL star simulation (hence the name and the pygame files still in the tree). Those files remain for archaeological reasons but are not part of the deployed product. If you're looking for the original pygame demo, see `star_simulation.py` and `celestial_studio.py`; everything else has moved on.

## Author

Elliot Telford — [elliottelford.com](https://elliottelford.com)
