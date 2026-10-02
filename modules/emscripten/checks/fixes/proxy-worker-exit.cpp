/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* A WasmFS ProxyWorker that is destroyed leaves nothing running against its
 * queue. Its thread's Worker goes back to the pool, idle, and later hosts
 * another thread; the program stays alive long enough for the worker
 * thread's 50 ms heartbeat to have fired several times in each state. */

#include <emscripten/emscripten.h>
#include <emscripten/eventloop.h>
#include <stdio.h>
#include <thread>

/* thread_utils.h uses these without including them. */
#include <assert.h>
#include <condition_variable>
#include <mutex>

#include "thread_utils.h"

/* Several heartbeats. */
#define IDLE_MS 500

static int failures;

/* Off the main thread, which can't wait for a ProxyWorker to start. */
static void use_worker() {
  std::thread([] {
    emscripten::ProxyWorker worker;
    bool ran = false;
    worker([&] { ran = true; });
    if (!ran) {
      puts("the worker never ran the proxied call");
      failures++;
    }
  }).join();
}

static void second_idle(void *) {
  if (!failures)
    puts("ok");
  emscripten_force_exit(failures ? 1 : 0);
}

/* Both of the pool's Workers host threads again, the one the first
 * ProxyWorker's thread ran on among them. */
static void first_idle(void *) {
  use_worker();
  emscripten_set_timeout(second_idle, IDLE_MS, nullptr);
}

int main() {
  use_worker();
  emscripten_set_timeout(first_idle, IDLE_MS, nullptr);
}
