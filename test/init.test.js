// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  copyDir,
  readManifest,
  writeManifest,
  removeFiles,
  MANIFEST_PATH,
} from "../src/init.js";

// ─── helpers ────────────────────────────────────────────────────────────────

let testDir;

async function makeTempDir() {
  const dir = join(tmpdir(), `dotkiro-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeTestFile(base, relPath, content = "# test\n") {
  const full = join(base, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  testDir = await makeTempDir();
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ─── MANIFEST_PATH ──────────────────────────────────────────────────────────

describe("MANIFEST_PATH", () => {
  it("points to .dotkiro-manifest.json", () => {
    expect(MANIFEST_PATH).toBe(".dotkiro-manifest.json");
  });
});

// ─── copyDir ────────────────────────────────────────────────────────────────

describe("copyDir", () => {
  it("copies .md files from src to dest", async () => {
    const src = join(testDir, "src");
    const dest = join(testDir, "dest");
    await writeTestFile(src, "a.md", "# A");
    await writeTestFile(src, "b.md", "# B");

    const result = await copyDir(src, dest, "test");
    expect(result.added).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.files).toHaveLength(2);

    const content = await readFile(join(dest, "a.md"), "utf-8");
    expect(content).toBe("# A");
  });

  it("ignores non-.md files", async () => {
    const src = join(testDir, "src");
    const dest = join(testDir, "dest");
    await writeTestFile(src, "readme.md", "# yes");
    await writeTestFile(src, "script.js", "console.log('no')");
    await writeTestFile(src, "data.json", "{}");

    const result = await copyDir(src, dest, "test");
    expect(result.added).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toContain("readme.md");
  });

  it("copies .json files when extensions include .json", async () => {
    const src = join(testDir, "src");
    const dest = join(testDir, "dest");
    await writeTestFile(src, "agent.json", "{}");
    await writeTestFile(src, "notes.md", "# notes");

    const result = await copyDir(src, dest, "test", [".md", ".json"]);
    expect(result.added).toBe(2);
    expect(result.files).toHaveLength(2);

    const content = await readFile(join(dest, "agent.json"), "utf-8");
    expect(content).toBe("{}");
  });

  it("ignores .json files with the default extensions", async () => {
    const src = join(testDir, "src");
    const dest = join(testDir, "dest");
    await writeTestFile(src, "agent.json", "{}");
    await writeTestFile(src, "notes.md", "# notes");

    const result = await copyDir(src, dest, "test");
    expect(result.added).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toContain("notes.md");
  });

  it("copies the right subset from a mixed .md/.json directory", async () => {
    const src = join(testDir, "src");
    const dest = join(testDir, "dest");
    await writeTestFile(src, "a.md", "# a");
    await writeTestFile(src, "b.json", "{}");
    await writeTestFile(src, "c.txt", "nope");
    await writeTestFile(src, "d.yaml", "nope");

    const result = await copyDir(src, dest, "test", [".md", ".json"]);
    expect(result.added).toBe(2);
    expect(result.files).toHaveLength(2);
    expect(result.files.some((f) => f.endsWith("a.md"))).toBe(true);
    expect(result.files.some((f) => f.endsWith("b.json"))).toBe(true);
  });

  it("recursively copies subdirectories", async () => {
    const src = join(testDir, "src");
    const dest = join(testDir, "dest");
    await writeTestFile(src, "sub/deep/file.md", "# deep");

    const result = await copyDir(src, dest, "test");
    expect(result.added).toBe(1);
    const content = await readFile(join(dest, "sub", "deep", "file.md"), "utf-8");
    expect(content).toBe("# deep");
  });

  it("detects updated files", async () => {
    const src = join(testDir, "src");
    const dest = join(testDir, "dest");
    await writeTestFile(src, "a.md", "# version 2");
    await writeTestFile(dest, "a.md", "# version 1");

    const result = await copyDir(src, dest, "test");
    expect(result.updated).toBe(1);
    expect(result.added).toBe(0);

    const content = await readFile(join(dest, "a.md"), "utf-8");
    expect(content).toBe("# version 2");
  });

  it("detects unchanged files", async () => {
    const src = join(testDir, "src");
    const dest = join(testDir, "dest");
    await writeTestFile(src, "a.md", "# same");
    await writeTestFile(dest, "a.md", "# same");

    const result = await copyDir(src, dest, "test");
    expect(result.unchanged).toBe(1);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
  });

  it("returns zeros when src dir does not exist", async () => {
    const result = await copyDir(join(testDir, "nope"), join(testDir, "dest"), "test");
    expect(result).toEqual({ added: 0, updated: 0, unchanged: 0, files: [] });
  });

  it("returns zeros for empty directory", async () => {
    const src = join(testDir, "empty");
    await mkdir(src, { recursive: true });
    const result = await copyDir(src, join(testDir, "dest"), "test");
    expect(result).toEqual({ added: 0, updated: 0, unchanged: 0, files: [] });
  });

  // ─── PBT ──────────────────────────────────────────────────────────────

  it("added + updated + unchanged always equals files.length", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            name: fc.stringMatching(/^[a-z]{1,8}$/),
            content: fc.string({ minLength: 1, maxLength: 100 }),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        async (fileSpecs) => {
          const dir = await makeTempDir();
          try {
            const src = join(dir, "src");
            const dest = join(dir, "dest");
            for (const { name, content } of fileSpecs) {
              await writeTestFile(src, `${name}.md`, content);
            }
            const result = await copyDir(src, dest, null);
            // files may have duplicates from name collisions, so use result.files.length
            expect(result.added + result.updated + result.unchanged).toBe(result.files.length);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it("all copied files exist on disk", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.stringMatching(/^[a-z]{1,6}$/),
          { minLength: 1, maxLength: 5 }
        ),
        async (names) => {
          const dir = await makeTempDir();
          try {
            const src = join(dir, "src");
            const dest = join(dir, "dest");
            for (const name of names) {
              await writeTestFile(src, `${name}.md`, `# ${name}`);
            }
            const result = await copyDir(src, dest, null);
            for (const f of result.files) {
              expect(await fileExists(f)).toBe(true);
            }
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it("running copyDir twice with same content yields all unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            name: fc.stringMatching(/^[a-z]{1,6}$/),
            content: fc.string({ minLength: 1, maxLength: 50 }),
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (fileSpecs) => {
          const dir = await makeTempDir();
          try {
            const src = join(dir, "src");
            const dest = join(dir, "dest");
            for (const { name, content } of fileSpecs) {
              await writeTestFile(src, `${name}.md`, content);
            }
            await copyDir(src, dest, null);
            const result2 = await copyDir(src, dest, null);
            expect(result2.added).toBe(0);
            expect(result2.updated).toBe(0);
            // all should be unchanged on second run
            expect(result2.unchanged).toBe(result2.files.length);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});

// ─── readManifest / writeManifest ───────────────────────────────────────────

describe("manifest read/write", () => {
  it("round-trips typed manifest", async () => {
    const types = {
      shared: [".kiro/steering/a.md"],
      python: [".kiro/steering/python/b.md"],
    };
    await writeManifest(testDir, types);
    const result = await readManifest(testDir);
    expect(result).toEqual(types);
  });

  it("returns empty object when no manifest exists", async () => {
    const result = await readManifest(testDir);
    expect(result).toEqual({});
  });

  it("handles legacy flat format (files array)", async () => {
    const manifestDir = join(testDir, ".kiro");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(testDir, MANIFEST_PATH),
      JSON.stringify({ files: ["a.md", "b.md"] })
    );
    const result = await readManifest(testDir);
    expect(result).toEqual({ shared: ["a.md", "b.md"] });
  });

  it("handles malformed JSON gracefully", async () => {
    const manifestDir = join(testDir, ".kiro");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(testDir, MANIFEST_PATH), "not json{{{");
    const result = await readManifest(testDir);
    expect(result).toEqual({});
  });

  // ─── PBT ──────────────────────────────────────────────────────────────

  it("round-trips arbitrary type→files mappings", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.stringMatching(/^[a-z]{1,10}$/),
          fc.array(fc.stringMatching(/^\.kiro\/[a-z\/]{1,20}\.md$/), { maxLength: 5 })
        ),
        async (types) => {
          const dir = await makeTempDir();
          try {
            await writeManifest(dir, types);
            const result = await readManifest(dir);
            expect(result).toEqual(types);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 30 }
    );
  });
});

// ─── removeFiles ────────────────────────────────────────────────────────────

describe("removeFiles", () => {
  it("removes listed files", async () => {
    await writeTestFile(testDir, "a.md", "x");
    await writeTestFile(testDir, "b.md", "y");

    await removeFiles(testDir, ["a.md", "b.md"]);
    expect(await fileExists(join(testDir, "a.md"))).toBe(false);
    expect(await fileExists(join(testDir, "b.md"))).toBe(false);
  });

  it("cleans up empty parent directories", async () => {
    await writeTestFile(testDir, "deep/nested/file.md", "x");
    await removeFiles(testDir, ["deep/nested/file.md"]);
    expect(await fileExists(join(testDir, "deep/nested"))).toBe(false);
    expect(await fileExists(join(testDir, "deep"))).toBe(false);
  });

  it("does not fail on already-missing files", async () => {
    // should not throw
    await removeFiles(testDir, ["nonexistent.md", "also/missing.md"]);
  });

  it("leaves non-empty parent directories intact", async () => {
    await writeTestFile(testDir, "dir/keep.md", "keep");
    await writeTestFile(testDir, "dir/remove.md", "remove");

    await removeFiles(testDir, ["dir/remove.md"]);
    expect(await fileExists(join(testDir, "dir/keep.md"))).toBe(true);
    expect(await fileExists(join(testDir, "dir/remove.md"))).toBe(false);
  });

  // ─── PBT ──────────────────────────────────────────────────────────────

  it("every listed file is gone after removal", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.stringMatching(/^[a-z]{1,6}$/),
          { minLength: 1, maxLength: 8 }
        ),
        async (names) => {
          const dir = await makeTempDir();
          try {
            const files = [];
            for (const name of names) {
              const rel = `${name}.md`;
              await writeTestFile(dir, rel, "x");
              files.push(rel);
            }
            await removeFiles(dir, files);
            for (const f of files) {
              expect(await fileExists(join(dir, f))).toBe(false);
            }
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});
