/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* A side module with a static library, libhangul, linked into it. */

#include <ibus-web/runtime.h>

/* hangul.h does not bring in a definition of NULL. */
#include <stddef.h>

#include <hangul.h>

/* compose(keys): the preedit string that typing the keys on the two-set
 * (dubeolsik) layout leaves, as UCS-4 code points, LE. */
static void compose(const uint8_t *payload, uint32_t len, GString *reply) {
  HangulInputContext *hic = hangul_ic_new("2");
  if (hic == NULL)
    return;
  for (uint32_t i = 0; i < len; i++)
    hangul_ic_process(hic, payload[i]);
  const ucschar *preedit = hangul_ic_get_preedit_string(hic);
  for (; *preedit != 0; preedit++)
    g_string_append_len(reply, (const char *)preedit, sizeof *preedit);
  hangul_ic_delete(hic);
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, 12, "compose", compose);
}
