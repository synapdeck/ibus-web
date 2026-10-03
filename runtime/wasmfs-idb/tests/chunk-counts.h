// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The records the backend has read from and written to its `chunks` store,
// counted on its own thread by the test library linked into the program. A
// call into the backend has committed before it returns, so the counts are
// complete once it has.

#pragma once

#include <emscripten.h>

#include <atomic>
#include <ostream>

// Pulls the counting library into the link.
EM_JS_DEPS(chunk_counts, "$wasmfsIdbCountChunks");

inline std::atomic<unsigned> chunk_records_read;
inline std::atomic<unsigned> chunk_records_written;

extern "C" EMSCRIPTEN_KEEPALIVE inline void
wasmfs_idb_test_count_chunks(unsigned read, unsigned written) {
  chunk_records_read += read;
  chunk_records_written += written;
}

struct ChunkCounts {
  unsigned read;
  unsigned written;

  friend bool operator==(const ChunkCounts &a, const ChunkCounts &b) {
    return a.read == b.read && a.written == b.written;
  }
  friend std::ostream &operator<<(std::ostream &os, const ChunkCounts &c) {
    return os << c.read << " chunk record(s) read, " << c.written << " written";
  }
};

// The chunk records `call` read and wrote.
template <typename Call> ChunkCounts chunk_records(Call &&call) {
  chunk_records_read = 0;
  chunk_records_written = 0;
  call();
  return {chunk_records_read.load(), chunk_records_written.load()};
}
