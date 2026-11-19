import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseToolArgs, toolInputSchema } from "../../src/lib/tool-schema.js";

describe("toolInputSchema", () => {
  it("keeps descriptions, enums and optionality", () => {
    const schema = toolInputSchema({
      type: z.enum(["web", "mobile"]).optional().describe("Filter by type"),
      id: z.string().describe("Session id"),
    });
    expect(schema.properties.type).toMatchObject({ type: "string", enum: ["web", "mobile"] });
    expect(schema.required).toEqual(["id"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$schema).toBeUndefined();
  });

  it("keeps the limits and default of a number-or-string param", () => {
    const schema = toolInputSchema({
      limit: z
        .union([z.number(), z.string().transform(Number)])
        .pipe(z.number().min(1).max(100))
        .optional()
        .default(10)
        .describe("Page size"),
    });
    expect(schema.properties.limit).toEqual({
      description: "Page size",
      default: 10,
      allOf: [
        { anyOf: [{ type: "number" }, { type: "string" }] },
        { type: "number", minimum: 1, maximum: 100 },
      ],
    });
    expect(schema.required ?? []).not.toContain("limit");
  });
});

describe("parseToolArgs", () => {
  const shape = {
    sessionId: z.string().min(1),
    limit: z
      .union([z.number(), z.string().transform(Number)])
      .pipe(z.number().min(1))
      .optional()
      .default(10),
  };

  it("applies defaults and coercions", () => {
    expect(parseToolArgs(shape, { sessionId: "abc", limit: "5" })).toEqual({
      success: true,
      data: { sessionId: "abc", limit: 5 },
    });
    expect(parseToolArgs(shape, { sessionId: "abc" })).toEqual({
      success: true,
      data: { sessionId: "abc", limit: 10 },
    });
  });

  it("names each bad parameter", () => {
    const result = parseToolArgs(shape, { limit: 0 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toContain("sessionId: expected string, received undefined");
    expect(result.message).toContain("limit:");
  });

  it("treats missing arguments as an empty object", () => {
    expect(parseToolArgs({}, undefined)).toEqual({ success: true, data: {} });
  });
});
