// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include <gio/gio.h>
#include <json-glib/json-glib.h>
#include <stdio.h>
#include <string.h>

static void string(JsonBuilder *json, const char *name, const char *value) {
  if (!value)
    return;
  json_builder_set_member_name(json, name);
  json_builder_add_string_value(json, value);
}

static void variant(JsonBuilder *json, const char *name, GVariant *value) {
  GVariant *normal = g_variant_get_normal_form(value);
  gchar *bytes =
      g_base64_encode(g_variant_get_data(normal), g_variant_get_size(normal));
  json_builder_set_member_name(json, name);
  json_builder_begin_object(json);
  string(json, "type", g_variant_get_type_string(normal));
  string(json, "bytes", bytes);
  json_builder_end_object(json);
  g_free(bytes);
  g_variant_unref(normal);
}

typedef struct {
  gchar *id;
  GPtrArray *paths;
} Entry;

static void entry_free(gpointer data) {
  Entry *entry = data;
  g_free(entry->id);
  g_ptr_array_unref(entry->paths);
  g_free(entry);
}

static Entry *entry_for(GPtrArray *entries, const gchar *id) {
  for (guint i = 0; i < entries->len; i++) {
    Entry *entry = g_ptr_array_index(entries, i);
    if (g_str_equal(entry->id, id))
      return entry;
  }
  return NULL;
}

static void keys(JsonBuilder *json, GSettingsSchema *schema) {
  json_builder_set_member_name(json, "keys");
  json_builder_begin_array(json);
  gchar **names = g_settings_schema_list_keys(schema);
  for (gchar **name = names; *name; name++) {
    GSettingsSchemaKey *key = g_settings_schema_get_key(schema, *name);
    json_builder_begin_object(json);
    string(json, "name", *name);
    string(
        json, "type",
        g_variant_type_peek_string(g_settings_schema_key_get_value_type(key)));
    GVariant *value = g_settings_schema_key_get_default_value(key);
    variant(json, "default", value);
    g_variant_unref(value);
    string(json, "summary", g_settings_schema_key_get_summary(key));
    string(json, "description", g_settings_schema_key_get_description(key));
    GVariant *range = g_settings_schema_key_get_range(key), *detail;
    const gchar *kind;
    g_variant_get(range, "(&sv)", &kind, &detail);
    if (g_str_equal(kind, "range")) {
      json_builder_set_member_name(json, "range");
      json_builder_begin_object(json);
      GVariant *min = g_variant_get_child_value(detail, 0),
               *max = g_variant_get_child_value(detail, 1);
      variant(json, "min", min);
      variant(json, "max", max);
      g_variant_unref(min);
      g_variant_unref(max);
      json_builder_end_object(json);
    } else if (g_str_equal(kind, "enum") || g_str_equal(kind, "flags")) {
      json_builder_set_member_name(json, "choices");
      json_builder_begin_array(json);
      GVariantIter iter;
      const gchar *choice;
      g_variant_iter_init(&iter, detail);
      while (g_variant_iter_next(&iter, "&s", &choice))
        json_builder_add_string_value(json, choice);
      json_builder_end_array(json);
    } else if (!g_str_equal(kind, "type")) {
      g_error("Unsupported GSettings range kind: %s", kind);
    }
    g_variant_unref(detail);
    g_variant_unref(range);
    json_builder_end_object(json);
    g_settings_schema_key_unref(key);
  }
  g_strfreev(names);
  json_builder_end_array(json);
}

/* Each argument after the directory is a schema id, which lists the schema,
 * or ID=PATH, which adds a path to a schema also listed on its own. */
int main(int argc, char **argv) {
  if (argc < 2) {
    g_printerr("usage: metadata SCHEMA_DIR [SCHEMA_ID | SCHEMA_ID=PATH]...\n");
    return 1;
  }
  GError *error = NULL;
  GSettingsSchemaSource *source =
      g_settings_schema_source_new_from_directory(argv[1], NULL, FALSE, &error);
  if (!source) {
    g_printerr("%s\n", error->message);
    g_error_free(error);
    return 1;
  }

  GPtrArray *entries = g_ptr_array_new_with_free_func(entry_free);
  for (int i = 2; i < argc; i++) {
    if (strchr(argv[i], '=') == NULL && entry_for(entries, argv[i]) == NULL) {
      Entry *entry = g_new(Entry, 1);
      entry->id = g_strdup(argv[i]);
      entry->paths = g_ptr_array_new_with_free_func(g_free);
      g_ptr_array_add(entries, entry);
    }
  }
  int status = 0;
  for (int i = 2; i < argc && status == 0; i++) {
    const gchar *separator = strchr(argv[i], '=');
    if (separator == NULL)
      continue;
    g_autofree gchar *id = g_strndup(argv[i], separator - argv[i]);
    Entry *entry = entry_for(entries, id);
    if (entry == NULL) {
      g_printerr("%s: a path was given for a schema that isn't listed\n", id);
      status = 1;
    } else {
      g_ptr_array_add(entry->paths, g_strdup(separator + 1));
    }
  }

  JsonBuilder *json = json_builder_new();
  json_builder_begin_object(json);
  json_builder_set_member_name(json, "schemas");
  json_builder_begin_array(json);
  for (guint i = 0; i < entries->len && status == 0; i++) {
    Entry *entry = g_ptr_array_index(entries, i);
    GSettingsSchema *schema =
        g_settings_schema_source_lookup(source, entry->id, FALSE);
    const gchar *fixed = schema ? g_settings_schema_get_path(schema) : NULL;
    if (!schema) {
      g_printerr("%s: schema missing\n", entry->id);
      status = 1;
    } else if (fixed && entry->paths->len > 0) {
      g_printerr("%s: paths were given for a schema with a fixed path\n",
                 entry->id);
      status = 1;
    } else if (!fixed && entry->paths->len == 0) {
      g_printerr("%s: a relocatable schema needs its paths\n", entry->id);
      status = 1;
    } else {
      json_builder_begin_object(json);
      string(json, "id", entry->id);
      json_builder_set_member_name(json, "paths");
      json_builder_begin_array(json);
      if (fixed)
        json_builder_add_string_value(json, fixed);
      for (guint j = 0; j < entry->paths->len; j++)
        json_builder_add_string_value(json, g_ptr_array_index(entry->paths, j));
      json_builder_end_array(json);
      keys(json, schema);
      json_builder_end_object(json);
    }
    if (schema)
      g_settings_schema_unref(schema);
  }
  json_builder_end_array(json);
  json_builder_end_object(json);
  if (status == 0) {
    JsonNode *root = json_builder_get_root(json);
    gchar *output = json_to_string(root, FALSE);
    puts(output);
    g_free(output);
    json_node_unref(root);
  }
  g_object_unref(json);
  g_ptr_array_unref(entries);
  g_settings_schema_source_unref(source);
  return status;
}
