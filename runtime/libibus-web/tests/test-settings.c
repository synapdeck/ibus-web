/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#define G_SETTINGS_ENABLE_BACKEND
#include "../src/settings.h"
#include <errno.h>
#include <gio/gio.h>
#include <gio/gsettingsbackend.h>
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <string.h>

#define SCHEMA "org.ibus-web.Test"
#define PATH "/org/ibus-web/test/"
#define CHILD "org.ibus-web.Test.Child"
#define CHILD_PATH "/org/ibus-web/test/nested/"
#define RELOCATABLE "org.ibus-web.Test.Relocatable"
#define FIRST "/org/ibus-web/relocatable/first/"
#define SECOND "/org/ibus-web/relocatable/second/"

static void output_empty(void) {
  guint32 length;
  g_assert_null(ibusweb_output_peek(&length));
  g_assert_cmpuint(length, ==, 0);
}

static void expect_write(const gchar *path, const gchar *key, GVariant *value) {
  guint32 length;
  const guint8 *data = ibusweb_output_peek(&length);
  g_assert_nonnull(data);
  IBusWebRecordHeader header;
  g_assert_cmpuint(length, >=, sizeof header);
  memcpy(&header, data, sizeof header);
  g_assert_cmpuint(GUINT32_FROM_LE(header.ic), ==, 0);
  g_assert_cmpuint(GUINT16_FROM_LE(header.kind), ==,
                   IBUSWEB_REC_SETTING_WRITTEN);
  guint payload_length = GUINT32_FROM_LE(header.len);
  GVariant *payload = g_variant_ref_sink(
      g_variant_new_from_data(G_VARIANT_TYPE("(ssv)"), data + sizeof header,
                              payload_length, FALSE, NULL, NULL));
  GVariant *expected =
      g_variant_ref_sink(g_variant_new("(ssv)", path, key, value));
  g_assert_true(g_variant_is_normal_form(payload));
  g_assert_true(g_variant_equal(payload, expected));
  g_variant_unref(payload);
  g_variant_unref(expected);
  ibusweb_output_consume((sizeof header + payload_length + 7) & ~7u);
}

/* Adds one Init entry; a NULL key leaves the instance without values. */
static void add_instance(GVariantBuilder *builder, const gchar *schema,
                         const gchar *path, const gchar *key, GVariant *value) {
  GVariantBuilder values;
  g_variant_builder_init(&values, G_VARIANT_TYPE("a{sv}"));
  if (key != NULL)
    g_variant_builder_add(&values, "{sv}", key, value);
  g_variant_builder_add(builder, "(ss@a{sv})", schema, path,
                        g_variant_builder_end(&values));
}

static GVariant *snapshot_value(const gchar *key, GVariant *value) {
  GVariantBuilder builder;
  g_variant_builder_init(&builder, G_VARIANT_TYPE("a(ssa{sv})"));
  add_instance(&builder, SCHEMA, PATH, key, value);
  return g_variant_builder_end(&builder);
}

static void apply(GVariant *instances) {
  g_variant_ref_sink(instances);
  ibusweb_settings_init(instances);
  g_variant_unref(instances);
}

static void seed(const gchar *key, GVariant *value) {
  apply(snapshot_value(key, value));
}

static void declare(void) {
  GVariantBuilder builder;
  g_variant_builder_init(&builder, G_VARIANT_TYPE("a(ssa{sv})"));
  add_instance(&builder, SCHEMA, PATH, NULL, NULL);
  add_instance(&builder, CHILD, CHILD_PATH, NULL, NULL);
  add_instance(&builder, RELOCATABLE, FIRST, NULL, NULL);
  add_instance(&builder, RELOCATABLE, SECOND, NULL, NULL);
  apply(g_variant_builder_end(&builder));
}

static gint change(const gchar *path, const gchar *key, GVariant *value) {
  g_variant_ref_sink(value);
  gint result = ibusweb_settings_changed(path, key, value);
  g_variant_unref(value);
  return result;
}

static void count_changes(GSettings *settings G_GNUC_UNUSED,
                          const gchar *key G_GNUC_UNUSED, gpointer data) {
  ++*(guint *)data;
}

static void registration(void) {
  g_assert_null(g_getenv("GSETTINGS_BACKEND"));
  GSettingsBackend *backend = g_settings_backend_get_default();
  g_assert_cmpstr(G_OBJECT_TYPE_NAME(backend), ==, "IBusWebSettingsBackend");
  g_object_unref(backend);
}

static void defaults(void) {
  GSettings *settings = g_settings_new(SCHEMA);
  g_autofree gchar *layout = g_settings_get_string(settings, "layout");
  g_autofree gchar *mode = g_settings_get_string(settings, "mode");
  g_assert_cmpstr(layout, ==, "2");
  g_assert_cmpstr(mode, ==, "latin");
  g_assert_true(g_settings_get_boolean(settings, "enabled"));
  g_assert_cmpint(g_settings_get_int(settings, "page-size"), ==, 9);
  g_assert_true(g_settings_is_writable(settings, "layout"));
  g_object_unref(settings);
  output_empty();
}

static void snapshot(void) {
  GSettings *settings = g_settings_new(SCHEMA);
  guint changed = 0;
  g_signal_connect(settings, "changed", G_CALLBACK(count_changes), &changed);
  seed("layout", g_variant_new_string("3f"));
  seed("enabled", g_variant_new_boolean(FALSE));
  seed("page-size", g_variant_new_int32(7));
  seed("mode", g_variant_new_string("hangul"));
  ibusweb_pump();
  g_autofree gchar *layout = g_settings_get_string(settings, "layout");
  g_autofree gchar *mode = g_settings_get_string(settings, "mode");
  g_assert_cmpstr(layout, ==, "3f");
  g_assert_cmpstr(mode, ==, "hangul");
  g_assert_false(g_settings_get_boolean(settings, "enabled"));
  g_assert_cmpint(g_settings_get_int(settings, "page-size"), ==, 7);
  g_assert_cmpuint(changed, ==, 0);
  g_object_unref(settings);
  output_empty();
}

static void notification(void) {
  seed("layout", g_variant_new_string("before"));
  GSettings *settings = g_settings_new(SCHEMA);
  guint changed = 0;
  g_signal_connect(settings, "changed::layout", G_CALLBACK(count_changes),
                   &changed);
  g_assert_cmpint(change(PATH, "layout", g_variant_new_string("after")), ==, 0);
  ibusweb_pump();
  g_assert_cmpuint(changed, ==, 1);
  g_autofree gchar *layout = g_settings_get_string(settings, "layout");
  g_assert_cmpstr(layout, ==, "after");
  g_assert_cmpint(change(PATH, "layout", g_variant_new_string("after")), ==, 0);
  ibusweb_pump();
  g_assert_cmpuint(changed, ==, 1);
  g_object_unref(settings);
  output_empty();
}

static void invalid_values(void) {
  const struct {
    const gchar *path;
    const gchar *key;
    gint error;
    const gchar *message;
  } cases[] = {
      {"/org/ibus-web/missing/", "layout", -ENOENT, "*Unknown settings path*"},
      {PATH, "missing", -ENOENT, "*Unknown settings key*"},
      {PATH, "page-size", -EINVAL, "*Invalid value*"},
      {PATH, "mode", -EINVAL, "*Invalid value*"},
  };
  for (guint i = 0; i < G_N_ELEMENTS(cases); ++i) {
    g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING, cases[i].message);
    g_assert_cmpint(
        change(cases[i].path, cases[i].key, g_variant_new_string("invalid")),
        ==, cases[i].error);
    g_test_assert_expected_messages();
  }
  seed("page-size", g_variant_new_int32(9));
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING, "*Invalid value*");
  seed("page-size", g_variant_new_string("invalid"));
  g_test_assert_expected_messages();
  GSettings *settings = g_settings_new(SCHEMA);
  g_assert_cmpint(g_settings_get_int(settings, "page-size"), ==, 9);
  g_object_unref(settings);
  output_empty();
}

static void writes(void) {
  GSettings *settings = g_settings_new(SCHEMA);
  g_assert_true(g_settings_set_string(settings, "layout", "written"));
  expect_write(PATH, "layout", g_variant_new_string("written"));
  g_assert_true(g_settings_set_boolean(settings, "enabled", TRUE));
  expect_write(PATH, "enabled", g_variant_new_boolean(TRUE));
  g_assert_true(g_settings_set_int(settings, "page-size", 5));
  expect_write(PATH, "page-size", g_variant_new_int32(5));
  g_settings_reset(settings, "layout");
  expect_write(PATH, "layout", g_variant_new_string("2"));
  g_autofree gchar *layout = g_settings_get_string(settings, "layout");
  g_assert_cmpstr(layout, ==, "2");
  g_object_unref(settings);
  settings = g_settings_new(CHILD);
  g_assert_true(g_settings_set_string(settings, "layout", "nested"));
  expect_write(CHILD_PATH, "layout", g_variant_new_string("nested"));
  g_object_unref(settings);
  output_empty();
}

static void tree_writes(void) {
  GSettings *settings = g_settings_new(SCHEMA);
  GSettings *observer = g_settings_new(SCHEMA);
  g_settings_delay(settings);
  g_assert_true(g_settings_set_boolean(settings, "enabled", FALSE));
  g_assert_true(g_settings_set_string(settings, "layout", "delayed"));
  output_empty();
  g_settings_apply(settings);
  expect_write(PATH, "enabled", g_variant_new_boolean(FALSE));
  expect_write(PATH, "layout", g_variant_new_string("delayed"));
  g_autofree gchar *layout = g_settings_get_string(observer, "layout");
  g_assert_cmpstr(layout, ==, "delayed");
  g_assert_false(g_settings_get_boolean(observer, "enabled"));
  g_settings_reset(settings, "layout");
  g_settings_apply(settings);
  expect_write(PATH, "layout", g_variant_new_string("2"));
  g_object_unref(observer);
  g_object_unref(settings);
  output_empty();
}

static void relocatable(void) {
  GSettings *first = g_settings_new_with_path(RELOCATABLE, FIRST);
  GSettings *second = g_settings_new_with_path(RELOCATABLE, SECOND);
  guint changed = 0;
  g_signal_connect(second, "changed::layout", G_CALLBACK(count_changes),
                   &changed);
  g_assert_cmpint(change(FIRST, "layout", g_variant_new_string("first")), ==,
                  0);
  ibusweb_pump();
  g_assert_cmpuint(changed, ==, 0);
  g_autofree gchar *one = g_settings_get_string(first, "layout");
  g_autofree gchar *two = g_settings_get_string(second, "layout");
  g_assert_cmpstr(one, ==, "first");
  g_assert_cmpstr(two, ==, "relocatable");
  g_assert_true(g_settings_set_string(second, "layout", "second"));
  expect_write(SECOND, "layout", g_variant_new_string("second"));
  g_object_unref(first);
  g_object_unref(second);
  output_empty();
}

static void refused_instances(void) {
  const struct {
    const gchar *schema;
    const gchar *path;
    const gchar *message;
  } cases[] = {
      {"org.ibus-web.Missing", "/org/ibus-web/missing/",
       "*Unknown settings schema*"},
      {SCHEMA, "/org/ibus-web/elsewhere/", "*has the fixed path*"},
      {RELOCATABLE, "relative/", "*Invalid settings path*"},
      {RELOCATABLE, "/org//double/", "*Invalid settings path*"},
  };
  for (guint i = 0; i < G_N_ELEMENTS(cases); ++i) {
    GVariantBuilder builder;
    g_variant_builder_init(&builder, G_VARIANT_TYPE("a(ssa{sv})"));
    add_instance(&builder, cases[i].schema, cases[i].path, "layout",
                 g_variant_new_string("refused"));
    g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING, cases[i].message);
    apply(g_variant_builder_end(&builder));
    g_test_assert_expected_messages();

    g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING,
                          "*Unknown settings path*");
    g_assert_cmpint(
        change(cases[i].path, "layout", g_variant_new_string("refused")), ==,
        -ENOENT);
    g_test_assert_expected_messages();
  }

  GSettings *undeclared = g_settings_new_with_path(
      RELOCATABLE, "/org/ibus-web/relocatable/undeclared/");
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING,
                        "*Unknown settings path*");
  g_assert_false(g_settings_set_string(undeclared, "layout", "lost"));
  g_test_assert_expected_messages();
  g_object_unref(undeclared);
  output_empty();
}

static gint request(guint16 kind, GVariant *payload) {
  g_variant_ref_sink(payload);
  gsize length = sizeof(IBusWebRequestHeader) + g_variant_get_size(payload);
  guint8 *bytes = g_malloc(length);
  IBusWebRequestHeader header = {.kind = GUINT16_TO_LE(kind)};
  memcpy(bytes, &header, sizeof header);
  g_variant_store(payload, bytes + sizeof header);
  gint result = ibusweb_dispatch(bytes, length);
  /* The host reuses the request slot before the next pump. */
  memset(bytes, 0xa5, length);
  g_free(bytes);
  g_variant_unref(payload);
  ibusweb_pump();
  return result;
}

static void protocol(void) {
  GSettings *settings = g_settings_new(SCHEMA);
  guint changed = 0;
  g_signal_connect(settings, "changed::layout", G_CALLBACK(count_changes),
                   &changed);
  g_assert_cmpint(
      request(IBUSWEB_REQ_INIT,
              g_variant_new(
                  "(u@a(ssa{sv}))", IBUSWEB_PROTOCOL_VERSION,
                  snapshot_value("layout", g_variant_new_string("initial")))),
      ==, 0);
  g_autofree gchar *initial = g_settings_get_string(settings, "layout");
  g_assert_cmpstr(initial, ==, "initial");
  g_assert_cmpuint(changed, ==, 0);
  output_empty();
  for (guint i = 0; i < 2; ++i) {
    g_assert_cmpint(request(IBUSWEB_REQ_SETTING_CHANGED,
                            g_variant_new("(ssv)", PATH, "layout",
                                          g_variant_new_string("host-change"))),
                    ==, 0);
    g_assert_cmpuint(changed, ==, 1);
    g_autofree gchar *layout = g_settings_get_string(settings, "layout");
    g_assert_cmpstr(layout, ==, "host-change");
    output_empty();
  }
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING, "*Invalid value*");
  g_assert_cmpint(request(IBUSWEB_REQ_SETTING_CHANGED,
                          g_variant_new("(ssv)", PATH, "layout",
                                        g_variant_new_boolean(TRUE))),
                  ==, -EINVAL);
  g_test_assert_expected_messages();
  g_assert_cmpuint(changed, ==, 1);
  g_autofree gchar *unchanged = g_settings_get_string(settings, "layout");
  g_assert_cmpstr(unchanged, ==, "host-change");
  output_empty();
  g_object_unref(settings);
}

int main(int argc, char **argv) {
  static int32_t wake_word;
  g_unsetenv("GSETTINGS_BACKEND");
  g_test_init(&argc, &argv, NULL);
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, 0);
  declare();
  g_test_add_func("/settings/registration", registration);
  g_test_add_func("/settings/defaults", defaults);
  g_test_add_func("/settings/snapshot", snapshot);
  g_test_add_func("/settings/notification", notification);
  g_test_add_func("/settings/invalid", invalid_values);
  g_test_add_func("/settings/writes", writes);
  g_test_add_func("/settings/tree", tree_writes);
  g_test_add_func("/settings/relocatable", relocatable);
  g_test_add_func("/settings/refused", refused_instances);
  g_test_add_func("/settings/protocol", protocol);
  return g_test_run();
}
