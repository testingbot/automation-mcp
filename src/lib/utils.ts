import logger from "./logger.js";

export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9-_]/g, "");
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) return JSON.stringify(error);
  return String(error);
}

export function handleMCPError(
  toolName: string,
  error: unknown
): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  const errorMessage = formatError(error);
  logger.error({ tool: toolName, error: errorMessage }, "Tool execution failed");

  const readableToolName = toolName
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();

  return {
    content: [
      {
        type: "text",
        text: `Failed to ${readableToolName}: ${errorMessage}.`,
      },
    ],
    isError: true,
  };
}
