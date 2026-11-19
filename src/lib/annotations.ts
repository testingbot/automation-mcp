/**
 * MCP tool annotations (spec 2025-03-26+): hints clients use to decide when to
 * ask before running a tool, and that directories such as Glama use to judge
 * how well a tool is described. They describe behavior; they don't enforce it.
 */
export interface ToolAnnotations {
  /** Human-readable name for UIs. */
  title?: string;
  /** Does not change anything (default false). */
  readOnlyHint?: boolean;
  /** May delete or overwrite something that can't be recovered (default true for non-read-only tools). */
  destructiveHint?: boolean;
  /** Calling it again with the same arguments has no further effect (default false). */
  idempotentHint?: boolean;
  /** Talks to systems outside this server, here TestingBot's cloud (default true). */
  openWorldHint?: boolean;
}

/** Read-only call against TestingBot (a query or a page read). */
export const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Changes state on TestingBot but deletes nothing. */
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Changes state; repeating it with the same arguments changes nothing more. */
export const WRITE_IDEMPOTENT: ToolAnnotations = { ...WRITE, idempotentHint: true };

/** Deletes or ends something that can't be recovered. */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** The browser tools in this package. */
export const BROWSER_TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Starts a billed remote browser.
  tb_openBrowser: { ...WRITE, title: "Open a remote browser" },
  // Interactions change the remote page, but nothing outside the session.
  tb_navigate: { ...WRITE, title: "Navigate to a URL" },
  tb_click: { ...WRITE, title: "Click an element" },
  tb_type: { ...WRITE, title: "Type into a field" },
  tb_pressKey: { ...WRITE, title: "Press a key" },
  // Arbitrary page JavaScript: may change or submit anything the page can.
  tb_executeScript: { ...WRITE, destructiveHint: true, title: "Run JavaScript in the page" },
  tb_snapshot: { ...READ, title: "Describe the page" },
  tb_getText: { ...READ, title: "Read an element's text" },
  tb_getAttribute: { ...READ, title: "Read an element's attribute" },
  // Writes a PNG to local disk, but changes nothing remote.
  tb_screenshot: { ...READ, title: "Screenshot the page" },
  tb_listSessions: { ...READ, openWorldHint: false, title: "List open browser sessions" },
  tb_closeBrowser: { ...DESTRUCTIVE, title: "Close a browser session" },
};

/**
 * appium-mcp's own annotations assume a local device (openWorldHint false).
 * Here every call drives a TestingBot cloud device, and session management
 * starts billed sessions and deletes them.
 */
export function appiumAnnotations(
  name: string,
  upstream: ToolAnnotations | undefined
): ToolAnnotations {
  if (name === "appium_session_management") {
    return {
      title: "Manage TestingBot device sessions",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    };
  }
  return { ...(upstream ?? {}), openWorldHint: true };
}
