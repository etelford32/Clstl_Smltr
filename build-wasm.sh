#!/bin/bash
# Build script for Vercel deployment

set -e

echo "🦀 Building Rust WASM for deployment..."

# Ensure Rust/cargo is on PATH.
# Handles two layouts:
#   ~/.cargo/bin  — rustup default (local / Claude Code dev sessions)
#   /rust/bin     — pre-installed toolchain in Vercel build images
if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.cargo/env"
elif [ -d "/rust/bin" ]; then
    export PATH="/rust/bin:$PATH"
fi

# Verify rustc is available — do NOT attempt internet download
if ! command -v rustc &> /dev/null; then
    echo "ERROR: rustc not found at ~/.cargo/bin or /rust/bin." >&2
    echo "       Install Rust from https://rustup.rs and re-run." >&2
    exit 1
fi

# Add wasm32 target if not already added
if ! rustup target list | grep -q "wasm32-unknown-unknown (installed)"; then
    echo "Adding wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
fi

# ── Build S-star orbital propagator (Sgr A*) ──────────────────
echo "Building S-star WASM (Sgr A* orbital engine)..."
cd rust-sstar
cargo build --release --target wasm32-unknown-unknown

echo "Generating S-star JS bindings..."
if command -v wasm-bindgen &> /dev/null; then
    wasm-bindgen --target web --out-dir ../js/sstar-wasm/ \
        target/wasm32-unknown-unknown/release/sstar_wasm.wasm
else
    echo "WARN: wasm-bindgen CLI not found — using pre-built JS bindings"
    cp target/wasm32-unknown-unknown/release/sstar_wasm.wasm ../js/sstar-wasm/sstar_wasm_bg.wasm
fi
cd ..

# ── Build 24-hour location forecast core ─────────────────────
echo "Building forecast24 WASM (deterministic ensemble core)..."
cd rust-forecast
cargo build --release --target wasm32-unknown-unknown

echo "Generating forecast24 JS bindings..."
if command -v wasm-bindgen &> /dev/null; then
    wasm-bindgen --target web --out-dir ../js/forecast-wasm/ \
        target/wasm32-unknown-unknown/release/forecast24_wasm.wasm
else
    # No wasm-bindgen available → locationforecast.html falls back to its
    # bundled JS port (algorithmically identical, ~3× slower in tight loops).
    echo "WARN: wasm-bindgen CLI not found — locationforecast.html will use its JS port."
    mkdir -p ../js/forecast-wasm
    cp target/wasm32-unknown-unknown/release/forecast24_wasm.wasm ../js/forecast-wasm/forecast24_wasm_bg.wasm 2>/dev/null || true
fi
cd ..

# ── Build Black Hole Observatory N-body kernel ───────────────
# Pure extern-C exports (no wasm-bindgen dependency): the raw .wasm IS the
# artifact, loaded with WebAssembly.instantiate in js/abell85/simworker.js.
# The compiled binary is also committed at js/abell85-wasm/abell85_nbody.wasm
# (rust/www precedent) so deploys and tests survive toolchain hiccups; this
# step refreshes it when the toolchain is available.
echo "Building abell85 N-body kernel WASM..."
if (cd rust-abell85 && cargo build --release --target wasm32-unknown-unknown); then
    mkdir -p js/abell85-wasm
    cp rust-abell85/target/wasm32-unknown-unknown/release/abell85_nbody.wasm \
       js/abell85-wasm/abell85_nbody.wasm
else
    echo "WARN: rust-abell85 build failed — serving committed js/abell85-wasm binary."
fi

# ── Build Gravity Lab N-body kernel ──────────────────────────
# Dependency-free extern "C" module (no wasm-bindgen needed): plain cargo
# build, artifact copied verbatim. The committed binary at
# js/gravity-lab/wasm/gravity_kernel.wasm serves as the fallback if this
# build ever fails on Vercel's toolchain.
echo "Building gravity-kernel WASM (Gravity Lab N-body + test particles)..."
if (cd rust-gravity && cargo build --release --target wasm32-unknown-unknown); then
    mkdir -p js/gravity-lab/wasm
    cp rust-gravity/target/wasm32-unknown-unknown/release/gravity_kernel.wasm \
       js/gravity-lab/wasm/gravity_kernel.wasm
else
    echo "WARN: rust-gravity build failed — serving committed js/gravity-lab/wasm binary."
fi

# ── Build Shielding Lab ionospheric potential solver ─────────
# Dependency-free extern "C" module (no wasm-bindgen needed): plain cargo
# build, artifact copied verbatim. The committed binary at
# js/shielding-lab/wasm/shielding_kernel.wasm serves as the fallback if
# this build ever fails on Vercel's toolchain. Physics is gated by
# `cargo test` in rust-shielding/ — run it before editing the kernel.
echo "Building shielding-kernel WASM (Shielding Lab M-I coupling solver)..."
if (cd rust-shielding && cargo build --release --target wasm32-unknown-unknown); then
    mkdir -p js/shielding-lab/wasm
    cp rust-shielding/target/wasm32-unknown-unknown/release/shielding_kernel.wasm \
       js/shielding-lab/wasm/shielding_kernel.wasm
else
    echo "WARN: rust-shielding build failed — serving committed js/shielding-lab/wasm binary."
fi

# ── Build Ring-Current transport kernel ──────────────────────
# Dependency-free extern "C" module (no wasm-bindgen): plain cargo build,
# artifact copied verbatim. The committed binary at
# js/ring-current-wasm/ring_current_kernel.wasm serves as the fallback if this
# build ever fails on Vercel's toolchain. js/ring-current-transport.js is the
# reference oracle — `cargo test` in rust-ring-current/ gates the physics, and
# node tests/ring-current-kernel-smoke.mjs pins the WASM ↔ JS agreement.
echo "Building ring-current-kernel WASM (bounce-averaged ring-current transport)..."
if (cd rust-ring-current && cargo build --release --target wasm32-unknown-unknown); then
    mkdir -p js/ring-current-wasm
    cp rust-ring-current/target/wasm32-unknown-unknown/release/ring_current_kernel.wasm \
       js/ring-current-wasm/ring_current_kernel.wasm
else
    echo "WARN: rust-ring-current build failed — serving committed js/ring-current-wasm binary."
fi

# ── Build Flux Rope Simulator forecasting engine ─────────────
# Dependency-free extern "C" module (no wasm-bindgen needed): plain cargo
# build, artifact copied verbatim. The committed binary at
# js/flux-rope-wasm/flux_rope_core.wasm serves as the fallback if this
# build ever fails on Vercel's toolchain. Physics is gated by `cargo test`
# in rust-flux-rope/ (spec: FLUX_ROPE_PHYSICS_SPEC.md); the St. Patrick's
# 2015 validation is pinned by node tests/flux-rope-kernel-smoke.mjs.
echo "Building flux-rope-core WASM (CME flux-rope forecasting engine)..."
if (cd rust-flux-rope && cargo build --release --target wasm32-unknown-unknown); then
    mkdir -p js/flux-rope-wasm
    cp rust-flux-rope/target/wasm32-unknown-unknown/release/flux_rope_core.wasm \
       js/flux-rope-wasm/flux_rope_core.wasm
else
    echo "WARN: rust-flux-rope build failed — serving committed js/flux-rope-wasm binary."
fi

# ── Build star renderer (solar flare sim) ─────────────────────
# NOT built on Vercel. The Bevy dep graph (~479 crates) is too fragile for
# Vercel's older rustc — a transitive `constant_time_eq 0.4.3` release broke
# every deploy by demanding rustc 1.95+. The pre-built wasm at
#   rust/www/star_renderer_bg.wasm
# is committed to git and served as a static asset. Rebuild locally when
# you edit rust/src/**:
#   (cd rust && cargo build --release --target wasm32-unknown-unknown \
#        && cp target/wasm32-unknown-unknown/release/star_renderer.wasm \
#             www/star_renderer_bg.wasm)
# then commit the updated rust/www/star_renderer_bg.wasm alongside your
# source change.

echo "✅ WASM build complete!"
echo "   Built:   js/sstar-wasm/    (S-star orbital propagator)"
echo "   Built:   js/forecast-wasm/ (24-hour location forecast core)"
echo "   Built:   js/gravity-lab/wasm/ (Gravity Lab N-body kernel)"
echo "   Skipped: rust/www/ star renderer — served from committed binary"
ls -lh js/sstar-wasm/*.wasm js/forecast-wasm/*.wasm 2>/dev/null || true
