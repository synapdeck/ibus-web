# Known gaps

What is open: limits the code knowingly has, work later milestones take on, and minor review findings not yet fixed.
Each item says what is missing and, where it matters, why it was left. An item leaves this page when it is fixed or
decided.

## Toolchain

- **The exnref switch** (spec R18). `-fwasm-exceptions` emits WebAssembly's legacy exception encoding, which Firefox
  warns is deprecated once per Worker that instantiates a module. The standard encoding (`-sWASM_LEGACY_EXCEPTIONS=0`)
  is outside the minimum versions; `checks.toolchain-exnref` fails once every minimum version supports it, which is the
  cue to switch. Until then the test runners filter Firefox's warning out of their output.
- **Dynamic linking with pthreads is "experimental"** by Emscripten's own warning, which `-Wno-experimental` silences
  along with the rest of that warning category. Everything the runtime relies on is tested ([runtime.md](runtime.md)),
  but the combination stays a risk (spec R3).
- **Emscripten and LLVM are paired by nixpkgs** (6.0.9 on clang 22.1.8), which tests that pairing with little more than
  hello-world (spec R12); our own checks are the evidence.
- **Autotools configure scripts can't run their test programs**: autotools configures as a cross build, and only Meson
  has an exe wrapper (Node), so a recipe that needs run-time configure checks will meet it.
- **The dev shell's `.emcache` is never refreshed.** It is copied from the frozen cache only when it doesn't exist, so
  it goes stale when the cache changes; delete it to reseed.
- **Thread fixes not proven red in our checks.** The fix checks for patches 0014, 0015 and 0018 keep the conditions
  their bugs need, but nothing runs them against a toolchain missing their patch; that needs a toolchain and cache built
  with one patch left out. (Emscripten's own suite tests fail without each patch and pass with it; see the drafts.)
- **0018 off our backend.** The heartbeat fix wasn't run with Emscripten's browser OPFS or fetch backends, and a
  `ProxyWorker` thread that ended other than through its destructor would still leave its timer (none can today).
- **0014's upstream test exit path** is reasoned, not run; Emscripten's own
  `other.test_pthread_print_override_modularize` is flaky under load.

## GLib

- **Not built from spec §5.1**: the lazy arity lookup for callbacks with fewer parameters (§5.1.2, R1, waiting on the
  engine audit); a review of the series' `gsettings.c` changes (§5.1.3); the §5.1.4 platform backends (locale,
  collation, localized dates, `TextDecoder` charsets, file monitoring, network, a synthesized user and host).
- **File monitoring.** `testfilemonitor` fails ungated: Emscripten has no file-change notification, and the WasmFS
  monitor backend (spec §5.1.4) is feature work.
- **Tests skipped whole**, not gating: subprocess tests (`mem-overflow`, `deprecated-properties`,
  `network-monitor-race`, `tls-bindings`, gobject's `testing`), Windows-only `print`, `gdbus-address-get-session`,
  `gdbus-tool.py` (needs PyGObject) and the four lint scripts.
- **Platform-skipped subtests.** The locale ones return with spec §5.1.4's backends: collation
  (`/unicode/collate{,-key}/{0,1}`, `/unicode/collate-filename/0`), `/option/arg/repetition/locale`, and localized dates
  and times (`/date/month_substring`, `/GDateTime/modifiers`, the `de_DE` `format_mixed` cases, `/GDateTime/eras/*`).
  The rest stay skipped while their reason holds: sockets and spawning, Unix signals, IPv6 scope IDs and interfaces,
  WasmFS's millisecond file times, TZif files by path, the content-type backend, and `/pollable/unix/pty` (WasmFS has no
  `/dev/ptmx`).
- **WebAssembly guards still in place**, each possible on Emscripten: `g_application_command_line_get_stdin()` returns
  `NULL`; local file and socket streams don't implement `GFileDescriptorBased`; GLib's `unix` and GIO's `unix-streams`
  tests aren't built; local file output streams don't use `writev()`; socket sources and non-blocking sockets are stubs
  (networking is out of scope); the content-type backend maps extensions only (xdgmime would work without
  shared-mime-info data); mount-table features (`filesystem::readonly`, enclosing mounts, trash, the Unix volume
  monitor) are off.
- **The musl `iconv()` workaround (0015) isn't proposed upstream.** It would serve musl and NetBSD users; per-character
  conversion costs one or a few `iconv()` calls per character, on musl only.
- **WasmFS behaviour accepted, not carried as patches**: its stdout and stderr are a line-buffered text console, so
  bytes that aren't UTF-8 are replaced and a last line without a line break gets one, which keeps GLib's tools on
  `-sNODERAWFS`; an empty pipe whose writer is still open reads as end of file, so test-printf's reader waits for its
  writer (0016). A byte-exact stdout under Node would mean writing to the process's descriptors, past `Module.print`.
- **GLib's patches apply with offsets and fuzz** on the current nixpkgs GLib; rebase them on the next GLib bump.

## Runtime

- **IBus API scope.** The runtime supplies engine/data types, components and engine descriptions, a local bus, emitters,
  the framed dispatcher and settings backend. `IBusEngineSimple` still lacks compose, Ctrl+Shift+U and emoji; Latin mode
  therefore leaves ordinary typing to the browser. Only the US keymap exists. `IBusConfig`, `IBusInputContext` and
  `IBusProxy` are declared, for `ibusbus.h`, but not implemented, and the bus's daemon- and application-side requests
  warn once and fail ([runtime.md](runtime.md#ibus-layer)).
- **An engine's own startup code doesn't run yet.** `ibus_main()` and `ibus_quit()` warn once and return, so each
  engine's `main()` (bus, factory, `request_name` or `register_component`, then `ibus_main()`) is replaced by a
  hand-written `ibusweb_module_init`. Running `main()` unmodified needs a module-loading model: compile it under another
  name, call it on a thread of its own with the daemon's arguments (`--ibus`), and have `ibus_main()` report that
  startup is complete and park that thread until `ibus_quit()`, so locals that registered objects point at (Mozc keeps
  its engine on `main()`'s stack) stay alive. Unwinding to JavaScript would free them. Engine callbacks still run on the
  pumping thread, which owns the default main context; `main()` returning, or calling `exit()`, before `ibus_main()`
  would fail the load, and `exit()` would need catching, since it ends the runtime. The parked thread counts toward the
  manifest's `threads`. This is the module-loading ABI, so it waits on the engine API's changes.
- **Native parity scope.** `checks.hangul-differential` compares ten traces at the engine boundary against the pinned
  stock native engine. It does not test browser host/router behavior or live settings. The stock engine's invalid
  final-page digit emits five extra signals and two GLib criticals while both adapters exit successfully; the corpus
  declares that exact upstream outcome. The `hanja-click-page` trace pages forward and back and clicks on the first
  page: stock ibus-hangul, without port 0004, selects by absolute index and diverges from page 2 on, and the comparator
  tolerates only extra native records, so page-2 clicks are covered by the golden tests alone. Comparing what
  `ibus-daemon` and a toolkit client do on top of the engine needs a separate input-context adapter, which must set
  client-side preedit commits and capabilities explicitly, since both change the observable output. See
  [the test adapter](../tools/ibus-test/README.md).
- **An engine's C++ exception poisons the runtime.** The exception unwinds through GLib's signal emission, so
  `ibusweb_dispatch` latches a fault and returns `-ECANCELED`, and the host treats it as a crash. The page must restart
  the engine. Mozc and Rime are C++, so containing it needs a small GLib patch: hook the `marshal(...)` call in
  `g_closure_invoke` and `_g_closure_invoke_va` (`gobject/gclosure.c`) and the source dispatch call in `g_main_dispatch`
  through a C++ `try`/`catch` trampoline that libibus-web sets, so GLib's bookkeeping completes and only the engine
  module is marked faulted. Engine-internal C frames between the catch and the throw would still skip their cleanup, and
  engine modules keep state in globals, so the module would still be torn down; the gain is a clean report instead of
  later corruption. Snapshotting and restoring the heap per request was rejected for its cost. Building GLib with
  `-fexceptions` wouldn't help: unwinding runs only cleanup-attributed locals, and GLib's emission push and pop aren't,
  so it would mean rewriting GLib's internals.
- **No module shutdown call.** The ABI has no shutdown entry point; Hangul's `ibus_hangul_exit` never runs and its
  module globals live for the Worker lifetime.
- **GLib's pool share under concurrent `GTask`s.** The share of 3 covers one `GTask` in flight; each concurrent one can
  take another worker, up to `G_TASK_POOL_SIZE` (10) and beyond. Engines that run `GTask`s concurrently need a rule.
- **No public Emscripten API to grow the pthread pool.** The host's top-up uses Emscripten's internal `PThread`; an
  upstream call to add Workers and settle once they can run threads would replace it. No draft yet.
- **First threads in Chromium** cost about 12 ms each on a pool Worker that has never run one, so a pump that starts
  four takes about 50 ms, past D6's budget. Running a thread on each pool Worker at startup would move that out of
  keystrokes; not tried.
- **Per-Worker memory figures** (about 18 MiB per pool Worker in Chromium, 12–16 MiB in Firefox, 41–42 MiB under Node)
  predate the host's final JavaScript; re-measure once the host and runtime settle.
- **Expected stderr noise isn't marked as such** in check output: `dlopen` errors from refusal cases, and Emscripten's
  `received "7" command from terminated worker` at an `ASSERTIONS` + `PROXY_TO_PTHREAD` exit.
- **WebKit scope.** Production Playwright integration ran pinned Linux WebKit 26.6 in the Nix sandbox with software EGL.
  Safari 17.4/macOS browser-floor behavior and the separate WasmFS IndexedDB-in-Worker matrix remain unverified.

## Engines and page integration

- **Native adapter limits.** Focused commits have a mirror/overlay and native undo. If the field is unfocused or
  `execCommand` is unavailable, the `setRangeText` fallback dispatches a synthetic input event and has no native undo.
  Trusted Chromium blur commit reaches this fallback. Full clipboard and platform-complete navigation remain open; a
  concrete CodeMirror adapter is not shipped. A shortcut the engine declines after the router queued it loses its
  browser action unless the adapter can perform it: the textarea adapter covers undo, redo, select all, cut and copy,
  but not paste, word-wise deletion or navigation, or browser shortcuts such as find. Those are logged as warnings
  instead. See [core.md](core.md).
- **System keyboard layouts.** The existing `us` translation follows physical `event.code`; `default` follows translated
  `event.key`. Arbitrary OS layouts, Dead/AltGr/shortcut behavior and fallback replay have no system-layout matrix. A
  host override/detection mechanism is a future design recommendation.

- **The memory figure counts static data twice.** `heapBytes` is the declared program-break peak, an address that
  includes the static data below the heap, and the manifest's `memory` adds it to the runtime minimum and the module's
  `dylink.0` static size, which count that data already. The figure errs large; declaring the heap alone would need the
  break measured from the heap's base.
- **Connection-time callback audit.** The current cast audit sees explicit casts; it cannot establish every connected
  handler's arity. Hangul needs no lazy arity bridge, and Rime's only connected handlers are the module's own GSettings
  `changed` handlers.
- **Hangul setup.** The `setup` property does not launch an application.
- **Hangul preedit-mode updates.** Module settings stay current even with no live engines. `preedit-mode` takes effect
  in an existing engine on refocus or a capabilities update.
- **Surrounding selection anchor.** The IBus-compatible delete operation updates cached text/cursor but leaves the
  selection anchor unchanged until the host's next `SetSurroundingText`; callers can observe that stale anchor.
- **A shared-path record one module's schema doesn't accept.** Modules can declare different schemas at one path, and a
  record stored there by one module's schema is read by the others'. If another module's schema rejects it (a different
  type, or a value outside its choices or range), that module's Init snapshot and `get` fail until the record changes.
  Live changes already skip such values.
- **Mozc settings that wait for a restart.** Changing `active-on-launch` or the keymap style's turn-on keys takes effect
  when the module next starts, and a switch between romaji and kana at the next focus ([mozc.md](mozc.md#settings)).
  Mozc's keymap and romaji table editors and its user dictionary tool have no equivalent on the page.
- **m17n key bindings and the per-user customisation file.** m17n's key-binding customisation (`minput_config_command`)
  and its per-user `~/.m17n.d` customisation file are not exposed on the page; only input-method variables are
  ([m17n.md](m17n.md#settings-and-variables)).
- **m17n reads every input method at each start.** Listing m17n's input methods parses each `.mim`, so module init reads
  about 212 files, 2.5 MB, at every start: a start from IndexedDB takes 1014–2906 ms in the browsers
  ([m17n.md](m17n.md#in-the-browser)). m17n keeps no index of its own; a cached list, or each input method read on first
  use, would need changes to m17n-lib or ibus-m17n's listing.
- **`Init` carries every settings instance.** m17n's `Init` declares each of its 232 instances, 22,378 bytes with
  nothing stored, of the 64 KiB request slot ([m17n.md](m17n.md#checks)). A user who stores many values across m17n's
  per-engine instances could push `Init` past the slot, which `Connection.requestAsync` rejects with a `RangeError`, and
  the module would fail to start.
- **Rime's prisms for dictionaries not yet installed.** A settings change deployed while some dictionaries aren't
  installed leaves their prisms as prebuilt, so a `fuzzy-pinyin` change reaches an engine installed later only at the
  next deployment ([rime.md](rime.md#deployment)).
- **A change to Rime's page size or keys recompiles every schema.** `default.custom.yaml` reaches every compiled schema,
  so changing `page-size`, `switcher-hotkeys` or `ascii-toggle-key` recompiles them all and rebuilds every installed
  dictionary's prisms in the user's directory, about 3 s on Rime's deployer thread under Node, during which keys pass
  through ([rime.md](rime.md#settings)).
- **Rime takes no files of the user's own.** Its configuration comes only from the settings the module writes as
  `*.custom.yaml`: a page can't add a YAML patch beyond what the settings schema offers, or a custom phrase file, and
  nothing moves Rime's user directory in or out of the module's storage ([rime.md](rime.md#settings)).
- **Rime has no grammar model.** `librime-octagram` is built but no shipped schema configures a grammar: upstream
  replaces RIME-LMDG's model, 398 MB, in place, so it can't be pinned ([rime.md](rime.md#librime)).
- **Table sessions each copy their candidate list.** An open bare `\` in LaTeX holds all ~2,749 candidates, about
  100–200 KB, in that input context's session. The 4 MiB `heapBytes` of the table module was measured with one such
  context open. Many simultaneous open compositions would need a candidate view the sessions share or borrow, or a
  larger `heapBytes`.

- **Rime in a second tab is nearly unusable.** Only one tab holds a module's writer lock, so the data is safe, but a
  read-only Rime can't open its user dictionaries: LevelDB opens its `LOCK` file read-write, which the read-only mount
  refuses. Rime then runs a recovery task, which fails too, and the module resets every session on that failure:
  compositions are cut off mid-word, nothing learned shows, and "Rime has encountered an error." repeats. Mozc in a
  second tab loads the writer's data but silently loses its own learning.
- **Rime's user dictionary recovery can discard learning.** If the writer's LevelDB open ever fails (`EIO`, IndexedDB
  closing, a full quota, corruption LevelDB can't repair), librime renames the database to `.old` and starts it empty,
  restoring only from a sync snapshot, which nothing makes; a second failure deletes the live database.
- **A failed held log write is only logged.** The module holds a user dictionary's log writes back until input pauses
  ([rime.md](rime.md#learning)); when one then fails, it logs a warning, but LevelDB, told earlier that the write
  succeeded, never enters its error state.
- **Rime's heap in the worst case passes 150 MiB.** A redeployment that ends with the break at 125 MB, followed by a
  session that loads `rime_ice`'s 60.7 MB table above it, would pass the declared 150 MiB. The traced sessions added
  nothing or 8.4 MB, and none of 36 runs reached it ([rime.md](rime.md#distribution)).
- **Backspace can't take a commit back after `Persist`.** Hiding the tab sends `Persist`, which commits Rime's learning,
  so a Backspace afterwards takes nothing back.
- **WebKit's `unload()` and `dispose()` with unsaved learning** wait `hangMs` (2 s by default) and still lose it:
  WebKit's Workers reach IndexedDB through the page's main thread, which the wait holds
  ([core.md](core.md#layers-and-page-lifetime)).

## Storage

- **A shared content-addressed store (future design).** Today every module version installs its whole closure into its
  own data database. The proposed replacement is one IndexedDB database, mounted read-only at `/nix/store` in every
  module Worker with one backend thread per Worker. Each store path would be installed once and reused by all modules
  and versions referencing it. Content addressing avoids the half-updated-tree failure that motivated a database per
  version. No install lock or per-path marker is planned: the backend already reads and bumps `nextIno` in the same
  readwrite transaction as the entry's `add`, and IndexedDB serializes overlapping readwrite transactions across
  connections. Installers would extract to private staging names, then rename onto the store path in one transaction; a
  loser would discard its identical staging copy, and readers would see only whole paths. Deletion would require every
  Worker to hold a shared Web Lock for each path it uses; deletion would take that lock exclusively with `ifAvailable`.
  The staging and the rename exist for an engine's own data ([storage.md](storage.md#an-engines-own-data)): each store
  path is extracted under a staging name and renamed onto its path in one transaction, and an interrupted staging tree
  is swept by the next install of the path. They rely on the path's install lock, though: WasmFS's rename replaces an
  empty directory and the backend's move replaces any entry, so the installer checks the target is absent under the
  lock, and only one host stages a path at a time. Without the lock, concurrent installers would need private staging
  names of their own and a move that refuses an existing target, and the sweep would need to tell a dead installer's
  tree from a live one's. The shared database, the lock-free installs and per-path deletion are not implemented.

- **Host API**: usage report, export and reset (spec §5.6), and the quota `storage` events of spec §8, aren't built.
- **`storage: closed` waits for a wake.** The host notices a closed connection only when it next wakes, so a version
  change while the engine is idle goes unreported until a request or a GLib source wakes it. The relay could wake it, or
  the page could restart the Worker on its own `versionchange`.
- **A writer that unlinks a file another tab has open** deletes its inode at once: open counts are per connection, so
  the reader's next read fails with `ENOENT`. No current engine meets it: engine data is never unlinked, a read-only
  Rime fails at LevelDB's `LOCK` before it opens any of a user dictionary's files, and Mozc reads its files whole.

- **The backend's internals are runtime exports.** `_wasmfs_idb_record_entry` and `_wasmfs_idb_set_string` are
  `EMSCRIPTEN_KEEPALIVE`; only the export manifest keeps side modules off them.
- **Node.** The Node backend has no read-only mode, so a read-only mount and a seal are conventions there; Web Locks
  don't coordinate separate Node processes sharing a directory; and the Node marker's directory sync swallows every
  error, `EIO` included.
- **The memory fallback's headroom for metadata.** Without IndexedDB the memory grows by the page-rounded data size,
  which covers file contents only; WasmFS's file objects and directory entries come out of the base memory's spare,
  which a manifest of many small files could exhaust.
- **The install window is weaker than the seal.** While a host installs an engine's own data, its data backend takes
  changes from any thread of its runtime, an engine's included. None writes there, and the window lasts as long as
  extractions overlap.
- **An install of an engine's own data cut short leaves its staging tree** in the version's database until the next
  install of the path sweeps it; its bytes are counted nowhere meanwhile. A failed install removes its own, unless the
  runtime can no longer be called or the removal fails.
- **A memory mount installs every engine's own data at start**, since its memory can't grow: without IndexedDB a page
  downloads the data of engines it never selects.
- **Real quota failures** aren't reached in tests; the backend's tests inject the state one leaves.
- **Measurements on one machine.** The fsync and storage figures come from one host's ZFS. Chromium's 64 KiB cliff is
  attributed to Blink's value wrapping, not traced; Firefox's out-of-line threshold is measured (between 768 and 896
  KiB), not read from its source.
- **WebKit's IndexedDB in Workers** is checked only through Rime's browser tests (spec R5, R13): the backend's own
  programs (`checks.wasmfs-idb-browser`) run in Chromium and Firefox.
- **The backend's costs**: every `open()` costs one read-only transaction; the open/unlink race is argued in a comment,
  not tested.
- **Installing writes in 64 KiB pieces.** Each piece of a file's data is one write transaction at a 64 KiB boundary of
  the file, which covers the 16 KiB chunks the backend creates whole; in a database created with chunks that don't
  divide 64 KiB, most writes would cover a chunk in part at each end and read it first. Installing is off the request
  path.
- **Test hooks**: the chunk counter doesn't count `getAllKeys()` or cursors, and a `get()` of a hole counts nothing; the
  injected delete fault aborts synchronously, as a body that throws rather than a commit that aborts; the browser
  `install-torn-marker` case writes a non-marker value, since a browser's commit can't tear.

## Worker host

- **Node hosts are for tests only.** Node's Web Locks grant one exclusive lock to two `worker_threads` at once in about
  3% of races (12 of 300 with `ifAvailable`, 8 of 300 queued; Node 24.21.0), so two Node hosts started together can both
  become writer or both install one version. Node suites start hosts that share storage one at a time; a Node store that
  needs real exclusion would take an `O_EXCL` lock file or an `Atomics` lock.
  [Draft bug report](upstream/node-web-locks-worker-threads.md).
- **The published packages aren't released.** `@ibus-web/protocol`, `@ibus-web/worker-host`, `@ibus-web/core`,
  `@ibus-web/panel` and `ibus-web` are publishable, but their versions stay `0.0.0` and nothing publishes them. Releases
  are to be versioned with Changesets, with a CI workflow that bumps versions and publishes to npm; neither is set up
  yet.
- **Test-harness leftovers**: the failing-relay temporary copies and the Node scratch directory aren't removed; the Node
  archive server in the Vitest config process is `unref`'d, not closed; Vite's unanalyzable-import warning is filtered
  by its text.
- **WebKit IndexedDB stalls for other engines.** In WebKit a Worker reaches IndexedDB through the page's main thread,
  which spins on a key's reply; a key whose work waits on IndexedDB waits until the page gives up on the reply. Rime
  holds its writes back until input pauses, but no host guard lets the page stop waiting for other engines.

## Testing

- **Output a pthread prints just before exit can be lost**: Emscripten stubs the pthreads' `onmessage` during
  `exitRuntime`. A program that wants its output joins its threads first.
- **Browser durations patch `TestRunner.prototype`**, since Vitest 5.0.3's browser mode ignores `test.runner`; the
  duration checks in `checks.testing-programs` catch a Vitest update that breaks it. The program-level suite time isn't
  asserted.
- **Pool sizes in wasmfs-idb's checks are hand counts** (`backends` per program); a count too low fails the program's
  cases under `-sPTHREAD_POOL_SIZE_STRICT=2` rather than being derived.
- **A failed check keeps no `results.json`**: the derivation's output exists only when it passes, so a failure's results
  are in the log alone.
- **The library checker leans on the jsifier's shape.** `tools/emscripten-library-deps/library-deps.ts` finds the test
  that tells a function's source held in a string by its shape in Emscripten's jsifier (the one `if` whose block sets
  `isFunction` and whose test reads `snippet`), so an Emscripten that restructures it fails the check rather than being
  followed; and whatever name `addImplicitDeps` needs that the checker's context lacks fails with one catch-all message,
  naming it only through the engine's `ReferenceError`.
- **The worker-host browser tests' output settle rests on delivery order.** A test takes what the host's Workers printed
  once a line printed by a Worker started for the purpose has arrived, which assumes Playwright delivers console
  messages across Worker targets in the order the browser sent them. A line that arrived later anyway would fail the
  next test as unexpected output, not pass unseen; if that ever happens, the fix is a marker printed by the host's own
  Workers.
- **A check's Vitest file shows under its store name** (`../../../<hash>-fixes.test.ts`): it is copied into the store
  alone, so it can't use relative imports.
- **The workspace output copies the root `node_modules`** (disk only): it can't link to the shared install's instead,
  since pnpm's hoisted `.pnpm/node_modules` links to the workspace packages by relative paths, which would then resolve
  inside the install, where the packages hold no sources.

## Tooling

- **The pre-commit hook needs the dev shell.** A commit from a shell without `hk` on `PATH` fails unless it sets `HK=0`;
  commit with `nix develop -c git commit …` or from a direnv shell. The hook stashes unstaged work (`stash = "git"`)
  while it runs.
- **hk's own problems have no upstream reports**: pklr leaves interpolation in multi-line strings unexpanded, its HTTP
  client wants a CA bundle even offline, and nixpkgs' hk embeds no pkl package (hence the Nix-built `.hk` link).
- **`write-files` in the dev shell** brings nushell and git into its closure.

## CI

- **Cold-run disk.** A cold run rebuilds the patched Emscripten and everything WASM, and may exhaust `ubuntu-latest`'s
  some 14 GB of free disk; a disk-freeing step (such as `DeterminateSystems/nothing-but-nix`) or a larger runner would
  fix it.
- **Fork pull requests** get no cache (FlakeHub Cache can't authenticate their OIDC tokens); their behaviour is
  unverified.
- **FlakeHub visibility follows the repository's**, read from `github.event.repository.private` at each publish.
  FlakeHub's documentation doesn't say whether a publish changes an existing flake's visibility; if the first publish
  after the repository goes public leaves the flake private, change it once in FlakeHub's settings.
- **Only x86_64-linux is checked**; the flake's checks are defined for Darwin and aarch64 too.
- **The files writer never deletes** a file it no longer configures; a removed workflow needs `git rm`.

## Upstream

- **Most reports are filed; some fixes and one proposal aren't.** [upstream/README.md](upstream/README.md) lists what is
  left to post, in order (two PRs, a Node issue, two Emscripten issues, the follow-up PRs for filed issues, and the
  IndexedDB backend proposal), and what was filed where.
- **IBus's observed paths serialize `mtime` wrongly on 32-bit targets.** `mtime` is a `glong`, but its serializer passes
  it to a 64-bit `"x"` through varargs and its deserializer writes 64 bits over it and the field after it. The vendored
  `ibusobservedpath.c` carries the fix; no upstream report is drafted yet.
- **Moving the toolchain past 6.0.9 needs a newer clang.** Emscripten 6.0.10 and `main` build their libc with
  `__builtin_wasm_memory_fill`, which nixpkgs' clang 22 and 23.1 don't know, so the patches that shipped upstream (0001
  in 6.0.10, 0004 in 6.0.11, 0016 after it) stay until nixpkgs' Emscripten moves.

## Protocol

- **Inputs that don't re-encode byte for byte.** JavaScript does not promise to preserve a double's NaN payload, so
  those bits may change. A zero-byte tuple whose members are all variable-size and accept zero bytes is normal form to
  GLib, which reads its missing framing offsets as 0; it decodes, and re-encodes with explicit zero offsets (the empty
  `(ayay)` as `00`). Every other accepted input re-encodes exactly.
- **Integer-like dictionary keys.** The tree layer preserves entry order; schema records follow JavaScript's ordering of
  integer-like keys. IBus attachment names and GSettings schema IDs and keys do not use these keys.
