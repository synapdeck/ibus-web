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
    g_assert_true(record->ic == 0 || record->ic == fixture->ic);
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

gint golden_key(Fixture *fixture, guint key, guint code, guint modifiers) {
  gint reply = golden_request(fixture, IBUSWEB_REQ_PROCESS_KEY_EVENT,
                              g_variant_new("(uuu)", key, code, modifiers));
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_PROCESS_KEY_EVENT,
                                 g_variant_new("(uuu)", key, code,
                                               modifiers | IBUS_RELEASE_MASK)),
                  >=, 0);
  return reply;
}

void golden_setting(Fixture *fixture, const gchar *path, const gchar *key,
                    GVariant *value) {
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_SETTING_CHANGED,
                                 g_variant_new("(ssv)", path, key, value)),
                  ==, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_SETTING_WRITTEN), ==, 0);
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

static gboolean capture_engine(GSignalInvocationHint *hint G_GNUC_UNUSED,
                               guint count G_GNUC_UNUSED, const GValue *values,
                               gpointer data) {
  Fixture *fixture = data;
  fixture->engine = g_value_get_object(&values[0]);
  g_object_add_weak_pointer(G_OBJECT(fixture->engine),
                            (gpointer *)&fixture->engine);
  return TRUE;
}

void golden_create(Fixture *fixture) {
  static guint32 next_ic = 1;
  fixture->ic = next_ic++;
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CREATE_ENGINE,
                                 g_variant_new("(s)", "hangul")),
                  ==, 0);
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_SET_CAPABILITIES,
                                 g_variant_new("(u)", GOLDEN_CAPABILITIES)),
                  ==, 0);
  guint signal = g_signal_lookup("focus-in", IBUS_TYPE_ENGINE);
  gulong hook =
      g_signal_add_emission_hook(signal, 0, capture_engine, fixture, NULL);
  golden_empty_request(fixture, IBUSWEB_REQ_FOCUS_IN);
  g_signal_remove_emission_hook(signal, hook);
  g_assert_nonnull(fixture->engine);
}

void golden_destroy(Fixture *fixture) {
  golden_empty_request(fixture, IBUSWEB_REQ_DESTROY_ENGINE);
  g_assert_null(fixture->engine);
  fixture->ic = 0;
}

/* Lets the candidate cases open Hanja with either F9 or F8. */
static const gchar golden_hanja_keys[] = "Hangul_Hanja,F9,F8";

/* Engine settings are module globals, so each case starts from the same
 * snapshot whatever an earlier case changed or failed to restore. */
static const struct {
  const gchar *schema;
  const gchar *path;
} reset_instances[] = {{HANGUL_SCHEMA, HANGUL_PATH},
                       {PANEL_SCHEMA, PANEL_PATH}};

static GVariant *baseline(GSettingsSchemaKey *key, const gchar *schema) {
  if (g_str_equal(schema, HANGUL_SCHEMA) &&
      g_str_equal(g_settings_schema_key_get_name(key), "hanja-keys"))
    return g_variant_ref_sink(g_variant_new_string(golden_hanja_keys));
  return g_settings_schema_key_get_default_value(key);
}

static void reset_settings(Fixture *fixture) {
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();
  for (guint i = 0; i < G_N_ELEMENTS(reset_instances); ++i) {
    g_autoptr(GSettingsSchema) schema = g_settings_schema_source_lookup(
        source, reset_instances[i].schema, TRUE);
    g_assert_nonnull(schema);
    g_auto(GStrv) names = g_settings_schema_list_keys(schema);
    for (gchar **name = names; *name != NULL; ++name) {
      g_autoptr(GSettingsSchemaKey) key =
          g_settings_schema_get_key(schema, *name);
      g_autoptr(GVariant) value = baseline(key, reset_instances[i].schema);
      golden_setting(fixture, reset_instances[i].path, *name, value);
    }
  }
}

void golden_setup(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  fixture->records = g_ptr_array_new_with_free_func(record_free);
  reset_settings(fixture);
  golden_create(fixture);
  golden_clear(fixture);
}

void golden_teardown(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  if (fixture->ic != 0)
    golden_destroy(fixture);
  g_ptr_array_unref(fixture->records);
}

void golden_init(const gchar *schemas_dir, const gchar *module) {
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

  GVariantBuilder keys, instances;
  g_variant_builder_init(&keys, G_VARIANT_TYPE("a{sv}"));
  g_variant_builder_add(&keys, "{sv}", "hanja-keys",
                        g_variant_new_string(golden_hanja_keys));
  g_variant_builder_init(&instances, G_VARIANT_TYPE("a(ssa{sv})"));
  g_variant_builder_add(&instances, "(ss@a{sv})", HANGUL_SCHEMA, HANGUL_PATH,
                        g_variant_builder_end(&keys));
  g_variant_builder_add_parsed(&instances, "(%s, %s, @a{sv} {})", PANEL_SCHEMA,
                               PANEL_PATH);

  Fixture fixture = {.records = g_ptr_array_new_with_free_func(record_free)};
  g_assert_cmpint(
      golden_request(&fixture, IBUSWEB_REQ_INIT,
                     g_variant_new("(u@a(ssa{sv}))", IBUSWEB_PROTOCOL_VERSION,
                                   g_variant_builder_end(&instances))),
      ==, 0);
  g_log_set_default_handler(g_log_default_handler, NULL);
  g_assert_cmpint(ibusweb_load_module("/sides/hangul.wasm", NULL), ==, 0);
  collect(&fixture);
  g_ptr_array_unref(fixture.records);
}
