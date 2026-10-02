// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The JavaScript side of the IndexedDB backend. Every function runs on the
// backend's thread. Those taking a proxying context are asynchronous: each
// runs one IndexedDB transaction, writes its results through the pointers it
// was given and then finishes the context, which releases the blocked
// caller. Errors are negative errno values. Offsets and sizes travel as
// doubles, which hold every size a file may have exactly; inode numbers are
// the database's own.

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include <emscripten/proxying.h>

#include "file.h"

// What the database stores for an inode, as the JavaScript side writes it.
struct IdbAttrs {
  int32_t err;
  uint32_t ino;
  int32_t kind;
  uint32_t mode;
  double atime;
  double mtime;
  double ctime;
};

// The JavaScript side writes these fields at fixed offsets.
static_assert(offsetof(IdbAttrs, err) == 0);
static_assert(offsetof(IdbAttrs, ino) == 4);
static_assert(offsetof(IdbAttrs, kind) == 8);
static_assert(offsetof(IdbAttrs, mode) == 12);
static_assert(offsetof(IdbAttrs, atime) == 16);
static_assert(offsetof(IdbAttrs, mtime) == 24);
static_assert(offsetof(IdbAttrs, ctime) == 32);

// The database stores a file's kind as WasmFS numbers it.
static_assert(wasmfs::File::DataFileKind == 1);
static_assert(wasmfs::File::DirectoryKind == 2);
static_assert(wasmfs::File::SymlinkKind == 3);

extern "C" {

// Opens the database `name`, creating it with chunks of `chunk_size` bytes if
// it doesn't exist, and unless `read_only`, deletes the inodes no directory
// holds. Writes the backend's handle, or an error, to `id` and the root
// directory's inode to `root`. Sets `*closed` to 1, atomically, once the
// connection has closed.
void _wasmfs_idb_open(em_proxying_ctx *ctx, const char *name,
                      uint32_t chunk_size, int read_only, int32_t *closed,
                      int *id, uint32_t *root);

// The inode's stored attributes; attrs->err is -ENOENT if it doesn't exist.
void _wasmfs_idb_get_attrs(em_proxying_ctx *ctx, int id, uint32_t ino,
                           IdbAttrs *attrs);

// The child `name` of `parent`, with its attributes and, for a symlink, its
// target; attrs->err is -ENOENT if there is none.
void _wasmfs_idb_get_child(em_proxying_ctx *ctx, int id, uint32_t parent,
                           const char *name, IdbAttrs *attrs,
                           std::string *target);

// Creates an inode of `kind` as the child `name` of `parent`. `target` is a
// symlink's target and null otherwise.
void _wasmfs_idb_insert(em_proxying_ctx *ctx, int id, uint32_t parent,
                        const char *name, int kind, uint32_t mode,
                        const char *target, IdbAttrs *attrs);

// Moves `ino`, the child `old_name` of `old_parent`, to be the child
// `new_name` of `new_parent`, replacing whatever was there.
void _wasmfs_idb_move(em_proxying_ctx *ctx, int id, uint32_t ino,
                      uint32_t old_parent, const char *old_name,
                      uint32_t new_parent, const char *new_name, int *err);

void _wasmfs_idb_remove(em_proxying_ctx *ctx, int id, uint32_t parent,
                        const char *name, int *err);

void _wasmfs_idb_count_entries(em_proxying_ctx *ctx, int id, uint32_t dir,
                               int32_t *count);

// Calls _wasmfs_idb_record_entry for each of the directory's entries.
void _wasmfs_idb_get_entries(em_proxying_ctx *ctx, int id, uint32_t dir,
                             std::vector<wasmfs::Directory::Entry> *entries,
                             int *err);

// Counts a descriptor open on `ino`, so that unlinking it keeps its data;
// -ENOENT if an unlink deleted the inode first.
void _wasmfs_idb_open_file(em_proxying_ctx *ctx, int id, uint32_t ino,
                           int *err);

// Uncounts one; the last close of an unlinked inode deletes it.
void _wasmfs_idb_close_file(em_proxying_ctx *ctx, int id, uint32_t ino,
                            int *err);

void _wasmfs_idb_read(em_proxying_ctx *ctx, int id, uint32_t ino, uint8_t *buf,
                      uint32_t len, double offset, int32_t *nread);

// Commits the bytes before finishing.
void _wasmfs_idb_write(em_proxying_ctx *ctx, int id, uint32_t ino,
                       const uint8_t *buf, uint32_t len, double offset,
                       int32_t *nwritten);

void _wasmfs_idb_get_size(em_proxying_ctx *ctx, int id, uint32_t ino,
                          double *size, int *err);

void _wasmfs_idb_set_size(em_proxying_ctx *ctx, int id, uint32_t ino,
                          double size, int *err);

void _wasmfs_idb_set_mode(em_proxying_ctx *ctx, int id, uint32_t ino,
                          uint32_t mode, int *err);

// Returns once everything committed before it is durable.
void _wasmfs_idb_flush(em_proxying_ctx *ctx, int id, int *err);

// Infinity leaves that time as it is.
void _wasmfs_idb_set_times(em_proxying_ctx *ctx, int id, uint32_t ino,
                           double atime, double mtime, int *err);

} // extern "C"
