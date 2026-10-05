/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#include <dirent.h>
#include <emscripten/heap.h>
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <fcntl.h>
#include <glib.h>
#include <ibus-web/runtime.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Installs land on WasmFS's memory backend, mounted here; the rest of the
 * tree is the host's, where the archives are. */
#define MOUNT "/ibus-web-install-test"

#define BLOCK 512

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

/* The count is of the files in the listing and their sizes. */
static void test_count(void) {
  g_autoptr(GBytes) tree = archive("tree.tar");
  g_autoptr(GBytes) expected = archive("listing.txt");
  g_autofree char *text =
      g_strndup(g_bytes_get_data(expected, NULL), g_bytes_get_size(expected));
  g_auto(GStrv) lines = g_strsplit(text, "\n", -1);
  uint32_t want_files = 0;
  uint64_t want_bytes = 0;
  for (char **line = lines; *line != NULL; line++) {
    const char *kind = strchr(*line, '\t');
    if (kind != NULL && kind[1] == 'f') {
      want_files++;
      want_bytes += g_ascii_strtoull(kind + 3, NULL, 10);
    }
  }
  g_autofree char *dir = fresh_dir();
  IBusWebInstall *install = NULL;
  g_assert_cmpint(ibusweb_install_begin(dir, &install), ==, 0);
  uint32_t files = 1;
  uint64_t bytes = 1;
  ibusweb_install_count(install, &files, &bytes);
  g_assert_cmpuint(files, ==, 0);
  g_assert_cmpuint(bytes, ==, 0);
  g_assert_cmpint(
      feed(install, g_bytes_get_data(tree, NULL), g_bytes_get_size(tree), 4096),
      ==, 0);
  ibusweb_install_count(install, &files, &bytes);
  g_assert_cmpuint(files, ==, want_files);
  g_assert_cmpuint(bytes, ==, want_bytes);
  g_assert_cmpint(ibusweb_install_end(install), ==, 0);
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
 * one over that: every file the archive has is the archive's, truncated and
 * rewritten. Files the archive lacks would stay, since an install never
 * deletes; this tree has none. */
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
  int error;
} Refused;

static void test_refused(gconstpointer data) {
  const Refused *refused = data;
  g_autoptr(GBytes) bytes = archive(refused->archive);
  g_autofree char *dir = fresh_dir();
  IBusWebInstall *install = NULL;
  g_assert_cmpint(ibusweb_install_begin(dir, &install), ==, 0);
  int fed = feed(install, g_bytes_get_data(bytes, NULL),
                 g_bytes_get_size(bytes), g_bytes_get_size(bytes));
  g_assert_cmpint(fed, ==, refused->error);
  /* A failed install stays failed. */
  g_assert_cmpint(ibusweb_install_feed(install, (const uint8_t *)"", 0), ==,
                  refused->error);
  g_assert_cmpint(ibusweb_install_end(install), ==, refused->error);

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

static gsize padded(gsize size) { return (size + BLOCK - 1) / BLOCK * BLOCK; }

/* The octal number in a header field. */
static guint64 field_number(const uint8_t *header, gsize offset, gsize len) {
  g_autofree char *field = g_strndup((const char *)header + offset, len);
  return g_ascii_strtoull(field, NULL, 8);
}

/* The offset of the archive's first regular file with two bytes or more,
 * and its size. */
static gsize first_file(GBytes *tar, gsize *size) {
  gsize len;
  const uint8_t *data = g_bytes_get_data(tar, &len);
  for (gsize at = 0; at + BLOCK <= len;) {
    const uint8_t *header = data + at;
    g_assert_cmpuint(header[0], !=, 0);
    guint64 member_size = field_number(header, 124, 12);
    if ((header[156] == '0' || header[156] == '\0') && member_size >= 2) {
      *size = member_size;
      return at;
    }
    at += BLOCK + padded(member_size);
  }
  g_assert_not_reached();
}

/* Without its end-of-archive blocks an archive is cut short, whether
 * mid-file, mid-header or between members. */
static void test_truncated(void) {
  g_autoptr(GBytes) tree = archive("tree.tar");
  gsize size;
  gsize file = first_file(tree, &size);
  const gsize cuts[] = {
      file + 100,                  /* mid-header */
      file + BLOCK + size / 2,     /* in the file's data */
      file + BLOCK + padded(size), /* before the next header */
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

/* A member of an archive the test makes itself. */
typedef struct {
  const char *prefix;
  const char *name;
  char type;
  guint mode;
  const char *data;
  const char *linkname;
  /* The size field's 12 bytes as given, rather than the data's length. */
  const uint8_t *size_field;
  /* Checksummed as some old writers do, summing the bytes as signed, with
   * bytes that sum differently either way in the owner's name. */
  gboolean signed_sum;
} Member;

/* Copies at most len bytes of text, leaving out its NUL when it fills the
 * field. */
static void put_text(uint8_t *header, gsize offset, gsize len,
                     const char *text) {
  memcpy(header + offset, text, MIN(strlen(text), len));
}

static void add_member(GByteArray *tar, const Member *member) {
  uint8_t header[BLOCK] = {0};
  gsize len = member->data == NULL ? 0 : strlen(member->data);
  put_text(header, 0, 100, member->name);
  g_snprintf((char *)header + 100, 8, "%07o", member->mode);
  put_text(header, 108, 8, "0000000");
  put_text(header, 116, 8, "0000000");
  if (member->size_field != NULL)
    memcpy(header + 124, member->size_field, 12);
  else
    g_snprintf((char *)header + 124, 12, "%011" G_GSIZE_MODIFIER "o", len);
  put_text(header, 136, 12, "00000000000");
  header[156] = (uint8_t)member->type;
  if (member->linkname != NULL)
    put_text(header, 157, 100, member->linkname);
  memcpy(header + 257, "ustar", 6);
  memcpy(header + 263, "00", 2);
  if (member->signed_sum)
    memset(header + 265, 0xff, 16);
  if (member->prefix != NULL)
    put_text(header, 345, 155, member->prefix);
  memset(header + 148, ' ', 8);
  gint64 sum = 0;
  for (gsize i = 0; i < BLOCK; i++)
    sum += member->signed_sum ? (gint64)(int8_t)header[i] : header[i];
  g_snprintf((char *)header + 148, 7, "%06" G_GINT64_MODIFIER "o", sum);
  g_byte_array_append(tar, header, BLOCK);
  if (len > 0) {
    static const uint8_t zeros[BLOCK];
    g_byte_array_append(tar, (const uint8_t *)member->data, (guint)len);
    g_byte_array_append(tar, zeros, (guint)(padded(len) - len));
  }
}

static void add_end(GByteArray *tar) {
  static const uint8_t zeros[2 * BLOCK];
  g_byte_array_append(tar, zeros, sizeof zeros);
}

/* The members, then the end-of-archive blocks. */
static GBytes *make_archive(const Member *members, gsize n) {
  GByteArray *tar = g_byte_array_new();
  for (gsize i = 0; i < n; i++)
    add_member(tar, &members[i]);
  add_end(tar);
  return g_byte_array_free_to_bytes(tar);
}

static char *read_file(const char *dir, const char *rel) {
  g_autofree char *path = g_build_filename(dir, rel, NULL);
  char *contents = NULL;
  g_assert_true(g_file_get_contents(path, &contents, NULL, NULL));
  return contents;
}

/* Reject at the header, before even creating the oversized member. */
static void test_size_limit(void) {
  const Member members[] = {
      {.name = "ok", .type = '0', .mode = 0644, .data = "abc"},
      {.name = "too-large/file",
       .type = '0',
       .mode = 0644,
       .size_field = (const uint8_t *)"77777777777"},
  };
  g_autoptr(GByteArray) tar = g_byte_array_new();
  add_member(tar, &members[0]);
  add_member(tar, &members[1]);
  for (uint64_t limit = 0; limit <= 3; limit += 3) {
    g_autofree char *dir = fresh_dir();
    IBusWebInstall *install = NULL;
    g_assert_cmpint(ibusweb_install_begin(dir, &install), ==, 0);
    g_assert_cmpint(ibusweb_install_set_limit(install, limit), ==, 0);
    g_assert_cmpint(feed(install, tar->data, tar->len, 7), ==, -EFBIG);
    uint32_t files;
    uint64_t bytes;
    ibusweb_install_count(install, &files, &bytes);
    g_assert_cmpuint(files, ==, limit == 0 ? 0 : 1);
    g_assert_cmpuint(bytes, ==, limit);
    g_assert_cmpint(ibusweb_install_end(install), ==, -EFBIG);
    g_autofree char *large = g_build_filename(dir, "too-large", NULL);
    g_assert_false(exists(large));
  }
}

static void test_limit_exact_and_zero(void) {
  for (uint64_t size = 0; size <= 3; size += 3) {
    g_autoptr(GByteArray) tar = g_byte_array_new();
    const Member member = {.name = "file",
                           .type = '0',
                           .mode = 0644,
                           .data = size == 0 ? "" : "abc"};
    add_member(tar, &member);
    static const uint8_t end[2 * BLOCK];
    g_byte_array_append(tar, end, sizeof(end));
    g_autofree char *dir = fresh_dir();
    IBusWebInstall *install = NULL;
    g_assert_cmpint(ibusweb_install_begin(dir, &install), ==, 0);
    g_assert_cmpint(ibusweb_install_set_limit(install, size), ==, 0);
    g_assert_cmpint(feed(install, tar->data, tar->len, 1), ==, 0);
    g_assert_cmpint(ibusweb_install_set_limit(install, size), ==, -EINVAL);
    g_assert_cmpint(ibusweb_install_end(install), ==, 0);
  }
}

/* A size field that checksums but isn't octal, or is GNU's base-256, fails
 * the install before its member is made. */
static void test_size_fields(void) {
  static const uint8_t not_octal[12] = "0000000001a";
  static const uint8_t base256[12] = {0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5};
  const uint8_t *fields[] = {not_octal, base256};
  for (gsize i = 0; i < G_N_ELEMENTS(fields); i++) {
    const Member member = {.name = "sized",
                           .type = '0',
                           .mode = 0644,
                           .data = "12345",
                           .size_field = fields[i]};
    g_autoptr(GBytes) tar = make_archive(&member, 1);
    g_autofree char *dir = fresh_dir();
    g_assert_cmpint(install(dir, tar, 512), ==, -EINVAL);
    g_autofree char *path = g_build_filename(dir, "sized", NULL);
    g_assert_false(exists(path));
  }
}

/* A name of a whole 100 bytes and a prefix of a whole 155 have no NUL;
 * neither runs into the field after it. */
static void test_full_fields(void) {
  g_autofree char *name = g_strnfill(100, 'n');
  g_autofree char *prefix = g_strnfill(155, 'p');
  const Member members[] = {
      {.name = name, .type = '0', .mode = 0644, .data = "name\n"},
      {.prefix = prefix,
       .name = "f.txt",
       .type = '0',
       .mode = 0644,
       .data = "prefix\n"},
  };
  g_autoptr(GBytes) tar = make_archive(members, G_N_ELEMENTS(members));
  g_autofree char *dir = fresh_dir();
  g_assert_cmpint(install(dir, tar, 65536), ==, 0);
  g_autofree char *named = read_file(dir, name);
  g_assert_cmpstr(named, ==, "name\n");
  g_autofree char *rel = g_strconcat(prefix, "/f.txt", NULL);
  g_autofree char *prefixed = read_file(dir, rel);
  g_assert_cmpstr(prefixed, ==, "prefix\n");
}

static void test_lone_zero_block(void) {
  const Member member = {.name = "a", .type = '0', .mode = 0644, .data = "a"};
  GByteArray *tar = g_byte_array_new();
  add_member(tar, &member);
  static const uint8_t zeros[BLOCK];
  g_byte_array_append(tar, zeros, BLOCK);
  const Member after = {.name = "b", .type = '0', .mode = 0644, .data = "b"};
  add_member(tar, &after);
  add_end(tar);
  g_autoptr(GBytes) bytes = g_byte_array_free_to_bytes(tar);
  g_autofree char *dir = fresh_dir();
  g_assert_cmpint(install(dir, bytes, 65536), ==, -EINVAL);
  g_autofree char *b = g_build_filename(dir, "b", NULL);
  g_assert_false(exists(b));
}

static void test_signed_checksum(void) {
  const Member member = {.name = "signed",
                         .type = '0',
                         .mode = 0644,
                         .data = "signed\n",
                         .signed_sum = TRUE};
  g_autoptr(GBytes) tar = make_archive(&member, 1);
  g_autofree char *dir = fresh_dir();
  g_assert_cmpint(install(dir, tar, 65536), ==, 0);
  g_autofree char *contents = read_file(dir, "signed");
  g_assert_cmpstr(contents, ==, "signed\n");
}

static void test_directory_size(void) {
  static const uint8_t one[12] = "00000000001";
  const Member member = {
      .name = "dir/", .type = '5', .mode = 0755, .size_field = one};
  g_autoptr(GBytes) tar = make_archive(&member, 1);
  g_autofree char *dir = fresh_dir();
  g_assert_cmpint(install(dir, tar, 65536), ==, -EINVAL);
}

static char *link_target(const char *dir, const char *rel) {
  g_autofree char *path = g_build_filename(dir, rel, NULL);
  char buf[256];
  ssize_t len = readlink(path, buf, sizeof buf);
  g_assert_cmpint(len, >, 0);
  g_assert_cmpint(len, <, (ssize_t)sizeof buf);
  return g_strndup(buf, (gsize)len);
}

/* A symbolic link is made with its target as the archive has it, relative
 * or absolute, and reads through to it; it counts as no file and no
 * bytes. */
static void test_symlinks(void) {
  g_autofree char *dir = fresh_dir();
  g_autofree char *absolute = g_build_filename(dir, "base/data.txt", NULL);
  const Member members[] = {
      {.name = "base/", .type = '5', .mode = 0755},
      {.name = "base/data.txt", .type = '0', .mode = 0444, .data = "data\n"},
      {.name = "base/relative",
       .type = '2',
       .mode = 0777,
       .linkname = "data.txt"},
      {.name = "base/absolute",
       .type = '2',
       .mode = 0777,
       .linkname = absolute},
      /* Its parents are missing, as for a file. */
      {.name = "base/sub/deep",
       .type = '2',
       .mode = 0777,
       .linkname = "../data.txt"},
      {.name = "base/dir-link", .type = '2', .mode = 0777, .linkname = "sub"},
  };
  g_autoptr(GBytes) tar = make_archive(members, G_N_ELEMENTS(members));
  IBusWebInstall *install = NULL;
  g_assert_cmpint(ibusweb_install_begin(dir, &install), ==, 0);
  g_assert_cmpint(
      feed(install, g_bytes_get_data(tar, NULL), g_bytes_get_size(tar), 7), ==,
      0);
  uint32_t files;
  uint64_t bytes;
  ibusweb_install_count(install, &files, &bytes);
  g_assert_cmpuint(files, ==, 1);
  g_assert_cmpuint(bytes, ==, 5);
  g_assert_cmpint(ibusweb_install_end(install), ==, 0);

  g_autofree char *relative_target = link_target(dir, "base/relative");
  g_assert_cmpstr(relative_target, ==, "data.txt");
  g_autofree char *absolute_target = link_target(dir, "base/absolute");
  g_assert_cmpstr(absolute_target, ==, absolute);
  g_autofree char *deep_target = link_target(dir, "base/sub/deep");
  g_assert_cmpstr(deep_target, ==, "../data.txt");
  const char *through[] = {"base/relative", "base/absolute", "base/sub/deep",
                           "base/dir-link/deep"};
  for (gsize i = 0; i < G_N_ELEMENTS(through); i++) {
    g_autofree char *contents = read_file(dir, through[i]);
    g_assert_cmpstr(contents, ==, "data\n");
  }
}

/* The make-tree archive's link to "/" is a link like any other: its target
 * is never resolved while installing. */
static void test_symlink_archive(void) {
  g_autoptr(GBytes) bytes = archive("symlink.tar");
  g_autofree char *dir = fresh_dir();
  g_assert_cmpint(install(dir, bytes, 65536), ==, 0);
  g_autofree char *target = link_target(dir, "link");
  g_assert_cmpstr(target, ==, "/");
}

/* A link's name is held to a file's rules, it has no data, and it names
 * something. */
static void test_symlink_refused(void) {
  static const uint8_t one[12] = "00000000001";
  const Member bad[] = {
      {.name = "/ibus-web-escape", .type = '2', .linkname = "x"},
      {.name = "sub/../../ibus-web-escape", .type = '2', .linkname = "x"},
      {.name = "./", .type = '2', .linkname = "x"},
      {.name = "sized", .type = '2', .linkname = "x", .size_field = one},
      {.name = "empty", .type = '2', .linkname = ""},
  };
  for (gsize i = 0; i < G_N_ELEMENTS(bad); i++) {
    g_test_message("link named %s", bad[i].name);
    g_autoptr(GBytes) tar = make_archive(&bad[i], 1);
    g_autofree char *dir = fresh_dir();
    g_assert_cmpint(install(dir, tar, 65536), ==, -EINVAL);
    g_autofree char *parent = g_path_get_dirname(dir);
    g_autofree char *escape = g_build_filename(parent, "ibus-web-escape", NULL);
    g_assert_false(exists(escape));
    g_assert_false(exists("/ibus-web-escape"));
  }
}

/* A hard link names another member, which a store path's archive never
 * needs: tar stores each of its names whole. It fails before anything is
 * made of it. */
static void test_hardlink_refused(void) {
  const Member members[] = {
      {.name = "a", .type = '0', .mode = 0644, .data = "a\n"},
      {.name = "b", .type = '1', .mode = 0644, .linkname = "a"},
  };
  g_autoptr(GBytes) tar = make_archive(members, G_N_ELEMENTS(members));
  g_autofree char *dir = fresh_dir();
  g_assert_cmpint(install(dir, tar, 65536), ==, -EOPNOTSUPP);
  g_autofree char *b = g_build_filename(dir, "b", NULL);
  g_assert_false(exists(b));
}

/* Nothing is written through a link the archive made: a member under a
 * link fails, and a member at a link replaces the link itself. */
static void test_symlink_not_followed(void) {
  g_autofree char *dir = fresh_dir();
  g_autofree char *elsewhere = fresh_dir();
  g_autofree char *target = g_build_filename(elsewhere, "target", NULL);
  write_file(target, 3, 't');
  const char *under[] = {"out/escaped.txt", "out/sub/"};
  for (gsize i = 0; i < G_N_ELEMENTS(under); i++) {
    g_autofree char *into = fresh_dir();
    const gboolean is_dir = g_str_has_suffix(under[i], "/");
    const Member members[] = {
        {.name = "out", .type = '2', .linkname = elsewhere},
        {.name = under[i],
         .type = is_dir ? '5' : '0',
         .mode = 0644,
         .data = is_dir ? NULL : "escaped\n"},
    };
    g_autoptr(GBytes) tar = make_archive(members, G_N_ELEMENTS(members));
    g_test_message("member %s", under[i]);
    g_assert_cmpint(install(into, tar, 65536), ==, -ENOTDIR);
  }
  g_autofree char *escaped = g_build_filename(elsewhere, "escaped.txt", NULL);
  g_autofree char *sub = g_build_filename(elsewhere, "sub", NULL);
  g_assert_false(exists(escaped));
  g_assert_false(exists(sub));

  const Member replaced[] = {
      {.name = "file", .type = '2', .linkname = target},
      {.name = "file", .type = '0', .mode = 0644, .data = "file\n"},
      {.name = "link", .type = '0', .mode = 0644, .data = "link\n"},
      {.name = "link", .type = '2', .linkname = target},
  };
  g_autoptr(GBytes) tar = make_archive(replaced, G_N_ELEMENTS(replaced));
  g_assert_cmpint(install(dir, tar, 65536), ==, 0);
  g_autofree char *file = read_file(dir, "file");
  g_assert_cmpstr(file, ==, "file\n");
  g_autofree char *link = link_target(dir, "link");
  g_assert_cmpstr(link, ==, target);
  g_autofree char *untouched = read_file(elsewhere, "target");
  g_assert_cmpstr(untouched, ==, "ttt");
}

/* A link where the tree has a directory fails rather than replace it. */
static void test_symlink_over_directory(void) {
  const Member members[] = {
      {.name = "dir/", .type = '5', .mode = 0755},
      {.name = "dir", .type = '2', .linkname = "elsewhere"},
  };
  g_autoptr(GBytes) tar = make_archive(members, G_N_ELEMENTS(members));
  g_autofree char *dir = fresh_dir();
  g_assert_cmpint(install(dir, tar, 65536), ==, -EISDIR);
  g_autofree char *path = g_build_filename(dir, "dir", NULL);
  struct stat st;
  g_assert_cmpint(lstat(path, &st), ==, 0);
  g_assert_true(S_ISDIR(st.st_mode));
}

static guint mode_of(const char *dir, const char *rel) {
  g_autofree char *path = g_build_filename(dir, rel, NULL);
  struct stat st;
  g_assert_cmpint(lstat(path, &st), ==, 0);
  return st.st_mode & 07777;
}

/* Entries take the archive's mode plus the owner's read and write (and
 * search, for a directory), whether new or there already. */
static void test_modes(void) {
  g_autofree char *dir = fresh_dir();
  g_autofree char *old_dir = g_build_filename(dir, "old", NULL);
  g_assert_cmpint(mkdir(old_dir, 0700), ==, 0);
  g_assert_cmpint(chmod(old_dir, 0700), ==, 0);
  g_autofree char *old_file = g_build_filename(old_dir, "file", NULL);
  write_file(old_file, 10, 'o');
  g_assert_cmpint(chmod(old_file, 0666), ==, 0);
  const Member members[] = {
      {.name = "old/", .type = '5', .mode = 0751},
      {.name = "old/file", .type = '0', .mode = 0640, .data = "old\n"},
      {.name = "new/", .type = '5', .mode = 0555},
      {.name = "new/file", .type = '0', .mode = 0444, .data = "new\n"},
  };
  g_autoptr(GBytes) tar = make_archive(members, G_N_ELEMENTS(members));
  g_assert_cmpint(install(dir, tar, 65536), ==, 0);
  g_assert_cmpuint(mode_of(dir, "old"), ==, 0751);
  g_assert_cmpuint(mode_of(dir, "old/file"), ==, 0640);
  g_assert_cmpuint(mode_of(dir, "new"), ==, 0755);
  g_assert_cmpuint(mode_of(dir, "new/file"), ==, 0644);
}

/* Feeding no data with a length is the caller's mistake, and fails the
 * install like any other. */
static void test_null_feed(void) {
  g_autofree char *dir = fresh_dir();
  IBusWebInstall *install = NULL;
  g_assert_cmpint(ibusweb_install_begin(dir, &install), ==, 0);
  g_assert_cmpint(ibusweb_install_feed(install, NULL, 1), ==, -EINVAL);
  g_assert_cmpint(ibusweb_install_feed(install, (const uint8_t *)"", 0), ==,
                  -EINVAL);
  g_assert_cmpint(ibusweb_install_end(install), ==, -EINVAL);
}

/* A host that mounts the engine's data in memory adds the data's size, in
 * whole pages, to the runtime's memory, so a large file has to fit in about
 * its own size: grown piece by piece, the memory backend's buffer would
 * reach twice the file, and need the old buffer beside the new while it
 * moves. The test first takes the rest of the memory, in blocks small
 * enough to come from the top of the heap, leaving the file's pages and
 * HEADROOM, which stands for what the runtime's own memory has spare. */
#define LARGE_FILE (16 * 1024 * 1024 + 1)
#define WASM_PAGE 65536
#define HEADROOM (1024 * 1024)
#define FILL_BLOCK 65536

static uint8_t large_byte(gsize at) { return (uint8_t)(at % 251 + 1); }

static void test_large_file(void) {
  /* No zero bytes, so neither strlen() nor an unwritten stretch, which
   * reads as zeros, can pass for the data. */
  char *data = g_malloc(LARGE_FILE + 1);
  for (gsize i = 0; i < LARGE_FILE; i++)
    data[i] = (char)large_byte(i);
  data[LARGE_FILE] = '\0';
  const Member member = {
      .name = "large.bin", .type = '0', .mode = 0644, .data = data};
  g_autoptr(GBytes) tar = make_archive(&member, 1);
  g_free(data);
  g_autofree char *dir = fresh_dir();

  gsize budget =
      (LARGE_FILE + WASM_PAGE - 1) / WASM_PAGE * WASM_PAGE + HEADROOM;
  size_t heap = emscripten_get_heap_size();
  /* A heap that can grow would make room for whatever the install needs,
   * and the test would pass whatever that is. Asking it to grow would abort
   * rather than fail, with malloc aborting on a fixed memory as it does
   * here; the most it can reach is the same evidence. */
  g_assert_cmpuint(emscripten_get_heap_max(), ==, heap);
  g_assert_cmpuint(heap - *emscripten_get_sbrk_ptr(), >, budget);
  g_autoptr(GPtrArray) rest = g_ptr_array_new_with_free_func(free);
  while (heap - *emscripten_get_sbrk_ptr() > budget) {
    void *block = malloc(FILL_BLOCK);
    g_assert_nonnull(block);
    g_ptr_array_add(rest, block);
  }
  int installed = install(dir, tar, 65536);
  g_ptr_array_set_size(rest, 0);
  g_assert_cmpint(installed, ==, 0);

  g_autofree char *path = g_build_filename(dir, "large.bin", NULL);
  int fd = open(path, O_RDONLY);
  g_assert_cmpint(fd, >=, 0);
  static uint8_t buf[65536];
  gsize at = 0;
  for (;;) {
    ssize_t got = read(fd, buf, sizeof buf);
    g_assert_cmpint(got, >=, 0);
    if (got == 0)
      break;
    for (ssize_t i = 0; i < got; i++)
      if (buf[i] != large_byte(at + (gsize)i))
        g_error("large.bin differs at byte %" G_GSIZE_FORMAT, at + (gsize)i);
    at += (gsize)got;
  }
  close(fd);
  g_assert_cmpuint(at, ==, LARGE_FILE);
  g_assert_cmpint(unlink(path), ==, 0);
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
      {"absolute.tar", "ibus-web-escape.txt", -EINVAL},
      {"dotdot.tar", "../ibus-web-escape.txt", -EINVAL},
      {"hardlink.tar", "hard", -EOPNOTSUPP},
      {"fifo.tar", "fifo", -EINVAL},
  };
  g_test_add_func("/install/size-limit", test_size_limit);
  g_test_add_func("/install/limit-exact-and-zero", test_limit_exact_and_zero);
  g_test_add_func("/install/whole", test_whole);
  g_test_add_func("/install/count", test_count);
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
  g_test_add_func("/install/size-fields", test_size_fields);
  g_test_add_func("/install/full-fields", test_full_fields);
  g_test_add_func("/install/lone-zero-block", test_lone_zero_block);
  g_test_add_func("/install/signed-checksum", test_signed_checksum);
  g_test_add_func("/install/directory-size", test_directory_size);
  g_test_add_func("/install/modes", test_modes);
  g_test_add_func("/install/symlinks", test_symlinks);
  g_test_add_func("/install/symlink-archive", test_symlink_archive);
  g_test_add_func("/install/symlink-refused", test_symlink_refused);
  g_test_add_func("/install/hardlink-refused", test_hardlink_refused);
  g_test_add_func("/install/symlink-not-followed", test_symlink_not_followed);
  g_test_add_func("/install/symlink-over-directory",
                  test_symlink_over_directory);
  g_test_add_func("/install/null-feed", test_null_feed);
  g_test_add_func("/install/begin-errors", test_begin_errors);
  g_test_add_func("/install/large-file", test_large_file);
  return g_test_run();
}
