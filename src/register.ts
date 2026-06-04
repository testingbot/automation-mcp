/**
 * Library entry. Lets other MCP servers (e.g. @testingbot/mcp-server) compose
 * these tools into a single server instance without spawning a child process.
 *
 * Usage:
 *   import { addAutomationTools } from "@testingbot/automation-mcp";
 *   const handle = await addAutomationTools(server, testingBotApi, config);
 *   // call handle.shutdown() during shutdown to close any live sessions
 *
 * Note: this entry is async because it spawns and connects an `appium-mcp`
 * child process whose tool list is discovered at runtime. The host MUST await
 * the returned handle before serving its first tools/list response, otherwise
 * the mobile tool surface won't be visible to the client.
 */
import addBrowseTools from "./tools/browse.js";
import addSharedTools from "./tools/shared.js";
import addAppiumProxyTools, { type AppiumProxyHandle } from "./tools/appium-proxy.js";
import { SessionManager, type SessionManagerOptions } from "./session-manager.js";
import type { TestingBotConfig, AutomationOptions } from "./lib/types.js";
import logger from "./lib/logger.js";

export type { AutomationOptions, TestingBotConfig };
export { SessionManager };

export interface AutomationHandle {
  /** Map of registered tools, keyed by tool name. */
  tools: Record<string, unknown>;
  /** Owning SessionManager — exposed for advanced lifecycle integration. */
  sessions: SessionManager;
  /** Close all live sessions, the appium-mcp child, and stop the idle reaper. Call on server shutdown. */
  shutdown(): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolServer = { tool: (name: string, desc: string, schema: any, handler: any) => unknown };

/**
 * Register the automation tool family on a host MCP server.
 *
 * @param server      A server object exposing `.tool(name, desc, schema, handler)` — the same
 *                    duck-type used elsewhere in this repo and in @testingbot/mcp-server.
 * @param testingBotApi  An initialized `testingbot-api` client.
 * @param config      TestingBot credentials. Forwarded to the appium-mcp child to build the
 *                    credentialed hub URL injected into session-create calls.
 * @param options     Idle timeout / session cap / reaper interval / appium-mcp spawn overrides.
 */
export async function addAutomationTools(
  server: ToolServer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  testingBotApi: any,
  config: TestingBotConfig,
  options: AutomationOptions = {}
): Promise<AutomationHandle> {
  const sessions = new SessionManager(asSessionManagerOptions(options));

  // Browser/shared tools are synchronous — they register immediately.
  const localTools = {
    ...addBrowseTools(server, testingBotApi, sessions),
    ...addSharedTools(server, sessions),
  };

  // appium-mcp child + proxied tools. If spawn fails (e.g. appium-mcp not
  // installed in a slim deployment), we register a single fallback tool that
  // tells the agent what's wrong, so the rest of the server still works.
  let appium: AppiumProxyHandle | null = null;
  let appiumTools: Record<string, unknown> = {};
  try {
    appium = await addAppiumProxyTools(server, config, { spawn: options.appiumSpawn });
    appiumTools = appium.tools;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to start appium-mcp child; mobile tools will be unavailable"
    );
  }

  const tools = { ...localTools, ...appiumTools };

  logger.info(
    {
      toolCount: Object.keys(tools).length,
      mobile: appium ? Object.keys(appiumTools).length : "unavailable",
      idleTimeoutMs: options.idleTimeoutMs,
      maxSessions: options.maxSessions,
    },
    "Automation tools registered"
  );

  return {
    tools,
    sessions,
    async shutdown() {
      await sessions.closeAll();
      if (appium) await appium.shutdown();
    },
  };
}

function asSessionManagerOptions(o: AutomationOptions): SessionManagerOptions {
  return {
    idleTimeoutMs: o.idleTimeoutMs,
    maxSessions: o.maxSessions,
    reaperIntervalMs: o.reaperIntervalMs,
  };
}

export default addAutomationTools;
