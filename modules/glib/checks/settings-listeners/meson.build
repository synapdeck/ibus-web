# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
project('glib-settings-listeners', 'c', 'cpp')

schemas = import('gnome').compile_schemas()
listeners = executable(
  'settings-listeners',
  'settings-listeners.c',
  dependencies: dependency('gio-2.0'),
  link_language: 'cpp',
)
test(
  'settings-listeners',
  listeners,
  protocol: 'tap',
  env: ['GSETTINGS_SCHEMA_DIR=' + meson.current_build_dir()],
  depends: schemas,
)
