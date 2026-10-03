// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Threads that end without being joined on the main thread, detached ones
// and ones another thread joins, are reclaimed while the main thread stays
// blocked: their memory is freed and their Workers go back to the pool
// without the main thread returning to its event loop.

#include <emscripten/em_js.h>
#include <malloc.h>

#include <vector>

#include <gtest/gtest.h>

#include "threads.h"

namespace {

constexpr int kRounds = 8;
// Each round's threads: half end detached, half join a child of their own
// first, so a round runs up to 1.5 × kThreads threads at once.
constexpr int kThreads = 4;
constexpr int kAtOnce = kThreads + kThreads / 2;
constexpr size_t kStackSize = 256 * 1024;

} // namespace

// Workers the runtime holds, idle or hosting a thread; only the main
// thread knows them all.
EM_JS(int, worker_count, (void), {
  return PThread.unusedWorkers.length + Object.keys(PThread.pthreads).length;
});

namespace {

pthread_attr_t attr;
int finished;

void *finish(void *) {
  __atomic_fetch_add(&finished, 1, __ATOMIC_SEQ_CST);
  emscripten_futex_wake(&finished, INT_MAX);
  return nullptr;
}

void *join_child(void *) {
  pthread_t child;
  if (pthread_create(&child, &attr, finish, nullptr) == 0)
    pthread_join(child, nullptr);
  return finish(nullptr);
}

// Blocks without returning to the event loop.
void block_for(double ms) {
  static int never;
  const double end = emscripten_get_now() + ms;
  for (double left = ms; left > 0; left = end - emscripten_get_now())
    emscripten_futex_wait(&never, 0, left);
}

size_t in_use() { return mallinfo().uordblks; }

void run_round() {
  const int target = __atomic_load_n(&finished, __ATOMIC_SEQ_CST) + kAtOnce;
  for (int i = 0; i < kThreads; i++) {
    pthread_t thread;
    pthread_create(&thread, &attr, i % 2 ? join_child : finish, nullptr);
    pthread_detach(thread);
  }
  for (int now; (now = __atomic_load_n(&finished, __ATOMIC_SEQ_CST)) < target;)
    emscripten_futex_wait(&finished, now, 1000);
}

struct Round {
  size_t used;
  int workers;
};

struct Rounds {
  size_t baseline;
  // The pool, plus a new Worker for each thread it can't cover.
  int max_workers;
  std::vector<Round> rounds;
};

// On the main thread, throughout.
void run_rounds(void *arg) {
  auto &result = *static_cast<Rounds *>(arg);
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, kStackSize);
  result.max_workers = worker_count() + kAtOnce;

  // One round warms up whatever the runtime allocates once.
  run_round();
  block_for(200);
  result.baseline = in_use();
  for (int round = 1; round < kRounds; round++) {
    run_round();
    const double deadline = emscripten_get_now() + 5000;
    while (in_use() > result.baseline + kStackSize / 2 &&
           emscripten_get_now() < deadline)
      block_for(5);
    result.rounds.push_back({in_use(), worker_count()});
  }
}

TEST(Patch0014, BlockedMainThreadReclaimsThreads) {
  Rounds result;
  run_on_main_thread(run_rounds, &result);
  ASSERT_EQ(result.rounds.size(), kRounds - 1);
  for (size_t i = 0; i < result.rounds.size(); i++) {
    const Round &round = result.rounds[i];
    EXPECT_LE(round.used, result.baseline + kStackSize / 2)
        << "round " << i + 1 << "'s threads still hold memory (baseline "
        << result.baseline << ")";
    EXPECT_LE(round.workers, result.max_workers)
        << "round " << i + 1 << ": more Workers than the "
        << result.max_workers - kAtOnce << " to start with plus " << kAtOnce
        << " threads at once";
  }
}

} // namespace
