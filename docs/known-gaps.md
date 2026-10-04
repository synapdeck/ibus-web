# Known gaps

What is open: limits the code knowingly has, work later milestones take on, and minor review findings not
yet fixed. Each item says what is missing and, where it matters, why it was left.
An item leaves this page when it is fixed or decided.

## Toolchain

- **The exnref switch** (spec R18). `-fwasm-exceptions` emits WebAssembly's legacy exception encoding,
  which Firefox warns is deprecated once per Worker that instantiates a module. The standard encoding
  (`-sWASM_LEGACY_EXCEPTIONS=0`) is outside the minimum versions; `checks.toolchain-exnref` fails once every
  minimum version supports it, which is the cue to switch. Until then the test runners filter Firefox's
  warning out of their output.
- **Dynamic linking with pthreads is "experimental"** by Emscripten's own warning, which `-Wno-experimental`
  silences along with the rest of that warning category. Everything the runtime relies on is tested
  ([runtime.md](runtime.md)), but the combination stays a risk (spec R3).
- **Emscripten and LLVM are paired by nixpkgs** (6.0.9 on clang 22.1.8), which tests that pairing with
  little more than hello-world (spec R12); our own checks are the evidence.
- **No CMake recipe is built in `pkgsWasm` yet**; configuring CMake through the cross set is untried until
  an engine needs it.
- **Autotools configure scripts can't run their test programs**: autotools configures as a cross build,
  and only Meson has an exe wrapper (Node), so a recipe that needs run-time configure checks will meet it.
- **Emscripten functions hostile to a Worker host are still exported.** The export manifest takes
  `emscripten.h` whole but for Asyncify-only functions, so the main loop, canvas helpers and
  `emscripten_create_worker` remain callable from side modules.
- **Probe and cache link flags are spelled twice** in `modules/toolchain/cache.nix` (`-sMAIN_MODULE`,
  `-sPTHREAD_POOL_SIZE`, `-sEXIT_RUNTIME` in the probe links and in the cache's own list).
- **The side-module library guard sees only `-l` flags**, and would refuse a shared `-lm` too.
- **The dev shell's `.emcache` is never refreshed.** It is copied from the frozen cache only when it doesn't
  exist, so it goes stale when the cache changes; delete it to reseed.
- **Thread fixes not proven red in our checks.** The fix checks for patches 0014, 0015 and 0018 keep the
  conditions their bugs need, but nothing runs them against a toolchain missing their patch; that needs a
  toolchain and cache built with one patch left out. (Emscripten's own suite tests fail without each patch
  and pass with it; see the drafts.)
- **0018 off our backend.** The heartbeat fix wasn't run with Emscripten's browser OPFS or fetch backends,
  and a `ProxyWorker` thread that ended other than through its destructor would still leave its timer
  (none can today).
- **0014's upstream test exit path** is reasoned, not run; Emscripten's own
  `other.test_pthread_print_override_modularize` is flaky under load.

## GLib

- **Not built from spec §5.1**: the lazy arity lookup for callbacks with fewer parameters (§5.1.2, R1,
  waiting on the engine audit); a review of the series' `gsettings.c` changes (§5.1.3); the §5.1.4 platform backends (locale, collation, localized dates,
  `TextDecoder` charsets, file monitoring, network, a synthesized user and host).
- **Tool shadowing.** A build that runs a GLib tool by name from `PATH` gets nixpkgs' native, unpatched one,
  whose `gdbus-codegen` output traps on WebAssembly.
- **GLib's tools still grow their memory** (`-sALLOW_MEMORY_GROWTH=1`), unlike the tests and the runtime.
- **File monitoring.** `testfilemonitor` fails ungated: Emscripten has no file-change notification, and the
  WasmFS monitor backend (spec §5.1.4) is feature work.
- **Tests skipped whole**, not gating: subprocess tests (`mem-overflow`, `deprecated-properties`,
  `network-monitor-race`, `tls-bindings`, gobject's `testing`), Windows-only `print`,
  `gdbus-address-get-session`, `gdbus-tool.py` (needs PyGObject) and the four lint scripts.
- **Platform-skipped subtests.** The locale ones return with spec §5.1.4's backends: collation
  (`/unicode/collate{,-key}/{0,1}`, `/unicode/collate-filename/0`), `/option/arg/repetition/locale`, and
  localized dates and times (`/date/month_substring`, `/GDateTime/modifiers`, the `de_DE` `format_mixed`
  cases, `/GDateTime/eras/*`). The rest stay skipped while their reason holds: sockets and spawning, Unix
  signals, IPv6 scope IDs and interfaces, WasmFS's millisecond file times, unbounded pipes
  (`/mainloop/unix-fd`), TZif files by path, the content-type backend, and `/pollable/unix/pty` (WasmFS has
  no `/dev/ptmx`).
- **WebAssembly guards still in place**, each possible on Emscripten:
  `g_application_command_line_get_stdin()` returns `NULL`; local file and socket streams don't implement
  `GFileDescriptorBased`; GLib's `unix` and GIO's `unix-streams` tests aren't built; local file output
  streams don't use `writev()`; socket sources and non-blocking sockets are stubs (networking is out of
  scope); the content-type backend maps extensions only (xdgmime would work without shared-mime-info data);
  mount-table features (`filesystem::readonly`, enclosing mounts, trash, the Unix volume monitor) are off.
- **`pipe()` where `g_unix_open_pipe()` now works**: `gtester`, spawn-singlethread and test-printf still
  open pipes with `pipe()` on WebAssembly.
- **The musl `iconv()` workaround (0015) isn't proposed upstream.** It would serve musl and NetBSD users;
  per-character conversion costs one or a few `iconv()` calls per character, on musl only.
- **WasmFS behaviour accepted, not carried as patches**: pipes have no capacity, so a writer never sees one
  full; the Node backend opens `O_WRONLY` as `"r+"`, so an existing write-only (`0200`) file can't be opened
  for writing; a JavaScript-file-system pipe whose writers have closed reads `EAGAIN`, not end of file;
  WasmFS's stdout turns a NUL byte into a line break, which keeps GLib's tools on `-sNODERAWFS`. The first
  three have [upstream drafts](upstream/README.md); the stdout one has none.
- **The wake hook (0017).** Under `G_DISABLE_CHECKS` a `NULL` hook is installed and its signal calls
  `NULL`; the documentation doesn't say that a context must outlive concurrent wakeups, which the hook call
  widens; the smoke test's log handler counts in a plain `int` and leaves parameters unused.
- **GLib's patches apply with offsets and fuzz** on the current nixpkgs GLib; rebase them on the next GLib
  bump.

## Runtime

- **IBus API scope.** M1.1 supplies engine/data types, emitters, the framed dispatcher
  and settings backend. `IBusEngineSimple` still lacks compose, Ctrl+Shift+U and emoji;
  unused bus/config/component APIs remain absent. Keymap lookup uses page-provided keysyms.
- **Native parity scope.** `checks.hangul-differential` compares ten traces at
  the engine boundary against the pinned stock native engine. It does not test
  browser host/router behavior or live settings. The stock engine's invalid
  final-page digit emits five extra signals and two GLib criticals while both
  adapters exit successfully; the corpus declares that exact upstream outcome.
  The `hanja-click-page` trace pages forward and back and clicks on the first
  page: stock ibus-hangul, without port 0004, selects by absolute index and
  diverges from page 2 on, and the comparator tolerates only extra native
  records, so page-2 clicks are covered by the golden tests alone.
  See [the native testing spec](specs/2026-10-03-native-ibus-differential-testing.md).
- **An engine's C++ exception poisons the runtime.** The exception unwinds
  through GLib's signal emission, so `ibusweb_dispatch` latches a fault and
  returns `-ECANCELED`, and the host treats it as a crash and restarts the
  engine. Containing it needs a small GLib patch, once a C++ engine is in
  scope: hook the `marshal(...)` call in `g_closure_invoke` and
  `_g_closure_invoke_va` (`gobject/gclosure.c`) and the source dispatch call in
  `g_main_dispatch` through a C++ `try`/`catch` trampoline that libibus-web
  sets, so GLib's bookkeeping completes and only the engine module is marked
  faulted. Engine-internal C frames between the catch and the throw would still
  skip their cleanup, and engine modules keep state in globals, so the module
  would still be torn down; the gain is a clean report instead of later
  corruption. Snapshotting and restoring the heap per request was rejected for
  its cost. Building GLib with `-fexceptions` wouldn't help: unwinding runs only
  cleanup-attributed locals, and GLib's emission push and pop aren't, so it
  would mean rewriting GLib's internals.
- **The ring and the protocol** (spec §6): the output ring, `replyOutSeq` and the doorbell are M1.3's; `@ibus-web/protocol` supplies the GVariant codec and the framed messages. The full-ring wait must follow §6.2.2: the host sets `ringWaiting`, posts a doorbell,
  reads the wake word as `seen`, re-checks the free space and, while the ring is full, sleeps in
  `ibusweb_wait(seen, -1)` without pumping; the page, after advancing `ringRead`, clears `ringWaiting` and
  bumps `wake`.
- **The engine's pool share is fixed at 4** (`runtime/ibus-runtime/package.nix`). The design (spec §5.3)
  links `-sPTHREAD_POOL_SIZE` as the Nix-derived base plus `Module["ibuswebEngineThreads"]`, which the host
  sets from the manifest's `threads`, refusing to start without it. Emscripten 6.0.9 writes the setting
  verbatim inside the modularized factory, so this works (a probe linked that way started 2 + 3 Workers);
  the quoting must survive the cc-wrapper and the export-list link.
- **The manifest's sizes from build data.** Computing `memory`, `threads` and data sizes from the side
  module's `dylink.0`, files in the memory backend, the checks' measured peak heap, the engine's thread
  burst and each data archive's unpacked size is M1's.
- **No module shutdown call.** The ABI has no shutdown entry point; Hangul's
  `ibus_hangul_exit` never runs and its module globals live for the Worker lifetime.
- **GLib's pool share under concurrent `GTask`s.** The share of 3 covers one `GTask` in flight; each
  concurrent one can take another worker, up to `G_TASK_POOL_SIZE` (10) and beyond. Engines that run
  `GTask`s concurrently need a rule.
- **No public Emscripten API to grow the pthread pool.** The host's top-up uses Emscripten's internal
  `PThread`; an upstream call to add Workers and settle once they can run threads would replace it. No
  draft yet.
- **First threads in Chromium** cost about 12 ms each on a pool Worker that has never run one, so a pump
  that starts four takes about 50 ms, past D6's budget. Running a thread on each pool Worker at startup
  would move that out of keystrokes; not tried.
- **Per-Worker memory figures** (about 18 MiB per pool Worker in Chromium, 12–16 MiB in Firefox, 41–42 MiB
  under Node) predate the host's final JavaScript; re-measure once the host and runtime settle.
- **The pump's tuning constants** (a 10 ms cap with fd sources, 64 rounds) are unmeasured.
- **Expected stderr noise isn't marked as such** in check output: `dlopen` errors from refusal cases, and
  Emscripten's `received "7" command from terminated worker` at an `ASSERTIONS` + `PROXY_TO_PTHREAD` exit.
- **WebKit** wasn't run (spec R5, R13).

## Engines and page integration

- **Connection-time callback audit.** The current cast audit sees explicit casts;
  it cannot establish every connected handler's arity. Hangul needs no lazy arity
  bridge; m17n, libpinyin and Rime still need their own audits.
- **Hangul setup.** The `setup` property does not launch an application.
- **Hangul preedit-mode updates.** Module settings stay current even with no
  live engines. `preedit-mode` takes effect in an existing engine on refocus
  or a capabilities update.
- **Surrounding selection anchor.** The IBus-compatible delete operation updates
  cached text/cursor but leaves the selection anchor unchanged until the host's
  next `SetSurroundingText`; callers can observe that stale anchor.
- **Host startup (M1.3).** Map the installed engine data into its FHS view and
  apply the Init snapshot before loading the module. The existing host's data
  installation does not yet wire this engine startup sequence.
- **Client preedit policy (M1.4).** Commit the last COMMIT-mode preedit on blur
  and reset; Hangul clears its own composition and relies on the client. A Hanja
  list instead uses CLEAR mode. The router should omit
  `IBUS_CAP_SYNC_PROCESS_KEY_V2`: the reply already orders output, and an
  unconsumed key can be applied by the browser. Advertising it makes Hangul
  consume and forward that key explicitly.
- **Settings persistence (M1.4).** The page's replaceable persister must read
  Init snapshots from the `gsettings` IndexedDB database, persist SettingWritten,
  and deliver SettingChanged to other Workers and tabs over BroadcastChannel
  (spec §7.1.4). The C backend is in-memory only.

## Storage

- **Host API**: usage report, export and reset (spec §5.6), and the quota `storage` events of spec §8, aren't
  built.
- **`storage: closed` waits for a wake.** The host notices a closed connection only when it next wakes, so a
  version change while the engine is idle goes unreported until a request or a GLib source wakes it. The
  relay could wake it, or the page could restart the Worker on its own `versionchange`.
- **A writer that unlinks a file another tab has open** deletes its inode at once: open counts are per
  connection, so the reader's next read fails with `ENOENT`. Harmless for engine data, which nobody
  unlinks; user data that readers in other tabs keep open needs a rule before user dictionaries (M4).
- **Restarts in Chromium.** A host that dies without the page terminating it gets no wait for its writer
  lock, so a restart within about 2 s may come up read-only for the Worker's life. The page's bounded wait
  for a terminated writer's lock lives in the test harness until a page package owns it.
- **The backend's internals are runtime exports.** `_wasmfs_idb_record_entry` and
  `_wasmfs_idb_set_string` are `EMSCRIPTEN_KEEPALIVE`; only the export manifest keeps side modules off them.
- **Node.** The Node backend has no read-only mode, so a read-only mount and a seal are conventions there;
  Web Locks don't coordinate separate Node processes sharing a directory; and the Node marker's directory
  sync swallows every error, `EIO` included.
- **The memory fallback's headroom for metadata.** Without IndexedDB the memory grows by the page-rounded
  data size, which covers file contents only; WasmFS's file objects and directory entries come out of the
  base memory's spare, which a manifest of many small files could exhaust.
- **A manifest without a version** fails the start for every storage but `none`, the memory fallback
  included, which may be stricter than it needs to be.
- **Real quota failures** aren't reached in tests; the backend's tests inject the state one leaves.
- **Measurements on one machine.** The fsync and storage figures come from one host's ZFS. Chromium's
  64 KiB cliff is attributed to Blink's value wrapping, not traced; Firefox's out-of-line threshold is
  measured (between 768 and 896 KiB), not read from its source.
- **WebKit's IndexedDB in Workers** is unchecked (spec R5, R13).
- **The backend's costs**: every `open()` costs one read-only transaction; the open/unlink race is argued
  in a comment, not tested; a `pwrite()` straddling 2^53 − 1 fails whole with `EFBIG` rather than writing
  short.
- **Installing writes partial chunks.** Each read of the archive's response is one write transaction; the
  512-byte ustar headers offset the data, so most writes cover a partial chunk at each end and read those
  chunks first. Buffering the extractor's writes to chunk boundaries would remove the reads; installing is
  off the request path.
- **Test hooks**: the chunk counter doesn't count `getAllKeys()` or cursors, and a `get()` of a hole counts
  nothing; the injected delete fault aborts synchronously, as a body that throws rather than a commit that
  aborts; the browser `install-torn-marker` case writes a non-marker value, since a browser's commit can't
  tear.

## Worker host

- **Node hosts are for tests only.** Node's Web Locks grant one exclusive lock to two `worker_threads` at
  once in about 3% of races (12 of 300 with `ifAvailable`, 8 of 300 queued; Node 24.21.0), so two Node hosts
  started together can both become writer or both install one version. Node suites start hosts that share
  storage one at a time; a Node store that needs real exclusion would take an `O_EXCL` lock file or an
  `Atomics` lock. [Draft bug report](upstream/node-web-locks-worker-threads.md).
- **A page has no published source for the host's constants.** `HostInit.constants` (the pump's error
  code, the wait's timeout, the backend's read-only flag, the memory bounds) and `poolLowWater` come from
  derivations only the tests use; `packages.ibus-runtime` ships none of them.
- **Collection failures are silent but for `CollectReport.error`**; nothing is logged.
- **`@ibus-web/worker-host` is publishable but not released.** Its version stays `0.0.0` and nothing
  publishes it. Releases are to be versioned with Changesets, with a CI workflow that bumps versions and
  publishes to npm; neither is set up yet.
- **Test-harness leftovers**: the failing-relay temporary copies and the Node scratch directory aren't
  removed; the Node archive server in the Vitest config process is `unref`'d, not closed; Vite's
  unanalyzable-import warning is filtered by its text.
- **`pnpmDeps`' hash is verified on x86_64-linux only**; rolldown's native binding is a per-platform
  optional dependency.
- **A failed `node:fs` import is classed as trapped**: safe, but wrong.

## Testing

- **Sequences under `-t`.** Cases inside a sequence program depend on the ones before them, so a `-t` that
  selects one later case of `basic.1` or `sweep.2` alone fails.
- **The catch-up run hides its output.** A sequence program run for its storage that fails reports only
  "failed, run for the storage it leaves", without its output.
- **`run` hides under `-t`**: a pattern that excludes a program's `run` test hides run-level failures
  (selected cases that weren't reported still fail).
- **A crashed GoogleTest program leaves its empty `gtest-report-*.json`** in the host's `/tmp` under Node.
- **Output a pthread prints just before exit can be lost**: Emscripten stubs the pthreads' `onmessage`
  during `exitRuntime`. A program that wants its output joins its threads first.
- **Browser durations patch `TestRunner.prototype`**, since Vitest 5.0.3's browser mode ignores
  `test.runner`; the duration checks in `checks.test-programs` catch a Vitest update that breaks it. The
  program-level suite time isn't asserted.
- **Pool sizes in wasmfs-idb's checks are hand counts** (`backends` per program); a count too low fails the
  program's cases under `-sPTHREAD_POOL_SIZE_STRICT=2` rather than being derived.
- **The dev shell doesn't provide the Playwright browsers.** Nothing in it sets `PLAYWRIGHT_BROWSERS_PATH`;
  running the browser environments from a checkout reads it from the check with `nix eval`
  ([testing.md](testing.md)).
- **A failed check keeps no `results.json`**: the derivation's output exists only when it passes, so a
  failure's results are in the log alone.
- **The library checker leans on the jsifier's shape.** `runtime/wasmfs-idb/library-deps.ts` finds the
  test that tells a function's source held in a string by its shape in Emscripten's jsifier (the one `if`
  whose block sets `isFunction` and whose test reads `snippet`), so an Emscripten that restructures it
  fails the check rather than being followed; and whatever name `addImplicitDeps` needs that the checker's
  context lacks fails with one catch-all message, naming it only through the engine's `ReferenceError`.
- **The worker-host browser tests' output settle rests on delivery order.** A test takes what the host's
  Workers printed once a line printed by a Worker started for the purpose has arrived, which assumes
  Playwright delivers console messages across Worker targets in the order the browser sent them. A line
  that arrived later anyway would fail the next test as unexpected output, not pass unseen; if that ever
  happens, the fix is a marker printed by the host's own Workers.
- **A check's Vitest file shows under its store name** (`../../../<hash>-fixes.test.ts`): it is copied
  into the store alone, so it can't use relative imports.
- **`nodeTests` copies `.d.ts` files** along with the tests.
- **`packageNodeModules` may return a path that doesn't exist** for a package with no dependencies; the
  workspace output duplicates the root `node_modules` (disk only).
- **TypeScript loose ends**: the workspace's `fileFilter` matches by extension anywhere in a package; two
  `pre-js.d.ts` declare `ENVIRONMENT_IS_PTHREAD` (accepted, one per environment); the WebAssembly shim
  (`types/webassembly`) may collide with a future `@types/node`.

## Tooling

- **The pre-commit hook needs the dev shell.** A commit from a shell without `hk` on `PATH` fails unless it
  sets `HK=0`; commit with `nix develop -c git commit …` or from a direnv shell. The hook stashes unstaged
  work (`stash = "git"`) while it runs.
- **hk's version check is weak**: it compares hk's source with `pkgs.hk`, which come from the same place.
- **Paths repeated by hand**: `hk.pkl` and `.gitignore` both name the Nix-built types links. `hk.pkl`
  spells out oxfmt's three commands to add `-c`, since hk's evaluator has no list operations to derive them
  from the builtin's.
- **Claude Code plugins**: `marketplace.json` and the plugins' `plugin.json` both list `lspServers`; the
  marketplace's relative `directory` path is untested; the dev shell's greeting hard-codes its name.
- **hk's own problems have no upstream reports**: pklr leaves interpolation in multi-line strings
  unexpanded, its HTTP client wants a CA bundle even offline, and nixpkgs' hk embeds no pkl package (hence
  the Nix-built `.hk` link).
- **`write-files` in the dev shell** brings nushell and git into its closure.

## CI

- **Not yet run.** The workflow can't run from a workstation; the first run's checklist is in
  [tooling.md](tooling.md#ci).
- **Cold-run disk.** A cold run rebuilds the patched Emscripten and everything WASM, and may exhaust
  `ubuntu-latest`'s some 14 GB of free disk; a disk-freeing step (such as
  `DeterminateSystems/nothing-but-nix`) or a larger runner would fix it.
- **First-run cache ordering.** The first `master` run pushes to FlakeHub Cache before the flake's first
  publish exists to attach access to, so only a second run proves the cache.
- **Fork pull requests** get no cache (FlakeHub Cache can't authenticate their OIDC tokens); their
  behaviour is unverified.
- **Only x86_64-linux is checked**; the flake's checks are defined for Darwin and aarch64 too.
- **The files writer never deletes** a file it no longer configures; a removed workflow needs `git rm`.

## Upstream

- **Most reports are filed; some fixes and one proposal aren't.** [upstream/README.md](upstream/README.md)
  lists what is left to post, in order (two PRs, a Node issue, two Emscripten issues, the follow-up PRs
  for filed issues, and the IndexedDB backend proposal), and what was filed where. Patch headers get their
  issue numbers in a later change.
- **Moving the toolchain past 6.0.9 needs a newer clang.** Emscripten 6.0.10 and `main` build their libc
  with `__builtin_wasm_memory_fill`, which nixpkgs' clang 22 and 23.1 don't know, so the patches that
  shipped upstream (0001 in 6.0.10, 0004 in 6.0.11, 0016 after it) stay until nixpkgs' Emscripten moves.

## Protocol

- **Inputs that don't re-encode byte for byte.** JavaScript does not promise to
  preserve a double's NaN payload, so those bits may change. A zero-byte tuple whose
  members are all variable-size and accept zero bytes is normal form to GLib, which
  reads its missing framing offsets as 0; it decodes, and re-encodes with explicit
  zero offsets (the empty `(ayay)` as `00`). Every other accepted input re-encodes
  exactly.
- **Integer-like dictionary keys.** The tree layer preserves entry order; schema
  records follow JavaScript's ordering of integer-like keys. IBus attachment names
  and GSettings schema IDs and keys do not use these keys.
- **Fragment reassembly (M1.3).** The ring reader must reassemble `CONTINUATION`
  fragments before decoding; `decodeRecord` rejects flagged fragments.
- **Lazy lookup decoding (M1.4).** A framed 500-candidate record (64,832 bytes) takes
  1.01 ms median / 4.40 ms p99 under Node v24.21.0 on a Ryzen 9 9950X3D
  (`nix run .#protocol-bench`), twice the 0.5 ms target. Bytes to tree (0.43 ms) and
  tree to schemas (0.46 ms) each take most of the target alone. The panel must decode
  the visible page eagerly and defer the rest; the decoder constructs the whole
  table. See [protocol.md](protocol.md#lookup-decode-measurement).
