# Phase 0 runbook — May 2024 Gannon (G5) hindcast

Branch: `claude/gannon-superstorm-simulation-CpFh8`

Peer of `MHD_DENSITY_PHASE0_RUNBOOK.md` (Feb 2022 Starlink). Same overall
shape — pull inputs, replay BATS-R-US, fit the pseudo-Ap regression,
validate against accelerometer truth — but Gannon is **the** Phase-0
event for the Ap-saturation argument. Ap pegged at 400 for ~24 h on
May 11; the empirical models cannot distinguish "pinned 400" from
"would have been 800 if the cap let it climb". This run is the
evidence for that.

We additionally exploit the user's pre-existing ground-magnetometer
reconstruction of the event as a higher-cadence Ap surrogate — exactly
the first remediation lever the Feb 2022 runbook suggests when MHD-only
skill is < 25 %.

## Window

`2024-05-10T12:00Z → 2024-05-13T12:00Z` (72 h). Covers:

* SSC at ~2024-05-10T17:05Z (the first sheath arrival from AR 13664).
* The compound CME pile-up across May 10–11.
* Dst minimum near −412 nT on 2024-05-11 (Kyoto provisional).
* First 24 h of the recovery phase.

Wider than Feb 2022 (48 h) because the storm is multi-pulse and the
recovery is what stresses the MSIS+Ap baseline hardest (composition
overshoot, persistent O depletion).

## Five datasets, lands at

| What | Source | Lands at | Cadence |
|---|---|---|---|
| L1 IMF (OMNI HRO 1-min) | SPDF | `swmf/fixtures/hindcast/gannon_may_2024/imf_l1.dat` | 1 min |
| Ap definitive + F10.7 | GFZ Kp_ap_Ap_SN_F107 | `dsmc/fixtures/hindcast/gannon_may_2024/historical_ap.csv` (already present, 57 rows, 2024-05-08 → 2024-05-15) | 3 h |
| GRACE-FO neutral density | TU Delft v02 | `dsmc/fixtures/hindcast/gannon_may_2024/grace_fo_density.csv` | per-orbit |
| Swarm-C accelerometer density | ESA / TU Delft | `dsmc/fixtures/hindcast/gannon_may_2024/swarm_c_density.csv` | per-orbit |
| Ground-mag reconstruction | SuperMAG / INTERMAGNET / locally derived | `dsmc/fixtures/hindcast/gannon_may_2024/ground_mag.csv` (cols: `t, sme_nt, smu_nt, sml_nt, h_comp_mean_nt`) | 1 min |
| BATS-R-US output (Φ_PC, HPI) | this run | `data/hindcast/gannon_may_2024_hindcast.json` | 5 min |
| Pseudo-Ap fits (MHD + mag) | this OLS step | `data/hindcast/gannon_may_2024_pseudo_ap_fit.json` | 2 fits |

## Day 1 — pull / verify the inputs

```sh
cd swmf && python3 -m pipeline.fetch_omni_imf \
  --start 2024-05-10 --end 2024-05-13 --smoke-test
cd dsmc && python3 -m pipeline.fetch_historical_indices \
  --start 2024-05-10 --end 2024-05-13 --smoke-test
cd dsmc && python3 -m pipeline.fetch_grace_density \
  --start 2024-05-10 --end 2024-05-13 \
  --remote-template 'http://thermosphere.tudelft.nl/acceldata/GraceFO/v02/density/{Y}/grcfo_density_{Y}_{M}_{D}.txt' \
  --smoke-test
```

Then drop the `--smoke-test` and write fixtures.

**Watch-outs specific to Gannon:**

* OMNI propagation can mis-time the May 10 shock by 5–15 min — the
  shock travelled fast and the L1→bow-shock convection delay shrinks.
  Cross-check the IMF.dat shock arrival against DSCOVR direct
  (`dscovr_h0_mag_*.cdf`); if they disagree by > 5 min, prefer DSCOVR
  and re-emit IMF.dat with the SPDF DSCOVR pull path.
* OMNI sentinel bleed (`9999.9`, `99999.9`) is more common than usual
  during multi-CME compression because individual spacecraft drop in
  and out. The L1 ingestor must reject sentinels; verify by
  `grep -c '9999' fixtures/hindcast/gannon_may_2024/imf_l1.dat` → 0.
* The existing `historical_ap.csv` has Ap pinned at 400 across 8
  consecutive 3-h bins on 2024-05-11. That's correct — it's the
  saturation we're going to expose, not a data bug.

### Ground-mag reconstruction import

`dsmc/pipeline/import_ground_mag.py` (shipped on this branch) takes
whatever shape the user's reconstruction is in and writes the canonical
schema. It:

1. Reads CSV or JSON (header auto-detected; non-standard column names
   handled via a built-in alias table or an explicit `--columns
   raw:canon,...` map).
2. Linear-interpolates onto a 1-minute uniform grid in the requested
   window, deriving `sme = smu - sml` when SME is missing.
3. Computes an Ahn-Akasofu-style Joule-heating proxy in GW
   (`--proxy knipp` default — quadratic; `--proxy ahn` linear;
   `--proxy none` to skip).
4. Writes the canonical fixture:
   `t, sme_nt, smu_nt, sml_nt, h_comp_mean_nt, jh_proxy_gw`.

Concrete invocation for Gannon:

```sh
cd dsmc
python3 -m pipeline.import_ground_mag \
  --in raw/supermag/gannon_may_2024.csv \
  --out fixtures/hindcast/gannon_may_2024/ground_mag.csv \
  --start 2024-05-10T12:00:00Z \
  --end   2024-05-13T12:00:00Z \
  -v
```

Unit tests covering the shim: `dsmc/tests/test_import_ground_mag.py`.
Smoke-tested in this session on a 5-row synthetic input → 4 321 rows
on the 1-min grid; SME peak 3 110 nT → 432 GW Joule-heating proxy at
~midway between raw samples (interpolated), which is the right order
of magnitude for Gannon peak forcing.

**Day 1 done when:** all five fixture files present, non-empty, and
`head`/`tail` rows pass eyeball checks.

### Smoke-test status (re-confirmed 2026-05-21)

Day-1 smoke-tests were attempted from the remote-execution sandbox.
All external hosts the pipeline needs return **HTTP 403** (or
connection-timeout) from the sandbox's egress proxy (DNS resolves;
the block is at the proxy layer, not the upstream). A control probe
of `api.github.com` also returns 403 — uniform policy filter, not
real upstream 4xx. Probe results from `node scripts/fetch-omni.mjs
--probe` and `node scripts/fetch-grace.mjs --probe`:

```
spdf.gsfc.nasa.gov          403   (OMNI 1-min IMF)
kp.gfz-potsdam.de           403   (definitive Ap + F10.7)
thermosphere.tudelft.nl     403   (GRACE-FO / Swarm density)
omniweb.gsfc.nasa.gov       403   (OMNI alt access)
api.github.com              403   (also blocks SWMF clone)
raw.githubusercontent.com   301   (redirect-followable read; minimal use)
```

#### What the sandbox needs

To run Day-1 from inside this remote environment, the network policy
has to allow outbound HTTPS (and one HTTP for TU Delft) to:

| Host | Protocol | Purpose |
|---|---|---|
| `spdf.gsfc.nasa.gov` | HTTPS | OMNI HRO 1-min IMF |
| `omniweb.gsfc.nasa.gov` | HTTPS | OMNI fallback |
| `kp.gfz-potsdam.de` | HTTPS | GFZ Kp/Ap definitive series |
| `thermosphere.tudelft.nl` | HTTP | TU Delft accelerometer densities |
| `github.com` + `*.githubusercontent.com` | HTTPS | SWMF clone for BATS-R-US build |

That last row is what unblocks BATS-R-US (Day 2). See the
"BATS-R-US in this sandbox" section below for why even with network
the build doesn't yet run here.

#### Workstation operator path (no allowlist required)

If you'd rather pull from a workstation that has plain internet
access and drop the files in, the exact commands are:

```sh
# 1) OMNI 1-min IMF — May 2024 monthly file (covers the 10-13 May window)
curl -fSL --create-dirs -o swmf/raw/omni/omni_min202405.asc \
  'https://spdf.gsfc.nasa.gov/pub/data/omni/high_res_omni/monthly_1min/omni_min202405.asc'

# 2) GFZ definitive Ap + F10.7 (one file covers all time; filter to window)
curl -fSL --create-dirs -o dsmc/raw/gfz/Kp_ap_Ap_SN_F107_since_1932.txt \
  'https://kp.gfz-potsdam.de/app/files/Kp_ap_Ap_SN_F107_since_1932.txt'

# 3) GRACE-FO density — three daily files spanning 10-12 May
for d in 10 11 12; do
  curl -fSL --create-dirs \
    -o dsmc/raw/grace_fo/grcfo_density_2024_05_${d}.txt \
    "http://thermosphere.tudelft.nl/acceldata/GraceFO/v02/density/2024/grcfo_density_2024_05_${d}.txt"
done

# 4) Swarm-C density — paths shift; verify on TU Delft's index first
# (placeholder — fill in once the v02 Swarm-C tree is browsed)
```

Then run the existing fetchers in local-glob mode (already supported
by `fetch_grace_density`) to canonicalise the inputs. The two upstream
fetchers (`fetch_omni_imf`, `fetch_historical_indices`) currently only
network-fetch — when the time comes we'll add a `--from-file` flag to
each so the same drop-in pattern works for them too. For now,
copy/format manually using their parse functions as a reference.

The ground-mag fixture is independent of all of the above — see the
import shim below.

### Node fetchers (workstation drop-in path, JSON output)

For the JS-side pipeline (the `gannon-superstorm.html` replay bundle),
there are also two Node fetchers that mirror the Python ones above
but support `--from-file` / `--local-dir` natively and write canonical
JSON instead of SWMF/CSV. They live at:

* `scripts/fetch-omni.mjs`   — OMNI 1-min IMF → `data/hindcast/inputs/imf_l1.json`
* `scripts/fetch-grace.mjs`  — GRACE-FO v02   → `data/hindcast/inputs/grace_fo_density.json`

Both ship with `--smoke-test` (embedded synthetic input, no network,
no file writes), `--probe` (HEAD each upstream URL the window needs),
and the `--from-file` / `--local-dir` drop-in modes for the
workstation path. From inside this sandbox both probes return 403
(re-confirmed 2026-05-21); from a workstation:

```sh
# OMNI — single monthly file covers the 72 h window
curl -fSL --create-dirs -o raw/omni/omni_min202405.asc \
  'https://spdf.gsfc.nasa.gov/pub/data/omni/high_res_omni/monthly_1min/omni_min202405.asc'
node scripts/fetch-omni.mjs \
  --start 2024-05-10 --end 2024-05-13 \
  --from-file raw/omni/omni_min202405.asc

# GRACE-FO — three daily files for 10/11/12 May
for d in 10 11 12; do
  curl -fSL --create-dirs \
    -o raw/grace_fo/grcfo_density_2024_05_${d}.txt \
    "http://thermosphere.tudelft.nl/acceldata/GraceFO/v02/density/2024/grcfo_density_2024_05_${d}.txt"
done
node scripts/fetch-grace.mjs \
  --start 2024-05-10 --end 2024-05-13 \
  --local-dir raw/grace_fo
```

Both write the canonical JSON at `data/hindcast/inputs/*.json` for
the bundle builder (Day 2-3) to ingest. The Python peers keep writing
their SWMF/CSV fixtures in parallel; the two pipelines coexist.

## Day 2 — replay + fit

### BATS-R-US in this sandbox (status snapshot)

For the remote-execution sandbox specifically, Day-2 has four hard
prerequisites of which **none** is met today:

| Prereq | Status (2026-05-20) | Why it matters |
|---|---|---|
| Outbound HTTPS to `github.com` | 403 (egress proxy) | `swmf/Dockerfile` clones SWMF from github |
| `gfortran` / `gfortran-12` | not installed | SWMF requires gfortran 9+ |
| OpenMPI dev (`mpicc`, `mpiexec`) | not installed | SWMF coupled solver is MPI-parallel |
| L1 IMF data on disk | not present | feeds `gen_param --imf-file` |

Practical consequence: BATS-R-US for Gannon cannot run from inside
this sandbox in its current configuration. To unblock from here:
widen the network policy as listed above **and** rebuild the
sandbox image with `gfortran-12 libopenmpi-dev openmpi-bin`
pre-installed (or wrap the run in `docker compose up` against
`docker-compose.swmf.yml`, since Docker *is* installed here — but
the in-image build still needs network for the SWMF clone).

To unblock from a workstation: install the prereqs, follow the
container instructions in `swmf/Dockerfile`, and post the runner
output JSON back into this repo at
`data/hindcast/gannon_may_2024_hindcast.json`.

#### Placeholder mode for Day-2 plumbing tests

So the MHD-track fitter can be exercised today without BATS-R-US,
`scripts/gen_gannon_placeholder_mhd.py` synthesises a Gannon-shaped
hindcast JSON from the page-side replay bundle. The output carries
top-level `"is_placeholder": true`; `fit_pseudo_ap.py` refuses to
fit it unless `--allow-placeholder` is set, and even then the
output fit omits the legacy `a/b/c` shortcut keys so
`hindcast_runner.PseudoApFit.from_json` can't accidentally load it.

```sh
python3 scripts/gen_gannon_placeholder_mhd.py
# → data/hindcast/gannon_may_2024_hindcast.json  (865 samples, 5-min cadence,
#   peak Φ_PC ≈ 332 kV, peak HPI ≈ 450 GW)
```

Smoke-tested 2026-05-20; both tracks lined up side-by-side:

| Track | Coefficients (synthetic only) | R² |
|---|---|---|
| MHD (`--hindcast …_hindcast.json`)        | `Ap* = +6.92 + 4.616·Φ_PC − 2.725·HPI` | 0.79 |
| Ground-mag (`--features-csv …ground_mag.csv`) | `Ap* = +67.11 − 0.045·SME + 0.561·jh_proxy` | 0.48 |

These are numerically meaningless on their own — they're fit to a
synthetic surrogate against an Ap series saturated at 400 for ~24 h.
What they verify is the pipeline plumbing: pairing, OLS, refusal
contract, output schema. Real BATS-R-US output will overwrite
the hindcast JSON in place and these tables get re-populated.

### Generate PARAM.in — coupled GM+IE

The pseudo-Ap story needs **Φ_PC and HPI**, which only the coupled **GM+IE**
run emits (via the Ridley IE log). That path is the `gm_ie` sub-command — *not*
`hindcast` (which is the IH-only inline template) and *not* `run_forecast
--once` (which is the real-time forecast cycle). One command generates the
coupled `PARAM.in` (Boris + cold-start ladder already baked into
`config/PARAM.in.GM_IE`):

```sh
cd swmf
# imf_l1.dat must already be staged in IMF_DIR (default /data/imf; set IMF_DIR
# to point elsewhere). --f107 227.1 is the Gannon-window F10.7 from
# historical_ap.csv. Prints "Run dir: <RUN_DIR>" — capture it for the next step.
python3 -m pipeline.gen_param gm_ie \
  --start 2024-05-10T12:00:00 --hours 72 \
  --f107 227.1 --nproc 4 --imf imf_l1.dat
```

### Launch BATS-R-US

72 h of simulated time on `nproc 4` is a longer wall-clock run than the Feb
2022 hindcast — budget overnight. Tail `<RUN_DIR>/batsrus_stdout.log`. The
`--launch-run-dir` mode launches `SWMF.exe` (the coupled binary) on the
prepared run dir; it is distinct from `--once` (which regenerates a *forecast*
run) and does not touch the forecast DB.

```sh
cd swmf
python3 -m pipeline.run_forecast --launch-run-dir <RUN_DIR> \
  --nproc 4 --timeout-hours 24
```

> **Or run the whole coupled sequence with one command inside the container:**
> `docker compose -f docker-compose.swmf.yml run --rm swmf-hindcast` invokes
> `swmf/run-gannon-hindcast.sh`, which does the IMF gate → `gen_param gm_ie` →
> `run_forecast --launch-run-dir` → `hindcast_runner` in order. See
> `NEW_COMPUTER_RUNBOOK.md`.

### Solver stability — the cold-start ladder, Boris, and the CflExpl ≤ 0.65 rule

> **Load-bearing. Read before editing `swmf/config/PARAM.in.GM_IE`.** Getting
> this Gannon run to advance a single second of simulated time took four
> non-obvious fixes in a row (2026-06-07 session). Each one is a re-discoverable
> trap. Do not "simplify" the three-session structure or move the `#BORIS`
> block without reading this.

The template `swmf/config/PARAM.in.GM_IE` drives GM (BATS-R-US) + IE only — no
IM/RB ring-current component, on a coarser inner grid than SWPC operational. A
cold dipole magnetosphere **cannot** be integrated directly in 2nd-order,
time-accurate mode; it overshoots into negative density/pressure on iteration 1
("negative fast speed squared"). The validated recipe is a three-session ladder
and **all three sessions matter**:

| Session | `#TIMEACCURATE` | `#SCHEME` | `#TIMESTEPPING` | Purpose |
|---|---|---|---|---|
| 1 | `F` (steady, local dt) | `1` Rusanov (1st order) | `1` stage, **CflExpl 0.6** | relax the cold start in the most diffusive scheme |
| 2 | `F` (steady, local dt) | `2` Rusanov mc3 1.2 | `2` stage, **CflExpl 0.6** | converge the magnetosphere shape in 2nd order |
| 3 | `T` (time-accurate) | (inherits 2nd order) | `2` stage, CflExpl 0.6 | drive the storm from the relaxed state |

**Boris must be ON from session 1 — not switched on at session 3.** This is the
single most expensive trap in the file. The Boris semi-relativistic correction
caps the artificial fast/Alfvén speed near Earth (huge B, low ρ), but it also
**redefines the conserved momentum** (it folds in the v×B electric-field term).
If you relax sessions 1–2 *without* Boris and enable it only in the
time-accurate session 3, the relaxed state carries the non-Boris momentum
definition and is inconsistent with the integrator. Result: the inner-boundary
cell at **r ≈ 3.57 R_E** (just outside `rCurrents = 3.5`) detonates on the
*first* time-accurate step — `NaN from advance_explicit`, density → 1e88…1e100,
at `iteration = 1524`, **identically regardless of `nStage` or `CflExpl`**. That
integrator-independence is the tell: it is not a CFL problem, it is a
conserved-state inconsistency. Relaxing *with* Boris on fixed it; the run then
sailed past 1524 with the simulated clock advancing.

**The `CflExpl ≤ 0.65` rule.** BATS-R-US hard-rejects Boris correction combined
with **local (steady-state) time stepping** at CFL > 0.65:

```
GM_set_parameters WARNING: CFL number above 0.65 may be unstable for
local timestepping with Boris correction !!!
... ERROR: Correct PARAM.in!     (fatal — aborts at session 1, iteration 0)
```

So once Boris is in session 1, sessions 1 **and** 2 (both steady-state) need an
explicit `#TIMESTEPPING` with `CflExpl ≤ 0.65`. A session with **no**
`#TIMESTEPPING` block inherits a default CFL above 0.65 and aborts before
iteration 1 with `Correct PARAM.in!` (and `highest iteration reached = 0`). The
time-accurate session 3 is not subject to this limit (it is global, not local
time stepping), but we keep it at 0.6 anyway.

**Failure-signature cheat sheet** (so the next session recognises which trap it
hit without re-deriving it):

| Symptom in `batsrus_stdout.log` | Cause | Fix |
|---|---|---|
| `ERROR: Correct PARAM.in!`, iter 0, `Correct PARAM` after a Boris+CFL warning | Boris + local dt with CflExpl > 0.65 | add `#TIMESTEPPING` `CflExpl 0.6` to the steady-state session(s) |
| `NaN from advance_explicit` at `r≈3.57`, iter **1524**, density→1e100, independent of `nStage`/`CflExpl` | Boris enabled only at session 3 (inconsistent conserved state) | enable `#BORIS` from session 1 so the relaxation is Boris-consistent |
| `negative fast speed squared`, iter 1, at the **+x upstream face** (`x≈34`) | garbage IMF (negative/huge ρ, B) at the driven boundary | re-fetch `imf_l1.dat`, see data gate below |
| relaxes to 1500 then crashes only in session 3 | usually the Boris-transition trap above | — |

**Input data gate (don't skip — a stale `imf_l1.dat` masquerades as a solver
bug).** The upstream driver file is column-sensitive; a parser regression once
wrote density into the temperature column, producing negative/huge ρ that blew
up the +x boundary at iteration 1. Always re-fetch with **`python3`** (the
container has no `python` alias — `python -m …` silently no-ops and leaves the
old file in place) and gate before launching:

```sh
# inside the swmf container, after fetch_omni_imf writes /data/imf/imf_l1.dat:
head -6 /data/imf/imf_l1.dat                       # density col 14, Bz col 10
awk '$1 ~ /^[0-9]/{print $14}' /data/imf/imf_l1.dat | sort -n | sed -n '1p;$p'
awk '$1 ~ /^[0-9]/{print $10}' /data/imf/imf_l1.dat | sort -n | sed -n '1p;$p'
```

Gate: density strictly **positive** (Gannon ≈ 0.7 → 70 /cc), Bz in **tens of
nT** (≈ −47 → +49 nT). A negative-density min or a Bz in the thousands means the
columns are misparsed — fix the fetch, not the PARAM.

**Crash-safe resume.** Session 3 sets `#SAVERESTART` every 3600 s of simulated
time → `GM/restartOUT/`. A long run that is interrupted resumes from the last
checkpoint instead of re-running the cold-start ladder.

### Extract Φ_PC and HPI

`hindcast_runner`'s registered event **key is `may_2024_gannon`** — reversed
from the `gannon_may_2024` fixtures dir + front-end bundle. Pass the key form
here (argparse `choices` rejects `gannon_may_2024`), and point `--run-dir` at
the `gm_ie` run dir printed above:

```sh
cd swmf
python3 -m pipeline.hindcast_runner --event may_2024_gannon \
  --run-dir <RUN_DIR> \
  --out ../data/hindcast -v
```

### Two-track pseudo-Ap fit

The Feb 2022 pipeline fits `Ap* = a + b·Φ_PC + c·HPI`. For Gannon we
fit two independent models and report both:

* **MHD track** — same as Feb 2022:
  ```
  Ap*_mhd = a + b·Φ_PC + c·HPI
  ```
* **Ground-mag track** — independent reconstruction from the user's
  magnetometer data:
  ```
  Ap*_gnd = a' + b'·SME + c'·dΦ/dt + d'·jh_proxy
  ```

`fit_pseudo_ap.py` supports both paths natively (mutually exclusive
`--hindcast` and `--features-csv` flags). The features-CSV path
**refuses** to score against any input carrying the `_is_placeholder`
column — pass `--allow-placeholder` only when you intentionally want
a plumbing-only fit; the resulting JSON is then stamped
`"is_placeholder_input": true` so downstream consumers can refuse to
treat it as real.

```sh
cd dsmc
# MHD track (writes v1-compat a/b/c plus v2 coefficients/features keys
# so hindcast_runner.PseudoApFit.from_json keeps loading it unchanged):
python3 -m pipeline.fit_pseudo_ap \
  --hindcast ../data/hindcast/gannon_may_2024_hindcast.json \
  --historical-ap fixtures/hindcast/gannon_may_2024/historical_ap.csv \
  --out ../data/hindcast/gannon_may_2024_pseudo_ap_fit.json -v

# Ground-mag track (independent OLS, n features general):
python3 -m pipeline.fit_pseudo_ap \
  --features-csv fixtures/hindcast/gannon_may_2024/ground_mag.csv \
  --feature-cols sme_nt,jh_proxy_gw \
  --historical-ap fixtures/hindcast/gannon_may_2024/historical_ap.csv \
  --event-id gannon_may_2024 \
  --out ../data/hindcast/gannon_may_2024_pseudo_ap_fit_ground.json -v
```

Smoke-tested against the synthetic placeholder fixture: without
`--allow-placeholder` the CLI exits 1 with a clear refusal message
and writes no JSON; with it, the fit lands at
`Ap* = +67.1 − 0.045·sme_nt + 0.561·jh_proxy_gw` (R² ≈ 0.48 against
the saturated-at-400 historical Ap — the low R² is the
Ap-ceiling signature, not a regression bug). When the real
reconstruction lands and Ap is no longer treated as saturating
truth (since the whole point is that it isn't), this number
becomes the storm-peak skill comparison.

**Gannon-specific sanity bounds.** Because Ap is saturated for most
of the storm peak, single-event OLS will under-fit the high end.
Acceptable region: `b ∈ [0.15, 0.9]`, `c ∈ [0.05, 0.7]`. If R² is
poor *only at the storm peak* and clean during the ramp and recovery,
that is the expected Ap-ceiling artefact — note it in the residuals
write-up; do not chase coefficients into nonphysical territory.

**Day 2 done when:** both fits are written and the runner has been
re-invoked with `--regression-json` to recompute the sample-by-sample
`ap_pseudo_mhd` and `ap_pseudo_gnd` series.

## Day 3 — validate against two truth sources

### Score against GRACE-FO + Swarm-C

```sh
cd dsmc
python3 -m pipeline.validate_density \
  --hindcast ../data/hindcast/gannon_may_2024_hindcast.json \
  --truth fixtures/hindcast/gannon_may_2024/grace_fo_density.csv \
  --truth-secondary fixtures/hindcast/gannon_may_2024/swarm_c_density.csv \
  --historical-ap fixtures/hindcast/gannon_may_2024/historical_ap.csv \
  --out ../data/hindcast -v
```

The validator currently takes a single `--truth`. Two-truth comparison
requires extending the residual-report writer to emit two
RMSE-vs-baseline columns and tag each sample by source. If the
extension lands too slow, run the validator twice with different
`--truth` and merge the residual JSON post-hoc.

### Decision matrix

Three skill numbers to read:

| Run | Driver | Read off `_residuals.md` |
|---|---|---|
| MSIS+Ap (saturated) | baseline | RMSE_base |
| MSIS+Ap*_mhd | MHD track | RMSE_mhd, skill_mhd = 1 − RMSE_mhd/RMSE_base |
| MSIS+Ap*_gnd | ground-mag track | RMSE_gnd, skill_gnd = 1 − RMSE_gnd/RMSE_base |

Phase-0 gate: `max(skill_mhd, skill_gnd) ≥ 0.25`. If only the
ground-mag track clears the bar, the story becomes "MHD adds modest
skill over a simpler observational reconstruction — Phase 1 needs to
either improve the BATS-R-US grid or accept the mag-only product as
the v0".

### One-page write-up

Append to `MHD_DENSITY_PHASE0_RESULTS.md` (create if absent) a Gannon
section paralleling whatever the Feb 2022 section looks like:

* Event window, fitted formulas (both tracks), R² per track.
* Three skill numbers per the matrix above.
* Residual histograms by storm phase (ramp / peak / recovery) —
  separating storm-time vs. recovery-time skill is the headline
  finding for this event.
* The Ap-saturation segment: a single timeseries plot showing real
  Ap pinned at 400 while Ap*_mhd climbs to (provisionally) 600–800.
  This plot **is** the marketing slide.
* The next event (Halloween 2003) and the joint-fit plan.

## What's different from Feb 2022 (summary)

| Aspect | Feb 2022 | Gannon May 2024 |
|---|---|---|
| Window | 48 h | 72 h (multi-pulse) |
| Truth sources | GRACE-FO only | GRACE-FO + Swarm-C |
| Ap behaviour | climbs, doesn't peg | pegged at 400 for ~24 h |
| Pseudo-Ap tracks | MHD only | MHD + ground-mag (parallel) |
| Composition story | not central | central (O depletion on recovery) |
| Wall-clock budget | several hours | overnight |
| Marketing payload | Starlink LOC narrative | Ap-ceiling exposed; cycle-25-largest energy |

## Stretch goals (post-gate)

1. Run `drag_forecast.py` for a representative Starlink shell and a
   Spire cubesat across the window; report perigee-altitude error
   band against TLE ground truth. This is the per-spacecraft story.
2. Compute integrated hemispheric Joule-heating across the event and
   compare to a Halloween-2003 estimate. The claim "Gannon is the
   largest by deposited energy of cycle 25" needs this number.
3. Diff the MHD-derived composition (O/N₂ proxy from cusp + auroral
   inputs) against the storm-time MSIS output. Phase-2 hook.

## Concrete next step

Day 1, fetcher smoke tests for the Gannon window, in parallel with
finalising the new front-end page
(`gannon-superstorm.html` — see `GANNON_SIMULATION_DESIGN.md`). The
fetchers are zero-network in `--smoke-test` mode so they're safe to
run inside the session.
