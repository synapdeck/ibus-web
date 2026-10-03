// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "values.h"

static void roundtrip(void) {
  GError *error = NULL;
  GVariant *value = ibus_test_args(
      "(<'한글 🐈'>, {'number': <uint32 42>, 'bytes': <[byte 0x01, 0xff]>})",
      &error);
  g_assert_no_error(error);
  g_assert_nonnull(value);
  JsonNode *node = ibus_test_value(value);
  JsonObject *obj = json_node_get_object(node);
  g_assert_cmpstr(json_object_get_string_member(obj, "signature"), ==,
                  "(va{sv})");
  GVariant *parsed = g_variant_parse(
      NULL, json_object_get_string_member(obj, "text"), NULL, NULL, &error);
  g_assert_no_error(error);
  g_assert_true(g_variant_equal(value, parsed));
  g_variant_unref(parsed);
  json_node_free(node);
  g_variant_unref(value);
}

static void invalid(void) {
  GError *error = NULL;
  g_assert_null(ibus_test_args("uint32 42", &error));
  g_assert_nonnull(error);
  g_clear_error(&error);
  g_assert_null(ibus_test_args("(uint32 42,) garbage", &error));
  g_assert_nonnull(error);
  g_clear_error(&error);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  g_test_add_func("/values/roundtrip", roundtrip);
  g_test_add_func("/values/invalid", invalid);
  return g_test_run();
}
