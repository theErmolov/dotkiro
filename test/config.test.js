// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPaths, loadConfig, updateDotkirorc } from "../src/config.js";

// ─── buildPaths ─────────────────────────────────────────────────────────────

describe("buildPaths", () => {
  it("returns shared steering + skills + agents when no types given", () => {
    const paths = buildPaths([]);
    expect(paths).toEqual([
      { src: "steering", dest: ".kiro/steering", label: "Steering (shared)", type: "shared", extensions: [".md"] },
      { src: "skills", dest: ".kiro/skills", label: "Skills (shared)", type: "shared", extensions: [".md"] },
      { src: "agents", dest: ".kiro/agents", label: "Agents (shared)", type: "shared", extensions: [".md", ".json"] },
    ]);
  });

  it("adds type-specific paths for each type", () => {
    const paths = buildPaths(["python"]);
    expect(paths).toHaveLength(6);
    expect(paths[3]).toEqual({
      src: "python/steering",
      dest: ".kiro/steering/python",
      label: "Steering (python)",
      type: "python",
      extensions: [".md"],
    });
    expect(paths[4]).toEqual({
      src: "python/skills",
      dest: ".kiro/skills",
      label: "Skills (python)",
      type: "python",
      extensions: [".md"],
    });
    expect(paths[5]).toEqual({
      src: "python/agents",
      dest: ".kiro/agents",
      label: "Agents (python)",
      type: "python",
      extensions: [".md", ".json"],
    });
  });

  it("handles multiple types", () => {
    const paths = buildPaths(["python", "cdk"]);
    // 3 shared + 3 per type × 2 types = 9
    expect(paths).toHaveLength(9);
    const types = paths.map((p) => p.type);
    expect(types).toEqual([
      "shared", "shared", "shared",
      "python", "python", "python",
      "cdk", "cdk", "cdk",
    ]);
  });

  it("skips empty string and 'default' types", () => {
    const paths = buildPaths(["", "default", "python"]);
    // only shared (3) + python (3)
    expect(paths).toHaveLength(6);
    expect(paths.every((p) => p.type === "shared" || p.type === "python")).toBe(true);
  });

  it("rejects type names with path traversal characters", () => {
    expect(() => buildPaths(["../../etc"])).toThrow("Invalid type name");
    expect(() => buildPaths(["foo/bar"])).toThrow("Invalid type name");
    expect(() => buildPaths(["hello world"])).toThrow("Invalid type name");
    expect(() => buildPaths(["."])).toThrow("Invalid type name");
  });

  it("accepts valid type names", () => {
    expect(() => buildPaths(["python"])).not.toThrow();
    expect(() => buildPaths(["react-native"])).not.toThrow();
    expect(() => buildPaths(["node.js"])).not.toThrow();
    expect(() => buildPaths(["v2"])).not.toThrow();
  });

  // ─── PBT ────────────────────────────────────────────────────────────────

  it("always includes exactly 3 shared paths", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,9}[a-z0-9]$/).filter((s) => s !== "default"), { maxLength: 10 }),
        (types) => {
          const paths = buildPaths(types);
          const shared = paths.filter((p) => p.type === "shared");
          expect(shared).toHaveLength(3);
        }
      )
    );
  });

  it("adds exactly 3 paths per non-empty, non-default type", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,9}[a-z0-9]$/).filter((s) => s !== "default"), { maxLength: 10 }),
        (types) => {
          const paths = buildPaths(types);
          // 3 shared + 3 per valid type
          expect(paths).toHaveLength(3 + types.length * 3);
        }
      )
    );
  });

  it("type-specific steering dest always nests under .kiro/steering/<type>", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.stringMatching(/^[a-z][a-z0-9-]{0,18}[a-z0-9]$/).filter((s) => s !== "default"),
          { minLength: 1, maxLength: 5 }
        ),
        (types) => {
          const paths = buildPaths(types);
          for (const p of paths) {
            if (p.type !== "shared" && p.src.endsWith("/steering")) {
              expect(p.dest).toBe(`.kiro/steering/${p.type}`);
            }
          }
        }
      )
    );
  });

  it("type-specific skills always flatten to .kiro/skills", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.stringMatching(/^[a-z][a-z0-9-]{0,18}[a-z0-9]$/).filter((s) => s !== "default"),
          { minLength: 1, maxLength: 5 }
        ),
        (types) => {
          const paths = buildPaths(types);
          for (const p of paths) {
            if (p.src.endsWith("/skills")) {
              expect(p.dest).toBe(".kiro/skills");
            }
          }
        }
      )
    );
  });

  it("type-specific agents always flatten to .kiro/agents", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.stringMatching(/^[a-z][a-z0-9-]{0,18}[a-z0-9]$/).filter((s) => s !== "default"),
          { minLength: 1, maxLength: 5 }
        ),
        (types) => {
          const paths = buildPaths(types);
          for (const p of paths) {
            if (p.src.endsWith("/agents")) {
              expect(p.dest).toBe(".kiro/agents");
            }
          }
        }
      )
    );
  });

  it("agents paths accept both .md and .json; steering and skills accept only .md", () => {
    const paths = buildPaths(["python"]);
    for (const p of paths) {
      if (p.src.endsWith("agents")) {
        expect(p.extensions).toEqual([".md", ".json"]);
      } else {
        expect(p.extensions).toEqual([".md"]);
      }
    }
  });
});

// ─── loadConfig ─────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  const originalCwd = process.cwd;

  beforeEach(() => {
    // point cwd at a temp dir so .dotkirorc won't be found
    process.cwd = () => "/tmp/dotkiro-test-nonexistent";
  });

  afterEach(() => {
    process.cwd = originalCwd;
  });

  it("uses default branch when nothing overrides", async () => {
    const config = await loadConfig({}, []);
    expect(config.branch).toBe("main");
  });

  it("CLI flags override project config", async () => {
    const config = await loadConfig({ branch: "develop" }, []);
    expect(config.branch).toBe("develop");
  });

  it("ignores undefined CLI flag values", async () => {
    const config = await loadConfig({ branch: undefined }, []);
    expect(config.branch).toBe("main");
  });

  it("passes types through to config.types", async () => {
    const config = await loadConfig({}, ["python", "cdk"]);
    expect(config.types).toEqual(["python", "cdk"]);
  });

  it("builds paths from types", async () => {
    const config = await loadConfig({}, ["python"]);
    expect(config.paths).toHaveLength(6);
  });

  it("defaults types to empty array when none provided", async () => {
    const config = await loadConfig({}, []);
    expect(config.types).toEqual([]);
  });
});

// ─── updateDotkirorc ────────────────────────────────────────────────────────

describe("updateDotkirorc", () => {
  let testDir;
  const originalCwd = process.cwd;

  async function makeTempDir() {
    const dir = join(tmpdir(), `dotkiro-rc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function readRc(dir) {
    return JSON.parse(await readFile(join(dir, ".dotkirorc"), "utf-8"));
  }

  beforeEach(async () => {
    testDir = await makeTempDir();
    process.cwd = () => testDir;
    // seed a .dotkirorc
    await writeFile(
      join(testDir, ".dotkirorc"),
      JSON.stringify({ repo: "https://example.com/repo.git" }) + "\n"
    );
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await rm(testDir, { recursive: true, force: true });
  });

  it("adds types to an empty .dotkirorc", async () => {
    await updateDotkirorc({ addTypes: ["python", "cdk"] });
    const rc = await readRc(testDir);
    expect(rc.types).toEqual(["python", "cdk"]);
    expect(rc.repo).toBe("https://example.com/repo.git");
  });

  it("appends without duplicating existing types", async () => {
    await updateDotkirorc({ addTypes: ["python"] });
    await updateDotkirorc({ addTypes: ["python", "cdk"] });
    const rc = await readRc(testDir);
    expect(rc.types).toEqual(["python", "cdk"]);
  });

  it("removes specified types", async () => {
    await updateDotkirorc({ addTypes: ["python", "cdk", "typescript"] });
    await updateDotkirorc({ removeTypes: ["cdk"] });
    const rc = await readRc(testDir);
    expect(rc.types).toEqual(["python", "typescript"]);
  });

  it("clears all types", async () => {
    await updateDotkirorc({ addTypes: ["python"] });
    await updateDotkirorc({ clearTypes: true });
    const rc = await readRc(testDir);
    expect(rc.types).toBeUndefined();
    expect(rc.repo).toBe("https://example.com/repo.git");
  });

  it("removes types key when last type is removed", async () => {
    await updateDotkirorc({ addTypes: ["python"] });
    await updateDotkirorc({ removeTypes: ["python"] });
    const rc = await readRc(testDir);
    expect(rc.types).toBeUndefined();
  });

  // ─── PBT ──────────────────────────────────────────────────────────────

  it("add then remove is a no-op for the same types", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.stringMatching(/^[a-z]{1,8}$/),
          { minLength: 1, maxLength: 5 }
        ),
        async (types) => {
          const dir = await makeTempDir();
          const prev = process.cwd;
          process.cwd = () => dir;
          try {
            await writeFile(join(dir, ".dotkirorc"), JSON.stringify({ repo: "x" }));
            await updateDotkirorc({ addTypes: types });
            await updateDotkirorc({ removeTypes: types });
            const rc = await readRc(dir);
            expect(rc.types).toBeUndefined();
          } finally {
            process.cwd = prev;
            await rm(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it("adding types is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.stringMatching(/^[a-z]{1,8}$/),
          { minLength: 1, maxLength: 5 }
        ),
        async (types) => {
          const dir = await makeTempDir();
          const prev = process.cwd;
          process.cwd = () => dir;
          try {
            await writeFile(join(dir, ".dotkirorc"), JSON.stringify({ repo: "x" }));
            await updateDotkirorc({ addTypes: types });
            const rc1 = await readRc(dir);
            await updateDotkirorc({ addTypes: types });
            const rc2 = await readRc(dir);
            expect(rc1.types).toEqual(rc2.types);
          } finally {
            process.cwd = prev;
            await rm(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});
