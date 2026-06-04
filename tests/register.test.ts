import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProxyClientLike } from "../src/lib/types.js";

// Stub webdriver before importing the module under test — browse.ts pulls it
// in at top level.
const { mockNewSession } = vi.hoisted(() => ({ mockNewSession: vi.fn() }));

vi.mock("webdriver", () => ({
  default: { newSession: mockNewSession },
}));

import { addAutomationTools } from "../src/register.js";

function fakeAppiumChild(toolNames: string[]): {
  spawn: () => Promise<{ client: ProxyClientLike; close: () => Promise<void> }>;
  closed: { value: boolean };
} {
  const closed = { value: false };
  const client: ProxyClientLike = {
    async listTools() {
      return {
        tools: toolNames.map((name) => ({
          name,
          description: `${name} desc`,
          inputSchema: { type: "object" },
        })),
      };
    },
    async callTool() {
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {
      closed.value = true;
    },
  };
  return {
    spawn: async () => ({ client, close: async () => client.close() }),
    closed,
  };
}

describe("register.addAutomationTools", () => {
  let serverMock: { tool: ReturnType<typeof vi.fn> };
  let testingBotApi: any;
  const config = { "testingbot-key": "k", "testingbot-secret": "s" };

  beforeEach(() => {
    vi.clearAllMocks();
    serverMock = {
      tool: vi.fn((name, desc, schema, handler) => ({
        name,
        description: desc,
        schema,
        handler,
      })),
    };
    testingBotApi = {
      createSession: vi.fn(),
      getAuthenticationHashForSharing: vi.fn().mockReturnValue("hash"),
    };
  });

  it("registers local browser tools plus every appium-mcp tool from the child", async () => {
    const child = fakeAppiumChild([
      "appium_session_management",
      "appium_screenshot",
      "appium_gesture",
    ]);
    const handle = await addAutomationTools(serverMock, testingBotApi, config, {
      appiumSpawn: child.spawn,
    });

    const names = Object.keys(handle.tools).sort();
    expect(names).toEqual(
      [
        // browser family
        "tb_openBrowser",
        "tb_navigate",
        "tb_snapshot",
        "tb_click",
        "tb_type",
        "tb_getText",
        "tb_getAttribute",
        "tb_executeScript",
        "tb_closeBrowser",
        // shared (browser only)
        "tb_screenshot",
        "tb_pressKey",
        "tb_listSessions",
        // proxied from appium-mcp
        "appium_session_management",
        "appium_screenshot",
        "appium_gesture",
      ].sort()
    );
  });

  it("forwards AutomationOptions to the SessionManager", async () => {
    const child = fakeAppiumChild([]);
    const handle = await addAutomationTools(serverMock, testingBotApi, config, {
      maxSessions: 11,
      idleTimeoutMs: 12345,
      reaperIntervalMs: 0,
      appiumSpawn: child.spawn,
    });
    for (let i = 0; i < 11; i++) {
      handle.sessions.register({
        id: `s${i}`,
        type: "browser",
        driver: {} as any,
        browserName: "chrome",
        capabilities: {},
        liveViewUrl: "x",
        dispose: vi.fn().mockResolvedValue(undefined),
      });
    }
    expect(() =>
      handle.sessions.register({
        id: "overflow",
        type: "browser",
        driver: {} as any,
        browserName: "chrome",
        capabilities: {},
        liveViewUrl: "x",
        dispose: vi.fn().mockResolvedValue(undefined),
      })
    ).toThrow(/Session cap reached \(11\)/);
  });

  it("shutdown() closes all sessions AND the appium-mcp child", async () => {
    const child = fakeAppiumChild(["appium_screenshot"]);
    const handle = await addAutomationTools(serverMock, testingBotApi, config, {
      reaperIntervalMs: 0,
      appiumSpawn: child.spawn,
    });
    const disposeA = vi.fn().mockResolvedValue(undefined);
    const disposeB = vi.fn().mockResolvedValue(undefined);
    handle.sessions.register({
      id: "a",
      type: "browser",
      driver: {} as any,
      browserName: "chrome",
      capabilities: {},
      liveViewUrl: "x",
      dispose: disposeA,
    });
    handle.sessions.register({
      id: "b",
      type: "browser",
      driver: {} as any,
      browserName: "firefox",
      capabilities: {},
      liveViewUrl: "x",
      dispose: disposeB,
    });

    await handle.shutdown();

    expect(disposeA).toHaveBeenCalled();
    expect(disposeB).toHaveBeenCalled();
    expect(handle.sessions.size()).toBe(0);
    expect(child.closed.value).toBe(true);
    expect(() =>
      handle.sessions.register({
        id: "c",
        type: "browser",
        driver: {} as any,
        browserName: "chrome",
        capabilities: {},
        liveViewUrl: "x",
        dispose: vi.fn().mockResolvedValue(undefined),
      })
    ).toThrow(/shutting down/);
  });

  it("continues without mobile tools when the appium-mcp spawn fails", async () => {
    const handle = await addAutomationTools(serverMock, testingBotApi, config, {
      appiumSpawn: async () => {
        throw new Error("simulated spawn failure");
      },
    });
    // All local browser tools are still registered.
    expect(Object.keys(handle.tools)).toEqual(
      expect.arrayContaining(["tb_openBrowser", "tb_navigate", "tb_listSessions"])
    );
    // No appium_* tools because the child never came up.
    expect(Object.keys(handle.tools).filter((n) => n.startsWith("appium_"))).toEqual([]);
    // Shutdown is still safe.
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("invokes server.tool() once per registered tool", async () => {
    const child = fakeAppiumChild(["appium_a", "appium_b"]);
    const handle = await addAutomationTools(serverMock, testingBotApi, config, {
      appiumSpawn: child.spawn,
    });
    expect(serverMock.tool.mock.calls.length).toBe(Object.keys(handle.tools).length);
  });
});
