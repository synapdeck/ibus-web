// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.argv[2]!;
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (!JSON.parse(input).steps) process.exit(2);
if (mode === "malformed") process.stdout.write("not json\n");
if (mode === "split-unicode") {
  const bytes = Buffer.from(`${JSON.stringify({ kind: "reply", step: 0, value: "안녕" })}\n`);
  const split = bytes.indexOf(Buffer.from("안")) + 1;
  process.stdout.write(bytes.subarray(0, split));
  await new Promise((resolve) => setTimeout(resolve, 30));
  process.stdout.write(bytes.subarray(split));
}
if (mode.startsWith("partial-")) process.stdout.write(`${JSON.stringify({ kind: "reply", step: 0, value: true })}\n`);
if (mode === "partial-malformed") process.stdout.write("not json\n");
if (mode === "reply")
  process.stdout.write(`${JSON.stringify({ kind: "reply", step: 0, value: { signature: "s", text: "'안녕'" } })}\n`);
if (mode === "error") process.stdout.write(`${JSON.stringify({ kind: "error", step: 0, message: "intentional" })}\n`);
if (mode === "escaped-pipe") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  process.stdout.write(`${JSON.stringify({ kind: "reply", step: 0, value: true })}\n`);
  process.stderr.write("before interruption\n");
  writeFileSync(process.argv[3]!, String(child.pid));
  child.unref();
}
if (mode === "child" || mode === "child-exit") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(process.argv[3]!, String(child.pid));
  if (mode === "child-exit") process.exit(0);
}
if (mode === "exit") process.exitCode = 7;
if (mode === "exit" || mode === "error") process.stderr.write("diagnostic\n");
if (mode === "hang" || mode === "child" || mode === "partial-timeout") setInterval(() => {}, 1000);
