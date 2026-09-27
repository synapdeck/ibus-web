#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

int main() {
  std::vector<std::string> items{"a", "b"};
  try {
    throw std::runtime_error("probe");
  } catch (const std::exception &e) {
    std::printf("%s %zu\n", e.what(), items.size());
  }
  return 0;
}
