# Repository Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize ibus-web's TypeScript packages, tsconfigs, Nix modules, package metadata and front-door docs as `docs/specs/2026-10-07-repo-organization.md` describes, without changing behaviour.

**Architecture:** Every directory containing TypeScript becomes a workspace package with its own dependencies and root-level tsconfigs extending `@ibus-web/tsconfig` presets. Each component's Nix sits beside it with role-named files (`module.nix`, `options.nix`, `checks.nix`, `overlay.nix`, `_<name>.nix`), and `modules/` keeps only shared infrastructure plus `ibusWeb.lib`. Docs are rewritten last against the final layout.

**Tech Stack:** pnpm workspace, TypeScript 7 (tsgo), tsdown, Vitest 5, Effect 4, Nix flake-parts with import-tree, Emscripten, hk, oxfmt/oxlint, REUSE.

## Global Constraints

- Work on branch `typedrat/repo-organization`, cut from `master`. Never touch `codex/table-engine` or `.worktrees/table-engine` before the Phase F hygiene task archives it.
- No behaviour changes: every check that passes on `master` passes after each task. No exported symbol that another workspace package imports is removed except where a task says so.
- Each task ends with all of these passing, run from the repository root:
  - `nix run .#write-files` (then `git status` shows no unexpected generated-file drift)
  - `nix flake check -L`
  - `nix build .#integration-checks -L`
  - `nix develop -c hk check --all`
- Commit with `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths…>` after `nix develop -c git add <paths…>`. Conventional Commits; no attribution lines; stage named paths only, never `git add -A`.
- Every new file starts with the SPDX header `SPDX-FileCopyrightText: 2026 Synapdeck, Inc.` / `SPDX-License-Identifier: MIT OR Apache-2.0` in the file's comment syntax (JSON files that can't carry comments get a `.license` sidecar or a `REUSE.toml` entry). `reuse lint` must pass.
- Moves use `git mv` so history follows the file.
- Generated files (`pnpm-workspace.yaml`, `.github/workflows/ci.yml`, `*.generated.ts`, `packages/protocol/PROTOCOL.md`, `NOTICES/*`, `LICENSES/LicenseRef-xkeyboard-config.txt`) are never edited by hand; change their Nix source and run `nix run .#write-files`.
- Comments explain why, not what; no references to other files' history, plans, PRs or "now/previously" narration. Match the surrounding comment density.
- Markdown is formatted with `nix develop -c oxfmt <file>`. The plan file itself is never formatted: oxfmt rewrites its embedded code and breaks the exact before/after snippets.
- Fixed names other tasks rely on:
  - Preset package `packages/tsconfig`, name `@ibus-web/tsconfig`, presets `base.json`, `dom.json`, `worker.json`, `node.json`, `emscripten-js.json`; WebAssembly declarations at `packages/tsconfig/types/webassembly/index.d.ts`.
  - Tool packages `tools/<name>`, name `@ibus-web/<name>`: `bundle-scan`, `cast-audit`, `engine-manifest`, `gschema`, `ibus-test`, `keysyms`, `vendor-inventory`, `tsconfig-extends`, `assert-dependency`, `expect-results`, `glib-test-gate`, `toolchain-probes`, `emscripten-library-deps`, `pack-licenses`.
  - Component packages `@ibus-web/wasmfs-idb` (`runtime/wasmfs-idb`), `@ibus-web/ibus-runtime` (`runtime/ibus-runtime`), `@ibus-web/emscripten-checks` (`modules/emscripten`), `@ibus-web/testing` (`modules/testing`), `@ibus-web/example-hangul` (`examples/hangul`).
  - Shared Nix helpers under the per-system option `ibusWeb.lib`, declared in `modules/flake/lib.nix`. Defined there: `patchesIn`, `isEmscriptenWasm`, `mesonAllTestsRan`, `emscriptenRoot`, `wasmfsIncludeFlag`, `testLinkFlagsWithoutNodeFs`. Defined by the owning module: `nativeIbusConfig` (`modules/engines/`), `emscriptenTypes` and `libraryDeps` (`tools/emscripten-library-deps/`).

## Phases

| Phase | Tasks | Spec section |
| --- | --- | --- |
| A | TypeScript presets and tsconfig layout | TypeScript: presets, one tsconfig per configuration |
| B | Tools, loose scripts, component packages, example, workspace | TypeScript: tools, component packages, example, workspace |
| C | Nix moves, file roles, helpers, splits, dead options, naming | Nix |
| D | Package internals | TypeScript: inside the packages |
| E | Package metadata and `tools/pack-licenses` | Package metadata; licences in packed packages |
| F | Repository hygiene, front door, documentation | Repository hygiene; documentation |

---
## Phase A: TypeScript presets and tsconfig layout

Phase A introduces `@ibus-web/tsconfig`, points every tsconfig at it, switches hk's type check to build mode so a
package's `tsconfig.json` can be a solution file, and collapses each `packages/*` package's tsconfigs into its root.
Directories that are not packages yet (`modules/*`, `runtime/*`, `tests/playwright`, `tools/*`) only change what they
extend here; Phase B moves or packages them.

Facts this phase relies on, checked against TypeScript 7.0.2 (`tsc` in the dev shell):

- `tsc -b --noEmit tsconfig.json` builds a solution file (`"files": []` plus `references`) and reports every referenced
  config's errors, including configs that don't set `composite`, and configs that emit. It writes a
  `<config>.tsbuildinfo` beside each referenced config.
- A referenced config may not reference another `noEmit` config (TS6310), so configs never reference each other; a test
  config `include`s the source directories it needs instead, as the subfolder configs do today.
- A preset can name the WebAssembly declarations in `types` as `@ibus-web/tsconfig/types/webassembly`; the name resolves
  from the compiled project's `node_modules`, not the preset's.

### Task A1: Add `@ibus-web/tsconfig` and point every tsconfig at its presets

**Files:**

- Create: `packages/tsconfig/package.json`, `packages/tsconfig/base.json`, `packages/tsconfig/dom.json`,
  `packages/tsconfig/worker.json`, `packages/tsconfig/node.json`, `packages/tsconfig/emscripten-js.json`,
  `packages/tsconfig/tsconfig.json`
- Move: `types/webassembly/index.d.ts` → `packages/tsconfig/types/webassembly/index.d.ts`
- Delete: `tsconfig.base.json`, `tsconfig.emscripten-js.json`, `tsconfig.node-scripts.json`, `types/tsconfig.json`
- Modify (`extends` and type roots only): every tsconfig listed in Step 4
- Modify: `package.json`, `packages/{core,ibus-web,panel,protocol,test-programs,worker-host}/package.json`,
  `examples/hangul/package.json`, `runtime/wasmfs-idb/package.json`, `modules/glib/checks/tests/package.json`,
  `pnpm-lock.yaml`
- Modify: `modules/typescript/options.nix`, `modules/typescript/default.nix`, `modules/engines/cast-audit.nix`,
  `modules/engines/ibus-test.nix`, `runtime/libibus-web/checks.nix`, `runtime/wasmfs-idb/types.nix`,
  `modules/testing/default.nix`
- Modify: `modules/flake/tsconfig-extends.ts`

**Interfaces:**

- Produces: workspace package `@ibus-web/tsconfig` at `packages/tsconfig` with presets `base.json`, `dom.json`,
  `worker.json`, `node.json`, `emscripten-js.json`, extended as `"@ibus-web/tsconfig/<preset>.json"`. `node.json`'s
  `types` are `["node", "@ibus-web/tsconfig/types/webassembly"]`; a config that sets its own `types` and needs the
  WebAssembly declarations lists that same name.
- Produces: per-system option `ibusWeb.typescript.presets` (a package: the `packages/tsconfig` directory), for Nix
  builds that type-check sources outside the pnpm workspace. Such a build copies it to
  `<tree root>/node_modules/@ibus-web/tsconfig`.
- Produces: `base.json` sets `noEmit: true` and `allowImportingTsExtensions: true`; a config that emits turns both off.

- [ ] **Step 1: Create the branch**

```bash
git switch -c typedrat/repo-organization master
```

Expected: `Switched to a new branch 'typedrat/repo-organization'`.

- [ ] **Step 2: Create the presets package**

`packages/tsconfig/package.json`:

```json
{
  "name": "@ibus-web/tsconfig",
  "private": true,
  "devDependencies": {
    "@types/node": "catalog:"
  }
}
```

`packages/tsconfig/base.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The repository's standard compiler options; every other preset extends
// this. tsc only checks: bundlers and Node's type stripping produce the
// JavaScript, so emit is off unless a config turns it back on.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "rewriteRelativeImportExtensions": true,
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "noEmit": true,
    "allowImportingTsExtensions": true
  }
}
```

`packages/tsconfig/dom.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Code that runs on a page, and tests that run in a browser.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./base.json",
  "compilerOptions": {
    "lib": ["es2023", "dom"],
    "types": []
  }
}
```

`packages/tsconfig/worker.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Code that runs in a dedicated Worker. A config whose code waits on shared
// memory adds es2024.sharedmemory to lib.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./base.json",
  "compilerOptions": {
    "lib": ["es2023", "webworker"],
    "types": []
  }
}
```

`packages/tsconfig/node.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Code Node runs with its types stripped: tools, Node tests, and build and
// test configuration.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./base.json",
  "compilerOptions": {
    // Explicit, because the default for the target includes DOM.
    "lib": ["es2023"],
    // The WebAssembly declarations are what Node has but @types/node doesn't
    // declare. The name resolves from the project's node_modules, so every
    // package extending this lists @ibus-web/tsconfig as a dependency.
    "types": ["node", "@ibus-web/tsconfig/types/webassembly"]
  }
}
```

`packages/tsconfig/emscripten-js.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// For JavaScript Emscripten reads (--js-library, --pre-js, --post-js): it
// bundles these files into its own output as written, as scripts, so they
// are checked as such rather than as Node modules. Its output runs in
// Workers, which each config extending this one may widen to Node. The
// library is the base's target: what Baseline Widely available and the
// oldest supported Node both have, which every engine that runs the output
// does.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./base.json",
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "module": "preserve",
    "moduleResolution": "bundler",
    "lib": ["es2023", "webworker"],
    "types": []
  }
}
```

`packages/tsconfig/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Type-checks the declarations on their own. They are included by path:
// a package's node_modules doesn't link the package itself, so node.json's
// name for them doesn't resolve here.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./node.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["types"]
}
```

```bash
mkdir -p packages/tsconfig/types
git mv types/webassembly packages/tsconfig/types/webassembly
git rm -q types/tsconfig.json tsconfig.base.json tsconfig.emscripten-js.json tsconfig.node-scripts.json
```

- [ ] **Step 3: Declare the dependency**

Add `"@ibus-web/tsconfig": "workspace:*"` to `devDependencies` (creating the object where a manifest has none, keeping
keys sorted) in:

- `package.json` (the root, for the directories under `modules/`, `runtime/ibus-runtime`, `tests/` and `tools/` that
  aren't packages yet and resolve the presets from the root's `node_modules`)
- `packages/core/package.json`, `packages/ibus-web/package.json`, `packages/panel/package.json`,
  `packages/protocol/package.json`, `packages/test-programs/package.json`, `packages/worker-host/package.json`
- `examples/hangul/package.json`
- `runtime/wasmfs-idb/package.json`
- `modules/glib/checks/tests/package.json`

Not `tools/package.json`: the Nix builds that run tools from a hand-assembled tree link `tools/node_modules` from the
shared install, where a workspace link would dangle, so tools resolve the presets from the tree's root instead (Step 6).

Run: `nix develop -c pnpm install`
Expected: exit 0; `pnpm-lock.yaml` gains `'@ibus-web/tsconfig': link:...` entries for each importer above and an
importer `packages/tsconfig` with `@types/node`.

- [ ] **Step 4: Point every tsconfig at a preset**

Change `extends` as listed. Leave every other option alone except where the row says otherwise.

| File                                                                                                                                                                             | New `extends`                           | Also                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/core/tsconfig.base.json`                                                                                                                                               | `@ibus-web/tsconfig/base.json`          |                                                                                        |
| `packages/ibus-web/tsconfig.base.json`                                                                                                                                           | `@ibus-web/tsconfig/base.json`          |                                                                                        |
| `packages/panel/tsconfig.base.json`                                                                                                                                              | `@ibus-web/tsconfig/base.json`          |                                                                                        |
| `packages/protocol/tsconfig.base.json`                                                                                                                                           | `@ibus-web/tsconfig/base.json`          | drop `exactOptionalPropertyTypes` (the preset sets it)                                 |
| `packages/test-programs/tsconfig.base.json`                                                                                                                                      | `@ibus-web/tsconfig/base.json`          | add `"noEmit": false, "allowImportingTsExtensions": false` (it emits `dist/`)          |
| `packages/worker-host/tsconfig.base.json`                                                                                                                                        | `@ibus-web/tsconfig/base.json`          |                                                                                        |
| `packages/{core,ibus-web,panel,protocol,test-programs,worker-host}/tsconfig.json`                                                                                                | `@ibus-web/tsconfig/node.json`          |                                                                                        |
| `packages/worker-host/types/tsconfig.check.json`                                                                                                                                 | `@ibus-web/tsconfig/base.json`          |                                                                                        |
| `packages/worker-host/test/node/tsconfig.json`                                                                                                                                   | unchanged (`../../tsconfig.base.json`)  | delete `typeRoots`; `types` becomes `["node", "@ibus-web/tsconfig/types/webassembly"]` |
| `examples/hangul/tsconfig.json`                                                                                                                                                  | `@ibus-web/tsconfig/base.json`          |                                                                                        |
| `modules/emscripten/checks/fixes/tsconfig.json`                                                                                                                                  | `@ibus-web/tsconfig/emscripten-js.json` | delete `typeRoots`; `types` becomes `["node", "@ibus-web/tsconfig/types/webassembly"]` |
| `modules/flake/tsconfig.json`, `modules/toolchain/tsconfig.json`, `modules/typescript/tsconfig.json`, `modules/testing/tsconfig.json`, `modules/glib/checks/tests/tsconfig.json` | `@ibus-web/tsconfig/node.json`          |                                                                                        |
| `modules/testing/gtest-main/tsconfig.json`                                                                                                                                       | `@ibus-web/tsconfig/emscripten-js.json` |                                                                                        |
| `runtime/ibus-runtime/tsconfig.json`                                                                                                                                             | `@ibus-web/tsconfig/emscripten-js.json` |                                                                                        |
| `runtime/ibus-runtime/tests/tsconfig.json`                                                                                                                                       | `@ibus-web/tsconfig/node.json`          |                                                                                        |
| `runtime/wasmfs-idb/tsconfig.json`                                                                                                                                               | `@ibus-web/tsconfig/node.json`          |                                                                                        |
| `runtime/wasmfs-idb/src/tsconfig.json`, `runtime/wasmfs-idb/tests/tsconfig.json`                                                                                                 | `@ibus-web/tsconfig/emscripten-js.json` |                                                                                        |
| `tests/playwright/tsconfig.json`                                                                                                                                                 | `@ibus-web/tsconfig/node.json`          |                                                                                        |
| `tools/tsconfig.json` and `tools/{bundle-scan,cast-audit,engine-manifest,gschema,ibus-test,keysyms,vendor-inventory}/tsconfig.json`                                              | `@ibus-web/tsconfig/node.json`          |                                                                                        |
| `docs/upstream/evidence/idb-sync-calls/tsconfig.json`                                                                                                                            | `@ibus-web/tsconfig/node.json`          |                                                                                        |

`runtime/wasmfs-idb/tests/library-types/tsconfig.json` keeps `"extends": "../../src/tsconfig.json"`. Every other
config in the repository extends one of the configs above by a relative path and is unchanged.

Run: `git grep -n -e tsconfig.node-scripts -e tsconfig.emscripten-js -e '\.\./\.\./\.\./tsconfig' -- '*tsconfig*.json'`
Expected: no output. (The remaining relative `extends` of `tsconfig.base.json` are subfolder configs reaching their own
package's base, which Tasks A3–A6 delete.)

- [ ] **Step 5: Change the `tsconfig-extends` rule to reach a preset**

Replace `modules/flake/tsconfig-extends.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Fails unless every tsconfig*.json git tracks reaches one of
// @ibus-web/tsconfig's presets through `extends`, so every config shares
// the repository's standard options.
//
//   tsconfig-extends.ts
//     Run from the repository root.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

const presetPackage = "@ibus-web/tsconfig";
const presetDirectory = path.resolve("packages/tsconfig");

// tsconfig files are JSON with comments and trailing commas.
const parseJsonc = (text: string): unknown => {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const [{ error, offset }] = errors as [ParseError];
    throw new Error(`${printParseErrorCode(error)} at offset ${offset}`);
  }
  return value;
};

// Where a relative `extends` leads, as tsc resolves it: the path as written
// if that file exists, else with `.json` added.
const resolveExtends = (from: string, name: string) => {
  const resolved = path.resolve(path.dirname(from), name);
  if (existsSync(resolved) || resolved.endsWith(".json")) return resolved;
  return `${resolved}.json`;
};

// The configs `file` extends, as paths; a package name, which this can't
// follow, is kept as written.
const extendsOf = (file: string): string[] => {
  const config = parseJsonc(readFileSync(file, "utf8")) as { extends?: string | string[] };
  const named = config.extends === undefined ? [] : [config.extends].flat();
  return named.map((name) =>
    name.startsWith("./") || name.startsWith("../") || path.isAbsolute(name) ? resolveExtends(file, name) : name,
  );
};

const isPreset = (parent: string) =>
  parent.startsWith(`${presetPackage}/`) || (path.isAbsolute(parent) && path.dirname(parent) === presetDirectory);

const reachesPreset = (file: string, seen = new Set<string>()): boolean => {
  if (seen.has(file)) return false;
  seen.add(file);
  return extendsOf(file).some((parent) => isPreset(parent) || (path.isAbsolute(parent) && reachesPreset(parent, seen)));
};

const files = execFileSync("git", ["ls-files", "-z", "--", "*tsconfig*.json"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file !== "");

const failures = files.filter((file) => {
  try {
    return !reachesPreset(path.resolve(file));
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
});
for (const file of failures) {
  console.error(`${file}: doesn't extend an ${presetPackage} preset, directly or through another config`);
}
if (failures.length > 0) process.exit(1);
```

Run: `nix develop -c node modules/flake/tsconfig-extends.ts`
Expected: no output, exit 0.

Run:

```bash
printf '{ "compilerOptions": {} }\n' > tools/tsconfig.probe.json
git add -N tools/tsconfig.probe.json
nix develop -c node modules/flake/tsconfig-extends.ts; echo "exit=$?"
git rm -q --cached tools/tsconfig.probe.json && rm tools/tsconfig.probe.json
```

Expected: `tools/tsconfig.probe.json: doesn't extend an @ibus-web/tsconfig preset, directly or through another config`
and `exit=1`.

- [ ] **Step 6: Give Nix builds outside the workspace the presets**

In `modules/typescript/options.nix`, after the `tsc` option, add:

```nix
      presets = lib.mkOption {
        type = lib.types.package;
        description = ''
          @ibus-web/tsconfig's presets, for a build that type-checks or compiles
          sources outside the pnpm workspace: it copies this to
          node_modules/@ibus-web/tsconfig at the root of its tree, where every
          config's `extends` finds it.
        '';
      };
```

In `modules/typescript/default.nix`:

1. Delete the two lines in `buildWorkspace`'s fileset and the comment above them:

```nix
              # Every package's tsconfig extends the repository's base.
              fileset = lib.fileset.unions (
                workspaceFiles
                ++ [
                  (root + "/tsconfig.base.json")
                  (root + "/tsconfig.node-scripts.json")
                ]
```

becomes

```nix
              fileset = lib.fileset.unions (
                workspaceFiles
```

2. In `installPhase`, `cp -R package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.node-scripts.json node_modules $out/`
   becomes `cp -R package.json pnpm-workspace.yaml node_modules $out/`.
3. In the `let`, after `rootManifest`, add:

```nix
      presets = lib.fileset.toSource {
        root = root + "/packages/tsconfig";
        fileset = root + "/packages/tsconfig";
      };
```

4. In `ibusWeb.typescript = { ... inherit workspace workspaceFor nodeModules tsc; ... }`, add `presets` to the
   `inherit` list.

In `modules/engines/cast-audit.nix` and `modules/engines/ibus-test.nix`, delete these two fileset entries:

```nix
          ../../tsconfig.base.json
          ../../tsconfig.node-scripts.json
```

and append to the tree's `runCommand` script (after the `ln -s … $out/tools/node_modules` line):

```nix
        chmod u+w $out
        mkdir -p $out/node_modules/@ibus-web
        cp -R ${typescript.presets} $out/node_modules/@ibus-web/tsconfig
```

(`cp -R` from the store leaves `$out` read-only, hence the `chmod`.)

In `runtime/libibus-web/checks.nix` (`inventoryTools`), make the same deletion of `../../tsconfig.base.json` and
`../../tsconfig.node-scripts.json`, and append after its `ln -s` line:

```nix
          chmod u+w $out
          mkdir -p $out/node_modules/@ibus-web
          cp -R ${config.ibusWeb.typescript.presets} $out/node_modules/@ibus-web/tsconfig
```

In `runtime/wasmfs-idb/types.nix`, delete `../../tsconfig.base.json` and `../../tsconfig.emscripten-js.json` from
`sources`, and in `checks.wasmfs-idb-types` change

```nix
            cp -r --no-preserve=mode ${sources} source
            cd source
```

to

```nix
            cp -r --no-preserve=mode ${sources} source
            cd source
            mkdir -p node_modules/@ibus-web
            cp -R ${typescript.presets} node_modules/@ibus-web/tsconfig
```

In `modules/testing/default.nix` (`checks.gtest-main-library`), delete `../../tsconfig.base.json` and
`../../tsconfig.emscripten-js.json` from `sources`, and make the same two-line addition after `cd source`.

- [ ] **Step 7: Format and check**

```bash
nix develop -c hk fix --all
nix run .#write-files
git status --short
```

Expected: only the files this task lists appear as changed; `pnpm-workspace.yaml` is unchanged.

```bash
nix flake check -L
```

Expected: success. If `ibus-web-node-modules` or its `pnpm-deps` fails with `hash mismatch in fixed-output derivation`,
replace `hash` in `pnpmDeps` (`modules/typescript/default.nix`) with the `got:` value and run it again.

```bash
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: both succeed.

- [ ] **Step 8: Commit**

```bash
nix develop -c git add package.json pnpm-lock.yaml packages/tsconfig types tsconfig.base.json tsconfig.emscripten-js.json \
  tsconfig.node-scripts.json packages examples/hangul modules runtime tests tools docs/upstream/evidence
nix develop -c git commit -m "build(typescript): extend shared presets from @ibus-web/tsconfig" -- package.json \
  pnpm-lock.yaml packages/tsconfig types tsconfig.base.json tsconfig.emscripten-js.json tsconfig.node-scripts.json \
  packages examples/hangul modules runtime tests tools docs/upstream/evidence
```

Expected: hk's pre-commit hooks pass and the commit is created.

### Task A2: Type-check each package in build mode

hk's `tsc` step runs one job per directory holding a `tsconfig.json`. A package's `tsconfig.json` becomes a solution
file in the next tasks, which `tsc -p` checks as empty, so the step switches to `tsc -b`. Build mode works on a single
config too, so this lands first and every check stays green.

**Files:**

- Modify: `hk.pkl`
- Modify: `.gitignore`

**Interfaces:**

- Produces: hk's `tsc` step runs `tsc -b --noEmit <dir>/tsconfig.json` and re-runs when any `tsconfig*.json` changes.
  Every package's `tsconfig.json` from here on either is a single config or lists every other config of the package in
  `references`.

- [ ] **Step 1: Switch the step**

In `hk.pkl`, in `["tsc"]`:

- change the glob entry `"**/tsconfig.json",` to `"**/tsconfig*.json",`
- change the last command line `tsc --noEmit -p {{workspace_indicator}}` to `tsc -b --noEmit {{workspace_indicator}}`
- change the comment above the step from

```pkl
  // One job per directory holding a tsconfig.json, over the files it owns;
  // a JavaScript file or the config itself changing re-checks it too.
```

to

```pkl
  // One job per directory holding a tsconfig.json, over the files it owns;
  // a JavaScript file or any of the directory's configs changing re-checks
  // it too. Build mode, because a package's tsconfig.json lists its other
  // configs as references and holds no files itself.
```

- [ ] **Step 2: Ignore build info**

In `.gitignore`, after the `dist/` line, add:

```gitignore
# Written by `tsc -b`, even with --noEmit.
*.tsbuildinfo
```

- [ ] **Step 3: Check**

Run: `nix develop -c hk check --all`
Expected: success; `git status --short` shows no `*.tsbuildinfo`.

Then run the Global Constraints' remaining checks (`nix run .#write-files`, `nix flake check -L`,
`nix build .#integration-checks -L`). Expected: success.

- [ ] **Step 4: Commit**

```bash
nix develop -c git add hk.pkl .gitignore
nix develop -c git commit -m "build(hk): type-check each package in build mode" -- hk.pkl .gitignore
```

### Task A3: Collapse `@ibus-web/core`'s tsconfigs into its root

**Files:**

- Create: `packages/core/tsconfig.page.json`, `packages/core/tsconfig.shared.json`, `packages/core/tsconfig.test.json`,
  `packages/core/tsconfig.test-browser.json`, `packages/core/tsconfig.config.json`
- Rewrite: `packages/core/tsconfig.json`
- Delete: `packages/core/tsconfig.base.json`, `packages/core/src/tsconfig.page.json`,
  `packages/core/src/tsconfig.shared.json`, `packages/core/src/page/tsconfig.json`,
  `packages/core/src/shared/tsconfig.json`, `packages/core/test/browser/tsconfig.json`,
  `packages/core/test/node/tsconfig.json`
- Modify: `packages/core/tsdown.config.ts:10,17`

**Interfaces:**

- Consumes: presets from Task A1, build mode from Task A2.
- Produces: `packages/core/tsconfig.{page,shared,test,test-browser,config}.json`. The five DOM router tests and
  `test/router/dom-support.ts` are listed in `tsconfig.test-browser.json` and excluded from `tsconfig.test.json`; Phase D
  removes both lists when it moves the files into `test/browser/`.

- [ ] **Step 1: Write the new configs**

`packages/core/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Each config checks the files of one environment, so no file sees another
// environment's globals: the page bundle, the key tables both the page and
// the Worker load, the Node tests, the browser tests, and the build's and
// Vitest's configurations.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "files": [],
  "references": [
    { "path": "./tsconfig.page.json" },
    { "path": "./tsconfig.shared.json" },
    { "path": "./tsconfig.test.json" },
    { "path": "./tsconfig.test-browser.json" },
    { "path": "./tsconfig.config.json" }
  ]
}
```

`packages/core/tsconfig.page.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/dom.json",
  "compilerOptions": {
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src/page", "src/connection", "src/router", "src/services", "src/adapters"]
}
```

`packages/core/tsconfig.shared.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/base.json",
  "compilerOptions": {
    "lib": ["es2023"],
    "types": [],
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src/shared", "src/keys"]
}
```

`packages/core/tsconfig.test.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/dom.json",
  "compilerOptions": {
    "types": ["node"],
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["test/keys", "test/connection", "test/router", "test/support"],
  "exclude": [
    "test/router/contexts.test.ts",
    "test/router/preedit.test.ts",
    "test/router/surrounding.test.ts",
    "test/router/content-type.test.ts",
    "test/router/switching.test.ts",
    "test/router/dom-support.ts"
  ]
}
```

`packages/core/tsconfig.test-browser.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/dom.json",
  "compilerOptions": {
    "declaration": true,
    "skipLibCheck": true
  },
  "include": [
    "test/browser",
    "test/router/contexts.test.ts",
    "test/router/preedit.test.ts",
    "test/router/surrounding.test.ts",
    "test/router/content-type.test.ts",
    "test/router/switching.test.ts"
  ]
}
```

`packages/core/tsconfig.config.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The build's and Vitest's configurations, which load from source.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": {
    "skipLibCheck": true
  },
  "files": ["tsdown.config.ts", "vitest.config.ts", "vitest.browser.config.ts"]
}
```

```bash
git rm -q packages/core/tsconfig.base.json packages/core/src/tsconfig.page.json packages/core/src/tsconfig.shared.json \
  packages/core/src/page/tsconfig.json packages/core/src/shared/tsconfig.json \
  packages/core/test/browser/tsconfig.json packages/core/test/node/tsconfig.json
```

`packages/core/test/node/` held only its tsconfig and disappears.

- [ ] **Step 2: Point tsdown at the root configs**

In `packages/core/tsdown.config.ts`, `tsconfig: "src/tsconfig.shared.json",` becomes
`tsconfig: "tsconfig.shared.json",` and `tsconfig: "src/tsconfig.page.json",` becomes `tsconfig: "tsconfig.page.json",`.

- [ ] **Step 3: Verify the build keeps its layout**

Run: `nix build .#checks.x86_64-linux.core -L && nix build --no-link --print-out-paths .#checks.x86_64-linux.core-browser`
Expected: both succeed.

Run:

```bash
nix develop -c bash -c 'cd packages/core && pnpm run build && ls dist/page/index.d.ts dist/shared/index.d.ts'
```

Expected: both paths listed. If tsdown wrote `dist/src/page/index.d.ts` and `dist/src/shared/index.d.ts` instead, add
`"rootDir": "src"` to `compilerOptions` in `tsconfig.page.json` and `tsconfig.shared.json`, rebuild, and confirm the
two paths above. Remove `packages/core/dist` afterwards (`rm -rf packages/core/dist`; it is git-ignored).

Run: `nix develop -c bash -c 'tsc -b --noEmit packages/core/tsconfig.json'`
Expected: exit 0, no output.

- [ ] **Step 4: Check and commit**

Run the Global Constraints' checks. Expected: success; `git status --short` shows no `*.tsbuildinfo`.

```bash
nix develop -c git add packages/core
nix develop -c git commit -m "build(core): keep one tsconfig per configuration at the package root" -- packages/core
```

### Task A4: Collapse `ibus-web`, `@ibus-web/panel` and `@ibus-web/protocol`'s tsconfigs

**Files:**

- `packages/ibus-web`: create `tsconfig.page.json`, `tsconfig.test.json`, `tsconfig.test-browser.json`,
  `tsconfig.config.json`; rewrite `tsconfig.json`; delete `tsconfig.base.json`, `src/tsconfig.json`,
  `test/browser/tsconfig.json`, `test/node/tsconfig.json`; modify `tsdown.config.ts`
- `packages/panel`: create `tsconfig.page.json`, `tsconfig.test-browser.json`, `tsconfig.config.json`; rewrite
  `tsconfig.json`; delete `tsconfig.base.json`, `src/tsconfig.json`, `test/browser/tsconfig.json`; modify
  `tsdown.config.ts`
- `packages/protocol`: create `tsconfig.shared.json`, `tsconfig.test.json`, `tsconfig.config.json`; rewrite
  `tsconfig.json`; delete `tsconfig.base.json`, `src/tsconfig.json`, `test/tsconfig.json`, `scripts/tsconfig.json`;
  modify `tsdown.config.ts`

**Interfaces:**

- Produces: `ibus-web` and `panel` build from `tsconfig.page.json`; `protocol` builds from `tsconfig.shared.json`
  (its sources run on the page and in the Worker, and are checked against the Worker's globals). Protocol's build
  scripts (`scripts/`) are checked by `tsconfig.config.json` with the build configuration: both are Node code that runs
  at build time.

- [ ] **Step 1: `ibus-web`**

`packages/ibus-web/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Each config checks the files of one environment: the page facade, the
// Node tests, the browser tests, and the build's and Vitest's
// configurations.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "files": [],
  "references": [
    { "path": "./tsconfig.page.json" },
    { "path": "./tsconfig.test.json" },
    { "path": "./tsconfig.test-browser.json" },
    { "path": "./tsconfig.config.json" }
  ]
}
```

`packages/ibus-web/tsconfig.page.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/dom.json",
  "compilerOptions": {
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`packages/ibus-web/tsconfig.test.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/dom.json",
  "compilerOptions": {
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["test/node"]
}
```

`packages/ibus-web/tsconfig.test-browser.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/dom.json",
  "compilerOptions": {
    "skipLibCheck": true
  },
  "include": ["test/browser"]
}
```

`packages/ibus-web/tsconfig.config.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The build's and Vitest's configurations, which load from source.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": {
    "skipLibCheck": true
  },
  "files": ["tsdown.config.ts", "vitest.config.ts"]
}
```

In `packages/ibus-web/tsdown.config.ts`, `tsconfig: "src/tsconfig.json",` becomes `tsconfig: "tsconfig.page.json",`.

```bash
git rm -q packages/ibus-web/tsconfig.base.json packages/ibus-web/src/tsconfig.json \
  packages/ibus-web/test/browser/tsconfig.json packages/ibus-web/test/node/tsconfig.json
```

- [ ] **Step 2: `panel`**

`packages/panel/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Each config checks the files of one environment: the panel, its browser
// tests, and the build's and Vitest's configurations.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "files": [],
  "references": [
    { "path": "./tsconfig.page.json" },
    { "path": "./tsconfig.test-browser.json" },
    { "path": "./tsconfig.config.json" }
  ]
}
```

`packages/panel/tsconfig.page.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/dom.json",
  "compilerOptions": {
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`packages/panel/tsconfig.test-browser.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/dom.json",
  "compilerOptions": {
    "skipLibCheck": true
  },
  "include": ["test/browser"]
}
```

`packages/panel/tsconfig.config.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The build's and Vitest's configurations, which load from source.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": {
    "skipLibCheck": true
  },
  "files": ["tsdown.config.ts", "vitest.config.ts"]
}
```

In `packages/panel/tsdown.config.ts`, `tsconfig: "src/tsconfig.json",` becomes `tsconfig: "tsconfig.page.json",`.

```bash
git rm -q packages/panel/tsconfig.base.json packages/panel/src/tsconfig.json packages/panel/test/browser/tsconfig.json
```

- [ ] **Step 3: `protocol`**

`packages/protocol/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Each config checks the files of one environment: the protocol, which the
// page and the Worker both load; its Node tests; and the build-time Node
// code, the configurations and the generator scripts.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "files": [],
  "references": [
    { "path": "./tsconfig.shared.json" },
    { "path": "./tsconfig.test.json" },
    { "path": "./tsconfig.config.json" }
  ]
}
```

`packages/protocol/tsconfig.shared.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/worker.json",
  "compilerOptions": {
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`packages/protocol/tsconfig.test.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": {
    "skipLibCheck": true
  },
  "include": ["test"]
}
```

`packages/protocol/tsconfig.config.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Node code that runs at build time: the build's and Vitest's
// configurations, which load from source, and the scripts that generate
// protocol.h and PROTOCOL.md.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": {
    "skipLibCheck": true
  },
  "include": ["scripts", "tsdown.config.ts", "vitest.config.ts", "vitest.bench.config.ts", "vitest.parity.config.ts"]
}
```

In `packages/protocol/tsdown.config.ts`, `tsconfig: "src/tsconfig.json",` becomes `tsconfig: "tsconfig.shared.json",`.

```bash
git rm -q packages/protocol/tsconfig.base.json packages/protocol/src/tsconfig.json packages/protocol/test/tsconfig.json \
  packages/protocol/scripts/tsconfig.json
```

- [ ] **Step 4: Verify**

```bash
nix develop -c bash -c 'for p in ibus-web panel protocol; do tsc -b --noEmit packages/$p/tsconfig.json || exit 1; done'
nix develop -c bash -c 'pnpm --filter @ibus-web/protocol --filter @ibus-web/panel run build && ls packages/protocol/dist/index.d.ts packages/protocol/dist/transport.d.ts packages/panel/dist/index.d.ts'
```

Expected: no type errors; the three paths listed. If a declaration lands under `dist/src/`, add `"rootDir": "src"` to that
package's build config (`tsconfig.shared.json` or `tsconfig.page.json`) and rebuild. Then
`rm -rf packages/protocol/dist packages/panel/dist`.

Run the Global Constraints' checks. Expected: success.

- [ ] **Step 5: Commit**

```bash
nix develop -c git add packages/ibus-web packages/panel packages/protocol
nix develop -c git commit -m "build(packages): keep one tsconfig per configuration at the package root" -- \
  packages/ibus-web packages/panel packages/protocol
```

### Task A5: Collapse `@ibus-web/test-programs`'s tsconfigs

**Files:**

- Create: `packages/test-programs/tsconfig.shared.json`, `tsconfig.node.json`, `tsconfig.browser.json`,
  `tsconfig.worker.json`, `tsconfig.config.json`
- Rewrite: `packages/test-programs/tsconfig.json`
- Delete: `packages/test-programs/tsconfig.base.json`, `src/{browser,node,shared,worker}/tsconfig.json`
- Modify: `packages/test-programs/package.json` (`scripts.build`)

**Interfaces:**

- Produces: `pnpm run build` in `packages/test-programs` emits `dist/{shared,node,browser,worker}/` exactly as before,
  from `tsc -p tsconfig.<environment>.json`.

- [ ] **Step 1: Write the configs**

`packages/test-programs/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Sources are split by the environment they run in, and each environment
// has its own config, so no file sees another environment's globals:
//
//   tsconfig.node.json     src/node/: Node globals: Vitest's runner, the
//                          browser commands and the test file that runs
//                          programs under Node.
//   tsconfig.browser.json  src/browser/: DOM globals: the test file that
//                          runs programs in a browser.
//   tsconfig.worker.json   src/worker/: WebWorker globals: the Worker a
//                          program runs in.
//   tsconfig.shared.json   src/shared/: no environment's globals, only the
//                          language. The others include it too, so their
//                          imports of it resolve.
//
// An environment statically imports only its own directory and src/shared/;
// the Worker is reached at run time by URL. Each emits to dist/ with the
// layout of src/.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "files": [],
  "references": [
    { "path": "./tsconfig.shared.json" },
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.browser.json" },
    { "path": "./tsconfig.worker.json" },
    { "path": "./tsconfig.config.json" }
  ]
}
```

`packages/test-programs/tsconfig.shared.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/base.json",
  "compilerOptions": {
    "noEmit": false,
    "allowImportingTsExtensions": false,
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["es2023"],
    "types": [],
    // Vitest's declarations name both DOM and Node types, and each
    // environment has only one of them.
    "skipLibCheck": true
  },
  "include": ["src/shared"]
}
```

`packages/test-programs/tsconfig.node.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/base.json",
  "compilerOptions": {
    "noEmit": false,
    "allowImportingTsExtensions": false,
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["es2023"],
    "types": ["node"],
    // Vitest's declarations name both DOM and Node types, and each
    // environment has only one of them.
    "skipLibCheck": true
  },
  "include": ["src/node", "src/shared"]
}
```

`packages/test-programs/tsconfig.browser.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/base.json",
  "compilerOptions": {
    "noEmit": false,
    "allowImportingTsExtensions": false,
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["es2023", "dom"],
    "types": [],
    // Vitest's declarations name both DOM and Node types, and each
    // environment has only one of them.
    "skipLibCheck": true
  },
  "include": ["src/browser", "src/shared"]
}
```

`packages/test-programs/tsconfig.worker.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/base.json",
  "compilerOptions": {
    "noEmit": false,
    "allowImportingTsExtensions": false,
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["es2023", "webworker"],
    "types": [],
    // Vitest's declarations name both DOM and Node types, and each
    // environment has only one of them.
    "skipLibCheck": true
  },
  "include": ["src/worker", "src/shared"]
}
```

`packages/test-programs/tsconfig.config.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Vitest's configuration, which Vitest loads from source.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": {
    "skipLibCheck": true
  },
  "files": ["vitest.config.ts"]
}
```

```bash
git rm -q packages/test-programs/tsconfig.base.json packages/test-programs/src/browser/tsconfig.json \
  packages/test-programs/src/node/tsconfig.json packages/test-programs/src/shared/tsconfig.json \
  packages/test-programs/src/worker/tsconfig.json
```

- [ ] **Step 2: Build from the root configs**

In `packages/test-programs/package.json`, `scripts.build` becomes:

```json
"build": "status=0; for env in shared node browser worker; do tsc -p tsconfig.$env.json || status=1; done; exit $status"
```

- [ ] **Step 3: Verify the output layout**

```bash
nix develop -c bash -c 'cd packages/test-programs && rm -rf dist && pnpm run build && ls dist/node/node-tests.js dist/node/vitest.js dist/worker dist/browser dist/shared >/dev/null && echo layout-ok'
```

Expected: `layout-ok`.

Run the Global Constraints' checks. Expected: success (every `testing.programs` check imports from
`packages/test-programs/dist/node`).

- [ ] **Step 4: Commit**

```bash
nix develop -c git add packages/test-programs
nix develop -c git commit -m "build(test-programs): keep one tsconfig per environment at the package root" -- \
  packages/test-programs
```

### Task A6: Collapse `@ibus-web/worker-host`'s tsconfigs

**Files:**

- Create: `packages/worker-host/tsconfig.shared.json`, `tsconfig.worker.json`, `tsconfig.test.json`,
  `tsconfig.test-browser.json`, `tsconfig.test-shared.json`, `tsconfig.test-worker.json`, `tsconfig.types.json`,
  `tsconfig.config.json`
- Rewrite: `packages/worker-host/tsconfig.json`
- Delete: `packages/worker-host/tsconfig.base.json`, `src/shared/tsconfig.json`, `src/worker/tsconfig.json`,
  `test/browser/tsconfig.json`, `test/node/tsconfig.json`, `test/shared/tsconfig.json`, `test/worker/tsconfig.json`,
  `types/tsconfig.check.json`
- Modify: `packages/worker-host/tsdown.config.ts:53,58,63-66`, `packages/worker-host/package.json` (`scripts.build`)

**Interfaces:**

- Produces: tsdown builds the shared entry from `tsconfig.shared.json`, the Workers from `tsconfig.worker.json` and the
  test Workers from `tsconfig.test-worker.json`. `tsconfig.types.json` checks `types/*.d.ts` against `dist/` after the
  build and is deliberately not referenced from `tsconfig.json`, which hk checks without a build.

- [ ] **Step 1: Write the configs**

`packages/worker-host/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Sources are split by the environment they run in, and each environment
// has its own config, so no file sees another environment's globals:
//
//   tsconfig.shared.json       src/shared/: no environment's globals: what
//                              the page and the host share.
//   tsconfig.worker.json       src/worker/: WebWorker globals: the host's
//                              and the relay's Workers.
//   tsconfig.test-worker.json  test/worker/: WebWorker globals: the host's
//                              test build, instrumented.
//   tsconfig.test-shared.json  test/shared/: no environment's globals: the
//                              scenarios and the page's side of the control
//                              buffer, for either test environment.
//   tsconfig.test.json         test/node/ and test/engines/: Node globals:
//                              the tests under Node, Vitest's
//                              configuration's helpers, and the
//                              worker_threads adapter.
//   tsconfig.test-browser.json test/browser/: DOM globals: the tests in a
//                              browser.
//   tsconfig.config.json       the build's and Vitest's configurations.
//
// tsdown bundles what runs; these configs only check it. tsconfig.types.json
// checks the published declarations against dist/ after a build, so it
// isn't listed here.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "files": [],
  "references": [
    { "path": "./tsconfig.shared.json" },
    { "path": "./tsconfig.worker.json" },
    { "path": "./tsconfig.test.json" },
    { "path": "./tsconfig.test-browser.json" },
    { "path": "./tsconfig.test-shared.json" },
    { "path": "./tsconfig.test-worker.json" },
    { "path": "./tsconfig.config.json" }
  ]
}
```

`packages/worker-host/tsconfig.shared.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/base.json",
  "compilerOptions": {
    "lib": ["es2023"],
    "types": [],
    // tsdown writes the declarations from each file alone.
    "declaration": true,
    "isolatedDeclarations": true,
    "skipLibCheck": true
  },
  "include": ["src/shared"]
}
```

`packages/worker-host/tsconfig.worker.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/worker.json",
  "compilerOptions": {
    // The host waits on the control buffer with Atomics.waitAsync().
    "lib": ["es2023", "es2024.sharedmemory", "webworker"],
    "skipLibCheck": true
  },
  "include": ["src/worker", "src/shared"]
}
```

`packages/worker-host/tsconfig.test-worker.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/worker.json",
  "compilerOptions": {
    "lib": ["es2023", "es2024.sharedmemory", "webworker"],
    "skipLibCheck": true
  },
  "include": ["test/worker", "test/shared", "src/worker", "src/shared"]
}
```

`packages/worker-host/tsconfig.test.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Node runs the tests with worker_threads standing in for Workers, so they
// see Node's globals beside a Worker's.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/worker.json",
  "compilerOptions": {
    "lib": ["es2023", "es2024.sharedmemory", "webworker"],
    "types": ["node", "@ibus-web/tsconfig/types/webassembly"],
    "skipLibCheck": true
  },
  "include": ["test/node", "test/engines", "test/shared", "src/shared"]
}
```

`packages/worker-host/tsconfig.test-browser.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/dom.json",
  "compilerOptions": {
    "lib": ["es2023", "es2024.sharedmemory", "dom"],
    "skipLibCheck": true
  },
  "include": ["test/browser", "test/shared", "src/shared"]
}
```

`packages/worker-host/tsconfig.test-shared.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/base.json",
  "compilerOptions": {
    "lib": ["es2023", "es2024.sharedmemory"],
    "types": [],
    "skipLibCheck": true
  },
  "include": ["test/shared", "src/shared"]
}
```

`packages/worker-host/tsconfig.types.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Checks the Worker entries' declarations against the bundled ones they
// import, so it runs after the build has written dist/.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/base.json",
  "compilerOptions": {
    "lib": ["es2023", "esnext.disposable", "dom"],
    "types": []
  },
  "files": ["types/worker.d.ts", "types/relay.d.ts", "types/usage.ts"]
}
```

`packages/worker-host/tsconfig.config.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The build's and Vitest's configurations, which load from source.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": {
    "skipLibCheck": true
  },
  "files": ["tsdown.config.ts", "vitest.config.ts", "vitest.unit.config.ts"]
}
```

```bash
git rm -q packages/worker-host/tsconfig.base.json packages/worker-host/src/shared/tsconfig.json \
  packages/worker-host/src/worker/tsconfig.json packages/worker-host/test/browser/tsconfig.json \
  packages/worker-host/test/node/tsconfig.json packages/worker-host/test/shared/tsconfig.json \
  packages/worker-host/test/worker/tsconfig.json packages/worker-host/types/tsconfig.check.json
```

- [ ] **Step 2: Point the build at the root configs**

In `packages/worker-host/tsdown.config.ts`:

- `tsconfig: "src/shared/tsconfig.json",` → `tsconfig: "tsconfig.shared.json",`
- every `"src/worker/tsconfig.json"` → `"tsconfig.worker.json"` (three occurrences)
- every `"test/worker/tsconfig.json"` → `"tsconfig.test-worker.json"` (two occurrences)

In `packages/worker-host/package.json`, `scripts.build` becomes
`"rm -rf dist && tsdown && tsc -p tsconfig.types.json"`.

- [ ] **Step 3: Verify**

```bash
nix develop -c bash -c 'tsc -b --noEmit packages/worker-host/tsconfig.json && cd packages/worker-host && pnpm run build && ls dist/shared/index.d.ts dist/worker/index.js dist/worker/relay.js dist/test/worker/host.js && rm -rf dist'
```

Expected: no type errors; the four paths listed. If `dist/shared/index.d.ts` is missing and `dist/shared/src/...` or
`dist/src/shared/...` exists instead, add `"rootDir": "src"` to `tsconfig.shared.json` and rebuild.

Run: `git ls-files packages | grep -E '/tsconfig[^/]*\.json$' | wc -l`
Expected: `35` — tsconfig 1, core 6, ibus-web 5, panel 4, protocol 4, test-programs 6, worker-host 9. (The presets are
named `base.json` and so on, which the pattern doesn't match.)

Every match sits directly in `packages/<name>/`: `git ls-files 'packages/*' | grep -E '/tsconfig[^/]*\.json$' | grep -E '^packages/[^/]+/.+/'`
prints nothing.

Run the Global Constraints' checks. Expected: success.

- [ ] **Step 4: Commit**

```bash
nix develop -c git add packages/worker-host
nix develop -c git commit -m "build(worker-host): keep one tsconfig per environment at the package root" -- \
  packages/worker-host
```

## Phase B: Tools, loose scripts, component packages, the example and the workspace

Phase B makes every directory that holds TypeScript a workspace package and empties the root `package.json`. It changes
Nix only where a moved file is referenced, or where the old single `tools` package was assembled by hand; moving those
Nix modules next to their components is Phase C's work.

Conventions every tool package follows:

- `tools/<name>/package.json` is private, `"type": "module"`, named `@ibus-web/<name>`, and lists exactly the packages
  its files import, plus `@ibus-web/tsconfig` and `@types/node` as devDependencies. A tool whose tests import another
  workspace package's sources by relative path (`../../packages/<pkg>/src/...`) lists that package as a devDependency,
  so `typescript.workspaceFor [ "tools/<name>" ]` builds it into the tool's tree.
- A tool whose tests run with `testing.vitestCheck` has a `vitest.config.ts` and a `"test": "vitest run --configLoader
native"` script. A tool whose tests run through `testing.programs { nodeTests = …; }` has neither: the test-programs
  runner supplies Vitest.
- One `tsconfig.json`, extending `@ibus-web/tsconfig/node.json`, covering `*.ts` in the tool's directory.
- Imports between workspace packages stay relative paths to sources where they are today: Node refuses to strip types
  from files under `node_modules`, so a tool can't import another package's `.ts` sources by package name.

### Task B1: One package per existing tool

**Files:**

- Create: `tools/{bundle-scan,cast-audit,engine-manifest,gschema,ibus-test,keysyms,vendor-inventory}/package.json`
- Create: `tools/{bundle-scan,cast-audit,engine-manifest,gschema,ibus-test,keysyms,vendor-inventory}/vitest.config.ts`
- Rewrite: `tools/{bundle-scan,cast-audit,engine-manifest,gschema,ibus-test,keysyms,vendor-inventory}/tsconfig.json`
- Delete: `tools/package.json`, `tools/tsconfig.json`, `tools/vitest.config.ts`
- Modify: `tools/bundle-scan/scan.ts:87-97`
- Modify: `examples/hangul/package.json` (`@ibus-web/tools` → `@ibus-web/bundle-scan`)
- Modify: `modules/typescript/default.nix` (workspace globs, notice inputs, `--if-present`)
- Modify: `modules/engines/cast-audit.nix`, `modules/engines/ibus-test.nix`, `modules/engines/manifest.nix`,
  `modules/engines/settings-metadata.nix`, `modules/keys.nix`, `modules/playwright.nix`,
  `runtime/libibus-web/checks.nix`, `engines/hangul/checks/differential/default.nix`
- Modify: `pnpm-lock.yaml`, `pnpm-workspace.yaml` (generated)

**Interfaces:**

- Consumes: `@ibus-web/tsconfig` (Task A1).
- Produces: workspace packages `@ibus-web/{bundle-scan,cast-audit,engine-manifest,gschema,ibus-test,keysyms,vendor-inventory}`
  at `tools/<name>`. `pnpm-workspace.yaml` lists `tools/*` instead of `tools`.
- Produces: each tool's Nix-side tree is `typescript.workspaceFor [ "tools/<name>" ]`, and its package directory inside
  that tree is `<tree>/tools/<name>`. `packages.ibus-test-tools` is that tree for `tools/ibus-test`.
- Produces: `buildWorkspace` runs `pnpm -r … run --if-present build`, so a tree of packages without a build script
  builds.

- [ ] **Step 1: Write the vitest configuration each Vitest-run tool shares**

Create this file, byte for byte, as `tools/bundle-scan/vitest.config.ts`, `tools/cast-audit/vitest.config.ts`,
`tools/engine-manifest/vitest.config.ts`, `tools/gschema/vitest.config.ts`, `tools/ibus-test/vitest.config.ts`,
`tools/keysyms/vitest.config.ts` and `tools/vendor-inventory/vitest.config.ts`:

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

```bash
git rm -q tools/vitest.config.ts tools/tsconfig.json tools/package.json
```

- [ ] **Step 2: Write each tool's manifest**

`tools/bundle-scan/package.json`:

```json
{
  "name": "@ibus-web/bundle-scan",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run --configLoader native"
  },
  "dependencies": {
    "@ibus-web/core": "workspace:*",
    "@ibus-web/panel": "workspace:*",
    "@ibus-web/protocol": "workspace:*",
    "@ibus-web/worker-host": "workspace:*",
    "ibus-web": "workspace:*",
    "vite": "catalog:"
  },
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  }
}
```

`tools/cast-audit/package.json`:

```json
{
  "name": "@ibus-web/cast-audit",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run --configLoader native"
  },
  "dependencies": {
    "@microsoft/sarif": "^5.7.0",
    "ajv": "catalog:",
    "jsonc-parser": "catalog:",
    "tree-sitter": "^0.25.1",
    "tree-sitter-c": "^0.24.1",
    "tree-sitter-cpp": "^0.23.4"
  },
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  },
  "ibusWeb": {
    "assets": ["fixtures"]
  }
}
```

`tools/engine-manifest/package.json` and `tools/ibus-test/package.json`: the same shape with no `dependencies` and no
`ibusWeb`, named `@ibus-web/engine-manifest` and `@ibus-web/ibus-test`:

```json
{
  "name": "@ibus-web/engine-manifest",
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

```json
{
  "name": "@ibus-web/ibus-test",
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

`tools/gschema/package.json` (its test imports `packages/protocol/src` by path):

```json
{
  "name": "@ibus-web/gschema",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run --configLoader native"
  },
  "devDependencies": {
    "@ibus-web/protocol": "workspace:*",
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  }
}
```

`tools/keysyms/package.json` (its tests import `packages/core/src/keys/*.generated.ts` by path):

```json
{
  "name": "@ibus-web/keysyms",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run --configLoader native"
  },
  "devDependencies": {
    "@ibus-web/core": "workspace:*",
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  }
}
```

`tools/vendor-inventory/package.json`:

```json
{
  "name": "@ibus-web/vendor-inventory",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run --configLoader native"
  },
  "dependencies": {
    "mdast-util-from-markdown": "^2.0.2",
    "mdast-util-gfm-table": "^2.0.0",
    "micromark-extension-gfm-table": "^2.1.1"
  },
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  }
}
```

In `examples/hangul/package.json`, replace `"@ibus-web/tools": "workspace:*"` with `"@ibus-web/bundle-scan": "workspace:*"`
(keep `devDependencies` sorted).

- [ ] **Step 3: Rewrite each tool's tsconfig**

Each tool's `tsconfig.json` now also covers its `vitest.config.ts`, whose types name DOM types; `skipLibCheck` keeps
those declarations from failing a Node-only check.

`tools/bundle-scan/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": { "lib": ["es2023", "dom"], "types": ["node"], "skipLibCheck": true },
  "include": ["*.ts"]
}
```

`tools/gschema/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": { "lib": ["es2023", "dom"], "types": ["node"], "skipLibCheck": true },
  "include": ["*.ts"]
}
```

`tools/engine-manifest/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": {
    "types": ["node"],
    // Vitest's declarations name DOM types, which Node code doesn't have.
    "skipLibCheck": true
  },
  "include": ["*.ts"]
}
```

`tools/cast-audit/tsconfig.json`, `tools/ibus-test/tsconfig.json`, `tools/keysyms/tsconfig.json` and
`tools/vendor-inventory/tsconfig.json`:

```json
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

`tools/ibus-test/` keeps its `native/`, `wasm/` and `fixtures/` C sources; `"include": ["*.ts"]` is exactly the
TypeScript it had (`git ls-files 'tools/ibus-test/**/*.ts'` lists only top-level files).

- [ ] **Step 4: Resolve bundle-scan's entries from its own package**

In `tools/bundle-scan/scan.ts`, `main` builds a probe bundle for each published entry, resolving them from the directory
it builds in. That directory becomes the tool's own package, whose `node_modules` holds the entries:

```ts
async function main() {
  const tools = resolve(import.meta.dirname, "..");
  const temp = await mkdtemp(resolve(tools, ".bundle-scan-"));
```

becomes

```ts
async function main() {
  const root = import.meta.dirname;
  const temp = await mkdtemp(resolve(root, ".bundle-scan-"));
```

and in the `build({ … })` call `root: tools,` becomes `root,`.

- [ ] **Step 5: Build tool trees with `workspaceFor`**

`modules/typescript/default.nix`:

- In `pnpmWorkspace.packages`, replace `"tools"` with `"tools/*"`.
- In `buildWorkspace`, `lib.elem "packages/core" selectedDirs || lib.elem "tools" selectedDirs` becomes
  `lib.elem "packages/core" selectedDirs || lib.elem "tools/keysyms" selectedDirs`.
- In `buildPhase`, `} run build` becomes `} run --if-present build`.

`modules/engines/cast-audit.nix`: delete `toolsSource` and the `auditTools = pkgs.runCommand … '';` block (including the
preset copy Task A1 added) and put in their place:

```nix
      auditTools = typescript.workspaceFor [ "tools/cast-audit" ];
```

In `checks.engines-cast-audit-script`, `packageDir = "${auditTools}/tools";` becomes
`packageDir = "${auditTools}/tools/cast-audit";`. `script` and the `select.ts` path already name
`${auditTools}/tools/cast-audit/…` and stay.

`modules/engines/ibus-test.nix`: delete `toolsSource` and the `testTools = pkgs.runCommand … '';` block and put in their
place:

```nix
      testTools = typescript.workspaceFor [ "tools/ibus-test" ];
```

In the conformance runner, `cd ${testTools}/tools` becomes `cd ${testTools}/tools/ibus-test` and the last Vitest argument
`ibus-test/conformance.test.ts` becomes `conformance.test.ts`. In `checks.engines-ibus-test-script`,
`packageDir = "${testTools}/tools";` becomes `packageDir = "${testTools}/tools/ibus-test";` and the line
`vitestArgs = [ "ibus-test" ];` is deleted (the package holds only that tool's tests).

`engines/hangul/checks/differential/default.nix`, in `hangul-native-session`:
`packageDir = "${config.packages.ibus-test-tools}/tools";` becomes
`packageDir = "${config.packages.ibus-test-tools}/tools/ibus-test";` and `vitestArgs = [ "ibus-test/session.test.ts" ];`
becomes `vitestArgs = [ "session.test.ts" ];`.

`runtime/libibus-web/checks.nix`: replace the whole `inventoryTools = let … in pkgs.runCommand … '';` binding with

```nix
      inventoryTools = config.ibusWeb.typescript.workspaceFor [ "tools/vendor-inventory" ];
```

In `checks.libibus-web-vendored`, `${inventoryTools}/tools/vendor-inventory/cli.ts` stays. In
`checks.libibus-web-vendored-script`, `packageDir = "${inventoryTools}/tools";` becomes
`packageDir = "${inventoryTools}/tools/vendor-inventory";` and `vitestArgs = [ "vendor-inventory" ];` is deleted.

`modules/engines/manifest.nix`, `checks.engine-manifest`: `packageDir = "${typescript.workspace}/tools";` becomes
`packageDir = "${typescript.workspaceFor [ "tools/engine-manifest" ]}/tools/engine-manifest";` and the whole
`vitestArgs = [ … ];` list is deleted (it named every test the package has).

`modules/engines/settings-metadata.nix`, `checks.settings-metadata`: `packageDir = "${typescript.workspace}/tools";`
becomes `packageDir = "${typescript.workspaceFor [ "tools/gschema" ]}/tools/gschema";` and
`vitestArgs = [ "gschema/metadata.test.ts" ];` is deleted.

`modules/keys.nix`, `checks.keys-generators`:

```nix
          packageDir = "${
            typescript.workspaceFor [
              "tools"
              "packages/core"
            ]
          }/tools";
```

becomes

```nix
          packageDir = "${typescript.workspaceFor [ "tools/keysyms" ]}/tools/keysyms";
```

and `vitestArgs = [ "keysyms" ];` is deleted.

`modules/playwright.nix`, `checks.bundle-scan`:

```nix
            node tools/node_modules/vitest/vitest.mjs run --root tools --configLoader native bundle-scan/scan.test.ts 2>&1 | tee "$out/tests.txt"
            export IBUS_WEB_SCAN_OUTPUT=$out
            node tools/bundle-scan/scan.ts 2>&1 | tee "$out/scan.txt"
```

becomes

```nix
            node tools/bundle-scan/node_modules/vitest/vitest.mjs run --root tools/bundle-scan --configLoader native scan.test.ts 2>&1 | tee "$out/tests.txt"
            export IBUS_WEB_SCAN_OUTPUT=$out
            node tools/bundle-scan/scan.ts 2>&1 | tee "$out/scan.txt"
```

- [ ] **Step 6: Install and regenerate**

```bash
nix run .#write-files
nix develop -c pnpm install
git diff --stat pnpm-workspace.yaml
```

Expected: `pnpm-workspace.yaml` shows `- tools/*` in place of `- tools`; `pnpm-lock.yaml` has an importer per tool and no
`tools` importer.

- [ ] **Step 7: Check**

Several suites read fixtures that only Nix provides through environment variables, so run them through their checks.
Run the targeted checks first, then the Global Constraints' checks:

```bash
nix build -L .#checks.x86_64-linux.engines-cast-audit-script .#checks.x86_64-linux.engines-ibus-test-script \
  .#checks.x86_64-linux.libibus-web-vendored .#checks.x86_64-linux.libibus-web-vendored-script \
  .#checks.x86_64-linux.engine-manifest .#checks.x86_64-linux.settings-metadata .#checks.x86_64-linux.keys-generators \
  .#checks.x86_64-linux.bundle-scan .#checks.x86_64-linux.hangul-native-session
```

Expected: all build. If `pnpmDeps` reports a hash mismatch, update its `hash` with the `got:` value.

- [ ] **Step 8: Commit**

```bash
nix develop -c git add tools examples/hangul/package.json modules engines runtime/libibus-web/checks.nix \
  pnpm-lock.yaml pnpm-workspace.yaml
nix develop -c git commit -m "build(tools): make each tool its own workspace package" -- tools examples/hangul/package.json \
  modules engines runtime/libibus-web/checks.nix pnpm-lock.yaml pnpm-workspace.yaml
```

### Task B2: Move the build scripts out of the Nix modules

The four scripts here import only Node's built-ins. Nix runs each from its own store copy (`${./script.ts}`), whose store
path depends only on its name and contents, so moving them rebuilds nothing.

**Files:**

- Move: `modules/flake/tsconfig-extends.ts` → `tools/tsconfig-extends/tsconfig-extends.ts`
- Move: `modules/typescript/assert-dependency.ts` → `tools/assert-dependency/assert-dependency.ts`
- Move: `modules/testing/expect-results.ts` → `tools/expect-results/expect-results.ts`
- Move: `modules/toolchain/{instantiate,minimum-versions,probe-features}.ts` → `tools/toolchain-probes/`
- Create: `tools/{tsconfig-extends,assert-dependency,expect-results,toolchain-probes}/{package.json,tsconfig.json}`
- Delete: `modules/flake/tsconfig.json`, `modules/typescript/tsconfig.json`, `modules/testing/tsconfig.json`,
  `modules/toolchain/tsconfig.json`
- Modify: `hk.pkl`, `modules/typescript/default.nix`, `modules/testing/default.nix`, `modules/toolchain/cache.nix`,
  `modules/toolchain/minimum-versions.nix`, `pnpm-lock.yaml`

**Interfaces:**

- Produces: `@ibus-web/tsconfig-extends` (`tools/tsconfig-extends/tsconfig-extends.ts`, run by hk from the repository
  root), `@ibus-web/assert-dependency` (`tools/assert-dependency/assert-dependency.ts`, still exposed as
  `ibusWeb.typescript.assertDependency`), `@ibus-web/expect-results` (`tools/expect-results/expect-results.ts`) and
  `@ibus-web/toolchain-probes` (`tools/toolchain-probes/{instantiate,minimum-versions,probe-features}.ts`).

- [ ] **Step 1: Move the files**

```bash
mkdir -p tools/tsconfig-extends tools/assert-dependency tools/expect-results tools/toolchain-probes
git mv modules/flake/tsconfig-extends.ts tools/tsconfig-extends/tsconfig-extends.ts
git mv modules/typescript/assert-dependency.ts tools/assert-dependency/assert-dependency.ts
git mv modules/testing/expect-results.ts tools/expect-results/expect-results.ts
git mv modules/toolchain/instantiate.ts modules/toolchain/minimum-versions.ts modules/toolchain/probe-features.ts \
  tools/toolchain-probes/
git rm -q modules/flake/tsconfig.json modules/typescript/tsconfig.json modules/testing/tsconfig.json \
  modules/toolchain/tsconfig.json
```

`modules/testing/gtest-main/tsconfig.json` stays until Task B4.

- [ ] **Step 2: Give each its manifest and tsconfig**

`tools/tsconfig-extends/package.json`:

```json
{
  "name": "@ibus-web/tsconfig-extends",
  "private": true,
  "type": "module",
  "dependencies": {
    "jsonc-parser": "catalog:"
  },
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:"
  }
}
```

`tools/assert-dependency/package.json`, `tools/expect-results/package.json`, `tools/toolchain-probes/package.json`: the
same without `dependencies`, named `@ibus-web/assert-dependency`, `@ibus-web/expect-results` and
`@ibus-web/toolchain-probes`:

```json
{
  "name": "@ibus-web/assert-dependency",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:"
  }
}
```

```json
{
  "name": "@ibus-web/expect-results",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:"
  }
}
```

```json
{
  "name": "@ibus-web/toolchain-probes",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:"
  }
}
```

`tools/{tsconfig-extends,assert-dependency,expect-results,toolchain-probes}/tsconfig.json`, all four identical:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "include": ["*.ts"]
}
```

- [ ] **Step 3: Point the callers at the new paths**

- `hk.pkl`: `command = "node modules/flake/tsconfig-extends.ts"` → `command = "node tools/tsconfig-extends/tsconfig-extends.ts"`.
- `modules/typescript/default.nix`: both `./assert-dependency.ts` (in `assertPlaywrightVersion` and in
  `assertDependency = …;`) → `../../tools/assert-dependency/assert-dependency.ts`.
- `modules/testing/default.nix`: `${./expect-results.ts}` → `${../../tools/expect-results/expect-results.ts}`.
- `modules/toolchain/cache.nix`: both `${./instantiate.ts}` → `${../../tools/toolchain-probes/instantiate.ts}`;
  `${./probe-features.ts}` → `${../../tools/toolchain-probes/probe-features.ts}`.
- `modules/toolchain/minimum-versions.nix`: both `${./minimum-versions.ts}` →
  `${../../tools/toolchain-probes/minimum-versions.ts}`.

Run: `git grep -n -e 'instantiate\.ts' -e 'probe-features\.ts' -e 'minimum-versions\.ts' -e 'expect-results\.ts' -e 'assert-dependency\.ts' -e 'tsconfig-extends\.ts' -- '*.nix' '*.pkl'`
Expected: every match names a path under `tools/`.

- [ ] **Step 4: Install and check**

```bash
nix run .#write-files
nix develop -c pnpm install
nix develop -c node tools/tsconfig-extends/tsconfig-extends.ts && echo extends-ok
```

Expected: `extends-ok`.

Run the Global Constraints' checks. Expected: success.

- [ ] **Step 5: Commit**

```bash
nix develop -c git add tools modules hk.pkl pnpm-lock.yaml pnpm-workspace.yaml
nix develop -c git commit -m "build(tools): move the Nix modules' scripts into tool packages" -- tools modules hk.pkl \
  pnpm-lock.yaml pnpm-workspace.yaml
```

### Task B3: Move the GLib test gate and the Emscripten library checker into tools

Both scripts import an npm package and carry a test file that `testing.programs` runs with `nodeTests`.

**Files:**

- Move: `modules/glib/checks/tests/gate.ts`, `gate.test.ts` → `tools/glib-test-gate/`
- Move: `runtime/wasmfs-idb/library-deps.ts`, `library-deps.test.ts` → `tools/emscripten-library-deps/`
- Create: `tools/glib-test-gate/{package.json,tsconfig.json}`, `tools/emscripten-library-deps/{package.json,tsconfig.json}`
- Delete: `modules/glib/checks/tests/package.json`, `modules/glib/checks/tests/tsconfig.json`,
  `runtime/wasmfs-idb/tsconfig.json`
- Modify: `runtime/wasmfs-idb/package.json` (drop `acorn`), `modules/glib/checks/tests/default.nix`,
  `runtime/wasmfs-idb/types.nix`, `modules/typescript/default.nix` (`pnpmWorkspace.packages`), `pnpm-lock.yaml`

**Interfaces:**

- Produces: `@ibus-web/glib-test-gate` (`tools/glib-test-gate/gate.ts`) and `@ibus-web/emscripten-library-deps`
  (`tools/emscripten-library-deps/library-deps.ts`). `ibusWeb.runtime.libraryDeps` keeps its meaning: the checker
  script beside its package manifest and `node_modules`.
- Expect: GLib's own test run (`checks.glib-tests` and what depends on it) rebuilds, since the gate's `node_modules`
  link moves to another store path. This takes a long time; it is expected.

- [ ] **Step 1: Move the files**

```bash
mkdir -p tools/glib-test-gate tools/emscripten-library-deps
git mv modules/glib/checks/tests/gate.ts modules/glib/checks/tests/gate.test.ts tools/glib-test-gate/
git mv runtime/wasmfs-idb/library-deps.ts runtime/wasmfs-idb/library-deps.test.ts tools/emscripten-library-deps/
git rm -q modules/glib/checks/tests/package.json modules/glib/checks/tests/tsconfig.json runtime/wasmfs-idb/tsconfig.json
```

- [ ] **Step 2: Manifests and tsconfigs**

`tools/glib-test-gate/package.json`:

```json
{
  "name": "@ibus-web/glib-test-gate",
  "private": true,
  "type": "module",
  "dependencies": {
    "smol-toml": "catalog:"
  },
  "devDependencies": {
    "@ibus-web/test-programs": "workspace:*",
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  }
}
```

`tools/emscripten-library-deps/package.json`:

```json
{
  "name": "@ibus-web/emscripten-library-deps",
  "private": true,
  "type": "module",
  "dependencies": {
    "acorn": "^8.18.0"
  },
  "devDependencies": {
    "@ibus-web/test-programs": "workspace:*",
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  }
}
```

`tools/glib-test-gate/tsconfig.json` and `tools/emscripten-library-deps/tsconfig.json` have the content of
`tools/tsconfig-extends/tsconfig.json` from Task B2:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "include": ["*.ts"]
}
```

`runtime/wasmfs-idb/package.json` becomes:

```json
{
  "name": "@ibus-web/wasmfs-idb",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*"
  }
}
```

- [ ] **Step 3: Point the Nix at the new paths**

`modules/typescript/default.nix`, `pnpmWorkspace.packages`: delete `"modules/glib/checks/tests"`.

`modules/glib/checks/tests/default.nix`:

```nix
      gate = pkgs.runCommand "ibus-web-glib-tests-gate-script" { } ''
        mkdir $out
        cp ${./gate.ts} $out/gate.ts
        ln -s ${typescript.packageNodeModules ./.} $out/node_modules
      '';
```

becomes

```nix
      gate = pkgs.runCommand "ibus-web-glib-tests-gate-script" { } ''
        mkdir $out
        cp ${../../../../tools/glib-test-gate/gate.ts} $out/gate.ts
        ln -s ${typescript.packageNodeModules ../../../../tools/glib-test-gate} $out/node_modules
      '';
```

and in `checks.glib-tests-gate`, `nodeTests = ./.;` becomes `nodeTests = ../../../../tools/glib-test-gate;`.

`runtime/wasmfs-idb/types.nix`:

```nix
        cp ${./library-deps.ts} $out/library-deps.ts
        cp ${./package.json} $out/package.json
        ln -s ${typescript.packageNodeModules ./.} $out/node_modules
```

becomes

```nix
        cp ${../../tools/emscripten-library-deps/library-deps.ts} $out/library-deps.ts
        cp ${../../tools/emscripten-library-deps/package.json} $out/package.json
        ln -s ${typescript.packageNodeModules ../../tools/emscripten-library-deps} $out/node_modules
```

In `checks.wasmfs-idb-acorn`, the directory argument `runtime/wasmfs-idb` (last line of the `assertDependency` call)
becomes `tools/emscripten-library-deps`. In `checks.wasmfs-idb-library-deps`, `nodeTests = ./.;` becomes
`nodeTests = ../../tools/emscripten-library-deps;`.

- [ ] **Step 4: Install and check**

```bash
nix run .#write-files
nix develop -c pnpm install
nix build -L .#checks.x86_64-linux.glib-tests-gate .#checks.x86_64-linux.wasmfs-idb-library-deps \
  .#checks.x86_64-linux.wasmfs-idb-acorn .#checks.x86_64-linux.wasmfs-idb-types
```

Expected: all four build. Then the Global Constraints' checks. Expected: success.

- [ ] **Step 5: Commit**

```bash
nix develop -c git add tools modules runtime/wasmfs-idb pnpm-lock.yaml pnpm-workspace.yaml
nix develop -c git commit -m "build(tools): move the GLib test gate and library checker into tool packages" -- tools \
  modules runtime/wasmfs-idb pnpm-lock.yaml pnpm-workspace.yaml
```

### Task B4: Component packages

JavaScript Emscripten compiles in stays with its component. Each component with such files, or with Vitest suites that
drive its wasm build, becomes a private package with its tsconfigs at its root.

**Files:**

- `runtime/ibus-runtime`: create `package.json`, `tsconfig.worker.json`, `tsconfig.test.json`; rewrite `tsconfig.json`;
  delete `tests/tsconfig.json`
- `runtime/wasmfs-idb`: create `tsconfig.json`, `tsconfig.worker.json`, `tsconfig.test.json`,
  `tsconfig.library-types.json`; delete `src/tsconfig.json`, `tests/tsconfig.json`, `tests/library-types/tsconfig.json`
- `modules/emscripten`: create `package.json`, `tsconfig.json`; delete `checks/fixes/tsconfig.json`
- `modules/testing`: create `package.json`, `tsconfig.json`; delete `gtest-main/tsconfig.json`
- Modify: `modules/typescript/default.nix` (`pnpmWorkspace.packages`), `runtime/wasmfs-idb/types.nix`,
  `modules/testing/default.nix`, `pnpm-lock.yaml`

**Interfaces:**

- Produces: workspace packages `@ibus-web/ibus-runtime`, `@ibus-web/wasmfs-idb`, `@ibus-web/emscripten-checks`,
  `@ibus-web/testing`. `pnpmWorkspace.packages` is, in this order: `"packages/*"`, `"tools/*"`, `"examples/*"`,
  `"runtime/ibus-runtime"`, `"runtime/wasmfs-idb"`, `"modules/emscripten"`, `"modules/testing"`.
- Produces: `runtime/wasmfs-idb/tsconfig.library-types.json`, the negative type test, which no `tsconfig.json`
  references and only `checks.wasmfs-idb-types` runs.
- Unchanged: the generated-types out-links stay at `runtime/wasmfs-idb/src/emscripten-types` and
  `modules/testing/gtest-main/emscripten-types`.

- [ ] **Step 1: `runtime/ibus-runtime`**

`runtime/ibus-runtime/package.json`:

```json
{
  "name": "@ibus-web/ibus-runtime",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@ibus-web/test-programs": "workspace:*",
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  }
}
```

`runtime/ibus-runtime/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The runtime's --pre-js, which Emscripten bundles into the runtime as
// written and which runs in Workers; and the load tests' harness and test
// file, which run under Node.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "files": [],
  "references": [{ "path": "./tsconfig.worker.json" }, { "path": "./tsconfig.test.json" }]
}
```

`runtime/ibus-runtime/tsconfig.worker.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/emscripten-js.json",
  "files": ["host-memory.js", "pre-js.d.ts"]
}
```

`runtime/ibus-runtime/tsconfig.test.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": {
    // Atomics.waitAsync().
    "lib": ["es2023", "es2024.sharedmemory"]
  },
  "include": ["tests/*.ts"]
}
```

```bash
git rm -q runtime/ibus-runtime/tests/tsconfig.json
```

- [ ] **Step 2: `runtime/wasmfs-idb`**

`runtime/wasmfs-idb/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The backend's JavaScript library, which runs on the backend's thread, a
// Worker; and the tests' JavaScript libraries and --post-js, which run on
// every thread of a test program. tsconfig.library-types.json is a negative
// test that must fail, run only by its Nix check, so it isn't listed here.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "files": [],
  "references": [{ "path": "./tsconfig.worker.json" }, { "path": "./tsconfig.test.json" }]
}
```

`runtime/wasmfs-idb/tsconfig.worker.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// src/emscripten-types/ is generated, not written: the types of what the
// library uses from Emscripten, from a link of the library.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/emscripten-js.json",
  "files": ["src/libwasmfs_idb.js", "src/emscripten-library.d.ts", "src/emscripten-types/globals.d.ts"]
}
```

`runtime/wasmfs-idb/tsconfig.test.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/emscripten-js.json",
  "include": ["tests/*.js", "tests/*.d.ts", "src/emscripten-library.d.ts"]
}
```

`runtime/wasmfs-idb/tsconfig.library-types.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The negative test of addToLibrary's type: checking this must fail, with an
// error for each call in rejected.js.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./tsconfig.worker.json",
  "files": ["src/emscripten-library.d.ts", "tests/library-types/rejected.js"]
}
```

```bash
git rm -q runtime/wasmfs-idb/src/tsconfig.json runtime/wasmfs-idb/tests/tsconfig.json \
  runtime/wasmfs-idb/tests/library-types/tsconfig.json
```

In `runtime/wasmfs-idb/types.nix`, in `sources`, replace

```nix
            ./src/tsconfig.json
```

with `./tsconfig.worker.json`, replace `./tests/tsconfig.json` with `./tsconfig.test.json`, and replace
`./tests/library-types/tsconfig.json` with `./tsconfig.library-types.json`. In `checks.wasmfs-idb-types`:

- `tsc -p src` → `tsc -p tsconfig.worker.json`
- `tsc -p tests` → `tsc -p tsconfig.test.json`
- `if tsc -p tests/library-types > errors.txt; then` → `if tsc -p tsconfig.library-types.json > errors.txt; then`

- [ ] **Step 3: `modules/emscripten`**

`modules/emscripten/package.json`:

```json
{
  "name": "@ibus-web/emscripten-checks",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@ibus-web/test-programs": "workspace:*",
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  }
}
```

`modules/emscripten/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Type-checks the fix checks' --pre-js, which Emscripten bundles into
// programs run under Node, as written, as a script, and their Vitest test
// file.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/emscripten-js.json",
  "compilerOptions": {
    // Node's, not a Worker's.
    "lib": ["es2023"],
    "types": ["node", "@ibus-web/tsconfig/types/webassembly"]
  },
  "files": ["checks/fixes/size-pre.js", "checks/fixes/pre-js.d.ts", "checks/fixes/fixes.test.ts"]
}
```

```bash
git rm -q modules/emscripten/checks/fixes/tsconfig.json
```

- [ ] **Step 4: `modules/testing`**

`modules/testing/package.json`:

```json
{
  "name": "@ibus-web/testing",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*"
  }
}
```

`modules/testing/tsconfig.json`:

```json
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Type-checks GoogleTest's report library, which runs on a program's main
// thread: a Worker in browsers, Node's own thread under Node.
// gtest-main/emscripten-types/ is generated, not written: the types of what
// the library uses from Emscripten, from a link of the library.
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/emscripten-js.json",
  "files": [
    "gtest-main/report.js",
    "gtest-main/report.d.ts",
    "../../runtime/wasmfs-idb/src/emscripten-library.d.ts",
    "gtest-main/emscripten-types/globals.d.ts"
  ]
}
```

```bash
git rm -q modules/testing/gtest-main/tsconfig.json
```

In `modules/testing/default.nix`, `checks.gtest-main-library`: in `sources`, `./gtest-main/tsconfig.json` becomes
`./tsconfig.json`, and `tsc -p modules/testing/gtest-main` becomes `tsc -p modules/testing`.

- [ ] **Step 5: The workspace list**

In `modules/typescript/default.nix`, `pnpmWorkspace.packages` becomes:

```nix
        packages = [
          "packages/*"
          "tools/*"
          "examples/*"
          "runtime/ibus-runtime"
          "runtime/wasmfs-idb"
          "modules/emscripten"
          "modules/testing"
        ];
```

- [ ] **Step 6: Install and check**

```bash
nix run .#write-files
nix develop -c pnpm install
nix develop -c bash -c 'for d in runtime/ibus-runtime runtime/wasmfs-idb modules/emscripten modules/testing; do tsc -b --noEmit $d/tsconfig.json || exit 1; done'
nix build -L .#checks.x86_64-linux.wasmfs-idb-types .#checks.x86_64-linux.gtest-main-library
```

Expected: no type errors (the dev shell builds the two `emscripten-types` out-links on entry; if one is missing, run
`nix develop` once more and retry); both checks build.

Run the Global Constraints' checks. Expected: success.

- [ ] **Step 7: Commit**

```bash
nix develop -c git add runtime/ibus-runtime runtime/wasmfs-idb modules pnpm-lock.yaml pnpm-workspace.yaml
nix develop -c git commit -m "build: make components with JavaScript workspace packages" -- runtime/ibus-runtime \
  runtime/wasmfs-idb modules pnpm-lock.yaml pnpm-workspace.yaml
```

### Task B5: The Hangul example absorbs the end-to-end tests

**Files:**

- Move: `tests/playwright/{demo.spec.ts,fixtures.ts,keystroke.bench.ts,playwright.config.ts,settings.spec.ts}` →
  `examples/hangul/test/e2e/`
- Delete: `tests/playwright/tsconfig.json`
- Modify: `examples/hangul/test/e2e/playwright.config.ts` (`webServer.cwd`)
- Rewrite: `examples/hangul/package.json`
- Modify: `modules/playwright.nix`, `modules/demo.nix`, `pnpm-lock.yaml`

**Interfaces:**

- Produces: package `@ibus-web/example-hangul` with scripts `bundle`, `dev`, `e2e`, `smoke`, `typecheck`, and no
  `build` (the workspace build no longer type-checks it; hk's `tsc` step does).
- Produces: the Playwright suites at `examples/hangul/test/e2e/`, run as
  `node examples/hangul/node_modules/playwright/cli.js test -c examples/hangul/test/e2e/playwright.config.ts` from the
  workspace root. Phase C merges `modules/demo.nix` and `modules/playwright.nix` into `examples/hangul/module.nix`.

- [ ] **Step 1: Move the suites**

```bash
mkdir -p examples/hangul/test/e2e
git mv tests/playwright/demo.spec.ts tests/playwright/fixtures.ts tests/playwright/keystroke.bench.ts \
  tests/playwright/playwright.config.ts tests/playwright/settings.spec.ts examples/hangul/test/e2e/
git rm -q tests/playwright/tsconfig.json
```

`examples/hangul/tsconfig.json` already includes `test/**/*.ts`, with DOM and Node types, which is what the suites'
own config gave them.

In `examples/hangul/test/e2e/playwright.config.ts`, `cwd: resolve(import.meta.dirname, "../../examples/hangul"),`
becomes `cwd: resolve(import.meta.dirname, "../.."),`.

- [ ] **Step 2: Rename the package and give it scripts**

`examples/hangul/package.json`:

```json
{
  "name": "@ibus-web/example-hangul",
  "private": true,
  "type": "module",
  "scripts": {
    "bundle": "vite build",
    "dev": "vite --host 127.0.0.1 --port 5173 --strictPort",
    "e2e": "playwright test -c test/e2e/playwright.config.ts",
    "smoke": "node test/smoke.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "ibus-web": "workspace:*"
  },
  "devDependencies": {
    "@ibus-web/bundle-scan": "workspace:*",
    "@ibus-web/test-programs": "workspace:*",
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "effect": "catalog:",
    "playwright": "catalog:",
    "typescript": "catalog:",
    "vite": "catalog:"
  },
  "peerDependencies": {
    "effect": "catalog:"
  },
  "ibusWeb": {
    "assets": ["index.html", "src/style.css"]
  }
}
```

- [ ] **Step 3: Run the suites from the example**

In `modules/playwright.nix`:

- Delete the `suites = lib.fileset.toSource { … };` binding.
- `prepare` becomes:

```nix
      prepare = ''
        cp -R ${workspace} source
        chmod -R u+w source
        cd source
      '';
```

- In `integration`, `timeout --kill-after=10 600 node node_modules/playwright/cli.js test \` and the following
  `-c tests/playwright/playwright.config.ts 2>&1 | tee "$out/output.txt"` become
  `timeout --kill-after=10 600 node examples/hangul/node_modules/playwright/cli.js test \` and
  `-c examples/hangul/test/e2e/playwright.config.ts 2>&1 | tee "$out/output.txt"`.
- In `apps.keystroke-bench`, `node node_modules/playwright/cli.js test -c tests/playwright/playwright.config.ts "$@"`
  becomes `node examples/hangul/node_modules/playwright/cli.js test -c examples/hangul/test/e2e/playwright.config.ts "$@"`.

If `lib` is no longer used in `modules/playwright.nix` after deleting `suites`, keep it in the argument set only if
`apps.keystroke-bench` still uses it (it does: `lib.getExe`, `lib.concatStringsSep`).

In `modules/demo.nix`, `pnpm --filter demo... --filter '!demo' run build` becomes
`pnpm --filter @ibus-web/example-hangul... --filter '!@ibus-web/example-hangul' run build`.

- [ ] **Step 4: Install and check**

```bash
nix develop -c pnpm install
nix develop -c bash -c 'cd examples/hangul && pnpm run typecheck'
nix build -L .#checks.x86_64-linux.demo .#checks.x86_64-linux.bundle-scan
nix build -L .#playwright-integration
```

Expected: the type check prints nothing and exits 0; all three builds succeed, and `result/output.txt` ends with
Playwright's summary reporting no failed tests.

Run the Global Constraints' checks. Expected: success. `ls tests` fails with "No such file or directory".

- [ ] **Step 5: Commit**

```bash
nix develop -c git add examples/hangul tests modules/playwright.nix modules/demo.nix pnpm-lock.yaml
nix develop -c git commit -m "test(example): run the end-to-end suites from the Hangul example" -- examples/hangul tests \
  modules/playwright.nix modules/demo.nix pnpm-lock.yaml
```

### Task B6: Empty the root package and require tsconfigs at package roots

**Files:**

- Rewrite: `package.json`
- Delete: `docs/upstream/evidence/idb-sync-calls/tsconfig.json`
- Modify: `hk.pkl` (`tsc` excludes), `tools/tsconfig-extends/tsconfig-extends.ts`, `pnpm-lock.yaml`

**Interfaces:**

- Produces: the root `package.json` has no dependencies; nothing resolves a package from the root's `node_modules`.
- Produces: `tools/tsconfig-extends` also fails a tracked `tsconfig*.json` that isn't beside a `package.json`.
- Leaves for Phase F: `docs/upstream/evidence/idb-sync-calls/measure.ts` stays, not type-checked (hk's `tsc` step excludes
  `docs/upstream/evidence/**`), until the documentation phase removes the evidence directory and that exclude with it.

- [ ] **Step 1: Write the failing check first**

Add the package-root rule to `tools/tsconfig-extends/tsconfig-extends.ts`. Change its header comment to:

```ts
// Fails unless every tsconfig*.json git tracks sits at a package's root,
// beside its package.json, and reaches one of @ibus-web/tsconfig's presets
// through `extends`, so every config shares the repository's standard
// options.
//
//   tsconfig-extends.ts
//     Run from the repository root.
```

and replace the final block

```ts
for (const file of failures) {
  console.error(`${file}: doesn't extend an ${presetPackage} preset, directly or through another config`);
}
if (failures.length > 0) process.exit(1);
```

with

```ts
for (const file of failures) {
  console.error(`${file}: doesn't extend an ${presetPackage} preset, directly or through another config`);
}
const outside = files.filter((file) => !existsSync(path.join(path.dirname(file), "package.json")));
for (const file of outside) {
  console.error(`${file}: isn't beside a package.json; a package's configs sit at its root`);
}
if (failures.length > 0 || outside.length > 0) process.exit(1);
```

Run: `nix develop -c node tools/tsconfig-extends/tsconfig-extends.ts; echo "exit=$?"`
Expected: `docs/upstream/evidence/idb-sync-calls/tsconfig.json: isn't beside a package.json; a package's configs sit at
its root` and `exit=1` — the last tsconfig outside a package.

- [ ] **Step 2: Remove the evidence's tsconfig and empty the root**

```bash
git rm -q docs/upstream/evidence/idb-sync-calls/tsconfig.json
```

In `hk.pkl`, `["tsc"]`, replace

```pkl
    // A negative test: its check must fail, which the Nix check asserts.
    exclude = "**/runtime/wasmfs-idb/tests/library-types/**"
```

with

```pkl
    exclude =
      List(
        // A negative test: its check must fail, which the Nix check asserts.
        "**/runtime/wasmfs-idb/tests/library-types/**",
        // A measurement script kept with the evidence it produced, not part
        // of any package.
        "docs/upstream/evidence/**",
      )
```

`package.json` becomes:

```json
{
  "name": "ibus-web",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.3.4"
}
```

(Keep `packageManager` equal to what it was; `modules/typescript/default.nix` asserts it names nixpkgs' pnpm.)

- [ ] **Step 3: Install and verify**

```bash
nix develop -c pnpm install
nix develop -c node tools/tsconfig-extends/tsconfig-extends.ts && echo extends-ok
git ls-files | grep -E '(^|/)tsconfig[^/]*\.json$' | wc -l
git ls-files | grep -E '(^|/)tsconfig[^/]*\.json$' | while read -r f; do test -f "$(dirname "$f")/package.json" || echo "$f"; done
```

Expected: `extends-ok`; `58` (packages 35, tools 13, `examples/hangul` 1, `runtime/ibus-runtime` 3, `runtime/wasmfs-idb` 4,
`modules/emscripten` 1, `modules/testing` 1); the loop prints nothing.

Run: `git ls-files '*.ts' '*.mts' '*.js' | grep -vE '^(packages|tools|examples)/' | grep -vE '^(runtime/(ibus-runtime|wasmfs-idb)|modules/(emscripten|testing))/' `
Expected: only `docs/upstream/evidence/idb-sync-calls/measure.ts`.

Run the Global Constraints' checks. Expected: success.

- [ ] **Step 4: Commit**

```bash
nix develop -c git add package.json pnpm-lock.yaml hk.pkl tools/tsconfig-extends docs/upstream/evidence/idb-sync-calls
nix develop -c git commit -m "build: give the root package no dependencies" -- package.json pnpm-lock.yaml hk.pkl \
  tools/tsconfig-extends docs/upstream/evidence/idb-sync-calls
```
## Phase C: Nix moves, file roles, helpers, splits, dead options, naming

Phase C changes only Nix, the Markdown that names Nix files or checks, and `REUSE.toml`. It changes
no C, TypeScript or test logic.

### What Phase C relies on from Phases A and B

These are the states Phases A and B leave. Each task below was written against them; if one
doesn't hold when a task starts, stop and reconcile before editing.

1. Root `tsconfig.base.json`, `tsconfig.emscripten-js.json` and `tsconfig.node-scripts.json` are
   gone; the presets live in `packages/tsconfig`, an ordinary workspace package. `buildWorkspace`
   in `modules/typescript/default.nix` no longer adds root tsconfigs to its fileset, and its
   install copies `package.json pnpm-workspace.yaml node_modules` (plus the notice files) from the
   root.
2. `tools/package.json`, `tools/tsconfig.json` and `tools/vitest.config.ts` are gone. Every
   `tools/<name>/` is a private package `@ibus-web/<name>` with its own `package.json`,
   `tsconfig.json` and (where it has tests) `vitest.config.ts`. `pnpm-workspace.yaml`'s package
   list (the `pnpmWorkspace.packages` binding in `modules/typescript/default.nix`) includes
   `tools/*`, `packages/*`, `examples/*` and the component packages `runtime/wasmfs-idb`,
   `runtime/ibus-runtime`, `modules/emscripten` and `modules/testing`, and no longer lists
   `tools` or `modules/glib/checks/tests`.
3. Scripts kept their file names when they moved: `tools/tsconfig-extends/tsconfig-extends.ts`,
   `tools/assert-dependency/assert-dependency.ts`, `tools/expect-results/expect-results.ts`,
   `tools/glib-test-gate/gate.ts` and `gate.test.ts`, `tools/toolchain-probes/instantiate.ts`,
   `minimum-versions.ts` and `probe-features.ts`, `tools/emscripten-library-deps/library-deps.ts`
   and `library-deps.test.ts`.
4. Every Nix reference to a moved script points at its new path, still from the Nix file it was
   in. The three hand-built "tools tree plus `node_modules`" derivations (`auditTools`,
   `testTools`, `inventoryTools`) may already be replaced by `typescript.workspaceFor`; Phase C
   replaces whatever is there. `typescript.workspaceFor [ "tools/<name>" ]` builds for every tool
   package (each has a `build` script, or the build passes without one).
5. `tests/playwright/` is now `examples/hangul/test/e2e/`, with `playwright.config.ts` there and its
   web server's `cwd` set to the example's directory. `examples/hangul` is named
   `@ibus-web/example-hangul`, and its `devDependencies` include `playwright`. `tools/bundle-scan`
   depends on what its scan builds (`ibus-web` and `@ibus-web/worker-host`).
6. The root `package.json` has no dependencies, so `node_modules/playwright` exists only under
   packages that depend on it.

### Snapshotting derivations

Several tasks are pure refactors. Each one proves that by comparing every check's and package's
derivation before and after. The commands, which a task repeats in full where it uses them:

```bash
snap() {
  nix eval --json .#checks.x86_64-linux --apply 'builtins.mapAttrs (_: c: c.drvPath)' > "$1-checks.json"
  nix eval --json .#packages.x86_64-linux --apply 'builtins.mapAttrs (_: p: p.drvPath)' > "$1-packages.json"
}
drvdiff() {
  for kind in checks packages; do
    echo "== $kind"
    jq -n --slurpfile a "$1-$kind.json" --slurpfile b "$2-$kind.json" '
      $a[0] as $a | $b[0] as $b |
      { removed: ([$a | keys[]] - [$b | keys[]]),
        added: ([$b | keys[]] - [$a | keys[]]),
        changed: [$a | keys[] | select($b[.] != null and $a[.] != $b[.])] }'
  done
}
```

Every comparison and gate step starts with `nix fmt` (hk's fixers over the tree), so a new or
edited `.nix` file is in nixfmt's form before `checks.hk` sees it.

`checks.hk` and `checks.clangd` copy the whole tree, so they change in every task that touches a
file; the tasks' expected outputs leave them out of `changed`.

---

### Task C1: `ibusWeb.lib` and the helpers every module copies

**Files:**

- Create: `modules/flake/lib.nix`
- Modify: `modules/emscripten/emscripten.nix`, `modules/glib/overlay.nix`,
  `runtime/libibus-web/overlay.nix`, `engines/hangul/overlay.nix`,
  `modules/toolchain/checks/cross-toolchain.nix`, `modules/toolchain/checks/exnref.nix`,
  `modules/toolchain/cache.nix`, `runtime/wasmfs-idb/package.nix`, `runtime/wasmfs-idb/types.nix`,
  `modules/emscripten/checks/fixes/default.nix`, `runtime/ibus-runtime/exports.nix`,
  `runtime/ibus-runtime/checks.nix`, `modules/testing/default.nix`,
  `engines/hangul/checks/golden/default.nix`, `modules/engines/ibus-test.nix`,
  `runtime/libibus-web/checks.nix`, `modules/glib/checks/settings-listeners/default.nix`

**Interfaces:**

- Produces: the per-system option `ibusWeb.lib` (`lazyAttrsOf raw`), declared in
  `modules/flake/lib.nix`, which any module may add a helper to. This task defines:
  - `patchesIn :: path -> [path]`: the `.patch` files under a directory, sorted.
  - `isEmscriptenWasm :: platform -> bool`: the overlay guard.
  - `emscriptenRoot :: string`: `"${toolchain.emscripten}/share/emscripten"`.
  - `wasmfsIncludeFlag :: string`: `"-I${emscriptenRoot}/system/lib/wasmfs"`.
  - `testLinkFlagsWithoutNodeFs :: [string]`: `[ toolchain.commonFlags ]` and
    `toolchain.testMainFlagList` without the `node-host-fs.o` object.
  - `mesonAllTestsRan :: string -> string`: shell that runs `meson test` and fails unless some
    tests ran and all passed.
- Overlays, which are flake-level, reach it as
  `withSystem prev.stdenv.buildPlatform.system ({ config, ... }: config.ibusWeb.lib)`.

- [ ] **Step 1: Snapshot the derivations**

```bash
snap() {
  nix eval --json .#checks.x86_64-linux --apply 'builtins.mapAttrs (_: c: c.drvPath)' > "$1-checks.json"
  nix eval --json .#packages.x86_64-linux --apply 'builtins.mapAttrs (_: p: p.drvPath)' > "$1-packages.json"
}
drvdiff() {
  for kind in checks packages; do
    echo "== $kind"
    jq -n --slurpfile a "$1-$kind.json" --slurpfile b "$2-$kind.json" '
      $a[0] as $a | $b[0] as $b |
      { removed: ([$a | keys[]] - [$b | keys[]]),
        added: ([$b | keys[]] - [$a | keys[]]),
        changed: [$a | keys[] | select($b[.] != null and $a[.] != $b[.])] }'
  done
}
T=$(mktemp -d); snap "$T/before"
```

Expected: both files written, no evaluation error. Keep this shell open: the comparison step at the
end of the task uses `$T` and these functions.

- [ ] **Step 2: Create `modules/flake/lib.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.lib = lib.mkOption {
      type = lib.types.lazyAttrsOf lib.types.raw;
      default = { };
      description = ''
        Helpers more than one module needs, by name, so that each is written once. The
        general ones are defined here; a module that owns a helper's subject defines that
        helper beside it.
      '';
    };
  };

  config.perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) toolchain;
      emscriptenRoot = "${toolchain.emscripten}/share/emscripten";
    in
    {
      ibusWeb.lib = {
        # The .patch files under a directory, sorted by path, so 0001-… applies
        # first; a README beside them is not a patch.
        patchesIn =
          dir:
          lib.filter (path: lib.hasSuffix ".patch" (toString path)) (lib.filesystem.listFilesRecursive dir);

        # Whether a platform is the WebAssembly one pkgsWasm builds for. Overlays
        # gate on the platform because it can be read without evaluating the
        # compiler.
        isEmscriptenWasm = platform: platform.isWasm && (platform.useEmscripten or false);

        # Emscripten's installed tree: its system libraries' sources, its
        # JavaScript libraries and its tools.
        inherit emscriptenRoot;

        # WasmFS's internal headers, for code that subclasses its backends or
        # reaches into its threads.
        wasmfsIncludeFlag = "-I${emscriptenRoot}/system/lib/wasmfs";

        # A Node-run test program's link flags without the object that roots
        # WasmFS at the host's files: the memory root keeps writes isolated, and
        # store paths stay readable.
        testLinkFlagsWithoutNodeFs = [
          toolchain.commonFlags
        ]
        ++ lib.filter (flag: !(lib.hasSuffix "/node-host-fs.o" flag)) toolchain.testMainFlagList;

        # Shell that runs a Meson build's tests and fails unless some ran and all
        # passed. Meson exits 0 for a skipped test, as when a cross file loses its
        # exe wrapper, so the summary is checked too. `what` names the tests.
        mesonAllTestsRan = what: ''
          meson test --no-rebuild --print-errorlogs | tee meson-summary.txt
          [ "''${PIPESTATUS[0]}" -eq 0 ]
          if ! grep -Eq '^Ok:[[:space:]]+[1-9]' meson-summary.txt ||
            grep -Eq '^(Skipped|Fail|Timeout|Unexpected Pass|Expected Fail):[[:space:]]+[1-9]' meson-summary.txt; then
            echo ${lib.escapeShellArg "${what}: tests did not all run and pass"} >&2
            exit 1
          fi
        '';
      };
    };
}
```

- [ ] **Step 3: Use `patchesIn` for Emscripten's patches**

In `modules/emscripten/emscripten.nix`, replace the whole `perSystem` with:

```nix
  perSystem =
    { config, pkgs, ... }:
    {
      # nixpkgs applies patches to the source tree it installs whole under
      # share/emscripten, so the system libraries the cache compiles and the
      # JavaScript libraries links read both carry them.
      ibusWeb.toolchain.emscripten = pkgs.emscripten.overrideAttrs (old: {
        patches = (old.patches or [ ]) ++ config.ibusWeb.lib.patchesIn ./patches;
      });
    };
```

- [ ] **Step 4: Use the helpers in the GLib overlay**

In `modules/glib/overlay.nix`, change the module's arguments and the guard. Replace:

```nix
{ lib, ... }:
{
  flake.overlays.glib =
    final: prev:
    lib.optionalAttrs
      (prev.stdenv.hostPlatform.isWasm && (prev.stdenv.hostPlatform.useEmscripten or false))
      {
```

with:

```nix
{ lib, withSystem, ... }:
{
  flake.overlays.glib =
    final: prev:
    let
      inherit (withSystem prev.stdenv.buildPlatform.system ({ config, ... }: config.ibusWeb.lib))
        isEmscriptenWasm
        patchesIn
        ;
    in
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform)
      {
```

and replace the `patches` attribute:

```nix
            # Sorted by name, so 0001-… applies first; README.md is not a patch.
            patches =
              (old.patches or [ ])
              ++ lib.filter (p: lib.hasSuffix ".patch" (toString p)) (
                lib.filesystem.listFilesRecursive ./patches
              );
```

with:

```nix
            patches = (old.patches or [ ]) ++ patchesIn ./patches;
```

- [ ] **Step 5: Use the guard in the libibus-web overlay**

Replace the whole of `runtime/libibus-web/overlay.nix` after its SPDX lines with:

```nix
{ lib, withSystem, ... }:
{
  flake.overlays.libibus-web =
    final: prev:
    let
      inherit (withSystem prev.stdenv.buildPlatform.system ({ config, ... }: config.ibusWeb.lib))
        isEmscriptenWasm
        ;
    in
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) {
      libibus-web = final.callPackage ./_package.nix { };
    };
}
```

- [ ] **Step 6: Rewrite the Hangul overlay around `withSystem`**

The guard now needs `ibusWeb.lib`, so `withSystem` moves outward. Replace the whole of
`engines/hangul/overlay.nix` with:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{ lib, withSystem, ... }:
{
  flake.overlays.hangul =
    final: prev:
    withSystem prev.stdenv.buildPlatform.system (
      { config, ... }:
      let
        inherit (config.ibusWeb) runtime toolchain;
        inherit (config.ibusWeb.lib) isEmscriptenWasm patchesIn;
      in
      lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) {
        ibus-engines = prev.ibus-engines // {
          hangul =
            let
              libhangul = final.libhangul.overrideAttrs (old: {
                patches = (old.patches or [ ]) ++ [
                  ../../modules/libhangul/patches/0001-buffer-hanja-dictionary-reads.patch
                ];
                outputs = (old.outputs or [ "out" ]) ++ [ "data" ];
                configureFlags = (old.configureFlags or [ ]) ++ [
                  "--datadir=${placeholder "data"}/share"
                  "--localedir=${placeholder "data"}/share/locale"
                ];
              });
              schemas = prev.runCommand "hangul-gsettings-schemas" { } ''
                mkdir -p $out/share/glib-2.0/schemas
                cp ${prev.ibus-engines.hangul.src}/data/org.freedesktop.ibus.engine.hangul.gschema.xml $out/share/glib-2.0/schemas/
                cp ${final.libibus-web}/share/gsettings-schemas/${final.libibus-web.name}/glib-2.0/schemas/org.freedesktop.ibus.gschema.xml \
                  $out/share/glib-2.0/schemas/
                ${final.glib.dev}/bin/glib-compile-schemas --strict $out/share/glib-2.0/schemas
              '';
              layer = name: patchesIn (./patches + "/${name}");
              cflags = "-DHAVE_CONFIG_H -I. -Isrc";
              pkgConfigModules = [
                "ibus-1.0"
                "libhangul"
              ];
              sources = [
                "src/engine.c"
                "src/ustring.c"
                "module.c"
              ];
              prepare = ''
                cp ${./module.c} module.c
                cat > config.h <<EOF
                #define GETTEXT_PACKAGE "ibus-hangul"
                #define IBUSHANGUL_DATADIR "$data/share/ibus-hangul"
                #define PKGDATADIR "$data/share/ibus-hangul"
                #define LOCALEDIR "$data/share/locale"
                #define LIBEXECDIR "/usr/libexec"
                #define IBUSWEB_SETTINGS_SCHEMA_DIR "${schemas}/share/glib-2.0/schemas"
                EOF
              '';
            in
            prev.ibus-engines.hangul.overrideAttrs (old: {
              outputs = [
                "out"
                "data"
              ];
              patches = (old.patches or [ ]) ++ layer "port" ++ layer "casts";
              nativeBuildInputs = [ final.buildPackages.pkg-config ];
              buildInputs = [
                final.libibus-web
                libhangul
              ];
              # The static adapter also propagates the desktop recipe's inputs.
              propagatedBuildInputs = [ ];
              dontConfigure = true;
              postPatch = (old.postPatch or "") + prepare;
              buildPhase = ''
                runHook preBuild
                cflags="$($PKG_CONFIG --cflags ${lib.escapeShellArgs pkgConfigModules}) ${cflags}"
                objects=()
                for source in ${lib.escapeShellArgs sources}; do
                  object="$(basename "$source" .c).o"
                  $CC $cflags -c "$source" -o "$object"
                  objects+=("$object")
                done
                libs="$($PKG_CONFIG --static --libs libhangul)"
                source ${runtime.sideModuleLibraryGuard}
                checkSideModuleLibraries $libs
                $CC ${toolchain.sideModuleFlags} -g0 "''${objects[@]}" $libs -o hangul.wasm
                runHook postBuild
              '';
              installPhase = ''
                runHook preInstall
                install -Dm644 hangul.wasm -t $out
                install -Dm644 data/symbol.txt -t $data/share/ibus-hangul/data
                runHook postInstall
              '';
              passthru = (old.passthru or { }) // {
                inherit libhangul schemas;
                settingsSchemaDir = "${schemas}/share/glib-2.0/schemas";
                auditCflags = cflags;
                auditSources = sources;
                auditPkgConfigModules = pkgConfigModules;
              };
            });
        };
      }
    );
}
```

- [ ] **Step 7: Use the guard in the cross-toolchain probe**

In `modules/toolchain/checks/cross-toolchain.nix`, replace:

```nix
      probe =
        final: prev:
        lib.optionalAttrs
          (prev.stdenv.hostPlatform.isWasm && (prev.stdenv.hostPlatform.useEmscripten or false))
          {
            ibusWebOverlayProbe = true;
          };
```

with:

```nix
      probe =
        final: prev:
        lib.optionalAttrs (config.ibusWeb.lib.isEmscriptenWasm prev.stdenv.hostPlatform) {
          ibusWebOverlayProbe = true;
        };
```

- [ ] **Step 8: Use `emscriptenRoot` and `wasmfsIncludeFlag`**

Make these replacements, each exactly once per line shown:

| File | Replace | With |
| --- | --- | --- |
| `modules/toolchain/checks/exnref.nix` | `${toolchain.emscripten}/share/emscripten/tools/feature_matrix.py` | `${config.ibusWeb.lib.emscriptenRoot}/tools/feature_matrix.py` |
| `modules/toolchain/cache.nix` | `cp -r --no-preserve=mode ${emscripten}/share/emscripten/cache $EM_CACHE` | `cp -r --no-preserve=mode ${config.ibusWeb.lib.emscriptenRoot}/cache $EM_CACHE` |
| `runtime/ibus-runtime/checks.nix` | `musl=$(< ${emscripten}/share/emscripten/system/lib/libc/musl/VERSION)` | `musl=$(< ${config.ibusWeb.lib.emscriptenRoot}/system/lib/libc/musl/VERSION)` |
| `runtime/ibus-runtime/exports.nix` | `emscriptenRoot = "${emscripten}/share/emscripten";` | `inherit (config.ibusWeb.lib) emscriptenRoot;` |
| `modules/emscripten/checks/fixes/default.nix` | `wasmfsInclude = "-I${toolchain.emscripten}/share/emscripten/system/lib/wasmfs";` | `wasmfsInclude = config.ibusWeb.lib.wasmfsIncludeFlag;` |
| `runtime/wasmfs-idb/package.nix` | `cflags = "-I${emscripten}/share/emscripten/system/lib/wasmfs";` | `cflags = config.ibusWeb.lib.wasmfsIncludeFlag;` |

In `runtime/wasmfs-idb/package.nix`, `emscripten` is now unused: change
`inherit (toolchain) pkgsWasm emscripten;` to `inherit (toolchain) pkgsWasm;`.

In `runtime/wasmfs-idb/types.nix` and `modules/testing/default.nix`, replace every
`${emscripten}/share/emscripten` with `${emscriptenRoot}` (five places in `types.nix`, two in
`default.nix`), and add `inherit (config.ibusWeb.lib) emscriptenRoot;` as the first line of each
file's `let`.

Then confirm none is left:

```bash
git grep -n 'share/emscripten' -- '*.nix'
```

Expected: only `modules/flake/lib.nix` (the definition) and the comment in
`modules/emscripten/emscripten.nix`.

- [ ] **Step 9: Use `testLinkFlagsWithoutNodeFs`**

In `engines/hangul/checks/golden/default.nix`, replace:

```nix
        # The memory root keeps writes isolated; store paths stay readable.
        linkFlags = [
          toolchain.commonFlags
        ]
        ++ lib.filter (flag: !(lib.hasSuffix "/node-host-fs.o" flag)) toolchain.testMainFlagList;
```

with:

```nix
        linkFlags = config.ibusWeb.lib.testLinkFlagsWithoutNodeFs;
```

and leave the module's arguments and `let` as they are. In `modules/engines/ibus-test.nix`, replace:

```nix
        linkFlags = [
          toolchain.commonFlags
        ]
        ++ lib.filter (flag: !(lib.hasSuffix "/node-host-fs.o" flag)) toolchain.testMainFlagList;
```

with:

```nix
        linkFlags = config.ibusWeb.lib.testLinkFlagsWithoutNodeFs;
```

- [ ] **Step 10: Use `mesonAllTestsRan`**

In `runtime/libibus-web/checks.nix`, replace:

```nix
          # Meson exits 0 for a skipped test, as when a cross file loses its
          # exe wrapper, so the summary must show tests ran and none skipped.
          meson test --no-rebuild --print-errorlogs | tee meson-summary.txt
          [ "''${PIPESTATUS[0]}" -eq 0 ]
          if ! grep -Eq '^Ok:[[:space:]]+[1-9]' meson-summary.txt ||
            grep -Eq '^(Skipped|Fail|Timeout|Unexpected Pass|Expected Fail):[[:space:]]+[1-9]' meson-summary.txt; then
            echo "libibus-web: tests did not all run and pass" >&2
            exit 1
          fi
```

with:

```nix
          ${config.ibusWeb.lib.mesonAllTestsRan "libibus-web"}
```

In `modules/glib/checks/settings-listeners/default.nix`, replace:

```nix
          meson test --no-rebuild --print-errorlogs | tee meson-summary.txt
          [ "''${PIPESTATUS[0]}" -eq 0 ]
          if ! grep -Eq '^Ok:[[:space:]]+[1-9]' meson-summary.txt ||
            grep -Eq '^(Skipped|Fail|Timeout|Unexpected Pass|Expected Fail):[[:space:]]+[1-9]' meson-summary.txt; then
            echo "GLib settings listener tests did not all run and pass" >&2
            exit 1
          fi
```

with:

```nix
          ${config.ibusWeb.lib.mesonAllTestsRan "GLib settings listeners"}
```

- [ ] **Step 11: Confirm the duplicates are gone**

```bash
git grep -n -e 'useEmscripten or false' -e 'listFilesRecursive' -e 'node-host-fs.o" flag' -e "Ok:\[\[:space" -- '*.nix'
```

Expected: every hit is in `modules/flake/lib.nix`.

- [ ] **Step 12: Compare the derivations**

In the shell from Step 1:

```bash
nix run .#write-files
nix fmt
snap "$T/after"; drvdiff "$T/before" "$T/after"
```

Expected: no `removed` or `added`; `checks.changed` is exactly `clangd`, `glib-settings-listeners`,
`hk` and `libibus-web` (the two Meson gates' scripts lost a shell comment or changed a message);
`packages.changed` is empty. Any other changed derivation means a helper doesn't reproduce what it
replaced: find it with `nix derivation show` on both paths and fix the helper, not the caller.

- [ ] **Step 13: Run the gates**

```bash
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass.

- [ ] **Step 14: Commit**

```bash
nix develop -c git add modules/flake/lib.nix modules/emscripten modules/glib runtime engines/hangul \
  modules/toolchain modules/testing/default.nix modules/engines/ibus-test.nix
nix develop -c git commit -m "refactor(nix): share the helpers modules copied as ibusWeb.lib" -- \
  modules/flake/lib.nix modules/emscripten modules/glib runtime engines/hangul modules/toolchain \
  modules/testing/default.nix modules/engines/ibus-test.nix
```

---

### Task C2: One native IBus session config for the trace checks

**Files:**

- Modify: `modules/engines/ibus-test.nix`, `engines/hangul/checks/differential/default.nix`

**Interfaces:**

- Consumes: `ibusWeb.lib` (Task C1).
- Produces:
  `ibusWeb.lib.nativeIbusConfig :: { name, engine, destination, env ? { } } -> derivation`, a JSON
  file naming a private session bus, `ibus-daemon`, the dconf config service, `gdbus`,
  `gsettings`, the `ibus-test-native` adapter, the given engine command (a list), its bus name and
  extra environment, the IBus factory path and a 5000 ms timeout: the `nativeConfig` that
  `ibusWeb.engines.ibusTest` takes.

- [ ] **Step 1: Snapshot the derivations**

```bash
snap() {
  nix eval --json .#checks.x86_64-linux --apply 'builtins.mapAttrs (_: c: c.drvPath)' > "$1-checks.json"
  nix eval --json .#packages.x86_64-linux --apply 'builtins.mapAttrs (_: p: p.drvPath)' > "$1-packages.json"
}
drvdiff() {
  for kind in checks packages; do
    echo "== $kind"
    jq -n --slurpfile a "$1-$kind.json" --slurpfile b "$2-$kind.json" '
      $a[0] as $a | $b[0] as $b |
      { removed: ([$a | keys[]] - [$b | keys[]]),
        added: ([$b | keys[]] - [$a | keys[]]),
        changed: [$a | keys[] | select($b[.] != null and $a[.] != $b[.])] }'
  done
}
T=$(mktemp -d); snap "$T/before"
```

- [ ] **Step 2: Define `nativeIbusConfig` beside `ibusTest`**

In `modules/engines/ibus-test.nix`, replace the two bindings `fixtureBus = …;` and
`fixtureConfig = …;` (from `fixtureBus = pkgs.writeText "ibus-test-conformance-bus.conf" ''`
through the `);` that closes `fixtureConfig`) with:

```nix
      # A session bus of the test's own, which admits anyone on it.
      sessionBusConfig = pkgs.writeText "ibus-web-ibus-test-session-bus.conf" ''
        <busconfig>
          <type>session</type>
          <listen>unix:tmpdir=/tmp</listen>
          <auth>EXTERNAL</auth>
          <policy context="default">
            <allow own="*"/>
            <allow send_destination="*"/>
            <allow receive_sender="*"/>
          </policy>
        </busconfig>
      '';
      # A native IBus session around one engine, as ibusTest's nativeConfig.
      nativeIbusConfig =
        {
          name,
          engine,
          destination,
          env ? { },
        }:
        pkgs.writeText "ibus-web-${name}-native-session.json" (
          builtins.toJSON {
            sessionBus = [
              "${pkgs.dbus}/bin/dbus-daemon"
              "--config-file=${sessionBusConfig}"
            ];
            daemon = [
              "${pkgs.ibus}/bin/ibus-daemon"
              "--single"
              "--emoji-extension=disable"
            ];
            daemonDestination = "org.freedesktop.IBus";
            configService = {
              command = [ "${pkgs.ibus}/libexec/ibus-dconf" ];
              destination = "org.freedesktop.IBus.Config";
            };
            adapter = [ "${native}/bin/ibus-test-native" ];
            gdbus = [ "${pkgs.glib.bin}/bin/gdbus" ];
            gsettings = [ "${pkgs.glib.bin}/bin/gsettings" ];
            factory = "/org/freedesktop/IBus/Factory";
            timeoutMs = 5000;
            inherit engine destination env;
          }
        );
      fixtureConfig = nativeIbusConfig {
        name = "ibus-test-conformance";
        engine = [ "${fixtureNative}/bin/conformance-engine" ];
        destination = "org.example.IBusConformance";
        env.GSETTINGS_SCHEMA_DIR = "${fixtureData}/glib-2.0/schemas";
      };
```

Then, in the module's result, after `ibusWeb.engines.ibusTest = ibusTest;`, add:

```nix
      ibusWeb.lib.nativeIbusConfig = nativeIbusConfig;
```

- [ ] **Step 3: Use it for Hangul's differential check**

In `engines/hangul/checks/differential/default.nix`, replace the bindings `busConfig = …;` and
`nativeConfig = …;` (from `busConfig = pkgs.writeText "ibus-test-session-bus.conf" ''` through
the `);` that closes `nativeConfig`) with:

```nix
      nativeConfig = config.ibusWeb.lib.nativeIbusConfig {
        name = "hangul";
        engine = [
          "${hangul}/libexec/ibus-engine-hangul"
          "--ibus"
        ];
        destination = "org.freedesktop.IBus.Hangul";
        env = {
          GSETTINGS_SCHEMA_DIR = "${hangul}/share/gsettings-schemas/${hangul.name}/glib-2.0/schemas";
          XDG_DATA_DIRS = "${hangul}/share:${pkgs.ibus}/share";
        };
      };
```

The `native` binding there is still used by `hangul-native-session`; keep it.

- [ ] **Step 4: Check the Hangul config's shape**

```bash
jq -S 'keys' "$(nix build --no-link --print-out-paths .#packages.x86_64-linux.ibus-test-hangul-config)"
```

Expected: `adapter`, `configService`, `daemon`, `daemonDestination`, `destination`, `engine`,
`env`, `factory`, `gdbus`, `gsettings`, `sessionBus`, `timeoutMs`: the keys the old file had.

- [ ] **Step 5: Compare the derivations**

In the shell from Step 1:

```bash
nix fmt
snap "$T/after"; drvdiff "$T/before" "$T/after"
```

Expected: `checks.changed` is `clangd`, `hangul-differential`, `hk` and `ibus-test-conformance`;
`packages.changed` is `ibus-test-hangul-config`. Nothing removed or added.

- [ ] **Step 6: Run the gates**

```bash
nix run .#write-files
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass. `hangul-differential` and `ibus-test-conformance` rebuild and pass: the bus
config is the same policy written over more lines.

- [ ] **Step 7: Commit**

```bash
nix develop -c git add modules/engines/ibus-test.nix engines/hangul/checks/differential/default.nix
nix develop -c git commit -m "refactor(nix): build native IBus session configs from one helper" -- \
  modules/engines/ibus-test.nix engines/hangul/checks/differential/default.nix
```

---
### Task C3: Name every Nix file by its role

import-tree imports every `.nix` file whatever its name, so this task only renames; no module's
meaning changes.

**Files:**

- Rename (with `git mv`):
  - `runtime/libibus-web/package.nix` → `runtime/libibus-web/module.nix`
  - `runtime/ibus-runtime/package.nix` → `runtime/ibus-runtime/module.nix`
  - `runtime/wasmfs-idb/package.nix` → `runtime/wasmfs-idb/module.nix`
  - `engines/hangul/package.nix` → `engines/hangul/module.nix`
  - `engines/hangul/checks/{differential,golden,host}/default.nix` → `…/checks.nix`
  - `modules/emscripten/emscripten.nix` → `modules/emscripten/module.nix`
  - `modules/emscripten/checks/fixes/default.nix` → `modules/emscripten/checks/fixes/checks.nix`
  - `modules/baseline-browser-mapping/default.nix` → `modules/baseline-browser-mapping/module.nix`
  - `modules/glib/checks/{autotools-tools,meson-tools,settings-listeners,smoke,tests}/default.nix`
    → `…/checks.nix`
  - `modules/glib/checks/patches.nix` → `modules/glib/checks.nix`
  - `modules/toolchain/checks/cross-toolchain.nix` → `modules/toolchain/checks.nix`
  - `modules/toolchain/checks/exnref.nix` → `modules/toolchain/checks/exnref/checks.nix`
  - `modules/toolchain/checks/exnref.py` → `modules/toolchain/checks/exnref/exnref.py`
  - `modules/toolchain/checks/meson-consumer/default.nix` →
    `modules/toolchain/checks/meson-consumer/checks.nix`
- Modify: `modules/glib/checks.nix`, `modules/toolchain/checks.nix` (relative paths),
  `docs/runtime.md`, `docs/toolchain.md`

`modules/libhangul/checks/link/default.nix` is left for Task C8, which moves it out of `modules/`.
`modules/testing/default.nix` and `modules/typescript/default.nix` are left for Tasks C10 and C11,
which split them.

- [ ] **Step 1: Snapshot the derivations**

```bash
snap() {
  nix eval --json .#checks.x86_64-linux --apply 'builtins.mapAttrs (_: c: c.drvPath)' > "$1-checks.json"
  nix eval --json .#packages.x86_64-linux --apply 'builtins.mapAttrs (_: p: p.drvPath)' > "$1-packages.json"
}
drvdiff() {
  for kind in checks packages; do
    echo "== $kind"
    jq -n --slurpfile a "$1-$kind.json" --slurpfile b "$2-$kind.json" '
      $a[0] as $a | $b[0] as $b |
      { removed: ([$a | keys[]] - [$b | keys[]]),
        added: ([$b | keys[]] - [$a | keys[]]),
        changed: [$a | keys[] | select($b[.] != null and $a[.] != $b[.])] }'
  done
}
T=$(mktemp -d); snap "$T/before"
```

- [ ] **Step 2: Rename the files**

```bash
for dir in runtime/libibus-web runtime/ibus-runtime runtime/wasmfs-idb engines/hangul; do
  git mv "$dir/package.nix" "$dir/module.nix"
done
for dir in engines/hangul/checks/differential engines/hangul/checks/golden engines/hangul/checks/host \
  modules/emscripten/checks/fixes modules/glib/checks/autotools-tools modules/glib/checks/meson-tools \
  modules/glib/checks/settings-listeners modules/glib/checks/smoke modules/glib/checks/tests \
  modules/toolchain/checks/meson-consumer; do
  git mv "$dir/default.nix" "$dir/checks.nix"
done
git mv modules/emscripten/emscripten.nix modules/emscripten/module.nix
git mv modules/baseline-browser-mapping/default.nix modules/baseline-browser-mapping/module.nix
git mv modules/glib/checks/patches.nix modules/glib/checks.nix
git mv modules/toolchain/checks/cross-toolchain.nix modules/toolchain/checks.nix
mkdir modules/toolchain/checks/exnref
git mv modules/toolchain/checks/exnref.nix modules/toolchain/checks/exnref/checks.nix
git mv modules/toolchain/checks/exnref.py modules/toolchain/checks/exnref/exnref.py
```

- [ ] **Step 3: Fix the two paths that moved a level**

In `modules/glib/checks.nix`, replace `ours = ../patches;` with `ours = ./patches;`.
In `modules/toolchain/checks.nix`, replace `src = ../probes;` with `src = ./probes;`.

- [ ] **Step 4: Confirm no module is named by anything but its role**

```bash
git ls-files '*.nix' | grep -E '/(default|package)\.nix$'
```

Expected: exactly `modules/libhangul/checks/link/default.nix`, `modules/testing/default.nix` and
`modules/typescript/default.nix`.

- [ ] **Step 5: Update the docs that name the renamed files**

In `docs/runtime.md`, replace `runtime/ibus-runtime/package.nix` with
`runtime/ibus-runtime/module.nix`. In `docs/toolchain.md`, replace
`modules/emscripten/emscripten.nix` with `modules/emscripten/module.nix`. Then:

```bash
git grep -n -e 'emscripten/emscripten\.nix' -e '/package\.nix' -e 'checks/patches\.nix' \
  -e 'cross-toolchain\.nix' -e 'exnref\.nix' -- '*.md' ':!docs/plans' ':!docs/specs'
```

Expected: no output.

- [ ] **Step 6: Compare the derivations**

In the shell from Step 1:

```bash
nix fmt
snap "$T/after"; drvdiff "$T/before" "$T/after"
```

Expected: nothing removed or added; `checks.changed` is `clangd` and `hk` only; `packages.changed`
is empty. A rename that changes another derivation means a relative path broke: fix the path.

- [ ] **Step 7: Run the gates**

```bash
nix run .#write-files
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
nix develop -c git add -A runtime engines modules/emscripten modules/baseline-browser-mapping \
  modules/glib modules/toolchain docs/runtime.md docs/toolchain.md
nix develop -c git commit -m "refactor(nix): name each module file by its role" -- runtime engines \
  modules/emscripten modules/baseline-browser-mapping modules/glib modules/toolchain docs/runtime.md \
  docs/toolchain.md
```

`git add -A` is limited to the named directories, which hold only this task's renames.

---

### Task C4: The example's Nix beside it, and the flake reading `tools/` and `examples/`

**Files:**

- Modify: `flake.nix`
- Create: `examples/hangul/module.nix`, `tools/bundle-scan/checks.nix`
- Delete: `modules/demo.nix`, `modules/playwright.nix`

**Interfaces:**

- Produces (unchanged names): `packages.demo`, `apps.demo`, `packages.playwright-integration`,
  `ibusWeb.testing.extendedChecks.playwright`, `apps.keystroke-bench`, `checks.demo`,
  `checks.bundle-scan`, and the dev shell's `IBUS_WEB_DEMO_RUNTIME`, `IBUS_WEB_DEMO_HOST` and
  `IBUS_WEB_DEMO_HANGUL`.

- [ ] **Step 1: Snapshot the derivations**

```bash
snap() {
  nix eval --json .#checks.x86_64-linux --apply 'builtins.mapAttrs (_: c: c.drvPath)' > "$1-checks.json"
  nix eval --json .#packages.x86_64-linux --apply 'builtins.mapAttrs (_: p: p.drvPath)' > "$1-packages.json"
}
drvdiff() {
  for kind in checks packages; do
    echo "== $kind"
    jq -n --slurpfile a "$1-$kind.json" --slurpfile b "$2-$kind.json" '
      $a[0] as $a | $b[0] as $b |
      { removed: ([$a | keys[]] - [$b | keys[]]),
        added: ([$b | keys[]] - [$a | keys[]]),
        changed: [$a | keys[] | select($b[.] != null and $a[.] != $b[.])] }'
  done
}
T=$(mktemp -d); snap "$T/before"
```

- [ ] **Step 2: Read `tools/` and `examples/` into the flake**

In `flake.nix`, replace:

```nix
      inputs.import-tree [
        ./modules
        ./packages
        ./runtime
        ./engines
      ]
```

with:

```nix
      inputs.import-tree [
        ./modules
        ./packages
        ./tools
        ./runtime
        ./engines
        ./examples
      ]
```

- [ ] **Step 3: Create `examples/hangul/module.nix`**

It joins what `modules/demo.nix` and `modules/playwright.nix` built, around one copy of the
workspace and one browser environment.

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
      inherit (config.ibusWeb.testing) playwright;
      workspace = typescript.workspaceFor [ "examples/hangul" ];

      # What the page loads: the runtime, the Worker host and the Hangul engine.
      env = {
        IBUS_WEB_DEMO_RUNTIME = "${config.packages.ibus-runtime}";
        IBUS_WEB_DEMO_HOST = "${workspace}/packages/worker-host/dist";
        IBUS_WEB_DEMO_HANGUL = "${config.packages.ibus-web-hangul-dist}";
      };
      exports =
        vars:
        lib.concatStringsSep "\n" (
          lib.mapAttrsToList (name: value: "export ${name}=${lib.escapeShellArg value}") vars
        );

      # A writable copy of the workspace, entered at the example.
      enterExample = ''
        cp -R ${workspace} source
        chmod -R u+w source
        cd source/examples/hangul
      '';

      demo =
        pkgs.runCommand "ibus-web-demo"
          (
            env
            // {
              nativeBuildInputs = [
                typescript.nodejs
                pkgs.pnpm
              ];
            }
          )
          ''
            ${enterExample}
            node node_modules/vite/bin/vite.js build --outDir "$out" --emptyOutDir
          '';

      # The browsers, offline, a font so text renders headless, and the built page.
      pageEnv = playwright.env // {
        IBUS_WEB_DEMO_PAGE = "${demo}";
        FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
      };
      playwrightTest = "node node_modules/playwright/cli.js test -c test/e2e/playwright.config.ts";

      integration =
        pkgs.runCommand "ibus-web-playwright-integration"
          (
            pageEnv
            // {
              nativeBuildInputs = [ typescript.nodejs ];
              CI = "1";
            }
          )
          ''
            ${playwright.setup}
            ${enterExample}
            mkdir -p "$out"
            export IBUS_WEB_TEST_REPORT=$out/results.json
            export IBUS_WEB_TEST_OUTPUT=$out/artifacts
            set -o pipefail
            timeout --kill-after=10 600 ${playwrightTest} 2>&1 | tee "$out/output.txt"
          '';
    in
    {
      packages.demo = demo;
      packages.playwright-integration = integration;
      ibusWeb.testing.extendedChecks.playwright = integration;

      apps.demo = {
        type = "app";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "ibus-web-demo";
            runtimeInputs = [
              typescript.nodejs
              pkgs.pnpm
              pkgs.git
            ];
            text = ''
              root=$(git rev-parse --show-toplevel 2>/dev/null) || {
                echo "Run this app inside the ibus-web checkout." >&2
                exit 1
              }
              cd "$root"
              if [ ! -f flake.nix ] || [ ! -f examples/hangul/package.json ]; then
                echo "Run this app inside the ibus-web checkout." >&2
                exit 1
              fi
              ${exports env}
              if [ ! -d node_modules ]; then pnpm install --frozen-lockfile; fi
              pnpm --filter '@ibus-web/example-hangul...' --filter '!@ibus-web/example-hangul' run build
              pnpm --dir examples/hangul exec vite --host 127.0.0.1 --port 5173 --strictPort "$@"
            '';
          }
        );
      };

      apps.keystroke-bench = {
        type = "app";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "ibus-web-keystroke-bench";
            runtimeInputs = [ typescript.nodejs ];
            text = ''
              ${exports pageEnv}
              run_dir=$(mktemp -d)
              trap 'rm -rf "$run_dir"' EXIT
              cd "$run_dir"
              ${enterExample}
              export IBUS_WEB_KEYSTROKE_BENCH=1
              ${playwrightTest} "$@"
            '';
          }
        );
      };

      devshells.default.env = lib.mapAttrsToList (name: value: { inherit name value; }) env;

      checks.demo =
        pkgs.runCommand "ibus-web-demo-smoke"
          (
            pageEnv
            // {
              nativeBuildInputs = [ typescript.nodejs ];
            }
          )
          ''
            ${playwright.setup}
            ${enterExample}
            timeout --kill-after=10 90 node test/smoke.ts > "$out" 2>&1 || { cat "$out"; exit 1; }
            cat "$out"
          '';
    };
}
```

- [ ] **Step 4: Create `tools/bundle-scan/checks.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) typescript;
      workspace = typescript.workspaceFor [ "tools/bundle-scan" ];
    in
    {
      # The scanner's own tests, then its scan of the demo's production page.
      checks.bundle-scan =
        pkgs.runCommand "ibus-web-bundle-scan"
          {
            nativeBuildInputs = [ typescript.nodejs ];
            IBUS_WEB_DEMO_PAGE = "${config.packages.demo}";
          }
          ''
            cp -R ${workspace} source
            chmod -R u+w source
            cd source/tools/bundle-scan
            mkdir -p "$out"
            set -o pipefail
            node node_modules/vitest/vitest.mjs run --configLoader native 2>&1 | tee "$out/tests.txt"
            export IBUS_WEB_SCAN_OUTPUT=$out
            node scan.ts 2>&1 | tee "$out/scan.txt"
            cp ${config.packages.demo}/page-bundle-graph.json "$out/demo-graph.json"
          '';
    };
}
```

- [ ] **Step 5: Delete the old modules**

```bash
git rm modules/demo.nix modules/playwright.nix
```

- [ ] **Step 6: Evaluate the outputs**

```bash
nix eval .#apps.x86_64-linux.demo.program
nix eval .#apps.x86_64-linux.keystroke-bench.program
nix eval .#checks.x86_64-linux.demo.name
nix eval .#checks.x86_64-linux.bundle-scan.name
nix develop -c bash -c 'echo "$IBUS_WEB_DEMO_RUNTIME"; echo "$IBUS_WEB_DEMO_HANGUL"'
```

Expected: two store paths ending in `/bin/ibus-web-demo` and `/bin/ibus-web-keystroke-bench`;
`"ibus-web-demo-smoke"` and `"ibus-web-bundle-scan"`; two store paths.

- [ ] **Step 7: Compare the derivations**

In the shell from Step 1:

```bash
nix fmt
snap "$T/after"; drvdiff "$T/before" "$T/after"
```

Expected: nothing removed or added. `changed` may list `demo`, `bundle-scan`, `clangd`, `hk` and
the packages `demo` and `playwright-integration`, whose scripts were reassembled; nothing else.

- [ ] **Step 8: Run the gates, and the demo by hand**

```bash
nix run .#write-files
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass; `integration-checks` includes the Playwright suites, which drive the built
demo. If a browser is at hand, also run `nix run .#demo`: it serves on `http://127.0.0.1:5173`,
and typing `gks` after Shift+Space shows 한. Stop it with Ctrl+C.

- [ ] **Step 9: Commit**

```bash
nix develop -c git add flake.nix examples/hangul/module.nix tools/bundle-scan/checks.nix
nix develop -c git commit -m "refactor(nix): keep the example's Nix beside it" -- flake.nix \
  examples/hangul/module.nix tools/bundle-scan/checks.nix modules/demo.nix modules/playwright.nix
```

---

### Task C5: Each tool's own checks beside it

The engine-building API (`castAudit`, `ibusTest`, `mkEngineManifest`, `mkSettingsMetadata`) stays
in `modules/engines/`, since engines call it. What moves is each tool's own Vitest suite, and
`modules/keys.nix`, which exists only to run the keysyms generators.

**Files:**

- Create: `tools/cast-audit/checks.nix`, `tools/ibus-test/checks.nix`,
  `tools/engine-manifest/checks.nix`, `tools/vendor-inventory/checks.nix`,
  `tools/keysyms/module.nix` (from `modules/keys.nix`)
- Modify: `modules/engines/cast-audit.nix`, `modules/engines/ibus-test.nix`,
  `modules/engines/manifest.nix`, `modules/engines/settings-metadata.nix`,
  `runtime/libibus-web/checks.nix`, `engines/hangul/checks/differential/checks.nix`,
  `modules/typescript/options.nix`, `modules/typescript/default.nix`
- Delete: `modules/keys.nix`

**Interfaces:**

- Consumes: `ibusWeb.lib.testLinkFlagsWithoutNodeFs` (Task C1), `nativeIbusConfig` (Task C2).
- Produces:
  - `ibusWeb.typescript.extraSources :: attrsOf (listOf str)`: by workspace package directory,
    the repository-relative files outside it that its build or tests read. `workspaceFor` copies
    in the files of every package it selects.
  - Check names unchanged: `engines-cast-audit-script`, `engines-cast-audit-fixture`,
    `engines-ibus-test-script`, `ibus-test-native`, `ibus-test-conformance`, `engine-manifest`,
    `settings-metadata`, `libibus-web-vendored`, `libibus-web-vendored-script`,
    `keys-generators`, `hangul-native-session`.
  - `packages.ibus-test-tools` is removed; nothing but `hangul-native-session` read it.

- [ ] **Step 1: Snapshot the derivations**

```bash
snap() {
  nix eval --json .#checks.x86_64-linux --apply 'builtins.mapAttrs (_: c: c.drvPath)' > "$1-checks.json"
  nix eval --json .#packages.x86_64-linux --apply 'builtins.mapAttrs (_: p: p.drvPath)' > "$1-packages.json"
}
drvdiff() {
  for kind in checks packages; do
    echo "== $kind"
    jq -n --slurpfile a "$1-$kind.json" --slurpfile b "$2-$kind.json" '
      $a[0] as $a | $b[0] as $b |
      { removed: ([$a | keys[]] - [$b | keys[]]),
        added: ([$b | keys[]] - [$a | keys[]]),
        changed: [$a | keys[] | select($b[.] != null and $a[.] != $b[.])] }'
  done
}
T=$(mktemp -d); snap "$T/before"
```

- [ ] **Step 2: Create `tools/cast-audit/checks.nix`**

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
      checks.engines-cast-audit-script = testing.vitestCheck {
        name = "engines-cast-audit-script";
        packageDir = "${typescript.workspaceFor [ "tools/cast-audit" ]}/tools/cast-audit";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
```

- [ ] **Step 3: Leave the audit API in `modules/engines/cast-audit.nix`**

Replace the whole file with:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) toolchain typescript;
      inherit (toolchain) pkgsWasm;
      # The audit script with its dependencies alone, so editing another
      # source reruns no audit.
      tools = typescript.workspaceFor [ "tools/cast-audit" ];
      script = "${tools}/tools/cast-audit/cast-audit.ts";
      castAudit =
        {
          name,
          src,
          sources,
          cflags ? "",
          buildInputs ? [ ],
          pkgConfigModules ? [ ],
          allowList,
        }:
        pkgsWasm.stdenv.mkDerivation {
          name = "ibus-web-${name}-cast-audit";
          inherit src buildInputs;
          nativeBuildInputs = [
            pkgsWasm.buildPackages.pkg-config
            typescript.nodejs
          ];
          dontConfigure = true;
          dontFixup = true;
          buildPhase = ''
            runHook preBuild
            reports=()
            cflags=(${cflags})
            ${lib.optionalString (pkgConfigModules != [ ]) ''
              read -r -a pkgFlags <<< "$($PKG_CONFIG --cflags ${lib.escapeShellArgs pkgConfigModules})"
              cflags+=("''${pkgFlags[@]}")
            ''}
            for source in ${lib.escapeShellArgs sources}; do
              report="$TMPDIR/casts-''${#reports[@]}.sarif"
              $CC -fsyntax-only -Wno-everything -Wcast-function-type-strict \
                -fdiagnostics-format=sarif "''${cflags[@]}" "$source" 2> "$report" || {
                cat "$report" >&2
                exit 1
              }
              reports+=("$report")
            done
            mkdir $out
            node ${script} report "''${reports[@]}" > $out/report.json 2> $out/report.txt
            cat $out/report.txt
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            node ${script} compare $out/report.json ${allowList}
            runHook postInstall
          '';
        };
      fixture = castAudit {
        name = "fixture";
        src = ../../tools/cast-audit/fixtures;
        sources = [ "casts.c" ];
        buildInputs = [ pkgsWasm.glib ];
        pkgConfigModules = [ "gobject-2.0" ];
        allowList = ../../tools/cast-audit/fixtures/allow.jsonc;
      };
    in
    {
      ibusWeb.engines.castAudit = castAudit;
      checks.engines-cast-audit-fixture = fixture.overrideAttrs {
        postInstall = ''
          if node ${script} compare $out/report.json ${../../tools/cast-audit/fixtures/empty.jsonc} \
            > $out/rejected.txt 2>&1; then
            echo "an empty allow-list incorrectly accepted the incompatible cast" >&2
            exit 1
          fi
          cat $out/rejected.txt
          # Prove the directly called zero-argument mismatch fails by itself.
          node ${tools}/tools/cast-audit/select.ts $out/report.json takes_int > $out/direct.json
          if node ${script} compare $out/direct.json ${../../tools/cast-audit/fixtures/empty.jsonc} \
            > $out/direct-rejected.txt 2>&1; then
            echo "an empty allow-list incorrectly accepted the direct-call mismatch" >&2
            exit 1
          fi
          cat $out/direct-rejected.txt
        '';
      };
    };
}
```

- [ ] **Step 4: Create `tools/ibus-test/checks.nix`**

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
      # The conformance suite skips itself here: it runs from ibusTest, with a
      # native session and a module to compare.
      checks.engines-ibus-test-script = testing.vitestCheck {
        name = "engines-ibus-test-script";
        packageDir = "${typescript.workspaceFor [ "tools/ibus-test" ]}/tools/ibus-test";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
```

Before relying on the comment, confirm it: `grep -n 'IBUS_TEST_CONFORMANCE' tools/ibus-test/conformance.test.ts`
must show the suite skipping (or describing nothing) when the variable is unset. If it throws
instead, add `vitestArgs = [ "--exclude" "conformance.test.ts" ];` and change the comment to
"The conformance suite runs from ibusTest, with a native session and a module to compare."

- [ ] **Step 5: Leave the trace-check API in `modules/engines/ibus-test.nix`**

Replace the whole file with:

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
      inherit (config.ibusWeb)
        testing
        typescript
        toolchain
        runtime
        ;
      # The trace tooling with its dependencies alone, so editing another
      # source reruns no trace check.
      tools = typescript.workspaceFor [ "tools/ibus-test" ];
      native = pkgs.stdenv.mkDerivation {
        pname = "ibus-test-native";
        version = "0.1.0";
        src = ../../tools/ibus-test/native;
        nativeBuildInputs = [
          pkgs.meson
          pkgs.ninja
          pkgs.pkg-config
        ];
        buildInputs = [
          pkgs.glib
          pkgs.json-glib
          pkgs.ibus
        ];
        nativeCheckInputs = [ pkgs.dbus ];
        doCheck = true;
        # nixpkgs otherwise disables Meson's own timeout globally.
        mesonCheckFlags = [ "--timeout-multiplier=1" ];
      };
      wasm = testing.program {
        name = "ibus-test-wasm";
        src = ../../tools/ibus-test;
        sources = [
          "wasm/main.c"
          "wasm/driver.c"
          "native/values.c"
        ];
        nativeBuildInputs = [ toolchain.pkgsWasm.pkg-config ];
        buildInputs = [
          runtime.libibusWeb
          testing.jsonGlib
        ];
        cflags = "$($PKG_CONFIG --cflags libibus-web json-glib-1.0)";
        libs = "$($PKG_CONFIG --static --libs libibus-web json-glib-1.0)";
        format = null;
        gtest = false;
        linkFlags = config.ibusWeb.lib.testLinkFlagsWithoutNodeFs;
      };
      fixtureModule =
        (runtime.mkSideModule {
          name = "conformance";
          src = ../../tools/ibus-test/fixtures;
          sources = [
            "engine.c"
            "module.c"
          ];
        }).overrideAttrs
          {
            NIX_CFLAGS_COMPILE = "-I${runtime.libibusWeb}/include/ibus-1.0";
          };
      fixtureNative = pkgs.stdenv.mkDerivation {
        name = "ibus-test-conformance-engine";
        src = ../../tools/ibus-test/fixtures;
        nativeBuildInputs = [ pkgs.pkg-config ];
        buildInputs = [ pkgs.ibus ];
        buildPhase = ''
          $CC -Wall -Wextra -Werror $(pkg-config --cflags ibus-1.0) \
            engine.c native.c $(pkg-config --libs ibus-1.0) -o conformance-engine
        '';
        installPhase = ''
          install -Dm755 conformance-engine $out/bin/conformance-engine
        '';
      };
      fixtureData =
        pkgs.runCommand "ibus-test-conformance-data"
          {
            nativeBuildInputs = [ pkgs.glib ];
          }
          ''
            mkdir -p $out/glib-2.0/schemas
            cp ${../../tools/ibus-test/fixtures/org.example.IBusConformance.gschema.xml} $out/glib-2.0/schemas/
            glib-compile-schemas $out/glib-2.0/schemas
          '';
      # A session bus of the test's own, which admits anyone on it.
      sessionBusConfig = pkgs.writeText "ibus-web-ibus-test-session-bus.conf" ''
        <busconfig>
          <type>session</type>
          <listen>unix:tmpdir=/tmp</listen>
          <auth>EXTERNAL</auth>
          <policy context="default">
            <allow own="*"/>
            <allow send_destination="*"/>
            <allow receive_sender="*"/>
          </policy>
        </busconfig>
      '';
      # A native IBus session around one engine, as ibusTest's nativeConfig.
      nativeIbusConfig =
        {
          name,
          engine,
          destination,
          env ? { },
        }:
        pkgs.writeText "ibus-web-${name}-native-session.json" (
          builtins.toJSON {
            sessionBus = [
              "${pkgs.dbus}/bin/dbus-daemon"
              "--config-file=${sessionBusConfig}"
            ];
            daemon = [
              "${pkgs.ibus}/bin/ibus-daemon"
              "--single"
              "--emoji-extension=disable"
            ];
            daemonDestination = "org.freedesktop.IBus";
            configService = {
              command = [ "${pkgs.ibus}/libexec/ibus-dconf" ];
              destination = "org.freedesktop.IBus.Config";
            };
            adapter = [ "${native}/bin/ibus-test-native" ];
            gdbus = [ "${pkgs.glib.bin}/bin/gdbus" ];
            gsettings = [ "${pkgs.glib.bin}/bin/gsettings" ];
            factory = "/org/freedesktop/IBus/Factory";
            timeoutMs = 5000;
            inherit engine destination env;
          }
        );
      fixtureConfig = nativeIbusConfig {
        name = "ibus-test-conformance";
        engine = [ "${fixtureNative}/bin/conformance-engine" ];
        destination = "org.example.IBusConformance";
        env.GSETTINGS_SCHEMA_DIR = "${fixtureData}/glib-2.0/schemas";
      };
      ibusTest =
        {
          name,
          nativeConfig,
          module,
          settingsSchemaDir,
          traces,
          expectedDifferences ? null,
          coverage ? null,
          versions ? { },
          testEnvironment ? { },
        }:
        assert pkgs.stdenv.hostPlatform.isLinux;
        assert traces != [ ];
        let
          manifest = pkgs.writeText "${name}-manifest.json" (
            builtins.toJSON {
              inherit
                nativeConfig
                traces
                expectedDifferences
                coverage
                versions
                ;
              traceNames = map (trace: lib.removeSuffix ".json" (builtins.baseNameOf trace)) traces;
              wasmCommand = [
                "${typescript.nodejs}/bin/node"
                "${wasm}/ibus-test-wasm.js"
                "--schemas"
                settingsSchemaDir
                "--module"
                module
              ];
            }
          );
          # Materialize failed runs too, so the verdict cannot discard diagnostics.
          results =
            pkgs.runCommand "ibus-web-${name}-results"
              (
                {
                  nativeBuildInputs = [ typescript.nodejs ];
                  IBUS_TEST_CONFORMANCE = manifest;
                  CI = "1";
                }
                // testEnvironment
              )
              ''
                mkdir -p $out/artifacts
                export IBUS_TEST_ARTIFACTS=$out/artifacts
                export IBUS_WEB_TEST_CACHE_DIR=$TMPDIR/vite
                export XDG_DATA_HOME=$TMPDIR/vitest-data
                status=0
                (
                  cd ${tools}/tools/ibus-test
                  timeout --kill-after=10 ${
                    toString (90 + 15 * builtins.length traces)
                  } node node_modules/vitest/vitest.mjs run \
                    --configLoader native --reporter=default --reporter=json \
                    --outputFile.json=$out/results.json conformance.test.ts
                ) > $out/output.txt 2>&1 || status=$?
                cat $out/output.txt
                printf '%s\n' "$status" > $out/status
              '';
          verdict =
            output:
            pkgs.runCommand "ibus-web-${name}"
              {
                nativeBuildInputs = [ typescript.nodejs ];
                passthru.results = output;
              }
              ''
                status=$(cat ${output}/status)
                if [ "$status" != 0 ]; then
                  echo "Trace check failed (status $status); retained results: ${output}" >&2
                  cat ${output}/output.txt >&2
                  exit 1
                fi
                node --input-type=module - ${output}/results.json <<'JS'
                import { readFileSync } from 'node:fs';
                const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
                if (result.success !== true || result.numFailedTests !== 0 || result.numPassedTests < 1) {
                  throw new Error('Trace check has no successful test report');
                }
                JS
                ln -s ${output} $out
              '';
        in
        verdict results;
      nativeClangd =
        pkgs.runCommand "ibus-test-native-clangd"
          {
            inherit (native) buildInputs;
            nativeBuildInputs = [ pkgs.pkg-config ];
          }
          ''
            {
              echo 'If:'
              echo '  PathMatch: tools/ibus-test/(native/.*|fixtures/native\.c)'
              echo 'CompileFlags:'
              echo '  Compiler: ${pkgs.stdenv.cc}/bin/cc'
              echo '  Remove: [-isystem, -fwasm-exceptions, -mextended-const]'
              echo '  Add:'
              for flag in $(pkg-config --cflags gio-2.0 json-glib-1.0 ibus-1.0); do
                echo "    - $flag"
              done
            } > $out
          '';
    in
    {
      ibusWeb.toolchain = {
        clangdPathFlags."tools/ibus-test/wasm/.*" = [ "-I${testing.jsonGlib}/include/json-glib-1.0" ];
        clangdFragments = lib.optionals pkgs.stdenv.hostPlatform.isLinux [ nativeClangd ];
        clangdQueryDrivers = lib.optionals pkgs.stdenv.hostPlatform.isLinux [ "${pkgs.stdenv.cc}/bin/cc" ];
      };
      ibusWeb.engines.ibusTest = ibusTest;
      ibusWeb.lib.nativeIbusConfig = nativeIbusConfig;
      packages = {
        ibus-test-wasm = wasm;
      }
      // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux { ibus-test-native = native; };
      checks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        ibus-test-native = native;
        ibus-test-conformance = ibusTest {
          name = "ibus-test-conformance";
          nativeConfig = fixtureConfig;
          module = "${fixtureModule}/conformance.wasm";
          settingsSchemaDir = "${fixtureData}/glib-2.0/schemas";
          traces = [ ../../tools/ibus-test/fixtures/lifecycle.json ];
          testEnvironment.IBUS_TEST_FIXTURE = "1";
        };
      };
    };
}
```

- [ ] **Step 6: Point Hangul's native-session check at the tool's package**

In `engines/hangul/checks/differential/checks.nix`, in `hangul-native-session`, replace:

```nix
          packageDir = "${config.packages.ibus-test-tools}/tools";
```

with:

```nix
          packageDir = "${config.ibusWeb.typescript.workspaceFor [ "tools/ibus-test" ]}/tools/ibus-test";
```

and its `vitestArgs = [ "ibus-test/session.test.ts" ];` with `vitestArgs = [ "session.test.ts" ];`.
(If Phase B already rewrote either line, the result must read exactly as shown.)

- [ ] **Step 7: Create `tools/engine-manifest/checks.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) runtime testing typescript;
      # A side module whose dylink section the tests read.
      fixture = runtime.mkSideModule {
        name = "manifest-fixture";
        src = ./.;
        sources = [ "fixture.c" ];
      };
    in
    {
      checks.engine-manifest =
        (testing.vitestCheck {
          name = "engine-manifest";
          packageDir = "${typescript.workspaceFor [ "tools/engine-manifest" ]}/tools/engine-manifest";
          env.IBUS_WEB_DYLINK_FIXTURE = fixture.wasm;
          inBrowsers = false;
          limit = 60;
        }).overrideAttrs
          (old: {
            nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.wabt ];
          });
    };
}
```

The check runs every test in the package. Confirm that is the three it named before:

```bash
git ls-files 'tools/engine-manifest/*.test.ts'
```

Expected: `dylink.test.ts`, `protocol.test.ts`, `symlinks.test.ts`.

- [ ] **Step 8: Remove the check from `modules/engines/manifest.nix`**

In `modules/engines/manifest.nix`, delete the `fixture = runtime.mkSideModule { … };` binding,
change `inherit (config.ibusWeb) runtime typescript testing;` to
`inherit (config.ibusWeb) runtime typescript;`, and delete the whole `checks.engine-manifest = …;`
attribute, the last in the file.

- [ ] **Step 9: Run the gschema suite from its own package**

In `modules/engines/settings-metadata.nix`, make `checks.settings-metadata` read exactly:

```nix
      checks.settings-metadata = testing.vitestCheck {
        name = "settings-metadata";
        packageDir = "${typescript.workspaceFor [ "tools/gschema" ]}/tools/gschema";
        env.IBUS_WEB_SETTINGS_FIXTURE = fixture;
        inBrowsers = false;
        limit = 60;
      };
```

It stays here because its fixture is the metadata helper this module builds.

- [ ] **Step 10: Create `tools/vendor-inventory/checks.nix`**

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
      checks.libibus-web-vendored-script = testing.vitestCheck {
        name = "libibus-web-vendored-script";
        packageDir = "${typescript.workspaceFor [ "tools/vendor-inventory" ]}/tools/vendor-inventory";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
```

- [ ] **Step 11: Keep only the inventory's use in `runtime/libibus-web/checks.nix`**

Delete the `inventoryTools = …;` binding and the `checks.libibus-web-vendored-script = …;`
attribute. Make `checks.libibus-web-vendored` read:

```nix
      checks.libibus-web-vendored = pkgs.runCommand "libibus-web-vendored" { } ''
        ${config.ibusWeb.typescript.nodejs}/bin/node \
          ${config.ibusWeb.typescript.workspaceFor [ "tools/vendor-inventory" ]}/tools/vendor-inventory/cli.ts \
          --root ${runtime.libibusWeb.src} --readme ${./src/ibus/README.md} \
          --upstream ${pkgs.ibus.src} --version ${pkgs.ibus.version} \
          --hash ${pkgs.ibus.src.outputHash} > $out
        cat $out
      '';
```

- [ ] **Step 12: Declare `extraSources`**

In `modules/typescript/options.nix`, add inside `options.ibusWeb.typescript`, after `workspace`:

```nix
      extraSources = lib.mkOption {
        type = lib.types.attrsOf (lib.types.listOf lib.types.str);
        default = { };
        description = ''
          Repository files outside a workspace package that its build or tests read, by the
          package's directory, as repository-relative paths. workspaceFor copies them in
          whenever it selects that package, at the same paths.
        '';
      };
```

- [ ] **Step 13: Read `extraSources` in `buildWorkspace`**

In `modules/typescript/default.nix`, delete the `coreNoticeInputs = [ … ];` binding. In
`buildWorkspace`, replace the `noticeInputs = …;` binding (whatever its condition reads) with:

```nix
          # Files outside the selected packages that their builds or tests read.
          extraInputs = lib.unique (
            lib.concatMap (dir: config.ibusWeb.typescript.extraSources.${dir} or [ ]) selectedDirs
          );
```

and rename its two uses, `map (file: root + "/${file}") noticeInputs` and the `noticeInputs` that
closes the install's `concatMapStrings`, to `extraInputs`. Confirm:

```bash
git grep -n -e noticeInputs -e coreNoticeInputs -- modules
```

Expected: no output.

- [ ] **Step 14: Move `modules/keys.nix` to `tools/keysyms/module.nix`**

```bash
git mv modules/keys.nix tools/keysyms/module.nix
```

Then replace its whole content with:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ inputs, ... }:
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) typescript testing;
      # DEPS.src is the exact source revision of nixpkgs' Chromium build.
      chromiumInfo = lib.importJSON (
        inputs.nixpkgs + "/pkgs/applications/networking/browsers/chromium/info.json"
      );
      chromiumRevision = chromiumInfo.chromium.DEPS.src.rev;
      domCodes = pkgs.fetchurl {
        url = "https://raw.githubusercontent.com/chromium/chromium/${chromiumRevision}/ui/events/keycodes/dom/dom_code_data.inc";
        hash = "sha256-hB4sWOY4jxRzZxfrbjZci46XZ3iONjOb8dNaN6tI5bI=";
      };
      chromiumLicense = pkgs.fetchurl {
        url = "https://raw.githubusercontent.com/chromium/chromium/${chromiumRevision}/LICENSE";
        hash = "sha256-NozKEQa+mdOezTKjjYMFWF2AKkde/7ZjgLkf/JvPcJs=";
      };
      notice =
        kind: source:
        pkgs.runCommand "${kind}-notice.txt" { } ''
          ${typescript.nodejs}/bin/node ${./notices.ts} ${kind} ${source} > $out
        '';
      xkbExport =
        pkgs.runCommand "ibus-web-us-keymap.json"
          {
            nativeBuildInputs = [
              pkgs.stdenv.cc
              pkgs.pkg-config
            ];
            buildInputs = [ pkgs.libxkbcommon ];
          }
          ''
            cc -Wall -Wextra -Werror ${./xkb-export.c} $(pkg-config --cflags --libs xkbcommon) -o exporter
            ./exporter ${pkgs.xkeyboard_config}/share/X11/xkb > $out
            XKB_CONFIG_ROOT=/nonexistent XKB_DEFAULT_LAYOUT=de XKB_DEFAULT_OPTIONS=ctrl:nocaps \
              ./exporter ${pkgs.xkeyboard_config}/share/X11/xkb > repeated.json
            cmp $out repeated.json
          '';
      nativeClangd = (pkgs.formats.yaml { }).generate "xkb-export-clangd.yaml" {
        If.PathMatch = "tools/keysyms/xkb-export\\.c";
        CompileFlags = {
          Compiler = "${pkgs.stdenv.cc}/bin/cc";
          Remove = [
            "-isystem"
            "-fwasm-exceptions"
            "-mextended-const"
          ];
          Add = [ "-I${lib.getDev pkgs.libxkbcommon}/include" ];
        };
      };
      xkbNotice = pkgs.runCommand "xkeyboard-config-COPYING.txt" { nativeBuildInputs = [ pkgs.xz ]; } ''
        tar -xOf ${pkgs.xkeyboard_config.src} xkeyboard-config-${pkgs.xkeyboard_config.version}/COPYING > $out
      '';
      keysymdef = "${pkgs.xorgproto}/include/X11/keysymdef.h";
      generate =
        name: script: source:
        pkgs.runCommand name { } ''
          ${typescript.nodejs}/bin/node ${script} ${source} \
            | ${pkgs.oxfmt}/bin/oxfmt -c ${../../.oxfmtrc.jsonc} --stdin-filepath ${name} > $out
        '';
      # The generators' inputs, which the dev shell and the generators' tests read.
      sourcesEnv = {
        IBUS_WEB_CHROMIUM_LICENSE = chromiumLicense;
        IBUS_WEB_KEYSYMDEF = keysymdef;
        IBUS_WEB_DOM_CODES = domCodes;
        IBUS_WEB_XKB_NOTICE = xkbNotice;
        IBUS_WEB_XKB_EXPORT = xkbExport;
      };
      # The licences and notices the generated tables carry, which core's packing
      # copies and the notices' tests compare.
      notices = [
        "LICENSE-MIT"
        "LICENSE-APACHE"
        "LICENSES/MIT-open-group.txt"
        "LICENSES/HPND.txt"
        "LICENSES/BSD-3-Clause.txt"
        "LICENSES/LicenseRef-xkeyboard-config.txt"
        "NOTICES/keysymdef.txt"
        "NOTICES/chromium.txt"
      ];
    in
    {
      files.file."packages/core/src/keys/keysyms.generated.ts".source =
        generate "keysyms.generated.ts" ./keysymdef.ts
          keysymdef;
      files.file."packages/core/src/keys/dom-codes.generated.ts".source =
        generate "dom-codes.generated.ts" ./dom-codes.ts
          domCodes;
      files.file."packages/core/src/keys/us.generated.ts".source =
        generate "us.generated.ts" ./us.ts
          xkbExport;
      files.file."NOTICES/keysymdef.txt".source = notice "keysymdef" keysymdef;
      files.file."NOTICES/chromium.txt".source = notice "chromium" chromiumLicense;
      files.file."LICENSES/LicenseRef-xkeyboard-config.txt".source = xkbNotice;
      ibusWeb.typescript.extraSources = {
        "packages/core" = notices;
        "tools/keysyms" = notices;
      };
      ibusWeb.toolchain = {
        clangdFragments = [ nativeClangd ];
        clangdQueryDrivers = [ "${pkgs.stdenv.cc}/bin/cc" ];
      };
      devshells.default.env = lib.mapAttrsToList (name: value: { inherit name value; }) sourcesEnv;
      checks.keys-generators =
        (testing.vitestCheck {
          name = "keys-generators";
          packageDir = "${
            typescript.workspaceFor [
              "tools/keysyms"
              "packages/core"
            ]
          }/tools/keysyms";
          limit = 120;
          inBrowsers = false;
          env = sourcesEnv // {
            # Use the pinned pnpm binary without bootstrapping another copy from npm.
            pnpm_config_pm_on_fail = "ignore";
          };
        }).overrideAttrs
          (old: {
            nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.pnpm ];
          });
    };
}
```

The generated files' header comments name the module that writes them; check whether they do:

```bash
git grep -n 'modules/keys.nix' -- ':!docs/plans' ':!docs/specs'
```

If any hit is in a generator (`tools/keysyms/*.ts`), change it to `tools/keysyms/module.nix`; the
generated files pick it up in the next step. Update any hit in `docs/` the same way.

- [ ] **Step 15: Confirm the generated files are unchanged**

```bash
nix run .#write-files
git status --short packages/core/src/keys NOTICES LICENSES
```

Expected: no output, unless Step 14 changed a header comment, in which case only those header
lines differ (`git diff` shows nothing else).

- [ ] **Step 16: Compare the derivations**

In the shell from Step 1:

```bash
nix fmt
snap "$T/after"; drvdiff "$T/before" "$T/after"
```

Expected: `packages.removed` is `ibus-test-tools`; nothing else removed or added. `changed` may
list the checks this task touched (`engines-cast-audit-*`, `engines-ibus-test-script`,
`ibus-test-conformance`, `hangul-differential`, `hangul-native-session`, `hangul-cast-audit`,
`libibus-web-cast-audit`, `engine-manifest`, `settings-metadata`, `libibus-web-vendored*`,
`keys-generators`, `clangd`, `hk`) and packages built through `castAudit`, `ibusTest` or
`workspaceFor`. Look up any other: it means a binding moved with a changed value.

- [ ] **Step 17: Run the gates**

```bash
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass.

- [ ] **Step 18: Commit**

```bash
nix develop -c git add tools/cast-audit/checks.nix tools/ibus-test/checks.nix \
  tools/engine-manifest/checks.nix tools/vendor-inventory/checks.nix tools/keysyms/module.nix \
  modules/engines modules/typescript runtime/libibus-web/checks.nix \
  engines/hangul/checks/differential/checks.nix
nix develop -c git commit -m "refactor(nix): run each tool's suite from its own package" -- \
  tools/cast-audit/checks.nix tools/ibus-test/checks.nix tools/engine-manifest/checks.nix \
  tools/vendor-inventory/checks.nix tools/keysyms modules/keys.nix modules/engines modules/typescript \
  runtime/libibus-web/checks.nix engines/hangul/checks/differential/checks.nix
```

Add to the commit any generator, generated file or doc that Steps 14 and 15 changed.

---
### Task C6: The Emscripten library checker and its types beside the tool

**Files:**

- Create: `tools/emscripten-library-deps/options.nix`, `tools/emscripten-library-deps/module.nix`
- Modify: `runtime/wasmfs-idb/module.nix`, `runtime/wasmfs-idb/checks.nix`, `runtime/options.nix`,
  `modules/testing/default.nix`, `modules/flake/hk.nix`, `docs/tooling.md`
- Delete: `runtime/wasmfs-idb/types.nix`

**Interfaces:**

- Consumes: `ibusWeb.lib.emscriptenRoot` (Task C1).
- Produces:
  - `ibusWeb.lib.libraryDeps :: string`: the checker script's store path, run as
    `node <it> check <library.js> <emscripten root>` or
    `node <it> emit <library.js> <emscripten root> <directory>`.
  - `ibusWeb.lib.emscriptenTypes :: { name, library, linkFlags ? [ ], buildInputs ? [ ] } ->
    derivation` (named `ibus-web-<name>`): `emscripten.d.ts` and the export lists for one
    JavaScript library.
  - `ibusWeb.toolchain.emscriptenTypes :: attrsOf { link :: str; package :: package; }`: each entry
    becomes `packages.<name>`, a dev-shell out-link at `link`, and a link in `checks.hk`'s tree.
  - Removed: `ibusWeb.runtime.libraryDeps`, `ibusWeb.runtime.wasmfsIdbTestLibraries`.
  - Unchanged names: `packages.wasmfs-idb-types`, `packages.gtest-main-types`,
    `checks.wasmfs-idb-types`, `checks.wasmfs-idb-acorn`, `checks.wasmfs-idb-library-deps`.

- [ ] **Step 1: Snapshot the derivations**

```bash
snap() {
  nix eval --json .#checks.x86_64-linux --apply 'builtins.mapAttrs (_: c: c.drvPath)' > "$1-checks.json"
  nix eval --json .#packages.x86_64-linux --apply 'builtins.mapAttrs (_: p: p.drvPath)' > "$1-packages.json"
}
drvdiff() {
  for kind in checks packages; do
    echo "== $kind"
    jq -n --slurpfile a "$1-$kind.json" --slurpfile b "$2-$kind.json" '
      $a[0] as $a | $b[0] as $b |
      { removed: ([$a | keys[]] - [$b | keys[]]),
        added: ([$b | keys[]] - [$a | keys[]]),
        changed: [$a | keys[] | select($b[.] != null and $a[.] != $b[.])] }'
  done
}
T=$(mktemp -d); snap "$T/before"
```

- [ ] **Step 2: Create `tools/emscripten-library-deps/options.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.toolchain.emscriptenTypes = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            link = lib.mkOption {
              type = lib.types.str;
              description = "Where in the repository the types are linked: beside the library, where its type check reads them. hk.pkl's nixInputs must list it.";
            };
            package = lib.mkOption {
              type = lib.types.package;
              description = "The types, from ibusWeb.lib.emscriptenTypes.";
            };
          };
        }
      );
      default = { };
      description = "Types generated for Emscripten JavaScript libraries, by name. Each is a flake package of that name, linked at its link when the dev shell starts and in the tree checks.hk runs over.";
    };
  };
}
```

- [ ] **Step 3: Create `tools/emscripten-library-deps/module.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      system,
      ...
    }:
    let
      inherit (config.ibusWeb) testing toolchain typescript;
      inherit (config.ibusWeb.lib) emscriptenRoot;

      # The checker with its package's manifest, which makes it a module, and
      # the dependencies it imports, and nothing else of the workspace, so
      # editing another source rebuilds nothing that runs it.
      checker = pkgs.runCommand "ibus-web-emscripten-library-deps" { } ''
        mkdir $out
        cp ${./library-deps.ts} $out/library-deps.ts
        cp ${./package.json} $out/package.json
        ln -s ${typescript.packageNodeModules ./.} $out/node_modules
      '';
      libraryDeps = "${checker}/library-deps.ts";

      # Types for what a JavaScript library uses from Emscripten, from a link
      # that exports exactly that: Emscripten's own declarations, which
      # --emit-tsd runs tsc over, and globals.d.ts, which declares each export
      # as the global the library's code sees.
      emscriptenTypes =
        {
          name,
          library,
          linkFlags ? [ ],
          buildInputs ? [ ],
        }:
        toolchain.pkgsWasm.stdenv.mkDerivation {
          name = "ibus-web-${name}";
          dontUnpack = true;
          nativeBuildInputs = [
            typescript.nodejs
            typescript.tsc
          ];
          inherit buildInputs;
          dontFixup = true;
          buildPhase = ''
            runHook preBuild
            node ${libraryDeps} emit ${library} ${emscriptenRoot} $out
            $CXX -sASSERTIONS=1 ${lib.escapeShellArgs linkFlags} --no-entry --js-library=${library} \
              -sEXPORTED_RUNTIME_METHODS=$(cat $out/exported-runtime-methods.txt) \
              -sEXPORTED_FUNCTIONS=$(cat $out/exported-functions.txt) \
              --emit-tsd $out/emscripten.d.ts -o probe.js
            runHook postBuild
          '';
          dontInstall = true;
        };
    in
    {
      ibusWeb.lib = { inherit libraryDeps emscriptenTypes; };

      packages = lib.mapAttrs (_: types: types.package) toolchain.emscriptenTypes;

      # Built when the shell starts rather than as part of it, so the shell
      # still enters while a library doesn't build. The out-links keep the
      # types from garbage collection.
      devshells.default.devshell.startup = lib.mapAttrs (name: types: {
        text = ''
          rm -f "$FLAKE_ROOT/${types.link}"
          nix build "$FLAKE_ROOT#packages.${system}.${name}" --out-link "$FLAKE_ROOT/${types.link}" ||
            echo "${name} unavailable" >&2
        '';
      }) toolchain.emscriptenTypes;

      # The checker itself, over small libraries and over Emscripten's tree
      # with its rules changed.
      checks.wasmfs-idb-library-deps = testing.programs {
        name = "wasmfs-idb-library-deps";
        environments = [ "node" ];
        programs = [ ];
        nodeTests = ./.;
        nodeTestData = {
          inherit libraryDeps;
          emscripten = emscriptenRoot;
        };
      };
    };
}
```

- [ ] **Step 4: Register the backend's types in `runtime/wasmfs-idb/module.nix`**

Insert, before `packages.wasmfs-idb = wasmfsIdb;`:

```nix
      # What the backend's JavaScript library uses from Emscripten, for its type
      # check.
      ibusWeb.toolchain.emscriptenTypes.wasmfs-idb-types = {
        link = "runtime/wasmfs-idb/src/emscripten-types";
        package = config.ibusWeb.lib.emscriptenTypes {
          name = "wasmfs-idb-types";
          library = wasmfsIdb.jsLibrary;
          linkFlags = [
            "-sWASMFS=1"
            "-lwasmfs-idb"
          ];
          buildInputs = [ wasmfsIdb ];
        };
      };
```

If Phase B moved the backend's type-check config so that it reads its types from somewhere other
than `src/emscripten-types`, use that path for `link` here, in Step 6 and in `hk.pkl`.

- [ ] **Step 5: Make the test libraries a `let` of `runtime/wasmfs-idb/checks.nix`**

In `runtime/wasmfs-idb/checks.nix`, replace `testLibraries = runtime.wasmfsIdbTestLibraries;` with:

```nix
      # The JavaScript libraries the test programs link besides the backend's
      # own; each one's __deps are checked and it is type-checked.
      testLibraries = [
        ./tests/chunk-counts.js
        ./tests/faults.js
        ./tests/strict-commits.js
      ];
```

and delete the attribute `ibusWeb.runtime.wasmfsIdbTestLibraries = [ … ];`. Change the module's
arguments from `{ config, lib, ... }` to:

```nix
    {
      config,
      lib,
      pkgs,
      ...
    }:
```

and add `typescript` to its `inherit (config.ibusWeb) runtime testing;` line.

- [ ] **Step 6: Move the type checks from `types.nix` into `checks.nix`**

Move these from `runtime/wasmfs-idb/types.nix` into `runtime/wasmfs-idb/checks.nix`, verbatim
with their comments, bindings into the `let`, attributes into the result:

- the bindings `root`, `sources`, `sourcePath` and `here`;
- the attributes `checks.wasmfs-idb-acorn` and `checks.wasmfs-idb-types`.

Then make these substitutions in what moved:

| Replace | With |
| --- | --- |
| `runtime.wasmfsIdbTestLibraries` (in `sources` and in the `for library in` loop) | `testLibraries` |
| `${libraryDeps}` (each occurrence) | `${config.ibusWeb.lib.libraryDeps}` |
| `ln -s ${types} src/${typesDir}` | `ln -s ${config.ibusWeb.toolchain.emscriptenTypes.wasmfs-idb-types.package} src/emscripten-types` |

If `emscriptenRoot` is used in what moved (Task C1 put it there), add
`inherit (config.ibusWeb.lib) emscriptenRoot;` to the `let`. Then delete the file:

```bash
git rm runtime/wasmfs-idb/types.nix
```

- [ ] **Step 7: Remove the two runtime options**

In `runtime/options.nix`, delete the `wasmfsIdbTestLibraries = lib.mkOption { … };` and
`libraryDeps = lib.mkOption { … };` declarations.

- [ ] **Step 8: Build the GoogleTest report library's types with the helper**

In `modules/testing/default.nix`:

1. Replace `inherit (config.ibusWeb.runtime) libraryDeps;` with
   `inherit (config.ibusWeb.lib) libraryDeps;`.
2. Replace the whole `reportTypes = pkgsWasm.stdenv.mkDerivation { … };` binding, with the comment
   above it, by:

   ```nix
      # Types for what the report library uses from Emscripten, from a link
      # that exports exactly that.
      reportTypes = config.ibusWeb.lib.emscriptenTypes {
        name = "gtest-main-types";
        library = reportLibrary;
      };
   ```

3. Delete `packages.gtest-main-types = reportTypes;`, and the dev-shell startup block from its
   comment `# Built when the shell starts rather than as part of it, …` through the `'';` closing
   `devshells.default.devshell.startup.gtest-main-types.text`.
4. Add, after `ibusWeb.toolchain.clangdPathFlags."modules/testing/.*\\.(cpp|h)" = gtestCflagList;`:

   ```nix
      ibusWeb.toolchain.emscriptenTypes.gtest-main-types = {
        link = "modules/testing/gtest-main/${typesDir}";
        package = reportTypes;
      };
   ```

- [ ] **Step 9: Link the registered types in `checks.hk`**

In `modules/flake/hk.nix`, delete:

```nix
      # Where the JavaScript libraries' type checks find their generated
      # types.
      wasmfsIdbTypesLink = "runtime/wasmfs-idb/src/emscripten-types";
      gtestMainTypesLink = "modules/testing/gtest-main/emscripten-types";
```

and replace:

```nix
            ln -s ${config.packages.wasmfs-idb-types} ${wasmfsIdbTypesLink}
            ln -s ${config.packages.gtest-main-types} ${gtestMainTypesLink}
```

with:

```nix
            ${lib.concatStrings (
              lib.mapAttrsToList (_: types: ''
                grep -qF '"${types.link}"' hk.pkl || {
                  echo "hk.pkl's nixInputs lacks ${types.link}" >&2
                  exit 1
                }
                ln -s ${types.package} ${types.link}
              '') toolchain.emscriptenTypes
            )}
```

`hk.pkl` stays as it is: its `nixInputs` already lists both links, and the check now fails if a
registered link is missing from it.

- [ ] **Step 10: Update the doc that names the option**

In `docs/tooling.md`, replace `` (`ibusWeb.runtime.libraryDeps`: `` with
`` (`ibusWeb.lib.libraryDeps`: ``. Then:

```bash
git grep -n -e 'runtime.libraryDeps' -e 'wasmfsIdbTestLibraries' -e 'wasmfs-idb/types.nix' -- \
  ':!docs/plans' ':!docs/specs'
```

Expected: no output.

- [ ] **Step 11: Check the dev shell still links both**

```bash
nix develop -c true
ls -l runtime/wasmfs-idb/src/emscripten-types modules/testing/gtest-main/emscripten-types
```

Expected: both are symlinks into the store, each holding `emscripten.d.ts`.

- [ ] **Step 12: Compare the derivations**

In the shell from Step 1:

```bash
nix run .#write-files
nix fmt
snap "$T/after"; drvdiff "$T/before" "$T/after"
```

Expected: nothing removed or added. `changed` may list `wasmfs-idb-types`, `gtest-main-library`,
`wasmfs-idb-library-deps`, `clangd` and `hk`, and the packages `wasmfs-idb-types` and
`gtest-main-types` (their build scripts now come from one helper); nothing else.

- [ ] **Step 13: Run the gates**

```bash
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass.

- [ ] **Step 14: Commit**

```bash
nix develop -c git add tools/emscripten-library-deps/options.nix tools/emscripten-library-deps/module.nix \
  runtime/wasmfs-idb runtime/options.nix modules/testing/default.nix modules/flake/hk.nix docs/tooling.md
nix develop -c git commit -m "refactor(nix): keep the Emscripten library checker and its types with the tool" -- \
  tools/emscripten-library-deps runtime/wasmfs-idb runtime/options.nix modules/testing/default.nix \
  modules/flake/hk.nix docs/tooling.md
```

---

### Task C7: Options beside what sets them; dead options gone

**Files:**

- Create: `runtime/libibus-web/options.nix`, `runtime/wasmfs-idb/options.nix`,
  `runtime/ibus-runtime/options.nix`, `engines/hangul/options.nix`
- Delete: `runtime/options.nix`
- Rename: `modules/testing/json-glib.nix` → `modules/engines/json-glib.nix`
- Modify: `modules/engines/options.nix`, `modules/engines/json-glib.nix`,
  `modules/engines/ibus-test.nix`, `modules/engines/settings-metadata.nix`,
  `packages/protocol/module.nix`, `runtime/libibus-web/archives.nix`, `docs/runtime.md`,
  `docs/protocol.md`

**Interfaces:**

- Option paths unchanged except `ibusWeb.testing.jsonGlib` → `ibusWeb.engines.jsonGlib`.
- `installArchives`'s description lists every archive and listing it holds.

- [ ] **Step 1: Snapshot the derivations**

```bash
snap() {
  nix eval --json .#checks.x86_64-linux --apply 'builtins.mapAttrs (_: c: c.drvPath)' > "$1-checks.json"
  nix eval --json .#packages.x86_64-linux --apply 'builtins.mapAttrs (_: p: p.drvPath)' > "$1-packages.json"
}
drvdiff() {
  for kind in checks packages; do
    echo "== $kind"
    jq -n --slurpfile a "$1-$kind.json" --slurpfile b "$2-$kind.json" '
      $a[0] as $a | $b[0] as $b |
      { removed: ([$a | keys[]] - [$b | keys[]]),
        added: ([$b | keys[]] - [$a | keys[]]),
        changed: [$a | keys[] | select($b[.] != null and $a[.] != $b[.])] }'
  done
}
T=$(mktemp -d); snap "$T/before"
```

- [ ] **Step 2: Create `runtime/libibus-web/options.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.runtime = {
      libibusWeb = lib.mkOption {
        type = lib.types.package;
        description = "libibus-web for pkgsWasm: the static library the Worker host drives, its header and its pkg-config file.";
      };
      installArchives = lib.mkOption {
        type = lib.types.package;
        description = "Archives for testing engine data installs: tree.tar, a deterministic ustar of nested directories and files spanning several storage chunks, and tree-upgrade.tar, the next version's tree built the same way; listing.txt and listing-upgrade.txt, their listings, one `PATH<TAB>d` or `PATH<TAB>f SIZE SHA256` line per entry, sorted bytewise; tree.json, tree.tar's version (from its bytes), its unpacked size in bytes and its listing, with the same for tree-upgrade.tar under `upgrade`; and archives the installer must refuse: absolute.tar, dotdot.tar, symlink.tar, hardlink.tar, fifo.tar (each a valid file, then the refused member) and corrupt.tar (tree.tar with a header's checksum broken).";
      };
    };
  };
}
```

Before keeping that description, confirm it against what the archives build writes:

```bash
drv=$(nix derivation show .#checks.x86_64-linux.libibus-web |
  jq -r '[.. | objects | .inputDrvs? // empty | keys[]] | .[] | select(endswith("-ibus-web-install-archives.drv"))')
case $drv in /*) ;; *) drv=/nix/store/$drv ;; esac
out=$(nix build --no-link --print-out-paths "$drv^out")
ls "$out"; jq 'keys' "$out/tree.json"
```

Expected files: `absolute.tar`, `corrupt.tar`, `dotdot.tar`, `fifo.tar`, `hardlink.tar`,
`listing-upgrade.txt`, `listing.txt`, `symlink.tar`, `tree-upgrade.tar`, `tree.json`, `tree.tar`;
`tree.json`'s keys include `upgrade`. If the list differs, make the description name exactly what
is there.

- [ ] **Step 3: Create `runtime/wasmfs-idb/options.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.runtime.wasmfsIdb = lib.mkOption {
      type = lib.types.package;
      description = "The WasmFS IndexedDB backend: libwasmfs-idb.a and its header, with passthru.jsLibrary, the JavaScript library its links pass with --js-library, and passthru.cflags, the -I flag for the WasmFS internal headers it was compiled against.";
    };
  };
}
```

- [ ] **Step 4: Create `runtime/ibus-runtime/options.nix`**

It holds the rest of `runtime/options.nix`, verbatim. Write the file as:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.runtime = {
    };
  };
}
```

and move into the empty `options.ibusWeb.runtime = { };`, verbatim and in their current order, the
declarations `runtime/options.nix` still holds after removing `libibusWeb`, `wasmfsIdb` and
`installArchives`: `ibusRuntime`, `constants`, `ibusRuntimeAsserting`, `threadPool`, `memory`,
`linkFlags`, `exportList`, `checkSideModuleImports`, `mkSideModule`, `sideModuleLibraryGuard` and
`nodeHarness`. Then:

```bash
git rm runtime/options.nix
nix eval .#checks.x86_64-linux.ibus-runtime-load.name
```

Expected: `"ibus-web-test-programs-ibus-runtime-load"`; an "option does not exist" error means a
declaration was dropped.

- [ ] **Step 5: Fix the archives module's comment**

In `runtime/libibus-web/archives.nix`, replace:

```nix
      # tree.tar is uncompressed ustar as engines ship their data, built so
      # that the same tree always gives the same bytes; its version is
      # derived from those bytes, so changing the tree changes it.
      # tree-upgrade.tar is the next version's, built the same way.
```

with:

```nix
      # tree.tar is uncompressed ustar as engines ship their data, built so
      # that the same tree always gives the same bytes; its version is
      # derived from those bytes, so changing the tree changes it.
      # tree-upgrade.tar is the next version's, built the same way. tree.json
      # describes tree.tar and, under `upgrade`, tree-upgrade.tar; the rest
      # are archives the installer must refuse.
```

- [ ] **Step 6: Declare Hangul's option with Hangul**

Create `engines/hangul/options.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.engines.hangul = lib.mkOption {
      type = lib.types.package;
      description = "The Hangul side module with data-only store references.";
    };
  };
}
```

and delete these lines from `modules/engines/options.nix`:

```nix
    options.ibusWeb.engines.hangul = lib.mkOption {
      type = lib.types.package;
      description = "The Hangul side module with data-only store references.";
    };
```

- [ ] **Step 7: Move json-glib to the engine modules**

```bash
git mv modules/testing/json-glib.nix modules/engines/json-glib.nix
```

In it, replace the option declaration:

```nix
    options.ibusWeb.testing.jsonGlib = lib.mkOption {
      type = lib.types.package;
      description = "json-glib built for WebAssembly, with which C fixture producers write JSON. The runtime never links it.";
    };
```

with:

```nix
    options.ibusWeb.engines.jsonGlib = lib.mkOption {
      type = lib.types.package;
      description = "json-glib built for WebAssembly, with which engines' settings metadata and C test fixtures write JSON. The runtime never links it.";
    };
```

and `ibusWeb.testing.jsonGlib = pkgsWasm.stdenv.mkDerivation {` with
`ibusWeb.engines.jsonGlib = pkgsWasm.stdenv.mkDerivation {`. Then replace every `testing.jsonGlib`
with `config.ibusWeb.engines.jsonGlib` in `modules/engines/ibus-test.nix`,
`modules/engines/settings-metadata.nix` and `packages/protocol/module.nix` (two in each), and in
`docs/protocol.md` replace `` `ibusWeb.testing.jsonGlib` `` with `` `ibusWeb.engines.jsonGlib` ``.

```bash
git grep -n 'testing.jsonGlib' -- ':!docs/plans' ':!docs/specs'
```

Expected: no output.

- [ ] **Step 8: Update the runtime page**

In `docs/runtime.md`, replace `` (`runtime/options.nix`). `` with
`` (each part's `options.nix`). ``

- [ ] **Step 9: Compare the derivations**

In the shell from Step 1:

```bash
nix run .#write-files
nix fmt
snap "$T/after"; drvdiff "$T/before" "$T/after"
```

Expected: nothing removed or added; `checks.changed` is `clangd` and `hk`; `packages.changed` is
empty. The description and the archives comment are not in any derivation.

- [ ] **Step 10: Run the gates**

```bash
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass.

- [ ] **Step 11: Commit**

```bash
nix develop -c git add runtime engines/hangul/options.nix modules/engines modules/testing \
  packages/protocol/module.nix docs/runtime.md docs/protocol.md
nix develop -c git commit -m "refactor(nix): declare each option beside what sets it" -- runtime \
  engines/hangul/options.nix modules/engines modules/testing/json-glib.nix packages/protocol/module.nix \
  docs/runtime.md docs/protocol.md
```

---

### Task C8: libhangul joins the Hangul engine

The libhangul patch exists for `hangul.wasm`, and its link check tested nixpkgs' unpatched
library. After this task the patch lives with the engine, `pkgsWasm.libhangul` is the patched
library, and the link check builds against what the engine links.

**Files:**

- Rename: `modules/libhangul/patches/0001-buffer-hanja-dictionary-reads.patch` →
  `engines/hangul/patches/libhangul/0001-buffer-hanja-dictionary-reads.patch`;
  `modules/libhangul/checks/link/default.nix` → `engines/hangul/checks/libhangul-link/checks.nix`;
  `modules/libhangul/checks/link/libhangul-test.c` →
  `engines/hangul/checks/libhangul-link/libhangul-test.c`
- Modify: `engines/hangul/overlay.nix`, `engines/hangul/checks/libhangul-link/checks.nix`,
  `engines/hangul/checks/libhangul-link/libhangul-test.c`, `engines/hangul/patches/README.md`,
  `REUSE.toml`, `docs/toolchain.md`

**Interfaces:**

- `pkgsWasm.libhangul` is the patched library, with a `data` output. `ibus-engines.hangul`'s
  `passthru.libhangul` is the same derivation.
- `checks.libhangul-wasm` keeps its name until Task C12.

- [ ] **Step 1: Move the files**

```bash
mkdir -p engines/hangul/patches/libhangul engines/hangul/checks/libhangul-link
git mv modules/libhangul/patches/0001-buffer-hanja-dictionary-reads.patch engines/hangul/patches/libhangul/
git mv modules/libhangul/checks/link/default.nix engines/hangul/checks/libhangul-link/checks.nix
git mv modules/libhangul/checks/link/libhangul-test.c engines/hangul/checks/libhangul-link/
test ! -e modules/libhangul || find modules/libhangul -type f
```

Expected: the last command prints nothing.

- [ ] **Step 2: Patch libhangul for every WebAssembly consumer**

In `engines/hangul/overlay.nix`, inside `lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) {`,
add before `ibus-engines = prev.ibus-engines // {`:

```nix
        # Patched for everything that links it, so a check of the library
        # tests what hangul.wasm ships. Its data goes to an output of its own,
        # which engine distributions carry without the library.
        libhangul = prev.libhangul.overrideAttrs (old: {
          patches = (old.patches or [ ]) ++ patchesIn ./patches/libhangul;
          outputs = (old.outputs or [ "out" ]) ++ [ "data" ];
          configureFlags = (old.configureFlags or [ ]) ++ [
            "--datadir=${placeholder "data"}/share"
            "--localedir=${placeholder "data"}/share/locale"
          ];
        });
```

and replace the `libhangul = final.libhangul.overrideAttrs (old: { … });` binding inside
`hangul = let …` (the one that names `../../modules/libhangul/patches/…`) with:

```nix
              inherit (final) libhangul;
```

- [ ] **Step 3: Put the link check under the engine's licence**

`REUSE.toml` licenses everything under `engines/hangul/` as GPL-2.0-or-later, overriding headers.
Make the moved files say so: in `engines/hangul/checks/libhangul-link/checks.nix` change the
second line to `# SPDX-License-Identifier: GPL-2.0-or-later`, and in
`engines/hangul/checks/libhangul-link/libhangul-test.c` change
` * SPDX-License-Identifier: MIT OR Apache-2.0 */` to ` * SPDX-License-Identifier: GPL-2.0-or-later */`.

- [ ] **Step 4: Keep the libhangul patch under libhangul's licence**

In `REUSE.toml`, delete:

```toml
[[annotations]]
path = "modules/libhangul/patches/*.patch"
SPDX-FileCopyrightText = ["2005-2009 Choe Hwanjin", "2026 Synapdeck, Inc."]
SPDX-License-Identifier = "LGPL-2.1-or-later"
```

and insert, directly after the `engines/hangul/patches/**/*.patch` annotation near the top:

```toml

# libhangul's own licence, which the engine-wide annotations above would
# otherwise override; the last matching annotation wins.
[[annotations]]
path = "engines/hangul/patches/libhangul/*.patch"
SPDX-FileCopyrightText = ["2005-2009 Choe Hwanjin", "2026 Synapdeck, Inc."]
SPDX-License-Identifier = "LGPL-2.1-or-later"
precedence = "override"
```

Check that REUSE reads it that way:

```bash
nix develop -c reuse lint
nix develop -c reuse spdx | grep -A6 'FileName: ./engines/hangul/patches/libhangul/' | grep LicenseConcluded
nix develop -c reuse spdx | grep -A6 'FileName: ./engines/hangul/patches/port/0001' | grep LicenseConcluded
```

Expected: lint passes; the libhangul patch concludes `LGPL-2.1-or-later` and the port patch
`GPL-2.0-or-later`. If the libhangul patch shows GPL, move its annotation to the end of
`REUSE.toml` and check again.

- [ ] **Step 5: Describe the layer in the engine's patch README**

In `engines/hangul/patches/README.md`, after the paragraph ending "The casts patch also adds the
2026 Synapdeck copyright notice for these changes. …" (before the table), add:

```markdown
`libhangul/` patches the library rather than the engine, and applies to every WebAssembly build of
libhangul: `0001` buffers the Hanja dictionary's two loading scans with a 64 KiB stdio buffer, so
reads that would each cross into the IndexedDB backend's thread and transaction are batched. It is
LGPL-2.1-or-later, as libhangul is.
```

- [ ] **Step 6: Update the toolchain page**

In `docs/toolchain.md`, the layout bullet names `` `modules/libhangul/` `` among the components
the page covers; delete it from that list (`` `modules/toolchain/`, `modules/emscripten/`,
`modules/glib/`, `modules/libhangul/` and `` becomes `` `modules/toolchain/`, `modules/emscripten/`,
`modules/glib/` and ``). Then:

```bash
git grep -n 'modules/libhangul' -- ':!docs/plans' ':!docs/specs'
```

Expected: no output.

- [ ] **Step 7: Build the link check against the patched library**

```bash
nix build -L .#checks.x86_64-linux.libhangul-wasm
nix eval --raw .#legacyPackages.x86_64-linux.pkgsWasm.libhangul.drvPath
nix eval --raw .#packages.x86_64-linux.ibus-web-hangul.passthru.libhangul.drvPath
```

Expected: the check passes and prints `preedit U+D55C`; the two `drvPath`s are equal.

If the check fails, that is a real difference between the patched and unpatched library, which
this task exists to surface. Do not point the check back at the unpatched library. Stop, use
superpowers:systematic-debugging on the failure, and report it before continuing.

- [ ] **Step 8: Run the gates**

```bash
nix run .#write-files
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass. `ibus-runtime-load`'s Hangul side module now links the patched library and
must still pass.

- [ ] **Step 9: Commit**

```bash
nix develop -c git add engines/hangul REUSE.toml docs/toolchain.md
nix develop -c git commit -m "refactor(hangul): patch libhangul with the engine and check what it links" -- \
  engines/hangul modules/libhangul REUSE.toml docs/toolchain.md
```

---

### Task C9: Emscripten's dev-shell setup with Emscripten; one clangd configuration

**Files:**

- Create: `modules/emscripten/dev-shell.nix`
- Modify: `modules/flake/dev-shell.nix`, `runtime/libibus-web/module.nix`,
  `runtime/wasmfs-idb/module.nix`, `runtime/wasmfs-idb/checks.nix`,
  `modules/toolchain/checks/meson-consumer/checks.nix`
- Delete: `runtime/libibus-web/.clangd`, `runtime/wasmfs-idb/.clangd`,
  `modules/toolchain/checks/meson-consumer/src/.clangd`

**Interfaces:**

- The dev shell's `FLAKE_ROOT` is set before every other variable, so any module's `eval` may use it.
- The generated `.clangd` gives the three directories the flags their own `.clangd` files gave.

- [ ] **Step 1: Set `FLAKE_ROOT` first, and keep only the shell's own setup**

Replace the `perSystem` of `modules/flake/dev-shell.nix` with:

```nix
  perSystem =
    { config, lib, ... }:
    {
      # First, so other modules' variables may be set from it.
      devshells.default.env = lib.mkBefore [
        {
          name = "FLAKE_ROOT";
          eval = "$(${lib.getExe config.flake-root.package})";
        }
      ];
    };
```

- [ ] **Step 2: Create `modules/emscripten/dev-shell.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) toolchain;
    in
    {
      devshells.default = {
        packages = [ toolchain.emscripten ];
        env = [
          {
            name = "EM_CACHE";
            eval = "$FLAKE_ROOT/.emcache";
          }
        ];
        # A writable cache in the checkout, seeded from the prebuilt one.
        devshell.startup.emscripten-cache.text = ''
          if [ ! -d "$EM_CACHE" ]; then
            cp -r --no-preserve=mode ${toolchain.emscriptenCache} "$EM_CACHE"
          fi
        '';
      };
    };
}
```

- [ ] **Step 3: Check the shell**

```bash
nix develop -c bash -c 'echo "$FLAKE_ROOT"; echo "$EM_CACHE"; command -v emcc'
```

Expected: the checkout's path, the same path followed by `/.emcache`, and a store path ending in
`/bin/emcc`.

- [ ] **Step 4: Move the in-tree `.clangd` flags into the generated configuration**

clangd runs a loose source's fallback command in the source's directory, so these relative paths
mean what they meant in each directory's own `.clangd`.

In `runtime/libibus-web/module.nix`, replace the whole `ibusWeb.toolchain.clangdPathFlags."runtime/libibus-web/src/ibus/.*" = [ … ];`
attribute, with its comment, by:

```nix
      ibusWeb.toolchain.clangdPathFlags = {
        # The in-tree headers, ahead of the installed library's.
        "runtime/libibus-web/(src|tests)/[^/]+" = [
          "-I../include"
          "-I../include/ibus-1.0"
        ];
        # The IBus layer is compiled as IBus itself, with its private generated
        # header, which engines never get with the library.
        "runtime/libibus-web/src/ibus/.*" = [
          "-DIBUS_COMPILATION"
          "-I../../include/ibus-1.0"
          "-I../../include"
          "-I${
            libibus-web.overrideAttrs {
              pname = "libibus-web-private-headers";
              buildPhase = "ninja src/ibus/ibusmarshalers.h";
              installPhase = "install -Dm644 -t $out src/ibus/ibusmarshalers.h";
              dontFixup = true;
            }
          }"
        ];
        "runtime/libibus-web/include/ibus-1.0/.*" = [ "-DIBUS_COMPILATION" ];
      };
```

In `runtime/wasmfs-idb/module.nix`, change the `"runtime/wasmfs-idb/src/.*"` entry of
`clangdPathFlags` to:

```nix
        # The in-tree header, ahead of an installed copy.
        "runtime/wasmfs-idb/src/.*" = [
          "-std=c++17"
          "-I../include"
          cflags
        ];
```

In `runtime/wasmfs-idb/checks.nix`, change the tests' entry to:

```nix
      ibusWeb.toolchain.clangdPathFlags."runtime/wasmfs-idb/tests/.*\\.(cpp|h)" = [
        "-std=c++17"
        "-I../include"
        wasmfsIdb.cflags
      ]
      ++ testing.gtestCflagList;
```

In `modules/toolchain/checks/meson-consumer/checks.nix`, add after
`ibusWeb.toolchain.devLibraries = [ … ];`:

```nix
      # The build sets this through the recipe's NIX_CFLAGS_COMPILE.
      ibusWeb.toolchain.clangdPathFlags."modules/toolchain/checks/meson-consumer/src/.*" = [
        "-DIBUS_WEB_RECIPE_CFLAGS"
      ];
```

Then delete the checked-in files:

```bash
git rm runtime/libibus-web/.clangd runtime/wasmfs-idb/.clangd modules/toolchain/checks/meson-consumer/src/.clangd
git ls-files '*.clangd' '**/.clangd'
```

Expected: the second command prints nothing.

- [ ] **Step 5: Check every source still parses for the editor**

```bash
nix build -L .#checks.x86_64-linux.clangd
nix develop -c clangd --check=runtime/libibus-web/src/ibus/ibusengine.c --check-locations=false 2>&1 | grep -c '^E\['
```

Expected: the check passes; the count is `0`.

- [ ] **Step 6: Run the gates**

```bash
nix run .#write-files
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
nix develop -c git add modules/emscripten/dev-shell.nix modules/flake/dev-shell.nix runtime \
  modules/toolchain/checks/meson-consumer
nix develop -c git commit -m "refactor(nix): set up Emscripten's shell with Emscripten and generate every clangd flag" -- \
  modules/emscripten/dev-shell.nix modules/flake/dev-shell.nix runtime modules/toolchain/checks/meson-consumer
```

---
### Task C10: Split `modules/typescript/default.nix` by job

`default.nix` generates `pnpm-workspace.yaml`, installs and builds the workspace, and wraps `tsc`.
Each job becomes its own module, and the two values they share become options. Every binding moves
verbatim: Phases A and B, and Task C5, changed several of them (the package globs, the catalog,
`pnpmDeps`'s `hash`, `buildWorkspace`'s fileset and install), and the current text is the one to
keep.

**Files:**

- Create: `modules/typescript/files.nix`, `modules/typescript/workspace.nix`,
  `modules/typescript/tsc.nix`
- Modify: `modules/typescript/options.nix`, `docs/tooling.md`
- Delete: `modules/typescript/default.nix`

**Interfaces:**

- Produces: `ibusWeb.typescript.pnpmWorkspace` (attrs: `packages`, `allowBuilds`, `catalog`) and
  `ibusWeb.typescript.pnpmWorkspaceFile` (package), set by `files.nix` and read by
  `workspace.nix`. Every existing `ibusWeb.typescript.*` option keeps its name and value.

- [ ] **Step 1: Snapshot the derivations**

```bash
snap() {
  nix eval --json .#checks.x86_64-linux --apply 'builtins.mapAttrs (_: c: c.drvPath)' > "$1-checks.json"
  nix eval --json .#packages.x86_64-linux --apply 'builtins.mapAttrs (_: p: p.drvPath)' > "$1-packages.json"
}
drvdiff() {
  for kind in checks packages; do
    echo "== $kind"
    jq -n --slurpfile a "$1-$kind.json" --slurpfile b "$2-$kind.json" '
      $a[0] as $a | $b[0] as $b |
      { removed: ([$a | keys[]] - [$b | keys[]]),
        added: ([$b | keys[]] - [$a | keys[]]),
        changed: [$a | keys[] | select($b[.] != null and $a[.] != $b[.])] }'
  done
}
T=$(mktemp -d); snap "$T/before"
cp modules/typescript/default.nix "$T/default.nix"
```

- [ ] **Step 2: Declare the shared values**

In `modules/typescript/options.nix`, add inside `options.ibusWeb.typescript`, before `nodejs`:

```nix
      pnpmWorkspace = lib.mkOption {
        type = lib.types.attrsOf lib.types.anything;
        description = "pnpm-workspace.yaml's content: the workspace's package globs (each `<dir>` or `<dir>/*`), the dependencies allowed to run builds, and the catalog.";
      };
      pnpmWorkspaceFile = lib.mkOption {
        type = lib.types.package;
        description = "pnpm-workspace.yaml as generated from pnpmWorkspace, which builds of the workspace use in place of the tracked copy, so they follow the Nix before `write-files` has run.";
      };
```

- [ ] **Step 3: Create `modules/typescript/files.nix`**

Write this skeleton, then move the two bindings it names into its `let`, verbatim with their
comments:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { pkgs, ... }:
    let
      # pnpmWorkspace: moved verbatim from default.nix.
      # pnpmWorkspaceFile: moved verbatim from default.nix.
    in
    {
      ibusWeb.typescript = { inherit pnpmWorkspace pnpmWorkspaceFile; };
      files.file."pnpm-workspace.yaml".source = pnpmWorkspaceFile;
    };
}
```

Delete the two placeholder comment lines once the bindings are in. In `pnpmWorkspaceFile`, change
`modules/typescript/default.nix` in the generated header to `modules/typescript/files.nix`.

- [ ] **Step 4: Create `modules/typescript/workspace.nix`**

Write this skeleton, then move into its `let`, verbatim with their comments and in this order, the
bindings `root`, `packageDirs`, `packageSources`, `rootManifest`, `workspaceFiles`,
`withWorkspaceFile`, `playwrightDependents`, `assertPlaywrightVersion`, `manifests`, `pnpmDeps`,
`nodeModules`, `packageManifests`, `dirsByName`, `workspaceFor`, `buildWorkspace` and `workspace`:

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
      inherit (config.ibusWeb.typescript) nodejs pnpmWorkspace pnpmWorkspaceFile;
      inherit (pkgs) pnpm;
    in
    {
      ibusWeb.typescript = {
        nodejs = pkgs.nodejs_24;
        inherit workspace workspaceFor nodeModules;
        packageNodeModules =
          dir:
          let
            relative = lib.path.removePrefix root dir;
          in
          lib.throwIfNot (lib.elem (lib.removePrefix "./" relative) packageDirs)
            "packageNodeModules: ${relative} isn't a package of the workspace"
            "${nodeModules}/${relative}/node_modules";
        assertDependency = ../../tools/assert-dependency/assert-dependency.ts;
      };

      devshells.default.packages = [
        nodejs
        pnpm
      ];
    };
}
```

If `default.nix` sets `assertDependency` to a different path, keep that path. Then, in the moved
`assertPlaywrightVersion`, replace the script path after `node` (`${./assert-dependency.ts}` or
the path Phase B gave it) with `${config.ibusWeb.typescript.assertDependency}`. `root = ../..;`
still points at the repository root from `modules/typescript/`.

- [ ] **Step 5: Create `modules/typescript/tsc.nix`**

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
      inherit (config.ibusWeb.typescript) nodejs nodeModules;
      # The lockfile resolves typescript to one version, whichever packages
      # depend on it.
      tsc = pkgs.runCommand "ibus-web-tsc" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
        packages=(${nodeModules}/node_modules/.pnpm/typescript@*/node_modules/typescript)
        if [ ''${#packages[@]} -ne 1 ] || [ ! -d "''${packages[0]}" ]; then
          echo "expected one typescript in the workspace, found: ''${packages[*]}" >&2
          exit 1
        fi
        makeWrapper ${lib.getExe nodejs} $out/bin/tsc --add-flags "''${packages[0]}/bin/tsc"
      '';
    in
    {
      ibusWeb.typescript = { inherit tsc; };
      devshells.default.packages = [ tsc ];
    };
}
```

If the `tsc` binding in `default.nix` differs from this, use that text instead.

- [ ] **Step 6: Confirm every binding moved, then delete `default.nix`**

```bash
for name in root pnpmWorkspace pnpmWorkspaceFile packageDirs packageSources rootManifest \
  workspaceFiles withWorkspaceFile playwrightDependents assertPlaywrightVersion manifests pnpmDeps \
  nodeModules packageManifests dirsByName workspaceFor buildWorkspace workspace tsc; do
  n=$(grep -lE "^      $name =" modules/typescript/{files,workspace,tsc}.nix | wc -l)
  [ "$n" = 1 ] || echo "$name: defined in $n files"
done
git rm modules/typescript/default.nix
```

Expected: no "defined in" lines.

- [ ] **Step 7: Update the tooling page**

In `docs/tooling.md`, replace `` (`pnpmWorkspace` in `modules/typescript/default.nix`) `` with
`` (`pnpmWorkspace` in `modules/typescript/files.nix`) ``, and
`` `modules/typescript/default.nix` builds the workspace in three stages `` with
`` `modules/typescript/workspace.nix` builds the workspace in three stages ``.

```bash
git grep -n 'modules/typescript/default' -- ':!docs/plans' ':!docs/specs'
```

Expected: no output.

- [ ] **Step 8: Compare the derivations**

In the shell from Step 1:

```bash
nix run .#write-files
git diff --stat pnpm-workspace.yaml
nix fmt
snap "$T/after"; drvdiff "$T/before" "$T/after"
```

Expected: `pnpm-workspace.yaml` differs only in its header line. Nothing removed or added;
`changed` is `clangd`, `hk` and whatever reads `pnpm-workspace.yaml` (the header line is part of
the file the workspace builds copy in): every check and package built through `workspaceFor` or
`workspace`. No derivation outside those may change. Compare against `$T/default.nix` if one does.

- [ ] **Step 9: Run the gates**

```bash
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
nix develop -c git add modules/typescript pnpm-workspace.yaml docs/tooling.md
nix develop -c git commit -m "refactor(nix): split the TypeScript module by job" -- modules/typescript \
  pnpm-workspace.yaml docs/tooling.md
```

---

### Task C11: Split `modules/testing/default.nix` by job; drop its dead options

**Files:**

- Create: `modules/testing/playwright.nix`, `modules/testing/vitest.nix`,
  `modules/testing/gtest.nix`, `modules/testing/programs.nix`
- Delete: `modules/testing/default.nix`
- Modify: `docs/testing.md`

**Interfaces:**

- Option names unchanged: `ibusWeb.testing.{extendedChecks, playwright.chromiumSandbox,
  playwright.env, playwright.setup, browserLinkFlags, nodeLinkFlags, gtestCflagList, program,
  programs, vitestCheck}`.
- Removed: `ibusWeb.testing.gtestMain` (nothing outside the module read it) and
  `ibusWeb.testing.playwright.browsers` (never read).
- Added: `ibusWeb.testing.gtestLinkFlags :: str`, the link flags after a GoogleTest program's
  objects, which `program` adds and which were `gtestMain.libs`.
- `modules/testing/checks.nix` and `packages.integration-checks` are unchanged.

- [ ] **Step 1: Snapshot the derivations**

```bash
snap() {
  nix eval --json .#checks.x86_64-linux --apply 'builtins.mapAttrs (_: c: c.drvPath)' > "$1-checks.json"
  nix eval --json .#packages.x86_64-linux --apply 'builtins.mapAttrs (_: p: p.drvPath)' > "$1-packages.json"
}
drvdiff() {
  for kind in checks packages; do
    echo "== $kind"
    jq -n --slurpfile a "$1-$kind.json" --slurpfile b "$2-$kind.json" '
      $a[0] as $a | $b[0] as $b |
      { removed: ([$a | keys[]] - [$b | keys[]]),
        added: ([$b | keys[]] - [$a | keys[]]),
        changed: [$a | keys[] | select($b[.] != null and $a[.] != $b[.])] }'
  done
}
T=$(mktemp -d); snap "$T/before"
cp modules/testing/default.nix "$T/default.nix"
```

- [ ] **Step 2: Create `modules/testing/playwright.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.testing.playwright = {
      chromiumSandbox = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Whether Chromium runs with its own sandbox, as a browser does, which env passes on
          to the harnesses. It needs unprivileged user namespaces, which the Nix build
          sandbox allows on Linux unless the builder forbids them; on such a builder, set it
          to false.
        '';
      };
      env = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        description = "Environment variables under which the workspace's playwright package launches nixpkgs' headless browsers offline, as a derivation's attributes or exported in a shell, and IBUS_WEB_CHROMIUM_SANDBOX (1 or 0) for the harnesses.";
      };
      setup = lib.mkOption {
        type = lib.types.lines;
        description = "Shell commands a Nix build runs before launching the browsers. For builds only: it points HOME at a fresh directory.";
      };
    };
  };

  config.perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb.testing) playwright;
      # Headless Chromium uses its shell; the full browser and video encoder stay out.
      browsers = pkgs.playwright-driver.browsers.override {
        withChromium = false;
        withWebkit = true;
        withFfmpeg = false;
      };
    in
    {
      ibusWeb.testing.playwright = {
        env = {
          PLAYWRIGHT_BROWSERS_PATH = "${browsers}";
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          # Playwright checks the host's distribution packages for the
          # browsers' libraries; Nix links them in instead.
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
          IBUS_WEB_CHROMIUM_SANDBOX = if playwright.chromiumSandbox then "1" else "0";
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "ubuntu-24.04";
          # WebKit needs an EGL platform even headless; the sandbox has no host GPU driver.
          LIBGL_ALWAYS_SOFTWARE = "1";
          __EGL_VENDOR_LIBRARY_FILENAMES = "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json";
        };
        # Firefox writes to its XDG configuration and data directories under
        # HOME as it starts, even with the fresh profile Playwright gives
        # it, and hangs before Playwright can connect if it can't; a build's
        # HOME doesn't exist.
        setup = ''
          export HOME=$(mktemp -d)
        '';
      };
    };
}
```

- [ ] **Step 3: Create `modules/testing/vitest.nix`**

Write this, then move the `vitestCheck` binding from `default.nix` into its `let`, verbatim with
the comment above it (it keeps whatever path Phase B gave `expect-results.ts`):

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.testing = {
      extendedChecks = lib.mkOption {
        type = lib.types.attrsOf lib.types.package;
        default = { };
        description = "Extended integration checks aggregated by packages.integration-checks, outside the default flake check gate.";
      };
      vitestCheck = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = ''
          A function making a check that runs a workspace package's Vitest suites, from
          the built workspace, with the configuration the package's vitest.config.ts
          makes, taking:

          - name: the derivation's name, after "ibus-web-".
          - packageDir: the package's directory in the built workspace.
          - env: the build's attributes, such as the manifest the configuration reads.
          - inBrowsers: whether any suite runs in a browser, which then gets
            playwright's environment and setup.
          - limit: whole seconds before the run is killed, a bound on a browser or Vitest
            that hangs outright, past every test's own limit.
          - vitestArgs (default none): more arguments for Vitest.
          - expectedResults (default null): when given, a set as programs takes it, and
            the check passes if Vitest's report matches it rather than when every test
            passes.
          - passthru (default none): as for mkDerivation.

          Its output holds Vitest's console output as output.txt and its JSON report as
          results.json.
        '';
      };
    };
  };

  config.perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) typescript;
      inherit (config.ibusWeb.testing) playwright;
    in
    {
      ibusWeb.testing = { inherit vitestCheck; };
      packages.integration-checks = pkgs.linkFarm "ibus-web-integration-checks" (
        lib.mapAttrsToList (name: path: { inherit name path; }) config.ibusWeb.testing.extendedChecks
      );
    };
}
```

- [ ] **Step 4: Create `modules/testing/gtest.nix`**

Write this, then move into the result, verbatim with its comment, the attribute
`checks.gtest-main-library = …;` from `default.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.testing = {
      gtestCflagList = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "Compile flags for a GoogleTest program's sources, one flag an element: GoogleTest's headers, with its pthread support on.";
      };
      gtestLinkFlags = lib.mkOption {
        type = lib.types.str;
        description = ''
          Link flags after a GoogleTest program's objects: main() on a pthread
          (-sPROXY_TO_PTHREAD), which runs the tests its arguments select and hands
          GoogleTest's JSON report to the shim through the harness's JavaScript library,
          and GoogleTest itself.
        '';
      };
    };
  };

  config.perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) toolchain typescript;
      inherit (toolchain) emscripten pkgsWasm;
      inherit (config.ibusWeb.lib) libraryDeps emscriptenRoot;

      gtest = pkgsWasm.gtest;
      gtestCflagList = [
        "-I${lib.getDev gtest}/include"
        "-DGTEST_HAS_PTHREAD=1"
      ];
      gtestCflags = lib.concatStringsSep " " gtestCflagList;
      reportLibrary = ./gtest-main/report.js;

      gtestMainObject = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-gtest-main";
        dontUnpack = true;
        dontFixup = true;
        buildPhase = ''
          runHook preBuild
          $CXX ${gtestCflags} -c ${./gtest-main/main.cpp} -o gtest-main.o
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          install -Dm644 -t $out gtest-main.o
          runHook postInstall
        '';
      };

      # Types for what the report library uses from Emscripten, from a link
      # that exports exactly that.
      reportTypes = config.ibusWeb.lib.emscriptenTypes {
        name = "gtest-main-types";
        library = reportLibrary;
      };

      # Where the report library's type check finds those types.
      typesDir = "emscripten-types";
    in
    {
      ibusWeb.testing = {
        inherit gtestCflagList;
        gtestLinkFlags = "-sPROXY_TO_PTHREAD=1 ${gtestMainObject}/gtest-main.o -L${lib.getLib gtest}/lib -lgtest --js-library=${reportLibrary}";
      };

      # The harness and every GoogleTest program here include GoogleTest.
      ibusWeb.toolchain.clangdPathFlags."modules/testing/.*\\.(cpp|h)" = gtestCflagList;

      ibusWeb.toolchain.emscriptenTypes.gtest-main-types = {
        link = "modules/testing/gtest-main/${typesDir}";
        package = reportTypes;
      };
    };
}
```

Bindings the moved check doesn't use (`emscripten`, `emscriptenRoot`, `typescript`) may be removed
from the `let` once it is in; keep any it uses.

- [ ] **Step 5: Create `modules/testing/programs.nix`**

Write this, then move into its `let`, verbatim with their comments, the bindings `program`,
`packageDir` and `programs` from `default.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.testing = {
      browserLinkFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags for a C or C++ test program that runs in a browser: an ES module whose factory a dedicated Worker calls, with assertions on.";
      };
      nodeLinkFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags for a C or C++ test program that runs under Node, as `node NAME.js`: on WasmFS with the host's files at their own paths, with assertions on.";
      };
      program = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = ''
          A function building one test program for programs, taking:

          - name: the program's name; the derivation holds NAME.js and NAME.wasm.
          - src: the directory its sources are in. The build sees the sources it
            compiles, the .h files in src, and extraSources.
          - sources (default [ "NAME.cpp" ]): the files to compile, relative to src; .c
            files with $CC, the rest with $CXX.
          - extraSources (default none): more files from src the build reads, such as
            ones preBuild compiles.
          - format (default "gtest-json"): its passthru.testProgram format, "gtest-json"
            or "tap", or null for a program that programs doesn't run, which then has
            no passthru.testProgram.
          - gtest (default: format is "gtest-json"): whether it compiles with
            gtestCflagList and links gtestLinkFlags.
          - linkFlags (required), cflags and libs (default none): shell words, as
            strings or lists, for the link before the objects, for compiling each
            source, and for the link after the objects, before gtestLinkFlags.
            The build's shell expands them, so they may name $out.
          - args (default null): its arguments, as a list, written to NAME.args.
          - preBuild (default none): shell commands run before compiling, with $out
            already made, for whatever else the program needs beside it.
          - nativeBuildInputs, buildInputs (default none): as for mkDerivation.
          - derivationName (default "ibus-web-test-program-NAME"): the derivation's name.

          It builds with pkgsWasm's stdenv, whose compilers add the common flags.
        '';
      };
      programs = lib.mkOption {
        type = lib.types.functionTo lib.types.package;
        description = ''
          A function making a check that runs test programs with Vitest, taking:

          - name: a name for the check.
          - programs: derivations, each holding one program as NAME.js and NAME.wasm, and
            optionally NAME.args, its arguments one per line, with
            `passthru.testProgram = { name = NAME; format = "gtest-json" or "tap"; }`. A
            GoogleTest program links with gtestLinkFlags and reports through its harness;
            a TAP program takes g_test's -l, -s and --keep-going and prints TAP on its
            stdout. Programs for browsers link with browserLinkFlags, programs for Node
            with nodeLinkFlags. It may be empty when nodeTests holds the tests.
          - environments (default chromium and firefox): where they run, any of node,
            chromium and firefox.
          - timeout (default 120): the whole seconds each program has to exit, in each
            environment.
          - expectedResults (default null): for the shim's own check. When given, as
            `{ ENVIRONMENT = [ { path = [ PROGRAM SUITE... TEST ]; status = "passed",
            "failed" or "skipped"; durationMs = [ MIN MAX ]; } ... ]; }` (durationMs
            optional), the check passes if Vitest reports exactly those tests, at those
            paths, with those results and times, instead of when every test passes.
          - vitestArgs (default none): more arguments for Vitest, such as `-t PATTERN` to
            run only the cases it names.
          - nodeTests (default null): a directory of Vitest test files, TypeScript, that
            run in the node environment beside the programs, for what a program can't
            report on itself, such as the status it exits with. Its .ts files are copied
            as they are, so the tests keep their names and can import sibling
            helpers; every *.test.ts among them runs. They import from vitest, and read
            nodeTestData with `nodeTestData(KEY)` from
            `@ibus-web/test-programs/node-tests`, both of which resolve from the shim's
            package wherever the files are.
          - nodeTestData (default empty): strings for the nodeTests, such as the paths of
            what they run.

          Under a suite named after the environment, each program is a suite holding the
          suites and cases it lists (GoogleTest's --gtest_list_tests, g_test's -l), nested
          as it names them (GoogleTest's suites, the segments of a g_test path, TAP
          subtests), and last a test named "run". The program runs once, for the cases
          Vitest selects (--gtest_filter, or g_test's -s for the others), and each case's
          test takes the program's result and time for it; a listed case it didn't report
          fails. "run" fails when the run went wrong as a whole: the listing failed, the
          program didn't exit, its report was broken, it ran cases it wasn't asked to, or
          it exited with a failure no failing case explains. A program's output is shown
          for its failing tests. In browsers each program runs in a dedicated Worker on a
          cross-origin isolated page. Programs named PREFIX.1, PREFIX.2 and so on run in
          that order and share their storage (the origin's IndexedDB, or under Node the
          working directory), and stop at the first that fails; every other program
          starts with that storage empty. When Vitest selects cases of a later program of
          a sequence, the earlier ones still run first for the storage they leave: in full
          when none of their cases is selected, otherwise filtered to those. A program's
          "run" test selected without any of its cases passes without running the
          program.
        '';
      };
    };
  };

  config.perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) toolchain typescript;
      inherit (config.ibusWeb.testing) vitestCheck;
      inherit (toolchain) pkgsWasm;

      allEnvironments = [
        "node"
        "chromium"
        "firefox"
      ];
      formats = [
        "gtest-json"
        "tap"
      ];

      gtestCflags = lib.concatStringsSep " " config.ibusWeb.testing.gtestCflagList;
      gtestLibs = config.ibusWeb.testing.gtestLinkFlags;

      words = value: if lib.isList value then lib.concatStringsSep " " value else value;
    in
    {
      ibusWeb.testing = {
        browserLinkFlags = "-sASSERTIONS=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker -sEXIT_RUNTIME=1";

        # A program on its own needs nothing of a main module's.
        nodeLinkFlags = lib.concatStringsSep " " (
          lib.filter (flag: !lib.hasPrefix "-sMAIN_MODULE" flag) toolchain.testMainFlagList
        );

        inherit program programs;
      };
    };
}
```

`program` refers to `gtestCflags` and `gtestLibs`, which the `let` above now defines from the
options; `programs` refers to `vitestCheck` and `packageDir`.

- [ ] **Step 6: Confirm every binding and attribute moved, then delete `default.nix`**

```bash
grep -c 'checks.gtest-main-library' modules/testing/gtest.nix
for name in browsers vitestCheck program packageDir programs gtestMainObject reportTypes typesDir; do
  n=$(grep -lE "^      $name =" modules/testing/{playwright,vitest,gtest,programs}.nix | wc -l)
  [ "$n" = 1 ] || echo "$name: defined in $n files"
done
git rm modules/testing/default.nix
git grep -n -e 'testing.gtestMain\b' -e 'gtestMain\.' -e 'playwright.browsers' -- '*.nix'
```

Expected: `1`; no "defined in" lines; the last command prints nothing.

- [ ] **Step 7: Update the testing page**

In `docs/testing.md`, replace:

```markdown
`ibus-web-gtest-main` (`modules/testing/gtest-main/`) supplies `main()` for every GoogleTest
program, through `ibusWeb.testing.gtestMain`:

- `cflags`: GoogleTest's headers and `-DGTEST_HAS_PTHREAD=1`;
- `libs`: `-sPROXY_TO_PTHREAD=1`, the harness object, `-lgtest` and `--js-library` of the
  harness's JavaScript library;
- `jsLibrary`: that library's path.
```

with:

```markdown
`ibus-web-gtest-main` (`modules/testing/gtest-main/`) supplies `main()` for every GoogleTest
program. A program compiles with `ibusWeb.testing.gtestCflagList` (GoogleTest's headers and
`-DGTEST_HAS_PTHREAD=1`) and links with `ibusWeb.testing.gtestLinkFlags` (`-sPROXY_TO_PTHREAD=1`,
the harness object, `-lgtest` and `--js-library` of the harness's JavaScript library);
`ibusWeb.testing.program` adds both to a GoogleTest program itself.
```

Replace `` `ibusWeb.testing.programs` (`modules/testing/default.nix`) `` with
`` `ibusWeb.testing.programs` (`modules/testing/programs.nix`) ``, and in the `format` bullet
`compiles against GoogleTest and links `gtestMain`` with
`compiles against GoogleTest and links its harness`.

```bash
git grep -n -e 'modules/testing/default' -e 'gtestMain`' -- ':!docs/plans' ':!docs/specs'
```

Expected: no output.

- [ ] **Step 8: Compare the derivations**

In the shell from Step 1:

```bash
nix run .#write-files
nix fmt
snap "$T/after"; drvdiff "$T/before" "$T/after"
```

Expected: nothing removed or added; `checks.changed` is `clangd` and `hk`; `packages.changed` is
empty. Every function and value moved unchanged, so any other change is a binding that moved with
a different value: diff it against `$T/default.nix`.

- [ ] **Step 9: Run the gates**

```bash
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
nix develop -c git add modules/testing docs/testing.md
nix develop -c git commit -m "refactor(nix): split the testing module by job and drop its unread options" -- \
  modules/testing docs/testing.md
```

---

### Task C12: Name every check `<area>-<what>`

The area is the component directory the check lives in: `tools-…` under `tools/`, `toolchain-…`
under `modules/toolchain/`, `testing-…` under `modules/testing/`, `flake-…` under
`modules/flake/`, `engines-…` under `modules/engines/`, `example-hangul-…` under
`examples/hangul/`, and the component's own name elsewhere. A check whose name was only its area
gets the environment it runs in. Each renamed check's top-level derivation is named
`ibus-web-<new name>`.

**Files:**

- Modify: every file in the table below, `docs/**/*.md` (not `docs/plans/` or the
  2026-10-07 spec), `tools/*/README.md`, `examples/hangul/README.md`,
  `modules/*/patches/README.md`, `engines/hangul/patches/README.md`

| Old | New | File |
| --- | --- | --- |
| `bundle-scan` | `tools-bundle-scan` | `tools/bundle-scan/checks.nix` |
| `clangd` | `toolchain-clangd` | `modules/toolchain/dev-shell.nix` |
| `core` | `core-node` | `packages/core/module.nix` |
| `cross-toolchain` | `toolchain-cross` | `modules/toolchain/checks.nix` |
| `demo` | `example-hangul-smoke` | `examples/hangul/module.nix` |
| `engine-distribution-identity` | `worker-host-engine-distribution-identity` | `packages/worker-host/module.nix` |
| `engine-manifest` | `tools-engine-manifest` | `tools/engine-manifest/checks.nix` |
| `engines-cast-audit-script` | `tools-cast-audit` | `tools/cast-audit/checks.nix` |
| `engines-ibus-test-script` | `tools-ibus-test` | `tools/ibus-test/checks.nix` |
| `glib` | `glib-smoke` | `modules/glib/checks/smoke/checks.nix` |
| `gtest-main-library` | `testing-gtest-main-library` | `modules/testing/gtest.nix` |
| `hk` | `flake-hk` | `modules/flake/hk.nix` |
| `ibus-test-conformance` | `engines-ibus-test-conformance` | `modules/engines/ibus-test.nix` |
| `ibus-test-native` | `engines-ibus-test-native` | `modules/engines/ibus-test.nix` |
| `ibus-web` | `ibus-web-browser` | `packages/ibus-web/module.nix` |
| `keys-generators` | `tools-keysyms` | `tools/keysyms/module.nix` |
| `libhangul-wasm` | `hangul-libhangul-link` | `engines/hangul/checks/libhangul-link/checks.nix` |
| `libibus-web` | `libibus-web-tests` | `runtime/libibus-web/checks.nix` |
| `libibus-web-vendored-script` | `tools-vendor-inventory` | `tools/vendor-inventory/checks.nix` |
| `meson-consumer` | `toolchain-meson-consumer` | `modules/toolchain/checks/meson-consumer/checks.nix` |
| `panel` | `panel-browser` | `packages/panel/module.nix` |
| `protocol` | `protocol-node` | `packages/protocol/module.nix` |
| `settings-metadata` | `engines-settings-metadata` | `modules/engines/settings-metadata.nix` |
| `test-programs` | `testing-programs` | `modules/testing/checks.nix` |
| `wasmfs-idb` | `wasmfs-idb-browser` | `runtime/wasmfs-idb/checks.nix` |
| `wasmfs-idb-library-deps` | `tools-emscripten-library-deps` | `tools/emscripten-library-deps/module.nix` |

Every other check already fits and keeps its name. `packages.*`, `apps.*` and
`ibusWeb.testing.extendedChecks.*` keep theirs, so `nix run .#demo` and `integration-checks` are
unchanged.

- [ ] **Step 1: Rename the attributes and their derivations**

In each file, change the check's attribute and its derivation's name:

- `tools/bundle-scan/checks.nix`: `checks.bundle-scan =` → `checks.tools-bundle-scan =`;
  `pkgs.runCommand "ibus-web-bundle-scan"` → `pkgs.runCommand "ibus-web-tools-bundle-scan"`.
- `modules/toolchain/dev-shell.nix`: `checks.clangd = pkgs.runCommand "ibus-web-clangd-check" { }` →
  `checks.toolchain-clangd = pkgs.runCommand "ibus-web-toolchain-clangd" { }`.
- `packages/core/module.nix`: `checks.core = config.ibusWeb.testing.vitestCheck {` →
  `checks.core-node = config.ibusWeb.testing.vitestCheck {`, and its `name = "core";` →
  `name = "core-node";`.
- `modules/toolchain/checks.nix`: `checks.cross-toolchain =` → `checks.toolchain-cross =`;
  `name = "ibus-web-cross-toolchain-check";` → `name = "ibus-web-toolchain-cross";`.
- `examples/hangul/module.nix`: `checks.demo =` → `checks.example-hangul-smoke =`;
  `pkgs.runCommand "ibus-web-demo-smoke"` → `pkgs.runCommand "ibus-web-example-hangul-smoke"`.
- `packages/worker-host/module.nix`: `checks.engine-distribution-identity =` →
  `checks.worker-host-engine-distribution-identity =`;
  `pkgs.runCommand "engine-distribution-identity"` →
  `pkgs.runCommand "ibus-web-worker-host-engine-distribution-identity"`.
- `tools/engine-manifest/checks.nix`: `checks.engine-manifest =` → `checks.tools-engine-manifest =`;
  `name = "engine-manifest";` → `name = "tools-engine-manifest";`.
- `tools/cast-audit/checks.nix`: both `engines-cast-audit-script` → `tools-cast-audit`.
- `tools/ibus-test/checks.nix`: both `engines-ibus-test-script` → `tools-ibus-test`.
- `modules/glib/checks/smoke/checks.nix`: `checks.glib =` → `checks.glib-smoke =`;
  `"ibus-web-glib-check"` → `"ibus-web-glib-smoke"`.
- `modules/testing/gtest.nix`: `checks.gtest-main-library =` → `checks.testing-gtest-main-library =`;
  `"ibus-web-gtest-main-library-check"` → `"ibus-web-testing-gtest-main-library"`.
- `modules/flake/hk.nix`: `checks.hk =` → `checks.flake-hk =`; `pkgs.runCommand "ibus-web-hk"` →
  `pkgs.runCommand "ibus-web-flake-hk"`.
- `modules/engines/ibus-test.nix`: in `checks`, `ibus-test-native = native;` →
  `engines-ibus-test-native = native;`, `ibus-test-conformance = ibusTest {` →
  `engines-ibus-test-conformance = ibusTest {`, and its `name = "ibus-test-conformance";` →
  `name = "engines-ibus-test-conformance";`. (`fixtureConfig`'s own `name` stays; it names the
  config file, not the check.)
- `packages/ibus-web/module.nix`: `checks.ibus-web =` → `checks.ibus-web-browser =`;
  `name = "ibus-web";` → `name = "ibus-web-browser";`.
- `tools/keysyms/module.nix`: `checks.keys-generators =` → `checks.tools-keysyms =`;
  `name = "keys-generators";` → `name = "tools-keysyms";`.
- `engines/hangul/checks/libhangul-link/checks.nix`: `checks.libhangul-wasm =` →
  `checks.hangul-libhangul-link =`; `"ibus-web-libhangul-check"` → `"ibus-web-hangul-libhangul-link"`.
- `runtime/libibus-web/checks.nix`: `checks.libibus-web = runtime.libibusWeb.overrideAttrs` →
  `checks.libibus-web-tests = runtime.libibusWeb.overrideAttrs`;
  `pname = "ibus-web-libibus-web-check";` → `pname = "ibus-web-libibus-web-tests";`.
- `tools/vendor-inventory/checks.nix`: both `libibus-web-vendored-script` → `tools-vendor-inventory`.
- `modules/toolchain/checks/meson-consumer/checks.nix`: `checks.meson-consumer =` →
  `checks.toolchain-meson-consumer =`; `name = "ibus-web-meson-consumer";` →
  `name = "ibus-web-toolchain-meson-consumer";`.
- `packages/panel/module.nix`: `checks.panel =` → `checks.panel-browser =`; `name = "panel";` →
  `name = "panel-browser";`.
- `packages/protocol/module.nix`: `checks.protocol = testing.vitestCheck {` →
  `checks.protocol-node = testing.vitestCheck {`; its `name = "protocol";` →
  `name = "protocol-node";`. (`protocol-parity` keeps its name.)
- `modules/engines/settings-metadata.nix`: `checks.settings-metadata =` →
  `checks.engines-settings-metadata =`; `name = "settings-metadata";` →
  `name = "engines-settings-metadata";`.
- `modules/testing/checks.nix`: `checks.test-programs = pkgs.linkFarm "ibus-web-test-programs"` →
  `checks.testing-programs = pkgs.linkFarm "ibus-web-testing-programs"`.
- `runtime/wasmfs-idb/checks.nix`: `checks.wasmfs-idb = testing.programs {` →
  `checks.wasmfs-idb-browser = testing.programs {`; its `name = "wasmfs-idb";` →
  `name = "wasmfs-idb-browser";`.
- `tools/emscripten-library-deps/module.nix`: `checks.wasmfs-idb-library-deps =` →
  `checks.tools-emscripten-library-deps =`; `name = "wasmfs-idb-library-deps";` →
  `name = "tools-emscripten-library-deps";`.

- [ ] **Step 2: Check the names**

```bash
nix eval --json .#checks.x86_64-linux --apply builtins.attrNames | jq -r '.[]' > "${TMPDIR:-/tmp}/checks.txt"
for old in bundle-scan clangd core cross-toolchain demo engine-distribution-identity engine-manifest \
  engines-cast-audit-script engines-ibus-test-script glib gtest-main-library hk ibus-test-conformance \
  ibus-test-native ibus-web keys-generators libhangul-wasm libibus-web libibus-web-vendored-script \
  meson-consumer panel protocol settings-metadata test-programs wasmfs-idb wasmfs-idb-library-deps; do
  grep -qx "$old" "${TMPDIR:-/tmp}/checks.txt" && echo "still named $old"
done
grep -vE '^(core|engines|example-hangul|flake|glib|hangul|ibus-runtime|ibus-web|libibus-web|panel|protocol|testing|toolchain|tools|wasmfs-idb|worker-host|emscripten|files)[-:]' \
  "${TMPDIR:-/tmp}/checks.txt"
```

Expected: no output from either. (`files:…` are the generated-file checks.)

- [ ] **Step 3: Update the docs' check references**

```bash
files=$(git ls-files 'docs/*.md' 'docs/**/*.md' 'tools/*/README.md' 'examples/hangul/README.md' \
  'modules/*/patches/README.md' 'engines/hangul/patches/README.md' |
  grep -v -e '^docs/plans/' -e '^docs/specs/2026-10-07-repo-organization.md')
perl -pi -e '
  BEGIN {
    %r = (
      "bundle-scan" => "tools-bundle-scan", "clangd" => "toolchain-clangd", "core" => "core-node",
      "cross-toolchain" => "toolchain-cross", "demo" => "example-hangul-smoke",
      "engine-distribution-identity" => "worker-host-engine-distribution-identity",
      "engine-manifest" => "tools-engine-manifest", "engines-cast-audit-script" => "tools-cast-audit",
      "engines-ibus-test-script" => "tools-ibus-test", "glib" => "glib-smoke",
      "gtest-main-library" => "testing-gtest-main-library", "hk" => "flake-hk",
      "ibus-test-conformance" => "engines-ibus-test-conformance",
      "ibus-test-native" => "engines-ibus-test-native", "ibus-web" => "ibus-web-browser",
      "keys-generators" => "tools-keysyms", "libhangul-wasm" => "hangul-libhangul-link",
      "libibus-web" => "libibus-web-tests", "libibus-web-vendored-script" => "tools-vendor-inventory",
      "meson-consumer" => "toolchain-meson-consumer", "panel" => "panel-browser",
      "protocol" => "protocol-node", "settings-metadata" => "engines-settings-metadata",
      "test-programs" => "testing-programs", "wasmfs-idb" => "wasmfs-idb-browser",
      "wasmfs-idb-library-deps" => "tools-emscripten-library-deps",
    );
    $alt = join "|", map { quotemeta } sort { length $b <=> length $a } keys %r;
  }
  s/(checks\.(?:x86_64-linux\.|<system>\.|\$\{system\}\.)?)($alt)(?![\w-])/$1$r{$2}/g;
' $files
git diff --stat
```

The pattern only touches names written as `checks.NAME` or `checks.<system>.NAME`, so `core` the
package and `hk` the tool are left alone.

- [ ] **Step 4: Update the testing page's list of checks**

In `docs/testing.md`, under "Checks that aren't tests", replace:

```markdown
- `hk`: formatting, oxlint, `tsc`, the `tsconfig` extends chain, REUSE, actionlint
  ([tooling.md](tooling.md#hk)).
- `clangd`: every C and C++ source parses under the editor configuration.
```

with:

```markdown
- `flake-hk`: formatting, oxlint, `tsc`, the `tsconfig` extends chain, REUSE, actionlint
  ([tooling.md](tooling.md#hk)).
- `toolchain-clangd`: every C and C++ source parses under the editor configuration.
```

replace `` `wasmfs-idb-types`, `wasmfs-idb-acorn`, `gtest-main-library`: `` with
`` `wasmfs-idb-types`, `wasmfs-idb-acorn`, `testing-gtest-main-library`: ``, and:

```markdown
- `glib-patches`, `toolchain-cache`, `toolchain-exnref`, `cross-toolchain`, `meson-consumer`,
  `libhangul-wasm`: the toolchain and packages build, link and apply as expected
```

with:

```markdown
- `glib-patches`, `toolchain-cache`, `toolchain-exnref`, `toolchain-cross`,
  `toolchain-meson-consumer`, `hangul-libhangul-link`: the toolchain and packages build, link and
  apply as expected
```

- [ ] **Step 5: Find any old name left in prose**

```bash
git grep -n -w -E '`(bundle-scan|cross-toolchain|engine-distribution-identity|engine-manifest|engines-cast-audit-script|engines-ibus-test-script|gtest-main-library|ibus-test-conformance|keys-generators|libhangul-wasm|libibus-web-vendored-script|meson-consumer|settings-metadata|test-programs|wasmfs-idb-library-deps)`' \
  -- $files
```

Each hit is a backticked name that may be a check or something else of the same name (a tool's
directory, a package, a fixture). Rename the hits that mean the check; leave the rest. Expected
when done: only hits that name something other than a check.

- [ ] **Step 6: Run the gates**

```bash
nix run .#write-files
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass, under the new names (`nix flake check -L` logs `ibus-web-flake-hk`,
`ibus-web-toolchain-clangd`, …).

- [ ] **Step 7: Commit**

```bash
nix develop -c git add -u
nix develop -c git status --short
nix develop -c git commit -m "refactor(nix): name every check by its component" -- $(git diff --cached --name-only)
```

Expected from `git status --short`: only the `.nix` files in the table and the docs Steps 3–5
changed, all staged.

---

### Task C13: Prefix every project-made derivation with `ibus-web-`

Derivations that package a named upstream project or one of the project's own named artifacts keep
that name: `libibus-web`, `wasmfs-idb`, `ibus-runtime` and `ibus-runtime-asserting`,
`baseline-browser-mapping`, `hk-pkl`, nixpkgs recipes the overlays override (GLib, libhangul,
`ibus-engines.hangul`, Emscripten), and the `clangd` and `typescript-language-server` wrappers,
whose names are the commands they provide. So do the cross stdenv's own derivations in
`modules/toolchain/cross.nix` and `cache.nix` (`emscripten-clang-*`, `emscripten-binutils-*`,
`emscripten-meson-hook`, `emscripten-meson-cross.ini`, `emscripten-cache`): renaming them would
rebuild every WebAssembly package for no change in output. `withWorkspaceFile`'s `"source"` keeps
its name, which pnpm's install depends on.

**Files:**

- Modify: the files in Step 1.

- [ ] **Step 1: Rename**

| File | Replace | With |
| --- | --- | --- |
| `runtime/ibus-runtime/checks.nix` | `name = "ibus-runtime-node-harness";` | `name = "ibus-web-ibus-runtime-node-harness";` |
| `runtime/ibus-runtime/checks.nix` | `pkgs.runCommand "ibus-runtime-exports-script"` | `pkgs.runCommand "ibus-web-ibus-runtime-exports-script"` |
| `runtime/ibus-runtime/module.nix` | `name = "ibus-runtime-constants";` | `name = "ibus-web-ibus-runtime-constants";` |
| `runtime/ibus-runtime/exports.nix` | `pname = "ibus-runtime-exports";` | `pname = "ibus-web-ibus-runtime-exports";` |
| `runtime/libibus-web/checks.nix` | `pkgs.runCommand "libibus-web-vendored"` | `pkgs.runCommand "ibus-web-libibus-web-vendored"` |
| `runtime/libibus-web/module.nix` | `pname = "libibus-web-private-headers";` | `pname = "ibus-web-libibus-web-private-headers";` |
| `engines/hangul/module.nix` | `pkgs.runCommand "hangul-data-closure"` | `pkgs.runCommand "ibus-web-hangul-data-closure"` |
| `engines/hangul/overlay.nix` | `prev.runCommand "hangul-gsettings-schemas"` | `prev.runCommand "ibus-web-hangul-gsettings-schemas"` |
| `modules/engines/ibus-test.nix` | `pname = "ibus-test-native";` | `pname = "ibus-web-ibus-test-native";` |
| `modules/engines/ibus-test.nix` | `name = "ibus-test-conformance-engine";` | `name = "ibus-web-ibus-test-conformance-engine";` |
| `modules/engines/ibus-test.nix` | `pkgs.runCommand "ibus-test-conformance-data"` | `pkgs.runCommand "ibus-web-ibus-test-conformance-data"` |
| `modules/engines/ibus-test.nix` | `pkgs.writeText "${name}-manifest.json"` | `pkgs.writeText "ibus-web-${name}-manifest.json"` |
| `modules/engines/ibus-test.nix` | `pkgs.runCommand "ibus-test-native-clangd"` | `pkgs.runCommand "ibus-web-ibus-test-native-clangd"` |
| `modules/engines/manifest.nix` | `pkgs.writeText "${name}-manifest-fields.json"` | `pkgs.writeText "ibus-web-${name}-manifest-fields.json"` |
| `modules/engines/settings-metadata.nix` | `pkgs.writeText "settings-metadata-fixture.json"` | `pkgs.writeText "ibus-web-settings-metadata-fixture.json"` |
| `packages/worker-host/module.nix` | `pkgs.runCommand "echo-link-target"` | `pkgs.runCommand "ibus-web-echo-link-target"` |
| `packages/worker-host/module.nix` | `pkgs.writeText "echo-single-file"` | `pkgs.writeText "ibus-web-echo-single-file"` |
| `packages/worker-host/module.nix` | `pkgs.runCommand "echo-data"` | `pkgs.runCommand "ibus-web-echo-data"` |
| `packages/worker-host/module.nix` | `pkgs.runCommand "echo-schemas"` | `pkgs.runCommand "ibus-web-echo-schemas"` |
| `packages/worker-host/module.nix` | `pkgs.runCommand "worker-host-${name}"` | `pkgs.runCommand "ibus-web-worker-host-${name}"` |
| `tools/keysyms/module.nix` | `pkgs.runCommand "${kind}-notice.txt"` | `pkgs.runCommand "ibus-web-${kind}-notice.txt"` |
| `tools/keysyms/module.nix` | `.generate "xkb-export-clangd.yaml"` | `.generate "ibus-web-xkb-export-clangd.yaml"` |
| `tools/keysyms/module.nix` | `pkgs.runCommand "xkeyboard-config-COPYING.txt"` | `pkgs.runCommand "ibus-web-xkeyboard-config-COPYING.txt"` |
| `modules/toolchain/dev-shell.nix` | `pkgs.writeText "wasm-shell-meson-binaries.ini"` | `pkgs.writeText "ibus-web-wasm-shell-meson-binaries.ini"` |
| `modules/glib/checks/tests/checks.nix` | `writeShellScript "node-to-files"` | `writeShellScript "ibus-web-node-to-files"` |
| `modules/glib/checks/tests/checks.nix` | `writeText "glib-tests-cross.ini"` | `writeText "ibus-web-glib-tests-cross.ini"` |
| `modules/testing/vitest.nix` | `pkgs.writeText "expected-results.json"` | `pkgs.writeText "ibus-web-expected-results.json"` |
| `modules/typescript/files.nix` | `pkgs.runCommand "pnpm-workspace.yaml"` | `pkgs.runCommand "ibus-web-pnpm-workspace.yaml"` |
| `modules/typescript/files.nix` | `.generate "pnpm-workspace.yaml" pnpmWorkspace` | `.generate "ibus-web-pnpm-workspace.yaml" pnpmWorkspace` |
| `packages/protocol/module.nix` | `name = "protocol-bench";` | `name = "ibus-web-protocol-bench";` |

`packages/worker-host/test/shared/install.ts` finds the single-file store path with
`endsWith("-echo-single-file")`, which `…-ibus-web-echo-single-file` still matches.

- [ ] **Step 2: Find any left**

```bash
nix eval --json .#checks.x86_64-linux --apply 'cs: map (c: c.name) (builtins.attrValues cs)' |
  jq -r '.[] | select(startswith("ibus-web-") | not)'
nix eval --json .#packages.x86_64-linux --apply 'ps: map (p: p.name) (builtins.attrValues ps)' |
  jq -r '.[] | select(startswith("ibus-web-") | not)'
git grep -n -E '(runCommand|writeText|writeShellScript|writeShellApplication|mkDerivation)[^"]*"[a-z]' -- '*.nix' |
  grep -v '"ibus-web-'
```

Expected: the first prints nothing. The second prints only the exempt names (`libibus-web-*`,
`wasmfs-idb-*`, `ibus-runtime-*`, `baseline-browser-mapping-*`, `hk-pkl-*`, `ibus-hangul-*`). The
third prints only the exemptions above and lines whose name argument isn't on that line (check
each).

- [ ] **Step 3: Run the gates**

```bash
nix run .#write-files
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
nix develop -c git add -u
nix develop -c git commit -m "refactor(nix): prefix every project-made derivation with ibus-web-" -- \
  $(git diff --cached --name-only)
```

---

### Task C14: Describe the Nix layout, and check it holds

**Files:**

- Modify: `docs/toolchain.md`

- [ ] **Step 1: Rewrite the layout list in the toolchain page**

In `docs/toolchain.md`, replace the bulleted list that begins
``- `modules/<component>/` holds a component's modules`` and ends
`- Non-Nix files sit beside the module that uses them, under plain names.` with:

```markdown
- Each component's Nix sits in its directory, in files named for their role: `module.nix` (its
  packages, outputs and dev-shell setup), `options.nix` (options it declares for other modules),
  `checks.nix`, `overlay.nix` (its overlay on `pkgsWasm`), and `_<name>.nix` for a plain
  `callPackage` recipe, which import-tree skips. A module with more than one job splits into
  modules named for each (`archives.nix`, `exports.nix`, `cache.nix`), and a job's module may
  define the checks that need its own bindings. A check with fixtures of its own gets a directory
  holding its `checks.nix` beside them.
- `modules/` holds what components share: `toolchain/`, `emscripten/`, `glib/` and
  `baseline-browser-mapping/`, which this page covers; `engines/`, the API engines are built and
  checked with; `typescript/` and `testing/`; and `flake/` (systems, dev shell, CI, hk, generated
  files, and `ibusWeb.lib`, the helpers modules share).
- `runtime/<part>/`, `packages/<name>/`, `tools/<name>/`, `engines/<name>/` and
  `examples/<name>/` each hold one component: its sources, its Nix and its tests.
- Non-Nix files sit beside the module that uses them, under plain names.
```

- [ ] **Step 2: Check the layout holds**

```bash
git ls-files 'modules/*.nix' | grep -E '^modules/[^/]+\.nix$'
git ls-files '*.nix' | grep -E '/(default|package)\.nix$'
git ls-files '*.nix' | grep -vE '(^|/)(module|options|checks|overlay)\.nix$|/_[^/]+\.nix$|^flake\.nix$'
```

Expected: the first two print nothing. The third prints only modules named for their job:

```
modules/emscripten/dev-shell.nix
modules/engines/cast-audit.nix
modules/engines/ibus-test.nix
modules/engines/json-glib.nix
modules/engines/manifest.nix
modules/engines/settings-metadata.nix
modules/flake/ci.nix
modules/flake/dev-shell.nix
modules/flake/files.nix
modules/flake/flake-root.nix
modules/flake/hk.nix
modules/flake/lib.nix
modules/flake/systems.nix
modules/testing/gtest.nix
modules/testing/playwright.nix
modules/testing/programs.nix
modules/testing/vitest.nix
modules/toolchain/cache.nix
modules/toolchain/cross.nix
modules/toolchain/dev-shell.nix
modules/toolchain/minimum-versions.nix
modules/typescript/files.nix
modules/typescript/tsc.nix
modules/typescript/workspace.nix
runtime/ibus-runtime/exports.nix
runtime/ibus-runtime/side-module.nix
runtime/libibus-web/archives.nix
```

- [ ] **Step 3: Run the gates**

```bash
nix run .#write-files
nix fmt
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
nix develop -c git add docs/toolchain.md
nix develop -c git commit -m "docs(toolchain): describe the Nix layout" -- docs/toolchain.md
```

---
## Phase D: Package internals

Phase D reorganizes code inside the workspace packages without changing what they do: one test layout, `test` instead
of `it`, one definition of each helper that was copied, panel types owned by `@ibus-web/protocol`, barrels that list
their exports, and `worker-host`'s `host.ts` split along its seams.

It assumes Phases A–C have run:

- Every package's tsconfigs sit at its root and extend `@ibus-web/tsconfig` presets: `tsconfig.json`,
  `tsconfig.<target>.json`, `tsconfig.test.json` (Node tests) and `tsconfig.test-browser.json` (browser tests), and
  `tsconfig.config.json`. No tsconfig sits under `src/` or `test/`.
- `tools/<name>/` are packages, and the tests under `tools/`, `runtime/`, `modules/` and `examples/` are where Phase B
  put them.
- Check names may have changed in Phase C. `nix eval .#checks.x86_64-linux --apply builtins.attrNames` lists the
  current ones; this phase calls them by their names on `master` (`core`, `core-browser`, `protocol`, `panel`,
  `ibus-web`, `worker-host-node`, `worker-host-browser`, `bundle-scan`, `hangul-host`).

Two helper scripts live outside the repository for the length of the phase. Save them under `${TMPDIR:-/tmp}`; they are
never committed.

### Task D1: One test layout

Packages whose tests run in more than one environment split `test/` by environment: `test/node/`, `test/browser/`, and
`test/shared/` for helpers both use. Packages whose tests run in one environment keep area folders, with nothing loose at
the root of `test/`. Core is the only package that needs moving; protocol has two loose files.

`packages/test-programs/src/{node,browser}/programs.test.ts` stay where they are: they are not tests of
`test-programs` but the entry files its runner compiles to `dist/` and hands to every consumer's Vitest
(`src/node/config.ts` includes `dist/node/programs.test.js`).

**Files:**

- Move (core, to `test/node/`): `test/connection/connection.test.ts`, `test/keys/{translate,us}.test.ts`,
  `test/router/{async,hang,keystroke,replay,restart,services}.test.ts`, `test/support/fake-worker.ts`
- Move (core, to `test/browser/`): `test/router/{contexts,preedit,surrounding,content-type,switching}.test.ts` to
  `test/browser/router/`; `test/router/dom-support.ts` to `test/browser/support/dom.ts`
- Move (core, to `test/shared/`): `test/router/support.ts` to `test/shared/router.ts`
- Move (protocol): `test/manifest.test.ts`, `test/settings.test.ts` to `test/engine/`
- Modify: `packages/core/vitest.config.ts`, `packages/core/vitest.browser.config.ts`, `packages/core/tsconfig.test.json`,
  `packages/core/tsconfig.test-browser.json`

**Interfaces:**

- Produces: the paths above. Later tasks name core's tests by their new paths, e.g.
  `packages/core/test/node/connection/connection.test.ts`, `packages/core/test/node/support/fake-worker.ts`.

- [ ] **Step 1: Save the import rewriter**

Save as `${TMPDIR:-/tmp}/rewrite-imports.py`:

```python
#!/usr/bin/env python3
# Rewrites relative import specifiers after files move.
# Usage: rewrite-imports.py <moves.json> <directory>...
# moves.json maps each old repository-relative path to its new one. Every .ts
# file under the directories is read at its new place; each relative
# specifier is resolved from where the file used to be, mapped through the
# moves, and written relative to where the file is now.
import json
import os
import re
import sys

moves = {os.path.normpath(old): os.path.normpath(new) for old, new in json.load(open(sys.argv[1])).items()}
previous = {new: old for old, new in moves.items()}
specifier = re.compile(r"""((?:\bfrom|\bimport)\s*\(?\s*|new URL\(\s*)(["'])(\.\.?/[^"']*)\2""")


def rewrite(path: str) -> None:
    was = previous.get(path, path)
    with open(path) as file:
        text = file.read()

    def replace(match: re.Match[str]) -> str:
        spec = match.group(3)
        target = os.path.normpath(os.path.join(os.path.dirname(was), spec))
        target = moves.get(target, target)
        relative = os.path.relpath(target, os.path.dirname(path))
        if not relative.startswith("."):
            relative = "./" + relative
        if spec.endswith("/"):
            relative += "/"
        return f"{match.group(1)}{match.group(2)}{relative}{match.group(2)}"

    updated = specifier.sub(replace, text)
    if updated != text:
        with open(path, "w") as file:
            file.write(updated)


for root in sys.argv[2:]:
    for directory, _, names in os.walk(root):
        for name in names:
            if name.endswith(".ts"):
                rewrite(os.path.normpath(os.path.join(directory, name)))
```

- [ ] **Step 2: Write the move list**

Save as `${TMPDIR:-/tmp}/test-moves.json`:

```json
{
  "packages/core/test/connection/connection.test.ts": "packages/core/test/node/connection/connection.test.ts",
  "packages/core/test/keys/translate.test.ts": "packages/core/test/node/keys/translate.test.ts",
  "packages/core/test/keys/us.test.ts": "packages/core/test/node/keys/us.test.ts",
  "packages/core/test/router/async.test.ts": "packages/core/test/node/router/async.test.ts",
  "packages/core/test/router/hang.test.ts": "packages/core/test/node/router/hang.test.ts",
  "packages/core/test/router/keystroke.test.ts": "packages/core/test/node/router/keystroke.test.ts",
  "packages/core/test/router/replay.test.ts": "packages/core/test/node/router/replay.test.ts",
  "packages/core/test/router/restart.test.ts": "packages/core/test/node/router/restart.test.ts",
  "packages/core/test/router/services.test.ts": "packages/core/test/node/router/services.test.ts",
  "packages/core/test/support/fake-worker.ts": "packages/core/test/node/support/fake-worker.ts",
  "packages/core/test/router/contexts.test.ts": "packages/core/test/browser/router/contexts.test.ts",
  "packages/core/test/router/preedit.test.ts": "packages/core/test/browser/router/preedit.test.ts",
  "packages/core/test/router/surrounding.test.ts": "packages/core/test/browser/router/surrounding.test.ts",
  "packages/core/test/router/content-type.test.ts": "packages/core/test/browser/router/content-type.test.ts",
  "packages/core/test/router/switching.test.ts": "packages/core/test/browser/router/switching.test.ts",
  "packages/core/test/router/dom-support.ts": "packages/core/test/browser/support/dom.ts",
  "packages/core/test/router/support.ts": "packages/core/test/shared/router.ts",
  "packages/protocol/test/manifest.test.ts": "packages/protocol/test/engine/manifest.test.ts",
  "packages/protocol/test/settings.test.ts": "packages/protocol/test/engine/settings.test.ts"
}
```

- [ ] **Step 3: Move the files with git**

```bash
python3 - "${TMPDIR:-/tmp}/test-moves.json" <<'EOF'
import json, os, subprocess, sys
for old, new in json.load(open(sys.argv[1])).items():
    os.makedirs(os.path.dirname(new), exist_ok=True)
    subprocess.run(["git", "mv", old, new], check=True)
EOF
```

Expected: no output; `git status --short` shows 19 renames (`R`).

- [ ] **Step 4: Rewrite the relative imports**

```bash
python3 "${TMPDIR:-/tmp}/rewrite-imports.py" "${TMPDIR:-/tmp}/test-moves.json" packages/core/test packages/protocol/test
```

Then check that every relative import resolves:

```bash
python3 - <<'EOF'
import os, re
missing = 0
for root in ["packages/core/test", "packages/protocol/test"]:
    for directory, _, names in os.walk(root):
        for name in names:
            if not name.endswith(".ts"):
                continue
            path = os.path.join(directory, name)
            for match in re.finditer(r"""(?:\bfrom|\bimport)\s*\(?\s*(["'])(\.\.?/[^"']*)\1""", open(path).read()):
                if not os.path.exists(os.path.normpath(os.path.join(directory, match.group(2)))):
                    print("missing", path, match.group(2))
                    missing += 1
print("missing", missing)
EOF
```

Expected: `missing 0`. Spot-check: `packages/core/test/browser/settings.test.ts` now imports `./support/dom.ts` and
`../shared/router.ts`; `packages/core/test/node/connection/connection.test.ts` imports `../../shared/router.ts` and
`../support/fake-worker.ts`.

- [ ] **Step 5: Point core's Vitest configs at the new folders**

Replace the `test` block of `packages/core/vitest.config.ts` so the whole file reads:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["test/node/**/*.test.ts"],
  },
});
```

In `packages/core/vitest.browser.config.ts`, replace

```ts
    include: ["test/browser/**/*.test.ts", "test/router/{contexts,preedit,surrounding,content-type,switching}.test.ts"],
```

with

```ts
    include: ["test/browser/**/*.test.ts"],
```

- [ ] **Step 6: Point core's test tsconfigs at the new folders**

In `packages/core/tsconfig.test.json`, set `include` to exactly `["test/node", "test/shared"]` and remove any `exclude`
or `files` entry that names a file under `test/router/`. In `packages/core/tsconfig.test-browser.json`, set `include` to
exactly `["test/browser", "test/shared"]` and remove any `files` entry naming `test/router/…`. Leave `extends` and
`compilerOptions` as Phase A wrote them.

Then confirm no config still names the old folders:

```bash
rg -n "test/(router|connection|keys|support)/" packages/core --glob '!test/**'
```

Expected: no output.

- [ ] **Step 7: Run the affected checks**

```bash
nix develop -c hk check --all
nix build .#checks.x86_64-linux.core .#checks.x86_64-linux.core-browser .#checks.x86_64-linux.protocol -L
```

Expected: hk passes (tsc for core's configs, tsconfig-extends, oxlint); the three checks build. Core's Node run reports
9 test files and core-browser 10, as before the move.

- [ ] **Step 8: Run the Global Constraints gate and commit**

```bash
nix develop -c git add packages/core packages/protocol/test
nix develop -c git commit -m "test: split core's tests by environment and file protocol's loose tests" -- packages/core packages/protocol/test
```

### Task D2: `test`, not `it`

Every Vitest file calls `test`. Effect's testers (`it.effect`, `it.live`, `it.scoped`, `it.layer`, `it.prop`) have no
`test.` form and stay on `it`.

**Files:**

- Modify: every tracked `*.test.ts` that calls `it(` or `it.<modifier>(`: today 39 files under `packages/` and `tools/`
  (`git ls-files '*.test.ts'` after Phase B lists their current paths)

**Interfaces:**

- Consumes: Task D1's paths.
- Produces: no new names.

- [ ] **Step 1: Save the converter**

Save as `${TMPDIR:-/tmp}/it-to-test.py`:

```python
#!/usr/bin/env python3
# Renames Vitest's it() to test() in the files given. Effect's testers
# (it.effect, it.live, it.scoped, it.scopedLive, it.layer, it.prop,
# it.flakyTest) have no test.* form, so they stay on it.
import re
import sys

EFFECT = r"(?:effect|live|scoped|scopedLive|layer|prop|flakyTest)\b"
call = re.compile(r"(?<![\w.$])it(?=\(|\.(?!" + EFFECT + r")\w)")
effect_call = re.compile(r"(?<![\w.$])it\." + EFFECT)
test_call = re.compile(r"(?<![\w.$])test(?=\(|\.\w)")
vitest_import = re.compile(r"""import\s*\{([^}]*)\}\s*from\s*(["'])(vitest|@effect/vitest)\2""")

for path in sys.argv[1:]:
    with open(path) as file:
        text = file.read()
    updated = call.sub("test", text)
    keeps_it = effect_call.search(updated) is not None
    calls_test = test_call.search(vitest_import.sub("", updated)) is not None

    def fix_import(match: re.Match[str]) -> str:
        names = [name.strip() for name in match.group(1).split(",") if name.strip()]
        if "it" not in names:
            return match.group(0)
        if not keeps_it:
            names.remove("it")
        if calls_test and "test" not in names:
            names.append("test")
        names.sort(key=lambda name: name.removeprefix("type ").lower())
        return f"import {{ {', '.join(names)} }} from {match.group(2)}{match.group(3)}{match.group(2)}"

    updated = vitest_import.sub(fix_import, updated)
    if updated != text:
        with open(path, "w") as file:
            file.write(updated)
```

- [ ] **Step 2: Run it over every test file**

```bash
python3 "${TMPDIR:-/tmp}/it-to-test.py" $(git ls-files '*.test.ts')
nix develop -c oxfmt $(git diff --name-only)
```

- [ ] **Step 3: Confirm nothing but Effect's testers calls `it`**

```bash
rg -nP '(?<![\w.$])it(?=\(|\.(?!(?:effect|live|scoped|scopedLive|layer|prop|flakyTest)\b)\w)' $(git ls-files '*.test.ts')
rg -n 'import \{[^}]*\bit\b[^}]*\} from "(@effect/)?vitest"' $(git ls-files '*.test.ts')
```

Expected: the first prints nothing. The second lists only files that still call an Effect tester, which today are
`packages/core/test/node/router/{services,restart}.test.ts`, `packages/protocol/test/gvariant/roundtrip.test.ts`,
`packages/protocol/test/ibus/types.test.ts`, `packages/protocol/test/messages/{codec,lookup}.test.ts`,
`packages/protocol/test/transport/{ring,ring-fuzz}.test.ts`, `packages/worker-host/test/browser/layers.test.ts` and
`packages/worker-host/test/node/install-{lifetime,progress}.test.ts`. Files whose only Effect tester calls are
`it.effect` import `it` and not `test`: `services.test.ts`, `restart.test.ts` and `roundtrip.test.ts` must read
`import { expect, it } from "@effect/vitest";`.

- [ ] **Step 4: Run the gate**

The rename touches every package's tests, so the full Global Constraints gate is this task's test run. Expected: every
check passes with the same test counts as before the task.

- [ ] **Step 5: Commit**

```bash
nix develop -c git add $(git diff --name-only)
nix develop -c git commit -m "test: call Vitest's test everywhere" -- $(git diff --cached --name-only)
```

### Task D3: One definition of each small helper in protocol

`asError` and `errorMessage` replace four copies across core, ibus-web and worker-host; `align`, `alignedSize` and
`nonEmpty` each get one definition inside protocol.

The two `briefly`s and the two `describe`s are different helpers, not copies of these: `briefly` keeps the error's name
(`TypeError: …`) for storage reports, and each `describe` keeps a stack. Task D5 merges the two identical `briefly`s;
the `describe`s stay.

**Files:**

- Create: `packages/protocol/src/errors.ts`, `packages/protocol/src/schemas.ts`,
  `packages/protocol/test/errors/errors.test.ts`
- Modify: `packages/protocol/src/index.ts`, `packages/protocol/src/gvariant/{type,encode,decode}.ts`,
  `packages/protocol/src/transport/ring.ts`, `packages/protocol/test/transport/support.ts`,
  `packages/protocol/src/{manifest,settings}.ts`, `packages/core/src/router/router.ts`,
  `packages/core/src/services/engines.ts`, `packages/ibus-web/src/index.ts`,
  `packages/worker-host/src/worker/install/archive.ts`

**Interfaces:**

- Produces, exported from `@ibus-web/protocol`:
  - `asError(cause: unknown): Error`: the value if it is an `Error`, else `new Error(String(cause))`
  - `errorMessage(cause: unknown): string`: an `Error`'s `message`, else `String(cause)`, else
    `"Unprintable host error"` when `String` throws
- Produces, inside protocol only: `align(size: number, alignment: number): number` exported from
  `src/gvariant/type.ts`; `alignedSize(payloadBytes: number): number` exported from `src/transport/ring.ts` (not from
  any barrel); `nonEmpty` exported from `src/schemas.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/errors/errors.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { asError, errorMessage } from "../../src/errors.ts";

test("asError keeps an Error and wraps anything else", () => {
  const error = new TypeError("bad input");
  expect(asError(error)).toBe(error);
  expect(asError("text")).toBeInstanceOf(Error);
  expect(asError("text").message).toBe("text");
  expect(asError(7).message).toBe("7");
});

test("errorMessage reads an Error's message and prints anything else", () => {
  expect(errorMessage(new RangeError("out of range"))).toBe("out of range");
  expect(errorMessage("text")).toBe("text");
  expect(errorMessage(undefined)).toBe("undefined");
});

test("errorMessage still returns text for a value that can't be printed", () => {
  const unprintable = {
    toString: () => {
      throw new Error("no");
    },
  };
  expect(errorMessage(unprintable)).toBe("Unprintable host error");
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
nix develop -c pnpm --dir packages/protocol exec vitest run --configLoader native test/errors
```

Expected: FAIL, `Cannot find module '../../src/errors.ts'`.

- [ ] **Step 3: Write the helpers**

Create `packages/protocol/src/errors.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Whatever was thrown, as an Error.
export const asError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));

// Whatever was thrown, as text. A value whose own toString() throws still
// yields some.
export const errorMessage = (cause: unknown): string => {
  try {
    return cause instanceof Error ? cause.message : String(cause);
  } catch {
    return "Unprintable host error";
  }
};
```

In `packages/protocol/src/index.ts`, after the line

```ts
export { encodeRequest, decodeRecord, type DecodedRecord } from "./messages/codec.ts";
```

add

```ts
export { asError, errorMessage } from "./errors.ts";
```

- [ ] **Step 4: Run the test to see it pass**

```bash
nix develop -c pnpm --dir packages/protocol exec vitest run --configLoader native test/errors
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Use the helpers in core**

In `packages/core/src/router/router.ts`, delete

```ts
const asError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));
```

and add `asError,` as the first name in the `import { … } from "@ibus-web/protocol";` list at the top of the file (the
list that begins `CreateEngine,`).

In `packages/core/src/services/engines.ts`, delete

```ts
const error = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));
```

replace each of its three calls, `error(cause)`, with `asError(cause)` (two in the starter's callbacks, one in the
`page-adapter` log record's `message: error(cause).message`), and change the protocol import to

```ts
import { asError, EngineManifest, Init, SettingChanged, PROTOCOL_VERSION, type Request } from "@ibus-web/protocol";
```

- [ ] **Step 6: Use the helpers in ibus-web and worker-host**

In `packages/ibus-web/src/index.ts`, delete

```ts
const messageOf = (error: unknown): string => {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unprintable host error";
  }
};
```

replace its two calls `messageOf(entry.message)` and `messageOf(error)` with `errorMessage(entry.message)` and
`errorMessage(error)`, and change

```ts
import { CandidateClicked, PageUp, PageDown, CursorUp, CursorDown, PropertyActivate } from "@ibus-web/protocol";
```

to

```ts
import {
  CandidateClicked,
  PageUp,
  PageDown,
  CursorUp,
  CursorDown,
  PropertyActivate,
  errorMessage,
} from "@ibus-web/protocol";
```

In `packages/worker-host/src/worker/install/archive.ts`, delete

```ts
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

```

replace its two calls `messageOf(error)` with `errorMessage(error)`, and add, above
`import { decompressed, type BrotliDecoder } from "./decompress.ts";`,

```ts
import { errorMessage } from "@ibus-web/protocol";
```

Then confirm no copy is left:

```bash
rg -n "const (asError|messageOf|error) = \(" packages --glob '!**/test/**'
```

Expected: one line, the definition in `packages/protocol/src/errors.ts`.

- [ ] **Step 7: Give `align` one definition**

In `packages/protocol/src/gvariant/type.ts`, replace

```ts
const align = (size: number, alignment: Alignment): number => Math.ceil(size / alignment) * alignment;
```

with

```ts
export const align = (size: number, alignment: number): number => Math.ceil(size / alignment) * alignment;
```

In `packages/protocol/src/gvariant/encode.ts`, replace

```ts
import { isSignature, parseType, ProtocolError, type GVariantType } from "./type.ts";
import { type GVariantValue } from "./value.ts";

export const align = (size: number, alignment: number): number => Math.ceil(size / alignment) * alignment;
```

with

```ts
import { align, isSignature, parseType, ProtocolError, type GVariantType } from "./type.ts";
import { type GVariantValue } from "./value.ts";
```

In `packages/protocol/src/gvariant/decode.ts`, replace

```ts
import { isSignature, parseType, type GVariantType } from "./type.ts";
import { align, framingWidth, offsetWidth } from "./encode.ts";
```

with

```ts
import { align, isSignature, parseType, type GVariantType } from "./type.ts";
import { framingWidth, offsetWidth } from "./encode.ts";
```

- [ ] **Step 8: Give `alignedSize` one definition**

In `packages/protocol/src/transport/ring.ts`, replace

```ts
const alignedSize = (payloadBytes: number): number =>
```

with

```ts
// A record's bytes in the ring: its header and payload, padded to the
// record alignment.
export const alignedSize = (payloadBytes: number): number =>
```

In `packages/protocol/test/transport/support.ts`, delete

```ts
const alignedSize = (payloadBytes: number): number =>
  Math.ceil((RECORD_HEADER_BYTES + payloadBytes) / RECORD_ALIGNMENT) * RECORD_ALIGNMENT;

```

and after the `} from "../../src/transport/layout.ts";` line add

```ts
import { alignedSize } from "../../src/transport/ring.ts";
```

`RECORD_HEADER_BYTES` and `RECORD_ALIGNMENT` stay imported: the file uses both elsewhere.

- [ ] **Step 9: Give `nonEmpty` one definition**

Create `packages/protocol/src/schemas.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";

export const nonEmpty = Schema.String.check(Schema.isNonEmpty());
```

In `packages/protocol/src/manifest.ts`, replace

```ts
import { Schema } from "effect";

const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const nonEmpty = Schema.String.check(Schema.isNonEmpty());
```

with

```ts
import { Schema } from "effect";
import { nonEmpty } from "./schemas.ts";

const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
```

In `packages/protocol/src/settings.ts`, delete the line `const nonEmpty = Schema.String.check(Schema.isNonEmpty());`
and after `import type { GVariantValue } from "./gvariant/value.ts";` add `import { nonEmpty } from "./schemas.ts";`.

- [ ] **Step 10: Run the affected checks**

```bash
nix develop -c pnpm --dir packages/protocol exec vitest run --configLoader native test/gvariant test/transport test/engine test/errors
nix develop -c hk check --all
nix build .#checks.x86_64-linux.protocol .#checks.x86_64-linux.core .#checks.x86_64-linux.ibus-web .#checks.x86_64-linux.worker-host-node -L
```

Expected: all pass. (`test/ibus/flags.test.ts` needs `IBUS_WEB_FLAGS`, which only its Nix check sets, so the local run
leaves `test/ibus` out.)

- [ ] **Step 11: Run the gate and commit**

```bash
nix develop -c git add packages/protocol packages/core/src packages/ibus-web/src packages/worker-host/src
nix develop -c git commit -m "refactor: share error and alignment helpers through protocol" -- packages/protocol packages/core/src packages/ibus-web/src packages/worker-host/src
```

### Task D4: Panel types live in protocol

The panel's action, record, event and update types are defined once in `@ibus-web/protocol`. Core and panel import them,
and ibus-web decodes panel actions with protocol's `PanelAction` schema instead of rebuilding the union.

**Files:**

- Create: `packages/protocol/src/messages/panel.ts`, `packages/protocol/test/messages/panel.test.ts`
- Modify: `packages/protocol/src/index.ts`, `packages/core/src/services/logging.ts`,
  `packages/core/src/router/{contexts,router}.ts`, `packages/core/src/page/index.ts`,
  `packages/core/test/node/connection/connection.test.ts`, `packages/panel/src/host.ts`, `packages/ibus-web/src/index.ts`

**Interfaces:**

- Produces, exported from `@ibus-web/protocol`:
  - `PanelAction`: a `Schema.Union` of `CandidateClicked`, `PageUp`, `PageDown`, `CursorUp`, `CursorDown`,
    `PropertyActivate`, and `type PanelAction = typeof PanelAction.Type`
  - `type PanelRecord`: the eight lookup-table, auxiliary-text and property records of `LazyOutputRecord`
  - `type PanelEvent = { engine: string; ic: number } & ({ _tag: "record"; record: PanelRecord } | { _tag: "hide" | "caret" })`
  - `type PanelUpdate`: `PanelEvent`'s shape with `"orientation"` added beside `"hide" | "caret"`
- Changes: `@ibus-web/core` no longer exports `PanelEvent` or `PanelRecord`; `@ibus-web/panel` and `ibus-web` keep
  exporting `PanelAction`, `PanelRecord`, `PanelUpdate` as types, now protocol's.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/messages/panel.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { expect, test } from "vitest";
import { PanelAction } from "../../src/messages/panel.ts";

const decode = Schema.decodeUnknownSync(PanelAction);

test("PanelAction accepts each request a panel sends", () => {
  for (const tag of ["PageUp", "PageDown", "CursorUp", "CursorDown"] as const)
    expect(decode({ _tag: tag })._tag).toBe(tag);
  expect(decode({ _tag: "CandidateClicked", index: 2, button: 1, state: 0 })).toMatchObject({
    _tag: "CandidateClicked",
    index: 2,
  });
  expect(decode({ _tag: "PropertyActivate", name: "B", state: 1 })).toMatchObject({
    _tag: "PropertyActivate",
    name: "B",
  });
});

test("PanelAction rejects requests a panel doesn't send, and malformed ones", () => {
  expect(() => decode({ _tag: "ProcessKeyEvent", keyval: 97, keycode: 30, state: 0 })).toThrow();
  expect(() => decode({ _tag: "CandidateClicked", index: -1, button: 1, state: 0 })).toThrow();
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
nix develop -c pnpm --dir packages/protocol exec vitest run --configLoader native test/messages/panel.test.ts
```

Expected: FAIL, `Cannot find module '../../src/messages/panel.ts'`.

- [ ] **Step 3: Define the panel types**

Create `packages/protocol/src/messages/panel.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import type { LazyOutputRecord } from "./lookup.ts";
import { CandidateClicked, CursorDown, CursorUp, PageDown, PageUp, PropertyActivate } from "./requests.ts";

// The requests a candidate or property panel sends its engine.
export const PanelAction = Schema.Union([CandidateClicked, PageUp, PageDown, CursorUp, CursorDown, PropertyActivate]);
export type PanelAction = typeof PanelAction.Type;

// The output records a panel draws.
export type PanelRecord = Extract<
  LazyOutputRecord,
  {
    _tag:
      | "UpdateLookupTable"
      | "ShowLookupTable"
      | "HideLookupTable"
      | "UpdateAuxiliaryText"
      | "ShowAuxiliaryText"
      | "HideAuxiliaryText"
      | "RegisterProperties"
      | "UpdateProperty";
  }
>;

interface PanelContext {
  readonly engine: string;
  readonly ic: number;
}

interface PanelDraw {
  readonly _tag: "record";
  readonly record: PanelRecord;
}

// What the page hears for an engine's input context: a record to draw, or
// that the panel should hide (on focus out or a crash) or follow the caret.
export type PanelEvent = PanelContext & (PanelDraw | { readonly _tag: "hide" | "caret" });

// What a panel hears: the page's events, or that the lookup table's
// orientation setting changed.
export type PanelUpdate = PanelContext & (PanelDraw | { readonly _tag: "hide" | "caret" | "orientation" });
```

In `packages/protocol/src/index.ts`, after the `export { asError, errorMessage } from "./errors.ts";` line Task D3
added, add

```ts
export { PanelAction, type PanelEvent, type PanelRecord, type PanelUpdate } from "./messages/panel.ts";
```

- [ ] **Step 4: Run the test to see it pass**

```bash
nix develop -c pnpm --dir packages/protocol exec vitest run --configLoader native test/messages/panel.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Core imports the types from protocol**

In `packages/core/src/services/logging.ts`, change

```ts
import type { Log, LazyOutputRecord } from "@ibus-web/protocol";
```

to

```ts
import type { Log, PanelEvent } from "@ibus-web/protocol";
```

and delete these two definitions:

```ts
export type PanelRecord = Extract<
  LazyOutputRecord,
  {
    _tag:
      | "UpdateAuxiliaryText"
      | "ShowAuxiliaryText"
      | "HideAuxiliaryText"
      | "UpdateLookupTable"
      | "ShowLookupTable"
      | "HideLookupTable"
      | "RegisterProperties"
      | "UpdateProperty";
  }
>;

export type PanelEvent = { readonly engine: string; readonly ic: number } & (
  | { readonly _tag: "record"; readonly record: PanelRecord }
  | { readonly _tag: "hide" | "caret" }
);

```

In `packages/core/src/router/contexts.ts`, replace

```ts
import { SetCursorLocation, SetSurroundingText, type DecodedLazyRecord, type Request } from "@ibus-web/protocol";
```

with

```ts
import {
  SetCursorLocation,
  SetSurroundingText,
  type DecodedLazyRecord,
  type PanelEvent,
  type Request,
} from "@ibus-web/protocol";
```

and delete `import type { PanelEvent } from "../services/logging.ts";`.

In `packages/core/src/router/router.ts`, change

```ts
import { PanelEvents, SyncMailbox, type PanelEvent } from "../services/logging.ts";
```

to

```ts
import { PanelEvents, SyncMailbox } from "../services/logging.ts";
```

and add `type PanelEvent,` to the `@ibus-web/protocol` import list, after `IBusCapability as Cap,`.

In `packages/core/src/page/index.ts`, replace

```ts
export {
  Logger,
  PanelEvents,
  glibLevel,
  type LogLine,
  type PanelEvent,
  type PanelRecord,
} from "../services/logging.ts";
```

with

```ts
export { Logger, PanelEvents, glibLevel, type LogLine } from "../services/logging.ts";
```

In `packages/core/test/node/connection/connection.test.ts`, delete

```ts
import type { PanelEvent } from "../../../src/services/logging.ts";
```

and add `type PanelEvent,` to the `@ibus-web/protocol` import list, after `transportLayout,`.

- [ ] **Step 6: Panel re-exports protocol's types**

In `packages/panel/src/host.ts`, replace everything from the protocol import through the end of `PanelUpdate`:

```ts
import type { LazyOutputRecord, Request } from "@ibus-web/protocol";

export type PanelAction = Extract<
  Request,
  { _tag: "CandidateClicked" | "PageUp" | "PageDown" | "CursorUp" | "CursorDown" | "PropertyActivate" }
>;

export type PanelRecord = Extract<
  LazyOutputRecord,
  {
    _tag:
      | "UpdateLookupTable"
      | "ShowLookupTable"
      | "HideLookupTable"
      | "UpdateAuxiliaryText"
      | "ShowAuxiliaryText"
      | "HideAuxiliaryText"
      | "RegisterProperties"
      | "UpdateProperty";
  }
>;

export type PanelUpdate = { readonly engine: string; readonly ic: number } & (
  | { readonly _tag: "record"; readonly record: PanelRecord }
  | { readonly _tag: "hide" | "caret" | "orientation" }
);
```

with

```ts
import type { PanelAction } from "@ibus-web/protocol";

export type { PanelAction, PanelRecord, PanelUpdate } from "@ibus-web/protocol";
```

`packages/panel/src/index.ts`, `panel.ts` and `properties.ts` keep importing these names from `./host.ts`.

- [ ] **Step 7: ibus-web decodes with protocol's schema**

In `packages/ibus-web/src/index.ts`, replace the protocol and panel imports Task D3 left

```ts
import {
  CandidateClicked,
  PageUp,
  PageDown,
  CursorUp,
  CursorDown,
  PropertyActivate,
  errorMessage,
} from "@ibus-web/protocol";
import type { PanelAction, PanelHost, PanelUpdate } from "@ibus-web/panel";
```

with

```ts
import { errorMessage, PanelAction } from "@ibus-web/protocol";
import type { PanelHost, PanelUpdate } from "@ibus-web/panel";
```

and replace

```ts
const decodePanelAction = Schema.decodeUnknownSync(
  Schema.Union([CandidateClicked, PageUp, PageDown, CursorUp, CursorDown, PropertyActivate]),
);
```

with

```ts
const decodePanelAction = Schema.decodeUnknownSync(PanelAction);
```

The line `export type { PanelAction, PanelHost, PanelUpdate } from "@ibus-web/panel";` stays: it re-exports without
binding a local name, so it doesn't clash with the imported schema.

- [ ] **Step 8: Confirm each type has one definition**

```bash
rg -n "type Panel(Action|Record|Event|Update) =" packages
```

Expected: exactly four lines, all in `packages/protocol/src/messages/panel.ts`.

- [ ] **Step 9: Run the affected checks**

```bash
nix develop -c hk check --all
nix build .#checks.x86_64-linux.protocol .#checks.x86_64-linux.core .#checks.x86_64-linux.core-browser .#checks.x86_64-linux.panel .#checks.x86_64-linux.ibus-web .#checks.x86_64-linux.bundle-scan -L
```

Expected: all pass. `ibus-web`'s `published facade declarations` test compiles a consumer against the built declarations,
including `detail.record._tag` on a `panel` event, so it fails if `PanelUpdate` lost a member.

- [ ] **Step 10: Run the gate and commit**

```bash
nix develop -c git add packages/protocol packages/core packages/panel/src packages/ibus-web/src
nix develop -c git commit -m "refactor: define the panel's types once, in protocol" -- packages/protocol packages/core packages/panel/src packages/ibus-web/src
```

### Task D5: Worker-host's copied helpers

`nodeFs` and its interface, and the two identical `briefly`s, each get one definition. `worker/store.ts`, which shares a
name with `worker/install/store.ts` but only sets an environment variable, becomes `worker/schema-dir.ts`. The test
build's two identical timer promises become one.

`INSTALL_PIECE` keeps its copy in `test/shared/install.ts`: `test/shared/` compiles without any environment's globals
and so can't import `src/worker/install/archive.ts`, which uses `fetch` and the Worker's globals.

**Files:**

- Create: `packages/worker-host/src/worker/node-fs.ts`
- Rename: `packages/worker-host/src/worker/store.ts` to `packages/worker-host/src/worker/schema-dir.ts`
- Modify: `packages/worker-host/src/worker/install/store.ts`, `packages/worker-host/src/worker/storage/mount.ts`,
  `packages/worker-host/src/worker/storage/plan.ts`, `packages/worker-host/src/worker/install/provide.ts`,
  `packages/worker-host/src/worker/failure.ts`, `packages/worker-host/src/worker/host.ts`,
  `packages/worker-host/test/worker/instruments.ts`

**Interfaces:**

- Produces: `nodeFs(): Promise<NodeFs>` and `interface NodeFs` from `src/worker/node-fs.ts`;
  `briefly(error: unknown): string` from `src/worker/failure.ts`;
  `setSchemaDir(handle: RuntimeHandle, manifest: EngineManifest): void` from `src/worker/schema-dir.ts` (was
  `mountStore` in `store.ts`).

- [ ] **Step 1: One `nodeFs`**

Create `packages/worker-host/src/worker/node-fs.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a host under Node uses of node:fs/promises.
export interface NodeFs {
  open(
    path: string,
    flags: "w" | "r",
  ): Promise<{
    writeFile(text: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

// Only a host under Node is given Node storage, so only it imports this.
export const nodeFs = (): Promise<NodeFs> => import("node:fs/promises" as string) as Promise<NodeFs>;
```

In `packages/worker-host/src/worker/install/store.ts`, delete the block from `// What a host under Node uses of
node:fs/promises.` through `const nodeFs = (): Promise<NodeFs> => …;` and the blank line after it (the interface with
`open`, `readFile`, `readdir`, `rename`, `mkdir`, `rm`), and add above
`import { withString, type RuntimeHandle } from "../runtime.ts";`:

```ts
import { nodeFs } from "../node-fs.ts";
```

In `packages/worker-host/src/worker/storage/mount.ts`, delete

```ts
// What a host under Node uses of node:fs/promises.
interface NodeFs {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
}

// Only a host under Node is given Node storage, so only it imports this.
const nodeFs = (): Promise<NodeFs> => import("node:fs/promises" as string) as Promise<NodeFs>;

```

and add above `import { check, RuntimeRefused, withString, type RuntimeHandle } from "../runtime.ts";`:

```ts
import { nodeFs } from "../node-fs.ts";
```

- [ ] **Step 2: One `briefly`**

In `packages/worker-host/src/worker/failure.ts`, insert above the comment `// A failure in a step that calls nothing in a
runtime the host keeps:`

```ts
// An error's name and message on one line, for a report that has no room
// for its stack.
export const briefly = (error: unknown): string =>
  error instanceof Error || error instanceof DOMException ? `${error.name}: ${error.message}` : String(error);

```

In both `packages/worker-host/src/worker/storage/plan.ts` and `packages/worker-host/src/worker/install/provide.ts`,
delete

```ts
const briefly = (error: unknown): string =>
  error instanceof Error || error instanceof DOMException ? `${error.name}: ${error.message}` : String(error);

```

In `plan.ts`, add after `import { requestLock } from "./locks.ts";`:

```ts
import { briefly } from "../failure.ts";
```

In `provide.ts`, change

```ts
import { runtimeCallFailed, runtimeFinalizer, startupFailed, StartupFailed } from "../failure.ts";
```

to

```ts
import { briefly, runtimeCallFailed, runtimeFinalizer, startupFailed, StartupFailed } from "../failure.ts";
```

- [ ] **Step 3: Rename `store.ts`**

```bash
git mv packages/worker-host/src/worker/store.ts packages/worker-host/src/worker/schema-dir.ts
```

Replace the contents of `packages/worker-host/src/worker/schema-dir.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { EngineManifest } from "@ibus-web/protocol";
import { check, withString, type RuntimeHandle } from "./runtime.ts";

// Points GLib at the engine's settings schemas, which the data install
// mounts under /nix/store. It must run before Init: GLib caches its default
// schema source on first use.
export const setSchemaDir = (handle: RuntimeHandle, manifest: EngineManifest): void => {
  withString(handle, "GSETTINGS_SCHEMA_DIR", (name) =>
    withString(handle, manifest.settingsSchemaDir, (value) =>
      check("setenv GSETTINGS_SCHEMA_DIR", handle.rt._setenv(name, value, 1)),
    ),
  );
};
```

In `packages/worker-host/src/worker/host.ts`, change `import { mountStore } from "./store.ts";` to
`import { setSchemaDir } from "./schema-dir.ts";`, and
`yield* Effect.try({ try: () => mountStore(handle, manifest), catch: runtimeCallFailed });` to
`yield* Effect.try({ try: () => setSchemaDir(handle, manifest), catch: runtimeCallFailed });`.

- [ ] **Step 4: One timer promise in the test build**

In `packages/worker-host/test/worker/instruments.ts`, delete

```ts
// Long enough that the loop reaches the messages already queued for it, not
// only the timer.
const yieldToEventLoop = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

```

and replace

```ts
          counters.eventLoopTurns++;
          return yieldToEventLoop(arg(10)).then(() => ({ ret: 0 }));
```

with

```ts
          counters.eventLoopTurns++;
          // Long enough that the loop reaches the messages already queued
          // for it, not only the timer.
          return sleep(arg(10)).then(() => ({ ret: 0 }));
```

- [ ] **Step 5: Confirm the copies are gone**

```bash
rg -n "interface NodeFs|const nodeFs|const briefly|yieldToEventLoop|mountStore" packages/worker-host
```

Expected: exactly `src/worker/node-fs.ts` (`interface NodeFs`, `const nodeFs`) and `src/worker/failure.ts`
(`const briefly`).

- [ ] **Step 6: Run the affected checks**

```bash
nix develop -c hk check --all
nix build .#checks.x86_64-linux.worker-host-node .#checks.x86_64-linux.worker-host-browser .#checks.x86_64-linux.hangul-host -L
```

Expected: all pass.

- [ ] **Step 7: Run the gate and commit**

```bash
nix develop -c git add packages/worker-host
nix develop -c git commit -m "refactor(worker-host): define copied helpers once and name the schema setup for what it does" -- packages/worker-host
```

### Task D6: One host launcher for both test environments

The Node and browser harnesses each built a host's `HostInit`, started it and wrapped it in a blocking client, in about
80 lines that differed only in how they make a Worker, resolve a URL, compile a module and hold the caller's thread.
`test/shared/harness.ts` takes that sequence, with those differences as parameters.

What stays per environment: the clock (`setTimeout` and `performance` aren't in `test/shared/`'s globals), the call to
`navigator.locks`, and the `record` reporter (`console`).

**Files:**

- Modify: `packages/worker-host/test/shared/harness.ts`, `packages/worker-host/test/browser/harness.ts`,
  `packages/worker-host/test/node/harness.ts`

**Interfaces:**

- Produces, from `test/shared/harness.ts`:
  - `LATE_REPLY_MS = 30_000`
  - `waitFree(words: Int32Array, index: number, value: number, ms: number): Promise<void>`
  - `runtimeModules<Wasm>(compile: (wasmUrl: string) => Promise<Wasm>): (runtimeUrl: string) => Promise<Wasm>`
  - `interface LaunchedWorker extends HostWorker { terminate(): unknown }`
  - `interface LaunchEnv<Wasm> extends Clock { data; sides; worker(url); resolve(url); runtimeModule(runtimeUrl); compile(bytes); block; budgetMs }`
  - `hostLauncher<Wasm>(env: LaunchEnv<Wasm>): Launch`

- [ ] **Step 1: Record the current test counts**

```bash
for check in worker-host-node worker-host-browser; do
  nix build ".#checks.x86_64-linux.$check" -L 2>&1 | grep -E "Test Files|Tests " > "${TMPDIR:-/tmp}/$check.before"
done
```

- [ ] **Step 2: Add the shared launcher**

In `packages/worker-host/test/shared/harness.ts`, replace the imports

```ts
import type { TransportLayout } from "@ibus-web/protocol/transport";
import type { HostConfigValues } from "../../src/shared/config.ts";
import type { EngineManifest, EngineStorage, RuntimeConstants, SideModule } from "../../src/shared/messages.ts";
import { engineWriterLock } from "../../src/shared/naming.ts";
import type { Client, Clock } from "./client.ts";
import type { Message, TestInit } from "./testing.ts";
```

with

```ts
import type { EngineManifest } from "@ibus-web/protocol";
import type { TransportLayout } from "@ibus-web/protocol/transport";
import type { HostConfigValues } from "../../src/shared/config.ts";
import { createControl } from "../../src/shared/control.ts";
import type { EngineStorage, HostInit, RuntimeConstants, SideModule } from "../../src/shared/messages.ts";
import { engineWriterLock } from "../../src/shared/naming.ts";
import { startHost, type HostWorker } from "./bootstrap.ts";
import { blockingClient, type BlockingClientEnv, type Client, type Clock } from "./client.ts";
import type { Message, TestInit } from "./testing.ts";
```

and append to the end of the file:

```ts
// A caller past its budget waits up to this long more for a reply without
// holding its thread; a reply that needed the wait fails the test that
// waited.
export const LATE_REPLY_MS = 30_000;

// Waits while words[index] is value, for at most ms, without holding the
// thread.
export const waitFree = async (words: Int32Array, index: number, value: number, ms: number): Promise<void> => {
  const result = Atomics.waitAsync(words, index, value, ms);
  if (result.async) await result.value;
};

// Compiles each runtime's module once, by its .wasm beside the runtime's
// script.
export const runtimeModules = <Wasm>(
  compile: (wasmUrl: string) => Promise<Wasm>,
): ((runtimeUrl: string) => Promise<Wasm>) => {
  const compiled = new Map<string, Promise<Wasm>>();
  return (runtimeUrl) => {
    const wasm = runtimeUrl.replace(/\.js$/, ".wasm");
    let module = compiled.get(wasm);
    if (module === undefined) {
      module = compile(wasm);
      compiled.set(wasm, module);
    }
    return module;
  };
};

// What a host's Worker is to the harness: a browser's Worker, or Node's
// stand-in for one.
export interface LaunchedWorker extends HostWorker {
  terminate(): unknown;
}

// Where launching a host differs between test environments.
export interface LaunchEnv<Wasm> extends Clock {
  data: TestData;
  sides: readonly SideModule[];
  worker(url: string): LaunchedWorker;
  // A URL as the host's Worker loads it.
  resolve(url: string): string;
  runtimeModule(runtimeUrl: string): Promise<Wasm>;
  compile(bytes: Uint8Array): Promise<Wasm>;
  // How the caller holds its thread for a reply; a thread that can't block
  // returns at once and spins.
  block: BlockingClientEnv["block"];
  budgetMs: number;
}

// Launches hosts the same way in every environment: the test build's
// HostInit, then a client that holds the caller's thread for each reply.
export const hostLauncher =
  <Wasm>(env: LaunchEnv<Wasm>): Launch =>
  (options, messages) => {
    const { data } = env;
    const control = createControl(options.layout);
    const worker = env.worker(hostUrlFor(data, options));
    const minimum = data.constants.memory.minimum;
    const test: TestInit = {
      mallinfo: data.constants.mallinfo,
      sides: [...env.sides, ...(options.moreSides ?? [])],
      config: testHostConfig(options),
      ...(options.relayFailsAfter === undefined ? {} : { relayFailsAfter: options.relayFailsAfter }),
      ...options.test,
    };
    // A browser's terminate() returns before its Worker has stopped; Node's
    // stand-in settles once it has.
    const terminate = async (): Promise<void> => {
      await worker.terminate();
    };
    const ready = (async (): Promise<RunningHost> => {
      const init: HostInit<Wasm, TestInit> = {
        runtimeUrl: env.resolve(options.runtime.url),
        wasm:
          options.wasm === undefined ? await env.runtimeModule(options.runtime.url) : await env.compile(options.wasm),
        control,
        ...(options.layout === undefined ? {} : { layout: options.layout }),
        ...(options.manifestUrl === undefined
          ? {
              manifest: {
                ...(options.manifest ?? options.engine ?? data.engines.empty),
                memory: options.memory?.initial ?? options.manifest?.memory ?? options.engine?.memory ?? minimum,
              },
            }
          : { manifestUrl: env.resolve(options.manifestUrl) }),
        storage: options.storage ?? { kind: "none" },
        test,
      };
      const startupMs = await startHost(worker, init, messages);
      const client = blockingClient(
        control,
        messages,
        {
          now: env.now,
          sleep: env.sleep,
          schedule: env.schedule,
          block: env.block,
          budgetMs: env.budgetMs,
          lateReply: { wait: waitFree, ms: LATE_REPLY_MS },
        },
        options.layout,
      );
      worker.addEventListener("message", ({ data }) => {
        if ((data as Message).type === "doorbell") client.page.onDoorbell();
        if ((data as Message).type === "crashed") client.page.onCrash();
      });
      return {
        client,
        instrumented: options.released !== true,
        startupMs,
        messages,
        terminate,
      };
    })();
    return { messages, ready, terminate };
  };
```

- [ ] **Step 3: The browser harness uses it**

Replace the contents of `packages/worker-host/test/browser/harness.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The scenarios' harness in a browser: hosts started by URL from the built
// package, driven from the page's main thread, which can't block, so it
// spins for each reply as the synchronous keystroke path would, and what the
// hosts' Workers print to their consoles, taken by the tests.

import type { EngineManifest } from "@ibus-web/protocol";
import { inject } from "vitest";
import { commands } from "vitest/browser";
import type { SideModule } from "../../src/shared/messages.ts";
import { engineDatabase, engineDataDatabase, engineDataDatabasePrefix } from "../../src/shared/naming.ts";
import type { Clock } from "../shared/client.ts";
import {
  hostLauncher,
  launchingAsAPage,
  runtimeModules,
  startFrom,
  type Harness,
  type Launch,
} from "../shared/harness.ts";
import { LOCK_RELEASE_LIMIT_MS, locksFrom, type WebLocks } from "../shared/locks.ts";
import { printedFrom } from "../shared/printed.ts";
import "./commands.ts";

// A spinning page gives up on a reply after this long, twenty times the
// longest any request takes when nothing waits for the page (Chromium's
// spawn(4), some 50 ms), then waits for it without holding its thread: a
// reply that comes only then needed the page's main thread.
const SPIN_LIMIT_MS = 1000;

// A bound on a console line's way to the commands, for a loaded machine.
const SETTLE_LIMIT_MS = 10_000;

const clock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

const fetchOk = async (url: string): Promise<Response> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
};

const opened = (request: IDBOpenDBRequest): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

// Opening a database at a newer version waits until every other connection
// to it has closed.
const upgradeDatabase = async (engine: EngineManifest): Promise<number> => {
  const startedAt = performance.now();
  const name = engineDatabase(engine);
  const current = await opened(indexedDB.open(name));
  const { version } = current;
  current.close();
  (await opened(indexedDB.open(name, version + 1))).close();
  return performance.now() - startedAt;
};

// Writes what isn't a marker where the version's marker is, as a write cut
// short would leave it.
const tearMarker = async (engine: EngineManifest): Promise<void> => {
  const db = await opened(indexedDB.open(engineDataDatabase(engine)));
  try {
    const tx = db.transaction("meta", "readwrite");
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    tx.objectStore("meta").put('{"vers', "installed");
    await done;
  } finally {
    db.close();
  }
};

// Deletes the database, once every connection to it has closed: a
// terminated host's close as its Worker ends.
const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    const timer = setTimeout(
      () => reject(new Error(`deleting ${name}: still blocked after ${LOCK_RELEASE_LIMIT_MS} ms`)),
      LOCK_RELEASE_LIMIT_MS,
    );
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  });

// What the page's Workers printed, once everything printed before the call
// has arrived. Their consoles reach the commands over the one connection to
// the browser, in the order the browser sends them, so once a line printed
// by a Worker started now has arrived, so has every line printed earlier.
const settledConsole = async (): Promise<string[]> => {
  const marker = `ibus-web-settled-${crypto.randomUUID()}`;
  const url = URL.createObjectURL(new Blob([`console.log(${JSON.stringify(marker)});`], { type: "text/javascript" }));
  const worker = new Worker(url);
  try {
    const lines: string[] = [];
    const deadline = performance.now() + SETTLE_LIMIT_MS;
    for (;;) {
      const taken = await commands.consoleTake();
      const at = taken.indexOf(marker);
      if (at >= 0) return [...lines, ...taken.slice(0, at), ...taken.slice(at + 1)];
      lines.push(...taken);
      if (performance.now() >= deadline) throw new Error(`a Worker's console line took over ${SETTLE_LIMIT_MS} ms`);
      await clock.sleep(5);
    }
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
};

export const browserHarness = async (): Promise<Harness> => {
  if (!crossOriginIsolated) throw new Error("the page is not cross-origin isolated");
  await commands.consoleBegin();
  const data = inject("workerHost");
  const sides: SideModule[] = await Promise.all(
    data.sides.map(async ({ name, url }) => ({ name, bytes: await (await fetchOk(url)).arrayBuffer() })),
  );
  const locks = locksFrom(navigator.locks as unknown as WebLocks, (ms) => AbortSignal.timeout(ms) as never);
  const launchHost = hostLauncher<WebAssembly.Module>({
    ...clock,
    data,
    sides,
    worker: (url) => new Worker(url, { type: "module", name: "ibus-web-host" }),
    resolve: (url) => new URL(url, location.href).href,
    runtimeModule: runtimeModules((wasm) => WebAssembly.compileStreaming(fetchOk(wasm))),
    compile: (bytes) => WebAssembly.compile(new Uint8Array(bytes)),
    block: () => {},
    budgetMs: SPIN_LIMIT_MS,
  });
  // The databases hosts were given, which outlive them.
  const databases = new Set<string>();
  const launch: Launch = (options, messages) => {
    if (options.storage?.kind === "browser" && options.engine !== undefined) {
      databases.add(engineDatabase(options.engine));
      if (options.engine.version !== "") databases.add(engineDataDatabase(options.engine));
    }
    return launchHost(options, messages);
  };
  const launchAsAPage = launchingAsAPage(launch, locks);
  return {
    ...clock,
    data,
    sides,
    launch: launchAsAPage,
    start: startFrom(launchAsAPage),
    locks,
    storage: () => ({ kind: "browser" }),
    versions: async (engine) => {
      const prefix = engineDataDatabasePrefix(engine);
      return (await indexedDB.databases()).flatMap(({ name }) =>
        name?.startsWith(prefix) === true ? [name.slice(prefix.length)] : [],
      );
    },
    tearMarker,
    // A connection without a versionchange handler stays open when another
    // asks it to close.
    holdDataDatabase: async (engine) => {
      const db = await opened(indexedDB.open(engineDataDatabase(engine)));
      return () => db.close();
    },
    storageMount: "indexeddb",
    withoutIndexedDB: { withoutIndexedDB: true },
    upgradeDatabase,
    cleanUp: async () => {
      await Promise.all([...databases].map(deleteDatabase));
      databases.clear();
    },
    printed: printedFrom(() => commands.consoleTake(), settledConsole, clock),
    record: (name, measurements) => console.log(`${name}: ${JSON.stringify(measurements)}`),
    pendingLimitMs: 10_000,
  };
};
```

- [ ] **Step 4: The Node harness uses it**

Replace the contents of `packages/worker-host/test/node/harness.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The scenarios' harness under Node: hosts in worker_threads, driven from
// this thread, which blocks for each reply as the page's synchronous path
// would spin, and everything the hosts' threads print, taken by the tests.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { EngineManifest } from "@ibus-web/protocol";
import { inject } from "vitest";
import type { SideModule } from "../../src/shared/messages.ts";
import { encodeComponent } from "../../src/shared/naming.ts";
import type { Clock } from "../shared/client.ts";
import { hostLauncher, launchingAsAPage, runtimeModules, startFrom, type Harness } from "../shared/harness.ts";
import { locksFrom, type WebLocks } from "../shared/locks.ts";
import { printedFrom } from "../shared/printed.ts";
import { BrowserWorker } from "./browser-worker.ts";

// A call holds this thread for at most this long, then waits for the reply
// without holding it.
const BUDGET_MS = 1000;

const clock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

const scratch = mkdtempSync(join(tmpdir(), "ibus-web-worker-host-"));

// What the hosts' threads print goes to a file of this process's own.
const output = join(scratch, "output.txt");
process.env["IBUS_WEB_WORKER_HOST_OUTPUT"] = output;
writeFileSync(output, "");
let readTo = 0;
let partial = "";

// The lines printed since the last call: whole lines only, the rest kept
// for the next.
const drain = (): string[] => {
  const bytes = readFileSync(output).subarray(readTo);
  readTo += bytes.length;
  const lines = (partial + bytes.toString("utf8")).split("\n");
  partial = lines.pop()!;
  return lines.filter((line) => line !== "");
};

const bytesOf = async (url: string): Promise<ArrayBuffer> => {
  const bytes = await readFile(fileURLToPath(url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

export const nodeHarness = async (): Promise<Harness> => {
  const data = inject("workerHost");
  const sides: SideModule[] = await Promise.all(
    data.sides.map(async ({ name, url }) => ({ name, bytes: await bytesOf(url) })),
  );
  const locks = locksFrom(navigator.locks as unknown as WebLocks, (ms) => AbortSignal.timeout(ms) as never);
  const launch = hostLauncher<WebAssembly.Module>({
    ...clock,
    data,
    sides,
    worker: (url) => new BrowserWorker(url),
    resolve: (url) => url,
    runtimeModule: runtimeModules(async (wasm) => WebAssembly.compile(new Uint8Array(await bytesOf(wasm)))),
    compile: (bytes) => WebAssembly.compile(new Uint8Array(bytes)),
    block: (words, index, value, ms) => {
      Atomics.wait(words, index, value, ms);
    },
    budgetMs: BUDGET_MS,
  });
  const enginePath = (engine: Pick<EngineManifest, "name">): string =>
    join(scratch, "engines", encodeComponent(engine.name));
  const dataPath = (engine: Pick<EngineManifest, "name">): string => join(enginePath(engine), "data");
  const launchAsAPage = launchingAsAPage(launch, locks);
  return {
    ...clock,
    data,
    sides,
    launch: launchAsAPage,
    start: startFrom(launchAsAPage),
    locks,
    storage: (engine) => {
      const hostPath = enginePath(engine);
      mkdirSync(hostPath, { recursive: true });
      return { kind: "node", hostPath };
    },
    // A version's directory, its marker, or both.
    versions: async (engine) => [
      ...new Set(
        (await readdir(dataPath(engine)).catch(() => [] as string[])).map((name) =>
          name.replace(/\.(installed|marking)$/, ""),
        ),
      ),
    ],
    tearMarker: (engine) => writeFile(join(dataPath(engine), `${encodeComponent(engine.version)}.installed`), '{"vers'),
    dataEntries: async (engine) => (await readdir(dataPath(engine))).sort(),
    strayMarking: async (engine, version) => {
      mkdirSync(dataPath(engine), { recursive: true });
      await writeFile(join(dataPath(engine), `${version}.marking`), JSON.stringify({ version, files: 0, bytes: 0 }));
    },
    storageMount: "node",
    cleanUp: async () => {
      rmSync(join(scratch, "engines"), { recursive: true, force: true });
    },
    withoutIndexedDB: {},
    // The hosts' threads write synchronously into the file drain() reads,
    // so what they printed is there already.
    printed: printedFrom(drain, drain, clock),
    record: (name, measurements) => console.log(`${name}: ${JSON.stringify(measurements)}`),
    pendingLimitMs: 10_000,
  };
};
```

- [ ] **Step 5: Run the checks and compare counts**

```bash
nix develop -c hk check --all
for check in worker-host-node worker-host-browser; do
  nix build ".#checks.x86_64-linux.$check" -L 2>&1 | grep -E "Test Files|Tests " > "${TMPDIR:-/tmp}/$check.after"
  diff "${TMPDIR:-/tmp}/$check.before" "${TMPDIR:-/tmp}/$check.after" && echo "$check: same counts"
done
nix build .#checks.x86_64-linux.hangul-host -L
```

Expected: hk passes, both lines say `same counts`, and `hangul-host` builds.

- [ ] **Step 6: Run the gate and commit**

```bash
nix develop -c git add packages/worker-host/test
nix develop -c git commit -m "test(worker-host): launch hosts through one shared launcher" -- packages/worker-host/test
```

### Task D7: Each package exports what its consumers import

Barrel files list their exports. Worker-host stops re-exporting protocol's transport and `EngineManifest`, so core and
worker-host import those from protocol. Exports nothing imports from another file stop being exported.

Two `export *`s stay, on purpose: `packages/ibus-web/src/effect.ts` (`export * from "@ibus-web/core"` and
`"@ibus-web/protocol"`) and `packages/ibus-web/src/panel.ts` (`export * from "@ibus-web/panel"`). Those subpaths are
defined as "everything that package exports", so listing names would only let them drift.

`LogLevel` in `packages/ibus-web/src/index.ts` stays exported: it is the type of `IbusWebOptions.logLevel` and
`LogEntry.level`, part of the facade's public API.

**Files:**

- Modify: `packages/protocol/src/transport/index.ts`, `packages/protocol/src/ibus/annotations.ts`,
  `packages/worker-host/src/shared/{index,control,messages}.ts`,
  `packages/worker-host/src/worker/{output,loop,host,forward,runtime}.ts`,
  `packages/worker-host/src/worker/install/{provide,archive,store,wait}.ts`,
  `packages/worker-host/src/worker/storage/plan.ts`, `packages/worker-host/test/shared/{page,client,install,storage}.ts`,
  `packages/worker-host/test/worker/instruments.ts`, `packages/worker-host/test/browser/{layers,scenarios}.test.ts`,
  `packages/worker-host/test/node/{scenarios,install-lifetime,storage-plan,archive}.test.ts`,
  `packages/core/src/page/index.ts`, `packages/core/src/shared/index.ts`,
  `packages/core/src/connection/connection.ts`, `packages/core/src/services/{config,engines}.ts`,
  `packages/core/test/node/support/fake-worker.ts`, `packages/core/test/node/connection/connection.test.ts`,
  `packages/core/src/router/{router,keystroke,replay,surrounding}.ts`, `packages/core/src/services/engines.ts`

**Interfaces:**

- Removed from `@ibus-web/worker-host`: `transportLayout`, `transportViews`, `ReqMode`, `State`, `Word`, `HEADER_BYTES`,
  `DEFAULT_SLOT_BYTES`, `DEFAULT_RING_BYTES`, `TransportLayout`, `EngineManifest`, `EngineData`, `engineDataBytes`.
  Import the first nine from `@ibus-web/protocol` (or `@ibus-web/protocol/transport` inside worker-host) and
  `EngineManifest` from `@ibus-web/protocol`.
- Removed from `@ibus-web/core`: `HotkeyRegistry`, `RouterOutput`, `PreeditAttribute`, `EngineRegistryOptions`. Each is
  still declared in its module, so declarations that use them still emit.
- Removed from protocol: `Int64`, `Uint64` (declared, never used).

- [ ] **Step 1: Find any remaining importer of the names being removed**

```bash
rg -n -U 'import (type )?\{[^}]*\b(transportLayout|transportViews|ReqMode|State|Word|HEADER_BYTES|DEFAULT_SLOT_BYTES|DEFAULT_RING_BYTES|TransportLayout|EngineManifest|EngineData|engineDataBytes)\b[^}]*\} from "(@ibus-web/worker-host|[./]*(src/)?shared/(control|messages|index)\.ts)"' packages tools examples runtime modules
rg -nw "HotkeyRegistry|RouterOutput|PreeditAttribute|EngineRegistryOptions|Int64|Uint64" packages tools examples docs --glob '!docs/plans/**'
```

Expected from the first: exactly the files edited in Steps 4–6 below. Expected from the second: only each name's own
declaration and uses in its own file. If either lists anything else, add that file to the step that covers its package
before going on.

- [ ] **Step 2: Protocol's transport barrel lists its exports**

Replace the contents of `packages/protocol/src/transport/index.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
export {
  DEFAULT_RING_BYTES,
  DEFAULT_SLOT_BYTES,
  HEADER_BYTES,
  MAX_RING_BYTES,
  MIN_FRAGMENT_PAYLOAD_BYTES,
  MIN_RING_BYTES,
  RECORD_HEADER_BYTES,
  ReqMode,
  State,
  transportLayout,
  transportViews,
  Word,
  wordDescriptions,
  type TransportLayout,
  type TransportViews,
} from "./layout.ts";
export { RingReader, RingWriter, type WriteResult } from "./ring.ts";
```

`alignedSize`, which Task D3 exported from `ring.ts` for the tests, stays out of the barrel.

In `packages/protocol/src/ibus/annotations.ts`, delete the unused

```ts
export const Int64 = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: -(2n ** 63n), maximum: 2n ** 63n - 1n }),
).pipe(gvariant("x"));
export const Uint64 = Schema.BigInt.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: 2n ** 64n - 1n })).pipe(
  gvariant("t"),
);
```

- [ ] **Step 3: Worker-host's shared barrel lists its exports**

In `packages/worker-host/src/shared/control.ts`, delete the re-export block:

```ts
export {
  transportLayout,
  transportViews,
  ReqMode,
  State,
  Word,
  HEADER_BYTES,
  DEFAULT_SLOT_BYTES,
  DEFAULT_RING_BYTES,
  type TransportLayout,
} from "@ibus-web/protocol/transport";
```

The `import { … } from "@ibus-web/protocol/transport";` above it stays: the file uses those names itself.

In `packages/worker-host/src/shared/messages.ts`, replace

```ts
import type { EngineManifest } from "@ibus-web/protocol";
export type { EngineManifest } from "@ibus-web/protocol";
export type EngineData = EngineManifest["data"][number];
```

with

```ts
import type { EngineManifest } from "@ibus-web/protocol";
```

and change `export const engineDataBytes =` to `const engineDataBytes =`.

Replace the contents of `packages/worker-host/src/shared/index.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

export {
  controlViews,
  createControl,
  postCrash,
  postReply,
  postRequest,
  takeReply,
  type ControlViews,
  type Reply,
} from "./control.ts";
export {
  memoryWithData,
  WASM_PAGE,
  type CollectReport,
  type EngineStorage,
  type HostInit,
  type HostMessage,
  type InstallReport,
  type Mount,
  type RuntimeConstants,
  type RuntimeMemory,
  type SideModule,
  type StorageState,
} from "./messages.ts";
export {
  encodeComponent,
  engineDatabase,
  engineDataDatabase,
  engineDataDatabasePrefix,
  engineDataDir,
  engineDataLock,
  engineDataRoot,
  engineDir,
  engineInstallLock,
  engineWriterLock,
  type EngineIdentity,
} from "./naming.ts";
export type { HostConfigValues } from "./config.ts";
```

- [ ] **Step 4: Worker-host imports transport and `EngineManifest` from protocol**

Make these replacements in `packages/worker-host/`. Each "replace" block is the exact text in the file.

`src/worker/output.ts`: replace

```ts
import { State, Word, type ControlViews } from "../shared/control.ts";
import type { RingWriter } from "@ibus-web/protocol/transport";
```

with

```ts
import type { ControlViews } from "../shared/control.ts";
import { State, Word, type RingWriter } from "@ibus-web/protocol/transport";
```

`src/worker/loop.ts`: replace

```ts
import { postReply, ReqMode, State, Word, type ControlViews } from "../shared/control.ts";
import { RingWriter } from "@ibus-web/protocol/transport";
```

with

```ts
import { postReply, type ControlViews } from "../shared/control.ts";
import { ReqMode, RingWriter, State, Word } from "@ibus-web/protocol/transport";
```

`src/worker/host.ts`: replace

```ts
import { RingWriter, transportLayout } from "@ibus-web/protocol/transport";
import { controlViews, postCrash, Word, type ControlViews } from "../shared/control.ts";
```

with

```ts
import { RingWriter, transportLayout, Word } from "@ibus-web/protocol/transport";
import { controlViews, postCrash, type ControlViews } from "../shared/control.ts";
```

`src/worker/install/provide.ts`: replace

```ts
import type { CollectReport, EngineManifest, HostMessage, InstallReport } from "../../shared/messages.ts";
```

with

```ts
import type { EngineManifest } from "@ibus-web/protocol";
import type { CollectReport, HostMessage, InstallReport } from "../../shared/messages.ts";
```

`src/worker/storage/plan.ts`: replace

```ts
import { memoryWithData, type EngineManifest, type EngineStorage, type RuntimeMemory } from "../../shared/messages.ts";
```

with

```ts
import type { EngineManifest } from "@ibus-web/protocol";
import { memoryWithData, type EngineStorage, type RuntimeMemory } from "../../shared/messages.ts";
```

`src/worker/install/archive.ts`: replace

```ts
import { errorMessage } from "@ibus-web/protocol";
```

and delete

```ts
import type { EngineManifest } from "../../shared/messages.ts";
```

so that the protocol import reads

```ts
import { errorMessage, type EngineManifest } from "@ibus-web/protocol";
```

`src/worker/install/store.ts`: replace

```ts
import type { EngineManifest } from "../../shared/messages.ts";
```

with

```ts
import type { EngineManifest } from "@ibus-web/protocol";
```

`test/shared/page.ts`: replace

```ts
import { controlViews, postRequest, takeReply, ReqMode, State, Word, type Reply } from "../../src/shared/control.ts";
```

with

```ts
import { ReqMode, State, Word } from "@ibus-web/protocol/transport";
import { controlViews, postRequest, takeReply, type Reply } from "../../src/shared/control.ts";
```

`test/shared/client.ts`: replace

```ts
import { transportLayout, type TransportLayout } from "@ibus-web/protocol/transport";
import { ReqMode, State, Word, type Reply as ProtocolReply } from "../../src/shared/control.ts";
```

with

```ts
import { ReqMode, State, transportLayout, Word, type TransportLayout } from "@ibus-web/protocol/transport";
import type { Reply as ProtocolReply } from "../../src/shared/control.ts";
```

`test/worker/instruments.ts`: replace

```ts
import { Word } from "../../src/shared/control.ts";
```

with

```ts
import { Word } from "@ibus-web/protocol/transport";
```

`test/browser/layers.test.ts`: replace

```ts
import { createControl, State, Word } from "../../src/shared/control.ts";
```

with

```ts
import { State, Word } from "@ibus-web/protocol/transport";
import { createControl } from "../../src/shared/control.ts";
```

`test/shared/install.ts`: replace

```ts
import type { CollectReport, EngineManifest, InstallReport } from "../../src/shared/messages.ts";
```

with

```ts
import type { EngineManifest } from "@ibus-web/protocol";
import type { CollectReport, InstallReport } from "../../src/shared/messages.ts";
```

`test/shared/storage.ts`: replace

```ts
import { memoryWithData, type EngineManifest, type StorageState } from "../../src/shared/messages.ts";
```

with

```ts
import type { EngineManifest } from "@ibus-web/protocol";
import { memoryWithData, type StorageState } from "../../src/shared/messages.ts";
```

`test/browser/scenarios.test.ts`, `test/node/scenarios.test.ts`, `test/node/install-lifetime.test.ts`, `test/node/storage-plan.test.ts`, `test/node/archive.test.ts`: replace

```ts
import type { EngineManifest } from "../../src/shared/messages.ts";
```

with

```ts
import type { EngineManifest } from "@ibus-web/protocol";
```

The two harnesses already import `EngineManifest` from protocol since Task D6.

- [ ] **Step 5: Core imports transport from protocol**

`packages/core/src/connection/connection.ts`: delete `ReqMode,`, `State,`, `Word,`, `transportLayout,` and
`type TransportLayout,` from the `@ibus-web/worker-host` import, and add them to the `@ibus-web/protocol` import, which
then reads

```ts
import {
  decodeRecordLazy,
  encodeRequest,
  ProtocolError,
  ReqMode,
  requestKinds,
  RingReader,
  State,
  transportLayout,
  Word,
  type DecodedLazyRecord,
  type Request,
  type TransportLayout,
} from "@ibus-web/protocol";
```

`packages/core/src/services/config.ts`: change `import { transportLayout } from "@ibus-web/worker-host";` to
`import { transportLayout } from "@ibus-web/protocol";`.

`packages/core/src/services/engines.ts`: change

```ts
import { asError, EngineManifest, Init, SettingChanged, PROTOCOL_VERSION, type Request } from "@ibus-web/protocol";
import { transportLayout, type StorageState } from "@ibus-web/worker-host";
```

to

```ts
import {
  asError,
  EngineManifest,
  Init,
  SettingChanged,
  PROTOCOL_VERSION,
  transportLayout,
  type Request,
} from "@ibus-web/protocol";
import type { StorageState } from "@ibus-web/worker-host";
```

`packages/core/test/node/support/fake-worker.ts`: delete `ReqMode,`, `State,`, `Word,` and `transportLayout,` from the
`@ibus-web/worker-host` import, and change `import { encodeValue, RingWriter, recordKinds } from "@ibus-web/protocol";`
to

```ts
import { encodeValue, recordKinds, ReqMode, RingWriter, State, transportLayout, Word } from "@ibus-web/protocol";
```

`packages/core/test/node/connection/connection.test.ts`: change
`import { ReqMode, State, Word, postReply } from "@ibus-web/worker-host";` to
`import { postReply } from "@ibus-web/worker-host";`, and add `ReqMode,`, `State,` and `Word,` to the
`@ibus-web/protocol` import list.

- [ ] **Step 6: Core's barrels list their exports**

Replace the contents of `packages/core/src/shared/index.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
export {
  codepointForKeysym,
  evdevForCode,
  keysymByName,
  keysymForCodepoint,
  translateKey,
  validateKeyboard,
  type KeyLike,
} from "../keys/index.ts";
```

Replace the contents of `packages/core/src/page/index.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
export {
  Connection,
  ConnectionBusyError,
  type ConnectionOptions,
  type CrashInfo,
  type Reply,
  type SyncOutcome,
} from "../connection/connection.ts";
export {
  codepointForKeysym,
  evdevForCode,
  keysymByName,
  keysymForCodepoint,
  translateKey,
  validateKeyboard,
  type KeyLike,
} from "../keys/index.ts";
export {
  ReplayQueue,
  type AsyncKeyResult,
  type KeyResult,
  type KeySink,
  type Preedit,
  type SurfaceAdapter,
} from "../router/replay.ts";
export {
  KeyRouter,
  type EngineSnapshot,
  type EngineState,
  type KeyConnection,
  type KeyContext,
} from "../router/keystroke.ts";
export { CoreConfig, type CoreConfigValues } from "../services/config.ts";
export {
  EngineRegistry,
  makeEngineRegistry,
  type EngineEvent,
  type EngineRegistryService,
} from "../services/engines.ts";
export {
  SettingsSource,
  type SettingsChange,
  type SettingsSnapshot,
  type SettingsSourceService,
} from "../services/settings.ts";
export { Logger, PanelEvents, glibLevel, type LogLine } from "../services/logging.ts";
export { Router, makeRouter, type AttachOptions, type RouterService } from "../router/router.ts";
export { textareaAdapter } from "../adapters/textarea.ts";
export {
  SettingsApi,
  type SettingsApiService,
  type SettingsOptions,
  type SettingsSchema,
  type SettingsKey,
  type SettingValue,
} from "../settings/api.ts";
export { indexedDbSettings } from "../settings/persister.ts";
```

This is every name the `export *`s exported, minus `HotkeyRegistry`, `RouterOutput`, `PreeditAttribute` and
`EngineRegistryOptions`, and minus `PanelEvent` and `PanelRecord`, which Task D4 moved to protocol.

- [ ] **Step 7: Stop exporting what only its own file uses**

Remove the `export` keyword from each of these declarations, leaving the declaration itself:

| File | Declaration |
| --- | --- |
| `packages/core/src/router/router.ts` | `export interface HotkeyRegistry` |
| `packages/core/src/router/keystroke.ts` | `export interface RouterOutput` |
| `packages/core/src/router/replay.ts` | `export interface PreeditAttribute` |
| `packages/core/src/services/engines.ts` | `export interface EngineRegistryOptions` |
| `packages/core/src/router/surrounding.ts` | `export const toCodePoints` |
| `packages/worker-host/src/worker/forward.ts` | `export interface RelayWord` |
| `packages/worker-host/src/worker/install/provide.ts` | `export interface ProvideData`, `export interface DataMount` |
| `packages/worker-host/src/worker/install/store.ts` | `export interface Marker` |
| `packages/worker-host/src/worker/install/wait.ts` | `export interface Granted`, `export type WaitLimits` |
| `packages/worker-host/src/worker/loop.ts` | `export type Excursion` |
| `packages/worker-host/src/worker/output.ts` | `export interface OutputWaitContext` |
| `packages/worker-host/src/worker/runtime.ts` | `export interface EmscriptenPool` |

TypeScript emits a declaration that an exported signature uses even when the declaration isn't exported, so
`serveUntilExcursion`'s and `drainOutput`'s declarations still build.

- [ ] **Step 8: Confirm nothing still re-exports protocol from worker-host, and no `export *` is left but ibus-web's**

```bash
rg -n "export \*" packages --glob '!**/dist/**'
rg -n 'from "@ibus-web/protocol(/transport)?";' packages/worker-host/src/shared/control.ts packages/worker-host/src/shared/messages.ts
```

Expected: the first lists only `packages/ibus-web/src/effect.ts` (two lines) and `packages/ibus-web/src/panel.ts`. The
second lists only `import` lines, no `export … from`.

- [ ] **Step 9: Run the affected checks**

```bash
nix develop -c hk check --all
nix build .#checks.x86_64-linux.protocol .#checks.x86_64-linux.core .#checks.x86_64-linux.core-browser .#checks.x86_64-linux.panel .#checks.x86_64-linux.ibus-web .#checks.x86_64-linux.worker-host-node .#checks.x86_64-linux.worker-host-browser .#checks.x86_64-linux.bundle-scan .#checks.x86_64-linux.hangul-host -L
```

Expected: all pass. `ibus-web`'s `effect consumers retain core services, tagged errors, adapters and protocol schemas`
test checks that the `ibus-web/effect` subpath still carries core's services and protocol's schemas.

- [ ] **Step 10: Run the gate and commit**

```bash
nix develop -c git add packages/protocol/src packages/worker-host packages/core
nix develop -c git commit -m "refactor: list each barrel's exports and import transport from protocol" -- packages/protocol/src packages/worker-host packages/core
```

### Task D8: Split `host.ts` along its scopes

`packages/worker-host/src/worker/host.ts` holds six things: crash and log formatting, five layers, the request loop and
their composition. Each moves to its own file; `host.ts` keeps the composition. The code moves verbatim apart from
`export` keywords, imports, and one comment reflowed where an earlier edit broke its lines.

The log formatter (`hostLogger`) goes with the Worker layer rather than into `failure.ts`, because it writes through
`output.ts`, which already imports `failure.ts`.

**Files:**

- Create: `packages/worker-host/src/worker/layers/{worker,storage-plan,runtime,relay,storage}.ts`,
  `packages/worker-host/src/worker/serve.ts`
- Modify: `packages/worker-host/src/worker/host.ts`, `packages/worker-host/src/worker/failure.ts`,
  `packages/worker-host/src/worker/index.ts`, `packages/worker-host/test/worker/host.ts`,
  `packages/worker-host/test/browser/layers.test.ts`

**Interfaces:**

- Produces:
  - `src/worker/failure.ts`: `within`, `CrashRecord`, `stoppedRecord`, `crashRecord`, `crashMessage`,
    `startupMessage` (moved from `host.ts`), beside what it already exports
  - `src/worker/layers/worker.ts`: `UncaughtError`, `WorkerEnv`, `HostWorkerShape`, `HostWorker`, `workerLayer`
  - `src/worker/layers/storage-plan.ts`: `PlannedStorage`, `storagePlanLayer`
  - `src/worker/layers/runtime.ts`: `HostRuntime`, `runtimeLayer`
  - `src/worker/layers/relay.ts`: `Relay`, `relayLayer`
  - `src/worker/layers/storage.ts`: `Storage`, `storageLayer`
  - `src/worker/serve.ts`: `serve`
  - `src/worker/host.ts`: `hostLayer`, `program`
- Removed exports: `PlannedStorageShape`, `HostRuntimeShape`, `RelayShape` (used only in their own file).

- [ ] **Step 1: Move the crash formatting into `failure.ts`**

In `packages/worker-host/src/worker/failure.ts`, replace

```ts
import { Cause, Data, Effect, Exit, type Scope } from "effect";
```

with

```ts
import { CrashReason } from "@ibus-web/protocol";
import { Cause, Data, Effect, Exit, type Scope } from "effect";
```

and append to the end of the file:

```ts
// What Emscripten throws to unwind the runtime's thread once another thread
// has crashed. That thread's own error reaches this one's event loop only
// afterwards, as an uncaught error.
const UNWIND = "unwind";

// The promise's value, or fallback if it takes longer than ms.
export const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

// What the Crashed record says: what is known at once, which a crashed
// thread's own error isn't; the crash report carries that.
export interface CrashRecord {
  readonly reason: number;
  readonly message: string;
}

// Cleanup failures are defects because Effect finalizers cannot fail through
// the typed channel. Their RuntimeStopped value still controls later scopes.
const crashFailure = (cause: Cause.Cause<unknown>): RuntimeStopped | RelayFailed | undefined => {
  for (const reason of cause.reasons) {
    let error: unknown;
    if (Cause.isFailReason(reason)) error = reason.error;
    else if (Cause.isDieReason(reason)) error = reason.defect;
    else continue;
    if (error instanceof RuntimeStopped || error instanceof RelayFailed) return error;
  }
  return undefined;
};

export const stoppedRecord = (failure: RuntimeStopped): CrashRecord => ({
  reason: failure.reason ?? CrashReason.trap,
  message: failure.error === UNWIND ? "a thread crashed" : describe(failure.error),
});

export const crashRecord = (cause: Cause.Cause<unknown>): CrashRecord => {
  const failure = crashFailure(cause);
  if (failure instanceof RelayFailed) return { reason: CrashReason.relay, message: `relay: ${failure.message}` };
  if (failure instanceof RuntimeStopped) return stoppedRecord(failure);
  return { reason: CrashReason.host, message: Cause.pretty(cause) };
};

export const crashMessage = (
  cause: Cause.Cause<unknown>,
  threadError: Promise<string>,
  waitMs: number,
): Promise<string> => {
  const failure = crashFailure(cause);
  if (failure instanceof RelayFailed) return Promise.resolve(`relay: ${failure.message}`);
  if (failure instanceof RuntimeStopped) {
    if (failure.error !== UNWIND) return Promise.resolve(describe(failure.error));
    return within(threadError, waitMs, "its error never arrived").then((why) => `a thread crashed: ${why}`);
  }
  return Promise.resolve(Cause.pretty(cause));
};

export const startupMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.findErrorOption(cause);
  return error._tag === "Some" && error.value instanceof StartupFailed ? error.value.message : Cause.pretty(cause);
};
```

- [ ] **Step 2: Create the Worker layer**

Create `packages/worker-host/src/worker/layers/worker.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The Worker scope: the control buffer, the host's channel to the page, its
// logger, and how it reports a failed start or a crash.

import { encodeValue } from "@ibus-web/protocol";
import { RingWriter, transportLayout, Word } from "@ibus-web/protocol/transport";
import { Cause, Context, Effect, Exit, Layer, Logger } from "effect";
import { controlViews, postCrash, type ControlViews } from "../../shared/control.ts";
import type { HostInit, HostMessage } from "../../shared/messages.ts";
import { HostConfig } from "../config.ts";
import { crashMessage, crashRecord, describe, startupMessage, type CrashRecord } from "../failure.ts";
import { writeHostRecord } from "../output.ts";

// What a Worker's error event carries, as far as the host reads it.
export interface UncaughtError {
  error?: unknown;
  message?: string;
  preventDefault(): void;
}

// What the host needs of the Worker it runs in.
export interface WorkerEnv {
  post(message: HostMessage): void;
  // Calls listener with each uncaught error this thread's event loop
  // delivers.
  onUncaughtError(listener: (event: UncaughtError) => void): void;
  // The relay's script.
  relayUrl: URL;
}

// The Worker scope: the control buffer, and the host's channel to the page.
export interface HostWorkerShape {
  readonly init: HostInit<WebAssembly.Module, unknown>;
  readonly control: ControlViews;
  readonly writer: RingWriter;
  readonly env: WorkerEnv;
  // Posts "ready"; from here on, a failure is a crash, not a failed start.
  readonly ready: () => void;
  // Writes the Crashed record, if the ring has room, then CRASHED, so the
  // page stops waiting and a drain once it sees CRASHED finds the record;
  // then starts keeping the next uncaught error as the cause. Only the first
  // call does anything.
  readonly crashed: (record: CrashRecord) => void;
}

export class HostWorker extends Context.Service<HostWorker, HostWorkerShape>()("@ibus-web/worker-host/HostWorker") {}

const hostLogger = (writer: RingWriter, control: ControlViews, notify: () => void): Logger.Logger<unknown, void> =>
  Logger.make(({ logLevel, message, cause }) => {
    const parts = Array.isArray(message) ? message : [message];
    const text = parts.map((part) => (typeof part === "string" ? part : describe(part))).join(" ");
    const levels = { All: 128, Fatal: 4, Error: 8, Warn: 16, Info: 64, Debug: 128, Trace: 128, None: 0 };
    const payload = encodeValue("(uss)", {
      _tag: "()",
      items: [
        { _tag: "u", value: levels[logLevel] },
        { _tag: "s", value: "worker-host" },
        { _tag: "s", value: cause.reasons.length === 0 ? text : `${text}\n${Cause.pretty(cause)}` },
      ],
    });
    if (writeHostRecord(writer, control, 33, payload)) notify();
  });

// Acquires the control buffer's views and, released with a failure, reports
// it: before "ready" as a failed start, after it as a crash, CRASHED written
// first.
export const workerLayer = (
  init: HostInit<WebAssembly.Module, unknown>,
  env: WorkerEnv,
): Layer.Layer<HostWorker, never, HostConfig> => {
  const layout = init.layout ?? transportLayout();
  const control = controlViews(init.control, layout);
  const writer = new RingWriter(control, layout);
  const notify = (): void => {
    if (Atomics.exchange(control.words, Word.doorbell, 1) === 0) env.post({ type: "doorbell" });
  };
  return Layer.effect(
    HostWorker,
    Effect.gen(function* () {
      const config = yield* HostConfig;
      const startedAt = performance.now();
      let isReady = false;
      let isCrashed = false;
      let keepError: (why: string) => void = () => {};
      const threadError = new Promise<string>((resolve) => {
        keepError = resolve;
      });
      // Registered now rather than once the host stops: the thread's error
      // may already be queued by then.
      env.onUncaughtError((event) => {
        if (!isCrashed) return;
        event.preventDefault();
        keepError(describe(event.error ?? event.message));
      });
      const crashed = ({ reason, message }: CrashRecord): void => {
        if (isCrashed) return;
        isCrashed = true;
        writeHostRecord(
          writer,
          control,
          34,
          encodeValue("(us)", {
            _tag: "()",
            items: [
              { _tag: "u", value: reason },
              { _tag: "s", value: message },
            ],
          }),
        );
        postCrash(control);
      };
      yield* Effect.addFinalizer((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : isReady
            ? Effect.promise(async () => {
                crashed(crashRecord(exit.cause));
                const message = await crashMessage(exit.cause, threadError, config.crashWaitMs);
                env.post({ type: "crashed", message });
              })
            : Effect.sync(() => env.post({ type: "error", message: startupMessage(exit.cause) })),
      );
      return {
        init,
        control,
        writer,
        env,
        ready: () => {
          isReady = true;
          env.post({ type: "ready", startupMs: performance.now() - startedAt });
        },
        crashed,
      };
    }),
  ).pipe(Layer.provideMerge(Logger.layer([hostLogger(writer, control, notify)])));
};
```

- [ ] **Step 3: Create the storage-plan layer**

Create `packages/worker-host/src/worker/layers/storage-plan.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { EngineManifest } from "@ibus-web/protocol";
import { Context, Effect, Layer } from "effect";
import type { RuntimeMemory } from "../../shared/messages.ts";
import { StartupFailed, startupFailed } from "../failure.ts";
import { Instruments } from "../instruments.ts";
import { fetchBytes, readManifest, readRuntimeConstants, type RuntimeDistributionConstants } from "../startup.ts";
import { Held } from "../storage/held.ts";
import { memoryFor, planStorage, type StoragePlan } from "../storage/plan.ts";
import { HostWorker } from "./worker.ts";

// The storage's plan: what to mount at the engine's directory, decided
// before the runtime's memory is made, since a mount in memory needs a
// larger one, and the locks, among them the engine's writer lock, which the
// host takes before it creates its user backend. Released, it lets go of
// every lock, but of the writer lock only once the user backend is sealed.
interface PlannedStorageShape {
  readonly constants: RuntimeDistributionConstants;
  readonly plan: StoragePlan;
  readonly held: Held;
  // The runtime's memory, in bytes.
  readonly memory: RuntimeMemory;
  readonly manifest: EngineManifest;
  readonly module: ArrayBuffer;
}

export class PlannedStorage extends Context.Service<PlannedStorage, PlannedStorageShape>()(
  "@ibus-web/worker-host/PlannedStorage",
) {}

export const storagePlanLayer: Layer.Layer<PlannedStorage, StartupFailed, HostWorker> = Layer.effect(
  PlannedStorage,
  Effect.gen(function* () {
    const { init } = yield* HostWorker;
    const instruments = yield* Instruments;
    const constants = yield* Effect.tryPromise({
      try: () => readRuntimeConstants(init.runtimeUrl),
      catch: startupFailed,
    });
    const manifest = yield* Effect.tryPromise({
      try: () => readManifest(init, constants),
      catch: (error) => (error instanceof StartupFailed ? error : startupFailed(error)),
    });
    const held = new Held();
    yield* Effect.addFinalizer(() => Effect.sync(() => held.releaseAll()));
    instruments.beforeProbe();
    const plan = yield* Effect.tryPromise({
      try: () => planStorage(init.storage, manifest, constants.idbReadOnly, held),
      catch: startupFailed,
    });
    const module = yield* Effect.tryPromise({ try: () => fetchBytes(manifest.module.url), catch: startupFailed });
    if (module.length !== manifest.module.size)
      return yield* new StartupFailed({ message: `module size ${module.length}, expected ${manifest.module.size}` });
    return {
      constants,
      plan,
      held,
      manifest,
      module: module.buffer as ArrayBuffer,
      memory: memoryFor({ initial: manifest.memory, maximum: manifest.memory }, plan, manifest),
    };
  }),
);
```

- [ ] **Step 4: Create the runtime layer**

Create `packages/worker-host/src/worker/layers/runtime.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Context, Effect, Layer } from "effect";
import { WASM_PAGE } from "../../shared/messages.ts";
import { runtimeCallFailed, startupFailed, type StartupFailed } from "../failure.ts";
import { Instruments } from "../instruments.ts";
import type { LoopContext } from "../loop.ts";
import {
  alloc,
  check,
  checkMemory,
  requireRuntime,
  type CreateRuntime,
  type Runtime,
  type RuntimeHandle,
} from "../runtime.ts";
import { PlannedStorage } from "./storage-plan.ts";
import { HostWorker } from "./worker.ts";

// The runtime scope: the runtime, started in a memory the host makes at the
// engine's size, and set up to pump on this thread. Nothing to release: the
// runtime ends with the Worker.
interface HostRuntimeShape {
  readonly handle: RuntimeHandle;
  readonly wakeIndex: number;
  // Where requests and replies sit in the runtime's memory, each the
  // control slot's size.
  readonly buffers: LoopContext["buffers"];
}

export class HostRuntime extends Context.Service<HostRuntime, HostRuntimeShape>()(
  "@ibus-web/worker-host/HostRuntime",
) {}

export const runtimeLayer: Layer.Layer<HostRuntime, StartupFailed, HostWorker | PlannedStorage> = Layer.effect(
  HostRuntime,
  Effect.gen(function* () {
    const { init, control } = yield* HostWorker;
    const { memory: bytes, manifest, constants } = yield* PlannedStorage;
    const instruments = yield* Instruments;
    yield* Effect.try({ try: () => checkMemory(bytes, constants.memory), catch: startupFailed });
    const memory = new WebAssembly.Memory({
      initial: bytes.initial / WASM_PAGE,
      maximum: bytes.maximum / WASM_PAGE,
      shared: true,
    });
    instruments.beforeRuntime();
    const { default: createRuntime } = yield* Effect.tryPromise({
      try: () => import(/* @vite-ignore */ init.runtimeUrl) as Promise<{ default: CreateRuntime }>,
      catch: startupFailed,
    });
    const { wasm } = init;
    const rt: Runtime = yield* Effect.tryPromise({
      try: () => {
        // Emscripten has no way to hear that instantiateWasm failed, so a
        // failure ends the wait for the runtime here instead.
        let failInstantiate: (error: unknown) => void = () => {};
        const instantiateFailed = new Promise<never>((_, reject) => {
          failInstantiate = reject;
        });
        return Promise.race([
          createRuntime({
            wasmMemory: memory,
            ibuswebEngineThreads: manifest.threads,
            ...(wasm === undefined
              ? {}
              : {
                  instantiateWasm: (imports, done) => {
                    WebAssembly.instantiate(wasm, imports).then((instance) => done(instance, wasm), failInstantiate);
                    return {};
                  },
                }),
          }),
          instantiateFailed,
        ]);
      },
      catch: startupFailed,
    });
    return yield* Effect.try({
      try: () => {
        requireRuntime(rt);
        const handle: RuntimeHandle = {
          rt,
          memory,
          bytes: rt.HEAPU8,
          words: new Int32Array(rt.HEAPU8.buffer),
        };
        instruments.runtimeStarted(handle);
        const wake = alloc(handle, 4);
        Atomics.store(handle.words, wake / 4, 0);
        check("ibusweb_runtime_init", rt._ibusweb_runtime_init(wake));
        const cap = control.slot.length;
        return {
          handle,
          wakeIndex: wake / 4,
          buffers: { request: alloc(handle, cap), reply: alloc(handle, cap), cap },
        };
      },
      catch: runtimeCallFailed,
    });
  }),
);
```

- [ ] **Step 5: Create the relay layer**

Create `packages/worker-host/src/worker/layers/relay.ts`. `SpawnWorker` moves here with its only user; this module is
imported statically, so it is still captured before the runtime's dynamic import replaces the global:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Word } from "@ibus-web/protocol/transport";
import { Context, Effect, Layer } from "effect";
import { postCrash } from "../../shared/control.ts";
import { startupFailed, type StartupFailed } from "../failure.ts";
import type { RelayInit } from "../forward.ts";
import { HostRuntime } from "./runtime.ts";
import { HostWorker } from "./worker.ts";

// Captured before the runtime is imported: under Node, Emscripten replaces
// the global with worker_threads' own Worker class.
const SpawnWorker: typeof Worker = globalThis.Worker;

// The wake relay: the page bumps the control buffer's wake word, which the
// host, asleep in the runtime, doesn't sleep on. It bumps a word in the
// runtime's memory, so it starts once the runtime has one, and it ends with
// the runtime's scope.
interface RelayShape {
  // Settles with the relay's error, which this thread hears only in its
  // event loop.
  readonly failed: Promise<string>;
}

export class Relay extends Context.Service<Relay, RelayShape>()("@ibus-web/worker-host/Relay") {}

const startRelay = (url: URL, init: RelayInit): Promise<Worker> =>
  new Promise((resolve, reject) => {
    const relay = new SpawnWorker(url, { type: "module", name: "ibus-web-relay" });
    relay.onmessage = () => resolve(relay);
    relay.onerror = (event) => reject(new Error(`relay: ${event.message}`));
    relay.postMessage(init);
  });

export const relayLayer: Layer.Layer<Relay, StartupFailed, HostWorker | HostRuntime> = Layer.effect(
  Relay,
  Effect.gen(function* () {
    const { init, env, control } = yield* HostWorker;
    const { handle, wakeIndex } = yield* HostRuntime;
    const relay = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          startRelay(env.relayUrl, {
            from: { buffer: init.control, index: Word.wake },
            to: { buffer: handle.memory.buffer as unknown as SharedArrayBuffer, index: wakeIndex },
            control: init.control,
            ...(init.layout === undefined ? {} : { layout: init.layout }),
          }),
        catch: startupFailed,
      }),
      (relay) => Effect.sync(() => relay.terminate()),
    );
    // The relay reports its own failure through the control buffer; one this
    // thread does hear of, in its event loop, is reported the same way.
    const failed = new Promise<string>((resolve) => {
      relay.onerror = (event) => {
        resolve(event.message);
        postCrash(control);
        Atomics.add(handle.words, wakeIndex, 1);
        Atomics.notify(handle.words, wakeIndex);
      };
    });
    return { failed };
  }),
);
```

- [ ] **Step 6: Create the storage layer**

Create `packages/worker-host/src/worker/layers/storage.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Context, Effect, Layer } from "effect";
import { engineDir, engineWriterLock } from "../../shared/naming.ts";
import { HostConfig } from "../config.ts";
import { describe, runtimeCallFailed, runtimeFinalizer, type StartupFailed } from "../failure.ts";
import { Instruments } from "../instruments.ts";
import { provideData } from "../install/provide.ts";
import { setSchemaDir } from "../schema-dir.ts";
import { mount, type MountedStorage } from "../storage/mount.ts";
import { HostRuntime } from "./runtime.ts";
import { PlannedStorage } from "./storage-plan.ts";
import { HostWorker } from "./worker.ts";

// The storage's mounts: the engine's own files at its directory, and its
// data, installed first if need be, at /nix/store. The backends' threads and
// connections end with the Worker, since WasmFS never destroys a backend;
// released while the runtime can still be called, it seals the read-write
// backends, which lets the writer lock go.
export class Storage extends Context.Service<Storage, MountedStorage>()("@ibus-web/worker-host/Storage") {}

export const storageLayer: Layer.Layer<Storage, StartupFailed, HostWorker | HostRuntime | PlannedStorage | HostConfig> =
  Layer.effect(
    Storage,
    Effect.gen(function* () {
      const { env } = yield* HostWorker;
      const { handle } = yield* HostRuntime;
      const { plan, held, manifest, constants } = yield* PlannedStorage;
      const config = yield* HostConfig;
      const instruments = yield* Instruments;
      const mounted = yield* Effect.tryPromise({
        try: () => mount(handle, plan, engineDir(manifest)),
        catch: runtimeCallFailed,
      });
      const { seal } = mounted;
      if (seal !== undefined) {
        held.sealWith(() => instruments.seal(seal));
        yield* runtimeFinalizer(
          Effect.suspend(() => {
            try {
              held.seal();
              return Effect.void;
            } catch (error) {
              return Effect.logError(
                `sealing the engine's user data failed, so this host keeps ${engineWriterLock(manifest)} until its Worker ends: ${describe(error)}`,
              );
            }
          }),
        );
      }
      if (plan.mount === "memory") env.post({ type: "storage", state: "ephemeral", message: plan.why });
      if ((plan.mount === "indexeddb" || plan.mount === "node") && plan.readOnly)
        env.post({
          type: "storage",
          state: "read-only",
          message: `another instance of engine ${manifest.name} holds ${engineWriterLock(manifest)}; this one's user data refuses changes${plan.mount === "node" ? " (in browsers; the Node backend has no read-only mode)" : ""}`,
        });
      const data = yield* provideData({
        handle,
        engine: manifest,
        plan,
        idbReadOnly: constants.idbReadOnly,
        held,
        config,
        instruments,
        post: env.post,
      });
      const storage: MountedStorage = { ...mounted, closed: () => mounted.closed() || data.closed() };
      yield* Effect.try({ try: () => setSchemaDir(handle, manifest), catch: runtimeCallFailed });
      yield* Effect.try({ try: () => instruments.storageMounted(storage), catch: runtimeCallFailed });
      return storage;
    }),
  );
```

- [ ] **Step 7: Create the request loop**

Create `packages/worker-host/src/worker/serve.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { CrashReason } from "@ibus-web/protocol";
import { Effect } from "effect";
import { HostConfig } from "./config.ts";
import { describe, RelayFailed, runtimeIntact, RuntimeStopped, stoppedRecord, within } from "./failure.ts";
import { Instruments, type InstrumentReply } from "./instruments.ts";
import { HostRuntime } from "./layers/runtime.ts";
import { Relay } from "./layers/relay.ts";
import { Storage } from "./layers/storage.ts";
import { PlannedStorage } from "./layers/storage-plan.ts";
import { HostWorker } from "./layers/worker.ts";
import { finishReply, pump, ringDoorbell, serveUntilExcursion, step, topUp, type LoopContext } from "./loop.ts";
import { drainOutput, HostDefect } from "./output.ts";
import { alloc, loadSides, RuntimeRefused } from "./runtime.ts";
import { EngineScopes } from "./scopes.ts";

// The most pumps the host runs to settle the engines it destroys on its way
// out.
const SHUTDOWN_PUMPS = 8;

// Serves requests for good, leaving the synchronous section only to top the
// pool up or for an instrument's reply. Fails once the runtime or the relay
// stops.
export const serve: Effect.Effect<
  void,
  RuntimeStopped | RelayFailed,
  HostWorker | HostRuntime | Relay | Storage | HostConfig | PlannedStorage
> = Effect.gen(function* () {
  const worker = yield* HostWorker;
  const { handle, wakeIndex, buffers } = yield* HostRuntime;
  const relay = yield* Relay;
  const storage = yield* Storage;
  const config = yield* HostConfig;
  const instruments = yield* Instruments;
  const { control } = worker;
  const { module, constants } = yield* PlannedStorage;
  // Runs a runtime call; one that throws marks the host crashed before
  // anything else can happen.
  const guarded = <T>(call: () => T): Effect.Effect<T, RuntimeStopped> =>
    Effect.try({
      try: call,
      catch: (error) => {
        const stopped =
          error instanceof RuntimeStopped
            ? error
            : new RuntimeStopped({ error, reason: error instanceof HostDefect ? CrashReason.host : CrashReason.trap });
        worker.crashed(stoppedRecord(stopped));
        return stopped;
      },
    });
  const scopes = new EngineScopes(buffers.request, constants.canceled);
  let moduleLoaded = false;
  // The page hears of it once.
  let closedReported = false;
  const watchStorage = (): void => {
    if (closedReported || !storage.closed()) return;
    closedReported = true;
    worker.env.post({
      type: "storage",
      state: "closed",
      message: "the IndexedDB connection closed; the engine's storage fails with EIO",
    });
  };
  const outputLength = yield* guarded(() => new Int32Array(handle.bytes.buffer, alloc(handle, 4), 1));
  const ctx: LoopContext = {
    watchStorage,
    handle,
    control,
    constants,
    wakeIndex,
    buffers,
    instruments,
    lowWater: constants.poolLowWater,
    writer: worker.writer,
    scopes,
    loadEngine: () => {
      if (moduleLoaded) return;
      try {
        loadSides(handle, [{ name: "engine", bytes: module }]);
      } catch (error) {
        // A refused load leaves the runtime fit to call, so its account of
        // the failure reaches the page ahead of the Crashed record.
        if (error instanceof RuntimeRefused)
          try {
            drainOutput(handle.rt, worker.writer, outputLength, ctx);
          } catch {
            // The crash is already LOAD's; a failed drain only loses records.
          }
        throw new RuntimeStopped({ error, reason: CrashReason.load });
      }
      moduleLoaded = true;
    },
    outputLength,
    postDoorbell: () => worker.env.post({ type: "doorbell" }),
    lastSeq: 0,
    topUpFailed: false,
    stopping: false,
    woken: false,
  };
  // Destroying the engines left open runs their finalizers, which can leave
  // work for the default context; a few pumps run it without chasing a
  // source that keeps itself due. Records written here belong to no request,
  // so the page hears of them through a doorbell.
  yield* Effect.addFinalizer((exit) =>
    guarded(() => {
      const intact = runtimeIntact(exit);
      try {
        scopes.closeAll(handle.rt, intact);
      } catch (error) {
        if (error instanceof RuntimeStopped && error.reason === CrashReason.fault)
          try {
            drainOutput(handle.rt, worker.writer, outputLength, ctx);
          } catch {
            // The crash is already the fault's; a failed drain only loses records.
          }
        throw error;
      }
      if (!intact) return;
      for (let round = 0; round < SHUTDOWN_PUMPS; round++) if (pump(handle.rt, constants) !== 0) break;
      if (drainOutput(handle.rt, worker.writer, outputLength, ctx) > 0) ringDoorbell(ctx);
    }).pipe(Effect.orDie),
  );
  const relayFailed = Effect.gen(function* () {
    const message = yield* Effect.promise(() => within(relay.failed, config.crashWaitMs, "stopped without an error"));
    return yield* new RelayFailed({ message });
  });
  const answer = (reply: Promise<InstrumentReply>) =>
    Effect.promise(() => reply).pipe(Effect.flatMap((value) => guarded(() => finishReply(ctx, value))));

  // The only asynchronous excursion: the new Workers load only while this
  // thread's event loop runs, so the host waits for requests with
  // Atomics.waitAsync() meanwhile, serving and pumping as it would asleep.
  const topUpPool = (want: number) =>
    Effect.gen(function* () {
      instruments.eventLoopTurn();
      let outcome: { ms: number; createMs: number } | { error: unknown } | undefined;
      const loaded = topUp(handle.rt, want, config.topUpLimitMs).then(
        (done) => {
          outcome = done;
        },
        (error: unknown) => {
          outcome = { error };
        },
      );
      while (outcome === undefined) {
        const next = yield* guarded(() => step(ctx));
        if (next.kind === "served") continue;
        if (next.kind === "await") {
          yield* answer(next.reply);
          continue;
        }
        if (next.kind === "stopped") return;
        if (next.kind === "relayFailed") return yield* relayFailed;
        const woke = Atomics.waitAsync(
          handle.words,
          wakeIndex,
          next.seen,
          next.delay < 0 ? Infinity : next.delay,
        ).value;
        const value =
          typeof woke === "string" ? woke : yield* Effect.promise(() => Promise.race([woke, loaded.then(() => "")]));
        ctx.woken = value === "ok";
      }
      if ("error" in outcome) {
        ctx.topUpFailed = true;
        yield* Effect.logError(describe(outcome.error));
      } else instruments.toppedUp(want, outcome.ms, outcome.createMs);
    });

  for (;;) {
    const excursion = yield* guarded(() => serveUntilExcursion(ctx));
    switch (excursion.kind) {
      case "stopped":
        return;
      case "topUp":
        yield* topUpPool(excursion.want);
        break;
      case "await":
        yield* answer(excursion.reply);
        break;
      case "relayFailed":
        return yield* relayFailed;
    }
  }
}).pipe(Effect.scoped);
```

- [ ] **Step 8: Reduce `host.ts` to the composition**

Replace the contents of `packages/worker-host/src/worker/host.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The Worker host as a scoped program. Its resources are layers, each a
// scope inside the last: the Worker (the control buffer, the logger, crash
// reporting), the storage's plan (the locks, and what to mount, which sizes
// the runtime's memory), the runtime (instantiated in a memory made for it),
// the wake relay, which bumps a word in that memory, the storage's mounts,
// and the engine module. The request loop then runs as one synchronous
// section, leaving it only to top the pthread pool up. Only this Worker, and
// the relay it starts, touch the runtime's memory.

import { Effect, Layer } from "effect";
import type { HostInit } from "../shared/messages.ts";
import type { HostConfig } from "./config.ts";
import type { StartupFailed } from "./failure.ts";
import { relayLayer, type Relay } from "./layers/relay.ts";
import { runtimeLayer, type HostRuntime } from "./layers/runtime.ts";
import { storageLayer, type Storage } from "./layers/storage.ts";
import { storagePlanLayer, type PlannedStorage } from "./layers/storage-plan.ts";
import { HostWorker, workerLayer, type WorkerEnv } from "./layers/worker.ts";
import { serve } from "./serve.ts";

// Every scope the host runs in, outermost last.
export const hostLayer = (
  init: HostInit<WebAssembly.Module, unknown>,
  env: WorkerEnv,
): Layer.Layer<HostWorker | PlannedStorage | HostRuntime | Relay | Storage, StartupFailed, HostConfig> =>
  storageLayer.pipe(
    Layer.provideMerge(relayLayer),
    Layer.provideMerge(runtimeLayer),
    Layer.provideMerge(storagePlanLayer),
    Layer.provideMerge(workerLayer(init, env)),
  );

// The host: starts every scope, says it is ready, then serves until the
// runtime stops. Failures are reported to the page as the Worker scope
// closes, so the program itself never fails.
export const program = (
  init: HostInit<WebAssembly.Module, unknown>,
  env: WorkerEnv,
): Effect.Effect<void, never, HostConfig> =>
  Effect.gen(function* () {
    const worker = yield* HostWorker;
    worker.ready();
    return yield* serve;
  }).pipe(Effect.provide(hostLayer(init, env)), Effect.ignore);
```

- [ ] **Step 9: Point `WorkerEnv`'s importers at its new home**

In `packages/worker-host/src/worker/index.ts`, replace `import { program, type WorkerEnv } from "./host.ts";` with

```ts
import { program } from "./host.ts";
import type { WorkerEnv } from "./layers/worker.ts";
```

In `packages/worker-host/test/worker/host.ts`, replace
`import { program, type WorkerEnv } from "../../src/worker/host.ts";` with

```ts
import { program } from "../../src/worker/host.ts";
import type { WorkerEnv } from "../../src/worker/layers/worker.ts";
```

In `packages/worker-host/test/browser/layers.test.ts`, change the import that ends `} from "../../src/worker/host.ts";`
(the one naming `HostWorker`, `workerLayer`, `HostWorkerShape`, `UncaughtError`, `WorkerEnv`) to end
`} from "../../src/worker/layers/worker.ts";`.

- [ ] **Step 10: Confirm nothing moved was lost**

```bash
for name in hostLogger crashFailure stoppedRecord crashRecord crashMessage startupMessage workerLayer storagePlanLayer runtimeLayer startRelay relayLayer storageLayer serve hostLayer program SHUTDOWN_PUMPS UNWIND SpawnWorker within; do
  printf '%s %s\n' "$name" "$(rg -l "^(export )?const $name\b" packages/worker-host/src/worker | tr '\n' ' ')"
done
```

Expected: each name defined in exactly one file: `failure.ts` (`crashFailure`, `stoppedRecord`, `crashRecord`,
`crashMessage`, `startupMessage`, `UNWIND`, `within`), `layers/worker.ts` (`hostLogger`, `workerLayer`),
`layers/storage-plan.ts`, `layers/runtime.ts`, `layers/relay.ts` (`SpawnWorker`, `startRelay`, `relayLayer`),
`layers/storage.ts`, `serve.ts` (`serve`, `SHUTDOWN_PUMPS`), `host.ts` (`hostLayer`, `program`).

- [ ] **Step 11: Run the affected checks**

```bash
nix develop -c hk check --all
nix build .#checks.x86_64-linux.worker-host-node .#checks.x86_64-linux.worker-host-browser .#checks.x86_64-linux.hangul-host .#checks.x86_64-linux.ibus-web .#checks.x86_64-linux.bundle-scan -L
```

Expected: all pass. `bundle-scan` still finds no host code in the page graph, and `worker-host`'s build runs
`types/tsconfig.check.json` against the rebuilt `dist/`.

- [ ] **Step 12: Run the gate and commit**

```bash
nix develop -c git add packages/worker-host/src packages/worker-host/test
nix develop -c git commit -m "refactor(worker-host): give each host scope and the request loop its own file" -- packages/worker-host/src packages/worker-host/test
```

### Task D9: Readable tests

`connection.test.ts` gets `describe` groups, measurement lines in the Hangul suite go through the harness's `record`
reporter, and capability masks name their flags.

`packages/core/test/browser/crash.test.ts`'s `console.log` of recovery measurements stays: core's browser tests have no
reporter, and adding one for a single line isn't worth it.

**Files:**

- Modify: `packages/core/test/node/connection/connection.test.ts`,
  `packages/worker-host/test/engines/hangul.test.ts`, `packages/worker-host/test/engines/page-session.ts`

**Interfaces:**

- Consumes: `Harness.record(name: string, measurements: Record<string, unknown>): void`, which prints
  `` `${name}: ${JSON.stringify(measurements)}` ``.

- [ ] **Step 1: Count the connection tests**

```bash
grep -cE '^\s*test(\.each)?\(' packages/core/test/node/connection/connection.test.ts
```

Expected: `48`.

- [ ] **Step 2: Group the connection tests**

In `packages/core/test/node/connection/connection.test.ts`, add `describe` to the `vitest` import. Move the
`lookupRecord` function from between the tests to just below `start()`, beside the other helpers. Then wrap the tests in
these six `describe` blocks, in this order, moving each test whole (from its `test(` or `test.each(` line through its
closing `});` or `);`) and keeping the order shown within each block. Indent each moved test by two spaces; the file's
`beforeEach`/`afterEach` stay at the top level so they apply to every group.

`describe("startup and shutdown", () => { … })`:

1. `bootstraps one host with URL-only init and cached runtime compilation`
2. `startup host error rejects and stops the worker`
3. `default factory starts a module Worker at hostUrl`
4. `failed compilation is evicted so the next start retries`
5. `aborting startup terminates a Worker that has not announced ready and removes its listeners`
6. `aborting during shared compilation rejects promptly and cannot create a Worker later`
7. `an already-aborted startup cannot compile or create a Worker`
8. `aborting after ready but before startup hands off terminates the Worker`
9. `startup signal no longer owns an established connection`
10. `unsubscribe removes listeners and terminate rejects outstanding work`
11. `forced termination retains caller reason and last storage state exactly once`
12. `storage callbacks expose Worker messages without waiting for a crash`

`describe("synchronous replies", () => { … })`:

1. `sync reply includes records through outSeq; later output stays for take`
2. `waits for records even when REPLY is visible first`
3. `budget exhaustion abandons and does not overwrite busy slot`
4. `reply in the abandonment compare-exchange race completes synchronously`
5. `output already past replyOutSeq stays outside the synchronous batch`
6. `all sync drains stop at the deadline despite replenished output, then complete once without a host bell`
7. `sync fragment draining yields within budget and resumes the same abandoned batch in order`
8. `a reply with unread output arriving during abandonment defers its drain without losing completion`
9. `reply acquisition keeps non-crash invariant errors visible`

`describe("asynchronous replies", () => { … })`:

1. `async replies resolve on doorbell and requests are serialized`
2. `clears doorbell before draining; coalesced output is not stranded`
3. `abandoned and queued async replies each own their records exactly once`
4. `async reply does not resolve until its advertised output has drained`
5. `a real doorbell supersedes deferred completion and queued requests retain their own batch`

`describe("output records", () => { … })`:

1. `fragment reassembly frees space and wakes a blocked writer`
2. `invalid sequence or host ic is logged and dropped` (the `test.each`)
3. `development throws ProtocolError`
4. `doorbell during fragment backpressure does not release an incomplete reply's records`
5. `sequence validation resumes after a dropped gap and skips zero on wrap`
6. `host records do not advance the runtime sequence`
7. `ring movement keeps an incomplete request alive until progress stops`
8. `malformed payload is logged and dropped without blocking a valid successor`
9. `buffered output access does not drain a live ring or steal in-flight reply records`
10. `buffered output access observes CRASHED before returning stale records`
11. `production reply delivers lazy lookup to the panel and retains bytes after ring reuse (corrupt=%s)` (the
    `test.each`)

`describe("crashes and hangs", () => { … })`:

1. `Crashed preserves %s reason` (the `test.each`)
2. `crash from %s rejects pending work once` (the `test.each`)
3. `a hang rejects queued requests and terminates the host`
4. `a preexisting CRASHED state returns a crash before posting`
5. `crash carries the last storage state and rejects every queued request`
6. `a crash racing request publication returns a crash instead of stranding busy state`
7. `CRASHED racing %s reply acquisition follows normal cleanup` (the `test.each`)

`describe("Init watchdog", () => { … })`:

1. `Init may finish after the interactive watchdog budget, then a queued key uses its own budget`
2. `Init without progress eventually hangs with budget %s` (the `test.each`)
3. `Init ring movement refreshes only its bounded progress watchdog`
4. `invalid Init watchdog budget %s fails before creating a Worker` (the `test.each`)

- [ ] **Step 3: Confirm no test was lost or duplicated**

```bash
grep -cE '^\s*test(\.each)?\(' packages/core/test/node/connection/connection.test.ts
grep -cE '^describe\(' packages/core/test/node/connection/connection.test.ts
grep -nE '^test' packages/core/test/node/connection/connection.test.ts
```

Expected: `48`, `6`, and no output.

- [ ] **Step 4: The Hangul suite records through the harness**

In `packages/worker-host/test/engines/hangul.test.ts`, replace

```ts
  afterAll(() =>
    console.log(
      `Hangul ${runtime.name} suite peaks: ${JSON.stringify({ breakPeak, poolWorkersPeak, activeThreadsPeak, threads: build.manifest.threads })}`,
    ),
  );
```

with

```ts
  afterAll(() =>
    h.record(`Hangul ${runtime.name} suite peaks`, {
      breakPeak,
      poolWorkersPeak,
      activeThreadsPeak,
      threads: build.manifest.threads,
    }),
  );
```

and replace

```ts
    console.log(
      `Hangul ${runtime.name} resources: ${JSON.stringify({ breakPeak: stats.breakPeak, poolWorkersPeak: stats.poolWorkersPeak, idleWorkers: stats.idleWorkers, activeThreadsPeak: stats.activeThreadsPeak, threads: build.manifest.threads, heapBytes: build.heapBytes })}`,
    );
```

with

```ts
    h.record(`Hangul ${runtime.name} resources`, {
      breakPeak: stats.breakPeak,
      poolWorkersPeak: stats.poolWorkersPeak,
      idleWorkers: stats.idleWorkers,
      activeThreadsPeak: stats.activeThreadsPeak,
      threads: build.manifest.threads,
      heapBytes: build.heapBytes,
    });
```

The printed lines are unchanged: `record` prints `name: {json}`.

- [ ] **Step 5: Name the capability flags**

In `packages/worker-host/test/engines/page-session.ts`, add `IBusCapability,` to the `@ibus-web/protocol` import list
(after `FocusIn,`) and replace

```ts
// Preedit, auxiliary text, lookup table, focus and surrounding text.
export const CAPABILITIES = 1 | 2 | 4 | 8 | 32;
```

with

```ts
export const CAPABILITIES =
  IBusCapability.PREEDIT_TEXT |
  IBusCapability.AUXILIARY_TEXT |
  IBusCapability.LOOKUP_TABLE |
  IBusCapability.FOCUS |
  IBusCapability.SURROUNDING_TEXT;
```

In `packages/worker-host/test/engines/hangul.test.ts`, add `IBusCapability,` to the `@ibus-web/protocol` import list
(after `FocusOut,`) and replace `new SetCapabilities({ capabilities: CAPABILITIES | 128 })` with
`new SetCapabilities({ capabilities: CAPABILITIES | IBusCapability.SYNC_PROCESS_KEY })`.

- [ ] **Step 6: Run the affected checks**

```bash
nix develop -c hk check --all
nix build .#checks.x86_64-linux.core .#checks.x86_64-linux.hangul-host -L 2>&1 | grep -E "Test Files|Tests |Hangul .* (suite peaks|resources):"
```

Expected: both pass, core's test count matches Task D1's, and the `Hangul … suite peaks:` and `Hangul … resources:`
lines still print.

- [ ] **Step 7: Run the gate and commit**

```bash
nix develop -c git add packages/core/test packages/worker-host/test
nix develop -c git commit -m "test: group connection tests and name measurement and capability values" -- packages/core/test packages/worker-host/test
```
## Phase E: Package metadata and `tools/pack-licenses`

Phase E assumes Phases A–D have landed:

- `@ibus-web/tsconfig` exists, with its `node.json` preset.
- Every tool is its own package under `tools/<name>/`, with a `module.nix` holding its checks.
- `modules/typescript/` is split into `workspace.nix`, `files.nix` and `tsc.nix`.
- `ibusWeb.testing.vitestCheck` keeps its signature: `{ name, packageDir, env, inBrowsers, limit, vitestArgs ? [ ] }`.

The five publishable packages are `packages/protocol`, `packages/worker-host`, `packages/core`, `packages/panel` and `packages/ibus-web`. Only `worker-host` bundles third-party npm code: `effect` and `brotli-dec-wasm` go into `dist/worker`. `ibus-web` copies that directory into `dist/host`. Core bundles third-party data in its generated key tables.

### Task E1: Package metadata and its check

**Files:**

- Create: `modules/typescript/checks.nix`
- Create: `packages/protocol/README.md`, `packages/worker-host/README.md`, `packages/core/README.md`, `packages/panel/README.md`, `packages/ibus-web/README.md`
- Modify: `packages/{protocol,worker-host,core,panel,ibus-web}/package.json`

**Interfaces:**

- Consumes: `config.ibusWeb.typescript.nodejs` (the workspace's Node package).
- Produces: `checks.typescript-package-metadata`. It reads every `packages/*/package.json` that isn't `"private": true`. Task E5 extends its `problemsOf`.

- [ ] **Step 1: Write the failing check**

Create `modules/typescript/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, ... }:
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb.typescript) nodejs;
      root = ../..;
      docsBase = "https://github.com/synapdeck/ibus-web/blob/master/";

      # Every package under packages/ that npm may publish.
      published = lib.filter (dir: !((lib.importJSON (root + "/${dir}/package.json")).private or false)) (
        map (name: "packages/${name}") (
          lib.attrNames (lib.filterAttrs (_: type: type == "directory") (builtins.readDir (root + "/packages")))
        )
      );

      problemsOf =
        dir:
        let
          manifest = lib.importJSON (root + "/${dir}/package.json");
          homepage = manifest.homepage or "";
          # The packages target the Node the workspace builds with. Only its
          # major version is stated, so a nixpkgs patch release of Node doesn't
          # fail this.
          node = ">=${lib.versions.major nodejs.version}";
        in
        map (problem: "${dir}: ${problem}") (
          lib.optional (!(builtins.pathExists (root + "/${dir}/README.md"))) "has no README.md"
          ++ lib.optional (!(manifest ? description)) "has no description"
          ++ lib.optional ((manifest.license or null) != "MIT OR Apache-2.0") "isn't licensed MIT OR Apache-2.0"
          ++ lib.optional (
            !(lib.hasPrefix docsBase homepage && builtins.pathExists (root + "/${lib.removePrefix docsBase homepage}"))
          ) "homepage isn't a page of this repository"
          ++ lib.optional (!(manifest ? sideEffects)) "doesn't declare sideEffects"
          ++ lib.optional ((manifest.engines.node or null) != node) "engines.node isn't \"${node}\""
          ++ lib.optional ((manifest.keywords or [ ]) == [ ]) "has no keywords"
        );

      problems = lib.concatMap problemsOf published;
    in
    {
      checks.typescript-package-metadata = pkgs.runCommand "ibus-web-typescript-package-metadata" { } (
        if problems == [ ] then
          "touch $out"
        else
          lib.concatMapStrings (problem: "echo ${lib.escapeShellArg problem} >&2\n") problems + "exit 1\n"
      );
    };
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `nix build .#checks.x86_64-linux.typescript-package-metadata -L`

Expected: FAIL. The log should name, among others:

- `packages/core: has no README.md`
- `packages/core: homepage isn't a page of this repository`
- `packages/core: doesn't declare sideEffects`
- `packages/core: engines.node isn't ">=24"`
- `packages/core: has no keywords`

`protocol` and `worker-host` should not have the homepage line. If the major version printed isn't 24, use the printed one in Step 3.

- [ ] **Step 3: Add the metadata**

Add these fields to each `package.json`, after `"license"`, keeping every existing field:

`packages/protocol/package.json`:

```json
  "keywords": ["ibus", "input-method", "gvariant", "protocol", "webassembly"],
  "sideEffects": false,
  "engines": { "node": ">=24" },
```

`packages/worker-host/package.json`:

```json
  "keywords": ["ibus", "input-method", "ime", "web-worker", "webassembly"],
  "sideEffects": ["./dist/worker/*.js"],
  "engines": { "node": ">=24" },
```

`packages/core/package.json`: set `"homepage": "https://github.com/synapdeck/ibus-web/blob/master/docs/core.md"`, and add:

```json
  "keywords": ["ibus", "input-method", "ime", "keyboard", "webassembly"],
  "sideEffects": false,
  "engines": { "node": ">=24" },
```

`packages/panel/package.json`: set `"homepage": "https://github.com/synapdeck/ibus-web/blob/master/docs/panel.md"`, and add:

```json
  "keywords": ["ibus", "input-method", "ime", "candidate-window"],
  "sideEffects": ["./dist/style.css"],
  "engines": { "node": ">=24" },
```

Then remove `"effect": "catalog:"` from both `peerDependencies` and `devDependencies` in panel's `package.json`. Panel imports only protocol types. Leave an empty `peerDependencies` out entirely.

`packages/ibus-web/package.json`: set `"homepage": "https://github.com/synapdeck/ibus-web/blob/master/docs/ibus-web.md"`, and add:

```json
  "keywords": ["ibus", "input-method", "ime", "hangul", "webassembly"],
  "sideEffects": ["./dist/style.css", "./dist/host/*.js"],
  "engines": { "node": ">=24" },
```

The worker entries (`dist/worker/*.js`, and their copies in `dist/host/`) assign `self.onmessage` when loaded, and the stylesheets apply when imported. Every other module only declares exports.

- [ ] **Step 4: Check that panel compiles without `effect`**

Run: `nix develop -c sh -c 'pnpm install && grep -rn "from \"effect" packages/panel/src packages/panel/test || echo none'`

Expected: `none`, and `pnpm-lock.yaml` changes only in panel's importer. If a panel test imports `effect`, keep `effect` in `devDependencies` only.

- [ ] **Step 5: Write the five READMEs**

`packages/protocol/README.md`:

````markdown
# @ibus-web/protocol

The wire protocol between ibus-web's page and its Worker hosts: strict GVariant codecs, the typed
messages each side sends, and the shared-memory transport they travel over. Everything ibus-web
sends between the page and an engine's Worker goes through this package, and its decoder accepts
exactly what GLib's `g_variant_is_normal_form` accepts.

Most applications use [`ibus-web`](../ibus-web/README.md), which depends on this package; use it
directly to write your own host or page side.

```ts
import { GVariantBytes } from "@ibus-web/protocol";
```

`effect` 4 is a peer dependency. Consumers of its schemas need `exactOptionalPropertyTypes`.

The generated message reference is [`PROTOCOL.md`](PROTOCOL.md); the design is in
[docs/protocol.md](https://github.com/synapdeck/ibus-web/blob/master/docs/protocol.md).

Licensed under MIT OR Apache-2.0, at your option.
````

`packages/worker-host/README.md`:

```markdown
# @ibus-web/worker-host

The TypeScript that runs inside each ibus-web engine's dedicated Worker. It instantiates the
WebAssembly IBus runtime, starts the wake relay, mounts storage, installs the engine's data, and
serves the page's requests over the shared-memory transport.

The page doesn't import the host: it starts it by URL. `@ibus-web/worker-host/worker` and
`@ibus-web/worker-host/relay` are the two Worker scripts. Keep `dist/worker/` together when
deploying, since the host loads its relay and Brotli fallback from beside itself. The package root
exports only what the page shares with the host: the control buffer layout, the messages and the
storage names.

Most applications use [`ibus-web`](../ibus-web/README.md), which ships these scripts as
`ibus-web/host/*`. The design is in
[docs/worker-host.md](https://github.com/synapdeck/ibus-web/blob/master/docs/worker-host.md).

The Worker scripts bundle `effect` and `brotli-dec-wasm`; their licenses are in `LICENSES/`.
The package itself is licensed under MIT OR Apache-2.0, at your option.
```

`packages/core/README.md`:

```markdown
# @ibus-web/core

ibus-web's page-side client. It translates DOM key events to IBus key events, routes them to
engines running in Workers, applies their preedit and commits to text surfaces through adapters,
and reports panel state. It imports only the host's shared transport definitions: Worker, runtime
and engine code load by URL and never enter the page bundle.

`@ibus-web/core` exports the Effect services (`Router`, `EngineRegistry`, `CoreConfig`,
`SettingsSource`, `Logger`, `PanelEvents`) and the textarea adapter; `@ibus-web/core/keys`
exports key translation alone. `effect` 4 is a peer dependency.

Most applications use [`ibus-web`](../ibus-web/README.md), which wraps this package in a promise
API. The design and the layer wiring are in
[docs/core.md](https://github.com/synapdeck/ibus-web/blob/master/docs/core.md).

Licensed under MIT OR Apache-2.0, at your option. The generated key tables come from xorgproto,
Chromium and xkeyboard-config; their licenses and notices are in `LICENSES/`.
```

`packages/panel/README.md`:

````markdown
# @ibus-web/panel

A framework-free candidate and property panel for ibus-web. It follows the caret, shows the
engine's lookup table, auxiliary text and properties, and sends clicks, paging and scrolling
back to the engine. Hosts can replace it with their own UI through the same `PanelHost` contract.

```ts
import { createPanel } from "@ibus-web/panel";
import "@ibus-web/panel/style.css";
```

The stylesheet is separate, and every rule in it can be overridden. Most applications import the
panel through [`ibus-web`](../ibus-web/README.md) as `ibus-web/panel`. Details are in
[docs/panel.md](https://github.com/synapdeck/ibus-web/blob/master/docs/panel.md).

Licensed under MIT OR Apache-2.0, at your option.
````

`packages/ibus-web/README.md`:

````markdown
# ibus-web

IBus input-method engines in the browser. ibus-web runs C and C++ IBus engines, such as
ibus-hangul, as WebAssembly in dedicated Workers. It gives your page what the IBus daemon, the
input-method module and the candidate panel give a Linux desktop: key handling, preedit, commits
and candidates for your text fields.

```ts
import { createIbusWeb } from "ibus-web";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/assets/runtime/ibus-runtime.js", location.href),
  engines: { hangul: new URL("/assets/hangul/manifest.json", location.href) },
});
const detach = ibus.attach(document.querySelector("textarea")!);
await ibus.select("hangul");
```

The page must be cross-origin isolated (COOP `same-origin`, COEP `require-corp`). Deploy the
runtime, the engines' distributions and this package's `host/` directory as static assets.
`ibus-web/panel` adds the default candidate panel, and `ibus-web/effect` exposes the underlying
Effect services. `effect` 4 is a peer dependency.

Deployment, the full API and settings are described in
[docs/ibus-web.md](https://github.com/synapdeck/ibus-web/blob/master/docs/ibus-web.md).

Licensed under MIT OR Apache-2.0, at your option. The Worker scripts in `host/` bundle `effect`
and `brotli-dec-wasm`; their licenses are in `LICENSES/`. Engines are licensed separately (ibus-hangul
is GPL-2.0-or-later) and run only inside their Workers, never in your page's bundle.
````

Format them: `nix develop -c oxfmt packages/*/README.md`.

- [ ] **Step 6: Run the check to see it pass**

Run: `nix build .#checks.x86_64-linux.typescript-package-metadata -L`

Expected: PASS, with no output.

- [ ] **Step 7: Run the task gate and commit**

Run the four commands in Global Constraints. If `pnpmDeps`' hash changed, update `hash` in `modules/typescript/workspace.nix` from the mismatch error's `got:` value and rerun.

```bash
nix develop -c git add modules/typescript/checks.nix packages/{protocol,worker-host,core,panel,ibus-web}/package.json packages/{protocol,worker-host,core,panel,ibus-web}/README.md pnpm-lock.yaml modules/typescript/workspace.nix
nix develop -c git commit -m "feat(packages): describe the published packages and check their metadata" -- modules/typescript/checks.nix packages/protocol/package.json packages/worker-host/package.json packages/core/package.json packages/panel/package.json packages/ibus-web/package.json packages/protocol/README.md packages/worker-host/README.md packages/core/README.md packages/panel/README.md packages/ibus-web/README.md pnpm-lock.yaml modules/typescript/workspace.nix
```

### Task E2: `tools/pack-licenses`: REUSE and SPDX lookup

**Files:**

- Create: `tools/pack-licenses/package.json`, `tools/pack-licenses/tsconfig.json`, `tools/pack-licenses/vitest.config.ts`
- Create: `tools/pack-licenses/reuse.ts`, `tools/pack-licenses/spdx.ts`
- Create: `tools/pack-licenses/fixture.ts`, `tools/pack-licenses/reuse.test.ts`
- Create: `tools/pack-licenses/checks.nix`

**Interfaces:**

- Produces:
  - `globToRegExp(glob: string): RegExp`
  - `headerLicense(text: string): string | undefined`
  - `parseReuseToml(text: string): Annotation[]`, where `interface Annotation { readonly patterns: readonly RegExp[]; readonly license: string | undefined; readonly precedence: "closest" | "aggregate" | "override" }`
  - `licenseOf(root: string, file: string, annotations: readonly Annotation[]): Promise<string | undefined>`
  - `licenseIds(expression: string): string[]`
  - Test helpers in `fixture.ts`: `makeTree`, `cleanUp`, `KEY`, `own`, `sourceMap`
  - `checks.tools-pack-licenses`

The tool's own files spell the SPDX tag in pieces (`["SPDX", "License", "Identifier"].join("-")`). Otherwise `reuse lint` would read the string literals as this file's licence.

- [ ] **Step 1: Scaffold the package**

`tools/pack-licenses/package.json` (strict JSON; `REUSE.toml` already annotates `**/package.json`):

```json
{
  "name": "@ibus-web/pack-licenses",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run --configLoader native"
  },
  "dependencies": {
    "smol-toml": "catalog:"
  },
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  }
}
```

`tools/pack-licenses/tsconfig.json`:

```jsonc
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "extends": "@ibus-web/tsconfig/node.json",
  "include": ["*.ts"],
}
```

`tools/pack-licenses/vitest.config.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { defineConfig } from "vitest/config";

const cacheDir = process.env["IBUS_WEB_TEST_CACHE_DIR"];

export default defineConfig({
  ...(cacheDir === undefined ? {} : { cacheDir }),
  test: { include: ["*.test.ts"] },
});
```

`tools/pack-licenses/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) testing typescript;
      workspace = typescript.workspaceFor [ "tools/pack-licenses" ];
    in
    {
      checks.tools-pack-licenses = testing.vitestCheck {
        name = "tools-pack-licenses";
        packageDir = "${workspace}/tools/pack-licenses";
        env = { };
        inBrowsers = false;
        limit = 120;
      };
    };
}
```

Then run `nix develop -c pnpm install` to add the importer to `pnpm-lock.yaml`.

- [ ] **Step 2: Write the test helpers**

`tools/pack-licenses/fixture.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Throwaway repository trees for the tests.

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Spelled in pieces so REUSE doesn't take the fixtures' tags for this file's.
export const KEY = ["SPDX", "License", "Identifier"].join("-");

/** A header line declaring the repository's own license. */
export const own = (comment = "//") => `${comment} ${KEY}: MIT OR Apache-2.0\n`;

/** A version 3 sourcemap naming the given sources. */
export const sourceMap = (...sources: readonly string[]) =>
  JSON.stringify({ version: 3, sources, mappings: "" });

const roots: string[] = [];

/** Writes the files, by path relative to a new temporary root, and returns the root. */
export async function makeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pack-licenses-")));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

export async function cleanUp(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
```

- [ ] **Step 3: Write the failing tests**

`tools/pack-licenses/reuse.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { KEY, cleanUp, makeTree, own } from "./fixture.ts";
import { globToRegExp, headerLicense, licenseOf, parseReuseToml } from "./reuse.ts";
import { licenseIds } from "./spdx.ts";

afterEach(cleanUp);

test("a single star stops at a slash and a double star doesn't", () => {
  expect(globToRegExp("docs/*.md").test("docs/a.md")).toBe(true);
  expect(globToRegExp("docs/*.md").test("docs/x/a.md")).toBe(false);
  expect(globToRegExp("docs/**").test("docs/x/a.md")).toBe(true);
  expect(globToRegExp("a.b").test("axb")).toBe(false);
  expect(globToRegExp("a\\*b").test("a*b")).toBe(true);
});

test("a header's tags are read without their comment closers", () => {
  expect(headerLicense(`/* ${KEY}: MIT */\n`)).toBe("MIT");
  expect(headerLicense(`<!-- ${KEY}: BSD-3-Clause -->\n`)).toBe("BSD-3-Clause");
  expect(headerLicense(`// ${KEY}: MIT\n// ${KEY}: HPND\n`)).toBe("(MIT) AND (HPND)");
  expect(headerLicense("no tags\n")).toBeUndefined();
});

test("annotations keep their paths, license and precedence", () => {
  const [one, two] = parseReuseToml(`version = 1
[[annotations]]
path = "a/**"
${KEY} = "MIT"

[[annotations]]
path = ["b.txt", "c/*.txt"]
${KEY} = "HPND"
precedence = "override"
`);
  expect(one?.precedence).toBe("closest");
  expect(one?.license).toBe("MIT");
  expect(one?.patterns.some((pattern) => pattern.test("a/x/y.ts"))).toBe(true);
  expect(two?.precedence).toBe("override");
  expect(two?.patterns.some((pattern) => pattern.test("c/d.txt"))).toBe(true);
});

test("a file's license follows REUSE's precedence", async () => {
  const toml = `version = 1
[[annotations]]
path = "closest/**"
${KEY} = "BSD-3-Clause"

[[annotations]]
path = "override/**"
${KEY} = "HPND"
precedence = "override"

[[annotations]]
path = "aggregate/**"
${KEY} = "HPND"
precedence = "aggregate"

[[annotations]]
path = ["last/*", "last/x.ts"]
${KEY} = "MIT"

[[annotations]]
path = "last/x.ts"
${KEY} = "ISC"
`;
  const root = await makeTree({
    "closest/header.ts": own(),
    "closest/bare.ts": "export {};\n",
    "override/header.ts": own(),
    "aggregate/header.ts": own(),
    "last/x.ts": "export {};\n",
    "sidecar/data.bin": "\0binary",
    "sidecar/data.bin.license": `${KEY}: CC0-1.0\n`,
    "none/x.bin": "\0binary",
  });
  const annotations = parseReuseToml(toml);
  const of = (path: string) => licenseOf(root, join(root, path), annotations);
  expect(await of("closest/header.ts")).toBe("MIT OR Apache-2.0");
  expect(await of("closest/bare.ts")).toBe("BSD-3-Clause");
  expect(await of("override/header.ts")).toBe("HPND");
  expect(await of("aggregate/header.ts")).toBe("(MIT OR Apache-2.0) AND (HPND)");
  expect(await of("last/x.ts")).toBe("ISC");
  expect(await of("sidecar/data.bin")).toBe("CC0-1.0");
  expect(await of("none/x.bin")).toBeUndefined();
});

test("an expression's license identifiers, without operators", () => {
  expect(licenseIds("MIT-open-group AND HPND")).toEqual(["HPND", "MIT-open-group"]);
  expect(licenseIds("(MIT OR Apache-2.0) WITH LLVM-exception")).toEqual([
    "Apache-2.0",
    "LLVM-exception",
    "MIT",
  ]);
  expect(licenseIds("(MIT) AND (MIT)")).toEqual(["MIT"]);
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `nix develop -c sh -c 'cd tools/pack-licenses && pnpm test'`

Expected: FAIL, because `./reuse.ts` and `./spdx.ts` can't be resolved.

- [ ] **Step 5: Implement `spdx.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

const OPERATORS = new Set(["AND", "OR", "WITH"]);

/** The license and exception identifiers an SPDX expression names, sorted, each once. */
export function licenseIds(expression: string): string[] {
  const tokens = expression.replace(/[()]/g, " ").split(/\s+/);
  const ids = tokens.filter((token) => token !== "" && !OPERATORS.has(token.toUpperCase()));
  return [...new Set(ids)].sort();
}
```

- [ ] **Step 6: Implement `reuse.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A file's license as `reuse lint` sees it: from its own header or `.license`
// sidecar, and from the last REUSE.toml annotation whose path matches it.
// `reuse` itself can't be asked about one file, and over a Nix build's tree
// without git it would scan every node_modules.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { parse } from "smol-toml";

// Spelled in pieces so REUSE doesn't read this file's code as its tags.
const KEY = ["SPDX", "License", "Identifier"].join("-");
const TAG = `${KEY}:`;

export interface Annotation {
  readonly patterns: readonly RegExp[];
  readonly license: string | undefined;
  readonly precedence: "closest" | "aggregate" | "override";
}

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** A REUSE.toml path pattern: `*` stops at a slash, `**` doesn't, `\` escapes. */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === "\\" && i + 1 < glob.length) {
      pattern += escape(glob.charAt(++i));
    } else if (char === "*" && glob.charAt(i + 1) === "*") {
      pattern += ".*";
      i++;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else {
      pattern += escape(char);
    }
  }
  return new RegExp(`^${pattern}$`);
}

/** The licenses a file's text declares, joined with AND, or undefined if it declares none. */
export function headerLicense(text: string): string | undefined {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const at = line.indexOf(TAG);
    if (at === -1) continue;
    const value = line
      .slice(at + TAG.length)
      .replace(/\s*(?:\*\/|-->)\s*$/, "")
      .trim();
    if (value !== "") found.push(value);
  }
  if (found.length <= 1) return found[0];
  return found.map((expression) => `(${expression})`).join(" AND ");
}

export function parseReuseToml(text: string): Annotation[] {
  const document = parse(text) as { annotations?: readonly Record<string, unknown>[] };
  return (document.annotations ?? []).map((table) => {
    const path = table["path"];
    const paths = typeof path === "string" ? [path] : (path as readonly string[]);
    const license = table[KEY];
    return {
      patterns: paths.map(globToRegExp),
      license: Array.isArray(license) ? license.join(" AND ") : (license as string | undefined),
      precedence: (table["precedence"] ?? "closest") as Annotation["precedence"],
    };
  });
}

async function ownLicense(file: string): Promise<string | undefined> {
  const sidecar = `${file}.license`;
  const bytes = await readFile(existsSync(sidecar) ? sidecar : file);
  // A binary file can't carry a header.
  if (bytes.includes(0)) return undefined;
  return headerLicense(bytes.toString("utf8"));
}

/** The SPDX expression REUSE gives a file under root, or undefined if it gives none. */
export async function licenseOf(
  root: string,
  file: string,
  annotations: readonly Annotation[],
): Promise<string | undefined> {
  const path = relative(root, file).split(sep).join("/");
  const annotation = annotations.findLast((candidate) => candidate.patterns.some((pattern) => pattern.test(path)));
  if (annotation?.precedence === "override") return annotation.license;
  const declared = await ownLicense(file);
  if (annotation?.license === undefined) return declared;
  if (declared === undefined) return annotation.license;
  return annotation.precedence === "aggregate" ? `(${declared}) AND (${annotation.license})` : declared;
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `nix develop -c sh -c 'cd tools/pack-licenses && pnpm test'`

Expected: PASS, 5 tests.

Then run: `nix develop -c reuse lint`

Expected: compliant. If it reports a bad licence expression in `tools/pack-licenses/*.ts`, a literal tag slipped into code; spell it with `KEY`.

- [ ] **Step 8: Run the task gate and commit**

Run the four Global Constraints commands. The new check `tools-pack-licenses` runs under `nix flake check`. If `pnpmDeps`' hash mismatches, update it in `modules/typescript/workspace.nix`.

```bash
nix develop -c git add tools/pack-licenses pnpm-lock.yaml modules/typescript/workspace.nix
nix develop -c git commit -m "feat(pack-licenses): read a file's license as REUSE does" -- tools/pack-licenses pnpm-lock.yaml modules/typescript/workspace.nix
```

### Task E3: `tools/pack-licenses`: what a package bundles

**Files:**

- Create: `tools/pack-licenses/sources.ts`, `tools/pack-licenses/sources.test.ts`
- Create: `tools/pack-licenses/dependency.ts`

**Interfaces:**

- Consumes: `makeTree`, `cleanUp`, `sourceMap` from `fixture.ts`.
- Produces:
  - `interface PackageManifest { readonly name: string; readonly files?: readonly string[]; readonly ibusWeb?: { readonly copiedFrom?: Readonly<Record<string, string>> } }`
  - `bundledSources(packageDir: string, manifest: PackageManifest): Promise<{ sources: ReadonlySet<string>; problems: readonly string[] }>`. The sources are real absolute paths.
  - `dependencyOf(file: string): { name: string; dir: string } | undefined`
  - `licenseFiles(dir: string): Promise<string[]>`

- [ ] **Step 1: Write the failing tests**

`tools/pack-licenses/sources.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { dependencyOf, licenseFiles } from "./dependency.ts";
import { cleanUp, makeTree, sourceMap } from "./fixture.ts";
import { bundledSources } from "./sources.ts";

afterEach(cleanUp);

const dep = "node_modules/.pnpm/dep@1.0.0/node_modules/dep";

const tree = () =>
  makeTree({
    "packages/p/package.json": "{}",
    "packages/p/src/a.ts": "",
    "packages/p/dist/index.js": "",
    "packages/p/dist/index.js.map": sourceMap(
      "../src/a.ts",
      "../../q/dist/lib.js",
      "\0rolldown/runtime.js",
      `../../../${dep}/index.js`,
    ),
    "packages/p/dist/index.d.ts": "",
    "packages/q/src/b.ts": "",
    "packages/q/dist/lib.js": "",
    "packages/q/dist/lib.js.map": sourceMap("../src/b.ts"),
    [`${dep}/index.js`]: "",
    [`${dep}/LICENSE`]: "",
    [`${dep}/LICENSE-MIT.txt`]: "",
    [`${dep}/package.json`]: "{}",
  });

test("sources are followed through the maps of built files they name", async () => {
  const root = await tree();
  const { sources, problems } = await bundledSources(join(root, "packages/p"), { name: "p", files: ["dist", "LICENSES"] });
  expect(problems).toEqual([]);
  expect([...sources].sort()).toEqual(
    [join(root, dep, "index.js"), join(root, "packages/p/src/a.ts"), join(root, "packages/q/src/b.ts")].sort(),
  );
});

test("a packed script without a sourcemap is a problem", async () => {
  const root = await makeTree({ "packages/p/dist/index.js": "" });
  const { problems } = await bundledSources(join(root, "packages/p"), { name: "p", files: ["dist"] });
  expect(problems).toEqual(["dist/index.js has no sourcemap"]);
});

test("a copied directory's maps are read where it was built", async () => {
  const root = await tree();
  await mkdir(join(root, "packages/r/dist/host"), { recursive: true });
  await writeFile(join(root, "packages/r/dist/host/index.js"), "");
  const { sources, problems } = await bundledSources(join(root, "packages/r"), {
    name: "r",
    files: ["dist"],
    ibusWeb: { copiedFrom: { "dist/host": "../p/dist" } },
  });
  expect(problems).toEqual([]);
  expect(sources.has(join(root, "packages/p/src/a.ts"))).toBe(true);
});

test("a files entry that is a pattern is refused", async () => {
  const root = await tree();
  await expect(bundledSources(join(root, "packages/p"), { name: "p", files: ["dist/*.js"] })).rejects.toThrow(
    /pattern/,
  );
});

test("a dependency is named by the node_modules directory holding it", async () => {
  const root = await tree();
  expect(dependencyOf(join(root, dep, "index.js"))).toEqual({ name: "dep", dir: join(root, dep) });
  expect(dependencyOf(join(root, "node_modules/@scope/x/lib/y.js"))).toEqual({
    name: "@scope/x",
    dir: join(root, "node_modules/@scope/x"),
  });
  expect(dependencyOf(join(root, "packages/p/src/a.ts"))).toBeUndefined();
  expect(await licenseFiles(join(root, dep))).toEqual(["LICENSE", "LICENSE-MIT.txt"]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nix develop -c sh -c 'cd tools/pack-licenses && pnpm test sources'`

Expected: FAIL, because `./sources.ts` and `./dependency.ts` can't be resolved.

- [ ] **Step 3: Implement `dependency.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { readdir } from "node:fs/promises";
import { sep } from "node:path";

export interface Dependency {
  readonly name: string;
  readonly dir: string;
}

/** The npm package a file belongs to, by the last node_modules in its path. */
export function dependencyOf(file: string): Dependency | undefined {
  const parts = file.split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at === -1) return undefined;
  const end = at + (parts[at + 1]?.startsWith("@") ? 3 : 2);
  return { name: parts.slice(at + 1, end).join("/"), dir: parts.slice(0, end).join(sep) };
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/i;

/** The license and notice files at the top of a package's directory. */
export async function licenseFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => LICENSE_FILE.test(name)).sort();
}
```

- [ ] **Step 4: Implement `sources.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a package's tarball bundles, from the sourcemaps beside its scripts.
// A source that is itself a built script with a map is followed through that
// map, so a bundle of another workspace package's dist/ leads back to that
// package's sources rather than stopping at its build output.

import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageManifest {
  readonly name: string;
  readonly files?: readonly string[];
  readonly ibusWeb?: {
    /** Packed directories copied from another package's build, to where they were built. */
    readonly copiedFrom?: Readonly<Record<string, string>>;
  };
}

export interface Bundled {
  readonly sources: ReadonlySet<string>;
  readonly problems: readonly string[];
}

interface SourceMap {
  readonly sources: readonly (string | null)[];
  readonly sourceRoot?: string;
}

const SCRIPT = /\.[cm]?js$/;

// Sources a bundler makes up rather than reads, such as its runtime helpers.
const isVirtual = (source: string) =>
  source.startsWith("\0") || (/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.startsWith("file:"));

const inNodeModules = (path: string) => path.split(sep).includes("node_modules");

async function walk(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return [path];
  const entries = await readdir(path);
  return (await Promise.all(entries.map((entry) => walk(join(path, entry))))).flat();
}

async function packedFiles(packageDir: string, manifest: PackageManifest): Promise<string[]> {
  const files: string[] = [];
  for (const entry of manifest.files ?? []) {
    if (/[*?[\]{}!]/.test(entry)) {
      throw new Error(`${manifest.name}: files entry ${entry} is a pattern, which pack-licenses doesn't expand`);
    }
    const path = join(packageDir, entry);
    // LICENSES and the like exist only while the package is being packed.
    if (existsSync(path)) files.push(...(await walk(path)));
  }
  return files;
}

// Where a packed file was built: a copied directory's sourcemaps are
// relative to the directory they were written in.
function builtAt(packageDir: string, manifest: PackageManifest, file: string): string {
  const packed = relative(packageDir, file).split(sep).join("/");
  for (const [copy, origin] of Object.entries(manifest.ibusWeb?.copiedFrom ?? {})) {
    if (packed.startsWith(`${copy}/`)) return resolve(packageDir, origin, packed.slice(copy.length + 1));
  }
  return file;
}

/** Every original file the package's packed scripts were built from, as real absolute paths. */
export async function bundledSources(packageDir: string, manifest: PackageManifest): Promise<Bundled> {
  const sources = new Set<string>();
  const problems: string[] = [];
  const followed = new Set<string>();

  const follow = async (mapPath: string): Promise<void> => {
    if (followed.has(mapPath)) return;
    followed.add(mapPath);
    const map = JSON.parse(await readFile(mapPath, "utf8")) as SourceMap;
    const base = resolve(dirname(mapPath), map.sourceRoot ?? "");
    for (const source of map.sources) {
      if (source === null || isVirtual(source)) continue;
      const path = source.startsWith("file:") ? fileURLToPath(source) : resolve(base, source);
      const real = existsSync(path) ? await realpath(path) : path;
      if (SCRIPT.test(real) && !inNodeModules(real) && existsSync(`${real}.map`)) await follow(`${real}.map`);
      else sources.add(real);
    }
  };

  for (const file of await packedFiles(packageDir, manifest)) {
    if (!SCRIPT.test(file)) continue;
    const map = `${builtAt(packageDir, manifest, file)}.map`;
    if (existsSync(map)) await follow(map);
    else problems.push(`${relative(packageDir, file).split(sep).join("/")} has no sourcemap`);
  }
  return { sources, problems };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `nix develop -c sh -c 'cd tools/pack-licenses && pnpm test'`

Expected: PASS, 10 tests.

- [ ] **Step 6: Run the task gate and commit**

Run the four Global Constraints commands.

```bash
nix develop -c git add tools/pack-licenses/sources.ts tools/pack-licenses/sources.test.ts tools/pack-licenses/dependency.ts
nix develop -c git commit -m "feat(pack-licenses): find what a package bundles from its sourcemaps" -- tools/pack-licenses/sources.ts tools/pack-licenses/sources.test.ts tools/pack-licenses/dependency.ts
```

### Task E4: `tools/pack-licenses`: plan, prepack, postpack and the CLI

**Files:**

- Create: `tools/pack-licenses/notices.ts`, `tools/pack-licenses/plan.ts`, `tools/pack-licenses/pack.ts`, `tools/pack-licenses/cli.ts`
- Create: `tools/pack-licenses/plan.test.ts`, `tools/pack-licenses/pack.test.ts`, `tools/pack-licenses/cli.test.ts`

**Interfaces:**

- Consumes:
  - `bundledSources` and `PackageManifest` (Task E3)
  - `dependencyOf` and `licenseFiles` (Task E3)
  - `licenseOf` and `parseReuseToml` (Task E2)
  - `licenseIds` (Task E2)
- Produces:
  - `NOTICES: Readonly<Record<string, readonly string[]>>`
  - `interface Copy { readonly from: string; readonly to: string }`
  - `interface Plan { readonly copies: readonly Copy[]; readonly problems: readonly string[] }`
  - `planLicenses(root: string, packageDir: string, notices?: Readonly<Record<string, readonly string[]>>): Promise<Plan>`
  - `class LicenseError extends Error { readonly problems: readonly string[] }`
  - `prepack(packageDir: string, plan: Plan): Promise<void>`
  - `postpack(packageDir: string): Promise<void>`
  - `MANIFEST = ".pack-licenses.json"`
  - The CLI is `node tools/pack-licenses/cli.ts prepack|postpack|check [package directory]`. `check` exits 1 and prints each problem to stderr; otherwise it prints `to <- from` lines.

- [ ] **Step 1: Write the failing tests**

`tools/pack-licenses/plan.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { KEY, cleanUp, makeTree, own, sourceMap } from "./fixture.ts";
import { planLicenses } from "./plan.ts";

afterEach(cleanUp);

const dep = "node_modules/.pnpm/dep@1.0.0/node_modules/dep";

const repository = (extra: Readonly<Record<string, string>> = {}) =>
  makeTree({
    "REUSE.toml": `version = 1
[[annotations]]
path = "packages/p/src/table.ts"
${KEY} = "MIT-open-group AND HPND"
precedence = "override"
`,
    "LICENSE-MIT": "mit",
    "LICENSE-APACHE": "apache",
    "LICENSES/MIT-open-group.txt": "",
    "LICENSES/HPND.txt": "",
    "NOTICES/keysymdef.txt": "",
    "packages/p/package.json": JSON.stringify({ name: "p", files: ["dist"] }),
    "packages/p/src/a.ts": own(),
    "packages/p/src/table.ts": "",
    "packages/p/dist/index.js": "",
    [`${dep}/index.js`]: "",
    [`${dep}/LICENSE`]: "",
    ...extra,
  });

const tos = (plan: { copies: readonly { to: string }[] }) => plan.copies.map((copy) => copy.to);

test("code under the repository's own license needs only its two license files", async () => {
  const root = await repository({ "packages/p/dist/index.js.map": sourceMap("../src/a.ts") });
  const plan = await planLicenses(root, join(root, "packages/p"), {});
  expect(plan.problems).toEqual([]);
  expect(tos(plan)).toEqual(["LICENSE-APACHE", "LICENSE-MIT"]);
  expect(plan.copies[1]?.from).toBe(join(root, "LICENSE-MIT"));
});

test("third-party repository files bring their license texts and notices", async () => {
  const root = await repository({ "packages/p/dist/index.js.map": sourceMap("../src/a.ts", "../src/table.ts") });
  const plan = await planLicenses(root, join(root, "packages/p"), {
    "packages/p/src/table.ts": ["NOTICES/keysymdef.txt"],
  });
  expect(plan.problems).toEqual([]);
  expect(tos(plan)).toEqual([
    "LICENSE-APACHE",
    "LICENSE-MIT",
    "LICENSES/HPND.txt",
    "LICENSES/MIT-open-group.txt",
    "LICENSES/keysymdef-notice.txt",
  ]);
});

test("a bundled dependency brings its own license files", async () => {
  const root = await repository({ "packages/p/dist/index.js.map": sourceMap(`../../../${dep}/index.js`) });
  const plan = await planLicenses(root, join(root, "packages/p"), {});
  expect(plan.problems).toEqual([]);
  expect(tos(plan)).toContain("LICENSES/dep/LICENSE");
});

test("whatever can't be accounted for is a problem", async () => {
  const root = await repository({
    "packages/p/dist/index.js.map": sourceMap("../src/bare.ts", "../src/gone.ts", "../src/gpl.ts", "../../../node_modules/nolicense/index.js"),
    "packages/p/src/bare.ts": "export {};\n",
    "packages/p/src/gpl.ts": `// ${KEY}: GPL-2.0-or-later\n`,
    "node_modules/nolicense/index.js": "",
  });
  const plan = await planLicenses(root, join(root, "packages/p"), { "packages/p/src/x.ts": ["NOTICES/x.txt"] });
  expect([...plan.problems].sort()).toEqual(
    [
      "notice map names packages/p/src/x.ts, which doesn't exist",
      "notice map names NOTICES/x.txt, which doesn't exist",
      "packages/p/src/bare.ts has no license",
      "packages/p/src/gone.ts is bundled but missing",
      "packages/p/src/gpl.ts is GPL-2.0-or-later, but LICENSES/GPL-2.0-or-later.txt is missing",
      "nolicense has no license file",
    ].sort(),
  );
});
```

`tools/pack-licenses/pack.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { cleanUp, makeTree } from "./fixture.ts";
import { LicenseError, MANIFEST, postpack, prepack } from "./pack.ts";

afterEach(cleanUp);

const setUp = async () => {
  const root = await makeTree({
    "LICENSE-MIT": "mit",
    "LICENSES/HPND.txt": "hpnd",
    "p/dist/index.js": "",
    "p/LICENSES/keep.txt": "keep",
  });
  const packageDir = join(root, "p");
  const plan = {
    copies: [
      { from: join(root, "LICENSE-MIT"), to: "LICENSE-MIT" },
      { from: join(root, "LICENSES/HPND.txt"), to: "LICENSES/HPND.txt" },
      { from: join(root, "LICENSES/HPND.txt"), to: "LICENSES/dep/LICENSE" },
    ],
    problems: [],
  };
  return { packageDir, plan };
};

test("prepack copies what the plan says and postpack removes exactly that", async () => {
  const { packageDir, plan } = await setUp();
  await prepack(packageDir, plan);
  expect(await readFile(join(packageDir, "LICENSES/dep/LICENSE"), "utf8")).toBe("hpnd");
  expect(JSON.parse(await readFile(join(packageDir, MANIFEST), "utf8"))).toEqual([
    "LICENSE-MIT",
    "LICENSES/HPND.txt",
    "LICENSES/dep/LICENSE",
  ]);
  await postpack(packageDir);
  expect(existsSync(join(packageDir, "LICENSE-MIT"))).toBe(false);
  expect(existsSync(join(packageDir, "LICENSES/dep"))).toBe(false);
  expect(existsSync(join(packageDir, MANIFEST))).toBe(false);
  expect(await readFile(join(packageDir, "LICENSES/keep.txt"), "utf8")).toBe("keep");
  expect(existsSync(join(packageDir, "dist/index.js"))).toBe(true);
});

test("prepack after an interrupted pack starts over", async () => {
  const { packageDir, plan } = await setUp();
  await prepack(packageDir, plan);
  await prepack(packageDir, plan);
  await postpack(packageDir);
  expect(existsSync(join(packageDir, "LICENSE-MIT"))).toBe(false);
});

test("prepack won't overwrite a file it didn't write", async () => {
  const { packageDir, plan } = await setUp();
  await writeFile(join(packageDir, "LICENSE-MIT"), "hand-written");
  await expect(prepack(packageDir, plan)).rejects.toThrow(/LICENSE-MIT/);
  expect(await readFile(join(packageDir, "LICENSE-MIT"), "utf8")).toBe("hand-written");
});

test("prepack refuses a plan with problems", async () => {
  const { packageDir, plan } = await setUp();
  await expect(prepack(packageDir, { ...plan, problems: ["x has no license"] })).rejects.toBeInstanceOf(LicenseError);
  expect(existsSync(join(packageDir, MANIFEST))).toBe(false);
});

test("postpack without a manifest does nothing", async () => {
  const { packageDir } = await setUp();
  await postpack(packageDir);
  expect(existsSync(join(packageDir, "LICENSES/keep.txt"))).toBe(true);
});
```

`tools/pack-licenses/cli.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { cleanUp, makeTree, own, sourceMap } from "./fixture.ts";

afterEach(cleanUp);

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

const repository = (source: string) =>
  makeTree({
    "REUSE.toml": "version = 1\n",
    "LICENSE-MIT": "",
    "LICENSE-APACHE": "",
    "packages/p/package.json": JSON.stringify({ name: "p", files: ["dist"] }),
    "packages/p/src/a.ts": source,
    "packages/p/dist/index.js": "",
    "packages/p/dist/index.js.map": sourceMap("../src/a.ts"),
  });

test("check lists the copies for a package it can account for", async () => {
  const root = await repository(own());
  const result = run("check", join(root, "packages/p"));
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("LICENSE-MIT <- ");
});

test("check fails and names what it can't account for", async () => {
  const root = await repository("export {};\n");
  const result = run("check", join(root, "packages/p"));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("packages/p/src/a.ts has no license");
});

test("an unknown command is a usage error", () => {
  expect(run("publish").status).toBe(2);
});
```

`cli.ts` checks only the notice-map entries whose source file exists in the tree it runs on, so these fixture trees don't trip over the real map's paths. Task E5's check runs on the real tree and asserts that core's plan copies both notices.

- [ ] **Step 2: Run the tests to see them fail**

Run: `nix develop -c sh -c 'cd tools/pack-licenses && pnpm test'`

Expected: FAIL, because `./plan.ts`, `./pack.ts` and `./cli.ts` don't exist.

- [ ] **Step 3: Implement `notices.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * Notices a bundled repository file brings with it, beyond its license texts:
 * the copyright lines its permissive licenses require to travel with the code.
 */
export const NOTICES: Readonly<Record<string, readonly string[]>> = {
  "packages/core/src/keys/keysyms.generated.ts": ["NOTICES/keysymdef.txt"],
  "packages/core/src/keys/dom-codes.generated.ts": ["NOTICES/chromium.txt"],
};
```

- [ ] **Step 4: Implement `plan.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { dependencyOf, licenseFiles } from "./dependency.ts";
import { NOTICES } from "./notices.ts";
import { licenseOf, parseReuseToml } from "./reuse.ts";
import { bundledSources, type PackageManifest } from "./sources.ts";
import { licenseIds } from "./spdx.ts";

export interface Copy {
  readonly from: string;
  readonly to: string;
}

export interface Plan {
  readonly copies: readonly Copy[];
  readonly problems: readonly string[];
}

// The repository's own license, which LICENSE-MIT and LICENSE-APACHE carry.
const OWN = "MIT OR Apache-2.0";

/** What a package's tarball needs copied in, by path in the package, and what it can't account for. */
export async function planLicenses(
  root: string,
  packageDir: string,
  notices: Readonly<Record<string, readonly string[]>> = NOTICES,
): Promise<Plan> {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as PackageManifest;
  const annotations = parseReuseToml(await readFile(join(root, "REUSE.toml"), "utf8"));
  const bundled = await bundledSources(packageDir, manifest);
  const problems = new Set(bundled.problems);
  const copies = new Map<string, string>([
    ["LICENSE-MIT", join(root, "LICENSE-MIT")],
    ["LICENSE-APACHE", join(root, "LICENSE-APACHE")],
  ]);

  for (const [source, files] of Object.entries(notices)) {
    for (const path of [source, ...files]) {
      if (!existsSync(join(root, path))) problems.add(`notice map names ${path}, which doesn't exist`);
    }
  }

  const seenDependencies = new Set<string>();
  for (const source of [...bundled.sources].sort()) {
    const dependency = dependencyOf(source);
    if (dependency !== undefined) {
      if (seenDependencies.has(dependency.dir)) continue;
      seenDependencies.add(dependency.dir);
      const files = await licenseFiles(dependency.dir);
      if (files.length === 0) problems.add(`${dependency.name} has no license file`);
      for (const file of files) copies.set(`LICENSES/${dependency.name}/${file}`, join(dependency.dir, file));
      continue;
    }
    const path = relative(root, source).split(sep).join("/");
    if (path.startsWith("../") || isAbsolute(path)) {
      problems.add(`${source} is outside the repository`);
      continue;
    }
    if (!existsSync(source)) {
      problems.add(`${path} is bundled but missing`);
      continue;
    }
    const expression = await licenseOf(root, source, annotations);
    if (expression === undefined) {
      problems.add(`${path} has no license`);
      continue;
    }
    if (expression !== OWN) {
      for (const id of licenseIds(expression)) {
        const text = `LICENSES/${id}.txt`;
        if (existsSync(join(root, text))) copies.set(text, join(root, text));
        else problems.add(`${path} is ${expression}, but ${text} is missing`);
      }
    }
    for (const notice of notices[path] ?? []) {
      copies.set(`LICENSES/${basename(notice, ".txt")}-notice.txt`, join(root, notice));
    }
  }

  return {
    copies: [...copies].map(([to, from]) => ({ from, to })).sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0)),
    problems: [...problems],
  };
}
```

Copies sort by code unit (`<`), not `localeCompare`, so uppercase names come before lowercase ones as the plan test expects.

- [ ] **Step 5: Implement `pack.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Plan } from "./plan.ts";

/** Lists, in the package directory, the files prepack wrote, for postpack to remove. */
export const MANIFEST = ".pack-licenses.json";

export class LicenseError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

export async function prepack(packageDir: string, plan: Plan): Promise<void> {
  if (plan.problems.length > 0) throw new LicenseError(plan.problems);
  // An interrupted pack leaves its copies and manifest behind.
  await postpack(packageDir);
  for (const { to } of plan.copies) {
    if (existsSync(join(packageDir, to))) throw new Error(`${to} exists, and pack-licenses didn't write it`);
  }
  for (const { from, to } of plan.copies) {
    await mkdir(dirname(join(packageDir, to)), { recursive: true });
    await copyFile(from, join(packageDir, to));
  }
  await writeFile(join(packageDir, MANIFEST), `${JSON.stringify(plan.copies.map(({ to }) => to), null, 2)}\n`);
}

export async function postpack(packageDir: string): Promise<void> {
  const manifest = join(packageDir, MANIFEST);
  if (!existsSync(manifest)) return;
  const written = JSON.parse(await readFile(manifest, "utf8")) as readonly string[];
  const dirs = new Set<string>();
  for (const path of written) {
    await rm(join(packageDir, path), { force: true });
    for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) dirs.add(dir);
  }
  // Deepest first, so each is empty by the time it is reached unless
  // something else lives there.
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    await rmdir(join(packageDir, dir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
    });
  }
  await rm(manifest);
}
```

- [ ] **Step 6: Implement `cli.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Copies the license texts a package's bundle needs into it while npm packs
// it, and removes them afterwards:
//
//   node cli.ts prepack|postpack|check [package directory]
//
// check prints what prepack would copy, and fails on any bundled file whose
// license it can't find.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NOTICES } from "./notices.ts";
import { LicenseError, postpack, prepack } from "./pack.ts";
import { planLicenses } from "./plan.ts";

function repositoryRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "REUSE.toml"))) return dir;
    if (dirname(dir) === dir) throw new Error(`no REUSE.toml in ${from} or above it`);
  }
}

// The map's entries for files this repository has: a notice missing for a
// file that exists is a problem, but a tree without the file isn't one the
// map is about.
const presentNotices = (root: string) =>
  Object.fromEntries(Object.entries(NOTICES).filter(([source]) => existsSync(join(root, source))));

const plan = (packageDir: string) => {
  const root = repositoryRoot(packageDir);
  return planLicenses(root, packageDir, presentNotices(root));
};

const [command, directory = "."] = process.argv.slice(2);
const packageDir = resolve(directory);

try {
  switch (command) {
    case "prepack":
      await prepack(packageDir, await plan(packageDir));
      break;
    case "postpack":
      await postpack(packageDir);
      break;
    case "check": {
      const { copies, problems } = await plan(packageDir);
      if (problems.length > 0) throw new LicenseError(problems);
      for (const { from, to } of copies) console.log(`${to} <- ${from}`);
      break;
    }
    default:
      console.error("usage: node cli.ts prepack|postpack|check [package directory]");
      process.exitCode = 2;
  }
} catch (error) {
  if (!(error instanceof LicenseError)) throw error;
  for (const problem of error.problems) console.error(`pack-licenses: ${packageDir}: ${problem}`);
  process.exitCode = 1;
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `nix develop -c sh -c 'cd tools/pack-licenses && pnpm test'`

Expected: PASS, 22 tests: 5 reuse, 5 sources, 4 plan, 5 pack, 3 cli.


- [ ] **Step 8: Run the task gate and commit**

Run the four Global Constraints commands.

```bash
nix develop -c git add tools/pack-licenses
nix develop -c git commit -m "feat(pack-licenses): copy a package's licenses in for packing and out after" -- tools/pack-licenses
```

### Task E5: Pack every published package with `pack-licenses`

**Files:**

- Modify: `packages/{protocol,core,panel,ibus-web}/tsdown.config.ts`. worker-host already writes sourcemaps.
- Modify: `packages/{protocol,worker-host,core,panel,ibus-web}/package.json`
- Delete: `packages/worker-host/.gitignore`
- Modify: `.gitignore`
- Modify: `modules/typescript/workspace.nix`, and wherever Phase C put core's notice inputs
- Modify: `modules/typescript/checks.nix`
- Modify: `tools/pack-licenses/checks.nix`
- Modify: `docs/tooling.md`, `docs/core.md`, `docs/ibus-web.md`

**Interfaces:**

- Consumes:
  - `node tools/pack-licenses/cli.ts check <dir>` (Task E4)
  - `problemsOf` in `modules/typescript/checks.nix` (Task E1)
- Produces:
  - `checks.tools-pack-licenses-packages`
  - The field `"ibusWeb": { "copiedFrom": { "dist/host": "../worker-host/dist/worker" } }` in ibus-web's `package.json`.

- [ ] **Step 1: Extend the metadata check so it fails**

In `modules/typescript/checks.nix`, add these lines to `problemsOf`'s list, after the keywords line:

```nix
          ++ lib.optional (
            (manifest.scripts.prepack or null) != "node ../../tools/pack-licenses/cli.ts prepack"
            || (manifest.scripts.postpack or null) != "node ../../tools/pack-licenses/cli.ts postpack"
          ) "doesn't pack its licenses with tools/pack-licenses"
          ++ lib.optional (!(lib.elem "LICENSES" (manifest.files or [ ]))) "doesn't pack LICENSES/"
```

Run: `nix build .#checks.x86_64-linux.typescript-package-metadata -L`

Expected: FAIL. It reports `doesn't pack its licenses with tools/pack-licenses` for all five packages, and `doesn't pack LICENSES/` for every package except core.

- [ ] **Step 2: Add the licence check over the built packages, and see it fail**

Append to `tools/pack-licenses/checks.nix`'s `let`:

```nix
      published = [
        "packages/protocol"
        "packages/worker-host"
        "packages/core"
        "packages/panel"
        "packages/ibus-web"
      ];
      built = typescript.workspaceFor (published ++ [ "tools/pack-licenses" ]);
```

and to its attribute set:

```nix
      # Every published package's bundle, accounted for as prepack would.
      # Core's key tables must bring their notices.
      checks.tools-pack-licenses-packages =
        pkgs.runCommand "ibus-web-tools-pack-licenses-packages"
          { nativeBuildInputs = [ typescript.nodejs ]; }
          ''
            mkdir $out
            cd ${built}
            for dir in ${lib.escapeShellArgs published}; do
              node tools/pack-licenses/cli.ts check "$dir" > "$out/$(basename "$dir").txt"
            done
            grep -q '^LICENSES/keysymdef-notice.txt ' $out/core.txt
            grep -q '^LICENSES/chromium-notice.txt ' $out/core.txt
          '';
```

Change the module's arguments to `{ config, lib, pkgs, ... }`.

Run: `nix build .#checks.x86_64-linux.tools-pack-licenses-packages -L`

Expected: FAIL. Either `REUSE.toml` is missing from the built workspace (`no REUSE.toml in …`), or `dist/index.js has no sourcemap` for protocol.

- [ ] **Step 3: Put the licence inputs in every workspace build**

In `modules/typescript/workspace.nix`, inside the workspace build function, find the line `++ map packageSources selectedDirs` in `fileset = lib.fileset.unions (…)`. Add `++ licenseInputs` after it, and add this binding to the file's `let`:

```nix
      # pack-licenses reads these beside every package it checks, and core's
      # tests read the notices; they are small and rarely change.
      licenseInputs = [
        (root + "/REUSE.toml")
        (root + "/LICENSE-MIT")
        (root + "/LICENSE-APACHE")
        (root + "/LICENSES")
        (root + "/NOTICES")
      ];
```

In the same function's `installPhase`, after the line copying `package.json pnpm-workspace.yaml … node_modules $out/`, add:

```nix
            cp -R REUSE.toml LICENSE-MIT LICENSE-APACHE LICENSES NOTICES $out/
```

Then remove the per-package notice inputs this replaces:

- Run `git grep -n -e noticeInputs -e coreNoticeInputs -e '"LICENSES/MIT-open-group.txt"' -- '*.nix'`.
- Delete the list, its `optionals` and the `cp` loop it feeds, wherever Phase C left them (`modules/typescript/workspace.nix` or `tools/keysyms/module.nix`).

- [ ] **Step 4: Turn on sourcemaps**

Add `sourcemap: true,` to every config object passed to `defineConfig` in:

- `packages/protocol/tsdown.config.ts` (one object)
- `packages/core/tsdown.config.ts` (two objects)
- `packages/panel/tsdown.config.ts` (one)
- `packages/ibus-web/tsdown.config.ts` (one)

For example, core's file becomes:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { defineConfig } from "tsdown";
export default defineConfig([
  {
    entry: { "shared/index": "src/shared/index.ts" },
    platform: "neutral",
    sourcemap: true,
    dts: { generator: "tsgo" },
    deps: { neverBundle: ["effect", /^effect\//, /^@ibus-web\//] },
    tsconfig: "tsconfig.shared.json",
  },
  {
    entry: { "page/index": "src/page/index.ts" },
    platform: "browser",
    sourcemap: true,
    dts: { generator: "tsgo" },
    deps: { neverBundle: ["effect", /^effect\//, /^@ibus-web\//] },
    tsconfig: "tsconfig.page.json",
  },
]);
```

Keep whatever `tsconfig` paths Phase A set; only `sourcemap` is new.

- [ ] **Step 5: Switch the packages' scripts and files**

In each of the five `package.json` files:

- Set `"prepack": "node ../../tools/pack-licenses/cli.ts prepack"` and `"postpack": "node ../../tools/pack-licenses/cli.ts postpack"`.
- Make `files` contain `"LICENSES"` next to `"LICENSE-MIT"` and `"LICENSE-APACHE"`. Core already has it.

In `packages/ibus-web/package.json`, add, after `"publishConfig"`:

```json
  "ibusWeb": {
    "copiedFrom": { "dist/host": "../worker-host/dist/worker" }
  },
```

Delete worker-host's ignore file, which the root ignore rules replace: `git rm packages/worker-host/.gitignore`.

Append to the root `.gitignore`:

```gitignore
# Copied into a package by tools/pack-licenses while it is packed.
/packages/*/LICENSE-MIT
/packages/*/LICENSE-APACHE
/packages/*/LICENSES/
/packages/*/.pack-licenses.json
```

- [ ] **Step 6: Run both checks to see them pass**

Run: `nix build .#checks.x86_64-linux.typescript-package-metadata .#checks.x86_64-linux.tools-pack-licenses-packages -L && cat result-1/*.txt`

Expected: PASS. The listing should show:

- worker-host: `LICENSES/brotli-dec-wasm/LICENSE-Apache.txt`, `LICENSES/brotli-dec-wasm/LICENSE-MIT.txt` and `LICENSES/effect/LICENSE`.
- ibus-web: the same three.
- core:
  - `LICENSES/BSD-3-Clause.txt`
  - `LICENSES/HPND.txt`
  - `LICENSES/LicenseRef-xkeyboard-config.txt`
  - `LICENSES/MIT-open-group.txt`
  - `LICENSES/chromium-notice.txt`
  - `LICENSES/keysymdef-notice.txt`
- protocol and panel: only `LICENSE-APACHE` and `LICENSE-MIT`.

If a dependency's licence file name differs from these, the listing is still right as long as it names one; the check fails only when there is none.

- [ ] **Step 7: Pack a real tarball and inspect it**

Run:

```sh
nix develop -c sh -c '
  pnpm install && pnpm -r --filter "./packages/*" run build &&
  out=$(mktemp -d) &&
  pnpm --dir packages/ibus-web pack --pack-destination "$out" &&
  tar tzf "$out"/ibus-web-0.0.0.tgz | grep -E "LICENSE" &&
  git status --short packages
'
```

Expected:

- The tarball lists `package/LICENSE-MIT`, `package/LICENSE-APACHE`, `package/LICENSES/effect/LICENSE` and both `package/LICENSES/brotli-dec-wasm/…` files.
- `git status --short packages` prints nothing, because postpack removed the copies.

If pnpm doesn't run `postpack`, `git status` shows them as ignored-only. Confirm with `ls packages/ibus-web` that no `LICENSES/` remains.

- [ ] **Step 8: Document it**

In `docs/tooling.md`, after the `### tsdown` subsection, add:

```markdown
### Licenses in packed packages

A published package's tarball carries the license of everything bundled into it. Every published
package's tsdown config writes sourcemaps, and its `prepack` and `postpack` scripts run
`tools/pack-licenses`:

- **`prepack`** reads the sources of every sourcemap beside the package's packed scripts.
  - It follows a source that is itself a built script with a map. A bundle of another workspace
    package's `dist/` therefore leads back to that package's sources.
  - It reads a copied directory's maps where they were built. ibus-web's `dist/host/` is declared
    with `ibusWeb.copiedFrom` in its `package.json`.
  - For each repository file it finds, it takes the SPDX license REUSE gives it, from the file's
    header or a `REUSE.toml` annotation. If that isn't the repository's own `MIT OR Apache-2.0`,
    it copies `LICENSES/<id>.txt`.
  - For each file from `node_modules`, it copies that dependency's own license files to
    `LICENSES/<package>/`.
  - It adds the `NOTICES/` files that the map in `tools/pack-licenses/notices.ts` ties to a
    bundled file, and always adds `LICENSE-MIT` and `LICENSE-APACHE`.
  - It records what it wrote in `.pack-licenses.json`.
- **`postpack`** deletes exactly those files.
- **`check`** (`node tools/pack-licenses/cli.ts check <package>`) prints what `prepack` would copy.
  It fails on any bundled file whose license it can't find, and on any packed script without a
  sourcemap. `checks.tools-pack-licenses-packages` runs it on every published package, so a newly
  bundled dependency without a license file fails CI.

No package keeps a `LICENSES/` directory in the tree; the root `.gitignore` ignores the copies.
```

In `docs/core.md`, replace these lines:

```markdown
Canonical license texts and notices live in root `LICENSES/` and `NOTICES/`;
`prepack` copies the required texts/notices into the package and `postpack`
removes those generated copies. Keep upstream notices intact when regenerating.
```

with:

```markdown
Canonical license texts and notices live in root `LICENSES/` and `NOTICES/`.
`prepack` runs `tools/pack-licenses`, which copies the texts and notices the
bundle needs into the package's `LICENSES/`
([tooling.md](tooling.md#licenses-in-packed-packages)); `postpack` removes them.
Keep upstream notices intact when regenerating.
```

In `docs/ibus-web.md`, replace:

```markdown
come from the pinned X11, Chromium and xkeyboard-config sources. Inspect the
published packages' `LICENSES/` and `NOTICES/`, engine source bundle and
```

with:

```markdown
come from the pinned X11, Chromium and xkeyboard-config sources. Inspect each
published package's `LICENSES/` (license texts, notices and bundled
dependencies' licenses), the engine source bundle and
```

Format the three files with `nix develop -c oxfmt docs/tooling.md docs/core.md docs/ibus-web.md`. Then check that no doc still names core's old notice file names:

```sh
git grep -n -e xkeyboard-config-COPYING -e 'cp ../../LICENSE' -- '*.md'
```

Expected: no output. Fix any hit to the new names: `LICENSES/LicenseRef-xkeyboard-config.txt`, or the `tools/pack-licenses` scripts.

- [ ] **Step 9: Run the task gate and commit**

Run the four Global Constraints commands.

```bash
nix develop -c git add packages/protocol/tsdown.config.ts packages/core/tsdown.config.ts packages/panel/tsdown.config.ts packages/ibus-web/tsdown.config.ts packages/protocol/package.json packages/worker-host/package.json packages/core/package.json packages/panel/package.json packages/ibus-web/package.json .gitignore modules/typescript/workspace.nix modules/typescript/checks.nix tools/pack-licenses/checks.nix docs/tooling.md docs/core.md docs/ibus-web.md
nix develop -c git commit -m "feat(packages): pack each package's licenses from what it bundles" -- packages/protocol/tsdown.config.ts packages/core/tsdown.config.ts packages/panel/tsdown.config.ts packages/ibus-web/tsdown.config.ts packages/protocol/package.json packages/worker-host/package.json packages/core/package.json packages/panel/package.json packages/ibus-web/package.json packages/worker-host/.gitignore .gitignore modules/typescript/workspace.nix modules/typescript/checks.nix tools/pack-licenses/checks.nix docs/tooling.md docs/core.md docs/ibus-web.md
```

If Step 3 edited `tools/keysyms/module.nix`, add it to both path lists.

## Phase F: Repository hygiene, front door, documentation

Phase F assumes Phases A–E have landed. It writes the docs against the tree as it stands then. Before each docs step, check the claim being written against the code: `git grep`, `ls`, or `nix eval` as the step shows. Where a step names something from an earlier phase that turns out different, write what the tree has.

### Task F1: Ignore rules, EditorConfig and CI permissions

**Files:**

- Modify: `.gitignore`, `.editorconfig`
- Modify: `modules/flake/ci.nix`
- Regenerate: `.github/workflows/ci.yml`

**Interfaces:**

- Produces: workflow-level `permissions: { contents: read }`, and per-job `permissions: { contents: read, id-token: write }` on `check`, `integration` and `publish`. The publish step's `visibility` follows the repository's.

- [ ] **Step 1: Ignore what only this machine ignores today**

Append to `.gitignore`:

```gitignore
# Local agent and review output.
.artifacts/
.claude/settings.local.json
```

Run: `git check-ignore -v .artifacts/x .claude/settings.local.json`

Expected: both are matched by `.gitignore` lines, not by `.git/info/exclude` or a global file.

- [ ] **Step 2: Give EditorConfig a default section**

Replace `.editorconfig` with:

```editorconfig
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

root = true

# What the formatters already produce, for editors that don't run them.
[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.sh]
indent_style = space
indent_size = 2

[{Makefile,Makefile.*,*.mk}]
indent_style = tab

# A patch's context lines must stay byte for byte, trailing spaces included.
[*.{patch,diff}]
trim_trailing_whitespace = false

# Two trailing spaces are a Markdown line break.
[*.md]
trim_trailing_whitespace = false

# Vendored IBus sources keep upstream's formatting.
[runtime/libibus-web/{include/ibus-1.0,src/ibus}/**]
indent_style = unset
indent_size = unset
trim_trailing_whitespace = unset
```

Run: `nix develop -c hk check --all`

Expected: PASS with no formatter changes. oxfmt and shfmt read `.editorconfig`; two-space indentation and LF are already their settings, so nothing reformats. If oxfmt reports changes, the `[*]` section disagrees with `.oxfmtrc.jsonc`. Remove the key that differs from `[*]` rather than reformatting the tree.

- [ ] **Step 3: Scope `id-token` to the jobs, and make visibility follow the repository**

In `modules/flake/ci.nix`, replace the `permissions` binding and its comment with:

```nix
      # Each job sets its own: Determinate Nix and FlakeHub authenticate with
      # the job's OIDC token, which a job that doesn't use them shouldn't get.
      permissions = {
        contents = "read";
      };
      flakehubPermissions = {
        contents = "read";
        id-token = "write";
      };
```

In `checkJob`'s attribute set, after `timeoutMinutes = 240;`, add `permissions = flakehubPermissions;`. In `jobs.publish`, after `timeoutMinutes = 30;`, add `permissions = flakehubPermissions;`.

Replace the comment above `jobs.publish` with:

```nix
          # FlakeHub Cache grants access per published flake, so the cache
          # needs this one published; only a master that passed its checks is.
```

Replace `visibility = "private";` with:

```nix
                  # The flake is as visible as the repository: private while
                  # it is, listed once it is public.
                  visibility = "\${{ github.event.repository.private && 'private' || 'public' }}";
```

- [ ] **Step 4: Regenerate and inspect the workflow**

Run: `nix run .#write-files && git diff .github/workflows/ci.yml`

Expected:

- The top-level `permissions` has only `contents: read`.
- Each of `check`, `integration` and `publish` has `permissions` with `contents: read` and `id-token: write`.
- `visibility: ${{ github.event.repository.private && 'private' || 'public' }}`.

Then run `nix develop -c hk check -S actionlint`. Expected: PASS.

- [ ] **Step 5: Update the CI docs' permissions sentence**

In `docs/tooling.md`, in "### What it does", replace:

```markdown
`ci.yml` runs on pull requests and on pushes to `master`, with `contents: read` and
`id-token: write` (Determinate Nix and FlakeHub Cache authenticate with the job's OIDC token). A
```

with:

```markdown
`ci.yml` runs on pull requests and on pushes to `master`. The workflow grants `contents: read`;
each job adds `id-token: write`, since Determinate Nix and FlakeHub authenticate with the job's
OIDC token. A
```

Task F4 rewrites the rest of this section.

- [ ] **Step 6: Run the task gate and commit**

Run the four Global Constraints commands.

```bash
nix develop -c git add .gitignore .editorconfig modules/flake/ci.nix .github/workflows/ci.yml docs/tooling.md
nix develop -c git commit -m "ci: grant OIDC per job and publish as visibly as the repository" -- .gitignore .editorconfig modules/flake/ci.nix .github/workflows/ci.yml docs/tooling.md
```

### Task F2: Dead branches and the table-engine archive

This task changes shared state on `origin`, which can't be undone from here. **Stop and get the user's explicit confirmation before Step 4.** Everything before that is local and reversible.

**Files:** none. This task only touches refs and the worktree.

**Interfaces:**

- Produces: the tag `archive/table-engine` at `codex/table-engine`'s tip. The branches `backup/master-before-ci-squash`, `fix/ci-integration-verified`, `fix/ci-test-scheduling` and `codex/table-engine` are gone locally, and `.worktrees/table-engine` is removed.

- [ ] **Step 1: Record what will go**

Run:

```sh
for b in backup/master-before-ci-squash fix/ci-integration-verified fix/ci-test-scheduling codex/table-engine; do
  echo "== $b $(git rev-parse --short "$b") ahead of master by $(git rev-list --count master.."$b")"
done
git ls-remote --heads --tags origin
git -C .worktrees/table-engine status --short
```

Expected:

- Four branch lines.
- The remote lists `master` and `fix/ci-test-scheduling` among its heads, and no `archive/` tag.
- The worktree status is empty.

If the worktree has uncommitted changes, stop and ask the user what to do with them. Don't remove it.

- [ ] **Step 2: Tag the table-engine branch**

Run: `git tag -a archive/table-engine codex/table-engine -m "Reference for a second attempt at the table engine; not to be merged."`

Then: `git rev-parse archive/table-engine^{commit} codex/table-engine`

Expected: two identical hashes.

- [ ] **Step 3: Remove the worktree and the local branches**

Run:

```sh
git worktree remove .worktrees/table-engine
git branch -D codex/table-engine backup/master-before-ci-squash fix/ci-integration-verified fix/ci-test-scheduling
git worktree prune && git worktree list && git branch
```

Expected: one worktree (the main checkout). The branches are `master` and `typedrat/repo-organization`, plus any the user made since.

- [ ] **Step 4: Confirm with the user, then update `origin`**

Show the user this and wait for an explicit yes:

> About to run, against `origin` (synapdeck/ibus-web):
>
> - `git push origin archive/table-engine`, which publishes the table-engine reference as a tag.
> - `git push origin --delete fix/ci-test-scheduling`, which deletes the merged PR #1 branch.
>
> OK to run both? Or neither, or only one?

Run only what the user approves:

```sh
git push origin archive/table-engine
git push origin --delete fix/ci-test-scheduling
git ls-remote --heads --tags origin
```

Expected: `refs/tags/archive/table-engine` is present and `refs/heads/fix/ci-test-scheduling` is absent. If the user declines the tag push, the tag stays local only; tell them it then exists only on this machine.

No commit for this task.

### Task F3: Moved paths, renamed checks and the Markdown link check

**Files:**

- Modify: every tracked `*.md` that names a path or check that Phases A–E moved, renamed or removed. Exclude `docs/plans/**` and `docs/specs/2026-10-07-repo-organization.md`, which describe the moves themselves.
- Modify: `hk.pkl`, `modules/flake/hk.nix`, `docs/tooling.md`

**Interfaces:**

- Produces: the hk step `links`, which runs lychee offline over every Markdown file git tracks.

- [ ] **Step 1: Write the path sweep script**

Save this to `$TMPDIR/doc-paths.py`. It isn't committed.

```python
# Rewrites Markdown mentions of files this branch moved, and lists mentions of
# files and directories it moved or deleted that still need a hand edit.
import re
import subprocess
import sys
from pathlib import Path

SKIP = ("docs/plans/", "docs/specs/2026-10-07-repo-organization.md")


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


changes = [line.split("\t") for line in git("diff", "--name-status", "-M", "master...HEAD").splitlines()]
renamed = {c[1]: c[2] for c in changes if c[0].startswith("R")}
deleted = [c[1] for c in changes if c[0] == "D"]
gone_dirs = sorted(
    {str(parent) for old in [*renamed, *deleted] for parent in Path(old).parents if str(parent) != "." and not parent.exists()}
)
write = "--write" in sys.argv

for doc in git("ls-files", "*.md").split():
    if doc.startswith(SKIP):
        continue
    text = Path(doc).read_text()
    new = text
    for old, moved in sorted(renamed.items(), key=lambda item: -len(item[0])):
        new = re.sub(rf"(?<![\w-]){re.escape(old)}(?![\w.-])", moved, new)
    if write and new != text:
        Path(doc).write_text(new)
        print(f"rewrote {doc}")
    for number, line in enumerate(new.splitlines(), 1):
        for stale in [*deleted, *gone_dirs]:
            if re.search(rf"(?<![\w-]){re.escape(stale)}(?![\w-])", line):
                print(f"{doc}:{number}: still names {stale}")
```

- [ ] **Step 2: Rewrite moved file paths**

Run: `python3 $TMPDIR/doc-paths.py --write`

Expected:

- `rewrote …` lines for the docs that named moved files, for example `docs/tooling.md` and `docs/testing.md`.
- Then `still names …` lines.

Review the rewrites with `git diff -- '*.md'`. A rewrite inside a relative link from a doc in a subdirectory may now point at the wrong place: the link keeps its `../` prefix while the target moved elsewhere. Step 6's link check finds those; fix each to the correct relative path.

- [ ] **Step 3: Fix every remaining mention by hand**

For each `still names X` line, edit the sentence to name what replaced `X`. Find the replacement with `git log --diff-filter=D --format='%h %s' master..HEAD -- X` and the commit's diff.

Typical cases, after Phases A–C:

| Still names                                                               | Write instead                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `tsconfig.base.json`, `tsconfig.node-scripts.json`, `tsconfig.emscripten-js.json` | `@ibus-web/tsconfig`'s `base.json`, `node.json`, `emscripten-js.json` (`packages/tsconfig/`) |
| `types/`, `types/webassembly`                                             | `packages/tsconfig/types/webassembly`                                                             |
| `tools/package.json`, `tools/vitest.config.ts`                            | the tool's own `tools/<name>/package.json` or `vitest.config.ts`                                  |
| `tests/playwright`                                                        | `examples/hangul/test/e2e`                                                                        |
| `modules/libhangul`                                                       | `engines/hangul`                                                                                  |
| `runtime/options.nix`                                                     | the part's own `runtime/<part>/options.nix`                                                       |
| `modules/demo.nix`, `modules/playwright.nix`                              | `examples/hangul/module.nix`                                                                      |
| `modules/keys.nix`                                                        | `tools/keysyms/module.nix`                                                                        |
| `modules/typescript/default.nix`                                          | `modules/typescript/workspace.nix` or `files.nix`, whichever holds the thing named                |
| `modules/testing/default.nix`                                             | the `modules/testing/` file holding the thing named (`gtest.nix`, `programs.nix`, `vitest.nix`, `playwright.nix`) |
| `docs/plans/…`                                                            | drop the reference (Task F10 deletes the plans)                                                    |

Run the script again without `--write`. Expected: no `still names` lines, except mentions of `docs/plans/` that Task F10 handles.

- [ ] **Step 4: Rename checks in the docs**

List the check names that changed:

```sh
nix eval --json "git+file://$PWD?ref=master#checks.x86_64-linux" --apply builtins.attrNames > "$TMPDIR/checks-before.json"
nix eval --json ".#checks.x86_64-linux" --apply builtins.attrNames > "$TMPDIR/checks-after.json"
python3 - <<'EOF'
import json, os, subprocess
tmp = os.environ["TMPDIR"]
before = set(json.load(open(f"{tmp}/checks-before.json")))
after = set(json.load(open(f"{tmp}/checks-after.json")))
print("added:", sorted(after - before))
for name in sorted(before - after):
    hits = subprocess.run(
        ["git", "grep", "-n", "-E", rf"checks\.(x86_64-linux\.)?\"?{name}\"?\b|`{name}`", "--", "*.md",
         ":!docs/plans", ":!docs/specs/2026-10-07-repo-organization.md"],
        capture_output=True, text=True).stdout
    print(f"== {name}\n{hits}")
EOF
```

For each removed name, replace its mentions with the check that took its place. Phase C's commit messages and diffs say which renamed to which; under the `<area>-<what>` rule, a check that moved into `tools/<name>/` now starts `tools-`, and one that moved into `engines/hangul/` starts `hangul-`. Take each new name from the `added:` list, never from memory.

Rerun the snippet. Expected: every `== name` header is followed by no hits.

- [ ] **Step 5: Add the link check**

In `modules/flake/hk.nix`, add `pkgs.lychee` to `tools`, after `pkgs.actionlint`.

In `hk.pkl`, add this step to `linters`, after `["reuse"]`:

```pkl
  // Every relative link and heading anchor in the Markdown git tracks
  // resolves. It reads every file each run, since moving one file breaks
  // links in others.
  ["links"] {
    glob = List("**/*.md")
    check = new CommandSpec {
      command = "git ls-files -z -- '*.md' | xargs -0 lychee --offline --include-fragments --no-progress --"
      effect = "read"
    }
  }
```

In `docs/tooling.md`'s hk step table, add this row after `reuse`:

```markdown
| `links`            | every Markdown file git tracks, every run                             | lychee, offline, with heading anchors             |
```

Add `lychee` to the dev shell's list in "What it provides" (the hk bullet: `` `reuse`, `actionlint` `` becomes `` `reuse`, `actionlint`, `lychee` ``).

- [ ] **Step 6: Run the link check and fix what it finds**

Run: `nix develop -c hk check -S links`

Expected: PASS, after fixing each reported link. For each failure:

- **A missing file:** fix the relative path, using `git ls-files` to find where the target lives now.
- **A missing fragment:** compare with the target's heading. GitHub's slug lowercases, drops punctuation other than `-` and `_`, and turns spaces into `-`. If GitHub would resolve the link but lychee doesn't, report it to the user with the link and lychee's message rather than dropping `--include-fragments`.

Then prove the step can fail:

```sh
printf '\n[broken](no-such-file.md)\n' >> docs/README.md
nix develop -c hk check -S links; echo "exit $?"
git checkout docs/README.md
```

Expected: lychee reports `no-such-file.md`, and the exit status isn't 0.

- [ ] **Step 7: Run the task gate and commit**

Run the four Global Constraints commands. `checks.hk` now runs `links` in the sandbox too.

```bash
nix develop -c git add hk.pkl modules/flake/hk.nix $(git diff --name-only -- '*.md')
nix develop -c git commit -m "docs: follow the reorganized paths and check every link" -- hk.pkl modules/flake/hk.nix $(git diff --name-only HEAD -- '*.md')
```

### Task F4: Living docs that say M1 is unfinished

**Files:**

- Modify: `docs/runtime.md`, `docs/engines.md`, `docs/known-gaps.md`, `docs/ibus-web.md`, `docs/tooling.md`

**Interfaces:** none.

Each step replaces exact text. If Task F3 changed a path inside one of these passages, the `old` text below shows the passage before F3. Match it with F3's rewrite applied.

- [ ] **Step 1: `docs/runtime.md`**

Replace:

```markdown
Each part has a directory under `runtime/`: `runtime/libibus-web/` (the C
library, Meson), `runtime/ibus-runtime/` (the link, the export list, side
modules and their import check) and `runtime/wasmfs-idb/` (the storage
backend). Runtime-wide options are `ibusWeb.runtime.*`
(`runtime/options.nix`).

M1.1 adds the IBus types, emitters, framed dispatcher and GSettings backend.
The Worker host still uses its test transport; protocol transport and page
integration follow in M1.2–M1.4.
```

with:

```markdown
Each part has a directory under `runtime/`: `runtime/libibus-web/` (the C
library, Meson), `runtime/ibus-runtime/` (the link, the export list, side
modules and their import check) and `runtime/wasmfs-idb/` (the storage
backend). Their options are `ibusWeb.runtime.*`, each declared in its part's
`options.nix`.
```

Check the claim first: `git grep -n 'options.perSystem' -- runtime/*/options.nix`. Expected: one hit per part that declares options. If one part declares none, name only the parts that do.

Replace:

```markdown
different selected backend `-ENOTSUP`. The page persister and cross-tab bridge
are M1.4 work. Schemas must exist before GLib first obtains its default schema
```

with:

```markdown
different selected backend `-ENOTSUP`. The page persists those records and
relays them to other tabs ([core.md](core.md#settings-panel-output-and-logging)).
Schemas must exist before GLib first obtains its default schema
```

- [ ] **Step 2: `docs/engines.md`**

Replace:

```markdown
casts remain subject to the exact allow-list. This checks explicit casts; it does
not yet audit callback arity at
signal connection time. The allow-list is validated against that schema
```

with:

```markdown
casts remain subject to the exact allow-list. This checks explicit casts; it
doesn't audit callback arity at signal connection time. The allow-list is
validated against that schema
```

Replace:

```markdown
The page must eventually commit COMMIT-mode preedit on blur and
reset. Without `IBUS_CAP_SYNC_PROCESS_KEY_V2`, space passes through after the
engine commits; with it, the engine consumes space and emits `ForwardKeyEvent`
after `CommitText`. M1.4's router must choose capabilities accordingly.
```

with:

```markdown
The page commits COMMIT-mode preedit on blur and reset, and never advertises
`IBUS_CAP_SYNC_PROCESS_KEY_V2` ([core.md](core.md#adapter-and-client-duties)).
Without it, space passes through after the engine commits; with it, the engine
would consume space and emit `ForwardKeyEvent` after `CommitText`.
```

Check the claim first: `git grep -n "SYNC_PROCESS_KEY_V2 is never advertised" docs/core.md`. Expected: one hit.

- [ ] **Step 3: `docs/known-gaps.md`**

Replace:

```markdown
- **`@ibus-web/worker-host` is publishable but not released.** Its version stays `0.0.0` and nothing
  publishes it. Releases are to be versioned with Changesets, with a CI workflow that bumps versions and
  publishes to npm; neither is set up yet.
```

with:

```markdown
- **The published packages aren't released.** `@ibus-web/protocol`, `@ibus-web/worker-host`,
  `@ibus-web/core`, `@ibus-web/panel` and `ibus-web` are publishable, but their versions stay `0.0.0`
  and nothing publishes them. Releases are to be versioned with Changesets, with a CI workflow that
  bumps versions and publishes to npm; neither is set up yet.
```

In `## CI`, delete the bullets `**Not yet run.**` and `**First-run cache ordering.**`, with their continuation lines. Both are settled: CI has run green on `master`, including `publish`. Check that first with `gh run list --branch master --limit 5 --json conclusion,createdAt`; at least one `success` is expected. If none succeeded, keep both bullets and tell the user.

Then add, after the `**Fork pull requests**` bullet:

```markdown
- **FlakeHub visibility follows the repository's**, read from `github.event.repository.private` at each
  publish. FlakeHub's documentation doesn't say whether a publish changes an existing flake's visibility;
  if the first publish after the repository goes public leaves the flake private, change it once in
  FlakeHub's settings.
```

- [ ] **Step 4: `docs/ibus-web.md`**

Replace the first sentence:

```markdown
Install `ibus-web` and its `effect` peer dependency with your package manager.
```

with:

```markdown
The packages aren't on npm yet. To try them, build and pack them from this
repository: inside `nix develop`, run `pnpm install`, then
`pnpm -r --filter "./packages/*" run build`, then `pnpm --dir packages/<name> pack`
for each of `protocol`, `worker-host`, `core`, `panel` and `ibus-web`. Install
all five tarballs together, with `effect`, their peer dependency.
```

- [ ] **Step 5: `docs/tooling.md`: the workspace and its build**

Before replacing, run `git grep -n -e 'tsconfig.base.json' -e 'tsconfig.node-scripts.json' -e 'Repository-wide tools are' docs/tooling.md`.

- If it prints nothing, Phase A or B already rewrote these sections. Read them against the text below and change only sentences that contradict the tree.
- Otherwise replace the sections as follows.

Replace the whole `## TypeScript` section, up to but not including `## The pnpm workspace`, with:

```markdown
## TypeScript

All JavaScript that Emscripten doesn't read itself is TypeScript. Scripts the Nix builds run use
Node's type stripping (`node file.ts`), so they keep to erasable syntax: `.ts` import extensions,
no enums, namespaces or parameter properties. No `node -e` or `python -c` scripts are inlined in
Nix.

TypeScript is version 7 (the native compiler). Configuration:

- **`@ibus-web/tsconfig`** (`packages/tsconfig/`, private) holds the presets every tsconfig
  extends. `base.json` holds the standard options: `strict`, `exactOptionalPropertyTypes`,
  `erasableSyntaxOnly`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions`,
  `module`/`moduleResolution` `nodenext`, `target` `es2023`. The others add an environment's `lib`
  and `types`:
  - `dom.json` for page code and browser tests;
  - `worker.json` for code that runs in a dedicated Worker;
  - `node.json` for tools, Node tests and the scripts Nix runs. It also brings in the package's
    declarations of the part of the WebAssembly API Node code here uses, which TypeScript declares
    only in its web libraries.
  - `emscripten-js.json` for JavaScript Emscripten bundles as scripts.
- **One tsconfig per configuration, at the package root.** `tsconfig.json` references the others
  and is what editors open. A target gets its own config named for it (`tsconfig.page.json`,
  `tsconfig.worker.json`), and tests get `tsconfig.test.json` and `tsconfig.test-browser.json`.
  `tsconfig.config.json` covers the tsdown and Vitest configs. Each has its own `lib` and `types`,
  so code meant for a Worker can't use Node's API by accident. hk's `tsconfig-extends` step fails
  unless every tsconfig sits at a package root and extends a preset or its own package's
  `tsconfig.json`.
- **Builds.** Packages' `build` scripts emit `dist/` (tsdown for the published packages, `tsc -p`
  per environment for `@ibus-web/test-programs`), and checks run the emitted `dist/`. Test files
  run from source through Vitest ([testing.md](testing.md#vitest)).
- **JavaScript Emscripten reads** (`--js-library`, `--pre-js`, `--post-js`) stays JavaScript, with
  JSDoc types:
  - the IndexedDB backend's library and its test libraries;
  - the GoogleTest harness's report library;
  - `host-memory.js`;
  - `size-pre.js`.

  It's checked under its component's tsconfig, which extends
  `@ibus-web/tsconfig/emscripten-js.json` (`allowJs`/`checkJs`, `module: preserve`, a Worker's
  `es2023` library). Its declarations for what it uses from Emscripten are generated from a link of
  the library (`--emit-tsd`, through `ibusWeb.lib.emscriptenTypes`) where one exists, and local
  `.d.ts` files otherwise. `tools/emscripten-library-deps` checks a library's `__deps` against what
  it uses, parsing with the acorn version Emscripten ships. [storage.md](storage.md) describes the
  backend's library.

Hand-written TypeScript and JavaScript use modern syntax: what is Baseline "Widely available" and
also runs on the oldest supported Node.
```

Replace the opening of `## The pnpm workspace`, from its heading through the line ending `then \`pnpm install\`.`, with:

```markdown
## The pnpm workspace

One pnpm workspace at the root (`pnpm-workspace.yaml`). Every directory that holds TypeScript is one
of its packages, with a `package.json` naming exactly what that directory imports; the root
`package.json` has no dependencies.

| Directory                                                                                                   | Packages                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/*`                                                                                                | the published `@ibus-web/protocol`, `@ibus-web/worker-host`, `@ibus-web/core`, `@ibus-web/panel` and `ibus-web`; `@ibus-web/test-programs`; `@ibus-web/tsconfig` |
| `tools/*`                                                                                                   | one private package per tool, `@ibus-web/<tool>`                                                                                                           |
| `examples/*`                                                                                                | `@ibus-web/example-hangul`, with its end-to-end tests                                                                                                      |
| `runtime/wasmfs-idb`, `runtime/ibus-runtime`, `modules/emscripten`, `modules/testing`                       | the JavaScript Emscripten links into those components, and their Vitest suites                                                                             |

`pnpm-workspace.yaml` is generated. Its package globs and catalog are declared in Nix (`pnpmWorkspace`
in `modules/typescript/files.nix`), which reads them for its own builds, and `nix run .#write-files`
writes the file; `checks."files:pnpm-workspace.yaml"` fails while the tracked copy differs. The Nix
builds install from the generated file, not the tracked copy. Never edit the YAML: change the Nix, run
`write-files`, then `pnpm install`.
```

Check the component list first: `git grep -n -A12 'pnpmWorkspace' -- modules/typescript/files.nix`. The table must list exactly its globs; adjust any row that differs.

In the catalog bullet, replace the two sentences:

```markdown
  Repository-wide tools are `devDependencies` of the root `package.json`; a package that needs
  one in its own manifest (a peer dependency, a package-level script) names it `catalog:` too.
```

with:

```markdown
  A package names what it imports itself, as `catalog:` when the catalog has it.
```

In `### In Nix`:

- Replace `` `modules/typescript/default.nix` builds the workspace `` with `` `modules/typescript/workspace.nix` builds the workspace ``.
- Replace the stage 2 sentence's example. The text `as the GLib gate does, and the library checker (\`ibusWeb.runtime.libraryDeps\`: \`library-deps.ts\` beside its package's \`node_modules\`, which the type derivations and checks for both JavaScript libraries run)` becomes `as the GLib test gate (\`tools/glib-test-gate\`) and the library checker (\`tools/emscripten-library-deps\`) do`.
- In stage 3's sentence, after `plus files listed under \`ibusWeb.assets\` in its \`package.json\``, add `, and the repository's \`REUSE.toml\`, \`LICENSE-*\`, \`LICENSES/\` and \`NOTICES/\`, which \`tools/pack-licenses\` and core's tests read`.

In `### tsdown`, replace its first sentence:

```markdown
`@ibus-web/worker-host` bundles with tsdown.
```

with:

```markdown
Every published package bundles with tsdown and writes sourcemaps, which `tools/pack-licenses`
reads ([below](#licenses-in-packed-packages)). `@ibus-web/worker-host`'s are the interesting ones.
```

- [ ] **Step 6: `docs/tooling.md`: CI**

Replace the `- **\`check\`**` and `- **\`publish\`**` bullets in "### What it does" with:

```markdown
- **`check`** and **`integration`** do the same steps:
  - check out;
  - install Determinate Nix;
  - allow unprivileged user namespaces
    (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, where the runner has the
    setting). Ubuntu 24.04's AppArmor forbids them, and Chromium's sandbox, which the browser checks
    keep on, needs them;
  - enable FlakeHub Cache.

  Then `check` runs `nix flake check -L --system x86_64-linux --max-jobs 1`, and `integration`
  runs `nix build .#integration-checks -L --max-jobs 1`, each within 240 minutes. One job at a time
  keeps cold compilation and CPU-bound test checks from competing for the runner's few cores.
  Checks are defined for x86_64-linux, aarch64-linux and aarch64-darwin; the hosted runners are
  x86_64-linux, and the other systems' checks need their own machines.
- **`publish`** has `needs: [check, integration]`, and runs only on a push to `master`
  (`if: github.event_name == 'push' && github.ref == 'refs/heads/master'`). It publishes the flake
  to FlakeHub as `synapdeck/ibus-web`, rolling (`flakehub-push`), within 30 minutes. Its visibility
  follows the repository's (`github.event.repository.private`): private while the repository is,
  public once it is. FlakeHub Cache grants access per published flake, so the cache needs this
  flake published; only a `master` that passed both jobs is.
```

Delete the whole `### First run` subsection: its heading and every line up to the next `##` heading or the end of the file. CI has run, and its checks are what this section and `### The cache` describe.

Check the anchor first: `git grep -n 'tooling.md#first-run\|#first-run' -- '*.md'`. Expected: no hits left after Step 3 removed known-gaps' link. Fix any other hit to point at `tooling.md#ci`.

- [ ] **Step 7: Verify and commit**

Run: `nix develop -c oxfmt docs/runtime.md docs/engines.md docs/known-gaps.md docs/ibus-web.md docs/tooling.md`, then `git grep -n -E 'M1\.[0-9]|M1 |Not yet run|First run' -- docs/runtime.md docs/engines.md docs/known-gaps.md docs/ibus-web.md docs/tooling.md`.

Expected: no hits that describe M1 work as future. Historical measurements that name a milestone as context may stay.

Run the four Global Constraints commands.

```bash
nix develop -c git add docs/runtime.md docs/engines.md docs/known-gaps.md docs/ibus-web.md docs/tooling.md
nix develop -c git commit -m "docs: describe M1 as delivered and CI as running" -- docs/runtime.md docs/engines.md docs/known-gaps.md docs/ibus-web.md docs/tooling.md
```

### Task F5: The layout, in `toolchain.md` and the design spec

**Files:**

- Modify: `docs/toolchain.md` (section `## Flake layout`)
- Modify: `docs/specs/2026-09-26-ibus-web-design.md` (§10.1, from `### 10.1 Repository` up to `### 10.2`)

**Interfaces:** none.

- [ ] **Step 1: Check the tree the text describes**

Run:

```sh
git ls-files '*.nix' | sed 's|/[^/]*$||' | sort -u
ls modules packages tools examples engines runtime
git ls-files '*.nix' | grep -E '/(default|package)\.nix$'
grep -n 'import-tree' -A8 flake.nix
```

Expected:

- `modules/` holds `baseline-browser-mapping`, `emscripten`, `engines`, `flake`, `glib`, `testing`, `toolchain` and `typescript`, and nothing else.
- No `default.nix` or `package.nix` remains.
- import-tree lists `./modules ./packages ./tools ./runtime ./engines ./examples`.

Wherever the tree differs, write what it has in Steps 2 and 3.

- [ ] **Step 2: Replace `toolchain.md`'s layout section**

Replace from `## Flake layout` up to, not including, `**Inputs** come from FlakeHub` with:

```markdown
## Flake layout

The flake is dendritic: `flake.nix` holds only its inputs and hands every `.nix` file under
`modules/`, `packages/`, `tools/`, `runtime/`, `engines/` and `examples/` to flake-parts through
import-tree. Every such file is a flake-parts module except one whose name starts with `_`, which
import-tree skips: a plain `callPackage` recipe. Modules never import each other. They share values
only through per-system `ibusWeb.*` options (`ibusWeb.toolchain.*`, `ibusWeb.runtime.*`,
`ibusWeb.typescript.*`, `ibusWeb.testing.*`, …) and flake outputs. Helpers more than one module
needs are functions under `ibusWeb.lib` (`modules/flake/lib.nix`).

A component's Nix sits in the component's directory, and each file's name says its role:

| File          | Role                                                                          |
| ------------- | ----------------------------------------------------------------------------- |
| `module.nix`  | the component's flake-parts module: its packages, outputs and dev-shell setup |
| `options.nix` | options it declares for other modules to read                                 |
| `checks.nix`  | its checks                                                                    |
| `overlay.nix` | its overlay on `pkgsWasm`                                                     |
| `_<name>.nix` | a plain `callPackage` recipe                                                  |

A module with more than one job is split into further modules named for each job (`archives.nix`,
`exports.nix`). A check with fixtures of its own gets a directory under `checks/` holding its
`checks.nix` and its files; `patches/` holds a component's patches and a README of their
provenance. Non-Nix files sit beside the module that uses them, under plain names.

- `modules/` holds only what several components share:
  - `flake/`: systems, the dev shell, CI, hk, the generated files and `ibusWeb.lib`.
  - `toolchain/`, `emscripten/`, `glib/` and `baseline-browser-mapping/`, which this page covers.
  - `typescript/` and `testing/`.
  - `engines/`: what every engine shares.
- `runtime/<part>/` holds one part of the runtime: its sources, its modules and its tests.
- `engines/<name>/` holds one engine.
- `packages/<name>/`, `tools/<name>/` and `examples/<name>/` each hold a package of the pnpm
  workspace, with its Nix beside it.
```

- [ ] **Step 3: Redraw spec §10.1**

Replace everything from the line after `### 10.1 Repository` up to, not including, `One version for the whole project.` with:

````markdown
The flake is dendritic: `flake.nix` holds only inputs and passes its module
directories (below) through import-tree to flake-parts. Every `.nix` file in
them is a flake-parts module, except one whose name starts with `_`, which is
a plain `callPackage` recipe. Modules share values only through `ibusWeb.*`
per-system options, never by importing each other: the toolchain and its
`pkgsWasm` package set, engines, and the helpers in `ibusWeb.lib`. Non-Nix
files a module needs sit beside it under plain names.

A component's Nix lives in its own directory, each file named for its role:

- `module.nix`, its flake-parts module;
- `options.nix`, options it declares for others;
- `checks.nix`;
- `overlay.nix`, one gated overlay on `pkgsWasm` that may change several
  nixpkgs attributes;
- `_<name>.nix` recipes.

A check with sources of its own has a directory under `checks/`, with its
`checks.nix` beside them. `patches/` holds a component's patch files and a
README recording their provenance. `modules/` holds only infrastructure several
components share. The runtime's parts, each engine, each TypeScript package,
each tool and each example are components at the repository root.

Every directory holding TypeScript is a package of the pnpm workspace, and
every tsconfig extends a preset of `@ibus-web/tsconfig`. How the layout works
in practice is in `docs/toolchain.md` ("Flake layout") and `docs/tooling.md`.
Entries marked † below don't exist yet.

```
ibus-web/
├─ flake.nix, flake.lock           inputs: nixpkgs, flake-parts, import-tree, devshell, flake-root, systems, github-actions-nix, files
├─ package.json, pnpm-*.yaml       the pnpm workspace (no root dependencies), its catalog (generated from Nix) and its lockfile
├─ hk.pkl                          every formatter and lint check, for the git hooks, `nix fmt` and `checks.hk`
├─ REUSE.toml, LICENSES/, NOTICES/ per-path licensing, license texts, third-party notices
├─ modules/                        infrastructure several components share
│  ├─ flake/                       systems, hk, dev shell, the CI workflow, the files writer, ibusWeb.lib
│  ├─ toolchain/                   pkgsWasm (Emscripten cross package set), emscriptenCache, wrapper hooks, probes, checks/
│  ├─ emscripten/                  Emscripten's patches and the checks of what they fix
│  ├─ glib/                        pkgsWasm.glib: overlay, patches, checks
│  ├─ baseline-browser-mapping/    the package Emscripten's minimum versions come from
│  ├─ typescript/                  the pnpm workspace's offline build, its generated files, version and metadata checks
│  ├─ testing/                     the GoogleTest harness, the test-program and Vitest checks, nixpkgs' Playwright browsers
│  ├─ engines/                     what every engine shares: manifests, settings metadata, cast audits, the IBus conformance adapter
│  └─ release.nix †                the release set
├─ runtime/
│  ├─ libibus-web/                 C sources, ibus.h-compatible headers, tests/
│  ├─ wasmfs-idb/                  the WasmFS IndexedDB backend: C++, its JS library, header, tests/
│  └─ ibus-runtime/                the main-module link, its export list, side-module support, tests/
├─ engines/hangul/                 an engine: overlay.nix, patches/ (ibus-hangul's and libhangul's), checks/
├─ packages/                       protocol, worker-host, core, panel, ibus-web (published); test-programs; tsconfig
├─ tools/<name>/                   one package per build and check tool, each with its module.nix
├─ tools/claude/                   Claude Code language-server plugins (nixd, pkl)
├─ examples/hangul/                the Hangul demo and its end-to-end tests
└─ docs/                           this spec and the others; topic pages; upstream/ drafts
```
````

Before formatting, check every named directory exists: `ls -d modules/{flake,toolchain,emscripten,glib,baseline-browser-mapping,typescript,testing,engines} engines/hangul/patches tools/claude examples/hangul`. Expected: all listed. Also check engines/hangul's patch layout with `ls engines/hangul/patches`, and adjust the `engines/hangul/` line to what it shows.

- [ ] **Step 4: Verify and commit**

Run: `nix develop -c oxfmt docs/toolchain.md docs/specs/2026-09-26-ibus-web-design.md && nix develop -c hk check -S links`

Expected: PASS. The spec's tree is in a fenced block, which the renderer keeps out of any list.

Run the four Global Constraints commands.

```bash
nix develop -c git add docs/toolchain.md docs/specs/2026-09-26-ibus-web-design.md
nix develop -c git commit -m "docs(spec): redraw the repository layout" -- docs/toolchain.md docs/specs/2026-09-26-ibus-web-design.md
```

### Task F6: Upstream drafts: a status table, "Evidence", and the strace evidence out of the tree

**Files:**

- Modify: `docs/upstream/README.md`, and every `docs/upstream/*.md` with a `## Notes for the user` heading
- Modify: `docs/storage.md`, `docs/upstream/wasmfs-idb-backend.md`
- Modify: `modules/emscripten/patches/README.md` (row 0008)
- Delete: `docs/upstream/evidence/`

**Interfaces:** none.

- [ ] **Step 1: Pin a commit that has the evidence**

Run:

```sh
sha=$(git rev-parse origin/master)
git cat-file -e "$sha:docs/upstream/evidence/idb-sync-calls/README.md" && echo "$sha"
```

Expected: a full hash. Use it as `<sha>` below and its first 7 characters as `<short>`. `origin/master` is what GitHub serves, so the link resolves for anyone who can see the repository.

- [ ] **Step 2: Point the two docs at the pinned evidence**

In `docs/storage.md`, replace:

```markdown
The script, page and counts are in
[upstream/evidence/idb-sync-calls/](upstream/evidence/idb-sync-calls/).
```

with:

```markdown
The harness, page, counts and traces are in
[`docs/upstream/evidence/idb-sync-calls/` at `<short>`](https://github.com/synapdeck/ibus-web/tree/<sha>/docs/upstream/evidence/idb-sync-calls).
```

In `docs/upstream/wasmfs-idb-backend.md`:

- Replace `` ([`evidence/idb-sync-calls/`](evidence/idb-sync-calls/README.md) has the `` with `` ([`docs/upstream/evidence/idb-sync-calls/` at `<short>`](https://github.com/synapdeck/ibus-web/tree/<sha>/docs/upstream/evidence/idb-sync-calls) has the ``.
- Replace `` The `strace` counts are rerunnable: `evidence/idb-sync-calls/` `` with `` The `strace` counts are rerunnable: [the harness](https://github.com/synapdeck/ibus-web/tree/<sha>/docs/upstream/evidence/idb-sync-calls) ``.

Substitute the real `<sha>` and `<short>`.

- [ ] **Step 3: Delete the evidence**

Run:

```sh
git rm -r docs/upstream/evidence
git grep -n 'evidence/idb-sync-calls' -- ':!docs/specs/2026-10-07-repo-organization.md' ':!docs/plans'
```

Expected: the only hits are the three GitHub URLs from Step 2. If `hk.pkl`, `REUSE.toml` or a tsconfig still names the directory, remove that entry too.

- [ ] **Step 4: Rename "Notes for the user"**

Run:

```sh
grep -l '^## Notes for the user$' docs/upstream/*.md | xargs sed -i 's/^## Notes for the user$/## Evidence/'
git grep -n 'Notes for the user\|#notes-for-the-user' -- docs ':!docs/specs/2026-10-07-repo-organization.md'
```

Expected: 22 files changed; `node-web-locks-worker-threads.md` and `v8-liftoff-atomics-grown-shared-memory.md` have no such heading. The grep then shows only `docs/upstream/README.md` line 7, which Step 5 rewrites.

- [ ] **Step 5: Rewrite `docs/upstream/README.md`**

Replace the whole file with the text below. Keep the "Last checked" paragraph's facts as they are in the file; update them only if the user has rechecked.

```markdown
# Upstream reports

Draft reports for the projects ibus-web depends on: Emscripten, V8 and Node. Each Emscripten draft
backs a patch the toolchain carries in `modules/emscripten/patches/` (its README says which), or
explains why none is carried. A draft keeps its title and body as they would be posted, the evidence
behind them under "Evidence", and a status block at the top: what has been posted where, and the last
check against Emscripten's `main`. Once an issue is filed, its number goes into the matching patch's
header.

Last checked 2026-10-02, against Emscripten `main` 5977ecc (6.0.12-git; 6.0.11 is a0014542110d,
marked released that day). The suite-format tests ran with Emscripten's runner on `main`, using
emsdk's toolchain for it (`test/emsdk_version.txt` dbaebb43: clang 24.0.0git d3e9891b, Binaryen 133)
and Node 24.21.0. The toolchain's own LLVM 22.1.8 can't build `main`'s libc, or 6.0.10's:
`__builtin_wasm_memory_fill` (#27631) is unknown to clang 22 and 23.1.0.

## Status

Drafts not yet posted, in the order to post them:

| Draft                                         | Post as                                                                                                                                                                                                      | After                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `emscripten-wasmfs-proxy-worker-heartbeat.md` | a PR for #27858, e.g. "[WasmFS] Stop a ProxyWorker's heartbeat before its thread is joined", with `other.test_wasmfs_proxy_worker_exit`                                                                    | nothing                                                       |
| `emscripten-pthread-cleanup-blocked-main.md`  | a PR for #27840, e.g. "[pthread] Reclaim unjoined threads while the main thread is blocked" (the draft's two commits and three tests), linking #27841/#27846, which it makes easier to hit                 | nothing                                                       |
| `node-web-locks-worker-threads.md`            | a Node issue (github.com/nodejs/node), "Web Locks: an exclusive lock is sometimes granted to two worker_threads at once"                                                                                     | nothing                                                       |
| `emscripten-wasmfs-symlink-errors.md`         | an Emscripten issue, "WasmFS: symlink() reports EPERM for any backend failure (e.g. EACCES from the Node backend)", citing #27832, whose fix it builds on                                                    | nothing                                                       |
| `emscripten-wasmfs-lookup-errors.md`          | an Emscripten issue, "WasmFS: a backend can't fail a lookup with anything but ENOENT (e.g. EACCES from the Node backend)", citing #27832 and the symlink issue; its PR goes after theirs                    | the symlink issue                                             |
| `wasmfs-idb-backend.md`                       | a comment on #15942 ("WasmFS: IndexedDB backend"), not a new issue, then a PR. Rerun its `strace` counts against current browsers first, and settle the relicensing                                         | #27832, the symlink and lookup fixes, 0013 (#27823), the heartbeat PR |

Fixes for issues already filed go up as PRs once a maintainer has answered, each one a patch here
rebased onto `main`:

- 0010 for #27825; then 0012 for #27832 (it builds on 0010); then 0017 and 0019 for the symlink and
  lookup issues (they build on 0012).
- 0013 for #27823, after #27844 (0009), 0010 and 0012.
- 0003 for #27828, 0006 for #27829, 0007 for #18033. No dependencies.

Drafts already posted or settled:

| Draft                                         | Status                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `emscripten-noderawfs-fstat-stdio.md`         | #27628, fixed by #27632, in 6.0.10                                          |
| `emscripten-wasmfs-pipe-fifo-mode.md`         | filed as #27827, fixed by #27842, in 6.0.11                                 |
| `emscripten-imported-memory-maximum.md`       | filed as #27859, fixed by #27862 on `main` (after 6.0.11)                   |
| `emscripten-dlsym-rtld-next.md`               | filed as #27830; PR #27838 approved, not merged                             |
| `emscripten-pthread-finished-mark-reused.md`  | filed as #27841; PR #27846 open                                             |
| `emscripten-wasmfs-node-fsync.md`             | filed as #27822; PR #27844 open                                             |
| `emscripten-wasmfs-node-rename.md`            | filed as #27824; PR #27849 open                                             |
| `emscripten-wasmfs-open-noctty.md`            | filed as #27826; PR #27843 open                                             |
| `emscripten-wasmfs-node-chmod.md`             | filed as #27823; its `futimens()` part (0008) is PR #27845, approved        |
| `emscripten-wasmfs-node-create-eio.md`        | filed as #27832; fix PR pending (0012, above)                               |
| `emscripten-wasmfs-node-open-close-errors.md` | filed as #27825; fix PR pending (0010, above); #27847 is a related report with no patch here |
| `emscripten-wasmfs-poll-regular-file.md`      | filed as #27828; fix PR pending (0003, above)                               |
| `emscripten-wasmfs-search-permission.md`      | filed as #27829; fix PR pending (0006, above)                               |
| `emscripten-wasmfs-create-permission.md`      | commented on #18033; fix PR pending (0007, above)                           |
| `emscripten-wasmfs-getcwd-mount.md`           | commented on #18112 and #23756; #23756 is someone else's open fix           |
| `emscripten-pipe-capacity.md`                 | filed as #27831; not carried as a patch                                     |
| `emscripten-pipe-read-eof.md`                 | commented on #26708; not carried as a patch                                 |
| `v8-liftoff-atomics-grown-shared-memory.md`   | V8's own issues 529880019 and 533026477, fixed on V8 `main` (Chrome 157)    |
```

Check the content against the old file before overwriting: `git show HEAD:docs/upstream/README.md`. Every draft and issue number in it must appear in the new one; only the arrangement changes. Run `ls docs/upstream/*.md | wc -l`. Expected: 25, that is 24 drafts plus the README, matching the 6 + 18 rows above.

- [ ] **Step 6: Check patch 0008's draft column**

Run: `grep -n 'futimens\|0008' docs/upstream/emscripten-wasmfs-node-chmod.md | head`

Expected:

- Line 5 says the `futimens()` fix at the end of #27823's draft is patch 0008.
- Line 486 names `0008-wasmfs-futimens-null-path.patch`.

So 0008's row naming `emscripten-wasmfs-node-chmod.md` is right: 0008 has no draft of its own, and is the last section of 0013's. Make the row say so. In `modules/emscripten/patches/README.md`'s 0008 row, replace `draft \`emscripten-wasmfs-node-chmod.md\`` with `draft \`emscripten-wasmfs-node-chmod.md\` (its closing \`futimens()\` section)`.

If Step 6's grep shows something else, the row is genuinely wrong. Point it at the draft that does describe 0008, and tell the user.

- [ ] **Step 7: Verify and commit**

Run: `nix develop -c oxfmt docs/upstream/README.md docs/storage.md docs/upstream/wasmfs-idb-backend.md modules/emscripten/patches/README.md && nix develop -c hk check -S links -S reuse -S tsc`

Expected: PASS.

Run the four Global Constraints commands.

```bash
nix develop -c git add docs/upstream docs/storage.md modules/emscripten/patches/README.md
nix develop -c git commit -m "docs(upstream): track drafts in one status table and move the strace evidence out" -- docs/upstream docs/storage.md modules/emscripten/patches/README.md
```

### Task F7: The front door

**Files:**

- Create: `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`
- Modify: `REUSE.toml`, `docs/specs/2026-09-26-ibus-web-design.md` (§10.1 tree)

**Interfaces:** none.

- [ ] **Step 1: Check the facts these files state**

Run:

```sh
nix eval --json .#apps.x86_64-linux --apply builtins.attrNames
nix eval --raw .#checks.x86_64-linux.hk.name
git grep -n 'files\.file\.' -- '*.nix' | sed 's/=.*//'
gh api repos/synapdeck/ibus-web/private-vulnerability-reporting
```

Expected:

- The apps include `demo` and `write-files`.
- The `files.file` keys are the generated files that `AGENTS.md` lists below. If the grep shows a generated file the list lacks, or names one it doesn't show, make the list match the grep.
- The last command prints `{"enabled":true}` or `{"enabled":false}`. If it's false, tell the user that `SECURITY.md` points at private vulnerability reporting, which they need to turn on under the repository's Settings → Security. Don't enable it yourself.

- [ ] **Step 2: Annotate the new Markdown in `REUSE.toml`**

These files quote SPDX tags in prose, so REUSE must not scan them. In `REUSE.toml`, in the annotation whose `path` list starts with `"docs/**"` and `"README.md"`, add after `"README.md",`:

```toml
  "CONTRIBUTING.md",
  "AGENTS.md",
  "CLAUDE.md",
  "SECURITY.md",
```

- [ ] **Step 3: Add the new files to the spec's layout**

In `docs/specs/2026-09-26-ibus-web-design.md`'s §10.1 tree, after the `REUSE.toml, LICENSES/, NOTICES/` line, add:

```
├─ README.md, CONTRIBUTING.md      what ibus-web is and how to work on it; AGENTS.md (and CLAUDE.md) for coding agents; SECURITY.md
```

- [ ] **Step 4: Write `README.md`**

````markdown
# ibus-web

IBus input-method engines, running in the browser.

ibus-web runs minimally modified C and C++ IBus engines as WebAssembly in Web Workers; ibus-hangul
is the first. It gives web pages a TypeScript library that does what the IBus daemon, the
input-method module and the candidate panel do on a Linux desktop. It translates DOM key events,
routes them to the engine, applies the engine's preedit and commits to text fields, and shows its
candidates.

## How it fits together

- **The Worker side** is a WebAssembly runtime: a patched GLib and `libibus-web`, a fresh
  implementation of libibus. It hosts one engine per dedicated Worker, loaded as a side module.
- **The page side** is `ibus-web` and the `@ibus-web/*` packages: key translation, routing,
  text-surface adapters and the default panel.

The two halves talk only through a versioned protocol over a dedicated `SharedArrayBuffer`. That
boundary is also the licensing boundary. Engines are GPL, but the page packages are MIT OR Apache-2.0
and never contain Worker, runtime or engine code, so any page can use them. A page using ibus-web must
be cross-origin isolated (COOP `same-origin`, COEP `require-corp`).

## Try it

You need [Nix](https://nixos.org/download/) with flakes enabled. CI checks x86_64-linux.

```sh
nix run .#demo
```

Open http://127.0.0.1:5173, press Shift+Space to switch to Hangul, type `gks` for 한, and press F9 for
Hanja candidates. The first build compiles the patched Emscripten toolchain, GLib and the engine,
which takes a while.

## Packages

| Package                                           | What it is                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`ibus-web`](packages/ibus-web)                   | The facade most pages use: `createIbusWeb`, the panel, and the Worker scripts |
| [`@ibus-web/core`](packages/core)                 | Key translation, routing, adapters and the Effect services under the facade   |
| [`@ibus-web/panel`](packages/panel)               | The framework-free candidate and property panel                               |
| [`@ibus-web/protocol`](packages/protocol)         | The wire protocol and its strict GVariant codec                               |
| [`@ibus-web/worker-host`](packages/worker-host)   | The TypeScript that runs inside each engine's Worker                          |

They aren't published to npm yet; [docs/ibus-web.md](docs/ibus-web.md) says how to build and use them.

## Repository layout

| Directory    | What it holds                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `packages/`  | the TypeScript packages above, plus the shared test runner and tsconfig presets                     |
| `runtime/`   | the WebAssembly runtime: `libibus-web`, the IndexedDB storage backend, and the main-module link      |
| `engines/`   | one directory per engine: its overlay, patches and checks                                            |
| `modules/`   | Nix shared by several components: the Emscripten toolchain, GLib, the TypeScript build, testing, CI |
| `tools/`     | one package per build or check tool                                                                  |
| `examples/`  | the Hangul demo and its end-to-end tests                                                             |
| `docs/`      | how everything works and why, the design spec, and draft upstream reports                           |

## Documentation

[docs/README.md](docs/README.md) indexes the topic pages. The design and remaining milestones are in
the [design spec](docs/specs/2026-09-26-ibus-web-design.md), and what is knowingly left open is in
[docs/known-gaps.md](docs/known-gaps.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as
[SECURITY.md](SECURITY.md) describes.

## License

- The page-side packages, the Worker host and the tools: MIT OR Apache-2.0, at your option
  ([LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE)).
- `libibus-web` and the GLib patches: LGPL-2.1-or-later.
- Each engine and its patches: the engine's own license (ibus-hangul is GPL-2.0-or-later).

[REUSE.toml](REUSE.toml) is the authoritative per-path mapping, and every license text is in
[LICENSES/](LICENSES). Copyright 2026 Synapdeck, Inc.
````

- [ ] **Step 5: Write `CONTRIBUTING.md`**

````markdown
# Contributing to ibus-web

## Setting up

Everything comes from the flake, so the only prerequisite is [Nix](https://nixos.org/download/) with
flakes enabled. Enter the dev shell with `nix develop`, or let direnv do it on `cd` (`.envrc` is
`use flake`). The shell provides:

- the Emscripten cross toolchain and Meson;
- Node, pnpm and the workspace's TypeScript;
- hk and every formatter and linter it runs;
- the language servers.

On entry, it installs hk's git hook and builds the out-links editors and type checks read.
[docs/tooling.md](docs/tooling.md) describes all of it.

Inside the shell, run `pnpm install` once to get the workspace's `node_modules` for your editor and
for running Vitest by hand.

## Where things go

[README.md](README.md#repository-layout) maps the top-level directories.
[docs/toolchain.md](docs/toolchain.md#flake-layout) gives the Nix conventions: which file holds a
component's module, options, checks and overlay. [docs/tooling.md](docs/tooling.md#typescript)
gives the TypeScript ones:

- every directory with TypeScript is a pnpm workspace package that declares its own dependencies;
- each package has one tsconfig per configuration, at its root, extending a preset from
  `@ibus-web/tsconfig`;
- each tool is its own package under `tools/`.

## Making a change

1. **Generated files** are written from Nix: the CI workflow, `pnpm-workspace.yaml`, the key tables,
   `PROTOCOL.md`, `protocol.h`, and the notices. Change the Nix that declares them, then run
   `nix run .#write-files`. A `files:<path>` check fails while a tracked copy differs.
2. **License headers.** Every file you write starts with
   `SPDX-FileCopyrightText: 2026 Synapdeck, Inc.` and `SPDX-License-Identifier: MIT OR Apache-2.0`
   in its comment syntax. A file that can't hold comments (strict JSON) gets an entry in
   `REUSE.toml`. hk runs `reuse lint` on every commit.
3. **Checks.** A focused check is `nix build .#checks.x86_64-linux.<name> -L`. Before you push, run
   `nix flake check -L` (the default gates, which CI's `check` job runs) and
   `nix build .#integration-checks -L` (the extended matrices, CI's `integration` job).
   [docs/testing.md](docs/testing.md) describes the test frameworks and how to run one test from the
   checkout.
4. **Docs.** When behavior changes, change the page in `docs/` that describes it in the same commit.
   Each page keeps its reasons beside its decisions.
5. **Commit** from inside the dev shell, since hk's pre-commit hook needs its tools: a direnv shell, or
   `nix develop -c git commit`. The hook formats what you staged and fails on lint errors.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`,
with the summary in the imperative and lowercase.

- **Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `ci`, `build`, `chore`.
- **Scopes:** the component touched, such as `core`, `protocol`, `worker-host`, `panel`, `runtime`,
  `libibus-web`, `hangul`, `testing`, `toolchain`, `emscripten`, `glib`, `spec`, or a tool's name.
  Leave the scope out when a change spans many.

## Comments

Comments say why, not what: a non-obvious mechanism, a workaround and the constraint forcing it, an
invariant. They're written for someone reading the file cold, so they don't narrate the change that
introduced them, compare with other files, or point at a pull request. Match the comment density of
the code around you.

## Pull requests

Open pull requests against `master`. CI runs both jobs on every pull request. A pull request from a fork
builds without the binary cache, so its first run is slow.
````

- [ ] **Step 6: Write `AGENTS.md` and `CLAUDE.md`**

`AGENTS.md`:

```markdown
# Working in ibus-web

Instructions for coding agents. Read [CONTRIBUTING.md](CONTRIBUTING.md) too: everything there
applies.

## Environment

- Run every command inside the dev shell: `nix develop -c <command>`, or start the agent inside a
  direnv shell or `nix develop -c claude`. The language servers, hk and the toolchain resolve only
  there.
- Never search from `/`. Scope searches to the repository.

## Layout rules

- Every directory holding TypeScript is a pnpm workspace package whose `package.json` declares
  exactly what it imports. The root `package.json` has no dependencies; don't add any.
- tsconfigs sit only at package roots, one per compile configuration (`tsconfig.json`,
  `tsconfig.<target>.json`, `tsconfig.test.json`, `tsconfig.test-browser.json`,
  `tsconfig.config.json`). Each extends a preset from `@ibus-web/tsconfig` (`base`, `dom`, `worker`,
  `node`, `emscripten-js`) or its own package's `tsconfig.json`.
- A new tool is a new package `tools/<name>/` (`@ibus-web/<name>`, private), with its own
  `package.json`, `tsconfig.json`, `vitest.config.ts` and `module.nix`.
- Nix sits beside the component it builds, with each file named for its role:
  - `module.nix`, the flake-parts module;
  - `options.nix`, options for others;
  - `checks.nix`;
  - `overlay.nix`;
  - `_<name>.nix` for plain `callPackage` recipes.

  No `default.nix`. `modules/` is only for infrastructure several components share. A helper two
  modules need goes in `ibusWeb.lib` (`modules/flake/lib.nix`), not into a copy.
- Derivations are named `ibus-web-<what>`; checks are named `<area>-<what>`.

## Generated files: never edit by hand

Change the Nix that declares them, then run `nix run .#write-files`:

- `.github/workflows/ci.yml`, from `modules/flake/ci.nix`
- `pnpm-workspace.yaml`, from `modules/typescript/files.nix`
- `packages/core/src/keys/*.generated.ts`, `NOTICES/*.txt` and `LICENSES/LicenseRef-xkeyboard-config.txt`, from `tools/keysyms/module.nix`
- `packages/protocol/PROTOCOL.md` and `runtime/libibus-web/include/ibus-web/protocol.h`, from the protocol's schemas

`pnpm-lock.yaml` is written by `pnpm install`. When it changes, the `pnpmDeps` hash in
`modules/typescript/workspace.nix` usually does too: take the new value from the build's mismatch
error.

## Committing

- Stage named paths only (`nix develop -c git add <paths>`), never `git add -A` or `git add .`. Other
  people and agents may have work in progress in the tree.
- Commit with `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths>`, in Conventional
  Commits. hk's pre-commit hook runs then, and fails outside the dev shell.
- No AI attribution trailers or "Generated with" lines in commits or pull request descriptions.
- Never revert, reformat or "fix" changes you didn't make.

## Before saying it works

- Run the checks covering what you changed (`nix build .#checks.x86_64-linux.<name> -L`).
- Before handing back a branch, run `nix flake check -L`, `nix build .#integration-checks -L` and
  `nix develop -c hk check --all`.
- Report which you ran and what failed. Don't summarize a check you didn't run as passing.

## Writing

- **Comments** explain why, never what. Don't narrate history ("now", "previously", "was changed
  to"), reference other files' implementations, or point at plans or pull requests. Match the
  surrounding comment density.
- **Docs** in `docs/` describe the code as it is. Update the page a change affects in the same
  commit, and format Markdown with `nix develop -c oxfmt <file>`. `hk check -S links` must pass.
```

`CLAUDE.md`:

```markdown
@AGENTS.md
```

Claude Code reads `CLAUDE.md` and expands the `@AGENTS.md` import, so both kinds of agent read one file.

- [ ] **Step 7: Write `SECURITY.md`**

```markdown
# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting:
[open a draft advisory](https://github.com/synapdeck/ibus-web/security/advisories/new). Don't open a
public issue or pull request for them.

Include:

- what is affected: a package, the Worker host, the runtime, an engine's patches, or the build;
- the version or commit;
- how to reproduce it, and what an attacker gains.

A maintainer replies in the advisory and coordinates the fix and its disclosure there.

## Scope

ibus-web runs engines in dedicated Workers and keeps their code out of the page's bundle. Problems
that let engine or Worker code reach the page, or let one page's input reach another origin, are in
scope, as are problems in the packages, the runtime and the patches this repository carries.

A vulnerability in an upstream project ibus-web builds on (Emscripten, GLib, IBus, an engine) belongs
with that project; tell us too if ibus-web ships the affected code.

## Supported versions

Nothing has been released yet. Fixes land on `master`.
```

- [ ] **Step 8: Verify and commit**

Run: `nix develop -c oxfmt README.md docs/specs/2026-09-26-ibus-web-design.md CONTRIBUTING.md AGENTS.md CLAUDE.md SECURITY.md && nix develop -c hk check -S reuse -S links -S oxfmt`

Expected: PASS. If `reuse` complains about a parsing error in one of the five files, Step 2's annotation is missing it.

Run the four Global Constraints commands.

```bash
nix develop -c git add README.md CONTRIBUTING.md AGENTS.md CLAUDE.md SECURITY.md REUSE.toml docs/specs/2026-09-26-ibus-web-design.md
nix develop -c git commit -m "docs: add the README, contributing and agent guides, and a security policy" -- README.md CONTRIBUTING.md AGENTS.md CLAUDE.md SECURITY.md REUSE.toml docs/specs/2026-09-26-ibus-web-design.md
```

### Task F8: Index every doc

**Files:**

- Modify: `docs/README.md`

**Interfaces:** none.

- [ ] **Step 1: List what the index must cover**

Run: `git ls-files '*.md' | grep -v '^docs/plans/' | grep -v '^docs/upstream/[a-z]'`

Every file it prints, except `docs/README.md` itself and the root files, must be linked from the new index. `docs/upstream/README.md` stands for the drafts.

- [ ] **Step 2: Replace `docs/README.md`**

```markdown
# ibus-web documentation

How ibus-web works, the constraints it lives under, and the evidence behind each choice. Each page
keeps its reasons beside the decisions they support, with measurements summarised along with the
conditions they were taken under. Start with the repository's [README](../README.md) for what
ibus-web is, and [CONTRIBUTING](../CONTRIBUTING.md) for how to work on it.

## Topics

| Page                             | Covers                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [toolchain.md](toolchain.md)     | Emscripten and its patches, the frozen library cache, the flags every object gets, the `pkgsWasm` cross package set, the flake's layout, the minimum versions |
| [glib.md](glib.md)               | `pkgsWasm.glib`: the patch series, function-pointer casts, the platform backends, GLib's own tests and their gate                                          |
| [runtime.md](runtime.md)         | `libibus-web`, `ibus-runtime.wasm` and side modules; the pump and the wake design; the thread pool and its shares; fixed memory per Worker                 |
| [engines.md](engines.md)         | Engine recipe overrides, FHS data, patch layers, callback audits and Hangul golden tests                                                                   |
| [storage.md](storage.md)         | The WasmFS IndexedDB backend; engine data per version, its locks and installs; the writer lock; durability and costs                                       |
| [worker-host.md](worker-host.md) | `@ibus-web/worker-host`: the host's scopes, request loop, relay and pool top-up, failures, storage and engine data, and its test suites                    |
| [core.md](core.md)               | Page layers, key translation, sync/async routing, adapters, client policy, recovery and the Hangul demo                                                    |
| [ibus-web.md](ibus-web.md)       | Building and deploying the facade, its public API, Worker assets and settings                                                                              |
| [panel.md](panel.md)             | Framework-free candidate/property panel, actions, placement and stylesheet                                                                                 |
| [protocol.md](protocol.md)       | `@ibus-web/protocol`: strict GVariant codecs, schemas, generated artifacts, parity and decode measurements                                                 |
| [testing.md](testing.md)         | GoogleTest, g_test and Vitest; the test-program runner; adding a test program; running tests locally                                                       |
| [tooling.md](tooling.md)         | The dev shell, hk and its hooks, formatters and linters, TypeScript and pnpm, licenses in packed packages, editor language servers, CI and the binary cache |
| [known-gaps.md](known-gaps.md)   | What is knowingly left open, by area                                                                                                                       |

## Specs

| Spec                                                                                         | Covers                                                                                   |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [The design](specs/2026-09-26-ibus-web-design.md)                                            | Goals, architecture, protocol, licensing, build and the remaining milestones             |
| [Repository organization](specs/2026-10-07-repo-organization.md)                             | The package, tsconfig, Nix and documentation layout                                      |

## Beside the code

| Document                                                                              | Covers                                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`packages/protocol/PROTOCOL.md`](../packages/protocol/PROTOCOL.md)                   | The generated message reference                                           |
| [`examples/hangul/README.md`](../examples/hangul/README.md)                           | Running the Hangul demo                                                   |
| [`tools/cast-audit/README.md`](../tools/cast-audit/README.md)                         | The function-pointer cast audit and its allow-lists                       |
| [`tools/ibus-test/README.md`](../tools/ibus-test/README.md)                           | The native IBus test adapter, its artifacts and expected differences      |
| [`modules/emscripten/patches/README.md`](../modules/emscripten/patches/README.md)     | Each Emscripten patch: what it fixes, upstream status, when it can go     |
| [`modules/glib/patches/README.md`](../modules/glib/patches/README.md)                 | GLib's patch series                                                       |
| [`engines/hangul/patches/README.md`](../engines/hangul/patches/README.md)             | ibus-hangul's and libhangul's patch layers                                |
| [`runtime/libibus-web/src/ibus/README.md`](../runtime/libibus-web/src/ibus/README.md) | Which IBus sources are vendored and which are reimplemented               |
| [upstream/](upstream/README.md)                                                       | Draft reports for Emscripten, V8 and Node, and their status               |

The packages' own READMEs (`packages/*/README.md`) are what npm shows for each one.
```

Compare the table against Step 1's list. Every printed file must appear, or be a `packages/*/README.md`. Add a row for anything missing, for example a tool README a later phase added.

- [ ] **Step 3: Verify and commit**

Run: `nix develop -c oxfmt docs/README.md && nix develop -c hk check -S links`

Expected: PASS.

Run the four Global Constraints commands.

```bash
nix develop -c git add docs/README.md
nix develop -c git commit -m "docs: index every page, spec and in-tree README" -- docs/README.md
```

### Task F9: Retire the differential-testing spec

`docs/specs/2026-10-03-native-ibus-differential-testing.md` designed a feature that is finished. `tools/ibus-test/README.md` documents its contract and `docs/known-gaps.md` its open scope. The spec's design rules and its one note on future work appear nowhere else, so they move first and the spec is deleted.

**Files:**

- Modify: `tools/ibus-test/README.md` (a "Design rules" section after the opening paragraph)
- Modify: `docs/known-gaps.md` (the "Native parity scope" item)
- Delete: `docs/specs/2026-10-03-native-ibus-differential-testing.md`

**Interfaces:** none.

- [ ] **Step 1: Add the design rules to the adapter README**

In `tools/ibus-test/README.md`, insert after the opening paragraph (the one ending "contexts are symbolic names.") and before the next heading or paragraph:

```markdown
## Design rules

- The native engine is the reference and runs unpatched. Where the port deliberately fixes an upstream bug, the
  difference is declared narrowly in `expectedDifferences`. It is never hidden by patching the native side, skipping
  the scenario or loosening the comparison.
- Only transport identity is normalized: native object paths, runtime context numbers and sequence counters map to
  the trace's symbolic names. Events are never dropped, reordered or merged, and empty updates count.
- A reply or an explicit checkpoint proves that output is complete. An idle event loop or a sleep never does.
- An engine is added by configuration alone: its executable, service and factory identity, engine name, schemas, data
  and traces. Adding one changes neither the driver nor the comparison.
```

Then run `nix develop -c oxfmt tools/ibus-test/README.md`.

- [ ] **Step 2: Repoint known-gaps and record the future adapter**

In `docs/known-gaps.md`, in the "Native parity scope" item, replace the line

```markdown
  See [the native testing spec](specs/2026-10-03-native-ibus-differential-testing.md).
```

with

```markdown
  Comparing what `ibus-daemon` and a toolkit client do on top of the engine needs a separate input-context adapter,
  which must set client-side preedit commits and capabilities explicitly, since both change the observable output.
  See [the test adapter](../tools/ibus-test/README.md).
```

Then run `nix develop -c oxfmt docs/known-gaps.md`.

- [ ] **Step 3: Delete the spec and check for references**

```sh
git rm docs/specs/2026-10-03-native-ibus-differential-testing.md
git grep -n '2026-10-03-native-ibus-differential-testing' -- ':!docs/plans'
```

Expected: no output from `git grep`. For any hit, point it at `tools/ibus-test/README.md`.

- [ ] **Step 4: Verify and commit**

Run the four Global Constraints commands; `nix develop -c hk check -S links` must pass.

```bash
nix develop -c git add tools/ibus-test/README.md docs/known-gaps.md
nix develop -c git commit -m "docs: fold the differential-testing spec into the adapter README" -- tools/ibus-test/README.md docs/known-gaps.md docs/specs/2026-10-03-native-ibus-differential-testing.md
```

### Task F10: Delete the finished plans

This is the branch's last commit. It deletes `docs/plans/`, including this plan.

**Files:**

- Delete: `docs/plans/` (the six finished plans and `docs/plans/2026-10-07-repo-organization.md`)
- Modify: `hk.pkl` (the `oxfmt` exclude for `docs/plans/**`)

**Interfaces:** none.

- [ ] **Step 1: Make sure nothing else is left to do**

Every checkbox above this task must be checked. Run: `grep -c '^- \[ \]' docs/plans/2026-10-07-repo-organization.md`

Expected: the count equals the number of unchecked steps in this task, 3. If it's higher, finish those steps first.

- [ ] **Step 2: Remove the references and the directory**

Run:

```sh
git grep -n 'docs/plans\|plans/2026' -- ':!docs/plans' ':!docs/specs/2026-10-07-repo-organization.md'
```

Expected: no output. For any hit, drop the reference or point it at the topic page that now covers the subject. Then:

```sh
git rm -r docs/plans
```

Remove the `"docs/plans/**"` entry and its comment from the `oxfmt` step's `exclude` list in `hk.pkl`, and stage
`hk.pkl`.

- [ ] **Step 3: Verify and commit**

Run the four Global Constraints commands. `hk check -S links` matters most here.

```bash
nix develop -c git commit -m "docs: remove the implementation plans of finished work" -- docs/plans hk.pkl
```
