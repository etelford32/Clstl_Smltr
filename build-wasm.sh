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
echo "   Skipped: rust/www/ star renderer — served from committed binary"
ls -lh js/sstar-wasm/*.wasm js/forecast-wasm/*.wasm 2>/dev/null || true
