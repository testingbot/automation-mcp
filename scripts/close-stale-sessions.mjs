#!/usr/bin/env node
/**
 * Last-resort sweep for sessions left RUNNING by a crashed integration run.
 *
 * The integration suites close their own sessions in afterAll, and TestingBot
 * reaps idle sessions after ~5 minutes anyway — but a hard job failure (OOM,
 * cancelled workflow) skips afterAll and those minutes bill until the reaper
 * fires. This stops anything still running so a failed CI run costs seconds,
 * not minutes.
 *
 * Never fails the job: a sweep problem must not mask the real test result.
 *
 * Usage: TB_KEY=... TB_SECRET=... node scripts/close-stale-sessions.mjs
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TestingBot = require("testingbot-api");

const key = process.env.TESTINGBOT_KEY || process.env.TB_KEY;
const secret = process.env.TESTINGBOT_SECRET || process.env.TB_SECRET;

if (!key || !secret) {
  console.error("[sweep] No credentials in the environment — nothing to do.");
  process.exit(0);
}

const tb = new TestingBot({ api_key: key, api_secret: secret });

try {
  // Only the most recent page matters: an integration run creates a handful of
  // sessions, and anything older has long since been reaped.
  const page = await tb.getTests(0, 25);
  const tests = Array.isArray(page) ? page : (page?.data ?? []);
  const running = tests.filter((t) => String(t?.state).toUpperCase() === "RUNNING");

  if (running.length === 0) {
    console.error("[sweep] No running sessions left behind.");
    process.exit(0);
  }

  for (const test of running) {
    const id = test.session_id || test.id;
    try {
      await tb.stopTest(String(id));
      console.error(`[sweep] Stopped leaked session ${id}`);
    } catch (err) {
      console.error(`[sweep] Could not stop ${id}: ${err?.message ?? err}`);
    }
  }
} catch (err) {
  // Swallow: the sweep is best-effort and must never turn a passing run red.
  console.error(`[sweep] Skipped — ${err?.message ?? err}`);
}

process.exit(0);
