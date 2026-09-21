import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { redactPaths } from "../../src/lib/logger.js";

describe("logger redaction", () => {
  // server-factory's CallTool handler logs `{ tool, args }` wholesale on every
  // call, so any tool argument that can carry a secret must be redacted.
  const sensitiveArgs = ["args.text", "args.capabilities", "args.remoteServerUrl"];

  it.each(sensitiveArgs)("redacts %s", (path) => {
    expect(redactPaths).toContain(path);
  });

  it("redacts the generic secret-bearing field names", () => {
    for (const name of ["*.password", "*.secret", "*.token", "*.api_secret"]) {
      expect(redactPaths).toContain(name);
    }
  });

  it("still logs the fields needed to debug a tool call", () => {
    // Over-redacting makes the logs useless — sessionId and locators are not
    // secrets and must stay readable.
    expect(redactPaths).not.toContain("args.sessionId");
    expect(redactPaths).not.toContain("args.value");
    expect(redactPaths).not.toContain("args.url");
  });

  it("covers tb_type's payload, which is where a password would land", async () => {
    // Guard against the argument being renamed without updating redactPaths.
    const source = await readFile(new URL("../../src/tools/browse.ts", import.meta.url), "utf8");
    expect(source).toMatch(/text: z\.string\(\)\.describe\("Text to type"\)/);
  });
});
