// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Every limit and interval the host keeps, in milliseconds.
export interface HostConfigValues {
  // How long a pool top-up may take, from its first new Worker to its last
  // loaded, before it is a host error: far longer than a top-up takes,
  // under 0.2 s, and than the page's spin, which holds back a Worker's
  // new Worker() in Firefox.
  readonly topUpLimitMs: number;
  // How long a host that stopped waits for why: the trapping thread's error,
  // which reaches it only through its event loop after Emscripten unwinds
  // it, or the relay's.
  readonly crashWaitMs: number;
  // A wait for a Web Lock is made of requests of this long, each made again
  // when the last times out: Node grants a request queued for a lock a
  // terminated worker_thread held only once another request for it arrives.
  readonly lockRoundMs: number;
  // How long a host waits for a lock without word from its holder before it
  // gives up rather than never start. Each word starts the wait over.
  readonly lockLimitMs: number;
  // How often, at most, a host installing data says it is still going.
  readonly progressIntervalMs: number;
  // An archive that sends nothing for this long fails its install.
  readonly archiveIdleMs: number;
  // How long the deletion of a database may stay blocked by a connection
  // that doesn't close when asked to.
  readonly deleteLimitMs: number;
}

// An archive reaches the tar decoder in pieces of at most this size, and each
// file's data is written in pieces of at most this size, which the runtime
// copies into its own memory one at a time.
export const INSTALL_PIECE = 65536;
