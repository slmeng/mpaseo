import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@server/shared/messages";
import type { StreamItem } from "@/types/stream";
import {
  processTimelineResponse,
  processAgentStreamEvent,
  type ProcessTimelineResponseInput,
  type ProcessAgentStreamEventInput,
  type TimelineCursor,
} from "./session-stream-reducers";

function makeTimelineEntry(seq: number, text: string, type: string = "assistant_message") {
  return {
    seq,
    provider: "claude",
    item: { type, text },
    timestamp: new Date(1000 + seq).toISOString(),
  };
}

function makeTimelineEvent(
  text: string,
  type: string = "assistant_message",
): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: { type, text },
  } as AgentStreamEventPayload;
}

function makeToolCallEvent(status: "running" | "completed"): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: {
      type: "tool_call",
      callId: "call-1",
      name: "shell",
      status,
      detail: {
        type: "shell",
        command: "pwd",
      },
      error: null,
    },
  };
}

const baseTimelineInput: ProcessTimelineResponseInput = {
  payload: {
    agentId: "agent-1",
    direction: "after",
    startSeq: null,
    endSeq: null,
    entries: [],
    error: null,
  },
  currentTail: [],
  currentHead: [],
  currentCursor: undefined,
  isInitializing: false,
  hasActiveInitDeferred: false,
  initRequestDirection: "tail",
};

const baseStreamInput: ProcessAgentStreamEventInput = {
  event: makeTimelineEvent("hello"),
  seq: undefined,
  currentTail: [],
  currentHead: [],
  currentCursor: undefined,
  currentAgent: null,
  timestamp: new Date(2000),
};

describe("processTimelineResponse", () => {
  it("returns error path when payload.error is set", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        error: "something broke",
      },
    });

    expect(result.error).toBe("something broke");
    expect(result.initResolution).toBe("reject");
    expect(result.clearInitializing).toBe(true);
    expect(result.tail).toBe(baseTimelineInput.currentTail);
    expect(result.head).toBe(baseTimelineInput.currentHead);
    expect(result.cursorChanged).toBe(false);
  });

  it("replaces tail during bootstrap tail init and schedules committed catch-up", () => {
    const provisionalHead: StreamItem[] = [
      {
        kind: "assistant_message",
        id: "head-1",
        text: "streaming",
        timestamp: new Date(600),
      },
    ];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentHead: provisionalHead,
      isInitializing: true,
      hasActiveInitDeferred: true,
      initRequestDirection: "tail",
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        startSeq: 1,
        endSeq: 5,
        entries: [makeTimelineEntry(1, "first"), makeTimelineEntry(5, "last")],
      },
    });

    expect(result.tail.length).toBeGreaterThan(0);
    expect(result.head).toEqual([]);
    expect(result.cursorChanged).toBe(true);
    expect(result.cursor).toEqual({
      startSeq: 1,
      endSeq: 5,
    });

    const catchUp = result.sideEffects.find((effect) => effect.type === "catch_up");
    expect(catchUp).toEqual({
      type: "catch_up",
      cursor: { endSeq: 5 },
    });
  });

  it("prepends older committed history for before pagination", () => {
    const currentTail: StreamItem[] = [
      {
        kind: "assistant_message",
        id: "tail-3",
        text: "newer",
        timestamp: new Date(3000),
      },
    ];
    const currentCursor: TimelineCursor = { startSeq: 3, endSeq: 4 };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor,
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        startSeq: 1,
        endSeq: 2,
        entries: [makeTimelineEntry(1, "hello", "user_message"), makeTimelineEntry(2, "older")],
      },
    });

    expect(result.cursorChanged).toBe(true);
    expect(result.cursor).toEqual({
      startSeq: 1,
      endSeq: 4,
    });
    expect(result.tail).toHaveLength(3);
    expect(result.tail[0]?.kind).toBe("user_message");
    expect(result.tail[1]?.kind).toBe("assistant_message");
    expect(result.tail[2]).toBe(currentTail[0]);
  });

  it("replaces stale provisional assistant UI when fetch-after returns committed row 121", () => {
    const currentHead: StreamItem[] = [
      {
        kind: "assistant_message",
        id: "head-assistant",
        text: "partial",
        timestamp: new Date(120000),
      },
    ];
    const currentCursor: TimelineCursor = { startSeq: 1, endSeq: 120 };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentHead,
      currentCursor,
      payload: {
        ...baseTimelineInput.payload,
        direction: "after",
        startSeq: 121,
        endSeq: 121,
        entries: [makeTimelineEntry(121, "finalized reply")],
      },
    });

    expect(result.head).toEqual([]);
    expect(result.cursorChanged).toBe(true);
    expect(result.cursor).toEqual({
      startSeq: 1,
      endSeq: 121,
    });
    expect(result.tail[result.tail.length - 1]).toMatchObject({
      kind: "assistant_message",
      text: "finalized reply",
    });
  });

  it("keeps provisional head when reconnect catch-up has no new committed rows yet", () => {
    const currentHead: StreamItem[] = [
      {
        kind: "assistant_message",
        id: "head-assistant",
        text: "still streaming",
        timestamp: new Date(120000),
      },
    ];
    const currentCursor: TimelineCursor = { startSeq: 1, endSeq: 120 };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentHead,
      currentCursor,
      payload: {
        ...baseTimelineInput.payload,
        direction: "after",
        startSeq: null,
        endSeq: null,
        entries: [],
      },
    });

    expect(result.head).toBe(currentHead);
    expect(result.cursorChanged).toBe(false);
    expect(result.tail).toBe(baseTimelineInput.currentTail);
  });

  it("requests catch-up when committed rows arrive with a forward gap", () => {
    const currentCursor: TimelineCursor = { startSeq: 1, endSeq: 120 };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentCursor,
      payload: {
        ...baseTimelineInput.payload,
        direction: "after",
        startSeq: 125,
        endSeq: 125,
        entries: [makeTimelineEntry(125, "far ahead")],
      },
    });

    expect(result.cursorChanged).toBe(false);
    expect(result.tail).toBe(baseTimelineInput.currentTail);
    expect(result.sideEffects).toContainEqual({
      type: "catch_up",
      cursor: { endSeq: 120 },
    });
  });
});

describe("processAgentStreamEvent", () => {
  it("treats seq-less timeline events as provisional head updates", () => {
    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("partial"),
      seq: undefined,
    });

    expect(result.changedHead).toBe(true);
    expect(result.changedTail).toBe(false);
    expect(result.head).toHaveLength(1);
    expect(result.head[0]).toMatchObject({
      kind: "assistant_message",
      text: "partial",
    });
    expect(result.cursorChanged).toBe(false);
  });

  it("keeps tool call rows anchored in tail across live and committed updates", () => {
    const running = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeToolCallEvent("running"),
      seq: undefined,
    });
    expect(running.head).toEqual([]);
    expect(running.tail).toHaveLength(1);
    expect(running.tail[0]).toMatchObject({
      kind: "tool_call",
      payload: {
        source: "agent",
        data: {
          callId: "call-1",
          status: "running",
        },
      },
    });

    const completedLive = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeToolCallEvent("completed"),
      seq: undefined,
      currentHead: running.head,
      currentTail: running.tail,
      currentCursor: { startSeq: 1, endSeq: 7 },
    });
    expect(completedLive.head).toEqual([]);
    expect(completedLive.tail).toHaveLength(1);
    expect(completedLive.tail[0]).toMatchObject({
      kind: "tool_call",
      payload: {
        source: "agent",
        data: {
          callId: "call-1",
          status: "completed",
        },
      },
    });

    const committed = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeToolCallEvent("completed"),
      seq: 8,
      currentHead: completedLive.head,
      currentTail: completedLive.tail,
      currentCursor: { startSeq: 1, endSeq: 7 },
    });

    expect(committed.head).toEqual([]);
    expect(committed.tail).toHaveLength(1);
    expect(committed.tail[0]).toMatchObject({
      kind: "tool_call",
      payload: {
        source: "agent",
        data: {
          callId: "call-1",
          status: "completed",
        },
      },
    });
  });

  it("preserves assistant/tool interleaving while a turn is streaming", () => {
    const assistantBeforeTool = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("before"),
      seq: undefined,
    });

    const runningTool = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeToolCallEvent("running"),
      seq: undefined,
      currentHead: assistantBeforeTool.head,
      currentTail: assistantBeforeTool.tail,
    });

    const assistantAfterTool = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("after"),
      seq: undefined,
      currentHead: runningTool.head,
      currentTail: runningTool.tail,
    });

    const completedTool = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeToolCallEvent("completed"),
      seq: undefined,
      currentHead: assistantAfterTool.head,
      currentTail: assistantAfterTool.tail,
    });

    expect(completedTool.head).toEqual([]);
    expect(completedTool.tail.map((item) => item.kind)).toEqual([
      "assistant_message",
      "tool_call",
      "assistant_message",
    ]);
    expect(
      completedTool.tail[0]?.kind === "assistant_message" ? completedTool.tail[0].text : null,
    ).toBe("before");
    expect(
      completedTool.tail[2]?.kind === "assistant_message" ? completedTool.tail[2].text : null,
    ).toBe("after");
  });

  it("requests catch-up when a committed live row skips ahead", () => {
    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("far ahead"),
      seq: 125,
      currentCursor: { startSeq: 1, endSeq: 120 },
    });

    expect(result.changedTail).toBe(false);
    expect(result.changedHead).toBe(false);
    expect(result.cursorChanged).toBe(false);
    expect(result.sideEffects).toContainEqual({
      type: "catch_up",
      cursor: { endSeq: 120 },
    });
  });

  it("flushes provisional head into tail on terminal turn events", () => {
    const withHead = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("streaming"),
      seq: undefined,
    });

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: {
        type: "turn_completed",
        provider: "claude",
      },
      currentHead: withHead.head,
      currentTail: withHead.tail,
    });

    expect(result.changedHead).toBe(true);
    expect(result.changedTail).toBe(true);
    expect(result.head).toEqual([]);
    expect(result.tail).toHaveLength(1);
    expect(result.tail[0]).toMatchObject({
      kind: "assistant_message",
      text: "streaming",
    });
  });
});
