// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Usage: node run.js --program DIR... [--timeout SECONDS]
//                    [--browser chromium|firefox]...
//
// Runs Emscripten-built test programs in headless Chromium and Firefox. Each
// DIR holds programs as NAME.js and NAME.wasm, linked with -sMODULARIZE
// -sEXPORT_ES6 -sENVIRONMENT=worker -sEXIT_RUNTIME=1, and optionally
// NAME.args, the program's arguments one per line. A page served with
// cross-origin isolation runs each program in a dedicated Worker of its own
// and collects its output until it exits.
//
// Each program runs in a fresh browser context, so its origin's storage
// starts empty, except that programs named PREFIX.1, PREFIX.2 and so on run
// in that order in one context, each from a fresh page, so a later one sees
// what an earlier one stored. If one of them fails, the later ones don't
// run. A program has SECONDS (default 120) to exit in each browser.
//
// Prints each program's output per browser, then a table of results. Exits
// 1 unless every program exits 0 in every browser.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Browser } from "playwright";
import type { ProgramReport, ProgramSpec } from "../shared/protocol.ts";
import { browsersNamed, launch, launchError } from "./browsers.ts";
import { serve } from "./server.ts";

const { values: args } = parseArgs({
  options: {
    program: { type: "string", multiple: true },
    timeout: { type: "string", default: "120" },
    browser: { type: "string", multiple: true },
  },
});
if (args.program === undefined)
  throw new Error("--program is required, once per directory");
const timeoutMs = Number(args.timeout) * 1000;
if (!(timeoutMs > 0))
  throw new Error(`--timeout must be positive, not ${args.timeout}`);
const browserNames = browsersNamed(args.browser);

interface Program {
  name: string;
  // Its module script's URL path on the server.
  url: string;
  args: string[];
}

const programDirs = args.program;
const programs: Program[] = [];
for (const [index, dir] of programDirs.entries()) {
  const files = new Set(await readdir(dir));
  const names = [...files]
    .filter(
      (file) => file.endsWith(".js") && files.has(`${file.slice(0, -3)}.wasm`),
    )
    .map((file) => file.slice(0, -3))
    .sort();
  if (names.length === 0)
    throw new Error(`${dir}: no NAME.js with a NAME.wasm`);
  for (const name of names) {
    const argsFile = `${name}.args`;
    const programArgs = files.has(argsFile)
      ? (await readFile(join(dir, argsFile), "utf8")).split("\n")
      : [];
    // The file's final newline ends the last argument rather than adding
    // an empty one.
    if (programArgs.at(-1) === "") programArgs.pop();
    programs.push({
      name,
      url: `/programs/${index}/${name}.js`,
      args: programArgs,
    });
  }
}

// Programs that share a browser context, in the order they run.
const sequence = /^(.+)\.([1-9][0-9]*)$/;
const groups = new Map<string, Program[]>();
for (const program of programs) {
  const key = sequence.exec(program.name)?.[1] ?? program.name;
  const group = groups.get(key) ?? [];
  if (group.some(({ name }) => name === program.name))
    throw new Error(`two programs are named ${program.name}`);
  group.push(program);
  groups.set(key, group);
}
for (const [key, group] of groups) {
  if (group.length === 1 && group[0]!.name === key) continue;
  if (group.some(({ name }) => name === key))
    throw new Error(`${key} can't run both on its own and as a sequence`);
  group.sort(
    (a, b) =>
      Number(sequence.exec(a.name)![2]) - Number(sequence.exec(b.name)![2]),
  );
  for (const [index, { name }] of group.entries())
    if (name !== `${key}.${index + 1}`)
      throw new Error(
        `${key}: the sequence must be numbered from 1 without gaps, not ${name}`,
      );
}

const server = await serve(
  fileURLToPath(new URL("../../src/page/index.html", import.meta.url)),
  Object.fromEntries([
    ["/dist/", fileURLToPath(new URL("../", import.meta.url))],
    ...programDirs.map((dir, index) => [`/programs/${index}/`, dir]),
  ]),
);

// The page enforces each program's limit; this one catches a page that
// stops answering.
const evaluateTimeoutMs = timeoutMs + 30_000;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no answer from the page in ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Browser console output goes to stderr; programs' output and results go
// to stdout.
const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

// "exit 0" for a pass; anything else is a failure.
type Status = string;
const results = new Map<string, Map<string, Status>>();
const record = (browser: string, program: string, status: Status): void => {
  const row = results.get(program) ?? new Map<string, Status>();
  row.set(browser, status);
  results.set(program, row);
};

const runGroup = async (
  browserName: string,
  browser: Browser,
  group: Program[],
) => {
  const context = await browser.newContext();
  try {
    for (const [index, program] of group.entries()) {
      const page = await context.newPage();
      page.on("console", (message) =>
        log(
          `[${browserName} ${program.name} console.${message.type()}] ${message.text()}`,
        ),
      );
      page.on("pageerror", (error) =>
        log(`[${browserName} ${program.name} pageerror] ${error.message}`),
      );
      console.log(`== ${browserName}: ${program.name}`);
      let report: ProgramReport;
      try {
        await page.goto(`${server.origin}/`);
        const isolated = await page.evaluate(
          () =>
            (globalThis as { crossOriginIsolated?: boolean })
              .crossOriginIsolated === true,
        );
        if (!isolated) throw new Error("crossOriginIsolated is not true");
        await page.waitForFunction(() => "runProgram" in globalThis);
        const spec: ProgramSpec = {
          url: program.url,
          args: program.args,
          timeoutMs,
        };
        report = await withTimeout(
          page.evaluate(
            (spec) =>
              (
                globalThis as unknown as {
                  runProgram(spec: ProgramSpec): Promise<ProgramReport>;
                }
              ).runProgram(spec),
            spec,
          ),
          evaluateTimeoutMs,
        );
      } catch (error) {
        report = { output: [], exitCode: null, error: describe(error) };
      } finally {
        await page.close();
      }
      for (const { stream, text } of report.output)
        console.log(`${stream === "stdout" ? "out" : "err"}| ${text}`);
      const status =
        report.exitCode === null
          ? `FAIL: ${report.error ?? "no exit"}`
          : `exit ${report.exitCode}`;
      console.log(`-- ${status}`);
      record(browserName, program.name, status);
      if (report.exitCode !== 0) {
        for (const { name } of group.slice(index + 1))
          record(browserName, name, `not run: ${program.name} failed`);
        return;
      }
    }
  } finally {
    await context.close();
  }
};

try {
  for (const name of browserNames) {
    let browser: Browser;
    try {
      browser = await launch(name);
    } catch (error) {
      const message = launchError(error);
      console.log(`== ${name}\nFAIL: ${message}`);
      for (const { name: program } of programs) record(name, program, message);
      continue;
    }
    try {
      for (const group of groups.values()) await runGroup(name, browser, group);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}

console.log("");
console.log(`| Program | ${browserNames.join(" | ")} |`);
console.log(`| --- |${" --- |".repeat(browserNames.length)}`);
let failed = false;
for (const { name } of programs) {
  const row = results.get(name);
  const cells = browserNames.map((browser) => {
    const status = row?.get(browser) ?? "not run";
    if (status !== "exit 0") failed = true;
    // An error's stack stays in the program's own section above.
    return status.split("\n")[0];
  });
  console.log(`| ${name} | ${cells.join(" | ")} |`);
}
process.exit(failed ? 1 : 0);
