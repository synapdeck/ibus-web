// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
export type NativeInput = HTMLInputElement | HTMLTextAreaElement;
interface EditState {
  value: string;
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}
const snapshot = (element: NativeInput): EditState => ({
  value: element.value,
  start: element.selectionStart ?? element.value.length,
  end: element.selectionEnd ?? element.value.length,
  direction: element.selectionDirection ?? "none",
});

// Replaces the one span where element's value differs from value, so the
// rest of the field, and its selection, is left as it is.
const finish = (element: NativeInput, value: string) => {
  const now = element.value;
  let prefix = 0;
  while (prefix < now.length && prefix < value.length && now[prefix] === value[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < now.length - prefix &&
    suffix < value.length - prefix &&
    now[now.length - 1 - suffix] === value[value.length - 1 - suffix]
  )
    suffix++;
  if (element.selectionStart === null) element.value = value;
  else element.setRangeText(value.slice(prefix, value.length - suffix), prefix, now.length - suffix, "end");
};

/** Defer reply edits so deletion and commit share one native history entry. */
export function nativeEdits(element: NativeInput) {
  let pending: EditState | undefined;
  let base: EditState | undefined;
  let depth = 0;
  let affected: { start: number; end: number } | undefined;
  let originalLength = 0;
  const current = () => pending ?? snapshot(element);
  const apply = (before: EditState, after: EditState, range: { start: number; end: number } | undefined) => {
    if (!range) {
      if (element.selectionStart !== null) element.setSelectionRange(after.start, after.end, after.direction);
      return;
    }
    const { start, end } = range;
    const text = after.value.slice(start, end + after.value.length - before.value.length);
    if (!text && start === end) {
      if (element.selectionStart !== null) element.setSelectionRange(after.start, after.end, after.direction);
      return;
    }
    const document = element.ownerDocument;
    let native = false;
    if (
      document.activeElement === element &&
      element.selectionStart !== null &&
      typeof document.execCommand === "function"
    ) {
      element.setSelectionRange(start, end);
      try {
        native = document.execCommand(text ? "insertText" : "delete", false, text);
      } catch {
        /* Unsupported editing commands use the fallback. */
      }
    }
    // WebKit's native delete keeps a textarea's trailing line break when the
    // selection takes it in, so a command can report success short of the
    // edit; what it left undone is finished by hand.
    const complete = native && element.value === after.value;
    if (native && !complete) finish(element, after.value);
    else if (!native) {
      if (element.selectionStart === null) element.value = after.value;
      else element.setRangeText(text, start, end, "end");
    }
    if (element.selectionStart !== null) element.setSelectionRange(after.start, after.end, after.direction);
    if (!complete)
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: text ? "insertText" : "deleteContentBackward",
          data: text || null,
        }),
      );
  };
  return {
    current,
    batch(run: () => void) {
      if (depth++ === 0) {
        base = snapshot(element);
        pending = base;
        originalLength = base.value.length;
        affected = undefined;
      }
      try {
        run();
      } finally {
        if (--depth === 0) {
          const after = pending!;
          pending = undefined;
          apply(base!, after, affected);
        }
      }
    },
    /**
     * Run a native editing command against the live control. Inside a batch, the edits so far are applied first
     * and the batch continues from whatever value and selection the command leaves.
     */
    native<A>(command: () => A): A {
      if (!depth) return command();
      apply(base!, pending!, affected);
      try {
        return command();
      } finally {
        base = snapshot(element);
        pending = base;
        originalLength = base.value.length;
        affected = undefined;
      }
    },
    replace(text: string, start: number, end: number, preserve = false) {
      const before = current();
      const delta = text.length - (end - start);
      const preservePosition = (offset: number, isEnd: boolean) =>
        offset > end ? offset + delta : offset > start ? start + (isEnd ? text.length : 0) : offset;
      const after = {
        value: before.value.slice(0, start) + text + before.value.slice(end),
        start: preserve ? preservePosition(before.start, false) : start + text.length,
        end: preserve ? preservePosition(before.end, true) : start + text.length,
        direction: before.direction,
      };
      if (depth) {
        // Everything outside this union is unchanged, even when earlier edits shift later offsets.
        affected = {
          start: Math.min(affected?.start ?? start, start),
          end: Math.max(affected?.end ?? 0, end - (before.value.length - originalLength)),
        };
        pending = after;
      } else apply(before, after, { start, end });
    },
    select(start: number, end: number, direction: "forward" | "backward") {
      if (pending) pending = { ...pending, start, end, direction };
      else if (element.selectionStart !== null) element.setSelectionRange(start, end, direction);
    },
  };
}
