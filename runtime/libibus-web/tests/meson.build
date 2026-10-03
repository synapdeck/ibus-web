# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: LGPL-2.1-or-later

# Side modules take GLib's symbols from the main module that loads them;
# linking GLib in again would give them a second copy.
side_module_deps = [
  glib.partial_dependency(compile_args: true, includes: true),
]

side_modules = []
foreach name : ['test-side', 'test-side-bare']
  side_modules += shared_module(
    name,
    name + '.c',
    name_prefix: '',
    name_suffix: 'wasm',
    include_directories: include_directories('../include'),
    dependencies: side_module_deps,
    link_args: get_option('test_side_module_link_args'),
  )
endforeach

test_runtime = executable(
  'test-runtime',
  'test-runtime.c',
  'throwing-op.cpp',
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
  depends: side_modules,
)

test_install = executable(
  'test-install',
  'test-install.c',
  dependencies: libibus_web_dep,
  link_args: get_option('test_main_link_args'),
)

install_env = environment()
install_env.set('IBUSWEB_TEST_ARCHIVES', get_option('test_archives'))

test('install', test_install, protocol: 'tap', env: install_env)

test_serializable = executable(
  'test-serializable',
  'test-serializable.c',
  dependencies: libibus_web_dep,
  link_args: get_option('test_main_link_args'),
)
test('serializable', test_serializable, protocol: 'tap')

test_engine = executable(
  'test-engine',
  'test-engine.c',
  dependencies: libibus_web_dep,
  link_args: get_option('test_main_link_args'),
)
test('engine', test_engine, protocol: 'tap')
