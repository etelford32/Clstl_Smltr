@echo off
REM Celestial Star Renderer - WASM Build Script (Windows)

echo Building Celestial Star Renderer for WASM...
echo.

echo [1/5] Checking for wasm32-unknown-unknown target...
rustup target add wasm32-unknown-unknown

echo.
echo [2/5] Checking for wasm-bindgen-cli...
where wasm-bindgen >nul 2>nul
if %errorlevel% neq 0 (
    echo Installing wasm-bindgen-cli...
    cargo install wasm-bindgen-cli
) else (
    echo wasm-bindgen-cli already installed
)

echo.
echo [3/5] Building WASM binary (release mode)...
cargo build --release --target wasm32-unknown-unknown

echo.
echo [4/5] Generating JavaScript bindings...
wasm-bindgen --out-dir www --target web target/wasm32-unknown-unknown/release/star_renderer.wasm

echo.
echo [5/5] Build complete!
echo.
echo Output directory: www\
echo.
echo To test locally, run:
echo   python -m http.server 8080 --directory www
echo.
echo Then open: http://localhost:8080
echo.
pause
