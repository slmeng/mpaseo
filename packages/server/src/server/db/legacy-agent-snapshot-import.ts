import path from "node:path";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";

import { count } from "drizzle-orm";
import type { Logger } from "pino";

import { parseStoredAgentRecord, type StoredAgentRecord } from "../agent/agent-storage.js";
import { detectWorkspaceGitMetadata } from "../workspace-git-metadata.js";
import { READ_ONLY_GIT_ENV } from "../checkout-git-utils.js";
import { normalizeWorkspaceId } from "../workspace-registry-model.js";
import type { PaseoDatabaseHandle } from "./sqlite-database.js";
import { toAgentSnapshotRowValues } from "./db-agent-snapshot-store.js";
import { agentSnapshots, projects, workspaces } from "./schema.js";

const SQLITE_MAX_VARIABLES_PER_STATEMENT = 999;
const AGENT_SNAPSHOT_INSERT_VARIABLES_PER_ROW = Object.keys(agentSnapshots).length;
const MAX_AGENT_SNAPSHOT_ROWS_PER_INSERT = Math.max(
  1,
  Math.floor(SQLITE_MAX_VARIABLES_PER_STATEMENT / AGENT_SNAPSHOT_INSERT_VARIABLES_PER_ROW),
);

export type LegacyAgentSnapshotImportResult =
  | {
      status: "imported";
      importedAgents: number;
    }
  | {
      status: "skipped";
      reason: "database-not-empty" | "no-legacy-files";
    };

export async function importLegacyAgentSnapshots(options: {
  db: PaseoDatabaseHandle["db"];
  paseoHome: string;
  logger: Logger;
}): Promise<LegacyAgentSnapshotImportResult> {
  if (await hasAnyAgentSnapshotRows(options.db)) {
    options.logger.info("Skipping legacy agent snapshot import because the DB is not empty");
    return {
      status: "skipped",
      reason: "database-not-empty",
    };
  }

  const agentsDir = path.join(options.paseoHome, "agents");
  if (!(await pathExists(agentsDir))) {
    options.logger.info("Skipping legacy agent snapshot import because no legacy files exist");
    return {
      status: "skipped",
      reason: "no-legacy-files",
    };
  }

  await backupLegacyAgentDirectory({
    sourceDir: agentsDir,
    paseoHome: options.paseoHome,
    logger: options.logger,
  });

  const { records, skippedCount } = await readLegacyAgentRecords(agentsDir, options.logger);
  if (skippedCount > 0) {
    options.logger.warn({ skippedCount }, "Skipped invalid agent JSON files during migration");
  }
  if (records.length === 0) {
    options.logger.info("Skipping legacy agent snapshot import because no legacy files exist");
    return {
      status: "skipped",
      reason: "no-legacy-files",
    };
  }

  options.db.transaction((tx) => {
    const workspaceRows = tx
      .select({ id: workspaces.id, directory: workspaces.directory })
      .from(workspaces)
      .all();
    const workspaceIdsByDirectory = new Map(
      workspaceRows.map((row) => [row.directory, row.id] as const),
    );
    const projectRows = tx
      .select({ id: projects.id, directory: projects.directory, gitRemote: projects.gitRemote })
      .from(projects)
      .all();
    const projectIdsByDirectory = new Map(
      projectRows.map((row) => [row.directory, row.id] as const),
    );
    const projectIdsByRemote = new Map(
      projectRows
        .filter((row): row is typeof row & { gitRemote: string } => row.gitRemote !== null)
        .map((row) => [row.gitRemote, row.id] as const),
    );
    for (const record of records) {
      const normalizedDirectory = normalizeWorkspaceId(record.cwd);
      if (workspaceIdsByDirectory.has(normalizedDirectory)) {
        continue;
      }

      const timestamp = record.updatedAt ?? record.createdAt;
      const gitInfo = detectGitInfoForCwd(record.cwd);
      const resolvedDirectory = gitInfo?.toplevel
        ? normalizeWorkspaceId(gitInfo.toplevel)
        : normalizedDirectory;
      const projectDisplayName =
        gitInfo?.metadata.projectDisplayName ??
        resolvedDirectory.split(/[\\/]/).filter(Boolean).at(-1) ??
        resolvedDirectory;
      const projectKind = gitInfo?.metadata.projectKind ?? "directory";
      const gitRemote = gitInfo?.metadata.gitRemote ?? null;
      const workspaceKind = gitInfo?.metadata.isWorktree ? "worktree" : "checkout";
      const workspaceDisplayName =
        gitInfo?.metadata.workspaceDisplayName ??
        normalizedDirectory.split(/[\\/]/).filter(Boolean).at(-1) ??
        normalizedDirectory;

      let projectId =
        projectIdsByDirectory.get(resolvedDirectory) ??
        (gitRemote !== null ? projectIdsByRemote.get(gitRemote) : undefined);
      if (projectId === undefined) {
        const projectRow = tx
          .insert(projects)
          .values({
            directory: resolvedDirectory,
            displayName: projectDisplayName,
            kind: projectKind,
            gitRemote,
            createdAt: record.createdAt,
            updatedAt: timestamp,
            archivedAt: null,
          })
          .returning({ id: projects.id })
          .get();
        projectId = projectRow!.id;
        projectIdsByDirectory.set(resolvedDirectory, projectId);
        if (gitRemote !== null) {
          projectIdsByRemote.set(gitRemote, projectId);
        }
      }

      const workspaceRow = tx
        .insert(workspaces)
        .values({
          projectId,
          directory: normalizedDirectory,
          displayName: workspaceDisplayName,
          kind: workspaceKind,
          createdAt: record.createdAt,
          updatedAt: timestamp,
          archivedAt: null,
        })
        .returning({ id: workspaces.id })
        .get();
      workspaceIdsByDirectory.set(normalizedDirectory, workspaceRow!.id);
    }
    const rows = records.flatMap((record) => {
      const workspaceId = workspaceIdsByDirectory.get(normalizeWorkspaceId(record.cwd));
      if (workspaceId === undefined) {
        return [];
      }
      const clampedRecord =
        record.lastStatus === "running" || record.lastStatus === "initializing"
          ? { ...record, lastStatus: "closed" as const }
          : record;
      return [toAgentSnapshotRowValues({ record: clampedRecord, workspaceId })];
    });
    const totalBatches = Math.ceil(rows.length / MAX_AGENT_SNAPSHOT_ROWS_PER_INSERT);
    for (
      let startIndex = 0;
      startIndex < rows.length;
      startIndex += MAX_AGENT_SNAPSHOT_ROWS_PER_INSERT
    ) {
      const batch = rows.slice(startIndex, startIndex + MAX_AGENT_SNAPSHOT_ROWS_PER_INSERT);
      const batchNum = Math.floor(startIndex / MAX_AGENT_SNAPSHOT_ROWS_PER_INSERT) + 1;
      const rowsProcessed = startIndex + batch.length;
      options.logger.info(
        { batch: batchNum, totalBatches, rowsProcessed },
        "Importing agent snapshot batch",
      );
      tx.insert(agentSnapshots).values(batch).run();
    }
  });

  options.logger.info(
    { importedAgents: records.length },
    "Imported legacy agent snapshots into the database",
  );

  return {
    status: "imported",
    importedAgents: records.length,
  };
}

async function readLegacyAgentRecords(
  baseDir: string,
  logger: Logger,
): Promise<{
  records: StoredAgentRecord[];
  skippedCount: number;
}> {
  let entries: Array<import("node:fs").Dirent> = [];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], skippedCount: 0 };
    }
    throw error;
  }

  const recordsById = new Map<string, StoredAgentRecord>();
  let skippedCount = 0;
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      const record = await readRecordFile(path.join(baseDir, entry.name), logger);
      if (record) {
        recordsById.set(record.id, record);
      } else {
        skippedCount += 1;
      }
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    let childEntries: Array<import("node:fs").Dirent> = [];
    try {
      childEntries = await fs.readdir(path.join(baseDir, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const childEntry of childEntries) {
      if (!childEntry.isFile() || !childEntry.name.endsWith(".json")) {
        continue;
      }
      const record = await readRecordFile(path.join(baseDir, entry.name, childEntry.name), logger);
      if (record) {
        recordsById.set(record.id, record);
      } else {
        skippedCount += 1;
      }
    }
  }

  return {
    records: Array.from(recordsById.values()),
    skippedCount,
  };
}

async function readRecordFile(filePath: string, logger: Logger): Promise<StoredAgentRecord | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseStoredAgentRecord(JSON.parse(raw));
  } catch (error) {
    logger.error({ err: error, filePath }, "Skipping invalid legacy agent snapshot");
    return null;
  }
}

async function hasAnyAgentSnapshotRows(db: PaseoDatabaseHandle["db"]): Promise<boolean> {
  const rows = await db.select({ count: count() }).from(agentSnapshots);
  return (rows[0]?.count ?? 0) > 0;
}

async function backupLegacyAgentDirectory(options: {
  sourceDir: string;
  paseoHome: string;
  logger: Logger;
}): Promise<void> {
  const backupPath = path.join(options.paseoHome, "backup", "pre-migration", "agents");
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.cp(options.sourceDir, backupPath, { recursive: true });
  options.logger.info({ backupPath }, "Backed up legacy agent snapshots before migration");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function detectGitInfoForCwd(
  cwd: string,
): { toplevel: string; metadata: ReturnType<typeof detectWorkspaceGitMetadata> } | null {
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", {
      cwd,
      env: READ_ONLY_GIT_ENV,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!toplevel) {
      return null;
    }
    const directoryName = toplevel.split(/[\\/]/).filter(Boolean).at(-1) ?? toplevel;
    const metadata = detectWorkspaceGitMetadata(cwd, directoryName);
    return { toplevel, metadata };
  } catch {
    return null;
  }
}
