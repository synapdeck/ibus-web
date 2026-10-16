# Contributing to ibus-web

## Setting up

Everything comes from the flake, so the only prerequisite is [Nix](https://nixos.org/download/) with flakes enabled.
Enter the dev shell with `nix develop`, or let direnv do it on `cd` (`.envrc` is `use flake`). The shell provides:

- the Emscripten cross toolchain and Meson;
- Node, pnpm and the workspace's TypeScript;
- hk and every formatter and linter it runs;
- the language servers;
- `write-files`, which writes the generated files.

On entry, it installs hk's git hook and builds the out-links that editors and the type checks read.
[docs/tooling.md](docs/tooling.md) describes all of it.

Inside the shell, run `pnpm install` once to get the workspace's `node_modules` for your editor and for running Vitest
by hand.

## Where things go

[README.md](README.md#repository-layout) maps the top-level directories.
[docs/toolchain.md](docs/toolchain.md#flake-layout) gives the Nix conventions: which file holds a component's module,
options, checks and overlay. [docs/tooling.md](docs/tooling.md#typescript) gives the TypeScript ones:

- every directory with TypeScript is a pnpm workspace package that declares its own dependencies;
- each package has one tsconfig per configuration, at its root, extending a preset from `@ibus-web/tsconfig`;
- each tool is its own package under `tools/`.

## Making a change

1. **Generated files** are written from Nix: the CI workflow, `pnpm-workspace.yaml`, the key tables, `PROTOCOL.md`,
   `protocol.h`, the notices, and `.generated-files`, which lists them. Change the Nix that declares them, then run
   `nix run .#write-files`. The `files:<path>` check fails while a tracked copy differs.
2. **License headers.** Every file you write starts with `SPDX-FileCopyrightText: 2026 Synapdeck, Inc.` and
   `SPDX-License-Identifier: MIT OR Apache-2.0` in its comment syntax (`libibus-web` uses `LGPL-2.1-or-later`, and
   engine files take the engine's licence: `engines/hangul` is `GPL-2.0-or-later`). A file that can't hold comments,
   such as strict JSON, gets an entry in `REUSE.toml`. hk runs `reuse lint` on every commit.
3. **Checks.** A focused check is `nix build .#checks.x86_64-linux.<name> -L`. Before you push, run `nix flake check -L`
   (the default gates, which CI's `check` job runs) and `nix build .#integration-checks -L` (the extended matrices, CI's
   `integration` job). [docs/testing.md](docs/testing.md#running-tests-locally) describes the test frameworks and how to
   run one test from the checkout.
4. **Docs.** When behavior changes, change the page in `docs/` that describes it in the same commit. Each page keeps its
   reasons beside its decisions.
5. **Commit** from inside the dev shell, since hk's pre-commit hook needs its tools: a direnv shell, or
   `nix develop -c git commit`. The hook formats what you staged and fails on lint errors. `hk check --all` runs every
   step over the whole tree.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, with the summary in
the imperative and lowercase.

- **Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `style`, `ci`, `build`, `chore`.
- **Scopes:** the component touched, such as `core`, `protocol`, `worker-host`, `panel`, `runtime`, `libibus-web`,
  `hangul`, `testing`, `typescript`, `toolchain`, `nix`, `hk`, `spec`, or a tool's name (`pack-licenses`, `cast-audit`).
  Leave the scope out when a change spans many.

## Comments

Comments say why, not what: a non-obvious mechanism, a workaround and the constraint forcing it, an invariant. They're
written for someone reading the file cold, so they don't narrate the change that introduced them, compare with other
files, or point at a pull request. Match the comment density of the code around you.

## Pull requests

Open pull requests against `master`. CI runs both jobs on every pull request. A pull request from a fork builds without
the binary cache, so its first run is slow.
