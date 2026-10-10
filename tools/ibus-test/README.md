<!-- SPDX-FileCopyrightText: 2026 Synapdeck, Inc. -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# IBus test adapter protocol

`types.ts` defines the version 1 trace and JSON Lines transcript. The native executable is available on Linux as
`packages.ibus-test-native`; its tests are `checks.engines-ibus-test-native`. Run it with
`--address ADDRESS --destination NAME --factory PATH --timeout-ms N`. Supply one validated trace on stdin. The session
runner applies `settings` before launching the engine; the adapter does not apply settings. Engine object paths remain
internal; contexts are symbolic names.

## Design rules

- The native engine is the reference and runs unpatched. Where the port deliberately fixes an upstream bug, the
  difference is declared narrowly in `expectedDifferences`. It is never hidden by patching the native side, skipping the
  scenario or loosening the comparison.
- Only transport identity is normalized: native object paths, runtime context numbers and sequence counters map to the
  trace's symbolic names. Events are never dropped, reordered or merged, and empty updates count.
- An engine is added by configuration alone: its executable, service and factory identity, engine name, schemas, data
  and traces. Adding one changes neither the driver nor the comparison.

Every created context must have an explicit `destroy` step before a trace ends. The shared validator rejects open
contexts. Create, destroy, wait, and unit calls reply with JSON null; `ProcessKeyEvent` replies with a boolean. Other
reply bodies retain their typed GVariant representation. `SetContentType` takes `(uu)` and maps to
`org.freedesktop.DBus.Properties.Set` on the engine's `ContentType`.

The native driver sends calls on one connection and receives engine signals and replies addressed to that connection
through a second, eavesdropping observer. This gives both kinds of message one bus dispatch queue, preserving their wire
order through creation and the final Ping barrier. Replies are qualified by request serial, destination, and engine
owner. Values use JSON-GLib and GLib's annotated `g_variant_print` text plus the exact signature; there is no
replacement IBus implementation or custom variant codec involved.

If creation fails, buffered signals for known contexts still appear before the terminal creation error. Signals whose
paths cannot be resolved appear as error diagnostics at their original positions, retaining path, name, signature, and
payload. Draining continues after such a diagnostic, and the original factory failure remains the final error record.

Each event belongs to the step that observes it. A `wait` consumes the earliest unconsumed matching context/name event,
including an event already observed while executing an earlier call. Its original transcript position and step stay
unchanged. Nonmatching events are retained. Destroying a context clears its unconsumed checkpoints so reusing a symbolic
name cannot consume old events.

Method replies and matching events are explicit bounded checkpoints. Destroy's reply closes the context lifetime, and a
final `Peer.Ping` on the factory is the ordered end-of-trace barrier. Signals through that barrier are processed; an
engine signal on an unknown or destroyed path is an error. An engine must stop emitting context output after
destruction. A barrier cannot make claims about an engine that violates that lifetime after the barrier itself. No
idle-loop or sleep heuristic declares success. Errors produce a JSON error record at the active step and exit status 1;
invalid CLI arguments exit with status 2.

## Private native sessions

`withNativeSession(config, settings, use, options?)` in `session.ts` owns a native reference session.
`NativeEngineConfig` supplies argv arrays for `sessionBus` (dbus-daemon), `daemon` (ibus-daemon), `engine`, `adapter`,
`gdbus`, `gsettings`, and optionally `configService.command` with its well-known `destination`. It also supplies
`daemonDestination`, the engine `destination`, `factory`, schema/data `env`, and `timeoutMs`. No command is interpreted
by a shell.

The session appends `--nofork --address=ADDRESS` to `sessionBus`, `--address ADDRESS` to `daemon`, and the native
adapter's address/destination/factory/timeout arguments to `adapter`. Configure a private D-Bus config file with no
activation service directories. Configure ibus-daemon with `--single --emoji-extension=disable`, and launch any required
config service explicitly. All service commands must remain in the foreground and retain their owned process group. The
runner owns each daemon separately; it never discovers or replaces a desktop IBus instance.

Every invocation creates private bus sockets, an IBus address file, and XDG config/cache/runtime/data/state directories.
These reserved values and the `keyfile` GSettings backend override inherited/configured environment values. `HOME` is
preserved, overrides of it are rejected, and display/portal discovery variables are removed. The private DConf profile
uses only a private user DB; initial engine settings are written using native `gsettings set` to the persistent keyfile
backend before the engine launches. General live-settings parity is not part of this interface.

`use` receives `env`, `adapterCommand`, `artifactDir`, `resourceDir`, `signal`, and `run(trace)`. Use `run` for
automatic adapter cancellation and per-run artifacts; lower-level `runAdapter` also accepts an explicit `env`. The
startup sequence and each adapter run have `timeoutMs` deadlines. An optional parent `signal`, service death, callback
failure, or timeout triggers cleanup. Callbacks that do additional asynchronous work must honor `session.signal`.
Cancellation signals immediately, but the runner waits for the callback to settle, including asynchronous `finally`
work, before stopping remaining services or removing private resources. If interruption wins the race, a later callback
cleanup error does not replace that interruption error. A callback that ignores cancellation can therefore delay session
settlement indefinitely; its lifetime has no forced timeout. After callback settlement, each owned process group
receives TERM, then KILL after a bounded grace period if needed; all direct children are reaped before private resources
are removed.

`options.artifactDir` chooses the retained diagnostics directory; otherwise the runner creates one in the temporary
directory. It contains the explicit config, owned process commands/status and private paths in `session.json`, seeded
`settings.json`, numbered service/helper stdout/stderr files, and `run-N/` adapter artifacts. It does not dump the
caller's environment. Artifacts survive failure; private sockets and settings are removed on every exit path.

The generic CLI runs one trace and prints its JSON Lines transcript:

```sh
node tools/ibus-test/cli.ts --native-config CONFIG.json --trace TRACE.json --artifacts DIRECTORY
```

SIGINT/SIGTERM cancel the session. On Linux, Nix provides `packages.ibus-test-hangul-config` using the pinned stock
Hangul engine's actual libexec executable, native libibus and real ibus-dconf service. It does not use the setup UI or
the repository's replacement IBus library. Run the controlled fixture and stock Hangul session integration suite with
`nix build .#checks.x86_64-linux.hangul-native-session --no-link`. Native-specific packages and checks are omitted on
unsupported platforms.

## WASM replay and conformance

`packages.ibus-test-wasm` contains `ibus-test-wasm.js` and its WASM main module. Run
`node PATH/ibus-test-wasm.js --data DIR --module FILE`, providing the same validated version 1 trace on stdin. `DIR` is
the engine's FHS `usr/share` tree. The executable uses a memory filesystem root and mounts only that data tree and the
side module's directory, as the existing golden harness does. It applies settings through the runtime's `Init` request
before loading the side module. JSON-GLib is built privately for this test executable. The native and WASM adapters
share only GLib/JSON-GLib value helpers; their dispatch and IBus implementations remain independent.

The WASM adapter assigns runtime IDs to symbolic contexts, validates and decodes framed output in sequence order, and
emits the same typed event payloads and replies as the native adapter. It pumps after dispatch and before reporting a
reply. Explicit waits consume the same per-lifetime checkpoints as native waits, and use the runtime wake word and
next-source deadline, bounded by `timeoutMs`. A timeout is failure, never proof of completion. Destroy output is drained
before its reply. The runtime discards anything a destroyed engine emits, as native IBus does once the engine's object
is unexported, so a stale reference produces no record; a record for a closed context still fails the run, and a final
pump after every explicit context destruction checks for one. The outer `runAdapter` deadline also bounds synchronous
dispatch or a misbehaving engine.

Runtime log records remain diagnostics on stderr, outside behavioral comparison. Warning, critical, and error records
fail the run. Early GLib initialization logs also use stderr. Until the Init request, the executable uses GLib's fatal
severity mask for warning-or-worse, so a warning with no framed writer to report through exits nonzero with its
diagnostic on stderr and an empty transcript. The original mask is restored before Init, which installs the framed
writer before applying the settings snapshot: an unknown schema or key or an invalid initial value arrives as a Log
record and fails the run with step 0 error records before the engine module loads. Non-log global records, including
`SettingWritten` with context ID zero, fail explicitly with their kind, ID, signature and typed payload. The native
boundary currently observes Engine signals, and live-settings output parity is deferred; no invented context or
suppressed record hides that limit.

On Linux, `checks.engines-ibus-test-conformance` runs a portable controlled engine against stock native libibus and,
separately, the WASM replacement. It checks lifecycle, two contexts, Unicode/attachments, empty updates, event order,
waits, settings, invalid calls, deadlines, context reuse, output preceding closure and diagnostics. Native
transport-failure fixtures and Hangul goldens remain separate checks. This CLI harness does not establish browser
host/router conformance.

`ibusWeb.engines.ibusTest { name; nativeConfig; module; data; traces; expectedDifferences?; coverage?; versions?; }`
builds a Linux check for supplied trace paths and any configured engine. `nativeConfig` is a session-config JSON path;
`module` is the WASM side-module path; `data` is its `usr/share` tree; `traces` is a nonempty list of trace JSON paths.
Each trace runs in a fresh private native session and a fresh WASM process. Engine-specific corpus and configuration
stay outside this builder. The conformance fixture cases are enabled only in the dedicated fixture check. Transcript
differences include the reference event context (or WASM event context when the native event is absent), step, and first
differing field, retaining both values.

Optional `expectedDifferences` is an engine-local version 1 JSON document. Each declaration names a scenario and trigger
step, gives an explanatory reason, an exact contiguous sequence of native-only event records at that step, and a regular
expression matching the entire native engine stderr. The comparison requires successful native and WASM exits, no
adapter diagnostics, exact output before and after the insertion, and no undeclared differences. Unknown, duplicate,
missing, or unused declarations fail. This contract supports only extra native events at one trigger step; it cannot
excuse a changed reply or a later divergence. `coverage` is a separate version 1 engine-local document with ordered
`required` and `forbidden` event/reply observations for every scenario. It prevents a pair of equally empty transcripts
from passing. `versions` is copied into retained results for audit.

Hangul's `checks.hangul-differential` uses all three options. It exercises ten traces with physical evdev keycodes and
initial settings. The pinned native engine's final-page invalid digit emits five extra signals and exactly two nonfatal
GLib critical diagnostics; the declaration is specific to that scenario and trigger step. It is based on native engine
1.5.5 and IBus 1.5.34, not on a patched binary.

The builder materializes a `results` derivation even when a test fails. Its `status`, `results.json` and `output.txt`
retain the runner outcome, and `artifacts/` retains each trace, native session/service diagnostics, raw native and WASM
transcripts/stderr, and `result.json` with exit/signal/error metadata ordered differences, first divergence, and
supplied versions. Session-owned sockets, settings and processes are still cleaned up on failure. A separate verdict
derivation rejects failure, missing reports and malformed status; it never turns a failed run into a passing check. The
verdict prints the retained results path when it fails. Inspect or build it directly with
`nix build .#checks.x86_64-linux.CHECK.results`; building results alone records an experiment and does not assert
success. An optional `testEnvironment` attribute set configures the test process; the dedicated fixture check uses it to
enable the fixture cases.
