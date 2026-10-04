// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "driver.h"
#include <emscripten/wasmfs.h>
#include <stdio.h>
#include <sys/stat.h>

backend_t wasmfs_create_root_dir(void) {
  return wasmfs_create_memory_backend();
}

static gchar *mount_engine(const gchar *schemas_dir, const gchar *module) {
  if (mkdir("/nix", 0777) != 0 ||
      wasmfs_create_directory("/nix/store", 0777,
                              wasmfs_create_node_backend("/nix/store")) != 0)
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
  g_setenv("GSETTINGS_SCHEMA_DIR", schemas_dir, TRUE);
  g_unsetenv("GSETTINGS_BACKEND");
  g_setenv("G_MESSAGES_DEBUG", "all", TRUE);
  return path;
}

int main(int argc, char **argv) {
  /* Until Init installs the framed writer, a warning has no output record to
   * fail the run through, so it aborts with GLib's stderr diagnostic. */
  g_log_writer_default_set_use_stderr(TRUE);
  GLogLevelFlags runtime_fatal_mask = g_log_get_always_fatal();
  g_log_set_always_fatal(runtime_fatal_mask | G_LOG_LEVEL_WARNING |
                         G_LOG_LEVEL_CRITICAL | G_LOG_LEVEL_ERROR);
  gchar *schemas_dir = NULL, *module = NULL;
  GOptionEntry options[] = {
      {"schemas", 0, 0, G_OPTION_ARG_STRING, &schemas_dir,
       "Compiled settings schemas", "DIR"},
      {"module", 0, 0, G_OPTION_ARG_STRING, &module, "Engine side module",
       "FILE"},
      {NULL, 0, 0, 0, NULL, NULL, NULL},
  };
  GOptionContext *context = g_option_context_new(NULL);
  g_option_context_add_main_entries(context, options, NULL);
  GError *error = NULL;
  gboolean valid = g_option_context_parse(context, &argc, &argv, &error) &&
                   argc == 1 && schemas_dir && module;
  g_option_context_free(context);
  if (!valid) {
    g_printerr("Expected --schemas DIR --module FILE%s%s\n", error ? ": " : "",
               error ? error->message : "");
    g_clear_error(&error);
    g_free(schemas_dir);
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
    gchar *mounted_module = mount_engine(schemas_dir, module);
    if (!mounted_module) {
      g_printerr("Cannot mount engine data or module\n");
      ok = FALSE;
    } else {
      ok = ibus_test_wasm_run(trace, mounted_module, runtime_fatal_mask);
      g_free(mounted_module);
    }
  }
  g_clear_error(&error);
  g_object_unref(parser);
  g_string_free(input, TRUE);
  g_free(schemas_dir);
  g_free(module);
  return ok ? 0 : 1;
}
