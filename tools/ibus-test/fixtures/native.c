// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "engine.h"

int main(void) {
  ibus_init();
  conformance_engine_initialize();
  GError *error = NULL;
  GDBusConnection *connection = g_dbus_connection_new_for_address_sync(
      g_getenv("IBUS_ADDRESS"),
      G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
          G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION,
      NULL, NULL, &error);
  if (!connection)
    g_error("connect fixture: %s", error->message);
  IBusFactory *factory = g_object_ref_sink(ibus_factory_new(connection));
  ibus_factory_add_engine(factory, "conformance",
                          conformance_engine_get_type());
  GVariant *reply = g_dbus_connection_call_sync(
      connection, "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "RequestName",
      g_variant_new("(su)", "org.example.IBusConformance", 0),
      G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NONE, 1000, NULL, &error);
  if (!reply)
    g_error("own fixture name: %s", error->message);
  g_variant_unref(reply);
  GMainLoop *loop = g_main_loop_new(NULL, FALSE);
  g_main_loop_run(loop);
  g_main_loop_unref(loop);
  g_object_unref(factory);
  g_object_unref(connection);
  return 0;
}
