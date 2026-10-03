// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// For the cases where a thread ends while dlopen() on the main thread syncs
// the others: whether the ended thread was freed, and if so, a block over
// its struct filled with 0xff, so that a sync that still reaches it fails.
// The build defines SIDE_MODULE_DIR, the directory holding the side modules
// the cases load.

#pragma once

#include <malloc.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

#include "threads.h"

// Created by dlopen()'s first sync of another thread; it starts with the
// mutex that proxying a sync takes.
extern "C" void *_Atomic _dlopen_proxying_queue;

constexpr double kTimeoutMs = 5000;
// How long the freed block may take to appear, if it is freed at all.
constexpr double kFreeWaitMs = 300;
// Long enough for a cleanup that has begun to free the block.
constexpr double kFreeDelayMs = 50;
// More than a struct pthread takes.
constexpr size_t kStructCover = 256;

// A struct pthread starts with a pointer to itself, which cleaning it up
// overwrites, just before freeing it.
inline bool thread_freed(pthread_t thread) {
  return *(void *volatile *)thread != (void *)thread;
}

// Whether a block of size bytes over thread's struct came back from
// malloc(), and was filled.
inline bool refill(pthread_t thread, size_t size) {
  spin_for_ms(kFreeDelayMs);
  void *held[64];
  int count = 0;
  bool refilled = false;
  while (count < 64) {
    char *block = static_cast<char *>(malloc(size));
    if (block <= (char *)thread &&
        (char *)thread + kStructCover <= block + size) {
      memset(block, 0xff, size);
      refilled = true;
      break;
    }
    held[count++] = block;
  }
  for (int i = 0; i < count; i++)
    free(held[i]);
  return refilled;
}
