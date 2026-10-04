// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "driver.h"

#define ENGINE "org.freedesktop.IBus.Engine"
#define BUS "org.freedesktop.DBus"

typedef struct {
  GDBusConnection *connection;
  GDBusConnection *observer;
  GAsyncQueue *incoming;
  GHashTable *contexts;
  GHashTable *paths;
  GQueue events;
  const char *owner;
  const char *request_name;
  guint step;
  gint timeout_ms;
  gboolean creating;
  GQueue early;
} Driver;

typedef struct {
  char *context;
  char *name;
} Event;

typedef struct {
  GAsyncQueue *incoming;
  char *request_name;
} BusErrorCapture;

static void event_free(gpointer data) {
  Event *event = data;
  g_free(event->context);
  g_free(event->name);
  g_free(event);
}

static gboolean fail(GError **error, const char *message) {
  g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED, message);
  return FALSE;
}

static void emit(Driver *driver, JsonObject *object, const char *kind) {
  json_object_set_string_member(object, "kind", kind);
  json_object_set_int_member(object, "step", driver->step);
  JsonNode *node = json_node_new(JSON_NODE_OBJECT);
  json_node_take_object(node, object);
  ibus_test_write(node);
  json_node_free(node);
}

/* Calls use the request connection. The observer receives signals and the
 * request's replies through one bus dispatch queue, before GDBus can schedule
 * separate signal/reply callbacks on the main context. */
static GDBusMessage *receive(GDBusConnection *connection, GDBusMessage *message,
                             gboolean incoming, gpointer data) {
  (void)connection;
  if (incoming)
    g_async_queue_push(data, g_object_ref(message));
  return message;
}

/* Policy errors are delivered to the request connection even when the bus
 * does not copy them to the observing connection. Keep them in the same queue
 * as the observer's ordered engine traffic. */
static GDBusMessage *receive_bus_error(GDBusConnection *connection,
                                       GDBusMessage *message, gboolean incoming,
                                       gpointer data) {
  (void)connection;
  BusErrorCapture *capture = data;
  if (incoming &&
      g_dbus_message_get_message_type(message) == G_DBUS_MESSAGE_TYPE_ERROR &&
      g_strcmp0(g_dbus_message_get_sender(message), BUS) == 0 &&
      g_strcmp0(g_dbus_message_get_destination(message),
                capture->request_name) == 0)
    g_async_queue_push(capture->incoming, g_object_ref(message));
  return message;
}

static void bus_error_capture_free(gpointer data) {
  BusErrorCapture *capture = data;
  g_async_queue_unref(capture->incoming);
  g_free(capture->request_name);
  g_free(capture);
}

static gboolean signal_message(Driver *driver, GDBusMessage *message,
                               GError **error) {
  const char *interface = g_dbus_message_get_interface(message);
  if (g_strcmp0(interface, BUS) == 0 &&
      g_strcmp0(g_dbus_message_get_member(message), "NameOwnerChanged") == 0) {
    const char *name, *old, *owner;
    g_variant_get(g_dbus_message_get_body(message), "(&s&s&s)", &name, &old,
                  &owner);
    if (g_str_equal(name, driver->owner) && !*owner)
      return fail(error, "engine connection disappeared");
    return TRUE;
  }

  if (g_strcmp0(g_dbus_message_get_sender(message), driver->owner) ||
      g_strcmp0(interface, ENGINE))
    return TRUE;

  /* Buffer all engine signals during creation: an already-known context
   * must not overtake a new context whose path reply has not arrived yet. */
  if (driver->creating) {
    g_queue_push_tail(&driver->early, g_object_ref(message));
    return TRUE;
  }

  const char *context =
      g_hash_table_lookup(driver->paths, g_dbus_message_get_path(message));
  if (!context)
    return fail(error, "signal on unknown or destroyed engine path");

  JsonObject *object = json_object_new();
  const char *name = g_dbus_message_get_member(message);
  json_object_set_string_member(object, "context", context);
  json_object_set_string_member(object, "name", name);
  GVariant *body = g_dbus_message_get_body(message);
  GVariant *empty = body ? NULL : g_variant_ref_sink(g_variant_new("()"));
  json_object_set_member(object, "payload",
                         ibus_test_value(body ? body : empty));
  if (empty)
    g_variant_unref(empty);
  emit(driver, object, "event");

  Event *event = g_new0(Event, 1);
  event->context = g_strdup(context);
  event->name = g_strdup(name);
  g_queue_push_tail(&driver->events, event);
  return TRUE;
}

static GDBusMessage *next_message(Driver *driver, gint64 deadline,
                                  GError **error) {
  gint64 remaining = deadline - g_get_monotonic_time();
  GDBusMessage *message =
      remaining > 0 ? g_async_queue_timeout_pop(driver->incoming, remaining)
                    : NULL;
  if (!message)
    fail(error, g_dbus_connection_is_closed(driver->connection)
                    ? "bus connection closed"
                    : "D-Bus checkpoint deadline exceeded");
  return message;
}

static GVariant *call(Driver *driver, const char *path, const char *interface,
                      const char *method, GVariant *args, GError **error) {
  GDBusMessage *request =
      g_dbus_message_new_method_call(driver->owner, path, interface, method);
  g_dbus_message_set_body(request, args);
  guint32 serial;
  gboolean sent = g_dbus_connection_send_message(driver->connection, request,
                                                 G_DBUS_SEND_MESSAGE_FLAGS_NONE,
                                                 &serial, error);
  g_object_unref(request);
  if (!sent)
    return NULL;
  gint64 deadline = g_get_monotonic_time() + (gint64)driver->timeout_ms * 1000;
  for (;;) {
    GDBusMessage *message = next_message(driver, deadline, error);
    if (!message)
      return NULL;
    GDBusMessageType type = g_dbus_message_get_message_type(message);
    if ((type == G_DBUS_MESSAGE_TYPE_METHOD_RETURN ||
         type == G_DBUS_MESSAGE_TYPE_ERROR) &&
        g_dbus_message_get_reply_serial(message) == serial &&
        g_strcmp0(g_dbus_message_get_destination(message),
                  driver->request_name) == 0 &&
        (g_strcmp0(g_dbus_message_get_sender(message), driver->owner) == 0 ||
         (type == G_DBUS_MESSAGE_TYPE_ERROR &&
          g_strcmp0(g_dbus_message_get_sender(message), BUS) == 0))) {
      GVariant *result = NULL;
      if (!g_dbus_message_to_gerror(message, error)) {
        GVariant *body = g_dbus_message_get_body(message);
        result = body ? g_variant_ref(body)
                      : g_variant_ref_sink(g_variant_new("()"));
      }
      g_object_unref(message);
      return result;
    }
    gboolean ok = type != G_DBUS_MESSAGE_TYPE_SIGNAL ||
                  signal_message(driver, message, error);
    g_object_unref(message);
    if (!ok)
      return NULL;
  }
}

static gboolean consume_event(Driver *driver, const char *context,
                              const char *name) {
  for (GList *item = driver->events.head; item; item = item->next) {
    Event *event = item->data;
    if (g_str_equal(event->context, context) &&
        g_str_equal(event->name, name)) {
      event_free(event);
      g_queue_delete_link(&driver->events, item);
      return TRUE;
    }
  }
  return FALSE;
}

static gboolean wait_event(Driver *driver, const char *context,
                           const char *name, gint64 timeout_ms,
                           GError **error) {
  gint64 now = g_get_monotonic_time();
  gint64 bounded_ms = MIN(timeout_ms, (G_MAXINT64 - now) / 1000);
  gint64 deadline = now + bounded_ms * 1000;
  while (!consume_event(driver, context, name)) {
    GDBusMessage *message = next_message(driver, deadline, error);
    if (!message)
      return FALSE;
    gboolean ok = g_dbus_message_get_message_type(message) !=
                      G_DBUS_MESSAGE_TYPE_SIGNAL ||
                  signal_message(driver, message, error);
    g_object_unref(message);
    if (!ok)
      return FALSE;
  }
  return TRUE;
}

static void emit_unresolved_creation_signal(Driver *driver,
                                            GDBusMessage *message) {
  GVariant *body = g_dbus_message_get_body(message);
  GVariant *empty = body ? NULL : g_variant_ref_sink(g_variant_new("()"));
  GVariant *payload = body ? body : empty;
  char *text = g_variant_print(payload, TRUE);
  char *diagnostic = g_strdup_printf(
      "unresolved engine signal during CreateEngine: path=%s name=%s "
      "signature=%s payload=%s",
      g_dbus_message_get_path(message), g_dbus_message_get_member(message),
      g_variant_get_type_string(payload), text);

  JsonObject *record = json_object_new();
  json_object_set_string_member(record, "message", diagnostic);
  emit(driver, record, "error");

  g_free(diagnostic);
  g_free(text);
  if (empty)
    g_variant_unref(empty);
}

static void drain_creation_signals(Driver *driver, GError **error) {
  GDBusMessage *message;
  while ((message = g_queue_pop_head(&driver->early))) {
    GError *signal_error = NULL;
    if (!signal_message(driver, message, &signal_error)) {
      /* A failed factory reply cannot resolve a new path. Keep its output
       * in place as a diagnostic, then continue with later known contexts. */
      emit_unresolved_creation_signal(driver, message);
      if (!*error)
        g_propagate_error(error, signal_error);
      else
        g_error_free(signal_error);
    }
    g_object_unref(message);
  }
}

static GVariant *create_context(Driver *driver, const char *context,
                                const char *engine, const char *factory,
                                GError **error) {
  if (g_hash_table_contains(driver->contexts, context)) {
    fail(error, "duplicate context");
    return NULL;
  }

  driver->creating = TRUE;
  GVariant *result = call(driver, factory, "org.freedesktop.IBus.Factory",
                          "CreateEngine", g_variant_new("(s)", engine), error);
  driver->creating = FALSE;

  if (result && !g_variant_is_of_type(result, G_VARIANT_TYPE("(o)"))) {
    fail(error, "CreateEngine returned an invalid path");
  } else if (result) {
    const char *path;
    g_variant_get(result, "(&o)", &path);
    if (g_hash_table_contains(driver->paths, path)) {
      fail(error, "CreateEngine reused a live object path");
    } else {
      g_hash_table_insert(driver->contexts, g_strdup(context), g_strdup(path));
      g_hash_table_insert(driver->paths, g_strdup(path), g_strdup(context));
    }
  }

  /* Both success and every failure path account for the entire observed
   * buffer before the caller emits the reply or original creation error. */
  drain_creation_signals(driver, error);
  if (*error)
    g_clear_pointer(&result, g_variant_unref);
  return result;
}

static GVariant *destroy_context(Driver *driver, const char *context,
                                 const char *path, GError **error) {
  GVariant *result = call(driver, path, "org.freedesktop.IBus.Service",
                          "Destroy", g_variant_new("()"), error);
  if (!result)
    return NULL;

  g_hash_table_remove(driver->paths, path);
  g_hash_table_remove(driver->contexts, context);

  /* Reusing a symbolic name must not consume a previous lifetime's events. */
  for (GList *item = driver->events.head, *next; item; item = next) {
    next = item->next;
    Event *event = item->data;
    if (g_str_equal(event->context, context)) {
      event_free(event);
      g_queue_delete_link(&driver->events, item);
    }
  }
  return result;
}

static GVariant *invoke_engine(Driver *driver, const char *path,
                               JsonObject *step, GError **error) {
  const char *method = json_object_get_string_member(step, "method");
  if (!g_dbus_is_member_name(method)) {
    fail(error, "invalid D-Bus method name");
    return NULL;
  }

  GVariant *args =
      ibus_test_args(json_object_get_string_member(step, "args"), error);
  if (!args)
    return NULL;

  GVariant *result = NULL;
  if (g_str_equal(method, "SetContentType")) {
    if (g_variant_is_of_type(args, G_VARIANT_TYPE("(uu)"))) {
      result = call(driver, path, "org.freedesktop.DBus.Properties", "Set",
                    g_variant_new("(ssv)", ENGINE, "ContentType", args), error);
    } else {
      fail(error, "SetContentType requires (uu)");
    }
  } else {
    result = call(driver, path, ENGINE, method, args, error);
  }
  g_variant_unref(args);
  return result;
}

static void emit_reply(Driver *driver, const char *op, GVariant *result) {
  JsonObject *reply = json_object_new();
  if (result && g_str_equal(op, "call") &&
      g_variant_is_of_type(result, G_VARIANT_TYPE("(b)"))) {
    gboolean handled;
    g_variant_get(result, "(b)", &handled);
    json_object_set_boolean_member(reply, "value", handled);
  } else if (result && g_str_equal(op, "call") &&
             !g_variant_is_of_type(result, G_VARIANT_TYPE_UNIT)) {
    json_object_set_member(reply, "value", ibus_test_value(result));
  } else {
    json_object_set_null_member(reply, "value");
  }
  emit(driver, reply, "reply");
}

static gboolean step_run(Driver *driver, JsonObject *step, const char *factory,
                         GError **error) {
  const char *op = json_object_get_string_member(step, "op");
  const char *context = json_object_get_string_member(step, "context");
  const char *path = g_hash_table_lookup(driver->contexts, context);
  GVariant *result = NULL;

  if (g_str_equal(op, "create")) {
    result = create_context(driver, context,
                            json_object_get_string_member(step, "engine"),
                            factory, error);
  } else if (!path) {
    return fail(error, "unknown context");
  } else if (g_str_equal(op, "wait")) {
    if (!wait_event(driver, context,
                    json_object_get_string_member(step, "event"),
                    json_object_get_int_member(step, "timeoutMs"), error))
      return FALSE;
    emit_reply(driver, op, NULL);
    return TRUE;
  } else if (g_str_equal(op, "destroy")) {
    result = destroy_context(driver, context, path, error);
  } else if (g_str_equal(op, "call")) {
    result = invoke_engine(driver, path, step, error);
  } else {
    return fail(error, "unknown operation");
  }

  if (!result)
    return FALSE;
  emit_reply(driver, op, result);
  g_variant_unref(result);
  return TRUE;
}

static gboolean match(GDBusConnection *connection, const char *rule,
                      gint timeout, GError **error) {
  GVariant *reply = g_dbus_connection_call_sync(
      connection, BUS, "/org/freedesktop/DBus", BUS, "AddMatch",
      g_variant_new("(s)", rule), G_VARIANT_TYPE_UNIT, G_DBUS_CALL_FLAGS_NONE,
      timeout, NULL, error);
  if (!reply)
    return FALSE;
  g_variant_unref(reply);
  return TRUE;
}

typedef struct {
  GMainLoop *loop;
  GDBusConnection *connection;
  GError *error;
} ConnectionAttempt;

static gboolean cancel_connection(gpointer data) {
  g_cancellable_cancel(G_CANCELLABLE(data));
  return G_SOURCE_REMOVE;
}

static void connection_ready(GObject *source, GAsyncResult *result,
                             gpointer user_data) {
  (void)source;
  ConnectionAttempt *attempt = user_data;
  attempt->connection =
      g_dbus_connection_new_for_address_finish(result, &attempt->error);
  g_main_loop_quit(attempt->loop);
}

static GDBusConnection *connect_bus(const char *address, gint timeout_ms,
                                    GError **error) {
  GMainContext *context = g_main_context_new();
  g_main_context_push_thread_default(context);
  ConnectionAttempt attempt = {.loop = g_main_loop_new(context, FALSE)};
  GCancellable *cancellable = g_cancellable_new();
  GSource *timeout = g_timeout_source_new(timeout_ms);
  g_source_set_callback(timeout, cancel_connection, cancellable, NULL);
  g_source_attach(timeout, context);

  g_dbus_connection_new_for_address(
      address,
      G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
          G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION,
      NULL, cancellable, connection_ready, &attempt);
  g_main_loop_run(attempt.loop);

  g_source_destroy(timeout);
  g_source_unref(timeout);
  g_object_unref(cancellable);
  g_main_loop_unref(attempt.loop);
  g_main_context_pop_thread_default(context);
  g_main_context_unref(context);

  if (attempt.error)
    g_propagate_error(error, attempt.error);
  return attempt.connection;
}

gboolean ibus_test_run(JsonArray *steps, const char *address,
                       const char *destination, const char *factory,
                       gint timeout_ms) {
  Driver driver = {.timeout_ms = timeout_ms};
  GError *error = NULL;
  guint filter = 0;
  guint request_filter = 0;
  GVariant *owner_result = NULL;
  driver.contexts =
      g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  driver.paths = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  driver.incoming = g_async_queue_new_full(g_object_unref);
  gboolean ok = TRUE;
  if (json_array_get_length(steps) == 0)
    goto cleanup;
  driver.connection = connect_bus(address, timeout_ms, &error);
  if (!driver.connection) {
    ok = FALSE;
    goto cleanup;
  }
  g_dbus_connection_set_exit_on_close(driver.connection, FALSE);
  driver.observer = connect_bus(address, timeout_ms, &error);
  if (!driver.observer) {
    ok = FALSE;
    goto cleanup;
  }
  g_dbus_connection_set_exit_on_close(driver.observer, FALSE);
  owner_result = g_dbus_connection_call_sync(
      driver.connection, BUS, "/org/freedesktop/DBus", BUS, "GetNameOwner",
      g_variant_new("(s)", destination), G_VARIANT_TYPE("(s)"),
      G_DBUS_CALL_FLAGS_NONE, timeout_ms, NULL, &error);
  if (!owner_result) {
    ok = FALSE;
    goto cleanup;
  }
  g_variant_get(owner_result, "(&s)", &driver.owner);
  char *rule = g_strdup_printf(
      "eavesdrop='true',type='signal',sender='%s',interface='%s'", driver.owner,
      ENGINE);
  ok = match(driver.observer, rule, timeout_ms, &error);
  g_free(rule);
  if (!ok)
    goto cleanup;
  rule = g_strdup_printf("type='signal',sender='%s',interface='%s',member='"
                         "NameOwnerChanged',arg0='%s'",
                         BUS, BUS, driver.owner);
  ok = match(driver.observer, rule, timeout_ms, &error);
  g_free(rule);
  if (!ok)
    goto cleanup;
  driver.request_name = g_dbus_connection_get_unique_name(driver.connection);
  rule =
      g_strdup_printf("eavesdrop='true',type='method_return',destination='%s'",
                      driver.request_name);
  ok = match(driver.observer, rule, timeout_ms, &error);
  g_free(rule);
  if (!ok)
    goto cleanup;
  rule = g_strdup_printf("eavesdrop='true',type='error',destination='%s'",
                         driver.request_name);
  ok = match(driver.observer, rule, timeout_ms, &error);
  g_free(rule);
  if (!ok)
    goto cleanup;
  filter = g_dbus_connection_add_filter(driver.observer, receive,
                                        g_async_queue_ref(driver.incoming),
                                        (GDestroyNotify)g_async_queue_unref);
  BusErrorCapture *capture = g_new0(BusErrorCapture, 1);
  capture->incoming = g_async_queue_ref(driver.incoming);
  capture->request_name = g_strdup(driver.request_name);
  request_filter = g_dbus_connection_add_filter(
      driver.connection, receive_bus_error, capture, bus_error_capture_free);
  for (driver.step = 0; driver.step < json_array_get_length(steps);
       driver.step++) {
    if (!step_run(&driver, json_array_get_object_element(steps, driver.step),
                  factory, &error)) {
      ok = FALSE;
      break;
    }
  }
  if (ok) {
    driver.step--;
    if (g_hash_table_size(driver.contexts))
      ok = fail(&error,
                "trace ended with live contexts; explicit destroy required");
    else {
      /* All context lifetimes have ended. Ping is an ordered peer barrier,
       * not an idle-loop guess that delayed work has finished. */
      GVariant *reply = call(&driver, factory, "org.freedesktop.DBus.Peer",
                             "Ping", g_variant_new("()"), &error);
      ok = reply != NULL;
      if (reply)
        g_variant_unref(reply);
    }
  }
cleanup:
  if (!ok) {
    JsonObject *record = json_object_new();
    json_object_set_string_member(record, "message", error->message);
    emit(&driver, record, "error");
  }
  g_clear_error(&error);
  if (filter)
    g_dbus_connection_remove_filter(driver.observer, filter);
  if (request_filter)
    g_dbus_connection_remove_filter(driver.connection, request_filter);
  if (driver.observer) {
    g_dbus_connection_close_sync(driver.observer, NULL, NULL);
    g_object_unref(driver.observer);
  }
  if (driver.connection) {
    g_dbus_connection_close_sync(driver.connection, NULL, NULL);
    g_object_unref(driver.connection);
  }
  if (owner_result)
    g_variant_unref(owner_result);
  g_queue_clear_full(&driver.events, event_free);
  g_queue_clear_full(&driver.early, g_object_unref);
  g_async_queue_unref(driver.incoming);
  g_hash_table_unref(driver.contexts);
  g_hash_table_unref(driver.paths);
  return ok;
}
