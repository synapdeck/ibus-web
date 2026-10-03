/* SPDX-FileCopyrightText: 2008-2015 Peng Huang <shawn.p.huang@gmail.com>
 * SPDX-FileCopyrightText: 2008-2025 Red Hat, Inc.
 * SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include "../output.h"
#include "ibusinternal.h"
#include "ibusmarshalers.h"
#include "ibusweb-private.h"
#include <ibus-web/protocol.h>
#include <string.h>

struct _IBusEnginePrivate {
  gchar *engine_name;
  IBusText *surrounding_text;
  guint surrounding_cursor_pos;
  guint selection_anchor_pos;
  guint content_purpose;
  guint content_hints;
  gboolean has_focus_id;
  gboolean has_active_surrounding_text;
  uint32_t ic;
};
static IBusText *text_empty;
G_DEFINE_TYPE_WITH_PRIVATE(IBusEngine, ibus_engine, IBUS_TYPE_SERVICE)
enum {
  PROP_NONE,
  PROP_ENGINE_NAME,
  PROP_HAS_FOCUS_ID,
  PROP_ACTIVE_SURROUNDING_TEXT
};

static gboolean ibus_engine_process_key_event(IBusEngine *engine, guint keyval,
                                              guint keycode, guint state) {
  return FALSE;
}

static void ibus_engine_focus_in(IBusEngine *engine) {}

static void ibus_engine_focus_out(IBusEngine *engine) {}

static void ibus_engine_focus_in_id(IBusEngine *engine,
                                    const gchar *object_path,
                                    const gchar *client) {}

static void ibus_engine_focus_out_id(IBusEngine *engine,
                                     const gchar *object_path) {}

static void ibus_engine_reset(IBusEngine *engine) {}

static void ibus_engine_enable(IBusEngine *engine) {}

static void ibus_engine_disable(IBusEngine *engine) {}

static void ibus_engine_set_cursor_location(IBusEngine *engine, gint x, gint y,
                                            gint w, gint h) {}

static void ibus_engine_set_capabilities(IBusEngine *engine, guint caps) {
  engine->client_capabilities = caps;
}

static void ibus_engine_page_up(IBusEngine *engine) {}

static void ibus_engine_page_down(IBusEngine *engine) {}

static void ibus_engine_cursor_up(IBusEngine *engine) {}

static void ibus_engine_cursor_down(IBusEngine *engine) {}

static void ibus_engine_property_activate(IBusEngine *engine,
                                          const gchar *prop_name,
                                          guint prop_state) {}

static void ibus_engine_property_show(IBusEngine *engine,
                                      const gchar *prop_name) {}

static void ibus_engine_property_hide(IBusEngine *engine,
                                      const gchar *prop_name) {}

static void ibus_engine_candidate_clicked(IBusEngine *engine, guint index,
                                          guint button, guint state) {}

static void ibus_engine_set_surrounding_text(IBusEngine *engine, IBusText *text,
                                             guint cursor_pos,
                                             guint anchor_pos) {
  g_assert(IBUS_IS_ENGINE(engine));

  if (engine->priv->surrounding_text) {
    g_object_unref(engine->priv->surrounding_text);
  }

  engine->priv->surrounding_text =
      (IBusText *)g_object_ref_sink(text ? text : text_empty);
  engine->priv->surrounding_cursor_pos = cursor_pos;
  engine->priv->selection_anchor_pos = anchor_pos;
}

static void ibus_engine_set_content_type(IBusEngine *engine, guint purpose,
                                         guint hints) {
  engine->priv->content_purpose = purpose;
  engine->priv->content_hints = hints;
}

static void set_property(GObject *object, guint id, const GValue *value,
                         GParamSpec *spec) {
  IBusEnginePrivate *priv = IBUS_ENGINE(object)->priv;
  switch (id) {
  case PROP_ENGINE_NAME:
    g_free(priv->engine_name);
    priv->engine_name = g_value_dup_string(value);
    break;
  case PROP_HAS_FOCUS_ID:
    priv->has_focus_id = g_value_get_boolean(value);
    break;
  case PROP_ACTIVE_SURROUNDING_TEXT:
    priv->has_active_surrounding_text = g_value_get_boolean(value);
    break;
  default:
    G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
  }
}
static void get_property(GObject *object, guint id, GValue *value,
                         GParamSpec *spec) {
  IBusEnginePrivate *priv = IBUS_ENGINE(object)->priv;
  switch (id) {
  case PROP_ENGINE_NAME:
    g_value_set_string(value, priv->engine_name);
    break;
  case PROP_HAS_FOCUS_ID:
    g_value_set_boolean(value, priv->has_focus_id);
    break;
  case PROP_ACTIVE_SURROUNDING_TEXT:
    g_value_set_boolean(value, priv->has_active_surrounding_text);
    break;
  default:
    G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
  }
}
static void destroy(IBusObject *object) {
  IBusEnginePrivate *priv = IBUS_ENGINE(object)->priv;
  g_clear_pointer(&priv->engine_name, g_free);
  g_clear_object(&priv->surrounding_text);
  IBUS_OBJECT_CLASS(ibus_engine_parent_class)->destroy(object);
}
static void ibus_engine_init(IBusEngine *engine) {
  engine->priv = ibus_engine_get_instance_private(engine);
  engine->priv->surrounding_text = g_object_ref(text_empty);
}
static void ibus_engine_class_init(IBusEngineClass *klass) {
  GObjectClass *gobject_class = G_OBJECT_CLASS(klass);
  gobject_class->set_property = set_property;
  gobject_class->get_property = get_property;
  IBUS_OBJECT_CLASS(klass)->destroy = destroy;
  klass->process_key_event = ibus_engine_process_key_event;
  klass->focus_in = ibus_engine_focus_in;
  klass->focus_out = ibus_engine_focus_out;
  klass->focus_in_id = ibus_engine_focus_in_id;
  klass->focus_out_id = ibus_engine_focus_out_id;
  klass->reset = ibus_engine_reset;
  klass->enable = ibus_engine_enable;
  klass->disable = ibus_engine_disable;
  klass->set_cursor_location = ibus_engine_set_cursor_location;
  klass->set_capabilities = ibus_engine_set_capabilities;
  klass->page_up = ibus_engine_page_up;
  klass->page_down = ibus_engine_page_down;
  klass->cursor_up = ibus_engine_cursor_up;
  klass->cursor_down = ibus_engine_cursor_down;
  klass->property_activate = ibus_engine_property_activate;
  klass->property_show = ibus_engine_property_show;
  klass->property_hide = ibus_engine_property_hide;
  klass->candidate_clicked = ibus_engine_candidate_clicked;
  klass->set_surrounding_text = ibus_engine_set_surrounding_text;
  klass->set_content_type = ibus_engine_set_content_type;
  g_object_class_install_property(
      gobject_class, PROP_ENGINE_NAME,
      g_param_spec_string("engine-name", "Engine name", "Engine name", "noname",
                          G_PARAM_READWRITE | G_PARAM_CONSTRUCT_ONLY |
                              G_PARAM_STATIC_STRINGS));
  g_object_class_install_property(
      gobject_class, PROP_HAS_FOCUS_ID,
      g_param_spec_boolean(
          "has-focus-id", "Has focus ID", "Has focus ID", FALSE,
          G_PARAM_READWRITE | G_PARAM_CONSTRUCT_ONLY | G_PARAM_STATIC_STRINGS));
  g_object_class_install_property(
      gobject_class, PROP_ACTIVE_SURROUNDING_TEXT,
      g_param_spec_boolean("active-surrounding-text", "Active surrounding text",
                           "Active surrounding text", FALSE,
                           G_PARAM_READWRITE | G_PARAM_CONSTRUCT_ONLY |
                               G_PARAM_STATIC_STRINGS));
  g_signal_new(I_("process-key-event"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST,
               G_STRUCT_OFFSET(IBusEngineClass, process_key_event),
               g_signal_accumulator_true_handled, NULL,
               _ibus_marshal_BOOLEAN__UINT_UINT_UINT, G_TYPE_BOOLEAN, 3,
               G_TYPE_UINT, G_TYPE_UINT, G_TYPE_UINT);
  g_signal_new(I_("focus-in"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST, G_STRUCT_OFFSET(IBusEngineClass, focus_in),
               NULL, NULL, _ibus_marshal_VOID__VOID, G_TYPE_NONE, 0);
  g_signal_new(I_("focus-in-id"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST, G_STRUCT_OFFSET(IBusEngineClass, focus_in_id),
               NULL, NULL, _ibus_marshal_VOID__STRING_STRING, G_TYPE_NONE, 2,
               G_TYPE_STRING, G_TYPE_STRING);
  g_signal_new(I_("focus-out"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST, G_STRUCT_OFFSET(IBusEngineClass, focus_out),
               NULL, NULL, _ibus_marshal_VOID__VOID, G_TYPE_NONE, 0);
  g_signal_new(I_("focus-out-id"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST,
               G_STRUCT_OFFSET(IBusEngineClass, focus_out_id), NULL, NULL,
               _ibus_marshal_VOID__STRING, G_TYPE_NONE, 1, G_TYPE_STRING);
  g_signal_new(I_("reset"), G_TYPE_FROM_CLASS(gobject_class), G_SIGNAL_RUN_LAST,
               G_STRUCT_OFFSET(IBusEngineClass, reset), NULL, NULL,
               _ibus_marshal_VOID__VOID, G_TYPE_NONE, 0);
  g_signal_new(I_("enable"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST, G_STRUCT_OFFSET(IBusEngineClass, enable),
               NULL, NULL, _ibus_marshal_VOID__VOID, G_TYPE_NONE, 0);
  g_signal_new(I_("disable"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST, G_STRUCT_OFFSET(IBusEngineClass, disable),
               NULL, NULL, _ibus_marshal_VOID__VOID, G_TYPE_NONE, 0);
  g_signal_new(I_("set-cursor-location"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST,
               G_STRUCT_OFFSET(IBusEngineClass, set_cursor_location), NULL,
               NULL, _ibus_marshal_VOID__INT_INT_INT_INT, G_TYPE_NONE, 4,
               G_TYPE_INT, G_TYPE_INT, G_TYPE_INT, G_TYPE_INT);
  g_signal_new(I_("set-capabilities"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST,
               G_STRUCT_OFFSET(IBusEngineClass, set_capabilities), NULL, NULL,
               _ibus_marshal_VOID__UINT, G_TYPE_NONE, 1, G_TYPE_UINT);
  g_signal_new(I_("page-up"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST, G_STRUCT_OFFSET(IBusEngineClass, page_up),
               NULL, NULL, _ibus_marshal_VOID__VOID, G_TYPE_NONE, 0);
  g_signal_new(I_("page-down"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST, G_STRUCT_OFFSET(IBusEngineClass, page_down),
               NULL, NULL, _ibus_marshal_VOID__VOID, G_TYPE_NONE, 0);
  g_signal_new(I_("cursor-up"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST, G_STRUCT_OFFSET(IBusEngineClass, cursor_up),
               NULL, NULL, _ibus_marshal_VOID__VOID, G_TYPE_NONE, 0);
  g_signal_new(I_("cursor-down"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST, G_STRUCT_OFFSET(IBusEngineClass, cursor_down),
               NULL, NULL, _ibus_marshal_VOID__VOID, G_TYPE_NONE, 0);
  g_signal_new(I_("candidate-clicked"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST,
               G_STRUCT_OFFSET(IBusEngineClass, candidate_clicked), NULL, NULL,
               _ibus_marshal_VOID__UINT_UINT_UINT, G_TYPE_NONE, 3, G_TYPE_UINT,
               G_TYPE_UINT, G_TYPE_UINT);
  g_signal_new(I_("property-activate"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST,
               G_STRUCT_OFFSET(IBusEngineClass, property_activate), NULL, NULL,
               _ibus_marshal_VOID__STRING_UINT, G_TYPE_NONE, 2, G_TYPE_STRING,
               G_TYPE_UINT);
  g_signal_new(I_("property-show"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST,
               G_STRUCT_OFFSET(IBusEngineClass, property_show), NULL, NULL,
               _ibus_marshal_VOID__STRING, G_TYPE_NONE, 1, G_TYPE_STRING);
  g_signal_new(I_("property-hide"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST,
               G_STRUCT_OFFSET(IBusEngineClass, property_hide), NULL, NULL,
               _ibus_marshal_VOID__STRING, G_TYPE_NONE, 1, G_TYPE_STRING);
  g_signal_new(I_("set-surrounding-text"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST,
               G_STRUCT_OFFSET(IBusEngineClass, set_surrounding_text), NULL,
               NULL, _ibus_marshal_VOID__OBJECT_UINT_UINT, G_TYPE_NONE, 3,
               G_TYPE_OBJECT, G_TYPE_UINT, G_TYPE_UINT);
  g_signal_new(I_("set-content-type"), G_TYPE_FROM_CLASS(gobject_class),
               G_SIGNAL_RUN_LAST,
               G_STRUCT_OFFSET(IBusEngineClass, set_content_type), NULL, NULL,
               _ibus_marshal_VOID__UINT_UINT, G_TYPE_NONE, 2, G_TYPE_UINT,
               G_TYPE_UINT);
  text_empty = g_object_ref_sink(ibus_text_new_from_static_string(""));
}

static void _g_object_unref_if_floating(gpointer instance) {
  if (g_object_is_floating(instance))
    g_object_unref(instance);
}

IBusEngine *ibus_engine_new(const gchar *engine_name, const gchar *object_path,
                            GDBusConnection *connection) {
  return ibus_engine_new_with_type(IBUS_TYPE_ENGINE, engine_name, object_path,
                                   connection);
}

IBusEngine *ibus_engine_new_with_type(GType engine_type,
                                      const gchar *engine_name,
                                      const gchar *object_path,
                                      GDBusConnection *connection) {
  g_return_val_if_fail(g_type_is_a(engine_type, IBUS_TYPE_ENGINE), NULL);
  g_return_val_if_fail(engine_name != NULL, NULL);
  g_return_val_if_fail(object_path != NULL, NULL);

  GObject *object =
      g_object_new(engine_type, "engine-name", engine_name, "object-path",
                   object_path, "connection", connection, NULL);
  return IBUS_ENGINE(object);
}

void ibus_engine_commit_text(IBusEngine *engine, IBusText *text) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  g_return_if_fail(IBUS_IS_TEXT(text));

  GVariant *variant = ibus_serializable_serialize((IBusSerializable *)text);
  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_COMMIT_TEXT,
                        g_variant_new("(v)", variant));

  _g_object_unref_if_floating(text);
}

void ibus_engine_update_preedit_text(IBusEngine *engine, IBusText *text,
                                     guint cursor_pos, gboolean visible) {
  ibus_engine_update_preedit_text_with_mode(engine, text, cursor_pos, visible,
                                            IBUS_ENGINE_PREEDIT_CLEAR);
}

void ibus_engine_update_preedit_text_with_mode(IBusEngine *engine,
                                               IBusText *text, guint cursor_pos,
                                               gboolean visible,
                                               IBusPreeditFocusMode mode) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  g_return_if_fail(IBUS_IS_TEXT(text));

  GVariant *variant = ibus_serializable_serialize((IBusSerializable *)text);
  ibusweb_output_append(
      engine->priv->ic, IBUSWEB_REC_UPDATE_PREEDIT_TEXT,
      g_variant_new("(vubu)", variant, cursor_pos, visible, mode));

  _g_object_unref_if_floating(text);
}

void ibus_engine_update_auxiliary_text(IBusEngine *engine, IBusText *text,
                                       gboolean visible) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  g_return_if_fail(IBUS_IS_TEXT(text));

  GVariant *variant = ibus_serializable_serialize((IBusSerializable *)text);
  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_UPDATE_AUXILIARY_TEXT,
                        g_variant_new("(vb)", variant, visible));

  _g_object_unref_if_floating(text);
}

void ibus_engine_update_lookup_table(IBusEngine *engine, IBusLookupTable *table,
                                     gboolean visible) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  g_return_if_fail(IBUS_IS_LOOKUP_TABLE(table));

  GVariant *variant = ibus_serializable_serialize((IBusSerializable *)table);
  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_UPDATE_LOOKUP_TABLE,
                        g_variant_new("(vb)", variant, visible));

  _g_object_unref_if_floating(table);
}

void ibus_engine_update_lookup_table_fast(IBusEngine *engine,
                                          IBusLookupTable *table,
                                          gboolean visible) {
  /* Note: gnome shell needs the previous page and next page
     to correctly show the page up/down arrows,
     send three pages instead of one page. */

  g_return_if_fail(IBUS_IS_ENGINE(engine));
  g_return_if_fail(IBUS_IS_LOOKUP_TABLE(table));

  IBusLookupTable *new_table;
  IBusText *text;
  gint page_begin;
  gint cursor_pos;
  gint i;

  if (table->candidates->len < table->page_size << 2) {
    ibus_engine_update_lookup_table(engine, table, visible);
    return;
  }

  page_begin = (table->cursor_pos / table->page_size) * table->page_size;
  cursor_pos = ibus_lookup_table_get_cursor_in_page(table);

  if (table->cursor_pos >= table->page_size) {
    /* has previous page, adjust the value. */
    page_begin -= table->page_size;
    cursor_pos += table->page_size;
  }

  new_table = ibus_lookup_table_new(table->page_size, 0, table->cursor_visible,
                                    table->round);

  /* '3' means the previous page, current page and next page. */
  for (i = page_begin;
       i < page_begin + 3 * table->page_size && i < table->candidates->len;
       i++) {
    ibus_lookup_table_append_candidate(
        new_table, ibus_lookup_table_get_candidate(table, i));
  }

  for (i = 0; (text = ibus_lookup_table_get_label(table, i)) != NULL; i++) {
    ibus_lookup_table_append_label(new_table, text);
  }

  ibus_lookup_table_set_cursor_pos(new_table, cursor_pos);
  ibus_lookup_table_set_orientation(new_table,
                                    ibus_lookup_table_get_orientation(table));

  ibus_engine_update_lookup_table(engine, new_table, visible);

  _g_object_unref_if_floating(table);
}

void ibus_engine_forward_key_event(IBusEngine *engine, guint keyval,
                                   guint keycode, guint state) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));

  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_FORWARD_KEY_EVENT,
                        g_variant_new("(uuu)", keyval, keycode, state));
}

void ibus_engine_delete_surrounding_text(IBusEngine *engine,
                                         gint offset_from_cursor,
                                         guint nchars) {
  IBusEnginePrivate *priv;

  g_return_if_fail(IBUS_IS_ENGINE(engine));

  priv = engine->priv;

  /* Update surrounding-text cache.  This is necessary since some
     engines call ibus_engine_get_surrounding_text() immediately
     after ibus_engine_delete_surrounding_text(). */
  if (priv->surrounding_text) {
    IBusText *text;
    glong cursor_pos, len;

    cursor_pos = priv->surrounding_cursor_pos + offset_from_cursor;
    len = ibus_text_get_length(priv->surrounding_text);
    if (cursor_pos >= 0 && len - cursor_pos >= nchars) {
      gunichar *ucs;

      ucs = g_utf8_to_ucs4_fast(priv->surrounding_text->text, -1, NULL);
      memmove(&ucs[cursor_pos], &ucs[cursor_pos + nchars],
              sizeof(gunichar) * (len - cursor_pos - nchars));
      ucs[len - nchars] = 0;
      text = ibus_text_new_from_ucs4(ucs);
      g_free(ucs);
      priv->surrounding_cursor_pos = cursor_pos;
    } else {
      text = text_empty;
      priv->surrounding_cursor_pos = 0;
    }

    g_object_unref(priv->surrounding_text);
    priv->surrounding_text = g_object_ref_sink(text);
  }

  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_DELETE_SURROUNDING_TEXT,
                        g_variant_new("(iu)", offset_from_cursor, nchars));
}

void ibus_engine_get_surrounding_text(IBusEngine *engine, IBusText **text,
                                      guint *cursor_pos, guint *anchor_pos) {
  IBusEnginePrivate *priv;

  g_return_if_fail(IBUS_IS_ENGINE(engine));
  const gboolean signal_only = (text == NULL);

  g_return_if_fail((signal_only && (cursor_pos == NULL)) ||
                   (!signal_only && (cursor_pos != NULL)));

  g_return_if_fail((signal_only && (anchor_pos == NULL)) ||
                   (!signal_only && (anchor_pos != NULL)));

  priv = engine->priv;

  if (!signal_only) {
    *text = g_object_ref(priv->surrounding_text);
    *cursor_pos = priv->surrounding_cursor_pos;
    *anchor_pos = priv->selection_anchor_pos;
  }

  /* tell the client that this engine will utilize surrounding-text
   * feature, which causes periodical update.  Note that the client
   * should request the initial surrounding-text when the engine is
   * enabled (see ibus_im_context_focus_in() and
   * _ibus_context_enabled_cb() in client/gtk2/ibusimcontext.c). */
  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT,
                        g_variant_new("()"));
}

void ibus_engine_get_content_type(IBusEngine *engine, guint *purpose,
                                  guint *hints) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));

  *purpose = engine->priv->content_purpose;
  *hints = engine->priv->content_hints;
}

void ibus_engine_register_properties(IBusEngine *engine,
                                     IBusPropList *prop_list) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  g_return_if_fail(IBUS_IS_PROP_LIST(prop_list));

  GVariant *variant =
      ibus_serializable_serialize((IBusSerializable *)prop_list);
  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_REGISTER_PROPERTIES,
                        g_variant_new("(v)", variant));

  _g_object_unref_if_floating(prop_list);
}

void ibus_engine_update_property(IBusEngine *engine, IBusProperty *prop) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  g_return_if_fail(IBUS_IS_PROPERTY(prop));

  GVariant *variant = ibus_serializable_serialize((IBusSerializable *)prop);
  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_UPDATE_PROPERTY,
                        g_variant_new("(v)", variant));

  _g_object_unref_if_floating(prop);
}

const gchar *ibus_engine_get_name(IBusEngine *engine) {
  g_return_val_if_fail(IBUS_IS_ENGINE(engine), NULL);
  return engine->priv->engine_name;
}

void ibus_engine_show_preedit_text(IBusEngine *engine) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_SHOW_PREEDIT_TEXT,
                        g_variant_new("()"));
}

void ibus_engine_hide_preedit_text(IBusEngine *engine) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_HIDE_PREEDIT_TEXT,
                        g_variant_new("()"));
}

void ibus_engine_show_auxiliary_text(IBusEngine *engine) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_SHOW_AUXILIARY_TEXT,
                        g_variant_new("()"));
}

void ibus_engine_hide_auxiliary_text(IBusEngine *engine) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_HIDE_AUXILIARY_TEXT,
                        g_variant_new("()"));
}

void ibus_engine_show_lookup_table(IBusEngine *engine) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_SHOW_LOOKUP_TABLE,
                        g_variant_new("()"));
}

void ibus_engine_hide_lookup_table(IBusEngine *engine) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  ibusweb_output_append(engine->priv->ic, IBUSWEB_REC_HIDE_LOOKUP_TABLE,
                        g_variant_new("()"));
}

void ibusweb_engine_set_ic(IBusEngine *engine, uint32_t ic) {
  g_return_if_fail(IBUS_IS_ENGINE(engine));
  engine->priv->ic = ic;
}
uint32_t ibusweb_engine_get_ic(IBusEngine *engine) {
  g_return_val_if_fail(IBUS_IS_ENGINE(engine), 0);
  return engine->priv->ic;
}
