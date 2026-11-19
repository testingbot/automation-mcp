import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockNewSession } = vi.hoisted(() => ({
  mockNewSession: vi.fn(),
}));

vi.mock("webdriver", () => ({
  default: { newSession: mockNewSession },
}));

import { AutomationMcpServer } from "../src/server-factory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
    await expect(server.preflight()).rejects.toThrow(/Node\.js 20\+ required/);
    expect(testingBotApi.getUserInfo).not.toHaveBeenCalled();
  });

  it("enforces the same Node floor that package.json declares", async () => {
    // The runtime gate and engines.node must not drift apart.
    setNodeVersion("18.20.0");
    const server = new AutomationMcpServer(testingBotApi, config);
    await expect(server.preflight()).rejects.toThrow(/Node\.js 20\+ required/);
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

  async function startedServer() {
    setNodeVersion("20.10.0");
    const server = new AutomationMcpServer(testingBotApi, config, {
      appiumSpawn: fakeSpawn(["appium_gesture"]),
    });
    (server as any).server.connect = vi.fn().mockResolvedValue(undefined);
    await server.run();
    const handlers = (server as any).server._requestHandlers;
    const call = (method: string, params: any) =>
      handlers.get(method)({ method, params }, { signal: new AbortController().signal });
    return { server, call };
  }

  it("tools/list publishes JSON Schema, not Zod internals", async () => {
    const { server, call } = await startedServer();
    const { tools } = await call(ListToolsRequestSchema.shape.method.value, {});
    const navigate = tools.find((t: any) => t.name === "tb_navigate");
    expect(navigate.inputSchema.properties.url).toMatchObject({ type: "string", format: "uri" });
    expect(navigate.inputSchema.required).toEqual(expect.arrayContaining(["sessionId", "url"]));
    expect(JSON.stringify(tools)).not.toContain('"def"');
    // Proxied tools keep the raw schema appium-mcp sent.
    expect(tools.find((t: any) => t.name === "appium_gesture").inputSchema).toEqual({
      type: "object",
    });
    await server.close();
  });

  it("tools/list annotates every tool", async () => {
    const { server, call } = await startedServer();
    const { tools } = await call(ListToolsRequestSchema.shape.method.value, {});
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      // Everything talks to TestingBot except listing this server's own sessions.
      expect(tool.annotations.openWorldHint, tool.name).toBe(tool.name !== "tb_listSessions");
    }
    const byName = Object.fromEntries(tools.map((t: any) => [t.name, t.annotations]));
    expect(byName.tb_snapshot).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.tb_closeBrowser).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.tb_click).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    await server.close();
  });

  it("tb_* descriptions say when to use the tool and what it returns", async () => {
    const { server, call } = await startedServer();
    const { tools } = await call(ListToolsRequestSchema.shape.method.value, {});
    for (const tool of tools.filter((t: any) => t.name.startsWith("tb_"))) {
      expect(tool.description.length, tool.name).toBeGreaterThan(200);
      if (tool.annotations.destructiveHint) {
        expect(tool.description, tool.name).toMatch(/end|close|change|delete|side effect/i);
      }
    }
    await server.close();
  });

  it("tools/call rejects missing arguments with a clear message", async () => {
    const { server, call } = await startedServer();
    const result = await call(CallToolRequestSchema.shape.method.value, {
      name: "tb_navigate",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Invalid arguments for tb_navigate: /);
    expect(result.content[0].text).toContain("sessionId");
    expect(result.content[0].text).toContain("url");
    await server.close();
  });
});
