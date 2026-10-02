/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* The transactions with strict durability that have committed, counted on
 * the backend's thread by the test library linked into the program. A call
 * into the backend has committed before it returns, so the counts are
 * complete once it has. */

#pragma once

#include <emscripten.h>
#include <stdatomic.h>

/* Pulls the counting library into the link. */
EM_JS_DEPS(strict_commits, "$wasmfsIdbCountStrictCommits");

/* Every strict commit, and those of read-write transactions over the stores
 * a file lives in. */
static atomic_uint strict_commits;
static atomic_uint strict_file_commits;

EMSCRIPTEN_KEEPALIVE void wasmfs_idb_test_strict_commit(int files) {
  atomic_fetch_add(&strict_commits, 1);
  if (files)
    atomic_fetch_add(&strict_file_commits, 1);
}

static void reset_strict_commits(void) {
  atomic_store(&strict_commits, 0);
  atomic_store(&strict_file_commits, 0);
}
