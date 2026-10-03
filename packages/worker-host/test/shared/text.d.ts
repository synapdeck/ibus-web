// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The text API the shared tests use, which every environment they run in
// has but the language's own library doesn't declare.
declare class TextDecoder {
  decode(input?: Uint8Array): string;
}
declare class TextEncoder {
  encode(input?: string): Uint8Array<ArrayBuffer>;
}
