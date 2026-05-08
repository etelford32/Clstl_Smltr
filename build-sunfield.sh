#!/bin/bash
# Build solar field-line tracer (PFSS-lite) → WASM + JS glue
set -e

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
[ -d "/rust/bin" ] && export PATH="/rust/bin:$PATH"

rustup target add wasm32-unknown-unknown 2>/dev/null || true

cd "$(dirname "$0")/rust-sunfield"
echo "Building sunfield_wasm (release, wasm32)..."
cargo build --release --target wasm32-unknown-unknown

echo "Generating JS bindings..."
wasm-bindgen "target/wasm32-unknown-unknown/release/sunfield_wasm.wasm" \
  --out-dir "../js/sunfield-wasm" \
  --target web \
  --no-typescript

echo "✅ sunfield WASM built → js/sunfield-wasm/"
ls -lh "../js/sunfield-wasm/"
