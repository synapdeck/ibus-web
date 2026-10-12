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

## Checks

| Check             | Covers                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `rime-cast-audit` | librime, librime-lua, librime-octagram, LevelDB, yaml-cpp, OpenCC, glog, MARISA and Lua, each against its own allow-list, all empty |

A CMake library is audited with the flags its own configure gives the target that builds it, from the target's
`flags.make`, over the sources `compile_commands.json` lists for the target.
