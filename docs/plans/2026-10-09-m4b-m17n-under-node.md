# M4 Phase 2: m17n under Node — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase 2 of `docs/specs/2026-10-09-m4-m17n.md`: the runtime giving an engine its context while it is being made; m17n-lib, m17n-db and ibus-m17n for `pkgsWasm`; the side module `m17n.wasm` and its startup; the descriptor program and the TypeScript step that turns its output into the engine descriptors, the settings paths and the variable schemas; `variables.c`; and the checks `m17n-golden`, `m17n-engines`, `m17n-descriptors`, `m17n-imports`, `m17n-data-closure` and `m17n-cast-audit`, all under Node. The distribution, npm package, `m17n-host`, demo and Playwright are phase 3.

**Architecture:** `flake.overlays.m17n` overrides nixpkgs' `m17n_lib` and `ibus-engines.m17n` and keeps their Autotools builds. One configured ibus-m17n tree serves two derivations: a descriptor program, a WebAssembly main program linked with libibus-web, `libm17ncommon` and m17n-lib that runs under Node at build time and prints every engine ibus-m17n lists with its input method's variables as JSON; and `m17n.wasm`, built after it. A TypeScript step, the private workspace package `@ibus-web/m17n-descriptors`, turns the program's JSON into `engines.json`, `settings-paths.json`, `settings-schemas.json`, the variable schemas' XML, a C table of the variables and a list of settings instances. The variable schemas compile with ibus-m17n's and the panel's into the directory `m17n.wasm` keeps in its closure, and `variables.c` applies their values with `minput_config_variable` at module init and on each change. Golden and all-engines g_test programs drive the real module through the runtime under Node, with Init built from the step's instance list.

**Tech Stack:** C (GLib/GIO 2.88, IBus 1.5.34 headers, m17n-lib 1.8.6, Emscripten), TypeScript 7 on Node 26, Vitest, Autotools, Nix flake-parts, hk, oxfmt, clang-format.

## Global Constraints

- Work on branch `typedrat/m4b-m17n-under-node`, cut from the result of `typedrat/m4a-settings-by-path` (phase 1). Everything here uses phase 1's interfaces: `Init` is `(ua(ssa{sv}))`, one `(schemaId, path, values)` per instance; `SettingChanged` and `SettingWritten` are `(ssv)` of `(path, key, value)`; `mkEngineManifest` and `mkSettingsMetadata` take `settingsPaths` (an attribute set from schema id to paths, or a JSON file of that shape); libibus-web provides `ibus_engine_simple_add_table_by_locale` and a real `ibus_keymap_get("us")`.
- Names phase 3 relies on are fixed (see [Interfaces](#interfaces-phase-3-relies-on)): `engines/m17n/` and its layout; `pkgsWasm.m17n_lib`, `pkgsWasm.ibus-web-m17n-db`, `pkgsWasm.ibus-engines.m17n`; the option `ibusWeb.engines.m17n`; `packages.ibus-web-m17n`; the checks `m17n-golden`, `m17n-engines`, `m17n-imports`, `m17n-data-closure`, `m17n-cast-audit`, `m17n-descriptors`.
- Run every command inside the dev shell (`nix develop -c …`) from `/home/awilliams/Development/ibus-web` (or the worktree for the branch). `git add` a new file before any `nix` command that should see it: the flake only reads files git tracks.
- Commit with `nix develop -c git add <paths>` then `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths>`, in Conventional Commits. Stage named paths only, never `git add -A` or `git add .`. No attribution trailers. If hk's hook rewrites a file (clang-format, nixfmt, oxfmt), re-add it and commit again; never bypass the hook (`--no-verify` is forbidden).
- Comments explain why, never what; no history ("now", "previously"), no references to other files, plans or pull requests, no "NOTE:". Match the file's comment density. Separate logical blocks with one blank line; never a blank line right after an opening token or right before a closing one, nor between a comment and the code it describes. Never whitespace-minimize code.
- Licences: everything under `engines/m17n/` is GPL-2.0-or-later (ibus-m17n's), with SPDX headers in each file that can hold one; m17n-lib's patches are LGPL-2.1-or-later; `REUSE.toml` covers the patches. Our C follows the repository's `.clang-format` (LLVM); upstream files keep upstream's formatting.
- Docs change in the same commit as the code they describe. Format Markdown with `nix develop -c oxfmt <file>`; **never run oxfmt on `docs/plans/`**.
- Generated files are never edited by hand: `pnpm-workspace.yaml` comes from `modules/typescript/files.nix` through `nix run .#write-files`. `pnpm-lock.yaml` comes from `pnpm install`.
- Stay close to nixpkgs: override the recipes, keep upstream's build systems, and add only what WebAssembly needs.
- Run checks with `nix build .#checks.x86_64-linux.<name> -L`. Report which ran and what failed; never summarize a check you didn't run as passing.

### Decisions this plan makes where the spec is silent

- **Context during construction.** `IBusEngine`'s instance init sets the engine's context from a new internal getter, `ibusweb_factory_creating_ic()`, which returns the context of the `CreateEngine` under way and 0 outside one. An engine made outside a `create-engine` emission starts on context 0, as before. `ibusweb_engine_set_ic` stays for engines a handler returns that were made elsewhere.
- **`load_external_module` without `dlopen`.** m17n-lib's port patch 0002 is upstream-shaped rather than `#ifdef __EMSCRIPTEN__`: it moves configure's `AC_SEARCH_LIBS(dlopen)` out of the GUI block, where `--without-gui` skipped it, and guards the loader calls in `input.c` with `HAVE_DLOPEN`, failing a module's load as a missing module file already does. Emscripten's libc has a `dlopen`, so the overlay answers `ac_cv_search_dlopen=no`, the same way it answers the other checks a cross build can't make. A native build with GUI or without keeps loading modules.
- **No third m17n-lib patch and no `substituteInPlace` for `M17N_MODULE_DIR`.** With 0002, the only code that read `M17N_MODULE_DIR` is compiled out, so `m17n.wasm` holds no module directory and no reference to m17n-lib's output; `m17n-data-closure` checks this exactly. (The spec asks for the directory to become "a fixed path outside the store"; see the departures below.)
- **m17n-lib's `example/` programs** aren't built: `postPatch` drops `example` from the top-level `SUBDIRS`. A `makeFlags` override doesn't work, since make passes a command-line `SUBDIRS` to every sub-make.
- **Patch layers.** `patches/<library>/{port,casts}/`, applied `port` then `casts`, each sorted by filename. A layer with no patch has no directory (git keeps no empty directory), and the overlay's `layer` helper returns no patches for a missing one. m17n-lib has only `port`; ibus-m17n has both.
- **The descriptor program's derivation.** It is `ibus-engines.m17n`'s configured tree with its own build and install phases, a derivation separate from `m17n.wasm`, so the schemas `m17n.wasm` compiles in can come from its output. It installs `default.xml` in its own `data` output, where its compiled `PKGDATADIR` points. It links as a test program does (`testLinkFlagsWithoutNodeFs`, memory root, `/nix/store` mounted from the host) with a 1 MiB stack, and de-duplicates its library words, since a main module links every archive whole and `m17n-shell` names `libm17n-core` twice.
- **Derivation order, no cycle:** `m17n_lib` (whose `M17NDIR` is `ibus-web-m17n-db`) → descriptor program → `ibus-web-m17n-descriptors` (the program's JSON and the step's files) → the compiled schema directory → `m17n.wasm`. The program links libraries, never `m17n.wasm`.
- **Where the TypeScript step lives.** In `engines/m17n/descriptors/`, a private workspace package `@ibus-web/m17n-descriptors` added to the workspace's package list (`modules/typescript/files.nix`), with its own `package.json`, `tsconfig.json`, `vitest.config.ts` and `checks.nix`. The build runs `node descriptors.ts` directly, as `tools/gschema/metadata.ts` is run; it imports only Node's built-ins.
- **The step's outputs**, in `ibus-web-m17n-descriptors`: `engines.json`, `settings-paths.json`, `settings-schemas.json`, `schemas/org.freedesktop.ibus.engine.m17n.variables.gschema.xml` (one file, every variable schema), `variable-table.h`, `instances.txt` and the program's own output as `raw.json`.
- **Ordering.** The default engine (the option `ibusWeb.engines.m17n.defaultEngine`, `m17n:t:latn-post`) first; the rest sorted by language, then input method name, comparing code points.
- **Display names.** `Intl.DisplayNames(["en"], { type: "language", fallback: "none" })`. Node's ICU names no language for `ath`, `cmc`, `dra`, `nsk` and `tai` (verified); those take ISO 639's reference names without "languages": Athapascan, Chamic, Dravidian, Naskapi, Tai. Any other unnamed language fails the build.
- **Layouts.** A raw layout that is neither `default` nor `default[…]` fails the build; m17n-db has only `default` (151) and `default[lv3:ralt_switch]` (46).
- **Settings paths** are computed as ibus-m17n computes them from its GType name: lowercase language and input method name, except that an all-uppercase name keeps its case (`sa:IAST` → `/org/freedesktop/ibus/engine/m17n/sa/IAST/`; `sa:IAST-vedic` → `…/sa/iast-vedic/`), because upstream retries the uppercase name when m17n knows none by the lowercase one. Two engines with one path fail the build.
- **Variable schema ids** use m17n's own language and name: `org.freedesktop.ibus.engine.m17n.<lang>.<name>`; their path is the engine's settings path plus `variables/`. glib-compile-schemas doesn't validate ids, and `--strict` accepts the 34 generated schemas (verified).
- **Variable keys.** `integer` → `i`; its valid values, discrete or a `(MIN MAX)` range, must form one range, which becomes `<range>` (m17n-db has only {0,1}, {0,1,2} or none); integer values that aren't one range, ranges mixed with values, or a default outside the range fail the build. `symbol` → `s` with `<choices>` when it has valid values (m17n-db's engines have no symbol variable). `text` → `s`, unconstrained (`t:unicode`'s `prompt`). A variable with no initial value fails the build. The m17n description becomes the key's `<description>`; there is no `<summary>`, since m17n's descriptions don't separate one (many wrap mid-sentence). The key-name rule is GLib's: a lowercase letter, then lowercase letters, digits and single hyphens, not ending in a hyphen, at most 1024 characters.
- **How `variables.c` knows the variables at runtime: a generated C table.** The step writes `variable-table.h`, an X-macro `IBUSWEB_M17N_VARIABLES(X)` with one `X(lang, name, schema, key, TYPE)` per variable, and `m17n.wasm` compiles with `-I` on the step's output. A table rather than enumerating schemas by id prefix because `minput_config_variable` needs m17n's language and name (which a schema id can't be parsed back into once names contain dots or case) and m17n's type (symbol and text both become `s`). The header holds no store path, so the step's output doesn't enter the module's closure.
- **`variables.c`** calls `minput_config_variable` for every variable at init, default values included, and on a schema's `changed` signal for the changed key; a refused value logs a warning, which fails the golden tests. Its `GSettings` objects live for the Worker's lifetime: the module ABI has no shutdown entry point.
- **Settings instances for test harnesses.** `instances.txt` lists one instance a line in the metadata tool's argument form: each fixed schema's id (the panel and every variable schema), then `org.freedesktop.ibus.engine.m17n=<path>` for each of the 197 engines. The harness looks each fixed schema's path up in the compiled schemas and sends one `Init` entry per line, as the page's `Init` lists every instance the metadata declares.
- **Golden scenarios** (all checked against the real data, see [what was verified](#what-was-verified-and-how)): Telex's `tone-mark-on-last` = 1 and Cangjie's `candidates-group-size` = 2 come from the Init snapshot; Cangjie paging needs the second, since no Cangjie code has more than six candidates; the variable contrast is Telex (`hoaf ` → `hoà `) against VNI at its default (`hoa2 ` → `hòa `); a variable changed before its engine's first context reaches it (VIQR: h, o, a, a grave accent and space commit `hoà `); the Thai deletion is Kesmanee at level 1 with `ก่` before the cursor and `h` (U+0E49): m17n replaces the tone mark, so `DeleteSurroundingText(-1, 1)` precedes the commit of `้`; two engines' settings apart is `use-us-layout` on `hi:inscript` but not `mr:inscript`, both of which map `x` to `ं` and `k` to `क`.
- **The m17n-engines keys** are `a`, `1`, space and BackSpace, each pressed and released.

### Where this plan departs from the spec

These are contradictions or gaps found while verifying; each is resolved as stated, and listed here rather than resolved silently. Phase 3, which updates the spec, should fold them in.

1. **ibus-m17n needs a port patch.** The spec says "ibus-m17n needs no port patch". `ibus_m17n_mtext_to_ucs4` (`m17nutil.c`) converts a `(len + 1) * 6`-byte buffer it never terminates, so `g_utf8_to_ucs4_fast` reads leftover allocation bytes as characters, and a lookup table built from an M-text candidate group gains candidates that were never in it. Under Node, with `candidates-group-size` 2, Cangjie's second page showed `涥 灜` plus a third, garbage candidate; with the patch, exactly two. Port 0001 adds `buf [utf8_converter->nbytes] = 0;`, as `ibus_m17n_mtext_to_utf8` already does.
2. **The spec's third m17n-lib port patch isn't needed** ("`M17N_MODULE_DIR` … becomes a fixed path outside the store"). With 0002, nothing compiled reads it; `strings` finds neither `m17n/1.0` nor `dlopen`/`dlsym`/`dlclose` in the patched `libm17n.a` (the unpatched one has three loader symbols and the directory).
3. **"41 of m17n-db's input methods declare variables"** counts `.mim` files, including `global.mim` and six methods that aren't engines (`ja:anthy`, `zh:py`, `zh:py-gb`, `zh:py-b5`, `zh:tonepy-gb`, `zh:tonepy-b5`). The engines with variables number **34**, with **53** variables, so 34 variable schemas.
4. **`settingsSchemas` is a JSON file, not a list.** The variable schema ids are known only after the descriptor program runs, so `ibusWeb.engines.m17n.settingsSchemas` is the path of `settings-schemas.json`. `mkEngineManifest` and `mkSettingsMetadata` take a list today (phase 1 keeps it a list); phase 3 has to let them take a JSON file, as `settingsPaths` already may.
5. **The descriptor program's file is `engines/m17n/descriptors/descriptors.c`**, not `engines/m17n/descriptors.c`, following the cross-phase layout (`descriptors/` holds the program and the TypeScript step).
6. **Variable changes reach an engine whose input method isn't open yet.** The spec says a change "takes effect when the module next starts". m17n applies a configured value to input methods opened afterwards; ibus-m17n opens each engine's input method with that engine's first context, so a change already reaches an engine not yet made in the Worker. The docs say both; `m17n-golden` tests the second.
7. **Phase 2's docs.** The spec's Delivery lists `docs/m17n.md` and `docs/known-gaps.md` under phase 3; this plan writes them with the code they describe, as the repository requires. Phase 3 adds the distribution, `m17n-host` and the demo to them.

### What was verified, and how

- **Builds and behaviour, in a scratch clone of `typedrat/m17n-spike`** (`nix build` only, master's runtime plus this plan's Task 1 fix): the m17n-lib patches as the Task 2 script makes them; `m17n.wasm` with them imports no loader symbol and its closure is exactly itself, its `data` output, `ibus-web-m17n-db` and the schema directory; the descriptor program as written here prints 197 engines, 34 with variables, 53 variables; `descriptors.ts` and both Vitest files here pass (32 tests) on that output, and glib-compile-schemas `--strict` compiles the variable schemas with ibus-m17n's; `variables.c` and `module.c` as written here, with Init values for Telex and Cangjie and a `SettingChanged` for VIQR (in master's schema-addressed protocol), give the results the golden cases expect; the golden harness and cases here, adapted only in how `Init` and `SettingChanged` address settings, pass 9 of 12 cases (all but `altgr`, `us-layout` and `settings-apart`, which need phase 1's keymap and relocatable settings); `m17n-engines`' program passes all 197 engines with no warning, in about 0.2 s; both cast audits pass, with `variables.c` among the engine's sources; Task 1's test fails without the fix (`assertion failed (GUINT32_FROM_LE(header.ic) == ic): (0 == 21)`) and `libibus-web-tests` passes with it.
- **By reading the sources:** m17n-lib 1.8.6 `src/input.c` (`load_external_module`, `unload_external_module`, `minput_get_variable`, `minput_config_variable`), `configure.ac`, `src/Makefile.am`, top-level `Makefile.am`; ibus-m17n 1.4.40 `src/engine.c` (class name scan, settings path, the `sa-IAST` retry, key handling, AltGr, `use-us-layout`, surrounding text callbacks), `src/m17nutil.c`; m17n-db 1.8.10 `th-kesmanee.mim`, `th-pattachote.mim`, `vi-telex.mim`, `vi-vni.mim`, `vi-viqr.mim`, `zh-cangjie.mim`, `zh-util.mim`, `cjk-util.mim`, `hi-inscript.mim`, `mr-inscript.mim`, `global.mim`; GLib 2.88.3's `is_valid_keyname`.
- **Not verifiable before phase 1 lands:** `altgr` (needs the real US keymap: evdev 5, no modifiers → `4`, so `G-4` → `₹`; the m17n side of it was verified by feeding the keysym directly), `us-layout` and `settings-apart` (need relocatable instances; `x` → `ं` was verified for both inscript engines, `k` → `क` for Hindi).

## Interfaces phase 3 relies on

- **Directory** `engines/m17n/`: `overlay.nix` (`flake.overlays.m17n`), `options.nix`, `module.nix`, `module/module.c`, `module/variables.c`, `module/variables.h`, `descriptors/` (`descriptors.c`, `descriptors.ts` and its package), `patches/m17n-lib/port/`, `patches/ibus-m17n/{port,casts}/`, `patches/README.md`, `cast-audit.jsonc`, `m17n-lib-cast-audit.jsonc`, `checks/golden/`, `checks/engines/`.
- **pkgsWasm:** `m17n_lib`; `ibus-web-m17n-db`; `ibus-engines.m17n`, with `$out/m17n.wasm` and a `data` output holding `share/ibus-m17n/default.xml`, and passthru `m17n_lib`, `schemas`, `settingsSchemaDir`, `descriptorProgram`, `descriptors` (the step's output directory), `auditCflags`, `auditSources`.
- **Option** `ibusWeb.engines.m17n`, a submodule:
  - `package`: `pkgsWasm.ibus-engines.m17n`;
  - `descriptors`: path of `engines.json`, the descriptor array for `mkEngineManifest`'s `engines`;
  - `settingsPaths`: path of `settings-paths.json`, `{ "org.freedesktop.ibus.engine.m17n": [ 197 paths ] }`, for `settingsPaths`;
  - `settingsSchemaDir`: string, the compiled schema directory;
  - `settingsSchemas`: **path of a JSON file**, `settings-schemas.json`: `["org.freedesktop.ibus.engine.m17n", "org.freedesktop.ibus.panel", …34 variable schema ids sorted]`;
  - `defaultEngine`: `"m17n:t:latn-post"` (default).
- **Packages:** `packages.ibus-web-m17n` (the side module package) and `packages.ibus-web-m17n-descriptors`.
- **Checks:** `m17n-golden`, `m17n-engines`, `m17n-descriptors`, `m17n-imports`, `m17n-data-closure`, `m17n-cast-audit`.
- **Licences:** ibus-m17n GPL-2.0-or-later, m17n-lib and m17n-db LGPL-2.1-or-later (nixpkgs' `meta.license`).

---

## File structure

| Path | Change |
| --- | --- |
| `runtime/libibus-web/src/ibus/ibusweb-private.h`, `ibusfactory.c`, `ibusengine.c` | An engine takes the creating context in its instance init |
| `runtime/libibus-web/tests/test-engine.c` | Records emitted while an engine is made |
| `engines/m17n/overlay.nix` | `flake.overlays.m17n`: `m17n_lib`, `ibus-web-m17n-db`, the descriptor program and step, `ibus-engines.m17n` |
| `engines/m17n/options.nix` | `ibusWeb.engines.m17n` |
| `engines/m17n/module.nix` | Packages, the option's values, editor flags, `m17n-imports`, `m17n-data-closure`, `m17n-cast-audit` |
| `engines/m17n/module/module.c`, `variables.c`, `variables.h` | The side module's startup and variables |
| `engines/m17n/descriptors/descriptors.c` | The descriptor program |
| `engines/m17n/descriptors/descriptors.ts`, `descriptors.test.ts`, `outputs.test.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `checks.nix` | The TypeScript step and `m17n-descriptors` |
| `engines/m17n/patches/m17n-lib/port/0001-…`, `0002-…` | m17n-lib port patches |
| `engines/m17n/patches/ibus-m17n/port/0001-…`, `casts/0001-…` | ibus-m17n's port and cast patches |
| `engines/m17n/patches/README.md` | The patch inventory |
| `engines/m17n/cast-audit.jsonc`, `m17n-lib-cast-audit.jsonc` | Allow-lists |
| `engines/m17n/checks/golden/checks.nix`, `harness.h`, `harness.c`, `golden.c` | `m17n-golden` |
| `engines/m17n/checks/engines/checks.nix`, `engines.c` | `m17n-engines` |
| `modules/typescript/files.nix`, `pnpm-workspace.yaml` (generated), `pnpm-lock.yaml`, `modules/typescript/workspace.nix` (`pnpmDeps` hash, if it changes) | The new workspace package |
| `REUSE.toml` | m17n's annotations |
| `docs/runtime.md`, `docs/m17n.md` (new), `docs/README.md`, `docs/engines.md`, `docs/tooling.md`, `docs/known-gaps.md` | The pages each change affects |

---

### Task 1: An engine has its context while it is being made

ibus-m17n's class constructor opens the input method and draws its preedit and status, which emit `HidePreeditText` twice and `UpdateProperty` once, before the factory returns the engine; today those records go to context 0.

**Files:**
- Modify: `runtime/libibus-web/src/ibus/ibusweb-private.h`, `runtime/libibus-web/src/ibus/ibusfactory.c`, `runtime/libibus-web/src/ibus/ibusengine.c`
- Test: `runtime/libibus-web/tests/test-engine.c`
- Docs: `docs/runtime.md`

**Interfaces:**
- Produces: `G_GNUC_INTERNAL uint32_t ibusweb_factory_creating_ic(void);` — the context of the `CreateEngine` under way, 0 outside one. `IBusEngine`'s instance init sets `engine->priv->ic` from it.

- [ ] **Step 1: Write the failing test**

In `runtime/libibus-web/tests/test-engine.c`, insert above the line `static IBusEngine *observed_engine;`:

```c
typedef struct {
  IBusEngine parent;
} ConstructingEngine;
typedef struct {
  IBusEngineClass parent;
} ConstructingEngineClass;
G_DEFINE_TYPE(ConstructingEngine, constructing_engine, IBUS_TYPE_ENGINE)

/* Emits while it is being made, from its instance init and its constructor,
 * as ibus-m17n's engines do. */
static GObject *constructing_engine_constructor(GType type, guint n,
                                                GObjectConstructParam *params) {
  GObject *object = G_OBJECT_CLASS(constructing_engine_parent_class)
                        ->constructor(type, n, params);
  ibus_engine_hide_auxiliary_text(IBUS_ENGINE(object));
  return object;
}
static void constructing_engine_class_init(ConstructingEngineClass *klass) {
  G_OBJECT_CLASS(klass)->constructor = constructing_engine_constructor;
}
static void constructing_engine_init(ConstructingEngine *engine) {
  ibus_engine_hide_preedit_text(IBUS_ENGINE(engine));
}

```

In `factory()`, replace

```c
  g_object_unref(engine);
  g_assert_null(ibusweb_factory_create(20, "missing", &error));
```

with

```c
  g_object_unref(engine);

  ibus_factory_add_engine(factory, "constructing",
                          constructing_engine_get_type());
  clear_output();
  uint32_t seq = ibusweb_output_last_seq(), size;
  engine = ibusweb_factory_create(21, "constructing", &error);
  g_assert_cmpint(error, ==, 0);
  g_variant_unref(
      first_record(IBUSWEB_REC_HIDE_PREEDIT_TEXT, 21, ++seq, &size));
  ibusweb_output_consume(size);
  g_variant_unref(
      first_record(IBUSWEB_REC_HIDE_AUXILIARY_TEXT, 21, ++seq, &size));
  ibusweb_output_consume(size);
  g_object_unref(engine);

  /* Made outside a CreateEngine, an engine has no context yet. */
  clear_output();
  seq = ibusweb_output_last_seq();
  engine = g_object_ref_sink(g_object_new(constructing_engine_get_type(), NULL));
  g_variant_unref(first_record(IBUSWEB_REC_HIDE_PREEDIT_TEXT, 0, ++seq, &size));
  ibusweb_output_consume(size);
  g_variant_unref(
      first_record(IBUSWEB_REC_HIDE_AUXILIARY_TEXT, 0, ++seq, &size));
  ibusweb_output_consume(size);
  g_object_unref(engine);

  g_assert_null(ibusweb_factory_create(20, "missing", &error));
```

- [ ] **Step 2: Run the test to see it fail**

Run: `nix develop -c git add runtime/libibus-web && nix build .#checks.x86_64-linux.libibus-web-tests -L`
Expected: FAIL in `libibus-web:engine`, `/engine/factory`, with `first_record: assertion failed (GUINT32_FROM_LE(header.ic) == ic): (0 == 21)`.

- [ ] **Step 3: Implement**

In `runtime/libibus-web/src/ibus/ibusweb-private.h`, below `G_GNUC_INTERNAL gboolean ibusweb_factory_fail(const char *reason);` add:

```c
G_GNUC_INTERNAL uint32_t ibusweb_factory_creating_ic(void);
```

In `runtime/libibus-web/src/ibus/ibusfactory.c`, insert above `IBusEngine *ibusweb_factory_create(uint32_t ic, const char *name, int *error) {`:

```c
uint32_t ibusweb_factory_creating_ic(void) {
  return runtime_factory != NULL ? runtime_factory->priv->creating_ic : 0;
}

```

(`creating_ic` is 0 outside an emission: the private struct starts zeroed and `ibusweb_factory_create` restores the previous value afterwards.)

In `runtime/libibus-web/src/ibus/ibusengine.c`, replace `ibus_engine_init` with:

```c
static void ibus_engine_init(IBusEngine *engine) {
  engine->priv = ibus_engine_get_instance_private(engine);
  engine->priv->surrounding_text = g_object_ref(text_empty);
  /* An engine can emit from its own instance init or constructor, before the
   * factory returns it; those records belong to the context it is made for. */
  engine->priv->ic = ibusweb_factory_creating_ic();
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `nix build .#checks.x86_64-linux.libibus-web-tests -L`
Expected: PASS, every suite `OK`, `libibus-web:engine` included.

- [ ] **Step 5: Update the docs**

In `docs/runtime.md`, section "Protocol, dispatch and output", after the paragraph that ends `Called outside a `create-engine` emission, the function logs a critical.` add the paragraph:

```markdown
An engine belongs to its context while it is being made: `IBusEngine`'s instance init takes the context of the
`CreateEngine` under way, so records an engine emits from its own instance init or constructor, as ibus-m17n's do
when its first context opens the input method, reach that context rather than context 0. An engine made outside a
`create-engine` emission starts on context 0.
```

Run: `nix develop -c oxfmt docs/runtime.md`

- [ ] **Step 6: Commit**

```bash
nix develop -c git add runtime/libibus-web/src/ibus/ibusweb-private.h runtime/libibus-web/src/ibus/ibusfactory.c runtime/libibus-web/src/ibus/ibusengine.c runtime/libibus-web/tests/test-engine.c docs/runtime.md
nix develop -c git commit -m "fix(libibus-web): give an engine its context while it is being made" -- runtime/libibus-web/src/ibus/ibusweb-private.h runtime/libibus-web/src/ibus/ibusfactory.c runtime/libibus-web/src/ibus/ibusengine.c runtime/libibus-web/tests/test-engine.c docs/runtime.md
```

---

### Task 2: m17n-lib and m17n-db for WebAssembly

**Files:**
- Create: `engines/m17n/overlay.nix`, `engines/m17n/module.nix`, `engines/m17n/m17n-lib-cast-audit.jsonc`, `engines/m17n/patches/README.md`
- Create (generated by Step 1): `engines/m17n/patches/m17n-lib/port/0001-configure-check-for-pkg-config-outside-the-GUI-block.patch`, `engines/m17n/patches/m17n-lib/port/0002-input-load-external-modules-only-where-dlopen-exists.patch`
- Modify: `REUSE.toml`
- Docs: `docs/m17n.md` (new), `docs/README.md`

**Interfaces:**
- Produces: `pkgsWasm.m17n_lib` (static `libm17n-core.a`, `libm17n.a`, `libm17n-flt.a`, `m17n-core.pc`, `m17n-shell.pc`, `m17n-flt.pc`; no `bin/`), whose `M17NDIR` is `pkgsWasm.ibus-web-m17n-db`'s `share/m17n`; `checks.m17n-cast-audit` (m17n-lib only until Task 4).

- [ ] **Step 1: Generate m17n-lib's port patches**

The spike branch `typedrat/m17n-spike`, in this repository, holds 0001 as a plain diff; 0002 is new. Save this script outside the tree as `$TMPDIR/m17n-lib-patches.sh` and run it from the repository root with `nix develop -c bash $TMPDIR/m17n-lib-patches.sh`. It makes both as `git format-patch` commits against the pinned tarball; the Python uses `\t` escapes because configure.ac's context lines hold tabs.

```bash
set -euo pipefail
repo=$PWD
work=$(mktemp -d)
src=$(nix build --no-link --print-out-paths .#legacyPackages.x86_64-linux.pkgsWasm.m17n_lib.src)
tar -xzf "$src" -C "$work"
cd "$work"/m17n-lib-1.8.6
git init -q
git add -A
git -c user.name=base -c user.email=base@localhost commit -qm base
git config user.name 'Alexis Williams'
git config user.email alexis@typedr.at

git -C "$repo" show typedrat/m17n-spike:engines/m17n/patches/m17n-lib/0001-pkg-config-outside-gui.patch | git apply
git commit -qam 'configure: check for pkg-config outside the GUI block

AM_CONDITIONAL([HAVE_PKG_CONFIG]) and PKG_PROG_PKG_CONFIG sat inside the
GUI block, so a build configured --without-gui stopped with
"conditional HAVE_PKG_CONFIG was never defined", and never looked for
the pkg-config whose presence decides between the .pc files and
m17n-config.'

python3 - <<'EOF'
import pathlib

configure = pathlib.Path("configure.ac")
text = configure.read_text()
check = (
    "dnl Checks if dlopen exists, and if it's in libc or libdl.\n\n"
    "AC_SEARCH_LIBS(dlopen, dl,\n"
    "\t       AC_DEFINE(HAVE_DLOPEN, 1,\n"
    "\t       [Define to 1 if you have the function dlopen.]))\n\n"
)
pkg_config = 'PKG_PROG_PKG_CONFIG\nAM_CONDITIONAL([HAVE_PKG_CONFIG], [test "x$PKG_CONFIG" != x])\n\n'
assert text.count(check) == 1 and text.count(pkg_config) == 1
configure.write_text(text.replace(check, "", 1).replace(pkg_config, pkg_config + check, 1))

source = pathlib.Path("src/input.c")
text = source.read_text()
edits = [
    (
        "static MIMExternalModule *\nload_external_module (MPlist *plist)\n{\n",
        "static MIMExternalModule *\nload_external_module (MPlist *plist)\n{\n#ifdef HAVE_DLOPEN\n",
    ),
    (
        "  M17N_OBJECT_UNREF (func_list);\n  dlclose (handle);\n  return NULL;\n}\n",
        "  M17N_OBJECT_UNREF (func_list);\n  dlclose (handle);\n  return NULL;\n"
        "#else  /* not HAVE_DLOPEN */\n  return NULL;\n#endif\t/* not HAVE_DLOPEN */\n}\n",
    ),
    (
        "unload_external_module (MIMExternalModule *external)\n{\n  dlclose (external->handle);\n",
        "unload_external_module (MIMExternalModule *external)\n{\n#ifdef HAVE_DLOPEN\n  dlclose (external->handle);\n#endif\n",
    ),
]
for old, new in edits:
    assert text.count(old) == 1, old
    text = text.replace(old, new, 1)
source.write_text(text)
EOF
git commit -qam 'input: load external modules only where dlopen exists

input.c, part of the core input-method library, loads an input
method'"'"'s external modules with dlopen, but configure checked for dlopen
only inside the GUI block and input.c called it unconditionally. Check
for it whatever the GUI setting, and without it treat every external
module as one that fails to load, as a missing module file already is.'

mkdir -p "$repo"/engines/m17n/patches/m17n-lib/port
git format-patch -q --zero-commit --no-numbered --no-signature -o "$repo"/engines/m17n/patches/m17n-lib/port HEAD~2
```

Expected: `ls engines/m17n/patches/m17n-lib/port` prints `0001-configure-check-for-pkg-config-outside-the-GUI-block.patch` and `0002-input-load-external-modules-only-where-dlopen-exists.patch`. 0002's `src/input.c` hunks add `#ifdef HAVE_DLOPEN` at the top of `load_external_module`'s body, `#else  /* not HAVE_DLOPEN */ return NULL; #endif` before its closing brace, and `#ifdef HAVE_DLOPEN`/`#endif` around `unload_external_module`'s `dlclose`; its `configure.ac` hunk moves `if test x$with_gui != xno; then` below the `AC_SEARCH_LIBS(dlopen, …)` block.

- [ ] **Step 2: Annotate the patches' licences**

In `REUSE.toml`, insert after the `engines/hangul/patches/libhangul/*.patch` annotation (before the `engines/mozc/patches/**/*.patch` one):

```toml
# Matches the upstream ibus-engines.m17n recipe's meta.license.
[[annotations]]
path = "engines/m17n/**"
SPDX-FileCopyrightText = "2026 Synapdeck, Inc."
SPDX-License-Identifier = "GPL-2.0-or-later"
precedence = "override"

[[annotations]]
path = "engines/m17n/patches/**/*.patch"
SPDX-FileCopyrightText = ["The ibus-m17n authors", "2026 Synapdeck, Inc."]
SPDX-License-Identifier = "GPL-2.0-or-later"

# m17n-lib's own licence, which the engine-wide annotations above would
# otherwise override; the last matching annotation wins.
[[annotations]]
path = "engines/m17n/patches/m17n-lib/**/*.patch"
SPDX-FileCopyrightText = [
  "National Institute of Advanced Industrial Science and Technology (AIST)",
  "2026 Synapdeck, Inc.",
]
SPDX-License-Identifier = "LGPL-2.1-or-later"
precedence = "override"
```

- [ ] **Step 3: Write the overlay**

Create `engines/m17n/overlay.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  config,
  lib,
  withSystem,
  ...
}:
let
  inherit (config.ibusWeb.lib) isEmscriptenWasm patchesIn;
in
{
  flake.overlays.m17n =
    final: prev:
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) (
      withSystem prev.stdenv.buildPlatform.system (
        { pkgs, ... }:
        let
          # A layer with no patch has no directory.
          layer =
            library: name:
            let
              dir = ./patches + "/${library}/${name}";
            in
            lib.optionals (builtins.pathExists dir) (patchesIn dir);

          # The data alone: scripts/ holds shell and awk, which would bring
          # bash and gawk into the module's data closure.
          m17nDb = pkgs.runCommand "ibus-web-m17n-db" { } ''
            mkdir -p $out/share
            cp -r ${pkgs.m17n_db}/share/m17n $out/share/m17n
            chmod -R u+w $out/share/m17n
            rm -r $out/share/m17n/scripts
          '';

          # configure takes M17NDIR, where the library reads its data, from
          # what the m17n-db program prints.
          m17nDbProgram = pkgs.writeShellScriptBin "m17n-db" ''
            echo ${m17nDb}/share/m17n
          '';
        in
        {
          ibus-web-m17n-db = m17nDb;

          # Patched for everything that links it.
          m17n_lib = prev.m17n_lib.overrideAttrs (old: {
            patches = (old.patches or [ ]) ++ layer "m17n-lib" "port" ++ layer "m17n-lib" "casts";

            nativeBuildInputs = [
              final.buildPackages.autoreconfHook
              final.buildPackages.pkg-config
              m17nDbProgram
            ];

            # The example programs and their external modules are no part of
            # the library.
            postPatch = (old.postPatch or "") + ''
              substituteInPlace Makefile.am --replace-fail 'SUBDIRS = intl po src example' 'SUBDIRS = intl po src'
            '';

            configureFlags = (old.configureFlags or [ ]) ++ [
              # configure reads with_gui: --without-gui skips the GUI and
              # font-layout libraries' checks, and the rest say no to each
              # in case one runs anyway.
              "--without-gui"
              "--without-libotf"
              "--without-fontconfig"
              "--without-gd"
              "--without-x"
              "--disable-nls"
              # Found through programs and test links the build machine could
              # answer; none serves an input method.
              "ac_cv_prog_HAVE_XML2_CONFIG=no"
              "ac_cv_lib_xml2_xmlParseMemory=no"
              "ac_cv_prog_HAVE_ISPELL=no"
              "ac_cv_lib_wordcut_wordcut_init=no"
              # A cross build can't run these tests, and would substitute
              # rpl_malloc and rpl_realloc, which m17n-lib doesn't define;
              # Emscripten's malloc(0) and realloc(NULL, 0) return pointers.
              "ac_cv_func_malloc_0_nonnull=yes"
              "ac_cv_func_realloc_0_nonnull=yes"
              # No external module can be loaded: there is no module
              # directory, and each attempt would print the loader's error.
              "ac_cv_search_dlopen=no"
            ];
          });
        }
      )
    );
}
```

- [ ] **Step 4: Write m17n-lib's cast audit**

Create `engines/m17n/m17n-lib-cast-audit.jsonc` (the spike's findings, which the patched library still has):

```jsonc
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later
{
  "$schema": "../../tools/cast-audit/cast-audit.schema.json",
  "casts": [
    {
      "file": "input.c",
      "function": null,
      "from": "M17NFunc",
      "to": "MIMExternalFunc",
      "reason": "External-module functions come from dlsym() and are called as MIMExternalFunc, their real type; M17NFunc is only the storage type. No module can be loaded here, so the calls are unreachable.",
    },
    {
      "file": "input.c",
      "function": null,
      "from": "M17NFunc",
      "to": "MIMExternalFunc",
      "reason": "External-module functions come from dlsym() and are called as MIMExternalFunc, their real type; M17NFunc is only the storage type. No module can be loaded here, so the calls are unreachable.",
    },
    {
      "file": "input.c",
      "function": null,
      "from": "M17NFunc",
      "to": "MIMExternalFunc",
      "reason": "External-module functions come from dlsym() and are called as MIMExternalFunc, their real type; M17NFunc is only the storage type. No module can be loaded here, so the calls are unreachable.",
    },
    {
      "file": "input.c",
      "function": null,
      "from": "void (*)(MInputContext *, MSymbol)",
      "to": "M17NFunc",
      "reason": "A round trip through M17NFunc, the storage type: the function is stored from, and called as, its real type. reset_ic is called back as MInputCallbackFunc.",
    },
    {
      "file": "input.c",
      "function": null,
      "from": "M17NFunc",
      "to": "MInputCallbackFunc",
      "reason": "A round trip through M17NFunc, the storage type: the function is stored from, and called as, its real type. Callbacks are registered as MInputCallbackFunc.",
    },
    {
      "file": "language.c",
      "function": null,
      "from": "MTextPropSerializeFunc",
      "to": "M17NFunc",
      "reason": "A round trip through M17NFunc, the storage type: the function is stored from, and called as, its real type.",
    },
    {
      "file": "language.c",
      "function": null,
      "from": "MTextPropDeserializeFunc",
      "to": "M17NFunc",
      "reason": "A round trip through M17NFunc, the storage type: the function is stored from, and called as, its real type.",
    },
  ],
}
```

- [ ] **Step 5: Write the module**

Create `engines/m17n/module.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) engines toolchain;
      inherit (toolchain.pkgsWasm) m17n_lib;

      # The sources of libm17n-core and libm17n, which the module links, with
      # the flags and config.h of the library's own configure run.
      libAudit =
        (engines.castAudit {
          name = "m17n-lib";
          inherit (m17n_lib) src;
          sources = [
            "character.c"
            "chartab.c"
            "database.c"
            "plist.c"
            "m17n-core.c"
            "mtext.c"
            "symbol.c"
            "textprop.c"
            "mtext-lbrk.c"
            "mtext-wseg.c"
            "charset.c"
            "coding.c"
            "input.c"
            "language.c"
            "locale.c"
            "m17n.c"
          ];
          cflags = "$(make -s --no-print-directory -f Makefile -f - print-cflags <<< 'print-cflags: ; @echo $(wordlist 2,$(words $(CC)),$(CC)) $(DEFS) $(DEFAULT_INCLUDES) $(INCLUDES) $(AM_CPPFLAGS) $(CPPFLAGS) $(AM_CFLAGS) $(CFLAGS)')";
          allowList = ./m17n-lib-cast-audit.jsonc;
        }).overrideAttrs
          (old: {
            inherit (m17n_lib) patches postPatch configureFlags;
            nativeBuildInputs = old.nativeBuildInputs ++ m17n_lib.nativeBuildInputs;
            dontConfigure = false;
            preBuild = "cd src";
          });
    in
    {
      ibusWeb.toolchain.devLibraries = [ m17n_lib ];

      checks.m17n-cast-audit = pkgs.linkFarm "ibus-web-m17n-cast-audit" {
        m17n-lib = libAudit;
      };
    };
}
```

- [ ] **Step 6: Build and check the library**

Run:

```bash
nix develop -c git add engines/m17n REUSE.toml
lib=$(nix build --no-link --print-out-paths -L .#legacyPackages.x86_64-linux.pkgsWasm.m17n_lib)
ls "$lib" "$lib"/lib/pkgconfig
strings "$lib"/lib/libm17n.a | grep -cE '^(dlopen|dlsym|dlclose)$' || true
strings "$lib"/lib/libm17n.a | grep -c 'm17n/1.0' || true
db=$(nix build --no-link --print-out-paths .#legacyPackages.x86_64-linux.pkgsWasm.ibus-web-m17n-db)
ls "$db"/share/m17n/*.mim | wc -l
test ! -e "$db"/share/m17n/scripts && echo no-scripts
nix build .#checks.x86_64-linux.m17n-cast-audit -L
```

Expected: `include` and `lib` only (no `bin`); `m17n-core.pc`, `m17n-flt.pc`, `m17n-shell.pc`; `0` loader symbols (the spike's unpatched library has `3`); `0` module directories (the spike's has `1`); `210` input-method files; `no-scripts`; the cast audit PASSes with the seven allowed findings (`input.c` 3418, 3885, 3956, 4470, 6957; `language.c` 153, 155).

- [ ] **Step 7: Write the patch inventory**

Create `engines/m17n/patches/README.md`:

```markdown
# m17n patches

The sources come from the pinned nixpkgs recipes: `m17n_lib` (m17n-lib 1.8.6) and `ibus-engines.m17n` (ibus-m17n
1.4.40). Local patches apply after nixpkgs' in two layers, `port` then `casts`, each sorted by filename; a layer with
no patch has no directory. Each is a `git format-patch` against that source; none has been submitted upstream yet.

`m17n-lib/` patches the library and applies to every WebAssembly build of m17n-lib. It is LGPL-2.1-or-later, as
m17n-lib is.

| Patch              | Reason                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| m17n-lib port 0001 | Check for pkg-config outside configure's GUI block. `AM_CONDITIONAL([HAVE_PKG_CONFIG])` sat inside it, so `--without-gui` stopped configure with an undefined conditional.                                                                                                                                                                                  |
| m17n-lib port 0002 | Check for `dlopen` outside the GUI block too, and without it fail every external module's load, as a missing module file already fails. The overlay answers `ac_cv_search_dlopen=no`, so the library imports nothing of the dynamic loader and keeps no module directory, and an input method that needs a module (`ja:anthy`, `en:ispell`) doesn't load. |

m17n-lib's cast audit reports seven casts through `M17NFunc`, the type m17n stores every function as. Each is in
`../m17n-lib-cast-audit.jsonc` with its reason: the function is stored from, and called as, its real type, and the
three calls of external-module functions can't be reached, since no module loads.
```

- [ ] **Step 8: Write the docs**

Create `docs/m17n.md`:

```markdown
# m17n

`engines/m17n/` ports ibus-m17n 1.4.40, the IBus front end of the m17n input-method library, with m17n-lib 1.8.6 and
m17n-db 1.8.10. This page describes how each is built for WebAssembly and the checks on them.

## Build

`flake.overlays.m17n`, which applies only to `pkgsWasm`, overrides nixpkgs' recipes and keeps their Autotools builds.
Local patches apply after nixpkgs' in two layers, `port` then `casts`, each sorted by filename, under
`engines/m17n/patches/m17n-lib/` and `engines/m17n/patches/ibus-m17n/`; a layer with no patch has no directory. The
[inventory](../engines/m17n/patches/README.md) gives each patch's reason.

### m17n-lib

`m17n_lib` is built static, with only its core and input-method libraries. configure reads `--without-gui` (as
`with_gui`; `--disable-gui` does nothing), which skips the checks for the GUI, font-layout and drawing libraries;
`--without-libotf`, `--without-fontconfig`, `--without-gd` and `--without-x` say no to each in case a check runs
anyway. libxml2, which m17n uses to serialise M-texts, ispell and wordcut, whose callers are a spelling module and
Thai word segmentation, are found through programs and test links the build machine could answer, so configure's
cache variables answer each `no`; none is reached from an input method. A cross build can't run `AC_FUNC_MALLOC`'s and
`AC_FUNC_REALLOC`'s test programs, and would substitute `rpl_malloc` and `rpl_realloc`, which m17n-lib doesn't define;
Emscripten's `malloc(0)` and `realloc(NULL, 0)` return pointers, so their cache variables answer `yes`.
`--disable-nls` leaves out gettext, and the `example/` programs aren't built.

configure runs the `m17n-db` program to learn `M17NDIR`, where the library reads its data. The overlay puts a script
of that name first on the build's path, printing `ibus-web-m17n-db`'s directory, so the data keeps that store path.

Two port patches serve the WebAssembly build. configure checked for pkg-config inside its GUI block, which
`--without-gui` skips, and stopped on the conditional left undefined; 0001 moves the check out. `load_external_module`
in `input.c` called `dlopen` for an input method's external module, a library in m17n's module directory. No such
directory exists here, and each attempt would print the loader's error in the host's console. 0002 checks for
`dlopen` outside the GUI block as well and, without it, fails each module's load as a missing file already fails; the
overlay answers `ac_cv_search_dlopen=no`. The library then refers to nothing of the dynamic loader, and to no module
directory, since only that code read `M17N_MODULE_DIR`. The methods that need a module, `ja:anthy` and `en:ispell`,
are those m17n lists as unable to load.

### m17n-db

`ibus-web-m17n-db` is the build machine's `m17n_db` output's `share/m17n`: the 210 input methods, their icons,
charset maps and tables, 6.9 MB. Its `scripts/` is left out, since their shell and awk would bring bash and gawk into
the module's data closure. m17n's per-user directory, `~/.m17n.d`, lies under the module's home, `/engines/m17n`;
nothing writes there.

## Checks

- `checks.m17n-cast-audit` audits the sources of `libm17n-core` and `libm17n`, with the library's configured
  `config.h` and its Makefile's flags, against `engines/m17n/m17n-lib-cast-audit.jsonc`: seven casts through
  `M17NFunc`, the type m17n stores every function as, each with its reason.
```

In `docs/README.md`, add this row to the Topics table below the `mozc.md` row:

```markdown
| [m17n.md](m17n.md)               | m17n: m17n-lib, m17n-db and ibus-m17n for WebAssembly, startup without a bus, the engines and their descriptors, settings and input-method variables, and the checks |
```

Run: `nix develop -c oxfmt docs/m17n.md docs/README.md engines/m17n/patches/README.md`

- [ ] **Step 9: Commit**

```bash
nix develop -c git add engines/m17n REUSE.toml docs/m17n.md docs/README.md
nix develop -c git commit -m "build(m17n): build m17n-lib and m17n-db for WebAssembly" -- engines/m17n REUSE.toml docs/m17n.md docs/README.md
```

hk runs `reuse lint`; it must pass with the new annotations.

---

### Task 3: The descriptor program and its TypeScript step

**Files:**
- Create: `engines/m17n/descriptors/package.json`, `tsconfig.json`, `vitest.config.ts`, `descriptors.ts`, `descriptors.test.ts`, `outputs.test.ts`, `checks.nix`, `descriptors.c`
- Create: `engines/m17n/options.nix`
- Modify: `engines/m17n/overlay.nix`, `engines/m17n/module.nix`
- Modify: `modules/typescript/files.nix`; regenerate `pnpm-workspace.yaml`; update `pnpm-lock.yaml` (and the `pnpmDeps` hash in `modules/typescript/workspace.nix` if the build asks for it)
- Docs: `docs/m17n.md`, `docs/tooling.md`

**Interfaces:**
- Consumes: Task 2's `pkgsWasm.m17n_lib`.
- Produces: `pkgsWasm.ibus-engines.m17n.descriptorProgram` and `.descriptors` (passthru); `packages.ibus-web-m17n-descriptors`; the option `ibusWeb.engines.m17n` with `descriptors`, `settingsPaths`, `settingsSchemas` and `defaultEngine` set (`package` and `settingsSchemaDir` follow in Task 4); `checks.m17n-descriptors`. The step's outputs are listed under [Decisions](#decisions-this-plan-makes-where-the-spec-is-silent).

- [ ] **Step 1: Add the workspace package**

Create `engines/m17n/descriptors/package.json`:

```json
{
  "name": "@ibus-web/m17n-descriptors",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run --configLoader native"
  },
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  }
}
```

Create `engines/m17n/descriptors/tsconfig.json`:

```jsonc
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": {
    // Vitest's declarations name DOM types, which Node code doesn't have.
    "skipLibCheck": true
  },
  "include": ["*.ts"]
}
```

Create `engines/m17n/descriptors/vitest.config.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later

import { defineConfig } from "vitest/config";

// A Nix build's tree is read-only, so checks point Vite's cache elsewhere.
const cacheDir = process.env["IBUS_WEB_TEST_CACHE_DIR"];

export default defineConfig({
  ...(cacheDir === undefined ? {} : { cacheDir }),
  test: { include: ["*.test.ts"] },
});
```

In `modules/typescript/files.nix`, in `pnpmWorkspace.packages`, add `"engines/m17n/descriptors"` after `"tools/*"`.

Run:

```bash
nix develop -c git add engines/m17n/descriptors modules/typescript/files.nix
nix run .#write-files
nix develop -c pnpm install
git status --short
```

Expected: `pnpm-workspace.yaml` lists `engines/m17n/descriptors` after `tools/*`; `pnpm-lock.yaml` gains an `engines/m17n/descriptors` importer; `engines/m17n/descriptors/node_modules` exists (untracked and ignored).

- [ ] **Step 2: Write the failing unit tests**

Create `engines/m17n/descriptors/descriptors.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "vitest";
import {
  displayName,
  engineDescriptor,
  generate,
  gschema,
  header,
  instances,
  type RawEngine,
  type RawVariable,
  settingsPath,
  sortEngines,
  variableKey,
  variableSchema,
} from "./descriptors.ts";

const engine = (name: string, overrides: Partial<RawEngine> = {}): RawEngine => {
  const [, language, inputMethod] = name.split(":");
  return { name, language: language!, inputMethod: inputMethod!, rank: 0, layout: "default", variables: [], ...overrides };
};

const variable = (overrides: Partial<RawVariable> = {}): RawVariable => ({
  name: "level",
  description: "Acceptance level\nThe level of character sequence acceptance.",
  type: "integer",
  value: 1,
  valid: [0, 1, 2],
  ...overrides,
});

const telex = engine("m17n:vi:telex", {
  variables: [
    variable({ name: "tone-mark-on-last", description: "Tone mark position.", value: 0, valid: [0, 1] }),
    variable({ name: "backspace-is-undo", description: null, value: 0, valid: [1, 0] }),
  ],
});
const unicode = engine("m17n:t:unicode", {
  variables: [variable({ name: "prompt", description: "Preedit prompt", type: "text", value: "U+'s", valid: [] })],
});

describe("display names", () => {
  test("name the language in English and the input method in parentheses", () => {
    expect(displayName(engine("m17n:hi:inscript"))).toBe("Hindi (inscript)");
    expect(displayName(engine("m17n:zh:cangjie"))).toBe("Chinese (cangjie)");
  });

  test("use ISO 639's names for the codes ICU doesn't name", () => {
    expect(displayName(engine("m17n:ath:phonetic"))).toBe("Athapascan (phonetic)");
    expect(displayName(engine("m17n:tai:sonla-kbd"))).toBe("Tai (sonla-kbd)");
  });

  test("are the bare input method for the general methods", () => {
    expect(displayName(engine("m17n:t:latn-post"))).toBe("latn-post");
  });

  test("fail for a language nothing names", () => {
    expect(() => displayName(engine("m17n:xqq:kbd"))).toThrow("no English name for language xqq");
  });
});

describe("settings paths", () => {
  test("are ibus-m17n's, from the lowercased names", () => {
    expect(settingsPath(engine("m17n:hi:inscript"))).toBe("/org/freedesktop/ibus/engine/m17n/hi/inscript/");
    expect(settingsPath(engine("m17n:sa:IAST-vedic"))).toBe("/org/freedesktop/ibus/engine/m17n/sa/iast-vedic/");
  });

  test("keep an all-uppercase input method's case", () => {
    expect(settingsPath(engine("m17n:sa:IAST"))).toBe("/org/freedesktop/ibus/engine/m17n/sa/IAST/");
  });
});

describe("engines", () => {
  test("put the default first, then sort by language and input method", () => {
    const raw = ["m17n:zh:cangjie", "m17n:hi:itrans", "m17n:t:latn-post", "m17n:hi:inscript", "m17n:am:sera"].map(
      (name) => engine(name),
    );
    expect(sortEngines(raw, "m17n:t:latn-post").map((entry) => entry.name)).toEqual([
      "m17n:t:latn-post",
      "m17n:am:sera",
      "m17n:hi:inscript",
      "m17n:hi:itrans",
      "m17n:zh:cangjie",
    ]);
  });

  test("fail without the default", () => {
    expect(() => sortEngines([engine("m17n:hi:inscript")], "m17n:t:latn-post")).toThrow("m17n:t:latn-post");
  });

  test("describe each engine on the default keyboard", () => {
    expect(engineDescriptor(engine("m17n:hi:inscript", { layout: "default[lv3:ralt_switch]" }))).toEqual({
      name: "m17n:hi:inscript",
      displayName: "Hindi (inscript)",
      languages: ["hi"],
      keyboard: { layout: "default", passThrough: [] },
    });
    expect(engineDescriptor(engine("m17n:t:latn-post")).languages).toEqual([]);
    expect(() => engineDescriptor(engine("m17n:hi:inscript", { layout: "us" }))).toThrow("unexpected layout us");
  });
});

describe("variable keys", () => {
  test("give an integer variable's values as a range", () => {
    expect(variableKey(variable(), telex)).toEqual({
      name: "level",
      type: "integer",
      default: 1,
      description: "Acceptance level\nThe level of character sequence acceptance.",
      range: { min: 0, max: 2 },
    });
    expect(variableKey(variable({ valid: [1, 0] }), telex).range).toEqual({ min: 0, max: 1 });
    expect(variableKey(variable({ valid: [{ min: 1, max: 9 }] }), telex).range).toEqual({ min: 1, max: 9 });
    expect(variableKey(variable({ valid: [] }), telex).range).toBeUndefined();
  });

  test("give a symbol variable's values as choices", () => {
    const key = variableKey(variable({ type: "symbol", value: "on", valid: ["on", "off"] }), telex);
    expect(key.choices).toEqual(["on", "off"]);
  });

  test("leave a text variable unconstrained", () => {
    expect(variableKey(unicode.variables[0]!, unicode)).toEqual({
      name: "prompt",
      type: "text",
      default: "U+'s",
      description: "Preedit prompt",
    });
  });

  test.each([
    [variable({ name: "Level" }), "isn't a valid GSettings key name"],
    [variable({ name: "a--b" }), "isn't a valid GSettings key name"],
    [variable({ name: "level-" }), "isn't a valid GSettings key name"],
    [variable({ type: null, value: null }), "has no initial value"],
    [variable({ valid: [0, 2] }), "aren't a range"],
    [variable({ valid: [0, { min: 1, max: 2 }] }), "mixes ranges and values"],
    [variable({ value: 5 }), "out of its range"],
    [variable({ type: "symbol", value: "maybe", valid: ["on", "off"] }), "isn't one of its values"],
  ])("refuse %j", (raw, message) => {
    expect(() => variableKey(raw, telex)).toThrow(message);
  });
});

describe("variable schemas", () => {
  test("live under the engine's settings path", () => {
    expect(variableSchema(telex)).toMatchObject({
      id: "org.freedesktop.ibus.engine.m17n.vi.telex",
      path: "/org/freedesktop/ibus/engine/m17n/vi/telex/variables/",
      language: "vi",
      inputMethod: "telex",
    });
  });

  test("are written as GSettings schema XML", () => {
    expect(gschema([variableSchema(telex), variableSchema(unicode)])).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<schemalist>",
        '  <schema id="org.freedesktop.ibus.engine.m17n.vi.telex" path="/org/freedesktop/ibus/engine/m17n/vi/telex/variables/">',
        '    <key name="tone-mark-on-last" type="i">',
        '      <range min="0" max="1"/>',
        "      <default>0</default>",
        "      <description>Tone mark position.</description>",
        "    </key>",
        '    <key name="backspace-is-undo" type="i">',
        '      <range min="0" max="1"/>',
        "      <default>0</default>",
        "    </key>",
        "  </schema>",
        '  <schema id="org.freedesktop.ibus.engine.m17n.t.unicode" path="/org/freedesktop/ibus/engine/m17n/t/unicode/variables/">',
        '    <key name="prompt" type="s">',
        "      <default>'U+\\'s'</default>",
        "      <description>Preedit prompt</description>",
        "    </key>",
        "  </schema>",
        "</schemalist>",
        "",
      ].join("\n"),
    );
  });

  test("are listed for variables.c with each variable's type", () => {
    expect(header([variableSchema(telex), variableSchema(unicode)])).toBe(
      [
        "#define IBUSWEB_M17N_VARIABLES(X) \\",
        '  X("vi", "telex", "org.freedesktop.ibus.engine.m17n.vi.telex", "tone-mark-on-last", INTEGER) \\',
        '  X("vi", "telex", "org.freedesktop.ibus.engine.m17n.vi.telex", "backspace-is-undo", INTEGER) \\',
        '  X("t", "unicode", "org.freedesktop.ibus.engine.m17n.t.unicode", "prompt", TEXT)',
        "",
      ].join("\n"),
    );
  });
});

describe("outputs", () => {
  const raw = [engine("m17n:hi:inscript"), telex, engine("m17n:t:latn-post"), unicode];
  const outputs = generate(raw, "m17n:t:latn-post");

  test("list every engine's settings path for the relocatable schema", () => {
    expect(outputs.settingsPaths).toEqual({
      "org.freedesktop.ibus.engine.m17n": [
        "/org/freedesktop/ibus/engine/m17n/t/latn-post/",
        "/org/freedesktop/ibus/engine/m17n/hi/inscript/",
        "/org/freedesktop/ibus/engine/m17n/t/unicode/",
        "/org/freedesktop/ibus/engine/m17n/vi/telex/",
      ],
    });
  });

  test("list the schemas the module declares, variable schemas by id", () => {
    expect(outputs.settingsSchemas).toEqual([
      "org.freedesktop.ibus.engine.m17n",
      "org.freedesktop.ibus.panel",
      "org.freedesktop.ibus.engine.m17n.t.unicode",
      "org.freedesktop.ibus.engine.m17n.vi.telex",
    ]);
  });

  test("list every instance for test harnesses, as the metadata tool takes them", () => {
    expect(instances(outputs)).toBe(
      [
        "org.freedesktop.ibus.panel",
        "org.freedesktop.ibus.engine.m17n.t.unicode",
        "org.freedesktop.ibus.engine.m17n.vi.telex",
        "org.freedesktop.ibus.engine.m17n=/org/freedesktop/ibus/engine/m17n/t/latn-post/",
        "org.freedesktop.ibus.engine.m17n=/org/freedesktop/ibus/engine/m17n/hi/inscript/",
        "org.freedesktop.ibus.engine.m17n=/org/freedesktop/ibus/engine/m17n/t/unicode/",
        "org.freedesktop.ibus.engine.m17n=/org/freedesktop/ibus/engine/m17n/vi/telex/",
        "",
      ].join("\n"),
    );
  });

  test("fail when two engines share a settings path", () => {
    expect(() => generate([...raw, engine("m17n:hi:Inscript")], "m17n:t:latn-post")).toThrow(
      "two engines share a settings path",
    );
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `nix develop -c bash -c 'cd engines/m17n/descriptors && pnpm exec vitest run --configLoader native descriptors.test.ts'`
Expected: FAIL: `Failed to load url ./descriptors.ts` (the module doesn't exist).

- [ ] **Step 4: Write the step**

Create `engines/m17n/descriptors/descriptors.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** A variable's value as m17n gives it: an integer, a symbol's name or a text. */
export type RawValue = number | string;

/** One input-method variable, as the descriptor program prints it. */
export interface RawVariable {
  name: string;
  description: string | null;
  type: "integer" | "symbol" | "text" | null;
  value: RawValue | null;
  valid: Array<RawValue | { min: number; max: number }>;
}

/** One engine ibus-m17n lists, as the descriptor program prints it. */
export interface RawEngine {
  name: string;
  language: string;
  inputMethod: string;
  rank: number;
  layout: string;
  variables: RawVariable[];
}

/** An engine descriptor, as `mkEngineManifest` takes it. */
export interface EngineDescriptor {
  name: string;
  displayName: string;
  languages: string[];
  keyboard: { layout: "default"; passThrough: string[] };
}

/** A key of a variable schema. */
export interface VariableKey {
  name: string;
  type: "integer" | "symbol" | "text";
  default: RawValue;
  description?: string;
  range?: { min: number; max: number };
  choices?: string[];
}

/** The fixed-path schema holding one input method's variables. */
export interface VariableSchema {
  id: string;
  path: string;
  language: string;
  inputMethod: string;
  keys: VariableKey[];
}

/** What the build takes from this step. */
export interface Outputs {
  engines: EngineDescriptor[];
  settingsPaths: Record<string, string[]>;
  settingsSchemas: string[];
  gschema: string;
  header: string;
}

export const relocatableSchema = "org.freedesktop.ibus.engine.m17n";
export const panelSchema = "org.freedesktop.ibus.panel";

// ISO 639 collective and minority codes that ICU has no English name for,
// with their ISO 639 reference names.
const languageNames: Record<string, string> = {
  ath: "Athapascan",
  cmc: "Chamic",
  dra: "Dravidian",
  nsk: "Naskapi",
  tai: "Tai",
};

const displayNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

// GLib's rule for key names: a lowercase letter, then lowercase letters,
// digits and single hyphens, not ending in a hyphen.
const keyName = /^[a-z](?:-?[a-z0-9])*$/;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** m17n's `t` is no language: its methods work for any text. */
const isGeneral = (engine: RawEngine) => engine.language === "t";

export function displayName(engine: RawEngine): string {
  if (isGeneral(engine)) return engine.inputMethod;
  const language = displayNames.of(engine.language) ?? languageNames[engine.language];
  if (language === undefined) throw new Error(`${engine.name}: no English name for language ${engine.language}`);
  return `${language} (${engine.inputMethod})`;
}

/**
 * The path ibus-m17n opens the engine's settings at. It builds the path from
 * the engine's GType name, which lowercases the input method's name, and
 * retries an all-uppercase name (sa:IAST) as it is when m17n has no input
 * method by the lowercased one.
 */
export function settingsPath(engine: RawEngine): string {
  const name = engine.inputMethod;
  const kept = name === name.toUpperCase() ? name : name.toLowerCase();
  return `/org/freedesktop/ibus/engine/m17n/${engine.language.toLowerCase()}/${kept}/`;
}

/** The default first, then by language and the input method's name. */
export function sortEngines(raw: readonly RawEngine[], defaultEngine: string): RawEngine[] {
  const first = raw.find((engine) => engine.name === defaultEngine);
  if (first === undefined) throw new Error(`the default engine ${defaultEngine} isn't listed`);

  const rest = raw
    .filter((engine) => engine !== first)
    .sort((a, b) => compare(a.language, b.language) || compare(a.inputMethod, b.inputMethod));
  return [first, ...rest];
}

export function engineDescriptor(engine: RawEngine): EngineDescriptor {
  // m17n's layouts are the keyboard as it is, sometimes with AltGr as a
  // third-level switch, which the page's "default" keyboard already is.
  if (engine.layout !== "default" && !engine.layout.startsWith("default["))
    throw new Error(`${engine.name}: unexpected layout ${engine.layout}`);

  return {
    name: engine.name,
    displayName: displayName(engine),
    languages: isGeneral(engine) ? [] : [engine.language],
    keyboard: { layout: "default", passThrough: [] },
  };
}

function integerRange(variable: RawVariable, engine: RawEngine): { min: number; max: number } | undefined {
  if (variable.valid.length === 0) return undefined;
  const ranges = variable.valid.filter((valid): valid is { min: number; max: number } => typeof valid === "object");
  if (ranges.length === 1 && variable.valid.length === 1) return ranges[0];

  const values = [...new Set(variable.valid)].map((valid) => {
    if (typeof valid !== "number") throw new Error(`${engine.name}: ${variable.name} mixes ranges and values`);
    return valid;
  });
  values.sort((a, b) => a - b);

  // GSettings constrains an integer only by a range, so the values have to
  // be one.
  if (values.some((value, index) => value !== values[0]! + index))
    throw new Error(`${engine.name}: ${variable.name}'s values ${values.join(" ")} aren't a range`);
  return { min: values[0]!, max: values.at(-1)! };
}

export function variableKey(variable: RawVariable, engine: RawEngine): VariableKey {
  if (!keyName.test(variable.name) || variable.name.length > 1024)
    throw new Error(`${engine.name}: variable ${variable.name} isn't a valid GSettings key name`);
  if (variable.type === null || variable.value === null)
    throw new Error(`${engine.name}: variable ${variable.name} has no initial value`);

  const description = variable.description?.trim();
  const key: VariableKey = {
    name: variable.name,
    type: variable.type,
    default: variable.value,
    ...(description ? { description } : {}),
  };

  if (variable.type === "integer") {
    const range = integerRange(variable, engine);
    if (range === undefined) return key;
    if (typeof variable.value !== "number" || variable.value < range.min || variable.value > range.max)
      throw new Error(`${engine.name}: ${variable.name}'s default ${variable.value} is out of its range`);
    return { ...key, range };
  }
  if (variable.type === "symbol" && variable.valid.length > 0) {
    const choices = variable.valid.map(String);
    if (!choices.includes(String(variable.value)))
      throw new Error(`${engine.name}: ${variable.name}'s default ${variable.value} isn't one of its values`);
    return { ...key, choices };
  }
  return key;
}

export function variableSchema(engine: RawEngine): VariableSchema {
  return {
    id: `${relocatableSchema}.${engine.language}.${engine.inputMethod}`,
    path: `${settingsPath(engine)}variables/`,
    language: engine.language,
    inputMethod: engine.inputMethod,
    keys: engine.variables.map((variable) => variableKey(variable, engine)),
  };
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A string in GVariant's text format. */
const gvariantString = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function gschema(schemas: readonly VariableSchema[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<schemalist>"];
  for (const schema of schemas) {
    lines.push(`  <schema id="${xml(schema.id)}" path="${xml(schema.path)}">`);
    for (const key of schema.keys) {
      lines.push(`    <key name="${key.name}" type="${key.type === "integer" ? "i" : "s"}">`);
      if (key.range) lines.push(`      <range min="${key.range.min}" max="${key.range.max}"/>`);
      if (key.choices) {
        lines.push("      <choices>");
        for (const choice of key.choices) lines.push(`        <choice value="${xml(choice)}"/>`);
        lines.push("      </choices>");
      }
      const value = typeof key.default === "number" ? String(key.default) : gvariantString(key.default);
      lines.push(`      <default>${xml(value)}</default>`);
      if (key.description) lines.push(`      <description>${xml(key.description)}</description>`);
      lines.push("    </key>");
    }
    lines.push("  </schema>");
  }
  lines.push("</schemalist>", "");
  return lines.join("\n");
}

const cString = (text: string) => JSON.stringify(text);

/** The table variables.c applies the settings from, one entry per variable. */
export function header(schemas: readonly VariableSchema[]): string {
  const entries = schemas.flatMap((schema) =>
    schema.keys.map(
      (key) =>
        `  X(${cString(schema.language)}, ${cString(schema.inputMethod)}, ${cString(schema.id)}, ${cString(key.name)}, ${key.type.toUpperCase()})`,
    ),
  );
  return ["#define IBUSWEB_M17N_VARIABLES(X) \\", entries.join(" \\\n"), ""].join("\n");
}

/**
 * Each schema instance the module declares, one a line, as the metadata tool
 * takes them: a fixed schema's id, or the relocatable schema's id and a path.
 */
export function instances(outputs: Outputs): string {
  const fixed = outputs.settingsSchemas.filter((id) => id !== relocatableSchema);
  const relocated = Object.entries(outputs.settingsPaths).flatMap(([id, paths]) => paths.map((path) => `${id}=${path}`));
  return [...fixed, ...relocated, ""].join("\n");
}

export function generate(raw: readonly RawEngine[], defaultEngine: string): Outputs {
  const engines = sortEngines(raw, defaultEngine);
  const schemas = engines
    .filter((engine) => engine.variables.length > 0)
    .map(variableSchema)
    .sort((a, b) => compare(a.id, b.id));

  const paths = engines.map(settingsPath);
  if (new Set(paths).size !== paths.length) throw new Error("two engines share a settings path");

  return {
    engines: engines.map(engineDescriptor),
    settingsPaths: { [relocatableSchema]: paths },
    settingsSchemas: [relocatableSchema, panelSchema, ...schemas.map((schema) => schema.id)],
    gschema: gschema(schemas),
    header: header(schemas),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, defaultEngine, output] = process.argv.slice(2);
  if (!input || !defaultEngine || !output) throw new Error("usage: descriptors.ts RAW.json DEFAULT_ENGINE OUTPUT_DIR");
  const outputs = generate(JSON.parse(readFileSync(input, "utf8")), defaultEngine);

  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(join(output, "schemas"), { recursive: true });
  writeFileSync(join(output, "engines.json"), json(outputs.engines));
  writeFileSync(join(output, "settings-paths.json"), json(outputs.settingsPaths));
  writeFileSync(join(output, "settings-schemas.json"), json(outputs.settingsSchemas));
  writeFileSync(join(output, "schemas", `${relocatableSchema}.variables.gschema.xml`), outputs.gschema);
  writeFileSync(join(output, "variable-table.h"), outputs.header);
  writeFileSync(join(output, "instances.txt"), instances(outputs));
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `nix develop -c bash -c 'cd engines/m17n/descriptors && pnpm exec vitest run --configLoader native descriptors.test.ts'`
Expected: PASS, 27 tests.

- [ ] **Step 6: Write the descriptor program**

Create `engines/m17n/descriptors/descriptors.c`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif
#include "m17nutil.h"
#include <emscripten/wasmfs.h>
#include <stdio.h>
#include <sys/stat.h>

/* m17n reads its data from the store; nothing else of the host's is seen. */
backend_t wasmfs_create_root_dir(void) {
  return wasmfs_create_memory_backend();
}

static void string(GString *out, const gchar *value) {
  if (value == NULL) {
    g_string_append(out, "null");
    return;
  }
  g_string_append_c(out, '"');
  for (const gchar *p = value; *p != '\0'; p++) {
    guchar c = *p;
    if (c == '"' || c == '\\')
      g_string_append_printf(out, "\\%c", c);
    else if (c < 0x20)
      g_string_append_printf(out, "\\u%04x", c);
    else
      g_string_append_c(out, c);
  }
  g_string_append_c(out, '"');
}

static void text(GString *out, MText *mt) {
  g_autofree gchar *utf8 = ibus_m17n_mtext_to_utf8(mt);
  string(out, utf8);
}

/* One value of a variable: an integer, a symbol's name or a text. */
static void value(GString *out, MPlist *element) {
  MSymbol key = mplist_key(element);
  if (key == Minteger)
    g_string_append_printf(out, "%ld", (long)mplist_value(element));
  else if (key == Msymbol)
    string(out, msymbol_name(mplist_value(element)));
  else if (key == Mtext)
    text(out, mplist_value(element));
  else
    g_error("Unexpected variable value of type %s", msymbol_name(key));
}

static const gchar *type_name(MSymbol key) {
  if (key == Minteger)
    return "integer";
  if (key == Msymbol)
    return "symbol";
  if (key == Mtext)
    return "text";
  return NULL;
}

/* Each element is (NAME DESCRIPTION STATUS VALUE VALID-VALUE...); an integer
 * variable's valid value may be a (MIN MAX) range. */
static void variable(GString *out, MPlist *plist) {
  MSymbol name = mplist_value(plist);
  plist = mplist_next(plist);
  g_string_append(out, "{\"name\":");
  string(out, msymbol_name(name));
  g_string_append(out, ",\"description\":");
  if (mplist_key(plist) == Mtext)
    text(out, mplist_value(plist));
  else
    g_string_append(out, "null");
  plist = mplist_next(mplist_next(plist));

  g_string_append(out, ",\"type\":");
  string(out, type_name(mplist_key(plist)));
  g_string_append(out, ",\"value\":");
  if (type_name(mplist_key(plist)) != NULL)
    value(out, plist);
  else
    g_string_append(out, "null");

  g_string_append(out, ",\"valid\":[");
  gboolean first = TRUE;
  for (plist = mplist_next(plist); mplist_key(plist) != Mnil;
       plist = mplist_next(plist)) {
    if (!first)
      g_string_append_c(out, ',');
    first = FALSE;
    if (mplist_key(plist) == Mplist) {
      MPlist *range = mplist_value(plist);
      g_string_append(out, "{\"min\":");
      value(out, range);
      g_string_append(out, ",\"max\":");
      value(out, mplist_next(range));
      g_string_append_c(out, '}');
    } else {
      value(out, plist);
    }
  }
  g_string_append(out, "]}");
}

static void engine(GString *out, IBusEngineDesc *desc) {
  const gchar *name = ibus_engine_desc_get_name(desc);
  g_auto(GStrv) parts = g_strsplit(name, ":", 3);
  g_assert_cmpuint(g_strv_length(parts), ==, 3);

  g_string_append(out, "{\"name\":");
  string(out, name);
  g_string_append(out, ",\"language\":");
  string(out, ibus_engine_desc_get_language(desc));
  g_string_append(out, ",\"inputMethod\":");
  string(out, parts[2]);
  g_string_append_printf(out, ",\"rank\":%u,\"layout\":",
                         ibus_engine_desc_get_rank(desc));
  string(out, ibus_engine_desc_get_layout(desc));

  g_string_append(out, ",\"variables\":[");
  MPlist *variables =
      minput_get_variable(msymbol(parts[1]), msymbol(parts[2]), Mnil);
  gboolean first = TRUE;
  for (MPlist *p = variables; p != NULL && mplist_key(p) != Mnil;
       p = mplist_next(p)) {
    if (!first)
      g_string_append_c(out, ',');
    first = FALSE;
    variable(out, mplist_value(p));
  }
  g_string_append(out, "]}");
}

int main(void) {
  g_assert_cmpint(mkdir("/nix", 0777), ==, 0);
  g_assert_cmpint(
      wasmfs_create_directory("/nix/store", 0777,
                              wasmfs_create_node_backend("/nix/store")),
      ==, 0);

  ibus_m17n_init_common();
  IBusComponent *component = g_object_ref_sink(ibus_m17n_get_component());
  GList *engines = ibus_component_get_engines(component);

  GString *out = g_string_new("[");
  for (GList *p = engines; p != NULL; p = p->next) {
    if (p != engines)
      g_string_append_c(out, ',');
    engine(out, p->data);
  }
  g_string_append(out, "]\n");
  fputs(out->str, stdout);

  g_string_free(out, TRUE);
  g_list_free(engines);
  g_object_unref(component);
  return 0;
}
```

- [ ] **Step 7: Declare the option**

Create `engines/m17n/options.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.engines.m17n = lib.mkOption {
      description = "The m17n side module and what its distribution is made from.";
      type = lib.types.submodule {
        options = {
          package = lib.mkOption {
            type = lib.types.package;
            description = "ibus-engines.m17n: m17n.wasm, with default.xml in its data output.";
          };

          descriptors = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file of the module's engine descriptors, the default first.";
          };

          settingsPaths = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file of each engine's path for org.freedesktop.ibus.engine.m17n, as settingsPaths takes it.";
          };

          settingsSchemaDir = lib.mkOption {
            type = lib.types.str;
            description = "The compiled schema directory m17n.wasm keeps in its closure.";
          };

          settingsSchemas = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file listing the module's schema ids: ibus-m17n's, the panel's and every variable schema's.";
          };

          defaultEngine = lib.mkOption {
            type = lib.types.str;
            default = "m17n:t:latn-post";
            description = "The engine the descriptors list first, the module's default.";
          };
        };
      };
    };
  };
}
```

- [ ] **Step 8: Add the configured tree, the program and the step to the overlay**

Replace `engines/m17n/overlay.nix` with:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  config,
  lib,
  withSystem,
  ...
}:
let
  inherit (config.ibusWeb.lib) isEmscriptenWasm patchesIn;
in
{
  flake.overlays.m17n =
    final: prev:
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) (
      withSystem prev.stdenv.buildPlatform.system (
        { config, pkgs, ... }:
        let
          inherit (config.ibusWeb) typescript;

          # A layer with no patch has no directory.
          layer =
            library: name:
            let
              dir = ./patches + "/${library}/${name}";
            in
            lib.optionals (builtins.pathExists dir) (patchesIn dir);

          # The data alone: scripts/ holds shell and awk, which would bring
          # bash and gawk into the module's data closure.
          m17nDb = pkgs.runCommand "ibus-web-m17n-db" { } ''
            mkdir -p $out/share
            cp -r ${pkgs.m17n_db}/share/m17n $out/share/m17n
            chmod -R u+w $out/share/m17n
            rm -r $out/share/m17n/scripts
          '';

          # configure takes M17NDIR, where the library reads its data, from
          # what the m17n-db program prints.
          m17nDbProgram = pkgs.writeShellScriptBin "m17n-db" ''
            echo ${m17nDb}/share/m17n
          '';

          # The flags automake compiles a configured src/'s sources with, as
          # shell words, starting with the options configure added to CC.
          makeCflags = "$(make -s --no-print-directory -f Makefile -f - print-cflags <<< 'print-cflags: ; @echo $(wordlist 2,$(words $(CC)),$(CC)) $(DEFS) $(DEFAULT_INCLUDES) $(INCLUDES) $(AM_CPPFLAGS) $(CPPFLAGS) $(AM_CFLAGS) $(CFLAGS)')";

          # ibus-m17n's configured tree, from which the descriptor program and
          # the side module each build their part.
          base = prev.ibus-engines.m17n.overrideAttrs (old: {
            patches = (old.patches or [ ]) ++ layer "ibus-m17n" "port" ++ layer "ibus-m17n" "casts";

            outputs = [
              "out"
              "data"
            ];

            nativeBuildInputs = with final.buildPackages; [
              autoreconfHook
              gettext
              pkg-config
            ];

            buildInputs = [
              final.libibus-web
              final.m17n_lib
            ];

            # The static adapter also propagates the desktop recipe's inputs.
            propagatedBuildInputs = [ ];

            # Without the setup tool's GTK. LIBEXECDIR is only in that tool's
            # command line; outside the store, it keeps the module from
            # referring to its own output.
            configureFlags = [
              "--with-gtk=no"
              "--libexecdir=/usr/libexec"
              "--disable-nls"
              "--datadir=${placeholder "data"}/share"
            ];
          });

          # Built from the same tree as m17n.wasm but apart from it, so that
          # the schemas m17n.wasm compiles in can come from what it prints.
          descriptorProgram = base.overrideAttrs (old: {
            pname = "ibus-web-m17n-descriptor-program";

            postPatch = (old.postPatch or "") + ''
              cp ${./descriptors/descriptors.c} src/descriptors.c
            '';

            # A main module links every archive whole, so an archive m17n-shell
            # names twice, directly and through m17n-core, is named once.
            # mplist__from_file keeps a 64 KiB read buffer on the stack, the
            # whole of Emscripten's default.
            buildPhase = ''
              runHook preBuild
              cd src
              make libm17ncommon.la
              $CC ${makeCflags} -c descriptors.c -o descriptors.o

              libs=$($PKG_CONFIG --static --libs libibus-web m17n-shell | tr ' ' '\n' | awk 'NF && !seen[$0]++' | tr '\n' ' ')
              $CXX ${toString config.ibusWeb.lib.testLinkFlagsWithoutNodeFs} -sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB \
                descriptors.o .libs/libm17ncommon.a $libs -o descriptors.js

              cd ..
              runHook postBuild
            '';

            # default.xml goes where the program's PKGDATADIR points.
            installPhase = ''
              runHook preInstall
              install -Dm644 -t $out src/descriptors.js src/descriptors.wasm
              install -Dm644 src/default.xml -t $data/share/ibus-m17n
              runHook postInstall
            '';

            dontFixup = true;
          });

          # The step's files, with the program's own output beside them.
          descriptors =
            pkgs.runCommand "ibus-web-m17n-descriptors" { nativeBuildInputs = [ typescript.nodejs ]; }
              ''
                node ${descriptorProgram}/descriptors.js > raw.json
                node ${./descriptors/descriptors.ts} raw.json ${lib.escapeShellArg config.ibusWeb.engines.m17n.defaultEngine} $out
                cp raw.json $out/raw.json
              '';
        in
        {
          ibus-web-m17n-db = m17nDb;

          # Patched for everything that links it.
          m17n_lib = prev.m17n_lib.overrideAttrs (old: {
            patches = (old.patches or [ ]) ++ layer "m17n-lib" "port" ++ layer "m17n-lib" "casts";

            nativeBuildInputs = [
              final.buildPackages.autoreconfHook
              final.buildPackages.pkg-config
              m17nDbProgram
            ];

            # The example programs and their external modules are no part of
            # the library.
            postPatch = (old.postPatch or "") + ''
              substituteInPlace Makefile.am --replace-fail 'SUBDIRS = intl po src example' 'SUBDIRS = intl po src'
            '';

            configureFlags = (old.configureFlags or [ ]) ++ [
              # configure reads with_gui: --without-gui skips the GUI and
              # font-layout libraries' checks, and the rest say no to each
              # in case one runs anyway.
              "--without-gui"
              "--without-libotf"
              "--without-fontconfig"
              "--without-gd"
              "--without-x"
              "--disable-nls"
              # Found through programs and test links the build machine could
              # answer; none serves an input method.
              "ac_cv_prog_HAVE_XML2_CONFIG=no"
              "ac_cv_lib_xml2_xmlParseMemory=no"
              "ac_cv_prog_HAVE_ISPELL=no"
              "ac_cv_lib_wordcut_wordcut_init=no"
              # A cross build can't run these tests, and would substitute
              # rpl_malloc and rpl_realloc, which m17n-lib doesn't define;
              # Emscripten's malloc(0) and realloc(NULL, 0) return pointers.
              "ac_cv_func_malloc_0_nonnull=yes"
              "ac_cv_func_realloc_0_nonnull=yes"
              # No external module can be loaded: there is no module
              # directory, and each attempt would print the loader's error.
              "ac_cv_search_dlopen=no"
            ];
          });

          ibus-engines = prev.ibus-engines // {
            m17n = base.overrideAttrs (old: {
              passthru = (old.passthru or { }) // {
                inherit descriptorProgram descriptors;
              };
            });
          };
        }
      )
    );
}
```

- [ ] **Step 9: Expose the step's output**

Replace `engines/m17n/module.nix` with:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) engines toolchain;
      inherit (toolchain.pkgsWasm) m17n_lib;
      m17n = toolchain.pkgsWasm.ibus-engines.m17n;

      # The sources of libm17n-core and libm17n, which the module links, with
      # the flags and config.h of the library's own configure run.
      libAudit =
        (engines.castAudit {
          name = "m17n-lib";
          inherit (m17n_lib) src;
          sources = [
            "character.c"
            "chartab.c"
            "database.c"
            "plist.c"
            "m17n-core.c"
            "mtext.c"
            "symbol.c"
            "textprop.c"
            "mtext-lbrk.c"
            "mtext-wseg.c"
            "charset.c"
            "coding.c"
            "input.c"
            "language.c"
            "locale.c"
            "m17n.c"
          ];
          cflags = "$(make -s --no-print-directory -f Makefile -f - print-cflags <<< 'print-cflags: ; @echo $(wordlist 2,$(words $(CC)),$(CC)) $(DEFS) $(DEFAULT_INCLUDES) $(INCLUDES) $(AM_CPPFLAGS) $(CPPFLAGS) $(AM_CFLAGS) $(CFLAGS)')";
          allowList = ./m17n-lib-cast-audit.jsonc;
        }).overrideAttrs
          (old: {
            inherit (m17n_lib) patches postPatch configureFlags;
            nativeBuildInputs = old.nativeBuildInputs ++ m17n_lib.nativeBuildInputs;
            dontConfigure = false;
            preBuild = "cd src";
          });
    in
    {
      packages.ibus-web-m17n-descriptors = m17n.descriptors;

      ibusWeb.engines.m17n = {
        descriptors = "${m17n.descriptors}/engines.json";
        settingsPaths = "${m17n.descriptors}/settings-paths.json";
        settingsSchemas = "${m17n.descriptors}/settings-schemas.json";
      };

      ibusWeb.toolchain.devLibraries = [ m17n_lib ];

      ibusWeb.toolchain.clangdPathFlags."engines/m17n/descriptors/descriptors\\.c" = [
        "-I${m17n.src}/src"
      ];

      checks.m17n-cast-audit = pkgs.linkFarm "ibus-web-m17n-cast-audit" {
        m17n-lib = libAudit;
      };
    };
}
```

- [ ] **Step 10: Test the built output**

Create `engines/m17n/descriptors/outputs.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { EngineDescriptor } from "./descriptors.ts";

const directory = process.env["IBUS_WEB_M17N_DESCRIPTORS"];
if (!directory) throw new Error("IBUS_WEB_M17N_DESCRIPTORS is required");
const read = (name: string) => readFileSync(join(directory, name), "utf8");

const engines: EngineDescriptor[] = JSON.parse(read("engines.json"));
const paths: Record<string, string[]> = JSON.parse(read("settings-paths.json"));
const schemas: string[] = JSON.parse(read("settings-schemas.json"));
const gschema = read("schemas/org.freedesktop.ibus.engine.m17n.variables.gschema.xml");

test("lists the 197 engines ibus-m17n does, the default first", () => {
  expect(engines).toHaveLength(197);
  expect(engines[0]!.name).toBe("m17n:t:latn-post");
  expect(new Set(engines.map((engine) => engine.name)).size).toBe(197);
  expect(engines.find((engine) => engine.name === "m17n:hi:inscript")).toEqual({
    name: "m17n:hi:inscript",
    displayName: "Hindi (inscript)",
    languages: ["hi"],
    keyboard: { layout: "default", passThrough: [] },
  });
});

test("leaves out what ranks below zero and what needs a plugin", () => {
  const names = new Set(engines.map((engine) => engine.name));
  for (const name of ["m17n:zh:py", "m17n:ko:han2", "m17n:ko:romaja", "m17n:ja:anthy", "m17n:en:ispell"])
    expect(names.has(name)).toBe(false);
});

test("gives every engine its own settings path", () => {
  const relocated = paths["org.freedesktop.ibus.engine.m17n"]!;
  expect(relocated).toHaveLength(197);
  expect(new Set(relocated).size).toBe(197);
  expect(relocated).toContain("/org/freedesktop/ibus/engine/m17n/sa/IAST/");
});

test("declares a variable schema for each of the 34 engines with variables", () => {
  expect(schemas.slice(0, 2)).toEqual(["org.freedesktop.ibus.engine.m17n", "org.freedesktop.ibus.panel"]);
  expect(schemas).toHaveLength(36);
  expect(schemas).toContain("org.freedesktop.ibus.engine.m17n.vi.telex");
  expect(schemas).toContain("org.freedesktop.ibus.engine.m17n.zh.cangjie");
  expect(gschema.match(/<key /g)).toHaveLength(53);
  expect(gschema).toContain(
    '<schema id="org.freedesktop.ibus.engine.m17n.th.kesmanee" path="/org/freedesktop/ibus/engine/m17n/th/kesmanee/variables/">',
  );
});

test("lists every instance for test harnesses", () => {
  const lines = read("instances.txt").trimEnd().split("\n");
  expect(lines).toHaveLength(35 + 197);
  expect(lines).toContain("org.freedesktop.ibus.engine.m17n.vi.telex");
  expect(lines).toContain("org.freedesktop.ibus.engine.m17n=/org/freedesktop/ibus/engine/m17n/hi/inscript/");
});
```

Create `engines/m17n/descriptors/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing toolchain typescript;
    in
    {
      checks.m17n-descriptors = testing.vitestCheck {
        name = "m17n-descriptors";
        packageDir = "${typescript.workspaceFor [ "engines/m17n/descriptors" ]}/engines/m17n/descriptors";
        env.IBUS_WEB_M17N_DESCRIPTORS = toolchain.pkgsWasm.ibus-engines.m17n.descriptors;
        inBrowsers = false;
        limit = 60;
      };
    };
}
```

- [ ] **Step 11: Build the outputs and run the check**

Run:

```bash
nix develop -c git add engines/m17n pnpm-workspace.yaml pnpm-lock.yaml modules/typescript/files.nix
out=$(nix build --no-link --print-out-paths -L .#ibus-web-m17n-descriptors)
ls "$out" "$out"/schemas
jq length "$out"/engines.json "$out"/settings-schemas.json
jq -r '.[0].name' "$out"/engines.json
grep -c '  X(' "$out"/variable-table.h
nix build .#checks.x86_64-linux.m17n-descriptors -L
```

Expected: `engines.json`, `instances.txt`, `raw.json`, `schemas`, `settings-paths.json`, `settings-schemas.json`, `variable-table.h`, and `org.freedesktop.ibus.engine.m17n.variables.gschema.xml` in `schemas`; lengths `197` and `36`; `m17n:t:latn-post`; `53`; the check PASSes with 32 tests. The descriptor program's stderr shows three `ibus-m17n-Message`s, `skipped m17n:ko:han2`, `m17n:ko:romaja` and `m17n:zh:py since its rank is lower than 0`. If the workspace build stops with a hash mismatch for `pnpmDeps`, set `hash` in `modules/typescript/workspace.nix`'s `pnpmDeps` to the value it reports, `git add` it, and build again.

- [ ] **Step 12: Write the docs**

In `docs/m17n.md`, insert before `## Checks`:

```markdown
### ibus-m17n

`ibus-engines.m17n` is configured `--with-gtk=no`, without GTK, Python or `wrapGAppsHook3`, with its data directory in
a `data` output. Its `LIBEXECDIR`, which only the setup tool's command line uses, is `/usr/libexec`, so nothing built
from the tree refers to the package's own output. From that configured tree, upstream's Makefile builds
`libm17ncommon` (`m17nutil.c`), and our sources compile with the flags make used for it, read from the generated
Makefile.

## Engines

The engines are those `ibus_m17n_list_engines` keeps: the input methods m17n can load, that `default.xml` doesn't rank
below zero (`zh:py`, `ko:han2` and `ko:romaja`; it ranks `ja:anthy` there too), and that declare no
`candidates-charset` variable, since upstream's check for a UTF-8 charset is always true and drops every method that
declares one, on the desktop as here. `ja:anthy` and `en:ispell` need an external module, so m17n lists them as unable
to load. That leaves 197 engines, each keeping upstream's name, `m17n:<lang>:<name>`.

### Descriptors

`engines/m17n/descriptors/descriptors.c` is a WebAssembly program, run under Node at build time, linked with
libibus-web, ibus-m17n's `libm17ncommon` and m17n-lib, as the module is. It calls `ibus_m17n_init_common()` and
`ibus_m17n_get_component()`, and prints as JSON each engine's name, language, input method, rank and layout, and the
input method's variables from `minput_get_variable(lang, name, Mnil)`: each one's name, description, type, initial
value and valid values. It is built from ibus-m17n's configured tree in a derivation of its own, so that the schemas
`m17n.wasm` compiles in can come from its output: m17n-lib, then the program, then its output, then the schema
directory, then `m17n.wasm`. It runs with a 1 MiB stack: `mplist__from_file` keeps a 64 KiB read buffer on the stack,
the whole of Emscripten's default.

`descriptors.ts`, in the private workspace package `@ibus-web/m17n-descriptors`, turns that output into the module's
files, which `packages.ibus-web-m17n-descriptors` holds beside the program's output, `raw.json`:

| File                                                             | Holds                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `engines.json`                                                   | the engine descriptors, for `mkEngineManifest`'s `engines`                 |
| `settings-paths.json`                                            | each engine's path for `org.freedesktop.ibus.engine.m17n`, for `settingsPaths` |
| `settings-schemas.json`                                          | the module's schema ids: ibus-m17n's, the panel's and every variable schema's |
| `schemas/org.freedesktop.ibus.engine.m17n.variables.gschema.xml` | the input methods' variable schemas                                        |
| `variable-table.h`                                               | each variable, with its input method, schema and m17n type                 |
| `instances.txt`                                                  | every settings instance the module declares, one a line, for test harnesses |

| Descriptor field | Value                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | The engine's name                                                                                                                             |
| `languages`      | m17n's language, an ISO 639 code and so BCP 47 (`hi`, `sat`, `new`); `[]` for the `t:*` methods, which m17n's `t` marks as for any text        |
| `displayName`    | The language's English name from `Intl.DisplayNames` and the input method in parentheses, "Hindi (inscript)"; the bare input method for `t:*` |
| `keyboard`       | `{ layout: "default", passThrough: [] }`                                                                                                      |

m17n's `title` is the mode indicator (क for `hi:inscript`), not a name. ICU names no language for `ath`, `cmc`, `dra`,
`nsk` and `tai`, which take ISO 639's names: Athapascan, Chamic, Dravidian, Naskapi and Tai. Another language with no
name fails the build, as does a layout other than upstream's `default` and `default[lv3:ralt_switch]`, which both
become `default`. The module's default, the option `ibusWeb.engines.m17n.defaultEngine`, `m17n:t:latn-post`, Latin
postfix diacritics, which works on any keyboard, comes first; the rest are sorted by language, then input method.
```

At the end of `docs/m17n.md`'s `## Checks` list, add:

```markdown
- `checks.m17n-descriptors` runs the descriptor step's Vitest tests: display names, settings paths (`sa:IAST`
  included), ordering, variable keys and what fails the build, the schema XML and the variable table; and, on the
  built output, 197 engines with the default first, 197 settings paths, and 34 variable schemas with 53 keys.
```

In `docs/tooling.md`'s table under "The pnpm workspace", add a row after the `tools/*` row:

```markdown
| `engines/m17n/descriptors` | `@ibus-web/m17n-descriptors`, which turns the m17n descriptor program's output into the module's descriptors, settings paths and variable schemas |
```

Run: `nix develop -c oxfmt docs/m17n.md docs/tooling.md`

- [ ] **Step 13: Commit**

```bash
nix develop -c git add engines/m17n modules/typescript/files.nix modules/typescript/workspace.nix pnpm-workspace.yaml pnpm-lock.yaml docs/m17n.md docs/tooling.md
nix develop -c git commit -m "feat(m17n): generate engine descriptors and variable schemas from ibus-m17n's listing" -- engines/m17n modules/typescript/files.nix modules/typescript/workspace.nix pnpm-workspace.yaml pnpm-lock.yaml docs/m17n.md docs/tooling.md
```

hk's `tsc` step typechecks the new package and `tsconfig-extends` checks its tsconfig. (`modules/typescript/workspace.nix` is in the commit only if Step 11 changed it; leave it out of both commands otherwise.)

---

### Task 4: The side module, `m17n.wasm`

**Files:**
- Create (generated by Step 1): `engines/m17n/patches/ibus-m17n/port/0001-Terminate-the-UTF-8-buffer-before-converting-it-to-U.patch`, `engines/m17n/patches/ibus-m17n/casts/0001-Use-the-declared-GObject-callback-types.patch`
- Create: `engines/m17n/module/module.c`, `engines/m17n/cast-audit.jsonc`
- Modify: `engines/m17n/overlay.nix`, `engines/m17n/module.nix`, `engines/m17n/patches/README.md`
- Docs: `docs/m17n.md`, `docs/engines.md`, `docs/README.md`

**Interfaces:**
- Consumes: Task 1's context fix, Task 3's `descriptors` (the schema files), phase 1's `ibus_engine_simple_add_table_by_locale` and `ibus_keymap_get("us")`.
- Produces: `pkgsWasm.ibus-engines.m17n` building `$out/m17n.wasm` and `$data/share/ibus-m17n/default.xml`, with passthru `m17n_lib`, `schemas`, `settingsSchemaDir`, `descriptorProgram`, `descriptors`, `auditCflags`, `auditSources`; `packages.ibus-web-m17n`; `ibusWeb.engines.m17n.package` and `.settingsSchemaDir`; `checks.m17n-imports`, `checks.m17n-data-closure`; `checks.m17n-cast-audit` covering the engine too.

- [ ] **Step 1: Generate ibus-m17n's patches**

Save this script outside the tree as `$TMPDIR/ibus-m17n-patches.sh` and run it from the repository root with `nix develop -c bash $TMPDIR/ibus-m17n-patches.sh`. The port patch is new; the cast patch is the spike's, made a `git format-patch` commit.

```bash
set -euo pipefail
repo=$PWD
work=$(mktemp -d)
src=$(nix build --no-link --print-out-paths .#legacyPackages.x86_64-linux.pkgsWasm.ibus-engines.m17n.src)
cp -R "$src" "$work"/ibus-m17n
chmod -R u+w "$work"/ibus-m17n
cd "$work"/ibus-m17n
git init -q
git add -A
git -c user.name=base -c user.email=base@localhost commit -qm base
git config user.name 'Alexis Williams'
git config user.email alexis@typedr.at

python3 - <<'EOF'
import pathlib

source = pathlib.Path("src/m17nutil.c")
text = source.read_text()
old = "        return NULL;\n    }\n    ucs = g_utf8_to_ucs4_fast (buf, bufsize, nchars);\n"
new = "        return NULL;\n    }\n    buf [utf8_converter->nbytes] = 0;\n    ucs = g_utf8_to_ucs4_fast (buf, bufsize, nchars);\n"
assert text.count(old) == 1
source.write_text(text.replace(old, new, 1))
EOF
git commit -qam 'Terminate the UTF-8 buffer before converting it to UCS-4

ibus_m17n_mtext_to_ucs4 encodes into a buffer sized for the worst case
and converts the whole buffer, which g_utf8_to_ucs4_fast reads up to
its first nul byte. Nothing wrote one after the encoded text, so
whatever the allocation held before became extra characters: a lookup
table built from an M-text candidate group gained candidates that were
never in it. Terminate the text as ibus_m17n_mtext_to_utf8 does.'

git -C "$repo" show typedrat/m17n-spike:engines/m17n/patches/ibus-m17n/casts/0001-callback-types.patch | git apply
git commit -qam 'Use the declared GObject callback types

WebAssembly traps on an indirect call through a function type that
differs from the callee'"'"'s. GLib calls the class and instance
initializers as GClassInitFunc and GInstanceInitFunc, which take a
second argument these definitions lacked, and IBusObject calls destroy
as IBusObjectDestroyFunc, whose parameter is an IBusObject pointer.'

mkdir -p "$repo"/engines/m17n/patches/ibus-m17n/port "$repo"/engines/m17n/patches/ibus-m17n/casts
git format-patch -q --zero-commit --no-numbered --no-signature -o "$repo"/engines/m17n/patches/ibus-m17n/port HEAD~2..HEAD~1
git format-patch -q --zero-commit --no-numbered --no-signature -o "$repo"/engines/m17n/patches/ibus-m17n/casts HEAD~1
```

Expected: `engines/m17n/patches/ibus-m17n/port/0001-Terminate-the-UTF-8-buffer-before-converting-it-to-U.patch` (one line added to `src/m17nutil.c`) and `engines/m17n/patches/ibus-m17n/casts/0001-Use-the-declared-GObject-callback-types.patch` (`src/engine.c`: `ibus_m17n_engine_class_init (gpointer g_class, gpointer class_data)`, `ibus_m17n_engine_init (GTypeInstance *instance, gpointer g_class)`, `ibus_m17n_engine_destroy (IBusObject *object)`, and the `GTypeInfo` and `destroy` assignments without casts).

- [ ] **Step 2: Write the module's startup**

Create `engines/m17n/module/module.c`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif
#include "engine.h"
#include "m17nutil.h"
#include <ibus-web/runtime.h>

/* Keeps the compiled schemas, which the module's settings metadata lists, in
 * the side module's data closure. */
const char ibusweb_m17n_settings_schema_dir[] = IBUSWEB_SETTINGS_SCHEMA_DIR;

/* What ibus-m17n's start_component does, without a bus. The runtime keeps
 * the factory. */
void ibusweb_module_init(IBusWebModule *module G_GNUC_UNUSED) {
  ibus_m17n_init_common();

  IBusComponent *component = g_object_ref_sink(ibus_m17n_get_component());
  IBusFactory *factory = g_object_ref_sink(ibus_factory_new(NULL));
  GList *engines = ibus_component_get_engines(component);
  for (GList *p = engines; p != NULL; p = p->next) {
    const gchar *name = ibus_engine_desc_get_name(p->data);
    ibus_factory_add_engine(factory, name,
                            ibus_m17n_engine_get_type_for_name(name));
  }

  g_list_free(engines);
  g_object_unref(factory);
  g_object_unref(component);
}
```

Create `engines/m17n/cast-audit.jsonc`:

```jsonc
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-2.0-or-later
{
  "$schema": "../../tools/cast-audit/cast-audit.schema.json",
  "casts": [],
}
```

- [ ] **Step 3: Build the side module in the overlay**

In `engines/m17n/overlay.nix`:

- change `inherit (config.ibusWeb) typescript;` to `inherit (config.ibusWeb) runtime toolchain typescript;`;
- replace the `ibus-engines = prev.ibus-engines // { … };` attribute (the last attribute of the returned set) with:

```nix
          ibus-engines = prev.ibus-engines // {
            m17n =
              let
                inherit (final) m17n_lib;

                # ibus-m17n's relocatable schema, the panel's and the input
                # methods' variable schemas, compiled together.
                schemas = prev.runCommand "ibus-web-m17n-gsettings-schemas" { } ''
                  mkdir -p $out/share/glib-2.0/schemas
                  cp ${prev.ibus-engines.m17n.src}/src/org.freedesktop.ibus.engine.m17n.gschema.xml $out/share/glib-2.0/schemas/
                  cp ${final.libibus-web}/share/gsettings-schemas/${final.libibus-web.name}/glib-2.0/schemas/org.freedesktop.ibus.gschema.xml \
                    $out/share/glib-2.0/schemas/
                  cp ${descriptors}/schemas/*.gschema.xml $out/share/glib-2.0/schemas/
                  ${final.glib.dev}/bin/glib-compile-schemas --strict $out/share/glib-2.0/schemas
                '';
                settingsSchemaDir = "${schemas}/share/glib-2.0/schemas";

                # Our sources compile with the flags make used for
                # libm17ncommon, plus the schema directory module.c keeps in
                # the store closure.
                cflags = lib.concatStringsSep " " [
                  makeCflags
                  "'-DIBUSWEB_SETTINGS_SCHEMA_DIR=\"${settingsSchemaDir}\"'"
                ];

                # Relative to src/, where the flags' include paths resolve.
                sources = [
                  "m17nutil.c"
                  "engine.c"
                  "module.c"
                ];
              in
              base.overrideAttrs (old: {
                postPatch = (old.postPatch or "") + ''
                  cp ${./module/module.c} src/module.c
                '';

                # ibus-engine-m17n is a desktop process; the side module needs
                # only libm17ncommon, the engine and our module.
                buildPhase = ''
                  runHook preBuild
                  cd src
                  make libm17ncommon.la
                  $CC ${cflags} -c engine.c -o engine.o
                  $CC ${cflags} -c module.c -o module.o

                  libs="$($PKG_CONFIG --static --libs m17n-shell)"
                  source ${runtime.sideModuleLibraryGuard}
                  checkSideModuleLibraries $libs

                  # The archive is the engine's own code, not a library to
                  # pick members from.
                  $CC ${toolchain.sideModuleFlags} -g0 -Wl,--whole-archive .libs/libm17ncommon.a -Wl,--no-whole-archive \
                    engine.o module.o $libs -o m17n.wasm

                  cd ..
                  runHook postBuild
                '';

                installPhase = ''
                  runHook preInstall
                  install -Dm644 src/m17n.wasm -t $out
                  install -Dm644 src/default.xml -t $data/share/ibus-m17n
                  runHook postInstall
                '';

                passthru = (old.passthru or { }) // {
                  inherit
                    m17n_lib
                    schemas
                    settingsSchemaDir
                    descriptorProgram
                    descriptors
                    ;
                  auditCflags = cflags;
                  auditSources = sources;
                };
              });
          };
```

- [ ] **Step 4: Add the module's packages and checks**

Replace `engines/m17n/module.nix` with:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) engines runtime toolchain;
      inherit (config.ibusWeb.lib) emscriptenRoot;
      inherit (toolchain.pkgsWasm) m17n_lib ibus-web-m17n-db;
      m17n = toolchain.pkgsWasm.ibus-engines.m17n;

      engineAudit =
        (engines.castAudit {
          name = "m17n";
          inherit (m17n) src buildInputs;
          sources = m17n.auditSources;
          cflags = m17n.auditCflags;
          allowList = ./cast-audit.jsonc;
        }).overrideAttrs
          (old: {
            inherit (m17n) patches postPatch configureFlags;
            nativeBuildInputs = old.nativeBuildInputs ++ m17n.nativeBuildInputs;

            # The flags and config.h come from the engine's own configure run.
            dontConfigure = false;
            preBuild = "cd src";
          });

      # The sources of libm17n-core and libm17n, which the module links, with
      # the flags and config.h of the library's own configure run.
      libAudit =
        (engines.castAudit {
          name = "m17n-lib";
          inherit (m17n_lib) src;
          sources = [
            "character.c"
            "chartab.c"
            "database.c"
            "plist.c"
            "m17n-core.c"
            "mtext.c"
            "symbol.c"
            "textprop.c"
            "mtext-lbrk.c"
            "mtext-wseg.c"
            "charset.c"
            "coding.c"
            "input.c"
            "language.c"
            "locale.c"
            "m17n.c"
          ];
          cflags = "$(make -s --no-print-directory -f Makefile -f - print-cflags <<< 'print-cflags: ; @echo $(wordlist 2,$(words $(CC)),$(CC)) $(DEFS) $(DEFAULT_INCLUDES) $(INCLUDES) $(AM_CPPFLAGS) $(CPPFLAGS) $(AM_CFLAGS) $(CFLAGS)')";
          allowList = ./m17n-lib-cast-audit.jsonc;
        }).overrideAttrs
          (old: {
            inherit (m17n_lib) patches postPatch configureFlags;
            nativeBuildInputs = old.nativeBuildInputs ++ m17n_lib.nativeBuildInputs;
            dontConfigure = false;
            preBuild = "cd src";
          });
    in
    {
      packages.ibus-web-m17n = m17n;
      packages.ibus-web-m17n-descriptors = m17n.descriptors;

      ibusWeb.engines.m17n = {
        package = m17n;
        descriptors = "${m17n.descriptors}/engines.json";
        settingsPaths = "${m17n.descriptors}/settings-paths.json";
        inherit (m17n) settingsSchemaDir;
        settingsSchemas = "${m17n.descriptors}/settings-schemas.json";
      };

      ibusWeb.toolchain.devLibraries = [ m17n_lib ];

      ibusWeb.toolchain.clangdPathFlags."engines/m17n/module/.*\\.c" = [
        "-I${m17n.src}/src"
        ''-DIBUSWEB_SETTINGS_SCHEMA_DIR="${m17n.settingsSchemaDir}"''
      ];
      ibusWeb.toolchain.clangdPathFlags."engines/m17n/descriptors/descriptors\\.c" = [
        "-I${m17n.src}/src"
      ];

      checks.m17n-imports = pkgs.runCommand "ibus-web-m17n-imports" { nativeBuildInputs = [ pkgs.python3 ]; } ''
        cat ${
          runtime.checkSideModuleImports {
            name = "m17n";
            modules = [ "${m17n}/m17n.wasm" ];
          }
        } > $out

        # m17n-lib loads no external module, so the module needs nothing of
        # the dynamic loader.
        PYTHONPATH=${emscriptenRoot} python3 - ${m17n}/m17n.wasm >> $out <<'EOF'
        import sys
        from tools import webassembly

        loader = {"dlopen", "dlsym", "dlclose", "dlerror"}
        found = sorted(i.field for i in webassembly.get_imports(sys.argv[1]) if i.field in loader)
        print(f"{sys.argv[1]}: dynamic loader imports: {', '.join(found) or 'none'}")
        sys.exit(1 if found else 0)
        EOF
      '';

      checks.m17n-data-closure = pkgs.runCommand "ibus-web-m17n-data-closure" { } ''
        closure=${pkgs.closureInfo { rootPaths = [ m17n ]; }}/store-paths
        printf '%s\n' ${m17n} ${m17n.data} ${ibus-web-m17n-db} ${m17n.schemas} | sort > expected
        sort "$closure" > actual
        diff -u expected actual

        test -f ${m17n.data}/share/ibus-m17n/default.xml
        test -f ${m17n.settingsSchemaDir}/gschemas.compiled

        while IFS= read -r path; do
          if [ "$path" = ${m17n} ]; then continue; fi
          forbidden=$(find "$path" \( -name lib -o -name include -o -name '*.a' -o -name '*.wasm' -o -name '*.pc' \) -print)
          if [ -n "$forbidden" ]; then echo "non-data closure entries: $forbidden" >&2; exit 1; fi
        done < "$closure"

        cp "$closure" $out
      '';

      checks.m17n-cast-audit = pkgs.linkFarm "ibus-web-m17n-cast-audit" {
        engine = engineAudit;
        m17n-lib = libAudit;
      };
    };
}
```

- [ ] **Step 5: Build the module and run its checks**

Run:

```bash
nix develop -c git add engines/m17n
nix build .#ibus-web-m17n -L
cat "$(nix build --no-link --print-out-paths -L .#checks.x86_64-linux.m17n-imports)"
nix build .#checks.x86_64-linux.m17n-data-closure -L
nix build .#checks.x86_64-linux.m17n-cast-audit -L
nix build .#checks.x86_64-linux.m17n-descriptors -L
```

Expected: all PASS. `result` (the imports check) reads `…/m17n.wasm: N imported symbols, 0 missing` and `…/m17n.wasm: dynamic loader imports: none`. The data closure is exactly the module, its `-data` output, `ibus-web-m17n-db` and `ibus-web-m17n-gsettings-schemas`. The engine's cast report is empty.

- [ ] **Step 6: Update the patch inventory**

Replace `engines/m17n/patches/README.md` with:

```markdown
# m17n patches

The sources come from the pinned nixpkgs recipes: `m17n_lib` (m17n-lib 1.8.6) and `ibus-engines.m17n` (ibus-m17n
1.4.40). Local patches apply after nixpkgs' in two layers, `port` then `casts`, each sorted by filename; a layer with
no patch has no directory. Each is a `git format-patch` against that source; none has been submitted upstream yet.

`ibus-m17n/` patches the engine, GPL-2.0-or-later as ibus-m17n is. `m17n-lib/` patches the library and applies to
every WebAssembly build of m17n-lib. It is LGPL-2.1-or-later, as m17n-lib is.

| Patch                | Reason                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ibus-m17n port 0001  | Terminate the UTF-8 buffer `ibus_m17n_mtext_to_ucs4` converts. Without it, a lookup table built from an M-text candidate group gained candidates made of whatever the allocation held.                                                                                                                                                                      |
| ibus-m17n casts 0001 | Define the class initializer, instance initializer and destroy callback with their declared `GClassInitFunc`, `GInstanceInitFunc` and `IBusObjectDestroyFunc` types. The first two lacked their second argument, which trapped the first `CreateEngine`; the destroy callback had a different pointer parameter type.                                  |
| m17n-lib port 0001   | Check for pkg-config outside configure's GUI block. `AM_CONDITIONAL([HAVE_PKG_CONFIG])` sat inside it, so `--without-gui` stopped configure with an undefined conditional.                                                                                                                                                                                  |
| m17n-lib port 0002   | Check for `dlopen` outside the GUI block too, and without it fail every external module's load, as a missing module file already fails. The overlay answers `ac_cv_search_dlopen=no`, so the library imports nothing of the dynamic loader and keeps no module directory, and an input method that needs a module (`ja:anthy`, `en:ispell`) doesn't load. |

The engine's cast audit, over `m17nutil.c`, `engine.c` and the module's sources, finds nothing with the casts patch
applied; signal connections already have their full signatures, and the audit excludes the intentional `GCallback`
casts. m17n-lib's reports seven casts through `M17NFunc`, the type m17n stores every function as. Each is in
`../m17n-lib-cast-audit.jsonc` with its reason: the function is stored from, and called as, its real type, and the
three calls of external-module functions can't be reached, since no module loads.
```

- [ ] **Step 7: Write the docs**

In `docs/m17n.md`:

1. Replace the opening paragraph (from `` `engines/m17n/` ports ibus-m17n 1.4.40`` to `the checks on them.`) with:

~~~markdown
`engines/m17n/` builds ibus-m17n 1.4.40, the IBus front end of the m17n input-method library, with m17n-lib 1.8.6 and
m17n-db 1.8.10, as one engine module, `m17n.wasm`, whose 197 engines are the input methods ibus-m17n would offer on
the desktop. This page describes how it is built, how the module starts without a bus, its engines and their
descriptors, its settings, and its checks.

```sh
nix build .#ibus-web-m17n
nix build .#checks.x86_64-linux.m17n-imports
```
~~~

2. At the end of the `### ibus-m17n` section, add:

```markdown
`m17n.wasm` links `libm17ncommon`, `engine.c` and the module's sources, compiled with the same flags, with
m17n-lib's archives; `main.c`, which connects to the bus, isn't built. `default.xml`, from which ibus-m17n takes each
engine's rank and the methods it hides, is installed in the `data` output. The module's closure, which its
distribution carries, is `ibus-web-m17n-db`, the `data` output and the compiled schemas, and nothing else.

One port patch and one cast patch apply. `ibus_m17n_mtext_to_ucs4` converted a buffer it never terminated, so a
lookup table built from an M-text candidate group gained candidates made of whatever the allocation held; port 0001
terminates it. The cast patch gives `ibus_m17n_engine_class_init` and `ibus_m17n_engine_init` the two-argument types
GLib calls them with, without which the first `CreateEngine` traps, and `ibus_m17n_engine_destroy` its declared type.
```

3. Insert before `## Engines`:

```markdown
## Startup

`engines/m17n/module/module.c`'s `ibusweb_module_init` does what ibus-m17n's `start_component` does without a bus:

1. `ibus_m17n_init_common()` initialises m17n;
2. `ibus_m17n_get_component()` lists m17n's input methods and applies `default.xml`'s ranks and blacklist;
3. each listed engine's type, from `ibus_m17n_engine_get_type_for_name`, is registered with the factory.

ibus-m17n opens an engine's input method in its class constructor, when the first context of that engine is made.
The constructor already emits records, two hidden preedits and a property update; the runtime gives an engine its
context from its instance init ([runtime.md](runtime.md#protocol-dispatch-and-output)), so they reach that context.
Listing the input methods parses every `.mim`. Measured under Node while the module was ported, loading it took about
60 ms, and an engine's first `CreateEngine` from 0.1 ms to 4 ms, Cangjie's table being the largest.
```

4. Insert before `## Checks`:

```markdown
## Settings and variables

ibus-m17n opens its relocatable schema, `org.freedesktop.ibus.engine.m17n` (`lookup-table-orientation`, the preedit
colours and underline, `use-us-layout`), once for each engine, in the engine's class, at
`/org/freedesktop/ibus/engine/m17n/<lang>/<name>/`, so each engine's settings are an instance of their own and a
change reaches its class at once. The descriptor step's `settings-paths.json` lists the 197 paths for
`mkEngineManifest`'s `settingsPaths`. ibus-m17n builds each path from the engine's GType name, which lowercases the
input method's name, and keeps an all-uppercase name, `sa:IAST`, as it is, since it retries that when m17n knows no
input method by the lowercased one; the step builds the paths the same way.

`use-us-layout` looks each key up in the runtime's US keymap by its evdev code, so the keys are those at their US
positions whatever the user's layout. AltGr keys (Mod5) are looked up there without it and reach m17n as `G-` keys.
```

5. In `## Checks`, replace the `checks.m17n-cast-audit` bullet with these three bullets:

```markdown
- `checks.m17n-cast-audit` audits ibus-m17n's `m17nutil.c` and `engine.c` with the module's sources, using the
  engine's configured `config.h` and the flags make uses, against `engines/m17n/cast-audit.jsonc`, which is empty; and
  the sources of `libm17n-core` and `libm17n`, with the library's own, against
  `engines/m17n/m17n-lib-cast-audit.jsonc`: seven casts through `M17NFunc`, the type m17n stores every function as,
  each with its reason.
- `checks.m17n-imports` checks `m17n.wasm`'s imports against the runtime's export list, and that it imports nothing
  of the dynamic loader (`dlopen`, `dlsym`, `dlclose`, `dlerror`).
- `checks.m17n-data-closure` checks that the module's closure is exactly `ibus-web-m17n-db`, the `data` output with
  `default.xml` and the compiled schemas, with no libraries, headers or modules.
```

In `docs/engines.md`, add at the end:

~~~markdown
## m17n

`engines/m17n/` is ibus-m17n with m17n-lib and m17n-db in one side module, `m17n.wasm`, built through nixpkgs'
Autotools recipes. Its 197 engines, `m17n:<lang>:<name>`, are the input methods ibus-m17n lists, and their descriptors
come from that same listing, run at build time. [m17n.md](m17n.md) describes its build, startup, engines, settings and
checks.

```sh
nix build .#ibus-web-m17n
nix build .#checks.x86_64-linux.m17n-imports
```
~~~

In `docs/README.md`'s "Beside the code" table, add after the `engines/hangul/patches/README.md` row:

```markdown
| [`engines/m17n/patches/README.md`](../engines/m17n/patches/README.md)                 | m17n-lib's and ibus-m17n's patch layers                                  |
```

Run: `nix develop -c oxfmt docs/m17n.md docs/engines.md docs/README.md engines/m17n/patches/README.md`

- [ ] **Step 8: Commit**

```bash
nix develop -c git add engines/m17n docs/m17n.md docs/engines.md docs/README.md
nix develop -c git commit -m "feat(m17n): build ibus-m17n as the side module m17n.wasm" -- engines/m17n docs/m17n.md docs/engines.md docs/README.md
```

---

### Task 5: `m17n-golden`

A g_test program, run under Node through the test-program shim, initializes the runtime, sends an `Init` with every instance the module declares, loads the real `m17n.wasm` and drives engines through framed requests, as Hangul's golden harness does. Every record but a log or a settings write must carry the case's context, so the harness also checks Task 1 on every engine's first `CreateEngine`. A warning, critical or error logged by the module fails the program, at load as in every case.

**Files:**
- Create: `engines/m17n/checks/golden/checks.nix`, `engines/m17n/checks/golden/harness.h`, `engines/m17n/checks/golden/harness.c`, `engines/m17n/checks/golden/golden.c`
- Docs: `docs/m17n.md`

**Interfaces:**
- Consumes: `ibusWeb.engines.m17n` (`package`, `settingsSchemaDir`), `package.descriptors`'s `instances.txt`; phase 1's `Init` and `SettingChanged` by path and its US keymap.
- Produces: `checks.m17n-golden`; the harness API in `harness.h`, which Task 7 reuses: `golden_init(schemas_dir, module, instances, seeds, n_seeds)` (`GoldenSeed` = a path, key and value Init stores), `golden_make` (CreateEngine only), `golden_create` (CreateEngine, capabilities, focus, records cleared), `golden_destroy`, `golden_key`, `golden_type` (US keys for ASCII text), `golden_surrounding`, `golden_setting`, `golden_reset`, `golden_count`, `golden_index`, `golden_last`, `golden_object`, `golden_committed`, `golden_preedit`.

- [ ] **Step 1: Write the harness**

Create `engines/m17n/checks/golden/harness.h`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <ibus.h>

#define M17N_SCHEMA "org.freedesktop.ibus.engine.m17n"
#define M17N_PATH(lang, name) "/org/freedesktop/ibus/engine/m17n/" lang "/" name "/"
#define VARIABLES_PATH(lang, name) M17N_PATH(lang, name) "variables/"
#define GOLDEN_CAPABILITIES                                                    \
  (IBUS_CAP_PREEDIT_TEXT | IBUS_CAP_AUXILIARY_TEXT | IBUS_CAP_LOOKUP_TABLE |   \
   IBUS_CAP_SURROUNDING_TEXT | IBUS_CAP_FOCUS)

typedef struct {
  guint32 ic;
  guint16 kind;
  GVariant *payload;
} Record;

typedef struct {
  guint32 ic;
  GPtrArray *records;
  IBusEngine *engine; /* Weak, to check destruction. */
} Fixture;

/* A value Init stores for the instance at path. */
typedef struct {
  const gchar *path;
  const gchar *key;
  GVariant *value;
} GoldenSeed;

void golden_init(const gchar *schemas_dir, const gchar *module,
                 const gchar *instances, const GoldenSeed *seeds,
                 gsize n_seeds);
void golden_setup(Fixture *fixture, gconstpointer data);
void golden_teardown(Fixture *fixture, gconstpointer data);
void golden_make(Fixture *fixture, const gchar *engine);
void golden_create(Fixture *fixture, const gchar *engine);
void golden_destroy(Fixture *fixture);
void golden_clear(Fixture *fixture);
gint golden_request(Fixture *fixture, guint16 kind, GVariant *payload);
void golden_empty_request(Fixture *fixture, guint16 kind);
gint golden_key(Fixture *fixture, guint keyval, guint keycode,
                guint modifiers);
void golden_type(Fixture *fixture, const gchar *keys);
void golden_surrounding(Fixture *fixture, const gchar *text, guint cursor);
void golden_setting(Fixture *fixture, const gchar *path, const gchar *key,
                    GVariant *value);
void golden_reset(Fixture *fixture, const gchar *path);
guint golden_count(Fixture *fixture, guint16 kind);
gint golden_index(Fixture *fixture, guint16 kind);
Record *golden_last(Fixture *fixture, guint16 kind);
IBusSerializable *golden_object(Record *record, GType type);
gchar *golden_committed(Fixture *fixture);
gchar *golden_preedit(Fixture *fixture);
```

Create `engines/m17n/checks/golden/harness.c`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "harness.h"
#include <emscripten/wasmfs.h>
#include <string.h>
#include <sys/stat.h>

backend_t wasmfs_create_root_dir(void) {
  return wasmfs_create_memory_backend();
}

static void record_free(gpointer data) {
  Record *record = data;
  g_variant_unref(record->payload);
  g_free(record);
}

/* Every record but a log or a settings write belongs to the fixture's
 * context, those an engine emits while it is being made included. */
static void collect(Fixture *fixture) {
  guint32 length;
  const guint8 *bytes = ibusweb_output_peek(&length);
  guint32 offset = 0;
  while (offset < length) {
    IBusWebRecordHeader header;
    g_assert_cmpuint(length - offset, >=, sizeof header);
    memcpy(&header, bytes + offset, sizeof header);
    guint32 payload_length = GUINT32_FROM_LE(header.len);
    guint32 padded = (sizeof header + payload_length + 7) & ~7u;
    g_assert_cmpuint(padded, <=, length - offset);
    g_assert_cmpuint(GUINT16_FROM_LE(header.flags), ==, 0);

    Record *record = g_new0(Record, 1);
    record->kind = GUINT16_FROM_LE(header.kind);
    record->ic = GUINT32_FROM_LE(header.ic);
    gboolean global = record->kind == IBUSWEB_REC_LOG ||
                      record->kind == IBUSWEB_REC_SETTING_WRITTEN;
    g_assert_cmpuint(record->ic, ==, global ? 0 : fixture->ic);
    const gchar *signature = ibusweb_record_signature(record->kind);
    g_assert_nonnull(signature);
    gpointer copy = g_memdup2(bytes + offset + sizeof header, payload_length);
    record->payload = g_variant_ref_sink(g_variant_new_from_data(
        G_VARIANT_TYPE(signature), copy, payload_length, FALSE, g_free, copy));
    g_assert_true(g_variant_is_normal_form(record->payload));

    if (record->kind == IBUSWEB_REC_LOG) {
      guint level;
      const gchar *domain, *message;
      g_variant_get(record->payload, "(u&s&s)", &level, &domain, &message);
      if (level &
          (G_LOG_LEVEL_WARNING | G_LOG_LEVEL_CRITICAL | G_LOG_LEVEL_ERROR))
        g_error("Unexpected engine log (%s): %s", domain, message);
    }
    g_ptr_array_add(fixture->records, record);
    offset += padded;
  }
  ibusweb_output_consume(length);
}

gint golden_request(Fixture *fixture, guint16 kind, GVariant *payload) {
  g_variant_ref_sink(payload);
  gsize length = sizeof(IBusWebRequestHeader) + g_variant_get_size(payload);
  g_autofree guint8 *bytes = g_malloc(length);
  IBusWebRequestHeader header = {.kind = GUINT16_TO_LE(kind),
                                 .ic = GUINT32_TO_LE(fixture->ic)};
  memcpy(bytes, &header, sizeof header);
  g_variant_store(payload, bytes + sizeof header);
  gint result = ibusweb_dispatch(bytes, length);
  memset(bytes, 0xa5, length);
  g_variant_unref(payload);
  g_assert_cmpint(ibusweb_pump(), !=, IBUSWEB_PUMP_ERROR);
  collect(fixture);
  return result;
}

void golden_empty_request(Fixture *fixture, guint16 kind) {
  g_assert_cmpint(golden_request(fixture, kind, g_variant_new("()")), ==, 0);
}

gint golden_key(Fixture *fixture, guint keyval, guint keycode,
                guint modifiers) {
  gint reply =
      golden_request(fixture, IBUSWEB_REQ_PROCESS_KEY_EVENT,
                     g_variant_new("(uuu)", keyval, keycode, modifiers));
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_PROCESS_KEY_EVENT,
                                 g_variant_new("(uuu)", keyval, keycode,
                                               modifiers | IBUS_RELEASE_MASK)),
                  >=, 0);
  return reply;
}

/* The evdev code of the US key that types c unshifted. */
static guint keycode(gchar c) {
  static const struct {
    const gchar *keys;
    guint first;
  } rows[] = {{"1234567890", 2}, {"qwertyuiop", 16}, {"asdfghjkl", 30},
              {"zxcvbnm", 44}};
  for (guint i = 0; i < G_N_ELEMENTS(rows); i++) {
    const gchar *found = strchr(rows[i].keys, c);
    if (c != '\0' && found != NULL)
      return rows[i].first + (found - rows[i].keys);
  }

  switch (c) {
  case ' ':
    return 57;
  case '\'':
    return 40;
  case '`':
    return 41;
  default:
    g_error("No unshifted US key types %c", c);
  }
}

/* ASCII's printable keysyms are its code points. */
void golden_type(Fixture *fixture, const gchar *keys) {
  for (const gchar *c = keys; *c != '\0'; c++)
    g_assert_cmpint(golden_key(fixture, (guchar)*c, keycode(*c), 0), ==, 1);
}

void golden_surrounding(Fixture *fixture, const gchar *text, guint cursor) {
  IBusText *surrounding = g_object_ref_sink(ibus_text_new_from_string(text));
  GVariant *serialized =
      ibus_serializable_serialize(IBUS_SERIALIZABLE(surrounding));
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_SET_SURROUNDING_TEXT,
                                 g_variant_new("(vuu)", serialized, cursor,
                                               cursor)),
                  ==, 0);
  g_object_unref(surrounding);
}

void golden_setting(Fixture *fixture, const gchar *path, const gchar *key,
                    GVariant *value) {
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_SETTING_CHANGED,
                                 g_variant_new("(ssv)", path, key, value)),
                  ==, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_SETTING_WRITTEN), ==, 0);
}

/* Engine settings live in each engine's class for the whole run, so a case
 * that changes one starts from the defaults whatever an earlier case left. */
void golden_reset(Fixture *fixture, const gchar *path) {
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();
  g_autoptr(GSettingsSchema) schema =
      g_settings_schema_source_lookup(source, M17N_SCHEMA, TRUE);
  g_assert_nonnull(schema);
  g_auto(GStrv) names = g_settings_schema_list_keys(schema);
  for (gchar **name = names; *name != NULL; ++name) {
    g_autoptr(GSettingsSchemaKey) key = g_settings_schema_get_key(schema, *name);
    g_autoptr(GVariant) value = g_settings_schema_key_get_default_value(key);
    golden_setting(fixture, path, *name, value);
  }
}

void golden_clear(Fixture *fixture) {
  g_ptr_array_set_size(fixture->records, 0);
}

guint golden_count(Fixture *fixture, guint16 kind) {
  guint count = 0;
  for (guint i = 0; i < fixture->records->len; ++i) {
    Record *record = g_ptr_array_index(fixture->records, i);
    count += record->kind == kind;
  }
  return count;
}

/* The position of the first record of kind, or -1. */
gint golden_index(Fixture *fixture, guint16 kind) {
  for (guint i = 0; i < fixture->records->len; ++i) {
    Record *record = g_ptr_array_index(fixture->records, i);
    if (record->kind == kind)
      return i;
  }
  return -1;
}

Record *golden_last(Fixture *fixture, guint16 kind) {
  for (guint i = fixture->records->len; i > 0; --i) {
    Record *record = g_ptr_array_index(fixture->records, i - 1);
    if (record->kind == kind)
      return record;
  }
  g_error("Missing output record kind %u", kind);
}

IBusSerializable *golden_object(Record *record, GType type) {
  GVariant *serialized;
  g_variant_get_child(record->payload, 0, "v", &serialized);
  IBusSerializable *object = ibus_serializable_deserialize(serialized);
  g_assert_nonnull(object);
  g_assert_true(G_TYPE_CHECK_INSTANCE_TYPE(object, type));
  g_object_ref_sink(object);
  g_variant_unref(serialized);
  return object;
}

/* Everything committed since the records were last cleared, in order. */
gchar *golden_committed(Fixture *fixture) {
  GString *committed = g_string_new(NULL);
  for (guint i = 0; i < fixture->records->len; ++i) {
    Record *record = g_ptr_array_index(fixture->records, i);
    if (record->kind != IBUSWEB_REC_COMMIT_TEXT)
      continue;
    IBusText *text = IBUS_TEXT(golden_object(record, IBUS_TYPE_TEXT));
    g_string_append(committed, text->text);
    g_object_unref(text);
  }
  return g_string_free(committed, FALSE);
}

/* The latest preedit, or "" when there has been none. */
gchar *golden_preedit(Fixture *fixture) {
  if (golden_count(fixture, IBUSWEB_REC_UPDATE_PREEDIT_TEXT) == 0)
    return g_strdup("");
  IBusText *text = IBUS_TEXT(golden_object(
      golden_last(fixture, IBUSWEB_REC_UPDATE_PREEDIT_TEXT), IBUS_TYPE_TEXT));
  gchar *preedit = g_strdup(text->text);
  g_object_unref(text);
  return preedit;
}

static gboolean capture_engine(GSignalInvocationHint *hint G_GNUC_UNUSED,
                               guint count G_GNUC_UNUSED, const GValue *values,
                               gpointer data) {
  Fixture *fixture = data;
  fixture->engine = g_value_get_object(&values[0]);
  g_object_add_weak_pointer(G_OBJECT(fixture->engine),
                            (gpointer *)&fixture->engine);
  return TRUE;
}

/* Only the CreateEngine, so a case sees what the engine emits while it is
 * being made. */
void golden_make(Fixture *fixture, const gchar *engine) {
  static guint32 next_ic = 1;
  fixture->ic = next_ic++;
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CREATE_ENGINE,
                                 g_variant_new("(s)", engine)),
                  ==, 0);
}

void golden_create(Fixture *fixture, const gchar *engine) {
  golden_make(fixture, engine);
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_SET_CAPABILITIES,
                                 g_variant_new("(u)", GOLDEN_CAPABILITIES)),
                  ==, 0);
  guint signal = g_signal_lookup("focus-in", IBUS_TYPE_ENGINE);
  gulong hook =
      g_signal_add_emission_hook(signal, 0, capture_engine, fixture, NULL);
  golden_empty_request(fixture, IBUSWEB_REQ_FOCUS_IN);
  g_signal_remove_emission_hook(signal, hook);
  g_assert_nonnull(fixture->engine);
  golden_clear(fixture);
}

void golden_destroy(Fixture *fixture) {
  golden_empty_request(fixture, IBUSWEB_REQ_DESTROY_ENGINE);
  g_assert_null(fixture->engine);
  fixture->ic = 0;
  golden_clear(fixture);
}

void golden_setup(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  fixture->records = g_ptr_array_new_with_free_func(record_free);
}

void golden_teardown(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  if (fixture->ic != 0)
    golden_destroy(fixture);
  g_ptr_array_unref(fixture->records);
}

/* Init declares every instance the module's settings metadata does, so that
 * each engine's settings are those of an instance the page could store. */
static GVariant *instances_from(const gchar *path, const GoldenSeed *seeds,
                                gsize n_seeds) {
  g_autofree gchar *contents = NULL;
  g_assert_true(g_file_get_contents(path, &contents, NULL, NULL));
  g_auto(GStrv) lines = g_strsplit(contents, "\n", -1);
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();

  GVariantBuilder instances;
  g_variant_builder_init(&instances, G_VARIANT_TYPE("a(ssa{sv})"));
  gsize seeded = 0;
  for (gchar **line = lines; *line != NULL; line++) {
    if (**line == '\0')
      continue;
    g_auto(GStrv) parts = g_strsplit(*line, "=", 2);
    g_autoptr(GSettingsSchema) schema =
        g_settings_schema_source_lookup(source, parts[0], TRUE);
    g_assert_nonnull(schema);
    const gchar *instance =
        parts[1] != NULL ? parts[1] : g_settings_schema_get_path(schema);
    g_assert_nonnull(instance);

    GVariantBuilder values;
    g_variant_builder_init(&values, G_VARIANT_TYPE("a{sv}"));
    for (gsize i = 0; i < n_seeds; i++) {
      if (!g_str_equal(seeds[i].path, instance))
        continue;
      g_variant_builder_add(&values, "{sv}", seeds[i].key, seeds[i].value);
      seeded++;
    }
    g_variant_builder_add(&instances, "(ss@a{sv})", parts[0], instance,
                          g_variant_builder_end(&values));
  }

  g_assert_cmpuint(seeded, ==, n_seeds);
  return g_variant_builder_end(&instances);
}

void golden_init(const gchar *schemas_dir, const gchar *module,
                 const gchar *instances, const GoldenSeed *seeds,
                 gsize n_seeds) {
  g_assert_cmpint(mkdir("/nix", 0777), ==, 0);
  g_assert_cmpint(
      wasmfs_create_directory("/nix/store", 0777,
                              wasmfs_create_node_backend("/nix/store")),
      ==, 0);
  g_autofree gchar *directory = g_path_get_dirname(module);
  g_assert_cmpint(wasmfs_create_directory(
                      "/sides", 0777, wasmfs_create_node_backend(directory)),
                  ==, 0);
  g_setenv("GSETTINGS_SCHEMA_DIR", schemas_dir, TRUE);
  g_unsetenv("GSETTINGS_BACKEND");
  g_setenv("G_MESSAGES_DEBUG", "all", TRUE);
  static gint32 wake_word;
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, 0);

  Fixture fixture = {.records = g_ptr_array_new_with_free_func(record_free)};
  g_assert_cmpint(
      golden_request(&fixture, IBUSWEB_REQ_INIT,
                     g_variant_new("(u@a(ssa{sv}))", IBUSWEB_PROTOCOL_VERSION,
                                   instances_from(instances, seeds, n_seeds))),
      ==, 0);
  g_log_set_default_handler(g_log_default_handler, NULL);
  g_assert_cmpint(ibusweb_load_module("/sides/m17n.wasm", NULL), ==, 0);
  collect(&fixture);
  g_ptr_array_unref(fixture.records);
}
```

- [ ] **Step 2: Write the cases**

Create `engines/m17n/checks/golden/golden.c`. The expected texts are those the module produced under Node while it was ported (see [what was verified](#what-was-verified-and-how)); `altgr`, `us-layout` and `settings-apart` depend on phase 1's keymap and relocatable settings.

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "harness.h"

/* The relocatable instances the cases change. */
static const gchar *const changed_paths[] = {M17N_PATH("hi", "inscript"),
                                             M17N_PATH("mr", "inscript")};

static void setup(Fixture *fixture, gconstpointer data) {
  golden_setup(fixture, data);
  for (guint i = 0; i < G_N_ELEMENTS(changed_paths); i++)
    golden_reset(fixture, changed_paths[i]);
  golden_clear(fixture);
}

static void committed(Fixture *fixture, const gchar *expected) {
  g_autofree gchar *text = golden_committed(fixture);
  g_assert_cmpstr(text, ==, expected);
}

static void preedit(Fixture *fixture, const gchar *expected) {
  g_autofree gchar *text = golden_preedit(fixture);
  g_assert_cmpstr(text, ==, expected);
}

static void candidates(Fixture *fixture, const gchar *const *expected,
                       const gchar *page) {
  IBusLookupTable *table = IBUS_LOOKUP_TABLE(golden_object(
      golden_last(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE),
      IBUS_TYPE_LOOKUP_TABLE));
  guint count = g_strv_length((gchar **)expected);
  g_assert_cmpuint(ibus_lookup_table_get_number_of_candidates(table), ==,
                   count);
  g_assert_cmpuint(ibus_lookup_table_get_page_size(table), ==, count);
  for (guint i = 0; i < count; i++)
    g_assert_cmpstr(ibus_lookup_table_get_candidate(table, i)->text, ==,
                    expected[i]);
  g_object_unref(table);

  IBusText *aux = IBUS_TEXT(golden_object(
      golden_last(fixture, IBUSWEB_REC_UPDATE_AUXILIARY_TEXT),
      IBUS_TYPE_TEXT));
  g_assert_cmpstr(aux->text, ==, page);
  g_object_unref(aux);
}

/* ibus-m17n's constructor opens the input method and draws its preedit and
 * status before CreateEngine returns. */
static void context(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_make(fixture, "m17n:t:latn-pre");
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_HIDE_PREEDIT_TEXT), ==,
                   2);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_UPDATE_PROPERTY), ==, 1);
}

static void latin_postfix(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:t:latn-post");
  golden_type(fixture, "a");
  preedit(fixture, "a");
  golden_type(fixture, "'");
  preedit(fixture, "á");
  committed(fixture, "");
  golden_type(fixture, " ");
  committed(fixture, "á ");
  preedit(fixture, "");
}

static void inscript(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:hi:inscript");
  golden_type(fixture, "k");
  committed(fixture, "क");
  golden_clear(fixture);
  golden_type(fixture, "d");
  committed(fixture, "");
  preedit(fixture, "्");
}

static void telex(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:vi:telex");
  golden_type(fixture, "vieetj");
  committed(fixture, "v");
  preedit(fixture, "iệt");
  golden_clear(fixture);
  golden_type(fixture, " ");
  committed(fixture, "iệt ");
  preedit(fixture, "");
}

/* Kesmanee checks each key against the text before the cursor, which it
 * reads through surrounding text, and replaces a tone mark that can't
 * follow another by deleting the one before it. */
static void thai_surrounding(Fixture *fixture,
                             gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:th:kesmanee");
  golden_surrounding(fixture, "ก", 1);
  golden_clear(fixture);
  golden_type(fixture, "h");
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT),
                   >, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_DELETE_SURROUNDING_TEXT),
                   ==, 0);
  committed(fixture, "้");
  golden_destroy(fixture);

  golden_create(fixture, "m17n:th:kesmanee");
  golden_surrounding(fixture, "ก่", 2);
  golden_clear(fixture);
  golden_type(fixture, "h");
  gint offset;
  guint length;
  g_variant_get(
      golden_last(fixture, IBUSWEB_REC_DELETE_SURROUNDING_TEXT)->payload,
      "(iu)", &offset, &length);
  g_assert_cmpint(offset, ==, -1);
  g_assert_cmpuint(length, ==, 1);
  g_assert_cmpint(golden_index(fixture, IBUSWEB_REC_DELETE_SURROUNDING_TEXT),
                  <, golden_index(fixture, IBUSWEB_REC_COMMIT_TEXT));
  committed(fixture, "้");
}

static void cangjie(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:zh:cangjie");
  golden_type(fixture, "a");
  preedit(fixture, "日");
  candidates(fixture, (const gchar *[]){"日", "曰", NULL}, "( 1 / 1 )");
  golden_type(fixture, " ");
  committed(fixture, "日");
}

/* With AltGr, the keyval is whatever the user's layout gave; ibus-m17n
 * asks the US keymap for the key's unshifted keysym and adds G-. */
static void altgr(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:hi:inscript");
  g_assert_cmpint(golden_key(fixture, IBUS_currency, 5, IBUS_MOD5_MASK), ==,
                  1);
  committed(fixture, "₹");
}

static void us_layout(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:hi:inscript");
  golden_setting(fixture, M17N_PATH("hi", "inscript"), "use-us-layout",
                 g_variant_new_boolean(TRUE));
  g_assert_cmpint(golden_key(fixture, IBUS_x, 37, 0), ==, 1);
  committed(fixture, "क");
  golden_clear(fixture);

  golden_setting(fixture, M17N_PATH("hi", "inscript"), "use-us-layout",
                 g_variant_new_boolean(FALSE));
  g_assert_cmpint(golden_key(fixture, IBUS_x, 37, 0), ==, 1);
  committed(fixture, "ं");
}

/* One relocatable schema, an instance per engine: Hindi's setting leaves
 * Marathi's alone. */
static void settings_apart(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_setting(fixture, M17N_PATH("hi", "inscript"), "use-us-layout",
                 g_variant_new_boolean(TRUE));
  golden_create(fixture, "m17n:mr:inscript");
  g_assert_cmpint(golden_key(fixture, IBUS_x, 37, 0), ==, 1);
  committed(fixture, "ं");
  golden_destroy(fixture);

  golden_create(fixture, "m17n:hi:inscript");
  g_assert_cmpint(golden_key(fixture, IBUS_x, 37, 0), ==, 1);
  committed(fixture, "क");
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  gchar *schemas_dir = NULL, *module = NULL, *instances = NULL;
  GOptionEntry options[] = {
      {"schemas", 0, 0, G_OPTION_ARG_STRING, &schemas_dir,
       "Compiled GSettings schemas directory", "DIR"},
      {"module", 0, 0, G_OPTION_ARG_FILENAME, &module, "Engine side module",
       "FILE"},
      {"instances", 0, 0, G_OPTION_ARG_FILENAME, &instances,
       "The module's settings instances", "FILE"},
      {NULL}};
  GOptionContext *context_options = g_option_context_new(NULL);
  g_option_context_add_main_entries(context_options, options, NULL);
  GError *error = NULL;
  g_assert_true(g_option_context_parse(context_options, &argc, &argv, &error));
  g_assert_no_error(error);
  g_assert_nonnull(schemas_dir);
  g_assert_nonnull(module);
  g_assert_nonnull(instances);

  golden_init(schemas_dir, module, instances, NULL, 0);
  g_free(schemas_dir);
  g_free(module);
  g_free(instances);
  g_option_context_free(context_options);

  g_test_add("/m17n/context", Fixture, NULL, setup, context, golden_teardown);
  g_test_add("/m17n/latin-postfix", Fixture, NULL, setup, latin_postfix,
             golden_teardown);
  g_test_add("/m17n/inscript", Fixture, NULL, setup, inscript,
             golden_teardown);
  g_test_add("/m17n/telex", Fixture, NULL, setup, telex, golden_teardown);
  g_test_add("/m17n/thai-surrounding", Fixture, NULL, setup, thai_surrounding,
             golden_teardown);
  g_test_add("/m17n/cangjie", Fixture, NULL, setup, cangjie, golden_teardown);
  g_test_add("/m17n/altgr", Fixture, NULL, setup, altgr, golden_teardown);
  g_test_add("/m17n/us-layout", Fixture, NULL, setup, us_layout,
             golden_teardown);
  g_test_add("/m17n/settings-apart", Fixture, NULL, setup, settings_apart,
             golden_teardown);
  return g_test_run();
}
```

Create `engines/m17n/checks/golden/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb)
        engines
        runtime
        testing
        toolchain
        ;
      inherit (engines) m17n;

      program = testing.program {
        name = "m17n-golden";
        src = ./.;
        sources = [
          "golden.c"
          "harness.c"
        ];

        format = "tap";
        gtest = false;

        nativeBuildInputs = [ toolchain.pkgsWasm.pkg-config ];
        buildInputs = [ runtime.libibusWeb ];
        cflags = "$($PKG_CONFIG --cflags libibus-web ibus-1.0)";
        libs = "$($PKG_CONFIG --static --libs libibus-web)";

        # mplist__from_file keeps a 64 KiB read buffer on the stack, the
        # whole of Emscripten's default.
        linkFlags = config.ibusWeb.lib.testLinkFlagsWithoutNodeFs ++ [
          "-sSTACK_SIZE=1MB"
          "-sDEFAULT_PTHREAD_STACK_SIZE=1MB"
        ];
        args = [
          "--schemas"
          m17n.settingsSchemaDir
          "--module"
          "${m17n.package}/m17n.wasm"
          "--instances"
          "${m17n.package.descriptors}/instances.txt"
        ];
      };
    in
    {
      checks.m17n-golden = testing.programs {
        name = "m17n-golden";
        programs = [ program ];
        environments = [ "node" ];
      };
    };
}
```

- [ ] **Step 3: Run the golden tests**

Run: `nix develop -c git add engines/m17n/checks && nix build .#checks.x86_64-linux.m17n-golden -L`
Expected: PASS: Vitest reports `/m17n/context`, `/m17n/latin-postfix`, `/m17n/inscript`, `/m17n/telex`, `/m17n/thai-surrounding`, `/m17n/cangjie`, `/m17n/altgr`, `/m17n/us-layout`, `/m17n/settings-apart` and `run`, all passed. If `/m17n/context` fails on a record's context, Task 1's fix is missing from the branch.

[docs/testing.md](../testing.md#running-tests-locally) describes running a single case from the checkout.

- [ ] **Step 4: Write the docs**

At the end of `docs/m17n.md`'s `## Checks` list, add:

```markdown
- `checks.m17n-golden` runs a g_test program under Node with the real `m17n.wasm` and its data. Init declares every
  instance the module's metadata does, from the descriptor step's `instances.txt`. The cases: an engine's first
  `CreateEngine` emits its hidden preedits and property update on its own context; Latin postfix (`a'` gives á);
  Hindi InScript's direct keys and its halant in the preedit; Vietnamese Telex's preedit; Thai Kesmanee reading the
  surrounding text and, after a tone mark, deleting it before committing another; Cangjie's lookup table; AltGr and
  `use-us-layout` through the runtime's US keymap; and `use-us-layout` on Hindi InScript leaving Marathi InScript's
  instance alone. Every record but a log or a settings write must be on the case's context, and a warning from the
  module fails the program.
```

Run: `nix develop -c oxfmt docs/m17n.md`

- [ ] **Step 5: Commit**

```bash
nix develop -c git add engines/m17n/checks/golden docs/m17n.md
nix develop -c git commit -m "test(m17n): golden tests of m17n.wasm under Node" -- engines/m17n/checks/golden docs/m17n.md
```

---

### Task 6: m17n's variables as settings

**Files:**
- Create: `engines/m17n/module/variables.c`, `engines/m17n/module/variables.h`
- Modify: `engines/m17n/module/module.c`, `engines/m17n/overlay.nix`, `engines/m17n/module.nix`, `engines/m17n/checks/golden/golden.c`, `engines/m17n/patches/README.md`
- Docs: `docs/m17n.md`, `docs/known-gaps.md`

**Interfaces:**
- Consumes: Task 3's `variable-table.h` (`IBUSWEB_M17N_VARIABLES(X)`, `X(lang, name, schema, key, INTEGER | SYMBOL | TEXT)`) and the variable schemas compiled into the module's directory (Task 4).
- Produces: `void ibusweb_m17n_variables_init(void);` (`variables.h`), called from `ibusweb_module_init` between `ibus_m17n_init_common()` and `ibus_m17n_get_component()`.

- [ ] **Step 1: Write the failing cases**

In `engines/m17n/checks/golden/golden.c`, insert above `int main(int argc, char **argv) {`:

```c
/* candidates-group-size is 2 from Init, so 瀛's six candidates take three
 * pages. */
static void cangjie_paging(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:zh:cangjie");
  golden_type(fixture, "eyrn");
  preedit(fixture, "瀛");
  candidates(fixture, (const gchar *[]){"瀛", "渟", NULL}, "( 1 / 3 )");

  golden_empty_request(fixture, IBUSWEB_REQ_PAGE_DOWN);
  preedit(fixture, "涥");
  candidates(fixture, (const gchar *[]){"涥", "灜", NULL}, "( 2 / 3 )");
  golden_empty_request(fixture, IBUSWEB_REQ_PAGE_UP);
  preedit(fixture, "瀛");
  candidates(fixture, (const gchar *[]){"瀛", "渟", NULL}, "( 1 / 3 )");
  golden_empty_request(fixture, IBUSWEB_REQ_PAGE_DOWN);

  golden_clear(fixture);
  golden_type(fixture, " ");
  committed(fixture, "涥");
}

/* tone-mark-on-last is 1 for Telex from Init and 0, its default, for VNI:
 * an equivocal "oa" takes its tone on the last vowel only in Telex. */
static void variable_from_init(Fixture *fixture,
                               gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "m17n:vi:telex");
  golden_type(fixture, "hoaf ");
  committed(fixture, "hoà ");
  golden_destroy(fixture);

  golden_create(fixture, "m17n:vi:vni");
  golden_type(fixture, "hoa2 ");
  committed(fixture, "hòa ");
}

/* m17n takes a variable's new value when it next opens the input method,
 * which for VIQR, never made before this case, is its first context. */
static void variable_changed(Fixture *fixture,
                             gconstpointer data G_GNUC_UNUSED) {
  golden_setting(fixture, VARIABLES_PATH("vi", "viqr"), "tone-mark-on-last",
                 g_variant_new_int32(1));
  golden_create(fixture, "m17n:vi:viqr");
  golden_type(fixture, "hoa` ");
  committed(fixture, "hoà ");
}
```

In `main`, replace `golden_init(schemas_dir, module, instances, NULL, 0);` with:

```c
  const GoldenSeed seeds[] = {
      {VARIABLES_PATH("vi", "telex"), "tone-mark-on-last",
       g_variant_new_int32(1)},
      {VARIABLES_PATH("zh", "cangjie"), "candidates-group-size",
       g_variant_new_int32(2)},
  };
  golden_init(schemas_dir, module, instances, seeds, G_N_ELEMENTS(seeds));
```

and insert above `return g_test_run();`:

```c
  g_test_add("/m17n/cangjie-paging", Fixture, NULL, setup, cangjie_paging,
             golden_teardown);
  g_test_add("/m17n/variable-from-init", Fixture, NULL, setup,
             variable_from_init, golden_teardown);
  g_test_add("/m17n/variable-changed", Fixture, NULL, setup, variable_changed,
             golden_teardown);
```

- [ ] **Step 2: Run the cases to see them fail**

Run: `nix develop -c git add engines/m17n/checks/golden && nix build .#checks.x86_64-linux.m17n-golden -L`
Expected: FAIL at `/m17n/cangjie-paging` with `assertion failed (ibus_lookup_table_get_number_of_candidates(table) == count): (6 == 2)`: without the variable, Cangjie's group size is its default 10, so 瀛's six candidates fit one page. The two later cases, which the abort leaves unreported, fail too (without the variable, Telex gives `hòa ` and VIQR `hòa `).

- [ ] **Step 3: Write `variables.c`**

Create `engines/m17n/module/variables.h`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once

/* Configures m17n's input-method variables from their settings, and again
 * whenever one of them changes. */
void ibusweb_m17n_variables_init(void);
```

Create `engines/m17n/module/variables.c`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "variables.h"
#include "variable-table.h"
#include <gio/gio.h>
#include <m17n.h>
#include <stdint.h>
#include <string.h>

typedef enum { INTEGER, SYMBOL, TEXT } Type;

typedef struct {
  const gchar *language;
  const gchar *name;
  const gchar *schema;
  const gchar *key;
  Type type;
} Variable;

#define VARIABLE(language, name, schema, key, type)                            \
  {language, name, schema, key, type},
static const Variable variables[] = {IBUSWEB_M17N_VARIABLES(VARIABLE)};
#undef VARIABLE

/* m17n gives a configured value to the input methods it opens afterwards.
 * ibus-m17n opens each engine's once, with its first context, so a value
 * reaches an engine whose input method is already open only when the module
 * next starts. The configuration is never saved: the page's settings are its
 * only store. */
static void configure(const Variable *variable, GSettings *settings) {
  g_autoptr(GVariant) value = g_settings_get_value(settings, variable->key);
  MPlist *plist = mplist();
  MText *text = NULL;
  const gchar *string = NULL;

  switch (variable->type) {
  case INTEGER:
    mplist_add(plist, Minteger,
               (void *)(intptr_t)g_variant_get_int32(value));
    break;
  case SYMBOL:
    mplist_add(plist, Msymbol, msymbol(g_variant_get_string(value, NULL)));
    break;
  case TEXT:
    string = g_variant_get_string(value, NULL);
    text = mconv_decode_buffer(Mcoding_utf_8, (const unsigned char *)string,
                               strlen(string));
    mplist_add(plist, Mtext, text);
    break;
  }

  if (minput_config_variable(msymbol(variable->language),
                             msymbol(variable->name), msymbol(variable->key),
                             plist) != 0)
    g_warning("m17n refused the value of %s:%s's variable %s",
              variable->language, variable->name, variable->key);

  if (text != NULL)
    m17n_object_unref(text);
  m17n_object_unref(plist);
}

static void changed(GSettings *settings, const gchar *key, gpointer data) {
  const gchar *schema = data;
  for (gsize i = 0; i < G_N_ELEMENTS(variables); i++)
    if (g_str_equal(variables[i].schema, schema) &&
        g_str_equal(variables[i].key, key))
      configure(&variables[i], settings);
}

void ibusweb_m17n_variables_init(void) {
  GSettings *settings = NULL;
  for (gsize i = 0; i < G_N_ELEMENTS(variables); i++) {
    /* A schema's variables are listed together. Its GSettings lives as long
     * as the module, which has no shutdown entry point. */
    if (i == 0 || !g_str_equal(variables[i].schema, variables[i - 1].schema)) {
      settings = g_settings_new(variables[i].schema);
      g_signal_connect(settings, "changed", G_CALLBACK(changed),
                       (gpointer)variables[i].schema);
    }
    configure(&variables[i], settings);
  }
}
```

Replace `engines/m17n/module/module.c` with:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif
#include "engine.h"
#include "m17nutil.h"
#include "variables.h"
#include <ibus-web/runtime.h>

/* Keeps the compiled schemas, which the module's settings metadata lists, in
 * the side module's data closure. */
const char ibusweb_m17n_settings_schema_dir[] = IBUSWEB_SETTINGS_SCHEMA_DIR;

/* What ibus-m17n's start_component does, without a bus. An engine opens its
 * input method when its first context is made, so the variables are in place
 * before any input method opens. The runtime keeps the factory. */
void ibusweb_module_init(IBusWebModule *module G_GNUC_UNUSED) {
  ibus_m17n_init_common();
  ibusweb_m17n_variables_init();

  IBusComponent *component = g_object_ref_sink(ibus_m17n_get_component());
  IBusFactory *factory = g_object_ref_sink(ibus_factory_new(NULL));
  GList *engines = ibus_component_get_engines(component);
  for (GList *p = engines; p != NULL; p = p->next) {
    const gchar *name = ibus_engine_desc_get_name(p->data);
    ibus_factory_add_engine(factory, name,
                            ibus_m17n_engine_get_type_for_name(name));
  }

  g_list_free(engines);
  g_object_unref(factory);
  g_object_unref(component);
}
```

- [ ] **Step 4: Build `variables.c` into the module**

In `engines/m17n/overlay.nix`, inside `ibus-engines.m17n`:

1. Replace the `cflags` binding and its comment with:

```nix
                # Our sources compile with the flags make used for
                # libm17ncommon, plus the schema directory module.c keeps in
                # the store closure and the table variables.c reads.
                cflags = lib.concatStringsSep " " [
                  makeCflags
                  "'-DIBUSWEB_SETTINGS_SCHEMA_DIR=\"${settingsSchemaDir}\"'"
                  "-I${descriptors}"
                ];
```

2. In `sources`, add `"variables.c"` after `"module.c"`.

3. Replace the `postPatch` with:

```nix
                postPatch = (old.postPatch or "") + ''
                  cp ${./module/module.c} src/module.c
                  cp ${./module/variables.c} src/variables.c
                  cp ${./module/variables.h} src/variables.h
                '';
```

4. In `buildPhase`, after `$CC ${cflags} -c module.c -o module.o` add `$CC ${cflags} -c variables.c -o variables.o`, and in the link line change `engine.o module.o $libs -o m17n.wasm` to `engine.o module.o variables.o $libs -o m17n.wasm`.

In `engines/m17n/module.nix`, add `"-I${m17n.descriptors}"` to the `clangdPathFlags."engines/m17n/module/.*\\.c"` list, after the `-I${m17n.src}/src` entry.

- [ ] **Step 5: Run the checks**

Run:

```bash
nix develop -c git add engines/m17n
nix build .#checks.x86_64-linux.m17n-golden -L
nix build .#checks.x86_64-linux.m17n-cast-audit -L
nix build .#checks.x86_64-linux.m17n-imports -L
nix build .#checks.x86_64-linux.m17n-data-closure -L
```

Expected: all PASS; `m17n-golden` reports its twelve cases and `run`. The engine's cast report stays empty (the `changed` handler connects through `G_CALLBACK` with the signal's full signature). The data closure is unchanged: `variable-table.h` holds no store path, so the step's output stays out of it.

- [ ] **Step 6: Write the docs**

In `docs/m17n.md`:

1. In the opening paragraph, replace `its settings, and its checks.` with `its settings and m17n's input-method variables, and its checks.`

2. In `## Startup`, replace the numbered list with:

```markdown
1. `ibus_m17n_init_common()` initialises m17n;
2. `ibusweb_m17n_variables_init()` applies the input-method variables from their settings
   ([Settings and variables](#settings-and-variables));
3. `ibus_m17n_get_component()` lists m17n's input methods and applies `default.xml`'s ranks and blacklist;
4. each listed engine's type, from `ibus_m17n_engine_get_type_for_name`, is registered with the factory.
```

and after the list's following paragraph's first sentence (`…when the first context of that engine is made.`) add ` The variables are in place before any input method opens.`

3. At the end of `## Settings and variables`, add:

```markdown
41 of m17n-db's input methods declare variables; 34 of them are engines, with 53 variables (`candidates-group-size`,
`trim-last-halant`, `tone-mark-on-last`, `use-surrounding-text`, `level`, …). The descriptor program reads each
engine's with `minput_get_variable(lang, name, Mnil)`, and for each engine that has any, the step writes a fixed-path
schema, `org.freedesktop.ibus.engine.m17n.<lang>.<name>`, at the engine's path with `variables/` added:

| m17n type | Key type | Constraint                                                         |
| --------- | -------- | ------------------------------------------------------------------ |
| integer   | `i`      | its valid values as one range; m17n-db's are 0–1 or 0–2, or none |
| symbol    | `s`      | its valid values as choices                                        |
| text      | `s`      | none                                                               |

Defaults and descriptions are the input method's. A variable whose name isn't a valid GSettings key, one without an
initial value, integer values that aren't one range, or a default outside its values fails the build. The schemas
compile with ibus-m17n's and the panel's into the module's schema directory, and `settings-schemas.json` lists them
all, so the page stores them as it stores any settings.

`engines/m17n/module/variables.c` applies them from the step's `variable-table.h`, which lists each variable with its
input method, schema and m17n type. At module init, before ibus-m17n lists the input methods, it reads every one and
calls `minput_config_variable`; on a schema's `changed` signal it does so for the changed key. m17n gives a configured
value to the input methods it opens afterwards, and ibus-m17n opens each engine's once, with its first context, so a
change reaches an engine not yet made in the Worker, and one already made only when the module next starts
([known gaps](known-gaps.md#engines-and-page-integration)). `minput_save_config` is never called: the page's settings
are the only store, and `~/.m17n.d/config.mic` is never written.
```

4. In `## Checks`, replace the `checks.m17n-golden` bullet with:

```markdown
- `checks.m17n-golden` runs a g_test program under Node with the real `m17n.wasm` and its data. Init declares every
  instance the module's metadata does, from the descriptor step's `instances.txt`, and stores Telex's
  `tone-mark-on-last` as 1 and Cangjie's `candidates-group-size` as 2. The cases: an engine's first `CreateEngine`
  emits its hidden preedits and property update on its own context; Latin postfix (`a'` gives á); Hindi InScript's
  direct keys and its halant in the preedit; Vietnamese Telex's preedit; Thai Kesmanee reading the surrounding text
  and, after a tone mark, deleting it before committing another; Cangjie's lookup table, and its paging with groups of
  two; AltGr and `use-us-layout` through the runtime's US keymap; `use-us-layout` on Hindi InScript leaving Marathi
  InScript's instance alone; Telex putting the tone of `hoaf` on the last vowel from Init, where VNI, at its default,
  puts it on the first; and a variable changed before VIQR's first context reaching it. Every record but a log or a
  settings write must be on the case's context, and a warning from the module fails the program.
```

In `engines/m17n/patches/README.md`, at the end of the `ibus-m17n port 0001` row's reason, add: ` m17n-golden's Cangjie paging case checks each page's exact candidates.`

In `docs/known-gaps.md`, under `## Engines and page integration`, add after the `**Mozc settings that wait for a restart.**` item:

```markdown
- **m17n variable changes that wait for a restart.** m17n gives a changed input-method variable to the input methods
  it opens afterwards, and ibus-m17n opens each engine's once, with its first context, so a change reaches an engine
  already used in the Worker only when the module next starts ([m17n.md](m17n.md#settings-and-variables)). m17n's
  key bindings (`minput_config_command`) and its per-user customisation file have no equivalent on the page.
```

Run: `nix develop -c oxfmt docs/m17n.md docs/known-gaps.md engines/m17n/patches/README.md`

- [ ] **Step 7: Commit**

```bash
nix develop -c git add engines/m17n docs/m17n.md docs/known-gaps.md
nix develop -c git commit -m "feat(m17n): apply input-method variables from their settings" -- engines/m17n docs/m17n.md docs/known-gaps.md
```

---

### Task 7: `m17n-engines`

**Files:**
- Create: `engines/m17n/checks/engines/checks.nix`, `engines/m17n/checks/engines/engines.c`
- Docs: `docs/m17n.md`

**Interfaces:**
- Consumes: Task 5's harness (`engines/m17n/checks/golden/harness.{h,c}`); `ibusWeb.engines.m17n.descriptors`.
- Produces: `checks.m17n-engines`, one g_test case per descriptor, `/m17n-engines/<engine name>`.

- [ ] **Step 1: Write the program**

Create `engines/m17n/checks/engines/engines.c`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "../golden/harness.h"

/* Making the engine opens its input method; the keys run it, whatever it
 * makes of them. A warning from either fails the case. */
static void engine(Fixture *fixture, gconstpointer data) {
  golden_create(fixture, data);
  golden_key(fixture, IBUS_a, 30, 0);
  golden_key(fixture, IBUS_1, 2, 0);
  golden_key(fixture, IBUS_space, 57, 0);
  golden_key(fixture, IBUS_BackSpace, 14, 0);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  gchar *schemas_dir = NULL, *module = NULL, *instances = NULL,
        *engines = NULL;
  GOptionEntry options[] = {
      {"schemas", 0, 0, G_OPTION_ARG_STRING, &schemas_dir,
       "Compiled GSettings schemas directory", "DIR"},
      {"module", 0, 0, G_OPTION_ARG_FILENAME, &module, "Engine side module",
       "FILE"},
      {"instances", 0, 0, G_OPTION_ARG_FILENAME, &instances,
       "The module's settings instances", "FILE"},
      {"engines", 0, 0, G_OPTION_ARG_FILENAME, &engines,
       "The engines' names, one a line", "FILE"},
      {NULL}};
  GOptionContext *context = g_option_context_new(NULL);
  g_option_context_add_main_entries(context, options, NULL);
  GError *error = NULL;
  g_assert_true(g_option_context_parse(context, &argc, &argv, &error));
  g_assert_no_error(error);
  g_assert_nonnull(schemas_dir);
  g_assert_nonnull(module);
  g_assert_nonnull(instances);
  g_assert_nonnull(engines);
  golden_init(schemas_dir, module, instances, NULL, 0);

  g_autofree gchar *contents = NULL;
  g_assert_true(g_file_get_contents(engines, &contents, NULL, NULL));
  /* The names are the cases' data for the whole run. */
  gchar **names = g_strsplit(g_strchomp(contents), "\n", -1);
  for (gchar **name = names; *name != NULL; name++) {
    g_autofree gchar *path = g_strdup_printf("/m17n-engines/%s", *name);
    g_test_add(path, Fixture, *name, golden_setup, engine, golden_teardown);
  }

  g_free(schemas_dir);
  g_free(module);
  g_free(instances);
  g_free(engines);
  g_option_context_free(context);
  return g_test_run();
}
```

Create `engines/m17n/checks/engines/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb)
        engines
        runtime
        testing
        toolchain
        ;
      inherit (engines) m17n;

      # One engine name a line, from the descriptors the manifest lists.
      names = pkgs.runCommand "ibus-web-m17n-engine-names" { nativeBuildInputs = [ pkgs.jq ]; } ''
        jq -r '.[].name' ${m17n.descriptors} > $out
      '';

      # The golden tests' harness, from their directory.
      program = testing.program {
        name = "m17n-engines";
        src = ../.;
        sources = [
          "golden/harness.c"
          "engines/engines.c"
        ];

        format = "tap";
        gtest = false;

        nativeBuildInputs = [ toolchain.pkgsWasm.pkg-config ];
        buildInputs = [ runtime.libibusWeb ];
        cflags = "$($PKG_CONFIG --cflags libibus-web ibus-1.0)";
        libs = "$($PKG_CONFIG --static --libs libibus-web)";

        # mplist__from_file keeps a 64 KiB read buffer on the stack, the
        # whole of Emscripten's default.
        linkFlags = config.ibusWeb.lib.testLinkFlagsWithoutNodeFs ++ [
          "-sSTACK_SIZE=1MB"
          "-sDEFAULT_PTHREAD_STACK_SIZE=1MB"
        ];
        args = [
          "--schemas"
          m17n.settingsSchemaDir
          "--module"
          "${m17n.package}/m17n.wasm"
          "--instances"
          "${m17n.package.descriptors}/instances.txt"
          "--engines"
          "${names}"
        ];
      };
    in
    {
      checks.m17n-engines = testing.programs {
        name = "m17n-engines";
        programs = [ program ];
        environments = [ "node" ];
      };
    };
}
```

- [ ] **Step 2: Run it**

Run: `nix develop -c git add engines/m17n/checks/engines && nix build .#checks.x86_64-linux.m17n-engines -L`
Expected: PASS: 197 cases, `/m17n-engines/m17n:t:latn-post` first, and `run`. (Under Node, all 197 engines with their keys took about 0.2 s while the module was ported.) A case that fails names its engine; the shim shows that case's log, with the warning that failed it.

- [ ] **Step 3: Write the docs**

At the end of `docs/m17n.md`'s `## Checks` list, add:

```markdown
- `checks.m17n-engines` makes each engine the descriptors list, in the same Worker, types `a`, `1`, space and
  BackSpace, and destroys it; a warning from any of the 197 fails it. The engine names come from `engines.json`, so
  the module and its manifest are checked against each other: every descriptor names an engine the module registered.
```

Run: `nix develop -c oxfmt docs/m17n.md`

- [ ] **Step 4: Commit**

```bash
nix develop -c git add engines/m17n/checks/engines docs/m17n.md
nix develop -c git commit -m "test(m17n): make every engine the descriptors list" -- engines/m17n/checks/engines docs/m17n.md
```

---

### Task 8: Verify the phase

- [ ] **Step 1: Generated files**

Run: `nix run .#write-files && git status --short`
Expected: no change.

- [ ] **Step 2: The phase's checks**

Run each; expected PASS:

```bash
nix build .#checks.x86_64-linux.libibus-web-tests -L
nix build .#checks.x86_64-linux.m17n-descriptors -L
nix build .#checks.x86_64-linux.m17n-imports -L
nix build .#checks.x86_64-linux.m17n-data-closure -L
nix build .#checks.x86_64-linux.m17n-cast-audit -L
nix build .#checks.x86_64-linux.m17n-golden -L
nix build .#checks.x86_64-linux.m17n-engines -L
nix build .#checks.x86_64-linux.hangul-golden -L
nix build '.#checks.x86_64-linux."files:pnpm-workspace.yaml"' -L
```

`hangul-golden` runs again because Task 1 changed when an engine gets its context; its harness accepts an engine's records on context 0 or its own, so whatever Hangul emits while it is made, it passes.

- [ ] **Step 3: Everything**

Run, each expected to PASS:

```bash
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Report which ran and what failed. Don't summarize a check you didn't run as passing.

- [ ] **Step 4: Review against the spec's phase 2**

Check off, in the branch's diff: the runtime fix and its test (spec: Startup, Testing's `libibus-web-tests` row); the overlays and their patches (Build); `ibus-web-m17n-db` (m17n-db); `m17n.wasm` and its startup (Startup); the descriptor program and its three outputs plus the table and instance list (Descriptors, Variables); `variables.c` (Variables); `m17n-golden` with every case the Testing table lists for it, `m17n-engines` and the cast audit (Testing). Distribution, npm package, `m17n-host`, demo and Playwright are phase 3's.
