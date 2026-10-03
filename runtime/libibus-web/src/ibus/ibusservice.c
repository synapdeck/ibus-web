/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include <ibus.h>

struct _IBusServicePrivate {
  gchar *object_path;
  GDBusConnection *connection;
};

G_DEFINE_TYPE_WITH_PRIVATE(IBusService, ibus_service, IBUS_TYPE_OBJECT)

enum { PROP_NONE, PROP_OBJECT_PATH, PROP_CONNECTION };

static void set_property(GObject *object, guint id, const GValue *value,
                         GParamSpec *spec) {
  IBusServicePrivate *priv = IBUS_SERVICE(object)->priv;
  switch (id) {
  case PROP_OBJECT_PATH:
    g_free(priv->object_path);
    priv->object_path = g_value_dup_string(value);
    break;
  case PROP_CONNECTION:
    g_set_object(&priv->connection, g_value_get_object(value));
    break;
  default:
    G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
  }
}

static void get_property(GObject *object, guint id, GValue *value,
                         GParamSpec *spec) {
  IBusServicePrivate *priv = IBUS_SERVICE(object)->priv;
  switch (id) {
  case PROP_OBJECT_PATH:
    g_value_set_string(value, priv->object_path);
    break;
  case PROP_CONNECTION:
    g_value_set_object(value, priv->connection);
    break;
  default:
    G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
  }
}

static void destroy(IBusObject *object) {
  IBusServicePrivate *priv = IBUS_SERVICE(object)->priv;
  g_clear_pointer(&priv->object_path, g_free);
  g_clear_object(&priv->connection);
  IBUS_OBJECT_CLASS(ibus_service_parent_class)->destroy(object);
}

static void ibus_service_class_init(IBusServiceClass *klass) {
  GObjectClass *object_class = G_OBJECT_CLASS(klass);
  object_class->set_property = set_property;
  object_class->get_property = get_property;
  IBUS_OBJECT_CLASS(klass)->destroy = destroy;
  g_object_class_install_property(
      object_class, PROP_OBJECT_PATH,
      g_param_spec_string("object-path", "Object path", "Object path", NULL,
                          G_PARAM_READWRITE | G_PARAM_CONSTRUCT_ONLY |
                              G_PARAM_STATIC_STRINGS));
  g_object_class_install_property(
      object_class, PROP_CONNECTION,
      g_param_spec_object(
          "connection", "Connection", "Connection", G_TYPE_DBUS_CONNECTION,
          G_PARAM_READWRITE | G_PARAM_CONSTRUCT_ONLY | G_PARAM_STATIC_STRINGS));
}

static void ibus_service_init(IBusService *service) {
  service->priv = ibus_service_get_instance_private(service);
}

IBusService *ibus_service_new(GDBusConnection *connection, const gchar *path) {
  return g_object_new(IBUS_TYPE_SERVICE, "connection", connection,
                      "object-path", path, NULL);
}

const gchar *ibus_service_get_object_path(IBusService *service) {
  g_return_val_if_fail(IBUS_IS_SERVICE(service), NULL);
  return service->priv->object_path;
}

GDBusConnection *ibus_service_get_connection(IBusService *service) {
  g_return_val_if_fail(IBUS_IS_SERVICE(service), NULL);
  return service->priv->connection;
}
