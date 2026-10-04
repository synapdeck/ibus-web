/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#include <errno.h>
#include <fcntl.h>
#include <ibus-web/runtime.h>
#include <stddef.h>
#include <string.h>
#include <sys/stat.h>
#include <tar.h>
#include <unistd.h>

/* tar.h defines the field values, but not the POSIX ustar block layout. */
enum { USTAR_BLOCK_SIZE = 512 };

typedef struct {
  char name[100];
  char mode[8];
  char uid[8];
  char gid[8];
  char size[12];
  char mtime[12];
  char checksum[8];
  char typeflag[1];
  char linkname[100];
  char magic[TMAGLEN];
  char version[TVERSLEN];
  char uname[32];
  char gname[32];
  char devmajor[8];
  char devminor[8];
  char prefix[155];
  char padding[12];
} UstarHeader;

/* Parse the byte buffer directly; no struct alignment or aliasing is assumed.
 */
#define USTAR_OFFSET(field) offsetof(UstarHeader, field)
#define USTAR_LENGTH(field) sizeof(((UstarHeader *)0)->field)
#define USTAR_FIELD(field) USTAR_OFFSET(field), USTAR_LENGTH(field)

_Static_assert(sizeof(UstarHeader) == USTAR_BLOCK_SIZE,
               "ustar header must occupy one block");
_Static_assert(USTAR_OFFSET(name) == 0, "ustar name offset");
_Static_assert(USTAR_OFFSET(mode) == 100, "ustar mode offset");
_Static_assert(USTAR_OFFSET(size) == 124, "ustar size offset");
_Static_assert(USTAR_OFFSET(checksum) == 148, "ustar checksum offset");
_Static_assert(USTAR_OFFSET(typeflag) == 156, "ustar type offset");
_Static_assert(USTAR_OFFSET(magic) == 257, "ustar magic offset");
_Static_assert(USTAR_OFFSET(version) == 263, "ustar version offset");
_Static_assert(USTAR_OFFSET(prefix) == 345, "ustar prefix offset");

typedef enum {
  /* Collecting the next header. */
  STATE_HEADER,
  /* Writing a file's bytes, then skipping its padding to a whole block. */
  STATE_DATA,
  STATE_PADDING,
  /* Past the end-of-archive blocks. */
  STATE_END,
  STATE_FAILED,
} State;

struct _IBusWebInstall {
  char *dir;
  State state;
  int error;
  uint8_t header[USTAR_BLOCK_SIZE];
  uint32_t header_fill;
  /* All-zero blocks in a row: two end the archive. */
  int zero_blocks;
  /* The file being written, or -1. */
  int fd;
  uint64_t data_left;
  uint32_t padding_left;
  /* Regular files written whole, and the bytes written. */
  uint32_t files;
  uint64_t bytes;
};

static int fail(IBusWebInstall *install, int error) {
  if (install->fd >= 0) {
    close(install->fd);
    install->fd = -1;
  }
  install->state = STATE_FAILED;
  install->error = error;
  return error;
}

/* A field of octal digits, NUL- or space-terminated, maybe space-padded
 * before; FALSE for anything else, GNU's base-256 numbers among them. */
static gboolean octal(const uint8_t *header, size_t offset, size_t len,
                      uint64_t *value) {
  const uint8_t *field = header + offset;
  size_t i = 0;
  while (i < len && field[i] == ' ')
    i++;
  uint64_t result = 0;
  size_t digits = 0;
  for (; i < len && field[i] >= '0' && field[i] <= '7'; i++, digits++) {
    if (result > (UINT64_MAX >> 3))
      return FALSE;
    result = (result << 3) | (uint64_t)(field[i] - '0');
  }
  for (; i < len; i++)
    if (field[i] != ' ' && field[i] != '\0')
      return FALSE;
  *value = result;
  return digits > 0;
}

/* The checksum is of the header with its own field read as spaces, summed
 * as unsigned bytes or, by some old writers, as signed ones. */
static gboolean checksum_matches(const uint8_t *header) {
  uint64_t stored;
  if (!octal(header, USTAR_FIELD(checksum), &stored))
    return FALSE;
  uint64_t sum_unsigned = 0;
  int64_t sum_signed = 0;
  for (size_t i = 0; i < USTAR_BLOCK_SIZE; i++) {
    gboolean in_field = i >= USTAR_OFFSET(checksum) &&
                        i < USTAR_OFFSET(checksum) + USTAR_LENGTH(checksum);
    uint8_t byte = in_field ? ' ' : header[i];
    sum_unsigned += byte;
    sum_signed += (int8_t)byte;
  }
  return stored == sum_unsigned || (int64_t)stored == sum_signed;
}

static gboolean field_is(const uint8_t *header, size_t offset, size_t len,
                         const char *value) {
  return memcmp(header + offset, value, len) == 0;
}

static gboolean all_zero(const uint8_t *block) {
  for (size_t i = 0; i < USTAR_BLOCK_SIZE; i++)
    if (block[i] != 0)
      return FALSE;
  return TRUE;
}

/* A field that need not be NUL-terminated when full. */
static GString *append_field(GString *out, const uint8_t *header, size_t offset,
                             size_t len) {
  const char *field = (const char *)header + offset;
  const char *nul = memchr(field, '\0', len);
  return g_string_append_len(out, field,
                             nul == NULL ? (gssize)len : nul - field);
}

/* The member's name relative to the install's directory, with "." and
 * empty components dropped, or NULL if it is absolute or has "..". An empty
 * result names the directory itself. */
static char *relative_name(const uint8_t *header) {
  g_autoptr(GString) full = g_string_new(NULL);
  if (header[USTAR_OFFSET(prefix)] != '\0') {
    append_field(full, header, USTAR_FIELD(prefix));
    g_string_append_c(full, '/');
  }
  append_field(full, header, USTAR_FIELD(name));
  if (full->len == 0 || full->str[0] == '/')
    return NULL;
  g_auto(GStrv) parts = g_strsplit(full->str, "/", -1);
  GString *out = g_string_new(NULL);
  for (char **part = parts; *part != NULL; part++) {
    if (**part == '\0' || strcmp(*part, ".") == 0)
      continue;
    if (strcmp(*part, "..") == 0) {
      g_string_free(out, TRUE);
      return NULL;
    }
    if (out->len > 0)
      g_string_append_c(out, '/');
    g_string_append(out, *part);
  }
  return g_string_free(out, FALSE);
}

/* mkdir() that accepts a directory already there. */
static int ensure_dir(const char *path, mode_t mode) {
  if (mkdir(path, mode) == 0)
    return 0;
  int error = errno;
  struct stat st;
  if (error == EEXIST && stat(path, &st) == 0)
    return S_ISDIR(st.st_mode) ? 0 : -ENOTDIR;
  return -error;
}

/* Creates the parents of `rel` under the install's directory that are
 * missing, since an archive need not list them. */
static int ensure_parents(IBusWebInstall *install, const char *rel) {
  for (const char *slash = strchr(rel, '/'); slash != NULL;
       slash = strchr(slash + 1, '/')) {
    g_autofree char *parent = g_strndup(rel, (gsize)(slash - rel));
    g_autofree char *path = g_build_filename(install->dir, parent, NULL);
    int ret = ensure_dir(path, 0755);
    if (ret != 0)
      return ret;
  }
  return 0;
}

static int finish_file(IBusWebInstall *install) {
  int fd = install->fd;
  install->fd = -1;
  if (fsync(fd) != 0) {
    int error = errno;
    close(fd);
    return -error;
  }
  if (close(fd) != 0)
    return -errno;
  install->files++;
  return 0;
}

static int take_header(IBusWebInstall *install) {
  const uint8_t *header = install->header;
  if (all_zero(header)) {
    if (++install->zero_blocks == 2)
      install->state = STATE_END;
    return 0;
  }
  /* A lone zero block followed by a member is no archive tar writes. */
  if (install->zero_blocks > 0)
    return -EINVAL;
  /* POSIX's magic and version; GNU's older format has neither. */
  if (!field_is(header, USTAR_FIELD(magic), TMAGIC) ||
      !field_is(header, USTAR_FIELD(version), TVERSION) ||
      !checksum_matches(header))
    return -EINVAL;

  uint64_t mode, size;
  if (!octal(header, USTAR_FIELD(mode), &mode) ||
      !octal(header, USTAR_FIELD(size), &size))
    return -EINVAL;
  /* The owner can always rewrite what an install wrote, so that an install
   * again over it works even when the archive's data is read-only. */
  mode = (mode & (TUREAD | TUWRITE | TUEXEC | TGREAD | TGWRITE | TGEXEC |
                  TOREAD | TOWRITE | TOEXEC)) |
         TUREAD | TUWRITE;
  char type = (char)header[USTAR_OFFSET(typeflag)];
  gboolean regular = type == REGTYPE || type == AREGTYPE;
  if (!regular && type != DIRTYPE)
    return -EINVAL;
  g_autofree char *rel = relative_name(header);
  if (rel == NULL)
    return -EINVAL;

  if (!regular) {
    /* A directory's size, if any, is no data of its own. */
    if (size != 0)
      return -EINVAL;
    if (rel[0] == '\0')
      return 0;
    int ret = ensure_parents(install, rel);
    if (ret != 0)
      return ret;
    g_autofree char *path = g_build_filename(install->dir, rel, NULL);
    mode |= TUREAD | TUWRITE | TUEXEC;
    ret = ensure_dir(path, (mode_t)mode);
    /* mkdir() applies the umask, and leaves a directory already there as it
     * was. */
    if (ret == 0 && chmod(path, (mode_t)mode) != 0)
      ret = -errno;
    return ret;
  }

  if (rel[0] == '\0')
    return -EINVAL;
  int ret = ensure_parents(install, rel);
  if (ret != 0)
    return ret;
  g_autofree char *path = g_build_filename(install->dir, rel, NULL);
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, (mode_t)mode);
  if (fd < 0)
    return -errno;
  install->fd = fd;
  /* open() applies the umask, and leaves a file already there its mode. */
  if (fchmod(fd, (mode_t)mode) != 0)
    return -errno;
  install->data_left = size;
  install->padding_left =
      (uint32_t)((USTAR_BLOCK_SIZE - size % USTAR_BLOCK_SIZE) %
                 USTAR_BLOCK_SIZE);
  if (size == 0)
    return finish_file(install);
  /* Sized before its data arrives, a file in memory takes its size once,
   * where appending each piece would grow it to as much as twice that and
   * need the old copy beside the new while it moves. Until the data is
   * written the file reads as zeros; an install cut short leaves no marker,
   * so nothing trusts such a file. */
  if (ftruncate(fd, (off_t)size) != 0)
    return -errno;
  install->state = STATE_DATA;
  return 0;
}

int ibusweb_install_begin(const char *dir, IBusWebInstall **out) {
  if (dir == NULL || out == NULL)
    return -EINVAL;
  *out = NULL;
  struct stat st;
  if (stat(dir, &st) != 0)
    return -errno;
  if (!S_ISDIR(st.st_mode))
    return -ENOTDIR;
  IBusWebInstall *install = g_try_new0(IBusWebInstall, 1);
  if (install == NULL)
    return -ENOMEM;
  install->dir = g_strdup(dir);
  install->state = STATE_HEADER;
  install->fd = -1;
  *out = install;
  return 0;
}

int ibusweb_install_feed(IBusWebInstall *install, const uint8_t *data,
                         uint32_t len) {
  if (install == NULL)
    return -EINVAL;
  if (install->state == STATE_FAILED)
    return install->error;
  if (data == NULL && len > 0)
    return fail(install, -EINVAL);
  while (len > 0) {
    switch (install->state) {
    case STATE_FAILED:
      return install->error;
    case STATE_END:
      return 0;
    case STATE_HEADER: {
      uint32_t take = MIN(len, USTAR_BLOCK_SIZE - install->header_fill);
      memcpy(install->header + install->header_fill, data, take);
      install->header_fill += take;
      data += take;
      len -= take;
      if (install->header_fill == USTAR_BLOCK_SIZE) {
        install->header_fill = 0;
        int ret = take_header(install);
        if (ret != 0)
          return fail(install, ret);
      }
      break;
    }
    case STATE_DATA: {
      uint32_t take = (uint32_t)MIN((uint64_t)len, install->data_left);
      ssize_t written = write(install->fd, data, take);
      if (written < 0)
        return fail(install, -errno);
      if (written == 0)
        return fail(install, -EIO);
      /* A short write is retried with what is left. */
      data += written;
      len -= (uint32_t)written;
      install->data_left -= (uint64_t)written;
      install->bytes += (uint64_t)written;
      if (install->data_left == 0) {
        int ret = finish_file(install);
        if (ret != 0)
          return fail(install, ret);
        install->state =
            install->padding_left > 0 ? STATE_PADDING : STATE_HEADER;
      }
      break;
    }
    case STATE_PADDING: {
      uint32_t take = MIN(len, install->padding_left);
      data += take;
      len -= take;
      install->padding_left -= take;
      if (install->padding_left == 0)
        install->state = STATE_HEADER;
      break;
    }
    }
  }
  return install->state == STATE_FAILED ? install->error : 0;
}

void ibusweb_install_count(const IBusWebInstall *install, uint32_t *files,
                           uint64_t *bytes) {
  if (files != NULL)
    *files = install == NULL ? 0 : install->files;
  if (bytes != NULL)
    *bytes = install == NULL ? 0 : install->bytes;
}

int ibusweb_install_end(IBusWebInstall *install) {
  if (install == NULL)
    return -EINVAL;
  int ret;
  switch (install->state) {
  case STATE_END:
    ret = 0;
    break;
  case STATE_FAILED:
    ret = install->error;
    break;
  default:
    ret = fail(install, -EINVAL);
  }
  g_free(install->dir);
  g_free(install);
  return ret;
}
