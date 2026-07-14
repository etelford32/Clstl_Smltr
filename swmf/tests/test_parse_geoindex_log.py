"""
Tests for swmf/pipeline/parse_geoindex_log.py — the standard §3.1 model-Dst
extraction. Covers the header/alias path, the dst-vs-dstflx preference, the
kp-optional path, windowing + decimation, the CSV writer, and the loud
failure when no Dst column exists.
Run with `python -m pytest swmf/tests/test_parse_geoindex_log.py` or directly:
`python swmf/tests/test_parse_geoindex_log.py`.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "swmf"))

from pipeline.parse_geoindex_log import (    # noqa: E402
    find_geoindex_log, parse_geoindex_log, write_model_dst_csv,
)


BANNER = "Geomagnetic indices from BATSRUS"


def _write_log(tmp: Path, header: str, rows: list[str],
               name: str = "geoindex_e20150316-120000.log") -> Path:
    d = tmp / "GM" / "IO2"
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    p.write_text("\n".join([BANNER, header, *rows]) + "\n")
    return p


def _row(year, mo, dy, hr, mn, sc, *vals) -> str:
    return " ".join(str(x) for x in (12, year, mo, dy, hr, mn, sc, 0, *vals))


HEADER = "it year mo dy hr mn sc msc Kp dst"


def test_basic_parse(tmp_path: Path):
    p = _write_log(tmp_path, HEADER, [
        _row(2015, 3, 17, 0, 0, 0,   2.3,  -12.5),
        _row(2015, 3, 17, 0, 5, 0,   2.7,  -18.0),
        _row(2015, 3, 17, 0, 10, 0,  3.0,  -25.5),
    ])
    rows = parse_geoindex_log(p, decimate_seconds=None)
    assert [r["dst_nt"] for r in rows] == [-12.5, -18.0, -25.5]
    assert rows[0]["kp"] == 2.3
    assert rows[0]["t"] == "2015-03-17T00:00:00Z"


def test_find_under_run_dir(tmp_path: Path):
    _write_log(tmp_path, HEADER, [_row(2015, 3, 17, 0, 0, 0, 2.0, -10.0)])
    assert find_geoindex_log(tmp_path).name == "geoindex_e20150316-120000.log"


def test_find_missing_mentions_geomagindices(tmp_path: Path):
    with pytest.raises(FileNotFoundError, match="GEOMAGINDICES"):
        find_geoindex_log(tmp_path)


def test_earliest_stamp_wins_on_restart(tmp_path: Path):
    """A resumed run stamps a second file; the earliest carries the full series."""
    _write_log(tmp_path, HEADER, [_row(2015, 3, 17, 0, 0, 0, 2.0, -10.0)],
               name="geoindex_e20150317-060000.log")
    _write_log(tmp_path, HEADER, [_row(2015, 3, 16, 12, 0, 0, 1.0, -3.0)],
               name="geoindex_e20150316-120000.log")
    assert find_geoindex_log(tmp_path).name == "geoindex_e20150316-120000.log"


def test_plain_dst_beats_dstflx(tmp_path: Path):
    """When a build writes both variants, plain Biot-Savart dst wins."""
    header = "it year mo dy hr mn sc msc Kp dstflx dst"
    p = _write_log(tmp_path, header, [
        _row(2015, 3, 17, 0, 0, 0, 2.3, -99.0, -12.5),
    ])
    rows = parse_geoindex_log(p, decimate_seconds=None)
    assert rows[0]["dst_nt"] == -12.5


def test_kp_optional(tmp_path: Path):
    header = "it year mo dy hr mn sc msc dst"
    p = _write_log(tmp_path, header, [_row(2015, 3, 17, 0, 0, 0, -42.0)])
    rows = parse_geoindex_log(p, decimate_seconds=None)
    assert rows[0]["dst_nt"] == -42.0
    assert rows[0]["kp"] is None


def test_window_and_decimation(tmp_path: Path):
    rows_in = [_row(2015, 3, 17, 0, m, s, 2.0, -float(m * 60 + s))
               for m in range(0, 12) for s in (0, 30)]
    p = _write_log(tmp_path, HEADER, rows_in)
    rows = parse_geoindex_log(
        p,
        start_utc=datetime(2015, 3, 17, 0, 2, tzinfo=timezone.utc),
        end_utc=datetime(2015, 3, 17, 0, 10, tzinfo=timezone.utc),
        decimate_seconds=300.0,
    )
    # Window keeps 00:02..00:09:30; decimation keeps the last row per 5-min
    # bucket (buckets anchored at the first kept sample, 00:02).
    assert [r["t"] for r in rows] == \
        ["2015-03-17T00:06:30Z", "2015-03-17T00:09:30Z"]


def test_malformed_rows_skipped(tmp_path: Path):
    p = _write_log(tmp_path, HEADER, [
        _row(2015, 3, 17, 0, 0, 0, 2.3, -12.5),
        "12 2015 3 17 0 5 0 0 2.7 not_a_number",
        _row(2015, 3, 17, 0, 10, 0, 3.0, -25.5),
    ])
    rows = parse_geoindex_log(p, decimate_seconds=None)
    assert [r["dst_nt"] for r in rows] == [-12.5, -25.5]


def test_no_dst_column_fails_loudly(tmp_path: Path):
    p = _write_log(tmp_path, "it year mo dy hr mn sc msc Kp ae", [
        _row(2015, 3, 17, 0, 0, 0, 2.3, 450.0),
    ])
    with pytest.raises(ValueError, match="Dst-like column"):
        parse_geoindex_log(p, decimate_seconds=None)


def test_aliases_json_escape_hatch(tmp_path: Path):
    p = _write_log(tmp_path, "it year mo dy hr mn sc msc Kp WeirdDstName", [
        _row(2015, 3, 17, 0, 0, 0, 2.3, -33.0),
    ])
    rows = parse_geoindex_log(
        p, decimate_seconds=None,
        extra_aliases={"dst_nt": ("weirddstname",)},
    )
    assert rows[0]["dst_nt"] == -33.0


def test_csv_writer(tmp_path: Path):
    out = tmp_path / "model_dst.csv"
    write_model_dst_csv([
        {"t": "2015-03-17T00:00:00Z", "dst_nt": -12.5, "kp": 2.3},
        {"t": "2015-03-17T00:05:00Z", "dst_nt": -18.0, "kp": None},
    ], out)
    assert out.read_text() == (
        "t,dst_nt,kp\n"
        "2015-03-17T00:00:00Z,-12.50,2.30\n"
        "2015-03-17T00:05:00Z,-18.00,\n"
    )


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
