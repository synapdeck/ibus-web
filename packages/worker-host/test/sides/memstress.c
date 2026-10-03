/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Workloads for memory growth under many threads: many threads allocating
 * and touching fresh memory while it grows, with and without GLib, and the
 * costs of growing. Each workload's threads run while the host sleeps; its
 * result operation joins them once all have finished. */

#include "test-ops.h"

#include <emscripten/heap.h>
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <unistd.h>

#define MAX_THREADS 128
#define PAGE 4096

typedef enum { IDLE, PENDING, DONE } State;

static int32_t heap_kib(void) {
  return (int32_t)(emscripten_get_heap_size() / 1024);
}

static int32_t since(gint64 start) {
  return (int32_t)MIN(g_get_monotonic_time() - start, G_MAXINT32);
}

/* What a workload's result reports, in this order. */
typedef struct {
  int32_t started;
  int32_t errors;
  int32_t out_of_memory;
  int32_t elapsed_us;
  int32_t heap_kib_before;
  int32_t heap_kib_after;
} Totals;

static void reply_totals(GString *reply, const Totals *totals) {
  test_reply(reply, totals->started);
  test_reply(reply, totals->errors);
  test_reply(reply, totals->out_of_memory);
  test_reply(reply, totals->elapsed_us);
  test_reply(reply, totals->heap_kib_before);
  test_reply(reply, totals->heap_kib_after);
}

/* ---- Without GLib: pthreads, malloc() and the JavaScript getentropy(). */

/* A block's first words say who wrote it and how long it is; every page
 * after carries the same stamp, so a reader sees whether all of it is
 * there. */
typedef struct {
  uint32_t stamp;
  uint32_t size;
} Header;

static uint32_t stamp_of(int thread, int round) {
  return 0x5a000000u ^ ((uint32_t)thread << 12) ^ (uint32_t)round;
}

static void fill(uint8_t *block, uint32_t size, uint32_t stamp) {
  Header header = {stamp, size};
  memcpy(block, &header, sizeof header);
  for (uint32_t offset = PAGE; offset + sizeof stamp <= size; offset += PAGE)
    memcpy(block + offset, &stamp, sizeof stamp);
  memcpy(block + size - sizeof stamp, &stamp, sizeof stamp);
}

/* Whether a block still holds what fill() wrote. */
static gboolean intact(const uint8_t *block) {
  Header header;
  uint32_t word;
  memcpy(&header, block, sizeof header);
  if (header.size < sizeof header + sizeof word)
    return FALSE;
  for (uint32_t offset = PAGE; offset + sizeof word <= header.size;
       offset += PAGE) {
    memcpy(&word, block + offset, sizeof word);
    if (word != header.stamp)
      return FALSE;
  }
  memcpy(&word, block + header.size - sizeof word, sizeof word);
  return word == header.stamp;
}

typedef struct {
  int index;
  int threads;
  int rounds;
  unsigned seed;
  int32_t errors;
  int32_t out_of_memory;
} Churner;

static State churn_state;
static Totals churn_totals;
static gint64 churn_started;
static pthread_t churn_threads[MAX_THREADS];
static Churner churners[MAX_THREADS];
static atomic_int churn_finished;
/* Each thread's inbox: a block its neighbour allocated and filled, which it
 * marks with an atomic increment, checks and frees, so memory one thread got
 * from a grown heap is read, and atomically written, on another. */
static _Atomic(uint8_t *) inboxes[MAX_THREADS];

static void check_and_free(Churner *self, uint8_t *block) {
  if (block == NULL)
    return;
  atomic_fetch_add((_Atomic uint32_t *)(block + sizeof(Header)), 1);
  if (!intact(block))
    self->errors++;
  free(block);
}

/* size is rounded down to whole words, so that the last word never
 * overlaps a page's. */
static uint8_t *allocate(Churner *self, uint32_t size, uint32_t stamp) {
  size &= ~(uint32_t)(sizeof stamp - 1);
  uint8_t *block = malloc(size);
  if (block == NULL) {
    self->out_of_memory++;
    return NULL;
  }
  fill(block, size, stamp);
  return block;
}

/* Each round keeps one more block of 16–128 KiB, so the heap keeps growing
 * while every thread runs; sends one to its neighbour and checks the one it
 * was sent; and has JavaScript write random bytes into a fresh allocation,
 * on this thread, through its view of the memory. */
static void *churn(void *data) {
  Churner *self = data;
  uint8_t **kept = calloc((size_t)self->rounds, sizeof *kept);
  int next = (self->index + 1) % self->threads;
  if (kept == NULL) {
    self->out_of_memory++;
    atomic_fetch_add(&churn_finished, 1);
    return NULL;
  }
  for (int round = 0; round < self->rounds; round++) {
    uint32_t stamp = stamp_of(self->index, round);
    uint32_t size = 16 * 1024 + rand_r(&self->seed) % (112 * 1024);
    kept[round] = allocate(self, size, stamp);
    for (int i = 0; i <= round; i++)
      if (kept[i] != NULL && !intact(kept[i]))
        self->errors++;

    uint8_t *random = malloc(256);
    if (random == NULL)
      self->out_of_memory++;
    else {
      if (getentropy(random, 256) != 0)
        self->errors++;
      free(random);
    }

    check_and_free(self, atomic_exchange(&inboxes[self->index], NULL));
    uint8_t *gift = allocate(self, 4096 + rand_r(&self->seed) % 61440, stamp);
    if (gift != NULL)
      check_and_free(self, atomic_exchange(&inboxes[next], gift));
    sched_yield();
  }
  for (int round = 0; round < self->rounds; round++)
    check_and_free(self, kept[round]);
  free(kept);
  atomic_fetch_add(&churn_finished, 1);
  return NULL;
}

/* mem-stress(threads, rounds): threads that churn() for rounds each, without
 * GLib. Replies how many started. */
static void mem_stress(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t threads, rounds;
  if (!test_arg(payload, len, 0, &threads) ||
      !test_arg(payload, len, 1, &rounds) || threads < 1 ||
      threads > MAX_THREADS || rounds < 1)
    return;
  if (churn_state == PENDING) {
    test_reply(reply, -EBUSY);
    return;
  }
  churn_state = PENDING;
  churn_totals = (Totals){.heap_kib_before = heap_kib()};
  atomic_store(&churn_finished, 0);
  churn_started = g_get_monotonic_time();
  int started = 0;
  for (; started < threads; started++) {
    churners[started] = (Churner){
        .index = started,
        .threads = threads,
        .rounds = rounds,
        .seed = (unsigned)g_random_int(),
    };
    int error = pthread_create(&churn_threads[started], NULL, churn,
                               &churners[started]);
    if (error != 0) {
      g_warning("mem-stress: thread %d of %d: %s", started + 1, threads,
                g_strerror(error));
      break;
    }
  }
  churn_totals.started = started;
  test_reply(reply, started);
}

/* mem-stress-result(): once every thread has finished, joins them and
 * replies the Totals. */
static void mem_stress_result(const uint8_t *payload, uint32_t len,
                              GString *reply) {
  (void)payload;
  (void)len;
  if (churn_state == IDLE) {
    test_reply(reply, -ENOENT);
    return;
  }
  if (churn_state == PENDING) {
    if (atomic_load(&churn_finished) < churn_totals.started) {
      test_reply(reply, -EAGAIN);
      return;
    }
    churn_totals.elapsed_us = since(churn_started);
    for (int i = 0; i < churn_totals.started; i++) {
      pthread_join(churn_threads[i], NULL);
      churn_totals.errors += churners[i].errors;
      churn_totals.out_of_memory += churners[i].out_of_memory;
    }
    for (int i = 0; i < MAX_THREADS; i++) {
      uint8_t *left = atomic_exchange(&inboxes[i], NULL);
      if (left != NULL && !intact(left))
        churn_totals.errors++;
      free(left);
    }
    churn_totals.heap_kib_after = heap_kib();
    churn_state = DONE;
  }
  reply_totals(reply, &churn_totals);
}

/* ---- With GLib: GLib's 1bit-emufutex test's workload. Bit locks over an
 * emulated futex, a GMutex and a GCond per waited-on address, as GLib's own
 * emulation has; each thread starts with g_rand_new(), which reads
 * /dev/urandom. Thread creation, each with its 1 MiB stack, grows the heap
 * while the threads already started contend. */

#define LOCKS 48

typedef struct {
  const volatile gint *address;
  gint ref_count;
  GCond cond;
} Waiter;

static GMutex futex_mutex;
static GSList *futex_waiters;
static volatile gint locks[LOCKS];
static volatile gint contended[LOCKS];
static GThread *volatile owners[LOCKS];
static gint bits[LOCKS];

static Waiter *find_waiter(const volatile gint *address) {
  for (GSList *node = futex_waiters; node != NULL; node = node->next) {
    Waiter *waiter = node->data;
    if (waiter->address == address)
      return waiter;
  }
  return NULL;
}

static void futex_wait(const volatile gint *address, gint value) {
  g_mutex_lock(&futex_mutex);
  if (g_atomic_int_get(address) == value) {
    Waiter *waiter = find_waiter(address);
    if (waiter == NULL) {
      waiter = g_new(Waiter, 1);
      waiter->address = address;
      waiter->ref_count = 0;
      g_cond_init(&waiter->cond);
      futex_waiters = g_slist_prepend(futex_waiters, waiter);
    }
    waiter->ref_count++;
    g_cond_wait(&waiter->cond, &futex_mutex);
    if (--waiter->ref_count == 0) {
      futex_waiters = g_slist_remove(futex_waiters, waiter);
      g_cond_clear(&waiter->cond);
      g_free(waiter);
    }
  }
  g_mutex_unlock(&futex_mutex);
}

static void futex_wake(const volatile gint *address) {
  g_mutex_lock(&futex_mutex);
  Waiter *waiter = find_waiter(address);
  if (waiter != NULL)
    g_cond_signal(&waiter->cond);
  g_mutex_unlock(&futex_mutex);
}

static void bit_lock(int nr) {
  guint mask = 1u << bits[nr];
  for (;;) {
    guint value = g_atomic_int_or((volatile guint *)&locks[nr], mask);
    if ((value & mask) == 0)
      return;
    g_atomic_int_inc(&contended[nr]);
    futex_wait(&locks[nr], (gint)value);
    (void)g_atomic_int_dec_and_test(&contended[nr]);
  }
}

static void bit_unlock(int nr) {
  g_atomic_int_and((volatile guint *)&locks[nr], ~(1u << bits[nr]));
  if (g_atomic_int_get(&contended[nr]) != 0)
    futex_wake(&locks[nr]);
}

static State glib_state;
static Totals glib_totals;
static gint64 glib_started;
static GThread *glib_threads[MAX_THREADS];
static gint glib_finished;
static gint glib_errors;
static int glib_iterations;

/* Takes lock nr, checks nobody else holds it across three yields, and lets
 * it go; a violation counts as an error rather than aborting the runtime. */
static void acquire(int nr) {
  GThread *self = g_thread_self();
  bit_lock(nr);
  if (owners[nr] != NULL)
    g_atomic_int_inc(&glib_errors);
  owners[nr] = self;
  g_thread_yield();
  g_thread_yield();
  g_thread_yield();
  if (owners[nr] != self)
    g_atomic_int_inc(&glib_errors);
  owners[nr] = NULL;
  bit_unlock(nr);
}

static gpointer contend(gpointer data) {
  (void)data;
  GRand *rand = g_rand_new();
  for (int i = 0; i < glib_iterations; i++)
    acquire(g_rand_int_range(rand, 0, LOCKS));
  g_rand_free(rand);
  g_atomic_int_inc(&glib_finished);
  return NULL;
}

/* glib-stress(threads, iterations): threads that each take a random one of
 * the locks iterations times. Replies how many started. */
static void glib_stress(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t threads, iterations;
  if (!test_arg(payload, len, 0, &threads) ||
      !test_arg(payload, len, 1, &iterations) || threads < 1 ||
      threads > MAX_THREADS || iterations < 1)
    return;
  if (glib_state == PENDING) {
    test_reply(reply, -EBUSY);
    return;
  }
  glib_state = PENDING;
  glib_totals = (Totals){.heap_kib_before = heap_kib()};
  glib_iterations = iterations;
  g_atomic_int_set(&glib_finished, 0);
  g_atomic_int_set(&glib_errors, 0);
  for (int i = 0; i < LOCKS; i++)
    bits[i] = (gint)(g_random_int() % 32);
  glib_started = g_get_monotonic_time();
  int started = 0;
  for (; started < threads; started++) {
    GError *error = NULL;
    glib_threads[started] = g_thread_try_new("contend", contend, NULL, &error);
    if (glib_threads[started] == NULL) {
      g_warning("glib-stress: thread %d of %d: %s", started + 1, threads,
                error->message);
      g_error_free(error);
      break;
    }
  }
  glib_totals.started = started;
  test_reply(reply, started);
}

/* glib-stress-result(): once every thread has finished, joins them, checks
 * every lock is free and replies the Totals. */
static void glib_stress_result(const uint8_t *payload, uint32_t len,
                               GString *reply) {
  (void)payload;
  (void)len;
  if (glib_state == IDLE) {
    test_reply(reply, -ENOENT);
    return;
  }
  if (glib_state == PENDING) {
    if (g_atomic_int_get(&glib_finished) < glib_totals.started) {
      test_reply(reply, -EAGAIN);
      return;
    }
    glib_totals.elapsed_us = since(glib_started);
    for (int i = 0; i < glib_totals.started; i++)
      g_thread_join(glib_threads[i]);
    glib_totals.errors = g_atomic_int_get(&glib_errors);
    for (int i = 0; i < LOCKS; i++)
      if (locks[i] != 0 || owners[i] != NULL)
        glib_totals.errors++;
    glib_totals.heap_kib_after = heap_kib();
    glib_state = DONE;
  }
  reply_totals(reply, &glib_totals);
}

/* ---- Costs. */

/* mem-info(): the memory's size and the heap's break, in KiB. */
static void mem_info(const uint8_t *payload, uint32_t len, GString *reply) {
  (void)payload;
  (void)len;
  test_reply(reply, heap_kib());
  test_reply(reply, (int32_t)((uintptr_t)sbrk(0) / 1024));
}

/* mem-grow(mib): allocates mib MiB past the heap's break, touches a byte of
 * every page and frees it. Replies the allocation's microseconds (which
 * grow the memory if it must), the touching's, and the memory's size in KiB
 * before and after; -ENOMEM if the allocation fails. */
static void mem_grow(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t mib;
  if (!test_arg(payload, len, 0, &mib) || mib < 1)
    return;
  size_t size = (size_t)mib * 1024 * 1024;
  int32_t before = heap_kib();
  gint64 start = g_get_monotonic_time();
  volatile uint8_t *block = malloc(size);
  int32_t alloc_us = since(start);
  if (block == NULL) {
    test_reply(reply, -ENOMEM);
    return;
  }
  start = g_get_monotonic_time();
  for (size_t offset = 0; offset < size; offset += PAGE)
    block[offset] = 1;
  int32_t touch_us = since(start);
  free((void *)block);
  test_reply(reply, alloc_us);
  test_reply(reply, touch_us);
  test_reply(reply, before);
  test_reply(reply, heap_kib());
}

/* js-heap(calls): getentropy() of 64 bytes, calls times. Each call's
 * JavaScript writes into the memory through its view, which a build that
 * grows memory without growable buffers first checks is current. Replies
 * the microseconds. */
static void js_heap(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t calls;
  uint8_t bytes[64];
  if (!test_arg(payload, len, 0, &calls) || calls < 1)
    return;
  gint64 start = g_get_monotonic_time();
  for (int32_t i = 0; i < calls; i++)
    if (getentropy(bytes, sizeof bytes) != 0) {
      test_reply(reply, -EIO);
      return;
    }
  test_reply(reply, since(start));
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, TEST_OP_MEM_STRESS, "mem-stress", mem_stress);
  ibusweb_module_add_op(module, TEST_OP_MEM_STRESS_RESULT, "mem-stress-result",
                        mem_stress_result);
  ibusweb_module_add_op(module, TEST_OP_GLIB_STRESS, "glib-stress",
                        glib_stress);
  ibusweb_module_add_op(module, TEST_OP_GLIB_STRESS_RESULT,
                        "glib-stress-result", glib_stress_result);
  ibusweb_module_add_op(module, TEST_OP_MEM_INFO, "mem-info", mem_info);
  ibusweb_module_add_op(module, TEST_OP_MEM_GROW, "mem-grow", mem_grow);
  ibusweb_module_add_op(module, TEST_OP_JS_HEAP, "js-heap", js_heap);
}
