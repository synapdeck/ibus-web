/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */
#include <glib/gstdio.h>
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <ibus.h>
#include <json-glib/json-glib.h>

static const char *corpus_dir;
static const char *output_dir;
static JsonBuilder *calls;
static JsonBuilder *records;
static GSettings *settings;
static gboolean created;
static gboolean destroyed;

static void string_member(JsonBuilder *builder, const char *name,
                          const char *value) {
  json_builder_set_member_name(builder, name);
  json_builder_add_string_value(builder, value);
}
static void integer_member(JsonBuilder *builder, const char *name,
                           gint64 value) {
  json_builder_set_member_name(builder, name);
  json_builder_add_int_value(builder, value);
}
static void boolean_member(JsonBuilder *builder, const char *name,
                           gboolean value) {
  json_builder_set_member_name(builder, name);
  json_builder_add_boolean_value(builder, value);
}
static void write_bytes(const char *directory, const char *name,
                        const void *data, gsize size) {
  gchar *folder = g_build_filename(output_dir, directory, NULL);
  if (g_mkdir_with_parents(folder, 0700) != 0)
    g_error("Cannot create %s", folder);
  gchar *path = g_build_filename(folder, name, NULL);
  GError *error = NULL;
  if (!g_file_set_contents(path, data, size, &error))
    g_error("%s", error->message);
  g_free(path);
  g_free(folder);
}
static void write_json(const char *directory, const char *name,
                       JsonBuilder *builder) {
  JsonNode *root = json_builder_get_root(builder);
  JsonGenerator *generator = json_generator_new();
  json_generator_set_root(generator, root);
  gsize size;
  gchar *data = json_generator_to_data(generator, &size);
  write_bytes(directory, name, data, size);
  g_free(data);
  json_node_free(root);
  g_object_unref(generator);
}
static JsonParser *read_json(const char *name) {
  JsonParser *parser = json_parser_new();
  gchar *path = g_build_filename(corpus_dir, name, NULL);
  GError *error = NULL;
  if (!json_parser_load_from_file(parser, path, &error))
    g_error("%s", error->message);
  g_free(path);
  return parser;
}
static GBytes *read_bytes(const char *directory, const char *name) {
  gchar *file = g_strconcat(name, ".bin", NULL);
  gchar *path = g_build_filename(corpus_dir, directory, file, NULL);
  gchar *data;
  gsize size;
  GError *error = NULL;
  if (!g_file_get_contents(path, &data, &size, &error))
    g_error("%s", error->message);
  g_free(file);
  g_free(path);
  return g_bytes_new_take(data, size);
}
static void project_object(JsonBuilder *builder, IBusSerializable *object);
static void object_member(JsonBuilder *builder, const char *name,
                          gpointer object) {
  json_builder_set_member_name(builder, name);
  project_object(builder, IBUS_SERIALIZABLE(object));
}
static void project_object(JsonBuilder *builder, IBusSerializable *object) {
  json_builder_begin_object(builder);
  json_builder_set_member_name(builder, "attachments");
  json_builder_begin_object(builder);
  /* The fixture uses one named attachment; IBus exposes lookup but no
   * enumeration. */
  GVariant *attachment = ibus_serializable_get_attachment(object, "source");
  if (attachment)
    string_member(builder, "source", g_variant_get_type_string(attachment));
  json_builder_end_object(builder);
  if (IBUS_IS_ATTRIBUTE(object)) {
    IBusAttribute *attr = IBUS_ATTRIBUTE(object);
    integer_member(builder, "type", ibus_attribute_get_attr_type(attr));
    integer_member(builder, "value", ibus_attribute_get_value(attr));
    integer_member(builder, "startIndex", ibus_attribute_get_start_index(attr));
    integer_member(builder, "endIndex", ibus_attribute_get_end_index(attr));
  } else if (IBUS_IS_ATTR_LIST(object)) {
    json_builder_set_member_name(builder, "attributes");
    json_builder_begin_array(builder);
    for (guint i = 0;; i++) {
      IBusAttribute *attr = ibus_attr_list_get(IBUS_ATTR_LIST(object), i);
      if (!attr)
        break;
      project_object(builder, IBUS_SERIALIZABLE(attr));
    }
    json_builder_end_array(builder);
  } else if (IBUS_IS_TEXT(object)) {
    IBusText *text = IBUS_TEXT(object);
    string_member(builder, "text", ibus_text_get_text(text));
    object_member(builder, "attrs", ibus_text_get_attributes(text));
  } else if (IBUS_IS_LOOKUP_TABLE(object)) {
    IBusLookupTable *table = IBUS_LOOKUP_TABLE(object);
    integer_member(builder, "pageSize", ibus_lookup_table_get_page_size(table));
    integer_member(builder, "cursorPos",
                   ibus_lookup_table_get_cursor_pos(table));
    boolean_member(builder, "cursorVisible",
                   ibus_lookup_table_is_cursor_visible(table));
    boolean_member(builder, "round", ibus_lookup_table_is_round(table));
    integer_member(builder, "orientation",
                   ibus_lookup_table_get_orientation(table));
    json_builder_set_member_name(builder, "candidates");
    json_builder_begin_array(builder);
    for (guint i = 0; i < ibus_lookup_table_get_number_of_candidates(table);
         i++)
      project_object(builder, IBUS_SERIALIZABLE(
                                  ibus_lookup_table_get_candidate(table, i)));
    json_builder_end_array(builder);
    json_builder_set_member_name(builder, "labels");
    json_builder_begin_array(builder);
    for (guint i = 0;; i++) {
      IBusText *label = ibus_lookup_table_get_label(table, i);
      if (!label)
        break;
      project_object(builder, IBUS_SERIALIZABLE(label));
    }
    json_builder_end_array(builder);
  } else if (IBUS_IS_PROPERTY(object)) {
    IBusProperty *prop = IBUS_PROPERTY(object);
    string_member(builder, "key", ibus_property_get_key(prop));
    integer_member(builder, "type", ibus_property_get_prop_type(prop));
    object_member(builder, "label", ibus_property_get_label(prop));
    string_member(builder, "icon", ibus_property_get_icon(prop));
    object_member(builder, "tooltip", ibus_property_get_tooltip(prop));
    boolean_member(builder, "sensitive", ibus_property_get_sensitive(prop));
    boolean_member(builder, "visible", ibus_property_get_visible(prop));
    integer_member(builder, "state", ibus_property_get_state(prop));
    object_member(builder, "subProps", ibus_property_get_sub_props(prop));
    object_member(builder, "symbol", ibus_property_get_symbol(prop));
  } else if (IBUS_IS_PROP_LIST(object)) {
    json_builder_set_member_name(builder, "properties");
    json_builder_begin_array(builder);
    for (guint i = 0;; i++) {
      IBusProperty *prop = ibus_prop_list_get(IBUS_PROP_LIST(object), i);
      if (!prop)
        break;
      project_object(builder, IBUS_SERIALIZABLE(prop));
    }
    json_builder_end_array(builder);
  } else
    g_error("Unsupported projection: %s", G_OBJECT_TYPE_NAME(object));
  json_builder_end_object(builder);
}
static void save_object(const char *directory, const char *name,
                        IBusSerializable *object, gboolean normal) {
  JsonBuilder *builder = json_builder_new();
  json_builder_begin_object(builder);
  string_member(builder, "type", G_OBJECT_TYPE_NAME(object));
  boolean_member(builder, "normal", normal);
  object_member(builder, "value", object);
  json_builder_end_object(builder);
  gchar *file = g_strconcat(name, ".json", NULL);
  write_json(directory, file, builder);
  g_free(file);
  g_object_unref(builder);
  GVariant *value =
      g_variant_ref_sink(ibus_serializable_serialize_object(object));
  file = g_strconcat(name, ".bin", NULL);
  write_bytes(directory, file, g_variant_get_data(value),
              g_variant_get_size(value));
  g_variant_unref(value);
  g_free(file);
}
static void read_objects(JsonArray *cases) {
  for (guint i = 0; i < json_array_get_length(cases); i++) {
    JsonObject *item = json_array_get_object_element(cases, i);
    const char *name = json_object_get_string_member(item, "name");
    const char *signature = json_object_get_string_member(item, "signature");
    GBytes *bytes = read_bytes("objects", name);
    GVariant *value = g_variant_ref_sink(
        g_variant_new_from_bytes(G_VARIANT_TYPE(signature), bytes, FALSE));
    gboolean normal = g_variant_is_normal_form(value);
    IBusSerializable *object = ibus_serializable_deserialize_object(value);
    if (!object)
      g_error("Cannot deserialize %s", name);
    g_object_ref_sink(object);
    save_object("ts-objects", name, object, normal);
    g_object_unref(object);
    g_variant_unref(value);
    g_bytes_unref(bytes);
  }
}
static void fuzz_normal_form(void) {
  JsonParser *parser = read_json("fuzz.json");
  JsonArray *cases = json_node_get_array(json_parser_get_root(parser));
  JsonBuilder *builder = json_builder_new();
  json_builder_begin_object(builder);
  for (guint i = 0; i < json_array_get_length(cases); i++) {
    JsonObject *item = json_array_get_object_element(cases, i);
    const char *name = json_object_get_string_member(item, "name");
    const char *signature = json_object_get_string_member(item, "signature");
    GBytes *bytes = read_bytes("fuzz", name);
    GVariant *value = g_variant_ref_sink(
        g_variant_new_from_bytes(G_VARIANT_TYPE(signature), bytes, FALSE));
    json_builder_set_member_name(builder, name);
    json_builder_begin_object(builder);
    boolean_member(builder, "normal", g_variant_is_normal_form(value));
    json_builder_end_object(builder);
    g_variant_unref(value);
    g_bytes_unref(bytes);
  }
  json_builder_end_object(builder);
  write_json("", "fuzz.json", builder);
  g_object_unref(builder);
  g_object_unref(parser);
}
static IBusText *make_text(const char *value) {
  IBusText *text = ibus_text_new_from_string(value);
  ibus_text_set_attributes(text, ibus_attr_list_new());
  return text;
}
static IBusText *make_decorated(void) {
  IBusText *text = make_text("한글😀");
  ibus_text_append_attribute(text, IBUS_ATTR_TYPE_UNDERLINE, 1, 0, 2);
  ibus_text_append_attribute(text, IBUS_ATTR_TYPE_FOREGROUND, 0xabcdef, 1,
                             G_MAXUINT);
  return text;
}
static IBusLookupTable *make_table(void) {
  IBusLookupTable *table = ibus_lookup_table_new(9, 20, TRUE, FALSE);
  ibus_lookup_table_set_orientation(table, IBUS_ORIENTATION_VERTICAL);
  for (guint i = 0; i < 500; i++) {
    gchar *label = g_strdup_printf("C 후보 %u", i);
    ibus_lookup_table_append_candidate(table, make_text(label));
    g_free(label);
  }
  for (guint i = 0; i < 9; i++) {
    gchar *label = g_strdup_printf("%u", i + 1);
    ibus_lookup_table_append_label(table, make_text(label));
    g_free(label);
  }
  return table;
}
static IBusProperty *make_property(const char *key, IBusPropList *children) {
  IBusProperty *prop = ibus_property_new(
      key, PROP_TYPE_MENU, make_text("C Label"), "c-icon",
      make_text("C 도움말"), TRUE, TRUE, PROP_STATE_CHECKED, children);
  ibus_property_set_symbol(prop, make_text("★"));
  return prop;
}
static IBusProperty *make_menu(void) {
  IBusPropList *children = ibus_prop_list_new();
  ibus_prop_list_append(children, make_property("child", ibus_prop_list_new()));
  IBusProperty *menu = make_property("menu", children);
  ibus_serializable_set_attachment(IBUS_SERIALIZABLE(menu), "source",
                                   g_variant_new_string("C"));
  return menu;
}
static void save_owned(const char *name, gpointer object) {
  g_object_ref_sink(object);
  save_object("c-objects", name, IBUS_SERIALIZABLE(object), TRUE);
  g_object_unref(object);
}
static void create_objects(void) {
  save_owned("empty-text", make_text(""));
  save_owned("ascii", make_text("C ASCII"));
  save_owned("hangul", make_text("한글"));
  save_owned("astral", make_text("😀"));
  save_owned("decorated", make_decorated());
  save_owned("attribute", ibus_attribute_new(IBUS_ATTR_TYPE_FOREGROUND,
                                             0xabcdef, 1, G_MAXUINT));
  save_owned("empty-attrs", ibus_attr_list_new());
  save_owned("lookup", make_table());
  save_owned("property", make_menu());
  IBusPropList *props = ibus_prop_list_new();
  ibus_prop_list_append(props, make_menu());
  save_owned("properties", props);
  save_owned("empty-properties", ibus_prop_list_new());
}
static void begin_observation(JsonBuilder *builder, const char *kind) {
  json_builder_begin_object(builder);
  string_member(builder, "kind", kind);
  json_builder_set_member_name(builder, "args");
  json_builder_begin_object(builder);
}
static void end_observation(JsonBuilder *builder) {
  json_builder_end_object(builder);
  json_builder_end_object(builder);
}
static void string_variant(JsonBuilder *builder, const char *value) {
  json_builder_set_member_name(builder, "value");
  json_builder_begin_object(builder);
  string_member(builder, "type", "s");
  json_builder_set_member_name(builder, "value");
  json_builder_begin_object(builder);
  string_member(builder, "value", value);
  json_builder_end_object(builder);
  json_builder_end_object(builder);
}
static void emit_records(IBusEngine *engine);
typedef struct {
  IBusEngine parent;
} ParityEngine;
typedef struct {
  IBusEngineClass parent;
} ParityEngineClass;
G_DEFINE_TYPE(ParityEngine, parity_engine, IBUS_TYPE_ENGINE)
static gboolean process_key(IBusEngine *engine, guint keyval, guint keycode,
                            guint state) {
  if (keyval == IBUS_Return) {
    emit_records(engine);
    return FALSE;
  }
  begin_observation(calls, "ProcessKeyEvent");
  integer_member(calls, "keyval", keyval);
  integer_member(calls, "keycode", keycode);
  integer_member(calls, "state", state);
  end_observation(calls);
  return keyval == IBUS_a;
}
static void focus_in(IBusEngine *engine G_GNUC_UNUSED) {
  begin_observation(calls, "FocusIn");
  end_observation(calls);
}
static void focus_out(IBusEngine *engine G_GNUC_UNUSED) {
  begin_observation(calls, "FocusOut");
  end_observation(calls);
}
static void reset(IBusEngine *engine G_GNUC_UNUSED) {
  begin_observation(calls, "Reset");
  end_observation(calls);
}
static void enable(IBusEngine *engine G_GNUC_UNUSED) {
  begin_observation(calls, "Enable");
  end_observation(calls);
}
static void disable(IBusEngine *engine G_GNUC_UNUSED) {
  begin_observation(calls, "Disable");
  end_observation(calls);
}
static void page_up(IBusEngine *engine G_GNUC_UNUSED) {
  begin_observation(calls, "PageUp");
  end_observation(calls);
}
static void page_down(IBusEngine *engine G_GNUC_UNUSED) {
  begin_observation(calls, "PageDown");
  end_observation(calls);
}
static void cursor_up(IBusEngine *engine G_GNUC_UNUSED) {
  begin_observation(calls, "CursorUp");
  end_observation(calls);
}
static void cursor_down(IBusEngine *engine G_GNUC_UNUSED) {
  begin_observation(calls, "CursorDown");
  end_observation(calls);
}
static void set_cursor_location(IBusEngine *engine G_GNUC_UNUSED, gint x,
                                gint y, gint width, gint height) {
  begin_observation(calls, "SetCursorLocation");
  integer_member(calls, "x", x);
  integer_member(calls, "y", y);
  integer_member(calls, "width", width);
  integer_member(calls, "height", height);
  end_observation(calls);
}
static void set_capabilities(IBusEngine *engine G_GNUC_UNUSED,
                             guint capabilities) {
  begin_observation(calls, "SetCapabilities");
  integer_member(calls, "capabilities", capabilities);
  end_observation(calls);
}
static void candidate_clicked(IBusEngine *engine G_GNUC_UNUSED, guint index,
                              guint button, guint state) {
  begin_observation(calls, "CandidateClicked");
  integer_member(calls, "index", index);
  integer_member(calls, "button", button);
  integer_member(calls, "state", state);
  end_observation(calls);
}
static void property_activate(IBusEngine *engine G_GNUC_UNUSED,
                              const gchar *name, guint state) {
  begin_observation(calls, "PropertyActivate");
  string_member(calls, "name", name);
  integer_member(calls, "state", state);
  end_observation(calls);
}
static void set_surrounding_text(IBusEngine *engine G_GNUC_UNUSED,
                                 IBusText *text, guint cursor, guint anchor) {
  begin_observation(calls, "SetSurroundingText");
  object_member(calls, "text", text);
  integer_member(calls, "cursor", cursor);
  integer_member(calls, "anchor", anchor);
  end_observation(calls);
}
static void set_content_type(IBusEngine *engine G_GNUC_UNUSED, guint purpose,
                             guint hints) {
  begin_observation(calls, "SetContentType");
  integer_member(calls, "purpose", purpose);
  integer_member(calls, "hints", hints);
  end_observation(calls);
}
static void engine_destroy(IBusObject *object) {
  destroyed = TRUE;
  IBUS_OBJECT_CLASS(parity_engine_parent_class)->destroy(object);
}
static void parity_engine_class_init(ParityEngineClass *klass) {
  IBusEngineClass *engine = IBUS_ENGINE_CLASS(klass);
  IBUS_OBJECT_CLASS(klass)->destroy = engine_destroy;
  engine->process_key_event = process_key;
  engine->focus_in = focus_in;
  engine->focus_out = focus_out;
  engine->reset = reset;
  engine->enable = enable;
  engine->disable = disable;
  engine->page_up = page_up;
  engine->page_down = page_down;
  engine->cursor_up = cursor_up;
  engine->cursor_down = cursor_down;
  engine->set_cursor_location = set_cursor_location;
  engine->set_capabilities = set_capabilities;
  engine->candidate_clicked = candidate_clicked;
  engine->property_activate = property_activate;
  engine->set_surrounding_text = set_surrounding_text;
  engine->set_content_type = set_content_type;
}
static void parity_engine_init(ParityEngine *engine G_GNUC_UNUSED) {
  created = TRUE;
}
static void setting_changed(GSettings *instance, gchar *key,
                            gpointer data G_GNUC_UNUSED) {
  if (!calls)
    return;
  gchar *value = g_settings_get_string(instance, key);
  begin_observation(calls, "SettingChanged");
  string_member(calls, "schemaId", "org.example.Parity");
  string_member(calls, "key", key);
  string_variant(calls, value);
  end_observation(calls);
  g_free(value);
}
static void emit_records(IBusEngine *engine) {
  IBusText *text = g_object_ref_sink(make_decorated());
  IBusLookupTable *table = g_object_ref_sink(make_table());
  IBusProperty *property = g_object_ref_sink(make_menu());
  IBusPropList *properties = g_object_ref_sink(ibus_prop_list_new());
  ibus_prop_list_append(properties, property);
  begin_observation(records, "CommitText");
  object_member(records, "text", text);
  end_observation(records);
  ibus_engine_commit_text(engine, text);
  begin_observation(records, "UpdatePreeditText");
  object_member(records, "text", text);
  integer_member(records, "cursor", 2);
  boolean_member(records, "visible", TRUE);
  integer_member(records, "mode", IBUS_ENGINE_PREEDIT_COMMIT);
  end_observation(records);
  ibus_engine_update_preedit_text_with_mode(engine, text, 2, TRUE,
                                            IBUS_ENGINE_PREEDIT_COMMIT);
  begin_observation(records, "UpdateAuxiliaryText");
  object_member(records, "text", text);
  boolean_member(records, "visible", FALSE);
  end_observation(records);
  ibus_engine_update_auxiliary_text(engine, text, FALSE);
  begin_observation(records, "UpdateLookupTable");
  object_member(records, "table", table);
  boolean_member(records, "visible", TRUE);
  end_observation(records);
  ibus_engine_update_lookup_table(engine, table, TRUE);
  begin_observation(records, "ShowPreeditText");
  end_observation(records);
  ibus_engine_show_preedit_text(engine);
  begin_observation(records, "HidePreeditText");
  end_observation(records);
  ibus_engine_hide_preedit_text(engine);
  begin_observation(records, "ShowAuxiliaryText");
  end_observation(records);
  ibus_engine_show_auxiliary_text(engine);
  begin_observation(records, "HideAuxiliaryText");
  end_observation(records);
  ibus_engine_hide_auxiliary_text(engine);
  begin_observation(records, "ShowLookupTable");
  end_observation(records);
  ibus_engine_show_lookup_table(engine);
  begin_observation(records, "HideLookupTable");
  end_observation(records);
  ibus_engine_hide_lookup_table(engine);
  begin_observation(records, "RegisterProperties");
  object_member(records, "properties", properties);
  end_observation(records);
  ibus_engine_register_properties(engine, properties);
  begin_observation(records, "UpdateProperty");
  object_member(records, "property", property);
  end_observation(records);
  ibus_engine_update_property(engine, property);
  begin_observation(records, "ForwardKeyEvent");
  integer_member(records, "keyval", IBUS_b);
  integer_member(records, "keycode", 56);
  integer_member(records, "state", 4);
  end_observation(records);
  ibus_engine_forward_key_event(engine, IBUS_b, 56, 4);
  begin_observation(records, "DeleteSurroundingText");
  integer_member(records, "offset", -2);
  integer_member(records, "count", 3);
  end_observation(records);
  ibus_engine_delete_surrounding_text(engine, -2, 3);
  begin_observation(records, "RequireSurroundingText");
  end_observation(records);
  ibus_engine_get_surrounding_text(engine, NULL, NULL, NULL);
  begin_observation(records, "SettingWritten");
  string_member(records, "schemaId", "org.example.Parity");
  string_member(records, "key", "sample");
  string_variant(records, "written");
  end_observation(records);
  g_settings_set_string(settings, "sample", "written");
  begin_observation(records, "Log");
  integer_member(records, "level", G_LOG_LEVEL_MESSAGE);
  string_member(records, "domain", "");
  string_member(records, "message", "parity message");
  end_observation(records);
  g_message("parity message");
  g_object_unref(properties);
  g_object_unref(property);
  g_object_unref(table);
  g_object_unref(text);
}
static int dispatch_file(const char *directory, const char *name) {
  GBytes *bytes = read_bytes(directory, name);
  gsize size;
  const guint8 *data = g_bytes_get_data(bytes, &size);
  int result = ibusweb_dispatch(data, size);
  g_bytes_unref(bytes);
  return result;
}
static void run_runtime(JsonArray *requests) {
  static int32_t wake_word;
  int initialized = ibusweb_runtime_init(&wake_word);
  if (initialized != 0)
    g_error("Runtime initialization: %d", initialized);
  IBusFactory *factory = ibus_factory_new(NULL);
  ibus_factory_add_engine(factory, "parity", parity_engine_get_type());
  JsonBuilder *results = json_builder_new();
  json_builder_begin_object(results);
  json_builder_set_member_name(results, "init");
  json_builder_begin_object(results);
  integer_member(results, "result", dispatch_file("lifecycle", "init"));
  settings = g_settings_new("org.example.Parity");
  gchar *initial = g_settings_get_string(settings, "sample");
  string_member(results, "value", initial);
  g_free(initial);
  json_builder_end_object(results);
  g_signal_connect(settings, "changed", G_CALLBACK(setting_changed), NULL);
  json_builder_set_member_name(results, "create");
  json_builder_begin_object(results);
  integer_member(results, "result", dispatch_file("lifecycle", "create"));
  boolean_member(results, "created", created);
  json_builder_end_object(results);
  for (guint i = 0; i < json_array_get_length(requests); i++) {
    const char *name = json_array_get_string_element(requests, i);
    calls = json_builder_new();
    json_builder_begin_array(calls);
    int result = dispatch_file("requests", name);
    ibusweb_pump();
    json_builder_end_array(calls);
    json_builder_set_member_name(results, name);
    json_builder_begin_object(results);
    integer_member(results, "result", result);
    json_builder_set_member_name(results, "calls");
    json_builder_add_value(results, json_builder_get_root(calls));
    json_builder_end_object(results);
    g_clear_object(&calls);
  }
  records = json_builder_new();
  json_builder_begin_array(records);
  guint8 trigger[20] = {0};
  guint16 kind = GUINT16_TO_LE(IBUSWEB_REQ_PROCESS_KEY_EVENT);
  guint32 ic = GUINT32_TO_LE(1);
  guint32 key = GUINT32_TO_LE(IBUS_Return);
  memcpy(trigger, &kind, sizeof(kind));
  memcpy(trigger + 4, &ic, sizeof(ic));
  memcpy(trigger + 8, &key, sizeof(key));
  ibusweb_dispatch(trigger, sizeof(trigger));
  json_builder_end_array(records);
  guint32 size;
  const guint8 *data = ibusweb_output_peek(&size);
  write_bytes("", "records.bin", data, size);
  write_json("", "records.json", records);
  g_object_unref(records);
  json_builder_set_member_name(results, "destroy");
  json_builder_begin_object(results);
  integer_member(results, "result", dispatch_file("lifecycle", "destroy"));
  boolean_member(results, "destroyed", destroyed);
  json_builder_end_object(results);
  json_builder_end_object(results);
  write_json("", "requests.json", results);
  g_object_unref(results);
  g_object_unref(settings);
  g_object_unref(factory);
}
int main(int argc, char **argv) {
  if (argc != 4)
    g_error("Usage: parity CORPUS OUTPUT SCHEMAS");
  corpus_dir = argv[1];
  output_dir = argv[2];
  g_setenv("GSETTINGS_SCHEMA_DIR", argv[3], TRUE);
  g_type_ensure(IBUS_TYPE_ATTRIBUTE);
  g_type_ensure(IBUS_TYPE_ATTR_LIST);
  g_type_ensure(IBUS_TYPE_TEXT);
  g_type_ensure(IBUS_TYPE_LOOKUP_TABLE);
  g_type_ensure(IBUS_TYPE_PROPERTY);
  g_type_ensure(IBUS_TYPE_PROP_LIST);
  JsonParser *parser = read_json("cases.json");
  JsonObject *cases = json_node_get_object(json_parser_get_root(parser));
  read_objects(json_object_get_array_member(cases, "objects"));
  create_objects();
  fuzz_normal_form();
  run_runtime(json_object_get_array_member(cases, "requests"));
  g_object_unref(parser);
  return 0;
}
