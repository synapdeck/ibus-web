/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Writes a burst far larger than a pipe holds to stdout or stderr (argv[1]),
 * from the main thread or from a pthread (argv[2]), with the thread pool
 * already started: a line of LONG_LINE bytes, LINES lines of LINE bytes,
 * each starting with its number, then "end". The reader isn't reading yet,
 * so the burst only gets through if each write waits for it. A write that
 * fails is reported on the other stream, with status 2. */

#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>

#define LONG_LINE (256 * 1024)
#define LINES 2048
#define LINE 512

static FILE *out;
static int failure;

static void put(const char *data, size_t size) {
  if (!failure && fwrite(data, 1, size, out) != size)
    failure = errno;
}

static void *burst(void *arg) {
  static char line[LONG_LINE];
  for (int i = 0; i < LONG_LINE - 1; i++)
    line[i] = 'a' + i % 26;
  line[LONG_LINE - 1] = '\n';
  put(line, LONG_LINE);

  memset(line, 'x', LINE - 1);
  line[LINE - 1] = '\n';
  for (int i = 0; i < LINES; i++) {
    char number[5];
    snprintf(number, sizeof number, "%04d", i);
    memcpy(line, number, 4);
    put(line, LINE);
  }

  put("end\n", 4);
  if (!failure && fflush(out) != 0)
    failure = errno;
  return NULL;
}

int main(int argc, char **argv) {
  if (argc != 3 ||
      (strcmp(argv[1], "stdout") != 0 && strcmp(argv[1], "stderr") != 0) ||
      (strcmp(argv[2], "main") != 0 && strcmp(argv[2], "thread") != 0)) {
    fprintf(stderr, "usage: stdio-burst stdout|stderr main|thread\n");
    return 1;
  }
  out = strcmp(argv[1], "stdout") == 0 ? stdout : stderr;
  FILE *other = out == stdout ? stderr : stdout;

  if (strcmp(argv[2], "thread") == 0) {
    pthread_t thread;
    if (pthread_create(&thread, NULL, burst, NULL) != 0 ||
        pthread_join(thread, NULL) != 0) {
      fprintf(other, "couldn't run the thread\n");
      return 1;
    }
  } else {
    burst(NULL);
  }

  if (failure) {
    fprintf(other, "write failed: %s\n", strerror(failure));
    return 2;
  }
  return 0;
}
