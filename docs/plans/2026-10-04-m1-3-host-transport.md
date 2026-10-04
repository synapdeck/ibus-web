# M1.3: the Worker host's transport and engine startup — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@ibus-web/worker-host` speaks the real protocol. A page writes framed requests into the
request slot of a dedicated `SharedArrayBuffer`. The host dispatches them with `ibusweb_dispatch`,
pumps, and streams every output record through the output ring, with back-pressure, fragments,
`replyOutSeq` and doorbells. It starts an engine from a manifest Nix builds: memory and thread
shares from the manifest, the engine's data mapped at its FHS paths, `Init` before the engine module
loads, one scope per input context. A headless TypeScript harness runs ibus-hangul through the real
host under Node's `worker_threads`, and the spec's M1.3 questions (real engine transport, data
mapping, resource limits, ordered replies) get their answers.

**Architecture:** The transport's layout (control words, slot, ring, record placement, fragments,
padding) is defined once in `@ibus-web/protocol` (`src/transport/`), as data and as a ring writer and
reader in plain TypeScript, and joins the generated `PROTOCOL.md`. The host's request loop (plain
synchronous TypeScript, spec §7.4) uses the writer; the tests' page driver and later M1.4's keystroke
path use the reader. The host's bootstrap reads an `EngineManifest` (schema in `@ibus-web/protocol`),
checks it, sizes memory and the pool from it, installs the data, symlinks `/usr/share` to the
installed tree, and waits for `Init`, after which it loads the engine module. Nix builds each
engine's manifest and data archive from the engine's build. Test operations used by the host's own
suites travel in a reserved request-kind range that only the test build serves.

**Tech Stack:** TypeScript 7, Effect 4.0.0 (layers and scopes in the host; none on the request
loop's path), `@ibus-web/protocol` (bundled into the Worker scripts), Vitest 5 with `@effect/vitest`,
the test-program shim, Node `worker_threads` and Chromium/Firefox through Playwright, Nix
(`pkgsWasm`, `runtime.mkSideModule`, `testing.vitestCheck`), wabt's `wasm-objdump` for `dylink.0`.

## Global constraints

- nixpkgs: whatever `flake.lock` pins; versions come from Nix evaluation or the pnpm catalog, never literals in manifests.
- **The request loop is plain synchronous TypeScript** (spec §5.5.2, §7.4): no fibers, Effect timers or promises on the path from `ibusweb_wait` returning to the reply being published. Effect builds the scopes around it.
- **Nothing the Worker does for a request waits for the page** (spec §6.2.6), except the full-ring wait, which waits only for the page to read.
- The page never touches WebAssembly memory; the protocol never carries pointers (spec §9.2).
- `@ibus-web/protocol` and `@ibus-web/worker-host` are `MIT OR Apache-2.0`; `effect` is a peer dependency of both. Copyright `2026 Synapdeck, Inc.`.
- Effect 4 conventions: `exactOptionalPropertyTypes` is on repo-wide (absent optionals are missing keys, never `undefined`); property tests use Effect's `Arbitrary` through `@effect/vitest`'s `it.prop` with fixed seeds; `SchemaAOTCompiler` is allowed, `SchemaJITCompiler` is not. Verify APIs against `node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/*.d.ts`.
- **Structured tests:** Vitest for TypeScript, g_test for C that links GLib, GoogleTest otherwise. The host's suites play the page and run under Node (`checks.worker-host-node`) and in Chromium and Firefox (`checks.worker-host-browser`), on the asserting and released runtimes. Timing is asserted only on its one-sided part, under bounds generous for a loaded builder.
- Generated files (`protocol.h`, `PROTOCOL.md`, the CI workflow) are regenerated with `nix run .#write-files`; their `files:` checks must pass. `protocol.h`'s ABI stays as it is except where a task says otherwise.
- Comments explain why, not what; never refer to other files, this plan or its history. Docs describe the system as it is.
- `nix flake check` passes at the end of every task. `git add` new files before `nix` commands. Stage named paths only; commit with `nix develop -c git commit -- <paths>`; conventional messages, no attribution lines. The user edits concurrently: never revert changes you didn't make.

## Decisions fixed here (later tasks rely on them)

These settle what the spec leaves open; Task 8 writes them into the spec.

**The control header.** Eleven `Int32` words in the 64-byte header (room for sixteen):

| Index | Word          | Written by | Meaning                                                                                                       |
| ----- | ------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| 0     | `state`       | both       | `IDLE` 0, `REQUEST` 1, `REPLY` 2, `CRASHED` 3                                                                 |
| 1     | `reqSeq`      | page       | incremented per request; the host ignores it (diagnostics only)                                               |
| 2     | `reqLen`      | page       | bytes of the request in the slot                                                                              |
| 3     | `replyRet`    | host       | `ibusweb_dispatch`'s return value                                                                             |
| 4     | `replyOutSeq` | host       | `seq` of the last record the request's dispatch and pump produced (unchanged if none)                         |
| 5     | `ringWrite`   | host       | bytes ever written to the ring, mod 2³²                                                                       |
| 6     | `ringRead`    | page       | bytes ever consumed from the ring, mod 2³²                                                                    |
| 7     | `ringWaiting` | both       | host sets 1 before a full-ring wait; page clears it after advancing `ringRead`                                |
| 8     | `doorbell`    | both       | 1 while a doorbell message is outstanding: the host posts one only when it swaps 0→1; the page stores 0 first |
| 9     | `wake`        | page       | bumped and notified after each request and after freeing ring space while `ringWaiting`                       |
| 10    | `reqMode`     | both       | `SYNC` 0 (page spins), `ASYNC` 1 (page waits for a doorbell), `ABANDONED` 2 (page gave up spinning)           |

The page writes `reqMode` with the request. On a timeout it compare-exchanges `SYNC`→`ABANDONED` and
then re-reads `state`: if the reply had already landed, it handles it itself. The host, after setting
`state = REPLY` and notifying, reads `reqMode` and posts a doorbell (subject to the `doorbell` word)
if it is `ASYNC` or `ABANDONED`. Either the host sees `ABANDONED` or the page sees `REPLY`, so no
completion is missed.

**Doorbells** are `HostMessage { type: "doorbell" }`. The host posts one: after a pump outside a
request put records in the ring; before a full-ring wait; after a reply under the `reqMode` rule. It
posts only when `Atomics.exchange(doorbell, 1)` returns 0. The page, on a doorbell, stores 0 into
`doorbell` **before** draining, so records written before a suppressed doorbell are always drained.

**The ring.** Its size is a power of two (default 256 KiB) so that the byte counters' 2³² wrap stays
consistent; the slot defaults to 64 KiB; both are multiples of 8, configurable per Worker. Layout:
header (64 bytes), slot, ring. Free space is `ringBytes − (ringWrite − ringRead)`. Records keep the
16-byte header and 8-byte padding. A record never wraps: when fewer than 16 bytes remain before the
ring's end, both sides skip them; when at least 16 remain but the next record or fragment doesn't fit
before the end, the host writes a **padding record** there (`kind` 0, `seq` 0, `ic` 0, `flags` 0,
`len` = remaining − 16) and the reader discards it. Kind 0 is reserved for padding in both
directions' kind spaces.

**Fragments.** When a record's framed size exceeds the free space, the host writes the largest
fragment that fits (at least 8 payload bytes; otherwise it waits), with the record's `seq`, `ic` and
`kind`, `flags = CONTINUATION` and `len` = that fragment's payload bytes; the last fragment has
`flags` 0. A record's fragments are consecutive (the host is the ring's only writer). `replyOutSeq`
and every other count are in records, not fragments. The reader concatenates fragment payloads and
hands the complete record to `decodeRecord`.

**The full-ring wait** is spec §6.2.2's, unchanged: set `ringWaiting` 1, post a doorbell, read the
runtime's wake word as `seen`, re-check free space, and while still full call `ibusweb_wait(seen, -1)`
and start over. No pump meanwhile; a trap during the wait is a crash.

**Host-written records** (the host's own `Log` records and `Crashed`) carry `seq` 0 and `ic` 0 and
never count toward `replyOutSeq`. The runtime's sequence skips 0 when it wraps (a one-line change to
`src/output.c`), so `seq` 0 always means "written by the host".

**`Crashed`** gets a schema: `Crashed (us)`: `reason` (`TRAP` 1, `FAULT` 2 for `-ECANCELED`, `RELAY` 3,
`LOAD` 4, `HOST` 5) and `message`. The host writes it best-effort when it marks `state = CRASHED`, if
the ring has room without waiting; the `state` word is authoritative and the `crashed` host message
still carries the report. `protocol.h` gains its signature-table entry.

**Startup order.** The bootstrap (spec §5.5) ends with storage mounted, data installed and the FHS
view mapped; the request loop then starts. The engine module is loaded when the first `Init` succeeds:
the host dispatches `Init`, and on a return of 0 loads the module (opening the engine-module scope),
pumps, drains and only then publishes the reply. `Init` thus always precedes module initialization,
and restart (spec §8) is the same path. A module load failure crashes the Worker with reason `LOAD`.
A request other than `Init` before it gets `-ENOTCONN` from the runtime, as today.

**The FHS view.** Engine data archives' paths are under `/usr/share/` (the manifest schema enforces
it). After installing, the host creates `/usr` and symlinks `/usr/share` to
`<engineDataRoot>/usr/share`, in every storage mode, and sets `GSETTINGS_SCHEMA_DIR` to
`/usr/share/glib-2.0/schemas` with the runtime's `setenv` before any `Init`. GLib caches its schema
source on first lookup, which is `Init`'s.

**Engine scopes.** The engine-module scope has no release action (there is no module shutdown call).
Each successful `CreateEngine` opens an engine-instance scope keyed by `ic`, synchronously in the
loop; `DestroyEngine` closes it. When the host's scope closes with the runtime intact, it dispatches
`DestroyEngine` for every open instance; after a trap or fault it skips runtime calls.

**Faults.** `-ECANCELED` from `ibusweb_dispatch` is a crash with reason `FAULT`: the host publishes the
reply, drains what the runtime already wrote, writes `Crashed` and sets `CRASHED`. It never calls the
runtime's dispatch or pump again.

**Test operations** move to request kinds `0xff00`–`0xffff`. Only the test build serves them, through
the existing `Instruments.serve` hook, by calling `ibusweb_test_dispatch` and writing the operation's
reply bytes into the slot; the production loop hands every kind to `ibusweb_dispatch`, which answers
`-ENOSYS`.

**The engine manifest** (`EngineManifest` in `@ibus-web/protocol`, decoded by the host before anything
else):

```ts
{ name: string; version: string; license: string; runtimeAbi: number; protocol: number;
  module: { url: string; size: number }; memory: number; threads: number;
  data: { url: string; path: string; size: number }[]; engines: string[]; settingsSchemas: string[] }
```

`memory` is whole 64 KiB pages within the runtime's bounds; `threads` a nonnegative integer;
`runtimeAbi` must equal the runtime's `IBUSWEB_RUNTIME_ABI` and `protocol` must equal
`PROTOCOL_VERSION`, else the start fails (`RuntimeAbiMismatch`, `ProtocolMismatch`). `HostInit`
carries the manifest instead of today's `engine`, `memory` and `sides` fields; tests pass test
manifests.

**Thread pool.** `ibus-runtime` links `-sPTHREAD_POOL_SIZE=<base>+Module["ibuswebEngineThreads"]`
with base = GLib share + storage share + `lowWater` (8 today); the host sets
`ibuswebEngineThreads` from the manifest and refuses to start without it. The engine share leaves
`ibusWeb.runtime.threadPool.shares`.

**Memory from the build.** Nix computes `memory` as spec §5.3 has it: runtime minimum + the side
module's `dylink.0` memory size + 1 MiB per pool thread of the engine's share + the engine's declared
`heapBytes`, × 1.25, rounded up to whole MiB. `heapBytes` is declared per engine and the conformance
harness (Task 6) measures the peak heap and fails if it exceeds the declaration, so the declaration
can't silently go stale.

## File map

| Path                                                                                         | Responsibility                                                     | Task |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---- |
| `packages/protocol/src/transport/{layout,ring}.ts`, `test/transport/*`                       | control words, layout, ring writer and reader                      | 1    |
| `packages/protocol/src/messages/records.ts`, `src/manifest.ts`, `scripts/protocol-md.ts`     | `Crashed`, padding kind, manifest schema, generated docs           | 1, 2 |
| `runtime/libibus-web/src/output.c`, `tests/test-engine.c`                                    | seq skips 0                                                        | 1    |
| `runtime/ibus-runtime/package.nix`, `runtime/options.nix`                                    | pool size from `ibuswebEngineThreads`                              | 2    |
| `modules/engines/manifest.nix`, `modules/engines/options.nix`, `tools/engine-manifest/*`     | `mkEngineManifest`: manifest, data archive, memory                 | 2    |
| `engines/hangul/package.nix`                                                                 | Hangul's manifest                                                  | 2    |
| `packages/worker-host/src/shared/{control,messages}.ts`                                      | control from the protocol layout; `HostInit`, doorbell message     | 3    |
| `packages/worker-host/src/worker/{loop,output,runtime,host}.ts`                              | the protocol loop, ring output, replies, doorbells                 | 3, 5 |
| `packages/worker-host/test/shared/{page,client,testing}.ts`, scenarios                       | the page driver, test kinds, migrated scenarios                    | 3, 5 |
| `packages/worker-host/src/worker/{startup,scopes,fhs}.ts`                                    | manifest checks, FHS view, Init-then-load, instance scopes, faults | 4    |
| `packages/worker-host/test/sides/engine.c`                                                   | a test engine registered through `IBusFactory`                     | 4    |
| `packages/worker-host/test/engines/hangul.test.ts`, `engines/hangul/checks/host/default.nix` | the Hangul conformance harness over the host                       | 6    |
| `packages/worker-host/src/worker/install/*`, `test/shared/install.ts`                        | the install-lock wait's flake                                      | 7    |
| `docs/*`, spec                                                                               | docs                                                               | 8    |

---

### Task 1: The transport in `@ibus-web/protocol`

**Files:** `packages/protocol/src/transport/{layout,ring}.ts`, `src/index.ts`,
`src/messages/records.ts` (`Crashed`), `src/messages/framing.ts` (padding kind), `scripts/protocol-md.ts`,
`scripts/protocol-h.ts` (signature entry for `Crashed`), `test/transport/{layout,ring}.test.ts`,
`runtime/libibus-web/src/output.c`, `runtime/libibus-web/tests/test-engine.c`; regenerated
`protocol.h`, `PROTOCOL.md`.

**Interfaces (produced):**

```ts
export const Word = { state: 0, reqSeq: 1, reqLen: 2, replyRet: 3, replyOutSeq: 4, ringWrite: 5,
  ringRead: 6, ringWaiting: 7, doorbell: 8, wake: 9, reqMode: 10 } as const;
export const State = { idle: 0, request: 1, reply: 2, crashed: 3 } as const;
export const ReqMode = { sync: 0, async: 1, abandoned: 2 } as const;
export const HEADER_BYTES = 64, DEFAULT_SLOT_BYTES = 65536, DEFAULT_RING_BYTES = 262144, PADDING_KIND = 0;
export interface TransportLayout { readonly slotBytes: number; readonly ringBytes: number; readonly totalBytes: number;
  readonly slotOffset: number; readonly ringOffset: number }
export const transportLayout: (options?: { slotBytes?: number; ringBytes?: number }) => TransportLayout; // validates
export interface TransportViews { readonly words: Int32Array; readonly slot: Uint8Array; readonly ring: Uint8Array }
export const transportViews: (buffer: SharedArrayBuffer, layout: TransportLayout) => TransportViews;
export type WriteResult = { readonly _tag: "written" } | { readonly _tag: "full"; readonly needBytes: number };
export class RingWriter {              // the host's side; one record at a time
  constructor(views: TransportViews, layout: TransportLayout);
  freeBytes(): number;
  /** Writes `record` (a framed record: header + payload + padding) or as much of it as fits, with padding
   *  and fragments per the Decisions. Resumable: call again with the same record after space is freed. */
  write(record: Uint8Array): WriteResult;
}
export class RingReader {              // the page's side
  constructor(views: TransportViews, layout: TransportLayout);
  /** Returns the next complete record (fragments reassembled, padding skipped) framed as one record with
   *  flags 0, ready for decodeRecord, or undefined when none is complete; advances ringRead past what it
   *  consumed and, if ringWaiting was set, clears it and bumps and notifies wake. */
  next(): Uint8Array | undefined;
}
export class Crashed extends Schema.TaggedClass<Crashed>()("Crashed", { reason: Uint32, message: Str }, { kind: 34, … }) {}
export const CrashReason = { trap: 1, fault: 2, relay: 3, load: 4, host: 5 } as const;
```

- [ ] **Step 1: Write the failing tests.**
  - `layout.test.ts`: default layout is 64 + 65536 + 262144 bytes; rejects a ring that isn't a power of two, sizes not multiples of 8, a ring smaller than 64 bytes; word indices are distinct and fit the header.
  - `ring.test.ts` (writer and reader over one `SharedArrayBuffer`, same thread):
    - records written back to back read back identically and in order;
    - a record that doesn't fit before the ring's end produces a padding record (and, with < 16 bytes left, a skip) and the reader hides both;
    - a record larger than the whole ring arrives as fragments, reassembled byte for byte; `write` returns `full` until the reader frees space, then resumes;
    - a fragment carries `CONTINUATION` on all but the last, shares `seq`/`ic`/`kind`;
    - counters cross 2³² (start both counters at `0xfffff000`) without losing a record;
    - `next()` clears `ringWaiting` and bumps `wake` when it frees space while `ringWaiting` is 1;
    - `it.prop` with a fixed seed: random sequences of record sizes (8 bytes to 3× the ring) and interleavings of writes and reads deliver every record exactly once, in order, unchanged.
  - Extend `test/messages/kinds.test.ts`/generator tests: `Crashed` has signature `(us)`; kind 0 is no message's kind; `PROTOCOL.md` has a "Transport" section with the word table, the layout and the ring rules.
  - In `runtime/libibus-web/tests/test-engine.c` (g_test): with the output sequence set to `G_MAXUINT32` through a test-only setter in `src/output.h`, the next record's seq is 1.
- [ ] **Step 2: Run them; they fail.** `nix develop -c pnpm --dir packages/protocol exec vitest run --configLoader native test/transport` and `nix build -L .#checks.x86_64-linux.libibus-web`.
- [ ] **Step 3: Implement.** `ring.ts` is plain TypeScript over `Int32Array`/`Uint8Array` with `Atomics.load/store` on the counters and `Atomics.add/notify` on `wake`; the writer publishes a record's bytes before advancing `ringWrite` with `Atomics.store`. `Crashed` joins `OutputRecord`. `output.c` skips 0 when the sequence wraps. `protocol-md.ts` renders the transport section from `transport/layout.ts`'s data (word table with descriptions as data, not literals in the generator).
- [ ] **Step 4:** regenerate (`nix run .#write-files`); confirm `protocol.h`'s only ABI change is `Crashed`'s signature entry; run `nix build -L .#checks.x86_64-linux.{protocol,protocol-parity,libibus-web,hk}` and the `files:` checks.
- [ ] **Step 5: Commit** `feat(protocol): define the shared-memory transport and the Crashed record`.

### Task 2: Engine manifests and the pool share

**Files:** `packages/protocol/src/manifest.ts`, `test/manifest.test.ts`; `runtime/ibus-runtime/package.nix`,
`runtime/options.nix`; `modules/engines/manifest.nix` (new), `modules/engines/options.nix`;
`tools/engine-manifest/{dylink.ts,dylink.test.ts,tsconfig.json}`; `engines/hangul/package.nix`.

**Interfaces:**

- Produces: `EngineManifest` (Schema, the Decisions' shape) and `decodeEngineManifest(json: unknown): EngineManifest` (throws `SchemaError`); `ibusWeb.engines.mkEngineManifest { name, package, threads, heapBytes, engines, settingsSchemas }` returning a derivation with `manifest.json`, `<name>.wasm` and `data/<name>-<version>.tar`; `packages.ibus-web-hangul-dist` (or an `ibusWeb.engines.hangulDist` option) with Hangul's.

- [ ] **Step 1: Write the failing tests.**
  - `manifest.test.ts`: a valid manifest decodes; rejected: missing `version`, `memory` not a multiple of 65536, `memory` above 2 GiB or below the runtime minimum (bounds passed as data, not literals: `decodeEngineManifest(json, { minimum, maximum })`), negative or fractional `threads`, a data `path` outside `/usr/share/`, duplicate data paths.
  - `dylink.test.ts`: on a fixture produced in the check (`runtime.mkSideModule` of a trivial C file with a known static array), the script prints the `dylink.0` memory size `wasm-objdump -x --section=dylink.0` reports (parse only its documented `mem_size:` line), and fails on a module without the section.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement the pool link.** In `runtime/ibus-runtime/package.nix`, link `-sPTHREAD_POOL_SIZE='<base>+Module["ibuswebEngineThreads"]'` (base from the GLib and storage shares and `lowWater`), add `ibuswebEngineThreads` to `-sINCOMING_MODULE_JS_API`, and remove the engine share from `threadPool.shares` and `planned`; prove the quoting survives the cc-wrapper and the export-list link by grepping the generated `ibus-runtime.js` for `Module["ibuswebEngineThreads"]` in a build-only check line (`checks.ibus-runtime-exports` already greps the output; extend it). Update the host minimally so the existing suites still pass: `HostInit` gains `engineThreads`, set from the test manifest's `pool.engine`, passed to `createRuntime` as `ibuswebEngineThreads`; the host refuses to start without it.
- [ ] **Step 4: Implement `mkEngineManifest`** in `modules/engines/manifest.nix`: tar `package/data/usr/share` as ustar with paths under `usr/share` (the installer's format; see `runtime.installArchives`), record its unpacked size, run `tools/engine-manifest/dylink.ts` on the module, compute `memory` per the Decisions, and write `manifest.json` (URLs relative to the manifest: `./<name>.wasm`, `./data/<file>`). `runtimeAbi` and `protocol` come from the runtime's header and the protocol package (evaluate, don't hard-code). Hangul: `threads = 0` and a provisional `heapBytes = 16 MiB`, both replaced by Task 6's measurements, `engines = [ "hangul" ]`, `settingsSchemas = [ "org.freedesktop.ibus.engine.hangul" "org.freedesktop.ibus.panel" ]`.
- [ ] **Step 5:** `nix build -L .#checks.x86_64-linux.{protocol,ibus-runtime-exports,ibus-runtime-load,worker-host-node,hk}` and the Hangul dist; read its `manifest.json`.
- [ ] **Step 6: Commit** `feat: build engine manifests and size the pool from them`.

### Task 3: The protocol request loop and the output ring

**Files:** `packages/worker-host/package.json` (depend on `@ibus-web/protocol`), `tsdown.config.ts` (bundle it into the Worker scripts),
`src/shared/{control,messages,index}.ts`, `src/worker/{loop,output,runtime,host}.ts`,
`test/shared/{page,client,testing,scenarios,lifecycle,storage,install}.ts`, `test/worker/{host,instruments}.ts`,
`test/sides/test-ops.h`, `module.nix`.

**Interfaces:**

- Consumes: Task 1's layout, `RingWriter`, `RingReader`, `encodeRequest`, `decodeRecord`.
- Produces: `src/shared/control.ts` re-exporting the protocol layout plus page helpers `postRequest(views, bytes, mode)`, `takeReply(views): { ret: number; outSeq: number }`; `HostMessage` gains `{ type: "doorbell" }`; `src/worker/output.ts`: `drainOutput(rt, writer, words): number` (copies `ibusweb_output_peek`'s records into the ring with the full-ring wait, consumes what it copied, returns the count); `test/shared/page.ts`: `Page` with `request(kind, ic, payload, mode)`, `records()`, `waitForReply()`, `onDoorbell()`, used by every scenario.

- [ ] **Step 1: Write the failing tests** (Node suite first; the browser suite shares the scenarios):
  - a protocol round trip on the test engine-less runtime: `Init` (empty snapshot) answers 0, a second `Init` `-EALREADY`, `CreateEngine` before an engine exists `-ESRCH`;
  - `replyOutSeq` equals the `seq` of the last record a request produced and is unchanged for a request that produced none (use the `Log` records Init writes for an unknown snapshot key);
  - output from a timer side's pump outside a request reaches the ring and is followed by exactly one doorbell; two pumps before the page drains still give one doorbell (the `doorbell` word);
  - an `ASYNC` request completes with a doorbell; a `SYNC` one without; a `SYNC` one the page abandons before the reply gets a doorbell, and one abandoned after the reply landed is handled by the page without one (drive both orders with the test kinds' yield operation);
  - every existing scenario passes through test kinds `0xff00 + opcode`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** The loop: wake, read `state`; on `REQUEST`, copy the request out of the slot, `ibusweb_dispatch` (or, in the test build, the test hook for kinds ≥ `0xff00`), pump once, `drainOutput`, write `replyRet` and `replyOutSeq` (`ibusweb_output_last_seq`), set `REPLY`, notify `state`, apply the `reqMode` doorbell rule. Outside a request: pump; if `drainOutput` wrote records, ring the doorbell. Add `_ibusweb_dispatch`, `_ibusweb_output_peek/consume/last_seq` to the `Runtime` interface. Rename the shared test encoder to `encodeTestOp` and move the test opcodes to `0xff00 + n`. Records in this task always fit (the full-ring wait and fragments land in Task 5); `drainOutput` throws a `HostDefect` if `write` returns `full` so nothing is silently dropped.
- [ ] **Step 4:** `nix build -L .#checks.x86_64-linux.{worker-host-node,worker-host-browser,worker-host-side-imports,hk}`.
- [ ] **Step 5: Commit** `feat(worker-host): serve the protocol and stream output through the ring`.

### Task 4: Engine startup, the FHS view and engine scopes

**Files:** `src/worker/{startup,fhs,scopes,host,loop,failure}.ts`, `src/shared/messages.ts`,
`test/sides/engine.c` (new test engine), `module.nix` (its side and a test manifest with data),
`test/shared/{engine,scenarios,lifecycle}.ts`.

**Interfaces:**

- Consumes: `EngineManifest`, `decodeEngineManifest`, Task 3's loop.
- Produces: `HostInit { runtimeUrl; wasm?; control; manifestUrl | manifest; storage; poolLowWater; constants; test? }` (manifest replaces `engine`, `memory`, `sides`, `engineThreads`); `startup.ts`: `checkManifest(manifest, constants): EngineManifest` (raising `StartupFailed` with the bound or mismatch in its message); `fhs.ts`: `mapFhs(rt, manifest)`; `scopes.ts`: `EngineScopes` with `opened(ic)`, `closed(ic)`, `closeAll(rt, intact)`; `Crashed` written on every crash path.

The test engine `engine.c` registers `"echo"` through `IBusFactory`. Its `process_key_event` interprets
the keyval: `'a'` → accept; `'b'` → `CommitText` of `state` bytes of text (for large records); `'c'` →
commit from an idle source (output outside the request); `'d'` → read `/usr/share/echo/data.txt` and
commit its first line (the FHS view); `'s'` → write a GSettings key of its schema (`SettingWritten`);
and a second test side, `engine-throw.cpp`, registers `"thrower"`, whose `process_key_event` throws a C++ exception, for the fault path.
Its data archive (built in `module.nix` with `mkEngineManifest`) carries `usr/share/echo/data.txt` and its schema, compiled with
`pkgsWasm.glib`'s `glib-compile-schemas` (through the `.pc` variable), under `usr/share/glib-2.0/schemas`.

- [ ] **Step 1: Write the failing tests:**
  - the start fails, with the bound or mismatch in the error, for a manifest with `memory` out of bounds, a wrong `runtimeAbi`, a wrong `protocol`, missing `threads`;
  - before `Init`, `/usr/share/echo/data.txt` is readable through the symlink (test kind reading a file) in each storage mode (`node`, `memory`, and in browsers `indexeddb`);
  - the module isn't loaded before `Init` (`CreateEngine` → `-ENOTCONN`, test kind listing loaded modules → none); after `Init` it is, and `CreateEngine(1, "echo")` → 0; `Init`'s snapshot is visible to the engine at its init (the engine logs its key's value at module init; assert the `Log` record);
  - `'d'` commits the data file's line; `'s'` yields a `SettingWritten` record with `ic` 0;
  - `DestroyEngine` closes the instance scope; stopping the host with two open instances dispatches two `DestroyEngine`s (count through the engine's finalize log);
  - a key to `"thrower"` → reply `-ECANCELED`, the records already written are in the ring, then a `Crashed` record with reason `FAULT`, `state = CRASHED`, a `crashed` host message, and no further runtime calls (instrument: the test build counts calls);
  - a trap (an existing crash side) → `Crashed` reason `TRAP`; a failing relay → reason `RELAY`; a module that fails to load → reason `LOAD`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement** per the Decisions; the bootstrap order becomes: probe and writer lock → memory from the manifest (+ data size in the memory fallback) → runtime with `ibuswebEngineThreads` → relay → storage → install → FHS view and `GSETTINGS_SCHEMA_DIR` → request loop; the engine-module scope opens inside the loop on `Init`. The host's Effect logger writes `Log` records (seq 0) into the ring instead of `log` host messages.
- [ ] **Step 4:** `nix build -L .#checks.x86_64-linux.{worker-host-node,worker-host-browser,worker-host-side-imports,hk}`.
- [ ] **Step 5: Commit** `feat(worker-host): start engines from their manifest behind Init`.

### Task 5: Back-pressure and fragments

**Files:** `src/worker/output.ts`, `src/worker/loop.ts`, `test/shared/ring.ts` (scenarios), the suites' registration.

- [ ] **Step 1: Write the failing tests** (with a host whose ring is 4 KiB, set through `HostInit`'s layout):
  - a `'b'` commit of 64 KiB arrives as fragments, reassembled by the page, `replyOutSeq` counting it once;
  - the page stops reading: the host sets `ringWaiting`, posts one doorbell, and stays in `ibusweb_wait` (instrument: no pump while waiting); a request posted meanwhile isn't served until the page reads; when the page reads, everything arrives in order and the waiting request is then served;
  - ordering: idle-source output written while the page is spinning on a request arrives in `seq` order relative to the request's own records;
  - a trap during the full-ring wait → `CRASHED` (`Crashed` omitted if no room);
  - the reply is never published before the request's last record is in the ring.
- [ ] **Step 2: Run them; they fail** (Task 3's `drainOutput` throws on `full`).
- [ ] **Step 3: Implement** the full-ring wait in `drainOutput` with `RingWriter.write`'s resumable result, the doorbell before the wait, and the wake-word re-check. While waiting, only `ibusweb_wait` runs.
- [ ] **Step 4:** both host checks and `hk`.
- [ ] **Step 5: Commit** `feat(worker-host): wait for ring space and fragment large records`.

### Task 6: The Hangul conformance harness over the host

**Files:** `packages/worker-host/test/engines/{hangul.test.ts,page-session.ts}`, `engines/hangul/checks/host/default.nix`,
`engines/hangul/package.nix` (`heapBytes`, `threads` from the measurement).

The harness boots the host's test bundle (`dist/test/worker/host.js`: the production host plus its instruments, which give the stats the resource case reads) in a `worker_threads` Worker
through the existing adapter, from the Hangul manifest of Task 2 with Node storage, and plays the page
with Task 3's `Page`. `checks.hangul-host` runs it with `testing.vitestCheck` on the worker-host package
directory and the manifest path in its environment.

- [ ] **Step 1: Write the cases** (each asserts decoded records and `replyOutSeq`):
  - composition: ㅎ ㅏ ㄴ → preedit updates, `space` → `CommitText` 한;
  - Hanja: 한 then F9 → `UpdateLookupTable` (decoded, ≥ 1 candidate), `PageDown`, `CandidateClicked` with a page-relative index → the expected candidate committed (as the golden case does);
  - settings: `Init` snapshot with `hanja-keys` including F8 → F8 opens Hanja; `SettingChanged` of `hangul-keyboard` to `39` → a 3-set composition; an engine write → `SettingWritten` with `ic` 0;
  - lifecycle: create, destroy, recreate on the same `ic`; two contexts at once compose independently;
  - surrounding text: `SetSurroundingText` then Hanja conversion of the preceding syllable → `DeleteSurroundingText` before `CommitText`;
  - forwarding: with `IBUS_CAP_SYNC_PROCESS_KEY_V2`, `space` after 한 → reply 1 and `CommitText` before `ForwardKeyEvent`;
  - focus out with a preedit → no `CommitText`, last preedit's mode `COMMIT`;
  - resources: through the stats test kind, the pool never held more Workers than base + `threads`, and the runtime's peak heap (`sbrk` high-water, added to the stats operation) is at most the manifest's `heapBytes`.
- [ ] **Step 2: Run** `nix build -L .#checks.x86_64-linux.hangul-host`; fix the host, not the expectations, where they disagree with the golden cases' recorded behaviour. Record the measured peak heap and thread count in `engines/hangul/package.nix` (`heapBytes` rounded up to whole MiB with ~25 % headroom is already in the formula, so declare the measured peak rounded up to the next MiB).
- [ ] **Step 3:** `nix build -L .#checks.x86_64-linux.{hangul-host,hangul-golden,worker-host-node,hk}`.
- [ ] **Step 4: Commit** `test(hangul): run the engine through the Worker host`.

### Task 7: The install-lock wait's flake

**Files:** `packages/worker-host/src/worker/install/{provide,wait,archive}.ts`, `test/shared/install.ts`.

The scenario "a wait for the install lock outlives the lock limit while the installer's word keeps
arriving" fails under builder load: the waiter gives up when no progress arrives for `lockLimitMs`
(500 ms in the test), and the installer posts progress only per piece fed, so the gaps before the
first piece (clear, mount, fetch) and after the last (marker, seal) carry no word.

- [ ] **Step 1: Reproduce** by running the scenario 50 times while a test-only helper keeps every core busy with CPU-bound `worker_threads` loops, and confirm which gap times out (log `heard` timestamps in the test build).
- [ ] **Step 2: Fix the cause**, not the bound: the installer posts progress on a fixed interval (`progressIntervalMs`) for as long as it holds the install lock, from acquiring it to releasing it, independent of pieces. Add a unit test of the progress timer (fake clock via `@effect/vitest`'s `TestClock`).
- [ ] **Step 3:** the 50-run reproduction passes; `nix build -L .#checks.x86_64-linux.{worker-host-node,worker-host-browser}`.
- [ ] **Step 4: Commit** `fix(worker-host): keep announcing install progress between pieces`.

### Task 8: Docs and spec

- [ ] **Step 1:** `docs/worker-host.md`: the transport (pointer to `PROTOCOL.md`'s Transport section for the layout), the loop, doorbells and `reqMode`, the full-ring wait, fragments, startup order with `Init`-then-load, the FHS view, engine scopes, faults and `Crashed`, test kinds, the conformance harness. `docs/engines.md`: manifests, `mkEngineManifest`, `heapBytes` and its guard, `threads`. `docs/runtime.md`: pool size from `ibuswebEngineThreads`; seq skips 0. `docs/testing.md`: the new checks. `docs/known-gaps.md`: remove what M1.3 did (ring, `replyOutSeq`, doorbell, engine share, host startup, fragment reassembly); keep the persister, router and lazy decoding for M1.4.
- [ ] **Step 2: Spec:** §5.3 (pool from the manifest; `memory` from build data with `heapBytes`), §5.4.4 (the manifest's final fields), §5.5 (bootstrap order; engine module on `Init`), §5.5.1 (engine-module scope without a release action; instance scopes), §6.1.4 (`Crashed (us)`, padding kind 0, host-written records' `seq` 0), §6.2.1 (eleven words with `reqMode`), §6.2.2 (record placement, padding, fragments), §6.2.3 (doorbell coalescing and the `reqMode` rule), §8 (faults and reasons), §11.3 (the harness), §12 (M1.3 row done, with the answers).
- [ ] **Step 3:** `nix flake check`; republish nothing (the reviewer does).
- [ ] **Step 4: Commit** `docs: describe the Worker host's transport and engine startup`.
