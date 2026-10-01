/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#include "ibus-web/runtime.h"

#include <emscripten/threading_primitives.h>
#include <errno.h>
#include <limits.h>

static gint initialized; /* (atomic) */

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
  if (g_atomic_int_get(&initialized))
    return -EALREADY;
  /* Only one thread can own the context, so of racing callers only one gets
   * past here. */
  if (!g_main_context_acquire(NULL))
    return -EBUSY;
  g_main_context_wasm_set_wake_hook(NULL, wake, wake_word);
  g_atomic_int_set(&initialized, TRUE);
  return 0;
}
