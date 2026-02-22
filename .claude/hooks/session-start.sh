#!/bin/bash
# Session-start hook for Clstl_Smltr
# Ensures Rust/cargo is on PATH and the wasm32 target is available.
# No internet access required — uses the pre-installed toolchain.
set -euo pipefail

# Only run in Claude Code on the web (remote sessions)
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    exit 0
fi

# ── 1. Source the existing Rust installation ──────────────────────────────────
# rustc/cargo live at /root/.cargo/bin but are not on PATH by default in hooks.
CARGO_ENV="$HOME/.cargo/env"
if [ ! -f "$CARGO_ENV" ]; then
    echo "ERROR: ~/.cargo/env not found — Rust toolchain missing." >&2
    exit 1
fi

# shellcheck source=/dev/null
source "$CARGO_ENV"

# Persist cargo/bin for the rest of the session (all future tool calls)
echo "export PATH=\"$HOME/.cargo/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"

echo "✅ Rust $(rustc --version) available"

# ── 2. Ensure the wasm32 target is installed ─────────────────────────────────
if ! rustup target list --installed 2>/dev/null | grep -q "wasm32-unknown-unknown"; then
    echo "Adding wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
else
    echo "✅ wasm32-unknown-unknown target already installed"
fi

echo "✅ Session environment ready"
