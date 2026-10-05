// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  CrashReason,
  CreateEngine,
  DestroyEngine,
  Init,
  ProcessKeyEvent,
  PROTOCOL_VERSION,
  ReqMode,
  State,
  Word,
  encodeRequest,
  type Request,
  type EngineManifest,
} from "@ibus-web/protocol";
import { expect } from "vitest";
import type { Harness, RuntimeBuild, RunningHost } from "./harness.ts";
import { HostOp } from "./testing.ts";
import { opsOf } from "./scenarios.ts";
import { replyFile } from "./storage.ts";

const call = async (host: RunningHost, ic: number, request: Request): Promise<number> => {
  host.client.page.post(encodeRequest(ic, request), ReqMode.sync);
  return (await host.client.page.waitForReply()).ret;
};
const init = () =>
  new Init({
    version: PROTOCOL_VERSION,
    settings: {
      "org.example.echo": { value: { _tag: "v", type: "s", value: { _tag: "s", value: "snapshot" } } },
    },
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
    [{ protocol: base.protocol + 1 }, /ProtocolMismatch/],
    [{ threads: undefined }, /threads/],
  ] as const) {
    await expect(h.start({ runtime, manifest: { ...base, ...change } as EngineManifest })).rejects.toThrow(error);
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
          record: expect.objectContaining({ _tag: "SettingWritten", schemaId: "org.example.echo" }),
        }),
      ]),
    );
    expect(await call(host, 1, new DestroyEngine({}))).toBe(0);
    expect(
      host.client.page.records().filter(({ record }) => record._tag === "Log" && record.message === "echo finalized"),
    ).toHaveLength(1);
    for (const ic of [2, 3]) expect(await call(host, ic, new CreateEngine({ name: "echo" }))).toBe(0);
    await host.client.call(HostOp.stop);
    const deadline = h.now() + 30_000;
    let finalized = 0;
    while (finalized < 2 && h.now() < deadline) {
      finalized += host.client.page
        .records()
        .filter(({ record }) => record._tag === "Log" && record.message === "echo finalized").length;
      if (finalized < 2) await h.sleep(10);
    }
    expect(finalized, "the two remaining engines finalized before the deadline").toBe(2);
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
    expect((await read(`/engines/${engine.name}/data`)).status).toBe(-h.data.errno["ENOENT"]!);
  } finally {
    await host.terminate();
  }
};

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
    host.client.page.records();
    await call(host, 1, key("a")).catch(() => {});
    expect(await host.client.crashReport(20_000)).toContain("-ECANCELED");
    const words = host.client.page.views.words;
    expect(Atomics.load(words, Word.replyRet)).toBe(h.data.constants.canceled);
    expect(Atomics.load(words, Word.state)).toBe(State.crashed);
    const records = host.client.page.records();
    expect(records[0]?.record).toMatchObject({ _tag: "CommitText", text: { text: "before fault" } });
    expect(records.at(-1)).toMatchObject({ seq: 0, ic: 0, record: { _tag: "Crashed", reason: CrashReason.fault } });
    await h.sleep(100);
    expect(Atomics.load(new Int32Array(callsAfterFault), 0)).toBe(0);
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
    expect(await host.client.crashReport(20_000)).toBeDefined();
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
