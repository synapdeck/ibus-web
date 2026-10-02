// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Counts the transactions with strict durability that commit, and those of
// them that wrote, for tests linked with this library. The backend runs on
// its own threads, so the library wraps IndexedDB's method in every thread
// as it starts, and each commit goes to the program's own
// wasmfs_idb_test_strict_commit, which keeps the totals in memory every
// thread shares. The durability counted is the one the browser gave the
// transaction, not the one asked for.

/**
 * Wraps IDBDatabase's transaction() and IDBObjectStore's writes in this
 * thread.
 */
const wasmfsIdbCountStrictCommits = () => {
  // The strict transactions that have made a write request. Chromium and
  // Firefox sync nothing to disk for a strict commit that writes nothing.
  /** @type {WeakSet<IDBTransaction>} */
  const wrote = new WeakSet();
  const store = IDBObjectStore.prototype;
  const { put, add } = store;
  const remove = store.delete;
  /**
   * @this {IDBObjectStore}
   * @param {Parameters<IDBObjectStore["put"]>} args
   */
  store.put = function (...args) {
    wrote.add(this.transaction);
    return put.apply(this, args);
  };
  /**
   * @this {IDBObjectStore}
   * @param {Parameters<IDBObjectStore["add"]>} args
   */
  store.add = function (...args) {
    wrote.add(this.transaction);
    return add.apply(this, args);
  };
  /**
   * @this {IDBObjectStore}
   * @param {Parameters<IDBObjectStore["delete"]>} args
   */
  store.delete = function (...args) {
    wrote.add(this.transaction);
    return remove.apply(this, args);
  };
  const database = IDBDatabase.prototype;
  const { transaction } = database;
  /**
   * @this {IDBDatabase}
   * @param {Parameters<IDBDatabase["transaction"]>} args
   */
  database.transaction = function (...args) {
    const tx = transaction.apply(this, args);
    if (tx.durability === "strict") {
      const stores = Array.from(tx.objectStoreNames);
      const files =
        tx.mode === "readwrite" &&
        stores.includes("inodes") &&
        stores.includes("chunks");
      // Runs before the transaction's own complete handler, which the
      // caller sets after this returns, so the count is in before the
      // blocked caller is released.
      tx.addEventListener("complete", () =>
        _wasmfs_idb_test_strict_commit(files ? 1 : 0, wrote.has(tx) ? 1 : 0),
      );
    }
    return tx;
  };
};

addToLibrary({
  $wasmfsIdbCountStrictCommits__deps: ["wasmfs_idb_test_strict_commit"],
  $wasmfsIdbCountStrictCommits__postset: "wasmfsIdbCountStrictCommits();",
  $wasmfsIdbCountStrictCommits: wasmfsIdbCountStrictCommits,
});
