# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: LGPL-2.1-or-later
project(
  'libibus-web',
  'c',
  'cpp',
  version: '0.0.0',
  license: 'LGPL-2.1-or-later',
  meson_version: '>= 1.1',
  default_options: ['c_std=c11', 'cpp_std=c++17', 'warning_level=2'],
)

glib = dependency('glib-2.0')
# gmodule-2.0 links its users with --export-dynamic, which would export every
# symbol of the runtime past its export list.
gmodule = dependency('gmodule-no-export-2.0')

gobject = dependency('gobject-2.0')
gio = dependency('gio-2.0')
ibus_includes = include_directories('include/ibus-1.0', 'src/ibus')
subdir('src/ibus')

libibus_web = static_library(
  'ibus-web',
  'src/runtime.c',
  'src/settings.c',
  'src/output.c',
  'src/pump.c',
  'src/module.c',
  'src/test-dispatch.c',
  'src/dispatch.c',
  'src/log.c',
  'src/call-op.cpp',
  'src/install.c',
  include_directories: [include_directories('include'), ibus_includes],
  c_args: ['-DG_LOG_DOMAIN="ibus-web"'] + (get_option('tests') ? ['-DIBUSWEB_TESTS'] : []),
  cpp_args: '-DG_LOG_DOMAIN="ibus-web"',
  gnu_symbol_visibility: 'hidden',
  dependencies: [glib, gmodule, gobject, gio],
  install: true,
)

install_headers('include/ibus-web/runtime.h', 'include/ibus-web/protocol.h', subdir: 'ibus-web')

libibus_web_dep = declare_dependency(
  link_with: [libibus_web, libibus_ibus],
  include_directories: [include_directories('include'), ibus_includes],
  dependencies: [glib, gobject, gio],
  sources: ibus_enums[1],
)

import('pkgconfig').generate(
  libibus_web,
  filebase: 'libibus-web',
  name: 'libibus-web',
  description: 'The C library the ibus-web runtime\'s Worker host drives',
  libraries: libibus_ibus,
  requires: [glib, gobject, gio],
)

# Engines compile against IBus headers but resolve symbols from the main
# module. This .pc must not link a second IBus implementation.
ibus_version_parts = []
foreach part : ['MAJOR', 'MINOR', 'MICRO']
  ibus_version_parts += meson.get_compiler('c').get_define(
    'IBUS_' + part + '_VERSION',
    prefix: '#include <ibusversion.h>',
    include_directories: ibus_includes,
    dependencies: glib,
  ).strip('()')
endforeach
ibus_version = '.'.join(ibus_version_parts)
import('pkgconfig').generate(
  filebase: 'ibus-1.0',
  name: 'IBus',
  description: 'IBus headers provided by the ibus-web runtime',
  version: ibus_version,
  subdirs: 'ibus-1.0',
  requires: [glib, gobject, gio],
)
install_subdir('include/ibus-1.0', install_dir: get_option('includedir'))

if get_option('tests')
  subdir('tests')
endif
