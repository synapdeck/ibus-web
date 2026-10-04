/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#pragma once
#include <stddef.h>
#include <stdint.h>

#define IBUSWEB_PROTOCOL_VERSION 1

/* A request: 8 bytes of header (kind, flags, ic), then the payload, the
 * GVariant normal form of the kind's signature, little-endian. No flags are
 * defined; they must be zero. The empty tuple () is one zero byte in normal
 * form, so every request carries at least one byte of payload: a request of
 * the header alone is malformed (-EBADMSG). */
typedef struct {
  uint16_t kind;
  uint16_t flags;
  uint32_t ic;
} IBusWebRequestHeader;

/* An output record: 16 bytes of header (seq, ic, kind, flags, len), then len
 * bytes of payload (GVariant normal form), padded with zeros to a multiple of
 * 8. The runtime writes flags as zero; IBUSWEB_RECORD_CONTINUATION is the
 * only flag, and only the host sets it. */
typedef struct {
  uint32_t seq;
  uint32_t ic;
  uint16_t kind;
  uint16_t flags;
  uint32_t len;
} IBusWebRecordHeader;
#define IBUSWEB_RECORD_CONTINUATION                                            \
  0x0001 /* set by the host when it fragments; never by the runtime */

enum IBusWebRequestKind {
  IBUSWEB_REQ_INIT =
      1, /* (ua{sa{sv}})  protocol version; schema id → key → value */
  IBUSWEB_REQ_CREATE_ENGINE = 2,      /* (s)  engine name */
  IBUSWEB_REQ_DESTROY_ENGINE = 3,     /* () */
  IBUSWEB_REQ_SETTING_CHANGED = 4,    /* (ssv)  schema id, key, value */
  IBUSWEB_REQ_PROCESS_KEY_EVENT = 16, /* (uuu) → reply 0 or 1 */
  IBUSWEB_REQ_FOCUS_IN = 17,
  IBUSWEB_REQ_FOCUS_OUT = 18,
  IBUSWEB_REQ_RESET = 19,
  IBUSWEB_REQ_ENABLE = 20,
  IBUSWEB_REQ_DISABLE = 21,             /* () */
  IBUSWEB_REQ_SET_CURSOR_LOCATION = 22, /* (iiii) */
  IBUSWEB_REQ_SET_CAPABILITIES = 23,    /* (u) */
  IBUSWEB_REQ_PAGE_UP = 24,
  IBUSWEB_REQ_PAGE_DOWN = 25,
  IBUSWEB_REQ_CURSOR_UP = 26,
  IBUSWEB_REQ_CURSOR_DOWN = 27,          /* () */
  IBUSWEB_REQ_CANDIDATE_CLICKED = 28,    /* (uuu) index, button, state */
  IBUSWEB_REQ_PROPERTY_ACTIVATE = 29,    /* (su) */
  IBUSWEB_REQ_SET_SURROUNDING_TEXT = 30, /* (vuu) IBusText, cursor, anchor */
  IBUSWEB_REQ_SET_CONTENT_TYPE = 31,     /* (uu) purpose, hints */
};

enum IBusWebRecordKind {
  IBUSWEB_REC_COMMIT_TEXT = 1,         /* (v) */
  IBUSWEB_REC_UPDATE_PREEDIT_TEXT = 2, /* (vubu) text, cursor, visible, mode */
  IBUSWEB_REC_UPDATE_AUXILIARY_TEXT = 3, /* (vb) */
  IBUSWEB_REC_UPDATE_LOOKUP_TABLE = 4,   /* (vb) */
  IBUSWEB_REC_SHOW_PREEDIT_TEXT = 5,
  IBUSWEB_REC_HIDE_PREEDIT_TEXT = 6,
  IBUSWEB_REC_SHOW_AUXILIARY_TEXT = 7,
  IBUSWEB_REC_HIDE_AUXILIARY_TEXT = 8,
  IBUSWEB_REC_SHOW_LOOKUP_TABLE = 9,
  IBUSWEB_REC_HIDE_LOOKUP_TABLE = 10,        /* () */
  IBUSWEB_REC_REGISTER_PROPERTIES = 11,      /* (v) */
  IBUSWEB_REC_UPDATE_PROPERTY = 12,          /* (v) */
  IBUSWEB_REC_FORWARD_KEY_EVENT = 13,        /* (uuu) */
  IBUSWEB_REC_DELETE_SURROUNDING_TEXT = 14,  /* (iu) */
  IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT = 15, /* () */
  IBUSWEB_REC_SETTING_WRITTEN = 32,          /* (ssv) */
  IBUSWEB_REC_LOG = 33,     /* (uss) GLogLevelFlags, domain, message */
  IBUSWEB_REC_CRASHED = 34, /* written by the host only */
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
  };
  for (size_t i = 0; i < sizeof signatures / sizeof signatures[0]; i++)
    if (signatures[i].kind == kind)
      return signatures[i].signature;
  return NULL;
}
