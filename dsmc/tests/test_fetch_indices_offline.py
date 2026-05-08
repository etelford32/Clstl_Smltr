"""
Tests for dsmc/pipeline/fetch_indices_offline.py.

The backfill is the gateway between the bundled spaceweather dataset
and every downstream consumer (validate_density.py, jacchia_timeseries.py).
If its column contract drifts — t / ap / f107_sfu, ISO-Z timestamps,
3-hour cadence — every report we generate is silently broken.

Tests skip gracefully if the `spaceweather` package isn't installed,
so this file never blocks a clean checkout.

Run via `python -m pytest dsmc/tests/test_fetch_indices_offline.py` or
as a script.
"""

from __future__ import annotations

import csv
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))


def _has_spaceweather() -> bool:
    try:
        import spaceweather   # noqa: F401
        return True
    except Exception:    # noqa: BLE001
        return False


def test_backfill_returns_3h_cadence() -> None:
    if not _has_spaceweather():
        return
    from dsmc.pipeline.fetch_indices_offline import backfill
    rows = backfill("2024-05-08", "2024-05-09")
    # Two days × 8 bins = 16 rows max; allow ≤2 missing if spaceweather
    # has any partial entries.
    assert 14 <= len(rows) <= 16, f"unexpected row count: {len(rows)}"
    # Cadence: each row 3 hours after the previous one.
    for prev, curr in zip(rows, rows[1:]):
        dt = (curr["t"] - prev["t"]).total_seconds() / 3600.0
        assert abs(dt - 3.0) < 1e-6, f"non-3h gap between {prev['t']} and {curr['t']}"
    # All timestamps tz-aware UTC.
    for r in rows:
        assert r["t"].tzinfo is not None


def test_backfill_recovers_gannon_peak() -> None:
    """
    The published Apavg on 2024-05-11 is 271; the 3-hourly Ap that day
    peaked at 400 (Kp 9 → ap 400 in the standard conversion). If
    spaceweather's bundled data ever drifts away from that, the
    LSTM-justification analysis built on top of this fixture is wrong.
    """
    if not _has_spaceweather():
        return
    from dsmc.pipeline.fetch_indices_offline import backfill
    rows = backfill("2024-05-10", "2024-05-12")
    aps = [r["ap"] for r in rows]
    assert max(aps) == 400.0, (
        f"Gannon peak Ap should be 400 (Kp9o); got {max(aps)} — "
        "spaceweather dataset drift?"
    )
    f107s = [r["f107_sfu"] for r in rows]
    # F10.7 during Gannon was elevated — sanity-check it's > 200 SFU.
    assert min(f107s) > 200.0, f"unexpectedly low F10.7 during Gannon: {min(f107s)}"


def test_backfill_window_inverted_raises() -> None:
    if not _has_spaceweather():
        return
    from dsmc.pipeline.fetch_indices_offline import backfill
    try:
        backfill("2024-05-12", "2024-05-08")
    except ValueError:
        return
    raise AssertionError("expected ValueError for inverted window")


def test_write_csv_round_trips_through_load_indices() -> None:
    """
    The whole point of the offline backfill is that the CSV it writes is
    bit-compatible with the downstream loader. Round-trip through
    `load_indices_csv` and assert the contents match.
    """
    if not _has_spaceweather():
        return
    from dsmc.pipeline.fetch_indices_offline import backfill, write_csv
    from dsmc.pipeline.jacchia_timeseries import load_indices_csv
    rows = backfill("2024-05-10", "2024-05-11")
    out_path = REPO / "dsmc" / "tests" / "_tmp_indices.csv"
    try:
        write_csv(rows, out_path)
        loaded = load_indices_csv(out_path)
        assert len(loaded) == len(rows)
        for src, dst in zip(rows, loaded):
            assert src["t"] == dst.t, (src["t"], dst.t)
            assert abs(src["ap"] - dst.ap) < 1e-6
            assert abs(src["f107_sfu"] - dst.f107_sfu) < 1e-6
    finally:
        if out_path.exists():
            out_path.unlink()


def test_checked_in_fixtures_match_backfill() -> None:
    """
    The fixtures committed to dsmc/fixtures/hindcast/{gannon,halloween,
    st_patrick}/ must exactly match what the backfill would re-emit.
    If they drift (e.g. someone hand-edited a row), this test catches it.
    """
    if not _has_spaceweather():
        return
    from dsmc.pipeline.fetch_indices_offline import backfill, write_csv
    cases = [
        ("gannon_may_2024",     "2024-05-08", "2024-05-14"),
        ("halloween_oct_2003",  "2003-10-27", "2003-11-05"),
        ("st_patrick_mar_2015", "2015-03-15", "2015-03-21"),
    ]
    for event, start, end in cases:
        fixture = (REPO / "dsmc" / "fixtures" / "hindcast"
                   / event / "historical_ap.csv")
        if not fixture.exists():
            continue
        regen = REPO / "dsmc" / "tests" / f"_tmp_{event}.csv"
        try:
            rows = backfill(start, end)
            write_csv(rows, regen)
            assert fixture.read_text() == regen.read_text(), (
                f"checked-in {event} fixture differs from backfill output"
            )
        finally:
            if regen.exists():
                regen.unlink()


if __name__ == "__main__":
    fns = [v for k, v in globals().items()
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {fn.__name__}: {e}")
        except Exception as e:    # noqa: BLE001
            failed += 1
            print(f"ERROR {fn.__name__}: {e!r}")
    sys.exit(0 if failed == 0 else 1)
