// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { DestroyEngine, encodeRequest } from "@ibus-web/protocol";
import { EngineScopes } from "../../src/worker/scopes.ts";
import type { Runtime } from "../../src/worker/runtime.ts";

test("scopes destroy only live input contexts, synchronously and once", () => {
  const calls: Uint8Array[] = [];
  const bytes = new Uint8Array(128);
  const rt = {
    HEAPU8: bytes,
    _ibusweb_dispatch: (ptr: number, length: number) => {
      calls.push(bytes.slice(ptr, ptr + length));
      return 0;
    },
  } as Runtime;
  const scopes = new EngineScopes(8, -11);
  scopes.opened(1);
  scopes.closed(1);
  scopes.opened(2);
  scopes.opened(3);
  scopes.closeAll(rt, true);
  expect(calls).toEqual([encodeRequest(2, new DestroyEngine({})), encodeRequest(3, new DestroyEngine({}))]);
  scopes.closeAll(rt, true);
  expect(calls).toHaveLength(2);
});

test("a damaged runtime is never entered when instance scopes close", () => {
  const rt = {
    _ibusweb_dispatch: () => {
      throw new Error("unexpected runtime call");
    },
  } as unknown as Runtime;
  const scopes = new EngineScopes(0, -11);
  scopes.opened(1);
  expect(() => scopes.closeAll(rt, false)).not.toThrow();
  expect(() => scopes.closeAll(rt, true)).not.toThrow();
});

test.each(["fault", "trap"])("a %s during cleanup prevents later destroys and storage cleanup", async (failure) => {
  const { Effect, Exit } = await import("effect");
  const { runtimeFinalizer, runtimeIntact } = await import("../../src/worker/failure.ts");
  const calls: string[] = [];
  const rt = {
    HEAPU8: new Uint8Array(128),
    _ibusweb_dispatch: () => {
      calls.push("destroy");
      if (failure === "trap") throw new WebAssembly.RuntimeError("unreachable");
      return -11;
    },
  } as unknown as Runtime;
  const scopes = new EngineScopes(8, -11);
  scopes.opened(1);
  scopes.opened(2);
  const exit = await Effect.runPromise(
    Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runtimeFinalizer(
            Effect.sync(() => {
              calls.push("seal");
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => scopes.closeAll(rt, true)));
            }),
          );
        }),
      ),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(runtimeIntact(exit)).toBe(false);
  expect(calls).toEqual(["destroy"]);
});
