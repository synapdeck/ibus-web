# Native IBus Differential Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Inline execution and a commit per task are the user's preserved choices.

**Goal:** Compare a real native engine with its WASM port through reusable event traces, starting with Hangul.

**Architecture:** A TypeScript controller starts isolated native/WASM adapters and compares their step-indexed transcripts. A small C adapter uses real GDBus/libibus; test-only GLib value helpers serve both adapters. Engine launch details and scenarios live with each engine.

**Tech Stack:** TypeScript, Vitest, Node child_process, GLib/GIO/libibus, JSON-GLib, native IBus/D-Bus, Emscripten and Nix.

**Spec:** `docs/specs/2026-10-03-native-ibus-differential-testing.md` (approved by the user).

## Global Constraints

- No Hangul-specific behavior in generic driver, comparison or session code.
- No replacement libibus in the native reference; preserve the stock engine's behavior.
- Private explicit bus addresses, temporary XDG directories and owned process handles; never touch the desktop session or repurpose HOME.
- Initial settings precede engine startup. General live-settings parity is deferred.
- Preserve semantic event order, types, attachments, empty updates and replies. No sleeps as success criteria or broad difference suppression.
- Tests run offline in Nix. Test-only native/WASM dependencies do not enter the production runtime.
- Dependencies belong in `tools/package.json`; parsers and serialization use maintained libraries.
- Keep existing golden regressions. Expected native crashes run separately and must match a named scenario outcome.
- Commit each task; never stage bytecode or unrelated user changes.

## Review Focus

- Signals queued just before replies and delayed signals after replies: preserve order and reject unconsumed trailing output (Tasks 2 and 4).
- Child exit or interruption during startup/request processing: bounded failure and cleanup of the whole private process tree (Tasks 1 and 3).
- Multiple contexts: no cross-context event attribution or stale path reuse (Tasks 2 and 4).
- Variant attachments and non-ASCII strings: preserve exact types and contents through both adapters (Tasks 1 and 4).
- Native behavior changes after an update: stale expected differences must fail instead of masking an improvement/regression (Task 5).

### Task 1: Trace contract, comparison and process transport

**Files:** `tools/ibus-test/{types.ts,trace.ts,compare.ts,process.ts,trace.test.ts,compare.test.ts,process.test.ts,tsconfig.json}`, `tools/{package.json,vitest.config.ts}`, `modules/engines/ibus-test.nix`.

**Interfaces:**

- `Trace`: `{ version: 1, settings: Setting[], steps: Step[] }`.
- `Setting`: `{ schema: string, key: string, value: string }`, where value is GLib GVariant text, parsed by the C adapter/native gsettings tool.
- Steps: `create { context, engine }`, `destroy { context }`, `call { context, method, args }`, and `wait { context, event, timeoutMs }`. Args are GVariant tuple text. Context names are stable strings; engines/hotkeys never appear in the generic vocabulary.
- Adapters produce JSON Lines: ordered `event { step, context, name, payload }`, `reply { step, value }`, and `error { step, message }`. `payload` is `{ signature, text }`, where text is canonical GLib GVariant text with type annotations. This preserves nested types/attachments without a new TypeScript GVariant codec.
- `validateTrace(input: unknown): Trace`; `compareTranscripts(native, wasm): Difference[]`, with first differing step/field and both values.
- `runAdapter(command: readonly string[], trace: Trace, options): Promise<RunResult>` owns subprocess lifetime, bounded deadlines, stderr and raw transcript artifacts. JSON parsing uses Node; argv is passed without a shell.

- [ ] Write Vitest cases for valid traces, duplicate/unknown contexts, unknown operations, malformed input, payload Unicode, differing replies/event order/empty events, malformed adapter output, process exit, timeout and interruption cleanup.
- [ ] Run `checks.engines-ibus-test-script`; expect failure on absent functions/CLI, then implement the contract and process transport.
- [ ] Re-run the check; all cases pass, including a process fixture that spawns a child and cannot survive timeout cleanup. Test helper executables stay beside their tests.
- [ ] Run `nix flake check --max-jobs 1`, then commit `feat(testing): add engine trace and differential comparison contracts`.

### Task 2: Generic native engine D-Bus adapter

**Files:** `tools/ibus-test/native/{main.c,driver.c,driver.h,values.c,values.h,meson.build,test-values.c,test-driver.c,test-engine.c}`, `modules/engines/ibus-test.nix`.

**Interfaces:**

- Native CLI `ibus-test-native --address ADDRESS --destination NAME --factory PATH --timeout-ms N` consumes one validated Trace from stdin and writes the Task 1 JSON Lines protocol.
- Factory `CreateEngine` returns each context's object path. Destroy goes through `org.freedesktop.IBus.Service`; other calls go through the upstream Engine interface. Content type maps to `org.freedesktop.DBus.Properties.Set`, not an invented engine method.
- Value helpers use JSON-GLib for JSON and `g_variant_parse`/`g_variant_print` for typed values. No custom D-Bus/variant parser. Canonicalization is test-only and independent of replacement IBus types.
- Capture signals and replies in connection order, associate paths with named contexts, and wait for explicit event checkpoints with deadlines. No idle-loop or sleep heuristic marks a request complete.
- Build a controlled engine fixture with native libibus to test the adapter independently of Hangul. It can emit known values, delayed output and intentional exit.

- [ ] Write native g_test cases for factory creation, key reply and preceding signal, two contexts, destruction, ContentType, delayed output, unknown method, non-ASCII text and typed attachments.
- [ ] Run `checks.ibus-test-native`; expect RED against absent adapter behavior.
- [ ] Implement the adapter and JSON/value helpers, then pass the tests. Prove trailing output is retained or rejected and a dead engine becomes a bounded error.
- [ ] Run the full flake checks and commit `feat(testing): drive native IBus engines over a private D-Bus connection`.

### Task 3: Isolated native sessions and configurable engine launch

**Files:** `tools/ibus-test/{session.ts,session.test.ts,cli.ts,README.md}`, `modules/engines/ibus-test.nix`, `engines/hangul/checks/differential/default.nix`.

**Interfaces:**

- `NativeEngineConfig`: commands for native IBus daemon, config service if needed, engine and adapter; engine destination/factory; schema/data environment. All commands are argv arrays supplied by Nix.
- `withNativeSession(config, settings, use): Promise<T>` creates temporary XDG config/cache/runtime/data directories and private bus addresses; starts only owned processes; waits for D-Bus readiness/name ownership with a deadline; seeds settings before engine launch; calls use; cleans up on every exit path.
- Use the real native Hangul executable and native libibus from pinned nixpkgs. Supply its required IBus config service. For deterministic initial settings, use a private persistent GLib settings backend and seed it through native gsettings before launch; no dependency on the desktop dconf state.
- Expose native CLI configuration generically. The Hangul Nix check supplies its own package and service identity.

- [ ] Write integration tests for readiness, failed engine launch, schema/config errors, timeout and interruption, and two sessions that cannot observe one another's settings or contexts.
- [ ] Run native session checks RED, implement isolation/startup, then GREEN against the controlled fixture and a native Hangul composition trace.
- [ ] Verify the check needs no display/session environment and preserves the caller's bus/XDG configuration.
- [ ] Run full flake checks and commit `feat(testing): launch isolated native IBus reference sessions`.

### Task 4: WASM trace adapter and shared conformance checks

**Files:** `tools/ibus-test/wasm/{main.c,driver.c,driver.h,meson.build}`, shared value helpers from Task 2, `modules/engines/ibus-test.nix`, `tools/ibus-test/{conformance.test.ts,fixtures/*}`.

**Interfaces:**

- WASM CLI accepts `--data DIR --module FILE`; mounts the engine FHS data and side module as the existing golden harness does, initializes the runtime, applies trace settings through Init, then loads the module.
- Uses the same trace input/transcript output as native. Maps context strings to runtime IDs, calls the framed dispatcher, pumps and decodes records. Log records go to diagnostics; behavior records remain ordered. Errors and unexpected warning-or-worse logs fail the run.
- Share test-only value parsing/printing, not the native/WASM implementations of dispatch or IBus. Build JSON-GLib privately for this test executable if needed.
- Generic Nix builder takes native engine configuration, WASM module/data and trace paths; no Hangul paths embedded in the helper.

- [ ] Add adapter conformance tests for create/destroy, two contexts, Unicode/attachments, output ordering, explicit waits, invalid requests and trailing output. Run RED before implementing the WASM adapter.
- [ ] Implement and run GREEN. Deliberately perturb a transcript in a comparator test and assert the first divergent context/step/field is reported.
- [ ] Run full flake checks and commit `feat(testing): replay shared engine traces against the WASM runtime`.

### Task 5: Hangul differential corpus and expected upstream failures

**Files:** `engines/hangul/checks/differential/{default.nix,traces/*.json,expected-differences.json}`, `tools/ibus-test/{compare.ts,compare.test.ts,README.md}`, `docs/{engines.md,testing.md,known-gaps.md}`.

**Interfaces:**

- `checks.hangul-differential` runs native/WASM pairs per trace and retains trace, transcripts, versions, exit status and stderr in its output.
- Fixtures cover Latin/toggle, 2-set composition/CapsLock/BackSpace, focus/reset, Hanja keyboard/click/page behavior, password purpose, surrounding deletion, forwarding order, and initial settings for F8 and 3-set keyboard 39.
- Keep engine-specific expected differences keyed by exact scenario, step and outcome. The invalid last-page digit expects the known native assertion/exit and successful WASM behavior; a broad crash allowance is forbidden. An expected difference that disappears fails as stale.
- Existing live-settings/lifecycle golden cases remain authoritative for their regressions; generic live-settings comparison is outside this delivery.

- [ ] Add corpus and strict expected-difference tests. Run RED to expose genuine native/WASM differences; retain evidence rather than weakening comparison.
- [ ] Resolve accidental differences with regression tests; document deliberate ones narrowly. Confirm stock native reference has no port behavior patches.
- [ ] Run `checks.hangul-differential` GREEN, verify independent fixture-engine coverage demonstrates reusable configuration, and document adding another engine.
- [ ] Run full flake checks and commit `test(hangul): compare native and WASM engine traces`.

After all tasks, perform the executing-plans whole-branch review, fix important findings with RED/GREEN evidence, and report limitations accurately.
