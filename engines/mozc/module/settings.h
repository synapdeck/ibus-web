// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: BSD-3-Clause

// Mozc's settings from the org.freedesktop.ibus.engine.mozc GSettings schema,
// which the page's settings reach. Mozc keeps its own config, so each key is
// applied to the config field it names, which it overrides.

#ifndef IBUS_WEB_MODULE_SETTINGS_H_
#define IBUS_WEB_MODULE_SETTINGS_H_

#include <gio/gio.h>

namespace ibus_web {

// Applies settings to the converter's config now and after every change, so
// call it once the client factory is installed. Mozc's engine reads its
// keymap's turn-on keys when it is made, so call it before making the engine.
void FollowSettings(GSettings *settings);

// Writes active-on-launch into ibus_config.textproto, which Mozc's engine
// reads when it is made: call it before making the engine. FollowSettings
// writes later changes, which take effect when the module next starts.
void ApplyLaunchSetting(GSettings *settings);

} // namespace ibus_web

#endif // IBUS_WEB_MODULE_SETTINGS_H_
