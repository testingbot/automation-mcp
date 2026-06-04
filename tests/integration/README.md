# Integration tests

These tests open **real** TestingBot sessions. Every run burns paid test minutes,
so they are **excluded from `npm test`** and must be invoked explicitly.

## How to run

```bash
RUN_INTEGRATION_TESTS=true \
  TESTINGBOT_KEY=your-key \
  TESTINGBOT_SECRET=your-secret \
  npm run test:integration
```

If either the env flag is missing **or** credentials aren't set, every test in
this folder is skipped — never silently fails into a real session.

## What's covered

- **`web.integration.test.ts`** — opens a short Chrome session on Windows 11,
  navigates to `example.com`, captures an ARIA snapshot, takes a screenshot,
  verifies the live-view URL is reachable, and cleans up. Roughly one minute
  per run.

Mobile / device integration tests aren't wired up yet — they're more expensive
and slower. Add them under a separate `RUN_MOBILE_INTEGRATION_TESTS=true` gate
once the workflow stabilizes.

## Cost & safety

- Per-test timeout is 120 s; `testTimeout` is enforced in the npm script.
- Each test opens its own `SessionManager` and calls `closeAll()` in `afterAll`
  so a failure never leaves a session orphaned.
- If a test crashes between open and close, TestingBot will reap the session
  itself after ~5 min of idle.
