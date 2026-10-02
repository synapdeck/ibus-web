// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Each call breaks one rule of addToLibrary's type. The type check of this
// file must fail with one error per call, carrying the message above it.

// error: $orphan__deps decorates $orphan, which this addToLibrary call doesn't define
addToLibrary({ $orphan__deps: [] });

// error: $listed__deps: a __deps decorator's value is the wrong type
addToLibrary({ $listed: () => {}, $listed__deps: "$orphan" });

// error: $flagged__nothrow: a __nothrow decorator's value is a boolean
addToLibrary({ $flagged: () => {}, $flagged__nothrow: "yes" });

// error: proxied__proxy: a __proxy decorator's value is the wrong type
addToLibrary({ proxied: () => {}, proxied__proxy: "maybe" });

// error: $value: a symbol's value is a function, a class or a string of code
addToLibrary({ $value: true });

// error: lettered__sig: a signature's characters are v i j f d p e
addToLibrary({ lettered: () => {}, lettered__sig: "vx" });

// error: counted__sig has 1 characters, but counted takes 1 parameter(s) and a result
addToLibrary({ counted: (/** @type {number} */ n) => n, counted__sig: "i" });

const signature = /** @type {string} */ ("vi");
// error: widened__sig: a signature must be a string literal
addToLibrary({
  widened: (/** @type {number} */ n) => n,
  widened__sig: signature,
});

// error: $awaited__async: only a Wasm import can be async, not a $ symbol
addToLibrary({ $awaited: async () => {}, $awaited__async: true });
