# Far-Side Watch — next steps

> Status as of this writing: Phases 0–5 are **scaffolded and merged** (#832 +
> #834). The detector, tracker, emergence-ETA, page, ingestion cron, Supabase
> archive, and backtest harness all exist and are exercised end-to-end on
> **labelled synthetic data**. The `farside_maps` table is live.
>
> The work below is ordered by what unblocks the most value. The single gating
> item is **real GONG data access** — everything downstream is calibration and
> product polish on top of a pipeline that already runs.

> **Update (this session):** Tier 1 (WCS-aware parser + gzip + configurable
> sign) and Tier 2 (ground-truth table, archive-backtest evaluator with
> date-based matching, backfill mode, read endpoints) are now **code-complete
> and unit-tested**. They are still **data-blocked** on Tier 0 (no real maps
> ingested yet). Tiers 3 and 4 are detailed below as concrete build plans.

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

## Tier 1 — Make the parser + detector survive real data  ✅ code-complete

The FITS reader is now robust to the real product (verified with synthetic WCS
fixtures); only on-real-data calibration remains.

- ✅ **gzip** handled in the cron (`maybeGunzip`, magic-byte + `.gz` detection).
- ✅ **WCS-aware projection** (`parseWCS` + `remapToCarrington` in
  `api/_lib/fits.js`): reads `CRVAL/CDELT/CRPIX/CTYPE` and projects the source
  onto the canonical Carrington grid — correct for arbitrary pixel dims, a
  partial far-side longitude window, and **sine-latitude** (CEA) maps. Cells
  outside coverage stay 0 (no fabricated data in the seismic shadow).
- ✅ **Configurable sign + projection** via env (`FARSIDE_SIGNATURE_SIGN`,
  `FARSIDE_LAT_PROJECTION`) — default AR = negative.
- ⏳ **Remaining (needs a real map):** confirm the actual CTYPE/projection and
  sign, then re-tune `DETECT` (`sigma`, `minAreaDeg2`, `maxLatDeg`,
  `strongStrength`) against real background noise.

**Acceptance for Tier 1:** the detector flags the regions a human sees on the
real map, with a defensible false-positive rate.

---

## Tier 2 — Real validation (the moat)  ✅ code-complete

The whole validation path is built and unit-tested; it just needs real maps in
the archive to produce live numbers.

- ✅ **`farside_truth` table** (`supabase-farside-truth-migration.sql`, applied
  live) — ground-truth emergence record, public-read, seeded with AR13664 +
  the 2026 case.
- ✅ **Backfill mode** — `GET /api/cron/farside-ingest?backfill=<fromISO>..<toISO>`
  pages dated archive files (template `FARSIDE_GONG_ARCHIVE_TEMPLATE`,
  placeholders `{yyyy}{mm}{dd}{hh}`), capped per invocation.
- ✅ **Read endpoints** — proxy `format=truth` and date-ranged `format=series`
  (`&from=&to=`); feed accessors `getTruth()` / `getArchiveFrames()`.
- ✅ **Archive-backtest evaluator** — `runArchiveBacktest({truth, fetchFrames})`
  (pure, injected fetcher). **Date-based matching**: a track matches a truth case
  when its predicted emergence lands within `BACKTEST.matchDays` of the real
  crossing at a compatible latitude — robust to longitude bookkeeping drift.
  Honestly reports `windowsCovered`; the page shows LIVE numbers only when ≥1
  window has archive coverage, else falls back to the synthetic demo.
- ⏳ **Remaining (needs Tier 0):** run the backfill for the AR13664 (~Apr 2024)
  and 2026 windows once the archive URL template + host allow-list are set; the
  panel then flips to LIVE automatically. Optionally enrich `farside_truth` from
  the NOAA SWPC `solar_regions` history (a small importer) beyond the two seeds.

**Acceptance for Tier 2:** the backtest panel shows real, dated numbers for
AR13664 and the 2026 region (LIVE pill, ≥1 window covered).

---

## Tier 3 — ML detector (Phase 2 upgrade) — build plan

The classical blob detector is the transparent baseline + region proposer; the
ML layer rescores its proposals out of the noise. Design follows FarNet /
FarNet-II (Felipe & Asensio Ramos): a U-net that ingests a *sequence* of
phase-shift maps and emits a far-side activity probability.

**3.1 Training data (depends on Tier 2 archive).**
- `X`: a stack of K consecutive z-normalized phase-shift grids (FarNet uses ~11
  maps; our maps are 12-hourly, so K≈11 ≈ 5.5 days). Pull from
  `farside_maps.grid_b64` (or the raw R2 archive) in time order.
- `y`: a per-pixel activity mask — project each `farside_truth` region to its
  far-side position at each frame's time (fixed Carrington longitude → CMD via
  `carringtonL0`) as a Gaussian blob, positive only while genuinely far-side.
  Weakly-labelled but enough for a U-net.
- Augment with **negatives**: quiet far-side maps with no subsequent emergence.

**3.2 Model + training (offline, Python — NOT in the Vercel runtime).**
- U-net encoder/decoder, sequence input, sigmoid activity-map output; focal/Dice
  loss (activity is rare). Hold out the AR13664 + 2026 windows as the test set.
- Export to **ONNX** for portable inference.

**3.3 Inference integration (two viable paths).**
- **(a) ONNX in the Node cron** via `onnxruntime-node`: the classical detector
  proposes blobs, the model rescores each proposal's `confidence` on the K-map
  stack (drop sub-threshold). Stays in the existing 12-h cron.
- **(b) A small Python worker** (the "small worker on a 12-h cron" from the
  brief): loads the model, reads recent grids from Supabase, writes `detections`
  back via the service key. Heavier infra, no Node↔ML coupling.
- Either way the **`Detection` contract is unchanged** (`{lon,lat,strength,
  confidence,…}`), so tracker/page/alerts/backtest need no edits — swap only the
  scorer behind `detectSignatures` / the cron.

**3.4 Flare-productivity head (stretch).** Second output predicting
flare-productivity from the signature evolution (`farside_truth.flare_productive`),
so the alert can say "strong, likely flare-productive."

**Acceptance for Tier 3:** ML precision/recall, median lead time, and FAR beat
the classical baseline on the held-out AR13664 + 2026 windows — re-use the
Tier-2 backtest harness, just feed it ML detections.

---

## Tier 4 — Cross-source fusion — build plan

Confirm/deny seismic detections with the second seismic pipeline and the
direct-imaging EUV sources. A detection seen by ≥2 independent methods is far
more trustworthy than GONG alone, and EUV is *direct* (not inference).

**4.1 Ingest the cross-sources** (the cron already loops all four `SOURCES`).
- `hmi` (seismic) — same FITS path as GONG; an independent holography pipeline.
- `solo` / `stereo` (EUV) — *image* products. Detecting an AR in a far-side EUV
  image is its own CV step; start by ingesting STEREO's published far-side AR
  comparisons / EUV brightenings, then add a simple bright-region detector.

**4.2 Geometry gating for the imagers.** SolO/STEREO see only part of the far
side. Add `farside-geometry.js`: given a spacecraft heliographic longitude (from
a published/SPICE-derived ephemeris) and a target Carrington longitude at time t,
decide whether that longitude is on the craft's visible disk. Only fuse an imager
where it actually had a view — elsewhere it's "not observed," not "absent."

**4.3 Fusion rule.** Per far-side longitude bin, spatially match per-source
detections and combine with independent-evidence (noisy-OR):
`fused = 1 − Π_i (1 − w_i·conf_i)`, EUV weighted highest (direct imaging),
GONG/HMI seismic lower. Track-level output gains `sources: ['gong','hmi','euv']`
+ `fusedConfidence`.

**4.4 Cross-check metrics.** Report GONG↔HMI agreement and GONG↔EUV confirmation
rates (cf. the HMI nugget comparing helioseismic detections with STEREO EUV) — a
second validation axis alongside the NOAA-emergence backtest.

**4.5 Surface it.** Per-source provenance badges + fused confidence on each
watch-list entry and the map overlays; an EUV-confirmed far-side region is the
strongest possible operator signal.

**Acceptance for Tier 4:** every track carries source provenance + a fused
confidence; fusion measurably improves precision/FAR over GONG-only on the
Tier-2 backtest.

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
