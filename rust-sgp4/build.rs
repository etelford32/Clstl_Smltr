// build.rs — Compile vendored NRLMSISE-00 C source into the cdylib.
//
// The C package (Brodowski 2002, derived from Picone/Hedin/Drob's NRL
// Fortran) lives in vendor/nrlmsise00/. We compile two files:
//
//   nrlmsise-00.c       — model code (gtd7, gts7, ghp7, helpers)
//   nrlmsise-00_data.c  — coefficient tables (~1200 lines of doubles)
//
// Plus our small `c_stubs.c` providing the libc symbols (printf, malloc,
// free) that the model touches but wasm32-unknown-unknown doesn't supply.
// Math symbols (exp, log, sin, cos, sqrt, pow, fabs, log10) are exported
// from src/nrlmsise00.rs as `extern "C"` shims forwarding to the libm
// crate, so the C linker resolves them at link time.
//
// Builds for both native (host) and wasm32-unknown-unknown. cc-rs picks
// the correct compiler from the target triple — on wasm32 it uses clang
// with `--target=wasm32-unknown-unknown` and `-nostdlib`.

use std::env;
use std::path::PathBuf;

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    let is_wasm = target.starts_with("wasm32-");
    let vendor = PathBuf::from("vendor/nrlmsise00");

    let mut build = cc::Build::new();
    build
        .file(vendor.join("nrlmsise-00.c"))
        .file(vendor.join("nrlmsise-00_data.c"))
        .file(vendor.join("c_stubs.c"))
        .include(&vendor)
        .warnings(false)            // upstream code is clean but old-style
        .extra_warnings(false)
        .opt_level(2)
        // `INLINE` enables Brodowski's `static inline double` trick for
        // hot helpers (densu, densm, ccor, ...). Speeds the model up
        // ~2× at the cost of ~5 KB binary size — worth it for our
        // per-altitude inner loop.
        .define("INLINE", None);

    if is_wasm {
        // No libc on wasm32-unknown-unknown. Tell clang not to look for
        // one and not to emit calls into builtins that need libc.
        // Our minimal `vendor/nrlmsise00/include/` carries math.h /
        // stdio.h / stdlib.h stubs declaring only the symbols the
        // model actually touches; their bodies live in c_stubs.c
        // (printf/malloc/free) and src/nrlmsise00.rs (libm).
        build
            .flag("-nostdlibinc")
            .flag("-nostdlib")
            .flag("-fno-builtin")
            .flag("-fvisibility=hidden")
            .include(vendor.join("include"))
            // `-Wno-everything` silences upstream's K&R-era cast warnings.
            .flag_if_supported("-Wno-everything");
    }

    build.compile("nrlmsise00");

    println!("cargo:rerun-if-changed=vendor/nrlmsise00/nrlmsise-00.c");
    println!("cargo:rerun-if-changed=vendor/nrlmsise00/nrlmsise-00_data.c");
    println!("cargo:rerun-if-changed=vendor/nrlmsise00/nrlmsise-00.h");
    println!("cargo:rerun-if-changed=vendor/nrlmsise00/c_stubs.c");
    println!("cargo:rerun-if-changed=build.rs");
}
