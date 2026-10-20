// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterAll, describe, test } from "vitest";
import { browserHarness } from "./harness.ts";
import {
  jsModuleBesideWasm,
  jsModuleFault,
  jsModuleHang,
  jsModuleKeys,
  jsModuleMissingScript,
  jsModulePropertyActivated,
  jsModuleSettingChange,
} from "./js-module.ts";

const h = await browserHarness();
afterAll(() => h.cleanUp());
describe.each(h.data.runtimes)("JavaScript module on $name", (runtime) => {
  test("keys on each engine", () => jsModuleKeys(h, runtime));
  test("a setting changed by the page", () => jsModuleSettingChange(h, runtime));
  test("a property activated", () => jsModulePropertyActivated(h, runtime));
  test("a fault crashes the host with its text", () => jsModuleFault(h, runtime));
  test("a handler that never returns leaves the request unanswered", () => jsModuleHang(h, runtime));
  test("beside a WebAssembly module in its own Worker", () => jsModuleBesideWasm(h, runtime));
  test("a script that fails to fetch fails the start with a TypeError", () => jsModuleMissingScript(h, runtime));
});
