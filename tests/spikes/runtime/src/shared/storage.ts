// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The storage experiments' commands to their Workers: where engine data could
// live (IndexedDB, Cache Storage, the origin's private file system) and
// whether reading it waits for the page's main thread.

export type StoreLayout = {
  name: string;
  chunks: number;
  size: number;
  // Values stored as Blobs rather than ArrayBuffers.
  blob: boolean;
};

// The timed commands carry the page's epoch, which the page sets as it
// sends them.
export type TimedCommand =
  // Reads keys 0..chunks-1 in turn in one readonly transaction, on the
  // connection idb-open kept or on one it opens; reads Blob values through
  // arrayBuffer() once the transaction is done.
  | { op: "idb-read"; epoch: number; db: string; store: string; chunks: number }
  // Puts chunks fresh values of size bytes in one readwrite transaction.
  | {
      op: "idb-write";
      epoch: number;
      db: string;
      store: string;
      chunks: number;
      size: number;
    }
  | { op: "cache-read"; epoch: number; cache: string; chunks: number }
  // Reads the file in chunks of size bytes as WasmFS's read-only path does:
  // getFile() once, then a slice's arrayBuffer() per read.
  | {
      op: "opfs-blob-read";
      epoch: number;
      file: string;
      chunks: number;
      size: number;
    }
  | {
      op: "opfs-sync-read";
      epoch: number;
      file: string;
      chunks: number;
      size: number;
    };

export type LatencySource = "idb-tx-per-read" | "idb-one-tx" | "opfs-sync" | "opfs-blob";

export type StorageCommand =
  | TimedCommand
  // Creates db at version 1 with the stores, each holding random bytes
  // under keys 0..chunks-1.
  | { op: "idb-fill"; db: string; stores: StoreLayout[] }
  // Puts chunks responses of random bytes, one per chunkUrl(i).
  | { op: "cache-fill"; cache: string; chunks: number; size: number }
  | { op: "opfs-fill"; file: string; size: number }
  // Opens db and keeps the connection, noting any versionchange event on it.
  | { op: "idb-open"; db: string }
  // Closes the kept connection; returns the events it saw.
  | { op: "idb-close"; db: string }
  // Opens db at version, waiting at most waitMs; returns UpgradeOutcome.
  | { op: "idb-upgrade"; db: string; version: number; waitMs: number }
  // Holds a sync access handle on file until opfs-release.
  | { op: "opfs-hold"; file: string }
  | { op: "opfs-release" }
  // Times reads of size bytes at random among count chunks (keys, or
  // size-aligned offsets into file); returns each one's milliseconds.
  | {
      op: "latency";
      source: LatencySource;
      db: string;
      store: string;
      file: string;
      count: number;
      size: number;
      reads: number;
    };

// When each step of a timed command ended, in ms after its epoch, in order.
export type Timing = { marks: [string, number][]; bytes: number };

export type UpgradeOutcome = { blocked: boolean; opened: boolean; ms: number };

export const chunkUrl = (cache: string, i: number): string => `/storage-experiment/${cache}/${i}`;
