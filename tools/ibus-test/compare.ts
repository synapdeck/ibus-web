// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Difference, TranscriptRecord } from "./types.ts";
import { validateRecord } from "./trace.ts";

export type ExpectedDifference = {
  scenario: string;
  triggerStep: number;
  reason: string;
  nativeExtraRecords: TranscriptRecord[];
  nativeEngineStderrPattern: string;
};

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
    const event = a?.kind === "event" ? a : b?.kind === "event" ? b : undefined;
    const location = event ? { step, context: event.context } : { step };
    if (!a || !b) {
      differences.push({ ...location, field: "record", native: a, wasm: b });
      continue;
    }
    const field = firstField(a, b, "");
    if (field !== undefined) differences.push({ ...location, field, native: at(a, field), wasm: at(b, field) });
  }
  return differences;
}

export function validateExpectedDifferences(
  input: unknown,
  scenarios: readonly string[],
): Map<string, ExpectedDifference> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("expected differences must be an object");
  const document = input as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.differences))
    throw new TypeError("expected differences require version 1 and a differences array");
  const knownScenarios = new Set(scenarios);
  if (knownScenarios.size !== scenarios.length) throw new TypeError("duplicate scenario trace");
  const declarations = new Map<string, ExpectedDifference>();

  for (const item of document.differences) {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new TypeError("expected difference must be an object");
    const declaration = item as Record<string, unknown>;
    if (
      Object.keys(declaration).length !== 5 ||
      !["scenario", "triggerStep", "reason", "nativeExtraRecords", "nativeEngineStderrPattern"].every((key) =>
        Object.hasOwn(declaration, key),
      )
    )
      throw new TypeError("expected difference has unexpected fields");
    if (typeof declaration.scenario !== "string" || !knownScenarios.has(declaration.scenario))
      throw new TypeError(`unknown expected-difference scenario: ${String(declaration.scenario)}`);
    if (declarations.has(declaration.scenario))
      throw new TypeError(`duplicate expected-difference scenario: ${declaration.scenario}`);
    if (!Number.isSafeInteger(declaration.triggerStep) || (declaration.triggerStep as number) < 0)
      throw new TypeError("expected difference requires a nonnegative trigger step");
    if (typeof declaration.reason !== "string" || !declaration.reason.trim())
      throw new TypeError("expected difference requires a reason");
    if (!Array.isArray(declaration.nativeExtraRecords) || declaration.nativeExtraRecords.length === 0)
      throw new TypeError("expected difference requires nonempty nativeExtraRecords");
    const triggerStep = declaration.triggerStep as number;
    const nativeExtraRecords = declaration.nativeExtraRecords.map((record) => validateRecord(record, triggerStep + 1));
    if (nativeExtraRecords.some((record) => record.kind !== "event" || record.step !== triggerStep))
      throw new TypeError("expected extra records must be events at the trigger step");
    const pattern = declaration.nativeEngineStderrPattern;
    if (typeof pattern !== "string" || !pattern.startsWith("^") || !pattern.endsWith("$"))
      throw new TypeError("expected engine stderr pattern must be anchored");
    new RegExp(pattern, "u");
    declarations.set(declaration.scenario, {
      scenario: declaration.scenario,
      triggerStep,
      reason: declaration.reason,
      nativeExtraRecords,
      nativeEngineStderrPattern: pattern,
    });
  }
  return declarations;
}

/** Permit only the declared native events at the trigger boundary. */
export function checkExpectedDifference(
  native: readonly TranscriptRecord[],
  wasm: readonly TranscriptRecord[],
  expected: ExpectedDifference,
  nativeEngineStderr: string,
): void {
  if (!new RegExp(expected.nativeEngineStderrPattern, "u").test(nativeEngineStderr))
    throw new Error(`native engine stderr did not match the exact expected outcome for ${expected.scenario}`);

  const nativeBoundary = native.findIndex((record) => record.step >= expected.triggerStep);
  const wasmBoundary = wasm.findIndex((record) => record.step >= expected.triggerStep);
  if (nativeBoundary < 0 || wasmBoundary < 0)
    throw new Error(`missing trigger step ${expected.triggerStep} for ${expected.scenario}`);

  const preceding = compareTranscripts(native.slice(0, nativeBoundary), wasm.slice(0, wasmBoundary));
  if (preceding.length > 0)
    throw new Error(`behavior diverged before ${expected.scenario}: ${JSON.stringify(preceding[0])}`);

  const inserted = native.slice(nativeBoundary, nativeBoundary + expected.nativeExtraRecords.length);
  const insertionDifference = compareTranscripts(inserted, expected.nativeExtraRecords);
  if (insertionDifference.length > 0)
    throw new Error(
      `expected native insertion is missing or changed for ${expected.scenario}: ${JSON.stringify(insertionDifference[0])}`,
    );

  const following = compareTranscripts(native.slice(nativeBoundary + inserted.length), wasm.slice(wasmBoundary));
  if (following.length > 0)
    throw new Error(`behavior diverged after ${expected.scenario}: ${JSON.stringify(following[0])}`);
}
