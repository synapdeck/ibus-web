/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

/* The bus an engine module sees: there is no daemon or D-Bus connection, so
 * the module is the bus's only client. Name ownership, component
 * registration and engine listing work against that one client's state, as
 * the daemon would answer them for it; requests that only the daemon or an
 * application could act on warn once and fail. */

#include "ibusmarshalers.h"
#include <ibus.h>

#define UNIQUE_NAME ":1.1"
#define DBUS_SERVICE_DBUS "org.freedesktop.DBus"

enum {
  CONNECTED,
  DISCONNECTED,
  GLOBAL_ENGINE_CHANGED,
  NAME_OWNER_CHANGED,
  GLOBAL_SHORTCUT_KEY_RESPONDED,
  LAST_SIGNAL,
};

enum { PROP_0, PROP_CONNECT_ASYNC, PROP_CLIENT_ONLY };

struct _IBusBusPrivate {
  GMutex lock;
  GHashTable *names;
  GPtrArray *components;
  gboolean connect_async;
  gboolean client_only;
  gboolean watch_dbus_signal;
  gboolean watch_ibus_signal;
};

static guint bus_signals[LAST_SIGNAL];

G_LOCK_DEFINE_STATIC(singleton);
static IBusBus *singleton;

G_DEFINE_TYPE_WITH_PRIVATE(IBusBus, ibus_bus, IBUS_TYPE_OBJECT)

#define UNSUPPORTED(reason)                                                    \
  G_STMT_START {                                                               \
    static gsize warned = 0;                                                   \
    if (g_once_init_enter(&warned)) {                                          \
      g_warning("%s: %s", G_STRFUNC, reason);                                  \
      g_once_init_leave(&warned, 1);                                           \
    }                                                                          \
  }                                                                            \
  G_STMT_END

#define NO_DAEMON "ibus-web has no IBus daemon"

static gboolean is_daemon_name(const gchar *name) {
  return g_strcmp0(name, IBUS_SERVICE_IBUS) == 0 ||
         g_strcmp0(name, DBUS_SERVICE_DBUS) == 0;
}

static gboolean emit_connected(gpointer data) {
  g_signal_emit(data, bus_signals[CONNECTED], 0);
  return G_SOURCE_REMOVE;
}

/* Upstream shares one bus object across the whole process. */
static GObject *constructor(GType type, guint n_params,
                            GObjectConstructParam *params) {
  G_LOCK(singleton);
  if (singleton != NULL) {
    GObject *object = g_object_ref(G_OBJECT(singleton));
    G_UNLOCK(singleton);
    return object;
  }

  GObject *object = G_OBJECT_CLASS(ibus_bus_parent_class)
                        ->constructor(type, n_params, params);
  g_object_ref_sink(object);
  singleton = IBUS_BUS(object);
  G_UNLOCK(singleton);

  /* An asynchronous connection reports itself once the caller has had a
   * chance to connect to the signal, on the context it was made from. */
  if (singleton->priv->connect_async) {
    GMainContext *context = g_main_context_ref_thread_default();
    GSource *source = g_idle_source_new();
    g_source_set_callback(source, emit_connected, g_object_ref(object),
                          g_object_unref);
    g_source_attach(source, context);
    g_source_unref(source);
    g_main_context_unref(context);
  }

  return object;
}

static void set_property(GObject *object, guint id, const GValue *value,
                         GParamSpec *spec) {
  IBusBusPrivate *priv = IBUS_BUS(object)->priv;
  switch (id) {
  case PROP_CONNECT_ASYNC:
    priv->connect_async = g_value_get_boolean(value);
    break;
  case PROP_CLIENT_ONLY:
    priv->client_only = g_value_get_boolean(value);
    break;
  default:
    G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
  }
}

static void get_property(GObject *object, guint id, GValue *value,
                         GParamSpec *spec) {
  IBusBusPrivate *priv = IBUS_BUS(object)->priv;
  switch (id) {
  case PROP_CONNECT_ASYNC:
    g_value_set_boolean(value, priv->connect_async);
    break;
  case PROP_CLIENT_ONLY:
    g_value_set_boolean(value, priv->client_only);
    break;
  default:
    G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
  }
}

static void destroy(IBusObject *object) {
  IBusBus *bus = IBUS_BUS(object);

  G_LOCK(singleton);
  if (singleton == bus)
    singleton = NULL;
  G_UNLOCK(singleton);

  g_clear_pointer(&bus->priv->names, g_hash_table_unref);
  g_clear_pointer(&bus->priv->components, g_ptr_array_unref);
  IBUS_OBJECT_CLASS(ibus_bus_parent_class)->destroy(object);
}

static void finalize(GObject *object) {
  g_mutex_clear(&IBUS_BUS(object)->priv->lock);
  G_OBJECT_CLASS(ibus_bus_parent_class)->finalize(object);
}

static void ibus_bus_class_init(IBusBusClass *klass) {
  GObjectClass *object_class = G_OBJECT_CLASS(klass);
  object_class->constructor = constructor;
  object_class->set_property = set_property;
  object_class->get_property = get_property;
  object_class->finalize = finalize;
  IBUS_OBJECT_CLASS(klass)->destroy = destroy;

  g_object_class_install_property(
      object_class, PROP_CONNECT_ASYNC,
      g_param_spec_boolean("connect-async", "Connect Async",
                           "Connect asynchronously to the bus", FALSE,
                           G_PARAM_READWRITE | G_PARAM_CONSTRUCT_ONLY |
                               G_PARAM_STATIC_STRINGS));
  g_object_class_install_property(
      object_class, PROP_CLIENT_ONLY,
      g_param_spec_boolean(
          "client-only", "ClientOnly", "Client use only", FALSE,
          G_PARAM_READWRITE | G_PARAM_CONSTRUCT_ONLY | G_PARAM_STATIC_STRINGS));

  bus_signals[CONNECTED] =
      g_signal_new("connected", G_TYPE_FROM_CLASS(klass), G_SIGNAL_RUN_LAST, 0,
                   NULL, NULL, _ibus_marshal_VOID__VOID, G_TYPE_NONE, 0);
  bus_signals[DISCONNECTED] =
      g_signal_new("disconnected", G_TYPE_FROM_CLASS(klass), G_SIGNAL_RUN_LAST,
                   0, NULL, NULL, _ibus_marshal_VOID__VOID, G_TYPE_NONE, 0);
  bus_signals[GLOBAL_ENGINE_CHANGED] = g_signal_new(
      "global-engine-changed", G_TYPE_FROM_CLASS(klass), G_SIGNAL_RUN_LAST, 0,
      NULL, NULL, _ibus_marshal_VOID__STRING, G_TYPE_NONE, 1, G_TYPE_STRING);
  bus_signals[NAME_OWNER_CHANGED] = g_signal_new(
      "name-owner-changed", G_TYPE_FROM_CLASS(klass), G_SIGNAL_RUN_LAST, 0,
      NULL, NULL, _ibus_marshal_VOID__STRING_STRING_STRING, G_TYPE_NONE, 3,
      G_TYPE_STRING, G_TYPE_STRING, G_TYPE_STRING);
  bus_signals[GLOBAL_SHORTCUT_KEY_RESPONDED] = g_signal_new(
      "global-shortcut-key-responded", G_TYPE_FROM_CLASS(klass),
      G_SIGNAL_RUN_LAST, 0, NULL, NULL,
      _ibus_marshal_VOID__UCHAR_UINT_UINT_UINT_BOOLEAN, G_TYPE_NONE, 5,
      G_TYPE_UCHAR, G_TYPE_UINT, G_TYPE_UINT, G_TYPE_UINT, G_TYPE_BOOLEAN);
}

static void ibus_bus_init(IBusBus *bus) {
  bus->priv = ibus_bus_get_instance_private(bus);
  g_mutex_init(&bus->priv->lock);
  bus->priv->names =
      g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
  bus->priv->components = g_ptr_array_new_with_free_func(g_object_unref);
}

IBusBus *ibus_bus_new(void) { return g_object_new(IBUS_TYPE_BUS, NULL); }

IBusBus *ibus_bus_new_async(void) {
  return g_object_new(IBUS_TYPE_BUS, "connect-async", TRUE, NULL);
}

IBusBus *ibus_bus_new_async_client(void) {
  return g_object_new(IBUS_TYPE_BUS, "connect-async", TRUE, "client-only", TRUE,
                      NULL);
}

gboolean ibus_bus_is_connected(IBusBus *bus) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), FALSE);
  return TRUE;
}

/* Local services take a NULL connection. */
GDBusConnection *ibus_bus_get_connection(IBusBus *bus) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);
  return NULL;
}

const gchar *ibus_bus_get_service_name(IBusBus *bus) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);
  return IBUS_SERVICE_IBUS;
}

const gchar *ibus_bus_hello(IBusBus *bus) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);
  return UNIQUE_NAME;
}

static void name_owner_changed(IBusBus *bus, const gchar *name,
                               const gchar *old_owner, const gchar *new_owner) {
  if (bus->priv->watch_dbus_signal)
    g_signal_emit(bus, bus_signals[NAME_OWNER_CHANGED], 0, name, old_owner,
                  new_owner);
}

/* Names the daemon owns can't be taken: it never allows replacement, and a
 * queue for them would never advance. */
guint32 ibus_bus_request_name(IBusBus *bus, const gchar *name,
                              guint32 flags G_GNUC_UNUSED) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), 0);
  g_return_val_if_fail(name != NULL && name[0] != ':', 0);

  if (is_daemon_name(name))
    return IBUS_BUS_REQUEST_NAME_REPLY_EXISTS;

  g_mutex_lock(&bus->priv->lock);
  gboolean owned = g_hash_table_contains(bus->priv->names, name);
  if (!owned)
    g_hash_table_add(bus->priv->names, g_strdup(name));
  g_mutex_unlock(&bus->priv->lock);

  if (owned)
    return IBUS_BUS_REQUEST_NAME_REPLY_ALREADY_OWNER;

  name_owner_changed(bus, name, "", UNIQUE_NAME);
  return IBUS_BUS_REQUEST_NAME_REPLY_PRIMARY_OWNER;
}

/* D-Bus's ReleaseName replies: released, no owner, owned by another. */
guint ibus_bus_release_name(IBusBus *bus, const gchar *name) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), 0);
  g_return_val_if_fail(name != NULL, 0);

  if (is_daemon_name(name))
    return 3;

  g_mutex_lock(&bus->priv->lock);
  gboolean owned = g_hash_table_remove(bus->priv->names, name);
  g_mutex_unlock(&bus->priv->lock);

  if (!owned)
    return 2;

  name_owner_changed(bus, name, UNIQUE_NAME, "");
  return 1;
}

static gchar *name_owner(IBusBus *bus, const gchar *name) {
  if (is_daemon_name(name))
    return g_strdup(name);
  if (g_strcmp0(name, UNIQUE_NAME) == 0)
    return g_strdup(UNIQUE_NAME);

  g_mutex_lock(&bus->priv->lock);
  gboolean owned = g_hash_table_contains(bus->priv->names, name);
  g_mutex_unlock(&bus->priv->lock);
  return owned ? g_strdup(UNIQUE_NAME) : NULL;
}

GList *ibus_bus_list_queued_owners(IBusBus *bus, const gchar *name) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);
  g_return_val_if_fail(name != NULL, NULL);

  gchar *owner = name_owner(bus, name);
  return owner != NULL ? g_list_append(NULL, owner) : NULL;
}

gboolean ibus_bus_name_has_owner(IBusBus *bus, const gchar *name) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), FALSE);
  g_return_val_if_fail(name != NULL, FALSE);

  gchar *owner = name_owner(bus, name);
  g_free(owner);
  return owner != NULL;
}

gchar *ibus_bus_get_name_owner(IBusBus *bus, const gchar *name) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);
  g_return_val_if_fail(name != NULL, NULL);
  return name_owner(bus, name);
}

GList *ibus_bus_list_names(IBusBus *bus) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);

  GList *names = NULL;
  names = g_list_append(names, g_strdup(DBUS_SERVICE_DBUS));
  names = g_list_append(names, g_strdup(IBUS_SERVICE_IBUS));
  names = g_list_append(names, g_strdup(UNIQUE_NAME));

  g_mutex_lock(&bus->priv->lock);
  GHashTableIter iter;
  gpointer name;
  g_hash_table_iter_init(&iter, bus->priv->names);
  while (g_hash_table_iter_next(&iter, &name, NULL))
    names = g_list_append(names, g_strdup(name));
  g_mutex_unlock(&bus->priv->lock);

  return names;
}

/* With no connection, no message reaches a match rule to be filtered. */
gboolean ibus_bus_add_match(IBusBus *bus, const gchar *rule) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), FALSE);
  g_return_val_if_fail(rule != NULL, FALSE);
  return TRUE;
}

gboolean ibus_bus_remove_match(IBusBus *bus, const gchar *rule) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), FALSE);
  g_return_val_if_fail(rule != NULL, FALSE);
  return TRUE;
}

gboolean ibus_bus_exit(IBusBus *bus, gboolean restart G_GNUC_UNUSED) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), FALSE);
  UNSUPPORTED(NO_DAEMON);
  return FALSE;
}

IBusInputContext *
ibus_bus_create_input_context(IBusBus *bus,
                              const gchar *client_name G_GNUC_UNUSED) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);
  UNSUPPORTED("input contexts belong to the page");
  return NULL;
}

gchar *ibus_bus_current_input_context(IBusBus *bus) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);
  UNSUPPORTED("input contexts belong to the page");
  return NULL;
}

gboolean ibus_bus_register_component(IBusBus *bus, IBusComponent *component) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), FALSE);
  g_return_val_if_fail(IBUS_IS_COMPONENT(component), FALSE);

  g_mutex_lock(&bus->priv->lock);
  g_ptr_array_add(bus->priv->components, g_object_ref_sink(component));
  g_mutex_unlock(&bus->priv->lock);
  return TRUE;
}

/* The registered components' descriptions, which outlive the list. */
GList *ibus_bus_list_engines(IBusBus *bus) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);

  GList *engines = NULL;
  g_mutex_lock(&bus->priv->lock);
  for (guint i = 0; i < bus->priv->components->len; i++)
    engines = g_list_concat(engines,
                            ibus_component_get_engines(
                                g_ptr_array_index(bus->priv->components, i)));
  g_mutex_unlock(&bus->priv->lock);
  return engines;
}

GList *ibus_bus_list_active_engines(IBusBus *bus) {
  return ibus_bus_list_engines(bus);
}

IBusEngineDesc **ibus_bus_get_engines_by_names(IBusBus *bus,
                                               const gchar *const *names) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);
  if (names == NULL)
    return NULL;

  GList *engines = ibus_bus_list_engines(bus);
  GPtrArray *found = g_ptr_array_new();
  for (const gchar *const *name = names; *name != NULL; name++) {
    for (GList *e = engines; e != NULL; e = e->next) {
      if (g_strcmp0(ibus_engine_desc_get_name(e->data), *name) == 0) {
        g_ptr_array_add(found, e->data);
        break;
      }
    }
  }
  g_list_free(engines);
  g_ptr_array_add(found, NULL);
  return (IBusEngineDesc **)g_ptr_array_free(found, FALSE);
}

gboolean ibus_bus_get_use_sys_layout(IBusBus *bus) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), FALSE);
  UNSUPPORTED(NO_DAEMON);
  return FALSE;
}

gboolean ibus_bus_get_use_global_engine(IBusBus *bus) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), FALSE);
  UNSUPPORTED(NO_DAEMON);
  return FALSE;
}

gboolean ibus_bus_is_global_engine_enabled(IBusBus *bus) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), FALSE);
  UNSUPPORTED(NO_DAEMON);
  return FALSE;
}

IBusEngineDesc *ibus_bus_get_global_engine(IBusBus *bus) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);
  UNSUPPORTED("the page chooses the engine");
  return NULL;
}

gboolean ibus_bus_set_global_engine(IBusBus *bus,
                                    const gchar *global_engine G_GNUC_UNUSED) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), FALSE);
  UNSUPPORTED("the page chooses the engine");
  return FALSE;
}

void ibus_bus_set_watch_dbus_signal(IBusBus *bus, gboolean watch) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  bus->priv->watch_dbus_signal = watch;
}

/* The daemon's own signal, global-engine-changed, is never sent. */
void ibus_bus_set_watch_ibus_signal(IBusBus *bus, gboolean watch) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  bus->priv->watch_ibus_signal = watch;
}

IBusConfig *ibus_bus_get_config(IBusBus *bus) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);
  UNSUPPORTED("settings come from GSettings");
  return NULL;
}

gboolean ibus_bus_preload_engines(IBusBus *bus,
                                  const gchar *const *names G_GNUC_UNUSED) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), FALSE);
  UNSUPPORTED(NO_DAEMON);
  return FALSE;
}

gboolean ibus_bus_set_global_shortcut_keys(
    IBusBus *bus, IBusBusGlobalBindingType gtype G_GNUC_UNUSED,
    const IBusProcessKeyEventData *keys G_GNUC_UNUSED) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), FALSE);
  UNSUPPORTED(NO_DAEMON);
  return FALSE;
}

GVariant *ibus_bus_get_ibus_property(IBusBus *bus,
                                     const gchar *property_name G_GNUC_UNUSED) {
  g_return_val_if_fail(IBUS_IS_BUS(bus), NULL);
  UNSUPPORTED(NO_DAEMON);
  return NULL;
}

void ibus_bus_set_ibus_property(IBusBus *bus,
                                const gchar *property_name G_GNUC_UNUSED,
                                GVariant *value G_GNUC_UNUSED) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  UNSUPPORTED(NO_DAEMON);
}

/* Asynchronous forms: each answers as its synchronous form does, on the
 * caller's context once control returns to it, as a reply would arrive. */

static GTask *task_new(IBusBus *bus, GCancellable *cancellable,
                       GAsyncReadyCallback callback, gpointer user_data,
                       gpointer source_tag) {
  GTask *task = g_task_new(bus, cancellable, callback, user_data);
  g_task_set_source_tag(task, source_tag);
  return task;
}

static void return_unsupported(GTask *task, const gchar *reason) {
  g_task_return_new_error(task, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED, "%s",
                          reason);
  g_object_unref(task);
}

static void return_boolean(GTask *task, gboolean value) {
  g_task_return_boolean(task, value);
  g_object_unref(task);
}

static void return_int(GTask *task, gssize value) {
  g_task_return_int(task, value);
  g_object_unref(task);
}

static void return_pointer(GTask *task, gpointer value, GDestroyNotify free) {
  g_task_return_pointer(task, value, free);
  g_object_unref(task);
}

static gboolean finish_boolean(IBusBus *bus, GAsyncResult *res,
                               gpointer source_tag, GError **error) {
  g_return_val_if_fail(g_task_is_valid(res, bus), FALSE);
  g_return_val_if_fail(g_task_get_source_tag(G_TASK(res)) == source_tag, FALSE);
  return g_task_propagate_boolean(G_TASK(res), error);
}

static guint finish_uint(IBusBus *bus, GAsyncResult *res, gpointer source_tag,
                         GError **error) {
  g_return_val_if_fail(g_task_is_valid(res, bus), 0);
  g_return_val_if_fail(g_task_get_source_tag(G_TASK(res)) == source_tag, 0);
  gssize value = g_task_propagate_int(G_TASK(res), error);
  return value < 0 ? 0 : (guint)value;
}

static gpointer finish_pointer(IBusBus *bus, GAsyncResult *res,
                               gpointer source_tag, GError **error) {
  g_return_val_if_fail(g_task_is_valid(res, bus), NULL);
  g_return_val_if_fail(g_task_get_source_tag(G_TASK(res)) == source_tag, NULL);
  return g_task_propagate_pointer(G_TASK(res), error);
}

static void free_list(gpointer list) { g_list_free(list); }

void ibus_bus_request_name_async(IBusBus *bus, const gchar *name, guint flags,
                                 gint timeout_msec G_GNUC_UNUSED,
                                 GCancellable *cancellable,
                                 GAsyncReadyCallback callback,
                                 gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  GTask *task = task_new(bus, cancellable, callback, user_data,
                         ibus_bus_request_name_async);
  return_int(task, ibus_bus_request_name(bus, name, flags));
}

guint ibus_bus_request_name_async_finish(IBusBus *bus, GAsyncResult *res,
                                         GError **error) {
  return finish_uint(bus, res, ibus_bus_request_name_async, error);
}

void ibus_bus_release_name_async(IBusBus *bus, const gchar *name,
                                 gint timeout_msec G_GNUC_UNUSED,
                                 GCancellable *cancellable,
                                 GAsyncReadyCallback callback,
                                 gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  GTask *task = task_new(bus, cancellable, callback, user_data,
                         ibus_bus_release_name_async);
  return_int(task, ibus_bus_release_name(bus, name));
}

guint ibus_bus_release_name_async_finish(IBusBus *bus, GAsyncResult *res,
                                         GError **error) {
  return finish_uint(bus, res, ibus_bus_release_name_async, error);
}

void ibus_bus_name_has_owner_async(IBusBus *bus, const gchar *name,
                                   gint timeout_msec G_GNUC_UNUSED,
                                   GCancellable *cancellable,
                                   GAsyncReadyCallback callback,
                                   gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  GTask *task = task_new(bus, cancellable, callback, user_data,
                         ibus_bus_name_has_owner_async);
  return_boolean(task, ibus_bus_name_has_owner(bus, name));
}

gboolean ibus_bus_name_has_owner_async_finish(IBusBus *bus, GAsyncResult *res,
                                              GError **error) {
  return finish_boolean(bus, res, ibus_bus_name_has_owner_async, error);
}

void ibus_bus_add_match_async(IBusBus *bus, const gchar *rule,
                              gint timeout_msec G_GNUC_UNUSED,
                              GCancellable *cancellable,
                              GAsyncReadyCallback callback,
                              gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  GTask *task =
      task_new(bus, cancellable, callback, user_data, ibus_bus_add_match_async);
  return_boolean(task, ibus_bus_add_match(bus, rule));
}

gboolean ibus_bus_add_match_async_finish(IBusBus *bus, GAsyncResult *res,
                                         GError **error) {
  return finish_boolean(bus, res, ibus_bus_add_match_async, error);
}

void ibus_bus_remove_match_async(IBusBus *bus, const gchar *rule,
                                 gint timeout_msec G_GNUC_UNUSED,
                                 GCancellable *cancellable,
                                 GAsyncReadyCallback callback,
                                 gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  GTask *task = task_new(bus, cancellable, callback, user_data,
                         ibus_bus_remove_match_async);
  return_boolean(task, ibus_bus_remove_match(bus, rule));
}

gboolean ibus_bus_remove_match_async_finish(IBusBus *bus, GAsyncResult *res,
                                            GError **error) {
  return finish_boolean(bus, res, ibus_bus_remove_match_async, error);
}

void ibus_bus_get_name_owner_async(IBusBus *bus, const gchar *name,
                                   gint timeout_msec G_GNUC_UNUSED,
                                   GCancellable *cancellable,
                                   GAsyncReadyCallback callback,
                                   gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  GTask *task = task_new(bus, cancellable, callback, user_data,
                         ibus_bus_get_name_owner_async);
  return_pointer(task, ibus_bus_get_name_owner(bus, name), g_free);
}

gchar *ibus_bus_get_name_owner_async_finish(IBusBus *bus, GAsyncResult *res,
                                            GError **error) {
  return finish_pointer(bus, res, ibus_bus_get_name_owner_async, error);
}

void ibus_bus_exit_async(IBusBus *bus, gboolean restart G_GNUC_UNUSED,
                         gint timeout_msec G_GNUC_UNUSED,
                         GCancellable *cancellable,
                         GAsyncReadyCallback callback, gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  return_unsupported(
      task_new(bus, cancellable, callback, user_data, ibus_bus_exit_async),
      NO_DAEMON);
}

gboolean ibus_bus_exit_async_finish(IBusBus *bus, GAsyncResult *res,
                                    GError **error) {
  return finish_boolean(bus, res, ibus_bus_exit_async, error);
}

void ibus_bus_create_input_context_async(IBusBus *bus,
                                         const gchar *client_name G_GNUC_UNUSED,
                                         gint timeout_msec G_GNUC_UNUSED,
                                         GCancellable *cancellable,
                                         GAsyncReadyCallback callback,
                                         gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  return_unsupported(task_new(bus, cancellable, callback, user_data,
                              ibus_bus_create_input_context_async),
                     "input contexts belong to the page");
}

IBusInputContext *ibus_bus_create_input_context_async_finish(IBusBus *bus,
                                                             GAsyncResult *res,
                                                             GError **error) {
  return finish_pointer(bus, res, ibus_bus_create_input_context_async, error);
}

void ibus_bus_current_input_context_async(IBusBus *bus,
                                          gint timeout_msec G_GNUC_UNUSED,
                                          GCancellable *cancellable,
                                          GAsyncReadyCallback callback,
                                          gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  return_unsupported(task_new(bus, cancellable, callback, user_data,
                              ibus_bus_current_input_context_async),
                     "input contexts belong to the page");
}

gchar *ibus_bus_current_input_context_async_finish(IBusBus *bus,
                                                   GAsyncResult *res,
                                                   GError **error) {
  return finish_pointer(bus, res, ibus_bus_current_input_context_async, error);
}

void ibus_bus_register_component_async(IBusBus *bus, IBusComponent *component,
                                       gint timeout_msec G_GNUC_UNUSED,
                                       GCancellable *cancellable,
                                       GAsyncReadyCallback callback,
                                       gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  GTask *task = task_new(bus, cancellable, callback, user_data,
                         ibus_bus_register_component_async);
  return_boolean(task, ibus_bus_register_component(bus, component));
}

gboolean ibus_bus_register_component_async_finish(IBusBus *bus,
                                                  GAsyncResult *res,
                                                  GError **error) {
  return finish_boolean(bus, res, ibus_bus_register_component_async, error);
}

void ibus_bus_list_engines_async(IBusBus *bus, gint timeout_msec G_GNUC_UNUSED,
                                 GCancellable *cancellable,
                                 GAsyncReadyCallback callback,
                                 gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  GTask *task = task_new(bus, cancellable, callback, user_data,
                         ibus_bus_list_engines_async);
  return_pointer(task, ibus_bus_list_engines(bus), free_list);
}

GList *ibus_bus_list_engines_async_finish(IBusBus *bus, GAsyncResult *res,
                                          GError **error) {
  return finish_pointer(bus, res, ibus_bus_list_engines_async, error);
}

void ibus_bus_list_active_engines_async(IBusBus *bus,
                                        gint timeout_msec G_GNUC_UNUSED,
                                        GCancellable *cancellable,
                                        GAsyncReadyCallback callback,
                                        gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  GTask *task = task_new(bus, cancellable, callback, user_data,
                         ibus_bus_list_active_engines_async);
  return_pointer(task, ibus_bus_list_engines(bus), free_list);
}

GList *ibus_bus_list_active_engines_async_finish(IBusBus *bus,
                                                 GAsyncResult *res,
                                                 GError **error) {
  return finish_pointer(bus, res, ibus_bus_list_active_engines_async, error);
}

void ibus_bus_get_use_sys_layout_async(IBusBus *bus,
                                       gint timeout_msec G_GNUC_UNUSED,
                                       GCancellable *cancellable,
                                       GAsyncReadyCallback callback,
                                       gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  return_unsupported(task_new(bus, cancellable, callback, user_data,
                              ibus_bus_get_use_sys_layout_async),
                     NO_DAEMON);
}

gboolean ibus_bus_get_use_sys_layout_async_finish(IBusBus *bus,
                                                  GAsyncResult *res,
                                                  GError **error) {
  return finish_boolean(bus, res, ibus_bus_get_use_sys_layout_async, error);
}

void ibus_bus_get_use_global_engine_async(IBusBus *bus,
                                          gint timeout_msec G_GNUC_UNUSED,
                                          GCancellable *cancellable,
                                          GAsyncReadyCallback callback,
                                          gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  return_unsupported(task_new(bus, cancellable, callback, user_data,
                              ibus_bus_get_use_global_engine_async),
                     NO_DAEMON);
}

gboolean ibus_bus_get_use_global_engine_async_finish(IBusBus *bus,
                                                     GAsyncResult *res,
                                                     GError **error) {
  return finish_boolean(bus, res, ibus_bus_get_use_global_engine_async, error);
}

void ibus_bus_is_global_engine_enabled_async(IBusBus *bus,
                                             gint timeout_msec G_GNUC_UNUSED,
                                             GCancellable *cancellable,
                                             GAsyncReadyCallback callback,
                                             gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  return_unsupported(task_new(bus, cancellable, callback, user_data,
                              ibus_bus_is_global_engine_enabled_async),
                     NO_DAEMON);
}

gboolean ibus_bus_is_global_engine_enabled_async_finish(IBusBus *bus,
                                                        GAsyncResult *res,
                                                        GError **error) {
  return finish_boolean(bus, res, ibus_bus_is_global_engine_enabled_async,
                        error);
}

void ibus_bus_get_global_engine_async(IBusBus *bus,
                                      gint timeout_msec G_GNUC_UNUSED,
                                      GCancellable *cancellable,
                                      GAsyncReadyCallback callback,
                                      gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  return_unsupported(task_new(bus, cancellable, callback, user_data,
                              ibus_bus_get_global_engine_async),
                     "the page chooses the engine");
}

IBusEngineDesc *ibus_bus_get_global_engine_async_finish(IBusBus *bus,
                                                        GAsyncResult *res,
                                                        GError **error) {
  return finish_pointer(bus, res, ibus_bus_get_global_engine_async, error);
}

void ibus_bus_set_global_engine_async(IBusBus *bus,
                                      const gchar *global_engine G_GNUC_UNUSED,
                                      gint timeout_msec G_GNUC_UNUSED,
                                      GCancellable *cancellable,
                                      GAsyncReadyCallback callback,
                                      gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  return_unsupported(task_new(bus, cancellable, callback, user_data,
                              ibus_bus_set_global_engine_async),
                     "the page chooses the engine");
}

gboolean ibus_bus_set_global_engine_async_finish(IBusBus *bus,
                                                 GAsyncResult *res,
                                                 GError **error) {
  return finish_boolean(bus, res, ibus_bus_set_global_engine_async, error);
}

void ibus_bus_preload_engines_async(IBusBus *bus,
                                    const gchar *const *names G_GNUC_UNUSED,
                                    gint timeout_msec G_GNUC_UNUSED,
                                    GCancellable *cancellable,
                                    GAsyncReadyCallback callback,
                                    gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  return_unsupported(task_new(bus, cancellable, callback, user_data,
                              ibus_bus_preload_engines_async),
                     NO_DAEMON);
}

gboolean ibus_bus_preload_engines_async_finish(IBusBus *bus, GAsyncResult *res,
                                               GError **error) {
  return finish_boolean(bus, res, ibus_bus_preload_engines_async, error);
}

void ibus_bus_set_global_shortcut_keys_async(
    IBusBus *bus, IBusBusGlobalBindingType gtype G_GNUC_UNUSED,
    const IBusProcessKeyEventData *keys G_GNUC_UNUSED,
    gint timeout_msec G_GNUC_UNUSED, GCancellable *cancellable,
    GAsyncReadyCallback callback, gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  return_unsupported(task_new(bus, cancellable, callback, user_data,
                              ibus_bus_set_global_shortcut_keys_async),
                     NO_DAEMON);
}

gboolean ibus_bus_set_global_shortcut_keys_async_finish(IBusBus *bus,
                                                        GAsyncResult *res,
                                                        GError **error) {
  return finish_boolean(bus, res, ibus_bus_set_global_shortcut_keys_async,
                        error);
}

void ibus_bus_get_ibus_property_async(IBusBus *bus,
                                      const gchar *property_name G_GNUC_UNUSED,
                                      gint timeout_msec G_GNUC_UNUSED,
                                      GCancellable *cancellable,
                                      GAsyncReadyCallback callback,
                                      gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  return_unsupported(task_new(bus, cancellable, callback, user_data,
                              ibus_bus_get_ibus_property_async),
                     NO_DAEMON);
}

GVariant *ibus_bus_get_ibus_property_async_finish(IBusBus *bus,
                                                  GAsyncResult *res,
                                                  GError **error) {
  return finish_pointer(bus, res, ibus_bus_get_ibus_property_async, error);
}

void ibus_bus_set_ibus_property_async(IBusBus *bus,
                                      const gchar *property_name G_GNUC_UNUSED,
                                      GVariant *value G_GNUC_UNUSED,
                                      gint timeout_msec G_GNUC_UNUSED,
                                      GCancellable *cancellable,
                                      GAsyncReadyCallback callback,
                                      gpointer user_data) {
  g_return_if_fail(IBUS_IS_BUS(bus));
  return_unsupported(task_new(bus, cancellable, callback, user_data,
                              ibus_bus_set_ibus_property_async),
                     NO_DAEMON);
}

gboolean ibus_bus_set_ibus_property_async_finish(IBusBus *bus,
                                                 GAsyncResult *res,
                                                 GError **error) {
  return finish_boolean(bus, res, ibus_bus_set_ibus_property_async, error);
}
