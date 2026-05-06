#!/usr/bin/env python3
"""
hindcast_runner.py — historical-event replay for MHD density validation
=========================================================================
Replays a historical space-weather event through BATS-R-US (or against a
fixture, in dry-run mode) and emits the timeseries the density validator
needs:

  * Cross-polar-cap potential   Φ_PC   [kV]
  * Hemispheric power index     HPI    [GW]
  * MHD-derived pseudo-Ap       Ap*    [linear]

Pseudo-Ap is the Phase-1 product wedge: a continuous Ap surrogate driven
by the live MHD solution rather than the 3-hour NOAA index. The
regression that maps (Φ_PC, HPI) → Ap* is a placeholder here; Phase 0's
job is to fit it against historical Ap on the events below.

Event registry
--------------
  feb_2022_starlink   2022-02-03 → 2022-02-05  G2/G3, 38-of-49 LOC
  may_2024_gannon     2024-05-10 → 2024-05-12  G5, Ap pinned at 400
  oct_2024_x9         2024-10-03 → 2024-10-05  X9.0 flare + CME
  halloween_2003      2003-10-28 → 2003-11-01  canonical extreme storm
  quiet_2024_aug      2024-08-12 → 2024-08-14  control week (low F10.7/Ap)

Usage
-----
  # Dry-run against a checked-in fixture (no BATS-R-US required):
  python -m pipeline.hindcast_runner \\
      --event feb_2022_starlink --dry-run \\
      --fixtures swmf/fixtures/hindcast \\
      --out /tmp/hindcast_out

  # Real run (requires SWMF binaries + L1 IMF data on disk):
  python -m pipeline.hindcast_runner --event feb_2022_starlink

Output contract (one JSON file per event, written to --out):
{
  "event_id": "feb_2022_starlink",
  "window_utc": ["2022-02-03T00:00:00Z", "2022-02-05T00:00:00Z"],
  "cadence_minutes": 5,
  "samples": [
    {"t": "...", "phi_pc_kv": 78.2, "hpi_gw": 41.5, "ap_pseudo": 47.1},
    ...
  ],
  "source": "batsrus" | "fixture",
  "regression": {"version": "v0", "formula": "..."}
}
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger("swmf.hindcast_runner")


# ── Event registry ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Event:
    event_id: str
    label: str
    window_start: datetime
    window_end: datetime
    storm_class: str          # "G1".."G5", or "quiet"
    notes: str
    # Files we expect to find under <fixtures_dir>/<event_id>/ for dry-runs.
    fixture_files: tuple[str, ...] = field(default=(
        "imf_l1.dat",          # L1 IMF data — real run feeds this to PARAM.in
        "historical_ap.csv",   # NOAA Ap (3-hour) for the window
        "grace_fo_density.csv",# truth: time, alt_km, lat, lon, density_kg_m3
        "mhd_output.json",     # synthetic BATS-R-US output for dry-runs
    ))


def _utc(y: int, m: int, d: int) -> datetime:
    return datetime(y, m, d, tzinfo=timezone.utc)


EVENTS: dict[str, Event] = {
    "feb_2022_starlink": Event(
        event_id="feb_2022_starlink",
        label="Feb 2022 Starlink-4 LOC (G2/G3)",
        window_start=_utc(2022, 2, 3),
        window_end=_utc(2022, 2, 5),
        storm_class="G3",
        notes="38 of 49 Starlink satellites lost on insertion. Marketing hook.",
    ),
    "may_2024_gannon": Event(
        event_id="may_2024_gannon",
        label="May 2024 Gannon storm (G5)",
        window_start=_utc(2024, 5, 10),
        window_end=_utc(2024, 5, 12),
        storm_class="G5",
        notes="Ap pinned at 400. MSIS saturates; MHD does not.",
    ),
    "oct_2024_x9": Event(
        event_id="oct_2024_x9",
        label="Oct 2024 X9.0 flare event",
        window_start=_utc(2024, 10, 3),
        window_end=_utc(2024, 10, 5),
        storm_class="G3",
        notes="Local viz already shipped (ET&CLAUDE_SUN_MHD_NASA_X9.0_…).",
    ),
    "halloween_2003": Event(
        event_id="halloween_2003",
        label="Halloween 2003 (G5, canonical)",
        window_start=_utc(2003, 10, 28),
        window_end=_utc(2003, 11, 1),
        storm_class="G5",
        notes="Reference event in every space-weather paper.",
    ),
    "quiet_2024_aug": Event(
        event_id="quiet_2024_aug",
        label="Aug 2024 quiet control week",
        window_start=_utc(2024, 8, 12),
        window_end=_utc(2024, 8, 14),
        storm_class="quiet",
        notes="Null-result control: pseudo-Ap and real Ap should agree.",
    ),
}


# ── Pseudo-Ap regression (placeholder until Phase 0 fits real coefficients) ───
#
# Maps the MHD instantaneous magnetospheric state to a continuous Ap-like
# index. The form is intentionally simple — we want the residual analysis
# to tell us where it breaks. Coefficients here are order-of-magnitude
# estimates from Weimer-style scalings; Phase 0 replaces them with a fit.

@dataclass(frozen=True)
class PseudoApFit:
    version: str = "v0-placeholder"
    a: float = 0.0     # intercept
    b: float = 0.45    # Φ_PC weight  [Ap per kV]
    c: float = 0.55    # HPI weight   [Ap per GW]

    def __call__(self, phi_pc_kv: float, hpi_gw: float) -> float:
        ap = self.a + self.b * phi_pc_kv + self.c * hpi_gw
        # Pseudo-Ap is *not* clamped at 400; that's the whole point.
        return max(ap, 0.0)

    @property
    def formula(self) -> str:
        return f"Ap* = {self.a:+.3f} + {self.b:+.3f}·Φ_PC[kV] + {self.c:+.3f}·HPI[GW]"


# ── Fixture loader ────────────────────────────────────────────────────────────

def _load_fixture_mhd(fixture_dir: Path) -> list[dict]:
    """
    Read a synthetic BATS-R-US output JSON for dry-run mode. Each sample is:
      {"t": ISO-UTC, "phi_pc_kv": float, "hpi_gw": float}
    """
    path = fixture_dir / "mhd_output.json"
    if not path.exists():
        raise FileNotFoundError(f"missing fixture {path}")
    payload = json.loads(path.read_text())
    samples = payload.get("samples")
    if not isinstance(samples, list) or not samples:
        raise ValueError(f"fixture {path} has no samples[]")
    return samples


def _load_real_mhd(run_dir: Path,
                   *,
                   window_start: Optional[datetime] = None,
                   window_end:   Optional[datetime] = None) -> list[dict]:
    """
    Read Φ_PC and HPI from the SWMF/IE (Ridley Ionosphere) log file
    written under `run_dir`. See `parse_ie_log.py` for the format
    contract and column-name fallbacks.
    """
    from pipeline.parse_ie_log import find_ie_log, parse_ie_log
    log_path = find_ie_log(run_dir)
    return parse_ie_log(log_path,
                        start_utc=window_start,
                        end_utc=window_end)


# ── Driver ────────────────────────────────────────────────────────────────────

def replay(
    event_id: str,
    *,
    fixtures_dir: Path,
    out_dir: Path,
    dry_run: bool = True,
    fit: Optional[PseudoApFit] = None,
    run_dir: Optional[Path] = None,
) -> Path:
    """
    Replay one event and write its hindcast JSON. Returns the output path.
    """
    if event_id not in EVENTS:
        raise KeyError(f"unknown event {event_id!r}; known: {sorted(EVENTS)}")
    event = EVENTS[event_id]
    fit = fit or PseudoApFit()

    if dry_run:
        fixture_dir = fixtures_dir / event_id
        log.info("Dry-run replay of %s from %s", event_id, fixture_dir)
        raw_samples = _load_fixture_mhd(fixture_dir)
        source = "fixture"
    else:
        rd = run_dir or (Path(os.environ.get("RUNS_DIR", "/data/runs")) / event_id)
        log.info("Real replay of %s from %s", event_id, rd)
        raw_samples = _load_real_mhd(
            rd,
            window_start=event.window_start,
            window_end=event.window_end,
        )
        source = "batsrus"

    # Apply pseudo-Ap regression sample-by-sample.
    out_samples = []
    for s in raw_samples:
        phi_pc = float(s["phi_pc_kv"])
        hpi    = float(s["hpi_gw"])
        out_samples.append({
            "t":           s["t"],
            "phi_pc_kv":   phi_pc,
            "hpi_gw":      hpi,
            "ap_pseudo":   fit(phi_pc, hpi),
        })

    cadence_min = _infer_cadence_minutes(out_samples)

    payload = {
        "event_id":         event.event_id,
        "label":            event.label,
        "storm_class":      event.storm_class,
        "window_utc":       [event.window_start.isoformat().replace("+00:00", "Z"),
                             event.window_end.isoformat().replace("+00:00", "Z")],
        "cadence_minutes":  cadence_min,
        "source":           source,
        "regression":       {"version": fit.version, "formula": fit.formula},
        "samples":          out_samples,
        "generated_utc":    datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{event_id}_hindcast.json"
    out_path.write_text(json.dumps(payload, indent=2))
    log.info("Wrote %d samples → %s", len(out_samples), out_path)
    return out_path


def _infer_cadence_minutes(samples: list[dict]) -> Optional[int]:
    if len(samples) < 2:
        return None
    t0 = datetime.fromisoformat(samples[0]["t"].replace("Z", "+00:00"))
    t1 = datetime.fromisoformat(samples[1]["t"].replace("Z", "+00:00"))
    return int((t1 - t0).total_seconds() // 60)


# ── CLI ───────────────────────────────────────────────────────────────────────

def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--event", required=True, choices=sorted(EVENTS.keys()))
    p.add_argument("--dry-run", action="store_true",
                   help="Use fixture data instead of parsing a SWMF run.")
    p.add_argument("--run-dir", type=Path, default=None,
                   help="Override RUNS_DIR/<event_id> when parsing a real run.")
    p.add_argument("--fixtures", type=Path,
                   default=Path("swmf/fixtures/hindcast"),
                   help="Fixture root (one subdir per event).")
    p.add_argument("--out", type=Path, default=Path("data/hindcast"),
                   help="Where to write the per-event JSON output.")
    p.add_argument("--list", action="store_true", help="List events and exit.")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.list:
        for e in EVENTS.values():
            print(f"  {e.event_id:24s} {e.storm_class:5s}  {e.label}")
        return 0

    try:
        replay(
            args.event,
            fixtures_dir=args.fixtures,
            out_dir=args.out,
            dry_run=args.dry_run,
            run_dir=args.run_dir,
        )
    except (FileNotFoundError, NotImplementedError) as exc:
        log.error("%s", exc)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
