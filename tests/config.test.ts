import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfig } from "../src/config.js";

// dotenv.config() runs at import time, so capture the original env and
// restore it after each test to keep them isolated.
const TRACKED = [
  "TESTINGBOT_KEY",
  "TB_KEY",
  "TESTINGBOT_USERNAME",
  "TESTINGBOT_SECRET",
  "TB_SECRET",
  "TESTINGBOT_ACCESS_KEY",
];

describe("getConfig", () => {
  const originals = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of TRACKED) {
      originals.set(k, process.env[k]);
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TRACKED) {
      const v = originals.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("reads TESTINGBOT_KEY / TESTINGBOT_SECRET", () => {
    process.env.TESTINGBOT_KEY = "primary-key";
    process.env.TESTINGBOT_SECRET = "primary-secret";
    expect(getConfig()).toEqual({
      "testingbot-key": "primary-key",
      "testingbot-secret": "primary-secret",
    });
  });

  it("falls back to TB_KEY / TB_SECRET", () => {
    process.env.TB_KEY = "fallback-key";
    process.env.TB_SECRET = "fallback-secret";
    expect(getConfig()).toEqual({
      "testingbot-key": "fallback-key",
      "testingbot-secret": "fallback-secret",
    });
  });

  it("falls back to TESTINGBOT_USERNAME / TESTINGBOT_ACCESS_KEY", () => {
    process.env.TESTINGBOT_USERNAME = "legacy-user";
    process.env.TESTINGBOT_ACCESS_KEY = "legacy-secret";
    expect(getConfig()).toEqual({
      "testingbot-key": "legacy-user",
      "testingbot-secret": "legacy-secret",
    });
  });

  it("prefers TESTINGBOT_* over TB_* when both are set", () => {
    process.env.TESTINGBOT_KEY = "primary-key";
    process.env.TESTINGBOT_SECRET = "primary-secret";
    process.env.TB_KEY = "ignored";
    process.env.TB_SECRET = "ignored";
    expect(getConfig()["testingbot-key"]).toBe("primary-key");
    expect(getConfig()["testingbot-secret"]).toBe("primary-secret");
  });

  it("trims surrounding whitespace from values", () => {
    process.env.TESTINGBOT_KEY = "  whitespace-key  ";
    process.env.TESTINGBOT_SECRET = "  whitespace-secret  ";
    expect(getConfig()).toEqual({
      "testingbot-key": "whitespace-key",
      "testingbot-secret": "whitespace-secret",
    });
  });

  it("throws a helpful error when credentials are missing", () => {
    expect(() => getConfig()).toThrow(/Missing TestingBot credentials/);
  });

  it("throws when key is set but secret is missing", () => {
    process.env.TESTINGBOT_KEY = "only-key";
    expect(() => getConfig()).toThrow(/Missing TestingBot credentials/);
  });

  it("throws when secret is set but key is missing", () => {
    process.env.TESTINGBOT_SECRET = "only-secret";
    expect(() => getConfig()).toThrow(/Missing TestingBot credentials/);
  });
});
