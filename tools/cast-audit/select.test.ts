// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { selectOne } from "./select.ts";

const cast = (name: string | null) => ({ file: "casts.c", function: name, from: "void (*)(int)", to: "GFunc" });

test("selects the only cast of the named function", () => {
  expect(selectOne([cast("one"), cast("takes_int"), cast(null)], "takes_int")).toEqual([cast("takes_int")]);
});
test("rejects a function with no cast", () => {
  expect(() => selectOne([cast("one")], "takes_int")).toThrow(/expected one cast of takes_int, found 0/);
});
test("rejects a function with several casts", () => {
  expect(() => selectOne([cast("one"), cast("one")], "one")).toThrow(/expected one cast of one, found 2/);
});
