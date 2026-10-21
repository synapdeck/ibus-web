---
---

Build Mozc's build-machine tools on macOS. `system_util.cc` includes `mac_util.h` wherever `__APPLE__` is defined, but
the WebAssembly build's selections leave the Objective-C `mac_util` out of those tools, and the build has no Apple
toolchain to compile it. A port patch gives them the part of `MacUtil` they use in C++. The engine's WebAssembly output
doesn't change.
