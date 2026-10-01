/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include <ibus-web/runtime.h>

/* reverse(bytes): the payload back to front. */
static void reverse(const uint8_t *payload, uint32_t len, GString *reply) {
  g_string_append_len(reply, (const char *)payload, len);
  g_strreverse(reply->str);
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, 1, "reverse", reverse);
}
