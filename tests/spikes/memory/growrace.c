/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* One thread grows a shared memory a page at a time and publishes the last
 * word of each new page; other threads atomically increment each word they
 * see published. The atomic store comes after the growth and the increment
 * after seeing it, so every increment is of memory the reader has seen
 * grown. */

#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#define PAGE 65536

static _Atomic(uintptr_t) published;
static atomic_int stop;

static void *reader(void *arg) {
  (void)arg;
  uintptr_t last = 0;
  uintptr_t loads = 0;
  while (!atomic_load(&stop)) {
    uintptr_t address = atomic_load(&published);
    if (address != last) {
      atomic_fetch_add((_Atomic uint32_t *)address, 1);
      last = address;
      loads++;
    }
  }
  return (void *)loads;
}

int main(int argc, char **argv) {
  int readers = argc > 1 ? atoi(argv[1]) : 8;
  int pages = argc > 2 ? atoi(argv[2]) : 4096;
  pthread_t threads[64];
  if (readers > 64)
    readers = 64;
  for (int i = 0; i < readers; i++)
    pthread_create(&threads[i], NULL, reader, NULL);
  int grown = 0;
  for (; grown < pages; grown++) {
    size_t old = __builtin_wasm_memory_grow(0, 1);
    if (old == SIZE_MAX)
      break;
    atomic_store(&published, old * PAGE + PAGE - sizeof(uint32_t));
  }
  atomic_store(&stop, 1);
  uintptr_t loads = 0;
  for (int i = 0; i < readers; i++) {
    void *n;
    pthread_join(threads[i], &n);
    loads += (uintptr_t)n;
  }
  printf("grown %d pages, %lu loads by %d readers\n", grown,
         (unsigned long)loads, readers);
  return 0;
}
