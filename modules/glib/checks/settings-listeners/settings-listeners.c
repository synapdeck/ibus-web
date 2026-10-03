/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */
#define G_SETTINGS_ENABLE_BACKEND
#include <gio/gio.h>
#include <gio/gsettingsbackend.h>

#define SCHEMA "org.ibus-web.ListenerTest"
#define SETTINGS_PATH "/org/ibus-web/listener-test/"

typedef enum {
  CHANGED,
  PATH_CHANGED,
  KEYS_CHANGED,
  WRITABLE_CHANGED,
  PATH_WRITABLE_CHANGED,
} Notification;

typedef struct {
  Notification notification;
  gboolean deferred;
} TestCase;

typedef struct {
  GSettingsBackend *backend;
  Notification notification;
} Emission;

static gpointer emit_notification(gpointer data) {
  Emission *emission = data;
  const gchar *keys[] = {"value", NULL};
  switch (emission->notification) {
  case CHANGED:
    g_settings_backend_changed(emission->backend, SETTINGS_PATH "value", NULL);
    break;
  case PATH_CHANGED:
    g_settings_backend_path_changed(emission->backend, SETTINGS_PATH, NULL);
    break;
  case KEYS_CHANGED:
    g_settings_backend_keys_changed(emission->backend, SETTINGS_PATH, keys,
                                    NULL);
    break;
  case WRITABLE_CHANGED:
    g_settings_backend_writable_changed(emission->backend,
                                        SETTINGS_PATH "value");
    break;
  case PATH_WRITABLE_CHANGED:
    g_settings_backend_path_writable_changed(emission->backend, SETTINGS_PATH);
    break;
  }
  return NULL;
}

static void count_notification(GSettings *settings G_GNUC_UNUSED,
                               const gchar *key, gpointer data) {
  g_assert_cmpstr(key, ==, "value");
  ++*(guint *)data;
}

static void listener(gconstpointer data) {
  const TestCase *test = data;
  GMainContext *context = g_main_context_new();
  g_main_context_push_thread_default(context);
  GSettingsBackend *backend = g_memory_settings_backend_new();
  GSettings *settings = g_settings_new_with_backend(SCHEMA, backend);
  guint changed = 0, writable_changed = 0;
  g_signal_connect(settings, "changed", G_CALLBACK(count_notification),
                   &changed);
  g_signal_connect(settings, "writable-changed", G_CALLBACK(count_notification),
                   &writable_changed);

  Emission emission = {backend, test->notification};
  if (test->deferred) {
    /* This thread owns the listener's context, so the worker must queue it. */
    GThread *thread = g_thread_new("notify", emit_notification, &emission);
    g_thread_join(thread);
    g_assert_cmpuint(changed, ==, 0);
    g_assert_cmpuint(writable_changed, ==, 0);
    g_assert_true(g_main_context_pending(context));
  } else {
    emit_notification(&emission);
  }
  while (g_main_context_iteration(context, FALSE)) {
  }
  gboolean writable = test->notification >= WRITABLE_CHANGED;
  g_assert_cmpuint(changed, ==, writable ? 0 : 1);
  g_assert_cmpuint(writable_changed, ==, writable ? 1 : 0);
  g_object_unref(settings);
  g_object_unref(backend);
  g_main_context_pop_thread_default(context);
  g_main_context_unref(context);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  static const gchar *names[] = {"changed", "path-changed", "keys-changed",
                                 "writable-changed", "path-writable-changed"};
  static TestCase cases[G_N_ELEMENTS(names)][2];
  for (guint i = 0; i < G_N_ELEMENTS(names); ++i) {
    for (guint deferred = 0; deferred < 2; ++deferred) {
      cases[i][deferred] = (TestCase){i, deferred};
      g_autofree gchar *path =
          g_strdup_printf("/settings/listeners/%s/%s", names[i],
                          deferred ? "queued" : "direct");
      g_test_add_data_func(path, &cases[i][deferred], listener);
    }
  }
  return g_test_run();
}
