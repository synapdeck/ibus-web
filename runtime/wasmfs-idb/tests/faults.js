// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Fails the backend's IndexedDB calls when the test asks, for tests linked
// with this library. The backend runs on its own threads, so the library
// wraps IndexedDB's methods in every thread as it starts, and asks the
// program's own functions, which keep their state in memory every thread
// shares, whether to fail each call.

/** Wraps IndexedDB's object store and factory methods in this thread. */
const wasmfsIdbFaults = () => {
  // The program names a store by its index here.
  const stores = ["meta", "inodes", "entries", "chunks"];

  /**
   * Fails the transaction as a browser does when a write fails: it aborts
   * with the error as its own, which fails its pending requests and every
   * request made after.
   * @param {IDBTransaction} transaction
   * @param {string} name
   */
  const fail = (transaction, name) => {
    const error = new DOMException("Injected by the test", name);
    // Aborting from script would leave the error null.
    Object.defineProperty(transaction, "error", { get: () => error });
    transaction.abort();
  };

  /**
   * A write that needs more than the origin's quota.
   * @param {IDBObjectStore} objectStore
   */
  const quota = (objectStore) => {
    if (_wasmfs_idb_test_take_quota_failure(stores.indexOf(objectStore.name)))
      fail(objectStore.transaction, "QuotaExceededError");
  };

  const store = IDBObjectStore.prototype;
  const { put, add, delete: remove } = store;
  /**
   * @this {IDBObjectStore}
   * @param {Parameters<IDBObjectStore["put"]>} args
   */
  store.put = function (...args) {
    const request = put.apply(this, args);
    quota(this);
    return request;
  };
  /**
   * @this {IDBObjectStore}
   * @param {Parameters<IDBObjectStore["add"]>} args
   */
  store.add = function (...args) {
    const request = add.apply(this, args);
    quota(this);
    return request;
  };

  /**
   * @this {IDBObjectStore}
   * @param {Parameters<IDBObjectStore["delete"]>} args
   */
  store.delete = function (...args) {
    const request = remove.apply(this, args);
    if (_wasmfs_idb_test_take_delete_failure(stores.indexOf(this.name))) fail(this.transaction, "UnknownError");
    return request;
  };

  const factory = IDBFactory.prototype;
  const { open } = factory;
  /**
   * Throws as it does where the origin may not use IndexedDB.
   * @this {IDBFactory}
   * @param {Parameters<IDBFactory["open"]>} args
   */
  factory.open = function (...args) {
    if (_wasmfs_idb_test_take_open_failure()) throw new DOMException("Injected by the test", "SecurityError");
    return open.apply(this, args);
  };
};

addToLibrary({
  $wasmfsIdbFaults__deps: [
    "wasmfs_idb_test_take_quota_failure",
    "wasmfs_idb_test_take_delete_failure",
    "wasmfs_idb_test_take_open_failure",
  ],
  $wasmfsIdbFaults__postset: "wasmfsIdbFaults();",
  $wasmfsIdbFaults: wasmfsIdbFaults,
});
