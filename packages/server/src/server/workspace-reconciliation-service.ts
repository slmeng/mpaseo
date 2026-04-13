import { existsSync } from "node:fs";
import type pino from "pino";
import type {
  ProjectRegistry,
  WorkspaceRegistry,
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { detectWorkspaceGitMetadata } from "./workspace-git-metadata.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

export type ReconciliationChange =
  | { kind: "workspace_archived"; workspaceId: number; directory: string; reason: string }
  | { kind: "project_archived"; projectId: number; directory: string; reason: string }
  | {
      kind: "project_updated";
      projectId: number;
      directory: string;
      fields: Partial<Pick<PersistedProjectRecord, "kind" | "displayName" | "gitRemote">>;
    }
  | {
      kind: "workspace_updated";
      workspaceId: number;
      directory: string;
      fields: Partial<Pick<PersistedWorkspaceRecord, "displayName">>;
    };

export type ReconciliationResult = {
  changesApplied: ReconciliationChange[];
  durationMs: number;
};

export type WorkspaceReconciliationServiceOptions = {
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  logger: pino.Logger;
  intervalMs?: number;
  onChanges?: (changes: ReconciliationChange[]) => void;
};

export class WorkspaceReconciliationService {
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly logger: pino.Logger;
  private readonly intervalMs: number;
  private readonly onChanges: ((changes: ReconciliationChange[]) => void) | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: WorkspaceReconciliationServiceOptions) {
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.logger = options.logger.child({ module: "workspace-reconciliation" });
    this.intervalMs = options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.onChanges = options.onChanges ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.logger.info({ intervalMs: this.intervalMs }, "Starting workspace reconciliation service");
    this.timer = setInterval(() => void this.runSafe(), this.intervalMs);
    // Run once immediately on start
    void this.runSafe();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<ReconciliationResult> {
    return this.reconcile();
  }

  private async runSafe(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.reconcile();
      if (result.changesApplied.length > 0) {
        this.logger.info(
          { changeCount: result.changesApplied.length, durationMs: result.durationMs },
          "Reconciliation pass completed with changes",
        );
      }
    } catch (error) {
      this.logger.error({ err: error }, "Reconciliation pass failed");
    } finally {
      this.running = false;
    }
  }

  private async reconcile(): Promise<ReconciliationResult> {
    const start = Date.now();
    const changes: ReconciliationChange[] = [];

    const allProjects = await this.projectRegistry.list();
    const allWorkspaces = await this.workspaceRegistry.list();

    const activeProjects = allProjects.filter((p) => !p.archivedAt);
    const activeWorkspaces = allWorkspaces.filter((w) => !w.archivedAt);

    const workspacesByProject = new Map<number, PersistedWorkspaceRecord[]>();
    for (const workspace of activeWorkspaces) {
      const list = workspacesByProject.get(workspace.projectId) ?? [];
      list.push(workspace);
      workspacesByProject.set(workspace.projectId, list);
    }

    // 1. Archive workspaces whose directories no longer exist
    for (const workspace of activeWorkspaces) {
      if (!existsSync(workspace.directory)) {
        const timestamp = new Date().toISOString();
        await this.workspaceRegistry.archive(workspace.id, timestamp);
        changes.push({
          kind: "workspace_archived",
          workspaceId: workspace.id,
          directory: workspace.directory,
          reason: "directory_missing",
        });

        // Update the in-memory list for the project orphan check below
        const siblings = workspacesByProject.get(workspace.projectId);
        if (siblings) {
          const updated = siblings.filter((w) => w.id !== workspace.id);
          workspacesByProject.set(workspace.projectId, updated);
        }
      }
    }

    // 2. Archive orphaned projects (all workspaces archived/removed)
    for (const project of activeProjects) {
      const siblings = workspacesByProject.get(project.id) ?? [];
      if (siblings.length === 0) {
        const timestamp = new Date().toISOString();
        await this.projectRegistry.archive(project.id, timestamp);
        changes.push({
          kind: "project_archived",
          projectId: project.id,
          directory: project.directory,
          reason: "no_active_workspaces",
        });
      }
    }

    // 3. Reconcile git metadata for active projects whose directories still exist
    for (const project of activeProjects) {
      if (project.archivedAt) continue;
      const siblings = workspacesByProject.get(project.id) ?? [];
      if (siblings.length === 0) continue;
      if (!existsSync(project.directory)) continue;

      const directoryName =
        project.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? project.directory;
      const currentGit = detectWorkspaceGitMetadata(project.directory, directoryName);

      const projectUpdates: Partial<
        Pick<PersistedProjectRecord, "kind" | "displayName" | "gitRemote">
      > = {};

      // Detect kind change: directory → git
      if (project.kind !== currentGit.projectKind) {
        projectUpdates.kind = currentGit.projectKind;
        projectUpdates.displayName = currentGit.projectDisplayName;
        projectUpdates.gitRemote = currentGit.gitRemote;
      }

      // Detect display name change (e.g. remote renamed)
      if (
        project.kind === "git" &&
        currentGit.projectKind === "git" &&
        project.displayName !== currentGit.projectDisplayName
      ) {
        projectUpdates.displayName = currentGit.projectDisplayName;
      }

      // Detect git remote change
      if (
        project.kind === "git" &&
        currentGit.projectKind === "git" &&
        project.gitRemote !== currentGit.gitRemote
      ) {
        projectUpdates.gitRemote = currentGit.gitRemote;
      }

      if (Object.keys(projectUpdates).length > 0) {
        const timestamp = new Date().toISOString();
        await this.projectRegistry.upsert({
          ...project,
          ...projectUpdates,
          updatedAt: timestamp,
        });
        changes.push({
          kind: "project_updated",
          projectId: project.id,
          directory: project.directory,
          fields: projectUpdates,
        });
      }

      // 4. Reconcile workspace display names (branch name changes)
      for (const workspace of siblings) {
        if (!existsSync(workspace.directory)) continue;

        const wsDirName =
          workspace.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace.directory;
        const wsGit = detectWorkspaceGitMetadata(workspace.directory, wsDirName);

        if (wsGit.projectKind === "git" && workspace.displayName !== wsGit.workspaceDisplayName) {
          const timestamp = new Date().toISOString();
          await this.workspaceRegistry.upsert({
            ...workspace,
            displayName: wsGit.workspaceDisplayName,
            updatedAt: timestamp,
          });
          changes.push({
            kind: "workspace_updated",
            workspaceId: workspace.id,
            directory: workspace.directory,
            fields: { displayName: wsGit.workspaceDisplayName },
          });
        }
      }
    }

    if (changes.length > 0 && this.onChanges) {
      this.onChanges(changes);
    }

    return { changesApplied: changes, durationMs: Date.now() - start };
  }
}
