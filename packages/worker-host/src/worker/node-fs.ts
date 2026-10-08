// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a host under Node uses of node:fs/promises.
export interface NodeFs {
  open(
    path: string,
    flags: "w" | "r",
  ): Promise<{
    writeFile(text: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  readFile(path: string | URL, encoding: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

// Only a host under Node is given Node storage, so only it imports this.
export const nodeFs = (): Promise<NodeFs> => import("node:fs/promises" as string) as Promise<NodeFs>;
