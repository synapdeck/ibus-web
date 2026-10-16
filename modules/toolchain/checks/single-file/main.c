/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>

static void *twice(void *arg) {
  int (*side)(void) = arg;
  return (void *)(long)(2 * side());
}

/* Loads the side module named by argv[1] and calls it from a pthread, so the
 * program's Workers load it too. */
int main(int argc, char **argv) {
  if (argc != 2)
    return 1;

  void *handle = dlopen(argv[1], RTLD_NOW);
  if (handle == NULL) {
    fprintf(stderr, "%s\n", dlerror());
    return 2;
  }

  int (*side)(void) = (int (*)(void))dlsym(handle, "side");
  if (side == NULL)
    return 3;

  pthread_t thread;
  void *result = NULL;
  if (pthread_create(&thread, NULL, twice, (void *)side) != 0)
    return 4;
  if (pthread_join(thread, &result) != 0)
    return 5;

  printf("main %ld\n", (long)result);
  return 0;
}
