// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The database a program leaves with an orphan in it, for the next program
// to sweep.

#pragma once

#include "idb-test.h"

inline constexpr const char *kSweepDatabase = "ibus-web-test-sweep";
#define SWEEP_MOUNT "/sweep"

// What the database holds with the orphan left in it: the root, the kept
// file and the orphan, which only the kept file has an entry for; the kept
// file's chunk and the orphan's two.
inline constexpr idb_test::Counts kSweepLeft{3, 1, 3};
