/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */
#include <ibus-web/runtime.h>
#include <ibus.h>
#include <stdexcept>
#ifndef ECHO_SCHEMAS
#define ECHO_SCHEMAS ""
#endif
struct ThrowEngine {
  IBusEngine parent;
};
struct ThrowEngineClass {
  IBusEngineClass parent;
};
G_DEFINE_TYPE(ThrowEngine, throw_engine, IBUS_TYPE_ENGINE)
static gboolean process_key(IBusEngine *engine, guint, guint, guint) {
  ibus_engine_commit_text(engine, ibus_text_new_from_string("before fault"));
  throw std::runtime_error("thrower key failed");
}
static void throw_engine_class_init(ThrowEngineClass *klass) {
  IBUS_ENGINE_CLASS(klass)->process_key_event = process_key;
}
static void throw_engine_init(ThrowEngine *) {}
extern "C" void ibusweb_module_init(IBusWebModule *) {
  g_debug("thrower schemas: %s", ECHO_SCHEMAS);
  IBusFactory *factory = ibus_factory_new(nullptr);
  ibus_factory_add_engine(factory, "thrower", throw_engine_get_type());
  g_object_unref(factory);
}
