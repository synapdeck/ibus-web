/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include "spike.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

static int file_line(const char *path, const char *rel, GPtrArray *lines) {
  int fd = open(path, O_RDONLY);
  if (fd < 0)
    return -errno;
  GChecksum *sum = g_checksum_new(G_CHECKSUM_SHA256);
  uint8_t buf[65536];
  size_t size = 0;
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf)) > 0) {
    g_checksum_update(sum, buf, n);
    size += (size_t)n;
  }
  int ret = n < 0 ? -errno : 0;
  close(fd);
  if (ret == 0)
    g_ptr_array_add(lines, g_strdup_printf("%s\tf %zu %s", rel, size,
                                           g_checksum_get_string(sum)));
  g_checksum_free(sum);
  return ret;
}

static int list_into(const char *root, const char *rel, GPtrArray *lines) {
  g_autofree char *path =
      rel[0] == '\0' ? g_strdup(root) : g_build_filename(root, rel, NULL);
  DIR *dir = opendir(path);
  if (dir == NULL)
    return -errno;
  int ret = 0;
  struct dirent *entry;
  while (ret == 0 && (entry = readdir(dir)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
      continue;
    g_autofree char *child_rel =
        rel[0] == '\0' ? g_strdup(entry->d_name)
                       : g_strconcat(rel, "/", entry->d_name, NULL);
    g_autofree char *child = g_build_filename(root, child_rel, NULL);
    struct stat st;
    if (lstat(child, &st) != 0)
      ret = -errno;
    else if (S_ISDIR(st.st_mode)) {
      g_ptr_array_add(lines, g_strdup_printf("%s\td", child_rel));
      ret = list_into(root, child_rel, lines);
    } else if (S_ISREG(st.st_mode))
      ret = file_line(child, child_rel, lines);
    else
      g_ptr_array_add(lines, g_strdup_printf("%s\t?", child_rel));
  }
  closedir(dir);
  return ret;
}

static int by_bytes(gconstpointer a, gconstpointer b) {
  return strcmp(*(char *const *)a, *(char *const *)b);
}

/* list-tree(path): every file and directory under path, one line each,
 * `PATH<TAB>d` or `PATH<TAB>f SIZE SHA256` with PATH relative to path,
 * sorted bytewise. Replies 0 then the lines, or only the error. */
static void list_tree(const uint8_t *payload, uint32_t len, GString *reply) {
  if (len == 0 || memchr(payload, '\0', len) != NULL)
    return;
  g_autofree char *root = g_strndup((const char *)payload, len);
  g_autoptr(GPtrArray) lines = g_ptr_array_new_with_free_func(g_free);
  int ret = list_into(root, "", lines);
  spike_reply(reply, ret);
  if (ret != 0)
    return;
  g_ptr_array_sort(lines, by_bytes);
  for (guint i = 0; i < lines->len; i++) {
    g_string_append(reply, lines->pdata[i]);
    g_string_append_c(reply, '\n');
  }
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, SPIKE_OP_LIST_TREE, "list-tree", list_tree);
}
