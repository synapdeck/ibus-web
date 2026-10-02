// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Stores a value for the next program of the sequence.

#include <gtest/gtest.h>

#include "persist.h"

TEST(Persist, Stores) { EXPECT_TRUE(persist::store(kPersistValue)); }
