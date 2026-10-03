// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The fixes whose evidence lies outside what a program reports on itself:
// the status a program exits with, and a memory its module refuses.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { nodeTestData as data } from "@ibus-web/test-programs/node-tests";
import { describe, expect, test } from "vitest";

const exitTimeoutMs = 110_000;

// The status the program exits with, or null if it is killed: after
// exitTimeoutMs, for one that hangs.
const exitStatus = (args: readonly string[]): Promise<number | null> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", timeout: exitTimeoutMs, killSignal: "SIGKILL" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });

describe("Patch0014", () => {
  // An exit() that reaches the main thread while dlopen() syncs threads
  // ends the program with its own status, even with a thread's cleanup
  // pending.
  test("ExitDuringSyncKeepsStatus", { timeout: exitTimeoutMs + 10_000 }, async () => {
    expect(await exitStatus([data("dlsyncExit"), data("dlsyncSide")])).toBe(42);
  });
});

describe("Patch0016", () => {
  const MiB = 1024 * 1024;
  const pageSize = 64 * 1024;
  const maximumMiB = Number(data("importedMemoryMaximumMiB"));

  // Every import a stand-in, and the memory a shared one of the given size.
  const instantiate = async (mib: number): Promise<WebAssembly.Instance> => {
    const module = await WebAssembly.compile(await readFile(data("importedMemoryWasm")));
    const pages = (mib * MiB) / pageSize;
    const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
    for (const { module: name, name: field, kind } of WebAssembly.Module.imports(module)) {
      let value: WebAssembly.ImportValue;
      if (kind === "memory") value = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
      else if (kind === "function") value = () => {};
      else throw new Error(`no stand-in for ${name}.${field}, a ${kind}`);
      (imports[name] ??= {})[field] = value;
    }
    return WebAssembly.instantiate(module, imports);
  };

  test("MaximumMemoryIsTaken", async () => {
    await expect(instantiate(maximumMiB)).resolves.toBeInstanceOf(WebAssembly.Instance);
  });

  test("MemoryAboveMaximumIsRefused", async () => {
    await expect(instantiate(maximumMiB + 16)).rejects.toThrow(WebAssembly.LinkError);
  });
});
