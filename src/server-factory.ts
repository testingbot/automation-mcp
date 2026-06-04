import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
import logger from "./lib/logger.js";
import type { TestingBotConfig, AutomationOptions } from "./lib/types.js";
import { addAutomationTools, type AutomationHandle } from "./register.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

/**
 * Standalone MCP server hosting only the automation tools. Used when this
 * package is invoked via its `bin` entry. When composed as a library inside
 * @testingbot/mcp-server, `addAutomationTools` is imported directly instead.
 */
export class AutomationMcpServer {
  public server: McpServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public tools: Record<string, any> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private testingBotApi: any;
  private config: TestingBotConfig;
  private automation: AutomationHandle | null = null;
  private options: AutomationOptions;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(testingBotApi: any, config: TestingBotConfig, options: AutomationOptions = {}) {
    this.testingBotApi = testingBotApi;
    this.config = config;
    this.options = options;

    this.server = new McpServer(
      {
        name: packageJson.name || "@testingbot/automation-mcp",
        version: packageJson.version || "0.0.0",
      },
      { capabilities: { tools: {} } }
    );

    this.setupHandlers();
  }

  /**
   * Register every tool family. Async because the appium-mcp child must be
   * spawned and its tool list discovered before we can publish a complete
   * tools/list response to the MCP client.
   */
  private async registerTools() {
    this.automation = await addAutomationTools(this, this.testingBotApi, this.config, this.options);
    Object.assign(this.tools, this.automation.tools);
    logger.info(
      { toolCount: Object.keys(this.tools).length },
      "Standalone server: tools registered"
    );
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: Object.values(this.tools).map((t: any) => ({
        name: t.name,
        description: t.description,
        // Proxied appium-mcp tools stash a raw JSON Schema on the tool object.
        // Honor it when present; otherwise serialize the Zod-style schema dict.
        inputSchema: t.inputSchema ?? {
          type: "object",
          properties: t.schema,
          required: Object.keys(t.schema).filter(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (k) => !(t.schema as any)[k].isOptional?.()
          ),
        },
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const toolArgs = request.params.arguments || {};
      logger.info({ tool: toolName, args: toolArgs }, "Tool called");
      const tool = this.tools[toolName];
      if (!tool) throw new Error(`Tool not found: ${toolName}`);
      return tool.handler(toolArgs);
    });
  }

  // Duck-typed by addAutomationTools — same signature as @testingbot/mcp-server.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public tool(
    name: string,
    description: string,
    schema: any,
    handler: (args: any) => Promise<any>
  ) {
    return { name, description, schema, handler };
  }

  public async preflight(): Promise<void> {
    const required = 18;
    const major = Number(process.versions.node.split(".")[0]);
    if (!Number.isFinite(major) || major < required) {
      throw new Error(`Node.js ${required}+ required; running ${process.versions.node}.`);
    }
    if (!this.config["testingbot-key"] || !this.config["testingbot-secret"]) {
      throw new Error("Missing TestingBot credentials. Set TESTINGBOT_KEY and TESTINGBOT_SECRET.");
    }
    try {
      await this.testingBotApi.getUserInfo();
    } catch (error) {
      throw new Error(
        `TestingBot credential check failed: ${
          error instanceof Error ? error.message : String(error)
        }. Verify TESTINGBOT_KEY / TESTINGBOT_SECRET.`
      );
    }
  }

  public async run() {
    await this.preflight();
    await this.registerTools();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info("TestingBot Automation MCP Server running on stdio");
  }

  public async close() {
    try {
      if (this.automation) await this.automation.shutdown();
      await this.server.close();
    } catch (error) {
      logger.error({ error }, "Error during shutdown");
    }
  }
}
