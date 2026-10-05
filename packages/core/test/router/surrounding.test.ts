// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, it } from "vitest";
import { run, select, key, record, text } from "./dom-support.ts";
afterEach(() => document.body.replaceChildren());
it("clips ±1000 code points and converts astral cursor and backward anchor offsets", () =>
  run(async ({ router, connections, field }) => {
    const f = field("x".repeat(1100) + "😀A😀" + "y".repeat(1100));
    f.element.setSelectionRange(1102, 1103, "backward");
    f.element.focus();
    await select(router);
    const request = connections.a[0]!.sent.find((x) => x.request._tag === "SetSurroundingText")!.request;
    expect(request).toMatchObject({
      text: { text: "x".repeat(999) + "😀A😀" + "y".repeat(998) },
      cursor: 1000,
      anchor: 1001,
    });
  }));
it("deletes astral code points before a commit, forwards keys in record order, and refreshes after a consumed key", () =>
  run(async ({ router, connections, field }) => {
    const f = field("a😀😀b");
    f.element.setSelectionRange(3, 3);
    f.element.focus();
    await select(router);
    const c = connections.a[0]!;
    const sentBefore = c.sent.length;
    c.outcome = {
      _tag: "reply",
      ret: 1,
      records: [
        record({ _tag: "DeleteSurroundingText", offset: -1, count: 1 }),
        record({ _tag: "CommitText", text: text("X") }),
        record({ _tag: "ForwardKeyEvent", keyval: 0x59, keycode: 0, state: 0 }),
      ],
    };
    key(f.element);
    expect(f.element.value).toBe("aXY😀b");
    expect(c.sent.slice(sentBefore).map((x) => x.request._tag)).toEqual(["ProcessKeyEvent"]);
    await select(router);
    expect(c.sent.filter((x) => x.request._tag === "SetSurroundingText").at(-1)!.request).toMatchObject({
      text: { text: "aXY😀b" },
      cursor: 3,
    });
    const count = c.sent.filter((x) => x.request._tag === "SetSurroundingText").length;
    c.outcome = { _tag: "reply", ret: 1, records: [record({ _tag: "RequireSurroundingText" })] };
    key(f.element);
    await select(router);
    expect(c.sent.filter((x) => x.request._tag === "SetSurroundingText")).toHaveLength(count);
    f.element.value = "new😀";
    f.element.setSelectionRange(5, 5);
    key(f.element);
    await select(router);
    expect(c.sent.filter((x) => x.request._tag === "SetSurroundingText").at(-1)!.request).toMatchObject({
      text: { text: "new😀" },
      cursor: 4,
    });
  }));
it("removes unsupported capabilities and sends changed caret rectangles after a batch", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.detach();
    let rect = new DOMRect(1, 2, 3, 4);
    f.adapter.capabilities = () => ({ preedit: true, auxText: false, lookupTable: false, surroundingText: false });
    f.adapter.caretRect = () => rect;
    router.attach(f.adapter);
    f.element.focus();
    await select(router);
    const c = connections.a[0]!;
    expect(c.sent.find((x) => x.request._tag === "SetCapabilities")!.request).toMatchObject({ capabilities: 25 });
    expect(c.sent.some((x) => x.request._tag === "SetSurroundingText")).toBe(false);
    rect = new DOMRect(10, 20, 1, 16);
    key(f.element);
    await select(router);
    expect(c.sent.filter((x) => x.request._tag === "SetCursorLocation").at(-1)!.request).toMatchObject({
      x: 10,
      y: 20,
      width: 1,
      height: 16,
    });
  }));
