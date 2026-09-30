# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
project('glib-tools-consumer', 'c')

gnome = import('gnome')

generated = gnome.gdbus_codegen(
  'example-counter',
  'example.xml',
  interface_prefix: 'org.example.',
  namespace: 'Example',
  object_manager: true,
)
resources = gnome.compile_resources(
  'example-resources',
  'example.gresource.xml',
  c_name: 'example',
)
marshallers = gnome.genmarshal(
  'example-marshal',
  sources: 'example-marshal.list',
  prefix: 'example_marshal',
)
enums = gnome.mkenums_simple('example-enums', sources: 'example-color.h')
gnome.compile_schemas()

executable(
  'consumer',
  'main.c',
  generated,
  resources,
  marshallers,
  enums,
  dependencies: [dependency('gio-2.0')],
  # The wrapper's -O2 reaches the link too and would turn Emscripten's
  # runtime assertions off.
  link_args: ['-sEXIT_RUNTIME=1', '-sASSERTIONS=1'],
)
