// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "engine.h"
#include <ibus-web/runtime.h>

void ibusweb_module_init(IBusWebModule *module G_GNUC_UNUSED) {
  conformance_engine_initialize();
  IBusFactory *factory = g_object_ref_sink(ibus_factory_new(NULL));
  ibus_factory_add_engine(factory, "conformance",
                          conformance_engine_get_type());
  g_object_unref(factory);
}
