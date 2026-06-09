#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from "node:util";
import { init } from "../src/init.js";
import { add } from "../src/add.js";
import { remove } from "../src/remove.js";
import { status } from "../src/status.js";
import { update } from "../src/update.js";
import { loadConfig } from "../src/config.js";

const commands = { init, add, remove, status, update };

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    branch: { type: "string" },
    gitignore: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...types] = positionals;

if (values.help || !command) {
  console.log(`Usage: dotkiro <command> [types...] [options]

Commands:
  init [types...]   Fetch steering files, skills, and agents from a remote repo
                    Types map to folders in the repo (e.g. "dotkiro init python typescript")
                    Omit types to pull shared files only
  add <types...>    Add type-specific conventions without affecting existing ones
  update            Re-sync all previously configured types from the remote repo
  remove [types...] Remove synced files — specify types to remove only those
                    Omit types to remove everything
  status            Show what's currently synced

Options:
  --repo       Git repo URL
  --branch     Branch to use (default: main)
  --gitignore  Add the manifest to .gitignore if not already present
  -h, --help   Show this help message

Config (.dotkirorc or ~/.config/dotkiro/config.json):
  repo      Git repo URL
  branch    Branch name (default: main)`);
  process.exit(0);
}

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

if (command === "remove") {
  await commands[command](types);
} else if (command === "status") {
  await commands[command]();
} else if (command === "update") {
  await commands[command](values);
} else {
  const config = await loadConfig(values, types);
  await commands[command](config);
}
