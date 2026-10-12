// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { expect, test } from "vitest";
import { sharedWindow, type DataStore } from "../../src/worker/install/store.ts";
import { RuntimeRefused } from "../../src/worker/runtime.ts";

// A store that records how its window was set, and a window over it.
const recorded = () => {
  const set: boolean[] = [];
  const heard: boolean[] = [];
  const store = { setWritable: (writable: boolean) => set.push(writable) } as unknown as DataStore;
  return { set, heard, window: sharedWindow(store, (open) => heard.push(open)) };
};

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

test("overlapping installs open the window once and shut it after the last ends", async () => {
  const { set, heard, window } = recorded();
  const first = gate();
  const second = gate();
  const installs = [window(() => first.opened), window(() => second.opened)];
  expect(set).toEqual([true]);
  first.open();
  await installs[0];
  expect(set, "one install still running").toEqual([true]);
  second.open();
  await installs[1];
  expect(set).toEqual([true, false]);
  expect(heard).toEqual([true, false]);
});

test("installs one after another open and shut it each time", async () => {
  const { set, window } = recorded();
  await window(async () => {});
  await window(async () => {});
  expect(set).toEqual([true, false, true, false]);
});

test("an install the runtime refused shuts it; one that threw from inside the runtime leaves it alone", async () => {
  const refused = recorded();
  await expect(
    refused.window(async () => {
      throw new RuntimeRefused("refused");
    }),
  ).rejects.toThrow("refused");
  expect(refused.set).toEqual([true, false]);

  const trapped = recorded();
  await expect(
    trapped.window(async () => {
      throw new WebAssembly.RuntimeError("unreachable");
    }),
  ).rejects.toThrow("unreachable");
  expect(trapped.set).toEqual([true]);
});
