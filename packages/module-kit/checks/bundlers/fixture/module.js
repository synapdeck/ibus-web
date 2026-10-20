// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A module of two engines, written with the kit and Effect, which every
// bundler has to inline: a transform with settings, one of them a toggle
// property, and an engine that offers candidates through Effect handlers.

import { defineEngine, defineModule, transformEngine } from "@ibus-web/module-kit";
import { Effect, Schema } from "effect";

const upper = transformEngine({
  displayName: "Bundled upper",
  languages: ["en"],
  keyboard: { layout: "us" },
  settings: Schema.Struct({
    shout: Schema.Boolean.annotate({
      default: false,
      title: "Add an exclamation mark",
      property: { label: "Shout", symbol: "!" },
    }),
    repeat: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })).annotate({
      default: 1,
      title: "How many times each letter is written",
    }),
  }),
  alphabet: "abcdefghijklmnopqrstuvwxyz",
  transform: (input, { shout, repeat }) => ({
    text: `${Array.from(input, (letter) => letter.toUpperCase().repeat(repeat)).join("")}${shout ? "!" : ""}`,
  }),
});

const words = ["alpha", "bravo", "charlie", "delta"];

const picker = defineEngine({
  displayName: "Bundled words",
  languages: ["en"],
  keyboard: { layout: "us" },
  create(context) {
    let shown = [];

    return {
      processKey: (_keyval, _keycode, _state, character) =>
        Effect.sync(() => {
          if (!/^[a-z]$/.test(character)) return false;

          shown = words.filter((word) => word.startsWith(character));
          context.candidates(shown);
          return true;
        }),
      candidateClicked: (index) =>
        Effect.sync(() => {
          const word = shown[index];
          if (word !== undefined) context.commit(word);
          context.candidates([]);
        }),
    };
  },
});

export default defineModule({
  name: "bundled-fixture",
  version: "1.0.0",
  license: "MIT OR Apache-2.0",
  settingsPrefix: "org.example.bundled",
  engines: { upper, words: picker },
});
