// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Whatever was thrown, as an Error.
export const asError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));

// Each formatter below yields text even for a value whose own toString()
// throws.
const printed = (cause: unknown): string => {
  try {
    return String(cause);
  } catch {
    return "Unprintable host error";
  }
};

// Whatever was thrown, as its message alone.
export const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : printed(cause));

// What this file reads of an ErrorEvent. It is looked up at each call:
// Node has none, and its typings declare none.
type ErrorEventLike = new (...args: never[]) => { message: string; filename: string; lineno: number };

// Whatever was thrown, on one line. A thread's uncaught error reaches the
// thread that started it as the ErrorEvent its Worker fired, which carries
// no error to name, only where it was thrown.
export const errorSummary = (cause: unknown): string => {
  if (cause instanceof Error || (typeof DOMException === "function" && cause instanceof DOMException))
    return `${cause.name}: ${cause.message}`;
  const errorEvent = (globalThis as { ErrorEvent?: ErrorEventLike }).ErrorEvent;
  if (typeof errorEvent === "function" && cause instanceof errorEvent)
    return `${cause.message} (${cause.filename}:${cause.lineno})`;
  return printed(cause);
};

// Whatever was thrown, with its stack when it has one. Chromium's stacks
// start with the summary and Firefox's leave it out, so the summary is added
// only when the stack doesn't already open with it.
export const errorReport = (cause: unknown): string => {
  const summary = errorSummary(cause);
  const stack = cause instanceof Error ? (cause.stack ?? "") : "";
  if (stack === "") return summary;
  return stack.startsWith(summary) ? stack : `${summary}\n${stack}`;
};
