#!/bin/bash
# Session-start hook for Clstl_Smltr
# Ensures Rust/cargo is on PATH and the wasm32 target is available.
# No internet access required — uses the pre-installed toolchain.
set -euo pipefail

# Only run in Claude Code on the web (remote sessions)
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    exit 0
fi

# ── 1. Locate and source the existing Rust installation ──────────────────────
# Two known layouts:
#   ~/.cargo/bin  — rustup default (dev / Claude Code web sessions)
#   /rust/bin     — pre-installed toolchain in Vercel / some cloud images
RUST_BIN=""
if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.cargo/env"
    RUST_BIN="$HOME/.cargo/bin"
elif [ -d "/rust/bin" ] && [ -x "/rust/bin/rustc" ]; then
    export PATH="/rust/bin:$PATH"
    RUST_BIN="/rust/bin"
fi

if ! command -v rustc &>/dev/null; then
    echo "ERROR: rustc not found at ~/.cargo/bin or /rust/bin — Rust toolchain missing." >&2
    exit 1
fi

# Persist the resolved bin dir for all subsequent tool calls in this session
echo "export PATH=\"${RUST_BIN}:\$PATH\"" >> "$CLAUDE_ENV_FILE"

echo "✅ Rust $(rustc --version) available"

# ── 2. Ensure the wasm32 target is installed ─────────────────────────────────
if ! rustup target list --installed 2>/dev/null | grep -q "wasm32-unknown-unknown"; then
    echo "Adding wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
else
    echo "✅ wasm32-unknown-unknown target already installed"
fi

echo "✅ Session environment ready"
