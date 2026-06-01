# Far-Side Watch — next steps

> Status as of this writing: Phases 0–5 are **scaffolded and merged** (#832 +
> #834). The detector, tracker, emergence-ETA, page, ingestion cron, Supabase
> archive, and backtest harness all exist and are exercised end-to-end on
> **labelled synthetic data**. The `farside_maps` table is live.
>
> The work below is ordered by what unblocks the most value. The single gating
> item is **real GONG data access** — everything downstream is calibration and
> product polish on top of a pipeline that already runs.

---

## Tier 0 — Go live with real data (the blocker)

Nothing here is code; it's the ops + data-access work that flips the page from
SYNTHETIC to LIVE. Until this is done the rest is unverifiable against reality.

1. **Confirm the real GONG far-side endpoints.** The URLs in
   `api/_lib/farside-sources.js` are best-known guesses. Verify against the NSO
   archive: exact path, file naming, cadence, and whether the product is FITS,
   FITS.gz, or PNG. (GONG far-side products are published by NSO/NISP and also
   fed to NOAA SWPC.)
2. **Allow-list the upstream hosts** in the deployment network policy. The
   sandbox blocked `gong.nso.edu` / `gong2.nso.edu` with `host_not_allowed`;
   production will need the same hosts (and SolO/STEREO/JSOC) explicitly allowed.
3. **Set the env vars on Vercel:** `FARSIDE_GONG_URL` (required), optionally
   `FARSIDE_SOLO_URL`, `FARSIDE_STEREO_URL`, `FARSIDE_HMI_URL`. Confirm
   `SUPABASE_SERVICE_KEY` is readable from the **edge** runtime (the proxy reads
   the DB), and set `R2_*` if you want raw-map provenance archived.
4. **Trigger one ingest run** (manually or wait for `30 1,13 * * *`). Acceptance:
   a real row in `farside_maps`; `?format=json` and `?format=series` return real
   data; the page source pill shows `● LIVE`; the `farside_ingest` heartbeat is
   green.

**Acceptance for Tier 0:** one real GONG map ingested, rendered on the page, with
detections, and no watchdog alert.

---

## Tier 1 — Make the parser + detector survive real data

The FITS reader and detector thresholds are tuned to synthetic fields. Real GONG
maps will differ in ways we can only fix once we have one in hand.

1. **Validate `api/_lib/fits.js` against a real map.** Check BITPIX, multi-HDU,
   and **gzip** (`.fits.gz` → add `gunzip` in the cron before `readFITS`).
2. **Get the projection right.** Far-side seismic maps cover the far *hemisphere*
   in a specific projection (Carrington longitude, possibly sine-latitude), not
   necessarily a clean 360×180 grid. Fix the `resample` mapping and the renderer's
   longitude axis to the real coverage, including the low-sensitivity "seismic
   shadow" near the far-side limbs.
3. **Confirm the sign + units.** GONG active regions are a negative phase shift;
   verify and tune `zNormalize(..., signatureSign)` + `DETECT.sigma` against the
   real background noise so the false-positive floor is sane.
4. **Re-calibrate `DETECT`** (`sigma`, `minAreaDeg2`, `maxLatDeg`, `strongStrength`)
   on real maps with known events.

**Acceptance for Tier 1:** the detector flags the regions a human sees on the
real map, with a defensible false-positive rate.

---

## Tier 2 — Real validation (turn the moat from synthetic to measured)

This is the SBIR/operator deliverable: a **measured** warning horizon.

1. **Backfill the GONG far-side archive** for the two canonical windows —
   ~Apr 2024 (AR13664 / Gannon) and ~May 2026. Add a `?backfill=<from>..<to>` mode
   to `api/cron/farside-ingest.js` that pages the archive instead of "latest".
2. **Ingest the NOAA ground truth.** Pull the NOAA SWPC `solar_regions` history
   (which signatures became NOAA-numbered regions at the east limb, their dates,
   Carrington coords, and flare productivity) into a `farside_truth` table or a
   static dataset. This replaces the two hand-coded `VALIDATION_CASES`.
3. **Point `runBacktest()` at real frames.** It already accepts the cron's stored
   frame shape — swap `runSyntheticBacktest()` for real per-emergence windows
   pulled from `farside_maps` + `farside_truth`. Report the real triplet:
   detection rate, median lead time, false-alarm rate (+ ETA accuracy).
4. **Publish the result** on the page (drop the SYNTHETIC label) and in the SBIR
   deck: "we caught AR13664 N days before the limb."

**Acceptance for Tier 2:** the backtest panel shows real, dated, cited numbers
for AR13664 and the 2026 region.

---

## Tier 3 — ML detector (Phase 2 upgrade)

The classical detector is the baseline; the ML layer is the wheelhouse.

1. **Assemble the training set:** historical GONG maps labelled by ground truth
   (Tier 2's `farside_truth`) — which signatures became real regions, and how
   flare-productive.
2. **Train a detector** in the Felipe & Asensio Ramos style (CNN trained on
   Earth-side regions to pull far-side signatures out of the noise). Batch-run
   every 12 h.
3. **Slot it behind the stable contract.** `detectSignatures()` already returns a
   `confidence` in [0,1]; replace the logistic heuristic with the learned
   probability. No caller changes.

**Acceptance for Tier 3:** ML detection rate and FAR beat the classical baseline
on a held-out validation set.

---

## Tier 4 — Cross-source fusion

Use the imagers and the second seismic pipeline to confirm/deny.

1. **HMI/JSOC seismic** as an independent cross-check — agreement with GONG raises
   a detection's confidence; disagreement flags it.
2. **SolO / STEREO-A EUV** when geometry cooperates: a direct-imaging confirmation
   of a seismic detection is the strongest possible signal. Add a fusion step that
   boosts confidence when ≥2 sources agree, and surface which sources saw it.

**Acceptance for Tier 4:** a detection carries a per-source provenance badge and a
fused confidence.

---

## Tier 5 — Product surface (finish Phase 4)

1. **Globe overlay on the Solar Physics Engine** (`sun.html` / solar engine):
   import `js/farside/index.js` and render front-side ARs + far-side detections +
   the east-limb horizon on the rotating 3D globe (deferred from Phase 4).
2. **Embed the Far-Side Watch panel** in the Space-Weather dashboard
   (`space-weather.html`).
3. **Wire the real alert.** Add a `notify_region_emergence` column to
   `user_profiles` (migration), a toggle in `account.html`, and adopt the
   `farside-alerts.js` rule into `js/alert-engine.js` (today we dispatch the
   `user-alert` event directly — the shape already matches the engine).
4. **Operator export.** Build `api/farside/export` (CSV + REST) as promised,
   gated to Advanced; the page's CSV button already exists for signed-in users.
5. **Status + monitoring.** Add the `farside_ingest` pipeline to `status.html`;
   confirm watchdog alert routing.

---

## Tier 6 — Scientific accuracy refinements

Small physics upgrades that improve ETA precision and honesty.

1. **Differential rotation.** Replace the fixed 13.2°/day synodic rate with a
   latitude-dependent profile (Snodgrass/Howard) in `carrington.js` —
   high-latitude regions rotate slower, shifting their emergence ETA.
2. **B0 tilt** in the limb-crossing geometry (latitude affects the exact crossing
   instant via the solar-axis tilt).
3. **Coverage-aware confidence.** Down-weight detections in the far-side seismic
   shadow (near ±90° CMD) where holography is least reliable.

---

## Tier 7 — Tests

Add a `tests/` harness (the repo already uses Playwright + node tests):
- node unit tests for `fits.js` (round-trip), `farside-detect`, `farside-track`,
  `farside-validate` (the smoke tests run during development, formalized).
- a Playwright smoke for `far-side-watch.html` (loads, renders, panel populates).

---

## Dependency order (at a glance)

```
Tier 0 (data access) ─┬─> Tier 1 (parser/detector calibration) ─┬─> Tier 3 (ML)
                      │                                          └─> Tier 4 (fusion)
                      └─> Tier 2 (real validation) ──────────────────> SBIR proof
Tier 5 (product) and Tier 6/7 (accuracy/tests) can proceed in parallel once
Tier 0 lands.
```

The honest critical path to the SBIR pitch is **Tier 0 → Tier 1 → Tier 2**.
