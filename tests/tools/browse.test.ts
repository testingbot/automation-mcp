import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted webdriver mock — browse.ts calls WebDriver.newSession() and then
// drives the returned client. We provide a fake client whose methods are spies.
const { fakeDriver, mockNewSession } = vi.hoisted(() => {
  const fakeDriver = {
    sessionId: "tb-sess-123",
    navigateTo: vi.fn().mockResolvedValue(undefined),
    getTitle: vi.fn().mockResolvedValue("Example Domain"),
    getUrl: vi.fn().mockResolvedValue("https://example.com/"),
    executeScript: vi.fn().mockResolvedValue({
      title: "Example Domain",
      url: "https://example.com/",
      headings: ["H1: Example Domain"],
      actionable: [
        { tag: "a", role: null, text: "More information...", href: "https://www.iana.org/" },
      ],
      actionableTotal: 1,
      body: "This domain is for use in illustrative examples.",
      bodyTruncated: false,
    }),
    setTimeouts: vi.fn().mockResolvedValue(undefined),
    findElement: vi.fn().mockResolvedValue({
      "element-6066-11e4-a52e-4f735466cecf": "element-99",
    }),
    elementClick: vi.fn().mockResolvedValue(undefined),
    elementClear: vi.fn().mockResolvedValue(undefined),
    elementSendKeys: vi.fn().mockResolvedValue(undefined),
    getElementText: vi.fn().mockResolvedValue("hello world"),
    getElementAttribute: vi.fn().mockResolvedValue("https://example.com"),
    takeScreenshot: vi.fn().mockResolvedValue("UE5HREFUQQ=="),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  };
  const mockNewSession = vi.fn().mockResolvedValue(fakeDriver);
  return { fakeDriver, mockNewSession };
});

vi.mock("webdriver", () => ({
  default: { newSession: mockNewSession },
}));

import addBrowseTools from "../../src/tools/browse.js";
import { SessionManager } from "../../src/session-manager.js";

describe("Browser tools", () => {
  let serverMock: any;
  let testingBotApi: any;
  let sessions: SessionManager;
  let tools: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-arm stubs (vi.clearAllMocks clears resolved values too).
    (fakeDriver.getTitle as any).mockResolvedValue("Example Domain");
    (fakeDriver.getUrl as any).mockResolvedValue("https://example.com/");
    (fakeDriver.takeScreenshot as any).mockResolvedValue("UE5HREFUQQ==");
    (fakeDriver.findElement as any).mockResolvedValue({
      "element-6066-11e4-a52e-4f735466cecf": "element-99",
    });
    (fakeDriver.executeScript as any).mockResolvedValue({
      title: "Example Domain",
      url: "https://example.com/",
      headings: ["H1: Example Domain"],
      actionable: [
        { tag: "a", role: null, text: "More information...", href: "https://www.iana.org/" },
      ],
      actionableTotal: 1,
      body: "This domain is for use in illustrative examples.",
      bodyTruncated: false,
    });
    (mockNewSession as any).mockResolvedValue(fakeDriver);

    serverMock = {
      tool: vi.fn((name, desc, schema, handler) => ({ name, desc, schema, handler })),
    };
    testingBotApi = {
      options: { api_key: "kkk", api_secret: "sss" },
      getAuthenticationHashForSharing: vi.fn().mockReturnValue("hash-deadbeef"),
    };
    sessions = new SessionManager({ reaperIntervalMs: 0, idleTimeoutMs: 60_000, maxSessions: 5 });
    tools = addBrowseTools(serverMock, testingBotApi, sessions);
  });

  afterEach(async () => {
    await sessions.closeAll();
  });

  // ---- tb_openBrowser ------------------------------------------------------

  it("tb_openBrowser starts a WebDriver session and returns sessionId + live URL", async () => {
    const result = await tools.tb_openBrowser.handler({
      browserName: "safari",
      browserVersion: "17",
      platform: "VENTURA",
      name: "smoke",
    });

    expect(mockNewSession).toHaveBeenCalledOnce();
    const call = (mockNewSession as any).mock.calls[0][0];
    expect(call.user).toBe("kkk");
    expect(call.key).toBe("sss");
    expect(call.hostname).toBe("hub.testingbot.com");
    expect(call.capabilities.browserName).toBe("safari");
    expect(call.capabilities.browserVersion).toBe("17");
    expect(call.capabilities.platformName).toBe("VENTURA");
    expect(call.capabilities["tb:options"].name).toBe("smoke");
    expect(result.content[0].text).toContain("tb-sess-123");
    expect(result.content[0].text).toContain(
      "https://testingbot.com/tests/tb-sess-123/live?auth=hash-deadbeef"
    );
    expect(sessions.size()).toBe(1);
  });

  it("tb_openBrowser lowercases the browser name in capabilities", async () => {
    await tools.tb_openBrowser.handler({
      browserName: "Safari",
      browserVersion: "17",
      platform: "VENTURA",
    });
    const call = (mockNewSession as any).mock.calls[0][0];
    expect(call.capabilities.browserName).toBe("safari");
  });

  it("tb_openBrowser errors when WebDriver doesn't return a sessionId", async () => {
    (mockNewSession as any).mockResolvedValueOnce({ ...fakeDriver, sessionId: undefined });
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      browserVersion: "120",
      platform: "WIN11",
    });
    expect(result.isError).toBe(true);
  });

  it("tb_openBrowser emits Appium-style mobile caps when deviceName is set (Android Chrome)", async () => {
    const result = await tools.tb_openBrowser.handler({
      browserName: "Chrome",
      platform: "Android",
      deviceName: "Google Pixel 8",
      platformVersion: "14",
    });
    const call = (mockNewSession as any).mock.calls[0][0];
    expect(call.capabilities.browserName).toBe("chrome");
    expect(call.capabilities.platformName).toBe("Android");
    expect(call.capabilities["appium:deviceName"]).toBe("Google Pixel 8");
    expect(call.capabilities["appium:platformVersion"]).toBe("14");
    expect(call.capabilities["appium:automationName"]).toBe("UiAutomator2");
    // browserVersion / legacy `platform` are intentionally omitted for mobile —
    // they confuse TestingBot's hub when Appium routing is in play.
    expect(call.capabilities.browserVersion).toBeUndefined();
    expect(call.capabilities.platform).toBeUndefined();
    expect(result.content[0].text).toContain("Google Pixel 8");
    expect(result.content[0].text).toContain("Android 14");
  });

  it("tb_openBrowser defaults a mobile session to an emulator/simulator", async () => {
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "Android",
      deviceName: "Google Pixel 9",
      platformVersion: "15",
    });
    const call = (mockNewSession as any).mock.calls.at(-1)[0];
    expect(call.capabilities["tb:options"].realDevice).toBeUndefined();
    expect(result.content[0].text).toContain("emulator/simulator");
  });

  it("tb_openBrowser sets tb:options.realDevice when realDevice is requested", async () => {
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "Android",
      deviceName: "Google Pixel 9",
      platformVersion: "15",
      realDevice: true,
    });
    const call = (mockNewSession as any).mock.calls.at(-1)[0];
    expect(call.capabilities["tb:options"].realDevice).toBe(true);
    expect(result.content[0].text).toContain("real device");
  });

  it("tb_openBrowser ignores realDevice for desktop sessions", async () => {
    await tools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "WIN11",
      realDevice: true,
    });
    const call = (mockNewSession as any).mock.calls.at(-1)[0];
    expect(call.capabilities["tb:options"].realDevice).toBeUndefined();
  });

  it("tb_openBrowser opens a real-device session when the device is available", async () => {
    testingBotApi.getDevices = vi
      .fn()
      .mockResolvedValue([
        { name: "Pixel 9", platform_name: "Android", version: "15", available: true },
      ]);
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "Android",
      deviceName: "Google Pixel 9",
      platformVersion: "15",
      realDevice: true,
    });
    expect(mockNewSession).toHaveBeenCalledOnce();
    expect(result.content[0].text).toContain("real device");
  });

  it("tb_openBrowser suggests alternatives and starts no session when the exact device+version is busy", async () => {
    testingBotApi.getDevices = vi.fn().mockResolvedValue([
      { name: "Pixel 9", platform_name: "Android", version: "15", available: false },
      { name: "Pixel 8", platform_name: "Android", version: "14", available: true },
      { name: "iPhone 15", platform_name: "iOS", version: "17", available: true },
    ]);
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "Android",
      deviceName: "Google Pixel 9",
      platformVersion: "15",
      realDevice: true,
    });
    expect(mockNewSession).not.toHaveBeenCalled();
    const text = result.content[0].text;
    expect(text).toContain("No session was started");
    expect(text).toContain("busy");
    expect(text).toContain("Pixel 8"); // same-platform available alternative
    expect(text).not.toContain("iPhone 15"); // different platform filtered out
  });

  it("tb_openBrowser reports a version mismatch (no fallback) when the OS version isn't offered", async () => {
    // Pixel 9 only exists on Android 16; requesting 15 must NOT silently run on 16
    // (the hub would time out). It should list the offered versions instead.
    testingBotApi.getDevices = vi
      .fn()
      .mockResolvedValue([
        { name: "Pixel 9", platform_name: "Android", version: "16", available: true },
      ]);
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "Android",
      deviceName: "Google Pixel 9",
      platformVersion: "15",
      realDevice: true,
    });
    expect(mockNewSession).not.toHaveBeenCalled();
    const text = result.content[0].text;
    expect(text).toContain("not offered on Android 15");
    expect(text).toContain("Pixel 9 16 (available)");
  });

  it("tb_openBrowser treats version 16.0 and catalog 16 as the same version", async () => {
    testingBotApi.getDevices = vi
      .fn()
      .mockResolvedValue([
        { name: "Pixel 9", platform_name: "Android", version: "16", available: true },
      ]);
    await tools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "Android",
      deviceName: "Google Pixel 9",
      platformVersion: "16.0",
      realDevice: true,
    });
    expect(mockNewSession).toHaveBeenCalledOnce();
  });

  it("tb_openBrowser coerces a stringified realDevice:'true' into a real-device session", async () => {
    testingBotApi.getDevices = vi
      .fn()
      .mockResolvedValue([
        { name: "Pixel 9", platform_name: "Android", version: "15", available: true },
      ]);
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "Android",
      deviceName: "Google Pixel 9",
      platformVersion: "15",
      realDevice: "true",
    });
    const call = (mockNewSession as any).mock.calls.at(-1)[0];
    expect(call.capabilities["tb:options"].realDevice).toBe(true);
    expect(result.content[0].text).toContain("real device");
  });

  it("tb_openBrowser treats stringified realDevice:'false' as an emulator (not a real device)", async () => {
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "Android",
      deviceName: "Google Pixel 9",
      platformVersion: "15",
      realDevice: "false",
    });
    const call = (mockNewSession as any).mock.calls.at(-1)[0];
    expect(call.capabilities["tb:options"].realDevice).toBeUndefined();
    expect(result.content[0].text).toContain("emulator/simulator");
  });

  it("tb_openBrowser proceeds when the availability check itself fails", async () => {
    testingBotApi.getDevices = vi.fn().mockRejectedValue(new Error("devices API down"));
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "Android",
      deviceName: "Google Pixel 9",
      platformVersion: "15",
      realDevice: true,
    });
    expect(mockNewSession).toHaveBeenCalledOnce();
    expect(result.content[0].text).toContain("real device");
  });

  it("tb_openBrowser picks XCUITest when the mobile platform is iOS", async () => {
    await tools.tb_openBrowser.handler({
      browserName: "Safari",
      platform: "iOS",
      deviceName: "iPhone 15 Pro",
      platformVersion: "17",
    });
    const call = (mockNewSession as any).mock.calls[0][0];
    expect(call.capabilities["appium:automationName"]).toBe("XCUITest");
    expect(call.capabilities["appium:deviceName"]).toBe("iPhone 15 Pro");
  });

  it("tb_openBrowser honors automationName override when provided", async () => {
    await tools.tb_openBrowser.handler({
      browserName: "Chrome",
      platform: "Android",
      deviceName: "Pixel 8",
      automationName: "Espresso",
    });
    const call = (mockNewSession as any).mock.calls[0][0];
    expect(call.capabilities["appium:automationName"]).toBe("Espresso");
  });

  it("tb_openBrowser ignores screenResolution for mobile sessions", async () => {
    await tools.tb_openBrowser.handler({
      browserName: "Chrome",
      platform: "Android",
      deviceName: "Pixel 8",
      screenResolution: "1080x2400",
    });
    const call = (mockNewSession as any).mock.calls[0][0];
    expect(call.capabilities["tb:options"].screenResolution).toBeUndefined();
  });

  it("tb_openBrowser errors when credentials are missing", async () => {
    // Build a registration with no creds in testingBotApi.options and no env vars.
    const oldKey = process.env.TESTINGBOT_KEY;
    const oldSecret = process.env.TESTINGBOT_SECRET;
    const oldTb = process.env.TB_KEY;
    const oldTbS = process.env.TB_SECRET;
    delete process.env.TESTINGBOT_KEY;
    delete process.env.TESTINGBOT_SECRET;
    delete process.env.TB_KEY;
    delete process.env.TB_SECRET;

    const localSessions = new SessionManager({ reaperIntervalMs: 0 });
    const localTools = addBrowseTools(serverMock, { options: {} }, localSessions);
    const result = await localTools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "WIN11",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Missing TestingBot credentials");

    if (oldKey !== undefined) process.env.TESTINGBOT_KEY = oldKey;
    if (oldSecret !== undefined) process.env.TESTINGBOT_SECRET = oldSecret;
    if (oldTb !== undefined) process.env.TB_KEY = oldTb;
    if (oldTbS !== undefined) process.env.TB_SECRET = oldTbS;
  });

  // ---- tb_navigate ---------------------------------------------------------

  it("tb_navigate calls driver.navigateTo and reports title + URL", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    const result = await tools.tb_navigate.handler({
      sessionId: "tb-sess-123",
      url: "https://example.com",
    });
    expect(fakeDriver.navigateTo).toHaveBeenCalledWith("https://example.com");
    expect(result.content[0].text).toContain("Example Domain");
    expect(result.content[0].text).toContain("https://example.com/");
  });

  it("tb_navigate fails helpfully on unknown sessionId", async () => {
    const result = await tools.tb_navigate.handler({
      sessionId: "ghost",
      url: "https://example.com",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown sessionId");
  });

  // ---- tb_snapshot ---------------------------------------------------------

  it("tb_snapshot returns title, headings, actionables, and body inside a fence", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    const result = await tools.tb_snapshot.handler({ sessionId: "tb-sess-123" });
    expect(fakeDriver.executeScript).toHaveBeenCalled();
    const text = result.content[0].text;
    expect(text).toContain("Example Domain");
    expect(text).toContain("## Headings");
    expect(text).toContain("## Actionable");
    expect(text).toContain("More information");
  });

  // ---- tb_click ------------------------------------------------------------

  it("tb_click uses CSS by default and calls elementClick", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    const result = await tools.tb_click.handler({
      sessionId: "tb-sess-123",
      value: "button#go",
      timeoutMs: 1000,
    });
    // setTimeouts is the positional W3C protocol command (implicit, pageLoad,
    // script) — passing an object made the hub reject it ("implicit: object").
    expect(fakeDriver.setTimeouts).toHaveBeenCalledWith(1000);
    expect(fakeDriver.findElement).toHaveBeenCalledWith("css selector", "button#go");
    expect(fakeDriver.elementClick).toHaveBeenCalledWith("element-99");
    expect(result.content[0].text).toBe("Clicked css=button#go");
  });

  it("tb_click supports xpath", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    await tools.tb_click.handler({
      sessionId: "tb-sess-123",
      by: "xpath",
      value: "//button[@id='go']",
    });
    expect(fakeDriver.findElement).toHaveBeenCalledWith("xpath", "//button[@id='go']");
  });

  it("tb_click maps id locator to CSS #id", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    await tools.tb_click.handler({ sessionId: "tb-sess-123", by: "id", value: "go" });
    expect(fakeDriver.findElement).toHaveBeenCalledWith("css selector", "#go");
  });

  it("tb_click maps name locator to CSS [name=...]", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    await tools.tb_click.handler({ sessionId: "tb-sess-123", by: "name", value: "submit" });
    expect(fakeDriver.findElement).toHaveBeenCalledWith("css selector", '[name="submit"]');
  });

  it("tb_click errors clearly when element is missing", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    (fakeDriver.findElement as any).mockResolvedValueOnce({});
    const result = await tools.tb_click.handler({ sessionId: "tb-sess-123", value: "#nope" });
    expect(result.isError).toBe(true);
    expect(fakeDriver.elementClick).not.toHaveBeenCalled();
  });

  // ---- tb_type -------------------------------------------------------------

  it("tb_type clears, types, and optionally presses Enter", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    await tools.tb_type.handler({
      sessionId: "tb-sess-123",
      value: "input[name=q]",
      text: "hello",
      pressEnter: true,
    });
    expect(fakeDriver.elementClear).toHaveBeenCalledWith("element-99");
    expect(fakeDriver.elementSendKeys).toHaveBeenNthCalledWith(1, "element-99", "hello");
    // Enter is sent as a second elementSendKeys call (W3C Enter codepoint).
    expect((fakeDriver.elementSendKeys as any).mock.calls.length).toBe(2);
  });

  it("tb_type skips clear when clearFirst=false", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    await tools.tb_type.handler({
      sessionId: "tb-sess-123",
      value: "input[name=q]",
      text: "hello",
      clearFirst: false,
    });
    expect(fakeDriver.elementClear).not.toHaveBeenCalled();
    expect(fakeDriver.elementSendKeys).toHaveBeenCalledWith("element-99", "hello");
  });

  // ---- tb_getText ----------------------------------------------------------

  it("tb_getText returns the text of the resolved element", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    const result = await tools.tb_getText.handler({ sessionId: "tb-sess-123", value: "#status" });
    expect(fakeDriver.getElementText).toHaveBeenCalledWith("element-99");
    expect(result.content[0].text).toBe("hello world");
  });

  // ---- tb_getAttribute -----------------------------------------------------

  it("tb_getAttribute returns the requested attribute value", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    const result = await tools.tb_getAttribute.handler({
      sessionId: "tb-sess-123",
      value: "a.cta",
      attribute: "href",
    });
    expect(fakeDriver.getElementAttribute).toHaveBeenCalledWith("element-99", "href");
    expect(result.content[0].text).toBe("https://example.com");
  });

  it("tb_getAttribute reports missing attributes clearly", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    (fakeDriver.getElementAttribute as any).mockResolvedValueOnce(null);
    const result = await tools.tb_getAttribute.handler({
      sessionId: "tb-sess-123",
      value: "a.cta",
      attribute: "data-x",
    });
    expect(result.content[0].text).toContain("no 'data-x' attribute");
  });

  // ---- tb_executeScript ----------------------------------------------------

  it("tb_executeScript forwards the script + args and JSON-stringifies the result", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    (fakeDriver.executeScript as any).mockResolvedValueOnce({ ok: true, count: 3 });
    const result = await tools.tb_executeScript.handler({
      sessionId: "tb-sess-123",
      script: "return { ok: true, count: 3 }",
      args: [],
    });
    expect(fakeDriver.executeScript).toHaveBeenCalledWith("return { ok: true, count: 3 }", []);
    expect(result.content[0].text).toContain('"ok": true');
    expect(result.content[0].text).toContain('"count": 3');
  });

  // ---- tb_closeBrowser -----------------------------------------------------

  it("tb_closeBrowser calls deleteSession and removes the session", async () => {
    await tools.tb_openBrowser.handler({ browserName: "chrome", platform: "WIN11" });
    const result = await tools.tb_closeBrowser.handler({ sessionId: "tb-sess-123" });
    expect(fakeDriver.deleteSession).toHaveBeenCalled();
    expect(result.content[0].text).toContain("Closed session");
    expect(sessions.size()).toBe(0);
  });

  it("tb_closeBrowser is idempotent for unknown sessions", async () => {
    const result = await tools.tb_closeBrowser.handler({ sessionId: "ghost" });
    expect(result.content[0].text).toContain("No active session ghost");
    expect(result.isError).toBeUndefined();
  });
});
