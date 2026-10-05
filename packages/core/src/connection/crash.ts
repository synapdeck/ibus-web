// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { CrashReason, type Crashed } from "@ibus-web/protocol";
export interface CrashInfo {
  reason: "trap" | "fault" | "relay" | "load" | "host" | "hang" | "worker";
  message: string;
  storage?: "read-only" | "ephemeral" | "closed";
}
export const crashFromRecord = (record: Crashed): CrashInfo => ({
  reason: (Object.keys(CrashReason) as (keyof typeof CrashReason)[]).find((key) => CrashReason[key] === record.reason)!,
  message: record.message,
});
