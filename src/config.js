// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULTS = {
  branch: "main",
};

const VALID_TYPE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;

export function buildPaths(types) {
  const paths = [
    { src: "steering", dest: ".kiro/steering", label: "Steering (shared)", type: "shared", extensions: [".md"] },
    { src: "skills", dest: ".kiro/skills", label: "Skills (shared)", type: "shared", extensions: [".md"] },
    { src: "agents", dest: ".kiro/agents", label: "Agents (shared)", type: "shared", extensions: [".md", ".json"] },
  ];

  for (const type of types) {
    if (type && type !== "default") {
      if (!VALID_TYPE.test(type)) {
        throw new Error(`Invalid type name: "${type}". Use only letters, numbers, hyphens, dots, and underscores.`);
      }
      paths.push(
        { src: `${type}/steering`, dest: `.kiro/steering/${type}`, label: `Steering (${type})`, type, extensions: [".md"] },
        { src: `${type}/skills`, dest: ".kiro/skills", label: `Skills (${type})`, type, extensions: [".md"] },
        { src: `${type}/agents`, dest: ".kiro/agents", label: `Agents (${type})`, type, extensions: [".md", ".json"] },
      );
    }
  }

  return paths;
}

async function readJson(filePath) {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export async function loadConfig(cliFlags = {}, types = []) {
  const userConfig = await readJson(
    join(homedir(), ".config", "dotkiro", "config.json")
  );
  const projectConfig = await readJson(join(process.cwd(), ".dotkirorc"));

  const config = { ...DEFAULTS, ...userConfig, ...projectConfig };

  for (const [key, val] of Object.entries(cliFlags)) {
    if (val !== undefined) config[key] = val;
  }

  config.types = types.length > 0 ? types : (config.types || []);
  config.paths = buildPaths(config.types);

  return config;
}

/**
 * Read the project .dotkirorc, update its types array, and write it back.
 * Preserves all other fields (repo, branch, etc.).
 */
export async function updateDotkirorc({ addTypes = [], removeTypes = [], clearTypes = false } = {}) {
  const rcPath = join(process.cwd(), ".dotkirorc");
  const rc = await readJson(rcPath);

  let current = rc.types || [];

  if (clearTypes) {
    current = [];
  } else {
    // add new types (deduplicated)
    for (const t of addTypes) {
      if (!current.includes(t)) {
        current.push(t);
      }
    }
    // remove specified types
    if (removeTypes.length > 0) {
      current = current.filter((t) => !removeTypes.includes(t));
    }
  }

  if (current.length > 0) {
    rc.types = current;
  } else {
    delete rc.types;
  }

  await writeFile(rcPath, JSON.stringify(rc, null, 2) + "\n");
}
