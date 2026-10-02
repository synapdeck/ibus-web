/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* The records the backend has read from and written to its `chunks` store,
 * counted on its own thread by the test library linked into the program. A
 * call into the backend has committed before it returns, so the counts are
 * complete once it has. */

#pragma once

#include <emscripten.h>
#include <stdatomic.h>

/* Pulls the counting library into the link. */
EM_JS_DEPS(chunk_counts, "$wasmfsIdbCountChunks");

static atomic_uint chunk_records_read;
static atomic_uint chunk_records_written;

EMSCRIPTEN_KEEPALIVE void wasmfs_idb_test_count_chunks(unsigned read,
                                                       unsigned written) {
  atomic_fetch_add(&chunk_records_read, read);
  atomic_fetch_add(&chunk_records_written, written);
}

static void reset_chunk_counts(void) {
  atomic_store(&chunk_records_read, 0);
  atomic_store(&chunk_records_written, 0);
}
