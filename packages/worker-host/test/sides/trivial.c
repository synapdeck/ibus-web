/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include "spike.h"

/* add(a, b): a + b, wrapping. */
static void add(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t a, b;
  if (!spike_arg(payload, len, 0, &a) || !spike_arg(payload, len, 1, &b))
    return;
  spike_reply(reply, (int32_t)((uint32_t)a + (uint32_t)b));
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, SPIKE_OP_ADD, "add", add);
}
