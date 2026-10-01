/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* An exit() that reaches the main thread while dlopen() syncs threads ends
 * the program with its own status, even with a thread's cleanup pending:
 * the runtime has torn its threads down by then, and cleaning one up must
 * not be what reports the end. A slow thread holds up its own sync while a
 * detached thread ends, then has a third thread call exit(42). argv[1] is
 * a side module. */

#include <dlfcn.h>
#include <emscripten/threading.h>
#include <limits.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

#define TIMEOUT_MS 5000
/* Long enough for an ended thread to hand its cleanup to the main thread. */
#define EXIT_DELAY_MS 100
#define STATUS 42

/* Created by dlopen()'s first sync of another thread. */
extern void *_Atomic _dlopen_proxying_queue;

static pthread_t slow, victim, exiter;
static int roles_set, victim_go, victim_exiting, exit_go;

static int load(int *flag) { return __atomic_load_n(flag, __ATOMIC_SEQ_CST); }

static void raise_flag(int *flag) {
  __atomic_store_n(flag, 1, __ATOMIC_SEQ_CST);
  emscripten_futex_wake(flag, INT_MAX);
}

/* Waits in futex waits, which also run the syncs dlopen() asks for. */
static void wait_for(int *flag) {
  while (!load(flag))
    emscripten_futex_wait(flag, 0, INFINITY);
}

/* Spins without a futex wait, so this thread's own sync stays pending. */
static int spin_until(int (*done)(void)) {
  double end = emscripten_get_now() + TIMEOUT_MS;
  while (!done())
    if (emscripten_get_now() > end)
      return 0;
  return 1;
}

static int syncing(void) { return _dlopen_proxying_queue != NULL; }
static int victim_ended(void) { return load(&victim_exiting); }
static int never(void) { return 0; }

static void hold_up_sync(void) {
  if (!spin_until(syncing)) {
    printf("FAIL: dlopen() never started syncing\n");
    exit(1);
  }
  raise_flag(&victim_go);
  if (!spin_until(victim_ended)) {
    printf("FAIL: the victim never ended\n");
    exit(1);
  }
  double end = emscripten_get_now() + EXIT_DELAY_MS;
  while (emscripten_get_now() < end)
    ;
  printf("exiting while dlopen() syncs\n");
  fflush(stdout);
  raise_flag(&exit_go);
  spin_until(never);
  printf("FAIL: the program didn't exit\n");
  exit(1);
}

static void *entry(void *arg) {
  wait_for(&roles_set);
  pthread_t self = pthread_self();
  if (pthread_equal(self, slow)) {
    hold_up_sync();
  } else if (pthread_equal(self, victim)) {
    wait_for(&victim_go);
    raise_flag(&victim_exiting);
  } else {
    wait_for(&exit_go);
    exit(STATUS);
  }
  return NULL;
}

int main(int argc, char **argv) {
  pthread_t t[3];
  for (int i = 0; i < 3; i++)
    pthread_create(&t[i], NULL, entry, NULL);
  /* dlopen() syncs threads in ascending order of their pthread_t, and the
   * first sync creates the dlopen queue. */
  for (int i = 0; i < 3; i++)
    for (int j = i + 1; j < 3; j++)
      if (t[j] < t[i]) {
        pthread_t swap = t[i];
        t[i] = t[j];
        t[j] = swap;
      }
  slow = t[0];
  victim = t[1];
  exiter = t[2];
  pthread_detach(victim);
  pthread_detach(exiter);
  raise_flag(&roles_set);

  dlopen(argv[1], RTLD_NOW);
  printf("FAIL: dlopen() returned\n");
  return 1;
}
