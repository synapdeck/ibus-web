// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closureLinkProblems } from "./symlinks.ts";

let store: string;
// Two store paths in the closure, and one beside them that isn't.
let a: string;
let b: string;
let outside: string;

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), "ibus-web-closure-links-"));
  a = join(store, "aaaa-a");
  b = join(store, "bbbb-b");
  outside = join(store, "cccc-outside");
  for (const dir of [a, b, outside]) {
    mkdirSync(join(dir, "share"), { recursive: true });
    writeFileSync(join(dir, "share", "file.txt"), dir);
  }
});

afterEach(() => rmSync(store, { recursive: true, force: true }));

const problems = (): string[] => closureLinkProblems([a, b]);

describe("links in a closure", () => {
  it("accepts links that resolve inside it, relative, absolute and chained", () => {
    symlinkSync("file.txt", join(a, "share", "relative"));
    symlinkSync(join(b, "share", "file.txt"), join(a, "share", "absolute"));
    symlinkSync("absolute", join(a, "share", "chained"));
    symlinkSync(join(b, "share"), join(a, "dir"));
    symlinkSync("../dir/file.txt", join(a, "share", "through-dir"));
    symlinkSync(`../../${"bbbb-b"}/share`, join(a, "share", "sibling"));
    expect(problems()).toEqual([]);
  });

  it("accepts a store path that is itself a link into the closure", () => {
    const link = join(store, "dddd-link");
    symlinkSync(join(a, "share", "file.txt"), link);
    expect(closureLinkProblems([a, link])).toEqual([]);
  });

  it("refuses a link that dangles", () => {
    symlinkSync("missing.txt", join(a, "share", "dangling"));
    expect(problems()).toEqual([expect.stringContaining(`${join(a, "share", "dangling")} -> missing.txt`)]);
  });

  it("refuses a link out of the closure, absolute or relative", () => {
    symlinkSync(join(outside, "share", "file.txt"), join(a, "absolute"));
    symlinkSync("../cccc-outside/share/file.txt", join(a, "relative"));
    expect(problems()).toHaveLength(2);
  });

  it("refuses a chain that passes outside the closure on its way back in", () => {
    symlinkSync(join(a, "share", "file.txt"), join(outside, "back"));
    symlinkSync(join(outside, "back"), join(a, "detour"));
    expect(problems()).toEqual([expect.stringContaining(join(a, "detour"))]);
  });

  it("refuses a link to a directory that only holds the closure", () => {
    symlinkSync(store, join(a, "store"));
    symlinkSync("/", join(b, "root"));
    expect(problems()).toHaveLength(2);
  });

  it("refuses a loop", () => {
    symlinkSync("two", join(a, "one"));
    symlinkSync("one", join(a, "two"));
    expect(problems()).toHaveLength(2);
  });

  it("fails the command for a closure with a bad link, naming it", () => {
    const paths = join(store, "store-paths");
    writeFileSync(paths, `${a}\n${b}\n`);
    const run = () =>
      execFileSync(process.execPath, [new URL("./symlinks.ts", import.meta.url).pathname, paths, b], {
        encoding: "utf8",
        stdio: "pipe",
      });
    expect(run()).toBe("");
    // b is the package itself, excluded from the closure the data holds.
    symlinkSync(join(b, "share", "file.txt"), join(a, "into-package"));
    expect(run).toThrow(join(a, "into-package"));
  });
});
