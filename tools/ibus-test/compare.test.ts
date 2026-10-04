// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { compareTranscripts } from "./compare.ts";

const unicode = {
  kind: "event" as const,
  step: 1,
  context: "한글",
  name: "UpdatePreeditText",
  payload: { signature: "(sa{sv})", text: "('한글', {'cursor': <uint32 2>})" },
};

test("preserves Unicode, type signatures, and nested GVariant text", () => {
  expect(compareTranscripts([unicode], [structuredClone(unicode)])).toEqual([]);
  expect(compareTranscripts([unicode], [{ ...unicode, payload: { ...unicode.payload, signature: "s" } }])).toEqual([
    { step: 1, context: "한글", field: "payload.signature", native: "(sa{sv})", wasm: "s" },
  ]);
});

test("reports the first differing reply value", () => {
  expect(
    compareTranscripts([{ kind: "reply", step: 2, value: true }], [{ kind: "reply", step: 2, value: false }]),
  ).toEqual([{ step: 2, field: "value", native: true, wasm: false }]);
});

test("reports event order without sorting", () => {
  const a = { ...unicode, name: "A" };
  const b = { ...unicode, name: "B" };
  expect(compareTranscripts([a, b], [b, a])[0]).toEqual({
    step: 1,
    context: "한글",
    field: "name",
    native: "A",
    wasm: "B",
  });
});

test("reports an extra empty update", () => {
  const empty = { ...unicode, payload: { signature: "s", text: "''" } };
  expect(compareTranscripts([empty], [])[0]).toEqual({
    step: 1,
    context: "한글",
    field: "record",
    native: empty,
    wasm: undefined,
  });
});

test("compares error records and typed reply values", () => {
  expect(
    compareTranscripts([{ kind: "error", step: 3, message: "bad" }], [{ kind: "error", step: 3, message: "worse" }])[0],
  ).toEqual({ step: 3, field: "message", native: "bad", wasm: "worse" });
  expect(
    compareTranscripts(
      [{ kind: "reply", step: 1, value: unicode.payload }],
      [{ kind: "reply", step: 1, value: { ...unicode.payload, text: "''" } }],
    )[0],
  ).toEqual({ step: 1, field: "value.text", native: unicode.payload.text, wasm: "''" });
});

test("identifies the first divergent context, step, and payload field", () => {
  const changed = structuredClone(unicode);
  changed.payload.text = "('perturbed', {})";
  expect(compareTranscripts([unicode], [changed])[0]).toEqual({
    context: "한글",
    step: 1,
    field: "payload.text",
    native: unicode.payload.text,
    wasm: changed.payload.text,
  });
});
