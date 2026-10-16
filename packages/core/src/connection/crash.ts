// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { CrashReason, type Crashed } from "@ibus-web/protocol";
export interface CrashInfo {
  reason: "trap" | "fault" | "relay" | "load" | "host" | "hang" | "worker";
  message: string;
  storage?: "read-only" | "ephemeral" | "closed";
  /** The host refused the module before starting it, as it would again: a mismatch, or a manifest it can't take. */
  refused?: "RuntimeAbiMismatch" | "ProtocolMismatch" | "manifest";
}
/** The connection's start failed, as `crash` says. */
export class ConnectionFailed extends Error {
  readonly crash: CrashInfo;

  constructor(crash: CrashInfo) {
    super(crash.message);
    this.crash = crash;
  }
}
export const crashFromRecord = (record: Crashed): CrashInfo => ({
  reason: (Object.keys(CrashReason) as (keyof typeof CrashReason)[]).find((key) => CrashReason[key] === record.reason)!,
  message: record.message,
});
