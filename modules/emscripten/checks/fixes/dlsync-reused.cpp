// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A running thread whose pthread_t belonged to a thread joined just before
// still takes part in dlopen()'s sync, and can call into the new module.
// The joined thread's message that it had finished reaches the main thread
// only once the main thread has joined it, cleaned it up and created the
// new thread at the same address.

#include <dlfcn.h>
#include <emscripten/em_js.h>
#include <emscripten/eventloop.h>

#include <string>

#include <gtest/gtest.h>

#include "dlsync.h"

// Whether dlopen()'s sync would skip thread as finished; only the main
// thread knows.
EM_JS(int, marked_finished, (pthread_t thread),
      { return PThread.finishedThreads.has(thread) ? 1 : 0; });

namespace {

constexpr int kAttempts = 10;
// Long enough for the joined thread's message to arrive.
constexpr double kMessageDelayMs = 100;

pthread_t waiter;
int go;
int (*value)();
int result;

int own_value() { return 42; }

void *quit(void *) { return nullptr; }

void *wait_then_call(void *) {
  wait_for(&go);
  result = value();
  return nullptr;
}

void release_waiter() {
  raise_flag(&go);
  pthread_join(waiter, nullptr);
  go = 0;
}

struct Load {
  int attempt = 0;
  bool marked_finished = false;
  std::string error;
  int done = 0;
};

// Runs once the event loop has delivered the joined thread's message.
void load_and_call(void *arg) {
  auto &load = *static_cast<Load *>(arg);
  load.marked_finished = marked_finished(waiter);
  void *side = dlopen(SIDE_MODULE_DIR "/dlsync-side.wasm", RTLD_NOW);
  if (side == nullptr) {
    load.error = std::string("dlopen: ") + dlerror();
    raise_flag(&load.done);
    return;
  }
  value = reinterpret_cast<int (*)()>(dlsym(side, "side_value"));
  // A thread the sync skipped traps here.
  release_waiter();
  raise_flag(&load.done);
}

// On the main thread, which then goes back to its event loop.
void reuse(void *arg) {
  auto &load = *static_cast<Load *>(arg);
  for (int attempt = 1; attempt <= kAttempts; attempt++) {
    pthread_t joined;
    pthread_create(&joined, nullptr, quit, nullptr);
    // Cleans the thread up at once, its message still queued.
    pthread_join(joined, nullptr);
    pthread_create(&waiter, nullptr, wait_then_call, nullptr);
    if (pthread_equal(waiter, joined)) {
      load.attempt = attempt;
      emscripten_set_timeout(load_and_call, kMessageDelayMs, &load);
      return;
    }
    value = own_value;
    release_waiter();
  }
  raise_flag(&load.done);
}

TEST(Patch0015, ReusedThreadTakesPartInSync) {
  Load load;
  start_on_main_thread(reuse, &load);
  wait_for(&load.done);
  ASSERT_NE(load.attempt, 0)
      << "no new thread reused a joined thread's pthread_t";
  ASSERT_EQ(load.error, "");
  EXPECT_FALSE(load.marked_finished) << "the running thread is marked finished";
  EXPECT_EQ(result, 42) << "what the thread got from the side module";
}

} // namespace
