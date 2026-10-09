# Mozc

`engines/mozc/` builds Mozc 2.30.5544.102, Google's open-source Japanese input method, with nixpkgs' UT dictionaries, as an
engine module: its converter, its session layer and its own IBus frontend, ibus-mozc, in one side module, `mozc.wasm`. This page
describes how it is built, how the frontend reaches the converter without `mozc_server`, the distribution and its
checks.

```sh
nix build .#ibus-web-mozc-dist
nix build .#checks.x86_64-linux.mozc-host
```

## Build

`flake.overlays.mozc`, which applies only to `pkgsWasm`, overrides nixpkgs' `mozc` recipe and keeps its Bazel build:
its source, its pinned Bazel 7, and its dependency fetch, whose output is the native recipe's, since the WebAssembly
build needs no external repository the native one lacks. Bazel and every tool it runs (protoc, the dictionary
generators) are the build machine's; Bazel configures their compiler from `$CC`, which the overlay points at the build
machine's. `withIbus` is on, with libibus-web as `ibus`; Qt is stubbed out, since the setup tool and renderer aren't
built.

The WebAssembly target is a Bazel C++ toolchain of its own, `src/ibus_web_toolchain`, installed from
`engines/mozc/bazel/`: a platform of `cpu:wasm32` and `os:none` (Bazel's platforms have no Emscripten OS) and a
`unix_cc_toolchain_config` over the cross stdenv's Emscripten, through a wrapper, `cc`, that compiles with emcc and
links with em++. Bazel actions inherit the client's environment, so the toolchain's hardening flags are the cross
stdenv's. The build runs with `--config=oss_wasm --compilation_mode=opt --force_pic`.

After each compile, `cc` runs the [cast audit](engines.md#cast-audit)'s pass over the same source with the same flags,
which exist only inside the Bazel build: `-fsyntax-only -Wno-everything -Wno-error -Wcast-function-type-strict` with
SARIF diagnostics, one report per object, in a directory the sandbox may write. The install keeps the reports that
found something, with the sources they name, copied from the execroot after their paths are made relative to it.

Four port patches, in `patches/port`, apply after nixpkgs':

- 0001 adds the `oss_wasm` target: the open-source branding of `oss_linux` with Mozc's WebAssembly handling. Mozc's
  own `wasm` target is Google-branded and defines `GOOGLE_JAPANESE_INPUT_BUILD`, which the open-source tree can't
  build. The session watchdog stays off.
- 0002 builds the Unix IPC client for WebAssembly. Nothing calls it, but the client library links it.
- 0003 drops `ABSL_ATTRIBUTE_LIFETIME_BOUND` from `PosMatcher::Set`, which clang 22 rejects.
- 0004 implements ibus-mozc's `page_up`, `page_down`, `cursor_up` and `cursor_down`, which upstream leaves empty, so
  the candidate panel's page and arrow controls did nothing. Each sends the converter the matching key (Page Up, Page
  Down, Up, Down), which does what that key does in the current keymap.

A click on a candidate selects it for its segment, as Mozc's own candidate windows do with the same command
(`SELECT_CANDIDATE`), and leaves the conversion open; Enter commits it. Mozc converts a sentence in segments, so a
click that committed would commit every segment at once. Mozc sends one page of candidates at a time, and ibus-mozc
maps the panel's page-relative index into that page.

Mozc's `pkg_config_repository` passes what `pkg-config --libs-only-l` names for `@ibus` to the link. The overlay's
`pkg-config` (`bazel/pkg-config`) leaves out every library the runtime carries, which is all of them: the side module
imports GLib and IBus rather than linking a second copy. Abseil's two debugging files are compiled with
`-DSTANDALONE_WASM`, its switch for builds without Emscripten's JavaScript, since their Emscripten stack traces and
symbolizer call JavaScript functions the runtime doesn't export.

The distribution is built from `mozc-ut`, nixpkgs' `mozc` with the UT dictionaries merged into its own: alt-cannadic,
EDICT2, jawiki, NEologd, personal names, place names, SKK-JISYO and SudachiDict. Without them the OSS dictionary,
mostly IPAdic, lacks most proper nouns and recent words. The overlay overrides `mozc-ut` with the build machine's
dictionaries, every argument of `mozc-ut` named `mozcdic-ut-*`, since they are data the build reads, and gives `mozc`
the build machine's `merge-ut-dictionaries`, which merges them.

The derivation has four outputs: `out`, `mozc.wasm` alone; `data`, the data set, `share/mozc/mozc.data`; `check`,
the converter check's program; and `casts`, the cast audit's reports and sources. The static stdenv's propagated inputs are cleared, so the module's closure is
its data closure.

## The converter in-process

On the desktop, ibus-mozc's `client::Client` serializes each command and sends it to `mozc_server` over a Unix socket.
`engines/mozc/in_process/` (`//ibus_web_in_process`) keeps the client and its protocol and replaces the connection:
`InProcessIPCClientFactory` makes connections that hand each serialized command to a `SessionHandler` in this
process, as `mozc_server`'s `SessionServer::Process` would, and `InProcessServerLauncher` starts nothing.
`InProcessClientFactory` makes clients with both installed, for `ClientFactory::SetClientFactory`.

## Startup

`engines/mozc/module/module.cc` does what ibus-mozc's `main()` sets up before it enters `ibus_main()`:

1. sets Mozc's profile directory to `g_get_home_dir()`, which the host makes the module's own files,
   `/engines/<name>`; Mozc keeps its configuration, user dictionary and history there;
2. turns off `use_mozc_renderer`, so candidates go through IBus's lookup table to the page's panel rather than to
   Mozc's renderer process;
3. loads the data set, compiled in by store path, into a desktop engine and its session handler, and installs the
   in-process client factory;
4. applies the module's settings ([Settings](#settings)) to Mozc's config and its IBus configuration;
5. creates the one `MozcEngine` and registers its type;
6. reads Mozc's IBus configuration (`ibus_config.textproto` in the profile directory, written from the built-in
   default when missing) and adds an engine to the factory for each engine it lists.

If the data set doesn't load, every `CreateEngine` fails with the reason. The handler, factory and engine are never
freed: the module lives as long as its Worker. This init replaces Mozc's own `main()`, which would need `ibus_main()`
to park its thread ([known-gaps.md](known-gaps.md#runtime)).

## Settings

Mozc keeps its settings as a protobuf, `config1.db` in its profile directory, which its own settings tool edits. That
tool is a desktop application, so the module takes Mozc's settings from a GSettings schema of ibus-web's,
`org.freedesktop.ibus.engine.mozc` (`engines/mozc/org.freedesktop.ibus.engine.mozc.gschema.xml`), which the page's
settings reach the way they reach any engine's: the Init snapshot, the settings form and `SettingChanged`. The schema
holds what Mozc's settings dialog offers that means something in a browser, with Mozc's defaults: the input method
(romaji or kana), keymap style (MS-IME, ATOK, Kotoeri), punctuation, symbols, the width of a space and of the numeric
keypad, the candidate selection shortcut, what Shift does, the yen key, turning off for ASCII words, each conversion
Mozc can offer (date, single kanji, symbol, number, emoticon, emoji, calculator, transliteration, zip code, spelling
correction), suggestions from history and the dictionary, realtime conversion, the number of suggestions, history
learning and incognito mode. Enumerations are string keys with choices. Keymap and romaji table editing, the user
dictionary tool, presentation mode, usage statistics and logging are left out.

`engines/mozc/module/settings.cc` applies them. At startup, before the engine is made, it reads Mozc's config through
a client of its own, sets every field the schema has from its key, and writes the config back with `SetConfig`, as
Mozc's settings tool does, so the converter and its sessions take it up; fields the schema lacks keep what
`config1.db` holds. On each `changed` signal it does the same again, so a change reaches open contexts at once. Mozc's
engine rereads the input method on enable and focus, so a switch between romaji and kana applies at the next focus,
and its client reads the keymap's turn-on keys when it is made, so those follow a keymap change when the module next
starts.

`active-on-launch`, whether `mozc-jp` starts in hiragana rather than direct input, is the one key that isn't in Mozc's
config: it is in `ibus_config.textproto`, which the engine reads when it is made. The module rewrites that file when
the key differs from it, before making the engine and again on each change, so a change takes effect when the module
next starts. The rewrite keeps the file's settings and loses its comments.

## Distribution

`ibus-web-mozc-dist` is `mkEngineManifest` over `mozc.wasm`. It lists Mozc's three default engines, all Japanese, on
the `"default"` keyboard, since romaji input follows the characters typed rather than key positions:

| Engine     | Display name | Starts in                    |
| ---------- | ------------ | ---------------------------- |
| `mozc-jp`  | Mozc         | the user's chosen input mode |
| `mozc-on`  | Mozc:あ      | hiragana                     |
| `mozc-off` | Mozc:A\_     | direct input                 |

The data closure is the data set and the compiled `org.freedesktop.ibus.panel` schema, the module's only settings
schema. The data set is 54,375,469 bytes, 35 MB as Brotli; `mozc.wasm` is 5.3 MB. Mozc reads the whole data set
into memory. The manifest declares one engine thread and a 75 MiB program break, from `checks.mozc-host`'s peaks of
73,367,552 bytes asserting and 73,371,648 released, with the data set loaded and at most one engine thread alive; its
memory comes to 136 MiB.

The licence is `BSD-3-Clause AND Apache-2.0 AND NAIST-2003 AND MIT AND Unicode-DFS-2015 AND GPL-2.0-only AND
CC-BY-SA-4.0 AND GPL-2.0-or-later`. The first five come from Mozc's own credits: Mozc, Protocol Buffers and the
Japanese usage dictionary; Abseil; IPAdic; the Tamachi phonetic kanji alphabet; and Unicode's JIS tables. The Okinawa
dictionary and Japan Post's zip codes are in the public domain, which has no SPDX identifier. The rest are the UT
dictionaries' licences as nixpkgs declares them: alt-cannadic's GPL-2.0-only (nixpkgs' deprecated `GPL-2.0`), EDICT2's and jawiki's CC-BY-SA-4.0,
SKK-JISYO's GPL-2.0-or-later, and Apache-2.0 for the merge tooling and the other dictionaries.

The module ships as `@ibus-web/engine-mozc` (`packages/engines/mozc/`): `nix build .#npm.engine-mozc` copies
`ibus-web-mozc-dist` in as `dist/` and adds to `LICENSES/` the texts the repository has (BSD-3-Clause, Apache-2.0, MIT,
GPL-2.0-or-later), Mozc's `LICENSE` and its credits, `credits_en.html`, which carry the notices of every component it
names, as `LICENSES/mozc/`, and each UT dictionary's `LICENSE`, from its source, as
`LICENSES/mozcdic-ut-<name>/LICENSE`. `npmTarball` fails unless `package.json`'s `license` is the module's. It exports
`manifest.json`, `mozc.wasm`, `settings.json` and `data/*`; the tarball is 36 MB.

## Checks

- `checks.mozc-converter` runs the converter check's program under Node: Mozc's real `client::Client`, through the
  in-process factory, types `kyouhaiitenkidesu`, converts it with Space and commits it with Enter, and the output must
  be きょうはいいてんきです, 今日はいい天気です and 今日はいい天気です.
- `checks.mozc-host` runs the distribution through a Node Worker host and the test page, on each runtime build: romaji
  composes underlined hiragana, Space converts it and Enter commits it; a second Space opens the candidate window with
  漢字 among the candidates; the panel's cursor, next-page and previous-page controls move through them; a click on the
  second page selects that page's candidate, which Enter commits; settings from Init and from a later change reach the
  converter, and `active-on-launch` starts `mozc-jp` in hiragana; the direct-input engine passes keys through. It holds the program break and threads to the
  manifest's declaration and records each start, 674–833 ms with the data installed from its archive.
- `checks.mozc-cast-audit` reports on the build's cast reports and compares the findings with
  `engines/mozc/cast-audit.jsonc`. All 416 WebAssembly compiles are audited, 139 of them Abseil's, 78 Protocol
  Buffers' and 15 zlib's; the only findings are casts to `GCallback`, which the audit excludes, so the allow-list is
  empty.
- The demo serves the distribution, and `examples/demo/test/e2e/mozc.spec.ts` types through it in Chromium, Firefox
  and WebKit: the same conversion, the candidate panel opening on a second Space, and direct input.
- `checks.mozc-imports` checks `mozc.wasm`'s 380 imports against the runtime's export list.
- `checks.mozc-data-closure` checks that the closure is the data set and the schema, with no libraries, headers or
  modules.
