#!/bin/bash
# Build S-star orbital engine → WASM + JS glue
set -e

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
[ -d "/rust/bin" ] && export PATH="/rust/bin:$PATH"

rustup target add wasm32-unknown-unknown 2>/dev/null || true

cd "$(dirname "$0")/rust-sstar"
echo "Building sstar_wasm (release, wasm32)..."
cargo build --release --target wasm32-unknown-unknown

echo "Generating JS bindings..."
wasm-bindgen "target/wasm32-unknown-unknown/release/sstar_wasm.wasm" \
  --out-dir "../js/sstar-wasm" \
  --target web \
  --no-typescript

echo "✅ S-star WASM built → js/sstar-wasm/"
ls -lh "../js/sstar-wasm/"
