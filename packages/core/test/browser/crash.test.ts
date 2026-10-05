// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { data, runHost } from "./real-host.ts";

describe.each(data.runtimes)("synthetic DOM recovery through $name host", (runtime) => {
  test("fault falls back once and the unchanged engine commits after restart and refocus", () =>
    runHost(runtime, "recoverable", async (h) => {
      const field = h.field();
      await h.focus(field);
      const context = h.contexts.get(field.element)!;
      const generation = context.generation;
      const firstConnection = h.connections[0];
      const crashed = h.nextCrash();
      const faultKey = h.dispatch(field, "!", "Digit1");
      const crash = await crashed;
      expect(["host", "fault"]).toContain(crash.reason);
      if (crash.reason === "host") expect(crash.message).toBe("Worker control state is CRASHED");
      else expect(crash.message).toBe("ibusweb_dispatch returned -ECANCELED");
      expect(h.registry.snapshot("selected-engine")!.generation).toBe(generation + 1);
      await h.registry.drainContext("selected-engine", context);
      expect(field.element.value).toBe("!");
      // The negative reply precedes the terminal fault: either native passthrough
      // or accepted-key replay owns insertion, depending on which the page sees first.
      expect(field.inputs).toEqual([
        {
          value: "!",
          data: "!",
          source: faultKey.defaultPrevented ? "adapter" : "default",
        },
      ]);
      expect(h.records.filter(({ record }) => record._tag === "CommitText")).toEqual([]);
      await Effect.runPromise(h.registry.whenReady("selected-engine"));
      expect(h.connections).toHaveLength(2);
      expect(h.connections[1]).not.toBe(firstConnection);
      // Contexts recreate on a real focus transition after registry restart.
      field.element.blur();
      await h.settle();
      await h.focus(field);
      expect(context.generation).toBe(generation + 1);
      const recovered = await h.press(field, "a");
      expect(recovered.defaultPrevented).toBe(true);
      expect(field.element.value).toBe("!a");
      expect(h.records.filter(({ record }) => record._tag === "CommitText")).toMatchObject([
        { record: { text: { text: "a" } } },
      ]);
      expect(
        h.requests.filter(({ request }) => request._tag === "CreateEngine").map(({ generation }) => generation),
      ).toEqual([generation, generation + 1]);
      expect(h.crashes).toHaveLength(1);
      console.log(
        `Recovery ${runtime.name}: ${JSON.stringify({
          terminal: crash.reason,
          faultInsertion: field.inputs[0]!.source,
          generation: context.generation,
          connections: h.connections.length,
          recoveredCommit: "a",
          faultWarnings: h.logs.filter((line) => line.record.level & 16).length,
          lifecycleWarnings: h.lifecycleWarnings,
        })}`,
      );
    }));
});
