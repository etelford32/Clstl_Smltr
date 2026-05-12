# ─────────────────────────────────────────────────────────────────────────────
# SWMF / BATS-R-US containerization — Phase 0 + Phase 1
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
WORKDIR /opt
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" \
 && git clone --depth=1 https://github.com/SWMFsoftware/SWMF.git swmf \
 && cd swmf \
 && git submodule update --init --recursive \
        BATL \
        SC/BATSRUS \
        IH/BATSRUS \
        GM/BATSRUS \
        IE/Ridley_serial \
        share

WORKDIR /opt/swmf

# Install SWMF with gfortran + OpenMPI
# Config.pl -install sets up Makefiles for the detected compiler
RUN perl Config.pl -install -compiler=gfortran -mpi=openmpi \
 && perl Config.pl -v

# Configure all four components for the coupled hindcast run.
# SC: 1–24 R☉   |  IH: 24 R☉ → 2 AU  |  GM: Earth magnetosphere  |  IE: Ridley
# If submodule paths drift in a future SWMF release, run `git submodule status`
# in /opt/swmf and update the COPY lines in stage 2 plus the -GM/-IE arg here.
RUN perl Config.pl -v -SC -IH -GM/BATSRUS -IE/Ridley_serial

# Compile — use all available cores; coupled SWMF build typically takes
# 30-50 min on a 4-core machine (vs. 20-30 for SC+IH alone).
# SWMF= the coupled binary, PostIDL = output converter
RUN make -j$(nproc) SWMF \
 && make -j$(nproc) PIDL

# Build standalone IH/BATSRUS for simpler solar-wind-only runs (Phase 0 IH-only fallback)
WORKDIR /opt/swmf/IH/BATSRUS
RUN make -j$(nproc) BATSRUS

# Build standalone GM/BATSRUS for magnetosphere-only smoke tests
WORKDIR /opt/swmf/GM/BATSRUS
RUN make -j$(nproc) BATSRUS

WORKDIR /opt/swmf

# Verify binaries
RUN ls -la /opt/swmf/bin/ \
 && ls -la /opt/swmf/IH/BATSRUS/BATSRUS.exe \
            /opt/swmf/GM/BATSRUS/BATSRUS.exe \
            /opt/swmf/SWMF.exe \
 && echo "SWMF coupled-build OK"

# ── Stage 2: runtime image ─────────────────────────────────────────────────────
FROM ubuntu:22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV SWMF_ROOT=/opt/swmf
ENV SWMF_BIN=/opt/swmf/bin
ENV PATH="${SWMF_BIN}:/opt/swmf/IH/BATSRUS:/opt/swmf/GM/BATSRUS:${PATH}"
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

# Copy compiled SWMF binaries from builder.
# SWMF.exe is the coupled binary that runs SC + IH + GM + IE together.
# Per-component BATSRUS.exes are kept for standalone smoke tests.
COPY --from=builder /opt/swmf/bin/          /opt/swmf/bin/
COPY --from=builder /opt/swmf/IH/BATSRUS/BATSRUS.exe  /opt/swmf/IH/BATSRUS/BATSRUS.exe
COPY --from=builder /opt/swmf/SC/BATSRUS/BATSRUS.exe  /opt/swmf/SC/BATSRUS/BATSRUS.exe
COPY --from=builder /opt/swmf/GM/BATSRUS/BATSRUS.exe  /opt/swmf/GM/BATSRUS/BATSRUS.exe
COPY --from=builder /opt/swmf/SWMF.exe      /opt/swmf/SWMF.exe

# IE/Ridley_serial is a serial Fortran component — its compiled object
# files live alongside the SWMF binary and are linked into SWMF.exe.
# Nothing extra to copy at runtime; the COPY above for SWMF.exe is enough.

# Copy SWMF Scripts and utilities
COPY --from=builder /opt/swmf/share/Scripts /opt/swmf/share/Scripts

# Install Python pipeline dependencies
WORKDIR /app
COPY pipeline/requirements.txt ./pipeline/requirements.txt
RUN pip3 install --no-cache-dir -r pipeline/requirements.txt

# Install swmfpy (University of Michigan SWMF Python tools)
RUN pip3 install --no-cache-dir \
    swmfpy \
    spacepy \
    astropy \
    "fastapi[standard]" \
    uvicorn \
    httpx \
    schedule \
    pandas \
    numpy \
    scipy

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

[program:ingest]
command=python3 /app/pipeline/ingest_l1.py --daemon
stdout_logfile=/data/logs/ingest.log
stderr_logfile=/data/logs/ingest_err.log
autorestart=true
startretries=10

[program:api]
command=python3 -m uvicorn pipeline.serve_results:app --host 0.0.0.0 --port 8000
directory=/app
stdout_logfile=/data/logs/api.log
stderr_logfile=/data/logs/api_err.log
autorestart=true
startretries=5

[program:forecast]
command=python3 /app/pipeline/run_forecast.py --daemon
stdout_logfile=/data/logs/forecast.log
stderr_logfile=/data/logs/forecast_err.log
autorestart=true
startretries=5
EOF

EXPOSE 8000

VOLUME ["/data/runs", "/data/imf", "/data/results"]

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/swmf-pipeline.conf"]
