/*
 * stdlib.h — minimal stub for wasm32 build. Declares only malloc / free
 * (bump-allocator implementations in c_stubs.c).
 */
#ifndef NRLMSIS_STDLIB_H
#define NRLMSIS_STDLIB_H

#ifndef NULL
#define NULL ((void*)0)
#endif

void* malloc(unsigned long size);
void  free  (void* ptr);

#endif /* NRLMSIS_STDLIB_H */
