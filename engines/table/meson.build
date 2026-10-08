# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
project(
  'ibus-web-table',
  'cpp',
  default_options: ['cpp_std=c++23', 'warning_level=3', 'werror=true'],
)

marisa = dependency('marisa')

engine = static_library(
  'table',
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
