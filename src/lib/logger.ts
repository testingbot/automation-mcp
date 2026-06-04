import pino from "pino";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const debugToFile = process.env.TESTINGBOT_DEBUG === "true";
const isDevMode = process.env.NODE_ENV === "development" || process.argv.includes("--dev");
const logLevel = process.env.LOG_LEVEL || (isDevMode || debugToFile ? "info" : "error");

let logFilePath: string | undefined;
if (debugToFile) {
  const logsDir = path.join(__dirname, "../../logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  logFilePath = path.join(logsDir, "debug.log");
}

const redactPaths = [
  "*.api_key",
  "*.api_secret",
  "*.apiKey",
  "*.apiSecret",
  "*.password",
  "*.authorization",
  "*.Authorization",
  "options.api_key",
  "options.api_secret",
  "args.localFilePath",
  "args.remoteUrl",
  "headers.authorization",
];

// MCP servers communicate over stdio — stdout is reserved for JSON-RPC framing.
// All log output MUST go to stderr (fd 2) or a file; never to stdout.
const logger = (() => {
  const base = { level: logLevel, redact: { paths: redactPaths, censor: "[redacted]" } };

  if (debugToFile && logFilePath) {
    return pino({
      ...base,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: false,
          translateTime: "yyyy-mm-dd HH:MM:ss",
          ignore: "pid,hostname",
          destination: logFilePath,
          mkdir: true,
        },
      },
    });
  }

  if (isDevMode) {
    return pino({
      ...base,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss Z",
          ignore: "pid,hostname",
          destination: 2,
        },
      },
    });
  }

  return pino(base, pino.destination(2));
})();

if (debugToFile && logFilePath) {
  console.error(`Debug logging enabled: ${logFilePath}`);
}

export default logger;
