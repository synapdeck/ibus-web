# TypeScript protocol

`@ibus-web/protocol` is the MIT OR Apache-2.0 wire package. Effect 4 is a peer
dependency. Consumers using its schemas need `exactOptionalPropertyTypes: true`;
the package also uses `skipLibCheck` for Effect's declarations.

## Layers and decoding

The GVariant layer parses type signatures and converts between bytes and tagged
`GVariantValue` trees. Integers of 64 bits are `bigint`; dictionary entries remain
ordered tree nodes. `GVariantBytes(signature)` exposes the conversion as an Effect
Schema codec. The decoder accepts GLib normal form only, checking alignment padding,
fixed sizes, offsets and their minimal width, booleans, UTF-8 and NUL termination,
object paths, signatures, variant types and GLib's depth limit of 128. Invalid bytes
raise `GVariantDecodeError`; invalid signatures raise `ProtocolError`. Exact byte
round trips have one caveat: JavaScript may lose NaN payload bits.

The IBus layer declares `Schema.Class`es and GVariant annotations. `serializable`
adds the IBus name and attachments; the schema walker derives signatures and maps
between trees and encoded fields. Schema dictionaries are JavaScript records, so
integer-like keys move ahead of other keys. The tree layer preserves their order.

Message classes form tagged request and output unions. Cached synchronous schema
codecs implement `encodeRequest` and `decodeRecord`. Requests have an eight-byte
header; output records have a sixteen-byte header and zero padding to eight-byte
alignment. `decodeRecord` returns `size`, including padding, for advancing a reader.
The ring reader owns fragment reassembly in M1.3: continuation records are rejected.
`Crashed` has reserved kind 34 but no payload schema until that host milestone.

## Generated artifacts

The schemas define message names, numbers, fields, signatures and descriptions;
TypeScript also defines protocol version 1, header layouts and the continuation flag.
`scripts/protocol-h.ts` generates the LGPL-2.1-or-later header installed by
`libibus-web`, preserving its C ABI. `scripts/protocol-md.ts` generates the package's
[wire reference](../packages/protocol/PROTOCOL.md), including the IBus serializers
and message framing. This is distinct from the host's SAB layout.

`packages/protocol/module.nix` runs those generators against the built TypeScript
workspace and formats their output with clang-format and oxfmt respectively.
Run `nix run .#write-files` to update committed artifacts. The corresponding
`files:` checks reject stale copies. Package tests check generated content as well
as schema metadata; repository `checks.hk` checks types, formatting and licensing.

## Parity pipeline

1. The corpus derivation runs `test/parity/write-corpus.ts`, writing typed TypeScript
   object bytes, runtime requests, and a fixed-seed corpus of 500 byte strings over
   twenty GVariant signatures.
2. The parity-output derivation compiles `test/parity/c/parity.c` to WASM against
   real IBus, `libibus-web` and json-glib. Under Node it reads the corpus, serializes
   and deserializes IBus objects, dispatches requests, emits records and records
   `g_variant_is_normal_form` judgments. It produces fixtures, not test assertions.
3. `checks.protocol-parity` passes both derivation paths to Vitest through
   `IBUS_WEB_PROTOCOL_PARITY`. Tests compare object fields and bytes in both
   directions, every request's arguments and result (including lifecycle and
   settings), and all implemented record kinds with sequence, context and flags.
   They compare the decoder's accept/reject result with GLib for every fuzz input.

`checks.protocol` runs the unit, property, generator and benchmark suites; parity
cases skip without their manifest. Both checks are included in `nix flake check`.
The deterministic corpora provide concrete coverage, not an exhaustive proof over
all GVariant values. Effect `Arbitrary` supplies schema-derived and composed inputs
with fixed seeds; no fast-check dependency is used.

## Adding a message

Add a schema class in `src/messages/requests.ts` or `records.ts`, with annotated
fields, its kind number and description, then include it in the union and public
exports. Reuse the annotated integer and string schemas and IBus serializables.
Extend kind/signature tests and parity fixtures, including the C producer's observed
request or emitted signal. Regenerate the header and wire reference, implement the
runtime behavior, and run `checks.protocol`, `checks.protocol-parity` and the full
`nix flake check`. Coordinate protocol-version changes with every wire consumer.

## Lookup decode measurement

On 2026-10-03, Linux x86_64 kernel 6.18.52-xanmod1, AMD Ryzen 9 9950X3D
16-Core Processor, Node v24.21.0, Effect 4.0.0:

| Run                                | Framed median / p99 (ms) | Bytes to tree median / p99 (ms) | Tree to classes median / p99 (ms) |
| ---------------------------------- | ------------------------ | ------------------------------- | --------------------------------- |
| Nix `checks.protocol`, interpreted | 2.6625 / 4.4335          | 1.2556 / 1.5651                 | 1.3797 / 1.8788                   |
| Local interpreted comparison       | 2.6921 / 4.2343          | 1.2438 / 1.7107                 | 1.3228 / 1.6697                   |
| Local AOT comparison               | 2.7174 / 4.6268          | 1.3219 / 5.6585                 | 1.2989 / 1.9813                   |

`test/bench/lookup-table.test.ts` builds 500 candidates cycling through 한글, 한국어,
대한민국, each with one underline attribute, and nine digit labels with one attribute.
The framed record is **64,832 bytes** (64,816 payload bytes). After a correctness
assertion, each operation warms 50 times and times 500 calls with `performance.now()`.
Median averages the middle two samples; p99 uses nearest rank. Setup, sorting and
logging are outside timing. Raw samples and environment details stay in the check's
`output.txt`. Each layer is measured separately, so its timings need not sum to the
framed time. Tree to classes includes the walker and schema validation/construction.

AOT targeted every record AST for decode and every flipped request AST for decode
(encoding), installed before codec creation. It compiled static class/array loops;
bytes/tree transformations stayed interpreted. Fresh local Vitest processes ran AOT
then interpreted sequentially. The framed median did not improve, so AOT was left out;
there is no generated AOT artifact. These are single-machine Node measurements, not
browser or end-to-end keystroke latency results.

The < 5 ms builder assertion passes, but the < 0.5 ms design target is unmet. M1.4
must address visible-page eager decoding with remaining candidates decoded on panel
request; the current public decoder eagerly builds the complete lookup table. Even
the bytes-to-tree layer alone exceeds the target on this fixture.

A concurrent full-flake run measured 5.3899 ms median / 79.1824 ms p99 and failed
the same 5 ms assertion. The bound is sensitive to builder load; it is not a
machine-independent latency guarantee. Run the protocol check alone when diagnosing
a timing failure, retaining both results rather than relaxing the threshold.
