/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include <ibus.h>

static gpointer round_trip(gpointer object, const char *signature) {
  g_assert_true(g_object_is_floating(object));
  GVariant *wire = g_variant_ref_sink(ibus_serializable_serialize(object));
  g_assert_cmpstr(g_variant_get_type_string(wire), ==, signature);
  IBusSerializable *copy = ibus_serializable_deserialize(wire);
  g_assert_nonnull(copy);
  g_assert_cmpuint(G_OBJECT_TYPE(copy), ==, G_OBJECT_TYPE(object));
  GVariant *again = g_variant_ref_sink(ibus_serializable_serialize(copy));
  g_assert_true(g_variant_equal(wire, again));
  g_variant_unref(again);
  g_variant_unref(wire);
  g_object_unref(object);
  return copy;
}

static void attribute(void) {
  IBusAttribute *attr =
      ibus_attribute_new(IBUS_ATTR_TYPE_FOREGROUND, 0xabcdef, 2, -1);
  GVariant *wire =
      g_variant_ref_sink(ibus_serializable_serialize(IBUS_SERIALIZABLE(attr)));
  guint end;
  g_variant_get_child(wire, 5, "u", &end);
  g_assert_cmpuint(end, ==, G_MAXUINT32);
  g_variant_unref(wire);
  attr = round_trip(attr, "(sa{sv}uuuu)");
  g_assert_cmpuint(attr->type, ==, IBUS_ATTR_TYPE_FOREGROUND);
  g_assert_cmpuint(attr->value, ==, 0xabcdef);
  g_assert_cmpuint(attr->start_index, ==, 2);
  g_assert_cmpuint(attr->end_index, ==, G_MAXUINT32);
  g_object_unref(attr);
}

static void attributes(void) {
  IBusAttrList *list = ibus_attr_list_new();
  ibus_attr_list_append(list,
                        ibus_attribute_new(IBUS_ATTR_TYPE_UNDERLINE,
                                           IBUS_ATTR_UNDERLINE_SINGLE, 0, 3));
  list = round_trip(list, "(sa{sv}av)");
  g_assert_cmpuint(ibus_attr_list_get(list, 0)->end_index, ==, 3);
  g_assert_null(ibus_attr_list_get(list, 1));
  g_object_unref(list);
}

static void text(void) {
  IBusText *value = ibus_text_new_from_string("한글");
  ibus_text_append_attribute(value, IBUS_ATTR_TYPE_BACKGROUND, 0x123456, 0, -1);
  value = round_trip(value, "(sa{sv}sv)");
  g_assert_cmpstr(value->text, ==, "한글");
  g_assert_cmpuint(ibus_attr_list_get(value->attrs, 0)->value, ==, 0x123456);
  g_object_unref(value);
}

static void lookup(void) {
  IBusLookupTable *table = ibus_lookup_table_new(9, 0, TRUE, TRUE);
  IBusText *candidate = ibus_text_new_from_string("韓");
  g_assert_true(g_object_is_floating(candidate));
  ibus_lookup_table_append_candidate(table, candidate);
  g_assert_false(g_object_is_floating(candidate));
  ibus_lookup_table_append_label(table, ibus_text_new_from_string("1"));
  ibus_lookup_table_set_orientation(table, IBUS_ORIENTATION_VERTICAL);
  table = round_trip(table, "(sa{sv}uubbiavav)");
  g_assert_cmpuint(table->page_size, ==, 9);
  g_assert_true(table->round);
  g_assert_true(table->cursor_visible);
  g_assert_cmpint(table->orientation, ==, IBUS_ORIENTATION_VERTICAL);
  g_assert_cmpstr(ibus_lookup_table_get_candidate(table, 0)->text, ==, "韓");
  g_assert_cmpstr(ibus_lookup_table_get_label(table, 0)->text, ==, "1");
  g_object_unref(table);
}

static IBusProperty *new_property(void) {
  IBusProperty *prop = ibus_property_new(
      "mode", PROP_TYPE_TOGGLE, ibus_text_new_from_string("Hangul"), "hangul",
      ibus_text_new_from_string("Switch mode"), TRUE, FALSE, PROP_STATE_CHECKED,
      ibus_prop_list_new());
  ibus_property_set_symbol(prop, ibus_text_new_from_string("한"));
  return prop;
}

static void property(void) {
  IBusProperty *prop = round_trip(new_property(), "(sa{sv}suvsvbbuvv)");
  g_assert_cmpstr(ibus_property_get_key(prop), ==, "mode");
  g_assert_cmpstr(ibus_property_get_label(prop)->text, ==, "Hangul");
  g_assert_cmpstr(ibus_property_get_symbol(prop)->text, ==, "한");
  g_assert_cmpstr(ibus_property_get_icon(prop), ==, "hangul");
  g_assert_cmpstr(ibus_property_get_tooltip(prop)->text, ==, "Switch mode");
  g_assert_cmpint(ibus_property_get_prop_type(prop), ==, PROP_TYPE_TOGGLE);
  g_assert_cmpint(ibus_property_get_state(prop), ==, PROP_STATE_CHECKED);
  g_assert_true(ibus_property_get_sensitive(prop));
  g_assert_false(ibus_property_get_visible(prop));
  g_object_unref(prop);
}

static void properties(void) {
  IBusPropList *list = ibus_prop_list_new();
  IBusProperty *prop = new_property();
  g_assert_true(g_object_is_floating(prop));
  ibus_prop_list_append(list, prop);
  g_assert_false(g_object_is_floating(prop));
  list = round_trip(list, "(sa{sv}av)");
  g_assert_cmpstr(ibus_property_get_key(ibus_prop_list_get(list, 0)), ==,
                  "mode");
  g_assert_null(ibus_prop_list_get(list, 1));
  g_object_unref(list);
}

static void keys(void) {
  guint keyval = 0, modifiers = 0;
  g_assert_true(ibus_key_event_from_string("Shift+space", &keyval, &modifiers));
  g_assert_cmpuint(keyval, ==, IBUS_space);
  g_assert_cmpuint(modifiers, ==, IBUS_SHIFT_MASK);
  g_assert_cmpuint(ibus_keyval_from_name("Hangul_Hanja"), ==,
                   IBUS_Hangul_Hanja);
  g_assert_cmpuint(ibus_keyval_to_unicode(IBUS_space), ==, ' ');
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  g_test_add_func("/serializable/attribute", attribute);
  g_test_add_func("/serializable/attributes", attributes);
  g_test_add_func("/serializable/text", text);
  g_test_add_func("/serializable/lookup", lookup);
  g_test_add_func("/serializable/property", property);
  g_test_add_func("/serializable/properties", properties);
  g_test_add_func("/keys/names", keys);
  return g_test_run();
}
