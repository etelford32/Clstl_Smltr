fn main() {
    // Enable getrandom's WASM JS backend for wasm32 targets
    if std::env::var("CARGO_CFG_TARGET_ARCH").unwrap() == "wasm32" {
        println!("cargo:rustc-cfg=wasm_js");
        println!("cargo:rustc-cfg=web_sys_unstable_apis");
    }
}
