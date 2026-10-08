# @ibus-web/panel

A framework-free candidate and property panel for ibus-web. It follows the caret, shows the
engine's lookup table, auxiliary text and properties, and sends clicks, paging and scrolling
back to the engine. Hosts can replace it with their own UI through the same `PanelHost` contract.

```ts
import { createPanel } from "@ibus-web/panel";
import "@ibus-web/panel/style.css";

// `ibus` is the object createIbusWeb returns; it is a PanelHost.
const panel = createPanel(ibus);
document.body.append(panel.element);
```

The stylesheet is separate, and every rule in it can be overridden. Most applications import the
panel through [`ibus-web`](../ibus-web/README.md) as `ibus-web/panel`. Details are in
[docs/panel.md](https://github.com/synapdeck/ibus-web/blob/master/docs/panel.md).

Licensed under MIT OR Apache-2.0, at your option.
