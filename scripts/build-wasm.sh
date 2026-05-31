#!/usr/bin/env bash
# Build the freestanding WASM kernels (disc-hydro, jovian-grs) and copy them
# into the static asset tree where the dev server / Vercel deployment can
# serve them directly.
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
    release) FLAG="--release"; SUB="release" ;;
    debug)   FLAG="";          SUB="debug"   ;;
    *)
        echo "unknown profile: $PROFILE (expected: release | debug)" >&2
        exit 2
        ;;
esac

# crate package → built wasm name → static/<subdir>/
build_one() {
    local pkg="$1" wasm="$2" outdir="$3"
    # shellcheck disable=SC2086
    cargo build $FLAG --target wasm32-unknown-unknown -p "$pkg"
    local src="$ROOT/target/wasm32-unknown-unknown/$SUB/$wasm.wasm"
    local dir="$ROOT/static/$outdir"
    mkdir -p "$dir"
    cp -f "$src" "$dir/$wasm.wasm"
    local size; size=$(wc -c < "$dir/$wasm.wasm")
    printf "✅ %s.wasm  %s  (%s bytes)\n" "$wasm" "$PROFILE" "$size"
}

build_one disc-hydro disc_hydro hydro
build_one jovian-grs jovian_grs grs
