#include <stdexcept>

extern "C" int probe() {
  try {
    throw std::runtime_error("side");
  } catch (const std::exception &) {
    return 0;
  }
}
