// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

namespace ibusweb::table::utf8 {

struct Decoded {
  char32_t character;
  std::size_t length;
};

// The code point starting at `offset`, or nothing where the bytes there
// aren't well-formed UTF-8: overlong forms and surrogates are rejected.
// `offset` must be less than `text.size()`.
std::optional<Decoded> decode(std::string_view text, std::size_t offset);

bool valid(std::string_view text);

// Code points in well-formed text.
std::size_t length(std::string_view text);

// Bytes in the last code point of non-empty, well-formed text.
std::size_t lastLength(std::string_view text);

void append(std::string &out, char32_t character);

} // namespace ibusweb::table::utf8
