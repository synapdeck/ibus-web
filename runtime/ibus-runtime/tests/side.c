/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include <ibus-web/runtime.h>
#include <stdlib.h>

/* reverse(bytes): the payload back to front. */
static void reverse(const uint8_t *payload, uint32_t len, GString *reply) {
  g_string_append_len(reply, (const char *)payload, len);
  g_strreverse(reply->str);
}

/* exit(): _Exit(3), which Emscripten carries out by throwing a JavaScript
 * exception, ExitStatus, rather than a C++ one. exit() itself is JavaScript
 * that side modules can't count on the runtime to carry. */
static void exit_op(const uint8_t *payload, uint32_t len, GString *reply) {
  (void)payload;
  (void)len;
  (void)reply;
  _Exit(3);
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, 1, "reverse", reverse);
  ibusweb_module_add_op(module, 3, "exit", exit_op);
}
