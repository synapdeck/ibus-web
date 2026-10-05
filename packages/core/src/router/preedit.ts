// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { UpdatePreeditText } from "@ibus-web/protocol";
import type { Preedit, SurfaceAdapter } from "./replay.ts";
import { toUtf16 } from "./surrounding.ts";
export class PreeditState {
  private value: Preedit | undefined;
  private visible = false;
  private mode = 0;
  update(record: UpdatePreeditText, adapter: SurfaceAdapter): void {
    this.value = {
      text: record.text.text,
      cursor: toUtf16(record.text.text, record.cursor),
      attributes: record.text.attrs.attributes.map((attribute) => ({
        type: attribute.type,
        value: attribute.value,
        start: toUtf16(record.text.text, attribute.startIndex),
        end: toUtf16(record.text.text, attribute.endIndex),
      })),
    };
    this.mode = record.mode;
    this.show(record.visible, adapter);
  }
  show(visible: boolean, adapter: SurfaceAdapter): void {
    this.visible = visible;
    adapter.setPreedit(visible ? this.value : undefined);
  }
  finish(adapter: SurfaceAdapter): void {
    const commit = this.visible && this.mode === 1 ? this.value?.text : undefined;
    this.clear();
    if (commit) adapter.commit(commit);
    adapter.setPreedit(undefined);
  }
  clear(): void {
    this.value = undefined;
    this.visible = false;
    this.mode = 0;
  }
}
