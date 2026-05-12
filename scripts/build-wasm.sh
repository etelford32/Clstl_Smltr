#!/usr/bin/env bash
# Build the disc-hydro WASM module and copy it into the static asset tree
# where the dev server / Vercel deployment can serve it directly.
#
# Usage:  ./scripts/build-wasm.sh         (release)
#         ./scripts/build-wasm.sh debug   (debug build, faster compile)
#
# Requires:
#   * rustc + cargo with the `wasm32-unknown-unknown` target installed.
#     Set up with:  rustup target add wasm32-unknown-unknown

set -euo pipefail

PROFILE="${1:-release}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"

case "$PROFILE" in
    release)
        cargo build --release --target wasm32-unknown-unknown -p disc-hydro
        SRC="$ROOT/target/wasm32-unknown-unknown/release/disc_hydro.wasm"
        ;;
    debug)
        cargo build --target wasm32-unknown-unknown -p disc-hydro
        SRC="$ROOT/target/wasm32-unknown-unknown/debug/disc_hydro.wasm"
        ;;
    *)
        echo "unknown profile: $PROFILE (expected: release | debug)" >&2
        exit 2
        ;;
esac

OUT_DIR="$ROOT/static/hydro"
mkdir -p "$OUT_DIR"
cp -f "$SRC" "$OUT_DIR/disc_hydro.wasm"

SIZE=$(wc -c < "$OUT_DIR/disc_hydro.wasm")
printf "✅ disc_hydro.wasm  %s  (%s bytes)\n" "$PROFILE" "$SIZE"
