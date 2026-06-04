import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockNewSession } = vi.hoisted(() => ({
  mockNewSession: vi.fn(),
}));

vi.mock("webdriver", () => ({
  default: { newSession: mockNewSession },
}));

import { AutomationMcpServer } from "../src/server-factory.js";
import type { ProxyClientLike } from "../src/lib/types.js";

function fakeSpawn(toolNames: string[]) {
  const client: ProxyClientLike = {
    async listTools() {
      return {
        tools: toolNames.map((name) => ({
          name,
          description: "",
          inputSchema: { type: "object" },
        })),
      };
    },
    async callTool() {
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {},
  };
  return async () => ({ client, close: async () => client.close() });
}

describe("AutomationMcpServer", () => {
  let testingBotApi: any;
  let config: any;
  const originalNode = process.versions.node;

  beforeEach(() => {
    testingBotApi = {
      getUserInfo: vi.fn().mockResolvedValue({ email: "ada@example.com" }),
      getAuthenticationHashForSharing: vi.fn().mockReturnValue("hash"),
      createSession: vi.fn(),
    };
    config = { "testingbot-key": "k", "testingbot-secret": "s" };
  });

  afterEach(() => {
    Object.defineProperty(process.versions, "node", {
      value: originalNode,
      configurable: true,
    });
  });

  function setNodeVersion(version: string) {
    Object.defineProperty(process.versions, "node", {
      value: version,
      configurable: true,
    });
  }

  it("passes preflight with a supported Node version and valid credentials", async () => {
    setNodeVersion("20.10.0");
    const server = new AutomationMcpServer(testingBotApi, config);
    await expect(server.preflight()).resolves.toBeUndefined();
    expect(testingBotApi.getUserInfo).toHaveBeenCalledOnce();
  });

  it("rejects unsupported Node versions before hitting the API", async () => {
    setNodeVersion("16.20.0");
    const server = new AutomationMcpServer(testingBotApi, config);
    await expect(server.preflight()).rejects.toThrow(/Node\.js 18\+ required/);
    expect(testingBotApi.getUserInfo).not.toHaveBeenCalled();
  });

  it("rejects when api_key is missing", async () => {
    setNodeVersion("20.10.0");
    const server = new AutomationMcpServer(testingBotApi, {
      "testingbot-key": "",
      "testingbot-secret": "s",
    });
    await expect(server.preflight()).rejects.toThrow(/Missing TestingBot credentials/);
    expect(testingBotApi.getUserInfo).not.toHaveBeenCalled();
  });

  it("rejects when api_secret is missing", async () => {
    setNodeVersion("20.10.0");
    const server = new AutomationMcpServer(testingBotApi, {
      "testingbot-key": "k",
      "testingbot-secret": "",
    });
    await expect(server.preflight()).rejects.toThrow(/Missing TestingBot credentials/);
  });

  it("wraps credential-check failures with a clear message", async () => {
    setNodeVersion("20.10.0");
    testingBotApi.getUserInfo.mockRejectedValue(new Error("401 Unauthorized"));
    const server = new AutomationMcpServer(testingBotApi, config);
    await expect(server.preflight()).rejects.toThrow(/credential check failed.*401 Unauthorized/);
  });

  it("constructs without registering any tools — registration is deferred to run()", () => {
    // The constructor only wires up the MCP request handlers; both local and
    // proxied tools are registered during run(), so the tools map is empty
    // until then.
    const server = new AutomationMcpServer(testingBotApi, config);
    expect(Object.keys(server.tools)).toEqual([]);
  });

  it("close() runs without throwing even when no sessions exist", async () => {
    const server = new AutomationMcpServer(testingBotApi, config);
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("run() spawns the proxy and registers proxied appium tools alongside local ones", async () => {
    setNodeVersion("20.10.0");
    const server = new AutomationMcpServer(testingBotApi, config, {
      appiumSpawn: fakeSpawn(["appium_session_management", "appium_gesture"]),
    });
    // Intercept the stdio transport.connect so run() doesn't actually try to talk over stdio.
    (server as any).server.connect = vi.fn().mockResolvedValue(undefined);
    await server.run();
    expect(Object.keys(server.tools)).toEqual(
      expect.arrayContaining(["tb_openBrowser", "appium_session_management", "appium_gesture"])
    );
  });
});
