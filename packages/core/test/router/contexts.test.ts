// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, it } from "vitest";
import { run, select, key, record, text, emptyReply } from "./dom-support.ts";
afterEach(() => document.body.replaceChildren());
it("creates distinct contexts on focus, with capabilities, content type and surrounding, before keys", () =>
  run(async ({ router, connections, field }) => {
    const a = field("😀a");
    const c = connections.a[0]!;
    a.element.focus();
    expect(key(a.element).defaultPrevented).toBe(false);
    await select(router);
    const sent = c.sent.filter((x) => x.ic === 1).map((x) => x.request);
    expect(sent.map((x) => x._tag)).toEqual([
      "CreateEngine",
      "SetCapabilities",
      "SetContentType",
      "Enable",
      "FocusIn",
      "SetSurroundingText",
      "SetCursorLocation",
    ]);
    expect(sent[0]).toMatchObject({ name: "factory" });
    expect(sent[1]).toMatchObject({ capabilities: 63 });
    expect(sent.find((request) => request._tag === "SetSurroundingText")).toMatchObject({
      text: { text: "😀a" },
      cursor: 2,
      anchor: 2,
    });
    expect(key(a.element).defaultPrevented).toBe(true);
    const b = field();
    b.element.focus();
    await select(router);
    expect(c.sent.some((x) => x.ic === 1 && x.request._tag === "FocusOut")).toBe(true);
    expect(c.sent.some((x) => x.ic === 2 && x.request._tag === "CreateEngine")).toBe(true);
  }));
it("password fields never create contexts and pass keys through", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.autocomplete = "current-password";
    f.element.focus();
    await select(router);
    expect(connections.a[0]!.sent.some((x) => x.request._tag === "CreateEngine")).toBe(false);
    expect(key(f.element).defaultPrevented).toBe(false);
  }));
it("drops a pending creation's records and stale FocusIn after blur or detach", () =>
  run(async ({ router, connections, field }) => {
    const c = connections.a[0]!;
    c.hold = "CreateEngine";
    const f = field();
    f.element.focus();
    await c.untilSent("CreateEngine");
    expect(c.pending).toHaveLength(1);
    f.element.blur();
    f.detach();
    c.completeAsync(0, [record({ _tag: "CommitText", text: text("late") })]);
    c.hold = undefined;
    await select(router);
    expect(f.element.value).toBe("");
    expect(c.sent.some((x) => x.request._tag === "FocusIn")).toBe(false);
    expect(c.sent.filter((x) => x.request._tag === "DestroyEngine")).toHaveLength(1);
  }));
it("a rejected CreateEngine never intercepts keys", () =>
  run(async ({ router, connections, field }) => {
    const c = connections.a[0]!;
    const original = c.requestAsync.bind(c);
    c.requestAsync = (r, ic) =>
      r._tag === "CreateEngine" ? Promise.resolve({ ...emptyReply, ret: -1 }) : original(r, ic);
    const f = field();
    f.element.focus();
    await select(router);
    expect(key(f.element).defaultPrevented).toBe(false);
  }));
it("queues keys behind lifecycle ownership and applies reply output once", () =>
  run(async ({ router, connections, field }) => {
    const c = connections.a[0]!;
    const f = field();
    f.element.focus();
    await select(router);
    c.hold = "Reset";
    f.element.value = "external";
    f.element.dispatchEvent(new Event("input"));
    await c.untilSent("Reset");
    expect(key(f.element).defaultPrevented).toBe(true);
    c.completeAsync(0, [record({ _tag: "CommitText", text: text("X") })]);
    c.hold = undefined;
    await select(router);
    expect(f.element.value).toBe("externalXa");
    expect(c.sent.some((x) => x.request._tag === "ProcessKeyEvent" && x.mode === "async")).toBe(true);
  }));
it("closing the router scope removes DOM listeners, cancels pending setup and settles queued selections", async () => {
  let captured:
    | { element: HTMLTextAreaElement; connection: import("./dom-support.ts").DomConnection; selecting: Promise<void> }
    | undefined;
  await run(async ({ router, connections, field }) => {
    const f = field();
    const c = connections.a[0]!;
    c.hold = "CreateEngine";
    f.element.focus();
    await c.untilSent("CreateEngine");
    const selecting = select(router, "b");
    selecting.catch(() => {});
    captured = { element: f.element, connection: c, selecting };
  });
  expect(captured!.connection.terminated).toBe(true);
  expect(key(captured!.element).defaultPrevented).toBe(false);
  await expect(captured!.selecting).rejects.toThrow("Router is closed");
});
it("switch during pending Create drops its output and never focuses the stale selection", () =>
  run(async ({ router, connections, field }) => {
    const c = connections.a[0]!;
    c.hold = "CreateEngine";
    const f = field();
    f.element.focus();
    await c.untilSent("CreateEngine");
    const switching = select(router, "b");
    c.completeAsync(0, [record({ _tag: "CommitText", text: text("late") })]);
    c.hold = undefined;
    await switching;
    expect(f.element.value).toBe("");
    expect(c.sent.some((x) => x.request._tag === "FocusIn")).toBe(false);
    expect(connections.b[0]!.sent.some((x) => x.request._tag === "FocusIn")).toBe(true);
  }));
it("an already focused attachment initializes, and consumed capture events stop bubbling", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.detach();
    f.element.focus();
    router.attach(f.adapter);
    await select(router);
    let bubble = 0;
    document.body.addEventListener("keydown", () => bubble++, { once: true });
    expect(key(f.element).defaultPrevented).toBe(true);
    expect(bubble).toBe(0);
    connections.a[0]!.outcome = { _tag: "reply", ret: 0, records: [] };
    expect(key(f.element).defaultPrevented).toBe(false);
    expect(bubble).toBe(1);
  }));
it("blur and refocus in one task still send FocusOut then FocusIn", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const c = connections.a[0]!;
    const start = c.sent.length;
    f.element.blur();
    f.element.focus();
    await select(router);
    expect(
      c.sent
        .slice(start)
        .filter((x) => x.request._tag === "FocusOut" || x.request._tag === "FocusIn")
        .map((x) => x.request._tag),
    ).toEqual(["FocusOut", "FocusIn"]);
  }));
it("creation output applies once while keys wait for success", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    const c = connections.a[0]!;
    c.hold = "CreateEngine";
    f.element.focus();
    await c.untilSent("CreateEngine");
    expect(key(f.element).defaultPrevented).toBe(false);
    c.completeAsync(0, [record({ _tag: "CommitText", text: text("created") })]);
    c.hold = undefined;
    await select(router);
    expect(f.element.value).toBe("created");
    expect(key(f.element).defaultPrevented).toBe(true);
  }));
it("supports adapter methods inherited from a prototype", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.detach();
    const adapter = Object.create(f.adapter) as typeof f.adapter;
    router.attach(adapter);
    f.element.focus();
    await select(router);
    const c = connections.a[0]!;
    c.outcome = { _tag: "reply", ret: 1, records: [record({ _tag: "CommitText", text: text("X") }, 2)] };
    expect(key(f.element).defaultPrevented).toBe(true);
    expect(f.element.value).toBe("X");
  }));
for (const transition of ["blur", "switch"] as const)
  it(`drains abandoned and queued keys before ${transition} finalizes composition`, () =>
    run(async ({ router, connections, field }) => {
      const f = field();
      f.element.focus();
      await select(router);
      const c = connections.a[0]!;
      c.outcome = { _tag: "pending" };
      expect(key(f.element, "a").defaultPrevented).toBe(true);
      expect(key(f.element, "b").defaultPrevented).toBe(true);
      if (transition === "blur") f.element.blur();
      const completion = select(router, transition === "switch" ? "b" : "a");
      expect(c.sent.some((x) => x.request._tag === "FocusOut")).toBe(false);
      c.completeAbandoned(1, [record({ _tag: "CommitText", text: text("A") })]);
      await completion;
      expect(f.element.value).toBe("Ab");
      const tags = c.sent.map((x) => x.request._tag);
      expect(tags.lastIndexOf("ProcessKeyEvent")).toBeLessThan(tags.indexOf("FocusOut"));
      if (transition === "switch") expect(connections.b[0]!.sent.some((x) => x.request._tag === "FocusIn")).toBe(true);
    }));
it("pointer reset retires accepted keys before caret movement and ignores their eventual reply", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const c = connections.a[0]!;
    c.outcome = { _tag: "pending" };
    key(f.element, "a");
    key(f.element, "b");
    f.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(f.element.value).toBe("ab");
    f.element.setSelectionRange(0, 0);
    c.completeAbandoned(0, [record({ _tag: "CommitText", text: text("late") })]);
    await select(router);
    expect(f.element.value).toBe("ab");
    expect(c.sent.filter((x) => x.request._tag === "ProcessKeyEvent")).toHaveLength(1);
  }));
it("reset commits earlier preedit then replays pending keys in one local batch", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const c = connections.a[0]!;
    c.outcome = {
      _tag: "reply",
      ret: 1,
      records: [{ ...record({ _tag: "UpdatePreeditText", text: text("X"), cursor: 1, visible: true, mode: 1 }) }],
    };
    key(f.element);
    c.outcome = { _tag: "pending" };
    key(f.element, "a");
    key(f.element, "b");
    const original = f.adapter.batch;
    let batches = 0;
    f.adapter.batch = (fn) => {
      batches++;
      original(fn);
    };
    f.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(f.element.value).toBe("Xab");
    expect(batches).toBe(1);
    c.completeAbandoned(1, [record({ _tag: "CommitText", text: text("late") })]);
    await select(router);
    expect(f.element.value).toBe("Xab");
  }));
it("scope disposal settles a pending switch drain and drops later editing", async () => {
  let pending: Promise<void> | undefined;
  await run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const c = connections.a[0]!;
    c.outcome = { _tag: "pending" };
    key(f.element);
    pending = select(router, "b");
    pending.catch(() => {});
  });
  await expect(pending).rejects.toThrow("Router is closed");
});
it("new keys after retirement wait behind Reset while the retired reply retains transport ownership", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const c = connections.a[0]!;
    c.outcome = { _tag: "pending" };
    key(f.element, "a");
    c.hold = "Reset";
    f.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await c.untilSent("Reset");
    expect(key(f.element, "b").defaultPrevented).toBe(true);
    expect(c.sent.filter((x) => x.request._tag === "ProcessKeyEvent")).toHaveLength(1);
    c.completeAbandoned(0, [record({ _tag: "CommitText", text: text("late") })]);
    expect(f.element.value).toBe("a");
    c.hold = undefined;
    c.completeAsync();
    await select(router);
    expect(f.element.value).toBe("ab");
    expect(c.sent.filter((x) => x.request._tag === "ProcessKeyEvent")).toHaveLength(2);
  }));

it("replays an accepted AltGraph character exactly once when its pending request is declined", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const c = connections.a[0]!;
    c.outcome = { _tag: "pending" };
    const inputs: (string | null)[] = [];
    f.element.addEventListener("input", (event) => inputs.push((event as InputEvent).data));
    const event = new KeyboardEvent("keydown", {
      key: "€",
      code: "KeyE",
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
      bubbles: true,
      cancelable: true,
    });
    f.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(f.element.value).toBe("");
    c.completeAbandoned(0);
    await select(router);
    expect(f.element.value).toBe("€");
    expect(inputs).toEqual(["€"]);
    expect(c.sent.filter((x) => x.request._tag === "ProcessKeyEvent")).toHaveLength(1);
  }));
