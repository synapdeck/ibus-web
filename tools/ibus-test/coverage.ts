// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { ReplyValue, TranscriptRecord } from "./types.ts";

type EventObservation = {
  kind: "event";
  step: number;
  name: string;
  signature?: string;
  payloadContains?: string;
};
type ReplyObservation = { kind: "reply"; step: number; value: ReplyValue };
export type Observation = EventObservation | ReplyObservation;
export type ScenarioCoverage = {
  scenario: string;
  required: Observation[];
  forbidden: Observation[];
};

function validateObservation(input: unknown): Observation {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("coverage observation must be an object");
  const observation = input as Record<string, unknown>;
  if (!Number.isSafeInteger(observation.step) || (observation.step as number) < 0)
    throw new TypeError("coverage observation requires a nonnegative step");
  if (observation.kind === "event") {
    if (typeof observation.name !== "string" || !observation.name)
      throw new TypeError("coverage event requires a name");
    if (observation.signature !== undefined && typeof observation.signature !== "string")
      throw new TypeError("coverage event signature must be a string");
    if (observation.payloadContains !== undefined && typeof observation.payloadContains !== "string")
      throw new TypeError("coverage event payloadContains must be a string");
    return input as EventObservation;
  }
  if (observation.kind === "reply" && Object.hasOwn(observation, "value")) return input as ReplyObservation;
  throw new TypeError("coverage observation must be an event or valued reply");
}

export function validateCoverage(input: unknown, scenarios: readonly string[]): Map<string, ScenarioCoverage> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("coverage must be an object");
  const document = input as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.scenarios))
    throw new TypeError("coverage requires version 1 and a scenarios array");
  const knownScenarios = new Set(scenarios);
  if (knownScenarios.size !== scenarios.length) throw new TypeError("duplicate trace scenario");
  const coverage = new Map<string, ScenarioCoverage>();
  for (const item of document.scenarios) {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new TypeError("scenario coverage must be an object");
    const scenario = item as Record<string, unknown>;
    if (typeof scenario.scenario !== "string" || !knownScenarios.has(scenario.scenario))
      throw new TypeError(`unknown coverage scenario: ${String(scenario.scenario)}`);
    if (coverage.has(scenario.scenario)) throw new TypeError(`duplicate coverage scenario: ${scenario.scenario}`);
    if (!Array.isArray(scenario.required) || scenario.required.length === 0)
      throw new TypeError(`scenario ${scenario.scenario} requires nonempty observations`);
    if (!Array.isArray(scenario.forbidden)) throw new TypeError("scenario forbidden observations must be an array");
    scenario.required.forEach(validateObservation);
    scenario.forbidden.forEach(validateObservation);
    coverage.set(scenario.scenario, item as ScenarioCoverage);
  }
  for (const scenario of scenarios) {
    if (!coverage.has(scenario)) throw new TypeError(`missing coverage scenario: ${scenario}`);
  }
  return coverage;
}

function matches(record: TranscriptRecord, observation: Observation): boolean {
  if (record.kind !== observation.kind || record.step !== observation.step) return false;
  if (record.kind === "reply" && observation.kind === "reply")
    return JSON.stringify(record.value) === JSON.stringify(observation.value);
  if (record.kind !== "event" || observation.kind !== "event" || record.name !== observation.name) return false;
  return (
    (observation.signature === undefined || record.payload.signature === observation.signature) &&
    (observation.payloadContains === undefined || record.payload.text.includes(observation.payloadContains))
  );
}

export function checkCoverage(records: readonly TranscriptRecord[], coverage: ScenarioCoverage): void {
  let cursor = 0;
  for (const observation of coverage.required) {
    const index = records.findIndex((record, index) => index >= cursor && matches(record, observation));
    if (index < 0) throw new Error(`missing ordered ${coverage.scenario} observation: ${JSON.stringify(observation)}`);
    cursor = index + 1;
  }
  for (const observation of coverage.forbidden) {
    if (records.some((record) => matches(record, observation)))
      throw new Error(`forbidden ${coverage.scenario} observation: ${JSON.stringify(observation)}`);
  }
}
