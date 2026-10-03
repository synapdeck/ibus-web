/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "engine.h"
#include <ibus-web/runtime.h>

void ibusweb_module_init(IBusWebModule *module G_GNUC_UNUSED) {
  ibus_hangul_init(NULL);
  IBusFactory *factory = g_object_ref_sink(ibus_factory_new(NULL));
  ibus_factory_add_engine(factory, "hangul", IBUS_TYPE_HANGUL_ENGINE);
  g_object_unref(factory);
}
