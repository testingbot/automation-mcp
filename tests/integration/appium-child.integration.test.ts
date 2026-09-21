import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  addAppiumProxyTools,
  HIDDEN_TOOLS,
  type AppiumProxyHandle,
} from "../../src/tools/appium-proxy.js";

/**
 * Spawns the REAL appium-mcp child and inspects the tool surface it advertises.
 *
 * Every other appium-proxy test stubs the child, so nothing verifies that the
 * package still spawns, still speaks MCP, or still exposes the tool names our
 * HIDDEN_TOOLS / steering / schema-rewrite logic is written against — an
 * upstream rename would pass CI and break mobile silently.
 *
 * Costs nothing: no session is created, so no TestingBot minutes are used. It
 * lives in tests/integration only because spawning a heavy child process with
 * native deps is too slow and environment-dependent for the unit run.
 */
const SHOULD_RUN = process.env.RUN_INTEGRATION_TESTS === "true";
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

describeOrSkip("appium-mcp child process", () => {
  let handle: AppiumProxyHandle | null = null;
  let registered: string[] = [];

  const serverShim = {
    tool: (name: string, desc: string, schema: any, handler: any) => ({
      name,
      desc,
      schema,
      handler,
    }),
  };

  beforeAll(async () => {
    // Dummy credentials: enough to build the injected hub URL. No session is
    // opened, so these are never authenticated against anything.
    handle = await addAppiumProxyTools(serverShim, {
      "testingbot-key": "integration-dummy-key",
      "testingbot-secret": "integration-dummy-secret",
    });
    registered = Object.keys(handle.tools);
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.shutdown();
  });

  it("spawns and advertises a non-empty tool list", () => {
    expect(registered.length).toBeGreaterThan(0);
  });

  it("still exposes appium_session_management — the tool our steering targets", () => {
    expect(registered).toContain("appium_session_management");
  });

  it("hides every local-device tool", () => {
    for (const hidden of HIDDEN_TOOLS) {
      expect(registered, `${hidden} should not be published`).not.toContain(hidden);
    }
  });

  it("publishes no schema that would let the agent choose a remote server", () => {
    for (const name of registered) {
      const schema = (handle!.tools as Record<string, any>)[name]?.inputSchema;
      const props = schema?.properties ?? {};
      expect(Object.keys(props), `${name} exposes remoteServerUrl`).not.toContain(
        "remoteServerUrl"
      );
    }
  });

  it("steers session_management toward tb_openBrowser for browser work", () => {
    const tool = (handle!.tools as Record<string, any>).appium_session_management;
    expect(tool.desc ?? tool.description).toContain("tb_openBrowser");
  });

  it("shuts the child down cleanly", async () => {
    await handle!.shutdown();
    handle = null;
  });
});

describe("appium child integration suite is gated", () => {
  it("opts in via RUN_INTEGRATION_TESTS", () => {
    expect(typeof SHOULD_RUN).toBe("boolean");
  });
});
