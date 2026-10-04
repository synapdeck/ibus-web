/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */
#include <ibus-web/runtime.h>
#include <ibus.h>
#include <stdio.h>
#ifndef ECHO_DATA
#define ECHO_DATA ""
#endif
#ifndef ECHO_SCHEMAS
#define ECHO_SCHEMAS ""
#endif
typedef struct {
  IBusEngine parent;
} EchoEngine;
typedef struct {
  IBusEngineClass parent;
} EchoEngineClass;
G_DEFINE_TYPE(EchoEngine, echo_engine, IBUS_TYPE_ENGINE)
static gboolean idle_commit(gpointer data) {
  ibus_engine_commit_text(IBUS_ENGINE(data), ibus_text_new_from_string("idle"));
  return G_SOURCE_REMOVE;
}
static gboolean process_key(IBusEngine *engine, guint keyval, guint keycode,
                            guint state) {
  (void)keycode;
  switch (keyval) {
  case 'a':
    return TRUE;
  case 'b': {
    gchar *text = g_strnfill(state, 'b');
    ibus_engine_commit_text(engine, ibus_text_new_from_string(text));
    g_free(text);
    return TRUE;
  }
  case 'c':
    g_idle_add_full(G_PRIORITY_DEFAULT_IDLE, idle_commit, g_object_ref(engine),
                    g_object_unref);
    return TRUE;
  case 'd': {
    FILE *file = fopen(ECHO_DATA, "r");
    if (file == NULL)
      return FALSE;
    gchar line[256];
    if (fgets(line, sizeof line, file) != NULL) {
      g_strchomp(line);
      ibus_engine_commit_text(engine, ibus_text_new_from_string(line));
    }
    fclose(file);
    return TRUE;
  }
  case 's': {
    GSettings *settings = g_settings_new("org.example.echo");
    g_settings_set_string(settings, "value", "written");
    g_object_unref(settings);
    return TRUE;
  }
  default:
    return FALSE;
  }
}
static void finalize(GObject *object) {
  g_message("echo finalized");
  G_OBJECT_CLASS(echo_engine_parent_class)->finalize(object);
}
static void echo_engine_class_init(EchoEngineClass *klass) {
  IBUS_ENGINE_CLASS(klass)->process_key_event = process_key;
  G_OBJECT_CLASS(klass)->finalize = finalize;
}
static void echo_engine_init(EchoEngine *engine) { (void)engine; }
void ibusweb_module_init(IBusWebModule *module) {
  (void)module;
  g_debug("echo schemas: %s", ECHO_SCHEMAS);
  GSettings *settings = g_settings_new("org.example.echo");
  gchar *value = g_settings_get_string(settings, "value");
  g_message("echo init: %s", value);
  g_free(value);
  g_object_unref(settings);
  IBusFactory *factory = ibus_factory_new(NULL);
  ibus_factory_add_engine(factory, "echo", echo_engine_get_type());
  g_object_unref(factory);
}
