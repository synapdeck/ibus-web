// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The hand-written JavaScript module under a real page: its script imported
// by URL in the host's Worker, served with the suite's cross-origin
// isolation headers, and driven through the control buffer from the page's
// main thread.

import {
  booleanVariant,
  CreateEngine,
  DestroyEngine,
  Init,
  PROTOCOL_VERSION,
  ProcessKeyEvent,
  PropertyActivate,
  ReqMode,
  SettingChanged,
  State,
  Word,
  encodeRequest,
  stringVariant,
  type DecodedRecord,
  type Request,
} from "@ibus-web/protocol";
import { expect } from "vitest";
import type { Harness, RunningHost, RuntimeBuild } from "../shared/harness.ts";

const upperPath = "/org/example/jsfixture/upper/";

const key = (character: string) => new ProcessKeyEvent({ keyval: character.codePointAt(0)!, keycode: 0, state: 0 });

interface Served {
  ret: number;
  records: DecodedRecord[];
}

// One request, and the records the host wrote serving it.
const serve = async ({ client }: RunningHost, ic: number, request: Request): Promise<Served> => {
  client.page.post(encodeRequest(ic, request), ReqMode.sync);
  const { ret } = await client.page.waitForReply();
  return { ret, records: client.page.records() };
};

const tags = ({ records }: Served): string[] => records.map(({ record }) => record._tag);

const commits = ({ records }: Served): string[] =>
  records.flatMap(({ record }) => (record._tag === "CommitText" ? [record.text.text] : []));

const startFixture = (h: Harness, runtime: RuntimeBuild): Promise<RunningHost> =>
  h.start({ runtime, manifest: h.data.jsModule });

// Init, declaring the upper engine's settings instance, which its property
// and the page's changes need.
const init = (): Init =>
  new Init({
    version: PROTOCOL_VERSION,
    userDataWritable: false,
    settings: [{ schemaId: "org.example.jsfixture.upper", path: upperPath, values: {} }],
    patterns: [],
  });

const opened = async (host: RunningHost, ic: number, engine: string): Promise<void> => {
  expect((await serve(host, ic, init())).ret).toBe(0);
  expect((await serve(host, ic, new CreateEngine({ name: engine }))).ret).toBe(0);
};

// A host stopped by a fault leaves its Crashed record in the ring and posts
// the fault's text.
const crashedWith = async (host: RunningHost, message: RegExp): Promise<void> => {
  expect(await host.client.crashReport(10_000)).toMatch(message);
  expect(Atomics.load(host.client.page.views.words, Word.state)).toBe(State.crashed);
  const records = host.client.page.records().map(({ record }) => record);
  expect(records.at(-1)).toMatchObject({ _tag: "Crashed", reason: 2, message: expect.stringMatching(message) });
};

export const jsModuleSmoke = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const host = await startFixture(h, runtime);
  try {
    await opened(host, 1, "trace");
    const served = await serve(host, 1, key("c"));
    expect(served.ret).toBe(1);
    expect(commits(served)).toEqual(["commit"]);
  } finally {
    await host.terminate();
  }
};

export const jsModuleKeys = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const host = await startFixture(h, runtime);
  try {
    expect((await serve(host, 0, init())).ret).toBe(0);
    expect((await serve(host, 1, new CreateEngine({ name: "upper" }))).ret).toBe(0);
    expect((await serve(host, 2, new CreateEngine({ name: "pick" }))).ret).toBe(0);
    expect((await serve(host, 3, new CreateEngine({ name: "trace" }))).ret).toBe(0);

    const first = await serve(host, 1, key("a"));
    expect(first.ret).toBe(1);
    expect(tags(first)).toEqual(["UpdatePreeditText"]);
    expect((await serve(host, 1, key("b"))).ret).toBe(1);
    const composed = await serve(host, 1, key(" "));
    expect(composed.ret).toBe(1);
    expect(commits(composed)).toEqual(["AB"]);

    const offered = await serve(host, 2, key("x"));
    expect(offered.ret).toBe(1);
    expect(tags(offered)).toEqual(["UpdateLookupTable", "UpdateAuxiliaryText"]);
    const picked = await serve(host, 2, key("2"));
    expect(picked.ret).toBe(1);
    expect(commits(picked)).toEqual(["xx"]);

    expect((await serve(host, 3, key("p"))).ret).toBe(1);
    expect((await serve(host, 3, key("z"))).ret).toBe(0);

    expect((await serve(host, 1, new DestroyEngine({}))).ret).toBe(0);
    expect((await serve(host, 1, key("a"))).ret).toBeLessThan(0);
  } finally {
    await host.terminate();
  }
};

export const jsModuleSettingChange = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const host = await startFixture(h, runtime);
  try {
    await opened(host, 1, "upper");
    expect((await serve(host, 1, key("a"))).ret).toBe(1);
    expect((await serve(host, 1, key("b"))).ret).toBe(1);

    const changed = await serve(
      host,
      0,
      new SettingChanged({ path: upperPath, key: "shout", value: booleanVariant(false) }),
    );
    expect(changed.ret).toBe(0);
    expect(tags(changed)).toEqual(["UpdateProperty", "UpdatePreeditText"]);
    expect(changed.records[0]!.record).toMatchObject({ property: { key: "shout", state: 0 } });
    expect(changed.records[1]!.record).toMatchObject({ text: { text: "ab" } });

    const composed = await serve(host, 1, key(" "));
    expect(commits(composed)).toEqual(["ab"]);

    const refused = await serve(
      host,
      0,
      new SettingChanged({ path: upperPath, key: "shout", value: stringVariant("no") }),
    );
    expect(refused.ret).toBeLessThan(0);
    expect(refused.records.map(({ record }) => record._tag)).toEqual(["Log"]);
  } finally {
    await host.terminate();
  }
};

export const jsModulePropertyActivated = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const host = await startFixture(h, runtime);
  try {
    expect((await serve(host, 0, init())).ret).toBe(0);
    const created = await serve(host, 1, new CreateEngine({ name: "upper" }));
    expect(created.ret).toBe(0);
    expect(tags(created)).toEqual(["RegisterProperties"]);

    const activated = await serve(host, 1, new PropertyActivate({ name: "shout", state: 0 }));
    expect(activated.ret).toBe(0);
    expect(tags(activated)).toEqual(["SettingWritten", "UpdateProperty", "UpdatePreeditText"]);
    expect(activated.records[0]!.record).toMatchObject({ path: upperPath, key: "shout" });
    expect(activated.records[1]!.record).toMatchObject({ property: { key: "shout", state: 0 } });

    expect((await serve(host, 1, key("a"))).ret).toBe(1);
    expect(commits(await serve(host, 1, key(" ")))).toEqual(["a"]);
  } finally {
    await host.terminate();
  }
};

export const jsModuleFault = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const host = await startFixture(h, runtime);
  try {
    await opened(host, 1, "trace");

    host.client.page.post(encodeRequest(1, key("!")), ReqMode.sync);
    await expect(host.client.page.waitForReply()).rejects.toThrow(/host crashed/);
    await crashedWith(host, /^engine trace threw: Error: trace fault/);
  } finally {
    await host.terminate();
  }
};

// How long the page lets a request go unanswered before it reads the silence
// as the handler's.
const SILENCE_MS = 500;

export const jsModuleHang = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const host = await startFixture(h, runtime);
  try {
    await opened(host, 1, "stall");
    const { page } = host.client;
    const crashes = () => host.messages.filter(({ type }) => type === "crashed");

    page.post(encodeRequest(1, key("a")), ReqMode.sync);
    await h.sleep(SILENCE_MS);

    // Neither a reply nor a crash: the Worker is alive, inside the handler,
    // and nothing moved in the ring, which is what the page's hang
    // detection watches for.
    expect(Atomics.load(page.views.words, Word.state)).toBe(State.request);
    expect(page.records()).toEqual([]);
    expect(crashes()).toEqual([]);
  } finally {
    await host.terminate();
  }
};

// A browser's import() rejects with a TypeError for a script that fails to
// fetch, the one import failure the host doesn't refuse for good.
export const jsModuleMissingScript = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const { jsModule } = h.data;
  const missing = {
    ...jsModule,
    module: { ...jsModule.module, url: jsModule.module.url.replace(/module\.mjs$/, "missing.mjs") },
  };
  await expect(h.start({ runtime, manifest: missing })).rejects.toThrow(
    /^host: module script \S*missing\.mjs: TypeError/,
  );
};

export const jsModuleBesideWasm = async (h: Harness, runtime: RuntimeBuild): Promise<void> => {
  const echo = { ...h.data.engines.echo, name: `echo-${runtime.name}-js-beside-${Math.random()}` };
  const script = await startFixture(h, runtime);
  const wasm = await h.start({ runtime, engine: echo });
  try {
    const echoInit = new Init({
      version: PROTOCOL_VERSION,
      userDataWritable: true,
      settings: [
        { schemaId: "org.example.echo", path: "/org/example/echo/", values: { value: stringVariant("snapshot") } },
      ],
      patterns: [],
    });
    expect((await serve(wasm, 0, echoInit)).ret).toBe(0);
    expect((await serve(wasm, 1, new CreateEngine({ name: "echo" }))).ret).toBe(0);
    await opened(script, 1, "trace");

    // Requests alternate between the two Workers.
    expect(commits(await serve(script, 1, key("c")))).toEqual(["commit"]);
    expect((await serve(wasm, 1, key("a"))).ret).toBe(1);
    expect(commits(await serve(wasm, 1, key("d")))).toEqual(["echo store data"]);
    expect(commits(await serve(script, 1, key("c")))).toEqual(["commit"]);

    // One module's fault leaves the other serving.
    script.client.page.post(encodeRequest(1, key("!")), ReqMode.sync);
    await expect(script.client.page.waitForReply()).rejects.toThrow(/host crashed/);
    await crashedWith(script, /^engine trace threw: Error: trace fault/);
    expect(commits(await serve(wasm, 1, key("d")))).toEqual(["echo store data"]);
  } finally {
    await Promise.all([script.terminate(), wasm.terminate()]);
  }
};
