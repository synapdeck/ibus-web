// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a JavaScript library sees of Emscripten that isn't one of its library
// symbols, so `--emit-tsd` doesn't describe it.

// A symbol's value: a function or class Emscripten emits from its source, or
// a string it emits as written.
type LibrarySymbol =
  | ((...args: never[]) => unknown)
  | (abstract new (...args: never[]) => unknown)
  | string;

// A key ending in a decorator matches the plain string signature too, whose
// type therefore has to admit every decorator's value.
interface LibraryEntries {
  [symbol: string]: LibrarySymbol | string[] | boolean;
  [deps: `${string}__deps`]: string[];
  [sig: `${string}__sig`]: string;
  [docs: `${string}__docs`]: string;
  [postset: `${string}__postset`]: string;
  [async: `${string}__async`]: boolean;
  [i53abi: `${string}__i53abi`]: boolean;
}

// Adds the entries to the library Emscripten links from, when it evaluates
// the file at link time.
declare function addToLibrary(entries: LibraryEntries): void;

// The runtime's error output, which every program has.
declare function err(...args: unknown[]): void;
