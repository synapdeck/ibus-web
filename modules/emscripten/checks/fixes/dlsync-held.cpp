// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// dlopen() on the main thread syncs the threads it knows of one at a time.
// Proxying the sync to a thread can itself wait, here on the dlopen queue's
// mutex, which another thread holds; a thread that ends meanwhile must not
// be cleaned up, and so freed, while the sync is about to reach its struct.
// It is cleaned up as soon as the sync is done.

#include <dlfcn.h>

#include <string>

#include <gtest/gtest.h>

#include "dlsync.h"

namespace {

// Room below GoogleTest's own thread for the case's threads. dlopen() syncs
// threads in ascending order of their pthread_t, and the victim's sync must
// be the one that waits, so the victim has to come before every other
// thread; GoogleTest's starts before main() and so would otherwise be first.
constexpr size_t kReserve = 1024 * 1024;
void *reserve = [] { return malloc(kReserve); }();

pthread_t victim, holder;
size_t victim_size;
int roles_set, first_loaded, victim_spinning, locked, victim_go, victim_exiting,
    done;
// Written by the holder before it lets the sync go on.
int saw_waiter, freed_during_sync, refilled;
const char *failure;

// Spins without a futex wait, so this thread never takes the dlopen
// queue's mutex meanwhile.
bool spin_for(int *flag) {
  const double end = emscripten_get_now() + kTimeoutMs;
  while (!load(flag))
    if (emscripten_get_now() > end)
      return false;
  return true;
}

void hold_queue() {
  if (!spin_for(&victim_spinning)) {
    failure = "the victim never started spinning";
    return;
  }
  auto *mutex = static_cast<pthread_mutex_t *>(_dlopen_proxying_queue);
  pthread_mutex_lock(mutex);
  raise_flag(&locked);
  // musl counts a mutex's waiters in its third int; the main thread is the
  // only one that can wait on this one now.
  const double end = emscripten_get_now() + kTimeoutMs;
  while (((volatile int *)mutex)[2] == 0) {
    if (emscripten_get_now() > end) {
      failure = "dlopen() never waited on the queue";
      pthread_mutex_unlock(mutex);
      return;
    }
  }
  saw_waiter = 1;
  raise_flag(&victim_go);
  spin_for(&victim_exiting);
  const double free_end = emscripten_get_now() + kFreeWaitMs;
  while (!thread_freed(victim) && emscripten_get_now() < free_end)
    ;
  if (thread_freed(victim)) {
    freed_during_sync = 1;
    refilled = refill(victim, victim_size);
  }
  pthread_mutex_unlock(mutex);
}

void *entry(void *) {
  wait_for(&roles_set);
  wait_for(&first_loaded);
  if (pthread_equal(pthread_self(), victim)) {
    raise_flag(&victim_spinning);
    spin_for(&victim_go);
    raise_flag(&victim_exiting);
    return nullptr;
  }
  hold_queue();
  wait_for(&done);
  return nullptr;
}

struct Load {
  std::string error;
  bool victim_first = false;
  bool victim_freed_after = false;
};

// On the main thread, which is the one whose dlopen() syncs the others.
void load_while_victim_ends(void *arg) {
  auto &load = *static_cast<Load *>(arg);
  free(reserve);
  pthread_t a, b;
  pthread_create(&a, nullptr, entry, nullptr);
  pthread_create(&b, nullptr, entry, nullptr);
  victim = a < b ? a : b;
  holder = a < b ? b : a;
  victim_size = malloc_usable_size((void *)victim);
  pthread_detach(victim);
  raise_flag(&roles_set);

  // The first load creates the dlopen queue.
  if (dlopen(SIDE_MODULE_DIR "/dlsync-side.wasm", RTLD_NOW) == nullptr) {
    load.error = std::string("dlopen: ") + dlerror();
    return;
  }
  raise_flag(&first_loaded);
  if (!spin_for(&locked)) {
    load.error = std::string("the holder never took the queue's mutex: ") +
                 (failure ? failure : "?");
    return;
  }
  if (dlopen(SIDE_MODULE_DIR "/dlsync-side2.wasm", RTLD_NOW) == nullptr)
    load.error = std::string("dlopen: ") + dlerror();
  load.victim_freed_after = thread_freed(victim);
  raise_flag(&done);
  pthread_join(holder, nullptr);
}

TEST(Patch0014, ProxyWaitHoldsCleanup) {
  Load load;
  // The victim is created on the main thread, but must sort before this
  // one.
  const pthread_t self = pthread_self();
  run_on_main_thread(load_while_victim_ends, &load);
  ASSERT_LT(victim, self) << "the victim's sync isn't the first";
  ASSERT_EQ(load.error, "");
  EXPECT_TRUE(load.victim_freed_after)
      << "the victim wasn't cleaned up once dlopen() returned";
  ASSERT_EQ(failure, nullptr) << failure;
  EXPECT_TRUE(saw_waiter)
      << "dlopen() didn't wait on the queue while the victim ended";
  EXPECT_FALSE(freed_during_sync)
      << "the victim was freed while dlopen() was syncing"
      << (refilled ? ", and its block reused" : "");
}

} // namespace
