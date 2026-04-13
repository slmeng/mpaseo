import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { SessionOutboundMessage } from "./messages.js";
import { ScriptRouteStore } from "./script-proxy.js";
import * as worktreeBootstrap from "./worktree-bootstrap.js";
import {
  buildAgentSessionConfig,
  createPaseoWorktreeInBackground,
  handleCreatePaseoWorktreeRequest,
  handleWorkspaceSetupStatusRequest,
} from "./worktree-session.js";
import { createWorktree } from "../utils/worktree.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function createTerminalManagerStub(options?: {
  createTerminal?: (input: {
    cwd: string;
    name?: string;
    env?: Record<string, string>;
  }) => Promise<any>;
}) {
  const terminals: Array<{
    id: string;
    cwd: string;
    name: string | undefined;
    env: Record<string, string> | undefined;
    sent: string[];
  }> = [];

  return {
    terminals,
    manager: {
      registerCwdEnv: vi.fn(),
      createTerminal: vi.fn(
        async (input: { cwd: string; name?: string; env?: Record<string, string> }) => {
          if (options?.createTerminal) {
            return options.createTerminal(input);
          }
          const sent: string[] = [];
          const terminal = {
            id: `terminal-${terminals.length + 1}`,
            getState: () => ({
              scrollback: [[{ char: "$" }]],
              grid: [],
            }),
            subscribe: () => () => {},
            onExit: () => () => {},
            send: (message: { type: string; data: string }) => {
              if (message.type === "input") {
                sent.push(message.data);
              }
            },
          };
          terminals.push({
            id: terminal.id,
            cwd: input.cwd,
            name: input.name,
            env: input.env,
            sent,
          });
          return terminal;
        },
      ),
    } as any,
  };
}

function createGitRepo(options?: { paseoConfig?: Record<string, unknown> }) {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "worktree-session-test-")));
  const repoDir = path.join(tempDir, "repo");
  execSync(`mkdir -p ${JSON.stringify(repoDir)}`);
  execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  if (options?.paseoConfig) {
    writeFileSync(path.join(repoDir, "paseo.json"), JSON.stringify(options.paseoConfig, null, 2));
  }
  execSync("git add .", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}

function createGitHubPrRemoteRepo() {
  const { tempDir, repoDir } = createGitRepo();
  const featureBranch = "feature/review-pr";
  execSync(`git checkout -b ${JSON.stringify(featureBranch)}`, { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "review branch\n");
  execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'review branch'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  const featureSha = execSync("git rev-parse HEAD", { cwd: repoDir, stdio: "pipe" })
    .toString()
    .trim();
  execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
  execSync(`git branch -D ${JSON.stringify(featureBranch)}`, { cwd: repoDir, stdio: "pipe" });

  const remoteDir = path.join(tempDir, "remote.git");
  execSync(`git clone --bare ${JSON.stringify(repoDir)} ${JSON.stringify(remoteDir)}`, {
    stdio: "pipe",
  });
  execSync(
    `git --git-dir=${JSON.stringify(remoteDir)} update-ref refs/pull/123/head ${featureSha}`,
    {
      stdio: "pipe",
    },
  );
  execSync(`git remote add origin ${JSON.stringify(remoteDir)}`, { cwd: repoDir, stdio: "pipe" });
  execSync("git fetch origin", { cwd: repoDir, stdio: "pipe" });

  return { tempDir, repoDir };
}

describe("createPaseoWorktreeInBackground", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("emits running then completed snapshots for no-setup workspaces without auto-starting scripts", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        scripts: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createWorktree({
      branchName: "feature-no-setup",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-no-setup",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: 42,
        worktree: {
          branchName: "feature-no-setup",
          worktreePath,
        },
        shouldBootstrap: true,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload).toMatchObject({
      workspaceId: "42",
      status: "running",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });
    expect(progressMessages[1]?.payload).toMatchObject({
      workspaceId: "42",
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });
    expect(snapshots.get("42")).toMatchObject({
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });

    expect(terminalManager.terminals).toHaveLength(0);
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("archives the pending workspace and emits a failed snapshot when setup cannot start", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    writeFileSync(path.join(repoDir, "paseo.json"), "{ invalid json\n");
    execSync("git add paseo.json", { cwd: repoDir, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'broken config'", {
      cwd: repoDir,
      stdio: "pipe",
    });

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createWorktree({
      branchName: "broken-feature",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "broken-feature",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});
    const workspaceId = 101;

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: null,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId,
        worktree: {
          branchName: "broken-feature",
          worktreePath,
        },
        shouldBootstrap: true,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload.status).toBe("running");
    expect(progressMessages[0]?.payload.error).toBeNull();
    expect(progressMessages[1]?.payload.status).toBe("failed");
    expect(progressMessages[1]?.payload.error).toContain("Failed to parse paseo.json");
    expect(progressMessages[1]?.payload.detail.commands).toEqual([]);
    expect(snapshots.get("101")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Failed to parse paseo.json"),
    });
    expect(archiveWorkspaceRecord).toHaveBeenCalledWith(workspaceId);
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("emits running setup snapshots before completed for real setup commands", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        worktree: {
          setup: ["sh -c \"printf 'phase-one\\\\n'; sleep 0.1; printf 'phase-two\\\\n'\""],
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createWorktree({
      branchName: "feature-running-setup",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-running-setup",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: null,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: 43,
        worktree: {
          branchName: "feature-running-setup",
          worktreePath,
        },
        shouldBootstrap: true,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages.length).toBeGreaterThan(1);
    expect(progressMessages[0]?.payload).toMatchObject({
      workspaceId: "43",
      status: "running",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-running-setup",
        log: "",
        commands: [],
      },
    });
    expect(progressMessages.at(-1)?.payload.status).toBe("completed");

    const runningMessages = progressMessages.filter(
      (message) => message.payload.status === "running",
    );
    expect(runningMessages.length).toBeGreaterThan(0);
    expect(
      progressMessages.findIndex((message) => message.payload.status === "running"),
    ).toBeLessThan(progressMessages.findIndex((message) => message.payload.status === "completed"));

    const setupOutputMessage = runningMessages.find((message) =>
      message.payload.detail.commands[0]?.log.includes("phase-one"),
    );
    expect(setupOutputMessage?.payload.detail.log).toContain("phase-one");
    expect(setupOutputMessage?.payload.detail.commands[0]).toMatchObject({
      index: 1,
      command: "sh -c \"printf 'phase-one\\\\n'; sleep 0.1; printf 'phase-two\\\\n'\"",
      log: expect.stringContaining("phase-one"),
      status: "running",
    });

    expect(progressMessages.at(-1)?.payload).toMatchObject({
      workspaceId: "43",
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-running-setup",
      },
    });
    expect(progressMessages.at(-1)?.payload.detail.log).toContain("phase-two");
    expect(progressMessages.at(-1)?.payload.detail.commands[0]).toMatchObject({
      index: 1,
      command: "sh -c \"printf 'phase-one\\\\n'; sleep 0.1; printf 'phase-two\\\\n'\"",
      log: expect.stringContaining("phase-two"),
      status: "completed",
      exitCode: 0,
    });
    expect(snapshots.get("43")).toMatchObject({
      status: "completed",
      error: null,
    });
  });

  test("emits completed when reusing an existing worktree without bootstrapping or auto-starting scripts", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        worktree: {
          setup: ["printf 'ran' > setup-ran.txt"],
        },
        scripts: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const existingWorktree = await createWorktree({
      branchName: "reused-worktree",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "reused-worktree",
      runSetup: false,
      paseoHome,
    });

    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: 44,
        worktree: {
          branchName: "reused-worktree",
          worktreePath: existingWorktree.worktreePath,
        },
        shouldBootstrap: false,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload).toMatchObject({
      workspaceId: "44",
      status: "running",
      error: null,
    });
    expect(progressMessages[1]?.payload).toMatchObject({
      workspaceId: "44",
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath: existingWorktree.worktreePath,
        branchName: "reused-worktree",
        log: "",
        commands: [],
      },
    });
    expect(terminalManager.terminals).toHaveLength(0);
    expect(readFileSync(path.join(existingWorktree.worktreePath, "README.md"), "utf8")).toContain(
      "hello",
    );
    expect(() =>
      readFileSync(path.join(existingWorktree.worktreePath, "setup-ran.txt"), "utf8"),
    ).toThrow();
    expect(snapshots.get("44")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(existingWorktree.worktreePath);
  });

  test("keeps setup completed without attempting script launch afterward", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        scripts: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createWorktree({
      branchName: "feature-service-failure",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-service-failure",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub({
      createTerminal: async () => {
        throw new Error("terminal spawn failed");
      },
    });
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: 45,
        worktree: {
          branchName: "feature-service-failure",
          worktreePath,
        },
        shouldBootstrap: true,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload.status).toBe("running");
    expect(progressMessages[0]?.payload.error).toBeNull();
    expect(progressMessages[1]?.payload.status).toBe("completed");
    expect(progressMessages[1]?.payload.error).toBeNull();
    expect(
      emitted.some(
        (message) =>
          message.type === "workspace_setup_progress" && message.payload.status === "failed",
      ),
    ).toBe(false);
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "Failed to spawn worktree scripts after workspace setup completed",
    );
    expect(terminalManager.terminals).toHaveLength(0);
    expect(snapshots.get("45")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("does not auto-start scripts in socket mode", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        scripts: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createWorktree({
      branchName: "feature-socket-mode",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-socket-mode",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: 46,
        worktree: {
          branchName: "feature-socket-mode",
          worktreePath,
        },
        shouldBootstrap: true,
      },
    );

    expect(terminalManager.terminals).toHaveLength(0);
    expect(snapshots.get("46")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("returns the cached workspace setup snapshot for status requests", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map([
      [
        "/repo/.paseo/worktrees/feature-a",
        {
          status: "completed",
          detail: {
            type: "worktree_setup",
            worktreePath: "/repo/.paseo/worktrees/feature-a",
            branchName: "feature-a",
            log: "done",
            commands: [],
          },
          error: null,
        },
      ],
    ]);

    await handleWorkspaceSetupStatusRequest(
      {
        emit: (message) => emitted.push(message),
        workspaceSetupSnapshots: snapshots,
        workspaceRegistry: { list: async () => [] } as any,
      },
      {
        type: "workspace_setup_status_request",
        workspaceId: "/repo/.paseo/worktrees/feature-a",
        requestId: "req-status",
      },
    );

    expect(emitted).toContainEqual({
      type: "workspace_setup_status_response",
      payload: {
        requestId: "req-status",
        workspaceId: "/repo/.paseo/worktrees/feature-a",
        snapshot: {
          status: "completed",
          detail: {
            type: "worktree_setup",
            worktreePath: "/repo/.paseo/worktrees/feature-a",
            branchName: "feature-a",
            log: "done",
            commands: [],
          },
          error: null,
        },
      },
    });
  });

  test("returns null when no cached workspace setup snapshot exists", async () => {
    const emitted: SessionOutboundMessage[] = [];

    await handleWorkspaceSetupStatusRequest(
      {
        emit: (message) => emitted.push(message),
        workspaceSetupSnapshots: new Map(),
        workspaceRegistry: { list: async () => [] } as any,
      },
      {
        type: "workspace_setup_status_request",
        workspaceId: "/repo/.paseo/worktrees/missing",
        requestId: "req-missing",
      },
    );

    expect(emitted).toContainEqual({
      type: "workspace_setup_status_response",
      payload: {
        requestId: "req-missing",
        workspaceId: "/repo/.paseo/worktrees/missing",
        snapshot: null,
      },
    });
  });
});

describe("handleCreatePaseoWorktreeRequest", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("checks out the GitHub PR branch when a github_pr attachment is present", async () => {
    const { tempDir, repoDir } = createGitHubPrRemoteRepo();
    cleanupPaths.push(tempDir);

    const emitted: SessionOutboundMessage[] = [];
    const logger = createLogger();
    const paseoHome = path.join(tempDir, ".paseo");

    await handleCreatePaseoWorktreeRequest(
      {
        paseoHome,
        describeWorkspaceRecord: async (workspace) =>
          ({
            id: String(workspace.id),
            projectId: String(workspace.projectId),
            projectDisplayName: "repo",
            projectRootPath: repoDir,
            workspaceDirectory: workspace.directory,
            workspaceKind: "worktree",
            projectKind: "git",
            name: workspace.displayName,
            status: "done",
            activityAt: null,
            diffStat: null,
            scripts: [],
          }) as any,
        emit: (message) => emitted.push(message),
        registerPendingWorktreeWorkspace: async ({ worktreePath, branchName }) =>
          ({
            id: 1,
            projectId: 1,
            directory: worktreePath,
            displayName: branchName,
            kind: "worktree",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            archivedAt: null,
          }) as any,
        sessionLogger: logger,
        createPaseoWorktreeInBackground: async () => {},
      },
      {
        type: "create_paseo_worktree_request",
        requestId: "req-pr-worktree",
        cwd: repoDir,
        worktreeSlug: "review-pr-123",
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 123,
            title: "Review branch",
            url: "https://github.com/getpaseo/paseo/pull/123",
            baseRefName: "main",
            headRefName: "feature/review-pr",
          },
        ],
      },
    );

    const response = emitted.find(
      (
        message,
      ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
        message.type === "create_paseo_worktree_response",
    );

    expect(response?.payload.error).toBeNull();
    expect(response?.payload.workspace?.workspaceDirectory).toBeTruthy();

    const worktreePath = response?.payload.workspace?.workspaceDirectory;
    expect(worktreePath).toBeTruthy();
    if (!worktreePath) {
      return;
    }

    const branch = execSync("git branch --show-current", { cwd: worktreePath, stdio: "pipe" })
      .toString()
      .trim();
    expect(branch).toBe("feature/review-pr");

    const readme = readFileSync(path.join(worktreePath, "README.md"), "utf8");
    expect(readme).toContain("review branch");
  });

  test("buildAgentSessionConfig checks out the GitHub PR branch for agent worktrees", async () => {
    const { tempDir, repoDir } = createGitHubPrRemoteRepo();
    cleanupPaths.push(tempDir);

    const result = await buildAgentSessionConfig(
      {
        paseoHome: path.join(tempDir, ".paseo"),
        sessionLogger: createLogger(),
        checkoutExistingBranch: async () => {
          throw new Error("should not checkout existing branch");
        },
        createBranchFromBase: async () => {
          throw new Error("should not create a new branch from base");
        },
      },
      {
        provider: "codex",
        cwd: repoDir,
      },
      {
        createWorktree: true,
        worktreeSlug: "agent-review-pr-123",
      },
      undefined,
      [
        {
          type: "github_pr",
          mimeType: "application/github-pr",
          number: 123,
          title: "Review branch",
          url: "https://github.com/getpaseo/paseo/pull/123",
          baseRefName: "main",
          headRefName: "feature/review-pr",
        },
      ],
    );

    expect(result.worktreeBootstrap?.worktree.branchName).toBe("feature/review-pr");
    expect(result.worktreeBootstrap?.worktree.worktreePath).toContain("agent-review-pr-123");

    const branch = execSync("git branch --show-current", {
      cwd: result.sessionConfig.cwd,
      stdio: "pipe",
    })
      .toString()
      .trim();
    expect(branch).toBe("feature/review-pr");
  });
});

describe("handleCreatePaseoWorktreeRequest", () => {
  test("invokes worktree creation once for a create request", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const emitted: SessionOutboundMessage[] = [];
    const createAgentWorktreeSpy = vi.spyOn(worktreeBootstrap, "createAgentWorktree");

    try {
      await handleCreatePaseoWorktreeRequest(
        {
          paseoHome,
          sessionLogger: createLogger(),
          emit: (message) => emitted.push(message),
          registerPendingWorktreeWorkspace: vi.fn(async (options) => ({
            workspaceId: options.worktreePath,
            projectId: options.repoRoot,
          })),
          describeWorkspaceRecord: vi.fn(async (workspace) => ({
            id: workspace.workspaceId,
            projectId: workspace.projectId,
            projectDisplayName: path.basename(repoDir),
            projectRootPath: repoDir,
            projectKind: "git",
            workspaceKind: "worktree",
            name: path.basename(workspace.workspaceId),
            status: "done",
            activityAt: null,
          })),
          createPaseoWorktreeInBackground: vi.fn(async () => {}),
        },
        {
          type: "create_paseo_worktree_request",
          cwd: repoDir,
          worktreeSlug: "single-call",
          requestId: "req-single-call",
        },
      );

      expect(createAgentWorktreeSpy).toHaveBeenCalledTimes(1);
      const response = emitted.find(
        (
          message,
        ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
          message.type === "create_paseo_worktree_response",
      );
      expect(response?.payload.error).toBeNull();
    } finally {
      createAgentWorktreeSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("creates the worktree before emitting the response", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const emitted: SessionOutboundMessage[] = [];
    const backgroundWork = vi.fn(async () => {});

    try {
      await handleCreatePaseoWorktreeRequest(
        {
          paseoHome,
          sessionLogger: createLogger(),
          emit: (message) => emitted.push(message),
          registerPendingWorktreeWorkspace: vi.fn(async (options) => {
            expect(existsSync(options.worktreePath)).toBe(true);
            return {
              workspaceId: options.worktreePath,
              projectId: options.repoRoot,
            } as any;
          }),
          describeWorkspaceRecord: vi.fn(async (workspace) => ({
            id: workspace.workspaceId,
            projectId: workspace.projectId,
            projectDisplayName: path.basename(repoDir),
            projectRootPath: repoDir,
            projectKind: "git",
            workspaceKind: "worktree",
            name: path.basename(workspace.workspaceId),
            status: "done",
            activityAt: null,
          })),
          createPaseoWorktreeInBackground: backgroundWork,
        },
        {
          type: "create_paseo_worktree_request",
          cwd: repoDir,
          worktreeSlug: "response-after-create",
          requestId: "req-1",
        },
      );

      const response = emitted.find(
        (
          message,
        ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
          message.type === "create_paseo_worktree_response",
      );
      expect(response?.payload.error).toBeNull();
      expect(response?.payload.workspace?.id).toBeTruthy();
      expect(existsSync(response!.payload.workspace!.id)).toBe(true);
      expect(backgroundWork).toHaveBeenCalledWith(
        expect.objectContaining({
          requestCwd: repoDir,
          repoRoot: repoDir,
          worktree: {
            branchName: "response-after-create",
            worktreePath: response!.payload.workspace!.id,
          },
          shouldBootstrap: true,
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
