// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#pragma once

#include <cstddef>
#include <expected>
#include <filesystem>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace ibusweb::table {

enum class Mode { command, continuous };

// `default` and `us` in the file.
enum class Layout { standard, us };

struct Frontmatter {
  std::string name;
  std::vector<std::string> languages;
  Mode mode;
  std::optional<char32_t> trigger;
  Layout layout;
};

struct ParseError {
  std::string path;
  // 0 when the error belongs to the file rather than a line of it.
  std::size_t line;
  std::string reason;

  // `path:line: reason`, or `path: reason` without a line.
  std::string message() const;
};

struct Candidate {
  std::string key;
  std::string output;
};

// A parsed table, immutable and shared by every session of its engine. Keys
// and outputs are UTF-8.
class Table {
public:
  static std::expected<Table, ParseError> parse(std::string_view path,
                                                std::string_view text);
  static std::expected<Table, ParseError>
  load(const std::filesystem::path &path);

  Table(Table &&) noexcept;
  Table &operator=(Table &&) noexcept;
  ~Table();

  const Frontmatter &frontmatter() const;
  bool inAlphabet(char32_t c) const;

  // The key's outputs in file order; empty if it isn't a key.
  std::span<const std::string> exact(std::string_view key) const;

  // Every key starting with `prefix`, the prefix included, by key length in
  // code points, then by key in code point order, then each key's outputs in
  // file order.
  std::vector<Candidate> completions(std::string_view prefix) const;

  // Whether a key strictly longer than `prefix` starts with it.
  bool extendable(std::string_view prefix) const;

  // The longest key that `text` starts with: its length in bytes and its
  // first output.
  std::optional<std::pair<std::size_t, std::string_view>>
  longestPrefix(std::string_view text) const;

private:
  struct Index;

  Table(Frontmatter frontmatter, std::vector<char32_t> alphabet,
        std::unique_ptr<Index> index);

  Frontmatter frontmatter_;
  std::vector<char32_t> alphabet_;
  std::unique_ptr<Index> index_;
};

} // namespace ibusweb::table
