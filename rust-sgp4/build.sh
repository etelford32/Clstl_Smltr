#!/bin/bash
# Build the SGP4 + NRLMSISE-00 WASM module
#
# Compiles the Rust crate (which also pulls in the vendored Brodowski C
# port via build.rs + cc-rs), then runs wasm-bindgen to regenerate
# js/sgp4-wasm/sgp4_wasm.js so the JS exports match the current Rust
# #[wasm_bindgen] surface, and finally wasm-opt -Oz for size if available.
set -e

# Always run from the script's directory regardless of caller cwd, so
# `bash rust-sgp4/build.sh` from the repo root works the same as
# running from inside rust-sgp4/.
cd "$(dirname "$0")"

WASM_BINDGEN_VERSION="0.2.120"   # must match Cargo.lock

echo "Building SGP4+NRLMSISE-00 WASM propagator..."

if ! command -v rustc &> /dev/null; then
    echo "ERROR: rustc not found. Install Rust from https://rustup.rs" >&2
    exit 1
fi

# Ensure wasm32 target.
if ! rustup target list 2>/dev/null | grep -q "wasm32-unknown-unknown (installed)"; then
    echo "Adding wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
fi

# Ensure clang is available — cc-rs needs it for the wasm32 C compile of
# vendor/nrlmsise00/*.c. Most CI images already have it; flag clearly if
# missing because the failure mode otherwise looks like a Rust build
# error rather than a missing-toolchain error.
if ! command -v clang &> /dev/null; then
    echo "ERROR: clang not found — required to compile vendored NRLMSISE-00 C source for wasm32." >&2
    echo "Install: apt-get install -y clang  (or brew install llvm)" >&2
    exit 1
fi

# Ensure wasm-bindgen-cli matches the wasm-bindgen crate pin. wasm-bindgen
# is strict about CLI/crate version match — mismatches yield "wasm-bindgen
# version mismatch" at runtime. We resolve to the pinned version to keep
# CI builds reproducible.
if ! command -v wasm-bindgen &> /dev/null \
   || ! wasm-bindgen --version | grep -q "$WASM_BINDGEN_VERSION"; then
    echo "Installing wasm-bindgen-cli $WASM_BINDGEN_VERSION..."
    cargo install wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION" --locked
fi

# 1. Compile the cdylib + vendored C.
cargo build --release --target wasm32-unknown-unknown

# 2. Run wasm-bindgen to regenerate the JS glue alongside the .wasm.
mkdir -p ../js/sgp4-wasm
wasm-bindgen --target web --out-dir ../js/sgp4-wasm --no-typescript \
    target/wasm32-unknown-unknown/release/sgp4_wasm.wasm

# 3. Optional shrink. wasm-opt isn't on every dev machine; just skip if
# missing — bindgen output is already reasonable.
if command -v wasm-opt &> /dev/null; then
    wasm-opt -Oz ../js/sgp4-wasm/sgp4_wasm_bg.wasm \
             -o ../js/sgp4-wasm/sgp4_wasm_bg.wasm
    echo "wasm-opt -Oz applied"
fi

SIZE=$(ls -lh ../js/sgp4-wasm/sgp4_wasm_bg.wasm | awk '{print $5}')
echo "WASM build complete: $SIZE"
