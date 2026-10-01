/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* assert() must expand to its check, whatever the build defines. */
#undef NDEBUG

#include <assert.h>
#include <emscripten/em_asm.h>
#include <emscripten/emscripten.h>
#include <ibus-web/runtime.h>
#include <stdlib.h>
#include <string.h>

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

/* javascript(int32 n): n doubled in JavaScript, by EM_ASM, then
 * emscripten_get_now(), which must be positive: int32 and double, both LE.
 * All three, assert()'s __assert_fail among them, are JavaScript the runtime
 * provides. */
static void javascript(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t n;
  if (len != sizeof n)
    return;
  memcpy(&n, payload, sizeof n);
  int32_t doubled = EM_ASM_INT({ return $0 * 2; }, n);
  double now = emscripten_get_now();
  assert(now > 0);
  g_string_append_len(reply, (const char *)&doubled, sizeof doubled);
  g_string_append_len(reply, (const char *)&now, sizeof now);
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, 1, "reverse", reverse);
  ibusweb_module_add_op(module, 3, "exit", exit_op);
  ibusweb_module_add_op(module, 4, "javascript", javascript);
}
