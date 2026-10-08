// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include "utf8.hpp"

namespace ibusweb::table::utf8 {

namespace {

bool isContinuation(char byte) {
  return (static_cast<unsigned char>(byte) & 0xc0) == 0x80;
}

} // namespace

std::optional<Decoded> decode(std::string_view text, std::size_t offset) {
  const auto lead = static_cast<unsigned char>(text[offset]);
  if (lead < 0x80) {
    return Decoded{lead, 1};
  }

  std::size_t length = 0;
  char32_t character = 0;
  char32_t smallest = 0;
  if ((lead & 0xe0) == 0xc0) {
    length = 2;
    character = lead & 0x1f;
    smallest = 0x80;
  } else if ((lead & 0xf0) == 0xe0) {
    length = 3;
    character = lead & 0x0f;
    smallest = 0x800;
  } else if ((lead & 0xf8) == 0xf0) {
    length = 4;
    character = lead & 0x07;
    smallest = 0x10000;
  } else {
    return std::nullopt;
  }

  if (offset + length > text.size()) {
    return std::nullopt;
  }
  for (std::size_t i = 1; i < length; ++i) {
    const char byte = text[offset + i];
    if (!isContinuation(byte)) {
      return std::nullopt;
    }
    character = (character << 6) | (static_cast<unsigned char>(byte) & 0x3f);
  }

  const bool surrogate = character >= 0xd800 && character <= 0xdfff;
  if (character < smallest || character > 0x10ffff || surrogate) {
    return std::nullopt;
  }
  return Decoded{character, length};
}

bool valid(std::string_view text) {
  for (std::size_t offset = 0; offset < text.size();) {
    const auto decoded = decode(text, offset);
    if (!decoded) {
      return false;
    }
    offset += decoded->length;
  }
  return true;
}

std::size_t length(std::string_view text) {
  std::size_t count = 0;
  for (const char byte : text) {
    if (!isContinuation(byte)) {
      ++count;
    }
  }
  return count;
}

std::size_t lastLength(std::string_view text) {
  std::size_t start = text.size() - 1;
  while (start > 0 && isContinuation(text[start])) {
    --start;
  }
  return text.size() - start;
}

void append(std::string &out, char32_t character) {
  if (character < 0x80) {
    out += static_cast<char>(character);
  } else if (character < 0x800) {
    out += static_cast<char>(0xc0 | (character >> 6));
    out += static_cast<char>(0x80 | (character & 0x3f));
  } else if (character < 0x10000) {
    out += static_cast<char>(0xe0 | (character >> 12));
    out += static_cast<char>(0x80 | ((character >> 6) & 0x3f));
    out += static_cast<char>(0x80 | (character & 0x3f));
  } else {
    out += static_cast<char>(0xf0 | (character >> 18));
    out += static_cast<char>(0x80 | ((character >> 12) & 0x3f));
    out += static_cast<char>(0x80 | ((character >> 6) & 0x3f));
    out += static_cast<char>(0x80 | (character & 0x3f));
  }
}

} // namespace ibusweb::table::utf8
