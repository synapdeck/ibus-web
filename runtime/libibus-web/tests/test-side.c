/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#include <ibus-web/runtime.h>

static void twice(const uint8_t *payload, uint32_t len, GString *reply) {
  g_string_append_len(reply, (const char *)payload, len);
  g_string_append_len(reply, (const char *)payload, len);
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, 3, "twice", twice);
}
