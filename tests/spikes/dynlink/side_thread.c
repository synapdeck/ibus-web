#include <pthread.h>

static int result;

static void *double_it(void *arg) {
  result = *(int *)arg * 2;
  return NULL;
}

int probe(void) {
  pthread_t thread;
  int input = 21;
  if (pthread_create(&thread, NULL, double_it, &input) != 0)
    return 1;
  if (pthread_join(thread, NULL) != 0)
    return 2;
  return result == 42 ? 0 : 3;
}
