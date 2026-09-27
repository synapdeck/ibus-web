#include <stdexcept>

extern "C" int probe() { throw std::runtime_error("thrown in side module"); }
