project('meson-consumer', 'c')

if host_machine.system() != 'emscripten'
  error('host system is ' + host_machine.system() + ', expected emscripten')
endif
if not meson.can_run_host_binaries()
  error('Meson has no way to run host binaries')
endif

executable(
  'consumer',
  'main.c',
  dependencies: [dependency('zlib'), dependency('libffi')],
  # A threaded program keeps its runtime alive after main returns, and
  # stdout is only flushed when the runtime exits. The wrapper's -O2 reaches
  # the link too and would turn Emscripten's runtime assertions off.
  link_args: ['-sEXIT_RUNTIME=1', '-sASSERTIONS=1'],
)
