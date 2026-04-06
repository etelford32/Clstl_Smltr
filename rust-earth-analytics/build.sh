#!/bin/bash
# Build earth-analytics WASM module
# Output: ../js/earth-ecs-wasm/ (pkg directory consumed by the JS bridge)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/../js/earth-ecs-wasm"

echo "🔧 Building earth_analytics_ecs → WASM (release)..."

# Check for wasm-pack
if ! command -v wasm-pack &> /dev/null; then
    echo "📦 Installing wasm-pack..."
    cargo install wasm-pack
fi

cd "$SCRIPT_DIR"

wasm-pack build \
    --target web \
    --out-dir "$OUT_DIR" \
    --release

# Clean up unnecessary wasm-pack files
rm -f "$OUT_DIR/.gitignore" "$OUT_DIR/package.json" "$OUT_DIR/README.md"

echo ""
echo "✅ WASM build complete → $OUT_DIR"
ls -lh "$OUT_DIR"/*.wasm "$OUT_DIR"/*.js 2>/dev/null || true
