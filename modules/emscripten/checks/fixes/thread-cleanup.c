/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Threads that end without being joined on the main thread, detached ones
 * and ones another thread joins, are reclaimed while the main thread stays
 * blocked: their memory is freed and their Workers go back to the pool
 * without the main thread returning to its event loop. */

#include <emscripten/em_js.h>
#include <emscripten/threading.h>
#include <limits.h>
#include <malloc.h>
#include <pthread.h>
#include <stdio.h>

#define ROUNDS 8
/* Each round's threads: half end detached, half join a child of their own
 * first, so a round runs up to 1.5 × THREADS threads at once. */
#define THREADS 4
#define AT_ONCE (THREADS + THREADS / 2)
#define STACK_SIZE (256 * 1024)

/* Workers the runtime holds, idle or hosting a thread. */
EM_JS(int, worker_count, (void), {
  return PThread.unusedWorkers.length + Object.keys(PThread.pthreads).length;
});

static pthread_attr_t attr;
static int finished;

static void *finish(void *arg) {
  __atomic_fetch_add(&finished, 1, __ATOMIC_SEQ_CST);
  emscripten_futex_wake(&finished, INT_MAX);
  return NULL;
}

static void *join_child(void *arg) {
  pthread_t child;
  if (pthread_create(&child, &attr, finish, NULL) == 0)
    pthread_join(child, NULL);
  return finish(NULL);
}

/* Blocks without returning to the event loop. */
static void block_for(double ms) {
  static int never;
  double end = emscripten_get_now() + ms;
  for (double left = ms; left > 0; left = end - emscripten_get_now())
    emscripten_futex_wait(&never, 0, left);
}

static size_t in_use(void) { return mallinfo().uordblks; }

static void run_round(void) {
  int target = __atomic_load_n(&finished, __ATOMIC_SEQ_CST) + AT_ONCE;
  for (int i = 0; i < THREADS; i++) {
    pthread_t thread;
    pthread_create(&thread, &attr, i % 2 ? join_child : finish, NULL);
    pthread_detach(thread);
  }
  for (int now; (now = __atomic_load_n(&finished, __ATOMIC_SEQ_CST)) < target;)
    emscripten_futex_wait(&finished, now, 1000);
}

int main(void) {
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, STACK_SIZE);
  /* The pool, plus a new Worker for each thread it can't cover. */
  int max_workers = worker_count() + AT_ONCE;

  /* One round warms up whatever the runtime allocates once. */
  run_round();
  block_for(200);
  size_t baseline = in_use();
  int failures = 0;
  for (int round = 1; round < ROUNDS; round++) {
    run_round();
    double deadline = emscripten_get_now() + 5000;
    while (in_use() > baseline + STACK_SIZE / 2 &&
           emscripten_get_now() < deadline)
      block_for(5);
    size_t used = in_use();
    int workers = worker_count();
    printf("round %d: %zu bytes in use (baseline %zu), %d workers\n", round,
           used, baseline, workers);
    if (used > baseline + STACK_SIZE / 2) {
      printf("FAIL: round %d's threads still hold memory\n", round);
      failures++;
    }
    if (workers > max_workers) {
      printf("FAIL: %d workers, more than the %d to start with plus %d "
             "threads at once\n",
             workers, max_workers - AT_ONCE, AT_ONCE);
      failures++;
    }
  }
  printf("%d failures\n", failures);
  return failures != 0;
}
