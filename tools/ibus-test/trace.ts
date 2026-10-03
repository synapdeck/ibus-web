// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Trace, Step, TranscriptRecord, TypedValue } from "./types.ts";

function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label}: expected object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
    throw new TypeError(`${label}: expected fields ${fields.join(", ")}`);
  }
  return record;
}

function string(value: unknown, label: string, nonempty = true): string {
  if (typeof value !== "string" || (nonempty && value.length === 0))
    throw new TypeError(`${label}: expected ${nonempty ? "nonempty " : ""}string`);
  return value;
}

function index(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label}: expected nonnegative integer`);
  return value;
}

export function validateTrace(input: unknown): Trace {
  const trace = object(input, ["version", "settings", "steps"], "trace");
  if (trace.version !== 1 || !Array.isArray(trace.settings) || !Array.isArray(trace.steps))
    throw new TypeError("trace: invalid version, settings or steps");
  const settings = trace.settings.map((input: unknown, i: number) => {
    const value = object(input, ["schema", "key", "value"], `settings[${i}]`);
    return {
      schema: string(value.schema, "schema"),
      key: string(value.key, "key"),
      value: string(value.value, "value", false),
    };
  });
  const live = new Set<string>();
  const steps: Step[] = trace.steps.map((input: unknown, i: number) => {
    const label = `steps[${i}]`;
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new TypeError(`${label}: expected object`);
    const op = (input as Record<string, unknown>).op;
    let step: Step;
    switch (op) {
      case "create": {
        const item = object(input, ["op", "context", "engine"], label);
        step = {
          op,
          context: string(item.context, `${label}.context`),
          engine: string(item.engine, `${label}.engine`),
        };
        if (live.has(step.context)) throw new TypeError(`${label}: duplicate context ${step.context}`);
        live.add(step.context);
        break;
      }
      case "destroy": {
        const item = object(input, ["op", "context"], label);
        step = { op, context: string(item.context, `${label}.context`) };
        if (!live.delete(step.context)) throw new TypeError(`${label}: unknown context ${step.context}`);
        break;
      }
      case "call": {
        const item = object(input, ["op", "context", "method", "args"], label);
        step = {
          op,
          context: string(item.context, `${label}.context`),
          method: string(item.method, `${label}.method`),
          args: string(item.args, `${label}.args`),
        };
        if (!live.has(step.context)) throw new TypeError(`${label}: unknown context ${step.context}`);
        break;
      }
      case "wait": {
        const item = object(input, ["op", "context", "event", "timeoutMs"], label);
        step = {
          op,
          context: string(item.context, `${label}.context`),
          event: string(item.event, `${label}.event`),
          timeoutMs: index(item.timeoutMs, `${label}.timeoutMs`),
        };
        if (step.timeoutMs === 0 || !live.has(step.context))
          throw new TypeError(`${label}: invalid timeout or unknown context ${step.context}`);
        break;
      }
      default:
        throw new TypeError(`${label}: unknown operation ${String(op)}`);
    }
    return step;
  });
  return { version: 1, settings, steps };
}

function typedValue(input: unknown, label: string): TypedValue {
  const value = object(input, ["signature", "text"], label);
  return {
    signature: string(value.signature, `${label}.signature`, false),
    text: string(value.text, `${label}.text`, false),
  };
}

export function validateRecord(input: unknown, stepCount: number): TranscriptRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("record: expected object");
  const kind = (input as Record<string, unknown>).kind;
  const fields =
    kind === "event"
      ? ["kind", "step", "context", "name", "payload"]
      : kind === "reply"
        ? ["kind", "step", "value"]
        : kind === "error"
          ? ["kind", "step", "message"]
          : null;
  if (!fields) throw new TypeError(`record: unknown kind ${String(kind)}`);
  const record = object(input, fields, "record");
  const step = index(record.step, "record.step");
  if (step >= stepCount) throw new TypeError(`record: step ${step} outside trace`);
  if (kind === "event")
    return {
      kind,
      step,
      context: string(record.context, "record.context"),
      name: string(record.name, "record.name"),
      payload: typedValue(record.payload, "record.payload"),
    };
  if (kind === "error") return { kind, step, message: string(record.message, "record.message", false) };
  const value = record.value;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return { kind: "reply", step, value };
  return { kind: "reply", step, value: typedValue(value, "record.value") };
}
