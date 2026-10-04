// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dylinkMemorySize } from "./dylink.ts";

describe("dylink.0 memory", () => {
  it("rejects a module without the section", () => {
    expect(() => dylinkMemorySize(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0))).toThrow(/dylink.0/);
  });
  it("agrees with wasm-objdump on the compiled side module", () => {
    const fixture = process.env.IBUS_WEB_DYLINK_FIXTURE;
    if (!fixture) throw new Error("IBUS_WEB_DYLINK_FIXTURE is required");
    const dump = execFileSync("wasm-objdump", ["-x", "--section=dylink.0", fixture], { encoding: "utf8" });
    const match = /^\s*- mem_size\s*:\s*(\d+)\s*$/m.exec(dump);
    expect(match, dump).not.toBeNull();
    expect(dylinkMemorySize(readFileSync(fixture))).toBe(Number(match![1]));
    expect(
      execFileSync(process.execPath, [new URL("./dylink.ts", import.meta.url).pathname, fixture], {
        encoding: "utf8",
      }).trim(),
    ).toBe(match![1]);
  });
});
