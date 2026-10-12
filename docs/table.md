# The table engine

`engines/table/` is an engine module whose engines are driven by tables: `latex` turns LaTeX commands into Unicode, and
`xsampa` turns X-SAMPA into IPA. Its code is MIT OR Apache-2.0, and no table carries a copyleft licence. This page
describes the table format, where the two tables come from, the engine's C++ core, which the native checks build and
drive, and the glue and side module that run it in the browser.

The format and behaviour are the engine's own, compatible with neither ibus-table nor SCIM. There is no ordinary table
mode (type a code, pick a candidate) and no wildcards: methods that need one, such as Cangjie, Quick or Wubi, come with
Rime, and scripts with context rules (Hebrew final forms, Greek final sigma) are left to engines of their own. The
engine keeps no user data, learns no frequencies and has no settings. Tables are parsed when the engine loads; a
precompiled bundle could go behind the same loader if a table grows large enough for load time to matter.

## Table format

A table is a UTF-8 file with LF line endings, named `<engine>.table`; the engine's name is the file's stem. Frontmatter
of `key = value` lines ends at a line that is exactly `---`. The body is one mapping per line, `key<TAB>output`.

```
# X-SAMPA to IPA.
name = X-SAMPA
languages = und-fonipa
mode = continuous
---
# Vowels
@	ə
@\	ɘ
```

- Blank lines are ignored everywhere.
- In the frontmatter, a line starting with `#` is a comment. In the body, a line starting with `#` and containing no tab
  is a comment, so `#` can still be a key.
- Outputs accept the escapes `\t`, `\n` and `\\`, and are used exactly as written otherwise: combining marks and
  surrounding spaces included, nothing normalized. Keys accept no escapes; they are typed characters, written as typed.

| Key         | Required        | Meaning                                                            |
| ----------- | --------------- | ------------------------------------------------------------------ |
| `name`      | yes             | The engine's display name                                          |
| `languages` | yes             | Comma-separated BCP 47 tags                                        |
| `mode`      | yes             | `command` or `continuous`                                          |
| `trigger`   | in command mode | One character that opens a composition; every key starts with it   |
| `layout`    | no              | `default` (the default) or `us`: the engine's keyboard translation |

A key may appear on several lines, giving several candidates in file order; in continuous mode keys are unique. The
**alphabet** is every character after the trigger in command mode, and every character of every key in continuous mode.
A key can't contain a space, which ends a composition, nor, in command mode, the trigger after its start, which opens
the next one.

**Completions** of a prefix are the keys starting with it, the prefix included, ordered by key length in code points,
then by key in code point order, then by file order within one key: `\al` offers `\aleph` before `\alpha`.

### Errors

The parser stops at the first error and reports it as `path:line: reason`, or `path: reason` when the file can't be read
at all. `table-parse` holds one malformed table for each:

| Reason                                                 | Where                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `carriage return; tables use LF line endings`          | Any line holding a CR                                                |
| `invalid UTF-8`                                        | Any line that isn't well-formed UTF-8                                |
| `expected key = value`                                 | A frontmatter line without `=`, or whose key isn't a lower-case word |
| `unknown key "…"`, `repeated key "…"`                  | The frontmatter line                                                 |
| `empty value for "…"`, `empty language tag`            | The frontmatter line                                                 |
| `missing --- after the frontmatter`                    | The file's last line                                                 |
| `missing required key "…"`                             | The `---` line                                                       |
| `mode must be command or continuous, not "…"`          | The `mode` line                                                      |
| `layout must be default or us, not "…"`                | The `layout` line                                                    |
| `trigger is only for command mode`                     | The `trigger` line                                                   |
| `trigger must be one character`                        | The `trigger` line                                                   |
| `expected key<TAB>output`, `empty key`, `empty output` | The body line                                                        |
| `space in key "…"`, `tab in output; write it as \t`    | The body line                                                        |
| `unknown escape "\…" in output`                        | The body line                                                        |
| `key "…" doesn't start with the trigger`               | The body line                                                        |
| `key is only the trigger`, `trigger inside key "…"`    | The body line                                                        |
| `repeated mapping "…" to "…"`                          | The second of two identical lines                                    |
| `repeated key "…" in continuous mode`                  | The second line with that key                                        |
| `no mappings`                                          | The file's last line                                                 |

## Data

| Table          | Source                                                                     | Licence           |
| -------------- | -------------------------------------------------------------------------- | ----------------- |
| `xsampa.table` | `engines/table/tables/xsampa.table`, written by hand from Wells' chart     | MIT OR Apache-2.0 |
| `latex.table`  | Generated at build time by `tools/latex-table` from a pinned `unicode.xml` | W3C               |

`ibusWeb.engines.table.tables` holds both, and nothing else.

### X-SAMPA

`xsampa.table` follows J. C. Wells'
[summary chart](https://web.archive.org/web/20110709014830/http://www.phon.ucl.ac.uk/home/sampa/x-sampa.htm) (the
original page is offline; this is the Internet Archive's copy), section by section. Where the chart gives an alternative
spelling (`v\` for `P`, `_j` for `'`, `_=` for `=`, `_~` for `~`), both are keys. Lower-case letters that are already
IPA symbols aren't listed; continuous mode types them as they are. Keys are literal per the chart, so `g` stays an ASCII
`g` rather than becoming the IPA `ɡ`. Three plosives the summary leaves to SAMPA and the full chart (`J\`, `G\`, `?`)
are added, and since Unicode has no implosive diacritic, the chart's `_<` is written out for the five implosives (`b_<`,
`d_<`, `J\_<`, `g_<`, `G\_<`).

### LaTeX

`tools/latex-table` turns `unicode.xml` from [W3C xml-entities](https://github.com/w3c/xml-entities), pinned to commit
`0f766d761eebd0908b4f2cfaa30cf9b06bdc79b0` (Unicode 18), into `latex.table`:

- It takes each character's classic `<latex>` name and its `<mathlatex set="unicode-math">` name: classic names first,
  then unicode-math names, each group in code point order. A name both give for one character appears once.
- Only bare commands matching `\\[A-Za-z]+` are kept; forms with arguments (`\mathbf{A}`, `\not =`) are dropped.
- Names from Elsevier's fonts (`\El…`) are dropped.
- A command naming two characters becomes two candidates, the classic one first: `\ast` gives `*`, then `∗`.
- The aliases in `tools/latex-table/aliases.tsv` come last: common LaTeX and amsmath spellings that `unicode.xml`
  doesn't carry, as `command<TAB>U+XXXX` lines. The generator fails if an alias's character isn't in `unicode.xml`, or
  if `unicode.xml` already uses the alias as a name, so the list shrinks rather than duplicates when upstream adds one.

The classic names are what make `\alpha` work: unicode-math names α `\mupalpha`. The generated table isn't committed;
the W3C notice ships with it. `aliases.tsv` is ours, MIT OR Apache-2.0.

## The engine

The engine is C++23 in `engines/table/src/`, in namespace `ibusweb::table`, with no IBus or GObject in it:

- **`Table`** (`table.hpp`) is a parsed table, immutable and shared by every session of its engine. It holds a
  `marisa::Trie` of the UTF-8 keys, each key's outputs by key ID, the frontmatter and the sorted alphabet. Its queries
  are `exact(key)`, `completions(prefix)`, `extendable(prefix)` (a longer key starts with it) and `longestPrefix(text)`.
  MARISA's predictive and common-prefix searches find the keys; key IDs never decide order.
- **`Sink`** (`sink.hpp`) is what a session writes to: `commit(text)`, `preedit(text)` (empty hides it) and
  `candidates(all, cursor, cursorShown)` (empty hides them). Sessions pass the whole list; a page is the aligned block
  of 10 candidates that contains the cursor. Within one call into a session, a commit comes before the preedit and
  candidates that follow it.
- **`Session`** (`session.hpp`) is one context's composition. `makeSession(table, sink)` returns a command or a
  continuous session by the table's mode. `processKey(keyval, character, modifiers)` takes the key's X11 keysym, its
  Unicode value (0 if none) and IBus's modifier mask, and returns whether it consumed the key. `candidateClicked`,
  `pageUp`, `pageDown`, `cursorUp` and `cursorDown` come from the panel. `reset` clears the state and emits nothing.
- `keys.hpp` holds the keysyms and modifier masks by value; `utf8.hpp` decodes and encodes UTF-8.

### Common behaviour

- Key releases, and presses of modifier keys themselves (Shift, Control, Caps Lock, the ISO level and group keys, …),
  return false and change nothing. A continuous composition must survive the Shift that types the `H` of `_H`.
- A key held with Control, Alt or Super flushes the composition (as each mode defines it), then passes through.
- Keypad keys act like their main keys: KP_Space like Space, KP_Up and KP_Down like Up and Down, KP_Tab like Tab and
  KP_Enter like Enter.
- The preedit is the raw buffer. What it shows is exactly what blur or Escape leaves behind.
- Clicking a candidate commits its output and ends the composition.

### Command mode

`latex` uses command mode with the trigger `\`.

- **Idle**, the trigger opens a composition with the buffer `\` and is consumed. Every other key passes through.
- **Candidates** are the buffer's completions. If the buffer is a key, the cursor is shown on its first output, which is
  the first completion; otherwise the cursor is hidden.
- **An alphabet character** is appended, even when no key starts with the result: `\alphabet` stays as typed, with no
  candidates.
- **Space** commits the highlighted candidate if the cursor is shown, and is consumed. Otherwise it commits the raw
  buffer and passes through, so the space is typed too.
- **Enter** commits the highlighted candidate if the cursor is shown, otherwise the raw buffer, and is consumed.
- **Any other printable key** (a digit, punctuation, another `\`) commits the highlighted candidate if the cursor is
  shown, otherwise the raw buffer, and is then handled as if idle: `\alpha,` gives `α,`, and `\alpha\beta` gives `α`
  followed by an open `\beta`.
- **Up, Down, Tab and Shift+Tab** move the cursor and show it; a hidden cursor is first shown where it is, on the first
  candidate of its page. **Page Up and Page Down** move it by a page.
- **Backspace** deletes the last character. Deleting the trigger ends the composition and commits nothing.
- **Escape** commits the raw buffer and is consumed.
- **Left, Right, Home and End**, and every other key that types nothing (Delete, Insert, F1, …), commit the raw buffer
  and pass through, so the key acts on committed text.

### Continuous mode

`xsampa` uses continuous mode.

- **An alphabet character** is appended, then the buffer is resolved. While the buffer is non-empty and not extendable,
  the longest key it starts with is committed and removed from its front; if no key matches, its first character is
  committed as typed. What remains can still extend, and stays as the preedit.
- **Flushing** runs the same loop as if nothing could extend, leaving the buffer empty. Several commits from one key are
  joined into one.
- **Escape** commits the pending buffer raw, unresolved, and is consumed; with nothing pending it passes through.
- **Any other key** (Space, Enter, arrows, characters outside the alphabet) flushes, then passes through.
- **Backspace** deletes the last pending character, or passes through when nothing is pending.
- **Candidates** are the pending buffer's completions, a guide to what it can still become, with the cursor hidden. They
  can be clicked and paged; `cursorUp` and `cursorDown` do nothing.

Enter differs between the modes on purpose. A command composition is explicit, so Enter ends it like any composition.
Continuous input has no visible composition step, so Enter keeps its ordinary meaning.

## MARISA

The engine links MARISA 0.3.1, the one package every module that uses it shares ([engines.md](engines.md#marisa)); the
native build the tools link is the same recipe.

## In the browser

`engines/table/src/glue.cpp` is the module's only GObject code. One `IBusEngine` subclass, `IBusWebTableEngine`, serves
every engine, and its `engine-name` picks the table. That name is a construct property, set after instance init, so an
instance makes its session in `constructed` and destroys it in `finalize`. The type is registered by hand with callbacks
of exactly the types GLib calls them through, which leaves the cast audit nothing to allow.

`ibusweb_module_init` registers an engine for every `*.table` in the table directory, named for its file. A handler on
the factory's `create-engine` signal runs before the factory makes the engine: it parses the engine's table on first use
and keeps it in a module-level map for the Worker's life, shared by every context of that engine. A table that doesn't
parse fails `CreateEngine` with the parser's `path:line: reason` through `ibusweb_factory_fail_create`, which stops the
emission: the reply is `-EIO`, the page receives the reason in a `CreateEngineFailed` record and `select` rejects with
it, and the field stays on native input. That handler lets no exception out into GLib's signal emission. The key and
paging handlers catch nothing: an exception from one of them unwinds through the emission and faults the runtime, which
the host treats as a crash ([runtime.md](runtime.md#protocol-dispatch-and-output)).

The glue is the session's `Sink`:

- `commit` commits the text.
- `preedit` shows the raw buffer, underlined, in COMMIT mode, with the cursor at its end. Empty, it clears and hides the
  preedit.
- `candidates` gets the whole list, which a bare `\` makes every command in the LaTeX table, and sends IBus a lookup
  table of only the page of 10 that holds the cursor, each candidate as its output and key (`α \alpha`), with the
  cursor's position on that page. The panel draws the table it is sent as one page and leaves paging to the engine, so
  only those 10 become `IBusText`s. Empty, it hides the lookup table.

PageUp, PageDown, CursorUp and CursorDown go to the session, which redraws with the cursor's new page. The panel's click
index counts from the page it shows, and the glue adds the page's start; a position no candidate holds is ignored. A
key's character is `ibus_keyval_to_unicode(keyval)`, and IBus's `state` is passed through as the session's modifiers.
FocusOut and Reset reset the session, which emits nothing.

`pkgsWasm.ibus-web-table` (`engines/table/_package.nix`) compiles `ibusWeb.engines.table.sources` as C++23 with the
runtime's toolchain and side-module flags, and links `pkgsWasm.marisa` into `table.wasm` statically; the runtime's
library guard rejects a library the runtime carries. The table directory and the compiled `org.freedesktop.ibus.panel`
schema are compiled in as store paths, which makes them the side module's whole data closure.

`table-host` checks that a bare `\` sends IBus one page of 10. It builds a second distribution whose LaTeX table is a
fixture with a malformed line, beside the shipped X-SAMPA table, and expects `CreateEngine` to fail with `-EIO` after a
`CreateEngineFailed` record, and nothing else, whose message is what `table-check` prints for the same file, while
X-SAMPA keeps working in that Worker.

## Building and checking

The native build is Meson (`engines/table/meson.build`), from nixpkgs' compiler, linking the patched MARISA. It builds
the engine as a static library and two tools, `ibusWeb.engines.table.tools`:

- `table-check FILE.table...` parses each table and exits 1 with `path:line: reason` on the first error.
- `table-describe FILE.table...` prints the tables' engine descriptors as one JSON array, each named for its file's
  stem, with the frontmatter's display name, languages and layout, and no pass-through keys.

`ibusWeb.engines.table.sources` lists the `.cpp` files in `engines/table/src` by name, for builds of the engine. The
side module compiles all of them; the Meson build names its own and leaves out `glue.cpp`, the only one that needs IBus.

| Check                | Covers                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `table-parse`        | Both shipped tables parse and describe their engines; one malformed table per error class fails with its exact message                                                                                                                 |
| `table-golden`       | GoogleTest, native, through a recording `Sink`: the table queries and every rule of both modes, and the shipped X-SAMPA                                                                                                                |
| `table-imports`      | `table.wasm` imports only what the runtime exports                                                                                                                                                                                     |
| `table-cast-audit`   | every source, glue included, under `-Wcast-function-type-strict`, with an empty allow-list                                                                                                                                             |
| `table-data-closure` | the closure is the module, the tables and the compiled schema, all of them data                                                                                                                                                        |
| `table-host`         | `table.wasm` in the real runtime under Node: both engines in one Worker, a short trace each, one-page lookup tables and a page-relative click, FocusOut and Reset, and a broken table failing `CreateEngine` with the parser's message |
| `tools-latex-table`  | Vitest: a cut-down `unicode.xml` gives an exact table, every generator rule and both alias failures, and the 24 aliases                                                                                                                |

Each is a flake check, run as `nix build .#checks.x86_64-linux.<name> -L`.
