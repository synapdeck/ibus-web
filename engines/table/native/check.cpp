// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// table-check FILE.table...: parses each table, stopping at the first error.

#include <iostream>

#include "../src/table.hpp"

int main(int argc, char **argv) {
  if (argc < 2) {
    std::cerr << "usage: table-check FILE.table...\n";
    return 2;
  }

  for (int i = 1; i < argc; ++i) {
    const auto table = ibusweb::table::Table::load(argv[i]);
    if (!table) {
      std::cerr << table.error().message() << '\n';
      return 1;
    }
  }
  return 0;
}
