/* SPDX-FileCopyrightText: 2008-2015 Peng Huang <shawn.p.huang@gmail.com>
 * SPDX-FileCopyrightText: 2008-2015 Red Hat, Inc.
 * SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include "ibusmarshalers.h"
#include "ibusweb-private.h"
#include <errno.h>

struct _IBusFactoryPrivate {
  GHashTable *types;
  uint32_t creating_ic;
};

static IBusFactory *runtime_factory;
static guint create_engine_signal;
G_DEFINE_TYPE_WITH_PRIVATE(IBusFactory, ibus_factory, IBUS_TYPE_SERVICE)

static IBusEngine *create_engine(IBusFactory *factory, const gchar *name) {
  GType type =
      GPOINTER_TO_SIZE(g_hash_table_lookup(factory->priv->types, name));
  g_return_val_if_fail(type != G_TYPE_INVALID, NULL);
  gchar *path = g_strdup_printf("/org/freedesktop/IBus/Engine/%u",
                                factory->priv->creating_ic);
  IBusEngine *engine = ibus_engine_new_with_type(
      type, name, path, ibus_service_get_connection(IBUS_SERVICE(factory)));
  g_free(path);
  return engine;
}

static gboolean first_engine(GSignalInvocationHint *hint G_GNUC_UNUSED,
                             GValue *accumulator, const GValue *result,
                             gpointer data G_GNUC_UNUSED) {
  if (g_value_get_object(result) == NULL)
    return TRUE;
  g_value_copy(result, accumulator);
  return FALSE;
}

static void destroy(IBusObject *object) {
  IBusFactory *factory = IBUS_FACTORY(object);
  g_clear_pointer(&factory->priv->types, g_hash_table_unref);
  IBUS_OBJECT_CLASS(ibus_factory_parent_class)->destroy(object);
}

static void ibus_factory_class_init(IBusFactoryClass *klass) {
  IBUS_OBJECT_CLASS(klass)->destroy = destroy;
  klass->create_engine = create_engine;
  create_engine_signal = g_signal_new(
      "create-engine", G_TYPE_FROM_CLASS(klass), G_SIGNAL_RUN_LAST,
      G_STRUCT_OFFSET(IBusFactoryClass, create_engine), first_engine, NULL,
      _ibus_marshal_OBJECT__STRING, IBUS_TYPE_ENGINE, 1, G_TYPE_STRING);
}

static void ibus_factory_init(IBusFactory *factory) {
  factory->priv = ibus_factory_get_instance_private(factory);
  factory->priv->types =
      g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
}

IBusFactory *ibus_factory_new(GDBusConnection *connection) {
  if (runtime_factory != NULL) {
    g_critical("The runtime permits only one factory");
    return NULL;
  }
  IBusFactory *factory =
      g_object_new(IBUS_TYPE_FACTORY, "object-path", IBUS_PATH_FACTORY,
                   "connection", connection, NULL);
  /* The registry serves all input contexts for the lifetime of the runtime. */
  runtime_factory = g_object_ref(factory);
  return factory;
}

void ibus_factory_add_engine(IBusFactory *factory, const gchar *name,
                             GType type) {
  g_return_if_fail(IBUS_IS_FACTORY(factory));
  g_return_if_fail(name != NULL);
  g_return_if_fail(g_type_is_a(type, IBUS_TYPE_ENGINE));
  g_hash_table_replace(factory->priv->types, g_strdup(name),
                       GSIZE_TO_POINTER(type));
}

IBusEngine *ibusweb_factory_create(uint32_t ic, const char *name, int *error) {
  if (error != NULL)
    *error = -ESRCH;
  if (runtime_factory == NULL ||
      !g_hash_table_contains(runtime_factory->priv->types, name))
    return NULL;
  IBusEngine *engine = NULL;
  uint32_t previous_ic = runtime_factory->priv->creating_ic;
  runtime_factory->priv->creating_ic = ic;
  g_signal_emit(runtime_factory, create_engine_signal, 0, name, &engine);
  runtime_factory->priv->creating_ic = previous_ic;
  if (engine == NULL)
    return NULL;
  if (g_object_is_floating(engine))
    g_object_ref_sink(engine);
  ibusweb_engine_set_ic(engine, ic);
  if (error != NULL)
    *error = 0;
  return engine;
}
