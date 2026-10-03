/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include "output.h"
#include "ibus-web/protocol.h"
#include "ibus-web/runtime.h"
#include <string.h>

static GMutex output_lock;
static GByteArray *output;
static uint32_t last_seq;

typedef struct {
  uint32_t ic;
  uint16_t kind;
  GBytes *payload;
} PendingRecord;

static gboolean append_record(gpointer data) {
  PendingRecord *record = data;
  gsize len;
  const guint8 *payload = g_bytes_get_data(record->payload, &len);
  uint32_t size = (sizeof(IBusWebRecordHeader) + len + 7) & ~7u;
  g_mutex_lock(&output_lock);
  if (output == NULL)
    output = g_byte_array_new();
  if (size > G_MAXUINT - output->len) {
    g_mutex_unlock(&output_lock);
    g_bytes_unref(record->payload);
    g_free(record);
    g_critical("Output buffer exceeds its addressable size");
    return G_SOURCE_REMOVE;
  }
  IBusWebRecordHeader header = {
      .seq = GUINT32_TO_LE(++last_seq),
      .ic = GUINT32_TO_LE(record->ic),
      .kind = GUINT16_TO_LE(record->kind),
      .flags = 0,
      .len = GUINT32_TO_LE(len),
  };
  static const guint8 padding[7] = {0};
  g_byte_array_append(output, (const guint8 *)&header, sizeof header);
  g_byte_array_append(output, payload, len);
  g_byte_array_append(output, padding, size - sizeof header - len);
  g_mutex_unlock(&output_lock);
  g_bytes_unref(record->payload);
  g_free(record);
  return G_SOURCE_REMOVE;
}

void ibusweb_output_append(uint32_t ic, uint16_t kind, GVariant *payload) {
  g_return_if_fail(payload != NULL);
  g_variant_ref_sink(payload);
  GVariant *normal = g_variant_get_normal_form(payload);
  g_variant_unref(payload);
  if (g_variant_get_size(normal) >
      G_MAXUINT - sizeof(IBusWebRecordHeader) - 7) {
    g_variant_unref(normal);
    g_critical("Output record exceeds its addressable size");
    return;
  }
  PendingRecord *record = g_new(PendingRecord, 1);
  record->ic = ic;
  record->kind = kind;
  record->payload = g_variant_get_data_as_bytes(normal);
  g_variant_unref(normal);
  g_main_context_invoke(NULL, append_record, record);
}

const uint8_t *ibusweb_output_peek(uint32_t *len) {
  if (len != NULL)
    *len = 0;
  if (!g_main_context_is_owner(g_main_context_default())) {
    g_critical("Output peek must run on the pumping thread");
    return NULL;
  }
  g_mutex_lock(&output_lock);
  uint32_t size = output == NULL ? 0 : output->len;
  if (len != NULL)
    *len = size;
  const uint8_t *data = size == 0 ? NULL : output->data;
  g_mutex_unlock(&output_lock);
  return data;
}

void ibusweb_output_consume(uint32_t len) {
  if (!g_main_context_is_owner(g_main_context_default())) {
    g_critical("Output consume must run on the pumping thread");
    return;
  }
  g_mutex_lock(&output_lock);
  uint32_t available = output == NULL ? 0 : output->len;
  uint32_t offset = 0;
  if (len <= available) {
    while (offset < len) {
      IBusWebRecordHeader header;
      memcpy(&header, output->data + offset, sizeof header);
      offset += (sizeof header + GUINT32_FROM_LE(header.len) + 7) & ~7u;
    }
  }
  if (len > available || offset != len) {
    g_mutex_unlock(&output_lock);
    g_critical("Output consume must end on a record boundary");
    return;
  }
  if (len != 0)
    g_byte_array_remove_range(output, 0, len);
  g_mutex_unlock(&output_lock);
}

uint32_t ibusweb_output_last_seq(void) {
  g_mutex_lock(&output_lock);
  uint32_t seq = last_seq;
  g_mutex_unlock(&output_lock);
  return seq;
}
