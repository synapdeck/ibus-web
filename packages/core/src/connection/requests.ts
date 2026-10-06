// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { DecodedLazyRecord } from "@ibus-web/protocol";
import type { CrashInfo } from "./crash.ts";
export interface Reply {
  ret: number;
  outSeq: number;
  /** Records owned by this reply, through outSeq; never also returned by records.take(). */
  records: DecodedLazyRecord[];
}
export interface QueuedRequest {
  bytes: Uint8Array;
  resolve: (reply: Reply) => void;
  reject: (crash: CrashInfo) => void;
}
export class ConnectionBusyError extends Error {
  readonly _tag = "ConnectionBusyError";
  constructor() {
    super("The connection already has an in-flight request");
  }
}
