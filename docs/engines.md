# Engines

`engines/<name>/` owns an engine's overlay, package output, module entry point, patches, cast allow-list and checks. The
top-level flake imports that tree. Hangul is the first port:

```sh
nix build .#ibus-web-hangul
nix build .#checks.x86_64-linux.hangul-golden
nix build .#checks.x86_64-linux.hangul-cast-audit
```

The package contains `hangul.wasm`; `ibus-web-hangul-dist` adds a manifest and store-path data archives. Its module
links engine code and private libhangul, importing IBus, GLib and system libraries from `ibus-runtime.wasm`. It is
GPL-2.0-or-later. The internal option is `ibusWeb.engines.hangul`; the public package is `packages.ibus-web-hangul`.

## Build and data

The WASM-gated overlay overrides the pinned nixpkgs `ibus-engines.hangul` recipe (ibus-hangul 1.5.5), keeping its source
and patches. It replaces the desktop dependency set, including propagated inputs, and builds through upstream's own
Autotools: `configure`, with `--datadir` and `--localedir` in the `data` output, then `make` for `src/libinternal.a`,
which holds `engine.c` and `ustring.c`. configure requires GTK for the setup tool, which isn't built, so the overlay
presets `GTK_CFLAGS` and `GTK_LIBS` to skip that query. Our `module.c` compiles with the flags make used for the
library, queried from the generated Makefile, plus `IBUSWEB_SETTINGS_SCHEMA_DIR`. The link of the archive and module
into `hangul.wasm` is ours, since upstream builds only the desktop `ibus-engine-hangul` executable, and
`make -C data install-symboltableDATA` installs the symbol table. Cross `pkg-config` supplies compile flags. Only
private libhangul contributes link libraries; the shared `checkSideModuleLibraries` guard rejects runtime libraries
accidentally added by pkg-config.

Engine data keeps the paths compiled by Nix. Private libhangul's Hanja table and ibus-hangul's symbols retain their
respective `/nix/store/<hash>-<name>` paths; no FHS path patch is needed. libhangul keeps the Hanja dictionary open and
seeks through it. The host mounts the version's data database at `/nix/store`, while user files stay at
`/engines/<encodeComponent(name)>`, one directory under `/engines` whatever the name holds.

The data closure is the side module's Nix store references, minus its own output. Every dependency must be data only:
dictionaries, schema XML and `gschemas.compiled`, without runtime libraries, development files or compilers. The schema
output includes Hangul and `org.freedesktop.ibus.panel`. The cross GLib compiler named by `gio-2.0.pc` runs under Node
with `--strict`. Hangul's module retains the schema directory string as a store reference; the host sets
`GSETTINGS_SCHEMA_DIR` to the manifest's `settingsSchemaDir` before any Init, since GLib caches its schema source on the
first lookup.

### Distribution manifest

`ibusWeb.engines.mkEngineManifest` takes `name`, `package`, `threads`, `heapBytes`, `settingsSchemaDir`, `engines`,
`settingsSchemas` and, for relocatable schemas, `settingsPaths` and optionally `settingsPatterns`. `engines`, the
module's engine descriptors, and `settingsSchemas`, its schema ids, are each a Nix list or a JSON file another
derivation builds, as `settingsPaths` is an attribute set (schema id to its paths) or such a file; a descriptor may
carry `data`, the store paths of the closure it alone needs, which the build checks with the rest of the manifest; the
manifest's own check validates them, so evaluation never reads a build output. It derives license and the upstream
version from the package, runtime ABI and protocol from the build. The license is the conjunction of the package's
`meta.license`, normalized by `ibusWeb.lib.spdxExpression`: it runs aboutcode's `license-expression` over the SPDX ids,
which writes each license once under its current identifier (`GPL-2.0` becomes `GPL-2.0-only`) and fails on an id SPDX
doesn't know. It merges no license into another: `GPL-2.0-only AND GPL-2.0-or-later` stays as it is, since the
expression records what the contents carry, not the terms they can be passed on under. Build:

```sh
nix build .#ibus-web-hangul-dist
```

The output contains `manifest.json`, generated `settings.json`, `hangul.wasm`, and one `data/<hash>-<name>.tar.br` per
closure store path. A module is one such distribution, run in one Worker; its engines are the input methods inside it,
each created by name with `CreateEngine`. `ModuleManifest` and `EngineDescriptor` in `@ibus-web/protocol` have these
fields:

```ts
type ModuleManifest = {
  name: string;
  version: string;
  license: string;
  runtimeAbi: number;
  runtimeIdentity: string;
  protocol: number;
  module: { url: string; size: number };
  memory: number;
  threads: number;
  data: { storePath: string; url: string; size: number; files: number; encoding: "br" | "identity" }[];
  settingsSchemaDir: string;
  engines: EngineDescriptor[];
  settingsSchemas: string[];
  settingsMetadata?: { url: string; size: number };
};

type EngineDescriptor = {
  name: string;
  displayName: string;
  languages: string[]; // BCP 47
  keyboard: { layout: "us" | "default"; passThrough: string[] };
  data?: string[]; // store paths of `data` this engine alone needs
};
```

An archive's `size` is the bytes of file data it installs, and `files` its entries, the store path's own directory,
every directory, file and link under it, each of which WasmFS's memory backend keeps an object for where the data is
installed in memory ([storage.md](storage.md#without-indexeddb-the-memory-fallback)).

`settings.json` comes from the compiled schema directory via pinned GLib running under WebAssembly, then the strict
TypeScript GVariant decoder. It records each listed schema's paths (a fixed schema's own path; a relocatable schema's
paths from the manifest's `settingsPaths`, which the build fails without), key names/types, defaults, descriptions and
any range/choices supplied by GLib. `settingsPatterns` gives a relocatable schema, by id, a `pattern` for its paths, in
which `{name}` stands for one or more characters other than `/`; the build fails if one of its paths doesn't match.
`Init` then declares the schema by its pattern and carries only those of its instances that have stored values, so a
module with an instance per engine, as m17n has 197, doesn't send them all at every start. The page fetches it through
`settingsMetadata` before Init, validates settings and constructs a metadata-driven form. Hangul's keyboard key has no
generated choices. An engine's `keyboard.layout = "us"` translates physical `event.code` positions; `"default"` uses
translated `event.key`. This engine keyboard preference is not an OS keyboard-layout detector. The first engine is the
module's default. Hangul's manifest lists one engine: `hangul`, "Hangul", `["ko"]`, with the US layout and no
pass-through keys.

`version` is an immutable distribution identity: `<upstream-version>+nix.<output-hash>`. The hash comes from the
distribution's Nix output path, covering its build recipe and inputs, including the module, data/schema closure,
runtime, protocol and manifest metadata. Identical builds retain the identity; rebuilds with changed inputs receive a
different one even when the upstream version is unchanged. This is a Nix build identity, not a digest computed from the
archive bytes. Hosts use the entire version for data-cache and installation-lock namespaces, so a new build can install
while an older host continues reading its own closure. Manually authored manifests must likewise change version whenever
their distribution changes.

`decodeModuleManifest` enforces:

- `name` matches `[A-Za-z0-9][A-Za-z0-9._+-]*`: it becomes a directory and database name, so it must be one path
  component that can't climb out of its parent or hide itself;
- `version`, `license` and every URL are non-empty; `engines` lists at least one engine, with non-empty, unique names
  and non-empty display names;
- `memory` is bytes in whole 64 KiB pages within the runtime bounds; `threads` is a nonnegative engine pool share;
- each `storePath` is `/nix/store/<32 base-32 characters>-<name>`, with no two alike;
- each engine's `data` names store paths of the manifest's `data`, none twice;
- `settingsSchemaDir` is canonical (no empty, `.` or `..` component) and lies inside one of the data's store paths, and
  not inside one an engine names, since `Init` reads the schemas before any engine is made;
- unknown keys are rejected at every level, so a misspelled field fails rather than reading as missing.

The host validates the manifest before allocating runtime resources and rejects ABI/protocol mismatches: `runtimeAbi`
must be `IBUSWEB_RUNTIME_ABI`, and `runtimeIdentity`, a SHA-256 in lowercase hexadecimal, the runtime's identity over
its libraries' versions and exports ([runtime.md](runtime.md#the-export-list)).

The build computes memory as `(runtime minimum + threads × 1 MiB + heapBytes) × 1.25`, rounded up to whole MiB.
`heapBytes` is build/check metadata, not a manifest field: the declared peak of the heap, measured from its base, which
holds the side module's static data too, since the module is allocated there as it loads. `checks.hangul-host` fails if
the measured heap peak (`heapPeak`) exceeds `heapBytes` or engine thread demand exceeds `threads`. Hangul declares a 6
MiB heap and zero threads, several MiB over its Node conformance workload's peak; the formula adds headroom separately.
Browser storage threads belong to the runtime's storage share.

### An engine's own data

A store path any engine names in its descriptor's `data` is that engine's own: the host installs it the first time a
page prepares the engine, before its first `CreateEngine` in a Worker, rather than at start
([storage.md](storage.md#an-engines-own-data)). The rest of the closure is the module's base data, installed at start.
`lazyStorePaths(manifest)` in `@ibus-web/protocol` gives the former. Per-engine data suits large, optional data that an
engine alone uses, such as Rime's dictionaries, of which a user downloads only those of the schemas they type in. Data
every engine reads, or that the module reads as it starts, stays base data: m17n keeps its whole closure there, since it
is 1.5 MB as Brotli and ibus-m17n reads every input method's file as it lists them at startup. A store path several
engines name is installed once, by whichever is prepared first.

### Archives and serving

Each archive is deterministic pax, POSIX's extension of ustar, Brotli quality 11 and the standard window (no
`--large_window`). GNU tar writes it with `ibusWeb.lib.archiveTarFlags`: pax keeps a name or a link target longer than
ustar's 100 bytes in an extended header, as Rime's common data needs for its links into the dictionaries' store paths,
and the flags drop pax's own `atime` and `ctime` records and name the extended headers without the writer's pid, so the
same tree always gives the same bytes; the host's test archives are built twice with their times changed to check that.
Entries are named from `/nix/store`: `<hash>-<name>/…`, or the bare `<hash>-<name>` file for a store path that is a
single file. `--hard-dereference` stores hard links, which store optimisation makes of identical files, as regular
files, since the installer takes none. Symbolic links are kept as links, with their targets as the store has them;
before archiving, `tools/engine-manifest/symlinks.ts` resolves every link in the closure the way the engine's file
system will, holding only the closure's store paths, and fails the build if one leads outside them. `size` counts
unpacked regular-file bytes, every name of a hard-linked file in full and nothing for a symbolic link.

The host extracts each archive at the root of the `/nix/store` mount, decoding it with `modern-tar`'s strict decoder and
writing each entry through WasmFS's `FS` as it arrives ([storage.md](storage.md#installing)). Since every archive lands
there, the host refuses an entry outside the archive's own store path before writing anything of it. It takes regular
files, directories and symbolic links, keeping a link's target unresolved; it refuses hard links with `-EOPNOTSUPP` and
never writes through a link: an entry under one fails with `-ENOTDIR`, and a file or link replaces a link already at its
name. Before creating or sizing each regular file, the host rejects one that would exceed the remaining declared budget.
It also requires exact equality after extraction before writing the installed marker. A mismatch is an ordinary
installation refusal; a corrected retry reinstalls. This limit excludes tar headers and padding, decoder buffers and
file-system metadata, so it is not a total-memory or quota bound. Serve `.tar.br` as opaque bytes, **without
`Content-Encoding: br`**: fetch must not decompress it before the host. `encoding: "identity"` supports plain tar
fixtures.

Relative module/archive URLs in a fetched manifest resolve against the final response URL after redirects. Inline
manifests retain the caller's URLs.

The host constructs `DecompressionStream("brotli")` to detect native support. Otherwise it imports, by URL from beside
its own script, a separate `brotli-dec-wasm` streaming decoder bundle (`brotli-fallback.js`, 291 KB) with its WASM
embedded by Rolldown's binary loader. No external decoder WASM fetch is needed, and native installations never load that
bundle. Both paths feed the tar decoder in pieces of at most 64 KiB. Only a failure that starts in the decoder is
reported as a Brotli error, with the hint about `Content-Encoding: br`; a failure of the body itself (the network, an
abort) passes through as it is, and a fallback that fails to load says so.

### npm package

`packages/engines/hangul/` is `@ibus-web/engine-hangul`, the package that will put this distribution on npm. It holds
only its `package.json` and README, since Nix builds its contents: `nix build .#npm.engine-hangul` copies
`ibus-web-hangul-dist` into it as `dist/`, adds the license texts of the engine and libhangul to `LICENSES/`, and packs
it with `ibusWeb.typescript.npmTarball`, which fails unless the package's `license` is the engine's `meta.license` as
`spdxExpression` normalizes it, the manifest's license. `checks.typescript-npm` builds it with the other tarballs. It
exports `manifest.json`, `hangul.wasm`, `settings.json` and `data/*`. A host serves `dist/` as it is and passes
`manifest.json`'s URL to ibus-web.

## Startup and patch layers

`ibusweb_module_init` calls `ibus_hangul_init(NULL)`, registers `ibus_hangul_exit` as the module's shutdown function
(`ibusweb_module_set_shutdown`), creates an `IBusFactory`, registers the `hangul` engine type and releases its
reference. The runtime's registry retains the factory. Send the Init settings snapshot before loading the module:
upstream initialization reads those settings into globals. Contexts use `FocusIn` and `FocusOut`; the protocol has no ID
variants.

Local patches follow nixpkgs' patches, with `port` before `casts`, each sorted by filename. `port` holds build/startup
adaptations and engine behavior fixes; `casts` holds exact callback-type fixes and can be removed independently if a
future toolchain makes it unnecessary. Keep patches as `git format-patch` commits against the pinned source. Their
[inventory](../engines/hangul/patches/README.md) records reasons and upstream status.

Hangul has **four port patches and one cast patch**. The port patches:

- 0001 disconnects an engine's settings handlers on destruction.
- 0002 rejects candidate digits beyond the last page.
- 0003 keeps global settings current with no live engine: one module listener, connected at init, updates the globals,
  and instance handlers only reselect their context's keyboard. Settings upstream reads only at initialization, such as
  `disable-latin-mode`, stay init-only.
- 0004 treats a `CandidateClicked` index as page-relative, the position of the clicked label on the visible page, as the
  IBus panel sends it, and ignores a click no visible label has (at or past the page size, or past the last candidate of
  a short final page). Upstream reads the index as absolute, and a cursor past the candidates fails the `g_assert` in
  `ibus_lookup_table_set_cursor_pos`.

The cast patch changes three functions: the two hand-written GType init callbacks get their second argument, and the
destroy callback its declared pointer type. Its connected settings handlers already have their full declared signature.

The `setup` property is inert because spawning a desktop settings application has no meaning here. `ibus_hangul_exit`
runs from the `Shutdown` request the page sends before it ends the Worker; `checks.hangul-host` sends it after `Persist`
with an engine still open and checks that it logs nothing and that every later request is refused. `preedit-mode` is
copied into a live engine on focus/capability updates, so changing it takes effect after refocus.

## Cast audit

`tools/cast-audit/` is a TypeScript tool with dependencies isolated in `tools/cast-audit/package.json`. It consumes
Clang SARIF diagnostics using `@microsoft/sarif` types and parses the C/C++ source with native `tree-sitter` and the
C/C++ grammars. The Nix wrapper uses the engine's real compiler flags and writes a structured `report.json`.

Each engine commits a JSONC allow-list with the editor schema `tools/cast-audit/cast-audit.schema.json`. Entries
identify a diagnostic and explain why its source/target types are safe; stale or unmatched allowances fail. Intentional
`GCallback` target casts are excluded; generic `void (*)(void)` casts remain subject to the exact allow-list. This
checks explicit casts; it does not audit callback arity at signal connection time. The allow-list is validated against
that schema (Ajv) each time the audit runs, so a misspelled or extra field, or an entry without a reason, fails.

`checks.hangul-cast-audit` runs the audit twice: over the engine, whose sources and flags come from the overlay's
`passthru` (`auditSources`, `auditCflags`), with the patches applied and the engine's own configure run supplying
`config.h` and the Makefile the flags are read from, and over the private libhangul linked into `hangul.wasm`, with its
own configured `config.h` and allow-list (`engines/hangul/libhangul-cast-audit.jsonc`). Hangul's unpatched report
contains three findings; its patched report and allow-list are empty, and libhangul has no findings. A separate import
check verifies the side module against the runtime's export manifest. Mozc's flags exist only inside its Bazel build, so
its audit pass runs there, beside each compile ([mozc.md](mozc.md#build)), and `checks.mozc-cast-audit` compares what it
found. A library too large to list file by file passes `sourcesFrom`, a shell command that prints its sources, in place
of `sources`: `checks.rime-cast-audit` reads each CMake target's sources from `compile_commands.json` and its flags from
the target's `flags.make` ([rime.md](rime.md#checks)). A command that fails, or a list with no source, fails the audit,
which `checks.engines-cast-audit-unlisted` proves.

## Golden tests

`checks.hangul-golden` is a g_test program, built as a main module with assertions and run through the test-program shim
under Node. The memory-root WasmFS mounts only the package's data and side-module directory. The harness initializes the
runtime, applies an Init snapshot, loads the real side module, and creates a fresh input context per case. Engine
settings are module globals, so before each case the fixture resets every key of the Hangul and panel schemas to its
default, except `hanja-keys`, which gets Init's value. It sends framed protocol requests, pumps, and decodes owned
output records with GVariant and IBus serialization. Keys use US keysyms, evdev keycodes, modifiers and releases.

Sixteen behavioral cases cover Latin mode, Hangul composition and CapsLock, BackSpace, focus/reset, Hanja keyboard and
click selection (after paging forward), paging and invalid digits, clicks no visible label has, settings, destruction,
password fields, surrounding text, enable, and commit/forward ordering. The idle-settings case destroys the last engine,
changes the keyboard and Hanja hotkey, then uses both after recreation without a resend. Warnings and errors fail the
harness. All four port bugs were reproduced before their fixes. The harness holds a weak pointer to each engine and
asserts that `DestroyEngine` frees it; the lifecycle case also counts the `changed` handlers on the module's GSettings
objects, of which none may have the destroyed engine as data, leaving only the module handler on each.

Preedit attributes are compared after IBus normalizes their endpoints: `-1` means the actual text length, and an empty
underline range is omitted. The runtime's cached surrounding text, cursor and selection anchor all change on deletion,
the anchor moving with the text around it; upstream IBus leaves the anchor until the next host update.

`checks.hangul-differential` runs ten engine-owned traces against the stock native Hangul engine and the WASM side
module. It compares typed replies and engine signals in order, then checks scenario-specific coverage on both sides. The
corpus covers composition, reset/focus, Hanja selection and paging, surrounding deletion, password fields, forwarding,
and initial F8/layout 39 settings. The stock engine emits five extra signals after an invalid digit on the final
candidate page and prints two GLib criticals. That narrow, versioned outcome is declared in the engine directory; all
preceding and subsequent records still have to match. The `hanja-click-page` trace pages forward and back before it
clicks, on the first page: stock ibus-hangul, lacking port 0004, reads the index as absolute and diverges from page 2
on, and an expected difference can only excuse extra native records, so page-2 clicks are covered by the golden tests
alone. See [the test adapter](../tools/ibus-test/README.md) for the retained artifacts and expected-difference contract.

The page commits COMMIT-mode preedit on blur and reset, and never advertises `IBUS_CAP_SYNC_PROCESS_KEY_V2`
([core.md](core.md#adapter-and-client-duties)). Without it, space passes through after the engine commits; with it, the
engine would consume space and emit `ForwardKeyEvent` after `CommitText`.

The shim reports 17 golden tests, including its run-completion check. The
[Worker-host conformance harness](worker-host.md#transport-and-hangul-conformance) is a separate Node check: ten
scenarios on each asserting/released build, 20 reported tests. It runs the real engine through SAB requests and records
rather than calling WASM directly, and guards the declared heap and thread share. Neither harness establishes live
browser UI behavior or device input behavior.

## MARISA

`modules/marisa/_marisa.nix` overrides nixpkgs' MARISA 0.3.1 for two builds: `pkgsWasm.marisa`, through
`flake.overlays.marisa`, which the table engine and librime link, and the build machine's, `ibusWeb.marisa`, which
native tools such as the table engine's link. It adds upstream [PR #146](https://github.com/s-yata/marisa-trie/pull/146)
(commit `e31c7ed`) with `fetchpatch`: 0.3.1 reads uninitialized units while packing a `FlatVector`. It turns off tuning
for the build machine (`ENABLE_NATIVE_CODE`) and the command-line tools, which no module uses, and records the
BSD-2-Clause option of MARISA's dual licence. Upstream's tests run in the check phase wherever the build can run them,
which is the native build: that build is the `marisa-tests` check, which also asserts that the WebAssembly build carries
the same patches. Each side module still links its own static copy.

## The table module

`engines/table/` is ibus-web's own module: two engines, `latex` and `xsampa`, over one C++23 side module.
[table.md](table.md) describes the table format, the engine and its glue.

```sh
nix build .#ibus-web-table-dist
nix build .#checks.x86_64-linux.table-host
```

`ibus-web-table-dist` is `mkEngineManifest` over `table.wasm`. Its engine descriptors come from the tables' frontmatter:
`table-describe` prints them as JSON and the manifest build reads that file, so Nix needs no build output at evaluation
time. `latex` comes first and is the module's default. The data closure is the two tables and the compiled
`org.freedesktop.ibus.panel` schema, the module's only settings schema. The manifest's licence is
`(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C`: the engine, MARISA linked into it, and the LaTeX table's data. It
declares no engine threads and a 6 MiB heap that `checks.table-host` checks with both tables loaded.

The module ships as `@ibus-web/engine-table` (`packages/engines/table/`), packed as Hangul's is:
`nix build .#npm.engine-table` copies `ibus-web-table-dist` in as `dist/` and adds the MIT, Apache-2.0 and W3C texts to
`LICENSES/` and MARISA's own `COPYING.md`, taken from its source, as `LICENSES/marisa/COPYING.md`, and `npmTarball`
fails unless `package.json`'s `license` is the module's. It exports `manifest.json`, `table.wasm`, `settings.json` and
`data/*`.

The first `CreateEngine` of `latex` in a Worker parses the LaTeX table and builds its MARISA trie: 7.5 ms under Node on
the released runtime, against 1.1 ms for a second context, which shares the parsed table. `checks.table-host` records
both as `Table released LaTeX load`. There is no target until there is a baseline; this is the baseline.

## Mozc

`engines/mozc/` is Mozc's converter, with nixpkgs' UT dictionaries, and its own IBus frontend in one side module,
`mozc.wasm`, built through nixpkgs' Bazel recipe, with the frontend talking to the converter in-process instead of to
`mozc_server`. Its three engines are `mozc-jp`, `mozc-on` and `mozc-off`. [mozc.md](mozc.md) describes its build,
startup, distribution and checks.

```sh
nix build .#ibus-web-mozc-dist
nix build .#checks.x86_64-linux.mozc-host
```

## m17n

`engines/m17n/` is ibus-m17n with m17n-lib and m17n-db in one side module, `m17n.wasm`, built through nixpkgs' Autotools
recipes. Its 197 engines, `m17n:<lang>:<name>`, are the input methods ibus-m17n lists, and their descriptors come from
that same listing, run at build time. [m17n.md](m17n.md) describes its build, startup, engines, settings, distribution,
the browser and checks.

```sh
nix build .#ibus-web-m17n-dist
nix build .#checks.x86_64-linux.m17n-host
```

## Rime

`engines/rime/` is ibus-rime with librime, its Lua and grammar plugins and their libraries in one side module,
`rime.wasm`, built through nixpkgs' CMake recipes, with `rime-data`, `rime-loengfan` and `rime-ice` deployed at build
time by librime's own deployer, built for WebAssembly. Its 47 engines, `rime:<schema_id>`, are the schemas that type,
and their descriptors come from the deployed configs, read through librime. [rime.md](rime.md) describes its build,
deployment, startup, engines, settings, switches as properties, per-engine data, the distribution and npm package, the
browser and the checks.

```sh
nix build .#ibus-web-rime-dist
nix build .#checks.x86_64-linux.rime-host
nix build .#npm.engine-rime
```
