// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { describe, expect, test } from "vitest";
import { data, runHost } from "./real-host.ts";

describe.each(data.runtimes)("synthetic DOM Hangul through $name host", (runtime) => {
  test("Hangul toggle and US keys compose 한글, with input only for committed text", () =>
    runHost(runtime, "hangul", async (h) => {
      const field = h.field();
      await h.focus(field);
      expect((await h.press(field, "HangulMode", "Lang1")).defaultPrevented).toBe(true);
      for (const key of "gks") expect((await h.press(field, key)).defaultPrevented).toBe(true);
      expect(field.preedits.at(-1)?.text).toBe("한");
      expect(field.element.value).toBe("");
      expect(field.inputs).toEqual([]);
      for (const key of "rmf") await h.press(field, key);
      expect(field.element.value).toBe("한");
      expect(field.preedits.at(-1)?.text).toBe("글");
      expect(field.inputs).toEqual([{ value: "한", data: "한", source: "adapter" }]);
      await h.press(field, " ", "Space");
      expect(field.element.value).toBe("한글 ");
      expect(field.inputs.filter((input) => input.source === "adapter").map((input) => input.data)).toEqual([
        "한",
        "글",
      ]);
      expect(
        h.records
          .filter(({ record }) => record._tag === "CommitText")
          .map(({ record }) => record._tag === "CommitText" && record.text.text),
      ).toEqual(["한", "글"]);
      expect(field.preedits.at(-1)).toBeUndefined();
      expect(h.requests.find(({ request }) => request._tag === "CreateEngine")?.request).toMatchObject({
        name: "hangul",
      });
    }));
  test("blur commits the client-owned COMMIT preedit exactly once", () =>
    runHost(runtime, "hangul", async (h) => {
      const field = h.field();
      await h.focus(field);
      await h.press(field, "HangulMode", "Lang1");
      for (const key of "gks") await h.press(field, key);
      expect(field.element.value).toBe("");
      field.element.blur();
      await h.settle();
      expect(field.element.value).toBe("한");
      expect(field.inputs).toEqual([{ value: "한", data: "한", source: "adapter" }]);
      expect(field.preedits.at(-1)).toBeUndefined();
      expect(h.records.filter(({ record }) => record._tag === "CommitText")).toEqual([]);
      expect(h.requests.some(({ request }) => request._tag === "FocusOut")).toBe(true);
    }));
  test("password typing passes Latin through without creating an engine context", () =>
    runHost(runtime, "hangul", async (h) => {
      const field = h.field("password");
      await h.focus(field);
      for (const key of "gksrmf") expect((await h.press(field, key)).defaultPrevented).toBe(false);
      expect(field.element.value).toBe("gksrmf");
      expect(field.inputs.every((input) => input.source === "default")).toBe(true);
      expect(h.contexts.size).toBe(0);
      expect(h.requests).toEqual([]);
      expect(h.records).toEqual([]);
    }));
  test("F9 and a digit replace surrounding 한 with 韓, deleting before committing", () =>
    runHost(runtime, "hangul", async (h) => {
      const field = h.field();
      await h.focus(field);
      await h.press(field, "HangulMode", "Lang1");
      for (const key of "gks") await h.press(field, key);
      field.element.blur();
      await h.settle();
      await h.focus(field);
      expect(field.element.value).toBe("한");
      await h.press(field, "F9", "F9");
      const table = h.records.filter(({ record }) => record._tag === "UpdateLookupTable").at(-1)?.record;
      expect(table?._tag).toBe("UpdateLookupTable");
      if (table?._tag !== "UpdateLookupTable") throw new Error("No Hanja table");
      const index = table.table.visible().candidates.findIndex((candidate) => candidate.text === "韓");
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(9);
      const before = h.records.length;
      const digit = String(index + 1);
      expect((await h.press(field, digit, `Digit${digit}`)).defaultPrevented).toBe(true);
      expect(field.element.value).toBe("韓");
      const editing = h.records
        .slice(before)
        .map(({ record }) => record)
        .filter((record) => record._tag === "DeleteSurroundingText" || record._tag === "CommitText");
      expect(editing).toMatchObject([
        { _tag: "DeleteSurroundingText", offset: -1, count: 1 },
        { _tag: "CommitText", text: { text: "韓" } },
      ]);
      expect(field.inputs.map((input) => input.value)).toEqual(["한", "韓"]);
    }));
});
