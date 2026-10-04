// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "driver.h"
#include <emscripten/wasmfs.h>
#include <stdio.h>
#include <sys/stat.h>

backend_t wasmfs_create_root_dir(void) {
  return wasmfs_create_memory_backend();
}

static gchar *mount_engine(const gchar *data, const gchar *module) {
  if (mkdir("/usr", 0777) != 0 ||
      wasmfs_create_directory("/usr/share", 0777,
                              wasmfs_create_node_backend(data)) != 0)
    return NULL;
  gchar *directory = g_path_get_dirname(module);
  gint mounted = wasmfs_create_directory("/sides", 0777,
                                         wasmfs_create_node_backend(directory));
  g_free(directory);
  if (mounted != 0)
    return NULL;
  gchar *basename = g_path_get_basename(module);
  gchar *path = g_build_filename("/sides", basename, NULL);
  g_free(basename);
  g_setenv("GSETTINGS_SCHEMA_DIR", "/usr/share/glib-2.0/schemas", TRUE);
  g_unsetenv("GSETTINGS_BACKEND");
  g_setenv("G_MESSAGES_DEBUG", "all", TRUE);
  return path;
}

int main(int argc, char **argv) {
  /* Init selects the settings backend before installing the framed writer. */
  g_log_writer_default_set_use_stderr(TRUE);
  gchar *data = NULL, *module = NULL;
  GOptionEntry options[] = {
      {"data", 0, 0, G_OPTION_ARG_STRING, &data, "Engine usr/share tree",
       "DIR"},
      {"module", 0, 0, G_OPTION_ARG_STRING, &module, "Engine side module",
       "FILE"},
      {NULL, 0, 0, 0, NULL, NULL, NULL},
  };
  GOptionContext *context = g_option_context_new(NULL);
  g_option_context_add_main_entries(context, options, NULL);
  GError *error = NULL;
  gboolean valid = g_option_context_parse(context, &argc, &argv, &error) &&
                   argc == 1 && data && module;
  g_option_context_free(context);
  if (!valid) {
    g_printerr("Expected --data DIR --module FILE%s%s\n", error ? ": " : "",
               error ? error->message : "");
    g_clear_error(&error);
    g_free(data);
    g_free(module);
    return 2;
  }

  GString *input = g_string_new(NULL);
  gchar buffer[4096];
  gsize length;
  while ((length = fread(buffer, 1, sizeof buffer, stdin)))
    g_string_append_len(input, buffer, length);
  JsonParser *parser = json_parser_new();
  gboolean ok = !ferror(stdin) && json_parser_load_from_data(
                                      parser, input->str, input->len, &error);
  JsonNode *root = ok ? json_parser_get_root(parser) : NULL;
  JsonObject *trace =
      root && JSON_NODE_HOLDS_OBJECT(root) ? json_node_get_object(root) : NULL;
  if (!trace || !json_object_has_member(trace, "version") ||
      json_object_get_int_member(trace, "version") != 1 ||
      !json_object_has_member(trace, "steps") ||
      !JSON_NODE_HOLDS_ARRAY(json_object_get_member(trace, "steps")) ||
      !json_object_has_member(trace, "settings") ||
      !JSON_NODE_HOLDS_ARRAY(json_object_get_member(trace, "settings"))) {
    g_printerr("Expected a validated version 1 trace%s%s\n", error ? ": " : "",
               error ? error->message : "");
    ok = FALSE;
  } else {
    gchar *mounted_module = mount_engine(data, module);
    if (!mounted_module) {
      g_printerr("Cannot mount engine data or module\n");
      ok = FALSE;
    } else {
      ok = ibus_test_wasm_run(trace, mounted_module);
      g_free(mounted_module);
    }
  }
  g_clear_error(&error);
  g_object_unref(parser);
  g_string_free(input, TRUE);
  g_free(data);
  g_free(module);
  return ok ? 0 : 1;
}
