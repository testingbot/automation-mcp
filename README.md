# @testingbot/automation-mcp

MCP server that lets AI agents drive remote browsers **and real iOS / Android devices** on [TestingBot](https://testingbot.com)'s grid. Real Safari on macOS, Edge on Windows, Firefox, Chrome on any supported OS, plus physical Appium devices — all from one install, no local browser, simulator, or Appium server required. Every session includes a live-view URL so a human can watch the agent drive in real time.

> **Status: alpha.** One install gets you both browser and mobile automation. Mobile is powered by the official [`appium-mcp`](https://github.com/appium/appium-mcp), spawned as a child process and proxied through this server — you never need to install or configure it yourself.

## What's in the box

### Browser automation

| Tool | What it does |
|---|---|
| `tb_openBrowser` | Start a remote browser session on TestingBot via WebDriver. Returns a `sessionId` and a `liveViewUrl`. |
| `tb_navigate` | Navigate to a URL. |
| `tb_snapshot` | Structured page summary (title, headings, actionable elements, body text). |
| `tb_screenshot` | PNG of the current page as a base64 image. |
| `tb_click` | Click by CSS / xpath / id / name / tag / class / linkText / partialLinkText. |
| `tb_type` | Type into an input (with optional clear / press-Enter). Same `by` strategies. |
| `tb_getText` | Read the visible text of one element (cheap probe). |
| `tb_getAttribute` | Read an attribute (`href`, `value`, `aria-label`, `data-*`, …). |
| `tb_executeScript` | Run a JS snippet in the page. Escape hatch for anything not covered above. |
| `tb_pressKey` | Press a key/chord on the focused element (`Enter`, `Tab`, `Control+A`, `Meta+Shift+Z`, …). |
| `tb_closeBrowser` | Close a browser session. |
| `tb_listSessions` | List active browser sessions managed here. |

Every active browser session has a built-in idle reaper (4 min default) and a session cap (5 default). Both are configurable via `AutomationOptions`.

### Mobile (iOS / Android)

The full [`appium-mcp`](https://github.com/appium/appium-mcp) tool surface — ~30 `appium_*` tools including `appium_session_management`, `appium_gesture`, `appium_set_value`, `appium_screenshot`, `appium_find_element`, `appium_app_lifecycle`, `appium_perform_actions`, and more — is proxied straight through. The agent calls them by name; we forward each call to a bundled `appium-mcp` child process over MCP.

We pre-inject two things for every session-create call:

- **`remoteServerUrl`** = the credentialed TestingBot Appium hub URL (`https://<key>:<secret>@hub.testingbot.com/wd/hub`)
- **`REMOTE_SERVER_URL_ALLOW_REGEX`** = a strict regex limiting connections to TestingBot's hub only

So the agent only needs to call `appium_session_management(action: "create", capabilities: { platformName: "iOS", ... })`. No URL, no credentials, no setup.

> Mobile tools won't appear if the bundled `appium-mcp` package fails to start (e.g. its native deps can't be loaded). Browser tools work independently.

## Install

One MCP, two surfaces:

```bash
npx @testingbot/automation-mcp
```

Example Claude Desktop config:

```jsonc
{
  "mcpServers": {
    "testingbot-automation": {
      "command": "npx",
      "args": ["-y", "@testingbot/automation-mcp"],
      "env": {
        "TESTINGBOT_KEY": "your-api-key",
        "TESTINGBOT_SECRET": "your-api-secret"
      }
    }
  }
}
```

That's it. No second MCP, no extra env vars.

> **Heads-up on install size.** Bundling `appium-mcp` brings in its full mobile-driver stack — XCUITest, UiAutomator2, langchain, and a few hundred MB of dependencies. First `npm install` will take longer than a typical MCP server. The cost is paid once.

## Composed as a library

If you're already running [`@testingbot/mcp-server`](https://github.com/testingbot/mcp-server) for resource management, the automation tools compose into the same server instance — no second MCP entry, no extra process. `@testingbot/mcp-server` does this automatically; the example below is for any other host MCP:

```ts
import { addAutomationTools } from "@testingbot/automation-mcp";

const handle = await addAutomationTools(server, testingBotApi, config, {
  idleTimeoutMs: 4 * 60 * 1000,  // optional, default
  maxSessions: 5,                 // optional, default
});

// On shutdown, close any live sessions AND the bundled appium-mcp child:
await handle.shutdown();
```

`addAutomationTools` is async because it spawns and discovers tools from the bundled `appium-mcp` child. The host MUST `await` it before serving its first `tools/list` response, otherwise mobile tools won't be visible to the client.

The library entry expects the same `server.tool(name, desc, schema, handler)` duck-type used by `@testingbot/mcp-server`'s other tool families.

## Live view (the killer feature)

Every `tb_openBrowser` response includes:

```
- **Live view** (open in a browser tab to watch): https://testingbot.com/tests/<sessionId>/live?auth=<hash>
```

Click that URL → you see the AI driving in real time. Works for any TestingBot session — Safari, Chrome, iOS, Android, etc. — same URL pattern: `https://testingbot.com/tests/<sessionId>/live?auth=<md5(key:secret:sessionId)>`.

For mobile sessions, ask the agent to surface the live-view URL after `appium_session_management` returns the sessionId.

## Example prompts

**Browser:**

> Open Safari 17 on macOS Sonoma on TestingBot. Go to news.ycombinator.com, get an ARIA snapshot, summarize the top 5 stories, then close the session.

**Mobile (iOS simulator app):**

> Open an iPhone 15 Pro with iOS 17 on TestingBot, install the app at `tb://abc123`, tap the "Sign in" button, take a screenshot, then close the session.

**Mobile (Android web):**

> Open Chrome on a Pixel 8 with Android 14 on TestingBot, browse to wikipedia.org, search for "Appium", take a screenshot, then close.

Behind the scenes for mobile, the agent:

1. Calls `appium_session_management({ action: "create", capabilities: { platformName: "iOS", "appium:deviceName": "iPhone 15 Pro", ... } })`. We inject the credentialed `remoteServerUrl` automatically.
2. Uses `appium_gesture` / `appium_set_value` / `appium_screenshot` / `appium_find_element` / etc. to drive the device.
3. Closes via `appium_session_management({ action: "delete", sessionId })`.

## Caveats (read these)

- **Sessions cost money.** Every minute a remote browser or device is alive consumes TestingBot test minutes. The idle reaper closes browser sessions at 4 min by default; for mobile, ask the agent to be explicit about closing.
- **TestingBot kills sessions at ~5 min idle.** Our reaper closes browser sessions at 4 min so the close is clean instead of disconnect-on-next-call.
- **WebDriver throughout.** Browser sessions use the same protocol TestingBot is native to, so Chrome, Edge, Safari, and Firefox all work without a per-browser code path. Mobile uses WebDriver too via Appium.
- **Live view URL leaks an MD5 hash.** Don't paste it in public places — anyone with the URL can watch your session.
- **Mobile traffic is locked to TestingBot's hub.** We set `REMOTE_SERVER_URL_ALLOW_REGEX` in the appium-mcp child's env to a strict regex; the child will refuse any `remoteServerUrl` pointing elsewhere, even if the agent supplies one.

## Development

```bash
npm ci
npm run dev          # watch mode
npm test             # vitest
npm run lint
npm run build        # lint + format:check + test + tsc
```

## License

MIT — see [LICENSE](LICENSE).
