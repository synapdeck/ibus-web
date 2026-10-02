// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// main() for GoogleTest programs: runs every test, then hands GoogleTest's
// JSON report to whatever runs the program. Programs link with
// -sPROXY_TO_PTHREAD, so this runs on a pthread while the program's own
// thread keeps its event loop.

#include <cstddef>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include <gtest/gtest.h>

extern "C" void ibus_web_test_report(const char *text, size_t length);

namespace {

constexpr const char *kReportPath = "/tmp/gtest-report.json";

} // namespace

int main(int argc, char **argv) {
  // Last, so a program's own arguments can't send the report elsewhere.
  // GoogleTest sets up its report as it parses its flags, so the flag has
  // to be among them.
  std::string output = std::string("--gtest_output=json:") + kReportPath;
  std::vector<char *> args(argv, argv + argc);
  args.push_back(output.data());
  args.push_back(nullptr);
  int count = argc + 1;
  testing::InitGoogleTest(&count, args.data());
  const int status = RUN_ALL_TESTS();

  std::ifstream file(kReportPath, std::ios::binary);
  if (!file) {
    std::fprintf(stderr, "gtest-main: no report at %s\n", kReportPath);
    return 1;
  }
  const std::string report{std::istreambuf_iterator<char>(file),
                           std::istreambuf_iterator<char>()};
  file.close();
  // Under Node the path is the host's, shared with other programs.
  std::remove(kReportPath);
  ibus_web_test_report(report.data(), report.size());
  return status;
}
