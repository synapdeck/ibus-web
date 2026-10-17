// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the page asks the storage Worker, which reads and resets modules'
// databases for it: the page opens no transaction on them itself, since one
// it hadn't seen commit when a key's wait began would hold up the host's
// writes until the wait ended. One request a Worker, each answered once.

// One module's databases, by their names, as naming.ts gives them.
export interface ModuleDatabases {
  // Its own files, the user data.
  user: string;
  // Its version's data, and the version, which the data's marker names.
  data: string;
  version: string;
  // The store paths of the engines' own data, whose markers say whether
  // each is installed.
  paths: string[];
  // What every version's data database is named, the encoded version
  // following it, so that the versions still stored are found by name.
  dataPrefix: string;
}

export type StorageRequest =
  | { type: "usage"; modules: ModuleDatabases[] }
  // A tar of the user data, from one read-only transaction.
  | { type: "export"; database: string }
  // Deletes the user data, waiting at most limitMs while connections other
  // tabs keep open on it close.
  | { type: "reset"; database: string; limitMs: number };

// The bytes of file data each database holds: the user data's files, the
// version's base data as its marker records it, and each installed store
// path's; a database or marker that doesn't exist counts as none.
export interface DatabaseUsage {
  userData: number;
  base: number;
  paths: Record<string, number>;
  // Every version whose data database exists, by version: its base data
  // and every store path marked installed in it. Where the browser can't
  // list databases, the current version alone, if it exists.
  versions: Record<string, number>;
}

export type StorageReply =
  | { type: "usage"; modules: DatabaseUsage[] }
  | { type: "export"; archive: Uint8Array<ArrayBuffer> }
  | { type: "reset" }
  | { type: "error"; message: string };
