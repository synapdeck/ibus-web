/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#pragma once

#include <emscripten/wasmfs.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opens (creating if needed) the IndexedDB database `database` and returns
 * a backend whose root is that database's root directory. Must be called on
 * a pthread or a Worker's main thread, never the browser's main thread.
 * Returns NULL if IndexedDB is unavailable or the database can't be opened,
 * and reports why on stderr. */
backend_t wasmfs_create_idb_backend(const char *database, uint32_t flags);

/* The backend refuses every change with EROFS until its window is opened
 * (wasmfs_idb_backend_set_writable), and doesn't sweep the database. */
#define WASMFS_IDB_READ_ONLY 0x1u

/* Makes `backend`, one that wasmfs_create_idb_backend returned, read-only
 * for good: every change started after it fails with EROFS, as through a
 * backend created with WASMFS_IDB_READ_ONLY, descriptors already open for
 * writing included, while reads, closes and fsync() still work. The last
 * close of a file unlinked before the seal still deletes what it stored. A
 * change another thread has already started may still complete, so seal
 * once no other thread is writing. Sealing doesn't make earlier writes
 * durable; fsync() first. */
void wasmfs_idb_backend_seal(backend_t backend);

/* Opens or shuts `backend`'s window for changes. While it is shut every
 * change fails with EROFS, as through a sealed backend, descriptors already
 * open for writing included; while it is open the backend takes changes. It
 * starts open, or shut for a backend created with WASMFS_IDB_READ_ONLY,
 * which also never swept the database, so a window opened on one is for a
 * writer the caller has made the database's only one. Returns 0, or
 * -EROFS for opening a sealed backend's, which stays shut for good. A
 * change another thread has already started as the window shuts may still
 * complete, so shut it once no other thread is writing. */
int wasmfs_idb_backend_set_writable(backend_t backend, bool writable);

/* Whether the database's connection has closed under `backend`, one that
 * wasmfs_create_idb_backend returned: another connection opened a newer
 * version of the database, or the browser closed it. Every later call that
 * reaches the database then fails with EIO, and nothing reopens it. */
int wasmfs_idb_backend_closed(backend_t backend);

#ifdef __cplusplus
}
#endif
