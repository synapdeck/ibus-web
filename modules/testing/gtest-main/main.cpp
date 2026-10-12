// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// main() for GoogleTest programs: runs the tests its arguments select, then
// hands GoogleTest's JSON report to whatever runs the program. Programs link
// with -sPROXY_TO_PTHREAD, so this runs on a pthread while the program's own
// thread keeps its event loop.

#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <unistd.h>

extern "C" void ibus_web_test_report(const char *text, size_t length);

int main(int argc, char **argv) {
  // A file of this run's own: under Node, /tmp is the host's, which other
  // programs may be writing reports to at the same time. A TMPDIR the
  // runner removes keeps the report of a program that dies before it can
  // remove it from outliving the run.
  const char *tmpdir = std::getenv("TMPDIR");
  std::string path =
      std::string(tmpdir != nullptr && *tmpdir != '\0' ? tmpdir : "/tmp") +
      "/gtest-report-XXXXXX.json";
  const int fd = mkstemps(path.data(), 5);
  if (fd == -1) {
    std::perror("gtest-main: mkstemps");
    return 1;
  }
  close(fd);

  // Last, so a program's own arguments can't send the report elsewhere.
  // GoogleTest sets up its report as it parses its flags, so the flag has
  // to be among them.
  std::string output = "--gtest_output=json:" + path;
  std::vector<char *> args(argv, argv + argc);
  args.push_back(output.data());
  args.push_back(nullptr);
  int count = argc + 1;
  testing::InitGoogleTest(&count, args.data());
  const int status = RUN_ALL_TESTS();

  std::ifstream file(path, std::ios::binary);
  if (!file) {
    std::fprintf(stderr, "gtest-main: no report at %s\n", path.c_str());
    std::remove(path.c_str());
    return 1;
  }
  const std::string report{std::istreambuf_iterator<char>(file),
                           std::istreambuf_iterator<char>()};
  file.close();
  std::remove(path.c_str());
  ibus_web_test_report(report.data(), report.size());
  return status;
}
