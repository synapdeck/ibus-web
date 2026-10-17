// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Effect, Fiber, Stream } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { engineDatabase } from "@ibus-web/worker-host";
import type { ModuleEvent } from "../../src/services/modules.ts";
import { data, runHost } from "./real-host.ts";

const settled = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

// Each module's databases go with the test that made them, so that the next
// starts on none.
afterEach(async () => {
  for (const { name } of await indexedDB.databases())
    if (name?.startsWith("ibus-web/")) await settled(indexedDB.deleteDatabase(name));
});

describe.each(data.runtimes)("storage through $name host", (runtime) => {
  test("a version change while the module idles is reported at once, with no request to wake its host", () =>
    runHost(
      runtime,
      "hangul",
      async (h) => {
        const events: Extract<ModuleEvent, { _tag: "storage" }>[] = [];
        const watching = Effect.runFork(
          h.registry.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event._tag === "storage") events.push(event);
              }),
            ),
          ),
        );
        try {
          const field = h.field();
          await h.focus(field);
          const requests = h.requests.length;
          const name = engineDatabase(h.registry.snapshot("selected-engine")!.manifest!);
          const current = await settled(indexedDB.open(name));
          const { version } = current;
          current.close();
          (await settled(indexedDB.open(name, version + 1))).close();

          const deadline = performance.now() + 5000;
          while (events.length === 0 && performance.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
          expect(events).toEqual([
            {
              _tag: "storage",
              module: "selected-engine",
              state: "closed",
              message: "the IndexedDB connection closed; the engine's storage fails with EIO",
            },
          ]);
          expect(h.requests.slice(requests), "requests since the change").toEqual([]);
        } finally {
          await Effect.runPromise(Fiber.interrupt(watching));
        }
      },
      "browser",
    ));
});
