/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#pragma once

#include <ibus-web/runtime.h>
#include <string.h>

/* Opcodes of the spike side modules' operations, unique across all of them
 * since a host loads them together. Payloads and replies are little-endian
 * int32 values unless an operation says otherwise; a payload an operation
 * can't read gets an empty reply. Operations that start work reply 0 or
 * -EBUSY while earlier work is still running. Result operations reply
 * -ENOENT before any work started and -EAGAIN while it is pending. */
enum {
  SPIKE_OP_ADD = 1,
  SPIKE_OP_IDLE_LATER = 2,
  SPIKE_OP_IDLE_RESULT = 3,
  SPIKE_OP_SPAWN = 4,
  SPIKE_OP_SPAWN_RESULT = 5,
  SPIKE_OP_THROW = 6,
  SPIKE_OP_FSYNC = 7,
  SPIKE_OP_FSYNC_RESULT = 8,
};

/* Reads the index-th int32 of a payload; FALSE if it is too short. */
static inline gboolean spike_arg(const uint8_t *payload, uint32_t len,
                                 uint32_t index, int32_t *value) {
  uint32_t le;
  if (len / sizeof le <= index)
    return FALSE;
  memcpy(&le, payload + index * sizeof le, sizeof le);
  *value = (int32_t)GUINT32_FROM_LE(le);
  return TRUE;
}

static inline void spike_reply(GString *reply, int32_t value) {
  uint32_t le = GUINT32_TO_LE((uint32_t)value);
  g_string_append_len(reply, (const char *)&le, sizeof le);
}
