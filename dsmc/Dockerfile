# ─────────────────────────────────────────────────────────────────────────────
# Parker Physics DSMC thermosphere pipeline — Phase 1
#
# Multi-stage build:
#   Stage 1 (sparta-builder) — OPTIONAL (toggled by BUILD_SPARTA arg):
#     clone + compile Sandia SPARTA (DSMC) with OpenMPI
#   Stage 2 (runtime) — FastAPI drag service + Belay supervisor + ingest
#
# Build (runtime only, ~fast):
#   docker build -t parkerphysics/dsmc:latest dsmc/
#
# Build with SPARTA (slow, first time):
#   docker build --build-arg BUILD_SPARTA=1 -t parkerphysics/dsmc:latest dsmc/
#
# Run:
#   docker-compose -f swmf/docker-compose.swmf.yml up dsmc
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: SPARTA builder (opt-in) ─────────────────────────────────────────
ARG BUILD_SPARTA=0
FROM ubuntu:22.04 AS sparta-builder

ARG BUILD_SPARTA
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential g++ make git ca-certificates \
        libopenmpi-dev openmpi-bin \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Clone + build only if BUILD_SPARTA=1, otherwise create empty stubs so
# the runtime COPY below still finds the paths.
WORKDIR /opt
RUN if [ "$BUILD_SPARTA" = "1" ]; then \
      git config --global url."https://github.com/".insteadOf "git@github.com:" && \
      git clone --depth=1 https://github.com/sparta/sparta.git && \
      cd sparta/src && \
      make -j"$(nproc)" mpi && \
      ls -la spa_mpi; \
    else \
      mkdir -p /opt/sparta/src && \
      echo "#!/bin/sh\necho 'SPARTA not built — rebuild with --build-arg BUILD_SPARTA=1' >&2; exit 64" > /opt/sparta/src/spa_mpi && \
      chmod +x /opt/sparta/src/spa_mpi ; \
    fi


# ── Stage 2: runtime image ───────────────────────────────────────────────────
FROM ubuntu:22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV SPARTA_BIN=/opt/sparta/src/spa_mpi
ENV SPARTA_TABLES_DIR=/app/sparta/tables

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-dev \
        libopenmpi3 openmpi-bin \
        curl ca-certificates \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy SPARTA (real or stub) from the builder stage
COPY --from=sparta-builder /opt/sparta /opt/sparta

WORKDIR /app
COPY pipeline/requirements.txt ./pipeline/requirements.txt
RUN pip3 install --no-cache-dir -r pipeline/requirements.txt

# Pipeline + SPARTA driver
COPY pipeline/   ./pipeline/
COPY sparta/     ./sparta/
COPY benchmark/  ./benchmark/

# SPARTA tables live here; mounted volume in compose
RUN mkdir -p /app/sparta/tables /data/dsmc/logs

EXPOSE 8001

# Default entrypoint: the FastAPI service. The Belay supervisor runs as
# an asyncio background task inside the same process, so we don't need
# supervisord here. A single container, one ASGI worker, one event loop.
CMD ["python3", "-m", "uvicorn", "pipeline.serve_drag:app", \
     "--host", "0.0.0.0", "--port", "8001"]
