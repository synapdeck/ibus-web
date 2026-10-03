// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include <ibus.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <unistd.h>

typedef struct {
  IBusEngine parent;
  guint delayed;
  gboolean trailing_on_destroy;
} TestEngine;

typedef struct {
  IBusEngineClass parent;
} TestEngineClass;

G_DEFINE_TYPE(TestEngine, test_engine, IBUS_TYPE_ENGINE)

static void commit(IBusEngine *engine) {
  IBusText *text = ibus_text_new_from_string("한글 🐈");
  ibus_serializable_set_attachment(IBUS_SERIALIZABLE(text), "typed",
                                   g_variant_new_uint32(42));
  ibus_engine_commit_text(engine, text);
}

static gboolean delayed(gpointer data) {
  TestEngine *engine = data;
  engine->delayed = 0;
  commit(IBUS_ENGINE(engine));
  return G_SOURCE_REMOVE;
}

static gboolean key(IBusEngine *engine, guint keyval, guint keycode,
                    guint state) {
  (void)keycode;
  (void)state;
  if (keyval == 1)
    commit(engine);
  if (keyval == 2)
    ((TestEngine *)engine)->delayed = g_timeout_add(40, delayed, engine);
  if (keyval == 3)
    exit(23);
  if (keyval == 6)
    ((TestEngine *)engine)->trailing_on_destroy = TRUE;
  if (keyval == 7) {
    ibus_engine_update_preedit_text_with_mode(engine,
                                              ibus_text_new_from_string(""), 0,
                                              FALSE, IBUS_ENGINE_PREEDIT_CLEAR);
    commit(engine);
  }
  return keyval != 0;
}

static void content(IBusEngine *engine, guint purpose, guint hints) {
  ibus_engine_forward_key_event(engine, purpose, hints, 0);
}

static void destroy(IBusObject *object) {
  TestEngine *engine = (TestEngine *)object;
  if (engine->delayed) {
    g_source_remove(engine->delayed);
    engine->delayed = 0;
  }
  IBUS_OBJECT_CLASS(test_engine_parent_class)->destroy(object);
}

static void method(IBusService *service, GDBusConnection *connection,
                   const gchar *sender, const gchar *path,
                   const gchar *interface, const gchar *name,
                   GVariant *parameters, GDBusMethodInvocation *invocation) {
  if (g_str_equal(name, "ProcessKeyEvent")) {
    guint keyval, code, state;
    g_variant_get(parameters, "(uuu)", &keyval, &code, &state);
    if (keyval == 5)
      return; /* An intentionally unanswered request. */
  }
  gboolean trailing = g_str_equal(name, "Destroy") &&
                      ((TestEngine *)service)->trailing_on_destroy;
  char *saved_path = g_strdup(path);
  g_object_ref(connection);
  g_object_ref(service);

  IBUS_SERVICE_CLASS(test_engine_parent_class)
      ->service_method_call(service, connection, sender, path, interface, name,
                            parameters, invocation);

  if (g_str_equal(name, "Reset"))
    commit(IBUS_ENGINE(service));
  if (trailing) {
    /* Deliberately violate the lifetime after the Destroy reply. */
    g_dbus_connection_emit_signal(
        connection, NULL, saved_path, "org.freedesktop.IBus.Engine",
        "ForwardKeyEvent", g_variant_new("(uuu)", 1, 2, 3), NULL);
  }

  g_free(saved_path);
  g_object_unref(connection);
  g_object_unref(service);
}

static void test_engine_init(TestEngine *engine) {
  engine->delayed = 0;
  engine->trailing_on_destroy = FALSE;
}

static void test_engine_class_init(TestEngineClass *klass) {
  IBUS_ENGINE_CLASS(klass)->process_key_event = key;
  IBUS_ENGINE_CLASS(klass)->set_content_type = content;
  IBUS_OBJECT_CLASS(klass)->destroy = destroy;
  IBUS_SERVICE_CLASS(klass)->service_method_call = method;
}

static IBusEngine *create_early(IBusFactory *factory, const gchar *name,
                                gpointer user_data) {
  (void)user_data;
  if (!g_str_equal(name, "early") && !g_str_equal(name, "interleaved"))
    return NULL;

  static guint next_id;
  char *path = g_strdup_printf("/org/example/early/%u", ++next_id);
  IBusEngine *engine = ibus_engine_new_with_type(
      test_engine_get_type(), name, path,
      ibus_service_get_connection(IBUS_SERVICE(factory)));
  g_free(path);

  /* The adapter has not received the path from CreateEngine yet. */
  commit(engine);
  if (g_str_equal(name, "interleaved")) {
    g_dbus_connection_emit_signal(
        ibus_service_get_connection(IBUS_SERVICE(factory)), NULL,
        "/org/example/early/1", "org.freedesktop.IBus.Engine",
        "ForwardKeyEvent", g_variant_new("(uuu)", 1, 2, 3), NULL);
  }
  return engine;
}

typedef struct {
  IBusFactory parent;
} TestFactory;

typedef struct {
  IBusFactoryClass parent;
} TestFactoryClass;

G_DEFINE_TYPE(TestFactory, test_factory, IBUS_TYPE_FACTORY)

static void emit_creation_output(GDBusConnection *connection) {
  const char *paths[] = {
      "/org/example/early/1",
      "/org/example/unresolved",
      "/org/example/early/1",
  };
  for (guint i = 0; i < G_N_ELEMENTS(paths); i++) {
    g_dbus_connection_emit_signal(
        connection, NULL, paths[i], "org.freedesktop.IBus.Engine",
        "ForwardKeyEvent", g_variant_new("(uuu)", i + 1, 0, 0), NULL);
  }
}

static void factory_method(IBusService *service, GDBusConnection *connection,
                           const gchar *sender, const gchar *path,
                           const gchar *interface, const gchar *name,
                           GVariant *parameters,
                           GDBusMethodInvocation *invocation) {
  if (g_str_equal(name, "CreateEngine")) {
    const char *engine_name;
    g_variant_get(parameters, "(&s)", &engine_name);
    if (g_str_has_prefix(engine_name, "fail-")) {
      emit_creation_output(connection);
      if (g_str_equal(engine_name, "fail-timeout")) {
        /* Deliberately leave the request unanswered after emitting output. */
        g_object_unref(invocation);
      } else if (g_str_equal(engine_name, "fail-invalid")) {
        /* Bypass GDBus's reply-type validation to exercise an invalid peer. */
        GDBusMessage *reply = g_dbus_message_new_method_reply(
            g_dbus_method_invocation_get_message(invocation));
        g_dbus_message_set_body(reply,
                                g_variant_new("(s)", "not an object path"));
        g_dbus_connection_send_message(
            connection, reply, G_DBUS_SEND_MESSAGE_FLAGS_NONE, NULL, NULL);
        g_object_unref(reply);
        g_object_unref(invocation);
      } else if (g_str_equal(engine_name, "fail-reused")) {
        g_dbus_method_invocation_return_value(
            invocation, g_variant_new("(o)", "/org/example/early/1"));
      } else {
        g_dbus_method_invocation_return_dbus_error(
            invocation, "org.example.FactoryFailed",
            "intentional factory failure");
      }
      return;
    }
  }

  IBUS_SERVICE_CLASS(test_factory_parent_class)
      ->service_method_call(service, connection, sender, path, interface, name,
                            parameters, invocation);
}

static void test_factory_init(TestFactory *factory) { (void)factory; }

static void test_factory_class_init(TestFactoryClass *klass) {
  IBUS_SERVICE_CLASS(klass)->service_method_call = factory_method;
}

int main(int argc, char **argv) {
  if (argc != 2)
    return 2;
  /* Kill the owned fixture if a failed assertion terminates its test parent. */
  pid_t parent_pid = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent_pid)
    return 2;

  ibus_init();
  GError *error = NULL;
  GDBusConnection *connection = g_dbus_connection_new_for_address_sync(
      argv[1],
      G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
          G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION,
      NULL, NULL, &error);
  if (!connection)
    g_error("connect: %s", error->message);
  IBusFactory *factory =
      g_object_new(test_factory_get_type(), "object-path", IBUS_PATH_FACTORY,
                   "connection", connection, NULL);
  g_object_ref_sink(factory);
  ibus_factory_add_engine(factory, "fixture", test_engine_get_type());
  g_signal_connect(factory, "create-engine", G_CALLBACK(create_early), NULL);
  GVariant *reply = g_dbus_connection_call_sync(
      connection, "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "RequestName",
      g_variant_new("(su)", "org.example.IBusTest", 0), G_VARIANT_TYPE("(u)"),
      G_DBUS_CALL_FLAGS_NONE, 1000, NULL, &error);
  if (!reply)
    g_error("request name: %s", error->message);
  g_variant_unref(reply);
  puts("READY");
  fflush(stdout);
  GMainLoop *loop = g_main_loop_new(NULL, FALSE);
  g_main_loop_run(loop);
  g_main_loop_unref(loop);
  g_object_unref(factory);
  g_object_unref(connection);
  return 0;
}
