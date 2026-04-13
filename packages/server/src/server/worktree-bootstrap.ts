import { v4 as uuidv4 } from "uuid";
import type { Logger } from "pino";
import { sep } from "node:path";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { TerminalSession } from "../terminal/terminal.js";
import { buildScriptHostname } from "../utils/script-hostname.js";
import { runGitCommand } from "../utils/run-git-command.js";
import {
  createWorktree,
  getScriptConfigs,
  getWorktreeTerminalSpecs,
  isServiceScript,
  listPaseoWorktrees,
  processCarriageReturns,
  resolveWorktreeRuntimeEnv,
  runWorktreeSetupCommands,
  WorktreeSetupError,
  type WorktreeConfig,
  type WorktreeSetupCommandResult,
  type WorktreeRuntimeEnv,
} from "../utils/worktree.js";
import { findFreePort, type ScriptRouteStore } from "./script-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import type { AgentTimelineItem, ToolCallDetail } from "./agent/agent-sdk-types.js";

export interface WorktreeBootstrapTerminalResult {
  name: string | null;
  command: string;
  status: "started" | "failed";
  terminalId: string | null;
  error: string | null;
}

export interface RunAsyncWorktreeBootstrapOptions {
  agentId: string;
  worktree: WorktreeConfig;
  shouldBootstrap?: boolean;
  terminalManager: TerminalManager | null;
  appendTimelineItem: (item: AgentTimelineItem) => Promise<boolean>;
  emitLiveTimelineItem?: (item: AgentTimelineItem) => Promise<boolean>;
  logger?: Logger;
}

export interface CreateAgentWorktreeOptions {
  cwd: string;
  branchName: string;
  baseBranch: string;
  worktreeSlug: string;
  paseoHome?: string;
}

export interface CreateAgentWorktreeResult {
  worktree: WorktreeConfig;
  shouldBootstrap: boolean;
}

const MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES = 64 * 1024;
const WORKTREE_SETUP_TRUNCATION_MARKER = "\n...<output truncated in the middle>...\n";
const WORKTREE_BOOTSTRAP_TERMINAL_READY_TIMEOUT_MS = 1_500;
const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
};

type MiddleTruncationAccumulator = {
  totalBytes: number;
  head: string;
  tail: string;
  truncated: boolean;
};

export type WorktreeSetupOutputAccumulator = MiddleTruncationAccumulator;
export type WorktreeSetupProgressAccumulator = {
  resultsByIndex: Map<number, WorktreeSetupCommandResult>;
  outputAccumulatorsByIndex: Map<number, WorktreeSetupOutputAccumulator>;
};

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sliceFirstBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) {
    return "";
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function sliceLastBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) {
    return "";
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

export function createWorktreeSetupOutputAccumulator(): WorktreeSetupOutputAccumulator {
  return {
    totalBytes: 0,
    head: "",
    tail: "",
    truncated: false,
  };
}

function getHeadTailBudgets(maxBytes: number): { headBytes: number; tailBytes: number } {
  const markerBytes = byteLength(WORKTREE_SETUP_TRUNCATION_MARKER);
  const availableBytes = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.floor(availableBytes / 2);
  const tailBytes = availableBytes - headBytes;
  return { headBytes, tailBytes };
}

export function appendWorktreeSetupOutputAccumulator(
  accumulator: WorktreeSetupOutputAccumulator,
  chunk: string,
): void {
  if (!chunk) {
    return;
  }
  accumulator.totalBytes += byteLength(chunk);

  if (!accumulator.truncated) {
    const combined = `${accumulator.head}${chunk}`;
    if (byteLength(combined) <= MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES) {
      accumulator.head = combined;
      return;
    }
    const { headBytes, tailBytes } = getHeadTailBudgets(MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES);
    accumulator.head = sliceFirstBytes(combined, headBytes);
    accumulator.tail = sliceLastBytes(combined, tailBytes);
    accumulator.truncated = true;
    return;
  }

  const { tailBytes } = getHeadTailBudgets(MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES);
  accumulator.tail = sliceLastBytes(`${accumulator.tail}${chunk}`, tailBytes);
}

function truncateTextInMiddle(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (maxBytes <= 0 || !text) {
    return { text: "", truncated: text.length > 0 };
  }
  if (byteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }
  const { headBytes, tailBytes } = getHeadTailBudgets(maxBytes);
  return {
    text: `${sliceFirstBytes(text, headBytes)}${WORKTREE_SETUP_TRUNCATION_MARKER}${sliceLastBytes(text, tailBytes)}`,
    truncated: true,
  };
}

function renderMiddleTruncationAccumulator(accumulator: MiddleTruncationAccumulator): {
  text: string;
  truncated: boolean;
} {
  if (!accumulator.truncated) {
    return { text: accumulator.head, truncated: false };
  }
  return {
    text: `${accumulator.head}${WORKTREE_SETUP_TRUNCATION_MARKER}${accumulator.tail}`,
    truncated: true,
  };
}

export async function createAgentWorktree(
  options: CreateAgentWorktreeOptions,
): Promise<CreateAgentWorktreeResult> {
  const existingWorktree = await findExistingPaseoWorktreeBySlug(options);
  if (existingWorktree) {
    const branchName = await resolveBranchNameForWorktreePath(existingWorktree.path);
    return {
      worktree: {
        branchName,
        worktreePath: existingWorktree.path,
      },
      shouldBootstrap: false,
    };
  }

  const createdWorktree = await createWorktree({
    branchName: options.branchName,
    cwd: options.cwd,
    baseBranch: options.baseBranch,
    worktreeSlug: options.worktreeSlug,
    runSetup: false,
    paseoHome: options.paseoHome,
  });
  return {
    worktree: createdWorktree,
    shouldBootstrap: true,
  };
}

async function findExistingPaseoWorktreeBySlug(options: CreateAgentWorktreeOptions) {
  const worktrees = await listPaseoWorktrees({
    cwd: options.cwd,
    paseoHome: options.paseoHome,
  });
  const slugSuffix = `${sep}${options.worktreeSlug}`;
  return worktrees.find((worktree) => worktree.path.endsWith(slugSuffix));
}

async function resolveBranchNameForWorktreePath(worktreePath: string): Promise<string> {
  const { stdout } = await runGitCommand(["branch", "--show-current"], {
    cwd: worktreePath,
    env: READ_ONLY_GIT_ENV,
  });
  const branchName = stdout.trim();
  if (!branchName) {
    throw new Error(`Unable to resolve branch for existing worktree: ${worktreePath}`);
  }
  return branchName;
}

function formatDurationMs(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(2)}s`;
}

function commandStatusFromResult(
  result: WorktreeSetupCommandResult,
): "running" | "completed" | "failed" {
  if (result.exitCode === null) {
    return "running";
  }
  return result.exitCode === 0 ? "completed" : "failed";
}

function buildWorktreeSetupLog(input: {
  results: WorktreeSetupCommandResult[];
  outputAccumulatorsByIndex?: Map<number, WorktreeSetupOutputAccumulator>;
}): { log: string; truncated: boolean } {
  const { results, outputAccumulatorsByIndex } = input;
  if (results.length === 0) {
    return {
      log: "",
      truncated: false,
    };
  }

  const lines: string[] = [];
  let anyTruncated = false;
  const total = results.length;
  for (const [index, result] of results.entries()) {
    lines.push(`==> [${index + 1}/${total}] Running: ${result.command}`);
    const output = buildWorktreeSetupCommandLog({
      index: index + 1,
      result,
      outputAccumulatorsByIndex,
    });
    if (output.log.length > 0) {
      lines.push(output.log.replace(/\n$/, ""));
    }
    if (output.truncated) {
      anyTruncated = true;
    }
    if (result.exitCode !== null) {
      lines.push(
        `<== [${index + 1}/${total}] Exit ${result.exitCode} in ${formatDurationMs(result.durationMs)}`,
      );
    }
  }
  return {
    log: lines.join("\n"),
    truncated: anyTruncated,
  };
}

function buildWorktreeSetupCommandLog(input: {
  index: number;
  result: WorktreeSetupCommandResult;
  outputAccumulatorsByIndex?: Map<number, WorktreeSetupOutputAccumulator>;
}): { log: string; truncated: boolean } {
  const { index, result, outputAccumulatorsByIndex } = input;
  const accumulator = outputAccumulatorsByIndex?.get(index);
  const rendered = accumulator
    ? renderMiddleTruncationAccumulator(accumulator)
    : truncateTextInMiddle(
        `${result.stdout ?? ""}${result.stderr ?? ""}`,
        MAX_WORKTREE_SETUP_COMMAND_OUTPUT_BYTES,
      );

  return {
    log: processCarriageReturns(rendered.text),
    truncated: rendered.truncated,
  };
}

export function createWorktreeSetupProgressAccumulator(): WorktreeSetupProgressAccumulator {
  return {
    resultsByIndex: new Map(),
    outputAccumulatorsByIndex: new Map(),
  };
}

export function applyWorktreeSetupProgressEvent(
  accumulator: WorktreeSetupProgressAccumulator,
  event: Parameters<NonNullable<Parameters<typeof runWorktreeSetupCommands>[0]["onEvent"]>>[0],
): void {
  const existing = accumulator.resultsByIndex.get(event.index);
  const baseResult: WorktreeSetupCommandResult = existing ?? {
    command: event.command,
    cwd: event.cwd,
    stdout: "",
    stderr: "",
    exitCode: null,
    durationMs: 0,
  };

  if (event.type === "output") {
    const outputAccumulator =
      accumulator.outputAccumulatorsByIndex.get(event.index) ??
      createWorktreeSetupOutputAccumulator();
    appendWorktreeSetupOutputAccumulator(outputAccumulator, event.chunk);
    accumulator.outputAccumulatorsByIndex.set(event.index, outputAccumulator);
    accumulator.resultsByIndex.set(event.index, {
      ...baseResult,
      stdout: baseResult.stdout,
      stderr: baseResult.stderr,
    });
    return;
  }

  if (event.type === "command_completed") {
    accumulator.resultsByIndex.set(event.index, {
      ...baseResult,
      stdout: event.stdout,
      stderr: event.stderr,
      exitCode: event.exitCode,
      durationMs: event.durationMs,
    });
    return;
  }

  accumulator.resultsByIndex.set(event.index, baseResult);
}

export function getWorktreeSetupProgressResults(
  accumulator: WorktreeSetupProgressAccumulator,
): WorktreeSetupCommandResult[] {
  return Array.from(accumulator.resultsByIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, result]) => result);
}

export function buildWorktreeSetupDetail(input: {
  worktree: WorktreeConfig;
  results: WorktreeSetupCommandResult[];
  outputAccumulatorsByIndex?: Map<number, WorktreeSetupOutputAccumulator>;
}): Extract<ToolCallDetail, { type: "worktree_setup" }> {
  let anyCommandTruncated = false;
  const commands = input.results.map((result, index) => {
    const renderedLog = buildWorktreeSetupCommandLog({
      index: index + 1,
      result,
      outputAccumulatorsByIndex: input.outputAccumulatorsByIndex,
    });
    if (renderedLog.truncated) {
      anyCommandTruncated = true;
    }
    return {
      index: index + 1,
      command: result.command,
      cwd: result.cwd,
      log: renderedLog.log,
      status: commandStatusFromResult(result),
      exitCode: result.exitCode,
      ...(result.durationMs > 0 ? { durationMs: result.durationMs } : {}),
    };
  });
  const renderedLog = buildWorktreeSetupLog({
    results: input.results,
    outputAccumulatorsByIndex: input.outputAccumulatorsByIndex,
  });

  return {
    type: "worktree_setup",
    worktreePath: input.worktree.worktreePath,
    branchName: input.worktree.branchName,
    log: renderedLog.log,
    commands,
    ...(renderedLog.truncated || anyCommandTruncated ? { truncated: true } : {}),
  };
}

function buildSetupTimelineItem(input: {
  callId: string;
  status: "running" | "completed" | "failed";
  worktree: WorktreeConfig;
  results: WorktreeSetupCommandResult[];
  outputAccumulatorsByIndex?: Map<number, WorktreeSetupOutputAccumulator>;
  errorMessage: string | null;
}): AgentTimelineItem {
  const detail = buildWorktreeSetupDetail({
    worktree: input.worktree,
    results: input.results,
    outputAccumulatorsByIndex: input.outputAccumulatorsByIndex,
  });

  if (input.status === "running") {
    return {
      type: "tool_call",
      name: "paseo_worktree_setup",
      callId: input.callId,
      status: "running",
      detail,
      error: null,
    };
  }

  if (input.status === "completed") {
    return {
      type: "tool_call",
      name: "paseo_worktree_setup",
      callId: input.callId,
      status: "completed",
      detail,
      error: null,
    };
  }

  return {
    type: "tool_call",
    name: "paseo_worktree_setup",
    callId: input.callId,
    status: "failed",
    detail,
    error: { message: input.errorMessage ?? "Worktree setup failed" },
  };
}

function buildTerminalTimelineItem(input: {
  callId: string;
  status: "running" | "completed" | "failed";
  worktree: WorktreeConfig;
  results: WorktreeBootstrapTerminalResult[];
  errorMessage: string | null;
}): AgentTimelineItem {
  const detailInput = {
    worktreePath: input.worktree.worktreePath,
    branchName: input.worktree.branchName,
  };
  const detailOutput = {
    worktreePath: input.worktree.worktreePath,
    terminals: input.results,
  };

  if (input.status === "running") {
    return {
      type: "tool_call",
      name: "paseo_worktree_terminals",
      callId: input.callId,
      status: "running",
      detail: {
        type: "unknown",
        input: detailInput,
        output: null,
      },
      error: null,
    };
  }

  if (input.status === "completed") {
    return {
      type: "tool_call",
      name: "paseo_worktree_terminals",
      callId: input.callId,
      status: "completed",
      detail: {
        type: "unknown",
        input: detailInput,
        output: detailOutput,
      },
      error: null,
    };
  }

  return {
    type: "tool_call",
    name: "paseo_worktree_terminals",
    callId: input.callId,
    status: "failed",
    detail: {
      type: "unknown",
      input: detailInput,
      output: detailOutput,
    },
    error: { message: input.errorMessage ?? "Worktree terminal bootstrap failed" },
  };
}

async function waitForTerminalBootstrapReadiness(
  terminal: Pick<TerminalSession, "getState" | "subscribe">,
): Promise<void> {
  if (terminalHasOutput(terminal.getState())) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      resolve();
    };

    unsubscribe = terminal.subscribe((message) => {
      if (message.type !== "output") {
        return;
      }
      finish();
    });

    if (terminalHasOutput(terminal.getState())) {
      finish();
      return;
    }

    timeout = setTimeout(finish, WORKTREE_BOOTSTRAP_TERMINAL_READY_TIMEOUT_MS);
  });
}

function terminalHasOutput(state: ReturnType<TerminalSession["getState"]>): boolean {
  for (const row of [...state.scrollback, ...state.grid]) {
    for (const cell of row) {
      if (cell.char.trim().length > 0) {
        return true;
      }
    }
  }
  return false;
}

async function runWorktreeTerminalBootstrap(
  options: RunAsyncWorktreeBootstrapOptions,
  runtimeEnv: WorktreeRuntimeEnv,
): Promise<void> {
  const terminalSpecs = getWorktreeTerminalSpecs(options.worktree.worktreePath);
  if (terminalSpecs.length === 0) {
    return;
  }

  const callId = uuidv4();
  const started = await options.appendTimelineItem(
    buildTerminalTimelineItem({
      callId,
      status: "running",
      worktree: options.worktree,
      results: [],
      errorMessage: null,
    }),
  );
  if (!started) {
    return;
  }

  if (!options.terminalManager) {
    await options.appendTimelineItem(
      buildTerminalTimelineItem({
        callId,
        status: "failed",
        worktree: options.worktree,
        results: [],
        errorMessage: "Terminal manager not available",
      }),
    );
    return;
  }

  const results: WorktreeBootstrapTerminalResult[] = [];
  for (const spec of terminalSpecs) {
    try {
      const terminal = await options.terminalManager.createTerminal({
        cwd: options.worktree.worktreePath,
        name: spec.name,
        env: runtimeEnv,
      });
      await waitForTerminalBootstrapReadiness(terminal);
      terminal.send({
        type: "input",
        data: `${spec.command}\r`,
      });
      results.push({
        name: terminal.name ?? spec.name ?? null,
        command: spec.command,
        status: "started",
        terminalId: terminal.id,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.warn(
        { agentId: options.agentId, command: spec.command, err: error },
        "Failed to bootstrap worktree terminal",
      );
      results.push({
        name: spec.name ?? null,
        command: spec.command,
        status: "failed",
        terminalId: null,
        error: message,
      });
    }
  }

  await options.appendTimelineItem(
    buildTerminalTimelineItem({
      callId,
      status: "completed",
      worktree: options.worktree,
      results,
      errorMessage: null,
    }),
  );
}

export async function runAsyncWorktreeBootstrap(
  options: RunAsyncWorktreeBootstrapOptions,
): Promise<void> {
  if (options.shouldBootstrap === false) {
    return;
  }

  const setupCallId = uuidv4();
  let setupResults: WorktreeSetupCommandResult[] = [];
  let runtimeEnv: WorktreeRuntimeEnv | null = null;
  const emitLiveTimelineItem = options.emitLiveTimelineItem;
  const progressAccumulator = createWorktreeSetupProgressAccumulator();
  let liveEmitQueue = Promise.resolve();

  const queueLiveRunningEmit = () => {
    if (!emitLiveTimelineItem) {
      return;
    }
    const runningResults = getWorktreeSetupProgressResults(progressAccumulator);
    liveEmitQueue = liveEmitQueue.then(async () => {
      try {
        await emitLiveTimelineItem(
          buildSetupTimelineItem({
            callId: setupCallId,
            status: "running",
            worktree: options.worktree,
            results: runningResults,
            outputAccumulatorsByIndex: progressAccumulator.outputAccumulatorsByIndex,
            errorMessage: null,
          }),
        );
      } catch (error) {
        options.logger?.warn(
          { err: error, agentId: options.agentId },
          "Failed to emit live worktree setup timeline update",
        );
      }
    });
  };

  try {
    runtimeEnv = await resolveWorktreeRuntimeEnv({
      worktreePath: options.worktree.worktreePath,
      branchName: options.worktree.branchName,
    });
    options.terminalManager?.registerCwdEnv({
      cwd: options.worktree.worktreePath,
      env: runtimeEnv,
    });

    setupResults = await runWorktreeSetupCommands({
      worktreePath: options.worktree.worktreePath,
      branchName: options.worktree.branchName,
      cleanupOnFailure: false,
      runtimeEnv,
      onEvent: (event) => {
        applyWorktreeSetupProgressEvent(progressAccumulator, event);
        queueLiveRunningEmit();
      },
    });
    await liveEmitQueue;

    const completed = await options.appendTimelineItem(
      buildSetupTimelineItem({
        callId: setupCallId,
        status: "completed",
        worktree: options.worktree,
        results: setupResults,
        outputAccumulatorsByIndex: progressAccumulator.outputAccumulatorsByIndex,
        errorMessage: null,
      }),
    );
    if (!completed) {
      return;
    }
  } catch (error) {
    if (error instanceof WorktreeSetupError) {
      setupResults = error.results;
    }
    await liveEmitQueue;
    const message = error instanceof Error ? error.message : String(error);
    await options.appendTimelineItem(
      buildSetupTimelineItem({
        callId: setupCallId,
        status: "failed",
        worktree: options.worktree,
        results: setupResults,
        outputAccumulatorsByIndex: progressAccumulator.outputAccumulatorsByIndex,
        errorMessage: message,
      }),
    );
    return;
  }

  await runWorktreeTerminalBootstrap(options, runtimeEnv);
}

// ---------------------------------------------------------------------------
// Script lifecycle helpers
// ---------------------------------------------------------------------------

export interface WorktreeScriptResult {
  scriptName: string;
  hostname: string | null;
  port: number | null;
  terminalId: string;
}

type SpawnWorkspaceScriptOptions = {
  repoRoot: string;
  workspaceId: string;
  branchName: string | null;
  scriptName: string;
  daemonPort?: number | null;
  daemonListenHost?: string | null;
  routeStore: ScriptRouteStore;
  runtimeStore: WorkspaceScriptRuntimeStore;
  terminalManager: TerminalManager;
  logger?: Logger;
  onLifecycleChanged?: () => void;
};

function isLoopbackListenHost(host: string | null | undefined): boolean {
  if (!host) {
    return true;
  }

  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1" ||
    normalizedHost === "[::1]"
  );
}

export function resolveServiceBindHost(daemonListenHost: string | null | undefined): string {
  return isLoopbackListenHost(daemonListenHost) ? "127.0.0.1" : "0.0.0.0";
}

export async function spawnWorkspaceScript(
  options: SpawnWorkspaceScriptOptions,
): Promise<WorktreeScriptResult> {
  const {
    repoRoot,
    workspaceId,
    branchName,
    scriptName,
    daemonPort,
    daemonListenHost,
    routeStore,
    runtimeStore,
    terminalManager,
    logger,
    onLifecycleChanged,
  } = options;
  const scriptConfigs = getScriptConfigs(repoRoot);
  const config = scriptConfigs.get(scriptName);
  if (!config) {
    throw new Error(`Script '${scriptName}' is not configured in paseo.json`);
  }

  const serviceScript = isServiceScript(config);
  const hostname = serviceScript ? buildScriptHostname(branchName, scriptName) : null;
  let port: number | null = null;
  let terminal: TerminalSession | null = null;
  let runtimeRegistered = false;

  try {
    if (runtimeStore.isRunning({ workspaceId, scriptName })) {
      throw new Error(`Script '${scriptName}' is already running`);
    }

    if (serviceScript) {
      port = config.port ?? (await findFreePort());
      routeStore.registerRoute({
        hostname: hostname!,
        port,
        workspaceId,
        scriptName,
      });
    }

    const env = serviceScript
      ? {
          PORT: String(port),
          HOST: resolveServiceBindHost(daemonListenHost),
          ...(daemonPort !== null && daemonPort !== undefined
            ? {
                PASEO_SCRIPT_URL: `http://${hostname!}:${daemonPort}`,
              }
            : {}),
        }
      : undefined;

    terminal = await terminalManager.createTerminal({
      cwd: repoRoot,
      name: scriptName,
      env,
    });
    runtimeStore.set({
      workspaceId,
      scriptName,
      type: serviceScript ? "service" : "script",
      lifecycle: "running",
      terminalId: terminal.id,
      exitCode: null,
    });
    runtimeRegistered = true;

    terminal.onExit((info) => {
      if (hostname) {
        routeStore.removeRoute(hostname);
      }
      runtimeStore.set({
        workspaceId,
        scriptName,
        type: serviceScript ? "service" : "script",
        lifecycle: "stopped",
        terminalId: terminal!.id,
        exitCode: info.exitCode,
      });
      onLifecycleChanged?.();
      logger?.info(
        {
          scriptName,
          hostname,
          exitCode: info.exitCode,
          terminalId: terminal!.id,
        },
        "Stopped worktree script",
      );
    });

    await waitForTerminalBootstrapReadiness(terminal);
    terminal.send({ type: "input", data: `${config.command}\r` });

    logger?.info(
      {
        scriptName,
        hostname,
        port,
        terminalId: terminal.id,
        type: serviceScript ? "service" : "script",
      },
      serviceScript
        ? `Registered script proxy: ${hostname} -> 127.0.0.1:${port}`
        : "Started workspace script",
    );

    onLifecycleChanged?.();
    return {
      scriptName,
      hostname,
      port,
      terminalId: terminal.id,
    };
  } catch (error) {
    if (hostname && port !== null) {
      routeStore.removeRoute(hostname);
    }
    if (runtimeRegistered) {
      runtimeStore.remove({ workspaceId, scriptName });
    }
    logger?.error(
      {
        err: error,
        scriptName,
        repoRoot,
        branchName,
        hostname,
        port,
        command: config.command,
      },
      "Failed to spawn worktree script",
    );
    throw error;
  }
}

export async function spawnWorktreeScripts(options: {
  repoRoot: string;
  workspaceId: string;
  branchName: string | null;
  daemonPort?: number | null;
  daemonListenHost?: string | null;
  routeStore: ScriptRouteStore;
  runtimeStore: WorkspaceScriptRuntimeStore;
  terminalManager: TerminalManager;
  logger?: Logger;
  onLifecycleChanged?: () => void;
}): Promise<WorktreeScriptResult[]> {
  const { repoRoot } = options;
  const scriptConfigs = getScriptConfigs(repoRoot);
  if (scriptConfigs.size === 0) {
    return [];
  }

  const results: WorktreeScriptResult[] = [];
  for (const scriptName of scriptConfigs.keys()) {
    results.push(
      await spawnWorkspaceScript({
        ...options,
        scriptName,
      }),
    );
  }

  return results;
}

export function teardownWorktreeScripts(options: {
  hostnames: string[];
  routeStore: ScriptRouteStore;
  logger: Logger;
}): void {
  const { hostnames, routeStore, logger } = options;
  for (const hostname of hostnames) {
    routeStore.removeRoute(hostname);
    logger.info({ hostname }, "Removed script proxy route");
  }
}
