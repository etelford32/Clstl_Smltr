#!/bin/bash

# Celestial Star Renderer - WASM Build Script
# This script builds the Rust project for WebAssembly deployment

set -e  # Exit on error

echo "🌟 Building Celestial Star Renderer for WASM..."
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if wasm32 target is installed
echo -e "${BLUE}[1/5]${NC} Checking for wasm32-unknown-unknown target..."
if ! rustup target list | grep -q "wasm32-unknown-unknown (installed)"; then
    echo -e "${YELLOW}Installing wasm32-unknown-unknown target...${NC}"
    rustup target add wasm32-unknown-unknown
else
    echo -e "${GREEN}✓${NC} Target already installed"
fi

# Check if wasm-bindgen-cli is installed
echo ""
echo -e "${BLUE}[2/5]${NC} Checking for wasm-bindgen-cli..."
if ! command -v wasm-bindgen &> /dev/null; then
    echo -e "${YELLOW}Installing wasm-bindgen-cli...${NC}"
    cargo install wasm-bindgen-cli
else
    echo -e "${GREEN}✓${NC} wasm-bindgen-cli already installed"
fi

# Build the WASM binary
echo ""
echo -e "${BLUE}[3/5]${NC} Building WASM binary (release mode)..."
cargo build --release --target wasm32-unknown-unknown

# Generate JS bindings
echo ""
echo -e "${BLUE}[4/5]${NC} Generating JavaScript bindings..."
wasm-bindgen --out-dir www --target web \
    target/wasm32-unknown-unknown/release/star_renderer.wasm

# Copy index.html if it doesn't exist
echo ""
echo -e "${BLUE}[5/5]${NC} Setting up web directory..."
if [ ! -f "www/index.html" ]; then
    echo -e "${YELLOW}Warning: www/index.html not found${NC}"
fi

# Get the WASM file size
WASM_SIZE=$(du -h www/star_renderer_bg.wasm | cut -f1)

echo ""
echo -e "${GREEN}✨ Build complete!${NC}"
echo ""
echo "📊 WASM bundle size: ${WASM_SIZE}"
echo "📁 Output directory: www/"
echo ""
echo "To test locally, run:"
echo -e "  ${YELLOW}python3 -m http.server 8080 --directory www${NC}"
echo "  or"
echo -e "  ${YELLOW}cd www && npx serve${NC}"
echo ""
echo "Then open: http://localhost:8080"
echo ""
