// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateRecord, validateTrace } from "./trace.ts";
import type { RunOptions, RunResult, Trace } from "./types.ts";

export type AdapterFailureReason = "protocol" | "spawn" | "timeout" | "aborted" | "output-limit";

export class AdapterRunError extends Error {
  readonly reason: AdapterFailureReason;
  readonly artifactDir: string;
  readonly result: RunResult;

  constructor(
    reason: AdapterFailureReason,
    artifactDir: string,
    result: RunResult,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AdapterRunError";
    this.reason = reason;
    this.artifactDir = artifactDir;
    this.result = result;
  }
}

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export async function runAdapter(command: readonly string[], trace: Trace, options: RunOptions): Promise<RunResult> {
  validateTrace(trace);
  if (command.length === 0 || command.some((part) => !part || typeof part !== "string"))
    throw new TypeError("adapter command must be a nonempty argv array");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2 ** 31 - 1)
    throw new TypeError("adapter timeoutMs must be a positive 32-bit integer");
  mkdirSync(options.artifactDir, { recursive: true });
  writeFileSync(join(options.artifactDir, "trace.json"), `${JSON.stringify(trace)}\n`);

  return new Promise<RunResult>((resolve, reject) => {
    const output = { chunks: [] as Buffer[], bytes: 0 };
    const diagnostics = { chunks: [] as Buffer[], bytes: 0 };
    let failure: AdapterFailureReason | undefined;
    let spawnError: Error | undefined;
    let finished = false;
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: true,
    });

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const interrupt = (reason: AdapterFailureReason) => {
      if (finished || failure) return;
      failure = reason;
      killGroup("SIGKILL");
    };
    const deadline = setTimeout(() => interrupt("timeout"), options.timeoutMs);
    const onAbort = () => interrupt("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const collect = (target: typeof output, chunk: Buffer) => {
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - target.bytes);
      if (remaining) target.chunks.push(chunk.subarray(0, remaining));
      target.bytes += chunk.length;
      if (target.bytes > MAX_OUTPUT_BYTES) interrupt("output-limit");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(output, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(diagnostics, chunk));
    // The adapter owns this process group, including children left after its exit.
    child.on("exit", () => killGroup("SIGKILL"));
    child.on("error", (error) => {
      spawnError = error;
      interrupt("spawn");
    });
    child.stdin.on("error", () => {
      /* The exit status explains an early adapter exit. */
    });
    child.stdin.end(`${JSON.stringify(trace)}\n`);

    child.on("close", (exitCode, signal) => {
      finished = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onAbort);
      const stdoutBytes = Buffer.concat(output.chunks);
      const stderrBytes = Buffer.concat(diagnostics.chunks);
      const stdout = stdoutBytes.toString("utf8");
      const stderr = stderrBytes.toString("utf8");
      try {
        writeFileSync(join(options.artifactDir, "transcript.jsonl"), stdoutBytes);
        writeFileSync(join(options.artifactDir, "stderr.txt"), stderrBytes);
      } catch (error) {
        reject(error);
        return;
      }
      const result: RunResult = {
        records: [],
        exitCode,
        signal,
        stderr,
        rawTranscript: stdout,
        artifactDir: options.artifactDir,
      };
      let protocolError: unknown;
      try {
        const lines = stdout.split("\n");
        for (const [i, line] of lines.entries()) {
          if (i === lines.length - 1 && line === "") continue;
          if (line === "") throw new TypeError(`empty adapter record at line ${i + 1}`);
          result.records.push(validateRecord(JSON.parse(line), trace.steps.length));
        }
      } catch (error) {
        protocolError = error;
      }
      if (failure)
        reject(
          new AdapterRunError(
            failure,
            options.artifactDir,
            result,
            `adapter ${failure}`,
            spawnError ? { cause: spawnError } : undefined,
          ),
        );
      else if (protocolError)
        reject(
          new AdapterRunError(
            "protocol",
            options.artifactDir,
            result,
            `malformed adapter output: ${String(protocolError)}`,
            { cause: protocolError },
          ),
        );
      else resolve(result);
    });
  });
}
