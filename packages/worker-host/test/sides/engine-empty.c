/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */
#include <ibus-web/runtime.h>
#include <ibus.h>
#ifndef ECHO_SCHEMAS
#define ECHO_SCHEMAS ""
#endif
void ibusweb_module_init(IBusWebModule *module) {
  (void)module;
  const char *volatile schemas = ECHO_SCHEMAS;
  (void)schemas;

  /* A minimal engine keeps this fixture valid without adding output behavior.
   */
  IBusFactory *factory = ibus_factory_new(NULL);
  ibus_factory_add_engine(factory, "empty", IBUS_TYPE_ENGINE);
  g_object_unref(factory);
}
