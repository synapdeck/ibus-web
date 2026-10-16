# M6 Phase 6c: Input fidelity

## Goal

Keys from keyboard layouts other than US reach every engine as the spec's "6c: Input fidelity" describes: a Playwright
layout matrix (US, AZERTY, QWERTZ, Dvorak, Colemak) through every module in Chromium, Firefox and WebKit, with what it
finds fixed and `docs/core.md` recording the behaviour per layout; a per-engine `layout` setting a host can drive; the
textarea adapter performing declined word deletion and caret and word navigation; the surrounding text's anchor moving
with the IBus-compatible delete; and Hangul's `preedit-mode` taking effect in a live engine at once.

## Tasks

1. **Surrounding anchor.** `ibus_engine_delete_surrounding_text` moves the cached selection anchor with the deleted
   span, as the cursor already moves. Proven by `test-engine`'s surrounding cases asserting the anchor after a deletion
   before, inside and after it (`checks.libibus-web-tests`), red before the fix.
2. **Hangul's live `preedit-mode`.** Port patch 0005 has the instance settings handler flush a live engine's
   composition and apply the new mode when `preedit-mode` changes. Proven by `checks.hangul-golden`'s settings case
   changing the mode with no refocus and composing a word, red before the patch.
3. **Layout override.** Each engine gets a `layout` setting (`"us"` or `"default"`, defaulting to its declared layout),
   read before its module's keys, followed live, listed by `settings.schemas(module)`, and reported by
   `engines(module)` as `layout` beside `keyboard.layout`. Proven by core Node router tests (stored override before the
   first key, a live change, a change from another tab), a settings-API test, and the facade's browser test of
   `engines()` (`checks.core-node`, `checks.core-browser`, `checks.ibus-web-browser`).
4. **Declined word deletion and navigation.** The textarea adapter's `replayKey` performs Ctrl+Backspace and
   Ctrl+Delete (Option on Apple), Ctrl+Left/Right with and without Shift (Option on Apple), Ctrl+Home/End and Apple's
   Command+arrows and Command+Backspace through `setSelectionRange` and native `delete` edits. Proven by the adapter's
   browser tests (`checks.core-browser`), red before the change.
5. **Layout matrix.** `examples/demo/test/e2e/layouts.spec.ts` sends each layout's real `key`, `code`, `keyCode` and
   modifiers through Playwright's own input pipeline into Hangul, m17n, Mozc, Rime and the table module, covering typed
   text, AltGr characters, dead keys and Ctrl and Meta shortcuts, and the layout override on a US engine. What it finds
   is fixed in core, and `docs/core.md` gains a per-layout table. Proven by the extended `playwright` check
   (`nix build .#integration-checks -L`).
6. **Verify the phase.** `nix run .#write-files` with no drift, `nix flake check -L`, `nix build .#integration-checks -L`,
   `nix develop -c hk check --all`.

## Decisions this phase makes where the spec is silent

- **The setting's schema.** It is a page setting: key translation runs on the page, so the Worker never sees it, and
  `Init` never declares it. Two relocatable schemas, `org.ibus-web.keyboard.us` and `org.ibus-web.keyboard.default`,
  differ only in their `layout` key's default, the declared layout; an engine's instance is the schema of its declared
  layout. Key `layout`, type `s`, choices `us` and `default`.
- **The path.** `/org/ibus-web/keyboard/<manifest name>/<engine name's ":" components>/`, as m17n's per-engine paths
  split its names, so `rime:luna_pinyin` in the `rime` distribution is `/org/ibus-web/keyboard/rime/rime/luna_pinyin/`.
  The manifest's name, not the page's module key, so pages naming a module differently share it. An engine whose name
  can't form a canonical path (a `/`, or an empty, `.` or `..` component) has no setting and keeps its declared layout.
- **What `engines()` reports.** Each descriptor gains `layout`, the layout its keys follow now (the setting, else the
  declared one), and `layoutPath`, the setting's path, so a host needs no path rule of its own.
- **When the override is read.** With the manifest, before the module's first key: the registry registers the schemas
  and reads the stored values as it reads the manifest. A settings source that fails that read leaves the declared
  layouts and logs a warning; the module still starts.
- **Word boundaries** come from `Intl.Segmenter`'s word granularity. Word-wise movement right stops at the end of a
  word on every platform, as macOS and Linux do; Windows' stop at the next word's start is not emulated.
- **Platform chords.** On Apple platforms Option is the word modifier and Command the line and document one; elsewhere
  Ctrl is the word modifier and Ctrl+Home/End the document one. Ctrl+Up/Down (paragraph movement) stays unperformed.
- **How the matrix emulates layouts.** Playwright's keyboard knows only the US layout. The specs register each
  layout's key descriptions with Playwright's in-process server keyboard, so the browser's own input path (CDP,
  Juggler, WebKit's inspector protocol) delivers trusted events with the layout's `key`, `code` and `keyCode`. One
  test per module and browser walks every layout, so Rime installs its data once per browser.

## Departures from the spec

- **AltGr in Chromium and WebKit.** Their automation protocols carry only Shift, Control, Alt and Meta, so no emulated
  event there has `getModifierState("AltGraph")`; only Firefox's (whose input processor tracks a pressed AltGraph key)
  does. The AltGr rows run with the AltGraph state in Firefox, and in Chromium and WebKit they send the AltGr character
  with no modifier, which checks the character's path but not the AltGraph state. Recorded in `docs/core.md` and
  `docs/testing.md`.
- **Dead keys are emulated, not composed.** No OS input method runs under automation, so a dead key is its `Dead`
  keydown followed by the composed character's own keydown, the sequence Firefox and Chromium deliver on Linux.

## What the spike proved and what it didn't

The spike this phase was to start from was not on disk when it began (no `m6c-spike` clone or `m6c-*` directory in the
scratchpad), so nothing was carried over from it. What was proved before writing this plan:

- Registering custom key descriptions with Playwright 1.63's server keyboard delivers trusted `keydown`, `keypress` and
  `keyup` events with arbitrary `key`, `code` and `keyCode` in all three browsers, and text lands in a textarea.
- Firefox reports `getModifierState("AltGraph")` after an emulated AltGraph keydown; Chromium and WebKit don't.
- A `Dead` keydown reaches the page with no text in all three.

Everything else is unproven until its task runs.
