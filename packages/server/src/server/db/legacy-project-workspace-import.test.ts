import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { openPaseoDatabase, type PaseoDatabaseHandle } from "./sqlite-database.js";
import { importLegacyProjectWorkspaceJson } from "./legacy-project-workspace-import.js";
import { projects, workspaces } from "./schema.js";

describe("importLegacyProjectWorkspaceJson", () => {
  let tmpDir: string;
  let paseoHome: string;
  let dbDir: string;
  let database: PaseoDatabaseHandle;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "paseo-legacy-import-"));
    paseoHome = path.join(tmpDir, ".paseo");
    dbDir = path.join(paseoHome, "db");
    mkdirSync(paseoHome, { recursive: true });
    database = await openPaseoDatabase(dbDir);
  });

  afterEach(async () => {
    await database?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("imports legacy projects and workspaces once when the DB is empty", async () => {
    writeLegacyJson({
      paseoHome,
      projectsJson: [
        {
          projectId: "project-1",
          rootPath: "/tmp/project-1",
          kind: "git",
          displayName: "Project One",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      workspacesJson: [
        {
          workspaceId: "workspace-1",
          projectId: "project-1",
          cwd: "/tmp/project-1",
          kind: "local_checkout",
          displayName: "main",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          archivedAt: null,
        },
      ],
    });

    const result = await importLegacyProjectWorkspaceJson({
      db: database.db,
      paseoHome,
      logger: createTestLogger(),
    });

    expect(result).toEqual({
      status: "imported",
      importedProjects: 1,
      importedWorkspaces: 1,
    });
    const projectRows = await database.db.select().from(projects);
    expect(projectRows).toEqual([
      expect.objectContaining({
        directory: "/tmp/project-1",
        kind: "git",
        displayName: "Project One",
      }),
    ]);
    expect(typeof projectRows[0]!.id).toBe("number");

    const workspaceRows = await database.db.select().from(workspaces);
    expect(workspaceRows).toEqual([
      expect.objectContaining({
        projectId: projectRows[0]!.id,
        directory: "/tmp/project-1",
        kind: "checkout",
        displayName: "main",
      }),
    ]);
  });

  test("skips import when the DB already has project or workspace data", async () => {
    // Seed with a project in the new schema format
    const [inserted] = await database.db
      .insert(projects)
      .values({
        directory: "/tmp/existing-project",
        kind: "git",
        displayName: "Existing Project",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
        archivedAt: null,
      })
      .returning({ id: projects.id });

    writeLegacyJson({
      paseoHome,
      projectsJson: [
        {
          projectId: "legacy-project",
          rootPath: "/tmp/legacy-project",
          kind: "git",
          displayName: "Legacy Project",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      workspacesJson: [],
    });

    const result = await importLegacyProjectWorkspaceJson({
      db: database.db,
      paseoHome,
      logger: createTestLogger(),
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "database-not-empty",
    });
    // Only the existing project should be in DB
    const allProjects = await database.db.select().from(projects);
    expect(allProjects).toHaveLength(1);
    expect(allProjects[0]!.id).toBe(inserted!.id);
  });

  test("rolls back the whole import when workspace insertion fails", async () => {
    writeLegacyJson({
      paseoHome,
      projectsJson: [
        {
          projectId: "project-1",
          rootPath: "/tmp/project-1",
          kind: "git",
          displayName: "Project One",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      workspacesJson: [
        {
          workspaceId: "workspace-1",
          projectId: "missing-project",
          cwd: "/tmp/project-1",
          kind: "local_checkout",
          displayName: "main",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          archivedAt: null,
        },
      ],
    });

    await expect(
      importLegacyProjectWorkspaceJson({
        db: database.db,
        paseoHome,
        logger: createTestLogger(),
      }),
    ).rejects.toThrow();

    expect(await database.db.select().from(projects)).toEqual([]);
    expect(await database.db.select().from(workspaces)).toEqual([]);
  });

  test("deduplicates projects with the same rootPath", async () => {
    writeLegacyJson({
      paseoHome,
      projectsJson: [
        {
          projectId: "project-1",
          rootPath: "/tmp/project-1",
          kind: "git",
          displayName: "First Project",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          archivedAt: null,
        },
        {
          projectId: "project-2",
          rootPath: "/tmp/project-1",
          kind: "git",
          displayName: "Replacement Project",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      workspacesJson: [
        {
          workspaceId: "workspace-1",
          projectId: "project-2",
          cwd: "/tmp/project-1",
          kind: "local_checkout",
          displayName: "main",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:00.000Z",
          archivedAt: null,
        },
      ],
    });

    const result = await importLegacyProjectWorkspaceJson({
      db: database.db,
      paseoHome,
      logger: createTestLogger(),
    });

    expect(result).toEqual({
      status: "imported",
      importedProjects: 1,
      importedWorkspaces: 1,
    });
    const projectRows = await database.db.select().from(projects);
    expect(projectRows).toHaveLength(1);
    expect(projectRows[0]).toEqual(
      expect.objectContaining({
        directory: "/tmp/project-1",
        displayName: "First Project",
      }),
    );
  });

  test("creates backup of JSON files before import", async () => {
    writeLegacyJson({
      paseoHome,
      projectsJson: [
        {
          projectId: "project-1",
          rootPath: "/tmp/project-1",
          kind: "git",
          displayName: "Project One",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      workspacesJson: [
        {
          workspaceId: "workspace-1",
          projectId: "project-1",
          cwd: "/tmp/project-1",
          kind: "local_checkout",
          displayName: "main",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          archivedAt: null,
        },
      ],
    });

    await importLegacyProjectWorkspaceJson({
      db: database.db,
      paseoHome,
      logger: createTestLogger(),
    });

    const backupDir = path.join(paseoHome, "backup", "pre-migration");
    const projectsBackupPath = path.join(backupDir, "projects.json");
    const workspacesBackupPath = path.join(backupDir, "workspaces.json");
    expect(existsSync(projectsBackupPath)).toBe(true);
    expect(existsSync(workspacesBackupPath)).toBe(true);
    expect(JSON.parse(readFileSync(projectsBackupPath, "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(workspacesBackupPath, "utf8"))).toHaveLength(1);
  });

  test("produces clear error message for corrupt project JSON", async () => {
    writeLegacyJson({
      paseoHome,
      projectsJson: [
        {
          projectId: "project-1",
          rootPath: 123,
          kind: "git",
          displayName: "Project One",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-02T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      workspacesJson: [],
    });

    await expect(
      importLegacyProjectWorkspaceJson({
        db: database.db,
        paseoHome,
        logger: createTestLogger(),
      }),
    ).rejects.toThrow(
      `Failed to parse ${path.join(paseoHome, "projects", "projects.json")}. ` +
        "The file may be corrupted.",
    );
  });
});

function writeLegacyJson(input: {
  paseoHome: string;
  projectsJson: unknown[];
  workspacesJson: unknown[];
}): void {
  const projectsPath = path.join(input.paseoHome, "projects", "projects.json");
  const workspacesPath = path.join(input.paseoHome, "projects", "workspaces.json");
  mkdirSync(path.dirname(projectsPath), { recursive: true });
  writeFileSync(projectsPath, JSON.stringify(input.projectsJson, null, 2), {
    encoding: "utf8",
    flag: "w",
  });
  writeFileSync(workspacesPath, JSON.stringify(input.workspacesJson, null, 2), {
    encoding: "utf8",
    flag: "w",
  });
}
