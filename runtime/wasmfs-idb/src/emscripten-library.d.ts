// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a JavaScript library sees of Emscripten that isn't one of its library
// symbols, so `--emit-tsd` doesn't describe it.

// The type of each decorator's value, as Emscripten checks it when it merges
// a library. A decorator `<symbol>__<name>` configures `<symbol>`.
interface LibraryDecorators {
  deps: readonly (string | ((...args: never[]) => unknown))[];
  sig: string;
  proxy: string;
  asm: boolean;
  postset: string | (() => string | void);
  docs: string;
  nothrow: boolean;
  noleakcheck: boolean;
  internal: boolean;
  user: boolean;
  async: string | boolean;
  i53abi: boolean;
  export: boolean;
  force: boolean;
}
type Decorator = keyof LibraryDecorators & string;

// Fails the property it's intersected with, and says why in the error.
interface LibraryError<Message extends string> {
  "addToLibrary error": Message;
}

type SigChar = "v" | "i" | "j" | "f" | "d" | "p" | "e";

// A signature's characters, one element each, or never if one isn't valid.
type SigChars<
  S extends string,
  Acc extends unknown[] = [],
> = S extends `${SigChar}${infer Rest}`
  ? SigChars<Rest, [...Acc, unknown]>
  : S extends ""
    ? Acc
    : never;

// A signature is the result's character, then one per parameter.
type CheckSig<
  Sig,
  Value,
  Key extends string,
  Symbol extends string,
> = Sig extends string
  ? [SigChars<Sig>] extends [never]
    ? LibraryError<`${Key}: a signature's characters are v i j f d p e`>
    : Value extends (...args: infer Params) => unknown
      ? SigChars<Sig>["length"] extends [unknown, ...Params]["length"]
        ? unknown
        : LibraryError<`${Key} has ${SigChars<Sig>["length"]} characters, but ${Symbol} takes ${Params["length"]} parameter(s) and a result`>
      : unknown
  : unknown;

type CheckDecorator<
  Entries,
  Key extends string,
  Symbol extends string,
  Name extends Decorator,
> = Symbol extends keyof Entries
  ? Entries[Key & keyof Entries] extends LibraryDecorators[Name]
    ? Name extends "sig"
      ? CheckSig<Entries[Key & keyof Entries], Entries[Symbol], Key, Symbol>
      : Name extends "async"
        ? Symbol extends `$${string}`
          ? LibraryError<`${Key}: only a Wasm import can be async, not a $ symbol`>
          : unknown
        : unknown
    : LibraryError<`${Key}: a __${Name} decorator's value is ${LibraryDecorators[Name] extends boolean ? "a boolean" : "the wrong type"}`>
  : LibraryError<`${Key} decorates ${Symbol}, which this library doesn't define`>;

// Emscripten splits a decorator at its last `__`, so the suffix is matched
// whole and the symbol is everything before it.
type CheckEntry<Entries, Key extends string> = {
  [Name in Decorator]: Key extends `${infer Symbol}__${Name}`
    ? CheckDecorator<Entries, Key, Symbol, Name>
    : never;
}[Decorator] extends infer Result
  ? [Result] extends [never]
    ? unknown
    : Result
  : never;

type CheckLibrary<Entries> = {
  [Key in keyof Entries & string]: CheckEntry<Entries, Key>;
};

// A symbol's value: a function or class Emscripten emits from its source, or
// a string it emits as written.
type LibraryValue =
  | ((...args: never[]) => unknown)
  | (abstract new (...args: never[]) => unknown)
  | string
  | boolean
  | readonly unknown[];

// Adds the entries to the library Emscripten links from, when it evaluates
// the file at link time. Every decorator must name a symbol defined in the
// same call, with a value of its decorator's type, and a `__sig` must have a
// character for the result and for each of the function's parameters.
declare function addToLibrary<
  const Entries extends Record<string, LibraryValue>,
>(entries: Entries & NoInfer<CheckLibrary<Entries>>): void;

// The runtime's error output, which every program has.
declare function err(...args: unknown[]): void;
