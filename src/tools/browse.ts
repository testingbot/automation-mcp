import { z } from "zod";
import WebDriver from "webdriver";
import { handleMCPError, sanitizeSessionId } from "../lib/utils.js";
import logger from "../lib/logger.js";
import { SessionManager } from "../session-manager.js";
import { buildLiveViewUrl } from "../lib/live-view.js";

// TestingBot's WebDriver hub. We talk W3C WebDriver directly — works for
// every browser TestingBot supports (Chrome, Edge, Safari, Firefox, …).
const HUB = {
  protocol: "https" as const,
  hostname: "hub.testingbot.com",
  port: 443,
  path: "/wd/hub",
};

/** Extract the WebDriver elementId from a findElement() response, regardless
 *  of which protocol shape the remote returned. */
function asElementId(found: Record<string, unknown> | null | undefined): string | null {
  if (!found || typeof found !== "object") return null;
  return (
    (found["element-6066-11e4-a52e-4f735466cecf"] as string) || (found.ELEMENT as string) || null
  );
}

// W3C key codes for special keys that have no literal char representation.
const W3C_KEYS: Record<string, string> = {
  Enter: "\uE007",
  Tab: "\uE004",
  Escape: "\uE00C",
  Backspace: "\uE003",
  Delete: "\uE017",
  Space: "\uE00D",
  ArrowLeft: "\uE012",
  ArrowUp: "\uE013",
  ArrowRight: "\uE014",
  ArrowDown: "\uE015",
  Home: "\uE011",
  End: "\uE010",
  PageUp: "\uE00E",
  PageDown: "\uE00F",
  Control: "\uE051",
  Shift: "\uE050",
  Alt: "\uE052",
  Meta: "\uE053",
  Cmd: "\uE053",
};

// User-facing locator strategies (modeled after mcp-selenium so the same
// prompts that work there work here too).
export const LOCATOR_KEYS = [
  "css",
  "xpath",
  "id",
  "name",
  "tag",
  "class",
  "linkText",
  "partialLinkText",
] as const;
export type LocatorBy = (typeof LOCATOR_KEYS)[number];

/** Escape a string for safe use inside a CSS identifier. `CSS.escape` is a
 *  DOM-only API, so we ship a minimal replacement here. */
function cssEscape(value: string): string {
  return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

/** Convert (by, value) to the W3C (strategy, query) pair. `id`/`name`/`class`
 *  are translated to CSS — the W3C strategies for them are deprecated. */
function buildLocator(by: LocatorBy, value: string): { using: string; value: string } {
  switch (by) {
    case "css":
      return { using: "css selector", value };
    case "xpath":
      return { using: "xpath", value };
    case "id":
      return { using: "css selector", value: `#${cssEscape(value)}` };
    case "name":
      return { using: "css selector", value: `[name=${JSON.stringify(value)}]` };
    case "class":
      return { using: "css selector", value: `.${cssEscape(value)}` };
    case "tag":
      return { using: "tag name", value };
    case "linkText":
      return { using: "link text", value };
    case "partialLinkText":
      return { using: "partial link text", value };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findOne(driver: any, by: LocatorBy, value: string): Promise<string> {
  const loc = buildLocator(by, value);
  const found = await driver.findElement(loc.using, loc.value);
  const id = asElementId(found);
  if (!id) throw new Error(`Element not found: ${by}=${value}`);
  return id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function addBrowseTools(server: any, testingBotApi: any, sessions: SessionManager) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  // We need credentials for WebDriver.newSession. Pull them from the
  // testingBotApi instance the host passes us — keeps the registration
  // signature stable across the rest of the tool families.
  const key: string =
    testingBotApi?.options?.api_key ?? process.env.TESTINGBOT_KEY ?? process.env.TB_KEY ?? "";
  const secret: string =
    testingBotApi?.options?.api_secret ??
    process.env.TESTINGBOT_SECRET ??
    process.env.TB_SECRET ??
    "";

  // ---------------------------------------------------------------------------
  // tb_openBrowser
  // ---------------------------------------------------------------------------
  tools.tb_openBrowser = server.tool(
    "tb_openBrowser",
    "Start a remote browser session on TestingBot via WebDriver. Handles BOTH desktop browsers (Chrome/Edge/Safari/Firefox on Win/macOS/Linux) AND mobile browsers (Chrome on Android, Safari on iOS) on real TestingBot devices. For a mobile browser task, set `deviceName` and `platformVersion` — the session is still WebDriver/chromedriver-backed, so tb_navigate / tb_snapshot / tb_screenshot / tb_click work directly with no native-context juggling. **Prefer this over appium_session_management for any task whose goal is loading a web page in a browser**, even on mobile. Reserve appium_session_management for native-app testing (.apk/.ipa). Returns a sessionId for subsequent tool calls and a liveViewUrl the human can open to watch the agent drive in real time. Burns TestingBot minutes — call tb_closeBrowser when done.",
    {
      browserName: z
        .enum(["chrome", "firefox", "edge", "safari", "Chrome", "Firefox", "Edge", "Safari"])
        .describe("Browser engine"),
      browserVersion: z
        .string()
        .optional()
        .default("latest")
        .describe("Browser version (desktop only, default: 'latest'). Ignored for mobile."),
      platform: z
        .string()
        .describe(
          "Platform/OS. Desktop codes like 'WIN11', 'VENTURA', 'macOS Ventura', or for mobile pass 'Android' or 'iOS' (and also set deviceName + platformVersion)."
        ),
      deviceName: z
        .string()
        .optional()
        .describe(
          "Mobile device name (e.g. 'Google Pixel 8', 'iPhone 15 Pro'). REQUIRED for mobile-browser sessions. Triggers Appium-style capabilities under the hood, but the resulting session is still WebDriver — use tb_navigate / tb_snapshot etc. as usual."
        ),
      platformVersion: z
        .string()
        .optional()
        .describe(
          "Mobile OS version (e.g. '14' for Android 14, '17' for iOS 17). Pair with deviceName."
        ),
      automationName: z
        .string()
        .optional()
        .describe(
          "Mobile automation engine override. Defaults: 'UiAutomator2' for Android, 'XCUITest' for iOS. Only set this if you have a specific reason."
        ),
      name: z.string().optional().describe("Human-readable session name (shown in dashboard)"),
      build: z.string().optional().describe("Build identifier for grouping"),
      screenResolution: z
        .string()
        .optional()
        .describe(
          "Screen resolution for desktop sessions (e.g., '1920x1080'). Ignored for mobile."
        ),
    },
    async (args: {
      browserName: string;
      browserVersion?: string;
      platform: string;
      deviceName?: string;
      platformVersion?: string;
      automationName?: string;
      name?: string;
      build?: string;
      screenResolution?: string;
    }) => {
      try {
        if (!key || !secret) {
          throw new Error(
            "Missing TestingBot credentials in process env (TESTINGBOT_KEY / TESTINGBOT_SECRET)."
          );
        }

        const browserName = args.browserName.toLowerCase();
        const browserVersion = args.browserVersion || "latest";
        const isMobile = !!args.deviceName;

        const tbOpts: Record<string, unknown> = {};
        if (args.name) tbOpts.name = args.name;
        if (args.build) tbOpts.build = args.build;
        if (!isMobile && args.screenResolution) tbOpts.screenResolution = args.screenResolution;

        // W3C WebDriver capabilities + TestingBot-specific options.
        // - Desktop: legacy `platform` + W3C `platformName` so codes like
        //   "VENTURA" and "macOS Ventura" both work.
        // - Mobile: Appium-style `appium:*` caps. TestingBot's hub routes the
        //   session through chromedriver/safaridriver under Appium, so the
        //   resulting WebDriver session behaves like a normal browser — you
        //   can `goto`, `findElement`, screenshot etc. with no need to switch
        //   contexts. Auto-pick automationName from the platform.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const capabilities: Record<string, any> = isMobile
          ? {
              browserName,
              platformName: args.platform,
              "appium:deviceName": args.deviceName,
              ...(args.platformVersion ? { "appium:platformVersion": args.platformVersion } : {}),
              "appium:automationName":
                args.automationName ?? (/ios/i.test(args.platform) ? "XCUITest" : "UiAutomator2"),
              "tb:options": tbOpts,
            }
          : {
              browserName,
              browserVersion,
              platformName: args.platform,
              platform: args.platform,
              "tb:options": tbOpts,
            };

        logger.info({ capabilities, mobile: isMobile }, "Opening browser session");

        const driver = await WebDriver.newSession({
          ...HUB,
          user: key,
          key: secret,
          logLevel: "warn",
          capabilities,
        });

        const rawSessionId = driver.sessionId;
        if (!rawSessionId) {
          throw new Error("TestingBot did not return a WebDriver sessionId");
        }
        const id = sanitizeSessionId(rawSessionId);
        const liveViewUrl = buildLiveViewUrl(testingBotApi, id);

        sessions.register({
          id,
          type: "browser",
          driver,
          browserName,
          capabilities,
          liveViewUrl,
          dispose: async () => {
            try {
              await driver.deleteSession();
            } catch (err) {
              logger.warn({ err }, "deleteSession threw; remote may have already terminated");
            }
          },
        });

        const deviceLine = isMobile
          ? `- **Device**: ${args.deviceName}${args.platformVersion ? ` (${args.platform} ${args.platformVersion})` : ` (${args.platform})`}\n`
          : `- **Browser**: ${browserName} ${browserVersion} on ${args.platform}\n`;
        const browserLine = isMobile ? `- **Browser**: ${browserName}\n` : "";

        return {
          content: [
            {
              type: "text",
              text:
                `Browser session ready.\n\n` +
                `- **Session ID**: \`${id}\`\n` +
                deviceLine +
                browserLine +
                `- **Live view** (open in a browser tab to watch): ${liveViewUrl}\n\n` +
                `Use this sessionId for tb_navigate / tb_click / tb_snapshot / tb_screenshot. Call tb_closeBrowser when done — sessions burn minutes.`,
            },
          ],
        };
      } catch (error) {
        return handleMCPError("tb_openBrowser", error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // tb_navigate
  // ---------------------------------------------------------------------------
  tools.tb_navigate = server.tool(
    "tb_navigate",
    "Navigate the session's browser to a URL.",
    {
      sessionId: z.string().min(1).describe("Session ID from tb_openBrowser"),
      url: z.string().url().describe("URL to navigate to"),
    },
    async (args: { sessionId: string; url: string }) => {
      try {
        const session = sessions.touchAs(sanitizeSessionId(args.sessionId), "browser");
        await session.driver.navigateTo(args.url);
        const [title, currentUrl] = await Promise.all([
          session.driver.getTitle(),
          session.driver.getUrl(),
        ]);
        return {
          content: [
            {
              type: "text",
              text: `Navigated to ${args.url}\n\n- **Page title**: ${title}\n- **URL**: ${currentUrl}`,
            },
          ],
        };
      } catch (error) {
        return handleMCPError("tb_navigate", error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // tb_snapshot — text + structure summary the agent can use to find targets
  // ---------------------------------------------------------------------------
  tools.tb_snapshot = server.tool(
    "tb_snapshot",
    "Return a structured snapshot of the current page: title, URL, headings, links/buttons with their text, and a truncated body. Use this as the agent's 'see the page' primitive before deciding what to click.",
    {
      sessionId: z.string().min(1).describe("Session ID from tb_openBrowser"),
      bodyChars: z
        .number()
        .int()
        .min(500)
        .max(50_000)
        .optional()
        .default(5_000)
        .describe("How many characters of body innerText to include (default 5000, max 50000)."),
    },
    async (args: { sessionId: string; bodyChars?: number }) => {
      try {
        const session = sessions.touchAs(sanitizeSessionId(args.sessionId), "browser");
        const bodyChars = args.bodyChars ?? 5_000;
        const snapshot = (await session.driver.executeScript(
          `
          var bodyChars = arguments[0];
          var headings = [].slice.call(document.querySelectorAll('h1,h2,h3'))
            .map(function (h) { return h.tagName + ': ' + (h.innerText || '').trim().slice(0, 200); });
          var actionable = [].slice.call(
            document.querySelectorAll('a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"]')
          )
            .map(function (el) {
              var text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
              return {
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || null,
                text: text.slice(0, 120),
                href: el.tagName === 'A' ? el.href : null,
              };
            })
            .filter(function (x) { return x.text; });
          var body = (document.body && document.body.innerText) || '';
          return {
            title: document.title,
            url: location.href,
            headings: headings,
            actionable: actionable.slice(0, 100),
            actionableTotal: actionable.length,
            body: body.slice(0, bodyChars),
            bodyTruncated: body.length > bodyChars,
          };
        `,
          [bodyChars]
        )) as {
          title: string;
          url: string;
          headings: string[];
          actionable: Array<{
            tag: string;
            role: string | null;
            text: string;
            href: string | null;
          }>;
          actionableTotal: number;
          body: string;
          bodyTruncated: boolean;
        };

        const lines: string[] = [];
        lines.push(`# ${snapshot.title}`);
        lines.push(`URL: ${snapshot.url}`);
        if (snapshot.headings.length) {
          lines.push("\n## Headings");
          for (const h of snapshot.headings) lines.push(`- ${h}`);
        }
        if (snapshot.actionable.length) {
          lines.push(
            `\n## Actionable (${snapshot.actionable.length}${snapshot.actionableTotal > snapshot.actionable.length ? ` of ${snapshot.actionableTotal}` : ""})`
          );
          for (const a of snapshot.actionable) {
            lines.push(
              `- [${a.tag}${a.role ? ` role=${a.role}` : ""}] ${a.text}${a.href ? ` → ${a.href}` : ""}`
            );
          }
        }
        lines.push(`\n## Body text${snapshot.bodyTruncated ? " (truncated)" : ""}`);
        lines.push("```\n" + snapshot.body + "\n```");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return handleMCPError("tb_snapshot", error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // tb_click
  // ---------------------------------------------------------------------------
  tools.tb_click = server.tool(
    "tb_click",
    "Click an element. Use `by` to pick a locator strategy (css/xpath/id/name/tag/class/linkText/partialLinkText).",
    {
      sessionId: z.string().min(1).describe("Session ID from tb_openBrowser"),
      by: z.enum(LOCATOR_KEYS).optional().default("css").describe("Locator strategy (default css)"),
      value: z
        .string()
        .min(1)
        .describe("Locator value (e.g. CSS selector, XPath expression, link text)"),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(30000)
        .optional()
        .default(5000)
        .describe("Implicit wait for the element to appear (default 5000ms)."),
    },
    async (args: { sessionId: string; by?: LocatorBy; value: string; timeoutMs?: number }) => {
      try {
        const session = sessions.touchAs(sanitizeSessionId(args.sessionId), "browser");
        const by = args.by ?? "css";
        // setTimeouts is the low-level W3C protocol command: positional
        // (implicit, pageLoad, script), each number|null — NOT an object. Passing
        // an object makes `implicit` an object and the hub rejects it. Set only
        // implicit; leaving pageLoad/script undefined keeps the session defaults.
        await session.driver.setTimeouts(args.timeoutMs ?? 5000);
        const elementId = await findOne(session.driver, by, args.value);
        await session.driver.elementClick(elementId);
        return {
          content: [{ type: "text", text: `Clicked ${by}=${args.value}` }],
        };
      } catch (error) {
        return handleMCPError("tb_click", error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // tb_type
  // ---------------------------------------------------------------------------
  tools.tb_type = server.tool(
    "tb_type",
    "Type text into an input. Uses the same locator strategies as tb_click. Clears the field first by default.",
    {
      sessionId: z.string().min(1).describe("Session ID from tb_openBrowser"),
      by: z.enum(LOCATOR_KEYS).optional().default("css").describe("Locator strategy (default css)"),
      value: z.string().min(1).describe("Locator value"),
      text: z.string().describe("Text to type"),
      clearFirst: z.boolean().optional().default(true).describe("Clear the field before typing"),
      pressEnter: z.boolean().optional().default(false).describe("Press Enter after typing"),
    },
    async (args: {
      sessionId: string;
      by?: LocatorBy;
      value: string;
      text: string;
      clearFirst?: boolean;
      pressEnter?: boolean;
    }) => {
      try {
        const session = sessions.touchAs(sanitizeSessionId(args.sessionId), "browser");
        const by = args.by ?? "css";
        // Positional (implicit, pageLoad, script) — see tb_click for the rationale.
        await session.driver.setTimeouts(5000);
        const elementId = await findOne(session.driver, by, args.value);

        if (args.clearFirst !== false) {
          await session.driver.elementClear(elementId);
        }
        await session.driver.elementSendKeys(elementId, args.text);
        if (args.pressEnter) {
          await session.driver.elementSendKeys(elementId, W3C_KEYS.Enter);
        }

        return {
          content: [
            {
              type: "text",
              text: `Typed into ${by}=${args.value}${args.pressEnter ? " and pressed Enter" : ""}`,
            },
          ],
        };
      } catch (error) {
        return handleMCPError("tb_type", error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // tb_getText — read element text without doing a full snapshot
  // ---------------------------------------------------------------------------
  tools.tb_getText = server.tool(
    "tb_getText",
    "Read the visible text of an element. Cheaper than tb_snapshot when you just need to verify a single label / status.",
    {
      sessionId: z.string().min(1).describe("Session ID from tb_openBrowser"),
      by: z.enum(LOCATOR_KEYS).optional().default("css").describe("Locator strategy"),
      value: z.string().min(1).describe("Locator value"),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(30000)
        .optional()
        .default(5000)
        .describe("Implicit wait"),
    },
    async (args: { sessionId: string; by?: LocatorBy; value: string; timeoutMs?: number }) => {
      try {
        const session = sessions.touchAs(sanitizeSessionId(args.sessionId), "browser");
        // setTimeouts is the low-level W3C protocol command: positional
        // (implicit, pageLoad, script), each number|null — NOT an object. Passing
        // an object makes `implicit` an object and the hub rejects it. Set only
        // implicit; leaving pageLoad/script undefined keeps the session defaults.
        await session.driver.setTimeouts(args.timeoutMs ?? 5000);
        const elementId = await findOne(session.driver, args.by ?? "css", args.value);
        const text = (await session.driver.getElementText(elementId)) as string;
        return { content: [{ type: "text", text: text ?? "" }] };
      } catch (error) {
        return handleMCPError("tb_getText", error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // tb_getAttribute
  // ---------------------------------------------------------------------------
  tools.tb_getAttribute = server.tool(
    "tb_getAttribute",
    "Read an attribute of an element (e.g. 'href', 'value', 'aria-label', 'class', 'data-*').",
    {
      sessionId: z.string().min(1).describe("Session ID from tb_openBrowser"),
      by: z.enum(LOCATOR_KEYS).optional().default("css").describe("Locator strategy"),
      value: z.string().min(1).describe("Locator value"),
      attribute: z.string().min(1).describe("Attribute name"),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(30000)
        .optional()
        .default(5000)
        .describe("Implicit wait"),
    },
    async (args: {
      sessionId: string;
      by?: LocatorBy;
      value: string;
      attribute: string;
      timeoutMs?: number;
    }) => {
      try {
        const session = sessions.touchAs(sanitizeSessionId(args.sessionId), "browser");
        // setTimeouts is the low-level W3C protocol command: positional
        // (implicit, pageLoad, script), each number|null — NOT an object. Passing
        // an object makes `implicit` an object and the hub rejects it. Set only
        // implicit; leaving pageLoad/script undefined keeps the session defaults.
        await session.driver.setTimeouts(args.timeoutMs ?? 5000);
        const elementId = await findOne(session.driver, args.by ?? "css", args.value);
        const value = await session.driver.getElementAttribute(elementId, args.attribute);
        return {
          content: [
            {
              type: "text",
              text: value == null ? `(no '${args.attribute}' attribute)` : String(value),
            },
          ],
        };
      } catch (error) {
        return handleMCPError("tb_getAttribute", error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // tb_executeScript — escape hatch for anything not exposed above
  // ---------------------------------------------------------------------------
  tools.tb_executeScript = server.tool(
    "tb_executeScript",
    "Execute a JavaScript snippet in the active page and return its result. The script body is wrapped as a function — use `return` to send a value back. Args are passed positionally via `arguments[0]`, `arguments[1]`, ...",
    {
      sessionId: z.string().min(1).describe("Session ID from tb_openBrowser"),
      script: z.string().min(1).describe("JS body, e.g. 'return document.title'"),
      args: z
        .array(z.unknown())
        .optional()
        .default([])
        .describe("Positional arguments accessible as arguments[N]"),
    },
    async (args: { sessionId: string; script: string; args?: unknown[] }) => {
      try {
        const session = sessions.touchAs(sanitizeSessionId(args.sessionId), "browser");
        const result = await session.driver.executeScript(args.script, args.args ?? []);
        let text: string;
        try {
          text = JSON.stringify(result, null, 2);
        } catch {
          text = String(result);
        }
        return { content: [{ type: "text", text: text ?? "undefined" }] };
      } catch (error) {
        return handleMCPError("tb_executeScript", error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // tb_closeBrowser
  // ---------------------------------------------------------------------------
  tools.tb_closeBrowser = server.tool(
    "tb_closeBrowser",
    "Close a remote browser session. Releases TestingBot minutes. For mobile device sessions, use appium-mcp's `appium_session_management` with `action: 'delete'`.",
    {
      sessionId: z.string().min(1).describe("Session ID to close"),
    },
    async (args: { sessionId: string }) => {
      try {
        const id = sanitizeSessionId(args.sessionId);
        const closed = await sessions.close(id);
        return {
          content: [
            {
              type: "text",
              text: closed
                ? `Closed session ${id}.`
                : `No active session ${id}. (Already closed or never opened.)`,
            },
          ],
        };
      } catch (error) {
        return handleMCPError("tb_closeBrowser", error);
      }
    }
  );

  return tools;
}
