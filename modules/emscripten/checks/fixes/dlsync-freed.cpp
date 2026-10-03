// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// dlopen() on the main thread syncs the threads it knows of one at a time,
// and each sync waits. A thread later in its list that ends during an
// earlier thread's sync must not be cleaned up, and so freed, before the
// sync reaches it; it is cleaned up as soon as the sync is done. Here a slow
// thread holds up its own sync while a detached thread with a higher
// address ends; if that thread is freed meanwhile, the slow thread fills its
// block with 0xff before it lets its sync finish.

#include <dlfcn.h>

#include <string>

#include <gtest/gtest.h>

#include "dlsync.h"

namespace {

pthread_t slow, victim;
size_t victim_size;
int roles_set, victim_go, victim_exiting, done;
// Written by the slow thread before it lets its sync finish.
int held_sync, freed_during_sync, refilled;
const char *failure;

// Spins without a futex wait, so this thread's own sync stays pending.
void hold_up_sync() {
  double end = emscripten_get_now() + kTimeoutMs;
  while (_dlopen_proxying_queue == nullptr) {
    if (emscripten_get_now() > end) {
      failure = "dlopen() never started syncing";
      return;
    }
  }
  held_sync = 1;
  raise_flag(&victim_go);
  end = emscripten_get_now() + kTimeoutMs;
  while (!load(&victim_exiting)) {
    if (emscripten_get_now() > end) {
      failure = "the victim never ended";
      return;
    }
  }
  end = emscripten_get_now() + kFreeWaitMs;
  while (!thread_freed(victim) && emscripten_get_now() < end)
    ;
  if (thread_freed(victim)) {
    freed_during_sync = 1;
    refilled = refill(victim, victim_size);
  }
}

void *entry(void *) {
  wait_for(&roles_set);
  if (pthread_equal(pthread_self(), victim)) {
    wait_for(&victim_go);
    raise_flag(&victim_exiting);
    return nullptr;
  }
  hold_up_sync();
  wait_for(&done);
  return nullptr;
}

struct Load {
  std::string dlopen_error;
  bool victim_freed_after = false;
};

// On the main thread, which is the one whose dlopen() syncs the others.
void load_while_victim_ends(void *arg) {
  auto &load = *static_cast<Load *>(arg);
  pthread_t a, b;
  pthread_create(&a, nullptr, entry, nullptr);
  pthread_create(&b, nullptr, entry, nullptr);
  // dlopen() syncs threads in ascending order of their pthread_t, and the
  // first sync creates the dlopen queue.
  slow = a < b ? a : b;
  victim = a < b ? b : a;
  victim_size = malloc_usable_size((void *)victim);
  pthread_detach(victim);
  raise_flag(&roles_set);

  if (dlopen(SIDE_MODULE_DIR "/dlsync-side.wasm", RTLD_NOW) == nullptr)
    load.dlopen_error = dlerror();
  load.victim_freed_after = thread_freed(victim);
  raise_flag(&done);
  pthread_join(slow, nullptr);
}

TEST(Patch0014, SyncHoldsCleanupOfLaterThread) {
  ASSERT_EQ(_dlopen_proxying_queue, nullptr)
      << "the case must have the program's first dlopen()";
  Load load;
  run_on_main_thread(load_while_victim_ends, &load);
  EXPECT_EQ(load.dlopen_error, "");
  EXPECT_TRUE(load.victim_freed_after)
      << "the victim wasn't cleaned up once dlopen() returned";
  ASSERT_EQ(failure, nullptr) << failure;
  EXPECT_TRUE(held_sync) << "the sync wasn't held up while the victim ended";
  EXPECT_FALSE(freed_during_sync)
      << "the victim was freed while dlopen() was syncing"
      << (refilled ? ", and its block reused" : "");
}

} // namespace
