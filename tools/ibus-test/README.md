<!-- SPDX-FileCopyrightText: 2026 Synapdeck, Inc. -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# IBus test adapter protocol

`types.ts` defines the version 1 trace and JSON Lines transcript. The native
executable is available on Linux as `packages.ibus-test-native`; its tests are
`checks.ibus-test-native`. Run it with `--address ADDRESS --destination NAME
--factory PATH --timeout-ms N`. Supply one validated trace on stdin. The session
runner applies `settings` before launching the engine; the adapter does not apply
settings. Engine object paths remain internal; contexts are symbolic names.

Every created context must have an explicit `destroy` step before a trace ends.
The shared validator rejects open contexts. Create, destroy, wait, and unit calls
reply with JSON null; `ProcessKeyEvent` replies with a boolean. Other reply bodies
retain their typed GVariant representation. `SetContentType` takes `(uu)` and
maps to `org.freedesktop.DBus.Properties.Set` on the engine's `ContentType`.

The native driver preserves incoming D-Bus message order, including signals
preceding method replies and signals emitted during factory creation. Values use
JSON-GLib and GLib's annotated `g_variant_print` text plus the exact signature;
there is no replacement IBus implementation or custom variant codec involved.

If creation fails, buffered signals for known contexts still appear before the
terminal creation error. Signals whose paths cannot be resolved appear as error
diagnostics at their original positions, retaining path, name, signature, and
payload. Draining continues after such a diagnostic, and the original factory
failure remains the final error record.

Each event belongs to the step that observes it. A `wait` consumes the earliest
unconsumed matching context/name event, including an event already observed
while executing an earlier call. Its original transcript position and step stay
unchanged. Nonmatching events are retained. Destroying a context clears its
unconsumed checkpoints so reusing a symbolic name cannot consume old events.

Method replies and matching events are explicit bounded checkpoints. Destroy's
reply closes the context lifetime, and a final `Peer.Ping` on the factory is the
ordered end-of-trace barrier. Signals through that barrier are processed; an
engine signal on an unknown or destroyed path is an error. An engine must stop
emitting context output after destruction. A barrier cannot make claims about an
engine that violates that lifetime after the barrier itself. No idle-loop or
sleep heuristic declares success. Errors produce a JSON error record at the
active step and exit status 1; invalid CLI arguments exit with status 2.
