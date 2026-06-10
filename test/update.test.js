// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the update command.
 * Update reads the manifest to discover previously configured types,
 * then delegates to init with those types.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { readManifest, writeManifest } from "../src/init.js";
import { init } from "../src/init.js";
import { update } from "../src/update.js";
import { loadConfig } from "../src/config.js";

const exec = promisify(execFile);

let testDir;
let bareRepo;
let projectDir;
let workTree;
let originalCwd;

async function fileExists(p) {
  try { await readFile(p); return true; } catch { return false; }
}

async function setupFixtures() {
  testDir = join(tmpdir(), `dotkiro-up-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  bareRepo = join(testDir, "remote.git");
  projectDir = join(testDir, "project");
  workTree = join(testDir, "work");

  await mkdir(workTree, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  await exec("git", ["init", workTree]);
  await exec("git", ["-C", workTree, "config", "user.email", "test@test.com"]);
  await exec("git", ["-C", workTree, "config", "user.name", "Test"]);

  const files = {
    "steering/code-style.md": "# Code Style v1",
    "skills/review/SKILL.md": "# Review Skill v1",
    "agents/team.md": "---\nname: team\ndescription: Team agent v1.\n---\nv1",
    "python/steering/python-rules.md": "# Python Rules v1",
  };

  for (const [relPath, content] of Object.entries(files)) {
    const full = join(workTree, relPath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }

  await exec("git", ["-C", workTree, "add", "."]);
  await exec("git", ["-C", workTree, "commit", "-m", "v1"]);
  await exec("git", ["clone", "--bare", workTree, bareRepo]);
}

beforeEach(async () => {
  await setupFixtures();
  originalCwd = process.cwd;
  process.cwd = () => projectDir;

  // write a .dotkirorc in the project so loadConfig finds the repo
  await writeFile(
    join(projectDir, ".dotkirorc"),
    JSON.stringify({ repo: bareRepo })
  );
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(testDir, { recursive: true, force: true });
});

describe("update", () => {
  it("prints message when no manifest exists", async () => {
    const spy = vi.spyOn(console, "log");
    await update({});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Nothing to update"));
    spy.mockRestore();
  });

  it("re-syncs previously configured types", async () => {
    // initial init with python
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    const manifest1 = await readManifest(projectDir);
    expect(manifest1).toHaveProperty("python");

    // now update the remote — change a file
    await writeFile(join(workTree, "steering/code-style.md"), "# Code Style v2");
    await exec("git", ["-C", workTree, "add", "."]);
    await exec("git", ["-C", workTree, "commit", "-m", "v2"]);
    // push to bare repo
    await exec("git", ["-C", workTree, "push", bareRepo, "main"]);

    // run update
    await update({});

    // verify the file was updated
    const content = await readFile(
      join(projectDir, ".kiro/steering/code-style.md"),
      "utf-8"
    );
    expect(content).toBe("# Code Style v2");

    // manifest should still have python
    const manifest2 = await readManifest(projectDir);
    expect(manifest2).toHaveProperty("python");
    expect(manifest2).toHaveProperty("shared");
  });

  it("picks up new files added to remote", async () => {
    // initial init shared only
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(config);

    // add a new file to remote
    await writeFile(join(workTree, "steering/new-rule.md"), "# New Rule");
    await exec("git", ["-C", workTree, "add", "."]);
    await exec("git", ["-C", workTree, "commit", "-m", "add rule"]);
    await exec("git", ["-C", workTree, "push", bareRepo, "main"]);

    await update({});

    expect(await fileExists(join(projectDir, ".kiro/steering/new-rule.md"))).toBe(true);
  });

  it("removes files deleted from remote", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(config);
    expect(await fileExists(join(projectDir, ".kiro/steering/code-style.md"))).toBe(true);

    // delete a file from remote
    await rm(join(workTree, "steering/code-style.md"));
    await exec("git", ["-C", workTree, "add", "."]);
    await exec("git", ["-C", workTree, "commit", "-m", "remove code-style"]);
    await exec("git", ["-C", workTree, "push", bareRepo, "main"]);

    await update({});

    expect(await fileExists(join(projectDir, ".kiro/steering/code-style.md"))).toBe(false);
  });
  it("re-syncs agent files (both .md and .json) added or changed in remote", async () => {
    // initial init shared only — pulls the existing agents/team.md
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(config);
    expect(await fileExists(join(projectDir, ".kiro/agents/team.md"))).toBe(true);

    // change the markdown agent and add a new json agent in the remote
    await writeFile(join(workTree, "agents/team.md"), "---\nname: team\ndescription: Team agent v2.\n---\nv2");
    await writeFile(join(workTree, "agents/deployer.json"), JSON.stringify({ name: "deployer", description: "Deploy agent." }));
    await exec("git", ["-C", workTree, "add", "."]);
    await exec("git", ["-C", workTree, "commit", "-m", "update agents"]);
    await exec("git", ["-C", workTree, "push", bareRepo, "main"]);

    await update({});

    const md = await readFile(join(projectDir, ".kiro/agents/team.md"), "utf-8");
    expect(md).toContain("v2");
    expect(await fileExists(join(projectDir, ".kiro/agents/deployer.json"))).toBe(true);
  });


  it("CLI flags override config during update", async () => {
    // init with python on main
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    // create a new branch with different content
    await exec("git", ["-C", workTree, "checkout", "-b", "v2"]);
    await writeFile(join(workTree, "steering/code-style.md"), "# v2 branch");
    await exec("git", ["-C", workTree, "add", "."]);
    await exec("git", ["-C", workTree, "commit", "-m", "v2 branch"]);
    await exec("git", ["-C", workTree, "push", bareRepo, "v2"]);

    // update with branch override
    await update({ branch: "v2" });

    const content = await readFile(
      join(projectDir, ".kiro/steering/code-style.md"),
      "utf-8"
    );
    expect(content).toBe("# v2 branch");
  });
});
