"""
Tests for dsmc/pipeline/import_ground_mag.py.

The shim canonicalises whatever shape a ground-magnetometer
reconstruction lands in to the schema the Phase-0 runbook expects:

    t, sme_nt, smu_nt, sml_nt, h_comp_mean_nt, jh_proxy_gw

Two contracts the regression downstream cares about and that we lock
in here:
  1. The output is on a strict 1-minute grid in [start, end].
  2. The Joule-heating proxy is monotone in SME (the regression treats
     it as a coupling-strength feature; non-monotonicity would silently
     ruin its sign convention).

Run: `python -m pytest dsmc/tests/test_import_ground_mag.py`
"""

from __future__ import annotations

import csv
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))

from dsmc.pipeline.import_ground_mag import (  # noqa: E402
    CANONICAL_HEADER,
    RawRow,
    _jh_proxy,
    _parse_columns_arg,
    _parse_time,
    _read_csv,
    canonicalise,
    write_canonical,
)


def _iso(s: str) -> datetime:
    return _parse_time(s)


# ── unit: time parsing ─────────────────────────────────────────────

def test_parse_time_z_suffix():
    t = _parse_time("2024-05-10T12:00:00Z")
    assert t == datetime(2024, 5, 10, 12, tzinfo=timezone.utc)


def test_parse_time_epoch_float():
    t = _parse_time(1_715_342_400.0)
    assert t.tzinfo is not None
    assert t.year == 2024


# ── unit: Joule proxy monotonicity & sanity ────────────────────────

def test_jh_proxy_monotone_knipp():
    sample = [0, 50, 200, 800, 2000, 4000, 6000]
    values = [_jh_proxy(s, "knipp") for s in sample]
    # strictly increasing
    assert all(b > a for a, b in zip(values, values[1:]))
    # at storm peak ~4000 nT the proxy should be >~ 600 GW
    assert values[-2] > 600


def test_jh_proxy_monotone_ahn():
    sample = [0, 100, 1000, 3000]
    values = [_jh_proxy(s, "ahn") for s in sample]
    assert values == sorted(values)
    # ahn is linear by construction
    assert abs(values[2] / values[1] - 10) < 1e-9


def test_jh_proxy_none_returns_none():
    assert _jh_proxy(500, "none") is None


def test_jh_proxy_negative_sme_clamped():
    # SuperMAG can dip slightly negative at quiet times due to baseline
    # subtraction; treat as zero, never as negative power.
    assert _jh_proxy(-12.0, "knipp") == 0.0


# ── unit: column-spec parsing ──────────────────────────────────────

def test_parse_columns_positional():
    assert _parse_columns_arg("t,sme,smu,sml") == {
        "t": "t", "sme": "sme", "smu": "smu", "sml": "sml",
    }


def test_parse_columns_rename():
    m = _parse_columns_arg("time_utc:t,sme_idx:sme")
    assert m == {"time_utc": "t", "sme_idx": "sme"}


# ── integration: CSV in, canonical CSV out ─────────────────────────

CSV_WITH_HEADER = """time,sme,smu,sml
2024-05-10T12:00:00Z,150,80,-70
2024-05-10T12:02:00Z,1700,900,-800
2024-05-10T12:04:00Z,3800,1900,-1900
2024-05-10T12:06:00Z,2400,1200,-1200
"""


def test_read_csv_and_canonicalise(tmp_path: Path):
    src = tmp_path / "raw.csv"
    src.write_text(CSV_WITH_HEADER)
    rows = _read_csv(src, override=None)
    assert len(rows) == 4
    assert rows[0].sme_nt == 150.0
    assert rows[2].smu_nt == 1900.0

    canon = canonicalise(
        rows,
        start=_iso("2024-05-10T12:00:00Z"),
        end=_iso("2024-05-10T12:06:00Z"),
        proxy_kind="knipp",
    )
    # 1-min grid, 7 samples (12:00 through 12:06 inclusive)
    assert len(canon) == 7
    times = [r.t.strftime("%H:%M") for r in canon]
    assert times == ["12:00", "12:01", "12:02", "12:03", "12:04", "12:05", "12:06"]
    # endpoints exact, interior interpolated
    assert canon[0].sme_nt == 150.0
    assert canon[6].sme_nt == 2400.0
    # interpolation halfway between 150 and 1700 → 925
    assert abs(canon[1].sme_nt - 925.0) < 1e-6
    # proxy strictly positive when SME > 0
    for r in canon:
        assert r.jh_proxy_gw is not None and r.jh_proxy_gw > 0


def test_write_canonical_round_trip(tmp_path: Path):
    src = tmp_path / "raw.csv"
    src.write_text(CSV_WITH_HEADER)
    rows = _read_csv(src, override=None)
    canon = canonicalise(
        rows,
        start=_iso("2024-05-10T12:00:00Z"),
        end=_iso("2024-05-10T12:06:00Z"),
        proxy_kind="knipp",
    )
    out = tmp_path / "canonical.csv"
    write_canonical(out, canon)
    rd = csv.reader(out.open())
    header = next(rd)
    assert header == CANONICAL_HEADER
    rows_out = list(rd)
    assert len(rows_out) == 7
    # Timestamp format is the runbook contract — ISO-Z, second precision.
    assert rows_out[0][0] == "2024-05-10T12:00:00Z"


# ── derive SME = SMU - SML when SME missing ────────────────────────

def test_sme_derived_when_missing(tmp_path: Path):
    src = tmp_path / "raw.csv"
    src.write_text(
        "time,smu,sml\n"
        "2024-05-10T12:00:00Z,1000,-2000\n"
        "2024-05-10T12:02:00Z,1500,-2500\n"
    )
    rows = _read_csv(src, override=None)
    assert rows[0].sme_nt is None
    canon = canonicalise(
        rows,
        start=_iso("2024-05-10T12:00:00Z"),
        end=_iso("2024-05-10T12:02:00Z"),
        proxy_kind="knipp",
    )
    # Derived SME = SMU - SML = 1000 - (-2000) = 3000 at t=0
    assert abs(canon[0].sme_nt - 3000.0) < 1e-6
    assert abs(canon[2].sme_nt - 4000.0) < 1e-6


# ── JSON input path ────────────────────────────────────────────────

def test_json_input(tmp_path: Path):
    src = tmp_path / "raw.json"
    src.write_text(json.dumps([
        {"time": "2024-05-10T12:00:00Z", "sme": 100, "smu": 50, "sml": -50},
        {"time": "2024-05-10T12:05:00Z", "sme": 3500, "smu": 1700, "sml": -1800},
    ]))
    # canonicalise() is the pure-API entry point; we go through the
    # module's reader explicitly via the CLI in real runs, but for the
    # unit test we exercise canonicalise + the JSON reader together.
    from dsmc.pipeline.import_ground_mag import _read_json
    rows = _read_json(src)
    canon = canonicalise(
        rows,
        start=_iso("2024-05-10T12:00:00Z"),
        end=_iso("2024-05-10T12:05:00Z"),
        proxy_kind="knipp",
    )
    assert len(canon) == 6
    assert canon[0].sme_nt == 100.0
    assert canon[5].sme_nt == 3500.0


if __name__ == "__main__":
    # Allow running as a plain script for the quick-feedback case.
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
