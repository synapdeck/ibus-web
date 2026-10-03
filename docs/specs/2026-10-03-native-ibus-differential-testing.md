# Native IBus differential testing

## Intent and scope

Drive a real native IBus engine and its WASM port with the same scenarios,
and report observable differences. The driver must work for later engines
without Hangul-specific branches. This complements the existing golden tests:
it supplies an independent reference for their expectations.

The first delivery covers deterministic request/reply behavior, initial
settings, composition, focus/reset, capabilities, lookup tables, candidate
selection and surrounding text. Hangul is the first real engine. A small
controlled native engine fixture tests the driver's generic behavior and
failure handling independently of Hangul.

## Boundary

The native adapter calls `org.freedesktop.IBus.Engine` over GDBus, through
an engine created by its real `IBusFactory`. It captures engine signals before
they are transformed by `ibus-daemon` or a toolkit client. Native `libibus`,
GLib and the engine come from the same pinned nixpkgs input as the port.
The reference does not link our replacement `libibus-web`.

Run the native engine with a private D-Bus/IBus session and isolated settings,
runtime and data directories. Use explicit bus addresses and process handles;
never discover, replace or change the user's desktop IBus session. Launch the
stock native engine with its normal entry point. The session supplies the
config service required by engines such as Hangul. No display automation or
keyboard injection is involved.

A later input-context adapter can compare daemon/client behavior separately.
It must configure client-side preedit commits and capabilities explicitly;
those policies can change observable output.

## Reusable components

- `tools/ibus-test/`: TypeScript trace orchestration, validation, subprocess
  lifecycle, transcript comparison and readable first-divergence reports.
  Dependencies stay in `tools/package.json`.
- A small C native adapter uses GLib/GIO/libibus for D-Bus and IBus values.
  It accepts the factory destination/path and engine name as configuration.
- A WASM adapter reuses the existing runtime mounting, dispatch and output
  collection interfaces. It interprets the same trace vocabulary.
- Shared test-only value conversion uses maintained GLib/IBus serialization
  and JSON-GLib for JSON where needed, rather than a new D-Bus or GVariant
  codec. It is separate from the future production TypeScript protocol codec.
- `modules/engines/`: Nix builders/check wiring reusable by engine packages.
- `engines/<name>/checks/differential/`: engine configuration, traces, data
  mounts, settings schemas and explicitly documented expected differences.

Adding another engine should supply its executable/arguments, service and
factory identity, engine name, schemas, data and scenarios. It should not
change the D-Bus driver or comparison algorithm. Protocol operations such as
content type must map to the actual upstream method/property interface.

## Trace and transcript contract

A versioned trace describes initial settings and ordered operations: create,
destroy, engine method calls, capabilities, content type and surrounding text.
Key inputs include keyval, evdev code, modifiers and explicit releases. Tests
can create multiple independently named contexts. Engine-specific hotkeys,
keyboard names and expected words belong only in fixtures.

Both adapters return step-indexed replies and ordered semantic events. Compare
text, attributes, preedit cursor/visibility/mode, candidate order, lookup cursor
and page size, properties, surrounding deletions and forwarded keys. Preserve
IBus variant types and attachments. Normalize transport identity only: native
object paths, runtime context numbers and sequence counters map to trace IDs.
Do not hide extra events, reorder events or discard empty updates.

Method replies delimit synchronous engine output. Capture signals and replies
in connection order, and test that the adapter does not lose signals queued
before a reply. Asynchronous scenarios use explicit expected-event checkpoints
with bounded timeouts; an empty event loop or an arbitrary sleep is not proof
of completion. Record unexpected trailing output and process death as failures.

Initial settings are seeded before engine startup in both adapters. General
live-settings parity is deferred until there is an observable engine-side
completion condition; a successful cross-process settings write alone does
not prove the engine processed its notification. Existing WASM golden tests
continue covering live changes and destruction callbacks.

## Differences and failures

Keep the native reference unpatched for behavior changes. Cases intentionally
fixing upstream bugs have named, narrowly matched expected outcomes for each
side, with the reason recorded beside the scenario. Run native-crash cases in
separate processes. Unexpected crashes, hangs, malformed traces, unknown
operations and unexpected differences fail; expected-difference declarations
must fail when stale. Logs are diagnostics, not substitutes for behavior.

A failed comparison retains the input trace, both transcripts, versions,
process exit status and stderr, and reports the earliest differing step and
field. All child processes and private session resources are cleaned up on
success, assertion failure, timeout and interruption.

## Acceptance

1. The generic driver passes against a controlled native test engine, including
   signal/reply ordering, two contexts, invalid requests, delayed events,
   process exit and timeout cleanup.
2. Hangul native/WASM traces cover Latin input, toggle and composition,
   CapsLock, BackSpace, focus/reset, Hanja selection/paging, password purpose,
   surrounding-text conversion and forwarding order, with initial settings
   covering the configured alternative Hanja key and keyboard layout.
3. Deliberately perturbing one WASM event produces a useful failing diff.
4. The last-page candidate bug is a narrowly recorded native/WASM difference,
   not an ignored scenario or a patched native reference.
5. The check runs offline as a Nix flake check and needs no user session,
   display server or changes to production runtime dependencies.

## Non-goals

No browser/router conformance, production protocol codec, automatic trace
shrinking, generic live-settings synchronization or broad random fuzzing in
this first delivery. These can build on the stable trace/adapters later.
