/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include "spike.h"

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sys/stat.h>
#include <unistd.h>

typedef enum { IDLE, PENDING, DONE } State;

/* Touched only on the pumping thread, except path, which a running writer
 * reads; the writer reports back through the source it attaches. */
static State state;
static char *path;
static int32_t status;

static gboolean complete(gpointer result) {
  status = GPOINTER_TO_INT(result);
  state = DONE;
  return G_SOURCE_REMOVE;
}

/* Writes the file's own path into it, so its size tells the host the write
 * landed. */
static int write_synced(const char *file) {
  int fd = open(file, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0)
    return -errno;
  int ret = 0;
  size_t len = strlen(file);
  if (write(fd, file, len) != (ssize_t)len)
    ret = -EIO;
  else if (fsync(fd) != 0)
    ret = -errno;
  if (close(fd) != 0 && ret == 0)
    ret = -errno;
  return ret;
}

static void *writer(void *file) {
  g_idle_add(complete, GINT_TO_POINTER(write_synced(file)));
  return NULL;
}

/* fsync(path), path as UTF-8 bytes: a pthread creates the file, writes it,
 * fsync()s and closes it, then reports to the default context through a
 * source. */
static void fsync_op(const uint8_t *payload, uint32_t len, GString *reply) {
  if (len == 0 || memchr(payload, '\0', len) != NULL)
    return;
  if (state == PENDING) {
    spike_reply(reply, -EBUSY);
    return;
  }
  g_free(path);
  path = g_strndup((const char *)payload, len);

  pthread_attr_t attr;
  pthread_t thread;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  int ret = pthread_create(&thread, &attr, writer, path);
  pthread_attr_destroy(&attr);
  if (ret != 0) {
    state = IDLE;
    spike_reply(reply, -ret);
    return;
  }
  state = PENDING;
  spike_reply(reply, 0);
}

/* fsync-result(): the file's size once written, or the writer's error. */
static void fsync_result(const uint8_t *payload, uint32_t len, GString *reply) {
  (void)payload;
  (void)len;
  struct stat st;
  switch (state) {
  case IDLE:
    spike_reply(reply, -ENOENT);
    break;
  case PENDING:
    spike_reply(reply, -EAGAIN);
    break;
  case DONE:
    if (status < 0)
      spike_reply(reply, status);
    else if (stat(path, &st) != 0)
      spike_reply(reply, -errno);
    else
      spike_reply(reply, (int32_t)MIN(st.st_size, G_MAXINT32));
    break;
  }
}

void ibusweb_module_init(IBusWebModule *module) {
  ibusweb_module_add_op(module, SPIKE_OP_FSYNC, "fsync", fsync_op);
  ibusweb_module_add_op(module, SPIKE_OP_FSYNC_RESULT, "fsync-result",
                        fsync_result);
}
