/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* dlopen() on the main thread syncs the threads it knows of one at a time,
 * and each sync waits. A thread later in its list that ends during an
 * earlier thread's sync must not be cleaned up, and so freed, before the
 * sync reaches it; it is cleaned up as soon as the sync is done. Here a slow
 * thread holds up its own sync while a detached thread with a higher
 * address ends; if that thread is freed meanwhile, the slow thread fills its
 * block with 0xff before it lets its sync finish. argv[1] is a side
 * module. */

#include <dlfcn.h>
#include <emscripten/threading.h>
#include <limits.h>
#include <malloc.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>

#define TIMEOUT_MS 5000
/* How long the freed block may take to appear, if it is freed at all. */
#define FREE_WAIT_MS 300
/* Long enough for a cleanup that has begun to free the block. */
#define FREE_DELAY_MS 50
/* More than a struct pthread takes. */
#define STRUCT_COVER 256

/* Created by dlopen()'s first sync of another thread. */
extern void *_Atomic _dlopen_proxying_queue;

static pthread_t slow, victim;
static size_t victim_size;
static int roles_set, victim_go, victim_exiting, done;
/* Written by the slow thread before it lets its sync finish. */
static int held_sync, freed_during_sync, refilled;
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

static void spin_for_ms(double ms) {
  double end = emscripten_get_now() + ms;
  while (emscripten_get_now() < end)
    ;
}

/* A struct pthread starts with a pointer to itself, which cleaning it up
 * overwrites, just before freeing it. */
static int victim_freed(void) {
  return *(void *volatile *)victim != (void *)victim;
}

static void refill_victim(void) {
  spin_for_ms(FREE_DELAY_MS);
  void *held[64];
  int count = 0;
  while (count < 64) {
    char *block = malloc(victim_size);
    if (block <= (char *)victim &&
        (char *)victim + STRUCT_COVER <= block + victim_size) {
      memset(block, 0xff, victim_size);
      refilled = 1;
      break;
    }
    held[count++] = block;
  }
  for (int i = 0; i < count; i++)
    free(held[i]);
}

/* Spins without a futex wait, so this thread's own sync stays pending. */
static void hold_up_sync(void) {
  double end = emscripten_get_now() + TIMEOUT_MS;
  while (_dlopen_proxying_queue == NULL) {
    if (emscripten_get_now() > end) {
      failure = "dlopen() never started syncing";
      return;
    }
  }
  held_sync = 1;
  raise_flag(&victim_go);
  end = emscripten_get_now() + TIMEOUT_MS;
  while (!load(&victim_exiting)) {
    if (emscripten_get_now() > end) {
      failure = "the victim never ended";
      return;
    }
  }
  end = emscripten_get_now() + FREE_WAIT_MS;
  while (!victim_freed() && emscripten_get_now() < end)
    ;
  if (victim_freed()) {
    freed_during_sync = 1;
    refill_victim();
  }
}

static void *entry(void *arg) {
  wait_for(&roles_set);
  if (pthread_equal(pthread_self(), victim)) {
    wait_for(&victim_go);
    raise_flag(&victim_exiting);
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
  /* dlopen() syncs threads in ascending order of their pthread_t, and the
   * first sync creates the dlopen queue. */
  slow = a < b ? a : b;
  victim = a < b ? b : a;
  victim_size = malloc_usable_size((void *)victim);
  pthread_detach(victim);
  raise_flag(&roles_set);

  int failures = 0;
  if (dlopen(argv[1], RTLD_NOW) == NULL) {
    printf("FAIL: dlopen: %s\n", dlerror());
    failures++;
  }
  if (!victim_freed()) {
    printf("FAIL: the victim wasn't cleaned up once dlopen() returned\n");
    failures++;
  }
  raise_flag(&done);
  pthread_join(slow, NULL);
  if (failure != NULL) {
    printf("FAIL: %s\n", failure);
    failures++;
  } else if (!held_sync) {
    printf("FAIL: the sync wasn't held up while the victim ended\n");
    failures++;
  }
  if (freed_during_sync) {
    printf("FAIL: the victim was freed while dlopen() was syncing%s\n",
           refilled ? ", and its block reused" : "");
    failures++;
  }
  printf("%d failures\n", failures);
  return failures != 0;
}
