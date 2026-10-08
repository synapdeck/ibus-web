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

// Whether the stack's first line is exactly `head`.
const opensWith = (stack: string, head: string): boolean => stack === head || stack.startsWith(`${head}\n`);

// Whether a stack already opens with the error's summary. Chromium writes the
// header when the error is constructed, so it omits ": " for an empty message
// and keeps the name the error had then, not one assigned afterwards.
const isHeaded = (error: Error, stack: string, summary: string): boolean => {
  const constructedName: unknown = (Object.getPrototypeOf(error) as { name?: unknown } | null)?.name;

  const heads = [summary, summary.replace(/: $/, "")];
  if (typeof constructedName === "string")
    heads.push(error.message === "" ? constructedName : `${constructedName}: ${error.message}`);

  return heads.some((head) => opensWith(stack, head));
};

// Whatever was thrown, with its stack when it has one. Chromium's stacks
// start with the summary and Firefox's leave it out, so the summary is added
// only when the stack doesn't already open with it.
export const errorReport = (cause: unknown): string => {
  const summary = errorSummary(cause);

  if (!(cause instanceof Error) || !cause.stack) return summary;

  return isHeaded(cause, cause.stack, summary) ? cause.stack : `${summary}\n${cause.stack}`;
};
