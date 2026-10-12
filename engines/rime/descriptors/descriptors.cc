// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: GPL-3.0-or-later

// Prints, as JSON, every schema a deployment compiled: its id, name,
// dictionary and dependencies, its switches with their states' labels and
// its spelling algebra, read from the deployed configs through librime.
//
// descriptors SHARED_DATA_DIR PREBUILT_DATA_DIR

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <string>
#include <vector>

#include <emscripten/wasmfs.h>
#include <rime_api.h>
#include <sys/stat.h>

namespace {

RimeApi *rime;

std::string Quote(const std::string &text) {
  std::string quoted = "\"";
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') {
      quoted += '\\';
      quoted += static_cast<char>(c);
    } else if (c < 0x20) {
      char escape[7];
      std::snprintf(escape, sizeof escape, "\\u%04x", c);
      quoted += escape;
    } else {
      quoted += static_cast<char>(c);
    }
  }
  return quoted + "\"";
}

std::string String(RimeConfig *config, const std::string &key) {
  const char *value = rime->config_get_cstring(config, key.c_str());
  return value != nullptr ? value : "";
}

// A list of strings as JSON, or [] when key isn't a list.
std::string Strings(RimeConfig *config, const std::string &key) {
  std::string json = "[";
  size_t count = rime->config_list_size(config, key.c_str());
  for (size_t i = 0; i < count; ++i) {
    json +=
        (i ? ", " : "") + Quote(String(config, key + "/@" + std::to_string(i)));
  }
  return json + "]";
}

std::string Switches(RimeConfig *config) {
  std::string json = "[";
  size_t count = rime->config_list_size(config, "switches");
  for (size_t i = 0; i < count; ++i) {
    std::string key = "switches/@" + std::to_string(i);
    json += i ? ", " : "";
    json += "{\"name\": " + Quote(String(config, key + "/name")) +
            ", \"options\": " + Strings(config, key + "/options") +
            ", \"states\": " + Strings(config, key + "/states") + "}";
  }
  return json + "]";
}

} // namespace

int main(int argc, char **argv) {
  if (argc != 3) {
    std::fprintf(stderr,
                 "usage: descriptors SHARED_DATA_DIR PREBUILT_DATA_DIR\n");
    return 2;
  }

  // The program's root is in memory; the store comes from the host.
  mkdir("/nix", 0777);
  if (wasmfs_create_directory("/nix/store", 0777,
                              wasmfs_create_node_backend("/nix/store")) != 0) {
    std::perror("/nix/store");
    return 1;
  }
  mkdir("/user", 0777);

  rime = rime_get_api();
  RIME_STRUCT(RimeTraits, traits);
  traits.shared_data_dir = argv[1];
  traits.prebuilt_data_dir = argv[2];
  traits.user_data_dir = "/user";
  traits.log_dir = "";
  traits.app_name = "rime.descriptors";
  rime->setup(&traits);
  rime->initialize(&traits);

  std::vector<std::string> ids;
  const std::string suffix = ".schema.yaml";
  for (const auto &entry : std::filesystem::directory_iterator(argv[2])) {
    std::string name = entry.path().filename().string();
    if (name.size() > suffix.size() &&
        name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0) {
      ids.push_back(name.substr(0, name.size() - suffix.size()));
    }
  }
  std::sort(ids.begin(), ids.end());

  std::printf("[\n");
  for (size_t i = 0; i < ids.size(); ++i) {
    RimeConfig config = {nullptr};
    if (!rime->schema_open(ids[i].c_str(), &config)) {
      std::fprintf(stderr, "%s: the deployed schema doesn't open\n",
                   ids[i].c_str());
      return 1;
    }
    std::printf(
        "  {\"id\": %s, \"name\": %s, \"dictionary\": %s, "
        "\"dependencies\": %s, \"switches\": %s, \"algebra\": %s}%s\n",
        Quote(ids[i]).c_str(), Quote(String(&config, "schema/name")).c_str(),
        Quote(String(&config, "translator/dictionary")).c_str(),
        Strings(&config, "schema/dependencies").c_str(),
        Switches(&config).c_str(), Strings(&config, "speller/algebra").c_str(),
        i + 1 < ids.size() ? "," : "");
    rime->config_close(&config);
  }
  std::printf("]\n");

  rime->finalize();
  return 0;
}
