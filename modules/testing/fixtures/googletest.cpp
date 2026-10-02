// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A GoogleTest program whose cases pass, fail, skip and take their time,
// each on purpose.

#include <chrono>
#include <thread>

#include <gtest/gtest.h>

TEST(Fixture, Passes) { EXPECT_EQ(2 + 2, 4); }

TEST(Fixture, FailsOnPurpose) { ADD_FAILURE() << "fails on purpose"; }

TEST(Fixture, SkipsOnPurpose) { GTEST_SKIP() << "skips on purpose"; }

TEST(Timing, SleepsOnPurpose) {
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
}
