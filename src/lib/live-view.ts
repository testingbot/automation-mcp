// Live-view URL is universal across TestingBot session types (Playwright /
// Selenium / Appium) — same `/tests/<id>/live?auth=<hash>` endpoint. The auth
// hash is an MD5 of `key:secret:sessionId` (see testingbot-api line ~563).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildLiveViewUrl(testingBotApi: any, sessionId: string): string {
  const hash = testingBotApi.getAuthenticationHashForSharing(sessionId);
  return `https://testingbot.com/tests/${encodeURIComponent(sessionId)}/live?auth=${hash}`;
}
