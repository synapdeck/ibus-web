/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include "dispatch.h"
#include "output.h"
#include <ibus-web/protocol.h>

static gchar *field_text(const GLogField *fields, gsize count,
                         const gchar *key) {
  for (gsize i = 0; i < count; ++i) {
    if (g_str_equal(fields[i].key, key) && fields[i].value != NULL)
      return g_utf8_make_valid(fields[i].value, fields[i].length);
  }
  return g_strdup("");
}

static GLogWriterOutput write_log(GLogLevelFlags level, const GLogField *fields,
                                  gsize count, gpointer data G_GNUC_UNUSED) {
  g_autofree gchar *domain = field_text(fields, count, "GLIB_DOMAIN");
  gboolean fatal = (level & (G_LOG_FLAG_FATAL | G_LOG_LEVEL_ERROR)) != 0;
  if (!fatal && g_log_writer_default_would_drop(level, domain))
    return G_LOG_WRITER_HANDLED;
  g_autofree gchar *message = field_text(fields, count, "MESSAGE");
  ibusweb_output_append(0, IBUSWEB_REC_LOG,
                        g_variant_new("(uss)", (guint)level, domain, message));
  /* GLib ignores a writer's return value; its default writer owns the fatal
   * flag handling as well as the final stderr diagnostic. */
  if (fatal)
    return g_log_writer_default(level, fields, count, NULL);
  return G_LOG_WRITER_HANDLED;
}

void ibusweb_log_init(void) { g_log_set_writer_func(write_log, NULL, NULL); }
