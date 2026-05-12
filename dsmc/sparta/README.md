# SPARTA DSMC kernel for Parkers Physics

We use [SPARTA](https://sparta.github.io/) (Sandia National Labs,
Stochastic PArallel Rarefied-gas Time-accurate Analyzer — GPL v2) as
the offline DSMC engine. It isn't on the hot path: the runtime API
answers from a pre-computed lookup grid or from NRLMSISE-00. SPARTA's
job is to refine that grid for conditions where empirical models are
known to be weak (e.g. severe geomagnetic storms, exospheric hot O,
He-dominated altitudes).

## Layout

```
dsmc/sparta/
├── README.md                 — this file
├── in.thermo.template        — production input deck (tokenised)
├── species/
│   ├── air.species           — 7 species, Bird (1994) VSS parameters
│   └── air.vss               — 28 pairwise interactions (7 self + 21 cross)
├── generate_tables.py        — batch driver (one CSV per altitude)
├── parse_dump.py             — summary.dump reducer
└── test_parse_dump.py        — unit tests
```

## Species set

| Species | Where it dominates  | Notes                         |
|---------|---------------------|-------------------------------|
| N₂      | < 200 km            | Molecular regime              |
| O₂      | < 200 km            | Molecular regime              |
| NO      | 80–150 km           | Dissociation product; minor above 200 km |
| O       | 200–600 km          | Drives LEO drag               |
| N       | storm-time 200–400 km | Auroral enhancement         |
| He      | 600–1000 km         | Solar-min exosphere           |
| H       | > 1000 km           | Geocorona                     |

VSS parameters from Bird (1994, Table A.1); cross-pairs by standard
combining rules (§4.3). Any future revision introducing non-unity α
for e.g. H–O (Dalgarno & Smith 1962) should update `air.vss` and
document why the combining rule is being overridden.

## Build

SPARTA is included as an opt-in build stage in the DSMC image. The
runtime image ships empty tables; build SPARTA when you're ready to
populate them:

```bash
# From the repo root
docker build -t parkerphysics/dsmc:latest \
  --build-arg BUILD_SPARTA=1 \
  -f dsmc/Dockerfile dsmc/
```

This clones the public `sparta/sparta` repo and runs `make mpi` in
`/opt/sparta/src`, producing `spa_mpi`.

## Generate the lookup tables

```bash
# Inside the container (or with the venv active locally):
python3 /app/sparta/generate_tables.py                  # full grid, SPARTA
python3 /app/sparta/generate_tables.py --dry-run        # render decks, skip solver
python3 /app/sparta/generate_tables.py --use-msis-fallback
#                                                      # fill grid from NRLMSISE-00
```

Outputs land in `${SPARTA_TABLES_DIR:-/app/sparta/tables}/altXXXX_YYYYMMDDTHHMMSSZ.csv`.
`pipeline/atmosphere.py` picks them up at import or after
`POST /v1/sparta/reload`.

### Environment knobs

| Variable              | Default                     | Effect                          |
|-----------------------|-----------------------------|---------------------------------|
| `SPARTA_BIN`          | `/opt/sparta/src/spa_mpi`   | Path to the built solver        |
| `SPARTA_TEMPLATE`     | `in.thermo.template` (next to driver) | Deck template         |
| `SPARTA_SPECIES_DIR`  | `species/` (next to driver) | Species & VSS files             |
| `SPARTA_TABLES_DIR`   | `/app/sparta/tables`        | CSV output dir                  |
| `SPARTA_WORKDIR`      | `/tmp/sparta_runs`          | Scratch per grid point          |
| `SPARTA_NPROC`        | `4`                         | MPI ranks for `mpiexec -n`      |
| `SPARTA_GRID_ALTS`    | `250 350 450 550 700 900`   | Altitude axis (km)              |
| `SPARTA_GRID_F107`    | `70 100 150 200 250`        | F10.7 axis (SFU)                |
| `SPARTA_GRID_AP`      | `5 15 50 100 200`           | Ap axis                         |
| `SPARTA_NPARTS`       | `100000`                    | Target sim particles per box    |
| `SPARTA_MIN_BOX_M`    | `1e-3`                      | Minimum cube side length (m)    |
| `SPARTA_GRID_NX`      | `10`                        | Grid cells per side (N×N×N)     |
| `SPARTA_TIMESTEP_S`   | `1e-6`                      | Integration Δt (s)              |
| `SPARTA_SETTLE_STEPS` | `5000`                      | Settle-phase step count         |
| `SPARTA_AVG_STEPS`    | `5000`                      | Averaging-phase step count      |

### What each grid point does

For every `(altitude, F10.7, Ap)`:

1. **MSIS seed** — call `pipeline.atmosphere.density()` to get initial
   `T`, total `nrho`, and per-species fractions. These fill the deck's
   placeholder tokens.
2. **Cell sizing** — box side + `fnum` chosen so the box holds
   ~`SPARTA_NPARTS` sim particles with `fnum ≥ 1`. At high altitudes
   (`nrho < 10¹⁴`) the box grows beyond the 1 mm minimum.
3. **Render** — substitute all `__TOKEN__` placeholders in
   `in.thermo.template`. Unresolved tokens raise immediately.
4. **Stage species files** — `species/` is copied next to the deck so
   the `species species/air.species …` line resolves.
5. **Solve** — `mpiexec -n $SPARTA_NPROC spa_mpi -in in.thermo`. Settle
   phase equilibrates trans/rot/vib modes; averaging phase time-
   averages per-species `nrho` and kinetic temperature.
6. **Parse** — `parse_dump.parse_summary_dump()` reads `summary.dump`
   and reduces to a box-average summary row.
7. **Emit** — one CSV row per point; partial progress is flushed per
   altitude so a midway crash keeps completed work.

## CSV schema

| Column                   | Units  | Notes                               |
|--------------------------|--------|-------------------------------------|
| `altitude_km`            | km     | Grid axis                           |
| `f107_sfu`               | SFU    | Grid axis                           |
| `ap`                     | linear | Grid axis                           |
| `density_kg_m3`          | kg/m³  | Neutral mass density                |
| `temperature_K`          | K      | Kinetic temperature                 |
| `scale_height_km`        | km     | H = k_B T / (m̄ g)                  |
| `mean_molecular_mass_kg` | kg     | ρ / n_total                         |
| `total_number_density`   | m⁻³    | Σ nᵢ                                |
| `n2_number_density`      | m⁻³    |                                     |
| `o2_number_density`      | m⁻³    |                                     |
| `no_number_density`      | m⁻³    |                                     |
| `o_number_density`       | m⁻³    |                                     |
| `n_number_density`       | m⁻³    |                                     |
| `he_number_density`      | m⁻³    |                                     |
| `h_number_density`       | m⁻³    |                                     |
| `source`                 | string | `sparta` \| `msis_bootstrap` \| `msis_fallback` |
| `seed_nrho_m3`           | m⁻³    | MSIS seed, for provenance           |
| `seed_temp_K`            | K      | MSIS seed, for provenance           |

`pipeline/atmosphere.py` reads rows with `dict.get(col, default)`, so
the schema is append-only safe. Only the three grid-axis columns are
required; everything else has a default.

## SPARTA input-deck contract

`in.thermo.template` is a tokenised SPARTA script. The substitution
contract is documented in the file's header comment. Hard rules:

- Token syntax is strictly `__UPPER_SNAKE__`. After substitution the
  driver scans for any remaining `__…__` fragments and raises if
  found; no silent drops.
- The `species` command declares species in the order
  `N2 O2 NO O N He H`. The dump columns inherit this order as
  `f_nrho[1..7]`. **Do not reorder without updating
  `parse_dump.SPECIES_ORDER` and the CSV column names.**
- Averaging is `Nevery=1, Nrepeat=AVG, Nfreq=AVG` — one dump frame
  per run, containing the time-average of the entire averaging phase.
- Periodic boundaries, no wall interactions, no inflow/outflow. The
  deck models a representative parcel at equilibrium, not a flow.

## Engaging Sandia

SPARTA is actively maintained by Stan Moore, Steve Plimpton, and
Michael Gallis at Sandia. The maintainers have historically been
receptive to validation collaborations — if we can demonstrate a real
operational use case (Starlink Feb 2022 drag event, AR3842), it's
worth an email to the sparta-users list.

Ping us first — we want to avoid duplicating effort and make sure the
AR3842 benchmark output is shareable.

## Phase-1 gates (from the roadmap)

- [ ] ρ@400 km within ±25% of MSIS at quiet-Sun (F10.7 = 100, Ap = 15).
- [ ] Starlink Feb 2022 benchmark still passes against the SPARTA table.
- [ ] At least one SPARTA row emits non-zero species-resolved
      composition for all 7 species.
