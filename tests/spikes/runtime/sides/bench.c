/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Storage costs, measured on the pumping thread, where each call into a
 * backend that runs on a thread of its own blocks for the round trip to it.
 * Every byte a file holds is what fill() gives for its offset, so reads check
 * what they get, and the bytes look random, so a store that compresses its
 * values takes them at their size. Times are from emscripten_get_now(), the
 * Worker's performance.now(), whose step the browser coarsens. */

#include "spike.h"

#include <emscripten.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

/* SplitMix64's output for each 8-byte word, little end first. */
static uint64_t mix(uint64_t word) {
  uint64_t z = word * 0x9e3779b97f4a7c15u;
  z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9u;
  z = (z ^ (z >> 27)) * 0x94d049bb133111ebu;
  return z ^ (z >> 31);
}

static void fill(uint8_t *buf, size_t len, uint64_t offset) {
  for (size_t i = 0; i < len;) {
    uint64_t at = offset + i;
    uint64_t word = mix(at / 8);
    for (unsigned byte = at % 8; byte < 8 && i < len; byte++, i++)
      buf[i] = (uint8_t)(word >> (byte * 8));
  }
}

/* The file bench-read last read, kept open so that a read costs the read
 * alone; a write to it closes it first. */
static char *open_path;
static int open_fd = -1;

static void close_kept(void) {
  if (open_fd >= 0)
    close(open_fd);
  open_fd = -1;
  g_clear_pointer(&open_path, g_free);
}

static int open_kept(const char *path) {
  if (open_path != NULL && strcmp(open_path, path) == 0)
    return open_fd;
  close_kept();
  int fd = open(path, O_RDONLY);
  if (fd >= 0) {
    open_fd = fd;
    open_path = g_strdup(path);
  }
  return fd;
}

/* Durations in ms, kept to report their mean, median, 95th percentile and
 * longest. */
typedef struct {
  GArray *ms;
} Times;

static Times times_new(void) {
  return (Times){g_array_new(FALSE, FALSE, sizeof(double))};
}

static void times_add(Times *times, double ms) {
  g_array_append_val(times->ms, ms);
}

static int by_value(gconstpointer a, gconstpointer b) {
  double x = *(const double *)a, y = *(const double *)b;
  return (x > y) - (x < y);
}

static int32_t ns(double ms) { return (int32_t)MIN(ms * 1e6, G_MAXINT32); }

/* Appends the count, then the mean, median, 95th percentile and longest in
 * ns, and frees the times. */
static void times_reply(Times *times, GString *reply) {
  GArray *ms = times->ms;
  double sum = 0;
  for (guint i = 0; i < ms->len; i++)
    sum += g_array_index(ms, double, i);
  g_array_sort(ms, by_value);
  spike_reply(reply, (int32_t)ms->len);
  if (ms->len == 0) {
    for (int i = 0; i < 4; i++)
      spike_reply(reply, 0);
  } else {
    spike_reply(reply, ns(sum / ms->len));
    spike_reply(reply, ns(g_array_index(ms, double, ms->len / 2)));
    spike_reply(reply, ns(g_array_index(ms, double, ms->len * 95 / 100)));
    spike_reply(reply, ns(g_array_index(ms, double, ms->len - 1)));
  }
  g_array_free(ms, TRUE);
}

/* The int32 arguments, then the path, which is the rest of the payload;
 * NULL if the payload is too short or the path empty or holds a NUL. */
static char *args_and_path(const uint8_t *payload, uint32_t len, uint32_t count,
                           int32_t *args) {
  for (uint32_t i = 0; i < count; i++)
    if (!spike_arg(payload, len, i, &args[i]))
      return NULL;
  uint32_t at = count * 4;
  if (len <= at || memchr(payload + at, '\0', len - at) != NULL)
    return NULL;
  return g_strndup((const char *)payload + at, len - at);
}

/* bench-write(size, piece, path): creates or truncates path, writes size
 * bytes in writes of piece bytes, fsync()s and closes it. Replies 0, then
 * the writes' times as times_reply() gives them, then the fsync()'s time in
 * ns; or only the error. */
static void bench_write(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t args[2] = {0};
  g_autofree char *path = args_and_path(payload, len, 2, args);
  int32_t size = args[0], piece = args[1];
  if (path == NULL || size < 0 || piece <= 0)
    return;
  close_kept();
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    spike_reply(reply, -errno);
    return;
  }
  uint8_t *buf = g_malloc(piece);
  Times writes = times_new();
  int32_t ret = 0;
  for (int32_t at = 0; ret == 0 && at < size; at += piece) {
    size_t n = MIN(piece, size - at);
    fill(buf, n, at);
    double start = emscripten_get_now();
    ssize_t written = write(fd, buf, n);
    times_add(&writes, emscripten_get_now() - start);
    if (written < 0)
      ret = -errno;
    else if ((size_t)written != n)
      ret = -EIO;
  }
  double start = emscripten_get_now();
  if (ret == 0 && fsync(fd) != 0)
    ret = -errno;
  double fsync_ms = emscripten_get_now() - start;
  if (close(fd) != 0 && ret == 0)
    ret = -errno;
  g_free(buf);
  spike_reply(reply, ret);
  if (ret != 0) {
    g_array_free(writes.ms, TRUE);
    return;
  }
  times_reply(&writes, reply);
  spike_reply(reply, ns(fsync_ms));
}

/* bench-read(size, count, seed, from, path), on path kept open: count reads of
 * size bytes at offsets from + k * size, k drawn at random, from seed, from
 * those the file holds whole. Replies the reads that came back short or wrong,
 * then their times as times_reply() gives them; or only the error. */
static void bench_read(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t args[4] = {0};
  g_autofree char *path = args_and_path(payload, len, 4, args);
  int32_t size = args[0], count = args[1], seed = args[2], from = args[3];
  if (path == NULL || size <= 0 || count < 0 || from < 0)
    return;
  int fd = open_kept(path);
  if (fd < 0) {
    spike_reply(reply, -errno);
    return;
  }
  struct stat st;
  int32_t err = fstat(fd, &st) != 0        ? -errno
                : st.st_size - from < size ? -EINVAL
                                           : 0;
  if (err != 0) {
    spike_reply(reply, err);
    return;
  }
  int32_t slots = (int32_t)MIN((st.st_size - from) / size, G_MAXINT32);
  GRand *rand = g_rand_new_with_seed((guint32)seed);
  uint8_t *buf = g_malloc(size);
  uint8_t *expected = g_malloc(size);
  Times reads = times_new();
  int32_t wrong = 0;
  for (int32_t i = 0; i < count; i++) {
    off_t offset = from + (off_t)g_rand_int_range(rand, 0, slots) * size;
    double start = emscripten_get_now();
    ssize_t n = pread(fd, buf, size, offset);
    times_add(&reads, emscripten_get_now() - start);
    fill(expected, size, offset);
    if (n != size || memcmp(buf, expected, size) != 0)
      wrong++;
  }
  g_free(expected);
  g_free(buf);
  g_rand_free(rand);
  spike_reply(reply, wrong);
  times_reply(&reads, reply);
}

/* bench-append(size, count, path): count appends of size bytes to path, each
 * followed by fsync(). Replies 0, then the writes' times and the fsync()s'
 * as times_reply() gives them; or only the error. */
static void bench_append(const uint8_t *payload, uint32_t len, GString *reply) {
  int32_t args[2] = {0};
  g_autofree char *path = args_and_path(payload, len, 2, args);
  int32_t size = args[0], count = args[1];
  if (path == NULL || size <= 0 || count < 0)
    return;
  close_kept();
  int fd = open(path, O_WRONLY | O_APPEND);
  struct stat st;
  if (fd < 0 || fstat(fd, &st) != 0) {
    spike_reply(reply, -errno);
    if (fd >= 0)
      close(fd);
    return;
  }
  uint64_t end = (uint64_t)st.st_size;
  uint8_t *buf = g_malloc(size);
  Times writes = times_new(), fsyncs = times_new();
  int32_t ret = 0;
  for (int32_t i = 0; ret == 0 && i < count; i++, end += size) {
    fill(buf, size, end);
    double start = emscripten_get_now();
    ssize_t written = write(fd, buf, size);
    double synced = emscripten_get_now();
    if (written != size)
      ret = written < 0 ? -errno : -EIO;
    else if (fsync(fd) != 0)
      ret = -errno;
    times_add(&writes, synced - start);
    times_add(&fsyncs, emscripten_get_now() - synced);
  }
  if (close(fd) != 0 && ret == 0)
    ret = -errno;
  g_free(buf);
  spike_reply(reply, ret);
  if (ret != 0) {
    g_array_free(writes.ms, TRUE);
    g_array_free(fsyncs.ms, TRUE);
    return;
  }
  times_reply(&writes, reply);
  times_reply(&fsyncs, reply);
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, SPIKE_OP_BENCH_WRITE, "bench-write",
                        bench_write);
  ibusweb_module_add_op(module, SPIKE_OP_BENCH_READ, "bench-read", bench_read);
  ibusweb_module_add_op(module, SPIKE_OP_BENCH_APPEND, "bench-append",
                        bench_append);
}
