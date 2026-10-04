/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "harness.h"

static void preedit(Fixture *fixture, const gchar *expected, guint mode) {
  Record *record = golden_last(fixture, IBUSWEB_REC_UPDATE_PREEDIT_TEXT);
  IBusText *text = IBUS_TEXT(golden_object(record, IBUS_TYPE_TEXT));
  guint cursor, actual_mode;
  gboolean visible;
  g_variant_get_child(record->payload, 1, "u", &cursor);
  g_variant_get_child(record->payload, 2, "b", &visible);
  g_variant_get_child(record->payload, 3, "u", &actual_mode);
  g_assert_cmpstr(text->text, ==, expected);
  g_assert_cmpuint(cursor, ==, g_utf8_strlen(expected, -1));
  g_assert_true(visible);
  g_assert_cmpuint(actual_mode, ==, mode);
  gboolean underline = FALSE, foreground = FALSE, background = FALSE;
  for (guint i = 0;; ++i) {
    IBusAttribute *attribute = ibus_attr_list_get(text->attrs, i);
    if (attribute == NULL)
      break;
    guint prefix_length = g_utf8_strlen(expected, -1) - 1;
    if (attribute->type == IBUS_ATTR_TYPE_UNDERLINE) {
      g_assert_cmpuint(attribute->start_index, ==, 0);
      g_assert_cmpuint(attribute->end_index, ==, prefix_length);
      g_assert_cmpuint(attribute->value, ==, IBUS_ATTR_UNDERLINE_SINGLE);
    } else {
      g_assert_cmpuint(attribute->start_index, ==, prefix_length);
      g_assert_cmpuint(attribute->end_index, ==, g_utf8_strlen(expected, -1));
    }
    underline |= attribute->type == IBUS_ATTR_TYPE_UNDERLINE;
    foreground |= attribute->type == IBUS_ATTR_TYPE_FOREGROUND;
    background |= attribute->type == IBUS_ATTR_TYPE_BACKGROUND;
  }
  g_assert_cmpint(underline, ==, g_utf8_strlen(expected, -1) > 1);
  g_assert_true(foreground && background);
  g_object_unref(text);
}

static void commit(Fixture *fixture, const gchar *expected) {
  IBusText *text = IBUS_TEXT(golden_object(
      golden_last(fixture, IBUSWEB_REC_COMMIT_TEXT), IBUS_TYPE_TEXT));
  g_assert_cmpstr(text->text, ==, expected);
  g_object_unref(text);
}

static void toggle(Fixture *fixture) {
  g_assert_cmpint(golden_key(fixture, IBUS_Hangul, 122, 0), ==, 1);
  IBusProperty *property = IBUS_PROPERTY(golden_object(
      golden_last(fixture, IBUSWEB_REC_UPDATE_PROPERTY), IBUS_TYPE_PROPERTY));
  g_assert_cmpstr(ibus_property_get_key(property), ==, "InputMode");
  g_assert_cmpstr(ibus_property_get_symbol(property)->text, ==, "한");
  g_object_unref(property);
  golden_clear(fixture);
}

static void compose_han(Fixture *fixture) {
  g_assert_cmpint(golden_key(fixture, IBUS_g, 34, 0), ==, 1);
  preedit(fixture, "ㅎ", IBUS_ENGINE_PREEDIT_COMMIT);
  g_assert_cmpint(golden_key(fixture, IBUS_k, 37, 0), ==, 1);
  preedit(fixture, "하", IBUS_ENGINE_PREEDIT_COMMIT);
  g_assert_cmpint(golden_key(fixture, IBUS_s, 31, 0), ==, 1);
  preedit(fixture, "한", IBUS_ENGINE_PREEDIT_COMMIT);
}

static void latin(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  g_assert_cmpint(golden_key(fixture, IBUS_g, 34, 0), ==, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_UPDATE_PREEDIT_TEXT), ==,
                   0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_COMMIT_TEXT), ==, 0);
}

static void composition(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  toggle(fixture);
  compose_han(fixture);
  golden_clear(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_space, 57, 0), ==, 0);
  commit(fixture, "한");
}

static gboolean capture_settings(GSignalInvocationHint *hint G_GNUC_UNUSED,
                                 guint count G_GNUC_UNUSED,
                                 const GValue *values, gpointer data) {
  GPtrArray *instances = data;
  GObject *settings = g_value_get_object(&values[0]);
  if (!g_ptr_array_find(instances, settings, NULL))
    g_ptr_array_add(instances, g_object_ref(settings));
  return TRUE;
}

static guint changed_handlers(GPtrArray *instances, GSignalMatchType mask,
                              gpointer data) {
  guint signal = g_signal_lookup("changed", G_TYPE_SETTINGS);
  guint count = 0;
  for (guint i = 0; i < instances->len; ++i) {
    gpointer settings = g_ptr_array_index(instances, i);
    /* Blocking is the only public API that counts matching handlers. */
    count += g_signal_handlers_block_matched(settings, G_SIGNAL_MATCH_ID | mask,
                                             signal, 0, NULL, NULL, data);
    g_signal_handlers_unblock_matched(settings, G_SIGNAL_MATCH_ID | mask,
                                      signal, 0, NULL, NULL, data);
  }
  return count;
}

static void lifecycle(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  g_autoptr(GPtrArray) instances =
      g_ptr_array_new_with_free_func(g_object_unref);
  guint signal = g_signal_lookup("changed", G_TYPE_SETTINGS);
  gulong hook =
      g_signal_add_emission_hook(signal, 0, capture_settings, instances, NULL);
  golden_setting(fixture, HANGUL_SCHEMA, "hanja-keys",
                 g_variant_new_string("Hangul_Hanja,F9,F8,F7"));
  golden_setting(fixture, "org.freedesktop.ibus.panel",
                 "lookup-table-orientation", g_variant_new_int32(0));
  g_signal_remove_emission_hook(signal, hook);
  g_assert_cmpuint(instances->len, ==, 2);
  /* Compared by address only; the engine is never dereferenced. */
  gpointer engine = fixture->engine;
  g_assert_cmpuint(changed_handlers(instances, G_SIGNAL_MATCH_DATA, engine), ==,
                   2);
  g_assert_cmpuint(changed_handlers(instances, 0, NULL), ==, 4);
  golden_destroy(fixture);
  g_assert_cmpuint(changed_handlers(instances, G_SIGNAL_MATCH_DATA, engine), ==,
                   0);
  /* Only the module listener on each settings object remains. */
  g_assert_cmpuint(changed_handlers(instances, 0, NULL), ==, 2);
  /* A stale instance handler would select a keyboard on the freed context. */
  golden_setting(fixture, HANGUL_SCHEMA, "hangul-keyboard",
                 g_variant_new_string("39"));
  golden_create(fixture);
  toggle(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_m, 50, 0), ==, 1);
  preedit(fixture, "ㅎ", IBUS_ENGINE_PREEDIT_COMMIT);
  g_assert_cmpint(golden_key(fixture, IBUS_f, 33, 0), ==, 1);
  preedit(fixture, "하", IBUS_ENGINE_PREEDIT_COMMIT);
  g_assert_cmpint(golden_key(fixture, IBUS_s, 31, 0), ==, 1);
  preedit(fixture, "한", IBUS_ENGINE_PREEDIT_COMMIT);
}

static IBusLookupTable *lookup(Fixture *fixture) {
  Record *record = golden_last(fixture, IBUSWEB_REC_UPDATE_LOOKUP_TABLE);
  gboolean visible;
  g_variant_get_child(record->payload, 1, "b", &visible);
  g_assert_true(visible);
  IBusLookupTable *table =
      IBUS_LOOKUP_TABLE(golden_object(record, IBUS_TYPE_LOOKUP_TABLE));
  g_assert_cmpuint(ibus_lookup_table_get_page_size(table), ==, 9);
  return table;
}

static void idle_settings(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_destroy(fixture);
  golden_clear(fixture);
  golden_setting(fixture, HANGUL_SCHEMA, "hangul-keyboard",
                 g_variant_new_string("39"));
  golden_setting(fixture, HANGUL_SCHEMA, "hanja-keys",
                 g_variant_new_string("F7"));
  golden_create(fixture);
  toggle(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_m, 50, 0), ==, 1);
  preedit(fixture, "ㅎ", IBUS_ENGINE_PREEDIT_COMMIT);
  g_assert_cmpint(golden_key(fixture, IBUS_f, 33, 0), ==, 1);
  preedit(fixture, "하", IBUS_ENGINE_PREEDIT_COMMIT);
  g_assert_cmpint(golden_key(fixture, IBUS_s, 31, 0), ==, 1);
  preedit(fixture, "한", IBUS_ENGINE_PREEDIT_COMMIT);
  g_assert_cmpint(golden_key(fixture, IBUS_F7, 65, 0), ==, 1);
  IBusLookupTable *table = lookup(fixture);
  g_assert_cmpuint(ibus_lookup_table_get_number_of_candidates(table), >, 0);
  g_object_unref(table);
  golden_empty_request(fixture, IBUSWEB_REQ_RESET);
  /* Equal-value resends are suppressed; neither assertion above relies on one.
   */
  golden_clear(fixture);
  golden_setting(fixture, HANGUL_SCHEMA, "hangul-keyboard",
                 g_variant_new_string("39"));
  golden_setting(fixture, HANGUL_SCHEMA, "hanja-keys",
                 g_variant_new_string("F7"));
  g_assert_cmpuint(fixture->records->len, ==, 0);
}

static guint korean_candidate(IBusLookupTable *table) {
  for (guint i = 0; i < ibus_lookup_table_get_number_of_candidates(table); ++i)
    if (g_str_equal(ibus_lookup_table_get_candidate(table, i)->text, "韓"))
      return i;
  g_error("Hanja candidates do not include 韓");
}

static void caps_lock(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  toggle(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_G, 34, IBUS_LOCK_MASK), ==, 1);
  preedit(fixture, "ㅎ", IBUS_ENGINE_PREEDIT_COMMIT);
  g_assert_cmpint(golden_key(fixture, IBUS_K, 37, IBUS_LOCK_MASK), ==, 1);
  preedit(fixture, "하", IBUS_ENGINE_PREEDIT_COMMIT);
  g_assert_cmpint(golden_key(fixture, IBUS_S, 31, IBUS_LOCK_MASK), ==, 1);
  preedit(fixture, "한", IBUS_ENGINE_PREEDIT_COMMIT);
}

static void backspace(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  toggle(fixture);
  compose_han(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_BackSpace, 14, 0), ==, 1);
  preedit(fixture, "하", IBUS_ENGINE_PREEDIT_COMMIT);
}

static void focus_reset(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  toggle(fixture);
  compose_han(fixture);
  golden_clear(fixture);
  golden_empty_request(fixture, IBUSWEB_REQ_FOCUS_OUT);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_COMMIT_TEXT), ==, 0);
  golden_empty_request(fixture, IBUSWEB_REQ_FOCUS_IN);
  compose_han(fixture);
  golden_clear(fixture);
  golden_empty_request(fixture, IBUSWEB_REQ_RESET);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_COMMIT_TEXT), ==, 0);
  compose_han(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_F9, 67, 0), ==, 1);
  preedit(fixture, "한", IBUS_ENGINE_PREEDIT_CLEAR);
  golden_clear(fixture);
  golden_empty_request(fixture, IBUSWEB_REQ_FOCUS_OUT);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_COMMIT_TEXT), ==, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_HIDE_LOOKUP_TABLE), >, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_HIDE_AUXILIARY_TEXT), >,
                   0);
}

static void hanja_keys(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  toggle(fixture);
  compose_han(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_F9, 67, 0), ==, 1);
  IBusLookupTable *table = lookup(fixture);
  guint index = korean_candidate(table);
  g_object_unref(table);
  Record *auxiliary = golden_last(fixture, IBUSWEB_REC_UPDATE_AUXILIARY_TEXT);
  gboolean visible;
  g_variant_get_child(auxiliary->payload, 1, "b", &visible);
  g_assert_true(visible);
  IBusText *text = IBUS_TEXT(golden_object(auxiliary, IBUS_TYPE_TEXT));
  g_assert_cmpstr(text->text, !=, "");
  g_object_unref(text);
  for (guint i = 0; i < index; ++i)
    g_assert_cmpint(golden_key(fixture, IBUS_Down, 108, 0), ==, 1);
  table = lookup(fixture);
  g_assert_cmpuint(ibus_lookup_table_get_cursor_pos(table), ==, index);
  g_object_unref(table);
  golden_clear(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_Return, 28, 0), ==, 1);
  commit(fixture, "韓");
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_HIDE_LOOKUP_TABLE), >, 0);
}

static void hanja_click(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  toggle(fixture);
  compose_han(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_F8, 66, 0), ==, 1);
  IBusLookupTable *table = lookup(fixture);
  g_assert_cmpuint(ibus_lookup_table_get_number_of_candidates(table), >, 10);
  g_object_unref(table);
  g_assert_cmpint(golden_key(fixture, IBUS_Page_Down, 109, 0), ==, 1);
  table = lookup(fixture);
  g_assert_cmpuint(ibus_lookup_table_get_cursor_pos(table), ==, 9);
  g_autofree gchar *expected =
      g_strdup(ibus_lookup_table_get_candidate(table, 10)->text);
  g_object_unref(table);
  golden_clear(fixture);
  /* Panels report the clicked label's position within the visible page. */
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CANDIDATE_CLICKED,
                                 g_variant_new("(uuu)", 1u, 1u, 0u)),
                  ==, 0);
  commit(fixture, expected);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_HIDE_LOOKUP_TABLE), >, 0);
}

static void invalid_digit(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  toggle(fixture);
  compose_han(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_F9, 67, 0), ==, 1);
  IBusLookupTable *table = lookup(fixture);
  guint count = ibus_lookup_table_get_number_of_candidates(table);
  g_assert_cmpuint(count % 9, !=, 0);
  g_object_unref(table);
  for (guint page = 0; page < (count - 1) / 9; ++page)
    g_assert_cmpint(golden_key(fixture, IBUS_Page_Down, 109, 0), ==, 1);
  table = lookup(fixture);
  g_assert_cmpuint(ibus_lookup_table_get_cursor_pos(table), ==,
                   ((count - 1) / 9) * 9);
  g_object_unref(table);
  golden_clear(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_9, 10, 0), ==, 1);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_COMMIT_TEXT), ==, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_HIDE_LOOKUP_TABLE), ==, 0);
}

static void click_ignored(Fixture *fixture, guint index) {
  golden_clear(fixture);
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CANDIDATE_CLICKED,
                                 g_variant_new("(uuu)", index, 1u, 0u)),
                  ==, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_COMMIT_TEXT), ==, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_HIDE_LOOKUP_TABLE), ==, 0);
}

static void invalid_click(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  toggle(fixture);
  compose_han(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_F9, 67, 0), ==, 1);
  IBusLookupTable *table = lookup(fixture);
  guint count = ibus_lookup_table_get_number_of_candidates(table);
  g_assert_cmpuint(count % 9, !=, 0);
  g_object_unref(table);
  /* Within the candidates overall, but past the labels a page shows. */
  click_ignored(fixture, 9);
  for (guint page = 0; page < (count - 1) / 9; ++page)
    g_assert_cmpint(golden_key(fixture, IBUS_Page_Down, 109, 0), ==, 1);
  click_ignored(fixture, count % 9);
}

static void settings(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  toggle(fixture);
  golden_setting(fixture, HANGUL_SCHEMA, "hangul-keyboard",
                 g_variant_new_string("39"));
  g_assert_cmpint(golden_key(fixture, IBUS_m, 50, 0), ==, 1);
  preedit(fixture, "ㅎ", IBUS_ENGINE_PREEDIT_COMMIT);
  g_assert_cmpint(golden_key(fixture, IBUS_f, 33, 0), ==, 1);
  preedit(fixture, "하", IBUS_ENGINE_PREEDIT_COMMIT);
  g_assert_cmpint(golden_key(fixture, IBUS_s, 31, 0), ==, 1);
  preedit(fixture, "한", IBUS_ENGINE_PREEDIT_COMMIT);
  golden_empty_request(fixture, IBUSWEB_REQ_RESET);
  golden_setting(fixture, HANGUL_SCHEMA, "hangul-keyboard",
                 g_variant_new_string("2"));
  compose_han(fixture);
  golden_empty_request(fixture, IBUSWEB_REQ_RESET);
  golden_setting(fixture, HANGUL_SCHEMA, "preedit-mode",
                 g_variant_new_string("word"));
  golden_empty_request(fixture, IBUSWEB_REQ_FOCUS_OUT);
  golden_empty_request(fixture, IBUSWEB_REQ_FOCUS_IN);
  golden_clear(fixture);
  compose_han(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_r, 19, 0), ==, 1);
  g_assert_cmpint(golden_key(fixture, IBUS_m, 50, 0), ==, 1);
  g_assert_cmpint(golden_key(fixture, IBUS_f, 33, 0), ==, 1);
  preedit(fixture, "한글", IBUS_ENGINE_PREEDIT_COMMIT);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_COMMIT_TEXT), ==, 0);
  g_assert_cmpint(golden_key(fixture, IBUS_space, 57, 0), ==, 0);
  commit(fixture, "한글");
}

static void password(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  toggle(fixture);
  g_assert_cmpint(
      golden_request(fixture, IBUSWEB_REQ_SET_CONTENT_TYPE,
                     g_variant_new("(uu)", IBUS_INPUT_PURPOSE_PASSWORD, 0u)),
      ==, 0);
  g_assert_cmpint(golden_key(fixture, IBUS_g, 34, 0), ==, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_UPDATE_PREEDIT_TEXT), ==,
                   0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_COMMIT_TEXT), ==, 0);
}

static void enable(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  golden_empty_request(fixture, IBUSWEB_REQ_ENABLE);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT),
                   >, 0);
}

static void surrounding(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  toggle(fixture);
  IBusText *text = ibus_text_new_from_static_string("한");
  GVariant *serialized = ibus_serializable_serialize(IBUS_SERIALIZABLE(text));
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_SET_SURROUNDING_TEXT,
                                 g_variant_new("(vuu)", serialized, 1u, 1u)),
                  ==, 0);
  g_object_unref(text);
  g_assert_cmpint(golden_key(fixture, IBUS_F9, 67, 0), ==, 1);
  IBusLookupTable *table = lookup(fixture);
  guint index = korean_candidate(table);
  g_assert_cmpuint(index, <, ibus_lookup_table_get_page_size(table));
  g_object_unref(table);
  golden_clear(fixture);
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_CANDIDATE_CLICKED,
                                 g_variant_new("(uuu)", index, 1u, 0u)),
                  ==, 0);
  gint offset;
  guint count;
  g_variant_get(
      golden_last(fixture, IBUSWEB_REC_DELETE_SURROUNDING_TEXT)->payload,
      "(iu)", &offset, &count);
  g_assert_cmpint(offset, ==, -1);
  g_assert_cmpuint(count, ==, 1);
  commit(fixture, "韓");
  guint delete_index, commit_index;
  g_assert_true(g_ptr_array_find(
      fixture->records,
      golden_last(fixture, IBUSWEB_REC_DELETE_SURROUNDING_TEXT),
      &delete_index));
  g_assert_true(g_ptr_array_find(fixture->records,
                                 golden_last(fixture, IBUSWEB_REC_COMMIT_TEXT),
                                 &commit_index));
  g_assert_cmpuint(delete_index, <, commit_index);
  guint cursor, anchor;
  ibus_engine_get_surrounding_text(fixture->engine, &text, &cursor, &anchor);
  g_assert_cmpstr(text->text, ==, "");
  g_assert_cmpuint(cursor, ==, 0);
  /* Upstream leaves the selection anchor until the next host update. */
  g_assert_cmpuint(anchor, ==, 1);
  g_object_unref(text);
}

static void forwarding(Fixture *fixture, gconstpointer data G_GNUC_UNUSED) {
  g_assert_cmpint(
      golden_request(fixture, IBUSWEB_REQ_SET_CAPABILITIES,
                     g_variant_new("(u)", GOLDEN_CAPABILITIES |
                                              IBUS_CAP_SYNC_PROCESS_KEY_V2)),
      ==, 0);
  toggle(fixture);
  compose_han(fixture);
  golden_clear(fixture);
  g_assert_cmpint(golden_key(fixture, IBUS_space, 57, 0), ==, 1);
  commit(fixture, "한");
  gboolean committed = FALSE, forwarded = FALSE;
  for (guint i = 0; i < fixture->records->len; ++i) {
    Record *record = g_ptr_array_index(fixture->records, i);
    if (record->kind == IBUSWEB_REC_COMMIT_TEXT)
      committed = TRUE;
    if (record->kind == IBUSWEB_REC_FORWARD_KEY_EVENT) {
      guint key, code, state;
      g_variant_get(record->payload, "(uuu)", &key, &code, &state);
      g_assert_true(committed);
      g_assert_cmpuint(key, ==, IBUS_space);
      g_assert_cmpuint(code, ==, 57);
      if (!(state & IBUS_RELEASE_MASK)) {
        g_assert_cmpuint(state, ==, 0);
        forwarded = TRUE;
      }
    }
  }
  g_assert_true(forwarded);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  gchar *schemas_dir = NULL, *module = NULL;
  GOptionEntry options[] = {{"schemas", 0, 0, G_OPTION_ARG_STRING, &schemas_dir,
                             "Engine share directory", "DIR"},
                            {"module", 0, 0, G_OPTION_ARG_FILENAME, &module,
                             "Engine side module", "FILE"},
                            {NULL}};
  GOptionContext *context = g_option_context_new(NULL);
  g_option_context_add_main_entries(context, options, NULL);
  GError *error = NULL;
  g_assert_true(g_option_context_parse(context, &argc, &argv, &error));
  g_assert_no_error(error);
  g_assert_nonnull(schemas_dir);
  g_assert_nonnull(module);
  golden_init(schemas_dir, module);
  g_free(schemas_dir);
  g_free(module);
  g_option_context_free(context);
  g_test_add("/hangul/latin", Fixture, NULL, golden_setup, latin,
             golden_teardown);
  g_test_add("/hangul/composition", Fixture, NULL, golden_setup, composition,
             golden_teardown);
  g_test_add("/hangul/idle-settings", Fixture, NULL, golden_setup,
             idle_settings, golden_teardown);
  g_test_add("/hangul/lifecycle", Fixture, NULL, golden_setup, lifecycle,
             golden_teardown);
  g_test_add("/hangul/caps-lock", Fixture, NULL, golden_setup, caps_lock,
             golden_teardown);
  g_test_add("/hangul/backspace", Fixture, NULL, golden_setup, backspace,
             golden_teardown);
  g_test_add("/hangul/focus-reset", Fixture, NULL, golden_setup, focus_reset,
             golden_teardown);
  g_test_add("/hangul/hanja-keys", Fixture, NULL, golden_setup, hanja_keys,
             golden_teardown);
  g_test_add("/hangul/hanja-click", Fixture, NULL, golden_setup, hanja_click,
             golden_teardown);
  g_test_add("/hangul/settings", Fixture, NULL, golden_setup, settings,
             golden_teardown);
  g_test_add("/hangul/password", Fixture, NULL, golden_setup, password,
             golden_teardown);
  g_test_add("/hangul/enable", Fixture, NULL, golden_setup, enable,
             golden_teardown);
  g_test_add("/hangul/surrounding", Fixture, NULL, golden_setup, surrounding,
             golden_teardown);
  g_test_add("/hangul/forwarding", Fixture, NULL, golden_setup, forwarding,
             golden_teardown);
  g_test_add("/hangul/invalid-digit", Fixture, NULL, golden_setup,
             invalid_digit, golden_teardown);
  g_test_add("/hangul/invalid-click", Fixture, NULL, golden_setup,
             invalid_click, golden_teardown);
  return g_test_run();
}
