// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, test } from "vitest";
import { run, select, key, preedit, record, text } from "../support/dom.ts";
afterEach(() => document.body.replaceChildren());
for (const reason of ["blur", "reset", "detach"] as const)
  for (const mode of [0, 1])
    test(`${reason} resolves visible preedit mode ${mode} in one batch before lifecycle`, () =>
      run(async ({ router, connections, field }) => {
        const f = field();
        const c = connections.a[0]!;
        f.element.focus();
        await select(router);
        c.outcome = { _tag: "reply", ret: 1, records: [preedit("한", mode)] };
        key(f.element);
        const calls: string[] = [];
        const original = f.adapter.batch;
        f.adapter.batch = (fn) => {
          calls.push("begin");
          original(fn);
          calls.push("end");
        };
        f.element.addEventListener("input", () => calls.push("commit"));
        if (reason === "blur") f.element.blur();
        else if (reason === "detach") f.detach();
        else f.element.dispatchEvent(new Event("select"));
        if (reason === "reset") {
          f.element.setSelectionRange(0, 0);
          f.element.value = "x";
          f.element.dispatchEvent(new Event("input"));
        }
        await select(router);
        expect(f.element.value).toBe(reason === "reset" ? (mode === 1 ? "x한" : "x") : mode === 1 ? "한" : "");
        expect(f.seen.at(-1)).toBeUndefined();
        expect(calls.filter((x) => x === "commit")).toHaveLength((reason === "reset" ? 1 : 0) + (mode === 1 ? 1 : 0));
        expect(
          c.sent.some(
            (x) =>
              x.request._tag === (reason === "reset" ? "Reset" : reason === "detach" ? "DestroyEngine" : "FocusOut"),
          ),
        ).toBe(true);
      }));
test("converts preedit code-point cursor and attributes to UTF-16, including end sentinel", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    connections.a[0]!.outcome = {
      _tag: "reply",
      ret: 1,
      records: [
        record({
          _tag: "UpdatePreeditText",
          text: {
            ...text("a😀b"),
            attrs: {
              attachments: {},
              attributes: [{ attachments: {}, type: 1, value: 2, startIndex: 1, endIndex: 0xffffffff }],
            },
          },
          cursor: 2,
          visible: true,
          mode: 1,
        }),
      ],
    };
    key(f.element);
    expect(f.seen.at(-1)).toEqual({ text: "a😀b", cursor: 3, attributes: [{ type: 1, value: 2, start: 1, end: 4 }] });
  }));
test("hidden preedit clears without a commit", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    connections.a[0]!.outcome = { _tag: "reply", ret: 1, records: [preedit(), record({ _tag: "HidePreeditText" })] };
    key(f.element);
    f.element.blur();
    await select(router);
    expect(f.element.value).toBe("");
  }));
test("pointerdown resolves preedit before the browser moves the caret", () =>
  run(async ({ router, connections, field }) => {
    const f = field("ab");
    f.element.focus();
    await select(router);
    connections.a[0]!.outcome = { _tag: "reply", ret: 1, records: [preedit("X", 1)] };
    key(f.element);
    f.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(f.element.value).toBe("abX");
    f.element.setSelectionRange(0, 0);
    f.element.dispatchEvent(new Event("select"));
    await select(router);
    expect(f.element.value).toBe("abX");
  }));
