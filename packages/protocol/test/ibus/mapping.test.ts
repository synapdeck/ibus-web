// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { ProtocolError } from "../../src/index.ts";
import { fromTree, toTree } from "../../src/ibus/walk.ts";
import { IBusText } from "../../src/ibus/types.ts";

it("maps text to the IBus serializable tuple", () => {
  const encoded = { attachments: {}, text: "hello", attrs: { attachments: {}, attributes: [] } };
  const tree = toTree(IBusText)(encoded);
  expect(tree).toEqual({
    _tag: "()",
    items: [
      { _tag: "s", value: "IBusText" },
      { _tag: "a", items: [] },
      { _tag: "s", value: "hello" },
      {
        _tag: "v",
        type: "(sa{sv}av)",
        value: {
          _tag: "()",
          items: [
            { _tag: "s", value: "IBusAttrList" },
            { _tag: "a", items: [] },
            { _tag: "a", items: [] },
          ],
        },
      },
    ],
  });
  expect(fromTree(IBusText)(tree)).toEqual(encoded);
});
it("rejects a different serializable name", () => {
  const tree = {
    _tag: "()",
    items: [
      { _tag: "s", value: "Wrong" },
      { _tag: "a", items: [] },
      { _tag: "s", value: "" },
      { _tag: "v", type: "(sa{sv}av)", value: { _tag: "()", items: [] } },
    ],
  } as const;
  expect(() => fromTree(IBusText)(tree)).toThrow(ProtocolError);
});
it("omits the message tag from the wire and restores it", () => {
  class Message extends Schema.TaggedClass<Message>()("Message", { text: IBusText }) {}
  const encoded = {
    _tag: "Message",
    text: { attachments: {}, text: "", attrs: { attachments: {}, attributes: [] } },
  } as const;
  const tree = toTree(Message)(encoded);
  expect(tree._tag).toBe("()");
  expect(fromTree(Message)(tree)).toEqual(encoded);
});
