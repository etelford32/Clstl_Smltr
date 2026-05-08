"""
Tests for dsmc/pipeline/synthesize_extreme.py.

The synthesizer produces stress-test inputs that are deliberately
extra-instrumental — there's no ground truth to validate against. So
the tests focus on what we *can* verify: scaling math, time-axis
re-anchoring, output schema, and the do-not-train-on-this guard rail.

If any of these regress, the stress report built on top silently
becomes nonsense.
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))

from dsmc.pipeline.synthesize_extreme import (    # noqa: E402
    AP_TABLE_MAX, PRESETS, ScaleSpec,
    _load_template, synthesize, write_fixture,
)


FIXTURES = REPO / "dsmc" / "fixtures" / "hindcast"


# ─── Preset registry ────────────────────────────────────────────────────────

def test_presets_have_distinct_synth_ids() -> None:
    ids = [s.synth_id for s in PRESETS.values()]
    assert len(ids) == len(set(ids)), f"duplicate synth_id in PRESETS: {ids}"
    assert all(s.startswith("synth_") for s in ids)


def test_presets_reference_existing_template_fixtures() -> None:
    for spec in PRESETS.values():
        path = FIXTURES / spec.template_event / "historical_ap.csv"
        assert path.exists(), (
            f"preset {spec.synth_id} references missing template "
            f"fixture {spec.template_event}"
        )


# ─── Synthesize math ────────────────────────────────────────────────────────

def test_synthesize_applies_f107_factor_uniformly() -> None:
    spec = ScaleSpec(
        synth_id="test_f107_only",
        template_event="solar_min_dec_2019",
        ap_factor=1.0, f107_factor=3.0,
    )
    template = _load_template(
        FIXTURES / spec.template_event / "historical_ap.csv"
    )
    rows, prov = synthesize(spec, fixtures_dir=FIXTURES)
    assert len(rows) == len(template)
    # Every output F10.7 must be exactly 3× the corresponding input.
    for src, dst in zip(template, rows):
        assert abs(dst.f107_sfu - src.f107_sfu * 3.0) < 1e-9
    assert prov["scaling"]["f107_factor"] == 3.0


def test_synthesize_caps_ap_at_table_max() -> None:
    """The Kp/ap conversion table tops out at 400; even with an absurd
    ap_factor the output must clip cleanly to AP_TABLE_MAX."""
    spec = ScaleSpec(
        synth_id="test_ap_cap",
        template_event="halloween_oct_2003",   # already has Ap=400 rows
        ap_factor=10.0,
    )
    rows, _ = synthesize(spec, fixtures_dir=FIXTURES)
    assert all(r.ap <= AP_TABLE_MAX + 1e-9 for r in rows)


def test_synthesize_extends_storm_plateau() -> None:
    """Inserting N storm-plateau bins must produce exactly N more rows."""
    base = ScaleSpec(
        synth_id="test_no_extend",
        template_event="bastille_jul_2000",
    )
    extended = ScaleSpec(
        synth_id="test_extend",
        template_event="bastille_jul_2000",
        extend_storm_3h_bins=8,
    )
    base_rows, _ = synthesize(base,     fixtures_dir=FIXTURES)
    ext_rows,  _ = synthesize(extended, fixtures_dir=FIXTURES)
    assert len(ext_rows) == len(base_rows) + 8
    # Cadence is still 3 hours throughout the extended series.
    for prev, curr in zip(ext_rows, ext_rows[1:]):
        dt = (curr.t - prev.t).total_seconds() / 3600.0
        assert abs(dt - 3.0) < 1e-6, f"non-3h gap at {prev.t} -> {curr.t}"


def test_synthesize_anchors_time_to_1900() -> None:
    """The output must NOT carry the source event's real timestamps —
    a synth fixture must be unambiguously identifiable as such."""
    spec = ScaleSpec(
        synth_id="test_anchor", template_event="bastille_jul_2000",
    )
    rows, _ = synthesize(spec, fixtures_dir=FIXTURES)
    assert rows[0].t.year == 1900
    assert rows[0].t.month == 1 and rows[0].t.day == 1


# ─── Provenance JSON ────────────────────────────────────────────────────────

def test_provenance_marks_do_not_train() -> None:
    spec = next(iter(PRESETS.values()))
    _, prov = synthesize(spec, fixtures_dir=FIXTURES)
    assert prov["do_not_train_on_this_fixture"] is True
    assert "warnings" in prov
    assert "citations" in prov
    assert "post_scale_summary" in prov


def test_provenance_warns_on_f107_extrapolation() -> None:
    spec = ScaleSpec(
        synth_id="test_warn_f107",
        template_event="bastille_jul_2000",
        f107_factor=2.0,    # 315 → 630, well past TRAINING_F107_MAX (315)
    )
    _, prov = synthesize(spec, fixtures_dir=FIXTURES)
    assert any("F10.7" in w and "exceeds" in w for w in prov["warnings"]), \
        prov["warnings"]


def test_provenance_warns_on_ap_saturation() -> None:
    spec = ScaleSpec(
        synth_id="test_warn_ap",
        template_event="halloween_oct_2003",   # already saturates
        ap_factor=1.0,
    )
    _, prov = synthesize(spec, fixtures_dir=FIXTURES)
    assert any("Ap saturation" in w for w in prov["warnings"]), prov["warnings"]


# ─── Round trip through the loader ──────────────────────────────────────────

def test_synth_fixture_reads_back_correctly(tmp_path: Path = REPO / "dsmc" / "tests" / "_tmp_synth") -> None:
    """Write → read round trip must preserve the schema exactly."""
    from dsmc.pipeline.jacchia_timeseries import load_indices_csv
    spec = ScaleSpec(
        synth_id="test_round_trip",
        template_event="solar_min_dec_2019",
        f107_factor=2.0,
    )
    rows, prov = synthesize(spec, fixtures_dir=FIXTURES)
    out_dir = tmp_path
    try:
        csv_path, json_path = write_fixture(rows, prov, out_dir=out_dir)
        loaded = load_indices_csv(csv_path)
        assert len(loaded) == len(rows)
        for src, dst in zip(rows, loaded):
            assert src.t == dst.t
            assert abs(src.ap - dst.ap) < 1e-6
            assert abs(src.f107_sfu - dst.f107_sfu) < 1e-6
        # Provenance JSON parses.
        meta = json.loads(json_path.read_text())
        assert meta["do_not_train_on_this_fixture"] is True
    finally:
        for p in out_dir.glob("*"):
            p.unlink()
        out_dir.rmdir()


# ─── Script-mode runner ────────────────────────────────────────────────────

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
