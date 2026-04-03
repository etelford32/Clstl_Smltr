#!/bin/bash
# Build the SGP4 WASM module
set -e

echo "Building SGP4 WASM propagator..."

if ! command -v rustc &> /dev/null; then
    echo "ERROR: rustc not found. Install Rust from https://rustup.rs" >&2
    exit 1
fi

# Ensure wasm32 target
if ! rustup target list 2>/dev/null | grep -q "wasm32-unknown-unknown (installed)"; then
    echo "Adding wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
fi

# Build
cargo build --release --target wasm32-unknown-unknown

# Copy output
mkdir -p www
cp target/wasm32-unknown-unknown/release/sgp4_wasm.wasm www/sgp4_wasm_bg.wasm

# Optimize if wasm-opt available
if command -v wasm-opt &> /dev/null; then
    wasm-opt -Oz www/sgp4_wasm_bg.wasm -o www/sgp4_wasm_bg.wasm
    echo "wasm-opt applied"
fi

echo "SGP4 WASM build complete: $(ls -lh www/sgp4_wasm_bg.wasm | awk '{print $5}')"
