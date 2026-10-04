/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
/* Generated from @ibus-web/protocol's schemas by `nix run .#write-files`; edit
 * those, not this file. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#define IBUSWEB_PROTOCOL_VERSION 1

/* Header fields and GVariant payloads are little-endian.
 *
 * A request is 8 bytes of header (kind, flags, ic) followed by its payload, the
 * GVariant normal form of a value of its kind's signature. No payload is empty
 * (the empty tuple () is one zero byte), so a request of the header alone is
 * malformed and ibusweb_dispatch returns -EBADMSG, as it does for a payload
 * that isn't normal form.
 *
 * A record is 16 bytes of header (seq, ic, kind, flags, len) followed by len
 * bytes of payload in GVariant normal form, zero-padded to a multiple of 8
 * bytes.
 *
 * Log and SettingWritten records belong to no input context: their ic is 0.
 *
 * The runtime writes record flags as zero. CONTINUATION (0x0001) is the only
 * flag; only the host sets it, when it fragments a record. */

typedef struct {
  /* Request kind identifying the payload schema. */
  uint16_t kind;
  /* Reserved request flags; must be zero. */
  uint16_t flags;
  /* Input context identifier. */
  uint32_t ic;
} IBusWebRequestHeader;

typedef struct {
  /* Output record sequence number. */
  uint32_t seq;
  /* Input context identifier. */
  uint32_t ic;
  /* Record kind identifying the payload schema. */
  uint16_t kind;
  /* Record flags; only the host sets CONTINUATION when fragmenting. */
  uint16_t flags;
  /* Payload length in bytes, excluding the header and padding. */
  uint32_t len;
} IBusWebRecordHeader;
#define IBUSWEB_RECORD_CONTINUATION 0x0001

enum IBusWebRequestKind {
  /* (ua{sa{sv}}) version, settings
   * Initialize the runtime with the host's protocol version and settings.
   * version: Protocol version supported by the host.
   * settings: Initial GSettings values, indexed by schema id and then key. */
  IBUSWEB_REQ_INIT = 1,
  /* (s) name
   * Create an engine for the input context.
   * name: IBus engine name to instantiate for the input context. */
  IBUSWEB_REQ_CREATE_ENGINE = 2,
  /* ()
   * Destroy the input context's engine. */
  IBUSWEB_REQ_DESTROY_ENGINE = 3,
  /* (ssv) schemaId, key, value
   * Notify the runtime that a host setting changed.
   * schemaId: GSettings schema id containing the changed key.
   * key: GSettings key that changed.
   * value: New typed GSettings value. */
  IBUSWEB_REQ_SETTING_CHANGED = 4,
  /* (uuu) keyval, keycode, state → reply 0 or 1
   * Process a key event and reply whether the engine handled it.
   * keyval: Key symbol value.
   * keycode: Hardware key code.
   * state: Modifier and event state mask. */
  IBUSWEB_REQ_PROCESS_KEY_EVENT = 16,
  /* ()
   * Give the input context keyboard focus. */
  IBUSWEB_REQ_FOCUS_IN = 17,
  /* ()
   * Remove keyboard focus from the input context. */
  IBUSWEB_REQ_FOCUS_OUT = 18,
  /* ()
   * Reset the engine's composition state. */
  IBUSWEB_REQ_RESET = 19,
  /* ()
   * Enable the input context's engine. */
  IBUSWEB_REQ_ENABLE = 20,
  /* ()
   * Disable the input context's engine. */
  IBUSWEB_REQ_DISABLE = 21,
  /* (iiii) x, y, width, height
   * Update the cursor rectangle used to position input method UI.
   * x: Horizontal position of the cursor rectangle in screen coordinates.
   * y: Vertical position of the cursor rectangle in screen coordinates.
   * width: Width of the cursor rectangle.
   * height: Height of the cursor rectangle. */
  IBUSWEB_REQ_SET_CURSOR_LOCATION = 22,
  /* (u) capabilities
   * Tell the engine which input method features the client supports.
   * capabilities: IBusCapabilite flags describing the client's supported
   *   features. */
  IBUSWEB_REQ_SET_CAPABILITIES = 23,
  /* ()
   * Move to the previous candidate page. */
  IBUSWEB_REQ_PAGE_UP = 24,
  /* ()
   * Move to the next candidate page. */
  IBUSWEB_REQ_PAGE_DOWN = 25,
  /* ()
   * Move the candidate cursor up. */
  IBUSWEB_REQ_CURSOR_UP = 26,
  /* ()
   * Move the candidate cursor down. */
  IBUSWEB_REQ_CURSOR_DOWN = 27,
  /* (uuu) index, button, state
   * Notify the engine that the user clicked a candidate.
   * index: Page-relative position of the clicked candidate on the visible
   *   lookup table page.
   * button: Mouse button used to select the candidate.
   * state: Modifier state at the time of the click. */
  IBUSWEB_REQ_CANDIDATE_CLICKED = 28,
  /* (su) name, state
   * Activate an input method property.
   * name: Key of the IBus property to activate.
   * state: IBusPropState requested for the property. */
  IBUSWEB_REQ_PROPERTY_ACTIVATE = 29,
  /* (vuu) text, cursor, anchor
   * Update the surrounding text and selection known to the engine.
   * text: Client text surrounding the insertion point.
   * cursor: Insertion point in characters within the surrounding text.
   * anchor: Selection anchor in characters within the surrounding text. */
  IBUSWEB_REQ_SET_SURROUNDING_TEXT = 30,
  /* (uu) purpose, hints
   * Describe the focused input field's purpose and input hints.
   * purpose: IBusInputPurpose of the focused input field.
   * hints: IBusInputHints flags for the focused input field. */
  IBUSWEB_REQ_SET_CONTENT_TYPE = 31,
};

enum IBusWebRecordKind {
  /* (v) text
   * Commit the engine's text to the client.
   * text: Text to insert into the client at the current selection. */
  IBUSWEB_REC_COMMIT_TEXT = 1,
  /* (vubu) text, cursor, visible, mode
   * Update the client's preedit text, cursor and visibility.
   * text: Current uncommitted composition text and its attributes.
   * cursor: Cursor position in characters within the preedit text.
   * visible: Whether to display the preedit text.
   * mode: IBusPreeditFocusMode: what the client does with the preedit on focus
   *   out and reset. */
  IBUSWEB_REC_UPDATE_PREEDIT_TEXT = 2,
  /* (vb) text, visible
   * Update the auxiliary text shown with the input method UI.
   * text: Auxiliary text supplied by the engine.
   * visible: Whether to display the auxiliary text. */
  IBUSWEB_REC_UPDATE_AUXILIARY_TEXT = 3,
  /* (vb) table, visible
   * Update the candidate lookup table.
   * table: Candidate list, labels, paging and cursor state.
   * visible: Whether to display the candidate lookup table. */
  IBUSWEB_REC_UPDATE_LOOKUP_TABLE = 4,
  /* ()
   * Show the existing preedit text. */
  IBUSWEB_REC_SHOW_PREEDIT_TEXT = 5,
  /* ()
   * Hide the preedit text. */
  IBUSWEB_REC_HIDE_PREEDIT_TEXT = 6,
  /* ()
   * Show the existing auxiliary text. */
  IBUSWEB_REC_SHOW_AUXILIARY_TEXT = 7,
  /* ()
   * Hide the auxiliary text. */
  IBUSWEB_REC_HIDE_AUXILIARY_TEXT = 8,
  /* ()
   * Show the existing candidate lookup table. */
  IBUSWEB_REC_SHOW_LOOKUP_TABLE = 9,
  /* ()
   * Hide the candidate lookup table. */
  IBUSWEB_REC_HIDE_LOOKUP_TABLE = 10,
  /* (v) properties
   * Register the engine's available properties with the client.
   * properties: Complete list of input method properties to display. */
  IBUSWEB_REC_REGISTER_PROPERTIES = 11,
  /* (v) property
   * Update one registered input method property.
   * property: Replacement state for the property identified by its key. */
  IBUSWEB_REC_UPDATE_PROPERTY = 12,
  /* (uuu) keyval, keycode, state
   * Forward a key event to the client for normal handling.
   * keyval: Key symbol value.
   * keycode: Hardware key code.
   * state: Modifier and event state mask. */
  IBUSWEB_REC_FORWARD_KEY_EVENT = 13,
  /* (iu) offset, count
   * Delete a range of the client's surrounding text.
   * offset: Signed character offset from the cursor to the start of the
   *   deletion.
   * count: Number of surrounding characters to delete. */
  IBUSWEB_REC_DELETE_SURROUNDING_TEXT = 14,
  /* ()
   * Ask the client to supply its current surrounding text. */
  IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT = 15,
  /* (ssv) schemaId, key, value
   * Notify the host of a setting written by the engine.
   * schemaId: GSettings schema id containing the written key.
   * key: GSettings key written by the engine.
   * value: Typed value the host should persist. */
  IBUSWEB_REC_SETTING_WRITTEN = 32,
  /* (uss) level, domain, message
   * Deliver a runtime log entry to the host.
   * level: GLogLevelFlags for this log entry.
   * domain: GLib log domain that emitted the entry.
   * message: Log message text. */
  IBUSWEB_REC_LOG = 33,
  /* (us) reason, message
   * Host crash report; the shared control state is authoritative. Written by
   *   the host only. */
  IBUSWEB_REC_CRASHED = 34,
};

static inline const char *ibusweb_request_signature(uint16_t kind) {
  static const struct {
    uint16_t kind;
    const char *signature;
  } signatures[] = {
      {IBUSWEB_REQ_INIT, "(ua{sa{sv}})"},
      {IBUSWEB_REQ_CREATE_ENGINE, "(s)"},
      {IBUSWEB_REQ_DESTROY_ENGINE, "()"},
      {IBUSWEB_REQ_SETTING_CHANGED, "(ssv)"},
      {IBUSWEB_REQ_PROCESS_KEY_EVENT, "(uuu)"},
      {IBUSWEB_REQ_FOCUS_IN, "()"},
      {IBUSWEB_REQ_FOCUS_OUT, "()"},
      {IBUSWEB_REQ_RESET, "()"},
      {IBUSWEB_REQ_ENABLE, "()"},
      {IBUSWEB_REQ_DISABLE, "()"},
      {IBUSWEB_REQ_SET_CURSOR_LOCATION, "(iiii)"},
      {IBUSWEB_REQ_SET_CAPABILITIES, "(u)"},
      {IBUSWEB_REQ_PAGE_UP, "()"},
      {IBUSWEB_REQ_PAGE_DOWN, "()"},
      {IBUSWEB_REQ_CURSOR_UP, "()"},
      {IBUSWEB_REQ_CURSOR_DOWN, "()"},
      {IBUSWEB_REQ_CANDIDATE_CLICKED, "(uuu)"},
      {IBUSWEB_REQ_PROPERTY_ACTIVATE, "(su)"},
      {IBUSWEB_REQ_SET_SURROUNDING_TEXT, "(vuu)"},
      {IBUSWEB_REQ_SET_CONTENT_TYPE, "(uu)"},
  };
  for (size_t i = 0; i < sizeof signatures / sizeof signatures[0]; i++)
    if (signatures[i].kind == kind)
      return signatures[i].signature;
  return NULL;
}

static inline const char *ibusweb_record_signature(uint16_t kind) {
  static const struct {
    uint16_t kind;
    const char *signature;
  } signatures[] = {
      {IBUSWEB_REC_COMMIT_TEXT, "(v)"},
      {IBUSWEB_REC_UPDATE_PREEDIT_TEXT, "(vubu)"},
      {IBUSWEB_REC_UPDATE_AUXILIARY_TEXT, "(vb)"},
      {IBUSWEB_REC_UPDATE_LOOKUP_TABLE, "(vb)"},
      {IBUSWEB_REC_SHOW_PREEDIT_TEXT, "()"},
      {IBUSWEB_REC_HIDE_PREEDIT_TEXT, "()"},
      {IBUSWEB_REC_SHOW_AUXILIARY_TEXT, "()"},
      {IBUSWEB_REC_HIDE_AUXILIARY_TEXT, "()"},
      {IBUSWEB_REC_SHOW_LOOKUP_TABLE, "()"},
      {IBUSWEB_REC_HIDE_LOOKUP_TABLE, "()"},
      {IBUSWEB_REC_REGISTER_PROPERTIES, "(v)"},
      {IBUSWEB_REC_UPDATE_PROPERTY, "(v)"},
      {IBUSWEB_REC_FORWARD_KEY_EVENT, "(uuu)"},
      {IBUSWEB_REC_DELETE_SURROUNDING_TEXT, "(iu)"},
      {IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT, "()"},
      {IBUSWEB_REC_SETTING_WRITTEN, "(ssv)"},
      {IBUSWEB_REC_LOG, "(uss)"},
      {IBUSWEB_REC_CRASHED, "(us)"},
  };
  for (size_t i = 0; i < sizeof signatures / sizeof signatures[0]; i++)
    if (signatures[i].kind == kind)
      return signatures[i].signature;
  return NULL;
}
