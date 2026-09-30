// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include <stdexcept>
#include <string>

extern "C" int probe() {
  try {
    throw std::runtime_error("inside");
  } catch (const std::runtime_error &e) {
    return std::string(e.what()) == "inside" ? 0 : 1;
  }
}
