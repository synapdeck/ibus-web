// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { createRequire } from "node:module";
import type { Page } from "playwright/test";

// Playwright's keyboard knows only the US layout. Its server half runs in this process, so key descriptions
// registered with it here travel the browser's own input path (CDP, Juggler, WebKit's inspector protocol) and arrive
// as trusted events carrying another layout's key, code and keyCode.
interface KeyDescription {
  key: string;
  code: string;
  keyCode: number;
  keyCodeWithoutLocation: number;
  text: string;
  location: number;
}
interface ServerKeyboard {
  readonly _pressedModifiers: ReadonlySet<string>;
  _keyDescriptionForString(name: string): KeyDescription;
}

const descriptions = new Map<string, KeyDescription>();
const require = createRequire(createRequire(import.meta.url).resolve("playwright/package.json"));
const { server } = require("playwright-core/lib/coreBundle") as {
  server: { Page: { prototype: object } };
};
const keyboards = new WeakMap<object, ServerKeyboard>();
let patched = false;

// Every server Page assigns its keyboard once, in its constructor; the first assignment exposes the class to patch.
Object.defineProperty(server.Page.prototype, "keyboard", {
  configurable: true,
  get(this: object) {
    return keyboards.get(this);
  },
  set(this: object, keyboard: ServerKeyboard) {
    keyboards.set(this, keyboard);
    if (patched) return;
    patched = true;

    const prototype = Object.getPrototypeOf(keyboard) as ServerKeyboard;
    const original = prototype._keyDescriptionForString;
    prototype._keyDescriptionForString = function (this: ServerKeyboard, name: string) {
      const description = descriptions.get(name);
      if (!description) return original.call(this, name);

      // As for Playwright's own keys, a modifier other than Shift makes the key a shortcut that types nothing.
      const modifiers = this._pressedModifiers;
      const shortcut = modifiers.size > 1 || (modifiers.size === 1 && !modifiers.has("Shift"));
      return { ...description, ...(shortcut ? { text: "" } : {}) };
    };
  },
});

export type LayoutName = "us" | "azerty" | "qwertz" | "dvorak" | "colemak";
export const layoutNames: readonly LayoutName[] = ["us", "azerty", "qwertz", "dvorak", "colemak"];

// The keys of the main block, in order, each row's characters unshifted then shifted. A space in a row is a key
// that types nothing at that level; a dead key is listed apart.
const rows = [
  ["Backquote", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0"],
  ["Minus", "Equal"],
  ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "BracketLeft", "BracketRight"],
  ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote", "Backslash"],
  ["IntlBackslash", "KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Comma", "Period", "Slash"],
] as const;
type Code = (typeof rows)[number][number];

interface Layout {
  // By row: the characters each key types, unshifted and shifted.
  readonly levels: readonly (readonly [string, string])[];
  readonly altGr: Readonly<Partial<Record<Code, string>>>;
  // Dead keys, by code: the spacing character they stand for.
  readonly dead: Readonly<Partial<Record<Code, string>>>;
}

// xkeyboard-config's us, fr, de, us(dvorak) and us(colemak).
const layouts: Readonly<Record<LayoutName, Layout>> = {
  us: {
    levels: [
      ["`1234567890", "~!@#$%^&*()"],
      ["-=", "_+"],
      ["qwertyuiop[]", "QWERTYUIOP{}"],
      ["asdfghjkl;'\\", 'ASDFGHJKL:"|'],
      [" zxcvbnm,./", " ZXCVBNM<>?"],
    ],
    altGr: {},
    dead: {},
  },
  azerty: {
    levels: [
      ["²&é\"'(-è_çà", " 1234567890"],
      [")=", "°+"],
      ["azertyuiop^$", "AZERTYUIOP¨£"],
      ["qsdfghjklmù*", "QSDFGHJKLM%µ"],
      ["<wxcvbn,;:!", ">WXCVBN?./§"],
    ],
    altGr: {
      Digit3: "#",
      Digit4: "{",
      Digit5: "[",
      Digit6: "|",
      Digit8: "\\",
      Digit9: "^",
      Digit0: "@",
      Minus: "]",
      Equal: "}",
      KeyE: "€",
    },
    dead: { BracketLeft: "^" },
  },
  qwertz: {
    levels: [
      ["^1234567890", '°!"§$%&/()='],
      ["ß´", "?`"],
      ["qwertzuiopü+", "QWERTZUIOPÜ*"],
      ["asdfghjklöä#", "ASDFGHJKLÖÄ'"],
      ["<yxcvbnm,.-", ">YXCVBNM;:_"],
    ],
    altGr: {
      Digit7: "{",
      Digit8: "[",
      Digit9: "]",
      Digit0: "}",
      Minus: "\\",
      KeyQ: "@",
      KeyE: "€",
      BracketRight: "~",
      IntlBackslash: "|",
    },
    dead: { Backquote: "^", Equal: "´" },
  },
  dvorak: {
    levels: [
      ["`1234567890", "~!@#$%^&*()"],
      ["[]", "{}"],
      ["',.pyfgcrl/=", '"<>PYFGCRL?+'],
      ["aoeuidhtns-\\", "AOEUIDHTNS_|"],
      [" ;qjkxbmwvz", " :QJKXBMWVZ"],
    ],
    altGr: {},
    dead: {},
  },
  colemak: {
    levels: [
      ["`1234567890", "~!@#$%^&*()"],
      ["-=", "_+"],
      ["qwfpgjluy;[]", "QWFPGJLUY:{}"],
      ["arstdhneio'\\", 'ARSTDHNEIO"|'],
      [" zxcvbkm,./", " ZXCVBKM<>?"],
    ],
    altGr: {},
    dead: {},
  },
};

// Browsers give a letter key the legacy keyCode of the letter it types, and every other key its US one.
const usKeyCodes: Readonly<Record<string, number>> = {
  Backquote: 192,
  Minus: 189,
  Equal: 187,
  BracketLeft: 219,
  BracketRight: 221,
  Semicolon: 186,
  Quote: 222,
  Backslash: 220,
  IntlBackslash: 226,
  Comma: 188,
  Period: 190,
  Slash: 191,
};
const keyCodeOf = (code: Code, base: string) => {
  if (/^[a-z]$/.test(base)) return base.toUpperCase().charCodeAt(0);
  if (code.startsWith("Digit")) return code.charCodeAt(5);
  if (code.startsWith("Key")) return code.charCodeAt(3);
  return usKeyCodes[code]!;
};

/** One key press: the code it is pressed at, the key it reports and the modifiers it needs. */
export interface Stroke {
  readonly code: Code;
  readonly key: string;
  readonly shift: boolean;
  readonly altGr: boolean;
}

const strokes = (name: LayoutName): Stroke[] => {
  const layout = layouts[name];
  const all: Stroke[] = [];
  rows.forEach((codes, row) => {
    const [base, shifted] = layout.levels[row]!;
    codes.forEach((code, index) => {
      for (const [characters, shift] of [
        [base, false],
        [shifted, true],
      ] as const) {
        const key = [...characters][index]!;
        if (key !== " " && !(!shift && layout.dead[code])) all.push({ code, key, shift, altGr: false });
      }
    });
  });
  for (const [code, key] of Object.entries(layout.altGr))
    all.push({ code: code as Code, key, shift: false, altGr: true });

  return all;
};

/** The press that types character on the layout, by the character the layout gives it. */
export function strokeFor(layout: LayoutName, character: string): Stroke {
  const stroke = strokes(layout).find((candidate) => candidate.key === character);
  if (!stroke) throw new Error(`${layout} has no key for ${JSON.stringify(character)}`);
  return stroke;
}

/** The press at the place where the US layout types character, reporting what the layout types there. */
export function physicalStroke(layout: LayoutName, character: string): Stroke {
  const us = strokeFor("us", character);
  const stroke = strokes(layout).find(
    (candidate) => candidate.code === us.code && candidate.shift === us.shift && !candidate.altGr,
  );
  if (!stroke) throw new Error(`${layout} types nothing where US types ${JSON.stringify(character)}`);
  return stroke;
}

/** The layout's dead key and the spacing character it stands for, if it has one. */
export function deadKey(layout: LayoutName): { code: Code; character: string } | undefined {
  const entry = Object.entries(layouts[layout].dead)[0];
  return entry ? { code: entry[0] as Code, character: entry[1] } : undefined;
}

const register = (description: Omit<KeyDescription, "keyCodeWithoutLocation">) => {
  // Playwright splits a key name at "+", so the key goes by its code points.
  const name = `\u{e000}${description.code}:${[...description.key].map((c) => c.codePointAt(0)).join(",")}`;
  descriptions.set(name, { ...description, keyCodeWithoutLocation: description.keyCode });
  return name;
};
const altGraph = register({ key: "AltGraph", code: "AltRight", keyCode: 225, text: "", location: 2 });

/**
 * Presses stroke. Only Firefox's automation carries the AltGraph state, through a pressed AltGraph key: Chromium's
 * and WebKit's take only Shift, Control, Alt and Meta, so there an AltGr character arrives with no modifier.
 */
export async function press(page: Page, layout: LayoutName, stroke: Stroke, modifiers: readonly string[] = []) {
  const base = strokes(layout).find((candidate) => candidate.code === stroke.code && !candidate.shift);
  const name = register({
    key: stroke.key,
    code: stroke.code,
    keyCode: keyCodeOf(stroke.code, base?.key ?? stroke.key),
    text: stroke.key,
    location: 0,
  });
  const held = [
    ...modifiers,
    ...(stroke.shift ? ["Shift"] : []),
    ...(stroke.altGr && page.context().browser()?.browserType().name() === "firefox" ? [altGraph] : []),
  ];

  for (const modifier of held) await page.keyboard.down(modifier);
  await page.keyboard.press(name);
  for (const modifier of held.toReversed()) await page.keyboard.up(modifier);
}

/** Presses the layout's dead key, which types nothing by itself. */
export async function pressDead(page: Page, layout: LayoutName) {
  const dead = deadKey(layout);
  if (!dead) throw new Error(`${layout} has no dead key`);
  await page.keyboard.press(
    register({ key: "Dead", code: dead.code, keyCode: keyCodeOf(dead.code, dead.character), text: "", location: 0 }),
  );
}

/** Types text by the characters the layout gives its keys. */
export async function typeOn(page: Page, layout: LayoutName, text: string) {
  for (const character of text) await press(page, layout, strokeFor(layout, character));
}

/** Types at the places where the US layout types text, as a US-layout engine reads them. */
export async function typeAt(page: Page, layout: LayoutName, text: string) {
  for (const character of text) await press(page, layout, physicalStroke(layout, character));
}
