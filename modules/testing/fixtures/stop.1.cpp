// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Fails, so the rest of its sequence doesn't run.

#include <gtest/gtest.h>

TEST(Stop, FailsOnPurpose) { ADD_FAILURE() << "fails on purpose"; }
