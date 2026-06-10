// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdir, readdir, copyFile, rm, readFile, writeFile, rmdir } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { updateDotkirorc } from "./config.js";

const exec = promisify(execFile);
export const MANIFEST_PATH = ".dotkiro-manifest.json";

const GITIGNORE_ENTRY = MANIFEST_PATH;

async function ensureGitignore(cwd) {
  const gitignorePath = join(cwd, ".gitignore");
  let content;
  try {
    content = await readFile(gitignorePath, "utf-8");
  } catch {
    console.log(`  No .gitignore found — consider adding "${GITIGNORE_ENTRY}" manually.`);
    return;
  }

  if (content.includes(GITIGNORE_ENTRY)) {
    return;
  }

  const newline = content.endsWith("\n") ? "" : "\n";
  await writeFile(gitignorePath, content + newline + GITIGNORE_ENTRY + "\n");
  console.log(`  Added "${GITIGNORE_ENTRY}" to .gitignore`);
}

async function filesEqual(a, b) {
  try {
    const [contentA, contentB] = await Promise.all([
      readFile(a),
      readFile(b),
    ]);
    return contentA.equals(contentB);
  } catch {
    return false;
  }
}

export async function copyDir(srcDir, destDir, label, extensions = [".md"]) {
  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch {
    return { added: 0, updated: 0, unchanged: 0, files: [] };
  }

  await mkdir(destDir, { recursive: true });

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const files = [];

  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);

    if (entry.isDirectory()) {
      const sub = await copyDir(srcPath, destPath, null, extensions);
      added += sub.added;
      updated += sub.updated;
      unchanged += sub.unchanged;
      files.push(...sub.files);
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      const equal = await filesEqual(srcPath, destPath);
      if (equal) {
        unchanged++;
      } else {
        const isNew = !(await readFile(destPath).then(() => true, () => false));
        await copyFile(srcPath, destPath);
        if (isNew) added++;
        else updated++;
      }
      files.push(destPath);
    }
  }

  if (label) {
    const total = added + updated + unchanged;
    if (total > 0) {
      const details = [];
      if (added > 0) details.push(`${added} added`);
      if (updated > 0) details.push(`${updated} updated`);
      if (unchanged > 0) details.push(`${unchanged} unchanged`);
      console.log(`  ${label}: ${details.join(", ")} → ${destDir}`);
    }
  }

  return { added, updated, unchanged, files };
}

export async function readManifest(cwd) {
  try {
    const content = await readFile(join(cwd, MANIFEST_PATH), "utf-8");
    const data = JSON.parse(content);
    // support both old flat format and new typed format
    if (data.types) return data.types;
    if (data.files) return { shared: data.files };
    return {};
  } catch {
    return {};
  }
}

export async function writeManifest(cwd, types) {
  const manifestDir = dirname(join(cwd, MANIFEST_PATH));
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(cwd, MANIFEST_PATH),
    JSON.stringify({ types }, null, 2) + "\n"
  );
}

export async function removeFiles(cwd, files) {
  for (const filePath of files) {
    try {
      await rm(join(cwd, filePath), { force: true });
    } catch {
      // already gone
    }
  }

  // clean up empty directories, deepest first
  const dirs = new Set(files.map((f) => dirname(f)));
  const sorted = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length);

  for (const dir of sorted) {
    try {
      await rmdir(join(cwd, dir));
    } catch {
      // not empty or doesn't exist
    }
  }
}

export async function init(config) {
  const { repo, branch, paths, types, gitignore } = config;

  if (!repo) {
    console.error(
      "No repo configured. Set it via --repo, .dotkirorc, or ~/.config/dotkiro/config.json"
    );
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

    for (const { src, dest, label, type, extensions } of paths) {
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

    // figure out all files from the new sync
    const allNewFiles = new Set(Object.values(filesByType).flat());

    // read previous manifest and find stale files
    const previousTypes = await readManifest(cwd);
    const allPreviousFiles = Object.values(previousTypes).flat();
    const stale = allPreviousFiles.filter((f) => !allNewFiles.has(f));
    await removeFiles(cwd, stale);

    // merge: keep types not in this run, overwrite types that are
    const staleSet = new Set(stale);
    const mergedTypes = {};

    // carry forward previous types, but strip any stale files from them
    for (const [type, files] of Object.entries(previousTypes)) {
      const remaining = files.filter((f) => !staleSet.has(f));
      if (remaining.length > 0) {
        mergedTypes[type] = remaining;
      }
    }

    // overwrite types that were in this run's scope
    for (const type of Object.keys(filesByType)) {
      mergedTypes[type] = filesByType[type];
    }

    // remove types that were requested but had no files (type exists in config but empty in repo)
    const requestedTypes = new Set(paths.map((p) => p.type));
    for (const type of requestedTypes) {
      if (!filesByType[type] || filesByType[type].length === 0) {
        delete mergedTypes[type];
      }
    }

    await writeManifest(cwd, mergedTypes);

    // persist declared types to .dotkirorc so the project manifest is the source of truth
    const declaredTypes = Object.keys(mergedTypes).filter((t) => t !== "shared");
    if (declaredTypes.length > 0) {
      await updateDotkirorc({ addTypes: declaredTypes });
    } else {
      await updateDotkirorc({ clearTypes: true });
    }

    const total = totalAdded + totalUpdated + totalUnchanged;
    if (total === 0 && stale.length === 0) {
      console.log("No files found in the configured paths.");
    } else {
      const parts = [];
      if (totalAdded > 0) parts.push(`${totalAdded} added`);
      if (totalUpdated > 0) parts.push(`${totalUpdated} updated`);
      if (totalUnchanged > 0) parts.push(`${totalUnchanged} unchanged`);
      if (stale.length > 0) parts.push(`${stale.length} removed`);
      console.log(`Done. ${parts.join(", ")}.`);
    }

    if (gitignore) {
      await ensureGitignore(cwd);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
