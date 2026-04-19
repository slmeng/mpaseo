import type { Command } from "commander";
import {
  clearLine,
  createInterface,
  cursorTo,
  type Interface as ReadlineInterface,
} from "node:readline";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { fetchProjectedTimelineItems } from "../../utils/timeline.js";
import type {
  DaemonClient,
  AgentStreamMessage,
  AgentStreamEventPayload,
  AgentTimelineItem,
} from "@getpaseo/server";

export function addAttachOptions(cmd: Command): Command {
  return cmd
    .description("Attach to a running agent's output stream")
    .argument("<id>", "Agent ID (or prefix)")
    .option("-i, --interactive", "Stay attached and send messages from the same terminal");
}

export interface AgentAttachOptions {
  host?: string;
  interactive?: boolean;
  [key: string]: unknown;
}

type PrintedOutput = {
  endedWithNewline: boolean;
  deferPromptRefresh: boolean;
};

type InteractivePromptState = {
  rl: ReadlineInterface;
  promptRefreshTimer: ReturnType<typeof setTimeout> | null;
  assistantStreaming: boolean;
  promptNeedsNewline: boolean;
};

type LiveAttachState = {
  reasoningBuffer: string;
  reasoningFlushTimer: ReturnType<typeof setTimeout> | null;
  lastToolStatusByCallId: Map<string, string>;
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildPermitAllowCommand(params: {
  host: string;
  agentId: string;
  requestId: string;
}): string {
  return [
    "paseo",
    "permit",
    "allow",
    "--host",
    shellQuote(params.host),
    shellQuote(params.agentId),
    shellQuote(params.requestId.slice(0, 8)),
  ].join(" ");
}

/**
 * Format and print a timeline item to the terminal
 */
function printTimelineItem(item: AgentTimelineItem): PrintedOutput {
  switch (item.type) {
    case "assistant_message":
      process.stdout.write(item.text);
      return {
        endedWithNewline: item.text.endsWith("\n"),
        deferPromptRefresh: true,
      };

    case "reasoning":
      console.log(`\n[Reasoning] ${item.text}`);
      return { endedWithNewline: true, deferPromptRefresh: false };

    case "tool_call": {
      const toolName = item.name;
      const status = item.status ?? "started";
      console.log(`\n[Tool: ${toolName}] ${status}`);
      return { endedWithNewline: true, deferPromptRefresh: false };
    }

    case "todo": {
      const completed = item.items.filter((i) => i.completed).length;
      const total = item.items.length;
      console.log(`\n[Todo] ${completed}/${total} completed`);
      return { endedWithNewline: true, deferPromptRefresh: false };
    }

    case "error":
      console.error(`\n[Error] ${item.message}`);
      return { endedWithNewline: true, deferPromptRefresh: false };

    case "user_message":
      console.log(`\n[User] ${item.text}`);
      return { endedWithNewline: true, deferPromptRefresh: false };

    default:
      return { endedWithNewline: true, deferPromptRefresh: false };
  }
}

/**
 * Format and print a stream event to the terminal
 */
function printStreamEvent(
  event: AgentStreamEventPayload,
  context?: { host: string; agentId: string },
): PrintedOutput {
  switch (event.type) {
    case "timeline":
      return printTimelineItem(event.item);

    case "permission_requested":
      console.log(`\n[Permission Required] ${event.request.name}`);
      if (event.request.description) {
        console.log(`  ${event.request.description}`);
      }
      if (context) {
        console.log(
          `  Allow: ${buildPermitAllowCommand({
            host: context.host,
            agentId: context.agentId,
            requestId: event.request.id,
          })}`,
        );
      }
      return { endedWithNewline: true, deferPromptRefresh: false };

    case "permission_resolved":
      console.log(`\n[Permission ${event.resolution.behavior}]`);
      return { endedWithNewline: true, deferPromptRefresh: false };

    case "turn_failed":
      console.error(`\n[Turn Failed] ${event.error}`);
      return { endedWithNewline: true, deferPromptRefresh: false };

    case "attention_required":
      console.log(`\n[Attention Required: ${event.reason}]`);
      return { endedWithNewline: true, deferPromptRefresh: false };

    default:
      return { endedWithNewline: true, deferPromptRefresh: false };
  }
}

function cancelPromptRefresh(state: InteractivePromptState | null): void {
  if (!state?.promptRefreshTimer) {
    return;
  }
  clearTimeout(state.promptRefreshTimer);
  state.promptRefreshTimer = null;
}

function refreshPrompt(state: InteractivePromptState | null): void {
  if (!state) {
    return;
  }
  cancelPromptRefresh(state);
  const rlWithRefresh = state.rl as ReadlineInterface & { _refreshLine?: () => void };
  if (typeof rlWithRefresh._refreshLine === "function") {
    rlWithRefresh._refreshLine();
    return;
  }
  state.rl.prompt();
}

function schedulePromptRefresh(state: InteractivePromptState | null, delayMs = 150): void {
  if (!state) {
    return;
  }
  cancelPromptRefresh(state);
  state.promptRefreshTimer = setTimeout(() => {
    state.promptRefreshTimer = null;
    refreshPrompt(state);
  }, delayMs);
}

function prepareInteractiveOutput(state: InteractivePromptState | null): void {
  if (!state) {
    return;
  }
  cancelPromptRefresh(state);
  if (process.stdout.isTTY) {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
  }
}

function finishAssistantStreamingIfNeeded(state: InteractivePromptState | null): void {
  if (!state?.assistantStreaming) {
    return;
  }
  state.assistantStreaming = false;
  if (state.promptNeedsNewline) {
    process.stdout.write("\n");
    state.promptNeedsNewline = false;
  }
}

function renderInteractiveOutput(
  state: InteractivePromptState | null,
  render: () => PrintedOutput,
  options?: { isAssistantChunk?: boolean },
): void {
  if (!state) {
    render();
    return;
  }

  const isAssistantChunk = options?.isAssistantChunk === true;

  if (isAssistantChunk) {
    cancelPromptRefresh(state);
    if (!state.assistantStreaming) {
      prepareInteractiveOutput(state);
    }
    const output = render();
    state.assistantStreaming = true;
    state.promptNeedsNewline = !output.endedWithNewline;
    return;
  }

  finishAssistantStreamingIfNeeded(state);
  prepareInteractiveOutput(state);
  const output = render();
  if (output.deferPromptRefresh) {
    schedulePromptRefresh(state);
    return;
  }
  if (!output.endedWithNewline) {
    process.stdout.write("\n");
  }
  refreshPrompt(state);
}

function printInteractiveHelp(state: InteractivePromptState | null): void {
  renderInteractiveOutput(state, () => {
    console.log("\n[Interactive commands]");
    console.log("  /help       Show this help");
    console.log("  /interrupt  Stop the current agent turn");
    console.log("  /quit       Detach from the agent");
    console.log("  /exit       Detach from the agent");
    return { endedWithNewline: true, deferPromptRefresh: false };
  });
}

function cancelReasoningFlush(state: LiveAttachState): void {
  if (!state.reasoningFlushTimer) {
    return;
  }
  clearTimeout(state.reasoningFlushTimer);
  state.reasoningFlushTimer = null;
}

function normalizeReasoningText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function flushReasoningBuffer(
  liveState: LiveAttachState,
  interactiveState: InteractivePromptState | null,
): void {
  cancelReasoningFlush(liveState);
  const reasoning = normalizeReasoningText(liveState.reasoningBuffer);
  if (!reasoning) {
    liveState.reasoningBuffer = "";
    return;
  }
  liveState.reasoningBuffer = "";
  renderInteractiveOutput(interactiveState, () => {
    console.log(`\n[Reasoning] ${reasoning}`);
    return { endedWithNewline: true, deferPromptRefresh: false };
  });
}

function scheduleReasoningFlush(
  liveState: LiveAttachState,
  interactiveState: InteractivePromptState | null,
): void {
  cancelReasoningFlush(liveState);
  liveState.reasoningFlushTimer = setTimeout(() => {
    liveState.reasoningFlushTimer = null;
    flushReasoningBuffer(liveState, interactiveState);
  }, 250);
}

function shouldPrintToolCallUpdate(
  liveState: LiveAttachState,
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
): boolean {
  const status = item.status ?? "started";
  const previousStatus = liveState.lastToolStatusByCallId.get(item.callId);
  if (previousStatus === status) {
    return false;
  }
  liveState.lastToolStatusByCallId.set(item.callId, status);
  return true;
}

/**
 * Attach to a running agent's output stream
 */
export async function runAttachCommand(
  id: string,
  options: AgentAttachOptions,
  _command: Command,
): Promise<void> {
  const host = getDaemonHost({ host: options.host as string | undefined });
  const interactive = options.interactive === true;

  if (!id) {
    console.error("Error: Agent ID required");
    console.error("Usage: paseo attach <id>");
    process.exit(1);
  }

  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.error("Error: --interactive requires a TTY on both stdin and stdout");
    process.exit(1);
  }

  let client: DaemonClient;
  try {
    client = await connectToDaemon({ host: options.host as string | undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Cannot connect to daemon at ${host}: ${message}`);
    console.error("Start the daemon with: paseo daemon start");
    process.exit(1);
  }

  try {
    const fetchResult = await client.fetchAgent(id);
    if (!fetchResult) {
      console.error(`Error: No agent found matching: ${id}`);
      console.error("Use `paseo ls` to list available agents");
      await client.close();
      process.exit(1);
    }
    const resolvedId = fetchResult.agent.id;

    console.log(`Attaching to agent ${resolvedId.substring(0, 7)}...`);
    if (interactive) {
      console.log("(Press Ctrl+C to detach, type /help for interactive commands)\n");
    } else {
      console.log("(Press Ctrl+C to detach)\n");
    }

    try {
      const timelineItems = await fetchProjectedTimelineItems({
        client,
        agentId: resolvedId,
      });
      for (const item of timelineItems) {
        printTimelineItem(item);
      }
      if (interactive && timelineItems.length > 0) {
        process.stdout.write("\n");
      }
    } catch (error) {
      console.warn("Warning: failed to fetch existing timeline", error);
    }

    const interactiveState: InteractivePromptState | null = interactive
      ? {
          rl: createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: "> ",
          }),
          promptRefreshTimer: null,
          assistantStreaming: false,
          promptNeedsNewline: false,
        }
      : null;
    const liveState: LiveAttachState = {
      reasoningBuffer: "",
      reasoningFlushTimer: null,
      lastToolStatusByCallId: new Map(),
    };

    const unsubscribe = client.on("agent_stream", (msg: unknown) => {
      const message = msg as AgentStreamMessage;
      if (message.type !== "agent_stream") return;
      if (message.payload.agentId !== resolvedId) return;

      const event = message.payload.event;
      if (event.type === "timeline") {
        if (event.item.type === "reasoning") {
          liveState.reasoningBuffer += event.item.text;
          scheduleReasoningFlush(liveState, interactiveState);
          return;
        }

        flushReasoningBuffer(liveState, interactiveState);

        if (event.item.type === "tool_call" && !shouldPrintToolCallUpdate(liveState, event.item)) {
          return;
        }
      } else {
        flushReasoningBuffer(liveState, interactiveState);
      }

      const isAssistantChunk = event.type === "timeline" && event.item.type === "assistant_message";

      renderInteractiveOutput(
        interactiveState,
        () =>
          printStreamEvent(event, {
            host,
            agentId: resolvedId,
          }),
        { isAssistantChunk },
      );
    });

    let detached = false;
    let resolveDetached: (() => void) | null = null;
    const detachedPromise = new Promise<void>((resolve) => {
      resolveDetached = resolve;
    });

    const detach = () => {
      if (detached) return;
      detached = true;
      cancelPromptRefresh(interactiveState);
      finishAssistantStreamingIfNeeded(interactiveState);
      flushReasoningBuffer(liveState, interactiveState);
      process.off("SIGINT", detach);
      process.off("SIGTERM", detach);
      unsubscribe();
      interactiveState?.rl.removeAllListeners();
      interactiveState?.rl.close();
      console.log("\n\nDetaching from agent...");
      void client.close().finally(() => {
        resolveDetached?.();
      });
    };

    if (interactiveState) {
      let commandQueue = Promise.resolve();
      interactiveState.rl.on("line", (line) => {
        commandQueue = commandQueue
          .then(async () => {
            const text = line.trim();
            if (!text) {
              finishAssistantStreamingIfNeeded(interactiveState);
              flushReasoningBuffer(liveState, interactiveState);
              refreshPrompt(interactiveState);
              return;
            }
            if (text === "/quit" || text === "/exit") {
              detach();
              return;
            }
            if (text === "/help") {
              printInteractiveHelp(interactiveState);
              return;
            }
            if (text === "/interrupt") {
              finishAssistantStreamingIfNeeded(interactiveState);
              flushReasoningBuffer(liveState, interactiveState);
              prepareInteractiveOutput(interactiveState);
              try {
                await client.cancelAgent(resolvedId);
                console.log("\n[Interrupted current agent turn]");
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`\n[Interrupt failed] ${message}`);
              }
              refreshPrompt(interactiveState);
              return;
            }

            finishAssistantStreamingIfNeeded(interactiveState);
            flushReasoningBuffer(liveState, interactiveState);
            prepareInteractiveOutput(interactiveState);
            try {
              await client.sendAgentMessage(resolvedId, text);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`\n[Send failed] ${message}`);
              finishAssistantStreamingIfNeeded(interactiveState);
              flushReasoningBuffer(liveState, interactiveState);
              refreshPrompt(interactiveState);
            }
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`\n[Interactive error] ${message}`);
            finishAssistantStreamingIfNeeded(interactiveState);
            flushReasoningBuffer(liveState, interactiveState);
            refreshPrompt(interactiveState);
          });
      });
      interactiveState.rl.on("SIGINT", detach);
      refreshPrompt(interactiveState);
    }

    process.on("SIGINT", detach);
    process.on("SIGTERM", detach);

    await detachedPromise;
  } catch (err) {
    await client.close().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to attach to agent: ${message}`);
    process.exit(1);
  }
}
