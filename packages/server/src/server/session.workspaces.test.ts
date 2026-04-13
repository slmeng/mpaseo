import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { Session } from "./session.js";
import type { AgentSnapshotPayload } from "../shared/messages.js";
import type { WorkspaceGitRuntimeSnapshot } from "./workspace-git-service.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";

vi.mock("@getpaseo/highlight", () => ({
  highlightCode: vi.fn(async () => ""),
  isLanguageSupported: vi.fn(() => false),
}));

function makeAgent(input: {
  id: string;
  cwd: string;
  status: AgentSnapshotPayload["status"];
  updatedAt: string;
  pendingPermissions?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentSnapshotPayload["attentionReason"];
}): AgentSnapshotPayload {
  const pendingPermissionCount = input.pendingPermissions ?? 0;
  return {
    id: input.id,
    provider: "codex",
    cwd: input.cwd,
    model: null,
    thinkingOptionId: null,
    effectiveThinkingOptionId: null,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    lastUserMessageAt: null,
    status: input.status,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: Array.from({ length: pendingPermissionCount }, (_, index) => ({
      id: `perm-${input.id}-${index}`,
      provider: "codex",
      name: "tool",
      kind: "tool",
    })),
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: null,
    },
    title: null,
    labels: {},
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    attentionTimestamp: null,
    archivedAt: null,
  };
}

function createNoopWorkspaceGitService() {
  return {
    subscribe: async (params: { cwd: string }) => ({
      initial: {
        cwd: params.cwd,
        git: {
          isGit: false,
          repoRoot: null,
          mainRepoRoot: null,
          currentBranch: null,
          remoteUrl: null,
          isPaseoOwnedWorktree: false,
          isDirty: null,
          aheadBehind: null,
          aheadOfOrigin: null,
          behindOfOrigin: null,
          diffStat: null,
        },
        github: {
          featuresEnabled: false,
          pullRequest: null,
          error: null,
          refreshedAt: null,
        },
      },
      unsubscribe: () => {},
    }),
    peekSnapshot: (_cwd: string) => null,
    getSnapshot: async (cwd: string) => ({
      cwd,
      git: {
        isGit: false,
        repoRoot: null,
        mainRepoRoot: null,
        currentBranch: null,
        remoteUrl: null,
        isPaseoOwnedWorktree: false,
        isDirty: null,
        aheadBehind: null,
        aheadOfOrigin: null,
        behindOfOrigin: null,
        diffStat: null,
      },
      github: {
        featuresEnabled: false,
        pullRequest: null,
        error: null,
        refreshedAt: null,
      },
    }),
    refresh: async () => {},
    dispose: () => {},
  };
}

function createWorkspaceRuntimeSnapshot(
  cwd: string,
  overrides?: {
    git?: Partial<WorkspaceGitRuntimeSnapshot["git"]>;
    github?: Partial<WorkspaceGitRuntimeSnapshot["github"]>;
  },
): WorkspaceGitRuntimeSnapshot {
  const base: WorkspaceGitRuntimeSnapshot = {
    cwd,
    git: {
      isGit: true,
      repoRoot: cwd,
      mainRepoRoot: null,
      currentBranch: "main",
      remoteUrl: "https://github.com/acme/repo.git",
      isPaseoOwnedWorktree: false,
      isDirty: false,
      aheadBehind: { ahead: 0, behind: 0 },
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
      diffStat: { additions: 1, deletions: 0 },
    },
    github: {
      featuresEnabled: true,
      pullRequest: {
        url: "https://github.com/acme/repo/pull/123",
        title: "Runtime payloads",
        state: "open",
        baseRefName: "main",
        headRefName: "feature/runtime-payloads",
        isMerged: false,
      },
      error: null,
      refreshedAt: "2026-04-12T00:00:00.000Z",
    },
  };

  return {
    cwd,
    git: {
      ...base.git,
      ...overrides?.git,
    },
    github: {
      ...base.github,
      ...overrides?.github,
      pullRequest:
        overrides?.github && "pullRequest" in overrides.github
          ? (overrides.github.pullRequest ?? null)
          : base.github.pullRequest,
      error:
        overrides?.github && "error" in overrides.github
          ? (overrides.github.error ?? null)
          : base.github.error,
    },
  };
}

function createSessionForWorkspaceTests(
  options: {
    appVersion?: string | null;
    workspaceGitService?: ReturnType<typeof createNoopWorkspaceGitService>;
  } = {},
): {
  session: Session;
  emitted: Array<{ type: string; payload: unknown }>;
  projects: Map<number, ReturnType<typeof createPersistedProjectRecord>>;
  workspaces: Map<number, ReturnType<typeof createPersistedWorkspaceRecord>>;
} {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const projects = new Map<number, ReturnType<typeof createPersistedProjectRecord>>();
  const workspaces = new Map<number, ReturnType<typeof createPersistedWorkspaceRecord>>();
  let nextProjectId = 1;
  let nextWorkspaceId = 1;
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const session = new Session({
    clientId: "test-client",
    appVersion: options.appVersion ?? null,
    onMessage: (message) => emitted.push(message as any),
    logger: logger as any,
    downloadTokenStore: {} as any,
    pushTokenStore: {} as any,
    paseoHome: "/tmp/paseo-test",
    agentManager: {
      subscribe: () => () => {},
      listAgents: () => [],
      getAgent: () => null,
      archiveAgent: async () => ({ archivedAt: new Date().toISOString() }),
      clearAgentAttention: async () => {},
      notifyAgentState: () => {},
    } as any,
    agentStorage: {
      list: async () => [],
      get: async () => null,
    } as any,
    projectRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => Array.from(projects.values()),
      get: async (id: number) => projects.get(id) ?? null,
      insert: async (record: Omit<ReturnType<typeof createPersistedProjectRecord>, "id">) => {
        const id = nextProjectId++;
        projects.set(id, createPersistedProjectRecord({ id, ...record }));
        return id;
      },
      upsert: async (record: ReturnType<typeof createPersistedProjectRecord>) => {
        projects.set(record.id, record);
      },
      archive: async (id: number, archivedAt: string) => {
        const existing = projects.get(id);
        if (!existing) {
          return;
        }
        projects.set(id, {
          ...existing,
          archivedAt,
          updatedAt: archivedAt,
        });
      },
      remove: async (id: number) => {
        projects.delete(id);
      },
    } as any,
    workspaceRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => Array.from(workspaces.values()),
      get: async (id: number) => workspaces.get(id) ?? null,
      insert: async (record: Omit<ReturnType<typeof createPersistedWorkspaceRecord>, "id">) => {
        const id = nextWorkspaceId++;
        workspaces.set(id, createPersistedWorkspaceRecord({ id, ...record }));
        return id;
      },
      upsert: async (record: ReturnType<typeof createPersistedWorkspaceRecord>) => {
        workspaces.set(record.id, record);
      },
      archive: async (id: number, archivedAt: string) => {
        const existing = workspaces.get(id);
        if (!existing) {
          return;
        }
        workspaces.set(id, {
          ...existing,
          archivedAt,
          updatedAt: archivedAt,
        });
      },
      remove: async (id: number) => {
        workspaces.delete(id);
      },
    } as any,
    checkoutDiffManager: {
      subscribe: async () => ({
        initial: { cwd: "/tmp", files: [], error: null },
        unsubscribe: () => {},
      }),
      scheduleRefreshForCwd: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    } as any,
    workspaceGitService: (options.workspaceGitService ?? createNoopWorkspaceGitService()) as any,
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    terminalManager: null,
  }) as any;

  return { session, emitted, projects, workspaces };
}

function seedProject(options: {
  projects: Map<number, ReturnType<typeof createPersistedProjectRecord>>;
  id: number;
  directory: string;
  displayName: string;
  kind?: "git" | "directory";
  gitRemote?: string | null;
}) {
  const record = createPersistedProjectRecord({
    id: options.id,
    directory: options.directory,
    displayName: options.displayName,
    kind: options.kind ?? "directory",
    gitRemote: options.gitRemote ?? null,
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  options.projects.set(record.id, record);
  return record;
}

function seedWorkspace(options: {
  workspaces: Map<number, ReturnType<typeof createPersistedWorkspaceRecord>>;
  id: number;
  projectId: number;
  directory: string;
  displayName: string;
  kind?: "checkout" | "worktree";
}) {
  const record = createPersistedWorkspaceRecord({
    id: options.id,
    projectId: options.projectId,
    directory: options.directory,
    displayName: options.displayName,
    kind: options.kind ?? "checkout",
    createdAt: "2026-03-01T12:00:00.000Z",
    updatedAt: "2026-03-01T12:00:00.000Z",
  });
  options.workspaces.set(record.id, record);
  return record;
}

function createTempGitRepo(options?: { remoteUrl?: string; branchName?: string }): {
  tempDir: string;
  repoDir: string;
} {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-workspace-git-")));
  const repoDir = path.join(tempDir, "repo");
  execSync(`mkdir -p ${repoDir}`);
  execSync(`git init -b ${options?.branchName ?? "main"}`, { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "file.txt"), "hello\n");
  execSync("git add .", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });
  if (options?.remoteUrl) {
    execSync(`git remote add origin ${JSON.stringify(options.remoteUrl)}`, {
      cwd: repoDir,
      stdio: "pipe",
    });
  }
  return { tempDir, repoDir };
}

describe("workspace aggregation", () => {
  test("archive request emits agent_archived and an authoritative agent_update", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const archivedRecord = {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/repo",
      createdAt: "2026-03-30T15:00:00.000Z",
      updatedAt: "2026-03-30T15:00:00.000Z",
      lastActivityAt: "2026-03-30T15:00:00.000Z",
      lastUserMessageAt: null,
      lastStatus: "idle" as const,
      lastModeId: null,
      runtimeInfo: null,
      config: {
        provider: "codex",
        cwd: "/tmp/repo",
      },
      persistence: null,
      title: "Archive me",
      labels: {},
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null as string | null,
    };
    const projects = new Map<number, ReturnType<typeof createPersistedProjectRecord>>();
    const workspaces = new Map<number, ReturnType<typeof createPersistedWorkspaceRecord>>();
    seedProject({
      projects,
      id: 1,
      directory: "/tmp/repo",
      displayName: "repo",
    });
    seedWorkspace({
      workspaces,
      id: 10,
      projectId: 1,
      directory: "/tmp/repo",
      displayName: "repo",
    });
    const logger = {
      child: () => logger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const closeAgent = vi.fn(async () => undefined);
    const session = new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message as any),
      logger: logger as any,
      downloadTokenStore: {} as any,
      pushTokenStore: {} as any,
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) => (agentId === "agent-1" ? { id: agentId } : null),
        archiveAgent: async () => {
          const archivedAt = new Date().toISOString();
          archivedRecord.archivedAt = archivedAt;
          archivedRecord.updatedAt = archivedAt;
          return { archivedAt };
        },
        clearAgentAttention: async () => {},
      } as any,
      agentStorage: {
        list: async () => [],
        get: async (agentId: string) => (agentId === archivedRecord.id ? archivedRecord : null),
      } as any,
      projectRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => Array.from(projects.values()),
        get: async (id: number) => projects.get(id) ?? null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      workspaceRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => Array.from(workspaces.values()),
        get: async (id: number) => workspaces.get(id) ?? null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      checkoutDiffManager: {
        subscribe: async () => ({
          initial: { cwd: "/tmp/repo", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      } as any,
      workspaceGitService: createNoopWorkspaceGitService() as any,
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: null,
    }) as any;

    session.agentUpdatesSubscription = {
      subscriptionId: "sub-agents",
      filter: { includeArchived: true },
      isBootstrapping: false,
      pendingUpdatesByAgentId: new Map(),
    };
    session.interruptAgentIfRunning = vi.fn();

    await session.handleArchiveAgentRequest("agent-1", "req-archive");

    expect(session.interruptAgentIfRunning).toHaveBeenCalledWith("agent-1");
    const update = emitted.find((message) => message.type === "agent_update");
    expect(update?.payload).toMatchObject({
      kind: "upsert",
      agent: {
        id: "agent-1",
        archivedAt: expect.any(String),
      },
    });
    const archivedPayload = emitted.find((message) => message.type === "agent_archived")?.payload;
    expect(archivedPayload).toMatchObject({
      agentId: "agent-1",
      archivedAt: expect.any(String),
      requestId: "req-archive",
    });
    expect(archivedRecord.archivedAt).toBe(archivedPayload.archivedAt);
  });

  test("close_items_request archives agents and kills terminals in one batch", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const archivedAt = "2026-04-01T00:00:00.000Z";
    const archivedRecord = {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
      lastActivityAt: "2026-03-01T12:00:00.000Z",
      lastUserMessageAt: null,
      lastStatus: "idle" as const,
      lastModeId: null,
      runtimeInfo: null,
      config: null,
      persistence: null,
      title: null,
      labels: {},
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null as string | null,
    };
    const projects = new Map<number, ReturnType<typeof createPersistedProjectRecord>>();
    const workspaces = new Map<number, ReturnType<typeof createPersistedWorkspaceRecord>>();
    seedProject({
      projects,
      id: 2,
      directory: "/tmp/repo",
      displayName: "repo",
    });
    seedWorkspace({
      workspaces,
      id: 20,
      projectId: 2,
      directory: "/tmp/repo",
      displayName: "repo",
    });
    const sessionLogger = {
      child: () => sessionLogger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const session = new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message as any),
      logger: sessionLogger as any,
      downloadTokenStore: {} as any,
      pushTokenStore: {} as any,
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) => (agentId === "agent-1" ? { id: agentId } : null),
        archiveAgent: async () => {
          archivedRecord.archivedAt = archivedAt;
          archivedRecord.updatedAt = archivedAt;
          return { archivedAt };
        },
        clearAgentAttention: async () => {},
      } as any,
      agentStorage: {
        list: async () => [],
        get: async (agentId: string) => (agentId === archivedRecord.id ? archivedRecord : null),
      } as any,
      projectRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => Array.from(projects.values()),
        get: async (id: number) => projects.get(id) ?? null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      workspaceRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => Array.from(workspaces.values()),
        get: async (id: number) => workspaces.get(id) ?? null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      checkoutDiffManager: {
        subscribe: async () => ({
          initial: { cwd: "/tmp", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      } as any,
      workspaceGitService: createNoopWorkspaceGitService() as any,
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: {
        killTerminal: vi.fn(),
        subscribeTerminalsChanged: () => () => {},
      } as any,
    }) as any;

    session.agentUpdatesSubscription = {
      subscriptionId: "sub-agents",
      filter: { includeArchived: true },
      isBootstrapping: false,
      pendingUpdatesByAgentId: new Map(),
    };
    session.interruptAgentIfRunning = vi.fn();

    await session.handleMessage({
      type: "close_items_request",
      agentIds: ["agent-1"],
      terminalIds: ["term-1"],
      requestId: "req-close-items",
    });

    expect(session.interruptAgentIfRunning).toHaveBeenCalledWith("agent-1");
    expect(session.terminalManager.killTerminal).toHaveBeenCalledWith("term-1");
    expect(emitted.find((message) => message.type === "close_items_response")?.payload).toEqual({
      agents: [{ agentId: "agent-1", archivedAt }],
      terminals: [{ terminalId: "term-1", success: true }],
      requestId: "req-close-items",
    });
    expect(emitted.find((message) => message.type === "agent_update")?.payload).toMatchObject({
      kind: "upsert",
      agent: {
        id: "agent-1",
        archivedAt,
      },
    });
  });

  test("close_items_request archives stored agents that are not currently loaded", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const sessionLogger = {
      child: () => sessionLogger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const liveArchivedAt = "2026-04-01T00:00:00.000Z";
    const storedAgentId = "agent-stored";
    const liveRecord = {
      id: "agent-live",
      provider: "codex",
      cwd: "/tmp/repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
      lastActivityAt: "2026-03-01T12:00:00.000Z",
      lastUserMessageAt: null,
      lastStatus: "idle" as const,
      lastModeId: null,
      runtimeInfo: null,
      config: null,
      persistence: null,
      title: null,
      labels: {},
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null as string | null,
    };
    const storedRecord = {
      id: storedAgentId,
      provider: "codex",
      cwd: "/tmp/repo",
      createdAt: "2026-03-01T12:05:00.000Z",
      updatedAt: "2026-03-01T12:05:00.000Z",
      lastActivityAt: "2026-03-01T12:05:00.000Z",
      lastUserMessageAt: null,
      lastStatus: "idle" as const,
      lastModeId: null,
      runtimeInfo: null,
      config: null,
      persistence: null,
      title: null,
      labels: {},
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null as string | null,
    };
    const upsertStoredRecord = vi.fn(async (record: typeof storedRecord) => {
      if (record.id !== storedAgentId) {
        return;
      }
      storedRecord.archivedAt = record.archivedAt;
      storedRecord.updatedAt = record.updatedAt;
      storedRecord.lastStatus = record.lastStatus;
      storedRecord.requiresAttention = record.requiresAttention;
      storedRecord.attentionReason = record.attentionReason;
      storedRecord.attentionTimestamp = record.attentionTimestamp;
    });
    const projects = new Map<number, ReturnType<typeof createPersistedProjectRecord>>();
    const workspaces = new Map<number, ReturnType<typeof createPersistedWorkspaceRecord>>();
    seedProject({
      projects,
      id: 3,
      directory: "/tmp/repo",
      displayName: "repo",
    });
    seedWorkspace({
      workspaces,
      id: 30,
      projectId: 3,
      directory: "/tmp/repo",
      displayName: "repo",
    });

    const archiveSnapshot = vi.fn(async (_agentId: string, archivedAt: string) => {
      storedRecord.archivedAt = archivedAt;
      storedRecord.updatedAt = archivedAt;
      return { ...storedRecord, archivedAt, updatedAt: archivedAt };
    });

    const session = new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message as any),
      logger: sessionLogger as any,
      downloadTokenStore: {} as any,
      pushTokenStore: {} as any,
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) => (agentId === "agent-live" ? { id: agentId } : null),
        archiveAgent: async (agentId: string) => {
          if (agentId !== "agent-live") {
            throw new Error(`Unexpected live archive: ${agentId}`);
          }
          liveRecord.archivedAt = liveArchivedAt;
          liveRecord.updatedAt = liveArchivedAt;
          return { archivedAt: liveArchivedAt };
        },
        archiveSnapshot,
        clearAgentAttention: async () => {},
      } as any,
      agentStorage: {
        list: async () => [],
        get: async (agentId: string) => {
          if (agentId === "agent-live") {
            return liveRecord;
          }
          if (agentId === storedAgentId) {
            return storedRecord;
          }
          return null;
        },
        upsert: upsertStoredRecord,
      } as any,
      projectRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => Array.from(projects.values()),
        get: async (id: number) => projects.get(id) ?? null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      workspaceRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => Array.from(workspaces.values()),
        get: async (id: number) => workspaces.get(id) ?? null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      checkoutDiffManager: {
        subscribe: async () => ({
          initial: { cwd: "/tmp", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      } as any,
      workspaceGitService: createNoopWorkspaceGitService() as any,
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: {
        killTerminal: vi.fn(),
        subscribeTerminalsChanged: () => () => {},
      } as any,
    }) as any;

    session.agentUpdatesSubscription = {
      subscriptionId: "sub-agents",
      filter: { includeArchived: true },
      isBootstrapping: false,
      pendingUpdatesByAgentId: new Map(),
    };
    session.interruptAgentIfRunning = vi.fn();

    await session.handleMessage({
      type: "close_items_request",
      agentIds: ["agent-live", storedAgentId],
      terminalIds: [],
      requestId: "req-close-stored",
    });

    expect(archiveSnapshot).toHaveBeenCalledTimes(1);
    expect(archiveSnapshot).toHaveBeenCalledWith(storedAgentId, expect.any(String));
    expect(storedRecord.archivedAt).toEqual(expect.any(String));
    expect(emitted.find((message) => message.type === "close_items_response")?.payload).toEqual({
      agents: [
        { agentId: "agent-live", archivedAt: liveArchivedAt },
        { agentId: storedAgentId, archivedAt: storedRecord.archivedAt },
      ],
      terminals: [],
      requestId: "req-close-stored",
    });
    expect(sessionLogger.warn).not.toHaveBeenCalled();
  });

  test("close_items_request continues after an archive failure", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const sessionLogger = {
      child: () => sessionLogger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const archivedAt = "2026-04-01T00:00:00.000Z";
    const goodRecord = {
      id: "agent-good",
      provider: "codex",
      cwd: "/tmp/repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
      lastActivityAt: "2026-03-01T12:00:00.000Z",
      lastUserMessageAt: null,
      lastStatus: "idle" as const,
      lastModeId: null,
      runtimeInfo: null,
      config: null,
      persistence: null,
      title: null,
      labels: {},
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null as string | null,
    };
    const projects = new Map<number, ReturnType<typeof createPersistedProjectRecord>>();
    const workspaces = new Map<number, ReturnType<typeof createPersistedWorkspaceRecord>>();
    seedProject({
      projects,
      id: 4,
      directory: "/tmp/repo",
      displayName: "repo",
    });
    seedWorkspace({
      workspaces,
      id: 40,
      projectId: 4,
      directory: "/tmp/repo",
      displayName: "repo",
    });

    const session = new Session({
      clientId: "test-client",
      onMessage: (message) => emitted.push(message as any),
      logger: sessionLogger as any,
      downloadTokenStore: {} as any,
      pushTokenStore: {} as any,
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: (agentId: string) =>
          agentId === "agent-bad" || agentId === "agent-good" ? { id: agentId } : null,
        archiveAgent: async (agentId: string) => {
          if (agentId === "agent-bad") {
            throw new Error("archive failed");
          }
          goodRecord.archivedAt = archivedAt;
          goodRecord.updatedAt = archivedAt;
          return { archivedAt };
        },
        clearAgentAttention: async () => {},
      } as any,
      agentStorage: {
        list: async () => [],
        get: async (agentId: string) => (agentId === "agent-good" ? goodRecord : null),
      } as any,
      projectRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => Array.from(projects.values()),
        get: async (id: number) => projects.get(id) ?? null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      workspaceRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => Array.from(workspaces.values()),
        get: async (id: number) => workspaces.get(id) ?? null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      checkoutDiffManager: {
        subscribe: async () => ({
          initial: { cwd: "/tmp", files: [], error: null },
          unsubscribe: () => {},
        }),
        scheduleRefreshForCwd: () => {},
        getMetrics: () => ({
          checkoutDiffTargetCount: 0,
          checkoutDiffSubscriptionCount: 0,
          checkoutDiffWatcherCount: 0,
          checkoutDiffFallbackRefreshTargetCount: 0,
        }),
        dispose: () => {},
      } as any,
      workspaceGitService: createNoopWorkspaceGitService() as any,
      mcpBaseUrl: null,
      stt: null,
      tts: null,
      terminalManager: {
        killTerminal: vi.fn(),
        subscribeTerminalsChanged: () => () => {},
      } as any,
    }) as any;

    session.agentUpdatesSubscription = {
      subscriptionId: "sub-agents",
      filter: { includeArchived: true },
      isBootstrapping: false,
      pendingUpdatesByAgentId: new Map(),
    };
    session.interruptAgentIfRunning = vi.fn();

    await session.handleMessage({
      type: "close_items_request",
      agentIds: ["agent-bad", "agent-good"],
      terminalIds: ["term-1"],
      requestId: "req-close-best-effort",
    });

    expect(session.interruptAgentIfRunning).toHaveBeenCalledWith("agent-bad");
    expect(session.interruptAgentIfRunning).toHaveBeenCalledWith("agent-good");
    expect(session.terminalManager.killTerminal).toHaveBeenCalledWith("term-1");
    expect(emitted.find((message) => message.type === "close_items_response")?.payload).toEqual({
      agents: [{ agentId: "agent-good", archivedAt }],
      terminals: [{ terminalId: "term-1", success: true }],
      requestId: "req-close-best-effort",
    });
    expect(emitted.find((message) => message.type === "agent_update")?.payload).toMatchObject({
      kind: "upsert",
      agent: {
        id: "agent-good",
        archivedAt,
      },
    });
    expect(sessionLogger.warn).toHaveBeenCalled();
  });

  test("uses persisted workspace names and stable status aggregation", async () => {
    const { session, projects, workspaces } = createSessionForWorkspaceTests();
    seedProject({
      projects,
      id: 1,
      directory: "/tmp/repo",
      displayName: "repo",
      kind: "directory",
    });
    seedWorkspace({
      workspaces,
      id: 10,
      projectId: 1,
      directory: "/tmp/repo",
      displayName: "repo",
    });

    (session as any).listAgentPayloads = async () => [
      makeAgent({
        id: "a1",
        cwd: "/tmp/repo",
        status: "running",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
      makeAgent({
        id: "a2",
        cwd: "/tmp/repo",
        status: "idle",
        updatedAt: "2026-03-01T12:01:00.000Z",
        pendingPermissions: 1,
      }),
    ];

    const result = await (session as any).listFetchWorkspacesEntries({
      type: "fetch_workspaces_request",
      requestId: "req-1",
    });

    expect(result.entries).toEqual([
      expect.objectContaining({
        id: "/tmp/repo",
        projectId: "/tmp/repo",
        name: "repo",
        projectKind: "non_git",
        workspaceKind: "local_checkout",
        status: "needs_input",
      }),
    ]);
  });

  test("keeps persisted git worktree display names", async () => {
    const { session, projects, workspaces } = createSessionForWorkspaceTests();
    seedProject({
      projects,
      id: 2,
      directory: "/tmp/repo",
      displayName: "repo",
      kind: "git",
      gitRemote: "https://github.com/acme/repo.git",
    });
    seedWorkspace({
      workspaces,
      id: 20,
      projectId: 2,
      directory: "/tmp/repo/.paseo/worktrees/feature-name",
      displayName: "feature-name",
      kind: "worktree",
    });

    (session as any).listAgentPayloads = async () => [
      makeAgent({
        id: "a1",
        cwd: "/tmp/repo/.paseo/worktrees/feature-name",
        status: "running",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    ];

    const result = await (session as any).listFetchWorkspacesEntries({
      type: "fetch_workspaces_request",
      requestId: "req-branch",
    });

    expect(result.entries[0]).toMatchObject({
      id: "/tmp/repo",
      status: "running",
      activityAt: null,
    });
  });

  test("workspace update stream keeps persisted workspace visible after agents stop", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    seedProject({
      projects,
      id: 3,
      directory: "/tmp/repo",
      displayName: "repo",
    });
    seedWorkspace({
      workspaces,
      id: 30,
      projectId: 3,
      directory: "/tmp/repo",
      displayName: "repo",
    });

    (session as any).workspaceUpdatesSubscription = {
      subscriptionId: "sub-1",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
      lastEmittedByWorkspaceId: new Map(),
    };
    (session as any).reconcileActiveWorkspaceRecords = async () => new Set();
    (session as any).buildWorkspaceDescriptorMap = async () =>
      new Map([
        [
          "/tmp/repo",
          {
            id: "/tmp/repo",
            projectId: "/tmp/repo",
            projectDisplayName: "repo",
            projectRootPath: "/tmp/repo",
            workspaceDirectory: "/tmp/repo",
            projectKind: "non_git",
            workspaceKind: "local_checkout",
            name: "repo",
            status: "running",
            activityAt: "2026-03-01T12:00:00.000Z",
            services: [],
          },
        ],
      ]);
    await (session as any).emitWorkspaceUpdateForCwd("/tmp/repo");

    (session as any).buildWorkspaceDescriptorMap = async () =>
      new Map([
        [
          "/tmp/repo",
          {
            id: "/tmp/repo",
            projectId: "/tmp/repo",
            projectDisplayName: "repo",
            projectRootPath: "/tmp/repo",
            workspaceDirectory: "/tmp/repo",
            projectKind: "non_git",
            workspaceKind: "local_checkout",
            name: "repo",
            status: "done",
            activityAt: null,
            services: [],
          },
        ],
      ]);
    await (session as any).emitWorkspaceUpdateForCwd("/tmp/repo");

    const workspaceUpdates = emitted.filter((message) => message.type === "workspace_update");
    expect(workspaceUpdates).toHaveLength(2);
    expect((workspaceUpdates[1] as any).payload).toEqual({
      kind: "upsert",
      workspace: {
        id: "/tmp/repo",
        projectId: "/tmp/repo",
        projectDisplayName: "repo",
        projectRootPath: "/tmp/repo",
        workspaceDirectory: "/tmp/repo",
        projectKind: "non_git",
        workspaceKind: "local_checkout",
        name: "repo",
        status: "done",
        activityAt: null,
        services: [],
      },
    });
  });

  test("create paseo worktree request inserts a workspace under the existing project", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-worktree-test-")));
    const repoDir = path.join(tempDir, "repo");
    const paseoHome = path.join(tempDir, "paseo-home");
    execSync(`mkdir -p ${repoDir}`);
    execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(path.join(repoDir, "file.txt"), "hello\n");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });

    (session as any).paseoHome = paseoHome;
    seedProject({
      projects,
      id: 4,
      directory: repoDir,
      displayName: "repo",
      kind: "git",
      gitRemote: "https://github.com/acme/repo.git",
    });
    seedWorkspace({
      workspaces,
      id: 40,
      projectId: 4,
      directory: repoDir,
      displayName: "main",
      kind: "checkout",
    });

    try {
      await (session as any).handleCreatePaseoWorktreeRequest({
        type: "create_paseo_worktree_request",
        cwd: repoDir,
        worktreeSlug: "worktree-123",
        requestId: "req-worktree",
      });

      const response = emitted.find(
        (message) => message.type === "create_paseo_worktree_response",
      ) as { type: "create_paseo_worktree_response"; payload: any } | undefined;

      expect(response?.payload.error).toBeNull();
      expect(response?.payload.workspace).toMatchObject({
        projectDisplayName: "repo",
        projectKind: "git",
        workspaceKind: "worktree",
        name: "worktree-123",
        status: "done",
      });
      expect(response?.payload.workspace?.id).toEqual(expect.any(String));
      expect(response?.payload.workspace?.id).toContain("worktree-123");
      // The worktree directory is created asynchronously in the background after
      // the response is sent, so we only verify the DB record here.
      const persistedWorkspace = Array.from(workspaces.values()).find(
        (ws) => ws.directory === response!.payload.workspace.id,
      );
      expect(persistedWorkspace).toBeTruthy();
      expect(persistedWorkspace?.directory).toContain(path.join("worktree-123"));
      expect(response?.payload.workspace?.projectId).toEqual(repoDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test("workspace update fanout for multiple cwd values is deduplicated", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const { session, projects, workspaces } = createSessionForWorkspaceTests();
    const sessionAny = session as any;
    seedProject({
      projects,
      id: 6,
      directory: "/tmp/repo",
      displayName: "repo",
      kind: "git",
    });
    seedWorkspace({
      workspaces,
      id: 60,
      projectId: 6,
      directory: "/tmp/repo",
      displayName: "main",
      kind: "checkout",
    });
    seedWorkspace({
      workspaces,
      id: 61,
      projectId: 6,
      directory: "/tmp/repo/worktree",
      displayName: "feature",
      kind: "worktree",
    });

    sessionAny.workspaceUpdatesSubscription = {
      subscriptionId: "sub-dedup",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
      lastEmittedByWorkspaceId: new Map(),
    };
    sessionAny.reconcileActiveWorkspaceRecords = async () => new Set();
    sessionAny.buildWorkspaceDescriptorMap = async () =>
      new Map([
        [
          "/tmp/repo",
          {
            id: "/tmp/repo",
            projectId: "/tmp/repo",
            projectDisplayName: "repo",
            projectRootPath: "/tmp/repo",
            workspaceDirectory: "/tmp/repo",
            projectKind: "git",
            workspaceKind: "local_checkout",
            name: "main",
            status: "done",
            activityAt: null,
            services: [],
          },
        ],
        [
          "/tmp/repo/worktree",
          {
            id: "/tmp/repo/worktree",
            projectId: "/tmp/repo",
            projectDisplayName: "repo",
            projectRootPath: "/tmp/repo",
            workspaceDirectory: "/tmp/repo/worktree",
            projectKind: "git",
            workspaceKind: "worktree",
            name: "feature",
            status: "running",
            activityAt: "2026-03-01T12:00:00.000Z",
            services: [],
          },
        ],
      ]);
    sessionAny.emit = (message: any) => emitted.push(message);

    await sessionAny.emitWorkspaceUpdatesForCwds(["/tmp/repo/worktree", "/tmp/repo"]);

    const workspaceUpdates = emitted.filter(
      (message) => message.type === "workspace_update",
    ) as any[];
    expect(workspaceUpdates).toHaveLength(2);
    expect(workspaceUpdates.map((entry) => entry.payload.kind)).toEqual(["upsert", "upsert"]);
    expect(workspaceUpdates.map((entry) => entry.payload.workspace.id).sort()).toEqual([
      "/tmp/repo",
      "/tmp/repo/worktree",
    ]);
  });

  test("open_project_request registers a workspace before any agent exists", async () => {
    const { session, emitted, workspaces } = createSessionForWorkspaceTests();
    const sessionAny = session as any;

    sessionAny.resolveWorkspaceDirectory = async (cwd: string) => cwd;

    await sessionAny.handleMessage({
      type: "open_project_request",
      cwd: "/tmp/repo",
      requestId: "req-open",
    });

    expect(
      Array.from(workspaces.values()).some((workspace) => workspace.directory === "/tmp/repo"),
    ).toBe(true);
    const response = emitted.find((message) => message.type === "open_project_response") as any;
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.workspace?.id).toBe("/tmp/repo");
  });

  test("open_project_request collapses a git subdirectory onto the repo root workspace", async () => {
    const { session, emitted, workspaces } = createSessionForWorkspaceTests();
    const sessionAny = session as any;
    const repoRoot = "/tmp/repo";
    const subdir = "/tmp/repo/packages/app";

    sessionAny.resolveWorkspaceDirectory = async () => repoRoot;
    sessionAny.buildProjectPlacement = async (cwd: string) => ({
      projectKey: repoRoot,
      projectName: "repo",
      checkout: {
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: null,
        worktreeRoot: repoRoot,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });

    await sessionAny.handleMessage({
      type: "open_project_request",
      cwd: subdir,
      requestId: "req-open-subdir",
    });

    expect(
      Array.from(workspaces.values()).some((workspace) => workspace.directory === repoRoot),
    ).toBe(true);
    expect(
      Array.from(workspaces.values()).some((workspace) => workspace.directory === subdir),
    ).toBe(false);
    const response = emitted.find((message) => message.type === "open_project_response") as any;
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.workspace?.id).toBe(repoRoot);
  });

  test("list_available_editors_request returns available targets", async () => {
    const { session, emitted } = createSessionForWorkspaceTests({ appVersion: "0.1.50" });
    const sessionAny = session as any;

    sessionAny.getAvailableEditorTargets = async () =>
      sessionAny.filterEditorsForClient([
        { id: "cursor", label: "Cursor" },
        { id: "webstorm", label: "WebStorm" },
        { id: "finder", label: "Finder" },
        { id: "unknown-editor", label: "Unknown Editor" },
      ]);

    await sessionAny.handleMessage({
      type: "list_available_editors_request",
      requestId: "req-editors",
    });

    const response = emitted.find(
      (message) => message.type === "list_available_editors_response",
    ) as any;
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.editors).toEqual([
      { id: "cursor", label: "Cursor" },
      { id: "webstorm", label: "WebStorm" },
      { id: "finder", label: "Finder" },
      { id: "unknown-editor", label: "Unknown Editor" },
    ]);
  });

  test("list_available_editors_request filters unsupported ids for legacy clients", async () => {
    const { session, emitted } = createSessionForWorkspaceTests({ appVersion: "0.1.49" });
    const sessionAny = session as any;

    sessionAny.getAvailableEditorTargets = async () =>
      sessionAny.filterEditorsForClient([
        { id: "cursor", label: "Cursor" },
        { id: "webstorm", label: "WebStorm" },
        { id: "unknown-editor", label: "Unknown Editor" },
        { id: "finder", label: "Finder" },
      ]);

    await sessionAny.handleMessage({
      type: "list_available_editors_request",
      requestId: "req-editors-legacy",
    });

    const response = emitted.find(
      (message) => message.type === "list_available_editors_response",
    ) as any;
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.editors).toEqual([
      { id: "cursor", label: "Cursor" },
      { id: "finder", label: "Finder" },
    ]);
  });

  test("open_in_editor_request launches the selected target", async () => {
    const { session, emitted } = createSessionForWorkspaceTests();
    const sessionAny = session as any;
    const calls: Array<{ editorId: string; path: string }> = [];

    sessionAny.openEditorTarget = async (input: { editorId: string; path: string }) => {
      calls.push(input);
    };

    await sessionAny.handleMessage({
      type: "open_in_editor_request",
      requestId: "req-open-editor",
      editorId: "vscode",
      path: "/tmp/repo",
    });

    expect(calls).toEqual([{ editorId: "vscode", path: "/tmp/repo" }]);
    const response = emitted.find((message) => message.type === "open_in_editor_response") as any;
    expect(response?.payload.error).toBeNull();
  });

  test("archive_workspace_request archives the persisted workspace row", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    seedProject({
      projects,
      id: 5,
      directory: "/tmp/repo",
      displayName: "repo",
    });
    seedWorkspace({
      workspaces,
      id: 50,
      projectId: 5,
      directory: "/tmp/repo",
      displayName: "repo",
    });

    await (session as any).handleMessage({
      type: "archive_workspace_request",
      workspaceId: 50,
      requestId: "req-archive",
    });

    expect(workspaces.get(50)?.archivedAt).toBeTruthy();
    const response = emitted.find(
      (message) => message.type === "archive_workspace_response",
    ) as any;
    expect(response?.payload).toMatchObject({
      workspaceId: 50,
      error: null,
    });
  });

  test("create_agent_request uses workspaceId as the execution authority", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    seedProject({
      projects,
      id: 5,
      directory: "/tmp/repo",
      displayName: "repo",
      kind: "git",
    });
    seedWorkspace({
      workspaces,
      id: 50,
      projectId: 5,
      directory: "/tmp/repo/.paseo/worktrees/feature",
      displayName: "feature",
      kind: "worktree",
    });

    const createdAgent = makeAgent({
      id: "agent-1",
      cwd: "/tmp/repo/.paseo/worktrees/feature",
      status: "idle",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const createAgent = vi.fn(async () => createdAgent as any);

    (session as any).agentManager = {
      createAgent,
      getAgent: vi.fn(() => createdAgent as any),
    };
    (session as any).forwardAgentUpdate = vi.fn(async () => undefined);
    (session as any).getAgentPayloadById = vi.fn(async () => createdAgent);
    (session as any).buildAgentSessionConfig = vi.fn(async (config: any) => ({
      sessionConfig: config,
      worktreeConfig: null,
    }));

    await (session as any).handleCreateAgentRequest({
      type: "create_agent_request",
      requestId: "req-create-agent",
      workspaceId: 50,
      config: {
        provider: "codex",
        cwd: "/tmp/repo",
        modeId: "default",
      },
      labels: {},
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/repo/.paseo/worktrees/feature",
      }),
      undefined,
      expect.objectContaining({
        workspaceId: 50,
      }),
    );
    const response = emitted.find((message) => message.type === "status") as any;
    expect(response?.payload).toMatchObject({
      status: "agent_created",
      requestId: "req-create-agent",
      agent: {
        cwd: "/tmp/repo/.paseo/worktrees/feature",
      },
    });
  });

  test("create_agent_request fails for an unknown workspaceId", async () => {
    const { session, emitted } = createSessionForWorkspaceTests();
    const createAgent = vi.fn();

    (session as any).agentManager = {
      createAgent,
      getAgent: vi.fn(() => null),
    };
    (session as any).buildAgentSessionConfig = vi.fn(async (config: any) => ({
      sessionConfig: config,
      worktreeConfig: null,
    }));

    await (session as any).handleCreateAgentRequest({
      type: "create_agent_request",
      requestId: "req-create-agent-fail",
      workspaceId: "999",
      config: {
        provider: "codex",
        cwd: "/tmp/repo",
        modeId: "default",
      },
      labels: {},
    });

    expect(createAgent).not.toHaveBeenCalled();
    const response = emitted.find((message) => message.type === "status") as any;
    expect(response?.payload).toMatchObject({
      status: "agent_create_failed",
      requestId: "req-create-agent-fail",
    });
    expect((response?.payload as any)?.error).toContain("Workspace not found: 999");
  });

  test("open_project_request creates git projects with GitHub owner/repo and branch names", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    const { tempDir, repoDir } = createTempGitRepo({
      remoteUrl: "git@github.com:acme/repo.git",
      branchName: "feature/test-branch",
    });

    try {
      await (session as any).handleOpenProjectRequest({
        type: "open_project_request",
        cwd: repoDir,
        requestId: "req-open-git",
      });

      expect(Array.from(projects.values())).toEqual([
        expect.objectContaining({
          directory: repoDir,
          kind: "git",
          displayName: "acme/repo",
          gitRemote: "git@github.com:acme/repo.git",
        }),
      ]);
      expect(Array.from(workspaces.values())).toEqual([
        expect.objectContaining({
          directory: repoDir,
          displayName: "feature/test-branch",
          kind: "checkout",
        }),
      ]);

      const response = emitted.find((message) => message.type === "open_project_response") as any;
      expect(response?.payload).toMatchObject({
        error: null,
        workspace: {
          projectDisplayName: "acme/repo",
          projectKind: "git",
          name: "feature/test-branch",
          workspaceKind: "local_checkout",
        },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("fetch_workspaces_request reconciles remote URL changes for existing workspaces", async () => {
    const session = createSessionForWorkspaceTests().session as any;
    const projects = new Map<string, ReturnType<typeof createPersistedProjectRecord>>();
    const workspaces = new Map<string, ReturnType<typeof createPersistedWorkspaceRecord>>();

    const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-workspace-fetch-")));
    const mainWorkspaceId = path.join(tempDir, "inkwell");
    const worktreeWorkspaceId = path.join(mainWorkspaceId, ".paseo", "worktrees", "feature-a");
    const oldProjectId = "remote:github.com/old-owner/inkwell";
    const newProjectId = "remote:github.com/new-owner/inkwell";

    execSync(`mkdir -p ${JSON.stringify(worktreeWorkspaceId)}`);

    projects.set(
      oldProjectId,
      createPersistedProjectRecord({
        projectId: oldProjectId,
        rootPath: mainWorkspaceId,
        kind: "git",
        displayName: "old-owner/inkwell",
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      }),
    );

    for (const [workspaceId, displayName] of [
      [mainWorkspaceId, "main"],
      [worktreeWorkspaceId, "feature-a"],
    ] as const) {
      workspaces.set(
        workspaceId,
        createPersistedWorkspaceRecord({
          workspaceId,
          projectId: oldProjectId,
          cwd: workspaceId,
          kind: workspaceId === mainWorkspaceId ? "local_checkout" : "worktree",
          displayName,
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        }),
      );
    }

    session.listAgentPayloads = async () => [];
    session.projectRegistry.get = async (projectId: string) => projects.get(projectId) ?? null;
    session.projectRegistry.list = async () => Array.from(projects.values());
    session.projectRegistry.upsert = async (
      record: ReturnType<typeof createPersistedProjectRecord>,
    ) => {
      projects.set(record.projectId, record);
    };
    session.projectRegistry.archive = async (projectId: string, archivedAt: string) => {
      const existing = projects.get(projectId);
      if (!existing) return;
      projects.set(projectId, { ...existing, archivedAt, updatedAt: archivedAt });
    };
    session.workspaceRegistry.get = async (workspaceId: string) =>
      workspaces.get(workspaceId) ?? null;
    session.workspaceRegistry.list = async () => Array.from(workspaces.values());
    session.workspaceRegistry.upsert = async (
      record: ReturnType<typeof createPersistedWorkspaceRecord>,
    ) => {
      workspaces.set(record.workspaceId, record);
    };
    session.buildProjectPlacement = async (cwd: string) => ({
      projectKey: newProjectId,
      projectName: "new-owner/inkwell",
      checkout: {
        cwd,
        isGit: true,
        currentBranch: cwd === mainWorkspaceId ? "main" : "feature-a",
        remoteUrl: "https://github.com/new-owner/inkwell.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: cwd !== mainWorkspaceId,
        mainRepoRoot: cwd === mainWorkspaceId ? null : mainWorkspaceId,
      },
    });

    try {
      await session.reconcileWorkspaceRecord(mainWorkspaceId);
      await session.reconcileWorkspaceRecord(worktreeWorkspaceId);

      const result = await session.listFetchWorkspacesEntries({
        type: "fetch_workspaces_request",
        requestId: "req-fetch-reconcile",
      });

      expect(result.entries.map((entry: any) => entry.projectId)).toEqual([
        newProjectId,
        newProjectId,
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("open_project_request treats non-git directories as directory projects", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "session-workspace-dir-")));
    const projectDir = path.join(tempDir, "plain-dir");
    execSync(`mkdir -p ${projectDir}`);
    writeFileSync(path.join(projectDir, "README.md"), "hello\n");

    try {
      await (session as any).handleOpenProjectRequest({
        type: "open_project_request",
        cwd: projectDir,
        requestId: "req-open-dir",
      });

      expect(Array.from(projects.values())).toEqual([
        expect.objectContaining({
          directory: projectDir,
          kind: "directory",
          displayName: "plain-dir",
          gitRemote: null,
        }),
      ]);
      expect(Array.from(workspaces.values())).toEqual([
        expect.objectContaining({
          directory: projectDir,
          displayName: "plain-dir",
          kind: "checkout",
        }),
      ]);

      const response = emitted.find((message) => message.type === "open_project_response") as any;
      expect(response?.payload).toMatchObject({
        error: null,
        workspace: {
          projectDisplayName: "plain-dir",
          projectKind: "non_git",
          name: "plain-dir",
          workspaceKind: "local_checkout",
        },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("backward compatibility", () => {
  test("workspace descriptor uses directory path as id, not numeric database id", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    seedProject({
      projects,
      id: 1,
      directory: "/tmp/myproject",
      displayName: "myproject",
      kind: "git",
      gitRemote: "https://github.com/acme/myproject.git",
    });
    seedWorkspace({
      workspaces,
      id: 10,
      projectId: 1,
      directory: "/tmp/myproject",
      displayName: "main",
    });

    await (session as any).handleMessage({
      type: "fetch_workspaces_request",
      payload: { requestId: "compat-id" },
      requestId: "compat-id",
    });

    const response = emitted.find((m) => m.type === "fetch_workspaces_response") as any;
    expect(response).toBeTruthy();
    const entries = response.payload.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("/tmp/myproject");
    expect(entries[0].id).not.toBe("10");
  });

  test("workspace descriptor maps projectKind 'directory' to 'non_git'", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    seedProject({
      projects,
      id: 1,
      directory: "/tmp/dirproject",
      displayName: "dirproject",
      kind: "directory",
    });
    seedWorkspace({
      workspaces,
      id: 10,
      projectId: 1,
      directory: "/tmp/dirproject",
      displayName: "dirproject",
    });

    await (session as any).handleMessage({
      type: "fetch_workspaces_request",
      payload: { requestId: "compat-dir-kind" },
      requestId: "compat-dir-kind",
    });

    const response = emitted.find((m) => m.type === "fetch_workspaces_response") as any;
    expect(response).toBeTruthy();
    expect(response.payload.entries[0].projectKind).toBe("non_git");
  });

  test("workspace descriptor maps projectKind 'git' unchanged", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    seedProject({
      projects,
      id: 1,
      directory: "/tmp/gitproject",
      displayName: "gitproject",
      kind: "git",
      gitRemote: "https://github.com/acme/gitproject.git",
    });
    seedWorkspace({
      workspaces,
      id: 10,
      projectId: 1,
      directory: "/tmp/gitproject",
      displayName: "main",
    });

    await (session as any).handleMessage({
      type: "fetch_workspaces_request",
      payload: { requestId: "compat-git-kind" },
      requestId: "compat-git-kind",
    });

    const response = emitted.find((m) => m.type === "fetch_workspaces_response") as any;
    expect(response).toBeTruthy();
    expect(response.payload.entries[0].projectKind).toBe("git");
  });

  test("workspace descriptor maps workspaceKind 'checkout' to 'local_checkout'", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    seedProject({
      projects,
      id: 1,
      directory: "/tmp/checkout-project",
      displayName: "checkout-project",
      kind: "git",
    });
    seedWorkspace({
      workspaces,
      id: 10,
      projectId: 1,
      directory: "/tmp/checkout-project",
      displayName: "main",
      kind: "checkout",
    });

    await (session as any).handleMessage({
      type: "fetch_workspaces_request",
      payload: { requestId: "compat-checkout" },
      requestId: "compat-checkout",
    });

    const response = emitted.find((m) => m.type === "fetch_workspaces_response") as any;
    expect(response).toBeTruthy();
    expect(response.payload.entries[0].workspaceKind).toBe("local_checkout");
  });

  test("workspace descriptor maps workspaceKind 'worktree' unchanged", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    seedProject({
      projects,
      id: 1,
      directory: "/tmp/worktree-project",
      displayName: "worktree-project",
      kind: "git",
    });
    seedWorkspace({
      workspaces,
      id: 10,
      projectId: 1,
      directory: "/tmp/worktree-project/.paseo/worktrees/feature",
      displayName: "feature",
      kind: "worktree",
    });

    await (session as any).handleMessage({
      type: "fetch_workspaces_request",
      payload: { requestId: "compat-worktree" },
      requestId: "compat-worktree",
    });

    const response = emitted.find((m) => m.type === "fetch_workspaces_response") as any;
    expect(response).toBeTruthy();
    expect(response.payload.entries[0].workspaceKind).toBe("worktree");
  });

  test("workspace descriptor uses project directory as projectId", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    seedProject({
      projects,
      id: 1,
      directory: "/tmp/myproject",
      displayName: "myproject",
      kind: "git",
      gitRemote: "https://github.com/acme/myproject.git",
    });
    seedWorkspace({
      workspaces,
      id: 10,
      projectId: 1,
      directory: "/tmp/myproject",
      displayName: "main",
    });

    await (session as any).handleMessage({
      type: "fetch_workspaces_request",
      payload: { requestId: "compat-project-id" },
      requestId: "compat-project-id",
    });

    const response = emitted.find((m) => m.type === "fetch_workspaces_response") as any;
    expect(response).toBeTruthy();
    expect(response.payload.entries[0].projectId).toBe("/tmp/myproject");
    expect(response.payload.entries[0].projectId).not.toBe("1");
  });

  test("open_project_response returns backward-compatible descriptor", async () => {
    const { session, emitted, projects, workspaces } = createSessionForWorkspaceTests();
    const { tempDir, repoDir } = createTempGitRepo({
      remoteUrl: "https://github.com/acme/compat-repo.git",
      branchName: "main",
    });

    try {
      await (session as any).handleOpenProjectRequest({
        type: "open_project_request",
        cwd: repoDir,
        requestId: "req-open-compat",
      });

      const response = emitted.find((m) => m.type === "open_project_response") as any;
      expect(response).toBeTruthy();
      const workspace = response.payload.workspace;

      // id should be the directory path, not a numeric id
      expect(workspace.id).toBe(repoDir);

      // projectId should be the project directory path, not a numeric id
      expect(workspace.projectId).toBe(repoDir);

      // projectKind should map "git" to "git"
      expect(workspace.projectKind).toBe("git");

      // workspaceKind should map "checkout" to "local_checkout"
      expect(workspace.workspaceKind).toBe("local_checkout");

      // projectRootPath and workspaceDirectory should be the actual directory
      expect(workspace.projectRootPath).toBe(repoDir);
      expect(workspace.workspaceDirectory).toBe(repoDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("listWorkspaceDescriptorsSnapshot keeps git workspaces on the baseline descriptor path", async () => {
    const { session } = createSessionForWorkspaceTests();
    const sessionAny = session as any;
    const project = createPersistedProjectRecord({
      id: 70,
      directory: "/tmp/repo",
      kind: "git",
      displayName: "repo",
      gitRemote: "https://github.com/acme/repo.git",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const workspace = createPersistedWorkspaceRecord({
      id: 71,
      projectId: project.id,
      directory: "/tmp/repo",
      kind: "checkout",
      displayName: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });

    sessionAny.listAgentPayloads = async () => [];
    sessionAny.projectRegistry.list = async () => [project];
    sessionAny.workspaceRegistry.list = async () => [workspace];

    const baselineDescriptor = {
      id: workspace.directory,
      projectId: project.directory,
      projectDisplayName: project.displayName,
      projectRootPath: project.directory,
      workspaceDirectory: workspace.directory,
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: null,
      services: [],
    } as const;
    const gitDescriptor = {
      ...baselineDescriptor,
      diffStat: { additions: 3, deletions: 1 },
    } as const;

    sessionAny.describeWorkspaceRecord = vi.fn(async () => baselineDescriptor);
    sessionAny.describeWorkspaceRecordWithGitData = vi.fn(async () => gitDescriptor);

    const descriptors = Array.from(
      (
        await sessionAny.buildWorkspaceDescriptorMap({
          includeGitData: false,
        })
      ).values(),
    );

    expect(sessionAny.describeWorkspaceRecord).toHaveBeenCalledWith(workspace, project);
    expect(sessionAny.describeWorkspaceRecordWithGitData).not.toHaveBeenCalled();
    expect(descriptors).toEqual([baselineDescriptor]);
  });

  test("fetch_workspaces_response reads runtime fields from passive workspace git service snapshots", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const runtimeSnapshot = createWorkspaceRuntimeSnapshot("/tmp/repo", {
      git: {
        currentBranch: "runtime-branch",
        isDirty: true,
        aheadBehind: { ahead: 3, behind: 1 },
        aheadOfOrigin: 3,
        behindOfOrigin: 1,
      },
      github: {
        pullRequest: {
          url: "https://github.com/acme/repo/pull/456",
          title: "Ship runtime payloads",
          state: "open",
          baseRefName: "main",
          headRefName: "runtime-branch",
          isMerged: false,
        },
        refreshedAt: "2026-04-12T00:05:00.000Z",
      },
    });
    const workspaceGitService = createNoopWorkspaceGitService();
    workspaceGitService.peekSnapshot = vi.fn(() => runtimeSnapshot);
    workspaceGitService.getSnapshot = vi.fn(async () => {
      throw new Error("fetch_workspaces should not trigger per-workspace refreshes");
    });
    workspaceGitService.subscribe = vi.fn(async () => ({
      initial: runtimeSnapshot,
      unsubscribe: () => {},
    }));

    const { session } = createSessionForWorkspaceTests({
      workspaceGitService,
    });
    const sessionAny = session as any;
    const project = createPersistedProjectRecord({
      projectId: "/tmp/repo",
      rootPath: "/tmp/repo",
      kind: "git",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "/tmp/repo",
      projectId: project.projectId,
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });

    sessionAny.emit = (message: any) => emitted.push(message);
    sessionAny.listAgentPayloads = async () => [];
    sessionAny.projectRegistry.list = async () => [project];
    sessionAny.workspaceRegistry.list = async () => [workspace];
    sessionAny.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: "repo",
      checkout: {
        cwd,
        isGit: true,
        currentBranch: runtimeSnapshot.git.currentBranch,
        remoteUrl: runtimeSnapshot.git.remoteUrl,
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });

    await sessionAny.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "req-fetch-workspaces-runtime",
    });

    const response = emitted.find((message) => message.type === "fetch_workspaces_response") as
      | { type: "fetch_workspaces_response"; payload: any }
      | undefined;

    expect(workspaceGitService.peekSnapshot).toHaveBeenCalledWith("/tmp/repo");
    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    expect(response?.payload.entries).toEqual([
      expect.objectContaining({
        id: "/tmp/repo",
        gitRuntime: {
          currentBranch: "runtime-branch",
          remoteUrl: "https://github.com/acme/repo.git",
          isPaseoOwnedWorktree: false,
          isDirty: true,
          aheadBehind: { ahead: 3, behind: 1 },
          aheadOfOrigin: 3,
          behindOfOrigin: 1,
        },
        githubRuntime: {
          featuresEnabled: true,
          pullRequest: {
            url: "https://github.com/acme/repo/pull/456",
            title: "Ship runtime payloads",
            state: "open",
            baseRefName: "main",
            headRefName: "runtime-branch",
            isMerged: false,
          },
          error: null,
          refreshedAt: "2026-04-12T00:05:00.000Z",
        },
      }),
    ]);
  });

  test("workspace_update includes updated runtime fields", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const runtimeSnapshot = createWorkspaceRuntimeSnapshot("/tmp/repo", {
      git: {
        currentBranch: "feature/runtime-payloads",
        isDirty: true,
      },
      github: {
        pullRequest: {
          url: "https://github.com/acme/repo/pull/789",
          title: "Updated runtime payloads",
          state: "merged",
          baseRefName: "main",
          headRefName: "feature/runtime-payloads",
          isMerged: true,
        },
        refreshedAt: "2026-04-12T00:10:00.000Z",
      },
    });
    const workspaceGitService = createNoopWorkspaceGitService();
    workspaceGitService.peekSnapshot = vi.fn(() => runtimeSnapshot);
    workspaceGitService.getSnapshot = vi.fn(async () => {
      throw new Error("workspace updates should use passive workspace git snapshots");
    });

    const { session } = createSessionForWorkspaceTests({
      workspaceGitService,
    });
    const sessionAny = session as any;
    const project = createPersistedProjectRecord({
      projectId: "/tmp/repo",
      rootPath: "/tmp/repo",
      kind: "git",
      displayName: "repo",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "/tmp/repo",
      projectId: project.projectId,
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });

    sessionAny.emit = (message: any) => emitted.push(message);
    sessionAny.workspaceUpdatesSubscription = {
      subscriptionId: "sub-runtime",
      filter: undefined,
      isBootstrapping: false,
      pendingUpdatesByWorkspaceId: new Map(),
      lastEmittedByWorkspaceId: new Map(),
    };
    sessionAny.reconcileActiveWorkspaceRecords = async () => new Set();
    sessionAny.listAgentPayloads = async () => [];
    sessionAny.projectRegistry.list = async () => [project];
    sessionAny.workspaceRegistry.list = async () => [workspace];
    sessionAny.buildProjectPlacement = async (cwd: string) => ({
      projectKey: cwd,
      projectName: "repo",
      checkout: {
        cwd,
        isGit: true,
        currentBranch: runtimeSnapshot.git.currentBranch,
        remoteUrl: runtimeSnapshot.git.remoteUrl,
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });

    await sessionAny.emitWorkspaceUpdateForCwd("/tmp/repo", {
      skipReconcile: true,
    });

    expect(workspaceGitService.peekSnapshot).toHaveBeenCalledWith("/tmp/repo");
    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    expect(emitted).toContainEqual({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: expect.objectContaining({
          id: "/tmp/repo",
          gitRuntime: expect.objectContaining({
            currentBranch: "feature/runtime-payloads",
            isDirty: true,
          }),
          githubRuntime: expect.objectContaining({
            featuresEnabled: true,
            pullRequest: expect.objectContaining({
              title: "Updated runtime payloads",
              isMerged: true,
            }),
            refreshedAt: "2026-04-12T00:10:00.000Z",
          }),
        }),
      },
    });
  });

  test("subscribed fetch_workspaces includes git enrichment in the initial snapshot", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const { session } = createSessionForWorkspaceTests();
    const sessionAny = session as any;
    const gitProject = createPersistedProjectRecord({
      id: 80,
      directory: "/tmp/repo",
      kind: "git",
      displayName: "repo",
      gitRemote: "https://github.com/acme/repo.git",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const directoryProject = createPersistedProjectRecord({
      id: 81,
      directory: "/tmp/docs",
      kind: "directory",
      displayName: "docs",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const gitWorkspace = createPersistedWorkspaceRecord({
      id: 82,
      projectId: gitProject.id,
      directory: "/tmp/repo",
      kind: "checkout",
      displayName: "main",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const directoryWorkspace = createPersistedWorkspaceRecord({
      id: 83,
      projectId: directoryProject.id,
      directory: "/tmp/docs",
      kind: "checkout",
      displayName: "docs",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
    const baselineGitDescriptor = {
      id: gitWorkspace.directory,
      projectId: gitProject.directory,
      projectDisplayName: gitProject.displayName,
      projectRootPath: gitProject.directory,
      workspaceDirectory: gitWorkspace.directory,
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: null,
      services: [],
    } as const;
    const enrichedGitDescriptor = {
      ...baselineGitDescriptor,
      diffStat: { additions: 3, deletions: 1 },
    } as const;
    const directoryDescriptor = {
      id: directoryWorkspace.directory,
      projectId: directoryProject.directory,
      projectDisplayName: directoryProject.displayName,
      projectRootPath: directoryProject.directory,
      workspaceDirectory: directoryWorkspace.directory,
      projectKind: "non_git",
      workspaceKind: "local_checkout",
      name: "docs",
      status: "done",
      activityAt: null,
      diffStat: null,
      services: [],
    } as const;

    sessionAny.emit = (message: any) => emitted.push(message);
    sessionAny.listAgentPayloads = async () => [];
    sessionAny.projectRegistry.list = async () => [gitProject, directoryProject];
    sessionAny.workspaceRegistry.list = async () => [gitWorkspace, directoryWorkspace];
    sessionAny.reconcileAndEmitWorkspaceUpdates = vi.fn(async () => {});
    sessionAny.describeWorkspaceRecord = vi.fn(
      async (workspace: typeof gitWorkspace | typeof directoryWorkspace, project: any) => {
        if (workspace.id === gitWorkspace.id) {
          expect(project).toEqual(gitProject);
          return baselineGitDescriptor;
        }
        expect(project).toEqual(directoryProject);
        return directoryDescriptor;
      },
    );
    sessionAny.describeWorkspaceRecordWithGitData = vi.fn(async () => enrichedGitDescriptor);

    await sessionAny.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "req-fetch-workspaces",
      subscribe: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = emitted.find((message) => message.type === "fetch_workspaces_response") as
      | { type: "fetch_workspaces_response"; payload: any }
      | undefined;
    expect(
      response?.payload.entries.map(
        (entry: typeof baselineGitDescriptor | typeof directoryDescriptor) => [
          entry.id,
          entry.diffStat,
        ],
      ),
    ).toEqual([
      [directoryDescriptor.id, directoryDescriptor.diffStat],
      [enrichedGitDescriptor.id, enrichedGitDescriptor.diffStat],
    ]);

    const workspaceUpdates = emitted.filter(
      (message) => message.type === "workspace_update",
    ) as Array<{ type: "workspace_update"; payload: any }>;
    expect(workspaceUpdates).toEqual([]);
    expect(sessionAny.describeWorkspaceRecordWithGitData).toHaveBeenCalledWith(
      gitWorkspace,
      gitProject,
    );
  });
});
