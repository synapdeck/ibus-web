// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the test libraries call in the test program that links them.

declare function _wasmfs_idb_test_count_chunks(
  read: number,
  written: number,
): void;

declare function _wasmfs_idb_test_take_quota_failure(store: number): number;

declare function _wasmfs_idb_test_take_delete_failure(store: number): number;

declare function _wasmfs_idb_test_take_open_failure(): number;

declare function _wasmfs_idb_test_strict_commit(files: number): void;
