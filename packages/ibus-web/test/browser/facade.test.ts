// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, test, vi } from "vitest";
import { Stream } from "effect";
import {
  Connection,
  type SurfaceAdapter,
  type SettingsSourceService,
  type AsyncKeyResult,
  type ConnectionOptions,
} from "@ibus-web/core";
import {
  encodeRequest,
  CandidateClicked,
  PageUp,
  PageDown,
  CursorUp,
  CursorDown,
  PropertyActivate,
  encodeSettingsMetadata,
  int32Variant,
  type SettingsMetadata,
  type LazyLookupTable,
} from "@ibus-web/protocol";
import {
  createIbusWeb,
  type IbusWebOptions,
  type IbusWebEventMap,
  type IbusWeb,
  type PanelAction,
} from "../../src/index.ts";
import { DomConnection, key, record, text } from "../../../core/test/browser/support/dom.ts";
const url = new URL("https://example.test/");
const manifest = {
  name: "test",
  version: "1",
  license: "MIT",
  runtimeAbi: 1,
  protocol: 1,
  module: { url: "engine.so", size: 1 },
  memory: 65536,
  threads: 0,
  data: [{ storePath: `/nix/store/${"a".repeat(32)}-test`, url: "data.tar", size: 0, encoding: "identity" }],
  settingsSchemaDir: `/nix/store/${"a".repeat(32)}-test/schemas`,
  engines: [{ name: "test", displayName: "test", languages: [], keyboard: { layout: "us", passThrough: [] } }],
  settingsSchemas: [],
};
const settings: SettingsSourceService = { snapshot: async () => ({}), written: () => {}, changes: Stream.empty };
const instances: ReturnType<typeof createIbusWeb>[] = [];
afterEach(async () => {
  for (const app of instances.splice(0)) await app?.dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function fixture(options: Partial<IbusWebOptions> = {}) {
  const starts: ConnectionOptions[] = [];
  const connections: DomConnection[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(manifest));
  const start = vi.spyOn(Connection, "start").mockImplementation(async (options) => {
    starts.push(options);
    const c = new DomConnection();
    connections.push(c);
    return c as unknown as Connection;
  });
  const app = createIbusWeb({ runtimeUrl: url, hostUrl: url, modules: { test: url }, settings, ...options });
  instances.push(app);
  const native = document.createElement("textarea");
  document.body.append(native);
  return { app, start, starts, connections, native };
}
function editor() {
  const element = document.createElement("div");
  element.tabIndex = 0;
  document.body.append(element);
  const resets = new Set<() => void>();
  const adapter: SurfaceAdapter = {
    element,
    capabilities: () => ({ preedit: true, auxText: true, lookupTable: true, surroundingText: false }),
    contentType: () => ({ purpose: 0, hints: 0, disabled: false }),
    surrounding: () => undefined,
    caretRect: () => new DOMRect(10, 20, 1, 16),
    batch: (apply) => apply(),
    commit: (value) => {
      element.textContent += value;
    },
    deleteSurrounding: () => {},
    setPreedit: () => {},
    replayKey: (event) => {
      element.textContent += event.key;
    },
    forwardKey: () => {},
    onReset: (listener) => {
      resets.add(listener);
      return () => {
        resets.delete(listener);
      };
    },
  };
  return { element, adapter, resets };
}
test("creation and attachment stay lazy; detach and disposal own every surface and connection", async () => {
  const f = fixture();
  const detach = f.app.attach(f.native);
  expect(typeof detach).toBe("function");
  expect(f.start).not.toHaveBeenCalled();
  f.native.focus();
  await f.app.select("test");
  expect(f.start).toHaveBeenCalledTimes(1);
  detach();
  detach();
  expect(key(f.native).defaultPrevented).toBe(false);
  await f.app.dispose();
  expect(f.connections[0]!.terminated).toBe(true);
  await expect(f.app.select("test")).rejects.toThrow();
});
test("native sync and manual adapters share the real router and preserve accepted output on focus change", async () => {
  const f = fixture(),
    edit = editor();
  f.app.attach(f.native);
  f.app.attachAdapter(edit.adapter, { keyMode: "manual" });
  f.native.focus();
  await f.app.select("test");
  const c = f.connections[0]!;
  c.outcome = { _tag: "reply", ret: 1, records: [record({ _tag: "CommitText", text: text("native") })] };
  expect(key(f.native).defaultPrevented).toBe(true);
  expect(f.native.value).toBe("native");
  edit.element.focus();
  await f.app.select("test");
  expect(key(edit.element).defaultPrevented).toBe(false);
  c.hold = "ProcessKeyEvent";
  let pending: Promise<AsyncKeyResult> | undefined;
  edit.element.addEventListener("keydown", (event) => {
    pending = f.app.keyAsync(edit.adapter, event);
  });
  expect(key(edit.element, "m").defaultPrevented).toBe(true);
  f.native.focus();
  const focused = f.app.select("test");
  c.completeAsync(0);
  expect(await pending).toBe("replayed");
  await focused;
  expect(edit.element.textContent).toBe("m");
  expect(f.native.value).toBe("native");
  expect(c.sent.filter((x) => x.request._tag === "ProcessKeyEvent").map((x) => x.mode)).toEqual(["sync", "async"]);
});
test("unload cancels manual ownership and reselect creates a fresh context on the same attachment", async () => {
  const f = fixture(),
    edit = editor();
  f.app.attachAdapter(edit.adapter, { keyMode: "manual" });
  edit.element.focus();
  await f.app.select("test");
  f.connections[0]!.hold = "ProcessKeyEvent";
  const pending = f.app.keyAsync(
    edit.adapter,
    new KeyboardEvent("keydown", { key: "a", code: "KeyA", cancelable: true }),
  );
  await f.app.unload("test");
  expect(await pending).toBe("cancelled");
  expect(edit.element.textContent).toBe("");
  await f.app.select("test");
  expect(f.connections).toHaveLength(2);
  expect(f.connections[1]!.sent.some((x) => x.request._tag === "CreateEngine")).toBe(true);
  await f.app.dispose();
  expect(edit.resets.size).toBe(0);
  expect(f.connections.every((c) => c.terminated)).toBe(true);
});
test("panel errors become filtered typed log events, including a throwing logger", async () => {
  const seen: unknown[] = [];
  const app = createIbusWeb({
    runtimeUrl: url,
    modules: {},
    logLevel: "error",
    logger: (entry) => {
      seen.push(entry);
      throw new Error("logger");
    },
  });
  instances.push(app);
  const events: Event[] = [];
  app.addEventListener("log", (event) => events.push(event));
  expect(() => app.reportPanelError(new Error("decode"))).not.toThrow();
  await Promise.resolve();
  expect(seen).toHaveLength(1);
  expect(events[0]).toBeInstanceOf(CustomEvent);
  expect((events[0] as CustomEvent).detail).toMatchObject({ level: "error", message: "decode" });
});

function nextEvent<K extends keyof IbusWebEventMap>(
  app: IbusWeb,
  type: K,
  predicate: (detail: IbusWebEventMap[K]["detail"]) => boolean = () => true,
) {
  return new Promise<IbusWebEventMap[K]>((resolve) => {
    const listener = (event: IbusWebEventMap[K]) => {
      if (predicate(event.detail)) {
        app.removeEventListener(type, listener as EventListener);
        resolve(event);
      }
    };
    app.addEventListener(type, listener);
  });
}
test("forwards lazy panel records and focused geometry without decoding candidates, and routes actions", async () => {
  const f = fixture(),
    edit = editor();
  f.app.attachAdapter(edit.adapter);
  edit.element.focus();
  const caret = nextEvent(f.app, "panel", (event) => event._tag === "caret");
  await f.app.select("test");
  expect((await caret).detail).toEqual({ _tag: "caret", module: "test", ic: 1 });
  expect(f.app.caretRect()).toMatchObject({ x: 10, y: 20, width: 1, height: 16 });
  const decode = vi.fn(() => ({ candidates: [], labels: [] }));
  const table: LazyLookupTable = {
    pageSize: 3,
    cursorPos: 0,
    cursorVisible: true,
    count: 3,
    round: false,
    orientation: 2,
    page: decode,
    visible: decode,
  };
  const panel = nextEvent(f.app, "panel", (event) => event._tag === "record");
  f.connections[0]!.outcome = {
    _tag: "reply",
    ret: 1,
    records: [record({ _tag: "UpdateLookupTable", table, visible: true })],
  };
  key(edit.element);
  const event = await panel;
  expect(event).toBeInstanceOf(CustomEvent);
  expect(
    event.detail._tag === "record" && event.detail.record._tag === "UpdateLookupTable" && event.detail.record.table,
  ).toBe(table);
  expect(decode).not.toHaveBeenCalled();
  f.app.sendPanelAction("test", 1, { _tag: "CandidateClicked", index: 2, button: 1, state: 0 });
  expect(f.connections[0]!.sent.at(-1)).toMatchObject({
    ic: 1,
    request: { _tag: "CandidateClicked", index: 2, button: 1, state: 0 },
  });
  const hide = nextEvent(f.app, "panel", (event) => event._tag === "hide");
  edit.element.blur();
  await hide;
  expect(f.app.caretRect()).toBeNull();
});
test("encodes every structural public panel action through the actual protocol boundary", async () => {
  const f = fixture();
  f.app.attach(f.native);
  f.native.focus();
  await f.app.select("test");
  const connection = f.connections[0]!;
  const request = connection.requestAsync.bind(connection);
  const encoded: Uint8Array[] = [];
  connection.requestAsync = async (action, ic) => {
    encoded.push(encodeRequest(ic, action));
    return request(action, ic);
  };
  const actions: PanelAction[] = [
    { _tag: "CandidateClicked", index: 2, button: 1, state: 0 },
    { _tag: "PageUp" },
    { _tag: "PageDown" },
    { _tag: "CursorUp" },
    { _tag: "CursorDown" },
    { _tag: "PropertyActivate", name: "InputMode", state: 1 },
  ];
  const requests = [
    new CandidateClicked({ index: 2, button: 1, state: 0 }),
    new PageUp(),
    new PageDown(),
    new CursorUp(),
    new CursorDown(),
    new PropertyActivate({ name: "InputMode", state: 1 }),
  ];
  for (const action of actions) f.app.sendPanelAction("test", 1, action);
  expect(encoded).toEqual(requests.map((request) => encodeRequest(1, request)));
  const failed = nextEvent(f.app, "log", (entry) => entry.domain === "panel" && entry.level === "error");
  expect(() =>
    f.app.sendPanelAction("test", 1, { _tag: "CandidateClicked", index: -1, button: 1, state: 0 }),
  ).not.toThrow();
  expect((await failed).detail.message).toMatch(/index|Uint32|greater|negative/);
  expect(encoded).toHaveLength(6);
});
test("lists a module's engines without starting a Worker and rejects an unknown module", async () => {
  const f = fixture();
  expect(await f.app.engines("test")).toEqual(manifest.engines);
  expect(f.start).not.toHaveBeenCalled();
  await expect(f.app.engines("missing")).rejects.toThrow("Unknown module: missing");
});
test("selection and selectionchange follow select, deselect and unload", async () => {
  const f = fixture();
  f.app.attach(f.native);
  f.native.focus();
  expect(f.app.selection).toBeUndefined();
  const selected = nextEvent(f.app, "selectionchange");
  await f.app.select("test");
  expect((await selected).detail).toEqual({ module: "test", engine: "test" });
  expect(f.app.selection).toEqual({ module: "test", engine: "test" });
  await expect(f.app.select("test", "missing")).rejects.toThrow(/Unknown engine/);
  expect(f.app.selection).toEqual({ module: "test", engine: "test" });
  const deselected = nextEvent(f.app, "selectionchange");
  await f.app.deselect();
  expect((await deselected).detail).toBeNull();
  expect(f.app.selection).toBeUndefined();
  expect(key(f.native).defaultPrevented).toBe(false);
  expect(f.connections[0]!.terminated).toBe(false);
  await f.app.select("test", "test");
  const unloaded = nextEvent(f.app, "selectionchange");
  await f.app.unload("test");
  expect((await unloaded).detail).toBeNull();
});
test("publishes state and storage CustomEvents from actual core lifecycle, including restart and unload", async () => {
  const f = fixture();
  f.app.attach(f.native);
  f.native.focus();
  const states: string[] = [];
  f.app.addEventListener("modulestate", (event) => {
    expect(event).toBeInstanceOf(CustomEvent);
    states.push(event.detail.state);
  });
  await f.app.select("test");
  const storage = nextEvent(f.app, "storage");
  f.starts[0]!.onStorage?.({ state: "read-only", message: "writer elsewhere" });
  expect((await storage).detail).toEqual({ module: "test", state: "read-only", message: "writer elsewhere" });
  await f.app.debugRestart("test");
  expect(f.connections).toHaveLength(2);
  expect(f.connections[0]!.terminated).toBe(true);
  const unloaded = nextEvent(f.app, "modulestate", (event) => event.state === "unloaded");
  await f.app.unload("test");
  await unloaded;
  expect(states).toContain("starting");
  expect(states).toContain("restarting");
  expect(states).toContain("ready");
  expect(states.at(-1)).toBe("unloaded");
});
test("filters engine logs by level and reports rejected panel actions through the same observable log route", async () => {
  const logs: unknown[] = [];
  const f = fixture({ logLevel: "warn", logger: (entry) => logs.push(entry) });
  f.app.attach(f.native);
  f.native.focus();
  await f.app.select("test");
  const logged = nextEvent(f.app, "log", (entry) => entry.message === "warning");
  f.connections[0]!.outcome = {
    _tag: "reply",
    ret: 1,
    records: [
      record({ _tag: "Log", level: 64, domain: "test", message: "info" }, 0),
      record({ _tag: "Log", level: 16, domain: "test", message: "warning" }, 0),
    ],
  };
  key(f.native);
  await logged;
  expect(logs).toEqual([{ level: "warn", domain: "test", module: "test", ic: 0, message: "warning" }]);
  f.connections[0]!.requestAsync = async () => {
    throw new Error("action failed");
  };
  const failed = nextEvent(f.app, "log", (entry) => entry.message === "action failed");
  f.app.sendPanelAction("test", 1, { _tag: "PageDown" });
  expect((await failed).detail).toMatchObject({ level: "error", domain: "panel" });
});
test("automatic async adapters and native sync attachments preserve independent policies", async () => {
  const f = fixture(),
    edit = editor();
  f.app.attach(f.native);
  f.app.attachAdapter(edit.adapter, { keyMode: "async" });
  edit.element.focus();
  await f.app.select("test");
  const c = f.connections[0]!;
  c.hold = "ProcessKeyEvent";
  expect(key(edit.element, "a").defaultPrevented).toBe(true);
  c.completeAsync(0);
  await f.app.select("test");
  expect(edit.element.textContent).toBe("a");
  f.native.focus();
  await f.app.select("test");
  expect(key(f.native).defaultPrevented).toBe(true);
  expect(c.sent.filter((x) => x.request._tag === "ProcessKeyEvent").map((x) => x.mode)).toEqual(["async", "sync"]);
});

test("settings load without Workers and publish orientation snapshots with context identity", async () => {
  const schema = "org.freedesktop.ibus.panel",
    name = "lookup-table-orientation";
  const values: Record<string, Record<string, { _tag: "v"; type: string; value: { _tag: "i"; value: number } }>> = {};
  const source: SettingsSourceService = {
    ...settings,
    snapshot: async () => values,
    written: (change) => {
      values[change.schemaId] = {
        [change.key]: change.value as { _tag: "v"; type: string; value: { _tag: "i"; value: number } },
      };
    },
  };
  const f = fixture({ settings: source });
  const metadata: SettingsMetadata = {
    schemas: [
      {
        id: schema,
        path: "/desktop/ibus/panel/",
        keys: [
          {
            name,
            type: "i",
            default: { _tag: "i", value: 1 },
            range: { min: { _tag: "i", value: 0 }, max: { _tag: "i", value: 1 } },
          },
        ],
      },
    ],
  };
  vi.mocked(fetch).mockImplementation(async (input) =>
    Response.json(
      String(input).endsWith("settings.json")
        ? encodeSettingsMetadata(metadata)
        : { ...manifest, settingsSchemas: [schema], settingsMetadata: { url: "settings.json", size: 1 } },
    ),
  );
  expect(await f.app.settings.schemas("test")).toEqual(metadata.schemas);
  expect(f.start).not.toHaveBeenCalled();
  expect(await f.app.settings.get("test", schema, name)).toMatchObject({ value: { value: 1 } });
  f.app.attach(f.native);
  f.native.focus();
  await f.app.select("test");
  const horizontal = nextEvent(f.app, "panel", (event) => event._tag === "orientation");
  await f.app.settings.set("test", schema, name, int32Variant(0));
  expect((await horizontal).detail).toEqual({ _tag: "orientation", module: "test", ic: 1 });
  expect(f.app.lookupTableOrientation("test")).toBe(0);
  await expect(f.app.settings.set("test", schema, name, int32Variant(3))).rejects.toThrow();
  await f.app.settings.reset("test", schema, name);
  expect(f.app.lookupTableOrientation("test")).toBe(1);
});
test("dispose during lazy runtime acquisition rejects selection without starting a Worker", async () => {
  const f = fixture(),
    edit = editor();
  f.app.attachAdapter(edit.adapter);
  edit.element.focus();
  const selected = f.app.select("test").then(
    () => undefined,
    (error: unknown) => error,
  );
  await f.app.dispose();
  expect(await selected).toBeDefined();
  expect(f.start).not.toHaveBeenCalled();
  expect(edit.resets.size).toBe(0);
});
test("dispose during Worker startup aborts acquisition and terminates a late connection", async () => {
  const f = fixture();
  let entered!: () => void, finish!: (connection: Connection) => void;
  let signal: AbortSignal | undefined;
  const booting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.start.mockImplementation((options) => {
    signal = options.signal;
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  f.app.attach(f.native);
  f.native.focus();
  const selected = f.app.select("test").then(
    () => undefined,
    (error: unknown) => error,
  );
  await booting;
  await f.app.dispose();
  expect(signal?.aborted).toBe(true);
  expect(await selected).toBeDefined();
  const late = new DomConnection();
  finish(late as unknown as Connection);
  await Promise.resolve();
  expect(late.terminated).toBe(true);
  expect(key(f.native).defaultPrevented).toBe(false);
});
test("panel error reporting cannot throw even for an unprintable host failure", async () => {
  const f = fixture();
  expect(() =>
    f.app.reportPanelError({
      toString() {
        throw new Error("unprintable");
      },
    }),
  ).not.toThrow();
});

test("unloading an inactive engine preserves the active engine's preedit on its surface", async () => {
  const f = fixture({ modules: { a: new URL("a", url), b: new URL("b", url) } }),
    edit = editor();
  vi.mocked(fetch).mockImplementation(async (input) =>
    Response.json({ ...manifest, name: new URL(String(input)).pathname.slice(1) }),
  );
  const preedits: unknown[] = [];
  edit.adapter.setPreedit = (value) => {
    preedits.push(value);
  };
  f.app.attachAdapter(edit.adapter);
  edit.element.focus();
  await f.app.select("a");
  await f.app.select("b");
  f.connections[1]!.outcome = {
    _tag: "reply",
    ret: 1,
    records: [record({ _tag: "UpdatePreeditText", text: text("composing"), cursor: 9, visible: true, mode: 0 })],
  };
  key(edit.element);
  const before = preedits.length;
  await f.app.unload("a");
  expect(preedits).toHaveLength(before);
  expect(f.connections[1]!.terminated).toBe(false);
});

test("unload invalidates every earlier queued selection without waiting for stalled startup", async () => {
  const f = fixture();
  let entered!: () => void, finish!: (connection: Connection) => void;
  let signal: AbortSignal | undefined;
  const booting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.start.mockImplementationOnce((options) => {
    signal = options.signal;
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const first = f.app.select("test").then(
    () => "resolved",
    () => "rejected",
  );
  await booting;
  const second = f.app.select("test").then(
    () => "resolved",
    () => "rejected",
  );
  await f.app.unload("test");
  expect(signal?.aborted).toBe(true);
  expect(await Promise.all([first, second])).toEqual(["rejected", "rejected"]);
  expect(f.start).toHaveBeenCalledTimes(1);
  const late = new DomConnection();
  finish(late as unknown as Connection);
  await Promise.resolve();
  expect(late.terminated).toBe(true);
  await f.app.select("test");
  expect(f.start).toHaveBeenCalledTimes(2);
});

for (const callback of ["setPreedit", "batch", "reset cleanup"] as const)
  test(`disposal releases every surface and Worker after a failing first adapter ${callback}`, async () => {
    const f = fixture({ modules: { a: new URL("a", url), b: new URL("b", url) } });
    vi.mocked(fetch).mockImplementation(async (input) =>
      Response.json({ ...manifest, name: new URL(String(input)).pathname.slice(1) }),
    );
    const first = editor(),
      second = editor();
    if (callback === "reset cleanup") {
      const subscribe = first.adapter.onReset;
      first.adapter.onReset = (listener) => {
        const remove = subscribe(listener);
        return () => {
          remove();
          throw new Error("adapter failed");
        };
      };
    }
    f.app.attachAdapter(first.adapter, { keyMode: "manual" });
    f.app.attachAdapter(second.adapter, { keyMode: "async" });
    first.element.focus();
    await f.app.select("a");
    second.element.focus();
    await f.app.select("b");
    first.element.focus();
    await f.app.select("b");
    second.element.focus();
    await f.app.select("b");
    if (callback === "setPreedit")
      first.adapter.setPreedit = () => {
        throw new Error("adapter failed");
      };
    if (callback === "batch")
      first.adapter.batch = () => {
        throw new Error("adapter failed");
      };
    f.connections[1]!.hold = "ProcessKeyEvent";
    const pending = f.app.keyAsync(
      second.adapter,
      new KeyboardEvent("keydown", { key: "a", code: "KeyA", cancelable: true }),
    );
    let disposal!: Promise<void>;
    expect(() => {
      disposal = f.app.dispose();
    }).not.toThrow();
    await expect(disposal).rejects.toThrow();
    expect(await pending).toBe("cancelled");
    expect(first.resets.size).toBe(0);
    expect(second.resets.size).toBe(0);
    expect(f.connections).toHaveLength(2);
    expect(f.connections.every((connection) => connection.terminated)).toBe(true);
    expect(key(second.element).defaultPrevented).toBe(false);
    expect(f.app.dispose()).toBe(disposal);
    await expect(f.app.dispose()).rejects.toThrow();
    instances.splice(instances.indexOf(f.app), 1);
  });

test("unload cancels ownership and releases the engine despite a preedit callback failure", async () => {
  const f = fixture(),
    first = editor(),
    second = editor();
  f.app.attachAdapter(first.adapter, { keyMode: "manual" });
  f.app.attachAdapter(second.adapter);
  second.element.focus();
  await f.app.select("test");
  first.element.focus();
  await f.app.select("test");
  first.adapter.setPreedit = () => {
    throw new Error("adapter failed");
  };
  f.connections[0]!.hold = "ProcessKeyEvent";
  const pending = f.app.keyAsync(
    first.adapter,
    new KeyboardEvent("keydown", { key: "a", code: "KeyA", cancelable: true }),
  );
  await expect(f.app.unload("test")).rejects.toThrow();
  expect(await pending).toBe("cancelled");
  expect(f.connections[0]!.terminated).toBe(true);
  expect(f.app.caretRect()).toBeNull();
  first.adapter.setPreedit = () => {};
  await f.app.select("test");
  expect(f.start).toHaveBeenCalledTimes(2);
});
