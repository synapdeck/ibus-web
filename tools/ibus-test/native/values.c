// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "values.h"
#include <stdio.h>

JsonNode *ibus_test_value(GVariant *value) {
  JsonObject *object = json_object_new();
  char *text = g_variant_print(value, TRUE);
  json_object_set_string_member(object, "signature",
                                g_variant_get_type_string(value));
  json_object_set_string_member(object, "text", text);
  g_free(text);
  JsonNode *node = json_node_new(JSON_NODE_OBJECT);
  json_node_take_object(node, object);
  return node;
}

GVariant *ibus_test_args(const char *text, GError **error) {
  GVariant *value = g_variant_parse(NULL, text, NULL, NULL, error);
  if (value && !g_variant_is_of_type(value, G_VARIANT_TYPE_TUPLE)) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_INVALID_ARGUMENT,
                        "method arguments must be a tuple");
    g_variant_unref(value);
    return NULL;
  }
  return value;
}

void ibus_test_write(JsonNode *record) {
  JsonGenerator *generator = json_generator_new();
  json_generator_set_root(generator, record);
  char *text = json_generator_to_data(generator, NULL);
  puts(text);
  fflush(stdout);
  g_free(text);
  g_object_unref(generator);
}
