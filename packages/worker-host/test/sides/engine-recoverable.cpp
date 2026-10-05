/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */
#include <ibus-web/runtime.h>
#include <ibus.h>
#include <stdexcept>
#ifndef ECHO_SCHEMAS
#define ECHO_SCHEMAS ""
#endif
struct RecoverableEngine {
  IBusEngine parent;
};
struct RecoverableEngineClass {
  IBusEngineClass parent;
};
G_DEFINE_TYPE(RecoverableEngine, recoverable_engine, IBUS_TYPE_ENGINE)
static gboolean process_key(IBusEngine *engine, guint keyval, guint,
                            guint state) {
  if (state & IBUS_RELEASE_MASK)
    return FALSE;
  if (keyval == '!')
    throw std::runtime_error("recoverable key failed");
  if (keyval < 32 || keyval > 126)
    return FALSE;
  char text[] = {static_cast<char>(keyval), '\0'};
  ibus_engine_commit_text(engine, ibus_text_new_from_string(text));
  return TRUE;
}
static void recoverable_engine_class_init(RecoverableEngineClass *klass) {
  IBUS_ENGINE_CLASS(klass)->process_key_event = process_key;
}
static void recoverable_engine_init(RecoverableEngine *) {}
extern "C" void ibusweb_module_init(IBusWebModule *) {
  g_debug("recoverable schemas: %s", ECHO_SCHEMAS);
  IBusFactory *factory = ibus_factory_new(nullptr);
  ibus_factory_add_engine(factory, "recoverable",
                          recoverable_engine_get_type());
  g_object_unref(factory);
}
