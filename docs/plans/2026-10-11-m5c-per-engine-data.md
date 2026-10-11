# M5 Phase 3: Per-Engine Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase 5c of `docs/specs/2026-10-11-m5-rime.md`, "Per-engine data": an engine's descriptor names store paths of its module's data as its own, and the host installs them the first time a page prepares that engine rather than at the module's start; then make Rime's dictionaries such data in `ibus-web-rime-dist` and run the distribution through `rime-host`.

**Architecture:** The generic part comes first and lands on its own (Tasks 1–9, fixtures only, no Rime). It starts by replacing the installer (Task 1): engine archives become pax, which holds the link targets longer than 100 bytes that Rime's common data has, and the host decodes them with `modern-tar` and writes each entry through WasmFS's JavaScript `FS`, which the runtime now exports, in place of `libibus-web`'s C extractor. The IndexedDB backend gains a window for changes, `wasmfs_idb_backend_set_writable`, beside its one-way seal. The protocol's `EngineDescriptor` gains `data?: string[]`, and `decodeModuleManifest` refuses a path outside the module's `data` and a lazy path holding the schema directory. Every host mounts the version's data with its window shut; it installs the base data at start through the open window, as before, and seals the backend only as it closes. A page message, `PrepareEngine`, has the host read each of the engine's store paths' markers (`meta.paths/<storePath>`) and install each missing path under an install lock of its own, so different paths install at once, in one Worker or several, while within a Worker one install serves every engine that needs the path; each extraction runs through the backend's window, now reference-counted, and writes its marker last, and the host posts progress per engine and a report per path. The message travels by `postMessage`; the page also bumps a new control word, `mail`, so that a host asleep in the runtime goes to its event loop to take it, where it prepares every engine asked for at once while it keeps serving requests, as it does during a pool top-up. The page core prepares an engine before its first `CreateEngine` in a Worker without holding the router's mailbox: a surface waits on native input while the data downloads, and other selections, focus changes and detaches go on; `select` resolves once the engine is made, and the facade gains `prepare(module, engine)` and an `install` event. The Rime part (Tasks 10–12) feeds 5b's `engine-data.json` into `mkEngineManifest` as each engine's `data` and adds `rime-host`, modelled on `mozc-host` and `m17n-host`.

**Tech Stack:** C++ (WasmFS backend, GoogleTest under Chromium and Firefox), TypeScript 7 with Effect 4 (worker host, page core, facade), `modern-tar` 0.8.5 (the host's tar decoder), Vitest (Node and browser mode), Nix flake-parts, hk, oxfmt.

## Global Constraints

- Work on branch `typedrat/m5c-per-engine-data`, cut from the tip of `typedrat/m5b-rime-under-node` (phase 5b). Tasks 1–9 use nothing of 5b's; Tasks 10–12 consume 5b's names, used exactly as the shared brief fixes them:
  - `packages.ibus-web-rime` (`$out/rime.wasm`), with passthru `descriptors` (the `ibus-web-rime-descriptors` output), `settingsSchemaDir`, `common`, `dicts` (attribute set, dictionary name to store path) and `schemas` (the shipped schema ids, in engine order);
  - `packages.ibus-web-rime-descriptors`, holding `engines.json` (the descriptor array, `rime:rime_ice` first), `settings-paths.json`, `settings-schemas.json`, `engine-data.json` (engine name to the list of its dictionary store paths) and `instances.txt`;
  - `packages.ibus-web-rime-common` and one `packages.ibus-web-rime-dict-<dictionary>` per dictionary;
  - engine names `rime:<schema_id>`, the default `rime:rime_ice`; the schemas `org.freedesktop.ibus.engine.rime` at `/org/freedesktop/ibus/engine/rime/` and the relocatable `org.freedesktop.ibus.engine.rime.schema`;
  - `docs/rime.md`, with a `## Checks` section, and a `## Rime` section in `docs/engines.md`.
- Run every command inside the dev shell (`nix develop -c …`) from the branch's checkout. `git add` a new file before any `nix` command that should see it: the flake reads only files git tracks.
- Commit with `nix develop -c git add <paths>` then `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths>`, in Conventional Commits. Stage named paths only, never `git add -A` or `git add .`. No attribution trailers or "Generated with" lines. hk's pre-commit hook runs oxlint, oxfmt, tsc, clang-format, nixfmt and REUSE; if it rejects or rewrites a file, fix the cause, re-add and commit again; never bypass it. Never revert, reformat or "fix" changes you didn't make.
- Comments explain why, never what; no history ("now", "previously"), no references to other files' implementations, plans or pull requests, no "NOTE:". Match the surrounding comment density. Separate logical blocks with one blank line; never a blank line right after an opening token or right before a closing one, nor between a comment and the code it describes. Never whitespace-minimize code.
- New files start with `SPDX-FileCopyrightText: 2026 Synapdeck, Inc.` and an `SPDX-License-Identifier` in their comment syntax: `MIT OR Apache-2.0` for everything under `runtime/wasmfs-idb/` and `packages/`, `GPL-3.0-or-later` under `engines/rime/` (the module's licence, as 5b's files there carry it; take the identifier from 5b's `engines/rime/module.nix` if it differs).
- Docs change in the same commit as the code they describe. Format every Markdown file under `docs/` you touch with `nix develop -c oxfmt <file>`; `nix develop -c hk check -S links` must pass. Never run oxfmt on `docs/plans/`. Non-Latin sample text in Markdown goes in code spans.
- Task 1 adds a dependency: `pnpm add` writes `pnpm-lock.yaml`, and `modules/typescript/workspace.nix`'s `pnpmDeps` hash takes the value the build's mismatch error prints.
- Generated files are never edited by hand. This phase changes one: `packages/protocol/PROTOCOL.md`, whose transport table gains the `mail` word (Task 6); `nix run .#write-files` writes it. `protocol.h` doesn't list the control words and doesn't change.
- Runtime ABI and protocol version stay 1: nothing is published yet. The new backend call and control word are additions, and Task 1 removes `ibusweb_install_*` without a bump.
- Stay close to nixpkgs: the Rime distribution uses `mkEngineManifest` as every other module does, and 5b's recipes are not touched.
- **Measured values.** `rime-host`'s peaks and timings exist only once it runs. A task never invents them: it writes `{{name}}` placeholders, runs the step that measures them, and replaces each with the printed value. Before each commit that touches a placeholder-bearing file, `grep -n '{{' <file>` prints nothing. The `heapBytes` a manifest declares is several MB over the measured break peak (`ceil(peak / MiB) + 4` MiB), not the next MiB.
- Run the checks covering what a task changes, `nix build .#checks.x86_64-linux.<name> -L`, and report which ran and what failed; never summarize a check you didn't run as passing.

### Decisions this plan makes where the spec is silent

- **Archives are pax.** Rime's common data links into the dictionaries' store paths with absolute targets of up to 114 bytes (5b's departure 13), past ustar's 100, and no relative target fits either. GNU tar writes pax with `ibusWeb.lib.archiveTarFlags`: `--format=pax`, `--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime` (pax would otherwise record each file's access and change times and name its extended headers after the writer's pid) and the `--sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner` engines' archives had. The host's test archives are built twice with their times changed and must come out the same bytes.
- **The host parses tar; C only ever wrote.** `libibus-web`'s streaming ustar extractor (`ibusweb_install_*`) and the host's own ustar framer (`entries.ts`), which read every header twice, give way to `modern-tar`'s `createTarDecoder({ strict: true })` (0.8.5, MIT, no dependencies), pinned exactly. The decompressed stream is cut into pieces of at most 64 KiB, which `beforePiece` gates as before, and piped through the decoder; each entry is written as it arrives, a file's body in pieces, so neither a whole archive nor a whole file is held. The decoder buffers up to 1 MiB before it pushes back.
- **What `modern-tar` does, strict, and what the host adds** (each a case in `archive.test.ts`): a header whose checksum doesn't match fails (`Invalid tar header checksum.`), and so does one summed as signed bytes, which some old writers did and the C extractor took; an archive cut short mid-header, mid-file, between members, before its end-of-archive blocks or after one of them fails (`Tar archive is truncated.`), as does an empty one; a lone zero block before a member fails (`Invalid tar header.`); zeros after the end-of-archive blocks are taken, anything else there fails (`Invalid EOF.`), where the C extractor ignored it. Leniencies: a pax `x` header's `path` and `linkpath` of any length are applied; a global `g` header's records apply to every member after it (a later one's raw records replace an earlier's, though what the earlier set, such as a name, stays), so a `path` there would rename every later entry; GNU's `L` and `K` long names are applied; a pax `size` record reframes the member's data; a pax record whose length runs past its newline leaves the newline in the value, one whose length falls short truncates it, and one with no length, a length that isn't a number or no key is skipped; a size field that isn't octal is read as a number all the same (`0000000001a` is 57), and GNU's base-256 is taken; a directory's or link's size field is ignored, their data taken as none; a type flag it doesn't know is a regular file; a header without ustar's magic is read. The host refuses a pax `size` record and a name or link target holding a NUL or a newline (`EINVAL`), checks every entry's name against the archive's own store path, and requires the bytes written to equal the manifest's `size`; a non-octal size or a misread record then fails the install by that count or by the next header's checksum. A non-ustar header, an unknown type and a directory's size are accepted where the C extractor refused them; the archives are the host's own builds.
- **The host writes through WasmFS's `FS`.** The runtime exports `FS` (`-sEXPORTED_RUNTIME_METHODS=HEAPU8,PThread,FS`, and `-sFORCE_FILESYSTEM=1`, without which the link leaves most of WasmFS's JavaScript API out). `FS` has no `fsync`; libc's is on the export list with the rest of libc, so the host calls `_fsync(fd)` and reads its errno through `___errno_location()`. `FS.unlink` and `FS.symlink` return the negative errno rather than throw it, unlike the other calls; the writer checks their returns. The errno values, `open()` flags and mode bits the writer uses come from `constants.json`'s new `fs`, which `constants.c` prints for the target. `FS.write` copies each piece into a `malloc`ed buffer of the runtime's.
- **The write policy moves to `src/worker/install/writer.ts` unchanged**, but for one thing: each piece written starts at a multiple of 64 KiB into its file and is whole but for the file's last, so a write covers the 16 KiB chunks the IndexedDB backend creates whole (the known gap of writes covering partial chunks goes; one for chunk sizes that don't divide 64 KiB replaces it). The limit refuses a file before its parents or the file are made (`EFBIG`); a path component that is a link fails `ENOTDIR`; a file or link replaces a link at its name, a link also replaces a file, and a link or file over a directory fails `EISDIR`; directories already there are kept, missing parents made; each entry takes the archive's mode plus the owner's read and write (and search, for a directory), new or there already; a file is opened with `O_TRUNC | O_NOFOLLOW`, `fchmod`ed and sized (`ftruncate`) before its data, then `fsync()`ed and closed; a hard link fails `EOPNOTSUPP`, a device, a FIFO, an absolute name, `..`, or a link with no target `EINVAL`. A refusal is `install <url>: "<entry>": -<errno>`. An `FS.ErrnoError` leaves the runtime fit to call: the writer closes the file it had open and the host refuses the install; anything else thrown from inside the runtime stops the host, with nothing closed.
- **The installer's tests run in a host, against the real runtime.** Two test requests the test build answers itself, `HostOp.install` (extract an archive, given by URL or as members the host builds, into a directory) and `HostOp.fs` (actions through `FS`, among them every call the installer makes, failing), run on a memory mount of the tests' own, so each case of `test-install.c` that still applies runs under Node and in both browsers on both runtimes. The fixtures move with them: `ibusWeb.runtime.installArchives` and `runtime/libibus-web/archives.nix` go, and `packages/worker-host/_archives.nix` builds the archives, pax, each under a store path, the refused ones too.
- **Waking a sleeping host for a message.** The host serves requests asleep in `ibusweb_wait()` inside the runtime, and a `postMessage` reaches it only through its event loop, which doesn't run then. So the transport gains a twelfth control word, `mail` (index 11, written by the page; the header holds 16 words, so the layout's size doesn't change): the page posts `PrepareEngine`, then `postMail()` bumps `mail` and `wake`. The relay forwards the wake, the host sees `mail` differ from the messages it has taken, and leaves its synchronous section for an excursion like the pool top-up's: it takes the messages in its event loop and installs, and between the install's steps it serves and pumps, waiting with `Atomics.waitAsync()`, so keys to engines already made go on during a 60 MB install. Only `PROTOCOL.md` documents the words; `protocol.h` doesn't change.
- **Message names.** Page to host: `PrepareEngine` = `{ type: "prepare-engine", engine }`, the shape of the host's own kebab-case messages. Host to page: `prepare-progress` `{ engine, bytes, total }` (unpacked bytes of file data written, of the size of the engine's store paths the storage lacked; the last has `bytes === total`; none when nothing is missing), `path-install` `{ engine, storePath, state: "installed" | "present", files, bytes, installMs, lockWaitMs, lockedAt, releasedAt }` per path (the lock fields are the path's install lock's, 0 when its marker was there before any lock), and `prepared` `{ engine, error? }` last. Each `PrepareEngine` gets exactly one `prepared`; for one engine they come in the order posted, and the page matches them so.
- **`wasmfs_idb_backend_set_writable` returns `int`**: 0, or `-EROFS` for opening a sealed backend's window, which stays shut for good; the seal and an opening window take one mutex, so a seal can't be undone by a racing open. A backend created with `WASMFS_IDB_READ_ONLY` starts with its window shut and can open it; one created without starts open. `fsync()` commits once a backend has ever been open (`everWritable`), which replaces "opened read-only". No JavaScript-library change: the read-only flag only ever decided the sweep on the JavaScript side.
- **Every host's data backend is created read-only** (no sweep: other hosts install into the database), and the base install at start goes through the window too, so there is one way to write data. The backend is sealed as the host closes, by a finalizer registered before the install starts, so a failed start seals it as before.
- **Markers.** A path's marker is `meta.paths/<storePath>` = `{ files, bytes }` in the version's database, written in a strict transaction on a host connection after the archive's files are `fsync()`ed, as `meta.installed` is. Under Node it is `<version>.paths/<hash>-<name>.installed` beside the version's directory, written as `.marking` and renamed; collection treats `<version>.paths` as one of the version's names, and removal deletes it with the markers, first.
- **An install lock per store path, and one install per path per Worker.** The base install keeps the version's install lock; each lazy store path installs under `ibus-web:install:<name>:<version>:<storePath>` (`enginePathInstallLock`, the store path encoded as the other names are), with a liveness channel of its own named after it. A Worker keeps a map from store path to its install in flight, so a prepare needing a path already being installed awaits that install rather than fetching it again (Rime's `rime_ice` and `double_pinyin_flypy` share `rime_ice`, `melt_eng` and `radical_pinyin`); each engine's progress sums its own missing paths. A prepare reads the markers first without a lock, since a marker is written last, and the install reads its path's marker again under the lock, since another host may have installed it meanwhile. A host takes several `PrepareEngine`s at once: it starts each as it arrives and returns to its synchronous section once all have ended.
- **The window is reference-counted** (`sharedWindow`): it opens as the first extraction starts and shuts as the last ends, so overlapping extractions of different paths share it; an extraction that threw from inside the runtime leaves it as it is, since the runtime can't be called after.
- **Extractions wait for the host's own transactions.** A marker read or write is a transaction on a connection of the host's own, which completes only through the host's event loop; an extraction's write, made synchronously on the host's thread, waits for the backend's transaction, which IndexedDB holds behind any earlier one over the same stores. So one extraction writing while another path's marker transaction was open deadlocked the host. The store counts its own open transactions, and the installer, before each write, waits while there are any (`quiet()`), checking again with no await between the check and the write.
- **The mail check follows the wake word's read.** The loop checks the `mail` word only after `step()` has read the runtime's wake word, so that mail posted after the check has moved the word the host then sleeps on.
- **Failures.** A failed install (a fetch, an archive the installer refuses, a lock wait past its limit, a marker that won't write) fails every prepare awaiting it, reported in `prepared.error`, and leaves the host serving; the window shuts when no other extraction runs. A call into the runtime that throws while installing stops the host, as any trap does. An unknown engine gets `prepared.error` `module <name> has no engine <engine>`; an engine without data of its own, or any engine on a memory mount, gets `prepared` at once.
- **The page: a selection doesn't wait in the router's mailbox.** `registry.prepare(module, engine)` posts `PrepareEngine` once per Worker and engine (memoized by connection; a failure is forgotten so the next try posts again), starting the module's Worker if it hasn't but without selecting it; an engine without data of its own resolves without starting anything; `registry.isPrepared(module, engine)` says whether the engine can be made as things are. When `reconcile` finds a surface wanting an engine whose data isn't there, it starts the download as a fiber of the router's own and returns, the surface on native input as during a module start; when the download ends a message re-enters the mailbox and makes the engine for the surfaces that still want it. `router.select(module, engine)` reconciles in the mailbox as before, then waits for the engine's data outside it (starting the download even with no surface focused) and resolves once a mailbox turn has made the engine. `selectionChanges` (the facade's `selectionchange`) reports the new selection at once, as it does while a module starts. Deselecting or selecting something else while the engine downloads cancels nothing: the download completes and stays installed, the stale selection's promise resolves, and no engine is made for it. A failed install fails a selection that still names the engine with `PrepareEngineError` (`_tag`, `module`, `engine`, `reason`, the Worker's message), exported from `@ibus-web/core` and `ibus-web`, treated as `CreateEngineError` is: the selection stands, the surface stays on native input, and the next focus tries again; a failure after the selection moved on reaches only the log, and only if a surface still wants the engine.
- **The facade's `prepare(module, engine)`** takes the engine by name (no default), and rejects for an unknown module or engine before anything starts. `install` events come from the registry's event stream, `{ module, engine, bytes, total }`.
- **Memory mounts** are sized as now: `memoryWithData` already sums every archive of the manifest, lazy ones included, and such a host installs them all at start.
- **`mkEngineManifest` needs no code change.** It passes descriptors through as they come, a Nix list or a JSON file, and its build decodes the manifest with `decodeModuleManifest`, which now checks each engine's `data`. The worker-host's fixtures gain `lazyDist`, the echo module with a second engine, `echo-lazy`, whose `data` is a store path of the closure, given as a Nix list; Rime's distribution gives them as a JSON file another derivation builds.
- **Fixtures.** `lazy.tar` and `lazy2.tar` are the test tree re-rooted under `/nix/store/11111111111111111111111111111111-test-lazy` and `…22222222222222222222222222222222-test-lazy2`, so scenarios reuse `tree`'s listing, size and stall point; `lazyEngineFor()` makes a module whose base data is the test module's schemas alone, so the base install stays below every scenario's stall point, with engines `lazy` and `shared` naming the first and `lazy2` the second. Two test-build instruments, `fetching` and `window`, report each archive fetch and each window opening and shutting, so scenarios can count fetches of a shared path and see one window across overlapping extractions; `pieceDelayMs` 20 slows each install enough that two overlap.
- **Proving cross-Worker visibility first.** WasmFS's `Directory::Handle::getChild()` (`system/lib/wasmfs/file.cpp` of the patched Emscripten 6.0.9) returns a child from the directory's `dcache` when it is there and otherwise asks the backend, caching only a child it found (`cacheChild`); `getEntries()` asks the backend every time. So WasmFS never caches an absence. Task 2 makes that a test of the backend, two backends over one database standing for two Workers, before anything relies on it; Task 6's `prepare-after-mount` repeats it end to end with two hosts.
- **Rime's distribution file** is `engines/rime/dist.nix`, merging `engine-data.json` into `engines.json` with jq, the name and mechanism 5d's plan reads. Its first build declares 256 MiB and 2 threads, a deliberately generous bound so `rime-host` can run and measure; Task 12 replaces both with the measured figures.
- **What `rime-host` covers**, as the spec's Testing row asks: start time; only base data installed at start; `rime:rime_ice`'s dictionaries installed by `PrepareEngine`, with progress ending at the total, and then `nihao` committing `你好`; a second engine sharing them (`rime:double_pinyin`) finding them all present; `rime:luna_pinyin` prepared in the same Worker and converting; a settings change starting maintenance while only some dictionaries are installed, with no warning; and the break and thread peaks against the manifest. Its workload opens `rime_ice` and one traditional engine, which is what the spec sizes the break by.

### Where this plan departs from the spec

- **Concurrent installs and a non-blocking selection (approved by the user while this plan was written).** The spec's "takes the install lock" and "`select(…)` … waits for it" read as one version-wide lock and a selection that holds the router until its data is there. This plan installs each store path under a lock of its own and never holds the router's mailbox for an install, as the decisions above say; `select` still resolves only once the engine is made.

- **No removal of a partial tree.** The spec says that for each missing path the host "removes whatever an interrupted install left under it" before extracting. This plan extracts over it instead. Within one version's database a store path names exactly one archive, and the installer's contract (`entryWriter` in `packages/worker-host/src/worker/install/writer.ts`, Task 1) already completes a tree an earlier run of the same archive left half-written: existing files are truncated and rewritten, directories kept, links replaced. Removing first would delete entries another host's WasmFS may already hold in its directory cache (its own failed install, say), leaving it stale objects over deleted inodes; extracting over keeps every file's and directory's inode. `prepare-interrupted` kills a host mid-path and checks that the next host's install is whole and its counts exact. The recovery from an interrupted *base* install is unchanged: the database is emptied first, as the spec's existing rule says.
- **Docs move into this phase.** The spec's Delivery puts per-engine data in `docs/engines.md`, `docs/storage.md`, `docs/worker-host.md` and `docs/ibus-web.md` in phase 5d. The repository's rule is that docs change with the code they describe, so each task here updates its pages; 5d's plan expects exactly that (its Task 0, Step 5). The design spec's own updates (§5.6's install window, R7, §5.4.4's descriptor) stay 5d's.
- **"A failed install fails the selection with a tagged reason, as a failed `CreateEngine` does."** It fails with `PrepareEngineError`, a class of its own whose `_tag` and `reason` say which step failed, handled as `CreateEngineError` is, rather than a `CreateEngineError`, so a page can tell a download that failed from an engine that refused to start.

### What was verified, and how

Spiked in a scratch clone (`git clone` of this repository at `master`, `e0f1d5d`, which has no 5b, so the generic part sat directly on master; nothing in it touches 5b's files). Every code block of Tasks 1–9 is the spike's code after oxfmt and hk's hook.

- **Built and run, passing, at the end of Task 9:** `checks.wasmfs-idb-browser` (196 cases in Chromium and Firefox, among them `writable`'s 8 and `visibility`'s 2); `checks.ibus-runtime-exports` (the new call exported exactly as the header declares it); `checks.wasmfs-idb-types`; `checks.protocol-node` (422, the 7 new manifest cases among them); `checks.worker-host-node` (67 units, `window.test.ts`'s 3 and the changed install-lifetime and archive tests among them); `worker-host-node-integration` (242, the 18 `prepare-*` cases among them) and `worker-host-browser-integration` (388, the 20 `prepare-*` cases among them); `checks.worker-host-browser` (8); `checks.core-node` (181); `checks.core-browser` (298, the four new switching cases among them); `checks.ibus-web-browser` (49); `hangul-host` (20), `table-host` (16), `mozc-host` (16), `m17n-host` (27); `checks."files:packages/protocol/PROTOCOL.md"` after `nix run .#write-files`; `nix develop -c hk check -S links` and oxfmt over the docs pages. `nix flake check --keep-going` (its hk step included), `nix develop -c hk check --all` and `nix build .#integration-checks -L` (`playwright-integration` 84 tests and the matrices above) all passed on the final spike.
- **Concurrency, confirmed in the spike.** Two engines' different store paths installed at once in one Worker (their locks held over the same 250–300 ms) and in two Workers racing for one path (one installed, one found it present after the other let go), with the window opened once and shut once across the overlap, and one fetch of a path two engines share. Reading `_wasmfs_idb_insert` in `src/libwasmfs_idb.js` confirms why disjoint paths are safe: a new inode's number comes from `meta.nextIno` inside the one read-write transaction over `meta`, `inodes` and `entries` that also adds the entry, and IndexedDB serializes overlapping read-write transactions across connections; entries are keyed `[parent, name]`, chunks `[inode, index]`, and each extraction keeps its state in a writer of its own. Two problems surfaced only under concurrency, and the plan's code fixes both: (1) a deadlock, an extraction's synchronous write waiting on the backend's transaction while IndexedDB held that behind another path's marker transaction on the host's own connection, which could complete only once the blocked thread ran its event loop (reproduced in 1 of 7 runs without `quiet()`: the trace showed one archive's last feed starting just after the other archive ended and went to mark itself); and (2) a lost wakeup, the mail word checked before `step()` read the wake word, so a message posted in between left the host asleep (1 run in about 4 in Chromium). With both fixes, `prepare-concurrent` and `prepare-shared` passed 12 runs in a row in Chromium and Firefox on both runtimes (96 runs), and the full matrices above passed.
- **Task 1, the installer, in a second spike** after 5b had shown the 114-byte links: built on the 5c spike, then applied alone to master (`e0f1d5d`) in a worktree. On master alone: `checks.worker-host-node` (87), `checks.worker-host-browser` (8), `checks.libibus-web-tests` (7 suites, 63 cases), `checks.ibus-runtime-exports`, `checks.ibus-runtime-load` (31), `checks.hangul-host` (20), `checks.tools-pack-licenses-tarball`, `worker-host-node-integration` (270) and `worker-host-browser-integration` (400), and `nix develop -c hk check --all` passed. With Tasks 2–9 over it (the whole spike): `checks.worker-host-node` (90), `worker-host-node-integration` (291) and `worker-host-browser-integration` (440), `checks.worker-host-browser`, `libibus-web-tests`, `libibus-web-cast-audit`, `libibus-web-vendored`, `ibus-runtime-exports`, `ibus-runtime-exports-script`, `ibus-runtime-load`, `ibus-runtime-side-imports`, `worker-host-side-imports`, `worker-host-engine-distribution-identity`, `hangul-host` (20), `table-host` (16), `mozc-host` (16), `m17n-host` (27), `core-node` (181), `core-browser` (298), `ibus-web-browser` (49), `example-demo-smoke`, `tools-pack-licenses` (35), `tools-pack-licenses-packages`, `tools-pack-licenses-tarball`, `tools-bundle-scan` (6), `typescript-package-metadata`, `toolchain-cache` and `hk check --all` passed; `prepare-concurrent` and `prepare-shared` passed 12 runs in a row in Chromium and Firefox on both runtimes again (96 runs). Every `FS` call the installer makes, made to fail, gave the errno libc gives (`EEXIST`, `ENOENT`, `ENOTDIR`, `EISDIR`, `ELOOP` for `O_NOFOLLOW` on a link, `EBADF` on a closed descriptor, `fsync` included) under Node and in both browsers; the only surprise was `FS.unlink` and `FS.symlink` returning their errno instead of throwing it. A pax archive of the real `ibus-web-rime-common` from the 5b spike (293 entries, 89 links, the longest target 114 bytes; GNU tar gave the same bytes twice) installed whole under Node on both runtimes, every entry's type and size, every link's target and 64 YAML files' contents as the archive has them; it wasn't run in a browser. The runtime's `ibus-runtime.js` grew 8,993 bytes (1,811 as Brotli) and its `.wasm` shrank 3,558 (1,135 as Brotli); the host's Worker script grew 21,947 bytes (5,991 gzipped).
- **Task 5 on its own:** Task 5's files applied over the protocol commit alone (without Task 6) passed `tsc -b --noEmit packages/worker-host/tsconfig.json` and `checks.worker-host-node` before the window became shared; the shared window and `quiet()` were then added to the same files and are covered by `window.test.ts` and the full run.
- **Read, not run:** WasmFS's directory cache (`file.cpp`, `getChild`, `cacheChild`, `getEntries`); the installer's contract on re-extraction; 5d's plan, for the names it reads from this phase (`engines/rime/dist.nix`, `enginesWithData`, `passthru.heapBytes`, the `install` event's last `bytes === total`, the docs sections).
- **Not verified, because 5b doesn't exist yet:** everything in Tasks 10–12. The distribution's build, whether Rime starts with only `ibus-web-rime-common` installed (its maintenance at startup walks the deployed schemas, whose dictionaries' links into `build/` dangle until their engines are prepared; `rime-host`'s start test is the first check of that, and Task 12 says what to do if it logs), every expectation drawn from Rime's data, the install sizes and times, and the peaks. Task 10 checks 5b's names before anything uses them.
- **Not run in the spike:** the suites at each intermediate commit (the spike's commits don't follow the task boundaries exactly).

## Interfaces later phases rely on

- **Installer:** pax archives (`ibusWeb.lib.archiveTarFlags`); the runtime exports `FS` and `constants.json` holds `fs`; `entryWriter` (`src/worker/install/writer.ts`) and `extract` (`src/worker/install/archive.ts`) in the host; `ibusweb_install_*` no longer exists. Tests: `HostOp.install`, `HostOp.fs`, `TestData.archives.installer`, `test/shared/tar.ts`, `packages/worker-host/_archives.nix`.
- **Backend:** `int wasmfs_idb_backend_set_writable(backend_t backend, bool writable)` in `ibus-web/wasmfs-idb.h` (0, or `-EROFS` for a sealed backend); `WASMFS_IDB_READ_ONLY` starts a backend with its window shut.
- **Protocol:** `EngineDescriptor.data?: readonly string[]` (store paths of the module's `data`); `lazyStorePaths(manifest): ReadonlySet<string>` from `@ibus-web/protocol`; `Word.mail` = 11 in `@ibus-web/protocol/transport`.
- **Storage:** markers `meta.paths/<storePath>` = `{ files, bytes }` beside `meta.installed`; under Node `<dir>/data/<version>.paths/<hash>-<name>.installed`; `enginePathMarker(storePath)` and `enginePathInstallLock(engine, storePath)` (`ibus-web:install:<name>:<version>:<encoded store path>`) in the host's `src/shared/naming.ts`; `sharedWindow(store, changed?)` and `DataStore.quiet()` in `src/worker/install/store.ts`.
- **Worker host (`@ibus-web/worker-host`):** `PrepareEngine` = `{ type: "prepare-engine"; engine: string }`; `postMail(views: ControlViews): void`; `HostMessage` gains `prepare-progress` `{ engine, bytes, total }`, `path-install` (`PathInstallReport`, with its path lock's `lockWaitMs`, `lockedAt`, `releasedAt`) and `prepared` (`PreparedReport`, `{ engine, error? }`); a host takes several `PrepareEngine`s at once. Tests: `RunningHost.prepare(engine): Promise<Prepared>`; `TestData.engines.lazy`, `TestData.archives.lazy` and `lazy2`; the instruments' `fetching` and `window` messages; `LAZY_PATH` and `lazyEngineFor()` in `test/shared/prepare.ts`; `PageSession.create()` prepares an engine with data of its own before `CreateEngine`.
- **Core (`@ibus-web/core`):** `Connection.prepare(engine: string, progress?: PrepareProgress): Promise<void>`; `PrepareFailed`; `type PrepareProgress = (bytes: number, total: number) => void`; `KeyConnection` includes `prepare`; `ModuleRegistryService.prepare(name: string, engine: string): Effect.Effect<void, Error>` and `isPrepared(name: string, engine: string): boolean`; a router that never holds its mailbox for an install; `ModuleEvent` `{ _tag: "install"; module; engine; bytes; total }`; `PrepareEngineError` (`_tag: "PrepareEngineError"`, `module`, `engine`, `reason`).
- **Facade (`ibus-web`):** `IbusWeb.prepare(module: string, engine: string): Promise<void>`; `IbusWebEventMap.install: CustomEvent<{ module: string; engine: string; bytes: number; total: number }>`, the last of an install with `bytes === total`; `PrepareEngineError` exported.
- **Rime:** `packages.ibus-web-rime-dist` in `engines/rime/dist.nix` (`mkEngineManifest`, each engine's dictionaries as its `data` through `enginesWithData`, passthru `heapBytes`); `checks.rime-host` (`engines/rime/checks/host/checks.nix`, suite `packages/worker-host/test/engines/rime.test.ts`).
- **Docs:** `docs/storage.md` `### An engine's own data`; `docs/engines.md` `### An engine's own data`; `docs/worker-host.md` `### Excursions` and the messages table; `docs/core.md` and `docs/ibus-web.md` on `prepare` and `install`; `docs/rime.md` `## Distribution` and `rime-host` under `## Checks`.

## File structure

| Path | Change |
| --- | --- |
| `modules/flake/lib.nix`, `modules/engines/manifest.nix`, `modules/engines/options.nix` | `archiveTarFlags`: engine archives are pax |
| `runtime/ibus-runtime/module.nix`, `constants.c`, `tests/load.test.ts` | Export `FS`; `constants.json`'s `fs` |
| `runtime/libibus-web/src/install.c`, `tests/test-install.c`, `archives.nix` | Delete: the C extractor, its tests and their fixtures |
| `runtime/libibus-web/include/ibus-web/runtime.h`, `meson.build`, `meson.options`, `tests/meson.build`, `checks.nix`, `options.nix` | Without the extractor |
| `packages/worker-host/package.json`, `pnpm-lock.yaml`, `modules/typescript/workspace.nix`, `tsdown.config.ts`, READMEs | `modern-tar`, bundled into the Worker scripts |
| `packages/worker-host/src/worker/install/writer.ts` | Create: writing entries through `FS` |
| `packages/worker-host/src/worker/install/archive.ts`, `entries.ts` (delete) | The decoder, the store-path check, the pieces |
| `packages/worker-host/src/worker/runtime.ts`, `layers/runtime.ts`, `startup.ts`, `src/shared/messages.ts`, `index.ts`, `config.ts` | `FS`, `fsync`, `FsConstants` |
| `packages/worker-host/_archives.nix`, `test/archives/make-tree.py` (moved), `module.nix` | Create: the test archives, pax |
| `packages/worker-host/test/shared/tar.ts`, `installer.ts`, `test/worker/install-ops.ts` | Create: the archive builder, the installer's scenarios, `HostOp.install` and `HostOp.fs` |
| `packages/worker-host/test/node/archive.test.ts` | Rewrite: the decoder's and the installer's units |
| `runtime/wasmfs-idb/tests/visibility.cpp` | Create: a file another backend creates after a missed lookup is found |
| `runtime/wasmfs-idb/include/ibus-web/wasmfs-idb.h`, `src/idb_backend.cpp` | `wasmfs_idb_backend_set_writable`; `everWritable` for `fsync()` |
| `runtime/wasmfs-idb/tests/writable.cpp` | Create: the window's tests |
| `runtime/wasmfs-idb/checks.nix` | The two new programs in `checks.wasmfs-idb-browser` |
| `packages/protocol/src/manifest.ts`, `src/index.ts`, `test/engine/manifest.test.ts` | `EngineDescriptor.data`, `lazyStorePaths`, the decoding checks |
| `packages/protocol/src/transport/layout.ts`, `PROTOCOL.md` (generated) | `Word.mail` |
| `packages/worker-host/src/shared/naming.ts`, `messages.ts`, `control.ts`, `index.ts` | `enginePathMarker`; `PrepareEngine` and the host's new messages; `postMail` |
| `packages/worker-host/src/worker/runtime.ts` | `_wasmfs_idb_backend_set_writable` in the runtime surface |
| `packages/worker-host/src/worker/install/archive.ts` | Installs a given list of archives; `written`, `fetching` and `quiet` hooks; `outside` exported |
| `packages/worker-host/src/worker/install/store.ts` | Read-only backend, the window, path markers, `sharedWindow`, `quiet()` |
| `packages/worker-host/src/worker/install/wait.ts` | `announce`, a path install's liveness channel |
| `packages/worker-host/src/worker/instruments.ts`, `test/worker/instruments.ts`, `test/shared/testing.ts` | The `fetching` and `window` instruments |
| `packages/worker-host/test/node/window.test.ts` | Create: the shared window's units |
| `packages/worker-host/src/worker/install/provide.ts` | Base data only, through the window; the seal at close; `prepare` |
| `packages/worker-host/src/worker/install/prepare.ts` | Create: installing an engine's own data |
| `packages/worker-host/src/worker/mail.ts` | Create: the page's messages after `HostInit` |
| `packages/worker-host/src/worker/layers/worker.ts`, `layers/storage.ts`, `index.ts`, `loop.ts`, `serve.ts` | `onMessage`, `mail`, `prepare`; the mail excursion |
| `packages/worker-host/module.nix`, `_archives.nix` | `lazy.tar`, `lazy2.tar`; `lazyDist` |
| `packages/worker-host/test/worker/host.ts`, `test/browser/layers.test.ts` | `onMessage` in the test environments |
| `packages/worker-host/test/node/install-lifetime.test.ts`, `config.ts`, `harness.ts`, `scenarios.test.ts` | The store's new members; fixtures; the scenarios |
| `packages/worker-host/test/shared/harness.ts`, `install.ts`, `prepare.ts` (create), `test/browser/scenarios.test.ts` | `RunningHost.prepare`; shared helpers; the scenarios |
| `packages/core/src/connection/connection.ts`, `router/keystroke.ts`, `page/index.ts` | `Connection.prepare`, `PrepareFailed` |
| `packages/core/src/services/modules.ts`, `router/router.ts` | `registry.prepare`, `isPrepared`, `PrepareEngineError`, `install` events; downloads outside the router's mailbox |
| `packages/core/test/node/support/fake-worker.ts`, `test/node/connection/connection.test.ts`, `test/shared/router.ts`, `test/node/router/services.test.ts`, `test/browser/support/dom.ts`, `test/browser/router/switching.test.ts` | Fakes and tests |
| `packages/ibus-web/src/index.ts`, `test/browser/facade.test.ts` | `prepare`, `install`, `PrepareEngineError` |
| `engines/rime/dist.nix` | Create: `packages.ibus-web-rime-dist` |
| `engines/rime/checks/host/checks.nix`, `packages/worker-host/test/engines/rime.test.ts` | Create: `checks.rime-host` |
| `packages/worker-host/test/engines/page-session.ts` | Prepare before `CreateEngine` |
| `docs/storage.md`, `docs/worker-host.md`, `docs/engines.md`, `docs/core.md`, `docs/ibus-web.md`, `docs/known-gaps.md`, `docs/rime.md`, `docs/testing.md` | Per-engine data; Rime's distribution and `rime-host` |

---

### Task 0: Create the branch

**Files:** none.

- [ ] **Step 1: Branch from 5b**

```bash
nix develop -c git switch -c typedrat/m5c-per-engine-data typedrat/m5b-rime-under-node
nix develop -c git log --oneline -1
```

Expected: the branch is created at 5b's tip. Tasks 1–9 touch none of 5b's files (Task 1 changes how every distribution's archives are built, 5b's included, but none of its recipes); Task 10 checks 5b's names before the Rime tasks use them.

---

### Task 1: The host installs engine data with `modern-tar`, writing through WasmFS's `FS`

5b's departure 13: `ibus-web-rime-common` links into the dictionaries' store paths with absolute targets of up to 114 bytes, and the distribution's ustar archives hold 100, so Task 11's distribution can't be built until the archives and the installer carry longer ones. This task makes engine archives pax, which keeps a long name or link target in an extended header, and replaces the installer: `libibus-web`'s C extractor (`ibusweb_install_*`) goes, and the host decodes each archive with `modern-tar`'s strict streaming decoder and writes each entry, as its bytes arrive, through WasmFS's JavaScript `FS`, which the runtime now exports. The write policy moves into TypeScript unchanged: the size limit checked before anything of a file is made, nothing written through a link, links and files replacing links, the owner's bits added, files sized before their data, each `fsync()`ed, and the exact count before the marker. Everything later in this plan installs through it.

**Files:**
- Modify: `modules/flake/lib.nix` (`ibusWeb.lib.archiveTarFlags`), `modules/engines/manifest.nix`, `modules/engines/options.nix`
- Modify: `runtime/ibus-runtime/module.nix`, `runtime/ibus-runtime/constants.c`, `runtime/ibus-runtime/tests/load.test.ts`
- Delete: `runtime/libibus-web/src/install.c`, `runtime/libibus-web/tests/test-install.c`, `runtime/libibus-web/archives.nix`
- Modify: `runtime/libibus-web/include/ibus-web/runtime.h`, `runtime/libibus-web/meson.build`, `runtime/libibus-web/meson.options`, `runtime/libibus-web/tests/meson.build`, `runtime/libibus-web/checks.nix`, `runtime/libibus-web/options.nix`
- Move: `runtime/libibus-web/tests/archives/make-tree.py` to `packages/worker-host/test/archives/make-tree.py`
- Modify: `packages/worker-host/package.json`, `pnpm-lock.yaml`, `modules/typescript/workspace.nix` (`pnpmDeps`), `packages/worker-host/tsdown.config.ts`, `packages/worker-host/README.md`, `packages/ibus-web/README.md`
- Create: `packages/worker-host/_archives.nix`, `packages/worker-host/src/worker/install/writer.ts`
- Rewrite: `packages/worker-host/src/worker/install/archive.ts`; delete `packages/worker-host/src/worker/install/entries.ts`
- Modify: `packages/worker-host/module.nix`, `src/worker/runtime.ts`, `src/worker/layers/runtime.ts`, `src/worker/startup.ts`, `src/worker/instruments.ts`, `src/shared/messages.ts`, `src/shared/index.ts`, `src/shared/config.ts`
- Create (tests): `packages/worker-host/test/shared/tar.ts`, `test/shared/installer.ts`, `test/worker/install-ops.ts`
- Rewrite (tests): `packages/worker-host/test/node/archive.test.ts`
- Modify (tests): `packages/worker-host/test/node/startup.test.ts`, `test/node/config.ts`, `test/node/scenarios.test.ts`, `test/browser/scenarios.test.ts`, `test/shared/harness.ts`, `test/shared/install.ts`, `test/shared/testing.ts`, `test/worker/instruments.ts`
- Docs: `docs/engines.md`, `docs/storage.md`, `docs/runtime.md`, `docs/worker-host.md`, `docs/known-gaps.md`

**Interfaces:**
- Consumes: nothing of this phase.
- Produces: `ibusWeb.lib.archiveTarFlags`; the runtime's `FS` export and `constants.json`'s `fs` (`FsConstants`: `errno`, `open`, `mode`); `RuntimeHandle.fs`; `Runtime.FS` (`EmscriptenFs`), `_fsync`, `___errno_location`; in `src/worker/install/writer.ts`, `entryWriter(handle, dir, limit): EntryWriter` (`directory`, `symlink`, `file(name, mode, size): FileWriter`, `written`, `abandon()`); in `src/worker/install/archive.ts`, `extract(handle, source, what, dir, storeName, limit, tally, hooks): Promise<Written>`, `ExtractHooks`, `placeEntry`, `relativeName`, and `installArchives(handle, engine, hooks)` as before; tests: `HostOp.install` (`InstallOpRequest`, `InstallOpReply`) and `HostOp.fs` (`FsAction`, `FsResult`), `TestData.archives.installer` (`InstallerArchives`), `test/shared/tar.ts`'s archive builder, the installer scenarios in `test/shared/installer.ts`, `counts` exported from `test/shared/install.ts`; `packages/worker-host/_archives.nix` (`dataName`, `longName`, `refusedName`).

- [ ] **Step 1: Add `modern-tar`**

`modern-tar` 0.8.5 (MIT, no dependencies, published 2026-09-06) is the decoder. Pin it exactly, then install and take the new `pnpmDeps` hash from the build's mismatch error:

```bash
nix develop -c sh -c 'cd packages/worker-host && pnpm add --save-exact modern-tar@0.8.5'
```

If the dev shell won't build because `pnpmDeps` no longer matches the lockfile, run the same `pnpm add` under `nix shell --inputs-from . nixpkgs#pnpm nixpkgs#nodejs` instead. Then set `hash = "";` in `modules/typescript/workspace.nix`'s `pnpmDeps`, run `nix develop -c true`, and put the `got:` value it prints in its place (`sha256-3QRJKBqKfsGLd+fpBjlgHtugHKbJaNYeRgQc7q0XUqc=` in the spike, from master's lockfile). `packages/worker-host/package.json`'s dependencies end:

```json
    "brotli-dec-wasm": "catalog:",
    "modern-tar": "0.8.5"
```

The host's Worker scripts must stay self-contained, so bundle it. In `packages/worker-host/tsdown.config.ts`:

```diff
diff --git a/packages/worker-host/tsdown.config.ts b/packages/worker-host/tsdown.config.ts
--- a/packages/worker-host/tsdown.config.ts
+++ b/packages/worker-host/tsdown.config.ts
@@ -39,7 +39,7 @@ const worker = (name: string, source: string, tsconfig: string): UserConfig => (
   // node:fs/promises is imported lazily, only when running under Node; a
   // browser never reaches that import.
   deps: {
-    alwaysBundle: [/^@ibus-web\/protocol(?:\/|$)/, "effect", /^effect\//, /^brotli-dec-wasm/],
+    alwaysBundle: [/^@ibus-web\/protocol(?:\/|$)/, "effect", /^effect\//, /^brotli-dec-wasm/, "modern-tar"],
     neverBundle: [/^node:/],
     onlyBundle: false,
   },
```

and say so where the READMEs list what the scripts bundle:

```diff
diff --git a/packages/ibus-web/README.md b/packages/ibus-web/README.md
--- a/packages/ibus-web/README.md
+++ b/packages/ibus-web/README.md
@@ -26,6 +26,6 @@ distributions and this package's `dist/host/` directory (exported as `ibus-web/h
 Deployment, the full API and settings are described in
 [docs/ibus-web.md](https://github.com/synapdeck/ibus-web/blob/master/docs/ibus-web.md).
 
-Licensed under MIT OR Apache-2.0, at your option. The Worker scripts in `dist/host/` bundle `effect` and
-`brotli-dec-wasm`; their licenses are in `LICENSES/`. Engines are licensed separately (ibus-hangul is GPL-2.0-or-later)
+Licensed under MIT OR Apache-2.0, at your option. The Worker scripts in `dist/host/` bundle `effect`, `brotli-dec-wasm`
+and `modern-tar`; their licenses are in `LICENSES/`. Engines are licensed separately (ibus-hangul is GPL-2.0-or-later)
 and run only inside their Workers, never in your page's bundle.
diff --git a/packages/worker-host/README.md b/packages/worker-host/README.md
--- a/packages/worker-host/README.md
+++ b/packages/worker-host/README.md
@@ -12,5 +12,5 @@ layout, the messages and the storage names.
 Most applications use [`ibus-web`](../ibus-web/README.md), which ships these scripts as `ibus-web/host/*`. The design is
 in [docs/worker-host.md](https://github.com/synapdeck/ibus-web/blob/master/docs/worker-host.md).
 
-The Worker scripts bundle `effect` and `brotli-dec-wasm`; their licenses are in `LICENSES/`. The package itself is
-licensed under MIT OR Apache-2.0, at your option.
+The Worker scripts bundle `effect`, `brotli-dec-wasm` and `modern-tar`; their licenses are in `LICENSES/`. The package
+itself is licensed under MIT OR Apache-2.0, at your option.
```

`tools/pack-licenses` finds the bundled package in the Worker scripts' source maps and copies `modern-tar`'s licence into the tarball's `LICENSES/`.

- [ ] **Step 2: Write the failing tests**

The tests build archives byte by byte, so they can be wrong in exactly the way a case needs. Create `packages/worker-host/test/shared/tar.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Tar archives the tests write byte by byte, so that they can be wrong in
// exactly the way a test needs: as JSON, a member can cross from the page
// to a host, which builds the archive there.

const BLOCK = 512;

// A member: a ustar header, then its data padded to a whole block.
export interface Member {
  name: string;
  // The type flag; "0", a regular file, if none.
  type?: string;
  mode?: number;
  // The data, as text or as `size` bytes of a pattern no zeros can pass
  // for, starting at byte `from` of it.
  data?: string | { size: number; from?: number };
  linkname?: string;
  prefix?: string;
  // The size field's 12 bytes as given, rather than the data's length.
  sizeField?: readonly number[];
  // The checksum's octal value as given, rather than the header's.
  checksum?: number;
  // Checksummed as some old writers do, summing the bytes as signed, with
  // bytes that sum differently either way in the owner's name.
  signedSum?: boolean;
}

const encoder = new TextEncoder();

// The pattern's byte at offset: never zero, and different from its
// neighbours.
export const patternByte = (offset: number): number => (offset % 251) + 1;

export const pattern = (size: number, from = 0): Uint8Array => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = patternByte(from + i);
  return bytes;
};

const dataOf = ({ data }: Member): Uint8Array =>
  data === undefined
    ? new Uint8Array()
    : typeof data === "string"
      ? encoder.encode(data)
      : pattern(data.size, data.from);

const padded = (size: number): number => Math.ceil(size / BLOCK) * BLOCK;

// Copies at most length bytes of text, leaving out the NUL when it fills
// the field.
const put = (block: Uint8Array, offset: number, length: number, text: string): void => {
  block.set(encoder.encode(text).subarray(0, length), offset);
};

const octal = (value: number, digits: number): string => `${value.toString(8).padStart(digits, "0")}\0`;

export const header = (member: Member, size: number): Uint8Array => {
  const block = new Uint8Array(BLOCK);
  put(block, 0, 100, member.name);
  put(block, 100, 8, octal(member.mode ?? 0o644, 7));
  put(block, 108, 8, octal(0, 7));
  put(block, 116, 8, octal(0, 7));
  if (member.sizeField === undefined) put(block, 124, 12, octal(size, 11));
  else block.set(member.sizeField.slice(0, 12), 124);
  put(block, 136, 12, octal(0, 11));
  put(block, 156, 1, member.type ?? "0");
  put(block, 157, 100, member.linkname ?? "");
  put(block, 257, 6, "ustar\0");
  put(block, 263, 2, "00");
  put(block, 345, 155, member.prefix ?? "");
  if (member.signedSum === true) block.fill(0xff, 265, 281);
  block.fill(0x20, 148, 156);
  const sum =
    member.checksum ??
    block.reduce((total, byte) => total + (member.signedSum === true && byte >= 0x80 ? byte - 0x100 : byte), 0);
  put(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
};

export const member = (spec: Member): Uint8Array => {
  const data = dataOf(spec);
  const bytes = new Uint8Array(BLOCK + padded(data.length));
  bytes.set(header(spec, data.length), 0);
  bytes.set(data, BLOCK);
  return bytes;
};

// A pax record: its own length in decimal, then the key and value.
export const paxRecord = (key: string, value: string): string => {
  const body = encoder.encode(` ${key}=${value}\n`).length;
  let length = body + 1;
  while (body + String(length).length !== length) length = body + String(length).length;
  return `${length} ${key}=${value}\n`;
};

// A pax extended header ("x") or global header ("g") holding the records,
// or the text as given.
export const pax = (records: Readonly<Record<string, string>> | string, type: "x" | "g" = "x"): Member => ({
  name: type === "g" ? "pax_global_header" : "PaxHeaders/entry",
  type,
  data:
    typeof records === "string"
      ? records
      : Object.entries(records)
          .map(([key, value]) => paxRecord(key, value))
          .join(""),
});

// GNU's long name ("L") or long link target ("K") for the next member.
export const gnuLong = (type: "L" | "K", value: string): Member => ({
  name: "././@LongLink",
  type,
  data: `${value}\0`,
});

export const END = new Uint8Array(2 * BLOCK);

export const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

// An archive of the members, ended as tar ends one unless end is false.
export const archive = (members: readonly Member[], end = true): Uint8Array =>
  concat(...members.map(member), ...(end ? [END] : []));
```

Replace `packages/worker-host/test/node/archive.test.ts` with the decoder's cases, the installer's checks of each entry, and its writes over a file system that records its calls. The decoder's cases pin down what the installer leaves to `modern-tar` (the decisions above list them):

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the installer leaves to modern-tar's strict decoder, and what it
// checks itself: these run the decoder alone, and the installer over a file
// system that only records what it was asked to do.

import { createTarDecoder, type TarHeader } from "modern-tar";
import { describe, expect, test } from "vitest";
import { extract, placeEntry, relativeName } from "../../src/worker/install/archive.ts";
import type { FsConstants } from "../../src/shared/messages.ts";
import { RuntimeRefused, type EmscriptenFs, type RuntimeHandle } from "../../src/worker/runtime.ts";
import { archive, concat, END, gnuLong, member, pax, type Member } from "../shared/tar.ts";

const BASE = "00000000000000000000000000000000-data";

const fs: FsConstants = {
  errno: { EEXIST: 20, EFBIG: 22, EINVAL: 28, EISDIR: 31, ENOENT: 44, ENOTDIR: 54, EOPNOTSUPP: 138 },
  open: { O_WRONLY: 1, O_CREAT: 64, O_TRUNC: 512, O_NOFOLLOW: 131072 },
  mode: { S_IFMT: 61440, S_IFDIR: 16384, S_IFLNK: 40960 },
};

// The bytes as a stream in pieces of the size.
const streamOf = (bytes: Uint8Array, piece: number): ReadableStream<Uint8Array> => {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) controller.close();
      else controller.enqueue(bytes.slice(at, (at += piece)));
    },
  });
};

interface Decoded {
  headers: TarHeader[];
  data: string[];
  error?: string;
}

const text = new TextDecoder();

// Every entry the strict decoder gives for the archive, fed in pieces of the
// size, with its data, and the error that ended it early, if any.
const decode = async (bytes: Uint8Array, piece = 512): Promise<Decoded> => {
  const decoded: Decoded = { headers: [], data: [] };
  const entries = streamOf(bytes, piece)
    .pipeThrough(createTarDecoder({ strict: true }))
    .getReader();
  try {
    for (;;) {
      const next = await entries.read();
      if (next.done) break;
      decoded.headers.push(next.value.header);
      decoded.data.push(text.decode(await new Response(next.value.body).arrayBuffer()));
    }
  } catch (error) {
    decoded.error = (error as Error).message;
  }
  return decoded;
};

const file = (name: string, data = "data\n", more: Partial<Member> = {}): Member => ({ name, data, ...more });

describe("the strict decoder", () => {
  test("refuses a header whose checksum doesn't match", async () => {
    const bytes = archive([file(`${BASE}/a`), file(`${BASE}/b`)]);
    bytes[1024] ^= 1;
    const { headers, error } = await decode(bytes);
    expect(headers.map(({ name }) => name)).toEqual([`${BASE}/a`]);
    expect(error).toBe("Invalid tar header checksum.");
  });

  test("refuses a header summed as signed bytes", async () => {
    expect((await decode(archive([file(`${BASE}/a`, "a", { signedSum: true })]))).error).toBe(
      "Invalid tar header checksum.",
    );
  });

  test.each([
    ["mid-header", 512 + 512 + 100],
    ["mid-file", 512 + 512 + 512 + 2],
    ["between members", 512 + 512],
    ["without its end-of-archive blocks", 512 + 512 + 512 + 512],
    ["after one end-of-archive block", 512 + 512 + 512 + 512 + 512],
  ])("refuses an archive cut short %s", async (_, cut) => {
    const bytes = archive([file(`${BASE}/a`), file(`${BASE}/b`, "b".repeat(600))]).subarray(0, cut);
    expect((await decode(bytes, 7)).error).toBe("Tar archive is truncated.");
  });

  test("refuses a lone zero block before a member", async () => {
    const bytes = concat(member(file(`${BASE}/a`)), new Uint8Array(512), member(file(`${BASE}/b`)), END);
    expect((await decode(bytes)).error).toBe("Invalid tar header.");
  });

  test("takes zeros after the end-of-archive blocks, and refuses anything else", async () => {
    const bytes = archive([file(`${BASE}/a`)]);
    expect((await decode(concat(bytes, new Uint8Array(9216)))).error).toBeUndefined();
    expect((await decode(concat(bytes, new TextEncoder().encode("trailing")))).error).toBe("Invalid EOF.");
  });

  test("takes a name and a link target longer than ustar's from a pax header", async () => {
    const name = `${BASE}/${"n".repeat(120)}.txt`;
    const target = `/nix/store/${"t".repeat(120)}/share/data`;
    const { headers, data, error } = await decode(
      archive([
        pax({ path: name, mtime: "0" }),
        file(`${BASE}/short`, "long\n"),
        pax({ linkpath: target }),
        { name: `${BASE}/link`, type: "2" },
      ]),
      13,
    );
    expect(error).toBeUndefined();
    expect(headers.map(({ name, type, linkname }) => [name, type, linkname])).toEqual([
      [name, "file", ""],
      [`${BASE}/link`, "symlink", target],
    ]);
    expect(data[0]).toBe("long\n");
  });

  // A later global header's records replace an earlier one's, though what
  // the earlier one set, such as a name, stays.
  test("applies a global header's records to every member after it", async () => {
    const { headers, error } = await decode(
      archive([
        pax({ comment: "global" }, "g"),
        file(`${BASE}/a`),
        pax({ path: "elsewhere/x" }, "g"),
        file(`${BASE}/b`),
      ]),
    );
    expect(error).toBeUndefined();
    expect(headers.map(({ name, pax }) => [name, pax?.["comment"]])).toEqual([
      [`${BASE}/a`, "global"],
      ["elsewhere/x", undefined],
    ]);
  });

  test("takes GNU's long names and link targets", async () => {
    const name = `${BASE}/${"g".repeat(150)}`;
    const target = `/nix/store/${"k".repeat(150)}`;
    const { headers, error } = await decode(
      archive([gnuLong("L", name), file(`${BASE}/x`), gnuLong("K", target), { name: `${BASE}/link`, type: "2" }]),
    );
    expect(error).toBeUndefined();
    expect(headers.map(({ name, linkname }) => [name, linkname])).toEqual([
      [name, ""],
      [`${BASE}/link`, target],
    ]);
  });

  test("frames a member's data by a pax size record", async () => {
    const { headers, data, error } = await decode(
      archive([
        pax({ size: "3" }),
        file(`${BASE}/a`, "abc", { sizeField: [...new TextEncoder().encode("00000000007\0")] }),
      ]),
    );
    expect(error).toBeUndefined();
    expect(headers.map(({ size, pax }) => [size, pax?.["size"]])).toEqual([[3, "3"]]);
    expect(data).toEqual(["abc"]);
  });

  test.each([
    ["a length past its newline", "30 path=short\n", `short\n`],
    ["a length short of its newline", "13 path=short\n", "shor"],
  ])("misreads a pax record with %s", async (_, records, name) => {
    const { headers, error } = await decode(archive([pax(records), file(`${BASE}/a`)]));
    expect(error).toBeUndefined();
    expect(headers.map(({ name }) => name)).toEqual([name]);
  });

  test.each([
    ["no length", "path=short\n"],
    ["a length that isn't a number", "x2 path=short\n"],
    ["no key", "9 =value\n"],
  ])("ignores a pax record with %s", async (_, records) => {
    const { headers, error } = await decode(archive([pax(records), file(`${BASE}/a`)]));
    expect(error).toBeUndefined();
    expect(headers.map(({ name }) => name)).toEqual([`${BASE}/a`]);
  });

  test("reads a size field that isn't octal as a number all the same", async () => {
    const { headers, error } = await decode(
      archive([file(`${BASE}/a`, "12345", { sizeField: [...new TextEncoder().encode("0000000001a\0")] })]),
    );
    expect(error).toBeUndefined();
    expect(headers.map(({ size }) => size)).toEqual([57]);
  });

  test("takes GNU's base-256 size", async () => {
    const { headers, data } = await decode(
      archive([file(`${BASE}/a`, "12345", { sizeField: [0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5] })]),
    );
    expect(headers.map(({ size }) => size)).toEqual([5]);
    expect(data).toEqual(["12345"]);
  });

  test("reads a whole 100-byte name and 155-byte prefix", async () => {
    const name = "n".repeat(100);
    const prefix = "p".repeat(155);
    const { headers } = await decode(archive([file(name), file("f.txt", "x", { prefix })]));
    expect(headers.map(({ name }) => name)).toEqual([name, `${prefix}/f.txt`]);
  });

  test("gives a directory or link no data, whatever its size field", async () => {
    const one = [...new TextEncoder().encode("00000000001\0")];
    const { headers, error } = await decode(
      archive([
        { name: `${BASE}/dir/`, type: "5", sizeField: one },
        { name: `${BASE}/link`, type: "2", linkname: "x", sizeField: one },
      ]),
    );
    expect(error).toBeUndefined();
    expect(headers.map(({ type, size }) => [type, size])).toEqual([
      ["directory", 0],
      ["symlink", 0],
    ]);
  });

  test("names the types it knows, and takes any other as a regular file", async () => {
    const { headers } = await decode(
      archive([
        { name: `${BASE}/hard`, type: "1", linkname: `${BASE}/a` },
        { name: `${BASE}/chr`, type: "3" },
        { name: `${BASE}/fifo`, type: "6" },
        { name: `${BASE}/contiguous`, type: "7" },
        { name: `${BASE}/sparse`, type: "S" },
      ]),
    );
    expect(headers.map(({ type }) => type)).toEqual(["link", "character-device", "fifo", "file", "file"]);
  });

  test("reads a header without ustar's magic", async () => {
    const bytes = archive([file(`${BASE}/a`)]);
    bytes.fill(0, 257, 265);
    // The checksum covers the magic.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : bytes[i]!;
    bytes.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    const { headers, error } = await decode(bytes);
    expect(error).toBeUndefined();
    expect(headers.map(({ name }) => name)).toEqual([`${BASE}/a`]);
  });
});

describe("the installer's checks of each entry", () => {
  const placed = (header: Partial<TarHeader>): string =>
    placeEntry({ size: 0, type: "file", ...header } as TarHeader, BASE, fs);

  test("resolve names relative to the store's root", () => {
    expect(relativeName(`./${BASE}//a/./b`)).toBe(`${BASE}/a/b`);
    expect(relativeName("./")).toBe("");
    for (const name of ["", "/abs", `${BASE}/../x`, `${BASE}/a/..`]) expect(relativeName(name)).toBeNull();
    expect(placed({ name: `./${BASE}/a` })).toBe(`${BASE}/a`);
    expect(placed({ name: BASE, type: "directory" })).toBe(BASE);
  });

  test.each([
    ["an absolute name", { name: `/${BASE}/a` }, fs.errno.EINVAL],
    ["a .. component", { name: `${BASE}/../${BASE}/a` }, fs.errno.EINVAL],
    ["a hard link", { name: `${BASE}/a`, type: "link" }, fs.errno.EOPNOTSUPP],
    ["a device", { name: `${BASE}/a`, type: "character-device" }, fs.errno.EINVAL],
    ["a FIFO", { name: `${BASE}/a`, type: "fifo" }, fs.errno.EINVAL],
    ["a pax size", { name: `${BASE}/a`, pax: { size: "1" } }, fs.errno.EINVAL],
    ["a newline in its name", { name: `${BASE}/a\n` }, fs.errno.EINVAL],
    ["a NUL in its link target", { name: `${BASE}/a`, type: "symlink", linkname: "x\0y" }, fs.errno.EINVAL],
  ] as const)("refuse %s", (_, header, errno) => {
    expect(() => placed(header as Partial<TarHeader>)).toThrow(
      new RuntimeRefused(`${JSON.stringify(header.name)}: -${errno}`),
    );
  });

  test.each(["elsewhere/x", `${BASE}x/a`, "."])("refuse %s, outside the store path", (name) => {
    expect(() => placed({ name })).toThrow("lies outside");
  });
});

// A file system that records each call, failing the one named.
const recording = (failing: { call: keyof EmscriptenFs; with: "errno" | "trap" }) => {
  const calls: string[] = [];
  class ErrnoError extends Error {
    readonly errno: number;
    constructor(errno: number) {
      super(`errno ${errno}`);
      this.errno = errno;
    }
  }
  const call =
    <T>(name: keyof EmscriptenFs, result: T) =>
    (...args: unknown[]): T => {
      calls.push(`${name} ${args.map((arg) => (typeof arg === "object" ? "-" : String(arg))).join(" ")}`);
      if (failing.call === name) {
        if (failing.with === "trap") throw new WebAssembly.RuntimeError("unreachable");
        throw new ErrnoError(5);
      }
      return result;
    };
  const FS = {
    ErrnoError,
    mkdir: call("mkdir", undefined),
    symlink: call("symlink", 0),
    unlink: call("unlink", 0),
    lstat: (path: string) => {
      calls.push(`lstat ${path}`);
      if (path === "/root") return { mode: fs.mode.S_IFDIR | 0o755, size: 0 };
      throw new ErrnoError(fs.errno.ENOENT);
    },
    chmod: call("chmod", undefined),
    open: call("open", { fd: 7 }),
    fchmod: call("fchmod", undefined),
    ftruncate: call("ftruncate", undefined),
    write: (stream: { fd: number }, data: Uint8Array, offset: number, length: number) =>
      call("write", length)(stream.fd, data, offset, length),
    close: call("close", undefined),
  };
  const handle = {
    rt: { FS, _fsync: () => 0, ___errno_location: () => 0 },
    words: new Int32Array(1),
    fs,
  } as unknown as RuntimeHandle;
  return { handle, calls };
};

describe("the installer's writes", () => {
  const tree = archive([file(`${BASE}/a`, "x".repeat(70_000))]);

  test("go in 64 KiB pieces from the file's start, each file's fsync()ed and closed", async () => {
    const { handle, calls } = recording({ call: "symlink", with: "errno" });
    const written = await extract(
      handle,
      streamOf(tree, 100_000),
      "test",
      "/root",
      BASE,
      70_000,
      { fed: 0, files: 0, bytes: 0 },
      {},
    );
    expect(written).toEqual({ files: 1, bytes: 70_000 });
    expect(calls.filter((call) => /^(open|ftruncate|write|close)/.test(call))).toEqual([
      `open /root/${BASE}/a ${fs.open.O_WRONLY | fs.open.O_CREAT | fs.open.O_TRUNC | fs.open.O_NOFOLLOW} ${0o644}`,
      "ftruncate 7 70000",
      "write 7 - 0 65536",
      "write 7 - 0 4464",
      "close -",
    ]);
  });

  test.each([
    ["errno", true],
    ["trap", false],
  ] as const)("that fail with %s close the file only while the runtime is fit to call", async (failure, closes) => {
    const { handle, calls } = recording({ call: "write", with: failure });
    const result = extract(
      handle,
      streamOf(tree, 512),
      "test",
      "/root",
      BASE,
      70_000,
      { fed: 0, files: 0, bytes: 0 },
      {},
    );
    if (closes) await expect(result).rejects.toThrow(new RuntimeRefused(`test: "${BASE}/a": -5`));
    else await expect(result).rejects.toBeInstanceOf(WebAssembly.RuntimeError);
    expect(calls.includes("close -")).toBe(closes);
  });
});
```

In `packages/worker-host/test/node/startup.test.ts`, give the constants their `fs`:

```diff
diff --git a/packages/worker-host/test/node/startup.test.ts b/packages/worker-host/test/node/startup.test.ts
--- a/packages/worker-host/test/node/startup.test.ts
+++ b/packages/worker-host/test/node/startup.test.ts
@@ -15,6 +15,11 @@ const constants = {
   waitTimedOut: -2,
   idbReadOnly: 1,
   canceled: -11,
+  fs: {
+    errno: { EEXIST: 20, EFBIG: 22, EINVAL: 28, EISDIR: 31, ENOENT: 44, ENOTDIR: 54, EOPNOTSUPP: 138 },
+    open: { O_WRONLY: 1, O_CREAT: 64, O_TRUNC: 512, O_NOFOLLOW: 131072 },
+    mode: { S_IFMT: 61440, S_IFDIR: 16384, S_IFLNK: 40960 },
+  },
 };
 const manifest = {
   name: "test",
```

The installer's policy is held against the real runtime, in a host: two test requests the test build answers itself drive the installer and WasmFS's `FS` directly, on a memory mount of the tests' own. In `packages/worker-host/test/shared/testing.ts`:

```diff
diff --git a/packages/worker-host/test/shared/testing.ts b/packages/worker-host/test/shared/testing.ts
--- a/packages/worker-host/test/shared/testing.ts
+++ b/packages/worker-host/test/shared/testing.ts
@@ -7,6 +7,7 @@
 
 import type { HostConfigValues } from "../../src/shared/config.ts";
 import type { HostMessage, Mount, SideModule } from "../../src/shared/messages.ts";
+import type { Member } from "./tar.ts";
 
 export const HostOp = {
   stop: 0xfff5,
@@ -22,8 +23,57 @@ export const HostOp = {
   // Adds the int32 payload's count of Workers to the pool, then replies 0
   // once they have all loaded the runtime, or -1.
   addWorkers: 0xfff4,
+  // Extracts an archive with the installer, as a UTF-8 JSON InstallOpRequest,
+  // and replies with a UTF-8 JSON InstallOpReply.
+  install: 0xfff7,
+  // Runs a UTF-8 JSON array of FsActions through WasmFS's FS, and replies
+  // with a UTF-8 JSON array of their FsResults.
+  fs: 0xfff8,
 } as const;
 
+// A piece of an archive the host builds: a member, zeros, or text.
+export type ArchivePart = Member | { zeros: number } | { text: string };
+
+export interface InstallOpRequest {
+  // An existing directory, and the store path its entries must lie under.
+  dir: string;
+  storeName: string;
+  // The most bytes of file data it may write; no limit if none.
+  limit?: number;
+  archive: { url: string } | { parts: ArchivePart[] };
+  // Only the archive's first cut bytes.
+  cut?: number;
+  // The size of the pieces the archive arrives in; 64 KiB if none.
+  piece?: number;
+  // Takes the runtime's free memory, before installing, down to a file of
+  // this size, in whole pages, and the headroom.
+  squeeze?: { file: number; headroom: number };
+}
+
+export type InstallOpReply = { ok: true; files: number; bytes: number } | { ok: false; message: string };
+
+export type FsAction =
+  // Mounts a memory backend at path.
+  | { op: "mount"; path: string }
+  | { op: "mkdir"; path: string; mode?: number }
+  // Writes the text, or size bytes of the archive's pattern.
+  | { op: "write"; path: string; text?: string; size?: number; mode?: number }
+  | { op: "symlink"; target: string; path: string }
+  | { op: "unlink"; path: string }
+  | { op: "chmod"; path: string; mode: number }
+  | { op: "lstat"; path: string }
+  | { op: "readlink"; path: string }
+  | { op: "read"; path: string }
+  | { op: "pattern"; path: string }
+  // Makes every FS call the installer uses fail, in a fresh directory, and
+  // gives each one's errno.
+  | { op: "failures"; dir: string };
+
+export interface FsResult {
+  value?: unknown;
+  errno?: number;
+}
+
 export interface HostStats {
   // Maximum live pthread Workers, including the initial pool.
   poolWorkersPeak: number;
@@ -103,7 +153,7 @@ export interface TestInit {
   relayFailsAfter?: number;
   // indexedDB.open() throws in the host, as it does in an opaque origin.
   withoutIndexedDB?: boolean;
-  // The install stops for good once it has fed the extractor at least this
+  // The install stops for good once it has fed the tar decoder at least this
   // many bytes, and the host posts "stalled".
   stallAt?: number;
   // The install waits this long before feeding each piece of an archive.
```

Create `packages/worker-host/test/worker/install-ops.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// HostOp.install and HostOp.fs: the installer, and WasmFS's FS beneath it,
// driven directly on a memory mount of the tests' own, so the tests can hold
// the installer to its policy in a host with the real runtime.

import { extract } from "../../src/worker/install/archive.ts";
import { RuntimeRefused, withString, type RuntimeHandle } from "../../src/worker/runtime.ts";
import { member, pattern, patternByte } from "../shared/tar.ts";
import type { FsAction, FsResult, InstallOpReply, InstallOpRequest, ArchivePart } from "../shared/testing.ts";

const encoder = new TextEncoder();
const WASM_PAGE = 65536;

const partBytes = (part: ArchivePart): Uint8Array =>
  "zeros" in part ? new Uint8Array(part.zeros) : "text" in part ? encoder.encode(part.text) : member(part);

const archiveBytes = async (archive: InstallOpRequest["archive"]): Promise<Uint8Array> => {
  if ("url" in archive) {
    const response = await fetch(archive.url);
    if (!response.ok) throw new Error(`fetch ${archive.url}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const parts = archive.parts.map(partBytes);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const streamOf = (bytes: Uint8Array, piece: number): ReadableStream<Uint8Array> => {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) controller.close();
      else controller.enqueue(bytes.slice(at, (at += piece)));
    },
  });
};

// Takes the runtime's free memory, in blocks small enough to come from the
// top of its heap, until only budget bytes are left, then runs use and
// gives it back.
const squeezed = async <T>(handle: RuntimeHandle, budget: number, use: () => Promise<T>): Promise<T> => {
  const rt = handle.rt as typeof handle.rt & { _sbrk(increment: number): number };
  const heap = handle.memory.buffer.byteLength;
  if (heap - rt._sbrk(0) <= budget) throw new Error(`only ${heap - rt._sbrk(0)} bytes free, not ${budget}`);
  const blocks: number[] = [];
  try {
    while (heap - rt._sbrk(0) > budget) {
      const block = rt._malloc(65536);
      if (block === 0) break;
      blocks.push(block);
    }
    return await use();
  } finally {
    for (const block of blocks) rt._free(block);
  }
};

export const install = async (handle: RuntimeHandle, request: InstallOpRequest): Promise<InstallOpReply> => {
  let bytes = await archiveBytes(request.archive);
  if (request.cut !== undefined) bytes = bytes.subarray(0, request.cut);
  const run = () =>
    extract(
      handle,
      streamOf(bytes, request.piece ?? 65536),
      "install",
      request.dir,
      request.storeName,
      request.limit ?? Number.MAX_SAFE_INTEGER,
      { fed: 0, files: 0, bytes: 0 },
      {},
    );
  try {
    const written =
      request.squeeze === undefined
        ? await run()
        : await squeezed(
            handle,
            Math.ceil(request.squeeze.file / WASM_PAGE) * WASM_PAGE + request.squeeze.headroom,
            run,
          );
    return { ok: true, ...written };
  } catch (error) {
    if (error instanceof RuntimeRefused) return { ok: false, message: error.message };
    throw error;
  }
};

// Runs each action in turn, through FS where it has the call, and reports
// each one's result or errno.
export const fsActions = (handle: RuntimeHandle, actions: readonly FsAction[]): FsResult[] => {
  const { rt } = handle;
  const { FS } = rt;
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = handle.fs.open;
  const results: FsResult[] = [];
  for (const action of actions) {
    try {
      switch (action.op) {
        case "mount": {
          const backend = rt._wasmfs_create_memory_backend();
          const ret = withString(handle, action.path, (ptr) => rt._wasmfs_create_directory(ptr, 0o777, backend));
          results.push(ret < 0 ? { errno: -ret } : {});
          break;
        }
        case "mkdir":
          FS.mkdir(action.path, action.mode ?? 0o755);
          results.push({});
          break;
        case "write": {
          const stream = FS.open(action.path, O_WRONLY | O_CREAT | O_TRUNC, action.mode ?? 0o644);
          try {
            const data = action.text === undefined ? pattern(action.size ?? 0) : encoder.encode(action.text);
            FS.write(stream, data, 0, data.length);
          } finally {
            FS.close(stream);
          }
          results.push({});
          break;
        }
        case "symlink": {
          const ret = FS.symlink(action.target, action.path);
          results.push(ret < 0 ? { errno: -ret } : {});
          break;
        }
        case "unlink": {
          const ret = FS.unlink(action.path);
          results.push(ret < 0 ? { errno: -ret } : {});
          break;
        }
        case "chmod":
          FS.chmod(action.path, action.mode);
          results.push({});
          break;
        case "lstat": {
          const { mode, size } = FS.lstat(action.path);
          results.push({ value: { mode, size } });
          break;
        }
        case "readlink":
          results.push({ value: (FS as unknown as { readlink(path: string): string }).readlink(action.path) });
          break;
        case "read":
          results.push({
            value: (FS as unknown as { readFile(path: string, opts: { encoding: "utf8" }): string }).readFile(
              action.path,
              { encoding: "utf8" },
            ),
          });
          break;
        // The offset of the first byte that isn't the pattern's, or the
        // file's size if none.
        case "pattern": {
          const data = (FS as unknown as { readFile(path: string): Uint8Array }).readFile(action.path);
          let at = 0;
          while (at < data.length && data[at] === patternByte(at)) at++;
          results.push({ value: at === data.length ? { size: data.length } : { differsAt: at } });
          break;
        }
        // Each call the installer makes, failing, with its errno.
        case "failures": {
          const errnoOf = (call: () => unknown): number | string => {
            try {
              const ret = call();
              return typeof ret === "number" && ret < 0 ? -ret : `returned ${String(ret)}`;
            } catch (error) {
              if (error instanceof FS.ErrnoError) return error.errno;
              throw error;
            }
          };
          const { dir } = action;
          FS.mkdir(`${dir}/sub`, 0o755);
          const file = FS.open(`${dir}/file`, O_WRONLY | O_CREAT, 0o644);
          FS.close(file);
          FS.symlink(`${dir}/file`, `${dir}/link`);
          const closed = FS.open(`${dir}/closed`, O_WRONLY | O_CREAT, 0o644);
          FS.close(closed);
          const fsyncErrno = (): number => {
            if (rt._fsync(closed.fd) === 0) return 0;
            return handle.words[rt.___errno_location() / 4]!;
          };
          results.push({
            value: {
              mkdirExisting: errnoOf(() => FS.mkdir(`${dir}/sub`, 0o755)),
              mkdirMissingParent: errnoOf(() => FS.mkdir(`${dir}/missing/x`, 0o755)),
              mkdirUnderFile: errnoOf(() => FS.mkdir(`${dir}/file/x`, 0o755)),
              mkdirUnderLink: errnoOf(() => FS.mkdir(`${dir}/link/x`, 0o755)),
              lstatMissing: errnoOf(() => FS.lstat(`${dir}/missing`)),
              lstatUnderFile: errnoOf(() => FS.lstat(`${dir}/file/x`)),
              unlinkMissing: errnoOf(() => FS.unlink(`${dir}/missing`)),
              unlinkDirectory: errnoOf(() => FS.unlink(`${dir}/sub`)),
              symlinkExisting: errnoOf(() => FS.symlink("x", `${dir}/file`)),
              symlinkMissingParent: errnoOf(() => FS.symlink("x", `${dir}/missing/x`)),
              openDirectory: errnoOf(() => FS.open(`${dir}/sub`, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644)),
              openLink: errnoOf(() => FS.open(`${dir}/link`, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644)),
              openMissingParent: errnoOf(() =>
                FS.open(`${dir}/missing/x`, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644),
              ),
              chmodMissing: errnoOf(() => FS.chmod(`${dir}/missing`, 0o644)),
              fchmodClosed: errnoOf(() => FS.fchmod(closed.fd, 0o644)),
              ftruncateClosed: errnoOf(() => FS.ftruncate(closed.fd, 1)),
              writeClosed: errnoOf(() => FS.write(closed, new Uint8Array(1), 0, 1)),
              closeClosed: errnoOf(() => FS.close(closed)),
              fsyncClosed: fsyncErrno(),
            },
          });
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof FS.ErrnoError)) throw error;
      results.push({ errno: error.errno });
    }
  }
  return results;
};
```

and serve the two requests in `packages/worker-host/test/worker/instruments.ts`:

```diff
diff --git a/packages/worker-host/test/worker/instruments.ts b/packages/worker-host/test/worker/instruments.ts
--- a/packages/worker-host/test/worker/instruments.ts
+++ b/packages/worker-host/test/worker/instruments.ts
@@ -15,10 +15,13 @@ import {
   PumpControl,
   RuntimeCall,
   HostOp,
+  type FsAction,
   type HostStats,
+  type InstallOpRequest,
   type TestInit,
   type TestMessage,
 } from "../shared/testing.ts";
+import { fsActions, install } from "./install-ops.ts";
 
 // Counts the Workers Emscripten creates, through the global Worker class.
 // Under Node, Emscripten first assigns worker_threads' Worker to the global,
@@ -67,6 +70,10 @@ const withholdIndexedDB = (): void => {
 };
 
 const encoder = new TextEncoder();
+const decoder = new TextDecoder();
+
+// A test request's payload, after its framing.
+const payloadOf = (request: Uint8Array): Uint8Array => request.subarray(8);
 
 const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
 
@@ -310,6 +317,19 @@ export const makeInstruments = (
         case HostOp.topUp:
           held = arg(1) === 0;
           return { ret: 0 };
+        case HostOp.install: {
+          const spec = JSON.parse(decoder.decode(payloadOf(request))) as InstallOpRequest;
+          return install(runtime, spec).then((reply) => {
+            const json = encoder.encode(JSON.stringify(reply));
+            return { ret: json.length, bytes: json };
+          });
+        }
+        case HostOp.fs: {
+          const json = encoder.encode(
+            JSON.stringify(fsActions(runtime, JSON.parse(decoder.decode(payloadOf(request))) as FsAction[])),
+          );
+          return { ret: json.length, bytes: json };
+        }
         case HostOp.addWorkers: {
           counters.eventLoopTurns++;
           const want = arg(1);
```

Create `packages/worker-host/test/shared/installer.ts`, the scenarios, which port every case of `test-install.c` that still applies and add the pax ones and each `FS` call's failure:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The installer's policy, held against the real runtime: each scenario
// extracts archives with HostOp.install into a memory mount of its own and
// looks at what it made through HostOp.fs, so it runs in any environment.

import { expect } from "vitest";
import type { Client } from "./client.ts";
import type { Harness, RunningHost } from "./harness.ts";
import { opsOf } from "./scenarios.ts";
import { counts } from "./install.ts";
import { replyFile } from "./storage.ts";
import type { Member } from "./tar.ts";
import {
  HostOp,
  type ArchivePart,
  type FsAction,
  type FsResult,
  type InstallOpReply,
  type InstallOpRequest,
} from "./testing.ts";

const MOUNT = "/ibus-web-install-test";
const BASE = "00000000000000000000000000000000-base";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Requests that do a whole install are no keystroke, and their time is no
// criterion; they let the page go at once, since in Firefox a response body
// the host fetches waits while the page spins.
const UNHELD = { budgetMs: 1 };

const json = async <T>(client: Client, op: number, request: unknown): Promise<T> => {
  const { ret, bytes } = await client.call(op, encoder.encode(JSON.stringify(request)), UNHELD);
  if (ret < 0) throw new Error(`host op ${op}: ${ret}`);
  return JSON.parse(decoder.decode(bytes)) as T;
};

export const fs = (client: Client, actions: readonly FsAction[]): Promise<FsResult[]> =>
  json<FsResult[]>(client, HostOp.fs, actions);

const one = async (client: Client, action: FsAction): Promise<FsResult> => (await fs(client, [action]))[0]!;

const install = (client: Client, request: InstallOpRequest): Promise<InstallOpReply> =>
  json<InstallOpReply>(client, HostOp.install, request);

const mounted = new WeakSet<Client>();
let made = 0;

// A directory of its own on the tests' memory mount for each install.
const freshDir = async (client: Client): Promise<string> => {
  if (!mounted.has(client)) {
    expect(await one(client, { op: "mount", path: MOUNT }), "the tests' mount").toEqual({});
    mounted.add(client);
  }
  const dir = `${MOUNT}/${made++}`;
  expect(await one(client, { op: "mkdir", path: dir }), dir).toEqual({});
  return dir;
};

const errno = (h: Harness, name: string): number => {
  const value = h.data.errno[name];
  if (value === undefined) throw new Error(`no ${name} in Emscripten's errno.h`);
  return value;
};

// The refusal the installer reports for the entry and errno.
const refusal = (h: Harness, name: string, errnoName: string): string =>
  `install: ${JSON.stringify(name)}: -${errno(h, errnoName)}`;

const exists = async (client: Client, path: string): Promise<boolean> =>
  (await one(client, { op: "lstat", path })).errno === undefined;

const read = async (client: Client, path: string): Promise<unknown> => (await one(client, { op: "read", path })).value;

const modeOf = async (client: Client, path: string): Promise<number> =>
  ((await one(client, { op: "lstat", path })).value as { mode: number }).mode;

const listing = async (h: Harness, client: Client, path: string): Promise<string | number> => {
  const reply = replyFile(await client.call(opsOf(h).listTree, encoder.encode(path), UNHELD));
  return reply.text ?? reply.status;
};

const members = (...list: readonly (Member | ArchivePart)[]): InstallOpRequest["archive"] => ({
  parts: [...list, { zeros: 1024 }],
});

const file = (name: string, data = "data\n", more: Partial<Member> = {}): Member => ({
  name: `${BASE}/${name}`,
  data,
  ...more,
});

// The test archive's tree, whole, in pieces of each size: header and data
// boundaries fall anywhere within a piece, and its counts are the
// listing's. Byte by byte, which Firefox's streams take some 40 s over for
// the whole tree, an archive of pax headers and a file goes in.
export const installWhole = async (h: Harness, host: RunningHost): Promise<void> => {
  const { tree } = h.data.archives;
  const { base, data, long } = h.data.archives.installer;
  for (const piece of [7, 511, 513, 65536, 1 << 20]) {
    const dir = await freshDir(host.client);
    const reply = await install(host.client, { dir, storeName: data, archive: { url: tree.url }, piece });
    expect(reply, `pieces of ${piece} bytes`).toEqual({ ok: true, ...counts(tree) });
    expect(await listing(h, host.client, `${dir}/${data}`), `pieces of ${piece} bytes`).toBe(tree.listing);
  }
  const dir = await freshDir(host.client);
  expect(
    await install(host.client, { dir, storeName: long.storeName, archive: { url: `${base}long.tar` }, piece: 1 }),
  ).toEqual({ ok: true, files: 1, bytes: 5 });
  expect(await read(host.client, `${dir}/${long.storeName}/${long.name}`)).toBe("long\n");
};

// An install cut short, over files longer than the archive's, then a whole
// one over that: every file the archive has is the archive's, truncated
// and rewritten.
export const installOverPartial = async (h: Harness, host: RunningHost): Promise<void> => {
  const { tree } = h.data.archives;
  const { data } = h.data.archives.installer;
  const dir = await freshDir(host.client);
  const root = `${dir}/${data}`;
  expect(
    await fs(host.client, [
      { op: "mkdir", path: root },
      { op: "mkdir", path: `${root}/share` },
      { op: "mkdir", path: `${root}/share/dict` },
      { op: "write", path: `${root}/share/dict/main.dict`, size: 700_000 },
      { op: "write", path: `${root}/README`, size: 4096 },
    ]),
  ).toEqual([{}, {}, {}, {}, {}]);
  const half = await install(host.client, {
    dir,
    storeName: data,
    archive: { url: tree.url },
    cut: Math.floor(tree.size / 2),
    piece: 4096,
  });
  expect(half).toEqual({ ok: false, message: "install: Tar archive is truncated." });
  expect(await install(host.client, { dir, storeName: data, archive: { url: tree.url } })).toEqual({
    ok: true,
    ...counts(tree),
  });
  expect(await listing(h, host.client, root)).toBe(tree.listing);
};

// Each refused archive's first file is taken; the refusal is its second
// member's, and nothing of it is made.
export const installRefused = async (h: Harness, host: RunningHost): Promise<void> => {
  const { base, refused } = h.data.archives.installer;
  const cases = [
    ["absolute", "/ibus-web-escape.txt", "EINVAL"],
    ["dotdot", `${refused}/../../ibus-web-escape.txt`, "EINVAL"],
    ["hardlink", `${refused}/hard`, "EOPNOTSUPP"],
    ["fifo", `${refused}/fifo`, "EINVAL"],
  ] as const;
  for (const [archive, name, errnoName] of cases) {
    const dir = await freshDir(host.client);
    const reply = await install(host.client, {
      dir,
      storeName: refused,
      archive: { url: `${base}refused/${archive}.tar` },
    });
    expect(reply, archive).toEqual({ ok: false, message: refusal(h, name, errnoName) });
    expect(await read(host.client, `${dir}/${refused}/ok.txt`), archive).toBe("accepted\n");
    for (const escape of [`${dir}/ibus-web-escape.txt`, `${MOUNT}/ibus-web-escape.txt`, "/ibus-web-escape.txt"])
      expect(await exists(host.client, escape), `${archive}: ${escape}`).toBe(false);
    for (const made of [`${dir}/${refused}/hard`, `${dir}/${refused}/fifo`])
      expect(await exists(host.client, made), `${archive}: ${made}`).toBe(false);
  }
  const dir = await freshDir(host.client);
  expect(
    await install(host.client, { dir, storeName: refused, archive: { url: `${base}refused/outside.tar` } }),
  ).toEqual({ ok: false, message: `install: archive entry "ibus-web-escape.txt" lies outside ${refused}` });
  expect(await exists(host.client, `${dir}/ibus-web-escape.txt`)).toBe(false);
};

// What the strict decoder refuses fails the install: a broken checksum, an
// archive cut short anywhere, a lone zero block, and anything but zeros
// after the end.
export const installMalformed = async (h: Harness, host: RunningHost): Promise<void> => {
  const { base, data } = h.data.archives.installer;
  const check = async (what: string, request: Omit<InstallOpRequest, "dir">, message: string): Promise<void> => {
    const dir = await freshDir(host.client);
    expect(await install(host.client, { dir, ...request }), what).toEqual({
      ok: false,
      message: `install: ${message}`,
    });
  };
  await check(
    "corrupt.tar",
    { storeName: data, archive: { url: `${base}corrupt.tar` } },
    "Invalid tar header checksum.",
  );
  const twoFiles = members(file("a"), file("b", "b".repeat(600)));
  for (const [where, cut] of [
    ["mid-header", 512 + 512 + 100],
    ["mid-file", 512 + 512 + 512 + 2],
    ["between members", 512 + 512],
    ["before its end-of-archive blocks", 512 + 512 + 512 + 1024],
  ] as const)
    await check(`cut ${where}`, { storeName: BASE, archive: twoFiles, cut, piece: 512 }, "Tar archive is truncated.");
  await check(
    "a lone zero block",
    { storeName: BASE, archive: members(file("a"), { zeros: 512 }, file("b")) },
    "Invalid tar header.",
  );
  await check(
    "trailing bytes",
    { storeName: BASE, archive: { parts: [file("a"), { zeros: 1024 }, { text: "trailing" }] } },
    "Invalid EOF.",
  );
  await check(
    "a checksum summed as signed bytes",
    { storeName: BASE, archive: members(file("signed", "signed\n", { signedSum: true })) },
    "Invalid tar header checksum.",
  );
  const dir = await freshDir(host.client);
  expect(
    await install(host.client, {
      dir,
      storeName: data,
      archive: { parts: [{ text: "" }] },
    }),
    "no archive at all",
  ).toEqual({ ok: false, message: "install: Tar archive is truncated." });
  // GNU tar pads an archive to a whole record with zeros.
  const padded = await freshDir(host.client);
  expect(
    await install(host.client, {
      dir: padded,
      storeName: BASE,
      archive: { parts: [file("a"), { zeros: 1024 }, { zeros: 9216 }] },
    }),
  ).toEqual({ ok: true, files: 1, bytes: 5 });
};

// The limit refuses a file that would pass it before its parents or the
// file are made; a limit of the data's exact size, or of nothing for no
// data, is met.
export const installLimit = async (h: Harness, host: RunningHost): Promise<void> => {
  const big = file("too-large/file", undefined, { sizeField: [...encoder.encode("77777777777\0")] });
  for (const limit of [0, 3]) {
    const dir = await freshDir(host.client);
    const reply = await install(host.client, {
      dir,
      storeName: BASE,
      limit,
      archive: { parts: [file("ok", "abc"), big] },
      piece: 7,
    });
    expect(reply, `limit ${limit}`).toEqual({
      ok: false,
      message: refusal(h, limit === 0 ? `${BASE}/ok` : `${BASE}/too-large/file`, "EFBIG"),
    });
    expect(await exists(host.client, `${dir}/${BASE}/too-large`), `limit ${limit}`).toBe(false);
    expect(await exists(host.client, `${dir}/${BASE}/ok`), `limit ${limit}`).toBe(limit === 3);
  }
  for (const data of ["", "abc"]) {
    const dir = await freshDir(host.client);
    expect(
      await install(host.client, {
        dir,
        storeName: BASE,
        limit: data.length,
        archive: members(file("f", data)),
        piece: 1,
      }),
    ).toEqual({ ok: true, files: 1, bytes: data.length });
  }
};

// Entries take the archive's mode plus the owner's read and write (and
// search, for a directory), whether new or there already.
export const installModes = async (h: Harness, host: RunningHost): Promise<void> => {
  const dir = await freshDir(host.client);
  const root = `${dir}/${BASE}`;
  expect(
    await fs(host.client, [
      { op: "mkdir", path: root },
      { op: "mkdir", path: `${root}/old`, mode: 0o700 },
      { op: "chmod", path: `${root}/old`, mode: 0o700 },
      { op: "write", path: `${root}/old/file`, text: "oooooooooo", mode: 0o666 },
      { op: "chmod", path: `${root}/old/file`, mode: 0o666 },
    ]),
  ).toEqual([{}, {}, {}, {}, {}]);
  const reply = await install(host.client, {
    dir,
    storeName: BASE,
    archive: members(
      { name: `${BASE}/old/`, type: "5", mode: 0o751 },
      file("old/file", "old\n", { mode: 0o640 }),
      { name: `${BASE}/new/`, type: "5", mode: 0o555 },
      file("new/file", "new\n", { mode: 0o444 }),
    ),
  });
  expect(reply).toEqual({ ok: true, files: 2, bytes: 8 });
  const modes = [];
  for (const path of ["old", "old/file", "new", "new/file"])
    modes.push((await modeOf(host.client, `${root}/${path}`)) & 0o7777);
  expect(modes).toEqual([0o751, 0o640, 0o755, 0o644]);
  expect(await read(host.client, `${root}/old/file`)).toBe("old\n");
};

// A symbolic link is made with its target as the archive has it, relative
// or absolute, and reads through to it; it counts as no file and no bytes.
// Its parents are made as a file's are, and a link to "/" is a link like
// any other.
export const installSymlinks = async (h: Harness, host: RunningHost): Promise<void> => {
  const dir = await freshDir(host.client);
  const root = `${dir}/${BASE}`;
  const absolute = `${root}/data.txt`;
  const reply = await install(host.client, {
    dir,
    storeName: BASE,
    piece: 7,
    archive: members(
      { name: `${BASE}/`, type: "5", mode: 0o755 },
      file("data.txt", "data\n", { mode: 0o444 }),
      { name: `${BASE}/relative`, type: "2", linkname: "data.txt" },
      { name: `${BASE}/absolute`, type: "2", linkname: absolute },
      { name: `${BASE}/sub/deep`, type: "2", linkname: "../data.txt" },
      { name: `${BASE}/dir-link`, type: "2", linkname: "sub" },
    ),
  });
  expect(reply).toEqual({ ok: true, files: 1, bytes: 5 });
  const results = await fs(host.client, [
    { op: "readlink", path: `${root}/relative` },
    { op: "readlink", path: `${root}/absolute` },
    { op: "readlink", path: `${root}/sub/deep` },
    ...["relative", "absolute", "sub/deep", "dir-link/deep"].map((path): FsAction => ({
      op: "read",
      path: `${root}/${path}`,
    })),
  ]);
  expect(results.map(({ value }) => value)).toEqual([
    "data.txt",
    absolute,
    "../data.txt",
    "data\n",
    "data\n",
    "data\n",
    "data\n",
  ]);

  const { base, refused } = h.data.archives.installer;
  const rooted = await freshDir(host.client);
  expect(
    await install(host.client, { dir: rooted, storeName: refused, archive: { url: `${base}symlink.tar` } }),
  ).toEqual({
    ok: true,
    files: 1,
    bytes: 9,
  });
  expect((await one(host.client, { op: "readlink", path: `${rooted}/${refused}/link` })).value).toBe("/");
};

// The 5b-style archive: a name and a link target longer than ustar holds,
// from pax headers.
export const installLongNames = async (h: Harness, host: RunningHost): Promise<void> => {
  const { base, long } = h.data.archives.installer;
  const dir = await freshDir(host.client);
  expect(await install(host.client, { dir, storeName: long.storeName, archive: { url: `${base}long.tar` } })).toEqual({
    ok: true,
    files: 1,
    bytes: 5,
  });
  const root = `${dir}/${long.storeName}`;
  expect(await read(host.client, `${root}/${long.name}`)).toBe("long\n");
  expect((await one(host.client, { op: "readlink", path: `${root}/data/link` })).value).toBe(long.target);
};

// A link's name is held to a file's rules, and it names something; a hard
// link fails before anything is made of it.
export const installLinksRefused = async (h: Harness, host: RunningHost): Promise<void> => {
  const cases: [Member, string, string][] = [
    [{ name: `/${BASE}/escape`, type: "2", linkname: "x" }, `/${BASE}/escape`, "EINVAL"],
    [{ name: `${BASE}/sub/../../escape`, type: "2", linkname: "x" }, `${BASE}/sub/../../escape`, "EINVAL"],
    [{ name: `${BASE}/empty`, type: "2", linkname: "" }, `${BASE}/empty`, "EINVAL"],
    [{ name: `${BASE}/b`, type: "1", linkname: `${BASE}/a` }, `${BASE}/b`, "EOPNOTSUPP"],
  ];
  for (const [link, name, errnoName] of cases) {
    const dir = await freshDir(host.client);
    expect(await install(host.client, { dir, storeName: BASE, archive: members(file("a"), link) }), name).toEqual({
      ok: false,
      message: refusal(h, name, errnoName),
    });
    for (const escape of [`${dir}/escape`, `${MOUNT}/escape`, "/escape", `${dir}/${BASE}/b`])
      expect(await exists(host.client, escape), `${name}: ${escape}`).toBe(false);
  }
};

// Nothing is written through a link the archive made: an entry under a
// link fails, and a file or link at a link's name replaces the link; a
// link also replaces a file, and fails on a directory, as a file does.
export const installThroughLinks = async (h: Harness, host: RunningHost): Promise<void> => {
  const elsewhere = await freshDir(host.client);
  expect(await one(host.client, { op: "write", path: `${elsewhere}/target`, text: "ttt" })).toEqual({});
  for (const under of [file("out/escaped.txt", "escaped\n"), { name: `${BASE}/out/sub/`, type: "5" }] as Member[]) {
    const dir = await freshDir(host.client);
    expect(
      await install(host.client, {
        dir,
        storeName: BASE,
        archive: members({ name: `${BASE}/out`, type: "2", linkname: elsewhere }, under),
      }),
      under.name,
    ).toEqual({ ok: false, message: refusal(h, under.name.replace(/\/$/, ""), "ENOTDIR") });
  }
  expect(await exists(host.client, `${elsewhere}/escaped.txt`)).toBe(false);
  expect(await exists(host.client, `${elsewhere}/sub`)).toBe(false);

  const dir = await freshDir(host.client);
  const target = `${elsewhere}/target`;
  expect(
    await install(host.client, {
      dir,
      storeName: BASE,
      archive: members(
        { name: `${BASE}/file`, type: "2", linkname: target },
        file("file", "file\n"),
        file("link", "link\n"),
        { name: `${BASE}/link`, type: "2", linkname: target },
      ),
    }),
  ).toEqual({ ok: true, files: 2, bytes: 10 });
  expect(await read(host.client, `${dir}/${BASE}/file`)).toBe("file\n");
  expect((await one(host.client, { op: "readlink", path: `${dir}/${BASE}/link` })).value).toBe(target);
  expect(await read(host.client, target)).toBe("ttt");

  for (const [over, errnoName] of [
    [{ name: `${BASE}/dir`, type: "2", linkname: "elsewhere" }, "EISDIR"],
    [file("dir", "file\n"), "EISDIR"],
  ] as [Member, string][]) {
    const into = await freshDir(host.client);
    expect(
      await install(host.client, {
        dir: into,
        storeName: BASE,
        archive: members({ name: `${BASE}/dir/`, type: "5", mode: 0o755 }, over),
      }),
      over.type ?? "file",
    ).toEqual({ ok: false, message: refusal(h, `${BASE}/dir`, errnoName) });
    expect(((await modeOf(host.client, `${into}/${BASE}/dir`)) & 0o170000) === 0o040000).toBe(true);
  }
};

// The installer's directory must be one.
export const installTarget = async (h: Harness, host: RunningHost): Promise<void> => {
  const dir = await freshDir(host.client);
  expect(await one(host.client, { op: "write", path: `${dir}/file`, text: "z" })).toEqual({});
  for (const [target, errnoName] of [
    [`${dir}/missing`, "ENOENT"],
    [`${dir}/file`, "ENOTDIR"],
  ] as const)
    expect(await install(host.client, { dir: target, storeName: BASE, archive: members(file("a")) }), target).toEqual({
      ok: false,
      message: `install: ${JSON.stringify(target)}: -${errno(h, errnoName)}`,
    });
};

// A host that mounts the engine's data in memory adds the data's size, in
// whole pages, to the runtime's memory, so a large file has to fit in about
// its own size: grown piece by piece, the memory backend's buffer would
// reach twice the file and need the old buffer beside the new while it
// moves. The install runs with the rest of the memory taken, leaving the
// file's pages and a headroom that stands for what the runtime's own
// memory has spare.
export const installLargeFile = async (h: Harness, host: RunningHost): Promise<void> => {
  const size = 16 * 1024 * 1024 + 1;
  const dir = await freshDir(host.client);
  const reply = await install(host.client, {
    dir,
    storeName: BASE,
    archive: members(file("large.bin", undefined, { data: { size } })),
    squeeze: { file: size, headroom: 1024 * 1024 },
  });
  expect(reply).toEqual({ ok: true, files: 1, bytes: size });
  const path = `${dir}/${BASE}/large.bin`;
  expect((await one(host.client, { op: "pattern", path })).value).toEqual({ size });
  expect(await one(host.client, { op: "unlink", path })).toEqual({});
};

// Each FS call the installer makes, made to fail: WasmFS's JavaScript layer
// gives the errno libc would.
export const fsFailures = async (h: Harness, host: RunningHost): Promise<void> => {
  const dir = await freshDir(host.client);
  const [{ value }] = (await fs(host.client, [{ op: "failures", dir }])) as [{ value: Record<string, number> }];
  const want = (name: string): number => errno(h, name);
  expect(value).toEqual({
    mkdirExisting: want("EEXIST"),
    mkdirMissingParent: want("ENOENT"),
    mkdirUnderFile: want("ENOTDIR"),
    mkdirUnderLink: want("ENOTDIR"),
    lstatMissing: want("ENOENT"),
    lstatUnderFile: want("ENOTDIR"),
    unlinkMissing: want("ENOENT"),
    unlinkDirectory: want("EISDIR"),
    symlinkExisting: want("EEXIST"),
    symlinkMissingParent: want("ENOENT"),
    openDirectory: want("EISDIR"),
    openLink: want("ELOOP"),
    openMissingParent: want("ENOENT"),
    chmodMissing: want("ENOENT"),
    fchmodClosed: want("EBADF"),
    ftruncateClosed: want("EBADF"),
    writeClosed: want("EBADF"),
    closeClosed: want("EBADF"),
    fsyncClosed: want("EBADF"),
  });
};
```

`counts` is shared now. In `packages/worker-host/test/shared/install.ts`:

```diff
diff --git a/packages/worker-host/test/shared/install.ts b/packages/worker-host/test/shared/install.ts
--- a/packages/worker-host/test/shared/install.ts
+++ b/packages/worker-host/test/shared/install.ts
@@ -40,7 +40,7 @@ const collectOf = (messages: readonly Message[]): CollectReport | undefined => {
 const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
 
 // The regular files an archive's listing holds, and their bytes.
-const counts = ({ listing }: TestArchive): { files: number; bytes: number } => {
+export const counts = ({ listing }: TestArchive): { files: number; bytes: number } => {
   const sizes = listing
     .split("\n")
     .map((line) => /^[^\t]*\tf (\d+) /.exec(line))
```

Register the scenarios, each runtime's on a host of its own with room for the large file:

```diff
diff --git a/packages/worker-host/test/browser/scenarios.test.ts b/packages/worker-host/test/browser/scenarios.test.ts
--- a/packages/worker-host/test/browser/scenarios.test.ts
+++ b/packages/worker-host/test/browser/scenarios.test.ts
@@ -65,6 +65,21 @@ import {
   waitFailsWithoutProgress,
   waitOutlivesLimit,
 } from "../shared/install.ts";
+import {
+  fsFailures,
+  installLargeFile,
+  installLimit,
+  installLinksRefused,
+  installLongNames,
+  installMalformed,
+  installModes,
+  installOverPartial,
+  installRefused,
+  installSymlinks,
+  installTarget,
+  installThroughLinks,
+  installWhole,
+} from "../shared/installer.ts";
 import { browserHarness } from "./harness.ts";
 
 const h = await browserHarness();
@@ -182,6 +197,30 @@ describe.each(h.data.runtimes)("storage on the $name runtime", (runtime) => {
   test("a failed start seals the user data and lets go of every lock", () => failedStartReleasesLocks(h, runtime));
 });
 
+// The installer's policy, on a host of its own with room for a large file.
+describe.each(h.data.runtimes)("the installer on the $name runtime", (runtime) => {
+  let host: RunningHost;
+  beforeAll(async () => {
+    const memory = 64 * 1024 * 1024;
+    host = await h.start({ runtime, memory: { initial: memory, maximum: memory } });
+  });
+  afterAll(() => host?.terminate());
+
+  test("whole, in pieces", () => installWhole(h, host));
+  test("over a half-written tree", () => installOverPartial(h, host));
+  test("refused archives", () => installRefused(h, host));
+  test("malformed archives", () => installMalformed(h, host));
+  test("its limit", () => installLimit(h, host));
+  test("modes", () => installModes(h, host));
+  test("symbolic links", () => installSymlinks(h, host));
+  test("long names and link targets", () => installLongNames(h, host));
+  test("links refused", () => installLinksRefused(h, host));
+  test("never through a link", () => installThroughLinks(h, host));
+  test("its directory", () => installTarget(h, host));
+  test("a large file in its own size", () => installLargeFile(h, host));
+  test("FS calls failing", () => fsFailures(h, host));
+});
+
 describe.each(h.data.runtimes)("engine data on the $name runtime", (runtime) => {
   test("install-fresh", () => installFresh(h, runtime));
   for (const memory of [false, true])
diff --git a/packages/worker-host/test/node/scenarios.test.ts b/packages/worker-host/test/node/scenarios.test.ts
--- a/packages/worker-host/test/node/scenarios.test.ts
+++ b/packages/worker-host/test/node/scenarios.test.ts
@@ -64,6 +64,21 @@ import {
   waitFailsWithoutProgress,
   waitOutlivesLimit,
 } from "../shared/install.ts";
+import {
+  fsFailures,
+  installLargeFile,
+  installLimit,
+  installLinksRefused,
+  installLongNames,
+  installMalformed,
+  installModes,
+  installOverPartial,
+  installRefused,
+  installSymlinks,
+  installTarget,
+  installThroughLinks,
+  installWhole,
+} from "../shared/installer.ts";
 import { nodeHarness } from "./harness.ts";
 
 const h = await nodeHarness();
@@ -178,6 +193,30 @@ describe.each(h.data.runtimes)("storage on the $name runtime", (runtime) => {
   test("a failed start seals the user data and lets go of every lock", () => failedStartReleasesLocks(h, runtime));
 });
 
+// The installer's policy, on a host of its own with room for a large file.
+describe.each(h.data.runtimes)("the installer on the $name runtime", (runtime) => {
+  let host: RunningHost;
+  beforeAll(async () => {
+    const memory = 64 * 1024 * 1024;
+    host = await h.start({ runtime, memory: { initial: memory, maximum: memory } });
+  });
+  afterAll(() => host?.terminate());
+
+  test("whole, in pieces", () => installWhole(h, host));
+  test("over a half-written tree", () => installOverPartial(h, host));
+  test("refused archives", () => installRefused(h, host));
+  test("malformed archives", () => installMalformed(h, host));
+  test("its limit", () => installLimit(h, host));
+  test("modes", () => installModes(h, host));
+  test("symbolic links", () => installSymlinks(h, host));
+  test("long names and link targets", () => installLongNames(h, host));
+  test("links refused", () => installLinksRefused(h, host));
+  test("never through a link", () => installThroughLinks(h, host));
+  test("its directory", () => installTarget(h, host));
+  test("a large file in its own size", () => installLargeFile(h, host));
+  test("FS calls failing", () => fsFailures(h, host));
+});
+
 // Node's Web Locks can grant an exclusive lock twice, so install-concurrent runs only in browsers.
 describe.each(h.data.runtimes)("engine data on the $name runtime", (runtime) => {
   test("install-fresh", () => installFresh(h, runtime));
```

The fixtures move to the host that uses them. `ibusWeb.runtime.installArchives` goes, with `runtime/libibus-web/archives.nix`; its archives are built by a recipe of the worker-host's, pax as engines' archives are, each under a store path, and the archives the installer must refuse sit under one too, since every entry is now checked against the archive's store path:

```bash
nix develop -c git mv runtime/libibus-web/tests/archives/make-tree.py packages/worker-host/test/archives/make-tree.py
nix develop -c git rm runtime/libibus-web/archives.nix
```

```diff
diff --git a/runtime/libibus-web/tests/archives/make-tree.py b/packages/worker-host/test/archives/make-tree.py
similarity index 71%
rename from runtime/libibus-web/tests/archives/make-tree.py
rename to packages/worker-host/test/archives/make-tree.py
--- a/runtime/libibus-web/tests/archives/make-tree.py
+++ b/packages/worker-host/test/archives/make-tree.py
@@ -1,18 +1,22 @@
 # SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 # SPDX-License-Identifier: LGPL-2.1-or-later
 
-"""Writes the tree the installer's test archive holds, the archives it must
-refuse, and the listing an installed tree must match.
+"""Writes the tree the installer's test archive holds, the listing an
+installed tree must match, and the archives the installer must refuse.
 
 Usage: make-tree.py TREE OUT
        make-tree.py --upgrade TREE OUT
+       make-tree.py --refused STORE_NAME OUT
        make-tree.py --corrupt OUT
 
 TREE receives the tree, from which the caller builds OUT/tree.tar with GNU
-tar; this script writes the refused archives and OUT/listing.txt, and
-OUT/corrupt.tar once tree.tar exists (run with --corrupt). With --upgrade,
-TREE receives the next version's tree, which drops a file and turns
-another into a directory, and OUT/listing-upgrade.txt its listing.
+tar, and OUT/listing.txt its listing. With --upgrade, TREE receives the
+next version's tree, which drops a file and turns another into a
+directory, and OUT/listing-upgrade.txt its listing. --refused writes
+OUT/refused/*.tar, each a file under the store path STORE_NAME that the
+installer accepts, then one member it must refuse, and OUT/symlink.tar, a
+link to "/" under it. --corrupt writes OUT/corrupt.tar once tree.tar
+exists.
 """
 
 import hashlib
@@ -93,20 +97,23 @@ def member(name, kind=tarfile.REGTYPE, data=b"", linkname=""):
     return info, (io.BytesIO(data) if kind == tarfile.REGTYPE else None)
 
 
-def refused(path, bad):
-    """An archive with a file the installer accepts, then one member it must
-    refuse."""
+def refused(path, store, bad):
+    """An archive with a file under the store path that the installer
+    accepts, then one member it must refuse."""
     with tarfile.open(path, "w", format=tarfile.USTAR_FORMAT) as tar:
-        tar.addfile(*member("ok.txt", data=b"accepted\n"))
+        tar.addfile(*member(f"{store}/ok.txt", data=b"accepted\n"))
         tar.addfile(*bad)
 
 
-def write_refused(out):
-    refused(f"{out}/absolute.tar", member("/ibus-web-escape.txt", data=b"escaped\n"))
-    refused(f"{out}/dotdot.tar", member("sub/../../ibus-web-escape.txt", data=b"escaped\n"))
-    refused(f"{out}/symlink.tar", member("link", tarfile.SYMTYPE, linkname="/"))
-    refused(f"{out}/hardlink.tar", member("hard", tarfile.LNKTYPE, linkname="ok.txt"))
-    refused(f"{out}/fifo.tar", member("fifo", tarfile.FIFOTYPE))
+def write_refused(store, out):
+    os.makedirs(f"{out}/refused", exist_ok=True)
+    escape = member("/ibus-web-escape.txt", data=b"escaped\n")
+    refused(f"{out}/refused/absolute.tar", store, escape)
+    refused(f"{out}/refused/dotdot.tar", store, member(f"{store}/../../ibus-web-escape.txt", data=b"escaped\n"))
+    refused(f"{out}/refused/outside.tar", store, member("ibus-web-escape.txt", data=b"escaped\n"))
+    refused(f"{out}/refused/hardlink.tar", store, member(f"{store}/hard", tarfile.LNKTYPE, linkname=f"{store}/ok.txt"))
+    refused(f"{out}/refused/fifo.tar", store, member(f"{store}/fifo", tarfile.FIFOTYPE))
+    refused(f"{out}/symlink.tar", store, member(f"{store}/link", tarfile.SYMTYPE, linkname="/"))
 
 
 def write_corrupt(out):
@@ -124,6 +131,8 @@ def write_corrupt(out):
 if __name__ == "__main__":
     if sys.argv[1] == "--corrupt":
         write_corrupt(sys.argv[2])
+    elif sys.argv[1] == "--refused":
+        write_refused(*sys.argv[2:4])
     elif sys.argv[1] == "--upgrade":
         tree, out = sys.argv[2:4]
         write_tree(tree, UPGRADE_FILES)
@@ -136,4 +145,3 @@ if __name__ == "__main__":
         os.makedirs(out, exist_ok=True)
         with open(f"{out}/listing.txt", "w") as f:
             f.write(listing(tree))
-        write_refused(out)
```

(The script keeps its `LGPL-2.1-or-later` header: moving it doesn't relicense it.) Create `packages/worker-host/_archives.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

# The archives the host's tests install, built as engines' archives are:
# pax, with archiveTarFlags, each entry named from the store's root under a
# store path.
#
# tree.tar holds a tree of nested directories and files spanning several
# storage chunks under dataName, and tree-upgrade.tar the next version's
# tree; tree.json describes each, its version (from its bytes), its unpacked
# size in bytes and its listing, one `PATH<TAB>d` or `PATH<TAB>f SIZE
# SHA256` line per entry relative to the store path, sorted bytewise, with
# tree-upgrade.tar's under `upgrade`. tree.tar.br is tree.tar compressed,
# truncated.tar.br the same cut short, and corrupt.tar.br no Brotli at all.
#
# The installer's own tests take the rest, which fixtures.json names:
# long.tar, under longName, has a name and a link target too long for
# ustar, and is built twice, from the tree as written and with its times
# changed, which must give the same bytes; refused/ holds archives under
# refusedName of a file the installer accepts, then one member it must
# refuse; symlink.tar a link to "/", which it accepts; and corrupt.tar is
# tree.tar with a header's checksum broken.
{
  runCommand,
  python3,
  gnutar,
  jq,
  brotli,
  archiveTarFlags,
  dataName,
  longName,
  refusedName,
}:
runCommand "ibus-web-worker-host-archives"
  {
    nativeBuildInputs = [
      python3
      gnutar
      jq
      brotli
    ];
  }
  ''
    mkdir $out

    # Archives the tree $1 as the store path $2, into $out/$3.
    pack() {
      rm -rf store
      mkdir store
      cp -a "$1" "store/$2"
      tar ${archiveTarFlags} --mode=u+rw,go=rX -C store -cf "$out/$3" "$2"
      rm -rf store
    }

    # Describes the archive $1 of the tree $2, whose listing is $3, as JSON.
    describe() {
      local archive=$1 tree=$2 listing=$3 size version
      size=$(find "$tree" -type f -printf '%s\n' | awk '{ sum += $1 } END { print sum + 0 }')
      version=$(sha256sum "$out/$archive" | cut -c1-16)
      jq -n --arg archive "$archive" --arg version "$version" --argjson size "$size" \
        --rawfile listing "$out/$listing" \
        '{ $archive, $version, $size, $listing }'
    }

    python3 ${./test/archives/make-tree.py} tree $out
    python3 ${./test/archives/make-tree.py} --upgrade tree-upgrade $out
    pack tree ${dataName} tree.tar
    pack tree-upgrade ${dataName} tree-upgrade.tar
    describe tree.tar tree listing.txt > tree.json
    describe tree-upgrade.tar tree-upgrade listing-upgrade.txt > upgrade.json
    jq --slurpfile upgrade upgrade.json '. + { upgrade: $upgrade[0] }' tree.json > $out/tree.json

    python3 ${./test/archives/make-tree.py} --refused ${refusedName} $out
    python3 ${./test/archives/make-tree.py} --corrupt $out

    name="data/$(printf 'n%.0s' $(seq 120)).txt"
    target="/nix/store/00000000000000000000000000000000-$(printf 't%.0s' $(seq 70))/share/data"
    mkdir -p long/data
    printf 'long\n' > "long/$name"
    ln -s "$target" long/data/link
    pack long ${longName} long.tar
    touch -d @1000000000 "long/$name" long/data
    touch -h -d @1000000000 long/data/link
    mv $out/long.tar first.tar
    pack long ${longName} long.tar
    cmp first.tar $out/long.tar

    jq -n --arg data ${dataName} --arg refused ${refusedName} --arg longName ${longName} \
      --arg name "$name" --arg target "$target" \
      '{ $data, $refused, long: { storeName: $longName, $name, $target } }' > $out/fixtures.json

    brotli --quality=11 --output=$out/tree.tar.br $out/tree.tar
    head -c -1 $out/tree.tar.br > $out/truncated.tar.br
    printf '\377\377\377\377' > $out/corrupt.tar.br
  ''
```

In `packages/worker-host/module.nix`, build them with it:

```diff
diff --git a/packages/worker-host/module.nix b/packages/worker-host/module.nix
--- a/packages/worker-host/module.nix
+++ b/packages/worker-host/module.nix
@@ -219,32 +219,14 @@
         );
 
       # The test engines' data is installed at the store's root, so their
-      # archives' entries are named from there, under the store path the
+      # archives' entries are named from there, under the store paths the
       # tests give them.
-      testDataName = "00000000000000000000000000000000-test-data";
-      archives =
-        pkgs.runCommand "ibus-web-worker-host-archives"
-          {
-            nativeBuildInputs = [
-              pkgs.brotli
-              pkgs.gnutar
-            ];
-          }
-          ''
-            mkdir $out
-            cp ${runtime.installArchives}/* $out/
-            chmod u+w $out/*
-            for archive in tree tree-upgrade; do
-              mkdir -p store/${testDataName}
-              tar -xf $out/$archive.tar -C store/${testDataName}
-              tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
-                --mode=u+rw,go=rX -C store -cf $out/$archive.tar ${testDataName}
-              rm -rf store
-            done
-            brotli --quality=11 --output=$out/tree.tar.br $out/tree.tar
-            head -c -1 $out/tree.tar.br > $out/truncated.tar.br
-            printf '\377\377\377\377' > $out/corrupt.tar.br
-          '';
+      archives = pkgs.callPackage ./_archives.nix {
+        inherit (config.ibusWeb.lib) archiveTarFlags;
+        dataName = "00000000000000000000000000000000-test-data";
+        longName = "33333333333333333333333333333333-test-long";
+        refusedName = "44444444444444444444444444444444-test-refused";
+      };
 
       # Each runs the host's tests on the asserting runtime and the released
       # one, from the built package.
```

and in `runtime/libibus-web/options.nix` drop the option:

```diff
diff --git a/runtime/libibus-web/options.nix b/runtime/libibus-web/options.nix
--- a/runtime/libibus-web/options.nix
+++ b/runtime/libibus-web/options.nix
@@ -9,11 +9,6 @@
         type = lib.types.package;
         description = "libibus-web for pkgsWasm: the static library the Worker host drives, its header and its pkg-config file.";
       };
-
-      installArchives = lib.mkOption {
-        type = lib.types.package;
-        description = "Archives for testing engine data installs: tree.tar, a deterministic ustar of nested directories and files spanning several storage chunks, and tree-upgrade.tar, the next version's tree built the same way; listing.txt and listing-upgrade.txt, their listings, one `PATH<TAB>d` or `PATH<TAB>f SIZE SHA256` line per entry, sorted bytewise; tree.json, tree.tar's version (from its bytes), its unpacked size in bytes and its listing, with the same for tree-upgrade.tar under `upgrade`; and archives the installer must refuse: absolute.tar, dotdot.tar, symlink.tar, hardlink.tar, fifo.tar (each a valid file, then the refused member) and corrupt.tar (tree.tar with a header's checksum broken).";
-      };
     };
   };
 }
```

Give the tests the fixtures' names. In `packages/worker-host/test/shared/harness.ts` and `test/node/config.ts`:

```diff
diff --git a/packages/worker-host/test/node/config.ts b/packages/worker-host/test/node/config.ts
--- a/packages/worker-host/test/node/config.ts
+++ b/packages/worker-host/test/node/config.ts
@@ -37,7 +37,7 @@ import { fileURLToPath, pathToFileURL } from "node:url";
 import { browserMode, crossOriginIsolation, servePlugin, serveDirs } from "@ibus-web/test-programs/vitest";
 import type { TestProjectInlineConfiguration, ViteUserConfig } from "vitest/config";
 import type { ModuleManifest } from "@ibus-web/protocol";
-import type { BuildConstants, TestArchive, TestData } from "../shared/harness.ts";
+import type { BuildConstants, InstallerArchives, TestArchive, TestData } from "../shared/harness.ts";
 import { commands } from "./commands.ts";
 
 const environments = ["node", "chromium", "firefox"] as const;
@@ -194,6 +194,10 @@ export const workerHostConfig = async (): Promise<ViteUserConfig> => {
       tree: { ...tree, url: url("archives", tree.archive) },
       upgrade: { ...upgrade, url: url("archives", upgrade.archive) },
       missing: url("archives", "missing.tar"),
+      installer: {
+        base: url("archives", ""),
+        ...readJson<Omit<InstallerArchives, "base">>(join(manifest.archives, "fixtures.json")),
+      },
     },
   });
   const dirs = {
diff --git a/packages/worker-host/test/shared/harness.ts b/packages/worker-host/test/shared/harness.ts
--- a/packages/worker-host/test/shared/harness.ts
+++ b/packages/worker-host/test/shared/harness.ts
@@ -69,8 +69,19 @@ export interface TestData {
   // thread and glib-stress's lock takes per thread.
   stress: { threads: number; rounds: number; iterations: number };
   // The engine's data, the next version's, which drops a file and turns
-  // another into a directory, and a URL where no archive is.
-  archives: { tree: TestArchive; upgrade: TestArchive; missing: string };
+  // another into a directory, a URL where no archive is, and the installer's
+  // own archives.
+  archives: { tree: TestArchive; upgrade: TestArchive; missing: string; installer: InstallerArchives };
+}
+
+// The archives the installer's own tests take: each is at base followed by
+// its file name, refused/*.tar under the store path refused, and long.tar
+// under long.storeName, with a name and a link target too long for ustar.
+export interface InstallerArchives {
+  base: string;
+  data: string;
+  refused: string;
+  long: { storeName: string; name: string; target: string };
 }
 
 export interface HostOptions {
```

`ibusWeb.lib.archiveTarFlags`, which the recipe takes, is Step 4's; add it now (Step 4 shows it) so the fixtures build.

- [ ] **Step 3: Run them to see them fail**

```bash
nix develop -c git add packages/worker-host runtime/libibus-web modules/flake/lib.nix
nix develop -c sh -c 'cd packages/worker-host && tsc -b --noEmit tsconfig.json'
nix build .#checks.x86_64-linux.worker-host-node -L
```

Expected: FAIL. `tsc` refuses `archive.test.ts`'s imports of `extract`, `placeEntry` and `relativeName`, `startup.test.ts`'s `fs`, and the test worker's `install` and `fsActions` users; `worker-host-node` fails `archive.test.ts`'s installer cases. (The spike ran the suites only with the task whole; this intermediate state wasn't run.)

- [ ] **Step 4: Make archives pax**

GNU tar's pax format keeps a name or link target longer than ustar's fields in an extended header. Left to itself it also records each file's `atime` and `ctime` and names the extended headers after its pid, so the flags drop both. In `modules/flake/lib.nix`:

```diff
diff --git a/modules/flake/lib.nix b/modules/flake/lib.nix
--- a/modules/flake/lib.nix
+++ b/modules/flake/lib.nix
@@ -46,6 +46,21 @@ in
     # compiler.
     isEmscriptenWasm = platform: platform.isWasm && (platform.useEmscripten or false);
 
+    # GNU tar's flags for an archive of engine data. pax keeps a name or a
+    # link target longer than ustar's 100 bytes in an extended header; the
+    # rest make the same tree give the same bytes whatever its files' times
+    # and owners: pax would otherwise record each file's atime and ctime, and
+    # name its extended headers after the writer's pid.
+    archiveTarFlags = lib.concatStringsSep " " [
+      "--format=pax"
+      "--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime"
+      "--sort=name"
+      "--mtime=@0"
+      "--owner=0"
+      "--group=0"
+      "--numeric-owner"
+    ];
+
     # Shell words for the flags automake compiles a configured source
     # directory's files with, read from its Makefile, which holds them only
     # as make variables. They start with the options configure added to CC
@@ -93,7 +108,12 @@ in
         '';
 
       ibusWeb.lib = {
-        inherit (flakeLib) patchesIn isEmscriptenWasm makeCflags;
+        inherit (flakeLib)
+          patchesIn
+          isEmscriptenWasm
+          makeCflags
+          archiveTarFlags
+          ;
 
         # Emscripten's installed tree: its system libraries' sources, its
         # JavaScript libraries and its tools.
```

and use them for engine distributions, in `modules/engines/manifest.nix` and the option's description:

```diff
diff --git a/modules/engines/manifest.nix b/modules/engines/manifest.nix
--- a/modules/engines/manifest.nix
+++ b/modules/engines/manifest.nix
@@ -79,7 +79,7 @@
               # check that each lies under the archive's own store path. Hard
               # links, which store optimisation makes of identical files, are
               # stored as files: the installer takes none.
-              tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
+              tar ${config.ibusWeb.lib.archiveTarFlags} \
                 --hard-dereference -C /nix/store -cf data.tar "$(basename "$storePath")"
               # The bytes the installer writes: every name of a hard-linked
               # file in full, and nothing for a link.
diff --git a/modules/engines/options.nix b/modules/engines/options.nix
--- a/modules/engines/options.nix
+++ b/modules/engines/options.nix
@@ -7,7 +7,7 @@
       type = lib.types.functionTo lib.types.package;
       description = ''
         Build an engine distribution from its side module, data closure, thread share and heap budget.
-        Each store path of the closure but the module's own becomes a Brotli-compressed ustar archive
+        Each store path of the closure but the module's own becomes a Brotli-compressed pax archive
         whose entries are named from /nix/store (`<hash>-<name>/...`, or the single file), with hard
         links stored as files; the build fails if a symbolic link in the closure leads outside it.
         `engines` lists the module's engine descriptors, the first being its default, either as Nix
```

- [ ] **Step 5: Export `FS` from the runtime, and its constants**

WasmFS's JavaScript `FS` (`src/lib/libwasmfs.js` in Emscripten 6.0.9) is linked whole only with the file system forced; it has no `fsync`, and libc's, with `__errno_location`, is on the export list already with the rest of libc. In `runtime/ibus-runtime/module.nix`:

```diff
diff --git a/runtime/ibus-runtime/module.nix b/runtime/ibus-runtime/module.nix
--- a/runtime/ibus-runtime/module.nix
+++ b/runtime/ibus-runtime/module.nix
@@ -71,8 +71,11 @@
         toolchain.runtimeMainFlags
 
         # The Worker host reads and writes requests in the runtime's memory,
-        # and tops Emscripten's pthread pool up while it is idle.
-        "-sEXPORTED_RUNTIME_METHODS=HEAPU8,PThread"
+        # tops Emscripten's pthread pool up while it is idle, and writes the
+        # engine data it installs through WasmFS's JavaScript API, which a
+        # link includes whole only when the file system is forced.
+        "-sEXPORTED_RUNTIME_METHODS=HEAPU8,PThread,FS"
+        "-sFORCE_FILESYSTEM=1"
         "-sPTHREAD_POOL_SIZE='${toString poolSize}+Module[\"ibuswebEngineThreads\"]'"
         "-sPTHREAD_POOL_SIZE_STRICT=2"
 
```

The host needs the target's errno values, `open()` flags and mode bits to drive `FS`; `constants.json` gains them. In `runtime/ibus-runtime/constants.c` and the load test that lists its keys:

```diff
diff --git a/runtime/ibus-runtime/constants.c b/runtime/ibus-runtime/constants.c
--- a/runtime/ibus-runtime/constants.c
+++ b/runtime/ibus-runtime/constants.c
@@ -2,18 +2,32 @@
  * SPDX-License-Identifier: MIT OR Apache-2.0 */
 
 /* The host uses the target's ABI, errno and backend flags when serving
- * requests. */
+ * requests, and its file-system constants when it installs engine data
+ * through Emscripten's FS. */
 #include <errno.h>
+#include <fcntl.h>
 #include <ibus-web/protocol.h>
 #include <ibus-web/runtime.h>
 #include <ibus-web/wasmfs-idb.h>
 #include <stdio.h>
+#include <sys/stat.h>
 
 int main(void) {
   printf("{\"pumpError\": %d, \"waitTimedOut\": %d", IBUSWEB_PUMP_ERROR,
          -ETIMEDOUT);
   printf(", \"idbReadOnly\": %u", WASMFS_IDB_READ_ONLY);
-  printf(", \"runtimeAbi\": %u, \"protocol\": %u, \"canceled\": %d}\n",
+  printf(", \"runtimeAbi\": %u, \"protocol\": %u, \"canceled\": %d",
          IBUSWEB_RUNTIME_ABI, IBUSWEB_PROTOCOL_VERSION, -ECANCELED);
+
+  printf(
+      ", \"fs\": {\"errno\": {\"EEXIST\": %d, \"EFBIG\": %d, \"EINVAL\": %d, "
+      "\"EISDIR\": %d, \"ENOENT\": %d, \"ENOTDIR\": %d, "
+      "\"EOPNOTSUPP\": %d}",
+      EEXIST, EFBIG, EINVAL, EISDIR, ENOENT, ENOTDIR, EOPNOTSUPP);
+  printf(", \"open\": {\"O_WRONLY\": %d, \"O_CREAT\": %d, \"O_TRUNC\": %d, "
+         "\"O_NOFOLLOW\": %d}",
+         O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW);
+  printf(", \"mode\": {\"S_IFMT\": %d, \"S_IFDIR\": %d, \"S_IFLNK\": %d}}}\n",
+         S_IFMT, S_IFDIR, S_IFLNK);
   return 0;
 }
diff --git a/runtime/ibus-runtime/tests/load.test.ts b/runtime/ibus-runtime/tests/load.test.ts
--- a/runtime/ibus-runtime/tests/load.test.ts
+++ b/runtime/ibus-runtime/tests/load.test.ts
@@ -247,6 +247,7 @@ test("released and asserting distributions ship the generated runtime constants"
   const constants = JSON.parse(expected) as Record<string, unknown>;
   expect(Object.keys(constants).sort()).toEqual([
     "canceled",
+    "fs",
     "idbReadOnly",
     "memory",
     "poolLowWater",
```

- [ ] **Step 6: Remove the C extractor**

```bash
nix develop -c git rm runtime/libibus-web/src/install.c runtime/libibus-web/tests/test-install.c
```

```diff
diff --git a/runtime/libibus-web/checks.nix b/runtime/libibus-web/checks.nix
--- a/runtime/libibus-web/checks.nix
+++ b/runtime/libibus-web/checks.nix
@@ -90,7 +90,6 @@
           "-Dtests=true"
           "-Dtest_main_link_args=${mesonArray toolchain.testMainFlags}"
           "-Dtest_side_module_link_args=${mesonArray toolchain.sideModuleFlags}"
-          "-Dtest_archives=${runtime.installArchives}"
           "-Dtest_us_keymap=${config.ibusWeb.keysyms.usKeymapVectors}"
         ];
         installPhase = ''
diff --git a/runtime/libibus-web/include/ibus-web/runtime.h b/runtime/libibus-web/include/ibus-web/runtime.h
--- a/runtime/libibus-web/include/ibus-web/runtime.h
+++ b/runtime/libibus-web/include/ibus-web/runtime.h
@@ -163,66 +163,6 @@ IBUSWEB_API int32_t ibusweb_test_dispatch(const uint8_t *request,
                                           uint32_t request_len, uint8_t *reply,
                                           uint32_t reply_cap);
 
-/* A streaming extractor of an engine's data: a POSIX ustar archive,
- * uncompressed, fed in pieces of any size as they arrive and written
- * through the file system as it goes.
- *
- * It takes regular files, directories and symbolic links. A hard link fails
- * the install with -EOPNOTSUPP. A device, a FIFO, an extended header, a
- * name that is absolute or has a ".." component, a link with data or no
- * target, a header whose checksum doesn't match, or one that isn't ustar's
- * fails it with -EINVAL, as does an archive that ends before its
- * end-of-archive blocks. A link keeps its target as the archive has it,
- * unresolved. Nothing is written through a link: a member under one fails
- * with -ENOTDIR, and a file or link member replaces a link already at its
- * name; a link member also replaces a file there, and fails with -EISDIR
- * on a directory. Files and directories take the
- * archive's permission bits, plus the owner's read and write (and search,
- * for a directory), so that an install can always redo what an earlier one
- * wrote; a file that exists already is truncated and rewritten, a directory
- * that exists already is kept, both take the archive's mode as new ones do,
- * and missing parents are created, so installing again over a tree an
- * earlier install left half-written completes it. Nothing the archive lacks
- * is removed. Entries already written before a failure stay. Each file is
- * fsync()ed once written.
- *
- * Call it on one thread at a time; the file system's own calls may block,
- * as the IndexedDB backend's do. */
-typedef struct _IBusWebInstall IBusWebInstall;
-
-/* Starts extracting into `dir` (which must exist). Returns 0, -EINVAL
- * without dir or out, -ENOENT or -ENOTDIR if dir isn't a directory, or
- * -ENOMEM. */
-IBUSWEB_API int ibusweb_install_begin(const char *dir, IBusWebInstall **out);
-
-/* Caps the cumulative regular-file bytes. Call before the first feed;
- * otherwise returns -EINVAL. The default is UINT64_MAX. A member exceeding
- * the remaining budget fails feed with -EFBIG before creating its parents
- * or opening/sizing the file. Headers, padding and filesystem metadata do
- * not count toward this limit; the caller checks the final count for exact
- * equality when the declaration is also an expected size. */
-IBUSWEB_API int ibusweb_install_set_limit(IBusWebInstall *install,
-                                          uint64_t bytes);
-
-/* Feeds the next `len` bytes of the archive; returns 0 or a negative errno.
- * Once a feed has failed, every later one fails the same way; NULL data with
- * a length fails it with -EINVAL. Bytes after the end-of-archive blocks are
- * ignored. */
-IBUSWEB_API int ibusweb_install_feed(IBusWebInstall *install,
-                                     const uint8_t *data, uint32_t len);
-
-/* What the install has written so far: the regular files written whole,
- * and the bytes of file data written; links count as neither. Call it before
- * ibusweb_install_end(), which frees `install`; a NULL install gives 0 and 0.
- * Either pointer may be NULL. */
-IBUSWEB_API void ibusweb_install_count(const IBusWebInstall *install,
-                                       uint32_t *files, uint64_t *bytes);
-
-/* Finishes: fsyncs what it wrote, returns 0 or a negative errno, frees
- * `install`. Returns a failed feed's error, or -EINVAL if the archive ended
- * early. */
-IBUSWEB_API int ibusweb_install_end(IBusWebInstall *install);
-
 /* Whole records in sequence order. The pointer remains valid until the next
  * runtime call, ibusweb_wait() included: a call another thread proxied to
  * the pumping thread runs inside the wait, and one that appends a record
diff --git a/runtime/libibus-web/meson.build b/runtime/libibus-web/meson.build
--- a/runtime/libibus-web/meson.build
+++ b/runtime/libibus-web/meson.build
@@ -31,7 +31,6 @@ libibus_web = static_library(
   'src/dispatch.c',
   'src/log.c',
   'src/call-op.cpp',
-  'src/install.c',
   include_directories: [include_directories('include'), ibus_includes],
   c_args: ['-DG_LOG_DOMAIN="ibus-web"'] + (get_option('tests') ? ['-DIBUSWEB_TESTS'] : []),
   cpp_args: '-DG_LOG_DOMAIN="ibus-web"',
diff --git a/runtime/libibus-web/meson.options b/runtime/libibus-web/meson.options
--- a/runtime/libibus-web/meson.options
+++ b/runtime/libibus-web/meson.options
@@ -18,12 +18,6 @@ option(
   value: [],
   description: 'Link arguments for the side modules the tests load',
 )
-option(
-  'test_archives',
-  type: 'string',
-  value: '',
-  description: 'The directory of archives the install tests extract',
-)
 option(
   'test_us_keymap',
   type: 'string',
diff --git a/runtime/libibus-web/tests/meson.build b/runtime/libibus-web/tests/meson.build
--- a/runtime/libibus-web/tests/meson.build
+++ b/runtime/libibus-web/tests/meson.build
@@ -40,18 +40,6 @@ test(
   depends: side_modules,
 )
 
-test_install = executable(
-  'test-install',
-  'test-install.c',
-  dependencies: libibus_web_dep,
-  link_args: get_option('test_main_link_args'),
-)
-
-install_env = environment()
-install_env.set('IBUSWEB_TEST_ARCHIVES', get_option('test_archives'))
-
-test('install', test_install, protocol: 'tap', env: install_env)
-
 test_serializable = executable(
   'test-serializable',
   'test-serializable.c',
```

The runtime ABI stays 1: nothing is published yet.

- [ ] **Step 7: The installer**

The writes, with every rule the C extractor had. Create `packages/worker-host/src/worker/install/writer.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Writing an archive's entries into a directory through WasmFS's FS, so the
// stored layout has the one writer whatever backs the mount. Every call is
// synchronous; the caller waits for whatever it must between them.

import { RuntimeRefused, type RuntimeHandle } from "../runtime.ts";

// The regular files written whole, and the bytes of file data written.
export interface Written {
  files: number;
  bytes: number;
}

// A regular file being written: its data, in order, then end().
export interface FileWriter {
  write(data: Uint8Array): void;
  end(): void;
}

export interface EntryWriter {
  directory(name: string, mode: number): void;
  symlink(name: string, target: string): void;
  // Refuses a file larger than what is left of the limit before making
  // anything of it.
  file(name: string, mode: number, size: number): FileWriter;
  readonly written: Readonly<Written>;
  // Closes the file being written, if any, after a failure. Call it only
  // while the runtime is fit to call.
  abandon(): void;
}

// Writes into dir, an existing directory, at most limit bytes of file data.
// Names are relative to dir, with no empty, "." or ".." components; the
// empty name is dir itself. A failure throws RuntimeRefused, naming the
// entry and the negative errno, and leaves what was written before it.
export const entryWriter = (handle: RuntimeHandle, dir: string, limit: number): EntryWriter => {
  const { FS } = handle.rt;
  const { errno, open, mode: modeBits } = handle.fs;
  const written: Written = { files: 0, bytes: 0 };
  // The file being written, which a failure leaves open.
  let current: { fd: number } | undefined;

  const refused = (name: string, code: number): RuntimeRefused =>
    new RuntimeRefused(`${JSON.stringify(name)}: -${code}`);

  // An ErrnoError leaves the runtime fit to call; anything else thrown from
  // inside it may not.
  const fs = <T>(name: string, call: () => T): T => {
    try {
      return call();
    } catch (error) {
      if (error instanceof FS.ErrnoError) throw refused(name, error.errno);
      throw error;
    }
  };
  // unlink() and symlink() return their errno rather than throw it.
  const fsReturning = (name: string, call: () => number): void => {
    const ret = call();
    if (ret < 0) throw refused(name, -ret);
  };

  const pathOf = (name: string): string => (name === "" ? dir : `${dir}/${name}`);
  const isType = (st: { mode: number }, type: number): boolean => (st.mode & modeBits.S_IFMT) === type;
  // What is at path, not following a link there, or null for nothing.
  const lstat = (name: string, path: string): { mode: number } | null => {
    try {
      return FS.lstat(path);
    } catch (error) {
      if (error instanceof FS.ErrnoError && error.errno === errno.ENOENT) return null;
      if (error instanceof FS.ErrnoError) throw refused(name, error.errno);
      throw error;
    }
  };

  // mkdir() that accepts a directory already there. A link there is no
  // directory, even to one: following it would let the archive write
  // outside dir through a link it made itself.
  const ensureDir = (name: string, path: string, mode: number): void => {
    try {
      FS.mkdir(path, mode);
      return;
    } catch (error) {
      if (!(error instanceof FS.ErrnoError) || error.errno !== errno.EEXIST) {
        if (error instanceof FS.ErrnoError) throw refused(name, error.errno);
        throw error;
      }
    }
    const st = lstat(name, path);
    if (st === null || !isType(st, modeBits.S_IFDIR)) throw refused(name, errno.ENOTDIR);
  };

  // Creates the parents of name that are missing, since an archive need not
  // list them.
  const ensureParents = (name: string): void => {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) ensureDir(name, pathOf(parts.slice(0, i).join("/")), 0o755);
  };

  // The archive's permission bits, plus the owner's read and write, so that
  // an install can always redo what an earlier one wrote.
  const permissions = (mode: number): number => (mode & 0o777) | 0o600;

  const checkDir = (): void => {
    const st = lstat(dir, dir);
    if (st === null) throw refused(dir, errno.ENOENT);
    if (!isType(st, modeBits.S_IFDIR)) throw refused(dir, errno.ENOTDIR);
  };
  checkDir();

  return {
    written,

    directory(name, mode) {
      if (name === "") return;
      ensureParents(name);
      const path = pathOf(name);
      const bits = permissions(mode) | 0o700;
      ensureDir(name, path, bits);
      // mkdir() applies the umask, and leaves a directory already there as
      // it was.
      fs(name, () => FS.chmod(path, bits));
    },

    // A link's target is kept as the archive has it, absolute or relative,
    // and never resolved here: it may name a path another archive installs
    // later.
    symlink(name, target) {
      if (name === "" || target === "") throw refused(name, errno.EINVAL);
      ensureParents(name);
      const path = pathOf(name);
      // Whatever is there but a directory is replaced, never written
      // through.
      const st = lstat(name, path);
      if (st !== null) {
        if (isType(st, modeBits.S_IFDIR)) throw refused(name, errno.EISDIR);
        fsReturning(name, () => FS.unlink(path));
      }
      fsReturning(name, () => FS.symlink(target, path));
    },

    file(name, mode, size) {
      if (name === "") throw refused(name, errno.EINVAL);
      if (size > limit - written.bytes) throw refused(name, errno.EFBIG);
      ensureParents(name);
      const path = pathOf(name);
      const st = lstat(name, path);
      if (st !== null && isType(st, modeBits.S_IFLNK)) fsReturning(name, () => FS.unlink(path));
      const bits = permissions(mode);
      const stream = fs(name, () => FS.open(path, open.O_WRONLY | open.O_CREAT | open.O_TRUNC | open.O_NOFOLLOW, bits));
      current = stream;
      // open() applies the umask, and leaves a file already there its mode.
      fs(name, () => FS.fchmod(stream.fd, bits));
      // Sized before its data arrives, a file in memory takes its size once,
      // where appending each piece would grow it to as much as twice that
      // and need the old copy beside the new while it moves. Until the data
      // is written the file reads as zeros; an install cut short leaves no
      // marker, so nothing trusts such a file.
      if (size > 0) fs(name, () => FS.ftruncate(stream.fd, size));
      let left = size;
      return {
        write(data) {
          if (data.length > left) throw refused(name, errno.EINVAL);
          let at = 0;
          // A short write is retried with what is left.
          while (at < data.length) {
            const count = fs(name, () => FS.write(stream, data, at, data.length - at));
            if (count === 0) throw refused(name, errno.EINVAL);
            at += count;
            left -= count;
            written.bytes += count;
          }
        },
        end() {
          if (left !== 0) throw refused(name, errno.EINVAL);
          current = undefined;
          // fsync() is libc's: it reports failure in errno, and WasmFS's
          // FS has none of its own.
          if (handle.rt._fsync(stream.fd) !== 0) {
            const code = handle.words[handle.rt.___errno_location() / 4]!;
            fs(name, () => FS.close(stream));
            throw refused(name, code);
          }
          fs(name, () => FS.close(stream));
          written.files++;
        },
      };
    },

    abandon() {
      const file = current;
      current = undefined;
      if (file === undefined) return;
      try {
        FS.close(file);
      } catch (error) {
        if (!(error instanceof FS.ErrnoError)) throw error;
      }
    },
  };
};
```

The archive's side: the decoder, the store-path check and the stream's pieces. Replace `packages/worker-host/src/worker/install/archive.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Streaming the engine's data archives through a tar decoder and writing
// each entry through the runtime's file system as its bytes arrive, so
// neither a whole archive nor a whole file is ever held.

import { errorMessage, type ModuleManifest } from "@ibus-web/protocol";
import { createTarDecoder, type TarHeader } from "modern-tar";
import { decompressed, type BrotliDecoder } from "./decompress.ts";
import { entryWriter, type Written } from "./writer.ts";
import { engineDataRoot } from "../../shared/naming.ts";
import { INSTALL_PIECE } from "../../shared/config.ts";
import type { FsConstants } from "../../shared/messages.ts";
import { RuntimeRefused, type RuntimeHandle } from "../runtime.ts";
import { makeDirs } from "../storage/mount.ts";

// What an install has done: archive bytes fed to the decoder, and the
// regular files and bytes of file data written.
export interface Tally {
  fed: number;
  files: number;
  bytes: number;
}

export interface ArchiveHooks {
  // An archive that sends nothing for this long fails the install.
  readonly idleMs: number;
  readonly forceBrotliFallback: boolean;
  // Hears which decoder each Brotli archive goes through.
  readonly brotliDecoder: (decoder: BrotliDecoder) => void;
  // Called before each piece of the archive reaches the decoder; the
  // install waits for it.
  readonly beforePiece: (tally: Tally) => Promise<void> | undefined;
}

// What extract() hears besides the archive hooks: each piece arriving, and
// the install being held before a piece, which the archive's idle time
// leaves out.
export interface ExtractHooks extends Partial<Pick<ArchiveHooks, "beforePiece">> {
  readonly arrived?: () => void;
  readonly holding?: () => void;
}

// Fetching and reading happen outside the runtime, which they leave fit to
// call.
const outside = async <T>(what: string, promise: Promise<T>): Promise<T> => {
  try {
    return await promise;
  } catch (error) {
    throw new RuntimeRefused(`${what}: ${errorMessage(error)}`);
  }
};

// The entry's name with empty and "." components dropped, or null if it is
// absolute or has a ".." component. The empty name is the root itself.
export const relativeName = (name: string): string | null => {
  if (name === "" || name.startsWith("/")) return null;
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  return parts.includes("..") ? null : parts.join("/");
};

// Where the entry goes under the store's root, which every archive is
// extracted at, so one whose entries strayed from its own store path could
// replace another's files. Throws for an entry the installer refuses.
export const placeEntry = (header: TarHeader, storeName: string, { errno }: FsConstants): string => {
  const refuse = (code: number): never => {
    throw new RuntimeRefused(`${JSON.stringify(header.name)}: -${code}`);
  };
  // A hard link would name an entry written earlier, which a reader can't
  // trust to be the archive's; archives store each name whole instead.
  if (header.type === "link") refuse(errno.EOPNOTSUPP);
  if (header.type !== "file" && header.type !== "directory" && header.type !== "symlink") refuse(errno.EINVAL);
  // A size from a pax record moves where the entry's data ends, which
  // nothing that writes engine data needs.
  if (header.pax?.["size"] !== undefined) refuse(errno.EINVAL);
  // No store path's names or link targets hold these, and a pax record
  // whose length runs past its own newline leaves one in its value.
  if (/[\0\n]/.test(header.name) || /[\0\n]/.test(header.linkname ?? "")) refuse(errno.EINVAL);
  const name = relativeName(header.name);
  if (name === null) return refuse(errno.EINVAL);
  if (name !== storeName && !name.startsWith(`${storeName}/`))
    throw new RuntimeRefused(`archive entry ${JSON.stringify(name)} lies outside ${storeName}`);
  return name;
};

// Extracts the tar archive streaming from source into dir, an existing
// directory, where its entries must all lie under storeName, writing at
// most limit bytes of file data; adds the archive bytes it fed to tally.fed
// and returns what it wrote. what names the archive in a refusal.
export const extract = async (
  handle: RuntimeHandle,
  source: ReadableStream<Uint8Array>,
  what: string,
  dir: string,
  storeName: string,
  limit: number,
  tally: Tally,
  hooks: ExtractHooks,
): Promise<Written> => {
  const gate = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      hooks.arrived?.();
      for (let at = 0; at < chunk.length; at += INSTALL_PIECE) {
        const piece = chunk.subarray(at, at + INSTALL_PIECE);
        const held = hooks.beforePiece?.(tally);
        if (held !== undefined) {
          hooks.holding?.();
          await held;
          hooks.arrived?.();
        }
        controller.enqueue(piece);
        tally.fed += piece.length;
      }
    },
  });
  // Strict, the decoder refuses a header whose checksum doesn't match and
  // an archive that ends before its end-of-archive blocks, mid-header or
  // mid-file.
  const entries = source
    .pipeThrough(gate)
    .pipeThrough(createTarDecoder({ strict: true }))
    .getReader();
  // Reading fails outside the runtime, as the decoder refusing the archive
  // or its source failing.
  const read = async <T>(promise: Promise<T>): Promise<T> => {
    try {
      return await promise;
    } catch (error) {
      throw new RuntimeRefused(errorMessage(error));
    }
  };
  let done = false;
  // A file's next piece of data, until it is whole.
  const piece = new Uint8Array(INSTALL_PIECE);
  let writer: ReturnType<typeof entryWriter> | undefined;
  try {
    writer = entryWriter(handle, dir, limit);
    for (;;) {
      const next = await read(entries.read());
      if (next.done) break;
      const { header, body } = next.value;
      const name = placeEntry(header, storeName, handle.fs);
      const mode = header.mode ?? 0;
      if (header.type === "directory") {
        writer.directory(name, mode);
      } else if (header.type === "symlink") {
        writer.symlink(name, header.linkname ?? "");
      } else {
        const file = writer.file(name, mode, header.size);
        // The data goes in a piece at a time, each starting at a multiple of
        // the piece's size into the file and whole but for the file's last,
        // so a write covers whole every storage chunk of a size that divides
        // it.
        let left = header.size;
        let held = 0;
        const data = body.getReader();
        for (;;) {
          const chunk = await read(data.read());
          if (chunk.done) break;
          for (let at = 0; at < chunk.value.length;) {
            const want = Math.min(INSTALL_PIECE, left);
            const take = Math.min(chunk.value.length - at, want - held);
            if (take <= 0) throw new RuntimeRefused(`${JSON.stringify(name)}: data past its size`);
            piece.set(chunk.value.subarray(at, at + take), held);
            held += take;
            at += take;
            if (held < want) continue;
            file.write(piece.subarray(0, held));
            left -= held;
            held = 0;
          }
        }
        file.end();
      }
    }
    done = true;
    return writer.written;
  } catch (error) {
    // A failure from inside the runtime leaves it unfit to call, so nothing
    // is closed after one.
    if (!(error instanceof RuntimeRefused)) throw error;
    writer?.abandon();
    throw new RuntimeRefused(`${what}: ${error.message}`);
  } finally {
    if (!done) entries.cancel().catch(() => {});
  }
};

// Fetches the archive at url and extracts it into dir, the store's root,
// where its entries must all lie under storeName; its regular files must
// hold exactly expectedBytes.
const installArchive = async (
  handle: RuntimeHandle,
  url: string,
  dir: string,
  storeName: string,
  encoding: "br" | "identity",
  expectedBytes: number,
  tally: Tally,
  hooks: ArchiveHooks,
): Promise<void> => {
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arrived = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new Error(`nothing arrived for ${hooks.idleMs} ms`)), hooks.idleMs);
  };
  try {
    arrived();
    const response = await outside(`fetch ${url}`, fetch(url, { signal: idle.signal }));
    if (!response.ok || response.body === null) throw new RuntimeRefused(`fetch ${url}: ${response.status}`);
    const source = decompressed(response.body, encoding, hooks.forceBrotliFallback, hooks.brotliDecoder);
    makeDirs(handle, dir);
    const { files, bytes } = await extract(handle, source, `install ${url}`, dir, storeName, expectedBytes, tally, {
      ...hooks,
      arrived,
      holding: () => clearTimeout(timer),
    });
    if (bytes !== expectedBytes)
      throw new RuntimeRefused(`install ${url} size: expected ${expectedBytes} regular-file bytes, got ${bytes}`);
    tally.files += files;
    tally.bytes += bytes;
  } finally {
    clearTimeout(timer);
  }
};

// Installs every archive of the engine's data at the store's root, each at
// its own store path.
export const installArchives = async (
  handle: RuntimeHandle,
  engine: ModuleManifest,
  hooks: ArchiveHooks,
): Promise<Tally> => {
  const tally: Tally = { fed: 0, files: 0, bytes: 0 };
  const root = engineDataRoot(engine);
  for (const data of engine.data) {
    const storeName = data.storePath.slice(data.storePath.lastIndexOf("/") + 1);
    await installArchive(handle, data.url, root, storeName, data.encoding, data.size, tally, hooks);
  }
  return tally;
};
```

```bash
nix develop -c git rm packages/worker-host/src/worker/install/entries.ts
```

The runtime's surface, the constants it reads and the handle that carries them, in `src/worker/runtime.ts`, `src/shared/messages.ts`, `src/shared/index.ts`, `src/worker/startup.ts` and `src/worker/layers/runtime.ts`:

```diff
diff --git a/packages/worker-host/src/shared/index.ts b/packages/worker-host/src/shared/index.ts
--- a/packages/worker-host/src/shared/index.ts
+++ b/packages/worker-host/src/shared/index.ts
@@ -16,6 +16,7 @@ export {
   WASM_PAGE,
   type CollectReport,
   type EngineStorage,
+  type FsConstants,
   type HostInit,
   type HostMessage,
   type InstallReport,
diff --git a/packages/worker-host/src/shared/messages.ts b/packages/worker-host/src/shared/messages.ts
--- a/packages/worker-host/src/shared/messages.ts
+++ b/packages/worker-host/src/shared/messages.ts
@@ -33,6 +33,14 @@ export interface SideModule {
   bytes: ArrayBuffer;
 }
 
+// The target's errno values, open() flags and mode bits that the host's
+// installer uses.
+export interface FsConstants {
+  errno: Record<"EEXIST" | "EFBIG" | "EINVAL" | "EISDIR" | "ENOENT" | "ENOTDIR" | "EOPNOTSUPP", number>;
+  open: Record<"O_WRONLY" | "O_CREAT" | "O_TRUNC" | "O_NOFOLLOW", number>;
+  mode: Record<"S_IFMT" | "S_IFDIR" | "S_IFLNK", number>;
+}
+
 // Values the runtime's build defines, which the host checks its calls
 // against, and the bounds of the memory the runtime takes.
 export interface RuntimeConstants {
@@ -48,6 +56,7 @@ export interface RuntimeConstants {
   // The least and the most memory the runtime's memory import admits, in
   // bytes.
   memory: { minimum: number; maximum: number };
+  fs: FsConstants;
 }
 
 // What the host mounts at the engine's directory, /engines/<name>, for the
diff --git a/packages/worker-host/src/worker/layers/runtime.ts b/packages/worker-host/src/worker/layers/runtime.ts
--- a/packages/worker-host/src/worker/layers/runtime.ts
+++ b/packages/worker-host/src/worker/layers/runtime.ts
@@ -89,6 +89,7 @@ export const runtimeLayer: Layer.Layer<HostRuntime, StartupFailed, HostWorker |
           memory,
           bytes: rt.HEAPU8,
           words: new Int32Array(rt.HEAPU8.buffer),
+          fs: constants.fs,
         };
         instruments.runtimeStarted(handle);
 
diff --git a/packages/worker-host/src/worker/runtime.ts b/packages/worker-host/src/worker/runtime.ts
--- a/packages/worker-host/src/worker/runtime.ts
+++ b/packages/worker-host/src/worker/runtime.ts
@@ -4,7 +4,13 @@
 // What the host uses of ibus-runtime.js, and the plain functions that call
 // into it.
 
-import { WASM_PAGE, type RuntimeMemory, type SideModule, type RuntimeConstants } from "../shared/messages.ts";
+import {
+  WASM_PAGE,
+  type FsConstants,
+  type RuntimeMemory,
+  type SideModule,
+  type RuntimeConstants,
+} from "../shared/messages.ts";
 
 // A failure that leaves the runtime fit to be called again: a call into it
 // returned an error, or the host refused something before calling it.
@@ -36,16 +42,33 @@ export interface Runtime {
   _ibusweb_output_peek(length: number): number;
   _ibusweb_output_consume(length: number): void;
   _ibusweb_output_last_seq(): number;
-  _ibusweb_install_begin(dir: number, installOut: number): number;
-  _ibusweb_install_set_limit(install: number, bytes: bigint): number;
-  _ibusweb_install_feed(install: number, data: number, len: number): number;
-  _ibusweb_install_count(install: number, files: number, bytes: number): void;
-  _ibusweb_install_end(install: number): number;
+  _fsync(fd: number): number;
+  ___errno_location(): number;
+  // WasmFS's JavaScript API, through which the host writes the engine data
+  // it installs.
+  FS: EmscriptenFs;
   // Emscripten's own pthread pool, which the runtime exports for the host to
   // top it up.
   PThread: EmscriptenPool;
 }
 
+// What the host uses of WasmFS's FS. Most calls throw an ErrnoError on
+// failure; unlink() and symlink() return the negative errno instead. Paths
+// are absolute; a mode is the permission bits and, from lstat(), the type.
+export interface EmscriptenFs {
+  ErrnoError: new (errno: number) => Error & { errno: number };
+  mkdir(path: string, mode: number): void;
+  symlink(target: string, path: string): number;
+  unlink(path: string): number;
+  lstat(path: string): { mode: number; size: number };
+  chmod(path: string, mode: number): void;
+  open(path: string, flags: number, mode: number): { fd: number };
+  fchmod(fd: number, mode: number): void;
+  ftruncate(fd: number, length: number): void;
+  write(stream: { fd: number }, data: Uint8Array, offset: number, length: number): number;
+  close(stream: { fd: number }): void;
+}
+
 // Emscripten's internals, not an API: requireRuntime() checks they are there.
 interface EmscriptenPool {
   // The Workers pthread_create() hands threads to, last first.
@@ -69,12 +92,14 @@ export type CreateRuntime = (settings: {
 }) => Promise<Runtime>;
 
 // The runtime started in the memory the host made for it, with its views of
-// that memory. The memory never grows, so the views stay whole.
+// that memory and its file-system constants. The memory never grows, so the
+// views stay whole.
 export interface RuntimeHandle {
   rt: Runtime;
   memory: WebAssembly.Memory;
   bytes: Uint8Array;
   words: Int32Array;
+  fs: FsConstants;
 }
 
 // A memory the runtime can't take fails the load here, with the bounds,
@@ -98,8 +123,23 @@ export const checkMemory = (
 // drop; better to refuse to start than to fail at the first top-up.
 export const requireRuntime = (rt: Runtime): void => {
   const pool = (rt as Partial<Runtime>).PThread as Partial<EmscriptenPool> | undefined;
+  const fs = (rt as Partial<Runtime>).FS as Partial<EmscriptenFs> | undefined;
+  const fsCalls = [
+    "mkdir",
+    "symlink",
+    "unlink",
+    "lstat",
+    "chmod",
+    "open",
+    "fchmod",
+    "ftruncate",
+    "write",
+    "close",
+  ] as const;
   const missing = [
-    ...(typeof rt._ibusweb_install_set_limit === "function" ? [] : ["ibusweb_install_set_limit"]),
+    ...(typeof fs?.ErrnoError === "function" ? [] : ["FS.ErrnoError"]),
+    ...fsCalls.filter((name) => typeof fs?.[name] !== "function").map((name) => `FS.${name}`),
+    ...(typeof rt._fsync === "function" ? [] : ["fsync"]),
     ...(rt.HEAPU8 instanceof Uint8Array ? [] : ["HEAPU8"]),
     ...(Array.isArray(pool?.unusedWorkers) ? [] : ["PThread.unusedWorkers"]),
     ...(typeof pool?.allocateUnusedWorker === "function" ? [] : ["PThread.allocateUnusedWorker"]),
diff --git a/packages/worker-host/src/worker/startup.ts b/packages/worker-host/src/worker/startup.ts
--- a/packages/worker-host/src/worker/startup.ts
+++ b/packages/worker-host/src/worker/startup.ts
@@ -63,6 +63,19 @@ const runtimeConstants = Schema.Struct({
   waitTimedOut: integer,
   idbReadOnly: count,
   memory: Schema.Struct({ minimum: memoryBytes, maximum: memoryBytes }),
+  fs: Schema.Struct({
+    errno: Schema.Struct({
+      EEXIST: count,
+      EFBIG: count,
+      EINVAL: count,
+      EISDIR: count,
+      ENOENT: count,
+      ENOTDIR: count,
+      EOPNOTSUPP: count,
+    }),
+    open: Schema.Struct({ O_WRONLY: count, O_CREAT: count, O_TRUNC: count, O_NOFOLLOW: count }),
+    mode: Schema.Struct({ S_IFMT: count, S_IFDIR: count, S_IFLNK: count }),
+  }),
   poolLowWater: count,
 });
 
```

and the comments that named the extractor, in `src/shared/config.ts` and `src/worker/instruments.ts`:

```diff
diff --git a/packages/worker-host/src/shared/config.ts b/packages/worker-host/src/shared/config.ts
--- a/packages/worker-host/src/shared/config.ts
+++ b/packages/worker-host/src/shared/config.ts
@@ -28,6 +28,7 @@ export interface HostConfigValues {
   readonly deleteLimitMs: number;
 }
 
-// The response body reaches the extractor through a buffer of this size in
-// the runtime's memory, which also bounds each of the extractor's writes.
+// An archive reaches the tar decoder in pieces of at most this size, and each
+// file's data is written in pieces of at most this size, which the runtime
+// copies into its own memory one at a time.
 export const INSTALL_PIECE = 65536;
diff --git a/packages/worker-host/src/worker/instruments.ts b/packages/worker-host/src/worker/instruments.ts
--- a/packages/worker-host/src/worker/instruments.ts
+++ b/packages/worker-host/src/worker/instruments.ts
@@ -31,7 +31,7 @@ export interface Instruments {
   // A request for the lock wasn't granted at once, so the host waits.
   readonly waiting: (lock: string) => void;
   // Before the next piece of the engine's data, fed bytes into the install,
-  // reaches the extractor; the install waits for a promise.
+  // reaches the tar decoder; the install waits for a promise.
   readonly beforePiece: (fed: number) => Promise<void> | undefined;
   // Answers a request itself, or undefined to have the runtime dispatch it.
   // A promise has the host leave its request loop until it settles.
```

- [ ] **Step 8: Run the tests**

```bash
nix develop -c git add packages/worker-host runtime modules
nix build .#checks.x86_64-linux.worker-host-node .#checks.x86_64-linux.worker-host-browser \
  .#checks.x86_64-linux.libibus-web-tests .#checks.x86_64-linux.ibus-runtime-exports \
  .#checks.x86_64-linux.ibus-runtime-load .#checks.x86_64-linux.hangul-host \
  .#checks.x86_64-linux.tools-pack-licenses-tarball -L
nix build .#worker-host-node-integration .#worker-host-browser-integration -L
```

Expected: PASS. In the spike, on master: `worker-host-node` 87 (`archive.test.ts`'s 39 among them), `worker-host-browser` 8, `libibus-web-tests` 7 suites (63 cases, `test-install`'s gone), `ibus-runtime-load` 31, `hangul-host` 20, `worker-host-node-integration` 270 and `worker-host-browser-integration` 400 (each with the installer's 26: 13 scenarios on two runtimes, per browser). Firefox's streams take some 40 s over the whole test tree in 1-byte pieces, past a request's late-reply limit, so the tree goes in pieces of 7 bytes up and a small pax archive byte by byte; the install requests let the page go at once, since in Firefox a response body the host fetches waits while the page spins.

- [ ] **Step 9: Measure the runtime**

```bash
old=$(nix build --no-link --print-out-paths "git+file://$PWD?rev=$(git rev-parse HEAD)#packages.x86_64-linux.ibus-runtime")
new=$(nix build --no-link --print-out-paths .#packages.x86_64-linux.ibus-runtime)
stat -c '%s %n' "$old"/ibus-runtime.{js,wasm} "$new"/ibus-runtime.{js,wasm}
```

Expected: in the spike the released runtime's `ibus-runtime.js` grew from 2,053,841 to 2,062,834 bytes (+8,993; +1,811 as Brotli) and `ibus-runtime.wasm` shrank from 4,310,523 to 4,306,965 (−3,558; −1,135 as Brotli): `FS`'s JavaScript and its `_wasmfs_*` exports against `install.c`. The asserting runtime's grew by 13,038 and shrank by 3,544. The host's `dist/worker/index.js` grew from 578,334 to 600,281 bytes (+21,947, +5,991 gzipped), `modern-tar` and the installer against `entries.ts`.

- [ ] **Step 10: Document it**

```diff
diff --git a/docs/engines.md b/docs/engines.md
--- a/docs/engines.md
+++ b/docs/engines.md
@@ -127,25 +127,28 @@ adds headroom separately. Browser storage threads belong to the runtime's storag
 
 ### Archives and serving
 
-Each archive is deterministic POSIX ustar, Brotli quality 11 and the standard window (no `--large_window`). Entries are
-named from `/nix/store`: `<hash>-<name>/…`, or the bare `<hash>-<name>` file for a store path that is a single file.
-`--hard-dereference` stores hard links, which store optimisation makes of identical files, as regular files, since the
-installer takes none. Symbolic links are kept as links, with their targets as the store has them; before archiving,
-`tools/engine-manifest/symlinks.ts` resolves every link in the closure the way the engine's file system will, holding
-only the closure's store paths, and fails the build if one leads outside them. ustar holds a link target of at most 100
-bytes; GNU tar refuses a longer one and the build fails rather than archiving it. `size` counts unpacked regular-file
-bytes, every name of a hard-linked file in full and nothing for a symbolic link.
-
-The host extracts each archive at the root of the `/nix/store` mount. Since every archive lands there, the host follows
-each archive's ustar framing as it streams and refuses an entry outside the archive's own store path before the
-extractor sees it. The extractor (`ibusweb_install_feed`) takes regular files, directories and symbolic links
-(`SYMTYPE`), keeping a link's target unresolved; it refuses hard links (`LNKTYPE`) with `-EOPNOTSUPP` and never writes
-through a link: a member under one fails with `-ENOTDIR`, and a file or link member replaces a link already at its name.
-Before creating or sizing each regular file, the extractor rejects a member that would exceed the remaining declared
-budget. The host also requires exact equality after extraction before writing the installed marker. A mismatch is an
-ordinary installation refusal; a corrected retry reinstalls. This limit excludes tar headers/padding, decoder buffers
-and filesystem metadata, so it is not a total-memory or quota bound. Serve `.tar.br` as opaque bytes, **without
-`Content-Encoding: br`**: fetch must not decompress it before the host. `encoding: "identity"` supports plain ustar
+Each archive is deterministic pax, POSIX's extension of ustar, Brotli quality 11 and the standard window (no
+`--large_window`). GNU tar writes it with `ibusWeb.lib.archiveTarFlags`: pax keeps a name or a link target longer than
+ustar's 100 bytes in an extended header, as Rime's common data needs for its links into the dictionaries' store paths,
+and the flags drop pax's own `atime` and `ctime` records and name the extended headers without the writer's pid, so the
+same tree always gives the same bytes; the host's test archives are built twice with their times changed to check that.
+Entries are named from `/nix/store`: `<hash>-<name>/…`, or the bare `<hash>-<name>` file for a store path that is a
+single file. `--hard-dereference` stores hard links, which store optimisation makes of identical files, as regular
+files, since the installer takes none. Symbolic links are kept as links, with their targets as the store has them;
+before archiving, `tools/engine-manifest/symlinks.ts` resolves every link in the closure the way the engine's file
+system will, holding only the closure's store paths, and fails the build if one leads outside them. `size` counts
+unpacked regular-file bytes, every name of a hard-linked file in full and nothing for a symbolic link.
+
+The host extracts each archive at the root of the `/nix/store` mount, decoding it with `modern-tar`'s strict decoder and
+writing each entry through WasmFS's `FS` as it arrives ([storage.md](storage.md#installing)). Since every archive lands
+there, the host refuses an entry outside the archive's own store path before writing anything of it. It takes regular
+files, directories and symbolic links, keeping a link's target unresolved; it refuses hard links with `-EOPNOTSUPP` and
+never writes through a link: an entry under one fails with `-ENOTDIR`, and a file or link replaces a link already at its
+name. Before creating or sizing each regular file, the host rejects one that would exceed the remaining declared budget.
+It also requires exact equality after extraction before writing the installed marker. A mismatch is an ordinary
+installation refusal; a corrected retry reinstalls. This limit excludes tar headers and padding, decoder buffers and
+file-system metadata, so it is not a total-memory or quota bound. Serve `.tar.br` as opaque bytes, **without
+`Content-Encoding: br`**: fetch must not decompress it before the host. `encoding: "identity"` supports plain tar
 fixtures.
 
 Relative module/archive URLs in a fetched manifest resolve against the final response URL after redirects. Inline
@@ -154,8 +157,8 @@ manifests retain the caller's URLs.
 The host constructs `DecompressionStream("brotli")` to detect native support. Otherwise it imports, by URL from beside
 its own script, a separate `brotli-dec-wasm` streaming decoder bundle (`brotli-fallback.js`, 291 KB) with its WASM
 embedded by Rolldown's binary loader. No external decoder WASM fetch is needed, and native installations never load that
-bundle. Both paths feed the bounded C extractor in pieces of at most 64 KiB. Only a failure that starts in the decoder
-is reported as a Brotli error, with the hint about `Content-Encoding: br`; a failure of the body itself (the network, an
+bundle. Both paths feed the tar decoder in pieces of at most 64 KiB. Only a failure that starts in the decoder is
+reported as a Brotli error, with the hint about `Content-Encoding: br`; a failure of the body itself (the network, an
 abort) passes through as it is, and a fallback that fails to load says so.
 
 ### npm package
diff --git a/docs/known-gaps.md b/docs/known-gaps.md
--- a/docs/known-gaps.md
+++ b/docs/known-gaps.md
@@ -152,8 +152,6 @@ decided.
   includes the static data below the heap, and the manifest's `memory` adds it to the runtime minimum and the module's
   `dylink.0` static size, which count that data already. The figure errs large; declaring the heap alone would need the
   break measured from the heap's base.
-- **Link targets of at most 100 bytes.** Data archives are plain ustar, whose link-target field holds 100 bytes, and the
-  installer refuses extended headers, so a closure with a longer symbolic-link target fails its distribution's build.
 - **Connection-time callback audit.** The current cast audit sees explicit casts; it cannot establish every connected
   handler's arity. Hangul needs no lazy arity bridge; Rime still needs its own audit.
 - **Hangul setup.** The `setup` property does not launch an application.
@@ -222,9 +220,10 @@ decided.
 - **WebKit's IndexedDB in Workers** is unchecked (spec R5, R13).
 - **The backend's costs**: every `open()` costs one read-only transaction; the open/unlink race is argued in a comment,
   not tested; a `pwrite()` straddling 2^53 − 1 fails whole with `EFBIG` rather than writing short.
-- **Installing writes partial chunks.** Each read of the archive's response is one write transaction; the 512-byte ustar
-  headers offset the data, so most writes cover a partial chunk at each end and read those chunks first. Buffering the
-  extractor's writes to chunk boundaries would remove the reads; installing is off the request path.
+- **Installing writes in 64 KiB pieces.** Each piece of a file's data is one write transaction at a 64 KiB boundary of
+  the file, which covers the 16 KiB chunks the backend creates whole; in a database created with chunks that don't
+  divide 64 KiB, most writes would cover a chunk in part at each end and read it first. Installing is off the request
+  path.
 - **Test hooks**: the chunk counter doesn't count `getAllKeys()` or cursors, and a `get()` of a hole counts nothing; the
   injected delete fault aborts synchronously, as a body that throws rather than a commit that aborts; the browser
   `install-torn-marker` case writes a non-marker value, since a browser's commit can't tear.
diff --git a/docs/runtime.md b/docs/runtime.md
--- a/docs/runtime.md
+++ b/docs/runtime.md
@@ -163,7 +163,6 @@ All of it is declared in `ibus-web/runtime.h`. Errors are negative errno values,
 | `ibusweb_output_peek(len)`                                             | The buffered whole records, in sequence order; the pointer is valid until the next runtime call, `ibusweb_wait()` included. Pumping thread only.                                                               |
 | `ibusweb_output_consume(len)`                                          | Drops `len` bytes of records from the front; a length not on a record boundary logs a critical and drops nothing. Pumping thread only.                                                                         |
 | `ibusweb_output_last_seq()`                                            | The last appended sequence number, zero before any record.                                                                                                                                                     |
-| `ibusweb_install_begin/set_limit/feed/count/end`                       | A streaming ustar extractor that installs an engine's data through the file system; see [storage.md](storage.md#installing).                                                                                   |
 
 `ibusweb_module_init(IBusWebModule *)` is the entry point every side module defines; the export list's check expects it
 to be defined by side modules, not by the runtime.
@@ -241,11 +240,10 @@ any result but `0` and `-ETIMEDOUT` as a crash.
 failing unless tests ran and none was skipped. `test-runtime` (g_test, TAP) covers init, the pump (empty, always ready,
 off-thread, wake from another thread, deadlines, fd sources), the wait (timeout, a stale `seen`, wake, proxied calls,
 off-thread), module registration, test-dispatch errors and exceptions, and loading side modules (present, missing, not a
-module, no entry point). `test-install` covers the extractor. The suite also covers serialization, key helpers,
-emitters, engine signals and caches (including fresh cursor/capabilities/content values inside non-chaining subclass
-callbacks and ordinary connected handlers), protocol validation, engine creation failures, logs and settings (69 C cases
-in total). The real Hangul side module has its own [golden tests](engines.md#golden-tests). See
-[testing.md](testing.md).
+module, no entry point). The suite also covers serialization, key helpers, emitters, engine signals and caches
+(including fresh cursor/capabilities/content values inside non-chaining subclass callbacks and ordinary connected
+handlers), protocol validation, engine creation failures, logs and settings (63 C cases in total). The real Hangul side
+module has its own [golden tests](engines.md#golden-tests). See [testing.md](testing.md).
 
 ## `ibus-runtime.wasm`
 
@@ -258,18 +256,18 @@ runs beside the released one.
 `em++` links the static libraries (`libibus-web`, `gio-2.0`, `gobject-2.0`, `libffi`, `libwasmfs-idb` and its JavaScript
 library); the export list decides what of them is linked. The flags (`ibusWeb.runtime.linkFlags`):
 
-| Flags                                                                                                | Why                                                                                                                                                                 |
-| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
-| `-sMAIN_MODULE=2 -sWASMFS=1 -sEXIT_RUNTIME=0` (`toolchain.runtimeMainFlags`)                         | A main module with an explicit export list; WasmFS for its backends; the runtime never exits. See [toolchain.md](toolchain.md#dynamic-linking) for dynamic linking. |
-| `-sEXPORTED_FUNCTIONS=@exports.txt`                                                                  | The export list, below.                                                                                                                                             |
-| `-sEXPORTED_RUNTIME_METHODS=HEAPU8,PThread`                                                          | The host copies requests through `HEAPU8` and tops the pool up through `PThread`.                                                                                   |
-| `-sPTHREAD_POOL_SIZE=8+Module["ibuswebEngineThreads"]` (base derived) `-sPTHREAD_POOL_SIZE_STRICT=2` | A pool sized for the planned peak plus spares, the engine's share from its manifest; a thread beyond it fails with `EAGAIN` (Threads, below).                       |
-| `-sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB`                                                  | GRegex overflows Emscripten's 64 KiB default stack, on any thread.                                                                                                  |
-| `-sALLOW_MEMORY_GROWTH=0 -sIMPORTED_MEMORY=1`, `-sINITIAL_MEMORY` 32 MiB, `-sMAXIMUM_MEMORY` 2 GiB   | Fixed memory made by the host, of any size between the two (Memory, below).                                                                                         |
-| `-sABORTING_MALLOC=1`                                                                                | A full heap aborts; the remedy is a larger memory from the host.                                                                                                    |
-| `-sINCOMING_MODULE_JS_API=instantiateWasm,wasmMemory,noExitRuntime,ibuswebEngineThreads`             | The settings the host passes. `noExitRuntime` must be named, or the runtime's thread exits after a callback and retires its pthreads' Workers.                      |
-| `--pre-js=host-memory.js`                                                                            | Refuses to start without `wasmMemory` from the host, rather than make a memory of the least size.                                                                   |
-| `-sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node`                                        | An ES module factory the host imports by URL, in browsers and under Node (for tests).                                                                               |
+| Flags                                                                                                | Why                                                                                                                                                                                                                                                                                                                                           |
+| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
+| `-sMAIN_MODULE=2 -sWASMFS=1 -sEXIT_RUNTIME=0` (`toolchain.runtimeMainFlags`)                         | A main module with an explicit export list; WasmFS for its backends; the runtime never exits. See [toolchain.md](toolchain.md#dynamic-linking) for dynamic linking.                                                                                                                                                                           |
+| `-sEXPORTED_FUNCTIONS=@exports.txt`                                                                  | The export list, below.                                                                                                                                                                                                                                                                                                                       |
+| `-sEXPORTED_RUNTIME_METHODS=HEAPU8,PThread,FS` `-sFORCE_FILESYSTEM=1`                                | The host copies requests through `HEAPU8`, tops the pool up through `PThread`, and installs engine data through WasmFS's JavaScript `FS`, which a link includes whole only with the file system forced. `FS` has no `fsync`; the host calls libc's, on the export list with the rest of libc, and reads its errno through `__errno_location`. |
+| `-sPTHREAD_POOL_SIZE=8+Module["ibuswebEngineThreads"]` (base derived) `-sPTHREAD_POOL_SIZE_STRICT=2` | A pool sized for the planned peak plus spares, the engine's share from its manifest; a thread beyond it fails with `EAGAIN` (Threads, below).                                                                                                                                                                                                 |
+| `-sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB`                                                  | GRegex overflows Emscripten's 64 KiB default stack, on any thread.                                                                                                                                                                                                                                                                            |
+| `-sALLOW_MEMORY_GROWTH=0 -sIMPORTED_MEMORY=1`, `-sINITIAL_MEMORY` 32 MiB, `-sMAXIMUM_MEMORY` 2 GiB   | Fixed memory made by the host, of any size between the two (Memory, below).                                                                                                                                                                                                                                                                   |
+| `-sABORTING_MALLOC=1`                                                                                | A full heap aborts; the remedy is a larger memory from the host.                                                                                                                                                                                                                                                                              |
+| `-sINCOMING_MODULE_JS_API=instantiateWasm,wasmMemory,noExitRuntime,ibuswebEngineThreads`             | The settings the host passes. `noExitRuntime` must be named, or the runtime's thread exits after a callback and retires its pthreads' Workers.                                                                                                                                                                                                |
+| `--pre-js=host-memory.js`                                                                            | Refuses to start without `wasmMemory` from the host, rather than make a memory of the least size.                                                                                                                                                                                                                                             |
+| `-sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node`                                        | An ES module factory the host imports by URL, in browsers and under Node (for tests).                                                                                                                                                                                                                                                         |
 
 The common flags (`-O2 -fPIC -pthread -fwasm-exceptions -mextended-const`) and the minimum browser and Node versions
 come from the toolchain ([toolchain.md](toolchain.md#minimum-browser-and-node-versions)). Of what the minimum versions
diff --git a/docs/storage.md b/docs/storage.md
--- a/docs/storage.md
+++ b/docs/storage.md
@@ -346,37 +346,43 @@ reads a version before its marker exists, so the deletion has no reader to wait
 marker and the next host redoes it; a second host waiting on the lock finds the marker and mounts. The installing host
 keeps its sealed read-write backend rather than mount a third, since a backend's thread lasts as long as the runtime.
 
-**The marker.** Every file was `fsync()`ed by the extractor, so the data has committed; the directory entries made after
+**The marker.** Every file was `fsync()`ed by the installer, so the data has committed; the directory entries made after
 a file's last `fsync()` committed relaxed, and the marker's strict commit makes them durable too, since a strict commit
 that writes makes every earlier change to the database durable. A marker whose value isn't one for this version counts
 as none, so the version is installed again rather than every start failing.
 
-**The extractor.** Archives are Brotli-compressed POSIX ustar, one per store path, its entries named from `/nix/store`
-(`<hash>-<name>/…`, or the bare file for a store path that is one); how they are built is
+**The installer.** Archives are Brotli-compressed pax, POSIX's extension of ustar, one per store path, its entries named
+from `/nix/store` (`<hash>-<name>/…`, or the bare file for a store path that is one); how they are built is
 [engines.md](engines.md#archives-and-serving)'s. The host streams native `DecompressionStream("brotli")` output, where
 construction succeeds, or a `brotli-dec-wasm` fallback with its WASM embedded in a separate decoder script, imported by
-URL only without native support. Plain ustar (`encoding: "identity"`) remains available for fixtures. Serve the archives
+URL only without native support. Plain tar (`encoding: "identity"`) remains available for fixtures. Serve the archives
 without `Content-Encoding: br` to avoid fetch decoding them twice; a decoding failure's message says so, while a failure
-of the response body itself passes through unlabelled. Decompressed bytes are re-cut into at most 64 KiB pieces and
-streamed into `libibus-web`'s `ibusweb_install_begin`, `_set_limit`, `_feed`, `_count` and `_end`, which write through
-the mounted file system, so the stored layout has one writer. The host feeds it through a 64 KiB buffer in the runtime's
-memory. It takes regular files, directories and symbolic links (`SYMTYPE`), a link keeping its target unresolved; a hard
-link (`LNKTYPE`) fails with `EOPNOTSUPP`; devices, FIFOs, extended headers, absolute names, `..`, a link with data or no
-target, a bad checksum, a non-ustar header or an archive that ends early fail with `EINVAL`. Nothing is written through
-a link: a member under one fails with `ENOTDIR`, and a file or link member replaces a link already at its name. Each
-entry takes the archive's mode plus its owner's read and write (and search, for a directory), so a later install can
-redo it; existing files are truncated and rewritten, missing parents made. Each regular file is sized from its header
-before its data is written, so a file in memory is allocated once, and `fsync()`ed once written. Each archive is
-extracted at the root of the data mount; as it streams, the host follows its ustar framing and refuses any entry outside
-the archive's own store path before the extractor sees it, so one archive can't replace another's files. The bounded C
-parser uses standard `tar.h` constants and an explicitly size/offset-checked ustar header layout.
-
-The streaming extractor's optional `ibusweb_install_set_limit(install, bytes)` sets a uint64 regular-file byte budget
-before the first feed. The host always sets it from the manifest, passing a JavaScript `bigint` across the WASM i64
-boundary; older low-level callers of `ibusweb_install_begin` retain an unlimited default. Feed returns `-EFBIG` before
-creating or sizing a member that exceeds the remaining budget. The host checks final count equality before persisting
-the installed marker. Metadata and decompressor buffers are outside this budget. This additive export preserves the
-existing C ABI; the host checks that the runtime provides it before startup continues.
+of the response body itself passes through unlabelled.
+
+Decompressed bytes are re-cut into at most 64 KiB pieces and piped through `modern-tar`'s `createTarDecoder()`, strict,
+and the host's installer (`src/worker/install/`) writes each entry as the decoder gives it, through WasmFS's JavaScript
+`FS` (`mkdir`, `lstat`, `chmod`, `symlink`, `unlink`, `open`, `fchmod`, `ftruncate`, `write`, `close`) and libc's
+`fsync`, which the runtime exports, into the mounted file system, so the stored layout has one writer: the host's
+installer. A file's data goes in as it arrives, in pieces of at most 64 KiB, each a `write()`; neither an archive nor a
+file is ever held whole. The decoder refuses a header whose checksum doesn't match, a lone zero block, an archive that
+ends before its two end-of-archive blocks, mid-header or mid-file, and anything but zeros after them. It applies pax
+extended (`x`) and global (`g`) headers and GNU's long names (`L`, `K`), so a name or link target has no length limit.
+
+The installer takes regular files, directories and symbolic links, a link keeping its target unresolved; a hard link
+fails with `EOPNOTSUPP`; devices, FIFOs, absolute names, `..`, a pax `size` record, a name or target holding a NUL or a
+newline, and a link with no target fail with `EINVAL`. Each archive is extracted at the root of the data mount, and an
+entry outside the archive's own store path is refused before anything of it is written, so one archive can't replace
+another's files. Nothing is written through a link: an entry under one fails with `ENOTDIR`, a file or link replaces a
+link already at its name, a link also replaces a file, and a link or file where there is a directory fails with
+`EISDIR`. Each entry takes the archive's mode plus its owner's read and write (and search, for a directory), new or
+there already, so a later install can redo it; existing directories are kept, existing files truncated and rewritten,
+missing parents made. Each regular file is sized from its header (`ftruncate`) before its data is written, so a file in
+memory is allocated once, and `fsync()`ed once written. A failure reports the entry and the negative errno, as
+`install <url>: "<entry>": -<errno>`, and closes the file it was writing.
+
+The installer refuses, with `EFBIG`, a regular file that would take the bytes written past the manifest's `size` for the
+archive, before creating its parents or the file, and the host requires the bytes written to equal `size` exactly before
+it writes the marker. Metadata and decompressor buffers are outside this budget.
 
 **Waiting and progress.** A host waiting for the data or install lock gives up, failing its start, after 120 s without
 word from the holder. The installer sends progress every second for as long as it holds the install lock, on a
@@ -477,7 +483,7 @@ The runtime's memory is fixed once made ([runtime.md](runtime.md)), so the host
 opens the module's database without creating it and closes it at once. If that fails, the module's directory is WasmFS's
 memory backend, and the host makes the runtime's memory, and its maximum, larger than the manifest's `memory` by the
 data's size: the sum of the manifest's data sizes (unpacked bytes), rounded up to whole 64 KiB pages. That covers the
-files' contents, since the extractor sizes each file before writing it, so the memory backend allocates each file once
+files' contents, since the installer sizes each file before writing it, so the memory backend allocates each file once
 at its size; per-file metadata (WasmFS's file objects and directory entries) comes out of the spare in the manifest's
 base memory. A memory this takes past the runtime's maximum fails the memory check, a load failure. The data is
 installed at every start, with no lock, and the host posts `storage: ephemeral` with the reason IndexedDB couldn't be
@@ -566,9 +572,9 @@ five closed at 14,648 KiB).
 
 ### Installing
 
-The extractor writes each file's data as it arrives, so through pieces of at most 64 KiB, each `write()` one write
-transaction. Since ustar's 512-byte headers offset file data from chunk boundaries, most of those writes cover a chunk
-in part at each end and read it first. Installing is off the request path, so that cost only delays startup.
+The installer writes each file's data as it arrives, a 64 KiB piece at a time from the file's start, each `write()` one
+write transaction. At the 16 KiB chunks the backend creates, each piece covers four chunks whole, so only a file's last
+chunk is written in part. Installing is off the request path, so its cost only delays startup.
 
 ## Not built yet
 
diff --git a/docs/worker-host.md b/docs/worker-host.md
--- a/docs/worker-host.md
+++ b/docs/worker-host.md
@@ -152,7 +152,7 @@ The host fails its start, posting `error`, when:
 - `malloc()` for the wake word or the buffers fails, `ibusweb_runtime_init()` fails, or the runtime refuses
   initialization;
 - storage fails: IndexedDB found but the backend won't open, a lock not granted within the lock limit of the last word
-  from its holder, a fetch error or an archive idle too long, an install the extractor refuses, a deletion blocked past
+  from its holder, a fetch error or an archive idle too long, an install the installer refuses, a deletion blocked past
   its limit, or a manifest with no version.
 
 A failed host lets go of every lock it took, seals first if it can.
@@ -293,9 +293,9 @@ part (`src/worker/storage/`, `src/worker/install/`):
   the user backend is sealed.
 - **Install** (`provide.ts`): the version's data lock, shared, for the host's life; then its install lock, exclusive;
   the marker read; if absent, the version's storage cleared, a read-write mount, the archives streamed in 64 KiB pieces
-  into `ibusweb_install_feed()`, the marker written last, the backend sealed; if present, a read-only mount. The install
-  lock goes as soon as the data is there; the host then collects other versions whose data lock it gets exclusively at
-  once. A memory mount installs at every start with no lock.
+  through the tar decoder and written entry by entry through `FS`, the marker written last, the backend sealed; if
+  present, a read-only mount. The install lock goes as soon as the data is there; the host then collects other versions
+  whose data lock it gets exclusively at once. A memory mount installs at every start with no lock.
 - **Progress**: an installer says it is still going, every `progressIntervalMs` for as long as it holds the install
   lock, from acquiring it to releasing it, on a `BroadcastChannel` named after the install lock. A host waiting for that
   lock gives up only after `lockLimitMs` without word, so a slow install is waited for and a dead one isn't.
@@ -367,16 +367,17 @@ browser-shaped `Worker`. Expected output is asserted and never printed: every li
 (Node: `fs.writeSync` on fds 1 and 2 redirected into a file, since a sleeping host's `process.stderr` never flushes;
 browsers: Workers' console messages), each test takes the lines it expects, and anything else fails it.
 
-| Group                     | Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                       | Where                                                                                                                                   |
-| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
-| One host, in order        | `dispatch`, `cold-wake`, `thread-create-blocked`, `pool-top-up`, `thread-exit-blocked`, `cross-thread-wake`, `deadline`, `sync-proxied`, `exceptions`; `pool-exhausted`                                                                                                                                                                                                                                                         | all; `pool-exhausted` in browsers                                                                                                       |
-| Hosts of their own        | `thread-crash`, `heap-full`, `mem-stress`, `glib-stress`                                                                                                                                                                                                                                                                                                                                                                        | all; `heap-full` under Node                                                                                                             |
-| The host                  | fails to start when instantiation fails; refuses a memory the runtime can't take; reports a failing relay as a crash; logs a top-up that doesn't finish in time and tops up no more                                                                                                                                                                                                                                             | all                                                                                                                                     |
-| Storage                   | `storage-roundtrip`, `promise-proxied-fsync`, `storage-costs` (correctness only), `storage-fallback`, `storage-closed`, `writer-lock`; lock release on a crash with the runtime intact, a seal that throws, a trap, a failed start                                                                                                                                                                                              | all; `storage-closed` and the throwing seal in browsers                                                                                 |
-| Engine data               | `install-fresh`, `install-skip`, `install-concurrent`, `install-interrupted`, `install-interrupted-queued`, `install-interrupted-stray`, `install-torn-marker`, `upgrade-while-running`, `interrupted-upgrade-then-old`, `stale-file`, `failed-start-releases-locks`, `data-read-only`; a blocked deletion; a stray `<V>.marking`; a lock wait that outlives its limit while progress arrives, and one that fails when it stops | all; `install-concurrent` and the blocked deletion in browsers, the stray marking under Node; `data-read-only` only recorded under Node |
-| The host as released      | `dispatch`, `thread-crash`, `relay-failure`, and that it ignores `HostInit.test`, on the shipped `dist/worker/` files (served raw in browsers, as a page would serve them)                                                                                                                                                                                                                                                      | all                                                                                                                                     |
-| Units                     | `Held`'s release rules; the storage names' encoding                                                                                                                                                                                                                                                                                                                                                                             | Node                                                                                                                                    |
-| Layers (`@effect/vitest`) | `HostConfig`'s defaults and overrides; `runtimeFinalizer` after a normal close, an intact failure, and each kind of throw; the Worker scope's reports (failed start, crash with `CRASHED` written, the thread's error after `"unwind"`, one that never arrives, a foreign uncaught error left alone, log records, defects)                                                                                                      | browsers                                                                                                                                |
+| Group                     | Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Where                                                                                                                                   |
+| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
+| One host, in order        | `dispatch`, `cold-wake`, `thread-create-blocked`, `pool-top-up`, `thread-exit-blocked`, `cross-thread-wake`, `deadline`, `sync-proxied`, `exceptions`; `pool-exhausted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | all; `pool-exhausted` in browsers                                                                                                       |
+| Hosts of their own        | `thread-crash`, `heap-full`, `mem-stress`, `glib-stress`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | all; `heap-full` under Node                                                                                                             |
+| The host                  | fails to start when instantiation fails; refuses a memory the runtime can't take; reports a failing relay as a crash; logs a top-up that doesn't finish in time and tops up no more                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | all                                                                                                                                     |
+| Storage                   | `storage-roundtrip`, `promise-proxied-fsync`, `storage-costs` (correctness only), `storage-fallback`, `storage-closed`, `writer-lock`; lock release on a crash with the runtime intact, a seal that throws, a trap, a failed start                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | all; `storage-closed` and the throwing seal in browsers                                                                                 |
+| Engine data               | `install-fresh`, `install-skip`, `install-concurrent`, `install-interrupted`, `install-interrupted-queued`, `install-interrupted-stray`, `install-torn-marker`, `upgrade-while-running`, `interrupted-upgrade-then-old`, `stale-file`, `failed-start-releases-locks`, `data-read-only`; a blocked deletion; a stray `<V>.marking`; a lock wait that outlives its limit while progress arrives, and one that fails when it stops                                                                                                                                                                                                                                                                     | all; `install-concurrent` and the blocked deletion in browsers, the stray marking under Node; `data-read-only` only recorded under Node |
+| The installer             | on a memory mount of its own, through `HostOp.install` and `HostOp.fs`: the test tree whole in pieces of 7 bytes to 1 MiB, its counts, and over a half-written tree, and an archive of pax headers byte by byte; refused archives (absolute, `..`, outside the store path, hard link, FIFO); malformed ones (a broken checksum, cut short mid-header, mid-file, between members and before the end-of-archive blocks, a lone zero block, trailing bytes, a signed checksum); the size limit; modes; symbolic links; a name and a link target longer than ustar's; never writing through a link; its directory; a 16 MiB file in its own size; each `FS` call it makes, failing, giving libc's errno |
+| The host as released      | `dispatch`, `thread-crash`, `relay-failure`, and that it ignores `HostInit.test`, on the shipped `dist/worker/` files (served raw in browsers, as a page would serve them)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | all                                                                                                                                     |
+| Units                     | `Held`'s release rules; the storage names' encoding; what `modern-tar`'s strict decoder refuses and takes; the installer's checks of each entry, its 64 KiB writes, and closing a file after an errno but not after a trap                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Node                                                                                                                                    |
+| Layers (`@effect/vitest`) | `HostConfig`'s defaults and overrides; `runtimeFinalizer` after a normal close, an intact failure, and each kind of throw; the Worker scope's reports (failed start, crash with `CRASHED` written, the thread's error after `"unwind"`, one that never arrives, a foreign uncaught error left alone, log records, defects)                                                                                                                                                                                                                                                                                                                                                                          | browsers                                                                                                                                |
 
 Each scenario's criterion is its assertion: every sum right in `dispatch`; in `cold-wake` spaced requests finding the
 host asleep; `cross-thread-wake` every source dispatched, never before its attach and within 500 ms of it, with
```

```bash
nix develop -c oxfmt docs/engines.md docs/storage.md docs/runtime.md docs/worker-host.md docs/known-gaps.md
nix develop -c hk check -S links
```

Expected: the link check passes.

- [ ] **Step 11: Commit**

```bash
nix develop -c git add modules runtime packages/worker-host packages/ibus-web/README.md pnpm-lock.yaml docs
nix develop -c git commit -m "feat(worker-host): install engine data as pax through modern-tar, writing through WasmFS's FS" -- modules/flake/lib.nix modules/engines/manifest.nix modules/engines/options.nix modules/typescript/workspace.nix pnpm-lock.yaml runtime/ibus-runtime runtime/libibus-web packages/worker-host packages/ibus-web/README.md docs/engines.md docs/storage.md docs/runtime.md docs/worker-host.md docs/known-gaps.md
```

---

### Task 2: WasmFS finds what another Worker created after a lookup missed it

Everything later relies on this: a host that mounted a version, and looked for one of an engine's files before another host installed it, must find it once installed. WasmFS's directory cache holds found entries only (`getChild()` in the patched Emscripten's `system/lib/wasmfs/file.cpp` caches a child only when the backend returned one, and `getEntries()` asks the backend each time). This task pins that down as a test of the backend: two backends over one database are two connections on two backend threads, as two hosts' are.

**Files:**
- Create: `runtime/wasmfs-idb/tests/visibility.cpp`
- Modify: `runtime/wasmfs-idb/checks.nix`
- Docs: `docs/storage.md`

**Interfaces:**
- Consumes: `idb_test::IdbTest`, `wasmfs_create_idb_backend`, `WASMFS_IDB_READ_ONLY`.
- Produces: the `visibility` program in `checks.wasmfs-idb-browser`.

- [ ] **Step 1: Write the test**

Create `runtime/wasmfs-idb/tests/visibility.cpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What another backend over the same database creates, as another Worker's
// would, a backend that looked for it first and found nothing then finds:
// WasmFS keeps the entries a lookup found, never an entry's absence, and
// lists a directory from the database each time.

#include <dirent.h>

#include "idb-test.h"

using idb_test::errno_text;
using idb_test::read_file;
using idb_test::write_file;

namespace {

// The fixture's backend writes, as the host installing a store path would;
// a second, created read-only and mounted beside it, reads, as a host that
// mounted the version earlier would.
class Visibility : public idb_test::IdbTest {
protected:
  void SetUp() override {
    ASSERT_NO_FATAL_FAILURE(IdbTest::SetUp());
    reader_path = mount_path + "-reader";
    reader = wasmfs_create_idb_backend(database.c_str(), WASMFS_IDB_READ_ONLY);
    ASSERT_NE(reader, nullptr);
    ASSERT_EQ(wasmfs_create_directory(reader_path.c_str(), 0777, reader), 0);
  }

  std::string read(std::string_view name) const {
    return reader_path + "/" + std::string(name);
  }

  // The names a directory lists, but "." and "..".
  static std::vector<std::string> listed(const std::string &dir) {
    std::vector<std::string> names;
    DIR *stream = opendir(dir.c_str());
    EXPECT_NE(stream, nullptr) << dir << ": " << errno_text();
    if (stream == nullptr) {
      return names;
    }
    while (const dirent *entry = readdir(stream)) {
      const std::string name = entry->d_name;
      if (name != "." && name != "..") {
        names.push_back(name);
      }
    }
    EXPECT_EQ(closedir(stream), 0) << errno_text();
    std::sort(names.begin(), names.end());
    return names;
  }

  std::string reader_path;
  backend_t reader = nullptr;
};

} // namespace

TEST_F(Visibility, ATreeCreatedAfterAMissIsFound) {
  struct stat st;
  EXPECT_ERRNO(stat(read("store").c_str(), &st), ENOENT);
  EXPECT_ERRNO(stat(read("store/file").c_str(), &st), ENOENT);
  ASSERT_EQ(mkdir(path("store").c_str(), 0755), 0) << errno_text();
  ASSERT_NO_FATAL_FAILURE(write_file(path("store/file"), 0644, "data"));
  EXPECT_EQ(read_file(read("store/file")), "data");
}

TEST_F(Visibility, AFileCreatedInAKnownDirectoryAfterAMissIsFound) {
  ASSERT_EQ(mkdir(path("store").c_str(), 0755), 0) << errno_text();
  EXPECT_EQ(listed(read("store")), std::vector<std::string>{});
  struct stat st;
  EXPECT_ERRNO(stat(read("store/file").c_str(), &st), ENOENT);
  ASSERT_NO_FATAL_FAILURE(write_file(path("store/file"), 0644, "data"));
  EXPECT_EQ(listed(read("store")), std::vector<std::string>{"file"});
  EXPECT_EQ(read_file(read("store/file")), "data");
}
```

In `runtime/wasmfs-idb/checks.nix`, in `checks.wasmfs-idb-browser`'s `programs`, after the `seal` entry, add:

```nix
          # The fixture's backend and a reader beside it, for each of two
          # cases.
          {
            name = "visibility";
            backends = 4;
          }
```

- [ ] **Step 2: Run it**

```bash
nix develop -c git add runtime/wasmfs-idb/tests/visibility.cpp runtime/wasmfs-idb/checks.nix
nix build .#checks.x86_64-linux.wasmfs-idb-browser -L
```

Expected: PASS, the two `Visibility` cases and `run` in Chromium and Firefox among the rest. This is a test of behaviour the backend already has, and it passes without a code change; a failure here means WasmFS caches an absence after all, and the design's "Other Workers" rule needs rethinking before anything else in this plan.

- [ ] **Step 3: Document it**

In `docs/storage.md`, section "How it plugs into WasmFS", replace the end of the **State.** bullet,

```markdown
  stored mode and times in place of the ones WasmFS makes up. WasmFS keeps file identity in its own cache
  (`maintainsFileIdentity()` stays false).
```

with

```markdown
  stored mode and times in place of the ones WasmFS makes up. WasmFS keeps file identity in its own cache
  (`maintainsFileIdentity()` stays false). That cache holds the entries lookups found, never an entry's absence, and a
  directory's listing is read from the database each time, so a file another connection creates after a lookup missed
  it is found by the next.
```

and in section "Tests", replace `` `sweep.1`/`sweep.2` and `seal`. `` with

```markdown
`sweep.1`/`sweep.2`, `seal` and `visibility` (a file another backend creates after this one's lookup missed it, found and listed).
```

Then:

```bash
nix develop -c oxfmt docs/storage.md
nix develop -c hk check -S links
```

Expected: oxfmt rewraps the paragraph; the link check passes.

- [ ] **Step 4: Commit**

```bash
nix develop -c git add runtime/wasmfs-idb/tests/visibility.cpp runtime/wasmfs-idb/checks.nix docs/storage.md
nix develop -c git commit -m "test(wasmfs-idb): a file another backend creates after a missed lookup is found" -- runtime/wasmfs-idb/tests/visibility.cpp runtime/wasmfs-idb/checks.nix docs/storage.md
```

---

### Task 3: The backend's window for changes

**Files:**
- Modify: `runtime/wasmfs-idb/include/ibus-web/wasmfs-idb.h`, `runtime/wasmfs-idb/src/idb_backend.cpp`, `runtime/wasmfs-idb/checks.nix`
- Create: `runtime/wasmfs-idb/tests/writable.cpp`
- Docs: `docs/storage.md`

**Interfaces:**
- Consumes: `IdbBackend`'s `readOnly` flag, which every change already checks; `strict_commits_of` from `tests/strict-commits.h`.
- Produces: `int wasmfs_idb_backend_set_writable(backend_t backend, bool writable)`, exported by the runtime through the `wasmfs-idb` section of its export list (generated from the header).

- [ ] **Step 1: Write the failing test**

Create `runtime/wasmfs-idb/tests/writable.cpp`:

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A backend's window: shut, it refuses every change, even through a
// descriptor opened while it was open, and leaves the database as it was;
// open, it takes changes, on a backend created read-only too, whose fsync()
// then makes them durable; a sealed backend's never opens again.

#include "idb-test.h"
#include "strict-commits.h"

using idb_test::errno_text;
using idb_test::read_file;
using idb_test::write_file;

namespace {

// What fsync() makes once the backend has taken a change: one strict
// commit, over a file's stores, writing.
constexpr StrictCommits kBarrier{1, 1, 1};

// Files written while the window is open, a descriptor left open for
// writing, and then the window shut.
class Writable : public idb_test::IdbTest {
protected:
  void SetUp() override {
    ASSERT_NO_FATAL_FAILURE(IdbTest::SetUp());
    writer = open(path("file").c_str(), O_CREAT | O_EXCL | O_RDWR, 0644);
    ASSERT_GE(writer, 0) << errno_text();
    ASSERT_EQ(write(writer, "written", 7), 7) << errno_text();
    ASSERT_EQ(mkdir(path("dir").c_str(), 0755), 0) << errno_text();
    ASSERT_EQ(mkdir(path("empty").c_str(), 0755), 0) << errno_text();
    ASSERT_NO_FATAL_FAILURE(write_file(path("dir/inner"), 0644, "inner"));
    ASSERT_EQ(fsync(writer), 0) << errno_text();
    auto written = idb_test::read_layout(database);
    ASSERT_TRUE(written);
    before = *written;
    ASSERT_EQ(wasmfs_idb_backend_set_writable(backend, false), 0);
  }

  void TearDown() override {
    if (writer >= 0) {
      EXPECT_EQ(close(writer), 0) << errno_text();
    }
    IdbTest::TearDown();
  }

  void refuse_through_writer() {
    EXPECT_ERRNO(write(writer, "more", 4), EROFS);
    EXPECT_ERRNO(ftruncate(writer, 0), EROFS);
    EXPECT_ERRNO(fchmod(writer, 0600), EROFS);
  }

  void refuse_new_changes(const std::string &root) {
    EXPECT_ERRNO(open((root + "/file").c_str(), O_WRONLY), EROFS);
    EXPECT_ERRNO(open((root + "/new").c_str(), O_CREAT | O_WRONLY, 0644),
                 EROFS);
    EXPECT_ERRNO(mkdir((root + "/newdir").c_str(), 0755), EROFS);
    EXPECT_ERRNO(mkdir((root + "/dir/newdir").c_str(), 0755), EROFS);
    EXPECT_ERRNO(unlink((root + "/file").c_str()), EROFS);
    EXPECT_ERRNO(rmdir((root + "/empty").c_str()), EROFS);
    EXPECT_ERRNO(rename((root + "/file").c_str(), (root + "/renamed").c_str()),
                 EROFS);
    EXPECT_ERRNO(chmod((root + "/dir").c_str(), 0700), EROFS);
    EXPECT_ERRNO(utimensat(AT_FDCWD, (root + "/file").c_str(), NULL, 0), EROFS);
    EXPECT_ERRNO(symlink("file", (root + "/link").c_str()), EROFS);
  }

  // A second backend over the same database, created read-only, mounted
  // beside the first.
  std::string mount_read_only(backend_t *out) {
    const std::string root = mount_path + "-ro";
    *out = wasmfs_create_idb_backend(database.c_str(), WASMFS_IDB_READ_ONLY);
    EXPECT_NE(*out, nullptr);
    if (*out != nullptr) {
      EXPECT_EQ(wasmfs_create_directory(root.c_str(), 0777, *out), 0);
    }
    return root;
  }

  int writer = -1;
  // What the database held as the window shut.
  idb_test::Layout before{};
};

} // namespace

TEST_F(Writable, ShutRefusesWritesThroughADescriptorOpenedBefore) {
  refuse_through_writer();
}

TEST_F(Writable, ShutRefusesEveryNewChange) { refuse_new_changes(mount_path); }

TEST_F(Writable, ShutStillReads) {
  EXPECT_EQ(read_file(path("file")), "written");
  EXPECT_EQ(read_file(path("dir/inner")), "inner");
}

TEST_F(Writable, RefusedChangesLeaveTheDatabaseAsItWas) {
  refuse_through_writer();
  EXPECT_EQ(fsync(writer), 0) << errno_text();
  refuse_new_changes(mount_path);
  auto after = idb_test::read_layout(database);
  ASSERT_TRUE(after);
  EXPECT_EQ(after->digest, before.digest);
}

TEST_F(Writable, OpenedAgainTakesChanges) {
  ASSERT_EQ(wasmfs_idb_backend_set_writable(backend, true), 0);
  EXPECT_EQ(pwrite(writer, "W", 1, 0), 1) << errno_text();
  ASSERT_NO_FATAL_FAILURE(write_file(path("dir/later"), 0644, "later"));
  EXPECT_EQ(mkdir(path("newdir").c_str(), 0755), 0) << errno_text();
  EXPECT_EQ(read_file(path("file")), "Written");
  EXPECT_EQ(read_file(path("dir/later")), "later");
}

TEST_F(Writable, ReadOnlyBackendTakesChangesWhileOpen) {
  backend_t read_only = nullptr;
  const std::string root = mount_read_only(&read_only);
  ASSERT_NE(read_only, nullptr);
  refuse_new_changes(root);
  ASSERT_EQ(wasmfs_idb_backend_set_writable(read_only, true), 0);
  ASSERT_NO_FATAL_FAILURE(write_file(root + "/dir/installed", 0644, "data"));
  EXPECT_EQ(read_file(path("dir/installed")), "data");
  ASSERT_EQ(wasmfs_idb_backend_set_writable(read_only, false), 0);
  EXPECT_ERRNO(unlink((root + "/dir/installed").c_str()), EROFS);
}

// The window has let the backend change the database, so fsync() has
// something to make durable, though the backend was created read-only.
TEST_F(Writable, FsyncCommitsOnceTheWindowHasOpened) {
  backend_t read_only = nullptr;
  const std::string root = mount_read_only(&read_only);
  ASSERT_NE(read_only, nullptr);
  ASSERT_EQ(wasmfs_idb_backend_set_writable(read_only, true), 0);
  const int fd =
      open((root + "/synced").c_str(), O_CREAT | O_EXCL | O_RDWR, 0644);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(write(fd, "data", 4), 4) << errno_text();
  ASSERT_EQ(wasmfs_idb_backend_set_writable(read_only, false), 0);
  int result = -1;
  EXPECT_EQ(strict_commits_of([&] { result = fsync(fd); }), kBarrier);
  EXPECT_EQ(result, 0) << errno_text();
  EXPECT_EQ(close(fd), 0) << errno_text();
}

TEST_F(Writable, SealedStaysShut) {
  wasmfs_idb_backend_seal(backend);
  EXPECT_EQ(wasmfs_idb_backend_set_writable(backend, true), -EROFS);
  refuse_through_writer();
  refuse_new_changes(mount_path);
}
```

In `runtime/wasmfs-idb/checks.nix`, after the `visibility` entry Task 2 added, add:

```nix
          # The fixture's backend for each of seven cases, and a read-only
          # one beside it in two.
          {
            name = "writable";
            backends = 9;
          }
```

- [ ] **Step 2: Run it to see it fail**

```bash
nix develop -c git add runtime/wasmfs-idb/tests/writable.cpp runtime/wasmfs-idb/checks.nix
nix build .#checks.x86_64-linux.wasmfs-idb-browser -L
```

Expected: FAIL, building `ibus-web-wasmfs-idb-test-writable`: `use of undeclared identifier 'wasmfs_idb_backend_set_writable'`.

- [ ] **Step 3: Add the window**

In `runtime/wasmfs-idb/include/ibus-web/wasmfs-idb.h`, add `#include <stdbool.h>` between `#include <emscripten/wasmfs.h>` and `#include <stdint.h>`; replace

```c
/* The backend refuses every change with EROFS. */
#define WASMFS_IDB_READ_ONLY 0x1u
```

with

```c
/* The backend refuses every change with EROFS until its window is opened
 * (wasmfs_idb_backend_set_writable), and doesn't sweep the database. */
#define WASMFS_IDB_READ_ONLY 0x1u
```

and after the declaration of `wasmfs_idb_backend_seal`, add:

```c

/* Opens or shuts `backend`'s window for changes. While it is shut every
 * change fails with EROFS, as through a sealed backend, descriptors already
 * open for writing included; while it is open the backend takes changes. It
 * starts open, or shut for a backend created with WASMFS_IDB_READ_ONLY,
 * which also never swept the database, so a window opened on one is for a
 * writer the caller has made the database's only one. Returns 0, or
 * -EROFS for opening a sealed backend's, which stays shut for good. A
 * change another thread has already started as the window shuts may still
 * complete, so shut it once no other thread is writing. */
int wasmfs_idb_backend_set_writable(backend_t backend, bool writable);
```

In `runtime/wasmfs-idb/src/idb_backend.cpp`, add `#include <mutex>` between `#include <memory>` and `#include <string>`. In `class IdbBackend`, replace

```cpp
  // Set from the start, or by sealing; read on every caller's thread.
  std::atomic<bool> readOnly;
  // Read-only from the start, so nothing it wrote needs making durable.
  const bool openedReadOnly;
```

with

```cpp
  // Set from the start, by sealing, or while the window is shut; read on
  // every caller's thread.
  std::atomic<bool> readOnly;
  // Whether the backend has ever taken changes, and so may hold some that
  // fsync() has to make durable.
  std::atomic<bool> everWritable;
  // Sealing is for good, so a seal and an opening window take this lock, and
  // a window never opens on a sealed backend.
  std::mutex access;
  bool sealed = false;
```

and its constructor

```cpp
  explicit IdbBackend(bool readOnly)
      : readOnly(readOnly), openedReadOnly(readOnly) {}
```

with

```cpp
  explicit IdbBackend(bool readOnly)
      : readOnly(readOnly), everWritable(!readOnly) {}
```

In `class IdbFile`, replace

```cpp
  // A backend read-only from the start has written nothing to make durable;
  // a sealed one may have.
  int flush() override {
    if (backend.openedReadOnly) {
      return 0;
    }
```

with

```cpp
  // A backend that has never taken changes has written nothing to make
  // durable; a sealed one, or one whose window is shut, may have.
  int flush() override {
    if (!backend.everWritable) {
      return 0;
    }
```

and replace `wasmfs_idb_backend_seal` with:

```cpp
void wasmfs_idb_backend_seal(backend_t backend) {
  auto *idb =
      static_cast<IdbBackend *>(reinterpret_cast<wasmfs::Backend *>(backend));
  std::lock_guard lock(idb->access);
  idb->sealed = true;
  idb->readOnly.store(true);
}

int wasmfs_idb_backend_set_writable(backend_t backend, bool writable) {
  auto *idb =
      static_cast<IdbBackend *>(reinterpret_cast<wasmfs::Backend *>(backend));
  std::lock_guard lock(idb->access);
  if (!writable) {
    idb->readOnly.store(true);
    return 0;
  }
  if (idb->sealed) {
    return -EROFS;
  }
  idb->everWritable.store(true);
  idb->readOnly.store(false);
  return 0;
}
```

Nothing changes in `src/libwasmfs_idb.js`: there the read-only flag decides only whether the open sweeps.

- [ ] **Step 4: Run it to see it pass, and the export list**

```bash
nix build .#checks.x86_64-linux.wasmfs-idb-browser .#checks.x86_64-linux.ibus-runtime-exports .#checks.x86_64-linux.wasmfs-idb-types -L
```

Expected: PASS. In `wasmfs-idb-browser`, every program passes in Chromium and Firefox (196 cases in the spike), `writable`'s eight among them, and `fsync`'s `ReadOnlyBackendHasNothingToSync` still sees no strict commit; `ibus-runtime-exports` finds `wasmfs_idb_backend_set_writable` exported exactly as the header declares it.

- [ ] **Step 5: Document it**

In `docs/storage.md`, section "C API", replace the `WASMFS_IDB_READ_ONLY` bullet with

```markdown
- `WASMFS_IDB_READ_ONLY` (`0x1`): the backend starts with its window shut (below), so every change fails with `EROFS`,
  and it doesn't sweep (below).
```

and add before the `wasmfs_idb_backend_closed` bullet:

```markdown
- `wasmfs_idb_backend_set_writable(backend, writable)` opens or shuts the backend's window for changes. While it is
  shut every change fails with `EROFS`, as through a sealed backend, descriptors already open for writing included; while
  it is open the backend takes changes. A backend starts with it open, or shut if created with `WASMFS_IDB_READ_ONLY`.
  Opening a sealed backend's fails with `-EROFS`: a seal is for good. A backend that has ever been open commits on
  `fsync()`. The window makes no backend the database's only writer; the caller coordinates writers.
```

In section "`fsync()`", replace

```markdown
- A backend created read-only commits nothing on `fsync()`; it has written nothing. A sealed backend still commits,
  since it may have written before the seal.
```

with

```markdown
- A backend whose window has never been open commits nothing on `fsync()`; it has written nothing. A sealed backend, or
  one whose window has shut, still commits, since it may have written before.
```

In section "Errors", in the table, replace the cause `` `ReadOnlyError`, the read-only flag, a seal `` with `` `ReadOnlyError`, a shut window, a seal ``. In section "Tests", in the sentence listing the programs (Task 2 left it ending `` `seal` and `visibility` (…). ``, wrapped as oxfmt wraps it), insert after `` `seal`, `` and before `` and `visibility` ``:

```markdown
, `writable` (a shut window refusing every change, through a descriptor opened while it was open too, and leaving the
database as it was; an open one taking changes, on a backend created read-only as well, whose `fsync()` then commits; a
sealed backend's never opening)
```

Then:

```bash
nix develop -c oxfmt docs/storage.md
nix develop -c hk check -S links
```

- [ ] **Step 6: Commit**

```bash
nix develop -c git add runtime/wasmfs-idb docs/storage.md
nix develop -c git commit -m "feat(wasmfs-idb): a window for changes beside the seal" -- runtime/wasmfs-idb/include/ibus-web/wasmfs-idb.h runtime/wasmfs-idb/src/idb_backend.cpp runtime/wasmfs-idb/tests/writable.cpp runtime/wasmfs-idb/checks.nix docs/storage.md
```

---

### Task 4: An engine's own data in its descriptor

**Files:**
- Modify: `packages/protocol/src/manifest.ts`, `packages/protocol/src/index.ts`, `packages/protocol/test/engine/manifest.test.ts`
- Docs: `docs/engines.md`

**Interfaces:**
- Consumes: the manifest schema's `storePath` and its whole-manifest filter.
- Produces: `EngineDescriptor.data?: readonly string[]`; `lazyStorePaths(manifest: { readonly engines: readonly EngineDescriptor[] }): ReadonlySet<string>`, exported from `@ibus-web/protocol`; the decoding failures `engine <name> names a data store path twice`, `engine <name>'s data <path> is not in the module's data` and `schema directory is in <path>, which installs only with an engine`.

- [ ] **Step 1: Write the failing tests**

In `packages/protocol/test/engine/manifest.test.ts`, change the import to

```ts
import { decodeModuleManifest, lazyStorePaths } from "../../src/manifest.ts";
```

and append:

```ts
describe("an engine's own data", () => {
  const dictionary = "/nix/store/1123456789abcdfghijklmnpqrsvwxyz-dictionary";
  const withDictionary = {
    ...valid,
    data: [...valid.data, { storePath: dictionary, url: "./data/dictionary.tar.br", size: 8192, encoding: "br" }],
    engines: [
      { ...engine, data: [dictionary] },
      { ...engine, name: "romaja" },
    ],
  };

  test("decodes an engine's data, and an engine without it", () =>
    expect(decodeModuleManifest(withDictionary, bounds)).toEqual(withDictionary));
  test("lists the store paths engines name as lazy, and nothing else", () => {
    expect([...lazyStorePaths(decodeModuleManifest(withDictionary, bounds))]).toEqual([dictionary]);
    expect([...lazyStorePaths(decodeModuleManifest(valid, bounds))]).toEqual([]);
  });
  test("takes a path several engines name once", () =>
    expect([
      ...lazyStorePaths(
        decodeModuleManifest(
          {
            ...withDictionary,
            engines: [
              { ...engine, data: [dictionary] },
              { ...engine, name: "romaja", data: [dictionary] },
            ],
          },
          bounds,
        ),
      ),
    ]).toEqual([dictionary]));
  test("rejects a path not in the module's data", () =>
    expect(() =>
      decodeModuleManifest({ ...withDictionary, engines: [{ ...engine, data: [`${dictionary}-other`] }] }, bounds),
    ).toThrow(/engine hangul's data \/nix\/store\/\S+-dictionary-other is not in the module's data/));
  test("rejects a path named twice by one engine", () =>
    expect(() =>
      decodeModuleManifest({ ...withDictionary, engines: [{ ...engine, data: [dictionary, dictionary] }] }, bounds),
    ).toThrow(/engine hangul names a data store path twice/));
  test("rejects a path that isn't a store path", () =>
    expect(() =>
      decodeModuleManifest({ ...withDictionary, engines: [{ ...engine, data: ["/usr/share/dictionary"] }] }, bounds),
    ).toThrow());
  test("rejects lazy data holding the schema directory", () =>
    expect(() =>
      decodeModuleManifest({ ...withDictionary, engines: [{ ...engine, data: [storePath] }] }, bounds),
    ).toThrow(/schema directory is in \/nix\/store\/\S+-hangul-data, which installs only with an engine/));
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
nix develop -c git add packages/protocol/test/engine/manifest.test.ts
nix build .#checks.x86_64-linux.protocol-node -L
```

Expected: FAIL: `lazyStorePaths` is not a function, and the decoding cases fail on the excess key `data` in an engine.

- [ ] **Step 3: Add the field and its checks**

In `packages/protocol/src/manifest.ts`, add to `EngineDescriptor`, after `keyboard`:

```ts
  // Store paths of the module's data that this engine needs and the module's start doesn't: installed before the
  // engine is first made.
  data: Schema.optionalKey(Schema.Array(storePath)),
```

After `export type EngineDescriptor = typeof EngineDescriptor.Type;` add:

```ts

// The module's lazy data: every store path some engine names as its own. The rest is base data, installed at start.
export const lazyStorePaths = (manifest: { readonly engines: readonly EngineDescriptor[] }): ReadonlySet<string> =>
  new Set(manifest.engines.flatMap((engine) => engine.data ?? []));
```

In `ModuleManifest`'s filter, replace

```ts
    const paths = manifest.data.map((entry) => entry.storePath);
    if (new Set(paths).size !== paths.length) return "duplicate data store paths";
    const components = manifest.settingsSchemaDir.split("/").slice(1);
    if (components.some((component) => component === "" || component === "." || component === ".."))
      return "schema directory must be a canonical store path";
    return (
```

with

```ts
    const paths = manifest.data.map((entry) => entry.storePath);
    if (new Set(paths).size !== paths.length) return "duplicate data store paths";
    for (const engine of manifest.engines) {
      const own = engine.data ?? [];
      if (new Set(own).size !== own.length) return `engine ${engine.name} names a data store path twice`;
      const outside = own.find((path) => !paths.includes(path));
      if (outside !== undefined) return `engine ${engine.name}'s data ${outside} is not in the module's data`;
    }
    const components = manifest.settingsSchemaDir.split("/").slice(1);
    if (components.some((component) => component === "" || component === "." || component === ".."))
      return "schema directory must be a canonical store path";
    // Init reads the schemas before any engine is made, so they must be installed at start.
    for (const path of lazyStorePaths(manifest))
      if (manifest.settingsSchemaDir.startsWith(`${path}/`))
        return `schema directory is in ${path}, which installs only with an engine`;
    return (
```

In `packages/protocol/src/index.ts`, replace

```ts
export { EngineDescriptor, ModuleManifest, decodeModuleManifest } from "./manifest.ts";
```

with

```ts
export { EngineDescriptor, ModuleManifest, decodeModuleManifest, lazyStorePaths } from "./manifest.ts";
```

- [ ] **Step 4: Run them to see them pass**

```bash
nix build .#checks.x86_64-linux.protocol-node -L
```

Expected: PASS, the seven cases of `an engine's own data` among the rest (422 in the spike).

- [ ] **Step 5: Document it**

In `docs/engines.md`, section "Distribution manifest": in the paragraph on `mkEngineManifest`, replace

```markdown
an attribute set (schema id to its paths) or such a file;
```

with

```markdown
an attribute set (schema id to its paths) or such a file; a descriptor may carry `data`, the store paths of the closure
it alone needs, which the build checks with the rest of the manifest;
```

In the `EngineDescriptor` type, add after `keyboard`:

```ts
  data?: string[]; // store paths of `data` this engine alone needs
```

and in the list of what `decodeModuleManifest` enforces, replace the `settingsSchemaDir` bullet with:

```markdown
- each engine's `data` names store paths of the manifest's `data`, none twice;
- `settingsSchemaDir` is canonical (no empty, `.` or `..` component) and lies inside one of the data's store paths, and
  not inside one an engine names, since `Init` reads the schemas before any engine is made;
```

Then:

```bash
nix develop -c oxfmt docs/engines.md
nix develop -c hk check -S links
```

- [ ] **Step 6: Commit**

```bash
nix develop -c git add packages/protocol docs/engines.md
nix develop -c git commit -m "feat(protocol): an engine's own data in its descriptor" -- packages/protocol/src/manifest.ts packages/protocol/src/index.ts packages/protocol/test/engine/manifest.test.ts docs/engines.md
```

---

### Task 5: The host's data store: a window, and markers per store path

The host mounts each version's data with its window shut and opens it only to install; the base install installs only base data; the store learns to read and write a marker per store path. Nothing installs an engine's own data yet (Task 6).

**Files:**
- Modify: `packages/worker-host/src/shared/naming.ts`, `src/worker/runtime.ts`, `src/worker/instruments.ts`, `src/worker/install/archive.ts`, `src/worker/install/store.ts`, `src/worker/install/provide.ts`
- Modify (tests): `packages/worker-host/test/node/install-lifetime.test.ts`, `test/node/harness.ts`, `test/worker/instruments.ts`, `test/shared/testing.ts`
- Create (tests): `packages/worker-host/test/node/window.test.ts`
- Docs: `docs/storage.md`, `docs/worker-host.md`

**Interfaces:**
- Consumes: `wasmfs_idb_backend_set_writable` (Task 3); `lazyStorePaths` (Task 4).
- Produces: `enginePathMarker(storePath: string): string` (`paths/<storePath>`); `DataStore` with `backend(): number` (window shut), `setWritable(writable: boolean): void`, `pathInstalled(storePath): Promise<PathMarker | null>`, `markPath(storePath, marker): Promise<void>` and `quiet(): Promise<void> | undefined`; `sharedWindow(store, changed?)`, a reference-counted window: `<T>(install: () => Promise<T>) => Promise<T>`; `installArchives(handle, engine, entries, hooks)`; `ArchiveHooks.written?: (bytes: number) => void`, `fetching?: (url: string) => void`, `quiet?: () => Promise<void> | undefined`; `DataEntry`; `outside(what, promise)` exported from `archive.ts`; `Instruments.fetching(url)` and `Instruments.window(open)`, which the test build posts as `{ type: "fetching", url }` and `{ type: "window", open, at }`.

- [ ] **Step 1: Write the failing tests**

The window is shared: installs that overlap open it once and shut it once, so Task 6's concurrent installs of different store paths each write through it. Create `packages/worker-host/test/node/window.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { expect, test } from "vitest";
import { sharedWindow, type DataStore } from "../../src/worker/install/store.ts";
import { RuntimeRefused } from "../../src/worker/runtime.ts";

// A store that records how its window was set, and a window over it.
const recorded = () => {
  const set: boolean[] = [];
  const heard: boolean[] = [];
  const store = { setWritable: (writable: boolean) => set.push(writable) } as unknown as DataStore;
  return { set, heard, window: sharedWindow(store, (open) => heard.push(open)) };
};

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

test("overlapping installs open the window once and shut it after the last ends", async () => {
  const { set, heard, window } = recorded();
  const first = gate();
  const second = gate();
  const installs = [window(() => first.opened), window(() => second.opened)];
  expect(set).toEqual([true]);
  first.open();
  await installs[0];
  expect(set, "one install still running").toEqual([true]);
  second.open();
  await installs[1];
  expect(set).toEqual([true, false]);
  expect(heard).toEqual([true, false]);
});

test("installs one after another open and shut it each time", async () => {
  const { set, window } = recorded();
  await window(async () => {});
  await window(async () => {});
  expect(set).toEqual([true, false, true, false]);
});

test("an install the runtime refused shuts it; one that threw from inside the runtime leaves it alone", async () => {
  const refused = recorded();
  await expect(
    refused.window(async () => {
      throw new RuntimeRefused("refused");
    }),
  ).rejects.toThrow("refused");
  expect(refused.set).toEqual([true, false]);

  const trapped = recorded();
  await expect(
    trapped.window(async () => {
      throw new WebAssembly.RuntimeError("unreachable");
    }),
  ).rejects.toThrow("unreachable");
  expect(trapped.set).toEqual([true]);
});
```

The install's lifetime test holds the install lock through every runtime call of the install; the window adds two. In `packages/worker-host/test/node/install-lifetime.test.ts`, rename the test to

```ts
  it.effect("announces throughout clear, mount, window, fetch and marker, then releases the lock and timer", () =>
```

replace the fake store's

```ts
        backend: () => 1,
        mark: marking.wait,
        seal: active,
```

with

```ts
        backend: () => 1,
        setWritable: active,
        mark: marking.wait,
        pathInstalled: async () => null,
        markPath: async () => {},
        seal: () => {},
```

add `quiet: () => undefined,` after its `closed: () => false,`, and replace

```ts
      expect(activeDuringRuntimeCalls).toEqual([true, true, true]);
```

with

```ts
      // makeDirs, mountAt, and the window opened and shut around the fetch.
      expect(activeDuringRuntimeCalls).toEqual([true, true, true, true]);
```

In `packages/worker-host/test/node/harness.ts`, replace

```ts
    // A version's directory, its marker, or both.
    versions: async (engine) => [
      ...new Set(
        (await readdir(dataPath(engine)).catch(() => [] as string[])).map((name) =>
          name.replace(/\.(installed|marking)$/, ""),
        ),
      ),
    ],
```

with

```ts
    // A version's directory, its markers, or any of them.
    versions: async (engine) => [
      ...new Set(
        (await readdir(dataPath(engine)).catch(() => [] as string[])).map((name) =>
          name.replace(/\.(installed|marking|paths)$/, ""),
        ),
      ),
    ],
```

- [ ] **Step 2: Run it to see it fail**

```bash
nix develop -c git add packages/worker-host/test
nix build .#checks.x86_64-linux.worker-host-node -L
```

Expected: FAIL: `window.test.ts` can't import `sharedWindow`, and `install-lifetime.test.ts` reports `expected [ true, true ] to deeply equal [ true, true, true, true ]`, since nothing opens or shuts a window.

- [ ] **Step 3: Implement the store, the window and the base install**

In `packages/worker-host/src/shared/naming.ts`, after `engineDataDatabase`, add:

```ts

// The key, in the meta store of a version's data, of the marker of a store
// path of an engine's own data, installed after the version's base data.
export const enginePathMarker = (storePath: string): string => `paths/${storePath}`;
```

In `packages/worker-host/src/worker/runtime.ts`, add to `interface Runtime`, after `_wasmfs_idb_backend_seal`:

```ts
  _wasmfs_idb_backend_set_writable(backend: number, writable: number): number;
```

and to `requireRuntime`'s `missing` list, after the `fsync` line:

```ts
    ...(typeof rt._wasmfs_idb_backend_set_writable === "function" ? [] : ["wasmfs_idb_backend_set_writable"]),
```

In `packages/worker-host/src/worker/install/archive.ts`:

- in `ArchiveHooks`, after `beforePiece`, add

  ```ts
    // Hears the bytes of file data the archive has written, after each write.
    readonly written?: (bytes: number) => void;
    // Hears each archive's URL before it is fetched.
    readonly fetching?: (url: string) => void;
    // A promise to wait for before the installer writes, or undefined when it
    // may write at once: a transaction of the host's own still open on the
    // database would hold the write's up, and the write, blocking this
    // thread, would keep that transaction from ever completing.
    readonly quiet?: () => Promise<void> | undefined;
  ```

  and let `ExtractHooks` take them: `export interface ExtractHooks extends Partial<Pick<ArchiveHooks, "beforePiece" | "written" | "quiet">> {`;

- replace

  ```ts
  // Fetching and reading happen outside the runtime, which they leave fit to
  // call.
  const outside = async <T>(what: string, promise: Promise<T>): Promise<T> => {
  ```

  with

  ```ts
  // A store path's archive, as the manifest lists it.
  export type DataEntry = ModuleManifest["data"][number];

  // Work outside the runtime, fetching and reading, or the host's own storage
  // and locks, leaves it fit to call.
  export const outside = async <T>(what: string, promise: Promise<T>): Promise<T> => {
  ```

- before the comment `// Extracts the tar archive streaming from source into dir, an existing`, add

  ```ts
  // Waits until the installer may write, checking again once each wait ends,
  // so the write after it follows with no await between.
  const quieted = async (quiet: ExtractHooks["quiet"]): Promise<void> => {
    let wait: Promise<void> | undefined;
    while ((wait = quiet?.()) !== undefined) await wait;
  };

  ```

- in `extract`, add `await quieted(hooks.quiet);` before each write: before `writer = entryWriter(handle, dir, limit);`, `writer.directory(name, mode);`, `writer.symlink(name, header.linkname ?? "");`, `const file = writer.file(name, mode, header.size);`, `file.write(piece.subarray(0, held));` and `file.end();`; and after `held = 0;` add `hooks.written?.(writer.written.bytes);`;

- in `installArchive`, add `hooks.fetching?.(url);` after `arrived();`, and `await quieted(hooks.quiet);` before `makeDirs(handle, dir);`;

- replace `installArchives` with

  ```ts
  // Installs the archives at the store's root, each at its own store path.
  export const installArchives = async (
    handle: RuntimeHandle,
    engine: ModuleManifest,
    entries: readonly DataEntry[],
    hooks: ArchiveHooks,
  ): Promise<Tally> => {
    const tally: Tally = { fed: 0, files: 0, bytes: 0 };
    const root = engineDataRoot(engine);
    for (const data of entries) {
      const storeName = data.storePath.slice(data.storePath.lastIndexOf("/") + 1);
      await installArchive(handle, data.url, root, storeName, data.encoding, data.size, tally, hooks);
    }
    return tally;
  };
  ```

In `packages/worker-host/src/worker/instruments.ts`, add to `Instruments`, after `brotliDecoder`,

```ts
  // An archive of the engine's data is about to be fetched.
  readonly fetching: (url: string) => void;
  // The data backend's window for changes opened or shut.
  readonly window: (open: boolean) => void;
```

and `fetching: () => {},` and `window: () => {},` after `brotliDecoder: () => {},` in `none`. In `packages/worker-host/test/worker/instruments.ts`, add after the `brotliDecoder` member

```ts
    fetching: (url) => post({ type: "fetching", url }),
    window: (open) => post({ type: "window", open, at: Date.now() }),
```

and in `packages/worker-host/test/shared/testing.ts`, replace `  | { type: "brotli-decoder"; decoder: "native" | "fallback" };` with

```ts
  | { type: "brotli-decoder"; decoder: "native" | "fallback" }
  // An archive of the engine's data is about to be fetched.
  | { type: "fetching"; url: string }
  // The data backend's window opened or shut, at Date.now().
  | { type: "window"; open: boolean; at: number };
```

Replace `packages/worker-host/src/worker/install/store.ts` with (the host's own transactions are counted so that `quiet()` can hold an extraction's writes back until none is open; Task 6's concurrent installs need it):

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Where a mount that outlives the Worker keeps each version's data, apart
// from the engine's own files: an IndexedDB database, or a directory on the
// host, per version. A version's base data is installed into storage
// emptied first, and its marker is written last, so that data with a marker
// is whole and the version's alone. Each store path of an engine's own data
// is installed later into the same storage, with a marker of its own written
// last. The data is read-only to the engine but while an install holds the
// backend's window open, where the backend can refuse changes, as the
// IndexedDB backend can; the Node backend has no read-only mode, so there
// the engine is trusted not to write its data.

import {
  encodeComponent,
  engineDataDatabase,
  engineDataDatabasePrefix,
  enginePathMarker,
} from "../../shared/naming.ts";
import type { ModuleManifest } from "@ibus-web/protocol";
import { nodeFs } from "../node-fs.ts";
import { check, RuntimeRefused, withString, type RuntimeHandle } from "../runtime.ts";
import { openExisting } from "../storage/plan.ts";

// The marker of a version's data installed whole: the regular files and
// bytes of file data its install wrote.
interface Marker {
  version: string;
  files: number;
  bytes: number;
}

// The marker of one store path of an engine's own data, installed whole:
// the regular files and bytes of file data its install wrote. The storage
// is the version's own, so the marker needs no version.
export interface PathMarker {
  files: number;
  bytes: number;
}

// The marker, if value is one for version; anything else counts as none.
const markerOf = (value: unknown, version: string): Marker | null => {
  if (typeof value !== "object" || value === null) return null;
  const { version: marked, files, bytes } = value as Partial<Record<keyof Marker, unknown>>;
  return marked === version && typeof files === "number" && typeof bytes === "number"
    ? { version, files, bytes }
    : null;
};

const pathMarkerOf = (value: unknown): PathMarker | null => {
  if (typeof value !== "object" || value === null) return null;
  const { files, bytes } = value as Partial<Record<keyof PathMarker, unknown>>;
  return typeof files === "number" && typeof bytes === "number" ? { files, bytes } : null;
};

export interface DataStore {
  // This version's marker, or null. It is read before the data is mounted,
  // so that a store about to be emptied has no connection of this host's
  // open.
  installed(): Promise<Marker | null>;
  // Empties this version's storage.
  clear(): Promise<void>;
  // A backend over this version's storage, its window for changes shut, or
  // 0. The Node backend has no read-only mode.
  backend(): number;
  // Opens or shuts the backend's window for changes, where it has one.
  setWritable(writable: boolean): void;
  // Marks this version's base data installed, durably, once the data is.
  mark(marker: Marker): Promise<void>;
  // The marker of a store path of an engine's own data, or null.
  pathInstalled(storePath: string): Promise<PathMarker | null>;
  // Marks the store path installed, durably, once its data is.
  markPath(storePath: string, marker: PathMarker): Promise<void>;
  // Makes the backend refuse every later change for good, where it can.
  readonly seal?: () => void;
  // Every other version whose data is kept, encoded.
  others(): Promise<string[]>;
  remove(version: string): Promise<void>;
  // Whether the backend's connection has closed under it.
  closed(): boolean;
  // While the host has a transaction of its own open on this version's
  // storage, a promise that settles once it has none; otherwise undefined.
  quiet(): Promise<void> | undefined;
}

// Runs installs with the backend's window open: it opens as the first of
// any that overlap starts and shuts as the last ends, so installs of
// different store paths can run at once. An install that threw from inside
// the runtime leaves it unfit to call, so nothing shuts the window after
// one. changed hears each opening and shutting.
export const sharedWindow = (
  store: DataStore,
  changed: (open: boolean) => void = () => {},
): (<T>(install: () => Promise<T>) => Promise<T>) => {
  let running = 0;
  const shut = (): void => {
    store.setWritable(false);
    changed(false);
  };
  return async (install) => {
    if (running++ === 0) {
      store.setWritable(true);
      changed(true);
    }
    try {
      const result = await install();
      if (--running === 0) shut();
      return result;
    } catch (error) {
      if (--running === 0 && error instanceof RuntimeRefused) shut();
      throw error;
    }
  };
};

// Deletes the database, failing if another connection to it stays open
// past limitMs after it was asked to close. Every connection the runtime
// and the host make closes when asked, so only one that doesn't holds a
// deletion up.
export const deleteDatabase = (name: string, limitMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error ?? new Error(`deleting ${name} failed`));
    };
    request.onblocked = () => {
      timer ??= setTimeout(
        () =>
          reject(
            new Error(
              `deleting ${name}: another connection to it stayed open for ${limitMs} ms after it was asked to close`,
            ),
          ),
        limitMs,
      );
    };
  });

// The key of the marker in the database's meta store. The store is the
// backend's, which reads only its own keys.
const MARKER_KEY = "installed";

const idbRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

// Puts value at key in the database's meta store, on a connection of the
// host's own, apart from the backend's. Every file was fsync()ed, so the
// data is committed. The directory entries made after a file's last
// fsync() were committed relaxed; this commit's strict durability flushes
// them too, since a strict commit makes every earlier change to the
// database durable.
const putMeta = async (database: string, key: string, value: unknown): Promise<void> => {
  const db = await openExisting(database);
  if (db === null) throw new Error(`${database} is gone`);
  try {
    const tx = db.transaction("meta", "readwrite", { durability: "strict" });
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error(`marking ${database} aborted`));
    });
    tx.objectStore("meta").put(value, key);
    await committed;
  } finally {
    db.close();
  }
};

// The value at key in the database's meta store, or undefined if there is
// no such database or store.
const getMeta = async (database: string, key: string): Promise<unknown> => {
  const db = await openExisting(database);
  if (db === null) return undefined;
  try {
    if (!db.objectStoreNames.contains("meta")) return undefined;
    return await idbRequest(db.transaction("meta", "readonly").objectStore("meta").get(key));
  } finally {
    db.close();
  }
};

export const idbStore = (
  handle: RuntimeHandle,
  engine: ModuleManifest,
  readOnlyFlag: number,
  deleteLimitMs: number,
): DataStore => {
  const { rt } = handle;
  const database = engineDataDatabase(engine);
  const prefix = engineDataDatabasePrefix(engine);
  let backend = 0;
  // The host's own connections open on the database, and who waits for
  // there to be none.
  let open = 0;
  let quieted: Promise<void> | undefined;
  let quiet: (() => void) | undefined;
  const tracked = async <T>(work: () => Promise<T>): Promise<T> => {
    if (open++ === 0) quieted = new Promise((resolve) => (quiet = resolve));
    try {
      return await work();
    } finally {
      if (--open === 0) {
        quieted = undefined;
        quiet?.();
      }
    }
  };
  return {
    installed: async () => markerOf(await getMeta(database, MARKER_KEY), engine.version),
    clear: () => deleteDatabase(database, deleteLimitMs),
    // Created read-only, the backend neither sweeps the database, which
    // hosts installing other store paths write, nor takes a change until an
    // install opens its window.
    backend() {
      backend = withString(handle, database, (ptr) => rt._wasmfs_create_idb_backend(ptr, readOnlyFlag));
      return backend;
    },
    setWritable: (writable) =>
      check(
        `${writable ? "opening" : "shutting"} ${database}'s window`,
        rt._wasmfs_idb_backend_set_writable(backend, writable ? 1 : 0),
      ),
    mark: (marker) => tracked(() => putMeta(database, MARKER_KEY, marker)),
    pathInstalled: async (storePath) =>
      pathMarkerOf(await tracked(() => getMeta(database, enginePathMarker(storePath)))),
    markPath: (storePath, marker) => tracked(() => putMeta(database, enginePathMarker(storePath), marker)),
    seal: () => {
      if (backend !== 0) rt._wasmfs_idb_backend_seal(backend);
    },
    async others() {
      return (await indexedDB.databases())
        .map(({ name }) => name ?? "")
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length))
        .filter((version) => version !== "" && !version.includes("/") && `${prefix}${version}` !== database);
    },
    remove: (version) => deleteDatabase(`${prefix}${version}`, deleteLimitMs),
    closed: () => backend !== 0 && rt._wasmfs_idb_backend_closed(backend) !== 0,
    quiet: () => quieted,
  };
};

// Each version's data is a directory under data/ beside the engine's own
// files; its marker is a file beside that directory, outside the tree the
// engine sees, written whole as <version>.marking, then renamed over
// <version>.installed. The markers of the store paths of engines' own data
// are files in <version>.paths/ beside it, each named for its store path,
// written the same way.
const MARKER = ".installed";
const PENDING = ".marking";
const PATHS = ".paths";

// Writes value as JSON to path whole or not at all: to pending, synced,
// renamed over path, and the directory synced after where the platform
// allows it, which makes the rename durable.
const writeWhole = async (
  fs: Awaited<ReturnType<typeof nodeFs>>,
  dir: string,
  pending: string,
  path: string,
  value: unknown,
): Promise<void> => {
  const file = await fs.open(pending, "w");
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await fs.rename(pending, path);
  try {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms can't open a directory to sync it.
  }
};

export const nodeStore = async (
  handle: RuntimeHandle,
  engine: ModuleManifest,
  hostPath: string,
): Promise<DataStore> => {
  const fs = await nodeFs();
  const root = `${hostPath}/data`;
  const own = encodeComponent(engine.version);
  const dirOf = (version: string): string => `${root}/${version}`;
  const markerPath = (version: string): string => `${dirOf(version)}${MARKER}`;
  const pendingPath = (version: string): string => `${dirOf(version)}${PENDING}`;
  const pathsDir = (version: string): string => `${dirOf(version)}${PATHS}`;
  const pathMarker = (storePath: string): string =>
    `${pathsDir(own)}/${storePath.slice(storePath.lastIndexOf("/") + 1)}`;
  // The markers go first, so that a removal cut short leaves no marker.
  const remove = async (version: string): Promise<void> => {
    for (const path of [markerPath(version), pendingPath(version), pathsDir(version), dirOf(version)])
      await fs.rm(path, { recursive: true, force: true });
  };
  return {
    // A marker that doesn't parse is none, so the version is installed
    // again rather than every start failing.
    async installed() {
      try {
        return markerOf(JSON.parse(await fs.readFile(markerPath(own), "utf8")), engine.version);
      } catch {
        return null;
      }
    },
    async clear() {
      await remove(own);
      await fs.mkdir(dirOf(own), { recursive: true });
    },
    backend: () => withString(handle, dirOf(own), (ptr) => handle.rt._wasmfs_create_node_backend(ptr)),
    setWritable: () => {},
    // Every file of the data was fsync()ed before this is written.
    mark: (marker) => writeWhole(fs, root, pendingPath(own), markerPath(own), marker),
    async pathInstalled(storePath) {
      try {
        return pathMarkerOf(JSON.parse(await fs.readFile(`${pathMarker(storePath)}${MARKER}`, "utf8")));
      } catch {
        return null;
      }
    },
    async markPath(storePath, marker) {
      await fs.mkdir(pathsDir(own), { recursive: true });
      const path = pathMarker(storePath);
      await writeWhole(fs, pathsDir(own), `${path}${PENDING}`, `${path}${MARKER}`, marker);
    },
    // A version's directory, its markers, its marker being written, or any
    // of them together.
    others: async () => [
      ...new Set(
        (await fs.readdir(root).catch(() => [] as string[]))
          .map((name) => name.replace(/\.(installed|marking|paths)$/, ""))
          .filter((version) => version !== own),
      ),
    ],
    remove,
    closed: () => false,
    quiet: () => undefined,
  };
};
```

Replace `packages/worker-host/src/worker/install/provide.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Mounts this version's data at /nix/store, installing its base data first
// unless its marker says it is there, then lets other versions' data go.
// The base data is every store path no engine names as its own; those an
// engine names are installed when a page prepares that engine. A mount in
// memory is this host's alone, starts empty and can't grow, so it installs
// every store path at start with no lock. Otherwise the host holds the
// version's data lock, shared, for as long as it runs, and decides and
// installs under its install lock, so that of hosts starting together one
// installs and the others then find the marker. An install cut short leaves
// no marker, and the next host empties the version's storage and installs
// again, so no partial tree and no other version's file survives it, and a
// host using another version never sees its own data change.
//
// Any host may later install a store path of an engine's own into the
// version's storage, so its backend is created with its window for changes
// shut, opened only while the host holds an install lock and runs the
// installer, and sealed for good as the host closes.

import { errorSummary, lazyStorePaths, type ModuleManifest } from "@ibus-web/protocol";
import { Effect, type Scope } from "effect";
import type { HostConfigValues } from "../../shared/config.ts";
import type { CollectReport, HostMessage, InstallReport } from "../../shared/messages.ts";
import { encodeComponent, engineDataLock, engineDataRoot, engineInstallLock } from "../../shared/naming.ts";
import { runtimeCallFailed, runtimeFinalizer, startupFailed, StartupFailed } from "../failure.ts";
import type { Instruments } from "../instruments.ts";
import type { RuntimeHandle } from "../runtime.ts";
import type { Held } from "../storage/held.ts";
import { makeDirs, mountAt } from "../storage/mount.ts";
import type { StoragePlan } from "../storage/plan.ts";
import { requestLock } from "../storage/locks.ts";
import { installArchives, type ArchiveHooks, type Tally } from "./archive.ts";
import { idbStore, nodeStore, sharedWindow, type DataStore } from "./store.ts";
import { holdLock, progressOn } from "./wait.ts";

interface ProvideData {
  readonly handle: RuntimeHandle;
  readonly engine: ModuleManifest;
  readonly plan: StoragePlan;
  readonly idbReadOnly: number;
  readonly held: Held;
  readonly config: HostConfigValues;
  readonly instruments: Instruments;
  readonly post: (message: HostMessage) => void;
}

// What the engine's data is mounted on.
export interface DataMount {
  // Whether its IndexedDB backend's connection has closed under it.
  readonly closed: () => boolean;
}

// Deletes the data of every other version no host is using. A host using a
// version holds its data lock shared, so one granted exclusively at once is
// one no host uses, and no host can start using it until it is let go.
// Best-effort: a failure is reported, never thrown.
const collect = async (store: DataStore, engine: ModuleManifest): Promise<CollectReport> => {
  const report: CollectReport = { removed: [], inUse: [] };
  try {
    for (const version of await store.others()) {
      const lock = await requestLock(engineDataLock(engine, version), { mode: "exclusive", ifAvailable: true });
      if (lock === null) {
        report.inUse.push(version);
        continue;
      }
      try {
        await store.remove(version);
        report.removed.push(version);
      } finally {
        lock.release();
      }
    }
  } catch (error) {
    report.error = errorSummary(error);
  }
  return report;
};

const archiveHooks = (config: HostConfigValues, instruments: Instruments): ArchiveHooks => ({
  idleMs: config.archiveIdleMs,
  forceBrotliFallback: instruments.forceBrotliFallback,
  brotliDecoder: instruments.brotliDecoder,
  fetching: instruments.fetching,
  beforePiece: ({ fed }: Tally) => instruments.beforePiece(fed),
});

export const provideData = ({
  handle,
  engine,
  plan,
  idbReadOnly,
  held,
  config,
  instruments,
  post,
}: ProvideData): Effect.Effect<DataMount, StartupFailed, Scope.Scope> =>
  Effect.gen(function* () {
    if (engine.version === "")
      return yield* new StartupFailed({ message: `engine ${engine.name}'s manifest has no version` });
    const root = engineDataRoot(engine);
    const startedAt = performance.now();
    const report = (state: InstallReport["state"], fields: Omit<InstallReport, "state" | "version" | "installMs">) =>
      post({ type: "install", state, version: engine.version, ...fields, installMs: performance.now() - startedAt });

    if (plan.mount === "memory" || plan.mount === "none") {
      const lockedAt = Date.now();
      const tally = yield* Effect.tryPromise({
        try: () => {
          makeDirs(handle, root);
          return installArchives(handle, engine, engine.data, archiveHooks(config, instruments));
        },
        catch: runtimeCallFailed,
      });
      report("installed", {
        files: tally.files,
        bytes: tally.bytes,
        lockWaitMs: 0,
        lockedAt,
        releasedAt: Date.now(),
      });
      return { closed: () => false };
    }

    const lazy = lazyStorePaths(engine);
    const base = engine.data.filter(({ storePath }) => !lazy.has(storePath));
    const hold = (name: string, mode: LockMode, progress?: string) =>
      Effect.tryPromise({
        try: () => holdLock(name, mode, config, () => instruments.waiting(name), progress),
        catch: startupFailed,
      }).pipe(Effect.tap(({ lock }) => Effect.sync(() => held.add(lock))));
    yield* hold(engineDataLock(engine, encodeComponent(engine.version)), "shared");
    // Sealed as the host closes, while the runtime can still be called,
    // whether its start failed or it ran.
    let seal: (() => void) | undefined;
    yield* runtimeFinalizer(Effect.sync(() => seal?.()));
    const installLock = engineInstallLock(engine);
    const { store, marker, found, waitMs, lockedAt, releasedAt } = yield* Effect.gen(function* () {
      const { waitMs, lockedAt } = yield* Effect.acquireRelease(
        hold(installLock, "exclusive", installLock),
        ({ lock }) => Effect.sync(() => held.release(lock)),
      );
      yield* progressOn(installLock, config.progressIntervalMs);

      yield* Effect.try({ try: () => makeDirs(handle, "/nix"), catch: runtimeCallFailed });
      const store: DataStore = yield* plan.mount === "node"
        ? Effect.tryPromise({ try: () => nodeStore(handle, engine, plan.hostPath), catch: startupFailed })
        : Effect.succeed(idbStore(handle, engine, idbReadOnly, config.deleteLimitMs));
      const marker = yield* Effect.tryPromise({ try: () => store.installed(), catch: startupFailed });
      if (marker === null) yield* Effect.tryPromise({ try: () => store.clear(), catch: startupFailed });
      yield* Effect.try({ try: () => mountAt(handle, store.backend(), root, plan.mount), catch: runtimeCallFailed });
      seal = store.seal;
      const window = sharedWindow(store, instruments.window);
      let found = marker;
      if (found === null) {
        const tally = yield* Effect.tryPromise({
          try: () => window(() => installArchives(handle, engine, base, archiveHooks(config, instruments))),
          catch: runtimeCallFailed,
        });
        found = { version: engine.version, files: tally.files, bytes: tally.bytes };
        const marked = found;
        yield* Effect.tryPromise({ try: () => store.mark(marked), catch: startupFailed });
      }
      // Read before letting go, so that a host waiting on the lock can't take
      // it at an earlier time than this.
      const releasedAt = Date.now();
      return { store, marker, found, waitMs, lockedAt, releasedAt };
    }).pipe(Effect.scoped);
    report(marker === null ? "installed" : "present", {
      files: found.files,
      bytes: found.bytes,
      lockWaitMs: waitMs,
      lockedAt,
      releasedAt,
    });
    post({ type: "collect", ...(yield* Effect.promise(() => collect(store, engine))) });
    return { closed: () => store.closed() };
  });
```

- [ ] **Step 4: Run the units, then the host's suites**

```bash
nix develop -c git add packages/worker-host
nix build .#checks.x86_64-linux.worker-host-node -L
nix build .#worker-host-node-integration .#worker-host-browser-integration -L
```

Expected: PASS. The units pass (67 in the spike, `window.test.ts`'s three among them). Under Node and in Chromium and Firefox, every engine-data scenario passes unchanged, `data-read-only` among them: a write under the data fails with `EROFS` on the host that installed it (its window shut) and on the one that found it present, and `failed-start-releases-locks` and `install-interrupted` show a failed or killed install leaving nothing a next host can't redo.

- [ ] **Step 5: Document it**

In `docs/storage.md`:

- in section "Database layout", in the `meta` row, replace `` and `installed`, engine data's marker `` with `and engine data's markers`, padding the cell to the table's width, and replace the bullet

  ```markdown
  - `meta.installed` is the host's ([below](#installing)); the backend reserves the key and never reads it.
  ```

  with

  ```markdown
  - `meta.installed` and `meta.paths/<storePath>` are the host's ([below](#installing)); the backend reserves those keys
    and never reads them.
  ```

- in section "Engine data: a database per version", replace step 3 to the end of step 5 of the install with

  ```markdown
  3. **with a marker**, mounts the version with its window shut (`WASMFS_IDB_READ_ONLY`);
  4. **without one**, deletes the version's database (a deletion still blocked after 10 s fails the start), mounts a
     backend over a new one with its window shut, opens the window, extracts every base archive into it, shuts the window,
     and writes the marker last in a strict transaction on a connection of its own;
  5. lets go of the install lock, posts `install`, collects old versions and posts `collect`.

  Any host may later install an engine's own data into the version, so no host seals its data backend while it runs; each
  seals it as it closes, while the runtime can still be called.
  ```

  and in the paragraph after it replace

  ```markdown
  marker and the next host redoes it; a second host waiting on the lock finds the marker and mounts. The installing host
  keeps its sealed read-write backend rather than mount a third, since a backend's thread lasts as long as the runtime.
  ```

  with

  ```markdown
  marker and the next host redoes it; a second host waiting on the lock finds the marker and mounts. Every host mounts one
  data backend, created read-only, since a backend's thread lasts as long as the runtime; created read-only, it doesn't
  sweep a database other hosts install into.
  ```

- in section "Failed starts", replace

  ```markdown
  terminates the Worker. A read-write data backend whose install failed is sealed as the start fails, so nothing writes
  into an unmarked version once the host is closing.
  ```

  with

  ```markdown
  terminates the Worker. An install that fails shuts the data backend's window as it fails, and the data backend is sealed
  as the host closes, so nothing writes into an unmarked version once the host is closing.
  ```

- in section "Node hosts", replace `` so neither a read-only mount nor a seal refuses writes. `` with `` so neither a read-only mount, a shut window nor a seal refuses writes. ``

In `docs/worker-host.md`, section "The program and its scopes", in the Storage row replace `` installs or finds the version's data `` with `` installs or finds the version's base data `` and the release cell's `` Seals the read-write backends `` with `` Seals the backends ``; in section "Storage and engine data in the host", replace the **Install** bullet with

```markdown
- **Install** (`provide.ts`): the version's data lock, shared, for the host's life; then its install lock, exclusive;
  the marker read; if absent, the version's storage cleared; a mount with its window shut; if the marker was absent,
  the window opened, the base archives streamed in 64 KiB pieces through the tar decoder and written entry by entry through
  `FS`, the window shut, and the marker written last. The install lock goes as soon as the data is there; the host then collects other versions whose
  data lock it gets exclusively at once. A memory mount installs every archive at every start with no lock. The data
  backend is sealed as the host closes.
```

Then:

```bash
nix develop -c oxfmt docs/storage.md docs/worker-host.md
nix develop -c hk check -S links
```

- [ ] **Step 6: Commit**

```bash
nix develop -c git add packages/worker-host docs/storage.md docs/worker-host.md
nix develop -c git commit -m "feat(worker-host): mount engine data with its window shut, and keep a marker per store path" -- packages/worker-host/src/shared/naming.ts packages/worker-host/src/worker/runtime.ts packages/worker-host/src/worker/instruments.ts packages/worker-host/src/worker/install/archive.ts packages/worker-host/src/worker/install/store.ts packages/worker-host/src/worker/install/provide.ts packages/worker-host/test/node/install-lifetime.test.ts packages/worker-host/test/node/harness.ts packages/worker-host/test/node/window.test.ts packages/worker-host/test/worker/instruments.ts packages/worker-host/test/shared/testing.ts docs/storage.md docs/worker-host.md
```

---

### Task 6: `PrepareEngine`: installing an engine's own data in the host

**Files:**
- Modify: `packages/protocol/src/transport/layout.ts`; `packages/protocol/PROTOCOL.md` (generated)
- Modify: `packages/worker-host/src/shared/messages.ts`, `src/shared/control.ts`, `src/shared/index.ts`
- Create: `packages/worker-host/src/worker/mail.ts`, `src/worker/install/prepare.ts`
- Modify: `packages/worker-host/src/worker/layers/worker.ts`, `src/worker/layers/storage.ts`, `src/worker/index.ts`, `src/worker/loop.ts`, `src/worker/serve.ts`, `src/worker/install/provide.ts`, `src/worker/install/wait.ts`, `src/shared/naming.ts`
- Modify: `packages/worker-host/module.nix`, `packages/worker-host/_archives.nix`
- Modify (tests): `packages/worker-host/test/worker/host.ts`, `test/browser/layers.test.ts`, `test/shared/harness.ts`, `test/shared/install.ts`, `test/node/config.ts`, `test/node/scenarios.test.ts`, `test/browser/scenarios.test.ts`
- Create (tests): `packages/worker-host/test/shared/prepare.ts`
- Docs: `docs/storage.md`, `docs/worker-host.md`, `docs/engines.md`, `docs/known-gaps.md`

**Interfaces:**
- Consumes: Task 5's `DataStore` (`setWritable`, `pathInstalled`, `markPath`, `quiet`), `sharedWindow`, `installArchives(…, entries, hooks)` with `written` and `quiet`, `outside`, the `fetching` and `window` instruments; `holdLock` (`install/wait.ts`); `engineInstallLock`; `RuntimeRefused`.
- Produces: `Word.mail` = 11; `PrepareEngine`, `PathInstallReport` (with the path lock's `lockWaitMs`, `lockedAt`, `releasedAt`), `PreparedReport` (`{ engine, error? }`) and the three `HostMessage`s; `postMail(views)`; `enginePathInstallLock(engine, storePath)` (`ibus-web:install:<name>:<version>:<encoded store path>`); `announce(name, intervalMs): () => void`; `Mail` with `waiting`, `arrival()` and `next()`; `WorkerEnv.onMessage`; `HostWorkerShape.mail`; `StorageShape.prepare(engine): Promise<void>`; `DataMount.prepare`; `preparer({ engine, post, install? })`, whose prepares run at once and share one install per store path; the test harness's `RunningHost.prepare`, `Prepared`, `PREPARE_LIMIT_MS`; `TestData.engines.lazy`, `TestData.archives.lazy` and `lazy2`; `LAZY_PATH`, `lazyEngineFor`, the `prepare*` scenarios.

- [ ] **Step 1: Write the page's half and the failing scenarios**

The scenarios play the page, so they need what a page uses: the control word, the message types and `postMail`.

In `packages/protocol/src/transport/layout.ts`, add `mail: 11,` after `reqMode: 10,` in `Word`, and to `wordDescriptions`, after `reqMode`:

```ts
  mail: {
    writer: "page",
    description:
      "Messages posted to the host after HostInit, modulo 2³²; bumped after each, with wake, so a sleeping host goes to its event loop to read them.",
  },
```

In `packages/worker-host/src/shared/messages.ts`, replace `// The page's first and only message to the host. Wasm is the runtime's` with `// The page's first message to the host. Wasm is the runtime's`; before the comment `// What the host did with other versions' data once its own was mounted:` add

```ts
// The page's message to a host that is ready: install the engine's own
// data, the store paths its descriptor names, where this version's storage
// lacks them, before the engine is first made. The host answers with
// "prepared". The page posts it with postMail(), which brings a host asleep
// in the runtime out to its event loop, where messages arrive.
export interface PrepareEngine {
  type: "prepare-engine";
  engine: string;
}

// How the host found one store path of an engine's own data: "installed",
// this Worker installed it, for this engine or another that needs it too;
// "present", its marker was there. files and bytes are the regular files
// and the bytes of file data its install wrote, as its marker records them;
// installMs, how long installing it took, 0 when present. lockWaitMs,
// lockedAt and releasedAt are the path's install lock's, as InstallReport's
// are, and 0 when the marker was there before the host took it.
export interface PathInstallReport {
  engine: string;
  storePath: string;
  state: "installed" | "present";
  files: number;
  bytes: number;
  installMs: number;
  lockWaitMs: number;
  lockedAt: number;
  releasedAt: number;
}

// The end of a PrepareEngine: the engine's own data is installed, or error
// says why not.
export interface PreparedReport {
  engine: string;
  error?: string;
}

```

and in `HostMessage`, after `| ({ type: "collect" } & CollectReport)`, add

```ts
  // While a PrepareEngine installs: bytes of file data written of total,
  // the size of the engine's store paths the storage lacked.
  | { type: "prepare-progress"; engine: string; bytes: number; total: number }
  | ({ type: "path-install" } & PathInstallReport)
  | ({ type: "prepared" } & PreparedReport)
```

Append to `packages/worker-host/src/shared/control.ts`:

```ts

// Tells the host that the page has posted it a message: a host asleep in
// the runtime wakes, sees the count change and goes to its event loop, where
// the message arrives. Call it after posting the message.
export const postMail = ({ words }: ControlViews): void => {
  Atomics.add(words, Word.mail, 1);
  Atomics.add(words, Word.wake, 1);
  Atomics.notify(words, Word.wake);
};
```

In `packages/worker-host/src/shared/index.ts`, export `postMail` after `postCrash`, and `type PathInstallReport`, `type PreparedReport`, `type PrepareEngine` after `type Mount`.

The fixtures. In `packages/worker-host/module.nix`, after `engineDists` (`) engineSides;`), add

```nix

      # The echo engine's module with a second engine whose own data is the
      # store path its links point into, installed only once that engine is
      # prepared.
      lazyDist = engines.mkEngineManifest {
        name = "echo";
        package = engineSides.echo;
        inherit settingsSchemaDir;
        threads = engineThreads;
        heapBytes = 1024 * 1024;
        engines = [
          (testEngine "echo")
          (testEngine "echo-lazy" // { data = [ "${linkTarget}" ]; })
        ];
        settingsSchemas = [
          "org.example.echo"
          "org.freedesktop.ibus.panel"
        ];
      };
```

replace

```nix
            engines = lib.mapAttrs (_: dist: "${dist}") (engineDists // { rebuilt = rebuiltDist; });
```

with

```nix
            engines = lib.mapAttrs (_: dist: "${dist}") (
              engineDists
              // {
                rebuilt = rebuiltDist;
                lazy = lazyDist;
              }
            );
```

and in the `_archives.nix` call, after `dataName`, add

```nix
        lazyNames = {
          lazy = "11111111111111111111111111111111-test-lazy";
          lazy2 = "22222222222222222222222222222222-test-lazy2";
        };
```

In `packages/worker-host/_archives.nix`, add `lib,` before `runCommand,` and `lazyNames,` after `dataName,` in its arguments; in its header replace

```nix
# tree-upgrade.tar's under `upgrade`. tree.tar.br is tree.tar compressed,
# truncated.tar.br the same cut short, and corrupt.tar.br no Brotli at all.
```

with

```nix
# tree-upgrade.tar's under `upgrade`. lazy.tar and lazy2.tar are tree.tar
# under each of lazyNames' store paths, which the tests make engines' own
# data. tree.tar.br is tree.tar compressed, truncated.tar.br the same cut
# short, and corrupt.tar.br no Brotli at all.
```

and after `pack tree-upgrade ${dataName} tree-upgrade.tar` add

```nix
    ${lib.concatStrings (
      lib.mapAttrsToList (archive: name: "pack tree ${name} ${archive}.tar\n") lazyNames
    )}
```

In `packages/worker-host/test/node/config.ts`, add `| "lazy"` to the engine names in `Manifest.engines` (`Record<"echo" | "thrower" | "empty" | "rebuilt" | "lazy", string>`), in `type EngineName` and in `testData`'s `url` parameter's directory union; add `lazy: engineManifest("lazy", url),` after `rebuilt` in `engines`; add

```ts
      lazy: { ...tree, archive: "lazy.tar", url: url("archives", "lazy.tar") },
      lazy2: { ...tree, archive: "lazy2.tar", url: url("archives", "lazy2.tar") },
```

after `upgrade` in `archives`; and in the Node project's `workerHost` URL function replace

```ts
            dir === "archives" || dir === "echo" || dir === "thrower" || dir === "empty" || dir === "rebuilt"
```

with

```ts
            dir === "archives" ||
            dir === "echo" ||
            dir === "thrower" ||
            dir === "empty" ||
            dir === "rebuilt" ||
            dir === "lazy"
```

In `packages/worker-host/test/shared/harness.ts`:

- replace the imports from `control.ts` and `messages.ts` with

  ```ts
  import { controlViews, createControl, postMail } from "../../src/shared/control.ts";
  import type {
    EngineStorage,
    HostInit,
    PreparedReport,
    PrepareEngine,
    RuntimeConstants,
    SideModule,
  } from "../../src/shared/messages.ts";
  ```

- in `TestData`, make `engines` `Record<"echo" | "thrower" | "empty" | "rebuilt" | "lazy", ModuleManifest>` and replace

  ```ts
    // The engine's data, the next version's, which drops a file and turns
    // another into a directory, a URL where no archive is, and the installer's
    // own archives.
    archives: { tree: TestArchive; upgrade: TestArchive; missing: string; installer: InstallerArchives };
  ```

  with

  ```ts
    // The engine's data, the next version's, which drops a file and turns
    // another into a directory, the engine's data again under two store paths
    // of their own, a URL where no archive is, and the installer's own
    // archives.
    archives: {
      tree: TestArchive;
      upgrade: TestArchive;
      lazy: TestArchive;
      lazy2: TestArchive;
      missing: string;
      installer: InstallerArchives;
    };
  ```

- before `export interface RunningHost {` add

  ```ts
  // A PrepareEngine's answer, as the host posts it.
  export type Prepared = { type: "prepared" } & PreparedReport;

  ```

  and in `RunningHost`, after `client: Client;`,

  ```ts
    // Posts PrepareEngine for the engine, as a page does, and resolves with
    // the host's answer.
    prepare(engine: string): Promise<Prepared>;
  ```

- after `export const LATE_REPLY_MS = 30_000;` add

  ```ts

  // How long a PrepareEngine may take before a test gives up on it: an
  // install of the test archives takes well under a second.
  export const PREPARE_LIMIT_MS = 30_000;
  ```

- in `hostLauncher`, after the `worker.addEventListener("message", …)` that routes doorbells, add

  ```ts

        const views = controlViews(control, options.layout);
        const prepare = async (engine: string): Promise<Prepared> => {
          const from = messages.length;
          worker.postMessage({ type: "prepare-engine", engine } satisfies PrepareEngine);
          postMail(views);
          const deadline = env.now() + PREPARE_LIMIT_MS;
          for (;;) {
            const answer = messages
              .slice(from)
              .find((message): message is Prepared => message.type === "prepared" && message.engine === engine);
            if (answer !== undefined) return answer;
            if (env.now() >= deadline) throw new Error(`prepare ${engine}: no answer in ${PREPARE_LIMIT_MS} ms`);
            await env.sleep(5);
          }
        };
  ```

  and add `prepare,` after `client,` in the `RunningHost` it returns.

In `packages/worker-host/test/shared/install.ts`, export the helpers the new scenarios share: put `export` before `const installOf`, `const treeOf`, `const withHosts`, `const waitFor`, `const terminatedHostMayClose` and `const expectFreed`.

Create `packages/worker-host/test/shared/prepare.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The scenarios of an engine's own data: store paths an engine names, which
// a host installs only when the page prepares that engine, each under an
// install lock and with a marker of its own. Each scenario has an engine,
// and so storage and locks, of its own.

import { expect } from "vitest";
import type { ModuleManifest } from "@ibus-web/protocol";
import type { PathInstallReport } from "../../src/shared/messages.ts";
import { engineDataDatabase, enginePathInstallLock } from "../../src/shared/naming.ts";
import type { Client } from "./client.ts";
import type { Harness, RunningHost, RuntimeBuild } from "./harness.ts";
import { counts, expectFreed, installOf, terminatedHostMayClose, waitFor, withHosts } from "./install.ts";
import { call32, errno, opsOf, round } from "./scenarios.ts";
import { replyFile } from "./storage.ts";
import type { Message } from "./testing.ts";

const encoder = new TextEncoder();

// Where the lazy test archives' trees land.
export const LAZY_PATH = "/nix/store/11111111111111111111111111111111-test-lazy";
const LAZY2_PATH = "/nix/store/22222222222222222222222222222222-test-lazy2";

// The engines that name them as their own data: "lazy" and "shared" the
// first, "lazy2" the second.
const LAZY_ENGINE = "lazy";
const LAZY2_ENGINE = "lazy2";
const SHARED_ENGINE = "shared";

// An engine of its own for a scenario on a runtime, whose base data is the
// test engine's own, its schemas, and whose other engines name the lazy
// archives as their own data. The archives' version is the engine's.
export const lazyEngineFor = (h: Harness, scenario: string, runtime: RuntimeBuild): ModuleManifest => {
  const { empty } = h.data.engines;
  const { lazy, lazy2 } = h.data.archives;
  const descriptor = empty.engines[0]!;
  return {
    ...empty,
    name: `${scenario}-${runtime.name}-${Math.random().toString(36).slice(2, 8)}`,
    memory: h.data.constants.memory.minimum,
    version: lazy.version,
    data: [
      ...empty.data,
      { storePath: LAZY_PATH, url: lazy.url, size: lazy.size, encoding: "identity" },
      { storePath: LAZY2_PATH, url: lazy2.url, size: lazy2.size, encoding: "identity" },
    ],
    engines: [
      ...empty.engines,
      { ...descriptor, name: LAZY_ENGINE, data: [LAZY_PATH] },
      { ...descriptor, name: LAZY2_ENGINE, data: [LAZY2_PATH] },
      { ...descriptor, name: SHARED_ENGINE, data: [LAZY_PATH] },
    ],
  };
};

const pathInstalls = (messages: readonly Message[], from = 0, engine = LAZY_ENGINE): PathInstallReport[] =>
  messages.slice(from).flatMap((message) => {
    if (message.type !== "path-install" || message.engine !== engine) return [];
    const { type: _, ...report } = message;
    return [report];
  });

const progressOf = (messages: readonly Message[], from = 0, engine = LAZY_ENGINE): { bytes: number; total: number }[] =>
  messages
    .slice(from)
    .flatMap((message) =>
      message.type === "prepare-progress" && message.engine === engine
        ? [{ bytes: message.bytes, total: message.total }]
        : [],
    );

// The tree under path as the host sees it, listed by list-tree, or the
// error that listing it failed with.
const listed = async (h: Harness, client: Client, path: string): Promise<string | number> => {
  const reply = replyFile(await client.call(opsOf(h).listTree, encoder.encode(path)));
  return reply.text ?? reply.status;
};

// Checks what the host said of preparing the engine since from: its one
// store path found in state, and progress from 0 to the path's size when it
// had to be installed.
const expectPrepared = (
  h: Harness,
  host: RunningHost,
  from: number,
  engine: string,
  storePath: string,
  state: PathInstallReport["state"],
): PathInstallReport => {
  const { files, bytes } = counts(h.data.archives.lazy);
  const reports = pathInstalls(host.messages, from, engine);
  expect(reports, `${engine}'s path reports`).toMatchObject([{ engine, storePath, state, files, bytes }]);
  const progress = progressOf(host.messages, from, engine);
  if (state === "present") expect(progress, `${engine}'s progress for data already there`).toEqual([]);
  else {
    expect(progress[0], `${engine}'s first progress`).toEqual({ bytes: 0, total: h.data.archives.lazy.size });
    expect(progress.at(-1), `${engine}'s last progress`).toEqual({ bytes, total: h.data.archives.lazy.size });
  }
  return reports[0]!;
};

// Prepares the lazy engine and checks the host's answer: no error, and the
// lazy path found in state.
const prepareLazy = async (
  h: Harness,
  host: RunningHost,
  state: PathInstallReport["state"],
): Promise<PathInstallReport> => {
  const from = host.messages.length;
  const prepared = await host.prepare(LAZY_ENGINE);
  expect(prepared, "the prepare's answer").toEqual({ type: "prepared", engine: LAZY_ENGINE });
  return expectPrepared(h, host, from, LAZY_ENGINE, LAZY_PATH, state);
};

// Whether two installs held their locks at overlapping times.
const overlapped = (a: PathInstallReport, b: PathInstallReport): boolean =>
  a.lockedAt < b.releasedAt && b.lockedAt < a.releasedAt;

const expectLazyTree = async (h: Harness, client: Client, what = "the lazy tree"): Promise<void> => {
  expect(await listed(h, client, LAZY_PATH), what).toBe(h.data.archives.lazy.listing);
};

// A host installs at start the data no engine names, not the lazy path;
// preparing the engine that names it installs it, posting progress, and
// preparing it again finds its marker. An engine with no data of its own,
// and one the module doesn't have, are answered at once.
export const prepareFresh = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-fresh", runtime);
    const host = await launch(engine).ready;
    expect(installOf(host.messages), "the install report").toMatchObject({
      state: "installed",
      files: h.data.schemaFiles,
      bytes: h.data.engines.empty.data.reduce((sum, entry) => sum + entry.size, 0),
    });
    expect(await listed(h, host.client, LAZY_PATH), "the lazy path before").toBe(-errno(h, "ENOENT"));
    const installed = await prepareLazy(h, host, "installed");
    h.record("prepare-fresh", { lockWaitMs: round(installed.lockWaitMs, 1), installMs: round(installed.installMs, 1) });
    await expectLazyTree(h, host.client);
    expect((await prepareLazy(h, host, "present")).lockedAt, "a marker found without the lock").toBe(0);
    expect(await host.prepare(engine.engines[0]!.name), "an engine with no data of its own").toEqual({
      type: "prepared",
      engine: engine.engines[0]!.name,
    });
    expect((await host.prepare("missing")).error, "an engine the module lacks").toBe(
      `module ${engine.name} has no engine missing`,
    );
  });

// A host started after another installed the lazy path finds its marker and
// installs nothing.
export const prepareSkip = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-skip", runtime);
    const first = await launch(engine).ready;
    await prepareLazy(h, first, "installed");
    await first.terminate();
    const second = await launch(engine).ready;
    expect(installOf(second.messages)?.state, "the base data").toBe("present");
    await prepareLazy(h, second, "present");
    await expectLazyTree(h, second.client);
  });

// Of two hosts preparing the engine at once, one installs the lazy path and
// the other waits on the path's install lock, then finds the marker; both
// read the tree. Browsers only: Node's Web Locks can grant one exclusive
// lock twice.
export const prepareRace = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-race", runtime);
    const first = await launch(engine).ready;
    const second = await launch(engine).ready;
    const hosts = [first, second];
    const from = hosts.map(({ messages }) => messages.length);
    const answers = await Promise.all(hosts.map((host) => host.prepare(LAZY_ENGINE)));
    for (const answer of answers) expect(answer.error, "a prepare's error").toBeUndefined();
    const reports = hosts.map(({ messages }, i) => pathInstalls(messages, from[i])[0]!);
    const states = reports.map(({ state }) => state);
    expect(states.toSorted(), "the hosts' path states").toEqual(["installed", "present"]);
    const installed = reports[states.indexOf("installed")]!;
    const present = reports[states.indexOf("present")]!;
    h.record("prepare-race", { lockTakenAfterReleaseMs: present.lockedAt - installed.releasedAt });
    expect(present.lockedAt, "the second took the lock").toBeGreaterThanOrEqual(installed.releasedAt);
    for (const host of hosts) await expectLazyTree(h, host.client);
  });

// Two engines prepared at once whose data are different store paths install
// at the same time, each under its own lock, and the backend's window opens
// once as the first extraction starts and shuts once after the last ends.
export const prepareConcurrent = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-concurrent", runtime);
    const host = await launch(engine, { test: { pieceDelayMs: 20 } }).ready;
    const from = host.messages.length;
    const answers = await Promise.all([host.prepare(LAZY_ENGINE), host.prepare(LAZY2_ENGINE)]);
    for (const answer of answers) expect(answer.error, "a prepare's error").toBeUndefined();
    const first = expectPrepared(h, host, from, LAZY_ENGINE, LAZY_PATH, "installed");
    const second = expectPrepared(h, host, from, LAZY2_ENGINE, LAZY2_PATH, "installed");
    h.record("prepare-concurrent", {
      first: [first.lockedAt, first.releasedAt],
      second: [second.lockedAt, second.releasedAt],
    });
    expect(overlapped(first, second), "the two installs overlapped").toBe(true);
    const windows = host.messages.slice(from).flatMap((message) => (message.type === "window" ? [message] : []));
    expect(
      windows.map(({ open }) => open),
      "the window opened once and shut once",
    ).toEqual([true, false]);
    expect(windows[1]!.at, "the window shut after both started").toBeGreaterThanOrEqual(
      Math.max(first.lockedAt, second.lockedAt),
    );
    await expectLazyTree(h, host.client);
    expect(await listed(h, host.client, LAZY2_PATH), "the second tree").toBe(h.data.archives.lazy2.listing);
  });

// Two engines prepared at once that share a store path wait on one install
// of it: its archive is fetched once, and each engine's progress runs to the
// path's size.
export const prepareShared = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-shared", runtime);
    const host = await launch(engine, { test: { pieceDelayMs: 20 } }).ready;
    const from = host.messages.length;
    const answers = await Promise.all([host.prepare(LAZY_ENGINE), host.prepare(SHARED_ENGINE)]);
    for (const answer of answers) expect(answer.error, "a prepare's error").toBeUndefined();
    expectPrepared(h, host, from, LAZY_ENGINE, LAZY_PATH, "installed");
    expectPrepared(h, host, from, SHARED_ENGINE, LAZY_PATH, "installed");
    expect(
      host.messages
        .slice(from)
        .filter((message) => message.type === "fetching" && message.url === h.data.archives.lazy.url),
      "fetches of the shared path's archive",
    ).toHaveLength(1);
    await expectLazyTree(h, host.client);
  });

// A host that mounted the version before another host installed the lazy
// path, and looked for one of its files and found nothing, finds it once
// the other host has installed it, without preparing the engine itself;
// preparing it then finds the marker.
export const prepareAfterMount = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-after-mount", runtime);
    const file = h.data.archives.lazy.listing
      .split("\n")
      .find((line) => /\tf /.test(line))!
      .split("\t")[0]!;
    const path = `${LAZY_PATH}/${file}`;
    const read = async (client: Client) => replyFile(await client.call(opsOf(h).readFile, encoder.encode(path))).status;
    const mounted = await launch(engine).ready;
    expect(await read(mounted.client), "the file before it is installed").toBe(-errno(h, "ENOENT"));
    expect(await listed(h, mounted.client, LAZY_PATH), "the lazy path before").toBe(-errno(h, "ENOENT"));
    const installer = await launch(engine).ready;
    await prepareLazy(h, installer, "installed");
    expect(await read(mounted.client), "the file once another host installed it").toBeGreaterThanOrEqual(0);
    await expectLazyTree(h, mounted.client, "the lazy tree once another host installed it");
    await prepareLazy(h, mounted, "present");
  });

// A host whose Worker is terminated halfway through installing the lazy
// path leaves no marker for it: the next host to prepare the engine
// extracts the archive again over what the first left, and the tree is the
// archive's, its counts whole.
export const prepareInterrupted = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-interrupted", runtime);
    const { lazy } = h.data.archives;
    const launched = launch(engine, { test: { stallAt: Math.floor(lazy.size / 2) } });
    const first = await launched.ready;
    void first.prepare(LAZY_ENGINE).catch(() => {});
    const { bytes } = await waitFor(
      h,
      launched,
      (message): message is { type: "stalled"; bytes: number } => message.type === "stalled",
      "the install stalling",
    );
    expect(bytes, "archive bytes fed before the stall").toBeLessThan(lazy.size);
    await first.terminate();
    await expectFreed(h, enginePathInstallLock(engine, LAZY_PATH));
    const next = await launch(engine).ready;
    expect(installOf(next.messages)?.state, "the base data").toBe("present");
    await prepareLazy(h, next, "installed");
    await expectLazyTree(h, next.client);
    await terminatedHostMayClose(h, engineDataDatabase(engine));
  });

// The backend's window is open only while a host installs: a file written
// into the store once the lazy path is installed, or once an install of it
// has failed, fails with EROFS, and the tree stays the archive's. The Node
// backend has no read-only mode, so under Node the writes are recorded,
// not judged.
export const prepareWindowShut = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = lazyEngineFor(h, "prepare-window-shut", runtime);
    const broken: ModuleManifest = {
      ...engine,
      data: engine.data.map((entry) =>
        entry.storePath === LAZY_PATH ? { ...entry, url: h.data.archives.missing } : entry,
      ),
    };
    const write = (client: Client): Promise<number> =>
      call32(client, opsOf(h).writeFile, encoder.encode("/nix/store/written.txt\0x"));
    const failing = await launch(broken).ready;
    const failed = await failing.prepare(LAZY_ENGINE);
    expect(failed.error, "the failed prepare's error").toBe(`fetch ${h.data.archives.missing}: 404`);
    await expectFreed(h, enginePathInstallLock(engine, LAZY_PATH));
    const afterFailure = await write(failing.client);
    const installing = await launch(engine).ready;
    await prepareLazy(h, installing, "installed");
    const afterInstall = await write(installing.client);
    h.record("prepare-window-shut", { afterFailure, afterInstall });
    if (h.storageMount !== "indexeddb") return;
    expect(afterFailure, "a write after a failed install").toBe(-errno(h, "EROFS"));
    expect(afterInstall, "a write after an install").toBe(-errno(h, "EROFS"));
    await expectLazyTree(h, installing.client);
  });

// Without IndexedDB the data lives in the runtime's memory, which can't
// grow, so the host installs every store path at start, both lazy archives
// among them, and a prepare finds nothing to do.
export const preparedInMemory = async (h: Harness, host: RunningHost): Promise<void> => {
  const { files, bytes } = counts(h.data.archives.lazy);
  expect(installOf(host.messages), "the install report").toMatchObject({
    state: "installed",
    files: 2 * files + h.data.schemaFiles,
    bytes: 2 * bytes + h.data.engines.empty.data.reduce((sum, entry) => sum + entry.size, 0),
    lockWaitMs: 0,
  });
  await expectLazyTree(h, host.client);
  const from = host.messages.length;
  expect(await host.prepare(LAZY_ENGINE), "the prepare").toEqual({ type: "prepared", engine: LAZY_ENGINE });
  expect(pathInstalls(host.messages, from), "path reports").toEqual([]);
};

// The echo engine's distribution as mkEngineManifest builds it, whose
// second engine names as its own data the store path the echo data's links
// lead into: a link into it dangles until that engine is prepared.
export const preparedDistribution = (h: Harness, runtime: RuntimeBuild): Promise<void> =>
  withHosts(h, runtime, async (launch) => {
    const engine = { ...h.data.engines.lazy, name: `prepared-distribution-${runtime.name}-${Math.random()}` };
    const lazy = engine.engines.find(({ data }) => data !== undefined);
    expect(lazy?.data, "the engine with data of its own").toHaveLength(1);
    const dir = h.data.echoData.slice(0, h.data.echoData.lastIndexOf("/"));
    const host = await launch(engine).ready;
    const read = async (path: string) => replyFile(await host.client.call(opsOf(h).readFile, encoder.encode(path)));
    expect((await read(`${dir}/data.txt`)).text, "the base data").toBe("echo store data\n");
    expect((await read(`${dir}/absolute.txt`)).status, "a link into the engine's data, before").toBe(
      -errno(h, "ENOENT"),
    );
    expect((await host.prepare(lazy!.name)).error, "the prepare's error").toBeUndefined();
    expect((await read(`${dir}/absolute.txt`)).text, "a link into the engine's data, after").toBe("echo link target\n");
  });
```

Register them. In `packages/worker-host/test/node/scenarios.test.ts`, import

```ts
import {
  lazyEngineFor,
  prepareAfterMount,
  prepareConcurrent,
  preparedDistribution,
  preparedInMemory,
  prepareFresh,
  prepareInterrupted,
  prepareShared,
  prepareSkip,
  prepareWindowShut,
} from "../shared/prepare.ts";
```

before `import { nodeHarness } from "./harness.ts";`, and before the comment `// The Worker scripts exactly as the package ships them, loaded as they are` add

```ts
// Node's Web Locks can grant an exclusive lock twice, so prepare-race runs only in browsers.
describe.each(h.data.runtimes)("an engine's own data on the $name runtime", (runtime) => {
  test("prepare-fresh", () => prepareFresh(h, runtime));
  test("prepare-skip", () => prepareSkip(h, runtime));
  test("prepare-concurrent", () => prepareConcurrent(h, runtime));
  test("prepare-shared", () => prepareShared(h, runtime));
  test("prepare-after-mount", () => prepareAfterMount(h, runtime));
  test("prepare-interrupted", () => prepareInterrupted(h, runtime));
  test("prepare-window-shut", () => prepareWindowShut(h, runtime));
  test("prepared-distribution", () => preparedDistribution(h, runtime));
  test("prepared-in-memory", async () => {
    const host = await h.start({
      runtime,
      engine: lazyEngineFor(h, "prepared-in-memory", runtime),
      storage: { kind: "browser" },
      test: h.withoutIndexedDB,
    });
    try {
      await preparedInMemory(h, host);
    } finally {
      await host.terminate();
    }
  });
});

```

In `packages/worker-host/test/browser/scenarios.test.ts`, the same import (with `prepareRace` added after `prepareInterrupted`) before `import { browserHarness } from "./harness.ts";`, and the same block before its `// The Worker scripts exactly as the package ships them, loaded as they are` comment, without the first comment line and with `test("prepare-race", () => prepareRace(h, runtime));` after `prepare-shared`.

- [ ] **Step 2: Run them to see them fail**

```bash
nix develop -c git add packages/protocol packages/worker-host
nix build .#worker-host-node-integration -L
```

Expected: FAIL. Every `prepare-*` case fails with `prepare lazy: no answer in 30000 ms` (`prepare echo-lazy: …` in `prepared-distribution`), since the host never reads its mail; `prepared-in-memory`'s install report already counts both lazy archives. The rest pass. (The run takes some ten minutes more than usual for the timeouts.)

- [ ] **Step 3: Take the page's messages in the host**

Create `packages/worker-host/src/worker/mail.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The page's messages after HostInit. They arrive only through the host's
// event loop, which a host asleep in the runtime doesn't run, so the page
// counts each in the control buffer's mail word too (postMail()), and the
// host, seeing the count change, goes to its event loop to take them.

import type { PrepareEngine } from "../shared/messages.ts";

const isPrepare = (message: unknown): message is PrepareEngine =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "prepare-engine" &&
  typeof (message as { engine?: unknown }).engine === "string";

export class Mail {
  readonly #queue: (PrepareEngine | undefined)[] = [];
  #arrived: (() => void) | undefined;

  // A message the page posted. It counts in the mail word whatever it is,
  // so one the host doesn't know is kept as undefined, which it skips.
  receive(message: unknown): void {
    this.#queue.push(isPrepare(message) ? message : undefined);
    this.#arrived?.();
    this.#arrived = undefined;
  }

  // Whether a message has arrived that hasn't been taken.
  get waiting(): boolean {
    return this.#queue.length > 0;
  }

  // Settles once a message is waiting.
  async arrival(): Promise<void> {
    while (this.#queue.length === 0)
      await new Promise<void>((resolve) => {
        this.#arrived = resolve;
      });
  }

  // Takes the next message, once it has arrived.
  async next(): Promise<PrepareEngine | undefined> {
    await this.arrival();
    return this.#queue.shift()!;
  }
}
```

In `packages/worker-host/src/worker/layers/worker.ts`: import `{ Mail } from "../mail.ts"` after the `failure.ts` import; add to `WorkerEnv`, after `onUncaughtError`,

```ts
  // Calls listener with each message the page posts after HostInit.
  onMessage(listener: (message: unknown) => void): void;
```

to `HostWorkerShape`, after `env`,

```ts
  // The page's messages after HostInit, kept from the moment the Worker
  // scope starts, so that none posted once the host is ready is lost.
  readonly mail: Mail;
```

in the layer's `Effect.gen`, after `const startedAt = performance.now();`,

```ts
      const mail = new Mail();
      env.onMessage((message) => mail.receive(message));
```

and `mail,` after `env,` in the value it returns.

In `packages/worker-host/src/worker/index.ts`, replace the header comment's

```ts
// The Worker host's script, which the page starts by URL. Its one message is
// a HostInit. It runs with the default configuration and no instruments:
// whatever HostInit.test holds is never read.
```

with

```ts
// The Worker host's script, which the page starts by URL. Its first message
// is a HostInit; the rest go to the host. It runs with the default
// configuration and no instruments: whatever HostInit.test holds is never
// read.
```

and add to `env`, after `onUncaughtError`,

```ts
  onMessage: (listener) => {
    self.onmessage = ({ data }: MessageEvent) => listener(data);
  },
```

Add the same `onMessage` member after `onUncaughtError` in `packages/worker-host/test/worker/host.ts`'s `env`, and `onMessage: () => {},` after `onUncaughtError` in `packages/worker-host/test/browser/layers.test.ts`'s `env`.

Create `packages/worker-host/src/worker/install/prepare.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Installing an engine's own data, the store paths its descriptor names,
// when the page prepares the engine ahead of making it. Each store path is
// installed under an install lock of its own, so paths install at once, in
// one Worker or several, and within a Worker one install serves every
// engine that needs the path while it runs. Under the lock the host reads
// the path's marker again, since another host may have installed it
// meanwhile; if it is still missing, it extracts the path's archive through
// the backend's window and writes the marker, last. An install cut short
// leaves no marker, and the next one extracts over what it left: the
// version and the store path name one archive, and the installer completes
// a tree an earlier run of the same archive left half-written, without
// removing what another host's file system may already have found there. A
// host that mounted the version before another installed a path finds the
// path by lookup, since WasmFS keeps only the entries it has found, never
// an entry's absence.

import { errorMessage, type ModuleManifest } from "@ibus-web/protocol";
import type { HostConfigValues } from "../../shared/config.ts";
import type { HostMessage, PathInstallReport } from "../../shared/messages.ts";
import { enginePathInstallLock } from "../../shared/naming.ts";
import type { Instruments } from "../instruments.ts";
import { RuntimeRefused, type RuntimeHandle } from "../runtime.ts";
import type { Held } from "../storage/held.ts";
import { installArchives, outside, type ArchiveHooks, type DataEntry } from "./archive.ts";
import type { DataStore } from "./store.ts";
import { announce, holdLock } from "./wait.ts";

// What installing into the version's storage takes; a mount in memory has
// installed every store path at start, and has none.
interface Install {
  readonly handle: RuntimeHandle;
  readonly store: DataStore;
  // Runs an extraction with the backend's window open, shared by every
  // extraction that overlaps it.
  readonly window: <T>(install: () => Promise<T>) => Promise<T>;
  readonly held: Held;
  readonly config: HostConfigValues;
  readonly instruments: Instruments;
  readonly hooks: ArchiveHooks;
}

interface Preparing {
  readonly engine: ModuleManifest;
  readonly post: (message: HostMessage) => void;
  readonly install?: Install;
}

// What one store path's install found or did, as its report says it.
type PathOutcome = Omit<PathInstallReport, "engine" | "storePath">;

// One store path's install in this Worker, which every engine that needs
// the path while it runs awaits.
interface PathInstall {
  outcome: Promise<PathOutcome>;
  // The bytes of file data it has written, and who hears them change.
  written: number;
  readonly heard: Set<() => void>;
}

const absent = { lockWaitMs: 0, lockedAt: 0, releasedAt: 0 };

// Installs the store path under its own lock, saying it is still going on
// the lock's channel while it holds it.
const installPath = (
  { handle, store, window, held, config, instruments, hooks }: Install,
  engine: ModuleManifest,
  entry: DataEntry,
  path: PathInstall,
): Promise<PathOutcome> =>
  (async () => {
    const lock = enginePathInstallLock(engine, entry.storePath);
    const granted = await outside(
      lock,
      holdLock(lock, "exclusive", config, () => instruments.waiting(lock), lock),
    );
    held.add(granted.lock);
    const stop = announce(lock, config.progressIntervalMs);
    try {
      const fields = { lockWaitMs: granted.waitMs, lockedAt: granted.lockedAt };
      const marker = await outside(`${entry.storePath}'s marker`, store.pathInstalled(entry.storePath));
      if (marker !== null) return { state: "present", ...marker, installMs: 0, ...fields, releasedAt: Date.now() };
      const startedAt = performance.now();
      const tally = await window(() =>
        installArchives(handle, engine, [entry], {
          ...hooks,
          quiet: store.quiet,
          written: (bytes) => {
            path.written = bytes;
            for (const hear of path.heard) hear();
          },
        }),
      );
      const written = { files: tally.files, bytes: tally.bytes };
      await outside(`marking ${entry.storePath}`, store.markPath(entry.storePath, written));
      // Read before letting go, so that a host waiting on the lock can't take
      // it at an earlier time than this.
      return {
        state: "installed",
        ...written,
        installMs: performance.now() - startedAt,
        ...fields,
        releasedAt: Date.now(),
      };
    } finally {
      stop();
      held.release(granted.lock);
    }
  })();

// Prepares the named engines, posting "path-install" for each of an
// engine's store paths, "prepare-progress" while they install, and
// "prepared" last. Several prepares run at once; the promise each returns
// rejects only with what a call into the runtime threw.
export const preparer = ({ engine, post, install }: Preparing): ((name: string) => Promise<void>) => {
  // The store paths this Worker is installing.
  const installing = new Map<string, PathInstall>();

  const start = (entry: DataEntry, worker: Install): PathInstall => {
    const path = { written: 0, heard: new Set() } as unknown as PathInstall;
    path.outcome = installPath(worker, engine, entry, path);
    installing.set(entry.storePath, path);
    const done = (): void => {
      installing.delete(entry.storePath);
    };
    path.outcome.then(done, done);
    return path;
  };

  return async (name) => {
    const prepared = (error?: string): void =>
      post({ type: "prepared", engine: name, ...(error === undefined ? {} : { error }) });
    const report = (storePath: string, outcome: PathOutcome): void =>
      post({ type: "path-install", engine: name, storePath, ...outcome });
    const descriptor = engine.engines.find((candidate) => candidate.name === name);
    if (descriptor === undefined) return prepared(`module ${engine.name} has no engine ${name}`);
    const paths = descriptor.data ?? [];
    if (install === undefined || paths.length === 0) return prepared();
    const entries = paths.map((path) => engine.data.find(({ storePath }) => storePath === path)!);

    try {
      // A path already marked needs no lock: its marker is written last.
      const missing: DataEntry[] = [];
      for (const entry of entries) {
        const marker = installing.has(entry.storePath)
          ? null
          : await outside(`${entry.storePath}'s marker`, install.store.pathInstalled(entry.storePath));
        if (marker === null) missing.push(entry);
        else report(entry.storePath, { state: "present", ...marker, installMs: 0, ...absent });
      }
      if (missing.length === 0) return prepared();

      const total = missing.reduce((sum, { size }) => sum + size, 0);
      const paths = missing.map((entry) => installing.get(entry.storePath) ?? start(entry, install));
      const settled = new Set<PathInstall>();
      let said = -1;
      const progress = (): void => {
        const bytes = missing.reduce(
          (sum, { size }, i) => sum + (settled.has(paths[i]!) ? size : paths[i]!.written),
          0,
        );
        if (bytes === said) return;
        said = bytes;
        post({ type: "prepare-progress", engine: name, bytes, total });
      };
      progress();
      for (const path of paths) path.heard.add(progress);
      const outcomes = await Promise.allSettled(
        paths.map((path) =>
          path.outcome.finally(() => {
            settled.add(path);
            progress();
          }),
        ),
      );
      for (const path of paths) path.heard.delete(progress);

      let failure: unknown;
      outcomes.forEach((outcome, i) => {
        if (outcome.status === "fulfilled") report(missing[i]!.storePath, outcome.value);
        else if (outcome.reason instanceof RuntimeRefused) failure ??= outcome.reason;
        else throw outcome.reason;
      });
      return prepared(failure === undefined ? undefined : errorMessage(failure));
    } catch (error) {
      if (!(error instanceof RuntimeRefused)) throw error;
      return prepared(errorMessage(error));
    }
  };
};
```

In `packages/worker-host/src/shared/naming.ts`, after `engineInstallLock`, add

```ts

// The Web Lock one store path of an engine's own data is installed under,
// held exclusively, so that paths install independently of one another.
export const enginePathInstallLock = (engine: EngineIdentity, storePath: string): string =>
  `${engineInstallLock(engine)}:${encodeComponent(storePath)}`;
```

In `packages/worker-host/src/worker/install/wait.ts`, before the comment `// The install lock owns the channel and timer,`, add

```ts
// Says the holder of the lock name is still going, at once and every
// intervalMs, until the function it returns is called.
export const announce = (name: string, intervalMs: number): (() => void) => {
  const channel = new BroadcastChannel(name);
  channel.postMessage(null);
  const timer = setInterval(() => channel.postMessage(null), intervalMs);
  return () => {
    clearInterval(timer);
    channel.close();
  };
};

```

In `packages/worker-host/src/worker/install/provide.ts`, import `{ preparer } from "./prepare.ts"` after the `archive.ts` import; replace `shut, opened only while the host holds the install lock and runs the` in the header comment with `shut, opened only while the host holds an install lock and runs the`; keep the shared window the base install used for the prepares: replace `const { store, marker, found, waitMs, lockedAt, releasedAt } = yield* Effect.gen(function* () {` with `const { store, window, marker, found, waitMs, lockedAt, releasedAt } = yield* Effect.gen(function* () {` and `return { store, marker, found, waitMs, lockedAt, releasedAt };` with `return { store, window, marker, found, waitMs, lockedAt, releasedAt };`; add to `DataMount`, after `closed`,

```ts
  // Installs the named engine's own data where the version's storage lacks
  // it, posting what it does and, last, "prepared". Rejects only with what
  // a call into the runtime threw, which leaves the runtime unfit to call.
  readonly prepare: (engine: string) => Promise<void>;
```

replace the memory branch's `return { closed: () => false };` with `return { closed: () => false, prepare: preparer({ engine, post }) };`, and the last `return { closed: () => store.closed() };` with

```ts
    return {
      closed: () => store.closed(),
      prepare: preparer({
        engine,
        post,
        install: { handle, store, window, held, config, instruments, hooks: archiveHooks(config, instruments) },
      }),
    };
```

In `packages/worker-host/src/worker/layers/storage.ts`, replace

```ts
// released while the runtime can still be called, it seals the read-write
// backends, which lets the writer lock go.
export class Storage extends Context.Service<Storage, MountedStorage>()("@ibus-web/worker-host/Storage") {}
```

with

```ts
// released while the runtime can still be called, it seals the backends,
// which lets the writer lock go.
export interface StorageShape extends MountedStorage {
  // Installs an engine's own data before it is first made.
  readonly prepare: (engine: string) => Promise<void>;
}

export class Storage extends Context.Service<Storage, StorageShape>()("@ibus-web/worker-host/Storage") {}
```

and

```ts
      const storage: MountedStorage = { ...mounted, closed: () => mounted.closed() || data.closed() };
```

with

```ts
      const storage: StorageShape = {
        ...mounted,
        closed: () => mounted.closed() || data.closed(),
        prepare: data.prepare,
      };
```

In `packages/worker-host/src/worker/loop.ts`: add to `LoopContext`, after `woken`,

```ts
  // The page's messages after HostInit the host has taken, as the control
  // buffer's mail word counts them.
  mailTaken: number;
```

add to `Excursion`, after the `topUp` member,

```ts
  // The page has posted messages the host hasn't taken.
  | { kind: "mail" }
```

and replace the comment and first lines of `serveUntilExcursion`,

```ts
// Serves requests and pumps, sleeping in ibusweb_wait() between them, until
// the pool needs topping up while no request is pending, or something must
// wait for the event loop. A runtime call that traps throws out of here.
export const serveUntilExcursion = (ctx: LoopContext): Excursion => {
  const { handle, instruments } = ctx;
  for (;;) {
    const next = step(ctx);
    if (next.kind === "served") continue;
    if (next.kind !== "idle") return next;
```

with

```ts
// Whether the page has posted messages the host hasn't taken.
export const mailWaiting = (ctx: LoopContext): boolean =>
  Atomics.load(ctx.control.words, Word.mail) !== ctx.mailTaken;

// Serves requests and pumps, sleeping in ibusweb_wait() between them, until
// the pool needs topping up while no request is pending, the page has
// posted a message, or something must wait for the event loop. A runtime
// call that traps throws out of here.
export const serveUntilExcursion = (ctx: LoopContext): Excursion => {
  const { handle, instruments } = ctx;
  for (;;) {
    const next = step(ctx);
    if (next.kind === "served") continue;
    if (next.kind !== "idle") return next;
    // Checked once step has read the wake word, so that mail posted after
    // this check has moved the word the host then sleeps on.
    if (mailWaiting(ctx)) return { kind: "mail" };
```

The order matters: checked before `step` reads the wake word, a message posted between the check and that read moves the word before the host samples it, and the host sleeps on the moved word for good (the spike caught this as a prepare left unanswered in about one Chromium run in four).

In `packages/worker-host/src/worker/serve.ts`: import `mailWaiting` from `./loop.ts` with the rest, as

```ts
import {
  finishReply,
  mailWaiting,
  pump,
  ringDoorbell,
  serveUntilExcursion,
  step,
  topUp,
  type LoopContext,
} from "./loop.ts";
```

replace the header comment's

```ts
// Serves requests for good, leaving the synchronous section only to top the
// pool up or for an instrument's reply. Fails once the runtime or the relay
// stops.
```

with

```ts
// Serves requests for good, leaving the synchronous section only to top the
// pool up, to take the page's messages, or for an instrument's reply. Fails
// once the runtime or the relay stops.
```

add `mailTaken: 0,` after `woken: false,` in `ctx`; replace everything from the comment `// The only asynchronous excursion: the new Workers load only while this` through the end of `topUpPool` with

```ts
  // Serves and pumps from the event loop as the host would asleep, waiting
  // for requests with Atomics.waitAsync() raced against settled, until done
  // says the excursion's work has finished, or the host stops.
  const serveUntil = (settled: Promise<unknown>, done: () => boolean) =>
    Effect.gen(function* () {
      while (!done()) {
        const next = yield* guarded(() => step(ctx));
        if (next.kind === "served") continue;
        if (next.kind === "await") {
          yield* answer(next.reply);
          continue;
        }
        if (next.kind === "stopped") return "stopped" as const;
        if (next.kind === "relayFailed") return yield* relayFailed;

        const woke = Atomics.waitAsync(
          handle.words,
          wakeIndex,
          next.seen,
          next.delay < 0 ? Infinity : next.delay,
        ).value;
        const value =
          typeof woke === "string" ? woke : yield* Effect.promise(() => Promise.race([woke, settled.then(() => "")]));
        ctx.woken = value === "ok";
      }
      return "done" as const;
    });

  // The new Workers load only while this thread's event loop runs.
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

      if ((yield* serveUntil(loaded, () => outcome !== undefined)) === "stopped") return;
      if (outcome === undefined) return;
      if ("error" in outcome) {
        ctx.topUpFailed = true;
        yield* Effect.logError(errorReport(outcome.error));
      } else instruments.toppedUp(want, outcome.ms, outcome.createMs);
    });

  // The page's messages arrive only through the event loop. The host takes
  // each as it arrives, as many as the mail word counts, and prepares its
  // engine at once, beside any other prepare still running, while it serves
  // requests as it would asleep; it goes back to its synchronous section
  // once every prepare has ended and no message is waiting. A call into the
  // runtime that threw while installing stops the host.
  const takeMail = Effect.gen(function* () {
    instruments.eventLoopTurn();
    let outcome: { error: unknown } | "done" | undefined;
    const taking = (async () => {
      const running = new Set<Promise<void>>();
      while (mailWaiting(ctx) || running.size > 0) {
        if (mailWaiting(ctx) && worker.mail.waiting) {
          const message = await worker.mail.next();
          ctx.mailTaken = (ctx.mailTaken + 1) | 0;
          if (message === undefined) continue;
          const preparing: Promise<void> = storage.prepare(message.engine).finally(() => running.delete(preparing));
          running.add(preparing);
        } else await Promise.race([...running, worker.mail.arrival()]);
      }
    })().then(
      () => {
        outcome = "done";
      },
      (error: unknown) => {
        outcome = { error };
      },
    );

    if ((yield* serveUntil(taking, () => outcome !== undefined)) === "stopped") return;
    const failed = outcome;
    if (failed !== undefined && failed !== "done")
      yield* guarded(() => {
        throw failed.error;
      });
  });
```

and in the final `switch`, after the `topUp` case, add

```ts
      case "mail":
        yield* takeMail;
        break;
```

Regenerate the protocol's document:

```bash
nix develop -c git add packages/worker-host
nix run .#write-files
git diff --stat packages/protocol/PROTOCOL.md
```

Expected: `PROTOCOL.md` changes by one line, the transport table's row `| 11 | \`mail\` | page | Messages posted to the host after HostInit, … |`.

- [ ] **Step 4: Run them to see them pass, and the browsers**

```bash
nix develop -c git add packages/protocol/PROTOCOL.md
nix build .#checks.x86_64-linux.protocol-node .#checks.x86_64-linux.worker-host-node '.#checks.x86_64-linux."files:packages/protocol/PROTOCOL.md"' -L
nix build .#worker-host-node-integration .#worker-host-browser-integration .#checks.x86_64-linux.worker-host-browser -L
```

Expected: PASS. Under Node, the 18 `prepare-*` cases (nine on each runtime) among the rest; `prepare-window-shut` records `{"afterFailure":1,"afterInstall":1}` (the Node backend refuses nothing). In Chromium and Firefox, the 20 `prepare-*` cases (ten on each runtime) among the rest: `prepare-window-shut` recording `-69`, `EROFS`, for both writes; `prepare-concurrent` the two installs holding their locks over the same 250–300 ms (`pieceDelayMs` 20 slows each archive's 12 pieces) and the window opening once and shutting once; `prepare-shared` one fetch of the shared archive; `prepare-race` the second host taking the path's lock 0–1 ms after the first let go. Run `prepare-concurrent` and `prepare-shared` repeatedly before trusting them: the spike ran them twelve times in a row in both browsers on both runtimes (96 runs) without a failure.

- [ ] **Step 5: Document it**

In `docs/storage.md`, section "C API", end the `wasmfs_idb_backend_set_writable` bullet's last sentence with `, as the host does with its install locks ([below](#an-engines-own-data)).` in place of its full stop. In section "Engine data: a database per version", replace its opening paragraph's

```markdown
other file. The protocol lives in `packages/worker-host/src/worker/install/`.
```

with

```markdown
other file. The archives an engine's descriptor names in its `data` are that engine's own, installed when a page first
prepares the engine ([below](#an-engines-own-data)); the rest are the version's base data, installed at start. The
protocol lives in `packages/worker-host/src/worker/install/`.
```

and add, before `### Old versions`:

```markdown
### An engine's own data

An engine's descriptor may name store paths of the module's data as its own (`data`,
[engines.md](engines.md#an-engines-own-data)). They are installed into the version's database, beside its base data,
when a page first prepares the engine: `PrepareEngine` ([worker-host.md](worker-host.md#messages)), which the page sends
before the engine's first `CreateEngine` in a Worker. A host prepares several engines at once.

1. The host reads each of the engine's paths' markers, `meta.paths/<storePath>` = `{ files, bytes }`, on a short
   connection of its own; a path with one is there, since its marker is written last.
2. For each path without one it joins the install of that path already running in this Worker, if there is one, so
   that two engines sharing a path fetch it once; otherwise it starts one. An install takes the path's own install lock,
   `ibus-web:install:<name>:<version>:<storePath>` (encoded as the other names), and says it is still going on the lock's
   channel while it holds it, so that a host waiting on the path waits rather than gives up. Under the lock it reads the
   marker again, since another host may have installed the path meanwhile; if it is still missing, it extracts the
   path's archive at the store's root with the checks of any archive (its own `size` limit, entries confined to its
   store path) and writes the marker in a strict transaction, last.
3. It posts `prepare-progress`, the bytes written of the engine's missing paths, a `path-install` for each path,
   `present` or `installed`, and `prepared`, with the reason if an install failed.

- **Installs run at once.** Different store paths install concurrently, in one Worker or several, each under its own
  lock: inodes come from `meta.nextIno` inside the one read-write transaction that makes an entry, which IndexedDB
  serializes against every other over the same stores, whatever the connection; entries are keyed by parent and name,
  chunks by inode and index; and each extraction has a handle of its own. The base install keeps the version's install
  lock, and no host prepares an engine before its version's base data is marked.
- **The window** is shared: it opens as the first extraction starts and shuts as the last ends. The data backend takes
  changes only while one runs. An engine thread in the same Worker could write to `/nix/store` while it is open; none
  does. This is weaker than the seal ([known gaps](known-gaps.md#storage)).
- **The host's own transactions.** An extraction's writes block the host's thread until the backend's transaction
  commits, and IndexedDB holds that transaction until every earlier one over the same stores has ended, the host's
  marker reads and writes on its own connection included, which end only in the host's event loop. So the installer
  waits, before each write, until the host has none of its own open.
- **An install cut short** leaves no marker for its path, and the next host to prepare the engine extracts the archive
  over what it left: the version and the store path name one archive, and the installer completes a tree an earlier run
  of the same archive left half-written. Nothing is removed first, so no host's WasmFS cache is left holding an entry
  another host deleted.
- **Hosts that mounted the version first** find a path another host installed by lookup, since WasmFS keeps no entry's
  absence ([above](#how-it-plugs-into-wasmfs)); preparing the engine then finds its marker and installs nothing.
- **Memory mounts.** Without IndexedDB the data lives in the runtime's memory, which is sized at start and can't grow, so
  such a host installs every archive at start, sized as now, and a prepare finds nothing to do.

The scenarios run under Node and in both browsers, on the asserting and the released runtime: a lazy install, a marker
already present, two engines' paths installing at once with the window opened once, two engines sharing a path with one
fetch, two hosts racing for one path (browsers only), a path another host installed after this one mounted, an install
killed mid-path, the window shut after an install and after a failed one, a memory mount installing everything at
start, and a distribution `mkEngineManifest` built with an engine's own data.
```

In section "Node hosts", replace

```markdown
  that doesn't parse counts as absent; removal deletes the marker first, so a removal cut short leaves no marker.
  Collection lists versions from directories, markers and stray `.marking` files alike.
```

with

```markdown
  that doesn't parse counts as absent; removal deletes the markers first, so a removal cut short leaves none. A store
  path of an engine's own data has its marker in `<version>.paths/`, `<hash>-<name>.installed`, written the same way.
  Collection lists versions from directories, markers, `.paths` directories and stray `.marking` files alike.
```

In `docs/worker-host.md`:

- in "Package and bundles", in the `@ibus-web/worker-host` row, replace `` (`createControl`, `postRequest`, `takeReply`) `` with `` (`createControl`, `postRequest`, `takeReply`, `postMail`) ``;
- under `## Messages`, before `` `HostMessage`, every message the host posts: `` add

  ```markdown
  After `HostInit` the page posts one kind of message, `PrepareEngine` (`{ type: "prepare-engine", engine }`): install the
  engine's own data, where the version's storage lacks it, before the engine is first made
  ([storage.md](storage.md#an-engines-own-data)). It travels outside the request slot and the ring, so requests and keys
  go on while it installs. A host asleep in the runtime runs no event loop to hear it, so the page counts each message in
  the control buffer's `mail` word too, with `postMail()`, which bumps `mail` and `wake`: the host wakes, sees `mail`
  changed and goes to its event loop to take the messages. The host answers each with `prepared`.

  ```

  and add three rows to the table after `collect`:

  ```markdown
  | `prepare-progress` | While a `PrepareEngine` installs: `engine`, `bytes` of file data written and `total`, the size of the engine's store paths the storage lacked; the last has `bytes` equal to `total`. |
  | `path-install`     | One store path of the engine's own data: `engine`, `storePath`, `installed` or `present`, with its marker's `files` and `bytes`, `installMs`, and its install lock's `lockWaitMs`, `lockedAt` and `releasedAt` (0 when its marker was there before the lock). |
  | `prepared`         | The end of a `PrepareEngine`: `engine`, and `error` if an install failed. A failure leaves the host serving. |
  ```

- in "The request loop", replace step 1's first sentence with `` 1. If the control buffer's `mail` word differs from the messages taken, leave the section to take them (below). Read the wake word, then `state`. ``, keeping the rest of the step;
- replace

  ```markdown
  ### The pool top-up

  The top-up is the loop's only asynchronous excursion, and it runs only while no request is pending.
  ```

  with

  ```markdown
  ### Excursions

  The loop leaves its synchronous section for two kinds of work that need the event loop: topping the pool up, and the
  page's messages. In both the host serves and pumps as it would asleep, but waits with `Atomics.waitAsync()` on the wake
  word, raced against the work, and returns to the section once the work is done.

  **The page's messages.** The host takes each as it arrives, as many as `mail` counts, and prepares its engine at once,
  beside the prepares still running: each of the engine's store paths that lacks a marker is installed under a lock of
  its own, one install serving every engine that needs the path, posting `prepare-progress` and a `path-install` for
  each path, then `prepared` (`src/worker/install/prepare.ts`). It returns to its section once every prepare has ended
  and no message waits. The loop checks `mail` only after reading the wake word, so a message posted after the check has
  moved the word the host then sleeps on. Requests are served between the installs' steps, so the keys of the engines
  already made go on. A call into the runtime that throws while installing stops the host as any trap does; every other
  failure is the install's, reported in `prepared.error`.

  ### The pool top-up

  The top-up runs only while no request is pending.
  ```

  and in the top-up's list replace

  ```markdown
  - Meanwhile the host serves and pumps as it would asleep, but waits with `Atomics.waitAsync()` on the wake word, raced
    against the loads.
  ```

  with

  ```markdown
  - Meanwhile the host serves and pumps as it would asleep (above), its waits raced against the loads.
  ```

- in "Storage and engine data in the host", after the **Install** bullet, add

  ```markdown
  - **Prepare** (`prepare.ts`): each of the engine's store paths' markers read, and each path without one installed under
    its own install lock and progress channel, joining an install of it already running in this Worker; the window,
    shared by overlapping extractions, open while any runs.
  ```

- in "Tests", add a row before `Engine data`:

  ```markdown
  | An engine's own data      | `prepare-fresh`, `prepare-skip`, `prepare-concurrent`, `prepare-shared`, `prepare-race`, `prepare-after-mount`, `prepare-interrupted`, `prepare-window-shut`, `prepared-distribution`, `prepared-in-memory` | all; `prepare-race` in browsers; the window's refusals only recorded under Node |
  ```

In `docs/engines.md`, add before `### Archives and serving`:

```markdown
### An engine's own data

A store path any engine names in its descriptor's `data` is that engine's own: the host installs it the first time a
page prepares the engine, before its first `CreateEngine` in a Worker, rather than at start
([storage.md](storage.md#an-engines-own-data)). The rest of the closure is the module's base data, installed at start.
`lazyStorePaths(manifest)` in `@ibus-web/protocol` gives the former. Per-engine data suits large, optional data that an
engine alone uses, such as Rime's dictionaries, of which a user downloads only those of the schemas they type in. Data
every engine reads, or that the module reads as it starts, stays base data: m17n keeps its whole closure there, since
it is 1.5 MB as Brotli and ibus-m17n reads every input method's file as it lists them at startup. A store path several
engines name is installed once, by whichever is prepared first.

```

In `docs/known-gaps.md`, section "Storage", add before `- **Real quota failures**`:

```markdown
- **The install window is weaker than the seal.** While a host installs an engine's own data, its data backend takes
  changes from any thread of its runtime, an engine's included. None writes there, and the window lasts as long as
  extractions overlap.
- **A failed install of an engine's own data leaves its partial tree** in the version's database until the next prepare
  extracts the archive over it; its bytes are counted nowhere meanwhile.
- **A memory mount installs every engine's own data at start**, since its memory can't grow: without IndexedDB a page
  downloads the data of engines it never selects.
```

Then:

```bash
nix develop -c oxfmt docs/storage.md docs/worker-host.md docs/engines.md docs/known-gaps.md
nix develop -c hk check -S links
```

Expected: oxfmt pads the tables; the link check passes, `#an-engines-own-data` resolving in both pages.

- [ ] **Step 6: Commit**

```bash
nix develop -c git add packages/protocol packages/worker-host docs/storage.md docs/worker-host.md docs/engines.md docs/known-gaps.md
nix develop -c git commit -m "feat(worker-host): install an engine's own data when the page prepares it" -- packages/protocol/src/transport/layout.ts packages/protocol/PROTOCOL.md packages/worker-host/src packages/worker-host/module.nix packages/worker-host/test docs/storage.md docs/worker-host.md docs/engines.md docs/known-gaps.md
```

---

### Task 7: The page's connection posts `PrepareEngine`

**Files:**
- Modify: `packages/core/src/connection/connection.ts`, `packages/core/src/router/keystroke.ts`, `packages/core/src/page/index.ts`
- Modify (tests): `packages/core/test/node/support/fake-worker.ts`, `packages/core/test/node/connection/connection.test.ts`, `packages/core/test/shared/router.ts`

**Interfaces:**
- Consumes: `postMail`, `PrepareEngine` and the `prepare-progress` and `prepared` messages (Task 6).
- Produces: `Connection.prepare(engine: string, progress?: PrepareProgress): Promise<void>`; `class PrepareFailed extends Error`; `type PrepareProgress = (bytes: number, total: number) => void`, both exported from `@ibus-web/core`; `KeyConnection` includes `prepare`; `FakeConnection.prepare`, `.prepared` and `.prepareWith` for core's tests.

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/node/support/fake-worker.ts`, add `type PrepareEngine,` to the `@ibus-web/worker-host` import; add to `FakeWorker`, after `requests`,

```ts
  // The engines the page has posted PrepareEngine for, and the mail word as it read after each.
  prepares: { engine: string; mail: number }[] = [];
```

and replace

```ts
  postMessage(init: HostInit) {
    this.init = init;
```

with

```ts
  postMessage(message: HostInit | PrepareEngine) {
    if ("type" in message) {
      // The page bumps the mail word only once the message is posted.
      queueMicrotask(() =>
        this.prepares.push({ engine: message.engine, mail: Atomics.load(this.views.words, Word.mail) }),
      );
      return;
    }
    const init = message;
    this.init = init;
```

In `packages/core/test/node/connection/connection.test.ts`, change the connection import to

```ts
import { Connection, PrepareFailed, type ConnectionOptions } from "../../../src/connection/connection.ts";
```

and add before `describe("crashes and hangs", () => {`:

```ts
describe("preparing an engine", () => {
  test("posts PrepareEngine outside the request slot, counts it in the mail word and hears its progress", async () => {
    const connection = await start();
    const progress: [number, number][] = [];
    const prepared = connection.prepare("lazy", (bytes, total) => progress.push([bytes, total]));
    await Promise.resolve();
    expect(host.prepares).toEqual([{ engine: "lazy", mail: 1 }]);
    expect(Atomics.load(host.views.words, Word.state)).toBe(State.idle);
    expect(connection.busy).toBe(false);
    host.message({ type: "prepare-progress", engine: "lazy", bytes: 0, total: 10 });
    host.message({ type: "prepare-progress", engine: "other", bytes: 5, total: 5 });
    host.message({ type: "prepare-progress", engine: "lazy", bytes: 10, total: 10 });
    host.message({ type: "prepared", engine: "lazy" });
    await expect(prepared).resolves.toBeUndefined();
    expect(progress).toEqual([
      [0, 10],
      [10, 10],
    ]);
  });
  test("answers each engine's prepares in the order they were posted", async () => {
    const connection = await start();
    const first = connection.prepare("lazy");
    const second = connection.prepare("lazy");
    const other = connection.prepare("other");
    host.message({ type: "prepared", engine: "other" });
    host.message({ type: "prepared", engine: "lazy", error: "no space" });
    host.message({ type: "prepared", engine: "lazy" });
    await expect(other).resolves.toBeUndefined();
    await expect(first).rejects.toEqual(new PrepareFailed("no space"));
    await expect(second).resolves.toBeUndefined();
  });
  test("a crash rejects the prepares it cut short, and later ones at once", async () => {
    const connection = await start();
    const pending = connection.prepare("lazy");
    host.message({ type: "crashed", message: "trap" });
    await expect(pending).rejects.toMatchObject({ reason: "host", message: "trap" });
    await expect(connection.prepare("lazy")).rejects.toMatchObject({ reason: "host" });
  });
});
```

In `packages/core/test/shared/router.ts`, change the connection import to

```ts
import type { Reply, SyncOutcome, CrashInfo, PrepareProgress } from "../../src/connection/connection.ts";
```

and add to `FakeConnection`, after `polls = 0;`:

```ts
  // The engines prepared, in order; prepareWith answers each.
  prepared: string[] = [];
  prepareWith: (engine: string, progress: PrepareProgress | undefined) => Promise<void> = async () => {};
  prepare(engine: string, progress?: PrepareProgress): Promise<void> {
    this.prepared.push(engine);
    return this.prepareWith(engine, progress);
  }
```

- [ ] **Step 2: Run them to see them fail**

```bash
nix develop -c git add packages/core/test
nix build .#checks.x86_64-linux.core-node -L
```

Expected: FAIL in `preparing an engine`: `connection.prepare is not a function`, and the import of `PrepareFailed` is undefined.

- [ ] **Step 3: Add `prepare` to the connection**

In `packages/core/src/connection/connection.ts`, add `postMail,` after `controlViews,` and `type PrepareEngine,` after `type ControlViews,` in the `@ibus-web/worker-host` import; before `export type SyncOutcome =` add

```ts
/** The host couldn't install an engine's own data; the message is the host's reason. */
export class PrepareFailed extends Error {}
/** Hears the bytes of an engine's own data written so far, of the total the host's storage lacked. */
export type PrepareProgress = (bytes: number, total: number) => void;
interface PendingPrepare {
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
  readonly progress: PrepareProgress | undefined;
}
```

in `class Connection`, after `private readonly queue: QueuedRequest[] = [];`,

```ts
  // By engine, in the order they were posted: the host answers each engine's in turn.
  private readonly preparing = new Map<string, PendingPrepare[]>();
```

before the doc comment of `poll()` (`Settle an asynchronous request whose reply is already in shared memory,`),

```ts
  /**
   * Has the host install the engine's own data, where its storage lacks it, before the engine is first made.
   * Outside the request slot, so keys and requests go on meanwhile. Rejects with PrepareFailed for the host's
   * reason, or with the connection's crash.
   */
  prepare(engine: string, progress?: PrepareProgress): Promise<void> {
    if (this.crash) return Promise.reject(this.crash);
    return new Promise((resolve, reject) => {
      const pending = this.preparing.get(engine) ?? [];
      pending.push({ resolve, reject, progress });
      this.preparing.set(engine, pending);
      try {
        this.worker.postMessage({ type: "prepare-engine", engine } satisfies PrepareEngine);
        postMail(this.control);
      } catch (error) {
        this.fail({ reason: "worker", message: String(error) });
      }
    });
  }
```

in `message`'s `switch`, after the `doorbell` case,

```ts
      case "prepare-progress":
        for (const pending of this.preparing.get(message.engine) ?? [])
          pending.progress?.(message.bytes, message.total);
        break;
      case "prepared": {
        const pending = this.preparing.get(message.engine)?.shift();
        if (this.preparing.get(message.engine)?.length === 0) this.preparing.delete(message.engine);
        if (message.error === undefined) pending?.resolve();
        else pending?.reject(new PrepareFailed(message.error));
        break;
      }
```

and in `fail`, after `for (const pending of this.queue.splice(0)) pending.reject(crash);`,

```ts
    for (const pending of [...this.preparing.values()].flat()) pending.reject(crash);
    this.preparing.clear();
```

In `packages/core/src/router/keystroke.ts`, add `"prepare"` to `KeyConnection`'s `Pick`:

```ts
  "busy" | "requestSync" | "requestAsync" | "onDoorbell" | "onCrash" | "records" | "replies" | "terminate" | "prepare"
```

In `packages/core/src/page/index.ts`, export `PrepareFailed` after `ConnectionBusyError` and `type PrepareProgress` after `type ConnectionOptions` from `../connection/connection.ts`.

- [ ] **Step 4: Run them to see them pass**

```bash
nix develop -c git add packages/core
nix build .#checks.x86_64-linux.core-node -L
```

Expected: PASS, the three `preparing an engine` cases among the rest.

- [ ] **Step 5: Commit**

```bash
nix develop -c git commit -m "feat(core): a connection posts PrepareEngine and hears its progress" -- packages/core/src/connection/connection.ts packages/core/src/router/keystroke.ts packages/core/src/page/index.ts packages/core/test/node/support/fake-worker.ts packages/core/test/node/connection/connection.test.ts packages/core/test/shared/router.ts
```

---

### Task 8: The registry prepares an engine, and the router makes it once its data is there

**Files:**
- Modify: `packages/core/src/services/modules.ts`, `packages/core/src/router/router.ts`, `packages/core/src/page/index.ts`
- Modify (tests): `packages/core/test/node/router/services.test.ts`, `packages/core/test/browser/support/dom.ts`, `packages/core/test/browser/router/switching.test.ts`
- Docs: `docs/core.md`

**Interfaces:**
- Consumes: `Connection.prepare`, `PrepareFailed` (Task 7); `EngineDescriptor.data` (Task 4).
- Produces: `ModuleRegistryService.prepare(name: string, engine: string): Effect.Effect<void, Error>` and `isPrepared(name: string, engine: string): boolean`; `ModuleEvent` `{ _tag: "install"; module; engine; bytes; total }`; `class PrepareEngineError extends Error { _tag: "PrepareEngineError"; module; engine; reason }`, exported from `@ibus-web/core`; a router whose `select` waits for an engine's data outside its mailbox and whose `reconcile` starts the download in the background, the surface on native input meanwhile.

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/node/router/services.test.ts`, replace the import of `makeModuleRegistry` with

```ts
import { makeModuleRegistry, PrepareEngineError } from "../../../src/services/modules.ts";
import { PrepareFailed } from "../../../src/connection/connection.ts";
```

and append:

```ts

it.effect(
  "registry prepares an engine's own data once per Worker, reports its progress, and tries a failed install again",
  () =>
    Effect.gen(function* () {
      const lazyPath = `/nix/store/${"b".repeat(32)}-lazy`;
      const lazy: ModuleManifest = {
        ...manifest,
        data: [...manifest.data, { storePath: lazyPath, url: "lazy.tar", size: 10, encoding: "identity" }],
        engines: [...manifest.engines, { ...manifest.engines[0]!, name: "lazy", data: [lazyPath] }],
      };
      const started: FakeConnection[] = [];
      const restarted = yield* Deferred.make<void>();
      let failures = 1;
      const registry = yield* makeModuleRegistry({
        hostUrl: url,
        runtimeUrl: url,
        modules: { test: url },
        loadManifest: async () => lazy,
        loadMetadata: async () => metadata,
        waitForWriter: () => Effect.void,
        start: async () => {
          const connection = new FakeConnection();
          connection.requestAsync = async () => emptyReply;
          connection.prepareWith = async (_, progress) => {
            progress?.(4, 10);
            if (failures-- > 0) throw new PrepareFailed("no space left");
            progress?.(10, 10);
          };
          started.push(connection);
          if (started.length === 2) Deferred.doneUnsafe(restarted, Effect.void);
          return connection;
        },
      });
      const installs = yield* registry.events.pipe(
        Stream.filter((event) => event._tag === "install"),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* registry.prepare("test", "test");
      expect(started, "Workers started for an engine without data of its own").toHaveLength(0);
      expect(registry.isPrepared("test", "test"), "an engine without data of its own").toBe(true);
      expect((yield* Effect.flip(registry.prepare("test", "missing"))).message).toBe(
        "Unknown engine: missing in module test",
      );

      const failed = yield* Effect.flip(registry.prepare("test", "lazy"));
      expect(failed).toBeInstanceOf(PrepareEngineError);
      expect(failed).toMatchObject({ module: "test", engine: "lazy", reason: "no space left" });
      expect(registry.snapshot("test")!.enabled, "a module prepared but not selected").toBe(false);
      expect(registry.isPrepared("test", "lazy"), "after a failed install").toBe(false);
      yield* registry.prepare("test", "lazy");
      expect(registry.isPrepared("test", "lazy"), "once installed").toBe(true);
      yield* registry.prepare("test", "lazy");
      expect(started[0]!.prepared).toEqual(["lazy", "lazy"]);

      started[0]!.crash({ reason: "worker", message: "stop" });
      yield* Deferred.await(restarted);
      yield* registry.whenReady("test");
      expect(registry.isPrepared("test", "lazy"), "in the restarted Worker").toBe(false);
      yield* registry.prepare("test", "lazy");
      expect(started[1]!.prepared, "the restarted Worker's").toEqual(["lazy"]);
      expect([...(yield* Fiber.join(installs))].map(({ bytes, total }) => [bytes, total])).toEqual([
        [4, 10],
        [4, 10],
        [10, 10],
        [4, 10],
        [10, 10],
      ]);
    }).pipe(Effect.provide(services)),
);
```

In `packages/core/test/browser/support/dom.ts`, give the fixture manifest a store path and an engine of its own; replace

```ts
  data: [{ storePath: `/nix/store/${"a".repeat(32)}-test`, url: "data.tar", size: 0, encoding: "identity" }],
  settingsSchemaDir: `/nix/store/${"a".repeat(32)}-test/schemas`,
  // The second engine passes `a` through, so a test can tell whose keyboard policy applies.
  engines: [
    { name: "factory", displayName: "Factory", languages: [], keyboard: { layout: "us", passThrough: [] } },
    { name: "other", displayName: "Other", languages: [], keyboard: { layout: "us", passThrough: ["a"] } },
  ],
```

with

```ts
  data: [
    { storePath: `/nix/store/${"a".repeat(32)}-test`, url: "data.tar", size: 0, encoding: "identity" },
    { storePath: `/nix/store/${"b".repeat(32)}-lazy`, url: "lazy.tar", size: 0, encoding: "identity" },
  ],
  settingsSchemaDir: `/nix/store/${"a".repeat(32)}-test/schemas`,
  // The second engine passes `a` through, so a test can tell whose keyboard policy applies; the third has data of
  // its own.
  engines: [
    { name: "factory", displayName: "Factory", languages: [], keyboard: { layout: "us", passThrough: [] } },
    { name: "other", displayName: "Other", languages: [], keyboard: { layout: "us", passThrough: ["a"] } },
    {
      name: "lazy",
      displayName: "Lazy",
      languages: [],
      keyboard: { layout: "us", passThrough: [] },
      data: [`/nix/store/${"b".repeat(32)}-lazy`],
    },
  ],
```

In `packages/core/test/browser/router/switching.test.ts`, add after the `effect` import

```ts
import type { CreateEngine } from "@ibus-web/protocol";
import { PrepareFailed } from "../../../src/connection/connection.ts";
```

and append:

```ts
test("selecting an engine with data of its own prepares it before creating it, once per Worker", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    let installed!: () => void;
    a.prepareWith = () =>
      new Promise((resolve) => {
        installed = resolve;
      });
    const selected = Effect.runPromise(router.select("a", "lazy"));
    await expect.poll(() => a.prepared).toEqual(["lazy"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      a.sent.filter((x) => x.request._tag === "CreateEngine").map((x) => (x.request as CreateEngine).name),
    ).toEqual(["factory"]);
    installed();
    await selected;
    expect(
      a.sent.filter((x) => x.request._tag === "CreateEngine").map((x) => (x.request as CreateEngine).name),
    ).toEqual(["factory", "lazy"]);
    await select(router, "a");
    await Effect.runPromise(router.select("a", "lazy"));
    expect(a.prepared).toEqual(["lazy"]);
  }));
test("a failed install fails the selection with the reason; the selection stands, and the next focus tries again", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    a.prepareWith = async () => {
      throw new PrepareFailed("fetch ./lazy.tar: 404");
    };
    await expect(Effect.runPromise(router.select("a", "lazy"))).rejects.toMatchObject({
      _tag: "PrepareEngineError",
      module: "a",
      engine: "lazy",
      reason: "fetch ./lazy.tar: 404",
    });
    expect(router.selection).toEqual({ module: "a", engine: "lazy" });
    expect(key(f.element).defaultPrevented).toBe(false);
    a.prepareWith = async () => {};
    f.element.blur();
    f.element.focus();
    await expect.poll(() => a.sent.filter((x) => x.request._tag === "CreateEngine").length).toBe(2);
    expect(a.prepared).toEqual(["lazy", "lazy"]);
  }));
test("an engine's download holds up no other work: other selections and focus changes go on, and a superseded selection makes nothing", () =>
  run(async ({ router, registry, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    let installed!: () => void;
    a.prepareWith = () =>
      new Promise((resolve) => {
        installed = resolve;
      });
    const pending = Effect.runPromise(router.select("a", "lazy"));
    await expect.poll(() => a.prepared).toEqual(["lazy"]);
    expect(router.selection, "the selection, reported at once").toEqual({ module: "a", engine: "lazy" });
    expect(key(f.element).defaultPrevented, "native input while the engine downloads").toBe(false);

    await select(router, "b");
    const g = field();
    g.element.focus();
    const b = connections.b[0]!;
    await expect.poll(() => b.sent.filter((x) => x.request._tag === "CreateEngine").map((x) => x.ic)).toEqual([1, 2]);

    installed();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      a.sent.filter((x) => x.request._tag === "CreateEngine").map((x) => (x.request as CreateEngine).name),
      "engines made in module a",
    ).toEqual(["factory"]);
    expect(registry.isPrepared("a", "lazy"), "the data, installed all the same").toBe(true);
  }));
test("a deselect while an engine downloads goes on at once; selecting the engine again makes it without a second install", () =>
  run(async ({ router, connections, field }) => {
    const f = field();
    f.element.focus();
    await select(router);
    const a = connections.a[0]!;
    let installed!: () => void;
    a.prepareWith = () =>
      new Promise((resolve) => {
        installed = resolve;
      });
    const pending = Effect.runPromise(router.select("a", "lazy"));
    await expect.poll(() => a.prepared).toEqual(["lazy"]);
    await Effect.runPromise(router.deselect());
    expect(router.selection).toBeUndefined();
    installed();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.sent.filter((x) => x.request._tag === "CreateEngine")).toHaveLength(1);
    await Effect.runPromise(router.select("a", "lazy"));
    expect(
      a.sent.filter((x) => x.request._tag === "CreateEngine").map((x) => (x.request as CreateEngine).name),
    ).toEqual(["factory", "lazy"]);
    expect(a.prepared).toEqual(["lazy"]);
  }));
```

- [ ] **Step 2: Run them to see them fail**

```bash
nix develop -c git add packages/core/test
nix build .#checks.x86_64-linux.core-node .#checks.x86_64-linux.core-browser -L
```

Expected: FAIL. Under Node, `registry.prepare is not a function`. In Chromium and Firefox, the first new switching test creates `lazy` without waiting (`expected [ 'factory', 'lazy' ] to deeply equal [ 'factory' ]`), the second resolves the selection instead of rejecting it, and the last two fail on `registry.isPrepared` and on `lazy` being made for a selection that moved on.

- [ ] **Step 3: Prepare in the registry and the router**

In `packages/core/src/services/modules.ts`, replace the connection import with

```ts
import {
  Connection,
  PrepareFailed,
  type ConnectionOptions,
  type CrashInfo,
  type Reply,
} from "../connection/connection.ts";
```

replace `ModuleEvent` with

```ts
export type ModuleEvent =
  | { readonly _tag: "state"; readonly module: string; readonly state: ModuleState }
  | { readonly _tag: "storage"; readonly module: string; readonly state: StorageState; readonly message: string }
  /** While an engine's own data installs: bytes written so far of total, what the module's storage lacked. */
  | {
      readonly _tag: "install";
      readonly module: string;
      readonly engine: string;
      readonly bytes: number;
      readonly total: number;
    };
/** An engine's own data failed to install; `reason` is the Worker's. */
export class PrepareEngineError extends Error {
  readonly _tag = "PrepareEngineError";
  readonly module: string;
  readonly engine: string;
  readonly reason: string;

  constructor(module: string, engine: string, reason: string) {
    super(`Engine ${engine} of module ${module} could not be prepared: ${reason}`);
    this.module = module;
    this.engine = engine;
    this.reason = reason;
  }
}
```

add to `ModuleRegistryService`, after `engines`,

```ts
  /**
   * Installs the engine's own data in the module's Worker, starting it if need be, once per Worker; an engine with no
   * data of its own needs nothing. Fails with PrepareEngineError for the Worker's reason.
   */
  prepare(name: string, engine: string): Effect.Effect<void, Error>;
```

replace the head of `ensure`,

```ts
    const ensure = (name: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        if (!entries.has(name)) return yield* Effect.fail(new Error(`Unknown module: ${name}`));
        const entry = get(name);
        entry.snapshot.enabled = true;
        if (!entry.started) {
```

with

```ts
    // Starts the module's Worker, if it hasn't, and waits until it is ready.
    const start = (name: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const entry = get(name);
        if (!entry.started) {
```

and after that function's end (`yield* whenReady(name);` and `});`) add

```ts
    const ensure = (name: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        if (!entries.has(name)) return yield* Effect.fail(new Error(`Unknown module: ${name}`));
        get(name).snapshot.enabled = true;
        yield* start(name);
      });
    // By connection, so that a restarted Worker prepares again; a failed install is forgotten, to be tried again.
    const prepared = new WeakMap<KeyConnection, Map<string, Promise<void>>>();
    const installed = new WeakMap<KeyConnection, Set<string>>();
    const prepare = (name: string, engine: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const entry = entries.get(name);
        if (!entry) return yield* Effect.fail(new Error(`Unknown module: ${name}`));
        const manifest = yield* manifestOf(name, entry);
        const descriptor = manifest.engines.find((candidate) => candidate.name === engine);
        if (!descriptor) return yield* Effect.fail(new Error(`Unknown engine: ${engine} in module ${name}`));
        if ((descriptor.data ?? []).length === 0) return;
        yield* start(name);
        const connection = entry.snapshot.connection;
        if (!connection) return yield* Effect.fail(new Error(`Module ${name} is not ready`));

        let engines = prepared.get(connection);
        if (!engines) {
          engines = new Map();
          prepared.set(connection, engines);
        }
        let pending = engines.get(engine);
        if (!pending) {
          const installing = connection.prepare(engine, (bytes, total) =>
            events.enqueue({ _tag: "install", module: name, engine, bytes, total }),
          );
          const byEngine = engines;
          installing.then(
            () => {
              const done = installed.get(connection) ?? new Set<string>();
              installed.set(connection, done.add(engine));
            },
            () => {
              if (byEngine.get(engine) === installing) byEngine.delete(engine);
            },
          );
          engines.set(engine, installing);
          pending = installing;
        }
        const waiting = pending;
        yield* Effect.tryPromise({
          try: () => waiting,
          catch: (cause) =>
            cause instanceof PrepareFailed ? new PrepareEngineError(name, engine, cause.message) : asError(cause),
        });
      });
```

add to `ModuleRegistryService`, after `prepare`,

```ts
  /** Whether the engine can be made in the module's Worker as it is: it has no data of its own, or the Worker has it. */
  isPrepared(name: string, engine: string): boolean;
```

and to `service`, after `ensure,`:

```ts
      prepare,
      isPrepared: (name, engine) => {
        const snapshot = entries.get(name)?.snapshot;
        const descriptor = snapshot?.manifest?.engines.find((candidate) => candidate.name === engine);
        if (descriptor === undefined) return false;
        if ((descriptor.data ?? []).length === 0) return true;
        return snapshot!.connection !== undefined && (installed.get(snapshot!.connection)?.has(engine) ?? false);
      },
```

In `packages/core/src/router/router.ts`, replace the `effect` import with `import { Context, Effect, Exit, Layer, PubSub, Scope, Stream } from "effect";` and import `{ ModuleRegistry, PrepareEngineError } from "../services/modules.ts"`; before `export class Router` add

```ts
// An engine that failed to start, its data or itself: the selection stands, and the surface stays on native input.
const engineFailed = (error: Error): error is CreateEngineError | PrepareEngineError =>
  error instanceof CreateEngineError || error instanceof PrepareEngineError;

```

in `makeRouter`, after `const panel = yield* PanelEvents;`, add `const scope = yield* Scope.Scope;`; in `reconcile`, replace

```ts
      if (!context.created) {
        const reply = yield* request(context, new CreateEngine({ name: context.engine }));
```

with

```ts
      if (!context.created) {
        // The surface stays on native input while the engine's own data
        // installs, and the mailbox goes on; the install's end comes back
        // through it.
        if (!registry.isPrepared(target.module, target.engine)) {
          yield* download(target);
          return;
        }
        const reply = yield* request(context, new CreateEngine({ name: context.engine }));
```

replace `reconcileAll` with

```ts
  // One surface's engine failing to start mustn't leave the others on the old selection.
  const reconcileAll = (which: (surface: Surface) => boolean = () => true) =>
    Effect.gen(function* () {
      const failures: (CreateEngineError | PrepareEngineError)[] = [];
      for (const surface of [...surfaces.values()].filter(which))
        yield* reconcile(surface).pipe(
          Effect.catch((error) =>
            engineFailed(error) ? Effect.sync(() => void failures.push(error)) : Effect.fail(error),
          ),
        );

      if (failures.length > 0) return yield* Effect.fail(failures[0]!);
    });
```

and after it add

```ts

  // Engines whose own data installs in the background, by module and engine. Once it ends, the surfaces that still
  // want the engine make it; a surface that has moved on leaves it installed. A failure reaches the mailbox's log only
  // if a surface still wants the engine, and its next focus tries again.
  const downloads = new Set<string>();
  const download = (target: Selection) =>
    Effect.suspend(() => {
      const key = `${target.module}\0${target.engine}`;
      if (downloads.has(key)) return Effect.void;
      downloads.add(key);
      return registry.prepare(target.module, target.engine).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            downloads.delete(key);
            if (closed) return;
            mailbox.enqueue(() =>
              Exit.isSuccess(exit)
                ? reconcileAll((surface) => wants(surface, target))
                : [...surfaces.values()].some((surface) => wants(surface, target))
                  ? exit
                  : Effect.void,
            );
          }),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });
```

replace `restore` and its comment with

```ts
  // A change that fails leaves the selection as it was, and the surfaces it suspended return to it. An engine that
  // failed to start is the exception: the change has applied and the selection stands, and the surfaces wanting the
  // engine stay on native input until their next focus tries again.
  const restore = (release: () => void, error: Error) =>
    Effect.gen(function* () {
      release();
      if (!engineFailed(error)) for (const surface of surfaces.values()) yield* Effect.ignore(reconcile(surface));
      return yield* Effect.fail(error);
    });
```

and in `select`, replace everything from `const start = Effect.gen(function* () {` to the end of the second `return submit(…)` (the read-waiting branch) with

```ts
        const start = Effect.gen(function* () {
          yield* registry.ensure(module);
          if (cancelled()) return yield* cancellation();
          yield* reconcileAll();
        });
        // The engine's own data installs outside the mailbox, focused surface or not, so that it is there by the
        // time one is; the selection then waits for it, and has the surfaces that still want the engine make it. A
        // selection superseded meanwhile resolves, the data staying installed.
        const settle = (target: Selection) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(registry.prepare(target.module, target.engine));
            if (!same(selected, target) || cancelled()) return;
            if (Exit.isFailure(exit)) return yield* exit;
            yield* submit(() => reconcileAll((surface) => wants(surface, target)));
          });

        if (snapshot.manifest) {
          const target = pick(snapshot.manifest.engines, module, engine);
          if (target instanceof Error) return Effect.fail(target);
          selections++;
          apply(target);
          return submit(() =>
            Effect.gen(function* () {
              if (cancelled()) return yield* cancellation();
              yield* start;
            }),
          ).pipe(Effect.andThen(settle(target)));
        }

        const call = ++selections;
        const release = hold({ increment: () => reading++, decrement: () => reading-- });
        for (const surface of surfaces.values()) if (surface.override === undefined) surface.suspended = true;
        let applied: Selection | undefined;
        return submit(() =>
          Effect.gen(function* () {
            if (cancelled()) return yield* cancellation();
            const target = yield* resolve(module, engine);
            if (cancelled()) return yield* cancellation();
            // A later selection owns the surfaces; booting this module would only hold up its turn in the mailbox.
            if (call !== selections) return;
            apply(target);
            applied = target;
            release();
            yield* start;
          }).pipe(
            Effect.catch((error) => restore(release, error)),
            Effect.ensuring(Effect.sync(release)),
          ),
        ).pipe(Effect.andThen(Effect.suspend(() => (applied === undefined ? Effect.void : settle(applied)))));
```

(the `}),` closing `select` follows unchanged). `selectionchange` reports the new selection at once, while the engine downloads, as it does while a module starts: `apply()` publishes it before any work is submitted.

In `packages/core/src/page/index.ts`, export `PrepareEngineError` after `ModuleRegistry` from `../services/modules.ts`.

- [ ] **Step 4: Run them to see them pass**

```bash
nix develop -c git add packages/core
nix build .#checks.x86_64-linux.core-node .#checks.x86_64-linux.core-browser -L
```

Expected: PASS: 181 under Node and 298 in Chromium and Firefox in the spike, the new cases among them, and every existing switching, override and restart case unchanged (their engines have no data of their own, so no prepare is posted).

- [ ] **Step 5: Document it**

In `docs/core.md`, section "Layers and page lifetime", before the paragraph `Creating a surface's engine can fail.`, add

```markdown
An engine whose descriptor names data of its own has it installed before it is first made in a Worker.
`registry.prepare(module, engine)` posts the Worker `PrepareEngine` once per Worker and engine, starting the Worker if it
hasn't, without selecting the module; an engine with no data of its own needs nothing, and `registry.isPrepared` says
whether an engine can be made as things are. While data installs, `registry.events` carries `install` events,
`{ module, engine, bytes, total }`, the last with `bytes` equal to `total`. The router never holds its mailbox for an
install: a surface that wants an engine whose data isn't there stays on native input, as while its module starts, and
starts the download in the background, and once it ends the surfaces that still want the engine make it. Focus changes,
detaches and other selections go on meanwhile. `router.select(module, engine)` reports the new selection at once,
through `selectionChanges`, and resolves once the engine is made; a selection changed or undone while its engine
downloads resolves at once with nothing made, and the download goes on and stays installed.

```

and at the end of that paragraph's first two sentences (after `otherwise its message names the reply.`) add

```markdown
Installing its data can fail too: `PrepareEngineError` carries the module, the engine and the Worker's `reason`, and is
treated as `CreateEngineError` is, and a failed install is tried again at the next prepare.
```

Then:

```bash
nix develop -c oxfmt docs/core.md
nix develop -c hk check -S links
```

- [ ] **Step 6: Commit**

```bash
nix develop -c git add packages/core docs/core.md
nix develop -c git commit -m "feat(core): prepare an engine's own data before creating it" -- packages/core/src/services/modules.ts packages/core/src/router/router.ts packages/core/src/page/index.ts packages/core/test/node/router/services.test.ts packages/core/test/browser/support/dom.ts packages/core/test/browser/router/switching.test.ts docs/core.md
```

---

### Task 9: The facade's `prepare` and `install`

**Files:**
- Modify: `packages/ibus-web/src/index.ts`, `packages/ibus-web/test/browser/facade.test.ts`
- Docs: `docs/ibus-web.md`

**Interfaces:**
- Consumes: `ModuleRegistryService.prepare`, the `install` `ModuleEvent`, `PrepareEngineError`, `PrepareFailed` (Tasks 7–8).
- Produces: `IbusWeb.prepare(module: string, engine: string): Promise<void>`; `IbusWebEventMap.install`; `PrepareEngineError` exported from `ibus-web`.

- [ ] **Step 1: Write the failing test**

In `packages/ibus-web/test/browser/facade.test.ts`, add `PrepareFailed,` after `Connection,` in the `@ibus-web/core` import and `PrepareEngineError,` after `createIbusWeb,` in the `../../src/index.ts` import, and append:

```ts
test("prepare installs an engine's own data ahead of selection, reporting install events, and rejects with the reason", async () => {
  const f = fixture();
  const lazyPath = `/nix/store/${"b".repeat(32)}-lazy`;
  vi.mocked(fetch).mockImplementation(async () =>
    Response.json({
      ...manifest,
      data: [...manifest.data, { storePath: lazyPath, url: "lazy.tar", size: 10, encoding: "identity" }],
      engines: [
        ...manifest.engines,
        { ...manifest.engines[0], name: "lazy", data: [lazyPath] },
        { ...manifest.engines[0], name: "broken", data: [lazyPath] },
      ],
    }),
  );
  f.start.mockImplementation(async () => {
    const c = new DomConnection();
    c.prepareWith = async (engine, progress) => {
      if (engine === "broken") throw new PrepareFailed("fetch ./lazy.tar: 404");
      progress?.(4, 10);
      progress?.(10, 10);
    };
    f.connections.push(c);
    return c as unknown as Connection;
  });
  const installs: IbusWebEventMap["install"]["detail"][] = [];
  f.app.addEventListener("install", (event) => installs.push(event.detail));
  await f.app.prepare("test", "test");
  expect(f.connections, "Workers started for an engine without data of its own").toHaveLength(0);
  await f.app.prepare("test", "lazy");
  expect(f.app.selection).toBeUndefined();
  expect(f.connections[0]!.prepared).toEqual(["lazy"]);
  await expect
    .poll(() => installs)
    .toEqual([
      { module: "test", engine: "lazy", bytes: 4, total: 10 },
      { module: "test", engine: "lazy", bytes: 10, total: 10 },
    ]);
  f.app.attach(f.native);
  f.native.focus();
  await f.app.select("test", "lazy");
  expect(f.connections[0]!.prepared, "selection after prepare").toEqual(["lazy"]);
  const failed = f.app.prepare("test", "broken");
  await expect(failed).rejects.toBeInstanceOf(PrepareEngineError);
  await expect(failed).rejects.toMatchObject({ module: "test", engine: "broken", reason: "fetch ./lazy.tar: 404" });
  await expect(f.app.prepare("test", "missing")).rejects.toThrow("Unknown engine: missing in module test");
  await expect(f.app.prepare("missing", "lazy")).rejects.toThrow("Unknown module: missing");
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
nix develop -c git add packages/ibus-web/test
nix build .#checks.x86_64-linux.ibus-web-browser -L
```

Expected: FAIL: `f.app.prepare is not a function` (and `PrepareEngineError` undefined) in Chromium and Firefox.

- [ ] **Step 3: Add them to the facade**

In `packages/ibus-web/src/index.ts`: add `PrepareEngineError,` after `PanelEvents,` in the `@ibus-web/core` import; replace `export { CreateEngineError };` with `export { CreateEngineError, PrepareEngineError };`; add to `IbusWebEventMap`, after `storage`,

```ts
  /** While an engine's own data installs: bytes written so far of total, what the module's storage lacked. */
  install: CustomEvent<Omit<Extract<ModuleEvent, { _tag: "install" }>, "_tag">>;
```

to `IbusWeb`, after `engines`,

```ts
  /**
   * Installs the engine's own data ahead of selection, starting the module's Worker if it hasn't, so that selecting
   * the engine later waits for nothing; `install` events report its progress. An engine with no data of its own needs
   * nothing. Rejects with a PrepareEngineError carrying the Worker's reason.
   */
  prepare(module: string, engine: string): Promise<void>;
```

replace the registry events' dispatch

```ts
            if (event._tag === "state") emit("modulestate", { module: event.module, state: event.state });
            else emit("storage", { module: event.module, state: event.state, message: event.message });
```

with

```ts
            if (event._tag === "state") emit("modulestate", { module: event.module, state: event.state });
            else if (event._tag === "storage")
              emit("storage", { module: event.module, state: event.state, message: event.message });
            else
              emit("install", { module: event.module, engine: event.engine, bytes: event.bytes, total: event.total });
```

and add to `app`, after `engines`,

```ts
    prepare: async (module: string, engine: string) => {
      alive();
      if (!Object.hasOwn(options.modules, module)) throw new Error(`Unknown module: ${module}`);
      const current = await initialize();
      await runtime.runPromise(current.registry.prepare(module, engine));
    },
```

- [ ] **Step 4: Run it to see it pass**

```bash
nix develop -c git add packages/ibus-web
nix build .#checks.x86_64-linux.ibus-web-browser .#checks.x86_64-linux.typescript-npm -L
```

Expected: PASS (49 in Chromium and Firefox in the spike, the new case among them); the npm tarballs still pack.

- [ ] **Step 5: Document it**

In `docs/ibus-web.md`, in the paragraph on `select`, before `` `deselect()` returns every surface to plain browser input and keeps Workers loaded; `` add

```markdown
An engine whose descriptor names data of its own (a Rime schema's dictionaries) downloads and installs it the first
time it is selected, and `select` waits for it, while the surface stays on native input and other selections, focus
changes and detaches go on; a selection changed meanwhile resolves without making the engine, and the download still
completes. `prepare(module, engine)` does that ahead of selection, starting the
module's Worker if it hasn't, so that the selection later waits for nothing; an engine without data of its own needs
nothing. While data installs, `install` events carry `{ module, engine, bytes, total }`, unpacked bytes written of the
total the storage lacked, the last with `bytes` equal to `total`; a second selection, or one in a later visit, installs
nothing and sends none. A failed install rejects `select` or `prepare` with a `PrepareEngineError`, exported from
`ibus-web`, whose `reason` is the Worker's; the selection stands, as for a `CreateEngineError`, and the next focus
tries again.
```

replace `` engine descriptors (`name`, `displayName`, `languages`, `keyboard`) without starting a Worker. `` with `` engine descriptors (`name`, `displayName`, `languages`, `keyboard`, and `data` for an engine with data of its own) without starting a Worker. ``; replace `` `unload(module)` and `dispose()` return Promises. `` with `` `unload(module)`, `prepare` and `dispose()` return Promises. ``; and replace `` `modulestate`, `selectionchange`, `storage`, `panel` and `log` are typed CustomEvent names; `` with `` `modulestate`, `selectionchange`, `storage`, `panel`, `log` and `install` are typed CustomEvent names; ``. Then:

```bash
nix develop -c oxfmt docs/ibus-web.md
nix develop -c hk check -S links
```

- [ ] **Step 6: Commit**

```bash
nix develop -c git commit -m "feat(ibus-web): prepare an engine ahead of selection and hear its install" -- packages/ibus-web/src/index.ts packages/ibus-web/test/browser/facade.test.ts docs/ibus-web.md
```

---

### Task 10: Check 5b's interface

The generic part is done; the rest makes Rime's dictionaries such data. Nothing here could be built when this plan was written (5b didn't exist), so first check every name it uses.

**Files:** none.

- [ ] **Step 1: Check the packages and their passthru**

```bash
for package in ibus-web-rime ibus-web-rime-common ibus-web-rime-descriptors; do
  nix eval --raw ".#packages.x86_64-linux.$package.name" && echo
done
nix eval --impure --json --expr '
  let
    flake = builtins.getFlake (toString ./.);
    rime = flake.packages.x86_64-linux.ibus-web-rime;
  in
  {
    descriptors = rime ? descriptors;
    settingsSchemaDir = rime.settingsSchemaDir or null;
    common = rime ? common;
    dicts = builtins.attrNames (rime.dicts or { });
    license = rime.meta ? license;
  }'
```

Expected: the three names print; `descriptors`, `common` and `license` are true; `settingsSchemaDir` is a path under `ibus-web-rime-common`'s store path (or another base path, but no dictionary's); `dicts` lists the shipped dictionaries (`rime_ice`, `melt_eng`, `radical_pinyin`, `luna_pinyin`, `terra_pinyin`, `cangjie5`, `quick5`, `pinyin_simp`, `wubi86`, `stroke`, `jyut6ping3`, `loengfan`, `wugniu_lopha`, `luna_quanpin` or whatever subset 5b's deployment produces).

- [ ] **Step 2: Check the descriptor files**

```bash
d=$(nix build .#ibus-web-rime-descriptors --no-link --print-out-paths)
ls "$d"
jq -r '.[0].name' "$d/engines.json"
jq -r --slurpfile data "$d/engine-data.json" '.[] | "\(.name)\t\($data[0][.name] | length)"' "$d/engines.json"
common=$(nix eval --raw .#packages.x86_64-linux.ibus-web-rime-common.outPath)
jq -e --arg common "$common" '[.[][]] | all(. != $common)' "$d/engine-data.json"
jq -e '[.[] | has("data")] | any | not' "$d/engines.json"
```

Expected: `engines.json`, `engine-data.json`, `settings-paths.json`, `settings-schemas.json` and `instances.txt`; the first engine `rime:rime_ice`; every engine with at least one path; no engine naming the common path; `engines.json`'s descriptors without `data` of their own (Task 11 merges it in). If an engine has no path, or `engines.json` already carries `data`, the merge in Task 11 needs adapting: an engine absent from `engine-data.json` would get `data: null`, which the manifest's check refuses.

- [ ] **Step 3: Check the docs 5b wrote**

```bash
grep -n '^## ' docs/rime.md
grep -n '^## Rime' docs/engines.md
```

Expected: `docs/rime.md` has a `## Checks` section; `docs/engines.md` has `## Rime`.

```bash
nix build .#checks.x86_64-linux.rime-data-closure -L 2>&1 | grep 'longest link target'
```

Expected: `longest link target: 114 bytes`, past ustar's 100 (5b's departure 13); Task 1's pax archives carry it, and Task 11's build is the first to archive it. A missing name anywhere in this task is a mismatch with 5b's plan: stop and resolve it there.

---

### Task 11: Rime's distribution with lazy dictionaries

**Files:**
- Create: `engines/rime/dist.nix`
- Docs: `docs/rime.md`, `docs/engines.md`

**Interfaces:**
- Consumes: `packages.ibus-web-rime` and its passthru `descriptors` and `settingsSchemaDir`; `ibusWeb.engines.mkEngineManifest`; `EngineDescriptor.data` (Task 4).
- Produces: `packages.ibus-web-rime-dist` (`manifest.json`, `rime.wasm`, `settings.json`, `data/*.tar.br`; passthru `heapBytes`), each engine's dictionaries its own `data` and `ibus-web-rime-common` base data.

- [ ] **Step 1: Write the failing test**

The distribution's test is what its manifest says: every engine names its dictionaries, all of them in the module's data, the common path is base data, and `rime:rime_ice` comes first.

```bash
nix build .#ibus-web-rime-dist --no-link --print-out-paths -L
```

Expected: FAIL: `flake … does not provide attribute 'packages.x86_64-linux.ibus-web-rime-dist'`.

- [ ] **Step 2: Build the distribution**

Create `engines/rime/dist.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) engines;
      package = config.packages.ibus-web-rime;
      inherit (package) descriptors;

      # Each engine's dictionaries are data of its own, installed when it is
      # first made.
      enginesWithData =
        pkgs.runCommand "ibus-web-rime-engines.json" { nativeBuildInputs = [ pkgs.jq ]; }
          ''
            jq --slurpfile data ${descriptors}/engine-data.json 'map(. + { data: $data[0][.name] })' \
              ${descriptors}/engines.json > $out
          '';
    in
    {
      packages.ibus-web-rime-dist = engines.mkEngineManifest {
        name = "rime";
        inherit package;
        inherit (package) settingsSchemaDir;
        engines = enginesWithData;
        settingsSchemas = "${descriptors}/settings-schemas.json";
        settingsPaths = "${descriptors}/settings-paths.json";

        # A first bound, generous enough for rime-host to run and measure what
        # the module needs.
        threads = 2;
        heapBytes = 256 * 1024 * 1024;
      };
    };
}
```

(If 5b's `engines/rime/module.nix` already defines a `packages.ibus-web-rime-dist`, stop: the spec puts the distribution here, and the two would collide.)

- [ ] **Step 3: Run the test**

```bash
nix develop -c git add engines/rime/dist.nix
dist=$(nix build .#ibus-web-rime-dist --no-link --print-out-paths -L)
common=$(nix eval --raw .#packages.x86_64-linux.ibus-web-rime-common.outPath)
jq -e --arg common "$common" '
  [.data[].storePath] as $all
  | ([.engines[].data[]] | unique) as $lazy
  | .engines[0].name == "rime:rime_ice"
    and all(.engines[]; (.data | length) > 0 and all(.data[]; IN($all[])))
    and ($lazy | index($common)) == null
    and ($all | index($common)) != null
' "$dist/manifest.json"
jq -r '
  [.engines[].data[]] as $lazy
  | (.data | map(select(.storePath | IN($lazy[]))) | map(.size) | add) as $lazyBytes
  | (.data | map(select(.storePath | IN($lazy[]) | not)) | map(.size) | add) as $baseBytes
  | "base \($baseBytes) lazy \($lazyBytes)"
' "$dist/manifest.json"
jq -r '[.engines[].data[]] | unique | .[]' "$dist/manifest.json" | while read -r path; do
  stat -c %s "$dist/data/$(basename "$path").tar.br"
done | awk '{ sum += $1 } END { print "lazy archives " sum }'
du -b "$dist/data" | tail -1
jq -r '.engines[] | select(.name == "rime:rime_ice") | .data[]' "$dist/manifest.json" | while read -r path; do
  jq -r --arg path "$path" '.data[] | select(.storePath == $path) | .size' "$dist/manifest.json"
done | awk '{ sum += $1 } END { print "rime_ice " sum }'
```

Expected: `true`; then the base and lazy unpacked bytes, the lazy archives' Brotli bytes, all archives' bytes and `rime:rime_ice`'s own unpacked bytes. Measured natively at design time: 159 MB of compiled tables, 62 MB as Brotli, `rime_ice.table.bin` alone 59 MB; the lazy bytes here should be of that order and the base a few MB. Note the five figures as `{{baseMB}}`, `{{lazyMB}}`, `{{lazyBrotliMB}}`, `{{allBrotliMB}}` and `{{rimeIceMB}}` (MB, one decimal) for Step 4. The archives are pax (Task 1), so the common path's 114-byte links went in; `tar -tvf` over its archive, decompressed, lists them. The build itself has decoded the manifest with `decodeModuleManifest`: had a dictionary path held the schema directory, or lain outside the module's data, it would have failed there.

- [ ] **Step 4: Document it**

In `docs/rime.md`, add before `## Checks`:

```markdown
## Distribution

`ibus-web-rime-dist` (`engines/rime/dist.nix`) is `mkEngineManifest` over `rime.wasm`, with the descriptor step's
engines, settings schemas and settings paths. Each engine's dictionaries, its schema's and those of the schemas it
depends on (`engine-data.json`), are its own data ([engines.md](engines.md#an-engines-own-data)): the host installs them
the first time a page prepares or selects the engine. The rest of the closure, `ibus-web-rime-common` with Rime's
configs, OpenCC's data and `rime-ice`'s Lua scripts, is base data, installed at start. The base data is
{{baseMB}} MB unpacked; the dictionaries {{lazyMB}} MB, {{lazyBrotliMB}} MB as Brotli of the distribution's
{{allBrotliMB}} MB; `rime:rime_ice`'s own come to {{rimeIceMB}} MB unpacked. A dictionary several engines name, as the
double-pinyin engines name `rime_ice`'s, is installed once.
```

In `docs/engines.md`, section `## Rime`, add `nix build .#ibus-web-rime-dist` to its commands if 5b's section doesn't list it. Replace the five placeholders with Step 3's figures, then:

```bash
grep -n '{{' docs/rime.md
nix develop -c oxfmt docs/rime.md docs/engines.md
nix develop -c hk check -S links
```

Expected: `grep` prints nothing; the link check passes.

- [ ] **Step 5: Commit**

```bash
nix develop -c git add engines/rime/dist.nix docs/rime.md docs/engines.md
nix develop -c git commit -m "feat(rime): build the distribution, each engine's dictionaries its own data" -- engines/rime/dist.nix docs/rime.md docs/engines.md
```

---

### Task 12: `rime-host`

**Files:**
- Modify: `packages/worker-host/test/engines/page-session.ts`
- Create: `packages/worker-host/test/engines/rime.test.ts`, `engines/rime/checks/host/checks.nix`
- Modify: `engines/rime/dist.nix` (the measured `threads` and `heapBytes`)
- Docs: `docs/rime.md`, `docs/worker-host.md`, `docs/testing.md`

**Interfaces:**
- Consumes: `packages.ibus-web-rime-dist`; `RunningHost.prepare` (Task 6); `PageSession`, `ModuleBuild`; the settings `org.freedesktop.ibus.engine.rime` key `page-size` (5b).
- Produces: `checks.rime-host`; `PageSession.create()` preparing an engine with data of its own before `CreateEngine`, as the page's router does.

- [ ] **Step 1: Prepare before creating, in the test page**

In `packages/worker-host/test/engines/page-session.ts`, keep the session's manifest (`ModuleManifest` is already imported): add a field and pass it through the constructor:

```ts
  private lastSeq = 0;
  readonly host: RunningHost;
  private readonly manifest: ModuleManifest;
  private readonly options: SessionOptions;
  private constructor(host: RunningHost, manifest: ModuleManifest, options: SessionOptions) {
    this.host = host;
    this.manifest = manifest;
    this.options = options;
  }
```

in `start`, replace `const session = new PageSession(host, options);` with `const session = new PageSession(host, engine, options);`, and replace `create`'s comment and first request,

```ts
  // Activates an engine as the page's router does, enabling it before its
  // first focus.
  async create(ic: number, engine = this.options.engine): Promise<void> {
    await this.request(ic, new CreateEngine({ name: engine }));
```

with

```ts
  // Activates an engine as the page's router does: its own data prepared,
  // then the engine made and enabled before its first focus.
  async create(ic: number, engine = this.options.engine): Promise<void> {
    if ((this.manifest.engines.find(({ name }) => name === engine)?.data ?? []).length > 0) {
      const prepared = await this.host.prepare(engine);
      expect(prepared.error, `preparing ${engine}`).toBeUndefined();
    }
    await this.request(ic, new CreateEngine({ name: engine }));
```

Every existing suite's engines have no data of their own, so they don't change.

- [ ] **Step 2: Write the suite and its check**

Create `packages/worker-host/test/engines/rime.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { SettingChanged, int32Variant, type DecodedRecord, type Init, type OutputRecord } from "@ibus-web/protocol";
import { afterAll, afterEach, describe, expect, inject, test } from "vitest";
import type { PathInstallReport } from "../../src/shared/messages.ts";
import { nodeHarness } from "../node/harness.ts";
import { installOf } from "../shared/install.ts";
import type { Message } from "../shared/testing.ts";
import { Key, PageSession, type SessionOptions } from "./page-session.ts";

const h = await nodeHarness();
const build = inject("module");
const manifest = build.manifests["rime"]!;
afterAll(() => h.cleanUp());

type Values = Init["settings"][number]["values"];

const RIME_PATH = "/org/freedesktop/ibus/engine/rime/";
const RIME_ICE = "rime:rime_ice";

const metadata = JSON.parse(build.texts["settings"]!) as { schemas: { id: string; paths: string[] }[] };

// Every instance the metadata declares, as the page sends them: the given
// values at their paths and nothing stored anywhere else.
const instances = (values: Readonly<Record<string, Values>> = {}): Init["settings"] =>
  metadata.schemas.flatMap(({ id, paths }) => paths.map((path) => ({ schemaId: id, path, values: values[path] ?? {} })));
const options = (engine: string): SessionOptions => ({ settings: instances(), engine });

const ownData = (engine: string): readonly string[] =>
  manifest.engines.find(({ name }) => name === engine)?.data ?? [];
const lazy = new Set(manifest.engines.flatMap(({ data }) => data ?? []));
const sizeOf = (paths: Iterable<string>): number =>
  [...paths].reduce((sum, path) => sum + manifest.data.find(({ storePath }) => storePath === path)!.size, 0);

const pathInstalls = (messages: readonly Message[], engine: string): PathInstallReport[] =>
  messages.flatMap((message) => {
    if (message.type !== "path-install" || message.engine !== engine) return [];
    const { type: _, ...report } = message;
    return [report];
  });
const progressOf = (messages: readonly Message[], engine: string): { bytes: number; total: number }[] =>
  messages.flatMap((message) =>
    message.type === "prepare-progress" && message.engine === engine
      ? [{ bytes: message.bytes, total: message.total }]
      : [],
  );

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

// Types ASCII, whose keysyms are its code points; ibus-rime reads the keysym.
const typeText = async (session: PageSession, ic: number, text: string): Promise<DecodedRecord[]> => {
  const records: DecodedRecord[] = [];
  for (const character of text) records.push(...(await session.key(ic, character.codePointAt(0)!, 0)));
  return records;
};

describe.each(h.data.runtimes)("Rime through $name host", (runtime) => {
  let current: PageSession | undefined;
  let breakPeak = 0;
  let threadsPeak = 0;
  const start = async (engine: string): Promise<PageSession> => {
    const begin = performance.now();
    current = await PageSession.start(h, runtime, manifest, options(engine));
    h.record(`Rime ${runtime.name} start`, { ms: performance.now() - begin });
    return current;
  };
  afterEach(async () => {
    const running = current;
    current = undefined;
    if (running === undefined) return;
    try {
      const stats = await running.stats();
      breakPeak = Math.max(breakPeak, stats.breakPeak);
      threadsPeak = Math.max(threadsPeak, stats.activeThreadsPeak);
      expect(stats.activeThreadsPeak).toBeLessThanOrEqual(manifest.threads);
      expect(stats.breakPeak).toBeGreaterThan(0);
      expect(stats.breakPeak).toBeLessThanOrEqual(build.heapBytes);
      expect(stats.poolWorkersPeak).toBeLessThanOrEqual(build.poolBase + manifest.threads);
    } finally {
      await running.host.terminate();
    }
  });
  afterAll(() => h.record(`Rime ${runtime.name} suite peaks`, { breakPeak, threadsPeak, heapBytes: build.heapBytes }));

  test("the base data installs at start, rime:rime_ice's dictionaries when it is prepared, and nihao commits 你好", async () => {
    const session = await start(RIME_ICE);
    const { messages } = session.host;
    const base = manifest.data.filter(({ storePath }) => !lazy.has(storePath));
    expect(installOf(messages)?.bytes, "the base data installed at start").toBe(sizeOf(base.map((e) => e.storePath)));
    const own = ownData(RIME_ICE);
    const reports = pathInstalls(messages, RIME_ICE);
    expect(reports.map(({ storePath }) => storePath).toSorted(), "rime_ice's dictionaries").toEqual([...own].toSorted());
    expect(new Set(reports.map(({ state }) => state)), "installed, all of them").toEqual(new Set(["installed"]));
    const progress = progressOf(messages, RIME_ICE);
    expect(progress.at(-1), "the last progress").toEqual({ bytes: sizeOf(own), total: sizeOf(own) });
    h.record(`Rime ${runtime.name} rime_ice install`, {
      bytes: sizeOf(own),
      ms: reports.reduce((sum, { installMs }) => sum + installMs, 0),
    });

    await typeText(session, 1, "nihao");
    expect(committed(await session.key(1, ...Key.space))).toBe("你好");
  });

  test("in one Worker, rime:double_pinyin finds rime_ice's dictionaries present and rime:luna_pinyin converts beside it", async () => {
    const session = await start(RIME_ICE);
    const { messages } = session.host;
    await typeText(session, 1, "nihao");
    expect(committed(await session.key(1, ...Key.space))).toBe("你好");

    await session.create(2, "rime:double_pinyin");
    const shared = pathInstalls(messages, "rime:double_pinyin");
    expect(shared.length, "double pinyin's dictionaries").toBeGreaterThan(0);
    expect(new Set(shared.map(({ state }) => state)), "present, all of them").toEqual(new Set(["present"]));
    expect(progressOf(messages, "rime:double_pinyin"), "progress for data already there").toEqual([]);

    await session.create(3, "rime:luna_pinyin");
    expect(
      pathInstalls(messages, "rime:luna_pinyin").some(({ state }) => state === "installed"),
      "luna_pinyin's own dictionaries installed",
    ).toBe(true);
    await typeText(session, 3, "zhongguo");
    expect(committed(await session.key(3, ...Key.space))).toBe("中國");
  });

  test("a settings change with only rime_ice's dictionaries installed redeploys without a warning and reaches the context", async () => {
    const session = await start(RIME_ICE);
    await session.request(
      0,
      new SettingChanged({ path: RIME_PATH, key: "page-size", value: int32Variant(7) }),
    );
    // Maintenance runs on the deployer's thread; the context takes the change
    // up at its first key after maintenance ends.
    const deadline = performance.now() + 60_000;
    for (;;) {
      const table = last(await typeText(session, 1, "ni"), "UpdateLookupTable").table;
      await session.key(1, ...Key.escape);
      if (table.pageSize === 7) break;
      expect(performance.now(), "maintenance ending").toBeLessThan(deadline);
      await h.sleep(250);
    }
  });
});
```

Create `engines/rime/checks/host/checks.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) runtime testing typescript;
      dist = config.packages.ibus-web-rime-dist;
    in
    {
      checks.rime-host = testing.vitestCheck {
        name = "rime-host";
        packageDir = "${typescript.workspaceFor [ "packages/worker-host" ]}/packages/worker-host";
        env = {
          IBUS_WEB_WORKER_HOST_TESTS = config.checks.worker-host-node.manifest;
          IBUS_WEB_MODULE_TESTS = pkgs.writeText "ibus-web-rime-host-tests.json" (
            builtins.toJSON {
              suite = "rime";
              dists.rime = "${dist}";
              inherit (dist) heapBytes;
              poolBase = runtime.threadPool.size;

              # The suite declares every instance the metadata lists, as the page does.
              texts.settings = "${dist}/settings.json";
            }
          );
        };
        inBrowsers = false;
        limit = 1200;
      };
    };
}
```

- [ ] **Step 3: Run it, and read what it measured**

```bash
nix develop -c git add packages/worker-host/test/engines engines/rime/checks/host/checks.nix
nix build .#checks.x86_64-linux.rime-host -L 2>&1 | tee rime-host.log | grep -E 'Rime (asserting|released) |✓|×|FAIL'
```

Expected: PASS under the first bound (256 MiB, 2 threads), three tests on each runtime, and the records `Rime asserting start`, `Rime asserting rime_ice install`, `Rime asserting suite peaks` and the same for `released`. If the first test fails at start with a warning record from Rime's startup maintenance (a dictionary's link into `build/` that dangles until its engine is prepared), the module's startup check walks the dictionaries of every deployed schema: that is 5b's to fix (the maintenance must accept a deployment whose prebuilt tables are absent until installed, by checking the user directory against the shared one without opening tables, or the module defers maintenance until a session is made); record the warning, stop, and resolve it in 5b's module before going on. If an expectation drawn from Rime's data fails (a commit other than `你好` or `中國`, or `rime:double_pinyin` naming a dictionary `rime:rime_ice` doesn't), read the engine's `engine-data.json` entry and its schema before changing the test, and say so in the report.

Note from the peaks line, for each runtime, `breakPeak` and `threadsPeak`; let `{{breakAsserting}}` and `{{breakReleased}}` be the two break peaks, `{{threadsPeak}}` the larger thread peak, and `{{heapMiB}}` = `ceil(max(breakAsserting, breakReleased) / 1048576) + 4`. From the start and install records, `{{startMs}}` (the larger start of the two runtimes, whole ms) and `{{installMs}}` and `{{rimeIceMB}}` (the released runtime's install, whole ms, and its bytes in MB, one decimal).

- [ ] **Step 4: Declare what it measured**

In `engines/rime/dist.nix`, replace

```nix
        # A first bound, generous enough for rime-host to run and measure what
        # the module needs.
        threads = 2;
        heapBytes = 256 * 1024 * 1024;
```

with

```nix
        # rime-host peaks at {{breakAsserting}} bytes asserting and
        # {{breakReleased}} released, with rime_ice and luna_pinyin open in one
        # Worker, whose tables Rime maps into memory, and at {{threadsPeak}}
        # engine threads: LevelDB's compaction and the deployer's maintenance.
        # The declaration leaves several MiB above the break, and the manifest
        # builder adds headroom after it.
        threads = {{threadsPeak}};
        heapBytes = {{heapMiB}} * 1024 * 1024;
```

with the placeholders replaced by Step 3's figures (if `threadsPeak` is 1, write "engine thread: LevelDB's compaction" accordingly). Then:

```bash
grep -n '{{' engines/rime/dist.nix
nix build .#checks.x86_64-linux.rime-host -L 2>&1 | grep -E 'Rime (asserting|released) suite peaks|Tests '
```

Expected: `grep` prints nothing; PASS, six tests, the peaks within the new declaration.

- [ ] **Step 5: Document it**

In `docs/rime.md`, add to `## Distribution` (Task 11):

```markdown
It declares {{threadsPeak}} engine threads and a {{heapMiB}} MiB program break: `rime-host` peaked at
{{breakAsserting}} bytes asserting and {{breakReleased}} released with `rime:rime_ice` and `rime:luna_pinyin` open in
one Worker, since Rime maps its tables, which WasmFS serves as copies in memory, so the break counts every dictionary
the workload has open.
```

and under `## Checks`:

```markdown
- `rime-host` runs the distribution through a Node Worker host and the test page on both runtime builds: only the base
  data installed at start; `rime:rime_ice`'s dictionaries installed by `PrepareEngine`, with progress ending at their
  total, and `nihao` committing `你好`; in one Worker, `rime:double_pinyin` finding those dictionaries present and
  `rime:luna_pinyin`, prepared beside it, converting `zhongguo` to `中國`; a page-size change redeploying with only
  `rime_ice`'s dictionaries installed and reaching the open context, with no warning; and the break and thread peaks
  against the manifest. The module starts in {{startMs}} ms; `rime_ice`'s {{rimeIceMB}} MB install in {{installMs}} ms
  under Node.
```

In `docs/worker-host.md`, section "Transport and Hangul conformance", replace `` `checks.mozc-host` and `checks.m17n-host` are such suites. `` with `` `checks.mozc-host`, `checks.m17n-host` and `checks.rime-host` are such suites; a suite's `PageSession` prepares an engine with data of its own before creating it, as the page does. `` In `docs/testing.md`, wherever the engine host suites are listed, add `rime-host` beside `m17n-host`. Then:

```bash
grep -n '{{' docs/rime.md
nix develop -c oxfmt docs/rime.md docs/worker-host.md docs/testing.md
nix develop -c hk check -S links
```

- [ ] **Step 6: Commit**

```bash
rm -f rime-host.log
nix develop -c git add packages/worker-host/test/engines engines/rime docs/rime.md docs/worker-host.md docs/testing.md
nix develop -c git commit -m "test(rime): run the distribution through the Worker host and declare its measured peaks" -- packages/worker-host/test/engines/page-session.ts packages/worker-host/test/engines/rime.test.ts engines/rime/checks/host/checks.nix engines/rime/dist.nix docs/rime.md docs/worker-host.md docs/testing.md
```

---

### Task 13: Verify the phase

**Files:** none, unless a step finds drift.

- [ ] **Step 1: Generated files**

```bash
nix run .#write-files
nix develop -c git status --short
```

Expected: no output from `git status`. (`PROTOCOL.md` was regenerated in Task 6; nothing else this phase touches is generated.)

- [ ] **Step 2: The default gate**

```bash
nix flake check -L
```

Expected: PASS. In the spike (Tasks 1–9 on master), `nix flake check -L --keep-going` passed once `writable.cpp` was clang-formatted as Task 3's code now is.

- [ ] **Step 3: The extended gate**

```bash
nix build .#integration-checks -L
```

Expected: PASS. In the spike, `worker-host-node-integration` (291 tests) and `worker-host-browser-integration` (440 tests) passed.

- [ ] **Step 4: hk over the tree**

```bash
nix develop -c hk check --all
```

Expected: PASS.

- [ ] **Step 5: This phase's own checks, named**

```bash
nix build .#checks.x86_64-linux.wasmfs-idb-browser .#checks.x86_64-linux.ibus-runtime-exports .#checks.x86_64-linux.ibus-runtime-load .#checks.x86_64-linux.libibus-web-tests .#checks.x86_64-linux.tools-pack-licenses-tarball .#checks.x86_64-linux.protocol-node .#checks.x86_64-linux.worker-host-node .#checks.x86_64-linux.worker-host-browser .#checks.x86_64-linux.core-node .#checks.x86_64-linux.core-browser .#checks.x86_64-linux.ibus-web-browser .#checks.x86_64-linux.hangul-host .#checks.x86_64-linux.table-host .#checks.x86_64-linux.mozc-host .#checks.x86_64-linux.m17n-host .#checks.x86_64-linux.rime-host .#checks.x86_64-linux.typescript-npm -L
nix build .#ibus-web-rime-dist .#worker-host-node-integration .#worker-host-browser-integration -L
```

Expected: PASS. In the spike every one of these but `rime-host` and `ibus-web-rime-dist` passed: hangul-host 20, table-host 16, mozc-host 16, m17n-host 27, worker-host-browser 8, and the counts given in each task. Report which ran and what failed; don't summarize one you didn't run as passing.
