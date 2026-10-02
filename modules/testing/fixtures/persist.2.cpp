// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Reads back the value the program before it in the sequence stored.

#include <gtest/gtest.h>

#include "persist.h"

TEST(Persist, ReadsWhatTheFirstStored) {
  EXPECT_EQ(persist::load(), kPersistValue);
}
