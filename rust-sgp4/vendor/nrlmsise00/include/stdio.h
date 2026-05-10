/*
 * stdio.h — minimal stub for wasm32 build. Declares only printf (no-op
 * implementation in c_stubs.c). NRLMSISE-00 only uses printf for error
 * messages on inputs we never feed it from our Rust wrapper.
 */
#ifndef NRLMSIS_STDIO_H
#define NRLMSIS_STDIO_H

int printf(const char* fmt, ...);

#endif /* NRLMSIS_STDIO_H */
