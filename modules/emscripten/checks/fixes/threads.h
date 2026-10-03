// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Flags threads raise for one another, and the program's main thread, for
// the thread fixes. GoogleTest runs cases on a pthread of their own, but
// the fixes are to what the main thread does.

#pragma once

#include <emscripten/eventloop.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <limits.h>
#include <math.h>
#include <pthread.h>

inline int load(int *flag) { return __atomic_load_n(flag, __ATOMIC_SEQ_CST); }

inline void raise_flag(int *flag) {
  __atomic_store_n(flag, 1, __ATOMIC_SEQ_CST);
  emscripten_futex_wake(flag, INT_MAX);
}

// Waits in futex waits, which also run the syncs dlopen() asks for.
inline void wait_for(int *flag) {
  while (!load(flag))
    emscripten_futex_wait(flag, 0, INFINITY);
}

inline void spin_for_ms(double ms) {
  const double end = emscripten_get_now() + ms;
  while (emscripten_get_now() < end)
    ;
}

// Calls fn(arg) on the main thread, from its event loop, as main() would be
// called without GoogleTest's thread. A call proxied to the main thread runs
// inside its processing of proxied calls, which it can't reenter while the
// call blocks; threads the call starts on new Workers then never run.
inline void start_on_main_thread(void (*fn)(void *), void *arg) {
  struct Call {
    void (*fn)(void *);
    void *arg;
  };
  emscripten_proxy_async(
      emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(),
      [](void *call) {
        emscripten_set_timeout(
            [](void *call) {
              auto *c = static_cast<Call *>(call);
              c->fn(c->arg);
              delete c;
            },
            0, call);
      },
      new Call{fn, arg});
}

// Calls fn(arg) on the main thread, as start_on_main_thread() does, and
// waits for it to return, in futex waits. The main thread doesn't return to
// its event loop until fn does.
inline void run_on_main_thread(void (*fn)(void *), void *arg) {
  struct Call {
    void (*fn)(void *);
    void *arg;
    int done;
  } call{fn, arg, 0};
  start_on_main_thread(
      [](void *call) {
        auto *c = static_cast<Call *>(call);
        c->fn(c->arg);
        raise_flag(&c->done);
      },
      &call);
  wait_for(&call.done);
}
