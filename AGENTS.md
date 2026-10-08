# Working in ibus-web

Instructions for coding agents. Read [CONTRIBUTING.md](CONTRIBUTING.md) too: everything there applies.

## Environment

- Run every command inside the dev shell: `nix develop -c <command>`, or start the agent inside a direnv shell or
  `nix develop -c claude`. The language servers, hk and the toolchain resolve only there.
- Never search from `/`. Scope searches to the repository.
- `git add` a new file before any `nix` command that should see it: the flake only reads files git tracks.

## Layout

- Every directory holding TypeScript is a pnpm workspace package whose `package.json` declares exactly what it
  imports. The root `package.json` has no dependencies; don't add any.
- tsconfigs sit only at package roots, one per compile configuration: `tsconfig.json` (a solution file that only
  references the others) and files such as `tsconfig.<target>.json`, `tsconfig.test.json`, `tsconfig.test-browser.json`
  and `tsconfig.config.json`. A package with one configuration has only `tsconfig.json`. Each extends a preset from
  `@ibus-web/tsconfig` (`base`, `dom`, `worker`, `node`, `emscripten-js`) or another config of its own package, never
  the solution `tsconfig.json` (`runtime/wasmfs-idb/tsconfig.library-types.json` extends `./tsconfig.worker.json`);
  hk's `tsconfig-extends` step enforces this.
- A tool is a package `tools/<name>/` (`@ibus-web/<name>`, private) with its own `package.json` and `tsconfig.json`, a
  `vitest.config.ts` when it has tests, and `checks.nix` when it only has checks or `module.nix` when it also provides
  something. `tools/claude/` is the exception: it holds Claude Code plugin manifests and isn't a package.
- Nix sits beside the component it builds, each file named for its role:
  - `module.nix`, the flake-parts module: packages, outputs, dev-shell setup;
  - `options.nix`, options it declares for other modules;
  - `checks.nix`;
  - `overlay.nix`, its overlay on `pkgsWasm`;
  - `_<name>.nix`, a plain `callPackage` recipe, which import-tree skips.

  A module with more than one job splits into further modules named for each job (`exports.nix`, `archives.nix`,
  `cache.nix`, …).

  No `default.nix`. A check with fixtures of its own gets a directory under `checks/` holding its `checks.nix`.
  `modules/` is only for infrastructure several components share. Modules never import each other; they share values
  through `ibusWeb.*` options.

- A helper two modules need goes in `ibusWeb.lib` (declared in `modules/flake/lib.nix`), not into a copy.
- Derivations are named `ibus-web-<what>`, except the project's own artifacts (`libibus-web`, `wasmfs-idb`,
  `ibus-runtime`), upstream packages and command wrappers. Checks are named `<area>-<what>`, the area being the
  component's directory: `hangul-golden`, `tools-cast-audit`, `glib-settings-listeners`. The `files:<path>` checks from the files module are the exception: they are named for the
  generated file they guard.

## Generated files: never edit by hand

Change the Nix that declares them, then run `nix run .#write-files`. Each has a `files:<path>` check that fails while
the tracked copy differs.

- `.github/workflows/ci.yml`, from `modules/flake/ci.nix`
- `pnpm-workspace.yaml`, from `modules/typescript/files.nix`
- `packages/protocol/PROTOCOL.md` and `runtime/libibus-web/include/ibus-web/protocol.h`, from
  `packages/protocol/module.nix` and the protocol's schemas
- `packages/core/src/keys/*.generated.ts`, `NOTICES/*.txt` and `LICENSES/LicenseRef-xkeyboard-config.txt`, from
  `tools/keysyms/module.nix`

`pnpm-lock.yaml` is written by `pnpm install`. When it changes, the `pnpmDeps` hash in
`modules/typescript/workspace.nix` usually does too: take the new value from the build's mismatch error.

## Committing

- Stage named paths only (`nix develop -c git add <paths>`), never `git add -A` or `git add .`. Other people and agents
  may have work in progress in the tree.
- Commit with `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths>`, in Conventional Commits. hk's
  pre-commit hook runs then, and fails outside the dev shell. If it rejects or changes files, fix the cause and commit
  again; never bypass it.
- No AI attribution trailers or "Generated with" lines in commits or pull request descriptions.
- Never revert, reformat or "fix" changes you didn't make.

## Before saying it works

- Run the checks covering what you changed (`nix build .#checks.x86_64-linux.<name> -L`). List them with
  `nix eval --json .#checks.x86_64-linux --apply builtins.attrNames`.
- Before handing back a branch, run `nix run .#write-files` (expect no drift in `git status`), `nix flake check -L`,
  `nix build .#integration-checks -L` and `nix develop -c hk check --all`.
- Report which you ran and what failed. Don't summarize a check you didn't run as passing.

## Writing

- **Comments** explain why, never what. Don't narrate history ("now", "previously", "was changed to"), compare with
  or reference other files' implementations, or point at plans or pull requests. Match the surrounding comment
  density.
- **Readability:** separate logical blocks with a blank line (groups of related bindings, the steps of a function,
  sections of an attribute set or script, imports and body). Never put a blank line right after an opening token or
  right before a closing one, nor between a comment and the code it describes.
- **Docs** in `docs/` describe the code as it is. Update the page a change affects in the same commit, and format
  Markdown with `nix develop -c oxfmt <file>`. `hk check -S links` must pass.
- **Never run oxfmt on `docs/plans/`.** The plans quote code verbatim as before/after snippets, which formatting would
  rewrite; hk excludes them.
