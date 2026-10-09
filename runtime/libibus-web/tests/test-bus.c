/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include <ibus.h>

static IBusBus *bus;

static void connection(void) {
  g_assert_true(ibus_bus_is_connected(bus));
  g_assert_null(ibus_bus_get_connection(bus));
  g_assert_cmpstr(ibus_bus_get_service_name(bus), ==, IBUS_SERVICE_IBUS);

  /* An engine's factory takes the bus's connection. */
  IBusFactory *factory =
      g_object_ref_sink(ibus_factory_new(ibus_bus_get_connection(bus)));
  g_object_unref(factory);
}

static void singleton(void) {
  IBusBus *again = ibus_bus_new();
  g_assert_true(again == bus);
  g_object_unref(again);
}

static void on_name_owner_changed(IBusBus *self G_GNUC_UNUSED,
                                  const gchar *name, const gchar *old_owner,
                                  const gchar *new_owner, gpointer data) {
  g_ptr_array_add(data,
                  g_strdup_printf("%s %s>%s", name, old_owner, new_owner));
}

static void names(void) {
  const gchar *name = "org.freedesktop.IBus.Mozc";
  const gchar *me = ibus_bus_hello(bus);
  GPtrArray *changes = g_ptr_array_new_with_free_func(g_free);
  gulong handler = g_signal_connect(bus, "name-owner-changed",
                                    G_CALLBACK(on_name_owner_changed), changes);
  ibus_bus_set_watch_dbus_signal(bus, TRUE);

  g_assert_false(ibus_bus_name_has_owner(bus, name));
  g_assert_cmpuint(ibus_bus_request_name(bus, name, 0), ==,
                   IBUS_BUS_REQUEST_NAME_REPLY_PRIMARY_OWNER);
  g_assert_cmpuint(ibus_bus_request_name(bus, name, 0), ==,
                   IBUS_BUS_REQUEST_NAME_REPLY_ALREADY_OWNER);
  g_assert_true(ibus_bus_name_has_owner(bus, name));

  gchar *owner = ibus_bus_get_name_owner(bus, name);
  g_assert_cmpstr(owner, ==, me);
  g_free(owner);

  GList *queued = ibus_bus_list_queued_owners(bus, name);
  g_assert_cmpuint(g_list_length(queued), ==, 1);
  g_assert_cmpstr(queued->data, ==, me);
  g_list_free_full(queued, g_free);

  GList *listed = ibus_bus_list_names(bus);
  g_assert_nonnull(g_list_find_custom(listed, name, (GCompareFunc)g_strcmp0));
  g_assert_nonnull(
      g_list_find_custom(listed, IBUS_SERVICE_IBUS, (GCompareFunc)g_strcmp0));
  g_list_free_full(listed, g_free);

  /* The daemon's own name is never handed over. */
  g_assert_cmpuint(ibus_bus_request_name(bus, IBUS_SERVICE_IBUS, 0), ==,
                   IBUS_BUS_REQUEST_NAME_REPLY_EXISTS);
  owner = ibus_bus_get_name_owner(bus, IBUS_SERVICE_IBUS);
  g_assert_cmpstr(owner, ==, IBUS_SERVICE_IBUS);
  g_free(owner);

  g_assert_cmpuint(ibus_bus_release_name(bus, name), ==, 1);
  g_assert_cmpuint(ibus_bus_release_name(bus, name), ==, 2);
  g_assert_false(ibus_bus_name_has_owner(bus, name));

  g_assert_cmpuint(changes->len, ==, 2);
  gchar *acquired = g_strdup_printf("%s >%s", name, me);
  gchar *released = g_strdup_printf("%s %s>", name, me);
  g_assert_cmpstr(changes->pdata[0], ==, acquired);
  g_assert_cmpstr(changes->pdata[1], ==, released);
  g_free(acquired);
  g_free(released);

  ibus_bus_set_watch_dbus_signal(bus, FALSE);
  g_signal_handler_disconnect(bus, handler);
  g_ptr_array_unref(changes);
}

static void components(void) {
  IBusComponent *component =
      ibus_component_new("com.google.IBus.Mozc", "Mozc", "2.30", "BSD-3-Clause",
                         "Google", "", "", "ibus-mozc");
  ibus_component_add_engine(
      component,
      ibus_engine_desc_new("mozc-jp", "Mozc", "", "ja", "", "", "", "default"));
  ibus_component_add_engine(component,
                            ibus_engine_desc_new("mozc-off", "Mozc (off)", "",
                                                 "ja", "", "", "", "default"));
  g_assert_true(ibus_bus_register_component(bus, component));

  GList *engines = ibus_bus_list_engines(bus);
  g_assert_cmpuint(g_list_length(engines), ==, 2);
  g_assert_cmpstr(ibus_engine_desc_get_name(engines->data), ==, "mozc-jp");
  g_list_free(engines);

  const gchar *wanted[] = {"mozc-off", "absent", "mozc-jp", NULL};
  IBusEngineDesc **found = ibus_bus_get_engines_by_names(bus, wanted);
  g_assert_cmpstr(ibus_engine_desc_get_name(found[0]), ==, "mozc-off");
  g_assert_cmpstr(ibus_engine_desc_get_name(found[1]), ==, "mozc-jp");
  g_assert_null(found[2]);
  g_free(found);
}

static void on_request_name(GObject *source, GAsyncResult *res, gpointer data) {
  GError *error = NULL;
  *(guint *)data =
      ibus_bus_request_name_async_finish(IBUS_BUS(source), res, &error);
  g_assert_no_error(error);
}

static void on_exit(GObject *source, GAsyncResult *res, gpointer data) {
  GError *error = NULL;
  g_assert_false(ibus_bus_exit_async_finish(IBUS_BUS(source), res, &error));
  g_assert_error(error, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED);
  g_error_free(error);
  *(gboolean *)data = TRUE;
}

/* Replies arrive once control returns to the caller's context, never from
 * inside the call. */
static void async(void) {
  guint reply = 0;
  ibus_bus_request_name_async(bus, "org.freedesktop.IBus.Async", 0, -1, NULL,
                              on_request_name, &reply);
  g_assert_cmpuint(reply, ==, 0);
  while (reply == 0)
    g_main_context_iteration(NULL, TRUE);
  g_assert_cmpuint(reply, ==, IBUS_BUS_REQUEST_NAME_REPLY_PRIMARY_OWNER);
  g_assert_cmpuint(ibus_bus_release_name(bus, "org.freedesktop.IBus.Async"), ==,
                   1);

  gboolean done = FALSE;
  g_test_expect_message("IBUS", G_LOG_LEVEL_WARNING, "*no IBus daemon*");
  ibus_bus_exit(bus, FALSE);
  g_test_assert_expected_messages();
  ibus_bus_exit_async(bus, FALSE, -1, NULL, on_exit, &done);
  while (!done)
    g_main_context_iteration(NULL, TRUE);
}

/* Each unsupported request warns the first time only. */
static void unsupported(void) {
  g_test_expect_message("IBUS", G_LOG_LEVEL_WARNING, "*GSettings*");
  g_assert_null(ibus_bus_get_config(bus));
  g_test_assert_expected_messages();
  g_assert_null(ibus_bus_get_config(bus));

  g_test_expect_message("IBUS", G_LOG_LEVEL_WARNING,
                        "*input contexts belong to the page*");
  g_assert_null(ibus_bus_create_input_context(bus, "test"));
  g_test_assert_expected_messages();

  g_test_expect_message("IBUS", G_LOG_LEVEL_WARNING,
                        "*the page chooses the engine*");
  g_assert_false(ibus_bus_set_global_engine(bus, "mozc-jp"));
  g_test_assert_expected_messages();

  /* ibus_main() returns at once rather than blocking the caller. */
  g_test_expect_message("IBUS", G_LOG_LEVEL_WARNING,
                        "*the runtime runs the main context*");
  ibus_main();
  g_test_assert_expected_messages();
  ibus_main();

  g_test_expect_message("IBUS", G_LOG_LEVEL_WARNING,
                        "*the runtime runs the main context*");
  ibus_quit();
  g_test_assert_expected_messages();
}

static void on_connected(IBusBus *self G_GNUC_UNUSED, gpointer data) {
  *(gboolean *)data = TRUE;
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  ibus_init();
  ibus_init();

  /* The first bus, made asynchronously, reports its connection later. */
  gboolean connected = FALSE;
  bus = ibus_bus_new_async();
  g_signal_connect(bus, "connected", G_CALLBACK(on_connected), &connected);
  while (!connected)
    g_main_context_iteration(NULL, TRUE);

  g_test_add_func("/bus/connection", connection);
  g_test_add_func("/bus/singleton", singleton);
  g_test_add_func("/bus/names", names);
  g_test_add_func("/bus/components", components);
  g_test_add_func("/bus/async", async);
  g_test_add_func("/bus/unsupported", unsupported);
  int status = g_test_run();
  g_object_unref(bus);
  return status;
}
