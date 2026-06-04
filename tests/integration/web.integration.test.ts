import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import { addAutomationTools, type AutomationHandle } from "../../src/register.js";

// Double-gated. Every condition must be true or the whole suite is skipped:
// 1. The runner explicitly opted in via RUN_INTEGRATION_TESTS=true
// 2. Real credentials are present
const SHOULD_RUN =
  process.env.RUN_INTEGRATION_TESTS === "true" &&
  !!process.env.TESTINGBOT_KEY &&
  !!process.env.TESTINGBOT_SECRET;

const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

describeOrSkip("Real browser integration", () => {
  let handle: AutomationHandle;
  let tools: Record<string, any>;
  let sessionId: string;

  // Use a fresh manager per-suite so it doesn't conflict with anything else.
  // Bypass the standalone CLI server — we drive the library entry directly.
  const serverShim = {
    tool: (name: string, _desc: string, _schema: any, handler: any) => ({
      name,
      handler,
    }),
  };

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const require = createRequire(import.meta.url);
    const TestingBot = require("testingbot-api");
    const testingBotApi = new TestingBot({
      api_key: process.env.TESTINGBOT_KEY!,
      api_secret: process.env.TESTINGBOT_SECRET!,
    });

    const config = {
      "testingbot-key": process.env.TESTINGBOT_KEY!,
      "testingbot-secret": process.env.TESTINGBOT_SECRET!,
    };

    handle = addAutomationTools(serverShim, testingBotApi, config, {
      // Short reaper interval so a forgotten session doesn't bleed minutes.
      reaperIntervalMs: 0, // disable during the test; closeAll runs in afterAll
      maxSessions: 2,
    });
    tools = handle.tools as Record<string, any>;
  });

  afterAll(async () => {
    if (handle) await handle.shutdown();
  });

  it("opens a real Chrome session and returns a sessionId + live-view URL", async () => {
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      browserVersion: "latest",
      platform: "WIN11",
      name: "automation-mcp integration smoke",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toContain("Session ID");
    expect(text).toMatch(/https:\/\/testingbot\.com\/tests\/[^/]+\/live\?auth=[a-f0-9]+/);

    // Extract sessionId for the rest of the suite.
    const match = text.match(/Session ID\*\*: `([^`]+)`/);
    expect(match).toBeTruthy();
    sessionId = match![1];
  });

  it("the live-view URL is HTTP-reachable", async () => {
    expect(sessionId).toBeTruthy();
    const open = await tools.tb_listSessions.handler({});
    const liveUrl = (open.content[0].text as string).match(
      /live: (https:\/\/testingbot\.com\/tests\/[^\s]+)/
    )?.[1];
    expect(liveUrl).toBeTruthy();
    const head = await fetch(liveUrl!, { method: "HEAD" });
    // Anything in the 2xx/3xx range counts as reachable.
    expect(head.status).toBeGreaterThanOrEqual(200);
    expect(head.status).toBeLessThan(400);
  });

  it("navigates to example.com and reports the right page title", async () => {
    const result = await tools.tb_navigate.handler({
      sessionId,
      url: "https://example.com",
      waitUntil: "load",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Example Domain/i);
    expect(result.content[0].text).toContain("https://example.com/");
  });

  it("returns a non-empty ARIA snapshot", async () => {
    const result = await tools.tb_snapshot.handler({ sessionId });

    expect(result.isError).toBeUndefined();
    const yaml = result.content[0].text as string;
    expect(yaml).toContain("```yaml");
    // example.com's structure is stable; "Example Domain" appears in either
    // the H1 heading or the page title we prefix above the snapshot.
    expect(yaml.toLowerCase()).toContain("example domain");
  });

  it("returns a PNG screenshot as a base64 image content block", async () => {
    const result = await tools.tb_screenshot.handler({ sessionId });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("image");
    expect(result.content[0].mimeType).toBe("image/png");
    // PNG header magic bytes when decoded: 0x89 0x50 0x4E 0x47.
    const buf = Buffer.from(result.content[0].data, "base64");
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
    expect(buf.length).toBeGreaterThan(1000); // any real screenshot is at least 1KB
  });

  it("lists the active session with the right type tag", async () => {
    const result = await tools.tb_listSessions.handler({});
    expect(result.content[0].text).toContain(sessionId);
    expect(result.content[0].text).toContain("(browser)");
  });

  it("closes the session and removes it from the manager", async () => {
    const before = handle.sessions.size();
    expect(before).toBe(1);

    const result = await tools.tb_closeBrowser.handler({ sessionId });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Closed session");

    expect(handle.sessions.size()).toBe(0);
  });

  it("a follow-up call against the closed sessionId fails with a helpful error", async () => {
    const result = await tools.tb_navigate.handler({
      sessionId,
      url: "https://example.com",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown sessionId/);
  });
});

// Sanity smoke: even when the suite is skipped, make sure at least one assertion
// runs so vitest doesn't report 0 tests when integration is off.
describe("Integration suite is gated", () => {
  it("opts in via RUN_INTEGRATION_TESTS + creds", () => {
    if (!SHOULD_RUN) {
      // eslint-disable-next-line no-console
      console.error(
        "[skip] Integration tests not running. Set RUN_INTEGRATION_TESTS=true, TESTINGBOT_KEY, and TESTINGBOT_SECRET to enable."
      );
    }
    expect(typeof SHOULD_RUN).toBe("boolean");
  });
});
