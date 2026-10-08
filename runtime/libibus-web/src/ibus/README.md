<!-- SPDX-FileCopyrightText: 2026 Synapdeck, Inc. -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# IBus source inventory

Imported from IBus 1.5.34, released at
<https://github.com/ibus/ibus/archive/refs/tags/1.5.34.tar.gz>.
The locked nixpkgs fetcher's unpacked-source hash is
`sha256-MCxzMnG+g2FC4pZtDOP2c7vSRG5Zk6EfrkGnEyFvBfQ=`.
Upstream files were committed unchanged before adaptation. Paths below are
relative to `runtime/libibus-web`; generated build outputs are not vendored.

Callback changes preserve layouts and serialization. Explicit callbacks use
the base class's actual function type and convert object pointers inside the
function. The hand-written serializable GType initializers take both arguments
GLib passes. The cast-audit allow-list documents the GLib-generated
adapters whose pointer parameters have identical WASM signatures.

Meson generates enums and marshallers with the cross GLib tools. Its explicit
IBus identifier and symbol prefixes replace upstream's post-generation sed
renaming. The generated marshallers use their callback-specific typedefs.

Files marked ours are reimplementations written for the runtime, not
adaptations: some share a name with an upstream file, but diffing them
against it shows nothing useful. `checks.libibus-web-vendored` holds the rest
to this table: files marked unchanged must be byte-identical to the IBus
source the build uses, adapted ones must differ from theirs, the generated
version header must be what upstream's template gives for the release above,
and that release and hash must be the build's IBus source's.

To review the adaptations against an unpacked release, set `IBUS_SOURCE` to
its directory and run this from the repository root. A diff exit status of 1
means that an adapted file differs.

```sh
cd runtime/libibus-web
sed -n 's/^| `\([^`]*\)` *| Upstream.*/\1/p' src/ibus/README.md |
  while read -r local; do
    upstream="$IBUS_SOURCE/src/${local##*/}"
    case "$local" in
      *.gschema.xml) upstream="$IBUS_SOURCE/data/dconf/${local##*/}" ;;
    esac
    diff -u "$upstream" "$local"
  done
```

| File                                        | Origin and purpose; changes                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ibus/README.md`                        | Ours: this inventory and adaptation record.                                                                                                             |
| `src/ibus/ibusattribute.c`                  | Upstream attributes and end-index representation; exact serialization callback signatures.                                                              |
| `src/ibus/ibusattrlist.c`                   | Upstream attribute lists and color helpers; exact virtual method signatures.                                                                            |
| `src/ibus/ibusattrlistprivate.h`            | Upstream internal color representation; mark conversion helpers internal so they are not exported.                                                      |
| `src/ibus/ibuscomponent.c`                  | Upstream component descriptions and their XML form; unchanged.                                                                                          |
| `src/ibus/ibusenginedesc.c`                 | Upstream engine descriptions and their XML form; unchanged.                                                                                             |
| `src/ibus/ibusenumtypes.c.template`         | Upstream enum implementation template; unchanged.                                                                                                       |
| `src/ibus/ibusenumtypes.h.template`         | Upstream enum declaration template; unchanged.                                                                                                          |
| `src/ibus/ibuserror.c`                      | Upstream attribute error domain; D-Bus registration replaced with a local quark.                                                                        |
| `src/ibus/ibusinternal.h`                   | Upstream private string-helper declaration and constants; unchanged.                                                                                    |
| `src/ibus/ibuskeys.c`                       | Upstream key names, case conversion and key-event strings; unchanged.                                                                                   |
| `src/ibus/ibuskeyuni.c`                     | Upstream keysym/Unicode conversion; unchanged.                                                                                                          |
| `src/ibus/ibuslookuptable.c`                | Upstream candidate and label tables; exact virtual method signatures.                                                                                   |
| `src/ibus/ibusmarshalers.list`              | Upstream signal signatures; unchanged.                                                                                                                  |
| `src/ibus/ibusobject.c`                     | Upstream base object and floating ownership; exact GObject disposal and finalization signatures.                                                        |
| `src/ibus/ibusobservedpath.c`               | Upstream observed paths of component descriptions; unchanged.                                                                                           |
| `src/ibus/ibusproperty.c`                   | Upstream properties; exact GObject and serialization callback signatures.                                                                               |
| `src/ibus/ibusproplist.c`                   | Upstream property lists; exact virtual method signatures.                                                                                               |
| `src/ibus/ibusserializable.c`               | Upstream serialization and attachments; exact GType, destroy, data-foreach and variant cleanup callback signatures.                                     |
| `src/ibus/ibustext.c`                       | Upstream text serialization; exact base-class virtual method signatures.                                                                                |
| `src/ibus/ibusutil.c`                       | Upstream property string deserialization helper only; unused language-resource helpers deleted.                                                         |
| `src/ibus/ibusversion.h.in`                 | Upstream version template; unchanged.                                                                                                                   |
| `src/ibus/ibusxml.c`                        | Upstream XML node parsing and output; unchanged.                                                                                                        |
| `src/ibus/keynamesprivate.h`                | Upstream generated key-name lookup table; unchanged.                                                                                                    |
| `src/ibus/meson.build`                      | Ours: enum and marshaller generation and static library.                                                                                                |
| `src/ibus/org.freedesktop.ibus.gschema.xml` | Upstream schemas needed by engines; unchanged.                                                                                                          |
| `include/ibus-1.0/ibus-visibility.h`        | Upstream version/deprecation annotations; unchanged.                                                                                                    |
| `include/ibus-1.0/ibus.h`                   | Ours: umbrella for the provided data and engine types; no bus API.                                                                                      |
| `include/ibus-1.0/ibusattribute.h`          | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusattrlist.h`           | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusbus.h`                | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibuscomponent.h`          | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusconfig.h`             | Upstream declarations required by ibusbus.h, with no implementation exported; unchanged.                                                                |
| `include/ibus-1.0/ibusdebug.h`              | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusengine.h`             | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusenginedesc.h`         | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusenginesimple.h`       | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibuserror.h`              | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusfactory.h`            | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusinputcontext.h`       | Upstream declarations required by ibusbus.h, with no implementation exported; unchanged.                                                                |
| `include/ibus-1.0/ibuskeymap.h`             | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibuskeys.h`               | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibuskeysyms-compat.h`     | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibuskeysyms.h`            | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibuslookuptable.h`        | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusmessage.h`            | Upstream message declarations required by ibusengine.h, with no implementation exported; unchanged.                                                     |
| `include/ibus-1.0/ibusobject.h`             | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusobservedpath.h`       | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusproperty.h`           | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusproplist.h`           | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusproxy.h`              | Upstream declarations required by ibusconfig.h and ibusinputcontext.h, with no implementation exported; unchanged.                                      |
| `include/ibus-1.0/ibusserializable.h`       | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusservice.h`            | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusshare.h`              | Upstream key-event declarations and constants; unchanged.                                                                                               |
| `include/ibus-1.0/ibustext.h`               | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibustypes.h`              | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusxevent.h`             | Upstream declarations required by ibusbus.h, with no implementation exported; unchanged.                                                                |
| `include/ibus-1.0/ibusxml.h`                | Upstream public type layout and declarations; unchanged.                                                                                                |
| `include/ibus-1.0/ibusversion.h`            | Generated from the upstream template with release 1.5.34.                                                                                               |
| `src/ibus/ibusweb-private.h`                | Ours: hidden engine and factory entry points for protocol dispatch.                                                                                     |
| `src/ibus/ibusservice.c`                    | Ours: GObject service properties and ownership without D-Bus.                                                                                           |
| `src/ibus/ibusengine.c`                     | Ours, using upstream signal declarations and emitter logic: replace D-Bus output with protocol records; retain surrounding text and fast-page behavior. |
| `src/ibus/ibusenginesimple.c`               | Ours: pass-through simple engine; Compose and emoji remain with the browser and OS.                                                                     |
| `src/ibus/ibusfactory.c`                    | Ours, using upstream signal semantics: one runtime registry, per-context engine creation, and a handler's reason for failing it.                        |
| `src/ibus/ibuskeymap.c`                     | Ours: router keyvals pass through without engine-side remapping.                                                                                        |
