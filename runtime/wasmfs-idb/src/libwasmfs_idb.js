// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The IndexedDB side of the WasmFS IndexedDB backend, run on the backend's
// thread. A database holds four object stores: `meta` (format, chunk size,
// next inode number, root inode), `inodes` (by inode number: kind, mode,
// size and times in ms), `entries` (by [parent inode, name]: the child's
// inode number) and `chunks` (by [inode, index]: an ArrayBuffer of at most
// the chunk size). A missing chunk reads as zeros, and no chunk holds bytes
// past its file's size, so truncating and growing again never brings old
// bytes back.
//
// Values are ArrayBuffers copied out of the module's memory, never views of
// it, which is shared and can't be stored, and never Blobs, whose reads in
// Firefox wait for the page's main thread.

addToLibrary({
  $wasmfsIdbBackends__deps: ["$HandleAllocator"],
  $wasmfsIdbBackends: "new HandleAllocator()",

  // A failure that already is an errno.
  $WasmfsIdbError: class {
    constructor(errno) {
      this.errno = errno;
    }
  },

  $wasmfsIdbErrno__deps: ["$ERRNO_CODES", "$WasmfsIdbError"],
  $wasmfsIdbErrno: (e) => {
    if (e instanceof WasmfsIdbError) return e.errno;
    switch (e?.name) {
      case "QuotaExceededError":
        return -ERRNO_CODES.ENOSPC;
      case "ConstraintError":
        return -ERRNO_CODES.EEXIST;
      case "ReadOnlyError":
        return -ERRNO_CODES.EROFS;
      // A closed connection, or a database another version replaced.
      case "InvalidStateError":
      case "VersionError":
        return -ERRNO_CODES.EIO;
    }
    err("wasmfs-idb: unexpected error:", e);
    return -ERRNO_CODES.EIO;
  },

  $wasmfsIdbRequest: (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }),

  // Runs `body` in one transaction and resolves with its result once the
  // transaction has committed. A transaction commits on its own once no
  // request is pending, so `body` may await requests but nothing else.
  $wasmfsIdbTransact__deps: ["$ERRNO_CODES", "$WasmfsIdbError"],
  $wasmfsIdbTransact: async (state, stores, mode, body) => {
    if (!state.db) throw new WasmfsIdbError(-ERRNO_CODES.EIO);
    const tx = state.db.transaction(stores, mode);
    const committed = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () =>
        reject(
          tx.error ?? new DOMException("Transaction aborted", "AbortError"),
        );
    });
    let result;
    try {
      result = await body(tx);
    } catch (e) {
      committed.catch(() => {});
      try {
        tx.abort();
      } catch {
        // Already finished.
      }
      throw e;
    }
    await committed;
    return result;
  },

  // Runs an operation for a proxied call: `op` resolves with what `report`
  // writes back, or fails with what `fail` does, before the caller resumes.
  $wasmfsIdbRun__deps: [
    "emscripten_proxy_finish",
    "$wasmfsIdbBackends",
    "$wasmfsIdbErrno",
  ],
  $wasmfsIdbRun: async (ctx, id, op, report, fail) => {
    try {
      report(await op(wasmfsIdbBackends.get(id)));
    } catch (e) {
      fail(wasmfsIdbErrno(e));
    }
    _emscripten_proxy_finish(ctx);
  },

  $wasmfsIdbChunkRange: (ino, first, last) =>
    IDBKeyRange.bound([ino, first], [ino, last]),

  // A directory's entries: every name sorts after "" and before any array.
  $wasmfsIdbEntryRange: (dir) => IDBKeyRange.bound([dir, ""], [dir, []]),

  $wasmfsIdbWriteAttrs: (ptr, ino, inode) => {
    HEAP32[ptr >> 2] = 0;
    HEAPU32[(ptr + 4) >> 2] = ino;
    HEAP32[(ptr + 8) >> 2] = inode.kind;
    HEAPU32[(ptr + 12) >> 2] = inode.mode;
    HEAPF64[(ptr + 16) >> 3] = inode.size;
    HEAPF64[(ptr + 24) >> 3] = inode.atime;
    HEAPF64[(ptr + 32) >> 3] = inode.mtime;
    HEAPF64[(ptr + 40) >> 3] = inode.ctime;
  },

  // Deletes an inode and its chunks within `tx`.
  $wasmfsIdbDeleteInode__deps: ["$wasmfsIdbChunkRange"],
  $wasmfsIdbDeleteInode: (tx, ino) => {
    tx.objectStore("inodes").delete(ino);
    tx.objectStore("chunks").delete(wasmfsIdbChunkRange(ino, 0, Infinity));
  },

  // Unlinking an inode another descriptor still has open leaves it for that
  // descriptor's last close. `deleted` says whether the unlinking
  // transaction deleted it already, which it does when it was closed then;
  // a close since then leaves it to be deleted here.
  $wasmfsIdbAfterUnlink__deps: ["$wasmfsIdbTransact", "$wasmfsIdbDeleteInode"],
  $wasmfsIdbAfterUnlink: async (state, ino, deleted) => {
    if (state.openCounts.has(ino)) {
      state.unlinked.add(ino);
    } else if (!deleted) {
      await wasmfsIdbTransact(state, ["inodes", "chunks"], "readwrite", (tx) =>
        wasmfsIdbDeleteInode(tx, ino),
      );
    }
  },

  // Marks a directory changed, as unlinking or adding an entry does.
  $wasmfsIdbTouch__deps: ["$wasmfsIdbRequest"],
  $wasmfsIdbTouch: async (inodes, ino, now) => {
    const inode = await wasmfsIdbRequest(inodes.get(ino));
    if (inode) inodes.put({ ...inode, mtime: now, ctime: now }, ino);
  },

  _wasmfs_idb_open__sig: "vppipp",
  _wasmfs_idb_open__deps: [
    "emscripten_proxy_finish",
    "$wasmfsIdbBackends",
    "$wasmfsIdbErrno",
    "$wasmfsIdbRequest",
    "$wasmfsIdbTransact",
    "$UTF8ToString",
    "$ERRNO_CODES",
    "$WasmfsIdbError",
  ],
  _wasmfs_idb_open: async (ctx, namePtr, chunkSize, idPtr, rootPtr) => {
    const name = UTF8ToString(namePtr);
    try {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const meta = db.createObjectStore("meta");
        const inodes = db.createObjectStore("inodes");
        db.createObjectStore("entries");
        db.createObjectStore("chunks");
        const now = Date.now();
        meta.put(1, "format");
        meta.put(chunkSize >>> 0, "chunkSize");
        meta.put(2, "nextIno");
        meta.put(1, "root");
        inodes.put(
          { kind: 2, mode: 0o777, size: 0, atime: now, mtime: now, ctime: now },
          1,
        );
      };
      const db = await wasmfsIdbRequest(request);
      const state = {
        db,
        chunkSize: 0,
        root: 0,
        openCounts: new Map(),
        unlinked: new Set(),
      };
      // Another connection asking for a newer version waits until this one
      // closes; calls after that fail.
      db.onversionchange = () => {
        db.close();
        state.db = null;
        err(`wasmfs-idb: ${name} closed for a version change`);
      };
      db.onclose = () => {
        state.db = null;
        err(`wasmfs-idb: ${name} closed unexpectedly`);
      };
      const [format, storedChunkSize, root] = await wasmfsIdbTransact(
        state,
        ["meta"],
        "readonly",
        (tx) => {
          const meta = tx.objectStore("meta");
          return Promise.all(
            ["format", "chunkSize", "root"].map((key) =>
              wasmfsIdbRequest(meta.get(key)),
            ),
          );
        },
      );
      if (format !== 1) {
        db.close();
        throw new WasmfsIdbError(-ERRNO_CODES.EIO);
      }
      state.chunkSize = storedChunkSize;
      state.root = root;
      HEAP32[idPtr >> 2] = wasmfsIdbBackends.allocate(state);
      HEAPU32[rootPtr >> 2] = root;
    } catch (e) {
      HEAP32[idPtr >> 2] = wasmfsIdbErrno(e);
    }
    _emscripten_proxy_finish(ctx);
  },

  _wasmfs_idb_get_attrs__sig: "vpiip",
  _wasmfs_idb_get_attrs__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$wasmfsIdbWriteAttrs",
    "$ERRNO_CODES",
  ],
  _wasmfs_idb_get_attrs: (ctx, id, ino, attrsPtr) => {
    ino >>>= 0;
    wasmfsIdbRun(
      ctx,
      id,
      (state) =>
        wasmfsIdbTransact(state, ["inodes"], "readonly", (tx) =>
          wasmfsIdbRequest(tx.objectStore("inodes").get(ino)),
        ),
      (inode) => {
        if (inode) wasmfsIdbWriteAttrs(attrsPtr, ino, inode);
        else HEAP32[attrsPtr >> 2] = -ERRNO_CODES.ENOENT;
      },
      (errno) => (HEAP32[attrsPtr >> 2] = errno),
    );
  },

  _wasmfs_idb_get_child__sig: "vpiippp",
  _wasmfs_idb_get_child__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$wasmfsIdbWriteAttrs",
    "$UTF8ToString",
    "$ERRNO_CODES",
    "$stringToUTF8OnStack",
    "$stackSave",
    "$stackRestore",
    "_wasmfs_idb_set_string",
  ],
  _wasmfs_idb_get_child: (ctx, id, parent, namePtr, attrsPtr, targetPtr) => {
    parent >>>= 0;
    const name = UTF8ToString(namePtr);
    wasmfsIdbRun(
      ctx,
      id,
      (state) =>
        wasmfsIdbTransact(
          state,
          ["entries", "inodes"],
          "readonly",
          async (tx) => {
            const ino = await wasmfsIdbRequest(
              tx.objectStore("entries").get([parent, name]),
            );
            if (ino === undefined) return undefined;
            return {
              ino,
              inode: await wasmfsIdbRequest(tx.objectStore("inodes").get(ino)),
            };
          },
        ),
      (found) => {
        if (!found?.inode) {
          HEAP32[attrsPtr >> 2] = -ERRNO_CODES.ENOENT;
          return;
        }
        wasmfsIdbWriteAttrs(attrsPtr, found.ino, found.inode);
        if (found.inode.target !== undefined) {
          const sp = stackSave();
          __wasmfs_idb_set_string(
            targetPtr,
            stringToUTF8OnStack(found.inode.target),
          );
          stackRestore(sp);
        }
      },
      (errno) => (HEAP32[attrsPtr >> 2] = errno),
    );
  },

  _wasmfs_idb_insert__sig: "vpiipiipp",
  _wasmfs_idb_insert__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$wasmfsIdbTouch",
    "$wasmfsIdbWriteAttrs",
    "$UTF8ToString",
    "$lengthBytesUTF8",
    "$ERRNO_CODES",
    "$WasmfsIdbError",
  ],
  _wasmfs_idb_insert: (
    ctx,
    id,
    parent,
    namePtr,
    kind,
    mode,
    targetPtr,
    attrsPtr,
  ) => {
    parent >>>= 0;
    const name = UTF8ToString(namePtr);
    const target = targetPtr ? UTF8ToString(targetPtr) : undefined;
    wasmfsIdbRun(
      ctx,
      id,
      (state) =>
        wasmfsIdbTransact(
          state,
          ["meta", "inodes", "entries"],
          "readwrite",
          async (tx) => {
            const meta = tx.objectStore("meta");
            const inodes = tx.objectStore("inodes");
            const ino = await wasmfsIdbRequest(meta.get("nextIno"));
            if (ino > 0xffffffff) throw new WasmfsIdbError(-ERRNO_CODES.ENOSPC);
            // Fails with a ConstraintError if the name is taken.
            await wasmfsIdbRequest(
              tx.objectStore("entries").add(ino, [parent, name]),
            );
            const now = Date.now();
            const inode = {
              kind,
              mode: mode >>> 0,
              size: 0,
              atime: now,
              mtime: now,
              ctime: now,
            };
            if (target !== undefined) {
              inode.target = target;
              inode.size = lengthBytesUTF8(target);
            }
            meta.put(ino + 1, "nextIno");
            inodes.put(inode, ino);
            await wasmfsIdbTouch(inodes, parent, now);
            return { ino, inode };
          },
        ),
      ({ ino, inode }) => wasmfsIdbWriteAttrs(attrsPtr, ino, inode),
      (errno) => (HEAP32[attrsPtr >> 2] = errno),
    );
  },

  _wasmfs_idb_move__sig: "vpiiipipp",
  _wasmfs_idb_move__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$wasmfsIdbTouch",
    "$wasmfsIdbDeleteInode",
    "$wasmfsIdbAfterUnlink",
    "$UTF8ToString",
    "$ERRNO_CODES",
    "$WasmfsIdbError",
  ],
  _wasmfs_idb_move: (
    ctx,
    id,
    ino,
    oldParent,
    oldNamePtr,
    newParent,
    newNamePtr,
    errPtr,
  ) => {
    ino >>>= 0;
    oldParent >>>= 0;
    newParent >>>= 0;
    const oldName = UTF8ToString(oldNamePtr);
    const newName = UTF8ToString(newNamePtr);
    wasmfsIdbRun(
      ctx,
      id,
      async (state) => {
        if (oldParent === newParent && oldName === newName) return;
        const replaced = await wasmfsIdbTransact(
          state,
          ["inodes", "entries", "chunks"],
          "readwrite",
          async (tx) => {
            const entries = tx.objectStore("entries");
            const inodes = tx.objectStore("inodes");
            const [moving, existing] = await Promise.all([
              wasmfsIdbRequest(entries.get([oldParent, oldName])),
              wasmfsIdbRequest(entries.get([newParent, newName])),
            ]);
            if (moving !== ino) throw new WasmfsIdbError(-ERRNO_CODES.ENOENT);
            entries.delete([oldParent, oldName]);
            entries.put(ino, [newParent, newName]);
            const now = Date.now();
            await wasmfsIdbTouch(inodes, oldParent, now);
            if (newParent !== oldParent)
              await wasmfsIdbTouch(inodes, newParent, now);
            if (existing === undefined) return undefined;
            const deleted = !state.openCounts.has(existing);
            if (deleted) wasmfsIdbDeleteInode(tx, existing);
            return { ino: existing, deleted };
          },
        );
        if (replaced)
          await wasmfsIdbAfterUnlink(state, replaced.ino, replaced.deleted);
      },
      () => {},
      (errno) => (HEAP32[errPtr >> 2] = errno),
    );
  },

  _wasmfs_idb_remove__sig: "vpiipp",
  _wasmfs_idb_remove__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$wasmfsIdbTouch",
    "$wasmfsIdbDeleteInode",
    "$wasmfsIdbAfterUnlink",
    "$UTF8ToString",
  ],
  _wasmfs_idb_remove: (ctx, id, parent, namePtr, errPtr) => {
    parent >>>= 0;
    const name = UTF8ToString(namePtr);
    wasmfsIdbRun(
      ctx,
      id,
      async (state) => {
        const removed = await wasmfsIdbTransact(
          state,
          ["inodes", "entries", "chunks"],
          "readwrite",
          async (tx) => {
            const entries = tx.objectStore("entries");
            const ino = await wasmfsIdbRequest(entries.get([parent, name]));
            if (ino === undefined) return undefined;
            entries.delete([parent, name]);
            await wasmfsIdbTouch(tx.objectStore("inodes"), parent, Date.now());
            const deleted = !state.openCounts.has(ino);
            if (deleted) wasmfsIdbDeleteInode(tx, ino);
            return { ino, deleted };
          },
        );
        if (removed)
          await wasmfsIdbAfterUnlink(state, removed.ino, removed.deleted);
      },
      () => {},
      (errno) => (HEAP32[errPtr >> 2] = errno),
    );
  },

  _wasmfs_idb_count_entries__sig: "vpiip",
  _wasmfs_idb_count_entries__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$wasmfsIdbEntryRange",
  ],
  _wasmfs_idb_count_entries: (ctx, id, dir, countPtr) => {
    dir >>>= 0;
    wasmfsIdbRun(
      ctx,
      id,
      (state) =>
        wasmfsIdbTransact(state, ["entries"], "readonly", (tx) =>
          wasmfsIdbRequest(
            tx.objectStore("entries").count(wasmfsIdbEntryRange(dir)),
          ),
        ),
      (count) => (HEAP32[countPtr >> 2] = count),
      (errno) => (HEAP32[countPtr >> 2] = errno),
    );
  },

  _wasmfs_idb_get_entries__sig: "vpiipp",
  _wasmfs_idb_get_entries__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$wasmfsIdbEntryRange",
    "$stringToUTF8OnStack",
    "$stackSave",
    "$stackRestore",
    "_wasmfs_idb_record_entry",
  ],
  _wasmfs_idb_get_entries: (ctx, id, dir, entriesPtr, errPtr) => {
    dir >>>= 0;
    wasmfsIdbRun(
      ctx,
      id,
      (state) =>
        wasmfsIdbTransact(
          state,
          ["entries", "inodes"],
          "readonly",
          async (tx) => {
            const entries = tx.objectStore("entries");
            const inodes = tx.objectStore("inodes");
            const range = wasmfsIdbEntryRange(dir);
            const [keys, inos] = await Promise.all([
              wasmfsIdbRequest(entries.getAllKeys(range)),
              wasmfsIdbRequest(entries.getAll(range)),
            ]);
            const children = await Promise.all(
              inos.map((ino) => wasmfsIdbRequest(inodes.get(ino))),
            );
            return keys.map(([, name], i) => ({
              name,
              kind: children[i]?.kind ?? 0,
            }));
          },
        ),
      (list) => {
        for (const { name, kind } of list) {
          const sp = stackSave();
          __wasmfs_idb_record_entry(
            entriesPtr,
            stringToUTF8OnStack(name),
            kind,
          );
          stackRestore(sp);
        }
      },
      (errno) => (HEAP32[errPtr >> 2] = errno),
    );
  },

  _wasmfs_idb_open_file__sig: "vii",
  _wasmfs_idb_open_file__deps: ["$wasmfsIdbBackends"],
  _wasmfs_idb_open_file: (id, ino) => {
    ino >>>= 0;
    const { openCounts } = wasmfsIdbBackends.get(id);
    openCounts.set(ino, (openCounts.get(ino) ?? 0) + 1);
  },

  _wasmfs_idb_close_file__sig: "vpiip",
  _wasmfs_idb_close_file__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbDeleteInode",
  ],
  _wasmfs_idb_close_file: (ctx, id, ino, errPtr) => {
    ino >>>= 0;
    wasmfsIdbRun(
      ctx,
      id,
      async (state) => {
        const count = state.openCounts.get(ino) - 1;
        if (count > 0) {
          state.openCounts.set(ino, count);
          return;
        }
        state.openCounts.delete(ino);
        if (state.unlinked.delete(ino)) {
          await wasmfsIdbTransact(
            state,
            ["inodes", "chunks"],
            "readwrite",
            (tx) => wasmfsIdbDeleteInode(tx, ino),
          );
        }
      },
      () => {},
      (errno) => (HEAP32[errPtr >> 2] = errno),
    );
  },

  _wasmfs_idb_read__sig: "vpiipidp",
  _wasmfs_idb_read__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$wasmfsIdbChunkRange",
    "$ERRNO_CODES",
    "$WasmfsIdbError",
  ],
  _wasmfs_idb_read: (ctx, id, ino, bufPtr, len, offset, nreadPtr) => {
    ino >>>= 0;
    len >>>= 0;
    wasmfsIdbRun(
      ctx,
      id,
      (state) =>
        wasmfsIdbTransact(
          state,
          ["inodes", "chunks"],
          "readonly",
          async (tx) => {
            const inode = await wasmfsIdbRequest(
              tx.objectStore("inodes").get(ino),
            );
            if (!inode) throw new WasmfsIdbError(-ERRNO_CODES.ENOENT);
            const end = Math.min(offset + len, inode.size);
            if (end <= offset) return 0;
            const { chunkSize } = state;
            const range = wasmfsIdbChunkRange(
              ino,
              Math.floor(offset / chunkSize),
              Math.floor((end - 1) / chunkSize),
            );
            const chunks = tx.objectStore("chunks");
            const [keys, values] = await Promise.all([
              wasmfsIdbRequest(chunks.getAllKeys(range)),
              wasmfsIdbRequest(chunks.getAll(range)),
            ]);
            // The caller is blocked until this call finishes, so its buffer
            // stays put.
            HEAPU8.fill(0, bufPtr, bufPtr + (end - offset));
            keys.forEach(([, index], i) => {
              const start = index * chunkSize;
              const chunk = new Uint8Array(values[i]);
              const from = Math.max(offset, start);
              const to = Math.min(end, start + chunk.length);
              if (to > from)
                HEAPU8.set(
                  chunk.subarray(from - start, to - start),
                  bufPtr + (from - offset),
                );
            });
            return end - offset;
          },
        ),
      (nread) => (HEAP32[nreadPtr >> 2] = nread),
      (errno) => (HEAP32[nreadPtr >> 2] = errno),
    );
  },

  _wasmfs_idb_write__sig: "vpiipidp",
  _wasmfs_idb_write__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$ERRNO_CODES",
    "$WasmfsIdbError",
  ],
  _wasmfs_idb_write: (ctx, id, ino, bufPtr, len, offset, nwrittenPtr) => {
    ino >>>= 0;
    len >>>= 0;
    wasmfsIdbRun(
      ctx,
      id,
      async (state) => {
        if (len === 0) return 0;
        return wasmfsIdbTransact(
          state,
          ["inodes", "chunks"],
          "readwrite",
          async (tx) => {
            const inodes = tx.objectStore("inodes");
            const chunks = tx.objectStore("chunks");
            const inode = await wasmfsIdbRequest(inodes.get(ino));
            if (!inode) throw new WasmfsIdbError(-ERRNO_CODES.ENOENT);
            const { chunkSize } = state;
            const end = offset + len;
            const first = Math.floor(offset / chunkSize);
            const last = Math.floor((end - 1) / chunkSize);
            // Only a chunk the write covers in part, and that holds bytes of
            // the file the write keeps, needs reading.
            const keeps = (index) => {
              const start = index * chunkSize;
              return (
                start < inode.size &&
                (offset > start ||
                  end < Math.min(start + chunkSize, inode.size))
              );
            };
            const edges = [...new Set([first, last])].filter(keeps);
            const old = new Map(
              await Promise.all(
                edges.map(async (index) => [
                  index,
                  await wasmfsIdbRequest(chunks.get([ino, index])),
                ]),
              ),
            );
            for (let index = first; index <= last; index++) {
              const start = index * chunkSize;
              const from = Math.max(offset, start);
              const to = Math.min(end, start + chunkSize);
              const previous = old.get(index);
              const chunk = new Uint8Array(
                Math.max(previous?.byteLength ?? 0, to - start),
              );
              if (previous) chunk.set(new Uint8Array(previous));
              chunk.set(
                HEAPU8.subarray(
                  bufPtr + (from - offset),
                  bufPtr + (to - offset),
                ),
                from - start,
              );
              chunks.put(chunk.buffer, [ino, index]);
            }
            const now = Date.now();
            inodes.put(
              {
                ...inode,
                size: Math.max(inode.size, end),
                mtime: now,
                ctime: now,
              },
              ino,
            );
            return len;
          },
        );
      },
      (nwritten) => (HEAP32[nwrittenPtr >> 2] = nwritten),
      (errno) => (HEAP32[nwrittenPtr >> 2] = errno),
    );
  },

  _wasmfs_idb_get_size__sig: "vpiip",
  _wasmfs_idb_get_size__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$ERRNO_CODES",
    "$WasmfsIdbError",
  ],
  _wasmfs_idb_get_size: (ctx, id, ino, sizePtr) => {
    ino >>>= 0;
    wasmfsIdbRun(
      ctx,
      id,
      (state) =>
        wasmfsIdbTransact(state, ["inodes"], "readonly", async (tx) => {
          const inode = await wasmfsIdbRequest(
            tx.objectStore("inodes").get(ino),
          );
          if (!inode) throw new WasmfsIdbError(-ERRNO_CODES.ENOENT);
          return inode.size;
        }),
      (size) => (HEAPF64[sizePtr >> 3] = size),
      (errno) => (HEAPF64[sizePtr >> 3] = errno),
    );
  },

  _wasmfs_idb_set_size__sig: "vpiidp",
  _wasmfs_idb_set_size__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$wasmfsIdbChunkRange",
    "$ERRNO_CODES",
    "$WasmfsIdbError",
  ],
  _wasmfs_idb_set_size: (ctx, id, ino, size, errPtr) => {
    ino >>>= 0;
    wasmfsIdbRun(
      ctx,
      id,
      (state) =>
        wasmfsIdbTransact(
          state,
          ["inodes", "chunks"],
          "readwrite",
          async (tx) => {
            const inodes = tx.objectStore("inodes");
            const chunks = tx.objectStore("chunks");
            const inode = await wasmfsIdbRequest(inodes.get(ino));
            if (!inode) throw new WasmfsIdbError(-ERRNO_CODES.ENOENT);
            if (size === inode.size) return;
            // Growing needs no chunks, since missing ones read as zeros.
            if (size < inode.size) {
              const { chunkSize } = state;
              chunks.delete(
                wasmfsIdbChunkRange(ino, Math.ceil(size / chunkSize), Infinity),
              );
              const kept = size % chunkSize;
              if (kept) {
                const key = [ino, Math.floor(size / chunkSize)];
                const chunk = await wasmfsIdbRequest(chunks.get(key));
                if (chunk && chunk.byteLength > kept)
                  chunks.put(chunk.slice(0, kept), key);
              }
            }
            const now = Date.now();
            inodes.put({ ...inode, size, mtime: now, ctime: now }, ino);
          },
        ),
      () => {},
      (errno) => (HEAP32[errPtr >> 2] = errno),
    );
  },

  _wasmfs_idb_set_mode__sig: "vpiiip",
  _wasmfs_idb_set_mode__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$ERRNO_CODES",
    "$WasmfsIdbError",
  ],
  _wasmfs_idb_set_mode: (ctx, id, ino, mode, errPtr) => {
    ino >>>= 0;
    wasmfsIdbRun(
      ctx,
      id,
      (state) =>
        wasmfsIdbTransact(state, ["inodes"], "readwrite", async (tx) => {
          const inodes = tx.objectStore("inodes");
          const inode = await wasmfsIdbRequest(inodes.get(ino));
          if (!inode) throw new WasmfsIdbError(-ERRNO_CODES.ENOENT);
          inodes.put({ ...inode, mode: mode >>> 0, ctime: Date.now() }, ino);
        }),
      () => {},
      (errno) => (HEAP32[errPtr >> 2] = errno),
    );
  },

  _wasmfs_idb_set_times__sig: "vpiiddp",
  _wasmfs_idb_set_times__deps: [
    "$wasmfsIdbRun",
    "$wasmfsIdbTransact",
    "$wasmfsIdbRequest",
    "$ERRNO_CODES",
    "$WasmfsIdbError",
  ],
  _wasmfs_idb_set_times: (ctx, id, ino, atime, mtime, errPtr) => {
    ino >>>= 0;
    wasmfsIdbRun(
      ctx,
      id,
      (state) =>
        wasmfsIdbTransact(state, ["inodes"], "readwrite", async (tx) => {
          const inodes = tx.objectStore("inodes");
          const inode = await wasmfsIdbRequest(inodes.get(ino));
          if (!inode) throw new WasmfsIdbError(-ERRNO_CODES.ENOENT);
          const changed = { ...inode, ctime: Date.now() };
          if (atime !== Infinity) changed.atime = atime;
          if (mtime !== Infinity) changed.mtime = mtime;
          inodes.put(changed, ino);
        }),
      () => {},
      (errno) => (HEAP32[errPtr >> 2] = errno),
    );
  },
});
