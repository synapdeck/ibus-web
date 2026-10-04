/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */
#include <ibus-web/runtime.h>
#ifndef ECHO_SCHEMAS
#define ECHO_SCHEMAS ""
#endif
void ibusweb_module_init(IBusWebModule *module) {
  (void)module;
  const char *volatile schemas = ECHO_SCHEMAS;
  (void)schemas;
}
