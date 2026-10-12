// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "@effect/vitest";
import { Request, OutputRecord, requestKinds, recordKinds, signatureOf } from "../../src/index.ts";

test("matches every request kind and payload signature in protocol version 1", () => {
  const actual = Request.members.map((message) => [message.name, requestKinds.get(message.name), signatureOf(message)]);
  expect(actual).toEqual([
    ["Init", 1, "(ua(ssa{sv}))"],
    ["CreateEngine", 2, "(s)"],
    ["DestroyEngine", 3, "()"],
    ["SettingChanged", 4, "(ssv)"],
    ["Persist", 5, "()"],
    ["ProcessKeyEvent", 16, "(uuu)"],
    ["FocusIn", 17, "()"],
    ["FocusOut", 18, "()"],
    ["Reset", 19, "()"],
    ["Enable", 20, "()"],
    ["Disable", 21, "()"],
    ["SetCursorLocation", 22, "(iiii)"],
    ["SetCapabilities", 23, "(u)"],
    ["PageUp", 24, "()"],
    ["PageDown", 25, "()"],
    ["CursorUp", 26, "()"],
    ["CursorDown", 27, "()"],
    ["CandidateClicked", 28, "(uuu)"],
    ["PropertyActivate", 29, "(su)"],
    ["SetSurroundingText", 30, "(vuu)"],
    ["SetContentType", 31, "(uu)"],
  ]);
  expect(requestKinds.size).toBe(21);
  expect(new Set(requestKinds.values()).size).toBe(requestKinds.size);
});

test("matches every record kind and includes the host crash payload", () => {
  const actual = OutputRecord.members.map((message) => [
    message.name,
    recordKinds.get(message.name),
    signatureOf(message),
  ]);
  expect(actual).toEqual([
    ["CommitText", 1, "(v)"],
    ["UpdatePreeditText", 2, "(vubu)"],
    ["UpdateAuxiliaryText", 3, "(vb)"],
    ["UpdateLookupTable", 4, "(vb)"],
    ["ShowPreeditText", 5, "()"],
    ["HidePreeditText", 6, "()"],
    ["ShowAuxiliaryText", 7, "()"],
    ["HideAuxiliaryText", 8, "()"],
    ["ShowLookupTable", 9, "()"],
    ["HideLookupTable", 10, "()"],
    ["RegisterProperties", 11, "(v)"],
    ["UpdateProperty", 12, "(v)"],
    ["ForwardKeyEvent", 13, "(uuu)"],
    ["DeleteSurroundingText", 14, "(iu)"],
    ["RequireSurroundingText", 15, "()"],
    ["SettingWritten", 32, "(ssv)"],
    ["Log", 33, "(uss)"],
    ["Crashed", 34, "(us)"],
    ["CreateEngineFailed", 35, "(s)"],
  ]);
  expect(recordKinds.get("Crashed")).toBe(34);
  expect(recordKinds.size).toBe(19);
  expect(new Set(recordKinds.values()).size).toBe(recordKinds.size);
});

test("reserves kind zero for ring padding", () => {
  expect([...requestKinds.values(), ...recordKinds.values()]).not.toContain(0);
});
