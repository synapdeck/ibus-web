// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#include "driver.h"
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <string.h>

typedef struct {
  guint32 context_id;
  gchar *name;
} Checkpoint;

typedef struct {
  GHashTable *contexts;
  GHashTable *names;
  GQueue checkpoints;
  guint step;
  guint32 next_context;
  guint32 last_sequence;
  gint32 *wake_word;
} Driver;

static gboolean fail(GError **error, const gchar *message) {
  g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED, message);
  return FALSE;
}

static void emit(Driver *driver, JsonObject *object, const gchar *kind) {
  json_object_set_string_member(object, "kind", kind);
  json_object_set_int_member(object, "step", driver->step);
  JsonNode *node = json_node_new(JSON_NODE_OBJECT);
  json_node_take_object(node, object);
  ibus_test_write(node);
  json_node_free(node);
}

static void checkpoint_free(gpointer data) {
  Checkpoint *checkpoint = data;
  g_free(checkpoint->name);
  g_free(checkpoint);
}

static const gchar *event_name(guint16 kind) {
  switch (kind) {
  case IBUSWEB_REC_COMMIT_TEXT:
    return "CommitText";
  case IBUSWEB_REC_UPDATE_PREEDIT_TEXT:
    return "UpdatePreeditText";
  case IBUSWEB_REC_UPDATE_AUXILIARY_TEXT:
    return "UpdateAuxiliaryText";
  case IBUSWEB_REC_UPDATE_LOOKUP_TABLE:
    return "UpdateLookupTable";
  case IBUSWEB_REC_SHOW_PREEDIT_TEXT:
    return "ShowPreeditText";
  case IBUSWEB_REC_HIDE_PREEDIT_TEXT:
    return "HidePreeditText";
  case IBUSWEB_REC_SHOW_AUXILIARY_TEXT:
    return "ShowAuxiliaryText";
  case IBUSWEB_REC_HIDE_AUXILIARY_TEXT:
    return "HideAuxiliaryText";
  case IBUSWEB_REC_SHOW_LOOKUP_TABLE:
    return "ShowLookupTable";
  case IBUSWEB_REC_HIDE_LOOKUP_TABLE:
    return "HideLookupTable";
  case IBUSWEB_REC_REGISTER_PROPERTIES:
    return "RegisterProperties";
  case IBUSWEB_REC_UPDATE_PROPERTY:
    return "UpdateProperty";
  case IBUSWEB_REC_FORWARD_KEY_EVENT:
    return "ForwardKeyEvent";
  case IBUSWEB_REC_DELETE_SURROUNDING_TEXT:
    return "DeleteSurroundingText";
  case IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT:
    return "RequireSurroundingText";
  default:
    return NULL;
  }
}

static gboolean record_output(Driver *driver, guint16 kind, guint32 id,
                              GVariant *payload, GError **error) {
  if (kind == IBUSWEB_REC_LOG) {
    guint level;
    const gchar *domain, *message;
    g_variant_get(payload, "(u&s&s)", &level, &domain, &message);
    g_printerr("runtime log [%u] %s: %s\n", level, domain, message);
    if (level &
        (G_LOG_LEVEL_WARNING | G_LOG_LEVEL_CRITICAL | G_LOG_LEVEL_ERROR)) {
      g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                  "unexpected runtime log [%u] %s: %s", level, domain, message);
      return FALSE;
    }
    return TRUE;
  }
  const gchar *name = event_name(kind);
  const gchar *context =
      g_hash_table_lookup(driver->names, GUINT_TO_POINTER(id));
  if (!context || !name) {
    gchar *text = g_variant_print(payload, TRUE);
    g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                "unsupported output kind=%u context=%u signature=%s payload=%s",
                kind, id, g_variant_get_type_string(payload), text);
    g_free(text);
    return FALSE;
  }
  JsonObject *object = json_object_new();
  json_object_set_string_member(object, "context", context);
  json_object_set_string_member(object, "name", name);
  json_object_set_member(object, "payload", ibus_test_value(payload));
  emit(driver, object, "event");
  Checkpoint *checkpoint = g_new0(Checkpoint, 1);
  checkpoint->context_id = id;
  checkpoint->name = g_strdup(name);
  g_queue_push_tail(&driver->checkpoints, checkpoint);
  return TRUE;
}

static gboolean collect(Driver *driver, GError **error) {
  guint32 length;
  const guint8 *bytes = ibusweb_output_peek(&length);
  guint32 offset = 0;
  gboolean ok = TRUE;
  while (offset < length) {
    if (length - offset < sizeof(IBusWebRecordHeader))
      return fail(error, "truncated output header");
    IBusWebRecordHeader header;
    memcpy(&header, bytes + offset, sizeof header);
    guint32 payload_length = GUINT32_FROM_LE(header.len);
    guint64 padded = (sizeof header + (guint64)payload_length + 7) & ~7ULL;
    guint16 kind = GUINT16_FROM_LE(header.kind);
    const gchar *signature = ibusweb_record_signature(kind);
    if (padded > length - offset || !signature || header.flags != 0 ||
        GUINT32_FROM_LE(header.seq) != driver->last_sequence + 1)
      return fail(error, "invalid output frame, signature, or sequence");
    driver->last_sequence++;
    gpointer copy = g_memdup2(bytes + offset + sizeof header, payload_length);
    GVariant *payload = g_variant_ref_sink(g_variant_new_from_data(
        G_VARIANT_TYPE(signature), copy, payload_length, FALSE, g_free, copy));
    if (!g_variant_is_normal_form(payload)) {
      g_variant_unref(payload);
      return fail(error, "noncanonical output payload");
    }
    /* Keep later records even when an earlier diagnostic fails the run. */
    GError *record_error = NULL;
    if (!record_output(driver, kind, GUINT32_FROM_LE(header.ic), payload,
                       &record_error)) {
      JsonObject *diagnostic = json_object_new();
      json_object_set_string_member(diagnostic, "message",
                                    record_error->message);
      emit(driver, diagnostic, "error");
      if (ok)
        g_propagate_error(error, record_error);
      else
        g_error_free(record_error);
      ok = FALSE;
    }
    g_variant_unref(payload);
    offset += padded;
  }
  ibusweb_output_consume(length);
  return ok;
}

static gboolean pump(Driver *driver, gint32 *delay, GError **error) {
  *delay = ibusweb_pump();
  if (*delay == IBUSWEB_PUMP_ERROR)
    return fail(error, "runtime pump failed");
  return collect(driver, error);
}

static gint dispatch(Driver *driver, guint32 id, guint16 kind,
                     GVariant *payload, GError **error) {
  g_variant_take_ref(payload);
  const gchar *signature = ibusweb_request_signature(kind);
  if (!signature || !g_variant_is_of_type(payload, G_VARIANT_TYPE(signature))) {
    g_variant_unref(payload);
    fail(error, "unknown request or incorrect argument signature");
    return -1;
  }
  gsize length = sizeof(IBusWebRequestHeader) + g_variant_get_size(payload);
  guint8 *bytes = g_malloc(length);
  IBusWebRequestHeader header = {.kind = GUINT16_TO_LE(kind),
                                 .ic = GUINT32_TO_LE(id)};
  memcpy(bytes, &header, sizeof header);
  g_variant_store(payload, bytes + sizeof header);
  gint result = ibusweb_dispatch(bytes, length);
  memset(bytes, 0xa5, length);
  g_free(bytes);
  g_variant_unref(payload);
  gint32 delay;
  if (!pump(driver, &delay, error))
    return -1;
  if (result < 0)
    g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                "runtime request %u failed: %d", kind, result);
  return result;
}

static guint16 method_kind(const gchar *method) {
  static const struct {
    const gchar *name;
    guint16 kind;
  } methods[] = {
      {"ProcessKeyEvent", IBUSWEB_REQ_PROCESS_KEY_EVENT},
      {"FocusIn", IBUSWEB_REQ_FOCUS_IN},
      {"FocusOut", IBUSWEB_REQ_FOCUS_OUT},
      {"Reset", IBUSWEB_REQ_RESET},
      {"Enable", IBUSWEB_REQ_ENABLE},
      {"Disable", IBUSWEB_REQ_DISABLE},
      {"SetCursorLocation", IBUSWEB_REQ_SET_CURSOR_LOCATION},
      {"SetCapabilities", IBUSWEB_REQ_SET_CAPABILITIES},
      {"PageUp", IBUSWEB_REQ_PAGE_UP},
      {"PageDown", IBUSWEB_REQ_PAGE_DOWN},
      {"CursorUp", IBUSWEB_REQ_CURSOR_UP},
      {"CursorDown", IBUSWEB_REQ_CURSOR_DOWN},
      {"CandidateClicked", IBUSWEB_REQ_CANDIDATE_CLICKED},
      {"PropertyActivate", IBUSWEB_REQ_PROPERTY_ACTIVATE},
      {"SetSurroundingText", IBUSWEB_REQ_SET_SURROUNDING_TEXT},
      {"SetContentType", IBUSWEB_REQ_SET_CONTENT_TYPE},
  };
  for (guint i = 0; i < G_N_ELEMENTS(methods); i++)
    if (g_str_equal(methods[i].name, method))
      return methods[i].kind;
  return 0;
}

static gboolean consume_checkpoint(Driver *driver, guint32 id,
                                   const gchar *name) {
  for (GList *link = driver->checkpoints.head; link; link = link->next) {
    Checkpoint *checkpoint = link->data;
    if (checkpoint->context_id == id && g_str_equal(checkpoint->name, name)) {
      checkpoint_free(checkpoint);
      g_queue_delete_link(&driver->checkpoints, link);
      return TRUE;
    }
  }
  return FALSE;
}

static void clear_checkpoints(Driver *driver, guint32 id) {
  GList *link = driver->checkpoints.head;
  while (link) {
    GList *next = link->next;
    Checkpoint *checkpoint = link->data;
    if (checkpoint->context_id == id) {
      checkpoint_free(checkpoint);
      g_queue_delete_link(&driver->checkpoints, link);
    }
    link = next;
  }
}

static gboolean wait_event(Driver *driver, guint32 id, const gchar *name,
                           gint64 timeout_ms, GError **error) {
  gint64 deadline = g_get_monotonic_time() + timeout_ms * 1000;
  while (!consume_checkpoint(driver, id, name)) {
    gint32 seen = __atomic_load_n(driver->wake_word, __ATOMIC_SEQ_CST);
    gint32 delay;
    if (!pump(driver, &delay, error))
      return FALSE;
    if (consume_checkpoint(driver, id, name))
      return TRUE;
    gint64 remaining = (deadline - g_get_monotonic_time() + 999) / 1000;
    if (remaining <= 0)
      return fail(error, "event wait deadline exceeded");
    gint32 bounded = (gint32)MIN(remaining, G_MAXINT32);
    if (delay >= 0)
      bounded = MIN(bounded, delay);
    ibusweb_wait(seen, bounded);
  }
  return TRUE;
}

static gboolean execute_step(Driver *driver, JsonObject *step, GError **error) {
  const gchar *operation = json_object_get_string_member(step, "op");
  const gchar *context = json_object_get_string_member(step, "context");
  guint32 id = GPOINTER_TO_UINT(g_hash_table_lookup(driver->contexts, context));
  gint result = 0;
  gboolean boolean_reply = FALSE;
  if (g_str_equal(operation, "create")) {
    if (id)
      return fail(error, "duplicate live context");
    id = ++driver->next_context;
    g_hash_table_insert(driver->contexts, g_strdup(context),
                        GUINT_TO_POINTER(id));
    g_hash_table_insert(driver->names, GUINT_TO_POINTER(id), g_strdup(context));
    result = dispatch(
        driver, id, IBUSWEB_REQ_CREATE_ENGINE,
        g_variant_new("(s)", json_object_get_string_member(step, "engine")),
        error);
  } else {
    if (!id)
      return fail(error, "unknown context");
    if (g_str_equal(operation, "wait")) {
      if (!wait_event(driver, id, json_object_get_string_member(step, "event"),
                      json_object_get_int_member(step, "timeoutMs"), error))
        return FALSE;
    } else if (g_str_equal(operation, "destroy")) {
      result = dispatch(driver, id, IBUSWEB_REQ_DESTROY_ENGINE,
                        g_variant_new("()"), error);
      g_hash_table_remove(driver->contexts, context);
      g_hash_table_remove(driver->names, GUINT_TO_POINTER(id));
      clear_checkpoints(driver, id);
    } else if (g_str_equal(operation, "call")) {
      guint16 kind = method_kind(json_object_get_string_member(step, "method"));
      GVariant *arguments =
          ibus_test_args(json_object_get_string_member(step, "args"), error);
      if (!arguments)
        return FALSE;
      boolean_reply = kind == IBUSWEB_REQ_PROCESS_KEY_EVENT;
      result = dispatch(driver, id, kind, arguments, error);
    } else
      return fail(error, "unknown trace operation");
  }
  if (result < 0)
    return FALSE;
  JsonObject *reply = json_object_new();
  if (boolean_reply)
    json_object_set_boolean_member(reply, "value", result != 0);
  else
    json_object_set_null_member(reply, "value");
  emit(driver, reply, "reply");
  return TRUE;
}

static void settings_builder_free(gpointer data) {
  g_variant_builder_unref(data);
}

static GVariant *settings_snapshot(JsonArray *settings, GError **error) {
  GHashTable *schemas = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                              settings_builder_free);
  gboolean ok = TRUE;
  for (guint i = 0; i < json_array_get_length(settings); i++) {
    JsonObject *setting = json_array_get_object_element(settings, i);
    const gchar *schema = json_object_get_string_member(setting, "schema");
    GVariant *value =
        g_variant_parse(NULL, json_object_get_string_member(setting, "value"),
                        NULL, NULL, error);
    if (!value) {
      ok = FALSE;
      break;
    }
    GVariantBuilder *keys = g_hash_table_lookup(schemas, schema);
    if (!keys) {
      keys = g_variant_builder_new(G_VARIANT_TYPE("a{sv}"));
      g_hash_table_insert(schemas, g_strdup(schema), keys);
    }
    g_variant_builder_add(keys, "{sv}",
                          json_object_get_string_member(setting, "key"), value);
    g_variant_unref(value);
  }
  GVariantBuilder snapshot;
  g_variant_builder_init(&snapshot, G_VARIANT_TYPE("a{sa{sv}}"));
  GHashTableIter iterator;
  gpointer schema, keys;
  g_hash_table_iter_init(&iterator, schemas);
  while (g_hash_table_iter_next(&iterator, &schema, &keys))
    g_variant_builder_add(&snapshot, "{s@a{sv}}", (gchar *)schema,
                          g_variant_builder_end(keys));
  g_hash_table_unref(schemas);
  if (!ok) {
    g_variant_builder_clear(&snapshot);
    return NULL;
  }
  return g_variant_builder_end(&snapshot);
}

gboolean ibus_test_wasm_run(JsonObject *trace, const gchar *module,
                            GLogLevelFlags runtime_fatal_mask) {
  static gint32 wake_word;
  Driver driver = {
      .wake_word = &wake_word,
      .contexts = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL),
      .names =
          g_hash_table_new_full(g_direct_hash, g_direct_equal, NULL, g_free),
  };
  GError *error = NULL;
  gboolean ok = ibusweb_runtime_init(driver.wake_word) == 0;
  if (!ok)
    fail(&error, "runtime initialization failed");
  GVariant *snapshot =
      ok ? settings_snapshot(json_object_get_array_member(trace, "settings"),
                             &error)
         : NULL;
  if (ok)
    ok = snapshot != NULL;
  if (ok)
    ok = dispatch(
             &driver, 0, IBUSWEB_REQ_INIT,
             g_variant_new("(u@a{sa{sv}})", IBUSWEB_PROTOCOL_VERSION, snapshot),
             &error) >= 0;
  /* Init has installed the framed writer; collection now rejects warnings. */
  g_log_set_always_fatal(runtime_fatal_mask);
  if (ok) {
    g_log_set_default_handler(g_log_default_handler, NULL);
    gint loaded = ibusweb_load_module(module, NULL);
    gint32 delay;
    ok = pump(&driver, &delay, &error);
    if (ok && loaded < 0)
      ok = fail(&error, "side module load failed");
  }
  JsonArray *steps = json_object_get_array_member(trace, "steps");
  guint count = json_array_get_length(steps);
  for (guint i = 0; ok && i < count; i++) {
    driver.step = i;
    ok = execute_step(&driver, json_array_get_object_element(steps, i), &error);
  }
  if (ok && g_hash_table_size(driver.contexts))
    ok = fail(&error, "explicit destroy required for every context");
  if (ok) {
    gint32 delay;
    ok = pump(&driver, &delay, &error);
  }
  if (!ok) {
    JsonObject *record = json_object_new();
    json_object_set_string_member(
        record, "message", error ? error->message : "WASM adapter failed");
    emit(&driver, record, "error");
  }
  g_clear_error(&error);
  g_queue_clear_full(&driver.checkpoints, checkpoint_free);
  g_hash_table_unref(driver.contexts);
  g_hash_table_unref(driver.names);
  return ok;
}
