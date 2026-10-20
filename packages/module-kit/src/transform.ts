// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Modifier, type RichText, Underline } from "@ibus-web/protocol/module-script";
import type { Effect } from "effect";
import { defineEngine, type Engine, type EngineContext, type EngineDescriptor, type EngineSession } from "./engine.ts";
import { run } from "./run.ts";
import { isText, type NoSettings, type SettingsSchema } from "./settings.ts";

/** What a transform produces: the text, and lines for the auxiliary text beneath the raw buffer. */
export type Transformed = string | { readonly text: string; readonly notes?: readonly string[] };

export interface TransformDefinition<S extends SettingsSchema> extends EngineDescriptor {
  /** A `Schema.Struct` with a field for each setting. */
  readonly settings?: S;
  /**
   * Turns the whole raw buffer into the text to show and commit. It is called again on every key, so context rules are
   * right whatever has been typed. May return an Effect of its result, which the kit runs with `Effect.runSync`.
   */
  transform(input: string, settings: S["Type"]): Transformed | Effect.Effect<Transformed, unknown>;
  /**
   * The characters that extend the buffer, as a string of them or a predicate on a key's character. Defaults to every
   * character but whitespace and control characters. One that holds the space makes Space extend a pending buffer too; on an empty buffer Space passes through.
   */
  readonly alphabet?: string | ((character: string) => boolean);
}

const Space = 0x20;
const BackSpace = 0xff08;
const Tab = 0xff09;
const Return = 0xff0d;
const Escape = 0xff1b;
const KP_Space = 0xff80;
const KP_Tab = 0xff89;
const KP_Enter = 0xff8d;

// Presses of modifier keys alone also arrive as keys, and must not end a
// composition between a letter and the shifted one that follows it.
const isModifierKey = (keyval: number): boolean =>
  (keyval >= 0xffe1 && keyval <= 0xffee) ||
  (keyval >= 0xfe01 && keyval <= 0xfe0f) ||
  (keyval >= 0xfe11 && keyval <= 0xfe13) ||
  keyval === 0xff7e ||
  keyval === 0xff7f;

// Keypad keys act like the main keys they stand for.
const mainKey = (keyval: number): number =>
  keyval === KP_Space ? Space : keyval === KP_Tab ? Tab : keyval === KP_Enter ? Return : keyval;

const shortcut = Modifier.CONTROL | Modifier.MOD1 | Modifier.SUPER;

const defaultAlphabet = (character: string): boolean => !/[\s\p{Cc}]/u.test(character);

const alphabetOf = (alphabet: TransformDefinition<SettingsSchema>["alphabet"]): ((character: string) => boolean) => {
  if (alphabet === undefined) return defaultAlphabet;
  if (typeof alphabet === "function") return alphabet;

  const allowed = new Set(alphabet);
  return (character) => allowed.has(character);
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Shown {
  readonly text: string;
  readonly notes: readonly string[];
}

// A transform's result as the context can carry it. Text with a NUL or a
// lone surrogate would make the context throw, a fault that ends the module,
// so it fails here instead, as a transform that threw.
const shownOf = (result: unknown): Shown => {
  const { text, notes = [] } = (typeof result === "string" ? { text: result } : (result ?? {})) as {
    text?: unknown;
    notes?: unknown;
  };

  if (!isText(text))
    throw new TypeError(
      typeof text === "string"
        ? "the transform's text holds a NUL or a lone surrogate"
        : "the transform returned neither text nor { text, notes? }",
    );
  if (!Array.isArray(notes) || !notes.every(isText))
    throw new TypeError("the transform's notes aren't a list of text without NULs or lone surrogates");
  return { text, notes };
};

/**
 * Makes an engine from a whole-string function. Keys in the alphabet build a raw buffer whose transformation is the
 * underlined preedit, in COMMIT mode, and the auxiliary text shows the buffer and the transform's notes. Space, unless
 * the alphabet holds it, Enter, Tab, keys outside the alphabet and shortcuts commit the transformed buffer and pass
 * through; Backspace edits the buffer; Escape commits it raw. A `transform` that throws while the word is typed shows
 * the raw buffer as the preedit and logs one warning for the word; one that still throws at the commit has the raw
 * buffer committed.
 */
export const transformEngine = <S extends SettingsSchema = NoSettings>(
  definition: TransformDefinition<S>,
): Engine<S> => {
  const { transform, alphabet, ...rest } = definition;
  const inAlphabet = alphabetOf(alphabet);
  const names = Object.keys(definition.settings?.fields ?? {});

  return defineEngine<S>({
    ...rest,
    create(context: EngineContext<S>): EngineSession {
      let buffer = "";

      const values = (): S["Type"] =>
        Object.fromEntries(names.map((name) => [name, (context.settings.get as (key: string) => unknown)(name)]));

      const hide = (): void => {
        context.preedit("", 0, false, "clear");
        context.auxiliary("", false);
      };

      // Set once the word has logged its warning, so a transform that throws
      // on every key of a word logs once.
      let warned = false;

      const warn = (error: unknown): void => {
        if (warned) return;

        warned = true;
        context.log("warning", `the transform failed, so the raw input is used: ${message(error)}`);
      };

      const apply = (): Shown => shownOf(run(transform(buffer, values())));

      const underline = (text: string): RichText => ({
        text,
        attributes: [{ type: "underline", value: Underline.SINGLE, start: 0, end: Array.from(text).length }],
      });

      const clear = (): void => {
        buffer = "";
        warned = false;
      };

      const draw = (): void => {
        if (buffer === "") {
          hide();
          return;
        }

        let shown: Shown;
        try {
          shown = apply();
        } catch (error) {
          warn(error);
          shown = { text: buffer, notes: [] };
        }

        context.preedit(underline(shown.text), Array.from(shown.text).length, shown.text !== "", "commit");
        context.auxiliary([buffer, ...shown.notes].join("\n"), true);
      };

      const flush = (): void => {
        if (buffer === "") return;

        let text: string;
        try {
          text = apply().text;
        } catch (error) {
          warn(error);
          text = buffer;
        }

        clear();
        if (text !== "") context.commit(text);
        hide();
      };

      for (const name of names) {
        (context.settings.onChange as (key: string, fn: () => void) => void)(name, () => {
          if (buffer !== "") draw();
        });
      }

      return {
        processKey(keyval, _keycode, state, character) {
          if (state & Modifier.RELEASE || isModifierKey(keyval)) return false;

          if (state & shortcut) {
            flush();
            return false;
          }

          switch (mainKey(keyval)) {
            case BackSpace: {
              if (buffer === "") return false;

              buffer = Array.from(buffer).slice(0, -1).join("");
              if (buffer === "") warned = false;
              draw();
              return true;
            }
            case Escape: {
              if (buffer === "") return false;

              const raw = buffer;
              clear();
              context.commit(raw);
              hide();
              return true;
            }
            case Space:
              if (inAlphabet(" ") && buffer !== "") {
                buffer += " ";
                draw();
                return true;
              }

              flush();
              return false;
            case Tab:
            case Return:
              flush();
              return false;
          }

          if (character === "" || !inAlphabet(character)) {
            flush();
            return false;
          }

          buffer += character;
          draw();
          return true;
        },
        focusOut() {
          clear();
          context.auxiliary("", false);
        },
        reset() {
          clear();
          hide();
        },
      };
    },
  });
};
