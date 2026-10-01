/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* dlopen() on the main thread syncs the threads it knows of one at a time.
 * Proxying the sync to a thread can itself wait, here on the dlopen queue's
 * mutex, which another thread holds; a thread that ends meanwhile must not
 * be cleaned up, and so freed, while the sync is about to reach its struct.
 * It is cleaned up as soon as the sync is done. argv[1] and argv[2] are two
 * copies of a side module. */

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

/* Created by dlopen()'s first sync of another thread; it starts with the
 * mutex that proxying a sync takes. */
extern void *_Atomic _dlopen_proxying_queue;

static pthread_t victim, holder;
static size_t victim_size;
static int roles_set, first_loaded, victim_spinning, locked, victim_go,
    victim_exiting, done;
/* Written by the holder before it lets the sync go on. */
static int saw_waiter, freed_during_sync, refilled;
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

/* Spins without a futex wait, so this thread never takes the dlopen
 * queue's mutex meanwhile. */
static int spin_for(int *flag) {
  double end = emscripten_get_now() + TIMEOUT_MS;
  while (!load(flag))
    if (emscripten_get_now() > end)
      return 0;
  return 1;
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

static void hold_queue(void) {
  if (!spin_for(&victim_spinning)) {
    failure = "the victim never started spinning";
    return;
  }
  pthread_mutex_t *mutex = (pthread_mutex_t *)_dlopen_proxying_queue;
  pthread_mutex_lock(mutex);
  raise_flag(&locked);
  /* musl counts a mutex's waiters in its third int; the main thread is the
   * only one that can wait on this one now. */
  double end = emscripten_get_now() + TIMEOUT_MS;
  while (((volatile int *)mutex)[2] == 0) {
    if (emscripten_get_now() > end) {
      failure = "dlopen() never waited on the queue";
      pthread_mutex_unlock(mutex);
      return;
    }
  }
  saw_waiter = 1;
  raise_flag(&victim_go);
  spin_for(&victim_exiting);
  end = emscripten_get_now() + FREE_WAIT_MS;
  while (!victim_freed() && emscripten_get_now() < end)
    ;
  if (victim_freed()) {
    freed_during_sync = 1;
    refill_victim();
  }
  pthread_mutex_unlock(mutex);
}

static void *entry(void *arg) {
  wait_for(&roles_set);
  wait_for(&first_loaded);
  if (pthread_equal(pthread_self(), victim)) {
    raise_flag(&victim_spinning);
    spin_for(&victim_go);
    raise_flag(&victim_exiting);
    return NULL;
  }
  hold_queue();
  wait_for(&done);
  return NULL;
}

int main(int argc, char **argv) {
  pthread_t a, b;
  pthread_create(&a, NULL, entry, NULL);
  pthread_create(&b, NULL, entry, NULL);
  /* dlopen() syncs threads in ascending order of their pthread_t: the
   * victim's sync must be the one that waits. */
  victim = a < b ? a : b;
  holder = a < b ? b : a;
  victim_size = malloc_usable_size((void *)victim);
  pthread_detach(victim);
  raise_flag(&roles_set);

  int failures = 0;
  /* The first load creates the dlopen queue. */
  if (dlopen(argv[1], RTLD_NOW) == NULL) {
    printf("FAIL: dlopen: %s\n", dlerror());
    return 1;
  }
  raise_flag(&first_loaded);
  if (!spin_for(&locked)) {
    printf("FAIL: the holder never took the queue's mutex: %s\n",
           failure ? failure : "?");
    return 1;
  }
  if (dlopen(argv[2], RTLD_NOW) == NULL) {
    printf("FAIL: dlopen: %s\n", dlerror());
    failures++;
  }
  if (!victim_freed()) {
    printf("FAIL: the victim wasn't cleaned up once dlopen() returned\n");
    failures++;
  }
  raise_flag(&done);
  pthread_join(holder, NULL);
  if (failure != NULL) {
    printf("FAIL: %s\n", failure);
    failures++;
  } else if (!saw_waiter) {
    printf("FAIL: dlopen() didn't wait on the queue while the victim ended\n");
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
