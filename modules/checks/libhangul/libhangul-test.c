/* 2-set keys g, k, s compose to the syllable 한 (U+D55C). Built without
 * external keyboards, libhangul needs no hangul_init(): keyboard lookup falls
 * back to the built-in tables. */
#include <hangul.h>
#include <stdio.h>

int main(void) {
  HangulInputContext *hic = hangul_ic_new("2");
  if (hic == NULL) {
    puts("hangul_ic_new failed");
    return 1;
  }

  hangul_ic_process(hic, 'g');
  hangul_ic_process(hic, 'k');
  hangul_ic_process(hic, 's');

  const ucschar *preedit = hangul_ic_get_preedit_string(hic);
  printf("preedit U+%04X\n", (unsigned)preedit[0]);
  int ok = preedit[0] == 0xD55C && preedit[1] == 0;

  hangul_ic_delete(hic);
  return ok ? 0 : 1;
}
