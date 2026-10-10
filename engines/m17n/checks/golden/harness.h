/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <ibus.h>

#define M17N_SCHEMA "org.freedesktop.ibus.engine.m17n"
#define M17N_PATH(lang, name)                                                  \
  "/org/freedesktop/ibus/engine/m17n/" lang "/" name "/"
#define VARIABLES_PATH(lang, name) M17N_PATH(lang, name) "variables/"
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

/* A value Init stores for the instance at path. */
typedef struct {
  const gchar *path;
  const gchar *key;
  GVariant *value;
} GoldenSeed;

void golden_init(const gchar *schemas_dir, const gchar *module,
                 const gchar *instances, const GoldenSeed *seeds,
                 gsize n_seeds);
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
void golden_surrounding(Fixture *fixture, const gchar *text, guint cursor);
void golden_setting(Fixture *fixture, const gchar *path, const gchar *key,
                    GVariant *value);
void golden_reset(Fixture *fixture, const gchar *path);
guint golden_count(Fixture *fixture, guint16 kind);
gint golden_index(Fixture *fixture, guint16 kind);
Record *golden_last(Fixture *fixture, guint16 kind);
IBusSerializable *golden_object(Record *record, GType type);
gchar *golden_committed(Fixture *fixture);
gchar *golden_preedit(Fixture *fixture);
