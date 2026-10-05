<!-- SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
SPDX-License-Identifier: MIT OR Apache-2.0 -->

<!-- Generated from @ibus-web/protocol's schemas by `nix run .#write-files`; edit those, not this file. -->

# ibus-web protocol

Protocol version: **1**.

Header fields and GVariant payloads are little-endian.

A request is 8 bytes of header (`kind`, `flags`, `ic`) followed by its payload, the GVariant normal form of a value of its kind's signature. No payload is empty (the empty tuple `()` is one zero byte), so a request of the header alone is malformed and `ibusweb_dispatch` returns -EBADMSG, as it does for a payload that isn't normal form.

A record is 16 bytes of header (`seq`, `ic`, `kind`, `flags`, `len`) followed by `len` bytes of payload in GVariant normal form, zero-padded to a multiple of 8 bytes.

`Log` and `SettingWritten` records belong to no input context: their `ic` is 0.

The runtime writes record flags as zero. `CONTINUATION` (`0x0001`) is the only flag; only the host sets it, when it fragments a record.

## Transport

Shared memory contains a 64-byte control header, a 65536-byte request slot and a 262144-byte ring by default. Slot and ring sizes are multiples of 8; the ring is a power of two of at least 64 bytes.

| Index | Word          | Written by | Meaning                                                                  |
| ----- | ------------- | ---------- | ------------------------------------------------------------------------ |
| 0     | `state`       | both       | IDLE 0, REQUEST 1, REPLY 2, CRASHED 3.                                   |
| 1     | `reqSeq`      | page       | Request sequence for diagnostics; ignored by the host.                   |
| 2     | `reqLen`      | page       | Request bytes in the slot.                                               |
| 3     | `replyRet`    | host       | Return value of ibusweb_dispatch.                                        |
| 4     | `replyOutSeq` | host       | Last runtime record produced by dispatch and pump; unchanged if none.    |
| 5     | `ringWrite`   | host       | Bytes written modulo 2³².                                                |
| 6     | `ringRead`    | page       | Bytes consumed modulo 2³².                                               |
| 7     | `ringWaiting` | both       | Host sets 1 before waiting; page clears after freeing space.             |
| 8     | `doorbell`    | both       | 1 while a doorbell is outstanding; page clears before draining.          |
| 9     | `wake`        | page       | Bumped and notified after requests and freeing space for a waiting host. |
| 10    | `reqMode`     | both       | SYNC 0, ASYNC 1, ABANDONED 2.                                            |

Ring counters count bytes modulo 2³²; free space is ringBytes minus the unsigned difference of ringWrite and ringRead. Bytes are published before ringWrite advances. Records have a 16-byte header and zero padding to multiples of 8 and never wrap. A tail shorter than 16 bytes is skipped; otherwise a padding record fills an unusable tail (kind, seq, ic and flags zero; len equals tail bytes minus 16). Kind 0 is reserved in both directions.

When a record exceeds available space, the writer emits the largest fitting fragment with at least 8 payload bytes. All fragments share seq, ic and kind and remain consecutive, apart from padding. CONTINUATION is set on every fragment except the last. The reader concatenates payloads and returns one framed record with flags zero. On full, resume with the same immutable record; needBytes is the minimum free space needed for progress, including a required tail skip. After consuming bytes the reader clears ringWaiting and bumps and notifies wake if a writer was waiting.

Host records use seq and ic zero and do not advance replyOutSeq. Runtime sequences skip zero on wrap. The control state is authoritative for crashes; Crashed is a best-effort host record.

## Request header

| Field   | Width (bytes) | Description                                  |
| ------- | ------------- | -------------------------------------------- |
| `kind`  | 2             | Request kind identifying the payload schema. |
| `flags` | 2             | Reserved request flags; must be zero.        |
| `ic`    | 4             | Input context identifier.                    |

## Record header

| Field   | Width (bytes) | Description                                                     |
| ------- | ------------- | --------------------------------------------------------------- |
| `seq`   | 4             | Output record sequence number.                                  |
| `ic`    | 4             | Input context identifier.                                       |
| `kind`  | 2             | Record kind identifying the payload schema.                     |
| `flags` | 2             | Record flags; only the host sets CONTINUATION when fragmenting. |
| `len`   | 4             | Payload length in bytes, excluding the header and padding.      |

## Requests

### Init

Kind: **1**. Signature: `(ua{sa{sv}})`.

Initialize the runtime with the host's protocol version and settings.

| Name       | GVariant type | Description                                                  |
| ---------- | ------------- | ------------------------------------------------------------ |
| `version`  | `u`           | Protocol version supported by the host.                      |
| `settings` | `a{sa{sv}}`   | Initial GSettings values, indexed by schema id and then key. |

### CreateEngine

Kind: **2**. Signature: `(s)`.

Create an engine for the input context.

| Name   | GVariant type | Description                                            |
| ------ | ------------- | ------------------------------------------------------ |
| `name` | `s`           | IBus engine name to instantiate for the input context. |

### DestroyEngine

Kind: **3**. Signature: `()`.

Destroy the input context's engine.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### SettingChanged

Kind: **4**. Signature: `(ssv)`.

Notify the runtime that a host setting changed.

| Name       | GVariant type | Description                                     |
| ---------- | ------------- | ----------------------------------------------- |
| `schemaId` | `s`           | GSettings schema id containing the changed key. |
| `key`      | `s`           | GSettings key that changed.                     |
| `value`    | `v`           | New typed GSettings value.                      |

### ProcessKeyEvent

Kind: **16**. Signature: `(uuu)`.

Process a key event and reply whether the engine handled it.

Reply: `ibusweb_dispatch` returns 1 if the engine handled the key and 0 if not; the reply is that return value, not a GVariant payload.

| Name      | GVariant type | Description                    |
| --------- | ------------- | ------------------------------ |
| `keyval`  | `u`           | Key symbol value.              |
| `keycode` | `u`           | Hardware key code.             |
| `state`   | `u`           | Modifier and event state mask. |

### FocusIn

Kind: **17**. Signature: `()`.

Give the input context keyboard focus.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### FocusOut

Kind: **18**. Signature: `()`.

Remove keyboard focus from the input context.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### Reset

Kind: **19**. Signature: `()`.

Reset the engine's composition state.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### Enable

Kind: **20**. Signature: `()`.

Enable the input context's engine.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### Disable

Kind: **21**. Signature: `()`.

Disable the input context's engine.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### SetCursorLocation

Kind: **22**. Signature: `(iiii)`.

Update the cursor rectangle used to position input method UI.

| Name     | GVariant type | Description                                                        |
| -------- | ------------- | ------------------------------------------------------------------ |
| `x`      | `i`           | Horizontal position of the cursor rectangle in screen coordinates. |
| `y`      | `i`           | Vertical position of the cursor rectangle in screen coordinates.   |
| `width`  | `i`           | Width of the cursor rectangle.                                     |
| `height` | `i`           | Height of the cursor rectangle.                                    |

### SetCapabilities

Kind: **23**. Signature: `(u)`.

Tell the engine which input method features the client supports.

| Name           | GVariant type | Description                                                      |
| -------------- | ------------- | ---------------------------------------------------------------- |
| `capabilities` | `u`           | IBusCapabilite flags describing the client's supported features. |

### PageUp

Kind: **24**. Signature: `()`.

Move to the previous candidate page.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### PageDown

Kind: **25**. Signature: `()`.

Move to the next candidate page.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### CursorUp

Kind: **26**. Signature: `()`.

Move the candidate cursor up.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### CursorDown

Kind: **27**. Signature: `()`.

Move the candidate cursor down.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### CandidateClicked

Kind: **28**. Signature: `(uuu)`.

Notify the engine that the user clicked a candidate.

| Name     | GVariant type | Description                                                                       |
| -------- | ------------- | --------------------------------------------------------------------------------- |
| `index`  | `u`           | Page-relative position of the clicked candidate on the visible lookup table page. |
| `button` | `u`           | Mouse button used to select the candidate.                                        |
| `state`  | `u`           | Modifier state at the time of the click.                                          |

### PropertyActivate

Kind: **29**. Signature: `(su)`.

Activate an input method property.

| Name    | GVariant type | Description                               |
| ------- | ------------- | ----------------------------------------- |
| `name`  | `s`           | Key of the IBus property to activate.     |
| `state` | `u`           | IBusPropState requested for the property. |

### SetSurroundingText

Kind: **30**. Signature: `(vuu)`.

Update the surrounding text and selection known to the engine.

| Name     | GVariant type               | Description                                                 |
| -------- | --------------------------- | ----------------------------------------------------------- |
| `text`   | `v` ([IBusText](#ibustext)) | Client text surrounding the insertion point.                |
| `cursor` | `u`                         | Insertion point in characters within the surrounding text.  |
| `anchor` | `u`                         | Selection anchor in characters within the surrounding text. |

### SetContentType

Kind: **31**. Signature: `(uu)`.

Describe the focused input field's purpose and input hints.

| Name      | GVariant type | Description                                       |
| --------- | ------------- | ------------------------------------------------- |
| `purpose` | `u`           | IBusInputPurpose of the focused input field.      |
| `hints`   | `u`           | IBusInputHints flags for the focused input field. |

## Records

### CommitText

Kind: **1**. Signature: `(v)`.

Commit the engine's text to the client.

| Name   | GVariant type               | Description                                              |
| ------ | --------------------------- | -------------------------------------------------------- |
| `text` | `v` ([IBusText](#ibustext)) | Text to insert into the client at the current selection. |

### UpdatePreeditText

Kind: **2**. Signature: `(vubu)`.

Update the client's preedit text, cursor and visibility.

| Name      | GVariant type               | Description                                                                         |
| --------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `text`    | `v` ([IBusText](#ibustext)) | Current uncommitted composition text and its attributes.                            |
| `cursor`  | `u`                         | Cursor position in characters within the preedit text.                              |
| `visible` | `b`                         | Whether to display the preedit text.                                                |
| `mode`    | `u`                         | IBusPreeditFocusMode: what the client does with the preedit on focus out and reset. |

### UpdateAuxiliaryText

Kind: **3**. Signature: `(vb)`.

Update the auxiliary text shown with the input method UI.

| Name      | GVariant type               | Description                            |
| --------- | --------------------------- | -------------------------------------- |
| `text`    | `v` ([IBusText](#ibustext)) | Auxiliary text supplied by the engine. |
| `visible` | `b`                         | Whether to display the auxiliary text. |

### UpdateLookupTable

Kind: **4**. Signature: `(vb)`.

Update the candidate lookup table.

| Name      | GVariant type                             | Description                                      |
| --------- | ----------------------------------------- | ------------------------------------------------ |
| `table`   | `v` ([IBusLookupTable](#ibuslookuptable)) | Candidate list, labels, paging and cursor state. |
| `visible` | `b`                                       | Whether to display the candidate lookup table.   |

### ShowPreeditText

Kind: **5**. Signature: `()`.

Show the existing preedit text.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### HidePreeditText

Kind: **6**. Signature: `()`.

Hide the preedit text.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### ShowAuxiliaryText

Kind: **7**. Signature: `()`.

Show the existing auxiliary text.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### HideAuxiliaryText

Kind: **8**. Signature: `()`.

Hide the auxiliary text.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### ShowLookupTable

Kind: **9**. Signature: `()`.

Show the existing candidate lookup table.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### HideLookupTable

Kind: **10**. Signature: `()`.

Hide the candidate lookup table.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### RegisterProperties

Kind: **11**. Signature: `(v)`.

Register the engine's available properties with the client.

| Name         | GVariant type                       | Description                                          |
| ------------ | ----------------------------------- | ---------------------------------------------------- |
| `properties` | `v` ([IBusPropList](#ibusproplist)) | Complete list of input method properties to display. |

### UpdateProperty

Kind: **12**. Signature: `(v)`.

Update one registered input method property.

| Name       | GVariant type                       | Description                                               |
| ---------- | ----------------------------------- | --------------------------------------------------------- |
| `property` | `v` ([IBusProperty](#ibusproperty)) | Replacement state for the property identified by its key. |

### ForwardKeyEvent

Kind: **13**. Signature: `(uuu)`.

Forward a key event to the client for normal handling.

| Name      | GVariant type | Description                    |
| --------- | ------------- | ------------------------------ |
| `keyval`  | `u`           | Key symbol value.              |
| `keycode` | `u`           | Hardware key code.             |
| `state`   | `u`           | Modifier and event state mask. |

### DeleteSurroundingText

Kind: **14**. Signature: `(iu)`.

Delete a range of the client's surrounding text.

| Name     | GVariant type | Description                                                           |
| -------- | ------------- | --------------------------------------------------------------------- |
| `offset` | `i`           | Signed character offset from the cursor to the start of the deletion. |
| `count`  | `u`           | Number of surrounding characters to delete.                           |

### RequireSurroundingText

Kind: **15**. Signature: `()`.

Ask the client to supply its current surrounding text.

| Name | GVariant type | Description |
| ---- | ------------- | ----------- |

### SettingWritten

Kind: **32**. Signature: `(ssv)`.

Notify the host of a setting written by the engine.

| Name       | GVariant type | Description                                     |
| ---------- | ------------- | ----------------------------------------------- |
| `schemaId` | `s`           | GSettings schema id containing the written key. |
| `key`      | `s`           | GSettings key written by the engine.            |
| `value`    | `v`           | Typed value the host should persist.            |

### Log

Kind: **33**. Signature: `(uss)`.

Deliver a runtime log entry to the host.

| Name      | GVariant type | Description                             |
| --------- | ------------- | --------------------------------------- |
| `level`   | `u`           | GLogLevelFlags for this log entry.      |
| `domain`  | `s`           | GLib log domain that emitted the entry. |
| `message` | `s`           | Log message text.                       |

### Crashed

Kind: **34**. Signature: `(us)`.

Host crash report; the shared control state is authoritative. Written by the host only.

| Name      | GVariant type | Description                                                                                                                                                                                                                               |
| --------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reason`  | `u`           | Why the Worker stopped: TRAP 1 (the runtime trapped), FAULT 2 (a request returned -ECANCELED, leaving the runtime unusable), RELAY 3 (the wake relay failed), LOAD 4 (the engine module failed to load), HOST 5 (the host itself failed). |
| `message` | `s`           | Human-readable detail of the failure, for logs.                                                                                                                                                                                           |

## IBus types

Serializable tuples begin with their type name and attachments. Nested serializables occupy GVariant variant (`v`) slots.

### IBusAttribute

Signature: `(sa{sv}uuuu)`.

| Name          | GVariant type | Description                                                             |
| ------------- | ------------- | ----------------------------------------------------------------------- |
| `name`        | `s`           | Serializable type name: `IBusAttribute`.                                |
| `attachments` | `a{sv}`       | Named attachments for IBusAttribute.                                    |
| `type`        | `u`           | Attribute decoration type.                                              |
| `value`       | `u`           | Decoration value, such as underline style or RGB color.                 |
| `startIndex`  | `u`           | First character index covered by the attribute.                         |
| `endIndex`    | `u`           | Exclusive ending character index; 0xffffffff means the end of the text. |

### IBusAttrList

Signature: `(sa{sv}av)`.

| Name          | GVariant type                            | Description                              |
| ------------- | ---------------------------------------- | ---------------------------------------- |
| `name`        | `s`                                      | Serializable type name: `IBusAttrList`.  |
| `attachments` | `a{sv}`                                  | Named attachments for IBusAttrList.      |
| `attributes`  | `av` ([IBusAttribute](#ibusattribute)[]) | Text attributes in their original order. |

### IBusText

Signature: `(sa{sv}sv)`.

| Name          | GVariant type                       | Description                                          |
| ------------- | ----------------------------------- | ---------------------------------------------------- |
| `name`        | `s`                                 | Serializable type name: `IBusText`.                  |
| `attachments` | `a{sv}`                             | Named attachments for IBusText.                      |
| `text`        | `s`                                 | Text content.                                        |
| `attrs`       | `v` ([IBusAttrList](#ibusattrlist)) | Decorations applied to character ranges in the text. |

### IBusLookupTable

Signature: `(sa{sv}uubbiavav)`.

| Name            | GVariant type                  | Description                                              |
| --------------- | ------------------------------ | -------------------------------------------------------- |
| `name`          | `s`                            | Serializable type name: `IBusLookupTable`.               |
| `attachments`   | `a{sv}`                        | Named attachments for IBusLookupTable.                   |
| `pageSize`      | `u`                            | Number of candidates per page.                           |
| `cursorPos`     | `u`                            | Cursor position in the candidate list.                   |
| `cursorVisible` | `b`                            | Whether the candidate cursor is visible.                 |
| `round`         | `b`                            | Whether cursor movement wraps around the candidate list. |
| `orientation`   | `i`                            | Candidate display orientation.                           |
| `candidates`    | `av` ([IBusText](#ibustext)[]) | Candidate texts in display order.                        |
| `labels`        | `av` ([IBusText](#ibustext)[]) | Labels for candidate positions.                          |

### IBusProperty

Signature: `(sa{sv}suvsvbbuvv)`.

| Name          | GVariant type                       | Description                             |
| ------------- | ----------------------------------- | --------------------------------------- |
| `name`        | `s`                                 | Serializable type name: `IBusProperty`. |
| `attachments` | `a{sv}`                             | Named attachments for IBusProperty.     |
| `key`         | `s`                                 | Unique property key.                    |
| `type`        | `u`                                 | Property presentation type.             |
| `label`       | `v` ([IBusText](#ibustext))         | Human-readable property label.          |
| `icon`        | `s`                                 | Icon name or path.                      |
| `tooltip`     | `v` ([IBusText](#ibustext))         | Tooltip describing the property.        |
| `sensitive`   | `b`                                 | Whether the property can be activated.  |
| `visible`     | `b`                                 | Whether the property is visible.        |
| `state`       | `u`                                 | Property checked state.                 |
| `subProps`    | `v` ([IBusPropList](#ibusproplist)) | Nested properties.                      |
| `symbol`      | `v` ([IBusText](#ibustext))         | Short symbolic property label.          |

### IBusPropList

Signature: `(sa{sv}av)`.

| Name          | GVariant type                          | Description                             |
| ------------- | -------------------------------------- | --------------------------------------- |
| `name`        | `s`                                    | Serializable type name: `IBusPropList`. |
| `attachments` | `a{sv}`                                | Named attachments for IBusPropList.     |
| `properties`  | `av` ([IBusProperty](#ibusproperty)[]) | Properties in display order.            |
