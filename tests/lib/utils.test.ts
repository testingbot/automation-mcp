import { describe, it, expect } from "vitest";
import { sanitizeSessionId, formatError, handleMCPError } from "../../src/lib/utils.js";

describe("sanitizeSessionId", () => {
  it("passes alphanumeric, dashes, and underscores through unchanged", () => {
    expect(sanitizeSessionId("abc-123_DEF")).toBe("abc-123_DEF");
  });

  it("strips path-traversal characters", () => {
    expect(sanitizeSessionId("../../etc/passwd")).toBe("etcpasswd");
  });

  it("strips whitespace and shell metacharacters", () => {
    expect(sanitizeSessionId("abc; rm -rf /")).toBe("abcrm-rf");
  });

  it("strips NUL bytes and control characters", () => {
    expect(sanitizeSessionId("abc\x00\n\tdef")).toBe("abcdef");
  });

  it("returns empty string when nothing is allowed", () => {
    expect(sanitizeSessionId("!@#$%^&*()")).toBe("");
  });
});

describe("formatError", () => {
  it("returns the message of an Error instance", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("returns the message of a custom Error subclass", () => {
    class CustomError extends Error {}
    expect(formatError(new CustomError("oops"))).toBe("oops");
  });

  it("JSON-stringifies plain objects", () => {
    expect(formatError({ status: 500, body: "bad" })).toBe('{"status":500,"body":"bad"}');
  });

  it("stringifies primitives", () => {
    expect(formatError("plain string")).toBe("plain string");
    expect(formatError(42)).toBe("42");
    expect(formatError(null)).toBe("null");
    expect(formatError(undefined)).toBe("undefined");
  });
});

describe("handleMCPError", () => {
  it("returns a text content block with isError: true", () => {
    const result = handleMCPError("tb_navigate", new Error("upstream timeout"));
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("upstream timeout");
  });

  it("converts camelCase / snake_case tool names to a human-readable phrase", () => {
    const camel = handleMCPError("tb_openBrowser", new Error("nope"));
    expect(camel.content[0].text).toMatch(/Failed to tb_open browser/);

    const snake = handleMCPError("tb_open_device", new Error("nope"));
    expect(snake.content[0].text).toMatch(/Failed to tb_open_device/);
  });

  it("handles non-Error throws", () => {
    const result = handleMCPError("tb_doThing", "string error");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("string error");
  });

  it("handles object errors via formatError", () => {
    const result = handleMCPError("tb_doThing", { code: 42 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"code":42');
  });
});
