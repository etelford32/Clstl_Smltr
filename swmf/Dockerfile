# ─────────────────────────────────────────────────────────────────────────────
# SWMF / BATS-R-US containerization — Phase 0
#
# Multi-stage build:
#   Stage 1 (builder) — clone + compile SWMF with gfortran + OpenMPI
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
# Phase 0: SC (Solar Corona) + IH (Inner Heliosphere) components only
WORKDIR /opt
RUN git clone --depth=1 https://github.com/SWMFsoftware/SWMF.git swmf \
 && cd swmf \
 && git submodule update --init --recursive BATL SC/BATSRUS IH/BATSRUS share

WORKDIR /opt/swmf

# Install SWMF with gfortran + OpenMPI
# Config.pl -install sets up Makefiles for the detected compiler
RUN perl Config.pl -install -compiler=gfortran -mpi=openmpi \
 && perl Config.pl -v

# Configure SC (Solar Corona) and IH (Inner Heliosphere) components
# SC: 1–24 R☉  |  IH: 24 R☉ → 2+ AU
RUN perl Config.pl -v -SC -IH

# Compile — use all available cores; typically takes 20-30 min on a 4-core machine
# SWMF= the coupled model, PostIDL = output converter
RUN make -j$(nproc) SWMF \
 && make -j$(nproc) PIDL

# Build standalone IH/BATSRUS for simpler solar wind runs (Phase 0 default)
WORKDIR /opt/swmf/IH/BATSRUS
RUN make -j$(nproc) BATSRUS

# Verify binaries
RUN ls -la /opt/swmf/bin/ && echo "SWMF build OK"

# ── Stage 2: runtime image ─────────────────────────────────────────────────────
FROM ubuntu:22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV SWMF_ROOT=/opt/swmf
ENV SWMF_BIN=/opt/swmf/bin
ENV PATH="${SWMF_BIN}:/opt/swmf/IH/BATSRUS:${PATH}"
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

# Copy compiled SWMF binaries from builder
COPY --from=builder /opt/swmf/bin/          /opt/swmf/bin/
COPY --from=builder /opt/swmf/IH/BATSRUS/BATSRUS.exe  /opt/swmf/IH/BATSRUS/BATSRUS.exe
COPY --from=builder /opt/swmf/SC/BATSRUS/BATSRUS.exe  /opt/swmf/SC/BATSRUS/BATSRUS.exe
COPY --from=builder /opt/swmf/SWMF.exe      /opt/swmf/SWMF.exe

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
