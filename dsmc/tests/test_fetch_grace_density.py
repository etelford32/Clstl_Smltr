"""
Tests for the TU Delft GRACE-FO v02 parsing + decimation added to
fetch_grace_density.py. Run with pytest or directly:
`python dsmc/tests/test_fetch_grace_density.py`.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "dsmc"))

from pipeline.fetch_grace_density import (  # noqa: E402
    _parse_record, _decimate_records,
)

# TU Delft v02 column order: date time sys alt(m) lon lat lst arglat dens dens_mean flag flag
V02_COLS = ("date", "time", "_", "alt_m", "lon_deg", "lat_deg",
            "_", "_", "density_kg_m3")


def test_v02_row_parsing():
    line = ("2024-05-11 09:25:00.000 GPS 487123.456 83.693 -68.358 "
            "5.623 291.665 0.74580000E-11 0.85135775E-12 0.0 0.0")
    r = _parse_record(line, V02_COLS)
    assert r is not None
    assert r["t"] == datetime(2024, 5, 11, 9, 25, 0, tzinfo=timezone.utc)
    assert abs(r["alt_km"] - 487.123456) < 1e-6        # metres → km
    assert r["lat_deg"] == -68.358
    assert r["lon_deg"] == 83.693
    assert abs(r["density_kg_m3"] - 7.458e-12) < 1e-15  # column 9, not the mean
    assert "alt_m" not in r and "_" not in r


def test_v02_short_line_rejected():
    assert _parse_record("2024-05-11 09:25:00.000 GPS", V02_COLS) is None


def test_decimate_first_per_bucket():
    recs = [{"t": datetime(2024, 5, 11, 9, 0, s, tzinfo=timezone.utc)}
            for s in (0, 10, 20, 30, 40, 50)]   # 10 s cadence
    out = _decimate_records(recs, 30.0)
    assert [r["t"].second for r in out] == [0, 30]   # one per 30 s bucket


if __name__ == "__main__":
    import traceback
    failed = 0
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        try:
            fn()
            print(f"  ok   {fn.__name__}")
        except Exception:
            failed += 1
            print(f"  FAIL {fn.__name__}")
            traceback.print_exc()
    if failed:
        sys.exit(1)
    print(f"\n{len(tests)} passed")
