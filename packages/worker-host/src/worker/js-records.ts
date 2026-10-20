// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A module script's output calls as the IBus records the page reads for the
// same IBus calls. The contract's indices already count code points, as
// IBusText's do, so they pass through unchanged.

import {
  IBusAttrList,
  IBusAttrType,
  IBusLookupTable,
  IBusOrientation,
  IBusPreeditFocusMode,
  IBusPropList,
  IBusProperty,
  IBusPropState,
  IBusPropType,
  IBusText,
} from "@ibus-web/protocol";
import type {
  CandidatePage,
  LogLevel,
  PreeditMode,
  Property,
  PropertyState,
  RichText,
} from "@ibus-web/protocol/module-script";

const attributeTypes = {
  underline: IBusAttrType.Underline,
  foreground: IBusAttrType.Foreground,
  background: IBusAttrType.Background,
  hint: IBusAttrType.Hint,
} as const;

const orientations = {
  horizontal: IBusOrientation.Horizontal,
  vertical: IBusOrientation.Vertical,
  system: IBusOrientation.System,
} as const;

const propertyKinds = {
  normal: IBusPropType.Normal,
  toggle: IBusPropType.Toggle,
  radio: IBusPropType.Radio,
  menu: IBusPropType.Menu,
  separator: IBusPropType.Separator,
} as const;

const propertyStates = {
  unchecked: IBusPropState.Unchecked,
  checked: IBusPropState.Checked,
  inconsistent: IBusPropState.Inconsistent,
} as const;

const preeditModes = {
  clear: IBusPreeditFocusMode.Clear,
  commit: IBusPreeditFocusMode.Commit,
} as const;

// GLib's level flags. GLib's ERROR is fatal, so a module's error is
// CRITICAL, the most severe level a program survives.
const logLevels = {
  debug: 1 << 7,
  info: 1 << 6,
  warning: 1 << 4,
  error: 1 << 3,
} as const;

// IBusPropState as the contract names it. A state IBus doesn't define
// reads as unchecked, the state a property has unset.
export const propertyState = (state: number): PropertyState =>
  state === IBusPropState.Checked ? "checked" : state === IBusPropState.Inconsistent ? "inconsistent" : "unchecked";

// A value the contract's type rules out, which a script without types can
// still pass.
const lookUp = <T>(table: Readonly<Record<string, T>>, what: string, value: string): T => {
  if (!Object.hasOwn(table, value)) throw new TypeError(`unknown ${what} ${JSON.stringify(value)}`);
  return table[value]!;
};

export const preeditMode = (mode: PreeditMode): number => lookUp(preeditModes, "preedit mode", mode);

export const logLevel = (level: LogLevel): number => lookUp(logLevels, "log level", level);

export const ibusText = (text: RichText): IBusText =>
  IBusText.make({
    attachments: {},
    text: typeof text === "string" ? text : text.text,
    attrs: IBusAttrList.make({
      attachments: {},
      attributes:
        typeof text === "string"
          ? []
          : text.attributes.map(({ type, value, start, end }) => ({
              attachments: {},
              type: lookUp(attributeTypes, "attribute type", type),
              value,
              startIndex: start,
              endIndex: end,
            })),
    }),
  });

// The page as a whole table, so the panel shows exactly it and pages
// nowhere. The panel finds the cursor's candidate and each label by
// position on the page, so a cursor off the page or labels of another
// count would show the wrong ones; an empty page has its cursor at 0.
export const lookupTable = (page: CandidatePage): IBusLookupTable => {
  const count = page.candidates.length;
  const { cursor } = page;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= Math.max(count, 1))
    throw new RangeError(`a candidate page's cursor ${String(cursor)} isn't on its ${count} candidates`);
  if (page.labels !== undefined && page.labels.length !== count)
    throw new RangeError(`a candidate page has ${page.labels.length} labels for its ${count} candidates`);

  return IBusLookupTable.make({
    attachments: {},
    pageSize: page.candidates.length,
    cursorPos: page.cursor,
    cursorVisible: page.cursorVisible,
    round: false,
    orientation: lookUp(orientations, "orientation", page.orientation ?? "system"),
    candidates: page.candidates.map(ibusText),
    labels: (page.labels ?? []).map(ibusText),
  });
};

export const ibusProperty = (property: Property): IBusProperty =>
  IBusProperty.make({
    attachments: {},
    key: property.key,
    type: lookUp(propertyKinds, "property kind", property.kind),
    label: ibusText(property.label),
    icon: property.icon ?? "",
    tooltip: ibusText(property.tooltip ?? ""),
    sensitive: property.sensitive ?? true,
    visible: property.visible ?? true,
    state: lookUp(propertyStates, "property state", property.state ?? "unchecked"),
    subProps: ibusPropList(property.children ?? []),
    symbol: ibusText(property.symbol ?? ""),
  });

export const ibusPropList = (properties: readonly Property[]): IBusPropList =>
  IBusPropList.make({ attachments: {}, properties: properties.map(ibusProperty) });
