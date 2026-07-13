# Fixture — St. Patrick's Day storm, Mar 2015 (`st_patrick_mar_2015`)

Event 1 of the hindcast database. Expected contents (see
`HINDCAST_STPATRICK_2015_RUNBOOK.md` Day 1 for the pull commands and the
data gate that must pass before anything lands here):

* `imf_l1.dat` — OMNI HRO 1-min L1 IMF for 2015-03-16T12 → 2015-03-19T12,
  written by `pipeline/fetch_omni_imf.py` from `omni_min201503.asc`.
  **Not yet staged** — SPDF is 403-blocked from the remote sandbox, so the
  pull is a workstation step.
* `mhd_output.json` — optional synthetic BATS-R-US output if a
  `hindcast_runner --dry-run` fixture is ever needed for this event
  (generate with `scripts/build_hindcast_fixture.py`).

Fingerprints for `imf_l1.dat` (reject the file if these are off): SSC
density jump to ~20–40 /cc at 2015-03-17 ~04:45 UT, speed step ~400 →
550–600 km/s, magnetic-cloud Bz floor ≈ −25 to −30 nT late Mar 17, zero
`9999` sentinels.

The index/truth fixtures for this event live at
`dsmc/fixtures/hindcast/st_patrick_mar_2015/` (`historical_ap.csv` already
staged; `ground_mag.csv` and `kyoto_dst.csv` pending the same workstation
pull).
