# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
project(
  'ibus-test-native',
  'c',
  default_options: ['c_std=c11', 'warning_level=2', 'werror=true'],
)

gio = dependency('gio-2.0')
json = dependency('json-glib-1.0')
ibus = dependency('ibus-1.0')

values = static_library('values', 'values.c', dependencies: [gio, json])
common = declare_dependency(link_with: values, dependencies: [gio, json])
adapter = executable(
  'ibus-test-native',
  ['main.c', 'driver.c'],
  dependencies: common,
  install: true,
)
fixture = executable('test-engine', 'test-engine.c', dependencies: ibus)

values_test = executable('test-values', 'test-values.c', dependencies: common)
driver_test = executable('test-driver', 'test-driver.c', dependencies: common)
test('values', values_test)
test('driver', driver_test, args: [adapter, fixture], timeout: 30)
