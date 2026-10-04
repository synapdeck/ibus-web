# Engines

`engines/<name>/` owns an engine's overlay, package output, module entry point,
patches, cast allow-list and checks. The top-level flake imports that tree.
Hangul is the first port:

```sh
nix build .#ibus-web-hangul
nix build .#checks.x86_64-linux.hangul-golden
nix build .#checks.x86_64-linux.hangul-cast-audit
```

The package contains `hangul.wasm` and `data/usr/share/`. Its module links engine
code and private libhangul, importing IBus, GLib and system libraries from
`ibus-runtime.wasm`. It is GPL-2.0-or-later. The internal option is
`ibusWeb.engines.hangul`; the public package is `packages.ibus-web-hangul`.

## Build and data

The WASM-gated overlay overrides the pinned nixpkgs `ibus-engines.hangul`
recipe (ibus-hangul 1.5.5), keeping its source and patches. It replaces the
desktop dependency set, including propagated inputs, bypasses configure, writes
the small engine config header, and compiles `engine.c`, `ustring.c` and our
`module.c`. Cross `pkg-config` supplies compile flags. Only private libhangul
contributes link libraries; the shared `checkSideModuleLibraries` guard rejects
runtime libraries accidentally added by pkg-config.

A private override of libhangul 0.2.0 changes its default Hanja path to
`/usr/share/libhangul/hanja/hanja.txt`, without changing the general libhangul
package. Hangul's symbols live at `/usr/share/ibus-hangul/data/symbol.txt`.
libhangul keeps the Hanja dictionary open and uses seeks to read entries;
the eventual host mapping must support that access pattern.

The data tree also contains the Hangul and IBus schema XML files, including
`org.freedesktop.ibus.panel`, and `gschemas.compiled`. Compilation uses the
cross GLib tool named by `gio-2.0.pc`, executed under Node, with `--strict`.
The native build machine's schema compiler is not substituted. The host must
expose this tree at its FHS paths before loading the module; wiring the
installed data backend into that view is M1.3 work.

## Startup and patch layers

`ibusweb_module_init` calls `ibus_hangul_init(NULL)`, creates an `IBusFactory`,
registers the `hangul` engine type and releases its reference. The runtime's
registry retains the factory. Send the Init settings snapshot before loading
the module: upstream initialization reads those settings into globals.
Contexts use `FocusIn` and `FocusOut`; the protocol has no ID variants.

Local patches follow nixpkgs' patches, with `port` before `casts`, each sorted
by filename. `port` holds build/startup adaptations and engine behavior fixes;
`casts` holds exact callback-type fixes and can be removed independently if a
future toolchain makes it unnecessary. Keep patches as `git format-patch`
commits against the pinned source. Their [inventory](../engines/hangul/patches/README.md)
records reasons and upstream status.

Hangul has **four port patches and one cast patch**. The port patches:

- 0001 disconnects an engine's settings handlers on destruction.
- 0002 rejects candidate digits beyond the last page.
- 0003 keeps global settings current with no live engine: one module listener,
  connected at init, updates the globals, and instance handlers only reselect
  their context's keyboard. Settings upstream reads only at initialization,
  such as `disable-latin-mode`, stay init-only.
- 0004 treats a `CandidateClicked` index as page-relative, the position of the
  clicked label on the visible page, as the IBus panel sends it, and ignores a
  click no visible label has (at or past the page size, or past the last
  candidate of a short final page). Upstream reads the index as absolute, and
  a cursor past the candidates fails the `g_assert` in
  `ibus_lookup_table_set_cursor_pos`.

The cast patch changes three functions: the two hand-written GType init
callbacks get their second argument, and the destroy callback its declared
pointer type. Its connected settings handlers already have their full declared
signature.

The `setup` property is inert because spawning a desktop settings application
has no meaning here. There is no module shutdown ABI, so `ibus_hangul_exit`
does not run. `preedit-mode`
is copied into a live engine on focus/capability updates, so changing it takes
effect after refocus.

## Cast audit

`tools/cast-audit/` is a TypeScript tool with dependencies isolated in
`tools/package.json`. It consumes Clang SARIF diagnostics using
`@microsoft/sarif` types and parses the C/C++ source with native `tree-sitter`
and the C/C++ grammars. The Nix wrapper uses the engine's real compiler flags
and writes a structured `report.json`.

Each engine commits a JSONC allow-list with the editor schema
`tools/cast-audit/cast-audit.schema.json`. Entries identify a diagnostic and
explain why its source/target types are safe; stale or unmatched allowances
fail. Intentional `GCallback` target casts are excluded; generic `void (*)(void)`
casts remain subject to the exact allow-list. This checks explicit casts; it does
not yet audit callback arity at
signal connection time. The allow-list is validated against that schema
(Ajv) each time the audit runs, so a misspelled or extra field, or an entry
without a reason, fails.

`checks.hangul-cast-audit` runs the audit twice: over the engine, whose
sources, flags and pkg-config modules come from the overlay's `passthru`
(`auditSources`, `auditCflags`, `auditPkgConfigModules`), with the patches
applied, and over the private libhangul linked into `hangul.wasm`, with its own
configured `config.h` and allow-list (`engines/hangul/libhangul-cast-audit.jsonc`).
Hangul's unpatched report contains three findings; its patched report and
allow-list are empty, and libhangul has no findings. A separate import check
verifies the side module against the runtime's export manifest.

## Golden tests

`checks.hangul-golden` is a g_test program, built as a main module with
assertions and run through the test-program shim under Node. The memory-root
WasmFS mounts only the package's data and side-module directory. The harness
initializes the runtime, applies an Init snapshot, loads the real side module,
and creates a fresh input context per case. Engine settings are module
globals, so before each case the fixture resets every key of the Hangul and
panel schemas to its default, except `hanja-keys`, which gets Init's value. It
sends framed protocol requests,
pumps, and decodes owned output records with GVariant and IBus serialization.
Keys use US keysyms, evdev keycodes, modifiers and releases.

Sixteen cases cover Latin mode, Hangul composition and CapsLock, BackSpace,
focus/reset, Hanja keyboard and click selection (after paging forward), paging
and invalid digits, clicks no visible label has, settings, destruction,
password fields, surrounding text, enable, and commit/forward ordering. The idle-settings case destroys the last engine, changes
the keyboard and Hanja hotkey, then uses both after recreation without a resend.
Warnings and errors fail the harness. All four port bugs were reproduced before
their fixes. The harness holds a weak pointer to each engine and asserts that
`DestroyEngine` frees it; the lifecycle case also counts the `changed` handlers
on the module's GSettings objects, of which none may have the destroyed engine
as data, leaving only the module handler on each.

Preedit attributes are compared after IBus normalizes their endpoints: `-1`
means the actual text length, and an empty underline range is omitted. Cached
surrounding text and cursor change on deletion; upstream leaves the selection
anchor until the next host update. The tests preserve that behavior.

`checks.hangul-differential` runs ten engine-owned traces against the stock
native Hangul engine and the WASM side module. It compares typed replies and
engine signals in order, then checks scenario-specific coverage on both sides.
The corpus covers composition, reset/focus, Hanja selection and paging,
surrounding deletion, password fields, forwarding, and initial F8/layout 39
settings. The stock engine emits five extra signals after an invalid digit on
the final candidate page and prints two GLib criticals. That narrow, versioned
outcome is declared in the engine directory; all preceding and subsequent
records still have to match. The `hanja-click-page` trace pages forward and
back before it clicks, on the first page: stock ibus-hangul, lacking port 0004,
reads the index as absolute and diverges from page 2 on, and an expected
difference can only excuse extra native records, so page-2 clicks are covered
by the golden tests alone. See [the test adapter](../tools/ibus-test/README.md)
for the retained artifacts and expected-difference contract.

The page must eventually commit COMMIT-mode preedit on blur and
reset. Without `IBUS_CAP_SYNC_PROCESS_KEY_V2`, space passes through after the
engine commits; with it, the engine consumes space and emits `ForwardKeyEvent`
after `CommitText`. M1.4's router must choose capabilities accordingly.
