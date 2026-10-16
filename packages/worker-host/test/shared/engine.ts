// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  CrashReason,
  CreateEngine,
  DestroyEngine,
  Init,
  Persist,
  ProcessKeyEvent,
  PROTOCOL_VERSION,
  Shutdown,
  ReqMode,
  State,
  Word,
  encodeRequest,
  stringVariant,
  type Request,
  type ModuleManifest,
} from "@ibus-web/protocol";
import { expect } from "vitest";
import type { Harness, RuntimeBuild, RunningHost } from "./harness.ts";
import { HostOp } from "./testing.ts";
import { call32, int32s, opsOf, poll, stats } from "./scenarios.ts";
import { replyFile } from "./storage.ts";
import { engineDir } from "../../src/shared/naming.ts";

const call = async (host: RunningHost, ic: number, request: Request): Promise<number> => {
  host.client.page.post(encodeRequest(ic, request), ReqMode.sync);
  return (await host.client.page.waitForReply()).ret;
};
const init = () =>
  new Init({
    version: PROTOCOL_VERSION,
    userDataWritable: true,
    settings: [
      { schemaId: "org.example.echo", path: "/org/example/echo/", values: { value: stringVariant("snapshot") } },
    ],
  });
const key = (value: string, state = 0) => new ProcessKeyEvent({ keyval: value.charCodeAt(0), keycode: 0, state });
const modules = async (host: RunningHost): Promise<string[]> => {
  const reply = await host.client.call(HostOp.loadedModules);
  return JSON.parse(new TextDecoder().decode(reply.bytes)) as string[];
};

export const manifestFailures = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const base = h.data.engines.echo;
  for (const [change, error] of [
    [{ memory: h.data.constants.memory.minimum - 65536 }, /memory bounds/],
    [{ runtimeAbi: base.runtimeAbi + 1 }, /RuntimeAbiMismatch/],
    [{ runtimeIdentity: "0".repeat(64) }, /RuntimeAbiMismatch: manifest identity 0{64}/],
    [{ protocol: base.protocol + 1 }, /ProtocolMismatch/],
    [{ threads: undefined }, /threads/],
  ] as const) {
    await expect(h.start({ runtime, manifest: { ...base, ...change } as ModuleManifest })).rejects.toThrow(error);
  }
};

export const engineLifecycle = async (h: Harness, runtime: RuntimeBuild, memory: boolean): Promise<void> => {
  const engine = { ...h.data.engines.echo, name: `echo-${runtime.name}-${memory}-${Math.random()}` };
  const host = await h.start({
    runtime,
    engine,
    storage: memory ? { kind: "browser" } : h.storage(engine),
    test: { ...(memory ? h.withoutIndexedDB : {}), sides: [] },
  });
  try {
    expect(await modules(host)).toEqual([]);
    expect(await call(host, 1, new CreateEngine({ name: "echo" }))).toBe(-h.data.errno["ENOTCONN"]!);
    // Helpers are absent so module inspection observes exactly the engine.
    expect(await modules(host)).toEqual([]);
    expect(await call(host, 0, init())).toBe(0);
    expect(await modules(host)).toHaveLength(1);
    expect(host.client.page.records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ record: expect.objectContaining({ _tag: "Log", message: "echo init: snapshot" }) }),
      ]),
    );
    expect(await call(host, 0, new Persist({}))).toBe(0);
    expect(
      host.client.page.records().filter(({ record }) => record._tag === "Log" && record.message === "echo persisted"),
    ).toHaveLength(1);
    expect(await call(host, 1, new CreateEngine({ name: "echo" }))).toBe(0);
    expect(await call(host, 1, key("a"))).toBe(1);
    expect(await call(host, 1, key("d"))).toBe(1);
    expect(host.client.page.records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ic: 1,
          record: expect.objectContaining({
            _tag: "CommitText",
            text: expect.objectContaining({ text: "echo store data" }),
          }),
        }),
      ]),
    );
    expect(await call(host, 1, key("s"))).toBe(1);
    expect(host.client.page.records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ic: 0,
          record: expect.objectContaining({ _tag: "SettingWritten", path: "/org/example/echo/" }),
        }),
      ]),
    );
    expect(await call(host, 1, new DestroyEngine({}))).toBe(0);
    expect(
      host.client.page.records().filter(({ record }) => record._tag === "Log" && record.message === "echo finalized"),
    ).toHaveLength(1);
    for (const ic of [2, 3]) expect(await call(host, ic, new CreateEngine({ name: "echo" }))).toBe(0);
    // Stopping destroys the engines still open, and the page hears of their
    // last records through a doorbell, as of any written outside a request.
    host.client.page.records();
    Atomics.store(host.client.page.views.words, Word.doorbell, 0);
    const since = host.messages.length;
    await host.client.call(HostOp.stop);
    const deadline = h.now() + 30_000;
    while (!host.messages.slice(since).some(({ type }) => type === "doorbell") && h.now() < deadline) await h.sleep(10);
    expect(host.messages.slice(since).map(({ type }) => type)).toContain("doorbell");
    expect(
      host.client.page.records().filter(({ record }) => record._tag === "Log" && record.message === "echo finalized"),
      "the two remaining engines finalized",
    ).toHaveLength(2);
  } finally {
    await host.terminate();
  }
};

export const storeBeforeInit = async (h: Harness, runtime: RuntimeBuild, memory: boolean): Promise<void> => {
  const engine = { ...h.data.engines.echo, name: `store-${runtime.name}-${memory}-${Math.random()}` };
  const host = await h.start({
    runtime,
    engine,
    storage: memory ? { kind: "browser" } : h.storage(engine),
    test: memory ? h.withoutIndexedDB : {},
  });
  try {
    const read = async (path: string) =>
      replyFile(await host.client.call(opsOf(h).readFile, new TextEncoder().encode(path)));
    expect((await read(h.data.echoData)).text).toBe("echo store data\n");
    expect((await read(`${engineDir(engine)}/data`)).status).toBe(-h.data.errno["ENOENT"]!);
  } finally {
    await host.terminate();
  }
};

// The faulting request still completes as an asynchronous one does, with a
// doorbell, and the Crashed record is in the ring by the time the page can
// see CRASHED, so one drain then finds it.
export const engineFault = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const callsAfterFault = new SharedArrayBuffer(4);
  const host = await h.start({
    runtime,
    manifest: h.data.engines.thrower,
    test: { sides: [], callsAfterFault, canceled: h.data.constants.canceled },
  });
  try {
    expect(await call(host, 0, init())).toBe(0);
    expect(await call(host, 1, new CreateEngine({ name: "thrower" }))).toBe(0);
    const page = host.client.page;
    const words = page.views.words;
    page.records();
    const since = host.messages.length;
    page.post(encodeRequest(1, key("a")), ReqMode.async);
    const deadline = h.now() + 20_000;
    while (Atomics.load(words, Word.state) !== State.crashed && h.now() < deadline) {
      // Holds the thread, so the drain below is the first one since CRASHED.
    }
    expect(Atomics.load(words, Word.state)).toBe(State.crashed);
    const records = page.records();
    expect(records.at(-1)).toMatchObject({ seq: 0, ic: 0, record: { _tag: "Crashed", reason: CrashReason.fault } });
    expect(records[0]?.record).toMatchObject({ _tag: "CommitText", text: { text: "before fault" } });
    expect(Atomics.load(words, Word.replyRet)).toBe(h.data.constants.canceled);
    expect(Atomics.load(words, Word.replyOutSeq) >>> 0).toBe(records.at(-2)?.seq);
    // The runtime caught the exception inside GLib and went on writing
    // output: its warning reaches the page, and the crash names what() of
    // the exception.
    expect(records.at(-2)?.record).toMatchObject({ _tag: "Log", message: "An engine threw: thrower key failed" });
    expect(records.at(-1)?.record).toMatchObject({ message: "an engine threw: thrower key failed" });
    expect(await host.client.crashReport(20_000)).toContain("an engine threw: thrower key failed");
    const types = host.messages.slice(since).map(({ type }) => type);
    expect(types.indexOf("doorbell"), "a doorbell before the crash report").toBeGreaterThanOrEqual(0);
    expect(types.indexOf("doorbell")).toBeLessThan(types.indexOf("crashed"));
    await h.sleep(100);
    expect(Atomics.load(new Int32Array(callsAfterFault), 0)).toBe(0);
  } finally {
    await host.terminate();
  }
};

// Shutdown runs the module's shutdown function after Persist has run its
// persist function, and the runtime refuses every request after it.
export const engineShutdown = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const host = await h.start({ runtime, manifest: h.data.engines.echo, test: { sides: [] } });
  try {
    expect(await call(host, 0, init())).toBe(0);
    expect(await call(host, 1, new CreateEngine({ name: "echo" }))).toBe(0);
    host.client.page.records();
    expect(await call(host, 0, new Persist({}))).toBe(0);
    expect(await call(host, 0, new Shutdown({}))).toBe(0);
    const messages = host.client.page
      .records()
      .flatMap(({ record }) => (record._tag === "Log" && record.message.startsWith("echo ") ? [record.message] : []));
    expect(messages).toEqual(["echo persisted", "echo shut down"]);
    expect(await call(host, 1, key("a"))).toBe(-h.data.errno["ESHUTDOWN"]!);
    expect(await call(host, 0, new Shutdown({}))).toBe(-h.data.errno["ESHUTDOWN"]!);
  } finally {
    await host.terminate();
  }
};

// Once the engine module has loaded, every idle pool Worker has run a
// thread, so a burst of threads as large as the engine's share starts on
// Workers that have, creating none.
export const enginePoolWarm = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const host = await h.start({ runtime, manifest: h.data.engines.echo });
  try {
    const before = await stats(host.client);
    expect(before.warms).toBe(0);
    expect(await call(host, 0, init())).toBe(0);
    const after = await stats(host.client);
    expect(after.warms).toBe(1);
    expect(after.lastWarmed).toBe(after.idleWorkers);
    expect(after.lastWarmed).toBeGreaterThanOrEqual(h.data.pool.engine);

    const ops = opsOf(h);
    const startedAt = h.now();
    expect(await call32(host.client, ops.spawn, int32s(h.data.pool.engine))).toBe(0);
    const [count, error] = (await poll(h, host.client, ops.spawnResult)).values;
    const ms = h.now() - startedAt;
    h.record(`pool warm ${runtime.name}`, { warmed: after.lastWarmed, burst: count, burstMs: ms });
    expect([count, error]).toEqual([h.data.pool.engine, 0]);
    expect((await stats(host.client)).workersCreated).toBe(after.workersCreated);
  } finally {
    await host.terminate();
  }
};

export const engineLoadFailure = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const manifest = {
    ...h.data.engines.empty,
    module: { url: "data:application/wasm,%00%01%02%03", size: 4 },
  };
  const host = await h.start({ runtime, manifest, test: { sides: [] } });
  try {
    await call(host, 0, init()).catch(() => {});
    expect(await host.client.crashReport(20_000)).not.toBeNull();
    expect(host.client.page.records().at(-1)).toMatchObject({ record: { _tag: "Crashed", reason: CrashReason.load } });
  } finally {
    await host.terminate();
  }
};

export const manifestUrl = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const url = h.data.engines.echo.module.url.replace(/[^/]*$/, "manifest.json");
  const host = await h.start({ runtime, manifestUrl: url, test: { sides: [] } });
  try {
    expect(await call(host, 0, init())).toBe(0);
    expect(await call(host, 1, new CreateEngine({ name: "echo" }))).toBe(0);
    expect(await call(host, 1, key("d"))).toBe(1);
  } finally {
    await host.terminate();
  }
};
