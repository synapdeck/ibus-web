/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <ibus.h>

#define RIME_SCHEMA "org.freedesktop.ibus.engine.rime"
#define RIME_SCHEMA_SCHEMA RIME_SCHEMA ".schema"
#define RIME_PATH "/org/freedesktop/ibus/engine/rime/"
#define RIME_SCHEMA_PATH(id) RIME_PATH id "/"
#define GOLDEN_CAPABILITIES                                                    \
  (IBUS_CAP_PREEDIT_TEXT | IBUS_CAP_AUXILIARY_TEXT | IBUS_CAP_LOOKUP_TABLE |   \
   IBUS_CAP_SURROUNDING_TEXT | IBUS_CAP_FOCUS)

typedef struct {
  guint32 ic;
  guint16 kind;
  GVariant *payload;
} Record;

typedef struct {
  guint32 ic;
  GPtrArray *records;
  IBusEngine *engine; /* Weak, to check destruction. */
} Fixture;

void golden_init(const gchar *schemas_dir, const gchar *module,
                 const gchar *instances, const gchar *home,
                 const gchar *const *store_paths);
void golden_mount(const gchar *store_path);
void golden_mount_host(const gchar *mount_point);
void golden_wait_file(const gchar *path, const gchar *text);
void golden_wait_log(Fixture *fixture, const gchar *message);
gboolean golden_pump_until(Fixture *fixture,
                           gboolean (*done)(gconstpointer data),
                           gconstpointer data, guint timeout_ms);
void golden_setup(Fixture *fixture, gconstpointer data);
void golden_teardown(Fixture *fixture, gconstpointer data);
void golden_make(Fixture *fixture, const gchar *engine);
void golden_create(Fixture *fixture, const gchar *engine);
void golden_destroy(Fixture *fixture);
void golden_clear(Fixture *fixture);
gint golden_request(Fixture *fixture, guint16 kind, GVariant *payload);
void golden_empty_request(Fixture *fixture, guint16 kind);
gint golden_key(Fixture *fixture, guint keyval, guint keycode, guint modifiers);
void golden_type(Fixture *fixture, const gchar *keys);
void golden_chord(Fixture *fixture, const gchar *keys);
void golden_surrounding(Fixture *fixture, const gchar *text, guint cursor);
void golden_setting(Fixture *fixture, const gchar *path, const gchar *key,
                    GVariant *value);
void golden_reset(Fixture *fixture, const gchar *schema, const gchar *path);
guint golden_count(Fixture *fixture, guint16 kind);
guint golden_count_log(Fixture *fixture, const gchar *message);
gint golden_index(Fixture *fixture, guint16 kind);
Record *golden_last(Fixture *fixture, guint16 kind);
IBusSerializable *golden_object(Record *record, GType type);
gchar *golden_committed(Fixture *fixture);
gchar *golden_preedit(Fixture *fixture);
