# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: LGPL-2.1-or-later

gnome = import('gnome')
ibus_enums = gnome.mkenums(
  'ibusenumtypes',
  sources: files('../../include/ibus-1.0/ibustypes.h', '../../include/ibus-1.0/ibusattribute.h', '../../include/ibus-1.0/ibusobject.h', '../../include/ibus-1.0/ibusproperty.h', '../../include/ibus-1.0/ibusengine.h', '../../include/ibus-1.0/ibuserror.h'),
  identifier_prefix: 'IBus',
  symbol_prefix: 'ibus',
  c_template: 'ibusenumtypes.c.template',
  h_template: 'ibusenumtypes.h.template',
  install_header: true,
  install_dir: get_option('includedir') / 'ibus-1.0',
)
ibus_marshallers = gnome.genmarshal('ibusmarshalers',
  sources: 'ibusmarshalers.list', prefix: '_ibus_marshal', internal: true)

libibus_ibus = static_library(
  'ibus-web-ibus',
  'ibusobject.c', 'ibusserializable.c', 'ibustext.c', 'ibusattribute.c',
  'ibusattrlist.c', 'ibuslookuptable.c', 'ibusproperty.c', 'ibusproplist.c',
  'ibuskeys.c', 'ibuskeyuni.c', 'ibusutil.c', 'ibuserror.c',
  'ibusservice.c', 'ibusengine.c', 'ibusenginesimple.c', 'ibusfactory.c', 'ibuskeymap.c',
  ibus_enums, ibus_marshallers,
  include_directories: [ibus_includes, include_directories('../../include')],
  dependencies: [glib, gobject, gio],
  # Upstream's flags: engines see this layer's warnings under IBus's own
  # log domain, as natively.
  c_args: ['-DIBUS_COMPILATION', '-DG_LOG_DOMAIN="IBUS"',
    '-DIBUS_DISABLE_DEPRECATION_WARNINGS'],
  gnu_symbol_visibility: 'default',
  install: true,
)

install_data('org.freedesktop.ibus.gschema.xml',
  install_dir: get_option('datadir') / 'glib-2.0/schemas')
