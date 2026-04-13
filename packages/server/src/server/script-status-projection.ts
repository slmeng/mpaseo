import type {
  ScriptStatusUpdateMessage,
  SessionOutboundMessage,
  WorkspaceScriptPayload,
} from "../shared/messages.js";
import { buildScriptHostname } from "../utils/script-hostname.js";
import { getScriptConfigs, isServiceScript } from "../utils/worktree.js";
import { readGitCommand } from "./workspace-git-metadata.js";
import type { ScriptHealthEntry, ScriptHealthState } from "./script-health-monitor.js";
import type { ScriptRouteStore } from "./script-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";

type SessionEmitter = {
  emit(message: SessionOutboundMessage): void;
};

type BuildWorkspaceScriptPayloadsOptions = {
  workspaceDirectory: string;
  routeStore: ScriptRouteStore;
  runtimeStore: WorkspaceScriptRuntimeStore;
  daemonPort: number | null;
  resolveHealth?: (hostname: string) => ScriptHealthState | null;
};

function resolveDaemonPort(daemonPort: number | null | (() => number | null)): number | null {
  if (typeof daemonPort === "function") {
    return daemonPort();
  }
  return daemonPort;
}

function resolveWorkspaceBranchName(workspaceDirectory: string): string | null {
  return readGitCommand(workspaceDirectory, "git symbolic-ref --short HEAD");
}

function toServiceProxyUrl(hostname: string, daemonPort: number | null): string | null {
  if (daemonPort === null) {
    return null;
  }
  return `http://${hostname}:${daemonPort}`;
}

function toWireHealth(health: ScriptHealthState | null): WorkspaceScriptPayload["health"] {
  if (health === "pending" || health === null) {
    return null;
  }
  return health;
}

function createConfiguredPayload(input: {
  scriptName: string;
  type: WorkspaceScriptPayload["type"];
  branchName: string | null;
  daemonPort: number | null;
  configuredPort: number | null;
}): WorkspaceScriptPayload {
  const hostname =
    input.type === "service"
      ? buildScriptHostname(input.branchName, input.scriptName)
      : input.scriptName;

  return {
    scriptName: input.scriptName,
    type: input.type,
    hostname,
    port: input.type === "service" ? input.configuredPort : null,
    proxyUrl: input.type === "service" ? toServiceProxyUrl(hostname, input.daemonPort) : null,
    lifecycle: "stopped",
    health: null,
    exitCode: null,
  };
}

function sortPayloads(payloads: WorkspaceScriptPayload[]): WorkspaceScriptPayload[] {
  return payloads.sort((left, right) =>
    left.scriptName.localeCompare(right.scriptName, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

export function buildWorkspaceScriptPayloads(
  options: BuildWorkspaceScriptPayloadsOptions,
): WorkspaceScriptPayload[] {
  const workspaceDirectory = options.workspaceDirectory;
  const branchName = resolveWorkspaceBranchName(workspaceDirectory);
  const scriptConfigs = getScriptConfigs(workspaceDirectory);
  const runtimeEntries = new Map(
    options.runtimeStore
      .listForWorkspace(workspaceDirectory)
      .map((entry) => [entry.scriptName, entry] as const),
  );
  const routesByScriptName = new Map(
    options.routeStore
      .listRoutesForWorkspace(workspaceDirectory)
      .map((entry) => [entry.scriptName, entry] as const),
  );

  const payloads: WorkspaceScriptPayload[] = [];

  for (const [scriptName, config] of scriptConfigs.entries()) {
    const type = isServiceScript(config) ? "service" : "script";
    const runtimeEntry = runtimeEntries.get(scriptName) ?? null;
    const routeEntry = routesByScriptName.get(scriptName) ?? null;

    const payload = createConfiguredPayload({
      scriptName,
      type,
      branchName,
      daemonPort: options.daemonPort,
      configuredPort: isServiceScript(config) ? (config.port ?? null) : null,
    });

    payloads.push({
      ...payload,
      hostname:
        type === "service" ? (routeEntry?.hostname ?? payload.hostname) : payload.scriptName,
      port: type === "service" ? (routeEntry?.port ?? payload.port) : null,
      proxyUrl:
        type === "service"
          ? toServiceProxyUrl(routeEntry?.hostname ?? payload.hostname, options.daemonPort)
          : null,
      lifecycle: runtimeEntry?.lifecycle ?? payload.lifecycle,
      health:
        type === "service"
          ? toWireHealth(options.resolveHealth?.(routeEntry?.hostname ?? payload.hostname) ?? null)
          : null,
      exitCode: runtimeEntry?.exitCode ?? null,
    });
  }

  for (const runtimeEntry of runtimeEntries.values()) {
    if (scriptConfigs.has(runtimeEntry.scriptName) || runtimeEntry.lifecycle !== "running") {
      continue;
    }

    const routeEntry = routesByScriptName.get(runtimeEntry.scriptName) ?? null;
    const type = runtimeEntry.type;
    const hostname =
      type === "service"
        ? (routeEntry?.hostname ?? buildScriptHostname(branchName, runtimeEntry.scriptName))
        : runtimeEntry.scriptName;
    payloads.push({
      scriptName: runtimeEntry.scriptName,
      type,
      hostname,
      port: type === "service" ? (routeEntry?.port ?? null) : null,
      proxyUrl: type === "service" ? toServiceProxyUrl(hostname, options.daemonPort) : null,
      lifecycle: runtimeEntry.lifecycle,
      health:
        type === "service" && routeEntry
          ? toWireHealth(options.resolveHealth?.(hostname) ?? null)
          : null,
      exitCode: runtimeEntry.exitCode,
    });
  }

  return sortPayloads(payloads);
}

function buildScriptStatusUpdateMessage(params: {
  workspaceId: string;
  scripts: WorkspaceScriptPayload[];
}): ScriptStatusUpdateMessage {
  return {
    type: "script_status_update",
    payload: {
      workspaceId: params.workspaceId,
      scripts: params.scripts,
    },
  };
}

export function createScriptStatusEmitter({
  sessions,
  routeStore,
  runtimeStore,
  daemonPort,
}: {
  sessions: () => SessionEmitter[];
  routeStore: ScriptRouteStore;
  runtimeStore: WorkspaceScriptRuntimeStore;
  daemonPort: number | null | (() => number | null);
}): (workspaceId: string, scripts: ScriptHealthEntry[]) => void {
  return (workspaceId, scripts) => {
    const resolvedDaemonPort = resolveDaemonPort(daemonPort);
    const scriptHealthByHostname = new Map(
      scripts.map((script) => [script.hostname, script.health] as const),
    );

    const projected = buildWorkspaceScriptPayloads({
      workspaceDirectory: workspaceId,
      routeStore,
      runtimeStore,
      daemonPort: resolvedDaemonPort,
      resolveHealth: (hostname) => scriptHealthByHostname.get(hostname) ?? null,
    });

    const message = buildScriptStatusUpdateMessage({
      workspaceId,
      scripts: projected,
    });

    for (const session of sessions()) {
      session.emit(message);
    }
  };
}
