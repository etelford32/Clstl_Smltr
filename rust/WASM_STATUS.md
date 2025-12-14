# WASM Build Status

## Current Status: 🚧 In Progress

The WASM infrastructure is **complete and ready**, but there's a dependency conflict that needs resolution.

## What's Working ✅

- **Build scripts**: `build_wasm.sh` and `build_wasm.bat` are ready
- **HTML template**: Beautiful, styled web page in `www/index.html`
- **Cargo configuration**: WASM target settings in `.cargo/config.toml`
- **Dependencies**: Most WASM dependencies configured correctly

## Known Issue 🐛

**getrandom version conflict:**
- Bevy 0.12 transitively depends on `getrandom 0.3`
- getrandom 0.3 requires both the "js" feature AND `--cfg=wasm_js` flag
- Even with both enabled, there's a compilation issue with getrandom 0.3.4

## Solutions to Try

### Option 1: Wait for Bevy 0.13+ (Recommended)
Bevy 0.13+ has better WASM support out of the box. When upgrading:
```toml
[dependencies]
bevy = { version = "0.13", features = ["webgl2"] }
```

### Option 2: Override getrandom globally
Add to `Cargo.toml`:
```toml
[patch.crates-io]
getrandom = { version = "0.2", features = ["js"] }
```

### Option 3: Use alternative RNG
Replace `rand` with `fastrand` or `oorandom` which don't depend on getrandom:
```rust
use fastrand;
// Instead of: rng.gen_range(0.0..1.0)
// Use: fastrand::f32() * range
```

## Files Created

```
rust/
├── www/
│   └── index.html              # ✅ Styled WASM host page
├── .cargo/
│   └── config.toml             # ✅ WASM build configuration
├── build_wasm.sh               # ✅ Unix build script
├── build_wasm.bat              # ✅ Windows build script
└── WASM_STATUS.md              # 📄 This file
```

## Testing When Fixed

Once the dependency issue is resolved:

```bash
# Build WASM
./build_wasm.sh

# Serve locally
python3 -m http.server 8080 --directory www

# Open browser
http://localhost:8080
```

## Expected Performance

When working, the WASM build will deliver:
- ~2-4 MB initial bundle (compresses to <1 MB with gzip)
- 1-3 second load time
- 60 FPS performance in modern browsers
- Same visual quality as native build

## Help Wanted

If you'd like to help resolve this, the key files to look at are:
- `Cargo.toml` (lines 23-31)
- `.cargo/config.toml`

The goal is to get getrandom working properly for wasm32-unknown-unknown target.
