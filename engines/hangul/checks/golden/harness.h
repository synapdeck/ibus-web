/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <ibus.h>

#define HANGUL_SCHEMA "org.freedesktop.ibus.engine.hangul"
#define HANGUL_PATH "/org/freedesktop/ibus/engine/hangul/"
#define PANEL_SCHEMA "org.freedesktop.ibus.panel"
#define PANEL_PATH "/desktop/ibus/panel/"
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
  IBusEngine
      *engine; /* Weak, to check destruction and the surrounding cache. */
} Fixture;

void golden_init(const gchar *schemas_dir, const gchar *module);
void golden_setup(Fixture *fixture, gconstpointer data);
void golden_teardown(Fixture *fixture, gconstpointer data);
void golden_create(Fixture *fixture);
void golden_destroy(Fixture *fixture);
void golden_clear(Fixture *fixture);
gint golden_request(Fixture *fixture, guint16 kind, GVariant *payload);
gint golden_key(Fixture *fixture, guint key, guint code, guint modifiers);
void golden_empty_request(Fixture *fixture, guint16 kind);
void golden_setting(Fixture *fixture, const gchar *path, const gchar *key,
                    GVariant *value);
guint golden_count(Fixture *fixture, guint16 kind);
Record *golden_last(Fixture *fixture, guint16 kind);
IBusSerializable *golden_object(Record *record, GType type);
