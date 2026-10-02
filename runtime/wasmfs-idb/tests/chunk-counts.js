// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Counts the records the backend reads from and writes to its `chunks`
// store, for tests linked with this library. The backend's thread is a
// Worker whose IndexedDB calls nothing else can see, so every thread wraps
// the object store's methods as it starts, and each count goes to the
// program's own wasmfs_idb_test_count_chunks, which keeps the totals in
// memory every thread shares. A record read is one a request returned; a
// record written is one a request stored.

/** Wraps IndexedDB's object store methods in this thread. */
const wasmfsIdbCountChunks = () => {
  const store = IDBObjectStore.prototype;
  const { get, getAll, put, add } = store;

  /**
   * @template {IDBRequest} R
   * @param {IDBObjectStore} objectStore
   * @param {R} request
   * @param {(result: R["result"]) => number} records
   * @returns {R}
   */
  const countRead = (objectStore, request, records) => {
    if (objectStore.name === "chunks") {
      // Runs before the request's own success handler, so the count is in
      // before the transaction can commit and release the blocked caller.
      request.addEventListener("success", () => _wasmfs_idb_test_count_chunks(records(request.result), 0));
    }
    return request;
  };

  /** @param {IDBObjectStore} objectStore */
  const countWrite = (objectStore) => {
    if (objectStore.name === "chunks") _wasmfs_idb_test_count_chunks(0, 1);
  };

  /**
   * @this {IDBObjectStore}
   * @param {Parameters<IDBObjectStore["get"]>} args
   */
  store.get = function (...args) {
    return countRead(this, get.apply(this, args), (value) => (value === undefined ? 0 : 1));
  };
  /**
   * @this {IDBObjectStore}
   * @param {Parameters<IDBObjectStore["getAll"]>} args
   */
  store.getAll = function (...args) {
    return countRead(this, getAll.apply(this, args), (values) => values.length);
  };
  /**
   * @this {IDBObjectStore}
   * @param {Parameters<IDBObjectStore["put"]>} args
   */
  store.put = function (...args) {
    const request = put.apply(this, args);
    countWrite(this);
    return request;
  };
  /**
   * @this {IDBObjectStore}
   * @param {Parameters<IDBObjectStore["add"]>} args
   */
  store.add = function (...args) {
    const request = add.apply(this, args);
    countWrite(this);
    return request;
  };
};

addToLibrary({
  $wasmfsIdbCountChunks__deps: ["wasmfs_idb_test_count_chunks"],
  $wasmfsIdbCountChunks__postset: "wasmfsIdbCountChunks();",
  $wasmfsIdbCountChunks: wasmfsIdbCountChunks,
});
