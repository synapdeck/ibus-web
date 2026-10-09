// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: BSD-3-Clause

#include "ibus_web_module/settings.h"

#include <cstdint>
#include <initializer_list>
#include <string>

#include "base/file_util.h"
#include "base/protobuf/text_format.h"
#include "base/system_util.h"
#include "client/client.h"
#include "client/client_interface.h"
#include "protocol/config.pb.h"
#include "unix/ibus/ibus_config.h"
#include "unix/ibus/ibus_config.pb.h"

namespace ibus_web {
namespace {

using ::mozc::config::Config;

// A choice's name in the schema and the config value it stands for.
struct Choice {
  const char *name;
  int value;
};

struct ChoiceKey {
  const char *key;
  std::initializer_list<Choice> choices;
  void (*set)(Config &, int);
};

template <typename Enum, void (Config::*Set)(Enum)>
void SetEnum(Config &config, int value) {
  (config.*Set)(static_cast<Enum>(value));
}

const ChoiceKey kChoiceKeys[] = {
    {"preedit-method",
     {{"romaji", Config::ROMAN}, {"kana", Config::KANA}},
     SetEnum<Config::PreeditMethod, &Config::set_preedit_method>},
    {"session-keymap",
     {{"ms-ime", Config::MSIME},
      {"atok", Config::ATOK},
      {"kotoeri", Config::KOTOERI}},
     SetEnum<Config::SessionKeymap, &Config::set_session_keymap>},
    {"punctuation-method",
     {{"kuten-touten", Config::KUTEN_TOUTEN},
      {"comma-period", Config::COMMA_PERIOD},
      {"kuten-period", Config::KUTEN_PERIOD},
      {"comma-touten", Config::COMMA_TOUTEN}},
     SetEnum<Config::PunctuationMethod, &Config::set_punctuation_method>},
    {"symbol-method",
     {{"corner-bracket-middle-dot", Config::CORNER_BRACKET_MIDDLE_DOT},
      {"square-bracket-slash", Config::SQUARE_BRACKET_SLASH},
      {"corner-bracket-slash", Config::CORNER_BRACKET_SLASH},
      {"square-bracket-middle-dot", Config::SQUARE_BRACKET_MIDDLE_DOT}},
     SetEnum<Config::SymbolMethod, &Config::set_symbol_method>},
    {"space-character-form",
     {{"input-mode", Config::FUNDAMENTAL_INPUT_MODE},
      {"full-width", Config::FUNDAMENTAL_FULL_WIDTH},
      {"half-width", Config::FUNDAMENTAL_HALF_WIDTH}},
     SetEnum<Config::FundamentalCharacterForm,
             &Config::set_space_character_form>},
    {"selection-shortcut",
     {{"none", Config::NO_SHORTCUT},
      {"123456789", Config::SHORTCUT_123456789},
      {"asdfghjkl", Config::SHORTCUT_ASDFGHJKL}},
     SetEnum<Config::SelectionShortcut, &Config::set_selection_shortcut>},
    {"numpad-character-form",
     {{"input-mode", Config::NUMPAD_INPUT_MODE},
      {"full-width", Config::NUMPAD_FULL_WIDTH},
      {"half-width", Config::NUMPAD_HALF_WIDTH},
      {"direct-input", Config::NUMPAD_DIRECT_INPUT}},
     SetEnum<Config::NumpadCharacterForm, &Config::set_numpad_character_form>},
    {"shift-key-mode-switch",
     {{"off", Config::OFF},
      {"ascii", Config::ASCII_INPUT_MODE},
      {"katakana", Config::KATAKANA_INPUT_MODE}},
     SetEnum<Config::ShiftKeyModeSwitch, &Config::set_shift_key_mode_switch>},
    {"yen-sign-character",
     {{"yen-sign", Config::YEN_SIGN}, {"backslash", Config::BACKSLASH}},
     SetEnum<Config::YenSignCharacter, &Config::set_yen_sign_character>},
    {"history-learning-level",
     {{"learn", Config::DEFAULT_HISTORY},
      {"read-only", Config::READ_ONLY},
      {"off", Config::NO_HISTORY}},
     SetEnum<Config::HistoryLearningLevel,
             &Config::set_history_learning_level>},
};

struct BoolKey {
  const char *key;
  void (Config::*set)(bool);
};

const BoolKey kBoolKeys[] = {
    {"use-auto-ime-turn-off", &Config::set_use_auto_ime_turn_off},
    {"use-date-conversion", &Config::set_use_date_conversion},
    {"use-single-kanji-conversion", &Config::set_use_single_kanji_conversion},
    {"use-symbol-conversion", &Config::set_use_symbol_conversion},
    {"use-number-conversion", &Config::set_use_number_conversion},
    {"use-emoticon-conversion", &Config::set_use_emoticon_conversion},
    {"use-emoji-conversion", &Config::set_use_emoji_conversion},
    {"use-calculator", &Config::set_use_calculator},
    {"use-t13n-conversion", &Config::set_use_t13n_conversion},
    {"use-zip-code-conversion", &Config::set_use_zip_code_conversion},
    {"use-spelling-correction", &Config::set_use_spelling_correction},
    {"use-history-suggest", &Config::set_use_history_suggest},
    {"use-dictionary-suggest", &Config::set_use_dictionary_suggest},
    {"use-realtime-conversion", &Config::set_use_realtime_conversion},
    {"incognito-mode", &Config::set_incognito_mode},
};

constexpr char kLaunchKey[] = "active-on-launch";

// Mozc's own name for the file, which it keeps in its profile directory.
constexpr char kIbusConfigFile[] = "ibus_config.textproto";

// Sends the whole config through a client of its own, as Mozc's settings
// tool does, so the converter's sessions take it up.
void Apply(GSettings *settings, mozc::client::ClientInterface &client) {
  Config config;
  if (!client.GetConfig(&config)) {
    g_warning("Mozc's config could not be read; settings are not applied");
    return;
  }

  for (const ChoiceKey &key : kChoiceKeys) {
    gchar *name = g_settings_get_string(settings, key.key);
    for (const Choice &choice : key.choices) {
      if (g_str_equal(name, choice.name)) {
        key.set(config, choice.value);
      }
    }
    g_free(name);
  }
  for (const BoolKey &key : kBoolKeys) {
    (config.*key.set)(g_settings_get_boolean(settings, key.key));
  }
  config.set_suggestions_size(
      static_cast<uint32_t>(g_settings_get_int(settings, "suggestions-size")));

  if (!client.SetConfig(config)) {
    g_warning("Mozc's config could not be written; settings are not applied");
  }
}

void Changed(GSettings *settings, const gchar *key, gpointer data) {
  if (g_str_equal(key, kLaunchKey)) {
    ApplyLaunchSetting(settings);
  } else {
    Apply(settings, *static_cast<mozc::client::ClientInterface *>(data));
  }
}

} // namespace

void FollowSettings(GSettings *settings) {
  // Lives as long as the module, as the handler connected to it does.
  mozc::client::ClientInterface *client =
      mozc::client::ClientFactory::NewClient().release();
  Apply(settings, *client);
  g_signal_connect(settings, "changed", G_CALLBACK(Changed), client);
}

void ApplyLaunchSetting(GSettings *settings) {
  mozc::IbusConfig current;
  current.Initialize();
  const bool active = g_settings_get_boolean(settings, kLaunchKey);
  if (current.GetConfig().active_on_launch() == active) {
    return;
  }

  mozc::ibus::Config config = current.GetConfig();
  config.set_active_on_launch(active);
  std::string text;
  mozc::protobuf::TextFormat::PrintToString(config, &text);
  const std::string path = mozc::FileUtil::JoinPath(
      mozc::SystemUtil::GetUserProfileDirectory(), kIbusConfigFile);
  if (absl::Status status = mozc::FileUtil::SetContents(path, text);
      !status.ok()) {
    g_warning("%s: %s", path.c_str(), std::string(status.message()).c_str());
  }
}

} // namespace ibus_web
