/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

/* Shutdown leaves the runtime refusing every later request, so it runs in a
 * program of its own. */
#include <errno.h>
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>

static GString *calls;

static void persist_first(void) { g_string_append(calls, "persist "); }

static void shut_first(void) { g_string_append(calls, "first "); }

static void shut_third(void) { g_string_append(calls, "third "); }

static void first_module(IBusWebModule *module) {
  g_assert_cmpint(ibusweb_module_set_persist(module, persist_first), ==, 0);
  g_assert_cmpint(ibusweb_module_set_shutdown(module, shut_first), ==, 0);
}

static void refused_module(IBusWebModule *module) {
  g_assert_cmpint(ibusweb_module_set_shutdown(module, shut_first), ==, 0);
  g_assert_cmpint(ibusweb_module_set_shutdown(module, NULL), ==, -EINVAL);
}

static void second_module(IBusWebModule *module) { (void)module; }

static void third_module(IBusWebModule *module) {
  g_assert_cmpint(ibusweb_module_set_shutdown(module, shut_third), ==, 0);
}

static gint send(guint16 kind, guint32 ic, GVariant *payload) {
  g_variant_ref_sink(payload);
  GByteArray *bytes = g_byte_array_new();
  IBusWebRequestHeader header = {GUINT16_TO_LE(kind), 0, GUINT32_TO_LE(ic)};
  g_byte_array_append(bytes, (const guint8 *)&header, sizeof header);
  g_byte_array_append(bytes, g_variant_get_data(payload),
                      g_variant_get_size(payload));
  g_variant_unref(payload);
  gint result = ibusweb_dispatch(bytes->data, bytes->len);
  g_byte_array_unref(bytes);
  return result;
}

static GVariant *init(void) {
  return g_variant_new(
      "(ub@a(ssa{sv}))", IBUSWEB_PROTOCOL_VERSION, TRUE,
      g_variant_new_array(G_VARIANT_TYPE("(ssa{sv})"), NULL, 0));
}

static gboolean set_flag(gpointer flag) {
  *(gboolean *)flag = TRUE;
  return G_SOURCE_REMOVE;
}

/* Shutdown calls every module's shutdown function once, last registered
 * first, whatever the header's ic; a module whose registration failed isn't
 * among them. Afterwards no request reaches the runtime and the pump runs
 * nothing. */
static void test_shutdown(void) {
  static int32_t wake_word;
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, 0);
  calls = g_string_new(NULL);
  g_assert_cmpint(ibusweb_register_module("first", first_module, NULL), ==, 0);
  g_assert_cmpint(ibusweb_register_module("refused", refused_module, NULL), ==,
                  -EINVAL);
  g_assert_cmpint(ibusweb_register_module("second", second_module, NULL), ==,
                  0);
  g_assert_cmpint(ibusweb_register_module("third", third_module, NULL), ==, 0);

  g_assert_cmpint(send(IBUSWEB_REQ_SHUTDOWN, 0, g_variant_new("()")), ==,
                  -ENOTCONN);
  g_assert_cmpint(send(IBUSWEB_REQ_INIT, 0, init()), ==, 0);
  g_assert_cmpint(send(IBUSWEB_REQ_PERSIST, 0, g_variant_new("()")), ==, 0);
  g_assert_cmpint(send(IBUSWEB_REQ_SHUTDOWN, 42, g_variant_new("()")), ==, 0);
  g_assert_cmpstr(calls->str, ==, "persist third first ");

  g_assert_cmpint(send(IBUSWEB_REQ_SHUTDOWN, 0, g_variant_new("()")), ==,
                  -ESHUTDOWN);
  g_assert_cmpint(send(IBUSWEB_REQ_PERSIST, 0, g_variant_new("()")), ==,
                  -ESHUTDOWN);
  g_assert_cmpint(
      send(IBUSWEB_REQ_CREATE_ENGINE, 7, g_variant_new("(s)", "test")), ==,
      -ESHUTDOWN);
  gboolean ran = FALSE;
  g_idle_add(set_flag, &ran);
  g_assert_cmpint(ibusweb_pump(), ==, -1);
  g_assert_false(ran);
  g_assert_cmpstr(calls->str, ==, "persist third first ");
  g_string_free(calls, TRUE);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  g_test_add_func("/shutdown/order", test_shutdown);
  return g_test_run();
}
