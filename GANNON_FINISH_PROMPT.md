# Prompt — finish the May-2024 Gannon MHD hindcast (run on the workstation)

You are working in the **parkersphysics.com** repo on a workstation that has
plain outbound internet, Docker (BuildKit), `gfortran`, and OpenMPI — unlike the
Claude-on-the-web sandbox, which is network-blocked and can't compile SWMF. Your
job is to take the May-2024 Gannon (G5) MHD-density hindcast from PLACEHOLDER to
VALIDATED and publish it so the live `gannon-superstorm.html` page lifts itself.

**Read first, in order:** `CLAUDE.md` (§4 load-bearing invariants, §5 reversion
pattern), `NEW_COMPUTER_RUNBOOK.md` (the end-to-end offload path), and
`MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md` (per-step detail + the load-bearing solver
cold-start ladder). The launch wiring (`gen_param gm_ie`,
`run_forecast --launch-run-dir`, `swmf/run-gannon-hindcast.sh`,
`docker-compose.swmf.yml`) already exists on branch
`claude/gannon-superstorm-simulation-8ea0o2` — verify you're on it or based on it.

**Naming landmine (do not "fix"):** the fixtures dir + front-end bundle use
`gannon_may_2024`, but `hindcast_runner`'s registered event key is the reversed
`may_2024_gannon`. Pass the right spelling to each tool; don't unify them.

## What's already real vs still placeholder

Real: GFZ definitive Ap, GRACE-FO density truth
(`dsmc/fixtures/hindcast/gannon_may_2024/grace_fo_density.csv`), and the runtime
CME/OMNI page lifts. Placeholder/blocking: the BATS-R-US output (Φ_PC/HPI), the
ground-mag reconstruction (`ground_mag.csv` carries `_is_placeholder=1`), and the
density-validation skill numbers. The page pill keys off the MHD track, so it
stays `⚠ PLACEHOLDER DATA` until real model tracks are published.

## Do this

1. **Stage + gate inputs.** Fetch OMNI HRO 1-min IMF for 2024-05-10→13 to
   `swmf/data/imf/imf_l1.dat` (workstation curl paths are in the runbook, Day 1).
   Gate it before spending an overnight run: IMF density column strictly
   positive, Bz in tens of nT, zero `9999` sentinels. A stale/misparsed IMF
   masquerades as a solver bug — fix the fetch, not PARAM.in. GRACE-FO truth is
   already committed. The real SuperMAG/INTERMAGNET **ground-mag** reconstruction
   still needs to replace the placeholder for the second skill track — import it
   with `dsmc/pipeline/import_ground_mag.py` if you have the raw data; if not,
   proceed with the MHD track alone and note the gap.

2. **Run the coupled GM+IE hindcast (overnight).**
   ```sh
   docker compose -f docker-compose.swmf.yml build            # ~30-50 min, once
   docker compose -f docker-compose.swmf.yml run --rm swmf-hindcast
   ```
   This runs the IMF gate → `gen_param gm_ie` → `run_forecast --launch-run-dir`
   → `hindcast_runner`, producing `data/hindcast/may_2024_gannon_hindcast.json`.
   **Watch the solver like the runbook says:** if `batsrus_stdout.log` shows
   `Correct PARAM.in!` at iter 0, or `NaN from advance_explicit` at r≈3.57 iter
   1524, or `negative fast speed squared` at the +x face, match the symptom to
   the runbook's failure-signature table before changing anything — the
   three-session cold-start ladder + Boris-from-session-1 + CflExpl ≤ 0.65 are
   load-bearing; do not "simplify" `config/PARAM.in.GM_IE`. It resumes from
   `GM/restartOUT/` if interrupted.

3. **Fit + validate (host).** MHD-track pseudo-Ap fit
   (`dsmc/pipeline/fit_pseudo_ap.py --hindcast … --historical-ap …`), then
   `dsmc/pipeline/validate_density.py --hindcast … --truth grace_fo_density.csv
   --historical-ap …`. The **Phase-0 gate is `max(skill_mhd, skill_gnd) ≥ 0.25`**.
   Add the ground-mag track (`--features-csv`) if step 1 landed real mag data.
   Expect the residual to concentrate at the storm peak (the Ap-ceiling artefact,
   Ap pinned at 400) — that's the product thesis, not a bug; don't chase
   coefficients into nonphysical territory (sanity bands are in the runbook).

4. **Record + publish.** Append the event section to
   `MHD_DENSITY_PHASE0_RESULTS.md` (both fitted formulas, R² per track, the three
   skill numbers, residuals by storm phase, and the Ap-saturation timeseries —
   real Ap pinned at 400 while Ap*_mhd climbs past it, which is the marketing
   slide). Then build + upload the model artifact:
   ```sh
   node scripts/build-gannon-model-artifact.mjs \
     --bundle data/hindcast/gannon_may_2024_replay.json \
     --hindcast data/hindcast/may_2024_gannon_hindcast.json \
     --residuals data/hindcast/may_2024_gannon_residuals.json \
     --upload
   ```
   Needs `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
   in the env. The builder **refuses to upload placeholder-derived data** — if it
   blocks, your hindcast/fit JSONs are still stamped placeholder; find out why
   before overriding.

5. **Confirm the lift.** In a Vercel preview/prod (egress-allowed),
   `/api/hindcast/gannon-model` should return `available:true` and
   `gannon-superstorm.html` should flip its pill from `⚠ PLACEHOLDER DATA` to
   `● BATS-R-US HINDCAST` / `✓ VALIDATED HINDCAST` with no front-end redeploy.

## Guardrails

- Commit to branch `claude/gannon-superstorm-simulation-8ea0o2`; don't force-push
  over shared history. Follow `CLAUDE.md` §5 before any PR.
- Don't publish a VALIDATED artifact from synthetic inputs — the placeholder
  refusal contract exists for exactly that.
- If the gate fails (`skill < 0.25` on both tracks), don't fudge it — report the
  numbers and the residual-by-phase breakdown, and treat "mag-only product as v0"
  vs "improve the BATS-R-US grid" as a Phase-1 decision for the user.
- State up front, in one line, what you understand the task to be and which files
  you expect to change; then proceed.

## Done when

`data/hindcast/may_2024_gannon_hindcast.json` is a real BATS-R-US run, the
Phase-0 gate result is recorded in `MHD_DENSITY_PHASE0_RESULTS.md`, the model
artifact is uploaded to R2, and the live page shows the un-stamped hindcast.
