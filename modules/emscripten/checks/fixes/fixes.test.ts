// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The fixes whose evidence lies outside what a program reports on itself:
// the status a program exits with, a memory its module refuses, and the
// output a reader that falls behind receives.

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

describe("Patch0020", () => {
  const stallMs = 500;

  // What stdio-burst writes.
  const expected = (() => {
    const longLine = Array.from({ length: 256 * 1024 - 1 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const lines = Array.from({ length: 2048 }, (_, i) => `${String(i).padStart(4, "0")}${"x".repeat(507)}\n`);
    return `${longLine}\n${lines.join("")}end\n`;
  })();

  // Everything the program writes to each stream, and its status. Neither
  // stream is read for stallMs, so the pipe fills while the program writes.
  const burst = (
    program: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string; status: number | null }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [program, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: exitTimeoutMs,
        killSignal: "SIGKILL",
      });
      const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      const ended = Promise.all(
        (["stdout", "stderr"] as const).map(
          (name) =>
            new Promise<void>((done) => {
              setTimeout(() => child[name].on("data", (chunk: Buffer) => chunks[name].push(chunk)), stallMs);
              child[name].once("end", done);
            }),
        ),
      );

      child.once("error", reject);
      child.once("close", (status) => {
        void ended.then(() =>
          resolve({
            stdout: Buffer.concat(chunks.stdout).toString(),
            stderr: Buffer.concat(chunks.stderr).toString(),
            status,
          }),
        );
      });
    });

  // The program's own file system: Emscripten's JavaScript one, WasmFS, or
  // NODERAWFS, whose writes reach the descriptor without going through out().
  const programs = ["stdioBurstJsfs", "stdioBurstWasmfs", "stdioBurstNoderawfs"];
  const cases = programs.flatMap((program) =>
    (["stdout", "stderr"] as const).flatMap((stream) =>
      (["main", "thread"] as const).map((thread) => ({ program, stream, thread })),
    ),
  );

  test.for(cases)(
    "WritesWaitForTheReader $program $stream $thread",
    { timeout: exitTimeoutMs + 10_000 },
    async ({ program, stream, thread }) => {
      const result = await burst(data(program), [stream, thread]);
      const other = stream === "stdout" ? "stderr" : "stdout";
      expect(result.status, result[other]).toBe(0);
      expect(result[other]).toBe("");
      expect(result[stream].length).toBe(expected.length);
      expect(result[stream] === expected).toBe(true);
    },
  );
});
