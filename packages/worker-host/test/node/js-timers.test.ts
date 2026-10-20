// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host as released, running a module's timers while it is idle: output
// with a doorbell, and a throw that crashes the host.

import { afterAll, expect, test } from "vitest";
import { CreateEngine, Init, ProcessKeyEvent, SettingChanged, variant } from "@ibus-web/protocol";
import { Word } from "@ibus-web/protocol/transport";
import { manifest, next, page, scriptDirectory, scriptUrl, start } from "./js-host.ts";

const scripts = scriptDirectory("ibus-web-js-timers-");
afterAll(scripts.remove);

const upperPath = "/org/example/jsfixture/upper/";

const init = new Init({ version: 1, userDataWritable: false, settings: [], patterns: [] });

const key = (character: string) => new ProcessKeyEvent({ keyval: character.codePointAt(0)!, keycode: 0, state: 0 });

test("a timer fires while the host is idle, its output draining behind a doorbell", async () => {
  const { worker, control, message } = await start(manifest);
  try {
    expect(message).toMatchObject({ type: "ready" });
    const host = page(control);
    const declared = new Init({
      version: 1,
      userDataWritable: false,
      settings: [{ schemaId: "org.example.jsfixture.upper", path: upperPath, values: {} }],
      patterns: [],
    });
    expect((await host.request(0, declared)).ret).toBe(0);
    expect((await host.request(1, new CreateEngine({ name: "upper" }))).ret).toBe(0);

    // The smallest delay the setting allows.
    const delay = variant("d", { _tag: "d", value: 0.1 });
    expect((await host.request(0, new SettingChanged({ path: upperPath, key: "delay", value: delay }))).ret).toBe(0);

    const doorbell = next(worker);
    const first = await host.request(1, key("a"));
    const second = await host.request(1, key("b"));
    expect([first.ret, second.ret]).toEqual([1, 1]);
    expect(Atomics.load(host.views.words, Word.doorbell)).toBe(0);

    expect(await doorbell).toEqual({ type: "doorbell" });
    expect(Atomics.load(host.views.words, Word.doorbell)).toBe(1);

    // The first key's timer was cancelled by the second, so the composition
    // commits once.
    expect(host.records().map(({ ic, record }) => [ic, record._tag])).toEqual([
      [1, "UpdatePreeditText"],
      [1, "CommitText"],
    ]);
  } finally {
    await worker.terminate();
  }
});

test("a timer that throws crashes the host with the module's fault", async () => {
  const { worker, control, message } = await start(
    scripts.manifest(
      "throwing.mjs",
      `import script from ${JSON.stringify(scriptUrl)};
      export default {
        ...script,
        engines: {
          ...script.engines,
          pick: {
            ...script.engines.pick,
            create: (context) => ({
              processKey() {
                context.log("info", "armed");
                context.after(0, () => {
                  throw new Error("late");
                });
                return true;
              },
            }),
          },
        },
      };`,
    ),
  );
  try {
    expect(message).toMatchObject({ type: "ready" });
    const host = page(control);
    expect((await host.request(0, init)).ret).toBe(0);
    expect((await host.request(1, new CreateEngine({ name: "pick" }))).ret).toBe(0);

    const crashed = next(worker);
    const served = await host.request(1, key("a"));
    expect(served.ret).toBe(1);
    expect(await crashed).toEqual({
      type: "crashed",
      message: expect.stringMatching(/^engine pick threw: Error: late/),
    });

    expect([...served.records, ...host.records()].map(({ record }) => record._tag)).toEqual(["Log", "Crashed"]);
  } finally {
    await worker.terminate();
  }
});
