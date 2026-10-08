// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, it } from "vitest";
import { Effect } from "effect";
import { run, select, key, preedit } from "../support/dom.ts";
afterEach(() => document.body.replaceChildren());
it("switches in Disable/FocusOut then Enable/FocusIn order and resolves preedit", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    a.outcome = { _tag: "reply", ret: 1, records: [preedit()] };
    key(f.element);
    await select(router, "b");
    expect(f.element.value).toBe("한");
    expect(a.sent.slice(-2).map((x) => x.request._tag)).toEqual(["Disable", "FocusOut"]);
    expect(
      connections.b[0]!.sent.filter((x) => ["Enable", "FocusIn"].includes(x.request._tag)).map((x) => x.request._tag),
    ).toEqual(["Enable", "FocusIn"]);
    await select(router, "a");
    expect(a.sent.filter((x) => x.request._tag === "CreateEngine")).toHaveLength(1);
  }));
it("preserves per-surface overrides across global switch and restart, reusing the Worker", () =>
  run(async ({ router, registry, connections, field }) => {
    const f = field();
    await Effect.runPromise(router.override(f.adapter, "a"));
    f.element.focus();
    await select(router);
    await select(router, "b");
    expect(registry.snapshot("a")!.enabled).toBe(true);
    expect(key(f.element).defaultPrevented).toBe(true);
    expect(connections.a).toHaveLength(1);
    connections.a[0]!.crash({ reason: "worker", message: "restart", storage: "read-only" });
    await Effect.runPromise(registry.whenReady("a"));
    expect(key(f.element).defaultPrevented).toBe(false);
    expect(connections.a[1]!.sent.some((x) => x.request._tag === "CreateEngine")).toBe(false);
    f.element.blur();
    f.element.focus();
    await select(router, "b");
    expect(key(f.element).defaultPrevented).toBe(true);
    expect(connections.a[1]!.sent.filter((x) => x.request._tag === "CreateEngine")).toHaveLength(1);
    await Effect.runPromise(router.override(f.adapter, undefined));
    expect(connections.b[0]!.sent.some((x) => x.request._tag === "FocusIn")).toBe(true);
  }));
it("hotkeys start empty, can consume a custom binding, and unregister", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const c = connections.a[0]!;
    c.outcome = { _tag: "reply", ret: 0, records: [] };
    expect(key(f.element).defaultPrevented).toBe(false);
    let called = 0;
    const remove = router.hotkeys.add(
      (e) => e.key === "x",
      () => called++,
    );
    const count = c.sent.length;
    expect(key(f.element, "x").defaultPrevented).toBe(true);
    expect(c.sent).toHaveLength(count);
    expect(called).toBe(1);
    remove();
    expect(key(f.element, "x").defaultPrevented).toBe(false);
  }));
it("hotkeys leave composing, Dead and password events untouched", () =>
  run(async ({ router, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    let matches = 0;
    router.hotkeys.add(
      () => {
        matches++;
        return true;
      },
      () => {},
    );
    for (const init of [{ key: "a", isComposing: true }, { key: "Dead" }]) {
      const event = new KeyboardEvent("keydown", { ...init, cancelable: true, bubbles: true });
      f.element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    f.element.setAttribute("autocomplete", "new-password");
    expect(key(f.element).defaultPrevented).toBe(false);
    expect(matches).toBe(0);
  }));
