// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { defineModule, transformEngine } from "@ibus-web/module-kit";
import { Schema } from "effect";
import { markPinyin } from "./pinyin.ts";

const pinyinTones = transformEngine({
  displayName: "Pinyin (tone numbers)",
  languages: ["zh-Latn-pinyin"],
  keyboard: { layout: "default" },
  settings: Schema.Struct({
    vAsU: Schema.Boolean.annotate({
      default: true,
      title: "Read v as ü",
      description: "Type v for ü, as in lv4 for lǜ. u: is always read as ü.",
      property: { label: "v is ü", symbol: "ü" },
    }),
  }),
  // The letters and numbers of a syllable, ü itself on a layout that has it
  // and its two spellings on one that doesn't, and the apostrophe that
  // separates syllables; Space commits.
  alphabet: (character) => /^[A-Za-züÜ0-5:']$/.test(character),
  transform: markPinyin,
});

export default defineModule({
  name: "pinyin-tones",
  version: "1.0.0",
  license: "MIT OR Apache-2.0",
  settingsPrefix: "org.ibus-web.example",
  engines: { "pinyin-tones": pinyinTones },
});
