import { describe, it, expect, vi, beforeEach } from "vitest";
import addAppiumProxyTools, {
  buildRemoteServerUrl,
  applyAgentSteering,
  applySchemaRewrite,
  HIDDEN_TOOLS,
} from "../../src/tools/appium-proxy.js";
import type { ProxyClientLike } from "../../src/lib/types.js";

function makeFakeChild(): {
  client: ProxyClientLike;
  closed: { value: boolean };
  listToolsCalls: { value: number };
  callToolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>;
} {
  const closed = { value: false };
  const callToolCalls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const listToolsCalls = { value: 0 };
  const client: ProxyClientLike = {
    async listTools() {
      listToolsCalls.value++;
      return {
        tools: [
          {
            name: "appium_session_management",
            description: "Create or close an Appium session",
            inputSchema: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["create", "attach", "delete"] },
                remoteServerUrl: { type: "string" },
                capabilities: { type: "object" },
              },
              required: ["action"],
            },
          },
          {
            name: "appium_screenshot",
            description: "Take a screenshot",
            inputSchema: { type: "object", properties: { sessionId: { type: "string" } } },
          },
        ],
      };
    },
    async callTool(params) {
      callToolCalls.push(params);
      return { content: [{ type: "text", text: `OK ${params.name}` }] };
    },
    async close() {
      closed.value = true;
    },
  };
  return { client, closed, listToolsCalls, callToolCalls };
}

describe("addAppiumProxyTools", () => {
  let serverMock: { tool: ReturnType<typeof vi.fn> };
  const config = { "testingbot-key": "my-key", "testingbot-secret": "my-secret" };

  beforeEach(() => {
    vi.clearAllMocks();
    serverMock = {
      tool: vi.fn((name, desc, schema, handler) => ({ name, description: desc, schema, handler })),
    };
  });

  it("registers a passthrough tool for every tool the child advertises", async () => {
    const fake = makeFakeChild();
    const handle = await addAppiumProxyTools(serverMock, config, {
      spawn: async () => ({ client: fake.client, close: fake.client.close.bind(fake.client) }),
    });

    expect(Object.keys(handle.tools).sort()).toEqual([
      "appium_screenshot",
      "appium_session_management",
    ]);
    expect(serverMock.tool).toHaveBeenCalledTimes(2);
    expect(fake.listToolsCalls.value).toBe(1);
  });

  it("rewrites appium_session_management's schema to a TestingBot-clean shape", async () => {
    const fake = makeFakeChild();
    const handle = await addAppiumProxyTools(serverMock, config, {
      spawn: async () => ({ client: fake.client, close: fake.client.close.bind(fake.client) }),
    });
    const t = (handle.tools as any).appium_session_management;
    // remoteServerUrl MUST NOT be in the schema — the whole point of bundling
    // is the agent never has to think about credentials or hub URLs.
    expect(t.inputSchema.properties.remoteServerUrl).toBeUndefined();
    // 'attach' is dropped (it requires a user-supplied remoteServerUrl which
    // we don't expose). The remaining actions cover every real use case.
    expect(t.inputSchema.properties.action.enum).toEqual([
      "create",
      "delete",
      "list",
      "detach",
      "select",
    ]);
    expect(t.inputSchema.properties.platform.enum).toEqual(["ios", "android"]);
    expect(t.inputSchema.required).toEqual(["action"]);
  });

  it("force-injects the credentialed URL on create and overrides any agent value", async () => {
    const fake = makeFakeChild();
    const handle = await addAppiumProxyTools(serverMock, config, {
      spawn: async () => ({ client: fake.client, close: fake.client.close.bind(fake.client) }),
    });
    // Even if the agent somehow smuggles a remoteServerUrl past the schema,
    // we replace it. Credentials are not the agent's to choose.
    await (handle.tools as any).appium_session_management.handler({
      action: "create",
      capabilities: { platformName: "iOS" },
      remoteServerUrl: "https://attacker:hacked@evil.example.com/wd/hub",
    });
    expect(fake.callToolCalls).toHaveLength(1);
    expect(fake.callToolCalls[0].arguments?.remoteServerUrl).toBe(
      "https://my-key:my-secret@hub.testingbot.com/wd/hub"
    );
  });

  it("injects the credentialed URL on create when nothing is supplied", async () => {
    const fake = makeFakeChild();
    const handle = await addAppiumProxyTools(serverMock, config, {
      spawn: async () => ({ client: fake.client, close: fake.client.close.bind(fake.client) }),
    });
    await (handle.tools as any).appium_session_management.handler({
      action: "create",
      capabilities: { platformName: "iOS" },
    });
    expect(fake.callToolCalls[0].arguments?.remoteServerUrl).toBe(
      "https://my-key:my-secret@hub.testingbot.com/wd/hub"
    );
  });

  it("does not inject the URL on delete actions (no session to create)", async () => {
    const fake = makeFakeChild();
    const handle = await addAppiumProxyTools(serverMock, config, {
      spawn: async () => ({ client: fake.client, close: fake.client.close.bind(fake.client) }),
    });
    await (handle.tools as any).appium_session_management.handler({
      action: "delete",
      sessionId: "abc",
    });
    expect(fake.callToolCalls[0].arguments).toEqual({ action: "delete", sessionId: "abc" });
  });

  it("does not inject the URL on non-session tools", async () => {
    const fake = makeFakeChild();
    const handle = await addAppiumProxyTools(serverMock, config, {
      spawn: async () => ({ client: fake.client, close: fake.client.close.bind(fake.client) }),
    });
    await (handle.tools as any).appium_screenshot.handler({ sessionId: "abc" });
    expect(fake.callToolCalls[0].arguments).toEqual({ sessionId: "abc" });
  });

  it("passes the child's result back untouched on success", async () => {
    const fake = makeFakeChild();
    const handle = await addAppiumProxyTools(serverMock, config, {
      spawn: async () => ({ client: fake.client, close: fake.client.close.bind(fake.client) }),
    });
    const result = await (handle.tools as any).appium_screenshot.handler({ sessionId: "abc" });
    expect(result).toEqual({ content: [{ type: "text", text: "OK appium_screenshot" }] });
  });

  it("wraps callTool errors via handleMCPError so the agent gets a clean message", async () => {
    const fake = makeFakeChild();
    fake.client.callTool = vi.fn().mockRejectedValue(new Error("boom"));
    const handle = await addAppiumProxyTools(serverMock, config, {
      spawn: async () => ({ client: fake.client, close: fake.client.close.bind(fake.client) }),
    });
    const result = await (handle.tools as any).appium_screenshot.handler({ sessionId: "abc" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("boom");
  });

  it("propagates the strict ALLOW_REGEX into the child's env", async () => {
    let receivedEnv: Record<string, string> | undefined;
    const fake = makeFakeChild();
    await addAppiumProxyTools(serverMock, config, {
      spawn: async (env) => {
        receivedEnv = env;
        return { client: fake.client, close: fake.client.close.bind(fake.client) };
      },
    });
    expect(receivedEnv?.REMOTE_SERVER_URL_ALLOW_REGEX).toBe(
      "^https://[^@]+@hub\\.testingbot\\.com/wd/hub$"
    );
  });

  it("strips TestingBot credentials from the child's inherited env", async () => {
    process.env.TESTINGBOT_KEY = "leaky-key";
    process.env.TESTINGBOT_SECRET = "leaky-secret";
    process.env.TB_KEY = "leaky-tb-key";
    process.env.TB_SECRET = "leaky-tb-secret";
    let receivedEnv: Record<string, string> | undefined;
    const fake = makeFakeChild();
    try {
      await addAppiumProxyTools(serverMock, config, {
        spawn: async (env) => {
          receivedEnv = env;
          return { client: fake.client, close: fake.client.close.bind(fake.client) };
        },
      });
    } finally {
      delete process.env.TESTINGBOT_KEY;
      delete process.env.TESTINGBOT_SECRET;
      delete process.env.TB_KEY;
      delete process.env.TB_SECRET;
    }
    expect(receivedEnv?.TESTINGBOT_KEY).toBeUndefined();
    expect(receivedEnv?.TESTINGBOT_SECRET).toBeUndefined();
    expect(receivedEnv?.TB_KEY).toBeUndefined();
    expect(receivedEnv?.TB_SECRET).toBeUndefined();
  });

  it("shutdown() closes the child", async () => {
    const fake = makeFakeChild();
    const handle = await addAppiumProxyTools(serverMock, config, {
      spawn: async () => ({ client: fake.client, close: fake.client.close.bind(fake.client) }),
    });
    await handle.shutdown();
    expect(fake.closed.value).toBe(true);
  });

  it("rejects when credentials are missing", async () => {
    const fake = makeFakeChild();
    await expect(
      addAppiumProxyTools(
        serverMock,
        { "testingbot-key": "", "testingbot-secret": "" },
        {
          spawn: async () => ({ client: fake.client, close: fake.client.close.bind(fake.client) }),
        }
      )
    ).rejects.toThrow(/Missing TestingBot credentials/);
  });

  it("buildRemoteServerUrl percent-encodes reserved characters in credentials", () => {
    expect(
      buildRemoteServerUrl({ "testingbot-key": "user@name", "testingbot-secret": "p/a:s" })
    ).toBe("https://user%40name:p%2Fa%3As@hub.testingbot.com/wd/hub");
  });

  it("replaces appium_session_management's description with a TestingBot-clean one", async () => {
    const fake = makeFakeChild();
    const handle = await addAppiumProxyTools(serverMock, config, {
      spawn: async () => ({ client: fake.client, close: fake.client.close.bind(fake.client) }),
    });
    const desc = (handle.tools as any).appium_session_management.description as string;
    expect(desc).toContain("tb_openBrowser instead");
    expect(desc).toContain("NATIVE apps");
    expect(desc).toContain("injected for you");
    // The upstream description's misleading "embedded driver / DEFAULT MODE
    // (no remoteServerUrl)" must NOT survive — we replace, not prepend.
    expect(desc).not.toContain("Create or close an Appium session");
    expect(desc).not.toContain("DEFAULT MODE");
    expect(desc).not.toContain("embedded");
  });

  it("leaves non-session tools' descriptions untouched", async () => {
    const fake = makeFakeChild();
    const handle = await addAppiumProxyTools(serverMock, config, {
      spawn: async () => ({ client: fake.client, close: fake.client.close.bind(fake.client) }),
    });
    const desc = (handle.tools as any).appium_screenshot.description as string;
    expect(desc).not.toContain("tb_openBrowser");
    expect(desc).toBe("Take a screenshot");
  });

  it("applyAgentSteering is a no-op for unknown tool names", () => {
    expect(applyAgentSteering("appium_gesture", "Tap, swipe, etc.")).toBe("Tap, swipe, etc.");
  });

  it("applySchemaRewrite is a no-op for tools other than session_management", () => {
    const schema = { type: "object", properties: { x: { type: "number" } } };
    expect(applySchemaRewrite("appium_screenshot", schema)).toBe(schema);
  });

  it("hides local-only upstream tools that don't apply to TestingBot", async () => {
    const closed = { value: false };
    const localOnlyClient: ProxyClientLike = {
      async listTools() {
        return {
          tools: [
            { name: "select_device", description: "List local devices", inputSchema: {} },
            { name: "prepare_ios_simulator", description: "Boot local sim", inputSchema: {} },
            {
              name: "appium_prepare_ios_real_device",
              description: "USB-tethered iOS prep",
              inputSchema: {},
            },
            { name: "appium_screenshot", description: "Screenshot", inputSchema: {} },
          ],
        };
      },
      async callTool() {
        return { content: [{ type: "text", text: "ok" }] };
      },
      async close() {
        closed.value = true;
      },
    };
    const handle = await addAppiumProxyTools(serverMock, config, {
      spawn: async () => ({ client: localOnlyClient, close: async () => localOnlyClient.close() }),
    });
    const names = Object.keys(handle.tools);
    expect(names).toEqual(["appium_screenshot"]);
    expect(names).not.toContain("select_device");
    expect(names).not.toContain("prepare_ios_simulator");
    expect(names).not.toContain("appium_prepare_ios_real_device");
  });

  it("exposes HIDDEN_TOOLS for callers to introspect", () => {
    expect(HIDDEN_TOOLS.has("select_device")).toBe(true);
    expect(HIDDEN_TOOLS.has("prepare_ios_simulator")).toBe(true);
    expect(HIDDEN_TOOLS.has("appium_prepare_ios_real_device")).toBe(true);
    expect(HIDDEN_TOOLS.has("appium_screenshot")).toBe(false);
  });
});
