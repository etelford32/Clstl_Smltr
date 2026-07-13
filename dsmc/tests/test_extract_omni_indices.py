"""
Tests for dsmc/pipeline/extract_omni_indices.py — OMNI HRO 1-min column
extraction, sentinel handling, the AE ≈ AU − AL column-order gate, the
window filter, and the end-to-end chain into import_ground_mag.

Run with `python -m pytest dsmc/tests/test_extract_omni_indices.py` or
directly: `python3 dsmc/tests/test_extract_omni_indices.py` (no pytest
needed for the direct path).
"""

from __future__ import annotations

import csv
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))

from dsmc.pipeline.extract_omni_indices import (  # noqa: E402
    COL_AE, COL_AL, COL_AU, COL_PC_N, COL_SYM_H,
    check_consistency, extract, main,
)

T0 = datetime(2015, 3, 17, 0, 0, tzinfo=timezone.utc)


def _asc_line(t: datetime, *, ae: float, al: float, au: float,
              sym_h: float, pc: float = 1.5) -> str:
    """One synthetic HRO 1-min row: 46 words, real values at the documented
    indices, benign filler elsewhere."""
    cols = ["0.0"] * 46
    doy = (t - datetime(t.year, 1, 1, tzinfo=timezone.utc)).days + 1
    cols[0], cols[1] = str(t.year), str(doy)
    cols[2], cols[3] = str(t.hour), str(t.minute)
    cols[COL_AE] = f"{ae:g}"
    cols[COL_AL] = f"{al:g}"
    cols[COL_AU] = f"{au:g}"
    cols[COL_SYM_H] = f"{sym_h:g}"
    cols[COL_PC_N] = f"{pc:g}"
    return " ".join(cols)


def _write_asc(tmp: Path, lines: list[str]) -> Path:
    p = tmp / "omni_min_test.asc"
    p.write_text("\n".join(lines) + "\n")
    return p


def _storm_lines(n_minutes: int = 60) -> list[str]:
    """A consistent synthetic storm: AL digs to −800, AU to +200,
    AE = AU − AL exactly, SYM-H bottoms at −234 at minute 30."""
    lines = []
    for m in range(n_minutes):
        t = T0 + timedelta(minutes=m)
        al = -800.0 * min(m, 30) / 30.0
        au = 200.0 * min(m, 30) / 30.0
        sym = -234.0 * (1.0 - abs(m - 30) / 30.0)
        lines.append(_asc_line(t, ae=au - al, al=al, au=au, sym_h=sym))
    return lines


def test_extraction_and_window(tmp_path: Path):
    asc = _write_asc(tmp_path, _storm_lines(60))
    rows, stats = extract(asc, T0 + timedelta(minutes=10),
                          T0 + timedelta(minutes=20))
    assert len(rows) == 11            # end-inclusive
    assert stats["dropped_fill"] == 0
    assert rows[0]["t"] == T0 + timedelta(minutes=10)
    assert rows[0]["al"] < 0 and rows[0]["au"] > 0


def test_sentinels_dropped(tmp_path: Path):
    lines = _storm_lines(10)
    bad = _asc_line(T0 + timedelta(minutes=10), ae=99999, al=-100,
                    au=50, sym_h=-40)
    asc = _write_asc(tmp_path, lines + [bad])
    rows, stats = extract(asc, T0, T0 + timedelta(minutes=10))
    assert stats["dropped_fill"] == 1
    assert all(r["t"] != T0 + timedelta(minutes=10) for r in rows)


def test_consistency_gate_catches_swapped_al_au(tmp_path: Path):
    # Swap AL and AU: AU − AL flips sign, AE identity breaks on every row.
    lines = []
    for m in range(20):
        t = T0 + timedelta(minutes=m)
        lines.append(_asc_line(t, ae=1000.0, al=200.0, au=-800.0,
                               sym_h=-100.0))
    asc = _write_asc(tmp_path, lines)
    rows, _ = extract(asc, T0, T0 + timedelta(minutes=19))
    ok, msg = check_consistency(rows)
    assert not ok
    assert "misparsed" in msg


def test_consistency_gate_passes_good_data(tmp_path: Path):
    asc = _write_asc(tmp_path, _storm_lines(30))
    rows, _ = extract(asc, T0, T0 + timedelta(minutes=29))
    ok, _ = check_consistency(rows)
    assert ok


def test_cli_writes_csv_and_pc(tmp_path: Path):
    asc = _write_asc(tmp_path, _storm_lines(60))
    out = tmp_path / "indices.csv"
    pc_out = tmp_path / "pc.csv"
    rc = main(["--in", str(asc),
               "--start", "2015-03-17T00:00:00Z",
               "--end", "2015-03-17T00:59:00Z",
               "--out", str(out), "--pc-out", str(pc_out)])
    assert rc == 0
    with out.open() as fh:
        rows = list(csv.DictReader(fh))
    assert list(rows[0].keys()) == ["t", "ae", "au", "al", "h"]
    assert len(rows) == 60
    sym_min = min(float(r["h"]) for r in rows)
    assert sym_min == -234.0          # the runbook fingerprint
    with pc_out.open() as fh:
        pc_rows = list(csv.DictReader(fh))
    assert len(pc_rows) == 60 and float(pc_rows[0]["pc_n"]) == 1.5


def test_cli_refuses_inconsistent_columns(tmp_path: Path):
    lines = [_asc_line(T0 + timedelta(minutes=m), ae=1000.0, al=200.0,
                       au=-800.0, sym_h=-50.0) for m in range(20)]
    asc = _write_asc(tmp_path, lines)
    rc = main(["--in", str(asc),
               "--start", "2015-03-17T00:00:00Z",
               "--end", "2015-03-17T00:19:00Z",
               "--out", str(tmp_path / "x.csv")])
    assert rc == 1
    assert not (tmp_path / "x.csv").exists()   # gate fires before any write


def test_chain_into_import_ground_mag(tmp_path: Path):
    """End-to-end: .asc → extractor CSV → import_ground_mag canonical
    fixture, with AE landing in sme_nt and SYM-H in h_comp_mean_nt."""
    from dsmc.pipeline.import_ground_mag import _main as ground_mag_main

    asc = _write_asc(tmp_path, _storm_lines(60))
    indices = tmp_path / "indices.csv"
    assert main(["--in", str(asc),
                 "--start", "2015-03-17T00:00:00Z",
                 "--end", "2015-03-17T00:59:00Z",
                 "--out", str(indices)]) == 0

    canonical = tmp_path / "ground_mag.csv"
    assert ground_mag_main(["--in", str(indices),
                            "--out", str(canonical),
                            "--start", "2015-03-17T00:00:00Z",
                            "--end", "2015-03-17T00:59:00Z"]) == 0

    with canonical.open() as fh:
        rows = [r for r in csv.DictReader(fh) if not r["t"].startswith("#")]
    assert rows, "canonical fixture is empty"
    sme = [float(r["sme_nt"]) for r in rows if r["sme_nt"]]
    h = [float(r["h_comp_mean_nt"]) for r in rows if r["h_comp_mean_nt"]]
    assert max(sme) == 1000.0         # AE peak carried through as SME
    assert min(h) == -234.0           # SYM-H min carried through
    jh = [float(r["jh_proxy_gw"]) for r in rows if r["jh_proxy_gw"]]
    assert jh and max(jh) > 0         # Joule proxy synthesized


if __name__ == "__main__":
    import tempfile, traceback
    failed = 0
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        with tempfile.TemporaryDirectory() as td:
            try:
                fn(Path(td))
                print(f"  ok   {fn.__name__}")
            except Exception:
                failed += 1
                print(f"  FAIL {fn.__name__}")
                traceback.print_exc()
    if failed:
        sys.exit(1)
    print(f"\n{len(tests)} passed")
