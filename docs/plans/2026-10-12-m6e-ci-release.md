# M6 Phase 6e: CI and release — Plan

## Goal

The spec's "6e: CI and release": CI on WarpBuild runners for x86_64-linux, aarch64-linux and aarch64-darwin, the
Playwright suite on macOS and a Safari smoke suite through `safaridriver`, Changesets versioning with a tag-driven release
workflow that builds `.#release` and publishes with npm trusted publishing, and the four toolchain fixes. Nothing is
tagged, released or published here; the release task itself runs after every M6 phase has landed.

## Tasks

1. **Files writer deletes what it no longer configures.** `write-files` records the paths it manages in a generated
   manifest and deletes a path the previous manifest listed that the Nix no longer configures. Proof:
   `checks.flake-write-files` runs the writer in a scratch repository holding a stale managed file and an unmanaged one;
   the stale one goes, the other stays.
2. **`.emcache` re-seeded when the frozen cache changes.** The dev shell records which frozen cache seeded `.emcache` and
   replaces the copy when the cache's store path differs. Proof: `checks.emscripten-dev-cache` runs the seeding script
   against two caches: first seed, kept on the same cache, replaced on a new one.
3. **Single-file executables.** `modules/toolchain/emscripten-cc-wrapper-hook.sh` adds `-sSINGLE_FILE` ahead of the
   command's arguments on every link that makes a program; the runtime and the Emscripten fix check that reads a module's
   `.wasm` opt out with `-sSINGLE_FILE=0`; recipes stop copying `.wasm` files beside programs. Proof:
   `checks.toolchain-single-file` (a plain program and a pthreaded main module loading a side module, each one `.js` that
   runs under Node from a directory holding nothing else; the side module and an opted-out link keep their `.wasm`),
   red against the unpatched hook, then `nix flake check` and `integration-checks` green.
4. **Autotools configure runs its test programs.** A setup hook gives configure a site file setting
   `cross_compiling=maybe`, so configure runs its test programs, which emcc links as Node scripts. Proof:
   `checks.toolchain-autotools-consumer`, whose `AC_RUN_IFELSE` result reaches the build, red without the hook.
5. **The flake evaluates off Linux.** m17n-db's charset maps come from glibc's source where nixpkgs' m17n-db is
   Linux-only. Proof: every `checks.<system>` attribute of aarch64-darwin and aarch64-linux evaluates to a derivation.
6. **CI on WarpBuild, on three systems.** `ci.nix` runs `nix flake check` on x86_64-linux, aarch64-linux and
   aarch64-darwin, `integration-checks` on x86_64-linux, and the Playwright suite on aarch64-darwin, on WarpBuild labels.
   Proof: `checks."files:.github/workflows/ci.yml"` and hk's actionlint.
7. **The Safari smoke suite.** A W3C WebDriver client and suite in the demo (Hangul typing, a Rime install and
   conversion, learning that survives a reload, the IndexedDB backend in Workers), `nix run .#safari-smoke` driving
   Safari through `safaridriver`, and a CI job on the macOS runner. Proof: the same suite on Firefox through geckodriver,
   `packages.webdriver-smoke` in `integration-checks`.
8. **Changesets.** `.changeset/config.json` with every published package in one fixed group, the engine packages in the
   pnpm workspace, `changeset` in the dev shell, and the release-notes tool. Proof: `checks.tools-release` (the notes
   tool's tests, and `changeset status` with a sample changeset bumping all eleven packages to one version).
9. **`.#release` and source bundles.** `packages.release` (x86_64-linux) holding the GitHub release's assets per design
   spec §10.7 and `release.json`, and `packages.engine-<name>-src` for each engine. Proof: `nix build .#release`, its
   `release.json` and asset list inspected; `checks.tools-release-source-bundles` fails when an engine has no bundle.
10. **Release workflows.** `release.yml` on a `v*` tag: build `.#release`, check the tag against its version, create the
    GitHub release, `npm publish` each tarball with trusted publishing; and a weekly `nix build --rebuild`. Proof:
    `files:` checks and actionlint.
11. **Verify the phase.** `nix run .#write-files` with no drift, `nix flake check -L`, `nix build .#integration-checks -L`,
    `nix develop -c hk check --all`.

Each task updates the docs it affects and removes or narrows its `docs/known-gaps.md` bullet in the same commit.

## Decisions this phase makes where the spec is silent

- **Runner labels.** `warp-ubuntu-latest-x64-8x`, `warp-ubuntu-latest-arm64-8x` and `warp-macos-26-arm64-6x`, the labels
  Synapdeck's other repositories use. WarpBuild's Linux runners have 150 GB of disk, which ends the cold-run problem;
  eight cores keep a cold run inside the timeout. The macOS label is the only macOS size those repositories use.
- **What runs where.** `nix flake check` on all three systems. `integration-checks` on x86_64-linux only; on macOS only
  `packages.playwright-integration`, the "whole Playwright suite" the spec names, since macOS minutes cost about 13 times
  Linux ones and the rest of `integration-checks` is not browser-specific to WebKit.
- **The manifest of generated files** is itself a generated file, `.generated-files`, so its `files:` check catches a
  configuration change made without running the writer.
- **Versioning is local.** The maintainer runs `changeset version`, commits through hk and tags; no bot opens version
  pull requests. Every published package is in one fixed group, so a release has one version, which names its assets.
- **The first release's changeset is not committed here.** Writing it, versioning and tagging are the release task.
- **The suite's local proof.** The Safari smoke suite speaks plain W3C WebDriver, so it also runs on Firefox through
  geckodriver in the Nix sandbox; that run is in `integration-checks` so the suite can't rot unseen.
- **Reproducibility.** The weekly job rebuilds the release, the runtime and each engine's module with `--rebuild`, since
  `--rebuild` compares only the derivations named.

## Departures from the spec

- **The release builds source bundles too.** The spec's release step names `.#release`, which doesn't exist; it is built
  here to design spec §10.7 and §9.3, source bundles included, since the release can't happen without it.
- **`checks.flake-write-files`, `checks.emscripten-dev-cache`, `checks.tools-release`,
  `checks.tools-release-source-bundles`, `checks.toolchain-autotools-consumer` and `packages.webdriver-smoke`** are tests the
  spec's Testing section doesn't list; each is the only way to show its task's behaviour locally.
- **Autotools configure runs its test programs without an exe wrapper.** The spec asks for a Node exe wrapper, as Meson
  has; autoconf has no such hook. The site file sets `cross_compiling=maybe` instead, and configure runs `./conftest`
  itself, which works because emcc links an output with no extension as a Node script carrying its WebAssembly.

## What the spike proved and what it didn't

The planner's spike clone was lost with the machine's `/tmp`; its commands and their output survive in the session
transcript, and the code below is rebuilt from them onto current master.

Proved there, by building: the wrapper hook's `-sSINGLE_FILE` with a pthreaded main module loading a side module runs
under Node (`toolchain-single-file` red without the hook, green with it); the site file makes configure run its test
programs (`toolchain-autotools-consumer` red without it); with both, `nix flake check` on x86_64-linux failed only
`emscripten-fixes` (the imported-memory module read its `.wasm`) and `toolchain-clangd` (the consumer's config header),
both fixed; m17n-db built from glibc's charmaps source matches nixpkgs' but for a comment, and with it every darwin and
aarch64-linux check evaluates; `changeset status` and `version` bump all eleven packages to 1.0.0 once the engine
packages are in the workspace; the release-notes tool's tests pass; a hangul source bundle builds and is reproducible
across xz thread counts.

Not proved: the spike's `integration-checks` run and its `.#release` build never finished (the notes tool's relative
import failed in the store). Nothing in this phase can run here on WarpBuild, aarch64-linux, macOS or Safari: the
workflows are checked only as generated YAML and by actionlint, the macOS Playwright run and the Safari suite only by the
same suite on Linux, and the publish job not at all. Whether npm lets a trusted publisher be configured before a
package's first version (design spec R14) is unverified.
