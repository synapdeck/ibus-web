# M0.4: Runtime skeleton and Worker spike — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish M0 by proving the runtime skeleton: `pkgsWasm.glib` linked
into `ibus-runtime.wasm` as a `-sMAIN_MODULE=2` main module with a minimal
`libibus-web`, side modules loaded into it (trivial, pthread-starting, C++
exception), and a TypeScript Worker host whose request loop blocks in
`Atomics.wait` while threads, proxied calls and WasmFS keep working — in
Node and in Chromium and Firefox — answering R2 and R3 and settling the
runtime's memory choice (§5.3).

**Architecture:** `runtime/libibus-web/` is a small C library (Meson,
built with `pkgsWasm.stdenv`) holding the pump, the side-module loader and
a spike dispatcher. A GLib patch lets the default context's wakeup also
notify a word the Worker host waits on (the pump hook, §5.1.3/§5.2.4).
`modules/runtime/` links `ibus-runtime.wasm` with a derived, versioned
export list. Spike side modules and a spike Worker host
(`tests/spikes/runtime/`) exercise the R2 scenarios under Node
(`worker_threads`) and under Playwright in Chromium and Firefox against a
COOP/COEP server. The TypeScript lives in a pnpm workspace built offline in
Nix (`fetchPnpmDeps` + `pnpmConfigHook`), the foundation M1's packages
extend.

**Tech Stack:** Nix flake (flake-parts, import-tree), nixpkgs Emscripten
6.0.9 plus `modules/emscripten/patches`, GLib 2.88.3 (`pkgsWasm.glib`),
C/Meson, TypeScript (pnpm 11, `tsc`), Node 24, Playwright 1.61.1 with
nixpkgs' Chromium and Firefox.

## Global constraints

- nixpkgs revision: `8ce4ef6cb6f871616146b9fe26d2a5ae594e94fe`, locked through `flake.lock`.
- Emscripten is `ibusWeb.toolchain.emscripten` (nixpkgs' build plus `modules/emscripten/patches`), used by the cache, the cross stdenv, the dev shell and clangd; never `pkgs.emscripten` or `pkgsBuildBuild.emscripten` directly. Small fixes to Emscripten are allowed when tracked upstream; no forked compiler or LLVM; never `-sEMULATE_FUNCTION_POINTER_CASTS`.
- Every WASM object is compiled with `ibusWeb.toolchain.commonFlags` (`-O2 -fPIC -pthread -fwasm-exceptions`); check and test links add `-sASSERTIONS=1`.
- **Derive, don't hardcode:** versions, target prefixes, triples, store paths and symbol lists come from Nix evaluation or the build, never literals.
- Dendritic layout: every `.nix` file under `modules/` is a flake-parts module; modules share values only through `ibusWeb.*` per-system options and flake outputs. One directory per component (`modules/<component>/` with `overlay.nix`, `patches/`, `checks/`). Non-Nix files sit beside their module under plain names.
- Outputs: `packages.<system>` holds only ibus-web's own artifacts (`ibus-runtime` and its parts); WASM builds of nixpkgs packages are reached through `legacyPackages.<system>.pkgsWasm`.
- Main modules are linked with `em++` (`$CXX`); C sources are compiled with `$CC -c` first.
- §9.2 boundary rules: Workers load by URL, never inlined; **the page communicates only through the dedicated SAB and `postMessage`, never touches WASM memory, and the protocol never carries pointers into it.** A spike design that needs to break this stops for the user's decision.
- Cross-origin isolation for browser runs: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on every response.
- TypeScript: one pnpm workspace at the repository root; dependencies via `fetchPnpmDeps` (`pnpm_11`, `fetcherVersion = 4`) installed offline with `pnpmConfigHook`; `strict`, `erasableSyntaxOnly` (so Node can run sources directly while iterating); `tsc` emits the JavaScript browsers load. The `playwright` package version equals nixpkgs' `playwright-driver` version, and browsers come from `playwright-driver.browsers` (never downloaded).
- Hand-written JavaScript/TypeScript uses modern syntax (Baseline "Widely available" ∩ the oldest supported Node): `const`/`let`, arrows, template literals, destructuring, `for…of`, `?.`/`??`.
- GLib changes are new commits of ours in the scratch clone `.superpowers/sdd/glib-port/glib` (branch `ibus-web`), re-exported to `modules/glib/patches/`; never edit third-party commits.
- New files carry SPDX headers (`SPDX-FileCopyrightText: 2026 Synapdeck, Inc.`; `MIT OR Apache-2.0` for repository code, `LGPL-2.1-or-later` for `libibus-web` and code added to GLib); `checks.reuse` enforces it.
- Comments explain why, not what, and never refer to other files, this plan or its history.
- `nix flake check` passes at the end of every task. Flakes only see git-tracked files: `git add` before `nix` commands.
- Stage named paths only (never `git add -A`/`.`/`commit -a`); check `git diff --cached --stat` before committing. The user edits files concurrently: leave changes you didn't make; never `git checkout`/`restore`/`stash`.

## File map

| Path | Change | Responsibility |
|---|---|---|
| `modules/glib/patches/0017-*.patch`, `README.md` | create / modify (Task 1) | WebAssembly pump hook: the default context's wakeup also notifies a host word |
| `runtime/libibus-web/` (`meson.build`, `include/ibus-web/runtime.h`, `src/*.c`) | create (Task 2) | pump, side-module loader, spike dispatcher |
| `modules/runtime/libibus-web.nix`, `modules/runtime/checks/libibus-web/` | create (Task 2) | build and C tests |
| `modules/runtime/ibus-runtime.nix`, `modules/runtime/exports.nix` | create (Task 3) | the main-module link and its derived, versioned export list |
| `tests/spikes/runtime/sides/*` | create (Task 3) | spike side modules |
| `modules/toolchain/cache.nix` | modify (Task 3) | cache variants the runtime link needs |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `modules/typescript/default.nix` | create (Task 4) | the pnpm workspace and its offline Nix build |
| `tests/spikes/runtime/{package.json,tsconfig.json,src/**}` | create (Tasks 4–6) | spike Worker host, scenarios, Node and browser harnesses |
| `modules/spikes/runtime/default.nix` | create (Tasks 5–6) | `checks.runtime-spike-node`, `checks.runtime-spike-browser` |
| `docs/spikes/2026-10-01-runtime-worker.md` | create (Tasks 5–7) | spike report |
| `docs/specs/2026-09-26-ibus-web-design.md`, `docs/plans/…` | modify (Task 8) | R2, R3, §5.2.4, §5.3, M0 rows |

---

### Task 1: The pump hook in GLib

On WebAssembly, `g_wakeup_signal()` (patch 0013, futex-based) wakes threads
sleeping in GLib. The runtime's Worker host sleeps outside GLib, in
`Atomics.wait`, so the default context's wakeup must also notify a word the
host waits on (spec §5.1.3, §5.2.4). Which word, and in which memory, is
Task 5's question; this task provides the mechanism in GLib.

**Files:** scratch clone (new commit of ours), `modules/glib/patches/0017-*.patch`, `modules/glib/patches/README.md`, `modules/glib/checks/smoke/glib-test.c`.

**Interfaces:**
- Produces (WebAssembly only, declared in a GLib header installed with the library, e.g. `glib/gwakeup-wasm.h` or a section of `gmain.h` under `#ifdef G_PLATFORM_WASM`):
  ```c
  /* Called from whichever thread signals the context's wakeup, after the
   * wakeup's own futex has been woken. */
  typedef void (*GWasmWakeHook) (gpointer user_data);
  void g_main_context_wasm_set_wake_hook (GMainContext  *context,
                                          GWasmWakeHook  hook,
                                          gpointer       user_data);
  ```
  A C hook (not a raw word) keeps the choice of word and memory out of GLib: `libibus-web` decides what the hook does (Task 2/5).

- [ ] **Step 1:** Tag the clone's tip `ibus-web-pre-m0-4`. Add the hook to the WebAssembly `GWakeup`: a hook pointer and user data, set through `g_main_context_wasm_set_wake_hook()` on the context's wakeup, called from `g_wakeup_signal()` after `emscripten_futex_wake()`. Thread-safe publication (set once before use; read with an atomic load). No effect on other platforms (compile-time guard).
- [ ] **Step 2:** Smoke test (`glib-test.c`): set a hook on the default context that counts calls atomically; acquire the default context on the main thread; from a `GThread`, `g_idle_add()` a source; assert the hook ran (counter > 0) and the source dispatches on the next `g_main_context_iteration(NULL, FALSE)`. Also assert that with the context *not* acquired, an attach from another thread does not call the hook (documents why the pump must own the context). Print `wakehook 1 0` and grep it in the check.
- [ ] **Step 3:** Re-export the series (`git format-patch --no-signature -o <repo>/modules/glib/patches nixpkgs-2.88.3..ibus-web`), document 0017 in the README, run `checks.glib-patches`, `checks.glib`, `checks.glib-tests` (results unchanged), `nix flake check`. Commit.

### Task 2: `libibus-web` skeleton

The minimal C library the Worker host drives. No IBus types yet (M1).

**Files:** `runtime/libibus-web/meson.build`, `runtime/libibus-web/include/ibus-web/runtime.h`, `runtime/libibus-web/src/{runtime.c,pump.c,module.c,dispatch.c}`, `modules/runtime/libibus-web.nix` (derivation exposed as `ibusWeb.runtime.libibusWeb` and `packages.libibus-web`), `modules/runtime/checks/libibus-web/{default.nix,test-runtime.c}`.

**Interfaces (Produces, `ibus-web/runtime.h`):**
```c
/* Runtime ABI version; the export list (Task 3) is versioned by it. */
#define IBUSWEB_RUNTIME_ABI 0

/* One-time setup on the thread that will pump: acquires the default
 * GMainContext for the Worker's lifetime (so GLib signals the wakeup for
 * sources attached from other threads) and installs the wake hook. The
 * hook increments *wake_word and wakes its waiters; wake_word lives where
 * Task 5 decides (initially in WASM memory). */
int ibusweb_runtime_init (int32_t *wake_word);

/* Dispatches every pending source without blocking; returns the delay in
 * milliseconds until the next source deadline, or -1 if none. */
int32_t ibusweb_pump (void);

/* Loads a side module with dlopen() and calls its exported
 * ibusweb_module_init(IBusWebModule *); returns 0 or a negative errno. */
typedef struct _IBusWebModule IBusWebModule;
int ibusweb_load_module (const char *path, IBusWebModule **module_out);

/* Spike dispatcher: a request is an opcode plus a payload; replies are
 * written into a caller-provided buffer. Opcodes are the spike scenarios'
 * entry points the side modules register through IBusWebModule. */
int32_t ibusweb_dispatch (const uint8_t *request, uint32_t request_len,
                          uint8_t *reply, uint32_t reply_cap);
```
`IBusWebModule` (opaque) lets a side module register named spike operations (`void (*)(const uint8_t *, uint32_t, GString *)`), so scenarios live in side modules, not the runtime.

- [ ] **Step 1: Failing test.** `test-runtime.c` (linked with `toolchain.testMainFlags`, run under Node) asserts: `ibusweb_runtime_init(&word)` returns 0; a `GThread` that `g_idle_add`s a source increments `word` (wake hook) and the next `ibusweb_pump()` dispatches it; `ibusweb_pump()` returns the remaining delay for a `g_timeout_add(250, …)` source (200–250 ms) and -1 with no sources; `ibusweb_dispatch` returns an error for an unknown opcode. Build it to see it fail (no library yet).
- [ ] **Step 2: Implement** with Meson (`pkgsWasm.stdenv`, `dependency('glib-2.0')`, `dependency('gmodule-2.0')`), installing a static library, the header and a `.pc`. `ibusweb_load_module` uses `dlopen`/`dlsym` (Emscripten dynamic linking).
- [ ] **Step 3:** Check passes; register `libibus-web` in `ibusWeb.toolchain.devLibraries`; `nix flake check`; commit.

### Task 3: `ibus-runtime.wasm` and spike side modules

**Files:** `modules/runtime/ibus-runtime.nix` (`packages.ibus-runtime`: `ibus-runtime.js`, `ibus-runtime.wasm`, `exports.txt`), `modules/runtime/exports.nix` (derives the export list), `modules/toolchain/cache.nix` (new probe variants), `tests/spikes/runtime/sides/{trivial.c,thread.c,throw.cpp,fsync.c}`, `modules/runtime/checks/runtime-link/{default.nix,…}`.

**Requirements:**
- Link: `em++` with `-sMAIN_MODULE=2`, the export list, `-sWASMFS=1` with the OPFS backend available (`wasmfs_create_opfs_backend` reachable from JS/C), `-sPTHREAD_POOL_SIZE=<n>` (choose and justify; the pool is pre-allocated so thread creation never yields, R2), `-sSTACK_SIZE=1MB` and `-sDEFAULT_PTHREAD_STACK_SIZE=1MB` (GRegex, §5.3), `-sMODULARIZE=1 -sEXPORT_ES6=1`, `-sENVIRONMENT=web,worker,node`, `-sEXIT_RUNTIME=0`. Memory: start with growth off and a fixed size large enough for the spike (`-sINITIAL_MEMORY` chosen from measured needs); Task 7 settles the final rule. Release build without `-sASSERTIONS`; a second, asserting build for the checks.
- **Export list, derived:** every global function and data symbol of `libibus-web`, `libglib-2.0`, `libgobject-2.0`, `libgmodule-2.0`, `libgio-2.0` (the GIO subset built), `libffi`, plus the C/C++ runtime symbols side modules need (libc, libc++/libc++abi — derive from Emscripten's own system library symbol lists or from what the spike side modules import, and justify the choice). Generate it in a derivation (e.g. `llvm-nm --defined-only --extern-only` over the static libraries from `ibusWeb.toolchain.emscripten.llvmEnv`), sorted, with a header line naming `IBUSWEB_RUNTIME_ABI`. A check fails if a side module imports a symbol the list lacks (`wasm-objdump`/`llvm-nm` on the side modules vs the list).
- **Side modules** (`-sSIDE_MODULE=1`, `commonFlags`), each exporting `ibusweb_module_init` that registers spike operations:
  - `trivial.c`: op `add` returns the sum of two `int32`s.
  - `thread.c`: op `idle-later(ms)` starts a `GThread` that sleeps `ms` then `g_idle_add`s a source that records the dispatch time; op `idle-result` returns the delay between attach and dispatch. Op `spawn(n)` creates `n` threads from a pumped source and joins them, reporting success.
  - `throw.cpp`: op `throw` throws a C++ exception caught in the runtime-side C++ wrapper around the op call (the runtime catches and returns an error reply), proving cross-module exceptions.
  - `fsync.c`: op `fsync(path)` starts a pthread that creates the file, writes, `fsync()`s and closes it, signalling completion through a source on the default context.
- **Node smoke (C level, no TypeScript):** a small Node script in the check instantiates the asserting runtime build, calls `ibusweb_runtime_init`, loads each side module and calls each op through `ibusweb_dispatch`, asserting replies. (The TS host comes in Task 5.)
- [ ] Steps: write the link check expecting the replies (fails), implement the link, export list and side modules, pass, extend cache probes until `checks.toolchain-cache` covers the runtime's flag combinations against the read-only cache, `nix flake check`, commit.

### Task 4: pnpm workspace and TypeScript build

**Files:** `package.json` (root, private, `packageManager: pnpm@<pnpm_11 version>`), `pnpm-workspace.yaml` (`packages: ["tests/spikes/*", "packages/*"]`), `pnpm-lock.yaml`, `tests/spikes/runtime/package.json` (`@ibus-web/spike-runtime`, private; devDependencies `typescript`, `@types/node`, `playwright` = nixpkgs `playwright-driver` version, derived and checked), `tests/spikes/runtime/tsconfig.json` (`strict`, `erasableSyntaxOnly`, `module`/`moduleResolution` `nodenext`, `target` ES2023, `lib` with DOM and WebWorker), `modules/typescript/default.nix`.

**Interfaces:**
- Produces `ibusWeb.typescript.workspace`: a derivation that installs the workspace offline (`fetchPnpmDeps` with `pnpm_11`, `fetcherVersion = 4`, `pnpmConfigHook`), runs `pnpm -r exec tsc -p .` and outputs each package's `dist/` (the JavaScript browsers load) and sources; `checks.typescript` runs `tsc --noEmit` across the workspace. Node in checks runs the emitted `dist/` (deterministic); developers may run sources directly with Node 24 while iterating.
- The dev shell gains `pnpm_11` and Node 24 (spec §10.6).
- [ ] Steps: a placeholder `src/index.ts` that type-checks, the Nix module with the deps hash, `checks.typescript` failing on an introduced type error then passing, a check that the `playwright` version equals `pkgs.playwright-driver.version`, `nix flake check`, commit.

### Task 5: Spike Worker host and the Node harness (R2)

**Files:** `tests/spikes/runtime/src/host/worker.ts` (the Worker host), `src/host/control.ts` (control-header layout and helpers), `src/scenarios.ts` (scenario definitions shared by both harnesses), `src/node/run.ts` (Node harness: `worker_threads`), `modules/spikes/runtime/default.nix` (`checks.runtime-spike-node`), `docs/spikes/2026-10-01-runtime-worker.md`.

**Host (spec §5.5 steps 1–4, spike-sized):** receives the compiled runtime module (or its URL), a dedicated control SAB and the side-module list by `postMessage`; instantiates the runtime; mounts storage (memory in Node; OPFS in browsers, Task 6); loads the side modules; calls `ibusweb_runtime_init`; enters the request loop — `Atomics.wait` with the pump deadline as timeout, then dispatch or pump, write the reply, repeat. Requests use a minimal spike layout of §6.2.1's control header (`state`, `reqSeq`, `reqLen`, `replyRet`, plus a request/reply slot); no ring or GVariant yet.

**The open design question — the wake word (decide here, with evidence):** the host must sleep on one word and be woken both by the page (a request) and by GLib (the Task 1 hook, from any pthread). §9.2 forbids the page touching WASM memory. Try, in order, and record each result in the spike report:
1. **Hook notifies the control SAB:** the wake hook (`EM_JS`) does `Atomics.add`/`Atomics.notify` on the control SAB's wake word, made reachable from every pthread's JS realm (e.g. passed to pthread Workers at startup through an Emscripten hook such as `Module` settings propagated to workers, or `emscripten_pthread`-level init code). Host waits on the control SAB word. Keeps §9.2.
2. **C wait loop:** the host calls into the runtime (`ibusweb_wait(timeout)`), which waits with `emscripten_futex_wait` on a word in WASM memory (processing the proxy queue — spec R2's first option), and a relay maps page requests to that word without the page touching WASM memory. Record whether such a relay exists without a JS event loop turn.
3. If neither works without breaking §9.2, **stop and report** with the evidence; the user decides (e.g. placing the control header in WASM memory changes §6.2/§9.2).

**Scenarios** (each with a pass criterion and a measured number, Node first):
- `dispatch`: 1000 `add` round trips; report p50/p99 latency.
- `cross-thread-wake`: `idle-later(50)`, host idle with a long deadline; the source is dispatched within 50 ms + ε of the attach (report ε; fail above 20 ms).
- `deadline`: `g_timeout_add(100)` with no requests; dispatched at 100 ms ± 10.
- `thread-create-blocked`: `spawn(n)` for n = pool size and n = pool size + 1 while the host sleeps between requests; record whether creating beyond the pool hangs, fails or succeeds (R2).
- `sync-proxied`: a pthread performs a call Emscripten proxies synchronously to the Worker's thread (e.g. a JS-library call marked `__proxy: 'sync'`, or a WasmFS operation that proxies) while the host is in `Atomics.wait`; record whether it completes, under option 1 vs 2.
- `promise-proxied-fsync`: `fsync(path)` from a pthread while the host waits; record whether it completes (WasmFS memory/Node backends; OPFS in Task 6).
- `exceptions`: `throw` returns the error reply; runtime keeps working.
- [ ] Steps: write `scenarios.ts` and the Node harness with all scenarios expected to pass (red until the host exists); implement the host; iterate on the wake mechanism; record results and decision in the spike report; `checks.runtime-spike-node` runs the harness under the TS build's `dist/`; `nix flake check`; commit. **Checkpoint:** if the wake mechanism needs a spec change (option 3), stop here for the user.

### Task 6: Browser harness (Chromium and Firefox)

**Files:** `tests/spikes/runtime/src/browser/{server.ts,page.ts,index.html,run.ts}`, `modules/spikes/runtime/default.nix` (`checks.runtime-spike-browser`), optionally `modules/playwright/default.nix` exposing `ibusWeb.testing.playwright` (browsers path, env) for reuse in M1.

**Requirements:**
- `server.ts`: Node HTTP server serving the runtime, side modules and `dist/` with COOP/COEP headers (Global constraints) and correct MIME types (`application/wasm`, `text/javascript`).
- `page.ts`: creates the Worker by URL (`new Worker(url, { type: "module" })`), sends the compiled `WebAssembly.Module` and SAB, runs `scenarios.ts`, reports JSON results.
- `run.ts`: Playwright (`playwright` package, `chromium` and `firefox` from `PLAYWRIGHT_BROWSERS_PATH` = nixpkgs' `playwright-driver.browsers`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`), headless, asserting `crossOriginIsolated === true`, then each scenario's pass criterion. Plus an `opfs` scenario: mount WasmFS's OPFS backend at `/engines/spike/`, write, `fsync`, read back, and `promise-proxied-fsync` on the OPFS mount.
- Runs inside the Nix sandbox (no network); if a browser can't run in the sandbox (e.g. user namespaces), document the flags used (`--no-sandbox` for Chromium only if required, and why) and keep the check runnable offline.
- [ ] Steps: harness red, server and page, green in Chromium, then Firefox (record engine differences: `Atomics.wait` in Workers, OPFS sync access handles, timing), spike report updated, `nix flake check`, commit.

### Task 7: Memory growth (§5.3)

**Files:** `tests/spikes/runtime/sides/memstress.c` (or a standalone program), `tests/spikes/runtime/src/scenarios.ts` (stress scenario), `modules/runtime/ibus-runtime.nix` (final memory flags), spike report.

**Requirements:** reproduce the GLib-suite trap pattern without GLib (many pthreads allocating and touching fresh memory while memory grows) and with GLib (the `1bit-emufutex`-style workload), under memory growth and under fixed memory, in Node (≥ 300 runs), Chromium and Firefox (≥ 50 runs each). Decision rule (user-approved): **if growth traps in any engine, the runtime uses fixed per-Worker memory, sized from the manifest (runtime + side module + data, with margin); otherwise growth.** Implement the chosen rule in the link (and, for fixed memory, how the size is chosen — a manifest field the host passes, or a per-engine link), record the evidence. If a GLib-free reproduction appears, add it to `docs/upstream/` as a draft (V8/SpiderMonkey/Node or Emscripten, per the evidence).
- [ ] Steps: stress harness, runs, decision, link change, `nix flake check`, commit.

### Task 8: Settle R2 and R3; spec and plan

**Files:** `docs/specs/2026-09-26-ibus-web-design.md`, `docs/spikes/2026-10-01-runtime-worker.md`, `docs/plans/2026-10-01-m0-4-runtime-skeleton.md` (follow-ups).

- R2: the wake mechanism chosen (§5.2.4 and §5.5 updated), thread creation and proxied-call results, the promise-proxied `fsync` answer per file system, in the spec's voice.
- R3: settled or not for `-sMAIN_MODULE=2`/WasmFS/browser with the evidence (Chromium, Firefox).
- §5.3: the memory rule and its evidence; pool size; export-list derivation and ABI version.
- §10/§11: the pnpm workspace, the Playwright harness, the new checks.
- §12: `↳ M0.4` row; M0 row marked done if everything in it is answered.
- Plan follow-ups: what M1 inherits (Effect host replacing the spike host, ring and protocol, real `libibus-web` types).
- [ ] Steps: edit, `nix flake check`, commit.

## Known gaps and follow-ups

(Filled in as tasks finish.)
