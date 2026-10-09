/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include "../src/ibus/ibusweb-private.h"
#define IBUSWEB_TESTS
#include "../src/output.h"
#include <errno.h>
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <ibus.h>
#include <stdio.h>
#include <string.h>

static int32_t wake_word;

static void clear_output(void) {
  uint32_t len;
  ibusweb_output_peek(&len);
  ibusweb_output_consume(len);
}

static GVariant *first_record(uint16_t kind, uint32_t ic, uint32_t seq,
                              uint32_t *record_size) {
  uint32_t available;
  const uint8_t *data = ibusweb_output_peek(&available);
  g_assert_nonnull(data);
  g_assert_cmpuint(available, >=, sizeof(IBusWebRecordHeader));
  IBusWebRecordHeader header;
  memcpy(&header, data, sizeof header);
  g_assert_cmpuint(GUINT32_FROM_LE(header.ic), ==, ic);
  g_assert_cmpuint(GUINT32_FROM_LE(header.seq), ==, seq);
  g_assert_cmpuint(GUINT16_FROM_LE(header.kind), ==, kind);
  g_assert_cmpuint(header.flags, ==, 0);
  uint32_t len = GUINT32_FROM_LE(header.len);
  *record_size = (sizeof header + len + 7) & ~7u;
  g_assert_cmpuint(available, >=, *record_size);
  for (uint32_t i = sizeof header + len; i < *record_size; i++)
    g_assert_cmpuint(data[i], ==, 0);
  GBytes *bytes = g_bytes_new(data + sizeof header, len);
  GVariant *payload = g_variant_ref_sink(g_variant_new_from_bytes(
      G_VARIANT_TYPE(ibusweb_record_signature(kind)), bytes, FALSE));
  g_bytes_unref(bytes);
  g_assert_true(g_variant_is_normal_form(payload));
  return payload;
}

static void output_sequence_wrap(void) {
  clear_output();
  ibusweb_output_test_set_seq(G_MAXUINT32);
  ibusweb_output_append(7, IBUSWEB_REC_HIDE_PREEDIT_TEXT, g_variant_new("()"));
  uint32_t size;
  GVariant *payload = first_record(IBUSWEB_REC_HIDE_PREEDIT_TEXT, 7, 1, &size);
  g_variant_unref(payload);
  clear_output();
}

static void output_framing(void) {
  clear_output();
  uint32_t seq = ibusweb_output_last_seq();
  ibusweb_output_append(42, IBUSWEB_REC_FORWARD_KEY_EVENT,
                        g_variant_new("(uuu)", 65u, 38u, 4u));
  ibusweb_output_append(7, IBUSWEB_REC_HIDE_PREEDIT_TEXT, g_variant_new("()"));
  uint32_t size;
  GVariant *payload =
      first_record(IBUSWEB_REC_FORWARD_KEY_EVENT, 42, seq + 1, &size);
  guint key, code, state;
  g_variant_get(payload, "(uuu)", &key, &code, &state);
  g_assert_cmpuint(key, ==, 65);
  g_assert_cmpuint(code, ==, 38);
  g_assert_cmpuint(state, ==, 4);
  g_variant_unref(payload);
  g_test_expect_message("ibus-web", G_LOG_LEVEL_CRITICAL, "*record boundary*");
  ibusweb_output_consume(size - 1);
  g_test_assert_expected_messages();
  payload = first_record(IBUSWEB_REC_FORWARD_KEY_EVENT, 42, seq + 1, &size);
  g_variant_unref(payload);
  ibusweb_output_consume(size);
  payload = first_record(IBUSWEB_REC_HIDE_PREEDIT_TEXT, 7, seq + 2, &size);
  g_assert_cmpstr(g_variant_get_type_string(payload), ==, "()");
  g_variant_unref(payload);
  ibusweb_output_consume(size);
  uint32_t remaining = 99;
  g_assert_null(ibusweb_output_peek(&remaining));
  g_assert_cmpuint(remaining, ==, 0);
  g_assert_cmpuint(ibusweb_output_last_seq(), ==, seq + 2);
}

static gpointer emit_in_thread(gpointer unused) {
  (void)unused;
  ibusweb_output_append(2, IBUSWEB_REC_SHOW_PREEDIT_TEXT, g_variant_new("()"));
  return NULL;
}

static void output_thread(void) {
  clear_output();
  uint32_t seq = ibusweb_output_last_seq();
  ibusweb_output_append(1, IBUSWEB_REC_HIDE_PREEDIT_TEXT, g_variant_new("()"));
  GThread *thread = g_thread_new("emitter", emit_in_thread, NULL);
  g_thread_join(thread);
  g_assert_cmpuint(ibusweb_output_last_seq(), ==, seq + 1);
  ibusweb_pump();
  uint32_t size;
  GVariant *payload =
      first_record(IBUSWEB_REC_HIDE_PREEDIT_TEXT, 1, seq + 1, &size);
  g_variant_unref(payload);
  ibusweb_output_consume(size);
  payload = first_record(IBUSWEB_REC_SHOW_PREEDIT_TEXT, 2, seq + 2, &size);
  g_variant_unref(payload);
  ibusweb_output_consume(size);
}

static gpointer access_in_thread(gpointer unused) {
  (void)unused;
  uint32_t len = 99;
  g_assert_null(ibusweb_output_peek(&len));
  g_assert_cmpuint(len, ==, 0);
  ibusweb_output_consume(1);
  return NULL;
}

static void output_thread_access(void) {
  clear_output();
  ibusweb_output_append(1, IBUSWEB_REC_HIDE_PREEDIT_TEXT, g_variant_new("()"));
  uint32_t before, after;
  ibusweb_output_peek(&before);
  g_test_expect_message("ibus-web", G_LOG_LEVEL_CRITICAL, "*pumping thread*");
  g_test_expect_message("ibus-web", G_LOG_LEVEL_CRITICAL, "*pumping thread*");
  GThread *thread = g_thread_new("reader", access_in_thread, NULL);
  g_thread_join(thread);
  g_test_assert_expected_messages();
  ibusweb_output_peek(&after);
  g_assert_cmpuint(after, ==, before);
  clear_output();
}

static uint32_t expected_seq;

static void expect_record(uint16_t kind, GVariant *expected) {
  uint32_t size;
  GVariant *actual = first_record(kind, 42, ++expected_seq, &size);
  g_variant_ref_sink(expected);
  g_assert_cmpstr(g_variant_get_type_string(actual), ==,
                  g_variant_get_type_string(expected));
  g_assert_true(g_variant_equal(actual, expected));
  g_variant_unref(actual);
  g_variant_unref(expected);
  ibusweb_output_consume(size);
}

static IBusEngine *new_engine(void) {
  IBusEngine *engine =
      g_object_ref_sink(ibus_engine_new("test", "/test", NULL));
  ibusweb_engine_set_ic(engine, 42);
  g_assert_cmpuint(ibusweb_engine_get_ic(engine), ==, 42);
  clear_output();
  expected_seq = ibusweb_output_last_seq();
  return engine;
}

static void emitters(void) {
  IBusEngine *engine = new_engine();
  IBusText *text = g_object_ref_sink(ibus_text_new_from_string("한글"));
  GVariant *wire =
      g_variant_ref_sink(ibus_serializable_serialize(IBUS_SERIALIZABLE(text)));
  ibus_engine_commit_text(engine, text);
  expect_record(IBUSWEB_REC_COMMIT_TEXT, g_variant_new("(v)", wire));
  ibus_engine_update_preedit_text(engine, text, 1, TRUE);
  expect_record(
      IBUSWEB_REC_UPDATE_PREEDIT_TEXT,
      g_variant_new("(vubu)", wire, 1u, TRUE, IBUS_ENGINE_PREEDIT_CLEAR));
  ibus_engine_update_preedit_text_with_mode(engine, text, 2, FALSE,
                                            IBUS_ENGINE_PREEDIT_COMMIT);
  expect_record(
      IBUSWEB_REC_UPDATE_PREEDIT_TEXT,
      g_variant_new("(vubu)", wire, 2u, FALSE, IBUS_ENGINE_PREEDIT_COMMIT));
  ibus_engine_update_auxiliary_text(engine, text, TRUE);
  expect_record(IBUSWEB_REC_UPDATE_AUXILIARY_TEXT,
                g_variant_new("(vb)", wire, TRUE));
  g_variant_unref(wire);
  g_object_unref(text);

  IBusLookupTable *table =
      g_object_ref_sink(ibus_lookup_table_new(5, 0, TRUE, FALSE));
  ibus_lookup_table_append_candidate(table, ibus_text_new_from_string("韓"));
  wire =
      g_variant_ref_sink(ibus_serializable_serialize(IBUS_SERIALIZABLE(table)));
  ibus_engine_update_lookup_table(engine, table, TRUE);
  expect_record(IBUSWEB_REC_UPDATE_LOOKUP_TABLE,
                g_variant_new("(vb)", wire, TRUE));
  ibus_engine_update_lookup_table_fast(engine, table, FALSE);
  expect_record(IBUSWEB_REC_UPDATE_LOOKUP_TABLE,
                g_variant_new("(vb)", wire, FALSE));
  g_variant_unref(wire);
  g_object_unref(table);

  IBusPropList *props = g_object_ref_sink(ibus_prop_list_new());
  IBusProperty *prop = ibus_property_new(
      "mode", PROP_TYPE_TOGGLE, ibus_text_new_from_string("한"), "", NULL, TRUE,
      TRUE, PROP_STATE_CHECKED, NULL);
  ibus_prop_list_append(props, prop);
  wire =
      g_variant_ref_sink(ibus_serializable_serialize(IBUS_SERIALIZABLE(props)));
  ibus_engine_register_properties(engine, props);
  expect_record(IBUSWEB_REC_REGISTER_PROPERTIES, g_variant_new("(v)", wire));
  g_variant_unref(wire);
  wire =
      g_variant_ref_sink(ibus_serializable_serialize(IBUS_SERIALIZABLE(prop)));
  ibus_engine_update_property(engine, prop);
  expect_record(IBUSWEB_REC_UPDATE_PROPERTY, g_variant_new("(v)", wire));
  g_variant_unref(wire);
  g_object_unref(props);

  ibus_engine_show_preedit_text(engine);
  expect_record(IBUSWEB_REC_SHOW_PREEDIT_TEXT, g_variant_new("()"));
  ibus_engine_hide_preedit_text(engine);
  expect_record(IBUSWEB_REC_HIDE_PREEDIT_TEXT, g_variant_new("()"));
  ibus_engine_show_auxiliary_text(engine);
  expect_record(IBUSWEB_REC_SHOW_AUXILIARY_TEXT, g_variant_new("()"));
  ibus_engine_hide_auxiliary_text(engine);
  expect_record(IBUSWEB_REC_HIDE_AUXILIARY_TEXT, g_variant_new("()"));
  ibus_engine_show_lookup_table(engine);
  expect_record(IBUSWEB_REC_SHOW_LOOKUP_TABLE, g_variant_new("()"));
  ibus_engine_hide_lookup_table(engine);
  expect_record(IBUSWEB_REC_HIDE_LOOKUP_TABLE, g_variant_new("()"));
  ibus_engine_forward_key_event(engine, IBUS_space, 57, IBUS_SHIFT_MASK);
  expect_record(IBUSWEB_REC_FORWARD_KEY_EVENT,
                g_variant_new("(uuu)", IBUS_space, 57u, IBUS_SHIFT_MASK));
  g_object_unref(engine);
}

static void emitter_ownership(void) {
  IBusEngine *engine = new_engine();
  IBusText *text = ibus_text_new_from_string("floating");
  g_object_add_weak_pointer(G_OBJECT(text), (gpointer *)&text);
  ibus_engine_commit_text(engine, text);
  g_assert_null(text);
  text = g_object_ref_sink(ibus_text_new_from_string("owned"));
  g_object_add_weak_pointer(G_OBJECT(text), (gpointer *)&text);
  ibus_engine_update_auxiliary_text(engine, text, TRUE);
  g_assert_nonnull(text);
  g_assert_cmpstr(text->text, ==, "owned");
  g_object_unref(text);
  g_assert_null(text);
  IBusLookupTable *table = ibus_lookup_table_new(5, 0, TRUE, FALSE);
  g_object_add_weak_pointer(G_OBJECT(table), (gpointer *)&table);
  ibus_engine_update_lookup_table(engine, table, TRUE);
  g_assert_null(table);
  IBusPropList *props = ibus_prop_list_new();
  g_object_add_weak_pointer(G_OBJECT(props), (gpointer *)&props);
  ibus_engine_register_properties(engine, props);
  g_assert_null(props);
  clear_output();
  g_object_unref(engine);
}

static void fast_lookup(void) {
  IBusEngine *engine = new_engine();
  IBusLookupTable *table = ibus_lookup_table_new(5, 12, TRUE, TRUE);
  ibus_lookup_table_set_orientation(table, IBUS_ORIENTATION_VERTICAL);
  for (guint i = 0; i < 40; i++)
    ibus_lookup_table_append_candidate(
        table, ibus_text_new_from_printf("candidate %u", i));
  ibus_lookup_table_append_label(table, ibus_text_new_from_string("label"));
  g_object_add_weak_pointer(G_OBJECT(table), (gpointer *)&table);
  ibus_engine_update_lookup_table_fast(engine, table, TRUE);
  g_assert_null(table);
  uint32_t size;
  GVariant *payload =
      first_record(IBUSWEB_REC_UPDATE_LOOKUP_TABLE, 42, ++expected_seq, &size);
  GVariant *wire;
  gboolean visible;
  g_variant_get(payload, "(vb)", &wire, &visible);
  table = IBUS_LOOKUP_TABLE(ibus_serializable_deserialize(wire));
  g_assert_true(visible);
  g_assert_cmpuint(table->candidates->len, ==, 15);
  g_assert_cmpuint(table->cursor_pos, ==, 7);
  g_assert_cmpuint(table->page_size, ==, 5);
  g_assert_true(table->round);
  g_assert_cmpint(table->orientation, ==, IBUS_ORIENTATION_VERTICAL);
  g_assert_cmpstr(ibus_lookup_table_get_candidate(table, 0)->text, ==,
                  "candidate 5");
  g_assert_cmpstr(ibus_lookup_table_get_candidate(table, 14)->text, ==,
                  "candidate 19");
  g_assert_cmpstr(ibus_lookup_table_get_label(table, 0)->text, ==, "label");
  g_object_unref(table);
  g_variant_unref(wire);
  g_variant_unref(payload);
  ibusweb_output_consume(size);
  g_object_unref(engine);
}

static void surrounding_text(void) {
  IBusEngine *engine = new_engine();
  IBusText *text;
  guint cursor, anchor;
  ibus_engine_get_surrounding_text(engine, &text, &cursor, &anchor);
  g_assert_cmpstr(text->text, ==, "");
  g_assert_cmpuint(cursor, ==, 0);
  g_assert_cmpuint(anchor, ==, 0);
  g_object_unref(text);
  expect_record(IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT, g_variant_new("()"));
  text = g_object_ref_sink(ibus_text_new_from_string("a한글z"));
  g_signal_emit_by_name(engine, "set-surrounding-text", text, 3u, 1u);
  g_object_unref(text);
  ibus_engine_get_surrounding_text(engine, &text, &cursor, &anchor);
  g_assert_cmpstr(text->text, ==, "a한글z");
  g_assert_cmpuint(cursor, ==, 3);
  g_assert_cmpuint(anchor, ==, 1);
  g_object_unref(text);
  expect_record(IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT, g_variant_new("()"));
  ibus_engine_delete_surrounding_text(engine, -2, 2);
  expect_record(IBUSWEB_REC_DELETE_SURROUNDING_TEXT,
                g_variant_new("(iu)", -2, 2u));
  ibus_engine_get_surrounding_text(engine, &text, &cursor, &anchor);
  g_assert_cmpstr(text->text, ==, "az");
  g_assert_cmpuint(cursor, ==, 1);
  g_assert_cmpuint(anchor, ==, 1);
  g_object_unref(text);
  expect_record(IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT, g_variant_new("()"));
  ibus_engine_get_surrounding_text(engine, NULL, NULL, NULL);
  expect_record(IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT, g_variant_new("()"));
  g_signal_emit_by_name(engine, "set-capabilities", 123u);
  g_assert_cmpuint(engine->client_capabilities, ==, 123);
  g_signal_emit_by_name(engine, "set-content-type", IBUS_INPUT_PURPOSE_NUMBER,
                        IBUS_INPUT_HINT_NO_SPELLCHECK);
  guint purpose, hints;
  ibus_engine_get_content_type(engine, &purpose, &hints);
  g_assert_cmpuint(purpose, ==, IBUS_INPUT_PURPOSE_NUMBER);
  g_assert_cmpuint(hints, ==, IBUS_INPUT_HINT_NO_SPELLCHECK);
  g_object_unref(engine);
}

static void surrounding_bounds(void) {
  const struct {
    guint cursor;
    gint offset;
    guint count;
    const gchar *text;
    guint resulting_cursor;
  } cases[] = {
      {3, -2, 2, "az", 1},      {4, 0, 0, "a한글z", 4},
      {2, 3, 1, "", 0},         {0, -1, 1, "", 0},
      {2, 0, G_MAXUINT, "", 0}, {2, G_MAXINT, 1, "", 0},
      {2, G_MININT, 1, "", 0},  {G_MAXUINT, 2, 1, "", 0},
  };
  for (guint i = 0; i < G_N_ELEMENTS(cases); ++i) {
    g_test_message("deletion boundary %u", i);
    IBusEngine *engine = new_engine();
    IBusText *text = g_object_ref_sink(ibus_text_new_from_string("a한글z"));
    g_signal_emit_by_name(engine, "set-surrounding-text", text, cases[i].cursor,
                          cases[i].cursor);
    g_object_unref(text);
    ibus_engine_delete_surrounding_text(engine, cases[i].offset,
                                        cases[i].count);
    expect_record(IBUSWEB_REC_DELETE_SURROUNDING_TEXT,
                  g_variant_new("(iu)", cases[i].offset, cases[i].count));
    guint cursor, anchor;
    ibus_engine_get_surrounding_text(engine, &text, &cursor, &anchor);
    g_assert_cmpstr(text->text, ==, cases[i].text);
    g_assert_cmpuint(cursor, ==, cases[i].resulting_cursor);
    g_object_unref(text);
    expect_record(IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT, g_variant_new("()"));
    g_object_unref(engine);
  }
}

typedef struct {
  IBusEngine parent;
} TestEngine;
typedef struct {
  IBusEngineClass parent;
} TestEngineClass;
G_DEFINE_TYPE(TestEngine, test_engine, IBUS_TYPE_ENGINE)

typedef struct {
  IBusEngine parent;
} ConstructingEngine;
typedef struct {
  IBusEngineClass parent;
} ConstructingEngineClass;
G_DEFINE_TYPE(ConstructingEngine, constructing_engine, IBUS_TYPE_ENGINE)

/* Emits while it is being made, from its instance init and its constructor,
 * as ibus-m17n's engines do. */
static GObject *constructing_engine_constructor(GType type, guint n,
                                                GObjectConstructParam *params) {
  GObject *object = G_OBJECT_CLASS(constructing_engine_parent_class)
                        ->constructor(type, n, params);
  ibus_engine_hide_auxiliary_text(IBUS_ENGINE(object));
  return object;
}
static void constructing_engine_class_init(ConstructingEngineClass *klass) {
  G_OBJECT_CLASS(klass)->constructor = constructing_engine_constructor;
}
static void constructing_engine_init(ConstructingEngine *engine) {
  ibus_engine_hide_preedit_text(IBUS_ENGINE(engine));
}

static IBusEngine *observed_engine;
static const char *called;
static guint arguments[4];
static char *string_argument;
static IBusText *text_argument;

#define RECORD_EMPTY(name)                                                     \
  static void on_##name(IBusEngine *engine) {                                  \
    g_assert_true(engine == observed_engine);                                  \
    called = #name;                                                            \
  }
RECORD_EMPTY(focus_in)
RECORD_EMPTY(focus_out)
RECORD_EMPTY(reset)
RECORD_EMPTY(enable)
RECORD_EMPTY(disable)
RECORD_EMPTY(page_up)
RECORD_EMPTY(page_down)
RECORD_EMPTY(cursor_up)
RECORD_EMPTY(cursor_down)
#undef RECORD_EMPTY

static gboolean on_key(IBusEngine *engine, guint key, guint code, guint state) {
  g_assert_true(engine == observed_engine);
  called = "key";
  arguments[0] = key;
  arguments[1] = code;
  arguments[2] = state;
  return TRUE;
}
static void on_location(IBusEngine *engine, gint x, gint y, gint w, gint h) {
  g_assert_true(engine == observed_engine);
  called = "location";
  arguments[0] = x;
  arguments[1] = y;
  arguments[2] = w;
  arguments[3] = h;
}
static void on_capabilities(IBusEngine *engine, guint caps) {
  g_assert_true(engine == observed_engine);
  called = "capabilities";
  arguments[0] = caps;
}
static void on_candidate(IBusEngine *engine, guint index, guint button,
                         guint state) {
  g_assert_true(engine == observed_engine);
  called = "candidate";
  arguments[0] = index;
  arguments[1] = button;
  arguments[2] = state;
}
static void on_activate(IBusEngine *engine, const gchar *name, guint state) {
  g_assert_true(engine == observed_engine);
  called = "activate";
  g_set_str(&string_argument, name);
  arguments[0] = state;
}
static void on_show(IBusEngine *engine, const gchar *name) {
  g_assert_true(engine == observed_engine);
  called = "show";
  g_set_str(&string_argument, name);
}
static void on_hide(IBusEngine *engine, const gchar *name) {
  g_assert_true(engine == observed_engine);
  called = "hide";
  g_set_str(&string_argument, name);
}
static void on_surrounding(IBusEngine *engine, IBusText *text, guint cursor,
                           guint anchor) {
  g_assert_true(engine == observed_engine);
  called = "surrounding";
  text_argument = text;
  arguments[0] = cursor;
  arguments[1] = anchor;
}
static void on_content(IBusEngine *engine, guint purpose, guint hints) {
  g_assert_true(engine == observed_engine);
  called = "content";
  arguments[0] = purpose;
  arguments[1] = hints;
}
static void on_focus_in_id(IBusEngine *engine, const gchar *path,
                           const gchar *client) {
  g_assert_true(engine == observed_engine);
  called = "focus-in-id";
  g_set_str(&string_argument, path);
  g_assert_cmpstr(client, ==, "client");
}
static void on_focus_out_id(IBusEngine *engine, const gchar *path) {
  g_assert_true(engine == observed_engine);
  called = "focus-out-id";
  g_set_str(&string_argument, path);
}
static void test_engine_class_init(TestEngineClass *klass) {
  IBusEngineClass *engine = IBUS_ENGINE_CLASS(klass);
  engine->process_key_event = on_key;
  engine->focus_in = on_focus_in;
  engine->focus_out = on_focus_out;
  engine->reset = on_reset;
  engine->enable = on_enable;
  engine->disable = on_disable;
  engine->page_up = on_page_up;
  engine->page_down = on_page_down;
  engine->cursor_up = on_cursor_up;
  engine->cursor_down = on_cursor_down;
  engine->set_cursor_location = on_location;
  engine->set_capabilities = on_capabilities;
  engine->candidate_clicked = on_candidate;
  engine->property_activate = on_activate;
  engine->property_show = on_show;
  engine->property_hide = on_hide;
  engine->set_surrounding_text = on_surrounding;
  engine->set_content_type = on_content;
  engine->focus_in_id = on_focus_in_id;
  engine->focus_out_id = on_focus_out_id;
}
static void test_engine_init(TestEngine *engine) { (void)engine; }

static void signal_dispatch(void) {
  observed_engine =
      g_object_ref_sink(g_object_new(test_engine_get_type(), NULL));
  const struct {
    const char *signal;
    const char *callback;
  } empty[] = {
      {"focus-in", "focus_in"},
      {"focus-out", "focus_out"},
      {"reset", "reset"},
      {"enable", "enable"},
      {"disable", "disable"},
      {"page-up", "page_up"},
      {"page-down", "page_down"},
      {"cursor-up", "cursor_up"},
      {"cursor-down", "cursor_down"},
  };
  for (guint i = 0; i < G_N_ELEMENTS(empty); i++) {
    called = NULL;
    g_signal_emit_by_name(observed_engine, empty[i].signal);
    g_assert_cmpstr(called, ==, empty[i].callback);
    GSignalQuery query;
    g_signal_query(g_signal_lookup(empty[i].signal, IBUS_TYPE_ENGINE), &query);
    g_assert_cmpuint(query.signal_flags, ==, G_SIGNAL_RUN_LAST);
  }
  gboolean handled = FALSE;
  g_signal_emit_by_name(observed_engine, "process-key-event", 65u, 38u, 4u,
                        &handled);
  g_assert_true(handled);
  g_assert_cmpstr(called, ==, "key");
  g_assert_cmpuint(arguments[0], ==, 65);
  g_assert_cmpuint(arguments[1], ==, 38);
  g_assert_cmpuint(arguments[2], ==, 4);
  g_signal_emit_by_name(observed_engine, "set-cursor-location", -1, 2, 3, 4);
  g_assert_cmpstr(called, ==, "location");
  g_assert_cmpint((gint)arguments[0], ==, -1);
  g_assert_cmpuint(arguments[1], ==, 2);
  g_assert_cmpuint(arguments[2], ==, 3);
  g_assert_cmpuint(arguments[3], ==, 4);
  g_signal_emit_by_name(observed_engine, "set-capabilities", 23u);
  g_assert_cmpstr(called, ==, "capabilities");
  g_assert_cmpuint(arguments[0], ==, 23);
  g_signal_emit_by_name(observed_engine, "candidate-clicked", 2u, 3u, 4u);
  g_assert_cmpstr(called, ==, "candidate");
  g_assert_cmpuint(arguments[0], ==, 2);
  g_assert_cmpuint(arguments[1], ==, 3);
  g_assert_cmpuint(arguments[2], ==, 4);
  g_signal_emit_by_name(observed_engine, "property-activate", "mode", 7u);
  g_assert_cmpstr(called, ==, "activate");
  g_assert_cmpstr(string_argument, ==, "mode");
  g_assert_cmpuint(arguments[0], ==, 7);
  g_signal_emit_by_name(observed_engine, "property-show", "show");
  g_assert_cmpstr(called, ==, "show");
  g_assert_cmpstr(string_argument, ==, "show");
  g_signal_emit_by_name(observed_engine, "property-hide", "hide");
  g_assert_cmpstr(called, ==, "hide");
  g_assert_cmpstr(string_argument, ==, "hide");
  IBusText *text = g_object_ref_sink(ibus_text_new_from_string("주변"));
  g_signal_emit_by_name(observed_engine, "set-surrounding-text", text, 1u, 2u);
  g_assert_cmpstr(called, ==, "surrounding");
  g_assert_true(text_argument == text);
  g_assert_cmpuint(arguments[0], ==, 1);
  g_assert_cmpuint(arguments[1], ==, 2);
  g_object_unref(text);
  g_signal_emit_by_name(observed_engine, "set-content-type", 5u, 6u);
  g_assert_cmpstr(called, ==, "content");
  g_assert_cmpuint(arguments[0], ==, 5);
  g_assert_cmpuint(arguments[1], ==, 6);
  g_signal_emit_by_name(observed_engine, "focus-in-id", "/ic", "client");
  g_assert_cmpstr(called, ==, "focus-in-id");
  g_assert_cmpstr(string_argument, ==, "/ic");
  g_signal_emit_by_name(observed_engine, "focus-out-id", "/ic");
  g_assert_cmpstr(called, ==, "focus-out-id");
  g_assert_cmpstr(string_argument, ==, "/ic");
  g_object_unref(observed_engine);
  observed_engine = NULL;
  g_clear_pointer(&string_argument, g_free);
}

static void factory(void) {
  IBusFactory *factory = ibus_factory_new(NULL);
  g_assert_nonnull(factory);
  g_object_ref_sink(factory);
  ibus_factory_add_engine(factory, "test", test_engine_get_type());
  int error = 0;
  IBusEngine *engine = ibusweb_factory_create(19, "test", &error);
  g_assert_cmpint(error, ==, 0);
  g_assert_nonnull(engine);
  g_assert_cmpuint(G_OBJECT_TYPE(engine), ==, test_engine_get_type());
  g_assert_cmpstr(ibus_engine_get_name(engine), ==, "test");
  g_assert_cmpuint(ibusweb_engine_get_ic(engine), ==, 19);
  g_assert_cmpstr(ibus_service_get_object_path(IBUS_SERVICE(engine)), ==,
                  "/org/freedesktop/IBus/Engine/19");
  g_object_unref(engine);

  ibus_factory_add_engine(factory, "constructing",
                          constructing_engine_get_type());
  clear_output();
  uint32_t seq = ibusweb_output_last_seq(), size;
  engine = ibusweb_factory_create(21, "constructing", &error);
  g_assert_cmpint(error, ==, 0);
  g_variant_unref(
      first_record(IBUSWEB_REC_HIDE_PREEDIT_TEXT, 21, ++seq, &size));
  ibusweb_output_consume(size);
  g_variant_unref(
      first_record(IBUSWEB_REC_HIDE_AUXILIARY_TEXT, 21, ++seq, &size));
  ibusweb_output_consume(size);
  g_object_unref(engine);

  /* Made outside a CreateEngine, an engine has no context yet. */
  clear_output();
  seq = ibusweb_output_last_seq();
  engine =
      g_object_ref_sink(g_object_new(constructing_engine_get_type(), NULL));
  g_variant_unref(first_record(IBUSWEB_REC_HIDE_PREEDIT_TEXT, 0, ++seq, &size));
  ibusweb_output_consume(size);
  g_variant_unref(
      first_record(IBUSWEB_REC_HIDE_AUXILIARY_TEXT, 0, ++seq, &size));
  ibusweb_output_consume(size);
  g_object_unref(engine);

  g_assert_null(ibusweb_factory_create(20, "missing", &error));
  g_assert_cmpint(error, ==, -ESRCH);
  g_test_expect_message("IBUS", G_LOG_LEVEL_CRITICAL, "*one factory*");
  g_assert_null(ibus_factory_new(NULL));
  g_test_assert_expected_messages();
  g_object_unref(factory);
}

static void simple_and_keymap(void) {
  IBusEngine *engine =
      g_object_ref_sink(g_object_new(IBUS_TYPE_ENGINE_SIMPLE, NULL));
  gboolean handled = TRUE;
  g_signal_emit_by_name(engine, "process-key-event", IBUS_a, 38u, 0u, &handled);
  g_assert_false(handled);
  g_assert_false(
      ibus_engine_simple_add_table_by_locale(IBUS_ENGINE_SIMPLE(engine), NULL));
  g_object_unref(engine);

  g_assert_null(ibus_keymap_get("de"));
  g_assert_cmpuint(ibus_keymap_lookup_keysym(NULL, 30, 0), ==, IBUS_VoidSymbol);
  IBusKeymap *us = ibus_keymap_get("us");
  g_assert_nonnull(us);
  g_assert_true(ibus_keymap_get("us") == us);
  g_object_unref(us);
  g_assert_cmpuint(ibus_keymap_lookup_keysym(us, 30, 0), ==, IBUS_a);
  g_assert_cmpuint(ibus_keymap_lookup_keysym(us, 30, IBUS_SHIFT_MASK), ==,
                   IBUS_A);
  g_assert_cmpuint(
      ibus_keymap_lookup_keysym(us, 30, IBUS_SHIFT_MASK | IBUS_LOCK_MASK), ==,
      IBUS_a);
  g_assert_cmpuint(ibus_keymap_lookup_keysym(us, 2, IBUS_LOCK_MASK), ==,
                   IBUS_1);
  g_assert_cmpuint(ibus_keymap_lookup_keysym(us, 79, IBUS_MOD2_MASK), ==,
                   IBUS_KP_1);
  g_assert_cmpuint(ibus_keymap_lookup_keysym(us, 79, IBUS_SHIFT_MASK), ==,
                   IBUS_KP_End);
  g_assert_cmpuint(ibus_keymap_lookup_keysym(us, 0xfff, 0), ==,
                   IBUS_VoidSymbol);
  g_object_unref(us);
}

static void keymap_matches_page(void) {
  const gchar *path = g_getenv("IBUSWEB_TEST_US_KEYMAP");
  if (path == NULL || *path == '\0')
    g_error("IBUSWEB_TEST_US_KEYMAP is not set");

  g_autofree gchar *contents = NULL;
  g_assert_true(g_file_get_contents(path, &contents, NULL, NULL));
  IBusKeymap *us = ibus_keymap_get("us");
  g_auto(GStrv) lines = g_strsplit(contents, "\n", -1);
  guint checked = 0, nonempty = 0;
  for (gchar **line = lines; *line != NULL; ++line) {
    guint code, state, keyval;
    if (**line == '\0')
      continue;
    ++nonempty;
    if (sscanf(*line, "%u %u %u", &code, &state, &keyval) != 3)
      continue;
    if (ibus_keymap_lookup_keysym(us, code, state) != keyval)
      g_error("evdev %u, state %u: expected 0x%x, got 0x%x", code, state,
              keyval, ibus_keymap_lookup_keysym(us, code, state));
    ++checked;
  }
  g_test_message("checked %u vectors", checked);
  g_assert_cmpuint(nonempty, >, 0);
  g_assert_cmpuint(checked, ==, nonempty);
  g_object_unref(us);
}

static void simple_hides_preedit_on_focus_out_and_reset(void) {
  IBusEngine *engine =
      g_object_ref_sink(g_object_new(IBUS_TYPE_ENGINE_SIMPLE, NULL));
  ibusweb_engine_set_ic(engine, 42);
  clear_output();
  expected_seq = ibusweb_output_last_seq();

  g_signal_emit_by_name(engine, "focus-out");
  expect_record(IBUSWEB_REC_HIDE_PREEDIT_TEXT, g_variant_new("()"));

  g_signal_emit_by_name(engine, "reset");
  expect_record(IBUSWEB_REC_HIDE_PREEDIT_TEXT, g_variant_new("()"));

  g_object_unref(engine);
}

/* Engines see the IBus layer's warnings under native IBus's domain. */
static void log_domain(void) {
  g_test_expect_message("IBUS", G_LOG_LEVEL_CRITICAL, "*IBUS_IS_SERIALIZABLE*");
  g_assert_null(ibus_serializable_serialize_object(NULL));
  g_test_expect_message("IBUS", G_LOG_LEVEL_CRITICAL, "*IBUS_IS_ENGINE*");
  ibus_engine_show_preedit_text(NULL);
  g_test_assert_expected_messages();
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, 0);
  g_assert_cmpuint(sizeof(IBusWebRequestHeader), ==, 8);
  g_assert_cmpuint(sizeof(IBusWebRecordHeader), ==, 16);
  g_assert_null(ibusweb_request_signature(0));
  g_assert_null(ibusweb_record_signature(0));
  g_test_add_func("/output/framing", output_framing);
  g_test_add_func("/output/sequence-wrap", output_sequence_wrap);
  g_test_add_func("/output/thread", output_thread);
  g_test_add_func("/output/thread-access", output_thread_access);
  g_test_add_func("/engine/emitters", emitters);
  g_test_add_func("/engine/ownership", emitter_ownership);
  g_test_add_func("/engine/fast-lookup", fast_lookup);
  g_test_add_func("/engine/surrounding", surrounding_text);
  g_test_add_func("/engine/surrounding-bounds", surrounding_bounds);
  g_test_add_func("/engine/signals", signal_dispatch);
  g_test_add_func("/engine/factory", factory);
  g_test_add_func("/engine/simple-keymap", simple_and_keymap);
  g_test_add_func("/engine/keymap-matches-page", keymap_matches_page);
  g_test_add_func("/engine/log-domain", log_domain);
  g_test_add_func("/engine/simple-preedit-lifecycle",
                  simple_hides_preedit_on_focus_out_and_reset);
  return g_test_run();
}
