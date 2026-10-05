// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, it } from "vitest";
import { Effect } from "effect";
import type { RouterService } from "../../src/router/router.ts";
import type { AsyncKeyResult, SurfaceAdapter } from "../../src/router/replay.ts";
import { key, record, run, select, text } from "../router/dom-support.ts";
afterEach(() => document.body.replaceChildren());
function editor(router: RouterService, mode: "async" | "manual" = "async") {
  const element = document.createElement("div");
  element.tabIndex = 0;
  element.contentEditable = "true";
  document.body.append(element);
  const resets = new Set<() => void>();
  const adapter: SurfaceAdapter = {
    element,
    capabilities: () => ({ preedit: true, auxText: false, lookupTable: false, surroundingText: false }),
    contentType: () => ({ purpose: 0, hints: 0, disabled: false }),
    surrounding: () => undefined,
    caretRect: () => undefined,
    batch: (apply) => apply(),
    commit: (value) => {
      element.textContent += value;
    },
    deleteSurrounding: () => {},
    setPreedit: () => {},
    replayKey: (event) => {
      if (event.type === "keydown") element.textContent += event.key;
    },
    forwardKey: () => {},
    onReset: (listener) => {
      resets.add(listener);
      return () => {
        resets.delete(listener);
      };
    },
  };
  return {
    element,
    adapter,
    detach: router.attach(adapter, { keyMode: mode }),
    reset: () => {
      for (const listener of resets) listener();
    },
  };
}
it("native sync and automatic async surfaces share an engine with distinct contexts and isolated output", () =>
  run(async ({ router, connections, field }) => {
    const native = field(),
      edit = editor(router);
    native.element.focus();
    await select(router);
    const c = connections.a[0]!;
    c.outcome = { _tag: "reply", ret: 1, records: [record({ _tag: "CommitText", text: text("native") })] };
    expect(key(native.element).defaultPrevented).toBe(true);
    expect(native.element.value).toBe("native");
    edit.element.focus();
    await select(router);
    c.hold = "ProcessKeyEvent";
    expect(key(edit.element, "e").defaultPrevented).toBe(true);
    expect(edit.element.textContent).toBe("");
    const request = c.sent.at(-1)!;
    expect(request.mode).toBe("async");
    expect(request.ic).toBe(2);
    c.completeAsync(1, [record({ _tag: "CommitText", text: text("editor") }, 2)]);
    await select(router);
    expect(edit.element.textContent).toBe("editor");
    expect(native.element.value).toBe("native");
    native.element.focus();
    await select(router);
    key(native.element);
    expect(c.sent.filter((x) => x.request._tag === "ProcessKeyEvent").map((x) => x.mode)).toEqual([
      "sync",
      "async",
      "sync",
    ]);
  }));
it("manual attachment installs no key or hotkey capture; keyAsync owns immediate eligible interception", () =>
  run(async ({ router, connections }) => {
    const edit = editor(router, "manual");
    edit.element.focus();
    await select(router);
    let hotkeys = 0;
    router.hotkeys.add(
      () => true,
      () => {
        hotkeys++;
      },
    );
    expect(key(edit.element).defaultPrevented).toBe(false);
    expect(hotkeys).toBe(0);
    const c = connections.a[0]!;
    c.hold = "ProcessKeyEvent";
    let result: Promise<AsyncKeyResult> | undefined;
    edit.element.addEventListener("keydown", (event) => {
      result = router.keyAsync(edit.adapter, event);
    });
    const event = key(edit.element, "m");
    expect(event.defaultPrevented).toBe(true);
    expect(hotkeys).toBe(0);
    c.completeAsync(0);
    expect(await result).toBe("replayed");
    expect(edit.element.textContent).toBe("m");
  }));
it("manual exclusions and readiness preserve native handling without replay", () =>
  run(async ({ router, registry, connections }) => {
    const edit = editor(router, "manual");
    let result: Promise<AsyncKeyResult> | undefined;
    edit.element.addEventListener("keydown", (event) => {
      result = router.keyAsync(edit.adapter, event);
    });
    expect(key(edit.element).defaultPrevented).toBe(false);
    expect(await result).toBe("passthrough");
    edit.element.focus();
    await select(router);
    const c = connections.a[0]!,
      count = c.sent.length;
    for (const options of [{ key: "Dead" }, { key: "a", isComposing: true }]) {
      const e = new KeyboardEvent("keydown", { ...options, code: "KeyA", cancelable: true, bubbles: true });
      edit.element.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
      expect(await result).toBe("passthrough");
    }
    registry.snapshot("a")!.passThrough = new Set([97]);
    expect(key(edit.element).defaultPrevented).toBe(false);
    expect(await result).toBe("passthrough");
    registry.snapshot("a")!.passThrough = new Set();
    edit.adapter.contentType = () => ({ purpose: 8, hints: 0, disabled: true });
    expect(key(edit.element).defaultPrevented).toBe(false);
    expect(await result).toBe("passthrough");
    expect(c.sent).toHaveLength(count);
    expect(edit.element.textContent).toBe("");
  }));
for (const transition of ["focus", "switch"])
  it(`pending async output stays on its original adapter during ${transition}`, () =>
    run(async ({ router, connections, field }) => {
      const edit = editor(router, "manual"),
        native = field();
      edit.element.focus();
      await select(router);
      const c = connections.a[0]!;
      c.hold = "ProcessKeyEvent";
      const result = router.keyAsync(
        edit.adapter,
        new KeyboardEvent("keydown", { key: "a", code: "KeyA", cancelable: true }),
      );
      if (transition === "focus") native.element.focus();
      const finished = select(router, transition === "switch" ? "b" : "a");
      c.completeAsync(1, [record({ _tag: "CommitText", text: text("owned") })]);
      expect(await result).toBe("consumed");
      await finished;
      expect(edit.element.textContent).toBe("owned");
      expect(native.element.value).toBe("");
      expect(c.sent.findIndex((x) => x.request._tag === "FocusOut")).toBeGreaterThan(
        c.sent.findIndex((x) => x.request._tag === "ProcessKeyEvent"),
      );
    }));
it("detach cancels old awaiters and old disposer cannot remove reattached adapter or leak old output", () =>
  run(async ({ router, connections }) => {
    const edit = editor(router, "manual");
    edit.element.focus();
    await select(router);
    const c = connections.a[0]!;
    c.hold = "ProcessKeyEvent";
    const old = router.keyAsync(
      edit.adapter,
      new KeyboardEvent("keydown", { key: "a", code: "KeyA", cancelable: true }),
    );
    edit.detach();
    expect(await old).toBe("cancelled");
    router.attach(edit.adapter, { keyMode: "async" });
    edit.detach();
    c.completeAsync(1, [record({ _tag: "CommitText", text: text("late") })]);
    await select(router);
    expect(edit.element.textContent).toBe("");
    expect(key(edit.element, "b").defaultPrevented).toBe(true);
    c.completeAsync(0);
    await select(router);
    expect(edit.element.textContent).toBe("b");
  }));
it("reset retires async active and queued keys, then suppresses their late commit", () =>
  run(async ({ router, connections }) => {
    const edit = editor(router, "manual");
    edit.element.focus();
    await select(router);
    const c = connections.a[0]!;
    c.hold = "ProcessKeyEvent";
    const results = ["a", "b"].map((value) =>
      router.keyAsync(
        edit.adapter,
        new KeyboardEvent("keydown", { key: value, code: `Key${value.toUpperCase()}`, cancelable: true }),
      ),
    );
    edit.reset();
    expect(edit.element.textContent).toBe("ab");
    expect(await Promise.all(results)).toEqual(["replayed", "replayed"]);
    c.completeAsync(1, [record({ _tag: "CommitText", text: text("late") })]);
    await select(router);
    expect(edit.element.textContent).toBe("ab");
  }));
it("scope disposal cancels pending manual input without editing the disposed surface", async () => {
  let results: Promise<AsyncKeyResult>[] = [];
  let element: HTMLElement | undefined;
  await run(async ({ router, connections }) => {
    const edit = editor(router, "manual");
    element = edit.element;
    edit.element.focus();
    await select(router);
    connections.a[0]!.hold = "ProcessKeyEvent";
    results = ["a", "b"].map((value) =>
      router.keyAsync(edit.adapter, new KeyboardEvent("keydown", { key: value, code: "KeyA", cancelable: true })),
    );
  });
  expect(await Promise.all(results)).toEqual(["cancelled", "cancelled"]);
  expect(element!.textContent).toBe("");
});
it("changing one surface from async to manual leaves the native surface synchronous", () =>
  run(async ({ router, connections, field }) => {
    const native = field(),
      edit = editor(router);
    edit.element.focus();
    await select(router);
    edit.detach();
    router.attach(edit.adapter, { keyMode: "manual" });
    await select(router);
    expect(key(edit.element).defaultPrevented).toBe(false);
    native.element.focus();
    await Effect.runPromise(router.select("a"));
    expect(key(native.element).defaultPrevented).toBe(true);
    expect(connections.a[0]!.sent.filter((x) => x.request._tag === "ProcessKeyEvent").map((x) => x.mode)).toEqual([
      "sync",
    ]);
  }));
for (const password of ["type", "current-password", "new-password"])
  it(`automatic async mode excludes native ${password} controls before context creation`, () =>
    run(async ({ router, connections }) => {
      const { textareaAdapter } = await import("../../src/adapters/textarea.ts");
      const element = document.createElement("input");
      if (password === "type") element.type = "password";
      else element.setAttribute("autocomplete", password);
      document.body.append(element);
      const adapter = textareaAdapter(element);
      router.attach(adapter, { keyMode: "async" });
      element.focus();
      await select(router);
      expect(key(element).defaultPrevented).toBe(false);
      expect(
        connections.a[0]!.sent.some((x) => x.request._tag === "CreateEngine" || x.request._tag === "ProcessKeyEvent"),
      ).toBe(false);
    }));
