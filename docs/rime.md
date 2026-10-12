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

### librime

`librime` is built static, with its plugins merged in (`BUILD_MERGED_PLUGINS`), threading (`ENABLE_THREADING`: the
deployer runs on a `std::async` thread), logging, and its private headers installed, which the tools and the descriptor
program include. It is built without `ENABLE_TIMESTAMP`. With it, a deployment records each source file's modification
time in the compiled config and rebuilds a config whose recorded times differ from the files'. WasmFS gives a file the
time at which it first sees it, not the store's, so the times never match: every deployment would recompile every config
with new bytes and rebuild every prism, whose checksum covers the config. Without them, a deployment recompiles the
configs to the same bytes and the prebuilt prisms stay current.

librime installs no `rime.pc` outside Linux and the BSDs, so the overlay writes one, with the libraries as
`Requires.private`. A static librime registers a plugin's modules only if something refers to the plugin, so the module
calls the `rime_require_module_*` functions each defines for that. librime builds its tools only with a shared library;
`ibus-web-rime-tools` compiles `rime_deployer` and `rime_dict_manager` against the static one and links them as Node
programs on WasmFS with the host's files, with a fixed 2 GB memory, since deploying `rime_ice` peaks near 900 MB.

librime's port patches: 0001 logs a missing dictionary source at INFO, since deploying over prebuilt tables without
their sources logged an error per dictionary; 0002 lets a front end filter the schema list the switcher offers and new
sessions start from (`Switcher::SetSchemaListFilter`); 0003 passes over a dictionary whose prebuilt table is a symbolic
link not yet resolved, so a deployment succeeds before every dictionary is installed.

### ibus-rime

`ibus-engines.rime` is configured with CMake, with its port patch 0001's `ENABLE_LIBNOTIFY` off, so the build needs no
libnotify, and its data and icon directories outside the store, so nothing built from it refers to its output. From the
configured tree, `rime_engine.c` and `rime_settings.c` compile with the flags CMake wrote for the program (read from its
`flags.make`); `rime_main.c`, which connects to the bus, isn't built. The package holds the two objects, their flags,
ibus-rime's headers and `ibus_rime.yaml`.

`rime.wasm` links the objects, the module's sources (`module/module.cc`, `module/settings.c`) and librime with its
libraries. Its closure, which its distribution carries, is itself, the common path, the dictionary paths and the
compiled settings schemas.

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
librime's port patch 0003 lets it pass over a dictionary whose link doesn't resolve yet, or resolved only after it
looked for the table, as one installed during the deployment does, so the module starts with only the common path
installed. Deploying every schema takes about 35 s under Node and peaks near 900 MB; its output is reproducible
(`nix build --rebuild` finds the same bytes).

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
the table, if a schema has no gloss, or if a dependency isn't deployed. `engine-data.json` is a file of its own: the
distribution merges it into each descriptor as its `data` ([Distribution](#distribution)).

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
every session. The deployer reports the end before it checks for tasks queued meanwhile and returns, and a deployment
started before it has returned would find it still at work and never run, so the module handles the end only once it
has. A session keeps the configs it was made with, so each engine makes a new one at its next key, with the deployed
configs. Before ending them, it has every engine forget its session (ibus-rime's port patch 0004): Rime makes a
session's id from its address, so a new session can take an ended one's id, and an engine still holding that id would
type in, or end, another engine's session. When no deployment starts, startup logs `Rime is ready.` itself. While
maintenance runs, Rime's service is disabled and keys pass through unhandled, as on the desktop.

The module lives as long as its Worker and finalizes Rime only to restart it. ibus-rime's "Deploy" property calls the
module's `ibus_rime_stop` and `ibus_rime_start(TRUE)`, which forget every engine's session, finalize Rime and start it
again with a full check. `RimeFinalize` blocks until the deployer returns, which would hold the pumping thread for the
rest of a deployment and handle that deployment's end after the restart had begun, so a Deploy while the deployer works
restarts Rime once it has returned instead, and the restart's full check takes in a settings change made meanwhile.

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
arrives during maintenance is written at once and deployed when it ends and the deployer has returned. The deployment
recompiles the configs into `/engines/<name>/build`, rebuilds the prisms whose config changed and reuses the prebuilt
tables; Rime's sessions end when it does, and an open context takes the change up at its next key. A change that touches
`default.custom.yaml` recompiles every schema, about 3 s under Node.

## Distribution

`ibus-web-rime-dist` (`engines/rime/dist.nix`) is `mkEngineManifest` over `rime.wasm`, with the descriptor step's
`engines.json`, each engine given its dictionaries from `engine-data.json` as `data`, `settings-paths.json` and
`settings-schemas.json`. Its engines start with `rime:rime_ice`. Each engine's dictionaries, its schema's and those of
the schemas it depends on, are its own data ([engines.md](engines.md#an-engines-own-data)): the host installs them the
first time a page prepares or selects the engine. Of its 24 archives, two are base data, installed at start:
`ibus-web-rime-common`, with Rime's configs, OpenCC's data and `rime-ice`'s Lua scripts, and the compiled settings
schemas, 4,030,506 bytes installed and 998,854 as Brotli. The 22 dictionary paths are lazy, 289,631,136 bytes and
82,153,014 as Brotli. `rime:rime_ice`'s own come to 75,939,528 bytes and 23,865,433 as Brotli; `rime:jyut6ping3` and
`rime:jyut6ping3_ipa` name the most, 82,951,852 bytes. A dictionary several engines name, as the double-pinyin engines
name `rime_ice`'s, is installed once. `rime.wasm` is 3,932,032 bytes, and the module's memory comes to 197 MiB.

Every schema of `rime-data`, `rime-loengfan` and `rime-ice` ships, 47 engines. The distribution is a function of the
schema list: `ibus-web-rime-dist.override { schemas = [ "rime_ice" "luna_pinyin" ]; }` passes the list to the module's
recipe, and the module, its deployment, its descriptors, its dictionary paths and its settings paths follow it, so the
build has exactly those engines, each with its own lazy data and its dependencies' dictionaries. It keeps the full
build's thread and program-break declaration, which holds for any subset.

The licence is
`GPL-3.0-or-later AND BSD-3-Clause AND GPL-3.0-only AND MIT AND Apache-2.0 AND BSD-2-Clause AND BSL-1.0 AND LGPL-3.0-only AND CC-BY-4.0`:
ibus-rime's GPL-3.0-or-later; librime's, librime-lua's, LevelDB's and glog's BSD-3-Clause; librime-octagram's
GPL-3.0-only; yaml-cpp's and Lua's MIT; OpenCC's Apache-2.0; MARISA's BSD-2-Clause, the side of its dual licence the
repository takes; Boost's BSL-1.0, for its headers; and the data's: `rime-data`'s schema packages are GPL-3.0-only,
LGPL-3.0-only, Apache-2.0 and CC-BY-4.0 between them, `rime-loengfan` is CC-BY-4.0 and `rime-ice` GPL-3.0-only. The
distribution lists them from each component's `meta.license` (its `licenses` passthru) and gives the module that
`meta.license`, which `mkEngineManifest` writes. Two works are CanCLID's, under CC-BY-4.0, and compiled into Rime's
tables at build time: the Cantonese dictionary `jyut6ping3`, from
[rime-cantonese](https://github.com/rime/rime-cantonese) through `rime-data`, and `loengfan`, from
[rime-loengfan](https://github.com/CanCLID/rime-loengfan) at `987ac95b02f957e8764a2f45222a4006c188ed50`, which
`rime:jyut6ping3`'s data includes through its dependency.

The module ships as `@ibus-web/engine-rime` (`packages/engines/rime/`): `nix build .#npm.engine-rime` copies
`ibus-web-rime-dist` in as `dist/`; puts each licence's text in `LICENSES/`, the repository's where it has one,
CC-BY-4.0's from `rime-loengfan`'s own `LICENSE`, and the rest from nixpkgs' `spdx-license-list-data`, since the
repository can't hold texts nothing in it uses; adds the copyright notices the permissive licences ask to keep, under
`LICENSES/<component>/`: librime's, librime-lua's, LevelDB's and yaml-cpp's `LICENSE`, glog's `COPYING`, MARISA's
`COPYING.md`, `rime-loengfan`'s `LICENSE` and Lua's notice, which Lua keeps at the end of `lua.h`; and credits CanCLID's
`jyut6ping3` and `loengfan` in `LICENSES/ATTRIBUTION.md`, as CC-BY-4.0 asks. `npmTarball` fails unless `package.json`'s
`license` is the module's. It exports `manifest.json`, `rime.wasm`, `settings.json` and `data/*`; the tarball is 83.3
MB, the dictionaries of every schema most of it. `npm.engine-rime.override { schemas = [ … ]; }` packs a distribution
built with the same override.

It declares 2 engine threads and a 123 MiB program break: `rime-host` peaked at 124,395,520 bytes asserting and
124,329,984 released with `rime:rime_ice` and `rime:luna_pinyin` open in one Worker, since Rime maps its tables, which
WasmFS serves as copies in memory, so the break counts every dictionary the workload has open. A page-size change's
redeployment sets the peak, which varies from run to run, from 96 MB to 124 MB, with how the deployer's work overlaps
the open session's; without it the workload peaks at 102.2 MB. The workload runs one engine thread at a time, the
deployer's, but LevelDB's compaction thread stays once started, so a deployment after a compaction needs a second.

## In the browser

The demo serves the distribution beside the other modules. Its picker gives Rime's engines one group per language, as it
does any module's whose engines declare several: `rime · Chinese` for the Mandarin schemas, simplified and traditional,
and stroke, all `zh`; `rime · Cantonese` for `jyut6ping3` and `jyutping`; `rime · Wu Chinese` for `wugniu` (`rime · wuu`
in Chromium, whose language names have none for Wu); and a group for each further language the gloss table gives the
dialect, IPA and Middle Chinese schemas (`rime · ltc` for `sampheng` and `zyenpheng`, Middle Chinese, which none of the
three browsers names), with any schema it gives no language under `rime`: the IPA schemas, `und-fonipa`. The status
line's Data field follows the facade's `install` events: an engine's first selection shows its dictionaries downloading
and what it installed, and a later one, in the page or after a reload, shows nothing. The settings form shows
`org.freedesktop.ibus.engine.rime` and, of the relocatable `org.freedesktop.ibus.engine.rime.schema`, only the selected
engine's instance. A change starts Rime's maintenance; keys pass through until it ends, and the next key uses the
change.

A page that styles its own controls drives Rime's switches without its menu. The demo shows how when opened as
`/?properties=page`: it places none of the panel's properties and draws each toggle property of the focused context,
`rime:option:simplification`, `rime:option:full_shape` and the others, as a switch of its own. A switch sends
`PropertyActivate` with the other state through `sendPanelAction` and redraws from the engine's `UpdateProperty`; it
takes no focus, so the action reaches the field's context. Switches of more than two states, which are radio groups,
aren't drawn. Rime ends its sessions when its maintenance ends, and an engine registers its schema's switches with the
session it starts at its next key, so the switches appear once a key has reached Rime after the maintenance.

Rime keeps a commit's learning open, so that it can be undone, until the next key it doesn't handle, and a page that
closes or reloads ends the Worker without saving it.

`rime.spec.ts` times `rime_ice`'s first selection, from the picker to `Installed`, which takes in the module's start,
its common data and Rime's maintenance, and `rime_ice`'s 75.9 MB of dictionaries: 1,891 ms in Chromium 153.0.8010.12,
2,818 ms in Firefox 155.0 and 2,372 ms in WebKit 26.6, the second of two runs, under the Nix sandbox's Playwright on an
AMD Ryzen 9 9950X3D 16-Core Processor (32 logical CPUs), with the rest of the suite running beside it. There is no
target until there is a baseline.

## Checks

| Check                    | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rime-deploy`            | The module started with only the common path and the compiled schemas installed: configs compiled, no table or prism written, an engine typing once its dictionaries are added; a page-size change rebuilding only the installed dictionaries' prisms and reusing every table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rime-descriptors`       | Vitest: the table checked against deployed configs, dependency resolution into `engine-data.json`, ordering, glosses, the switch and algebra tables, and what fails the build; the default build's outputs and a build of three schemas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `rime-golden`            | g_test cases under Node with the real module and data: `nihao` to `你好` and a 21-character corpus sentence on `rime_ice`; a Lua translator; `luna_pinyin` traditional, then simplified after its switch; Cangjie `a`; Jyutping and loengfan's lookup; Wugniu; a `combo_pinyin` chord and a stenotype abbreviation; paging and a clicked candidate; the switch properties and `PropertyActivate`; the switcher listing one schema; Shift; page size, switcher keys, each `ascii-toggle-key`, a schema's own settings, `traditional` and fuzzy Pinyin, each deployed and reaching an open context; two engines across deployments, each typing in its own session and ending only its own; a change during a deployment deployed after it; the Deploy property, idle and during a deployment, with a change made meanwhile. A warning outside a deployment, or any critical, fails it |
| `rime-userdb`            | A candidate chosen third comes first after the program restarts on the same storage, with a record torn off the log in between and LevelDB's lock file left behind; four reopenings compacted on LevelDB's own thread                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `rime-host`              | The distribution through a Node Worker host and the test page on both runtime builds: only the base data installed at start; `rime:rime_ice`'s dictionaries installed by `PrepareEngine`, with progress ending at their total, and `nihao` committing `你好`; in one Worker, `rime:double_pinyin` finding those dictionaries present and `rime:luna_pinyin`, prepared beside it, converting `zhongguo` to `中國`; a page-size change redeploying with only `rime_ice`'s dictionaries installed and reaching the open context, warning of nothing but what a new user directory lacks and `rime-data`'s includes; and the break and thread peaks against the manifest. The module starts in 936 ms; `rime_ice`'s 75.9 MB install in 486 ms under Node                                                                                                                                 |
| `rime-engines`           | Every descriptor's engine made, typed into and destroyed in one Worker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `rime-cast-audit`        | librime, librime-lua, librime-octagram, LevelDB, yaml-cpp, OpenCC, glog, MARISA, Lua, ibus-rime and the module, each against its own allow-list, all empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `rime-imports`           | `rime.wasm` imports only what the runtime exports, and nothing of the dynamic loader                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `rime-data-closure`      | The closure is the module, the common path, the dictionary paths and the compiled schemas, all of them data; it prints the longest link target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `typescript-npm`         | Packs `@ibus-web/engine-rime` with every licence text, the notices and the attribution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `rime-dist-schemas`      | The distribution and the npm package built with `schemas = [ "luna_pinyin" "cangjie5" ]`: exactly those engines, each naming data the manifest lists, `luna_pinyin`'s including `stroke`'s dictionary and `cangjie5`'s `luna_pinyin`'s, which deploy as dependencies; and the tarball's manifest is the distribution's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `playwright-integration` | The demo serves the distribution, and `examples/demo/test/e2e/rime.spec.ts` runs in Chromium, Firefox and WebKit: Rime's language groups in the picker, worked out from the served manifest; `rime_ice`'s dictionaries installing on its first selection, with progress, and not on its second; `rime_ice` converting `nihaoshijie` whole; Cangjie 5's `日` for `a`; the page's own switch turning `luna_pinyin`'s simplification on with the panel's properties not placed; a candidate chosen third for `shi` coming first after a reload, from the user dictionary in IndexedDB; and the settings form holding Rime's fixed settings and the selected engine's switches, with a page size of 3 reaching the panel                                                                                                                                                                 |

The golden harness waits for `Rime is ready.` before its cases, pumping and serving the calls other threads proxy to the
pumping thread: the deployer and LevelDB's thread reach the host's files through it. Warnings logged between
`Rime is under maintenance ...` and `Rime is ready.` are reported, not failed: a new user directory lacks files Rime
warns of, and `rime-data`'s configs warn of their own includes. A CMake library is audited with the flags its own
configure gives the target that builds it, from the target's `flags.make`, over the sources `compile_commands.json`
lists for the target.
