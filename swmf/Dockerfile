# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# SWMF / BATS-R-US containerization — Phase 0 + Phase 1
#
# The `# syntax` directive above MUST be the first non-blank line in this
# file — it enables BuildKit features (heredoc COPY <<EOF, --mount=type=cache,
# etc.) that this Dockerfile relies on. Removing it will silently break the
# build on classic-builder hosts (DOCKER_BUILDKIT=0).
#
# Components built into SWMF.exe:
#   SC — Solar Corona              (1 → 24 R☉)
#   IH — Inner Heliosphere         (24 R☉ → 2 AU; supplies upstream BC for GM)
#   GM — Geo-magnetosphere         (BATS-R-US around Earth)
#   IE — Ionosphere Electrodynamics (Ridley_serial; emits the IE log file
#                                    parse_ie_log.py reads for Φ_PC + HPI)
#
# The GM + IE additions over the previous SC+IH-only build are what make
# the Phase-0 pseudo-Ap regression actually computable — IH alone forecasts
# solar wind at L1 but does not produce magnetospheric energy inputs.
#
# Multi-stage build:
#   Stage 1 (builder) — clone + compile SWMF with gfortran + OpenMPI
#                       (~30-50 min on a 4-core machine for the coupled build)
#   Stage 2 (runtime) — slim image with binaries + Python pipeline
#
# Build:   docker build -t parkerphysics/swmf:latest .
# Run:     docker-compose -f docker-compose.swmf.yml up
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: compiler environment ─────────────────────────────────────────────
FROM ubuntu:22.04 AS builder

LABEL maintainer="Parker Physics <dev@parkerphysics.com>"
LABEL description="SWMF/BATS-R-US build environment (gfortran 12 + OpenMPI 4)"

ENV DEBIAN_FRONTEND=noninteractive
ENV SWMF_ROOT=/opt/swmf
ENV PATH="${SWMF_ROOT}/bin:${PATH}"

# Core build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Fortran + C compilers
    gfortran-12 gcc-12 g++-12 \
    # MPI
    libopenmpi-dev openmpi-bin \
    # Build toolchain
    make perl cmake git \
    # HDF5 / NetCDF (BATS-R-US output formats)
    libhdf5-openmpi-dev libnetcdf-dev libnetcdff-dev \
    # Python for swmfpy helper
    python3 python3-pip python3-dev \
    # Misc
    ca-certificates curl wget \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Set default compiler version
RUN update-alternatives --install /usr/bin/gfortran gfortran /usr/bin/gfortran-12 100 \
 && update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-12 100 \
 && update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-12 100

# Clone SWMF (Apache 2 license — https://github.com/SWMFsoftware/SWMF)
# Components built here:
#   SC — Solar Corona              (1 → 24 R☉)
#   IH — Inner Heliosphere         (24 R☉ → 2+ AU; passes solar wind to GM)
#   GM — Geo-magnetosphere         (BATS-R-US around Earth)
#   IE — Ionosphere Electrodynamics (Ridley_serial; needed for Φ_PC + HPI
#                                    timeseries that pseudo-Ap regresses on)
# Force HTTPS for all github.com submodules (SWMFsoftware .gitmodules uses SSH URLs)
#
# Drop --depth=1: Config.pl reads git metadata to stamp version strings
# and the shallow clone has bitten us with "fatal: bad revision HEAD" in
# share/Library hooks. Full clone adds ~150 MB but is paid once at build.
#
# Submodule strategy: pull whatever the top-level repo's .gitmodules
# declares (no path filter — earlier attempts hard-coded BATL/util/share
# paths that no longer exist as direct submodules in recent SWMFsoftware
# layouts). The real per-component setup is driven by `Config.pl -install`
# below; this `git submodule update` just makes sure any submodules that
# ARE registered (typically SC/BATSRUS, IH/BATSRUS, sometimes GM/BATSRUS)
# come down before Config.pl runs. `git submodule status` prints what's
# there so the build log shows the actual layout for this SWMF tag.
#
# Pin a SWMF release tag below (TODO: replace master with whatever tag you
# validate against). Tracking master is unstable for an ops pipeline.
ARG SWMF_REF=5f7194214
WORKDIR /opt
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" \
 && git clone https://github.com/SWMFsoftware/SWMF.git swmf \
 && cd swmf \
 && git checkout ${SWMF_REF} \
 && echo "=== .gitmodules (if present) ===" \
 && (cat .gitmodules 2>/dev/null || echo "(no .gitmodules at top level)") \
 && git submodule update --init --recursive \
 && echo "=== submodule status after init ===" \
 && git submodule status

WORKDIR /opt/swmf

# Install SWMF with gfortran + OpenMPI
# Config.pl -install sets up Makefiles for the detected compiler
RUN perl Config.pl -install -compiler=gfortran -mpi=openmpi \
 && perl Config.pl -v

# Configure all four components for the coupled hindcast run.
# SC: 1–24 R☉   |  IH: 24 R☉ → 2 AU  |  GM: Earth magnetosphere  |  IE: Ridley
#
# Component-version selection uses the documented `-v=COMPONENT/VERSION,...`
# syntax. The old `-COMPONENT/VERSION` bare form is silently ignored by
# recent Config.pl, which previously caused a configure-time no-op and a
# downstream `make SWMF` link failure that looked like a missing source
# bug. If submodule paths drift in a future SWMF release, run
# `git submodule status` in /opt/swmf and update the COPY lines in stage 2
# plus the -v= arg here.
RUN perl Config.pl -v=SC/BATSRUS,IH/BATSRUS,GM/BATSRUS,IE/Ridley_serial,IM/RCM2 \
 && perl Config.pl -show

# Compile — use all available cores; coupled SWMF build typically takes
# 30-50 min on a 4-core machine (vs. 20-30 for SC+IH alone).
# SWMF= the coupled binary, PostIDL = output converter
#
# After this step succeeds, /opt/swmf/SWMF.exe is the production binary
# that runs SC + IH + GM + IE together — that's what run_forecast.py
# invokes for coupled hindcasts and forecasts.
RUN make -j$(nproc) SWMF \
 && make -j$(nproc) PIDL

# Run-directory template: correct per-component skeleton incl. IM/ + RCM data files
RUN make rundir && mv run /opt/swmf/run_template

# NOTE: standalone BATSRUS.exe builds (IH-only / GM-only smoke tests) used
# to live here but were removed — `make BATSRUS` is not a target in current
# SWMF (Makefile errors with "No rule to make target 'BATSRUS'"). The
# standalone executables aren't required by run_forecast.py's coupled
# path; if you later want IH-only smoke tests, the modern recipe is
# something like `cd IH/BATSRUS && perl Config.pl -install && make`
# (default target) — verify against the SWMF_REF you're pinning before
# adding it back.

WORKDIR /opt/swmf

# Verify the coupled binary built.
# In current SWMF, `make SWMF` drops SWMF.exe into /opt/swmf/bin/ alongside
# PostIDL.exe (older SWMF docs show it at the top-level /opt/swmf/SWMF.exe;
# that path is gone in 2024+ releases).
RUN ls -la /opt/swmf/bin/ \
 && test -x /opt/swmf/bin/SWMF.exe \
 && echo "SWMF coupled-build OK — $(stat -c '%s bytes' /opt/swmf/bin/SWMF.exe)"
RUN ls -la /opt/swmf/bin/ \
 && ls -la /opt/swmf/SWMF.exe \
 && echo "SWMF coupled-build OK"

# ── Stage 2: runtime image ─────────────────────────────────────────────────────
FROM ubuntu:22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV SWMF_ROOT=/opt/swmf
ENV SWMF_BIN=/opt/swmf/bin
ENV PATH="${SWMF_BIN}:${PATH}"
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Runtime dependencies only
RUN apt-get update && apt-get install -y --no-install-recommends \
    # MPI runtime
    libopenmpi3 openmpi-bin \
    # HDF5 / NetCDF runtime
    libhdf5-openmpi-103 libnetcdf19 libnetcdff7 \
    # Python runtime
    python3 python3-pip \
    # Process management
    supervisor curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy compiled SWMF binary from builder.
# SWMF.exe (the coupled binary running SC + IH + GM + IE together) and
# PostIDL.exe both live under /opt/swmf/bin/ in current SWMF, so the
# single COPY of that directory picks up everything we need. The
# separate `COPY /opt/swmf/SWMF.exe` line that older docs reference is
# gone — that path doesn't exist in 2024+ SWMF layouts.
COPY --from=builder /opt/swmf/bin/  /opt/swmf/bin/
# SWMF.exe is the coupled binary that runs SC + IH + GM + IE together —
# that's the production binary. The per-component standalone
# BATSRUS.exe files used to be copied here too; the standalone builds
# were removed (see note in stage 1) so the COPY lines are gone too.
COPY --from=builder /opt/swmf/bin/      /opt/swmf/bin/
COPY --from=builder /opt/swmf/SWMF.exe  /opt/swmf/SWMF.exe

# IE/Ridley_serial is a serial Fortran component — its compiled object
# files live alongside the SWMF binary and are linked into SWMF.exe.
# Nothing extra to copy at runtime; the COPY above for SWMF.exe is enough.

# Copy SWMF Scripts and utilities
COPY --from=builder /opt/swmf/share/Scripts /opt/swmf/share/Scripts
COPY --from=builder /opt/swmf/run_template   /opt/swmf/run_template
COPY --from=builder /opt/swmf/PARAM.XML     /opt/swmf/PARAM.XML

# Install Python pipeline dependencies.
#
# --only-binary=:all: forces pip to use wheels — if a wheel is missing
# (common for spacepy on aarch64 before ~0.6), pip fails in seconds rather
# than spending 30 min compiling from source against build tools we stripped
# out of this runtime stage. The previous "two pip install blocks" pattern
# is gone: everything is pinned in requirements.txt so the resolver sees
# one consistent graph.
WORKDIR /app
COPY pipeline/requirements.txt ./pipeline/requirements.txt
RUN pip3 install --no-cache-dir --only-binary=:all: \
        -r pipeline/requirements.txt

# Copy pipeline, config, benchmark
COPY pipeline/ ./pipeline/
COPY config/   ./config/
COPY benchmark/ ./benchmark/

# Run directory (bind-mounted at runtime for each forecast run)
RUN mkdir -p /data/runs /data/imf /data/results /data/logs

# Supervisor config — runs ingestion daemon + API server concurrently
COPY <<'EOF' /etc/supervisor/conf.d/swmf-pipeline.conf
[supervisord]
nodaemon=true
user=root
logfile=/data/logs/supervisord.log

# ingest / forecast invoke via `python -m pipeline.MODULE` so the
# `pipeline` package is importable. Running `python /app/pipeline/X.py`
# instead puts sys.path[0] at /app/pipeline (not /app), which breaks
# the `from pipeline import db` imports at module load.
[program:ingest]
command=python3 -m pipeline.ingest_l1 --daemon
directory=/app
environment=PYTHONPATH="/app"
stdout_logfile=/data/logs/ingest.log
stderr_logfile=/data/logs/ingest_err.log
autorestart=true
startretries=10

[program:api]
command=python3 -m uvicorn pipeline.serve_results:app --host 0.0.0.0 --port 8000
directory=/app
environment=PYTHONPATH="/app"
stdout_logfile=/data/logs/api.log
stderr_logfile=/data/logs/api_err.log
autorestart=true
startretries=5

[program:forecast]
command=python3 -m pipeline.run_forecast --daemon
directory=/app
environment=PYTHONPATH="/app"
stdout_logfile=/data/logs/forecast.log
stderr_logfile=/data/logs/forecast_err.log
autorestart=true
startretries=5
EOF

EXPOSE 8000

VOLUME ["/data/runs", "/data/imf", "/data/results"]

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/swmf-pipeline.conf"]
