// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Runs after a sequence that left a value stored, and must find nothing.

#include <gtest/gtest.h>

#include "persist.h"

TEST(Cleared, StartsWithNothingStored) { EXPECT_FALSE(persist::exists()); }
