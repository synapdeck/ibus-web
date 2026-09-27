#include <stdexcept>
#include <string>

extern "C" int probe() {
  try {
    throw std::runtime_error("inside");
  } catch (const std::runtime_error &e) {
    return std::string(e.what()) == "inside" ? 0 : 1;
  }
}
