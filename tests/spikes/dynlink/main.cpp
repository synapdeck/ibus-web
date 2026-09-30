// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Loads each side module named on the command line and runs its probe.
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <stdexcept>

using Probe = int (*)();

static const char *basename_of(const char *path) {
  const char *slash = std::strrchr(path, '/');
  return slash ? slash + 1 : path;
}

int main(int argc, char **argv) {
  int failures = 0;
  for (int i = 1; i < argc; ++i) {
    const char *name = basename_of(argv[i]);
    void *handle = dlopen(argv[i], RTLD_NOW);
    if (handle == nullptr) {
      std::printf("FAIL %s: dlopen: %s\n", name, dlerror());
      ++failures;
      continue;
    }
    auto probe = reinterpret_cast<Probe>(dlsym(handle, "probe"));
    if (probe == nullptr) {
      std::printf("FAIL %s: dlsym: %s\n", name, dlerror());
      ++failures;
      continue;
    }
    try {
      int result = probe();
      if (result == 0) {
        std::printf("PASS %s\n", name);
      } else {
        std::printf("FAIL %s: probe returned %d\n", name, result);
        ++failures;
      }
    } catch (const std::exception &e) {
      std::printf("CAUGHT %s: %s\n", name, e.what());
    }
  }
  return failures;
}
