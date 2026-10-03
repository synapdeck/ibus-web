// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Linked without memory growth, but importing a memory declared up to a
// maximum above its initial size, and given one between the two: the heap
// spans the memory given, on every thread, and never grows past it. The
// program's first argument is the size it was given, in MiB.

#include <emscripten/em_asm.h>
#include <emscripten/heap.h>
#include <pthread.h>

#include <cstdlib>
#include <cstring>

#include <gtest/gtest.h>

namespace {

constexpr size_t kMiB = 1024 * 1024;

// Where allocations go, so the compiler can't take them for unused and drop
// them, or assume they succeed.
void *volatile sink;

// The first argument: the runner puts the program's own arguments before
// GoogleTest's flags. Only the main thread has Node's argv.
size_t given() {
  return (size_t)MAIN_THREAD_EM_ASM_INT({ return Number(process.argv[2]); }) *
         kMiB;
}

TEST(Patch0016, HeapSpansMemoryGiven) {
  EXPECT_EQ(emscripten_get_heap_max(), given());
}

// Half the memory given: in the larger memories, more than the initial
// size holds.
TEST(Patch0016, ThreadAllocatesBeyondInitialSize) {
  static size_t half;
  half = given() / 2;
  pthread_t thread;
  ASSERT_EQ(pthread_create(
                &thread, nullptr,
                [](void *) -> void * {
                  sink = malloc(half);
                  if (sink == nullptr)
                    return (void *)"the allocation failed";
                  memset(sink, 1, half);
                  free(sink);
                  return nullptr;
                },
                nullptr),
            0);
  void *error;
  pthread_join(thread, &error);
  EXPECT_EQ(error, nullptr) << static_cast<const char *>(error);
}

// An allocation the heap can't hold fails, rather than growing it.
TEST(Patch0016, HeapNeverGrows) {
  sink = malloc(given());
  EXPECT_EQ(sink, nullptr) << "an allocation of the whole memory succeeded";
  EXPECT_EQ(emscripten_get_heap_max(), given());
}

} // namespace
