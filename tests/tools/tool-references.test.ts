import { describe, it, expect, vi } from "vitest";
import addBrowseTools from "../../src/tools/browse.js";
import addSharedTools from "../../src/tools/shared.js";
import { SessionManager } from "../../src/session-manager.js";

/**
 * Tool descriptions are read by the agent and are the only map it has of what
 * exists. A description naming a tool that was never registered — as
 * `tb_appiumEndpoint` was — invites the agent to call something that isn't
 * there, and the failure looks like a server bug to the user.
 */
describe("agent-facing tool references", () => {
  const sessions = new SessionManager({ reaperIntervalMs: 0 });
  const serverMock = {
    tool: vi.fn((name, description, schema, handler) => ({
      name,
      description,
      schema,
      handler,
    })),
  };
  const testingBotApi = {
    options: { api_key: "k", api_secret: "s" },
    getAuthenticationHashForSharing: () => "hash",
  };

  const tools = {
    ...addBrowseTools(serverMock, testingBotApi, sessions),
    ...addSharedTools(serverMock, sessions),
  } as Record<string, { description: string }>;

  const registered = new Set(Object.keys(tools));

  it("registers the tools the rest of the suite assumes", () => {
    expect(registered.size).toBeGreaterThan(5);
    expect(registered.has("tb_openBrowser")).toBe(true);
  });

  it.each(Object.keys(tools))("%s describes only tools that exist", (name) => {
    const mentioned = tools[name].description.match(/\btb_[A-Za-z]+/g) ?? [];
    for (const ref of mentioned) {
      expect(registered.has(ref), `${name} references unregistered ${ref}`).toBe(true);
    }
  });

  it("points mobile session listing at the real appium tool", () => {
    // Mobile sessions live in the appium-mcp child, not our SessionManager.
    expect(tools.tb_listSessions.description).toContain("appium_session_management");
    expect(tools.tb_listSessions.description).not.toContain("tb_appiumEndpoint");
  });
});
