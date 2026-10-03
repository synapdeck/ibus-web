// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A WasmFS ProxyWorker that is destroyed leaves nothing running against its
// queue. Its thread's Worker goes back to the pool, idle, and later hosts
// another thread; the program stays alive long enough for the worker
// thread's 50 ms heartbeat to have fired several times in each state. A
// heartbeat that outlives its queue fails an assertion on its Worker, which
// ends the program.

#include <unistd.h>

#include <thread>

// thread_utils.h uses these without including them.
#include <assert.h>
#include <condition_variable>
#include <mutex>

#include "thread_utils.h"

#include <gtest/gtest.h>

namespace {

// Several heartbeats.
constexpr useconds_t kIdleUs = 500 * 1000;

// Off the main thread, which can't wait for a ProxyWorker to start.
bool use_worker() {
  bool ran = false;
  std::thread([&] {
    emscripten::ProxyWorker worker;
    worker([&] { ran = true; });
  }).join();
  return ran;
}

// The pool holds a Worker for this thread and one each for use_worker()'s
// two, so the second time round both of those Workers host threads again,
// the one the first ProxyWorker's thread ran on among them.
TEST(Patch0018, DestroyedProxyWorkerStopsHeartbeat) {
  EXPECT_TRUE(use_worker()) << "the worker never ran the proxied call";
  usleep(kIdleUs);
  EXPECT_TRUE(use_worker()) << "the worker never ran the proxied call";
  usleep(kIdleUs);
}

} // namespace
