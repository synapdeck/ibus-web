# M5 Phase 2: Rime under Node — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase 5b of `docs/specs/2026-10-11-m5-rime.md`: MARISA moved to shared infrastructure; `flake.overlays.rime` with Rime's dependencies, librime 1.17.0 static with its merged `lua` and `octagram` plugins, and librime's `rime_deployer` and `rime_dict_manager` as WebAssembly programs; the build-time deployment of every shipped schema into `ibus-web-rime-common` and one `ibus-web-rime-dict-<dictionary>` path per dictionary; the descriptor program and `@ibus-web/rime-descriptors`; `rime.wasm`, ibus-rime 1.6.1's engine with this project's module init, settings and switch properties; and the checks `rime-deploy`, `rime-descriptors`, `rime-golden`, `rime-userdb`, `rime-engines`, `rime-cast-audit`, `rime-imports` and `rime-data-closure`, all under Node. The distribution, per-engine installs and `rime-host` are phase 5c's; the npm package, the demo and Playwright are 5d's.

**Architecture:** `flake.overlays.rime` overrides nixpkgs' recipes for `pkgsWasm` and keeps their CMake (and Lua's make) builds: LevelDB, OpenCC, glog, Lua and librime built static, with Boost's headers alone, and MARISA the one package the table engine also links. An object derivation compiles ibus-rime's `rime_engine.c` and `rime_settings.c` with its own CMake flags. `engines/rime/_data.nix`, which takes a `schemas` argument (every shipped schema by default), as the module's recipe `_package.nix` does, merges `rime-data`, `rime-loengfan` and `rime-ice` into one source directory, runs the WebAssembly `rime_deployer --build` under Node over it, and splits the output: compiled configs, sources and OpenCC's data into the common path, Rime's shared data directory, and each dictionary's tables and prisms into a path of its own, linked from the common path's `build/`. A descriptor program, run under Node, reads every deployed config through librime's API; `descriptors.ts` checks it against the module's schema table and writes the engine descriptors, each engine's dictionary paths, the settings files and a C header of schemas, switches and spelling algebra that `rime.wasm` compiles in. `rime.wasm`'s init does what ibus-rime's `main()` does without a bus, routes glog into GLib's log, writes the YAML patches GSettings asks for and starts Rime's maintenance on its deployer thread. g_test programs drive the real module through the runtime under Node.

**Tech Stack:** C and C++17 (librime 1.17.0, ibus-rime 1.6.1, LevelDB 1.23, OpenCC 1.4.1, glog 0.7.1, yaml-cpp 0.9.0, Lua 5.2.4, MARISA 0.3.1, Boost 1.91 headers, GLib/GIO 2.88, IBus 1.5.34 headers, Emscripten), TypeScript 7 on Node 26, Vitest, CMake, Nix flake-parts, hk, oxfmt, clang-format.

## Global Constraints

- Work on branch `typedrat/m5b-rime-under-node`, cut from `master`. Phase 5a (`typedrat/m5a-pinyin-compare`) is independent; 5c branches from this branch's tip.
- Names later phases rely on are fixed (see [Interfaces](#interfaces-later-phases-rely-on)): `engines/rime/` and its layout; `flake.overlays.rime`; `pkgsWasm.librime`, `pkgsWasm.ibus-engines.rime`, `pkgsWasm.ibus-web-rime`; the option `ibusWeb.engines.rime`; the packages `ibus-web-rime`, `ibus-web-rime-common`, `ibus-web-rime-descriptors` and `ibus-web-rime-dict-<dictionary>`; the checks `rime-deploy`, `rime-descriptors`, `rime-golden`, `rime-userdb`, `rime-engines`, `rime-cast-audit`, `rime-imports`, `rime-data-closure`; and `modules/marisa/`, `ibusWeb.marisa` and `checks.marisa-tests`.
- Run every command inside the dev shell (`nix develop -c …`) from the repository root (or the worktree for the branch). `git add` a new file before any `nix` command that should see it: the flake only reads files git tracks.
- Commit with `nix develop -c git add <paths>` then `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths>`, in Conventional Commits. Stage named paths only, never `git add -A` or `git add .`. No attribution trailers. If hk's hook rewrites a file (clang-format, nixfmt, oxfmt), re-add it and commit again; never bypass the hook (`--no-verify` is forbidden).
- Comments explain why, never what; no history ("now", "previously"), no references to other files' implementations, plans or pull requests, no "NOTE:". Match the file's comment density. Separate logical blocks with one blank line; never a blank line right after an opening token or right before a closing one, nor between a comment and the code it describes. Never whitespace-minimize code. Upstream files keep upstream's formatting; our C and C++ follow `.clang-format` (LLVM).
- Licences: everything under `engines/rime/` is GPL-3.0-or-later (ibus-rime's, nixpkgs' `meta.license` of `ibus-engines.rime`), with SPDX headers in each file that can hold one; `LICENSES/GPL-3.0-or-later.txt` is added for it. librime's patches are BSD-3-Clause, OpenCC's Apache-2.0, ibus-rime's GPL-3.0-or-later; `REUSE.toml` covers the patches. `modules/marisa/` keeps the `MIT OR Apache-2.0` of the files it moves.
- Docs change in the same commit as the code they describe. Format Markdown with `nix develop -c oxfmt <file>`; **never run oxfmt on `docs/plans/`**.
- Generated files are never edited by hand, with one exception this plan states where it happens: `pnpm-workspace.yaml` gains its line before `nix run .#write-files` can run, because the write needs a workspace whose lockfile already lists the new package (Task 6). `pnpm-lock.yaml` comes from `pnpm install`.
- Stay close to nixpkgs: override the recipes, keep upstream's build systems, add only what WebAssembly needs. Every hardening flag the toolchain supports stays on.
- Runtime ABI and protocol version stay 1.
- Run checks with `nix build .#checks.x86_64-linux.<name> -L`. Report which ran and what failed; never summarize a check you didn't run as passing. Building the deployment takes about a minute and the first `rime-golden` about two; budget the first full build (LevelDB, OpenCC, glog, Lua, librime, the deployment) at 15–25 minutes.

### Decisions this plan makes where the spec is silent

- **MARISA's move.** `engines/table/_marisa.nix` moves unchanged to `modules/marisa/_marisa.nix`. `modules/marisa/overlay.nix` is `flake.overlays.marisa` (`pkgsWasm.marisa`), `modules/marisa/options.nix` declares `ibusWeb.marisa` (the build machine's MARISA, with the same patches), `modules/marisa/module.nix` sets it, and `modules/marisa/checks.nix` holds `checks.marisa-tests` (upstream's tests in the native build, asserting the WebAssembly build carries the same patches), formerly `checks.table-marisa`. The table engine reads `config.ibusWeb.marisa`. The move changes no derivation: `pkgsWasm.ibus-web-table` and the native MARISA keep their store paths (verified).
- **Patch layers.** `engines/rime/patches/<library>/{port,casts}/`, applied `port` then `casts`, each sorted by filename; a layer with no patch has no directory, and the overlay applies layers only to the recipes that have them. librime has three port patches, OpenCC one, ibus-rime three port patches and one casts patch. Each is a `git format-patch` against the pinned source, written out in full in its task.
- **LevelDB** is configured as nixpkgs' native LevelDB already is, without Google's `crc32c` library and tcmalloc, and without Snappy. nixpkgs' cross CMake compiles library checks to a static library without linking (`CMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY`), so `check_library_exists` passes for every library, and LevelDB would include `<crc32c/crc32c.h>` and fail; the overlay answers `HAVE_CRC32C`, `HAVE_SNAPPY` and `HAVE_TCMALLOC` `OFF`. `HAVE_CRC32C` selects only the hardware-accelerated library: without it LevelDB checksums every block and log record with its own table-driven CRC32C (`util/crc32c.cc`), which is all the library's portable code would do on WebAssembly, which has no CRC instruction; `rime-userdb`'s torn log record is caught by that checksum. Snappy itself doesn't build for WebAssembly (`-Werror,-Wpass-failed`); without it LevelDB stores blocks uncompressed, which Rime's user dictionaries are too small to miss. LevelDB 1.23 maps no table file on a 32-bit target (`kDefaultMmapLimit` is 0), so it reads them with `pread`.
- **OpenCC** builds against `pkgsWasm.marisa` (`USE_SYSTEM_MARISA`), so `rime.wasm` holds one MARISA; without it OpenCC's bundled copy collides. Its `data/` and `src/tools/` directories aren't built: the data's generator runs the freshly built `opencc` program, which a cross build can't. The conversion data is the build machine's OpenCC's `share/opencc`, copied into the common path, where Rime names each configuration by path. A port patch makes segmentation plugins (Jieba's, loaded with `dlopen`) optional and the overlay turns them off; `SHARE_INSTALL_PREFIX=/usr/share` keeps OpenCC's own data directory out of the store, so `rime.wasm` refers to no OpenCC output.
- **glog** is built without gflags, libunwind and its tests. Its `libglog.pc` gains `-DGLOG_USE_GLOG_EXPORT`, which glog's CMake package gives its consumers and its headers require.
- **Lua** is `pkgsWasm.lua`, the one `librime-lua` takes (5.2.4; see the departures), built with `PLAT=posix`, so `LUA_USE_POSIX` without `LUA_USE_DLOPEN`, and without readline; `LUA_ROOT` is set back to `/usr/local/`, since librime-lua sets the scripts' search path itself and the default would keep Lua's output in `rime.wasm`'s closure.
- **Boost's headers** are `ibus-web-boost-headers`: the build machine's `boost.dev` `include/` and its `Boost` and `boost_headers` CMake packages. librime outside Linux asks CMake for Boost 1.77 with no compiled component.
- **librime** is static (`BUILD_STATIC`, no shared library), with `BUILD_MERGED_PLUGINS`, nixpkgs' default plugins (`librime-lua`, `librime-octagram`), `ENABLE_THREADING`, `ENABLE_LOGGING` and `INSTALL_PRIVATE_HEADERS` (the tools and the descriptor program use `rime/*.h`), and **without `ENABLE_TIMESTAMP`**: WasmFS gives a file the modification time at which it first sees it, not the store's, so the timestamps a deployment records never match at runtime, and each deployment would recompile every config with new bytes and rebuild every prism from it (22 at the first start, measured). Without timestamps a deployment recompiles the configs to the same bytes and the prebuilt prisms stay current. librime installs no `rime.pc` outside Linux and the BSDs, so the overlay writes one, with its dependencies as `Requires.private`. librime's own CMake builds its tools only with a shared library; `ibus-web-rime-tools` compiles `rime_deployer` and `rime_dict_manager` against the static one and links them as Node programs on WasmFS with the host's files (`testMainFlags`), with a fixed 2 GB memory: deploying `rime_ice` peaks near 900 MB.
- **A static librime registers a plugin only if something refers to it.** `rime.wasm`'s init calls `rime_require_module_lua`, `rime_require_module_grammar` and `rime_require_module_octagram`, which `RIME_REGISTER_MODULE` defines for that; without them `lua_processor` is missing.
- **The schema table**, `engines/rime/_schemas.nix`, lists every schema the data can deploy (52: `rime-data`'s 41 that `rime-ice` doesn't replace, `rime-loengfan`'s one and `rime-ice`'s ten, all but `t9`), each with its gloss, languages, package, dictionary and dependencies, as the deployed configs give them, an `undeclared` list for a dependency a config doesn't name (`array30` reads `array30_query`'s dictionary) and `engine = false` for a schema that is only ever a dependency. Nix needs the dictionaries and dependencies before anything is deployed, to make one derivation per dictionary without importing from a derivation; `descriptors.ts` checks each deployed schema's dictionary and dependencies against the table and fails on a difference, so an upstream change can't slip through. The file is `_`-prefixed so import-tree skips it.
- **The shipped schemas.** `schemas` defaults to the spec's table of mainstream schemas, in its order, then every other table entry with `engine` unset, by id: 47 engines (17 + 30). An argument naming an unknown or repeated id fails evaluation. The deployed set is the shipped schemas and, transitively, their dependencies, declared or not; the generated `default.yaml`'s `schema_list` lists all of them, because `rime_deployer` compiles declared dependencies itself but not an undeclared one.
- **Two recipes.** `engines/rime/_data.nix` (`pkgsWasm.ibus-web-rime-data`, an attribute set) makes the source, the deployment, the dictionary paths, the common path and the descriptors; `engines/rime/_package.nix` (`pkgsWasm.ibus-web-rime`) builds `rime.wasm` over them. Both take `schemas`, and the module's `.override { schemas = …; }` passes it to the data's `.override`, so one argument selects everything. The data can be built and checked (Tasks 5–6) before the module exists.
- **The merged source** (`ibus-web-rime-source`) is `rime-data`'s `share/rime-data`, then `rime-loengfan`'s, then `rime-ice`'s, without rime-ice's empty `build/` and `AGENTS.md`, plus ibus-rime's `ibus_rime.yaml`, with `default.yaml` rewritten from `rime-data`'s by replacing its `schema_list`.
- **The common path** is the merged source without dictionary sources (`*.dict.yaml`, `cn_dicts/`, `en_dicts/`, `essay*.txt`), OpenCC's data added under `opencc/` beside the schemas' own (theirs win), and `build/` with the deployment's compiled YAML and one absolute symbolic link per compiled table or prism into its dictionary's path. A dictionary path holds `build/<dictionary>.table.bin`, `build/<dictionary>.reverse.bin` and `build/<schema>.prism.bin` of each deployed schema whose dictionary it is. The common path's build fails if any compiled `.bin` has no dictionary.
- **The descriptor step's outputs** (`ibus-web-rime-descriptors`): `engines.json` (descriptors without `data`, which the protocol accepts only from 5c), `engine-data.json` (engine name to its dictionaries' store paths, own first, then its dependencies', each once), `settings-paths.json`, `settings-schemas.json`, `instances.txt`, `rime-tables.h` and the program's own output as `raw.json`. The descriptor program prints every schema the deployment compiled, from the `*.schema.yaml` in its `build/`; the step uses the shipped ones and their closure.
- **`rime-tables.h`**, which `rime.wasm` compiles in, holds three X-macros: `IBUSWEB_RIME_SCHEMAS(X)` (the shipped schema ids, the engines module init registers), `IBUSWEB_RIME_SWITCHES(X)` (schema, switch, index among the schema's switches, option index or -1) for the `full_shape`, `ascii_punct`, `simplification` and `traditionalization` switches the settings set, and `IBUSWEB_RIME_ALGEBRA(X)` (schema, rule): rime-ice's Pinyin schemas' spelling algebra, which fuzzy Pinyin's rules go before. It holds no store path, so the step's output doesn't enter the module's closure.
- **Module init** (`module/module.cc`) fills `RimeTraits` (shared data the common path, compiled in; user data `g_get_home_dir()`; `log_dir` empty; distribution `Rime`, `ibus-rime`, ibus-rime's version; app `rime.ibus`), writes the settings' YAML, sets the notification handler, calls `setup`, routes glog to GLib, sets the switcher filter, starts Rime as ibus-rime's `ibus_rime_start(FALSE)` does (initialize, `start_maintenance`, `deploy_config_file("ibus_rime.yaml")`), loads ibus-rime's settings and registers `rime:<id>` for each shipped schema. It defines `rime_api`, `ibus_rime_start` and `ibus_rime_stop`, which `rime_main.c` defines upstream and ibus-rime's "Deploy" property calls.
- **Logging.** A glog `LogSink` sends each message to `g_log("Rime", …)`: INFO as `G_LOG_LEVEL_INFO`, WARNING as `G_LOG_LEVEL_WARNING`, ERROR and FATAL as `G_LOG_LEVEL_CRITICAL`. After `setup`, which sends everything to stderr when `log_dir` is empty, the module sets `FLAGS_logtostderr` false and `FLAGS_stderrthreshold` past every severity, so nothing goes to stderr and glog writes no file.
- **Readiness.** The notification handler logs `Rime is under maintenance ...` when a deployment starts, and `Rime is ready.` (or the warning `Rime has encountered an error.`) when it ends, from the pumping thread, where it also reloads ibus-rime's settings. `ibus_rime_start` logs `Rime is ready.` itself when no deployment starts, so a page or a test always learns when Rime can be used.
- **Sessions after a deployment.** A Rime session keeps the configs it was made with, and `GetSession` refuses sessions only while maintenance runs. When a deployment ends, the module calls `cleanup_all_sessions`, so each engine finds its session gone at its next key and makes a new one with the deployed configs.
- **The switcher filter** rejects every schema. With it, the switcher's menu lists only the session's schema, which it lists first whatever the filter says, `SelectNextSchema` has nothing to go to, and a new session starts with Rime's default configuration and no schema, so making an engine loads its own schema's dictionaries and no other's (without it, each session would first load the schema last selected in this Worker).
- **Selecting the schema.** ibus-rime's port patch 0002 makes the first session in `constructed`, once the construct property `engine-name` is set, and `select_schema`s `<id>` whenever it makes a session for an engine named `rime:<id>`; an engine named `rime` keeps upstream's behaviour.
- **Switch properties.** ibus-rime's port patch 0003 appends a property per switch after ibus-rime's three, built from the session's schema whenever a session is made: a switch with a `name` a `PROP_TYPE_TOGGLE` keyed `rime:option:<name>`, labelled with its current state's label; one with `options` a `PROP_TYPE_MENU` keyed `rime:options:<index>`, labelled with the current option's state label, holding a `PROP_TYPE_RADIO` per option keyed `rime:option:<option>`. An `option` notification (`"<name>"` or `"!<name>"`) updates the property's state and label and, for a radio, its menu's label. Activating a toggle sets its option to the requested state; activating a radio checked turns the group's other options off first.
- **libnotify** becomes a CMake option of ibus-rime, `ENABLE_LIBNOTIFY` (on by default), so that configuring with it off neither requires nor includes libnotify; `rime_main.c` then logs its messages with `g_message`.
- **Settings write only what the page stored.** Each key's YAML entry is written only when `g_settings_get_user_value` returns a value, so a key at its default leaves Rime's own configuration, and a fresh start writes no file and deploys nothing beyond the first start's. The defaults in the schema are Rime's (or rime-ice's, or ibus-rime's) own. A patch file is removed when it would be empty, and written only when its content differs.
- **Settings keys.** Fixed: `page-size` (`i`, 1–10, 5) → `menu/page_size`; `switcher-hotkeys` (`as`) → `switcher/hotkeys`; `ascii-toggle-key` (`shift`, `caps-lock`, `control`, `none`) → `ascii_composer/switch_key`, `shift` being the default configuration's own map; `inline-preedit` (`b`, true), `preedit-style` (`composition`, `preview`; `preview`), `cursor-type` (`insert`, `select`; `select`) → `ibus_rime.custom.yaml`'s `style/…`; `traditional` (`b`) → the reset of each rime-ice schema's `traditionalization`; `fuzzy-pinyin` (`as` with choices) → the rules rime-ice's speller carries commented out, by name (`zh-z`, `z-zh`, `l-n` … `huang-wang`, 35 of them), placed before each rime-ice Pinyin schema's own algebra as a whole `speller/algebra` list. Relocatable `org.freedesktop.ibus.engine.rime.schema` at `/org/freedesktop/ibus/engine/rime/<id>/`: `full-shape`, `ascii-punct`, `simplification` (`b`, false) → `switches/@<index>/reset`; for a switch of several options, true selects the option's index and false leaves the schema's own reset.
- **A settings change** rewrites the patches and, if one changed, starts maintenance with a full check, then deploys `ibus_rime.yaml` as `ibus_rime_start` does. A full check because a patch written in the same second the last deployment ended looks no newer than it, and a check for modifications would skip it. A change that arrives while maintenance runs is written at once and deployed when that maintenance ends.
- **Lazy dictionaries.** librime's port patch 0003 lets a deployment pass over a dictionary whose prebuilt table is a symbolic link to a file not there yet, logging at INFO, instead of failing; sessions read the prebuilt table once its path is installed. `rime-deploy` starts with only the common path and the compiled schemas installed.
- **The golden harness** (`checks/golden/harness.c`) is m17n's, with: a home directory argument; the store mounted whole or only the paths given, with `golden_mount` for later ones and `golden_mount_host` for the program's working directory; `golden_wait_log`, which pumps and runs proxied calls through `ibusweb_wait` until a Log record carries a message; `golden_wait_file`; `golden_chord`; capitals typed with Shift; GLib's always-fatal mask cut back to criticals and errors after `g_test_init`, so a warning reaches the records rather than aborting where it is logged; and warnings tolerated, as test messages, between `Rime is under maintenance ...` (or the start) and `Rime is ready.`. A warning outside a deployment, and any critical, still fails the case. Init declares every settings instance with no stored value.
- **`rime-userdb`**'s learning and remembering steps keep the user directory in the program's working directory, which the test-program shim keeps for a numbered sequence; its compaction case keeps it in memory. LevelDB's compaction thread reaches the host's files through the pumping thread, which can't serve it while closing a database waits for that thread, a deadlock the IndexedDB backend, with a thread of its own, doesn't have.
- **The cast audit** covers librime, librime-lua (C++ and C), librime-octagram, LevelDB, yaml-cpp, OpenCC, glog, MARISA, Lua, ibus-rime and the module, each against its own allow-list in `engines/rime/cast-audit/`. A CMake library is audited with the flags its own configure gives the target that builds it (from the target's `flags.make`) over the sources `compile_commands.json` lists for that target. `ibusWeb.engines.castAudit` gains `sourcesFrom`, a shell command printing the sources, for libraries too large to name file by file. All twelve allow-lists are empty.

### Where this plan departs from the spec

These are contradictions or gaps found while building; each is resolved as stated and listed here rather than resolved silently. Phase 5d, which updates the spec, should fold them in.

1. **Lua is 5.2.4, not 5.4.** nixpkgs' `librime-lua` takes the default `lua`, 5.2.4, in `pkgsWasm` too, and staying close to nixpkgs keeps it. `rime-ice`'s scripts need nothing of 5.3 or 5.4 but the `utf8` library, which librime-lua supplies on 5.2 (`src/lib/lutf8lib-compat.c`); `rime-golden`'s `lua` case runs its Unicode translator, and every rime-ice engine loads its Lua components in `rime-engines` without a warning. The overridden attribute is `lua`.
2. **Logging doesn't reach the page through stderr.** The runtime turns GLib's log into `Log` records; a program's stderr goes to the console and nowhere else. Rime's `log_dir` stays empty, as the spec says, and the module routes glog into GLib (Decisions), so Rime's messages reach the page as `Log` records and its warnings fail `rime-golden`.
3. **The spec's port patches are not all.** librime needs three port patches, not the one the spec expects: the switcher filter, a missing dictionary source logged as information rather than an error (every deployment over prebuilt-only data logged one error per dictionary), and a prebuilt table that isn't installed yet passed over rather than failing the deployment (5c's lazy dictionaries). OpenCC needs one, to build without its `dlopen` plugin loader. ibus-rime needs a casts patch beyond its three port patches. The cast audit itself finds nothing anywhere else.
4. **Rime doesn't end sessions to deploy.** The spec says "Rime ends its sessions to deploy, and ibus-rime makes a new one when it finds its own gone". librime refuses sessions only while maintenance runs and keeps them afterwards with their old configs; an engine that sees no key during maintenance keeps its session. The module ends every session when a deployment ends (`cleanup_all_sessions`), which gives the behaviour the spec describes: `rime-golden`'s `page-size` case checks it on an open context.
5. **Not every schema is an engine.** "Every schema of `rime-data` and `rime-ice`" can't hold for four of them. `rime-ice`'s `t9` needs a `t9_processor` that librime doesn't have (its mobile front ends supply it): making the engine logs a critical. `rime-data`'s `array30_query` and `array30_wsymbols` are helper schemas without a punctuator, which Rime warns of whenever a session opens them; they are `array30`'s dependencies (one declared, one not), deployed as such. `rime-ice`'s `melt_eng` and `radical_pinyin` and `rime-loengfan`'s `loengfan` are dependencies, as the spec has them. 47 engines remain.
6. **`stenotype` isn't a chord scheme.** `rime-data`'s `stenotype` (`打字速記法`) is a shorthand typed key by key, with no `chord_composer`. `rime-golden` presses a `combo_pinyin` chord (E, R and I together, released together: `你`) and types a stenotype abbreviation (`N`: `你`).
7. **Timestamps.** librime is built without `ENABLE_TIMESTAMP` (Decisions); the spec doesn't name the option. With it, every first start rebuilt every prism.
8. **The table carries more than glosses.** The spec's "gloss and language table … in the module's Nix" also gives each schema's dictionary and dependencies, which Nix needs for the per-dictionary derivations, and the build checks them against the deployed configs.
9. **`switcher-hotkeys` defaults to Rime's own keys**, `['Control+grave', 'Control+Shift+grave', 'F4']`, not `["F4", "Control+grave"]`: the module writes only what the page stores, so a default that differs from the data's would be a setting nobody chose.
10. **A settings change starts maintenance with a full check**, not the check for modifications the spec's startup uses: the check compares whole seconds and misses a patch written in the same second the last deployment ended.
11. **No yaml-cpp override.** nixpkgs' recipe already builds it without tools, and without tests when it can't run them.
12. **`docs/rime.md` is written here**, though the spec lists it under phase 4 (5d): the repository's rule is that docs change with the code they describe, as M4's phase 2 did with `docs/m17n.md`. 5c and 5d add the distribution, per-engine data and the browser to it.
13. **Symbolic links longer than an archive holds.** The common path's links into the dictionary paths are absolute, and the longest is 114 bytes (`…-ibus-web-rime-dict-array30_wsymbols/build/array30_wsymbols.reverse.bin`); the distribution's ustar archives hold 100 ([known-gaps.md](../known-gaps.md#engines-and-page-integration)), so 5c's distribution build fails until the archive and installer carry longer targets. No relative target fits either (103 bytes at most), and the store names are fixed. 5b builds no archive; `rime-data-closure` records the longest target.
14. **The descriptors' `data`** is a file of its own, `engine-data.json`, since `EngineDescriptor` takes `data` only from 5c and `decodeModuleManifest` refuses unknown keys; 5c merges it.

### What was verified, and how

- **Built and run, in a scratch clone of `master` at `8b1e100`** (the spec as of this plan), with `nix build` and Node 26 from the dev shell: every file this plan creates or changes, as written here, after hk's formatters (clang-format, nixfmt, oxfmt) and with `hk check --from-ref master` passing. All of `marisa-tests`, `table-golden`, `rime-deploy` (3 tests), `rime-descriptors` (15), `rime-golden` (18), `rime-userdb` (6), `rime-engines` (48: every one of the 47 engines, and the run), `rime-cast-audit` (twelve audits, every allow-list empty: librime 105 sources, librime-lua 8 C++ and 2 C, librime-octagram 4, LevelDB 38, yaml-cpp 32, OpenCC 25, glog 9, MARISA 9, Lua's library, ibus-rime 2, the module 2), `rime-imports` (509 imported symbols, none missing, no loader import) and `rime-data-closure` passed. The MARISA move left `pkgsWasm.ibus-web-table` and the native MARISA at the same derivation paths. `rime-userdb` passed four forced reruns in a row; before `ibus_rime_start` logged readiness when nothing deploys, its second step hung in four of six runs. Without librime's port patch 0003, `rime-deploy` fails as Task 9's first step says (run in a second clone); without ibus-rime's casts patch, the audit reports the two findings Task 4's says. The tasks' snippets were checked to compose, insertion by insertion, into the spike's `overlay.nix`, `cast-audit.nix` and `_data.nix`.
- **The spec's open risk, a redeploy over prebuilt-only shared data, holds.** Natively first (nixpkgs' `librime` and `rime_deployer`), then in WebAssembly under Node: with the shared directory holding the compiled configs and tables but no `*.dict.yaml`, a deployment with a `luna_pinyin.custom.yaml` speller patch and a `default.custom.yaml` page size logs `reuse existing table` for each dictionary, writes no `.table.bin` or `.reverse.bin` to the user's `build/`, and rebuilds only the prisms of schemas whose compiled config changed. `rime-deploy` checks it, with the dictionaries installed after the first start, as 5c installs them.
- **Threads and file systems under Node.** The deployer's `std::async` thread runs every startup and settings deployment (`rime-golden` deploys 16 times); LevelDB's compaction thread compacts four level-0 tables (`Compacted 4@0 + 0@1 files` in the database's `LOG`, `rime-userdb-compaction`); LevelDB's `LOCK` file is created and survives the program that held it, and the next program opens the database anyway: WasmFS answers `F_SETLK` with success, the lock being per process, and LevelDB's own table of locked files guards a database within one. Renames (`CURRENT`, through a temporary file) and `fsync` work on WasmFS's memory backend and its Node backend. A record torn off the end of the log is dropped when the database opens, and the entry before it survives (`rime-userdb.2`). The deployer and LevelDB's thread reach the Node backend through the pumping thread, which `ibusweb_wait` serves.
- **Measured** (released Node, under `nix build`): the WebAssembly `rime_deployer` deploys the mainstream schemas in 20 s, peaking at 880 MB RSS, against 18 s and 954 MB natively; the full set builds in about a minute. `rime.wasm` is 3,929,557 bytes. The closure is 297.7 MB: the common path 4.0 MB, the 22 dictionary paths the rest (`rime_ice` 60.9 MB, `jyut6ping3` 27.6 MB, `loengfan` 25.3 MB, `luna_pinyin` 9.3 MB). A first start under Node, with the store mounted from the host, deploys in about a second, recompiling the configs only; a settings change that touches `default.custom.yaml` redeploys every schema in about 3 s (`rime-golden`, 16 deployments, runs in 50 s). Compiled tables from the WebAssembly deployer differ from the native one's in `cangjie5.table.bin` and three reverse lookups (the native deployer is itself deterministic); the module reads only what the WebAssembly deployer wrote.
- **By reading the sources:** librime 1.17.0 (`setup.cc`, `deployer.cc`, `service.cc`, `switcher.cc`, `engine.cc`, `lever/deployment_tasks.cc`, `dict/dict_compiler.cc`, `dict/level_db.cc`, `rime_api_impl.h`, `CMakeLists.txt`, `src/CMakeLists.txt`, `plugins/CMakeLists.txt`, `tools/`), librime-lua and librime-octagram's CMake, ibus-rime 1.6.1 (all of it), OpenCC 1.4.1's CMake, `Config.cpp` and `PluginSegmentation.cpp`, LevelDB 1.23's CMake and `port/port_stdcxx.h`, glog 0.7.1's headers, Lua 5.2.4's Makefile and `luaconf.h`, Emscripten's WasmFS `syscalls.cpp` (`F_SETLK`) and Node backend, nixpkgs' recipes for every package overridden, `rime-data`'s and `rime-ice`'s schemas, and the two reference ports' patch lists (`LibreService/my_rime`, `fcitx5-prebuilder`), whose patches this plan doesn't use.
- **Not verified here, for later phases:** anything in a browser or on the IndexedDB backend (5c and 5d); the distribution and its archives (5c; see departure 13); the thread pool's view of Rime's threads in a Worker host, where a thread beyond the pool fails at once (5c's `rime-host` measures the engine share the manifest declares: the deployer's thread during maintenance and LevelDB's, which lasts as long as the module once it starts); peak memory with lazy dictionaries.

## Interfaces later phases rely on

- **Directory** `engines/rime/`: `overlay.nix` (`flake.overlays.rime`, which applies only to `pkgsWasm`), `options.nix` (`ibusWeb.engines.rime`), `module.nix`, `_package.nix`, `_data.nix`, `_schemas.nix`, `cast-audit.nix` and `cast-audit/*.jsonc`, `org.freedesktop.ibus.engine.rime.gschema.xml`, `module/` (`module.cc`, `settings.c`, `settings.h`), `descriptors/` (`descriptors.cc`, `descriptors.ts` and the package `@ibus-web/rime-descriptors`), `patches/{librime,opencc,ibus-rime}/…` and `patches/README.md`, `checks/{golden,deploy,userdb,engines}/`. No `engines/rime/checks.nix` and no `dist.nix`: 5c creates `dist.nix` and `checks/host/`.
- **pkgsWasm:** `leveldb`, `opencc`, `glog`, `lua`, `librime` (static; `include/rime_api.h`, `include/rime/*.h`, `lib/librime.a`, `lib/pkgconfig/rime.pc`), `librime-lua` and `librime-octagram` (nixpkgs', taking the overridden `lua`), `ibus-web-boost-headers`, `ibus-web-rime-tools` (`rime_deployer.{js,wasm}`, `rime_dict_manager.{js,wasm}`), `ibus-web-rime-descriptor-program` (`descriptors.{js,wasm}`), `rime-loengfan` (`share/rime-data/loengfan.{schema,dict}.yaml`, `share/doc/rime-loengfan/LICENSE`; `src` at `987ac95b02f957e8764a2f45222a4006c188ed50`, `meta.license` CC-BY-4.0), `ibus-web-rime-data` (`_data.nix`, `callPackage`d: an attribute set of `schemas`, `source`, `deployment`, `dicts`, `common`, `descriptors`, with `.override { schemas = …; }`), `ibus-engines.rime` (ibus-rime's objects: `lib/ibus-rime/{rime_engine.o,rime_settings.o,cflags}`, `include/ibus-rime/*.h`, `share/rime-data/ibus_rime.yaml`), `ibus-web-rime`; and `marisa`, from `flake.overlays.marisa`.
- **`pkgsWasm.ibus-web-rime`**, `callPackage`d from `_package.nix`, so it has `.override`. Its argument `schemas` (default `null`: every engine of the table, the mainstream 17 first) selects the shipped schemas, e.g. `ibus-web-rime.override { schemas = [ "rime_ice" "luna_pinyin" "jyut6ping3" ]; }`. `$out/rime.wasm`; `meta` ibus-rime's (GPL-3.0-or-later); passthru:
  - `schemas`: the shipped schema ids, in engine order;
  - `common`: `ibus-web-rime-common`, Rime's shared data directory, the module's base data;
  - `dicts`: an attribute set, dictionary name → `ibus-web-rime-dict-<name>` (22 in the default build);
  - `descriptors`: `ibus-web-rime-descriptors`;
  - `settingsSchemas` (the compiled schema derivation) and `settingsSchemaDir` (its `share/glib-2.0/schemas`, a base-data path of its own);
  - `source` (the merged data) and `deployment` (the deployer's output);
  - `auditCflags` and `auditCxxflags`.
  `nicheSchemas` and `extraSchemas` don't exist: the spec replaced them with `schemas`.
- **Packages:** `packages.ibus-web-rime`, `packages.ibus-web-rime-common`, `packages.ibus-web-rime-descriptors` and `packages.ibus-web-rime-dict-<name>` for each dictionary.
- **`ibus-web-rime-descriptors`:** `engines.json` (47 descriptors, `rime:rime_ice` first, `{ name, displayName, languages, keyboard: { layout: "us", passThrough: [] } }`, no `data`), `engine-data.json` (`{ "rime:<id>": [ store paths ] }`, every engine with at least one path, never the common path), `settings-paths.json` (`{ "org.freedesktop.ibus.engine.rime.schema": [ "/org/freedesktop/ibus/engine/rime/<id>/", … ] }`), `settings-schemas.json` (`["org.freedesktop.ibus.engine.rime", "org.freedesktop.ibus.engine.rime.schema", "org.freedesktop.ibus.panel"]`), `instances.txt`, `rime-tables.h`, `raw.json`.
- **Option** `ibusWeb.engines.rime`: `package`, `descriptors` (path of `engines.json`), `engineData` (path of `engine-data.json`), `settingsPaths`, `settingsSchemaDir` (string), `settingsSchemas` (path of `settings-schemas.json`).
- **GSettings:** `org.freedesktop.ibus.engine.rime` at `/org/freedesktop/ibus/engine/rime/` (`page-size`, `switcher-hotkeys`, `ascii-toggle-key`, `inline-preedit`, `preedit-style`, `cursor-type`, `traditional`, `fuzzy-pinyin`); relocatable `org.freedesktop.ibus.engine.rime.schema` at `/org/freedesktop/ibus/engine/rime/<id>/` (`full-shape`, `ascii-punct`, `simplification`).
- **Properties:** ibus-rime's `InputMode`, `deploy`, `sync`; then per switch `rime:option:<name>` (`PROP_TYPE_TOGGLE`, label the current state's), or `rime:options:<index>` (`PROP_TYPE_MENU`) holding `rime:option:<option>` (`PROP_TYPE_RADIO`). `PropertyActivate` with `PROP_STATE_CHECKED`/`UNCHECKED` sets them.
- **Log messages a page can watch:** `Rime is under maintenance ...` and `Rime is ready.` (message level, domain empty), `Rime has encountered an error.` (warning); Rime's own under the domain `Rime`.
- **Threads:** the deployer's (`std::async`), alive during each maintenance, created by the pumping thread; LevelDB's compaction thread, detached, alive from a database's first scheduled compaction until the Worker ends, created by whichever thread wrote the database. 5c's `rime-host` measures them for the manifest's `threads`.
- **For 5c's installs:** the module starts with only `ibus-web-rime-common` and the compiled schemas installed and logs no warning (`rime-deploy`); an engine works once its `engine-data.json` paths are installed, without another deployment. A settings change made while a dictionary isn't installed leaves that dictionary's prisms as prebuilt, so a `fuzzy-pinyin` change reaches an engine installed later only at the next deployment (known gap). The common path's link targets reach 114 bytes (departure 13).
- **Checks:** `marisa-tests`, `rime-deploy`, `rime-descriptors`, `rime-golden`, `rime-userdb`, `rime-engines`, `rime-cast-audit`, `rime-imports`, `rime-data-closure`.
- **Docs:** `docs/rime.md` with `## Build`, `## Deployment`, `## Startup`, `## Engines`, `## Settings`, `## Switches as properties` and `## Checks`; `docs/engines.md` `## MARISA` and `## Rime`; `docs/README.md`'s `rime.md` row.

---

## File structure

| Path | Change |
| --- | --- |
| `modules/marisa/_marisa.nix` (moved from `engines/table/`), `overlay.nix`, `options.nix`, `module.nix`, `checks.nix` (moved from `engines/table/`) | MARISA as shared infrastructure; `checks.marisa-tests` |
| `engines/table/overlay.nix`, `engines/table/module.nix` | Read `pkgsWasm.marisa` and `ibusWeb.marisa` |
| `modules/engines/cast-audit.nix`, `modules/engines/options.nix` | `castAudit` takes `sourcesFrom` |
| `engines/rime/overlay.nix` | `flake.overlays.rime` |
| `engines/rime/patches/opencc/port/0001-Make-segmentation-plugins-optional.patch` | OpenCC without `dlopen` |
| `engines/rime/patches/librime/port/0001-…`, `0002-…`, `0003-…` | librime's port patches |
| `engines/rime/patches/ibus-rime/port/0001-…`, `0002-…`, `0003-…`, `casts/0001-…` | ibus-rime's patches |
| `engines/rime/patches/README.md` | The patch inventory |
| `engines/rime/_schemas.nix`, `engines/rime/_data.nix`, `engines/rime/_package.nix` | The schema table, the data's deployment and the module's recipe |
| `engines/rime/options.nix`, `engines/rime/module.nix` | `ibusWeb.engines.rime`, packages, `rime-imports`, `rime-data-closure` |
| `engines/rime/descriptors/descriptors.cc` | The descriptor program |
| `engines/rime/descriptors/descriptors.ts`, `descriptors.test.ts`, `outputs.test.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `checks.nix` | The TypeScript step and `rime-descriptors` |
| `engines/rime/org.freedesktop.ibus.engine.rime.gschema.xml` | Rime's settings |
| `engines/rime/module/module.cc`, `settings.c`, `settings.h` | The side module's init and settings |
| `engines/rime/cast-audit.nix`, `engines/rime/cast-audit/*.jsonc` | `rime-cast-audit` |
| `engines/rime/checks/golden/checks.nix`, `harness.h`, `harness.c`, `golden.c` | `rime-golden` |
| `engines/rime/checks/deploy/checks.nix`, `deploy.c` | `rime-deploy` |
| `engines/rime/checks/userdb/checks.nix`, `userdb.c` | `rime-userdb` |
| `engines/rime/checks/engines/checks.nix`, `engines.c` | `rime-engines` |
| `modules/typescript/files.nix`, `pnpm-workspace.yaml` (generated), `pnpm-lock.yaml` | The new workspace package |
| `LICENSES/GPL-3.0-or-later.txt`, `REUSE.toml` | Rime's licences |
| `docs/rime.md` (new), `docs/README.md`, `docs/engines.md`, `docs/table.md`, `docs/known-gaps.md` | The pages each change affects |

---

## Milestone A: the libraries

Tasks 1–3 make Rime's libraries and tools for `pkgsWasm`. At the end of Task 3 the WebAssembly `rime_deployer` runs under Node, and every library's cast audit passes.

### Task 1: MARISA as shared infrastructure

MARISA's recipe and overlay move from the table engine to `modules/marisa/`, with its upstream-test check, so that librime builds against the one `pkgsWasm.marisa` the table engine links. The native build the table tools link reaches the same recipe through `ibusWeb.marisa`. Nothing is rebuilt.

**Files:**
- Move: `engines/table/_marisa.nix` → `modules/marisa/_marisa.nix` (unchanged); `engines/table/checks.nix` → `modules/marisa/checks.nix`
- Create: `modules/marisa/overlay.nix`, `modules/marisa/options.nix`, `modules/marisa/module.nix`
- Modify: `engines/table/overlay.nix`, `engines/table/module.nix`
- Docs: `docs/engines.md`, `docs/table.md`

**Interfaces:**
- Produces: `flake.overlays.marisa` (`pkgsWasm.marisa`); the perSystem option `ibusWeb.marisa` (a package: the build machine's MARISA with the same patches); `checks.marisa-tests` (formerly `checks.table-marisa`).

- [ ] **Step 1: Record what must not change**

Run:

```bash
nix eval --raw .#packages.x86_64-linux.ibus-web-table.drvPath; echo
nix eval --raw .#checks.x86_64-linux.table-marisa.drvPath; echo
```

Expected: two `.drv` paths (in the spike, `…-ibus-web-table-static-wasm32-unknown-none-0.1.0.drv` and `…-marisa-0.3.1.drv`). Keep them for Step 4.

- [ ] **Step 2: Write the failing check**

Run: `nix eval --raw .#checks.x86_64-linux.marisa-tests.drvPath`
Expected: FAIL: `does not provide attribute … 'checks.x86_64-linux.marisa-tests'`.

- [ ] **Step 3: Move the recipe and its check**

```bash
mkdir -p modules/marisa
nix develop -c git mv engines/table/_marisa.nix modules/marisa/_marisa.nix
nix develop -c git mv engines/table/checks.nix modules/marisa/checks.nix
```

Replace `modules/marisa/checks.nix` with:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) marisa;
      wasm = config.ibusWeb.toolchain.pkgsWasm.marisa;
    in
    {
      # Upstream's tests run in the native build's check phase. They can't run
      # in the WebAssembly build, which must carry the same patches.
      checks.marisa-tests =
        assert map toString wasm.patches == map toString marisa.patches;
        marisa;
    };
}
```

Create `modules/marisa/overlay.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ config, lib, ... }:
let
  inherit (config.ibusWeb.lib) isEmscriptenWasm;
in
{
  # One MARISA for every side module that links it; each links its own
  # static copy.
  flake.overlays.marisa =
    final: prev:
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) {
      marisa = final.callPackage ./_marisa.nix { inherit (prev) marisa; };
    };
}
```

Create `modules/marisa/options.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.marisa = lib.mkOption {
      type = lib.types.package;
      description = "MARISA for the build machine, with the patches pkgsWasm.marisa carries, for native tools that read or write the tries a side module does.";
    };
  };
}
```

Create `modules/marisa/module.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { pkgs, ... }:
    {
      ibusWeb.marisa = pkgs.callPackage ./_marisa.nix { };
    };
}
```

In `engines/table/overlay.nix`, delete these two lines (the line and the blank line after it):

```nix
          marisa = final.callPackage ./_marisa.nix { inherit (prev) marisa; };

```

In `engines/table/module.nix`, replace

```nix
      inherit (config.ibusWeb) testing toolchain;

      marisa = pkgs.callPackage ./_marisa.nix { };
```

with

```nix
      inherit (config.ibusWeb) marisa testing toolchain;
```

- [ ] **Step 4: Run the check, and see nothing else change**

Run:

```bash
nix develop -c git add modules/marisa engines/table
nix build .#checks.x86_64-linux.marisa-tests -L
nix eval --raw .#packages.x86_64-linux.ibus-web-table.drvPath; echo
nix eval --raw .#checks.x86_64-linux.marisa-tests.drvPath; echo
nix build .#checks.x86_64-linux.table-golden .#checks.x86_64-linux.table-host -L
```

Expected: PASS; the two `.drv` paths are exactly Step 1's (the move rebuilds nothing); `table-golden` and `table-host` PASS from the cache.

- [ ] **Step 5: Update the docs**

In `docs/table.md`, replace the whole `## MARISA` section (its heading and its one paragraph) with:

```markdown
## MARISA

The engine links MARISA 0.3.1, the one package every module that uses it shares
([engines.md](engines.md#marisa)); the native build the tools link is the same recipe.
```

and delete the `table-marisa` row from its checks table.

In `docs/engines.md`, insert above `## The table module`:

```markdown
## MARISA

`modules/marisa/_marisa.nix` overrides nixpkgs' MARISA 0.3.1 for two builds: `pkgsWasm.marisa`, through
`flake.overlays.marisa`, which the table engine and librime link, and the build machine's, `ibusWeb.marisa`, which
native tools such as the table engine's link. It adds upstream [PR #146](https://github.com/s-yata/marisa-trie/pull/146)
(commit `e31c7ed`) with `fetchpatch`: 0.3.1 reads uninitialized units while packing a `FlatVector`. It turns off tuning
for the build machine (`ENABLE_NATIVE_CODE`) and the command-line tools, which no module uses, and records the
BSD-2-Clause option of MARISA's dual licence. Upstream's tests run in the check phase wherever the build can run them,
which is the native build: that build is the `marisa-tests` check, which also asserts that the WebAssembly build carries
the same patches. Each side module still links its own static copy.
```

Run: `nix develop -c oxfmt docs/engines.md docs/table.md`

- [ ] **Step 6: Commit**

```bash
nix develop -c git add modules/marisa engines/table docs/engines.md docs/table.md
nix develop -c git commit -m "refactor(marisa): make MARISA shared infrastructure" -- modules/marisa engines/table docs/engines.md docs/table.md
```

---

### Task 2: Rime's libraries for WebAssembly

LevelDB, OpenCC, glog, Lua and Boost's headers, from nixpkgs' recipes, each audited for function-pointer casts.

**Files:**
- Create: `engines/rime/overlay.nix`, `engines/rime/patches/opencc/port/0001-Make-segmentation-plugins-optional.patch`, `engines/rime/patches/README.md`, `engines/rime/cast-audit.nix`, `engines/rime/cast-audit/{leveldb,yaml-cpp,opencc,glog,marisa,lua}.jsonc`, `LICENSES/GPL-3.0-or-later.txt`
- Modify: `modules/engines/cast-audit.nix`, `modules/engines/options.nix`, `REUSE.toml`
- Docs: `docs/rime.md` (new), `docs/README.md`, `docs/engines.md`

**Interfaces:**
- Produces: `pkgsWasm.leveldb`, `pkgsWasm.opencc`, `pkgsWasm.glog`, `pkgsWasm.lua`, `pkgsWasm.ibus-web-boost-headers`; `ibusWeb.engines.castAudit`'s `sourcesFrom ? null` (a shell command printing the sources to audit, in place of `sources`); `checks.rime-cast-audit` (the libraries' audits; Tasks 3, 6 and 7 add librime's, ibus-rime's and the module's).

- [ ] **Step 1: Write the failing check**

Run: `nix build .#checks.x86_64-linux.rime-cast-audit`
Expected: FAIL: `does not provide attribute … 'checks.x86_64-linux.rime-cast-audit'`.

- [ ] **Step 2: Let the cast audit take a listing**

In `modules/engines/cast-audit.nix`, replace

```nix
          name,
          src,
          sources,
          cflags ? "",
```

with

```nix
          name,
          src,
          sources ? [ ],
          sourcesFrom ? null,
          cflags ? "",
```

and

```nix
            for source in ${lib.escapeShellArgs sources}; do
```

with

```nix
            for source in ${
              if sourcesFrom == null then lib.escapeShellArgs sources else "$(${sourcesFrom})"
            }; do
```

In `modules/engines/options.nix`, replace the description

```nix
        Audit strict function-pointer casts: { name, src, sources, cflags ? "",
        buildInputs ? [ ], pkgConfigModules ? [ ], allowList }. Produces report.json
        and report.txt and fails unless the findings equal the JSONC allow-list.
```

with

```nix
        Audit strict function-pointer casts: { name, src, sources ? [ ], sourcesFrom ? null,
        cflags ? "", buildInputs ? [ ], pkgConfigModules ? [ ], allowList }. sourcesFrom,
        when given, is a shell command printing the sources to audit in place of sources.
        Produces report.json and report.txt and fails unless the findings equal the JSONC
        allow-list.
```

- [ ] **Step 3: Make OpenCC's port patch**

Create `engines/rime/patches/opencc/port/0001-Make-segmentation-plugins-optional.patch`, a `git format-patch` against OpenCC 1.4.1 (`pkgsWasm.opencc.src`):

```diff
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Alexis Williams <alexis@typedr.at>
Date: Sun, 11 Oct 2026 13:06:07 -0700
Subject: [PATCH] Make segmentation plugins optional

OpenCC loads a segmentation plugin, such as Jieba's, with dlopen
whenever a configuration names a segmentation type it doesn't have
built in. A build for a platform without dynamic loading, or that
wants none, can turn this off with -DENABLE_SEGMENTATION_PLUGINS=OFF:
PluginSegmentation.cpp isn't built, libopencc needs no libdl and
records no plugin directory, and such a configuration fails to load
as one naming an unknown type does.
---
 CMakeLists.txt     | 13 ++++++++++---
 src/CMakeLists.txt |  7 +++++--
 src/Config.cpp     |  4 ++++
 3 files changed, 19 insertions(+), 5 deletions(-)

diff --git a/CMakeLists.txt b/CMakeLists.txt
index 7a7aa06..5240330 100644
--- a/CMakeLists.txt
+++ b/CMakeLists.txt
@@ -59,6 +59,10 @@ else()
   set(OPENCC_JIEBA_PLUGIN_DEFAULT OFF)
 endif()
 option(BUILD_OPENCC_JIEBA_PLUGIN "Build Jieba segmentation as a loadable plugin." ${OPENCC_JIEBA_PLUGIN_DEFAULT})
+option(ENABLE_SEGMENTATION_PLUGINS "Load segmentation plugins, such as Jieba's, at runtime." ON)
+if (BUILD_OPENCC_JIEBA_PLUGIN AND NOT ENABLE_SEGMENTATION_PLUGINS)
+  message(FATAL_ERROR "BUILD_OPENCC_JIEBA_PLUGIN requires ENABLE_SEGMENTATION_PLUGINS.")
+endif ()
 option(BUILD_PYTHON "Build python library" OFF)
 
 # Built-in dictionaries and configs can be produced as compiled ocd2
@@ -341,9 +345,12 @@ if (ENABLE_BENCHMARK)
   )
 endif()
 
-add_definitions(
-  -DOPENCC_SEGMENTATION_PLUGIN_DIR="${DIR_PLUGIN_FULL}"
-)
+if (ENABLE_SEGMENTATION_PLUGINS)
+  add_definitions(
+    -DOPENCC_ENABLE_SEGMENTATION_PLUGINS
+    -DOPENCC_SEGMENTATION_PLUGIN_DIR="${DIR_PLUGIN_FULL}"
+  )
+endif ()
 
 
 ######## Dependencies
diff --git a/src/CMakeLists.txt b/src/CMakeLists.txt
index 1753830..69581ff 100644
--- a/src/CMakeLists.txt
+++ b/src/CMakeLists.txt
@@ -70,7 +70,6 @@ set(
   MaxMatchSegmentation.cpp
   PhraseExtract.cpp
   PipelineConverter.cpp
-  PluginSegmentation.cpp
   PrefixMatch.cpp
   SingleStageConverter.cpp
   ResourceProvider.cpp
@@ -134,6 +133,10 @@ if (WIN32)
   list(APPEND LIBOPENCC_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/version_libopencc.rc")
 endif()
 
+if (ENABLE_SEGMENTATION_PLUGINS)
+  list(APPEND LIBOPENCC_SOURCES PluginSegmentation.cpp)
+endif ()
+
 add_library(libopencc
   ${LIBOPENCC_SOURCES}
   ${LIBOPENCC_HEADERS}
@@ -152,7 +155,7 @@ if (NOT BUILD_SHARED_LIBS)
 endif()
 # PluginSegmentation.cpp uses LoadLibrary on _WIN32 (MSVC and MinGW).
 # Only non-Windows targets may need libdl for dlopen.
-if (NOT CMAKE_SYSTEM_NAME STREQUAL "Windows")
+if (ENABLE_SEGMENTATION_PLUGINS AND NOT CMAKE_SYSTEM_NAME STREQUAL "Windows")
   include(CheckLibraryExists)
   check_library_exists(dl dlopen "" HAVE_LIBDL)
   if (HAVE_LIBDL)
diff --git a/src/Config.cpp b/src/Config.cpp
index fbed5af..a5431b1 100644
--- a/src/Config.cpp
+++ b/src/Config.cpp
@@ -618,7 +618,11 @@ public:
         }
         configPairs.push_back(std::make_pair(key, it->value.GetString()));
       }
+#ifdef OPENCC_ENABLE_SEGMENTATION_PLUGINS
       segmentation = CreatePluginSegmentation(type, configPairs);
+#else
+      throw InvalidFormat("Segmentation plugins are not enabled: " + type);
+#endif
     }
     return segmentation;
   }
```

Check it applies: `nix develop -c bash -c 'cd $(mktemp -d) && cp -r $(nix build --no-link --print-out-paths .#legacyPackages.x86_64-linux.pkgsWasm.opencc.src)/. . && chmod -R u+w . && patch -p1 --dry-run < '"$PWD"'/engines/rime/patches/opencc/port/0001-Make-segmentation-plugins-optional.patch'`
Expected: `checking file CMakeLists.txt`, `checking file src/CMakeLists.txt`, `checking file src/Config.cpp`, no rejects.

- [ ] **Step 4: Write the overlay**

Create `engines/rime/overlay.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
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
  flake.overlays.rime =
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
          patchesFor = library: layer library "port" ++ layer library "casts";
        in
        {
          leveldb = prev.leveldb.overrideAttrs (old: {
            # Snappy compresses tables Rime's are too small to gain from.
            buildInputs = [ ];
            propagatedBuildInputs = [ ];
            cmakeFlags = (old.cmakeFlags or [ ]) ++ [
              "-DHAVE_CRC32C=OFF"
              "-DHAVE_SNAPPY=OFF"
              "-DHAVE_TCMALLOC=OFF"
            ];
            doCheck = false;
          });

          opencc = prev.opencc.overrideAttrs (old: {
            patches = (old.patches or [ ]) ++ patchesFor "opencc";
            buildInputs = old.buildInputs ++ [ final.marisa ];
            postPatch = (old.postPatch or "") + ''
              substituteInPlace CMakeLists.txt --replace-fail 'add_subdirectory(data)' ""
              substituteInPlace src/CMakeLists.txt --replace-fail 'add_subdirectory(tools)' ""
            '';
            cmakeFlags = (old.cmakeFlags or [ ]) ++ [
              "-DUSE_SYSTEM_MARISA=ON"
              "-DENABLE_SEGMENTATION_PLUGINS=OFF"
              # Rime names OpenCC's configurations by path, in its shared data
              # directory. Outside the store, the library doesn't refer to its
              # own output.
              "-DSHARE_INSTALL_PREFIX=/usr/share"
              "-DBUILD_OPENCC_JIEBA_PLUGIN=OFF"
              "-DENABLE_GTEST=OFF"
              "-DENABLE_BENCHMARK=OFF"
              "-DBUILD_PYTHON=OFF"
              "-DBUILD_DOCUMENTATION=OFF"
            ];
          });

          glog = prev.glog.overrideAttrs (old: {
            buildInputs = [ ];
            propagatedBuildInputs = [ ];
            cmakeFlags = [
              "-DWITH_GFLAGS=OFF"
              "-DWITH_UNWIND=OFF"
              "-DWITH_GTEST=OFF"
              "-DBUILD_TESTING=OFF"
              "-DWITH_PKGCONFIG=ON"
            ];
            doCheck = false;
            # glog's CMake package defines this for its consumers; its
            # pkg-config file doesn't, and the headers refuse to build
            # without it.
            postInstall = (old.postInstall or "") + ''
              substituteInPlace $out/lib/pkgconfig/libglog.pc \
                --replace-fail 'Cflags: -I''${includedir}' 'Cflags: -I''${includedir} -DGLOG_USE_GLOG_EXPORT'
            '';
          });

          lua = prev.lua.overrideAttrs (old: {
            buildInputs = [ ];
            propagatedBuildInputs = [ ];
            # librime-lua sets the search path for Rime's scripts. Outside the
            # store, the library doesn't refer to its own output.
            postPatch = old.postPatch + ''
              sed -i "s@#define LUA_ROOT[[:space:]]*\"$out/\"@#define LUA_ROOT \"/usr/local/\"@" src/luaconf.h
            '';
            makeFlags = map (
              flag:
              if lib.hasPrefix "PLAT=" flag then
                "PLAT=posix"
              else if lib.hasPrefix "MYLIBS=" flag then
                "MYLIBS="
              else
                flag
            ) old.makeFlags;
          });

          ibus-web-boost-headers = pkgs.runCommand "ibus-web-boost-headers-${pkgs.boost.version}" { } ''
            mkdir -p $out/lib/cmake
            cp -r ${pkgs.boost.dev}/include $out/include
            cp -r ${pkgs.boost.dev}/lib/cmake/{Boost,boost_headers}-${pkgs.boost.version} $out/lib/cmake/
          '';
        }
      )
    );
}
```

- [ ] **Step 5: Write the libraries' cast audit**

Create `engines/rime/cast-audit.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) engines toolchain;
      inherit (toolchain) pkgsWasm;

      # The sources compile_commands.json lists for a target, in one
      # language.
      sourcesScript = ''
        const [commands, target, lang] = process.argv.slice(1);
        const suffix = lang === "C" ? /\.c$/ : /\.(cc|cpp)$/;
        for (const { file, output } of require(require("node:path").resolve(commands)))
          if (output.startsWith(target) && suffix.test(file)) console.log(file);
      '';

      # A CMake library's sources, audited with the flags its own configure
      # run gives the target that builds them: CMake writes each target's
      # flags to its flags.make and its sources to compile_commands.json.
      # lang is CXX or C, and only that language's sources are audited.
      cmakeAudit =
        {
          name,
          package,
          target,
          lang ? "CXX",
          extraCflags ? [ ],
        }:
        let
          sources = "node -e ${lib.escapeShellArg sourcesScript} build/compile_commands.json ${target}/ ${lang}";
        in
        (engines.castAudit {
          name = "rime-${name}";
          inherit (package) src;
          cflags = "$(< $TMPDIR/cflags)";
          sourcesFrom = sources;
          allowList = ./cast-audit + "/${name}.jsonc";
        }).overrideAttrs
          (old: {
            inherit (package) patches;
            cmakeFlags = package.cmakeFlags ++ [ "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON" ];
            postPatch = package.postPatch or "";
            preConfigure = package.preConfigure or "";
            nativeBuildInputs = old.nativeBuildInputs ++ package.nativeBuildInputs;
            buildInputs = (package.buildInputs or [ ]) ++ (package.propagatedBuildInputs or [ ]);
            dontConfigure = false;

            # The flags as make holds them, quoted for a shell; each a word.
            preBuild = ''
              make -s -f ${target}/flags.make -f - print-cflags > flags \
                <<< 'print-cflags: ; $(info $(${lang}_DEFINES) $(${lang}_INCLUDES) $(${lang}_FLAGS))@:'
              # emcc warns of the link settings the compiler wrapper passes
              # when it only compiles, which -Werror would make an error.
              eval "printf '%s\n' $(< flags)" | grep -vx -e -Werror > $TMPDIR/cflags
              printf '%s\n' ${lib.escapeShellArgs extraCflags} >> $TMPDIR/cflags
              cd ..
              echo "auditing $(${sources} | wc -l) sources"
            '';
          });

      audits = {
        leveldb = cmakeAudit {
          name = "leveldb";
          package = pkgsWasm.leveldb;
          target = "CMakeFiles/leveldb.dir";
        };
        yaml-cpp = cmakeAudit {
          name = "yaml-cpp";
          package = pkgsWasm.yaml-cpp;
          target = "CMakeFiles/yaml-cpp.dir";
        };
        opencc = cmakeAudit {
          name = "opencc";
          package = pkgsWasm.opencc;
          target = "src/CMakeFiles/libopencc.dir";
        };
        glog = cmakeAudit {
          name = "glog";
          package = pkgsWasm.glog;
          target = "CMakeFiles/glog_internal.dir";
        };
        marisa = cmakeAudit {
          name = "marisa";
          package = pkgsWasm.marisa;
          target = "CMakeFiles/marisa.dir";
        };

        # The library's sources, with the flags its posix target gives them;
        # lua.c and luac.c are the programs.
        lua = engines.castAudit {
          name = "rime-lua";
          inherit (pkgsWasm.lua) src;
          cflags = "-O2 -fPIC -DLUA_USE_POSIX";
          sourcesFrom = "ls src/*.c | grep -v -e '^src/lua\\.c$' -e '^src/luac\\.c$'";
          allowList = ./cast-audit/lua.jsonc;
        };
      };
    in
    {
      checks.rime-cast-audit = pkgs.linkFarm "ibus-web-rime-cast-audit" audits;
    };
}
```

Create each of `engines/rime/cast-audit/leveldb.jsonc`, `yaml-cpp.jsonc`, `opencc.jsonc`, `glog.jsonc`, `marisa.jsonc` and `lua.jsonc` with:

```jsonc
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later
{
  "$schema": "../../../tools/cast-audit/cast-audit.schema.json",
  "casts": [],
}
```

- [ ] **Step 6: Licences**

Run: `nix develop -c reuse download GPL-3.0-or-later`
Expected: `Successfully downloaded LICENSES/GPL-3.0-or-later.txt.`

In `REUSE.toml`, insert before the `engines/mozc/patches/**/*.patch` annotation:

```toml
# Matches the upstream ibus-engines.rime recipe's meta.license.
[[annotations]]
path = "engines/rime/**"
SPDX-FileCopyrightText = "2026 Synapdeck, Inc."
SPDX-License-Identifier = "GPL-3.0-or-later"
precedence = "override"

# OpenCC's own licence, which the engine-wide annotation above would
# otherwise override; the last matching annotation wins.
[[annotations]]
path = "engines/rime/patches/opencc/**/*.patch"
SPDX-FileCopyrightText = ["Carbo Kuo and the OpenCC contributors", "2026 Synapdeck, Inc."]
SPDX-License-Identifier = "Apache-2.0"
precedence = "override"

```

- [ ] **Step 7: Build and audit the libraries**

Run:

```bash
nix develop -c git add engines/rime modules/engines REUSE.toml LICENSES/GPL-3.0-or-later.txt
for library in leveldb opencc glog lua ibus-web-boost-headers; do
  nix build --no-link --print-out-paths -L .#legacyPackages.x86_64-linux.pkgsWasm.$library
done
nix build .#checks.x86_64-linux.rime-cast-audit -L 2>&1 | grep auditing
```

Expected: five store paths (`leveldb-static-wasm32-unknown-none-1.23`, `opencc-static-…-1.4.1`, `glog-static-…-0.7.1`, `lua-static-…-5.2.4`, `ibus-web-boost-headers-1.91.0`), none of which builds Snappy, readline or ncurses; then `auditing 38 sources` (LevelDB), `32` (yaml-cpp), `25` (OpenCC), `9` (glog) and `9` (MARISA), and the check PASSes with every allow-list empty. Check what the overlay promised:

```bash
opencc=$(nix build --no-link --print-out-paths .#legacyPackages.x86_64-linux.pkgsWasm.opencc)
strings "$opencc"/lib/libopencc.a | grep -c -e '/nix/store' -e dlopen || true
grep -c GLOG_USE_GLOG_EXPORT $(nix build --no-link --print-out-paths .#legacyPackages.x86_64-linux.pkgsWasm.glog)/lib/pkgconfig/libglog.pc
```

Expected: `0` (no store path and no loader in OpenCC), `1`.

- [ ] **Step 8: Write the patch inventory and the docs**

Create `engines/rime/patches/README.md`:

```markdown
# Rime patches

The sources come from the pinned nixpkgs recipes: `opencc` (OpenCC 1.4.1), `librime` (librime 1.17.0) and
`ibus-engines.rime` (ibus-rime 1.6.1). Local patches apply after nixpkgs' in two layers, `port` then `casts`, each
sorted by filename; a layer with no patch has no directory. Each is a `git format-patch` against that source; none has
been submitted upstream yet.

`opencc/` is Apache-2.0, as OpenCC is.

| Patch                | Reason                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opencc port 0001     | Make segmentation plugins optional (`ENABLE_SEGMENTATION_PLUGINS`). OpenCC loads one, such as Jieba's, with `dlopen` whenever a configuration names a segmentation it doesn't have built in; with the option off, `PluginSegmentation.cpp` isn't built, the library needs no libdl and records no plugin directory, and such a configuration fails as an unknown type does. |
```

Create `docs/rime.md`:

````markdown
# Rime

`engines/rime/` builds ibus-rime 1.6.1, the IBus front end of the Rime input method engine, with librime 1.17.0 and its
`librime-lua` and `librime-octagram` plugins, as one engine module, `rime.wasm`. Its data is `rime-data`'s schemas,
`rime-ice`'s, which replace `rime-data`'s `double_pinyin*`, and CanCLID's `loengfan`; each schema that types is an
engine of its own, `rime:<schema_id>`. This page describes how the libraries and the module are built, the deployment
that compiles the data at build time, how the module starts without a bus, its engines and their descriptors, its
settings, the switches it registers as properties, and its checks.

```sh
nix build .#ibus-web-rime
nix build .#checks.x86_64-linux.rime-golden
```

## Build

`flake.overlays.rime`, which applies only to `pkgsWasm`, overrides nixpkgs' recipes and keeps their CMake builds (and
Lua's make). Local patches apply after nixpkgs' in two layers, `port` then `casts`, each sorted by filename, under
`engines/rime/patches/<library>/`; a layer with no patch has no directory. The
[inventory](../engines/rime/patches/README.md) gives each patch's reason. Every library is static and private to the
module except MARISA, the one package the table engine also links ([engines.md](engines.md#marisa)); each side module
links its own copy.

### Libraries

- **LevelDB** 1.23 is configured as nixpkgs' native LevelDB already is, without Google's `crc32c` library, Snappy and
  tcmalloc. nixpkgs' cross CMake compiles library checks to a static library without linking, so every
  `check_library_exists` passes; the overlay answers `HAVE_CRC32C`, `HAVE_SNAPPY` and `HAVE_TCMALLOC` `OFF`. Without
  `crc32c`, LevelDB checksums every block and log record with its own table-driven CRC32C, which is what the library's
  portable code would do on WebAssembly, which has no CRC instruction. Snappy doesn't build for WebAssembly, and Rime's
  user dictionaries are too small to miss compression. On a 32-bit target LevelDB reads its tables with `pread` rather
  than mapping them. Its background compaction thread stays: the runtime has threads.
- **OpenCC** 1.4.1 builds against `pkgsWasm.marisa` (`USE_SYSTEM_MARISA`) rather than its bundled copy, which would
  collide with librime's. Its `data/` and `src/tools/` aren't built: generating the data runs the freshly built `opencc`
  program, which a cross build can't. The conversion data is the build machine's OpenCC's `share/opencc`, in Rime's
  shared data directory, where Rime names each configuration by path. Port patch 0001 makes segmentation plugins
  (Jieba's, loaded with `dlopen`) optional, and the overlay turns them off; `SHARE_INSTALL_PREFIX=/usr/share` keeps
  OpenCC's own data directory out of the store. The library then refers to no store path and nothing of the loader.
- **glog** 0.7.1 is built without gflags, libunwind and its tests. Its `libglog.pc` gains `-DGLOG_USE_GLOG_EXPORT`,
  which glog's CMake package gives its consumers and its headers require.
- **Lua** is the `lua` nixpkgs' `librime-lua` takes, 5.2.4, built with `PLAT=posix`: POSIX without `LUA_USE_DLOPEN`, and
  without readline. `rime-ice`'s scripts need of later Lua only the `utf8` library, which librime-lua supplies. Its
  `LUA_ROOT` is `/usr/local/`, as upstream's: librime-lua sets the scripts' search path itself.
- **yaml-cpp** 0.9.0 is nixpkgs' as it is, which already builds without its tools, and without tests when it can't run
  them.
- **Boost**: `ibus-web-boost-headers` is the build machine's Boost 1.91 headers and its `Boost` and `boost_headers`
  CMake packages. Outside Linux, librime asks CMake for Boost with no compiled component.

## Checks

| Check             | Covers                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `rime-cast-audit` | LevelDB, yaml-cpp, OpenCC, glog, MARISA and Lua, each against its own allow-list, all empty |

A CMake library is audited with the flags its own configure gives the target that builds it, from the target's
`flags.make`, over the sources `compile_commands.json` lists for the target.
````

In `docs/README.md`, add this row to the Topics table below the `m17n.md` row:

```markdown
| [rime.md](rime.md)               | Rime: its libraries, librime and ibus-rime for WebAssembly, the build-time deployment, startup without a bus, the engines and their descriptors, settings, switches as properties, and the checks |
```

In `docs/engines.md`, section "Cast audit", append to the paragraph that ends `` and `checks.mozc-cast-audit` compares what it found.``:

```markdown
A library too large to list file by file passes `sourcesFrom`, a shell command that prints its sources, in place of
`sources`: `checks.rime-cast-audit` reads each CMake target's sources from `compile_commands.json` and its flags from
the target's `flags.make` ([rime.md](rime.md#checks)).
```

Run: `nix develop -c oxfmt docs/rime.md docs/README.md docs/engines.md engines/rime/patches/README.md`

- [ ] **Step 9: Commit**

```bash
nix develop -c git add engines/rime modules/engines REUSE.toml LICENSES/GPL-3.0-or-later.txt docs/rime.md docs/README.md docs/engines.md
nix develop -c git commit -m "build(rime): build Rime's libraries for WebAssembly" -- engines/rime modules/engines REUSE.toml LICENSES/GPL-3.0-or-later.txt docs/rime.md docs/README.md docs/engines.md
```

hk runs `reuse lint`; it must pass with the new annotations.

---

### Task 3: librime, its plugins and its tools

librime 1.17.0 static, with `librime-lua` and `librime-octagram` merged in, and its `rime_deployer` and `rime_dict_manager` as WebAssembly programs run under Node.

**Files:**
- Create: `engines/rime/patches/librime/port/0001-dict_compiler-log-a-missing-source-as-information.patch`, `engines/rime/patches/librime/port/0002-switcher-let-a-front-end-filter-the-schema-list.patch`, `engines/rime/cast-audit/{librime,librime-lua,librime-lua-c,librime-octagram}.jsonc`
- Modify: `engines/rime/overlay.nix`, `engines/rime/cast-audit.nix`, `engines/rime/patches/README.md`, `REUSE.toml`
- Docs: `docs/rime.md`

**Interfaces:**
- Consumes: Task 2's libraries.
- Produces: `pkgsWasm.librime` (`lib/librime.a`, `include/rime_api.h`, `include/rime/**/*.h`, `lib/pkgconfig/rime.pc` with `Requires.private: yaml-cpp leveldb marisa opencc libglog lua`); `pkgsWasm.ibus-web-rime-tools` (`rime_deployer.{js,wasm}`, `rime_dict_manager.{js,wasm}`); `rime::Switcher::SetSchemaListFilter(function<bool(const string& schema_id)>)` (librime port 0002).

- [ ] **Step 1: Write the failing test**

Run: `nix build .#legacyPackages.x86_64-linux.pkgsWasm.ibus-web-rime-tools`
Expected: FAIL: `attribute 'ibus-web-rime-tools' missing`.

- [ ] **Step 2: Make librime's port patches**

Create `engines/rime/patches/librime/port/0001-dict_compiler-log-a-missing-source-as-information.patch`, a `git format-patch` against librime 1.17.0 (`pkgsWasm.librime.src`):

```diff
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Alexis Williams <alexis@typedr.at>
Date: Sun, 11 Oct 2026 12:50:34 -0700
Subject: [PATCH] dict_compiler: log a missing source as information

A distribution that ships prebuilt tables without their sources, so that
a redeployment reuses them, logged an error for every dictionary each
time it deployed. A missing source is an error only without a prebuilt
table, which the compiler reports on its own.
---
 src/rime/dict/dict_compiler.cc | 3 ++-
 1 file changed, 2 insertions(+), 1 deletion(-)

diff --git a/src/rime/dict/dict_compiler.cc b/src/rime/dict/dict_compiler.cc
index 5996ee2..af7cae0 100644
--- a/src/rime/dict/dict_compiler.cc
+++ b/src/rime/dict/dict_compiler.cc
@@ -83,7 +83,8 @@ bool DictCompiler::Compile(const path& schema_file) {
   DictSettings settings;
   auto dict_file = source_resolver_->ResolvePath(dict_name_ + ".dict.yaml");
   if (!std::filesystem::exists(dict_file)) {
-    LOG(ERROR) << "source file '" << dict_file << "' does not exist.";
+    // Not an error while a prebuilt table exists, which is checked below.
+    LOG(INFO) << "source file '" << dict_file << "' does not exist.";
     build_table_from_source = false;
   } else if (!load_dict_settings_from_file(&settings, dict_file)) {
     LOG(ERROR) << "failed to load settings from '" << dict_file << "'.";
```

Create `engines/rime/patches/librime/port/0002-switcher-let-a-front-end-filter-the-schema-list.patch`:

```diff
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Alexis Williams <alexis@typedr.at>
Date: Sun, 11 Oct 2026 12:50:34 -0700
Subject: [PATCH] switcher: let a front end filter the schema list

A front end that offers each schema as an input method of its own, and
switches between them itself, wants Rime's switcher to offer only the
current schema. A filter set with Switcher::SetSchemaListFilter limits
the entries ForEachSchemaListEntry visits: the switcher's menu, which
lists the current schema first whatever the filter says, and the schema a
new session starts with, which is the default configuration when the
filter accepts none.
---
 src/rime/switcher.cc | 13 +++++++++++++
 src/rime/switcher.h  |  5 +++++
 2 files changed, 18 insertions(+)

diff --git a/src/rime/switcher.cc b/src/rime/switcher.cc
index d283a92..85840fe 100644
--- a/src/rime/switcher.cc
+++ b/src/rime/switcher.cc
@@ -143,18 +143,31 @@ static an<ConfigValue> ParseSchemaListEntry(Config* config,
   return schema_property;
 }
 
+static function<bool(const string& schema_id)>& schema_list_filter() {
+  static function<bool(const string& schema_id)> filter;
+  return filter;
+}
+
+void Switcher::SetSchemaListFilter(
+    function<bool(const string& schema_id)> filter) {
+  schema_list_filter() = std::move(filter);
+}
+
 int Switcher::ForEachSchemaListEntry(
     Config* config,
     function<bool(const string& schema_id)> process_entry) {
   auto schema_list = config->GetList("schema_list");
   if (!schema_list)
     return 0;
+  const auto& filter = schema_list_filter();
   int num_processed_entries = 0;
   for (auto iter = schema_list->begin(); iter != schema_list->end(); ++iter) {
     auto entry = ParseSchemaListEntry(config, As<ConfigMap>(*iter));
     if (!entry)
       continue;
     const string& schema_id = entry->str();
+    if (filter && !filter(schema_id))
+      continue;
     ++num_processed_entries;
     if (!process_entry(schema_id))
       break;
diff --git a/src/rime/switcher.h b/src/rime/switcher.h
index 7ad7676..a7081ee 100644
--- a/src/rime/switcher.h
+++ b/src/rime/switcher.h
@@ -30,6 +30,11 @@ class Switcher : public Processor, public Engine {
   static int ForEachSchemaListEntry(
       Config* config,
       function<bool(const string& schema_id)> process_entry);
+  // Limits the schema list entries the switcher offers, and starts new
+  // sessions with, to those the filter accepts. Without one, all of them.
+  // Set it before making sessions.
+  static void SetSchemaListFilter(
+      function<bool(const string& schema_id)> filter);
 
   void SetActiveSchema(const string& schema_id);
   Schema* CreateSchema();
```

In `REUSE.toml`, insert after the OpenCC patch annotation Task 2 added:

```toml
[[annotations]]
path = "engines/rime/patches/librime/**/*.patch"
SPDX-FileCopyrightText = ["RIME Developers", "2026 Synapdeck, Inc."]
SPDX-License-Identifier = "BSD-3-Clause"
precedence = "override"

```

- [ ] **Step 3: Build librime and its tools in the overlay**

In `engines/rime/overlay.nix`, replace `        { pkgs, ... }:` with `        { config, pkgs, ... }:`, and insert above `          ibus-web-boost-headers =`:

```nix
          librime =
            (prev.librime.override {
              boost = final.ibus-web-boost-headers;
              plugins = [
                final.librime-lua
                final.librime-octagram
              ];
            }).overrideAttrs
              (old: {
                patches = (old.patches or [ ]) ++ patchesFor "librime";
                buildInputs = [ final.ibus-web-boost-headers ];
                # A static library's consumers link its dependencies too.
                propagatedBuildInputs = with final; [
                  glog
                  leveldb
                  marisa
                  opencc
                  yaml-cpp
                  lua
                ];
                cmakeFlags = [
                  "-DBUILD_STATIC=ON"
                  "-DBUILD_SHARED_LIBS=OFF"
                  "-DBUILD_MERGED_PLUGINS=ON"
                  "-DBUILD_TEST=OFF"
                  "-DBUILD_TOOLS=OFF"
                  "-DENABLE_LOGGING=ON"
                  "-DENABLE_THREADING=ON"
                  # WasmFS gives a file the time it first saw it, not the
                  # store's, so recorded times never match and would make each
                  # deployment rebuild every prism. Without them the configs
                  # recompile on each deployment, to the same bytes, and the
                  # prebuilt prisms stay current.
                  "-DENABLE_TIMESTAMP=OFF"
                  "-DENABLE_EXTERNAL_PLUGINS=OFF"
                  "-DINSTALL_PRIVATE_HEADERS=ON"
                ];
                postInstall = (old.postInstall or "") + ''
                  mkdir -p $out/lib/pkgconfig
                  cat > $out/lib/pkgconfig/rime.pc <<EOF
                  Name: Rime
                  Description: Rime Input Method Engine
                  Version: ${old.version}
                  Requires.private: yaml-cpp leveldb marisa opencc libglog lua
                  Cflags: -I$out/include
                  Libs: -L$out/lib -lrime
                  EOF
                '';
              });

          ibus-web-rime-tools = final.stdenv.mkDerivation {
            pname = "ibus-web-rime-tools";
            inherit (final.librime) version src;
            nativeBuildInputs = [ final.buildPackages.pkg-config ];
            buildInputs = [
              final.librime
              final.ibus-web-boost-headers
            ];
            dontConfigure = true;
            buildPhase = ''
              runHook preBuild
              for tool in rime_deployer rime_dict_manager; do
                $CXX -std=c++17 -Itools $($PKG_CONFIG --cflags rime libglog yaml-cpp leveldb marisa opencc) -c tools/$tool.cc -o $tool.o
                $CXX ${config.ibusWeb.toolchain.testMainFlags} -sINITIAL_MEMORY=2GB -sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB \
                  $tool.o $($PKG_CONFIG --static --libs rime) -o $tool.js
              done
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              install -Dm644 -t $out rime_deployer.{js,wasm} rime_dict_manager.{js,wasm}
              runHook postInstall
            '';
            dontFixup = true;
          };

```

- [ ] **Step 4: Audit librime and its plugins**

In `engines/rime/cast-audit.nix`, insert above `      audits = {`:

```nix
      luaPlugin = "plugins/librime-lua-static-${pkgsWasm.librime-lua.version}";
      octagramPlugin = "plugins/librime-octagram-static-${pkgsWasm.librime-octagram.version}";

```

and, inside `audits = {`, above `        leveldb = cmakeAudit {`:

```nix
        librime = cmakeAudit {
          name = "librime";
          package = pkgsWasm.librime;
          target = "src/CMakeFiles/rime-static.dir";
          # setup.cc alone takes the merged plugins' modules.
          extraCflags = [ "-DRIME_EXTRA_MODULES=,Q(lua),Q(octagram)" ];
        };
        librime-lua = cmakeAudit {
          name = "librime-lua";
          package = pkgsWasm.librime;
          target = "${luaPlugin}/CMakeFiles/rime-lua-objs.dir";
        };
        librime-lua-c = cmakeAudit {
          name = "librime-lua-c";
          package = pkgsWasm.librime;
          target = "${luaPlugin}/CMakeFiles/rime-lua-objs.dir";
          lang = "C";
        };
        librime-octagram = cmakeAudit {
          name = "librime-octagram";
          package = pkgsWasm.librime;
          target = "${octagramPlugin}/CMakeFiles/rime-octagram-objs.dir";
        };
```

Create each of `engines/rime/cast-audit/librime.jsonc`, `librime-lua.jsonc`, `librime-lua-c.jsonc` and `librime-octagram.jsonc` with the same empty list as Task 2's.

- [ ] **Step 5: Build, run the deployer, audit**

Run:

```bash
nix develop -c git add engines/rime REUSE.toml
librime=$(nix build --no-link --print-out-paths -L .#legacyPackages.x86_64-linux.pkgsWasm.librime)
ls "$librime"/lib "$librime"/lib/pkgconfig
tools=$(nix build --no-link --print-out-paths -L .#legacyPackages.x86_64-linux.pkgsWasm.ibus-web-rime-tools)
nix develop -c node "$tools"/rime_deployer.js | head -3
nix build .#checks.x86_64-linux.rime-cast-audit -L 2>&1 | grep auditing
```

Expected: librime's configure prints `Found plugin: …/librime-lua-static-…`, `Found plugin: …/librime-octagram-static-…`, `Found lua, version 5.2.4` and `rime_plugins_modules: lua;octagram`, and nothing of Snappy, GTest or capnproto; `lib` holds `librime.a` and `pkgconfig/rime.pc`; the deployer prints `Usage:`, `--add-schema <schema_id>...` and its description; the audit adds `auditing 105 sources` (librime), `8` (librime-lua's C++), `2` (its C), `4` (librime-octagram) and PASSes with every allow-list empty.

- [ ] **Step 6: Update the patch inventory and the docs**

In `engines/rime/patches/README.md`, add to the table, after the OpenCC row:

```markdown
| librime port 0001 | Log a missing dictionary source at INFO. Deploying over prebuilt tables without their sources, which reuses the tables, logged an error for every dictionary; a missing source is an error only without a prebuilt table, which the compiler reports on its own. |
| librime port 0002 | Let a front end filter the schema list (`Switcher::SetSchemaListFilter`): the entries the switcher's menu offers and a new session starts with. A front end that offers each schema as an input method of its own, and switches between them itself, wants the menu to offer only the current schema. |
```

and replace its sentence `` `opencc/` is Apache-2.0, as OpenCC is. `` with `` `opencc/` is Apache-2.0, as OpenCC is; `librime/` is BSD-3-Clause, as librime is. ``

In `docs/rime.md`, insert above `## Checks`:

```markdown
### librime

`librime` is built static, with its plugins merged in (`BUILD_MERGED_PLUGINS`), threading (`ENABLE_THREADING`: the
deployer runs on a `std::async` thread), logging, and its private headers installed, which the tools and the descriptor
program include. It is built without `ENABLE_TIMESTAMP`. With it, a deployment records each source file's modification
time in the compiled config and rebuilds a config whose recorded times differ from the files'. WasmFS gives a file the
time at which it first sees it, not the store's, so the times never match: every deployment would recompile every
config with new bytes and rebuild every prism, whose checksum covers the config. Without them, a deployment recompiles
the configs to the same bytes and the prebuilt prisms stay current.

librime installs no `rime.pc` outside Linux and the BSDs, so the overlay writes one, with the libraries as
`Requires.private`. A static librime registers a plugin's modules only if something refers to the plugin, so the module
calls the `rime_require_module_*` functions each defines for that. librime builds its tools only with a shared library;
`ibus-web-rime-tools` compiles `rime_deployer` and `rime_dict_manager` against the static one and links them as Node
programs on WasmFS with the host's files, with a fixed 2 GB memory, since deploying `rime_ice` peaks near 900 MB.

librime's port patches: 0001 logs a missing dictionary source at INFO, since deploying over prebuilt tables without
their sources logged an error per dictionary; 0002 lets a front end filter the schema list the switcher offers and new
sessions start from (`Switcher::SetSchemaListFilter`).
```

and in the `rime-cast-audit` row of its `## Checks` table replace `LevelDB, yaml-cpp, OpenCC, glog, MARISA and Lua` with `librime, librime-lua, librime-octagram, LevelDB, yaml-cpp, OpenCC, glog, MARISA and Lua`.

Run: `nix develop -c oxfmt docs/rime.md engines/rime/patches/README.md`

- [ ] **Step 7: Commit**

```bash
nix develop -c git add engines/rime REUSE.toml docs/rime.md
nix develop -c git commit -m "build(rime): build librime and its tools for WebAssembly" -- engines/rime REUSE.toml docs/rime.md
```

---

### Task 4: ibus-rime's engine

ibus-rime 1.6.1's `rime_engine.c` and `rime_settings.c`, patched and compiled with its own CMake flags, as objects the side module links. `rime_main.c` isn't built.

**Files:**
- Create: `engines/rime/patches/ibus-rime/port/0001-Make-libnotify-optional.patch`, `0002-Select-the-schema-an-engine-is-named-for.patch`, `0003-Register-the-schema-s-switches-as-properties.patch`, `engines/rime/patches/ibus-rime/casts/0001-Use-the-declared-GObject-callback-types.patch`, `engines/rime/cast-audit/ibus-rime.jsonc`
- Modify: `engines/rime/overlay.nix`, `engines/rime/cast-audit.nix`, `engines/rime/patches/README.md`, `REUSE.toml`
- Docs: `docs/rime.md`

**Interfaces:**
- Consumes: `pkgsWasm.librime` (Task 3), `pkgsWasm.libibus-web`.
- Produces: `pkgsWasm.ibus-engines.rime`: `lib/ibus-rime/rime_engine.o`, `lib/ibus-rime/rime_settings.o`, `lib/ibus-rime/cflags` (the C flags, quoted for a shell, as CMake wrote them), `include/ibus-rime/{rime_config.h,rime_engine.h,rime_settings.h}`, `share/rime-data/ibus_rime.yaml`. From the patches: `void ibus_rime_engine_option_changed(RimeSessionId session_id, const char* option);` (in `rime_engine.h`); the engine expects `RimeApi *rime_api`, `void ibus_rime_start(gboolean full_check)` and `void ibus_rime_stop()` from the program that links it; engines named `rime:<schema_id>` select that schema; switch properties keyed `rime:option:<name>`, `rime:options:<index>` and `rime:option:<option>`.

- [ ] **Step 1: Write the patches**

Create `engines/rime/patches/ibus-rime/port/0001-Make-libnotify-optional.patch`, a `git format-patch` against ibus-rime 1.6.1 (`pkgsWasm.ibus-engines.rime.src`):

```diff
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Alexis Williams <alexis@typedr.at>
Date: Sun, 11 Oct 2026 12:47:37 -0700
Subject: [PATCH] Make libnotify optional

ibus-rime shows Rime's deployment messages as desktop notifications,
which needs libnotify and a notification daemon. Builds without a desktop
can turn that off with -DENABLE_LIBNOTIFY=OFF; the messages are then
logged.
---
 CMakeLists.txt |  8 +++++---
 rime_main.c    | 10 ++++++++++
 2 files changed, 15 insertions(+), 3 deletions(-)

diff --git a/CMakeLists.txt b/CMakeLists.txt
index 4a22bbc..1545c1f 100644
--- a/CMakeLists.txt
+++ b/CMakeLists.txt
@@ -16,11 +16,13 @@ if(IBus_FOUND)
   link_directories(${IBus_LIBRARY_DIRS})
 endif(IBus_FOUND)
 
-pkg_check_modules(LIBNOTIFY REQUIRED libnotify)
-if (LIBNOTIFY_FOUND)
+option(ENABLE_LIBNOTIFY "Show Rime's deployment messages as desktop notifications" ON)
+if(ENABLE_LIBNOTIFY)
+  pkg_check_modules(LIBNOTIFY REQUIRED libnotify)
   include_directories(${LIBNOTIFY_INCLUDE_DIRS})
   link_directories(${LIBNOTIFY_LIBRARY_DIRS})
-endif(LIBNOTIFY_FOUND)
+  add_definitions(-DIBUS_RIME_ENABLE_LIBNOTIFY)
+endif(ENABLE_LIBNOTIFY)
 
 find_package(Rime REQUIRED)
 if(Rime_FOUND)
diff --git a/rime_main.c b/rime_main.c
index 0706daa..2f7ab17 100644
--- a/rime_main.c
+++ b/rime_main.c
@@ -8,7 +8,9 @@
 #include <glib-object.h>
 #include <glib/gstdio.h>
 #include <ibus.h>
+#ifdef IBUS_RIME_ENABLE_LIBNOTIFY
 #include <libnotify/notify.h>
+#endif
 #include <rime_api.h>
 #include "rime_engine.h"
 #include "rime_settings.h"
@@ -30,9 +32,13 @@ static const char* get_ibus_rime_user_data_dir(char *path) {
 }
 
 static void show_message(const char* summary, const char* details) {
+#ifdef IBUS_RIME_ENABLE_LIBNOTIFY
   NotifyNotification* notice = notify_notification_new(summary, details, NULL);
   notify_notification_show(notice, NULL);
   g_object_unref(notice);
+#else
+  g_message("%s%s%s", summary, details ? " " : "", details ? details : "");
+#endif
 }
 
 static void notification_handler(void* context_object,
@@ -112,10 +118,12 @@ static void rime_with_ibus() {
     exit(1);
   }
 
+#ifdef IBUS_RIME_ENABLE_LIBNOTIFY
   if (!notify_init("ibus-rime")) {
     g_error("notify_init failed");
     exit(1);
   }
+#endif
   rime_api->set_notification_handler(notification_handler, NULL);
 
   RIME_STRUCT(RimeTraits, ibus_rime_traits);
@@ -129,7 +137,9 @@ static void rime_with_ibus() {
   ibus_main();
 
   ibus_rime_stop();
+#ifdef IBUS_RIME_ENABLE_LIBNOTIFY
   notify_uninit();
+#endif
 
   g_object_unref(factory);
   g_object_unref(bus);
```

Create `engines/rime/patches/ibus-rime/port/0002-Select-the-schema-an-engine-is-named-for.patch`:

```diff
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Alexis Williams <alexis@typedr.at>
Date: Sun, 11 Oct 2026 12:49:07 -0700
Subject: [PATCH] Select the schema an engine is named for

An engine named "rime:<schema_id>" makes its sessions in that schema,
so that a front end can offer each schema as an engine of its own. The
engine named "rime" keeps the schema the user last chose.

The name is a construct property, set after instance init, so the first
session is made once the engine is constructed.
---
 rime_engine.c | 30 ++++++++++++++++++++++++++++--
 1 file changed, 28 insertions(+), 2 deletions(-)

diff --git a/rime_engine.c b/rime_engine.c
index 3406f04..d8ad5f9 100644
--- a/rime_engine.c
+++ b/rime_engine.c
@@ -29,6 +29,7 @@ struct _IBusRimeEngineClass {
 /* functions prototype */
 static void ibus_rime_engine_class_init (IBusRimeEngineClass *klass);
 static void ibus_rime_engine_init (IBusRimeEngine *rime_engine);
+static void ibus_rime_engine_constructed (GObject *object);
 static void ibus_rime_engine_destroy (IBusRimeEngine *rime_engine);
 static gboolean ibus_rime_engine_process_key_event (IBusEngine *engine,
                                                     guint keyval,
@@ -69,9 +70,11 @@ G_DEFINE_TYPE (IBusRimeEngine, ibus_rime_engine, IBUS_TYPE_ENGINE)
 static void
 ibus_rime_engine_class_init (IBusRimeEngineClass *klass)
 {
+  GObjectClass *object_class = G_OBJECT_CLASS (klass);
   IBusObjectClass *ibus_object_class = IBUS_OBJECT_CLASS (klass);
   IBusEngineClass *engine_class = IBUS_ENGINE_CLASS (klass);
 
+  object_class->constructed = ibus_rime_engine_constructed;
   ibus_object_class->destroy = (IBusObjectDestroyFunc) ibus_rime_engine_destroy;
 
   engine_class->process_key_event = ibus_rime_engine_process_key_event;
@@ -86,10 +89,26 @@ ibus_rime_engine_class_init (IBusRimeEngineClass *klass)
   engine_class->page_down = ibus_rime_engine_page_down;
 }
 
+// An engine named "rime:<schema_id>" types in that schema; "rime" keeps
+// the one the user last chose.
+static const char*
+ibus_rime_engine_schema (IBusRimeEngine *rime_engine)
+{
+  const gchar* name = ibus_engine_get_name((IBusEngine *)rime_engine);
+  if (name && g_str_has_prefix(name, "rime:")) {
+    return name + strlen("rime:");
+  }
+  return NULL;
+}
+
 static void
 ibus_rime_create_session (IBusRimeEngine *rime_engine)
 {
   rime_engine->session_id = rime_api->create_session();
+  const char* schema_id = ibus_rime_engine_schema(rime_engine);
+  if (rime_engine->session_id && schema_id) {
+    rime_api->select_schema(rime_engine->session_id, schema_id);
+  }
   Bool inline_caret =
       g_ibus_rime_settings.embed_preedit_text &&
       g_ibus_rime_settings.preedit_style == PREEDIT_STYLE_COMPOSITION &&
@@ -100,8 +119,6 @@ ibus_rime_create_session (IBusRimeEngine *rime_engine)
 static void
 ibus_rime_engine_init (IBusRimeEngine *rime_engine)
 {
-  ibus_rime_create_session(rime_engine);
-
   RIME_STRUCT_INIT(RimeStatus, rime_engine->status);
   RIME_STRUCT_CLEAR(rime_engine->status);
 
@@ -152,6 +169,15 @@ ibus_rime_engine_init (IBusRimeEngine *rime_engine)
   ibus_prop_list_append(rime_engine->props, prop);
 }
 
+// The engine's name, which picks its schema, is a construct property, set
+// after instance init.
+static void
+ibus_rime_engine_constructed (GObject *object)
+{
+  G_OBJECT_CLASS (ibus_rime_engine_parent_class)->constructed (object);
+  ibus_rime_create_session ((IBusRimeEngine *)object);
+}
+
 static void
 ibus_rime_engine_destroy (IBusRimeEngine *rime_engine)
 {
```

Create `engines/rime/patches/ibus-rime/port/0003-Register-the-schema-s-switches-as-properties.patch`:

```diff
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Alexis Williams <alexis@typedr.at>
Date: Sun, 11 Oct 2026 12:50:18 -0700
Subject: [PATCH] Register the schema's switches as properties

Each of the schema's switches becomes a property, so a panel or a page
can show and set them without Rime's own menu: a switch of two states is
a toggle keyed rime:option:<name>, and one of several options a menu of
radio properties keyed rime:option:<option>. Their labels are the
schema's state labels. Rime's option notifications update them, and
activating one sets the option.
---
 rime_engine.c | 255 ++++++++++++++++++++++++++++++++++++++++++++++++++
 rime_engine.h |   6 ++
 rime_main.c   |   4 +
 3 files changed, 265 insertions(+)

diff --git a/rime_engine.c b/rime_engine.c
index d8ad5f9..e19aef8 100644
--- a/rime_engine.c
+++ b/rime_engine.c
@@ -7,8 +7,18 @@
 // TODO:
 #define _(x) (x)
 
+// Properties for Rime's switches are keyed by this and the switch's name, or
+// for a switch of several options, each option's name.
+#define IBUS_RIME_OPTION_PREFIX "rime:option:"
+
+// ibus-rime's own properties, which come before the switches'.
+#define IBUS_RIME_BASE_PROPERTIES 3
+
 extern RimeApi *rime_api;
 
+// The engine each session belongs to, for Rime's option notifications.
+static GHashTable* engines_by_session = NULL;
+
 typedef struct _IBusRimeEngine IBusRimeEngine;
 typedef struct _IBusRimeEngineClass IBusRimeEngineClass;
 
@@ -101,9 +111,21 @@ ibus_rime_engine_schema (IBusRimeEngine *rime_engine)
   return NULL;
 }
 
+static void
+ibus_rime_forget_session (IBusRimeEngine *rime_engine)
+{
+  if (engines_by_session && rime_engine->session_id) {
+    g_hash_table_remove(engines_by_session,
+                        GSIZE_TO_POINTER(rime_engine->session_id));
+  }
+}
+
+static void ibus_rime_engine_load_switches (IBusRimeEngine *rime_engine);
+
 static void
 ibus_rime_create_session (IBusRimeEngine *rime_engine)
 {
+  ibus_rime_forget_session(rime_engine);
   rime_engine->session_id = rime_api->create_session();
   const char* schema_id = ibus_rime_engine_schema(rime_engine);
   if (rime_engine->session_id && schema_id) {
@@ -114,6 +136,209 @@ ibus_rime_create_session (IBusRimeEngine *rime_engine)
       g_ibus_rime_settings.preedit_style == PREEDIT_STYLE_COMPOSITION &&
       g_ibus_rime_settings.cursor_type == CURSOR_TYPE_INSERT;
   rime_api->set_option(rime_engine->session_id, "soft_cursor", !inline_caret);
+  if (rime_engine->session_id) {
+    if (!engines_by_session) {
+      engines_by_session = g_hash_table_new(NULL, NULL);
+    }
+    g_hash_table_insert(engines_by_session,
+                        GSIZE_TO_POINTER(rime_engine->session_id),
+                        rime_engine);
+    ibus_rime_engine_load_switches(rime_engine);
+  }
+}
+
+static IBusProperty*
+ibus_rime_find_property (IBusPropList* props, const gchar* key)
+{
+  IBusProperty* prop;
+  for (guint i = 0; (prop = ibus_prop_list_get(props, i)) != NULL; ++i) {
+    if (!g_strcmp0(ibus_property_get_key(prop), key)) {
+      return prop;
+    }
+    IBusPropList* sub_props = ibus_property_get_sub_props(prop);
+    IBusProperty* found =
+        sub_props ? ibus_rime_find_property(sub_props, key) : NULL;
+    if (found) {
+      return found;
+    }
+  }
+  return NULL;
+}
+
+static void
+ibus_rime_free_states (gpointer states)
+{
+  g_strfreev(states);
+}
+
+// A switch's state labels, from its schema, kept on its property so that
+// option notifications can relabel it.
+static gchar**
+ibus_rime_switch_states (RimeConfig* config, size_t index)
+{
+  gchar* path = g_strdup_printf("switches/@%zu/states", index);
+  size_t count = rime_api->config_list_size(config, path);
+  g_free(path);
+  gchar** states = g_new0(gchar*, count + 1);
+  for (size_t i = 0; i < count; ++i) {
+    path = g_strdup_printf("switches/@%zu/states/@%zu", index, i);
+    const char* state = rime_api->config_get_cstring(config, path);
+    g_free(path);
+    states[i] = g_strdup(state ? state : "");
+  }
+  return states;
+}
+
+static IBusText*
+ibus_rime_state_label (gchar** states, guint state, const char* fallback)
+{
+  if (state < g_strv_length(states) && states[state][0]) {
+    return ibus_text_new_from_string(states[state]);
+  }
+  return ibus_text_new_from_string(fallback);
+}
+
+// Registers the schema's switches as properties after ibus-rime's own: a
+// switch of two states as a toggle keyed by its name, one of several
+// options as a menu of radio properties keyed by each option.
+static void
+ibus_rime_engine_load_switches (IBusRimeEngine *rime_engine)
+{
+  IBusPropList* props = ibus_prop_list_new();
+  g_object_ref_sink(props);
+  for (guint i = 0; i < IBUS_RIME_BASE_PROPERTIES; ++i) {
+    ibus_prop_list_append(props, ibus_prop_list_get(rime_engine->props, i));
+  }
+  g_object_unref(rime_engine->props);
+  rime_engine->props = props;
+
+  RIME_STRUCT(RimeStatus, status);
+  RimeConfig config = {0};
+  gboolean opened = FALSE;
+  if (rime_api->get_status(rime_engine->session_id, &status)) {
+    opened = status.schema_id &&
+             rime_api->schema_open(status.schema_id, &config);
+    rime_api->free_status(&status);
+  }
+  if (opened) {
+    size_t count = rime_api->config_list_size(&config, "switches");
+    for (size_t i = 0; i < count; ++i) {
+      gchar** states = ibus_rime_switch_states(&config, i);
+      gchar* path = g_strdup_printf("switches/@%zu/name", i);
+      const char* name = rime_api->config_get_cstring(&config, path);
+      g_free(path);
+      if (name) {
+        Bool on = rime_api->get_option(rime_engine->session_id, name);
+        gchar* key = g_strconcat(IBUS_RIME_OPTION_PREFIX, name, NULL);
+        IBusProperty* prop =
+            ibus_property_new(key,
+                              PROP_TYPE_TOGGLE,
+                              ibus_rime_state_label(states, on, name),
+                              NULL,
+                              NULL,
+                              TRUE,
+                              TRUE,
+                              on ? PROP_STATE_CHECKED : PROP_STATE_UNCHECKED,
+                              NULL);
+        g_free(key);
+        g_object_set_data_full(G_OBJECT(prop), "ibus-rime-states", states,
+                               ibus_rime_free_states);
+        ibus_prop_list_append(props, prop);
+        continue;
+      }
+
+      path = g_strdup_printf("switches/@%zu/options", i);
+      size_t n_options = rime_api->config_list_size(&config, path);
+      g_free(path);
+      if (n_options == 0) {
+        g_strfreev(states);
+        continue;
+      }
+      IBusPropList* options = ibus_prop_list_new();
+      IBusText* current = NULL;
+      for (size_t j = 0; j < n_options; ++j) {
+        path = g_strdup_printf("switches/@%zu/options/@%zu", i, j);
+        const char* option = rime_api->config_get_cstring(&config, path);
+        g_free(path);
+        if (!option) {
+          continue;
+        }
+        Bool on = rime_api->get_option(rime_engine->session_id, option);
+        gchar* key = g_strconcat(IBUS_RIME_OPTION_PREFIX, option, NULL);
+        IBusProperty* prop =
+            ibus_property_new(key,
+                              PROP_TYPE_RADIO,
+                              ibus_rime_state_label(states, j, option),
+                              NULL,
+                              NULL,
+                              TRUE,
+                              TRUE,
+                              on ? PROP_STATE_CHECKED : PROP_STATE_UNCHECKED,
+                              NULL);
+        g_free(key);
+        if (on || !current) {
+          current = ibus_property_get_label(prop);
+        }
+        ibus_prop_list_append(options, prop);
+      }
+      gchar* key = g_strdup_printf("rime:options:%zu", i);
+      IBusProperty* menu =
+          ibus_property_new(key,
+                            PROP_TYPE_MENU,
+                            ibus_text_new_from_string(
+                                current ? ibus_text_get_text(current) : ""),
+                            NULL,
+                            NULL,
+                            TRUE,
+                            TRUE,
+                            PROP_STATE_UNCHECKED,
+                            options);
+      g_free(key);
+      IBusProperty* option;
+      for (guint j = 0; (option = ibus_prop_list_get(options, j)) != NULL; ++j) {
+        g_object_set_data(G_OBJECT(option), "ibus-rime-menu", menu);
+      }
+      g_strfreev(states);
+      ibus_prop_list_append(props, menu);
+    }
+    rime_api->config_close(&config);
+  }
+  ibus_engine_register_properties((IBusEngine *)rime_engine, props);
+}
+
+void
+ibus_rime_engine_option_changed (RimeSessionId session_id, const char* option)
+{
+  IBusRimeEngine* rime_engine =
+      engines_by_session
+          ? g_hash_table_lookup(engines_by_session, GSIZE_TO_POINTER(session_id))
+          : NULL;
+  if (!rime_engine || !option) {
+    return;
+  }
+  gboolean on = option[0] != '!';
+  gchar* key = g_strconcat(IBUS_RIME_OPTION_PREFIX, on ? option : option + 1,
+                           NULL);
+  IBusProperty* prop = ibus_rime_find_property(rime_engine->props, key);
+  g_free(key);
+  if (!prop) {
+    return;
+  }
+  ibus_property_set_state(prop, on ? PROP_STATE_CHECKED : PROP_STATE_UNCHECKED);
+  gchar** states = g_object_get_data(G_OBJECT(prop), "ibus-rime-states");
+  if (states) {
+    ibus_property_set_label(
+        prop, ibus_rime_state_label(states, on, ibus_property_get_key(prop)));
+  }
+  ibus_engine_update_property((IBusEngine *)rime_engine, prop);
+
+  IBusProperty* menu = g_object_get_data(G_OBJECT(prop), "ibus-rime-menu");
+  if (menu && on) {
+    ibus_property_set_label(
+        menu, ibus_text_new_from_string(
+                  ibus_text_get_text(ibus_property_get_label(prop))));
+    ibus_engine_update_property((IBusEngine *)rime_engine, menu);
+  }
 }
 
 static void
@@ -181,6 +406,7 @@ ibus_rime_engine_constructed (GObject *object)
 static void
 ibus_rime_engine_destroy (IBusRimeEngine *rime_engine)
 {
+  ibus_rime_forget_session(rime_engine);
   if (rime_engine->session_id) {
     rime_api->destroy_session(rime_engine->session_id);
     rime_engine->session_id = 0;
@@ -247,6 +473,7 @@ static void
 ibus_rime_engine_disable (IBusEngine *engine)
 {
   IBusRimeEngine *rime_engine = (IBusRimeEngine *)engine;
+  ibus_rime_forget_session(rime_engine);
   if (rime_engine->session_id) {
     rime_api->destroy_session(rime_engine->session_id);
     rime_engine->session_id = 0;
@@ -598,6 +825,34 @@ static void ibus_rime_engine_property_activate (IBusEngine *engine,
         !rime_api->get_option(rime_engine->session_id, "ascii_mode"));
     ibus_rime_engine_update(rime_engine);
   }
+  else if (g_str_has_prefix(prop_name, IBUS_RIME_OPTION_PREFIX)) {
+    const char* option = prop_name + strlen(IBUS_RIME_OPTION_PREFIX);
+    IBusProperty* prop = ibus_rime_find_property(rime_engine->props, prop_name);
+    IBusProperty* menu =
+        prop ? g_object_get_data(G_OBJECT(prop), "ibus-rime-menu") : NULL;
+    if (menu) {
+      // Choosing one of a switch's options turns the others off.
+      if (prop_state == PROP_STATE_CHECKED) {
+        IBusPropList* options = ibus_property_get_sub_props(menu);
+        IBusProperty* other;
+        for (guint i = 0; (other = ibus_prop_list_get(options, i)) != NULL;
+             ++i) {
+          if (other != prop) {
+            rime_api->set_option(
+                rime_engine->session_id,
+                ibus_property_get_key(other) + strlen(IBUS_RIME_OPTION_PREFIX),
+                False);
+          }
+        }
+        rime_api->set_option(rime_engine->session_id, option, True);
+      }
+    }
+    else {
+      rime_api->set_option(rime_engine->session_id, option,
+                           prop_state == PROP_STATE_CHECKED);
+    }
+    ibus_rime_engine_update(rime_engine);
+  }
 }
 
 static void ibus_rime_engine_candidate_clicked (IBusEngine *engine,
diff --git a/rime_engine.h b/rime_engine.h
index 52d2df6..c73a68d 100644
--- a/rime_engine.h
+++ b/rime_engine.h
@@ -2,10 +2,16 @@
 #define __IBUS_RIME_ENGINE_H__
 
 #include <ibus.h>
+#include <rime_api.h>
 
 #define IBUS_TYPE_RIME_ENGINE \
         (ibus_rime_engine_get_type())
 
 GType ibus_rime_engine_get_type();
 
+// Reflects a Rime "option" notification, "<option>" or "!<option>", in the
+// property of the session's engine.
+void ibus_rime_engine_option_changed(RimeSessionId session_id,
+                                     const char* option);
+
 #endif
diff --git a/rime_main.c b/rime_main.c
index 2f7ab17..4b4cd41 100644
--- a/rime_main.c
+++ b/rime_main.c
@@ -59,6 +59,10 @@ static void notification_handler(void* context_object,
     }
     return;
   }
+  if (!strcmp(message_type, "option")) {
+    ibus_rime_engine_option_changed(session_id, message_value);
+    return;
+  }
 }
 
 static void fill_traits(RimeTraits *traits) {
```

In `REUSE.toml`, insert after the `engines/rime/**` annotation Task 2 added:

```toml
[[annotations]]
path = "engines/rime/patches/ibus-rime/**/*.patch"
SPDX-FileCopyrightText = ["The ibus-rime authors", "2026 Synapdeck, Inc."]
SPDX-License-Identifier = "GPL-3.0-or-later"

```

- [ ] **Step 2: Compile the engine in the overlay**

In `engines/rime/overlay.nix`, insert above `          ibus-web-boost-headers =`:

```nix
          # ibus-rime's engine, compiled with its CMake build's flags. Its
          # program, rime_main.c, connects to the bus, so the side module
          # takes only the engine and the settings it reads.
          ibus-engines = prev.ibus-engines // {
            rime = prev.ibus-engines.rime.overrideAttrs (old: {
              patches = (old.patches or [ ]) ++ patchesFor "ibus-rime";

              nativeBuildInputs = with final.buildPackages; [
                cmake
                pkg-config
              ];
              buildInputs = [
                final.libibus-web
                final.librime
              ];
              propagatedBuildInputs = [ ];

              # Rime's data directories are the module's traits; icons are
              # paths no page loads. Outside the store, neither makes the
              # module refer to this output.
              cmakeFlags = [
                "-DENABLE_LIBNOTIFY=OFF"
                "-DRIME_DATA_DIR=/usr/share/rime-data"
                "-DCMAKE_INSTALL_DATADIR=/usr/share"
              ];

              buildPhase = ''
                runHook preBuild
                # The flags as make holds them, quoted for the shell that runs
                # the compile command it writes.
                make -s -f CMakeFiles/ibus-engine-rime.dir/flags.make -f - print-cflags > cflags \
                  <<< 'print-cflags: ; $(info $(C_DEFINES) $(C_INCLUDES) $(C_FLAGS))@:'
                for source in rime_engine rime_settings; do
                  eval "$CC $(< cflags) -c ../$source.c -o $source.o"
                done
                runHook postBuild
              '';

              installPhase = ''
                runHook preInstall
                install -Dm644 -t $out/lib/ibus-rime rime_engine.o rime_settings.o cflags
                install -Dm644 -t $out/include/ibus-rime rime_config.h ../rime_engine.h ../rime_settings.h
                install -Dm644 -t $out/share/rime-data ../ibus_rime.yaml
                runHook postInstall
              '';

              postInstall = "";
              dontFixup = true;
            });
          };

```

Run:

```bash
nix develop -c git add engines/rime REUSE.toml
out=$(nix build --no-link --print-out-paths -L .#legacyPackages.x86_64-linux.pkgsWasm.ibus-engines.rime)
ls "$out"/lib/ibus-rime "$out"/include/ibus-rime "$out"/share/rime-data
cat "$out"/lib/ibus-rime/cflags
strings "$out"/lib/ibus-rime/rime_engine.o | grep -c /nix/store || true
```

Expected: `cflags rime_engine.o rime_settings.o`; `rime_config.h rime_engine.h rime_settings.h`; `ibus_rime.yaml`; flags beginning `-DRIME_DATA_DIR=\"/usr/share/rime-data\"` with libibus-web's and GLib's include directories; `0` store paths in the object (its icons directory is `/usr/share/ibus-rime/icons`). No libnotify or gdk-pixbuf is built or found.

- [ ] **Step 3: Write the failing audit**

In `engines/rime/cast-audit.nix`, insert after `      inherit (toolchain) pkgsWasm;`:

```nix
      ibus-rime = pkgsWasm.ibus-engines.rime;
```

and inside `audits = {`, after the `lua` audit:

```nix
        ibus-rime =
          (engines.castAudit {
            name = "rime-ibus-rime";
            inherit (ibus-rime) src;
            buildInputs = [
              pkgsWasm.libibus-web
              pkgsWasm.librime
            ];
            cflags = "$(< $TMPDIR/cflags)";
            sources = [
              "rime_engine.c"
              "rime_settings.c"
            ];
            allowList = ./cast-audit/ibus-rime.jsonc;
          }).overrideAttrs
            (old: {
              inherit (ibus-rime) patches;
              preBuild = ''
                eval "printf '%s\n' $(< ${ibus-rime}/lib/ibus-rime/cflags)" > $TMPDIR/cflags
                echo "-I${ibus-rime}/include/ibus-rime" >> $TMPDIR/cflags
              '';
            });
```

Create `engines/rime/cast-audit/ibus-rime.jsonc` with the same empty list as Task 2's.

Run: `nix develop -c git add engines/rime && nix build .#checks.x86_64-linux.rime-cast-audit -L`
Expected: FAIL in `ibus-web-rime-ibus-rime-cast-audit`, with

```
rime_engine.c:78: <expression>: void (*)(IBusRimeEngine *, gpointer) → GInstanceInitFunc
rime_engine.c:88: ibus_rime_engine_destroy: void (*)(IBusRimeEngine *) → IBusObjectDestroyFunc
```

The first is `G_DEFINE_TYPE`'s instance-init adapter; the second, destroy's assignment. WebAssembly checks an indirect call's type exactly, so both are fixed in the source rather than allowed.

- [ ] **Step 4: Write the casts patch**

Create `engines/rime/patches/ibus-rime/casts/0001-Use-the-declared-GObject-callback-types.patch`:

```diff
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Alexis Williams <alexis@typedr.at>
Date: Sun, 11 Oct 2026 14:29:17 -0700
Subject: [PATCH] Use the declared GObject callback types

WebAssembly traps on an indirect call through a function type that
differs from the callee's. GLib calls the class and instance
initializers as GClassInitFunc and GInstanceInitFunc, and
G_DEFINE_TYPE reaches the instance initializer through a cast, so the
type registers them itself with those types. IBusObject calls destroy as
IBusObjectDestroyFunc, whose parameter is an IBusObject pointer.
---
 rime_engine.c | 47 +++++++++++++++++++++++++++++++++++++++--------
 1 file changed, 39 insertions(+), 8 deletions(-)

diff --git a/rime_engine.c b/rime_engine.c
index e19aef8..3d79767 100644
--- a/rime_engine.c
+++ b/rime_engine.c
@@ -37,10 +37,12 @@ struct _IBusRimeEngineClass {
 };
 
 /* functions prototype */
-static void ibus_rime_engine_class_init (IBusRimeEngineClass *klass);
-static void ibus_rime_engine_init (IBusRimeEngine *rime_engine);
+static void ibus_rime_engine_class_init (gpointer g_class,
+                                         gpointer class_data);
+static void ibus_rime_engine_init (GTypeInstance *instance,
+                                   gpointer g_class);
 static void ibus_rime_engine_constructed (GObject *object);
-static void ibus_rime_engine_destroy (IBusRimeEngine *rime_engine);
+static void ibus_rime_engine_destroy (IBusObject *object);
 static gboolean ibus_rime_engine_process_key_event (IBusEngine *engine,
                                                     guint keyval,
                                                     guint keycode,
@@ -75,17 +77,44 @@ static void ibus_rime_engine_property_hide (IBusEngine *engine,
 
 static void ibus_rime_engine_update (IBusRimeEngine *rime_engine);
 
-G_DEFINE_TYPE (IBusRimeEngine, ibus_rime_engine, IBUS_TYPE_ENGINE)
+static gpointer ibus_rime_engine_parent_class = NULL;
+
+GType
+ibus_rime_engine_get_type ()
+{
+  static GType type = 0;
+  if (type == 0) {
+    static const GTypeInfo info = {
+      sizeof (IBusRimeEngineClass),
+      NULL,
+      NULL,
+      ibus_rime_engine_class_init,
+      NULL,
+      NULL,
+      sizeof (IBusRimeEngine),
+      0,
+      ibus_rime_engine_init,
+      NULL,
+    };
+    type = g_type_register_static (IBUS_TYPE_ENGINE,
+                                   "IBusRimeEngine",
+                                   &info,
+                                   0);
+  }
+  return type;
+}
 
 static void
-ibus_rime_engine_class_init (IBusRimeEngineClass *klass)
+ibus_rime_engine_class_init (gpointer g_class, gpointer class_data)
 {
+  IBusRimeEngineClass *klass = g_class;
+  ibus_rime_engine_parent_class = g_type_class_peek_parent (klass);
   GObjectClass *object_class = G_OBJECT_CLASS (klass);
   IBusObjectClass *ibus_object_class = IBUS_OBJECT_CLASS (klass);
   IBusEngineClass *engine_class = IBUS_ENGINE_CLASS (klass);
 
   object_class->constructed = ibus_rime_engine_constructed;
-  ibus_object_class->destroy = (IBusObjectDestroyFunc) ibus_rime_engine_destroy;
+  ibus_object_class->destroy = ibus_rime_engine_destroy;
 
   engine_class->process_key_event = ibus_rime_engine_process_key_event;
   engine_class->focus_in = ibus_rime_engine_focus_in;
@@ -342,8 +371,9 @@ ibus_rime_engine_option_changed (RimeSessionId session_id, const char* option)
 }
 
 static void
-ibus_rime_engine_init (IBusRimeEngine *rime_engine)
+ibus_rime_engine_init (GTypeInstance *instance, gpointer g_class)
 {
+  IBusRimeEngine *rime_engine = (IBusRimeEngine *)instance;
   RIME_STRUCT_INIT(RimeStatus, rime_engine->status);
   RIME_STRUCT_CLEAR(rime_engine->status);
 
@@ -404,8 +434,9 @@ ibus_rime_engine_constructed (GObject *object)
 }
 
 static void
-ibus_rime_engine_destroy (IBusRimeEngine *rime_engine)
+ibus_rime_engine_destroy (IBusObject *object)
 {
+  IBusRimeEngine *rime_engine = (IBusRimeEngine *)object;
   ibus_rime_forget_session(rime_engine);
   if (rime_engine->session_id) {
     rime_api->destroy_session(rime_engine->session_id);
```

- [ ] **Step 5: Run the audit to see it pass**

Run: `nix develop -c git add engines/rime && nix build .#checks.x86_64-linux.rime-cast-audit -L`
Expected: PASS, the ibus-rime audit empty.

- [ ] **Step 6: Update the patch inventory and the docs**

In `engines/rime/patches/README.md`, add to the table, after librime's rows:

```markdown
| ibus-rime port 0001 | Make libnotify optional (`ENABLE_LIBNOTIFY`). Without it, `rime_main.c` logs its deployment messages with `g_message`, and configuring needs no libnotify. |
| ibus-rime port 0002 | Select the schema an engine is named for: an engine named `rime:<schema_id>` makes its sessions in that schema, and one named `rime` keeps the user's. The name is a construct property, so the first session is made once the engine is constructed. |
| ibus-rime port 0003 | Register the schema's switches as properties, keyed `rime:option:<name>` (a toggle) or `rime:option:<option>` (a radio, in a menu keyed `rime:options:<index>`), labelled with the schema's state labels; follow Rime's option notifications and set options from `PropertyActivate`. |
| ibus-rime casts 0001 | Use the declared GObject callback types. WebAssembly traps on an indirect call through a function type that differs from the callee's: the type registers its class and instance initializers with `GClassInitFunc`'s and `GInstanceInitFunc`'s types rather than through `G_DEFINE_TYPE`'s cast, and destroy takes an `IBusObject`. |
```

replace `` `opencc/` is Apache-2.0, as OpenCC is; `librime/` is BSD-3-Clause, as librime is. `` with `` `opencc/` is Apache-2.0, as OpenCC is; `librime/` is BSD-3-Clause, as librime is; `ibus-rime/` is GPL-3.0-or-later, as ibus-rime is. ``, and append the paragraph:

```markdown
Every cast audit of the libraries, ibus-rime and the module is empty: the casts patch removes ibus-rime's two findings.
```

In `docs/rime.md`, insert above `## Checks`:

```markdown
### ibus-rime

`ibus-engines.rime` is configured with CMake, with its port patch 0001's `ENABLE_LIBNOTIFY` off, so the build needs no
libnotify, and its data and icon directories outside the store, so nothing built from it refers to its output. From the
configured tree, `rime_engine.c` and `rime_settings.c` compile with the flags CMake wrote for the program (read from its
`flags.make`); `rime_main.c`, which connects to the bus, isn't built. The package holds the two objects, their flags,
ibus-rime's headers and `ibus_rime.yaml`.
```

and in the `rime-cast-audit` row replace `MARISA and Lua` with `MARISA, Lua and ibus-rime`.

Run: `nix develop -c oxfmt docs/rime.md engines/rime/patches/README.md`

- [ ] **Step 7: Commit**

```bash
nix develop -c git add engines/rime REUSE.toml docs/rime.md
nix develop -c git commit -m "build(rime): compile ibus-rime's engine for WebAssembly" -- engines/rime REUSE.toml docs/rime.md
```

---

## Milestone B: the data

Tasks 5–6 deploy the data at build time and describe its engines. At the end of Task 6, `rime-descriptors` passes over the default build and a build of three schemas.

### Task 5: The build-time deployment

The merged data, `rime_deployer --build` over it under Node, and the split of its output into the common path and one path per dictionary.

**Files:**
- Create: `engines/rime/_schemas.nix`, `engines/rime/_data.nix`
- Modify: `engines/rime/overlay.nix`
- Docs: `docs/rime.md`

**Interfaces:**
- Consumes: `pkgsWasm.ibus-web-rime-tools` (Task 3), `pkgsWasm.ibus-engines.rime`'s `share/rime-data/ibus_rime.yaml` (Task 4), the build machine's `rime-data`, `rime-ice` and `opencc`.
- Produces: `pkgsWasm.rime-loengfan`; `pkgsWasm.ibus-web-rime-data`, an attribute set made by `callPackage` (so with `.override { schemas = [ … ]; }`): `schemas` (the shipped ids, in engine order), `source` (`ibus-web-rime-source`), `deployment` (`ibus-web-rime-deployment`, `$out/build`), `dicts` (dictionary name → `ibus-web-rime-dict-<name>`, each `$out/build/*.bin`), `common` (`ibus-web-rime-common`). Task 6 adds `descriptors`.

- [ ] **Step 1: Write the failing test**

Run: `nix build .#legacyPackages.x86_64-linux.pkgsWasm.ibus-web-rime-data.common`
Expected: FAIL: `attribute 'ibus-web-rime-data' missing`.

- [ ] **Step 2: Write the schema table**

Create `engines/rime/_schemas.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later

# Every schema the module can deploy: rime-data's, rime-loengfan's, and
# rime-ice's, which replace rime-data's of the same names. Each has an
# English gloss for its display name, the languages it types, the package it
# comes from, and the dictionary and dependencies its deployed config names,
# which the build needs before it deploys anything and checks against the
# deployed configs afterwards.
{
  array30 = {
    gloss = "Array 30";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "array30";
    dependencies = [
      "array30_wsymbols"
      "luna_quanpin"
    ];
    # Its wildcard lookup reads array30_query's dictionary, which its config
    # doesn't list as a dependency.
    undeclared = [ "array30_query" ];
  };
  array30_query = {
    # A helper with no punctuation, which Rime warns of when a session
    # opens it: a dependency, not an engine.
    engine = false;
    gloss = "Array 30, wildcard lookup";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "array30_query";
    dependencies = [ ];
  };
  array30_wsymbols = {
    # A helper with no punctuation, which Rime warns of when a session
    # opens it: a dependency, not an engine.
    engine = false;
    gloss = "Array 30, symbols";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "array30_wsymbols";
    dependencies = [ ];
  };
  bopomofo = {
    gloss = "Zhuyin";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "terra_pinyin";
    dependencies = [ "stroke" ];
  };
  bopomofo_express = {
    gloss = "Zhuyin, express";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "terra_pinyin";
    dependencies = [ "stroke" ];
  };
  bopomofo_tw = {
    gloss = "Zhuyin, Taiwan";
    languages = [ "zh-Hant-TW" ];
    from = "rime-data";
    dictionary = "terra_pinyin";
    dependencies = [ "stroke" ];
  };
  cangjie5 = {
    gloss = "Cangjie 5";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "cangjie5";
    dependencies = [ "luna_quanpin" ];
  };
  cangjie5_express = {
    gloss = "Cangjie 5, express";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "cangjie5";
    dependencies = [ "luna_quanpin" ];
  };
  combo_pinyin = {
    gloss = "Combo Pinyin";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  combo_pinyin_10 = {
    gloss = "Combo Pinyin, ten fingers";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  combo_pinyin_10_emacsen = {
    gloss = "Combo Pinyin, ten fingers, Emacs";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  combo_pinyin_8 = {
    gloss = "Combo Pinyin, eight fingers";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  combo_pinyin_8_emacsen = {
    gloss = "Combo Pinyin, eight fingers, Emacs";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  combo_pinyin_9 = {
    gloss = "Combo Pinyin, nine fingers";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  double_pinyin = {
    gloss = "Double Pinyin, Ziranma";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  double_pinyin_abc = {
    gloss = "Double Pinyin, Intelligent ABC";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  double_pinyin_flypy = {
    gloss = "Double Pinyin, Xiaohe";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  double_pinyin_jiajia = {
    gloss = "Double Pinyin, Pinyin Jiajia";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  double_pinyin_mspy = {
    gloss = "Double Pinyin, Microsoft";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  double_pinyin_pyjj = {
    gloss = "Double Pinyin, Pinyin Jiajia, traditional";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ "stroke" ];
  };
  double_pinyin_sogou = {
    gloss = "Double Pinyin, Sogou";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  double_pinyin_ziguang = {
    gloss = "Double Pinyin, Ziguang";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  hkcantonese = {
    gloss = "Cantonese, Hong Kong romanisation";
    languages = [ "yue" ];
    from = "rime-data";
    dictionary = "jyutping";
    dependencies = [ "luna_pinyin" ];
  };
  ipa_xsampa = {
    gloss = "IPA, X-SAMPA";
    languages = [ "und-fonipa" ];
    from = "rime-data";
    dictionary = "ipa_xsampa";
    dependencies = [ ];
  };
  ipa_yunlong = {
    gloss = "IPA, Yunlong";
    languages = [ "und-fonipa" ];
    from = "rime-data";
    dictionary = "ipa_yunlong";
    dependencies = [ ];
  };
  jyut6ping3 = {
    gloss = "Cantonese, Jyutping";
    languages = [ "yue" ];
    from = "rime-data";
    dictionary = "jyut6ping3";
    dependencies = [
      "luna_pinyin"
      "loengfan"
      "stroke"
      "cangjie5"
    ];
  };
  jyut6ping3_ipa = {
    gloss = "Cantonese, Jyutping with IPA";
    languages = [ "yue" ];
    from = "rime-data";
    dictionary = "jyut6ping3";
    dependencies = [
      "luna_pinyin"
      "loengfan"
      "stroke"
      "cangjie5"
    ];
  };
  jyutping = {
    gloss = "Cantonese, Jyutping without tones";
    languages = [ "yue" ];
    from = "rime-data";
    dictionary = "jyutping";
    dependencies = [
      "luna_pinyin"
      "stroke"
      "cangjie5"
    ];
  };
  loengfan = {
    # A dependency, not an engine.
    engine = false;
    gloss = "Cantonese, by two parts";
    languages = [ "yue" ];
    from = "rime-loengfan";
    dictionary = "loengfan";
    dependencies = [ "cangjie5" ];
  };
  luna_pinyin = {
    gloss = "Pinyin, traditional";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ "stroke" ];
  };
  luna_pinyin_fluency = {
    gloss = "Pinyin, traditional, sentences";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ "stroke" ];
  };
  luna_pinyin_simp = {
    gloss = "Pinyin, simplified characters";
    languages = [ "zh-Hans" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ "stroke" ];
  };
  luna_pinyin_tw = {
    gloss = "Pinyin, Taiwan";
    languages = [ "zh-Hant-TW" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ "stroke" ];
  };
  luna_quanpin = {
    gloss = "Pinyin, full";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ "stroke" ];
  };
  melt_eng = {
    # A dependency, not an engine.
    engine = false;
    gloss = "English";
    languages = [ "en" ];
    from = "rime-ice";
    dictionary = "melt_eng";
    dependencies = [ ];
  };
  pinyin_simp = {
    gloss = "Pinyin, simplified, compact";
    languages = [ "zh-Hans" ];
    from = "rime-data";
    dictionary = "pinyin_simp";
    dependencies = [ "stroke" ];
  };
  quick5 = {
    gloss = "Quick";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "quick5";
    dependencies = [ "luna_quanpin" ];
  };
  radical_pinyin = {
    # A dependency, not an engine.
    engine = false;
    gloss = "Character components";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "radical_pinyin";
    dependencies = [ ];
  };
  rime_ice = {
    gloss = "Pinyin, simplified";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  sampheng = {
    gloss = "Middle Chinese, three-part";
    languages = [ "ltc" ];
    from = "rime-data";
    dictionary = "zyenpheng";
    dependencies = [ "luna_pinyin" ];
  };
  scj6 = {
    gloss = "Quick Cangjie 6";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "scj6";
    dependencies = [ "luna_quanpin" ];
  };
  soutzoe = {
    gloss = "Wu, Suzhou";
    languages = [ "wuu" ];
    from = "rime-data";
    dictionary = "soutzoe";
    dependencies = [ "luna_pinyin" ];
  };
  stenotype = {
    gloss = "Stenotype";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  stroke = {
    gloss = "Strokes";
    languages = [ "zh" ];
    from = "rime-data";
    dictionary = "stroke";
    dependencies = [ "luna_pinyin" ];
  };
  terra_pinyin = {
    gloss = "Pinyin with tones";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "terra_pinyin";
    dependencies = [ "stroke" ];
  };
  wubi86 = {
    gloss = "Wubi 86";
    languages = [ "zh-Hans" ];
    from = "rime-data";
    dictionary = "wubi86";
    dependencies = [ "pinyin_simp" ];
  };
  wubi_pinyin = {
    gloss = "Wubi 86 and Pinyin";
    languages = [ "zh-Hans" ];
    from = "rime-data";
    dictionary = "wubi86";
    dependencies = [ "pinyin_simp" ];
  };
  wubi_trad = {
    gloss = "Wubi 86, traditional output";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "wubi86";
    dependencies = [ "pinyin_simp" ];
  };
  wugniu = {
    gloss = "Wu, Shanghai";
    languages = [ "wuu" ];
    from = "rime-data";
    dictionary = "wugniu_lopha";
    dependencies = [ "luna_pinyin" ];
  };
  wugniu_lopha = {
    gloss = "Wu, Shanghai, Lopha";
    languages = [ "wuu" ];
    from = "rime-data";
    dictionary = "wugniu_lopha";
    dependencies = [ "luna_pinyin" ];
  };
  yale = {
    gloss = "Cantonese, Yale";
    languages = [ "yue" ];
    from = "rime-data";
    dictionary = "jyutping";
    dependencies = [ "luna_pinyin" ];
  };
  zyenpheng = {
    gloss = "Middle Chinese";
    languages = [ "ltc" ];
    from = "rime-data";
    dictionary = "zyenpheng";
    dependencies = [ "luna_pinyin" ];
  };
}
```

Its entries were read from a native deployment of every schema (nixpkgs' `librime` and `rime_deployer`), from each compiled config's `schema/name`, `schema/dependencies` and `translator/dictionary`; Task 6's step checks them against the WebAssembly deployment on every build.

- [ ] **Step 3: Write the data recipe**

Create `engines/rime/_data.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  lib,
  runCommand,
  writeText,
  nodejs,
  ibus-engines,
  ibus-web-rime-tools,
  rime-data,
  rime-ice,
  rime-loengfan,
  opencc-data,
  # The schemas to deploy and register as engines; their dependencies
  # deploy whether listed or not.
  schemas ? null,
}:
let
  table = import ./_schemas.nix;

  # The mainstream schemas, in the order the engines are listed, rime_ice
  # first, then every other engine, by id.
  mainstream = [
    "rime_ice"
    "double_pinyin"
    "double_pinyin_flypy"
    "double_pinyin_mspy"
    "double_pinyin_sogou"
    "double_pinyin_ziguang"
    "double_pinyin_abc"
    "double_pinyin_jiajia"
    "luna_pinyin"
    "terra_pinyin"
    "bopomofo"
    "cangjie5"
    "quick5"
    "wubi86"
    "stroke"
    "jyut6ping3"
    "wugniu"
  ];
  everySchema =
    mainstream
    ++ lib.filter (id: !lib.elem id mainstream && table.${id}.engine or true) (lib.attrNames table);

  shipped =
    let
      listed = if schemas == null then everySchema else schemas;
      unknown = lib.filter (id: !table ? ${id}) listed;
    in
    assert lib.assertMsg (unknown == [ ]) "rime: no such schema: ${toString unknown}";
    assert lib.assertMsg (lib.unique listed == listed) "rime: a schema is listed twice";
    listed;

  # The shipped schemas and, transitively, the schemas they depend on,
  # which the deployment compiles too.
  deployed = map (entry: entry.key) (
    builtins.genericClosure {
      startSet = map (id: { key = id; }) shipped;
      operator =
        entry:
        map (id: { key = id; }) (table.${entry.key}.dependencies ++ table.${entry.key}.undeclared or [ ]);
    }
  );

  dictionaryNames = lib.unique (map (id: table.${id}.dictionary) deployed);

  # rime-data, then rime-loengfan, then rime-ice, whose double_pinyin*
  # replace rime-data's of the same names, with ibus-rime's own
  # configuration and a default.yaml listing every schema to deploy: Rime
  # compiles a schema's declared dependencies on its own, but not the rest.
  source = runCommand "ibus-web-rime-source" { } ''
    mkdir $out
    cp -r ${rime-data}/share/rime-data/. $out/
    chmod -R u+w $out
    cp -r ${rime-loengfan}/share/rime-data/. $out/
    chmod -R u+w $out
    cp -r ${rime-ice}/share/rime-data/. $out/
    chmod -R u+w $out
    rm -r $out/build $out/AGENTS.md
    cp ${ibus-engines.rime}/share/rime-data/ibus_rime.yaml $out/

    awk -v list=${lib.escapeShellArg (toString deployed)} '
      /^schema_list:/ {
        print
        n = split(list, ids, " ")
        for (i = 1; i <= n; i++) print "  - schema: " ids[i]
        skipping = 1
        next
      }
      skipping && /^  - / { next }
      { skipping = 0; print }
    ' ${rime-data}/share/rime-data/default.yaml > $out/default.yaml
  '';

  # rime_deployer, built for WebAssembly from the librime that reads its
  # output. Building rime_ice's table peaks near 900 MB.
  deployment = runCommand "ibus-web-rime-deployment" { nativeBuildInputs = [ nodejs ]; } ''
    node ${ibus-web-rime-tools}/rime_deployer.js --build "$TMPDIR/user" ${source} $out/build
    rm -f $out/build/user.yaml
  '';

  # A dictionary's tables and the prisms of the schemas that read it.
  dictionaryFiles =
    name:
    [
      "${name}.table.bin"
      "${name}.reverse.bin"
    ]
    ++ map (id: "${id}.prism.bin") (lib.filter (id: table.${id}.dictionary == name) deployed);

  dicts = lib.genAttrs dictionaryNames (
    name:
    runCommand "ibus-web-rime-dict-${name}" { } ''
      mkdir -p $out/build
      for file in ${lib.escapeShellArgs (dictionaryFiles name)}; do
        if [ -e ${deployment}/build/$file ]; then
          cp ${deployment}/build/$file $out/build/
        fi
      done
    ''
  );

  # Rime's shared data directory: the deployment's configs, and links to the
  # dictionaries' compiled tables beside them, which Rime takes for its
  # prebuilt data; the configuration sources, symbols, Lua scripts and
  # OpenCC's data; and no dictionary source.
  common = runCommand "ibus-web-rime-common" { } ''
    mkdir $out
    cp -r ${source}/. $out/
    chmod -R u+w $out
    rm -r $out/*.dict.yaml $out/cn_dicts $out/en_dicts $out/essay*.txt
    cp -rn ${opencc-data}/share/opencc/. $out/opencc/

    mkdir $out/build
    cp ${deployment}/build/*.yaml $out/build/
    ${lib.concatMapStrings (name: ''
      for file in ${dicts.${name}}/build/*; do
        ln -s "$file" $out/build/
      done
    '') dictionaryNames}

    for file in ${deployment}/build/*.bin; do
      if [ ! -L $out/build/$(basename "$file") ]; then
        echo "no dictionary holds $(basename "$file")" >&2
        exit 1
      fi
    done
  '';
in
{
  schemas = shipped;
  inherit
    source
    deployment
    dicts
    common
    ;
}
```

In `engines/rime/overlay.nix`, insert above `          ibus-web-boost-headers =`:

```nix
          # The data and its deployment, with the descriptors made from it.
          ibus-web-rime-data = final.callPackage ./_data.nix {
            inherit (config.ibusWeb.typescript) nodejs;
            inherit (pkgs) rime-data rime-ice;
            opencc-data = pkgs.opencc;
          };

          # CanCLID's loengfan, which rime-data's jyut6ping3 looks characters
          # up by, at the revision Debian's and Arch's packages ship.
          rime-loengfan = pkgs.stdenvNoCC.mkDerivation {
            pname = "rime-loengfan";
            version = "0-unstable-2022-03-03";
            src = pkgs.fetchFromGitHub {
              owner = "CanCLID";
              repo = "rime-loengfan";
              rev = "987ac95b02f957e8764a2f45222a4006c188ed50";
              hash = "sha256-vOqVSwKZ+p5Wc03pRUWxCdWBdxuTe8n4xu2BTbj9/b4=";
            };
            installPhase = ''
              runHook preInstall
              install -Dm644 -t $out/share/rime-data loengfan.schema.yaml loengfan.dict.yaml
              install -Dm644 -t $out/share/doc/rime-loengfan LICENSE
              runHook postInstall
            '';
            meta.license = lib.licenses.cc-by-40;
          };

```

- [ ] **Step 4: Build and inspect the data**

Run:

```bash
nix develop -c git add engines/rime
nix eval --json .#legacyPackages.x86_64-linux.pkgsWasm.ibus-web-rime-data.schemas --apply builtins.length
nix eval --json .#legacyPackages.x86_64-linux.pkgsWasm.ibus-web-rime-data.dicts --apply builtins.attrNames
common=$(nix build --no-link --print-out-paths -L .#legacyPackages.x86_64-linux.pkgsWasm.ibus-web-rime-data.common)
source=$(nix build --no-link --print-out-paths .#legacyPackages.x86_64-linux.pkgsWasm.ibus-web-rime-data.source)
grep -c '  - schema:' "$source"/default.yaml
ls "$common"/build/*.yaml | wc -l
find "$common"/build -type l | wc -l
find -L "$common"/build -type l | wc -l
ls "$common" | grep -c '\.dict\.yaml$' || true
ls "$common"/opencc | wc -l
readlink "$common"/build/rime_ice.table.bin
nix build --rebuild "$(nix eval --raw .#legacyPackages.x86_64-linux.pkgsWasm.ibus-web-rime-data.deployment.drvPath)^*"
```

Expected: `47`; the 22 dictionaries `[ "array30" "array30_query" "array30_wsymbols" "cangjie5" "ipa_xsampa" "ipa_yunlong" "jyut6ping3" "jyutping" "loengfan" "luna_pinyin" "melt_eng" "pinyin_simp" "quick5" "radical_pinyin" "rime_ice" "scj6" "soutzoe" "stroke" "terra_pinyin" "wubi86" "wugniu_lopha" "zyenpheng" ]`; `52` schemas listed (the 47 and five dependencies); `53` compiled YAML files (each schema's and `default.yaml`); `89` links, none dangling (`0`); no dictionary source (`0`); `45` OpenCC files; a link into `…-ibus-web-rime-dict-rime_ice/build/rime_ice.table.bin`; and the deployment rebuilt to the same bytes (no `differs` error). The deployment takes about 35 s.

- [ ] **Step 5: Update the docs**

In `docs/rime.md`, insert above `## Checks`:

```markdown
## Deployment

`engines/rime/_data.nix` deploys the data at build time; `_package.nix` builds the module over it. Both take `schemas`,
the schema ids to ship.

- **The source** (`ibus-web-rime-source`) is `rime-data`'s `share/rime-data`, then `rime-loengfan`'s, then `rime-ice`'s,
  whose `double_pinyin*` replace `rime-data`'s, with ibus-rime's `ibus_rime.yaml` and a `default.yaml`, `rime-data`'s
  with its `schema_list` replaced by every schema to deploy: the shipped ones and, transitively, their dependencies, of
  which `rime_deployer` compiles only the declared ones itself. `rime-loengfan` is CanCLID's `loengfan`, at the revision
  Debian's and Arch's packages ship, which `jyut6ping3` names as a dependency and `rime-data` lacks.
- **The deployment** (`ibus-web-rime-deployment`) is `rime_deployer --build`, the WebAssembly program under Node, over
  the source: every compiled config, table, reverse lookup and prism, from the same librime that reads them.
- **One path per dictionary** (`ibus-web-rime-dict-<name>`) holds `build/<name>.table.bin`, `build/<name>.reverse.bin`
  and the `build/<schema>.prism.bin` of each deployed schema whose dictionary it is.
- **The common path** (`ibus-web-rime-common`) is Rime's shared data directory: the source without its dictionary
  sources (`*.dict.yaml`, `cn_dicts/`, `en_dicts/`, `essay*.txt`), with OpenCC's data under `opencc/` beside the
  schemas' own, and `build/`, Rime's prebuilt data, holding the compiled configs and an absolute symbolic link to each
  table and prism. Its build fails if a compiled table has no dictionary.

A deployment at runtime, which settings changes cause, finds the prebuilt tables through those links and reuses them
without their sources; it rebuilds the prisms of the schemas whose compiled config changed, in the user's `build/`.
Deploying every schema takes about 35 s under Node and peaks near 900 MB; its output is reproducible
(`nix build --rebuild` finds the same bytes).
```

Run: `nix develop -c oxfmt docs/rime.md`

- [ ] **Step 6: Commit**

```bash
nix develop -c git add engines/rime docs/rime.md
nix develop -c git commit -m "build(rime): deploy Rime's data at build time" -- engines/rime docs/rime.md
```

---

### Task 6: The descriptor program and `@ibus-web/rime-descriptors`

A WebAssembly program that reads every deployed config through librime and prints it as JSON, and a TypeScript step that checks it against the schema table and writes the module's descriptors, settings files and C tables.

**Files:**
- Create: `engines/rime/descriptors/descriptors.cc`, `descriptors.ts`, `descriptors.test.ts`, `outputs.test.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `checks.nix`
- Modify: `engines/rime/_data.nix`, `engines/rime/overlay.nix`, `modules/typescript/files.nix`, `pnpm-workspace.yaml` (generated), `pnpm-lock.yaml`
- Docs: `docs/rime.md`

**Interfaces:**
- Consumes: `pkgsWasm.librime` (Task 3); `ibus-web-rime-data`'s `source`, `deployment`, `dicts` (Task 5).
- Produces: `pkgsWasm.ibus-web-rime-descriptor-program` (`descriptors.{js,wasm}`; `node descriptors.js SHARED_DATA_DIR PREBUILT_DATA_DIR` prints a JSON array of `{ id, name, dictionary, dependencies, switches: [{ name, options, states }], algebra }`); `ibus-web-rime-data.descriptors` (`ibus-web-rime-descriptors`: `engines.json`, `engine-data.json`, `settings-paths.json`, `settings-schemas.json`, `instances.txt`, `rime-tables.h`, `raw.json`); the private workspace package `@ibus-web/rime-descriptors`; `checks.rime-descriptors`.

- [ ] **Step 1: Write the failing tests**

Create `engines/rime/descriptors/package.json`:

```json
{
  "name": "@ibus-web/rime-descriptors",
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

Create `engines/rime/descriptors/tsconfig.json`:

```jsonc
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later
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

Create `engines/rime/descriptors/vitest.config.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "vitest/config";

// A Nix build's tree is read-only, so checks point Vite's cache elsewhere.
const cacheDir = process.env["IBUS_WEB_TEST_CACHE_DIR"];

export default defineConfig({
  ...(cacheDir === undefined ? {} : { cacheDir }),
  test: { include: ["*.test.ts"] },
});
```

Create `engines/rime/descriptors/descriptors.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, test } from "vitest";
import {
  closure,
  deployed,
  engineData,
  engineDescriptor,
  generate,
  header,
  instances,
  type Plan,
  type RawSchema,
  settingSwitchesOf,
  type TableEntry,
} from "./descriptors.ts";

const raw = (id: string, overrides: Partial<RawSchema> = {}): RawSchema => ({
  id,
  name: id.toUpperCase(),
  dictionary: id,
  dependencies: [],
  switches: [],
  algebra: [],
  ...overrides,
});

const entry = (overrides: Partial<TableEntry> = {}): TableEntry => ({
  gloss: "Gloss",
  languages: ["zh-Hans"],
  from: "rime-data",
  dictionary: "",
  dependencies: [],
  ...overrides,
});

const toggle = (name: string) => ({ name, options: [], states: ["off", "on"] });

const ice = raw("rime_ice", {
  name: "雾凇拼音",
  dependencies: ["melt_eng", "radical_pinyin"],
  switches: [toggle("ascii_mode"), toggle("ascii_punct"), toggle("traditionalization"), toggle("full_shape")],
  algebra: ["erase/^hm$/", 'xform/"/\\\\/'],
});
const melt = raw("melt_eng");
const radical = raw("radical_pinyin");
const luna = raw("luna_pinyin", {
  name: "朙月拼音",
  dependencies: ["stroke"],
  switches: [toggle("ascii_mode"), toggle("full_shape"), toggle("simplification")],
});
const stroke = raw("stroke", { dependencies: ["luna_pinyin"] });
const jyut = raw("jyut6ping3", {
  dependencies: ["luna_pinyin", "stroke"],
  switches: [
    toggle("ascii_mode"),
    { name: "", options: ["noop", "variants_hk", "simplification"], states: ["a", "b", "c"] },
  ],
});
const array = raw("array30", { dependencies: [] });
const query = raw("array30_query");

const all = [ice, melt, radical, luna, stroke, jyut, array, query];

const plan = (schemas: string[], overrides: Partial<Plan> = {}): Plan => ({
  schemas,
  table: Object.fromEntries(
    all.map((schema) => [
      schema.id,
      entry({
        dictionary: schema.dictionary,
        dependencies: schema.dependencies,
        from:
          schema.id === "rime_ice" || schema.id === "melt_eng" || schema.id === "radical_pinyin"
            ? "rime-ice"
            : "rime-data",
        ...(schema.id === "array30" ? { undeclared: ["array30_query"] } : {}),
      }),
    ]),
  ),
  dictionaries: Object.fromEntries(all.map((schema) => [schema.dictionary, `/nix/store/${schema.dictionary}`])),
  ...overrides,
});

describe("the table", () => {
  test("must agree with the deployed configs", () => {
    expect(deployed(all, plan([])).size).toBe(all.length);
    const wrong = plan([]);
    wrong.table["luna_pinyin"] = entry({ dictionary: "terra_pinyin", dependencies: ["stroke"] });
    expect(() => deployed(all, wrong)).toThrow(
      "luna_pinyin: the table's dictionary is terra_pinyin, the deployed config's luna_pinyin",
    );
    wrong.table["luna_pinyin"] = entry({ dictionary: "luna_pinyin", dependencies: [] });
    expect(() => deployed(all, wrong)).toThrow(
      "luna_pinyin: the table's dependencies are [], the deployed config's [stroke]",
    );
    const missing = plan([]);
    delete missing.table["stroke"];
    expect(() => deployed(all, missing)).toThrow("stroke: deployed but not in the table");
  });
});

describe("dependencies", () => {
  const schemas = deployed(all, plan([]));

  test("resolve transitively, each once, the schema first", () => {
    expect(closure("jyut6ping3", schemas).map((schema) => schema.id)).toEqual(["jyut6ping3", "luna_pinyin", "stroke"]);
  });

  test("include what a schema needs without declaring it", () => {
    expect(closure("array30", schemas, { array30: ["array30_query"] }).map((schema) => schema.id)).toEqual([
      "array30",
      "array30_query",
    ]);
  });

  test("fail when one isn't deployed", () => {
    expect(() => closure("rime_ice", deployed([ice, melt], plan([])))).toThrow(
      "rime_ice: depends on radical_pinyin, which isn't deployed",
    );
  });

  test("become the engine's dictionaries' store paths", () => {
    expect(engineData("rime_ice", schemas, plan([]))).toEqual([
      "/nix/store/rime_ice",
      "/nix/store/melt_eng",
      "/nix/store/radical_pinyin",
    ]);
    expect(engineData("array30", schemas, plan([]))).toEqual(["/nix/store/array30", "/nix/store/array30_query"]);
  });
});

describe("descriptors", () => {
  test("name the schema and gloss it, typing on the US layout", () => {
    expect(engineDescriptor(ice, entry({ gloss: "Pinyin, simplified" }))).toEqual({
      name: "rime:rime_ice",
      displayName: "雾凇拼音 (Pinyin, simplified)",
      languages: ["zh-Hans"],
      keyboard: { layout: "us", passThrough: [] },
    });
  });

  test("fail without a gloss", () => {
    expect(() => engineDescriptor(ice, entry({ gloss: "" }))).toThrow("rime_ice: no gloss");
  });

  test("keep the order the schemas are listed in, and fail for one not deployed", () => {
    expect(generate(all, plan(["rime_ice", "luna_pinyin", "jyut6ping3"])).engines.map((e) => e.name)).toEqual([
      "rime:rime_ice",
      "rime:luna_pinyin",
      "rime:jyut6ping3",
    ]);
    expect(() => generate(all, plan(["rime_ice", "wubi86"]))).toThrow("wubi86: isn't deployed");
    expect(() => generate(all, plan(["rime_ice", "rime_ice"]))).toThrow("a schema is listed twice");
  });
});

describe("the module's tables", () => {
  test("find the switches the settings set, by index, and an option in a group", () => {
    expect(settingSwitchesOf(ice)).toEqual([
      { schema: "rime_ice", name: "ascii_punct", index: 1, option: -1 },
      { schema: "rime_ice", name: "traditionalization", index: 2, option: -1 },
      { schema: "rime_ice", name: "full_shape", index: 3, option: -1 },
    ]);
    expect(settingSwitchesOf(jyut)).toEqual([{ schema: "jyut6ping3", name: "simplification", index: 1, option: 2 }]);
  });

  test("give the schemas, switches and rime-ice's algebra as C", () => {
    const text = header([ice, luna], plan([]));
    expect(text).toContain('#define IBUSWEB_RIME_SCHEMAS(X) \\\n  X("rime_ice") \\\n  X("luna_pinyin")\n');
    expect(text).toContain('  X("luna_pinyin", "simplification", 2, -1)');
    expect(text).toContain('  X("rime_ice", "erase/^hm$/") \\\n  X("rime_ice", "xform/\\"/\\\\\\\\/")\n');
    const algebra = text.slice(text.indexOf("#define IBUSWEB_RIME_ALGEBRA"));
    expect(algebra).not.toContain("luna_pinyin");
  });

  test("refuse a control character", () => {
    expect(() => header([raw("x\u0001")], plan([]))).toThrow("control character");
  });
});

test("instances list the fixed schemas, then each engine's path", () => {
  expect(instances(generate(all, plan(["rime_ice", "luna_pinyin"])))).toBe(
    [
      "org.freedesktop.ibus.engine.rime",
      "org.freedesktop.ibus.panel",
      "org.freedesktop.ibus.engine.rime.schema=/org/freedesktop/ibus/engine/rime/rime_ice/",
      "org.freedesktop.ibus.engine.rime.schema=/org/freedesktop/ibus/engine/rime/luna_pinyin/",
      "",
    ].join("\n"),
  );
});
```

Create `engines/rime/descriptors/outputs.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { EngineDescriptor } from "./descriptors.ts";

const read = (directory: string, name: string) => readFileSync(join(directory, name), "utf8");

const builds = {
  every: process.env["IBUS_WEB_RIME_DESCRIPTORS"],
  fewer: process.env["IBUS_WEB_RIME_DESCRIPTORS_FEWER"],
};
for (const [build, directory] of Object.entries(builds))
  if (!directory) throw new Error(`the ${build} build's descriptors are required`);

const every = builds.every!;
const fewer = builds.fewer!;

describe("the default build", () => {
  const engines: EngineDescriptor[] = JSON.parse(read(every, "engines.json"));
  const data: Record<string, string[]> = JSON.parse(read(every, "engine-data.json"));

  test("lists every schema's engine, the mainstream ones first", () => {
    expect(engines).toHaveLength(47);
    expect(engines.slice(0, 3).map((engine) => engine.name)).toEqual([
      "rime:rime_ice",
      "rime:double_pinyin",
      "rime:double_pinyin_flypy",
    ]);
    expect(engines[16]!.name).toBe("rime:wugniu");
    expect(engines[17]!.name).toBe("rime:array30");
    expect(engines[0]).toEqual({
      name: "rime:rime_ice",
      displayName: "雾凇拼音 (Pinyin, simplified)",
      languages: ["zh-Hans"],
      keyboard: { layout: "us", passThrough: [] },
    });
    for (const name of ["rime:loengfan", "rime:melt_eng", "rime:radical_pinyin", "rime:array30_query", "rime:t9"])
      expect(engines.map((engine) => engine.name)).not.toContain(name);
  });

  test("gives each engine its dictionaries and its dependencies'", () => {
    const names = (engine: string) =>
      data[engine]!.map((path) => path.replace(/^\/nix\/store\/[0-9a-z]{32}-ibus-web-rime-dict-/, ""));
    expect(names("rime:rime_ice")).toEqual(["rime_ice", "melt_eng", "radical_pinyin"]);
    expect(names("rime:cangjie5")).toEqual(["cangjie5", "luna_pinyin", "stroke"]);
    expect(names("rime:jyut6ping3")).toEqual(["jyut6ping3", "luna_pinyin", "stroke", "loengfan", "cangjie5"]);
    expect(names("rime:array30")).toEqual(["array30", "array30_wsymbols", "luna_pinyin", "stroke", "array30_query"]);
  });
});

test("a build with fewer schemas lists only those, with the dependencies' data", () => {
  const engines: EngineDescriptor[] = JSON.parse(read(fewer, "engines.json"));
  expect(engines.map((engine) => engine.name)).toEqual(["rime:rime_ice", "rime:luna_pinyin", "rime:jyut6ping3"]);
  const data: Record<string, string[]> = JSON.parse(read(fewer, "engine-data.json"));
  expect(Object.keys(data)).toEqual(["rime:rime_ice", "rime:luna_pinyin", "rime:jyut6ping3"]);
  expect(read(fewer, "rime-tables.h")).toContain(
    '#define IBUSWEB_RIME_SCHEMAS(X) \\\n  X("rime_ice") \\\n  X("luna_pinyin") \\\n  X("jyut6ping3")\n',
  );
});
```

Create `engines/rime/descriptors/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing toolchain typescript;
      data = toolchain.pkgsWasm.ibus-web-rime-data;
      fewer = data.override {
        schemas = [
          "rime_ice"
          "luna_pinyin"
          "jyut6ping3"
        ];
      };
    in
    {
      checks.rime-descriptors = testing.vitestCheck {
        name = "rime-descriptors";
        packageDir = "${typescript.workspaceFor [ "engines/rime/descriptors" ]}/engines/rime/descriptors";
        env = {
          IBUS_WEB_RIME_DESCRIPTORS = data.descriptors;
          IBUS_WEB_RIME_DESCRIPTORS_FEWER = fewer.descriptors;
        };
        inBrowsers = false;
        limit = 60;
      };
    };
}
```

In `modules/typescript/files.nix`, add `"engines/rime/descriptors"` to the workspace's package list after `"engines/m17n/descriptors"`.

`nix run .#write-files` builds the workspace, and the workspace's install refuses a package its lockfile doesn't list (`ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`), so the lockfile comes first, from the generated file's one new line. In `pnpm-workspace.yaml`, add `  - engines/rime/descriptors` after `  - engines/m17n/descriptors`, then run:

```bash
nix shell --inputs-from . nixpkgs#pnpm nixpkgs#nodejs -c pnpm install --lockfile-only
nix develop -c git add engines/rime modules/typescript/files.nix pnpm-workspace.yaml pnpm-lock.yaml
nix run .#write-files
git status --short pnpm-workspace.yaml
```

Expected: pnpm adds the `engines/rime/descriptors` importer (12 lines, the same devDependencies as `engines/m17n/descriptors`); `write-files` leaves `pnpm-workspace.yaml` as written (no `M` in `git status`). If the workspace build stops with a hash mismatch for `pnpmDeps`, set `hash` in `modules/typescript/workspace.nix`'s `pnpmDeps` to the value it reports, `git add` it, and build again (in the spike it didn't change).

Run: `nix build .#checks.x86_64-linux.rime-descriptors -L`
Expected: FAIL: evaluation stops on `attribute 'descriptors' missing` (`ibus-web-rime-data` has none yet).

- [ ] **Step 2: Write the descriptor program**

Create `engines/rime/descriptors/descriptors.cc`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later

// Prints, as JSON, every schema a deployment compiled: its id, name,
// dictionary and dependencies, its switches with their states' labels and
// its spelling algebra, read from the deployed configs through librime.
//
// descriptors SHARED_DATA_DIR PREBUILT_DATA_DIR

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <string>
#include <vector>

#include <emscripten/wasmfs.h>
#include <rime_api.h>
#include <sys/stat.h>

namespace {

RimeApi *rime;

std::string Quote(const std::string &text) {
  std::string quoted = "\"";
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') {
      quoted += '\\';
      quoted += static_cast<char>(c);
    } else if (c < 0x20) {
      char escape[7];
      std::snprintf(escape, sizeof escape, "\\u%04x", c);
      quoted += escape;
    } else {
      quoted += static_cast<char>(c);
    }
  }
  return quoted + "\"";
}

std::string String(RimeConfig *config, const std::string &key) {
  const char *value = rime->config_get_cstring(config, key.c_str());
  return value != nullptr ? value : "";
}

// A list of strings as JSON, or [] when key isn't a list.
std::string Strings(RimeConfig *config, const std::string &key) {
  std::string json = "[";
  size_t count = rime->config_list_size(config, key.c_str());
  for (size_t i = 0; i < count; ++i) {
    json +=
        (i ? ", " : "") + Quote(String(config, key + "/@" + std::to_string(i)));
  }
  return json + "]";
}

std::string Switches(RimeConfig *config) {
  std::string json = "[";
  size_t count = rime->config_list_size(config, "switches");
  for (size_t i = 0; i < count; ++i) {
    std::string key = "switches/@" + std::to_string(i);
    json += i ? ", " : "";
    json += "{\"name\": " + Quote(String(config, key + "/name")) +
            ", \"options\": " + Strings(config, key + "/options") +
            ", \"states\": " + Strings(config, key + "/states") + "}";
  }
  return json + "]";
}

} // namespace

int main(int argc, char **argv) {
  if (argc != 3) {
    std::fprintf(stderr,
                 "usage: descriptors SHARED_DATA_DIR PREBUILT_DATA_DIR\n");
    return 2;
  }

  // The program's root is in memory; the store comes from the host.
  mkdir("/nix", 0777);
  if (wasmfs_create_directory("/nix/store", 0777,
                              wasmfs_create_node_backend("/nix/store")) != 0) {
    std::perror("/nix/store");
    return 1;
  }
  mkdir("/user", 0777);

  rime = rime_get_api();
  RIME_STRUCT(RimeTraits, traits);
  traits.shared_data_dir = argv[1];
  traits.prebuilt_data_dir = argv[2];
  traits.user_data_dir = "/user";
  traits.log_dir = "";
  traits.app_name = "rime.descriptors";
  rime->setup(&traits);
  rime->initialize(&traits);

  std::vector<std::string> ids;
  const std::string suffix = ".schema.yaml";
  for (const auto &entry : std::filesystem::directory_iterator(argv[2])) {
    std::string name = entry.path().filename().string();
    if (name.size() > suffix.size() &&
        name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0) {
      ids.push_back(name.substr(0, name.size() - suffix.size()));
    }
  }
  std::sort(ids.begin(), ids.end());

  std::printf("[\n");
  for (size_t i = 0; i < ids.size(); ++i) {
    RimeConfig config = {nullptr};
    if (!rime->schema_open(ids[i].c_str(), &config)) {
      std::fprintf(stderr, "%s: the deployed schema doesn't open\n",
                   ids[i].c_str());
      return 1;
    }
    std::printf(
        "  {\"id\": %s, \"name\": %s, \"dictionary\": %s, "
        "\"dependencies\": %s, \"switches\": %s, \"algebra\": %s}%s\n",
        Quote(ids[i]).c_str(), Quote(String(&config, "schema/name")).c_str(),
        Quote(String(&config, "translator/dictionary")).c_str(),
        Strings(&config, "schema/dependencies").c_str(),
        Switches(&config).c_str(), Strings(&config, "speller/algebra").c_str(),
        i + 1 < ids.size() ? "," : "");
    rime->config_close(&config);
  }
  std::printf("]\n");

  rime->finalize();
  return 0;
}
```

In `engines/rime/overlay.nix`, insert above `          # ibus-rime's engine, compiled with its CMake build's flags. Its`:

```nix
          # Built apart from rime.wasm, so that what rime.wasm compiles in can
          # come from what it prints.
          ibus-web-rime-descriptor-program = final.stdenv.mkDerivation {
            pname = "ibus-web-rime-descriptor-program";
            inherit (final.librime) version;
            src = ./descriptors;
            nativeBuildInputs = [ final.buildPackages.pkg-config ];
            buildInputs = [ final.librime ];
            dontConfigure = true;
            buildPhase = ''
              runHook preBuild
              $CXX -std=c++17 $($PKG_CONFIG --cflags rime) -c descriptors.cc -o descriptors.o
              $CXX ${toString config.ibusWeb.lib.testLinkFlagsWithoutNodeFs} -sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB \
                descriptors.o $($PKG_CONFIG --static --libs rime) -o descriptors.js
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              install -Dm644 -t $out descriptors.js descriptors.wasm
              runHook postInstall
            '';
            dontFixup = true;
          };

```

- [ ] **Step 3: Write the step**

Create `engines/rime/descriptors/descriptors.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** One of a schema's switches, as the descriptor program prints it: a name for a toggle, options for a group. */
export interface RawSwitch {
  name: string;
  options: string[];
  states: string[];
}

/** One deployed schema, as the descriptor program prints it. */
export interface RawSchema {
  id: string;
  name: string;
  dictionary: string;
  dependencies: string[];
  switches: RawSwitch[];
  algebra: string[];
}

/** A schema's entry in the module's table. */
export interface TableEntry {
  gloss: string;
  languages: string[];
  from: "rime-data" | "rime-loengfan" | "rime-ice";
  engine?: boolean;
  undeclared?: string[];
  dictionary: string;
  dependencies: string[];
}

/** What the build knows before deploying: the schemas it ships, in order, its table and each dictionary's store path. */
export interface Plan {
  schemas: string[];
  table: Record<string, TableEntry>;
  dictionaries: Record<string, string>;
}

/** An engine descriptor, as `mkEngineManifest` takes it. */
export interface EngineDescriptor {
  name: string;
  displayName: string;
  languages: string[];
  keyboard: { layout: "us"; passThrough: string[] };
}

/** A switch the settings set: its index among the schema's switches, and the option's within it, or -1 for a toggle. */
export interface SettingSwitch {
  schema: string;
  name: string;
  index: number;
  option: number;
}

/** What the build takes from this step. */
export interface Outputs {
  engines: EngineDescriptor[];
  engineData: Record<string, string[]>;
  settingsPaths: Record<string, string[]>;
  settingsSchemas: string[];
  header: string;
}

export const fixedSchema = "org.freedesktop.ibus.engine.rime";
export const relocatableSchema = "org.freedesktop.ibus.engine.rime.schema";
export const panelSchema = "org.freedesktop.ibus.panel";

// The switches whose initial state the settings set.
const settingSwitches = ["full_shape", "ascii_punct", "simplification", "traditionalization"];

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export const settingsPath = (id: string) => `/org/freedesktop/ibus/engine/rime/${id}/`;

/** The deployed schemas by id, checked against the table, which the build trusted before it deployed. */
export function deployed(raw: readonly RawSchema[], plan: Plan): Map<string, RawSchema> {
  const schemas = new Map(raw.map((schema) => [schema.id, schema]));
  for (const schema of raw) {
    const entry = plan.table[schema.id];
    if (entry === undefined) throw new Error(`${schema.id}: deployed but not in the table`);
    if (entry.dictionary !== schema.dictionary)
      throw new Error(
        `${schema.id}: the table's dictionary is ${entry.dictionary}, the deployed config's ${schema.dictionary}`,
      );
    if (!same(entry.dependencies, schema.dependencies))
      throw new Error(
        `${schema.id}: the table's dependencies are [${entry.dependencies.join(", ")}], the deployed config's [${schema.dependencies.join(", ")}]`,
      );
  }
  return schemas;
}

/** A schema and, transitively, its dependencies, declared or not, each once, the schema first. */
export function closure(
  id: string,
  schemas: ReadonlyMap<string, RawSchema>,
  undeclared: Readonly<Record<string, string[]>> = {},
): RawSchema[] {
  const seen = new Map<string, RawSchema>();
  const visit = (current: string, from: string) => {
    if (seen.has(current)) return;
    const schema = schemas.get(current);
    if (schema === undefined) throw new Error(`${from}: depends on ${current}, which isn't deployed`);
    seen.set(current, schema);
    for (const dependency of [...schema.dependencies, ...(undeclared[current] ?? [])]) visit(dependency, current);
  };
  visit(id, id);
  return [...seen.values()];
}

export function engineDescriptor(schema: RawSchema, entry: TableEntry): EngineDescriptor {
  if (entry.gloss === "") throw new Error(`${schema.id}: no gloss`);
  return {
    name: `rime:${schema.id}`,
    displayName: `${schema.name} (${entry.gloss})`,
    languages: entry.languages,
    // The shape-based schemas map key positions, so every engine reads the
    // US layout's.
    keyboard: { layout: "us", passThrough: [] },
  };
}

/** The store paths of an engine's dictionaries: its own schema's, then its dependencies'. */
export function engineData(id: string, schemas: ReadonlyMap<string, RawSchema>, plan: Plan): string[] {
  const undeclared = Object.fromEntries(
    Object.entries(plan.table).map(([schema, entry]) => [schema, entry.undeclared ?? []]),
  );
  const paths = closure(id, schemas, undeclared).map((schema) => {
    const path = plan.dictionaries[schema.dictionary];
    if (path === undefined) throw new Error(`${schema.id}: no store path for dictionary ${schema.dictionary}`);
    return path;
  });
  return [...new Set(paths)];
}

export function settingSwitchesOf(schema: RawSchema): SettingSwitch[] {
  return schema.switches.flatMap((found, index): SettingSwitch[] => {
    if (found.name !== "")
      return settingSwitches.includes(found.name) ? [{ schema: schema.id, name: found.name, index, option: -1 }] : [];
    const option = found.options.indexOf("simplification");
    return option < 0 ? [] : [{ schema: schema.id, name: "simplification", index, option }];
  });
}

/** rime-ice's Pinyin and Double Pinyin schemas, which take fuzzy Pinyin before their own algebra. */
export const isRimeIcePinyin = (schema: RawSchema, plan: Plan) =>
  plan.table[schema.id]?.from === "rime-ice" && schema.dictionary === "rime_ice";

// JSON's escapes are C's for the text a schema holds: its quotes,
// backslashes and non-ASCII characters, but no control characters.
const cString = (text: string) => {
  if ([...text].some((character) => character.codePointAt(0)! < 0x20))
    throw new Error(`control character in ${JSON.stringify(text)}`);
  return JSON.stringify(text);
};

const macro = (name: string, entries: readonly string[]) =>
  entries.length === 0
    ? `#define ${name}(X)`
    : [`#define ${name}(X) \\`, entries.map((entry) => `  ${entry}`).join(" \\\n")].join("\n");

/** The tables the module compiles in: its engines' schemas, the switches its settings set, and the algebra fuzzy Pinyin goes before. */
export function header(shipped: readonly RawSchema[], plan: Plan): string {
  const switches = shipped.flatMap(settingSwitchesOf);
  const algebra = shipped
    .filter((schema) => isRimeIcePinyin(schema, plan))
    .flatMap((schema) => schema.algebra.map((rule) => `X(${cString(schema.id)}, ${cString(rule)})`));
  return [
    macro(
      "IBUSWEB_RIME_SCHEMAS",
      shipped.map((schema) => `X(${cString(schema.id)})`),
    ),
    macro(
      "IBUSWEB_RIME_SWITCHES",
      switches.map((found) => `X(${cString(found.schema)}, ${cString(found.name)}, ${found.index}, ${found.option})`),
    ),
    macro("IBUSWEB_RIME_ALGEBRA", algebra),
    "",
  ].join("\n");
}

/**
 * Each schema instance the module declares, one a line, as the metadata tool
 * takes them: a fixed schema's id, or the relocatable schema's id and a path.
 */
export function instances(outputs: Outputs): string {
  const fixed = outputs.settingsSchemas.filter((id) => id !== relocatableSchema);
  const relocated = Object.entries(outputs.settingsPaths).flatMap(([id, paths]) =>
    paths.map((path) => `${id}=${path}`),
  );
  return [...fixed, ...relocated, ""].join("\n");
}

export function generate(raw: readonly RawSchema[], plan: Plan): Outputs {
  const schemas = deployed(raw, plan);
  if (new Set(plan.schemas).size !== plan.schemas.length) throw new Error("a schema is listed twice");
  const shipped = plan.schemas.map((id) => {
    const schema = schemas.get(id);
    if (schema === undefined) throw new Error(`${id}: isn't deployed`);
    return schema;
  });

  return {
    engines: shipped.map((schema) => engineDescriptor(schema, plan.table[schema.id]!)),
    engineData: Object.fromEntries(
      shipped.map((schema) => [`rime:${schema.id}`, engineData(schema.id, schemas, plan)]),
    ),
    settingsPaths: { [relocatableSchema]: shipped.map((schema) => settingsPath(schema.id)) },
    settingsSchemas: [fixedSchema, relocatableSchema, panelSchema],
    header: header(shipped, plan),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, planFile, output] = process.argv.slice(2);
  if (!input || !planFile || !output) throw new Error("usage: descriptors.ts RAW.json PLAN.json OUTPUT_DIR");
  const outputs = generate(JSON.parse(readFileSync(input, "utf8")), JSON.parse(readFileSync(planFile, "utf8")));

  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "engines.json"), json(outputs.engines));
  writeFileSync(join(output, "engine-data.json"), json(outputs.engineData));
  writeFileSync(join(output, "settings-paths.json"), json(outputs.settingsPaths));
  writeFileSync(join(output, "settings-schemas.json"), json(outputs.settingsSchemas));
  writeFileSync(join(output, "rime-tables.h"), outputs.header);
  writeFileSync(join(output, "instances.txt"), instances(outputs));
}
```

In `engines/rime/_data.nix`, add `  ibus-web-rime-descriptor-program,` to the arguments after `  ibus-web-rime-tools,`; insert above `  # A dictionary's tables and the prisms of the schemas that read it.`:

```nix
  # What the descriptor program reads from the deployed configs.
  raw = runCommand "ibus-web-rime-raw-descriptors" { nativeBuildInputs = [ nodejs ]; } ''
    node ${ibus-web-rime-descriptor-program}/descriptors.js ${source} ${deployment}/build > $out
  '';

```

insert above `in` (the last `let` binding's end):

```nix

  plan = writeText "ibus-web-rime-plan.json" (
    builtins.toJSON {
      schemas = shipped;
      table = lib.genAttrs deployed (id: table.${id});
      dictionaries = lib.mapAttrs (_: path: "${path}") dicts;
    }
  );

  descriptors = runCommand "ibus-web-rime-descriptors" { nativeBuildInputs = [ nodejs ]; } ''
    node ${./descriptors/descriptors.ts} ${raw} ${plan} $out
    cp ${raw} $out/raw.json
  '';
```

and add `    descriptors` to the result's `inherit`, after `    common`.

- [ ] **Step 4: Run the tests to see them pass**

Run:

```bash
nix develop -c git add engines/rime
nix build .#checks.x86_64-linux.rime-descriptors -L
d=$(nix build --no-link --print-out-paths .#legacyPackages.x86_64-linux.pkgsWasm.ibus-web-rime-data.descriptors)
ls "$d"
nix develop -c jq -r '.[0].displayName, length' "$d"/engines.json
head -3 "$d"/rime-tables.h
```

Expected: PASS with 15 tests; `engine-data.json engines.json instances.txt raw.json rime-tables.h settings-paths.json settings-schemas.json`; `雾凇拼音 (Pinyin, simplified)`, `47`; `#define IBUSWEB_RIME_SCHEMAS(X) \`, `  X("rime_ice") \`, `  X("double_pinyin") \`. The descriptor program's stderr shows Rime's INFO lines; none is an `E` line.

- [ ] **Step 5: Update the docs**

In `docs/rime.md`, insert above `## Checks`:

```markdown
### Descriptors

The descriptor program (`descriptors/descriptors.cc`), a WebAssembly program run under Node at build time, reads every
schema the deployment compiled through librime's API and prints, as JSON, its id, name, dictionary, dependencies,
switches (each a name or a list of options, with the states' labels) and spelling algebra. `descriptors.ts`
(`@ibus-web/rime-descriptors`) checks every deployed schema against the schema table and writes the module's files:

| File                    | Holds                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `engines.json`          | A descriptor per shipped schema, in the order shipped: `rime:<id>`, `<name> (<gloss>)`, the table's languages, the US layout    |
| `engine-data.json`      | Each engine's dictionary paths: its own schema's, then its dependencies', declared or not, each once                            |
| `settings-paths.json`   | Each engine's path for `org.freedesktop.ibus.engine.rime.schema`, `/org/freedesktop/ibus/engine/rime/<id>/`                     |
| `settings-schemas.json` | Rime's fixed and relocatable schemas and the panel's                                                                            |
| `instances.txt`         | Every settings instance, for test harnesses                                                                                     |
| `rime-tables.h`         | The shipped schemas, the switches the settings set (by index among a schema's switches), and rime-ice's Pinyin schemas' algebra |

The schema table, `engines/rime/_schemas.nix`, gives each schema the data can deploy its English gloss, languages,
package, dictionary and dependencies, as its deployed config names them, a dependency it reads but doesn't name
(`array30` reads `array30_query`'s dictionary) and whether it is an engine. Nix needs the dictionaries and dependencies
before anything is deployed, to make one derivation per dictionary; the step fails if a deployed config disagrees with
the table, if a schema has no gloss, or if a dependency isn't deployed. `engine-data.json` is a file of its own because
`EngineDescriptor` doesn't take `data`.
```

and add to its `## Checks` table, above the `rime-cast-audit` row:

```markdown
| `rime-descriptors` | Vitest: the table checked against deployed configs, dependency resolution into `engine-data.json`, ordering, glosses, the switch and algebra tables, and what fails the build; the default build's outputs and a build of three schemas |
```

Run: `nix develop -c oxfmt docs/rime.md`

- [ ] **Step 6: Commit**

```bash
nix develop -c git add engines/rime modules/typescript/files.nix pnpm-workspace.yaml pnpm-lock.yaml docs/rime.md
nix develop -c git commit -m "feat(rime): describe the engines from the deployed configs" -- engines/rime modules/typescript/files.nix pnpm-workspace.yaml pnpm-lock.yaml docs/rime.md
```

---

## Milestone C: the side module

Task 7 builds `rime.wasm`. At its end the module loads, its imports and closure are checked, and every cast audit passes.

### Task 7: `rime.wasm`

The side module: ibus-rime's engine with the module's init, its GSettings schemas and the settings that write Rime's YAML.

**Files:**
- Create: `engines/rime/org.freedesktop.ibus.engine.rime.gschema.xml`, `engines/rime/module/module.cc`, `engines/rime/module/settings.c`, `engines/rime/module/settings.h`, `engines/rime/_package.nix`, `engines/rime/options.nix`, `engines/rime/module.nix`, `engines/rime/cast-audit/module.jsonc`
- Modify: `engines/rime/overlay.nix`, `engines/rime/cast-audit.nix`
- Docs: `docs/rime.md`, `docs/engines.md`, `docs/known-gaps.md`

**Interfaces:**
- Consumes: `pkgsWasm.ibus-engines.rime` (Task 4), `pkgsWasm.ibus-web-rime-data` (Tasks 5–6), `pkgsWasm.librime` and `rime::Switcher::SetSchemaListFilter` (Task 3), the runtime's `sideModuleFlags` and `sideModuleLibraryGuard`.
- Produces: `pkgsWasm.ibus-web-rime` (`$out/rime.wasm`, `.override { schemas = …; }`, passthru `schemas`, `common`, `dicts`, `deployment`, `descriptors`, `source`, `settingsSchemas`, `settingsSchemaDir`, `auditCflags`, `auditCxxflags`); `packages.ibus-web-rime`, `packages.ibus-web-rime-common`, `packages.ibus-web-rime-descriptors`, `packages.ibus-web-rime-dict-<name>`; the option `ibusWeb.engines.rime`; `checks.rime-imports`, `checks.rime-data-closure`. In the module: `void ibusweb_module_init(IBusWebModule *)`, `RimeApi *rime_api`, `void ibus_rime_start(gboolean)`, `void ibus_rime_stop()`, `void ibusweb_rime_settings_init(void)`, `void ibusweb_rime_settings_deployed(void)`; the log messages `Rime is under maintenance ...`, `Rime is ready.`, `Rime has encountered an error.`.

- [ ] **Step 1: Write the failing checks**

Create `engines/rime/options.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.engines.rime = lib.mkOption {
      description = "The Rime side module and what its distribution is made from.";
      type = lib.types.submodule {
        options = {
          package = lib.mkOption {
            type = lib.types.package;
            description = "ibus-web-rime: rime.wasm, with the common data, the dictionaries and the descriptors in its passthru.";
          };

          descriptors = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file of the module's engine descriptors, rime:rime_ice first.";
          };

          engineData = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file of each engine's dictionary store paths, by engine name.";
          };

          settingsPaths = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file of each engine's path for org.freedesktop.ibus.engine.rime.schema, as settingsPaths takes it.";
          };

          settingsSchemaDir = lib.mkOption {
            type = lib.types.str;
            description = "The compiled schema directory rime.wasm keeps in its closure.";
          };

          settingsSchemas = lib.mkOption {
            type = lib.types.path;
            description = "A JSON file listing the module's schema ids: Rime's fixed and relocatable schemas and the panel's.";
          };
        };
      };
    };
  };
}
```

Create `engines/rime/module.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) runtime toolchain;
      inherit (config.ibusWeb.lib) emscriptenRoot;
      rime = toolchain.pkgsWasm.ibus-web-rime;
    in
    {
      packages = {
        ibus-web-rime = rime;
        ibus-web-rime-common = rime.common;
        ibus-web-rime-descriptors = rime.descriptors;
      }
      // lib.mapAttrs' (name: dict: lib.nameValuePair "ibus-web-rime-dict-${name}" dict) rime.dicts;

      ibusWeb.engines.rime = {
        package = rime;
        descriptors = "${rime.descriptors}/engines.json";
        engineData = "${rime.descriptors}/engine-data.json";
        settingsPaths = "${rime.descriptors}/settings-paths.json";
        inherit (rime) settingsSchemaDir;
        settingsSchemas = "${rime.descriptors}/settings-schemas.json";
      };

      ibusWeb.toolchain.devLibraries = [ toolchain.pkgsWasm.librime ];

      checks.rime-imports =
        pkgs.runCommand "ibus-web-rime-imports" { nativeBuildInputs = [ pkgs.python3 ]; }
          ''
            cat ${
              runtime.checkSideModuleImports {
                name = "rime";
                modules = [ "${rime}/rime.wasm" ];
              }
            } > $out

            # OpenCC loads no segmentation plugin and Lua no C module, so the
            # module needs nothing of the dynamic loader.
            PYTHONPATH=${emscriptenRoot} python3 - ${rime}/rime.wasm >> $out <<'EOF'
            import sys
            from tools import webassembly

            loader = {"dlopen", "dlsym", "dlclose", "dlerror"}
            found = sorted(i.field for i in webassembly.get_imports(sys.argv[1]) if i.field in loader)
            print(f"{sys.argv[1]}: dynamic loader imports: {', '.join(found) or 'none'}")
            sys.exit(1 if found else 0)
            EOF
          '';

      # The closure is the module, the common data, every dictionary and the
      # compiled schemas, all of them data.
      checks.rime-data-closure = pkgs.runCommand "ibus-web-rime-data-closure" { } ''
        closure=${pkgs.closureInfo { rootPaths = [ rime ]; }}/store-paths
        printf '%s\n' ${rime} ${rime.common} ${rime.settingsSchemas} \
          ${toString (builtins.attrValues rime.dicts)} | sort > expected
        sort "$closure" > actual
        diff -u expected actual

        test -f ${rime.settingsSchemaDir}/gschemas.compiled
        test -f ${rime.common}/build/default.yaml

        while IFS= read -r path; do
          if [ "$path" = ${rime} ]; then continue; fi
          forbidden=$(find "$path" \( -name lib -o -name include -o -name '*.a' -o -name '*.wasm' -o -name '*.pc' \) -print)
          if [ -n "$forbidden" ]; then echo "non-data closure entries: $forbidden" >&2; exit 1; fi
        done < "$closure"

        # The distribution's archives hold link targets of 100 bytes at most.
        longest=$(find ${rime.common}/build -type l -printf '%l\n' | awk '{ if (length($0) > n) n = length($0) } END { print n }')
        echo "longest link target: $longest bytes"
        { cat "$closure"; echo "longest link target: $longest bytes"; } > $out
      '';
    };
}
```

Run: `nix develop -c git add engines/rime && nix build .#checks.x86_64-linux.rime-imports .#checks.x86_64-linux.rime-data-closure -L`
Expected: FAIL: `attribute 'ibus-web-rime' missing`.

- [ ] **Step 2: Write the settings schema**

Create `engines/rime/org.freedesktop.ibus.engine.rime.gschema.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- SPDX-FileCopyrightText: 2026 Synapdeck, Inc. -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Rime's settings, which the module writes as YAML patches. A key left at
     its default patches nothing, so its default is Rime's own configuration. -->
<schemalist>
  <schema id="org.freedesktop.ibus.engine.rime" path="/org/freedesktop/ibus/engine/rime/">
    <key name="page-size" type="i">
      <range min="1" max="10"/>
      <default>5</default>
      <summary>Candidates per page</summary>
      <description>How many candidates each page of the candidate list shows.</description>
    </key>
    <key name="switcher-hotkeys" type="as">
      <default>['Control+grave', 'Control+Shift+grave', 'F4']</default>
      <summary>Menu keys</summary>
      <description>The keys that open Rime's menu of options, as Rime names them, such as F4 or Control+grave. With none, the menu doesn't open.</description>
    </key>
    <key name="ascii-toggle-key" type="s">
      <choices>
        <choice value="shift"/>
        <choice value="caps-lock"/>
        <choice value="control"/>
        <choice value="none"/>
      </choices>
      <default>'shift'</default>
      <summary>Latin input key</summary>
      <description>The key that switches between Chinese and Latin input: either Shift (and Caps Lock, which also clears the composition), Caps Lock alone, either Control, or none.</description>
    </key>
    <key name="inline-preedit" type="b">
      <default>true</default>
      <summary>Show the composition in the text</summary>
      <description>Show the text being composed where it will be inserted, rather than only in the candidate window.</description>
    </key>
    <key name="preedit-style" type="s">
      <choices>
        <choice value="composition"/>
        <choice value="preview"/>
      </choices>
      <default>'preview'</default>
      <summary>Composition shown</summary>
      <description>What the text shows while composing: the input as typed, or a preview of the text it converts to.</description>
    </key>
    <key name="cursor-type" type="s">
      <choices>
        <choice value="insert"/>
        <choice value="select"/>
      </choices>
      <default>'select'</default>
      <summary>Cursor in the composition</summary>
      <description>Where the cursor sits in the composition: at the insertion point, or at the start of the text being converted.</description>
    </key>
    <key name="traditional" type="b">
      <default>false</default>
      <summary>Traditional characters</summary>
      <description>Whether rime-ice's Pinyin and Double Pinyin engines start out typing traditional characters.</description>
    </key>
    <key name="fuzzy-pinyin" type="as">
      <choices>
        <choice value="zh-z"/>
        <choice value="z-zh"/>
        <choice value="l-n"/>
        <choice value="n-l"/>
        <choice value="f-h"/>
        <choice value="h-f"/>
        <choice value="l-r"/>
        <choice value="r-l"/>
        <choice value="g-k"/>
        <choice value="k-g"/>
        <choice value="ang-an"/>
        <choice value="an-ang"/>
        <choice value="eng-en"/>
        <choice value="en-eng"/>
        <choice value="in-ing"/>
        <choice value="ing-in"/>
        <choice value="ian-iang"/>
        <choice value="iang-ian"/>
        <choice value="uan-uang"/>
        <choice value="uang-uan"/>
        <choice value="ai-an"/>
        <choice value="an-ai"/>
        <choice value="ong-un"/>
        <choice value="un-ong"/>
        <choice value="ong-on"/>
        <choice value="iong-un"/>
        <choice value="un-iong"/>
        <choice value="ong-eng"/>
        <choice value="eng-ong"/>
        <choice value="fei-hui"/>
        <choice value="hui-fei"/>
        <choice value="hu-fu"/>
        <choice value="fu-hu"/>
        <choice value="wang-huang"/>
        <choice value="huang-wang"/>
      </choices>
      <default>[]</default>
      <summary>Fuzzy Pinyin</summary>
      <description>Spellings rime-ice's Pinyin and Double Pinyin engines also accept for each other, each written as the sound typed, a hyphen and the sound it also stands for: zh-z lets z, c and s stand for zh, ch and sh.</description>
    </key>
  </schema>
  <schema id="org.freedesktop.ibus.engine.rime.schema">
    <key name="full-shape" type="b">
      <default>false</default>
      <summary>Full-width characters</summary>
      <description>Whether the engine starts out typing full-width Latin letters, digits and punctuation.</description>
    </key>
    <key name="ascii-punct" type="b">
      <default>false</default>
      <summary>Latin punctuation</summary>
      <description>Whether the engine starts out typing Latin rather than Chinese punctuation.</description>
    </key>
    <key name="simplification" type="b">
      <default>false</default>
      <summary>Simplified characters</summary>
      <description>Whether an engine with a switch to simplified characters starts out with it on.</description>
    </key>
  </schema>
</schemalist>
```

- [ ] **Step 3: Write the module's sources**

Create `engines/rime/module/settings.h`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <glib.h>

G_BEGIN_DECLS

/* Writes the YAML patches the settings ask for into Rime's user directory,
 * and follows the settings from then on. Call it before Rime is set up. */
void ibusweb_rime_settings_init(void);

/* Tells the settings that a deployment has ended, so that one that changed
 * meanwhile can start the next. */
void ibusweb_rime_settings_deployed(void);

G_END_DECLS
```

Create `engines/rime/module/settings.c`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "settings.h"
#include "rime-tables.h"
#include <errno.h>
#include <gio/gio.h>
#include <glib/gstdio.h>
#include <rime_api.h>

#define RIME_SCHEMA "org.freedesktop.ibus.engine.rime"
#define RIME_SCHEMA_SCHEMA RIME_SCHEMA ".schema"
#define RIME_PATH "/org/freedesktop/ibus/engine/rime/"

extern RimeApi *rime_api;

typedef struct {
  const char *schema;
  const char *name;
  int index;
  int option;
} Switch;

typedef struct {
  const char *schema;
  const char *rule;
} AlgebraRule;

#define IBUSWEB_RIME_SCHEMA_ENTRY(schema_id) schema_id,
static const char *const schemas[] = {
    IBUSWEB_RIME_SCHEMAS(IBUSWEB_RIME_SCHEMA_ENTRY)};
#undef IBUSWEB_RIME_SCHEMA_ENTRY

#define IBUSWEB_RIME_SWITCH_ENTRY(schema_id, name, index, option)              \
  {schema_id, name, index, option},
static const Switch switches[] = {
    IBUSWEB_RIME_SWITCHES(IBUSWEB_RIME_SWITCH_ENTRY)};
#undef IBUSWEB_RIME_SWITCH_ENTRY

#define IBUSWEB_RIME_ALGEBRA_ENTRY(schema_id, rule) {schema_id, rule},
static const AlgebraRule algebra[] = {
    IBUSWEB_RIME_ALGEBRA(IBUSWEB_RIME_ALGEBRA_ENTRY)};
#undef IBUSWEB_RIME_ALGEBRA_ENTRY

/* rime-ice's fuzzy pinyin, the rules its speller carries commented out, by
 * the names the settings schema offers. */
static const struct {
  const char *name;
  const char *rule;
} fuzzy_rules[] = {
    {"zh-z", "derive/^([zcs])h/$1/"},
    {"z-zh", "derive/^([zcs])([^h])/$1h$2/"},
    {"l-n", "derive/^l/n/"},
    {"n-l", "derive/^n/l/"},
    {"f-h", "derive/^f/h/"},
    {"h-f", "derive/^h/f/"},
    {"l-r", "derive/^l/r/"},
    {"r-l", "derive/^r/l/"},
    {"g-k", "derive/^g/k/"},
    {"k-g", "derive/^k/g/"},
    {"ang-an", "derive/ang$/an/"},
    {"an-ang", "derive/an$/ang/"},
    {"eng-en", "derive/eng$/en/"},
    {"en-eng", "derive/en$/eng/"},
    {"in-ing", "derive/in$/ing/"},
    {"ing-in", "derive/ing$/in/"},
    {"ian-iang", "derive/ian$/iang/"},
    {"iang-ian", "derive/iang$/ian/"},
    {"uan-uang", "derive/uan$/uang/"},
    {"uang-uan", "derive/uang$/uan/"},
    {"ai-an", "derive/ai$/an/"},
    {"an-ai", "derive/an$/ai/"},
    {"ong-un", "derive/ong$/un/"},
    {"un-ong", "derive/un$/ong/"},
    {"ong-on", "derive/ong$/on/"},
    {"iong-un", "derive/iong$/un/"},
    {"un-iong", "derive/un$/iong/"},
    {"ong-eng", "derive/ong$/eng/"},
    {"eng-ong", "derive/eng$/ong/"},
    {"fei-hui", "derive/^fei$/hui/"},
    {"hui-fei", "derive/^hui$/fei/"},
    {"hu-fu", "derive/^hu$/fu/"},
    {"fu-hu", "derive/^fu$/hu/"},
    {"wang-huang", "derive/^wang$/huang/"},
    {"huang-wang", "derive/^huang$/wang/"},
};

/* Rime's ascii_composer actions for each choice of ascii-toggle-key. shift
 * is the default configuration's own: either Shift switches, as does Caps
 * Lock, which also clears the composition. */
static const struct {
  const char *name;
  const char *keys;
} ascii_toggle_keys[] = {
    {"shift", "    Shift_L: inline_ascii\n"
              "    Shift_R: commit_text\n"
              "    Control_L: noop\n"
              "    Control_R: noop\n"
              "    Caps_Lock: clear\n"
              "    Eisu_toggle: clear\n"},
    {"caps-lock", "    Shift_L: noop\n"
                  "    Shift_R: noop\n"
                  "    Control_L: noop\n"
                  "    Control_R: noop\n"
                  "    Caps_Lock: clear\n"
                  "    Eisu_toggle: clear\n"},
    {"control", "    Shift_L: noop\n"
                "    Shift_R: noop\n"
                "    Control_L: commit_code\n"
                "    Control_R: commit_code\n"
                "    Caps_Lock: noop\n"
                "    Eisu_toggle: noop\n"},
    {"none", "    Shift_L: noop\n"
             "    Shift_R: noop\n"
             "    Control_L: noop\n"
             "    Control_R: noop\n"
             "    Caps_Lock: noop\n"
             "    Eisu_toggle: noop\n"},
};

static GSettings *settings;
static GSettings *schema_settings[G_N_ELEMENTS(schemas)];

/* Whether a change came while a deployment ran, which the next one takes. */
static gboolean pending;

/* A YAML double-quoted scalar. */
static void append_quoted(GString *yaml, const char *text) {
  g_string_append_c(yaml, '"');
  for (const char *c = text; *c != '\0'; c++) {
    if (*c == '"' || *c == '\\')
      g_string_append_c(yaml, '\\');
    g_string_append_c(yaml, *c);
  }
  g_string_append_c(yaml, '"');
}

/* The value the page stored for key, or NULL: only those are patched, so
 * a key left at its default leaves Rime's own configuration alone. */
static GVariant *stored(GSettings *from, const char *key) {
  return g_settings_get_user_value(from, key);
}

static char *default_patch(void) {
  GString *yaml = g_string_new(NULL);
  GVariant *value;

  if ((value = stored(settings, "page-size")) != NULL) {
    g_string_append_printf(yaml, "  \"menu/page_size\": %d\n",
                           g_variant_get_int32(value));
    g_variant_unref(value);
  }

  if ((value = stored(settings, "switcher-hotkeys")) != NULL) {
    g_autofree const char **keys = g_variant_get_strv(value, NULL);
    g_string_append(yaml, "  \"switcher/hotkeys\":");
    if (keys[0] == NULL)
      g_string_append(yaml, " []");
    g_string_append_c(yaml, '\n');
    for (const char **key = keys; *key != NULL; key++) {
      g_string_append(yaml, "    - ");
      append_quoted(yaml, *key);
      g_string_append_c(yaml, '\n');
    }
    g_variant_unref(value);
  }

  if ((value = stored(settings, "ascii-toggle-key")) != NULL) {
    const char *choice = g_variant_get_string(value, NULL);
    for (gsize i = 0; i < G_N_ELEMENTS(ascii_toggle_keys); i++) {
      if (g_str_equal(choice, ascii_toggle_keys[i].name))
        g_string_append_printf(yaml, "  \"ascii_composer/switch_key\":\n%s",
                               ascii_toggle_keys[i].keys);
    }
    g_variant_unref(value);
  }

  return g_string_free(yaml, FALSE);
}

static char *ibus_rime_patch(void) {
  GString *yaml = g_string_new(NULL);
  GVariant *value;

  if ((value = stored(settings, "inline-preedit")) != NULL) {
    g_string_append_printf(yaml, "  \"style/inline_preedit\": %s\n",
                           g_variant_get_boolean(value) ? "true" : "false");
    g_variant_unref(value);
  }

  static const struct {
    const char *key;
    const char *path;
  } strings[] = {{"preedit-style", "style/preedit_style"},
                 {"cursor-type", "style/cursor_type"}};
  for (gsize i = 0; i < G_N_ELEMENTS(strings); i++) {
    if ((value = stored(settings, strings[i].key)) == NULL)
      continue;
    g_string_append_printf(yaml, "  \"%s\": ", strings[i].path);
    append_quoted(yaml, g_variant_get_string(value, NULL));
    g_string_append_c(yaml, '\n');
    g_variant_unref(value);
  }

  return g_string_free(yaml, FALSE);
}

/* A switch's initial state: the option's index for a switch of several
 * options, which only true sets, or 0 or 1 for a toggle. */
static void append_reset(GString *yaml, const Switch *found, gboolean on) {
  if (found->option < 0)
    g_string_append_printf(yaml, "  \"switches/@%d/reset\": %d\n", found->index,
                           on ? 1 : 0);
  else if (on)
    g_string_append_printf(yaml, "  \"switches/@%d/reset\": %d\n", found->index,
                           found->option);
}

static char *schema_patch(gsize index) {
  const char *schema_id = schemas[index];
  GSettings *own = schema_settings[index];
  GString *yaml = g_string_new(NULL);

  static const struct {
    const char *key;
    const char *name;
  } resets[] = {{"full-shape", "full_shape"},
                {"ascii-punct", "ascii_punct"},
                {"simplification", "simplification"}};
  for (gsize i = 0; i < G_N_ELEMENTS(switches); i++) {
    const Switch *found = &switches[i];
    if (!g_str_equal(found->schema, schema_id))
      continue;
    GVariant *value = NULL;
    if (g_str_equal(found->name, "traditionalization")) {
      value = stored(settings, "traditional");
    } else {
      for (gsize j = 0; j < G_N_ELEMENTS(resets); j++) {
        if (g_str_equal(found->name, resets[j].name))
          value = stored(own, resets[j].key);
      }
    }
    if (value == NULL)
      continue;
    append_reset(yaml, found, g_variant_get_boolean(value));
    g_variant_unref(value);
  }

  GVariant *fuzzy = stored(settings, "fuzzy-pinyin");
  gboolean pinyin = FALSE;
  for (gsize i = 0; i < G_N_ELEMENTS(algebra); i++)
    pinyin |= g_str_equal(algebra[i].schema, schema_id);
  if (fuzzy != NULL && pinyin) {
    /* The rules derive from the full spellings, so they go before the
     * rest of the algebra, which double pinyin's begins converting. */
    g_autofree const char **names = g_variant_get_strv(fuzzy, NULL);
    g_string_append(yaml, "  \"speller/algebra\":\n");
    for (const char **name = names; *name != NULL; name++) {
      for (gsize i = 0; i < G_N_ELEMENTS(fuzzy_rules); i++) {
        if (!g_str_equal(*name, fuzzy_rules[i].name))
          continue;
        g_string_append(yaml, "    - ");
        append_quoted(yaml, fuzzy_rules[i].rule);
        g_string_append_c(yaml, '\n');
      }
    }
    for (gsize i = 0; i < G_N_ELEMENTS(algebra); i++) {
      if (!g_str_equal(algebra[i].schema, schema_id))
        continue;
      g_string_append(yaml, "    - ");
      append_quoted(yaml, algebra[i].rule);
      g_string_append_c(yaml, '\n');
    }
  }
  g_clear_pointer(&fuzzy, g_variant_unref);

  return g_string_free(yaml, FALSE);
}

/* Writes name's patch, or removes the file when there's nothing to patch,
 * and says whether that changed it. */
static gboolean write_patch(const char *name, char *patch) {
  g_autofree char *path = g_build_filename(g_get_home_dir(), name, NULL);
  g_autofree char *contents =
      *patch == '\0' ? NULL : g_strconcat("patch:\n", patch, NULL);
  g_free(patch);

  g_autofree char *existing = NULL;
  if (!g_file_get_contents(path, &existing, NULL, NULL))
    existing = NULL;
  if (g_strcmp0(existing, contents) == 0)
    return FALSE;

  g_autoptr(GError) error = NULL;
  if (contents == NULL) {
    if (g_unlink(path) != 0)
      g_warning("%s: %s", path, g_strerror(errno));
  } else if (!g_file_set_contents(path, contents, -1, &error)) {
    g_warning("%s", error->message);
  }
  return TRUE;
}

static gboolean write_patches(void) {
  gboolean changed = write_patch("default.custom.yaml", default_patch());
  changed |= write_patch("ibus_rime.custom.yaml", ibus_rime_patch());
  for (gsize i = 0; i < G_N_ELEMENTS(schemas); i++) {
    g_autofree char *name = g_strconcat(schemas[i], ".custom.yaml", NULL);
    changed |= write_patch(name, schema_patch(i));
  }
  return changed;
}

/* A full check: a patch written in the second the last deployment ended
 * looks no newer than it, and a check of modifications alone would skip it. */
static void deploy(void) {
  if (rime_api->start_maintenance(True))
    rime_api->deploy_config_file("ibus_rime.yaml", "config_version");
}

static void changed(GSettings *from G_GNUC_UNUSED,
                    const char *key G_GNUC_UNUSED,
                    gpointer data G_GNUC_UNUSED) {
  if (!write_patches())
    return;
  if (rime_api->is_maintenance_mode())
    pending = TRUE;
  else
    deploy();
}

void ibusweb_rime_settings_init(void) {
  settings = g_settings_new(RIME_SCHEMA);
  g_signal_connect(settings, "changed", G_CALLBACK(changed), NULL);
  for (gsize i = 0; i < G_N_ELEMENTS(schemas); i++) {
    g_autofree char *path = g_strconcat(RIME_PATH, schemas[i], "/", NULL);
    schema_settings[i] = g_settings_new_with_path(RIME_SCHEMA_SCHEMA, path);
    g_signal_connect(schema_settings[i], "changed", G_CALLBACK(changed), NULL);
  }
  write_patches();
}

void ibusweb_rime_settings_deployed(void) {
  if (!pending)
    return;
  pending = FALSE;
  deploy();
}
```

Create `engines/rime/module/module.cc`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later

// ibus-rime as a side module: what its main() sets up before it enters
// ibus_main(), without a bus.

#include <cstring>
#include <string>

#include <glog/logging.h>
#include <rime/switcher.h>
#include <rime_api.h>

#include <ibus-web/runtime.h>
#include <ibus.h>

extern "C" {
#include "rime_config.h"
#include "rime_engine.h"
#include "rime_settings.h"
}

#include "rime-tables.h"
#include "settings.h"

extern "C" RimeApi *rime_api;
RimeApi *rime_api = nullptr;

// Keeps the compiled schemas, which the module's settings metadata lists,
// in the side module's data closure.
extern "C" const char ibusweb_rime_settings_schema_dir[] =
    IBUSWEB_SETTINGS_SCHEMA_DIR;

// A static librime registers a plugin's modules only if something refers to
// the plugin; these are what each defines for that.
void rime_require_module_lua();
void rime_require_module_grammar();
void rime_require_module_octagram();

namespace {

// The common data's store path, compiled in so that it stays in the side
// module's data closure; Rime's shared data directory.
constexpr char kSharedDataDir[] = IBUSWEB_RIME_SHARED_DATA_DIR;

RimeTraits traits;

// Rime logs through glog. Its messages become GLib's, which reach the page
// as Log records, and its warnings and errors fail the tests that watch
// for them.
class GLibSink : public google::LogSink {
public:
  void send(google::LogSeverity severity, const char *,
            const char *base_filename, int line, const google::LogMessageTime &,
            const char *message, size_t message_len) override {
    GLogLevelFlags level = G_LOG_LEVEL_INFO;
    if (severity >= google::GLOG_ERROR) {
      level = G_LOG_LEVEL_CRITICAL;
    } else if (severity == google::GLOG_WARNING) {
      level = G_LOG_LEVEL_WARNING;
    }
    g_log("Rime", level, "%s:%d: %.*s", base_filename, line,
          static_cast<int>(message_len), message);
  }
};

// Runs on the pumping thread once a deployment has ended, whichever thread
// reported it.
gboolean Deployed(gpointer data) {
  const bool success = GPOINTER_TO_INT(data);
  if (success) {
    g_message("Rime is ready.");
    ibus_rime_load_settings();
  } else {
    g_warning("Rime has encountered an error.");
  }

  // Sessions keep the configs they were made with. Ending them makes each
  // engine start a new one, with the deployed configs, at its next key.
  rime_api->cleanup_all_sessions();
  ibusweb_rime_settings_deployed();
  return G_SOURCE_REMOVE;
}

void Notify(void *, RimeSessionId session_id, const char *message_type,
            const char *message_value) {
  if (std::strcmp(message_type, "option") == 0) {
    ibus_rime_engine_option_changed(session_id, message_value);
    return;
  }
  if (std::strcmp(message_type, "deploy") != 0) {
    return;
  }

  // Deployments report from the deployer's thread.
  if (std::strcmp(message_value, "start") == 0) {
    g_message("Rime is under maintenance ...");
  } else if (std::strcmp(message_value, "success") == 0) {
    g_main_context_invoke(nullptr, Deployed, GINT_TO_POINTER(TRUE));
  } else if (std::strcmp(message_value, "failure") == 0) {
    g_main_context_invoke(nullptr, Deployed, GINT_TO_POINTER(FALSE));
  }
}

} // namespace

extern "C" void ibus_rime_start(gboolean full_check) {
  rime_api->initialize(&traits);
  if (rime_api->start_maintenance(full_check)) {
    rime_api->deploy_config_file("ibus_rime.yaml", "config_version");
  } else {
    // Nothing changed since the last deployment, so none starts and
    // nothing else would say Rime can be used.
    g_message("Rime is ready.");
  }
}

extern "C" void ibus_rime_stop() { rime_api->finalize(); }

// The traits, engines and settings live as long as the module, which is the
// Worker's lifetime, so none is freed and RimeFinalize is never reached.
void ibusweb_module_init(IBusWebModule *) {
  rime_require_module_lua();
  rime_require_module_grammar();
  rime_require_module_octagram();
  rime_api = rime_get_api();

  RIME_STRUCT_INIT(RimeTraits, traits);
  traits.shared_data_dir = kSharedDataDir;
  traits.user_data_dir = g_get_home_dir();
  traits.log_dir = "";
  traits.distribution_name = "Rime";
  traits.distribution_code_name = "ibus-rime";
  traits.distribution_version = IBUS_RIME_VERSION;
  traits.app_name = "rime.ibus";

  ibusweb_rime_settings_init();
  rime_api->set_notification_handler(Notify, nullptr);
  rime_api->setup(&traits);

  // Setup sent everything to stderr; the sink takes it instead.
  FLAGS_logtostderr = false;
  FLAGS_stderrthreshold = google::NUM_SEVERITIES;
  google::AddLogSink(new GLibSink);

  // The page's picker switches schemas. Switching inside Rime to one whose
  // data this Worker hasn't installed would fail, so Rime's menu offers
  // only the session's own schema, which it lists whatever the filter
  // says, and a new session starts with no schema until the engine selects
  // its own.
  rime::Switcher::SetSchemaListFilter(
      [](const std::string &) { return false; });

  ibus_rime_start(FALSE);
  ibus_rime_load_settings();

  // The factory has no bus connection and the runtime's registry keeps it,
  // so the module drops its own reference once the engines are added.
  IBusFactory *factory =
      IBUS_FACTORY(g_object_ref_sink(ibus_factory_new(nullptr)));
#define IBUSWEB_RIME_ADD_ENGINE(schema_id)                                     \
  ibus_factory_add_engine(factory, "rime:" schema_id, IBUS_TYPE_RIME_ENGINE);
  IBUSWEB_RIME_SCHEMAS(IBUSWEB_RIME_ADD_ENGINE)
#undef IBUSWEB_RIME_ADD_ENGINE
  g_object_unref(factory);
}
```

- [ ] **Step 4: Write the recipe**

Create `engines/rime/_package.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  lib,
  stdenv,
  runCommand,
  pkg-config,
  glib,
  libibus-web,
  librime,
  ibus-engines,
  ibus-web-boost-headers,
  ibus-web-rime-data,
  sideModuleFlags,
  sideModuleLibraryGuard,
  # The schemas to deploy and register as engines; their dependencies
  # deploy whether listed or not. Every engine of the schema table by
  # default.
  schemas ? null,
}:
let
  data = ibus-web-rime-data.override { inherit schemas; };
  inherit (data) common descriptors;

  # The engine's schemas and the panel's, compiled together.
  settingsSchemas = runCommand "ibus-web-rime-gsettings-schemas" { } ''
    mkdir -p $out/share/glib-2.0/schemas
    cp ${./org.freedesktop.ibus.engine.rime.gschema.xml} $out/share/glib-2.0/schemas/org.freedesktop.ibus.engine.rime.gschema.xml
    cp ${libibus-web}/share/gsettings-schemas/${libibus-web.name}/glib-2.0/schemas/org.freedesktop.ibus.gschema.xml \
      $out/share/glib-2.0/schemas/
    ${glib.dev}/bin/glib-compile-schemas --strict $out/share/glib-2.0/schemas
  '';
  settingsSchemaDir = "${settingsSchemas}/share/glib-2.0/schemas";

  # Both directories are compiled in as store paths, which makes them the
  # side module's data closure.
  defines = [
    "'-DIBUSWEB_RIME_SHARED_DATA_DIR=\"${common}\"'"
    "'-DIBUSWEB_SETTINGS_SCHEMA_DIR=\"${settingsSchemaDir}\"'"
    "-I${descriptors}"
    "-I${ibus-engines.rime}/include/ibus-rime"
  ];
  cxxflags = lib.concatStringsSep " " ([ "-std=c++17" ] ++ defines);
  cflags = lib.concatStringsSep " " defines;

  inputs = [
    libibus-web
    librime
    ibus-web-boost-headers
  ];
in
(stdenv.mkDerivation {
  pname = "ibus-web-rime";
  inherit (ibus-engines.rime) version;
  src = ./module;

  nativeBuildInputs = [ pkg-config ];
  buildInputs = inputs;
  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    $CXX ${cxxflags} $($PKG_CONFIG --cflags ibus-1.0 libibus-web rime libglog) -c module.cc -o module.o
    $CC ${cflags} $($PKG_CONFIG --cflags ibus-1.0 libibus-web rime) -c settings.c -o settings.o

    libs="$($PKG_CONFIG --static --libs rime)"
    source ${sideModuleLibraryGuard}
    checkSideModuleLibraries $libs

    $CXX ${sideModuleFlags} -g0 ${ibus-engines.rime}/lib/ibus-rime/rime_engine.o ${ibus-engines.rime}/lib/ibus-rime/rime_settings.o \
      module.o settings.o $libs -o rime.wasm
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 rime.wasm -t $out
    runHook postInstall
  '';

  passthru = {
    inherit (data)
      schemas
      common
      dicts
      deployment
      descriptors
      source
      ;
    inherit settingsSchemas settingsSchemaDir;
    auditCxxflags = cxxflags;
    auditCflags = cflags;
  };

  # ibus-rime's own: what links into it and the data carry licences of their
  # own.
  inherit (ibus-engines.rime) meta;
})
# The static stdenv propagates every build input, which would put the
# libraries, and everything they reference, in the module's closure.
.overrideAttrs
  {
    buildInputs = inputs;
    propagatedBuildInputs = [ ];
  }
```

In `engines/rime/overlay.nix`, insert above `          # CanCLID's loengfan`:

```nix
          ibus-web-rime = final.callPackage ./_package.nix {
            inherit (config.ibusWeb.toolchain) sideModuleFlags;
            inherit (config.ibusWeb.runtime) sideModuleLibraryGuard;
          };

```

- [ ] **Step 5: Audit the module**

In `engines/rime/cast-audit.nix`, insert after `      inherit (toolchain) pkgsWasm;`:

```nix
      rime = pkgsWasm.ibus-web-rime;
```

and inside `audits = {`, after the `ibus-rime` audit:

```nix
        module = (
          engines.castAudit {
            name = "rime-module";
            src = ./module;
            sources = [
              "module.cc"
              "settings.c"
            ];
            buildInputs = [
              pkgsWasm.libibus-web
              pkgsWasm.librime
              pkgsWasm.ibus-web-boost-headers
            ];
            pkgConfigModules = [
              "ibus-1.0"
              "libibus-web"
              "rime"
              "libglog"
            ];
            cflags = rime.auditCflags;
            allowList = ./cast-audit/module.jsonc;
          }
        );
```

Create `engines/rime/cast-audit/module.jsonc` with the same empty list as Task 2's.

- [ ] **Step 6: Run the checks to see them pass**

Run:

```bash
nix develop -c git add engines/rime
nix build .#checks.x86_64-linux.rime-imports .#checks.x86_64-linux.rime-data-closure .#checks.x86_64-linux.rime-cast-audit -L
stat -c %s $(nix build --no-link --print-out-paths .#ibus-web-rime)/rime.wasm
nix eval .#packages.x86_64-linux --apply 'p: builtins.length (builtins.filter (n: builtins.match "ibus-web-rime-dict-.*" n != null) (builtins.attrNames p))'
```

Expected: `rime-imports` prints `…/rime.wasm: 509 imported symbols, 0 missing` and `dynamic loader imports: none`; `rime-data-closure` PASSes, printing `longest link target: 114 bytes`; the cast audit PASSes, every allow-list empty; `rime.wasm` is about 3.9 MB (3,929,557 bytes in the spike); `22` dictionary packages. If the closure check names a library, a `lib`, `include` or `.a` path, a store path compiled into `rime.wasm` is the cause: `strings rime.wasm | grep /nix/store` shows it.

- [ ] **Step 7: Update the docs**

In `docs/rime.md`, in `### ibus-rime`, append the paragraph:

```markdown
`rime.wasm` links the objects, the module's sources (`module/module.cc`, `module/settings.c`) and librime with its
libraries. Its closure, which its distribution carries, is itself, the common path, the dictionary paths and the
compiled settings schemas.
```

Insert above `## Checks`:

````markdown
## Startup

`ibusweb_module_init` does what ibus-rime's `main()` does without a bus:

1. fills `RimeTraits`: the shared data directory the common path, compiled in; the user data directory
   `g_get_home_dir()`, which the host makes `/engines/<name>`; `log_dir` empty; the distribution `Rime`, `ibus-rime`,
   ibus-rime's version; the app `rime.ibus`;
2. writes the YAML its settings generate ([Settings](#settings));
3. sets the notification handler;
4. calls `RimeSetup`, routes glog into GLib's log, and sets the switcher's filter;
5. calls `RimeInitialize` and `RimeStartMaintenance(False)`, which checks the user directory against the shared one on
   the deployer thread, then deploys `ibus_rime.yaml` and loads ibus-rime's settings, as `rime_main.c` does;
6. registers each shipped schema's engine with the factory.

Rime logs through glog, which goes to stderr when `log_dir` is empty. The module adds a `LogSink` that sends each
message to `g_log` in the domain `Rime` (INFO as info, WARNING as a warning, ERROR and FATAL as criticals), and turns
glog's stderr off, so Rime's messages reach the page as `Log` records. The notification handler logs
`Rime is under maintenance ...` when a deployment starts and `Rime is ready.` (or the warning
`Rime has encountered an error.`) when it ends, from the pumping thread, where it reloads ibus-rime's settings and ends
every session. A session keeps the configs it was made with, so each engine makes a new one at its next key, with the
deployed configs. When no deployment starts, startup logs `Rime is ready.` itself. While maintenance runs, Rime's
service is disabled and keys pass through unhandled, as on the desktop.

The module lives as long as its Worker; `RimeFinalize` is never reached. ibus-rime's "Deploy" property calls the
module's `ibus_rime_stop` and `ibus_rime_start(TRUE)`, which finalize Rime and start it again with a full check.

## Engines

Each shipped schema is an engine, `rime:<schema_id>`. ibus-rime's port patch 0002 makes an engine's first session once
it is constructed, when its `engine-name` is set, and selects the named schema in every session it makes. The switcher
filter rejects every schema, so a new session starts with Rime's default configuration until the engine selects its own,
and loads no other schema's dictionaries.

The default build ships 47 engines: the mainstream schemas first, `rime:rime_ice` (the default), `rime-ice`'s seven
Double Pinyin schemes, `luna_pinyin`, `terra_pinyin`, `bopomofo`, `cangjie5`, `quick5`, `wubi86`, `stroke`, `jyut6ping3`
and `wugniu`, then every other `rime-data` schema by id. Five schemas are deployed only as dependencies: `loengfan`,
`rime-ice`'s `melt_eng` and `radical_pinyin`, and `rime-data`'s helpers `array30_query` and `array30_wsymbols`, which
have no punctuator, which Rime warns of when a session opens them. `rime-ice`'s `t9` isn't deployed: it needs a
`t9_processor` that only Rime's mobile front ends have.

| Engine             | Dictionaries (`engine-data.json`)                                               |
| ------------------ | ------------------------------------------------------------------------------- |
| `rime:rime_ice`    | `rime_ice`, `melt_eng`, `radical_pinyin` (the Double Pinyin engines share them) |
| `rime:luna_pinyin` | `luna_pinyin`, `stroke`                                                         |
| `rime:cangjie5`    | `cangjie5`, `luna_pinyin`, `stroke`                                             |
| `rime:jyut6ping3`  | `jyut6ping3`, `luna_pinyin`, `stroke`, `loengfan`, `cangjie5`                   |
| `rime:array30`     | `array30`, `array30_wsymbols`, `luna_pinyin`, `stroke`, `array30_query`         |

The 22 dictionary paths come to about 290 MB compiled: `rime_ice` 61 MB, `jyut6ping3` 28 MB, `loengfan` 25 MB; the
common path is 4 MB and `rime.wasm` 3.9 MB.

### Selecting schemas

`_package.nix` and `_data.nix` take `schemas`, the schema ids to deploy and register; by default, every engine of the
table. A build can ship fewer:

```nix
pkgsWasm.ibus-web-rime.override { schemas = [ "rime_ice" "luna_pinyin" "jyut6ping3" ]; }
```

The list reaches everything built from it: the generated `default.yaml`, the deployment and its dictionary paths, the
descriptors and the engines the module registers. Dependencies are deployed whether listed or not. An id the table
doesn't have, or one listed twice, fails evaluation.

## Switches as properties

ibus-rime's port patch 0003 registers the session's schema's switches as properties, after ibus-rime's own (`InputMode`,
`deploy`, `sync`), each time it makes a session:

- a switch with a name is a toggle keyed `rime:option:<name>` (`rime:option:ascii_mode`, `rime:option:full_shape`,
  `rime:option:simplification`, …), labelled with its current state's label;
- a switch of several options is a menu keyed `rime:options:<index>`, labelled with the current option's state label,
  holding a radio property per option, keyed `rime:option:<option>`.

Rime's `option` notifications update the property's state and label (and a radio's menu). `PropertyActivate` sets the
option to the state asked for; choosing an option of a menu turns the group's others off. A page that wants its own
controls reads these from the `panel` events and sends `PropertyActivate`, without placing `panel.properties`. To take
Rime's own controls away, the settings empty `switcher-hotkeys` and set `ascii-toggle-key` to `none`. Rime's menu (F4,
Ctrl+`) keeps its option items but lists only the engine's own schema.

## Settings

Rime is configured by YAML patches in its user directory. The module takes its settings from GSettings and writes the
patches itself, at startup and on every `changed` signal. A key the page hasn't stored writes nothing, so its default is
Rime's own configuration; a file is written only when its content differs and removed when it would be empty.

| Key (`org.freedesktop.ibus.engine.rime`)         | Writes                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `page-size`                                      | `default.custom.yaml`: `menu/page_size`                                                                          |
| `switcher-hotkeys`                               | `default.custom.yaml`: `switcher/hotkeys`; empty turns the menu off                                              |
| `ascii-toggle-key`                               | `default.custom.yaml`: `ascii_composer/switch_key` for `shift` (the default's), `caps-lock`, `control` or `none` |
| `inline-preedit`, `preedit-style`, `cursor-type` | `ibus_rime.custom.yaml`: `style/inline_preedit`, `style/preedit_style`, `style/cursor_type`                      |
| `traditional`                                    | Each `rime-ice` schema's `<id>.custom.yaml`: the `traditionalization` switch's `reset`                           |
| `fuzzy-pinyin`                                   | `rime-ice`'s Pinyin schemas' `<id>.custom.yaml`: `speller/algebra`, the chosen rules before the schema's own     |

`fuzzy-pinyin`'s choices are the 35 rules `rime-ice`'s speller carries commented out, named for the sound typed and the
one it also stands for (`zh-z` lets z, c and s stand for zh, ch and sh). They go before the schema's own algebra, which
Double Pinyin begins by converting the full spellings, so the whole list is written. The relocatable
`org.freedesktop.ibus.engine.rime.schema`, at `/org/freedesktop/ibus/engine/rime/<schema_id>/` for each engine, holds
`full-shape`, `ascii-punct` and `simplification`, written as the `reset` of the schema's switch of that name; for a
switch of several options, `simplification` true selects that option and false leaves the schema's own.

When a patch changed, the module starts maintenance with a full check, since a check for modifications compares whole
seconds and misses a patch written in the second the last deployment ended, then deploys `ibus_rime.yaml`. A change that
arrives during maintenance is written at once and deployed when it ends. The deployment recompiles the configs into
`/engines/<name>/build`, rebuilds the prisms whose config changed and reuses the prebuilt tables; Rime's sessions end
when it does, and an open context takes the change up at its next key. A change that touches `default.custom.yaml`
recompiles every schema, about 3 s under Node.
````

In its `## Checks` table, replace the `rime-cast-audit` row's cell with `librime, librime-lua, librime-octagram, LevelDB, yaml-cpp, OpenCC, glog, MARISA, Lua, ibus-rime and the module, each against its own allow-list, all empty`, and add below it:

```markdown
| `rime-imports`      | `rime.wasm` imports only what the runtime exports, and nothing of the dynamic loader                                     |
| `rime-data-closure` | The closure is the module, the common path, the dictionary paths and the compiled schemas, all of them data; it prints the longest link target |
```

In `docs/engines.md`, append:

````markdown
## Rime

`engines/rime/` is ibus-rime with librime, its Lua and grammar plugins and their libraries in one side module,
`rime.wasm`, built through nixpkgs' CMake recipes, with `rime-data`, `rime-loengfan` and `rime-ice` deployed at build
time by librime's own deployer, built for WebAssembly. Its 47 engines, `rime:<schema_id>`, are the schemas that type,
and their descriptors come from the deployed configs, read through librime. [rime.md](rime.md) describes its build,
deployment, startup, engines, settings, switches as properties and checks.

```sh
nix build .#ibus-web-rime
nix build .#checks.x86_64-linux.rime-golden
```
````

In `docs/known-gaps.md`, section "Engines and page integration", replace

```markdown
- **Connection-time callback audit.** The current cast audit sees explicit casts; it cannot establish every connected
  handler's arity. Hangul needs no lazy arity bridge; Rime still needs its own audit.
```

with

```markdown
- **Connection-time callback audit.** The current cast audit sees explicit casts; it cannot establish every connected
  handler's arity. Hangul needs no lazy arity bridge, and Rime's only connected handlers are the module's own
  GSettings `changed` handlers.
```

and insert above `- **Table sessions each copy their candidate list.**`:

```markdown
- **A change to Rime's page size or keys recompiles every schema.** `default.custom.yaml` reaches every compiled schema,
  so changing `page-size`, `switcher-hotkeys` or `ascii-toggle-key` recompiles them all and rebuilds every installed
  dictionary's prisms in the user's directory, about 3 s on Rime's deployer thread under Node, during which keys pass
  through ([rime.md](rime.md#settings)).
- **Rime's links are longer than a data archive holds.** The common path's links into the dictionary paths reach 114
  bytes, past ustar's 100 (above), so a Rime distribution needs archives and an installer that carry longer link
  targets ([rime.md](rime.md#deployment)).
```

Run: `nix develop -c oxfmt docs/rime.md docs/engines.md docs/known-gaps.md`

- [ ] **Step 8: Commit**

```bash
nix develop -c git add engines/rime docs/rime.md docs/engines.md docs/known-gaps.md
nix develop -c git commit -m "feat(rime): build the Rime side module" -- engines/rime docs/rime.md docs/engines.md docs/known-gaps.md
```

---

## Milestone D: under Node

Tasks 8–11 drive the real module through the runtime under Node.

### Task 8: `rime-golden`

g_test cases under Node with the real module and data, through the runtime: conversion, schemas, chords, paging and clicks, switch properties, the switcher, and every setting, each deployed and reaching an open context.

**Files:**
- Create: `engines/rime/checks/golden/checks.nix`, `harness.h`, `harness.c`, `golden.c`
- Docs: `docs/rime.md`

**Interfaces:**
- Consumes: `ibusWeb.engines.rime` (Task 7), `runtime.libibusWeb`, `testing.program`, `testing.programs`, `ibusWeb.lib.testLinkFlagsWithoutNodeFs`.
- Produces: `checks.rime-golden`; the harness the other Rime checks compile (`engines/rime/checks/golden/harness.{h,c}`):

```c
void golden_init(const gchar *schemas_dir, const gchar *module,
                 const gchar *instances, const gchar *home,
                 const gchar *const *store_paths);
void golden_mount(const gchar *store_path);
void golden_mount_host(const gchar *mount_point);
void golden_wait_log(Fixture *fixture, const gchar *message);
void golden_wait_file(const gchar *path, const gchar *text);
void golden_chord(Fixture *fixture, const gchar *keys);
void golden_reset(Fixture *fixture, const gchar *schema, const gchar *path);
```

beside m17n's `golden_setup`, `golden_teardown`, `golden_make`, `golden_create`, `golden_destroy`, `golden_clear`, `golden_request`, `golden_empty_request`, `golden_key`, `golden_type`, `golden_surrounding`, `golden_setting`, `golden_count`, `golden_index`, `golden_last`, `golden_object`, `golden_committed` and `golden_preedit`.

The harness starts as m17n's (`engines/m17n/checks/golden/harness.{h,c}`) and differs in what Rime needs: the home directory and the store's mounts are arguments; it waits for Rime to be ready, pumping and serving the calls Rime's threads proxy to it; it types capitals with Shift and presses chords; and it tolerates warnings during a deployment only. `golden_init`'s Init declares every instance with nothing stored, since the module writes Rime's YAML only for stored values.

- [ ] **Step 1: Write the harness**

Create `engines/rime/checks/golden/harness.h`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <ibus.h>

#define RIME_SCHEMA "org.freedesktop.ibus.engine.rime"
#define RIME_SCHEMA_SCHEMA RIME_SCHEMA ".schema"
#define RIME_PATH "/org/freedesktop/ibus/engine/rime/"
#define RIME_SCHEMA_PATH(id) RIME_PATH id "/"
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

void golden_init(const gchar *schemas_dir, const gchar *module,
                 const gchar *instances, const gchar *home,
                 const gchar *const *store_paths);
void golden_mount(const gchar *store_path);
void golden_mount_host(const gchar *mount_point);
void golden_wait_file(const gchar *path, const gchar *text);
void golden_wait_log(Fixture *fixture, const gchar *message);
void golden_setup(Fixture *fixture, gconstpointer data);
void golden_teardown(Fixture *fixture, gconstpointer data);
void golden_make(Fixture *fixture, const gchar *engine);
void golden_create(Fixture *fixture, const gchar *engine);
void golden_destroy(Fixture *fixture);
void golden_clear(Fixture *fixture);
gint golden_request(Fixture *fixture, guint16 kind, GVariant *payload);
void golden_empty_request(Fixture *fixture, guint16 kind);
gint golden_key(Fixture *fixture, guint keyval, guint keycode, guint modifiers);
void golden_type(Fixture *fixture, const gchar *keys);
void golden_chord(Fixture *fixture, const gchar *keys);
void golden_surrounding(Fixture *fixture, const gchar *text, guint cursor);
void golden_setting(Fixture *fixture, const gchar *path, const gchar *key,
                    GVariant *value);
void golden_reset(Fixture *fixture, const gchar *schema, const gchar *path);
guint golden_count(Fixture *fixture, guint16 kind);
gint golden_index(Fixture *fixture, guint16 kind);
Record *golden_last(Fixture *fixture, guint16 kind);
IBusSerializable *golden_object(Record *record, GType type);
gchar *golden_committed(Fixture *fixture);
gchar *golden_preedit(Fixture *fixture);
```

Create `engines/rime/checks/golden/harness.c`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "harness.h"
#include <emscripten/wasmfs.h>
#include <glib/gstdio.h>
#include <string.h>
#include <sys/stat.h>

backend_t wasmfs_create_root_dir(void) {
  return wasmfs_create_memory_backend();
}

/* Whether Rime is deploying, between the messages its notification handler
 * logs: a deployment warns of files a user directory lacks and of the data's
 * own quirks, which the cases report without failing on. */
static gboolean deploying = TRUE;

/* A Log record's message, or "" for any other record. */
static const gchar *message_of(Record *record) {
  if (record->kind != IBUSWEB_REC_LOG)
    return "";
  const gchar *message;
  g_variant_get(record->payload, "(u&s&s)", NULL, NULL, &message);
  return message;
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
      if (g_str_equal(message, "Rime is under maintenance ..."))
        deploying = TRUE;
      if (deploying && (level & G_LOG_LEVEL_WARNING))
        g_test_message("Deploying (%s): %s", domain, message);
      else if (level &
               (G_LOG_LEVEL_WARNING | G_LOG_LEVEL_CRITICAL | G_LOG_LEVEL_ERROR))
        g_error("Unexpected engine log (%s): %s", domain, message);
    }
    if (g_str_equal(message_of(record), "Rime is ready."))
      deploying = FALSE;
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
  } rows[] = {{"1234567890", 2},
              {"qwertyuiop", 16},
              {"asdfghjkl", 30},
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

/* ASCII's printable keysyms are its code points; a capital is its letter's
 * key with Shift held. */
void golden_type(Fixture *fixture, const gchar *keys) {
  for (const gchar *c = keys; *c != '\0'; c++) {
    guint modifiers = g_ascii_isupper(*c) ? IBUS_SHIFT_MASK : 0;
    g_assert_cmpint(golden_key(fixture, (guchar)*c,
                               keycode(g_ascii_tolower(*c)), modifiers),
                    ==, 1);
  }
}

/* Presses every key, then releases every key: a chord. */
void golden_chord(Fixture *fixture, const gchar *keys) {
  for (const gchar *c = keys; *c != '\0'; c++)
    golden_request(fixture, IBUSWEB_REQ_PROCESS_KEY_EVENT,
                   g_variant_new("(uuu)", (guchar)*c, keycode(*c), 0));
  for (const gchar *c = keys; *c != '\0'; c++)
    golden_request(
        fixture, IBUSWEB_REQ_PROCESS_KEY_EVENT,
        g_variant_new("(uuu)", (guchar)*c, keycode(*c), IBUS_RELEASE_MASK));
}

void golden_surrounding(Fixture *fixture, const gchar *text, guint cursor) {
  IBusText *surrounding = g_object_ref_sink(ibus_text_new_from_string(text));
  GVariant *serialized =
      ibus_serializable_serialize(IBUS_SERIALIZABLE(surrounding));
  g_assert_cmpint(
      golden_request(fixture, IBUSWEB_REQ_SET_SURROUNDING_TEXT,
                     g_variant_new("(vuu)", serialized, cursor, cursor)),
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
void golden_reset(Fixture *fixture, const gchar *schema_id, const gchar *path) {
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();
  g_autoptr(GSettingsSchema) schema =
      g_settings_schema_source_lookup(source, schema_id, TRUE);
  g_assert_nonnull(schema);
  g_auto(GStrv) names = g_settings_schema_list_keys(schema);
  for (gchar **name = names; *name != NULL; ++name) {
    g_autoptr(GSettingsSchemaKey) key =
        g_settings_schema_get_key(schema, *name);
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
static GVariant *instances_from(const gchar *path) {
  g_autofree gchar *contents = NULL;
  g_assert_true(g_file_get_contents(path, &contents, NULL, NULL));
  g_auto(GStrv) lines = g_strsplit(contents, "\n", -1);
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();

  GVariantBuilder instances;
  g_variant_builder_init(&instances, G_VARIANT_TYPE("a(ssa{sv})"));
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
    g_variant_builder_add(&instances, "(ss@a{sv})", parts[0], instance,
                          g_variant_new_array(G_VARIANT_TYPE("{sv}"), NULL, 0));
  }
  return g_variant_builder_end(&instances);
}

static gint32 wake_word;

/* Pumps, running what other threads proxy here, until a Log record carries
 * message. Rime's deployer reads the store through this thread. */
void golden_wait_log(Fixture *fixture, const gchar *message) {
  gint64 deadline = g_get_monotonic_time() + 300 * G_USEC_PER_SEC;
  for (guint seen = 0;;) {
    for (; seen < fixture->records->len; seen++) {
      if (g_str_equal(message_of(g_ptr_array_index(fixture->records, seen)),
                      message))
        return;
    }
    g_assert_cmpint(g_get_monotonic_time(), <, deadline);
    gint32 word = g_atomic_int_get(&wake_word);
    gint32 delay = ibusweb_pump();
    g_assert_cmpint(delay, !=, IBUSWEB_PUMP_ERROR);
    collect(fixture);
    ibusweb_wait(word, delay < 0 || delay > 50 ? 50 : delay);
  }
}

/* Makes one store path readable, as installing its archive would. */
void golden_mount(const gchar *store_path) {
  g_assert_cmpint(wasmfs_create_directory(
                      store_path, 0777, wasmfs_create_node_backend(store_path)),
                  ==, 0);
}

/* Mounts the program's working directory, which the programs of a sequence
 * share, at mount_point. */
void golden_mount_host(const gchar *mount_point) {
  g_assert_cmpint(wasmfs_create_directory(mount_point, 0777,
                                          wasmfs_create_node_backend(".")),
                  ==, 0);
}

/* The store is the host's, or, given store_paths, only those paths, which
 * golden_mount adds to. */
/* Waits, running what other threads proxy here, until the file at path
 * holds text. */
void golden_wait_file(const gchar *path, const gchar *text) {
  gint64 deadline = g_get_monotonic_time() + 60 * G_USEC_PER_SEC;
  for (;;) {
    g_autofree gchar *contents = NULL;
    if (g_file_get_contents(path, &contents, NULL, NULL) &&
        strstr(contents, text) != NULL)
      return;
    g_assert_cmpint(g_get_monotonic_time(), <, deadline);
    ibusweb_wait(g_atomic_int_get(&wake_word), 50);
  }
}

void golden_init(const gchar *schemas_dir, const gchar *module,
                 const gchar *instances, const gchar *home,
                 const gchar *const *store_paths) {
  g_assert_cmpint(mkdir("/nix", 0777), ==, 0);
  if (store_paths == NULL) {
    g_assert_cmpint(
        wasmfs_create_directory("/nix/store", 0777,
                                wasmfs_create_node_backend("/nix/store")),
        ==, 0);
  } else {
    g_assert_cmpint(mkdir("/nix/store", 0777), ==, 0);
    for (const gchar *const *path = store_paths; *path != NULL; path++)
      golden_mount(*path);
  }
  g_autofree gchar *directory = g_path_get_dirname(module);
  g_assert_cmpint(wasmfs_create_directory(
                      "/sides", 0777, wasmfs_create_node_backend(directory)),
                  ==, 0);
  g_setenv("GSETTINGS_SCHEMA_DIR", schemas_dir, TRUE);
  g_unsetenv("GSETTINGS_BACKEND");
  g_setenv("G_MESSAGES_DEBUG", "all", TRUE);
  g_setenv("HOME", home, TRUE);
  g_assert_cmpint(g_mkdir_with_parents(home, 0777), ==, 0);
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, 0);

  Fixture fixture = {.records = g_ptr_array_new_with_free_func(record_free)};
  g_assert_cmpint(
      golden_request(&fixture, IBUSWEB_REQ_INIT,
                     g_variant_new("(u@a(ssa{sv}))", IBUSWEB_PROTOCOL_VERSION,
                                   instances_from(instances))),
      ==, 0);
  g_log_set_default_handler(g_log_default_handler, NULL);
  /* g_test_init makes warnings fatal where they're logged, which would end
   * the run at the first deployment's. The records are checked instead. */
  g_log_set_always_fatal(G_LOG_FATAL_MASK | G_LOG_LEVEL_CRITICAL);
  g_autofree gchar *name = g_path_get_basename(module);
  g_autofree gchar *side = g_build_filename("/sides", name, NULL);
  g_assert_cmpint(ibusweb_load_module(side, NULL), ==, 0);
  collect(&fixture);

  /* Keys pass through while Rime deploys, as it does at its first start. */
  golden_wait_log(&fixture, "Rime is ready.");
  g_ptr_array_unref(fixture.records);
}
```

- [ ] **Step 2: Write the cases**

Create `engines/rime/checks/golden/golden.c`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "harness.h"

static void committed(Fixture *fixture, const gchar *expected) {
  g_autofree gchar *text = golden_committed(fixture);
  g_assert_cmpstr(text, ==, expected);
}

static void preedit(Fixture *fixture, const gchar *expected) {
  g_autofree gchar *text = golden_preedit(fixture);
  g_assert_cmpstr(text, ==, expected);
}

/* The candidates on the latest table's page, without the empty one
 * ibus-rime appends to show there is a next page. */
static void candidates(Fixture *fixture, const gchar *const *expected,
                       guint page_size) {
  IBusLookupTable *table = IBUS_LOOKUP_TABLE(
      golden_object(golden_last(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE),
                    IBUS_TYPE_LOOKUP_TABLE));
  g_assert_cmpuint(ibus_lookup_table_get_page_size(table), ==, page_size);
  guint count = g_strv_length((gchar **)expected);
  g_assert_cmpuint(ibus_lookup_table_get_number_of_candidates(table), >=,
                   count);
  for (guint i = 0; i < count; i++)
    g_assert_cmpstr(ibus_lookup_table_get_candidate(table, i)->text, ==,
                    expected[i]);
  g_object_unref(table);
}

static gint key(Fixture *fixture, guint keyval, guint keycode) {
  return golden_key(fixture, keyval, keycode, 0);
}

static void escape(Fixture *fixture) {
  g_assert_cmpint(key(fixture, IBUS_Escape, 1), ==, 1);
  golden_clear(fixture);
}

static void activate(Fixture *fixture, const gchar *name, guint state) {
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_PROPERTY_ACTIVATE,
                                 g_variant_new("(su)", name, state)),
                  ==, 0);
}

/* The last UpdateProperty for key: its state and label. */
static void updated(Fixture *fixture, const gchar *key_name, guint state,
                    const gchar *label) {
  IBusProperty *found = NULL;
  for (guint i = 0; i < fixture->records->len; ++i) {
    Record *record = g_ptr_array_index(fixture->records, i);
    if (record->kind != IBUSWEB_REC_UPDATE_PROPERTY)
      continue;
    IBusProperty *prop =
        IBUS_PROPERTY(golden_object(record, IBUS_TYPE_PROPERTY));
    if (g_str_equal(ibus_property_get_key(prop), key_name)) {
      g_clear_object(&found);
      found = prop;
    } else {
      g_object_unref(prop);
    }
  }
  g_assert_nonnull(found);
  g_assert_cmpuint(ibus_property_get_state(found), ==, state);
  g_assert_cmpstr(ibus_property_get_label(found)->text, ==, label);
  g_object_unref(found);
}

static guint updates(Fixture *fixture, const gchar *key_name) {
  guint count = 0;
  for (guint i = 0; i < fixture->records->len; ++i) {
    Record *record = g_ptr_array_index(fixture->records, i);
    if (record->kind != IBUSWEB_REC_UPDATE_PROPERTY)
      continue;
    IBusProperty *prop =
        IBUS_PROPERTY(golden_object(record, IBUS_TYPE_PROPERTY));
    count += g_str_equal(ibus_property_get_key(prop), key_name);
    g_object_unref(prop);
  }
  return count;
}

/* A setting the module writes into Rime's YAML, which takes effect once
 * the deployment it starts has ended. */
static void deployed_setting(Fixture *fixture, const gchar *path,
                             const gchar *key_name, GVariant *value) {
  golden_clear(fixture);
  golden_setting(fixture, path, key_name, value);
  golden_wait_log(fixture, "Rime is ready.");
  golden_clear(fixture);
}

static void nihao(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "nihao");
  preedit(fixture, "你好");
  candidates(fixture, (const gchar *[]){"你好", NULL}, 5);
  golden_type(fixture, " ");
  committed(fixture, "你好");
}

/* A corpus sentence, converted whole as the first candidate. The preview
 * shows it without committing, so nothing is learned. */
static void sentence(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture,
              "tachengfeijiqulezhijiagezainaliouranyujianleyigepengyou");
  preedit(fixture, "他乘飞机去了芝加哥在那里偶然遇见了一个朋友");
  escape(fixture);
  committed(fixture, "");
}

/* rime-ice's Lua translators run: U and a code point types the character. */
static void lua(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "U4e00");
  preedit(fixture, "一");
}

static void luna_pinyin(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:luna_pinyin");
  golden_type(fixture, "hanzi");
  preedit(fixture, "漢字");
  escape(fixture);

  activate(fixture, "rime:option:simplification", PROP_STATE_CHECKED);
  updated(fixture, "rime:option:simplification", PROP_STATE_CHECKED, "汉字");
  golden_type(fixture, "hanzi");
  preedit(fixture, "汉字");
}

static void cangjie(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:cangjie5");
  golden_type(fixture, "a");
  candidates(fixture, (const gchar *[]){"日", "曰", NULL}, 5);
  golden_type(fixture, " ");
  committed(fixture, "日");
}

/* Jyutping, with tones as comments, and its lookup by a character's two
 * parts, loengfan's, behind r. */
static void jyutping(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:jyut6ping3");
  golden_type(fixture, "nei");
  candidates(fixture, (const gchar *[]){"你 nei5", "呢 nei1", NULL}, 5);
  escape(fixture);

  golden_type(fixture, "rmuk");
  preedit(fixture, "來");
}

static void wugniu(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:wugniu");
  golden_type(fixture, "nonsa");
  candidates(fixture, (const gchar *[]){"農啥", "農", NULL}, 5);
}

/* combo_pinyin takes keys pressed together, on their release: e and r are
 * n's initial, i its final. Stenotype abbreviates: N is ni. */
static void chords(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:combo_pinyin");
  golden_chord(fixture, "eri");
  preedit(fixture, "你");
  golden_destroy(fixture);

  golden_create(fixture, "rime:stenotype");
  golden_type(fixture, "N");
  preedit(fixture, "你");
}

/* PageDown shows the next page, and a click picks from the page shown. */
static void paging(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "zhong");
  candidates(fixture, (const gchar *[]){"中", "🀄", "种", "重", "终", NULL}, 5);
  golden_empty_request(fixture, IBUSWEB_REQ_PAGE_DOWN);
  candidates(fixture, (const gchar *[]){"众", "钟", "忠", "仲", "衷", NULL}, 5);
  golden_clear(fixture);
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CANDIDATE_CLICKED,
                                 g_variant_new("(uuu)", 1, 1, 0)),
                  ==, 0);
  committed(fixture, "钟");
}

/* Each switch is a property: two states a toggle, more a menu of radio
 * properties. */
static void properties(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_make(fixture, "rime:bopomofo");
  IBusPropList *props = IBUS_PROP_LIST(
      golden_object(golden_last(fixture, IBUSWEB_REC_REGISTER_PROPERTIES),
                    IBUS_TYPE_PROP_LIST));
  static const struct {
    const gchar *key;
    IBusPropType type;
    const gchar *label;
  } expected[] = {
      {"InputMode", PROP_TYPE_NORMAL, "中文"},
      {"deploy", PROP_TYPE_NORMAL, "部署"},
      {"sync", PROP_TYPE_NORMAL, "同步"},
      {"rime:option:ascii_mode", PROP_TYPE_TOGGLE, "中文"},
      {"rime:option:full_shape", PROP_TYPE_TOGGLE, "半角"},
      {"rime:options:2", PROP_TYPE_MENU, "傳統漢字"},
  };
  for (guint i = 0; i < G_N_ELEMENTS(expected); i++) {
    IBusProperty *prop = ibus_prop_list_get(props, i);
    g_assert_nonnull(prop);
    g_assert_cmpstr(ibus_property_get_key(prop), ==, expected[i].key);
    g_assert_cmpint(ibus_property_get_prop_type(prop), ==, expected[i].type);
    g_assert_cmpstr(ibus_property_get_label(prop)->text, ==, expected[i].label);
  }
  g_assert_null(ibus_prop_list_get(props, G_N_ELEMENTS(expected)));
  IBusPropList *options = ibus_property_get_sub_props(
      ibus_prop_list_get(props, G_N_ELEMENTS(expected) - 1));
  static const gchar *const option_keys[] = {
      "rime:option:zh_hant", "rime:option:zh_hans", "rime:option:zh_hant_tw"};
  for (guint i = 0; i < G_N_ELEMENTS(option_keys); i++) {
    IBusProperty *option = ibus_prop_list_get(options, i);
    g_assert_cmpstr(ibus_property_get_key(option), ==, option_keys[i]);
    g_assert_cmpint(ibus_property_get_prop_type(option), ==, PROP_TYPE_RADIO);
  }
  g_object_unref(props);
  golden_destroy(fixture);

  /* Choosing an option turns the group's others off and relabels the
   * menu. */
  golden_create(fixture, "rime:bopomofo");
  activate(fixture, "rime:option:zh_hans", PROP_STATE_CHECKED);
  updated(fixture, "rime:option:zh_hans", PROP_STATE_CHECKED, "简化字");
  updated(fixture, "rime:options:2", PROP_STATE_UNCHECKED, "简化字");
  golden_destroy(fixture);

  /* A toggle relabels itself, and its state reaches the conversion. */
  golden_create(fixture, "rime:rime_ice");
  activate(fixture, "rime:option:traditionalization", PROP_STATE_CHECKED);
  updated(fixture, "rime:option:traditionalization", PROP_STATE_CHECKED, "繁");
  golden_clear(fixture);
  golden_type(fixture, "hanzi");
  preedit(fixture, "漢字");
  escape(fixture);
  activate(fixture, "rime:option:traditionalization", PROP_STATE_UNCHECKED);
  updated(fixture, "rime:option:traditionalization", PROP_STATE_UNCHECKED,
          "简");
}

/* Rime's menu lists only the engine's own schema, then its options. */
static void switcher(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:luna_pinyin");
  g_assert_cmpint(key(fixture, IBUS_F4, 62), ==, 1);
  IBusLookupTable *table = IBUS_LOOKUP_TABLE(
      golden_object(golden_last(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE),
                    IBUS_TYPE_LOOKUP_TABLE));
  g_assert_cmpuint(ibus_lookup_table_get_number_of_candidates(table), ==, 2);
  g_assert_cmpstr(ibus_lookup_table_get_candidate(table, 0)->text, ==,
                  "朙月拼音");
  g_assert_cmpstr(ibus_lookup_table_get_candidate(table, 1)->text, ==,
                  "中／半／漢／。");
  g_object_unref(table);
  escape(fixture);
}

/* Shift alone switches to Latin input and back, by default. */
static void ascii_mode(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  g_assert_cmpint(key(fixture, IBUS_Shift_L, 42), ==, 0);
  updated(fixture, "rime:option:ascii_mode", PROP_STATE_CHECKED, "Ａ");
  golden_clear(fixture);
  g_assert_cmpint(key(fixture, IBUS_a, 30), ==, 0);
  g_assert_cmpint(key(fixture, IBUS_Shift_L, 42), ==, 0);
  updated(fixture, "rime:option:ascii_mode", PROP_STATE_UNCHECKED, "中");
}

/* A page-size change deploys, and an open context takes it up at its next
 * key once the deployment has ended. */
static void page_size(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "shi");
  candidates(fixture, (const gchar *[]){NULL}, 5);
  escape(fixture);

  deployed_setting(fixture, RIME_PATH, "page-size", g_variant_new_int32(7));
  golden_type(fixture, "shi");
  candidates(fixture, (const gchar *[]){NULL}, 7);
  escape(fixture);

  deployed_setting(fixture, RIME_PATH, "page-size", g_variant_new_int32(5));
}

static void no_switcher(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:luna_pinyin");
  deployed_setting(fixture, RIME_PATH, "switcher-hotkeys",
                   g_variant_new_strv(NULL, 0));
  g_assert_cmpint(key(fixture, IBUS_F4, 62), ==, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE), ==,
                   0);

  const gchar *defaults[] = {"Control+grave", "Control+Shift+grave", "F4"};
  deployed_setting(fixture, RIME_PATH, "switcher-hotkeys",
                   g_variant_new_strv(defaults, G_N_ELEMENTS(defaults)));
}

/* Presses key a second time. Caps Lock is on by then, which its press
 * carries as the lock modifier and its release no longer does. */
static void toggle_again(Fixture *fixture, guint keyval, guint keycode) {
  if (keyval != IBUS_Caps_Lock) {
    key(fixture, keyval, keycode);
    return;
  }
  golden_request(fixture, IBUSWEB_REQ_PROCESS_KEY_EVENT,
                 g_variant_new("(uuu)", keyval, keycode, IBUS_LOCK_MASK));
  golden_request(fixture, IBUSWEB_REQ_PROCESS_KEY_EVENT,
                 g_variant_new("(uuu)", keyval, keycode, IBUS_RELEASE_MASK));
}

/* Each choice of key switches to Latin input, and none does not. */
static void ascii_toggle_key(Fixture *fixture,
                             gconstpointer data G_GNUC_UNUSED) {
  static const struct {
    const gchar *choice;
    guint keyval, keycode;
  } choices[] = {
      {"control", IBUS_Control_L, 29},
      {"caps-lock", IBUS_Caps_Lock, 58},
      {"shift", IBUS_Shift_L, 42},
  };
  golden_create(fixture, "rime:rime_ice");
  for (guint i = 0; i < G_N_ELEMENTS(choices); i++) {
    deployed_setting(fixture, RIME_PATH, "ascii-toggle-key",
                     g_variant_new_string(choices[i].choice));
    key(fixture, choices[i].keyval, choices[i].keycode);
    updated(fixture, "rime:option:ascii_mode", PROP_STATE_CHECKED, "Ａ");
    golden_clear(fixture);
    toggle_again(fixture, choices[i].keyval, choices[i].keycode);
    updated(fixture, "rime:option:ascii_mode", PROP_STATE_UNCHECKED, "中");
  }

  deployed_setting(fixture, RIME_PATH, "ascii-toggle-key",
                   g_variant_new_string("none"));
  for (guint i = 0; i < G_N_ELEMENTS(choices); i++) {
    key(fixture, choices[i].keyval, choices[i].keycode);
    g_assert_cmpuint(updates(fixture, "rime:option:ascii_mode"), ==, 0);
  }
  deployed_setting(fixture, RIME_PATH, "ascii-toggle-key",
                   g_variant_new_string("shift"));
}

/* An engine's own settings set its switches' initial states. */
static void schema_settings(Fixture *fixture,
                            gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:luna_pinyin");
  deployed_setting(fixture, RIME_SCHEMA_PATH("luna_pinyin"), "simplification",
                   g_variant_new_boolean(TRUE));
  golden_type(fixture, "hanzi");
  preedit(fixture, "汉字");
  escape(fixture);
  golden_destroy(fixture);

  /* rime-ice's engines start traditional. */
  golden_create(fixture, "rime:double_pinyin_flypy");
  deployed_setting(fixture, RIME_PATH, "traditional",
                   g_variant_new_boolean(TRUE));
  golden_type(fixture, "hjzi");
  preedit(fixture, "漢字");
  escape(fixture);

  deployed_setting(fixture, RIME_PATH, "traditional",
                   g_variant_new_boolean(FALSE));
  deployed_setting(fixture, RIME_SCHEMA_PATH("luna_pinyin"), "simplification",
                   g_variant_new_boolean(FALSE));
}

/* zh-z lets z stand for zh in rime-ice's Pinyin. */
static void fuzzy_pinyin(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "zongguo");
  preedit(fixture, "总过");
  escape(fixture);

  const gchar *fuzzy[] = {"zh-z"};
  deployed_setting(fixture, RIME_PATH, "fuzzy-pinyin",
                   g_variant_new_strv(fuzzy, G_N_ELEMENTS(fuzzy)));
  golden_type(fixture, "zongguo");
  preedit(fixture, "中国");
  escape(fixture);

  deployed_setting(fixture, RIME_PATH, "fuzzy-pinyin",
                   g_variant_new_strv(NULL, 0));
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  gchar *schemas_dir = NULL, *module = NULL, *instances = NULL;
  GOptionEntry options[] = {{"schemas", 0, 0, G_OPTION_ARG_STRING, &schemas_dir,
                             "Compiled GSettings schemas directory", "DIR"},
                            {"module", 0, 0, G_OPTION_ARG_FILENAME, &module,
                             "Engine side module", "FILE"},
                            {"instances", 0, 0, G_OPTION_ARG_FILENAME,
                             &instances, "The module's settings instances",
                             "FILE"},
                            {NULL}};
  GOptionContext *context_options = g_option_context_new(NULL);
  g_option_context_add_main_entries(context_options, options, NULL);
  GError *error = NULL;
  g_assert_true(g_option_context_parse(context_options, &argc, &argv, &error));
  g_assert_no_error(error);
  g_assert_nonnull(schemas_dir);
  g_assert_nonnull(module);
  g_assert_nonnull(instances);

  golden_init(schemas_dir, module, instances, "/engines/rime", NULL);
  g_free(schemas_dir);
  g_free(module);
  g_free(instances);
  g_option_context_free(context_options);

  g_test_add("/rime/nihao", Fixture, NULL, golden_setup, nihao,
             golden_teardown);
  g_test_add("/rime/sentence", Fixture, NULL, golden_setup, sentence,
             golden_teardown);
  g_test_add("/rime/lua", Fixture, NULL, golden_setup, lua, golden_teardown);
  g_test_add("/rime/luna-pinyin", Fixture, NULL, golden_setup, luna_pinyin,
             golden_teardown);
  g_test_add("/rime/cangjie", Fixture, NULL, golden_setup, cangjie,
             golden_teardown);
  g_test_add("/rime/jyutping", Fixture, NULL, golden_setup, jyutping,
             golden_teardown);
  g_test_add("/rime/wugniu", Fixture, NULL, golden_setup, wugniu,
             golden_teardown);
  g_test_add("/rime/chords", Fixture, NULL, golden_setup, chords,
             golden_teardown);
  g_test_add("/rime/paging", Fixture, NULL, golden_setup, paging,
             golden_teardown);
  g_test_add("/rime/properties", Fixture, NULL, golden_setup, properties,
             golden_teardown);
  g_test_add("/rime/switcher", Fixture, NULL, golden_setup, switcher,
             golden_teardown);
  g_test_add("/rime/ascii-mode", Fixture, NULL, golden_setup, ascii_mode,
             golden_teardown);
  g_test_add("/rime/page-size", Fixture, NULL, golden_setup, page_size,
             golden_teardown);
  g_test_add("/rime/no-switcher", Fixture, NULL, golden_setup, no_switcher,
             golden_teardown);
  g_test_add("/rime/ascii-toggle-key", Fixture, NULL, golden_setup,
             ascii_toggle_key, golden_teardown);
  g_test_add("/rime/schema-settings", Fixture, NULL, golden_setup,
             schema_settings, golden_teardown);
  g_test_add("/rime/fuzzy-pinyin", Fixture, NULL, golden_setup, fuzzy_pinyin,
             golden_teardown);
  return g_test_run();
}
```

The expectations come from the data, run under Node in the spike: `nihao`'s first candidates `你好 👋 拟好 你 尼`; the sentence, corpus row 340077 of 5a's corpus (`tachengfeijiqulezhijiagezainaliouranyujianleyigepengyou`), converted whole as `他乘飞机去了芝加哥在那里偶然遇见了一个朋友` and read from the preview, so nothing is learned; `zhong`'s two pages `中 🀄 种 重 终` and `众 钟 忠 仲 衷`; `luna_pinyin`'s `hanzi` `漢字`, then `汉字`; Cangjie `a` `日 曰`; Jyutping `nei` `你 nei5`, `呢 nei1`, and `rmuk`, a lookup through loengfan behind `r`, `來`; Wugniu `nonsa` `農啥 農`; combo Pinyin's chord E+R+I (initial `ld`, n; final `I`, i) `你`; stenotype's `N` `你`; rime-ice's `zongguo` `总过` without fuzzy Pinyin and `中国` with `zh-z`; `double_pinyin_flypy`'s `hjzi` (Xiaohe's `hj` is han) `漢字` with `traditional`. The cases share one user directory in memory, so a candidate one commits is learned for the next: `paging` commits `钟` for `zhong`, and `page-size` types `shi` and checks only the page size.

- [ ] **Step 3: Write the check**

Create `engines/rime/checks/golden/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
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
      inherit (engines) rime;

      program = testing.program {
        name = "rime-golden";
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

        linkFlags = config.ibusWeb.lib.testLinkFlagsWithoutNodeFs ++ [
          "-sSTACK_SIZE=1MB"
          "-sDEFAULT_PTHREAD_STACK_SIZE=1MB"
        ];
        args = [
          "--schemas"
          rime.settingsSchemaDir
          "--module"
          "${rime.package}/rime.wasm"
          "--instances"
          "${rime.package.descriptors}/instances.txt"
        ];
      };
    in
    {
      checks.rime-golden = testing.programs {
        name = "rime-golden";
        programs = [ program ];
        environments = [ "node" ];
      };
    };
}
```

- [ ] **Step 4: Run it**

Run: `nix develop -c git add engines/rime/checks/golden && nix build .#checks.x86_64-linux.rime-golden -L`
Expected: PASS, 18 tests (the 17 cases and the run), in about 50 s, most of it the 16 deployments the settings cases cause. The log shows `# Deploying (Rime): …` messages: the first start's `nonexistent config file '/engines/rime/installation.yaml'` and `user.yaml`, and `rime-data`'s `circular dependencies detected in melt_eng.schema` and `combo_pinyin_layouts`, reported, not failed.

To run the program locally: `nix build` the program (`nix-store -q --references` of the check's `.drv` names it), then `node rime-golden.js $(cat rime-golden.args)` from an empty directory.

- [ ] **Step 5: Update the docs**

In `docs/rime.md`'s `## Checks` table, add above the `rime-cast-audit` row:

```markdown
| `rime-golden` | g_test cases under Node with the real module and data: `nihao` to `你好` and a 21-character corpus sentence on `rime_ice`; a Lua translator; `luna_pinyin` traditional, then simplified after its switch; Cangjie `a`; Jyutping and loengfan's lookup; Wugniu; a `combo_pinyin` chord and a stenotype abbreviation; paging and a clicked candidate; the switch properties and `PropertyActivate`; the switcher listing one schema; Shift; page size, switcher keys, each `ascii-toggle-key`, a schema's own settings, `traditional` and fuzzy Pinyin, each deployed and reaching an open context. A warning outside a deployment, or any critical, fails it |
```

and replace the paragraph below the table with:

```markdown
The golden harness waits for `Rime is ready.` before its cases, pumping and serving the calls other threads proxy to the
pumping thread: the deployer and LevelDB's thread reach the host's files through it. Warnings logged between
`Rime is under maintenance ...` and `Rime is ready.` are reported, not failed: a new user directory lacks files Rime
warns of, and `rime-data`'s configs warn of their own includes. A CMake library is audited with the flags its own
configure gives the target that builds it, from the target's `flags.make`, over the sources `compile_commands.json`
lists for the target.
```

Run: `nix develop -c oxfmt docs/rime.md`

- [ ] **Step 6: Commit**

```bash
nix develop -c git add engines/rime/checks/golden docs/rime.md
nix develop -c git commit -m "test(rime): drive the module through golden cases under Node" -- engines/rime/checks/golden docs/rime.md
```

---

### Task 9: `rime-deploy` and dictionaries installed later

The spec's open risk, a redeploy over prebuilt-only shared data, as a check; and the module starting with only its common data, as 5c installs it, which needs librime's third port patch.

**Files:**
- Create: `engines/rime/checks/deploy/checks.nix`, `engines/rime/checks/deploy/deploy.c`, `engines/rime/patches/librime/port/0003-dict_compiler-leave-a-prebuilt-table-that-isn-t-inst.patch`
- Modify: `engines/rime/patches/README.md`
- Docs: `docs/rime.md`, `docs/known-gaps.md`

**Interfaces:**
- Consumes: Task 8's harness (`golden_init` with `store_paths`, `golden_mount`, `golden_wait_log`); `rime.package.common`, `.settingsSchemas`, `.descriptors`, `.dicts`.
- Produces: `checks.rime-deploy`; librime passes over a dictionary whose prebuilt table is a dangling link.

- [ ] **Step 1: Write the failing test**

Create `engines/rime/checks/deploy/deploy.c`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "../golden/harness.h"

static gchar **dictionaries;

/* The files of Rime's staging directory with suffix, sorted. */
static gchar *staged(const gchar *suffix) {
  g_autoptr(GDir) dir = g_dir_open("/engines/rime/build", 0, NULL);
  g_assert_nonnull(dir);
  g_autoptr(GPtrArray) names = g_ptr_array_new_with_free_func(g_free);
  const gchar *name;
  while ((name = g_dir_read_name(dir)) != NULL) {
    if (g_str_has_suffix(name, suffix))
      g_ptr_array_add(names, g_strdup(name));
  }
  g_ptr_array_sort_values(names, (GCompareFunc)g_strcmp0);
  g_ptr_array_add(names, NULL);
  return g_strjoinv(" ", (gchar **)names->pdata);
}

static void preedit(Fixture *fixture, const gchar *expected) {
  g_autofree gchar *text = golden_preedit(fixture);
  g_assert_cmpstr(text, ==, expected);
}

static guint page_size(Fixture *fixture) {
  IBusLookupTable *table = IBUS_LOOKUP_TABLE(
      golden_object(golden_last(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE),
                    IBUS_TYPE_LOOKUP_TABLE));
  guint size = ibus_lookup_table_get_page_size(table);
  g_object_unref(table);
  return size;
}

/* The first deployment, with only the common data installed, compiles the
 * configs and leaves every table and prism to the prebuilt data. An
 * engine works once its dictionaries are there. */
static void without_dictionaries(Fixture *fixture,
                                 gconstpointer data G_GNUC_UNUSED) {
  g_autofree gchar *tables = staged(".bin");
  g_assert_cmpstr(tables, ==, "");
  g_autofree gchar *configs = staged(".schema.yaml");
  g_assert_true(strstr(configs, "rime_ice.schema.yaml") != NULL);

  for (gchar **path = dictionaries; *path != NULL; path++)
    golden_mount(*path);
  golden_create(fixture, "rime:luna_pinyin");
  golden_type(fixture, "hanzi");
  preedit(fixture, "漢字");
  g_assert_cmpuint(page_size(fixture), ==, 5);
}

/* A setting that changes every schema redeploys over the prebuilt data: the
 * installed dictionaries' prisms are rebuilt for the new configs, every
 * table is reused, and the prisms of dictionaries not installed wait for
 * their data. */
static void redeploy(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:luna_pinyin");
  golden_clear(fixture);
  golden_setting(fixture, RIME_PATH, "page-size", g_variant_new_int32(7));
  golden_wait_log(fixture, "Rime is ready.");
  golden_clear(fixture);

  g_autofree gchar *tables = staged(".table.bin");
  g_assert_cmpstr(tables, ==, "");
  g_autofree gchar *reverse = staged(".reverse.bin");
  g_assert_cmpstr(reverse, ==, "");
  g_autofree gchar *prisms = staged(".prism.bin");
  g_assert_true(strstr(prisms, "luna_pinyin.prism.bin") != NULL);
  g_assert_null(strstr(prisms, "rime_ice.prism.bin"));
  g_assert_null(strstr(prisms, "cangjie5.prism.bin"));

  golden_type(fixture, "hanzi");
  preedit(fixture, "漢字");
  g_assert_cmpuint(page_size(fixture), ==, 7);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  gchar *schemas_dir = NULL, *module = NULL, *instances = NULL;
  gchar **store_paths = NULL;
  GOptionEntry options[] = {
      {"schemas", 0, 0, G_OPTION_ARG_STRING, &schemas_dir,
       "Compiled GSettings schemas directory", "DIR"},
      {"module", 0, 0, G_OPTION_ARG_FILENAME, &module, "Engine side module",
       "FILE"},
      {"instances", 0, 0, G_OPTION_ARG_FILENAME, &instances,
       "The module's settings instances", "FILE"},
      {"store-path", 0, 0, G_OPTION_ARG_FILENAME_ARRAY, &store_paths,
       "A store path installed at start", "PATH"},
      {"dictionary", 0, 0, G_OPTION_ARG_FILENAME_ARRAY, &dictionaries,
       "A dictionary's store path, installed later", "PATH"},
      {NULL}};
  GOptionContext *context_options = g_option_context_new(NULL);
  g_option_context_add_main_entries(context_options, options, NULL);
  GError *error = NULL;
  g_assert_true(g_option_context_parse(context_options, &argc, &argv, &error));
  g_assert_no_error(error);
  g_assert_nonnull(store_paths);
  g_assert_nonnull(dictionaries);

  golden_init(schemas_dir, module, instances, "/engines/rime",
              (const gchar *const *)store_paths);
  g_free(schemas_dir);
  g_free(module);
  g_free(instances);
  g_strfreev(store_paths);
  g_option_context_free(context_options);

  g_test_add("/rime-deploy/without-dictionaries", Fixture, NULL, golden_setup,
             without_dictionaries, golden_teardown);
  g_test_add("/rime-deploy/redeploy", Fixture, NULL, golden_setup, redeploy,
             golden_teardown);
  return g_test_run();
}
```

Create `engines/rime/checks/deploy/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
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
      inherit (engines) rime;

      # The golden tests' harness, from their directory.
      program = testing.program {
        name = "rime-deploy";
        src = ../.;
        sources = [
          "golden/harness.c"
          "deploy/deploy.c"
        ];

        format = "tap";
        gtest = false;

        nativeBuildInputs = [ toolchain.pkgsWasm.pkg-config ];
        buildInputs = [ runtime.libibusWeb ];
        cflags = "$($PKG_CONFIG --cflags libibus-web ibus-1.0)";
        libs = "$($PKG_CONFIG --static --libs libibus-web)";

        linkFlags = config.ibusWeb.lib.testLinkFlagsWithoutNodeFs ++ [
          "-sSTACK_SIZE=1MB"
          "-sDEFAULT_PTHREAD_STACK_SIZE=1MB"
        ];

        # The common data and the compiled schemas at start, as a Worker
        # installs base data, and the descriptors the harness reads;
        # luna_pinyin's dictionaries later.
        args = [
          "--schemas"
          rime.settingsSchemaDir
          "--module"
          "${rime.package}/rime.wasm"
          "--instances"
          "${rime.package.descriptors}/instances.txt"
          "--store-path"
          "${rime.package.common}"
          "--store-path"
          "${rime.package.settingsSchemas}"
          "--store-path"
          "${rime.package.descriptors}"
          "--dictionary"
          "${rime.package.dicts.luna_pinyin}"
          "--dictionary"
          "${rime.package.dicts.stroke}"
        ];
      };
    in
    {
      checks.rime-deploy = testing.programs {
        name = "rime-deploy";
        programs = [ program ];
        environments = [ "node" ];
      };
    };
}
```

Run: `nix develop -c git add engines/rime/checks/deploy && nix build .#checks.x86_64-linux.rime-deploy -L`
Expected: FAIL, before any case: Rime's first deployment logs, as a critical,

```
** ERROR **: Unexpected engine log (Rime): dict_compiler.cc:116: neither rime_ice.dict.yaml nor rime_ice.table.bin exists.
```

and the harness aborts on it: without the dictionaries' paths, the common path's links into them dangle, and librime finds neither a source nor a table.

- [ ] **Step 2: Make librime's third port patch**

Create `engines/rime/patches/librime/port/0003-dict_compiler-leave-a-prebuilt-table-that-isn-t-inst.patch`:

```diff
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Alexis Williams <alexis@typedr.at>
Date: Sun, 11 Oct 2026 13:29:53 -0700
Subject: [PATCH] dict_compiler: leave a prebuilt table that isn't installed
 yet

A front end that downloads dictionaries when an input method is first
used can link each prebuilt table into the prebuilt data directory
before its data has arrived. Deploying then found neither a source nor
a table, logged an error and failed the deployment. A link whose target
isn't there yet is compiled once it is: sessions read the prebuilt
table as it stands, so deployment leaves it and goes on.
---
 src/rime/dict/dict_compiler.cc | 13 +++++++++++++
 1 file changed, 13 insertions(+)

diff --git a/src/rime/dict/dict_compiler.cc b/src/rime/dict/dict_compiler.cc
index af7cae0..1f22bcf 100644
--- a/src/rime/dict/dict_compiler.cc
+++ b/src/rime/dict/dict_compiler.cc
@@ -19,6 +19,7 @@
 #include <rime/dict/prism.h>
 #include <rime/dict/reverse_lookup_dictionary.h>
 #include <rime/dict/table.h>
+#include <rime/deployer.h>
 #include <rime/resource.h>
 #include <rime/service.h>
 
@@ -113,6 +114,18 @@ bool DictCompiler::Compile(const path& schema_file) {
   } else if (build_table_from_source) {
     rebuild_table = true;
   } else {
+    // A front end that installs dictionaries when they are first used links
+    // each prebuilt table before its data is there. Sessions read it once it
+    // is, so there is nothing to compile yet.
+    path prebuilt_table =
+        Service::instance().deployer().prebuilt_data_dir /
+        path(dict_name_ + ".table.bin");
+    if (std::filesystem::is_symlink(prebuilt_table) &&
+        !std::filesystem::exists(prebuilt_table)) {
+      LOG(INFO) << "prebuilt table " << prebuilt_table
+                << " is not installed yet.";
+      return true;
+    }
     LOG(ERROR) << "neither " << dict_name_ << ".dict.yaml nor " << dict_name_
                << ".table.bin exists.";
     return false;
```

- [ ] **Step 3: Run the test to see it pass**

Run: `nix develop -c git add engines/rime && nix build .#checks.x86_64-linux.rime-deploy -L`
Expected: PASS, 3 tests. librime, the tools, the deployment, the descriptors and `rime.wasm` rebuild (the patch changes only what a deployment does with a dangling link). Then run the checks that ran on the old librime again: `nix build .#checks.x86_64-linux.rime-golden .#checks.x86_64-linux.rime-descriptors .#checks.x86_64-linux.rime-cast-audit -L`, all PASS.

- [ ] **Step 4: Update the patch inventory and the docs**

In `engines/rime/patches/README.md`, add after `librime port 0002`'s row:

```markdown
| librime port 0003 | Pass over a dictionary whose prebuilt table is a symbolic link to a file not installed yet, logging at INFO, rather than failing the deployment. A front end that installs dictionaries when they are first used links them all before their data arrives; sessions read the table once it does. |
```

In `docs/rime.md`, append to the `### librime` section's last paragraph (after `` (`Switcher::SetSchemaListFilter`) ``, replacing its full stop): `; 0003 passes over a dictionary whose prebuilt table is a symbolic link not yet resolved, so a deployment succeeds before every dictionary is installed.` In `## Deployment`'s last paragraph, insert after `` in the user's `build/`. ``:

```markdown
librime's port patch 0003 lets it pass over a dictionary whose link doesn't resolve yet, so the module starts with only
the common path installed.
```

Add to its `## Checks` table, as the first row:

```markdown
| `rime-deploy` | The module started with only the common path and the compiled schemas installed: configs compiled, no table or prism written, an engine typing once its dictionaries are added; a page-size change rebuilding only the installed dictionaries' prisms and reusing every table |
```

In `docs/known-gaps.md`, insert above `- **A change to Rime's page size or keys recompiles every schema.**`:

```markdown
- **Rime's prisms for dictionaries not yet installed.** A settings change deployed while some dictionaries aren't
  installed (5c's lazy data) leaves their prisms as prebuilt, so a `fuzzy-pinyin` change reaches an engine installed
  later only at the next deployment ([rime.md](rime.md#deployment)).
```

Run: `nix develop -c oxfmt docs/rime.md docs/known-gaps.md engines/rime/patches/README.md`

- [ ] **Step 5: Commit**

```bash
nix develop -c git add engines/rime docs/rime.md docs/known-gaps.md
nix develop -c git commit -m "feat(rime): start with dictionaries not yet installed" -- engines/rime docs/rime.md docs/known-gaps.md
```

---

### Task 10: `rime-userdb`

A learned candidate surviving a restart on the same storage, a torn log record and a stale lock file, and compaction on LevelDB's own thread.

**Files:**
- Create: `engines/rime/checks/userdb/checks.nix`, `engines/rime/checks/userdb/userdb.c`
- Docs: `docs/rime.md`

**Interfaces:**
- Consumes: Task 8's harness (`golden_mount_host`, `golden_wait_file`); the test-program shim's sequences (programs named `PREFIX.1`, `PREFIX.2` share their working directory, in order).
- Produces: `checks.rime-userdb`.

- [ ] **Step 1: Write the test**

Create `engines/rime/checks/userdb/userdb.c`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "../golden/harness.h"
#include <fcntl.h>
#include <unistd.h>

/* rime_ice's user dictionary, a LevelDB database. */
#define USERDB "rime_ice.userdb"

static gchar *home;

static gchar *in_userdb(const gchar *name) {
  return g_build_filename(home, USERDB, name, NULL);
}

static gchar *first_candidate(Fixture *fixture) {
  IBusLookupTable *table = IBUS_LOOKUP_TABLE(
      golden_object(golden_last(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE),
                    IBUS_TYPE_LOOKUP_TABLE));
  gchar *text = g_strdup(ibus_lookup_table_get_candidate(table, 0)->text);
  g_object_unref(table);
  return text;
}

/* The page's third candidate, chosen, is learned. */
static void learn(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "zhong");
  g_autofree gchar *first = first_candidate(fixture);
  g_assert_cmpstr(first, ==, "中");
  golden_clear(fixture);
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CANDIDATE_CLICKED,
                                 g_variant_new("(uuu)", 2, 1, 0)),
                  ==, 0);
  g_autofree gchar *text = golden_committed(fixture);
  g_assert_cmpstr(text, ==, "种");
  golden_destroy(fixture);

  /* The program ends without closing the database, as a Worker does: the
   * write is in its log, and its lock file stays behind. */
  g_autofree gchar *lock = in_userdb("LOCK");
  g_assert_true(g_file_test(lock, G_FILE_TEST_IS_REGULAR));
}

/* A host killed mid-write leaves a torn record at the end of the log, which
 * opening the database drops. */
static void tear_log(void) {
  g_autofree gchar *dir = g_build_filename(home, USERDB, NULL);
  g_autoptr(GDir) entries = g_dir_open(dir, 0, NULL);
  g_assert_nonnull(entries);
  const gchar *name;
  guint torn = 0;
  while ((name = g_dir_read_name(entries)) != NULL) {
    if (!g_str_has_suffix(name, ".log"))
      continue;
    g_autofree gchar *path = g_build_filename(dir, name, NULL);
    int fd = open(path, O_WRONLY | O_APPEND);
    g_assert_cmpint(fd, >=, 0);
    static const guint8 partial[] = {0x12, 0x34, 0x56, 0x78, 0x40, 0x00, 0x01};
    g_assert_cmpint(write(fd, partial, sizeof partial), ==, sizeof partial);
    g_assert_cmpint(close(fd), ==, 0);
    torn++;
  }
  g_assert_cmpuint(torn, ==, 1);
}

/* After a restart on the same storage, the learned candidate comes first,
 * whatever a torn write left behind. */
static void remembered(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  tear_log();
  golden_create(fixture, "rime:rime_ice");
  golden_type(fixture, "zhong");
  g_autofree gchar *first = first_candidate(fixture);
  g_assert_cmpstr(first, ==, "种");
}

/* Each time the dictionary is opened again, LevelDB turns its log into a
 * table; at four, it compacts them on its own thread. */
static void compaction(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  static const gchar *const words[] = {"zhong", "guo", "ren", "min", "hao"};
  for (guint i = 0; i < G_N_ELEMENTS(words); i++) {
    golden_create(fixture, "rime:rime_ice");
    golden_type(fixture, words[i]);
    golden_clear(fixture);
    g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CANDIDATE_CLICKED,
                                   g_variant_new("(uuu)", 1, 1, 0)),
                    ==, 0);
    golden_destroy(fixture);
  }
  g_autofree gchar *log = in_userdb("LOG");
  golden_wait_file(log, "Compacted 4@0 + 0@1 files");
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  gchar *schemas_dir = NULL, *module = NULL, *instances = NULL, *step = NULL;
  GOptionEntry options[] = {{"schemas", 0, 0, G_OPTION_ARG_STRING, &schemas_dir,
                             "Compiled GSettings schemas directory", "DIR"},
                            {"module", 0, 0, G_OPTION_ARG_FILENAME, &module,
                             "Engine side module", "FILE"},
                            {"instances", 0, 0, G_OPTION_ARG_FILENAME,
                             &instances, "The module's settings instances",
                             "FILE"},
                            {"step", 0, 0, G_OPTION_ARG_STRING, &step,
                             "learn, remember or compact", "STEP"},
                            {NULL}};
  GOptionContext *context_options = g_option_context_new(NULL);
  g_option_context_add_main_entries(context_options, options, NULL);
  GError *error = NULL;
  g_assert_true(g_option_context_parse(context_options, &argc, &argv, &error));
  g_assert_no_error(error);
  g_assert_nonnull(step);

  /* Learning and remembering keep the user's files in the working
   * directory, which outlives each program. LevelDB's thread reaches those
   * through this one, which can't serve it while closing the database
   * waits for that thread, so compaction keeps them in memory, as the
   * IndexedDB backend's own thread would. */
  if (g_str_equal(step, "compact")) {
    home = g_strdup("/engines/rime");
  } else {
    golden_mount_host("/host");
    home = g_strdup("/host/engines/rime");
  }
  golden_init(schemas_dir, module, instances, home, NULL);
  g_free(schemas_dir);
  g_free(module);
  g_free(instances);
  g_option_context_free(context_options);

  if (g_str_equal(step, "learn"))
    g_test_add("/rime-userdb/learn", Fixture, NULL, golden_setup, learn,
               golden_teardown);
  else if (g_str_equal(step, "remember"))
    g_test_add("/rime-userdb/remember", Fixture, NULL, golden_setup, remembered,
               golden_teardown);
  else
    g_test_add("/rime-userdb/compaction", Fixture, NULL, golden_setup,
               compaction, golden_teardown);
  int result = g_test_run();
  g_free(step);
  return result;
}
```

Create `engines/rime/checks/userdb/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
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
      inherit (engines) rime;

      # One program, run as each step; the numbered ones share their
      # storage, the working directory, in order.
      program =
        name: step:
        testing.program {
          inherit name;
          derivationName = "ibus-web-test-program-${name}";
          src = ../.;
          sources = [
            "golden/harness.c"
            "userdb/userdb.c"
          ];

          format = "tap";
          gtest = false;

          nativeBuildInputs = [ toolchain.pkgsWasm.pkg-config ];
          buildInputs = [ runtime.libibusWeb ];
          cflags = "$($PKG_CONFIG --cflags libibus-web ibus-1.0)";
          libs = "$($PKG_CONFIG --static --libs libibus-web)";

          linkFlags = config.ibusWeb.lib.testLinkFlagsWithoutNodeFs ++ [
            "-sSTACK_SIZE=1MB"
            "-sDEFAULT_PTHREAD_STACK_SIZE=1MB"
          ];
          args = [
            "--schemas"
            rime.settingsSchemaDir
            "--module"
            "${rime.package}/rime.wasm"
            "--instances"
            "${rime.package.descriptors}/instances.txt"
            "--step"
            step
          ];
        };
    in
    {
      checks.rime-userdb = testing.programs {
        name = "rime-userdb";
        programs = [
          (program "rime-userdb.1" "learn")
          (program "rime-userdb.2" "remember")
          (program "rime-userdb-compaction" "compact")
        ];
        environments = [ "node" ];
      };
    };
}
```

- [ ] **Step 2: Run it**

Run: `nix develop -c git add engines/rime/checks/userdb && nix build .#checks.x86_64-linux.rime-userdb -L`
Expected: PASS, 6 tests: `rime-userdb.1` (`learn`, `run`), `rime-userdb.2` (`remember`, `run`), `rime-userdb-compaction` (`compaction`, `run`). `learn` commits `种`, the third candidate of `zhong`, and leaves `rime_ice.userdb/LOCK`; `remember` appends seven bytes of a torn record to the database's only `.log` and finds `种` first; `compaction` reopens the dictionary five times and waits until LevelDB's `LOG` says `Compacted 4@0 + 0@1 files`.

`remember` relies on `Rime is ready.` at a start that deploys nothing: `.2` starts within a second of `.1`'s deployment as often as not, and Rime then finds nothing newer than its last build. Task 7's `ibus_rime_start` logs readiness itself then; without that line the harness would wait for good whenever it happened.

- [ ] **Step 3: Update the docs**

In `docs/rime.md`'s `## Checks` table, add below the `rime-golden` row:

```markdown
| `rime-userdb` | A candidate chosen third comes first after the program restarts on the same storage, with a record torn off the log in between and LevelDB's lock file left behind; four reopenings compacted on LevelDB's own thread |
```

Run: `nix develop -c oxfmt docs/rime.md`

- [ ] **Step 4: Commit**

```bash
nix develop -c git add engines/rime/checks/userdb docs/rime.md
nix develop -c git commit -m "test(rime): keep the user dictionary across restarts" -- engines/rime/checks/userdb docs/rime.md
```

---

### Task 11: `rime-engines`

Every engine made, typed into and destroyed in one Worker.

**Files:**
- Create: `engines/rime/checks/engines/checks.nix`, `engines/rime/checks/engines/engines.c`
- Docs: `docs/rime.md`

**Interfaces:**
- Consumes: Task 8's harness; `ibusWeb.engines.rime.descriptors`.
- Produces: `checks.rime-engines`.

- [ ] **Step 1: Write the test**

Create `engines/rime/checks/engines/engines.c`:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "../golden/harness.h"

/* Making the engine loads its schema and dictionaries; the keys run it,
 * whatever it makes of them. A warning from either fails the case. */
static void engine(Fixture *fixture, gconstpointer data) {
  golden_create(fixture, data);
  golden_key(fixture, IBUS_a, 30, 0);
  golden_key(fixture, IBUS_1, 2, 0);
  golden_key(fixture, IBUS_space, 57, 0);
  golden_key(fixture, IBUS_BackSpace, 14, 0);
  golden_key(fixture, IBUS_Escape, 1, 0);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  gchar *schemas_dir = NULL, *module = NULL, *instances = NULL, *engines = NULL;
  GOptionEntry options[] = {{"schemas", 0, 0, G_OPTION_ARG_STRING, &schemas_dir,
                             "Compiled GSettings schemas directory", "DIR"},
                            {"module", 0, 0, G_OPTION_ARG_FILENAME, &module,
                             "Engine side module", "FILE"},
                            {"instances", 0, 0, G_OPTION_ARG_FILENAME,
                             &instances, "The module's settings instances",
                             "FILE"},
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
  golden_init(schemas_dir, module, instances, "/engines/rime", NULL);

  g_autofree gchar *contents = NULL;
  g_assert_true(g_file_get_contents(engines, &contents, NULL, NULL));
  /* The names are the cases' data for the whole run. */
  gchar **names = g_strsplit(g_strchomp(contents), "\n", -1);
  for (gchar **name = names; *name != NULL; name++) {
    g_autofree gchar *path = g_strdup_printf("/rime-engines/%s", *name);
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

Create `engines/rime/checks/engines/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
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
      inherit (engines) rime;

      # One engine name a line, from the descriptors the manifest lists.
      names = pkgs.runCommand "ibus-web-rime-engine-names" { nativeBuildInputs = [ pkgs.jq ]; } ''
        jq -r '.[].name' ${rime.descriptors} > $out
      '';

      # The golden tests' harness, from their directory.
      program = testing.program {
        name = "rime-engines";
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

        linkFlags = config.ibusWeb.lib.testLinkFlagsWithoutNodeFs ++ [
          "-sSTACK_SIZE=1MB"
          "-sDEFAULT_PTHREAD_STACK_SIZE=1MB"
        ];
        args = [
          "--schemas"
          rime.settingsSchemaDir
          "--module"
          "${rime.package}/rime.wasm"
          "--instances"
          "${rime.package.descriptors}/instances.txt"
          "--engines"
          "${names}"
        ];
      };
    in
    {
      checks.rime-engines = testing.programs {
        name = "rime-engines";
        programs = [ program ];
        environments = [ "node" ];
      };
    };
}
```

- [ ] **Step 2: Run it**

Run: `nix develop -c git add engines/rime/checks/engines && nix build .#checks.x86_64-linux.rime-engines -L`
Expected: PASS, 48 tests: the 47 engines and the run. An engine whose schema warns when a session opens it, or needs a component librime lacks, fails here: `array30_query` and `array30_wsymbols` (no punctuator) and `rime-ice`'s `t9` (`t9_processor`) did, which is why the table makes the first two dependencies and leaves `t9` out.

- [ ] **Step 3: Update the docs**

In `docs/rime.md`'s `## Checks` table, add below the `rime-userdb` row:

```markdown
| `rime-engines` | Every descriptor's engine made, typed into and destroyed in one Worker |
```

Run: `nix develop -c oxfmt docs/rime.md`

- [ ] **Step 4: Commit**

```bash
nix develop -c git add engines/rime/checks/engines docs/rime.md
nix develop -c git commit -m "test(rime): make every engine in one Worker" -- engines/rime/checks/engines docs/rime.md
```

---

## Milestone E: the phase

### Task 12: Verify the phase

- [ ] **Step 1: Generated files**

Run: `nix run .#write-files && git status --short`
Expected: no change.

- [ ] **Step 2: The phase's checks**

Run:

```bash
for check in marisa-tests table-golden table-host rime-deploy rime-descriptors rime-golden rime-userdb rime-engines rime-cast-audit rime-imports rime-data-closure; do
  nix build .#checks.x86_64-linux.$check -L || echo "FAILED: $check"
done
```

Expected: no `FAILED` line. Record each check's result for the hand-off.

- [ ] **Step 3: Everything else**

Run:

```bash
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all PASS. `nix flake check` builds every Rime check above and everything else; `integration-checks` exercises nothing of Rime yet (5d adds its Playwright tests), and must still pass; `hk check --all` covers clang-format, nixfmt, oxfmt, oxlint, tsc, `reuse lint` and the docs' links.

- [ ] **Step 4: Report**

Report which commands ran and their results, any check that failed and why, and the measured figures that changed from this plan's (sizes, test counts, times). Note for 5c: `ibus-web-rime-dist` must carry link targets of up to 114 bytes (`rime-data-closure` prints the figure), and `rime-host` measures the deployer's and LevelDB's threads for the manifest's `threads`.
