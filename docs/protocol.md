# TypeScript protocol

`@ibus-web/protocol` is the MIT OR Apache-2.0 wire package. Effect 4 is a peer dependency. Consumers using its schemas
need `exactOptionalPropertyTypes: true`; the package also uses `skipLibCheck` for Effect's declarations.

## Layers and decoding

The GVariant layer parses type signatures and converts between bytes and tagged `GVariantValue` trees. Integers of 64
bits are `bigint`; dictionary entries remain ordered tree nodes. `GVariantBytes(signature)` exposes the conversion as an
Effect Schema codec.

The decoder accepts exactly what GLib's `g_variant_is_normal_form` accepts. It checks alignment padding, fixed sizes,
framing offsets and their minimal width, booleans, UTF-8 and NUL termination, object paths, signatures and variant type
strings, and GLib's depth rules:

- **Type strings.** Containers nest at most 128 deep; an empty tuple `()` may still appear inside 128 containers, since
  it has no member to recurse into.
- **Values.** Every array element, maybe child, tuple or dict-entry member and variant child is one level deeper than
  its container, and a value's depth stays under 128. A variant's depth plus its child type's depth also stays
  under 128.
- **`g` values** are D-Bus signatures: a sequence of complete types, without maybe types.

Invalid bytes raise `GVariantDecodeError` with the offset of the fault; invalid signatures raise `CodecError`.

Accepted bytes re-encode byte for byte, with two exceptions. JavaScript may lose a NaN double's payload bits. And GLib
accepts a zero-byte encoding of a tuple with at least one member when every member is variable-size and itself accepts
zero bytes (arrays, maybes and such tuples): with no room for framing offsets, every offset reads as 0. The decoder
accepts these as GLib does. Where such a tuple has framing offsets (two or more members), the encoder writes them out as
explicit zeros: the empty `(ayay)` re-encodes as `00`, and `00` read as `m(ayay)` re-encodes as `0000`, read as
`a(ayay)` or `((ayay)ay)` as `0001`. No other accepted input re-encodes differently.

The encoder refuses, with `CodecError`, any value GLib wouldn't read back as given: integers outside their type's range
or not integers, strings with NUL or lone surrogates, invalid object paths, signatures and variant type strings, values
that don't match their type's shape, and nesting past the same depth rules.

The IBus layer defines each IBus type as a `Schema.Struct` annotated with its IBus name (`ibusType`), built by
`serializable(name, fields)`, which puts the attachments first; fields carry their GVariant type as an annotation.
Construct values with `IBusText.make(…)` and the like. The attachments (`a{sv}`) are a guard that accepts exactly what
`Schema.Record(Str, GVariantVariant)` accepts, without Effect's per-entry record parsing, which dominated decoding a
lookup table's hundreds of serializables. One walk of a schema's AST derives its signature and its mapping between trees
and encoded fields; it finds a GVariant annotation under any of a schema's checks, and rejects optional fields, which a
GVariant tuple can't express. Schema dictionaries are JavaScript records, so integer-like keys move ahead of other keys;
the tree layer preserves their order.

Each message is a `Schema.TaggedClass` annotated with its kind, and the messages form tagged request and output unions.
Cached synchronous schema codecs implement `encodeRequest`, `decodeRequest`, `encodeRecord` and `decodeRecord`. A host
that serves requests itself, such as the JavaScript backend, uses `decodeRequest` and `encodeRecord`. Requests have an
eight-byte header; output records have a sixteen-byte header and zero padding to eight-byte alignment. `decodeRecord`
returns `size`, including padding, for advancing a reader. Its errors split by layer: framing faults (a truncated
header, an unknown kind, any flag set, including `CONTINUATION`, whose fragments the ring reader reassembles first,
nonzero padding, a length past the buffer, a `Crashed` record with a nonzero `seq` or `ic`) throw `CodecError`; a
payload that doesn't decode as its kind's schema throws Effect's `SchemaError`. `decodeRequest(bytes)` returns
`{ ic, request }` and holds requests to the runtime's rules: a header of fewer than eight bytes, a header with no
payload (even `()` takes a byte), nonzero flags and an unknown kind (the test range `0xff00`–`0xffff` included) throw
`CodecError`, and a mismatched payload throws `SchemaError`. `encodeRecord(seq, ic, record)` writes flags 0 and the
padding, and throws `CodecError` for a `seq` or `ic` outside 32 bits, an unknown record and a `Crashed` record with a
nonzero `seq` or `ic`. `encodeRequest` throws `CodecError` for an `ic` outside 32 bits and `SchemaError` for a request
that fails its schema.

`Crashed (us)` (kind 34) is written by the host only, with `seq` and `ic` 0: its `reason` is one of `TRAP` 1, `FAULT` 2
(a request returned `-ECANCELED`), `RELAY` 3, `LOAD` 4 and `HOST` 5 (`CrashReason`), and any other value fails its
schema. The control state, not the record, is authoritative for a crash.

`CreateEngineFailed (s)` (kind 35) is written by the runtime on the request's context, ahead of the `-EIO` reply to a
`CreateEngine` that the engine failed with a reason ([runtime.md](runtime.md#protocol-dispatch-and-output)). Its
`message` is that reason.

`decodeRecord` remains the fully eager API. `decodeRecordLazy` instead carries a `LazyLookupTable` in
`UpdateLookupTable` records. The dedicated `decodeLookupTableRecord(bytes, offset?)` validates the envelope, fixed
fields, metadata and candidate/label array framing immediately, and owns a byte snapshot so ring reuse or caller
mutation cannot change later pages. `visible()` decodes the page containing `cursorPos`; `page(index)` decodes only that
page's candidate texts and its page-position labels, using the same strict value decoder and original nesting/byte
offsets. Invisible candidate payloads are checked when requested, not during initial framing. Empty/out-of-range pages
are empty; invalid indices throw `RangeError`. Core's Connection uses this lazy path before publishing panel events. The
eager decoder remains available to other callers.

`SettingsMetadata` is a separate JSON codec generated from compiled GSettings schemas. It holds each schema's id and
paths (a fixed schema's one path, a relocatable schema's declared paths, and optionally a `pattern` every one of them
matches, `{name}` standing for one or more characters other than `/`) and each key's GVariant type, default, optional
summary/description, numeric range and choices. `decodeSettingsMetadata` rejects unknown fields and validates typed
defaults/ranges. Its JSON encoding preserves 64-bit integers as decimal strings, then restores `bigint` in the decoded
tree. Generated Hangul keyboard metadata contains no `choices`; consumers must not infer an enum from the settings name.

`keyvalToUnicode(keyval)` is `ibus_keyval_to_unicode()`: the code point a keyval stands for, or `undefined` for none.
Latin-1's printable keysyms are their code points and a Unicode keysym (`0x01000000` plus the code point) its code
point, short of surrogates and past U+10FFFF; every other keysym is looked up in `keyval-unicode.generated.ts`, which
`tools/keysyms` generates from the pinned `keysymdef.h`'s annotations with the few keysyms where IBus's own table
departs from them (the angle brackets, the legacy currency signs, and the keypad's Tab and Enter, which stand for
nothing). Control characters are among its values, BackSpace's U+0008 for one. `checks.tools-keysyms-ibus` holds the
table to the native libibus's function for every keyval below the Unicode keysyms and around their bounds.

## Transport

`@ibus-web/protocol/transport` exports the shared-memory layout and the ring: `Word`, `State`, `ReqMode`,
`transportLayout` and `transportViews`, the sizes `HEADER_BYTES`, `RECORD_HEADER_BYTES` (16),
`MIN_FRAGMENT_PAYLOAD_BYTES` (8), `MIN_RING_BYTES` (64), `MAX_RING_BYTES` (2³¹), `DEFAULT_SLOT_BYTES` and
`DEFAULT_RING_BYTES`, and `RingWriter` and `RingReader`. `transportLayout` refuses a slot that isn't a positive multiple
of 8 and a ring that isn't a power of two between the two bounds: the ring must divide the byte counters' 2³² wrap and
be smaller than it, or a full ring would read as empty.

`RingWriter.write(record)` writes a framed record, or as much of it as fits as fragments, and returns `written` or
`full` with `needBytes`, the least free space with which the next write of the same record publishes a fragment,
counting any padding or skip before the ring's end. Every fragment but the last carries `CONTINUATION` and at least
`MIN_FRAGMENT_PAYLOAD_BYTES` of payload, a multiple of 8; the writer pads to the ring's end rather than shortening a
fragment to fit there. `RingReader.next()` returns the next whole record, fragments reassembled and padding skipped,
framed with flags 0 for `decodeRecord`, and clears `ringWaiting` and bumps `wake` when it frees space for a waiting
writer. Both throw on counters that claim more than the ring holds. The wire rules, including the writer's full-ring
wait, are the generated [Transport section](../packages/protocol/PROTOCOL.md#transport)'s.

`ModuleManifest` is the union of `WasmModuleManifest` (`kind` absent or `"wasm"`) and `JsModuleManifest` (`kind: "js"`),
both with `EngineDescriptor`s. `decodeModuleManifest(json, { minimum, maximum })` decodes either against the runtime's
memory bounds, which only a WebAssembly manifest is held to, rejecting unknown keys at every level; the rules are
[engines.md](engines.md#distribution-manifest)'s. The Worker host decodes a JavaScript manifest with `JsModuleManifest`
alone, since it has no runtime to take bounds from ([worker-host.md](worker-host.md#startup-failures)).

`@ibus-web/protocol/descriptor` holds `EngineDescriptor` apart from the codecs and exports nothing else; the manifests
take it from there, and the root entry re-exports it. The `nonEmpty` and `storePath` field schemas it is made of, which
the manifests and settings use too, stay internal to the package. It imports only `effect`, so a module script that
decodes its engines' descriptors bundles Effect's `Schema` and nothing else of the protocol; a package test checks its
built file's imports, through the chunk it shares with the root entry, and its exports.

## Module scripts

`@ibus-web/protocol/module-script` is the contract between the Worker host and a JavaScript module script's default
export. It holds `MODULE_ABI` (1), types, and the few plain constants a script needs beside them: `Modifier`, the
`IBusModifierType` bits a key's state holds (`RELEASE` among them), `Underline`, `IBusAttrUnderline`'s values,
`PreeditHint`, `IBusAttrPreedit`'s, `InputPurpose` and `InputHints`, the `SetContentType` request's `purpose` and
`hints`, and the contract's names as arrays, `attributeTypes`, `propertyKinds`, `propertyStates` and `logLevels`, from
which its types are drawn. It imports nothing, so a script that uses it pulls nothing of Effect or the codecs into its
bundle; a package test checks that its built file has no import or re-export, and that its constants are IBus's. A
JavaScript manifest's `moduleAbi` and the export's `ibusWebModule` both state `MODULE_ABI`, a plain property rather than
a symbol so that it survives any bundler.

- `ModuleScript` is the export: `ibusWebModule`, `name`, `version`, `license`, an optional `settingsPrefix`, `engines`
  by IBus engine name in the manifest's order, and optional `persist()` and `shutdown()`. An engine's settings schema id
  is `<settingsPrefix>.<engine>`, and its path that id's components joined by `/`.
- `ModuleEngine` is an engine: its `descriptor` (the manifest's `EngineDescriptor` without its name), its `settings`
  declarations by key and `create(context)`, which returns an `EngineSession`. A throw from `create` fails the
  `CreateEngine` with the error's message.
- `SettingDeclaration` declares a key as `b`, `s` (optionally with `choices`), `i` or `d` (optionally with an inclusive
  `range`), or `as`, with a default of that type and an optional summary and description. `SettingValue` is
  `boolean | string | number | readonly string[]`.
- `EngineContext` is what a session writes to. `commit`, `preedit(text, cursor, visible, mode)`,
  `auxiliary(text, visible)`, `lookupTable(page, visible)`, `registerProperties`, `updateProperty`, `forwardKey`,
  `deleteSurrounding` and `requireSurrounding` each queue the output record of the same name, in call order.
  `settings.get` and `settings.set` read and write the host's store of the engine's own keys, and throw for an
  undeclared key or, on `set`, a value outside the key's type, range or choices. `after(ms, fn)` runs `fn` from the
  host's pump and returns a function that cancels it, since the event loop never runs while a module is serving.
  `log(level, message)` takes `debug`, `info`, `warning` or `error`. Calls on a destroyed session's context are ignored.
- `EngineSession` has one optional handler per engine request, with the request's fields as arguments:
  `processKey(keyval, keycode, state, character)`, which returns whether it consumed the key and gets the key's text
  (empty for none) beside IBus's values; `focusIn`, `focusOut`, `reset`, `enable`, `disable`, `setCursorLocation`,
  `setCapabilities`, `pageUp`, `pageDown`, `cursorUp`, `cursorDown`, `candidateClicked`, `propertyActivate`,
  `setSurroundingText(text, cursor, anchor)`, `setContentType` and `destroy`. `settingChanged(key, value)` runs in every
  session of the engine when a stored value changes: at once for a change from the page, and once the call that set it
  returns for a session's `settings.set`. A missing handler does nothing and a missing `processKey` consumes no key; a
  throw from any handler is a fault.
- The values crossing it are plain. `RichText` is a string or a `StyledText`, a string with `TextAttribute` ranges
  (`underline`, `foreground`, `background` or `hint`, with IBus's value) counted in code points, as every cursor and
  offset is. `CandidatePage` is the one page the panel displays: its candidates, optional labels, the cursor's index on
  it, whether the cursor is visible and an orientation. `Property` is a whole `IBusProperty`: key, `kind` (`normal`,
  `toggle`, `radio`, `menu` or `separator`), label, optional symbol, tooltip and icon, `sensitive` and `visible`
  (default true), `state` (`unchecked`, the default, `checked` or `inconsistent`) and a menu's `children`.

The main entry checks a default export against the contract alone, apart from any manifest. `scriptProblem(exported)`
returns undefined for a module script, and otherwise `NotAModule`, `ModuleAbiMismatch` with the `abi` it states, or
`Unsound` with the `reason`: a `persist` or `shutdown` that isn't a function, no engines, an engine named as an array
index or without a `create` function, a `settingsPrefix` that can't start a schema id, settings without one, or a
setting whose name a record can't carry or whose declaration `declarationProblem` refuses.
`settingAccepts(declaration, value)` is whether a value is of a setting's type and within its range or choices, and
`settingsSchemaIds` and `settingsSchemaPath` give a module's schema ids and an id's path.

## Generated artifacts

The schemas define message names, numbers, fields, signatures and descriptions; TypeScript also defines protocol version
1, header layouts and the continuation flag. `scripts/protocol-h.ts` generates the LGPL-2.1-or-later header installed by
`libibus-web`, preserving its C ABI, and wraps its comments to clang-format's 80 columns so that formatting leaves them
as written. `scripts/protocol-md.ts` generates the package's [wire reference](../packages/protocol/PROTOCOL.md),
including the IBus serializers and message framing; it is in the package's `files`, so every release carries it. Both
state the framing rules from one source, `scripts/framing-notes.ts`, built from the header layouts. The document's
Transport section renders the control words from `transport/layout.ts`'s data and derives its sizes from the layout's
constants.

`packages/protocol/module.nix` runs those generators against the built TypeScript workspace and formats their output
with clang-format and oxfmt respectively. Run `nix run .#write-files` to update committed artifacts. The corresponding
`files:` checks reject stale copies. Package tests check generated content as well as schema metadata; repository
`checks.flake-hk` checks types, formatting and licensing.

## Parity pipeline

1. The corpus derivation runs `test/parity/write-corpus.ts`, writing typed TypeScript object bytes, runtime requests,
   and 1000 fixed-seed byte strings for the normal-form comparison: 600 normal-form encodings of random typed values
   (some of them containers large enough for 2- and 4-byte offsets) with one to three bytes replaced, flipped, truncated
   or appended; 340 unmutated encodings; and 60 large containers sized around the 255- and 65535-byte offset-width
   boundaries.
2. The parity-output derivation compiles `test/parity/c/parity.c` to WASM against real IBus, `libibus-web` and json-glib
   (`ibusWeb.engines.jsonGlib`). Under Node it reads the corpus, serializes and deserializes IBus objects, dispatches
   requests, emits records and records `g_variant_is_normal_form` judgments. It produces fixtures, not test assertions.
3. `checks.protocol-parity` runs `vitest.parity.config.ts` with both derivation paths in `IBUS_WEB_PROTOCOL_PARITY`.
   Tests compare object fields and bytes in both directions, every request's arguments and result (including lifecycle
   and settings), and all implemented record kinds with sequence, context and flags. For every fuzz input the decoder
   must accept exactly when GLib calls the bytes normal form, without exceptions.

The parity suite throws when `IBUS_WEB_PROTOCOL_PARITY` is unset, so the check can't pass by skipping it, and the
default Vitest configuration leaves it out. The fuzz test also holds the corpus to floors well under its seeded mix (555
of 1000 cases normal form, 139 signatures): at least 40% normal form, at least 30% not, at least 100 distinct
signatures, and accepted containers with framing offsets of widths 1, 2 and 4. A generator change that degrades the
corpus fails the check.

`checks.protocol-node` runs the unit, property and generator suites. Both checks are part of `nix flake check`. The
deterministic corpora provide concrete coverage, not an exhaustive proof over all GVariant values. Effect `Arbitrary`
supplies schema-derived and composed inputs with fixed seeds; no fast-check dependency is used.

## Adding a message

Add a schema class in `src/messages/requests.ts` or `records.ts`, with annotated fields, its kind number and
description, then include it in the union and public exports. Reuse the annotated integer and string schemas and IBus
serializables. Extend kind/signature tests and parity fixtures, including the C producer's observed request or emitted
signal. Regenerate the header and wire reference, implement the runtime behavior, and run `checks.protocol-node`,
`checks.protocol-parity` and the full `nix flake check`. Coordinate protocol-version changes with every wire consumer.

## Lookup decode measurement

The decode benchmark times wall-clock work, so it isn't a check: a loaded builder would make its figures meaningless.
Run it on an otherwise idle machine:

```sh
nix run .#protocol-bench
```

or `pnpm run bench` in `packages/protocol` (`vitest.bench.config.ts`). `test/bench/lookup-table.test.ts` builds an
`UpdateLookupTable` record of 500 candidates cycling through 한글, 한국어, 대한민국, each with one underline attribute,
and nine digit labels with one attribute. The framed record is **64,832 bytes** (64,816 payload bytes). After a
correctness assertion, each operation warms 50 times and times 500 calls with `performance.now()`. The median averages
the middle two samples; p99 uses nearest rank. It prints the machine, the figures and the raw samples. Each layer is
measured separately, so its timings need not sum to the framed time; tree to schemas includes the walk and schema
validation and construction.

On 2026-10-04, Linux x86_64 kernel 6.18.52-xanmod1, AMD Ryzen 9 9950X3D 16-Core Processor, Node v24.21.0, Effect 4.0.0:

| Operation       | Median (ms) | p99 (ms) |
| --------------- | ----------- | -------- |
| Framed decode   | 1.01        | 4.40     |
| Bytes to tree   | 0.43        | 6.95     |
| Tree to schemas | 0.46        | 0.68     |

These are historical M1.2 single-machine Node figures, not browser or end-to-end keystroke latency. The eager framed
median exceeded the design's 0.5 ms target. After the owned-byte lazy decoder repair, one isolated 2026-10-05 run on the
same Ryzen 9 9950X3D, Linux 6.18.54-xanmod1 and Node 24.21.0 measured 500 samples of the 64,832-byte framed record with
500 candidates and nine visible: framed record to visible page median **0.085610 ms**, p99 **0.286419 ms**. This
includes synchronous framing, payload copy, metadata validation and visible-page decode; it excludes browser
key/Worker/ring and paint latency. The fully eager decoder remains public, while production core uses lazy lookup
records. Effect's `SchemaAOTCompiler` isn't used: compiling the record and request ASTs didn't lower the framed median,
since the bytes-to-tree transformations stay interpreted.
