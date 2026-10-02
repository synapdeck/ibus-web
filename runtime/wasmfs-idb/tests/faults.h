/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Failures the test injects into the backend's IndexedDB calls, through the
 * test library linked into the program. Each one armed fails the next call
 * it applies to, on whichever thread makes it, and is then spent. */

#pragma once

#include <emscripten.h>
#include <stdatomic.h>

/* Pulls the library into the link. */
EM_JS_DEPS(faults, "$wasmfsIdbFaults");

/* The backend's object stores, in the library's order. */
enum idb_store { IDB_META, IDB_INODES, IDB_ENTRIES, IDB_CHUNKS };

static atomic_int quota_store = -1;
static atomic_uint quota_skip;
static atomic_int delete_store = -1;
static atomic_int open_failure;

/* Lets `skip` writes to `store` through, then fails the next one's
 * transaction with a QuotaExceededError. */
static void fail_put(enum idb_store store, unsigned skip) {
  atomic_store(&quota_skip, skip);
  atomic_store(&quota_store, store);
}

/* Whether the quota failure armed is still waiting for its write. */
static int put_failure_pending(void) { return atomic_load(&quota_store) >= 0; }

/* Fails the transaction of the next delete from `store` with an
 * UnknownError, as a failing disk does. */
static void fail_delete(enum idb_store store) {
  atomic_store(&delete_store, store);
}

/* Whether the delete failure armed is still waiting for its delete. */
static int delete_failure_pending(void) {
  return atomic_load(&delete_store) >= 0;
}

/* Makes the next indexedDB.open() throw a SecurityError. */
static void fail_open(void) { atomic_store(&open_failure, 1); }

EMSCRIPTEN_KEEPALIVE int wasmfs_idb_test_take_quota_failure(int store) {
  if (store != atomic_load(&quota_store))
    return 0;
  if (atomic_load(&quota_skip) > 0) {
    atomic_fetch_sub(&quota_skip, 1);
    return 0;
  }
  atomic_store(&quota_store, -1);
  return 1;
}

EMSCRIPTEN_KEEPALIVE int wasmfs_idb_test_take_delete_failure(int store) {
  int armed = store;
  return atomic_compare_exchange_strong(&delete_store, &armed, -1);
}

EMSCRIPTEN_KEEPALIVE int wasmfs_idb_test_take_open_failure(void) {
  return atomic_exchange(&open_failure, 0);
}
