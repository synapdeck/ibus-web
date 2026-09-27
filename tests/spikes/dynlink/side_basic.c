#include <stdio.h>
#include <string.h>

int probe(void) {
  char buffer[16];
  snprintf(buffer, sizeof buffer, "%d", 40 + 2);
  return strcmp(buffer, "42") == 0 ? 0 : 1;
}
