"""
test_parse_dump.py — unit tests for parse_dump.parse_summary_dump

Run:  python3 -m pytest dsmc/sparta/test_parse_dump.py -q
Or:   python3 dsmc/sparta/test_parse_dump.py
"""

from __future__ import annotations

import math
import sys
import tempfile
import textwrap
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parse_dump   # noqa: E402


# ── Fixture helpers ─────────────────────────────────────────────────────────

def _synthetic_dump(
    *,
    timestep: int = 10_000,
    ncells: int = 8,
    per_species_nrho: dict[str, float] | None = None,
    temperature_K: float = 750.0,
    add_earlier_frame: bool = False,
) -> str:
    """
    Build a SPARTA-style grid dump we can feed to the parser.

    Per-species number densities are constant across cells (the parser
    averages across cells so constant data should come back exactly).
    """
    per_species_nrho = per_species_nrho or {
        "N2": 1.0e14, "O2": 2.0e13, "NO": 1.0e12,
        "O":  3.0e14, "N":  5.0e11, "He": 1.0e12, "H": 1.0e10,
    }
    # Pack columns in parse_dump.SPECIES_ORDER (N2 O2 NO O N He H) so the
    # dump column order matches the production deck's `species` command.
    nrho_vals = [per_species_nrho[s] for s in parse_dump.SPECIES_ORDER]

    header = textwrap.dedent(f"""\
        ITEM: TIMESTEP
        {timestep}
        ITEM: NUMBER OF CELLS
        {ncells}
        ITEM: BOX BOUNDS
        0 1e-3
        0 1e-3
        0 1e-3
        ITEM: CELLS id xc yc zc f_nrho[1] f_nrho[2] f_nrho[3] f_nrho[4] f_nrho[5] f_nrho[6] f_nrho[7] f_tkin
        """)
    rows = []
    for cell_id in range(1, ncells + 1):
        # Cell center coordinates are arbitrary for reduction correctness.
        xc = yc = zc = 5.0e-4
        cols = [cell_id, xc, yc, zc, *nrho_vals, temperature_K]
        rows.append(" ".join(f"{v:.6e}" if isinstance(v, float) else str(v)
                             for v in cols))

    frame = header + "\n".join(rows) + "\n"
    if not add_earlier_frame:
        return frame

    # Prepend a "bogus" earlier frame so the parser must pick the last.
    earlier = _synthetic_dump(
        timestep=timestep - 1000,
        ncells=ncells,
        per_species_nrho={k: v * 10 for k, v in per_species_nrho.items()},
        temperature_K=temperature_K * 2,
        add_earlier_frame=False,
    )
    return earlier + frame


# ── Tests ───────────────────────────────────────────────────────────────────

def test_single_frame_roundtrip():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "summary.dump"
        path.write_text(_synthetic_dump())
        out = parse_dump.parse_summary_dump(path, altitude_km=400.0)

    # Per-species nrho should come through exactly (constant across cells).
    assert math.isclose(out["n2_number_density"], 1.0e14, rel_tol=1e-9)
    assert math.isclose(out["o2_number_density"], 2.0e13, rel_tol=1e-9)
    assert math.isclose(out["no_number_density"], 1.0e12, rel_tol=1e-9)
    assert math.isclose(out["o_number_density"],  3.0e14, rel_tol=1e-9)
    assert math.isclose(out["n_number_density"],  5.0e11, rel_tol=1e-9)
    assert math.isclose(out["he_number_density"], 1.0e12, rel_tol=1e-9)
    assert math.isclose(out["h_number_density"],  1.0e10, rel_tol=1e-9)

    assert math.isclose(out["temperature_K"], 750.0, rel_tol=1e-9)

    # Total number density.
    expected_total = sum([
        1.0e14, 2.0e13, 1.0e12, 3.0e14, 5.0e11, 1.0e12, 1.0e10
    ])
    assert math.isclose(out["total_number_density"],
                        expected_total, rel_tol=1e-9)

    # Mass density: sum m_i * n_i.
    m = parse_dump.SPECIES_MASS_KG
    expected_rho = (
        m["N2"] * 1.0e14 + m["O2"] * 2.0e13 + m["NO"] * 1.0e12 +
        m["O"]  * 3.0e14 + m["N"]  * 5.0e11 + m["He"] * 1.0e12 +
        m["H"]  * 1.0e10
    )
    assert math.isclose(out["density_kg_m3"], expected_rho, rel_tol=1e-9)

    # Mean molecular mass.
    assert math.isclose(out["mean_molecular_mass_kg"],
                        expected_rho / expected_total, rel_tol=1e-9)

    # Scale height: H = k_B T / (m̄ g). At 400 km, g is reduced.
    g = 9.806_65 * (6_371_000.0 / (6_371_000.0 + 400_000.0)) ** 2
    m_bar = expected_rho / expected_total
    expected_H_km = 1.380_649e-23 * 750.0 / (m_bar * g) / 1000.0
    assert math.isclose(out["scale_height_km"], expected_H_km, rel_tol=1e-6)


def test_takes_last_of_multiple_frames():
    """Multi-frame dumps must return the *last* averaging window."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "summary.dump"
        path.write_text(_synthetic_dump(
            timestep=10_000,
            per_species_nrho={
                "N2": 1.0e14, "O2": 2.0e13, "NO": 1.0e12,
                "O":  3.0e14, "N":  5.0e11, "He": 1.0e12, "H": 1.0e10,
            },
            temperature_K=750.0,
            add_earlier_frame=True,
        ))
        out = parse_dump.parse_summary_dump(path, altitude_km=0.0)

    # If we grabbed the earlier frame instead, T would be 1500 K.
    assert math.isclose(out["temperature_K"], 750.0, rel_tol=1e-9)
    assert out["dump_timestep"] == 10_000


def test_missing_column_raises():
    """Dump without f_nrho[…] columns must raise a useful error."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "broken.dump"
        path.write_text(textwrap.dedent("""\
            ITEM: TIMESTEP
            1
            ITEM: NUMBER OF CELLS
            1
            ITEM: BOX BOUNDS
            0 1
            0 1
            0 1
            ITEM: CELLS id f_tkin
            1 500
            """))
        try:
            parse_dump.parse_summary_dump(path, altitude_km=0.0)
        except KeyError as exc:
            msg = str(exc)
            assert "f_nrho" in msg, f"error didn't mention f_nrho: {msg}"
        else:
            raise AssertionError("expected KeyError for missing columns")


def test_per_cell_averaging():
    """When cell values differ, parser returns the arithmetic mean."""
    # Two cells with nrho scaled by 1× and 3× → mean is 2×.
    header = textwrap.dedent("""\
        ITEM: TIMESTEP
        1
        ITEM: NUMBER OF CELLS
        2
        ITEM: BOX BOUNDS
        0 1e-3
        0 1e-3
        0 1e-3
        ITEM: CELLS id xc yc zc f_nrho[1] f_nrho[2] f_nrho[3] f_nrho[4] f_nrho[5] f_nrho[6] f_nrho[7] f_tkin
        """)
    # Cell 1: all species nrho = 1e14, T=800.  Cell 2: 3e14, T=400.
    cell1 = " ".join([
        "1", "1e-4", "1e-4", "1e-4",
        "1e14", "1e14", "1e14", "1e14", "1e14", "1e14", "1e14",
        "800.0",
    ])
    cell2 = " ".join([
        "2", "5e-4", "5e-4", "5e-4",
        "3e14", "3e14", "3e14", "3e14", "3e14", "3e14", "3e14",
        "400.0",
    ])
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "summary.dump"
        path.write_text(header + cell1 + "\n" + cell2 + "\n")
        out = parse_dump.parse_summary_dump(path, altitude_km=0.0)

    # Mean per species = 2e14 for every species.
    for col in ("n2_number_density", "o2_number_density",
                "no_number_density", "o_number_density",
                "n_number_density",  "he_number_density",
                "h_number_density"):
        assert math.isclose(out[col], 2.0e14, rel_tol=1e-9), \
            f"{col} averaged wrong: {out[col]}"

    # Mean T = (800 + 400)/2 = 600.
    assert math.isclose(out["temperature_K"], 600.0, rel_tol=1e-9)


def test_bad_file_raises_valueerror():
    """A file with no TIMESTEP blocks should raise, not silently return."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "garbage.txt"
        path.write_text("not a SPARTA dump\njust some lines\n")
        try:
            parse_dump.parse_summary_dump(path)
        except ValueError as exc:
            assert "ITEM: TIMESTEP" in str(exc)
        else:
            raise AssertionError("expected ValueError for non-dump file")


if __name__ == "__main__":
    test_single_frame_roundtrip()
    test_takes_last_of_multiple_frames()
    test_missing_column_raises()
    test_per_cell_averaging()
    test_bad_file_raises_valueerror()
    print("OK")
