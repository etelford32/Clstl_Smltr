#!/bin/bash
# Build the Rust SGP4 WASM module and copy output to js/sgp4-wasm/
set -e

echo "Building Rust SGP4 WASM..."

# Ensure Rust is on PATH
if [ -f "$HOME/.cargo/env" ]; then source "$HOME/.cargo/env"; fi
if [ -d "/rust/bin" ]; then export PATH="/rust/bin:$PATH"; fi

if ! command -v rustc &> /dev/null; then
    echo "ERROR: rustc not found. Install from https://rustup.rs" >&2
    exit 1
fi

# Add wasm32 target if needed
if ! rustup target list 2>/dev/null | grep -q "wasm32-unknown-unknown (installed)"; then
    rustup target add wasm32-unknown-unknown
fi

# Build
cd "$(dirname "$0")/rust-sgp4"
cargo build --release --target wasm32-unknown-unknown

# Generate JS bindings
if ! command -v wasm-bindgen &> /dev/null; then
    echo "Installing wasm-bindgen-cli..."
    cargo install wasm-bindgen-cli
fi

WASM_FILE="target/wasm32-unknown-unknown/release/sgp4_wasm.wasm"
OUT_DIR="../js/sgp4-wasm"
mkdir -p "$OUT_DIR"

wasm-bindgen "$WASM_FILE" --out-dir "$OUT_DIR" --target web --no-typescript

echo "SGP4 WASM build complete:"
ls -lh "$OUT_DIR"/*.wasm "$OUT_DIR"/*.js
echo "WASM size: $(du -h "$OUT_DIR/sgp4_wasm_bg.wasm" | cut -f1)"
