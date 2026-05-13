#!/bin/bash
# Build Sirius A+B binary physics engine → WASM + JS glue
#
#   • Kepler equation + 1PN periastron precession
#   • Peters–Mathews quadrupole GW strain (h+, h×) and dE/dt
#   • Bondi–Hoyle–Lyttleton wind accretion onto Sirius B
#   • Thermal bremsstrahlung + Planck composite SED at Earth
set -e

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
[ -d "/rust/bin" ] && export PATH="/rust/bin:$PATH"

rustup target add wasm32-unknown-unknown 2>/dev/null || true

cd "$(dirname "$0")/rust-sirius"
echo "Building sirius_wasm (release, wasm32)..."
cargo build --release --target wasm32-unknown-unknown

echo "Generating JS bindings..."
wasm-bindgen "target/wasm32-unknown-unknown/release/sirius_wasm.wasm" \
  --out-dir "../js/sirius-wasm" \
  --target web \
  --no-typescript

echo "Sirius WASM built → js/sirius-wasm/"
ls -lh "../js/sirius-wasm/"
