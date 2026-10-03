// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { runAdapter } from "./process.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const trace = {
  version: 1 as const,
  settings: [],
  steps: [
    { op: "create" as const, context: "a", engine: "e" },
    { op: "destroy" as const, context: "a" },
  ],
};
const fixture = fileURLToPath(new URL("adapter-fixture.ts", import.meta.url));
function run(mode: string, extra: string[] = [], options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const artifactDir = mkdtempSync(join(tmpdir(), "ibus-test-process-"));
  dirs.push(artifactDir);
  return {
    promise: runAdapter([process.execPath, fixture, mode, ...extra], trace, {
      artifactDir,
      timeoutMs: options.timeoutMs ?? 2000,
      signal: options.signal,
    }),
    artifactDir,
  };
}

test("writes one trace and retains Unicode reply and raw artifacts", async () => {
  const { promise, artifactDir } = run("reply");
  const result = await promise;
  expect(result.records).toEqual([{ kind: "reply", step: 0, value: { signature: "s", text: "'안녕'" } }]);
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(artifactDir, "trace.json"), "utf8")).toContain('"context":"a"');
  expect(readFileSync(join(artifactDir, "transcript.jsonl"), "utf8")).toContain("안녕");
});

test("returns valid adapter errors and nonzero exit with stderr", async () => {
  const { promise: error } = run("error");
  expect((await error).records).toEqual([{ kind: "error", step: 0, message: "intentional" }]);
  const { promise: exit } = run("exit");
  expect(await exit).toMatchObject({ exitCode: 7, stderr: "diagnostic\n" });
});

test("rejects malformed adapter output with diagnostic artifacts", async () => {
  const { promise, artifactDir } = run("malformed");
  await expect(promise).rejects.toMatchObject({ reason: "protocol", artifactDir });
  expect(readFileSync(join(artifactDir, "transcript.jsonl"), "utf8")).toBe("not json\n");
});

test("preserves UTF-8 split across pipe chunks", async () => {
  const { promise } = run("split-unicode");
  expect((await promise).records).toEqual([{ kind: "reply", step: 0, value: "안녕" }]);
});

test.each(["partial-malformed", "partial-timeout"])("retains parsed records on %s", async (mode) => {
  const { promise } = run(mode, [], { timeoutMs: 300 });
  await expect(promise).rejects.toMatchObject({
    reason: mode === "partial-malformed" ? "protocol" : "timeout",
    result: { records: [{ kind: "reply", step: 0, value: true }] },
  });
});

test.each(["child", "child-exit", "child-abort"])("cleans up a spawned grandchild on %s", async (mode) => {
  const dir = mkdtempSync(join(tmpdir(), "ibus-test-child-"));
  dirs.push(dir);
  const pidFile = join(dir, "pid");
  const controller = new AbortController();
  const { promise } = run(mode === "child-abort" ? "child" : mode, [pidFile], {
    timeoutMs: 2000,
    signal: controller.signal,
  });
  const settled =
    mode === "child-exit"
      ? expect(promise).resolves.toMatchObject({ exitCode: 0 })
      : expect(promise).rejects.toMatchObject({ reason: mode === "child-abort" ? "aborted" : "timeout" });
  if (mode === "child-abort") {
    await expect.poll(() => existsSync(pidFile)).toBe(true);
    controller.abort();
  }
  await settled;
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    await expect
      .poll(() => {
        try {
          return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] === "Z";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
          throw error;
        }
      })
      .toBe(true);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      // oxlint-disable-next-line no-unsafe-finally
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
});

test("abort interrupts and cleans up a running process", async () => {
  const controller = new AbortController();
  const { promise } = run("hang", [], { timeoutMs: 2000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await expect(promise).rejects.toMatchObject({ reason: "aborted" });
});

test.each(["timeout", "aborted"])(
  "settles %s while a separately grouped descendant holds the pipes",
  async (reason) => {
    const dir = mkdtempSync(join(tmpdir(), "ibus-test-escaped-"));
    dirs.push(dir);
    const pidFile = join(dir, "pid");
    const controller = new AbortController();
    const { promise, artifactDir } = run("escaped-pipe", [pidFile], {
      timeoutMs: reason === "timeout" ? 300 : 2000,
      signal: controller.signal,
    });
    let outcome: unknown;
    const observed = promise.then(
      (result) => {
        outcome = result;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    try {
      await expect.poll(() => existsSync(pidFile)).toBe(true);
      if (reason === "aborted") controller.abort();
      await expect.poll(() => outcome, { timeout: 1000 }).toBeDefined();
      expect(outcome).toMatchObject({
        reason,
        artifactDir,
        result: {
          records: [{ kind: "reply", step: 0, value: true }],
          stderr: "before interruption\n",
        },
      });
      expect(readFileSync(join(artifactDir, "transcript.jsonl"), "utf8")).toBe(
        `${JSON.stringify({ kind: "reply", step: 0, value: true })}\n`,
      );
      expect(readFileSync(join(artifactDir, "stderr.txt"), "utf8")).toBe("before interruption\n");
      // Settlement must precede this independently owned process's cleanup.
      expect(() => process.kill(-Number(readFileSync(pidFile, "utf8")), 0)).not.toThrow();
    } finally {
      if (existsSync(pidFile)) process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      await observed;
    }
  },
);
