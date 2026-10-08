# M2.1: the table engine

The design's M2 milestone asks for a custom MIT table engine and a `contenteditable` adapter. They share no code, so they
are split. This is M2.1, the table engine; the adapter is M2.2.

M2.1 ships one engine module, `table`, with two engines: `latex`, which turns LaTeX commands into Unicode, and `xsampa`,
which turns X-SAMPA into IPA. Both run in one Worker and switch without restarting it. To make that possible, the page
side learns the difference between a module (one manifest, one Worker) and the engines inside it.

An earlier attempt is kept on the `codex/table-engine` branch as a reference. It is not merged. Its MARISA index, its
shared module with several engines and its command and continuous behaviours carry over; its compatibility with SCIM
and ibus-table, and the conformance machinery built for it, do not.

## Goals

- An engine module whose code is MIT OR Apache-2.0 and whose data carries no copyleft licence, proving the design's
  fourth success criterion.
- Typing LaTeX commands and X-SAMPA in the browser, through the existing router and panel.
- Several engines in one module, selected by name, sharing one Worker.
- A pattern for C++ engines: one small GObject glue file, everything else ordinary C++.

## Non-goals

- Compatibility with ibus-table or SCIM, in format or behaviour. The table format is our own.
- An ordinary table mode (type a code, pick a candidate) and wildcards. Methods that need one, such as Cangjie, Quick or
  Wubi, come with Rime; scripts with context rules (Hebrew final forms, Greek final sigma) will be separate engines.
- Frequency learning and user phrases. The engine keeps no user data.
- Precompiled table bundles. Tables are parsed when the engine loads; a bundle can be added behind the same loader when
  a table is large enough for load time to matter.
- Engine settings.
- The `contenteditable` adapter (M2.2).

## Modules and engines

Until now "engine" has meant two things: the host's registry key (`"hangul"`, mapped to a manifest URL) and the IBus
engine names a manifest lists. M2.1 uses IBus's terms. A **module** is one engine distribution: one manifest, one side
module, one Worker. An **engine** is one input method inside it, created with `CreateEngine{name}`.

The page-side API and protocol types are renamed to match: the manifest type, the registry (`ModuleRegistry`), the
facade's `modules` option, `select`, `unload` and `debugRestart`, the `modulestate` event, and the `module` field of log
and panel events. Nothing outside the repository depends on them yet. The repository's `engines/<name>/` directories,
the Nix options under `ibusWeb.engines` and the npm names `@ibus-web/engine-<name>` keep their names.

### Manifest

The manifest's `engines: string[]` and its module-level `keyboard` are replaced by a list of engine descriptors:

```ts
type EngineDescriptor = {
  name: string;
  displayName: string;
  languages: string[]; // BCP 47
  keyboard: { layout: "us" | "default"; passThrough: string[] };
};

type ModuleManifest = {
  // … every other field as today
  engines: EngineDescriptor[];
};
```

The first engine is the module's default. The list is non-empty, names are non-empty and unique, and unknown keys are
rejected as elsewhere in the manifest. Hangul's manifest lists one engine: `hangul`, "Hangul", `["ko"]`, with today's
keyboard settings. `mkEngineManifest` takes the descriptors in place of `engines` and `keyboard`; it also accepts them as
a JSON file built by another derivation, which is how the table module's descriptors arrive (see
[Distribution](#distribution)).

### Router and facade

- `select(module, engine?)` selects an engine; without `engine`, the module's default. An unknown module or engine is
  rejected before anything changes.
- Switching engine within the selected module reuses its Worker. Each surface's context is drained and reset as on any
  switch today, and a new context is created with `CreateEngine{engine}`.
- The keyboard policy (layout and pass-through keys) is the active engine's.
- `override(adapter, …)` takes the same optional engine.
- `deselect()` returns every surface to plain browser input. Compositions finish through the same drain and reset;
  Workers stay loaded. X-SAMPA remaps ordinary letters (`S` becomes ʃ), so a host must be able to turn input methods
  off.
- `engines(module): Promise<EngineDescriptor[]>` fetches and validates the module's manifest without starting a Worker.
- `selection` is `{ module, engine } | undefined`; a `selectionchange` event fires whenever it changes.

There are still no built-in hotkeys: hosts bind their own.

### The demo

`examples/hangul` becomes `examples/demo` (`@ibus-web/example-demo`), one demo for every module the repository builds. It lists
each configured module's engines through `engines(module)` in a picker, switches with `select(module, engine)`, and
binds a shortcut that toggles between `deselect()` and the last selection. Its end-to-end tests are grouped by module:
Hangul's move unchanged, and the table engine's join them. `nix run .#demo`, `packages.demo` and the smoke check
(renamed `example-demo-smoke`) serve and build the renamed package.

## Table format

A table is a UTF-8 file with LF line endings, named `<engine>.table`. Frontmatter of `key = value` lines ends at a line
that is exactly `---`; the body is one mapping per line, `key<TAB>output`.

```
# X-SAMPA to IPA, after Wells (1995).
name = X-SAMPA
languages = und-fonipa
mode = continuous
---
# Plosives
t	t
t_h	tʰ
S	ʃ
@\	ɘ
```

- Blank lines are ignored everywhere.
- In the frontmatter, a line starting with `#` is a comment. In the body, a line starting with `#` and containing no tab
  is a comment, so `#` can still be a key.
- Outputs accept the escapes `\t`, `\n` and `\\`. Keys accept none: they are typed characters, so they can't contain a
  tab or newline, and LaTeX keys are written as they are typed.

### Frontmatter

| Key         | Required        | Meaning                                                            |
| ----------- | --------------- | ------------------------------------------------------------------ |
| `name`      | yes             | The engine's display name                                          |
| `languages` | yes             | Comma-separated BCP 47 tags                                        |
| `mode`      | yes             | `command` or `continuous`                                          |
| `trigger`   | in command mode | One character that opens a composition; every key starts with it   |
| `layout`    | no              | `default` (the default) or `us`: the engine's keyboard translation |

An unknown key, a repeated key, a missing required key, or a `trigger` in continuous mode is an error.

### Mappings

- A key may appear on several lines, giving several candidates in file order. A repeated identical line is an error.
- In command mode, every key starts with `trigger`. In continuous mode, keys are unique.
- Outputs are used exactly as written, combining marks included. Nothing is normalized.
- The **alphabet** is derived from the keys: every character after the trigger in command mode, every character of every
  key in continuous mode.
- **Completions** of a prefix are ordered by key length, then by key in code point order, then by file order within one
  key. `\al` therefore offers `\aleph` before `\alpha`.

### Errors

The parser reports `path:line: reason`. The native checks parse both shipped tables, so a malformed table fails the
build. In the Worker, a table that fails to parse fails `CreateEngine` with the same message.

## Data

| Table          | Source                                                                 | Licence           |
| -------------- | ---------------------------------------------------------------------- | ----------------- |
| `xsampa.table` | Written by hand from Wells' X-SAMPA chart, grouped by its sections     | MIT OR Apache-2.0 |
| `latex.table`  | Generated at build time from a pinned `unicode.xml` (W3C xml-entities) | W3C               |

`tools/latex-table` turns `unicode.xml` into `latex.table`:

- It takes each character's classic `<latex>` name and its `<mathlatex set="unicode-math">` name: classic names first,
  then unicode-math names, each group in code point order.
- Only bare commands matching `\\[A-Za-z]+` are kept; forms with arguments (`\mathbb{A}`, `{\'a}`) are dropped.
- Names from Elsevier's fonts (`\El…`) are dropped.
- A command that names two characters (classic and unicode-math disagreeing) becomes two candidates, classic first.
- The aliases in `tools/latex-table/aliases.tsv` come last. They are the common LaTeX and amsmath spellings
  `unicode.xml` doesn't carry because it gives each character one classic name, as `command<TAB>U+XXXX` lines we write
  ourselves. The generator fails if an alias's character isn't in `unicode.xml`, or if `unicode.xml` already uses the alias as a name, so the list shrinks rather than duplicates when upstream adds a name.

The first aliases:

| Aliases                          | Character | `unicode.xml`'s name |
| -------------------------------- | --------- | -------------------- |
| `\to`                            | →         | `\rightarrow`        |
| `\gets`                          | ←         | `\leftarrow`         |
| `\le`, `\ge`                     | ≤, ≥      | `\leq`, `\geq`       |
| `\neq`                           | ≠         | `\ne`                |
| `\iff`, `\implies`, `\impliedby` | ⟺, ⟹, ⟸   | `\Long…arrow`        |
| `\land`, `\lor`                  | ∧, ∨      | `\wedge`, `\vee`     |
| `\owns`                          | ∋         | `\ni`                |
| `\dots`                          | …         | `\ldots`             |
| `\lvert`, `\rvert`               | \|        | `\vert`              |
| `\lVert`, `\rVert`               | ‖         | `\Vert`              |
| `\emptyset`                      | ∅         | `\varnothing`        |
| `\hbar`                          | ℏ         | `\hslash`            |
| `\triangle`                      | △         | `\bigtriangleup`     |
| `\Box`                           | □         | `\square`            |
| `\Diamond`                       | ◇         | `\mdlgwhtdiamond`    |
| `\leadsto`                       | ⇝         | `\rightsquigarrow`   |
| `\qed`                           | ∎         | `\QED`               |
| `\degree`                        | °         | `\textdegree`        |

`unicode.xml`'s unicode-math names are the same as unicode-math's own table, apart from 11 second spellings it folds into
one name per character. The classic names are what make `\alpha` work: unicode-math's table names α `\mupalpha`. The
generated table isn't committed; the W3C notice ships with it. `aliases.tsv` is ours, MIT OR Apache-2.0.

## The engine

The engine is C++23, formatted by the repository's `.clang-format`. GObject appears in one file.

### Components

- **`Table`** is immutable, built from a parsed table and shared by every context of that engine. It holds a
  `marisa::Trie` of the UTF-8 keys, the outputs indexed by key ID, the frontmatter and the alphabet. Its queries:
  `exact(key)`, `completions(prefix)`, `extendable(prefix)` (some longer key starts with it) and
  `longestPrefix(text)`. MARISA's predictive and common-prefix searches do the work; key IDs never decide order.
- **`Session`** is one context's state: the raw buffer, the current candidates, the cursor and whether it is shown.
  `CommandSession` and `ContinuousSession` implement `processKey(keyval, modifiers) → bool`, `candidateClicked(index)`,
  `pageUp`, `pageDown`, `cursorUp`, `cursorDown` and `reset`.
- **`Sink`** is what a session writes to: `commit(text)`, `preedit(text)` (empty hides it) and
  `candidates(list, cursor, cursorShown)` (empty hides them).
- **`glue.cpp`** holds the GObject code: one `IBusEngine` subclass for every engine, whose `engine-name` selects the
  table. Its `class_init` assigns the vfuncs to static functions with exact signatures, and each instance owns a
  `std::unique_ptr<Session>` created in `init` and destroyed in `finalize`. It implements `Sink` on the engine. The
  module entry registers every engine with the factory. Tables are parsed on first use and kept in a module-level map
  for the module's lifetime.

`Sink` keeps sessions free of GObject: the native checks drive a session with a recording sink, and the browser drives
the same code through `glue.cpp`.

### Common behaviour

- A typed character is `ibus_keyval_to_unicode(keyval)`. Key releases return false.
- A key held with Control, Alt or Super flushes the composition (as each mode defines it), then passes through.
- The preedit is the raw buffer, underlined, in COMMIT mode. What it shows is exactly what blur or Escape leaves behind.
- FocusOut and Reset clear the state and emit nothing: the page already commits a visible COMMIT-mode preedit.
- Each candidate shows its output and its key (`α \alpha`) under the panel's position labels. Pages hold 10. Clicking a
  candidate commits its output and ends the composition.

### Command mode

`latex` uses command mode with the trigger `\`.

- **Idle.** The trigger opens a composition with the buffer `\` and is consumed. Every other key passes through.
- **Candidates** are the buffer's completions. The cursor is shown on the exact match if there is one; otherwise it is
  hidden until the user moves it.
- **An alphabet character** is appended, even when no key starts with the result: `\alphabet` stays as typed, with no
  candidates.
- **Space** commits the highlighted candidate if the cursor is shown and is consumed. Otherwise it commits the raw
  buffer and passes through, so the space is typed too.
- **Enter** commits the highlighted candidate if the cursor is shown, otherwise the raw buffer, and is consumed.
- **Any other printable key** (a digit, punctuation, another `\`) commits the highlighted candidate if the cursor is
  shown, otherwise the raw buffer, and is then processed as if idle: `\alpha,` gives `α,`, and `\alpha\beta` gives `α`
  followed by an open `\beta`.
- **Up, Down, Tab and Shift+Tab** move the cursor and show it. **Page Up and Page Down** page.
- **Backspace** deletes the last character. Deleting the trigger ends the composition and commits nothing.
- **Escape** commits the raw buffer and is consumed.
- **Left, Right, Home and End** commit the raw buffer and pass through.

### Continuous mode

`xsampa` uses continuous mode.

- **An alphabet character** is appended, then the buffer is resolved. While the buffer is non-empty and not
  extendable: if a key is a prefix of it, commit the longest such key's output and remove the key from the front;
  otherwise commit its first character literally and remove it. What remains can still extend, and stays as the
  preedit.
- **Flushing** runs the same loop as if nothing could extend, leaving the buffer empty.
- **Any other key** (Space, Enter, Escape, arrows, characters outside the alphabet) flushes, then passes through.
- **Backspace** deletes the last pending character, or passes through when nothing is pending.
- **Candidates** are the pending buffer's completions, shown as a guide to what it can still become. They can be
  clicked; they are not navigated by keyboard.

Enter differs between the modes on purpose. A command composition is explicit, so Enter ends it like any composition.
Continuous input has no visible composition step, so Enter keeps its ordinary meaning.

### MARISA

`pkgsWasm.marisa` is nixpkgs' recipe (0.3.1) with upstream
[PR #146](https://github.com/s-yata/marisa-trie/pull/146) as a vendored patch: 0.3.1 reads uninitialized units while
packing a `FlatVector`. The native and WebAssembly builds both carry it, and upstream's tests run in the native build.
The WebAssembly build has no host-specific instruction tuning. MARISA is linked statically into the side module under
its BSD-2-Clause option.

## Distribution

`ibus-web-table-dist` is built by `mkEngineManifest` from the side module, the two tables and their licences. The engine
descriptors come from the tables' frontmatter: the native check tool prints them as JSON, and the manifest build reads
that file, so each engine's configuration lives in one place and Nix needs no build output at evaluation time.

`packages/engines/table/` is `@ibus-web/engine-table`, packed by `npmTarball` like Hangul's. Its licence is
`(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C`, and its `LICENSES/` holds each text.

## Testing

| Check                          | Covers                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `table-parse`                  | Native. Both shipped tables parse; one malformed fixture per error class fails with its exact message                                                                                                                                            |
| `table-golden`                 | Native, through a recording `Sink`. Every rule above: dead ends, `\alpha,`, `\alpha\beta`, cursor shown and hidden, paging, Backspace through the trigger, Escape, longest match, literal fallback, flushing on Space and Enter, combining marks |
| `table-host`                   | `table.wasm` in the real runtime under Node: both engines created in one Worker, a short trace each, and a broken table failing `CreateEngine`                                                                                                   |
| `table-cast-audit`, link check | As for Hangul: callbacks with exact signatures, imports only from the runtime                                                                                                                                                                    |
| MARISA                         | Upstream's tests in the patched native build                                                                                                                                                                                                     |
| `tools-latex-table`            | A small `unicode.xml` fixture gives exact output: `\El…` dropped, argument forms dropped, classic names first, a command with two characters, aliases appended, and both alias failures                                                          |
| Protocol and core unit tests   | Engine descriptors decode and reject duplicates; switching engine in a module reuses its Worker; unknown engine; `deselect`; override with an engine; keyboard policy following the engine; `selectionchange`                                    |
| Playwright, three browsers     | `\alpha` and Space gives `α`; `\to,` gives `→,`; `S@` and Space gives `ʃə `; switching between LaTeX and X-SAMPA in one Worker; `deselect` gives plain input                                                                                     |
| `typescript-npm`               | `@ibus-web/engine-table` packs with its tables and every licence text                                                                                                                                                                            |

The time to load the LaTeX table is measured and recorded in `docs/engines.md`. There is no target until there is a
baseline.

## Delivery

Three phases, reviewed at the end of each:

1. **Modules and engines.** The rename, engine descriptors, `select(module, engine?)`, `deselect`, `engines(module)`,
   `selection` and `selectionchange`, with Hangul as the only module. Switching between two engines of one module is
   tested in core against a fake host. `examples/hangul` becomes `examples/demo`, with the picker and the `deselect`
   shortcut.
2. **The table engine, natively.** MARISA, `Table`, `Session` and both modes, the parser, `xsampa.table`,
   `tools/latex-table`, and `table-parse`, `table-golden` and `tools-latex-table`.
3. **The table engine in the browser.** `glue.cpp` and the side module, the distribution and descriptors,
   `@ibus-web/engine-table`, `table-host`, the cast audit and link check, the table module in the demo, the Playwright
   cases, the load-time measurement, and the docs: `docs/engines.md`, a new `docs/table.md`,
   and the design spec's M2 row split into M2.1 and M2.2.

Phases 1 and 2 are independent.

## References

- [W3C xml-entities, `unicode.xml`](https://github.com/w3c/xml-entities)
- [unicode-math's symbol table](https://github.com/latex3/unicode-math/blob/master/unicode-math-table.tex)
- [X-SAMPA](https://www.phon.ucl.ac.uk/home/sampa/x-sampa.htm), J. C. Wells
- [MARISA](https://github.com/s-yata/marisa-trie) and its [licence](https://github.com/s-yata/marisa-trie/blob/master/COPYING.md)
