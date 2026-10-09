# M4 Phase 3: m17n in the Browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase 3 of `docs/specs/2026-10-09-m4-m17n.md`: the m17n module's distribution and npm package, `m17n-host` (the distribution through a Node Worker host and the test page on both runtime builds), m17n in the demo with its engines grouped by language and only the selected engine's settings shown, Playwright in three browsers with the module's start from IndexedDB timed, and the browser-side docs that record M4 as done.

**Architecture:** Phase 2 leaves `m17n.wasm`, its data closure, the descriptor step's outputs and the `ibusWeb.engines.m17n` option. This phase lets `mkEngineManifest` and `mkSettingsMetadata` take the schema list as a JSON file, as they already take `settingsPaths`, since m17n's variable schema ids exist only once the descriptor program has run; feeds phase 2's outputs to `mkEngineManifest` in a new `engines/m17n/dist.nix`; packs the result as `@ibus-web/engine-m17n`; and exercises it end to end: under Node through the Worker host with an `Init` that declares every instance the module's metadata lists, as the page does, and in the demo through the facade, the panel and the real settings persister. The demo gains two generic rules: a module whose engines span several languages gets one picker group per language, and a settings path that holds an engine's name belongs to that engine and shows only while it is selected.

**Tech Stack:** TypeScript 7 on Node, Vitest, Playwright 1.63 (Chromium, Firefox, WebKit), Nix flake-parts, jq, hk, oxfmt.

## Global Constraints

- Work on branch `typedrat/m4c-m17n-in-the-browser`, cut from the tip of `typedrat/m4b-m17n-under-node` (phase 2), which sits on `typedrat/m4a-settings-by-path` (phase 1).
- Names this plan consumes from phase 1, used exactly: `Init` entries `{ schemaId, path, values }` (`a(ssa{sv})`); `SettingChanged`/`SettingWritten` `{ path, key, value }`; the settings API `get(module, path, key)`, `set(module, path, key, value)`, `reset(module, path, key)`; metadata schemas `{ id, paths, keys }`; `mkEngineManifest { name, package, threads, heapBytes, settingsSchemaDir, engines, settingsSchemas, settingsPaths ? { } }` and `mkSettingsMetadata { settingsSchemaDir, settingsSchemas, settingsPaths ? { } }`, `settingsPaths` an attribute set or a JSON file; the settings-metadata fixture in `modules/engines/settings-metadata.nix` and its test `tools/gschema/metadata.test.ts`; the demo's settings form looping over every schema's `paths`.
- Names this plan consumes from phase 2, used exactly (its "Interfaces phase 3 relies on"):
  - the option `ibusWeb.engines.m17n`, a submodule: `package` (`pkgsWasm.ibus-engines.m17n`, `$out/m17n.wasm`, `default.xml` in its `data` output), `descriptors` (path of `engines.json`, the descriptor array, the default engine first), `settingsPaths` (path of `settings-paths.json`, `{ "org.freedesktop.ibus.engine.m17n": [197 paths] }`), `settingsSchemaDir` (string), `settingsSchemas` (**path of `settings-schemas.json`**, a JSON array: ibus-m17n's schema, the panel's and the 34 variable schemas), `defaultEngine` (`"m17n:t:latn-post"`);
  - the package's passthru `m17n_lib`, `schemas`, `settingsSchemaDir`, `descriptorProgram`, `descriptors`; `packages.ibus-web-m17n` and `packages.ibus-web-m17n-descriptors`;
  - the descriptor program `engines/m17n/descriptors/descriptors.c` and its step `@ibus-web/m17n-descriptors`;
  - checks `m17n-golden`, `m17n-engines`, `m17n-descriptors`, `m17n-imports`, `m17n-data-closure`, `m17n-cast-audit`;
  - the docs it writes: `docs/m17n.md` (Build, Startup, Engines, Settings and variables, Checks), `docs/runtime.md`, the `## m17n` section of `docs/engines.md`, the `m17n.md` row of `docs/README.md` and the known-gaps entry **m17n variable changes that wait for a restart**;
  - ibus-m17n's port patch 0001, which terminates `ibus_m17n_mtext_to_ucs4`'s buffer so a lookup table built from a candidate group holds only its own candidates.
- Names other work relies on: `packages.ibus-web-m17n-dist`; `checks.m17n-host`; `legacyPackages.<system>.npm.engine-m17n`; `ibusWeb.demo.modules.m17n`; `PageSession.press` in `packages/worker-host/test/engines/page-session.ts`; `settingsSchemas` accepted as a list or a JSON file by `mkEngineManifest` and `mkSettingsMetadata`.
- Run every command inside the dev shell (`nix develop -c …`) from the branch's checkout. `git add` a new file before any `nix` command that should see it: the flake reads only files git tracks.
- Commit with `nix develop -c git add <paths>` then `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths>`, in Conventional Commits. Stage named paths only, never `git add -A` or `git add .`. No attribution trailers or "Generated with" lines. If hk's hook rewrites a file, re-add it and commit again; never bypass the hook. Never revert, reformat or "fix" changes you didn't make.
- Comments explain why, never what; no history ("now", "previously"), no references to other files, plans or pull requests, no "NOTE:". Match the surrounding comment density. Separate logical blocks with one blank line; never a blank line right after an opening token or right before a closing one, nor between a comment and the code it describes. Never whitespace-minimize code.
- New files start with `SPDX-FileCopyrightText: 2026 Synapdeck, Inc.` and an `SPDX-License-Identifier` in their comment syntax: `GPL-2.0-or-later` under `engines/m17n/` and in `packages/engines/m17n/module.nix` (engine files take the engine's licence), `MIT OR Apache-2.0` for test and demo TypeScript. `package.json` and `README.md` files are covered by `REUSE.toml`.
- Docs change in the same commit as the code they describe. Phase 2 wrote the m17n docs; this phase adds only the distribution, `m17n-host`, the demo and the browser to them, the design spec's M4 row and its §10.2/§10.3.1 m17n data entries. Format every Markdown file under `docs/` and every README you touch with `nix develop -c oxfmt <file>`; never run oxfmt on `docs/plans/`.
- Generated files (`pnpm-workspace.yaml`, `.github/workflows/ci.yml`, `PROTOCOL.md`, `protocol.h`, the key tables and notices) are never edited by hand. Nothing in this phase changes them: `packages/engines/*` is outside the workspace's globs (`packages/*` matches one level), so `@ibus-web/engine-m17n` adds no workspace package and `pnpm-lock.yaml` doesn't change. Task 7 confirms there is no drift.
- **Measured values.** Some figures exist only once the build runs: the program break, start times, sizes, counts. A task never invents them. It writes `{{name}}` placeholders, runs the step that measures them, and replaces each placeholder with the printed value. Before each commit that touches a placeholder-bearing file, `grep -n '{{' <file>` prints nothing.

### Decisions this plan makes where the spec is silent

- **`settingsSchemas` as a list or a file.** `mkSettingsMetadata` and `mkEngineManifest` accept `settingsSchemas` as a Nix list or a JSON file (a store path or a derivation), as `settingsPaths` may be an attribute set or a file; a list is written to a file, and the build reads the file. The manifest's `settingsSchemas` field is the file's array either way. The settings-metadata fixture covers both, through `mkSettingsMetadata` and through a Hangul distribution built with its schema list as a file.
- **Where the distribution lives.** `engines/m17n/dist.nix`, a module of its own beside phase 2's `module.nix`, reading only `ibusWeb.engines.m17n`; the demo registration lives there too. Phase 2's descriptors put the default engine first; the distribution task checks that the manifest's first engine is `defaultEngine`.
- **The licence.** `mkEngineManifest` writes `spdxExpression package.meta.license`, and nixpkgs' `ibus-engines.m17n` declares only `gpl2Plus`. The package's `meta.license` becomes `[ gpl2Plus lgpl21Plus ]` in phase 2's overlay, since m17n-lib is linked in and m17n-db is the data. The npm package copies `LICENSES/GPL-2.0-or-later.txt` and `LICENSES/LGPL-2.1-or-later.txt`, both already in the repository.
- **`heapBytes`.** The distribution starts from phase 2's figure: a test program with all 197 engines open peaked at about 26.5 MB under Node, so Task 1 declares 32 MiB. `m17n-host` then measures the distribution itself, with every engine open in one Worker, and Task 2 declares `ceil(max(peak asserting, peak released) / 1 MiB) + 4` MiB: several MiB above the measured peak, not the next whole MiB.
- **What `m17n-host` declares in `Init`.** Every instance the distribution's `settings.json` lists, with values only where a test gives them, as the page does. The check passes the metadata to the suite through the module-test `texts` (`texts.settings`). A separate case records the encoded `Init`'s size and holds it below the transport's 64 KiB request slot.
- **Keys the engine may decline.** m17n passes some keys through. `PageSession.press` reports whether the engine took a key; the m17n suite's `typeText` models the field a browser would hold: commits, plus each declined key's character.
- **The variable case.** Phase 2's verified one: Telex with `tone-mark-on-last` 1 from `Init` turns `h o a f Space` into `hoà `. At its default, Telex puts the tone of `oa` on the first vowel (`hòa `), from `vi-telex.mim`'s own description of the variable.
- **Thai.** From `th-kesmanee.mim`'s WTT 2.0 rules at the default level 1: a tone mark (`h`, ้) after nothing is rejected, after a consonant from the surrounding text (ก) it is committed. `m17n-host` checks both; Playwright checks the accepted case in the textarea (a rejected key leaves nothing to wait for).
- **Candidates.** No test here pages through candidates; `zh:cangjie`'s first page in `m17n-host` and any paging in the demo rely on phase 2's port patch 0001.
- **The picker.** A module whose engines declare more than one distinct first language gets one `<optgroup>` per language, labelled `<module> · <English language name>` (`Intl.DisplayNames`), in the order the manifest first lists each; engines without a language stay in a group labelled with the module's name. Every other module keeps its single group, so Hangul, Mozc and the table module's pickers don't change.
- **The settings form.** An engine owns the settings paths that contain its name's components as consecutive path segments (`m17n:hi:inscript` owns `/org/freedesktop/ibus/engine/m17n/hi/inscript/` and `…/hi/inscript/variables/`). The form shows the paths the selected engine owns and those no engine of the module owns (the panel's, Mozc's), and reloads on an engine change only in a module where some engine owns a path. Control ids keep phase 1's scheme, so `#setting-hangul-keyboard` and `#setting-punctuation-method` are unchanged.
- **The variables' save message.** A control whose schema id starts `org.freedesktop.ibus.engine.m17n.` (a variable schema, never ibus-m17n's own `org.freedesktop.ibus.engine.m17n`) reports `Saved; applies to engines not yet opened, and to the rest after Restart module.`; every other control keeps `Saved; applies live and across tabs.`
- **Start time from IndexedDB.** Measured in each browser by `m17n.spec.ts`: after the first start has installed the data, the test clicks Restart module and times, in the page, from the click to the module's state reading `ready` again, observing `#engine` with a `MutationObserver`. It logs one JSON line per browser; the figures go in `docs/m17n.md`, the design spec's M4 row and `docs/known-gaps.md`. The test asserts no figure: there is no baseline yet.
- **Known gaps.** The startup reads (every `.mim` parsed at each start) get a known-gaps entry whatever their measured cost, since nothing in M4 reduces them.
- **The root README** lists every published engine package; Mozc's row is missing, so Task 3 adds it beside m17n's.
- **§5.4 of the design spec** has no m17n-specific statement and stays as it is.

---

## File structure

| Path | Change |
| --- | --- |
| `modules/engines/settings-metadata.nix`, `modules/engines/manifest.nix` | `settingsSchemas` as a list or a JSON file; the fixture covers both |
| `tools/gschema/metadata.test.ts` | Tests for a schema list given as a file |
| `engines/m17n/overlay.nix` | The package's `meta.license` |
| `engines/m17n/dist.nix` | Create: `packages.ibus-web-m17n-dist`; the demo registration |
| `engines/m17n/checks/host/checks.nix` | Create: `checks.m17n-host` |
| `packages/worker-host/test/engines/page-session.ts` | `press`, a key the engine may decline |
| `packages/worker-host/test/engines/m17n.test.ts` | Create: the m17n host suite |
| `packages/engines/m17n/package.json`, `README.md`, `module.nix` | Create: `@ibus-web/engine-m17n` |
| `examples/demo/src/main.ts` | Picker groups by language; engine-owned settings; the variables' save message |
| `examples/demo/README.md` | The picker and the settings form |
| `examples/demo/test/e2e/m17n.spec.ts` | Create: the m17n Playwright spec |
| `docs/m17n.md` | Distribution, In the browser, Checks bullets |
| `docs/engines.md` | `settingsSchemas` as a file; the m17n section's commands |
| `docs/core.md`, `docs/testing.md`, `docs/known-gaps.md`, `docs/README.md`, `README.md` | m17n where each page lists modules or their behaviour; Mozc's README row |
| `docs/specs/2026-09-26-ibus-web-design.md` | §10.2, §10.3.1, §12's M4 row |

---

### Task 0: Check phase 2's interface

**Files:** none.

- [ ] **Step 1: Create the branch**

```bash
nix develop -c git switch -c typedrat/m4c-m17n-in-the-browser typedrat/m4b-m17n-under-node
```

- [ ] **Step 2: Check the names this plan consumes**

```bash
grep -nE '^ +(package|descriptors|settingsPaths|settingsSchemaDir|settingsSchemas|defaultEngine) = lib.mkOption' engines/m17n/options.nix
test -f engines/m17n/descriptors/descriptors.c
nix eval --raw .#packages.x86_64-linux.ibus-web-m17n.name && echo
for check in m17n-golden m17n-engines m17n-descriptors m17n-imports m17n-data-closure m17n-cast-audit; do
  nix eval --raw ".#checks.x86_64-linux.$check.name" && echo
done
grep -n '^## ' docs/m17n.md
grep -n '^## m17n' docs/engines.md
grep -n 'm17n variable changes that wait for a restart' docs/known-gaps.md
```

Expected: six options; the descriptor program exists; the package's and each check's derivation name print; `docs/m17n.md` has `## Build`, `## Startup`, `## Engines`, `## Settings and variables` and `## Checks`; `docs/engines.md` has `## m17n`; the known-gaps entry exists. Any difference is a mismatch with phase 2's plan: stop and resolve it there before going on.

---

### Task 1: The distribution

**Files:**
- Modify: `modules/engines/settings-metadata.nix`, `modules/engines/manifest.nix`, `tools/gschema/metadata.test.ts`, `engines/m17n/overlay.nix`
- Create: `engines/m17n/dist.nix`
- Docs: `docs/engines.md`, `docs/m17n.md`

**Interfaces:**
- Consumes: `ibusWeb.engines.m17n`, `ibusWeb.engines.mkEngineManifest`, `ibusWeb.engines.mkSettingsMetadata`.
- Produces: `settingsSchemas` accepted as a list or a JSON file; `packages.ibus-web-m17n-dist`, a directory with `manifest.json`, `m17n.wasm`, `settings.json` and `data/*.tar.br`, with `passthru.heapBytes`.

- [ ] **Step 1: Write the failing tests for a schema list given as a file**

In `tools/gschema/metadata.test.ts`, add to the type of `paths`:

```ts
  settingsSchemasFromFile: string;
  hangulSchemasFromFile: string;
```

and after the test `mkSettingsMetadata takes settingsPaths as %s`, add:

```ts
test("mkSettingsMetadata takes settingsSchemas as a JSON file", () => {
  expect(readFileSync(paths.settingsSchemasFromFile, "utf8")).toBe(readFileSync(paths.settingsFromAttrs, "utf8"));
});

test("mkEngineManifest takes settingsSchemas as a JSON file and lists them in the manifest", () => {
  const manifest = (dir: string) => JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
  expect(manifest(paths.hangulSchemasFromFile).settingsSchemas).toEqual(manifest(paths.hangul).settingsSchemas);
  expect(readFileSync(`${paths.hangulSchemasFromFile}/settings.json`, "utf8")).toBe(
    readFileSync(`${paths.hangul}/settings.json`, "utf8"),
  );
});
```

In `modules/engines/settings-metadata.nix`, replace `fixtureSettings` with:

```nix
      fixtureSchemas = [
        "org.test.Metadata"
        "org.test.Relocatable"
      ];

      fixtureSettings =
        settingsSchemas: settingsPaths:
        config.ibusWeb.engines.mkSettingsMetadata {
          settingsSchemaDir = "${helper}/schemas";
          inherit settingsSchemas settingsPaths;
        };

      # Hangul's distribution again, with its schema list from another
      # derivation's build.
      hangulDist = config.packages.ibus-web-hangul-dist;
      hangulSchemasFromFile = config.ibusWeb.engines.mkEngineManifest {
        name = "hangul";
        package = config.ibusWeb.engines.hangul;
        threads = 0;
        inherit (hangulDist) heapBytes;
        inherit (config.ibusWeb.engines.hangul) settingsSchemaDir;
        engines = pkgs.runCommand "ibus-web-hangul-engines.json" { nativeBuildInputs = [ pkgs.jq ]; } ''
          jq .engines ${hangulDist}/manifest.json > $out
        '';
        settingsSchemas =
          pkgs.runCommand "ibus-web-hangul-settings-schemas.json" { nativeBuildInputs = [ pkgs.jq ]; }
            ''
              jq .settingsSchemas ${hangulDist}/manifest.json > $out
            '';
      };
```

and in `fixture`, replace the two `settingsFrom…` entries with:

```nix
          settingsFromAttrs = fixtureSettings fixtureSchemas fixturePaths;
          settingsFromFile = fixtureSettings fixtureSchemas (
            pkgs.writeText "ibus-web-settings-paths-fixture.json" (builtins.toJSON fixturePaths)
          );
          settingsSchemasFromFile = fixtureSettings (pkgs.writeText "ibus-web-settings-schemas-fixture.json" (
            builtins.toJSON fixtureSchemas
          )) fixturePaths;
          inherit hangulSchemasFromFile;
```

- [ ] **Step 2: Run them to see them fail**

```bash
nix develop -c git add tools/gschema modules/engines
nix build .#checks.x86_64-linux.engines-settings-metadata -L
```

Expected: FAIL at evaluation or build: `lib.escapeShellArgs` can't take a file, and `builtins.toJSON` writes the file's store path where the manifest expects an array.

- [ ] **Step 3: Accept a list or a file**

In `modules/engines/settings-metadata.nix`'s `mkSettingsMetadata`, add beside `pathsFile` in the `let`:

```nix

          schemasFile =
            if builtins.isList settingsSchemas then
              pkgs.writeText "ibus-web-settings-schemas.json" (builtins.toJSON settingsSchemas)
            else
              settingsSchemas;
```

and replace

```nix
            node ${helper}/metadata.js ${lib.escapeShellArg settingsSchemaDir} ${lib.escapeShellArgs settingsSchemas} "''${instances[@]}" > raw.json
```

with

```nix
            mapfile -t schemas < <(jq -r '.[]' ${schemasFile})
            node ${helper}/metadata.js ${lib.escapeShellArg settingsSchemaDir} "''${schemas[@]}" "''${instances[@]}" > raw.json
```

In `modules/engines/manifest.nix`, add after `enginesFile` in the `let`:

```nix

          # The schema list, too, can come from another derivation's build.
          schemasFile =
            if builtins.isList settingsSchemas then
              pkgs.writeText "ibus-web-${name}-settings-schemas.json" (builtins.toJSON settingsSchemas)
            else
              settingsSchemas;
```

remove `settingsSchemas` from the `inherit` inside `description`, replace `--slurpfile data data.jsonl --slurpfile engines ${enginesFile} \` with `--slurpfile data data.jsonl --slurpfile engines ${enginesFile} --slurpfile settingsSchemas ${schemasFile} \`, and in the `jq` program replace `engines: $engines[0], $settingsMetadata }` with `engines: $engines[0], settingsSchemas: $settingsSchemas[0], $settingsMetadata }`.

In `docs/engines.md`'s Distribution manifest section, replace

```
`heapBytes`, `settingsSchemaDir`, `engines` and `settingsSchemas`. `engines` is the
module's engine descriptors, as a Nix list or as a JSON file another derivation
builds; the manifest's own check validates them, so evaluation never reads a build
output.
```

with

```
`heapBytes`, `settingsSchemaDir`, `engines`, `settingsSchemas` and, for relocatable
schemas, `settingsPaths`. `engines`, the module's engine descriptors, and
`settingsSchemas`, its schema ids, are each a Nix list or a JSON file another
derivation builds, as `settingsPaths` is an attribute set or such a file; the
manifest's own check validates them, so evaluation never reads a build output.
```

(If the wording there differs, make the same change to it.) Format with `nix develop -c oxfmt docs/engines.md`.

- [ ] **Step 4: Run them to see them pass**

```bash
nix develop -c git add modules/engines tools/gschema docs/engines.md
nix build .#checks.x86_64-linux.engines-settings-metadata .#ibus-web-hangul-dist .#ibus-web-mozc-dist .#ibus-web-table-dist -L
for module in hangul mozc table; do
  jq -c .settingsSchemas "$(nix build ".#ibus-web-$module-dist" --no-link --print-out-paths)/manifest.json"
done
```

Expected: PASS; each manifest's `settingsSchemas` is the same array as before (`["org.freedesktop.ibus.engine.hangul","org.freedesktop.ibus.panel"]`, `["org.freedesktop.ibus.engine.mozc","org.freedesktop.ibus.panel"]`, `["org.freedesktop.ibus.panel"]`).

- [ ] **Step 5: Commit**

```bash
nix develop -c git commit -m "feat(engines): take a module's settings schema list as a JSON file a derivation builds" -- modules/engines/settings-metadata.nix modules/engines/manifest.nix tools/gschema/metadata.test.ts docs/engines.md
```

- [ ] **Step 6: Give the package both licences**

In `engines/m17n/overlay.nix`, inside the attribute set that `ibus-engines.m17n`'s `overrideAttrs (old: { … })` returns, add before its `passthru`:

```nix
                # m17n-lib is linked into the module and m17n-db's input
                # methods are its data, both LGPL-2.1-or-later.
                meta = old.meta // {
                  license = with lib.licenses; [
                    gpl2Plus
                    lgpl21Plus
                  ];
                };
```

Run: `nix eval --json .#packages.x86_64-linux.ibus-web-m17n.meta.license | jq -r '.[].spdxId'`
Expected: `GPL-2.0-or-later` then `LGPL-2.1-or-later`. (`meta` doesn't change the derivation, so nothing rebuilds.)

- [ ] **Step 7: Write the distribution**

Create `engines/m17n/dist.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) engines;
      inherit (config.ibusWeb.engines) m17n;
    in
    {
      packages.ibus-web-m17n-dist = engines.mkEngineManifest {
        name = "m17n";
        inherit (m17n)
          package
          settingsSchemaDir
          settingsSchemas
          settingsPaths
          ;

        # A test program with all 197 engines open peaks at about 26.5 MB
        # under Node; the declaration leaves several MiB above that, and the
        # manifest builder adds headroom after it.
        threads = 0;
        heapBytes = 32 * 1024 * 1024;

        engines = m17n.descriptors;
      };
    };
}
```

- [ ] **Step 8: Build it and check what it holds**

```bash
nix develop -c git add engines/m17n/dist.nix engines/m17n/overlay.nix
dist=$(nix build .#ibus-web-m17n-dist --no-link --print-out-paths -L)
jq -r '.license, .threads, .engines[0].name, (.engines | length), (.settingsSchemas | length), (.data | length), ([.data[].size] | add), .memory' "$dist/manifest.json"
jq -r '.data[].storePath' "$dist/manifest.json"
jq -r '.schemas[] | "\(.id) \(.paths | length)"' "$dist/settings.json" | sort -k2 -n | tail -3
du -cb "$dist"/data/*.tar.br | tail -1
stat -c %s "$dist/m17n.wasm"
```

Expected:
- `GPL-2.0-or-later AND LGPL-2.1-or-later`; `0`; `m17n:t:latn-post` (the option's `defaultEngine`); `197`; `36` (ibus-m17n's schema, the panel's and 34 variable schemas); `3` archives; the bytes they install (`{{dataBytes}}`); the memory.
- Three store paths, `ibus-web-m17n-db`, ibus-m17n's `data` output with `default.xml`, and the compiled schemas: the module's closure is these and the package itself (`m17n-data-closure` checks exactly that), and `mkEngineManifest` leaves the package out of the data.
- `org.freedesktop.ibus.engine.m17n 197` last; the panel and each variable schema with one path.
- The archives' Brotli total (`{{brotliBytes}}`) and `m17n.wasm`'s size (`{{wasmBytes}}`).

Keep the printed values for Step 9.

- [ ] **Step 9: Document the distribution**

In `docs/m17n.md`, add before `## Checks`:

```markdown
## Distribution

`ibus-web-m17n-dist` (`engines/m17n/dist.nix`) is `mkEngineManifest` over `m17n.wasm`, with the descriptor step's
`engines.json`, `settings-paths.json` and `settings-schemas.json`. Its 197 engines start with `m17n:t:latn-post`, the
module's default. The schema list is a file because the variable schema ids exist only once the descriptor program has
run; the manifest lists its 36 schema ids as any manifest does.

The data closure is `ibus-web-m17n-db`, ibus-m17n's `default.xml` and the compiled schemas: three archives,
{{dataBytes}} bytes installed and {{brotliBytes}} as Brotli. `m17n.wasm` is {{wasmBytes}} bytes.

The licence is `GPL-2.0-or-later AND LGPL-2.1-or-later`: ibus-m17n's, and that of m17n-lib, linked into the module, and
of m17n-db, its data.
```

Replace each `{{…}}` with Step 8's value, bytes written with thousands separators. Then:

```bash
nix develop -c oxfmt docs/m17n.md
grep -n '{{' docs/m17n.md
```

Expected: the grep prints nothing.

- [ ] **Step 10: Run the checks**

```bash
nix build .#checks.x86_64-linux.m17n-data-closure .#checks.x86_64-linux.m17n-imports .#checks.x86_64-linux.m17n-descriptors -L
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
nix develop -c git add engines/m17n/dist.nix engines/m17n/overlay.nix docs/m17n.md
nix develop -c git commit -m "feat(m17n): build the module's distribution" -- engines/m17n/dist.nix engines/m17n/overlay.nix docs/m17n.md
```

---

### Task 2: `m17n-host`

**Files:**
- Modify: `packages/worker-host/test/engines/page-session.ts`
- Create: `packages/worker-host/test/engines/m17n.test.ts`, `engines/m17n/checks/host/checks.nix`
- Modify: `engines/m17n/dist.nix` (the measured `heapBytes`)
- Docs: `docs/m17n.md`

**Interfaces:**
- Consumes: `packages.ibus-web-m17n-dist`; `PageSession`, `nodeHarness`; the module-test JSON (`suite`, `dists`, `heapBytes`, `poolBase`, `texts`).
- Produces: `checks.m17n-host`; `PageSession.press(ic, keyval, keycode): Promise<{ handled: boolean; records: DecodedRecord[] }>`.

- [ ] **Step 1: Let the test page send a key the engine may decline**

In `packages/worker-host/test/engines/page-session.ts`, replace `request` with:

```ts
  async request(ic: number, request: Request, ret = 0): Promise<DecodedRecord[]> {
    const reply = await this.exchange(ic, request);
    expect(reply.ret, request._tag).toBe(ret);
    return reply.records;
  }

  private async exchange(ic: number, request: Request): Promise<{ ret: number; records: DecodedRecord[] }> {
    this.host.client.page.post(encodeRequest(ic, request), ReqMode.sync);
    const reply = await this.host.client.page.waitForReply();
    return { ret: reply.ret, records: this.checkRecords(reply.outSeq) };
  }
```

and add after `key`:

```ts
  // A key as the router sends it, whether or not the engine takes it: a
  // declined press is one the browser still acts on.
  async press(ic: number, keyval: number, keycode: number): Promise<{ handled: boolean; records: DecodedRecord[] }> {
    const press = await this.exchange(ic, new ProcessKeyEvent({ keyval, keycode, state: 0 }));
    expect([0, 1], "ProcessKeyEvent").toContain(press.ret);
    const release = await this.request(ic, new ProcessKeyEvent({ keyval, keycode, state: 1 << 30 }), 0);
    return { handled: press.ret === 1, records: [...press.records, ...release] };
  }
```

- [ ] **Step 2: Write the suite**

Create `packages/worker-host/test/engines/m17n.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  CreateEngine,
  IBusAttrType,
  Init,
  PROTOCOL_VERSION,
  SetSurroundingText,
  SettingChanged,
  encodeRequest,
  int32Variant,
  stringVariant,
  type DecodedRecord,
  type OutputRecord,
} from "@ibus-web/protocol";
import { afterAll, afterEach, describe, expect, inject, test } from "vitest";
import { nodeHarness } from "../node/harness.ts";
import { PageSession, type SessionOptions } from "./page-session.ts";

const h = await nodeHarness();
const build = inject("module");
const manifest = build.manifests["m17n"]!;
afterAll(() => h.cleanUp());

type Values = Init["settings"][number]["values"];

// ibus-m17n opens its relocatable schema at each engine's own path, and an
// input method's variables live below it.
const enginePath = (engine: string) => `/org/freedesktop/ibus/engine/${engine.split(":").join("/")}/`;
const variablesPath = (engine: string) => `${enginePath(engine)}variables/`;

const metadata = JSON.parse(build.texts["settings"]!) as { schemas: { id: string; paths: string[] }[] };
const declared = new Set(metadata.schemas.flatMap(({ paths }) => paths));

// Every instance the metadata declares, as the page sends them: the given
// values at their paths and nothing stored anywhere else.
const instances = (values: Readonly<Record<string, Values>> = {}): Init["settings"] => {
  for (const path of Object.keys(values)) expect(declared.has(path), path).toBe(true);
  return metadata.schemas.flatMap(({ id, paths }) =>
    paths.map((path) => ({ schemaId: id, path, values: values[path] ?? {} })),
  );
};
const options = (engine: string, values?: Readonly<Record<string, Values>>): SessionOptions => ({
  settings: instances(values),
  engine,
});

// Evdev codes of the keys typed here, whose keysyms are their code points.
const keycodes: Readonly<Record<string, number>> = {
  " ": 57,
  "'": 40,
  a: 30,
  e: 18,
  f: 33,
  h: 35,
  i: 23,
  j: 36,
  k: 37,
  o: 24,
  t: 20,
  v: 47,
};

const last = <Tag extends OutputRecord["_tag"]>(
  records: DecodedRecord[],
  tag: Tag,
): Extract<OutputRecord, { _tag: Tag }> => {
  const record = records.filter(({ record }) => record._tag === tag).at(-1)?.record;
  expect(record, tag).toBeDefined();
  return record as Extract<OutputRecord, { _tag: Tag }>;
};
const committed = (records: DecodedRecord[]): string =>
  records.map(({ record }) => (record._tag === "CommitText" ? record.text.text : "")).join("");
const attribute = (records: DecodedRecord[], type: number): number | undefined =>
  last(records, "UpdatePreeditText").text.attrs.attributes.find((attribute) => attribute.type === type)?.value;

// What a field holds after typing: the engine's commits, and each key it
// declines inserted as the browser would.
const typeText = async (session: PageSession, ic: number, text: string) => {
  let field = "";
  const records: DecodedRecord[] = [];
  for (const character of text) {
    const key = await session.press(ic, character.codePointAt(0)!, keycodes[character]!);
    records.push(...key.records);
    field += committed(key.records);
    if (!key.handled) field += character;
  }
  return { field, records };
};

// Init travels in one request, and the transport's default slot is 64 KiB.
test("Init with every declared instance fits one request", () => {
  const settings = instances();
  const bytes = encodeRequest(0, new Init({ version: PROTOCOL_VERSION, settings })).byteLength;
  h.record("m17n Init", { instances: settings.length, bytes });
  expect(bytes).toBeLessThan(64 * 1024);
});

describe.each(h.data.runtimes)("m17n through $name host", (runtime) => {
  let current: PageSession | undefined;
  let breakPeak = 0;
  const start = async (engine: string, values?: Readonly<Record<string, Values>>): Promise<PageSession> => {
    const begin = performance.now();
    current = await PageSession.start(h, runtime, manifest, options(engine, values));
    h.record(`m17n ${runtime.name} start`, { ms: performance.now() - begin });
    return current;
  };
  afterEach(async () => {
    const running = current;
    current = undefined;
    if (running === undefined) return;
    try {
      const stats = await running.stats();
      breakPeak = Math.max(breakPeak, stats.breakPeak);
      expect(stats.activeThreadsAtRuntimeStart).toBe(0);
      expect(stats.activeThreadsPeak).toBe(0);
      expect(stats.breakPeak).toBeGreaterThan(0);
      expect(stats.breakPeak).toBeLessThanOrEqual(build.heapBytes);
      expect(stats.poolWorkersPeak).toBeLessThanOrEqual(build.poolBase + manifest.threads);
    } finally {
      await running.host.terminate();
    }
  });
  afterAll(() => h.record(`m17n ${runtime.name} suite peaks`, { breakPeak, heapBytes: build.heapBytes }));

  test("t:latn-post composes á from a and ' and commits it with the Space", async () => {
    const session = await start("m17n:t:latn-post");
    expect(last((await typeText(session, 1, "a")).records, "UpdatePreeditText").text.text).toBe("a");
    expect(last((await typeText(session, 1, "'")).records, "UpdatePreeditText").text.text).toBe("á");
    expect((await typeText(session, 1, " ")).field).toBe("á ");
  });

  test("hi:inscript commits क for k", async () => {
    const session = await start("m17n:hi:inscript");
    expect((await typeText(session, 1, "k")).field).toBe("क");
  });

  test("vi:telex composes việt and commits it with the Space", async () => {
    const session = await start("m17n:vi:telex");
    expect((await typeText(session, 1, "vieetj ")).field).toBe("việt ");
  });

  test("vi:telex puts the tone of oa on the first vowel by default", async () => {
    const session = await start("m17n:vi:telex");
    expect((await typeText(session, 1, "hoaf ")).field).toBe("hòa ");
  });

  test("a variable's value from Init reaches the input method", async () => {
    const session = await start("m17n:vi:telex", {
      [variablesPath("m17n:vi:telex")]: { "tone-mark-on-last": int32Variant(1) },
    });
    expect((await typeText(session, 1, "hoaf ")).field).toBe("hoà ");
  });

  test("th:kesmanee takes a tone mark only after the consonant before the caret", async () => {
    const session = await start("m17n:th:kesmanee");
    expect((await typeText(session, 1, "h")).field).toBe("");

    await session.request(
      1,
      new SetSurroundingText({
        text: { attachments: {}, text: "ก", attrs: { attachments: {}, attributes: [] } },
        cursor: 1,
        anchor: 1,
      }),
    );
    expect((await typeText(session, 1, "h")).field).toBe("้");
  });

  test("zh:cangjie lists 日 and 曰 for a and commits 日 with the Space", async () => {
    const session = await start("m17n:zh:cangjie");
    const shown = last((await typeText(session, 1, "a")).records, "UpdateLookupTable");
    expect(shown.visible).toBe(true);
    expect(shown.table.candidates.slice(0, 2).map(({ text }) => text)).toEqual(["日", "曰"]);
    expect((await typeText(session, 1, " ")).field).toBe("日");
  });

  test("Init's value at one engine's path reaches that engine and no other", async () => {
    const session = await start("m17n:t:latn-post", {
      [enginePath("m17n:t:latn-post")]: { "preedit-foreground": stringVariant("#ff0000") },
    });
    await session.create(2, "m17n:vi:telex");
    expect(attribute((await typeText(session, 1, "a")).records, IBusAttrType.Foreground)).toBe(0xff0000);
    expect(attribute((await typeText(session, 2, "vieetj")).records, IBusAttrType.Foreground)).toBeUndefined();
  });

  test("a change at one engine's path reaches that engine's context and no other's", async () => {
    const session = await start("m17n:t:latn-post");
    await session.create(2, "m17n:vi:telex");
    expect(attribute((await typeText(session, 1, "a")).records, IBusAttrType.Underline)).toBe(0);

    const changed = await session.request(
      0,
      new SettingChanged({ path: enginePath("m17n:t:latn-post"), key: "preedit-underline", value: int32Variant(1) }),
    );
    expect(changed.some(({ record }) => record._tag === "SettingWritten")).toBe(false);

    expect(attribute((await typeText(session, 1, "'")).records, IBusAttrType.Underline)).toBe(1);
    expect(attribute((await typeText(session, 2, "vieetj")).records, IBusAttrType.Underline)).toBe(0);
  });

  test("what an engine emits while being made reaches the context it is made for", async () => {
    const session = await start("m17n:t:latn-post");
    const records = (await session.request(2, new CreateEngine({ name: "m17n:hi:inscript" }))).filter(
      ({ record }) => record._tag !== "Log",
    );
    expect(records.length).toBeGreaterThan(0);
    expect(records.map(({ ic }) => ic)).toEqual(records.map(() => 2));
  });

  // The declaration has to hold the worst a page can do: every engine open at once.
  test("every engine open in one Worker stays within the declared break", async () => {
    const session = await start("m17n:t:latn-post");
    for (const [index, { name }] of manifest.engines.entries()) await session.create(index + 2, name);
    for (let ic = 1; ic <= manifest.engines.length + 1; ic++) await typeText(session, ic, "a");

    const stats = await session.stats();
    h.record(`m17n ${runtime.name} every engine`, {
      engines: manifest.engines.length,
      breakPeak: stats.breakPeak,
      heapBytes: build.heapBytes,
    });
    expect(stats.breakPeak).toBeLessThanOrEqual(build.heapBytes);
  });
});
```

The expectations for `t:latn-post`, `hi:inscript`, `vi:telex` (`vieetj `), `th:kesmanee` with ก and `zh:cangjie` are the spike's measured outputs; `hoaf ` → `hoà ` with the variable at 1 is `m17n-golden`'s verified case. `hoaf ` → `hòa ` at the default and the rejected tone mark follow from `vi-telex.mim`'s and `th-kesmanee.mim`'s own rules.

- [ ] **Step 3: Write the check**

Create `engines/m17n/checks/host/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) runtime testing typescript;
      dist = config.packages.ibus-web-m17n-dist;
    in
    {
      checks.m17n-host = testing.vitestCheck {
        name = "m17n-host";
        packageDir = "${typescript.workspaceFor [ "packages/worker-host" ]}/packages/worker-host";
        env = {
          IBUS_WEB_WORKER_HOST_TESTS = config.checks.worker-host-node.manifest;
          IBUS_WEB_MODULE_TESTS = pkgs.writeText "ibus-web-m17n-host-tests.json" (
            builtins.toJSON {
              suite = "m17n";
              dists.m17n = "${dist}";
              inherit (dist) heapBytes;
              poolBase = runtime.threadPool.size;

              # The suite declares every instance the metadata lists, as the page does.
              texts.settings = "${dist}/settings.json";
            }
          );
        };
        inBrowsers = false;
        limit = 600;
      };
    };
}
```

- [ ] **Step 4: Run it**

```bash
nix develop -c git add packages/worker-host/test/engines engines/m17n/checks/host
out=$(nix build .#checks.x86_64-linux.m17n-host --no-link --print-out-paths -L)
grep -E 'm17n Init:|m17n (asserting|released) (start|suite peaks|every engine):' "$out/output.txt"
```

Expected: PASS, 1 + 11 × 2 = 23 tests. The grep prints the `Init` size, each start's milliseconds, each runtime's every-engine break and each runtime's suite peaks.

A failure that contradicts an expectation drawn from the `.mim` rules (`hòa ` at the default, the rejected tone mark) is a fact about m17n, not a bug to work around: read the input method's rules again, correct the expectation, and describe the corrected behaviour where Step 6's docs do. A failure on `breakPeak <= heapBytes` means 32 MiB is too small: set `heapBytes = 64 * 1024 * 1024;` for the measuring run, then Step 5 sets the real figure. Any other failure (a warning `Log`, records off the new context during `CreateEngine`, a change reaching `vi:telex`) is a defect in phase 2's runtime or module: fix it there, in a commit of its own, before going on.

Run the other module suites too, since `page-session.ts` changed: `nix build .#checks.x86_64-linux.mozc-host .#checks.x86_64-linux.hangul-host .#checks.x86_64-linux.table-host -L`. Expected: PASS.

- [ ] **Step 5: Declare the measured program break**

From Step 4's `suite peaks` lines take `{{peakAsserting}}` and `{{peakReleased}}` (each runtime's `breakPeak`, which the every-engine case sets). Compute `{{heapMiB}}` = ceil(max of the two / 1,048,576) + 4. In `engines/m17n/dist.nix`, replace

```nix
        # A test program with all 197 engines open peaks at about 26.5 MB
        # under Node; the declaration leaves several MiB above that, and the
        # manifest builder adds headroom after it.
        threads = 0;
        heapBytes = 32 * 1024 * 1024;
```

(or the 64 MiB measuring figure) with

```nix
        # m17n-host peaks at {{peakAsserting}} bytes asserting and
        # {{peakReleased}} released with every engine open in one Worker; the
        # declaration leaves several MiB above that, and the manifest builder
        # adds headroom after it.
        threads = 0;
        heapBytes = {{heapMiB}} * 1024 * 1024;
```

with the placeholders replaced (bytes with commas in the comment). Rerun Step 4's commands; expected: PASS, with the same peaks within a few pages. Take `{{memoryMiB}}` from `jq '.memory / 1048576' "$(nix build .#ibus-web-m17n-dist --no-link --print-out-paths)/manifest.json"`, `{{startMin}}`/`{{startMax}}` from the rounded least and greatest `start` milliseconds over both runtimes, and `{{instances}}` and `{{initBytes}}` from the `m17n Init` line.

- [ ] **Step 6: Document it**

In `docs/m17n.md`'s Distribution section, after the sentence ending `` `m17n.wasm` is … bytes.``, add:

```markdown
The manifest declares no engine threads and a {{heapMiB}} MiB program break, from `checks.m17n-host`'s peaks of
{{peakAsserting}} bytes asserting and {{peakReleased}} released with every engine open in one Worker; its memory comes
to {{memoryMiB}} MiB.
```

and append to the list in `## Checks`:

```markdown
- `checks.m17n-host` runs the distribution through a Node Worker host and the test page, on each runtime build, with
  `Init` declaring every instance the metadata lists, {{instances}} of them in {{initBytes}} bytes, within the
  transport's 64 KiB request slot. `t:latn-post` composes á and commits it with the Space; `hi:inscript` commits क;
  `vi:telex` makes việt, and puts the tone of `hoaf` on the first vowel unless `tone-mark-on-last` from `Init` puts it
  on the last; `th:kesmanee` refuses a tone mark with nothing before the caret and takes it after the surrounding
  text's ก; `zh:cangjie` lists 日 and 曰 for `a` and commits 日. A relocatable instance's value from `Init`, and a
  `SettingChanged` at `t:latn-post`'s path, reach that engine and not `vi:telex` beside it; what an engine emits while
  being made reaches the context it is made for. Every engine open in one Worker stays within the declared break, with
  no engine threads. It records each start, {{startMin}}–{{startMax}} ms with the data installed from its archive.
```

Replace the placeholders, then `nix develop -c oxfmt docs/m17n.md && grep -n '{{' docs/m17n.md engines/m17n/dist.nix`; expected: the grep prints nothing.

- [ ] **Step 7: Commit**

```bash
nix develop -c git add packages/worker-host/test/engines engines/m17n/checks/host engines/m17n/dist.nix docs/m17n.md
nix develop -c git commit -m "test(m17n): run the distribution through the Worker host and declare its measured break" -- packages/worker-host/test/engines/page-session.ts packages/worker-host/test/engines/m17n.test.ts engines/m17n/checks/host/checks.nix engines/m17n/dist.nix docs/m17n.md
```

---

### Task 3: `@ibus-web/engine-m17n`

**Files:**
- Create: `packages/engines/m17n/package.json`, `packages/engines/m17n/README.md`, `packages/engines/m17n/module.nix`
- Docs: `docs/m17n.md`, `README.md`

**Interfaces:**
- Consumes: `packages.ibus-web-m17n-dist`; `ibusWeb.typescript.npmTarball`; `ibusWeb.lib.spdxExpression`.
- Produces: `ibusWeb.typescript.npmPackages.engine-m17n`, so `legacyPackages.<system>.npm.engine-m17n` and `checks.typescript-npm` include it.

- [ ] **Step 1: Write the package**

Create `packages/engines/m17n/package.json`:

```json
{
  "name": "@ibus-web/engine-m17n",
  "version": "0.0.0",
  "description": "ibus-m17n with every m17n-db input method it offers, for ibus-web: its WebAssembly module, data and manifest.",
  "keywords": [
    "ibus",
    "ime",
    "indic",
    "input-method",
    "m17n",
    "thai",
    "vietnamese",
    "webassembly"
  ],
  "homepage": "https://github.com/synapdeck/ibus-web/blob/master/docs/m17n.md",
  "bugs": "https://github.com/synapdeck/ibus-web/issues",
  "license": "GPL-2.0-or-later AND LGPL-2.1-or-later",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/synapdeck/ibus-web.git",
    "directory": "packages/engines/m17n"
  },
  "files": [
    "dist",
    "LICENSES"
  ],
  "exports": {
    "./package.json": "./package.json",
    "./manifest.json": "./dist/manifest.json",
    "./m17n.wasm": "./dist/m17n.wasm",
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

Create `packages/engines/m17n/module.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb.engines.m17n) package;

      # ibus-m17n's, and those of m17n-lib, linked in, and m17n-db, the data.
      licenses = map (license: license.spdxId) (lib.toList package.meta.license);
    in
    {
      # The module's distribution as dist/, with the licence texts.
      ibusWeb.typescript.npmPackages.engine-m17n = config.ibusWeb.typescript.npmTarball {
        name = "ibus-web-npm-engine-m17n";

        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./README.md
          ];
        };

        files.dist = config.packages.ibus-web-m17n-dist;
        inherit licenses;
        license = config.ibusWeb.lib.spdxExpression package.meta.license;

        # The exports name the rest; the data archives' names are hashes.
        expect = map (id: "LICENSES/${id}.txt") licenses;
      };
    };
}
```

- [ ] **Step 2: Build it to see the size, before the README states it**

```bash
nix develop -c git add packages/engines/m17n/package.json packages/engines/m17n/module.nix
printf '# @ibus-web/engine-m17n\n' > packages/engines/m17n/README.md
nix develop -c git add packages/engines/m17n/README.md
npm=$(nix build .#npm.engine-m17n --no-link --print-out-paths -L)
tar -tzf "$npm"/*.tgz | grep -vE '^package/dist/data/' | sort
stat -c %s "$npm"/*.tgz
```

Expected: PASS; the listing holds `package/LICENSES/GPL-2.0-or-later.txt`, `package/LICENSES/LGPL-2.1-or-later.txt`, `package/README.md`, `package/package.json`, `package/dist/manifest.json`, `package/dist/m17n.wasm` and `package/dist/settings.json`; the size is `{{tarballBytes}}`. A `package.json says …, but its contents are …` failure means Task 1's Step 6 didn't take: fix the licence there, not here.

- [ ] **Step 3: Write the README**

Replace `packages/engines/m17n/README.md` with:

````markdown
# @ibus-web/engine-m17n

[ibus-m17n](https://github.com/ibus/ibus-m17n), the IBus front end of the [m17n](https://www.nongnu.org/m17n/)
input-method library, built for the browser with every m17n-db input method it offers: Indic, South-East Asian,
Vietnamese, Ethiopic, Cyrillic and many other scripts, and general-purpose methods such as Latin postfix diacritics,
197 engines in one module, which runs in one Worker. The package holds no JavaScript: it is the files a host serves
and points ibus-web at, `manifest.json` and the WebAssembly module, data archives and settings metadata it lists.

```ts
import { createIbusWeb } from "ibus-web";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  modules: { m17n: new URL("/ibus-web/engines/m17n/manifest.json", location.href) },
});
await ibus.select("m17n", "m17n:hi:inscript");
```

Each engine keeps ibus-m17n's name, `m17n:<lang>:<name>`; the default is `m17n:t:latn-post`, Latin postfix
diacritics, which works on any keyboard. `ibus.engines("m17n")` lists them with their display names, such as
"Hindi (inscript)", and languages. Each engine's settings live at its own path,
`/org/freedesktop/ibus/engine/m17n/<lang>/<name>/`, and an input method's variables, where it has any, below it at
`variables/`. A variable change reaches engines not yet opened in the module's Worker, and the rest when the module
next starts.

Serve `dist/` as it is: the manifest names its files by relative URL, and the data archives are already
Brotli-compressed, so they must be served without `Content-Encoding: br`. The data is {{brotliMB}} MB compressed and
the module's Worker takes {{memoryMiB}} MiB of memory. Details are in
[docs/m17n.md](https://github.com/synapdeck/ibus-web/blob/master/docs/m17n.md).

`dist/` comes from the Nix build of the module, never from this directory: `nix build .#npm.engine-m17n` packs the
tarball.

Licensed under `GPL-2.0-or-later AND LGPL-2.1-or-later`: ibus-m17n is GPL-2.0-or-later, and m17n-lib, which the module
links, and m17n-db, whose input methods are its data, are LGPL-2.1-or-later. Both texts are in `LICENSES/`.
````

`{{memoryMiB}}` is Task 2's value; `{{brotliMB}}` is Task 1's `{{brotliBytes}}` in MB to one decimal place.

- [ ] **Step 4: Document it**

In `docs/m17n.md`'s Distribution section, append to the licence paragraph:

```markdown
The module ships as `@ibus-web/engine-m17n` (`packages/engines/m17n/`): `nix build .#npm.engine-m17n` copies
`ibus-web-m17n-dist` in as `dist/` and both licence texts into `LICENSES/`, and `npmTarball` fails unless
`package.json`'s `license` is the module's. It exports `manifest.json`, `m17n.wasm`, `settings.json` and `data/*`; the
tarball is {{tarballMB}} MB.
```

and to its `## Checks` list:

```markdown
- `checks.typescript-npm` packs `@ibus-web/engine-m17n` with both licence texts.
```

In the root `README.md`'s packages table, add after the `@ibus-web/engine-table` row Mozc's row, which the table lacks, and m17n's:

```markdown
| [`@ibus-web/engine-mozc`](packages/engines/mozc)     | Mozc with nixpkgs' UT dictionaries: its WebAssembly module, data and manifest, built by Nix |
| [`@ibus-web/engine-m17n`](packages/engines/m17n)     | ibus-m17n with m17n-db's input methods: its WebAssembly module, data and manifest, built by Nix |
```

and in its License section, after the sentence ending `` `unicode.xml`.``, add: `` ibus-m17n is GPL-2.0-or-later; its packed module is `GPL-2.0-or-later AND LGPL-2.1-or-later`, for m17n-lib, linked in, and m17n-db's input methods. ``

Replace the placeholders, then:

```bash
nix develop -c oxfmt docs/m17n.md README.md packages/engines/m17n/README.md
grep -n '{{' docs/m17n.md README.md packages/engines/m17n/README.md
```

Expected: the grep prints nothing.

- [ ] **Step 5: Run the checks**

```bash
nix develop -c git add packages/engines/m17n
nix build .#npm.engine-m17n .#checks.x86_64-linux.typescript-npm .#checks.x86_64-linux.typescript-package-metadata -L
nix develop -c hk check -S reuse
```

Expected: PASS. `typescript-package-metadata` needs the README, a description, keywords and a homepage that is a page of the repository (`docs/m17n.md`); hk's `reuse` step runs `reuse lint`, which `REUSE.toml`'s `package.json` and README annotations satisfy.

- [ ] **Step 6: Commit**

```bash
nix develop -c git add packages/engines/m17n docs/m17n.md README.md
nix develop -c git commit -m "feat(m17n): pack @ibus-web/engine-m17n" -- packages/engines/m17n docs/m17n.md README.md
```

---

### Task 4: m17n in the demo

**Files:**
- Modify: `engines/m17n/dist.nix`, `examples/demo/src/main.ts`, `examples/demo/README.md`
- Create: `examples/demo/test/e2e/m17n.spec.ts`
- Docs: `docs/m17n.md`, `docs/core.md`

**Interfaces:**
- Consumes: `ibusWeb.demo.modules`; the facade's `engines(module)` (`EngineDescriptor { name, displayName, languages, keyboard }`), `settings.schemas(module)` (`{ id, paths, keys }`), `settings.get/set(module, path, key…)`, `debugRestart` behind the Restart module button.
- Produces: the demo rules in the decisions above; `#settings [name='<key>']` controls as the e2e selectors.

- [ ] **Step 1: Write the failing spec**

Create `examples/demo/test/e2e/m17n.spec.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Page } from "playwright/test";
import { expect, test } from "./fixtures.ts";

const field = (page: Page) => page.locator("#input");
const picker = (page: Page) => page.locator("#engine-picker");
const setting = (page: Page, name: string) => page.locator(`#settings [name='${name}']`);

// Typing stays native until the module's Worker and the field's context are
// ready, and a failed attempt can leave a composition that emptying the field
// commits, so attempts repeat until one starts clean and the engine alone
// makes the value.
const probe = async (page: Page, keys: string, value: string) => {
  await expect(async () => {
    await field(page).click();
    await field(page).fill("");
    await page.keyboard.type(keys);
    await expect(field(page)).toHaveValue(value, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await field(page).fill("");
};
const pick = async (page: Page, label: string, keys: string, value: string) => {
  await picker(page).selectOption({ label });
  await probe(page, keys, value);
};
const settingsReady = (page: Page) =>
  expect(page.locator("#settings-state")).toHaveText("Settings ready; changes save automatically.");

test("the picker lists m17n's engines under their languages", async ({ page }) => {
  const option = (group: string, label: RegExp) =>
    picker(page).locator(`optgroup[label='${group}'] option`).filter({ hasText: label });
  await expect(option("m17n · Hindi", /^Hindi \(inscript\)$/)).toHaveCount(1);
  await expect(option("m17n · Vietnamese", /^Vietnamese \(telex\)$/)).toHaveCount(1);
  await expect(option("m17n · Thai", /^Thai \(kesmanee\)$/)).toHaveCount(1);
  await expect(option("m17n", /^latn-post$/)).toHaveCount(1);
});

test("Hindi (inscript) types Devanagari from its keys", async ({ page }) => {
  await pick(page, "Hindi (inscript)", "k", "क");
  await page.keyboard.type("ke");
  await expect(field(page)).toHaveValue("का");
});

test("Vietnamese (telex) composes việt and commits it on Space", async ({ page }) => {
  await pick(page, "Vietnamese (telex)", "vieetj ", "việt ");
  await page.keyboard.type("vieetj");
  await expect(page.locator("[data-ibus-preedit]").filter({ hasText: "iệt" })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(field(page)).toHaveValue("việt ");
});

// The consonant is the field's own text, which reaches the engine only as
// surrounding text; kesmanee refuses a tone mark with nothing before it.
test("Thai (kesmanee) puts a tone mark on the field's consonant", async ({ page }) => {
  await picker(page).selectOption({ label: "Thai (kesmanee)" });
  await expect(async () => {
    await field(page).click();
    await field(page).fill("ก");
    await page.keyboard.type("h");
    await expect(field(page)).toHaveValue("ก้", { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
});

test("the settings form shows the selected engine's own settings and the panel's", async ({ page }) => {
  await pick(page, "Vietnamese (telex)", "vieetj ", "việt ");
  await settingsReady(page);
  await expect(setting(page, "use-us-layout")).toHaveCount(1);
  await expect(setting(page, "tone-mark-on-last")).toHaveCount(1);
  await expect(setting(page, "lookup-table-orientation")).toHaveCount(2);

  await pick(page, "Hindi (inscript)", "k", "क");
  await settingsReady(page);
  await expect(setting(page, "use-us-layout")).toHaveCount(1);
  await expect(setting(page, "tone-mark-on-last")).toHaveCount(0);
  await expect(setting(page, "lookup-table-orientation")).toHaveCount(2);
});

// Telex's input method is already open, so the variable reaches it only once
// the module starts again.
test("a variable saved in the form applies after Restart module", async ({ page }) => {
  test.setTimeout(120_000);
  await pick(page, "Vietnamese (telex)", "hoaf ", "hòa ");
  await settingsReady(page);
  await setting(page, "tone-mark-on-last").fill("1");
  await page.locator("h1").click();
  await expect(page.locator("#settings-state")).toHaveText(
    "Saved; applies to engines not yet opened, and to the rest after Restart module.",
  );

  await page.locator("#restart").click();
  await expect(page.locator("#engine")).toHaveText("ready");
  await probe(page, "hoaf ", "hoà ");
});
```

The two `lookup-table-orientation` controls are the panel's and the selected engine's instance of ibus-m17n's schema; Hindi's inscript has no variables, Vietnamese's telex has `tone-mark-on-last`.

- [ ] **Step 2: Run it to see it fail**

```bash
nix develop -c git add examples/demo/test/e2e/m17n.spec.ts
out=$(nix build .#playwright-integration --no-link --print-out-paths -L) || true
```

Expected: FAIL; every `m17n.spec.ts` test fails in all three browsers (the picker has no m17n engines), and Hangul's, Mozc's and the table module's pass.

- [ ] **Step 3: Serve m17n in the demo**

In `engines/m17n/dist.nix`, add after the `packages.ibus-web-m17n-dist` definition:

```nix

      ibusWeb.demo.modules.m17n = config.packages.ibus-web-m17n-dist;
```

- [ ] **Step 4: Group the picker by language and give engines their own settings**

In `examples/demo/src/main.ts` (as phase 1 left it, with settings addressed by path):

Replace

```ts
let last: Selection | undefined,
  shownSettings: string | undefined,
  restarting = false;
```

with

```ts
let last: Selection | undefined,
  shownSettings: string | undefined,
  shownEngine: string | undefined,
  // Whether some engine of the shown module owns settings, so the form follows the engine too.
  enginesOwnSettings = false,
  restarting = false;
// Each module's engine names, which say which settings paths belong to an engine.
const moduleEngines = new Map<string, readonly string[]>();
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
// A code Intl can't parse keeps its own spelling.
const languageName = (code: string) => {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
};
```

In the `selectionchange` listener, replace

```ts
  if (detail && detail.module !== shownSettings) showSettings(detail.module);
```

with

```ts
  if (detail && (detail.module !== shownSettings || (enginesOwnSettings && detail.engine !== shownEngine)))
    showSettings(detail.module, detail.engine);
```

Replace the whole `loadSettings` function and `showSettings` with:

```ts
// An engine owns the settings at paths holding its name's components as consecutive segments, as
// m17n:hi:inscript owns /org/freedesktop/ibus/engine/m17n/hi/inscript/ and the variables below it.
const ownedBy = (path: string, engine: string) => path.includes(`/${engine.split(":").join("/")}/`);
// m17n gives a variable to the input methods it opens after the change, and opens each engine's once.
const variableSchema = (id: string) => id.startsWith("org.freedesktop.ibus.engine.m17n.");
const loadSettings = async (module: string, engine: string, generation: number) => {
  const schemas = await app.settings.schemas(module);
  if (generation !== settingsGeneration) return;
  const engines = moduleEngines.get(module) ?? [];
  enginesOwnSettings = schemas.some((schema) =>
    schema.paths.some((path) => engines.some((other) => ownedBy(path, other))),
  );
  // Of the paths an engine owns, only the selected engine's are shown.
  const shown = (path: string) => ownedBy(path, engine) || !engines.some((other) => ownedBy(path, other));

  const ids = new Set<string>();
  for (const schema of schemas) {
    const keys = schema.keys.filter(
      (key) => editable.has(key.type) && (schema.id !== panelSchema || panelKeys.has(key.name)),
    );
    const saved = variableSchema(schema.id)
      ? "Saved; applies to engines not yet opened, and to the rest after Restart module."
      : "Saved; applies live and across tabs.";
    for (const path of schema.paths.filter(shown)) {
      for (const key of keys) {
        const label = document.createElement("label");
        label.className = "setting";
        const title = document.createElement("span");
        title.textContent = key.summary || key.name;
        const control = key.choices ? document.createElement("select") : document.createElement("input");
        // Key names repeat across schemas and instances; the first keeps the plain id, later ones are qualified.
        const qualified =
          schema.paths.length > 1
            ? `setting-${schema.id}-${schema.paths.indexOf(path)}-${key.name}`
            : `setting-${schema.id}-${key.name}`;
        control.id = ids.has(`setting-${key.name}`) ? qualified : `setting-${key.name}`;
        ids.add(control.id);
        control.name = key.name;
        if (control instanceof HTMLSelectElement) {
          for (const choice of key.choices!) control.add(new Option(choice, choice));
        } else {
          control.type = key.type === "b" ? "checkbox" : key.type === "i" ? "number" : "text";
          control.required = key.type === "i";
          if (key.range) {
            control.min = scalar(key.range.min);
            control.max = scalar(key.range.max);
          }
        }
        const help = document.createElement("small");
        help.id = `${control.id}-help`;
        help.textContent = `${key.description ? `${key.description} ` : ""}Default: ${scalar(key.default)}${key.range ? `; range: ${scalar(key.range.min)}–${scalar(key.range.max)}` : ""}`;
        control.setAttribute("aria-describedby", help.id);
        const value = await app.settings.get(module, path, key.name);
        if (generation !== settingsGeneration) return;
        display(control, value);
        controls.push({ path, key, control });
        control.addEventListener("change", () => {
          if (!control.reportValidity()) return;
          const value: SettingValue =
            key.type === "b"
              ? booleanVariant((control as HTMLInputElement).checked)
              : key.type === "i"
                ? int32Variant(Number(control.value))
                : stringVariant(control.value);
          control.disabled = true;
          settingsState.textContent = "Saving…";
          void app.settings.set(module, path, key.name, value).then(
            () => {
              control.disabled = false;
              settingsState.textContent = saved;
            },
            (cause: unknown) => {
              control.disabled = false;
              settingsState.textContent = "Save failed";
              failure(`Could not save ${key.name}`, cause);
              void refreshSettings().catch((cause: unknown) => failure("Settings refresh failed", cause));
            },
          );
        });
        label.append(title, control, help);
        form.append(label);
      }
    }
  }
  form.disabled = false;
  settingsState.textContent = "Settings ready; changes save automatically.";
};
const showSettings = (module: string, engine: string) => {
  shownSettings = module;
  shownEngine = engine;
  const generation = ++settingsGeneration;
  controls.length = 0;
  form.disabled = true;
  form.replaceChildren(form.querySelector("legend")!);
  settingsState.textContent = "Loading settings…";
  void loadSettings(module, engine, generation).catch((cause: unknown) => {
    if (generation !== settingsGeneration) return;
    settingsState.textContent = "Settings unavailable";
    failure("Settings initialization failed", cause);
  });
};
```

Compare the body with phase 1's version before replacing it: the only intended differences are the `engine` parameter, the `generation` check after `schemas`, `enginesOwnSettings`, `shown`, `keys` and `saved` computed once per schema, `schema.paths.filter(shown)` and `settingsState.textContent = saved`. If phase 1's version differs elsewhere (a later fix to the form), keep that difference.

In `start`, replace

```ts
    const group = document.createElement("optgroup");
    group.label = module;
    for (const engine of engines) {
      group.append(new Option(engine.displayName, String(choices.length)));
      choices.push({ module, engine: engine.name });
    }
    picker.append(group);
```

with

```ts
    moduleEngines.set(module, engines.map((engine) => engine.name));

    // A module whose engines span languages gets a group per language, in the order its manifest first lists each.
    const byLanguage = new Set(engines.map((engine) => engine.languages[0] ?? "")).size > 1;
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const engine of engines) {
      const language = byLanguage ? (engine.languages[0] ?? "") : "";
      let group = groups.get(language);
      if (group === undefined) {
        group = document.createElement("optgroup");
        group.label = language === "" ? module : `${module} · ${languageName(language)}`;
        groups.set(language, group);
        picker.append(group);
      }
      group.append(new Option(engine.displayName, String(choices.length)));
      choices.push({ module, engine: engine.name });
    }
```

and replace `showSettings(first.module);` with `showSettings(first.module, first.engine);`.

Option values still index `choices`, so `syncPicker` and the picker's `change` handler are unchanged.

- [ ] **Step 5: Run the spec to see it pass**

```bash
nix develop -c git add engines/m17n/dist.nix examples/demo
nix build .#checks.x86_64-linux.example-demo-smoke -L
out=$(nix build .#playwright-integration --no-link --print-out-paths -L)
jq '[.suites[] | select(.file == "m17n.spec.ts") | .specs[].tests[].results[] | select(.status == "passed")] | length' "$out/results.json"
```

Expected: PASS. Every test passes in all three browsers, Hangul's settings cases (`#setting-hangul-keyboard`), Mozc's (`#setting-punctuation-method`) and the table module's form test included; the `jq` count is 18 (6 tests × 3 browsers).

To iterate on the spec alone in a dev shell (after `nix develop -c pnpm install` once), with `page=$(nix build .#demo --no-link --print-out-paths)`:

```bash
nix develop -c bash -c "cd examples/demo && IBUS_WEB_DEMO_PAGE=$page \
  PLAYWRIGHT_BROWSERS_PATH=$(nix eval --raw .#checks.x86_64-linux.example-demo-smoke.PLAYWRIGHT_BROWSERS_PATH) \
  PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 \
  node node_modules/playwright/cli.js test -c test/e2e/playwright.config.ts m17n.spec.ts"
```

The integration check is the authority.

- [ ] **Step 6: Document the demo**

Replace `examples/demo/README.md` with:

````markdown
# The demo

One page for every input method module the repository builds. Its picker lists each module's engines: one group per
module, or one per language for a module whose engines span several languages, as m17n's do.

From inside the checkout, run:

```sh
nix run .#demo
```

The default address is `http://127.0.0.1:5173`. Pass Vite options after `--` to use another port:

```sh
nix run .#demo -- --port 5174
```

Inside `nix develop`, `pnpm --dir examples/demo dev --port 5174` uses the same runtime and module assets. Pick an input
method in the picker; <kbd>Ctrl+Space</kbd> turns input methods off and back on. The checkbox turns ibus-web handling on
or off. While a module starts, the fields accept native input.

The settings form shows the selected module's settings. A setting at a path that holds an engine's name, such as
m17n's `/org/freedesktop/ibus/engine/m17n/hi/inscript/` for `m17n:hi:inscript`, shows only while that engine is
selected. m17n's input-method variables, at `variables/` below an engine's path, reach engines not yet opened in the
module's Worker and the rest after Restart module, as the form says when one is saved.

A module joins the demo when its Nix module sets `ibusWeb.demo.modules.<name>` to its distribution. The page opens on the
default engine of the first module in name order. Each module's end-to-end tests are in `test/e2e/<name>.spec.ts`, with
their helpers beside them.
````

In `docs/core.md`, replace

```
The page lists every engine of every module through `engines(module)` in its picker
and opens on the first module's default engine.
```

with

```
The page lists every engine of every module through `engines(module)` in its picker,
in one group per language for a module whose engines span several, and opens on the
first module's default engine.
```

and replace

```
facade, candidate/property panel and a metadata-driven persistent settings form for
the selected module; its attachment control leaves native input usable while
disabled or starting.
```

with

```
facade, candidate/property panel and a metadata-driven persistent settings form for
the selected module. Of the settings paths that hold an engine's name, as m17n's
per-engine paths do, the form shows only the selected engine's. Its attachment
control leaves native input usable while disabled or starting.
```

In `docs/m17n.md`, add before `## Checks`:

```markdown
## In the browser

The demo serves the distribution beside the other modules. Its picker gives m17n's engines one group per language,
labelled `m17n · <language>` with the language's English name from `Intl.DisplayNames`, in the order the manifest
first lists each; the `t:*` methods, which declare no language, stay under `m17n`. Its settings form shows, of the
paths an engine owns (those holding the engine name's components as consecutive segments), only the selected
engine's: its instance of `org.freedesktop.ibus.engine.m17n` and, where its input method has variables, their schema
at `variables/` below it. The panel's schema, which no engine owns, is always shown. A saved variable reports that it
applies to engines not yet opened and to the rest after Restart module.
```

and append to its `## Checks` list:

```markdown
- The demo serves the distribution, and `examples/demo/test/e2e/m17n.spec.ts` runs in Chromium, Firefox and WebKit:
  m17n's language groups in the picker; Hindi from inscript's keys; Vietnamese composed and committed on Space; a Thai
  tone mark on a consonant already in the textarea, which reaches the engine only as surrounding text; a settings form
  holding the selected engine's instance and variables, not another's; and Telex's `tone-mark-on-last` saved in the
  form and applied after Restart module.
```

Format and check:

```bash
nix develop -c oxfmt docs/m17n.md docs/core.md examples/demo/README.md
nix develop -c hk check -S links
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
nix develop -c git add engines/m17n/dist.nix examples/demo docs/m17n.md docs/core.md
nix develop -c git commit -m "feat(demo): serve m17n, its engines grouped by language and each with its own settings" -- engines/m17n/dist.nix examples/demo/src/main.ts examples/demo/README.md examples/demo/test/e2e/m17n.spec.ts docs/m17n.md docs/core.md
```

---

### Task 5: The module's start from IndexedDB

**Files:**
- Modify: `examples/demo/test/e2e/m17n.spec.ts`
- Docs: `docs/m17n.md`

**Interfaces:**
- Consumes: the demo's `#engine` status and `#restart` button; the facade's `debugRestart`, which starts a fresh Worker over the version's installed data.
- Produces: one JSON line per browser in the Playwright output, `{"metric":"m17n start from IndexedDB, Restart module to ready",…}`.

- [ ] **Step 1: Add the timed restart**

At the top of `examples/demo/test/e2e/m17n.spec.ts`, add `import { cpus } from "node:os";` before the `playwright/test` import, and append:

```ts
// The first start installs the data; a restarted Worker reads it, and every
// input method m17n lists, from IndexedDB. Timed in the page, from the click
// to the module reading ready again.
test("the module starts again from IndexedDB", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  await pick(page, "Hindi (inscript)", "k", "क");
  await expect(page.locator("#engine")).toHaveText("ready");

  const milliseconds = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const state = document.querySelector("#engine")!;
        let left = false;
        const begin = performance.now();
        new MutationObserver((_, observer) => {
          if (state.textContent !== "ready") left = true;
          else if (left) {
            observer.disconnect();
            resolve(performance.now() - begin);
          }
        }).observe(state, { childList: true, characterData: true, subtree: true });
        document.querySelector<HTMLButtonElement>("#restart")!.click();
      }),
  );
  console.log(
    JSON.stringify({
      metric: "m17n start from IndexedDB, Restart module to ready",
      browser: browserName,
      milliseconds,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
    }),
  );
  expect(milliseconds).toBeGreaterThan(0);
  await probe(page, "k", "क");
});
```

- [ ] **Step 2: Run it and read the figures**

```bash
nix develop -c git add examples/demo/test/e2e/m17n.spec.ts
out=$(nix build .#playwright-integration --no-link --print-out-paths -L)
grep -h 'm17n start from IndexedDB' "$out/output.txt"
```

Expected: PASS, 7 m17n tests in each browser, and three JSON lines, one per browser. Take `{{chromium}}`, `{{firefox}}` and `{{webkit}}` as each line's `milliseconds` rounded to whole milliseconds, and `{{cpu}}`/`{{logicalCpus}}` from any line. If the list reporter doesn't echo test stdout into `output.txt`, read the lines from `results.json`: `jq -r '.. | .stdout? // empty | .[]?.text? // empty' "$out/results.json" | grep 'm17n start'`.

- [ ] **Step 3: Document it**

In `docs/m17n.md`'s `## In the browser` section, append:

```markdown
Module init reads about 212 files, 2.5 MB, at every start. In a browser, every start after the first reads them from
IndexedDB. `m17n.spec.ts` restarts the module once its data is installed and times the page from Restart module to
`ready`: {{chromium}} ms in Chromium, {{firefox}} ms in Firefox and {{webkit}} ms in WebKit, under the Nix sandbox's
Playwright on {{cpu}} ({{logicalCpus}} logical CPUs), against {{startMin}}–{{startMax}} ms under Node with the data
installed from its archive. One run each; there is no target until there is a baseline.
```

and in its Playwright bullet in `## Checks`, replace `form and applied after Restart module.` with `form and applied after Restart module; it times a restart from IndexedDB.`

Replace the placeholders (`{{startMin}}`/`{{startMax}}` are Task 2's), then `nix develop -c oxfmt docs/m17n.md && grep -n '{{' docs/m17n.md`; expected: the grep prints nothing.

- [ ] **Step 4: Commit**

```bash
nix develop -c git add examples/demo/test/e2e/m17n.spec.ts docs/m17n.md
nix develop -c git commit -m "test(demo): time m17n's start from IndexedDB in each browser" -- examples/demo/test/e2e/m17n.spec.ts docs/m17n.md
```

---

### Task 6: Record M4 in the docs

**Files:**
- Modify: `docs/engines.md`, `docs/README.md`, `docs/testing.md`, `docs/known-gaps.md`, `docs/specs/2026-09-26-ibus-web-design.md`

**Interfaces:**
- Consumes: the values measured in Tasks 1, 2 and 5, as written in `docs/m17n.md`.

- [ ] **Step 1: `docs/engines.md`**

In the `## m17n` section phase 2 wrote, replace `describes its build, startup, engines, settings and checks.` with `describes its build, startup, engines, settings, distribution, the browser and checks.`, and replace its `sh` block with:

```sh
nix build .#ibus-web-m17n-dist
nix build .#checks.x86_64-linux.m17n-host
```

- [ ] **Step 2: `docs/README.md`**

In the topics table, change the `engines.md` row's "Covers" cell to end `…, Hangul golden tests, the table module, Mozc and m17n` (if phase 2 hasn't already), and in the `m17n.md` row, replace `settings and input-method variables, and the checks` with `settings and input-method variables, the distribution, the browser and the checks`.

- [ ] **Step 3: `docs/testing.md`**

Count the Playwright tests per spec from Task 5's run:

```bash
out=$(nix build .#playwright-integration --no-link --print-out-paths)
jq -r '.suites[] | "\(.file) \(.specs | length)"' "$out/results.json"
```

In the Production Playwright integration section, replace

```
preview configuration with COOP/COEP and runs 15 trusted-input tests in each of
Chromium, Firefox and WebKit (45 total): Hangul's nine and the table module's six.
```

with the counts printed (`{{total}}` their sum, `{{all}}` three times it):

```
preview configuration with COOP/COEP and runs {{total}} trusted-input tests in each of
Chromium, Firefox and WebKit ({{all}} total): Hangul's {{hangul}}, the table module's {{table}}, Mozc's {{mozc}}
and m17n's {{m17n}}.
```

and after the sentence ending `checks that the settings form follows the module.`, add: ``The m17n spec (`m17n.spec.ts`) checks the picker's language groups, types Hindi, Vietnamese and a Thai tone mark on the field's own consonant, checks that the settings form holds only the selected engine's instance, applies a variable after Restart module, and times a restart from IndexedDB.`` If the section's wording already differs (another branch updated it), apply the same counts to its current wording.

- [ ] **Step 4: `docs/known-gaps.md`**

Under `## Engines and page integration`:

- If the list still says `m17n, libpinyin and Rime still need their own audits.`, replace it with `libpinyin and Rime still need their own audits.` (`m17n-cast-audit` covers m17n).
- Append after phase 2's **m17n variable changes that wait for a restart.** item:

```markdown
- **m17n reads every input method at each start.** Listing m17n's input methods parses each `.mim`, so module init
  reads about 212 files, 2.5 MB, at every start: a start from IndexedDB takes {{browserMin}}–{{browserMax}} ms in all
  in the browsers ([m17n.md](m17n.md#in-the-browser)). m17n keeps no index of its own; a cached list, or each input
  method read on first use, would need changes to m17n-lib or ibus-m17n's listing.
```

`{{browserMin}}` and `{{browserMax}}` are the least and greatest of Task 5's three figures.

- [ ] **Step 5: The design spec**

In `docs/specs/2026-09-26-ibus-web-design.md`:

- §10.2's table: change the `engine-m17n` row's Notes cell from `GPL-2.0-or-later` to `GPL-2.0-or-later; packed with m17n-lib and m17n-db as GPL-2.0-or-later AND LGPL-2.1-or-later`.
- §10.2's engine data list: replace ``- **m17n:** `m17n_db`'s output, used directly; it is text data.`` with ``- **m17n:** `ibus-web-m17n-db`, the native `m17n_db` output's `share/m17n` alone, without the `bin/` and `scripts/` that would bring bash and gawk; m17n-lib compiles in its store path as `M17NDIR`. It is text data.``
- §10.3.1's graph: replace `(data: m17n_db)` with `(data: ibus-web-m17n-db)`, keeping the line's column alignment.
- §12's M4 row: replace the Scope cell `m17n: m17n-lib, ibus-m17n, m17n-db delivery` with

  ``**Done.** (`docs/m17n.md`) ibus-m17n 1.4.40 over m17n-lib 1.8.6 with m17n-db 1.8.10's input methods: 197 engines, every input method ibus-m17n lists, in one side module, with their descriptors printed by a program that runs the module's own listing; settings addressed by path from the build to the page, with ibus-m17n's relocatable schema at each engine's path and m17n's 53 variables as 34 generated schemas; IBus's US keymap in libibus-web; `@ibus-web/engine-m17n`, m17n in the demo with its engines grouped by language, and its Playwright integration``

  and the Questions cell `Surrounding text; large data sets` with

  ``Can a real port read and delete surrounding text, can one relocatable schema hold many engines' settings, and can one module carry many engines? All three yes. `th:kesmanee` takes a tone mark only after the consonant the surrounding text gives it, under Node and in each browser's textarea, and `m17n-golden` deletes surrounding text for it. A change at one engine's path reaches that engine's contexts and no other's, and `Init` declares all {{instances}} instances in {{initBytes}} bytes. One Worker holds all 197 engines open within a declared {{heapMiB}} MiB program break, starting in {{startMin}}–{{startMax}} ms under Node with its data installed from Brotli and in {{browserMin}}–{{browserMax}} ms from IndexedDB in the browsers. Playwright types Hindi, Vietnamese and Thai in Chromium, Firefox and WebKit``

  with `{{browserMin}}`/`{{browserMax}}` as in Step 4.
- Verify phase 1's settings-by-path edits to §5.2.5, §6.1.3 and §7.1.4:

```bash
grep -nE 'relocatable schema fails|`SettingChanged` \| schema, key|ENOTSUP` for a relocatable' docs/specs/2026-09-26-ibus-web-design.md
```

  Expected: no output. If it prints a line, phase 1 missed it: report it rather than editing those sections here.
- §5.4 has no m17n-specific statement; leave it.

- [ ] **Step 6: Format and check**

```bash
nix develop -c oxfmt docs/engines.md docs/README.md docs/testing.md docs/known-gaps.md docs/specs/2026-09-26-ibus-web-design.md
grep -n '{{' docs/engines.md docs/README.md docs/testing.md docs/known-gaps.md docs/specs/2026-09-26-ibus-web-design.md
nix develop -c hk check -S links
```

Expected: the grep prints nothing and the link check passes. oxfmt re-pads §12's table; that is expected.

- [ ] **Step 7: Commit**

```bash
nix develop -c git add docs/engines.md docs/README.md docs/testing.md docs/known-gaps.md docs/specs/2026-09-26-ibus-web-design.md
nix develop -c git commit -m "docs: record m17n in the browser and M4 as done" -- docs/engines.md docs/README.md docs/testing.md docs/known-gaps.md docs/specs/2026-09-26-ibus-web-design.md
```

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

`nix flake check` includes `m17n-host`, `engines-settings-metadata`, `typescript-npm`, `typescript-package-metadata`, `example-demo-smoke` and phase 2's m17n checks; `integration-checks` includes the Playwright integration with `m17n.spec.ts`.

- [ ] **Step 3: Report**

Report which commands ran and their results. For anything that failed, give the failing check and its output, fix it in the task it belongs to with a new commit of the same scope (amending nothing), and rerun Step 2.
