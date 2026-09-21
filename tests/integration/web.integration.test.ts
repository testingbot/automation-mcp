import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import { addAutomationTools, type AutomationHandle } from "../../src/register.js";

// Double-gated. Every condition must be true or the whole suite is skipped:
// 1. The runner explicitly opted in via RUN_INTEGRATION_TESTS=true
// 2. Real credentials are present (either env-var naming is accepted)
const KEY = process.env.TESTINGBOT_KEY || process.env.TB_KEY || "";
const SECRET = process.env.TESTINGBOT_SECRET || process.env.TB_SECRET || "";
const SHOULD_RUN = process.env.RUN_INTEGRATION_TESTS === "true" && !!KEY && !!SECRET;

const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

// Requested desktop resolution. Asserted end-to-end below — the capability is
// only honoured under its kebab-case name, so this is the test that proves the
// tb:options key is right, not just well-formed.
const RESOLUTION = "1920x1080";

// A small, fully-controlled form injected into whatever page is loaded. Using
// our own DOM rather than a third-party page keeps the element-level tools
// (click / type / getText / getAttribute / pressKey) deterministic.
const INJECT_FIXTURE = `
  const host = document.createElement('div');
  host.id = 'tb-fixture';
  host.innerHTML =
    '<input id="tb-input" value="preset" data-role="probe" aria-label="Probe input">' +
    '<button id="tb-button" type="button">Press me</button>' +
    '<p id="tb-output">untouched</p>' +
    '<a id="tb-link" href="https://testingbot.com/">TestingBot</a>';
  document.body.appendChild(host);
  const out = host.querySelector('#tb-output');
  host.querySelector('#tb-button').addEventListener('click', () => { out.textContent = 'clicked'; });
  host.querySelector('#tb-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { out.textContent = 'entered:' + e.target.value; }
  });
  return 'injected';
`;

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

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const require = createRequire(import.meta.url);
    const TestingBot = require("testingbot-api");
    const testingBotApi = new TestingBot({
      api_key: KEY,
      api_secret: SECRET,
    });

    const config = {
      "testingbot-key": KEY,
      "testingbot-secret": SECRET,
    };

    // addAutomationTools is async (it discovers the appium-mcp child before
    // resolving) — awaiting is mandatory or `handle` is a bare Promise.
    handle = await addAutomationTools(serverShim, testingBotApi, config, {
      // Short reaper interval so a forgotten session doesn't bleed minutes.
      reaperIntervalMs: 0, // disable during the test; closeAll runs in afterAll
      maxSessions: 2,
    });
    tools = handle.tools as Record<string, any>;
  });

  afterAll(async () => {
    // Belt and braces: closeAll releases anything a failed test left open, so a
    // mid-suite failure never leaks a billing session.
    if (handle) await handle.shutdown();
  });

  // ---- session lifecycle ---------------------------------------------------

  it("opens a real Chrome session and returns a sessionId + live-view URL", async () => {
    const result = await tools.tb_openBrowser.handler({
      browserName: "chrome",
      browserVersion: "latest",
      platform: "WIN11",
      name: "automation-mcp integration smoke",
      build: `ci-${process.env.GITHUB_RUN_ID ?? "local"}`,
      screenResolution: RESOLUTION,
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

  it("applies the requested screen resolution on the VM", async () => {
    // TestingBot only honours the kebab-case `screen-resolution` key inside
    // tb:options; a camelCase spelling is dropped silently and the VM stays at
    // its 1280x1024 default. Assert the pixels, not just the capability shape.
    const result = await tools.tb_executeScript.handler({
      sessionId,
      script: "return screen.width + 'x' + screen.height",
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text as string)).toBe(RESOLUTION);
  });

  // ---- navigation & inspection --------------------------------------------

  it("navigates to example.com and reports the right page title", async () => {
    const result = await tools.tb_navigate.handler({
      sessionId,
      url: "https://example.com",
      waitUntil: "load",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Example Domain/i);
    expect(result.content[0].text).toContain("https://example.com/");
    // waitUntil 'load' means readyState reached 'complete' before we returned.
    expect(result.content[0].text).not.toContain("Still loading");
  });

  it("navigates with waitUntil 'none' without waiting on readyState", async () => {
    const result = await tools.tb_navigate.handler({
      sessionId,
      url: "https://example.com",
      waitUntil: "none",
    });
    expect(result.isError).toBeUndefined();
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

  it("reads element text off the live page", async () => {
    const result = await tools.tb_getText.handler({ sessionId, by: "css", value: "h1" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Example Domain/i);
  });

  it("reads an element attribute off the live page", async () => {
    const result = await tools.tb_getAttribute.handler({
      sessionId,
      by: "css",
      value: "a",
      attribute: "href",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("iana.org");
  });

  // ---- element interaction (against an injected, deterministic fixture) -----

  it("executes a script that injects a test fixture", async () => {
    const result = await tools.tb_executeScript.handler({
      sessionId,
      script: INJECT_FIXTURE,
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text as string)).toBe("injected");
  });

  it("passes positional arguments through to the page", async () => {
    const result = await tools.tb_executeScript.handler({
      sessionId,
      script: "return arguments[0] + arguments[1]",
      args: [2, 40],
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text as string)).toBe(42);
  });

  it("clicks an element and the page reacts", async () => {
    const click = await tools.tb_click.handler({ sessionId, by: "css", value: "#tb-button" });
    expect(click.isError).toBeUndefined();
    expect(click.content[0].text).toContain("Clicked");

    const out = await tools.tb_getText.handler({ sessionId, by: "id", value: "tb-output" });
    expect(out.content[0].text).toBe("clicked");
  });

  it("types into an input, clearing the preset value first", async () => {
    const typed = await tools.tb_type.handler({
      sessionId,
      by: "css",
      value: "#tb-input",
      text: "hello-tb",
    });
    expect(typed.isError).toBeUndefined();

    const value = await tools.tb_getAttribute.handler({
      sessionId,
      by: "css",
      value: "#tb-input",
      attribute: "value",
    });
    // clearFirst defaults to true, so the "preset" value must be gone.
    expect(value.content[0].text).toBe("hello-tb");
  });

  it("types with pressEnter and the keydown handler fires", async () => {
    const typed = await tools.tb_type.handler({
      sessionId,
      by: "css",
      value: "#tb-input",
      text: "submit-me",
      pressEnter: true,
    });
    expect(typed.isError).toBeUndefined();
    expect(typed.content[0].text).toContain("pressed Enter");

    const out = await tools.tb_getText.handler({ sessionId, by: "id", value: "tb-output" });
    expect(out.content[0].text).toBe("entered:submit-me");
  });

  it("presses a key on the focused element via tb_pressKey", async () => {
    // Focus the input and reset the output, then drive a bare Enter through the
    // W3C actions API (a different code path from tb_type's pressEnter).
    await tools.tb_executeScript.handler({
      sessionId,
      script:
        "document.getElementById('tb-output').textContent = 'reset';" +
        "const i = document.getElementById('tb-input'); i.value = 'via-actions'; i.focus(); return true;",
    });

    const pressed = await tools.tb_pressKey.handler({ sessionId, key: "Enter" });
    expect(pressed.isError).toBeUndefined();
    expect(pressed.content[0].text).toContain("Pressed Enter");

    const out = await tools.tb_getText.handler({ sessionId, by: "id", value: "tb-output" });
    expect(out.content[0].text).toBe("entered:via-actions");
  });

  it("resolves elements through every locator strategy", async () => {
    // findOne() maps our `by` values onto W3C strategies; a wrong mapping only
    // shows up against a real driver.
    const cases: Array<[string, string]> = [
      ["css", "#tb-link"],
      ["id", "tb-link"],
      ["xpath", "//a[@id='tb-link']"],
      ["tag", "a"],
      ["linkText", "TestingBot"],
      ["partialLinkText", "Testing"],
    ];
    for (const [by, value] of cases) {
      const result = await tools.tb_getAttribute.handler({
        sessionId,
        by,
        value,
        attribute: "href",
      });
      expect(result.isError, `locator ${by}=${value} failed`).toBeUndefined();
      expect(result.content[0].text, `locator ${by}=${value}`).toContain("testingbot.com");
    }
  });

  it("returns a helpful error for a locator that matches nothing", async () => {
    const result = await tools.tb_click.handler({
      sessionId,
      by: "css",
      value: "#definitely-not-here",
      timeoutMs: 1000,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found|no such element/i);
  });

  // ---- capture & bookkeeping ----------------------------------------------

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

  it("reports no active sessions once everything is closed", async () => {
    const result = await tools.tb_listSessions.handler({});
    expect(result.content[0].text).toContain("No active sessions");
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
