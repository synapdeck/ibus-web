// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host as released, started on a JavaScript module: the fixture script,
// and scripts or manifests that don't belong together.

import type { JsModuleManifest } from "@ibus-web/protocol";
import { State, Word } from "@ibus-web/protocol/transport";
import { afterAll, expect, test, vi } from "vitest";
import { controlViews, postMail, postRequest, takeReply } from "../../src/shared/control.ts";
import { importRefusal } from "../../src/worker/layers/script.ts";
import { manifest, next, scriptDirectory, scriptUrl, start } from "./js-host.ts";

const scripts = scriptDirectory("ibus-web-js-start-");
afterAll(scripts.remove);

test("a host starts the fixture script, serves a request and takes the page's mail", async () => {
  const { worker, control, message } = await start(manifest);
  try {
    expect(message).toMatchObject({ type: "ready" });

    // A test request kind, which no backend handles, woken through the
    // control buffer's own wake word.
    const views = controlViews(control);
    postRequest(views, new Uint8Array([0x00, 0xff, 0, 0, 1, 0, 0, 0, 0]));
    await Atomics.waitAsync(views.words, Word.state, State.request, 10_000).value;
    // -ENOSYS, in Emscripten's numbering.
    expect(takeReply(views)).toEqual({ ret: -52, outSeq: 0 });

    const prepared = next(worker);
    worker.postMessage({ type: "prepare-engine", engine: "pick" });
    postMail(views);
    expect(await prepared).toEqual({ type: "prepared", engine: "pick" });

    const unknown = next(worker);
    worker.postMessage({ type: "prepare-engine", engine: "absent" });
    postMail(views);
    expect(await unknown).toEqual({
      type: "prepared",
      engine: "absent",
      error: "module js-fixture has no engine absent",
    });
  } finally {
    await worker.terminate();
  }
});

test("a host refuses a manifest or script that doesn't belong, or a script that throws as it is imported, for good", async () => {
  const [upper, pick, trace, stall] = manifest.engines;
  const absent = { ...upper!, name: "absent" };
  const cases: [string, JsModuleManifest, string, RegExp][] = [
    [
      "the manifest's ABI",
      { ...manifest, moduleAbi: 2 },
      "ModuleAbiMismatch",
      /^ModuleAbiMismatch: manifest 2, host 1$/,
    ],
    [
      "the script's ABI",
      scripts.manifest(
        "abi.mjs",
        `import script from ${JSON.stringify(scriptUrl)};\nexport default { ...script, ibusWebModule: 2 };\n`,
      ),
      "ModuleAbiMismatch",
      /^ModuleAbiMismatch: script 2, host 1$/,
    ],
    [
      "a missing engine",
      { ...manifest, engines: [...manifest.engines, absent] },
      "manifest",
      /: it has no engine absent$/,
    ],
    [
      "an extra engine",
      { ...manifest, engines: [upper!, trace!, stall!] },
      "manifest",
      /: its engine pick isn't in the manifest$/,
    ],
    ["engines out of order", { ...manifest, engines: [pick!, upper!, trace!, stall!] }, "manifest", /in another order/],
    [
      "a stale descriptor",
      {
        ...manifest,
        engines: [{ ...upper!, keyboard: { layout: "us", passThrough: ["Tab"] } }, pick!, trace!, stall!],
      },
      "manifest",
      /: its engine upper's descriptor differs from the manifest's$/,
    ],
    [
      "a default export that isn't a module",
      scripts.manifest("plain.mjs", "export default { engines: {} };\n"),
      "manifest",
      /: its default export isn't an ibus-web module$/,
    ],
    [
      "a script that throws at import",
      scripts.manifest("throws.mjs", 'throw new Error("broken at import");\n'),
      "manifest",
      /^module script file:.*throws\.mjs: Error: broken at import/,
    ],
    [
      "a script that doesn't parse",
      scripts.manifest("unparsed.mjs", "export default {;\n"),
      "manifest",
      /^module script file:.*unparsed\.mjs: SyntaxError/,
    ],
  ];

  for (const [what, startOn, refused, error] of cases) {
    const { worker, message } = await start(startOn);
    try {
      expect(message, what).toEqual({ type: "error", message: expect.stringMatching(error), refused });
    } finally {
      await worker.terminate();
    }
  }
});

test("a TypeError from import() is refused for good only if the script can be fetched again", async () => {
  const url = "https://example.test/module.mjs";
  const fetching = (result: Promise<{ ok: boolean }>) => vi.fn(() => result);

  const probe = fetching(Promise.resolve({ ok: true }));
  expect(await importRefusal(new TypeError("x is undefined"), url, probe)).toBe("manifest");
  expect(probe).toHaveBeenCalledExactlyOnceWith(url);

  expect(await importRefusal(new TypeError("x"), url, fetching(Promise.resolve({ ok: false })))).toBeUndefined();
  expect(
    await importRefusal(new TypeError("x"), url, fetching(Promise.reject(new TypeError("offline")))),
  ).toBeUndefined();
});

test("any other import() rejection is refused for good without fetching", async () => {
  const probe = vi.fn();

  for (const error of [new Error("broken at import"), new SyntaxError("Unexpected token"), "thrown"])
    expect(await importRefusal(error, "https://example.test/module.mjs", probe)).toBe("manifest");

  expect(probe).not.toHaveBeenCalled();
});

test("a host that can't fetch a script that threw a TypeError retries it, as for a failed fetch", async () => {
  // Node's fetch reads no file: URL, so the probe fails.
  const { worker, message } = await start(scripts.manifest("type-error.mjs", "null.x;\nexport default {};\n"));
  try {
    expect(message).toEqual({ type: "error", message: expect.stringMatching(/^module script file:.*: TypeError/) });
  } finally {
    await worker.terminate();
  }
});
