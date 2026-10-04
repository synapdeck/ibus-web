// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { defaultHostConfig } from "../../src/worker/config.ts";
import { Instruments } from "../../src/worker/instruments.ts";
import { provideData } from "../../src/worker/install/provide.ts";
import * as archives from "../../src/worker/install/archive.ts";
import * as stores from "../../src/worker/install/store.ts";
import * as mounts from "../../src/worker/storage/mount.ts";
import { Held } from "../../src/worker/storage/held.ts";
import type { RuntimeHandle } from "../../src/worker/runtime.ts";
import { engineInstallLock } from "../../src/shared/naming.ts";
import type { EngineManifest } from "../../src/shared/messages.ts";

const gate = () => {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    wait: () => {
      entered();
      return pending;
    },
  };
};

afterEach(() => vi.restoreAllMocks());

describe("install lock lifetime", () => {
  it.effect("announces throughout clear, mount, fetch, marker and seal, then releases the lock and timer", () =>
    Effect.gen(function* () {
      // Only storage/runtime work is replaced: the install orchestration,
      // Web Locks, channel and Effect timer remain the production code.
      const clearing = gate();
      const fetching = gate();
      const marking = gate();
      const collected = gate();
      const engine: EngineManifest = {
        name: `progress-${crypto.randomUUID()}`,
        version: "1",
        license: "MIT",
        runtimeAbi: 1,
        protocol: 1,
        module: { url: "unused", size: 0 },
        memory: 1,
        threads: 0,
        data: [],
        settingsSchemaDir: "unused",
        engines: [],
        settingsSchemas: [],
      };
      const held = new Held();
      yield* Effect.addFinalizer(() => Effect.sync(() => held.releaseAll()));
      const sent = vi.spyOn(BroadcastChannel.prototype, "postMessage");
      const closed = vi.spyOn(BroadcastChannel.prototype, "close");
      const released = vi.spyOn(held, "release");
      const activeDuringRuntimeCalls: boolean[] = [];
      const active = () => {
        activeDuringRuntimeCalls.push(
          sent.mock.calls.length > 0 && closed.mock.calls.length === 0 && released.mock.calls.length === 0,
        );
      };
      const store: stores.DataStore = {
        installed: async () => null,
        clear: clearing.wait,
        backend: () => 1,
        mark: marking.wait,
        seal: active,
        others: async () => {
          await collected.wait();
          return [];
        },
        remove: async () => {},
        closed: () => false,
      };
      vi.spyOn(stores, "nodeStore").mockResolvedValue(store);
      vi.spyOn(mounts, "makeDirs").mockImplementation(active);
      vi.spyOn(mounts, "mountAt").mockImplementation(active);
      vi.spyOn(archives, "installArchives").mockImplementation(async () => {
        await fetching.wait();
        return { fed: 1, files: 1, bytes: 1 };
      });
      const installing = yield* provideData({
        handle: {} as RuntimeHandle,
        engine,
        plan: { mount: "node", hostPath: "unused", readOnly: false },
        idbReadOnly: 1,
        held,
        config: { ...defaultHostConfig, progressIntervalMs: 50 },
        instruments: yield* Instruments,
        post: () => {},
      }).pipe(Effect.forkScoped);
      for (const phase of [clearing, fetching, marking]) {
        yield* Effect.promise(() => phase.reached);
        const before = sent.mock.calls.length;
        yield* TestClock.adjust(150);
        expect(sent.mock.calls.length - before).toBe(3);
        expect(
          (yield* Effect.promise(() => navigator.locks.query())).held?.some(
            (lock) => lock.name === engineInstallLock(engine),
          ),
        ).toBe(true);
        phase.release();
      }
      // Collection is outside the install lock; a delayed collection must
      // not keep the channel alive or make the next installer wait.
      yield* Effect.promise(() => collected.reached);
      expect(activeDuringRuntimeCalls).toEqual([true, true, true]);
      expect(released).toHaveBeenCalledTimes(1);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(
        (yield* Effect.promise(() => navigator.locks.query())).held?.some(
          (lock) => lock.name === engineInstallLock(engine),
        ),
      ).toBe(false);
      const count = sent.mock.calls.length;
      yield* TestClock.adjust(500);
      expect(sent).toHaveBeenCalledTimes(count);
      collected.release();
      yield* Fiber.join(installing);
    }),
  );
});
