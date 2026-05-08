#!/usr/bin/env python3
"""
synthesize_extreme.py — synthetic extreme-event fixture generator
==================================================================
Produces synthetic Ap/F10.7 timeseries by scaling real sharp-onset
templates by published Carrington / Miyake / Quebec-class magnitude
factors. Output is a fixture in the same `t,ap,f107_sfu` 3-hourly CSV
contract that the rest of the pipeline consumes, plus a sibling
`provenance.json` documenting exactly what was scaled and why.

Critical disclaimer
-------------------
**These fixtures are stress-test inputs only.** They MUST NOT be used
to train the residual predictor. Two reasons:

  1. The "ground truth" we'd train against — NRLMSISE-00 — was itself
     calibrated on the modern instrumental record. At F10.7 ≥ 400 SFU
     or sustained Ap = 400, MSIS is extrapolating; we have no
     independent reference to call its output "right."

  2. The cosmogenic-isotope record (¹⁰Be in ice cores, ¹⁴C in tree
     rings, ³⁶Cl) tells us that extreme solar events occur and gives
     us their integrated fluence and recurrence — but at *annual*
     resolution at best. Reconstructing 3-hourly Ap from a yearly
     ¹⁰Be signal is ill-posed; the storm is averaged out.

What synthetic fixtures *are* good for: probing the trained predictor's
structural behaviour at out-of-distribution inputs — does the predicted
correction stay monotonic in Ap? bounded? smooth in F10.7? See
`dsmc.pipeline.ml.stress_test`.

Calibration sources
-------------------
* **Carrington 1859**:
  Tsurutani et al. (2003) JGR 108(A7), 1268 — peak Dst ≈ −1760 nT.
  Cliver & Dietrich (2013) JSWSC 3, A31 — review estimates Dst ≈
  −1100 to −1700 nT, ~3-4× the Halloween 2003 peak. We adopt a
  "duration extension at saturated Ap + 1.5× F10.7 boost" as a
  pragmatic translation of those numbers into 3-hourly indices that
  saturate.

* **Miyake 774-775 AD** (and 993-994 AD):
  Miyake et al. (2012) Nature 486, 240 — original ¹⁴C discovery.
  Mekhaldi et al. (2015) Nature Communications 6, 8611 — confirms
  multi-reservoir (¹⁴C + ¹⁰Be + ³⁶Cl) origin and estimates fluence
  ≈ 10× the August 1972 SEP event. We model this as a prolonged
  high-F10.7 plateau with saturated Ap.

* **March 1989 Quebec blackout**:
  Allen et al. (1989) EOS 70, 1479 — peak Dst ≈ −589 nT.
  Boteler (2019) Space Weather 17, 1427 — modern review.
  Calibrated against Gannon 2024 with Ap unchanged, F10.7 × 1.5
  to probe sensitivity to a higher solar flux baseline.

Recurrence frequency (for the distribution-shift detector that may be
built later): Schrijver et al. (2012) JGR 117, A08103 estimates
Carrington-class events at roughly 1-in-100 to 1-in-200 yr; Miyake-
class events at roughly 1-in-1000 yr.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import sys
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Sequence


log = logging.getLogger("dsmc.synthesize_extreme")


# Standard ap-table maximum (corresponds to Kp 9o). Anything above this
# is clamped — that's the index's design, not a software limit.
AP_TABLE_MAX = 400.0


# F10.7 saturation: the GOES-recorded peak during the 2003-11-04 X28+
# flare was 561 SFU (Halloween fixture max). We allow synthetic values
# above that but flag it in provenance — the predictor's training
# distribution stops at 315 SFU (Bastille 2000 max) so anything ≥ 400
# is OOD by construction.
TRAINING_F107_MAX = 315.0


@dataclass
class ScaleSpec:
    """One synthetic-event recipe."""
    synth_id: str
    template_event: str       # event id of the real fixture to scale
    ap_factor: float = 1.0
    f107_factor: float = 1.0
    extend_storm_3h_bins: int = 0
    """How many extra 3-h bins to insert at the storm peak before decay
    starts. Models the longer duration of Carrington-class disturbances
    relative to the modern reference event."""
    storm_threshold_ap: float = 80.0
    """Ap value above which a row is considered 'storm-time' for the
    duration-extension feature."""
    cap_ap: float = AP_TABLE_MAX
    cap_f107: float = 1000.0
    description: str = ""
    citations: list[str] = field(default_factory=list)


# Curated stress-test scenarios. Add new ones here; do NOT change an
# existing recipe in place — retraining downstream stress reports on
# the same `synth_id` would silently produce different numbers.
PRESETS: dict[str, ScaleSpec] = {
    "synth_carrington_class_from_halloween": ScaleSpec(
        synth_id="synth_carrington_class_from_halloween",
        template_event="halloween_oct_2003",
        ap_factor=1.0,                 # already saturated at 400; can't go higher
        f107_factor=1.5,               # push 561 → ~840 SFU (extreme flare-day F10.7)
        extend_storm_3h_bins=8,        # +24 h of saturated-Ap plateau
        description=(
            "Carrington-class extreme: Halloween 2003 with the saturated-Ap "
            "plateau extended by 24 h and F10.7 multiplied by 1.5 to model "
            "an X40+ class flare-day flux. Tsurutani+2003 estimate Dst ≈ "
            "-1760 nT for 1859, ≈ 4× Halloween's -422 nT; in 3-hourly indices "
            "that translates to longer dwell at Ap_saturation rather than a "
            "higher peak (Ap maxes at 400 by construction)."
        ),
        citations=[
            "Tsurutani et al. (2003), JGR 108(A7), 1268",
            "Cliver & Dietrich (2013), JSWSC 3, A31",
            "Schrijver et al. (2012), JGR 117, A08103",
        ],
    ),
    "synth_miyake_event_from_bastille": ScaleSpec(
        synth_id="synth_miyake_event_from_bastille",
        template_event="bastille_jul_2000",
        ap_factor=1.0,                 # geomagnetic component already 400-saturated
        f107_factor=2.0,               # 315 → 630 SFU; prolonged elevated SEP env
        extend_storm_3h_bins=16,       # +48 h plateau (Miyake events were prolonged)
        description=(
            "AD 774-775 Miyake-class event modelled by stretching Bastille "
            "Day 2000 (the cycle-23 max event with the highest training F10.7 "
            "we have at 315 SFU) to a 48-h saturated plateau with 2× F10.7. "
            "Mekhaldi+2015 estimates 774 AD fluence ≈ 10× August 1972; "
            "the prolonged plateau models that integrated dose, not the "
            "instantaneous peak (which 3-h indices cannot resolve)."
        ),
        citations=[
            "Miyake et al. (2012), Nature 486, 240",
            "Mekhaldi et al. (2015), Nat. Commun. 6, 8611",
            "Schrijver et al. (2012), JGR 117, A08103",
        ],
    ),
    "synth_quebec_1989_amplified_from_gannon": ScaleSpec(
        synth_id="synth_quebec_1989_amplified_from_gannon",
        template_event="gannon_may_2024",
        ap_factor=1.0,
        f107_factor=1.5,               # ~225 → ~338 SFU; pushes just past training max
        extend_storm_3h_bins=4,
        description=(
            "March 1989 Quebec-class amplifier on Gannon May 2024. Gannon's "
            "geomagnetic profile is closest to 1989's in modern records; we "
            "leave Ap untouched and lift F10.7 by 1.5× to probe how the "
            "predictor handles a flux just past the training maximum."
        ),
        citations=[
            "Allen et al. (1989), EOS 70, 1479",
            "Boteler (2019), Space Weather 17, 1427",
        ],
    ),
    "synth_pure_f107_ramp": ScaleSpec(
        synth_id="synth_pure_f107_ramp",
        template_event="solar_min_dec_2019",
        ap_factor=1.0,
        f107_factor=10.0,              # 70 → 700 SFU (pure F10.7 sweep, geomag quiet)
        extend_storm_3h_bins=0,
        description=(
            "Pure-F10.7 stress sweep: solar-min 2019 (Ap ≤ 12) with F10.7 "
            "multiplied by 10× to reach 700 SFU. Decouples the F10.7 axis "
            "from the Ap axis so the stress report can isolate the "
            "predictor's F10.7-sensitivity from its storm-coupling response."
        ),
        citations=[
            "(synthetic — for monotonicity / smoothness probing only)",
        ],
    ),
}


# ─── Generator ──────────────────────────────────────────────────────────────

@dataclass
class IndexRow:
    t: datetime
    ap: float
    f107_sfu: float


def _load_template(template_path: Path) -> list[IndexRow]:
    rows: list[IndexRow] = []
    with template_path.open() as fh:
        reader = csv.DictReader(fh)
        for r in reader:
            rows.append(IndexRow(
                t=datetime.fromisoformat(r["t"].replace("Z", "+00:00")),
                ap=float(r["ap"]),
                f107_sfu=float(r["f107_sfu"]),
            ))
    rows.sort(key=lambda r: r.t)
    return rows


def synthesize(spec: ScaleSpec, *, fixtures_dir: Path) -> tuple[list[IndexRow], dict]:
    """
    Produce the synthetic timeseries + provenance dict from a spec.
    The output time axis is shifted to start at 1900-01-01 UTC so the
    fixture is unambiguously not a real-event timestamp — anyone
    grepping for the date will land in a clearly synthetic range.
    """
    template_path = fixtures_dir / spec.template_event / "historical_ap.csv"
    if not template_path.exists():
        raise FileNotFoundError(
            f"template fixture {spec.template_event} not found at {template_path}"
        )
    template = _load_template(template_path)

    # 1. Apply the simple multiplicative scalings, with caps.
    scaled: list[IndexRow] = []
    for r in template:
        scaled.append(IndexRow(
            t=r.t,
            ap=min(r.ap * spec.ap_factor, spec.cap_ap),
            f107_sfu=min(r.f107_sfu * spec.f107_factor, spec.cap_f107),
        ))

    # 2. Apply the storm-duration extension. We find the longest
    #    contiguous run of `ap > storm_threshold_ap` and insert the
    #    requested number of 3-h bins at that run's *peak* index,
    #    each carrying the peak's (ap, F10.7). Time stamps in the
    #    suffix shift by the extension so cadence stays 3-h.
    if spec.extend_storm_3h_bins > 0 and scaled:
        peak_idx = max(range(len(scaled)), key=lambda i: scaled[i].ap)
        peak_row = scaled[peak_idx]
        # Insert `extend_storm_3h_bins` clones of the peak right after it.
        from datetime import timedelta
        inserted: list[IndexRow] = []
        for k in range(spec.extend_storm_3h_bins):
            inserted.append(IndexRow(
                t=peak_row.t + timedelta(hours=3 * (k + 1)),
                ap=peak_row.ap,
                f107_sfu=peak_row.f107_sfu,
            ))
        # Shift the post-peak tail forward by `extend_storm_3h_bins * 3h`
        # so the cadence remains uniform.
        shift_hours = 3 * spec.extend_storm_3h_bins
        tail = [
            IndexRow(t=r.t + timedelta(hours=shift_hours),
                     ap=r.ap, f107_sfu=r.f107_sfu)
            for r in scaled[peak_idx + 1:]
        ]
        scaled = scaled[: peak_idx + 1] + inserted + tail

    # 3. Reanchor the timestamp axis to 1900-01-01 so it can never be
    #    confused with a real event.
    if scaled:
        from datetime import timedelta
        anchor = datetime(1900, 1, 1, tzinfo=timezone.utc)
        delta = anchor - scaled[0].t.replace(tzinfo=timezone.utc)
        scaled = [
            IndexRow(t=r.t + delta, ap=r.ap, f107_sfu=r.f107_sfu)
            for r in scaled
        ]

    provenance = {
        "synth_id": spec.synth_id,
        "template_event": spec.template_event,
        "template_path": str(template_path),
        "scaling": {
            "ap_factor": spec.ap_factor,
            "f107_factor": spec.f107_factor,
            "extend_storm_3h_bins": spec.extend_storm_3h_bins,
            "storm_threshold_ap": spec.storm_threshold_ap,
            "cap_ap": spec.cap_ap,
            "cap_f107": spec.cap_f107,
        },
        "description": spec.description,
        "citations": list(spec.citations),
        "post_scale_summary": {
            "n_rows":       len(scaled),
            "ap_min":       min(r.ap for r in scaled) if scaled else None,
            "ap_max":       max(r.ap for r in scaled) if scaled else None,
            "f107_min":     min(r.f107_sfu for r in scaled) if scaled else None,
            "f107_max":     max(r.f107_sfu for r in scaled) if scaled else None,
        },
        "warnings": _provenance_warnings(spec, scaled),
        "generated_at_utc": datetime.now(timezone.utc).isoformat()
                             .replace("+00:00", "Z"),
        "do_not_train_on_this_fixture": True,
    }
    return scaled, provenance


def _provenance_warnings(spec: ScaleSpec, scaled: list[IndexRow]) -> list[str]:
    warnings: list[str] = []
    if any(r.ap >= AP_TABLE_MAX for r in scaled):
        warnings.append(
            "Ap saturation: rows reach the 400 ceiling; the index does "
            "not resolve magnitude beyond that point."
        )
    f107_max = max((r.f107_sfu for r in scaled), default=0.0)
    if f107_max > TRAINING_F107_MAX:
        warnings.append(
            f"F10.7 = {f107_max:.0f} SFU exceeds the predictor's training "
            f"maximum of {TRAINING_F107_MAX:.0f} SFU; predictions here are "
            "extrapolations and must be checked for monotonicity / "
            "smoothness only, not accuracy."
        )
    return warnings


# ─── I/O ────────────────────────────────────────────────────────────────────

def write_fixture(rows: list[IndexRow], provenance: dict, *,
                  out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / "historical_ap.csv"
    json_path = out_dir / "provenance.json"
    with csv_path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["t", "ap", "f107_sfu"])
        for r in rows:
            w.writerow([
                r.t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                f"{r.ap:.1f}",
                f"{r.f107_sfu:.1f}",
            ])
    json_path.write_text(json.dumps(provenance, indent=2))
    return csv_path, json_path


# ─── CLI ────────────────────────────────────────────────────────────────────

def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--preset", choices=sorted(PRESETS.keys()),
                   help="Generate one preset by id.")
    p.add_argument("--all-presets", action="store_true",
                   help="Generate every curated preset.")
    p.add_argument("--fixtures-dir", type=Path,
                   default=Path("dsmc/fixtures/hindcast"))
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if not args.preset and not args.all_presets:
        print("error: pass --preset <id> or --all-presets",
              file=sys.stderr)
        return 1
    targets = (sorted(PRESETS.keys()) if args.all_presets else [args.preset])
    for synth_id in targets:
        spec = PRESETS[synth_id]
        rows, prov = synthesize(spec, fixtures_dir=args.fixtures_dir)
        out_dir = args.fixtures_dir / synth_id
        csv_path, json_path = write_fixture(rows, prov, out_dir=out_dir)
        log.info(
            "Wrote %s (%d rows, Ap %.0f..%.0f, F10.7 %.0f..%.0f) "
            "+ %s",
            csv_path, len(rows),
            prov["post_scale_summary"]["ap_min"] or 0,
            prov["post_scale_summary"]["ap_max"] or 0,
            prov["post_scale_summary"]["f107_min"] or 0,
            prov["post_scale_summary"]["f107_max"] or 0,
            json_path,
        )
        for w in prov["warnings"]:
            log.info("  ⚠ %s", w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
