/* hangul.h does not bring in a definition of NULL. */
#include <stddef.h>

#include <hangul.h>

int probe(void) {
  HangulInputContext *hic = hangul_ic_new("2");
  if (hic == NULL) return 1;

  hangul_ic_process(hic, 'g');
  hangul_ic_process(hic, 'k');
  hangul_ic_process(hic, 's');
  const ucschar *preedit = hangul_ic_get_preedit_string(hic);
  int ok = preedit[0] == 0xD55C && preedit[1] == 0;

  hangul_ic_delete(hic);
  return ok ? 0 : 2;
}
