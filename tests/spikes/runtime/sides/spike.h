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
 * -ENOENT before any work started and -EAGAIN while it is pending.
 *
 * A list of X(NAME, opcode), which the build also prints for the
 * TypeScript side. */
#define SPIKE_OPS(X)                                                           \
  X(ADD, 1)                                                                    \
  X(IDLE_LATER, 2)                                                             \
  X(IDLE_RESULT, 3)                                                            \
  X(SPAWN, 4)                                                                  \
  X(SPAWN_RESULT, 5)                                                           \
  X(THROW, 6)                                                                  \
  X(FSYNC, 7)                                                                  \
  X(FSYNC_RESULT, 8)                                                           \
  X(SPAWN_DETACHED, 9)                                                         \
  X(SPAWN_DETACHED_RESULT, 10)                                                 \
  X(SPAWN_NESTED, 11)                                                          \
  X(SPAWN_NESTED_RESULT, 12)                                                   \
  X(PROXY_SYNC, 13)                                                            \
  X(PROXY_SYNC_RESULT, 14)                                                     \
  X(TASK, 15)                                                                  \
  X(TASK_RESULT, 16)                                                           \
  X(TIMEOUT, 17)                                                               \
  X(TIMEOUT_RESULT, 18)                                                        \
  X(CRASH_THREAD, 19)                                                          \
  X(WRITE_FILE, 20)                                                            \
  X(READ_FILE, 21)

#define SPIKE_OP_ENUM(name, opcode) SPIKE_OP_##name = opcode,
enum { SPIKE_OPS(SPIKE_OP_ENUM) };
#undef SPIKE_OP_ENUM

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
