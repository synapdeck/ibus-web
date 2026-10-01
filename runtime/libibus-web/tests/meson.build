# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: LGPL-2.1-or-later

# A main module links with the C++ driver: it carries the C++ runtime that
# C++ side modules expect from it.
add_languages('cpp', native: false)

# Side modules take GLib's symbols from the main module that loads them;
# linking GLib in again would give them a second copy.
side_module_deps = [
  glib.partial_dependency(compile_args: true, includes: true),
]

test_side = shared_module(
  'test-side',
  'test-side.c',
  name_prefix: '',
  name_suffix: 'wasm',
  include_directories: include_directories('../include'),
  dependencies: side_module_deps,
  link_args: get_option('test_side_module_link_args'),
)

test_runtime = executable(
  'test-runtime',
  'test-runtime.c',
  'main-module.cpp',
  dependencies: libibus_web_dep,
  link_args: get_option('test_main_link_args'),
)

test_env = environment()
test_env.set('G_TEST_SRCDIR', meson.current_source_dir())
test_env.set('G_TEST_BUILDDIR', meson.current_build_dir())

test(
  'runtime',
  test_runtime,
  protocol: 'tap',
  env: test_env,
  depends: test_side,
)
