# Default panel

`@ibus-web/panel` exports `createPanel(host)` and a disposable `Panel`. Creation
appends its `element` to `document.body`. The panel uses DOM APIs and only the
public `PanelHost` facade contract; hosts may replace it. Import its stylesheet separately:

```ts
import { createIbusWeb } from "ibus-web";
import { createPanel } from "ibus-web/panel";
import "ibus-web/panel/style.css";

const ibus = createIbusWeb({
  runtimeUrl: new URL("/assets/runtime/ibus-runtime.js", location.href),
  modules: { hangul: new URL("/assets/hangul/manifest.json", location.href) },
});
const panel = createPanel(ibus);
// Later: panel.dispose(); await ibus.dispose();
```

The host's `panel` CustomEvents carry a module, input-context ID and a tagged
record, hide, caret or orientation update. The panel ignores stale contexts and
hides output on FocusOut or crash. It decodes only the visible lookup page on a
table update, then waits for the engine to send another table after PageUp or
PageDown. It displays engine labels or position labels `1.`–`9.`, `0.`, `a.`–`f.`,
and highlights the cursor only when the engine marks it visible. Candidate clicks
send the page-relative index; paging buttons send PageUp/PageDown, and wheel motion
sends CursorUp/CursorDown.

The candidate window follows the host's viewport caret rectangle, preferring
below and moving above when space is short. When it fits on neither side, it takes
the side with more room, limits its height to that room and scrolls, so it never
covers the caret's line. It honors horizontal or vertical
table orientation; `System` reads the panel schema's
`lookup-table-orientation` setting. Auxiliary text has its own row. Visible
properties form a menu with toggle/radio state and disabled groups; the compact
indicator uses the first visible toggle/radio symbol. Toggle and radio properties
send `PropertyActivate` only when state changes; Normal actions activate every time.
Pointer interaction keeps focus in the composing field. The stylesheet exposes
`--ibus-panel-*` theme variables;
the panel module itself does not inject CSS. ResizeObserver placement is
coalesced on an owned animation frame to avoid observed WebKit resize feedback;
caret, panel and scroll/viewport event placement remains synchronous.
