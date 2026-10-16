/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include "dispatch.h"
#include "ibus/ibusweb-private.h"
#include "ops.h"
#include "settings.h"
#include <errno.h>
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <string.h>

static gboolean initialized;
static GHashTable *engines;
/* Set once an engine's exception has been caught: the engines' state can't
 * be trusted, so no request or source reaches them again. The first fault's
 * reason stays. */
static gchar *fault_reason; /* (atomic) (owned) */
/* Set once Shutdown has called the modules' shutdown functions, which may
 * have freed what the engines use. */
static gboolean shut_down;
/* What Init said; true until it has run. */
static gint user_data_writable = TRUE; /* (atomic) */

typedef struct {
  IBusWebRequestHeader header;
  GVariant *payload;
} Request;

/* Upstream's deserializers assume well-typed objects. Validate the text's
 * nested objects before calling them on bytes received from the host. */
static gboolean object_matches(GVariant *value, const gchar *type,
                               const gchar *name) {
  if (!g_variant_is_of_type(value, G_VARIANT_TYPE(type)))
    return FALSE;
  const gchar *actual;
  g_variant_get_child(value, 0, "&s", &actual);
  if (!g_str_equal(actual, name))
    return FALSE;
  g_autoptr(GVariant) attachments = g_variant_get_child_value(value, 1);
  GVariantIter iter;
  GVariant *attachment;
  g_variant_iter_init(&iter, attachments);
  while (g_variant_iter_next(&iter, "{&sv}", NULL, &attachment)) {
    gboolean valid = g_variant_is_of_type(attachment, G_VARIANT_TYPE_VARIANT);
    g_variant_unref(attachment);
    if (!valid)
      return FALSE;
  }
  return TRUE;
}

static IBusText *deserialize_text(GVariant *value) {
  if (!object_matches(value, "(sa{sv}sv)", "IBusText"))
    return NULL;
  g_autoptr(GVariant) boxed = g_variant_get_child_value(value, 3);
  g_autoptr(GVariant) attributes = g_variant_get_variant(boxed);
  if (!object_matches(attributes, "(sa{sv}av)", "IBusAttrList"))
    return NULL;
  g_autoptr(GVariant) array = g_variant_get_child_value(attributes, 2);
  GVariantIter iter;
  GVariant *attribute;
  g_variant_iter_init(&iter, array);
  while (g_variant_iter_next(&iter, "v", &attribute)) {
    gboolean valid = object_matches(attribute, "(sa{sv}uuuu)", "IBusAttribute");
    g_variant_unref(attribute);
    if (!valid)
      return NULL;
  }
  g_type_ensure(IBUS_TYPE_TEXT);
  g_type_ensure(IBUS_TYPE_ATTR_LIST);
  g_type_ensure(IBUS_TYPE_ATTRIBUTE);
  return IBUS_TEXT(ibus_serializable_deserialize(value));
}

static const gchar *empty_signal(guint16 kind) {
  switch (kind) {
  case IBUSWEB_REQ_FOCUS_IN:
    return "focus-in";
  case IBUSWEB_REQ_FOCUS_OUT:
    return "focus-out";
  case IBUSWEB_REQ_RESET:
    return "reset";
  case IBUSWEB_REQ_ENABLE:
    return "enable";
  case IBUSWEB_REQ_DISABLE:
    return "disable";
  case IBUSWEB_REQ_PAGE_UP:
    return "page-up";
  case IBUSWEB_REQ_PAGE_DOWN:
    return "page-down";
  case IBUSWEB_REQ_CURSOR_UP:
    return "cursor-up";
  case IBUSWEB_REQ_CURSOR_DOWN:
    return "cursor-down";
  default:
    return NULL;
  }
}

static int32_t route(gpointer data) {
  const Request *request = data;
  guint16 kind = request->header.kind;
  guint32 ic = request->header.ic;
  GVariant *payload = request->payload;
  if (kind == IBUSWEB_REQ_INIT) {
    if (initialized)
      return -EALREADY;
    guint version;
    g_variant_get_child(payload, 0, "u", &version);
    if (version != IBUSWEB_PROTOCOL_VERSION)
      return -EPROTO;
    gboolean writable;
    g_variant_get_child(payload, 1, "b", &writable);
    g_atomic_int_set(&user_data_writable, writable);

    /* Before the snapshot, whose warnings belong in the output too. */
    ibusweb_log_init();
    g_autoptr(GVariant) snapshot = g_variant_get_child_value(payload, 2);
    g_autoptr(GVariant) patterns = g_variant_get_child_value(payload, 3);
    ibusweb_settings_init(snapshot, patterns);
    engines = g_hash_table_new(g_direct_hash, g_direct_equal);
    initialized = TRUE;
    return 0;
  }
  if (!initialized)
    return -ENOTCONN;
  if (kind == IBUSWEB_REQ_SETTING_CHANGED) {
    const gchar *path, *key;
    g_autoptr(GVariant) value = NULL;
    g_variant_get(payload, "(&s&sv)", &path, &key, &value);
    return ibusweb_settings_changed(path, key, value);
  }
  if (kind == IBUSWEB_REQ_PERSIST) {
    ibusweb_modules_persist();
    return 0;
  }
  if (kind == IBUSWEB_REQ_SHUTDOWN) {
    shut_down = TRUE;
    ibusweb_modules_shutdown();
    return 0;
  }
  IBusEngine *engine = g_hash_table_lookup(engines, GUINT_TO_POINTER(ic));
  if (kind == IBUSWEB_REQ_CREATE_ENGINE) {
    if (engine != NULL)
      return -EEXIST;
    const gchar *name;
    g_variant_get(payload, "(&s)", &name);
    gint error;
    engine = ibusweb_factory_create(ic, name, &error);
    if (engine == NULL)
      return error;
    g_hash_table_insert(engines, GUINT_TO_POINTER(ic), engine);
    return 0;
  }
  if (engine == NULL)
    return -ENOENT;
  if (kind == IBUSWEB_REQ_DESTROY_ENGINE) {
    g_hash_table_remove(engines, GUINT_TO_POINTER(ic));
    ibus_object_destroy(IBUS_OBJECT(engine));
    g_object_unref(engine);
    return 0;
  }
  const gchar *signal = empty_signal(kind);
  if (signal != NULL) {
    g_signal_emit_by_name(engine, signal);
    return 0;
  }
  switch (kind) {
  case IBUSWEB_REQ_PROCESS_KEY_EVENT: {
    guint keyval, keycode, state;
    gboolean handled = FALSE;
    g_variant_get(payload, "(uuu)", &keyval, &keycode, &state);
    g_signal_emit_by_name(engine, "process-key-event", keyval, keycode, state,
                          &handled);
    return handled ? 1 : 0;
  }
  case IBUSWEB_REQ_SET_CURSOR_LOCATION: {
    gint x, y, width, height;
    g_variant_get(payload, "(iiii)", &x, &y, &width, &height);
    engine->cursor_area.x = x;
    engine->cursor_area.y = y;
    engine->cursor_area.width = width;
    engine->cursor_area.height = height;
    g_signal_emit_by_name(engine, "set-cursor-location", x, y, width, height);
    return 0;
  }
  case IBUSWEB_REQ_SET_CAPABILITIES: {
    guint capabilities;
    g_variant_get(payload, "(u)", &capabilities);
    engine->client_capabilities = capabilities;
    g_signal_emit_by_name(engine, "set-capabilities", capabilities);
    return 0;
  }
  case IBUSWEB_REQ_CANDIDATE_CLICKED: {
    guint index, button, state;
    g_variant_get(payload, "(uuu)", &index, &button, &state);
    g_signal_emit_by_name(engine, "candidate-clicked", index, button, state);
    return 0;
  }
  case IBUSWEB_REQ_PROPERTY_ACTIVATE: {
    const gchar *name;
    guint state;
    g_variant_get(payload, "(&su)", &name, &state);
    g_signal_emit_by_name(engine, "property-activate", name, state);
    return 0;
  }
  case IBUSWEB_REQ_SET_SURROUNDING_TEXT: {
    GVariant *serialized;
    guint cursor, anchor;
    g_variant_get(payload, "(vuu)", &serialized, &cursor, &anchor);
    IBusText *text = deserialize_text(serialized);
    g_variant_unref(serialized);
    if (text == NULL)
      return -EBADMSG;
    g_object_ref_sink(text);
    guint length = ibus_text_get_length(text);
    if (cursor > length || anchor > length) {
      g_object_unref(text);
      return -EINVAL;
    }
    g_signal_emit_by_name(engine, "set-surrounding-text", text, cursor, anchor);
    g_object_unref(text);
    return 0;
  }
  case IBUSWEB_REQ_SET_CONTENT_TYPE: {
    guint purpose, hints;
    g_variant_get(payload, "(uu)", &purpose, &hints);
    guint old_purpose, old_hints;
    ibus_engine_get_content_type(engine, &old_purpose, &old_hints);
    if (purpose == old_purpose && hints == old_hints)
      return 0;
    ibusweb_engine_set_content_type(engine, purpose, hints);
    g_signal_emit_by_name(engine, "set-content-type", purpose, hints);
    return 0;
  }
  default:
    return -ENOSYS;
  }
}

void ibusweb_factory_fail_create(const char *reason) {
  g_return_if_fail(reason != NULL);
  if (!ibusweb_factory_fail(reason))
    g_critical("ibusweb_factory_fail_create() called outside a CreateEngine");
}

void ibusweb_runtime_fault(const char *reason) {
  gchar *copy = g_strdup(reason);
  if (!g_atomic_pointer_compare_and_exchange(&fault_reason, NULL, copy))
    g_free(copy);
  ibusweb_runtime_wake();
}

const char *ibusweb_fault_reason(void) {
  return g_atomic_pointer_get(&fault_reason);
}

bool ibusweb_user_data_writable(void) {
  return g_atomic_int_get(&user_data_writable);
}

gboolean ibusweb_runtime_faulted(void) {
  return g_atomic_pointer_get(&fault_reason) != NULL;
}

gboolean ibusweb_runtime_stopped(void) {
  return ibusweb_runtime_faulted() || shut_down;
}

int32_t ibusweb_dispatch(const uint8_t *bytes, uint32_t len) {
  if (ibusweb_runtime_faulted())
    return -ENOTRECOVERABLE;
  if (shut_down)
    return -ESHUTDOWN;
  if (!g_main_context_is_owner(g_main_context_default()))
    return -EPERM;
  if (bytes == NULL || len < sizeof(IBusWebRequestHeader))
    return -EBADMSG;
  Request request;
  memcpy(&request.header, bytes, sizeof request.header);
  request.header.kind = GUINT16_FROM_LE(request.header.kind);
  request.header.flags = GUINT16_FROM_LE(request.header.flags);
  request.header.ic = GUINT32_FROM_LE(request.header.ic);
  if (request.header.flags != 0)
    return -EBADMSG;
  const gchar *signature = ibusweb_request_signature(request.header.kind);
  if (signature == NULL)
    return -ENOSYS;
  /* Engines can retain nested variants after the host reuses its request slot.
   */
  gsize payload_len = len - sizeof request.header;
  gpointer payload = g_memdup2(bytes + sizeof request.header, payload_len);
  request.payload = g_variant_ref_sink(g_variant_new_from_data(
      G_VARIANT_TYPE(signature), payload, payload_len, FALSE, g_free, payload));
  gint32 result = -EBADMSG;
  if (g_variant_is_normal_form(request.payload))
    result = ibusweb_dispatch_call(request.header.kind, route, &request);
  /* An exception caught inside GLib lets the request run on to its reply, so
   * the fault, not the reply, says what happened. */
  if (ibusweb_runtime_faulted())
    result = -ECANCELED;
  g_variant_unref(request.payload);
  return result;
}
