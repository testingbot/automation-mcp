/**
 * Tool parameter schemas: Zod shape → JSON Schema for tools/list, and argument
 * checking for tools/call. Exported so @testingbot/mcp-server uses the same
 * implementation for its own tools.
 */
import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Shape = Record<string, any>;

/**
 * Converts a tool's Zod shape (`{ arg: z.string(), ... }`) to the JSON Schema
 * object MCP expects as `inputSchema`. Inline everything (reused: "inline"):
 * MCP clients do not resolve $ref, and a reused sub-schema would otherwise be
 * emitted as a reference to a definition that is not part of the payload.
 * io: "input" describes what a client sends, so `.default()` params are
 * optional. unrepresentable: "any" keeps a schema JSON Schema cannot express
 * (a custom check, say) from failing the whole tools/list.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toolInputSchema(shape: Shape | undefined): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const converted: any = z.toJSONSchema(z.object(shape ?? {}), {
    target: "draft-7",
    io: "input",
    reused: "inline",
    unrepresentable: "any",
    override: keepPipeLimitsAndDefaults,
  });
  delete converted.$schema;
  return converted;
}

// zod 4's input mode drops things agents relied on with zod-to-json-schema:
// - a pipe such as `z.union([z.number(), z.string().transform(Number)])
//   .pipe(z.number().min(1).max(100))` shows only its input side, so the
//   limits disappear. Emit `allOf: [input, output]`, as zod-to-json-schema did.
// - objects come out open; tools have always advertised closed ones.
// - `.default()` behind such a pipe loses its `default`. Put it back.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function keepPipeLimitsAndDefaults(ctx: { zodSchema: any; jsonSchema: any }): void {
  const def = ctx.zodSchema._zod.def;
  // A bare transform is also a pipe internally; its output side says nothing.
  if (def.type === "pipe" && def.out._zod.def.type !== "transform") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output: any = z.toJSONSchema(def.out, {
      target: "draft-7",
      io: "output",
      unrepresentable: "any",
    });
    delete output.$schema;
    const { description, ...input } = ctx.jsonSchema;
    for (const key of Object.keys(ctx.jsonSchema)) delete ctx.jsonSchema[key];
    if (description) ctx.jsonSchema.description = description;
    ctx.jsonSchema.allOf = [input, output];
  }
  if (def.type === "object" && ctx.jsonSchema.additionalProperties === undefined) {
    ctx.jsonSchema.additionalProperties = false;
  }
  if (def.type === "default" && ctx.jsonSchema.default === undefined) {
    ctx.jsonSchema.default =
      typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
  }
}

export type ParsedToolArgs =
  { success: true; data: Record<string, unknown> } | { success: false; message: string };

/**
 * Check a tools/call payload against the tool's Zod shape. On success `data`
 * has defaults and coercions applied. On failure `message` names each bad
 * parameter, e.g. `sessionId: expected string, received undefined`, so an
 * agent can correct the call instead of seeing a crash from inside the tool.
 */
export function parseToolArgs(shape: Shape | undefined, args: unknown): ParsedToolArgs {
  const result = z.object(shape ?? {}).safeParse(args ?? {});
  if (result.success) return { success: true, data: result.data };
  const problems = result.error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join(".") : "arguments";
    return `${where}: ${issue.message.replace(/^Invalid input: /, "")}`;
  });
  return { success: false, message: problems.join("; ") };
}

/** The tools/call result for arguments that failed parseToolArgs. */
export function invalidArgsResult(toolName: string, message: string) {
  return {
    content: [{ type: "text" as const, text: `Invalid arguments for ${toolName}: ${message}` }],
    isError: true,
  };
}
