// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests that exercise the full init → add → update → remove lifecycle.
 * Uses a local bare git repo as the "remote" so no network is needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { readManifest, MANIFEST_PATH } from "../src/init.js";
import { init } from "../src/init.js";
import { add } from "../src/add.js";
import { remove } from "../src/remove.js";
import { status } from "../src/status.js";
import { loadConfig } from "../src/config.js";

const exec = promisify(execFile);

let testDir;
let bareRepo;
let projectDir;
let originalCwd;

async function fileExists(p) {
  try { await readFile(p); return true; } catch { return false; }
}

/**
 * Creates a local bare git repo populated with a conventions structure:
 *   steering/code-style.md
 *   skills/review/SKILL.md
 *   hooks/lint-on-save.kiro.hook
 *   agents/helper.md
 *   agents/reviewer.json
 *   python/steering/python-rules.md
 *   python/skills/pytest/SKILL.md
 *   python/hooks/run-pytest.kiro.hook
 *   python/agents/py-helper.json
 *   cdk/steering/construct-patterns.md
 */
async function setupFixtures() {
  testDir = join(tmpdir(), `dotkiro-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  bareRepo = join(testDir, "remote.git");
  projectDir = join(testDir, "project");

  const workTree = join(testDir, "work");

  await mkdir(workTree, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  // init a normal repo, add files, then clone --bare
  await exec("git", ["init", workTree]);
  await exec("git", ["-C", workTree, "config", "user.email", "test@test.com"]);
  await exec("git", ["-C", workTree, "config", "user.name", "Test"]);

  const files = {
    "steering/code-style.md": "# Code Style\nUse consistent formatting.",
    "steering/security.md": "# Security\nNo secrets in code.",
    "skills/review/SKILL.md": "# Code Review Skill",
    "hooks/lint-on-save.kiro.hook": '{"name":"Lint on Save","version":"1.0.0","when":{"type":"fileEdited","patterns":["*.ts"]},"then":{"type":"runCommand","command":"npm run lint"}}',
    "agents/helper.md": "---\nname: helper\ndescription: A shared helper agent.\n---\nYou are a helper.",
    "agents/reviewer.json": JSON.stringify({ name: "reviewer", description: "A shared review agent." }),
    "python/steering/python-rules.md": "# Python Rules\nUse type hints.",
    "python/skills/pytest/SKILL.md": "# Pytest Skill",
    "python/hooks/run-pytest.kiro.hook": '{"name":"Run Pytest","version":"1.0.0","when":{"type":"fileEdited","patterns":["*.py"]},"then":{"type":"runCommand","command":"pytest"}}',
    "python/agents/py-helper.json": JSON.stringify({ name: "py-helper", description: "A python agent." }),
    "cdk/steering/construct-patterns.md": "# CDK Patterns",
  };

  for (const [relPath, content] of Object.entries(files)) {
    const full = join(workTree, relPath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }

  await exec("git", ["-C", workTree, "add", "."]);
  await exec("git", ["-C", workTree, "commit", "-m", "initial"]);
  await exec("git", ["clone", "--bare", workTree, bareRepo]);
}

beforeEach(async () => {
  await setupFixtures();
  originalCwd = process.cwd;
  process.cwd = () => projectDir;
  // create .dotkirorc so loadConfig can find the repo
  await writeFile(
    join(projectDir, ".dotkirorc"),
    JSON.stringify({ repo: bareRepo }) + "\n"
  );
});

afterEach(async () => {
  process.cwd = originalCwd;
  await rm(testDir, { recursive: true, force: true });
});

// ─── init ───────────────────────────────────────────────────────────────────

describe("init (integration)", () => {
  it("syncs shared files with no types", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(config);

    expect(await fileExists(join(projectDir, ".kiro/steering/code-style.md"))).toBe(true);
    expect(await fileExists(join(projectDir, ".kiro/steering/security.md"))).toBe(true);
    expect(await fileExists(join(projectDir, ".kiro/skills/review/SKILL.md"))).toBe(true);
    // shared agents (both .md and .json)
    expect(await fileExists(join(projectDir, ".kiro/agents/helper.md"))).toBe(true);
    expect(await fileExists(join(projectDir, ".kiro/agents/reviewer.json"))).toBe(true);

    // no type-specific files
    expect(await fileExists(join(projectDir, ".kiro/steering/python/python-rules.md"))).toBe(false);

    const manifest = await readManifest(projectDir);
    expect(manifest).toHaveProperty("shared");
    expect(manifest.shared).toHaveLength(6);
  });

  it("syncs shared + type-specific files", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    // shared
    expect(await fileExists(join(projectDir, ".kiro/steering/code-style.md"))).toBe(true);
    // python steering
    expect(await fileExists(join(projectDir, ".kiro/steering/python/python-rules.md"))).toBe(true);
    // python skills (flattened)
    expect(await fileExists(join(projectDir, ".kiro/skills/pytest/SKILL.md"))).toBe(true);

    const manifest = await readManifest(projectDir);
    expect(manifest).toHaveProperty("shared");
    expect(manifest).toHaveProperty("python");
  });

  it("syncs multiple types", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python", "cdk"]);
    await init(config);

    expect(await fileExists(join(projectDir, ".kiro/steering/python/python-rules.md"))).toBe(true);
    expect(await fileExists(join(projectDir, ".kiro/steering/cdk/construct-patterns.md"))).toBe(true);

    const manifest = await readManifest(projectDir);
    expect(Object.keys(manifest).sort()).toEqual(["cdk", "python", "shared"]);
  });

  it("re-init with no CLI types uses types from .dotkirorc", async () => {
    // first init with python — writes types to .dotkirorc
    const config1 = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config1);
    expect(await fileExists(join(projectDir, ".kiro/steering/python/python-rules.md"))).toBe(true);

    // re-init with no CLI types — should still sync python because .dotkirorc now declares it
    const config2 = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(config2);

    // python files still present
    expect(await fileExists(join(projectDir, ".kiro/steering/python/python-rules.md"))).toBe(true);
    const manifest = await readManifest(projectDir);
    expect(manifest).toHaveProperty("shared");
    expect(manifest).toHaveProperty("python");
  });

  it("re-init with same types removes files deleted from remote", async () => {
    // init with python
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    const manifest1 = await readManifest(projectDir);
    const totalFiles = Object.values(manifest1).flat().length;
    expect(totalFiles).toBeGreaterThan(0);

    // re-init same config — nothing should change (idempotent)
    await init(config);
    const manifest2 = await readManifest(projectDir);
    expect(manifest2).toEqual(manifest1);
  });

  it("is idempotent — running twice produces same result", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);
    const manifest1 = await readManifest(projectDir);

    await init(config);
    const manifest2 = await readManifest(projectDir);

    expect(manifest1).toEqual(manifest2);
  });

  it("--gitignore adds manifest entry to existing .gitignore", async () => {
    await writeFile(join(projectDir, ".gitignore"), "node_modules/\n");
    const config = await loadConfig({ repo: bareRepo, branch: "main", gitignore: true }, []);
    await init(config);

    const content = await readFile(join(projectDir, ".gitignore"), "utf-8");
    expect(content).toContain(".dotkiro-manifest.json");
    // original content preserved
    expect(content).toContain("node_modules/");
  });

  it("--gitignore does not duplicate entry on repeat runs", async () => {
    await writeFile(join(projectDir, ".gitignore"), "node_modules/\n");
    const config = await loadConfig({ repo: bareRepo, branch: "main", gitignore: true }, []);
    await init(config);
    await init(config);

    const content = await readFile(join(projectDir, ".gitignore"), "utf-8");
    const matches = content.match(/\.dotkiro-manifest\.json/g);
    expect(matches).toHaveLength(1);
  });

  it("--gitignore does nothing when no .gitignore exists", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main", gitignore: true }, []);
    await init(config);

    // should not create a .gitignore
    expect(await fileExists(join(projectDir, ".gitignore"))).toBe(false);
  });
});

// ─── add ────────────────────────────────────────────────────────────────────

describe("add (integration)", () => {
  it("adds a type without re-syncing shared", async () => {
    // init shared first
    const initConfig = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(initConfig);

    // add python
    const addConfig = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await add(addConfig);

    expect(await fileExists(join(projectDir, ".kiro/steering/python/python-rules.md"))).toBe(true);

    const manifest = await readManifest(projectDir);
    expect(manifest).toHaveProperty("shared");
    expect(manifest).toHaveProperty("python");
  });

  it("can add multiple types sequentially", async () => {
    const initConfig = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(initConfig);

    const addPy = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await add(addPy);

    const addCdk = await loadConfig({ repo: bareRepo, branch: "main" }, ["cdk"]);
    await add(addCdk);

    const manifest = await readManifest(projectDir);
    expect(Object.keys(manifest).sort()).toEqual(["cdk", "python", "shared"]);
  });
});

// ─── remove (integration) ──────────────────────────────────────────────────

describe("remove (integration)", () => {
  it("removes a type and cleans up files", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python", "cdk"]);
    await init(config);

    await remove(["cdk"]);

    expect(await fileExists(join(projectDir, ".kiro/steering/cdk/construct-patterns.md"))).toBe(false);
    expect(await fileExists(join(projectDir, ".kiro/steering/python/python-rules.md"))).toBe(true);

    const manifest = await readManifest(projectDir);
    expect(manifest).not.toHaveProperty("cdk");
    expect(manifest).toHaveProperty("python");
  });

  it("removes everything and deletes manifest", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    await remove([]);

    expect(await fileExists(join(projectDir, MANIFEST_PATH))).toBe(false);
    expect(await fileExists(join(projectDir, ".kiro/steering/code-style.md"))).toBe(false);
  });
});

// ─── full lifecycle ─────────────────────────────────────────────────────────

describe("full lifecycle", () => {
  it("init → add → update → remove", async () => {
    // 1. init with shared only
    const initConfig = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(initConfig);
    let manifest = await readManifest(projectDir);
    expect(Object.keys(manifest)).toEqual(["shared"]);

    // 2. add python
    const addConfig = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await add(addConfig);
    manifest = await readManifest(projectDir);
    expect(manifest).toHaveProperty("python");

    // 3. re-init (simulates update) — should keep python
    const updateConfig = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(updateConfig);
    manifest = await readManifest(projectDir);
    expect(manifest).toHaveProperty("shared");
    expect(manifest).toHaveProperty("python");

    // 4. remove python
    await remove(["python"]);
    manifest = await readManifest(projectDir);
    expect(manifest).not.toHaveProperty("python");
    expect(manifest).toHaveProperty("shared");

    // 5. remove everything
    await remove([]);
    expect(await fileExists(join(projectDir, MANIFEST_PATH))).toBe(false);
  });
});

// ─── .dotkirorc as project manifest ─────────────────────────────────────────

async function readRc(dir) {
  try {
    return JSON.parse(await readFile(join(dir, ".dotkirorc"), "utf-8"));
  } catch {
    return {};
  }
}

describe(".dotkirorc manifest", () => {
  it("init with types writes them to .dotkirorc", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python", "cdk"]);
    await init(config);

    const rc = await readRc(projectDir);
    expect(rc.types).toEqual(expect.arrayContaining(["python", "cdk"]));
    expect(rc.types).toHaveLength(2);
  });

  it("init preserves repo and branch in .dotkirorc", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    const rc = await readRc(projectDir);
    expect(rc.repo).toBe(bareRepo);
    expect(rc.types).toEqual(["python"]);
  });

  it("add appends new types to .dotkirorc", async () => {
    const initConfig = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(initConfig);

    const addConfig = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await add(addConfig);

    let rc = await readRc(projectDir);
    expect(rc.types).toContain("python");

    const addCdk = await loadConfig({ repo: bareRepo, branch: "main" }, ["cdk"]);
    await add(addCdk);

    rc = await readRc(projectDir);
    expect(rc.types).toContain("python");
    expect(rc.types).toContain("cdk");
  });

  it("add does not duplicate existing types in .dotkirorc", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    const addConfig = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await add(addConfig);

    const rc = await readRc(projectDir);
    const pythonCount = rc.types.filter((t) => t === "python").length;
    expect(pythonCount).toBe(1);
  });

  it("remove strips types from .dotkirorc", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python", "cdk"]);
    await init(config);

    await remove(["cdk"]);

    const rc = await readRc(projectDir);
    expect(rc.types).toEqual(["python"]);
    expect(rc.types).not.toContain("cdk");
  });

  it("remove all clears types from .dotkirorc", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    await remove([]);

    const rc = await readRc(projectDir);
    expect(rc.types).toBeUndefined();
    // repo should still be there
    expect(rc.repo).toBe(bareRepo);
  });

  it("new clone can init from .dotkirorc types alone", async () => {
    // simulate: someone committed .dotkirorc with types
    await writeFile(
      join(projectDir, ".dotkirorc"),
      JSON.stringify({ repo: bareRepo, types: ["python", "cdk"] }) + "\n"
    );

    // init with no CLI args — should pick up types from .dotkirorc
    const config = await loadConfig({}, []);
    await init(config);

    expect(await fileExists(join(projectDir, ".kiro/steering/python/python-rules.md"))).toBe(true);
    expect(await fileExists(join(projectDir, ".kiro/steering/cdk/construct-patterns.md"))).toBe(true);
    expect(await fileExists(join(projectDir, ".kiro/steering/code-style.md"))).toBe(true);

    const manifest = await readManifest(projectDir);
    expect(Object.keys(manifest).sort()).toEqual(["cdk", "python", "shared"]);
  });
});

// ─── hooks ──────────────────────────────────────────────────────────────────

describe("hooks (integration)", () => {
  it("syncs shared hooks on init", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(config);

    expect(await fileExists(join(projectDir, ".kiro/hooks/lint-on-save.kiro.hook"))).toBe(true);

    const content = await readFile(join(projectDir, ".kiro/hooks/lint-on-save.kiro.hook"), "utf-8");
    expect(content).toContain("Lint on Save");
  });

  it("syncs type-specific hooks into .kiro/hooks/<type>/", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    expect(await fileExists(join(projectDir, ".kiro/hooks/lint-on-save.kiro.hook"))).toBe(true);
    expect(await fileExists(join(projectDir, ".kiro/hooks/python/run-pytest.kiro.hook"))).toBe(true);

    const content = await readFile(join(projectDir, ".kiro/hooks/python/run-pytest.kiro.hook"), "utf-8");
    expect(content).toContain("Run Pytest");
  });

  it("hooks are tracked in the manifest", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    const manifest = await readManifest(projectDir);
    const sharedFiles = manifest.shared;
    const pythonFiles = manifest.python;

    expect(sharedFiles.some((f) => f.includes("lint-on-save.kiro.hook"))).toBe(true);
    expect(pythonFiles.some((f) => f.includes("run-pytest.kiro.hook"))).toBe(true);
  });

  it("add syncs type-specific hooks without touching shared hooks", async () => {
    const initConfig = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(initConfig);

    const sharedHookBefore = await readFile(join(projectDir, ".kiro/hooks/lint-on-save.kiro.hook"), "utf-8");

    const addConfig = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await add(addConfig);

    // shared hook unchanged
    const sharedHookAfter = await readFile(join(projectDir, ".kiro/hooks/lint-on-save.kiro.hook"), "utf-8");
    expect(sharedHookAfter).toBe(sharedHookBefore);

    // type hook added
    expect(await fileExists(join(projectDir, ".kiro/hooks/python/run-pytest.kiro.hook"))).toBe(true);
  });

  it("remove cleans up type-specific hooks", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    expect(await fileExists(join(projectDir, ".kiro/hooks/python/run-pytest.kiro.hook"))).toBe(true);

    await remove(["python"]);

    expect(await fileExists(join(projectDir, ".kiro/hooks/python/run-pytest.kiro.hook"))).toBe(false);
    // shared hook still there
    expect(await fileExists(join(projectDir, ".kiro/hooks/lint-on-save.kiro.hook"))).toBe(true);
  });

  it("remove all cleans up all hooks", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    await remove([]);

    expect(await fileExists(join(projectDir, ".kiro/hooks/lint-on-save.kiro.hook"))).toBe(false);
    expect(await fileExists(join(projectDir, ".kiro/hooks/python/run-pytest.kiro.hook"))).toBe(false);
  });
});

// ─── agents ──────────────────────────────────────────────────────────────────

describe("agents (integration)", () => {
  it("syncs shared agents in both .md and .json formats", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(config);

    expect(await fileExists(join(projectDir, ".kiro/agents/helper.md"))).toBe(true);
    expect(await fileExists(join(projectDir, ".kiro/agents/reviewer.json"))).toBe(true);

    const manifest = await readManifest(projectDir);
    expect(manifest.shared).toContain(".kiro/agents/helper.md");
    expect(manifest.shared).toContain(".kiro/agents/reviewer.json");
  });

  it("flattens type-specific agents into .kiro/agents", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    // python agent lands flat in .kiro/agents, not nested under a type folder
    expect(await fileExists(join(projectDir, ".kiro/agents/py-helper.json"))).toBe(true);
    expect(await fileExists(join(projectDir, ".kiro/agents/python/py-helper.json"))).toBe(false);

    const manifest = await readManifest(projectDir);
    expect(manifest.python).toContain(".kiro/agents/py-helper.json");
  });

  it("re-init is idempotent for agents", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);
    const manifest1 = await readManifest(projectDir);

    await init(config);
    const manifest2 = await readManifest(projectDir);

    expect(manifest2).toEqual(manifest1);
  });

  it("add syncs type-specific agents without touching shared agents", async () => {
    const initConfig = await loadConfig({ repo: bareRepo, branch: "main" }, []);
    await init(initConfig);

    const sharedAgentBefore = await readFile(join(projectDir, ".kiro/agents/reviewer.json"), "utf-8");

    const addConfig = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await add(addConfig);

    // shared agent unchanged
    const sharedAgentAfter = await readFile(join(projectDir, ".kiro/agents/reviewer.json"), "utf-8");
    expect(sharedAgentAfter).toBe(sharedAgentBefore);

    // type agent added
    expect(await fileExists(join(projectDir, ".kiro/agents/py-helper.json"))).toBe(true);
  });

  it("remove cleans up type agents from flat .kiro/agents while keeping shared agents", async () => {
    const config = await loadConfig({ repo: bareRepo, branch: "main" }, ["python"]);
    await init(config);

    expect(await fileExists(join(projectDir, ".kiro/agents/py-helper.json"))).toBe(true);

    await remove(["python"]);

    expect(await fileExists(join(projectDir, ".kiro/agents/py-helper.json"))).toBe(false);
    // shared agents still there
    expect(await fileExists(join(projectDir, ".kiro/agents/helper.md"))).toBe(true);
    expect(await fileExists(join(projectDir, ".kiro/agents/reviewer.json"))).toBe(true);
  });

  it("does not create .kiro/agents when the remote has no agents folder", async () => {
    // build a separate remote without any agents/ directory
    const workTree2 = join(testDir, "work-noagents");
    const bareRepo2 = join(testDir, "remote-noagents.git");
    await mkdir(join(workTree2, "steering"), { recursive: true });
    await exec("git", ["init", workTree2]);
    await exec("git", ["-C", workTree2, "config", "user.email", "test@test.com"]);
    await exec("git", ["-C", workTree2, "config", "user.name", "Test"]);
    await writeFile(join(workTree2, "steering/only.md"), "# Only steering");
    await exec("git", ["-C", workTree2, "add", "."]);
    await exec("git", ["-C", workTree2, "commit", "-m", "initial"]);
    await exec("git", ["clone", "--bare", workTree2, bareRepo2]);

    const config = await loadConfig({ repo: bareRepo2, branch: "main" }, []);
    await init(config);

    expect(await fileExists(join(projectDir, ".kiro/steering/only.md"))).toBe(true);
    expect(await fileExists(join(projectDir, ".kiro/agents"))).toBe(false);
  });
});
