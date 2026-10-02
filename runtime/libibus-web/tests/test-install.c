/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#include <dirent.h>
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <fcntl.h>
#include <glib.h>
#include <ibus-web/runtime.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Installs land on WasmFS's memory backend, mounted here; the rest of the
 * tree is the host's, where the archives are. */
#define MOUNT "/ibus-web-install-test"

static const char *archives;

static GBytes *archive(const char *name) {
  g_autofree char *path = g_build_filename(archives, name, NULL);
  g_autoptr(GError) error = NULL;
  char *data;
  gsize len;
  if (!g_file_get_contents(path, &data, &len, &error))
    g_error("%s", error->message);
  return g_bytes_new_take(data, len);
}

/* A directory of its own on the memory backend for each install. */
static char *fresh_dir(void) {
  static int next;
  char *dir = g_strdup_printf(MOUNT "/%d", next++);
  g_assert_cmpint(mkdir(dir, 0755), ==, 0);
  return dir;
}

static void list_into(const char *root, const char *rel, GPtrArray *lines) {
  g_autofree char *path =
      rel[0] == '\0' ? g_strdup(root) : g_build_filename(root, rel, NULL);
  DIR *dir = opendir(path);
  g_assert_nonnull(dir);
  struct dirent *entry;
  while ((entry = readdir(dir)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
      continue;
    g_autofree char *child_rel =
        rel[0] == '\0' ? g_strdup(entry->d_name)
                       : g_strconcat(rel, "/", entry->d_name, NULL);
    g_autofree char *child = g_build_filename(root, child_rel, NULL);
    struct stat st;
    g_assert_cmpint(lstat(child, &st), ==, 0);
    if (S_ISDIR(st.st_mode)) {
      g_ptr_array_add(lines, g_strdup_printf("%s\td", child_rel));
      list_into(root, child_rel, lines);
    } else {
      g_assert_true(S_ISREG(st.st_mode));
      g_autofree char *data = NULL;
      gsize len;
      g_assert_true(g_file_get_contents(child, &data, &len, NULL));
      g_assert_cmpuint(len, ==, (gsize)st.st_size);
      g_autofree char *sum =
          g_compute_checksum_for_data(G_CHECKSUM_SHA256, (guchar *)data, len);
      g_ptr_array_add(lines, g_strdup_printf("%s\tf %" G_GSIZE_FORMAT " %s",
                                             child_rel, len, sum));
    }
  }
  closedir(dir);
}

static int by_bytes(gconstpointer a, gconstpointer b) {
  return strcmp(*(char *const *)a, *(char *const *)b);
}

/* The tree under root in listing.txt's form. */
static char *listing(const char *root) {
  g_autoptr(GPtrArray) lines = g_ptr_array_new_with_free_func(g_free);
  list_into(root, "", lines);
  g_ptr_array_sort(lines, by_bytes);
  GString *out = g_string_new(NULL);
  for (guint i = 0; i < lines->len; i++)
    g_string_append_printf(out, "%s\n", (char *)lines->pdata[i]);
  return g_string_free(out, FALSE);
}

static void assert_tree(const char *dir) {
  g_autoptr(GBytes) expected = archive("listing.txt");
  g_autofree char *got = listing(dir);
  g_autofree char *want =
      g_strndup(g_bytes_get_data(expected, NULL), g_bytes_get_size(expected));
  g_assert_cmpstr(got, ==, want);
}

/* Feeds `len` bytes of data in pieces of `piece` bytes; returns the first
 * failure, or 0. */
static int feed(IBusWebInstall *install, const uint8_t *data, gsize len,
                gsize piece) {
  for (gsize at = 0; at < len; at += piece) {
    int ret = ibusweb_install_feed(install, data + at, MIN(piece, len - at));
    if (ret != 0)
      return ret;
  }
  return 0;
}

/* Installs the first `len` bytes of the archive into dir, fed in pieces of
 * `piece` bytes; returns the first failure, or end's result. */
static int install_part(const char *dir, GBytes *bytes, gsize len,
                        gsize piece) {
  IBusWebInstall *install = NULL;
  g_assert_cmpint(ibusweb_install_begin(dir, &install), ==, 0);
  g_assert_nonnull(install);
  int fed = feed(install, g_bytes_get_data(bytes, NULL), len, piece);
  int ended = ibusweb_install_end(install);
  return fed != 0 ? fed : ended;
}

static int install(const char *dir, GBytes *bytes, gsize piece) {
  return install_part(dir, bytes, g_bytes_get_size(bytes), piece);
}

static gboolean exists(const char *path) {
  struct stat st;
  return lstat(path, &st) == 0;
}

static void test_whole(void) {
  g_autoptr(GBytes) tree = archive("tree.tar");
  g_autofree char *dir = fresh_dir();
  g_assert_cmpint(install(dir, tree, g_bytes_get_size(tree)), ==, 0);
  assert_tree(dir);
}

/* Header and data boundaries fall anywhere within a piece. */
static void test_pieces(void) {
  g_autoptr(GBytes) tree = archive("tree.tar");
  const gsize pieces[] = {1, 7, 511, 513, 65536};
  for (gsize i = 0; i < G_N_ELEMENTS(pieces); i++) {
    g_autofree char *dir = fresh_dir();
    g_test_message("pieces of %" G_GSIZE_FORMAT " bytes", pieces[i]);
    g_assert_cmpint(install(dir, tree, pieces[i]), ==, 0);
    assert_tree(dir);
  }
}

static void write_file(const char *path, gsize len, char fill) {
  g_autofree char *data = g_malloc(len);
  memset(data, fill, len);
  g_assert_true(g_file_set_contents(path, data, len, NULL));
}

/* An install cut short, over files longer than the archive's, then a whole
 * one over that: what is left is the archive's tree and nothing else. */
static void test_over_partial(void) {
  g_autoptr(GBytes) tree = archive("tree.tar");
  g_autofree char *dir = fresh_dir();
  g_autofree char *share = g_build_filename(dir, "share", NULL);
  g_autofree char *dict = g_build_filename(share, "dict", NULL);
  g_assert_cmpint(mkdir(share, 0755), ==, 0);
  g_assert_cmpint(mkdir(dict, 0755), ==, 0);
  g_autofree char *main_dict = g_build_filename(dict, "main.dict", NULL);
  g_autofree char *readme = g_build_filename(dir, "README", NULL);
  write_file(main_dict, 700000, 'x');
  write_file(readme, 4096, 'y');

  gsize half = g_bytes_get_size(tree) / 2;
  g_assert_cmpint(install_part(dir, tree, half, 4096), ==, -EINVAL);
  g_assert_cmpint(install(dir, tree, 65536), ==, 0);
  assert_tree(dir);
}

typedef struct {
  const char *archive;
  /* What the refused member would have made, relative to the install's
   * directory. */
  const char *escape;
} Refused;

static void test_refused(gconstpointer data) {
  const Refused *refused = data;
  g_autoptr(GBytes) bytes = archive(refused->archive);
  g_autofree char *dir = fresh_dir();
  IBusWebInstall *install = NULL;
  g_assert_cmpint(ibusweb_install_begin(dir, &install), ==, 0);
  int fed = feed(install, g_bytes_get_data(bytes, NULL),
                 g_bytes_get_size(bytes), g_bytes_get_size(bytes));
  g_assert_cmpint(fed, ==, -EINVAL);
  /* A failed install stays failed. */
  g_assert_cmpint(ibusweb_install_feed(install, (const uint8_t *)"", 0), ==,
                  -EINVAL);
  g_assert_cmpint(ibusweb_install_end(install), ==, -EINVAL);

  /* The member before was taken; the refusal is the refused member's. */
  g_autofree char *ok = g_build_filename(dir, "ok.txt", NULL);
  g_autofree char *contents = NULL;
  g_assert_true(g_file_get_contents(ok, &contents, NULL, NULL));
  g_assert_cmpstr(contents, ==, "accepted\n");
  g_autofree char *escape = g_build_filename(dir, refused->escape, NULL);
  g_assert_false(exists(escape));
  g_assert_false(exists("/ibus-web-escape.txt"));
}

static void test_corrupt(void) {
  g_autoptr(GBytes) bytes = archive("corrupt.tar");
  g_autofree char *dir = fresh_dir();
  g_assert_cmpint(install(dir, bytes, 65536), ==, -EINVAL);
}

/* Without its end-of-archive blocks an archive is cut short, whether
 * mid-file, mid-header or between members. */
static void test_truncated(void) {
  g_autoptr(GBytes) tree = archive("tree.tar");
  const gsize cuts[] = {
      100,       /* mid-header */
      1024 + 10, /* in README's data */
      1536,      /* after README, before the next header */
  };
  for (gsize i = 0; i < G_N_ELEMENTS(cuts); i++) {
    g_autofree char *dir = fresh_dir();
    g_test_message("cut at %" G_GSIZE_FORMAT, cuts[i]);
    g_assert_cmpint(install_part(dir, tree, cuts[i], 512), ==, -EINVAL);
  }
}

/* GNU tar pads an archive to a whole record after its end-of-archive
 * blocks; anything there is ignored. */
static void test_after_end(void) {
  g_autoptr(GBytes) tree = archive("tree.tar");
  g_autofree char *dir = fresh_dir();
  IBusWebInstall *install = NULL;
  g_assert_cmpint(ibusweb_install_begin(dir, &install), ==, 0);
  g_assert_cmpint(feed(install, g_bytes_get_data(tree, NULL),
                       g_bytes_get_size(tree), 65536),
                  ==, 0);
  g_assert_cmpint(ibusweb_install_feed(install, (const uint8_t *)"trailing", 8),
                  ==, 0);
  g_assert_cmpint(ibusweb_install_end(install), ==, 0);
  assert_tree(dir);
}

static void test_begin_errors(void) {
  IBusWebInstall *install = NULL;
  g_assert_cmpint(ibusweb_install_begin(NULL, &install), ==, -EINVAL);
  g_autofree char *dir = fresh_dir();
  g_assert_cmpint(ibusweb_install_begin(dir, NULL), ==, -EINVAL);
  g_autofree char *missing = g_build_filename(dir, "missing", NULL);
  g_assert_cmpint(ibusweb_install_begin(missing, &install), ==, -ENOENT);
  g_autofree char *file = g_build_filename(dir, "file", NULL);
  write_file(file, 1, 'z');
  g_assert_cmpint(ibusweb_install_begin(file, &install), ==, -ENOTDIR);
  g_assert_null(install);
}

int main(int argc, char **argv) {
  g_test_init(&argc, &argv, NULL);
  archives = g_getenv("IBUSWEB_TEST_ARCHIVES");
  if (archives == NULL)
    g_error("IBUSWEB_TEST_ARCHIVES names no directory of archives");
  backend_t memory = wasmfs_create_memory_backend();
  g_assert_cmpint(wasmfs_create_directory(MOUNT, 0777, memory), ==, 0);

  static const Refused refused[] = {
      /* Nor stripped of its leading slash, as GNU tar would. */
      {"absolute.tar", "ibus-web-escape.txt"},
      {"dotdot.tar", "../ibus-web-escape.txt"},
      {"symlink.tar", "link"},
      {"hardlink.tar", "hard"},
      {"fifo.tar", "fifo"},
  };
  g_test_add_func("/install/whole", test_whole);
  g_test_add_func("/install/pieces", test_pieces);
  g_test_add_func("/install/over-partial", test_over_partial);
  for (gsize i = 0; i < G_N_ELEMENTS(refused); i++) {
    g_autofree char *path =
        g_strdup_printf("/install/refused/%s", refused[i].archive);
    g_test_add_data_func(path, &refused[i], test_refused);
  }
  g_test_add_func("/install/corrupt", test_corrupt);
  g_test_add_func("/install/truncated", test_truncated);
  g_test_add_func("/install/after-end", test_after_end);
  g_test_add_func("/install/begin-errors", test_begin_errors);
  return g_test_run();
}
