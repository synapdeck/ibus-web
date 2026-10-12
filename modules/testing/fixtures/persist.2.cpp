// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Reads back the value the program before it in the sequence stored, then
// checks that an earlier case ran, as a case of a sequence may rely on.

#include <gtest/gtest.h>

#include "persist.h"

namespace {

bool readBack = false;

} // namespace

TEST(Persist, ReadsWhatTheFirstStored) {
  EXPECT_EQ(persist::load(), kPersistValue);
  readBack = true;
}

TEST(Later, FollowsTheEarlierCase) { EXPECT_TRUE(readBack); }
