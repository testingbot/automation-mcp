import dotenv from "dotenv";
import { TestingBotConfig } from "./lib/types.js";

dotenv.config();

export function getConfig(): TestingBotConfig {
  const key =
    process.env.TESTINGBOT_KEY || process.env.TB_KEY || process.env.TESTINGBOT_USERNAME || "";
  const secret =
    process.env.TESTINGBOT_SECRET ||
    process.env.TB_SECRET ||
    process.env.TESTINGBOT_ACCESS_KEY ||
    "";

  if (!key || !secret) {
    throw new Error(
      "Missing TestingBot credentials. Set TESTINGBOT_KEY and TESTINGBOT_SECRET (or TB_KEY/TB_SECRET) in the environment."
    );
  }

  return {
    "testingbot-key": key.trim(),
    "testingbot-secret": secret.trim(),
  };
}
