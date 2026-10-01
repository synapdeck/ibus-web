# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: LGPL-2.1-or-later
project(
  'libibus-web',
  'c',
  version: '0.0.0',
  license: 'LGPL-2.1-or-later',
  meson_version: '>= 1.1',
  default_options: ['c_std=c11', 'warning_level=2'],
)

glib = dependency('glib-2.0')
gmodule = dependency('gmodule-2.0')

libibus_web = static_library(
  'ibus-web',
  'src/runtime.c',
  'src/pump.c',
  'src/module.c',
  'src/dispatch.c',
  include_directories: include_directories('include'),
  c_args: '-DG_LOG_DOMAIN="ibus-web"',
  dependencies: [glib, gmodule],
  install: true,
)

install_headers('include/ibus-web/runtime.h', subdir: 'ibus-web')

libibus_web_dep = declare_dependency(
  link_with: libibus_web,
  include_directories: include_directories('include'),
  dependencies: glib,
)

import('pkgconfig').generate(
  libibus_web,
  filebase: 'libibus-web',
  name: 'libibus-web',
  description: 'The C library the ibus-web runtime\'s Worker host drives',
  requires: [glib],
)

if get_option('tests')
  subdir('tests')
endif
