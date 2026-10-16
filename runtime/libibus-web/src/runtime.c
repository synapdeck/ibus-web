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
