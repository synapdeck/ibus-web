/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#include "ops.h"

#include <errno.h>
#include <string.h>

typedef struct {
  IBusWebModule *module;
  char *name;
  IBusWebOp op;
} Entry;

static GMutex lock;
static GHashTable *entries; /* opcode → Entry; (locked by lock) */

static void entry_free(gpointer data) {
  Entry *entry = data;
  g_free(entry->name);
  g_free(entry);
}

int ibusweb_ops_add(IBusWebModule *module, uint32_t opcode, const char *name,
                    IBusWebOp op) {
  int ret = 0;

  g_mutex_lock(&lock);
  if (entries == NULL)
    entries = g_hash_table_new_full(NULL, NULL, NULL, entry_free);

  Entry *taken = g_hash_table_lookup(entries, GUINT_TO_POINTER(opcode));
  if (taken != NULL) {
    g_warning("Module %s can't register %s as opcode %" G_GUINT32_FORMAT
              ": module %s holds it for %s",
              ibusweb_module_get_name(module), name, opcode,
              ibusweb_module_get_name(taken->module), taken->name);
    ret = -EEXIST;
  } else {
    Entry *entry = g_new(Entry, 1);
    entry->module = module;
    entry->name = g_strdup(name);
    entry->op = op;
    g_hash_table_insert(entries, GUINT_TO_POINTER(opcode), entry);
  }
  g_mutex_unlock(&lock);
  return ret;
}

static gboolean entry_of_module(gpointer key, gpointer value, gpointer module) {
  (void)key;
  return ((Entry *)value)->module == module;
}

void ibusweb_ops_remove_module(IBusWebModule *module) {
  g_mutex_lock(&lock);
  if (entries != NULL)
    g_hash_table_foreach_remove(entries, entry_of_module, module);
  g_mutex_unlock(&lock);
}

int32_t ibusweb_dispatch(const uint8_t *request, uint32_t request_len,
                         uint8_t *reply, uint32_t reply_cap) {
  uint32_t opcode;
  IBusWebOp op = NULL;

  if (request_len < sizeof opcode)
    return -EINVAL;
  memcpy(&opcode, request, sizeof opcode);
  opcode = GUINT32_FROM_LE(opcode);

  g_mutex_lock(&lock);
  Entry *entry = entries == NULL
                     ? NULL
                     : g_hash_table_lookup(entries, GUINT_TO_POINTER(opcode));
  if (entry != NULL)
    op = entry->op;
  g_mutex_unlock(&lock);
  if (op == NULL)
    return -ENOSYS;

  GString *out = g_string_new(NULL);
  int32_t ret = ibusweb_ops_call(opcode, op, request + sizeof opcode,
                                 request_len - sizeof opcode, out);
  if (ret == 0) {
    if (out->len > reply_cap || out->len > G_MAXINT32) {
      ret = -ENOBUFS;
    } else {
      if (out->len > 0)
        memcpy(reply, out->str, out->len);
      ret = (int32_t)out->len;
    }
  }
  g_string_free(out, TRUE);
  return ret;
}
