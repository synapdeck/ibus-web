// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The contract between the Worker host and a JavaScript module script's default export, and the few IBus constants a
// script needs beside it. A script that imports this file must pull nothing else into its bundle, so it imports
// nothing.

/** The version of this contract, which a script's `ibusWebModule` and its manifest's `moduleAbi` both state. */
export const MODULE_ABI = 1;

/** The `IBusModifierType` bits a key's `state` holds. */
export const Modifier = {
  SHIFT: 1 << 0,
  LOCK: 1 << 1,
  CONTROL: 1 << 2,
  MOD1: 1 << 3,
  MOD2: 1 << 4,
  MOD3: 1 << 5,
  MOD4: 1 << 6,
  MOD5: 1 << 7,
  SUPER: 1 << 26,
  HYPER: 1 << 27,
  META: 1 << 28,
  /** Set on a key's release rather than its press. */
  RELEASE: 1 << 30,
} as const;

/** `IBusAttrUnderline`, an underline attribute's `value`. */
export const Underline = { NONE: 0, SINGLE: 1, DOUBLE: 2, LOW: 3, ERROR: 4 } as const;

/** `IBusAttrPreedit`, a hint attribute's `value`. */
export const PreeditHint = {
  DEFAULT: 0,
  WHOLE: 1,
  SELECTION: 2,
  PREDICTION: 3,
  PREFIX: 4,
  SUFFIX: 5,
  ERROR_SPELLING: 6,
  ERROR_COMPOSE: 7,
  NONE: 256,
} as const;

/** `IBusInputPurpose`, a `SetContentType` request's `purpose`. */
export const InputPurpose = {
  FREE_FORM: 0,
  ALPHA: 1,
  DIGITS: 2,
  NUMBER: 3,
  PHONE: 4,
  URL: 5,
  EMAIL: 6,
  NAME: 7,
  PASSWORD: 8,
  PIN: 9,
  TERMINAL: 10,
  DATE: 11,
  TIME: 12,
  DATETIME: 13,
} as const;

/** `IBusInputHints`, the flags of a `SetContentType` request's `hints`. */
export const InputHints = {
  NONE: 0,
  SPELLCHECK: 1,
  NO_SPELLCHECK: 2,
  WORD_COMPLETION: 4,
  LOWERCASE: 8,
  UPPERCASE_CHARS: 16,
  UPPERCASE_WORDS: 32,
  UPPERCASE_SENTENCES: 64,
  INHIBIT_OSK: 128,
  VERTICAL_WRITING: 256,
  EMOJI: 512,
  NO_EMOJI: 1024,
  PRIVATE: 2048,
  HIDDEN_TEXT: 4096,
  LATIN: 8192,
  MULTILINE: 16384,
} as const;

/** What a `TextAttribute` decorates. */
export const attributeTypes = ["underline", "foreground", "background", "hint"] as const;

export const propertyKinds = ["normal", "toggle", "radio", "menu", "separator"] as const;

export const propertyStates = ["unchecked", "checked", "inconsistent"] as const;

export const logLevels = ["debug", "info", "warning", "error"] as const;

/** A module script's default export. */
export interface ModuleScript {
  readonly ibusWebModule: typeof MODULE_ABI;
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /**
   * The start of each engine's settings schema id, `<settingsPrefix>.<engine>`, whose components joined by `/` are its
   * path: dot-separated components of letters, digits, `_` and `-`. Required when any engine declares settings.
   */
  readonly settingsPrefix?: string;
  /**
   * Engines by IBus engine name, in the manifest's order; the first is the module's default. No name may be an array
   * index such as `"1"`, which an object enumerates before its other keys.
   */
  readonly engines: Readonly<Record<string, ModuleEngine>>;
  /** Writes what the module keeps in memory to storage, since the page may end the Worker next. */
  persist?(): void;
  /** Releases what the module holds; no request reaches an engine afterwards. */
  shutdown?(): void;
}

/** The manifest's `EngineDescriptor` for an engine, but its name. */
export interface ModuleEngineDescriptor {
  readonly displayName: string;
  readonly languages: readonly string[];
  readonly keyboard: { readonly layout: "us" | "default"; readonly passThrough: readonly string[] };
}

export interface ModuleEngine {
  readonly descriptor: ModuleEngineDescriptor;
  /** The keys of the engine's settings schema, by GSettings key name. */
  readonly settings?: Readonly<Record<string, SettingDeclaration>>;
  /** Makes a session for one input context. A throw fails the `CreateEngine` with the error's message. */
  create(context: EngineContext): EngineSession;
}

/** A GVariant type a setting can have: boolean, string, 32-bit integer, double and array of strings. */
export type SettingType = "b" | "s" | "i" | "d" | "as";

export type SettingValue = boolean | string | number | readonly string[];

interface SettingText {
  readonly summary?: string;
  readonly description?: string;
}

/** An inclusive range. */
export interface SettingRange {
  readonly min: number;
  readonly max: number;
}

export type SettingDeclaration =
  | (SettingText & { readonly type: "b"; readonly default: boolean })
  | (SettingText & { readonly type: "s"; readonly default: string; readonly choices?: readonly string[] })
  | (SettingText & { readonly type: "i" | "d"; readonly default: number; readonly range?: SettingRange })
  | (SettingText & { readonly type: "as"; readonly default: readonly string[] });

/**
 * The output calls, settings, timers and log a session writes to. Each output call queues one record for the request
 * being served, in call order. Calls on the context of a destroyed session are ignored. Text holding a NUL or a lone
 * surrogate, which no record can carry, throws, but in `log`, whose message has each replaced with U+FFFD.
 */
export interface EngineContext {
  commit(text: RichText): void;
  /** Shows or hides the preedit, with its cursor in code points. */
  preedit(text: RichText, cursor: number, visible: boolean, mode: PreeditMode): void;
  auxiliary(text: RichText, visible: boolean): void;
  /** Shows or hides one page of candidates, the page the panel displays. */
  lookupTable(page: CandidatePage, visible: boolean): void;
  /** Declares the session's properties, replacing any it declared before. */
  registerProperties(properties: readonly Property[]): void;
  /** Replaces the registered property with the same key. */
  updateProperty(property: Property): void;
  forwardKey(keyval: number, keycode: number, state: number): void;
  /** Deletes `count` code points of the client's text, from `offset` code points after the cursor. */
  deleteSurrounding(offset: number, count: number): void;
  requireSurrounding(): void;
  readonly settings: EngineSettings;
  /**
   * Runs `fn` once, `ms` milliseconds from now, from the host's pump rather than the event loop, which never runs
   * while a module is serving. Returns a function that cancels it, which does nothing once it has run.
   */
  after(ms: number, fn: () => void): () => void;
  log(level: LogLevel, message: string): void;
}

/** The engine's own settings, as the host stores them. */
export interface EngineSettings {
  /** Throws for a key the engine doesn't declare. */
  get(key: string): SettingValue;
  /**
   * Stores a value and has the page persist it. Throws for a key the engine doesn't declare or a value outside its
   * type, range or choices.
   */
  set(key: string, value: SettingValue): void;
}

export type PreeditMode = "clear" | "commit";

export type LogLevel = (typeof logLevels)[number];

/** Text, plain or with attributes. */
export type RichText = string | StyledText;

export interface StyledText {
  readonly text: string;
  readonly attributes: readonly TextAttribute[];
}

/**
 * A decoration of the code points from `start` up to `end`. `value` is an `IBusAttrUnderline` for an underline, a
 * 0xRRGGBB color for a foreground or background, and an `IBusAttrPreedit` for a hint.
 */
export interface TextAttribute {
  readonly type: (typeof attributeTypes)[number];
  readonly value: number;
  readonly start: number;
  readonly end: number;
}

/** One page of candidates; IBus's own panels show at most 16 a page. */
export interface CandidatePage {
  readonly candidates: readonly RichText[];
  /** One for each candidate; without them the panel numbers the candidates. */
  readonly labels?: readonly RichText[];
  /** The cursor's index in `candidates`, 0 for an empty page; `lookupTable` throws for one off the page. */
  readonly cursor: number;
  readonly cursorVisible: boolean;
  /** Defaults to `system`. */
  readonly orientation?: "horizontal" | "vertical" | "system";
}

export type PropertyKind = (typeof propertyKinds)[number];

export type PropertyState = (typeof propertyStates)[number];

/** An `IBusProperty`. Unset, it is sensitive, visible and unchecked, with no symbol, tooltip, icon or children. */
export interface Property {
  readonly key: string;
  readonly kind: PropertyKind;
  readonly label: RichText;
  readonly symbol?: RichText;
  readonly tooltip?: RichText;
  readonly icon?: string;
  readonly sensitive?: boolean;
  readonly visible?: boolean;
  readonly state?: PropertyState;
  /** A menu's items. */
  readonly children?: readonly Property[];
}

/**
 * An engine's handlers for one input context's requests. A handler the session leaves out does nothing, and without
 * `processKey` no key is consumed. A throw from any handler is a fault that ends the module.
 */
export interface EngineSession {
  /**
   * Returns whether the engine consumed the key. `state` holds IBus's modifier and release bits; `character` is the
   * text the key's keyval stands for, as `ibus_keyval_to_unicode()` gives it, or empty for one that stands for none or
   * for a control character, as BackSpace's and Return's are.
   */
  processKey?(keyval: number, keycode: number, state: number, character: string): boolean;
  focusIn?(): void;
  focusOut?(): void;
  reset?(): void;
  enable?(): void;
  disable?(): void;
  setCursorLocation?(x: number, y: number, width: number, height: number): void;
  /** `capabilities` holds `IBusCapabilite` flags. */
  setCapabilities?(capabilities: number): void;
  pageUp?(): void;
  pageDown?(): void;
  cursorUp?(): void;
  cursorDown?(): void;
  /** `index` is the candidate's position on the visible page. */
  candidateClicked?(index: number, button: number, state: number): void;
  propertyActivate?(key: string, state: PropertyState): void;
  /** `cursor` and `anchor` count code points of `text`. */
  setSurroundingText?(text: string, cursor: number, anchor: number): void;
  /** `purpose` is an `IBusInputPurpose`, `hints` holds `IBusInputHints` flags. */
  setContentType?(purpose: number, hints: number): void;
  /**
   * Called in every session of the engine, the writer's included, when a key's stored value changes: at once for a
   * change from the page, and for a session's `settings.set` once the call that set it has returned.
   */
  settingChanged?(key: string, value: SettingValue): void;
  destroy?(): void;
}
