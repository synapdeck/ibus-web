// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
export interface SettingsBroadcast {
  readonly schemaPath: string;
  readonly key: string;
  readonly type: string;
  readonly bytes: ArrayBuffer | null;
}
export function settingsBroadcast(receive: (value: unknown) => void) {
  const channel = new BroadcastChannel("ibus-web:gsettings");
  channel.onmessage = (event: MessageEvent<unknown>) => receive(event.data);
  return { post: (value: SettingsBroadcast) => channel.postMessage(value), close: () => channel.close() };
}
export function decodeSettingsBroadcast(value: unknown): SettingsBroadcast {
  if (typeof value !== "object" || value === null) throw new Error("Invalid settings broadcast");
  const data = value as Record<string, unknown>;
  if (
    typeof data.schemaPath !== "string" ||
    typeof data.key !== "string" ||
    typeof data.type !== "string" ||
    (data.bytes !== null && !(data.bytes instanceof ArrayBuffer))
  )
    throw new Error("Invalid settings broadcast");
  return { schemaPath: data.schemaPath, key: data.key, type: data.type, bytes: data.bytes };
}
