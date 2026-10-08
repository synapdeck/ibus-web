# @ibus-web/protocol

The wire protocol between ibus-web's page and its Worker hosts: strict GVariant codecs, the typed
messages each side sends, and the shared-memory transport they travel over. Everything ibus-web
sends between the page and an engine's Worker goes through this package, and its decoder accepts
exactly what GLib's `g_variant_is_normal_form` accepts.

Most applications use [`ibus-web`](../ibus-web/README.md), which depends on this package; use it
directly to write your own host or page side.

```ts
import { decodeValue, encodeValue } from "@ibus-web/protocol";

const bytes = encodeValue("s", { _tag: "s", value: "us" });
const value = decodeValue("s", bytes);
```

Values are tagged unions. `stringVariant`, `booleanVariant`, `int32Variant` and `variant(type, value)` build the typed
variants that ibus-web's settings API takes. `@ibus-web/protocol/transport` is the transport-only
entry: the ring buffer, control layout and their constants, without the codecs. The root also
exports the main transport symbols (`RingWriter`, `RingReader`, `transportLayout`,
`transportViews`, `Word`, `State`, `ReqMode` and the default sizes). `effect` 4 is a peer dependency.

The generated message reference is [`PROTOCOL.md`](PROTOCOL.md); the design is in
[docs/protocol.md](https://github.com/synapdeck/ibus-web/blob/master/docs/protocol.md).

Licensed under MIT OR Apache-2.0, at your option.
