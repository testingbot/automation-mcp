import { z } from "zod";
import { handleMCPError, sanitizeSessionId } from "../lib/utils.js";
import { SessionManager } from "../session-manager.js";

// Browser-session helpers that don't fit neatly inside browse.ts (they touch
// the manager generically and could pick up future session types). Mobile
// device sessions are delegated to https://github.com/appium/appium-mcp via
// the tb_appiumEndpoint bridge tool, so they aren't dispatched here.

// W3C key codes for browser tb_pressKey. Stored via \u escapes so the
// codepoints survive any source-tooling that might silently strip them.
const W3C_KEY_CODES: Record<string, string> = {
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

/** Build a W3C key-actions sequence for a single key or chord like "Control+A".
 *  Modifier keys press down across the inner key, then release in reverse. */
function buildKeyActions(
  key: string
): Array<{ type: "keyDown" | "keyUp" | "pause"; value?: string; duration?: number }> {
  const parts = key.split("+").map((p) => p.trim());
  const codes = parts.map((p) => W3C_KEY_CODES[p] ?? p);
  const actions: Array<{ type: "keyDown" | "keyUp"; value: string }> = [];
  for (const c of codes) actions.push({ type: "keyDown", value: c });
  for (let i = codes.length - 1; i >= 0; i--) actions.push({ type: "keyUp", value: codes[i] });
  return actions;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function addSharedTools(server: any, sessions: SessionManager) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  // ---------------------------------------------------------------------------
  // tb_screenshot
  // ---------------------------------------------------------------------------
  tools.tb_screenshot = server.tool(
    "tb_screenshot",
    "Capture a PNG screenshot of the active browser session as a base64 image content block.",
    {
      sessionId: z.string().min(1).describe("Session ID from tb_openBrowser"),
    },
    async (args: { sessionId: string }) => {
      try {
        const session = sessions.touch(sanitizeSessionId(args.sessionId));
        const dataB64 = (await session.driver.takeScreenshot()) as string;
        return {
          content: [{ type: "image", data: dataB64, mimeType: "image/png" }],
        };
      } catch (error) {
        return handleMCPError("tb_screenshot", error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // tb_pressKey
  // ---------------------------------------------------------------------------
  tools.tb_pressKey = server.tool(
    "tb_pressKey",
    "Press a key (or chord) on the active browser session. Uses W3C key names: 'Enter', 'Tab', 'Escape', 'Control+A', 'Meta+Shift+Z', etc. Sent to the currently-focused element.",
    {
      sessionId: z.string().min(1).describe("Session ID from tb_openBrowser"),
      key: z.string().min(1).describe("Key name or chord"),
    },
    async (args: { sessionId: string; key: string }) => {
      try {
        const session = sessions.touch(sanitizeSessionId(args.sessionId));
        const actions = buildKeyActions(args.key);
        await session.driver.performActions([{ type: "key", id: "kb", actions }]);
        await session.driver.releaseActions();
        return { content: [{ type: "text", text: `Pressed ${args.key}` }] };
      } catch (error) {
        return handleMCPError("tb_pressKey", error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // tb_listSessions
  // ---------------------------------------------------------------------------
  tools.tb_listSessions = server.tool(
    "tb_listSessions",
    "List all active browser sessions managed by this server. Useful when you've lost track of a sessionId. (Mobile device sessions are managed by appium-mcp — see tb_appiumEndpoint.)",
    {},
    async () => {
      try {
        const list = sessions.list();
        if (list.length === 0) {
          return { content: [{ type: "text", text: "No active sessions." }] };
        }
        const lines = list.map((s) => {
          const ageS = Math.round((Date.now() - s.createdAt) / 1000);
          const idleS = Math.round((Date.now() - s.lastUsedAt) / 1000);
          return `- \`${s.id}\` (${s.type}) — ${JSON.stringify(s.capabilities)} · age ${ageS}s · idle ${idleS}s\n  live: ${s.liveViewUrl}`;
        });
        return {
          content: [
            { type: "text", text: `Active sessions (${list.length}):\n\n${lines.join("\n")}` },
          ],
        };
      } catch (error) {
        return handleMCPError("tb_listSessions", error);
      }
    }
  );

  return tools;
}
