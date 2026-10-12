/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include <errno.h>
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <ibus.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

typedef struct {
  IBusEngine parent;
} DispatchEngine;
typedef struct {
  IBusEngineClass parent;
} DispatchEngineClass;
G_DEFINE_TYPE(DispatchEngine, dispatch_engine, IBUS_TYPE_ENGINE)
static IBusEngine *last_created;
static guint engines_constructed, engines_finalized;

extern gboolean test_throwing_key_event(IBusEngine *, guint, guint, guint);

static gboolean process_key(IBusEngine *engine, guint keyval, guint keycode,
                            guint state) {
  if (keyval == 999)
    return test_throwing_key_event(engine, keyval, keycode, state);
  return keyval == IBUS_a;
}
static guint cache_callbacks;

static void check_cursor(IBusEngine *engine, gint x, gint y, gint width,
                         gint height) {
  g_assert_cmpint(engine->cursor_area.x, ==, x);
  g_assert_cmpint(engine->cursor_area.y, ==, y);
  g_assert_cmpint(engine->cursor_area.width, ==, width);
  g_assert_cmpint(engine->cursor_area.height, ==, height);
}

static void check_capabilities(IBusEngine *engine, guint caps) {
  g_assert_cmpuint(engine->client_capabilities, ==, caps);
}

static void check_content(IBusEngine *engine, guint purpose, guint hints) {
  guint actual_purpose, actual_hints;
  ibus_engine_get_content_type(engine, &actual_purpose, &actual_hints);
  g_assert_cmpuint(actual_purpose, ==, purpose);
  g_assert_cmpuint(actual_hints, ==, hints);
}

/* These class overrides deliberately do not chain to the parent. */
static void cursor_callback(IBusEngine *engine, gint x, gint y, gint width,
                            gint height) {
  check_cursor(engine, x, y, width, height);
  ++cache_callbacks;
}

static void capabilities_callback(IBusEngine *engine, guint caps) {
  check_capabilities(engine, caps);
  ++cache_callbacks;
}

static void content_callback(IBusEngine *engine, guint purpose, guint hints) {
  check_content(engine, purpose, hints);
  ++cache_callbacks;
}

static void connected_cursor(IBusEngine *engine, gint x, gint y, gint width,
                             gint height, gpointer data G_GNUC_UNUSED) {
  cursor_callback(engine, x, y, width, height);
}

static void connected_capabilities(IBusEngine *engine, guint caps,
                                   gpointer data G_GNUC_UNUSED) {
  capabilities_callback(engine, caps);
}

static void connected_content(IBusEngine *engine, guint purpose, guint hints,
                              gpointer data G_GNUC_UNUSED) {
  content_callback(engine, purpose, hints);
}

static void dispatch_engine_finalize(GObject *object) {
  ++engines_finalized;
  G_OBJECT_CLASS(dispatch_engine_parent_class)->finalize(object);
}
static void dispatch_engine_class_init(DispatchEngineClass *klass) {
  G_OBJECT_CLASS(klass)->finalize = dispatch_engine_finalize;
  IBUS_ENGINE_CLASS(klass)->set_cursor_location = cursor_callback;
  IBUS_ENGINE_CLASS(klass)->set_capabilities = capabilities_callback;
  IBUS_ENGINE_CLASS(klass)->set_content_type = content_callback;
  IBUS_ENGINE_CLASS(klass)->process_key_event = process_key;
}
static void dispatch_engine_init(DispatchEngine *engine) {
  ++engines_constructed;
  last_created = IBUS_ENGINE(engine);
  g_object_add_weak_pointer(G_OBJECT(engine), (gpointer *)&last_created);
}

static GByteArray *request(guint16 kind, guint32 ic, GVariant *payload) {
  g_variant_ref_sink(payload);
  GByteArray *bytes = g_byte_array_new();
  IBusWebRequestHeader header = {GUINT16_TO_LE(kind), 0, GUINT32_TO_LE(ic)};
  g_byte_array_append(bytes, (const guint8 *)&header, sizeof header);
  g_byte_array_append(bytes, g_variant_get_data(payload),
                      g_variant_get_size(payload));
  g_variant_unref(payload);
  return bytes;
}

static gint send(guint16 kind, guint32 ic, GVariant *payload) {
  GByteArray *bytes = request(kind, ic, payload);
  gint result = ibusweb_dispatch(bytes->data, bytes->len);
  g_byte_array_unref(bytes);
  return result;
}

static GVariant *snapshot(guint version) {
  GVariantBuilder builder;
  g_variant_builder_init(&builder, G_VARIANT_TYPE("a(ssa{sv})"));
  g_variant_builder_add_parsed(&builder,
                               "('review', '/review/', {'value': <true>})");
  return g_variant_new("(u@a(ssa{sv}))", version,
                       g_variant_builder_end(&builder));
}

static void empty_output(void) {
  guint32 length;
  g_assert_null(ibusweb_output_peek(&length));
  g_assert_cmpuint(length, ==, 0);
}

static void expect_log(GLogLevelFlags expected_level,
                       const gchar *expected_domain,
                       const gchar *expected_message) {
  guint32 length;
  const guint8 *data = ibusweb_output_peek(&length);
  g_assert_nonnull(data);
  g_assert_cmpuint(length, >=, sizeof(IBusWebRecordHeader));
  IBusWebRecordHeader header;
  memcpy(&header, data, sizeof header);
  g_assert_cmpuint(GUINT16_FROM_LE(header.kind), ==, IBUSWEB_REC_LOG);
  g_assert_cmpuint(GUINT32_FROM_LE(header.ic), ==, 0);
  guint payload_length = GUINT32_FROM_LE(header.len);
  GVariant *payload = g_variant_ref_sink(
      g_variant_new_from_data(G_VARIANT_TYPE("(uss)"), data + sizeof header,
                              payload_length, FALSE, NULL, NULL));
  g_assert_true(g_variant_is_normal_form(payload));
  guint level;
  const gchar *domain, *message;
  g_variant_get(payload, "(u&s&s)", &level, &domain, &message);
  g_assert_cmpuint(level & G_LOG_LEVEL_MASK, ==, expected_level);
  g_assert_cmpstr(domain, ==, expected_domain);
  g_assert_nonnull(strstr(message, expected_message));
  g_variant_unref(payload);
  ibusweb_output_consume((sizeof header + payload_length + 7) & ~7u);
  empty_output();
}

/* Drops the debug records G_MESSAGES_DEBUG lets GLib write. */
static void skip_debug_logs(void) {
  for (;;) {
    guint32 length;
    const guint8 *data = ibusweb_output_peek(&length);
    if (data == NULL)
      return;
    IBusWebRecordHeader header;
    memcpy(&header, data, sizeof header);
    guint payload_length = GUINT32_FROM_LE(header.len);
    if (GUINT16_FROM_LE(header.kind) != IBUSWEB_REC_LOG)
      return;
    GVariant *payload = g_variant_ref_sink(
        g_variant_new_from_data(G_VARIANT_TYPE("(uss)"), data + sizeof header,
                                payload_length, FALSE, NULL, NULL));
    guint level;
    g_variant_get_child(payload, 0, "u", &level);
    g_variant_unref(payload);
    if ((level & G_LOG_LEVEL_MASK) != G_LOG_LEVEL_DEBUG)
      return;
    ibusweb_output_consume((sizeof header + payload_length + 7) & ~7u);
  }
}

static void expect_create_failed(guint32 expected_ic, const gchar *expected) {
  guint32 length;
  const guint8 *data = ibusweb_output_peek(&length);
  g_assert_nonnull(data);
  g_assert_cmpuint(length, >=, sizeof(IBusWebRecordHeader));
  IBusWebRecordHeader header;
  memcpy(&header, data, sizeof header);
  g_assert_cmpuint(GUINT16_FROM_LE(header.kind), ==,
                   IBUSWEB_REC_CREATE_ENGINE_FAILED);
  g_assert_cmpuint(GUINT32_FROM_LE(header.ic), ==, expected_ic);

  guint payload_length = GUINT32_FROM_LE(header.len);
  GVariant *payload = g_variant_ref_sink(
      g_variant_new_from_data(G_VARIANT_TYPE("(s)"), data + sizeof header,
                              payload_length, FALSE, NULL, NULL));
  g_assert_true(g_variant_is_normal_form(payload));
  const gchar *message;
  g_variant_get(payload, "(&s)", &message);
  g_assert_cmpstr(message, ==, expected);
  g_variant_unref(payload);

  ibusweb_output_consume((sizeof header + payload_length + 7) & ~7u);
  empty_output();
}

typedef struct {
  GVariant *expected;
  guint calls;
} Observation;

static gboolean observe(GSignalInvocationHint *hint G_GNUC_UNUSED, guint count,
                        const GValue *values, gpointer data) {
  Observation *observation = data;
  ++observation->calls;
  g_assert_true(G_TYPE_CHECK_INSTANCE_TYPE(g_value_get_object(&values[0]),
                                           dispatch_engine_get_type()));
  g_assert_cmpuint(count - 1, ==, g_variant_n_children(observation->expected));
  for (guint i = 1; i < count; ++i) {
    GVariant *expected =
        g_variant_get_child_value(observation->expected, i - 1);
    GVariant *actual;
    if (G_VALUE_HOLDS_OBJECT(&values[i]))
      actual = g_variant_new_variant(
          ibus_serializable_serialize(g_value_get_object(&values[i])));
    else
      actual =
          g_dbus_gvalue_to_gvariant(&values[i], g_variant_get_type(expected));
    g_variant_take_ref(actual);
    g_assert_true(g_variant_equal(actual, expected));
    g_variant_unref(actual);
    g_variant_unref(expected);
  }
  return TRUE;
}

static void route(guint16 kind, const gchar *signal, GVariant *payload,
                  gint reply) {
  Observation observation = {g_variant_ref_sink(payload), 0};
  guint id = g_signal_lookup(signal, IBUS_TYPE_ENGINE);
  g_assert_cmpuint(id, !=, 0);
  gulong hook = g_signal_add_emission_hook(id, 0, observe, &observation, NULL);
  g_assert_cmpint(send(kind, 7, payload), ==, reply);
  g_assert_cmpuint(observation.calls, ==, 1);
  g_signal_remove_emission_hook(id, hook);
  g_variant_unref(observation.expected);
}

static gboolean count(GSignalInvocationHint *hint G_GNUC_UNUSED,
                      guint n_values G_GNUC_UNUSED,
                      const GValue *values G_GNUC_UNUSED, gpointer data) {
  ++*(guint *)data;
  return TRUE;
}

static void route_unchanged(guint16 kind, const gchar *signal,
                            GVariant *payload) {
  guint id = g_signal_lookup(signal, IBUS_TYPE_ENGINE);
  guint emissions = 0;
  gulong hook = g_signal_add_emission_hook(id, 0, count, &emissions, NULL);
  g_assert_cmpint(send(kind, 7, payload), ==, 0);
  g_assert_cmpuint(emissions, ==, 0);
  g_signal_remove_emission_hook(id, hook);
}

static gpointer wrong_thread(gpointer data G_GNUC_UNUSED) {
  g_assert_cmpint(send(IBUSWEB_REQ_RESET, 7, g_variant_new("()")), ==, -EPERM);
  return NULL;
}

static void routing(void) {
  route(IBUSWEB_REQ_PROCESS_KEY_EVENT, "process-key-event",
        g_variant_new("(uuu)", IBUS_a, 38u, 4u), 1);
  route(IBUSWEB_REQ_PROCESS_KEY_EVENT, "process-key-event",
        g_variant_new("(uuu)", IBUS_b, 56u, 0u), 0);
  const struct {
    guint16 kind;
    const gchar *signal;
  } zero[] = {
      {IBUSWEB_REQ_FOCUS_IN, "focus-in"},
      {IBUSWEB_REQ_FOCUS_OUT, "focus-out"},
      {IBUSWEB_REQ_RESET, "reset"},
      {IBUSWEB_REQ_ENABLE, "enable"},
      {IBUSWEB_REQ_DISABLE, "disable"},
      {IBUSWEB_REQ_PAGE_UP, "page-up"},
      {IBUSWEB_REQ_PAGE_DOWN, "page-down"},
      {IBUSWEB_REQ_CURSOR_UP, "cursor-up"},
      {IBUSWEB_REQ_CURSOR_DOWN, "cursor-down"},
  };
  for (guint i = 0; i < G_N_ELEMENTS(zero); ++i)
    route(zero[i].kind, zero[i].signal, g_variant_new("()"), 0);
  route(IBUSWEB_REQ_SET_CURSOR_LOCATION, "set-cursor-location",
        g_variant_new("(iiii)", -4, 8, 12, 16), 0);
  route(IBUSWEB_REQ_SET_CAPABILITIES, "set-capabilities",
        g_variant_new("(u)", 127u), 0);
  route(IBUSWEB_REQ_CANDIDATE_CLICKED, "candidate-clicked",
        g_variant_new("(uuu)", 2u, 1u, 4u), 0);
  route(IBUSWEB_REQ_PROPERTY_ACTIVATE, "property-activate",
        g_variant_new("(su)", "mode", 1u), 0);
  route(IBUSWEB_REQ_SET_CONTENT_TYPE, "set-content-type",
        g_variant_new("(uu)", 3u, 5u), 0);
  route_unchanged(IBUSWEB_REQ_SET_CONTENT_TYPE, "set-content-type",
                  g_variant_new("(uu)", 3u, 5u));
  IBusText *text = g_object_ref_sink(ibus_text_new_from_string("한글"));
  ibus_text_append_attribute(text, IBUS_ATTR_TYPE_UNDERLINE,
                             IBUS_ATTR_UNDERLINE_SINGLE, 0, 2);
  ibus_serializable_set_attachment(IBUS_SERIALIZABLE(text), "annotation",
                                   g_variant_new_string("metadata"));
  route(IBUSWEB_REQ_SET_SURROUNDING_TEXT, "set-surrounding-text",
        g_variant_new("(vuu)",
                      ibus_serializable_serialize(IBUS_SERIALIZABLE(text)), 2u,
                      1u),
        0);
  g_object_unref(text);
}

static void retained_surrounding(void) {
  IBusText *text = g_object_ref_sink(ibus_text_new_from_string("cached"));
  ibus_serializable_set_attachment(IBUS_SERIALIZABLE(text), "annotation",
                                   g_variant_new_string("retained metadata"));
  GByteArray *bytes =
      request(IBUSWEB_REQ_SET_SURROUNDING_TEXT, 7,
              g_variant_new(
                  "(vuu)", ibus_serializable_serialize(IBUS_SERIALIZABLE(text)),
                  2u, 1u));
  g_object_unref(text);
  g_assert_cmpint(ibusweb_dispatch(bytes->data, bytes->len), ==, 0);
  memset(bytes->data, 0, bytes->len);
  guint cursor, anchor;
  ibus_engine_get_surrounding_text(last_created, &text, &cursor, &anchor);
  GVariant *attachment =
      ibus_serializable_get_attachment(IBUS_SERIALIZABLE(text), "annotation");
  g_assert_nonnull(attachment);
  g_assert_cmpstr(g_variant_get_string(attachment, NULL), ==,
                  "retained metadata");
  g_object_unref(text);
  g_byte_array_unref(bytes);
  guint32 length;
  const guint8 *output = ibusweb_output_peek(&length);
  IBusWebRecordHeader header;
  g_assert_cmpuint(length, >=, sizeof header);
  memcpy(&header, output, sizeof header);
  g_assert_cmpuint(GUINT16_FROM_LE(header.kind), ==,
                   IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT);
  ibusweb_output_consume(length);
}

static void malformed(void) {
  g_assert_cmpint(ibusweb_dispatch(NULL, 0), ==, -EBADMSG);
  g_assert_cmpint(send(65535, 7, g_variant_new("()")), ==, -ENOSYS);
  GByteArray *bytes = request(IBUSWEB_REQ_PROCESS_KEY_EVENT, 7,
                              g_variant_new("(uuu)", IBUS_a, 38u, 0u));
  g_assert_cmpint(ibusweb_dispatch(bytes->data, bytes->len - 1), ==, -EBADMSG);
  bytes->data[2] = 1;
  g_assert_cmpint(ibusweb_dispatch(bytes->data, bytes->len), ==, -EBADMSG);
  bytes->data[2] = 0;
  guint8 *misaligned = g_malloc(bytes->len + 1);
  memcpy(misaligned + 1, bytes->data, bytes->len);
  g_assert_cmpint(ibusweb_dispatch(misaligned + 1, bytes->len), ==, 1);
  g_free(misaligned);
  g_byte_array_unref(bytes);
  g_assert_cmpint(
      send(IBUSWEB_REQ_PROCESS_KEY_EVENT, 7, g_variant_new("(s)", "wrong")), ==,
      -EBADMSG);
  g_assert_cmpint(
      send(IBUSWEB_REQ_SET_SURROUNDING_TEXT, 7,
           g_variant_new("(vuu)", g_variant_new_uint32(42), 0u, 0u)),
      ==, -EBADMSG);
  GVariant *incomplete_text = g_variant_new("(s)", "IBusText");
  g_assert_cmpint(send(IBUSWEB_REQ_SET_SURROUNDING_TEXT, 7,
                       g_variant_new("(vuu)", incomplete_text, 0u, 0u)),
                  ==, -EBADMSG);
  IBusAttribute *attribute = g_object_ref_sink(ibus_attribute_new(1, 2, 0, 1));
  g_assert_cmpint(send(IBUSWEB_REQ_SET_SURROUNDING_TEXT, 7,
                       g_variant_new("(vuu)",
                                     ibus_serializable_serialize(
                                         IBUS_SERIALIZABLE(attribute)),
                                     0u, 0u)),
                  ==, -EBADMSG);
  g_object_unref(attribute);
  GVariant *invalid_attributes =
      g_variant_new("(s@a{sv}sv)", "IBusText",
                    g_variant_new_array(G_VARIANT_TYPE("{sv}"), NULL, 0),
                    "text", g_variant_new_uint32(42));
  g_assert_cmpint(send(IBUSWEB_REQ_SET_SURROUNDING_TEXT, 7,
                       g_variant_new("(vuu)", invalid_attributes, 0u, 0u)),
                  ==, -EBADMSG);
  IBusText *short_text = g_object_ref_sink(ibus_text_new_from_string("한글"));
  GVariant *serialized =
      ibus_serializable_serialize(IBUS_SERIALIZABLE(short_text));
  g_variant_ref_sink(serialized);
  g_object_unref(short_text);
  guint id = g_signal_lookup("set-surrounding-text", IBUS_TYPE_ENGINE);
  guint emissions = 0;
  gulong hook = g_signal_add_emission_hook(id, 0, count, &emissions, NULL);
  g_assert_cmpint(send(IBUSWEB_REQ_SET_SURROUNDING_TEXT, 7,
                       g_variant_new("(vuu)", serialized, 3u, 0u)),
                  ==, -EINVAL);
  g_assert_cmpint(send(IBUSWEB_REQ_SET_SURROUNDING_TEXT, 7,
                       g_variant_new("(vuu)", serialized, 0u, 3u)),
                  ==, -EINVAL);
  g_assert_cmpuint(emissions, ==, 0);
  g_signal_remove_emission_hook(id, hook);
  g_variant_unref(serialized);
  GThread *thread = g_thread_new("dispatch", wrong_thread, NULL);
  g_thread_join(thread);
  empty_output();
}

static void logging(void) {
  g_log("review", G_LOG_LEVEL_WARNING, "warning after init");
  expect_log(G_LOG_LEVEL_WARNING, "review", "warning after init");
  g_log(NULL, G_LOG_LEVEL_MESSAGE, "message after init");
  expect_log(G_LOG_LEVEL_MESSAGE, "", "message after init");
  const GLogField fields[] = {{"GLIB_DOMAIN", "review-extra", 6},
                              {"MESSAGE", "message-extra", 7}};
  g_log_structured_array(G_LOG_LEVEL_WARNING, fields, G_N_ELEMENTS(fields));
  expect_log(G_LOG_LEVEL_WARNING, "review", "message");
  g_log("review", G_LOG_LEVEL_DEBUG, "debug after init");
  if (g_strcmp0(g_getenv("G_MESSAGES_DEBUG"), "all") == 0)
    expect_log(G_LOG_LEVEL_DEBUG, "review", "debug after init");
  else
    empty_output();
}

static gboolean survive_fatal(const gchar *domain G_GNUC_UNUSED,
                              GLogLevelFlags level G_GNUC_UNUSED,
                              const gchar *message G_GNUC_UNUSED,
                              gpointer data) {
  ++*(guint *)data;
  return FALSE;
}

/* A message made fatal by the always-fatal mask reaches the writer without
 * G_LOG_FLAG_FATAL. The process ends before anyone reads the output, so the
 * diagnostic has to reach stderr as well. */
static void fatal_logging(void) {
  g_autofree gchar *path = NULL;
  gint capture = g_file_open_tmp("dispatch-stderr-XXXXXX", &path, NULL);
  g_assert_cmpint(capture, >=, 0);
  gint saved = dup(STDERR_FILENO);
  g_assert_cmpint(saved, >=, 0);
  guint fatal_calls = 0;
  g_test_log_set_fatal_handler(survive_fatal, &fatal_calls);
  GLogLevelFlags mask =
      g_log_set_always_fatal(G_LOG_LEVEL_ERROR | G_LOG_LEVEL_WARNING);
  fflush(stderr);
  g_assert_cmpint(dup2(capture, STDERR_FILENO), ==, STDERR_FILENO);
  g_log("review", G_LOG_LEVEL_WARNING, "fatal warning after init");
  fflush(stderr);
  g_assert_cmpint(dup2(saved, STDERR_FILENO), ==, STDERR_FILENO);
  g_log_set_always_fatal(mask);
  g_test_log_set_fatal_handler(NULL, NULL);
  close(saved);
  close(capture);
  g_assert_cmpuint(fatal_calls, ==, 1);
  expect_log(G_LOG_LEVEL_WARNING, "review", "fatal warning after init");
  g_autofree gchar *written = NULL;
  g_assert_true(g_file_get_contents(path, &written, NULL, NULL));
  unlink(path);
  g_assert_nonnull(strstr(written, "fatal warning after init"));
}

static void set_flag(gpointer data) { *(gboolean *)data = TRUE; }

/* An engine a reference outlives DestroyEngine for must not emit under the
 * context a new engine has taken. */
static void stale_engine(void) {
  IBusEngine *old = g_object_ref(last_created);
  g_assert_cmpint(send(IBUSWEB_REQ_DESTROY_ENGINE, 7, g_variant_new("()")), ==,
                  0);
  g_assert_cmpint(
      send(IBUSWEB_REQ_CREATE_ENGINE, 7, g_variant_new("(s)", "test")), ==, 0);
  g_assert_true(last_created != old);
  ibus_engine_commit_text(old, ibus_text_new_from_string("stale"));
  ibus_engine_show_preedit_text(old);
  ibus_engine_forward_key_event(old, IBUS_a, 38, 0);
  empty_output();
  g_object_unref(old);
}

static IBusEngine *refuse(IBusFactory *factory, const gchar *name,
                          gpointer data G_GNUC_UNUSED) {
  if (g_str_equal(name, "refused"))
    ibusweb_factory_fail_create("refused.table:9: line 9 has no tab");
  else if (g_str_equal(name, "silent"))
    g_signal_stop_emission_by_name(factory, "create-engine");
  else if (g_str_equal(name, "refused-with-engine")) {
    IBusEngine *engine = ibus_engine_new_with_type(
        dispatch_engine_get_type(), name, "/org/freedesktop/IBus/Engine/99",
        ibus_service_get_connection(IBUS_SERVICE(factory)));
    ibusweb_factory_fail_create("handler refused after building an engine");
    return engine;
  }
  return NULL;
}

/* Registered engines that aren't made: a handler's reason reaches the host
 * on the request's context ahead of the reply, and stops the factory from
 * making the engine anyway. An engine the failing handler built is destroyed
 * rather than adopted. */
static void refusals(void) {
  guint constructed = engines_constructed;
  guint finalized = engines_finalized;

  g_assert_cmpint(
      send(IBUSWEB_REQ_CREATE_ENGINE, 9, g_variant_new("(s)", "refused")), ==,
      -EIO);
  skip_debug_logs();
  expect_create_failed(9, "refused.table:9: line 9 has no tab");
  g_assert_cmpuint(engines_constructed, ==, constructed);

  g_assert_cmpint(
      send(IBUSWEB_REQ_CREATE_ENGINE, 9, g_variant_new("(s)", "silent")), ==,
      -EIO);
  skip_debug_logs();
  empty_output();
  g_assert_null(last_created);
  g_assert_cmpuint(engines_constructed, ==, constructed);

  g_assert_cmpint(send(IBUSWEB_REQ_CREATE_ENGINE, 9,
                       g_variant_new("(s)", "refused-with-engine")),
                  ==, -EIO);
  skip_debug_logs();
  expect_create_failed(9, "handler refused after building an engine");
  g_assert_null(last_created);
  g_assert_cmpuint(engines_constructed, ==, constructed + 1);
  g_assert_cmpuint(engines_finalized, ==, finalized + 1);

  ibusweb_factory_fail_create("outside");
  expect_log(G_LOG_LEVEL_CRITICAL, "ibus-web", "outside a CreateEngine");
}

static GString *persisted;

static void persist_first(void) { g_string_append(persisted, "first "); }

static void persist_second(void) { g_string_append(persisted, "second "); }

static void first_module(IBusWebModule *module) {
  g_assert_cmpint(ibusweb_module_set_persist(module, persist_first), ==, 0);
}

static void second_module(IBusWebModule *module) {
  g_assert_cmpint(ibusweb_module_set_persist(module, persist_second), ==, 0);
}

static void refused_module(IBusWebModule *module) {
  g_assert_cmpint(ibusweb_module_set_persist(module, persist_first), ==, 0);
  g_assert_cmpint(ibusweb_module_set_persist(module, NULL), ==, -EINVAL);
}

/* Persist reaches every registered module once, in the order they were
 * registered, whatever the header's ic; a module whose registration failed
 * isn't among them. */
static void persisting(void) {
  persisted = g_string_new(NULL);
  g_assert_cmpint(ibusweb_register_module("first", first_module, NULL), ==, 0);
  g_assert_cmpint(ibusweb_register_module("refused", refused_module, NULL), ==,
                  -EINVAL);
  g_assert_cmpint(ibusweb_register_module("second", second_module, NULL), ==,
                  0);

  g_assert_cmpint(send(IBUSWEB_REQ_PERSIST, 0, g_variant_new("()")), ==, 0);
  g_assert_cmpint(send(IBUSWEB_REQ_PERSIST, 42, g_variant_new("()")), ==, 0);
  g_assert_cmpstr(persisted->str, ==, "first second first second ");
  empty_output();
  g_string_free(persisted, TRUE);
}

static void protocol(void) {
  static gint32 wake_word;
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, 0);
  g_log("review", G_LOG_LEVEL_MESSAGE, "message before init");
  empty_output();
  g_assert_cmpint(
      send(IBUSWEB_REQ_CREATE_ENGINE, 7, g_variant_new("(s)", "test")), ==,
      -ENOTCONN);
  g_assert_cmpint(send(IBUSWEB_REQ_PERSIST, 0, g_variant_new("()")), ==,
                  -ENOTCONN);
  g_assert_cmpint(send(IBUSWEB_REQ_INIT, 0, snapshot(2)), ==, -EPROTO);
  g_assert_cmpint(send(IBUSWEB_REQ_INIT, 0, snapshot(IBUSWEB_PROTOCOL_VERSION)),
                  ==, 0);
  skip_debug_logs();
  expect_log(G_LOG_LEVEL_WARNING, "ibus-web",
             "Unknown settings schema: review");
  g_assert_cmpint(send(IBUSWEB_REQ_INIT, 0, snapshot(IBUSWEB_PROTOCOL_VERSION)),
                  ==, -EALREADY);
  persisting();
  g_assert_cmpint(
      send(IBUSWEB_REQ_CREATE_ENGINE, 7, g_variant_new("(s)", "missing")), ==,
      -ESRCH);
  IBusFactory *factory = g_object_ref_sink(ibus_factory_new(NULL));
  ibus_factory_add_engine(factory, "test", dispatch_engine_get_type());
  ibus_factory_add_engine(factory, "refused", dispatch_engine_get_type());
  ibus_factory_add_engine(factory, "silent", dispatch_engine_get_type());
  ibus_factory_add_engine(factory, "refused-with-engine",
                          dispatch_engine_get_type());
  g_signal_connect(factory, "create-engine", G_CALLBACK(refuse), NULL);
  g_object_unref(factory);
  refusals();
  g_assert_cmpint(
      send(IBUSWEB_REQ_CREATE_ENGINE, 7, g_variant_new("(s)", "test")), ==, 0);
  g_assert_cmpint(
      send(IBUSWEB_REQ_CREATE_ENGINE, 7, g_variant_new("(s)", "test")), ==,
      -EEXIST);
  g_assert_cmpint(send(IBUSWEB_REQ_RESET, 8, g_variant_new("()")), ==, -ENOENT);
  gulong cursor_handler = g_signal_connect(last_created, "set-cursor-location",
                                           G_CALLBACK(connected_cursor), NULL);
  gulong caps_handler =
      g_signal_connect(last_created, "set-capabilities",
                       G_CALLBACK(connected_capabilities), NULL);
  gulong content_handler = g_signal_connect(
      last_created, "set-content-type", G_CALLBACK(connected_content), NULL);
  routing();
  g_assert_cmpuint(cache_callbacks, ==, 6);
  check_cursor(last_created, -4, 8, 12, 16);
  check_capabilities(last_created, 127);
  check_content(last_created, 3, 5);
  g_signal_handler_disconnect(last_created, cursor_handler);
  g_signal_handler_disconnect(last_created, caps_handler);
  g_signal_handler_disconnect(last_created, content_handler);
  retained_surrounding();
  malformed();
  g_assert_cmpint(send(IBUSWEB_REQ_SETTING_CHANGED, 0,
                       g_variant_new("(ssv)", "/review/", "value",
                                     g_variant_new_boolean(TRUE))),
                  ==, -ENOENT);
  expect_log(G_LOG_LEVEL_WARNING, "ibus-web",
             "Unknown settings path: /review/");
  logging();
  fatal_logging();
  g_assert_cmpint(send(IBUSWEB_REQ_DESTROY_ENGINE, 7, g_variant_new("()")), ==,
                  0);
  g_assert_null(last_created);
  g_assert_cmpint(send(IBUSWEB_REQ_DESTROY_ENGINE, 7, g_variant_new("()")), ==,
                  -ENOENT);
  g_assert_cmpint(
      send(IBUSWEB_REQ_CREATE_ENGINE, 7, g_variant_new("(s)", "test")), ==, 0);
  stale_engine();
  g_assert_cmpint(send(IBUSWEB_REQ_PROCESS_KEY_EVENT, 7,
                       g_variant_new("(uuu)", 999u, 0u, 0u)),
                  ==, -ECANCELED);
  expect_log(G_LOG_LEVEL_WARNING, "ibus-web", "thrown by an engine");
  g_assert_cmpint(send(IBUSWEB_REQ_RESET, 7, g_variant_new("()")), ==,
                  -ENOTRECOVERABLE);
  gboolean ran = FALSE;
  g_idle_add_once(set_flag, &ran);
  g_assert_cmpint(ibusweb_pump(), ==, -1);
  g_assert_false(ran);
  empty_output();
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  /* TAP's handler consumes legacy logs before they reach a structured writer.
   */
  g_log_set_default_handler(g_log_default_handler, NULL);
  g_log_set_always_fatal(G_LOG_LEVEL_ERROR);
  g_test_add_func("/dispatch/protocol", protocol);
  return g_test_run();
}
