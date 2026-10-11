# M5 Phase 4: Rime in the Browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase 4 (5d) of `docs/specs/2026-10-11-m5-rime.md`: Rime's distribution with its full licence and the `schemas` override carried end to end, `@ibus-web/engine-rime`, Rime in the demo with its engines grouped by language, install progress on an engine's first selection and the page's own switch controls, Playwright in Chromium, Firefox and WebKit, `rime_ice` cases in the keystroke benchmark, and the docs and design spec that record M5 as done.

**Architecture:** Phase 5c leaves `ibus-web-rime-dist`, built by `mkEngineManifest` with each engine's dictionaries as lazy data, `checks.rime-host`, and the facade's `prepare(module, engine)` and `install` event. This phase turns the distribution into a function of the schema list (`lib.makeOverridable` over `ibus-web-rime.override { schemas }`), so a build that ships fewer than every schema, `ibus-web-rime-dist.override { schemas = [ … ]; }`, and the npm package built from it carry exactly those engines; sets the module's licence to the conjunction of every component's `meta.license`; packs `@ibus-web/engine-rime` with every licence text and the upstream copyright notices; and exercises it in the demo. The demo gains three generic features: each picker option names its engine (`data-engine`), a Data field shows the facade's `install` events, and `/?properties=page` draws the focused engine's toggle properties as the page's own switches with none of the panel's properties placed, which is how a page drives Rime's `rime:option:*` switches from its own UI.

**Tech Stack:** Nix flake-parts, jq, TypeScript 7, Playwright 1.63 (Chromium, Firefox, WebKit), Vite 8, hk, oxfmt, REUSE.

## Global Constraints

- Work on branch `typedrat/m5d-rime-in-the-browser`, cut from the tip of `typedrat/m5c-per-engine-data` (phase 5c), which sits on `typedrat/m5b-rime-under-node` (5b).
- Names this plan consumes from 5b, used exactly: `packages.ibus-web-rime` (the side module, `$out/rime.wasm`, built by `engines/rime/_package.nix` through `callPackage`, so it has `.override`; its arguments include `schemas`, every shipped schema by default: all of `rime-data`'s, `rime-loengfan`'s and `rime-ice`'s, whose `double_pinyin*` replace `rime-data`'s; passthru `common`, `dicts`, `descriptors`, `settingsSchemaDir`); `packages.ibus-web-rime-descriptors` (`engines.json`, `settings-paths.json`, `settings-schemas.json`, `engine-data.json` mapping each engine name to its list of dictionary store paths, `instances.txt`); engine names `rime:<schema_id>`, default `rime:rime_ice`; the fixed schema `org.freedesktop.ibus.engine.rime` at `/org/freedesktop/ibus/engine/rime/` and the relocatable `org.freedesktop.ibus.engine.rime.schema` at `/org/freedesktop/ibus/engine/rime/<schema_id>/`; property keys `rime:option:<switch name>`; checks `rime-deploy`, `rime-descriptors`, `rime-golden`, `rime-userdb`, `rime-engines`, `rime-cast-audit`, `rime-imports`, `rime-data-closure`; `docs/rime.md`; `LICENSES/GPL-3.0-or-later.txt`, which 5b's GPL-3.0-or-later files under `engines/rime/` need.
- Names this plan consumes from 5c, used exactly: `packages.ibus-web-rime-dist` (with `passthru.heapBytes`), in the file 5c wrote it in (expected `engines/rime/dist.nix`; Task 0 finds it); `checks.rime-host`; `EngineDescriptor.data?: string[]`; `mkEngineManifest` accepting descriptors that carry `data`; the facade's `prepare(module, engine): Promise<void>` and its `install` event, `CustomEvent<{ module: string; engine: string; bytes: number; total: number }>`, dispatched while an engine's lazy data installs, the last one of an install with `bytes === total`; the worker message `PrepareEngine`; the storage markers `meta.paths/<storePath>` and `wasmfs_idb_backend_set_writable`; the per-engine data sections 5c wrote in `docs/engines.md`, `docs/storage.md`, `docs/worker-host.md` and `docs/ibus-web.md`.
- Names later work relies on: `packages.ibus-web-rime-dist` as an overridable function of `schemas`, with passthru `heapBytes`, `licenses` (the list of nixpkgs licence attribute sets), `licenseTexts` (SPDX id → upstream text) and `notices` (published path → source file); `legacyPackages.<system>.npm.engine-rime`, overridable the same way; `checks.rime-dist-schemas`; `ibusWeb.demo.modules.rime`; the demo's `option[data-engine]`, `#install` and `#switches [data-switch]` with `role="switch"` and `aria-checked`, and `/?properties=page`; `openDemo(page, path?)` in `examples/demo/test/e2e/fixtures.ts`; `hangulEngine(page)` in `hangul.ts`; the helpers of `examples/demo/test/e2e/rime.ts`.
- Run every command inside the dev shell (`nix develop -c …`) from the branch's checkout. `git add` a new file before any `nix` command that should see it: the flake reads only files git tracks.
- Commit with `nix develop -c git add <paths>` then `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths>`, in Conventional Commits. Stage named paths only, never `git add -A` or `git add .`. No attribution trailers or "Generated with" lines. If hk's hook rewrites a file, re-add it and commit again; never bypass the hook. Never revert, reformat or "fix" changes you didn't make.
- Comments explain why, never what; no history ("now", "previously"), no references to other files, plans or pull requests, no "NOTE:". Match the surrounding comment density. Separate logical blocks with one blank line; never a blank line right after an opening token or right before a closing one, nor between a comment and the code it describes. Never whitespace-minimize code.
- New files start with `SPDX-FileCopyrightText: 2026 Synapdeck, Inc.` and an `SPDX-License-Identifier` in their comment syntax: `GPL-3.0-or-later` under `engines/rime/` and in `packages/engines/rime/module.nix` (engine files take the engine's licence, ibus-rime's), `MIT OR Apache-2.0` for the demo and its tests. `package.json` and `README.md` files are covered by `REUSE.toml`.
- Docs change in the same commit as the code they describe. Format every Markdown file under `docs/` and every README you touch with `nix develop -c oxfmt <file>`; never run oxfmt on `docs/plans/`. Put non-Latin sample text in Markdown in code spans.
- Generated files (`pnpm-workspace.yaml`, `.github/workflows/ci.yml`, `PROTOCOL.md`, `protocol.h`, the key tables and notices) are never edited by hand. Nothing in this phase changes them: `packages/engines/*` is outside the workspace's globs, so `@ibus-web/engine-rime` adds no workspace package and `pnpm-lock.yaml` doesn't change, and `examples/demo` gains no dependency. Task 7 confirms there is no drift.
- **Measured values.** Some figures exist only once the build runs: sizes, counts, times. A task never invents them. It writes `{{name}}` placeholders, runs the step that measures them, and replaces each placeholder with the printed value. Before each commit that touches a placeholder-bearing file, `grep -n '{{' <file>` prints nothing.
- Stay close to nixpkgs: licences come from each recipe's `meta.license`, the texts from the repository or nixpkgs' `spdx-license-list-data`, and the notices from each recipe's `src`.
- The design spec's rendered page is published from `docs/specs/2026-09-26-ibus-web-design.md` with `~/.claude/skills/doc-artifact/render.py`. Task 6 changes the spec; republishing it isn't part of this plan, and the phase's report says the spec changed.

### Decisions this plan makes where the spec is silent

- **The override.** `ibus-web-rime-dist` becomes `lib.makeOverridable ({ schemas ? null }: …) { }`. Inside, everything comes from `config.packages.ibus-web-rime` (or, given a list, its `.override { inherit schemas; }`) and its passthru (`descriptors`, `settingsSchemaDir`), so the module, the deployment, the descriptors, the dictionary paths, the settings paths and the manifest all follow the list. `null` keeps the recipe's own default, every shipped schema, rather than restating it. The npm package is `lib.makeOverridable` the same way over `dist.override`. A build with fewer schemas keeps the default build's `threads` and `heapBytes`, which `rime-host` measured with every schema available, so they hold for any subset.
- **Checking the override.** `rime-dist-schemas`, a default check, builds the distribution and the npm package with `schemas = [ "luna_pinyin" "cangjie5" ]` and asserts: the engines are exactly those two; every engine names data, all among the manifest's archives; `luna_pinyin`'s data includes `stroke`'s dictionary and `cangjie5`'s `luna_pinyin`'s (its dependencies, deployed though not listed); the tarball's manifest is the distribution's. The two are chosen for small dictionaries, so the extra deployment and Brotli stay cheap enough for `nix flake check`.
- **The licence.** nixpkgs' `ibus-engines.rime` declares only `gpl3Plus`. The distribution's package is `ibus-web-rime` with `meta.license` overridden (an `overrideAttrs` of `meta` alone, which changes no derivation) to every component's `meta.license`, in this order: ibus-rime, librime, librime-lua, librime-octagram, LevelDB, yaml-cpp, OpenCC, glog, librime-lua's Lua, MARISA, Boost, `rime-data`, `rime-loengfan`, `rime-ice`. Code components and 5b's `rime-loengfan` (a data-only derivation in the overlay) come from `pkgsWasm`, `rime-data` and `rime-ice` from the native set. `spdxExpression` turns that into `GPL-3.0-or-later AND BSD-3-Clause AND GPL-3.0-only AND MIT AND Apache-2.0 AND BSD-2-Clause AND BSL-1.0 AND LGPL-3.0-only AND CC-BY-4.0` (verified, below). MARISA's is BSD-2-Clause, the repository's `pkgsWasm.marisa` declaring the BSD side of its dual licence; nixpkgs' `marisa` says `bsd3`, which its `COPYING.md` contradicts.
- **Which Lua.** The spec says Lua 5.4; nixpkgs' `librime-lua` propagates the default `lua`, 5.2.4, in `pkgsWasm` too (verified). Whatever 5b links, the licence and notice come from the Lua `pkgsWasm.librime-lua` propagates, found by `pname`, so they follow 5b's choice.
- **Licence texts.** `LICENSES/<id>.txt` for every identifier in the expression: the repository's text where `LICENSES/` has it, otherwise nixpkgs' `spdx-license-list-data.text`. The repository can't hold texts nothing in it uses: `reuse lint` fails on unused licences. The exception is CC-BY-4.0, whose text comes from upstream: `rime-loengfan`'s `LICENSE` is the full Attribution 4.0 International text, so the distribution offers it (`passthru.licenseTexts`) and the package takes it before the SPDX list's. Every GPL and LGPL text the upstream repositories carry is the unmodified FSF text, which the SPDX list has verbatim.
- **Notices.** The permissive licences ask that each copyright notice travel with binaries. The package carries, under `LICENSES/<component>/`, librime's, librime-lua's, LevelDB's and yaml-cpp's `LICENSE`, glog's `COPYING`, MARISA's `COPYING.md` (from `srcOnly`, as the table engine's package does), `rime-loengfan`'s `LICENSE` and Lua's notice, which Lua keeps at the end of `src/lua.h`, extracted by a small derivation that fails unless it holds `Lua.org, PUC-Rio`. OpenCC's and Boost's licence files are the generic texts and add nothing. Beside them, `LICENSES/ATTRIBUTION.md` gives CC-BY-4.0's attribution for both of CanCLID's works the package carries compiled. The distribution computes all of it (`passthru.notices`), so the licence and its notices are defined in one place.
- **CC-BY-4.0 attribution.** Two of the data's works are CanCLID's, under CC-BY-4.0: the Cantonese dictionary `jyut6ping3`, from rime-cantonese (`rime-cantonese-upstream`) through `rime-data`, and `loengfan`, from [rime-loengfan](https://github.com/CanCLID/rime-loengfan) at `987ac95b02f957e8764a2f45222a4006c188ed50`, which `rime:jyut6ping3` names as data through its dependency. `LICENSES/ATTRIBUTION.md`, the package README and `docs/rime.md` credit both, link the licence, and say the tables are compiled from them.
- **Picker groups.** The demo's existing rule (a module whose engines declare several first languages gets one group per language subtag, labelled with `Intl.DisplayNames`; engines with no language stay under the module's name) gives Rime a group per language the gloss table assigns across every `rime-data` schema: `rime · Chinese` (`zh-Hans`, `zh-Hant` and `zh` alike), `rime · Cantonese` (`yue`), `rime · Wu Chinese` (`wuu`), and whatever the IPA, Middle Chinese and other dialect schemas get. The test doesn't hard-code that list: it reads the served manifest in the page and applies the same rule with the browser's own `Intl`, then checks every Rime option is in its group; only `rime:rime_ice`, `rime:jyut6ping3` and `rime:wugniu`'s groups are fixed. `Intl.DisplayNames` names for `zh`, `yue` and `wuu` were checked under Node. No Rime-specific rule is added.
- **Selecting engines in tests.** Each picker option carries `data-engine`, its engine's name, so the tests select by name rather than by 5b's display names, which only `rime:rime_ice`'s is fixed by the spec (`雾凇拼音 (Pinyin, simplified)`).
- **Install progress.** A Data field in the status line shows `Installing <engine>: <x> of <y> MB` while `install` events have `bytes < total` and `Installed <engine>: <y> MB` at the last; it is untouched otherwise. The test watches the field with a `MutationObserver`: the first selection shows an `Installing` text and ends `Installed`; the second shows nothing.
- **The page's own controls.** The spec's test needs a page that drives `rime:option:simplification` with the panel's properties not placed. The demo does it when opened as `/?properties=page`: it doesn't place `panel.properties` and draws, from the `panel` events' `RegisterProperties` and `UpdateProperty` records of the focused context, a `role="switch"` button for each visible toggle property (`type` 1) anywhere in the property tree, which sends `PropertyActivate` with the other state through `sendPanelAction`. The buttons prevent default on `pointerdown` and `mousedown`, as the panel's own do, so the field keeps the focus and the action reaches its context. Radio groups (Rime's switches of more than two states) aren't drawn; none of this phase's tests needs one. Hangul's `InputMode` is a toggle too, so the feature is tested without Rime in `hangul.spec.ts`, and that test passed in the spike.
- **The learned word after a reload.** Chromium lets go of a terminated Worker's Web Locks some 2 s after `terminate()`, and a reload terminates the page's Workers, so a Rime host started at once after it could find the writer lock taken and run read-only. The test waits for `ibus-web:writer:rime` from the reloaded page with `navigator.locks.request` before selecting Rime, and checks the Storage field reads `persistent (writable)`.
- **The candidate a test chooses.** `shi` on `rime_ice`, its third candidate clicked. If 5b's `rime-userdb` uses another code or position for the same claim, use its.
- **Probes.** Typing stays native until the module, the engine's data and the field's context are ready, and keys pass through while Rime's maintenance runs, so every first use of an engine retries a probe until Rime alone makes the value: `nihao ` → `你好` (`rime_ice`), `zhongguo ` → `中國` (`luna_pinyin`, traditional by default), `a ` → `日` (`cangjie5`).
- **Timeouts.** Rime's tests take 300 s each (`test.describe.configure`), its probes 120 s, its first install 240 s. The integration run's own limit goes from 600 to 1800 s: 21 more tests, each installing tens of MB, run three at a time.
- **Timings recorded.** `rime.spec.ts` logs one JSON line per browser, from the picker's change to `Installed rime:rime_ice`, which covers the module's start (base data installed and Rime's maintenance) and `rime_ice`'s dictionaries. The figures go in `docs/rime.md`, R7 and the M5 row. No figure is asserted.
- **The benchmark.** `keystroke.bench.ts` becomes one `measure` function and two tests: Hangul's, unchanged in what it does (verified), and `rime_ice`'s: `nihao ` round and round, 72 warm-up keys (12 rounds), 500 measured, the field holding `你好` once per finished round and `ni` composing at the end.

### Where this plan departs from the spec

- **Docs for per-engine data.** The spec's Delivery puts per-engine data in `docs/engines.md`, `docs/storage.md`, `docs/worker-host.md` and `docs/ibus-web.md` in this phase. The repository's rule is that docs change with the code they describe, which is 5c's. This plan expects 5c to have written them (Task 0 checks) and adds only what is Rime's or the demo's, plus one sentence `docs/engines.md` should have whoever wrote it: per-engine data is for large, optional data an engine alone uses.
- **§5.4.4 of the design spec** shows `EngineDescriptor` without `data`. If 5c didn't add it, Task 6 does.
- **The NUR.** The design spec's §10.2 says xddxdd's NUR is a flake input; the M5 spec and the user's decision say it isn't until some data needs it. Task 6 rewrites §10.2 to say so.

### What was verified, and how

Built and run in a scratch clone of `master` at `e0f1d5d` (`/tmp/claude-1000/…/scratchpad/m5d-spike`, branch `spike`):

- **The demo's generic features.** Task 3's `index.html`, `main.ts` (without the `install` listener, whose event type is 5c's), `style.css`, `fixtures.ts`, `hangul.ts` and the new `hangul.spec.ts` test: `nix build .#demo` succeeded; `tsc -b` in `examples/demo` passed; `hk check` on the changed files passed (oxfmt, oxlint, tsc, reuse); Playwright from the dev shell, `hangul.spec.ts` and `mozc.spec.ts`, 45 of 45 passed in Chromium, Firefox and WebKit, including the page's own switch turning on Hangul input with `.ibus-panel-properties` absent and `option:checked` carrying `data-engine="hangul"`, and Mozc's panel properties menu still working beside the picker.
- **The benchmark refactor.** Task 5's `keystroke.bench.ts` with `rime.ts`: `tsc -b` passed, hk's pre-commit hook passed, and `IBUS_WEB_KEYSTROKE_BENCH=1 … -g Hangul` passed in all three browsers with Hangul's sequence and expected values unchanged (p50 0.81 / 1.34 / 2.30 ms, p99 9.36 / 2.48 / 5.30 ms in Chromium, Firefox, WebKit on the Ryzen 9 9950X3D; not recorded anywhere, one run).
- **The licence.** Through the flake (`builtins.getFlake` on the spike), the `meta.license` of `pkgsWasm.ibus-engines.rime`, `librime`, `librime-lua`, `librime-octagram`, `leveldb`, `yaml-cpp`, `opencc`, `glog`, librime-lua's Lua, `marisa`, `boost` and the native `rime-data` and `rime-ice` gave `GPL-3.0-or-later, BSD-3-Clause, BSD-3-Clause, GPL-3.0-only, BSD-3-Clause, MIT, Apache-2.0, BSD-3-Clause, MIT, BSD-2-Clause, BSL-1.0, GPL-3.0-only, LGPL-3.0-only, Apache-2.0, CC-BY-4.0, GPL-3.0-only`, and `modules/flake/spdx-expression.py` turned it into the expression above. librime-lua's Lua in `pkgsWasm` is `lua-static-wasm32-unknown-none-5.2.4`.
- **The upstream files.** Read from each pinned source: librime's, librime-lua's, LevelDB's and glog's are BSD-3-Clause with their own copyright lines; yaml-cpp's MIT; OpenCC's the plain Apache-2.0 text; librime-octagram's, ibus-rime's and rime-ice's the GPL-3.0 text; plum's (`rime-data`) the LGPL-3.0 text; MARISA's `COPYING.md` "BSD-2-Clause OR LGPL-2.1-or-later"; Boost's `LICENSE_1_0.txt`; Lua 5.2.4 and 5.4.7 have no licence file, only the notice in `lua.h`. A derivation with the notices map of Task 1 (before `rime-loengfan` and the attribution, which 5b's derivation needs) and the six SPDX texts the repository lacks built, and its `LICENSES/lua/COPYRIGHT` is Lua's notice; `spdx-license-list-data.text` has `GPL-3.0-only`, `GPL-3.0-or-later`, `LGPL-3.0-only`, `CC-BY-4.0`, `BSD-2-Clause` and `BSL-1.0`.
- **The jq.** The array-subset, data-membership and archive-selector expressions (in the shape `rime-dist-schemas` and Task 1 use them), run on hand-made manifests, pass and fail where they should (array subtraction, not `contains`, which matches substrings).
- **Intl names.** Node: `zh` → Chinese, `yue` → Cantonese, `wuu` → Wu Chinese; `zh-Hans`, `zh-Hant` and `zh` all have the language subtag `zh`.

Read, not run: `mkEngineManifest`, `npmTarball`, `modules/typescript/npm.nix`, the demo's Nix and Playwright configuration, `docs/` and the design spec.

**Not verified, because 5b and 5c don't exist yet:** everything Rime builds or runs. The distribution's override and licence, the npm package, `rime-dist-schemas`, the facade's `install` event and its `bytes === total` ending, Rime in the picker, every `rime.spec.ts` expectation (the candidates for `nihao`, `nihaoshijie`, `shi`, `a` on Cangjie 5 and `zhongguo` on `luna_pinyin`, the switch's state meaning simplified output, the languages the gloss table gives the full schema set, the page size reaching the panel, the learned word, the group labels in the browsers), the `rime_ice` benchmark case, the timings and every size. `rime-loengfan`'s `LICENSE`, `meta.license` and `src.rev` (the attribution names it) are 5b's and unread. Task 0 checks the names; each task's run is the first time its Rime part executes, and its steps say what to do when an expectation drawn from Rime's data is wrong.

---

## Interfaces later phases rely on

- `packages.ibus-web-rime-dist`: a derivation (the `mkEngineManifest` directory: `manifest.json`, `rime.wasm`, `settings.json`, `data/*.tar.br`), made by `lib.makeOverridable ({ schemas ? null }: …) { }`; passthru `heapBytes`, `licenses : [licence attrset]`, `licenseTexts : { <SPDX id> = <path>; }` (upstream licence texts, `CC-BY-4.0` from `rime-loengfan`), `notices : { "LICENSES/<path>" = <path>; }`.
- `legacyPackages.<system>.npm.engine-rime` (= `ibusWeb.typescript.npmPackages.engine-rime`): the tarball directory, `lib.makeOverridable ({ schemas ? null }: …) { }`.
- `checks.rime-dist-schemas`.
- `ibusWeb.demo.modules.rime = config.packages.ibus-web-rime-dist`.
- Demo DOM: `#engine-picker option[data-engine="<engine>"]`; `#install` (`—`, `Installing <engine>: <x> of <y> MB`, `Installed <engine>: <y> MB`); `#switches` (hidden unless the focused context has toggles and the page was opened with `?properties=page`) holding `button[data-switch="<property key>"][role="switch"][aria-checked]`.
- Playwright helpers: `openDemo(page: Page, path = "/")` (`fixtures.ts`); `hangulEngine(page)` and `hangul(page)` (`hangul.ts`); `field`, `candidates`, `candidateText`, `selectEngine`, `probe`, `rime` (`rime.ts`).

---

## File structure

| Path | Change |
| --- | --- |
| `engines/rime/dist.nix` (5c's) | The distribution as a function of `schemas`; the licence; the notices; the demo registration |
| `engines/rime/checks.nix` | Create, or extend if 5b has one: `rime-dist-schemas` |
| `packages/engines/rime/package.json`, `README.md`, `module.nix` | Create: `@ibus-web/engine-rime` |
| `examples/demo/index.html`, `src/main.ts`, `src/style.css` | Engine names on options; the Data field; the page's own switches |
| `examples/demo/test/e2e/fixtures.ts` | `openDemo` takes a path |
| `examples/demo/test/e2e/hangul.ts`, `hangul.spec.ts` | `hangulEngine`; the own-switch test |
| `examples/demo/test/e2e/rime.ts`, `rime.spec.ts` | Create: Rime's helpers and spec |
| `examples/demo/test/e2e/keystroke.bench.ts` | One `measure`, Hangul's case and `rime_ice`'s |
| `examples/demo/module.nix` | The integration run's limit |
| `examples/demo/README.md` | Rime, the Data field, `?properties=page` |
| `docs/rime.md` | Distribution, npm package, In the browser, Checks |
| `docs/core.md`, `docs/engines.md`, `docs/ibus-web.md`, `docs/testing.md`, `docs/README.md`, `README.md` | Rime where each lists modules, packages or tests |
| `docs/specs/2026-09-26-ibus-web-design.md` | §2, §5.4.4, §5.6, §10.2, §10.3.1, §12's M5 row, R7 |

---

### Task 0: Check 5c's interface

**Files:** none.

- [ ] **Step 1: Create the branch**

```bash
nix develop -c git switch -c typedrat/m5d-rime-in-the-browser typedrat/m5c-per-engine-data
```

- [ ] **Step 2: Check the packages and checks this plan consumes**

```bash
for package in ibus-web-rime ibus-web-rime-common ibus-web-rime-descriptors ibus-web-rime-dist; do
  nix eval --raw ".#packages.x86_64-linux.$package.name" && echo
done
for check in rime-deploy rime-descriptors rime-golden rime-userdb rime-engines rime-cast-audit rime-imports rime-data-closure rime-host; do
  nix eval --raw ".#checks.x86_64-linux.$check.name" && echo
done
nix eval --impure --json --expr '
  let
    flake = builtins.getFlake (toString ./.);
    rime = flake.packages.x86_64-linux.ibus-web-rime;
  in
  {
    override = rime ? override;
    descriptors = rime ? descriptors;
    settingsSchemaDir = rime ? settingsSchemaDir;
    heapBytes = flake.packages.x86_64-linux.ibus-web-rime-dist.heapBytes;
    lua = (flake.inputs.nixpkgs.lib.findFirst (input: (input.pname or "") == "lua") null
      flake.legacyPackages.x86_64-linux.pkgsWasm.librime-lua.propagatedBuildInputs).name;
    marisa = flake.legacyPackages.x86_64-linux.pkgsWasm.marisa.meta.license.spdxId;
    loengfan = flake.legacyPackages.x86_64-linux.pkgsWasm.rime-loengfan.meta.license.spdxId;
    loengfanLicense = builtins.pathExists "${flake.legacyPackages.x86_64-linux.pkgsWasm.rime-loengfan.src}/LICENSE";
  }'
```

Expected: every name prints; the JSON has `override`, `descriptors` and `settingsSchemaDir` true, a `heapBytes`, a `lua-…` name, `"BSD-2-Clause"`, `loengfan` `"CC-BY-4.0"` and `loengfanLicense` true (5b's `rime-loengfan`, its upstream `LICENSE` in its `src`). A false or a missing name is a mismatch with 5b's or 5c's plan: stop and resolve it there.

- [ ] **Step 3: Find the distribution and what 5c gave it**

```bash
grep -rln 'ibus-web-rime-dist' engines/rime
grep -rn 'demo.modules.rime' engines/rime || echo "not registered"
```

Expected: one file defines `packages.ibus-web-rime-dist`, expected `engines/rime/dist.nix`; if 5c used another, use that path wherever this plan says `engines/rime/dist.nix`. "not registered". Open the file and note, for Task 1: its `threads`, its `heapBytes` and the comment above them (5c's measured figures, `{{threads}}`, `{{heapMiB}}`, `{{heapComment}}`), and how it gives `mkEngineManifest` the engines' `data` (Task 1's code merges `engine-data.json` into `engines.json` with jq; if 5c's mechanism differs, keep 5c's, and change only what Task 1's Step 3 lists).

- [ ] **Step 4: Check the descriptors and settings keys**

```bash
d=$(nix build .#ibus-web-rime-descriptors --no-link --print-out-paths)
ls "$d"
jq -r '.[] | "\(.name)\t\(.displayName)\t\(.languages | join(","))"' "$d/engines.json"
jq -r 'to_entries[] | "\(.key) \(.value | length)"' "$d/engine-data.json"
grep -rho '<key name="[^"]*"' engines/rime --include='*.gschema.xml' | sort -u
test -f LICENSES/GPL-3.0-or-later.txt && echo "GPL-3.0-or-later text present"
```

Expected: `engines.json`, `engine-data.json`, `settings-paths.json`, `settings-schemas.json`, `instances.txt`; an engine for every shipped schema (`jq length`, Task 1's `{{engines}}`), `rime:rime_ice` first with `雾凇拼音 (Pinyin, simplified)` and `zh-Hans`, the spec's table's engines next in its order, then the rest of `rime-data`'s; no `rime-data` `double_pinyin*` beside `rime-ice`'s (one engine each); `rime:jyut6ping3` with `yue` and `rime:wugniu` with `wuu`; every engine with at least one path; the keys include `page-size`, `full-shape`, `ascii-punct` and `simplification`; the text present. `rime:jyut6ping3`'s paths include the `loengfan` dictionary's (from `rime-loengfan`), beside `luna_pinyin`'s, `stroke`'s and `cangjie5`'s: `jq -r '."rime:jyut6ping3"[]' "$d/engine-data.json"`. No test hard-codes the count. If the switch keys are spelled otherwise, use 5b's spelling in Task 4's spec.

- [ ] **Step 5: Check 5c's facade and docs**

```bash
grep -n 'install' packages/ibus-web/src/index.ts | head
grep -n 'prepare\|`install`' docs/ibus-web.md | head
grep -n 'per-engine\|PrepareEngine\|meta.paths' docs/engines.md docs/storage.md docs/worker-host.md | head
grep -n '^## ' docs/rime.md
grep -n '^## Rime' docs/engines.md
grep -n 'rime.md' docs/README.md
grep -n 'R19' docs/specs/2026-09-26-ibus-web-design.md | head -3
```

Expected: `IbusWebEventMap` has `install: CustomEvent<…>` and the facade has `prepare`; `docs/ibus-web.md` documents both; the three docs describe per-engine data; `docs/rime.md` has 5b's sections and 5c's (at least `## Checks`); `docs/engines.md` has `## Rime`; `docs/README.md` has a `rime.md` row; R19 reads as decided (5a). Read 5c's facade test of the `install` event and confirm the last event of an install has `bytes === total`; if it doesn't, the demo's Data field (Task 3) shows `Installed` when the selection's promise resolves instead: tell the reviewer and adapt Task 3's listener before going on.

---

### Task 1: The distribution, its licence and its override

**Files:**
- Modify: `engines/rime/dist.nix`
- Docs: `docs/rime.md`

**Interfaces:**
- Consumes: `packages.ibus-web-rime` and its `.override { schemas }`; its passthru `descriptors`, `settingsSchemaDir`; `ibusWeb.engines.mkEngineManifest`; `ibusWeb.toolchain.pkgsWasm`.
- Produces: `packages.ibus-web-rime-dist` overridable by `schemas`, passthru `heapBytes`, `licenses`, `licenseTexts`, `notices`.

- [ ] **Step 1: Write the failing test**

The distribution's own test is what its consumers ask of it: an override by the schema list and the full licence. Save as `$TMPDIR/rime-dist-test.nix` (a scratch expression, not committed):

```nix
let
  flake = builtins.getFlake (toString ./.);
  dist = flake.packages.x86_64-linux.ibus-web-rime-dist;
  ids = map (license: license.spdxId) dist.licenses;
in
assert dist ? override;
assert (dist.override { }).outPath == dist.outPath;
assert builtins.length (builtins.attrNames dist.notices) == 9;
assert dist.licenseTexts ? "CC-BY-4.0";
assert builtins.elem "CC-BY-4.0" ids && builtins.elem "BSL-1.0" ids && builtins.elem "BSD-2-Clause" ids;
"ok"
```

- [ ] **Step 2: Run it to see it fail**

```bash
cp "$TMPDIR/rime-dist-test.nix" ./rime-dist-test.nix
nix eval --impure --raw --file ./rime-dist-test.nix; echo
```

Expected: FAIL: `assertion '(dist ? override)' failed`, since the distribution is a plain derivation. (Run it from the checkout's root, where `./.` is the flake; delete `rime-dist-test.nix` before committing, and never `git add` it.)

- [ ] **Step 3: Make the distribution a function of the schema list, with its licence**

Replace `engines/rime/dist.nix` with the file below. Keep from 5c's file, unchanged: the values and comment of `threads` and `heapBytes` (Task 0's `{{threads}}`, `{{heapMiB}}` and `{{heapComment}}`), and anything else 5c's file has that isn't here (another passthru, another argument); if 5c gives the engines their `data` another way, keep that way instead of `enginesWithData`, built from `package` as here. The intended differences from 5c's file are: the `lib.makeOverridable` function of `schemas`; `package` from `ibus-web-rime` (overridden when a list is given), with `meta.license`; every input of `mkEngineManifest` taken from that `package`; the passthru `licenses`, `licenseTexts` and `notices`. The demo registration comes in Task 4.

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
      inherit (config.ibusWeb) engines;
      inherit (config.ibusWeb.toolchain) pkgsWasm;

      luaPackage = lib.findFirst (
        input: (input.pname or "") == "lua"
      ) (throw "librime-lua propagates no Lua") pkgsWasm.librime-lua.propagatedBuildInputs;

      # ibus-rime's, and those of everything the module links (librime, its Lua
      # and octagram plugins and their dependencies) and of its data
      # (rime-data's schema packages, rime-loengfan and rime-ice).
      licenses = lib.concatMap (component: lib.toList component.meta.license) [
        pkgsWasm.ibus-engines.rime
        pkgsWasm.librime
        pkgsWasm.librime-lua
        pkgsWasm.librime-octagram
        pkgsWasm.leveldb
        pkgsWasm.yaml-cpp
        pkgsWasm.opencc
        pkgsWasm.glog
        luaPackage
        pkgsWasm.marisa
        pkgsWasm.boost
        pkgs.rime-data
        pkgsWasm.rime-loengfan
        pkgs.rime-ice
      ];

      # Lua keeps its copyright notice at the end of lua.h, not in a file of
      # its own.
      luaNotice = pkgs.runCommand "ibus-web-rime-lua-notice" { } ''
        tar -xOzf ${luaPackage.src} --wildcards '*/src/lua.h' \
          | sed -n '/^\* Copyright (C) 1994/,/^\*\*\*\*\*\*/p' \
          | sed 's/^\* \{0,1\}//; /^\*\*\*\*/d' > $out
        grep -q 'Lua.org, PUC-Rio' $out
      '';

      # CC-BY-4.0 asks for credit to the works' creator, a link to the licence
      # and word of any change; the deployer compiles both into binary tables.
      attribution = pkgs.writeText "ibus-web-rime-attribution.md" ''
        # Attribution

        These works are under the Creative Commons Attribution 4.0 International licence
        (https://creativecommons.org/licenses/by/4.0/, the text in CC-BY-4.0.txt). Rime's
        deployer compiles each into binary tables at build time; nothing else is changed.

        - jyut6ping3, the Cantonese dictionary, by CanCLID, from rime-cantonese
          (https://github.com/rime/rime-cantonese), as rime-data ${pkgs.rime-data.version} carries it.
        - loengfan, by CanCLID, from rime-loengfan (https://github.com/CanCLID/rime-loengfan)
          at commit ${pkgsWasm.rime-loengfan.src.rev}.
      '';

      # The copyright notices the permissive licences ask to travel with the
      # module, each from its component's source, and the attribution.
      # OpenCC's and Boost's licence files are the generic texts.
      notices = {
        "LICENSES/librime/LICENSE" = "${pkgsWasm.librime.src}/LICENSE";
        "LICENSES/librime-lua/LICENSE" = "${pkgsWasm.librime-lua.src}/LICENSE";
        "LICENSES/leveldb/LICENSE" = "${pkgsWasm.leveldb.src}/LICENSE";
        "LICENSES/yaml-cpp/LICENSE" = "${pkgsWasm.yaml-cpp.src}/LICENSE";
        "LICENSES/glog/COPYING" = "${pkgsWasm.glog.src}/COPYING";
        "LICENSES/lua/COPYRIGHT" = luaNotice;
        "LICENSES/marisa/COPYING.md" = "${pkgs.srcOnly pkgsWasm.marisa}/COPYING.md";
        "LICENSES/rime-loengfan/LICENSE" = "${pkgsWasm.rime-loengfan.src}/LICENSE";
        "LICENSES/ATTRIBUTION.md" = attribution;
      };

      # rime-loengfan's LICENSE is CC-BY-4.0's full text, upstream's own copy.
      licenseTexts."CC-BY-4.0" = "${pkgsWasm.rime-loengfan.src}/LICENSE";

      dist = lib.makeOverridable (
        {
          schemas ? null,
        }:
        let
          rime =
            if schemas == null then
              config.packages.ibus-web-rime
            else
              config.packages.ibus-web-rime.override { inherit schemas; };

          # The schema list reaches the module, its deployment, descriptors,
          # dictionary paths and settings paths, so everything here follows it.
          package = rime.overrideAttrs (old: {
            meta = old.meta // {
              license = licenses;
            };
          });
          inherit (package) descriptors;

          # Each engine's dictionaries are data of its own, installed when it is
          # first made.
          enginesWithData =
            pkgs.runCommand "ibus-web-rime-engines.json" { nativeBuildInputs = [ pkgs.jq ]; }
              ''
                jq --slurpfile data ${descriptors}/engine-data.json 'map(. + { data: $data[0][.name] })' \
                  ${descriptors}/engines.json > $out
              '';

          manifest = engines.mkEngineManifest {
            name = "rime";
            inherit package;
            inherit (package) settingsSchemaDir;
            engines = enginesWithData;
            settingsSchemas = "${descriptors}/settings-schemas.json";
            settingsPaths = "${descriptors}/settings-paths.json";

            {{heapComment}}
            threads = {{threads}};
            heapBytes = {{heapMiB}} * 1024 * 1024;
          };
        in
        manifest.overrideAttrs (old: {
          passthru = old.passthru // {
            inherit licenses licenseTexts notices;
          };
        })
      ) { };
    in
    {
      packages.ibus-web-rime-dist = dist;
    };
}
```

Replace the three placeholders with 5c's comment (each line starting `# ` at the binding's indentation) and values, then `grep -n '{{' engines/rime/dist.nix`; expected: nothing.

- [ ] **Step 4: Run the test, build the default distribution and check it is 5c's**

```bash
nix develop -c git add engines/rime/dist.nix
nix eval --impure --raw --file ./rime-dist-test.nix; echo
dist=$(nix build .#ibus-web-rime-dist --no-link --print-out-paths -L)
jq -r '.license' "$dist/manifest.json"
nix eval --impure --json --expr '
  let dist = (builtins.getFlake (toString ./.)).packages.x86_64-linux.ibus-web-rime-dist;
  in { notices = builtins.attrNames dist.notices; same = (dist.override { }).outPath == dist.outPath; }'
notices=$(nix build --impure --no-link --print-out-paths --expr '
  let
    flake = builtins.getFlake (toString ./.);
    dist = flake.packages.x86_64-linux.ibus-web-rime-dist;
  in
  flake.inputs.nixpkgs.legacyPackages.x86_64-linux.linkFarm "ibus-web-rime-notices" (
    builtins.attrValues (builtins.mapAttrs (name: path: { inherit name path; }) dist.notices)
  )')
find -L "$notices" -type f -size +0 | sort
```

Expected: PASS; `ok`; the licence is `GPL-3.0-or-later AND BSD-3-Clause AND GPL-3.0-only AND MIT AND Apache-2.0 AND BSD-2-Clause AND BSL-1.0 AND LGPL-3.0-only AND CC-BY-4.0`; the nine notice paths, `same` true; the nine notices, each a non-empty file, `LICENSES/lua/COPYRIGHT` starting `Copyright (C) 1994`. Apart from `license`, the manifest is 5c's: `nix build .#checks.x86_64-linux.rime-host -L` passes, the data archives and engines unchanged.

- [ ] **Step 5: Build one with fewer schemas**

Task 2's `rime-dist-schemas` checks the override with the npm package. Build the distribution alone now:

```bash
fewer=$(nix build --impure --no-link --print-out-paths -L --expr '
  let dist = (builtins.getFlake (toString ./.)).packages.x86_64-linux.ibus-web-rime-dist;
  in dist.override { schemas = [ "luna_pinyin" "cangjie5" ]; }')
jq -r '.engines[] | "\(.name) \(.data | map(sub("^/nix/store/[^-]*-"; "")) | join(" "))"' "$fewer/manifest.json"
```

Expected: PASS; two lines, `rime:luna_pinyin` with `ibus-web-rime-dict-luna_pinyin` and `ibus-web-rime-dict-stroke`, and `rime:cangjie5` with `ibus-web-rime-dict-cangjie5` and `ibus-web-rime-dict-luna_pinyin` (and any further dictionary its dependencies bring). A failure to deploy with fewer schemas is 5b's: fix it there.

- [ ] **Step 6: Measure the distribution**

```bash
dist=$(nix build .#ibus-web-rime-dist --no-link --print-out-paths)
m="$dist/manifest.json"
brotli() { while IFS= read -r url; do stat -c %s "$dist/${url#./}"; done | awk '{ s += $1 } END { print s + 0 }'; }
jq -r '(.engines | length), (.data | length), .memory / 1048576' "$m"
jq -r '[.engines[].data[]] as $lazy | [.data[] | select(.storePath | IN($lazy[]) | not)] | length, (map(.size) | add)' "$m"
jq -r '[.engines[].data[]] as $lazy | .data[] | select(.storePath | IN($lazy[]) | not) | .url' "$m" | brotli
jq -r '[.engines[].data[]] as $lazy | [.data[] | select(.storePath | IN($lazy[]))] | length, (map(.size) | add)' "$m"
jq -r '[.engines[].data[]] as $lazy | .data[] | select(.storePath | IN($lazy[])) | .url' "$m" | brotli
jq -r '(.engines[] | select(.name == "rime:rime_ice") | .data) as $own | [.data[] | select(.storePath | IN($own[])) | .size] | add' "$m"
jq -r '(.engines[] | select(.name == "rime:rime_ice") | .data) as $own | .data[] | select(.storePath | IN($own[])) | .url' "$m" | brotli
stat -c %s "$dist/rime.wasm"
```

Keep, in order: `{{engines}}`, `{{archives}}`, `{{memoryMiB}}`; the base archives' count (expected 1, the common path) and `{{baseBytes}}`; `{{baseBrotli}}`; `{{dictionaries}}` and `{{lazyBytes}}`; `{{lazyBrotli}}`; `{{iceBytes}}`; `{{iceBrotli}}`; `{{wasmBytes}}`. A base count other than 1 means some path no engine names isn't the common path: read the list (`jq -r '… | .storePath'`) and describe it in Step 7 as it is.

- [ ] **Step 7: Document the distribution**

In `docs/rime.md`, add before `## Checks` (if 5c's page has a `## Distribution` section, put these paragraphs in place of its description of the archives and licence, and keep its paragraph on the threads and the program break):

```markdown
## Distribution

`ibus-web-rime-dist` (`engines/rime/dist.nix`) is `mkEngineManifest` over `rime.wasm`, with the descriptor step's
`engines.json`, each engine given its dictionaries from `engine-data.json` as `data`, `settings-paths.json` and
`settings-schemas.json`. Its engines start with `rime:rime_ice`. Of its {{archives}} archives, the common
path is base data, {{baseBytes}} bytes installed and {{baseBrotli}} as Brotli, and the {{dictionaries}} dictionary
paths are lazy, {{lazyBytes}} bytes and {{lazyBrotli}} as Brotli. `rime:rime_ice` names the most, {{iceBytes}} bytes and
{{iceBrotli}} as Brotli. `rime.wasm` is {{wasmBytes}} bytes, and the module's memory comes to {{memoryMiB}} MiB.

Every schema of `rime-data`, `rime-loengfan` and `rime-ice` ships, {{engines}} engines. The distribution is a
function of the schema list: `ibus-web-rime-dist.override { schemas = [ "rime_ice" "luna_pinyin" ]; }` passes the list
to the module's recipe, and the module, its deployment, its descriptors, its dictionary paths and its settings paths
follow it, so the build has exactly those engines, each with its own lazy data and its dependencies' dictionaries. It
keeps the full build's thread and program-break declaration, which holds for any subset.

The licence is
`GPL-3.0-or-later AND BSD-3-Clause AND GPL-3.0-only AND MIT AND Apache-2.0 AND BSD-2-Clause AND BSL-1.0 AND LGPL-3.0-only AND CC-BY-4.0`:
ibus-rime's GPL-3.0-or-later; librime's, librime-lua's, LevelDB's and glog's BSD-3-Clause; librime-octagram's
GPL-3.0-only; yaml-cpp's and Lua's MIT; OpenCC's Apache-2.0; MARISA's BSD-2-Clause, the side of its dual licence the
repository takes; Boost's BSL-1.0, for its headers; and the data's: `rime-data`'s schema packages are GPL-3.0-only,
LGPL-3.0-only, Apache-2.0 and CC-BY-4.0 between them, `rime-loengfan` is CC-BY-4.0 and `rime-ice` GPL-3.0-only. The distribution lists them from
each component's `meta.license` (its `licenses` passthru) and gives the module that `meta.license`, which
`mkEngineManifest` writes. Two works are CanCLID's, under CC-BY-4.0, and compiled into Rime's tables at build time: the
Cantonese dictionary `jyut6ping3`, from [rime-cantonese](https://github.com/rime/rime-cantonese) through `rime-data`,
and `loengfan`, from [rime-loengfan](https://github.com/CanCLID/rime-loengfan) at
`987ac95b02f957e8764a2f45222a4006c188ed50`, which `rime:jyut6ping3`'s data includes through its dependency.
```

Replace each `{{…}}` with Step 6's value , bytes written with thousands separators.

Then:

```bash
nix develop -c oxfmt docs/rime.md
grep -n '{{' docs/rime.md engines/rime/dist.nix
nix develop -c hk check -S links
```

Expected: the grep prints nothing; the link check passes.

- [ ] **Step 8: Commit**

```bash
rm -f rime-dist-test.nix
nix develop -c git add engines/rime/dist.nix docs/rime.md
nix develop -c git commit -m "feat(rime): build the distribution from the schema list, with its licence and notices" -- engines/rime/dist.nix docs/rime.md
```

---

### Task 2: `@ibus-web/engine-rime`

**Files:**
- Create: `packages/engines/rime/package.json`, `packages/engines/rime/README.md`, `packages/engines/rime/module.nix`
- Create or modify: `engines/rime/checks.nix`
- Docs: `docs/rime.md`, `README.md`

**Interfaces:**
- Consumes: `packages.ibus-web-rime-dist` with passthru `licenses`, `notices` and `.override`; `ibusWeb.typescript.npmTarball`; `ibusWeb.lib.spdxExpression`.
- Produces: `ibusWeb.typescript.npmPackages.engine-rime`, overridable by `schemas`, so `legacyPackages.<system>.npm.engine-rime`, `npm.all` and `checks.typescript-npm` include it; `checks.rime-dist-schemas`.

- [ ] **Step 1: Write the package**

Create `packages/engines/rime/package.json`:

```json
{
  "name": "@ibus-web/engine-rime",
  "version": "0.0.0",
  "description": "Rime with every schema of rime-data and rime-ice, for ibus-web: its WebAssembly module, data and manifest.",
  "keywords": [
    "cantonese",
    "cangjie",
    "chinese",
    "ibus",
    "ime",
    "input-method",
    "pinyin",
    "rime",
    "webassembly",
    "zhuyin"
  ],
  "homepage": "https://github.com/synapdeck/ibus-web/blob/master/docs/rime.md",
  "bugs": "https://github.com/synapdeck/ibus-web/issues",
  "license": "GPL-3.0-or-later AND BSD-3-Clause AND GPL-3.0-only AND MIT AND Apache-2.0 AND BSD-2-Clause AND BSL-1.0 AND LGPL-3.0-only AND CC-BY-4.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/synapdeck/ibus-web.git",
    "directory": "packages/engines/rime"
  },
  "files": [
    "dist",
    "LICENSES"
  ],
  "exports": {
    "./package.json": "./package.json",
    "./manifest.json": "./dist/manifest.json",
    "./rime.wasm": "./dist/rime.wasm",
    "./settings.json": "./dist/settings.json",
    "./data/*": "./dist/data/*"
  },
  "publishConfig": {
    "access": "public"
  },
  "ibusWeb": {
    "nixBuilt": true
  }
}
```

Create `packages/engines/rime/module.nix`:

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
      dist = config.packages.ibus-web-rime-dist;
      ids = lib.unique (map (license: license.spdxId) dist.licenses);

      # The texts the repository has; for the rest, which nothing in the
      # repository is licensed under, upstream's copy where the distribution
      # has one, else nixpkgs' copy of the SPDX list.
      licenses = lib.filter (id: builtins.pathExists ../../../LICENSES/${id}.txt) ids;
      otherTexts = lib.listToAttrs (
        map (
          id:
          lib.nameValuePair "LICENSES/${id}.txt" (
            dist.licenseTexts.${id} or "${pkgs.spdx-license-list-data.text}/text/${id}.txt"
          )
        ) (lib.subtractLists licenses ids)
      );

      # The module's distribution as dist/, with every licence text and the
      # upstream copyright notices. A distribution built with fewer schemas
      # packs the same way.
      tarball = lib.makeOverridable (
        {
          schemas ? null,
        }:
        config.ibusWeb.typescript.npmTarball {
          name = "ibus-web-npm-engine-rime";

          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./package.json
              ./README.md
            ];
          };

          files =
            dist.notices
            // otherTexts
            // {
              dist = dist.override { inherit schemas; };
            };
          inherit licenses;
          license = config.ibusWeb.lib.spdxExpression dist.licenses;

          # The exports name the rest; the data archives' names are hashes.
          expect = map (id: "LICENSES/${id}.txt") ids ++ lib.attrNames dist.notices;
        }
      ) { };
    in
    {
      ibusWeb.typescript.npmPackages.engine-rime = tarball;
    };
}
```

- [ ] **Step 2: Write the override's end to end check**

`engines/rime/checks.nix` is the module for the component's checks without fixtures of their own. If 5b created it, add the `let` bindings and the attribute below to its `perSystem`; otherwise create it:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      # Two schemas with small dictionaries, one depending on the other's,
      # keep the extra deployment and compression cheap.
      schemas = [
        "luna_pinyin"
        "cangjie5"
      ];
      fewer = config.packages.ibus-web-rime-dist.override { inherit schemas; };
      fewerNpm = config.ibusWeb.typescript.npmPackages.engine-rime.override { inherit schemas; };
    in
    {
      checks.rime-dist-schemas =
        pkgs.runCommand "ibus-web-rime-dist-schemas"
          {
            nativeBuildInputs = [
              pkgs.jq
              pkgs.gnutar
              pkgs.gzip
            ];
          }
          ''
            jq -e '[.engines[].name] | sort == ["rime:cangjie5", "rime:luna_pinyin"]' ${fewer}/manifest.json > /dev/null \
              || { echo "the build with two schemas has other engines" >&2; exit 1; }

            jq -e '[.data[].storePath] as $paths | all(.engines[]; (.data | length) > 0 and all(.data[]; IN($paths[])))' \
              ${fewer}/manifest.json > /dev/null \
              || { echo "an engine names no data, or data the manifest lacks" >&2; exit 1; }

            # Dependencies deploy though not listed: luna_pinyin's reverse lookup
            # needs stroke, and cangjie5's needs luna_pinyin's dictionary.
            has() {
              jq -e --arg engine "$1" --arg dictionary "-ibus-web-rime-dict-$2" \
                'any(.engines[] | select(.name == $engine) | .data[]; endswith($dictionary))' \
                ${fewer}/manifest.json > /dev/null || { echo "$1 lacks $2's dictionary" >&2; exit 1; }
            }
            has rime:luna_pinyin stroke
            has rime:cangjie5 luna_pinyin

            tar -xOzf ${fewerNpm}/*.tgz package/dist/manifest.json | cmp - ${fewer}/manifest.json
            touch $out
          '';
    };
}
```

- [ ] **Step 3: Build it to see the size, before the README states it**

```bash
nix develop -c git add packages/engines/rime/package.json packages/engines/rime/module.nix
printf '# @ibus-web/engine-rime\n' > packages/engines/rime/README.md
nix develop -c git add packages/engines/rime/README.md
npm=$(nix build .#npm.engine-rime --no-link --print-out-paths -L)
tar -tzf "$npm"/*.tgz | grep -vE '^package/dist/data/' | sort
stat -c %s "$npm"/*.tgz
```

Expected: PASS; `CC-BY-4.0.txt` is `rime-loengfan`'s `LICENSE` (`cmp` it with `$(nix eval --raw .#legacyPackages.x86_64-linux.pkgsWasm.rime-loengfan.src)/LICENSE`); the listing holds `package/LICENSES/` with `Apache-2.0.txt`, `BSD-2-Clause.txt`, `BSD-3-Clause.txt`, `BSL-1.0.txt`, `CC-BY-4.0.txt`, `GPL-3.0-only.txt`, `GPL-3.0-or-later.txt`, `LGPL-3.0-only.txt`, `MIT.txt`, and `glog/COPYING`, `leveldb/LICENSE`, `librime/LICENSE`, `librime-lua/LICENSE`, `lua/COPYRIGHT`, `marisa/COPYING.md`, `rime-loengfan/LICENSE`, `yaml-cpp/LICENSE`, `ATTRIBUTION.md`; `package/README.md`, `package/package.json`, `package/dist/manifest.json`, `package/dist/rime.wasm`, `package/dist/settings.json`; the size is `{{tarballBytes}}`. A `package.json says …, but its contents are …` failure means the expression differs from Task 1's: compare `jq -r .license "$(nix build .#ibus-web-rime-dist --no-link --print-out-paths)/manifest.json"` with `package.json` and correct `package.json` to it only if Task 1's licence list is right.

- [ ] **Step 4: Write the README**

Replace `packages/engines/rime/README.md` with:

````markdown
# @ibus-web/engine-rime

[ibus-rime](https://github.com/rime/ibus-rime), the IBus front end of the [Rime](https://rime.im/) input method engine,
built for the browser with [librime](https://github.com/rime/librime) and its Lua and octagram plugins, and the
schemas of [plum](https://github.com/rime/plum)'s `rime-data`, of [rime-loengfan](https://github.com/CanCLID/rime-loengfan)
and of [rime-ice](https://github.com/iDvel/rime-ice), every one: pinyin, simplified and traditional, double pinyin,
Zhuyin, Cangjie, Quick, Wubi, Array, stroke, Cantonese, Shanghainese and other dialects, IPA and Middle Chinese,
{{engines}} engines in one module, which runs in one Worker. The
package holds no JavaScript: it is the files a host serves and points ibus-web at, `manifest.json` and the WebAssembly
module, data archives and settings metadata it lists.

```ts
import { createIbusWeb } from "ibus-web";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  modules: { rime: new URL("/ibus-web/engines/rime/manifest.json", location.href) },
});
ibus.addEventListener("install", ({ detail }) => console.log(`${detail.engine}: ${detail.bytes} of ${detail.total}`));
await ibus.select("rime", "rime:luna_pinyin");
```

Each engine is one Rime schema, `rime:<schema_id>`; the default is `rime:rime_ice`, rime-ice's simplified pinyin.
`ibus.engines("rime")` lists them with their display names, such as `雾凇拼音 (Pinyin, simplified)`, and languages.
The module's start installs Rime's common data, {{baseMB}} MB compressed. Each engine's dictionaries are data of its
own, downloaded the first time it is selected, or when `ibus.prepare("rime", engine)` asks ahead, with `install` events
reporting the bytes: `rime:rime_ice`'s are {{iceMB}} MB compressed, and all of them {{lazyMB}} MB.

Rime's settings are the fixed `org.freedesktop.ibus.engine.rime` schema at `/org/freedesktop/ibus/engine/rime/` and,
for each engine, `org.freedesktop.ibus.engine.rime.schema` at `/org/freedesktop/ibus/engine/rime/<schema_id>/`; the
module writes Rime's YAML from them. Each schema's switches, such as simplified and traditional output or full-width
characters, are IBus properties, `rime:option:<name>`, which a page can draw with its own controls.

Serve `dist/` as it is: the manifest names its files by relative URL, and the data archives are already
Brotli-compressed, so they must be served without `Content-Encoding: br`. The module's Worker takes {{memoryMiB}} MiB of
memory. Details are in [docs/rime.md](https://github.com/synapdeck/ibus-web/blob/master/docs/rime.md).

`dist/` comes from the Nix build of the module, never from this directory: `nix build .#npm.engine-rime` packs the
tarball, and `npm.engine-rime.override { schemas = [ … ]; }` one with fewer schemas.

Licensed under
`GPL-3.0-or-later AND BSD-3-Clause AND GPL-3.0-only AND MIT AND Apache-2.0 AND BSD-2-Clause AND BSL-1.0 AND LGPL-3.0-only AND CC-BY-4.0`:
ibus-rime is GPL-3.0-or-later; librime, its plugins and their dependencies, linked into the module, are under the
BSD, MIT, Apache and Boost licences and librime-octagram under GPL-3.0-only; `rime-data`'s schemas are GPL-3.0-only,
LGPL-3.0-only, Apache-2.0 and CC-BY-4.0 between them, rime-loengfan is CC-BY-4.0 and rime-ice GPL-3.0-only. The
Cantonese dictionary `jyut6ping3`, from [rime-cantonese](https://github.com/rime/rime-cantonese), and `loengfan`, from
[rime-loengfan](https://github.com/CanCLID/rime-loengfan), are CanCLID's, under CC-BY-4.0, compiled into Rime's tables;
`LICENSES/ATTRIBUTION.md` credits them. Each licence text is in `LICENSES/`, and the copyright notices of librime,
librime-lua, LevelDB, yaml-cpp, glog, Lua, MARISA and rime-loengfan in `LICENSES/<component>/`.
````

`{{engines}}` and `{{memoryMiB}}` are Task 1's; `{{baseMB}}`, `{{iceMB}}` and `{{lazyMB}}` are Task 1's `{{baseBrotli}}`, `{{iceBrotli}}` and `{{lazyBrotli}}` in MB to one decimal place.

- [ ] **Step 5: Document it**

In `docs/rime.md`'s Distribution section, after the licence paragraph, add:

```markdown
The module ships as `@ibus-web/engine-rime` (`packages/engines/rime/`): `nix build .#npm.engine-rime` copies
`ibus-web-rime-dist` in as `dist/`; puts each licence's text in `LICENSES/`, the repository's where it has one, CC-BY-4.0's from
`rime-loengfan`'s own `LICENSE`, and the rest from nixpkgs' `spdx-license-list-data`, since the repository can't hold
texts nothing in it uses; adds the copyright notices the permissive licences ask to keep, under `LICENSES/<component>/`:
librime's, librime-lua's, LevelDB's and yaml-cpp's `LICENSE`, glog's `COPYING`, MARISA's `COPYING.md`,
`rime-loengfan`'s `LICENSE` and Lua's notice, which Lua keeps at the end of `lua.h`; and credits CanCLID's
`jyut6ping3` and `loengfan` in `LICENSES/ATTRIBUTION.md`, as CC-BY-4.0 asks. `npmTarball` fails unless `package.json`'s `license` is the module's. It exports `manifest.json`,
`rime.wasm`, `settings.json` and `data/*`; the tarball is {{tarballMB}} MB, the dictionaries of every schema most of it.
`npm.engine-rime.override { schemas = […]; }` packs a distribution built with the same override.
```

and append to its `## Checks` list:

```markdown
- `checks.typescript-npm` packs `@ibus-web/engine-rime` with every licence text, the notices and the attribution.
- `checks.rime-dist-schemas` builds the distribution and the npm package with `schemas = [ "luna_pinyin" "cangjie5" ]`:
  exactly those engines, each naming data the manifest lists, `luna_pinyin`'s including `stroke`'s dictionary and
  `cangjie5`'s `luna_pinyin`'s, which deploy as dependencies; and the tarball's manifest is the distribution's.
```

In the root `README.md`'s packages table, add after the `@ibus-web/engine-m17n` row:

```markdown
| [`@ibus-web/engine-rime`](packages/engines/rime)     | Rime with rime-data's and rime-ice's schemas: its WebAssembly module, data and manifest, built by Nix |
```

and in its License section, after the sentence ending `` m17n-lib, linked in, and m17n-db's input methods.``, add: `` ibus-rime is GPL-3.0-or-later; its packed module is `GPL-3.0-or-later AND BSD-3-Clause AND GPL-3.0-only AND MIT AND Apache-2.0 AND BSD-2-Clause AND BSL-1.0 AND LGPL-3.0-only AND CC-BY-4.0`, for librime, its plugins and dependencies, linked in, and the schemas of rime-data and rime-ice. ``

`{{tarballMB}}` is Step 2's size in MB to one decimal place. Then:

```bash
nix develop -c oxfmt docs/rime.md README.md packages/engines/rime/README.md
grep -n '{{' docs/rime.md README.md packages/engines/rime/README.md
```

Expected: the grep prints nothing.

- [ ] **Step 6: Run the checks**

```bash
nix develop -c git add packages/engines/rime engines/rime/checks.nix
nix build .#npm.engine-rime .#checks.x86_64-linux.typescript-npm .#checks.x86_64-linux.typescript-package-metadata -L
nix develop -c hk check -S reuse
nix build .#checks.x86_64-linux.rime-dist-schemas -L
```

Expected: PASS. `typescript-package-metadata` needs the README, a description, keywords and a homepage that is a page of the repository (`docs/rime.md`); `reuse lint` passes, `REUSE.toml` covering the README and `package.json`; `rime-dist-schemas` passes. If it takes more than a few minutes, its schemas aren't cheap after all: move it to `ibusWeb.testing.extendedChecks` (outside `nix flake check`) and say so in `docs/rime.md`. 
- [ ] **Step 7: Commit**

```bash
nix develop -c git add packages/engines/rime engines/rime/checks.nix docs/rime.md README.md
nix develop -c git commit -m "feat(rime): pack @ibus-web/engine-rime and check a build with fewer schemas" -- packages/engines/rime engines/rime/checks.nix docs/rime.md README.md
```

---

### Task 3: The demo's engine names, install progress and own switches

**Files:**
- Modify: `examples/demo/index.html`, `examples/demo/src/main.ts`, `examples/demo/src/style.css`, `examples/demo/test/e2e/fixtures.ts`, `examples/demo/test/e2e/hangul.ts`, `examples/demo/test/e2e/hangul.spec.ts`
- Docs: `examples/demo/README.md`, `docs/core.md`

**Interfaces:**
- Consumes: the facade's `panel` events (`RegisterProperties`, `UpdateProperty` records, `hide`), `sendPanelAction(module, ic, { _tag: "PropertyActivate", name, state })`, the `install` event (5c), `PanelUpdate` exported from `ibus-web`.
- Produces: `option[data-engine]`; `#install`; `#switches` with `button[data-switch][role="switch"][aria-checked]` under `/?properties=page`; `openDemo(page, path = "/")`; `hangulEngine(page)`.

- [ ] **Step 1: Write the failing test**

In `examples/demo/test/e2e/fixtures.ts`, replace

```ts
export async function openDemo(page: Page) {
  await page.goto("/");
```

with

```ts
export async function openDemo(page: Page, path = "/") {
  await page.goto(path);
```

In `examples/demo/test/e2e/hangul.ts`, replace

```ts
export async function hangul(page: Page) {
  await page.locator("#engine-picker").selectOption({ label: "Hangul" });
  await expect(page.locator("#engine")).toHaveText("ready");
  await expect(page.locator("#settings-state")).toHaveText("Settings ready; changes save automatically.");
  await page.locator("#input").click();
  await expect(page.locator("#mode")).toHaveText("EN");
```

with

```ts
// Hangul selected and the field focused, in its English mode.
export async function hangulEngine(page: Page) {
  await page.locator("#engine-picker").selectOption({ label: "Hangul" });
  await expect(page.locator("#engine")).toHaveText("ready");
  await expect(page.locator("#settings-state")).toHaveText("Settings ready; changes save automatically.");
  await page.locator("#input").click();
  await expect(page.locator("#mode")).toHaveText("EN");
}

export async function hangul(page: Page) {
  await hangulEngine(page);
```

(the rest of `hangul`, the Shift+Space and the `한` mode check, stays).

In `examples/demo/test/e2e/hangul.spec.ts`, replace `import { hangul, keyboardSetting } from "./hangul.ts";` with `import { hangul, hangulEngine, keyboardSetting } from "./hangul.ts";` and append:

```ts

// A page with its own controls reads the engine's toggles from the panel's
// records and activates them through the panel action, with none of the
// panel's properties placed.
test("the page's own switch turns on Hangul input with the panel's properties not placed", async ({ page }) => {
  await openDemo(page, "/?properties=page");
  await expect(page.locator(".ibus-panel-properties")).toHaveCount(0);
  await expect(page.locator("#engine-picker option:checked")).toHaveAttribute("data-engine", "hangul");
  await hangulEngine(page);
  const mode = page.locator("#switches [data-switch='InputMode']");
  await expect(mode).toHaveAttribute("aria-checked", "false");
  await mode.click();
  await expect(mode).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#mode")).toHaveText("한");
  await page.keyboard.type("gks");
  await page.locator("h1").click();
  await expect(page.locator("#input")).toHaveValue("한");
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
nix develop -c git add examples/demo/test/e2e
out=$(nix build .#playwright-integration --no-link --print-out-paths -L) || true
```

Expected: FAIL; the new test fails in all three browsers at `.ibus-panel-properties` (the page places the panel's properties whatever the query), and every other test passes.

To iterate on one spec in a dev shell (after `nix develop -c pnpm install` once), with `page=$(nix build .#demo --no-link --print-out-paths)`:

```bash
nix develop -c bash -c "cd examples/demo && IBUS_WEB_DEMO_PAGE=$page \
  PLAYWRIGHT_BROWSERS_PATH=$(nix eval --raw .#checks.x86_64-linux.example-demo-smoke.PLAYWRIGHT_BROWSERS_PATH) \
  PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 \
  node node_modules/playwright/cli.js test -c test/e2e/playwright.config.ts hangul.spec.ts"
```

The integration check is the authority.

- [ ] **Step 3: Add the controls to the page**

In `examples/demo/index.html`, replace

```html
        <button id="restart" type="button" disabled>Restart module</button>
      </div>
```

with

```html
        <button id="restart" type="button" disabled>Restart module</button>
        <div id="switches" class="switches" role="group" aria-label="Input method switches" hidden></div>
      </div>
```

and replace

```html
        <output id="mode">—</output>
      </p>
```

with

```html
        <output id="mode">—</output> · Data: <output id="install">—</output>
      </p>
```

In `examples/demo/src/style.css`, add after the `button { cursor: pointer; }` rule:

```css
.switches:not([hidden]) {
  display: flex;
  gap: 0.5rem;
}
.switches [aria-checked="true"] {
  background: #125ed0;
  color: white;
}
```

(`:not([hidden])`, since a `display` of the page's own would show the empty group the `hidden` attribute hides.)

- [ ] **Step 4: Draw the switches, show installs and name each option's engine**

In `examples/demo/src/main.ts`:

Replace

```ts
  type LogEntry,
  type Selection,
} from "ibus-web";
```

with

```ts
  type LogEntry,
  type PanelUpdate,
  type Selection,
} from "ibus-web";
```

After `type SettingValue = Awaited<ReturnType<IbusWeb["settings"]["get"]>>;` add:

```ts
type Property = Extract<Extract<PanelUpdate, { _tag: "record" }>["record"], { _tag: "UpdateProperty" }>["property"];
```

After `const settingsState = query<HTMLOutputElement>("#settings-state");` add:

```ts
const switches = query<HTMLDivElement>("#switches");
const install = query<HTMLOutputElement>("#install");
```

Replace

```ts
// The focused engine's properties, Mozc's input modes among them, sit beside the picker.
picker.after(panel.properties);
```

with

```ts
// The focused engine's properties, Mozc's input modes among them, sit beside the picker. Opened with ?properties=page,
// the page draws the engine's switches with controls of its own instead, as a page that styles its own would.
const ownSwitches = new URLSearchParams(location.search).get("properties") === "page";
if (!ownSwitches) picker.after(panel.properties);
```

After the `storage` event listener (the one ending `render();\n});` that sets `storages`), add:

```ts
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
// An engine's own data downloads the first time it is made; a later selection, here or after a reload, finds it
// installed and reports nothing.
app.addEventListener("install", ({ detail }) => {
  install.textContent =
    detail.bytes < detail.total
      ? `Installing ${detail.engine}: ${megabytes(detail.bytes)} of ${megabytes(detail.total)}`
      : `Installed ${detail.engine}: ${megabytes(detail.total)}`;
});
```

After the `panel` event listener that sets `mode.textContent`, and before `const toggle = () => {`, add:

```ts

// The focused context's toggle properties, wherever they sit in its property tree, and the context they belong to.
let switchContext: { readonly module: string; readonly ic: number } | undefined,
  toggles: Property[] = [];
const togglesIn = (properties: readonly Property[]): Property[] =>
  properties.flatMap((property) => [
    ...(property.type === 1 && property.visible ? [property] : []),
    ...togglesIn(property.subProps.properties),
  ]);
const renderSwitches = () => {
  switches.replaceChildren(
    ...toggles.map((property) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.switch = property.key;
      button.setAttribute("role", "switch");
      button.setAttribute("aria-checked", String(property.state === 1));
      button.textContent = property.label.text;
      button.title = property.tooltip.text;
      button.disabled = !property.sensitive;
      // The engine answers with UpdateProperty, which redraws the switch.
      button.addEventListener("click", () => {
        if (switchContext === undefined) return;
        app.sendPanelAction(switchContext.module, switchContext.ic, {
          _tag: "PropertyActivate",
          name: property.key,
          state: property.state === 1 ? 0 : 1,
        });
      });
      return button;
    }),
  );
  switches.hidden = toggles.length === 0;
};
// The field keeps the focus, so the action reaches the context whose switches these are.
for (const type of ["pointerdown", "mousedown"]) switches.addEventListener(type, (event) => event.preventDefault());
app.addEventListener("panel", ({ detail }) => {
  if (!ownSwitches) return;
  if (detail._tag === "hide") {
    switchContext = undefined;
    toggles = [];
    renderSwitches();
    return;
  }
  if (detail._tag !== "record") return;
  const record = detail.record;
  if (record._tag === "RegisterProperties") {
    switchContext = { module: detail.module, ic: detail.ic };
    toggles = togglesIn(record.properties.properties);
    renderSwitches();
  } else if (
    record._tag === "UpdateProperty" &&
    detail.module === switchContext?.module &&
    detail.ic === switchContext.ic &&
    toggles.some((property) => property.key === record.property.key)
  ) {
    toggles = toggles.map((property) => (property.key === record.property.key ? record.property : property));
    renderSwitches();
  }
});
```

In `start`, replace

```ts
      group.append(new Option(engine.displayName, String(choices.length)));
      choices.push({ module, engine: engine.name });
```

with

```ts
      const option = new Option(engine.displayName, String(choices.length));
      option.dataset.engine = engine.name;
      group.append(option);
      choices.push({ module, engine: engine.name });
```

- [ ] **Step 5: Run it to see it pass**

```bash
nix develop -c git add examples/demo
nix develop -c bash -c 'cd examples/demo && pnpm exec tsc -b'
nix build .#checks.x86_64-linux.example-demo-smoke .#checks.x86_64-linux.tools-bundle-scan -L
out=$(nix build .#playwright-integration --no-link --print-out-paths -L)
jq '[.suites[] | select(.file == "hangul.spec.ts") | .specs[].tests[].results[] | select(.status == "passed")] | length' "$out/results.json"
```

Expected: PASS. The type check passes (the `install` listener's `detail` is typed by 5c's event map); every Playwright test passes in all three browsers, Mozc's properties-menu test included, since the default page still places the panel's properties; the count is 30 (10 tests × 3 browsers).

- [ ] **Step 6: Document the demo**

In `examples/demo/README.md`, after the paragraph ending `or off. While a module starts, the fields accept native input.`, add:

```markdown
The status line's Data field shows an engine's own data downloading the first time the engine is selected, as Rime's
dictionaries do, and what it installed; a later selection, in the same page or after a reload, installs nothing.

Opened as `/?properties=page` (`http://127.0.0.1:5173/?properties=page`), the page places none of the panel's
properties and draws the focused engine's toggle properties as switches of its own beside the picker, as a page that
styles its own controls would: Hangul's input and Hanja modes, or a Rime schema's switches such as simplified and
traditional output. A switch sends the property's other state to the engine through the facade's panel action and
takes the state the engine reports back. It takes no focus, so the action reaches the field's input context. Each
picker option carries its engine's name in `data-engine`.
```

In `docs/core.md`'s demo paragraph, replace

```
paths that hold an engine's name, as m17n's per-engine paths do, the form shows only the selected engine's. Its
attachment control leaves native input usable while disabled or starting.
```

with

```
paths that hold an engine's name, as m17n's and Rime's per-engine paths do, the form shows only the selected engine's.
A Data field shows the facade's `install` events while an engine's own data downloads. Opened as `/?properties=page`,
the page places none of the panel's properties and draws the focused engine's toggle properties as its own switches,
which send `PropertyActivate` through `sendPanelAction`, taking no focus. Its attachment control leaves native input
usable while disabled or starting.
```

(If the paragraph's wrapping differs, make the same change to its words.) Then:

```bash
nix develop -c oxfmt examples/demo/README.md docs/core.md
nix develop -c hk check -S links
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
nix develop -c git add examples/demo docs/core.md
nix develop -c git commit -m "feat(demo): name each option's engine, show engine data installs and draw a page's own switches" -- examples/demo/index.html examples/demo/src/main.ts examples/demo/src/style.css examples/demo/test/e2e/fixtures.ts examples/demo/test/e2e/hangul.ts examples/demo/test/e2e/hangul.spec.ts examples/demo/README.md docs/core.md
```

---

### Task 4: Rime in the demo

**Files:**
- Modify: `engines/rime/dist.nix`, `examples/demo/module.nix`
- Create: `examples/demo/test/e2e/rime.ts`, `examples/demo/test/e2e/rime.spec.ts`
- Docs: `docs/rime.md`, `examples/demo/README.md`

**Interfaces:**
- Consumes: `ibusWeb.demo.modules`; Task 3's `option[data-engine]`, `#install`, `#switches` and `openDemo(page, path)`; the panel's `.ibus-panel [data-candidate]` buttons, whose text is the candidate's label, a space and the candidate.
- Produces: `ibusWeb.demo.modules.rime`; `rime.ts`'s `field(page)`, `candidates(page)`, `candidateText(text)`, `selectEngine(page, engine)`, `probe(page, keys, value)`, `rime(page, engine)`; one JSON line per browser, `{"metric":"rime_ice, picker to its data installed",…}`.

- [ ] **Step 1: Write the helpers and the failing spec**

Create `examples/demo/test/e2e/rime.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, type Page } from "playwright/test";

export const field = (page: Page) => page.locator("#input");
export const candidates = (page: Page) => page.locator(".ibus-panel [data-candidate]");

// A candidate's button reads its label, a space and the candidate.
export const candidateText = (button: string | null) => (button ?? "").slice((button ?? "").indexOf(" ") + 1);

export async function selectEngine(page: Page, engine: string) {
  const value = await page.locator(`#engine-picker option[data-engine='${engine}']`).getAttribute("value");
  await page.locator("#engine-picker").selectOption(value!);
}

// Typing stays native until the module's Worker, the engine's data and the
// field's context are ready, and keys pass through while Rime's maintenance
// runs, so attempts repeat until Rime alone makes the value. Escape drops
// whatever an attempt left composing.
export async function probe(page: Page, keys: string, value: string) {
  await expect(async () => {
    await field(page).click();
    await page.keyboard.press("Escape");
    await field(page).fill("");
    await page.keyboard.type(keys);
    await expect(field(page)).toHaveValue(value, { timeout: 2_000 });
  }).toPass({ timeout: 120_000 });
  await field(page).fill("");
}

// For each engine the tests type with, keys whose first candidate the Space commits.
const probes: Readonly<Record<string, readonly [string, string]>> = {
  "rime:rime_ice": ["nihao ", "你好"],
  "rime:luna_pinyin": ["zhongguo ", "中國"],
  "rime:cangjie5": ["a ", "日"],
};

// The engine selected and typing, with the field focused and empty.
export async function rime(page: Page, engine: string) {
  await selectEngine(page, engine);
  const [keys, value] = probes[engine]!;
  await probe(page, keys, value);
}
```

Create `examples/demo/test/e2e/rime.spec.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { cpus } from "node:os";
import type { Page } from "playwright/test";
import { expect, openDemo, test } from "./fixtures.ts";
import { candidateText, candidates, field, probe, rime, selectEngine } from "./rime.ts";

declare global {
  interface Window {
    installShown: string[];
  }
}

// An engine's first selection downloads and installs its dictionaries, and the
// module's first start runs Rime's maintenance.
test.describe.configure({ timeout: 300_000 });

const picker = (page: Page) => page.locator("#engine-picker");
const install = (page: Page) => page.locator("#install");
const setting = (page: Page, name: string) => page.locator(`#settings [name='${name}']`);
const settingsReady = (page: Page) =>
  expect(page.locator("#settings-state")).toHaveText("Settings ready; changes save automatically.");
const firstCandidate = async (page: Page) => candidateText(await candidates(page).first().textContent());

// Every text the Data field shows from now on.
const watchInstall = (page: Page) =>
  install(page).evaluate((element) => {
    const shown: string[] = [];
    window.installShown = shown;
    new MutationObserver(() => shown.push(element.textContent ?? "")).observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
const installShown = (page: Page) => page.evaluate(() => window.installShown);

// The groups follow from the manifest's languages by the page's rule, worked
// out again here in the browser from the manifest the page serves.
test("the picker lists Rime's engines under their languages", async ({ page }) => {
  const option = (group: string, engine: string) =>
    picker(page).locator(`optgroup[label='${group}'] option[data-engine='${engine}']`);
  await expect(option("rime · Chinese", "rime:rime_ice")).toHaveText("雾凇拼音 (Pinyin, simplified)");
  await expect(option("rime · Cantonese", "rime:jyut6ping3")).toHaveCount(1);
  await expect(option("rime · Wu Chinese", "rime:wugniu")).toHaveCount(1);

  const groups = await page.evaluate(async () => {
    const manifest = (await (await fetch("/ibus-web/modules/rime/manifest.json")).json()) as {
      engines: { name: string; languages: string[] }[];
    };
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    const language = (code: string | undefined) => {
      if (code === undefined) return "";
      try {
        const { language } = new Intl.Locale(code);
        return language === "und" ? "" : language;
      } catch {
        return code;
      }
    };
    return manifest.engines.map(({ name, languages }) => {
      const code = language(languages[0]);
      return { name, group: code === "" ? "rime" : `rime · ${names.of(code) ?? code}` };
    });
  });
  expect(groups.length).toBeGreaterThan(12);
  for (const { name, group } of groups) await expect(option(group, name)).toHaveCount(1);
  await expect(picker(page).locator("option[data-engine^='rime:']")).toHaveCount(groups.length);
});

test("rime_ice's dictionaries install on its first selection and not on its second", async ({
  page,
  browser,
  browserName,
}) => {
  await watchInstall(page);
  const begin = Date.now();
  await selectEngine(page, "rime:rime_ice");
  await expect(install(page)).toHaveText(/^Installed rime:rime_ice: \d+\.\d MB$/, { timeout: 240_000 });
  const milliseconds = Date.now() - begin;
  expect((await installShown(page)).some((text) => text.startsWith("Installing rime:rime_ice: "))).toBe(true);
  console.log(
    JSON.stringify({
      metric: "rime_ice, picker to its data installed",
      browser: browserName,
      version: browser.version(),
      milliseconds,
      installed: await install(page).textContent(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
    }),
  );
  await probe(page, "nihao ", "你好");

  await picker(page).selectOption({ label: "Hangul" });
  await expect(page.locator("#engine")).toHaveText("ready");
  await watchInstall(page);
  await rime(page, "rime:rime_ice");
  expect(await installShown(page)).toEqual([]);
});

test("rime_ice converts a phrase whole and commits it on Space", async ({ page }) => {
  await rime(page, "rime:rime_ice");
  await page.keyboard.type("nihaoshijie");
  await expect(field(page)).toHaveValue("");
  await expect.poll(() => firstCandidate(page)).toMatch(/^你好世界(\s|$)/);
  await page.keyboard.press("Space");
  await expect(field(page)).toHaveValue("你好世界");
});

test("Cangjie 5 lists 日 first for a and commits it on Space", async ({ page }) => {
  await rime(page, "rime:cangjie5");
  await page.keyboard.type("a");
  await expect.poll(() => firstCandidate(page)).toMatch(/^日(\s|$)/);
  await page.keyboard.press("Space");
  await expect(field(page)).toHaveValue("日");
});

// luna_pinyin starts traditional. The page draws Rime's switch itself and sets
// it through the panel action, with the panel's properties not placed.
test("the page's own switch turns luna_pinyin's simplification on", async ({ page }) => {
  await openDemo(page, "/?properties=page");
  await expect(page.locator(".ibus-panel-properties")).toHaveCount(0);
  await rime(page, "rime:luna_pinyin");
  const simplification = page.locator("#switches [data-switch='rime:option:simplification']");
  await expect(simplification).toHaveAttribute("aria-checked", "false");
  await simplification.click();
  await expect(simplification).toHaveAttribute("aria-checked", "true");
  await page.keyboard.type("zhongguo ");
  await expect(field(page)).toHaveValue("中国");
});

test("a candidate chosen below the first comes first after a reload", async ({ page }) => {
  await rime(page, "rime:rime_ice");
  await page.keyboard.type("shi");
  await expect(candidates(page).nth(2)).toBeVisible();
  const chosen = candidateText(await candidates(page).nth(2).textContent());
  expect(chosen).not.toBe(await firstCandidate(page));
  await candidates(page).nth(2).click();
  await expect(field(page)).not.toHaveValue("");
  expect(chosen.startsWith(await field(page).inputValue())).toBe(true);

  // A Worker's Web Locks outlive its page by up to some 2 s in Chromium, and a
  // host that started then would mount Rime's files read-only.
  await page.reload();
  await expect(page.locator("#engine")).toHaveText("ready");
  await page.evaluate(() => navigator.locks.request("ibus-web:writer:rime", () => undefined));
  await watchInstall(page);
  await rime(page, "rime:rime_ice");
  await expect(page.locator("#storage")).toHaveText("persistent (writable)");
  await page.keyboard.type("shi");
  await expect.poll(() => firstCandidate(page)).toBe(chosen);
  expect(await installShown(page)).toEqual([]);
});

test("the settings form holds Rime's settings and the selected engine's switches, and the page size reaches the panel", async ({
  page,
}) => {
  await rime(page, "rime:rime_ice");
  await settingsReady(page);
  await expect(setting(page, "page-size")).toHaveCount(1);
  await expect(setting(page, "full-shape")).toHaveCount(1);
  await expect(setting(page, "simplification")).toHaveCount(1);

  await setting(page, "page-size").fill("3");
  await page.locator("h1").click();
  await expect(page.locator("#settings-state")).toHaveText("Saved; applies live and across tabs.");

  // The change redeploys Rime's configuration, and keys pass through until
  // that ends.
  await expect(async () => {
    await field(page).click();
    await page.keyboard.press("Escape");
    await field(page).fill("");
    await page.keyboard.type("shi");
    await expect(candidates(page)).toHaveCount(3, { timeout: 2_000 });
  }).toPass({ timeout: 120_000 });
});
```

`full-shape` and `simplification` show once each because the form shows only the selected engine's instance of the relocatable schema; with every engine's they would show once per engine.

- [ ] **Step 2: Run it to see it fail**

```bash
nix develop -c git add examples/demo/test/e2e/rime.ts examples/demo/test/e2e/rime.spec.ts
out=$(nix build .#playwright-integration --no-link --print-out-paths -L) || true
```

Expected: FAIL; every `rime.spec.ts` test fails in all three browsers (no option names a `rime:` engine), and every other spec passes.

- [ ] **Step 3: Serve Rime in the demo, with time for its tests**

In `engines/rime/dist.nix`, add after `packages.ibus-web-rime-dist = dist;`:

```nix

      ibusWeb.demo.modules.rime = dist;
```

In `examples/demo/module.nix`'s `integration`, replace `timeout --kill-after=10 600 ${playwrightTest}` with `timeout --kill-after=10 1800 ${playwrightTest}`, and add above that line:

```nix
            # Each of Rime's tests installs tens of MB of dictionaries in a fresh browser context.
```

- [ ] **Step 4: Run the spec to see it pass**

```bash
nix develop -c git add engines/rime/dist.nix examples/demo
nix build .#checks.x86_64-linux.example-demo-smoke -L
out=$(nix build .#playwright-integration --no-link --print-out-paths -L)
jq '[.suites[] | select(.file == "rime.spec.ts") | .specs[].tests[].results[] | select(.status == "passed")] | length' "$out/results.json"
grep -h 'picker to its data installed' "$out/output.txt" || jq -r '.. | .stdout? // empty | .[]?.text? // empty' "$out/results.json" | grep 'picker to its data installed'
```

Expected: PASS; the count is 21 (7 tests × 3 browsers); three JSON lines, one per browser. Keep `{{chromium}}`, `{{firefox}}` and `{{webkit}}` (each line's `milliseconds`, rounded), the browsers' `version`s, `{{cpu}}`/`{{logicalCpus}}` and `{{installedMB}}` (the `installed` text's MB).

A failure that contradicts an expectation drawn from Rime's data (a first candidate, the traditional default of `luna_pinyin`, the third candidate for `shi`) is a fact about the data, not a bug to work around: check it with 5b's `rime-golden` program or the native `rime_api_console`, correct the expectation (and the probe in `rime.ts`), and say so in Step 6's docs. A switch whose `aria-checked` doesn't follow the click means 5b's toggle reports a state other than the option's value; the `rime-golden` case for `PropertyActivate` is the reference, and the fix is 5b's. `#storage` other than `persistent (writable)` after the reload, with the lock wait in place, is a defect in the host's lock handling: report it rather than retrying. A failure in one browser only, such as the install's progress not showing in Firefox while the page spins, gets a comment and a narrower assertion in that test, never a skip.

- [ ] **Step 5: Measure again, once**

The figures are from the second of two runs, so that no browser's first start is the one recorded. The run's output
isn't deterministic, so delete it and build it again rather than `--rebuild`, which would fail on the difference:

```bash
out=$(nix build .#playwright-integration --no-link --print-out-paths)
nix store delete "$out"
out=$(nix build .#playwright-integration --no-link --print-out-paths -L)
grep -h 'picker to its data installed' "$out/output.txt" || jq -r '.. | .stdout? // empty | .[]?.text? // empty' "$out/results.json" | grep 'picker to its data installed'
```

Replace Step 4's figures with these.

- [ ] **Step 6: Document Rime in the browser**

In `docs/rime.md`, add before `## Checks`:

```markdown
## In the browser

The demo serves the distribution beside the other modules. Its picker gives Rime's engines one group per language, as
it does any module's whose engines declare several: `rime · Chinese` for the Mandarin schemas, simplified and
traditional, and stroke, all `zh`; `rime · Cantonese` for `jyut6ping3` and `jyutping`; `rime · Wu Chinese` for
`wugniu`; and a group for each further language the gloss table gives the dialect, IPA and Middle Chinese schemas
({{otherGroups}}), with any schema it gives no language under `rime`. The
status line's Data field follows the facade's `install` events: an engine's first selection shows its dictionaries
downloading and what it installed, and a later one, in the page or after a reload, shows nothing. The settings form
shows `org.freedesktop.ibus.engine.rime` and, of the relocatable `org.freedesktop.ibus.engine.rime.schema`, only the
selected engine's instance. A change starts Rime's maintenance; keys pass through until it ends, and the next key uses
the change.

A page that styles its own controls drives Rime's switches without its menu. The demo shows how when opened as
`/?properties=page`: it places none of the panel's properties and draws each toggle property of the focused context,
`rime:option:simplification`, `rime:option:full_shape` and the others, as a switch of its own. A switch sends
`PropertyActivate` with the other state through `sendPanelAction` and redraws from the engine's `UpdateProperty`; it
takes no focus, so the action reaches the field's context. Switches of more than two states, which are radio groups,
aren't drawn.

`rime.spec.ts` times `rime_ice`'s first selection, from the picker to `Installed`, which takes in the module's start,
its common data and Rime's maintenance, and `rime_ice`'s {{installedMB}} MB of dictionaries: {{chromium}} ms in
Chromium {{chromiumVersion}}, {{firefox}} ms in Firefox {{firefoxVersion}} and {{webkit}} ms in WebKit
{{webkitVersion}}, the second of two runs, under the Nix sandbox's Playwright on {{cpu}} ({{logicalCpus}} logical
CPUs), with the rest of the suite running beside it. There is no target until there is a baseline.
```

and append to its `## Checks` list:

```markdown
- The demo serves the distribution, and `examples/demo/test/e2e/rime.spec.ts` runs in Chromium, Firefox and WebKit:
  Rime's language groups in the picker, worked out from the served manifest; `rime_ice`'s dictionaries installing on its first selection, with progress,
  and not on its second; `rime_ice` converting `nihaoshijie` whole; Cangjie 5's `日` for `a`; the page's own switch
  turning `luna_pinyin`'s simplification on with the panel's properties not placed; a candidate chosen third for `shi`
  coming first after a reload, from the user dictionary in IndexedDB; and the settings form holding Rime's fixed
  settings and the selected engine's switches, with a page size of 3 reaching the panel.
```

In `examples/demo/README.md`, replace `as m17n's do.` in the first paragraph with `as m17n's and Rime's do.`.

`{{otherGroups}}` lists the remaining group labels the picker shows: `jq -r '.engines[].languages[0] // ""' "$(nix build .#ibus-web-rime-dist --no-link --print-out-paths)/manifest.json" | sort -u`, named as the page names them. Replace the placeholders, then:

```bash
nix develop -c oxfmt docs/rime.md examples/demo/README.md
grep -n '{{' docs/rime.md examples/demo/README.md
nix develop -c hk check -S links
```

Expected: the grep prints nothing; the link check passes.

- [ ] **Step 7: Commit**

```bash
nix develop -c git add engines/rime/dist.nix examples/demo docs/rime.md
nix develop -c git commit -m "feat(demo): serve Rime, with its install, conversion, switch, learning and settings tests" -- engines/rime/dist.nix examples/demo/module.nix examples/demo/test/e2e/rime.ts examples/demo/test/e2e/rime.spec.ts examples/demo/README.md docs/rime.md
```

---

### Task 5: `rime_ice` in the keystroke benchmark

**Files:**
- Modify: `examples/demo/test/e2e/keystroke.bench.ts`
- Docs: `docs/testing.md`, `docs/rime.md`

**Interfaces:**
- Consumes: `hangul(page)`; `rime(page, engine)` and `candidates(page)` from `rime.ts`; `nix run .#keystroke-bench`, which runs `keystroke.bench.ts` alone, one worker, in the three browsers.
- Produces: one JSON line per browser and engine, now carrying `engine`.

- [ ] **Step 1: Write the benchmark with both cases**

Replace `examples/demo/test/e2e/keystroke.bench.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { cpus, platform, release, arch, totalmem } from "node:os";
import type { Browser, Page } from "playwright/test";
import { test, expect } from "./fixtures.ts";
import { hangul } from "./hangul.ts";
import { candidates, rime } from "./rime.ts";
interface Sample {
  key: string;
  milliseconds: number;
  observation: "handler-return" | "later-observer" | "native-input";
}
declare global {
  interface Window {
    ibusBench: { samples: Sample[]; pending: boolean; error: string | undefined };
  }
}

interface Case {
  readonly engine: string;
  readonly ready: (page: Page) => Promise<void>;
  // Typed round and round, each key once per round.
  readonly sequence: string;
  readonly warmup: number;
  // What the field holds after this many keys of the sequence.
  readonly value: (keys: number) => string;
  readonly after: (page: Page) => Promise<void>;
}

const measure = async (page: Page, browser: Browser, browserName: string, bench: Case) => {
  await bench.ready(page);
  await expect(page.locator("#engine")).toHaveText("ready");
  await page.locator("#input").evaluate((element, keys) => {
    const field = element as HTMLTextAreaElement;
    const snapshot = () =>
      JSON.stringify({
        value: field.value,
        start: field.selectionStart,
        end: field.selectionEnd,
        preedit: [...document.querySelectorAll("[data-ibus-preedit]")].map((node) => ({
          text: node.textContent,
          // Cursor/format attributes belong to preedit; incidental positioning styles do not.
          content: [...node.querySelectorAll("*")].map((child) => [
            child.textContent,
            child.getAttribute("class"),
            child.getAttribute("data-cursor"),
          ]),
        })),
      });
    const state: Window["ibusBench"] = {
      samples: [] as Sample[],
      pending: false,
      error: undefined as string | undefined,
    };
    window.ibusBench = state;
    let active: { start: number; before: string; key: string; handled: boolean; prevented: boolean } | undefined;
    const finish = (observation: Sample["observation"]) => {
      if (!active || snapshot() === active.before) return;
      state.samples.push({ key: active.key, milliseconds: performance.now() - active.start, observation });
      active = undefined;
      state.pending = false;
    };
    new MutationObserver(() => {
      if (active?.handled && active.prevented) finish("later-observer");
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "data-cursor"],
    });
    field.addEventListener("input", () =>
      queueMicrotask(() => {
        if (active?.handled) finish(active.prevented ? "later-observer" : "native-input");
      }),
    );
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.target !== field || !event.isTrusted || !keys.includes(event.key)) return;
        if (active) {
          state.error = "Overlapping measured keydowns";
          return;
        }
        active = { start: performance.now(), before: snapshot(), key: event.key, handled: false, prevented: false };
        state.pending = true;
      },
      true,
    );
    // The router's capture listener is already installed on this same target. Its
    // stopPropagation does not skip later listeners in the same capture phase.
    field.addEventListener(
      "keydown",
      (event) => {
        if (!active || !event.isTrusted) return;
        active.handled = true;
        active.prevented = event.defaultPrevented;
        // A passthrough Space can first commit preedit; wait for its native input too.
        if (active.prevented) finish("handler-return");
      },
      true,
    );
  }, bench.sequence);
  let typed = 0;
  const applyKeys = async (count: number) => {
    for (let index = 0; index < count; index++, typed++) {
      const key = bench.sequence[typed % bench.sequence.length]!;
      await page.keyboard.press(key === " " ? "Space" : key);
      await page.waitForFunction(
        (expected) => window.ibusBench.samples.length === expected || !!window.ibusBench.error,
        index + 1,
      );
    }
  };
  // Warmup obeys the same applied-state sequencing as measurement. A flood of
  // unacknowledged keys can overrun an abandoned synchronous request's replay queue.
  await applyKeys(bench.warmup);
  await expect(page.locator("#input")).toHaveValue(bench.value(typed));
  await page.evaluate(() => {
    window.ibusBench.samples.length = 0;
  });
  await applyKeys(500);
  await expect(page.locator("#input")).toHaveValue(bench.value(typed));
  await bench.after(page);
  const result = await page.evaluate(() => window.ibusBench);
  expect(result.error).toBeUndefined();
  expect(result.pending).toBe(false);
  expect(result.samples).toHaveLength(500);
  expect(result.samples.every((sample) => Number.isFinite(sample.milliseconds) && sample.milliseconds >= 0)).toBe(true);
  const sorted = result.samples.map((sample) => sample.milliseconds).sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      metric:
        "trusted keydown capture to observed value/selection/preedit application; paint excluded; later-observer samples include observer delivery overhead",
      engine: bench.engine,
      browser: browserName,
      version: browser.version(),
      node: process.version,
      machine: {
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
      },
      count: sorted.length,
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
      maxMs: sorted.at(-1),
      laterObserverSamples: result.samples.filter((sample) => sample.observation === "later-observer").length,
      nativeInputSamples: result.samples.filter((sample) => sample.observation === "native-input").length,
      samples: result.samples,
    }),
  );
};

test("500 trusted keydowns to observed application, Hangul", async ({ page, browser, browserName }) => {
  test.setTimeout(180_000);
  await measure(page, browser, browserName, {
    engine: "hangul",
    ready: hangul,
    sequence: "gksrmf ",
    warmup: 70,
    // Each round commits 한글 and a space; a round under way leaves its syllables in the preedit.
    value: (keys) => "한글 ".repeat(Math.floor(keys / 7)),
    after: (page) => expect(page.locator("[data-ibus-preedit]").filter({ hasText: "한" })).toBeVisible(),
  });
});

test("500 trusted keydowns to observed application, rime_ice", async ({ page, browser, browserName }) => {
  test.setTimeout(300_000);
  await measure(page, browser, browserName, {
    engine: "rime:rime_ice",
    ready: (page) => rime(page, "rime:rime_ice"),
    sequence: "nihao ",
    warmup: 72,
    // The Space commits each round's first candidate, 你好.
    value: (keys) => "你好".repeat(Math.floor(keys / 6)),
    // 500 keys end two into a round, its ni still composing.
    after: (page) => expect(candidates(page).first()).toBeVisible(),
  });
});
```

Hangul's case does what the single test did: 70 warm-up keys leave `한글 ` ten times, 570 keys 81 times, and the preedit holds `한`. Its keydown filter is the sequence's keys, as before.

- [ ] **Step 2: Run it**

```bash
nix develop -c git add examples/demo/test/e2e/keystroke.bench.ts
nix develop -c bash -c 'cd examples/demo && pnpm exec tsc -b'
nix run .#keystroke-bench 2>&1 | tee /tmp/keystroke-bench.txt | grep -E '✓|✘|passed|failed'
grep -o '"engine":"[^"]*","browser":"[^"]*","version":"[^"]*"' /tmp/keystroke-bench.txt
jq -rR 'fromjson? | select(.engine) | [.engine, .browser, .version, .p50Ms, .p99Ms, .maxMs, .laterObserverSamples, .machine.cpu, .machine.logicalCpus, .machine.release, .node] | @tsv' /tmp/keystroke-bench.txt
```

Expected: PASS, 6 tests (two cases × three browsers), six JSON lines. Keep `rime_ice`'s `{{p50…}}`, `{{p99…}}`, `{{max…}}` and later-observer count for each browser, the browser versions, and the machine. Run it on a machine otherwise idle; the figures are one run's.

- [ ] **Step 3: Document it**

In `docs/testing.md`'s `### Keystroke measurements`, after the paragraph that follows the table (the one ending `[protocol.md](protocol.md#lookup-decode-measurement).`), add:

```markdown
The same benchmark has a `rime_ice` case: `nihao ` typed round and round, 72 warm-up keys, then 500 measured, each
round's Space committing `你好`, with Rime's dictionaries already installed by the case's first selection. One run on
{{cpu}} ({{logicalCpus}} logical CPUs), Linux {{release}}, Node {{node}}:

| Browser                    | p50 ms | p99 ms | max ms |
| -------------------------- | -----: | -----: | -----: |
| Chromium {{chromiumVersion}} | {{chromiumP50}} | {{chromiumP99}} | {{chromiumMax}} |
| Firefox {{firefoxVersion}}   | {{firefoxP50}} | {{firefoxP99}} | {{firefoxMax}} |
| Linux WebKit {{webkitVersion}} | {{webkitP50}} | {{webkitP99}} | {{webkitMax}} |

Each case logs `engine` with its figures; `nix run .#keystroke-bench -- -g rime_ice` runs one case.
```

In `docs/rime.md`'s `## In the browser`, append: ``The keystroke benchmark's `rime_ice` case is in [testing.md](testing.md#keystroke-measurements): {{chromiumP50}}, {{firefoxP50}} and {{webkitP50}} ms at the median in Chromium, Firefox and WebKit.``

Replace the placeholders (milliseconds to three decimal places, as the Hangul table has them), then:

```bash
nix develop -c oxfmt docs/testing.md docs/rime.md
grep -n '{{' docs/testing.md docs/rime.md
nix develop -c hk check -S links
```

Expected: the grep prints nothing; the link check passes. oxfmt re-pads the table.

- [ ] **Step 4: Commit**

```bash
nix develop -c git add examples/demo/test/e2e/keystroke.bench.ts docs/testing.md docs/rime.md
nix develop -c git commit -m "test(demo): measure rime_ice in the keystroke benchmark" -- examples/demo/test/e2e/keystroke.bench.ts docs/testing.md docs/rime.md
```

---

### Task 6: Record M5 in the docs and the design spec

**Files:**
- Modify: `docs/engines.md`, `docs/README.md`, `docs/ibus-web.md`, `docs/testing.md`, `docs/specs/2026-09-26-ibus-web-design.md`

**Interfaces:**
- Consumes: the figures Tasks 1, 2, 4 and 5 wrote in `docs/rime.md`, and `rime-host`'s, which 5c wrote there.

- [ ] **Step 1: `docs/engines.md`**

In the `## Rime` section 5b wrote, make its description of `docs/rime.md` end with `the distribution and npm package, the browser and the checks` (for instance, replace `describes its build, startup, engines, settings and checks.` with `describes its build, startup, engines, settings, per-engine data, the distribution and npm package, the browser and the checks.`; if the wording differs, make the same change to it), and make its `sh` block:

```sh
nix build .#ibus-web-rime-dist
nix build .#checks.x86_64-linux.rime-host
nix build .#npm.engine-rime
```

Then check the per-engine data section 5c wrote:

```bash
grep -n 'large' docs/engines.md | grep -i 'optional\|own data\|per-engine'
```

If it prints nothing, add to the end of the first paragraph of 5c's per-engine data section: ``Per-engine data is for data that is large, optional and an engine's alone, as Rime's dictionaries are; a module whose data every engine shares, or whose whole closure is small, keeps it as base data, as m17n does, whose 1.5 MB of Brotli ibus-m17n reads in full to list its engines.``

- [ ] **Step 2: `docs/README.md`**

In the topics table, make the `engines.md` row's "Covers" cell end `…, Mozc, m17n and Rime` (if 5b hasn't), and in the `rime.md` row, replace the end of its cell, `… and the checks` (or however 5b ended it), with `…, per-engine data, the distribution and npm package, the browser and the checks`, keeping what it lists before.

- [ ] **Step 3: `docs/ibus-web.md`**

In the first paragraph, replace `the runtime's and the Hangul engine's.` with `the runtime's and each engine's.`

After the paragraph about `settings.schemas(module)` (the one ending ``filters both `log` events and the optional logger callback.``), add, unless 5c's text already says the same of the first selection:

```markdown
An engine whose descriptor names data of its own, as each of Rime's names its dictionaries, downloads and installs it
the first time a Worker makes it, so its first `select` waits for that download. `prepare(module, engine)` fetches it
ahead, and `install` events, `{ module, engine, bytes, total }`, report its progress. Serve those archives as the
others. Rime's switches, such as simplified or traditional output (`rime:option:simplification`) and full-width
characters (`rime:option:full_shape`), are IBus properties: a page with its own controls reads them from `panel`
events' `RegisterProperties` and `UpdateProperty` records, sets one with
`sendPanelAction(module, ic, { _tag: "PropertyActivate", name, state })` for the focused context while the field keeps
the focus, and leaves `panel.properties` unplaced. [rime.md](rime.md#in-the-browser) has the details, and the demo
does it when opened as `/?properties=page`.
```

- [ ] **Step 4: `docs/testing.md`**

Count the Playwright tests per spec from Task 4's run:

```bash
out=$(nix build .#playwright-integration --no-link --print-out-paths)
jq -r '.suites[] | "\(.file) \(.specs | length)"' "$out/results.json"
```

In the Production Playwright integration section, replace

```
and runs 28 trusted-input tests in each of Chromium, Firefox and WebKit (84 total): Hangul's nine, the table module's
seven, Mozc's five and m17n's seven.
```

with the counts printed (`{{total}}` their sum, expected 36, and `{{all}}` three times it):

```
and runs {{total}} trusted-input tests in each of Chromium, Firefox and WebKit ({{all}} total): Hangul's {{hangul}}, the
table module's {{table}}, Mozc's {{mozc}}, m17n's {{m17n}} and Rime's {{rime}}.
```

After the sentence ending `and the picker with its Ctrl+Space toggle, which leaves plain input while deselected.`, add: ``It also opens the page as `/?properties=page` and turns Hangul input on with the page's own switch, the panel's properties not placed.`` After the m17n spec's sentence (ending `once the page shows persistent storage.`), add: ``The Rime spec (`rime.spec.ts`) checks the picker's language groups, installs `rime_ice`'s dictionaries on its first selection and nothing on its second, timing it, converts a phrase, types Cangjie, turns `luna_pinyin`'s simplification on with the page's own switch, finds a chosen candidate first after a reload, and checks that the settings form holds the selected engine's switches and that the page size reaches the panel; each test takes up to 300 s, and the run's limit is 1800 s.``

(If the section's wording already differs, apply the same counts and sentences to its current wording.)

- [ ] **Step 5: The design spec**

In `docs/specs/2026-09-26-ibus-web-design.md`:

- §2, replace `Settings come from GSettings (Hangul, m17n, Mozc) or YAML files (Rime).` with `Settings come from GSettings (Hangul, m17n, Mozc, and Rime, whose module writes Rime's YAML from them).`
- §5.4.4: if `type EngineDescriptor` has no `data`, add after its last field: `  data?: string[]; // store paths from the module's data, installed before the engine is first made`. Run `grep -n 'data?: string' docs/specs/2026-09-26-ibus-web-design.md` first; if it prints a line, 5c added it: leave it.
- §5.6, the **Data files** bullet: replace `is fetched as archives listed in the manifest, installed once per version and read lazily like any other file.` with `is fetched as archives listed in the manifest, installed once per version, all at start or, for the archives an engine names as its own, before that engine is first made, and read lazily like any other file.`
- §5.6, the **Installing** bullet: make it say what `docs/storage.md` (as 5c left it) says of the base install. Where it says the host mounts a version with its marker read-only, and that the installing host seals the backend after the marker, say instead that the host mounts the version with its install window shut, and that the installing host shuts the window after the marker. `docs/storage.md` describes the code and wins any difference; read its install section before writing.
- §5.6, add after the **Installing** bullet:

```markdown
- **An engine's own data.** An engine descriptor may name store paths of the module's data as its own (`data`,
  §5.4.4). Those archives are lazy; the rest are base data, installed at start as above. Each lazy path gets its own
  marker, `meta.paths/<storePath>` = `{ files, bytes }`, in the version's database. Before the page first makes such an
  engine in a Worker, it sends `PrepareEngine { engine }`, outside the ring and the request loop, as installing is. The
  host takes the version's install lock, reads the engine's lazy paths' markers and, for each missing one, removes
  whatever an interrupted install left under the path, opens the install window, streams and extracts the archive with
  the checks above and its own `size` limit, writes the marker in a strict transaction and shuts the window; it reports
  progress and an `install` report per path, and lets the lock go. With every marker present it does nothing. A host
  that mounted the version before another Worker installed a path finds it by lookup: WasmFS caches the entries it has
  found, never an entry's absence. A memory mount installs every archive at start, since its memory is sized then.
- **The install window.** Since any host may later install a lazy path, the data backend can't be sealed for good.
  `wasmfs_idb_backend_set_writable(backend, writable)` gates it instead: a change while it isn't writable fails with
  `EROFS`, as a sealed backend's does. The host makes it writable only while it holds the version's install lock and
  runs the extractor. This is a weaker guarantee than the seal: while the window is open, an engine thread in the same
  Worker could write under `/nix/store`. None does, and the window lasts one archive's extraction. The engine's own
  files keep the one-way seal and the writer lock.
```

- §10.2's table: change the `engine-rime` row's Notes cell from `GPL-3.0-or-later` to `GPL-3.0-or-later; packed with librime, its plugins, their dependencies and the data as GPL-3.0-or-later AND BSD-3-Clause AND GPL-3.0-only AND MIT AND Apache-2.0 AND BSD-2-Clause AND BSL-1.0 AND LGPL-3.0-only AND CC-BY-4.0`.
- §10.2's engine data list: replace the whole **Rime** bullet with:

```markdown
- **Rime:** every schema of `rime-data` and `rime-ice`, from nixpkgs, and of `rime-loengfan`, which `jyut6ping3` needs
  and `rime-data` lacks, fetched from CanCLID at the revision Debian and Arch ship; `rime-ice`'s `double_pinyin*`
  replace `rime-data`'s. The module's recipe takes `schemas`, every one by default, so a build can ship fewer. The YAML
  sources are compiled at build time by the WASM build of `rime_deployer` under Node, so compiled dictionaries come
  from the librime build that reads them. The output is a common store path (the compiled configurations, `symbols`,
  OpenCC's data and `rime-ice`'s Lua scripts), which is base data, and one path per dictionary, which is data of the
  engines  that use it, installed when one is first made (§5.6). Rime data nixpkgs lacks would come from xddxdd's NUR, where the
  Rime community packages it (`rime-moegirl`, `rime-aurora-pinyin` and others), as a flake input whose `nixpkgs`
  follows ours; nothing shipped needs it, so the input waits until some data does. Only data whose license allows
  redistribution in a published package would ship, which rules out its `unfree` dictionaries and `rime-moegirl`'s
  CC-BY-NC-SA.
```

- §10.3.1's graph: replace `(data: rime-data, deployed)` with `(data: ibus-web-rime-common; per engine, ibus-web-rime-dict-*)`, keeping the line's column alignment.
- §12's M5 row: replace the Scope cell, which starts `Rime: librime and dependencies`, with

  ``**Done.** (`docs/rime.md`) ibus-rime 1.6.1 over librime 1.17.0 with librime-lua and librime-octagram, and every schema of `rime-data`, `rime-loengfan` and `rime-ice`, deployed at build time: {{engines}} engines, one per schema, `rime:rime_ice` the default; settings through GSettings, from which the module writes Rime's `*.custom.yaml` and redeploys on the deployer thread; Rime's switches as IBus properties a page can drive from its own controls; per-engine data, each engine's dictionaries installed when it is first made; a build with fewer schemas through `schemas`; `@ibus-web/engine-rime`, Rime in the demo, and its Playwright integration``

  and the Questions cell `Threads in a real engine; data size` with

  ``Can a real engine run threads of its own, and can its data come per engine? Both yes. LevelDB's compaction thread and the deployer's run within the declared {{threads}} engine threads and {{heapMiB}} MiB program break under `rime-host`, which starts the module in {{hostStartMin}}–{{hostStartMax}} ms under Node with its common data installed from Brotli, and a learned word survives a reload in each browser, from LevelDB over IndexedDB. A page downloads only the dictionaries of the engines its users pick: `rime_ice`'s {{iceBrotliMB}} MB of the {{lazyBrotliMB}} MB, its first selection taking {{browserMin}}–{{browserMax}} ms in the browsers. {{r19}} Playwright types pinyin and Cangjie and drives a page's own switch in Chromium, Firefox and WebKit``

  `{{engines}}`, `{{iceBrotliMB}}` and `{{lazyBrotliMB}}` are Task 1's figures in MB to one decimal place; `{{threads}}`, `{{heapMiB}}`, `{{hostStartMin}}` and `{{hostStartMax}}` are `rime-host`'s, from `docs/rime.md` (`grep -n 'rime-host' docs/rime.md`); `{{browserMin}}`/`{{browserMax}}` the least and greatest of Task 4's three times; `{{r19}}` one sentence giving R19's outcome as §13 records it, such as `R19 closed with libpinyin dropped: …`.
- §13's R7: replace `- **R7. Rime data size.** Prebuilt schemas can be large; lazy download per schema may be needed. Decided in M5.` with

```markdown
- **R7. Rime data size. Resolved** by per-engine data (§5.6). The shipped dictionaries come to {{lazyBrotliMB}} MB as
  Brotli; each engine names its own and its dependencies' as data installed when it is first made, so a page downloads
  only those of the engines its users pick: `rime_ice`'s {{iceBrotliMB}} MB, beside {{baseBrotliMB}} MB of common data
  at the module's start. The install window this needs is weaker than the seal it replaces (§5.6).
```

  with `{{baseBrotliMB}}` Task 1's `{{baseBrotli}}` in MB.
- R19 is 5a's: check that it reads as decided (`grep -n 'R19. Rime' docs/specs/2026-09-26-ibus-web-design.md`). If it doesn't, report it rather than editing it here.

- [ ] **Step 6: Format and check**

```bash
nix develop -c oxfmt docs/engines.md docs/README.md docs/ibus-web.md docs/testing.md docs/specs/2026-09-26-ibus-web-design.md
grep -n '{{' docs/engines.md docs/README.md docs/ibus-web.md docs/testing.md docs/specs/2026-09-26-ibus-web-design.md
nix develop -c hk check -S links
```

Expected: the grep prints nothing and the link check passes. oxfmt re-pads §12's table; that is expected.

- [ ] **Step 7: Commit**

```bash
nix develop -c git add docs/engines.md docs/README.md docs/ibus-web.md docs/testing.md docs/specs/2026-09-26-ibus-web-design.md
nix develop -c git commit -m "docs: record Rime in the browser and M5 as done" -- docs/engines.md docs/README.md docs/ibus-web.md docs/testing.md docs/specs/2026-09-26-ibus-web-design.md
```

The design spec's rendered page is out of date from here. Republishing it (with `~/.claude/skills/doc-artifact/render.py`) isn't this plan's: say in the phase's report that the spec changed.

---

### Task 7: Verify the phase

- [ ] **Step 1: Generated files have no drift**

Run: `nix run .#write-files && git status --short`
Expected: no output.

- [ ] **Step 2: Every check**

Run each; all expected to PASS:

```bash
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

`nix flake check` includes `typescript-npm` (with `@ibus-web/engine-rime`), `typescript-package-metadata`, `example-demo-smoke`, `tools-bundle-scan`, `rime-host` and 5b's Rime checks; `integration-checks` includes the Playwright integration with `rime.spec.ts` and the new `hangul.spec.ts` test. `nix flake check` also runs `rime-dist-schemas`.

- [ ] **Step 3: The phase's own outputs**

```bash
nix build .#ibus-web-rime-dist .#npm.engine-rime .#checks.x86_64-linux.rime-dist-schemas .#playwright-integration -L
nix run .#keystroke-bench -- -g rime_ice
```

Expected: PASS; the benchmark prints three `rime:rime_ice` lines.

- [ ] **Step 4: Report**

Report which commands ran and their results. For anything that failed, give the failing check and its output, fix it in the task it belongs to with a new commit of the same scope (amending nothing), and rerun Step 2. Say that the design spec changed and its rendered page needs republishing.
