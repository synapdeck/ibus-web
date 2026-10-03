// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Failures the test injects into the backend's IndexedDB calls, through the
// test library linked into the program. Each one armed fails the next call
// it applies to, on whichever thread makes it, and is then spent.

#pragma once

#include <emscripten.h>

#include <atomic>

// Pulls the library into the link.
EM_JS_DEPS(faults, "$wasmfsIdbFaults");

// The backend's object stores, in the library's order.
enum idb_store { IDB_META, IDB_INODES, IDB_ENTRIES, IDB_CHUNKS };

inline std::atomic<int> quota_store{-1};
inline std::atomic<unsigned> quota_skip;
inline std::atomic<int> delete_store{-1};
inline std::atomic<int> open_failure;

// Lets `skip` writes to `store` through, then fails the next one's
// transaction with a QuotaExceededError.
inline void fail_put(idb_store store, unsigned skip) {
  quota_skip = skip;
  quota_store = store;
}

// Whether the quota failure armed is still waiting for its write.
inline bool put_failure_pending() { return quota_store >= 0; }

// Fails the transaction of the next delete from `store` with an
// UnknownError, as a failing disk does.
inline void fail_delete(idb_store store) { delete_store = store; }

// Whether the delete failure armed is still waiting for its delete.
inline bool delete_failure_pending() { return delete_store >= 0; }

// Makes the next indexedDB.open() throw a SecurityError.
inline void fail_open() { open_failure = 1; }

// Spends every failure still armed, so none outlives its test.
inline void disarm_faults() {
  quota_store = -1;
  delete_store = -1;
  open_failure = 0;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE inline int wasmfs_idb_test_take_quota_failure(int store) {
  if (store != quota_store) {
    return 0;
  }
  if (quota_skip > 0) {
    --quota_skip;
    return 0;
  }
  quota_store = -1;
  return 1;
}

EMSCRIPTEN_KEEPALIVE inline int wasmfs_idb_test_take_delete_failure(int store) {
  int armed = store;
  return delete_store.compare_exchange_strong(armed, -1);
}

EMSCRIPTEN_KEEPALIVE inline int wasmfs_idb_test_take_open_failure() {
  return open_failure.exchange(0);
}

} // extern "C"
