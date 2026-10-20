// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A module script written against the host's contract by hand, as a build would emit one: self-contained, with no
// imports at run time.

/** @import { ModuleEngine, ModuleScript, Property, StyledText } from "@ibus-web/protocol/module-script" */

const RELEASE = 1 << 30;
const ESCAPE = 0xff1b;

/** @param {string} text */
const codePoints = (text) => [...text].length;

/** @param {string} character */
const isLetter = (character) => /^[a-z]$/i.test(character);

/**
 * @param {string} text
 * @returns {StyledText}
 */
const underlined = (text) => ({ text, attributes: [{ type: "underline", value: 1, start: 0, end: codePoints(text) }] });

/** @type {ModuleEngine} */
const upper = {
  descriptor: {
    displayName: "Fixture uppercase",
    languages: ["en"],
    keyboard: { layout: "us", passThrough: [] },
  },
  settings: {
    shout: { type: "b", default: true, summary: "Uppercase the composition" },
    delay: {
      type: "d",
      default: 1,
      range: { min: 0.1, max: 10 },
      summary: "Seconds without a key before the composition commits",
    },
  },
  // Composes letters, uppercased while `shout` is on, and commits them on space or after `delay` seconds without a
  // key.
  create(context) {
    let buffer = "";
    let cancelIdle = () => {};

    const shown = () => (context.settings.get("shout") ? buffer.toUpperCase() : buffer);
    /** @returns {Property} */
    const shoutProperty = () => ({
      key: "shout",
      kind: "toggle",
      label: "Shout",
      symbol: "A",
      tooltip: { text: "Uppercase the composition", attributes: [] },
      state: context.settings.get("shout") ? "checked" : "unchecked",
    });

    const draw = () => context.preedit(underlined(shown()), codePoints(buffer), buffer !== "", "commit");
    const clear = () => {
      cancelIdle();
      buffer = "";
      draw();
    };
    const commit = () => {
      const text = shown();
      clear();
      context.commit(text);
    };

    context.registerProperties([shoutProperty()]);

    return {
      processKey(keyval, _keycode, state, character) {
        if (state & RELEASE) return false;

        if (isLetter(character)) {
          buffer += character;
          draw();
          cancelIdle();
          cancelIdle = context.after(/** @type {number} */ (context.settings.get("delay")) * 1000, commit);
          return true;
        }

        if (character === " " && buffer !== "") {
          commit();
          return true;
        }

        if (keyval === ESCAPE && buffer !== "") {
          clear();
          return true;
        }

        return false;
      },
      focusOut: clear,
      reset: clear,
      propertyActivate(key, state) {
        if (key === "shout") context.settings.set("shout", state === "checked");
      },
      settingChanged(key) {
        if (key !== "shout") return;

        context.updateProperty(shoutProperty());
        draw();
      },
      destroy: () => cancelIdle(),
    };
  },
};

/** @type {ModuleEngine} */
const pick = {
  descriptor: {
    displayName: "Fixture picker",
    languages: ["en"],
    keyboard: { layout: "us", passThrough: ["Tab"] },
  },
  settings: {
    count: { type: "i", default: 3, range: { min: 1, max: 9 }, summary: "Candidates offered for a letter" },
    case: { type: "s", default: "lower", choices: ["lower", "upper"], summary: "The candidates' case" },
    extras: { type: "as", default: [], summary: "Candidates offered after the letter's" },
  },
  // Offers a letter repeated once, twice and so on as candidates, then the extras, and commits the one picked by
  // digit or click.
  create(context) {
    /** @type {string[]} */
    let candidates = [];

    /** @param {number} cursor */
    const show = (cursor) =>
      context.lookupTable(
        {
          candidates,
          labels: candidates.map((_, index) => `${index + 1}.`),
          cursor,
          cursorVisible: true,
          orientation: "vertical",
        },
        candidates.length > 0,
      );
    /** @param {number} index */
    const choose = (index) => {
      const chosen = candidates[index];
      if (chosen === undefined) return false;

      candidates = [];
      show(0);
      context.auxiliary("", false);
      context.commit(chosen);
      context.log("info", `picked ${chosen}`);
      return true;
    };

    return {
      processKey(keyval, _keycode, state, character) {
        if (state & RELEASE) return false;

        if (isLetter(character)) {
          const letter = context.settings.get("case") === "upper" ? character.toUpperCase() : character.toLowerCase();
          const count = /** @type {number} */ (context.settings.get("count"));
          const extras = /** @type {readonly string[]} */ (context.settings.get("extras"));

          candidates = [...Array.from({ length: count }, (_, index) => letter.repeat(index + 1)), ...extras];
          show(0);
          context.auxiliary(underlined(letter), true);
          return true;
        }

        if (candidates.length === 0) return false;

        if (/^[1-9]$/.test(character)) return choose(Number(character) - 1);

        if (keyval === ESCAPE) {
          candidates = [];
          show(0);
          context.auxiliary("", false);
          return true;
        }

        return false;
      },
      candidateClicked: (index) => void choose(index),
    };
  },
};

/** @type {ModuleEngine} */
const trace = {
  descriptor: {
    displayName: "Fixture trace",
    languages: ["en"],
    keyboard: { layout: "us", passThrough: [] },
  },
  // Logs every call it gets, with its arguments, and answers a key standing for one of the context's output calls with
  // that call. `!` throws.
  create(context) {
    /**
     * @param {string} name
     * @param {...unknown} args
     */
    const report = (name, ...args) =>
      context.log("debug", `${name}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`);

    report("create");

    /** @type {Record<string, () => void>} */
    const outputs = {
      c: () => context.commit("commit"),
      p: () =>
        context.preedit(
          {
            text: "𝄞ab",
            attributes: [
              { type: "underline", value: 1, start: 0, end: 3 },
              { type: "foreground", value: 0xff0000, start: 1, end: 2 },
            ],
          },
          1,
          true,
          "clear",
        ),
      a: () => context.auxiliary(underlined("aux"), false),
      l: () => context.lookupTable({ candidates: ["one", underlined("two")], cursor: 1, cursorVisible: false }, true),
      r: () =>
        context.registerProperties([
          {
            key: "mode",
            kind: "menu",
            label: "Mode",
            children: [{ key: "mode.a", kind: "radio", label: "A", state: "checked" }],
          },
          { key: "line", kind: "separator", label: "" },
        ]),
      u: () =>
        context.updateProperty({
          key: "mode",
          kind: "menu",
          label: underlined("Mode"),
          symbol: "M",
          tooltip: "The mode",
          icon: "mode.svg",
          sensitive: false,
          visible: false,
          state: "inconsistent",
        }),
      f: () => context.forwardKey(0x66, 41, 4),
      d: () => context.deleteSurrounding(-2, 1),
      s: () => context.requireSurrounding(),
      w: () => context.log("warning", "warned"),
      e: () => context.log("error", "erred"),
      i: () => context.log("info", "informed"),
    };

    return {
      processKey(keyval, keycode, state, character) {
        report("processKey", keyval, keycode, state, character);
        if (state & RELEASE) return false;

        if (character === "!") throw new Error("trace fault");

        const output = outputs[character];
        output?.();
        return output !== undefined;
      },
      focusIn: () => report("focusIn"),
      focusOut: () => report("focusOut"),
      reset: () => report("reset"),
      enable: () => report("enable"),
      disable: () => report("disable"),
      setCursorLocation: (x, y, width, height) => report("setCursorLocation", x, y, width, height),
      setCapabilities: (capabilities) => report("setCapabilities", capabilities),
      pageUp: () => report("pageUp"),
      pageDown: () => report("pageDown"),
      cursorUp: () => report("cursorUp"),
      cursorDown: () => report("cursorDown"),
      candidateClicked: (index, button, state) => report("candidateClicked", index, button, state),
      propertyActivate: (key, state) => report("propertyActivate", key, state),
      setSurroundingText: (text, cursor, anchor) => report("setSurroundingText", text, cursor, anchor),
      setContentType: (purpose, hints) => report("setContentType", purpose, hints),
      destroy: () => report("destroy"),
    };
  },
};

/** @type {ModuleEngine} */
const stall = {
  descriptor: {
    displayName: "Fixture stall",
    languages: ["en"],
    keyboard: { layout: "us", passThrough: [] },
  },
  // Never answers a key: the Worker sleeps on a word nothing writes, as a handler that never returns does without
  // spending a core.
  create: () => ({
    processKey() {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      return true;
    },
  }),
};

/** @type {ModuleScript} */
export default {
  ibusWebModule: 1,
  name: "js-fixture",
  version: "1.0.0",
  license: "MIT OR Apache-2.0",
  settingsPrefix: "org.example.jsfixture",
  engines: { upper, pick, trace, stall },
};
