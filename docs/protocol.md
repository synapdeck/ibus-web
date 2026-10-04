# TypeScript protocol

`@ibus-web/protocol` is the MIT OR Apache-2.0 wire package. Effect 4 is a peer
dependency. Consumers using its schemas need `exactOptionalPropertyTypes: true`;
the package also uses `skipLibCheck` for Effect's declarations.

## Layers and decoding

The GVariant layer parses type signatures and converts between bytes and tagged
`GVariantValue` trees. Integers of 64 bits are `bigint`; dictionary entries remain
ordered tree nodes. `GVariantBytes(signature)` exposes the conversion as an Effect
Schema codec.

The decoder accepts exactly what GLib's `g_variant_is_normal_form` accepts. It checks
alignment padding, fixed sizes, framing offsets and their minimal width, booleans,
UTF-8 and NUL termination, object paths, signatures and variant type strings, and
GLib's depth rules:

- **Type strings.** Containers nest at most 128 deep; an empty tuple `()` may still
  appear inside 128 containers, since it has no member to recurse into.
- **Values.** Every array element, maybe child, tuple or dict-entry member and variant
  child is one level deeper than its container, and a value's depth stays under 128.
  A variant's depth plus its child type's depth also stays under 128.
- **`g` values** are D-Bus signatures: a sequence of complete types, without maybe
  types.

Invalid bytes raise `GVariantDecodeError` with the offset of the fault; invalid
signatures raise `ProtocolError`.

Accepted bytes re-encode byte for byte, with two exceptions. JavaScript may lose a
NaN double's payload bits. And GLib accepts a zero-byte encoding of a tuple with at
least one member when every member is variable-size and itself accepts zero bytes
(arrays, maybes and such tuples): with no room for framing offsets, every offset
reads as 0. The decoder accepts these as GLib does. Where such a tuple has framing
offsets (two or more members), the encoder writes them out as explicit zeros: the
empty `(ayay)` re-encodes as `00`, and `00` read as `m(ayay)` re-encodes as `0000`,
read as `a(ayay)` or `((ayay)ay)` as `0001`. No other accepted input re-encodes
differently.

The encoder refuses, with `ProtocolError`, any value GLib wouldn't read back as
given: integers outside their type's range or not integers, strings with NUL or lone
surrogates, invalid object paths, signatures and variant type strings, values that
don't match their type's shape, and nesting past the same depth rules.

The IBus layer defines each IBus type as a `Schema.Struct` annotated with its IBus
name (`ibusType`), built by `serializable(name, fields)`, which puts the attachments
first; fields carry their GVariant type as an annotation. Construct values with
`IBusText.make(…)` and the like. The attachments (`a{sv}`) are a guard that accepts
exactly what `Schema.Record(Str, GVariantVariant)` accepts, without Effect's per-entry
record parsing, which dominated decoding a lookup table's hundreds of serializables.
One walk of a schema's AST derives its signature and its mapping between trees and
encoded fields; it finds a GVariant annotation under any of a schema's checks, and
rejects optional fields, which a GVariant tuple can't express. Schema dictionaries
are JavaScript records, so integer-like keys move ahead of other keys; the tree layer
preserves their order.

Each message is a `Schema.TaggedClass` annotated with its kind, and the messages form
tagged request and output unions. Cached synchronous schema codecs implement
`encodeRequest` and `decodeRecord`. Requests have an eight-byte header; output records
have a sixteen-byte header and zero padding to eight-byte alignment. `decodeRecord`
returns `size`, including padding, for advancing a reader. Its errors split by layer:
framing faults (a truncated header, an unknown kind, any flag set, including
`CONTINUATION`, whose fragments the M1.3 ring reader reassembles, nonzero padding,
a length past the buffer) throw `ProtocolError`; a payload that doesn't decode as
its kind's schema throws Effect's `SchemaError`. `encodeRequest` throws
`ProtocolError` for an `ic` outside 32 bits and `SchemaError` for a request that
fails its schema. `Crashed` has reserved kind 34 but no payload schema until the host
milestone defines it.

## Generated artifacts

The schemas define message names, numbers, fields, signatures and descriptions;
TypeScript also defines protocol version 1, header layouts and the continuation flag.
`scripts/protocol-h.ts` generates the LGPL-2.1-or-later header installed by
`libibus-web`, preserving its C ABI, and wraps its comments to clang-format's
80 columns so that formatting leaves them as written. `scripts/protocol-md.ts`
generates the package's [wire reference](../packages/protocol/PROTOCOL.md), including
the IBus serializers and message framing; it is in the package's `files`, so every
release carries it. Both state the framing rules from one source,
`scripts/framing-notes.ts`, built from the header layouts. The SAB layout joins the
document in M1.3, when its schemas exist.

`packages/protocol/module.nix` runs those generators against the built TypeScript
workspace and formats their output with clang-format and oxfmt respectively.
Run `nix run .#write-files` to update committed artifacts. The corresponding
`files:` checks reject stale copies. Package tests check generated content as well
as schema metadata; repository `checks.hk` checks types, formatting and licensing.

## Parity pipeline

1. The corpus derivation runs `test/parity/write-corpus.ts`, writing typed TypeScript
   object bytes, runtime requests, and 1000 fixed-seed byte strings for the
   normal-form comparison: 600 normal-form encodings of random typed values (some of
   them containers large enough for 2- and 4-byte offsets) with one to three bytes
   replaced, flipped, truncated or appended; 340 unmutated encodings; and 60 large
   containers sized around the 255- and 65535-byte offset-width boundaries.
2. The parity-output derivation compiles `test/parity/c/parity.c` to WASM against
   real IBus, `libibus-web` and json-glib (`ibusWeb.testing.jsonGlib`). Under Node it
   reads the corpus, serializes and deserializes IBus objects, dispatches requests,
   emits records and records `g_variant_is_normal_form` judgments. It produces
   fixtures, not test assertions.
3. `checks.protocol-parity` runs `vitest.parity.config.ts` with both derivation paths
   in `IBUS_WEB_PROTOCOL_PARITY`. Tests compare object fields and bytes in both
   directions, every request's arguments and result (including lifecycle and
   settings), and all implemented record kinds with sequence, context and flags. For
   every fuzz input the decoder must accept exactly when GLib calls the bytes normal
   form, without exceptions.

The parity suite throws when `IBUS_WEB_PROTOCOL_PARITY` is unset, so the check
can't pass by skipping it, and the default Vitest configuration leaves it out. The
fuzz test also holds the corpus to floors well under its seeded mix (555 of 1000
cases normal form, 139 signatures): at least 40% normal form, at least 30% not,
at least 100 distinct signatures, and accepted containers with framing offsets of
widths 1, 2 and 4. A generator change that degrades the corpus fails the check.

`checks.protocol` runs the unit, property and generator suites. Both checks are part
of `nix flake check`. The deterministic corpora provide concrete coverage, not an
exhaustive proof over all GVariant values. Effect `Arbitrary` supplies
schema-derived and composed inputs with fixed seeds; no fast-check dependency is
used.

## Adding a message

Add a schema class in `src/messages/requests.ts` or `records.ts`, with annotated
fields, its kind number and description, then include it in the union and public
exports. Reuse the annotated integer and string schemas and IBus serializables.
Extend kind/signature tests and parity fixtures, including the C producer's observed
request or emitted signal. Regenerate the header and wire reference, implement the
runtime behavior, and run `checks.protocol`, `checks.protocol-parity` and the full
`nix flake check`. Coordinate protocol-version changes with every wire consumer.

## Lookup decode measurement

The decode benchmark times wall-clock work, so it isn't a check: a loaded builder
would make its figures meaningless. Run it on an otherwise idle machine:

```sh
nix run .#protocol-bench
```

or `pnpm run bench` in `packages/protocol` (`vitest.bench.config.ts`).
`test/bench/lookup-table.test.ts` builds an `UpdateLookupTable` record of 500
candidates cycling through 한글, 한국어, 대한민국, each with one underline attribute,
and nine digit labels with one attribute. The framed record is **64,832 bytes**
(64,816 payload bytes). After a correctness assertion, each operation warms 50 times
and times 500 calls with `performance.now()`. The median averages the middle two
samples; p99 uses nearest rank. It prints the machine, the figures and the raw
samples. Each layer is measured separately, so its timings need not sum to the framed
time; tree to schemas includes the walk and schema validation and construction.

On 2026-10-04, Linux x86_64 kernel 6.18.52-xanmod1, AMD Ryzen 9 9950X3D 16-Core
Processor, Node v24.21.0, Effect 4.0.0:

| Operation       | Median (ms) | p99 (ms) |
| --------------- | ----------- | -------- |
| Framed decode   | 1.01        | 4.40     |
| Bytes to tree   | 0.43        | 6.95     |
| Tree to schemas | 0.46        | 0.68     |

These are single-machine Node figures, not browser or end-to-end keystroke latency.
The framed median is twice the design's 0.5 ms target (spec §11.7), and each layer
alone takes most of it, so M1.4 decodes the visible page eagerly and the remaining
candidates on the panel's request; the public decoder builds the complete table.
Effect's `SchemaAOTCompiler` isn't used: compiling the record and request ASTs
didn't lower the framed median, since the bytes-to-tree transformations stay
interpreted.
