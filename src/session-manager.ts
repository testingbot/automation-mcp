import logger from "./lib/logger.js";

// This server manages browser sessions only. Mobile device sessions are
// delegated to https://github.com/appium/appium-mcp — see tb_appiumEndpoint.
export type SessionType = "browser";

// Shape of a Webdriver client (webdriver package). We duck-type here rather
// than importing the real type to keep this module's interface lightweight
// and to allow tests to substitute a plain object.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WebdriverClient = any;

interface BaseSession {
  /** TestingBot session ID. Used to look up logs/video/live-view after the fact. */
  id: string;
  /** Capabilities the session was opened with — surfaced to callers. */
  capabilities: Record<string, unknown>;
  /** URL the human watches to see the AI drive in real time. */
  liveViewUrl: string;
  createdAt: number;
  lastUsedAt: number;
  /** Releases the underlying remote resource. Set by the tool that opens the session. */
  dispose: () => Promise<void>;
}

export interface BrowserSession extends BaseSession {
  type: "browser";
  /** Webdriver client connected to TestingBot's hub at /wd/hub. */
  driver: WebdriverClient;
  /** Lower-cased browser name (chrome/firefox/safari/edge). */
  browserName: string;
}

export type Session = BrowserSession;

export interface SessionManagerOptions {
  /** Sessions idle longer than this are closed. Default 4 min (TestingBot kills at 5). */
  idleTimeoutMs?: number;
  /** Refuse to open new sessions once this many are active. Default 5. */
  maxSessions?: number;
  /** Interval between reaper sweeps. Default 30s. Pass 0 to disable. */
  reaperIntervalMs?: number;
}

const DEFAULTS = {
  idleTimeoutMs: 4 * 60 * 1000,
  maxSessions: 5,
  reaperIntervalMs: 30 * 1000,
};

export class SessionManager {
  private sessions = new Map<string, Session>();
  private reaperTimer: NodeJS.Timeout | null = null;
  private readonly opts: Required<SessionManagerOptions>;
  private shuttingDown = false;

  constructor(opts: SessionManagerOptions = {}) {
    this.opts = {
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      maxSessions: opts.maxSessions ?? DEFAULTS.maxSessions,
      reaperIntervalMs: opts.reaperIntervalMs ?? DEFAULTS.reaperIntervalMs,
    };
    if (this.opts.reaperIntervalMs > 0) {
      this.reaperTimer = setInterval(() => {
        void this.reapIdle().catch((err) => logger.error({ err }, "Idle reaper failed"));
      }, this.opts.reaperIntervalMs);
      this.reaperTimer.unref?.();
    }
  }

  /** Number of live sessions. */
  size(): number {
    return this.sessions.size;
  }

  list(): Array<
    Pick<Session, "id" | "type" | "capabilities" | "createdAt" | "lastUsedAt" | "liveViewUrl">
  > {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      type: s.type,
      capabilities: s.capabilities,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      liveViewUrl: s.liveViewUrl,
    }));
  }

  register(session: Omit<BrowserSession, "createdAt" | "lastUsedAt">): Session {
    if (this.shuttingDown) {
      throw new Error("SessionManager is shutting down");
    }
    if (this.sessions.size >= this.opts.maxSessions) {
      throw new Error(
        `Session cap reached (${this.opts.maxSessions}). Close an existing session before opening another.`
      );
    }
    const now = Date.now();
    const full = { ...session, createdAt: now, lastUsedAt: now } as Session;
    this.sessions.set(session.id, full);
    logger.info(
      { id: session.id, type: session.type, active: this.sessions.size },
      "Session registered"
    );
    return full;
  }

  /** Look up a session and refresh its last-used timestamp. Throws on miss. */
  touch(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) {
      throw new Error(
        `Unknown sessionId: ${id}. Call tb_openBrowser first or check tb_listSessions.`
      );
    }
    s.lastUsedAt = Date.now();
    return s;
  }

  /** Reserved for future polymorphic dispatch. Currently always returns a BrowserSession. */
  touchAs<T extends SessionType>(id: string, expected: T): BrowserSession {
    const s = this.touch(id);
    if (s.type !== expected) {
      throw new Error(
        `Session ${id} is a ${s.type} session; this tool requires a ${expected} session.`
      );
    }
    return s;
  }

  /** Read without touching last-used. Used by listSessions / reaper. */
  peek(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async close(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    try {
      await s.dispose();
      logger.info({ id, type: s.type, active: this.sessions.size }, "Session closed");
    } catch (err) {
      logger.warn({ id, err }, "Error while disposing session; removed from registry anyway");
    }
    return true;
  }

  async closeAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    const toClose: string[] = [];
    for (const [id, s] of this.sessions) {
      if (now - s.lastUsedAt > this.opts.idleTimeoutMs) toClose.push(id);
    }
    for (const id of toClose) {
      logger.info({ id }, "Reaping idle session");
      await this.close(id);
    }
  }
}
