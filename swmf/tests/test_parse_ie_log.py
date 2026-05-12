"""
Smoke tests for swmf/pipeline/parse_ie_log.py — covers the alias path,
the substring-inference path, and the difflib-suggestion error path.
Run with `python -m pytest swmf/tests/test_parse_ie_log.py` or directly:
`python swmf/tests/test_parse_ie_log.py`.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "swmf"))

from pipeline.parse_ie_log import (    # noqa: E402
    parse_ie_log, _resolve_columns, _format_header_error,
)


def _write_log(tmp: Path, header: str, rows: list[str]) -> Path:
    p = tmp / "IE_log.dat"
    p.write_text("\n".join([header, *rows]) + "\n")
    return p


def _row(year, mo, dy, hr, mn, *vals) -> str:
    return " ".join(str(x) for x in (1, year, mo, dy, hr, mn, 0, *vals))


def test_alias_path(tmp_path: Path):
    """Standard SWMF column names — picked up by the explicit alias table."""
    header = "step year mo dy hr mn sc cpcpn cpcps hpn hps"
    rows = [
        _row(2022, 2, 3, 0,  0,   30.0, 31.0,  10.0, 11.0),
        _row(2022, 2, 3, 0,  5,   45.0, 47.0,  18.0, 17.0),
    ]
    p = _write_log(tmp_path, header, rows)
    samples = parse_ie_log(p)
    assert len(samples) == 2
    assert samples[0]["phi_pc_kv"] == 31.0     # max(30, 31)
    assert samples[0]["hpi_gw"]    == 21.0     # 10 + 11
    assert samples[1]["phi_pc_kv"] == 47.0
    assert samples[1]["hpi_gw"]    == 35.0


def test_inference_path_full_words(tmp_path: Path):
    """Novel column names like 'CPCPNorth_kV' should resolve via inference."""
    header = ("step year mo dy hr mn sc "
              "CPCPNorth_kV CPCPSouth_kV "
              "HemPower_North_GW HemPower_South_GW")
    rows = [_row(2022, 2, 3, 22, 0,  78.0, 82.0, 50.0, 48.0)]
    p = _write_log(tmp_path, header, rows)
    samples = parse_ie_log(p)
    assert len(samples) == 1
    assert samples[0]["phi_pc_kv"] == 82.0
    assert samples[0]["hpi_gw"]    == 98.0


def test_inference_path_phi_notation(tmp_path: Path):
    """Greek-phi-style naming used by some SWMF forks."""
    header = "step year mo dy hr mn sc Phi_N Phi_S HPower_N HPower_S"
    rows = [_row(2022, 2, 3, 22, 30,  60.0, 65.0, 35.0, 30.0)]
    p = _write_log(tmp_path, header, rows)
    samples = parse_ie_log(p)
    assert samples[0]["phi_pc_kv"] == 65.0
    assert samples[0]["hpi_gw"]    == 65.0


def test_inference_does_not_pick_step(tmp_path: Path):
    """`step`/`nstep` must never be mistaken for a hemisphere column."""
    cols = _resolve_columns(
        ["nstep", "year", "mo", "dy", "hr", "mn", "sc",
         "CPCPNorth", "CPCPSouth", "HPNorth", "HPSouth"]
    )
    assert cols["cpcp_n"] != 0     # 0 is `nstep`
    assert cols["cpcp_s"] != 0


def test_no_match_gives_useful_error(tmp_path: Path):
    """Header with no plausible physics columns → ValueError with suggestions."""
    header = "step year mo dy hr mn sc foo bar baz qux"
    rows = [_row(2022, 2, 3, 0, 0,  1.0, 2.0, 3.0, 4.0)]
    p = _write_log(tmp_path, header, rows)
    try:
        parse_ie_log(p)
    except ValueError as exc:
        msg = str(exc)
        assert "no header containing all required columns" in msg
        assert "cpcp_n" in msg
        assert "Last header-shaped line we saw had tokens" in msg
        assert "--aliases-json" in msg
        return
    raise AssertionError("expected ValueError")


def test_close_match_suggests_via_difflib(tmp_path: Path):
    """
    Header tokens that don't satisfy the inference rules but are spelling
    variants of known aliases should be surfaced by the difflib fallback
    in the error message.
    """
    # `cpcpx` and `hpx` are off-by-one from cpcpn/hpn; inference fails
    # (no hemisphere marker), so we exercise the difflib branch.
    msg = _format_header_error(
        Path("/tmp/x.dat"),
        ("cpcp_n", "cpcp_s", "hp_n", "hp_s"),
        last_candidate=["step", "year", "mo", "dy", "hr", "mn", "sc",
                        "cpcpx", "cpcpy", "hpx", "hpy"],
    )
    # difflib should at least mention some of the typo'd tokens.
    assert any(tok in msg for tok in ("cpcpx", "cpcpy", "hpx", "hpy"))


def test_window_filter(tmp_path: Path):
    """start_utc/end_utc must trim out-of-window rows."""
    header = "step year mo dy hr mn sc cpcpn cpcps hpn hps"
    rows = [
        _row(2022, 2, 2, 23, 55,  10.0, 11.0,  5.0, 5.0),     # before
        _row(2022, 2, 3,  0,  0,  20.0, 21.0, 10.0, 10.0),    # in
        _row(2022, 2, 5,  0,  0,  30.0, 31.0, 15.0, 15.0),    # at end (excl)
    ]
    p = _write_log(tmp_path, header, rows)
    samples = parse_ie_log(
        p,
        start_utc=datetime(2022, 2, 3, tzinfo=timezone.utc),
        end_utc=datetime(2022, 2, 5, tzinfo=timezone.utc),
    )
    assert len(samples) == 1
    assert samples[0]["phi_pc_kv"] == 21.0


if __name__ == "__main__":
    import tempfile, traceback
    failed = 0
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        with tempfile.TemporaryDirectory() as td:
            try:
                if fn.__code__.co_argcount == 1:
                    fn(Path(td))
                else:
                    fn()
                print(f"  ok   {fn.__name__}")
            except Exception:
                failed += 1
                print(f"  FAIL {fn.__name__}")
                traceback.print_exc()
    if failed:
        sys.exit(1)
    print(f"\n{len(tests)} passed")
