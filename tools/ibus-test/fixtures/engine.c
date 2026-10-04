// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "engine.h"

typedef struct {
  IBusEngine parent;
  guint pending_commit;
} ConformanceEngine;

typedef struct {
  IBusEngineClass parent;
} ConformanceEngineClass;

G_DEFINE_TYPE(ConformanceEngine, conformance_engine, IBUS_TYPE_ENGINE)

static gchar *startup_text;
static IBusEngine *retained_engine;

void conformance_engine_initialize(void) {
  GSettings *settings = g_settings_new("org.example.IBusConformance");
  startup_text = g_settings_get_string(settings, "initial-text");
  g_object_unref(settings);
}

static void commit_text(IBusEngine *engine, const gchar *value) {
  IBusText *text = ibus_text_new_from_string(value);
  ibus_serializable_set_attachment(IBUS_SERIALIZABLE(text), "typed",
                                   g_variant_new_uint32(42));
  ibus_engine_commit_text(engine, text);
}

static gboolean commit_delayed(gpointer data) {
  ConformanceEngine *engine = data;
  engine->pending_commit = 0;
  commit_text(IBUS_ENGINE(engine), "delayed 🐈");
  return G_SOURCE_REMOVE;
}

static gboolean process_key(IBusEngine *engine, guint keyval,
                            guint keycode G_GNUC_UNUSED,
                            guint state G_GNUC_UNUSED) {
  ConformanceEngine *fixture = (ConformanceEngine *)engine;
  switch (keyval) {
  case 1:
    commit_text(engine, "한글 🐈");
    break;
  case 2:
    if (fixture->pending_commit)
      g_source_remove(fixture->pending_commit);
    fixture->pending_commit = g_timeout_add(40, commit_delayed, fixture);
    break;
  case 3:
    ibus_engine_update_preedit_text_with_mode(engine,
                                              ibus_text_new_from_string(""), 0,
                                              FALSE, IBUS_ENGINE_PREEDIT_CLEAR);
    commit_text(engine, "ordered");
    break;
  case 4:
    commit_text(engine, startup_text);
    break;
  case 5:
    g_message("conformance diagnostic");
    break;
  case 6:
    g_warning("conformance warning");
    break;
  case 7: {
    GSettings *settings = g_settings_new("org.example.IBusConformance");
    g_settings_set_string(settings, "initial-text", "written by engine");
    g_object_unref(settings);
    break;
  }
  case 8:
    g_set_object(&retained_engine, engine);
    break;
  case 9:
    /* Deliberately emit on a retained object after its context was closed. */
    if (retained_engine) {
      ibus_engine_forward_key_event(retained_engine, 9, 0, 0);
      g_clear_object(&retained_engine);
    }
    break;
  default:
    return FALSE;
  }
  return TRUE;
}

static void set_content_type(IBusEngine *engine, guint purpose, guint hints) {
  ibus_engine_forward_key_event(engine, purpose, hints, 0);
}

static void reset(IBusEngine *engine) { commit_text(engine, "reset output"); }

static void destroy(IBusObject *object) {
  ConformanceEngine *engine = (ConformanceEngine *)object;
  if (engine->pending_commit) {
    g_source_remove(engine->pending_commit);
    engine->pending_commit = 0;
  }
  IBUS_OBJECT_CLASS(conformance_engine_parent_class)->destroy(object);
}

static void conformance_engine_init(ConformanceEngine *engine) {
  engine->pending_commit = 0;
}

static void conformance_engine_class_init(ConformanceEngineClass *klass) {
  IBUS_ENGINE_CLASS(klass)->process_key_event = process_key;
  IBUS_ENGINE_CLASS(klass)->set_content_type = set_content_type;
  IBUS_ENGINE_CLASS(klass)->reset = reset;
  IBUS_OBJECT_CLASS(klass)->destroy = destroy;
}
