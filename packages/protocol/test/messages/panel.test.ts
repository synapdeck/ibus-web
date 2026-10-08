// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { expect, test } from "vitest";
import { PanelAction } from "../../src/messages/panel.ts";

const decode = Schema.decodeUnknownSync(PanelAction);

test("PanelAction accepts each request a panel sends", () => {
  for (const tag of ["PageUp", "PageDown", "CursorUp", "CursorDown"] as const)
    expect(decode({ _tag: tag })._tag).toBe(tag);

  expect(decode({ _tag: "CandidateClicked", index: 2, button: 1, state: 0 })).toMatchObject({
    _tag: "CandidateClicked",
    index: 2,
  });
  expect(decode({ _tag: "PropertyActivate", name: "B", state: 1 })).toMatchObject({
    _tag: "PropertyActivate",
    name: "B",
  });
});

test("PanelAction rejects requests a panel doesn't send, and malformed ones", () => {
  expect(() => decode({ _tag: "ProcessKeyEvent", keyval: 97, keycode: 30, state: 0 })).toThrow();
  expect(() => decode({ _tag: "CandidateClicked", index: -1, button: 1, state: 0 })).toThrow();
});
