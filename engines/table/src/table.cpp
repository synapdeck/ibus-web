// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

#include "table.hpp"

#include <algorithm>
#include <array>
#include <fstream>
#include <iterator>
#include <map>
#include <set>
#include <system_error>
#include <tuple>

#include <marisa.h>

#include "utf8.hpp"

namespace ibusweb::table {

struct Table::Index {
  marisa::Trie trie;
  // By key ID, each key's outputs in file order.
  std::vector<std::vector<std::string>> outputs;
};

namespace {

struct Parsed {
  Frontmatter frontmatter;
  std::vector<std::pair<std::string, std::string>> mappings;
};

std::vector<std::string_view> splitLines(std::string_view text) {
  std::vector<std::string_view> lines;
  std::size_t start = 0;
  while (start < text.size()) {
    const std::size_t end = text.find('\n', start);
    if (end == std::string_view::npos) {
      lines.push_back(text.substr(start));
      break;
    }
    lines.push_back(text.substr(start, end - start));
    start = end + 1;
  }
  return lines;
}

bool isBlank(std::string_view line) {
  return line.find_first_not_of(" \t") == std::string_view::npos;
}

std::string_view trim(std::string_view text) {
  const std::size_t first = text.find_first_not_of(" \t");
  if (first == std::string_view::npos) {
    return {};
  }
  const std::size_t last = text.find_last_not_of(" \t");
  return text.substr(first, last - first + 1);
}

std::string quoted(std::string_view text) {
  return "\"" + std::string(text) + "\"";
}

// `\t`, `\n` and `\\`; anything else after a backslash is an error, reported
// as the reason.
std::expected<std::string, std::string> unescape(std::string_view raw) {
  std::string out;
  for (std::size_t i = 0; i < raw.size(); ++i) {
    if (raw[i] != '\\') {
      out += raw[i];
      continue;
    }
    if (i + 1 == raw.size()) {
      return std::unexpected("unknown escape \"\\\" in output");
    }
    switch (raw[i + 1]) {
    case 't':
      out += '\t';
      break;
    case 'n':
      out += '\n';
      break;
    case '\\':
      out += '\\';
      break;
    default: {
      const std::size_t length = utf8::decode(raw, i + 1)->length;
      return std::unexpected("unknown escape " +
                             quoted(raw.substr(i, 1 + length)) + " in output");
    }
    }
    ++i;
  }
  return out;
}

class Parser {
public:
  Parser(std::string_view path, std::string_view text)
      : path_(path), lines_(splitLines(text)) {}

  std::expected<Parsed, ParseError> run() {
    for (std::size_t i = 0; i < lines_.size(); ++i) {
      if (lines_[i].contains('\r')) {
        return fail(i + 1, "carriage return; tables use LF line endings");
      }
      if (!utf8::valid(lines_[i])) {
        return fail(i + 1, "invalid UTF-8");
      }
    }

    if (auto error = frontmatter()) {
      return std::unexpected(*error);
    }
    if (auto error = body()) {
      return std::unexpected(*error);
    }
    return std::move(parsed_);
  }

private:
  struct Value {
    std::size_t line;
    std::string_view text;
  };

  ParseError error(std::size_t line, std::string reason) const {
    return ParseError{path_, line, std::move(reason)};
  }

  std::unexpected<ParseError> fail(std::size_t line, std::string reason) const {
    return std::unexpected(error(line, std::move(reason)));
  }

  std::size_t lastLine() const {
    return std::max<std::size_t>(lines_.size(), 1);
  }

  std::optional<ParseError> frontmatter() {
    static constexpr std::array<std::string_view, 5> known{
        "name", "languages", "mode", "trigger", "layout"};

    std::map<std::string_view, Value> values;
    for (; next_ < lines_.size(); ++next_) {
      const std::string_view line = lines_[next_];
      const std::size_t number = next_ + 1;
      if (line == "---") {
        break;
      }
      if (isBlank(line) || line.starts_with('#')) {
        continue;
      }

      const std::size_t equals = line.find('=');
      const std::string_view key = trim(line.substr(0, equals));
      const bool word = !key.empty() && std::ranges::all_of(key, [](char c) {
        return c >= 'a' && c <= 'z';
      });
      if (equals == std::string_view::npos || !word) {
        return error(number, "expected key = value");
      }
      if (!std::ranges::contains(known, key)) {
        return error(number, "unknown key " + quoted(key));
      }
      if (values.contains(key)) {
        return error(number, "repeated key " + quoted(key));
      }
      const std::string_view value = trim(line.substr(equals + 1));
      if (value.empty()) {
        return error(number, "empty value for " + quoted(key));
      }
      values.emplace(key, Value{number, value});
    }

    if (next_ == lines_.size()) {
      return error(lastLine(), "missing --- after the frontmatter");
    }
    const std::size_t separator = next_ + 1;
    ++next_;

    for (const std::string_view key : {"name", "languages", "mode"}) {
      if (!values.contains(key)) {
        return error(separator, "missing required key " + quoted(key));
      }
    }

    Frontmatter &frontmatter = parsed_.frontmatter;
    frontmatter.name = values.at("name").text;

    const Value languages = values.at("languages");
    for (std::size_t start = 0; start <= languages.text.size();) {
      const std::size_t comma = languages.text.find(',', start);
      const std::size_t end =
          comma == std::string_view::npos ? languages.text.size() : comma;
      const std::string_view tag =
          trim(languages.text.substr(start, end - start));
      if (tag.empty()) {
        return error(languages.line, "empty language tag");
      }
      frontmatter.languages.emplace_back(tag);
      start = end + 1;
    }

    const Value mode = values.at("mode");
    if (mode.text == "command") {
      frontmatter.mode = Mode::command;
    } else if (mode.text == "continuous") {
      frontmatter.mode = Mode::continuous;
    } else {
      return error(mode.line, "mode must be command or continuous, not " +
                                  quoted(mode.text));
    }

    frontmatter.layout = Layout::standard;
    if (const auto layout = values.find("layout"); layout != values.end()) {
      const Value value = layout->second;
      if (value.text == "us") {
        frontmatter.layout = Layout::us;
      } else if (value.text != "default") {
        return error(value.line,
                     "layout must be default or us, not " + quoted(value.text));
      }
    }

    const auto trigger = values.find("trigger");
    if (frontmatter.mode == Mode::continuous) {
      if (trigger != values.end()) {
        return error(trigger->second.line, "trigger is only for command mode");
      }
      return std::nullopt;
    }
    if (trigger == values.end()) {
      return error(separator, "missing required key \"trigger\"");
    }
    const std::string_view text = trigger->second.text;
    const auto decoded = utf8::decode(text, 0);
    if (decoded->length != text.size()) {
      return error(trigger->second.line, "trigger must be one character");
    }
    frontmatter.trigger = decoded->character;
    trigger_ = text;
    return std::nullopt;
  }

  std::optional<ParseError> body() {
    const bool command = parsed_.frontmatter.mode == Mode::command;
    std::set<std::pair<std::string, std::string>> seen;
    std::set<std::string_view> keys;

    for (; next_ < lines_.size(); ++next_) {
      const std::string_view line = lines_[next_];
      const std::size_t number = next_ + 1;
      if (isBlank(line)) {
        continue;
      }

      const std::size_t tab = line.find('\t');
      if (tab == std::string_view::npos) {
        if (line.starts_with('#')) {
          continue;
        }
        return error(number, "expected key<TAB>output");
      }

      const std::string_view key = line.substr(0, tab);
      const std::string_view raw = line.substr(tab + 1);
      if (key.empty()) {
        return error(number, "empty key");
      }
      if (key.contains(' ')) {
        return error(number, "space in key " + quoted(key));
      }
      if (raw.contains('\t')) {
        return error(number, "tab in output; write it as \\t");
      }
      auto output = unescape(raw);
      if (!output) {
        return error(number, output.error());
      }
      if (output->empty()) {
        return error(number, "empty output");
      }

      if (command) {
        if (!key.starts_with(trigger_)) {
          return error(number, "key " + quoted(key) +
                                   " doesn't start with the trigger");
        }
        const std::string_view rest = key.substr(trigger_.size());
        if (rest.empty()) {
          return error(number, "key is only the trigger");
        }
        if (rest.contains(trigger_)) {
          return error(number, "trigger inside key " + quoted(key));
        }
      }

      if (!seen.emplace(key, *output).second) {
        return error(number,
                     "repeated mapping " + quoted(key) + " to " + quoted(raw));
      }
      if (!command && !keys.insert(key).second) {
        return error(number,
                     "repeated key " + quoted(key) + " in continuous mode");
      }
      parsed_.mappings.emplace_back(key, std::move(*output));
    }

    if (parsed_.mappings.empty()) {
      return error(lastLine(), "no mappings");
    }
    return std::nullopt;
  }

  std::string path_;
  std::vector<std::string_view> lines_;
  std::size_t next_ = 0;
  std::string_view trigger_;
  Parsed parsed_;
};

std::vector<char32_t> alphabetOf(const Parsed &parsed) {
  const auto &trigger = parsed.frontmatter.trigger;
  std::vector<char32_t> alphabet;
  for (const auto &[key, output] : parsed.mappings) {
    for (std::size_t offset = 0; offset < key.size();) {
      const utf8::Decoded decoded = *utf8::decode(key, offset);
      if (!(offset == 0 && trigger)) {
        alphabet.push_back(decoded.character);
      }
      offset += decoded.length;
    }
  }
  std::ranges::sort(alphabet);
  const auto duplicates = std::ranges::unique(alphabet);
  alphabet.erase(duplicates.begin(), duplicates.end());
  return alphabet;
}

} // namespace

std::string ParseError::message() const {
  if (line == 0) {
    return path + ": " + reason;
  }
  return path + ":" + std::to_string(line) + ": " + reason;
}

Table::Table(Frontmatter frontmatter, std::vector<char32_t> alphabet,
             std::unique_ptr<Index> index)
    : frontmatter_(std::move(frontmatter)), alphabet_(std::move(alphabet)),
      index_(std::move(index)) {}

Table::Table(Table &&) noexcept = default;
Table &Table::operator=(Table &&) noexcept = default;
Table::~Table() = default;

std::expected<Table, ParseError> Table::parse(std::string_view path,
                                              std::string_view text) {
  auto parsed = Parser(path, text).run();
  if (!parsed) {
    return std::unexpected(parsed.error());
  }

  std::map<std::string, std::vector<std::string>> byKey;
  for (auto &[key, output] : parsed->mappings) {
    byKey[key].push_back(std::move(output));
  }

  auto index = std::make_unique<Index>();
  marisa::Keyset keyset;
  for (const auto &[key, outputs] : byKey) {
    keyset.push_back(key);
  }
  index->trie.build(keyset);

  // MARISA numbers keys in its own order, so each key's ID comes from a
  // lookup.
  index->outputs.resize(byKey.size());
  marisa::Agent agent;
  for (auto &[key, outputs] : byKey) {
    agent.set_query(key);
    index->trie.lookup(agent);
    index->outputs[agent.key().id()] = std::move(outputs);
  }

  std::vector<char32_t> alphabet = alphabetOf(*parsed);
  return Table(std::move(parsed->frontmatter), std::move(alphabet),
               std::move(index));
}

std::expected<Table, ParseError>
Table::load(const std::filesystem::path &path) {
  const auto fail = [&](std::string reason) {
    return std::unexpected(ParseError{path.string(), 0, std::move(reason)});
  };

  std::error_code error;
  const auto status = std::filesystem::status(path, error);
  if (error) {
    return fail(error.message());
  }
  if (!std::filesystem::is_regular_file(status)) {
    return fail("not a regular file");
  }

  std::ifstream file(path, std::ios::binary);
  const std::string text{std::istreambuf_iterator<char>(file), {}};
  if (!file.is_open() || file.bad()) {
    return fail("can't read the file");
  }
  return parse(path.string(), text);
}

const Frontmatter &Table::frontmatter() const { return frontmatter_; }

bool Table::inAlphabet(char32_t c) const {
  return std::ranges::binary_search(alphabet_, c);
}

std::span<const std::string> Table::exact(std::string_view key) const {
  marisa::Agent agent;
  agent.set_query(key);
  if (!index_->trie.lookup(agent)) {
    return {};
  }
  return index_->outputs[agent.key().id()];
}

std::vector<Candidate> Table::completions(std::string_view prefix) const {
  struct Match {
    std::size_t length;
    std::string key;
    std::size_t id;
  };

  // The agent's key is overwritten by each step of the search, so every
  // match copies it.
  std::vector<Match> matches;
  marisa::Agent agent;
  agent.set_query(prefix);
  while (index_->trie.predictive_search(agent)) {
    const marisa::Key &key = agent.key();
    matches.push_back(
        {utf8::length(key.str()), std::string(key.str()), key.id()});
  }

  // std::string compares bytes as unsigned, which for UTF-8 is code point
  // order.
  std::ranges::sort(matches, [](const Match &a, const Match &b) {
    return std::tie(a.length, a.key) < std::tie(b.length, b.key);
  });

  std::vector<Candidate> candidates;
  for (const Match &match : matches) {
    for (const std::string &output : index_->outputs[match.id]) {
      candidates.push_back({match.key, output});
    }
  }
  return candidates;
}

bool Table::extendable(std::string_view prefix) const {
  marisa::Agent agent;
  agent.set_query(prefix);
  while (index_->trie.predictive_search(agent)) {
    if (agent.key().length() > prefix.size()) {
      return true;
    }
  }
  return false;
}

std::optional<std::pair<std::size_t, std::string_view>>
Table::longestPrefix(std::string_view text) const {
  // Matches come shortest first.
  std::optional<std::pair<std::size_t, std::string_view>> longest;
  marisa::Agent agent;
  agent.set_query(text);
  while (index_->trie.common_prefix_search(agent)) {
    const marisa::Key &key = agent.key();
    longest.emplace(key.length(), index_->outputs[key.id()].front());
  }
  return longest;
}

} // namespace ibusweb::table
