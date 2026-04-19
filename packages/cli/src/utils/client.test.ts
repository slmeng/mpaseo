import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonClientMock = vi.hoisted(() => {
  const instances: Array<{
    config: Record<string, unknown>;
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  class MockDaemonClient {
    readonly config: Record<string, unknown>;
    readonly connect = vi.fn(async () => {});
    readonly close = vi.fn(async () => {});

    constructor(config: Record<string, unknown>) {
      this.config = config;
      instances.push({ config, connect: this.connect, close: this.close });
    }
  }

  return {
    MockDaemonClient,
    instances,
  };
});

vi.mock("@getpaseo/server", () => ({
  loadConfig: vi.fn(() => ({ listen: "127.0.0.1:6767" })),
  resolvePaseoHome: vi.fn(() => "/tmp/paseo-home"),
  DaemonClient: daemonClientMock.MockDaemonClient,
}));

vi.mock("./client-id.js", () => ({
  getOrCreateCliClientId: vi.fn(async () => "cid_test_client"),
}));

import { connectToDaemon } from "./client.js";
import { resolveCliVersion } from "./cli-version.js";

describe("connectToDaemon", () => {
  beforeEach(() => {
    daemonClientMock.instances.length = 0;
  });

  it("passes the CLI appVersion in the daemon hello config", async () => {
    const client = await connectToDaemon({ host: "127.0.0.1:6767", timeout: 1234 });

    expect(daemonClientMock.instances).toHaveLength(1);
    expect(daemonClientMock.instances[0]?.config).toMatchObject({
      url: "ws://127.0.0.1:6767/ws",
      clientId: "cid_test_client",
      clientType: "cli",
      connectTimeoutMs: 1234,
      appVersion: resolveCliVersion(),
      reconnect: { enabled: false },
    });

    await client.close();
  });
});
