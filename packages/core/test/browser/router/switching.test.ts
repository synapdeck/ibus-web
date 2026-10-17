// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, test } from "vitest";
import { Effect, Fiber, Logger as EffectLogger, Stream } from "effect";
import type { CreateEngine } from "@ibus-web/protocol";
import { PrepareFailed } from "../../../src/connection/connection.ts";
import { run, select, key, preedit, record } from "../support/dom.ts";
afterEach(() => document.body.replaceChildren());
test("switches in Disable/FocusOut then Enable/FocusIn order and resolves preedit", () =>
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
test("preserves per-surface overrides across global switch and restart, reusing the Worker", () =>
  run(async ({ router, registry, connections, field }) => {
    const f = field();
    await Effect.runPromise(router.override(f.adapter, { module: "a" }));
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
test("reload gives an override naming the module back once the module is down and its body has run", () =>
  run(async ({ router, registry, connections, field }) => {
    const f = field();
    await Effect.runPromise(router.override(f.adapter, { module: "a" }));
    f.element.focus();
    await select(router, "b");
    expect(key(f.element).defaultPrevented).toBe(true);

    let startedDuring: boolean | undefined;
    await Effect.runPromise(
      router.reload(
        "a",
        Effect.sync(() => (startedDuring = registry.started("a"))),
      ),
    );
    expect(startedDuring).toBe(false);
    expect(connections.a).toHaveLength(2);
    expect(registry.snapshot("a")!.enabled).toBe(true);
    expect(router.selection).toEqual({ module: "b", engine: "factory" });
    expect(key(f.element).defaultPrevented).toBe(true);
    expect(connections.a[1]!.sent.map(({ request }) => request._tag)).toContain("ProcessKeyEvent");
  }));
test("reload gives the page's selection back even when its body fails", () =>
  run(async ({ router, connections }) => {
    await Effect.runPromise(router.select("a", "other"));
    const failed = await Effect.runPromise(Effect.flip(router.reload("a", Effect.fail(new Error("cleared nothing")))));
    expect(failed.message).toBe("cleared nothing");
    expect(router.selection).toEqual({ module: "a", engine: "other" });
    expect(connections.a).toHaveLength(2);
  }));
test("switching engine within a module reuses its Worker and destroys the old engine first", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    a.outcome = { _tag: "reply", ret: 1, records: [preedit()] };
    key(f.element);
    await Effect.runPromise(router.select("a", "other"));
    expect(f.element.value).toBe("한");
    expect(connections.a).toHaveLength(1);
    expect(
      a.sent
        .map((x) => x.request._tag)
        .filter((tag) => ["CreateEngine", "DestroyEngine", "Enable", "Disable", "FocusIn", "FocusOut"].includes(tag)),
    ).toEqual([
      "CreateEngine",
      "Enable",
      "FocusIn",
      "Disable",
      "FocusOut",
      "DestroyEngine",
      "CreateEngine",
      "Enable",
      "FocusIn",
    ]);
    expect(a.sent.flatMap(({ request }) => (request._tag === "CreateEngine" ? [request.name] : []))).toEqual([
      "factory",
      "other",
    ]);
    expect(router.selection).toEqual({ module: "a", engine: "other" });
    expect(router.activeContext()).toMatchObject({ module: "a", engine: "other", adapter: f.adapter });
  }));
test("the keyboard policy follows the selected engine", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    connections.a[0]!.outcome = { _tag: "reply", ret: 1, records: [] };
    expect(key(f.element).defaultPrevented).toBe(true);
    await Effect.runPromise(router.select("a", "other"));
    expect(key(f.element).defaultPrevented).toBe(false);
    expect(key(f.element, "b").defaultPrevented).toBe(true);
  }));
test("an unknown module or engine fails without changing the selection or starting a Worker", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    await expect(Effect.runPromise(router.select("a", "missing"))).rejects.toThrow(/Unknown engine/);
    await expect(Effect.runPromise(router.select("b", "missing"))).rejects.toThrow(/Unknown engine/);
    await expect(Effect.runPromise(router.select("c"))).rejects.toThrow(/Unknown module/);
    expect(router.selection).toEqual({ module: "a", engine: "factory" });
    expect(connections.b).toHaveLength(0);
    connections.a[0]!.outcome = { _tag: "reply", ret: 1, records: [] };
    expect(key(f.element).defaultPrevented).toBe(true);
  }));
test("deselect finishes the composition and returns surfaces to native input without unloading", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    a.outcome = { _tag: "reply", ret: 1, records: [preedit()] };
    key(f.element);
    await Effect.runPromise(router.deselect());
    expect(f.element.value).toBe("한");
    expect(router.selection).toBeUndefined();
    expect(a.sent.slice(-2).map((x) => x.request._tag)).toEqual(["Disable", "FocusOut"]);
    expect(key(f.element).defaultPrevented).toBe(false);
    expect(a.terminated).toBe(false);
    await select(router);
    expect(key(f.element).defaultPrevented).toBe(true);
    expect(a.sent.filter((x) => x.request._tag === "CreateEngine")).toHaveLength(1);
  }));
test("an override can name another engine of the module, in its own context on the same Worker", () =>
  run(async ({ router, connections, field }) => {
    const first = field(),
      second = field();
    await Effect.runPromise(router.override(second.adapter, { module: "a", engine: "other" }));
    first.element.focus();
    await select(router);
    second.element.focus();
    await select(router);
    expect(connections.a).toHaveLength(1);
    expect(
      connections.a[0]!.sent.flatMap(({ request, ic }) =>
        request._tag === "CreateEngine" ? [[ic, request.name]] : [],
      ),
    ).toEqual([
      [1, "factory"],
      [2, "other"],
    ]);
    expect(router.activeContext()).toMatchObject({ module: "a", engine: "other", adapter: second.adapter });
    connections.a[0]!.outcome = { _tag: "reply", ret: 1, records: [] };
    expect(key(second.element).defaultPrevented).toBe(false);
    expect(key(second.element, "b").defaultPrevented).toBe(true);
  }));
test("selection changes are published in order", () =>
  run(async ({ router }) => {
    const seen: unknown[] = [];
    const listening = Effect.runFork(
      router.selectionChanges.pipe(Stream.runForEach((selection) => Effect.sync(() => seen.push(selection)))),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Effect.runPromise(router.select("a", "other"));
    await Effect.runPromise(router.select("a", "other"));
    await Effect.runPromise(router.deselect());
    await select(router, "b");
    await expect.poll(() => seen).toHaveLength(3);
    expect(seen).toEqual([{ module: "a", engine: "other" }, undefined, { module: "b", engine: "factory" }]);
    await Effect.runPromise(Fiber.interrupt(listening));
  }));
test("a selection waiting for its module's manifest yields to a later one and never starts its Worker", () =>
  run(async ({ router, connections }) => {
    const seen: unknown[] = [];
    const listening = Effect.runFork(
      router.selectionChanges.pipe(Stream.runForEach((selection) => Effect.sync(() => seen.push(selection)))),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // `a`'s manifest is loaded, so its selection applies at once while `b`'s waits for the read.
    await Promise.all([select(router, "b"), Effect.runPromise(router.select("a", "other"))]);
    expect(router.selection).toEqual({ module: "a", engine: "other" });
    expect(connections.b).toHaveLength(0);

    await Effect.runPromise(router.deselect());
    await expect.poll(() => seen).toHaveLength(2);
    expect(seen).toEqual([{ module: "a", engine: "other" }, undefined]);
    await Effect.runPromise(Fiber.interrupt(listening));
  }));
test("deselect clears surface overrides", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    await Effect.runPromise(router.override(f.adapter, { module: "a", engine: "other" }));
    f.element.focus();
    await select(router);
    connections.a[0]!.outcome = { _tag: "reply", ret: 1, records: [] };
    expect(key(f.element, "b").defaultPrevented).toBe(true);

    await Effect.runPromise(router.deselect());
    expect(key(f.element, "b").defaultPrevented).toBe(false);

    // Following the page again, the surface takes `factory`'s policy, which doesn't pass `a` through.
    await select(router);
    expect(key(f.element).defaultPrevented).toBe(true);
  }));
test.each([
  {
    records: [record({ _tag: "CreateEngineFailed", message: "other.table:9: line 9 has no tab" })],
    reason: "other.table:9: line 9 has no tab",
  },
  { records: [], reason: "CreateEngine returned -29" },
])("a failed CreateEngine rejects select with its reason: $reason", ({ records, reason }) =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    // Deselecting after the focus lets its reconcile run first, so the selection sends the only CreateEngine.
    await Effect.runPromise(router.deselect());
    const a = connections.a[0]!;
    a.hold = "CreateEngine";

    const selecting = Effect.runPromise(router.select("a", "other"));
    await a.untilSent("CreateEngine");
    a.completeAsync(-29, records);

    await expect(selecting).rejects.toThrow(`Engine other of module a could not be created: ${reason}`);
    expect(key(f.element).defaultPrevented).toBe(false);
  }),
);
test("a focus reconcile and a same-tick select each send CreateEngine; the select rejects and the focus failure is logged", async () => {
  const logs: EffectLogger.Options<unknown>[] = [];
  const logger = EffectLogger.make((options) => {
    logs.push(options);
  });
  const focusReason = "focus.table:1: refused on focus";
  const selectReason = "other.table:9: line 9 has no tab";
  await run(async ({ router, connections, field }) => {
    const f = field();
    const a = connections.a[0]!;
    a.hold = "CreateEngine";
    const createEngines = () => a.sent.filter((x) => x.request._tag === "CreateEngine");
    const refusal = (message: string) => [record({ _tag: "CreateEngineFailed", message })];

    // The focus queues a reconcile; the select lands behind it in the same tick and queues its own.
    f.element.focus();
    const rejected = expect(Effect.runPromise(router.select("a", "other"))).rejects.toMatchObject({
      _tag: "CreateEngineError",
      module: "a",
      engine: "other",
      diagnostic: selectReason,
    });

    await expect.poll(createEngines).toHaveLength(1);
    a.completeAsync(-29, refusal(focusReason));
    await expect.poll(createEngines).toHaveLength(2);
    a.completeAsync(-29, refusal(selectReason));
    await rejected;

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createEngines()).toHaveLength(2);
  }, logger);

  const warnings = logs.filter((entry) => entry.logLevel === "Warn");
  expect(warnings).toHaveLength(1);
  expect(String(warnings[0]!.message)).toContain(focusReason);
  expect(String(warnings[0]!.message)).not.toContain(selectReason);
});
test("hotkeys start empty, can consume a custom binding, and unregister", () =>
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
test("hotkeys leave composing, Dead and password events untouched", () =>
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
test("selecting an engine with data of its own prepares it before creating it, once per Worker", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    let installed!: () => void;
    a.prepareWith = () =>
      new Promise((resolve) => {
        installed = resolve;
      });
    const selected = Effect.runPromise(router.select("a", "lazy"));
    await expect.poll(() => a.prepared).toEqual(["lazy"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      a.sent.filter((x) => x.request._tag === "CreateEngine").map((x) => (x.request as CreateEngine).name),
    ).toEqual(["factory"]);
    installed();
    await selected;
    expect(
      a.sent.filter((x) => x.request._tag === "CreateEngine").map((x) => (x.request as CreateEngine).name),
    ).toEqual(["factory", "lazy"]);
    await select(router, "a");
    await Effect.runPromise(router.select("a", "lazy"));
    expect(a.prepared).toEqual(["lazy"]);
  }));
test("a failed install fails the selection with the reason; the selection stands, and the next focus tries again", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    a.prepareWith = async () => {
      throw new PrepareFailed("fetch ./lazy.tar: 404");
    };
    await expect(Effect.runPromise(router.select("a", "lazy"))).rejects.toMatchObject({
      _tag: "PrepareEngineError",
      module: "a",
      engine: "lazy",
      diagnostic: "fetch ./lazy.tar: 404",
    });
    expect(router.selection).toEqual({ module: "a", engine: "lazy" });
    expect(key(f.element).defaultPrevented).toBe(false);
    a.prepareWith = async () => {};
    f.element.blur();
    f.element.focus();
    await expect.poll(() => a.sent.filter((x) => x.request._tag === "CreateEngine").length).toBe(2);
    expect(a.prepared).toEqual(["lazy", "lazy"]);
  }));
test("an engine's download holds up no other work: other selections and focus changes go on, and a superseded selection makes nothing", () =>
  run(async ({ router, registry, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    let installed!: () => void;
    a.prepareWith = () =>
      new Promise((resolve) => {
        installed = resolve;
      });
    const pending = Effect.runPromise(router.select("a", "lazy"));
    await expect.poll(() => a.prepared).toEqual(["lazy"]);
    expect(router.selection, "the selection, reported at once").toEqual({ module: "a", engine: "lazy" });
    expect(key(f.element).defaultPrevented, "native input while the engine downloads").toBe(false);

    await select(router, "b");
    const g = field();
    g.element.focus();
    const b = connections.b[0]!;
    await expect.poll(() => b.sent.filter((x) => x.request._tag === "CreateEngine").map((x) => x.ic)).toEqual([1, 2]);
    await pending;
    expect(registry.isPrepared("a", "lazy"), "the superseded selection, resolved before its install ends").toBe(false);

    installed();
    await expect.poll(() => registry.isPrepared("a", "lazy")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      a.sent.filter((x) => x.request._tag === "CreateEngine").map((x) => (x.request as CreateEngine).name),
      "engines made in module a",
    ).toEqual(["factory"]);
    expect(registry.isPrepared("a", "lazy"), "the data, installed all the same").toBe(true);
  }));
test("a deselect while an engine downloads goes on at once; selecting the engine again makes it without a second install", () =>
  run(async ({ router, registry, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    let installed!: () => void;
    a.prepareWith = () =>
      new Promise((resolve) => {
        installed = resolve;
      });
    const pending = Effect.runPromise(router.select("a", "lazy"));
    await expect.poll(() => a.prepared).toEqual(["lazy"]);
    await Effect.runPromise(router.deselect());
    expect(router.selection).toBeUndefined();
    await pending;
    expect(registry.isPrepared("a", "lazy"), "the undone selection, resolved before its install ends").toBe(false);

    installed();
    await expect.poll(() => registry.isPrepared("a", "lazy")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.sent.filter((x) => x.request._tag === "CreateEngine")).toHaveLength(1);
    await Effect.runPromise(router.select("a", "lazy"));
    expect(
      a.sent.filter((x) => x.request._tag === "CreateEngine").map((x) => (x.request as CreateEngine).name),
    ).toEqual(["factory", "lazy"]);
    expect(a.prepared).toEqual(["lazy"]);
  }));
