// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  SetCursorLocation,
  SetSurroundingText,
  type DecodedLazyRecord,
  type PanelEvent,
  type Request,
} from "@ibus-web/protocol";
import type { KeyContext } from "./keystroke.ts";
import type { SurfaceAdapter } from "./replay.ts";
import { PreeditState } from "./preedit.ts";
import { deletion, ibusText, surroundingWindow, type Surrounding } from "./surrounding.ts";
export class InputContext implements KeyContext {
  readonly ic: number;
  readonly engine: string;
  generation: number;
  ready = false;
  acceptOutput = false;
  created = false;
  focused = false;
  enabled = false;
  readonly adapter: SurfaceAdapter;
  readonly preedit = new PreeditState();
  unregister: () => void = () => {};
  private surrounding: Surrounding | undefined;
  private rect: string | undefined;
  private readonly current: () => boolean;
  private readonly refresh: () => void;
  private readonly panel: (event: PanelEvent) => void;
  constructor(options: {
    ic: number;
    engine: string;
    generation: number;
    adapter: SurfaceAdapter;
    current: () => boolean;
    refresh: () => void;
    panel: (event: PanelEvent) => void;
  }) {
    this.ic = options.ic;
    this.engine = options.engine;
    this.generation = options.generation;
    this.current = options.current;
    this.refresh = options.refresh;
    this.panel = options.panel;
    this.adapter = options.adapter;
  }
  apply({ record }: DecodedLazyRecord): void {
    if (!this.current()) return;
    switch (record._tag) {
      case "CommitText":
        this.adapter.commit(record.text.text);
        this.preedit.clear();
        this.adapter.setPreedit(undefined);
        break;
      case "UpdatePreeditText":
        this.preedit.update(record, this.adapter);
        break;
      case "ShowPreeditText":
        this.preedit.show(true, this.adapter);
        break;
      case "HidePreeditText":
        this.preedit.show(false, this.adapter);
        break;
      case "DeleteSurroundingText": {
        const value = this.adapter.surrounding(Number.MAX_SAFE_INTEGER);
        if (value) {
          const span = deletion(value, record.offset, record.count);
          this.adapter.deleteSurrounding(span.offset, span.count);
        }
        break;
      }
      case "ForwardKeyEvent":
        this.adapter.forwardKey(record);
        break;
      case "RequireSurroundingText":
        break;
      case "UpdateAuxiliaryText":
      case "ShowAuxiliaryText":
      case "HideAuxiliaryText":
      case "UpdateLookupTable":
      case "ShowLookupTable":
      case "HideLookupTable":
      case "RegisterProperties":
      case "UpdateProperty":
        this.panel({ _tag: "record", engine: this.engine, ic: this.ic, record });
        break;
    }
    this.refresh();
  }
  consumed(): void {
    this.refresh();
  }
  invalidate(): void {
    this.ready = false;
    this.acceptOutput = false;
    this.created = false;
    this.focused = false;
    this.enabled = false;
    this.preedit.clear();
    this.surrounding = undefined;
    this.rect = undefined;
  }
  finish(): void {
    this.adapter.batch(() => this.preedit.finish(this.adapter));
    this.refresh();
  }
  updates(window: number): Request[] {
    const requests: Request[] = [];
    const value = this.adapter.capabilities().surroundingText ? this.adapter.surrounding(window) : undefined;
    if (value) {
      const next = surroundingWindow(value, window),
        previous = this.surrounding;
      if (
        !previous ||
        next.text !== previous.text ||
        next.cursor !== previous.cursor ||
        next.anchor !== previous.anchor
      ) {
        this.surrounding = next;
        requests.push(new SetSurroundingText({ ...next, text: ibusText(next.text) }));
      }
    }
    const rect = this.adapter.caretRect();
    if (rect) {
      const value = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      const key = JSON.stringify(value);
      if (key !== this.rect) {
        this.rect = key;
        this.panel({ _tag: "caret", engine: this.engine, ic: this.ic });
        requests.push(new SetCursorLocation(value));
      }
    }
    return requests;
  }
}
