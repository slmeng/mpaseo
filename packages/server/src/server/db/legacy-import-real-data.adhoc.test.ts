/**
 * Adhoc test: imports real legacy data from ~/.paseo into a fresh SQLite DB
 * and asserts that projects/workspaces are properly grouped.
 *
 * Run with: npx vitest run packages/server/src/server/db/legacy-import-real-data.adhoc.test.ts
 */
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { openPaseoDatabase, type PaseoDatabaseHandle } from "./sqlite-database.js";
import { importLegacyProjectWorkspaceJson } from "./legacy-project-workspace-import.js";
import { importLegacyAgentSnapshots } from "./legacy-agent-snapshot-import.js";
import { projects, workspaces, agentSnapshots } from "./schema.js";
import { eq } from "drizzle-orm";

const REAL_PASEO_HOME = path.join(os.homedir(), ".paseo");

describe("legacy import from real ~/.paseo data", () => {
  let tmpDir: string;
  let dbDir: string;
  let database: PaseoDatabaseHandle;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "paseo-real-import-"));
    dbDir = path.join(tmpDir, "db");
    mkdirSync(dbDir, { recursive: true });
    database = await openPaseoDatabase(dbDir);
  });

  afterEach(async () => {
    await database?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("imports real data and groups projects correctly", async () => {
    const logger = createTestLogger();

    // Phase 1: Import legacy project/workspace JSON (has proper grouping)
    const pwResult = await importLegacyProjectWorkspaceJson({
      db: database.db,
      paseoHome: REAL_PASEO_HOME,
      logger,
    });
    console.log("Project/workspace import result:", pwResult);

    // Phase 2: Import legacy agent snapshots
    const agentResult = await importLegacyAgentSnapshots({
      db: database.db,
      paseoHome: REAL_PASEO_HOME,
      logger,
    });
    console.log("Agent snapshot import result:", agentResult);

    // --- Assertions ---

    const allProjects = await database.db.select().from(projects);
    const allWorkspaces = await database.db.select().from(workspaces);
    const allAgents = await database.db.select().from(agentSnapshots);

    console.log(`Total projects: ${allProjects.length}`);
    console.log(`Total workspaces: ${allWorkspaces.length}`);
    console.log(`Total agents: ${allAgents.length}`);

    // 1. There should be fewer projects than workspaces (workspaces group under projects)
    expect(allProjects.length).toBeLessThan(allWorkspaces.length);

    // 2. There should be exactly ONE project per unique git remote
    const projectsByRemote = new Map<string, typeof allProjects>();
    for (const project of allProjects) {
      if (project.gitRemote) {
        const existing = projectsByRemote.get(project.gitRemote) ?? [];
        existing.push(project);
        projectsByRemote.set(project.gitRemote, existing);
      }
    }

    const duplicateRemotes: string[] = [];
    for (const [remote, projectList] of projectsByRemote) {
      if (projectList.length > 1) {
        duplicateRemotes.push(remote);
        console.log(`DUPLICATE: ${remote} has ${projectList.length} projects:`);
        for (const p of projectList) {
          console.log(`  id=${p.id} directory=${p.directory}`);
        }
      }
    }
    expect(duplicateRemotes).toEqual([]);

    // 3. Specifically: getpaseo/paseo should be ONE project
    const paseoProjects = allProjects.filter(
      (p) => p.gitRemote === "git@github.com:getpaseo/paseo.git",
    );
    expect(paseoProjects).toHaveLength(1);
    const paseoProject = paseoProjects[0]!;

    // 4. All paseo workspaces (worktrees + main checkout + subdirs) should be under that one project
    const paseoWorkspaces = allWorkspaces.filter((w) => w.projectId === paseoProject.id);
    console.log(`Paseo project id=${paseoProject.id}, directory=${paseoProject.directory}`);
    console.log(`Paseo workspaces: ${paseoWorkspaces.length}`);

    // The old data had ~51 paseo workspaces
    expect(paseoWorkspaces.length).toBeGreaterThanOrEqual(10);

    // 5. Subdirectory workspaces (packages/server, packages/app) should be under the same project
    const subdirWorkspaces = paseoWorkspaces.filter((w) => w.directory.includes("/packages/"));
    console.log(`Paseo subdirectory workspaces: ${subdirWorkspaces.length}`);
    for (const w of subdirWorkspaces) {
      console.log(`  ${w.directory} (projectId=${w.projectId})`);
      expect(w.projectId).toBe(paseoProject.id);
    }

    // 6. Worktree workspaces should be under the same project
    const worktreeWorkspaces = paseoWorkspaces.filter((w) =>
      w.directory.includes("/.paseo/worktrees/"),
    );
    console.log(`Paseo worktree workspaces: ${worktreeWorkspaces.length}`);
    expect(worktreeWorkspaces.length).toBeGreaterThan(0);

    // 7. No git project should be a subdirectory of another project with the SAME git remote
    //    (e.g., /dev/paseo/packages/server should not be its own project if /dev/paseo exists)
    const activeGitProjects = allProjects.filter((p) => !p.archivedAt && p.gitRemote);
    const subdirProjects: string[] = [];
    for (const project of activeGitProjects) {
      for (const other of activeGitProjects) {
        if (
          project.id !== other.id &&
          project.gitRemote === other.gitRemote &&
          project.directory.startsWith(other.directory + "/")
        ) {
          subdirProjects.push(
            `${project.directory} (id=${project.id}) is under ${other.directory} (id=${other.id}), both remote=${project.gitRemote}`,
          );
        }
      }
    }
    if (subdirProjects.length > 0) {
      console.log("Subdirectory git projects with same remote (should be empty):");
      for (const s of subdirProjects) {
        console.log(`  ${s}`);
      }
    }
    expect(subdirProjects).toEqual([]);

    // 8. All agent snapshots should reference valid workspaces
    for (const agent of allAgents) {
      const workspace = allWorkspaces.find((w) => w.id === agent.workspaceId);
      expect(workspace).toBeDefined();
    }
  });
});
