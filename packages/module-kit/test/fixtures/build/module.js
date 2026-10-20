// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A module script written against the contract by hand, as a bundler would
// leave one: no imports, an engine with a setting of each type and one with
// none.

const session = () => ({ processKey: () => false });

export default {
  ibusWebModule: 1,
  name: "build-fixture",
  version: "1.2.3",
  license: "MIT OR Apache-2.0",
  settingsPrefix: "org.example.buildfixture",
  engines: {
    every: {
      descriptor: {
        displayName: "Every setting",
        languages: ["el", "en"],
        keyboard: { layout: "us", passThrough: [] },
      },
      settings: {
        "show-hints": { type: "b", default: true, summary: "Show hints" },
        "letter-case": {
          type: "s",
          default: "lower",
          choices: ["lower", "upper"],
          summary: "Letter case",
          description: "The case of the letters written.",
        },
        greeting: { type: "s", default: "γεια" },
        delay: { type: "i", default: 300, range: { min: 0, max: 1000 } },
        scale: { type: "d", default: 1.5, range: { min: 0.5, max: 4 } },
        ratio: { type: "d", default: 0.25 },
        words: { type: "as", default: ["alpha", "beta"] },
      },
      create: session,
    },
    plain: {
      descriptor: {
        displayName: "No settings",
        languages: [],
        keyboard: { layout: "default", passThrough: ["Escape"] },
      },
      create: session,
    },
  },
};
