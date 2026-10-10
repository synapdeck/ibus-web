/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif
#include "engine.h"
#include "m17nutil.h"
#include "variables.h"
#include <ibus-web/runtime.h>

/* Keeps the compiled schemas, which the module's settings metadata lists, in
 * the side module's data closure. */
const char ibusweb_m17n_settings_schema_dir[] = IBUSWEB_SETTINGS_SCHEMA_DIR;

/* The variables are in place before ibus_m17n_get_component lists the input
 * methods, and so before any engine opens one. The factory has no bus
 * connection and the runtime's registry keeps it, so the module drops its own
 * reference once the engines are added. */
void ibusweb_module_init(IBusWebModule *module G_GNUC_UNUSED) {
  ibus_m17n_init_common();
  ibusweb_m17n_variables_init();

  IBusComponent *component = g_object_ref_sink(ibus_m17n_get_component());
  IBusFactory *factory = g_object_ref_sink(ibus_factory_new(NULL));
  GList *engines = ibus_component_get_engines(component);
  for (GList *p = engines; p != NULL; p = p->next) {
    const gchar *name = ibus_engine_desc_get_name(p->data);
    GType type = ibus_m17n_engine_get_type_for_name(name);
    if (type == G_TYPE_INVALID) {
      continue;
    }

    ibus_factory_add_engine(factory, name, type);
  }

  g_list_free(engines);
  g_object_unref(factory);
  g_object_unref(component);
}
