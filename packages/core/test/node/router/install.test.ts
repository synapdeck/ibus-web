// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostInit, HostMessage } from "@ibus-web/worker-host";
import { EngineLoadFailed, ModuleAbiMismatch, ProtocolMismatch, RuntimeAbiMismatch } from "../../../src/errors.ts";
import { installModule } from "../../../src/services/preload.ts";

const wasm = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(wasm);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// A Worker whose host answers the init message with one message.
const answering = (reply: HostMessage) => {
  const worker = Object.assign(new EventTarget(), {
    terminated: false,
    postMessage(_init: HostInit) {
      queueMicrotask(() => worker.dispatchEvent(Object.assign(new Event("message"), { data: reply })));
    },
    terminate() {
      worker.terminated = true;
    },
  });
  return worker;
};

const install = (reply: HostMessage) => {
  const worker = answering(reply);
  const outcome = installModule({
    module: "test",
    hostUrl: new URL("https://example.test/host.js"),
    runtimeUrl: new URL("https://example.test/runtime/ibus-runtime.js"),
    manifestUrl: new URL("https://example.test/test/manifest.json"),
    engines: [],
    worker: () => worker as unknown as Worker,
    progress: () => {},
  });
  return { worker, outcome };
};

it("an install-only host that refuses for an ABI or protocol mismatch rejects with the error for it", async () => {
  for (const [refused, error] of [
    ["RuntimeAbiMismatch", RuntimeAbiMismatch],
    ["ModuleAbiMismatch", ModuleAbiMismatch],
    ["ProtocolMismatch", ProtocolMismatch],
  ] as const) {
    const { worker, outcome } = install({ type: "error", message: `${refused}: 2, 1`, refused });
    const failed = await outcome.catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(error);
    expect(failed).toMatchObject({ module: "test", diagnostic: `${refused}: 2, 1` });
    expect(worker.terminated, "the Worker ends").toBe(true);
  }
});

it("an install-only host that fails otherwise rejects as the module's load failing", async () => {
  const failed = await install({ type: "error", message: "boom" }).outcome.catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(EngineLoadFailed);
});
