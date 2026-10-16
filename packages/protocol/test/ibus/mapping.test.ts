// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "@effect/vitest";
import { Schema } from "effect";
import { CodecError } from "../../src/index.ts";
import { fromTree, toTree } from "../../src/ibus/walk.ts";
import { IBusText } from "../../src/ibus/types.ts";

test("maps text to the IBus serializable tuple", () => {
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
test("rejects a different serializable name", () => {
  const tree = {
    _tag: "()",
    items: [
      { _tag: "s", value: "Wrong" },
      { _tag: "a", items: [] },
      { _tag: "s", value: "" },
      { _tag: "v", type: "(sa{sv}av)", value: { _tag: "()", items: [] } },
    ],
  } as const;
  expect(() => fromTree(IBusText)(tree)).toThrow(CodecError);
});
test("omits the message tag from the wire and restores it", () => {
  class Message extends Schema.TaggedClass<Message>()("Message", { text: IBusText }) {}
  const encoded = {
    _tag: "Message",
    text: { attachments: {}, text: "", attrs: { attachments: {}, attributes: [] } },
  } as const;
  const tree = toTree(Message)(encoded);
  expect(tree._tag).toBe("()");
  expect(fromTree(Message)(tree)).toEqual(encoded);
});

test("wraps IBus attachments in an additional variant and unwraps them on decode", () => {
  const encoded = {
    attachments: { source: { _tag: "v", type: "s", value: { _tag: "s", value: "fixture" } } },
    text: "hello",
    attrs: { attachments: {}, attributes: [] },
  } as const;
  const tree = toTree(IBusText)(encoded);
  if (tree._tag !== "()") throw new Error("Expected a serializable tuple");
  expect(tree.items[1]).toEqual({
    _tag: "a",
    items: [
      {
        _tag: "{}",
        key: { _tag: "s", value: "source" },
        value: { _tag: "v", type: "v", value: encoded.attachments.source },
      },
    ],
  });
  expect(fromTree(IBusText)(tree)).toEqual(encoded);
  const missingWrapper = {
    ...tree,
    items: tree.items.map((item, index) =>
      index === 1
        ? {
            _tag: "a" as const,
            items: [
              { _tag: "{}" as const, key: { _tag: "s" as const, value: "source" }, value: encoded.attachments.source },
            ],
          }
        : item,
    ),
  };
  expect(() => fromTree(IBusText)(missingWrapper)).toThrow(CodecError);
});
