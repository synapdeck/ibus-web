# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
project(
  'ibus-web-table',
  'cpp',
  meson_version: '>= 1.1',
  default_options: ['cpp_std=c++23', 'warning_level=3', 'werror=true'],
)

marisa = dependency('marisa')

engine = static_library(
  'table',
  'src/command.cpp',
  'src/continuous.cpp',
  'src/session.cpp',
  'src/table.cpp',
  'src/utf8.cpp',
  dependencies: marisa,
)

executable('table-check', 'native/check.cpp', link_with: engine, install: true)
executable(
  'table-describe',
  'native/describe.cpp',
  link_with: engine,
  install: true,
)

if get_option('tests')
  gtest = dependency('gtest', main: true)
  golden = executable(
    'golden',
    'checks/golden/golden.cpp',
    link_with: engine,
    dependencies: gtest,
  )
  test(
    'golden',
    golden,
    env: {
      'IBUS_WEB_XSAMPA_TABLE': meson.current_source_dir() / 'tables' / 'xsampa.table',
    },
  )
endif
