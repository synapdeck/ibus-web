/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Each Emscripten fix the toolchain carries, checked for the behaviour it
 * restores. argv[1] is an empty host directory the program may write. */

#include <emscripten/em_js.h>
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* What the host sees, past WasmFS. */
EM_JS(int, host_exists, (const char *path),
      { return require('node:fs').existsSync(UTF8ToString(path)) ? 1 : 0; });

EM_JS(int, host_read, (const char *path, char *buf, int size), {
  try {
    return stringToUTF8(require('node:fs').readFileSync(UTF8ToString(path), 'utf8'), buf, size);
}
catch { return -1; }
});

EM_JS(void, host_chmod, (const char *path, int mode),
      { require('node:fs').chmodSync(UTF8ToString(path), mode); });

static const char *host;
static int failures;

#define CHECK(cond, ...)                                                       \
  do {                                                                         \
    if (!(cond)) {                                                             \
      failures++;                                                              \
      printf("FAIL line %d: ", __LINE__);                                      \
      printf(__VA_ARGS__);                                                     \
      printf(" (errno: %s)\n", strerror(errno));                               \
    }                                                                          \
  } while (0)

static void put(const char *path, const char *text) {
  int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0644);
  CHECK(fd >= 0, "create %s", path);
  CHECK(write(fd, text, strlen(text)) == (ssize_t)strlen(text), "write %s",
        path);
  CHECK(close(fd) == 0, "close %s", path);
}

static void expect_file(const char *path, const char *text) {
  char buf[64] = {0};
  struct stat st;
  int fd;

  CHECK(stat(path, &st) == 0 && st.st_size == (off_t)strlen(text), "stat %s",
        path);
  fd = open(path, O_RDONLY);
  CHECK(fd >= 0, "open %s", path);
  CHECK(read(fd, buf, sizeof buf - 1) == (ssize_t)strlen(text) &&
            strcmp(buf, text) == 0,
        "read %s: \"%s\"", path, buf);
  CHECK(close(fd) == 0, "close %s", path);
}

/* The host's file at rel, under the host directory, holds text; with a NULL
 * text, there is none. */
static void expect_host(const char *rel, const char *text) {
  char path[256], buf[64] = {0};

  snprintf(path, sizeof path, "%s/%s", host, rel);
  if (text == NULL)
    CHECK(!host_exists(path), "the host still has %s", rel);
  else
    CHECK(host_read(path, buf, sizeof buf) >= 0 && strcmp(buf, text) == 0,
          "host %s: \"%s\"", rel, buf);
}

static short poll_in(int fd) {
  struct pollfd pfd = {.fd = fd, .events = POLLIN};

  CHECK(poll(&pfd, 1, 0) >= 0, "poll");
  return pfd.revents & POLLIN;
}

static void check_memory_fs(void) {
  char mem[256], path[512], cwd[256];
  int fds[2], fd;
  struct stat st;

#define AT(rel) (snprintf(path, sizeof path, "%s/%s", mem, rel), path)
  /* A mount point inside a memory directory, which keeps its own names. */
  snprintf(mem, sizeof mem, "%s/mem", host);
  wasmfs_create_directory(mem, 0777, wasmfs_create_memory_backend());
  wasmfs_create_directory(AT("mnt"), 0777, wasmfs_create_memory_backend());
  CHECK(mkdir(AT("mnt/sub"), 0777) == 0, "mkdir");
  CHECK(chdir(AT("mnt/sub")) == 0, "chdir");
  CHECK(getcwd(cwd, sizeof cwd) != NULL && strcmp(cwd, AT("mnt/sub")) == 0,
        "getcwd under a mount: \"%s\"", cwd);
  CHECK(chdir(host) == 0, "chdir");

  /* Directories without search or write permission. */
  CHECK(mkdir(AT("noexec"), 0777) == 0, "mkdir");
  put(AT("noexec/f"), "f");
  CHECK(chmod(AT("noexec"), 0666) == 0, "chmod");
  CHECK(open(AT("noexec/f"), O_RDONLY) < 0 && errno == EACCES,
        "open without search permission");
  CHECK(chdir(AT("noexec")) < 0 && errno == EACCES,
        "chdir without search permission");
  CHECK(mkdir(AT("ro"), 0555) == 0, "mkdir");
  CHECK(open(AT("ro/f"), O_CREAT | O_WRONLY, 0644) < 0 && errno == EACCES,
        "create without write permission");

  /* Empty files and devices are readable; a pipe is while it holds data. */
  put(AT("empty"), "");
  fd = open(AT("empty"), O_RDONLY);
  CHECK(poll_in(fd), "poll an empty file");
  close(fd);
  fd = open("/dev/null", O_RDONLY | O_NOCTTY);
  CHECK(fd >= 0, "open with O_NOCTTY");
  CHECK(poll_in(fd), "poll /dev/null");
  close(fd);
  CHECK(pipe(fds) == 0, "pipe");
  CHECK(!poll_in(fds[0]), "poll an empty pipe");
  CHECK(write(fds[1], "x", 1) == 1, "write a pipe");
  CHECK(poll_in(fds[0]), "poll a pipe holding data");
  CHECK(fstat(fds[0], &st) == 0 && S_ISFIFO(st.st_mode), "a pipe is a FIFO");
  close(fds[0]);
  close(fds[1]);
#undef AT
}

static void check_node_errors(void) {
  char path[256];
  int fd;
  struct stat st;

  snprintf(path, sizeof path, "%s/locked", host);
  put(path, "locked");
  CHECK(stat(path, &st) == 0, "stat");
  /* Only the host refuses, so the error comes from the host's open(). */
  host_chmod(path, 0);
  fd = open(path, O_RDONLY);
  CHECK(fd < 0 && errno == EACCES, "open a file the host refuses: %d", fd);
  host_chmod(path, 0644);

  fd = open(path, O_RDWR);
  CHECK(fd >= 0 && write(fd, "synced", 6) == 6 && fsync(fd) == 0,
        "fsync a host file");
  CHECK(close(fd) == 0, "close");
}

static int dir_c;
static volatile int done;
static int reader_failures;

/* The directory is renamed back and forth meanwhile, but a lookup relative
 * to the directory itself must always find the file in it. */
static void *reader(void *data) {
  while (!done) {
    int fd = openat(dir_c, "f", O_RDONLY);
    char c = 0;

    if (fd < 0 || read(fd, &c, 1) != 1 || c != 'c')
      reader_failures++;
    if (fd >= 0)
      close(fd);
  }
  return NULL;
}

static void check_node_rename(void) {
  char d[256], path[512], cwd[256];
  int f, h;
  pthread_t thread;
  struct stat st;

#define AT(rel) (snprintf(path, sizeof path, "%s/%s", host, rel), path)
  CHECK(mkdir(AT("d"), 0777) == 0, "mkdir");
  CHECK(mkdir(AT("d/sub"), 0777) == 0, "mkdir");
  CHECK(mkdir(AT("d/sub/deep"), 0777) == 0, "mkdir");
  put(AT("d/f"), "f1");
  put(AT("d/g"), "g1");
  put(AT("d/sub/h"), "h1");
  put(AT("d/sub/i"), "i1");
  put(AT("d/sub/deep/j"), "j1");
  CHECK(symlink("g", AT("d/link")) == 0, "symlink");

  /* Files open across the renames, files looked up and closed, and a
   * working directory, all below the renamed directory. */
  f = open(AT("d/f"), O_RDWR);
  h = open(AT("d/sub/h"), O_RDWR);
  CHECK(f >= 0 && h >= 0, "open");
  CHECK(stat(AT("d/g"), &st) == 0, "stat");
  CHECK(stat(AT("d/sub/i"), &st) == 0, "stat");
  CHECK(stat(AT("d/sub/deep/j"), &st) == 0, "stat");
  CHECK(chdir(AT("d/sub")) == 0, "chdir");

  snprintf(d, sizeof d, "%s", AT("d"));
  CHECK(rename(d, AT("e")) == 0, "rename d e");
  expect_host("d", NULL);
  CHECK(pwrite(f, "F2", 2, 0) == 2 && fstat(f, &st) == 0 && st.st_size == 2,
        "write the open f");
  CHECK(pwrite(h, "H2", 2, 0) == 2 && fsync(h) == 0, "write the open h");
  expect_host("e/f", "F2");
  expect_host("e/sub/h", "H2");
  expect_file(AT("e/f"), "F2");
  expect_file(AT("e/g"), "g1");
  expect_file(AT("e/link"), "g1");
  expect_file(AT("e/sub/h"), "H2");
  expect_file(AT("e/sub/i"), "i1");
  expect_file(AT("e/sub/deep/j"), "j1");
  expect_file("i", "i1");
  put(AT("e/sub/deep/new"), "n1");
  expect_host("e/sub/deep/new", "n1");
  put("k", "k1");
  expect_host("e/sub/k", "k1");
  CHECK(open(AT("d/f"), O_RDONLY) < 0 && errno == ENOENT,
        "open under the old name");

  /* A subdirectory, then its parent, then into another directory. */
  CHECK(rename(AT("e/sub"), (snprintf(d, sizeof d, "%s/e/sub2", host), d)) == 0,
        "rename sub");
  CHECK(rename(AT("e"), (snprintf(d, sizeof d, "%s/x", host), d)) == 0,
        "rename e");
  CHECK(mkdir(AT("p"), 0777) == 0, "mkdir");
  CHECK(rename(AT("x/sub2/deep"),
               (snprintf(d, sizeof d, "%s/p/moved", host), d)) == 0,
        "rename deep");
  CHECK(rename(AT("x/g"), (snprintf(d, sizeof d, "%s/x/sub2/g", host), d)) == 0,
        "rename g");
  expect_host("e", NULL);
  expect_host("x/sub", NULL);
  expect_host("x/sub2/deep", NULL);
  expect_host("x/g", NULL);
  CHECK(pwrite(h, "H3", 2, 0) == 2, "write the open h");
  expect_host("x/sub2/h", "H3");
  expect_file(AT("x/f"), "F2");
  expect_file(AT("x/sub2/g"), "g1");
  expect_file(AT("x/sub2/h"), "H3");
  expect_file(AT("x/sub2/i"), "i1");
  expect_file(AT("p/moved/j"), "j1");
  expect_file(AT("p/moved/new"), "n1");
  expect_file("k", "k1");
  CHECK(getcwd(cwd, sizeof cwd) != NULL && strcmp(cwd, AT("x/sub2")) == 0,
        "getcwd: \"%s\"", cwd);
  CHECK(close(f) == 0 && close(h) == 0, "close");
  CHECK(chdir(host) == 0, "chdir");

  CHECK(mkdir(AT("c1"), 0777) == 0, "mkdir");
  put(AT("c1/f"), "c");
  dir_c = open(AT("c1"), O_RDONLY | O_DIRECTORY);
  CHECK(dir_c >= 0, "open c1");
  CHECK(pthread_create(&thread, NULL, reader, NULL) == 0, "pthread_create");
  for (int i = 0; i < 2000; i++) {
    char from[256], to[256];

    snprintf(from, sizeof from, "%s/c%d", host, 1 + i % 2);
    snprintf(to, sizeof to, "%s/c%d", host, 2 - i % 2);
    CHECK(rename(from, to) == 0, "rename %s", from);
  }
  done = 1;
  pthread_join(thread, NULL);
  CHECK(reader_failures == 0,
        "%d lookups failed while their directory was renamed", reader_failures);
  close(dir_c);
#undef AT
}

int main(int argc, char **argv) {
  host = argv[1];
  check_memory_fs();
  check_node_errors();
  check_node_rename();
  printf("%d failures\n", failures);
  return failures != 0;
}
