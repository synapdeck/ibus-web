/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "harness.h"
#include <emscripten/wasmfs.h>
#include <string.h>
#include <sys/stat.h>

backend_t wasmfs_create_root_dir(void) {
  return wasmfs_create_memory_backend();
}

static void record_free(gpointer data) {
  Record *record = data;
  g_variant_unref(record->payload);
  g_free(record);
}

/* Every record but a log or a settings write belongs to the fixture's
 * context, those an engine emits while it is being made included. */
static void collect(Fixture *fixture) {
  guint32 length;
  const guint8 *bytes = ibusweb_output_peek(&length);
  guint32 offset = 0;
  while (offset < length) {
    IBusWebRecordHeader header;
    g_assert_cmpuint(length - offset, >=, sizeof header);
    memcpy(&header, bytes + offset, sizeof header);
    guint32 payload_length = GUINT32_FROM_LE(header.len);
    guint32 padded = (sizeof header + payload_length + 7) & ~7u;
    g_assert_cmpuint(padded, <=, length - offset);
    g_assert_cmpuint(GUINT16_FROM_LE(header.flags), ==, 0);

    Record *record = g_new0(Record, 1);
    record->kind = GUINT16_FROM_LE(header.kind);
    record->ic = GUINT32_FROM_LE(header.ic);
    gboolean global = record->kind == IBUSWEB_REC_LOG ||
                      record->kind == IBUSWEB_REC_SETTING_WRITTEN;
    g_assert_cmpuint(record->ic, ==, global ? 0 : fixture->ic);
    const gchar *signature = ibusweb_record_signature(record->kind);
    g_assert_nonnull(signature);
    gpointer copy = g_memdup2(bytes + offset + sizeof header, payload_length);
    record->payload = g_variant_ref_sink(g_variant_new_from_data(
        G_VARIANT_TYPE(signature), copy, payload_length, FALSE, g_free, copy));
    g_assert_true(g_variant_is_normal_form(record->payload));

    if (record->kind == IBUSWEB_REC_LOG) {
      guint level;
      const gchar *domain, *message;
      g_variant_get(record->payload, "(u&s&s)", &level, &domain, &message);
      if (level &
          (G_LOG_LEVEL_WARNING | G_LOG_LEVEL_CRITICAL | G_LOG_LEVEL_ERROR))
        g_error("Unexpected engine log (%s): %s", domain, message);
    }
    g_ptr_array_add(fixture->records, record);
    offset += padded;
  }
  ibusweb_output_consume(length);
}

gint golden_request(Fixture *fixture, guint16 kind, GVariant *payload) {
  g_variant_ref_sink(payload);
  gsize length = sizeof(IBusWebRequestHeader) + g_variant_get_size(payload);
  g_autofree guint8 *bytes = g_malloc(length);
  IBusWebRequestHeader header = {.kind = GUINT16_TO_LE(kind),
                                 .ic = GUINT32_TO_LE(fixture->ic)};
  memcpy(bytes, &header, sizeof header);
  g_variant_store(payload, bytes + sizeof header);
  gint result = ibusweb_dispatch(bytes, length);
  memset(bytes, 0xa5, length);
  g_variant_unref(payload);
  g_assert_cmpint(ibusweb_pump(), !=, IBUSWEB_PUMP_ERROR);
  collect(fixture);
  return result;
}

void golden_empty_request(Fixture *fixture, guint16 kind) {
  g_assert_cmpint(golden_request(fixture, kind, g_variant_new("()")), ==, 0);
}

gint golden_key(Fixture *fixture, guint keyval, guint keycode,
                guint modifiers) {
  gint reply =
      golden_request(fixture, IBUSWEB_REQ_PROCESS_KEY_EVENT,
                     g_variant_new("(uuu)", keyval, keycode, modifiers));
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_PROCESS_KEY_EVENT,
                                 g_variant_new("(uuu)", keyval, keycode,
                                               modifiers | IBUS_RELEASE_MASK)),
                  >=, 0);
  return reply;
}

/* The evdev code of the US key that types c unshifted. */
static guint keycode(gchar c) {
  static const struct {
    const gchar *keys;
    guint first;
  } rows[] = {{"1234567890", 2},
              {"qwertyuiop", 16},
              {"asdfghjkl", 30},
              {"zxcvbnm", 44}};
  for (guint i = 0; i < G_N_ELEMENTS(rows); i++) {
    const gchar *found = strchr(rows[i].keys, c);
    if (c != '\0' && found != NULL)
      return rows[i].first + (found - rows[i].keys);
  }

  switch (c) {
  case ' ':
    return 57;
  case '\'':
    return 40;
  case '`':
    return 41;
  default:
    g_error("No unshifted US key types %c", c);
  }
}

/* ASCII's printable keysyms are its code points. */
void golden_type(Fixture *fixture, const gchar *keys) {
  for (const gchar *c = keys; *c != '\0'; c++)
    g_assert_cmpint(golden_key(fixture, (guchar)*c, keycode(*c), 0), ==, 1);
}

void golden_surrounding(Fixture *fixture, const gchar *text, guint cursor) {
  IBusText *surrounding = g_object_ref_sink(ibus_text_new_from_string(text));
  GVariant *serialized =
      ibus_serializable_serialize(IBUS_SERIALIZABLE(surrounding));
  g_assert_cmpint(
      golden_request(fixture, IBUSWEB_REQ_SET_SURROUNDING_TEXT,
                     g_variant_new("(vuu)", serialized, cursor, cursor)),
      ==, 0);
  g_object_unref(surrounding);
}

void golden_setting(Fixture *fixture, const gchar *path, const gchar *key,
                    GVariant *value) {
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_SETTING_CHANGED,
                                 g_variant_new("(ssv)", path, key, value)),
                  ==, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_SETTING_WRITTEN), ==, 0);
}

/* Engine settings live in each engine's class for the whole run, so a case
 * that changes one starts from the defaults whatever an earlier case left. */
void golden_reset(Fixture *fixture, const gchar *path) {
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();
  g_autoptr(GSettingsSchema) schema =
      g_settings_schema_source_lookup(source, M17N_SCHEMA, TRUE);
  g_assert_nonnull(schema);
  g_auto(GStrv) names = g_settings_schema_list_keys(schema);
  for (gchar **name = names; *name != NULL; ++name) {
    g_autoptr(GSettingsSchemaKey) key =
        g_settings_schema_get_key(schema, *name);
    g_autoptr(GVariant) value = g_settings_schema_key_get_default_value(key);
    golden_setting(fixture, path, *name, value);
  }
}

void golden_clear(Fixture *fixture) {
  g_ptr_array_set_size(fixture->records, 0);
}

guint golden_count(Fixture *fixture, guint16 kind) {
  guint count = 0;
  for (guint i = 0; i < fixture->records->len; ++i) {
    Record *record = g_ptr_array_index(fixture->records, i);
    count += record->kind == kind;
  }
  return count;
}

/* The position of the first record of kind, or -1. */
gint golden_index(Fixture *fixture, guint16 kind) {
  for (guint i = 0; i < fixture->records->len; ++i) {
    Record *record = g_ptr_array_index(fixture->records, i);
    if (record->kind == kind)
      return i;
  }
  return -1;
}

Record *golden_last(Fixture *fixture, guint16 kind) {
  for (guint i = fixture->records->len; i > 0; --i) {
    Record *record = g_ptr_array_index(fixture->records, i - 1);
    if (record->kind == kind)
      return record;
  }
  g_error("Missing output record kind %u", kind);
}

IBusSerializable *golden_object(Record *record, GType type) {
  GVariant *serialized;
  g_variant_get_child(record->payload, 0, "v", &serialized);
  IBusSerializable *object = ibus_serializable_deserialize(serialized);
  g_assert_nonnull(object);
  g_assert_true(G_TYPE_CHECK_INSTANCE_TYPE(object, type));
  g_object_ref_sink(object);
  g_variant_unref(serialized);
  return object;
}

/* Everything committed since the records were last cleared, in order. */
gchar *golden_committed(Fixture *fixture) {
  GString *committed = g_string_new(NULL);
  for (guint i = 0; i < fixture->records->len; ++i) {
    Record *record = g_ptr_array_index(fixture->records, i);
    if (record->kind != IBUSWEB_REC_COMMIT_TEXT)
      continue;
    IBusText *text = IBUS_TEXT(golden_object(record, IBUS_TYPE_TEXT));
    g_string_append(committed, text->text);
    g_object_unref(text);
  }
  return g_string_free(committed, FALSE);
}

/* The latest preedit, or "" when there has been none. */
gchar *golden_preedit(Fixture *fixture) {
  if (golden_count(fixture, IBUSWEB_REC_UPDATE_PREEDIT_TEXT) == 0)
    return g_strdup("");
  IBusText *text = IBUS_TEXT(golden_object(
      golden_last(fixture, IBUSWEB_REC_UPDATE_PREEDIT_TEXT), IBUS_TYPE_TEXT));
  gchar *preedit = g_strdup(text->text);
  g_object_unref(text);
  return preedit;
}

static gboolean capture_engine(GSignalInvocationHint *hint G_GNUC_UNUSED,
                               guint count G_GNUC_UNUSED, const GValue *values,
                               gpointer data) {
  Fixture *fixture = data;
  fixture->engine = g_value_get_object(&values[0]);
  g_object_add_weak_pointer(G_OBJECT(fixture->engine),
                            (gpointer *)&fixture->engine);
  return TRUE;
}

/* Only the CreateEngine, so a case sees what the engine emits while it is
 * being made. */
void golden_make(Fixture *fixture, const gchar *engine) {
  static guint32 next_ic = 1;
  fixture->ic = next_ic++;
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CREATE_ENGINE,
                                 g_variant_new("(s)", engine)),
                  ==, 0);
}

void golden_create(Fixture *fixture, const gchar *engine) {
  golden_make(fixture, engine);
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_SET_CAPABILITIES,
                                 g_variant_new("(u)", GOLDEN_CAPABILITIES)),
                  ==, 0);
  guint signal = g_signal_lookup("focus-in", IBUS_TYPE_ENGINE);
  gulong hook =
      g_signal_add_emission_hook(signal, 0, capture_engine, fixture, NULL);
  golden_empty_request(fixture, IBUSWEB_REQ_FOCUS_IN);
  g_signal_remove_emission_hook(signal, hook);
  g_assert_nonnull(fixture->engine);
  golden_clear(fixture);
}

void golden_destroy(Fixture *fixture) {
  golden_empty_request(fixture, IBUSWEB_REQ_DESTROY_ENGINE);
  g_assert_null(fixture->engine);
  fixture->ic = 0;
  golden_clear(fixture);
}

void golden_setup(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  fixture->records = g_ptr_array_new_with_free_func(record_free);
}

void golden_teardown(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  if (fixture->ic != 0)
    golden_destroy(fixture);
  g_ptr_array_unref(fixture->records);
}

/* Init declares every instance the module's settings metadata does, so that
 * each engine's settings are those of an instance the page could store. */
static GVariant *instances_from(const gchar *path, const GoldenSeed *seeds,
                                gsize n_seeds) {
  g_autofree gchar *contents = NULL;
  g_assert_true(g_file_get_contents(path, &contents, NULL, NULL));
  g_auto(GStrv) lines = g_strsplit(contents, "\n", -1);
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();

  GVariantBuilder instances;
  g_variant_builder_init(&instances, G_VARIANT_TYPE("a(ssa{sv})"));
  gsize seeded = 0;
  for (gchar **line = lines; *line != NULL; line++) {
    if (**line == '\0')
      continue;
    g_auto(GStrv) parts = g_strsplit(*line, "=", 2);
    g_autoptr(GSettingsSchema) schema =
        g_settings_schema_source_lookup(source, parts[0], TRUE);
    g_assert_nonnull(schema);
    const gchar *instance =
        parts[1] != NULL ? parts[1] : g_settings_schema_get_path(schema);
    g_assert_nonnull(instance);

    GVariantBuilder values;
    g_variant_builder_init(&values, G_VARIANT_TYPE("a{sv}"));
    for (gsize i = 0; i < n_seeds; i++) {
      if (!g_str_equal(seeds[i].path, instance))
        continue;
      g_variant_builder_add(&values, "{sv}", seeds[i].key, seeds[i].value);
      seeded++;
    }
    g_variant_builder_add(&instances, "(ss@a{sv})", parts[0], instance,
                          g_variant_builder_end(&values));
  }

  g_assert_cmpuint(seeded, ==, n_seeds);
  return g_variant_builder_end(&instances);
}

void golden_init(const gchar *schemas_dir, const gchar *module,
                 const gchar *instances, const GoldenSeed *seeds,
                 gsize n_seeds) {
  g_assert_cmpint(mkdir("/nix", 0777), ==, 0);
  g_assert_cmpint(
      wasmfs_create_directory("/nix/store", 0777,
                              wasmfs_create_node_backend("/nix/store")),
      ==, 0);
  g_autofree gchar *directory = g_path_get_dirname(module);
  g_assert_cmpint(wasmfs_create_directory(
                      "/sides", 0777, wasmfs_create_node_backend(directory)),
                  ==, 0);
  g_setenv("GSETTINGS_SCHEMA_DIR", schemas_dir, TRUE);
  g_unsetenv("GSETTINGS_BACKEND");
  g_setenv("G_MESSAGES_DEBUG", "all", TRUE);
  static gint32 wake_word;
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, 0);

  Fixture fixture = {.records = g_ptr_array_new_with_free_func(record_free)};
  g_assert_cmpint(
      golden_request(&fixture, IBUSWEB_REQ_INIT,
                     g_variant_new("(ub@a(ssa{sv}))", IBUSWEB_PROTOCOL_VERSION,
                                   TRUE,
                                   instances_from(instances, seeds, n_seeds))),
      ==, 0);
  g_log_set_default_handler(g_log_default_handler, NULL);
  g_assert_cmpint(ibusweb_load_module("/sides/m17n.wasm", NULL), ==, 0);
  collect(&fixture);
  g_ptr_array_unref(fixture.records);
}
