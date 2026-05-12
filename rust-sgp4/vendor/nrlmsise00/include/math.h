/*
 * math.h — minimal stub for the wasm32-unknown-unknown build of
 * NRLMSISE-00. Declares only the eight functions the model actually
 * uses; their definitions are provided as `extern "C"` Rust shims in
 * src/nrlmsise00.rs (forwarding to the libm crate).
 *
 * Native builds use the system math.h via cc-rs's default search path —
 * this file is only on the search path when targeting wasm32.
 */
#ifndef NRLMSIS_MATH_H
#define NRLMSIS_MATH_H

double exp   (double x);
double log   (double x);
double log10 (double x);
double sqrt  (double x);
double pow   (double x, double y);
double sin   (double x);
double cos   (double x);
double fabs  (double x);

#endif /* NRLMSIS_MATH_H */
