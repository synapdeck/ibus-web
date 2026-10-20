// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Builds one module's files from its script and exits. Building imports the
// script, which Node keeps for the life of the thread that imported it, so
// each plugin build runs in a thread of its own.

import { parentPort, workerData } from "node:worker_threads";
import { runModuleOutput, type ModuleInput } from "./files.ts";

parentPort?.postMessage(await runModuleOutput(workerData as ModuleInput));
