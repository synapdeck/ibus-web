// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The host's set of locks, with locks that only record their release: the
// writer lock goes with the rest only once nothing can write through the
// host's user backend.

import { describe, expect, test } from "vitest";
import { Held, type HeldLock } from "../../src/worker/storage/held.ts";

const fakeLocks = (...names: string[]): { locks: HeldLock[]; released: string[] } => {
  const released: string[] = [];
  return { locks: names.map((name) => ({ name, release: () => released.push(name) })), released };
};

describe("Held", () => {
  test("lets go of every lock when no backend needs sealing", () => {
    const held = new Held();
    const { locks, released } = fakeLocks("writer", "data");
    held.addWriter(locks[0]!);
    held.add(locks[1]!);
    held.releaseAll();
    expect(released.sort()).toEqual(["data", "writer"]);
  });

  test("lets go of the writer lock once the seal has run", () => {
    const held = new Held();
    const { locks, released } = fakeLocks("writer", "data");
    let sealed = 0;
    held.addWriter(locks[0]!);
    held.add(locks[1]!);
    held.sealWith(() => sealed++);
    held.seal();
    held.seal();
    held.releaseAll();
    expect(sealed, "seals").toBe(1);
    expect(released.sort()).toEqual(["data", "writer"]);
  });

  test("keeps the writer lock, and lets go of the rest, when the seal throws", () => {
    const held = new Held();
    const { locks, released } = fakeLocks("writer", "data", "install");
    held.addWriter(locks[0]!);
    held.add(locks[1]!);
    held.add(locks[2]!);
    held.sealWith(() => {
      throw new Error("the seal fails");
    });
    expect(() => held.seal()).toThrow("the seal fails");
    held.releaseAll();
    expect(released.sort()).toEqual(["data", "install"]);
  });

  test("keeps the writer lock, and lets go of the rest, when the seal never runs", () => {
    const held = new Held();
    const { locks, released } = fakeLocks("writer", "data");
    held.addWriter(locks[0]!);
    held.add(locks[1]!);
    held.sealWith(() => {});
    held.releaseAll();
    expect(released).toEqual(["data"]);
  });

  test("lets go of a lock on its own", () => {
    const held = new Held();
    const { locks, released } = fakeLocks("install", "data");
    held.add(locks[0]!);
    held.add(locks[1]!);
    held.release(locks[0]!);
    held.releaseAll();
    expect(released).toEqual(["install", "data"]);
  });
});
