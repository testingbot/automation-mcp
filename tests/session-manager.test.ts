import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager } from "../src/session-manager.js";

function makeFakeBrowser() {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

function makeFakeSession(id: string) {
  const browser = makeFakeBrowser();
  return {
    id,
    type: "browser" as const,
    browser: browser as any,
    page: {} as any,
    capabilities: { browserName: "chrome", platform: "WIN11" },
    liveViewUrl: `https://example.test/${id}`,
    dispose: () => browser.close(),
  };
}

describe("SessionManager", () => {
  let mgr: SessionManager;

  beforeEach(() => {
    // Disable the reaper interval for most tests so we drive it manually.
    mgr = new SessionManager({ reaperIntervalMs: 0, idleTimeoutMs: 50, maxSessions: 3 });
  });

  afterEach(async () => {
    await mgr.closeAll();
  });

  it("registers a session and reports it via list()", () => {
    mgr.register(makeFakeSession("abc"));
    expect(mgr.size()).toBe(1);
    expect(mgr.list()[0].id).toBe("abc");
    expect(mgr.list()[0].liveViewUrl).toBe("https://example.test/abc");
  });

  it("touch() returns the session and updates lastUsedAt", async () => {
    const fake = makeFakeSession("abc");
    mgr.register(fake);
    const first = mgr.peek("abc")!.lastUsedAt;
    await new Promise((r) => setTimeout(r, 5));
    const touched = mgr.touch("abc");
    expect(touched.id).toBe("abc");
    expect(touched.lastUsedAt).toBeGreaterThan(first);
  });

  it("touch() throws a helpful error on unknown sessionId", () => {
    expect(() => mgr.touch("nope")).toThrow(/Unknown sessionId.*nope/);
  });

  it("enforces maxSessions", () => {
    mgr.register(makeFakeSession("a"));
    mgr.register(makeFakeSession("b"));
    mgr.register(makeFakeSession("c"));
    expect(() => mgr.register(makeFakeSession("d"))).toThrow(/Session cap reached \(3\)/);
  });

  it("close() removes the session and closes the underlying browser", async () => {
    const fake = makeFakeSession("abc");
    mgr.register(fake);
    const closed = await mgr.close("abc");
    expect(closed).toBe(true);
    expect(fake.browser.close).toHaveBeenCalledOnce();
    expect(mgr.size()).toBe(0);
  });

  it("close() returns false for an unknown session", async () => {
    expect(await mgr.close("ghost")).toBe(false);
  });

  it("closeAll() shuts down every active session and prevents new registrations", async () => {
    const a = makeFakeSession("a");
    const b = makeFakeSession("b");
    mgr.register(a);
    mgr.register(b);
    await mgr.closeAll();
    expect(a.browser.close).toHaveBeenCalled();
    expect(b.browser.close).toHaveBeenCalled();
    expect(mgr.size()).toBe(0);
    expect(() => mgr.register(makeFakeSession("c"))).toThrow(/shutting down/);
  });

  it("does not leak the session from the map if browser.close() throws", async () => {
    const fake = makeFakeSession("abc");
    fake.browser.close.mockRejectedValueOnce(new Error("dead socket"));
    mgr.register(fake);
    const closed = await mgr.close("abc");
    expect(closed).toBe(true);
    expect(mgr.size()).toBe(0);
  });

  it("reaps sessions that exceed idleTimeoutMs", async () => {
    // Use a real interval and a tight idle threshold.
    const reaped = new SessionManager({ reaperIntervalMs: 10, idleTimeoutMs: 20, maxSessions: 5 });
    const fake = makeFakeSession("idle");
    reaped.register(fake);
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.browser.close).toHaveBeenCalled();
    expect(reaped.size()).toBe(0);
    await reaped.closeAll();
  });
});
