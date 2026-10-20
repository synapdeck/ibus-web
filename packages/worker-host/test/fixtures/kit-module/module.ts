// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A module written with the kit: a Greek transliteration whose final sigma is
// a setting shown as a toggle and whose case is one shown as a menu of
// radios, and a word picker that pages candidates and commits through Effect
// handlers.

import { defineEngine, defineModule, transformEngine } from "@ibus-web/module-kit";
import { Effect, Schema } from "effect";

const letters: Readonly<Record<string, string>> = {
  a: "α",
  b: "β",
  g: "γ",
  d: "δ",
  e: "ε",
  z: "ζ",
  h: "η",
  q: "θ",
  i: "ι",
  k: "κ",
  l: "λ",
  m: "μ",
  n: "ν",
  x: "ξ",
  o: "ο",
  p: "π",
  r: "ρ",
  s: "σ",
  t: "τ",
  u: "υ",
  f: "φ",
  c: "χ",
  y: "ψ",
  w: "ω",
};

// A sigma that closes a word is written ς, so the right letter is known only
// once the next one (or none) has been typed. Greek has no j, and a word
// holding one makes the transform throw.
const greek = transformEngine({
  displayName: "Fixture Greek",
  languages: ["el"],
  keyboard: { layout: "us" },
  settings: Schema.Struct({
    finalSigma: Schema.Boolean.annotate({
      default: true,
      title: "Write a sigma that ends a word as ς",
      property: { label: "Final sigma", symbol: "ς" },
    }),
    letterCase: Schema.Literals(["lower", "upper"]).annotate({
      default: "lower",
      title: "The case of the letters written",
      property: { label: "Case", values: { lower: "Lowercase", upper: "Uppercase" } },
    }),
  }),
  alphabet: `${Object.keys(letters).join("")}j`,
  transform: (input, { finalSigma, letterCase }) => {
    if (input.includes("j")) throw new Error("Greek has no letter j");

    const text = Array.from(input, (character) => letters[character] ?? character).join("");
    const sigma = finalSigma ? text.replace(/(?<=\p{L})σ$/u, "ς") : text;
    return { text: letterCase === "upper" ? sigma.toUpperCase() : sigma };
  },
});

const words = Array.from({ length: 25 }, (_, index) => `word${index}`);

const picker = defineEngine({
  displayName: "Fixture words",
  languages: ["en"],
  keyboard: { layout: "us" },
  create(context) {
    let prefix = "";
    let shown: readonly string[] = [];

    const offer = (): void => {
      shown = words.filter((word) => word.startsWith(prefix));
      context.candidates(shown);
    };

    return {
      // An Effect, run by the kit; its result is the key's. One that fails is
      // the module's fault.
      processKey: (_keyval, _keycode, _state, character) =>
        character === "#"
          ? Effect.fail(new Error("the picker has no key #"))
          : Effect.sync(() => {
              if (!/^[a-z]$/.test(character)) return false;

              prefix += character;
              offer();
              return true;
            }),
      candidateClicked: (index) =>
        Effect.gen(function* () {
          const word = shown[index];
          if (word === undefined) return yield* Effect.fail(new Error(`no candidate ${index}`));

          context.commit(word);
          context.candidates([]);
          prefix = "";
        }),
    };
  },
});

export default defineModule({
  name: "kit-fixture",
  version: "1.0.0",
  license: "MIT OR Apache-2.0",
  settingsPrefix: "org.example.kitfixture",
  engines: { greek, words: picker },
});
