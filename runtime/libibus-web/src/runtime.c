/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#include "ibus-web/runtime.h"
#include "dispatch.h"
#include "settings.h"

#include <emscripten/emscripten.h>
#include <emscripten/threading_primitives.h>
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <pthread.h>

/* The word the wake hook bumps: NULL until the first successful init sets
 * it, for good. */
static int32_t *runtime_wake_word; /* (atomic) */

/* Runs wherever the default context's wakeup is signalled, possibly with the
 * context locked, so it must not call into GLib. */
static void wake(gpointer user_data) {
  int32_t *word = user_data;
  __atomic_fetch_add(word, 1, __ATOMIC_SEQ_CST);
  emscripten_futex_wake(word, INT_MAX);
}

int ibusweb_runtime_init(int32_t *wake_word) {
  if (wake_word == NULL)
    return -EINVAL;
  if (g_atomic_pointer_get(&runtime_wake_word) != NULL)
    return -EALREADY;
  /* Only one thread can own the context, so of racing callers only one gets
   * past here. */
  if (!g_main_context_acquire(NULL))
    return -EBUSY;
  ibusweb_settings_register();
  g_main_context_wasm_set_wake_hook(NULL, wake, wake_word);
  g_wasm_set_dispatch_hook(ibusweb_dispatch_hook);
  g_atomic_pointer_set(&runtime_wake_word, wake_word);
  return 0;
}

void ibusweb_runtime_wake(void) {
  int32_t *word = g_atomic_pointer_get(&runtime_wake_word);
  if (word != NULL)
    wake(word);
}

/* A warming thread runs nothing of its own, and every stack comes from the
 * heap: a default 1 MiB stack on each idle Worker would raise the heap's peak,
 * which a module declares, by megabytes. */
#define WARM_STACK_BYTES (64 * 1024)

static void *return_at_once(void *data) { return data; }

int32_t ibusweb_warm_pool(int32_t count) {
  if (count < 0)
    return -EINVAL;
  if (!g_main_context_is_owner(g_main_context_default())) {
    g_critical("ibusweb_warm_pool() called off the thread that owns the "
               "default main context");
    return -EPERM;
  }

  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, WARM_STACK_BYTES);

  /* Every thread is created before any is joined: a joinable thread keeps
   * its Worker until it is joined, so each lands on a Worker of its own. */
  pthread_t *threads = g_new(pthread_t, count);
  int32_t started = 0;
  while (started < count &&
         pthread_create(&threads[started], &attr, return_at_once, NULL) == 0)
    started++;
  for (int32_t i = 0; i < started; i++)
    pthread_join(threads[i], NULL);
  g_free(threads);
  pthread_attr_destroy(&attr);
  return started;
}

int ibusweb_wait(int32_t seen, int32_t timeout_ms) {
  int32_t *word = g_atomic_pointer_get(&runtime_wake_word);
  if (word == NULL)
    return -EINVAL;
  if (!g_main_context_is_owner(g_main_context_default())) {
    g_critical("ibusweb_wait() called off the thread that owns the default "
               "main context");
    return -EPERM;
  }

  double end = timeout_ms < 0 ? INFINITY : emscripten_get_now() + timeout_ms;
  for (;;) {
    /* Waits at least once, even when the word has already moved or no time
     * is left: each futex wait on this thread ends by running the calls
     * other threads proxied to it, and a host that is woken often must not
     * starve them. */
    double left = fmax(end - emscripten_get_now(), 0);
    emscripten_futex_wait(word, (uint32_t)seen, left);
    if (g_atomic_int_get(word) != seen)
      return 0;
    if (left == 0)
      return -ETIMEDOUT;
  }
}
