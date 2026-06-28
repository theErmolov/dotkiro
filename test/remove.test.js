// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MANIFEST_PATH, writeManifest, readManifest } from "../src/init.js";

// We test remove logic by importing it and stubbing process.cwd
import { remove } from "../src/remove.js";

let testDir;
let originalCwd;

async function makeTempDir() {
  const dir = join(tmpdir(), `dotkiro-rm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeTestFile(base, relPath, content = "# test\n") {
  const full = join(base, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

async function fileExists(filePath) {
  try { await readFile(filePath); return true; } catch { return false; }
}

beforeEach(async () => {
  testDir = await makeTempDir();
  originalCwd = process.cwd;
  process.cwd = () => testDir;
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(testDir, { recursive: true, force: true });
});

describe("remove", () => {
  it("prints message when no manifest exists", async () => {
    const spy = vi.spyOn(console, "log");
    await remove([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Nothing to remove"));
    spy.mockRestore();
  });

  it("removes all files when no types specified", async () => {
    await writeTestFile(testDir, ".kiro/steering/a.md", "# a");
    await writeTestFile(testDir, ".kiro/skills/review/SKILL.md", "# skill");
    await writeManifest(testDir, {
      shared: [".kiro/steering/a.md", ".kiro/skills/review/SKILL.md"],
    });

    await remove([]);

    expect(await fileExists(join(testDir, ".kiro/steering/a.md"))).toBe(false);
    expect(await fileExists(join(testDir, ".kiro/skills/review/SKILL.md"))).toBe(false);
    // manifest itself should be gone
    expect(await fileExists(join(testDir, MANIFEST_PATH))).toBe(false);
  });

  it("removes only specified type, keeps others", async () => {
    await writeTestFile(testDir, ".kiro/steering/a.md", "# shared");
    await writeTestFile(testDir, ".kiro/steering/python/b.md", "# python");
    await writeManifest(testDir, {
      shared: [".kiro/steering/a.md"],
      python: [".kiro/steering/python/b.md"],
    });

    await remove(["python"]);

    expect(await fileExists(join(testDir, ".kiro/steering/a.md"))).toBe(true);
    expect(await fileExists(join(testDir, ".kiro/steering/python/b.md"))).toBe(false);

    const manifest = await readManifest(testDir);
    expect(manifest).toHaveProperty("shared");
    expect(manifest).not.toHaveProperty("python");
  });

  it("does not remove files shared by a kept type", async () => {
    // same file claimed by both shared and python
    await writeTestFile(testDir, ".kiro/skills/review/SKILL.md", "# skill");
    await writeManifest(testDir, {
      shared: [".kiro/skills/review/SKILL.md"],
      python: [".kiro/skills/review/SKILL.md"],
    });

    await remove(["python"]);

    // file should still exist because shared still claims it
    expect(await fileExists(join(testDir, ".kiro/skills/review/SKILL.md"))).toBe(true);
  });

  it("handles removing a type that has no files gracefully", async () => {
    await writeTestFile(testDir, ".kiro/steering/a.md", "# a");
    await writeManifest(testDir, {
      shared: [".kiro/steering/a.md"],
    });

    const spy = vi.spyOn(console, "log");
    await remove(["nonexistent"]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("skipping"));
    spy.mockRestore();
  });

  it("removes multiple types at once", async () => {
    await writeTestFile(testDir, ".kiro/steering/python/a.md", "# py");
    await writeTestFile(testDir, ".kiro/steering/cdk/b.md", "# cdk");
    await writeTestFile(testDir, ".kiro/steering/shared.md", "# shared");
    await writeManifest(testDir, {
      shared: [".kiro/steering/shared.md"],
      python: [".kiro/steering/python/a.md"],
      cdk: [".kiro/steering/cdk/b.md"],
    });

    await remove(["python", "cdk"]);

    expect(await fileExists(join(testDir, ".kiro/steering/python/a.md"))).toBe(false);
    expect(await fileExists(join(testDir, ".kiro/steering/cdk/b.md"))).toBe(false);
    expect(await fileExists(join(testDir, ".kiro/steering/shared.md"))).toBe(true);

    const manifest = await readManifest(testDir);
    expect(Object.keys(manifest)).toEqual(["shared"]);
  });

  it("removes type agent files from flat .kiro/agents while keeping shared agents", async () => {
    // both shared and python agents live flat in .kiro/agents
    await writeTestFile(testDir, ".kiro/agents/reviewer.json", "{}");
    await writeTestFile(testDir, ".kiro/agents/py-helper.json", "{}");
    await writeManifest(testDir, {
      shared: [".kiro/agents/reviewer.json"],
      python: [".kiro/agents/py-helper.json"],
    });

    await remove(["python"]);

    expect(await fileExists(join(testDir, ".kiro/agents/reviewer.json"))).toBe(true);
    expect(await fileExists(join(testDir, ".kiro/agents/py-helper.json"))).toBe(false);

    const manifest = await readManifest(testDir);
    expect(manifest).toHaveProperty("shared");
    expect(manifest).not.toHaveProperty("python");
  });

  // ─── PBT ──────────────────────────────────────────────────────────────

  it("removing all types leaves no manifest", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.stringMatching(/^[a-z]{1,8}$/),
          fc.array(fc.stringMatching(/^[a-z]{1,6}\.md$/), { minLength: 1, maxLength: 3 }),
          { minKeys: 1, maxKeys: 4 }
        ),
        async (typeMap) => {
          const dir = await makeTempDir();
          const prev = process.cwd;
          process.cwd = () => dir;
          try {
            // create all files and manifest
            for (const files of Object.values(typeMap)) {
              for (const f of files) {
                await writeTestFile(dir, f, "# x");
              }
            }
            await writeManifest(dir, typeMap);

            await remove([]);

            // manifest should be gone
            expect(await fileExists(join(dir, MANIFEST_PATH))).toBe(false);
          } finally {
            process.cwd = prev;
            await rm(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 15 }
    );
  });
});
