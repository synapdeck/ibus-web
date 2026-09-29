project('meson-consumer', 'c')

executable(
  'consumer',
  'main.c',
  dependencies: [dependency('zlib'), dependency('libffi')],
  # A threaded program keeps its runtime alive after main returns, and
  # stdout is only flushed when the runtime exits.
  link_args: ['-sEXIT_RUNTIME=1'],
  name_suffix: 'js',
)
