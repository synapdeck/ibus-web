# Recipes written for the native stdenv build unchanged: every build system
# sees Emscripten's tools and this project's code-generation flags, and
# autotools configure scripts run through emconfigure.
export CC=emcc CXX=em++ AR=emar RANLIB=emranlib NM=@nm@
export CFLAGS="@commonFlags@ ${CFLAGS:-}"
export CXXFLAGS="@commonFlags@ ${CXXFLAGS:-}"
export LDFLAGS="-pthread ${LDFLAGS:-}"
# Configure-time test programs become JS and run under Node.
export EMCONFIGURE_JS=2

wasmConfigureSetup() {
  if [ -z "${configureScript:-}" ] && [ -x ./configure ]; then
    configureScript="emconfigure ./configure"
  fi
}
preConfigureHooks+=(wasmConfigureSetup)
