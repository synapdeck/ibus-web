// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import type { LazyOutputRecord } from "./lookup.ts";
import { CandidateClicked, CursorDown, CursorUp, PageDown, PageUp, PropertyActivate } from "./requests.ts";

// The requests a candidate or property panel sends its engine.
export const PanelAction = Schema.Union([CandidateClicked, PageUp, PageDown, CursorUp, CursorDown, PropertyActivate]);
export type PanelAction = typeof PanelAction.Type;

// The output records a panel draws.
export type PanelRecord = Extract<
  LazyOutputRecord,
  {
    _tag:
      | "UpdateLookupTable"
      | "ShowLookupTable"
      | "HideLookupTable"
      | "UpdateAuxiliaryText"
      | "ShowAuxiliaryText"
      | "HideAuxiliaryText"
      | "RegisterProperties"
      | "UpdateProperty";
  }
>;

interface PanelContext {
  readonly engine: string;
  readonly ic: number;
}

interface PanelDraw {
  readonly _tag: "record";
  readonly record: PanelRecord;
}

// What the page hears for an engine's input context: a record to draw, or
// that the panel should hide (on focus out or a crash) or follow the caret.
export type PanelEvent = PanelContext & (PanelDraw | { readonly _tag: "hide" | "caret" });

// What a panel hears: the page's events, or that the lookup table's
// orientation setting changed.
export type PanelUpdate = PanelContext & (PanelDraw | { readonly _tag: "hide" | "caret" | "orientation" });
