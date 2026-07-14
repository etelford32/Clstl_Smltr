"""
Tests for dsmc/pipeline/import_pc_index.py — the CPCP reference builder
(standard §3 cpcp_bias_pct input). Covers the OMNI ASCII path (column 45,
DOY time decode, fill dropping), the CSV path, the Ridley & Kihn (2004)
conversion, windowing, and bucket-mean downsampling.
Run with `python -m pytest dsmc/tests/test_import_pc_index.py` or directly:
`python dsmc/tests/test_import_pc_index.py`.
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))

from dsmc.pipeline.import_pc_index import (    # noqa: E402
    COL_PCN, build_reference, pc_to_phi_kv, _read_csv, _read_omni_ascii,
)


def _omni_line(year: int, doy: int, hr: int, mn: int, pc: float) -> str:
    """Fabricate an OMNI HRO 1-min row: only the columns we read are real."""
    tokens = ["0.0"] * (COL_PCN + 2)
    tokens[0], tokens[1] = str(year), str(doy)
    tokens[2], tokens[3] = str(hr), str(mn)
    tokens[COL_PCN] = f"{pc:.2f}"
    return " ".join(tokens)


def test_pc_to_phi_ridley_kihn_march():
    """March (month 3): T = π/2; Φ = 29.28 − 3.31·sin(π/2 + 1.49) + 17.81·PC."""
    expected = 29.28 - 3.31 * math.sin(2 * math.pi * 3 / 12 + 1.49) + 17.81 * 5.0
    assert pc_to_phi_kv(5.0, 3) == pytest.approx(expected)
    # Quiet PC ≈ 0 sits near the ~29 kV baseline.
    assert pc_to_phi_kv(0.0, 3) == pytest.approx(29.01, abs=0.05)


def test_read_omni_ascii_time_and_fill(tmp_path: Path):
    p = tmp_path / "omni_min201503.asc"
    p.write_text("\n".join([
        _omni_line(2015, 76, 12, 0, 1.25),     # DOY 76 = 2015-03-17
        _omni_line(2015, 76, 12, 1, 999.99),   # fill — dropped
        _omni_line(2015, 76, 12, 2, 2.50),
        "short line that is ignored",
    ]) + "\n")
    rows = _read_omni_ascii(p)
    assert len(rows) == 2
    assert rows[0][0] == datetime(2015, 3, 17, 12, 0, tzinfo=timezone.utc)
    assert rows[0][1] == 1.25
    assert rows[1][1] == 2.50


def test_read_csv_alias_and_fill(tmp_path: Path):
    p = tmp_path / "pc.csv"
    p.write_text(
        "t,PCN\n"
        "2015-03-17T12:00:00Z,1.25\n"
        "2015-03-17T12:01:00Z,999.99\n"
        "2015-03-17T12:02:00Z,2.50\n"
    )
    rows = _read_csv(p)
    assert [pc for _, pc in rows] == [1.25, 2.50]


def test_read_csv_requires_pc_column(tmp_path: Path):
    p = tmp_path / "pc.csv"
    p.write_text("t,phi\n2015-03-17T12:00:00Z,100\n")
    with pytest.raises(ValueError, match="no PC column"):
        _read_csv(p)


def test_build_reference_window_and_bucket_mean():
    t = lambda mn: datetime(2015, 3, 17, 12, mn, tzinfo=timezone.utc)
    rows = [(t(m), float(m)) for m in range(0, 12)]    # PC = minute index
    ref = build_reference(
        rows,
        start_utc=t(0),
        end_utc=t(10),                                  # keeps minutes 0..9
        step_seconds=300.0,
    )
    # Two 5-min buckets: means of 0..4 (=2.0) and 5..9 (=7.0).
    assert [r["pc_n"] for r in ref] == [2.0, 7.0]
    assert ref[0]["t"] == "2015-03-17T12:00:00Z"
    assert ref[1]["t"] == "2015-03-17T12:05:00Z"
    assert ref[0]["phi_pc_kv"] == pytest.approx(pc_to_phi_kv(2.0, 3), abs=0.01)


def test_build_reference_empty_window_fails():
    rows = [(datetime(2015, 3, 17, tzinfo=timezone.utc), 1.0)]
    with pytest.raises(RuntimeError, match="no PC"):
        build_reference(rows,
                        start_utc=datetime(2016, 1, 1, tzinfo=timezone.utc),
                        end_utc=None)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
