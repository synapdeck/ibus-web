// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { PanelAction } from "@ibus-web/protocol";

export type { PanelAction, PanelRecord, PanelUpdate } from "@ibus-web/protocol";

export interface CaretRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Public facade contract. All geometry is in viewport CSS pixels.
 * The panel CustomEvent<PanelUpdate> carries records, hides (FocusOut/crash),
 * and caret/orientation snapshot notifications for its engine and input context.
 */
export interface PanelHost extends EventTarget {
  caretRect(): CaretRect | null;
  /** Current org.freedesktop.ibus.panel lookup-table-orientation, resolved to horizontal (0) or vertical (1). */
  lookupTableOrientation(engine: string): 0 | 1;
  sendPanelAction(engine: string, ic: number, action: PanelAction): void;
  /** Reports deferred decoding and callback failures through the facade's normal error channel. Must not throw. */
  reportPanelError(error: unknown): void;
}
