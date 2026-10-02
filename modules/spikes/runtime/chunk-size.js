// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// For measurement links of the runtime only: a database the IndexedDB
// backend creates whose name ends in "-chunk-<bytes>" gets chunks of that
// many bytes rather than the backend's default. The backend writes the size
// into its meta store once, as it creates the database, and reads it back
// on every open, so only that first write is changed. The backend's thread
// is a Worker of its own, so every thread wraps IndexedDB as it starts.

const wasmfsIdbChunkSizeByName = () => {
  if (typeof IDBObjectStore === "undefined") return;
  const store = IDBObjectStore.prototype;
  const { put } = store;
  store.put = function (value, ...rest) {
    const { transaction } = this;
    const size = /-chunk-(\d+)$/.exec(transaction.db.name)?.[1];
    const creating =
      this.name === "meta" &&
      rest[0] === "chunkSize" &&
      transaction.mode === "versionchange";
    return put.call(
      this,
      creating && size !== undefined ? Number(size) : value,
      ...rest,
    );
  };
};

addToLibrary({
  $wasmfsIdbChunkSizeByName__postset: "wasmfsIdbChunkSizeByName();",
  $wasmfsIdbChunkSizeByName: wasmfsIdbChunkSizeByName,
});
