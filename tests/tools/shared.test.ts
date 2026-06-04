import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import addSharedTools from "../../src/tools/shared.js";
import { SessionManager } from "../../src/session-manager.js";

// Mobile/Appium sessions are delegated to appium-mcp now, so the shared tools
// here only have to cover the browser session shape.

describe("Shared tools", () => {
  let serverMock: any;
  let sessions: SessionManager;
  let tools: Record<string, any>;
  let fakeBrowserDriver: any;

  beforeEach(() => {
    vi.clearAllMocks();

    serverMock = {
      tool: vi.fn((name, desc, schema, handler) => ({ name, desc, schema, handler })),
    };

    fakeBrowserDriver = {
      takeScreenshot: vi.fn().mockResolvedValue("PNGBROWSERB64"),
      performActions: vi.fn().mockResolvedValue(undefined),
      releaseActions: vi.fn().mockResolvedValue(undefined),
    };

    sessions = new SessionManager({ reaperIntervalMs: 0, idleTimeoutMs: 60_000, maxSessions: 5 });

    sessions.register({
      id: "b1",
      type: "browser",
      driver: fakeBrowserDriver,
      browserName: "chrome",
      capabilities: { browserName: "chrome" },
      liveViewUrl: "https://example.test/b1",
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    tools = addSharedTools(serverMock, sessions);
  });

  afterEach(async () => {
    await sessions.closeAll();
  });

  // ---- tb_screenshot -------------------------------------------------------

  it("tb_screenshot returns the driver's base64 PNG output", async () => {
    const result = await tools.tb_screenshot.handler({ sessionId: "b1" });
    expect(fakeBrowserDriver.takeScreenshot).toHaveBeenCalled();
    expect(result.content[0].type).toBe("image");
    expect(result.content[0].mimeType).toBe("image/png");
    expect(result.content[0].data).toBe("PNGBROWSERB64");
  });

  it("tb_screenshot fails helpfully on unknown sessionId", async () => {
    const result = await tools.tb_screenshot.handler({ sessionId: "ghost" });
    expect(result.isError).toBe(true);
  });

  // ---- tb_pressKey ---------------------------------------------------------

  it("tb_pressKey sends a single W3C key down+up pair", async () => {
    await tools.tb_pressKey.handler({ sessionId: "b1", key: "Enter" });
    expect(fakeBrowserDriver.performActions).toHaveBeenCalledOnce();
    const payload = (fakeBrowserDriver.performActions as any).mock.calls[0][0][0];
    expect(payload.type).toBe("key");
    expect(payload.actions[0].type).toBe("keyDown");
    expect(payload.actions[1].type).toBe("keyUp");
    // The Enter W3C codepoint is U+E007.
    expect(payload.actions[0].value).toBe("");
  });

  it("tb_pressKey expands chords like Control+A into modifier wrap", async () => {
    await tools.tb_pressKey.handler({ sessionId: "b1", key: "Control+A" });
    const actions = (fakeBrowserDriver.performActions as any).mock.calls[0][0][0].actions;
    expect(actions.length).toBe(4); // down Ctrl, down A, up A, up Ctrl
    expect(actions[0]).toEqual({ type: "keyDown", value: "" }); // Control
    expect(actions[1]).toEqual({ type: "keyDown", value: "A" });
    expect(actions[2]).toEqual({ type: "keyUp", value: "A" });
    expect(actions[3]).toEqual({ type: "keyUp", value: "" });
  });

  it("tb_pressKey calls releaseActions to clear modifier state", async () => {
    await tools.tb_pressKey.handler({ sessionId: "b1", key: "Tab" });
    expect(fakeBrowserDriver.releaseActions).toHaveBeenCalled();
  });

  it("tb_pressKey fails on unknown sessionId", async () => {
    const result = await tools.tb_pressKey.handler({ sessionId: "ghost", key: "Enter" });
    expect(result.isError).toBe(true);
  });

  // ---- tb_listSessions -----------------------------------------------------

  it("tb_listSessions reports the active browser session with its type tag", async () => {
    const result = await tools.tb_listSessions.handler({});
    expect(result.content[0].text).toContain("`b1` (browser)");
    expect(result.content[0].text).toContain("Active sessions (1)");
  });

  it("tb_listSessions reports empty state cleanly", async () => {
    await sessions.closeAll();
    const fresh = new SessionManager({ reaperIntervalMs: 0 });
    const freshTools = addSharedTools(serverMock, fresh);
    const result = await freshTools.tb_listSessions.handler({});
    expect(result.content[0].text).toContain("No active sessions");
    await fresh.closeAll();
  });
});
