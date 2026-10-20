// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The JavaScript backend on its own, past where a host would have crashed:
// what it answers once the module has faulted or shut down, what it destroys
// as the host closes, and when sessions hear of a setting's change.

import {
  booleanVariant,
  CreateEngine,
  decodeRecord,
  DestroyEngine,
  encodeRequest,
  FocusIn,
  Init,
  Persist,
  ProcessKeyEvent,
  SettingChanged,
  RingReader,
  RingWriter,
  Shutdown,
  transportLayout,
  transportViews,
  type DecodedRecord,
  type Request,
} from "@ibus-web/protocol";
import type { EngineContext, EngineSession, ModuleScript } from "@ibus-web/protocol/module-script";
import { expect, test } from "vitest";
import { jsBackend } from "../../src/worker/js-backend.ts";
import { RuntimeStopped } from "../../src/worker/failure.ts";
import { manifest, scriptUrl } from "./js-host.ts";

const ECANCELED = 11;
const ENOTRECOVERABLE = 56;
const ESHUTDOWN = 140;

const fixture = ((await import(scriptUrl)) as { default: ModuleScript }).default;

const backendFor = (script: ModuleScript, now: () => number = () => performance.now(), initialSeq = 0) => {
  const layout = transportLayout();
  const control = transportViews(new SharedArrayBuffer(layout.totalBytes), layout);
  const ring = { writer: new RingWriter(control, layout), control, postDoorbell: () => {}, lastSeq: initialSeq };
  const backend = jsBackend({ manifest, script, control, ring, now, initialSeq });
  const reader = new RingReader(control, layout);

  const records = (): DecodedRecord[] => {
    backend.drain();
    const read: DecodedRecord[] = [];
    for (let bytes = reader.next(); bytes !== undefined; bytes = reader.next()) read.push(decodeRecord(bytes));
    return read;
  };

  return {
    backend,
    ring,
    records,
    dispatch: (ic: number, request: Request) => backend.dispatch(encodeRequest(ic, request)),
  };
};

const init = new Init({ version: 1, userDataWritable: false, settings: [], patterns: [] });

const messages = (records: readonly DecodedRecord[]) =>
  records.map(({ record }) => (record._tag === "Log" ? record.message : record._tag));

test("record numbers skip zero as they wrap, and the ring names the last", () => {
  const { dispatch, records, ring } = backendFor(fixture, undefined, 0xfffffffe);
  dispatch(0, init);
  dispatch(1, new CreateEngine({ name: "trace" }));
  dispatch(1, new FocusIn({}));

  expect(records().map(({ seq }) => seq)).toEqual([0xffffffff, 1]);
  expect(ring.lastSeq).toBe(1);
});

test("a persist that throws is a fault, after which every request is refused", () => {
  const { backend, dispatch, records } = backendFor({
    ...fixture,
    persist: () => {
      throw new Error("disk full");
    },
  });
  expect(dispatch(0, init)).toEqual({ ret: 0 });
  expect(dispatch(1, new CreateEngine({ name: "trace" }))).toEqual({ ret: 0 });

  const persisted = dispatch(0, new Persist({}));
  expect(persisted).toEqual({
    ret: -ECANCELED,
    fault: expect.stringMatching(/^the module's persist threw: Error: disk full/),
  });
  expect(backend.fault()).toBe(persisted.fault);

  for (const request of [new FocusIn({}), new Persist({}), new Shutdown({}), init])
    expect(dispatch(1, request)).toEqual({ ret: -ENOTRECOVERABLE });

  // A faulted module isn't called again, so its sessions aren't destroyed.
  backend.close(true);
  expect(messages(records())).toEqual(["create()"]);
});

test("a handler that throws faults the module, keeping what its session wrote first", () => {
  const { backend, dispatch, records } = backendFor(fixture);
  dispatch(0, init);
  dispatch(1, new CreateEngine({ name: "trace" }));

  const fault = expect.stringMatching(/^engine trace threw: Error: trace fault/);
  expect(dispatch(1, new ProcessKeyEvent({ keyval: 0x21, keycode: 0, state: 0 }))).toEqual({ ret: -ECANCELED, fault });
  expect(backend.fault()).toEqual(fault);
  expect(messages(records())).toEqual(["create()", 'processKey(33, 0, 0, "!")']);

  expect(dispatch(2, new CreateEngine({ name: "trace" }))).toEqual({ ret: -ENOTRECOVERABLE });
  expect(records()).toEqual([]);
});

test("an output call no record can carry throws inside the handler, faulting the module", () => {
  const trace = fixture.engines["trace"]!;
  const { dispatch, records } = backendFor({
    ...fixture,
    engines: {
      ...fixture.engines,
      trace: { ...trace, create: (context) => ({ focusIn: () => context.preedit("ab", -1, true, "clear") }) },
    },
  });
  dispatch(0, init);
  dispatch(1, new CreateEngine({ name: "trace" }));

  expect(dispatch(1, new FocusIn({}))).toEqual({
    ret: -ECANCELED,
    fault: expect.stringMatching(/^engine trace threw: /),
  });
  expect(records()).toEqual([]);
});

test("a create's throw becomes CreateEngineFailed whatever it holds, and a log's NUL is replaced", () => {
  const trace = fixture.engines["trace"]!;
  const thrown: unknown[] = [
    new Error("no\0table \ud800"),
    Object.defineProperty(new Error(), "message", {
      get() {
        throw new Error("unprintable");
      },
    }),
  ];
  const { dispatch, records } = backendFor({
    ...fixture,
    engines: {
      ...fixture.engines,
      trace: {
        ...trace,
        create: () => {
          throw thrown.shift();
        },
      },
      pick: { ...trace, create: (context) => ({ focusIn: () => context.log("info", "a\0b") }) },
    },
  });
  dispatch(0, init);

  expect(dispatch(1, new CreateEngine({ name: "trace" }))).toEqual({ ret: -29 });
  expect(dispatch(1, new CreateEngine({ name: "trace" }))).toEqual({ ret: -29 });
  expect(dispatch(1, new CreateEngine({ name: "pick" }))).toEqual({ ret: 0 });
  expect(dispatch(1, new FocusIn({}))).toEqual({ ret: 0 });
  expect(records().map(({ record }) => record)).toMatchObject([
    { _tag: "CreateEngineFailed", message: "no\uFFFDtable \uFFFD" },
    { _tag: "CreateEngineFailed", message: "an unprintable error" },
    { _tag: "Log", message: "a\uFFFDb" },
  ]);
});

test("a log message that isn't a string faults the module naming log", () => {
  const trace = fixture.engines["trace"]!;
  const { dispatch } = backendFor({
    ...fixture,
    engines: {
      ...fixture.engines,
      trace: { ...trace, create: (context) => ({ focusIn: () => context.log("info", 7 as never) }) },
    },
  });
  dispatch(0, init);
  dispatch(1, new CreateEngine({ name: "trace" }));

  expect(dispatch(1, new FocusIn({}))).toEqual({
    ret: -ECANCELED,
    fault: expect.stringMatching(/TypeError: log needs a string message, not number/),
  });
});

test("a fault's text has what no record can carry replaced", () => {
  const { dispatch } = backendFor({
    ...fixture,
    persist: () => {
      throw new Error("lone \udc00 and \0");
    },
  });
  dispatch(0, init);

  expect(dispatch(0, new Persist({}))).toEqual({
    ret: -ECANCELED,
    fault: expect.stringMatching(/^the module's persist threw: Error: lone \uFFFD and \uFFFD/),
  });
});

test("a candidate page whose cursor is off it or whose labels don't match its candidates faults the module", () => {
  const pages = [
    { candidates: [], cursor: 0, cursorVisible: false },
    { candidates: ["a", "b"], cursor: 1, cursorVisible: true },
    { candidates: ["a", "b"], cursor: 2, cursorVisible: true },
    { candidates: ["a"], cursor: -1, cursorVisible: true },
    { candidates: [], cursor: 1, cursorVisible: false },
    { candidates: ["a", "b"], labels: ["1"], cursor: 0, cursorVisible: true },
  ];
  const outcomes = pages.map((page) => {
    const trace = fixture.engines["trace"]!;
    const { dispatch } = backendFor({
      ...fixture,
      engines: {
        ...fixture.engines,
        trace: { ...trace, create: (context) => ({ focusIn: () => context.lookupTable(page, true) }) },
      },
    });
    dispatch(0, init);
    dispatch(1, new CreateEngine({ name: "trace" }));
    return dispatch(1, new FocusIn({}));
  });

  expect(outcomes).toEqual([
    { ret: 0 },
    { ret: 0 },
    {
      ret: -ECANCELED,
      fault: expect.stringMatching(/RangeError: a candidate page's cursor 2 isn't on its 2 candidates/),
    },
    {
      ret: -ECANCELED,
      fault: expect.stringMatching(/RangeError: a candidate page's cursor -1 isn't on its 1 candidates/),
    },
    {
      ret: -ECANCELED,
      fault: expect.stringMatching(/RangeError: a candidate page's cursor 1 isn't on its 0 candidates/),
    },
    { ret: -ECANCELED, fault: expect.stringMatching(/RangeError: a candidate page has 1 labels for its 2 candidates/) },
  ]);
});

test("Shutdown calls the module's shutdown, after which every request is refused and no session destroyed", () => {
  const calls: string[] = [];
  const { backend, dispatch, records } = backendFor({ ...fixture, shutdown: () => void calls.push("shutdown") });
  dispatch(0, init);
  dispatch(1, new CreateEngine({ name: "trace" }));

  expect(dispatch(0, new Shutdown({}))).toEqual({ ret: 0 });
  expect(calls).toEqual(["shutdown"]);
  for (const request of [new FocusIn({}), new Shutdown({}), init])
    expect(dispatch(1, request)).toEqual({ ret: -ESHUTDOWN });

  backend.close(true);
  expect(messages(records())).toEqual(["create()"]);
});

test("closing destroys the open sessions only while the module may be called", () => {
  for (const intact of [true, false]) {
    const { backend, dispatch, records } = backendFor(fixture);
    dispatch(0, init);
    dispatch(1, new CreateEngine({ name: "trace" }));
    dispatch(2, new CreateEngine({ name: "trace" }));

    backend.close(intact);
    expect(messages(records()), String(intact)).toEqual(
      intact ? ["create()", "create()", "destroy()", "destroy()"] : ["create()", "create()"],
    );
  }
});

test("a destroy that throws as the host closes stops it with FAULT", () => {
  const trace = fixture.engines["trace"]!;
  const { backend, dispatch } = backendFor({
    ...fixture,
    engines: {
      ...fixture.engines,
      trace: {
        ...trace,
        create: (context) => ({
          ...trace.create(context),
          destroy: () => {
            throw new Error("still busy");
          },
        }),
      },
    },
  });
  dispatch(0, init);
  dispatch(1, new CreateEngine({ name: "trace" }));

  let stopped: unknown;
  try {
    backend.close(true);
  } catch (error) {
    stopped = error;
  }
  expect(stopped).toBeInstanceOf(RuntimeStopped);
  expect(stopped).toMatchObject({ reason: 2, error: expect.stringMatching(/^engine trace threw: Error: still busy/) });
});

// The fixture with a trace engine of one setting, `flag`, whose sessions
// log each change they hear of.
const flagged = (session: (context: EngineContext) => EngineSession): ModuleScript => ({
  ...fixture,
  engines: {
    ...fixture.engines,
    trace: {
      ...fixture.engines["trace"]!,
      settings: { flag: { type: "b", default: false } },
      create: (context) => ({
        settingChanged: (key, value) => context.log("info", `heard ${key} ${String(value)}`),
        ...session(context),
      }),
    },
  },
});

const tracePath = "/org/example/jsfixture/trace/";
const flaggedInit = new Init({
  version: 1,
  userDataWritable: false,
  settings: [{ schemaId: "org.example.jsfixture.trace", path: tracePath, values: {} }],
  patterns: [],
});

test("a write made in shutdown is persisted but told to no session", () => {
  let context!: EngineContext;
  const script = flagged((made) => {
    context = made;
    return {};
  });
  const { dispatch, records } = backendFor({ ...script, shutdown: () => context.settings.set("flag", true) });
  dispatch(0, flaggedInit);
  dispatch(1, new CreateEngine({ name: "trace" }));

  expect(dispatch(0, new Shutdown({}))).toEqual({ ret: 0 });
  expect(messages(records())).toEqual(["SettingWritten"]);
});

test("sessions hear of a session's write once the handler that made it has returned, the writer first", () => {
  const { dispatch, records } = backendFor(
    flagged((context) => ({
      focusIn: () => {
        context.settings.set("flag", true);
        context.log("info", `set, reading ${String(context.settings.get("flag"))}`);
      },
    })),
  );
  dispatch(0, flaggedInit);
  dispatch(1, new CreateEngine({ name: "trace" }));
  dispatch(2, new CreateEngine({ name: "trace" }));

  expect(dispatch(1, new FocusIn({}))).toEqual({ ret: 0 });
  expect(records().map(({ ic, record }) => [ic, record._tag === "Log" ? record.message : record])).toMatchObject([
    [1, { _tag: "SettingWritten", path: tracePath, key: "flag", value: booleanVariant(true) }],
    [1, "set, reading true"],
    [1, "heard flag true"],
    [2, "heard flag true"],
  ]);
});

test("a write a session's change handler makes is told after the change it heard", () => {
  const { dispatch, records } = backendFor(
    flagged((context) => ({
      settingChanged: (key, value) => {
        context.log("info", `heard ${key} ${String(value)}`);
        if (value === true) context.settings.set("flag", false);
      },
    })),
  );
  dispatch(0, flaggedInit);
  dispatch(1, new CreateEngine({ name: "trace" }));
  dispatch(2, new CreateEngine({ name: "trace" }));

  expect(dispatch(0, new SettingChanged({ path: tracePath, key: "flag", value: booleanVariant(true) }))).toEqual({
    ret: 0,
  });
  expect(messages(records())).toEqual([
    "heard flag true",
    "SettingWritten",
    "heard flag true",
    "SettingWritten",
    "heard flag false",
    "heard flag false",
  ]);
});

test("a write its key refuses throws inside the handler, faulting the module", () => {
  const { dispatch, records } = backendFor(
    flagged((context) => ({ focusIn: () => context.settings.set("flag", "yes" as never) })),
  );
  dispatch(0, flaggedInit);
  dispatch(1, new CreateEngine({ name: "trace" }));

  expect(dispatch(1, new FocusIn({}))).toEqual({
    ret: -ECANCELED,
    fault: expect.stringMatching(/^engine trace threw: TypeError: setting flag of engine trace can't hold "yes"/),
  });
  expect(records()).toEqual([]);
});

test("a change handler that throws faults the module", () => {
  const { dispatch } = backendFor(
    flagged(() => ({
      settingChanged: () => {
        throw new Error("deaf");
      },
    })),
  );
  dispatch(0, flaggedInit);
  dispatch(1, new CreateEngine({ name: "trace" }));

  expect(dispatch(0, new SettingChanged({ path: tracePath, key: "flag", value: booleanVariant(true) }))).toEqual({
    ret: -ECANCELED,
    fault: expect.stringMatching(/^engine trace threw: Error: deaf/),
  });
});

// A script whose one engine, `timed`, hands each session's context out.
const timedScript = (create: (context: EngineContext) => EngineSession) =>
  ({
    ...fixture,
    engines: { timed: { ...fixture.engines["trace"]!, create } },
  }) satisfies ModuleScript;

const clock = () => {
  let at = 1000;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
};

const logs = (records: readonly DecodedRecord[]) =>
  records.flatMap(({ ic, record }) => (record._tag === "Log" ? [`${ic}:${record.message}`] : []));

const timed = (create: (context: EngineContext) => EngineSession) => {
  const time = clock();
  const host = backendFor(timedScript(create), time.now);
  host.dispatch(0, init);
  return { ...host, time };
};

test("pump runs the timers that are due in order, returning the delay to the next", () => {
  let context!: EngineContext;
  const { backend, dispatch, records, time } = timed((made) => {
    context = made;
    return {};
  });
  dispatch(1, new CreateEngine({ name: "timed" }));
  expect(backend.pump()).toBe(-1);

  context.after(300, () => context.log("info", "c"));
  context.after(100, () => context.log("info", "a"));
  context.after(100, () => context.log("info", "b"));
  expect(backend.pump()).toBe(100);

  time.advance(100);
  expect(backend.pump()).toBe(200);
  expect(logs(records())).toEqual(["1:a", "1:b"]);

  time.advance(250);
  expect(backend.pump()).toBe(-1);
  expect(logs(records())).toEqual(["1:c"]);
});

test("a timer scheduled by a timer waits for the next pump", () => {
  let context!: EngineContext;
  const { backend, dispatch, records } = timed((made) => {
    context = made;
    return {};
  });
  dispatch(1, new CreateEngine({ name: "timed" }));

  let runs = 0;
  const again = (): void => {
    runs += 1;
    context.after(0, again);
  };
  context.after(0, again);

  expect(backend.pump()).toBe(0);
  expect(runs).toBe(1);
  expect(backend.pump()).toBe(0);
  expect(runs).toBe(2);
  expect(records()).toEqual([]);
});

test("a cancelled timer doesn't run, and cancelling twice or after it ran does nothing", () => {
  let context!: EngineContext;
  const { backend, dispatch, records, time } = timed((made) => {
    context = made;
    return {};
  });
  dispatch(1, new CreateEngine({ name: "timed" }));

  const cancelled = context.after(10, () => context.log("info", "cancelled"));
  const kept = context.after(10, () => context.log("info", "kept"));
  cancelled();
  cancelled();
  expect(backend.pump()).toBe(10);

  time.advance(10);
  expect(backend.pump()).toBe(-1);
  kept();
  cancelled();
  expect(logs(records())).toEqual(["1:kept"]);
});

test("a timer cancelled by one that ran before it in the same pump doesn't run", () => {
  let context!: EngineContext;
  const { backend, dispatch, records, time } = timed((made) => {
    context = made;
    return {};
  });
  dispatch(1, new CreateEngine({ name: "timed" }));

  const later = context.after(20, () => context.log("info", "later"));
  context.after(10, () => later());
  time.advance(30);

  expect(backend.pump()).toBe(-1);
  expect(logs(records())).toEqual([]);
});

test("a destroyed session's timers don't run, and a closed host's neither", () => {
  const contexts = new Map<number, EngineContext>();
  let created = 0;
  const { backend, dispatch, records, time } = timed((made) => {
    contexts.set((created += 1), made);
    return {};
  });
  dispatch(1, new CreateEngine({ name: "timed" }));
  dispatch(2, new CreateEngine({ name: "timed" }));
  dispatch(3, new CreateEngine({ name: "timed" }));

  const armed = (index: number) => {
    const context = contexts.get(index)!;
    context.after(10, () => context.log("info", `timer ${index}`));
    return context;
  };
  const destroyed = armed(1);
  armed(2);
  armed(3);

  dispatch(1, new DestroyEngine({}));
  // A destroyed session's context schedules nothing either.
  expect(destroyed.after(10, () => destroyed.log("info", "after destroy"))()).toBeUndefined();
  time.advance(10);
  expect(backend.pump()).toBe(-1);
  expect(logs(records())).toEqual(["2:timer 2", "3:timer 3"]);

  armed(2);
  backend.close(true);
  time.advance(10);
  expect(backend.pump()).toBe(-1);
  expect(logs(records())).toEqual([]);
});

test("an engine whose create fails leaves no timer behind", () => {
  const { backend, dispatch, time } = timed((context) => {
    context.after(10, () => {});
    throw new Error("no table");
  });
  expect(dispatch(1, new CreateEngine({ name: "timed" })).ret).toBe(-29);

  expect(backend.pump()).toBe(-1);
  time.advance(10);
  expect(backend.pump()).toBe(-1);
});

test("a timer that throws faults the module, and pump runs nothing afterwards", () => {
  let context!: EngineContext;
  const { backend, dispatch, records, time } = timed((made) => {
    context = made;
    return {};
  });
  dispatch(1, new CreateEngine({ name: "timed" }));

  context.after(10, () => {
    context.log("info", "before");
    throw new Error("late");
  });
  context.after(20, () => context.log("info", "after"));
  time.advance(20);

  expect(backend.pump()).toBe(-1);
  expect(backend.fault()).toMatch(/^engine timed threw: Error: late/);
  expect(logs(records())).toEqual(["1:before"]);

  expect(backend.pump()).toBe(-1);
  expect(logs(records())).toEqual([]);
  expect(dispatch(1, new FocusIn({}))).toEqual({ ret: -ENOTRECOVERABLE });
});

test("a setting a timer writes reaches the sessions as the pump ends", () => {
  const heard: string[] = [];
  let context!: EngineContext;
  const script = timedScript((made) => {
    context = made;
    return { settingChanged: (key) => void heard.push(key) };
  });
  const time = clock();
  const { backend, dispatch } = backendFor(
    {
      ...script,
      engines: {
        timed: { ...script.engines["timed"]!, settings: { mode: { type: "s", default: "a", summary: "A mode" } } },
      },
    },
    time.now,
  );
  dispatch(
    0,
    new Init({
      version: 1,
      userDataWritable: false,
      settings: [{ schemaId: "org.example.jsfixture.timed", path: "/org/example/jsfixture/timed/", values: {} }],
      patterns: [],
    }),
  );
  dispatch(1, new CreateEngine({ name: "timed" }));

  context.after(10, () => {
    context.settings.set("mode", "b");
    expect(heard).toEqual([]);
  });
  time.advance(10);

  expect(backend.pump()).toBe(-1);
  expect(heard).toEqual(["mode"]);
});

test("after refuses a delay that isn't a finite, non-negative number and a callback that isn't a function", () => {
  let context!: EngineContext;
  const { dispatch } = timed((made) => {
    context = made;
    return {};
  });
  dispatch(1, new CreateEngine({ name: "timed" }));

  for (const ms of [-1, NaN, Infinity, "5" as unknown as number])
    expect(() => context.after(ms, () => {})).toThrow(TypeError);
  expect(() => context.after(1, undefined as unknown as () => void)).toThrow(TypeError);
});
