/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* dlopen() on the main thread syncs the threads it knows of one at a time,
 * and each sync waits, during which the main thread cleans up threads that
 * have ended. A thread cleaned up that way must be passed over, not synced
 * through its freed struct. Here a slow thread holds up its sync while a
 * detached thread with a higher address, so later in the list, ends; the
 * slow thread then takes the freed block and fills it with 0xff before it
 * lets its sync finish. argv[1] is a side module. */

#include <dlfcn.h>
#include <emscripten/threading.h>
#include <limits.h>
#include <malloc.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FREE_TIMEOUT_MS 5000
/* Long enough for a cleanup that has begun to free the block. */
#define FREE_DELAY_MS 50
/* More than a struct pthread takes. */
#define STRUCT_COVER 256
/* Long enough for dlopen() to reach its sync of the slow thread. */
#define SYNC_DELAY_MS 200

static pthread_t slow, victim;
static size_t victim_size;
static int roles_set, loading, victim_go, done;
/* Written by the slow thread before it lets its sync finish. */
static int taken;
static const char *failure;

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

/* Spins without a futex wait, so no sync runs meanwhile. */
static void spin_for_ms(double ms) {
  double end = emscripten_get_now() + ms;
  while (emscripten_get_now() < end)
    ;
}

static void hold_up_sync(void) {
  while (!load(&loading))
    ;
  spin_for_ms(SYNC_DELAY_MS);
  raise_flag(&victim_go);
  /* A struct pthread starts with a pointer to itself, which cleaning it up
   * overwrites, just before freeing it. */
  double end = emscripten_get_now() + FREE_TIMEOUT_MS;
  while (*(void *volatile *)victim == (void *)victim) {
    if (emscripten_get_now() > end) {
      failure = "the detached thread was never cleaned up";
      return;
    }
  }
  spin_for_ms(FREE_DELAY_MS);
  void *held[64];
  int count = 0;
  while (count < 64) {
    char *block = malloc(victim_size);
    /* The freed block may have merged with a free neighbour, so the new
     * block need only cover the struct. */
    if (block <= (char *)victim &&
        (char *)victim + STRUCT_COVER <= block + victim_size) {
      memset(block, 0xff, victim_size);
      taken = 1;
      break;
    }
    held[count++] = block;
  }
  for (int i = 0; i < count; i++)
    free(held[i]);
  if (!taken)
    failure = "malloc() never handed out the freed block";
}

static void *entry(void *arg) {
  wait_for(&roles_set);
  if (pthread_equal(pthread_self(), victim)) {
    wait_for(&victim_go);
    return NULL;
  }
  hold_up_sync();
  wait_for(&done);
  return NULL;
}

int main(int argc, char **argv) {
  pthread_t a, b;
  pthread_create(&a, NULL, entry, NULL);
  pthread_create(&b, NULL, entry, NULL);
  /* dlopen() syncs threads in ascending order of their pthread_t. */
  slow = a < b ? a : b;
  victim = a < b ? b : a;
  victim_size = malloc_usable_size((void *)victim);
  pthread_detach(victim);
  raise_flag(&roles_set);

  __atomic_store_n(&loading, 1, __ATOMIC_SEQ_CST);
  void *side = dlopen(argv[1], RTLD_NOW);
  int failures = 0;
  if (side == NULL) {
    printf("FAIL: dlopen: %s\n", dlerror());
    failures++;
  }
  raise_flag(&done);
  pthread_join(slow, NULL);
  if (failure != NULL) {
    printf("FAIL: %s\n", failure);
    failures++;
  } else if (!taken) {
    printf("FAIL: the sync didn't wait for the slow thread\n");
    failures++;
  }
  printf("%d failures\n", failures);
  return failures != 0;
}
