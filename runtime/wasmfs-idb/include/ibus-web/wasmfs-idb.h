/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#pragma once

#include <emscripten/wasmfs.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opens (creating if needed) the IndexedDB database `database` and returns
 * a backend whose root is that database's root directory. Must be called on
 * a pthread or a Worker's main thread, never the browser's main thread.
 * Returns NULL if IndexedDB is unavailable or the database can't be opened.
 */
backend_t wasmfs_create_idb_backend(const char *database, uint32_t flags);

/* The backend refuses every change with EROFS. */
#define WASMFS_IDB_READ_ONLY 0x1u

#ifdef __cplusplus
}
#endif
