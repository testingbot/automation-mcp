import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Wire-level contract test for the capabilities tb_openBrowser builds.
 *
 * Every other browse test mocks `WebDriver.newSession`, so the real client is
 * never asked whether the capability set is legal — which is how a legacy
 * `platform` cap shipped and failed every desktop session with "Invalid or
 * unsupported WebDriver capabilities found (platform)". The `webdriver`
 * package rejects any top-level key that is neither standard W3C nor
 * colon-namespaced, as soon as an extension cap (`tb:options`) is present.
 *
 * Here the mock only *redirects* the session to a local stub hub and records
 * the request body — the real `webdriver` client, real validation, and a real
 * HTTP round trip all run. No TestingBot session, no cost, safe for CI.
 */

// Body of the POST /wd/hub/session the stub hub received.
let lastSessionBody: { capabilities?: Record<string, unknown> } | null = null;
let hubPort = 0;
let server: http.Server;

const { mockNewSession } = vi.hoisted(() => ({ mockNewSession: vi.fn() }));

vi.mock("webdriver", () => ({
  default: { newSession: mockNewSession },
}));

import addBrowseTools from "../../src/tools/browse.js";
import { SessionManager } from "../../src/session-manager.js";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url?.endsWith("/session")) {
        lastSessionBody = JSON.parse(raw || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            value: {
              sessionId: "stub-session-1",
              capabilities: { browserName: "chrome", platformName: "WIN11" },
            },
          })
        );
        return;
      }
      // Anything else (DELETE /session/<id>, …) — acknowledge and move on.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hubPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("tb_openBrowser capability contract (real webdriver client, stub hub)", () => {
  let sessions: SessionManager;
  let tools: Record<string, any>;

  beforeEach(async () => {
    lastSessionBody = null;

    // Real client, pointed at the stub hub instead of hub.testingbot.com.
    const realWebDriver = (await vi.importActual<any>("webdriver")).default;
    mockNewSession.mockImplementation((opts: Record<string, unknown>) =>
      realWebDriver.newSession({
        ...opts,
        protocol: "http",
        hostname: "127.0.0.1",
        port: hubPort,
        path: "/wd/hub",
        connectionRetryCount: 0,
        logLevel: "silent",
      })
    );

    const serverMock = { tool: vi.fn((name, desc, schema, handler) => ({ name, handler })) };
    const testingBotApi = {
      options: { api_key: "kkk", api_secret: "sss" },
      getAuthenticationHashForSharing: vi.fn().mockReturnValue("hash-deadbeef"),
    };
    sessions = new SessionManager({ reaperIntervalMs: 0, idleTimeoutMs: 60_000, maxSessions: 5 });
    tools = addBrowseTools(serverMock, testingBotApi, sessions) as Record<string, any>;
  });

  afterEach(async () => {
    await sessions.closeAll();
    vi.clearAllMocks();
  });

  it("opens a desktop session the real client accepts", async () => {
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      browserVersion: "latest",
      platform: "WIN11",
      name: "contract",
      build: "b1",
      screenResolution: "1920x1080",
    });

    // A rejected capability set surfaces as an isError result, not a throw.
    expect(result.isError).toBeUndefined();

    const sent = lastSessionBody?.capabilities as Record<string, any>;
    expect(sent).toBeTruthy();
    // webdriver nests the payload as alwaysMatch/firstMatch.
    const always = sent.alwaysMatch ?? sent;
    expect(always.platformName).toBe("WIN11");
    expect(always.platform).toBeUndefined();
    expect(always["tb:options"]["screen-resolution"]).toBe("1920x1080");
    expect(always["tb:options"].name).toBe("contract");
    expect(always["tb:options"].build).toBe("b1");
  });

  it("opens a mobile session the real client accepts", async () => {
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      platform: "Android",
      deviceName: "Galaxy S23",
      platformVersion: "14",
    });

    expect(result.isError).toBeUndefined();
    const sent = lastSessionBody?.capabilities as Record<string, any>;
    const always = sent.alwaysMatch ?? sent;
    expect(always["appium:deviceName"]).toBe("Galaxy S23");
    expect(always["appium:platformVersion"]).toBe("14");
    expect(always["appium:automationName"]).toBe("UiAutomator2");
  });

  it("would reject a non-W3C top-level cap — the guard that was missing", async () => {
    // Proves the harness actually exercises validation: the same session with a
    // legacy `platform` key alongside `tb:options` must fail.
    const realWebDriver = (await vi.importActual<any>("webdriver")).default;
    await expect(
      realWebDriver.newSession({
        protocol: "http",
        hostname: "127.0.0.1",
        port: hubPort,
        path: "/wd/hub",
        logLevel: "silent",
        capabilities: {
          browserName: "chrome",
          platformName: "WIN11",
          platform: "WIN11",
          "tb:options": {},
        },
      })
    ).rejects.toThrow(/Invalid or unsupported WebDriver capabilities/);
  });
});
