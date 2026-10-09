# @ibus-web/panel

A framework-free candidate and property panel for ibus-web. Its candidate window follows the caret,
shows the engine's lookup table and auxiliary text, and sends clicks, paging and scrolling back to the
engine; its properties element, which the host places in its own UI, opens a menu of the engine's
properties, such as its input modes. Hosts can replace both with their own UI through the same
`PanelHost` contract.

```ts
import { createPanel } from "@ibus-web/panel";
import "@ibus-web/panel/style.css";

// `ibus` is the object createIbusWeb returns; it is a PanelHost.
const panel = createPanel(ibus);
toolbar.append(panel.properties);
```

The stylesheet is separate, and every rule in it can be overridden. Most applications import the
panel through [`ibus-web`](../ibus-web/README.md) as `ibus-web/panel`. Details are in
[docs/panel.md](https://github.com/synapdeck/ibus-web/blob/master/docs/panel.md).

Licensed under MIT OR Apache-2.0, at your option.
