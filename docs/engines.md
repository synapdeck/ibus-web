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

Hangul has **two port patches and one cast patch**. The port patches disconnect
settings handlers on destruction and reject candidate digits beyond the last
page. The cast patch repairs two hand-written GType init callbacks' arity and
the destroy callback's pointer type. Its connected settings handlers already
have their full declared signature.

The `setup` property is inert because spawning a desktop settings application
has no meaning here. There is no module shutdown ABI, so `ibus_hangul_exit`
does not run. Global settings change only through live engines' callbacks;
a change with no engine alive does not refresh those globals. `preedit-mode`
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
fail. Intentional `GCallback` and generic `void (*)(void)` target casts are
excluded. This checks explicit casts; it does not yet audit callback arity at
signal connection time. Hangul's unpatched report contains three findings;
its patched report and allow-list are empty. A separate import check verifies
the side module against the runtime's export manifest.

## Golden tests

`checks.hangul-golden` is a g_test program, built as a main module with
assertions and run through the test-program shim under Node. The memory-root
WasmFS mounts only the package's data and side-module directory. The harness
initializes the runtime, applies an Init snapshot, loads the real side module,
and creates a fresh input context per case. It sends framed protocol requests,
pumps, and decodes owned output records with GVariant and IBus serialization.
Keys use US keysyms, evdev keycodes, modifiers and releases.

Fourteen cases cover Latin mode, Hangul composition and CapsLock, BackSpace,
focus/reset, Hanja keyboard and click selection, paging and invalid digits,
settings, destruction, password fields, surrounding text, enable, and
commit/forward ordering. Warnings and errors fail the harness. Both port bugs
were reproduced before their fixes; the lifecycle test observes destruction
and a subsequent unwanted callback rather than relying on freed memory to trap.

Preedit attributes are compared after IBus normalizes their endpoints: `-1`
means the actual text length, and an empty underline range is omitted. Cached
surrounding text and cursor change on deletion; upstream leaves the selection
anchor until the next host update. The tests preserve that behavior.

These tests exercise the actual WASM engine, but do not compare it with a native
IBus reference. M1.3 supplies the TypeScript/SAB conformance harness; a native
differential adapter can reuse the event traces and compare at the engine
D-Bus boundary. The page must eventually commit COMMIT-mode preedit on blur and
reset. Without `IBUS_CAP_SYNC_PROCESS_KEY_V2`, space passes through after the
engine commits; with it, the engine consumes space and emits `ForwardKeyEvent`
after `CommitText`. M1.4's router must choose capabilities accordingly.
