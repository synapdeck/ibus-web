# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
project('gdbus-codegen-consumer', 'c')

gnome = import('gnome')

generated = gnome.gdbus_codegen(
  'example-counter',
  'example.xml',
  interface_prefix: 'org.example.',
  namespace: 'Example',
  object_manager: true,
)

executable(
  'consumer',
  'main.c',
  generated,
  dependencies: [dependency('gio-2.0')],
  # The wrapper's -O2 reaches the link too and would turn Emscripten's
  # runtime assertions off.
  link_args: ['-sEXIT_RUNTIME=1', '-sASSERTIONS=1'],
)
