/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */
#include "test-ops.h"
#include <gio/gio.h>

/* Schema, key and string value, each NUL-terminated, in that order. This
 * exercises the engine-write path independently of a host setting change. */
static void setting_write(const uint8_t *payload, uint32_t len,
                          GString *reply) {
  const gchar *strings[3];
  for (guint i = 0; i < G_N_ELEMENTS(strings); i++) {
    const uint8_t *end = memchr(payload, 0, len);
    if (end == NULL)
      return;
    strings[i] = (const gchar *)payload;
    guint used = end - payload + 1;
    payload += used;
    len -= used;
  }
  if (len != 0)
    return;
  g_autoptr(GSettings) settings = g_settings_new(strings[0]);
  test_reply(reply, g_settings_set_string(settings, strings[1], strings[2]));
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, TEST_OP_SETTING_WRITE, "setting-write",
                        setting_write);
}
