// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The transactions with strict durability that have committed, counted on
// the backend's thread by the test library linked into the program. A call
// into the backend has committed before it returns, so the counts are
// complete once it has.

#pragma once

#include <emscripten.h>

#include <atomic>
#include <ostream>

// Pulls the counting library into the link.
EM_JS_DEPS(strict_commits, "$wasmfsIdbCountStrictCommits");

// Every strict commit, those of read-write transactions over the stores a
// file lives in, and of those the ones that wrote a record, which is what
// makes a browser sync to disk.
inline std::atomic<unsigned> strict_commits;
inline std::atomic<unsigned> strict_file_commits;
inline std::atomic<unsigned> strict_file_writes;

extern "C" EMSCRIPTEN_KEEPALIVE inline void
wasmfs_idb_test_strict_commit(int files, int wrote) {
  ++strict_commits;
  if (files) {
    ++strict_file_commits;
  }
  if (files && wrote) {
    ++strict_file_writes;
  }
}

struct StrictCommits {
  unsigned all;
  unsigned files;
  unsigned writing;

  friend bool operator==(const StrictCommits &a, const StrictCommits &b) {
    return a.all == b.all && a.files == b.files && a.writing == b.writing;
  }
  friend std::ostream &operator<<(std::ostream &os, const StrictCommits &c) {
    return os << c.all << " strict commit(s), " << c.files
              << " over a file's stores, " << c.writing << " of those writing";
  }
};

inline void reset_strict_commits() {
  strict_commits = 0;
  strict_file_commits = 0;
  strict_file_writes = 0;
}

// The strict commits `call` made.
template <typename Call> StrictCommits strict_commits_of(Call &&call) {
  reset_strict_commits();
  call();
  return {strict_commits.load(), strict_file_commits.load(),
          strict_file_writes.load()};
}
