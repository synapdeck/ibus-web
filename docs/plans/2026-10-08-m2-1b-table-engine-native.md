# M2.1 Phase 2: The Table Engine, Natively — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the table engine's native half as `docs/specs/2026-10-08-m2-1-table-engine.md` phase 2 describes: MARISA with PR #146, the table parser and `Table`, `Sink`, `Session` in command and continuous mode, `xsampa.table`, `tools/latex-table`, the native `table-check` and `table-describe` tools, and the checks `table-marisa`, `tools-latex-table`, `table-parse` and `table-golden`.

**Architecture:** `engines/table/src/` is plain C++23 with no IBus or GObject: a `Table` parsed from our own format and indexed by a `marisa::Trie`, and sessions that drive a `Sink`. Meson builds it natively with nixpkgs' compiler against a patched MARISA, giving the two command-line tools and a GoogleTest golden suite; the same sources build for WebAssembly in phase 3. The LaTeX table is generated at build time by a TypeScript tool from a pinned W3C `unicode.xml`; the X-SAMPA table is written by hand.

**Tech Stack:** C++23 (GCC 16 natively, Emscripten's clang and libc++ for the editor and phase 3), Meson, MARISA 0.3.1, GoogleTest 1.18 (nixpkgs, native), Nix flake-parts, TypeScript 7 on Node 24, Vitest 5, pnpm, REUSE, hk.

## Global Constraints

- Work on branch `typedrat/m2-1b-table-engine-native`, cut from `master`. Phase 1 (plan A) runs in parallel and touches no file this plan does; phase 3 (plan C) builds on this branch's result.
- The names the M2.1 cross-phase contracts give this phase ("Produced by B") are fixed, because phase 3 is planned against them: files `engines/table/src/{keys.hpp,table.hpp,table.cpp,sink.hpp,session.hpp,command.cpp,continuous.cpp}`, namespace `ibusweb::table`, the `Table`, `Frontmatter`, `ParseError`, `Candidate`, `Sink`, `Session`, `pageSize` and `makeSession` declarations exactly as written there, `engines/table/tables/xsampa.table`, `tools/latex-table/` (`@ibus-web/latex-table`, CLI `node tools/latex-table/cli.ts <unicode.xml> <aliases.tsv>` to stdout), the tools `table-check` and `table-describe`, the options `ibusWeb.engines.table.{tables,tools,sources}` declared in `engines/table/options.nix`, `engines/table/overlay.nix` overriding `pkgsWasm.marisa`, and the checks `table-parse`, `table-golden`, `table-marisa`, `tools-latex-table`. Engine name = table file stem (`latex`, `xsampa`).
- MARISA's PR #146 is applied with `fetchpatch` from `https://github.com/s-yata/marisa-trie/commit/e31c7ed028f01c844e920cdfa56b438c59d5987a.patch`, hash `sha256-PM30tfoXHOYZhu2Uh4C83mNDLe848thInQDOZxb0lx4=`, never vendored. It applies cleanly to 0.3.1 after nixpkgs' own patch (checked: upstream's five tests pass natively, and the WebAssembly build succeeds).
- `unicode.xml` is pinned to w3c/xml-entities commit `0f766d761eebd0908b4f2cfaa30cf9b06bdc79b0` (2026-09-25, "resync with full release of Unicode 18", the last commit to change the file), fetched from `https://raw.githubusercontent.com/w3c/xml-entities/0f766d761eebd0908b4f2cfaa30cf9b06bdc79b0/unicode.xml` with hash `sha256-itRCuTYOpD87oHBPAzxObbTBU1YYSDjQAKSsEhgvuTU=`. Its header licenses it under the W3C Software Notice and License (SPDX `W3C`).
- The X-SAMPA source is the Internet Archive copy of Wells' chart, cited in `xsampa.table` and `docs/table.md`: `https://web.archive.org/web/20110709014830/http://www.phon.ucl.ac.uk/home/sampa/x-sampa.htm`.
- **C++ style.** C++23 (`cpp_std=c++23`, `-std=c++23`): `std::expected` for anything that can fail to parse, standard containers and `std::string_view`/`std::span` at boundaries, no exceptions thrown by our code (MARISA may still throw `std::bad_alloc`), no IBus or GObject headers. Headers are `.hpp` with `#pragma once`; local includes are relative (`"table.hpp"`, `"../src/table.hpp"`) so the editor needs no extra include paths. Types are `PascalCase`, functions and variables `camelCase`, members end in `_`. Formatting is the repository's `.clang-format` (LLVM): the code below is already formatted with Emscripten's clang-format; hk's pre-commit hook reformats anything that drifts. Native builds use `warning_level=3` and `werror=true`.
- **Native build and tests.** Meson, in a `pkgs.stdenv.mkDerivation` as `tools/ibus-test/native` is built. The C++ test framework is GoogleTest from nixpkgs (`pkgs.gtest`, linked with `gtest_main`), test-only and native, registered with Meson's `test()` and run by `ibusWeb.lib.mesonAllTestsRan` in `table-golden`'s check phase. `table-parse` is a shell check over the native `table-check` CLI. MARISA's own tests run through CTest in the native recipe's check phase.
- **Editor.** `toolchain-clangd` parses every `.c`/`.cpp` with the WebAssembly configuration. `engines/table/**/*.{cpp,hpp}` get `-std=c++23`, `pkgsWasm.marisa`'s headers and GoogleTest's flags through `ibusWeb.toolchain.clangdPathFlags` (checked: all of this plan's sources parse cleanly).
- **Licences.** All new code and `xsampa.table`, `aliases.tsv` and the parse fixtures are `MIT OR Apache-2.0`, with SPDX headers in their own comment syntax (tables and `aliases.tsv` take `#` comments). `tools/latex-table/fixtures/unicode.xml` is an excerpt of `unicode.xml`: `SPDX-License-Identifier: W3C`, copyright David Carlisle. `LICENSES/W3C.txt` is added. No `REUSE.toml` entry is needed: every new file carries its own header (`package.json` is already covered). `LICENSES/BSD-2-Clause.txt` is **not** added here: `reuse lint` fails on a licence text no file uses (checked), and no file in this phase is BSD-2-Clause; MARISA's licence is recorded as `meta.license = lib.licenses.bsd2` on the override, and phase 3 adds the text with the package that ships it.
- Run every command inside the dev shell (`nix develop -c …`). `git add` a new file before any `nix` command that should see it, with one exception spelled out in Task 2: `tools/latex-table/package.json` stays untracked until `pnpm install` has updated the lockfile, because the dev shell's offline install fails on a tracked package the lockfile doesn't know.
- Commit with `nix develop -c git add <paths>` then `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths>`. Stage named paths only, never `git add -A`. No attribution trailers. If hk's hook rewrites a file, re-add it and commit again; never bypass the hook.
- Comments explain why, never what; no history, no references to other files or plans. Separate logical blocks with one blank line; never a blank line right after an opening token or before a closing one.
- Markdown in `docs/` is formatted with `nix develop -c oxfmt -c .oxfmtrc.jsonc --write <file>`. Never run oxfmt on `docs/plans/`.

### Decisions this plan makes where the spec is silent

These are written into `docs/table.md` (Task 5) and covered by `table-golden` or `table-parse`.

- **Modifier keys.** A press of a modifier keysym itself (Shift, Control, Caps Lock, ISO level and group keys, Mode_switch, Num_Lock) returns false and changes nothing, in both modes. Otherwise the Shift press that types the `H` of `_H` would flush a continuous composition.
- **Hidden cursor.** In command mode, the first Up, Down, Tab or Shift+Tab while the cursor is hidden shows it where it is (the first candidate) rather than moving it. Cursor moves stop at either end; paging stays put on the first or last page.
- **Keys that type nothing** (Delete, Insert, F1, …) commit the raw buffer and pass through while a command composition is open, as Left, Right, Home and End do: the application then acts on committed text, never on text hidden behind a preedit. Continuous mode already flushes and passes through every key outside the alphabet, so both modes treat them alike. Presses of modifier keys alone still change nothing.
- **Sink order.** Within one call into a session, a commit comes first, then the preedit, then the candidates. A continuous key that resolves several keys commits them as one string. Hiding is `preedit("")` then `candidates({}, 0, false)`. A continuous session emits no hide when nothing was shown.
- **`ParseError::line` is 0** for errors about the file rather than a line (it can't be opened); `message()` is then `path: reason`. The parser reports the first error only.
- **Error classes** beyond the spec's: CR line endings, invalid UTF-8, malformed frontmatter lines, empty values and language tags, a trigger longer than one character, a body line without a tab, empty keys and outputs, a space in a key (Space ends compositions), a raw tab in an output, unknown escapes, a key without the trigger, a key that is only the trigger, the trigger inside a key (it opens the next composition), and a table with no mappings. Messages are listed in Task 3.
- **`sources`** is a list of file names relative to `engines/table/src` (every `.cpp` there, sorted); phase 3 compiles them from that directory, where the headers are.
- **`keys.hpp`** holds keysyms in `ibusweb::table::keys` (plus `keys::isModifier`) and masks in `ibusweb::table::masks`.
- **LaTeX table frontmatter:** `name = LaTeX`, `languages = und-Zmth` (undetermined language, mathematical notation script), `mode = command`, `trigger = \`. X-SAMPA: `name = X-SAMPA`, `languages = und-fonipa`, `mode = continuous`. Neither sets `layout`, so both are `default`: they map typed characters, not key positions.
- **X-SAMPA coverage.** Every symbol on the summary chart, both spellings where it gives two (`P`/`v\`, `'`/`_j`, `=`/`_=`, `~`/`_~`), plus three plosives the summary leaves to SAMPA and the full chart (`J\` ɟ, `G\` ɢ, `?` ʔ) and the five implosives written out (`b_<`, `d_<`, `J\_<`, `g_<`, `G\_<`), since Unicode has no implosive diacritic. Lower-case letters that are IPA symbols as they stand aren't listed: continuous mode types them literally. Tone contours map to Unicode's combining contour marks (U+1DC4, U+1DC5, U+1DC8).

---

## File structure

| Path | Responsibility |
| --- | --- |
| `engines/table/_marisa.nix` | `callPackage` recipe: nixpkgs' MARISA plus PR #146, no native tuning, no tools, tests where runnable, BSD-2-Clause |
| `engines/table/overlay.nix` | `flake.overlays.table`: `pkgsWasm.marisa` from the recipe |
| `engines/table/checks.nix` | `table-marisa`: the native recipe, whose check phase runs upstream's tests |
| `engines/table/options.nix` | `ibusWeb.engines.table.{tables,tools,sources}` |
| `engines/table/tables.nix` | `unicode.xml`, the generated `latex.table`, and `ibusWeb.engines.table.tables` |
| `engines/table/module.nix` | The native Meson build (`tools`), `sources`, clangd flags |
| `engines/table/meson.build`, `meson.options` | Native project: engine library, `table-check`, `table-describe`, optional golden tests |
| `engines/table/src/utf8.{hpp,cpp}` | UTF-8 decoding, validation, lengths, encoding |
| `engines/table/src/table.{hpp,cpp}` | Format parser and the MARISA-backed `Table` |
| `engines/table/src/keys.hpp` | Keysyms and modifier masks by value |
| `engines/table/src/sink.hpp` | `Sink` |
| `engines/table/src/session.hpp`, `session.cpp` | `Session`, `pageSize`, `makeSession`, `CandidateList` |
| `engines/table/src/composition.hpp` | Shared session internals: `isPrintable`, `CandidateList`, the two factories |
| `engines/table/src/command.cpp`, `continuous.cpp` | `CommandSession`, `ContinuousSession` |
| `engines/table/native/check.cpp`, `describe.cpp` | `table-check`, `table-describe` |
| `engines/table/tables/xsampa.table` | Hand-written X-SAMPA table |
| `engines/table/checks/parse/` | `table-parse`: `checks.nix`, `fixtures/*.table` |
| `engines/table/checks/golden/` | `table-golden`: `checks.nix`, `golden.cpp`, `recorder.hpp` |
| `tools/latex-table/` | `@ibus-web/latex-table`: generator, CLI, `aliases.tsv`, fixture, Vitest suite, `checks.nix` |
| `LICENSES/W3C.txt` | The W3C licence text |
| `docs/table.md`, `docs/README.md` | The engine's page and its index row |

---

## Task 1: MARISA with PR #146

**Files:**
- Create: `engines/table/_marisa.nix`, `engines/table/overlay.nix`, `engines/table/checks.nix`

**Interfaces:**
- Consumes: `config.ibusWeb.lib.isEmscriptenWasm` (flake-level, `modules/flake/lib.nix`), `config.ibusWeb.toolchain.pkgsWasm`.
- Produces: `engines/table/_marisa.nix`, a `callPackage` recipe `{ lib, stdenv, fetchpatch, marisa }: <derivation>`; called as `pkgs.callPackage ./_marisa.nix { }` natively and as `final.callPackage ./_marisa.nix { inherit (prev) marisa; }` in the overlay. `pkgsWasm.marisa` is the patched static library with `include/marisa.h` and `lib/pkgconfig/marisa.pc`. Check `table-marisa`.

- [ ] **Step 1: Create the branch**

```bash
git switch -c typedrat/m2-1b-table-engine-native master
```

Expected: `Switched to a new branch 'typedrat/m2-1b-table-engine-native'`.

- [ ] **Step 2: Write the check first**

`engines/table/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      marisa = pkgs.callPackage ./_marisa.nix { };
      wasm = config.ibusWeb.toolchain.pkgsWasm.marisa;
    in
    {
      # Upstream's tests run in the native build's check phase. They can't run
      # in the WebAssembly build, which must carry the same patches.
      checks.table-marisa =
        assert map toString wasm.patches == map toString marisa.patches;
        marisa;
    };
}
```

Run:

```bash
nix develop -c git add engines/table/checks.nix
nix build .#checks.x86_64-linux.table-marisa -L
```

Expected: FAIL at evaluation, `path '…/engines/table/_marisa.nix' does not exist`.

- [ ] **Step 3: Write the recipe and the overlay**

`engines/table/_marisa.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  lib,
  stdenv,
  fetchpatch,
  marisa,
}:
marisa.overrideAttrs (old: {
  patches = (old.patches or [ ]) ++ [
    # 0.3.1 reads uninitialized units while packing a FlatVector.
    (fetchpatch {
      name = "marisa-flat-vector-build.patch";
      url = "https://github.com/s-yata/marisa-trie/commit/e31c7ed028f01c844e920cdfa56b438c59d5987a.patch";
      hash = "sha256-PM30tfoXHOYZhu2Uh4C83mNDLe848thInQDOZxb0lx4=";
    })
  ];

  # No instructions tuned to the build machine, which a browser's may lack.
  # The engine links the library alone.
  cmakeFlags = (old.cmakeFlags or [ ]) ++ [
    "-DENABLE_NATIVE_CODE=OFF"
    "-DENABLE_TOOLS=OFF"
  ];

  # Upstream's tests, wherever the build can run them.
  doCheck = stdenv.buildPlatform.canExecute stdenv.hostPlatform;
  checkPhase = ''
    runHook preCheck
    ctest --output-on-failure --no-tests=error
    runHook postCheck
  '';

  # COPYING.md offers BSD-2-Clause or LGPL-2.1-or-later; the engine takes
  # BSD-2-Clause.
  meta = old.meta // {
    license = lib.licenses.bsd2;
  };
})
```

`engines/table/overlay.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ config, lib, ... }:
{
  flake.overlays.table =
    final: prev:
    lib.optionalAttrs (config.ibusWeb.lib.isEmscriptenWasm prev.stdenv.hostPlatform) {
      marisa = final.callPackage ./_marisa.nix { inherit (prev) marisa; };
    };
}
```

- [ ] **Step 4: Run the check and build the WebAssembly library**

```bash
nix develop -c git add engines/table/_marisa.nix engines/table/overlay.nix
nix build .#checks.x86_64-linux.table-marisa -L
nix build .#legacyPackages.x86_64-linux.pkgsWasm.marisa --print-out-paths
```

Expected: the check's log shows `applying patch …-marisa-flat-vector-build.patch`, then CTest's `5/5 Test #5: marisa-test …… Passed` and `100% tests passed out of 5`. The second build prints a `marisa-static-wasm32-unknown-none-0.3.1` path whose `include/marisa.h` and `lib/libmarisa.a` exist (`ls <path>/include <path>/lib`).

- [ ] **Step 5: Commit**

```bash
nix develop -c git add engines/table/_marisa.nix engines/table/overlay.nix engines/table/checks.nix
nix develop -c git commit -m "build(table): patch MARISA for the table engine" -- engines/table/_marisa.nix engines/table/overlay.nix engines/table/checks.nix
```

---

## Task 2: The tables: `xsampa.table` and `tools/latex-table`

**Files:**
- Create: `engines/table/tables/xsampa.table`
- Create: `tools/latex-table/package.json`, `tsconfig.json`, `vitest.config.ts`, `latex-table.ts`, `cli.ts`, `latex-table.test.ts`, `aliases.tsv`, `fixtures/unicode.xml`, `checks.nix`
- Create: `engines/table/options.nix`, `engines/table/tables.nix`
- Create: `LICENSES/W3C.txt` (downloaded)
- Modify: `pnpm-lock.yaml` (by `pnpm install`)

**Interfaces:**
- Consumes: `config.ibusWeb.typescript.{workspaceFor,nodejs}`, `config.ibusWeb.testing.vitestCheck`.
- Produces: `tools/latex-table/latex-table.ts` exporting `readCharacters(xml: string): Character[]`, `parseAliases(text: string, path: string): Alias[]` and `generate(xml: string, aliasesText: string, aliasesPath: string): string` (the whole table, ending in a newline; throws `Error` with `path:line: reason` on an alias failure). CLI `node tools/latex-table/cli.ts <unicode.xml> <aliases.tsv>` writes the table to stdout and exits 1 with the message on failure. Options `ibusWeb.engines.table.{tables,tools,sources}` declared; `tables` defined: `$out/latex.table` and `$out/xsampa.table` only, `meta.license = [ w3c mit asl20 ]`. Check `tools-latex-table`.

- [ ] **Step 1: Write the X-SAMPA table**

`engines/table/tables/xsampa.table` (every mapping line is `key`, one TAB, the output; there are no other tabs):

```
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
#
# X-SAMPA to IPA, from J. C. Wells, "Computer-coding the IPA: a proposed
# extension of SAMPA", in the summary chart's order:
# https://web.archive.org/web/20110709014830/http://www.phon.ucl.ac.uk/home/sampa/x-sampa.htm
name = X-SAMPA
languages = und-fonipa
mode = continuous
---

# Consonants (pulmonic). Lower-case letters that are already IPA symbols aren't
# listed: they are typed as they are.
t`	ʈ
d`	ɖ
F	ɱ
n`	ɳ
J	ɲ
N	ŋ
N\	ɴ
B\	ʙ
R\	ʀ
4	ɾ
r`	ɽ
p\	ɸ
B	β
T	θ
D	ð
S	ʃ
Z	ʒ
s`	ʂ
z`	ʐ
C	ç
j\	ʝ
G	ɣ
X	χ
R	ʁ
X\	ħ
?\	ʕ
h\	ɦ
K	ɬ
K\	ɮ
P	ʋ
v\	ʋ
r\	ɹ
r\`	ɻ
M\	ɰ
l`	ɭ
L	ʎ
L\	ʟ

# The plosives the summary chart takes from SAMPA and the full chart: palatal
# and uvular voiced, and glottal.
J\	ɟ
G\	ɢ
?	ʔ

# Clicks
O\	ʘ
|\	ǀ
!\	ǃ
=\	ǂ
|\|\	ǁ

# Ejectives, implosives. Unicode has no implosive diacritic, so the chart's
# `_<` is written out for each implosive.
_>	ʼ
b_<	ɓ
d_<	ɗ
J\_<	ʄ
g_<	ɠ
G\_<	ʛ

# Vowels
M	ɯ
1	ɨ
}	ʉ
I	ɪ
Y	ʏ
U	ʊ
2	ø
@\	ɘ
8	ɵ
7	ɤ
@	ə
E	ɛ
9	œ
3	ɜ
3\	ɞ
V	ʌ
O	ɔ
{	æ
6	ɐ
&	ɶ
A	ɑ
Q	ɒ

# Other symbols
W	ʍ
H	ɥ
H\	ʜ
<\	ʢ
>\	ʡ
s\	ɕ
z\	ʑ
l\	ɺ
x\	ɧ
_	͡

# Suprasegmentals
"	ˈ
%	ˌ
:	ː
:\	ˑ
_X	̆
-\	‿

# Tones and word accents
_T	̋
_H	́
_M	̄
_L	̀
_B	̏
!	ꜜ
^	ꜛ
_R	̌
_F	̂
_H_T	᷄
_B_L	᷅
_R_F	᷈
<R>	↗
<F>	↘

# Diacritics
_0	̥
_v	̬
_h	ʰ
_O	̹
_c	̜
_+	̟
_-	̠
_"	̈
=	̩
_=	̩
_^	̯
`	˞
_t	̤
_k	̰
_N	̼
_w	ʷ
'	ʲ
_j	ʲ
_G	ˠ
_?\	ˤ
_d	̪
_a	̺
_m	̻
~	̃
_~	̃
_n	ⁿ
_l	ˡ
_}	̚
_e	̴
5	ɫ
_r	̝
_o	̞
_A	̘
_q	̙
```

Verify the transcription against the code points, which this listing gives unambiguously:

```bash
python3 - <<'EOF'
for line in open("engines/table/tables/xsampa.table", encoding="utf-8"):
    line = line.rstrip("\n")
    if "\t" in line:
        key, output = line.split("\t")
        print(key, " ".join(f"U+{ord(c):04X}" for c in output))
EOF
```

Expected output, exactly (137 lines):

```
t` U+0288
d` U+0256
F U+0271
n` U+0273
J U+0272
N U+014B
N\ U+0274
B\ U+0299
R\ U+0280
4 U+027E
r` U+027D
p\ U+0278
B U+03B2
T U+03B8
D U+00F0
S U+0283
Z U+0292
s` U+0282
z` U+0290
C U+00E7
j\ U+029D
G U+0263
X U+03C7
R U+0281
X\ U+0127
?\ U+0295
h\ U+0266
K U+026C
K\ U+026E
P U+028B
v\ U+028B
r\ U+0279
r\` U+027B
M\ U+0270
l` U+026D
L U+028E
L\ U+029F
J\ U+025F
G\ U+0262
? U+0294
O\ U+0298
|\ U+01C0
!\ U+01C3
=\ U+01C2
|\|\ U+01C1
_> U+02BC
b_< U+0253
d_< U+0257
J\_< U+0284
g_< U+0260
G\_< U+029B
M U+026F
1 U+0268
} U+0289
I U+026A
Y U+028F
U U+028A
2 U+00F8
@\ U+0258
8 U+0275
7 U+0264
@ U+0259
E U+025B
9 U+0153
3 U+025C
3\ U+025E
V U+028C
O U+0254
{ U+00E6
6 U+0250
& U+0276
A U+0251
Q U+0252
W U+028D
H U+0265
H\ U+029C
<\ U+02A2
>\ U+02A1
s\ U+0255
z\ U+0291
l\ U+027A
x\ U+0267
_ U+0361
" U+02C8
% U+02CC
: U+02D0
:\ U+02D1
_X U+0306
-\ U+203F
_T U+030B
_H U+0301
_M U+0304
_L U+0300
_B U+030F
! U+A71C
^ U+A71B
_R U+030C
_F U+0302
_H_T U+1DC4
_B_L U+1DC5
_R_F U+1DC8
<R> U+2197
<F> U+2198
_0 U+0325
_v U+032C
_h U+02B0
_O U+0339
_c U+031C
_+ U+031F
_- U+0320
_" U+0308
= U+0329
_= U+0329
_^ U+032F
` U+02DE
_t U+0324
_k U+0330
_N U+033C
_w U+02B7
' U+02B2
_j U+02B2
_G U+02E0
_?\ U+02E4
_d U+032A
_a U+033A
_m U+033B
~ U+0303
_~ U+0303
_n U+207F
_l U+02E1
_} U+031A
_e U+0334
5 U+026B
_r U+031D
_o U+031E
_A U+0318
_q U+0319
```

- [ ] **Step 2: Create the tool package and its fixture**

`tools/latex-table/package.json`:

```json
{
  "name": "@ibus-web/latex-table",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run --configLoader native"
  },
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  },
  "ibusWeb": {
    "assets": [
      "aliases.tsv",
      "fixtures"
    ]
  }
}
```

`tools/latex-table/tsconfig.json`:

```jsonc
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
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

`tools/latex-table/vitest.config.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { defineConfig } from "vitest/config";

// A Nix build's tree is read-only, so checks point Vite's cache elsewhere.
const cacheDir = process.env["IBUS_WEB_TEST_CACHE_DIR"];

export default defineConfig({
  ...(cacheDir === undefined ? {} : { cacheDir }),
  test: { include: ["*.test.ts"] },
});
```

`tools/latex-table/fixtures/unicode.xml` (genuine `unicode.xml` entries, cut down to the elements the generator reads and put out of code point order so the sort is tested; U+0127's only name is Elsevier's, and U+2242 U+0338 is a two-code-point character):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!--
SPDX-FileCopyrightText: David Carlisle 1999-2025
SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
SPDX-License-Identifier: W3C

Characters from W3C xml-entities' unicode.xml, cut down to the elements the
generator reads and reordered so that its sort is tested.
-->
<unicode unicode="18">
   <charlist>
      <character id="U1D400" dec="119808" mode="math" type="alphabetic">
         <latex>\mathbf{A}</latex>
         <mathlatex set="unicode-math">\mbfA</mathlatex>
         <description unicode="3.1">MATHEMATICAL BOLD CAPITAL A</description>
      </character>
      <character id="U00026" dec="38" mode="text" type="other">
         <latex>\&amp;</latex>
         <mathlatex set="unicode-math">\mathampersand</mathlatex>
         <description unicode="1.1">AMPERSAND</description>
      </character>
      <character id="U0002A" dec="42" mode="math" type="other">
         <latex>\ast </latex>
         <description unicode="1.1">ASTERISK</description>
      </character>
      <character id="U0005C" dec="92" mode="mixed" type="normal">
         <latex>\textbackslash </latex>
         <mathlatex>\backslash </mathlatex>
         <mathlatex set="unicode-math">\backslash</mathlatex>
         <description unicode="1.1">REVERSE SOLIDUS</description>
      </character>
      <character id="U000B0" dec="176" mode="mixed" type="other">
         <latex>\textdegree </latex>
         <mathlatex>\mbox{\textdegree}</mathlatex>
         <description unicode="1.1">DEGREE SIGN</description>
      </character>
      <character id="U00127" dec="295" mode="math" type="alphabetic">
         <latex>\Elzxh </latex>
         <description unicode="1.1">LATIN SMALL LETTER H WITH STROKE</description>
      </character>
      <character id="U003B1" dec="945" mode="math" type="alphabetic">
         <latex>\alpha </latex>
         <mathlatex set="unicode-math">\mupalpha</mathlatex>
         <description unicode="1.1">GREEK SMALL LETTER ALPHA</description>
      </character>
      <character id="U02192" dec="8594" mode="math" type="relation">
         <latex>\rightarrow </latex>
         <mathlatex set="unicode-math">\rightarrow</mathlatex>
         <description unicode="1.1">RIGHTWARDS ARROW</description>
      </character>
      <character id="U02205" dec="8709" mode="math" type="normal">
         <latex>\varnothing </latex>
         <mathlatex set="unicode-math">\varnothing</mathlatex>
         <description unicode="1.1">EMPTY SET</description>
      </character>
      <character id="U02217" dec="8727" mode="math" type="binaryop">
         <latex>{_\ast}</latex>
         <mathlatex set="unicode-math">\ast</mathlatex>
         <description unicode="1.1">ASTERISK OPERATOR</description>
      </character>
      <character id="U02242-00338" dec="8770-824" mode="math" type="relation">
         <latex>\NotEqualTilde </latex>
         <description>MINUS TILDE with slash</description>
      </character>
      <character id="U02260" dec="8800" mode="math" type="relation">
         <latex>\not =</latex>
         <mathlatex set="unicode-math">\ne</mathlatex>
         <description unicode="1.1">NOT EQUAL TO</description>
      </character>
   </charlist>
</unicode>
```

`tools/latex-table/aliases.tsv` (the spec's 24 aliases; each line is the command, one TAB, the code point):

```
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
#
# Common LaTeX and amsmath spellings that unicode.xml doesn't carry, since it
# gives each character one classic name: a command, a tab, and the character
# it types.
\to	U+2192
\gets	U+2190
\le	U+2264
\ge	U+2265
\neq	U+2260
\iff	U+27FA
\implies	U+27F9
\impliedby	U+27F8
\land	U+2227
\lor	U+2228
\owns	U+220B
\dots	U+2026
\lvert	U+007C
\rvert	U+007C
\lVert	U+2016
\rVert	U+2016
\emptyset	U+2205
\hbar	U+210F
\triangle	U+25B3
\Box	U+25A1
\Diamond	U+25C7
\leadsto	U+21DD
\qed	U+220E
\degree	U+00B0
```

- [ ] **Step 3: Write the failing tests**

`tools/latex-table/latex-table.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { generate, parseAliases, readCharacters } from "./latex-table.ts";

const fixture = fileURLToPath(new URL("fixtures/unicode.xml", import.meta.url));
const xml = readFileSync(fixture, "utf8");

const aliases = ["# Ours.", "\\to\tU+2192", "", "\\emptyset\tU+2205", "\\neq\tU+2260", ""].join("\n");

const expected = [
  "# LaTeX commands to Unicode, generated from W3C xml-entities' unicode.xml,",
  "# which is under the W3C Software Notice and License.",
  "name = LaTeX",
  "languages = und-Zmth",
  "mode = command",
  "trigger = \\",
  "---",
  "",
  "# Classic LaTeX names",
  "\\ast\t*",
  "\\textbackslash\t\\\\",
  "\\textdegree\t°",
  "\\alpha\tα",
  "\\rightarrow\t→",
  "\\varnothing\t∅",
  "\\NotEqualTilde\t\u2242\u0338",
  "",
  "# unicode-math names",
  "\\mathampersand\t&",
  "\\backslash\t\\\\",
  "\\mupalpha\tα",
  "\\ast\t∗",
  "\\ne\t≠",
  "\\mbfA\t𝐀",
  "",
  "# Common spellings unicode.xml doesn't name",
  "\\to\t→",
  "\\emptyset\t∅",
  "\\neq\t≠",
  "",
].join("\n");

describe("readCharacters", () => {
  test("reads each character's code points and trimmed, decoded names", () => {
    const characters = readCharacters(xml);
    expect(characters).toHaveLength(12);
    expect(characters[0]).toEqual({ codePoints: [0x1d400], latex: "\\mathbf{A}", unicodeMath: "\\mbfA" });
    expect(characters[1]).toEqual({ codePoints: [0x26], latex: "\\&", unicodeMath: "\\mathampersand" });
    expect(characters[10]).toEqual({ codePoints: [0x2242, 0x338], latex: "\\NotEqualTilde", unicodeMath: undefined });
  });
});

describe("generate", () => {
  test("gives the exact table", () => {
    expect(generate(xml, aliases, "aliases.tsv")).toBe(expected);
  });

  test("drops argument forms and Elsevier's names", () => {
    const table = generate(xml, "", "aliases.tsv");
    expect(table).not.toContain("\\mathbf");
    expect(table).not.toContain("\\&");
    expect(table).not.toContain("{_\\ast}");
    expect(table).not.toContain("\\not");
    expect(table).not.toContain("\\Elzxh");
  });

  test("gives a command naming two characters both, the classic one first", () => {
    const lines = generate(xml, "", "aliases.tsv").split("\n");
    expect(lines.filter((line) => line.startsWith("\\ast\t"))).toEqual(["\\ast\t*", "\\ast\t∗"]);
  });

  test("fails on an alias for a character unicode.xml lacks", () => {
    expect(() => generate(xml, "\\to\tU+2192\n\\snowman\tU+2603\n", "aliases.tsv")).toThrow(
      "aliases.tsv:2: U+2603 is not in unicode.xml",
    );
  });

  test("fails on an alias unicode.xml already uses as a name", () => {
    expect(() => generate(xml, "\\ast\tU+2217\n", "aliases.tsv")).toThrow(
      "aliases.tsv:1: \\ast is already a name in unicode.xml",
    );
    expect(() => generate(xml, "\\Elzxh\tU+0127\n", "aliases.tsv")).toThrow(
      "aliases.tsv:1: \\Elzxh is already a name in unicode.xml",
    );
  });
});

describe("parseAliases", () => {
  test("skips comments and blank lines", () => {
    expect(parseAliases(aliases, "aliases.tsv")).toEqual([
      { line: 2, command: "\\to", codePoint: 0x2192 },
      { line: 4, command: "\\emptyset", codePoint: 0x2205 },
      { line: 5, command: "\\neq", codePoint: 0x2260 },
    ]);
  });

  test("rejects a line that isn't a command and a code point", () => {
    expect(() => parseAliases("\\to U+2192\n", "aliases.tsv")).toThrow("aliases.tsv:1: expected \\command<TAB>U+XXXX");
  });
});

describe("the shipped aliases", () => {
  test("are the 24 the spec lists", () => {
    const shipped = parseAliases(
      readFileSync(fileURLToPath(new URL("aliases.tsv", import.meta.url)), "utf8"),
      "aliases.tsv",
    );
    expect(shipped.map((alias) => `${alias.command} ${String.fromCodePoint(alias.codePoint)}`)).toEqual([
      "\\to →",
      "\\gets ←",
      "\\le ≤",
      "\\ge ≥",
      "\\neq ≠",
      "\\iff ⟺",
      "\\implies ⟹",
      "\\impliedby ⟸",
      "\\land ∧",
      "\\lor ∨",
      "\\owns ∋",
      "\\dots …",
      "\\lvert |",
      "\\rvert |",
      "\\lVert ‖",
      "\\rVert ‖",
      "\\emptyset ∅",
      "\\hbar ℏ",
      "\\triangle △",
      "\\Box □",
      "\\Diamond ◇",
      "\\leadsto ⇝",
      "\\qed ∎",
      "\\degree °",
    ]);
  });
});

describe("cli.ts", () => {
  test("writes the table to standard output", () => {
    const dir = mkdtempSync(join(tmpdir(), "latex-table-"));
    const aliasesPath = join(dir, "aliases.tsv");
    writeFileSync(aliasesPath, aliases);
    const cli = fileURLToPath(new URL("cli.ts", import.meta.url));

    const result = spawnSync(process.execPath, [cli, fixture, aliasesPath], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  test("reports an alias failure and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "latex-table-"));
    const aliasesPath = join(dir, "aliases.tsv");
    writeFileSync(aliasesPath, "\\snowman\tU+2603\n");
    const cli = fileURLToPath(new URL("cli.ts", import.meta.url));

    const result = spawnSync(process.execPath, [cli, fixture, aliasesPath], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${aliasesPath}:1: U+2603 is not in unicode.xml\n`);
  });
});
```

Install the package's dependencies. `package.json` must stay untracked here: the dev shell builds `node_modules` offline from the lockfile, and a tracked package the lockfile lacks fails that build.

```bash
nix develop -c pnpm install
git diff --stat pnpm-lock.yaml
```

Expected: `pnpm-lock.yaml | 12 ++++++++++++`, a new `tools/latex-table:` importer with `@ibus-web/tsconfig` (`link:../../packages/tsconfig`), `@types/node` and `vitest`.

Run:

```bash
nix develop -c bash -c 'cd tools/latex-table && node node_modules/vitest/vitest.mjs run --configLoader native'
```

Expected: FAIL, `Error: Cannot find module './latex-table.ts' imported from …/latex-table.test.ts`.

- [ ] **Step 4: Write the generator and the CLI**

`tools/latex-table/latex-table.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The LaTeX engine's table, from W3C xml-entities' unicode.xml and our
// aliases. unicode.xml is regular enough to scan with patterns: each
// character is one <character> element with a U-prefixed hexadecimal id, and
// the names are text-only elements inside it.

export interface Character {
  codePoints: number[];
  latex: string | undefined;
  unicodeMath: string | undefined;
}

export interface Alias {
  line: number;
  command: string;
  codePoint: number;
}

const frontmatter = [
  "# LaTeX commands to Unicode, generated from W3C xml-entities' unicode.xml,",
  "# which is under the W3C Software Notice and License.",
  "name = LaTeX",
  "languages = und-Zmth",
  "mode = command",
  "trigger = \\",
  "---",
];

// Commands with arguments, such as \mathbb{A}, can't be typed as one key.
const bareCommand = /^\\[A-Za-z]+$/;

const namedEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[a-z]+);/g, (entity, name: string) => {
    if (name.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
    return namedEntities[name] ?? entity;
  });
}

function element(body: string, pattern: RegExp): string | undefined {
  const text = pattern.exec(body)?.[1];
  return text === undefined ? undefined : decodeEntities(text).trim();
}

export function readCharacters(xml: string): Character[] {
  const characters: Character[] = [];
  for (const [, attributes = "", body = ""] of xml.matchAll(/<character\b([^>]*)>([\s\S]*?)<\/character>/g)) {
    const id = /\bid="U([0-9A-F]+(?:-[0-9A-F]+)*)"/.exec(attributes)?.[1];
    if (id === undefined) {
      throw new Error(`unicode.xml: a character without a code point id: <character${attributes}>`);
    }
    characters.push({
      codePoints: id.split("-").map((hex) => Number.parseInt(hex, 16)),
      latex: element(body, /<latex>([\s\S]*?)<\/latex>/),
      unicodeMath: element(body, /<mathlatex set="unicode-math">([\s\S]*?)<\/mathlatex>/),
    });
  }
  return characters;
}

export function parseAliases(text: string, path: string): Alias[] {
  const aliases: Alias[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^(\\[A-Za-z]+)\tU\+([0-9A-F]{4,6})$/.exec(line);
    if (match === null) {
      throw new Error(`${path}:${index + 1}: expected \\command<TAB>U+XXXX`);
    }
    aliases.push({ line: index + 1, command: match[1]!, codePoint: Number.parseInt(match[2]!, 16) });
  }
  return aliases;
}

function compareCodePoints(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return a[i]! - b[i]!;
    }
  }
  return a.length - b.length;
}

function escapeOutput(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n");
}

function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

// Classic names, then unicode-math names, each in code point order, then the
// aliases in file order. A name that both give for one character appears
// once, as a classic name.
export function generate(xml: string, aliasesText: string, aliasesPath: string): string {
  const characters = readCharacters(xml).toSorted((a, b) => compareCodePoints(a.codePoints, b.codePoints));
  const names = new Set(characters.flatMap((character) => [character.latex, character.unicodeMath]));
  const single = new Set(
    characters.filter((character) => character.codePoints.length === 1).map((character) => character.codePoints[0]),
  );

  const lines = [...frontmatter];
  const seen = new Set<string>();
  const add = (command: string, text: string) => {
    const line = `${command}\t${escapeOutput(text)}`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  };

  const groups = [
    ["# Classic LaTeX names", "latex"],
    ["# unicode-math names", "unicodeMath"],
  ] as const;
  for (const [comment, field] of groups) {
    lines.push("", comment);
    for (const character of characters) {
      const name = character[field];
      // Names for Elsevier's fonts, which no LaTeX user types.
      if (name !== undefined && bareCommand.test(name) && !name.startsWith("\\El")) {
        add(name, String.fromCodePoint(...character.codePoints));
      }
    }
  }

  lines.push("", "# Common spellings unicode.xml doesn't name");
  for (const alias of parseAliases(aliasesText, aliasesPath)) {
    if (!single.has(alias.codePoint)) {
      throw new Error(`${aliasesPath}:${alias.line}: ${formatCodePoint(alias.codePoint)} is not in unicode.xml`);
    }
    if (names.has(alias.command)) {
      throw new Error(`${aliasesPath}:${alias.line}: ${alias.command} is already a name in unicode.xml`);
    }
    add(alias.command, String.fromCodePoint(alias.codePoint));
  }

  return `${lines.join("\n")}\n`;
}
```

`tools/latex-table/cli.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// cli.ts UNICODE.XML ALIASES.TSV: writes latex.table to standard output.

import { readFileSync } from "node:fs";
import { generate } from "./latex-table.ts";

const [xmlPath, aliasesPath] = process.argv.slice(2);
if (xmlPath === undefined || aliasesPath === undefined) {
  console.error("usage: cli.ts UNICODE.XML ALIASES.TSV");
  process.exit(2);
}

try {
  process.stdout.write(generate(readFileSync(xmlPath, "utf8"), readFileSync(aliasesPath, "utf8"), aliasesPath));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
```

- [ ] **Step 5: Run the tests**

```bash
nix develop -c bash -c 'cd tools/latex-table && node node_modules/vitest/vitest.mjs run --configLoader native'
```

Expected: `Test Files  1 passed (1)`, `Tests  11 passed (11)`.

- [ ] **Step 6: Add the check, the options and the tables**

`tools/latex-table/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
    in
    {
      checks.tools-latex-table = testing.vitestCheck {
        name = "tools-latex-table";
        packageDir = "${typescript.workspaceFor [ "tools/latex-table" ]}/tools/latex-table";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
```

`engines/table/options.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.engines.table = {
      tables = lib.mkOption {
        type = lib.types.package;
        description = "The table engine's tables, `latex.table` and `xsampa.table`, alone in the output's root.";
      };

      tools = lib.mkOption {
        type = lib.types.package;
        description = ''
          The native table tools: `bin/table-check FILE.table...` exits 1 with
          `path:line: reason` on the first table that fails to parse, and
          `bin/table-describe FILE.table...` prints the tables' engine descriptors
          as one JSON array, each named for its file's stem.
        '';
      };

      sources = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "The C++ files in `engines/table/src` that a build of the engine compiles, by name; the headers beside them are included from there.";
      };
    };
  };
}
```

`engines/table/tables.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) typescript;

      # The last commit to change unicode.xml when it was pinned: Unicode 18.
      unicodeXml = pkgs.fetchurl {
        name = "unicode.xml";
        url = "https://raw.githubusercontent.com/w3c/xml-entities/0f766d761eebd0908b4f2cfaa30cf9b06bdc79b0/unicode.xml";
        hash = "sha256-itRCuTYOpD87oHBPAzxObbTBU1YYSDjQAKSsEhgvuTU=";
      };

      generator = "${typescript.workspaceFor [ "tools/latex-table" ]}/tools/latex-table";
    in
    {
      ibusWeb.engines.table.tables =
        pkgs.runCommand "ibus-web-table-tables"
          {
            nativeBuildInputs = [ typescript.nodejs ];
            # latex.table is unicode.xml's data; xsampa.table is ours.
            meta.license = with lib.licenses; [
              w3c
              mit
              asl20
            ];
          }
          ''
            mkdir $out
            node ${generator}/cli.ts ${unicodeXml} ${generator}/aliases.tsv > $out/latex.table
            cp ${./tables/xsampa.table} $out/xsampa.table
          '';
    };
}
```

Add the W3C licence text, which the fixture's header names:

```bash
nix develop -c reuse download W3C
```

Expected: `Successfully downloaded LICENSES/W3C.txt.`

- [ ] **Step 7: Run the check, the generator on the pinned data, and reuse**

```bash
nix develop -c git add tools/latex-table pnpm-lock.yaml engines/table/tables/xsampa.table engines/table/options.nix engines/table/tables.nix LICENSES/W3C.txt
nix build .#checks.x86_64-linux.tools-latex-table -L
xml=$(nix store prefetch-file --json https://raw.githubusercontent.com/w3c/xml-entities/0f766d761eebd0908b4f2cfaa30cf9b06bdc79b0/unicode.xml | python3 -c 'import json, sys; print(json.load(sys.stdin)["storePath"])')
table=$(mktemp)
nix develop -c node tools/latex-table/cli.ts "$xml" tools/latex-table/aliases.tsv > "$table"
wc -l < "$table"; head -12 "$table"; tail -3 "$table"
nix develop -c reuse lint
```

Expected: the check passes with `Tests  11 passed (11)`. If the workspace build stops on a `pnpmDeps` hash mismatch, put the `got:` hash into `modules/typescript/workspace.nix`'s `pnpmDeps` and add that file to this task's commit (adding a package with only catalog dependencies left it unchanged when this plan was checked). The generated table has 2762 lines and starts:

```
# LaTeX commands to Unicode, generated from W3C xml-entities' unicode.xml,
# which is under the W3C Software Notice and License.
name = LaTeX
languages = und-Zmth
mode = command
trigger = \
---

# Classic LaTeX names
\space	 
\textdollar	$
\textquotesingle	'
```

and ends with `\leadsto	⇝`, `\qed	∎`, `\degree	°`. `reuse lint` ends with `Congratulations! Your project is compliant with version 3.3 of the REUSE Specification :-)` and lists `W3C` among the used licences. (`ibusWeb.engines.table.tables` itself is built by `table-parse` in Task 3.)

- [ ] **Step 8: Commit**

```bash
nix develop -c git add engines/table/tables/xsampa.table engines/table/options.nix engines/table/tables.nix tools/latex-table pnpm-lock.yaml LICENSES/W3C.txt
nix develop -c git commit -m "feat(table): add the X-SAMPA table and generate the LaTeX one" -- engines/table/tables/xsampa.table engines/table/options.nix engines/table/tables.nix tools/latex-table pnpm-lock.yaml LICENSES/W3C.txt
```

---

## Task 3: The parser, `Table` and the native tools

**Files:**
- Create: `engines/table/src/utf8.hpp`, `utf8.cpp`, `table.hpp`, `table.cpp`
- Create: `engines/table/native/check.cpp`, `describe.cpp`
- Create: `engines/table/meson.build`, `engines/table/module.nix`
- Create: `engines/table/checks/parse/checks.nix`, `engines/table/checks/parse/fixtures/*.table` (24 files, written by a script)

**Interfaces:**
- Consumes: `ibusWeb.engines.table.tables` (Task 2), `_marisa.nix` (Task 1), `config.ibusWeb.testing.gtestCflagList`, `config.ibusWeb.toolchain.pkgsWasm`.
- Produces, in `ibusweb::table` (`table.hpp`), exactly the contract's declarations: `enum class Mode { command, continuous }`, `enum class Layout { standard, us }`, `struct Frontmatter { std::string name; std::vector<std::string> languages; Mode mode; std::optional<char32_t> trigger; Layout layout; }`, `struct ParseError { std::string path; std::size_t line; std::string reason; std::string message() const; }`, `struct Candidate { std::string key; std::string output; }`, and `class Table` with `static std::expected<Table, ParseError> parse(std::string_view path, std::string_view text)`, `static std::expected<Table, ParseError> load(const std::filesystem::path &path)`, `const Frontmatter &frontmatter() const`, `bool inAlphabet(char32_t c) const`, `std::span<const std::string> exact(std::string_view key) const`, `std::vector<Candidate> completions(std::string_view prefix) const`, `bool extendable(std::string_view prefix) const`, `std::optional<std::pair<std::size_t, std::string_view>> longestPrefix(std::string_view text) const`; movable, not copyable. `utf8.hpp`: `struct Decoded { char32_t character; std::size_t length; }`, `std::optional<Decoded> decode(std::string_view, std::size_t offset)`, `bool valid(std::string_view)`, `std::size_t length(std::string_view)`, `std::size_t lastLength(std::string_view)`, `void append(std::string &, char32_t)`. Options `ibusWeb.engines.table.tools` (Meson build with `bin/table-check`, `bin/table-describe`) and `ibusWeb.engines.table.sources` (`[ "table.cpp" "utf8.cpp" ]` after this task). Check `table-parse`.

- [ ] **Step 1: Write the malformed fixtures**

Run this from the repository root. It writes one table per error class; a script rather than files typed by hand, because several hinge on exact tabs.

```bash
python3 - <<'EOF'
from pathlib import Path

header = (
    "# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.\n"
    "# SPDX-License-Identifier: MIT OR Apache-2.0\n"
)
continuous = header + "name = Broken\nlanguages = und\nmode = continuous\n---\n"
command = header + "name = Broken\nlanguages = und\nmode = command\ntrigger = \\\n---\n"

fixtures = {
    "frontmatter-syntax": header + "name: Broken\n",
    "unknown-key": header + "name = Broken\ncolour = blue\n",
    "repeated-key": header + "name = Broken\nname = Again\n",
    "empty-value": header + "name =\n",
    "missing-key": header + "name = Broken\nmode = continuous\n---\na\tb\n",
    "missing-separator": header + "name = Broken\nlanguages = und\nmode = continuous\n",
    "bad-mode": header + "name = Broken\nlanguages = und\nmode = chord\n---\na\tb\n",
    "bad-layout": header + "name = Broken\nlanguages = und\nmode = continuous\nlayout = dvorak\n---\na\tb\n",
    "trigger-in-continuous": header + "name = Broken\nlanguages = und\nmode = continuous\ntrigger = \\\n---\na\tb\n",
    "missing-trigger": header + "name = Broken\nlanguages = und\nmode = command\n---\n\\a\tb\n",
    "long-trigger": header + "name = Broken\nlanguages = und\nmode = command\ntrigger = \\\\\n---\n\\\\a\tb\n",
    "empty-language": header + "name = Broken\nlanguages = en,,fr\nmode = continuous\n---\na\tb\n",
    "mapping-syntax": continuous + "a b\n",
    "empty-key": continuous + "\tb\n",
    "space-in-key": continuous + "a b\tc\n",
    "tab-in-output": continuous + "a\tb\tc\n",
    "unknown-escape": continuous + "a\tb\\x\n",
    "empty-output": continuous + "a\t\n",
    "key-without-trigger": command + "alpha\t\u03b1\n",
    "bare-trigger": command + "\\\tx\n",
    "trigger-inside-key": command + "\\a\\b\tx\n",
    "repeated-mapping": command + "\\a\t\u03b1\n\\a\t\u03b1\n",
    "repeated-continuous-key": continuous + "a\tb\na\tc\n",
    "no-mappings": continuous + "# Nothing but a comment.\n",
}

directory = Path("engines/table/checks/parse/fixtures")
directory.mkdir(parents=True, exist_ok=True)
for name, text in fixtures.items():
    (directory / f"{name}.table").write_text(text, encoding="utf-8")
print(len(fixtures), "fixtures")
EOF
```

Expected: 24 files in `engines/table/checks/parse/fixtures/`, each starting with the two SPDX lines.

- [ ] **Step 2: Write the check**

`engines/table/checks/parse/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb.engines.table) tables tools;

      # Exactly as printed: key order matters to the comparison.
      descriptors = lib.concatStrings [
        ''[{"name":"latex","displayName":"LaTeX","languages":["und-Zmth"],''
        ''"keyboard":{"layout":"default","passThrough":[]}},''
        ''{"name":"xsampa","displayName":"X-SAMPA","languages":["und-fonipa"],''
        ''"keyboard":{"layout":"default","passThrough":[]}}]''
      ];

      # One per error class, in the order the check runs them.
      errors = pkgs.writeText "ibus-web-table-parse-errors" ''
        bad-layout.table:6: layout must be default or us, not "dvorak"
        bad-mode.table:5: mode must be command or continuous, not "chord"
        bare-trigger.table:8: key is only the trigger
        carriage-return.table:1: carriage return; tables use LF line endings
        empty-key.table:7: empty key
        empty-language.table:4: empty language tag
        empty-output.table:7: empty output
        empty-value.table:3: empty value for "name"
        frontmatter-syntax.table:3: expected key = value
        invalid-utf8.table:1: invalid UTF-8
        key-without-trigger.table:8: key "alpha" doesn't start with the trigger
        long-trigger.table:6: trigger must be one character
        mapping-syntax.table:7: expected key<TAB>output
        missing-key.table:5: missing required key "languages"
        missing-separator.table:5: missing --- after the frontmatter
        missing-trigger.table:6: missing required key "trigger"
        no-mappings.table:7: no mappings
        repeated-continuous-key.table:8: repeated key "a" in continuous mode
        repeated-key.table:4: repeated key "name"
        repeated-mapping.table:9: repeated mapping "\a" to "α"
        space-in-key.table:7: space in key "a b"
        tab-in-output.table:7: tab in output; write it as \t
        trigger-in-continuous.table:6: trigger is only for command mode
        trigger-inside-key.table:8: trigger inside key "\a\b"
        unknown-escape.table:7: unknown escape "\x" in output
        unknown-key.table:4: unknown key "colour"
        missing.table: No such file or directory
      '';
    in
    {
      checks.table-parse =
        pkgs.runCommand "ibus-web-table-parse"
          {
            nativeBuildInputs = [ tools ];
          }
          ''
            export LC_ALL=C

            # The shipped tables parse, and describe their engines.
            [ "$(cd ${tables} && echo *)" = "latex.table xsampa.table" ]
            table-check ${tables}/latex.table ${tables}/xsampa.table
            describe=$(table-describe ${tables}/latex.table ${tables}/xsampa.table)
            if [ "$describe" != ${lib.escapeShellArg descriptors} ]; then
              echo "unexpected descriptors: $describe" >&2
              exit 1
            fi

            # Each malformed table fails with its message. Bytes that can't be
            # committed as text are written here.
            cp ${./fixtures}/*.table .
            printf 'name = \377\n' > invalid-utf8.table
            printf 'name = Broken\r\n' > carriage-return.table
            for table in *.table missing.table; do
              if table-check "$table" 2>> errors.txt; then
                echo "$table parsed" >&2
                exit 1
              fi
            done
            diff -u ${errors} errors.txt

            mkdir $out
            cp errors.txt $out/
          '';
    };
}
```

Run:

```bash
nix develop -c git add engines/table/checks/parse
nix build .#checks.x86_64-linux.table-parse -L
```

Expected: FAIL at evaluation: the option `perSystem.x86_64-linux.ibusWeb.engines.table.tools` is used but has no value defined.

- [ ] **Step 3: Write the UTF-8 helpers**

`engines/table/src/utf8.hpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

namespace ibusweb::table::utf8 {

struct Decoded {
  char32_t character;
  std::size_t length;
};

// The code point starting at `offset`, or nothing where the bytes there
// aren't well-formed UTF-8: overlong forms and surrogates are rejected.
std::optional<Decoded> decode(std::string_view text, std::size_t offset);

bool valid(std::string_view text);

// Code points in well-formed text.
std::size_t length(std::string_view text);

// Bytes in the last code point of non-empty, well-formed text.
std::size_t lastLength(std::string_view text);

void append(std::string &out, char32_t character);

} // namespace ibusweb::table::utf8
```

`engines/table/src/utf8.cpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include "utf8.hpp"

namespace ibusweb::table::utf8 {

namespace {

bool isContinuation(char byte) {
  return (static_cast<unsigned char>(byte) & 0xc0) == 0x80;
}

} // namespace

std::optional<Decoded> decode(std::string_view text, std::size_t offset) {
  const auto lead = static_cast<unsigned char>(text[offset]);
  if (lead < 0x80) {
    return Decoded{lead, 1};
  }

  std::size_t length = 0;
  char32_t character = 0;
  char32_t smallest = 0;
  if ((lead & 0xe0) == 0xc0) {
    length = 2;
    character = lead & 0x1f;
    smallest = 0x80;
  } else if ((lead & 0xf0) == 0xe0) {
    length = 3;
    character = lead & 0x0f;
    smallest = 0x800;
  } else if ((lead & 0xf8) == 0xf0) {
    length = 4;
    character = lead & 0x07;
    smallest = 0x10000;
  } else {
    return std::nullopt;
  }

  if (offset + length > text.size()) {
    return std::nullopt;
  }
  for (std::size_t i = 1; i < length; ++i) {
    const char byte = text[offset + i];
    if (!isContinuation(byte)) {
      return std::nullopt;
    }
    character = (character << 6) | (static_cast<unsigned char>(byte) & 0x3f);
  }

  const bool surrogate = character >= 0xd800 && character <= 0xdfff;
  if (character < smallest || character > 0x10ffff || surrogate) {
    return std::nullopt;
  }
  return Decoded{character, length};
}

bool valid(std::string_view text) {
  for (std::size_t offset = 0; offset < text.size();) {
    const auto decoded = decode(text, offset);
    if (!decoded) {
      return false;
    }
    offset += decoded->length;
  }
  return true;
}

std::size_t length(std::string_view text) {
  std::size_t count = 0;
  for (const char byte : text) {
    if (!isContinuation(byte)) {
      ++count;
    }
  }
  return count;
}

std::size_t lastLength(std::string_view text) {
  std::size_t start = text.size() - 1;
  while (start > 0 && isContinuation(text[start])) {
    --start;
  }
  return text.size() - start;
}

void append(std::string &out, char32_t character) {
  if (character < 0x80) {
    out += static_cast<char>(character);
  } else if (character < 0x800) {
    out += static_cast<char>(0xc0 | (character >> 6));
    out += static_cast<char>(0x80 | (character & 0x3f));
  } else if (character < 0x10000) {
    out += static_cast<char>(0xe0 | (character >> 12));
    out += static_cast<char>(0x80 | ((character >> 6) & 0x3f));
    out += static_cast<char>(0x80 | (character & 0x3f));
  } else {
    out += static_cast<char>(0xf0 | (character >> 18));
    out += static_cast<char>(0x80 | ((character >> 12) & 0x3f));
    out += static_cast<char>(0x80 | ((character >> 6) & 0x3f));
    out += static_cast<char>(0x80 | (character & 0x3f));
  }
}

} // namespace ibusweb::table::utf8
```

- [ ] **Step 4: Write `Table` and its parser**

`engines/table/src/table.hpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <cstddef>
#include <expected>
#include <filesystem>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace ibusweb::table {

enum class Mode { command, continuous };

// `default` and `us` in the file.
enum class Layout { standard, us };

struct Frontmatter {
  std::string name;
  std::vector<std::string> languages;
  Mode mode;
  std::optional<char32_t> trigger;
  Layout layout;
};

struct ParseError {
  std::string path;
  // 0 when the error belongs to the file rather than a line of it.
  std::size_t line;
  std::string reason;

  // `path:line: reason`, or `path: reason` without a line.
  std::string message() const;
};

struct Candidate {
  std::string key;
  std::string output;
};

// A parsed table, immutable and shared by every session of its engine. Keys
// and outputs are UTF-8.
class Table {
public:
  static std::expected<Table, ParseError> parse(std::string_view path,
                                                std::string_view text);
  static std::expected<Table, ParseError>
  load(const std::filesystem::path &path);

  Table(Table &&) noexcept;
  Table &operator=(Table &&) noexcept;
  ~Table();

  const Frontmatter &frontmatter() const;
  bool inAlphabet(char32_t c) const;

  // The key's outputs in file order; empty if it isn't a key.
  std::span<const std::string> exact(std::string_view key) const;

  // Every key starting with `prefix`, the prefix included, by key length in
  // code points, then by key in code point order, then each key's outputs in
  // file order.
  std::vector<Candidate> completions(std::string_view prefix) const;

  // Whether a key strictly longer than `prefix` starts with it.
  bool extendable(std::string_view prefix) const;

  // The longest key that `text` starts with: its length in bytes and its
  // first output.
  std::optional<std::pair<std::size_t, std::string_view>>
  longestPrefix(std::string_view text) const;

private:
  struct Index;

  Table(Frontmatter frontmatter, std::vector<char32_t> alphabet,
        std::unique_ptr<Index> index);

  Frontmatter frontmatter_;
  std::vector<char32_t> alphabet_;
  std::unique_ptr<Index> index_;
};

} // namespace ibusweb::table
```

`engines/table/src/table.cpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include "table.hpp"

#include <algorithm>
#include <array>
#include <fstream>
#include <iterator>
#include <map>
#include <set>
#include <system_error>
#include <tuple>

#include <marisa.h>

#include "utf8.hpp"

namespace ibusweb::table {

struct Table::Index {
  marisa::Trie trie;
  // By key ID, each key's outputs in file order.
  std::vector<std::vector<std::string>> outputs;
};

namespace {

struct Parsed {
  Frontmatter frontmatter;
  std::vector<std::pair<std::string, std::string>> mappings;
};

std::vector<std::string_view> splitLines(std::string_view text) {
  std::vector<std::string_view> lines;
  std::size_t start = 0;
  while (start < text.size()) {
    const std::size_t end = text.find('\n', start);
    if (end == std::string_view::npos) {
      lines.push_back(text.substr(start));
      break;
    }
    lines.push_back(text.substr(start, end - start));
    start = end + 1;
  }
  return lines;
}

bool isBlank(std::string_view line) {
  return line.find_first_not_of(" \t") == std::string_view::npos;
}

std::string_view trim(std::string_view text) {
  const std::size_t first = text.find_first_not_of(" \t");
  if (first == std::string_view::npos) {
    return {};
  }
  const std::size_t last = text.find_last_not_of(" \t");
  return text.substr(first, last - first + 1);
}

std::string quoted(std::string_view text) {
  return "\"" + std::string(text) + "\"";
}

// `\t`, `\n` and `\\`; anything else after a backslash is an error, reported
// as the reason.
std::expected<std::string, std::string> unescape(std::string_view raw) {
  std::string out;
  for (std::size_t i = 0; i < raw.size(); ++i) {
    if (raw[i] != '\\') {
      out += raw[i];
      continue;
    }
    if (i + 1 == raw.size()) {
      return std::unexpected("unknown escape \"\\\" in output");
    }
    switch (raw[i + 1]) {
    case 't':
      out += '\t';
      break;
    case 'n':
      out += '\n';
      break;
    case '\\':
      out += '\\';
      break;
    default: {
      const std::size_t length = utf8::decode(raw, i + 1)->length;
      return std::unexpected("unknown escape " +
                             quoted(raw.substr(i, 1 + length)) + " in output");
    }
    }
    ++i;
  }
  return out;
}

class Parser {
public:
  Parser(std::string_view path, std::string_view text)
      : path_(path), lines_(splitLines(text)) {}

  std::expected<Parsed, ParseError> run() {
    for (std::size_t i = 0; i < lines_.size(); ++i) {
      if (lines_[i].contains('\r')) {
        return fail(i + 1, "carriage return; tables use LF line endings");
      }
      if (!utf8::valid(lines_[i])) {
        return fail(i + 1, "invalid UTF-8");
      }
    }

    if (auto error = frontmatter()) {
      return std::unexpected(*error);
    }
    if (auto error = body()) {
      return std::unexpected(*error);
    }
    return std::move(parsed_);
  }

private:
  struct Value {
    std::size_t line;
    std::string_view text;
  };

  ParseError error(std::size_t line, std::string reason) const {
    return ParseError{path_, line, std::move(reason)};
  }

  std::unexpected<ParseError> fail(std::size_t line, std::string reason) const {
    return std::unexpected(error(line, std::move(reason)));
  }

  std::size_t lastLine() const {
    return std::max<std::size_t>(lines_.size(), 1);
  }

  std::optional<ParseError> frontmatter() {
    static constexpr std::array<std::string_view, 5> known{
        "name", "languages", "mode", "trigger", "layout"};

    std::map<std::string_view, Value> values;
    for (; next_ < lines_.size(); ++next_) {
      const std::string_view line = lines_[next_];
      const std::size_t number = next_ + 1;
      if (line == "---") {
        break;
      }
      if (isBlank(line) || line.starts_with('#')) {
        continue;
      }

      const std::size_t equals = line.find('=');
      const std::string_view key = trim(line.substr(0, equals));
      const bool word = !key.empty() && std::ranges::all_of(key, [](char c) {
        return c >= 'a' && c <= 'z';
      });
      if (equals == std::string_view::npos || !word) {
        return error(number, "expected key = value");
      }
      if (!std::ranges::contains(known, key)) {
        return error(number, "unknown key " + quoted(key));
      }
      if (values.contains(key)) {
        return error(number, "repeated key " + quoted(key));
      }
      const std::string_view value = trim(line.substr(equals + 1));
      if (value.empty()) {
        return error(number, "empty value for " + quoted(key));
      }
      values.emplace(key, Value{number, value});
    }

    if (next_ == lines_.size()) {
      return error(lastLine(), "missing --- after the frontmatter");
    }
    const std::size_t separator = next_ + 1;
    ++next_;

    for (const std::string_view key : {"name", "languages", "mode"}) {
      if (!values.contains(key)) {
        return error(separator, "missing required key " + quoted(key));
      }
    }

    Frontmatter &frontmatter = parsed_.frontmatter;
    frontmatter.name = values.at("name").text;

    const Value languages = values.at("languages");
    for (std::size_t start = 0; start <= languages.text.size();) {
      const std::size_t comma = languages.text.find(',', start);
      const std::size_t end =
          comma == std::string_view::npos ? languages.text.size() : comma;
      const std::string_view tag =
          trim(languages.text.substr(start, end - start));
      if (tag.empty()) {
        return error(languages.line, "empty language tag");
      }
      frontmatter.languages.emplace_back(tag);
      start = end + 1;
    }

    const Value mode = values.at("mode");
    if (mode.text == "command") {
      frontmatter.mode = Mode::command;
    } else if (mode.text == "continuous") {
      frontmatter.mode = Mode::continuous;
    } else {
      return error(mode.line, "mode must be command or continuous, not " +
                                  quoted(mode.text));
    }

    frontmatter.layout = Layout::standard;
    if (const auto layout = values.find("layout"); layout != values.end()) {
      const Value value = layout->second;
      if (value.text == "us") {
        frontmatter.layout = Layout::us;
      } else if (value.text != "default") {
        return error(value.line,
                     "layout must be default or us, not " + quoted(value.text));
      }
    }

    const auto trigger = values.find("trigger");
    if (frontmatter.mode == Mode::continuous) {
      if (trigger != values.end()) {
        return error(trigger->second.line, "trigger is only for command mode");
      }
      return std::nullopt;
    }
    if (trigger == values.end()) {
      return error(separator, "missing required key \"trigger\"");
    }
    const std::string_view text = trigger->second.text;
    const auto decoded = utf8::decode(text, 0);
    if (decoded->length != text.size()) {
      return error(trigger->second.line, "trigger must be one character");
    }
    frontmatter.trigger = decoded->character;
    trigger_ = text;
    return std::nullopt;
  }

  std::optional<ParseError> body() {
    const bool command = parsed_.frontmatter.mode == Mode::command;
    std::set<std::pair<std::string, std::string>> seen;
    std::set<std::string_view> keys;

    for (; next_ < lines_.size(); ++next_) {
      const std::string_view line = lines_[next_];
      const std::size_t number = next_ + 1;
      if (isBlank(line)) {
        continue;
      }

      const std::size_t tab = line.find('\t');
      if (tab == std::string_view::npos) {
        if (line.starts_with('#')) {
          continue;
        }
        return error(number, "expected key<TAB>output");
      }

      const std::string_view key = line.substr(0, tab);
      const std::string_view raw = line.substr(tab + 1);
      if (key.empty()) {
        return error(number, "empty key");
      }
      if (key.contains(' ')) {
        return error(number, "space in key " + quoted(key));
      }
      if (raw.contains('\t')) {
        return error(number, "tab in output; write it as \\t");
      }
      auto output = unescape(raw);
      if (!output) {
        return error(number, output.error());
      }
      if (output->empty()) {
        return error(number, "empty output");
      }

      if (command) {
        if (!key.starts_with(trigger_)) {
          return error(number, "key " + quoted(key) +
                                   " doesn't start with the trigger");
        }
        const std::string_view rest = key.substr(trigger_.size());
        if (rest.empty()) {
          return error(number, "key is only the trigger");
        }
        if (rest.contains(trigger_)) {
          return error(number, "trigger inside key " + quoted(key));
        }
      }

      if (!seen.emplace(key, *output).second) {
        return error(number,
                     "repeated mapping " + quoted(key) + " to " + quoted(raw));
      }
      if (!command && !keys.insert(key).second) {
        return error(number,
                     "repeated key " + quoted(key) + " in continuous mode");
      }
      parsed_.mappings.emplace_back(key, std::move(*output));
    }

    if (parsed_.mappings.empty()) {
      return error(lastLine(), "no mappings");
    }
    return std::nullopt;
  }

  std::string path_;
  std::vector<std::string_view> lines_;
  std::size_t next_ = 0;
  std::string_view trigger_;
  Parsed parsed_;
};

std::vector<char32_t> alphabetOf(const Parsed &parsed) {
  const auto &trigger = parsed.frontmatter.trigger;
  std::vector<char32_t> alphabet;
  for (const auto &[key, output] : parsed.mappings) {
    for (std::size_t offset = 0; offset < key.size();) {
      const utf8::Decoded decoded = *utf8::decode(key, offset);
      if (!(offset == 0 && trigger)) {
        alphabet.push_back(decoded.character);
      }
      offset += decoded.length;
    }
  }
  std::ranges::sort(alphabet);
  const auto duplicates = std::ranges::unique(alphabet);
  alphabet.erase(duplicates.begin(), duplicates.end());
  return alphabet;
}

} // namespace

std::string ParseError::message() const {
  if (line == 0) {
    return path + ": " + reason;
  }
  return path + ":" + std::to_string(line) + ": " + reason;
}

Table::Table(Frontmatter frontmatter, std::vector<char32_t> alphabet,
             std::unique_ptr<Index> index)
    : frontmatter_(std::move(frontmatter)), alphabet_(std::move(alphabet)),
      index_(std::move(index)) {}

Table::Table(Table &&) noexcept = default;
Table &Table::operator=(Table &&) noexcept = default;
Table::~Table() = default;

std::expected<Table, ParseError> Table::parse(std::string_view path,
                                              std::string_view text) {
  auto parsed = Parser(path, text).run();
  if (!parsed) {
    return std::unexpected(parsed.error());
  }

  std::map<std::string, std::vector<std::string>> byKey;
  for (auto &[key, output] : parsed->mappings) {
    byKey[key].push_back(std::move(output));
  }

  auto index = std::make_unique<Index>();
  marisa::Keyset keyset;
  for (const auto &[key, outputs] : byKey) {
    keyset.push_back(key);
  }
  index->trie.build(keyset);

  // MARISA numbers keys in its own order, so each key's ID comes from a
  // lookup.
  index->outputs.resize(byKey.size());
  marisa::Agent agent;
  for (auto &[key, outputs] : byKey) {
    agent.set_query(key);
    index->trie.lookup(agent);
    index->outputs[agent.key().id()] = std::move(outputs);
  }

  std::vector<char32_t> alphabet = alphabetOf(*parsed);
  return Table(std::move(parsed->frontmatter), std::move(alphabet),
               std::move(index));
}

std::expected<Table, ParseError>
Table::load(const std::filesystem::path &path) {
  const auto fail = [&](std::string reason) {
    return std::unexpected(ParseError{path.string(), 0, std::move(reason)});
  };

  std::error_code error;
  const auto status = std::filesystem::status(path, error);
  if (error) {
    return fail(error.message());
  }
  if (!std::filesystem::is_regular_file(status)) {
    return fail("not a regular file");
  }

  std::ifstream file(path, std::ios::binary);
  const std::string text{std::istreambuf_iterator<char>(file), {}};
  if (!file.is_open() || file.bad()) {
    return fail("can't read the file");
  }
  return parse(path.string(), text);
}

const Frontmatter &Table::frontmatter() const { return frontmatter_; }

bool Table::inAlphabet(char32_t c) const {
  return std::ranges::binary_search(alphabet_, c);
}

std::span<const std::string> Table::exact(std::string_view key) const {
  marisa::Agent agent;
  agent.set_query(key);
  if (!index_->trie.lookup(agent)) {
    return {};
  }
  return index_->outputs[agent.key().id()];
}

std::vector<Candidate> Table::completions(std::string_view prefix) const {
  struct Match {
    std::size_t length;
    std::string key;
    std::size_t id;
  };

  // The agent's key is overwritten by each step of the search, so every
  // match copies it.
  std::vector<Match> matches;
  marisa::Agent agent;
  agent.set_query(prefix);
  while (index_->trie.predictive_search(agent)) {
    const marisa::Key &key = agent.key();
    matches.push_back(
        {utf8::length(key.str()), std::string(key.str()), key.id()});
  }

  // std::string compares bytes as unsigned, which for UTF-8 is code point
  // order.
  std::ranges::sort(matches, [](const Match &a, const Match &b) {
    return std::tie(a.length, a.key) < std::tie(b.length, b.key);
  });

  std::vector<Candidate> candidates;
  for (const Match &match : matches) {
    for (const std::string &output : index_->outputs[match.id]) {
      candidates.push_back({match.key, output});
    }
  }
  return candidates;
}

bool Table::extendable(std::string_view prefix) const {
  marisa::Agent agent;
  agent.set_query(prefix);
  while (index_->trie.predictive_search(agent)) {
    if (agent.key().length() > prefix.size()) {
      return true;
    }
  }
  return false;
}

std::optional<std::pair<std::size_t, std::string_view>>
Table::longestPrefix(std::string_view text) const {
  // Matches come shortest first.
  std::optional<std::pair<std::size_t, std::string_view>> longest;
  marisa::Agent agent;
  agent.set_query(text);
  while (index_->trie.common_prefix_search(agent)) {
    const marisa::Key &key = agent.key();
    longest.emplace(key.length(), index_->outputs[key.id()].front());
  }
  return longest;
}

} // namespace ibusweb::table
```

- [ ] **Step 5: Write the tools**

`engines/table/native/check.cpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// table-check FILE.table...: parses each table, stopping at the first error.

#include <iostream>

#include "../src/table.hpp"

int main(int argc, char **argv) {
  if (argc < 2) {
    std::cerr << "usage: table-check FILE.table...\n";
    return 2;
  }

  for (int i = 1; i < argc; ++i) {
    const auto table = ibusweb::table::Table::load(argv[i]);
    if (!table) {
      std::cerr << table.error().message() << '\n';
      return 1;
    }
  }
  return 0;
}
```

`engines/table/native/describe.cpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// table-describe FILE.table...: prints the tables' engine descriptors as one
// JSON array, each engine named for its file's stem.

#include <cstdio>
#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>

#include "../src/table.hpp"

namespace {

std::string jsonString(std::string_view text) {
  std::string out = "\"";
  for (const char c : text) {
    switch (c) {
    case '"':
      out += "\\\"";
      break;
    case '\\':
      out += "\\\\";
      break;
    case '\n':
      out += "\\n";
      break;
    case '\t':
      out += "\\t";
      break;
    default:
      if (static_cast<unsigned char>(c) < 0x20) {
        char escape[7];
        std::snprintf(escape, sizeof escape, "\\u%04x",
                      static_cast<unsigned>(c));
        out += escape;
      } else {
        out += c;
      }
    }
  }
  return out + "\"";
}

} // namespace

int main(int argc, char **argv) {
  using ibusweb::table::Layout;
  using ibusweb::table::Table;

  if (argc < 2) {
    std::cerr << "usage: table-describe FILE.table...\n";
    return 2;
  }

  std::string json = "[";
  for (int i = 1; i < argc; ++i) {
    const std::filesystem::path path = argv[i];
    const auto table = Table::load(path);
    if (!table) {
      std::cerr << table.error().message() << '\n';
      return 1;
    }

    const auto &frontmatter = table->frontmatter();
    std::string languages = "[";
    for (const std::string &language : frontmatter.languages) {
      languages += (languages.size() > 1 ? "," : "") + jsonString(language);
    }
    languages += "]";
    const char *layout = frontmatter.layout == Layout::us ? "us" : "default";

    json += (i > 1 ? "," : "");
    json += "{\"name\":" + jsonString(path.stem().string()) +
            ",\"displayName\":" + jsonString(frontmatter.name) +
            ",\"languages\":" + languages + ",\"keyboard\":{\"layout\":\"" +
            layout + "\",\"passThrough\":[]}}";
  }
  std::cout << json << "]\n";
  return 0;
}
```

- [ ] **Step 6: Write the Meson project and the module**

`engines/table/meson.build`:

```meson
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
project(
  'ibus-web-table',
  'cpp',
  default_options: ['cpp_std=c++23', 'warning_level=3', 'werror=true'],
)

marisa = dependency('marisa')

engine = static_library(
  'table',
  'src/table.cpp',
  'src/utf8.cpp',
  dependencies: marisa,
)

executable('table-check', 'native/check.cpp', link_with: engine, install: true)
executable(
  'table-describe',
  'native/describe.cpp',
  link_with: engine,
  install: true,
)
```

`engines/table/module.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) testing toolchain;

      marisa = pkgs.callPackage ./_marisa.nix { };

      tools = pkgs.stdenv.mkDerivation {
        pname = "ibus-web-table-tools";
        version = "0.1.0";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./meson.build
            ./src
            ./native
          ];
        };

        nativeBuildInputs = [
          pkgs.meson
          pkgs.ninja
          pkgs.pkg-config
        ];
        buildInputs = [ marisa ];
      };
    in
    {
      ibusWeb.engines.table = {
        inherit tools;
        sources = lib.filter (lib.hasSuffix ".cpp") (lib.attrNames (builtins.readDir ./src));
      };

      # The engine's sources build for the browser too, so the editor reads
      # them against the WebAssembly MARISA and C++ library. The native
      # checks' GoogleTest headers are the same release's.
      ibusWeb.toolchain.clangdPathFlags."engines/table/.*\\.(cpp|hpp)" = [
        "-std=c++23"
        "-isystem${lib.getDev toolchain.pkgsWasm.marisa}/include"
      ]
      ++ testing.gtestCflagList;
    };
}
```

- [ ] **Step 7: Run the check and the editor check**

```bash
nix develop -c git add engines/table/src engines/table/native engines/table/meson.build engines/table/module.nix
nix build .#checks.x86_64-linux.table-parse -L
nix build .#checks.x86_64-linux.toolchain-clangd -L
```

Expected: both pass. `table-parse`'s output `errors.txt` is exactly the 27 lines in its `errors` text. A failure prints a `diff -u` of expected against actual messages; fix the parser, not the expectations, unless the spec says otherwise.

- [ ] **Step 8: Commit**

```bash
nix develop -c git add engines/table/src engines/table/native engines/table/meson.build engines/table/module.nix engines/table/checks/parse
nix develop -c git commit -m "feat(table): parse tables into a MARISA index" -- engines/table/src engines/table/native engines/table/meson.build engines/table/module.nix engines/table/checks/parse
```

---

## Task 4: Sessions: `Sink`, command mode and continuous mode

**Files:**
- Create: `engines/table/src/keys.hpp`, `sink.hpp`, `session.hpp`, `composition.hpp`, `session.cpp`, `command.cpp`, `continuous.cpp`
- Create: `engines/table/meson.options`
- Create: `engines/table/checks/golden/checks.nix`, `golden.cpp`, `recorder.hpp`
- Modify: `engines/table/meson.build` (whole file below), `engines/table/module.nix` (the fileset)

**Interfaces:**
- Consumes: `Table`, `Candidate`, `Mode`, `utf8::*` (Task 3); `ibusWeb.engines.table.tools` (Task 3); `config.ibusWeb.lib.mesonAllTestsRan`.
- Produces, in `ibusweb::table`: `keys::{space, BackSpace, Tab, Return, Escape, Home, Left, Up, Right, Down, Page_Up, Page_Down, End, KP_Enter, ISO_Left_Tab}` (`std::uint32_t`, contract values) and `constexpr bool keys::isModifier(std::uint32_t)`; `masks::{Shift, Control, Mod1, Super, Release}`; `class Sink` with `commit(std::string_view)`, `preedit(std::string_view)`, `candidates(std::span<const Candidate> all, std::size_t cursor, bool cursorShown)`; `inline constexpr std::size_t pageSize = 10`; `class Session` with `processKey(std::uint32_t keyval, char32_t character, std::uint32_t modifiers) -> bool`, `candidateClicked(std::size_t)`, `pageUp()`, `pageDown()`, `cursorUp()`, `cursorDown()`, `reset()`; `std::unique_ptr<Session> makeSession(const Table &table, Sink &sink)`. `ibusWeb.engines.table.sources` becomes `[ "command.cpp" "continuous.cpp" "session.cpp" "table.cpp" "utf8.cpp" ]`. Check `table-golden`.

- [ ] **Step 1: Write the recording sink and the golden tests**

`engines/table/checks/golden/recorder.hpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <string>
#include <utility>
#include <vector>

#include "../../src/sink.hpp"

namespace ibusweb::table {

// A sink that records each call as a line of text. Candidate lists are
// summarised, so that a trace stays readable; the last list is kept whole
// for tests of its contents.
class Recorder final : public Sink {
public:
  void commit(std::string_view text) override {
    events_.push_back("commit \"" + std::string(text) + "\"");
  }

  void preedit(std::string_view text) override {
    events_.push_back("preedit \"" + std::string(text) + "\"");
  }

  void candidates(std::span<const Candidate> all, std::size_t cursor,
                  bool cursorShown) override {
    last_.assign(all.begin(), all.end());
    if (all.empty()) {
      events_.emplace_back("candidates none");
      return;
    }
    events_.push_back("candidates " + std::to_string(all.size()) + " cursor " +
                      std::to_string(cursor) +
                      (cursorShown ? " shown" : " hidden"));
  }

  // The events since the last call.
  std::vector<std::string> take() { return std::exchange(events_, {}); }

  std::vector<std::string> keys() const {
    std::vector<std::string> keys;
    for (const Candidate &candidate : last_) {
      keys.push_back(candidate.key);
    }
    return keys;
  }

private:
  std::vector<std::string> events_;
  std::vector<Candidate> last_;
};

} // namespace ibusweb::table
```

`engines/table/checks/golden/golden.cpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include <cstdlib>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <gtest/gtest.h>

#include "../../src/keys.hpp"
#include "../../src/session.hpp"
#include "../../src/table.hpp"
#include "../../src/utf8.hpp"
#include "recorder.hpp"

namespace ibusweb::table {
namespace {

using Events = std::vector<std::string>;
using Keys = std::vector<std::string>;

constexpr std::string_view commandTable = "name = Test\n"
                                          "languages = und\n"
                                          "mode = command\n"
                                          "trigger = \\\n"
                                          "---\n"
                                          "\\alpha\tα\n"
                                          "\\aleph\tℵ\n"
                                          "\\beta\tβ\n"
                                          "\\to\t→\n"
                                          "\\to\t⟶\n"
                                          "\\xa\t1\n"
                                          "\\xb\t2\n"
                                          "\\xc\t3\n"
                                          "\\xd\t4\n"
                                          "\\xe\t5\n"
                                          "\\xf\t6\n"
                                          "\\xg\t7\n"
                                          "\\xh\t8\n"
                                          "\\xi\t9\n"
                                          "\\xj\t10\n"
                                          "\\xk\t11\n"
                                          "\\xl\t12\n";

constexpr std::string_view continuousTable = "name = Mini\n"
                                             "languages = und\n"
                                             "mode = continuous\n"
                                             "---\n"
                                             "S\tʃ\n"
                                             "@\tə\n"
                                             "@\\\tɘ\n"
                                             "t`\tʈ\n"
                                             "_\t\u0361\n"
                                             "_0\t\u0325\n"
                                             "_h\tʰ\n"
                                             "_H\t\u0301\n"
                                             "_H_T\t\u1dc4\n";

// What ibus_keyval_to_unicode gives for the keys that have a character.
char32_t characterOf(std::uint32_t keyval) {
  switch (keyval) {
  case keys::BackSpace:
    return 0x08;
  case keys::Tab:
    return 0x09;
  case keys::Return:
  case keys::KP_Enter:
    return 0x0d;
  case keys::Escape:
    return 0x1b;
  default:
    if (keyval >= 0x20 && keyval < 0x7f) {
      return keyval;
    }
    if ((keyval & 0xff000000) == 0x01000000) {
      return keyval & 0x00ffffff;
    }
    return 0;
  }
}

class SessionTest : public testing::Test {
protected:
  void load(std::string_view text) {
    auto parsed = Table::parse("test.table", text);
    ASSERT_TRUE(parsed) << parsed.error().message();
    table_.emplace(std::move(*parsed));
    session_ = makeSession(*table_, sink_);
  }

  bool press(std::uint32_t keyval, std::uint32_t modifiers = 0) {
    return session_->processKey(keyval, characterOf(keyval), modifiers);
  }

  // Types each character as its own key, and returns whether each was
  // consumed: `y` or `n`.
  std::string type(std::string_view text) {
    std::string consumed;
    for (std::size_t offset = 0; offset < text.size();) {
      const utf8::Decoded decoded = *utf8::decode(text, offset);
      const char32_t c = decoded.character;
      const std::uint32_t keyval = c < 0x7f ? c : 0x01000000 | c;
      consumed += session_->processKey(keyval, c, 0) ? 'y' : 'n';
      offset += decoded.length;
    }
    return consumed;
  }

  Recorder sink_;
  std::optional<Table> table_;
  std::unique_ptr<Session> session_;
};

class Command : public SessionTest {
protected:
  void SetUp() override { load(commandTable); }
};

class Continuous : public SessionTest {
protected:
  void SetUp() override { load(continuousTable); }
};

TEST(TableQueries, CompletionsByLengthThenCodePointThenFileOrder) {
  const auto table = Table::parse("test.table", commandTable);
  ASSERT_TRUE(table) << table.error().message();

  const auto all = table->completions("\\");
  ASSERT_EQ(all.size(), 17u);
  EXPECT_EQ(all[0].key, "\\to");
  EXPECT_EQ(all[0].output, "→");
  EXPECT_EQ(all[1].key, "\\to");
  EXPECT_EQ(all[1].output, "⟶");
  EXPECT_EQ(all[2].key, "\\xa");
  EXPECT_EQ(all[14].key, "\\beta");
  EXPECT_EQ(all[15].key, "\\aleph");
  EXPECT_EQ(all[16].key, "\\alpha");

  const auto al = table->completions("\\al");
  ASSERT_EQ(al.size(), 2u);
  EXPECT_EQ(al[0].key, "\\aleph");
  EXPECT_EQ(al[1].key, "\\alpha");

  EXPECT_TRUE(table->completions("\\q").empty());
}

TEST(TableQueries, ExactExtendableAndAlphabet) {
  const auto table = Table::parse("test.table", commandTable);
  ASSERT_TRUE(table) << table.error().message();

  const auto to = table->exact("\\to");
  ASSERT_EQ(to.size(), 2u);
  EXPECT_EQ(to[0], "→");
  EXPECT_EQ(to[1], "⟶");
  EXPECT_TRUE(table->exact("\\t").empty());

  EXPECT_TRUE(table->extendable("\\al"));
  EXPECT_TRUE(table->extendable("\\"));
  EXPECT_FALSE(table->extendable("\\alpha"));
  EXPECT_FALSE(table->extendable("\\q"));

  EXPECT_TRUE(table->inAlphabet(U'a'));
  EXPECT_FALSE(table->inAlphabet(U'\\'));
  EXPECT_FALSE(table->inAlphabet(U'2'));
}

TEST(TableQueries, LongestPrefix) {
  const auto table = Table::parse("test.table", continuousTable);
  ASSERT_TRUE(table) << table.error().message();

  const auto schwa = table->longestPrefix("@\\x");
  ASSERT_TRUE(schwa);
  EXPECT_EQ(schwa->first, 2u);
  EXPECT_EQ(schwa->second, "ɘ");

  const auto tone = table->longestPrefix("_H_0");
  ASSERT_TRUE(tone);
  EXPECT_EQ(tone->first, 2u);
  EXPECT_EQ(tone->second, "\u0301");

  EXPECT_FALSE(table->longestPrefix("t_"));
  EXPECT_TRUE(table->inAlphabet(U'\\'));
}

TEST_F(Command, IdleKeysPassThrough) {
  EXPECT_EQ(type("a,"), "nn");
  EXPECT_EQ(press(keys::Return), false);
  EXPECT_EQ(press(keys::BackSpace), false);
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Command, TriggerOpensComposition) {
  EXPECT_EQ(type("\\"), "y");
  EXPECT_EQ(sink_.take(),
            (Events{"preedit \"\\\"", "candidates 17 cursor 0 hidden"}));
}

TEST_F(Command, CompletionsWithoutExactMatchHideTheCursor) {
  EXPECT_EQ(type("\\al"), "yyy");
  EXPECT_EQ(sink_.take().back(), "candidates 2 cursor 0 hidden");
  EXPECT_EQ(sink_.keys(), (Keys{"\\aleph", "\\alpha"}));
}

TEST_F(Command, ExactMatchShowsTheCursor) {
  EXPECT_EQ(type("\\alpha"), "yyyyyy");
  EXPECT_EQ(sink_.take().back(), "candidates 1 cursor 0 shown");
}

TEST_F(Command, SpaceCommitsTheHighlightedCandidate) {
  type("\\alpha");
  sink_.take();
  EXPECT_TRUE(press(keys::space));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"α\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, SpaceWithoutCursorCommitsTheBufferAndIsTyped) {
  type("\\al");
  sink_.take();
  EXPECT_FALSE(press(keys::space));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\\al\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, DeadEndStaysAsTyped) {
  EXPECT_EQ(type("\\alphabet"), "yyyyyyyyy");
  EXPECT_EQ(sink_.take().back(), "candidates none");
  EXPECT_TRUE(press(keys::Return));
  EXPECT_EQ(sink_.take(), (Events{"commit \"\\alphabet\"", "preedit \"\"",
                                  "candidates none"}));
}

TEST_F(Command, PunctuationCommitsThenIsTyped) {
  EXPECT_EQ(type("\\alpha,"), "yyyyyyn");
  EXPECT_EQ(sink_.take().back(), "candidates none");
}

TEST_F(Command, PunctuationCommitsTheHighlightedCandidate) {
  type("\\alpha");
  sink_.take();
  EXPECT_EQ(type(","), "n");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"α\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, DigitIsNotInTheAlphabet) {
  type("\\al");
  sink_.take();
  EXPECT_EQ(type("2"), "n");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\\al\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, TriggerCommitsAndOpensAnother) {
  type("\\alpha");
  sink_.take();
  EXPECT_EQ(type("\\"), "y");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"α\"", "preedit \"\"", "candidates none",
                    "preedit \"\\\"", "candidates 17 cursor 0 hidden"}));
  EXPECT_EQ(type("beta"), "yyyy");
  EXPECT_EQ(sink_.take().back(), "candidates 1 cursor 0 shown");
  EXPECT_TRUE(press(keys::Return));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"β\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, EnterCommitsTheBufferWithoutCursor) {
  type("\\al");
  sink_.take();
  EXPECT_TRUE(press(keys::KP_Enter));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\\al\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, EnterCommitsTheHighlightedCandidate) {
  type("\\to");
  press(keys::Down);
  sink_.take();
  EXPECT_TRUE(press(keys::Return));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"⟶\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, ArrowsAndTabMoveTheCursor) {
  type("\\to");
  sink_.take();
  EXPECT_TRUE(press(keys::Down));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 1 shown"}));
  EXPECT_TRUE(press(keys::Down));
  EXPECT_EQ(sink_.take(), Events{});
  EXPECT_TRUE(press(keys::Up));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 0 shown"}));
  EXPECT_TRUE(press(keys::Tab));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 1 shown"}));
  EXPECT_TRUE(press(keys::ISO_Left_Tab, masks::Shift));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 0 shown"}));
  EXPECT_TRUE(press(keys::Tab));
  EXPECT_TRUE(press(keys::Tab, masks::Shift));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 1 shown",
                                  "candidates 2 cursor 0 shown"}));
}

TEST_F(Command, MovingAHiddenCursorShowsItInPlace) {
  type("\\al");
  sink_.take();
  EXPECT_TRUE(press(keys::Down));
  EXPECT_EQ(sink_.take(), (Events{"candidates 2 cursor 0 shown"}));
  EXPECT_TRUE(press(keys::space));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"ℵ\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, Paging) {
  type("\\x");
  EXPECT_EQ(sink_.take().back(), "candidates 12 cursor 0 hidden");
  EXPECT_TRUE(press(keys::Page_Down));
  EXPECT_EQ(sink_.take(), (Events{"candidates 12 cursor 10 hidden"}));
  EXPECT_TRUE(press(keys::Page_Down));
  EXPECT_EQ(sink_.take(), Events{});
  EXPECT_TRUE(press(keys::Page_Up));
  EXPECT_EQ(sink_.take(), (Events{"candidates 12 cursor 0 hidden"}));
  EXPECT_TRUE(press(keys::Page_Up));
  EXPECT_EQ(sink_.take(), Events{});

  press(keys::Down);
  press(keys::Down);
  sink_.take();
  session_->pageDown();
  EXPECT_EQ(sink_.take(), (Events{"candidates 12 cursor 11 shown"}));
  session_->pageUp();
  EXPECT_EQ(sink_.take(), (Events{"candidates 12 cursor 1 shown"}));
  EXPECT_TRUE(press(keys::space));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"2\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, BackspaceThroughTheTrigger) {
  type("\\a");
  sink_.take();
  EXPECT_TRUE(press(keys::BackSpace));
  EXPECT_EQ(sink_.take(),
            (Events{"preedit \"\\\"", "candidates 17 cursor 0 hidden"}));
  EXPECT_TRUE(press(keys::BackSpace));
  EXPECT_EQ(sink_.take(), (Events{"preedit \"\"", "candidates none"}));
  EXPECT_FALSE(press(keys::BackSpace));
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Command, EscapeCommitsTheBuffer) {
  type("\\alpha");
  sink_.take();
  EXPECT_TRUE(press(keys::Escape));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\\alpha\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, CaretKeysCommitTheBufferAndPassThrough) {
  for (const std::uint32_t keyval :
       {keys::Left, keys::Right, keys::Home, keys::End}) {
    type("\\al");
    sink_.take();
    EXPECT_FALSE(press(keyval));
    EXPECT_EQ(sink_.take(),
              (Events{"commit \"\\al\"", "preedit \"\"", "candidates none"}));
  }
}

TEST_F(Command, ModifiersCommitTheBufferAndPassThrough) {
  for (const std::uint32_t mask : {masks::Control, masks::Mod1, masks::Super}) {
    type("\\alpha");
    sink_.take();
    EXPECT_FALSE(press('c', mask));
    EXPECT_EQ(sink_.take(), (Events{"commit \"\\alpha\"", "preedit \"\"",
                                    "candidates none"}));
  }
  EXPECT_FALSE(press('\\', masks::Control));
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Command, ReleasesAndModifierKeysChangeNothing) {
  type("\\al");
  sink_.take();
  EXPECT_FALSE(press('p', masks::Release));
  EXPECT_FALSE(press(0xffe1));
  EXPECT_FALSE(press(0xffe3, masks::Shift));
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Command, KeysThatTypeNothingCommitTheBufferAndPassThrough) {
  for (const std::uint32_t keyval : {0xffffu, 0xff63u, 0xffbeu}) {
    type("\\al");
    sink_.take();
    EXPECT_FALSE(press(keyval));
    EXPECT_EQ(sink_.take(),
              (Events{"commit \"\\al\"", "preedit \"\"", "candidates none"}));
  }
}

TEST_F(Command, ClickingACandidateCommitsIt) {
  type("\\x");
  sink_.take();
  session_->candidateClicked(12);
  EXPECT_EQ(sink_.take(), Events{});
  session_->candidateClicked(11);
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"12\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Command, ResetEmitsNothing) {
  type("\\al");
  sink_.take();
  session_->reset();
  EXPECT_EQ(sink_.take(), Events{});
  EXPECT_EQ(type("a"), "n");
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Continuous, UnextendableKeyCommitsAtOnce) {
  EXPECT_EQ(type("S"), "y");
  EXPECT_EQ(sink_.take(), (Events{"commit \"ʃ\""}));
}

TEST_F(Continuous, LongestMatch) {
  EXPECT_EQ(type("@"), "y");
  EXPECT_EQ(sink_.take(),
            (Events{"preedit \"@\"", "candidates 2 cursor 0 hidden"}));
  EXPECT_EQ(type("\\"), "y");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"ɘ\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, LiteralFallback) {
  EXPECT_EQ(type("t_"), "yy");
  EXPECT_EQ(
      sink_.take(),
      (Events{"preedit \"t\"", "candidates 1 cursor 0 hidden", "commit \"t\"",
              "preedit \"_\"", "candidates 5 cursor 0 hidden"}));
  EXPECT_EQ(type("h"), "y");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"ʰ\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, CombiningMarksCommitAsWritten) {
  type("@_");
  sink_.take();
  EXPECT_EQ(type("0"), "y");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\u0325\"", "preedit \"\"", "candidates none"}));

  EXPECT_EQ(type("_H_0"), "yyyy");
  EXPECT_EQ(sink_.take().at(6), "commit \"\u0301\u0325\"");

  type("_H_T");
  EXPECT_EQ(sink_.take().at(6), "commit \"\u1dc4\"");
}

TEST_F(Continuous, SpaceFlushesAndPassesThrough) {
  type("@");
  sink_.take();
  EXPECT_FALSE(press(keys::space));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"ə\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, EnterFlushesAndPassesThrough) {
  type("_H");
  sink_.take();
  EXPECT_FALSE(press(keys::Return));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\u0301\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, FlushUsesLiteralFallback) {
  type("t");
  sink_.take();
  EXPECT_FALSE(press(keys::Escape));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"t\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, CharactersOutsideTheAlphabetFlush) {
  type("@");
  sink_.take();
  EXPECT_EQ(type("x"), "n");
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"ə\"", "preedit \"\"", "candidates none"}));
  EXPECT_EQ(type("x"), "n");
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Continuous, BackspaceDeletesPendingCharacters) {
  type("_H");
  sink_.take();
  EXPECT_TRUE(press(keys::BackSpace));
  EXPECT_EQ(sink_.take(),
            (Events{"preedit \"_\"", "candidates 5 cursor 0 hidden"}));
  EXPECT_TRUE(press(keys::BackSpace));
  EXPECT_EQ(sink_.take(), (Events{"preedit \"\"", "candidates none"}));
  EXPECT_FALSE(press(keys::BackSpace));
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Continuous, ModifiersFlushAndPassThrough) {
  type("@");
  sink_.take();
  EXPECT_FALSE(press('a', masks::Control));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"ə\"", "preedit \"\"", "candidates none"}));
  EXPECT_FALSE(press('S', masks::Mod1));
  EXPECT_EQ(sink_.take(), Events{});
}

TEST_F(Continuous, ModifierKeysAndReleasesChangeNothing) {
  type("_");
  sink_.take();
  EXPECT_FALSE(press(0xffe1));
  EXPECT_FALSE(press('_', masks::Shift | masks::Release));
  EXPECT_EQ(sink_.take(), Events{});
  EXPECT_TRUE(press('H', masks::Shift));
  EXPECT_EQ(sink_.take(),
            (Events{"preedit \"_H\"", "candidates 2 cursor 0 hidden"}));
}

TEST_F(Continuous, CandidatesGuideAndCanBeClicked) {
  type("_");
  sink_.take();
  EXPECT_EQ(sink_.keys(), (Keys{"_", "_0", "_H", "_h", "_H_T"}));

  session_->cursorDown();
  session_->cursorUp();
  EXPECT_EQ(sink_.take(), Events{});

  session_->candidateClicked(2);
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\u0301\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, ArrowsFlushRatherThanNavigate) {
  type("_");
  sink_.take();
  EXPECT_FALSE(press(keys::Down));
  EXPECT_EQ(sink_.take(),
            (Events{"commit \"\u0361\"", "preedit \"\"", "candidates none"}));
}

TEST_F(Continuous, ResetEmitsNothing) {
  type("_H");
  sink_.take();
  session_->reset();
  EXPECT_EQ(sink_.take(), Events{});
  EXPECT_FALSE(press(keys::space));
  EXPECT_EQ(sink_.take(), Events{});
}

TEST(Xsampa, ShippedTable) {
  const char *path = std::getenv("IBUS_WEB_XSAMPA_TABLE");
  ASSERT_NE(path, nullptr) << "IBUS_WEB_XSAMPA_TABLE is required";
  const auto table = Table::load(path);
  ASSERT_TRUE(table) << table.error().message();

  Recorder sink;
  const auto session = makeSession(*table, sink);
  const auto type = [&](std::string_view text) {
    for (const char c : text) {
      session->processKey(static_cast<unsigned char>(c), c, 0);
    }
  };

  type("S@");
  EXPECT_FALSE(session->processKey(keys::space, U' ', 0));
  type("t_hr\\`");
  EXPECT_FALSE(session->processKey(keys::space, U' ', 0));

  std::string committed;
  for (const std::string &event : sink.take()) {
    if (event.starts_with("commit ")) {
      committed += event.substr(8, event.size() - 9);
    }
  }
  EXPECT_EQ(committed, "ʃətʰɻ");
}

} // namespace
} // namespace ibusweb::table
```

`engines/table/checks/golden/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb.engines.table) tools;
    in
    {
      # The tools' build with the golden tests turned on, run by Meson.
      checks.table-golden = tools.overrideAttrs (old: {
        pname = "ibus-web-table-golden";

        src = lib.fileset.toSource {
          root = ../..;
          fileset = lib.fileset.unions [
            ../../meson.build
            ../../meson.options
            ../../src
            ../../native
            ../../tables/xsampa.table
            ./golden.cpp
            ./recorder.hpp
          ];
        };

        mesonFlags = (old.mesonFlags or [ ]) ++ [ "-Dtests=true" ];
        buildInputs = old.buildInputs ++ [ pkgs.gtest ];

        doCheck = true;
        checkPhase = ''
          runHook preCheck
          ${config.ibusWeb.lib.mesonAllTestsRan "table-golden"}
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall
          mkdir $out
          cp meson-logs/testlog.txt $out/
          runHook postInstall
        '';
      });
    };
}
```

- [ ] **Step 2: Turn the tests on in Meson**

`engines/table/meson.options`:

```meson
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
option('tests', type: 'boolean', value: false, description: 'Build and register the golden tests')
```

`engines/table/meson.build`, replacing the whole file (the sessions' sources and the golden test are added):

```meson
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
project(
  'ibus-web-table',
  'cpp',
  default_options: ['cpp_std=c++23', 'warning_level=3', 'werror=true'],
)

marisa = dependency('marisa')

engine = static_library(
  'table',
  'src/command.cpp',
  'src/continuous.cpp',
  'src/session.cpp',
  'src/table.cpp',
  'src/utf8.cpp',
  dependencies: marisa,
)

executable('table-check', 'native/check.cpp', link_with: engine, install: true)
executable(
  'table-describe',
  'native/describe.cpp',
  link_with: engine,
  install: true,
)

if get_option('tests')
  gtest = dependency('gtest', main: true)
  golden = executable(
    'golden',
    'checks/golden/golden.cpp',
    link_with: engine,
    dependencies: gtest,
  )
  test(
    'golden',
    golden,
    env: {
      'IBUS_WEB_XSAMPA_TABLE': meson.current_source_dir() / 'tables' / 'xsampa.table',
    },
  )
endif
```

In `engines/table/module.nix`, add `./meson.options` to the tools' fileset:

```nix
          fileset = lib.fileset.unions [
            ./meson.build
            ./meson.options
            ./src
            ./native
          ];
```

Run:

```bash
nix develop -c git add engines/table/checks/golden engines/table/meson.options engines/table/meson.build engines/table/module.nix
nix build .#checks.x86_64-linux.table-golden -L
```

Expected: FAIL in Meson's configure step: `ERROR: File src/command.cpp does not exist.`

- [ ] **Step 3: Write the key constants and the sink**

`engines/table/src/keys.hpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <cstdint>

// X11 keysyms and IBus modifier masks by value, so that sessions build
// without IBus headers.
namespace ibusweb::table::keys {

inline constexpr std::uint32_t space = 0x20;
inline constexpr std::uint32_t BackSpace = 0xff08;
inline constexpr std::uint32_t Tab = 0xff09;
inline constexpr std::uint32_t Return = 0xff0d;
inline constexpr std::uint32_t Escape = 0xff1b;
inline constexpr std::uint32_t Home = 0xff50;
inline constexpr std::uint32_t Left = 0xff51;
inline constexpr std::uint32_t Up = 0xff52;
inline constexpr std::uint32_t Right = 0xff53;
inline constexpr std::uint32_t Down = 0xff54;
inline constexpr std::uint32_t Page_Up = 0xff55;
inline constexpr std::uint32_t Page_Down = 0xff56;
inline constexpr std::uint32_t End = 0xff57;
inline constexpr std::uint32_t KP_Enter = 0xff8d;
inline constexpr std::uint32_t ISO_Left_Tab = 0xfe20;

// Pressing a modifier on its own arrives as a key event too. Treating it as
// "any other key" would flush a continuous composition between `_` and a
// shifted `H`.
constexpr bool isModifier(std::uint32_t keyval) {
  const bool shiftToHyper = keyval >= 0xffe1 && keyval <= 0xffee;
  const bool isoLocksAndGroups = keyval >= 0xfe01 && keyval <= 0xfe0f;
  const bool modeSwitchAndNumLock = keyval == 0xff7e || keyval == 0xff7f;
  return shiftToHyper || isoLocksAndGroups || modeSwitchAndNumLock;
}

} // namespace ibusweb::table::keys

namespace ibusweb::table::masks {

inline constexpr std::uint32_t Shift = 1u << 0;
inline constexpr std::uint32_t Control = 1u << 2;
inline constexpr std::uint32_t Mod1 = 1u << 3;
inline constexpr std::uint32_t Super = 1u << 26;
inline constexpr std::uint32_t Release = 1u << 30;

} // namespace ibusweb::table::masks
```

`engines/table/src/sink.hpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <cstddef>
#include <span>
#include <string_view>

#include "table.hpp"

namespace ibusweb::table {

// What a session writes to. Within one call into a session, a commit comes
// before the preedit and the candidates that follow it.
class Sink {
public:
  virtual ~Sink() = default;

  virtual void commit(std::string_view text) = 0;

  // Empty hides the preedit.
  virtual void preedit(std::string_view text) = 0;

  // The whole list, paged by the cursor; empty hides it.
  virtual void candidates(std::span<const Candidate> all, std::size_t cursor,
                          bool cursorShown) = 0;
};

} // namespace ibusweb::table
```

- [ ] **Step 4: Write the session interface and the shared candidate list**

`engines/table/src/session.hpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>

#include "sink.hpp"
#include "table.hpp"

namespace ibusweb::table {

inline constexpr std::size_t pageSize = 10;

// One input context's composition. The table and the sink must outlive it.
class Session {
public:
  virtual ~Session() = default;

  // `character` is the key's Unicode value, or 0 if it has none. Returns
  // whether the key was consumed.
  virtual bool processKey(std::uint32_t keyval, char32_t character,
                          std::uint32_t modifiers) = 0;

  // An absolute index into the candidate list.
  virtual void candidateClicked(std::size_t index) = 0;

  virtual void pageUp() = 0;
  virtual void pageDown() = 0;
  virtual void cursorUp() = 0;
  virtual void cursorDown() = 0;

  // Clears the state and emits nothing: the page commits a visible preedit
  // itself.
  virtual void reset() = 0;
};

// A session of the table's mode.
std::unique_ptr<Session> makeSession(const Table &table, Sink &sink);

} // namespace ibusweb::table
```

`engines/table/src/composition.hpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

#include "session.hpp"
#include "sink.hpp"
#include "table.hpp"

namespace ibusweb::table {

// Whether a key's character would be typed: neither absent nor a control
// character. Keys such as Return carry control characters.
constexpr bool isPrintable(char32_t character) {
  return character >= 0x20 && character != 0x7f &&
         !(character >= 0x80 && character < 0xa0);
}

// A session's candidates, its cursor and whether the cursor is shown.
class CandidateList {
public:
  void set(std::vector<Candidate> list, bool cursorShown);
  void clear();

  // The candidate under the cursor if it is shown.
  const Candidate *highlighted() const;
  const Candidate *at(std::size_t index) const;

  // Each returns whether anything changed. A hidden cursor is shown where it
  // is rather than moved.
  bool cursorUp();
  bool cursorDown();
  bool pageUp();
  bool pageDown();

  void show(Sink &sink) const;

private:
  std::vector<Candidate> list_;
  std::size_t cursor_ = 0;
  bool cursorShown_ = false;
};

std::unique_ptr<Session> makeCommandSession(const Table &table, Sink &sink);
std::unique_ptr<Session> makeContinuousSession(const Table &table, Sink &sink);

} // namespace ibusweb::table
```

`engines/table/src/session.cpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include "session.hpp"

#include <algorithm>
#include <utility>

#include "composition.hpp"

namespace ibusweb::table {

void CandidateList::set(std::vector<Candidate> list, bool cursorShown) {
  list_ = std::move(list);
  cursor_ = 0;
  cursorShown_ = cursorShown && !list_.empty();
}

void CandidateList::clear() { set({}, false); }

const Candidate *CandidateList::highlighted() const {
  return cursorShown_ ? &list_[cursor_] : nullptr;
}

const Candidate *CandidateList::at(std::size_t index) const {
  return index < list_.size() ? &list_[index] : nullptr;
}

bool CandidateList::cursorUp() {
  if (list_.empty()) {
    return false;
  }
  if (!cursorShown_) {
    cursorShown_ = true;
    return true;
  }
  if (cursor_ == 0) {
    return false;
  }
  --cursor_;
  return true;
}

bool CandidateList::cursorDown() {
  if (list_.empty()) {
    return false;
  }
  if (!cursorShown_) {
    cursorShown_ = true;
    return true;
  }
  if (cursor_ + 1 == list_.size()) {
    return false;
  }
  ++cursor_;
  return true;
}

bool CandidateList::pageUp() {
  if (cursor_ < pageSize) {
    return false;
  }
  cursor_ -= pageSize;
  return true;
}

bool CandidateList::pageDown() {
  const std::size_t nextPage = (cursor_ / pageSize + 1) * pageSize;
  if (nextPage >= list_.size()) {
    return false;
  }
  cursor_ = std::min(cursor_ + pageSize, list_.size() - 1);
  return true;
}

void CandidateList::show(Sink &sink) const {
  sink.candidates(list_, cursor_, cursorShown_);
}

std::unique_ptr<Session> makeSession(const Table &table, Sink &sink) {
  if (table.frontmatter().mode == Mode::command) {
    return makeCommandSession(table, sink);
  }
  return makeContinuousSession(table, sink);
}

} // namespace ibusweb::table
```

- [ ] **Step 5: Write command mode**

`engines/table/src/command.cpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include <string>
#include <utility>

#include "composition.hpp"
#include "keys.hpp"
#include "utf8.hpp"

namespace ibusweb::table {

namespace {

// A composition opened by the trigger and ended explicitly: a candidate or
// the raw buffer is committed, or Backspace deletes the trigger.
class CommandSession final : public Session {
public:
  CommandSession(const Table &table, Sink &sink)
      : table_(table), sink_(sink), trigger_(*table.frontmatter().trigger) {}

  bool processKey(std::uint32_t keyval, char32_t character,
                  std::uint32_t modifiers) override {
    if ((modifiers & masks::Release) != 0 || keys::isModifier(keyval)) {
      return false;
    }
    if ((modifiers & (masks::Control | masks::Mod1 | masks::Super)) != 0) {
      if (composing()) {
        finish(buffer_);
      }
      return false;
    }
    if (!composing()) {
      return idle(character);
    }

    switch (keyval) {
    case keys::Return:
    case keys::KP_Enter:
      finish(chosen());
      return true;
    case keys::space:
      if (candidates_.highlighted() != nullptr) {
        finish(chosen());
        return true;
      }
      finish(buffer_);
      return false;
    case keys::Escape:
      finish(buffer_);
      return true;
    case keys::BackSpace:
      backspace();
      return true;
    case keys::Up:
    case keys::ISO_Left_Tab:
      cursorUp();
      return true;
    case keys::Down:
      cursorDown();
      return true;
    case keys::Tab:
      if ((modifiers & masks::Shift) != 0) {
        cursorUp();
      } else {
        cursorDown();
      }
      return true;
    case keys::Page_Up:
      pageUp();
      return true;
    case keys::Page_Down:
      pageDown();
      return true;
    default:
      break;
    }

    if (isPrintable(character) && table_.inAlphabet(character)) {
      utf8::append(buffer_, character);
      update();
      return true;
    }
    if (isPrintable(character)) {
      finish(chosen());
      return idle(character);
    }

    // Keys that type nothing (Left, Home, Delete, F1, …) act on the text
    // around the composition, so it is committed first.
    finish(buffer_);
    return false;
  }

  void candidateClicked(std::size_t index) override {
    if (const Candidate *candidate = candidates_.at(index)) {
      finish(candidate->output);
    }
  }

  void pageUp() override { redraw(candidates_.pageUp()); }
  void pageDown() override { redraw(candidates_.pageDown()); }
  void cursorUp() override { redraw(candidates_.cursorUp()); }
  void cursorDown() override { redraw(candidates_.cursorDown()); }

  void reset() override {
    buffer_.clear();
    candidates_.clear();
  }

private:
  bool composing() const { return !buffer_.empty(); }

  bool idle(char32_t character) {
    if (character != trigger_) {
      return false;
    }
    utf8::append(buffer_, character);
    update();
    return true;
  }

  // The highlighted candidate's output if the cursor is shown, otherwise the
  // raw buffer.
  std::string chosen() const {
    const Candidate *candidate = candidates_.highlighted();
    return candidate != nullptr ? candidate->output : buffer_;
  }

  void update() {
    // The exact match, if any, is the shortest completion, so it comes first.
    const bool exact = !table_.exact(buffer_).empty();
    candidates_.set(table_.completions(buffer_), exact);
    sink_.preedit(buffer_);
    candidates_.show(sink_);
  }

  void backspace() {
    buffer_.resize(buffer_.size() - utf8::lastLength(buffer_));
    if (composing()) {
      update();
      return;
    }
    candidates_.clear();
    hide();
  }

  // Takes its text by value: it is often the buffer, which this clears.
  void finish(std::string text) {
    buffer_.clear();
    candidates_.clear();
    sink_.commit(text);
    hide();
  }

  void hide() {
    sink_.preedit("");
    candidates_.show(sink_);
  }

  void redraw(bool changed) {
    if (changed) {
      candidates_.show(sink_);
    }
  }

  const Table &table_;
  Sink &sink_;
  char32_t trigger_;
  std::string buffer_;
  CandidateList candidates_;
};

} // namespace

std::unique_ptr<Session> makeCommandSession(const Table &table, Sink &sink) {
  return std::make_unique<CommandSession>(table, sink);
}

} // namespace ibusweb::table
```

- [ ] **Step 6: Write continuous mode**

`engines/table/src/continuous.cpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include <string>
#include <utility>

#include "composition.hpp"
#include "keys.hpp"
#include "utf8.hpp"

namespace ibusweb::table {

namespace {

// Alphabet characters convert as they are typed. Only what could still
// become a longer key stays pending, as the preedit.
class ContinuousSession final : public Session {
public:
  ContinuousSession(const Table &table, Sink &sink)
      : table_(table), sink_(sink) {}

  bool processKey(std::uint32_t keyval, char32_t character,
                  std::uint32_t modifiers) override {
    if ((modifiers & masks::Release) != 0 || keys::isModifier(keyval)) {
      return false;
    }

    const bool plain =
        (modifiers & (masks::Control | masks::Mod1 | masks::Super)) == 0;
    if (plain && keyval == keys::BackSpace) {
      if (buffer_.empty()) {
        return false;
      }
      // Every prefix of a pending buffer can still extend, so nothing
      // resolves.
      buffer_.resize(buffer_.size() - utf8::lastLength(buffer_));
      show();
      return true;
    }
    if (plain && isPrintable(character) && table_.inAlphabet(character)) {
      utf8::append(buffer_, character);
      resolve(false);
      return true;
    }

    if (!buffer_.empty()) {
      resolve(true);
    }
    return false;
  }

  void candidateClicked(std::size_t index) override {
    const Candidate *candidate = candidates_.at(index);
    if (candidate == nullptr) {
      return;
    }
    const std::string output = candidate->output;
    buffer_.clear();
    sink_.commit(output);
    show();
  }

  void pageUp() override {
    if (candidates_.pageUp()) {
      candidates_.show(sink_);
    }
  }

  void pageDown() override {
    if (candidates_.pageDown()) {
      candidates_.show(sink_);
    }
  }

  // The candidates are a guide to what the buffer can still become; they
  // have no cursor to move.
  void cursorUp() override {}
  void cursorDown() override {}

  void reset() override {
    buffer_.clear();
    candidates_.clear();
    visible_ = false;
  }

private:
  // Commits from the front of the buffer while it can't extend, or until it
  // is empty when flushing: the longest key it starts with, otherwise its
  // first character as typed.
  void resolve(bool flush) {
    std::string out;
    while (!buffer_.empty() && (flush || !table_.extendable(buffer_))) {
      std::size_t consumed = 0;
      if (const auto match = table_.longestPrefix(buffer_)) {
        consumed = match->first;
        out += match->second;
      } else {
        consumed = utf8::decode(buffer_, 0)->length;
        out.append(buffer_, 0, consumed);
      }
      buffer_.erase(0, consumed);
    }

    if (!out.empty()) {
      sink_.commit(out);
    }
    show();
  }

  void show() {
    if (!buffer_.empty()) {
      candidates_.set(table_.completions(buffer_), false);
      sink_.preedit(buffer_);
      candidates_.show(sink_);
      visible_ = true;
      return;
    }

    candidates_.clear();
    if (visible_) {
      sink_.preedit("");
      candidates_.show(sink_);
      visible_ = false;
    }
  }

  const Table &table_;
  Sink &sink_;
  std::string buffer_;
  CandidateList candidates_;
  // Whether the preedit and candidates are on screen, so that emptying an
  // already empty buffer emits nothing.
  bool visible_ = false;
};

} // namespace

std::unique_ptr<Session> makeContinuousSession(const Table &table, Sink &sink) {
  return std::make_unique<ContinuousSession>(table, sink);
}

} // namespace ibusweb::table
```

- [ ] **Step 7: Run the golden tests and the checks around them**

```bash
nix develop -c git add engines/table/src
nix build .#checks.x86_64-linux.table-golden -L
nix build .#checks.x86_64-linux.table-parse .#checks.x86_64-linux.toolchain-clangd -L
nix eval --json .#checks.x86_64-linux --apply 'cs: builtins.filter (n: builtins.match "(table|tools-latex)-.*" n != null) (builtins.attrNames cs)'
```

Expected: `table-golden`'s log ends with `[  PASSED  ] 42 tests.` and Meson's summary `Ok: 1`; the other two pass; the eval prints `["table-golden","table-marisa","table-parse","tools-latex-table"]`.

- [ ] **Step 8: Commit**

```bash
nix develop -c git add engines/table/src engines/table/meson.options engines/table/meson.build engines/table/module.nix engines/table/checks/golden
nix develop -c git commit -m "feat(table): compose in command and continuous mode" -- engines/table/src engines/table/meson.options engines/table/meson.build engines/table/module.nix engines/table/checks/golden
```

---

## Task 5: Documentation and the full verification

**Files:**
- Create: `docs/table.md`
- Modify: `docs/README.md` (one row in the Topics table, after `engines.md`)

**Interfaces:**
- Consumes: everything above.
- Produces: `docs/table.md`, which phase 3 extends with the glue, the side module and the distribution.

- [ ] **Step 1: Write the page**

`docs/table.md`:

````markdown
# The table engine

`engines/table/` is an engine module whose engines are driven by tables: `latex` turns LaTeX commands into Unicode,
and `xsampa` turns X-SAMPA into IPA. Its code is MIT OR Apache-2.0, and no table carries a copyleft licence. This page
describes the table format, where the two tables come from, and the engine's C++ core, which the native checks build
and drive.

## Table format

A table is a UTF-8 file with LF line endings, named `<engine>.table`; the engine's name is the file's stem.
Frontmatter of `key = value` lines ends at a line that is exactly `---`. The body is one mapping per line,
`key<TAB>output`.

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
**alphabet** is every character after the trigger in command mode, and every character of every key in continuous
mode. A key can't contain a space, which ends a composition, nor, in command mode, the trigger after its start, which
opens the next one.

**Completions** of a prefix are the keys starting with it, the prefix included, ordered by key length in code points,
then by key in code point order, then by file order within one key: `\al` offers `\aleph` before `\alpha`.

### Errors

The parser stops at the first error and reports it as `path:line: reason`, or `path: reason` when the file can't be
read at all. `table-parse` holds one malformed table for each:

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
original page is offline; this is the Internet Archive's copy), section by section. Where the chart gives an
alternative spelling (`v\` for `P`, `_j` for `'`, `_=` for `=`, `_~` for `~`), both are keys. Lower-case letters that
are already IPA symbols aren't listed; continuous mode types them as they are. Three plosives the summary leaves to SAMPA
and the full chart (`J\`, `G\`, `?`) are added, and since Unicode has no implosive diacritic, the chart's `_<` is
written out for the five implosives (`b_<`, `d_<`, `J\_<`, `g_<`, `G\_<`).

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
  are `exact(key)`, `completions(prefix)`, `extendable(prefix)` (a longer key starts with it) and
  `longestPrefix(text)`. MARISA's predictive and common-prefix searches find the keys; key IDs never decide order.
- **`Sink`** (`sink.hpp`) is what a session writes to: `commit(text)`, `preedit(text)` (empty hides it) and
  `candidates(all, cursor, cursorShown)` (empty hides them). Sessions pass the whole list; a page is the 10
  candidates around the cursor. Within one call into a session, a commit comes before the preedit and candidates that
  follow it.
- **`Session`** (`session.hpp`) is one context's composition. `makeSession(table, sink)` returns a command or a
  continuous session by the table's mode. `processKey(keyval, character, modifiers)` takes the key's X11 keysym, its
  Unicode value (0 if none) and IBus's modifier mask, and returns whether it consumed the key. `candidateClicked`,
  `pageUp`, `pageDown`, `cursorUp` and `cursorDown` come from the panel. `reset` clears the state and emits nothing.
- `keys.hpp` holds the keysyms and modifier masks by value; `utf8.hpp` decodes and encodes UTF-8.

### Common behaviour

- Key releases, and presses of modifier keys themselves (Shift, Control, Caps Lock, …), return false and change
  nothing. A continuous composition must survive the Shift that types the `H` of `_H`.
- A key held with Control, Alt or Super flushes the composition (as each mode defines it), then passes through.
- The preedit is the raw buffer. What it shows is exactly what blur or Escape leaves behind.
- Clicking a candidate commits its output and ends the composition.

### Command mode

`latex` uses command mode with the trigger `\`.

- **Idle**, the trigger opens a composition with the buffer `\` and is consumed. Every other key passes through.
- **Candidates** are the buffer's completions. If the buffer is a key, the cursor is shown on its first output, which
  is the first completion; otherwise the cursor is hidden.
- **An alphabet character** is appended, even when no key starts with the result: `\alphabet` stays as typed, with no
  candidates.
- **Space** commits the highlighted candidate if the cursor is shown, and is consumed. Otherwise it commits the raw
  buffer and passes through, so the space is typed too.
- **Enter** commits the highlighted candidate if the cursor is shown, otherwise the raw buffer, and is consumed.
- **Any other printable key** (a digit, punctuation, another `\`) commits the highlighted candidate if the cursor is
  shown, otherwise the raw buffer, and is then handled as if idle: `\alpha,` gives `α,`, and `\alpha\beta` gives `α`
  followed by an open `\beta`.
- **Up, Down, Tab and Shift+Tab** move the cursor and show it; a hidden cursor is first shown where it is, on the
  first candidate of its page. **Page Up and Page Down** move it by a page.
- **Backspace** deletes the last character. Deleting the trigger ends the composition and commits nothing.
- **Escape** commits the raw buffer and is consumed.
- **Left, Right, Home and End**, and every other key that types nothing (Delete, Insert, F1, …), commit the raw buffer
  and pass through, so the key acts on committed text.

### Continuous mode

`xsampa` uses continuous mode.

- **An alphabet character** is appended, then the buffer is resolved. While the buffer is non-empty and not
  extendable, the longest key it starts with is committed and removed from its front; if no key matches, its first
  character is committed as typed. What remains can still extend, and stays as the preedit.
- **Flushing** runs the same loop as if nothing could extend, leaving the buffer empty. Several commits from one key
  are joined into one.
- **Any other key** (Space, Enter, Escape, arrows, characters outside the alphabet) flushes, then passes through.
- **Backspace** deletes the last pending character, or passes through when nothing is pending.
- **Candidates** are the pending buffer's completions, a guide to what it can still become, with the cursor hidden.
  They can be clicked and paged; `cursorUp` and `cursorDown` do nothing.

Enter differs between the modes on purpose. A command composition is explicit, so Enter ends it like any composition.
Continuous input has no visible composition step, so Enter keeps its ordinary meaning.

## MARISA

`engines/table/_marisa.nix` overrides nixpkgs' MARISA 0.3.1 for both builds: `pkgsWasm.marisa`, through the table
overlay, and the native one the tools link. It adds upstream
[PR #146](https://github.com/s-yata/marisa-trie/pull/146) (commit `e31c7ed`) with `fetchpatch`: 0.3.1 reads
uninitialized units while packing a `FlatVector`. It turns off tuning for the build machine (`ENABLE_NATIVE_CODE`) and
the command-line tools, which the engine doesn't use, and records the BSD-2-Clause option of MARISA's dual licence.
Upstream's tests run in the check phase wherever the build can run them, which is the native build: that build is the
`table-marisa` check, which also asserts that the WebAssembly build carries the same patches.

## Building and checking

The native build is Meson (`engines/table/meson.build`), from nixpkgs' compiler, linking the patched MARISA. It builds
the engine as a static library and two tools, `ibusWeb.engines.table.tools`:

- `table-check FILE.table...` parses each table and exits 1 with `path:line: reason` on the first error.
- `table-describe FILE.table...` prints the tables' engine descriptors as one JSON array, each named for its file's
  stem, with the frontmatter's display name, languages and layout, and no pass-through keys.

`ibusWeb.engines.table.sources` lists the `.cpp` files in `engines/table/src` by name, for builds of the engine.

| Check               | Covers                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `table-parse`       | Both shipped tables parse and describe their engines; one malformed table per error class fails with its exact message  |
| `table-golden`      | GoogleTest, native, through a recording `Sink`: the table queries and every rule of both modes, and the shipped X-SAMPA |
| `table-marisa`      | Upstream MARISA's tests in the patched native build                                                                     |
| `tools-latex-table` | Vitest: a cut-down `unicode.xml` gives an exact table, every generator rule and both alias failures, and the 24 aliases |

Each is a flake check, run as `nix build .#checks.x86_64-linux.<name> -L`.
````

- [ ] **Step 2: Link it from the index**

In `docs/README.md`'s Topics table, add this row directly after the `engines.md` row:

```markdown
| [table.md](table.md) | The table engine: its table format, the X-SAMPA and LaTeX tables and their sources, command and continuous mode, MARISA, its native checks |
```

Format both pages and check the links:

```bash
nix develop -c oxfmt -c .oxfmtrc.jsonc --write docs/table.md docs/README.md
nix develop -c git add docs/table.md docs/README.md
nix develop -c hk check --all -S links
```

Expected: oxfmt pads the new row to the table's column widths; `links` reports `0 Errors`.

- [ ] **Step 3: Commit**

```bash
nix develop -c git commit -m "docs(table): describe the table format, its data and the engine" -- docs/table.md docs/README.md
```

- [ ] **Step 4: Run the full verification**

```bash
nix run .#write-files
git status --short
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: `write-files` changes nothing (`git status --short` is empty); `nix flake check` passes, including `table-marisa`, `table-parse`, `table-golden`, `tools-latex-table`, `toolchain-clangd`, `flake-hk` and `typescript-*`; `integration-checks` passes; `hk check --all` passes every step (`clang-format`, `nixfmt`, `oxfmt`, `oxlint`, `tsc`, `tsconfig-extends`, `reuse`, `links`). Report each command's result; a check that wasn't run is not reported as passing.

---

## Self-review

- **Spec coverage (phase 2).** MARISA with PR #146 on both builds, upstream tests natively, no host tuning: Task 1. `Table`, the parser and every format rule and error: Task 3. `Sink`, `Session`, `CommandSession`, `ContinuousSession` and every behaviour rule (dead ends, `\alpha,`, `\alpha\beta`, cursor shown and hidden, paging, Backspace through the trigger, Escape, Enter, modifiers, Left/Right/Home/End and other keys that type nothing, candidate clicks, longest match, literal fallback, flushing on Space and Enter, combining marks): Task 4, one or more `table-golden` tests each. `xsampa.table` from the archived chart, `tools/latex-table` with every Data rule and both alias failures, the 24 aliases, the pinned `unicode.xml`: Task 2. `table-check`, `table-describe`, `ibusWeb.engines.table.{tables,tools,sources}`: Tasks 2–3. Checks `table-parse`, `table-golden`, `table-marisa`, `tools-latex-table`: Tasks 1–4. Docs: Task 5. Phase 3 items (`glue.cpp`, the side module, distribution, `table-host`, cast audit, Playwright, load-time measurement, `docs/engines.md`) are out of scope.
- **Contract names.** Every name in "Produced by B" appears unchanged; additions are `utf8.hpp`, `composition.hpp`, `session.cpp`, `keys::isModifier`, the `keys`/`masks` namespaces, `ParseError` line 0, and the `table-describe` JSON key order (`name`, `displayName`, `languages`, `keyboard{layout,passThrough}`).
- **Verified while writing.** The C++ compiles warning-free with GCC 16 (`-Wall -Wextra -Wpedantic -Werror`) and Emscripten's clang/libc++ (`-std=c++23`); all 42 golden tests pass; all 27 parse messages match; clangd parses every new source; the four checks, `toolchain-clangd`, `reuse`, `nixfmt`, `clang-format`, `oxlint`, `tsc` for the new package and `links` pass; `nix flake check --no-build` evaluates.
