# SPARTA DSMC kernel for Parker Physics

We use [SPARTA](https://sparta.github.io/) (Sandia National Labs,
Stochastic PArallel Rarefied-gas Time-accurate Analyzer — GPL v2) as
the offline DSMC engine. It isn't on the hot path: the runtime API
answers from a pre-computed lookup grid or from NRLMSISE-00. SPARTA's
job is to refine that grid for conditions where empirical models are
known to be weak (e.g. severe geomagnetic storms, exospheric hot O).

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
# Inside the container (or with the venv active locally)
python3 /app/sparta/generate_tables.py                    # full grid
python3 /app/sparta/generate_tables.py --dry-run          # no solver calls
python3 /app/sparta/generate_tables.py --use-msis-fallback  # bootstrap w/out SPARTA
```

Outputs land in `/app/sparta/tables/altXXXX_YYYYMMDDTHHMMSSZ.csv`.
`pipeline/atmosphere.py` picks them up at import or after a
`POST /v1/sparta/reload`.

Each CSV row carries:

| Column              | Units       | Notes |
|---------------------|-------------|-------|
| `altitude_km`       | km          | Grid axis |
| `f107_sfu`          | SFU         | Grid axis |
| `ap`                | linear      | Grid axis |
| `density_kg_m3`     | kg/m³       | Neutral mass density |
| `temperature_K`     | K           | Thermospheric temperature |
| `scale_height_km`   | km          | Optional — derived |
| `o_number_density`  | m⁻³         | Atomic O (dominant drag species above ~250 km) |
| `n2_number_density` | m⁻³         | Molecular N₂ |

## Engaging Sandia

SPARTA is actively maintained by Stan Moore, Steve Plimpton, and
Michael Gallis at Sandia. The maintainers have historically been
receptive to validation collaborations — if we can demonstrate a real
operational use case (Starlink Feb 2022 drag event, AR3842), it's
worth an email to the sparta-users list.

Ping us first — we want to avoid duplicating effort and make sure the
AR3842 benchmark output is shareable.
