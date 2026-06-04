/**
 * Spawns the bundled `appium-mcp` package as a stdio child, then proxies its
 * full tool surface onto our parent MCP server. The agent sees `appium_*`
 * tools as if they were ours; behind the scenes every call is forwarded over
 * MCP to the child.
 *
 * Why bundle instead of asking the user to install appium-mcp separately:
 *   - Single MCP install for both browsers and mobile.
 *   - We pre-inject `REMOTE_SERVER_URL_ALLOW_REGEX` and the credentialed
 *     TestingBot hub URL so the agent never has to think about either.
 *   - Upstream upgrades flow in via a dep bump.
 *
 * Trade-off: appium-mcp pulls in ~21 MB of native drivers (XCUITest,
 * UiAutomator2) and ML deps (langchain, transformers). Cost is paid once at
 * install time.
 */
import { createRequire } from "module";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import logger from "../lib/logger.js";
import { handleMCPError } from "../lib/utils.js";
import type { TestingBotConfig, ProxyClientLike } from "../lib/types.js";

const require = createRequire(import.meta.url);

const HUB_HOST = "hub.testingbot.com";
const HUB_PATH = "/wd/hub";
// Strict regex: only the TestingBot hub with embedded creds is allowed. Even
// if the agent supplies its own remoteServerUrl, the child will reject any
// URL pointing elsewhere.
const ALLOW_REGEX = "^https://[^@]+@hub\\.testingbot\\.com/wd/hub$";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolServer = { tool: (name: string, desc: string, schema: any, handler: any) => any };

export interface AppiumProxyHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;
  shutdown(): Promise<void>;
}

export interface AppiumProxyOptions {
  /** Override for tests — return a connected MCP Client. */
  spawn?: (env: Record<string, string>) => Promise<{
    client: ProxyClientLike;
    close: () => Promise<void>;
  }>;
}

export function buildRemoteServerUrl(config: TestingBotConfig): string {
  const key = config["testingbot-key"];
  const secret = config["testingbot-secret"];
  if (!key || !secret) {
    throw new Error(
      "Missing TestingBot credentials; cannot bridge to appium-mcp. Set TESTINGBOT_KEY and TESTINGBOT_SECRET."
    );
  }
  // Defensive percent-encoding: TestingBot keys are normally URL-safe but a
  // paranoid encode here is free.
  const u = encodeURIComponent(key);
  const s = encodeURIComponent(secret);
  return `https://${u}:${s}@${HUB_HOST}${HUB_PATH}`;
}

/** Locate the appium-mcp entry without depending on $PATH or shell resolution. */
export function resolveAppiumMcpEntry(): string {
  // appium-mcp's exports map exposes "." only via the `import` condition
  // (ESM), so require.resolve("appium-mcp") fails under CJS-style resolution.
  // The package.json IS exposed for any condition, so we resolve that and
  // derive the dist path from it.
  const pkgJsonPath = require.resolve("appium-mcp/package.json");
  return path.join(path.dirname(pkgJsonPath), "dist", "index.js");
}

async function defaultSpawn(
  env: Record<string, string>
): Promise<{ client: ProxyClientLike; close: () => Promise<void> }> {
  const appiumEntry = resolveAppiumMcpEntry();

  const transport = new StdioClientTransport({
    command: process.execPath, // current node binary
    args: [appiumEntry],
    env,
    stderr: "pipe", // capture, don't interleave with ours
  });

  const client = new Client(
    { name: "@testingbot/automation-mcp", version: "0.1.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  return {
    client: client as unknown as ProxyClientLike,
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Tools the upstream appium-mcp exposes that don't make sense when we're
 * bundled inside the TestingBot MCP. select_device discovers devices via
 * local ADB/libimobiledevice; prepare_ios_simulator and
 * appium_prepare_ios_real_device prep a USB-tethered iOS device. None of
 * these apply to TestingBot's cloud hub — and exposing them confuses the
 * agent into "this is a local server" mode (per the upstream description).
 */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "select_device",
  "prepare_ios_simulator",
  "appium_prepare_ios_real_device",
]);

/**
 * Replace the upstream tool description with a TestingBot-aware one. The
 * upstream copy walks the agent through "DEFAULT MODE (no remoteServerUrl)
 * — embedded drivers" and "REMOTE SERVER MODE (only when user provides URL)"
 * — both of which are wrong here. The TestingBot hub URL + credentials are
 * always injected server-side; the agent must not think about them.
 */
export function applyAgentSteering(name: string, upstreamDescription: string): string {
  if (name === "appium_session_management") {
    return (
      "Manage TestingBot mobile-device sessions. " +
      "**For mobile-browser tasks (Chrome on Android, Safari on iOS), use tb_openBrowser instead** — it's chromedriver-backed WebDriver with clean navigate/snapshot/screenshot. " +
      "Reserve this tool for testing NATIVE apps (.apk/.ipa). " +
      'Open a session with `action: "create"`, supplying `platform` (`ios` or `android`) and `capabilities` (a JSON string with appium:deviceName, appium:platformVersion, appium:app etc.). ' +
      "**The TestingBot hub URL and credentials are injected for you — do not supply remoteServerUrl, it is not a parameter of this tool.** " +
      'Close with `action: "delete"` when done; sessions burn TestingBot minutes.'
    );
  }
  return upstreamDescription;
}

/**
 * Rewrite the upstream JSON Schema for tools where the upstream parameter
 * surface would mislead the agent. For appium_session_management, drop the
 * remoteServerUrl property entirely (so the agent literally cannot pass a
 * URL), drop the `attach` action (which only makes sense with a user-supplied
 * remote URL), and rewrite the verbose `action` description.
 */
export function applySchemaRewrite(name: string, upstreamSchema: unknown): unknown {
  if (name !== "appium_session_management") return upstreamSchema;
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "delete", "list", "detach", "select"],
        description:
          "create: open a new TestingBot device session (provide platform + capabilities). delete: close a session (uses sessionId, or the active one). list: enumerate active sessions managed here. detach: release ownership without closing the remote session. select: set an existing session as active (requires sessionId).",
      },
      platform: {
        type: "string",
        enum: ["ios", "android"],
        description:
          "Required for create. 'ios' for iPhone/iPad apps, 'android' for Pixel/Galaxy/etc. apps.",
      },
      capabilities: {
        type: "string",
        description:
          "JSON string of W3C/Appium capabilities for create. Common keys: appium:deviceName (e.g. 'iPhone 15 Pro', 'Google Pixel 8'), appium:platformVersion (e.g. '17', '14'), appium:app (e.g. 'tb://<id>' for an app uploaded via uploadFile). Do NOT include remoteServerUrl or credentials.",
      },
      sessionId: {
        type: "string",
        description:
          "For delete/detach/select: which session to act on. For delete and detach, optional — defaults to the active session.",
      },
    },
    required: ["action"],
    $schema: "http://json-schema.org/draft-07/schema#",
  };
}

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  // Don't leak our credentials to the child — it doesn't need them. They're
  // already baked into the URL we'll pass at call time.
  for (const k of ["TESTINGBOT_KEY", "TESTINGBOT_SECRET", "TB_KEY", "TB_SECRET"]) {
    delete out[k];
  }
  return out;
}

/**
 * Register every tool the appium-mcp child exposes onto our parent server as
 * a passthrough. Injects the credentialed `remoteServerUrl` into session
 * lifecycle calls so the agent doesn't have to.
 */
export async function addAppiumProxyTools(
  server: ToolServer,
  config: TestingBotConfig,
  options: AppiumProxyOptions = {}
): Promise<AppiumProxyHandle> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};
  const remoteServerUrl = buildRemoteServerUrl(config);

  const env: Record<string, string> = {
    ...filterEnv(process.env),
    REMOTE_SERVER_URL_ALLOW_REGEX: ALLOW_REGEX,
  };

  const spawnFn = options.spawn ?? defaultSpawn;
  const { client, close } = await spawnFn(env);

  let toolList: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  try {
    const result = await client.listTools();
    toolList = result.tools;
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }

  logger.info({ count: toolList.length }, "appium-mcp tools discovered");

  for (const t of toolList) {
    const name = t.name;
    if (HIDDEN_TOOLS.has(name)) {
      logger.info({ tool: name }, "Hiding upstream tool (local-only, n/a for TestingBot)");
      continue;
    }
    const inputSchema = applySchemaRewrite(name, t.inputSchema ?? { type: "object" });
    const description = applyAgentSteering(name, t.description ?? "");

    const handler = async (args: Record<string, unknown> = {}) => {
      try {
        const injected = { ...args };
        // Force-inject the credentialed TestingBot hub URL on every session
        // create. We deliberately stripped remoteServerUrl from the published
        // schema so the agent can't supply one — this overwrite is defense
        // in depth in case it somehow does. The agent never sees credentials
        // and never has to think about them.
        if (name === "appium_session_management") {
          const action = injected.action ?? "create";
          if (action === "create") {
            injected.remoteServerUrl = remoteServerUrl;
          }
        }
        return await client.callTool({ name, arguments: injected });
      } catch (error) {
        return handleMCPError(name, error);
      }
    };

    const registered = server.tool(name, description, {}, handler);
    // Bypass the host's Zod-based schema serialization: stash the raw JSON
    // Schema on the tool object so the ListTools handler can pick it up
    // verbatim. server-factory honors `inputSchema` when present.
    registered.inputSchema = inputSchema;
    tools[name] = registered;
  }

  return {
    tools,
    async shutdown() {
      try {
        await close();
        logger.info("appium-mcp child closed");
      } catch (e) {
        logger.warn({ error: String(e) }, "Error closing appium-mcp child");
      }
    },
  };
}

export default addAppiumProxyTools;
