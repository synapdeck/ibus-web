// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Difference, TranscriptRecord } from "./types.ts";

function firstField(native: unknown, wasm: unknown, path: string): string | undefined {
  if (Object.is(native, wasm)) return undefined;
  if (
    native === null ||
    wasm === null ||
    typeof native !== "object" ||
    typeof wasm !== "object" ||
    Array.isArray(native) ||
    Array.isArray(wasm)
  )
    return path;
  const a = native as Record<string, unknown>;
  const b = wasm as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const differing = firstField(a[key], b[key], path ? `${path}.${key}` : key);
    if (differing !== undefined) return differing;
  }
  return undefined;
}

function at(record: unknown, field: string): unknown {
  return field
    .split(".")
    .reduce<unknown>(
      (value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined),
      record,
    );
}

export function compareTranscripts(
  native: readonly TranscriptRecord[],
  wasm: readonly TranscriptRecord[],
): Difference[] {
  const differences: Difference[] = [];
  for (let i = 0; i < Math.max(native.length, wasm.length); i++) {
    const a = native[i];
    const b = wasm[i];
    const step = a?.step ?? b?.step ?? -1;
    if (!a || !b) {
      differences.push({ step, field: "record", native: a, wasm: b });
      continue;
    }
    const field = firstField(a, b, "");
    if (field !== undefined) differences.push({ step, field, native: at(a, field), wasm: at(b, field) });
  }
  return differences;
}
