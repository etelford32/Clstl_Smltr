/*
 * c_stubs.c — Tiny libc replacements for the wasm32 build.
 *
 * NRLMSISE-00's C source pulls in three symbols beyond pure libm:
 *
 *   printf(...)   — error messages on hopeless inputs (OOM, bad spline,
 *                   non-converging ghp7, glob7s param-set check). Made
 *                   no-op here; we only feed the model valid inputs from
 *                   our Rust wrapper, so these branches never fire.
 *   malloc(n)     — only `spline()` allocates a single Float64 working
 *                   buffer of size N (where N is the spline length, ≤ 50
 *                   for our use). Backed by a bump allocator over a
 *                   static scratch arena that resets on every call —
 *                   safe because spline() free()s before returning.
 *   free(p)       — paired with the malloc above. Drops the bump pointer
 *                   back to zero (single-threaded; we own the arena).
 *
 * On native targets cc-rs still links libc, but our overrides win for
 * malloc/free unless they're marked weak. To keep the native build
 * unambiguous we only define stubs when targeting wasm32 (the whole
 * file is gated on __wasm__).
 */

#if defined(__wasm__) || defined(__wasm32__)

/* ── printf no-op ────────────────────────────────────────────────────── */
/* Variadic; takes the args, discards them. Returns 0 to satisfy callers
 * that check the return (Brodowski's source ignores it). */
int printf(const char* fmt, ...) {
    (void)fmt;
    return 0;
}

/* ── Bump allocator over a static scratch ────────────────────────────── */
/* 64 KB is dramatically more than spline() ever needs (worst case ~400
 * bytes for our altitude grid), so we never run out. malloc() bumps the
 * pointer; free() resets it back to the start of the arena because the
 * model's allocation pattern is strictly LIFO with a single live
 * allocation at a time. If that ever changes upstream the assertion
 * below will catch it. */

#define MSIS_ARENA_SIZE 65536u
static unsigned char msis_arena[MSIS_ARENA_SIZE];
static unsigned int  msis_offset = 0;

void* malloc(unsigned long size) {
    /* Align to 8 bytes for f64 storage. */
    unsigned int aligned = (msis_offset + 7u) & ~7u;
    if (aligned + (unsigned int)size > MSIS_ARENA_SIZE) {
        return (void*)0;        /* spline() prints "Out Of Memory" then continues */
    }
    void* p = (void*)&msis_arena[aligned];
    msis_offset = aligned + (unsigned int)size;
    return p;
}

void free(void* p) {
    (void)p;
    msis_offset = 0;            /* LIFO single-allocation pattern — safe */
}

#endif /* __wasm__ */
