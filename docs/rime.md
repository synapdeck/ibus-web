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
sessions start from (`Switcher::SetSchemaListFilter`).

### ibus-rime

`ibus-engines.rime` is configured with CMake, with its port patch 0001's `ENABLE_LIBNOTIFY` off, so the build needs no
libnotify, and its data and icon directories outside the store, so nothing built from it refers to its output. From the
configured tree, `rime_engine.c` and `rime_settings.c` compile with the flags CMake wrote for the program (read from its
`flags.make`); `rime_main.c`, which connects to the bus, isn't built. The package holds the two objects, their flags,
ibus-rime's headers and `ibus_rime.yaml`.

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

## Checks

| Check              | Covers                                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rime-descriptors` | Vitest: the table checked against deployed configs, dependency resolution into `engine-data.json`, ordering, glosses, the switch and algebra tables, and what fails the build; the default build's outputs and a build of three schemas |
| `rime-cast-audit`  | librime, librime-lua, librime-octagram, LevelDB, yaml-cpp, OpenCC, glog, MARISA, Lua and ibus-rime, each against its own allow-list, all empty                                                                                          |

A CMake library is audited with the flags its own configure gives the target that builds it, from the target's
`flags.make`, over the sources `compile_commands.json` lists for the target.
