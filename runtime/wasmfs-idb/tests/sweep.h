/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* What sweep.1 leaves for sweep.2. */

#pragma once

#define SWEEP_DATABASE "ibus-web-test-sweep"
#define SWEEP_MOUNT "/sweep"

/* What the database holds with the orphan sweep.1 leaves: the root, the
 * kept file and the orphan, which only the kept file has an entry for; the
 * kept file's chunk and the orphan's two. */
#define SWEEP_LEFT_INODES 3
#define SWEEP_LEFT_ENTRIES 1
#define SWEEP_LEFT_CHUNKS 3
