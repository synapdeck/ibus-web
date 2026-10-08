// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, expect, test, vi } from "vitest";
import { asError, errorMessage, errorReport, errorSummary } from "../../src/errors.ts";

const unprintable = {
  toString: () => {
    throw new Error("no");
  },
};

// Node has no ErrorEvent; a Worker's error event is one.
class FakeErrorEvent {
  readonly message: string;
  readonly filename: string;
  readonly lineno: number;
  constructor(message: string, filename: string, lineno: number) {
    this.message = message;
    this.filename = filename;
    this.lineno = lineno;
  }
}

const withStack = (error: Error, stack: string | undefined): Error => {
  Object.defineProperty(error, "stack", { value: stack });
  return error;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test("asError keeps an Error and wraps anything else", () => {
  const error = new TypeError("bad input");
  expect(asError(error)).toBe(error);
  expect(asError("text")).toBeInstanceOf(Error);
  expect(asError("text").message).toBe("text");
  expect(asError(7).message).toBe("7");
});

test("errorMessage reads an Error's message and prints anything else", () => {
  expect(errorMessage(new RangeError("out of range"))).toBe("out of range");
  expect(errorMessage("text")).toBe("text");
  expect(errorMessage(undefined)).toBe("undefined");
});

test("errorMessage still returns text for a value that can't be printed", () => {
  expect(errorMessage(unprintable)).toBe("Unprintable host error");
});

test("errorSummary names the error", () => {
  expect(errorSummary(new TypeError("bad input"))).toBe("TypeError: bad input");
  expect(errorSummary(new DOMException("gone", "AbortError"))).toBe("AbortError: gone");
  expect(errorSummary("text")).toBe("text");
  expect(errorSummary(7)).toBe("7");
  expect(errorSummary(unprintable)).toBe("Unprintable host error");
});

test("errorSummary places an ErrorEvent in its script", () => {
  vi.stubGlobal("ErrorEvent", FakeErrorEvent);
  expect(errorSummary(new FakeErrorEvent("boom", "worker.js", 12))).toBe("boom (worker.js:12)");
});

test("errorReport keeps a Chromium stack, which starts with the summary", () => {
  const stack = "TypeError: bad input\n    at run (worker.js:3:9)";
  expect(errorReport(withStack(new TypeError("bad input"), stack))).toBe(stack);
});

test("errorReport puts the summary above a Firefox stack, which leaves it out", () => {
  const stack = "run@worker.js:3:9\n";
  expect(errorReport(withStack(new TypeError("bad input"), stack))).toBe(`TypeError: bad input\n${stack}`);
});

test("errorReport is the summary when there is no stack", () => {
  expect(errorReport(withStack(new TypeError("bad input"), undefined))).toBe("TypeError: bad input");
  expect(errorReport(withStack(new TypeError("bad input"), ""))).toBe("TypeError: bad input");
  expect(errorReport("text")).toBe("text");
  vi.stubGlobal("ErrorEvent", FakeErrorEvent);
  expect(errorReport(new FakeErrorEvent("boom", "worker.js", 12))).toBe("boom (worker.js:12)");
});
