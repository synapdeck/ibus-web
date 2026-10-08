// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// table-describe FILE.table...: prints the tables' engine descriptors as one
// JSON array, each engine named for its file's stem.

#include <cstdio>
#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>

#include "../src/table.hpp"

namespace {

std::string jsonString(std::string_view text) {
  std::string out = "\"";
  for (const char c : text) {
    switch (c) {
    case '"':
      out += "\\\"";
      break;
    case '\\':
      out += "\\\\";
      break;
    case '\n':
      out += "\\n";
      break;
    case '\t':
      out += "\\t";
      break;
    default:
      if (static_cast<unsigned char>(c) < 0x20) {
        char escape[7];
        std::snprintf(escape, sizeof escape, "\\u%04x",
                      static_cast<unsigned>(c));
        out += escape;
      } else {
        out += c;
      }
    }
  }
  return out + "\"";
}

} // namespace

int main(int argc, char **argv) {
  using ibusweb::table::Layout;
  using ibusweb::table::Table;

  if (argc < 2) {
    std::cerr << "usage: table-describe FILE.table...\n";
    return 2;
  }

  std::string json = "[";
  for (int i = 1; i < argc; ++i) {
    const std::filesystem::path path = argv[i];
    const auto table = Table::load(path);
    if (!table) {
      std::cerr << table.error().message() << '\n';
      return 1;
    }

    const auto &frontmatter = table->frontmatter();
    std::string languages = "[";
    for (const std::string &language : frontmatter.languages) {
      languages += (languages.size() > 1 ? "," : "") + jsonString(language);
    }
    languages += "]";
    const char *layout = frontmatter.layout == Layout::us ? "us" : "default";

    json += (i > 1 ? "," : "");
    json += "{\"name\":" + jsonString(path.stem().string()) +
            ",\"displayName\":" + jsonString(frontmatter.name) +
            ",\"languages\":" + languages + ",\"keyboard\":{\"layout\":\"" +
            layout + "\",\"passThrough\":[]}}";
  }
  std::cout << json << "]\n";
  return 0;
}
