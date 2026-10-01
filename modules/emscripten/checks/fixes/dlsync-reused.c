/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* A running thread whose pthread_t belonged to a thread joined just before
 * still takes part in dlopen()'s sync, and can call into the new module.
 * The joined thread's message that it had finished reaches the main thread
 * only once the main thread has joined it, cleaned it up and created the
 * new thread at the same address. argv[1] is the side module. */

#include <dlfcn.h>
#include <emscripten/em_js.h>
#include <emscripten/eventloop.h>
#include <emscripten/threading.h>
#include <limits.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

/* Whether dlopen()'s sync would skip thread as finished. */
EM_JS(int, marked_finished, (pthread_t thread),
      { return PThread.finishedThreads.has(thread) ? 1 : 0; });

static const char *side_path;
static pthread_t waiter;
static int go;
static int (*value)(void);
static int result;

static int own_value(void) { return 42; }

static void *quit(void *arg) { return NULL; }

static void *wait_then_call(void *arg) {
  while (__atomic_load_n(&go, __ATOMIC_SEQ_CST) == 0)
    emscripten_futex_wait(&go, 0, INFINITY);
  result = value();
  return NULL;
}

static void release_waiter(void) {
  __atomic_store_n(&go, 1, __ATOMIC_SEQ_CST);
  emscripten_futex_wake(&go, INT_MAX);
  pthread_join(waiter, NULL);
  go = 0;
}

/* Runs once the event loop has delivered the joined thread's message. */
static void load_and_call(void *arg) {
  int failures = 0;
  if (marked_finished(waiter)) {
    printf("FAIL: the running thread is marked finished\n");
    failures++;
  }
  void *side = dlopen(side_path, RTLD_NOW);
  if (side == NULL) {
    printf("FAIL: dlopen: %s\n", dlerror());
    exit(1);
  }
  value = (int (*)(void))dlsym(side, "side_value");
  /* A thread the sync skipped traps here. */
  release_waiter();
  if (result != 42) {
    printf("FAIL: the thread got %d from the side module\n", result);
    failures++;
  }
  printf("%d failures\n", failures);
  exit(failures != 0);
}

int main(int argc, char **argv) {
  side_path = argv[1];
  for (int attempt = 0; attempt < 10; attempt++) {
    pthread_t joined;
    pthread_create(&joined, NULL, quit, NULL);
    /* Cleans the thread up at once, its message still queued. */
    pthread_join(joined, NULL);
    pthread_create(&waiter, NULL, wait_then_call, NULL);
    if (pthread_equal(waiter, joined)) {
      printf("pthread_t reused on attempt %d\n", attempt + 1);
      emscripten_set_timeout(load_and_call, 100, NULL);
      return 0;
    }
    value = own_value;
    release_waiter();
  }
  printf("FAIL: no new thread reused a joined thread's pthread_t\n");
  return 1;
}
