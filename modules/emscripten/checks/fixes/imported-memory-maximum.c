/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Linked without memory growth, but importing a memory declared up to a
 * maximum above its initial size, and given one between the two: the heap
 * spans the memory given, on every thread, and never grows past it. Takes
 * the size the memory was given, in MiB. */

#include <emscripten/heap.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MiB (1024 * 1024)

static size_t given;
/* Where allocations go, so the compiler can't take them for unused and drop
 * them, or assume they succeed. */
static void *volatile sink;

/* Half the memory given: in the larger memories, more than the initial size
 * holds. */
static void *allocate(void *arg) {
  size_t size = given / 2;
  sink = malloc(size);
  if (sink == NULL)
    return "a thread's allocation beyond the initial size failed";
  memset(sink, 1, size);
  free(sink);
  return NULL;
}

int main(int argc, char **argv) {
  given = (size_t)atoi(argv[1]) * MiB;
  int failures = 0;

  if (emscripten_get_heap_max() != given) {
    printf("heap max %zu, not the %zu given\n", emscripten_get_heap_max(),
           given);
    failures++;
  }

  pthread_t thread;
  void *error;
  pthread_create(&thread, NULL, allocate, NULL);
  pthread_join(thread, &error);
  if (error != NULL) {
    printf("%s\n", (const char *)error);
    failures++;
  }

  /* Never grows: an allocation the heap can't hold fails. */
  sink = malloc(given);
  if (sink != NULL) {
    printf("an allocation of the whole memory succeeded\n");
    failures++;
  }
  if (emscripten_get_heap_max() != given) {
    printf("heap max %zu after a failed allocation\n",
           emscripten_get_heap_max());
    failures++;
  }
  return failures;
}
