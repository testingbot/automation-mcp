export interface TestingBotConfig {
  "testingbot-key": string;
  "testingbot-secret": string;
}

export interface ProxyClientLike {
  listTools(): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
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
