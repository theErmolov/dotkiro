// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { copyDir, readManifest, writeManifest } from "./init.js";
import { updateDotkirorc } from "./config.js";

const exec = promisify(execFile);

export async function add(config) {
  const { repo, branch, paths, types } = config;

  if (!repo) {
    console.error(
      "No repo configured. Set it via --repo, .dotkirorc, or ~/.config/dotkiro/config.json"
    );
    process.exit(1);
  }

  if (types.length === 0) {
    console.error("Usage: dotkiro add <types...>");
    process.exit(1);
  }

  const cwd = process.cwd();
  const tmpDir = join(tmpdir(), `cel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    console.log(`Fetching from ${repo} (${branch})...`);

    await exec("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      branch,
      "--single-branch",
      repo,
      tmpDir,
    ]);

    let totalAdded = 0;
    let totalUpdated = 0;
    let totalUnchanged = 0;
    const filesByType = {};

    // only sync the type-specific paths, not shared
    const typePaths = paths.filter((p) => p.type !== "shared");

    for (const { src, dest, label, type, extensions } of typePaths) {
      const srcDir = join(tmpDir, src);
      const destDir = join(cwd, dest);
      const { added, updated, unchanged, files } = await copyDir(srcDir, destDir, label, extensions);
      totalAdded += added;
      totalUpdated += updated;
      totalUnchanged += unchanged;

      const relFiles = files.map((f) => relative(cwd, f));
      if (!filesByType[type]) filesByType[type] = [];
      filesByType[type].push(...relFiles);
    }

    // merge into existing manifest
    const existing = await readManifest(cwd);
    for (const [type, files] of Object.entries(filesByType)) {
      existing[type] = files;
    }
    await writeManifest(cwd, existing);

    // update .dotkirorc so the project manifest declares these types
    await updateDotkirorc({ addTypes: types });

    const total = totalAdded + totalUpdated + totalUnchanged;
    if (total === 0) {
      console.log(`No files found for ${types.join(", ")}.`);
    } else {
      const parts = [];
      if (totalAdded > 0) parts.push(`${totalAdded} added`);
      if (totalUpdated > 0) parts.push(`${totalUpdated} updated`);
      if (totalUnchanged > 0) parts.push(`${totalUnchanged} unchanged`);
      console.log(`Done. ${parts.join(", ")}.`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
