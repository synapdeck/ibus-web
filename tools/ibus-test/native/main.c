// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "driver.h"
#include <stdio.h>

int main(int argc, char **argv) {
  char *address = NULL, *destination = NULL, *factory = NULL;
  gint timeout = 1000;
  GOptionEntry options[] = {
      {"address", 0, 0, G_OPTION_ARG_STRING, &address, "Private bus address",
       "ADDRESS"},
      {"destination", 0, 0, G_OPTION_ARG_STRING, &destination, "Engine service",
       "NAME"},
      {"factory", 0, 0, G_OPTION_ARG_STRING, &factory, "Factory object",
       "PATH"},
      {"timeout-ms", 0, 0, G_OPTION_ARG_INT, &timeout, "Method deadline", "N"},
      {NULL, 0, 0, 0, NULL, NULL, NULL}};
  GOptionContext *options_context = g_option_context_new(NULL);
  g_option_context_add_main_entries(options_context, options, NULL);
  GError *error = NULL;
  if (!g_option_context_parse(options_context, &argc, &argv, &error) ||
      argc != 1 || !address || !destination || !factory || timeout <= 0 ||
      !g_dbus_is_name(destination) || !g_variant_is_object_path(factory)) {
    g_printerr("Invalid options%s%s\n", error ? ": " : "",
               error ? error->message : "");
    g_clear_error(&error);
    g_option_context_free(options_context);
    g_free(address);
    g_free(destination);
    g_free(factory);
    return 2;
  }
  g_option_context_free(options_context);

  GString *input = g_string_new(NULL);
  char buffer[4096];
  size_t count;
  while ((count = fread(buffer, 1, sizeof buffer, stdin)))
    g_string_append_len(input, buffer, count);

  JsonParser *parser = json_parser_new();
  gboolean ok = !ferror(stdin) && json_parser_load_from_data(
                                      parser, input->str, input->len, &error);
  JsonNode *root = ok ? json_parser_get_root(parser) : NULL;
  JsonObject *trace =
      root && JSON_NODE_HOLDS_OBJECT(root) ? json_node_get_object(root) : NULL;
  JsonNode *steps = trace ? json_object_get_member(trace, "steps") : NULL;
  if (!trace || !steps || !JSON_NODE_HOLDS_ARRAY(steps) ||
      !json_object_has_member(trace, "version") ||
      json_object_get_int_member(trace, "version") != 1) {
    g_printerr("Expected a validated version 1 trace%s%s\n", error ? ": " : "",
               error ? error->message : "");
    ok = FALSE;
  } else {
    ok = ibus_test_run(json_node_get_array(steps), address, destination,
                       factory, timeout);
  }

  g_clear_error(&error);
  g_object_unref(parser);
  g_string_free(input, TRUE);
  g_free(address);
  g_free(destination);
  g_free(factory);
  return ok ? 0 : 1;
}
