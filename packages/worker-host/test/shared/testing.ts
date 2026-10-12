// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the host's test build adds: requests it answers itself, outside the
// runtime's opcode space, so tests can observe and steer it, and what
// HostInit.test tells it.

import type { HostConfigValues } from "../../src/shared/config.ts";
import type { HostMessage, Mount, SideModule } from "../../src/shared/messages.ts";
import type { Member } from "./tar.ts";

export const HostOp = {
  stop: 0xfff5,
  loadedModules: 0xfff6,
  // A UTF-8 JSON HostStats.
  stats: 0xfff1,
  // Returns the host to its event loop for the int32 payload's milliseconds
  // (10 if none), then replies 0.
  yield: 0xfff2,
  // Holds off topping the pool up while the int32 payload is 0, and allows
  // it again otherwise; replies 0.
  topUp: 0xfff3,
  // Adds the int32 payload's count of Workers to the pool, then replies 0
  // once they have all loaded the runtime, or -1.
  addWorkers: 0xfff4,
  // Extracts an archive with the installer, as a UTF-8 JSON InstallOpRequest,
  // and replies with a UTF-8 JSON InstallOpReply.
  install: 0xfff7,
  // Runs a UTF-8 JSON array of FsActions through WasmFS's FS, and replies
  // with a UTF-8 JSON array of their FsResults.
  fs: 0xfff8,
} as const;

// A piece of an archive the host builds: a member, zeros, or text.
export type ArchivePart = Member | { zeros: number } | { text: string };

export interface InstallOpRequest {
  // An existing directory, and the store path its entries must lie under.
  dir: string;
  storeName: string;
  // The most bytes of file data it may write; no limit if none.
  limit?: number;
  archive: { url: string } | { parts: ArchivePart[] };
  // Only the archive's first cut bytes.
  cut?: number;
  // The size of the pieces the archive arrives in; 64 KiB if none.
  piece?: number;
  // Takes the runtime's free memory, before installing, down to a file of
  // this size, in whole pages, and the headroom.
  squeeze?: { file: number; headroom: number };
}

export type InstallOpReply = { ok: true; files: number; bytes: number } | { ok: false; message: string };

export type FsAction =
  // Mounts a memory backend at path.
  | { op: "mount"; path: string }
  | { op: "mkdir"; path: string; mode?: number }
  // Writes the text, or size bytes of the archive's pattern.
  | { op: "write"; path: string; text?: string; size?: number; mode?: number }
  | { op: "symlink"; target: string; path: string }
  | { op: "unlink"; path: string }
  | { op: "chmod"; path: string; mode: number }
  | { op: "lstat"; path: string }
  | { op: "readlink"; path: string }
  | { op: "read"; path: string }
  | { op: "pattern"; path: string }
  // Makes every FS call the installer uses fail, in a fresh directory, and
  // gives each one's errno.
  | { op: "failures"; dir: string };

export interface FsResult {
  value?: unknown;
  errno?: number;
}

export interface HostStats {
  // Maximum live pthread Workers, including the initial pool.
  poolWorkersPeak: number;
  // Checked-out pthreads when instrumentation attaches, before runtime init,
  // storage mount, Init and engine module load, and their subsequent peak.
  activeThreadsAtRuntimeStart: number;
  activeThreadsPeak: number;
  // The program break's high-water mark, which the allocator never lowers:
  // an address, so it counts everything below the heap too, static data
  // included.
  breakPeak: number;
  // Workers Emscripten created after the runtime started, beyond its pool.
  workersCreated: number;
  // Workers in Emscripten's pool that host no thread and can take one.
  idleWorkers: number;
  // Pool top-ups finished, the Workers they added, and how long the last
  // took from its first new Worker to its last one loaded.
  topUps: number;
  topUpWorkers: number;
  lastTopUpMs: number | null;
  // Of that, how long the last top-up's new Worker() calls took.
  lastTopUpCreateMs: number | null;
  // Times the host has left its request loop for its event loop: a top-up
  // or a yield.
  eventLoopTurns: number;
  // Bytes malloc() has handed out and not had back.
  heapInUse: number;
  // The runtime's memory's size.
  memoryBytes: number;
  // What backs the engine's directory: "memory" is the in-memory mount of a
  // host without IndexedDB.
  mount: Mount;
  // Whether the IndexedDB backend's connection has closed under it.
  storageClosed: boolean;
  // Requests the host has served, this one included.
  requests: number;
  // Of those, the ones that arrived while the host slept: it found them
  // when its wait returned rather than before starting one.
  requestsWhileAsleep: number;
}

export const PumpControl = { run: 0, deferOnce: 1, holdUntilDispatch: 2, armHold: 3 } as const;

export const RuntimeCall = { pump: 0, dispatch: 1, wait: 2, consumed: 3 } as const;

export interface TestInit {
  // Observes the real channel in the test build only.
  traceInstallProgress?: boolean;
  // Models a holder whose event loop no longer announces liveness.
  silentInstallProgress?: boolean;
  // Holds the first piece until the page stores 1, without blocking timers.
  firstPieceGate?: SharedArrayBuffer;
  sides?: readonly SideModule[];
  runtimeCalls?: SharedArrayBuffer;
  // Entries into a runtime wait while output is blocked on ring space.
  ringWaitEntries?: SharedArrayBuffer;
  waitTrap?: SharedArrayBuffer;
  waitTrapOp?: number;
  // Once the page stores 1 here, the next wait the host starts while it
  // waits for ring space first runs waitAppendOp, as a call another thread
  // proxied to it would, with the int32 payload waitAppendBytes.
  waitAppend?: SharedArrayBuffer;
  waitAppendOp?: number;
  waitAppendBytes?: number;
  // Two int32s the host updates on each reply it publishes: the reqMode it
  // read for it, at 1, then the count of them, at 0, which it notifies.
  replies?: SharedArrayBuffer;
  deferPump?: SharedArrayBuffer;
  callsAfterFault?: SharedArrayBuffer;
  canceled?: number;
  // struct mallinfo's size, and the offset of uordblks (bytes in use), as
  // the WebAssembly target defines them.
  mallinfo: { bytes: number; inUseOffset: number };
  // Limits to shorten.
  config?: Partial<HostConfigValues>;
  // Starts the relay that fails once it has forwarded this many wakes.
  relayFailsAfter?: number;
  // indexedDB.open() throws in the host, as it does in an opaque origin.
  withoutIndexedDB?: boolean;
  // The install stops for good once it has fed the tar decoder at least this
  // many bytes, and the host posts "stalled".
  stallAt?: number;
  // The install waits this long before feeding each piece of an archive.
  pieceDelayMs?: number;
  // An install of a store path of an engine's own data stops for good once
  // the path's tree is in place, before its marker, and the host posts
  // "stalled-marking".
  stallBeforeMark?: boolean;
  // Sealing the engine's user data throws.
  sealThrows?: boolean;
  forceBrotliFallback?: boolean;
}

// What the test build posts beside the host's own messages.
export type TestMessage =
  | { type: "install-progress"; event: "heard" | "said" | "piece" | "waiting"; at: number; fed?: number }
  // A request for the lock wasn't granted at once, so the host waits.
  | { type: "waiting"; lock: string }
  // The install stopped where TestInit.stallAt said, after fed bytes.
  | { type: "stalled"; bytes: number }
  | { type: "brotli-decoder"; decoder: "native" | "fallback" }
  // An archive of the engine's data is about to be fetched.
  | { type: "fetching"; url: string }
  // The data backend's window opened or shut, at Date.now().
  | { type: "window"; open: boolean; at: number }
  // A staging tree an install cut short left at path was removed.
  | { type: "swept"; path: string }
  // The install stopped where TestInit.stallBeforeMark said.
  | { type: "stalled-marking"; storePath: string };

export type Message = HostMessage | TestMessage;

// Test requests use protocol framing, while the C test dispatcher retains its
// private uint32 opcode ABI behind the test-build hook.
export const encodeTestOp = (kind: number, payload: Uint8Array = new Uint8Array()): Uint8Array => {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint16(0, kind, true);
  bytes.set(payload, 8);
  return bytes;
};
