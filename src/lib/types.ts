export interface TestingBotConfig {
  "testingbot-key": string;
  "testingbot-secret": string;
}

/** Request options forwarded to the MCP SDK's `callTool`. */
export interface ProxyCallOptions {
  /** Per-request timeout in ms. Overrides the SDK's 60s default. */
  timeout?: number;
  /** Restart the timeout clock whenever the child reports progress. */
  resetTimeoutOnProgress?: boolean;
  /** Absolute ceiling, even with progress notifications resetting the clock. */
  maxTotalTimeout?: number;
}

export interface ProxyClientLike {
  listTools(): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: ProxyCallOptions
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface AutomationOptions {
  /** How long a session may sit idle before the reaper closes it. Default 4 min. */
  idleTimeoutMs?: number;
  /** Hard cap on concurrent active sessions. Default 5. */
  maxSessions?: number;
  /** Interval between idle-reaper sweeps. Default 30s. */
  reaperIntervalMs?: number;
  /**
   * Override how the appium-mcp child is started. For tests, or for embedding
   * scenarios where the child should be supplied externally. Defaults to
   * spawning the bundled `appium-mcp` package over stdio.
   */
  appiumSpawn?: (env: Record<string, string>) => Promise<{
    client: ProxyClientLike;
    close: () => Promise<void>;
  }>;
}
