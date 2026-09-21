import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import { addAutomationTools, type AutomationHandle } from "../../src/register.js";

/**
 * Mobile-browser integration. Separate from the desktop suite because it opens
 * a second billable session and exercises a different capability path
 * (`appium:*` caps on the same WebDriver session, routed through the hub's
 * Appium layer). The desktop suite cannot catch a regression here and vice
 * versa — the two branches of tb_openBrowser share no capability code.
 *
 * Gated on RUN_MOBILE_INTEGRATION_TESTS in addition to the usual flags, so a
 * run can opt into desktop-only when minutes are tight.
 */
const KEY = process.env.TESTINGBOT_KEY || process.env.TB_KEY || "";
const SECRET = process.env.TESTINGBOT_SECRET || process.env.TB_SECRET || "";
const SHOULD_RUN =
  process.env.RUN_INTEGRATION_TESTS === "true" &&
  process.env.RUN_MOBILE_INTEGRATION_TESTS === "true" &&
  !!KEY &&
  !!SECRET;

const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

describeOrSkip("Real mobile-browser integration (Android emulator)", () => {
  let handle: AutomationHandle;
  let tools: Record<string, any>;
  let sessionId: string;
  // Resolved from TestingBot's /v1/browsers catalog in beforeAll — hard-coding
  // a device name rots the moment the catalog changes.
  let deviceName = process.env.TB_MOBILE_DEVICE || "";
  let platformVersion = process.env.TB_MOBILE_VERSION || "";

  const serverShim = {
    tool: (name: string, _desc: string, _schema: any, handler: any) => ({ name, handler }),
  };

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const require = createRequire(import.meta.url);
    const TestingBot = require("testingbot-api");
    const testingBotApi = new TestingBot({ api_key: KEY, api_secret: SECRET });

    if (!deviceName) {
      // Emulators live in the /v1/browsers catalog, NOT /v1/devices — the
      // latter is the physical-device inventory. Mobile entries there carry
      // `deviceName` + `platformName`, and for them `version` is the OS
      // version (the browser is in `name`). Emulators are the cheapest way to
      // exercise the appium:* capability branch.
      const browsers = await testingBotApi.getBrowsers("webdriver");
      const android = (Array.isArray(browsers) ? browsers : []).filter(
        (b: any) => b?.deviceName && b?.platformName === "Android" && b?.name === "chrome"
      );
      // Newest OS version first, so the pick doesn't drift onto a stale image
      // as the catalog grows.
      android.sort((a: any, b: any) => parseFloat(b.version) - parseFloat(a.version));
      const pick = android[0];
      if (!pick) throw new Error("No Android emulator found in the TestingBot browser catalog");
      deviceName = pick.deviceName;
      platformVersion = platformVersion || String(pick.version);
    }

    handle = await addAutomationTools(
      serverShim,
      testingBotApi,
      { "testingbot-key": KEY, "testingbot-secret": SECRET },
      { reaperIntervalMs: 0, maxSessions: 2 }
    );
    tools = handle.tools as Record<string, any>;
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.shutdown();
  });

  it("opens a mobile Chrome session from appium:* capabilities", async () => {
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "Android",
      deviceName,
      platformVersion,
      name: "automation-mcp mobile smoke",
      build: `ci-${process.env.GITHUB_RUN_ID ?? "local"}`,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toContain("Session ID");
    expect(text).toContain(deviceName);
    // A mobile session must be reported as emulator unless realDevice was set.
    expect(text.toLowerCase()).toMatch(/emulator|simulator/);

    sessionId = text.match(/Session ID\*\*: `([^`]+)`/)![1];
  });

  it("drives the mobile browser with the same tools as desktop — no context switching", async () => {
    const nav = await tools.tb_navigate.handler({
      sessionId,
      url: "https://example.com",
      waitUntil: "load",
    });
    expect(nav.isError).toBeUndefined();
    expect(nav.content[0].text).toMatch(/Example Domain/i);

    const text = await tools.tb_getText.handler({ sessionId, by: "css", value: "h1" });
    expect(text.content[0].text).toMatch(/Example Domain/i);

    const snap = await tools.tb_snapshot.handler({ sessionId });
    expect(snap.isError).toBeUndefined();
    expect((snap.content[0].text as string).toLowerCase()).toContain("example domain");
  });

  it("reports a mobile viewport, not a desktop one", async () => {
    const result = await tools.tb_executeScript.handler({
      sessionId,
      script: "return window.innerWidth",
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text as string)).toBeLessThan(900);
  });

  it("captures a screenshot from the device", async () => {
    const result = await tools.tb_screenshot.handler({ sessionId });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].mimeType).toBe("image/png");
    expect(Buffer.from(result.content[0].data, "base64").length).toBeGreaterThan(1000);
  });

  it("closes the mobile session", async () => {
    const result = await tools.tb_closeBrowser.handler({ sessionId });
    expect(result.isError).toBeUndefined();
    expect(handle.sessions.size()).toBe(0);
  });
});

describe("Mobile integration suite is gated", () => {
  it("opts in via RUN_INTEGRATION_TESTS + RUN_MOBILE_INTEGRATION_TESTS + creds", () => {
    if (!SHOULD_RUN) {
      // eslint-disable-next-line no-console
      console.error(
        "[skip] Mobile integration tests not running. Set RUN_INTEGRATION_TESTS=true, RUN_MOBILE_INTEGRATION_TESTS=true, and credentials to enable."
      );
    }
    expect(typeof SHOULD_RUN).toBe("boolean");
  });
});
