// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
export const IBusAttrType = { Underline: 1, Foreground: 2, Background: 3, Hint: 4 } as const;
export const IBusOrientation = { Horizontal: 0, Vertical: 1, System: 2 } as const;
export const IBusPropType = { Normal: 0, Toggle: 1, Radio: 2, Menu: 3, Separator: 4 } as const;
export const IBusPropState = { Unchecked: 0, Checked: 1, Inconsistent: 2 } as const;
export const IBusPreeditFocusMode = { Clear: 0, Commit: 1 } as const;
